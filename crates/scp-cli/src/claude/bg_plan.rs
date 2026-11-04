//! The claude-bg policy with no IO: what to do with each background session, the settings it runs on, and what the process table says.

use super::bg_state::{Agent, BgRecord, BgState, Entry, PROVIDER, Records, short_id};
use crate::fleet::json::Json;
use scp_core::protocol::CLI_NAME;
use scp_mcp::ps::Env;
use scp_mcp::tools::js_num;
use std::collections::{HashMap, HashSet};

const STOP_AFTER_S: f64 = 120.0;
const IDLE_AFTER_S: f64 = 600.0;
/// a refused `claude rm` is tried again no sooner than this
pub const RM_RETRY_MS: f64 = 86_400_000.0;

/// JavaScript's `\s`
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// `text.split(/\s+/)`
fn split_space(text: &str) -> Vec<&str> {
    let mut words = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(js_space) {
        words.push(&rest[..at]);
        rest = rest[at..].trim_start_matches(js_space);
    }
    words.push(rest);
    words
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year.rem_euclid(400);
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    era * 146_097 + of_era * 365 + of_era / 4 - of_era / 100 + of_year - 719_468
}

/// epoch milliseconds of a local time, as `new Date(...)` reads it
fn local_ms(year: i32, month: i32, day: i32, hour: i32, minute: i32, second: i32) -> f64 {
    // SAFETY: an all-zero tm is valid, and mktime only reads and normalizes the one it is given
    let time = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        tm.tm_year = year - 1900;
        tm.tm_mon = month;
        tm.tm_mday = day;
        tm.tm_hour = hour;
        tm.tm_min = minute;
        tm.tm_sec = second;
        tm.tm_isdst = -1;
        libc::mktime(&mut tm)
    };
    time as f64 * 1000.0
}

