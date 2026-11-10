//! The `daemon` entry shared by the `scp-broker` and `swarm` binaries.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::paths::{Paths, account_home};
use crate::proto::Limits;
use crate::render::Renderer;
use crate::server::{Broker, BrokerOptions};

pub const DEFAULT_IDLE_S: f64 = 1800.0;

/// The broker's runtime: every request runs under the one core lock, so more worker threads only add cross-thread hand-offs.
pub fn runtime() -> io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
}

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

/// a setting in seconds as the CLI reads one: a nonnegative number, a numeric string, a duration such as `2h`, or `Infinity` (`Some(None)`)
fn setting_seconds(value: &serde_json::Value) -> Option<Option<f64>> {
    match value {
        serde_json::Value::Number(n) => n.as_f64().filter(|n| n.is_finite() && *n >= 0.0).map(Some),
        serde_json::Value::String(text) if text == "Infinity" => Some(None),
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            static PLAIN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            let plain = PLAIN
                .get_or_init(|| regex::Regex::new(r"^\d+(\.\d+)?$").expect("constant pattern"))
                .is_match(trimmed);
            if plain {
                return trimmed.parse().ok().map(Some);
            }
            duration(trimmed)
                .filter(|n| *n > 0.0)
                .map(|n| Some(n.ceil().max(1.0)))
        }
        _ => None,
    }
}

/// `$SCP_HISTORIC_AFTER_S`, else `historic_after_s` (alias `lifecycle.historic_after_s`) in config.json, as the CLI's daemon reads it:
/// `Some(None)` for Infinity, None (and 0) for the broker's default
pub fn historic_after_s(env: &BTreeMap<String, String>, config_dir: &Path) -> Option<Option<u64>> {
    let file =
        scp_mcp::identity::read_owned_file(&config_dir.join("config.json").to_string_lossy())
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .filter(serde_json::Value::is_object)
            .unwrap_or_default();
    let lifecycle = file.get("lifecycle").filter(|v| v.is_object());
    let value = env
        .get("SCP_HISTORIC_AFTER_S")
        .and_then(|raw| setting_seconds(&serde_json::Value::String(raw.clone())))
        .or_else(|| file.get("historic_after_s").and_then(setting_seconds))
        .or_else(|| {
            lifecycle
                .and_then(|l| l.get("historic_after_s"))
                .and_then(setting_seconds)
        })?;
    match value {
        None => Some(None),
        Some(seconds) if seconds == 0.0 || seconds >= u64::MAX as f64 => None,
        Some(seconds) => Some(Some(seconds.ceil() as u64)),
    }
}

/// runs the broker in the foreground until SIGTERM or SIGINT
pub async fn run(idle: f64, policy: Option<PathBuf>) -> Result<(), Box<dyn std::error::Error>> {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let path_env = env.clone();
    let (paths, policy_file, config_dir) = tokio::task::spawn_blocking(move || {
        let paths = Paths::from_env(&path_env)?;
        let config_dir = crate::render::config_dir(&path_env)?;
        let home =
            account_home().or_else(|error| path_env.get("HOME").map(PathBuf::from).ok_or(error));
        let policy_file = match policy {
            Some(path) => path,
            None => home?.join(".config/scp/policy.json"),
        };
        Ok::<_, io::Error>((paths, policy_file, config_dir))
    })
    .await??;
    let mut limits = Limits::from_env(&env).await.map_err(io::Error::other)?;
    if let Some(value) = historic_after_s(&env, &config_dir) {
        limits.0.insert("historicAfterS".into(), value);
    }
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let dir = paths.dir.clone();
    let broker = Broker::start(BrokerOptions {
        paths,
        limits,
        policy_file,
        idle: Duration::from_secs_f64(idle),
        env,
    })
    .await?
    .with_hook(Arc::new(Renderer::new(dir, config_dir)));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn historic_after_s_reads_the_variable_then_the_config_file_as_the_cli_does() {
        let dir = std::env::temp_dir().join(format!("scp-daemon-historic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let env =
            |value: &str| BTreeMap::from([("SCP_HISTORIC_AFTER_S".to_owned(), value.to_owned())]);
        let none = BTreeMap::new();
        assert_eq!(historic_after_s(&none, &dir), None);
        assert_eq!(historic_after_s(&env("90"), &dir), Some(Some(90)));
        assert_eq!(historic_after_s(&env("1h30m"), &dir), Some(Some(5400)));
        assert_eq!(historic_after_s(&env("Infinity"), &dir), Some(None));
        assert_eq!(historic_after_s(&env("0"), &dir), None);
        std::fs::write(
            dir.join("config.json"),
            r#"{"historic_after_s":"2h","lifecycle":{"historic_after_s":60}}"#,
        )
        .unwrap();
        assert_eq!(historic_after_s(&none, &dir), Some(Some(7200)));
        assert_eq!(historic_after_s(&env("soon"), &dir), Some(Some(7200)));
        assert_eq!(historic_after_s(&env("45"), &dir), Some(Some(45)));
        std::fs::write(
            dir.join("config.json"),
            r#"{"historic_after_s":-1,"lifecycle":{"historic_after_s":"Infinity"}}"#,
        )
        .unwrap();
        assert_eq!(historic_after_s(&none, &dir), Some(None));
        std::fs::write(
            dir.join("config.json"),
            r#"{"lifecycle":{"historic_after_s":0}}"#,
        )
        .unwrap();
        assert_eq!(historic_after_s(&none, &dir), None);
        std::fs::write(dir.join("config.json"), "[1]").unwrap();
        assert_eq!(historic_after_s(&none, &dir), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
