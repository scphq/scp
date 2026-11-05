//! Starting the broker daemon and detached `swarm spawn` runners.

use crate::identity::{codex_shell, harness_variant, private_dir, read_shim_binding};
use crate::ps::{
    Env, SHELL_PS_TIMEOUT_MS, Table, basename, harness_at, harness_lineage, join, lineage,
    read_ps_table,
};
use crate::server::{SpawnRequest, Spawned};
use scp_core::protocol::CLI_NAME;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::rc::Rc;
use std::sync::OnceLock;
use tokio::io::AsyncReadExt;

/// the environment variable a detached runner reads its caller's walk from
pub const SPAWN_RUNNER: &str = "SCP_SPAWN_RUNNER";
/// this CLI as a command line, as a JSON array of words
pub const CLI_ARGV: &str = "SCP_CLI_ARGV";

const DAEMON_ENV: [&str; 23] = [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "SCP_IDLE",
    "HOME",
    "XDG_CONFIG_HOME",
    "SCP_TOKEN",
    "SCP_RELAY",
    "SCP_MACHINE",
    "SCP_RUNNERS_FILE",
    "CODEX_HOME",
    "SCP_CODEX_BIN",
    "SCP_OPEN_BIN",
    "SCP_LSOF_BIN",
    "SCP_FUSER_BIN",
    "SCP_NATIVE",
    "SCP_SWARM_BIN",
    "SCP_CLAUDE_BG_EVERY_S",
];
const LOG_MAX_BYTES: u64 = 1024 * 1024;

static NATIVE_DAEMON: OnceLock<PathBuf> = OnceLock::new();

/// names the native `swarm` this server runs in, which then starts the broker itself (`<exe> daemon`) under `SCP_NATIVE=1`
pub fn set_native_daemon(exe: PathBuf) {
    let _ = NATIVE_DAEMON.set(exe);
}

/// the native `swarm` that starts the broker for `env`: `exe` under `SCP_NATIVE=1`; under `SCP_NATIVE=mcp`, as without it, the launcher starts the TypeScript broker
fn native_daemon<'a>(env: &Env, exe: Option<&'a Path>) -> Option<&'a Path> {
    exe.filter(|_| env.get("SCP_NATIVE").is_some_and(|v| v == "1"))
}

/// the broker command: `native daemon` when there is one, else the launcher's `daemon`; under `SCP_NATIVE=mcp` only a launcher
/// `SCP_CLI_ARGV` names, since a bare `swarm` on PATH may be a native one
fn daemon_argv(env: &Env, native: Option<&Path>) -> io::Result<Vec<String>> {
    match native {
        Some(exe) => Ok(vec![exe.to_string_lossy().into_owned(), "daemon".into()]),
        None => {
            let mut argv = if env.get("SCP_NATIVE").is_some_and(|v| v == "mcp") {
                named_launcher(env).ok_or_else(|| {
                    io::Error::other(
                        "SCP_NATIVE=mcp starts the TypeScript broker through SCP_CLI_ARGV, which is unset or unusable; rerun swarm setup --write",
                    )
                })?
            } else {
                launcher(env)
            };
            argv.push("daemon".into());
            Ok(argv)
        }
    }
}

/// `$SCP_CLI_ARGV` when it names a program
pub fn named_launcher(env: &Env) -> Option<Vec<String>> {
    env.get(CLI_ARGV)
        .and_then(|text| serde_json::from_str::<Vec<String>>(text).ok())
        .filter(|words| !words.is_empty() && !words[0].is_empty())
}

/// the CLI that starts the broker and runners: `$SCP_CLI_ARGV`, else `swarm` on PATH
pub fn launcher(env: &Env) -> Vec<String> {
    named_launcher(env).unwrap_or_else(|| vec![CLI_NAME.to_string()])
}