fn number(text: &str, len: usize) -> Option<i64> {
    (text.len() == len && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// `Date.parse` of an ISO 8601 time as `toISOString` writes it, also with an offset, without seconds or as a date; NaN for anything else
pub fn date_ms(text: &str) -> f64 {
    iso_ms(text).unwrap_or(f64::NAN)
}

fn iso_ms(text: &str) -> Option<f64> {
    let (date, time) = match text.split_once('T') {
        Some((date, time)) => (date, Some(time)),
        None => (text, None),
    };
    let mut parts = date.split('-');
    let year = number(parts.next()?, 4)?;
    let month = parts.next().map_or(Some(1), |part| number(part, 2))?;
    let day = parts.next().map_or(Some(1), |part| number(part, 2))?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day) as f64;
    let Some(time) = time else {
        return Some(days * 86_400_000.0);
    };
    let (clock, offset) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, Some(0.0))
    } else if let Some(at) = time.rfind(['+', '-']) {
        let (clock, zone) = time.split_at(at);
        let (hours, minutes) = zone[1..].split_once(':')?;
        let minutes = (number(hours, 2)? * 60 + number(minutes, 2)?) as f64;
        (
            clock,
            Some(if zone.starts_with('-') {
                -minutes
            } else {
                minutes
            }),
        )
    } else {
        (time, None)
    };
    let (whole, fraction) = clock.split_once('.').unwrap_or((clock, ""));
    let mut fields = whole.split(':');
    let hour = number(fields.next()?, 2)?;
    let minute = number(fields.next()?, 2)?;
    let second = fields.next().map_or(Some(0), |part| number(part, 2))?;
    if fields.next().is_some() || hour > 24 || minute > 59 || second > 59 {
        return None;
    }
    if clock.contains('.') && (fraction.is_empty() || !fraction.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let millis: f64 = format!("{fraction:0<3}")[..3].parse().ok()?;
    let seconds = hour * 3600 + minute * 60 + second;
    match offset {
        Some(minutes) => {
            Some(days * 86_400_000.0 + seconds as f64 * 1000.0 + millis - minutes * 60_000.0)
        }
        None => Some(
            local_ms(
                year as i32,
                month as i32 - 1,
                day as i32,
                hour as i32,
                minute as i32,
                second as i32,
            ) + millis,
        ),
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `Date.parse` of a `ps` `lstart` in the C locale, a local time; NaN when it names no date
fn lstart_ms(text: &str) -> f64 {
    let words: Vec<&str> = text.split(' ').filter(|word| !word.is_empty()).collect();
    let [_, month, day, time, year] = words[..] else {
        return f64::NAN;
    };
    let Some(month) = MONTHS.iter().position(|name| *name == month) else {
        return f64::NAN;
    };
    let clock: Vec<i32> = time
        .split(':')
        .filter_map(|part| part.parse().ok())
        .collect();
    match (day.parse::<i32>(), year.parse::<i32>(), &clock[..]) {
        (Ok(day), Ok(year), [hour, minute, second])
            if (1..=31).contains(&day) && *hour < 25 && *minute < 60 && *second < 60 =>
        {
            local_ms(year, month as i32, day, *hour, *minute, *second)
        }
        _ => f64::NAN,
    }
}

const DURATION_UNITS: [(&str, f64); 5] = [
    ("ms", 0.001),
    ("s", 1.0),
    ("m", 60.0),
    ("h", 3600.0),
    ("d", 86400.0),
];

fn decimal(text: &str) -> usize {
    let digits = |from: usize| text[from..].bytes().take_while(u8::is_ascii_digit).count();
    let whole = digits(0);
    if whole == 0 {
        return 0;
    }
    match text[whole..].strip_prefix('.') {
        Some(_) if digits(whole + 1) > 0 => whole + 1 + digits(whole + 1),
        _ => whole,
    }
}

/// `90s`, `30m`, `1h30m`; a bare number is seconds. Whole seconds out, at least one
pub fn parse_seconds(text: &str, flag: &str) -> Result<f64, String> {
    let trimmed = js_trim(text);
    let mut seconds = 0.0;
    if !trimmed.is_empty() && decimal(trimmed) == trimmed.len() {
        seconds = trimmed.parse().unwrap_or(f64::NAN);
    } else {
        let mut rest = trimmed;
        while !rest.is_empty() {
            let len = decimal(rest);
            let unit = DURATION_UNITS
                .iter()
                .find(|(unit, _)| len > 0 && rest[len..].starts_with(unit));
            let Some((unit, scale)) = unit else {
                seconds = f64::NAN;
                break;
            };
            seconds += rest[..len].parse::<f64>().unwrap_or(f64::NAN) * scale;
            rest = &rest[len + unit.len()..];
        }
        if trimmed.is_empty() || seconds.is_nan() {
            return Err(format!(
                "{flag} {} is not a duration like 90s, 30m or 1h30m",
                crate::args::js_string(text)
            ));
        }
    }
    if seconds.is_nan() || seconds <= 0.0 {
        return Err(format!("{flag} must be more than zero"));
    }
    Ok(seconds.ceil().max(1.0))
}

/// idle seconds from a variable: a number, a duration such as 30m, or Infinity
fn seconds_text(value: &str) -> Option<f64> {
    if value == "Infinity" {
        return Some(f64::INFINITY);
    }
    let trimmed = js_trim(value);
    if !trimmed.is_empty() && decimal(trimmed) == trimmed.len() {
        return trimmed.parse().ok();
    }
    parse_seconds(value, "stop_after_s").ok()
}

/// the same from config.json, which also holds plain numbers
fn seconds_value(value: Option<&Json>) -> Option<f64> {
    match value? {
        Json::Num(n) if *n == f64::INFINITY => Some(*n),
        Json::Num(n) => (n.is_finite() && *n >= 0.0).then_some(*n),
        Json::Str(text) => seconds_text(text),
        _ => None,
    }
}

/// when a worker leaves Claude's agents list
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveMode {
    OnStop,
    Historic,
    Never,
}

fn remove_text(value: &str) -> Option<RemoveMode> {
    match value {
        "1" | "true" | "on_stop" => Some(RemoveMode::OnStop),
        "historic" => Some(RemoveMode::Historic),
        "0" | "false" => Some(RemoveMode::Never),
        _ => None,
    }
}

fn remove_value(value: Option<&Json>) -> Option<RemoveMode> {
    match value? {
        Json::Bool(true) => Some(RemoveMode::OnStop),
        Json::Bool(false) => Some(RemoveMode::Never),
        Json::Str(text) => remove_text(text),
        _ => None,
    }
}

/// `stop_after_s`: idle seconds before a finished worker stops; `idle_after_s`: before any worker stops; `remove`: when one is removed
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BgConfig {
    pub stop_after_s: f64,
    pub idle_after_s: f64,
    pub remove: RemoveMode,
}

/// `$SCP_CLAUDE_BG_*`, else `claude_bg.*` in `file`, else 120 s and `on_stop`; idle time also falls to the shared settings, else 600 s
pub fn bg_config(env: &Env, file: &Json) -> BgConfig {
    let bg = file.get("claude_bg");
    let bg_field = |key: &str| bg.and_then(|bg| bg.get(key));
    let var = |key: &str| env.get(key).and_then(|value| seconds_text(value));
    BgConfig {
        stop_after_s: var("SCP_CLAUDE_BG_STOP_AFTER_S")
            .or_else(|| seconds_value(bg_field("stop_after_s")))
            .unwrap_or(STOP_AFTER_S),
        idle_after_s: var("SCP_CLAUDE_BG_IDLE_AFTER_S")
            .or_else(|| seconds_value(bg_field("idle_after_s")))
            .or_else(|| var("SCP_IDLE_AFTER_S"))
            .or_else(|| {
                seconds_value(
                    file.get("lifecycle")
                        .and_then(|section| section.get("idle_after_s")),
                )
            })
            .unwrap_or(IDLE_AFTER_S),
        remove: env
            .get("SCP_CLAUDE_BG_REMOVE")
            .and_then(|value| remove_text(value))
            .or_else(|| remove_value(bg_field("remove")))
            .unwrap_or(RemoveMode::OnStop),
    }
}

/// the first agent of each harness session and of each handle, and the agents by parent address
pub struct Index<'a> {
    sessions: HashMap<&'a str, &'a Agent>,
    handles: HashMap<&'a str, &'a Agent>,
    children: HashMap<&'a str, Vec<&'a Agent>>,
}

impl<'a> Index<'a> {
    pub fn new(agents: &'a [Agent]) -> Index<'a> {
        let mut index = Index {
            sessions: HashMap::new(),
            handles: HashMap::new(),
            children: HashMap::new(),
        };
        for agent in agents {
            if let Some(session) = &agent.harness_session {
                index.sessions.entry(session).or_insert(agent);
            }
            index.handles.entry(&agent.handle).or_insert(agent);
            if let Some(parent) = &agent.parent {
                index.children.entry(parent).or_default().push(agent);
            }
        }
        index
    }

    /// the endpoint of a session: the one its hooks named with its session id, else the one its record claims, unless that one runs
    /// another session; without a record only its session id names it
    pub fn endpoint_of(&self, entry: &Entry, record: Option<&BgRecord>) -> Option<&'a Agent> {
        let session = entry.session_id.as_deref().filter(|id| !id.is_empty());
        let by_session = session.and_then(|id| self.sessions.get(id).copied());
        let Some(record) = record.filter(|_| by_session.is_none()) else {
            return by_session;
        };
        let by_handle = self.handles.get(record.handle.as_deref()?).copied()?;
        (by_handle.harness_session.is_none()
            || by_handle.harness_session.as_deref() == entry.session_id.as_deref())
        .then_some(by_handle)
    }

    /// the workers under an endpoint that still run: a local child not historic and online or working, any child the broker's local
    /// agents do not list, and its in-process subagents of its current session not done
    pub fn live_children(&self, agent: &Agent) -> f64 {
        let local: &[&Agent] = self
            .children
            .get(agent.address.as_str())
            .map_or(&[], Vec::as_slice);
        let live = local
            .iter()
            .filter(|one| !one.historic && (one.presence == "online" || one.state == "working"))
            .count() as f64;
        live + (agent.children - local.len() as f64).max(0.0) + agent.subagents
    }
}

pub fn attached_to(entry: &Entry, attached: &HashSet<String>) -> bool {
    [&entry.id, &entry.name, &entry.session_id]
        .iter()
        .any(|key| key.as_ref().is_some_and(|key| attached.contains(key)))
}

/// a session in a worktree Claude Code made for it (`claude -w`): `claude rm` deletes that worktree when clean, so a wake could not resume it
fn claude_worktree(cwd: Option<&str>) -> bool {
    cwd.is_some_and(|cwd| cwd.contains("/.claude/worktrees/"))
}

/// `on_stop` waits for historic for a session `claude rm` would take its worktree from
pub fn remove_mode_of(config: &BgConfig, cwd: Option<&str>) -> RemoveMode {
    if config.remove == RemoveMode::OnStop && claude_worktree(cwd) {
        RemoveMode::Historic
    } else {
        config.remove
    }
}

fn finished(agent: &Agent) -> bool {
    agent.state == "done" || agent.handed_back
}

/// the idle seconds before the policy stops a session
fn stop_after(agent: &Agent, config: &BgConfig) -> f64 {
    if finished(agent) {
        config.stop_after_s.min(config.idle_after_s)
    } else {
        config.idle_after_s
    }
}

/// what one planning pass reads
pub struct PlanInput<'a> {
    pub entries: &'a [Entry],
    pub agents: &'a [Agent],
    pub records: &'a Records,
    pub states: &'a HashMap<String, BgState>,
    /// the sessions `claude attach` holds, by id, name or session id
    pub attached: &'a HashSet<String>,
    /// the process table, `ps -Ao pid=,ppid=,lstart=,args=`; None when unread, which keeps every live session
    pub processes: Option<&'a str>,
    pub now: f64,
    pub config: BgConfig,
    /// idle seconds that replace the configured thresholds
    pub older_than_s: Option<f64>,
    pub stop_only: bool,
    /// try a refused `claude rm` again at once
    pub retry_refused: bool,
    /// the session ids of the sessions the caller runs in, never stopped or removed
    pub own_sessions: &'a HashSet<String>,
    /// the caller's own process and its ancestors: a session whose process is one of them is never stopped or removed
    pub own_pids: &'a HashSet<i64>,
}

