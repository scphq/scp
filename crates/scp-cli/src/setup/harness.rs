//! What setup knows about each harness: where it is installed, where it keeps its MCP servers, what a right mount looks like, how its
//! CLI is run and shown, and setup's list of what it added.

use super::files::{
    WriteOptions, exists, fs_error, read_json, read_rewritable_json, read_toml, write_file,
};
use crate::fleet::json::Json;
use crate::fleet::mounts::{entry_argv, native_mode};
use crate::spawn::argv::{Mount, executable, mount_with};
use scp_core::protocol::CLI_NAME;
use scp_mcp::identity::home_dir;
use scp_mcp::ps::{Env, basename, join};
use scp_mcp::render::js_space;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const SETUP_HARNESSES: [&str; 6] = ["claude", "codex", "opencode", "grok", "muse", "agy"];
pub const SERVER: &str = "scp";
pub const HOOKED: [&str; 5] = ["claude", "codex", "opencode", "agy", "muse"];
const VERIFY_TIMEOUT: Duration = Duration::from_secs(60);
/// keys of a remote server entry, dropped when a JSON entry becomes the local mount
pub const REMOTE_KEYS: [&str; 5] = ["url", "httpUrl", "serverUrl", "headers", "oauth"];

pub type Which<'a> = &'a dyn Fn(&str) -> Option<String>;

fn var<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    env.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

pub fn home(env: &Env) -> String {
    var(env, "HOME").map_or_else(home_dir, str::to_owned)
}

pub fn config_home(env: &Env) -> String {
    var(env, "XDG_CONFIG_HOME").map_or_else(|| join(&[&home(env), ".config"]), str::to_owned)
}

/// where a harness's binary is usually installed, under the home directory
fn known(harness: &str) -> &'static [&'static str] {
    match harness {
        "claude" => &[".local/bin/claude", ".claude/local/claude"],
        "codex" => &[".local/bin/codex"],
        "opencode" => &[".opencode/bin/opencode", ".local/bin/opencode"],
        "grok" => &[".grok/bin/grok", ".local/bin/grok"],
        "muse" => &[".local/bin/muse"],
        _ => &[".local/bin/agy"],
    }
}

/// the installed harnesses and the binary each one runs
pub fn detect_harnesses(env: &Env, which: Which) -> HashMap<&'static str, String> {
    SETUP_HARNESSES
        .iter()
        .filter_map(|harness| {
            let path = which(harness).or_else(|| {
                known(harness)
                    .iter()
                    .map(|rel| join(&[&home(env), rel]))
                    .find(|path| executable(path))
            })?;
            Some((*harness, path))
        })
        .collect()
}

/// where T3 Code is: t3 on PATH or $SCP_T3_BIN, else the desktop app, else its data directory
pub fn detect_t3(env: &Env, which: Which) -> Option<String> {
    which("t3")
        .or_else(|| {
            var(env, "SCP_T3_BIN")
                .filter(|bin| executable(bin))
                .map(str::to_owned)
        })
        .or_else(|| {
            [
                "/Applications/T3 Code.app".to_owned(),
                join(&[&home(env), "Applications", "T3 Code.app"]),
                var(env, "T3CODE_HOME").map_or_else(|| join(&[&home(env), ".t3"]), str::to_owned),
            ]
            .into_iter()
            .find(|path| exists(path))
        })
}

pub fn agy_settings_file(env: &Env) -> String {
    join(&[&home(env), ".gemini", "antigravity-cli", "settings.json"])
}

/// what setup added, so --undo removes only that
pub fn manifest_file(env: &Env) -> String {
    join(&[&config_home(env), "scp", "setup.json"])
}

pub fn muse_installed_file(env: &Env) -> String {
    let data = var(env, "XDG_DATA_HOME")
        .map_or_else(|| join(&[&home(env), ".local", "share"]), str::to_owned);
    join(&[&data, "muse", "plugins", "installed.json"])
}

pub fn is_object(value: &Json) -> bool {
    matches!(value, Json::Obj(_))
}

