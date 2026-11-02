//! The `daemon` entry shared by the `scp-broker` and `swarm` binaries.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::paths::{Paths, account_home};
use crate::proto::Limits;
use crate::server::{Broker, BrokerOptions};

pub const DEFAULT_IDLE_S: f64 = 1800.0;

/// seconds from a bare number or a duration such as `90s`, `30m` or `1h30m`
pub fn idle_seconds(raw: &str) -> Result<f64, String> {
    let text = raw.trim();
    let seconds = text.parse::<f64>().ok().or_else(|| duration(text));
    seconds
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= u32::MAX as f64)
        .ok_or_else(|| "idle must be a nonnegative number of seconds or a duration like 30m".into())
}

fn duration(text: &str) -> Option<f64> {
    let mut total = 0.0;
    let mut rest = text;
    while !rest.is_empty() {
        let digits = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .filter(|n| *n > 0)?;
        let value: f64 = rest[..digits].parse().ok()?;
        rest = &rest[digits..];
        let (unit, len) = [
            ("ms", 0.001),
            ("s", 1.0),
            ("m", 60.0),
            ("h", 3600.0),
            ("d", 86400.0),
        ]
        .into_iter()
        .find(|(name, _)| rest.starts_with(name))
        .map(|(name, unit)| (unit, name.len()))?;
        total += value * unit;
        rest = &rest[len..];
    }
    (!text.is_empty()).then_some(total)
}

/// runs the broker in the foreground until SIGTERM or SIGINT
pub async fn run(idle: f64, policy: Option<PathBuf>) -> Result<(), Box<dyn std::error::Error>> {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let path_env = env.clone();
    let (paths, policy_file) = tokio::task::spawn_blocking(move || {
        let paths = Paths::from_env(&path_env)?;
        let home =
            account_home().or_else(|error| path_env.get("HOME").map(PathBuf::from).ok_or(error));
        let policy_file = match policy {
            Some(path) => path,
            None => home?.join(".config/scp/policy.json"),
        };
        Ok::<_, io::Error>((paths, policy_file))
    })
    .await??;
    let limits = Limits::from_env(&env).await.map_err(io::Error::other)?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let broker = Broker::start(BrokerOptions {
        paths,
        limits,
        policy_file,
        idle: Duration::from_secs_f64(idle),
        env,
    })
    .await?;
    broker
        .run(async move {
            tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
        })
        .await?;
    Ok(())
}

/// whether `error` says another broker holds the lock
pub fn already_runs(error: &(dyn std::error::Error + 'static)) -> bool {
    error.downcast_ref::<io::Error>().is_some_and(|e| {
        e.kind() == io::ErrorKind::AlreadyExists && e.to_string() == "a relay broker already runs"
    })
}

/// the pid in the broker lock of `dir` when that process runs a broker
pub fn broker_pid(dir: &Path) -> Option<i32> {
    let text = std::fs::read_to_string(dir.join("broker.lock")).ok()?;
    let pid: i32 = text.split(':').next()?.trim().parse().ok()?;
    if pid <= 0 {
        return None;
    }
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    let command = String::from_utf8_lossy(&output.stdout);
    let daemon = command.split_whitespace().any(|word| word == "daemon");
    (daemon && (command.contains("scp") || command.contains("swarm"))).then_some(pid)
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// stops the broker of `dir` with SIGTERM and waits up to 5 s; its pid, or None when none ran
pub fn stop(dir: &Path) -> io::Result<Option<i32>> {
    let Some(pid) = broker_pid(dir) else {
        return Ok(None);
    };
    // SAFETY: plain kill(2) on a pid read from the broker lock and checked with ps
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        if Instant::now() >= deadline {
            return Err(io::Error::other(format!(
                "the relay broker (pid {pid}) did not stop within 5 s"
            )));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(Some(pid))
}
