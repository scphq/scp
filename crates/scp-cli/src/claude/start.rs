//! Whether a background session `swarm claude --bg` started is running: its early death, what it says of free memory, and the
//! `failed` mark its state file keeps for `swarm claude ls`.

use super::bg_io::{Claude, Port, claude_of, now_ms};
use super::bg_plan::seconds_text;
use super::bg_state::{Agent, BgState, Entry, alive, bg_dir, read_state, short_id, write_state};
use crate::fleet::json::Json;
use scp_mcp::ps::Env;
use std::collections::HashSet;
use std::time::{Duration, Instant};

/// free memory, in percent, below which a session that dies as it starts is put down to memory pressure
const LOW_MEMORY_PCT: u32 = 20;
/// free memory, in percent, below which `swarm claude --bg` warns before it starts a session
pub const CRITICAL_MEMORY_PCT: u32 = 10;
const CONFIRM_S: f64 = 5.0;
const CONFIRM_MAX_S: f64 = 600.0;
const CONFIRM_TICK: Duration = Duration::from_millis(200);
/// how long a session listed with no process gets to show one
const RELIST: Duration = Duration::from_millis(1000);
/// the longest one broker call of the confirm watch may take
const BROKER_CALL: Duration = Duration::from_millis(1000);

fn whole_percent(text: &str) -> Option<u32> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, "0"));
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || !digits(fraction) {
        return None;
    }
    let value: f64 = text.parse().ok()?;
    (value <= 100.0).then_some(value.floor() as u32)
}

#[cfg(target_os = "macos")]
fn probe_memory() -> Option<u32> {
    let mut level: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: the name is NUL terminated and `level` is an int of `size` bytes, as this sysctl reads
    let read = unsafe {
        libc::sysctlbyname(
            c"kern.memorystatus_level".as_ptr(),
            (&raw mut level).cast(),
            &raw mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (read == 0 && (0..=100).contains(&level)).then_some(level as u32)
}

#[cfg(not(target_os = "macos"))]
fn probe_memory() -> Option<u32> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb = |key: &str| {
        info.lines().find_map(|line| {
            let rest = line.strip_prefix(key)?.strip_prefix(':')?;
            let number = rest.trim_start().strip_suffix(" kB")?;
            number
                .bytes()
                .all(|b| b.is_ascii_digit())
                .then(|| number.parse::<u64>().ok())
                .flatten()
        })
    };
    let total = kb("MemTotal").filter(|total| *total > 0)?;
    let available = kb("MemAvailable")?.min(total);
    Some((available * 100 / total) as u32)
}

/// free memory in percent of RAM, best effort: `$SCP_MEMORY_FREE_PCT` when set, else on macOS `kern.memorystatus_level` (what
/// `memory_pressure` prints as the free percentage), else `MemAvailable` of `MemTotal` in /proc/meminfo; None when unknown
pub fn memory_free_pct(env: &Env) -> Option<u32> {
    match env.get("SCP_MEMORY_FREE_PCT").map(|given| given.trim()) {
        Some(given) if !given.is_empty() => whole_percent(given),
        _ => probe_memory(),
    }
}

/// what a launch failure adds when free memory is low: memory pressure as its likely cause
pub fn memory_hint(env: &Env) -> String {
    match memory_free_pct(env) {
        Some(free) if free < LOW_MEMORY_PCT => {
            format!("; free memory is at {free}%, so memory pressure likely killed it")
        }
        _ => String::new(),
    }
}

/// how long `swarm claude --bg` watches a session it started: `$SCP_CLAUDE_BG_CONFIRM_S` (seconds or a duration, 0 never), else 5 s
pub fn confirm_window_ms(env: &Env) -> f64 {
    let value = env
        .get("SCP_CLAUDE_BG_CONFIRM_S")
        .filter(|raw| !raw.trim().is_empty())
        .and_then(|raw| seconds_text(raw));
    value.unwrap_or(CONFIRM_S).min(CONFIRM_MAX_S) * 1000.0
}

/// the name Node gives a signal, else `signal <n>`
pub fn signal_name(signal: i32) -> String {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGVTALRM => "SIGVTALRM",
        libc::SIGPROF => "SIGPROF",
        libc::SIGSYS => "SIGSYS",
        libc::SIGCHLD => "SIGCHLD",
        libc::SIGCONT => "SIGCONT",
        libc::SIGSTOP => "SIGSTOP",
        libc::SIGTSTP => "SIGTSTP",
        libc::SIGTTIN => "SIGTTIN",
        libc::SIGTTOU => "SIGTTOU",
        libc::SIGURG => "SIGURG",
        libc::SIGWINCH => "SIGWINCH",
        libc::SIGIO => "SIGIO",
        _ => {
            return platform_signal(signal)
                .map_or_else(|| format!("signal {signal}"), str::to_owned);
        }
    };
    name.to_owned()
}