/// the scp entry a harness has now
pub fn mounted_entry(harness: &str, file: &str) -> Result<Option<Json>, String> {
    let toml = harness == "codex" || harness == "grok";
    let config = if toml {
        read_toml(file)?
    } else {
        read_json(file)?
    };
    let key = match harness {
        "codex" | "grok" => "mcp_servers",
        "opencode" => "mcp",
        _ => "mcpServers",
    };
    let entry = config
        .as_ref()
        .and_then(|config| config.get(key))
        .filter(|table| is_object(table))
        .and_then(|table| table.get(SERVER));
    Ok(entry.filter(|entry| is_object(entry)).cloned())
}

pub fn entry_enabled(harness: &str, entry: &Json) -> bool {
    if harness == "agy" {
        return entry.get("disabled") != Some(&Json::Bool(true));
    }
    entry.get("enabled") != Some(&Json::Bool(false))
}

/// the type a local mount has in harnesses whose entries carry one
pub fn local_type(harness: &str) -> Option<&'static str> {
    match harness {
        "claude" | "muse" => Some("stdio"),
        "opencode" => Some("local"),
        _ => None,
    }
}

/// the key of an entry's environment
pub fn env_key(harness: &str) -> &'static str {
    if harness == "opencode" {
        "environment"
    } else {
        "env"
    }
}