/// `record` is None for a session `swarm claude --bg` did not start: such a session is stopped, never removed
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub id: String,
    pub entry: Entry,
    pub agent: Agent,
    pub record: Option<BgRecord>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Stop(Target),
    Remove {
        target: Target,
        live: bool,
    },
    Unhibernate(Target),
    /// a stopped worker `swarm claude --bg` started whose endpoint is gone: nothing can wake it, so it only leaves Claude's list
    Orphan {
        id: String,
        entry: Entry,
        record: BgRecord,
    },
    Keep {
        id: String,
        agent: Option<Agent>,
        reason: String,
    },
}

impl Action {
    pub fn id(&self) -> &str {
        match self {
            Action::Stop(target) | Action::Unhibernate(target) | Action::Remove { target, .. } => {
                &target.id
            }
            Action::Orphan { id, .. } | Action::Keep { id, .. } => id,
        }
    }

    pub fn agent(&self) -> Option<&Agent> {
        match self {
            Action::Stop(target) | Action::Unhibernate(target) | Action::Remove { target, .. } => {
                Some(&target.agent)
            }
            Action::Orphan { .. } => None,
            Action::Keep { agent, .. } => agent.as_ref(),
        }
    }

    /// what the action did, once it did
    pub fn verb(&self) -> &'static str {
        match self {
            Action::Stop(_) => "stopped",
            Action::Unhibernate(_) => "woke",
            _ => "removed",
        }
    }

    /// the endpoint an action names, or what an orphan lacks
    pub fn place(&self) -> &str {
        self.agent()
            .map_or("no endpoint", |agent| agent.address.as_str())
    }
}