fn detached(command: &mut tokio::process::Command, handshake: Option<i32>) {
    unsafe {
        command.pre_exec(move || {
            if let Some(fd) = handshake {
                if fd == 3 {
                    let flags = libc::fcntl(3, libc::F_GETFD);
                    if flags < 0 || libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                } else if libc::dup2(fd, 3) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// the broker for `dir`, detached, with a fixed environment and its output in broker.log
pub fn start_daemon(dir: &str, env: &Env) -> io::Result<()> {
    private_dir(dir)?;
    let log_file = join(&[dir, "broker.log"]);
    if fs::metadata(&log_file).map(|m| m.len()).unwrap_or(0) > LOG_MAX_BYTES {
        fs::OpenOptions::new()
            .write(true)
            .open(&log_file)?
            .set_len(0)?;
    }
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log_file)?;
    let native = native_daemon(env, NATIVE_DAEMON.get().map(PathBuf::as_path));
    let argv = daemon_argv(env, native)?;
    let mut command = tokio::process::Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .env_clear()
        .env("SCP_DIR", dir)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    for key in DAEMON_ENV {
        if let Some(value) = env.get(key) {
            command.env(key, value);
        }
    }
    if native.is_some()
        && let Some(words) = env.get(CLI_ARGV)
    {
        command.env(CLI_ARGV, words);
    }
    detached(&mut command, None);
    command.spawn().map(drop)
}

/// relay_spawn's request as `swarm spawn --bg` words, acting as the shim's own agent
pub fn spawn_words(request: &SpawnRequest) -> Vec<String> {
    let mut words: Vec<String> = vec!["--bg".into(), "--as".into(), request.as_.clone()];
    let mut valued = |flag: &str, value: &Option<String>| {
        if let Some(value) = value {
            words.push(flag.into());
            words.push(value.clone());
        }
    };
    valued("--harness", &request.harness);
    valued("--name", &request.name);
    valued("--title", &request.title);
    if request.no_push {
        words.push("--no-push".into());
    }
    if let Some(bytes) = request.handback_bytes {
        words.push("--handback-bytes".into());
        words.push(bytes.to_string());
    }
    words.push("--".into());
    words.extend(request.command.iter().cloned());
    words
}

const ENV_VALUED: [&str; 6] = ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"];
const TIMEOUT_VALUED: [&str; 4] = ["-s", "--signal", "-k", "--kill-after"];
const NICE_VALUED: [&str; 2] = ["-n", "--adjustment"];
const MUSE_MODE: &str = "--contributor-mode";
const MUSE_CONFIG: [&str; 2] = ["-c", "--config"];
const MUSE_MODES_ALLOWED: [&str; 2] = ["off", "on"];

/// `^[A-Za-z_][A-Za-z0-9_]*=`
fn assignment(word: &str) -> bool {
    let Some(eq) = word.find('=') else {
        return false;
    };
    let name = &word.as_bytes()[..eq];
    !name.is_empty()
        && (name[0].is_ascii_alphabetic() || name[0] == b'_')
        && name.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// where the program of a command starts, past `VAR=value` words and the wrappers env, timeout, nohup and nice
pub fn program_at(command: &[String]) -> usize {
    let mut i = 0;
    let skip_flags = |i: &mut usize, valued: &[&str]| {
        while *i < command.len() && command[*i].starts_with('-') && command[*i] != "--" {
            *i += if valued.contains(&command[*i].as_str()) {
                2
            } else {
                1
            };
        }
        if command.get(*i).is_some_and(|w| w == "--") {
            *i += 1;
        }
    };
    while i < command.len() {
        let word = &command[i];
        let name = basename(word);
        if assignment(word) {
            i += 1;
        } else if name == "env" {
            i += 1;
            skip_flags(&mut i, &ENV_VALUED);
        } else if name == "nohup" {
            i += 1;
        } else if name == "nice" {
            i += 1;
            skip_flags(&mut i, &NICE_VALUED);
        } else if name == "timeout" {
            i += 1;
            skip_flags(&mut i, &TIMEOUT_VALUED);
            i += 1;
        } else {
            break;
        }
    }
    i
}

/// `JSON.parse(value)` as a contributor mode: false is off, true is on, a string itself, anything else the raw text
fn config_mode(value: &str) -> String {
    match serde_json::from_str::<Value>(value) {
        Ok(Value::Bool(false)) => "off".into(),
        Ok(Value::Bool(true)) => "on".into(),
        Ok(Value::String(text)) => text,
        _ => value.into(),
    }
}

pub fn muse_modes(args: &[String]) -> Vec<Option<String>> {
    let end = args.iter().position(|w| w == "--").unwrap_or(args.len());
    let words = &args[..end];
    let mut modes = Vec::new();
    for (i, word) in words.iter().enumerate() {
        if word == MUSE_MODE {
            modes.push(words.get(i + 1).cloned());
        } else if let Some(mode) = word.strip_prefix(&format!("{MUSE_MODE}=")) {
            modes.push(Some(mode.into()));
        }
        let eq = word.find('=').filter(|eq| *eq > 0);
        let setting = if MUSE_CONFIG.contains(&word.as_str()) {
            words.get(i + 1).map(String::as_str)
        } else {
            eq.filter(|eq| MUSE_CONFIG.contains(&&word[..*eq]))
                .map(|eq| &word[eq + 1..])
        };
        if let Some(setting) = setting
            && let Some(split) = setting.find('=').filter(|s| *s > 0)
            && setting[..split].to_lowercase().contains("contributor")
        {
            modes.push(Some(config_mode(&setting[split + 1..])));
        }
    }
    modes
}

/// why `command` cannot run: a muse that sets its contributor mode to one not allowed; None for every other command
pub fn contributor_refusal(command: &[String]) -> Option<String> {
    let at = program_at(command);
    if command.get(at).is_none_or(|w| basename(w) != "muse") {
        return None;
    }
    for mode in muse_modes(&command[at + 1..]) {
        match mode {
            Some(mode) if MUSE_MODES_ALLOWED.contains(&mode.as_str()) => {}
            Some(mode) => {
                return Some(format!(
                    "{CLI_NAME} spawn: muse runs with {MUSE_MODE} off or on, not {}",
                    serde_json::to_string(&mode).unwrap_or_default()
                ));
            }
            None => {
                return Some(format!(
                    "{CLI_NAME} spawn: muse runs with {MUSE_MODE} off or on, not a bare flag"
                ));
            }
        }
    }
    None
}

/// the flag checks a detached spawn makes before it starts a runner: an option value that reads as an option, and a refused command
fn check_spawn(words: &[String]) -> Result<(), String> {
    let end = words.iter().position(|w| w == "--").unwrap_or(words.len());
    let mut i = 0;
    while i < end {
        let flag = &words[i];
        if matches!(
            flag.as_str(),
            "--as" | "--harness" | "--name" | "--title" | "--handback-bytes"
        ) {
            let value = words.get(i + 1).map(String::as_str).unwrap_or("");
            if value.encode_utf16().count() > 1 && value.starts_with('-') {
                return Err(format!(
                    "Option '{flag}' argument is ambiguous.\nDid you forget to specify the option argument for '{flag}'?\nTo specify an option argument starting with a dash use '{flag}=-XYZ'."
                ));
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    let command = words.get(end + 1..).unwrap_or(&[]);
    match contributor_refusal(command) {
        Some(refusal) => Err(refusal),
        None => Ok(()),
    }
}

/// the caller's process walk as a runner takes it: its lineage, its harness lineage and that harness
pub fn walk_now(env: &Env, pid: i64, table: Table) -> Value {
    let t = table.as_deref();
    let keys = t.map(|t| lineage(pid, t)).unwrap_or_default();
    let own = harness_lineage(pid, t);
    if own.is_empty()
        && codex_shell(env)
        && let Some(binding) = read_shim_binding(env, pid, t)
    {
        let mut bound = keys;
        bound.push(binding.process);
        return json!({ "keys": bound, "self": bound, "harness": binding.harness });
    }
    let harness_pid = own
        .last()
        .and_then(|key| key.strip_prefix("pid:"))
        .and_then(|rest| {
            let digits = rest
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(rest.len());
            rest[..digits].parse::<i64>().ok()
        });
    let provider = match (own.is_empty(), harness_pid) {
        (false, Some(at)) => harness_at(at, t, env),
        _ => None,
    };
    let mut walk = json!({ "keys": keys, "self": own });
    if let (Some(provider), Some(at)) = (provider, harness_pid) {
        let shared = table.clone();
        let harness = harness_variant(provider, env, at, &move || shared.clone(), None);
        walk["harness"] = Value::String(harness);
    }
    if table.is_none() {
        walk["unread"] = Value::Bool(true);
    }
    walk
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    for fd in fds {
        if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok((read, write))
}

/// the first line the runner writes on its handshake fd, or what it wrote before it closed it; empty when it could not start
pub async fn handshake(
    launch: &[String],
    args: &[String],
    cwd: &Path,
    env: &Env,
    walk: &Value,
) -> String {
    let mut command = tokio::process::Command::new(&launch[0]);
    command
        .args(&launch[1..])
        .arg("spawn")
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .env(SPAWN_RUNNER, walk.to_string());
    handshake_line(command).await
}

/// `command` started detached in its own session, stdio null and a pipe on fd 3: the first line it writes there, or what it wrote before
/// it closed it; empty when it could not start
pub async fn handshake_line(mut command: tokio::process::Command) -> String {
    use std::os::fd::AsRawFd;
    let Ok((read, write)) = pipe() else {
        return String::new();
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detached(&mut command, Some(write.as_raw_fd()));
    let child = command.spawn();
    drop(write);
    let Ok(child) = child else {
        return String::new();
    };
    drop(child);
    let Ok(mut channel) = tokio::net::unix::pipe::Receiver::from_owned_fd(read) else {
        return String::new();
    };
    let mut text = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match channel.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                text.extend_from_slice(&chunk[..n]);
                if let Some(end) = text.iter().position(|c| *c == b'\n') {
                    text.truncate(end);
                    break;
                }
            }
        }
    }
    String::from_utf8_lossy(&text).into_owned()
}

/// start a detached worker, returning its name and runner pid once its harness started
pub async fn spawn_detached(
    args: Vec<String>,
    cwd: &Path,
    env: &Env,
    parent: i64,
) -> Result<Spawned, String> {
    check_spawn(&args)?;
    let walk = walk_now(env, parent, read_ps_table(SHELL_PS_TIMEOUT_MS).map(Rc::new));
    let line = handshake(&launcher(env), &args, cwd, env, &walk).await;
    let ended =
        || format!("{CLI_NAME} spawn: the detached runner ended before the harness started");
    let reply: Value = serde_json::from_str(&line).map_err(|_| ended())?;
    let reply = reply.as_object().ok_or_else(ended)?;
    if let Some(error) = reply.get("error") {
        return Err(match error {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        });
    }
    let name = reply
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(ended)?;
    let pid = reply
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|p| u32::try_from(p).ok())
        .ok_or_else(ended)?;
    Ok(Spawned {
        name: name.into(),
        pid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(text: &[&str]) -> Vec<String> {
        text.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn spawn_words_follow_the_flags() {
        let request = SpawnRequest {
            command: words(&["codex", "exec", "hi"]),
            as_: "me/a".into(),
            harness: Some("codex".into()),
            name: Some("w".into()),
            title: None,
            no_push: true,
            handback_bytes: Some(100),
            cwd: None,
        };
        assert_eq!(
            spawn_words(&request),
            words(&[
                "--bg",
                "--as",
                "me/a",
                "--harness",
                "codex",
                "--name",
                "w",
                "--no-push",
                "--handback-bytes",
                "100",
                "--",
                "codex",
                "exec",
                "hi"
            ])
        );
    }

    #[test]
    fn refusals() {
        assert_eq!(contributor_refusal(&words(&["codex", "exec"])), None);
        assert_eq!(
            contributor_refusal(&words(&["env", "A=1", "muse", "--contributor-mode", "on"])),
            None
        );
        assert_eq!(
            contributor_refusal(&words(&["muse", "--contributor-mode", "full"])).as_deref(),
            Some("swarm spawn: muse runs with --contributor-mode off or on, not \"full\"")
        );
        assert_eq!(
            contributor_refusal(&words(&["timeout", "5", "muse", "--contributor-mode"])).as_deref(),
            Some("swarm spawn: muse runs with --contributor-mode off or on, not a bare flag")
        );
        assert_eq!(
            contributor_refusal(&words(&["muse", "-c", "contributor_mode=false"])),
            None
        );
        assert!(contributor_refusal(&words(&["muse", "--config=x.contributor=\"x\""])).is_some());
        assert_eq!(
            check_spawn(&words(&["--bg", "--title", "-x", "--", "a"])),
            Err("Option '--title' argument is ambiguous.\nDid you forget to specify the option argument for '--title'?\nTo specify an option argument starting with a dash use '--title=-XYZ'.".into())
        );
        assert_eq!(
            check_spawn(&words(&["--bg", "--title", "-", "--", "a"])),
            Ok(())
        );
    }

    #[test]
    fn launcher_words() {
        let mut env = Env::new();
        assert_eq!(launcher(&env), vec!["swarm"]);
        env.insert(CLI_ARGV.into(), r#"["/bin/bun","/x/cli.js"]"#.into());
        assert_eq!(launcher(&env), vec!["/bin/bun", "/x/cli.js"]);
        env.insert(CLI_ARGV.into(), "[]".into());
        assert_eq!(launcher(&env), vec!["swarm"]);
    }

    #[test]
    fn the_broker_is_native_only_under_scp_native() {
        let exe = Path::new("/opt/native/swarm");
        let mut env = Env::new();
        env.insert(CLI_ARGV.into(), r#"["/bin/node","/x/cli.js"]"#.into());
        assert_eq!(native_daemon(&env, Some(exe)), None);
        assert_eq!(
            daemon_argv(&env, None).unwrap(),
            vec!["/bin/node", "/x/cli.js", "daemon"]
        );
        env.insert("SCP_NATIVE".into(), "1".into());
        assert_eq!(native_daemon(&env, None), None);
        assert_eq!(native_daemon(&env, Some(exe)), Some(exe));
        assert_eq!(
            daemon_argv(&env, Some(exe)).unwrap(),
            vec!["/opt/native/swarm", "daemon"]
        );
        env.insert("SCP_NATIVE".into(), "0".into());
        assert_eq!(native_daemon(&env, Some(exe)), None);
    }

    #[test]
    fn scp_native_mcp_starts_the_typescript_broker_through_the_launcher() {
        let exe = Path::new("/opt/native/swarm");
        let mut env = Env::new();
        env.insert(CLI_ARGV.into(), r#"["/bin/node","/x/cli.js"]"#.into());
        env.insert("SCP_NATIVE".into(), "mcp".into());
        let native = native_daemon(&env, Some(exe));
        assert_eq!(native, None);
        assert_eq!(
            daemon_argv(&env, native).unwrap(),
            vec!["/bin/node", "/x/cli.js", "daemon"]
        );
        for bad in [None, Some("[]"), Some("swarm")] {
            match bad {
                None => env.remove(CLI_ARGV),
                Some(text) => env.insert(CLI_ARGV.into(), text.into()),
            };
            assert!(daemon_argv(&env, native).is_err(), "{bad:?}");
        }
        env.remove("SCP_NATIVE");
        assert_eq!(daemon_argv(&env, None).unwrap(), vec!["swarm", "daemon"]);
    }

    #[test]
    fn a_started_broker_keeps_the_native_mode_and_only_allowed_variables() {
        let dir = std::env::temp_dir().join(format!("scp-mcp-daemon-{}", std::process::id()));
        let relay = dir.join("relay");
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("cli.sh");
        let seen = dir.join("seen");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\n{{ echo \"$*\"; env | sort; }} > '{}.tmp' && mv '{}.tmp' '{}'\n",
                seen.display(),
                seen.display(),
                seen.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let mut env = Env::new();
        env.insert(
            CLI_ARGV.into(),
            serde_json::to_string(&[script.to_str().unwrap()]).unwrap(),
        );
        env.insert("SCP_NATIVE".into(), "mcp".into());
        env.insert("SCP_SWARM_BIN".into(), "/opt/native/swarm".into());
        env.insert("SCP_GRANT".into(), "krt_secret".into());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime
            .block_on(async { start_daemon(relay.to_str().unwrap(), &env) })
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !seen.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let text = fs::read_to_string(&seen).unwrap();
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("daemon"));
        let vars: Vec<&str> = lines.collect();
        assert!(vars.contains(&"SCP_NATIVE=mcp"));
        assert!(vars.contains(&"SCP_SWARM_BIN=/opt/native/swarm"));
        assert!(vars.contains(&format!("SCP_DIR={}", relay.display()).as_str()));
        assert!(
            !vars
                .iter()
                .any(|v| v.starts_with("SCP_GRANT=") || v.starts_with("SCP_CLI_ARGV="))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn walks_mark_a_failed_read() {
        let walk = walk_now(&Env::new(), 123, None);
        assert_eq!(walk, json!({ "keys": [], "self": [], "unread": true }));
    }

    #[test]
    fn handshakes_map_like_the_cli() {
        let dir = std::env::temp_dir().join(format!("scp-mcp-spawn-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("cli.sh");
        fs::write(
            &script,
            "#!/bin/sh\ncase \"$SCP_TEST_REPLY\" in\n  ok) printf '{\"name\":\"w1\",\"pid\":%s}\\n' $$ >&3;;\n  err) printf '{\"error\":\"nope\",\"usage\":true}\\n' >&3;;\n  *) exit 3;;\nesac\n",
        )
        .unwrap();
        fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let run = |reply: &str| {
            let mut env: Env = std::env::vars().collect();
            env.insert(
                CLI_ARGV.into(),
                serde_json::to_string(&[script.to_str().unwrap()]).unwrap(),
            );
            env.insert("SCP_TEST_REPLY".into(), reply.into());
            runtime.block_on(spawn_detached(
                words(&["--bg", "--as", "me/a", "--", "true"]),
                &dir,
                &env,
                1,
            ))
        };
        assert!(matches!(run("ok"), Ok(Spawned { name, pid }) if name == "w1" && pid > 1));
        assert_eq!(run("err"), Err("nope".into()));
        assert_eq!(
            run("none"),
            Err("swarm spawn: the detached runner ended before the harness started".into())
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