/// an entry's string variables
pub fn entry_vars(harness: &str, entry: Option<&Json>) -> Json {
    let vars = entry.and_then(|entry| entry.get(env_key(harness)));
    Json::Obj(
        vars.filter(|vars| is_object(vars))
            .map(|vars| {
                vars.entries()
                    .into_iter()
                    .filter(|(_, value)| matches!(value, Json::Str(_)))
                    .map(|(key, value)| (key.to_owned(), value.clone()))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// whether an entry's variables are the ones a native mount sets: setup wrote it under SCP_NATIVE=1 or mcp
pub fn native_vars(vars: &Json) -> bool {
    native_mode(vars.get("SCP_NATIVE").and_then(Json::as_str)) != "off"
        && vars.get("SCP_CLI_ARGV").is_some()
}

/// whether `entry` is the local mount `mount`, enabled
pub fn entry_right(harness: &str, entry: &Json, mount: &Mount) -> bool {
    let local = !["url", "httpUrl", "serverUrl"]
        .iter()
        .any(|key| entry.get(key).is_some())
        && match (entry.get("type"), local_type(harness)) {
            (None, _) | (_, None) => true,
            (Some(have), Some(want)) => have.as_str() == Some(want),
        };
    let vars = entry_vars(harness, Some(entry));
    local
        && entry_enabled(harness, entry)
        && entry_argv(harness, entry) == mount.argv
        && mount
            .env
            .iter()
            .all(|(key, value)| vars.get(key).and_then(Json::as_str) == Some(value))
}

/// `entry` without the keys of a remote server
pub fn without_remote(entry: &Json) -> Json {
    Json::Obj(
        entry
            .entries()
            .into_iter()
            .filter(|(key, _)| !REMOTE_KEYS.contains(key))
            .map(|(key, value)| (key.to_owned(), value.clone()))
            .collect(),
    )
}

/// a harness's mount: the native `swarm mcp` when `native` names it, told that `launch` starts this CLI; else `launch` with `mcp`
pub fn setup_mount(harness: &str, launch: &[String], native: Option<&str>, env: &Env) -> Mount {
    let mut words = vec!["--harness".to_owned(), harness.to_owned()];
    if harness == "claude" {
        words.push("--channels".into());
    }
    mount_with(native, launch, &words, env)
}

/// the name and description of every relay tool, in the order they are listed
pub fn tools() -> Vec<(String, String)> {
    let list = Json::parse(scp_mcp::tools::tools_json(true).as_bytes()).unwrap_or(Json::Null);
    list.items()
        .iter()
        .map(|tool| {
            let field = |key: &str| {
                tool.get(key)
                    .and_then(Json::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            (field("name"), field("description"))
        })
        .collect()
}

pub fn agy_rules() -> Vec<String> {
    tools()
        .iter()
        .map(|(name, _)| format!("mcp({SERVER}/{name})"))
        .collect()
}

/// a word as the plan prints it: `/^[A-Za-z0-9._/=@:<>-]+$/` plain, else quoted
pub fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/=@:<>-".contains(c));
    if plain {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

pub fn shell_words(words: &[String]) -> String {
    words
        .iter()
        .map(|w| shell_word(w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `text` with the home directory as `~`
pub fn tilde(text: &str, env: &Env) -> String {
    let home = home(env);
    let prefix = home.trim_end_matches('/');
    if prefix.chars().count() > 1 {
        text.replace(&format!("{prefix}/"), "~/")
    } else {
        text.to_owned()
    }
}

const SECRET_KEYS: [&str; 4] = ["env", "environment", "headers", "http_headers"];

/// `value` with the values of its env and header maps hidden, for printing
pub fn redacted(value: &Json) -> Json {
    match value {
        Json::Arr(items) => Json::Arr(items.iter().map(redacted).collect()),
        Json::Obj(_) => Json::Obj(
            value
                .entries()
                .into_iter()
                .map(|(key, inner)| {
                    let hidden = if SECRET_KEYS.contains(&key) && is_object(inner) {
                        Json::Obj(
                            inner
                                .entries()
                                .into_iter()
                                .map(|(name, _)| (name.to_owned(), Json::str("<kept>")))
                                .collect(),
                        )
                    } else {
                        redacted(inner)
                    };
                    (key.to_owned(), hidden)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// a harness command as the plan prints it: --env values and add-json's env hidden
pub fn shown(argv: &[String]) -> String {
    let all: Vec<String> = argv
        .iter()
        .enumerate()
        .map(|(at, word)| {
            if at == 0 {
                basename(word).to_owned()
            } else {
                word.clone()
            }
        })
        .collect();
    let words: Vec<String> = all
        .iter()
        .enumerate()
        .map(|(at, word)| {
            if at > 0 && all[at - 1] == "--env" {
                let name = word.split('=').next().unwrap_or_default();
                format!("{name}=<kept>")
            } else if all.get(2).map(String::as_str) == Some("add-json") && at + 1 == all.len() {
                Json::parse(word.as_bytes())
                    .map_or_else(|| word.clone(), |j| redacted(&j).compact())
            } else {
                word.clone()
            }
        })
        .collect();
    format!("$ {}", shell_words(&words))
}

/// a finished harness command: its exit code, and what it printed to both streams
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub code: i32,
    pub output: String,
}

fn spawn_failed(error: &std::io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(libc::EACCES) => "EACCES",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::ENOEXEC) => "ENOEXEC",
        _ => "ENOENT",
    }
}

fn drain(mut stream: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stream.read_to_end(&mut bytes);
        let _ = send.send(bytes);
    });
    receive
}

/// `spawnSync` with piped output and a time limit: the exit code, 124 after the limit, 127 when it did not start or a signal ended it
pub fn run_command(argv: &[String], env: &Env, cwd: Option<&str>) -> RunResult {
    let Some((program, rest)) = argv.split_first() else {
        return RunResult {
            code: 127,
            output: String::new(),
        };
    };
    let mut command = Command::new(program);
    command
        .args(rest)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return RunResult {
                code: 127,
                output: format!("spawnSync {program} {}", spawn_failed(&error)),
            };
        }
    };
    let streams = [
        child.stdout.take().map(drain),
        child.stderr.take().map(drain),
    ];
    let deadline = Instant::now() + VERIFY_TIMEOUT;
    let mut parts: [Option<Vec<u8>>; 2] = [None, None];
    let mut status = None;
    let mut timed_out = false;
    loop {
        for (part, stream) in parts.iter_mut().zip(&streams) {
            if part.is_none() {
                match stream.as_ref().map(mpsc::Receiver::try_recv) {
                    Some(Ok(bytes)) => *part = Some(bytes),
                    Some(Err(mpsc::TryRecvError::Empty)) => {}
                    _ => *part = Some(Vec::new()),
                }
            }
        }
        if status.is_none() {
            status = child.try_wait().ok().flatten();
        }
        if status.is_some() && parts.iter().all(Option::is_some) {
            break;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            // SAFETY: signals only the child this call started, which is not reaped until wait below
            if status.is_none() {
                unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
                status = child.wait().ok();
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let [out, err] = parts.map(Option::unwrap_or_default);
    let mut output = String::from_utf8_lossy(&out).into_owned();
    output.push_str(&String::from_utf8_lossy(&err));
    if timed_out {
        output.push_str(&format!("spawnSync {program} ETIMEDOUT"));
    }
    let code = status.and_then(|status| status.code());
    RunResult {
        code: code.unwrap_or(if timed_out { 124 } else { 127 }),
        output,
    }
}

/// `text` without terminal colours: `\x1b\[[0-9;]*[A-Za-z]`, then `\[[0-9;]*m`
pub fn strip_ansi(text: &str) -> String {
    let escapes = strip(text, "\u{1b}[", char::is_ascii_alphabetic);
    strip(&escapes, "[", |c| *c == 'm')
}

fn strip(text: &str, start: &str, last: fn(&char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(start) {
        out.push_str(&rest[..at]);
        let after = &rest[at + start.len()..];
        let params = after
            .find(|c: char| !(c.is_ascii_digit() || c == ';'))
            .unwrap_or(after.len());
        match after[params..].chars().next().filter(last) {
            Some(end) => rest = &after[params + end.len_utf8()..],
            None => {
                out.push_str(&rest[at..at + start.len()]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn last_line(text: &str) -> String {
    let plain = strip_ansi(text);
    plain
        .trim_matches(js_space)
        .split('\n')
        .rfind(|line| !line.is_empty())
        .unwrap_or("no output")
        .to_owned()
}

/// one change to the list of what setup added
pub type Change = Rc<dyn Fn(Vec<Json>) -> Vec<Json>>;

/// one thing setup added, with the fields it records
pub fn added_item(harness: &str, kind: &str, file: &str) -> Json {
    Json::object(vec![
        ("harness", Json::str(harness)),
        ("kind", Json::str(kind)),
        ("file", Json::str(file)),
    ])
}

fn item_field<'a>(item: &'a Json, key: &str) -> Option<&'a str> {
    item.get(key).and_then(Json::as_str)
}

pub fn item_kind(item: &Json) -> &str {
    item_field(item, "kind").unwrap_or_default()
}

pub fn item_harness(item: &Json) -> &str {
    item_field(item, "harness").unwrap_or_default()
}

pub fn item_file(item: &Json) -> &str {
    item_field(item, "file").unwrap_or_default()
}

/// the list in setup.json: items as they are, those without a harness, kind and file left out
pub fn read_manifest(env: &Env) -> Result<Vec<Json>, String> {
    let Some(config) = read_rewritable_json(&manifest_file(env))? else {
        return Ok(Vec::new());
    };
    let Some(Json::Arr(added)) = config.get("added") else {
        return Err("its added key is not a list".into());
    };
    Ok(added
        .iter()
        .filter(|item| {
            is_object(item)
                && ["harness", "kind", "file"]
                    .iter()
                    .all(|key| item_field(item, key).is_some())
        })
        .cloned()
        .collect())
}

pub fn same_item(a: &Json, b: &Json) -> bool {
    item_harness(a) == item_harness(b)
        && item_kind(a) == item_kind(b)
        && item_file(a) == item_file(b)
}

pub fn write_manifest(env: &Env, now_s: i64, change: &Change) -> Result<(), String> {
    let file = manifest_file(env);
    let next = change(read_manifest(env)?);
    if !next.is_empty() {
        let list = Json::object(vec![
            ("version", Json::Num(1.0)),
            ("added", Json::Arr(next)),
        ]);
        let options = WriteOptions {
            keep: false,
            ..WriteOptions::default()
        };
        write_file(&file, &format!("{}\n", list.pretty()), now_s, options)?;
    } else if exists(&file) {
        std::fs::remove_file(&file).map_err(fs_error("unlink", &file))?;
    }
    Ok(())
}

/// records `item`, adding its rules to those of an item already there
pub fn remember(item: Json) -> Change {
    Rc::new(move |mut added| {
        let Some(existing) = added.iter_mut().find(|other| same_item(other, &item)) else {
            added.push(item.clone());
            return added;
        };
        if let Some(rules) = item.get("rules") {
            let mut union: Vec<Json> = Vec::new();
            let had = existing.get("rules").map_or(&[][..], Json::items);
            for rule in had.iter().chain(rules.items()) {
                if !union.contains(rule) {
                    union.push(rule.clone());
                }
            }
            existing.set("rules", Json::Arr(union));
        }
        added
    })
}

pub fn forget(item: Json) -> Change {
    Rc::new(move |added| {
        added
            .into_iter()
            .filter(|other| !same_item(other, &item))
            .collect()
    })
}

/// the version `claude --version` prints, where the hooks read it
pub fn claude_version_file(env: &Env) -> String {
    join(&[&config_home(env), "scp", "claude-version"])
}

/// the first `\d+\.\d+\.\d+` in `text`
pub fn dotted_version(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    (0..bytes.len()).find_map(|start| {
        let major = digits(start);
        if major == 0 || bytes.get(start + major) != Some(&b'.') {
            return None;
        }
        let minor_at = start + major + 1;
        let minor = digits(minor_at);
        if minor == 0 || bytes.get(minor_at + minor) != Some(&b'.') {
            return None;
        }
        let patch_at = minor_at + minor + 1;
        let patch = digits(patch_at);
        (patch > 0).then(|| &text[start..patch_at + patch])
    })
}

/// the usage line for a CLI that is nowhere to be found
pub fn not_on_path() -> String {
    format!("{CLI_NAME} is not on PATH: pass --bin /absolute/path/to/{CLI_NAME}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_come_off_and_other_brackets_stay() {
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m [1m[x] [12"), "ok [x] [12");
        assert_eq!(strip_ansi("\u{1b}[2Kline"), "line");
        assert_eq!(last_line("a\n\n\u{1b}[31mb\u{1b}[0m\n"), "b");
        assert_eq!(last_line(" \n"), "no output");
    }

    #[test]
    fn the_shown_command_hides_what_the_entry_keeps_secret() {
        let words = |list: &[&str]| list.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        assert_eq!(
            shown(&words(&[
                "/x/codex", "mcp", "add", "--env", "A=1=2", "scp", "--", "a b"
            ])),
            "$ codex mcp add --env A=<kept> scp -- 'a b'"
        );
        assert_eq!(
            shown(&words(&[
                "/x/claude",
                "mcp",
                "add-json",
                "scp",
                r#"{"env":{"A":"1"},"b":[{"headers":{"H":"x"}}]}"#
            ])),
            r#"$ claude mcp add-json scp '{"env":{"A":"<kept>"},"b":[{"headers":{"H":"<kept>"}}]}'"#
        );
    }

    #[test]
    fn a_version_is_three_dotted_numbers() {
        assert_eq!(dotted_version("2.1.3 (Claude Code)"), Some("2.1.3"));
        assert_eq!(dotted_version("v1.2 and 3.4.5.6"), Some("3.4.5"));
        assert_eq!(dotted_version("1.2."), None);
        assert_eq!(dotted_version(""), None);
    }

    #[test]
    fn a_command_that_cannot_start_exits_127_and_names_the_failure() {
        let result = run_command(&["/no/such/bin".to_owned()], &Env::new(), None);
        assert_eq!(result.code, 127);
        assert_eq!(result.output, "spawnSync /no/such/bin ENOENT");
    }
}