/// a refused `claude rm` of the session is held: tried again only after a day, or at once with `retry_refused`
fn refusal(input: &PlanInput, id: &str) -> Option<String> {
    let (at, reason) = input.states.get(id)?.rm_refused()?;
    (!input.retry_refused && input.now - at < RM_RETRY_MS).then_some(reason)
}

fn own_session(input: &PlanInput, entry: &Entry, agent: Option<&Agent>) -> bool {
    let by_session = [
        entry.session_id.as_ref(),
        agent.and_then(|agent| agent.harness_session.as_ref()),
    ]
    .into_iter()
    .flatten()
    .any(|key| input.own_sessions.contains(key));
    by_session
        || entry
            .pid
            .is_some_and(|pid| input.own_pids.contains(&(pid as i64)))
}

/// why a session `swarm claude --bg` started, whose endpoint is gone, stays in Claude's list; None when it leaves it
fn orphan_kept(input: &PlanInput, entry: &Entry, record: &BgRecord, id: &str) -> Option<String> {
    if entry.pid.is_some() {
        return Some("no endpoint".into());
    }
    if !record.parented {
        return Some("no endpoint, and it started as a root".into());
    }
    if input.stop_only || input.config.remove == RemoveMode::Never {
        return Some("no endpoint".into());
    }
    if attached_to(entry, input.attached) {
        return Some("attached".into());
    }
    if own_session(input, entry, None) {
        return Some("the caller's own session".into());
    }
    refusal(input, id).map(|reason| format!("claude rm refused: {reason}"))
}

/// `Math.max(0, Math.floor(ms / 1000))`
fn whole_seconds(ms: f64) -> f64 {
    let seconds = (ms / 1000.0).floor();
    if seconds.is_nan() {
        seconds
    } else {
        seconds.max(0.0)
    }
}

/// what to do with each background session: only a worker, an endpoint linked under a parent, with no live workers, no `claude attach`
/// and not the caller's own is ever stopped, and only while Claude shows it exactly idle. Such a worker stops after `idle_after_s`
/// without work, a finished one (done or handed back) after `stop_after_s` when sooner. A worker `swarm claude --bg` started is removed
/// as it stops (`on_stop`), or once its endpoint is historic (`historic`); a stopped one whose endpoint is gone and that asked for a
/// parent is removed too, since nothing could wake it. `older_than_s` replaces the thresholds
pub fn plan(input: &PlanInput) -> Vec<Action> {
    let index = Index::new(input.agents);
    let mut actions = Vec::new();
    for entry in input.entries {
        let Some(id) = entry
            .id
            .as_deref()
            .filter(|id| entry.background() && short_id(id))
        else {
            continue;
        };
        let keep = |reason: String, agent: Option<&Agent>| Action::Keep {
            id: id.to_owned(),
            agent: agent.cloned(),
            reason,
        };
        let record = input.records.get(id);
        let Some(agent) = index.endpoint_of(entry, record) else {
            actions.push(match record {
                None => keep("no SCP endpoint, so nothing could wake it".into(), None),
                Some(record) => match orphan_kept(input, entry, record, id) {
                    Some(reason) => keep(reason, None),
                    None => Action::Orphan {
                        id: id.to_owned(),
                        entry: entry.clone(),
                        record: record.clone(),
                    },
                },
            });
            continue;
        };
        let target = || Target {
            id: id.to_owned(),
            entry: entry.clone(),
            agent: agent.clone(),
            record: record.cloned(),
        };
        let live = entry.pid.is_some();
        if live && agent.hibernate.as_deref() == Some(PROVIDER) && agent.connections > 0.0 {
            actions.push(Action::Unhibernate(target()));
        }
        let verdict = match record {
            None => Err(format!(
                "not started by {CLI_NAME} claude --bg, so no wake ticket would take its endpoint back"
            )),
            Some(_) => decide(input, &index, entry, agent, id, live),
        };
        actions.push(match verdict {
            Err(reason) => keep(reason, Some(agent)),
            Ok(Verdict::Stop) => Action::Stop(target()),
            Ok(Verdict::Remove) => Action::Remove {
                target: target(),
                live,
            },
        });
    }
    actions
}

enum Verdict {
    Stop,
    Remove,
}

