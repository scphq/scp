//! Runners of runners.json: their `status` command enriches views of via workers, their `stop` command runs when such a worker ends.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared, join_all};
use serde::Serialize;
use serde::de::{Deserializer, MapAccess, Visitor};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio::time::Instant;

use crate::core::{Core, SharedCore, integer, now_ms, text};
use crate::proto::RpcError;
use crate::scrub::find_secret;
use crate::store::{Row, SqlValue};

const STDOUT_BYTES: usize = 4096;
const STDERR_BYTES: usize = 2048;
const DRAIN_MS: u64 = 500;
const STATUS_TTL_MS: i64 = 15_000;
const STATUS_SLOTS: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Runner {
    pub command: Vec<String>,
    pub timeout_s: u64,
    pub stop: Option<Vec<String>>,
    pub status: Option<Vec<String>>,
    pub status_timeout_s: u64,
}

/// object keys in the order a JavaScript engine enumerates them: array-index keys ascending, then the rest as first written, a repeat keeping its first place and last value
struct Ordered(Vec<(String, Value)>);

impl<'de> serde::Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Keys;
        impl<'de> Visitor<'de> for Keys {
            type Value = Ordered;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered, A::Error> {
                let mut entries: Vec<(String, Value)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Value>()? {
                    match entries.iter_mut().find(|(k, _)| *k == key) {
                        Some(entry) => entry.1 = value,
                        None => entries.push((key, value)),
                    }
                }
                let index = |key: &str| {
                    key.parse::<u32>()
                        .ok()
                        .filter(|n| *n < u32::MAX && n.to_string() == key)
                };
                entries.sort_by_key(|(key, _)| index(key).map_or((1, 0), |n| (0, n)));
                Ok(Ordered(entries))
            }
        }
        deserializer.deserialize_map(Keys)
    }
}

/// runners.json's runners by name, or the message naming what is wrong with it
pub fn parse_config(text: &str, path: &str) -> Result<HashMap<String, Runner>, String> {
    let value: Value = serde_json::from_str(text).map_err(|_| format!("{path} is not JSON"))?;
    if !value.is_object() {
        return Err(format!(
            "{path} maps runner names to {{command, timeout_s?}}"
        ));
    }
    let Ordered(entries) = serde_json::from_str(text).map_err(|_| format!("{path} is not JSON"))?;
    let mut runners = HashMap::new();
    for (name, entry) in entries {
        if !crate::spawn::runner_name(&name) {
            return Err(format!(
                "{path}: runner {} is not a valid name: lowercase letters, digits and -, at most 32",
                json!(name)
            ));
        }
        let empty = Map::new();
        let fields = entry.as_object().unwrap_or(&empty);
        let argv = |field: &str| -> Result<Option<Vec<String>>, String> {
            let words = fields.get(field);
            if words.is_none() && field != "command" {
                return Ok(None);
            }
            let words: Option<Vec<String>> = words
                .and_then(Value::as_array)
                .filter(|w| !w.is_empty())
                .and_then(|w| {
                    w.iter()
                        .map(|w| w.as_str().filter(|w| !w.is_empty()).map(str::to_owned))
                        .collect()
                });
            words.map(Some).ok_or_else(|| {
                format!("{path}: runner {name} needs {field}, a non-empty list of words")
            })
        };
        let timeout = |field: &str, fallback: u64, max: u64| -> Result<u64, String> {
            let n = match fields.get(field) {
                None => return Ok(fallback),
                Some(Value::Null) if field == "timeout_s" => return Ok(fallback),
                Some(n) => n.as_f64(),
            };
            n.filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= max as f64)
                .map(|n| n as u64)
                .ok_or_else(|| {
                    format!("{path}: runner {name}'s {field} is whole seconds, 1 to {max}")
                })
        };
        let command = argv("command")?.unwrap_or_default();
        let stop = argv("stop")?;
        let status = argv("status")?;
        let status_timeout_s = timeout("status_timeout_s", 5, 60)?;
        let timeout_s = timeout("timeout_s", 60, 3600)?;
        runners.insert(
            name,
            Runner {
                command,
                timeout_s,
                stop,
                status,
                status_timeout_s,
            },
        );
    }
    Ok(runners)
}

