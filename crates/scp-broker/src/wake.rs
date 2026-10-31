//! How a message wakes an agent: the `wake` method, waker connections, and the wake hooks (wakers.json) the broker runs for hibernated
//! endpoints and broker wakes. A hook runs as a child process from its configured argv, never a shell, with metadata on stdin and no body.

use std::collections::{BTreeMap, HashSet};
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};

use scp_core::protocol::{BROKER_WAKES, ErrorCode, SPAWN_PROVIDER, WAKES, wake_decline_of};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinSet;

use crate::claims::{hash, token};
use crate::core::{Core, SharedCore, integer, now_ms, text, timestamp};
use crate::hibernate::wake_provider;
use crate::proto::RpcError;
use crate::scrub::{redact_secrets, strip_control};
use crate::session::HookOf;
use crate::state::ConnectionId;
use crate::store::{Row, SqlValue};
use crate::views::address;

const TIMEOUT_DEFAULT_S: u64 = 60;
const TIMEOUT_MAX_S: u64 = 3600;
const STDERR_KEEP: usize = 1024;
const STDOUT_KEEP: usize = 4096;
/// a waker's exit code for a decline, with `{"declined": "<reason>"}` on stdout
pub const WAKE_DECLINED_EXIT: i32 = 77;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakerConfig {
    pub command: Vec<String>,
    pub timeout_s: u64,
}

pub type WakerConfigs = BTreeMap<String, WakerConfig>;

/// a wakers.json object: `{"<provider>": {"command": [argv...], "timeout_s"?: N}}`, other fields ignored
pub fn parse_wakers(value: &Value) -> Result<WakerConfigs, String> {
    let entries = value
        .as_object()
        .ok_or("wakers is an object of provider names")?;
    let mut out = WakerConfigs::new();
    for (provider, entry) in entries {
        if !wake_provider(provider) {
            return Err(format!("{} is not a provider name", json!(provider)));
        }
        let entry = entry
            .as_object()
            .ok_or_else(|| format!("waker {provider} is not an object"))?;
        let command = entry
            .get("command")
            .and_then(Value::as_array)
            .filter(|c| !c.is_empty())
            .and_then(|c| {
                c.iter()
                    .map(|part| part.as_str().filter(|p| !p.is_empty()).map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .ok_or_else(|| format!("waker {provider}: command is a nonempty array of strings"))?;
        let timeout_s = match entry.get("timeout_s") {
            None | Some(Value::Null) => TIMEOUT_DEFAULT_S,
            Some(value) => value
                .as_f64()
                .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= TIMEOUT_MAX_S as f64)
                .map(|n| n as u64)
                .ok_or_else(|| {
                    format!("waker {provider}: timeout_s is a whole number of seconds from 1 to {TIMEOUT_MAX_S}")
                })?,
        };
        out.insert(provider.clone(), WakerConfig { command, timeout_s });
    }
    Ok(out)
}

/// the configured wakers and the queue the waker task reads endpoints to kick from
pub struct Wakers {
    path: PathBuf,
    builtin: WakerConfigs,
    loaded: StdMutex<Option<(SystemTime, u64, WakerConfigs)>>,
    tx: StdMutex<Option<mpsc::UnboundedSender<String>>>,
}

impl Wakers {
    pub fn new(path: PathBuf, builtin: WakerConfigs) -> Self {
        Self {
            path,
            builtin,
            loaded: StdMutex::new(None),
            tx: StdMutex::new(None),
        }
    }

    /// the wakers the broker always knows, by the CLI's own wake commands
    pub fn builtin() -> WakerConfigs {
        [
            (SPAWN_PROVIDER, "spawn-wake", 60),
            ("codex-queue", "codex-wake", 120),
            ("claude-bg", "claude-wake", 90),
        ]
        .into_iter()
        .map(|(provider, command, timeout_s)| {
            (
                provider.to_owned(),
                WakerConfig {
                    command: vec!["swarm".into(), command.into()],
                    timeout_s,
                },
            )
        })
        .collect()
    }

    /// the built-in wakers under those of the file, read again when its mtime or size changes; a malformed file configures nothing
    pub fn configs(&self) -> WakerConfigs {
        let mut out = self.builtin.clone();
        out.extend(self.configured());
        out
    }

    fn configured(&self) -> WakerConfigs {
        let mut loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner());
        let Ok(meta) = std::fs::metadata(&self.path) else {
            *loaded = None;
            return WakerConfigs::new();
        };
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if let Some((at, size, wakers)) = loaded.as_ref()
            && *at == mtime
            && *size == meta.len()
        {
            return wakers.clone();
        }
        let wakers = std::fs::read_to_string(&self.path)
            .map_err(|e| e.to_string())
            .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()))
            .and_then(|value| parse_wakers(&value))
            .unwrap_or_else(|error| {
                tracing::warn!(path = %self.path.display(), %error, "the wakers are invalid; no wake hook runs until they are fixed");
                WakerConfigs::new()
            });
        *loaded = Some((mtime, meta.len(), wakers.clone()));
        wakers
    }

    pub fn known(&self, provider: &str) -> bool {
        self.configs().contains_key(provider)
    }

    /// runs the endpoint's wake hook when one is due; never waits
    pub fn kick(&self, endpoint: &str) {
        if let Some(tx) = self.tx.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = tx.send(endpoint.to_owned());
        }
    }

    fn connect(&self) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        *self.tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
        rx
    }
}