/// what the policy does with a recorded session that has an endpoint, or why it keeps it
fn decide(
    input: &PlanInput,
    index: &Index,
    entry: &Entry,
    agent: &Agent,
    id: &str,
    live: bool,
) -> Result<Verdict, String> {
    if agent.parent.as_deref().is_none_or(str::is_empty) {
        return Err("a root".into());
    }
    let running = index.live_children(agent);
    if running > 0.0 {
        let plural = if running == 1.0 { "" } else { "s" };
        return Err(format!("{} live worker{plural}", js_num(running)));
    }
    if attached_to(entry, input.attached) {
        return Err("attached".into());
    }
    if own_session(input, entry, Some(agent)) {
        return Err("the caller's own session".into());
    }
    let pid = entry.pid.unwrap_or(0.0) as i64;
    let worked = date_ms(&agent.worked_at);
    let polling = live
        && input
            .processes
            .is_some_and(|table| only_polls_inbox(table, pid, None));
    let waits = polling
        && entry.status.as_deref() == Some("busy")
        && input
            .processes
            .is_some_and(|table| only_polls_inbox(table, pid, Some(worked)));
    if live && entry.status.as_deref() != Some("idle") && !waits {
        return Err(entry.status.clone().unwrap_or_else(|| "busy".into()));
    }
    if live && let Some(commands) = commands_of(input.processes, pid) {
        return Err(commands);
    }
    if polling && agent.unread {
        return Err("polling its inbox, which has unread mail".into());
    }
    let idle_ms = input.now - worked;
    let older = input.older_than_s;
    let refused = refusal(input, id);
    let threshold = older.unwrap_or_else(|| stop_after(agent, &input.config));
    let due = !live || idle_ms >= threshold * 1000.0;
    let mode = remove_mode_of(&input.config, entry.cwd.as_deref());
    let removable = match older {
        Some(older) => idle_ms >= older * 1000.0,
        None => match mode {
            RemoveMode::OnStop => due,
            RemoveMode::Historic => agent.historic && due,
            RemoveMode::Never => false,
        },
    };
    if !input.stop_only && refused.is_none() && removable {
        return Ok(Verdict::Remove);
    }
    if !live {
        let waits = !input.stop_only
            && input.config.remove == RemoveMode::OnStop
            && mode == RemoveMode::Historic;
        return Err(match refused {
            Some(reason) => format!("claude rm refused: {reason}"),
            None if waits => "in a claude worktree until historic".into(),
            None => "stopped".into(),
        });
    }
    if !threshold.is_finite() {
        return Err(if finished(agent) {
            "stop_after_s and idle_after_s are Infinity".into()
        } else {
            "not done, and idle_after_s is Infinity".into()
        });
    }
    let reached = idle_ms >= threshold * 1000.0;
    if !reached {
        let polls = if polling { "polling its inbox, " } else { "" };
        return Err(format!(
            "{polls}idle {} s of {} s",
            js_num(whole_seconds(idle_ms)),
            js_num(threshold)
        ));
    }
    Ok(Verdict::Stop)
}

pub fn removable(state: Option<&BgState>, now: f64) -> bool {
    let removed = state.is_some_and(BgState::removed);
    let held = state
        .and_then(BgState::rm_refused)
        .is_some_and(|(at, _)| now - at < RM_RETRY_MS);
    !removed && !held
}

/// what `maybe_due` knows of one agent's session
pub struct Due<'a> {
    pub state: &'a dyn Fn() -> Option<BgState>,
    pub config: BgConfig,
    pub now: f64,
    pub recorded: bool,
    pub stopped: bool,
}

/// whether a worker may be due for a stop or a removal, read from the broker alone, so an idle broker never runs claude; only one
/// `swarm claude --bg` started (`recorded`) is ever removed, and a stopped one only while the last listing showed it stopped (`stopped`)
pub fn maybe_due(agent: &Agent, index: &Index, due: &Due) -> bool {
    let hibernated = agent.hibernate.as_deref() == Some(PROVIDER);
    if hibernated && agent.connections > 0.0 {
        return true;
    }
    if agent.parent.as_deref().is_none_or(str::is_empty) || index.live_children(agent) > 0.0 {
        return false;
    }
    let mode = due.config.remove;
    if due.recorded
        && due.stopped
        && (mode == RemoveMode::OnStop || (mode == RemoveMode::Historic && agent.historic))
    {
        return removable((due.state)().as_ref(), due.now);
    }
    if hibernated {
        return false;
    }
    due.now - date_ms(&agent.worked_at) >= stop_after(agent, &due.config) * 1000.0
}

/// the targets of `claude attach <target>` in the process table: an `attach` after a word with `claude` in its path
pub fn attach_targets(table: &str) -> HashSet<String> {
    let mut targets = HashSet::new();
    for line in table.split('\n') {
        let words = split_space(js_trim(line));
        let Some(at) = words.iter().position(|word| *word == "attach") else {
            continue;
        };
        let target = words.get(at + 1).filter(|word| !word.is_empty());
        let claude = words[..at]
            .iter()
            .any(|word| word.split('/').any(|part| part.contains("claude")));
        if let (true, true, Some(target)) = (at > 0, claude, target) {
            targets.insert((*target).to_owned());
        }
    }
    targets
}

