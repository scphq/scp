use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::path::PathBuf::from(format!(
            "/tmp/swarm-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn swarm(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_swarm"));
        command
            .args(args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &self.0)
            .env("SCP_DIR", self.0.join("r"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        if let Ok(text) = fs::read_to_string(self.0.join("r/broker.lock"))
            && let Ok(pid) = text.split(':').next().unwrap_or("").parse::<i32>()
            && scp_broker::daemon::broker_pid(&self.0.join("r")) == Some(pid)
        {
            // SAFETY: the pid of the broker this test started, checked with ps
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn output(mut command: Command) -> Output {
    command.stdin(Stdio::null());
    command.output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
fn version_usage_and_errors() {
    let temp = Temp::new();
    let version = output(temp.swarm(&["--version"]));
    assert!(version.status.success());
    let cli: Value =
        serde_json::from_str(&fs::read_to_string("../../packages/cli/package.json").unwrap())
            .unwrap();
    assert_eq!(
        text(&version.stdout),
        format!("swarm {}\n", cli["version"].as_str().unwrap())
    );
    let mcp = output(temp.swarm(&["mcp", "extra"]));
    assert_eq!(mcp.status.code(), Some(125));
    assert!(text(&mcp.stderr).contains("mcp takes no arguments"));
    let unknown = output(temp.swarm(&["frobnicate"]));
    assert_eq!(unknown.status.code(), Some(125));
    assert!(text(&unknown.stderr).contains("frobnicate is not native in this swarm"));
    let mut handed = temp.swarm(&["--as", "x", "frobnicate", "a"]);
    handed.env(
        "SCP_CLI_ARGV",
        r#"["/bin/sh","-c","echo \"$SCP_ROUTED $*\"","sh"]"#,
    );
    let handed = output(handed);
    assert_eq!(text(&handed.stdout), "ts --as x frobnicate a\n");
    assert_eq!(output(temp.swarm(&[])).status.code(), Some(2));
    let bad = output(temp.swarm(&["daemon", "start"]));
    assert_eq!(bad.status.code(), Some(2));
    let idle = output(temp.swarm(&["daemon", "--idle", "soon"]));
    assert_eq!(idle.status.code(), Some(2));
}

#[test]
fn hook_as_a_later_word_runs_the_cli_not_the_hook() {
    let temp = Temp::new();
    for args in [
        &["frobnicate", "x", "hook"][..],
        &["send", "x", "hook", "--help"],
    ] {
        let mut command = temp.swarm(args);
        command.env(
            "SCP_CLI_ARGV",
            r#"["/bin/sh","-c","echo \"$SCP_ROUTED $*\"","sh"]"#,
        );
        let handed = output(command);
        assert_eq!(text(&handed.stdout), format!("ts {}\n", args.join(" ")));
    }
    for args in [
        &["swarm", "hook", "claude"][..],
        &["/usr/bin/node", "/x/cli.js", "hook", "claude"],
    ] {
        let hook = output(temp.swarm(args));
        assert_eq!(hook.status.code(), Some(0), "{args:?}");
        assert_eq!(text(&hook.stdout), "", "{args:?}");
    }
}

#[test]
fn mcp_serves_stdio_in_process() {
    let temp = Temp::new();
    let mut command = temp.swarm(&["mcp", "--harness", "claude"]);
    command
        .env("SCP_CLI_ARGV", r#"["/usr/bin/false"]"#)
        .env("SCP_HARNESS_DETECT", "0");
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for request in [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    ] {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{}", text(&out.stderr));
    let replies: Vec<Value> = text(&out.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["result"]["serverInfo"]["name"], "scp");
    let tools = replies[1]["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|tool| tool["name"] == "relay_whoami"));
}

#[test]
fn mcp_help_never_hands_itself_on() {
    let temp = Temp::new();
    let bin = temp.0.join("bin");
    fs::create_dir(&bin).unwrap();
    std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_swarm"), bin.join("swarm")).unwrap();
    let mut command = temp.swarm(&["mcp", "--help"]);
    command.env("PATH", format!("{}:/usr/bin:/bin", bin.display()));
    let out = output(command);
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(text(&out.stdout).starts_with("usage: swarm mcp "));
}

#[test]
fn idle_takes_seconds_and_durations() {
    use scp_broker::daemon::idle_seconds;
    assert_eq!(idle_seconds("90"), Ok(90.0));
    assert_eq!(idle_seconds("1h30m"), Ok(5400.0));
    assert_eq!(idle_seconds("1.5s"), Ok(1.5));
    assert_eq!(idle_seconds("250ms"), Ok(0.25));
    for bad in ["", "m", "1x", "-3", "30 m", "inf"] {
        assert!(idle_seconds(bad).is_err(), "{bad}");
    }
}

fn line(reader: &mut BufReader<UnixStream>) -> Value {
    let mut text = String::new();
    assert_ne!(reader.read_line(&mut text).unwrap(), 0);
    serde_json::from_str(&text).unwrap()
}

fn send(reader: &mut BufReader<UnixStream>, value: Value) {
    writeln!(reader.get_mut(), "{value}").unwrap();
}

#[test]
fn hook_runs_in_process() {
    let temp = Temp::new();
    fs::create_dir(temp.0.join("r")).unwrap();
    let listener = UnixListener::bind(temp.0.join("r/relay.sock")).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(6)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        assert_eq!(
            line(&mut reader)["params"],
            json!({"protocol":"scp/1","observe":true})
        );
        send(
            &mut reader,
            json!({"jsonrpc":"2.0","id":1,"result":{"capabilities":["hook"]}}),
        );
        let request = line(&mut reader);
        assert_eq!(request["method"], "hook");
        assert_eq!(request["params"]["args"], json!(["claude"]));
        assert_eq!(request["params"]["payload"], json!({"hello":true}));
        send(
            &mut reader,
            json!({"id":2,"result":{"stdout":"reply","exit":0,"commit":"token"}}),
        );
        assert_eq!(line(&mut reader)["method"], "hook_commit");
        send(&mut reader, json!({"id":3,"result":{}}));
    });
    let mut child = temp.swarm(&["hook", "claude"]).spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"hello":true}"#)
        .unwrap();
    let out = child.wait_with_output().unwrap();
    server.join().unwrap();
    assert!(out.status.success());
    assert_eq!(text(&out.stdout), "reply\n");
}

#[test]
fn hook_without_broker_is_silent() {
    let temp = Temp::new();
    let mut child = temp.swarm(&["hook", "claude"]).spawn().unwrap();
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
}

#[test]
fn hook_renders_against_the_native_broker() {
    let temp = Temp::new();
    let start = output(temp.swarm(&["daemon", "restart"]));
    assert!(start.status.success(), "{}", text(&start.stderr));
    let mut command = temp.swarm(&["hook", "claude"]);
    command
        .env("CLAUDECODE", "1")
        .env("CLAUDE_PID", std::process::id().to_string())
        .env("SCP_SESSION", "native-hook")
        .env("SCP_NAME", "subject")
        .env("SCP_TLDR_EVERY", "0");
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"hook_event_name":"SessionStart","source":"startup"}"#)
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let reply: Value = serde_json::from_str(&text(&out.stdout)).unwrap();
    assert_eq!(reply["hookSpecificOutput"]["hookEventName"], "SessionStart");
    assert!(
        reply["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap()
            .contains("relay_set_title")
    );
}

#[test]
fn daemon_stop_and_restart() {
    let temp = Temp::new();
    let stop = output(temp.swarm(&["daemon", "stop"]));
    assert!(stop.status.success());
    assert_eq!(text(&stop.stdout), "no relay broker runs\n");
    let start = output(temp.swarm(&["daemon", "restart"]));
    assert!(start.status.success(), "{}", text(&start.stderr));
    assert!(text(&start.stdout).starts_with("started a fresh one (pid "));
    let first = scp_broker::daemon::broker_pid(&temp.0.join("r")).unwrap();
    let again = output(temp.swarm(&["daemon", "restart"]));
    assert!(again.status.success(), "{}", text(&again.stderr));
    assert!(
        text(&again.stdout).starts_with(&format!("replaced the relay broker (pid {first}) with"))
    );
    let second = scp_broker::daemon::broker_pid(&temp.0.join("r")).unwrap();
    assert_ne!(first, second);
    let twice = output(temp.swarm(&["daemon"]));
    assert!(twice.status.success());
    assert!(text(&twice.stderr).contains("a relay broker already runs"));
    let stopped = output(temp.swarm(&["daemon", "stop"]));
    assert_eq!(
        text(&stopped.stdout),
        format!("stopped the relay broker (pid {second}); the next command starts a fresh one\n")
    );
    assert!(scp_broker::daemon::broker_pid(&temp.0.join("r")).is_none());
}

#[test]
fn builtin_wakers_run_the_named_cli() {
    use scp_broker::wake::{Wakers, cli_argv};
    let env = |value: &str| [("SCP_CLI_ARGV".to_owned(), value.to_owned())].into();
    let cli = cli_argv(&env(r#"["node","/opt/cli.js"]"#)).unwrap();
    assert_eq!(cli, ["node", "/opt/cli.js"]);
    for bad in ["[]", r#"[""]"#, "node", r#"{"a":1}"#] {
        assert!(cli_argv(&env(bad)).is_none(), "{bad}");
    }
    assert!(cli_argv(&Default::default()).is_none());
    let wakers = Wakers::builtin_for(&cli);
    assert_eq!(
        wakers["claude-bg"].command,
        ["node", "/opt/cli.js", "claude-wake"]
    );
    assert_eq!(
        Wakers::builtin()["codex-queue"].command,
        ["swarm", "codex-wake"]
    );
}

#[test]
fn a_broker_with_no_cli_runs_the_claude_bg_task_itself() {
    let temp = Temp::new();
    let bin = temp.0.join("bin");
    let log = temp.0.join("claude.log");
    fs::create_dir(&bin).unwrap();
    fs::write(
        bin.join("claude"),
        format!("#!/bin/sh\necho \"$*\" >> '{}'\necho '[]'\n", log.display()),
    )
    .unwrap();
    fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o755)).unwrap();
    let records = temp.0.join("r/claude-bg");
    fs::create_dir_all(&records).unwrap();
    fs::write(records.join("1a2b3c4d.json"), "{}").unwrap();
    let mut daemon = temp.swarm(&["daemon"]);
    daemon
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .env("SCP_CLAUDE_BG_EVERY_S", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = daemon.spawn().unwrap();
    let mut listed = false;
    for _ in 0..200 {
        listed = fs::read_to_string(&log).is_ok_and(|text| text.contains("agents --json --all"));
        if listed {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(listed, "no claude-bg task ran");
}

fn cold_start(temp: &Temp, mode: &str) -> Option<String> {
    let script = temp.0.join("cli.sh");
    let started = temp.0.join("started");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\necho \"$*\" > '{}.tmp' && mv '{}.tmp' '{}'\n",
            started.display(),
            started.display(),
            started.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    let mut command = temp.swarm(&["mcp", "--harness", "claude"]);
    command
        .env("SCP_NATIVE", mode)
        .env(
            "SCP_CLI_ARGV",
            serde_json::to_string(&[script.to_str().unwrap()]).unwrap(),
        )
        .env("SCP_HARNESS_DETECT", "0")
        .env("SCP_NAME", "cold")
        .stderr(Stdio::null());
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for request in [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"relay_whoami","arguments":{}}}),
    ] {
        writeln!(stdin, "{request}").unwrap();
    }
    let lock = temp.0.join("r/broker.lock");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut seen = None;
    while std::time::Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(&started) {
            seen = Some(text.trim().to_owned());
            break;
        }
        if lock.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
    seen
}

#[test]
fn scp_native_mcp_cold_starts_the_cli_broker_and_never_a_native_one() {
    let temp = Temp::new();
    assert_eq!(cold_start(&temp, "mcp").as_deref(), Some("daemon"));
    assert!(!temp.0.join("r/broker.lock").exists());
    for args in [
        &["daemon"][..],
        &["daemon", "restart"],
        &["daemon", "--idle", "5"],
    ] {
        let mut command = temp.swarm(args);
        command.env("SCP_NATIVE", "mcp");
        let out = output(command);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(text(&out.stderr).contains("SCP_NATIVE=mcp keeps the TypeScript broker"));
    }
    assert!(!temp.0.join("r/broker.lock").exists());
}

#[test]
fn scp_native_1_cold_starts_the_native_broker() {
    let temp = Temp::new();
    assert_eq!(cold_start(&temp, "1"), None);
    assert!(temp.0.join("r/broker.lock").exists());
}