/// one due wake hook run: the newest unread message's metadata only, never its body
#[derive(Debug, Clone)]
pub struct WakeJob {
    pub endpoint: String,
    pub address: String,
    pub handle: String,
    pub provider: String,
    pub reference: Option<String>,
    pub session: Option<String>,
    pub message: Value,
    pub message_id: String,
    pub from: Option<String>,
    pub unread: i64,
    pub ticket: Option<String>,
}

/// how a run ended
#[derive(Debug, Clone, Default)]
pub struct WakeOutcome {
    pub ok: bool,
    pub code: Option<i32>,
    pub error: Option<String>,
    pub declined: Option<String>,
    pub ms: i64,
    pub message: Option<String>,
}

#[derive(Debug, Default)]
struct RunResult {
    ok: bool,
    code: Option<i32>,
    error: Option<String>,
    stdout: String,
}

fn broker_wake(row: &Row) -> bool {
    text(row, "hibernate").is_none()
        && text(row, "wake").is_some_and(|w| BROKER_WAKES.iter().any(|b| b.wire() == w))
}

const BROKER_WAKE_SQL: &str = "COALESCE(wake IN ('codex-queue'), 0)";

/// the row's wake when it is a live one
pub fn wake_of(row: &Row) -> Option<&str> {
    text(row, "wake").filter(|w| *w != "none" && WAKES.iter().any(|k| k.wire() == *w))
}

fn waking(row: &Row, now: i64, grace_ms: i64) -> bool {
    wake_of(row).is_some()
        && (integer(row, "wakers").unwrap_or(0) > 0
            || integer(row, "waker_left").unwrap_or(0) >= now - grace_ms)
}

fn sv(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

fn opt(value: Option<&str>) -> SqlValue {
    value.map_or(SqlValue::Null, sv)
}

/// the host name up to its first dot
fn short_hostname() -> String {
    let mut buf = [0u8; 256];
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    let name = if ok {
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    } else {
        String::new()
    };
    name.split('.').next().unwrap_or("").to_owned()
}

/// the child environment: the broker's own without any SCP_ variable, then the relay directory and the wake's metadata
fn child_env(dir: &str, job: &WakeJob) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(key, _)| !key.starts_with("SCP_"))
        .collect();
    env.push(("SCP_DIR".into(), dir.into()));
    env.push(("SCP_WAKE_ENDPOINT".into(), job.address.clone()));
    env.push(("SCP_WAKE_HANDLE".into(), job.handle.clone()));
    env.push((
        "SCP_WAKE_REF".into(),
        job.reference.clone().unwrap_or_default(),
    ));
    if let Some(session) = &job.session {
        env.push(("SCP_WAKE_SESSION".into(), session.clone()));
    }
    env.push(("SCP_WAKE_PROVIDER".into(), job.provider.clone()));
    env.push(("SCP_WAKE_MESSAGE_ID".into(), job.message_id.clone()));
    env.push(("SCP_WAKE_FROM".into(), job.from.clone().unwrap_or_default()));
    for (key, field) in [("SCP_WAKE_KIND", "kind"), ("SCP_WAKE_THREAD", "thread")] {
        env.push((
            key.into(),
            job.message[field].as_str().unwrap_or("").to_owned(),
        ));
    }
    if let Some(ticket) = &job.ticket {
        env.push(("SCP_WAKE_TICKET".into(), ticket.clone()));
    }
    env
}

/// reads a pipe to its end, keeping its first `keep` bytes
async fn head(mut pipe: impl AsyncRead + Unpin, keep: usize) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 4096];
    while let Ok(n) = pipe.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        let room = keep.saturating_sub(kept.len());
        kept.extend_from_slice(&chunk[..n.min(room)]);
    }
    kept
}

fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGABRT => "SIGABRT".into(),
        other => format!("signal {other}"),
    }
}

/// kills the child's process group unless disarmed once the child was reaped
struct Group(Option<i32>);