fn js_integer(word: &str) -> Option<i64> {
    let number: f64 = word.parse().ok()?;
    (number.is_finite() && number.fract() == 0.0).then_some(number as i64)
}

/// `pid` and its ancestors in a `ps -Ao pid=,ppid=` table
pub fn ancestors_of(table: &str, pid: i64) -> HashSet<i64> {
    let mut parents = HashMap::new();
    for line in table.split('\n') {
        let words = split_space(js_trim(line));
        if let [child, parent, ..] = words[..]
            && let (Some(child), Some(parent)) = (js_integer(child), js_integer(parent))
        {
            parents.insert(child, parent);
        }
    }
    let mut chain = HashSet::new();
    let mut at = Some(pid);
    while let Some(one) = at.filter(|one| *one > 1 && !chain.contains(one)) {
        chain.insert(one);
        at = parents.get(&one).copied();
    }
    chain
}

/// a Bash tool shell of Claude Code: it sources a shell snapshot, or without one ends by writing its cwd, and lives until its command exits
fn bash_tool_shell(args: &str) -> bool {
    if args.contains("/shell-snapshots/snapshot-") {
        return true;
    }
    args.match_indices(" && pwd -P >| ").any(|(at, tail)| {
        let path = &args[at + tail.len()..];
        let Some(head) = path.strip_suffix("-cwd") else {
            return false;
        };
        let hex = head
            .bytes()
            .rev()
            .take_while(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
            .count();
        !path.contains(js_space) && hex > 0 && head[..head.len() - hex].ends_with("/claude-")
    })
}

const SHELLS: [&str; 4] = ["sh", "bash", "zsh", "dash"];
/// the commands an inbox poll loop may run besides the inbox wait itself
const POLL_WORDS: [&str; 22] = [
    "while", "until", "do", "done", "if", "then", "else", "elif", "fi", "true", "false", ":",
    "break", "continue", "exit", "echo", "printf", "test", "[", "[[", "sleep", "seq",
];
const LEAD_WORDS: [&str; 8] = ["do", "then", "else", "elif", "while", "until", "if", "!"];

/// the filters a poll loop may pipe into, each with the operands it takes besides files: a pattern, a jq filter, two sets
fn pipe_operands(word: &str) -> Option<usize> {
    match word {
        "grep" | "jq" => Some(1),
        "tr" => Some(2),
        "head" | "tail" | "wc" | "cut" => Some(0),
        _ => None,
    }
}

/// the file tests of `test`, `[` and `[[`: a loop on one watches the filesystem, not mail
fn file_test(word: &str) -> bool {
    let Some(flag) = word.strip_prefix('-') else {
        return false;
    };
    matches!(flag, "nt" | "ot" | "ef")
        || (flag.len() == 1 && "abcdefghkprstuwxGLNOS".contains(flag))
}

fn base(word: Option<&str>) -> &str {
    word.map_or("", |word| {
        let word = word.strip_prefix('\\').unwrap_or(word);
        word.rsplit('/').next().unwrap_or(word)
    })
}

/// `swarm inbox ... --wait`, also through node or bun and the CLI's `cli.js`, or under `timeout <duration>`
fn inbox_wait<S: AsRef<str>>(words: &[S]) -> bool {
    let word = |at: usize| words.get(at).map(AsRef::as_ref);
    let from = if base(word(0)) == "timeout" { 2 } else { 0 };
    let at = from + usize::from(matches!(base(word(from)), "node" | "bun"));
    let cli = base(word(at));
    (cli == CLI_NAME || cli == "cli.js")
        && word(at + 1) == Some("inbox")
        && words.iter().skip(at + 2).any(|word| {
            let word = word.as_ref();
            word == "--wait" || word.starts_with("--wait=")
        })
}

const QUOTE_ESCAPE: &str = "'\"'\"'";

/// the text of the first `eval '...'`, its escaped quotes read back; a run that never closes ends at its last escape
fn eval_body(args: &str) -> Option<String> {
    let bytes = args.as_bytes();
    let wordy = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    for (at, opening) in args.match_indices("eval '") {
        if at > 0 && wordy(bytes[at - 1]) {
            continue;
        }
        let start = at + opening.len();
        let mut from = start;
        let mut last_escape = None;
        let end = loop {
            match args[from..].find('\'') {
                None => break last_escape,
                Some(found) if args[from + found..].starts_with(QUOTE_ESCAPE) => {
                    last_escape = Some(from + found);
                    from += found + QUOTE_ESCAPE.len();
                }
                Some(found) => break Some(from + found),
            }
        };
        if let Some(end) = end {
            return Some(args[start..end].replace(QUOTE_ESCAPE, "'"));
        }
    }
    None
}

/// whether `raw` reads a file with `<`, a heredoc, process substitution or `/dev/null` aside
fn reads_file(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    raw.match_indices('<').any(|(at, _)| {
        if at > 0 && bytes[at - 1] == b'<' {
            return false;
        }
        let rest = raw[at + 1..].trim_start_matches(js_space);
        let null = rest.strip_prefix("/dev/null").is_some_and(|after| {
            !after
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
        });
        !null && rest.chars().next().is_some_and(|c| c != '<' && c != '(')
    })
}

/// `raw` with each redirection and its target turned into a space
fn strip_redirects(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let target_end = |c: char| js_space(c) || ";&|()<>".contains(c);
    let mut text = String::new();
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        let mut end = at;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == bytes.len() || !matches!(bytes[end], b'<' | b'>') {
            at = end.max(at + 1);
            continue;
        }
        text.push_str(&raw[copied..at]);
        text.push(' ');
        while end < bytes.len() && matches!(bytes[end], b'<' | b'>') {
            end += 1;
        }
        if end < bytes.len() && matches!(bytes[end], b'|' | b'&') {
            end += 1;
        }
        let rest = raw[end..].trim_start_matches(js_space);
        let target = rest.find(target_end).unwrap_or(rest.len());
        at = raw.len() - rest.len() + target;
        copied = at;
    }
    text.push_str(&raw[copied..]);
    text
}

