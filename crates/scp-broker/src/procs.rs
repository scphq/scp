use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{Mutex, OnceCell},
    time::timeout,
};

const STARTS_TTL: Duration = Duration::from_secs(5);
const STARTS_TIMEOUT: Duration = Duration::from_secs(10);
const STARTS_MAX_BUFFER: u64 = 16 * 1024 * 1024;

type Flight = Arc<OnceCell<Option<Table>>>;

#[derive(Clone)]
struct Table {
    at: Instant,
    by_pid: HashMap<u32, String>,
}

#[derive(Default)]
struct State {
    table: Option<Table>,
    reading: Option<Flight>,
    doubted: HashMap<String, Instant>,
}

#[derive(Default)]
pub struct Procs {
    state: Mutex<State>,
    #[cfg(test)]
    spawns: std::sync::atomic::AtomicUsize,
}

impl Procs {
    pub fn new() -> Self {
        Self::default()
    }

    async fn table(&self, after: Option<Instant>) -> Option<Table> {
        let flight = {
            let mut state = self.state.lock().await;
            if let Some(table) = &state.table
                && table.at.elapsed() < STARTS_TTL
                && after.is_none_or(|after| table.at > after)
            {
                return Some(table.clone());
            }
            Arc::clone(
                state
                    .reading
                    .get_or_insert_with(|| Arc::new(OnceCell::new())),
            )
        };
        let result = flight.get_or_init(|| self.read_table()).await.clone();
        let mut state = self.state.lock().await;
        if state
            .reading
            .as_ref()
            .is_some_and(|reading| Arc::ptr_eq(reading, &flight))
        {
            if let Some(table) = &result {
                state.table = Some(table.clone());
            }
            state.reading = None;
        }
        result.or_else(|| state.table.clone())
    }

    async fn read_table(&self) -> Option<Table> {
        let at = Instant::now();
        #[cfg(test)]
        self.spawns
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let output = timeout(STARTS_TIMEOUT, async {
            let mut command = Command::new("ps");
            command
                .args(["-A", "-o", "pid=,lstart="])
                .env_clear()
                .env(
                    "PATH",
                    std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()),
                )
                .env("LC_ALL", "C")
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            let mut child = command.spawn().ok()?;
            let mut output = Vec::new();
            child
                .stdout
                .take()?
                .take(STARTS_MAX_BUFFER + 1)
                .read_to_end(&mut output)
                .await
                .ok()?;
            if output.len() as u64 > STARTS_MAX_BUFFER {
                return None;
            }
            if !child.wait().await.ok()?.success() {
                return None;
            }
            Some(output)
        })
        .await
        .ok()??;
        Some(Table {
            at,
            by_pid: parse_starts(&String::from_utf8_lossy(&output)),
        })
    }

    pub async fn start_times(&self, pids: &[u32]) -> HashMap<u32, String> {
        if pids.is_empty() {
            return HashMap::new();
        }
        let Some(table) = self.table(None).await else {
            return HashMap::new();
        };
        pids.iter()
            .filter_map(|pid| table.by_pid.get(pid).map(|start| (*pid, start.clone())))
            .collect()
    }

    pub async fn alive(&self, process_key: &str) -> bool {
        let Some((pid, expected)) = parse_key(process_key) else {
            return true;
        };
        if !pid_alive(pid) {
            return false;
        }
        let Some(expected) = expected else {
            return true;
        };
        let Some(mut table) = self.table(None).await else {
            return true;
        };
        if table
            .by_pid
            .get(&pid)
            .is_some_and(|start| start == expected)
        {
            self.state.lock().await.doubted.remove(process_key);
            return true;
        }
        let since = {
            let mut state = self.state.lock().await;
            if state.doubted.len() > 1024 {
                state.doubted.clear();
            }
            *state
                .doubted
                .entry(process_key.to_owned())
                .or_insert_with(Instant::now)
        };
        if table.at <= since {
            let Some(fresh) = self.table(Some(since)).await else {
                return true;
            };
            if fresh.at <= since {
                return true;
            }
            table = fresh;
        }
        table.by_pid.get(&pid).is_none_or(|start| start == expected)
    }
}

pub fn parse_starts(text: &str) -> HashMap<u32, String> {
    text.lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let pid = words.next()?.parse().ok()?;
            let start = words.collect::<Vec<_>>().join("-");
            valid_start(&start).then_some((pid, start))
        })
        .collect()
}

fn valid_start(start: &str) -> bool {
    !start.is_empty()
        && start.len() <= 64
        && start
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b':' || byte == b'-')
}

fn parse_key(key: &str) -> Option<(u32, Option<&str>)> {
    let key = key.strip_prefix("pid:")?;
    let (pid, expected) = key
        .split_once(':')
        .map_or((key, None), |(pid, expected)| (pid, Some(expected)));
    if pid.is_empty()
        || !pid.bytes().all(|byte| byte.is_ascii_digit())
        || expected.is_some_and(|start| {
            start.is_empty()
                || !start
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b':' || byte == b'-')
        })
    {
        return None;
    }
    let pid = pid.parse().unwrap_or(u32::MAX);
    (pid != 0).then_some((pid, expected))
}

fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // Signal zero checks existence without delivering a signal.
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn batched_and_concurrent_lookups_share_one_spawn() {
        let procs = Procs::new();
        let pid = std::process::id();
        let pids = [pid, 1, u32::MAX];
        let single = [pid];
        let (first, second, third) = tokio::join!(
            procs.start_times(&pids),
            procs.start_times(&single),
            procs.start_times(&single)
        );
        assert!(first.contains_key(&pid));
        assert_eq!(first.get(&pid), second.get(&pid));
        assert_eq!(second, third);
        assert_eq!(procs.spawns.load(std::sync::atomic::Ordering::Relaxed), 1);
        procs.start_times(&pids).await;
        assert_eq!(procs.spawns.load(std::sync::atomic::Ordering::Relaxed), 1);
        procs
            .state
            .lock()
            .await
            .table
            .as_mut()
            .expect("cached table")
            .at -= STARTS_TTL;
        procs.start_times(&pids).await;
        assert_eq!(procs.spawns.load(std::sync::atomic::Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn a_confirmed_start_mismatch_uses_the_cached_table() {
        let procs = Procs::new();
        let key = format!("pid:{}:Mon-Jan-1-00:00:00-1900", std::process::id());
        assert!(!procs.alive(&key).await);
        let spawns = procs.spawns.load(std::sync::atomic::Ordering::Relaxed);
        assert!(!procs.alive(&key).await);
        assert_eq!(
            procs.spawns.load(std::sync::atomic::Ordering::Relaxed),
            spawns
        );
    }
}