impl Drop for Group {
    fn drop(&mut self) {
        if let Some(pid) = self.0.take() {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

/// runs the waker from its argv with `input` on stdin, killing its process group on timeout
async fn exec(config: &WakerConfig, input: String, env: Vec<(String, String)>) -> RunResult {
    let mut command = tokio::process::Command::new(&config.command[0]);
    command
        .args(&config.command[1..])
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return RunResult {
                error: Some(error.to_string()),
                ..RunResult::default()
            };
        }
    };
    let mut group = Group(child.id().map(|pid| pid as i32));
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let feed = async move {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
    };
    let run = async {
        let (_, out, err, status) = tokio::join!(
            feed,
            async {
                match stdout {
                    Some(pipe) => head(pipe, STDOUT_KEEP).await,
                    None => Vec::new(),
                }
            },
            async {
                match stderr {
                    Some(pipe) => head(pipe, STDERR_KEEP).await,
                    None => Vec::new(),
                }
            },
            child.wait()
        );
        (out, err, status)
    };
    let finished = tokio::time::timeout(Duration::from_secs(config.timeout_s), run).await;
    let Ok((out, err, status)) = finished else {
        drop(group);
        let _ = child.wait().await;
        return RunResult {
            error: Some(format!("timed out after {} s", config.timeout_s)),
            ..RunResult::default()
        };
    };
    group.0 = None;
    let stdout = String::from_utf8_lossy(&out).into_owned();
    match status {
        Err(error) => RunResult {
            error: Some(error.to_string()),
            ..RunResult::default()
        },
        Ok(status) if status.success() => RunResult {
            ok: true,
            code: Some(0),
            error: None,
            stdout,
        },
        Ok(status) => {
            let stderr = String::from_utf8_lossy(&err);
            let last = stderr.trim().lines().last().map(str::trim).unwrap_or("");
            let what = match status.code() {
                Some(code) => format!("exit {code}"),
                None => format!(
                    "killed by {}",
                    signal_name(status.signal().unwrap_or(libc::SIGKILL))
                ),
            };
            RunResult {
                ok: false,
                code: status.code(),
                error: Some(if last.is_empty() {
                    what
                } else {
                    format!("{what}: {last}")
                }),
                stdout,
            }
        }
    }
}

/// the decline a waker's exit 77 and stdout carry
fn decline_of(code: Option<i32>, stdout: &str) -> Option<String> {
    if code != Some(WAKE_DECLINED_EXIT) {
        return None;
    }
    let value = serde_json::from_str::<Value>(stdout).ok()?;
    wake_decline_of(value.get("declined")?).map(str::to_owned)
}

/// starts the task that runs wake hooks for the endpoints kicked: at most one run per endpoint, one kicked while its run is on runs again
/// once it ends. Each run locks the core only to read its job and to record its result
pub fn start(
    core: SharedCore,
    kicks: mpsc::UnboundedReceiver<String>,
) -> tokio::task::JoinHandle<()> {
    let machine = short_hostname();
    tokio::spawn(dispatch(core, kicks, machine))
}

async fn dispatch(core: SharedCore, mut kicks: mpsc::UnboundedReceiver<String>, machine: String) {
    let busy = Arc::new(StdMutex::new((
        HashSet::<String>::new(),
        HashSet::<String>::new(),
    )));
    let mut runs = JoinSet::new();
    loop {
        tokio::select! {
            kicked = kicks.recv() => {
                let Some(endpoint) = kicked else { break };
                {
                    let mut sets = busy.lock().unwrap_or_else(|e| e.into_inner());
                    if sets.0.contains(&endpoint) {
                        sets.1.insert(endpoint);
                        continue;
                    }
                    sets.0.insert(endpoint.clone());
                }
                runs.spawn(run(core.clone(), endpoint, machine.clone(), busy.clone()));
            }
            Some(_) = runs.join_next(), if !runs.is_empty() => {}
        }
    }
    runs.abort_all();
    while runs.join_next().await.is_some() {}
}

async fn run(
    core: SharedCore,
    endpoint: String,
    machine: String,
    busy: Arc<StdMutex<(HashSet<String>, HashSet<String>)>>,
) {
    let due = {
        let mut guard = core.lock().await;
        if guard.state.closing {
            None
        } else {
            match guard.wake_due(&endpoint, now_ms()).await {
                Ok(Some(job)) => {
                    let config = guard.wakers.configs().get(&job.provider).cloned();
                    Some((job, config, guard.paths.dir.to_string_lossy().into_owned()))
                }
                Ok(None) => None,
                Err(error) => {
                    tracing::error!(%error, "a wake hook did not start");
                    None
                }
            }
        }
    };
    if let Some((job, config, dir)) = due {
        let started = now_ms();
        let outcome = match config {
            None => WakeOutcome {
                error: Some(format!("no waker {} is configured", job.provider)),
                ..WakeOutcome::default()
            },
            Some(config) => {
                let event = json!({
                    "scp": 1, "event": "wake", "endpoint": job.address, "handle": job.handle, "provider": job.provider,
                    "ref": job.reference, "machine": machine, "message": job.message, "unread": job.unread,
                });
                let result = exec(&config, format!("{event}\n"), child_env(&dir, &job)).await;
                let declined = (!result.ok)
                    .then(|| decline_of(result.code, &result.stdout))
                    .flatten();
                WakeOutcome {
                    ok: result.ok,
                    code: result.code,
                    error: if declined.is_some() {
                        None
                    } else {
                        result.error
                    },
                    declined,
                    ..WakeOutcome::default()
                }
            }
        };
        let mut guard = core.lock().await;
        if !guard.state.closing {
            let outcome = WakeOutcome {
                ms: now_ms() - started,
                message: Some(job.message_id.clone()),
                ..outcome
            };
            match guard.wake_result(&endpoint, &outcome).await {
                Ok(true) => {
                    let _ = guard.presence_moved(&endpoint, true, false).await;
                    guard.bridge_changed(&endpoint);
                }
                Ok(false) => {}
                Err(error) => tracing::error!(%error, "a wake result was not recorded"),
            }
        }
    }
    let again = {
        let mut sets = busy.lock().unwrap_or_else(|e| e.into_inner());
        sets.0.remove(&endpoint);
        sets.1.remove(&endpoint)
    };
    if again {
        core.lock().await.wakers.kick(&endpoint);
    }
}

/// connects the core's kicks to a new waker task
pub async fn attach(core: &SharedCore) -> tokio::task::JoinHandle<()> {
    let kicks = core.lock().await.wakers.connect();
    start(core.clone(), kicks)
}

/// a delivery reached `endpoint`, admitted locally or from a hub: its waiters and those of the root it wakes return, and its wake hook
/// runs when due
pub async fn wake_delivered(core: &Arc<Mutex<Core>>, endpoint: &str) {
    let mut core = core.lock().await;
    core.delivered(endpoint).await;
}

impl Core {
    /// what [`wake_delivered`] does, for a caller that holds the core
    pub async fn delivered(&mut self, endpoint: &str) {
        self.state.wake(endpoint);
        match self.wakes_root(endpoint).await {
            Ok(Some(root)) => self.state.wake(&root),
            Ok(None) => {}
            Err(error) => tracing::error!(%error, "wake root lookup failed"),
        }
        self.wakers.kick(endpoint);
    }