/// the simple commands of `text`, each with the separator before it
fn commands(text: &str) -> Vec<(Option<&str>, &str)> {
    let bytes = text.as_bytes();
    let mut parts = Vec::new();
    let mut before = None;
    let mut start = 0;
    let mut at = 0;
    while at < bytes.len() {
        let rest = &bytes[at..];
        let len = if [b"||", b"&&", b"$("]
            .iter()
            .any(|two| rest.starts_with(*two))
        {
            2
        } else if matches!(
            bytes[at],
            b';' | b'|' | b'&' | b'\n' | b'(' | b')' | b'`' | b'{' | b'}'
        ) {
            1
        } else {
            at += 1;
            continue;
        };
        parts.push((before, &text[start..at]));
        before = Some(&text[at..at + len]);
        at += len;
        start = at;
    }
    parts.push((before, &text[start..]));
    parts
}

/// the words of a simple command, quotes kept; an unclosed quote separates words
fn shell_words(text: &str) -> Vec<&str> {
    let mut words = Vec::new();
    let mut at = 0;
    while at < text.len() {
        let start = at;
        while let Some(c) = text[at..].chars().next() {
            if js_space(c) {
                break;
            }
            if c == '"' || c == '\'' {
                match text[at + 1..].find(c) {
                    Some(close) => at += close + 2,
                    None => break,
                }
            } else {
                at += c.len_utf8();
            }
        }
        if at > start {
            words.push(&text[start..at]);
        } else {
            at += text[at..].chars().next().map_or(1, char::len_utf8);
        }
    }
    words
}

fn assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_alphabetic() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

/// whether a Bash tool command polls the inbox and does nothing else: each simple command in the text it evaluates is an inbox wait, a
/// shell keyword, test, echo or sleep, or a text filter on a pipe with no file operand. Anything else, a script, a file read or a `gh`
/// call, watches more than mail
pub fn polls_inbox(args: &str) -> bool {
    let raw = eval_body(args).unwrap_or_else(|| args.to_owned());
    if reads_file(&raw) {
        return false;
    }
    let text = strip_redirects(&raw);
    let mut waits = 0;
    for (before, part) in commands(&text) {
        let all = shell_words(part);
        let lead = all
            .iter()
            .take_while(|word| assignment(word) || LEAD_WORDS.contains(word))
            .count();
        let words = &all[lead..];
        let Some(first) = words.first().copied().filter(|word| *word != "for") else {
            continue;
        };
        if inbox_wait(words) {
            waits += 1;
        } else if let Some(operands) = pipe_operands(first) {
            let plain = |word: &&&str| {
                !word.starts_with('-')
                    && !(!word.is_empty() && word.bytes().all(|b| b.is_ascii_digit()))
            };
            if before != Some("|") || words[1..].iter().filter(plain).count() > operands {
                return false;
            }
        } else if !POLL_WORDS.contains(&first)
            || (matches!(first, "test" | "[" | "[[") && words.iter().any(|word| file_test(word)))
        {
            return false;
        }
    }
    waits > 0
}

struct Proc {
    pid: i64,
    args: String,
    started: Option<f64>,
}

fn digits_at(text: &str) -> Option<(i64, &str)> {
    let len = text.bytes().take_while(u8::is_ascii_digit).count();
    (len > 0).then(|| {
        let value: f64 = text[..len].parse().unwrap_or(f64::MAX);
        (value as i64, &text[len..])
    })
}

fn spaces_at(text: &str) -> Option<&str> {
    let rest = text.trim_start_matches(js_space);
    (rest.len() < text.len()).then_some(rest)
}