#[cfg(target_os = "macos")]
fn platform_signal(signal: i32) -> Option<&'static str> {
    match signal {
        libc::SIGEMT => Some("SIGEMT"),
        libc::SIGINFO => Some("SIGINFO"),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn platform_signal(signal: i32) -> Option<&'static str> {
    match signal {
        libc::SIGSTKFLT => Some("SIGSTKFLT"),
        libc::SIGPWR => Some("SIGPWR"),
        _ => None,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform_signal(_signal: i32) -> Option<&'static str> {
    None
}

/// the process an entry lists
fn process_of(entry: &Entry) -> Option<i32> {
    entry
        .pid
        .filter(|pid| pid.fract() == 0.0 && *pid > 0.0 && *pid <= f64::from(i32::MAX))
        .map(|pid| pid as i32)
}

/// the process an entry lists, while it still runs
pub fn running(entry: &Entry) -> Option<i32> {
    process_of(entry).filter(|pid| alive(*pid))
}

async fn find(claude: &Claude, id: &str) -> Option<Entry> {
    claude
        .list(true)
        .await?
        .into_iter()
        .find(|one| one.id.as_deref() == Some(id))
}

/// records the death in the session's state file, when the entry names its session and cwd
fn mark_failed(env: &Env, id: &str, handle: &str, entry: &Entry, reason: &str) -> String {
    if let (Some(session), Some(cwd)) = (&entry.session_id, &entry.cwd) {
        let mut state = Json::object(vec![
            ("sessionId", Json::str(session.as_str())),
            ("cwd", Json::str(cwd.as_str())),
        ]);
        if let Some(name) = entry.name.as_deref().filter(|name| !name.is_empty()) {
            state.set("name", Json::str(name));
        }
        state.set("handle", Json::str(handle));
        state.set(
            "failed",
            Json::object(vec![
                ("at", Json::Num(now_ms())),
                ("reason", Json::str(reason)),
            ]),
        );
        let _ = write_state(env, id, &state);
    }
    reason.to_owned()
}

/// why a session died: its process `pid` (else the one it lists) exited, or it lists none
fn why(entry: &Entry, pid: Option<i32>) -> String {
    let state = entry.state.as_deref().filter(|state| !state.is_empty());
    match pid.or_else(|| process_of(entry)) {
        None => format!(
            "claude agents shows it{} with no process",
            state.map(|state| format!(" {state}")).unwrap_or_default()
        ),
        Some(pid) => format!(
            "its process {pid} exited{}",
            state
                .filter(|_| process_of(entry).is_none())
                .map(|state| format!(", and claude agents shows it {state}"))
                .unwrap_or_default()
        ),
    }
}

/// how a background session started: why it died, else the endpoint the broker shows for its session and whether the watch asked the broker
pub enum StartOutcome {
    Died(String),
    Started {
        endpoint: Option<Box<Agent>>,
        asked: bool,
    },
}

/// the broker the confirm watch asks whether the session's endpoint is claimed; each call bounded, and dropped once one times out
struct Watch {
    broker: Option<Port>,
    deadline: Instant,
    asked: bool,
    shown: Option<Agent>,
}

impl Watch {
    fn bound(&self) -> Duration {
        BROKER_CALL.min(self.deadline.saturating_duration_since(Instant::now()))
    }

    fn outcome(&mut self) -> StartOutcome {
        StartOutcome::Started {
            endpoint: self.shown.take().map(Box::new),
            asked: self.asked,
        }
    }

    async fn claimed(&mut self, session: Option<&str>) -> bool {
        let Some(session) = session.filter(|session| !session.is_empty()) else {
            return false;
        };
        let Some(port) = &self.broker else {
            return false;
        };
        match tokio::time::timeout(self.bound(), port.agents()).await {
            Ok(agents) => {
                self.asked = true;
                let own: Vec<Agent> = agents
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|agent| {
                        agent.harness_session.as_deref() == Some(session)
                            || agent.surface.as_deref() == Some(session)
                    })
                    .collect();
                let held = own.iter().find(|agent| agent.connections > 0.0).cloned();
                let found = held.is_some();
                self.shown = held.or_else(|| own.into_iter().next());
                found
            }
            Err(_) => {
                port.close();
                self.broker = None;
                false
            }
        }
    }

    async fn check(
        &mut self,
        claude: &Claude,
        env: &Env,
        id: &str,
        handle: &str,
        first: Entry,
    ) -> StartOutcome {
        let window = self.deadline.saturating_duration_since(Instant::now());
        let mut entry = first;
        if running(&entry).is_none() {
            if self.claimed(entry.session_id.as_deref()).await {
                return self.outcome();
            }
            tokio::time::sleep(RELIST.min(window)).await;
            let Some(again) = find(claude, id).await else {
                return self.outcome();
            };
            if running(&again).is_none() {
                if self.claimed(again.session_id.as_deref()).await {
                    return self.outcome();
                }
                return StartOutcome::Died(mark_failed(
                    env,
                    id,
                    handle,
                    &again,
                    &why(&again, None),
                ));
            }
            entry = again;
        }
        let Some(mut pid) = process_of(&entry) else {
            return self.outcome();
        };
        loop {
            if !alive(pid) {
                let after = find(claude, id).await;
                if let Some(next) = after.as_ref().and_then(running) {
                    pid = next;
                    if let Some(after) = after {
                        entry = after;
                    }
                    continue;
                }
                let gone = after.as_ref().unwrap_or(&entry);
                return StartOutcome::Died(mark_failed(
                    env,
                    id,
                    handle,
                    gone,
                    &why(gone, Some(pid)),
                ));
            }
            if self.claimed(entry.session_id.as_deref()).await || Instant::now() >= self.deadline {
                return self.outcome();
            }
            tokio::time::sleep(CONFIRM_TICK).await;
        }
    }
}