    /// the `wake` method: only the endpoint's own session, its own hook or an attested launcher says how it wakes
    pub async fn wake_rpc(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let connection = self.connection(conn)?;
        if connection.lineage.is_some() && !connection.own {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "only the endpoint's own session says how it wakes",
            ));
        }
        let reference = params.get("ref").filter(|v| !v.is_null());
        if reference.is_some() && !connection.holder {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "only a spawn holding its worker, by the grant it spent or a wake ticket, gives a durable ref",
            ));
        }
        if reference.is_some() && !self.wakers.known(SPAWN_PROVIDER) {
            return Err(RpcError::invalid_params(format!(
                "no waker {SPAWN_PROVIDER} is configured: this broker cannot hold a spawn durably"
            )));
        }
        let (me, hook) = self.hook_of(conn)?;
        let via = params.get("via").unwrap_or(&Value::Null);
        let changed = self.set_wake(&me, via, &hook, reference).await?;
        let row = self.must_endpoint(&me).await?;
        let holds = via.as_str().is_some_and(|v| v != "none")
            && text(&row, "hibernate").is_none()
            && wake_of(&row) == via.as_str();
        self.set_waker(conn, holds.then(|| me.clone())).await?;
        if changed {
            self.wakers.kick(&me);
        }
        if !self.presence_moved(&me, true, false).await? && changed {
            self.bridge_changed(&me);
        }
        if changed {
            self.subagents_moved(&me).await?;
            self.state.wake(&me);
        }
        Ok(json!({"changed": changed}))
    }

    /// sets how `endpoint` wakes; whether it changed. A hook of another harness process changes nothing
    pub async fn set_wake(
        &mut self,
        endpoint: &str,
        value: &Value,
        hook: &HookOf,
        reference: Option<&Value>,
    ) -> Result<bool, RpcError> {
        let Some(value) = value
            .as_str()
            .filter(|v| WAKES.iter().any(|w| w.wire() == *v))
        else {
            let names: Vec<String> = WAKES.iter().map(|w| w.wire().into_owned()).collect();
            return Err(RpcError::invalid_params(format!(
                "via must be one of {}",
                names.join(", ")
            )));
        };
        let reference = match reference {
            None => None,
            Some(value) => Some(self.wake_ref(value)?),
        };
        if reference.is_some() && (value != "spawn-resume" || hook.transient) {
            return Err(RpcError::invalid_params(
                "ref goes only with spawn-resume, from the connection that holds the spawn",
            ));
        }
        let row = self.must_endpoint(endpoint).await?;
        if text(&row, "kind") != Some("agent") {
            return Err(RpcError::invalid_params("only an agent endpoint wakes"));
        }
        if !self.holds(&row, hook).await? {
            return Ok(false);
        }
        let wake = (value != "none").then_some(value);
        let hold = if hook.transient {
            text(&row, "hold_ref").map(str::to_owned)
        } else {
            reference
        };
        let retry = text(&row, "wake") == wake
            && broker_wake(&row)
            && (text(&row, "wake_note").is_some() || text(&row, "wake_declined").is_some());
        if text(&row, "wake") == wake && text(&row, "hold_ref") == hold.as_deref() && !retry {
            return Ok(false);
        }
        self.store
            .all(
                "UPDATE endpoints SET wake = ?, hold_ref = ? WHERE id = ?",
                &[opt(wake), opt(hold.as_deref()), sv(endpoint)],
            )
            .await?;
        let moved = text(&row, "wake") != wake;
        if text(&row, "hibernate").is_none() && (moved || retry) {
            self.store.all("UPDATE endpoints SET wake_tried = NULL, wake_fails = 0, wake_note = NULL, wake_declined = NULL, declined_message = NULL, declined_from = NULL WHERE id = ?", &[sv(endpoint)]).await?;
        }
        Ok(moved || retry)
    }

    /// a connection that set the endpoint's wake starts (`live`) or stops counting as its waker; a hook's (`grace`) still counts for the
    /// restart grace after it closes
    pub async fn waker(&mut self, endpoint: &str, live: bool, grace: bool) -> Result<(), RpcError> {
        if live {
            self.store
                .all(
                    "UPDATE endpoints SET wakers = wakers + 1 WHERE id = ?",
                    &[sv(endpoint)],
                )
                .await?;
            return Ok(());
        }
        let now = now_ms();
        self.store.all("UPDATE endpoints SET wakers = MAX(wakers - 1, 0), waker_left = CASE WHEN ? THEN ? ELSE waker_left END WHERE id = ?", &[SqlValue::Int(i64::from(grace)), SqlValue::Int(now), sv(endpoint)]).await?;
        if !grace {
            self.lapse_wake(endpoint, now).await?;
        }
        Ok(())
    }

    /// clears a wake no waker holds once a hook waker's grace ran out too
    pub async fn lapse_wake(&mut self, endpoint: &str, now: i64) -> Result<(), RpcError> {
        let grace = self.cap("restartGraceS", 60) * 1000;
        self.store
            .all(
                &format!("UPDATE endpoints SET wake = NULL WHERE id = ? AND wakers = 0 AND COALESCE(waker_left, 0) < ? AND NOT {BROKER_WAKE_SQL}"),
                &[sv(endpoint), SqlValue::Int(now - grace)],
            )
            .await?;
        Ok(())
    }

    /// counts `conn` as the waker of `endpoint`, or of none, and reports the presence that moves
    pub async fn set_waker(
        &mut self,
        conn: ConnectionId,
        endpoint: Option<String>,
    ) -> Result<(), RpcError> {
        let Some(connection) = self.state.connections.get_mut(&conn) else {
            return Ok(());
        };
        if connection.waker == endpoint {
            return Ok(());
        }
        let was = std::mem::replace(&mut connection.waker, endpoint.clone());
        let transient = connection.mode == crate::state::Mode::Transient;
        if let Some(was) = &was {
            self.unwaker(was, transient).await?;
        }
        if let Some(endpoint) = &endpoint {
            self.waker(endpoint, true, false).await?;
            self.presence_moved(endpoint, true, false).await?;
            self.state.wake(endpoint);
            self.subagents_moved(endpoint).await?;
        }
        Ok(())
    }

    async fn unwaker(&mut self, was: &str, transient: bool) -> Result<(), RpcError> {
        let before = self
            .by_id(was)
            .await?
            .and_then(|r| wake_of(&r).map(str::to_owned));
        self.waker(was, false, transient).await?;
        let after = self
            .by_id(was)
            .await?
            .and_then(|r| wake_of(&r).map(str::to_owned));
        if !self.presence_moved(was, true, false).await? && before != after {
            self.bridge_changed(was);
        }
        self.subagents_moved(was).await
    }

    /// a closing connection lets go of the endpoint it woke: a durable hold it kept hibernates, and its wake lapses
    pub async fn waker_closed(&mut self, endpoint: &str, transient: bool) -> Result<(), RpcError> {
        let held = if self.state.closing {
            Vec::new()
        } else {
            self.hibernate_held(Some(endpoint)).await?
        };
        for view in &held {
            if let Some(id) = view["id"].as_str() {
                self.presence_moved(id, true, false).await?;
            }
        }
        if !self.state.closing {
            self.unwaker(endpoint, transient).await?;
        }
        for view in &held {
            if let Some(id) = view["id"].as_str() {
                self.wakers.kick(id);
            }
        }
        Ok(())
    }

    /// a root's in-process subagents show its wake and the presence it gives them
    async fn subagents_moved(&mut self, root: &str) -> Result<(), RpcError> {
        for id in self.subagents_of(root).await? {
            self.presence_moved(&id, true, false).await?;
        }
        Ok(())
    }

    pub async fn subagents_of(&self, root: &str) -> Result<Vec<String>, RpcError> {
        Ok(self.store.all("SELECT id FROM endpoints WHERE parent_ep = ? AND kind = 'agent' AND substr(session, 1, 4) = 'sub:'", &[sv(root)]).await?
            .iter().filter_map(|r| text(r, "id").map(str::to_owned)).collect())
    }

    /// the wake of the root a message to the in-process subagent `row` reaches, with the root: while the subagent belongs to the root's
    /// current session, has no live wake of its own, and the root has a wake with a live waker and is not hibernated
    pub async fn root_wake(&self, row: &Row, now: i64) -> Result<Option<(Row, String)>, RpcError> {
        let grace = self.cap("restartGraceS", 60) * 1000;
        let Some(session) = text(row, "session").filter(|s| s.starts_with("sub:")) else {
            return Ok(None);
        };
        let Some(parent) = text(row, "parent_ep") else {
            return Ok(None);
        };
        if text(row, "kind") != Some("agent") || waking(row, now, grace) {
            return Ok(None);
        }
        let Some(colon) = session[4..].find(':') else {
            return Ok(None);
        };
        let id = &session[4..4 + colon];
        let Some(root) = self.by_id(parent).await? else {
            return Ok(None);
        };
        let key = text(&root, "session").or(text(&root, "id")).unwrap_or("");
        let mut expected = format!("sub:{id}:{key}");
        if expected.len() > 128 {
            let mut cut = 128;
            while !expected.is_char_boundary(cut) {
                cut -= 1;
            }
            expected.truncate(cut);
        }
        if text(&root, "hibernate").is_some() || !waking(&root, now, grace) || session != expected {
            return Ok(None);
        }
        let wake = wake_of(&root).unwrap_or("").to_owned();
        Ok(Some((root, wake)))
    }

    /// the root whose waker a delivery to the idle (`done`) in-process subagent `endpoint` reaches
    pub async fn wakes_root(&self, endpoint: &str) -> Result<Option<String>, RpcError> {
        let Some(row) = self.by_id(endpoint).await? else {
            return Ok(None);
        };
        if text(&row, "status_state") != Some("done") {
            return Ok(None);
        }
        Ok(self
            .root_wake(&row, now_ms())
            .await?
            .and_then(|(root, _)| text(&root, "id").map(str::to_owned)))
    }

    /// the endpoints whose waker the periodic pass kicks: hibernated, or with a broker wake
    pub async fn wakeable(&self) -> Result<Vec<String>, RpcError> {
        Ok(self.store.all(&format!("SELECT id FROM endpoints WHERE kind = 'agent' AND (hibernate IS NOT NULL OR {BROKER_WAKE_SQL})"), &[]).await?
            .iter().filter_map(|r| text(r, "id").map(str::to_owned)).collect())
    }

    /// the wake hook run a delivery to `endpoint` is due, recorded as tried: none while it is neither hibernated nor has a broker wake and a
    /// harness session, has no unread message (for any provider but spawn, none that arrived since it hibernated), ran within the debounce
    /// (doubling after failures up to the backoff cap), or its provider declined the newest unread message or another from its sender
    pub async fn wake_due(
        &mut self,
        endpoint: &str,
        now: i64,
    ) -> Result<Option<WakeJob>, RpcError> {
        self.settle_revived(now, Some(endpoint)).await?;
        let Some(row) = self.by_id(endpoint).await? else {
            return Ok(None);
        };
        let hibernate = text(&row, "hibernate");
        if text(&row, "kind") != Some("agent")
            || (hibernate.is_none()
                && !(broker_wake(&row) && text(&row, "harness_session").is_some()))
        {
            return Ok(None);
        }
        if let Some(tried) = integer(&row, "wake_tried") {
            let debounce = self.cap("wakeDebounceS", 60);
            let fails = integer(&row, "wake_fails").unwrap_or(0);
            let wait = if fails > 0 {
                debounce
                    .saturating_mul(1i64 << fails.min(40))
                    .min(self.cap("wakeBackoffMaxS", 900))
            } else {
                debounce
            };
            if now - tried < wait * 1000 {
                return Ok(None);
            }
        }
        let since = match hibernate {
            Some(provider) if provider != SPAWN_PROVIDER => {
                integer(&row, "hibernated_at").unwrap_or(0)
            }
            _ => 0,
        };
        let Some(newest) = self.store.all("SELECT m.id, m.from_ep, m.kind, m.thread, m.created_at FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ? AND m.created_at >= ? ORDER BY d.seq DESC LIMIT 1", &[sv(endpoint), SqlValue::Int(now), SqlValue::Int(since)]).await?.into_iter().next() else {
            return Ok(None);
        };
        let message_id = text(&newest, "id").unwrap_or("").to_owned();
        let from_ep = text(&newest, "from_ep").unwrap_or("");
        if text(&row, "wake_declined").is_some()
            && (text(&row, "declined_message") == Some(message_id.as_str())
                || text(&row, "declined_from") == Some(from_ep))
        {
            return Ok(None);
        }
        let unread = self
            .count(
                "SELECT COUNT(*) AS n FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ?",
                &[sv(endpoint), SqlValue::Int(now)],
            )
            .await?;
        let tickets = hibernate == Some(SPAWN_PROVIDER)
            || (hibernate.is_some() && text(&row, "revive").is_some())
            || broker_wake(&row);
        let ticket = tickets.then(|| token("kwt"));
        let kept = Self::kept_tickets(&row);
        self.store
            .all(
                "UPDATE endpoints SET wake_tried = ?, wake_ticket = ?, wake_tickets = ? WHERE id = ?",
                &[
                    SqlValue::Int(now),
                    ticket.as_deref().map_or(SqlValue::Null, |t| sv(hash(t))),
                    opt(kept.as_deref()),
                    sv(endpoint),
                ],
            )
            .await?;
        let from = self.by_id(from_ep).await?.map(|s| address(&s));
        let message = json!({
            "id": message_id, "from": from, "kind": text(&newest, "kind"), "thread": text(&newest, "thread"),
            "created_at": integer(&newest, "created_at").and_then(timestamp),
        });
        Ok(Some(WakeJob {
            endpoint: endpoint.to_owned(),
            address: address(&row),
            handle: text(&row, "handle").unwrap_or("").to_owned(),
            provider: hibernate.or(text(&row, "wake")).unwrap_or("").to_owned(),
            reference: if hibernate.is_some() {
                text(&row, "wake_ref")
            } else {
                text(&row, "harness_session")
            }
            .map(str::to_owned),
            session: text(&row, "harness_session")
                .filter(|_| hibernate.is_some())
                .map(str::to_owned),
            message,
            message_id,
            from,
            unread,
            ticket,
        }))
    }

    /// how a run ended, audited without the ref: a failure counts toward the backoff and shows `wake_failed`, a decline shows `wake_declined`
    /// and holds runs for that message and its sender, a success resets both. Whether the shown note changed
    pub async fn wake_result(
        &mut self,
        endpoint: &str,
        result: &WakeOutcome,
    ) -> Result<bool, RpcError> {
        let Some(row) = self.by_id(endpoint).await? else {
            return Ok(false);
        };
        let error = result.error.as_deref().map(|e| {
            let clean = strip_control(e);
            let spaced = clean.split_whitespace().collect::<Vec<_>>().join(" ");
            redact_secrets(&spaced)
                .chars()
                .take(200)
                .collect::<String>()
        });
        let declined = if result.ok {
            None
        } else {
            result
                .declined
                .as_deref()
                .and_then(|d| wake_decline_of(&json!(d)).map(str::to_owned))
        };
        let mut detail = json!({
            "target": address(&row), "provider": text(&row, "hibernate").or(text(&row, "wake")), "ok": result.ok,
        });
        if let Some(code) = result.code {
            detail["code"] = json!(code);
        }
        detail["ms"] = json!(result.ms.max(0));
        if let Some(declined) = &declined {
            detail["declined"] = json!(declined);
        } else if let Some(error) = error.as_deref().filter(|e| !e.is_empty()) {
            detail["error"] = json!(error);
        }
        self.audit("wake", Some(endpoint), None, detail).await?;
        let hibernated = text(&row, "hibernate").is_some();
        if !hibernated {
            let query = if result.ok {
                "UPDATE endpoints SET wake_ticket = NULL, wake_tried = NULL WHERE id = ?"
            } else {
                "UPDATE endpoints SET wake_ticket = NULL WHERE id = ?"
            };
            self.store.all(query, &[sv(endpoint)]).await?;
        }
        if !hibernated && !broker_wake(&row) {
            return Ok(false);
        }
        if let Some(declined) = declined {
            let from = match &result.message {
                Some(id) => self
                    .store
                    .all(
                        "SELECT from_ep FROM messages WHERE id = ?",
                        &[sv(id.as_str())],
                    )
                    .await?
                    .into_iter()
                    .next()
                    .and_then(|r| text(&r, "from_ep").map(str::to_owned)),
                None => None,
            };
            self.store.all("UPDATE endpoints SET wake_declined = ?, declined_message = ?, declined_from = ?, wake_note = NULL, wake_tried = NULL WHERE id = ?", &[sv(declined.as_str()), opt(result.message.as_deref()), opt(from.as_deref()), sv(endpoint)]).await?;
            return Ok(text(&row, "wake_declined") != Some(declined.as_str())
                || text(&row, "wake_note").is_some());
        }
        let note = (!result.ok).then(|| {
            let reason = error
                .clone()
                .filter(|e| !e.is_empty())
                .or_else(|| result.code.map(|c| format!("exit {c}")))
                .unwrap_or_else(|| "failed".into());
            format!(
                "wake_failed: {}",
                reason.chars().take(120).collect::<String>()
            )
        });
        let fails = if result.ok { "0" } else { "wake_fails + 1" };
        self.store.all(&format!("UPDATE endpoints SET wake_fails = {fails}, wake_note = ?, wake_declined = NULL, declined_message = NULL, declined_from = NULL WHERE id = ?"), &[opt(note.as_deref()), sv(endpoint)]).await?;
        Ok(note.as_deref() != text(&row, "wake_note") || text(&row, "wake_declined").is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> WakeJob {
        WakeJob {
            endpoint: "ep_1".into(),
            address: "me/lane".into(),
            handle: "lane".into(),
            provider: "vm".into(),
            reference: Some("box".into()),
            session: None,
            message: json!({"id": "msg_1", "from": "me/peer", "kind": "message", "thread": "thr_1"}),
            message_id: "msg_1".into(),
            from: Some("me/peer".into()),
            unread: 1,
            ticket: None,
        }
    }

    fn config(script: &str, timeout_s: u64) -> WakerConfig {
        WakerConfig {
            command: vec!["sh".into(), "-c".into(), script.into()],
            timeout_s,
        }
    }

    #[test]
    fn parses_wakers() {
        let parsed = parse_wakers(
            &json!({"vm": {"command": ["sh", "-c", "x"], "timeout_s": 2, "other": 1}}),
        )
        .unwrap();
        assert_eq!(parsed["vm"], config("x", 2));
        assert_eq!(
            parse_wakers(&json!({"vm": {"command": ["a"]}})).unwrap()["vm"].timeout_s,
            60
        );
        for bad in [
            json!([]),
            json!({"Bad Name": {"command": ["a"]}}),
            json!({"vm": {"command": []}}),
            json!({"vm": {"command": ["a", ""]}}),
            json!({"vm": {"command": ["a"], "timeout_s": 0}}),
            json!({"vm": {"command": ["a"], "timeout_s": 1.5}}),
            json!({"vm": {"command": ["a"], "timeout_s": 3601}}),
        ] {
            assert!(parse_wakers(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn declines_need_exit_77_and_a_reason() {
        assert_eq!(
            decline_of(Some(77), r#"{"declined":"budget"}"#).as_deref(),
            Some("budget")
        );
        assert_eq!(decline_of(Some(1), r#"{"declined":"budget"}"#), None);
        assert_eq!(decline_of(Some(77), r#"{"declined":"Bad"}"#), None);
        assert_eq!(decline_of(Some(77), "nope"), None);
    }

    #[test]
    fn child_env_drops_other_scp_variables() {
        let env = child_env("/relay", &job());
        assert!(
            env.iter().all(|(k, _)| !k.starts_with("SCP_")
                || k == "SCP_DIR"
                || k.starts_with("SCP_WAKE_"))
        );
        assert!(env.contains(&("SCP_WAKE_FROM".into(), "me/peer".into())));
        assert!(env.contains(&("SCP_DIR".into(), "/relay".into())));
    }

    #[tokio::test]
    async fn exec_feeds_stdin_and_reports_exits() {
        let ok = exec(&config("cat", 5), "hello\n".into(), vec![]).await;
        assert!(ok.ok);
        assert_eq!(ok.stdout, "hello\n");
        let failed = exec(
            &config("echo first >&2; echo last >&2; exit 3", 5),
            String::new(),
            vec![],
        )
        .await;
        assert_eq!((failed.ok, failed.code), (false, Some(3)));
        assert_eq!(failed.error.as_deref(), Some("exit 3: last"));
        let missing = exec(
            &WakerConfig {
                command: vec!["/nonexistent/waker".into()],
                timeout_s: 1,
            },
            String::new(),
            vec![],
        )
        .await;
        assert!(!missing.ok && missing.error.is_some());
    }

    #[tokio::test]
    async fn exec_kills_on_timeout_and_caps_output() {
        let started = std::time::Instant::now();
        let slow = exec(&config("sleep 5", 1), String::new(), vec![]).await;
        assert_eq!(slow.error.as_deref(), Some("timed out after 1 s"));
        assert!(started.elapsed() < Duration::from_secs(4));
        let loud = exec(
            &config("head -c 20000 /dev/zero | tr '\\0' a", 5),
            String::new(),
            vec![],
        )
        .await;
        assert_eq!(loud.stdout.len(), STDOUT_KEEP);
    }

    #[tokio::test]
    async fn exec_never_interprets_arguments() {
        let echo = exec(
            &WakerConfig {
                command: vec!["printf".into(), "%s".into(), "$HOME;`id`".into()],
                timeout_s: 5,
            },
            String::new(),
            vec![],
        )
        .await;
        assert_eq!(echo.stdout, "$HOME;`id`");
    }
}