/// the broker's environment for a runner: identity variables of the broker and of the harness that started it left out
pub fn environment(
    parent: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    parent
        .into_iter()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            (!key.starts_with("SCP_") || key == "SCP_DIR")
                && !key.starts_with("CLAUDE_CODE_")
                && key != "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
        })
        .collect()
}

fn visible(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.encode_utf16().count())
        && !value
            .chars()
            .any(|c| c < '\u{20}' || ('\u{7f}'..='\u{9f}').contains(&c))
}

fn state_name(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && value.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// a status command's stdout `{state, detail?, attach?}`; anything malformed reads as state unknown, a field that looks like a credential is dropped
pub fn status_reply(stdout: &str) -> Map<String, Value> {
    let unknown = || Map::from_iter([("state".to_owned(), json!("unknown"))]);
    let Ok(Value::Object(v)) = serde_json::from_str::<Value>(stdout.trim()) else {
        return unknown();
    };
    let Some(state) = v
        .get("state")
        .and_then(Value::as_str)
        .filter(|s| state_name(s))
    else {
        return unknown();
    };
    let field = |key: &str, min: usize, max: usize| match v.get(key) {
        None => Ok(None),
        Some(Value::String(s)) if visible(s, min, max) => Ok(Some(s.as_str())),
        Some(_) => Err(()),
    };
    let (Ok(detail), Ok(attach)) = (field("detail", 0, 200), field("attach", 1, 1024)) else {
        return unknown();
    };
    let mut out = Map::from_iter([("state".to_owned(), json!(state))]);
    for (key, value) in [("detail", detail), ("attach", attach)] {
        if let Some(value) = value.filter(|v| find_secret(v).is_none()) {
            out.insert(key.into(), json!(value));
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub code: i32,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

type Tail = Arc<Mutex<(Vec<u8>, bool)>>;

async fn keep_tail(mut pipe: impl AsyncRead + Unpin, bytes: usize, into: Tail) {
    let mut chunk = [0u8; 4096];
    while let Ok(size) = pipe.read(&mut chunk).await {
        if size == 0 {
            break;
        }
        let Ok(mut kept) = into.lock() else { break };
        kept.0.extend_from_slice(&chunk[..size]);
        if kept.0.len() > bytes {
            let drop = kept.0.len() - bytes;
            kept.0.drain(..drop);
            kept.1 = true;
        }
    }
}

fn taken(tail: &Tail) -> (String, bool) {
    tail.lock().map_or((String::new(), false), |kept| {
        (String::from_utf8_lossy(&kept.0).into_owned(), kept.1)
    })
}

/// runs a runner in its own process group with `request` on stdin; its exit code (124 on timeout, the group then killed), stdout and cleaned stderr tail
pub async fn run(
    command: &[String],
    timeout_s: u64,
    request: &str,
    env: &[(OsString, OsString)],
    cwd: &Path,
) -> Outcome {
    let deadline = Instant::now() + Duration::from_secs(timeout_s);
    let program = command.first().map_or("", String::as_str);
    let failed = |code: i32, message: String| Outcome {
        code,
        timed_out: false,
        stdout: String::new(),
        stderr: crate::session::handback_output(&message, false, STDERR_BYTES as i64),
    };
    let spawned = tokio::process::Command::new(program)
        .args(command.iter().skip(1))
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .current_dir(cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return failed(127, format!("{program}: command not found"));
        }
        Err(error) => return failed(126, format!("{program}: {error}")),
    };
    let pid = child.id();
    let out: Tail = Arc::default();
    let err: Tail = Arc::default();
    let mut readers = [
        child
            .stdout
            .take()
            .map(|pipe| tokio::spawn(keep_tail(pipe, STDOUT_BYTES, out.clone()))),
        child
            .stderr
            .take()
            .map(|pipe| tokio::spawn(keep_tail(pipe, STDERR_BYTES, err.clone()))),
    ];
    if let Some(mut stdin) = child.stdin.take() {
        let line = format!("{request}\n");
        tokio::spawn(async move {
            let _ = stdin.write_all(line.as_bytes()).await;
        });
    }
    let (code, timed_out) = tokio::select! {
        status = child.wait() => {
            use std::os::unix::process::ExitStatusExt;
            let code = status.map_or(128, |s| s.code().unwrap_or(128 + s.signal().unwrap_or(0)));
            let drain = Duration::from_millis(DRAIN_MS).min(deadline.saturating_duration_since(Instant::now()));
            let _ = tokio::time::timeout(drain, async {
                for reader in readers.iter_mut().flatten() {
                    let _ = reader.await;
                }
            }).await;
            (code, false)
        }
        _ = tokio::time::sleep_until(deadline) => {
            if let Some(pid) = pid.and_then(|p| i32::try_from(p).ok()) {
                // Signals the whole group the runner leads.
                unsafe { libc::kill(-pid, libc::SIGKILL) };
            }
            (124, true)
        }
    };
    for reader in readers.iter().flatten() {
        reader.abort();
    }
    let (stdout, stdout_cut) = taken(&out);
    let (stderr, stderr_cut) = taken(&err);
    Outcome {
        code,
        timed_out,
        stdout: if stdout_cut { String::new() } else { stdout },
        stderr: crate::session::handback_output(&stderr, stderr_cut, STDERR_BYTES as i64),
    }
}

/// a spawn_via row
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Record {
    pub spawner: String,
    pub name: String,
    pub runner: String,
    pub address: Option<String>,
    pub machine: Option<String>,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub attach: Option<String>,
    pub created_at: i64,
    pub ended_at: Option<i64>,
}

impl Record {
    pub fn from_row(row: &Row) -> Self {
        let owned = |key| text(row, key).map(str::to_owned);
        Self {
            spawner: owned("spawner").unwrap_or_default(),
            name: owned("name").unwrap_or_default(),
            runner: owned("runner").unwrap_or_default(),
            address: owned("address"),
            machine: owned("machine"),
            reference: owned("ref"),
            attach: owned("attach"),
            created_at: integer(row, "created_at").unwrap_or(0),
            ended_at: match row.get("ended_at") {
                None | Some(SqlValue::Null) => None,
                _ => integer(row, "ended_at"),
            },
        }
    }
    fn key(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

type StatusResult = Shared<BoxFuture<'static, Map<String, Value>>>;

struct Cached {
    until: Arc<AtomicI64>,
    result: StatusResult,
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// the runners file, the status cache and the slots status commands share
pub struct Service {
    path: PathBuf,
    now: Clock,
    cache: Mutex<HashMap<String, Cached>>,
    slots: Arc<Semaphore>,
}

impl Service {
    pub fn new(path: PathBuf, now: Clock) -> Self {
        Self {
            path,
            now,
            cache: Mutex::default(),
            slots: Arc::new(Semaphore::new(STATUS_SLOTS)),
        }
    }

    /// `$SCP_RUNNERS_FILE`, else runners.json beside the policy file
    pub fn from_env(policy_file: &Path) -> Self {
        let path = std::env::var_os("SCP_RUNNERS_FILE").map_or_else(
            || {
                policy_file
                    .parent()
                    .unwrap_or(Path::new(""))
                    .join("runners.json")
            },
            PathBuf::from,
        );
        Self::new(path, Arc::new(now_ms))
    }

    pub fn configs(&self) -> Result<HashMap<String, Runner>, String> {
        let shown = self.path.display().to_string();
        if !self.path.exists() {
            return Ok(HashMap::new());
        }
        let text = std::fs::read_to_string(&self.path).map_err(|e| e.to_string())?;
        parse_config(&text, &shown)
    }

    fn at(&self) -> Value {
        json!(crate::core::timestamp((self.now)()))
    }

    async fn execute(command: &[String], timeout_s: u64, input: &str) -> Outcome {
        let home = crate::paths::account_home()
            .or_else(|_| std::env::var_os("HOME").map(PathBuf::from).ok_or(()))
            .unwrap_or_default();
        run(
            command,
            timeout_s,
            input,
            &environment(std::env::vars_os()),
            &home,
        )
        .await
    }

    /// the runner's status of `record`, shared by concurrent callers and kept 15 seconds after it completes
    pub async fn status(
        &self,
        record: &Record,
        config: &Runner,
        input: String,
    ) -> Map<String, Value> {
        let Some(command) = config.status.clone() else {
            return Map::new();
        };
        let key = record.key();
        let result = {
            let Ok(mut cache) = self.cache.lock() else {
                return Map::new();
            };
            let now = (self.now)();
            match cache.get(&key) {
                Some(hit) if hit.until.load(Ordering::SeqCst) > now => hit.result.clone(),
                _ => {
                    let until = Arc::new(AtomicI64::new(i64::MAX));
                    let (slots, clock, timeout, done) = (
                        self.slots.clone(),
                        self.now.clone(),
                        config.status_timeout_s,
                        until.clone(),
                    );
                    let task = tokio::spawn(async move {
                        let permit = slots.acquire_owned().await;
                        let r = Self::execute(&command, timeout, &input).await;
                        drop(permit);
                        let mut status = if r.code == 0 {
                            status_reply(&r.stdout)
                        } else if r.code == 77 {
                            Map::from_iter([("state".to_owned(), json!("unknown"))])
                        } else {
                            let detail = if r.timed_out {
                                "timeout".to_owned()
                            } else {
                                format!("exit {}", r.code)
                            };
                            Map::from_iter([
                                ("state".to_owned(), json!("error")),
                                ("detail".to_owned(), json!(detail)),
                            ])
                        };
                        let attach = status.remove("attach");
                        done.store(clock() + STATUS_TTL_MS, Ordering::SeqCst);
                        status.insert("at".into(), json!(crate::core::timestamp(clock())));
                        let mut out =
                            Map::from_iter([("status".to_owned(), Value::Object(status))]);
                        if let Some(attach) = attach {
                            out.insert("attach".into(), attach);
                        }
                        out
                    });
                    let result = async move { task.await.unwrap_or_default() }
                        .boxed()
                        .shared();
                    cache.insert(
                        key,
                        Cached {
                            until,
                            result: result.clone(),
                        },
                    );
                    result
                }
            }
        };
        result.await
    }

    fn prune(&self) {
        let now = (self.now)();
        if let Ok(mut cache) = self.cache.lock() {
            cache.retain(|_, hit| hit.until.load(Ordering::SeqCst) > now);
        }
    }

    /// the runner's stop of `record`: `{name, stop, code?, stderr?}`
    pub async fn stop(&self, record: &Record, input: Option<String>) -> Value {
        let name = &record.runner;
        let config = match self.configs() {
            Err(error) => return json!({"name": name, "stop": "failed", "stderr": error}),
            Ok(runners) => runners.get(name).cloned(),
        };
        let (Some(config), Some(input)) = (config.filter(|c| c.stop.is_some()), input) else {
            return json!({"name": name, "stop": "none"});
        };
        let r = Self::execute(
            config.stop.as_deref().unwrap_or_default(),
            config.timeout_s,
            &input,
        )
        .await;
        let stop = if r.timed_out {
            "timeout"
        } else {
            match r.code {
                0 => "stopped",
                77 => "declined",
                _ => "failed",
            }
        };
        let mut out = json!({"name": name, "stop": stop, "code": r.code});
        if !r.stderr.is_empty() {
            out["stderr"] = json!(r.stderr);
        }
        out
    }
}

/// a view's runner object to enrich: where it sits in the result, the endpoint it belongs to and its via record
pub struct Target {
    pub pointer: String,
    pub endpoint: String,
    pub record: Record,
    pub input: Option<String>,
}

/// runner work a call leaves for after the core lock is released
pub enum Job {
    Enrich(Vec<Target>),
    Stop {
        record: Record,
        input: Option<String>,
    },
}

impl Job {
    pub async fn finish(self, core: &SharedCore, service: &Service, result: &mut Value) {
        match self {
            Job::Stop { record, input } => {
                result["runner"] = service.stop(&record, input).await;
            }
            Job::Enrich(targets) => {
                let configs = service.configs();
                service.prune();
                let mut pending = Vec::new();
                for target in targets {
                    let runners = match &configs {
                        Err(_) => {
                            if let Some(runner) = result.pointer_mut(&target.pointer) {
                                runner["status"] = json!({"state": "error", "detail": "invalid runners file", "at": service.at()});
                            }
                            continue;
                        }
                        Ok(runners) => runners,
                    };
                    let (Some(config), Some(input)) = (
                        runners
                            .get(&target.record.runner)
                            .filter(|c| c.status.is_some()),
                        target.input.clone(),
                    ) else {
                        continue;
                    };
                    let config = config.clone();
                    pending.push(async move {
                        let found = service.status(&target.record, &config, input).await;
                        (target, found)
                    });
                }
                if pending.is_empty() {
                    return;
                }
                let found = join_all(pending).await;
                let core = core.lock().await;
                for (target, found) in found {
                    let Ok(Some(current)) = core.via_record_of(&target.endpoint).await else {
                        continue;
                    };
                    if current.ended_at.is_some() || current != target.record {
                        continue;
                    }
                    if let Some(Value::Object(runner)) = result.pointer_mut(&target.pointer) {
                        runner.extend(found);
                    }
                }
            }
        }
    }
}

impl Core {
    /// the via record of the endpoint with id `id`, if its runner started it elsewhere
    pub async fn via_record_of(&self, id: &str) -> Result<Option<Record>, RpcError> {
        let Some(row) = self.by_id(id).await? else {
            return Ok(None);
        };
        Ok(self.via_for(&row).await?.as_ref().map(Record::from_row))
    }

    /// the stdin request `{scp, event, name, runner, parent, address?, machine?, ref?}` a runner reads; None when the spawner is gone
    pub async fn runner_input(&self, record: &Record, event: &str) -> Option<String> {
        let spawner = self.by_id(&record.spawner).await.ok()??;
        let parent = crate::views::address(&spawner);
        let parent = match &self.federation.machine {
            Some(machine) => format!(
                "me/{machine}/{}",
                parent
                    .split_once('/')
                    .map_or(parent.as_str(), |(_, rest)| rest)
            ),
            None => parent,
        };
        let quote = |v: &str| serde_json::to_string(v).unwrap_or_default();
        let mut line = format!(
            "{{\"scp\":1,\"event\":{},\"name\":{},\"runner\":{},\"parent\":{}",
            quote(event),
            quote(&record.name),
            quote(&record.runner),
            quote(&parent)
        );
        for (key, value) in [
            ("address", &record.address),
            ("machine", &record.machine),
            ("ref", &record.reference),
        ] {
            if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
                line.push_str(&format!(",\"{key}\":{}", quote(value)));
            }
        }
        line.push('}');
        Some(line)
    }

    /// the status enrichment of the runner objects at `pointers`, each of the endpoint id beside it
    pub async fn enrich_job(&self, views: Vec<(String, String)>) -> Result<Option<Job>, RpcError> {
        let mut targets = Vec::new();
        for (pointer, endpoint) in views {
            let Some(record) = self.via_record_of(&endpoint).await? else {
                continue;
            };
            if record.ended_at.is_some() {
                continue;
            }
            let input = self.runner_input(&record, "status").await;
            targets.push(Target {
                pointer,
                endpoint,
                record,
                input,
            });
        }
        Ok((!targets.is_empty()).then_some(Job::Enrich(targets)))
    }

    /// the enrichment of a `list` result's endpoints that carry a runner
    pub async fn list_job(&self, result: &Value) -> Result<Option<Job>, RpcError> {
        let views = result["endpoints"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter(|(_, view)| view.get("runner").is_some())
            .filter_map(|(i, view)| {
                Some((
                    format!("/endpoints/{i}/runner"),
                    view["id"].as_str()?.to_owned(),
                ))
            })
            .collect();
        self.enrich_job(views).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<HashMap<String, Runner>, String> {
        parse_config(text, "r.json")
    }

    #[test]
    fn runners_files_parse_with_defaults_and_name_what_is_wrong() {
        let ok = parse(r#"{"vm":{"command":["go"],"stop":["halt","now"],"status_timeout_s":7},"b2":{"command":["x"],"timeout_s":null}}"#).unwrap();
        assert_eq!(
            ok["vm"],
            Runner {
                command: vec!["go".into()],
                timeout_s: 60,
                stop: Some(vec!["halt".into(), "now".into()]),
                status: None,
                status_timeout_s: 7
            }
        );
        assert_eq!((ok["b2"].timeout_s, ok["b2"].status_timeout_s), (60, 5));
        assert_eq!(parse("{").unwrap_err(), "r.json is not JSON");
        assert_eq!(
            parse("[]").unwrap_err(),
            "r.json maps runner names to {command, timeout_s?}"
        );
        assert_eq!(
            parse(r#"{"Bad":{"command":["x"]}}"#).unwrap_err(),
            "r.json: runner \"Bad\" is not a valid name: lowercase letters, digits and -, at most 32"
        );
        assert_eq!(
            parse(r#"{"a":1}"#).unwrap_err(),
            "r.json: runner a needs command, a non-empty list of words"
        );
        assert_eq!(
            parse(r#"{"a":{"command":["x"],"status":["", "y"]}}"#).unwrap_err(),
            "r.json: runner a needs status, a non-empty list of words"
        );
        assert_eq!(
            parse(r#"{"a":{"command":["x"],"timeout_s":0,"status_timeout_s":61}}"#).unwrap_err(),
            "r.json: runner a's status_timeout_s is whole seconds, 1 to 60"
        );
        assert_eq!(
            parse(r#"{"a":{"command":["x"],"timeout_s":1.5}}"#).unwrap_err(),
            "r.json: runner a's timeout_s is whole seconds, 1 to 3600"
        );
        assert_eq!(
            parse(r#"{"a":{"command":["x"],"status_timeout_s":null}}"#).unwrap_err(),
            "r.json: runner a's status_timeout_s is whole seconds, 1 to 60"
        );
        assert_eq!(
            parse(r#"{"z":{},"1":{}}"#).unwrap_err(),
            "r.json: runner 1 needs command, a non-empty list of words"
        );
        assert_eq!(
            parse(r#"{"z":{},"a":{}}"#).unwrap_err(),
            "r.json: runner z needs command, a non-empty list of words"
        );
    }

    #[test]
    fn status_replies_reject_malformed_fields_and_drop_secrets() {
        for bad in [
            "nope",
            "[]",
            "{}",
            r#"{"state":"Up"}"#,
            r#"{"state":"ok","detail":null}"#,
            r#"{"state":"ok","attach":""}"#,
            r#"{"state":"ok","detail":"a\nb"}"#,
        ] {
            assert_eq!(
                Value::Object(status_reply(bad)),
                json!({"state": "unknown"}),
                "{bad}"
            );
        }
        assert_eq!(
            Value::Object(status_reply(
                r#" {"state":"starting","detail":"booting","attach":"ssh vm"} "#
            )),
            json!({"state": "starting", "detail": "booting", "attach": "ssh vm"})
        );
        let secret = format!(
            r#"{{"state":"ok","attach":"scp_t_test{}"}}"#,
            "v".repeat(32)
        );
        assert_eq!(Value::Object(status_reply(&secret)), json!({"state": "ok"}));
    }

    #[test]
    fn the_environment_drops_identity_variables() {
        let env = environment(
            [
                "SCP_DIR",
                "SCP_TOKEN",
                "CLAUDE_CODE_X",
                "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
                "PATH",
            ]
            .map(|k| (k.into(), "1".into())),
        );
        let keys: Vec<_> = env
            .iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert_eq!(keys, ["SCP_DIR", "PATH"]);
    }

    #[tokio::test]
    async fn runs_report_exit_codes_stdout_and_timeouts() {
        let sh = |script: &str| vec!["/bin/sh".to_owned(), "-c".to_owned(), script.to_owned()];
        let dir = std::env::temp_dir();
        let r = run(&sh("cat; echo err >&2; exit 3"), 5, "{\"a\":1}", &[], &dir).await;
        assert_eq!(
            (r.code, r.timed_out, r.stdout.as_str(), r.stderr.as_str()),
            (3, false, "{\"a\":1}\n", "err")
        );
        let started = std::time::Instant::now();
        let r = run(&sh("sleep 30 & wait"), 1, "{}", &[], &dir).await;
        assert_eq!((r.code, r.timed_out), (124, true));
        assert!(started.elapsed() < Duration::from_secs(3));
        let r = run(&["/no/such/runner".to_owned()], 5, "{}", &[], &dir).await;
        assert_eq!(
            (r.code, r.stderr.as_str()),
            (127, "/no/such/runner: command not found")
        );
    }

    #[tokio::test]
    async fn status_is_shared_while_running_and_kept_fifteen_seconds() {
        let dir = std::env::temp_dir().join(format!("scp-runner-status-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("log");
        let _ = std::fs::remove_file(&log);
        let clock = Arc::new(AtomicI64::new(1_000_000));
        let now = clock.clone();
        let service = Service::new(
            dir.join("runners.json"),
            Arc::new(move || now.load(Ordering::SeqCst)),
        );
        let config = Runner {
            command: vec!["true".into()],
            timeout_s: 5,
            stop: None,
            status: Some(vec![
                "/bin/sh".into(),
                "-c".into(),
                format!(
                    "sleep 0.2; printf x >> {}; echo '{{\"state\":\"running\",\"attach\":\"ssh vm\"}}'",
                    log.display()
                ),
            ]),
            status_timeout_s: 5,
        };
        let record = Record {
            spawner: "s".into(),
            name: "w".into(),
            runner: "vm".into(),
            address: None,
            machine: None,
            reference: None,
            attach: None,
            created_at: 1,
            ended_at: None,
        };
        let ran = || std::fs::read_to_string(&log).unwrap_or_default();
        let (a, b) = tokio::join!(
            service.status(&record, &config, "{}".into()),
            service.status(&record, &config, "{}".into())
        );
        assert_eq!(a, b);
        assert_eq!(a["status"]["state"], "running");
        assert_eq!(a["attach"], "ssh vm");
        assert!(a["status"].get("attach").is_none());
        assert_eq!(ran(), "x");
        clock.fetch_add(14_999, Ordering::SeqCst);
        service.status(&record, &config, "{}".into()).await;
        assert_eq!(ran(), "x");
        clock.fetch_add(1, Ordering::SeqCst);
        service.prune();
        service.status(&record, &config, "{}".into()).await;
        assert_eq!(ran(), "xx");
        let other = Record {
            created_at: 2,
            ..record
        };
        service.status(&other, &config, "{}".into()).await;
        assert_eq!(ran(), "xxx");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
