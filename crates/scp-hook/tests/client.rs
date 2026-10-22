use scp_hook::{self as hook, process};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::path::PathBuf::from(format!(
            "/tmp/scp-hook-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn command(&self, harness: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_scp-hook"));
        command
            .args(["hook", harness])
            .env_clear()
            .env("SCP_DIR", &self.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }
    fn broker(&self) -> UnixListener {
        UnixListener::bind(self.0.join("relay.sock")).unwrap()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
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
fn handshake(listener: UnixListener) -> BufReader<UnixStream> {
    let (stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(6)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    let hello = line(&mut reader);
    assert_eq!(hello["params"], json!({"protocol":"scp/1","observe":true}));
    send(
        &mut reader,
        json!({"jsonrpc":"2.0","id":1,"result":{"capabilities":["hook"]}}),
    );
    reader
}
fn finish(mut command: Command, raw: &[u8]) -> std::process::Output {
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(raw).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    output
}

#[test]
fn argv_and_fast_paths() {
    let argv = [
        "/bin/runtime",
        "cli.js",
        "hook",
        "agy",
        "Stop",
        "--wake",
        "50",
    ]
    .map(str::to_owned);
    let (launcher, args) = hook::parse_argv(&argv).unwrap();
    assert_eq!(launcher, ["/bin/runtime", "cli.js"]);
    assert_eq!(args, ["agy", "Stop", "--wake", "50"]);
    assert!(hook::parse_argv(&["hooks".into()]).is_none());
    assert!(hook::subagent_skip(&["--subagent".into()], b"{}"));
    for raw in [br#"{"agent_id":"x"}"#.as_slice(), br#"{"agentId":"x"}"#] {
        assert!(!hook::subagent_skip(&["--subagent".into()], raw));
    }
    assert!(!hook::cowork_live(&HashMap::new()));
    for (key, value) in [
        ("CLAUDE_CODE_IS_COWORK", "1"),
        ("CLAUDE_CODE_ENTRYPOINT", "remote_cowork"),
    ] {
        assert!(hook::cowork_live(&HashMap::from([(
            key.into(),
            value.into()
        )])));
    }
    let temp = Temp::new();
    let mut command = temp.command("agy");
    command.arg("--cowork-only");
    assert!(finish(command, b"").stdout.is_empty());
    let mut command = temp.command("agy");
    command.arg("--subagent");
    assert!(finish(command, b"{}").stdout.is_empty());
}

#[test]
fn deadline_math() {
    assert_eq!(hook::hook_ends(false, 100, 3000), 3600);
    assert_eq!(hook::hook_ends(true, 100, 3000), 3600);
    assert_eq!(hook::hook_ends(true, 100, 200), 1100);
    assert_eq!(hook::connect_budget(5000, 1000), 2500);
    assert_eq!(hook::connect_budget(5000, 4001), 0);
    assert_eq!(hook::connect_budget(5000, 3000), 1000);
    assert_eq!(hook::connect_budget(10, 30), 0);
}

#[test]
fn paths() {
    let mut env = HashMap::from([("HOME".into(), "/home/test".into())]);
    assert_eq!(
        hook::relay_dir(&env).to_str().unwrap(),
        "/home/test/.local/state/scp"
    );
    env.insert("XDG_STATE_HOME".into(), "/state//./folder/../".into());
    assert_eq!(hook::relay_dir(&env).to_str().unwrap(), "/state/scp");
    env.insert("SCP_DIR".into(), "relative//dir".into());
    assert_eq!(hook::relay_dir(&env).to_str().unwrap(), "relative//dir");
    assert_eq!(
        hook::socket_path(std::path::Path::new("/state/scp"), 7)
            .to_str()
            .unwrap(),
        "/state/scp/relay.sock"
    );
    let exact = format!("/{}", "a".repeat(88));
    assert_eq!(
        hook::socket_path(exact.as_ref(), 7).to_str().unwrap().len(),
        100
    );
    let long = format!("/{}", "a".repeat(89));
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(long.as_bytes()));
    assert_eq!(
        hook::socket_path(long.as_ref(), 7).to_str().unwrap(),
        format!("/tmp/scp-7-{}/relay.sock", &hash[..12])
    );
    assert!(hook::socket_path(format!("/{}", "日".repeat(40)).as_ref(), 7).starts_with("/tmp"));
}

#[test]
fn shrink_codepoints_and_arrays() {
    let value =
        json!({"keep-key": ["🌍é日abcd", {"deep":"abcde"}],"array":(0..80).collect::<Vec<_>>()});
    let shrunk = hook::shrink(&value, 3);
    assert_eq!(shrunk["keep-key"][0], "🌍é日");
    assert_eq!(shrunk["keep-key"][1]["deep"], "abc");
    assert_eq!(shrunk["array"].as_array().unwrap().len(), 64);
}
fn request_len(frame: &Value) -> usize {
    serde_json::to_vec(frame).unwrap().len() + 1
}
#[test]
fn shrink_thresholds() {
    let frame = hook::hook_frame(json!({"payload":{"s":""}}));
    let overhead = request_len(&frame);
    let count = hook::LINE_LIMIT - overhead;
    let frame = hook::hook_frame(json!({"payload":{"s":"x".repeat(count)}}));
    assert_eq!(request_len(&frame), hook::LINE_LIMIT);
    let frame = hook::hook_frame(json!({"payload":{"s":"x".repeat(count+1)}}));
    assert_eq!(
        frame["params"]["payload"]["s"].as_str().unwrap().len(),
        8192
    );
    for (n, expected) in [(40, 1024), (300, 128)] {
        let payload: serde_json::Map<String, Value> = (0..n)
            .map(|i| (i.to_string(), json!("x".repeat(9000))))
            .collect();
        let frame = hook::hook_frame(json!({"payload":payload}));
        assert_eq!(
            frame["params"]["payload"]["0"].as_str().unwrap().len(),
            expected
        );
        assert!(request_len(&frame) <= hook::LINE_LIMIT);
    }
}
#[test]
fn shrink_final_fallback() {
    let huge_key = "k".repeat(hook::LINE_LIMIT);
    let payload = json!({huge_key:{"nested":"x"},"number":4,"bool":true,"null":null,"short":"🌍".repeat(128),"long":"x".repeat(129),"array":[1]});
    let frame = hook::hook_frame(json!({"payload":payload}));
    assert_eq!(
        frame["params"]["payload"],
        json!({"number":4,"bool":true,"null":null,"short":"🌍".repeat(128)})
    );
}

#[test]
fn result_printed_then_committed() {
    let temp = Temp::new();
    let listener = temp.broker();
    let server = std::thread::spawn(move || {
        let mut reader = handshake(listener);
        let request = line(&mut reader);
        assert_eq!(request["method"], "hook");
        assert_eq!(request["params"]["payload"], json!({"hello":true}));
        assert_eq!(request["params"]["args"], json!(["claude"]));
        assert!(request["params"]["env"].get("PRIVATE_SECRET").is_none());
        assert_eq!(request["params"]["env"]["SCP_SESSION"], "session");
        let ppid = request["params"]["ppid"].as_i64().unwrap();
        let procs = request["params"]["procs"].as_array().unwrap();
        assert!(procs.len() <= 64);
        assert_eq!(procs[0]["pid"], ppid);
        assert!(procs[0]["comm"].is_string());
        send(&mut reader, json!({"id":999,"result":{}}));
        send(&mut reader, json!({"method":"other","params":{}}));
        send(
            &mut reader,
            json!({"id":2,"result":{"stdout":"reply","stderr":"warning\nignored","exit":0,"commit":"token"}}),
        );
        assert_eq!(
            line(&mut reader),
            json!({"jsonrpc":"2.0","id":3,"method":"hook_commit","params":{"commit":"token"}})
        );
        send(&mut reader, json!({"id":3,"result":{}}));
    });
    let mut command = temp.command("claude");
    command
        .env("PRIVATE_SECRET", "hidden")
        .env("SCP_SESSION", "session");
    let output = finish(command, br#"{"hello":true}"#);
    server.join().unwrap();
    assert_eq!(output.stdout, b"reply\n");
    assert_eq!(output.stderr, b"warning\n");
}

#[test]
fn failed_write_never_commits() {
    let temp = Temp::new();
    let listener = temp.broker();
    let server = std::thread::spawn(move || {
        let mut reader = handshake(listener);
        line(&mut reader);
        send(
            &mut reader,
            json!({"id":2,"result":{"stdout":"reply","commit":"token","exit":0}}),
        );
        let mut text = String::new();
        assert_eq!(reader.read_line(&mut text).unwrap(), 0);
    });
    let mut command = temp.command("claude");
    let (write_end, read_end) = {
        let (reader, writer) = UnixStream::pair().unwrap();
        (writer, reader)
    };
    use std::os::fd::{FromRawFd, IntoRawFd};
    command.stdout(unsafe { Stdio::from_raw_fd(write_end.into_raw_fd()) });
    drop(read_end);
    finish(command, b"{}");
    server.join().unwrap();
}

#[test]
fn deadline_extends() {
    let temp = Temp::new();
    let listener = temp.broker();
    let server = std::thread::spawn(move || {
        let mut reader = handshake(listener);
        line(&mut reader);
        send(
            &mut reader,
            json!({"method":"hook_deadline","params":{"ends":hook::now()+1600}}),
        );
        std::thread::sleep(Duration::from_millis(1050));
        send(
            &mut reader,
            json!({"id":2,"result":{"stdout":"extended","exit":0}}),
        );
    });
    assert_eq!(finish(temp.command("agy"), b"{}").stdout, b"extended\n");
    server.join().unwrap();
}

#[test]
fn deadline_exits() {
    for harness in ["claude", "agy"] {
        let temp = Temp::new();
        let listener = temp.broker();
        let server = std::thread::spawn(move || {
            let mut reader = handshake(listener);
            line(&mut reader);
            send(
                &mut reader,
                json!({"method":"hook_deadline","params":{"ends":hook::now()+50}}),
            );
            let mut text = String::new();
            assert_eq!(reader.read_line(&mut text).unwrap(), 0);
        });
        let began = Instant::now();
        assert_eq!(
            finish(temp.command(harness), b"{}").stdout,
            if harness == "agy" {
                b"{}\n".as_slice()
            } else {
                b""
            }
        );
        assert!(began.elapsed() < Duration::from_secs(3));
        server.join().unwrap();
    }
}

#[test]
fn fallback_launcher_and_engine() {
    for engine in [false, true] {
        let temp = Temp::new();
        let script = temp.0.join("launcher.sh");
        fs::write(&script,"test \"$1\" = prefix || exit 1\ntest \"$2\" = hook || exit 1\ntest \"$3\" = agy || exit 1\ncat\n").unwrap();
        let server = if engine {
            None
        } else {
            let listener = temp.broker();
            Some(std::thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream);
                line(&mut reader);
                send(&mut reader, json!({"id":1,"result":{"capabilities":[]}}));
            }))
        };
        let mut command = Command::new(env!("CARGO_BIN_EXE_scp-hook"));
        command
            .args(["/bin/sh", script.to_str().unwrap(), "prefix", "hook", "agy"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("SCP_DIR", &temp.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if engine {
            command.env("SCP_ENGINE", "ts");
        }
        assert_eq!(finish(command, b"original\n").stdout, b"original\n");
        if let Some(server) = server {
            server.join().unwrap();
        }
    }
}

#[test]
fn version() {
    let output = Command::new(env!("CARGO_BIN_EXE_scp-hook"))
        .arg("--version")
        .output()
        .unwrap();
    let manifest: Value =
        serde_json::from_str(include_str!("../../../packages/cli/package.json")).unwrap();
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("scp-hook {}\n", manifest["version"].as_str().unwrap())
    );
}

fn ps(pid: i32, field: &str, tz: &str) -> Option<String> {
    let output = match Command::new("ps")
        .args(["-ww", "-o", field, "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .env("TZ", tz)
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            assert!(
                std::env::var_os("SCP_HOOK_REQUIRE_PS").is_none(),
                "ps is missing"
            );
            return None;
        }
        Err(error) => panic!("ps failed: {error}"),
    };
    assert!(
        output.status.success(),
        "ps failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Some(String::from_utf8(output.stdout).unwrap().trim().to_owned())
}

#[test]
fn native_process_matches_ps() {
    unsafe extern "C" {
        fn tzset();
    }
    // TZ changes live only in this isolated test subprocess.
    if std::env::var_os("SCP_HOOK_PS_TEST").is_none() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        let output = command
            .args(["--exact", "native_process_matches_ps", "--nocapture"])
            .env("SCP_HOOK_PS_TEST", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    for tz in ["UTC", "America/Los_Angeles", "Asia/Kolkata"] {
        unsafe {
            std::env::set_var("TZ", tz);
            tzset();
        }
        let procs = process::collect(std::process::id() as i32, &HashMap::new());
        assert!(!procs.is_empty());
        for proc in procs {
            let Some(start) = ps(proc.pid, "lstart=", tz) else {
                return;
            };
            assert_eq!(
                proc.start.as_deref(),
                Some(
                    start
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join("-")
                        .as_str()
                ),
                "start pid {} TZ {tz}",
                proc.pid
            );
            assert_eq!(
                proc.args,
                ps(proc.pid, "args=", tz).unwrap(),
                "args pid {}",
                proc.pid
            );
            assert_eq!(
                proc.comm,
                ps(proc.pid, "comm=", tz).unwrap(),
                "comm pid {}",
                proc.pid
            );
            assert_eq!(
                proc.ppid.to_string(),
                ps(proc.pid, "ppid=", tz).unwrap(),
                "ppid pid {}",
                proc.pid
            );
        }
    }
}

#[test]
fn empty_result_is_not_committed() {
    let temp = Temp::new();
    let listener = temp.broker();
    let server = std::thread::spawn(move || {
        let mut reader = handshake(listener);
        line(&mut reader);
        send(
            &mut reader,
            json!({"id":2,"result":{"stdout":"","commit":"token","exit":0}}),
        );
        let mut text = String::new();
        assert_eq!(reader.read_line(&mut text).unwrap(), 0);
    });
    assert_eq!(finish(temp.command("agy"), b"{}").stdout, b"{}\n");
    server.join().unwrap();
}

#[test]
fn watchdog_bounds_blocked_stdin() {
    let temp = Temp::new();
    let began = Instant::now();
    let mut child = temp.command("agy").spawn().unwrap();
    let input = child.stdin.take().unwrap();
    let output = child.wait_with_output().unwrap();
    drop(input);
    assert!(output.status.success());
    assert_eq!(output.stdout, b"{}\n");
    assert!(began.elapsed() < Duration::from_secs(3));
}

#[test]
fn fallback_deadline_and_spawn_failure() {
    let temp = Temp::new();
    let script = temp.0.join("wait.sh");
    fs::write(&script, "exec sleep 10\n").unwrap();
    for launcher in [
        vec!["/bin/sh".to_owned(), script.to_str().unwrap().to_owned()],
        vec![temp.0.join("missing").to_str().unwrap().to_owned()],
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_scp-hook"));
        command
            .args(launcher)
            .args(["hook", "agy"])
            .env_clear()
            .env("SCP_ENGINE", "ts")
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let began = Instant::now();
        assert_eq!(finish(command, b"{}").stdout, b"{}\n");
        assert!(began.elapsed() < Duration::from_secs(3));
    }
}

#[test]
fn busy_and_sandbox_warning() {
    for sandbox in [false, true] {
        let temp = Temp::new();
        drop(temp.broker());
        fs::write(
            temp.0.join("broker.lock"),
            format!("{}:{}", std::process::id(), hook::now() / 1000),
        )
        .unwrap();
        let mut command = temp.command("agy");
        if sandbox {
            command.env("CODEX_SANDBOX", "1");
        }
        let output = finish(command, b"{}");
        assert_eq!(output.stdout, b"{}\n");
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert_eq!(stderr.lines().count(), 1);
        assert!(stderr.starts_with("swarm hook: relay broker unreachable, hook skipped: "));
        assert!(stderr.contains(if sandbox {
            "the sandbox blocks the relay socket (ECONNREFUSED)"
        } else {
            "it is busy; swarm status shows it"
        }));
    }
}

#[test]
fn session_start_daemon_environment() {
    let temp = Temp::new();
    let script = temp.0.join("daemon.sh");
    fs::write(
        &script,
        "printf '%s\\n' \"$*\" \"$SCP_DIR\" \"$HOME\" \"${PRIVATE_SECRET-unset}\" \"$PWD\"\n",
    )
    .unwrap();
    fs::write(temp.0.join("broker.log"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    let dir = temp.0.clone();
    let server = std::thread::spawn(move || {
        let began = Instant::now();
        loop {
            if fs::read_to_string(dir.join("broker.log"))
                .unwrap()
                .starts_with("prefix daemon\n")
            {
                break;
            }
            assert!(began.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(5));
        }
        let listener = UnixListener::bind(dir.join("relay.sock")).unwrap();
        let mut reader = handshake(listener);
        line(&mut reader);
        send(
            &mut reader,
            json!({"id":2,"result":{"stdout":"started","exit":0}}),
        );
    });
    let mut command = Command::new(env!("CARGO_BIN_EXE_scp-hook"));
    command
        .args([
            "/bin/sh",
            script.to_str().unwrap(),
            "prefix",
            "hook",
            "claude",
            "SessionStart",
        ])
        .env_clear()
        .env("SCP_DIR", &temp.0)
        .env("HOME", "/home/test")
        .env("PRIVATE_SECRET", "hidden")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    assert_eq!(finish(command, b"{}").stdout, b"started\n");
    server.join().unwrap();
    let log = fs::read_to_string(temp.0.join("broker.log")).unwrap();
    let lines: Vec<_> = log.lines().collect();
    assert_eq!(lines[0], "prefix daemon");
    assert_eq!(lines[1], temp.0.to_str().unwrap());
    assert_eq!(lines[2], "/home/test");
    assert_eq!(lines[3], "unset");
    assert_eq!(
        std::fs::canonicalize(lines[4]).unwrap(),
        std::fs::canonicalize(&temp.0).unwrap()
    );
}

#[test]
fn session_start_mapping() {
    let env = HashMap::new();
    let args = |s: &str| s.split_whitespace().map(str::to_owned).collect::<Vec<_>>();
    assert!(hook::session_start(
        &args("agy --push-wait 5 SessionStart"),
        &json!({}),
        &env
    ));
    assert!(hook::session_start(
        &args("claude --no-inject"),
        &json!({"hook_event_name":null,"hookEventName":" session_start1 "}),
        &env
    ));
    assert!(!hook::session_start(
        &args("agy SessionStart"),
        &json!({"hook_event_name":"Stop"}),
        &env
    ));
    assert!(!hook::session_start(
        &args("agy SessionStart --wake 5"),
        &json!({}),
        &env
    ));
    assert!(!hook::session_start(
        &args("claude SessionStart --subagent"),
        &json!({}),
        &env
    ));
    assert!(!hook::session_start(
        &args("agy SessionStart"),
        &json!({}),
        &HashMap::from([("SCP_TRANSPORT".into(), "cloud".into())])
    ));
}