/// how the background session `id` started: it runs once its endpoint is claimed under its session id, or while its process lives through
/// the confirm window, and the endpoint is the one a connection holds for its session, else one its session's claims made. A session
/// `claude agents --json --all` does not list, or a failed listing, is not watched. A death is recorded as `failed` in its state file
pub async fn start_outcome(id: &str, handle: &str, env: &Env) -> StartOutcome {
    let unwatched = StartOutcome::Started {
        endpoint: None,
        asked: false,
    };
    let window = confirm_window_ms(env);
    let Some(claude) = claude_of(env) else {
        return unwatched;
    };
    if window == 0.0 {
        return unwatched;
    }
    let deadline = Instant::now() + Duration::from_secs_f64(window / 1000.0);
    let Some(entry) = find(&claude, id).await else {
        return unwatched;
    };
    let mut watch = Watch {
        broker: None,
        deadline,
        asked: false,
        shown: None,
    };
    watch.broker = match tokio::time::timeout(watch.bound(), Port::open(env)).await {
        Ok(Ok(port)) => Some(port),
        _ => None,
    };
    let outcome = watch.check(&claude, env, id, handle, entry).await;
    if let Some(port) = &watch.broker {
        port.close();
    }
    outcome
}

/// the short ids whose state file records a failed start and no removal
pub fn failed_ids(env: &Env) -> HashSet<String> {
    let Ok(names) = std::fs::read_dir(bg_dir(env)) else {
        return HashSet::new();
    };
    names
        .flatten()
        .filter_map(|name| {
            let name = name.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".state.json").filter(|id| short_id(id))?;
            let BgState(state) = read_state(env, id)?;
            let failed = matches!(state.get("failed"), Some(Json::Obj(_)));
            (failed && !BgState(state).removed()).then(|| id.to_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn a_given_free_percentage_replaces_the_probe() {
        assert_eq!(
            memory_free_pct(&env(&[("SCP_MEMORY_FREE_PCT", "4")])),
            Some(4)
        );
        assert_eq!(
            memory_free_pct(&env(&[("SCP_MEMORY_FREE_PCT", " 7.9 ")])),
            Some(7)
        );
        assert_eq!(
            memory_free_pct(&env(&[("SCP_MEMORY_FREE_PCT", "101")])),
            None
        );
        assert_eq!(
            memory_free_pct(&env(&[("SCP_MEMORY_FREE_PCT", "-1")])),
            None
        );
        assert_eq!(
            memory_free_pct(&env(&[("SCP_MEMORY_FREE_PCT", "1e1")])),
            None
        );
        assert_eq!(
            memory_hint(&env(&[("SCP_MEMORY_FREE_PCT", "4")])),
            "; free memory is at 4%, so memory pressure likely killed it"
        );
        assert_eq!(memory_hint(&env(&[("SCP_MEMORY_FREE_PCT", "20")])), "");
    }

    #[test]
    fn the_probe_reads_a_percentage() {
        assert!(memory_free_pct(&Env::new()).is_none_or(|free| free <= 100));
    }

    #[test]
    fn the_confirm_window_takes_seconds_or_a_duration() {
        assert_eq!(confirm_window_ms(&Env::new()), 5000.0);
        assert_eq!(
            confirm_window_ms(&env(&[("SCP_CLAUDE_BG_CONFIRM_S", "0")])),
            0.0
        );
        assert_eq!(
            confirm_window_ms(&env(&[("SCP_CLAUDE_BG_CONFIRM_S", "0.5")])),
            500.0
        );
        assert_eq!(
            confirm_window_ms(&env(&[("SCP_CLAUDE_BG_CONFIRM_S", "2m")])),
            120_000.0
        );
        assert_eq!(
            confirm_window_ms(&env(&[("SCP_CLAUDE_BG_CONFIRM_S", "Infinity")])),
            600_000.0
        );
        assert_eq!(
            confirm_window_ms(&env(&[("SCP_CLAUDE_BG_CONFIRM_S", "soon")])),
            5000.0
        );
    }

    #[test]
    fn signals_are_named_as_node_names_them() {
        assert_eq!(signal_name(libc::SIGKILL), "SIGKILL");
        assert_eq!(signal_name(libc::SIGSEGV), "SIGSEGV");
        assert_eq!(signal_name(200), "signal 200");
        #[cfg(target_os = "macos")]
        assert_eq!(signal_name(libc::SIGEMT), "SIGEMT");
    }
}
