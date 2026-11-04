use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HELPER: &str = "SCP_TEST_TASK_HELPER";

/// the task process the broker runs as `<this test binary> --exact task_helper claude-bg-task`: it connects as the human,
/// records the run, holds the connection a moment and exits; outside a broker's run it does nothing
#[test]
fn task_helper() {
    if std::env::var(HELPER).is_err() {
        return;
    }
    let dir = std::path::PathBuf::from(std::env::var("SCP_DIR").expect("SCP_DIR"));
    let stream = UnixStream::connect(dir.join("relay.sock")).expect("connect");
    let mut writer = stream.try_clone().expect("clone");
    writeln!(
        writer,
        "{}",
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":"scp/1","human":true}})
    )
    .expect("hello");
    let mut line = String::new();
    BufReader::new(&stream)
        .read_line(&mut line)
        .expect("answer");
    let answer: serde_json::Value = serde_json::from_str(&line).expect("JSON");
    assert!(answer.get("result").is_some(), "{answer}");
    let mut runs = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("task-runs"))
        .expect("runs");
    writeln!(runs, "connected").expect("record");
    std::thread::sleep(Duration::from_millis(300));
}

#[test]
fn an_idle_broker_stops_while_its_task_runs_every_second() {
    let home = std::path::PathBuf::from(format!("/tmp/scp-ti-{:08x}", rand::random::<u32>()));
    let dir = home.join("relay");
    std::fs::create_dir_all(&home).expect("home");
    let exe = std::env::current_exe().expect("test binary");
    let cli = serde_json::json!([exe, "--exact", "task_helper", "--test-threads", "1"]).to_string();
    let started = Instant::now();
    let mut broker = Command::new(env!("CARGO_BIN_EXE_scp-broker"))
        .args(["daemon", "--idle", "2.5", "--policy"])
        .arg(home.join("policy.json"))
        .env_clear()
        .env("HOME", &home)
        .env("PATH", "/usr/bin:/bin")
        .env("SCP_DIR", &dir)
        .env("SCP_CLI_ARGV", &cli)
        .env("SCP_CLAUDE_BG_EVERY_S", "1")
        .env(HELPER, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("run scp-broker");
    let status = loop {
        if let Some(status) = broker.try_wait().expect("wait") {
            break Some(status);
        }
        if started.elapsed() > Duration::from_secs(10) {
            let _ = broker.kill();
            let _ = broker.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let elapsed = started.elapsed();
    let mut stderr = String::new();
    if let Some(mut pipe) = broker.stderr.take() {
        let _ = std::io::Read::read_to_string(&mut pipe, &mut stderr);
    }
    let runs = std::fs::read_to_string(dir.join("task-runs")).unwrap_or_default();
    std::fs::remove_dir_all(&home).ok();
    let status = status.unwrap_or_else(|| {
        panic!("the broker never went idle with its task running: {runs:?} {stderr}")
    });
    assert!(status.success(), "{stderr}");
    assert!(
        runs.lines().filter(|line| *line == "connected").count() >= 2,
        "the task did not connect on its interval: {runs:?} {stderr}"
    );
    assert!(elapsed < Duration::from_secs(6), "{elapsed:?} {stderr}");
}