/// a C locale `lstart` at the start of `text` and what follows its spaces
fn lstart_at(text: &str) -> Option<(&str, &str)> {
    let bytes = text.as_bytes();
    let name = |at: usize| {
        bytes.get(at).is_some_and(u8::is_ascii_uppercase)
            && bytes[at + 1..].len() >= 2
            && bytes[at + 1..at + 3].iter().all(u8::is_ascii_lowercase)
    };
    if !(name(0) && bytes.get(3) == Some(&b' ') && name(4) && bytes.get(7) == Some(&b' ')) {
        return None;
    }
    let mut at = 8;
    while bytes.get(at) == Some(&b' ') {
        at += 1;
    }
    let day = bytes[at..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count();
    if !(1..=2).contains(&day) {
        return None;
    }
    at += day;
    let shape = b" dd:dd:dd dddd";
    let fits = shape.iter().enumerate().all(|(i, want)| match want {
        b'd' => bytes.get(at + i).is_some_and(u8::is_ascii_digit),
        want => bytes.get(at + i) == Some(want),
    });
    if !fits {
        return None;
    }
    at += shape.len();
    let rest = spaces_at(&text[at..])?;
    Some((&text[..at], rest))
}

/// a `ps` row: pid, ppid, then optionally its C locale `lstart`, then its arguments
fn ps_row(line: &str) -> Option<(i64, i64, Option<&str>, &str)> {
    let (pid, rest) = digits_at(line.trim_start_matches(js_space))?;
    let (parent, rest) = digits_at(spaces_at(rest)?)?;
    let rest = spaces_at(rest)?;
    let (started, args) = match lstart_at(rest) {
        Some((started, args)) => (Some(started), args),
        None => (None, rest),
    };
    (!args.contains(['\r', '\u{2028}', '\u{2029}'])).then_some((pid, parent, started, args))
}

struct CommandShell {
    shell: Proc,
    under: Vec<Proc>,
}

/// the Bash tool shells under `pid` in a `ps -Ao pid=,ppid=,lstart=,args=` table, each with the processes under it
fn command_shells(table: &str, pid: i64) -> Vec<CommandShell> {
    type Row<'a> = (i64, &'a str, Option<f64>);
    let mut children: HashMap<i64, Vec<Row>> = HashMap::new();
    for line in table.split('\n') {
        if let Some((pid, parent, started, args)) = ps_row(line) {
            let started = started.map(lstart_ms).filter(|ms| !ms.is_nan());
            children
                .entry(parent)
                .or_default()
                .push((pid, args, started));
        }
    }
    let owned = |(pid, args, started): Row| Proc {
        pid,
        args: args.to_owned(),
        started,
    };
    let below = |root: i64| {
        let mut found = Vec::new();
        let mut queue = vec![root];
        let mut seen = HashSet::from([root]);
        while let Some(at) = queue.pop() {
            for child in children.get(&at).into_iter().flatten() {
                if seen.insert(child.0) {
                    found.push(owned(*child));
                    queue.push(child.0);
                }
            }
        }
        found
    };
    let mut shells = Vec::new();
    let mut queue = vec![pid];
    let mut seen = HashSet::from([pid]);
    while let Some(at) = queue.pop() {
        for child in children.get(&at).into_iter().flatten() {
            if !seen.insert(child.0) {
                continue;
            }
            if bash_tool_shell(child.1) {
                let shell = owned(*child);
                let under = below(shell.pid);
                shells.push(CommandShell { shell, under });
            } else {
                queue.push(child.0);
            }
        }
    }
    shells
}

/// whether a command Claude Code's Bash tool started still runs under `pid`; MCP servers, hooks and other helpers do not count
pub fn runs_command(table: &str, pid: i64) -> bool {
    !command_shells(table, pid).is_empty()
}

fn proc_waits(one: &Proc) -> bool {
    inbox_wait(&split_space(js_trim(&one.args)))
}

/// whether every command running under `pid` is an inbox poll loop that waits on the inbox right now: under its shell runs a
/// `swarm inbox --wait` and nothing but that and subshells of the same command. False with no command at all. With `after`, one of them
/// also started at or after it: a loop the turn started after the session's last hook, so the turn waits on it rather than on a model
/// that runs beside a `run_in_background` loop, whose launch fires a hook after the loop starts
pub fn only_polls_inbox(table: &str, pid: i64, after: Option<f64>) -> bool {
    let shells = command_shells(table, pid);
    let started = after.is_none_or(|after| {
        shells
            .iter()
            .any(|one| one.shell.started.is_some_and(|at| at >= after))
    });
    !shells.is_empty()
        && started
        && shells.iter().all(|CommandShell { shell, under }| {
            polls_inbox(&shell.args)
                && under.iter().any(proc_waits)
                && under.iter().all(|one| {
                    let first = split_space(&one.args).first().copied();
                    proc_waits(one) || (SHELLS.contains(&base(first)) && one.args == shell.args)
                })
        })
}

/// why the process tree keeps a live session: a command still runs under it, or the table is unread; None also while it only polls its inbox
pub fn commands_of(table: Option<&str>, pid: i64) -> Option<String> {
    let Some(table) = table else {
        return Some("ps failed, so running commands are unknown".into());
    };
    (runs_command(table, pid) && !only_polls_inbox(table, pid, None))
        .then(|| "running a background command".to_owned())
}
