use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

use scp_core::protocol::ErrorCode;
use serde_json::{Map, Value, json};
use tokio::sync::OwnedMutexGuard;
use tokio::time::Instant;

use super::{HookOf, flag, js_whitespace, seq_list, sv, utf16_cut, wrap_message};
use crate::claims::{hash, valid_token};
use crate::core::{Core, SharedCore, integer, now_ms, text};
use crate::proto::RpcError;
use crate::scrub::{after_cut_key, redact_secrets, strip_control};
use crate::state::{ConnectionId, Mode};
use crate::store::{Row, SqlValue};
use crate::views::{address, not_found, presence};

/// how often a waiting stop rechecks its workers, since a worker's exit or lapse wakes no one
const STOP_RECHECK: Duration = Duration::from_millis(1000);
const SYSTEM_HANDLE: &str = "_relay";
const SPAWN_PROVIDER: &str = "spawn";
const HANDBACK_CUT: &str = "[earlier output cut]";
const STEER_CLIP: usize = 120;

/// an endpoint's live spawned workers, those not joined yet, and the paced and unjoined ones
#[derive(Debug, Default)]
pub struct LiveWorkers {
    pub workers: Vec<Row>,
    pub starting: i64,
    pub paced: Vec<String>,
    pub unjoined: Vec<String>,
}

/// whether a message wakes the endpoint anyway, so a stop need not wait
pub fn wakes(row: &Row) -> bool {
    text(row, "wake").is_some_and(|wake| wake != "none")
}

fn len(result: &Value, key: &str) -> i64 {
    result[key].as_array().map_or(0, |list| list.len() as i64)
}

fn num(result: &Value, key: &str) -> i64 {
    result[key].as_i64().unwrap_or(0)
}

fn set(result: &Value, key: &str) -> bool {
    result[key] == json!(true)
}

/// a stop with nothing to show yet while workers run and the push budget lasts
fn idle(result: &Value) -> bool {
    len(result, "messages") == 0
        && num(result, "more") == 0
        && len(result, "workers") + num(result, "starting") > 0
        && num(result, "pushes_left") > 0
        && !set(result, "prompted")
        && !set(result, "wakeable")
}

fn worker_results(result: &Value) -> i64 {
    len(result, "messages") - num(result, "others_shown") + num(result, "more")
}

/// the workers still running that sent none of the messages a push would show, and those not joined yet
fn others_running(result: &Value) -> i64 {
    let shown = (len(result, "messages") - num(result, "others_shown")).max(0) as usize;
    let senders: HashSet<&str> = result["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .take(shown)
        .filter_map(|m| m["from"]["address"].as_str())
        .collect();
    let running = result["workers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| !a.as_str().is_some_and(|a| senders.contains(a)))
        .count() as i64;
    running + num(result, "starting")
}

fn gathering(result: &Value) -> bool {
    worker_results(result) > 0
        && num(result, "more") == 0
        && !set(result, "prompted")
        && !set(result, "wakeable")
        && others_running(result) > 0
}

fn wait_seconds(value: Option<&Value>, max: i64) -> Result<Duration, RpcError> {
    let Some(value) = value else {
        return Ok(Duration::ZERO);
    };
    let seconds = value
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .ok_or_else(|| RpcError::invalid_params("wait_s must be a number of seconds"))?;
    Ok(Duration::from_secs_f64(seconds.min(max as f64)))
}

/// the pid of a full harness-instance key
fn key_pid(key: Option<&str>) -> Option<u32> {
    let (pid, _) = key?.strip_prefix("pid:")?.split_once(':')?;
    pid.bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| pid.parse().ok())
        .flatten()
        .filter(|pid| *pid > 0)
}

fn base36(mut value: u64) -> String {
    let mut out = Vec::new();
    while value > 0 {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize]);
        value /= 36;
    }
    if out.is_empty() {
        out.push(b'0');
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn msg_id(now: i64) -> String {
    format!(
        "msg_{:0>9}{:016x}",
        base36(now.max(0) as u64),
        rand::random::<u64>()
    )
}

fn short_id(id: &str) -> &str {
    let mut at = id.len().saturating_sub(6);
    while !id.is_char_boundary(at) {
        at += 1;
    }
    &id[at..]
}

/// local wall time as HH:MM:SS
fn clock(at: i64) -> String {
    let secs = at.div_euclid(1000) as libc::time_t;
    // SAFETY: a zeroed tm is valid and localtime_r only writes into it.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the call.
    if unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
        return at.to_string();
    }
    format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
}

fn held_line(address: &str, durable: bool) -> String {
    if durable {
        format!("{address} stays resumable: message it to resume its session")
    } else {
        format!(
            "{address} stays resumable until its spawn's idle time runs out: message it before then to resume its session"
        )
    }
}

/// text's last `bytes` bytes, from a line start behind the cut mark when anything was dropped
pub fn keep_last(text: &str, bytes: i64, dropped: bool) -> String {
    let encoded = text.as_bytes();
    let n = encoded.len() as i64;
    if text.is_empty() || (!dropped && n <= bytes) {
        return text.to_owned();
    }
    let mark = if bytes > HANDBACK_CUT.len() as i64 + 1 {
        format!("{HANDBACK_CUT}\n")
    } else {
        String::new()
    };
    let reach = bytes - mark.len() as i64;
    let mut start = (n - reach).max(0);
    let at = |i: i64| encoded[i as usize];
    let nl = if start > 0 && start <= n && at(start - 1) != b'\n' {
        encoded[(start as usize).min(encoded.len())..]
            .iter()
            .position(|b| *b == b'\n')
            .map_or(-1, |p| start + p as i64)
    } else {
        -1
    };
    let line_start = if start > 0 {
        encoded[..(start as usize).min(encoded.len())]
            .iter()
            .rposition(|b| *b == b'\n')
            .map_or(0, |p| p as i64 + 1)
    } else {
        0
    };
    let long = nl != -1 && nl - line_start > reach && ((n - (nl + 1)) as f64) < reach as f64 / 2.0;
    if nl != -1 && nl + 1 < n && !long {
        start = nl + 1;
    }
    while start > 0 && start < n - 1 && at(start) == b'\n' {
        start += 1;
    }
    while start < n && at(start) & 0xc0 == 0x80 {
        start += 1;
    }
    let start = start.min(n) as usize;
    format!("{mark}{}", String::from_utf8_lossy(&encoded[start..]))
}

/// a harness's last output as a handback carries it: escapes and control characters out, carriage returns applied, secrets redacted, its last `bytes`
pub fn handback_output(text: &str, cut: bool, bytes: i64) -> String {
    static ESCAPES: OnceLock<regex::Regex> = OnceLock::new();
    let escapes = ESCAPES.get_or_init(|| {
        regex::Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_][^\x1b]*(?:\x1b\\)?|(?:\x1b\[|\x{9b})[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]")
            .expect("constant escape pattern")
    });
    let whole = match text.split_once('\n') {
        Some((_, rest)) if cut => rest,
        _ => text,
    };
    let lines = escapes
        .replace_all(whole, "")
        .split('\n')
        .map(|line| {
            let shown = line.trim_end_matches('\r');
            shown.rsplit('\r').next().unwrap_or("").to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n");
    let shown = strip_control(&lines);
    let rest = after_cut_key(&shown);
    let redacted = redact_secrets(rest.unwrap_or(&shown));
    keep_last(
        redacted.trim_matches(js_whitespace),
        bytes,
        cut || rest.is_some(),
    )
}

/// a number as JavaScript prints it
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// waits on the endpoint's waiter until `until` without the core lock; None once the connection closed
async fn wait_unlocked(
    shared: &SharedCore,
    mut guard: OwnedMutexGuard<Core>,
    conn: ConnectionId,
    until: Instant,
) -> Result<Option<OwnedMutexGuard<Core>>, RpcError> {
    let connection = guard.connection(conn)?;
    let endpoint = connection
        .endpoint
        .clone()
        .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "call hello first"))?;
    let closed = connection.closed.clone();
    let waiter = guard.state.waiter(&endpoint);
    let notified = waiter.notified();
    let disconnected = closed.notified();
    tokio::pin!(notified, disconnected);
    notified.as_mut().enable();
    disconnected.as_mut().enable();
    drop(guard);
    let open = tokio::select! {
        _ = &mut notified => true,
        _ = &mut disconnected => false,
        _ = tokio::time::sleep_until(until) => true,
    };
    if !open {
        return Ok(None);
    }
    let guard = shared.clone().lock_owned().await;
    Ok(guard.state.connections.contains_key(&conn).then_some(guard))
}

struct Exit<'a> {
    code: i64,
    output: &'a str,
    taken: &'a [String],
    lost: i64,
    exits: &'a [i64],
    stderr: &'a str,
}

impl Core {
    pub(crate) async fn live_workers(
        &self,
        me: &Row,
        now: i64,
        no_push: bool,
    ) -> Result<LiveWorkers, RpcError> {
        let id = text(me, "id").unwrap_or("");
        let pushes = if no_push { "NOT NULL" } else { "NULL" };
        let grants = self.store.all(&format!("SELECT token_hash, used_by, bound_process, pushed_at, handback, name FROM grants WHERE issuer = ? AND spawn = 1 AND no_push IS {pushes} AND revoked_at IS NULL AND created_at >= ? AND (used_by IS NOT NULL OR expires_at > ?) ORDER BY created_at"), &[sv(id), SqlValue::Int(integer(me, "spawned_at").unwrap_or(0)), SqlValue::Int(now)]).await?;
        let mut out = LiveWorkers::default();
        let gap = self.cap("pushGapS", 30) * 1000;
        for grant in grants {
            let bound = text(&grant, "bound_process");
            let pid = key_pid(bound);
            let running = async |key: Option<&str>| match key {
                Some(key) => self.procs.alive(key).await,
                None => true,
            };
            let Some(used_by) = text(&grant, "used_by") else {
                if let Some(pid) = pid
                    && !self.procs.alive(&format!("pid:{pid}")).await
                {
                    self.store.all("UPDATE grants SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL AND used_by IS NULL", &[SqlValue::Int(now), sv(text(&grant, "token_hash").unwrap_or(""))]).await?;
                } else if pid.is_none() || running(bound).await {
                    out.unjoined
                        .push(text(&grant, "name").unwrap_or("").to_owned());
                }
                continue;
            };
            let Some(row) = self.by_id(used_by).await? else {
                continue;
            };
            if text(&row, "status_state") == Some("done") {
                continue;
            }
            let lapsed = integer(&row, "connections").unwrap_or(0) == 0
                && text(&row, "process").is_some()
                && !running(text(&row, "process")).await;
            let harness = presence(&row, now) != "offline" && !lapsed;
            if !harness
                && (text(&grant, "handback").is_some() || pid.is_none() || !running(bound).await)
            {
                continue;
            }
            if integer(&grant, "pushed_at").is_some_and(|at| at > now - gap)
                && !out.paced.iter().any(|p| p == used_by)
            {
                out.paced.push(used_by.to_owned());
            }
            match out
                .workers
                .iter_mut()
                .find(|w| text(w, "id") == Some(used_by))
            {
                Some(slot) => *slot = row,
                None => out.workers.push(row),
            }
        }
        out.starting = out.unjoined.len() as i64;
        Ok(out)
    }

    /// unread deliveries to `me` from the endpoints that spent its push spawn grants and the relay's `worker ` handbacks; `fresh`: none shown or held
    async fn worker_messages(
        &self,
        me: &Row,
        now: i64,
        fresh: bool,
        paced: &[String],
    ) -> Result<(String, Vec<SqlValue>), RpcError> {
        let system = self
            .by_handle(SYSTEM_HANDLE)
            .await?
            .and_then(|row| text(&row, "id").map(str::to_owned))
            .unwrap_or_default();
        let fresh_sql = if fresh {
            "AND d.injected_at IS NULL AND (d.offered_until IS NULL OR d.offered_until <= ?)"
        } else {
            ""
        };
        let paced_sql = if paced.is_empty() {
            String::new()
        } else {
            format!(
                "AND m.from_ep NOT IN ({})",
                vec!["?"; paced.len()].join(", ")
            )
        };
        let clause = format!(
            "FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ? {fresh_sql} {paced_sql} AND (EXISTS (SELECT 1 FROM grants g WHERE g.issuer = d.endpoint AND g.spawn = 1 AND g.no_push IS NULL AND g.used_by = m.from_ep AND g.created_at >= ? AND m.created_at >= g.created_at AND (g.revoked_at IS NULL OR m.created_at <= g.revoked_at)) OR (m.from_ep = ? AND m.kind = 'message' AND m.body LIKE 'worker %' AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.handback = m.id AND g.no_push = 1)))"
        );
        let mut params = vec![sv(text(me, "id").unwrap_or("")), SqlValue::Int(now)];
        if fresh {
            params.push(SqlValue::Int(now));
        }
        params.extend(paced.iter().map(sv));
        params.push(SqlValue::Int(integer(me, "spawned_at").unwrap_or(0)));
        params.push(sv(system));
        Ok((clause, params))
    }

    pub(crate) async fn worker_unread(
        &self,
        me: &Row,
        now: i64,
        fresh: bool,
    ) -> Result<i64, RpcError> {
        let (clause, params) = self.worker_messages(me, now, fresh, &[]).await?;
        self.count(&format!("SELECT COUNT(*) AS n {clause}"), &params)
            .await
    }

    pub(crate) fn pushes_left(&self, me: &Row) -> i64 {
        (self.cap("pushes", 20) - integer(me, "pushes").unwrap_or(0)).max(0)
    }

    /// the seqs of the worker messages a stop's push would show
    pub(crate) async fn pushable(&self, me: &Row, now: i64) -> Result<HashSet<i64>, RpcError> {
        let (clause, params) = self.worker_messages(me, now, true, &[]).await?;
        Ok(self
            .store
            .all(&format!("SELECT d.seq AS seq {clause}"), &params)
            .await?
            .iter()
            .filter_map(|row| integer(row, "seq"))
            .collect())
    }

    /// the other unread messages no hook has shown or holds a push shows after its workers': newest first within the cap, in seq order
    async fn push_others(
        &self,
        me: &Row,
        now: i64,
        bytes: i64,
    ) -> Result<(Vec<Row>, Vec<Value>), RpcError> {
        let workers = self.pushable(me, now).await?;
        let id = text(me, "id").unwrap_or("");
        let rows = self.store.all("SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ? AND d.injected_at IS NULL AND (d.offered_until IS NULL OR d.offered_until <= ?) ORDER BY d.seq DESC LIMIT ?", &[sv(id), SqlValue::Int(now), SqlValue::Int(now), SqlValue::Int(self.cap("inboxPage", 100))]).await?;
        let cap = self.cap("injectMessages", 5) as usize;
        let mut picked = Vec::new();
        let mut left = bytes;
        for row in rows {
            if picked.len() >= cap {
                break;
            }
            if integer(&row, "seq").is_some_and(|seq| workers.contains(&seq)) {
                continue;
            }
            let envelope = self.message_envelope(&row, id).await?;
            let size = wrap_message(&envelope).len() as i64;
            if size > left {
                continue;
            }
            left -= size;
            picked.push((row, envelope));
        }
        picked.reverse();
        Ok(picked.into_iter().unzip())
    }

    /// a hook printed a push that continued the stop: it counts toward the pushes since the last prompt, and the workers it showed are paced
    pub(crate) async fn pushed(
        &mut self,
        endpoint: &str,
        read: Option<&Value>,
        hook: &HookOf,
    ) -> Result<bool, RpcError> {
        let me = self.must_endpoint(endpoint).await?;
        if !self.holds(&me, hook).await? {
            return Ok(false);
        }
        let counted = !self.store.all("UPDATE endpoints SET pushes = COALESCE(pushes, 0) + 1 WHERE id = ? AND COALESCE(pushes, 0) < ? RETURNING id", &[sv(endpoint), SqlValue::Int(self.cap("pushes", 20))]).await?.is_empty();
        let now = now_ms();
        let seqs = match read {
            Some(read) => seq_list(Some(read), self.cap("inboxPage", 100)).unwrap_or_default(),
            None => Vec::new(),
        };
        for seq in seqs {
            self.store.all("UPDATE grants SET pushed_at = ? WHERE issuer = ? AND spawn = 1 AND used_by = (SELECT m.from_ep FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.seq = ? AND d.endpoint = ?)", &[SqlValue::Int(now), sv(endpoint), SqlValue::Int(seq), sv(endpoint)]).await?;
        }
        Ok(counted)
    }

    /// a stop waiting on spawned workers: their unread messages and the relay's handbacks within pushBytes, then other unread ones; `peek` holds nothing
    pub async fn stop_wait(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
        peek: bool,
    ) -> Result<Value, RpcError> {
        let (endpoint, hook) = self.hook_of(conn)?;
        let endpoint = endpoint.as_str();
        let now = now_ms();
        let me = self.must_endpoint(endpoint).await?;
        if !self.holds(&me, &hook).await? {
            return Ok(
                json!({"messages":[],"offered":[],"hold":null,"more":0,"workers":[],"starting":0,"others":0,"pushes_left":0}),
            );
        }
        let live = self.live_workers(&me, now, false).await?;
        let quiet = self.live_workers(&me, now, true).await?;
        let mut background: Vec<String> = quiet.workers.iter().map(address).collect();
        background.extend(
            quiet
                .unjoined
                .iter()
                .filter(|name| !name.is_empty())
                .map(|name| format!("me/{name}")),
        );
        let left = self.pushes_left(&me);
        let (clause, args) = self.worker_messages(&me, now, true, &live.paced).await?;
        let (rows, waiting) = if left > 0 {
            let mut page = args.clone();
            page.push(SqlValue::Int(self.cap("inboxPage", 100)));
            let rows = self
                .store
                .all(
                    &format!("SELECT m.*, d.seq AS seq {clause} ORDER BY d.seq LIMIT ?"),
                    &page,
                )
                .await?;
            let waiting = self
                .count(&format!("SELECT COUNT(*) AS n {clause}"), &args)
                .await?;
            (rows, waiting)
        } else {
            (Vec::new(), 0)
        };
        let unread = self.count("SELECT COUNT(*) AS n FROM deliveries d WHERE d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ?", &[sv(endpoint), SqlValue::Int(now)]).await?;
        let push_bytes = self.cap("pushBytes", 20480);
        let (mut shown, mut envelopes, mut offered) =
            self.budget(&rows, endpoint, push_bytes, None).await?;
        let shown_workers = shown.len() as i64;
        let used: i64 = envelopes.iter().map(|e| wrap_message(e).len() as i64).sum();
        let (others, other_envelopes) = if rows.is_empty() {
            (Vec::new(), Vec::new())
        } else {
            self.push_others(&me, now, push_bytes - used).await?
        };
        offered.extend(others.iter().filter_map(|row| integer(row, "seq")));
        shown.extend(others.iter().cloned());
        envelopes.extend(other_envelopes);
        let hold = if peek {
            None
        } else {
            self.hold_seqs(&offered, now, None).await?
        };
        if !peek {
            self.received(endpoint, &shown, now).await?;
        }
        let from_workers = self.worker_unread(&me, now, false).await?;
        let mut out = json!({
            "messages": envelopes, "offered": offered, "hold": hold, "more": waiting - shown_workers,
            "workers": live.workers.iter().map(address).collect::<Vec<_>>(), "starting": live.starting,
            "others": unread - from_workers - others.len() as i64, "pushes_left": left,
        });
        let object = out.as_object_mut().ok_or_else(RpcError::internal)?;
        if !background.is_empty() {
            object.insert("background".into(), json!(background));
        }
        if !others.is_empty() {
            object.insert("others_shown".into(), json!(others.len()));
        }
        if let Some(mark) = params.get("prompts").and_then(Value::as_f64)
            && mark != integer(&me, "prompts").unwrap_or(0) as f64
        {
            object.insert("prompted".into(), json!(true));
        }
        if wakes(&me) {
            object.insert("wakeable".into(), json!(true));
        }
        if integer(&me, "briefed").is_some_and(|v| v != 0) {
            object.insert("brief".into(), json!(true));
        }
        Ok(out)
    }

    /// the method checks dispatch runs for stop_wait
    async fn stop_wait_allowed(&self, conn: ConnectionId) -> Result<(), RpcError> {
        let connection = self.connection(conn)?;
        if !connection.bound() {
            return Err(RpcError::new(ErrorCode::Unauthorized, "call hello first"));
        }
        if connection.mode == Mode::Observer {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "this connection only observes",
            ));
        }
        if let Some(endpoint) = &connection.endpoint {
            self.touch(endpoint).await?;
        }
        Ok(())
    }

    /// stop_wait with its wait held outside the core lock: peeks while idle, gathers workers finishing together, then holds what it shows
    pub async fn stop_wait_poll(
        shared: SharedCore,
        mut guard: OwnedMutexGuard<Self>,
        conn: ConnectionId,
        params: Map<String, Value>,
    ) -> Result<Value, RpcError> {
        guard.stop_wait_allowed(conn).await?;
        let wait = wait_seconds(params.get("wait_s"), guard.cap("waitMaxS", 50))?;
        let deadline = Instant::now() + wait;
        let mut result = guard.stop_wait(conn, &params, true).await?;
        while idle(&result) && Instant::now() < deadline {
            let until = deadline.min(Instant::now() + STOP_RECHECK);
            let Some(next) = wait_unlocked(&shared, guard, conn, until).await? else {
                return Ok(result);
            };
            guard = next;
            result = guard.stop_wait(conn, &params, true).await?;
        }
        if !wait.is_zero() {
            let quiet_for = Duration::from_secs(guard.cap("pushQuietS", 3) as u64);
            let cap = Instant::now() + Duration::from_secs(guard.cap("pushGraceS", 6) as u64);
            let mut quiet = Instant::now() + quiet_for;
            let mut results = worker_results(&result);
            while gathering(&result) && Instant::now() < quiet.min(cap) {
                let Some(next) = wait_unlocked(&shared, guard, conn, quiet.min(cap)).await? else {
                    return Ok(result);
                };
                guard = next;
                result = guard.stop_wait(conn, &params, true).await?;
                if worker_results(&result) > results {
                    results = worker_results(&result);
                    quiet = Instant::now() + quiet_for;
                }
            }
        }
        guard.stop_wait(conn, &params, false).await
    }

    /// a spawn grant by its token and the endpoint that spent it, for its issuer or an ancestor of that endpoint
    async fn spawn_grant(&self, me: &Row, token: &str) -> Result<(Row, Option<Row>), RpcError> {
        let grant = self
            .store
            .all(
                "SELECT * FROM grants WHERE token_hash = ?",
                &[sv(hash(token))],
            )
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "no such grant"))?;
        let spender = match text(&grant, "used_by") {
            Some(id) => self.by_id(id).await?,
            None => None,
        };
        let me_id = text(me, "id").unwrap_or("");
        let ancestor = match &spender {
            Some(spender) => self.ancestors(spender).await?.iter().any(|id| id == me_id),
            None => false,
        };
        if text(&grant, "issuer") != Some(me_id) && !ancestor {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "only the grant's issuer ends its spawn",
            ));
        }
        if spender.is_some() && integer(&grant, "revoked_at").is_some() {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "the grant was revoked: a new spawn holds its endpoint",
            ));
        }
        Ok((grant, spender))
    }

    /// the grant issuer's messages to the endpoint that spent it, sent since the grant, unread or among `ids`, oldest first
    async fn steers_of(
        &self,
        grant: &Row,
        spender: &Row,
        now: i64,
        ids: &[String],
    ) -> Result<Vec<Row>, RpcError> {
        let marks = if ids.is_empty() {
            "NULL".to_owned()
        } else {
            vec!["?"; ids.len()].join(", ")
        };
        let mut params = vec![
            sv(text(spender, "id").unwrap_or("")),
            sv(text(grant, "issuer").unwrap_or("")),
            SqlValue::Int(now),
            SqlValue::Int(integer(grant, "created_at").unwrap_or(0)),
        ];
        params.extend(ids.iter().map(sv));
        params.push(SqlValue::Int(self.cap("inboxPage", 100)));
        Ok(self.store.all(&format!("SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND m.from_ep = ? AND d.expires_at > ? AND m.created_at >= ? AND (d.acked_at IS NULL OR m.id IN ({marks})) ORDER BY d.seq LIMIT ?"), &params).await?)
    }

    /// the grant issuer's messages to the spender, since the grant, that it read, but those among `unapplied`
    async fn read_steers(
        &self,
        grant: &Row,
        spender: &Row,
        unapplied: &[String],
    ) -> Result<Vec<Row>, RpcError> {
        let not_in = if unapplied.is_empty() {
            String::new()
        } else {
            format!(
                "AND m.id NOT IN ({})",
                vec!["?"; unapplied.len()].join(", ")
            )
        };
        let mut params = vec![
            sv(text(spender, "id").unwrap_or("")),
            sv(text(grant, "issuer").unwrap_or("")),
            SqlValue::Int(integer(grant, "created_at").unwrap_or(0)),
        ];
        params.extend(unapplied.iter().map(sv));
        params.push(SqlValue::Int(self.cap("inboxPage", 100)));
        Ok(self.store.all(&format!("SELECT m.id AS id, d.acked_at AS acked_at, d.deferred_ack AS deferred_ack FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND m.from_ep = ? AND m.created_at >= ? AND d.acked_at IS NOT NULL {not_in} ORDER BY d.seq LIMIT ?"), &params).await?)
    }

    /// one line per steer a worker never applied: its text on one line, its short id and when it arrived against the worker's exit
    async fn unapplied_lines(
        &self,
        spender: &Row,
        grant: &Row,
        rows: &[Row],
        now: i64,
        exits: &[i64],
    ) -> Result<Vec<String>, RpcError> {
        let id = text(spender, "id").unwrap_or("");
        let since = integer(grant, "created_at").unwrap_or(0);
        let last = async |end: bool, until: i64| -> Result<Option<i64>, RpcError> {
            let kind = if end {
                "kind = 'session_end'"
            } else {
                "kind <> 'session_end'"
            };
            Ok(self.store.all(&format!("SELECT MAX(at) AS at FROM activity WHERE endpoint = ? AND agent IS NULL AND at >= ? AND at <= ? AND {kind}"), &[sv(id), SqlValue::Int(since), SqlValue::Int(until)]).await?
                .first().and_then(|row| integer(row, "at")))
        };
        let end = last(true, now).await?;
        let last_step = last(false, now).await?;
        let fallback = match end {
            Some(end) if last_step.is_none_or(|step| end >= step) => end,
            _ => now,
        };
        let mut out = Vec::new();
        for row in rows {
            let created = integer(row, "created_at").unwrap_or(0);
            let exited = if exits.is_empty() {
                fallback
            } else {
                exits
                    .iter()
                    .copied()
                    .find(|at| *at >= created)
                    .unwrap_or(-1)
            };
            let step = if exits.is_empty() {
                last_step
            } else {
                last(false, exited.max(0)).await?
            };
            let line = redact_secrets(
                &strip_control(text(row, "body").unwrap_or(""))
                    .split(js_whitespace)
                    .filter(|w| !w.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "),
            );
            let clipped = if line.encode_utf16().count() > STEER_CLIP {
                format!("{}...", utf16_cut(&line, STEER_CLIP))
            } else {
                line
            };
            let seconds = ((exited - created) as f64 / 1000.0 + 0.5).floor() as i64;
            let before = format!(
                "arrived {} s before it exited",
                if seconds < 1 {
                    "under 1".to_owned()
                } else {
                    seconds.to_string()
                }
            );
            let when = if created > exited {
                "arrived after it exited".to_owned()
            } else {
                match step {
                    None => before,
                    Some(step) if created > step => format!("{before}, after its last step"),
                    Some(_) => format!("{before}, unread"),
                }
            };
            out.push(format!(
                "steer not applied: \"{clipped}\" ({}, {when})",
                short_id(text(row, "id").unwrap_or(""))
            ));
        }
        Ok(out)
    }

    fn handback_thread(grant: &Row) -> String {
        let created = integer(grant, "created_at").unwrap_or(0).max(0) as u64;
        let digest = hash(&format!(
            "handback:{}",
            text(grant, "token_hash").unwrap_or("")
        ));
        format!("thr_{:0>9}{}", base36(created), &digest[..16])
    }

    async fn thread_full(&self, thread: &str) -> Result<bool, RpcError> {
        let Some(max) = self.limits.get("threadMax") else {
            return Ok(false);
        };
        Ok(self
            .count(
                "SELECT COUNT(*) AS n FROM messages WHERE thread = ?",
                &[sv(thread)],
            )
            .await?
            >= max as i64)
    }

    fn handback_hop(&self, spender: &Row, now: i64) -> i64 {
        let causal = integer(spender, "last_received_at")
            .is_some_and(|at| at >= now - self.cap("causalWindowS", 120) * 1000);
        if !causal {
            return 0;
        }
        let hop = integer(spender, "last_received_hop").unwrap_or(0) + 1;
        self.limits
            .get("hopMax")
            .map_or(hop, |max| hop.min(max as i64))
    }

    /// one plain text message from `from` straight into `to`'s inbox, past every send check
    async fn post(
        &self,
        from: &Row,
        to: &Row,
        body: &str,
        thread: &str,
        hop: i64,
        reply_to: Option<&str>,
    ) -> Result<String, RpcError> {
        let now = now_ms();
        let id = msg_id(now);
        let expires = now.saturating_add(self.cap("ttlDefaultS", 604_800).saturating_mul(1000));
        let reply = reply_to.map_or(SqlValue::Null, sv);
        self.store.all("INSERT INTO messages (id, thread, reply_to, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at) VALUES (?, ?, ?, 'message', ?, ?, ?, 'text/plain', 'public', '[]', ?, ?, ?)", &[sv(&id), sv(thread), reply, sv(text(from, "id").unwrap_or("")), sv(address(to)), sv(body), SqlValue::Int(hop), SqlValue::Int(now), SqlValue::Int(expires)]).await?;
        let recipient = text(to, "id").unwrap_or("");
        self.store
            .all(
                "INSERT INTO deliveries (message_id, endpoint, expires_at) VALUES (?, ?, ?)",
                &[sv(&id), sv(recipient), SqlValue::Int(expires)],
            )
            .await?;
        self.store
            .all(
                "UPDATE endpoints SET mail_at = ? WHERE id = ?",
                &[SqlValue::Int(now), sv(recipient)],
            )
            .await?;
        Ok(id)
    }

    fn stderr_tail(&self, stderr: &str) -> String {
        format!(
            "stderr (last {} KB):\n{stderr}",
            js_number(self.cap("stderrBytes", 1024) as f64 / 1024.0)
        )
    }

    /// a spawn's handback to its spawner `me`: one per grant, from the worker (the relay when it never joined), its output and exit
    async fn handback(
        &self,
        me: &Row,
        grant: &Row,
        spender: Option<&Row>,
        exit: &Exit<'_>,
    ) -> Result<Option<String>, RpcError> {
        if text(grant, "handback").is_some() {
            return Ok(None);
        }
        let tail = if !exit.stderr.is_empty() && (spender.is_none() || exit.code != 0) {
            self.stderr_tail(exit.stderr)
        } else {
            String::new()
        };
        let output = if tail.is_empty() {
            exit.output.to_owned()
        } else {
            handback_output(
                exit.output,
                false,
                self.cap("handbackBytes", 16384) - tail.len() as i64 - 2,
            )
        };
        let now = now_ms();
        let me_id = text(me, "id").unwrap_or("");
        let since = integer(grant, "created_at").unwrap_or(0);
        let last = match spender {
            Some(spender) => {
                let id = text(spender, "id").unwrap_or("");
                self.store.all("SELECT m.thread AS thread FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE ((m.from_ep = ? AND d.endpoint = ?) OR (m.from_ep = ? AND d.endpoint = ?)) AND m.created_at >= ? ORDER BY m.created_at DESC, d.seq DESC LIMIT 1", &[sv(id), sv(me_id), sv(me_id), sv(id), SqlValue::Int(since)]).await?
                    .first().and_then(|row| text(row, "thread").map(str::to_owned))
            }
            None => None,
        };
        let mut thread = None;
        for candidate in last.into_iter().chain([Self::handback_thread(grant)]) {
            if !self.thread_full(&candidate).await? {
                thread = Some(candidate);
                break;
            }
        }
        let Some(thread) = thread else {
            return Ok(None);
        };
        let exit_text = format!("exit {}", exit.code);
        let mut body: Vec<String> = match spender {
            None => {
                let name = text(grant, "name")
                    .map(|n| format!("{n} "))
                    .unwrap_or_default();
                let lost = match exit.lost {
                    0 => String::new(),
                    n => format!(
                        "{n} message{} you sent it never reached it: it never joined the relay",
                        if n == 1 { "" } else { "s" }
                    ),
                };
                vec![
                    format!("worker {name}finished ({exit_text}), not a relay agent"),
                    lost,
                    output,
                    tail,
                ]
            }
            Some(spender) => {
                let address = address(spender);
                let mut lines = if output.is_empty() {
                    let sent = !self.store.all("SELECT 1 FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE m.from_ep = ? AND d.endpoint = ? AND m.created_at >= ? AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.event = 'spawn_exit' AND a.ref = m.id) LIMIT 1", &[sv(text(spender, "id").unwrap_or("")), sv(me_id), SqlValue::Int(since)]).await?.is_empty();
                    vec![if sent {
                        format!("worker {address} exited ({exit_text}) with no final output")
                    } else {
                        format!("worker {address} exited without replying ({exit_text})")
                    }]
                } else {
                    vec![format!("worker {address} finished ({exit_text})"), output]
                };
                lines.push(tail);
                let unapplied = self.steers_of(grant, spender, now, exit.taken).await?;
                let mut steers: Vec<String> = self
                    .read_steers(grant, spender, exit.taken)
                    .await?
                    .iter()
                    .map(|row| {
                        let how = if integer(row, "deferred_ack").is_some_and(|v| v != 0)
                            && exit.code != 0
                        {
                            "delivered"
                        } else {
                            "read"
                        };
                        format!(
                            "your steer {} was {how} at {}",
                            short_id(text(row, "id").unwrap_or("")),
                            clock(integer(row, "acked_at").unwrap_or(0))
                        )
                    })
                    .collect();
                if !unapplied.is_empty() {
                    steers.extend(
                        self.unapplied_lines(spender, grant, &unapplied, now, exit.exits)
                            .await?,
                    );
                }
                if !steers.is_empty() {
                    lines.push(steers.join("\n"));
                }
                if text(spender, "wake") == Some("spawn-resume") {
                    lines.push(held_line(&address, text(spender, "hold_ref").is_some()));
                }
                lines
            }
        };
        body.retain(|line| !line.is_empty());
        let from = match spender {
            Some(spender) => spender.clone(),
            None => self
                .by_handle(SYSTEM_HANDLE)
                .await?
                .ok_or_else(RpcError::internal)?,
        };
        let hop = spender.map_or(0, |s| self.handback_hop(s, now));
        let id = self
            .post(&from, me, &body.join("\n\n"), &thread, hop, None)
            .await?;
        self.store
            .all(
                "UPDATE grants SET handback = ? WHERE token_hash = ?",
                &[sv(&id), sv(text(grant, "token_hash").unwrap_or(""))],
            )
            .await?;
        Ok(Some(id))
    }

    /// a held spawn's handback for its later run `run`: one per run, a reply to the woken message or the first handback, in its thread
    async fn run_handback(
        &self,
        me: &Row,
        grant: &Row,
        spender: &Row,
        run: i64,
        exit: &Exit<'_>,
        reply_to: Option<&str>,
    ) -> Result<Option<String>, RpcError> {
        let token = text(grant, "token_hash").unwrap_or("");
        if self.store.all("UPDATE grants SET run = ? WHERE token_hash = ? AND COALESCE(run, 1) < ? RETURNING token_hash", &[SqlValue::Int(run), sv(token), SqlValue::Int(run)]).await?.is_empty() {
            return Ok(None);
        }
        let me_id = text(me, "id").unwrap_or("");
        let spender_id = text(spender, "id").unwrap_or("");
        let woke = match reply_to {
            Some(reply_to) => self.store.all("SELECT m.id AS id, m.thread AS thread FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE m.id = ? AND m.from_ep = ? AND d.endpoint = ?", &[sv(reply_to), sv(me_id), sv(spender_id)]).await?.into_iter().next(),
            None => None,
        };
        let first = match text(grant, "handback") {
            Some(id) => self
                .store
                .all("SELECT id, thread FROM messages WHERE id = ?", &[sv(id)])
                .await?
                .into_iter()
                .next(),
            None => None,
        };
        let mut anchor = None;
        for row in woke.into_iter().chain(first) {
            if !self.thread_full(text(&row, "thread").unwrap_or("")).await? {
                anchor = Some(row);
                break;
            }
        }
        let thread = match &anchor {
            Some(row) => text(row, "thread").unwrap_or("").to_owned(),
            None => {
                let stable = Self::handback_thread(grant);
                if self.thread_full(&stable).await? {
                    return Ok(None);
                }
                stable
            }
        };
        let address = address(spender);
        let tail = if !exit.stderr.is_empty() && exit.code != 0 {
            self.stderr_tail(exit.stderr)
        } else {
            String::new()
        };
        let kept = if tail.is_empty() {
            exit.output.to_owned()
        } else {
            handback_output(
                exit.output,
                false,
                self.cap("handbackBytes", 16384) - tail.len() as i64 - 2,
            )
        };
        let head = if kept.is_empty() {
            format!(
                "worker {address} exited without replying (exit {})",
                exit.code
            )
        } else {
            format!("worker {address} finished (exit {})", exit.code)
        };
        let held = if text(spender, "wake") == Some("spawn-resume") {
            held_line(&address, text(spender, "hold_ref").is_some())
        } else {
            String::new()
        };
        let body = [head, kept, tail, held]
            .into_iter()
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        let hop = self.handback_hop(spender, now_ms());
        let reply = anchor.as_ref().and_then(|row| text(row, "id"));
        Ok(Some(
            self.post(spender, me, &body, &thread, hop, reply).await?,
        ))
    }

    /// the harness a spawn ran with `grant` exited with `code`: its spender is done and the spawner gets the handback
    pub async fn spawn_exit(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let token = params
            .get("grant")
            .and_then(Value::as_str)
            .filter(|v| valid_token(v, "krt_"))
            .ok_or_else(|| RpcError::invalid_params("grant is a krt_ token"))?;
        let whole = |v: &Value| {
            v.as_f64()
                .filter(|n| n.fract() == 0.0 && n.abs() < 9.0e15)
                .map(|n| n as i64)
        };
        let code = params
            .get("code")
            .and_then(whole)
            .filter(|n| (0..=255).contains(n))
            .ok_or_else(|| RpcError::invalid_params("code is an exit code, 0 to 255"))?;
        let given = |key: &str| params.get(key).filter(|v| !v.is_null());
        let run = match given("run") {
            None => 1,
            Some(v) => whole(v)
                .filter(|n| *n >= 1)
                .ok_or_else(|| RpcError::invalid_params("run is a whole number from 1"))?,
        };
        let string = |key: &str, message: &str| -> Result<Option<&str>, RpcError> {
            given(key)
                .map(|v| v.as_str().ok_or_else(|| RpcError::invalid_params(message)))
                .transpose()
        };
        let reply_to = string("reply_to", "reply_to is a message id")?;
        let output = string("output", "output is a string")?;
        let stderr = string("stderr", "stderr is a string")?;
        let started = given("started")
            .map(|v| {
                v.as_bool()
                    .ok_or_else(|| RpcError::invalid_params("started is a boolean"))
            })
            .transpose()?;
        let unapplied: Vec<String> = match given("unapplied") {
            None => Vec::new(),
            Some(v) => v
                .as_array()
                .filter(|list| list.len() as i64 <= self.cap("inboxPage", 100))
                .and_then(|list| {
                    list.iter()
                        .map(|id| id.as_str().map(str::to_owned))
                        .collect()
                })
                .ok_or_else(|| RpcError::invalid_params("unapplied is a list of message ids"))?,
        };
        let exit_times: Vec<i64> = match given("exits") {
            None => Vec::new(),
            Some(v) => v
                .as_array()
                .filter(|list| list.len() <= 8)
                .and_then(|list| list.iter().map(whole).collect())
                .ok_or_else(|| RpcError::invalid_params("exits is a list of times in ms"))?,
        };
        let handback_bytes = self.cap("handbackBytes", 16384);
        let output = output
            .map(|o| handback_output(o, false, handback_bytes))
            .unwrap_or_default();
        let stderr = stderr
            .map(|s| handback_output(s, false, 2 * self.cap("stderrBytes", 1024)))
            .unwrap_or_default();
        let me = self.actor_row(conn).await?;
        let (result, spawner) = crate::store::transaction(self.store.clone(), async {
            let (grant, spender) = self.spawn_grant(&me, token).await?;
            let now = now_ms();
            let spawner = match self.by_id(text(&grant, "issuer").unwrap_or("")).await? {
                Some(row) => row,
                None => me.clone(),
            };
            let spawner_id = text(&spawner, "id").unwrap_or("").to_owned();
            let name = text(&grant, "name").map_or(Value::Null, |n| json!(n));
            let token_hash = text(&grant, "token_hash").unwrap_or("").to_owned();
            let Some(spender) = spender else {
                if run > 1 {
                    return Ok((
                        json!({"joined":false,"name":name,"endpoint":null,"handback":null}),
                        spawner_id,
                    ));
                }
                self.store.all("UPDATE grants SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?", &[SqlValue::Int(now), sv(&token_hash)]).await?;
                let lost = self
                    .store
                    .all(
                        "DELETE FROM deliveries WHERE endpoint = ? RETURNING seq",
                        &[sv(format!("spawn:{token_hash}"))],
                    )
                    .await?
                    .len() as i64;
                let exit = Exit {
                    code,
                    output: &output,
                    taken: &[],
                    lost,
                    exits: &[],
                    stderr: &stderr,
                };
                let handback = if started == Some(false) {
                    None
                } else {
                    self.handback(&spawner, &grant, None, &exit).await?
                };
                self.audit(
                    "spawn_exit",
                    text(&me, "id"),
                    handback.as_deref(),
                    json!({"by":address(&me),"code":code,"joined":false,"handback":handback}),
                )
                .await?;
                return Ok((
                    json!({"joined":false,"name":name,"endpoint":null,"handback":handback}),
                    spawner_id,
                ));
            };
            let spender_id = text(&spender, "id").unwrap_or("").to_owned();
            let note = [
                Some(format!("exited {code}")),
                text(&spender, "status_note")
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("; ");
            let note = utf16_cut(&note, self.cap("noteChars", 280) as usize);
            self.store.all("UPDATE endpoints SET status_state = 'done', status_note = ?, hook_seen = NULL, hook_ended = ?, session = CASE WHEN connections = 0 THEN NULL ELSE session END, wake = CASE WHEN wakers = 0 AND NOT COALESCE(wake IN ('codex-queue'), 0) THEN NULL ELSE wake END WHERE id = ?", &[sv(note), SqlValue::Int(now), sv(&spender_id)]).await?;
            let created = integer(&grant, "created_at").unwrap_or(0);
            let mut exits: Vec<i64> = exit_times
                .iter()
                .map(|at| (*at).max(created).min(now))
                .collect();
            exits.sort_unstable();
            let exit = Exit {
                code,
                output: &output,
                taken: &unapplied,
                lost: 0,
                exits: &exits,
                stderr: &stderr,
            };
            let handback = if run == 1 {
                self.handback(&spawner, &grant, Some(&spender), &exit)
                    .await?
            } else {
                self.run_handback(&spawner, &grant, &spender, run, &exit, reply_to)
                    .await?
            };
            if run == 1 && handback.is_some() {
                self.store
                    .all(
                        "UPDATE grants SET run = 1 WHERE token_hash = ? AND run IS NULL",
                        &[sv(&token_hash)],
                    )
                    .await?;
            }
            let mut detail = json!({"by":address(&me),"code":code,"handback":handback});
            if run > 1 {
                detail["run"] = json!(run);
            }
            self.audit("spawn_exit", Some(&spender_id), handback.as_deref(), detail)
                .await?;
            let view = self.view(&self.must_endpoint(&spender_id).await?).await?;
            Ok::<_, RpcError>((
                json!({"joined":true,"name":name,"endpoint":view,"handback":handback}),
                spawner_id,
            ))
        })
        .await?;
        if !result["handback"].is_null() {
            self.state.wake(&spawner);
        }
        Ok(result)
    }

    /// an exited spawn's harness session, transcript and the issuer's unread messages to it; `take` marks them read for a resume to hand over
    pub async fn spawn_steers(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let token = params
            .get("grant")
            .and_then(Value::as_str)
            .filter(|v| valid_token(v, "krt_"))
            .ok_or_else(|| RpcError::invalid_params("grant is a krt_ token"))?;
        let me = self.actor_row(conn).await?;
        crate::store::transaction(self.store.clone(), async {
            let (grant, spender) = self.spawn_grant(&me, token).await?;
            let Some(spender) = spender else {
                return Ok(json!({"session":null,"steers":[],"transcript":null,"joined":false}));
            };
            let now = now_ms();
            let id = text(&spender, "id").unwrap_or("");
            let rows = self.steers_of(&grant, &spender, now, &[]).await?;
            let mut steers = Vec::new();
            for row in &rows {
                steers.push(self.message_envelope(row, id).await?);
            }
            let session = text(&spender, "harness_session");
            if flag(params, "take") && session.is_some() && !rows.is_empty() {
                self.store
                    .all("UPDATE endpoints SET hook_seen = NULL WHERE id = ?", &[sv(id)])
                    .await?;
                for seq in rows.iter().filter_map(|row| integer(row, "seq")) {
                    self.store
                        .all(
                            "UPDATE deliveries SET acked_at = ? WHERE seq = ? AND acked_at IS NULL",
                            &[SqlValue::Int(now), SqlValue::Int(seq)],
                        )
                        .await?;
                }
                self.audit(
                    "ack",
                    Some(id),
                    None,
                    json!({"count":rows.len(),"by":address(&me)}),
                )
                .await?;
            }
            Ok::<_, RpcError>(
                json!({"session":session,"steers":steers,"transcript":session.and(text(&spender, "harness_transcript")),"joined":true}),
            )
        })
        .await
    }

    /// the worker's spawn no longer holds it: its latest spawn grant records the end, its resume wake, durable ref and spawn hibernation clear
    pub async fn spawn_end(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let me = self.actor_row(conn).await?;
        let tty = self.at_terminal(conn);
        let value = params
            .get("endpoint")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| RpcError::invalid_params("an address is user/handle, or a handle"))?;
        let ended = crate::store::transaction(self.store.clone(), async {
            let target = self
                .lookup(value)
                .await
                .map_err(|_| not_found(value.trim()))?;
            if text(&target, "kind") != Some("agent") {
                return Err(RpcError::invalid_params(
                    "only a local agent endpoint is ended",
                ));
            }
            let id = text(&target, "id").unwrap_or("");
            let me_id = text(&me, "id").unwrap_or("");
            let grant = self.store.all("SELECT * FROM grants WHERE used_by = ? AND spawn = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1", &[sv(id)]).await?.into_iter().next();
            let issuer = grant.as_ref().and_then(|g| text(g, "issuer")) == Some(me_id);
            if !tty && !issuer && !self.ancestors(&target).await?.iter().any(|a| a == me_id) {
                if text(&me, "kind") == Some("agent") && !self.world().await?.discovers(me_id, id) {
                    return Err(crate::messages::unreachable(value));
                }
                return Err(RpcError::new(
                    ErrorCode::Unauthorized,
                    "only the worker's spawner, an ancestor or the human at a terminal ends it",
                ));
            }
            let spawn_held = text(&target, "hibernate") == Some(SPAWN_PROVIDER);
            let held = text(&target, "wake") == Some("spawn-resume")
                || text(&target, "hold_ref").is_some()
                || spawn_held;
            if let Some(grant) = &grant {
                self.store
                    .all(
                        "UPDATE grants SET ended_at = COALESCE(ended_at, ?) WHERE token_hash = ?",
                        &[
                            SqlValue::Int(now_ms()),
                            sv(text(grant, "token_hash").unwrap_or("")),
                        ],
                    )
                    .await?;
            }
            self.store.all("UPDATE endpoints SET wake = CASE WHEN wake = 'spawn-resume' THEN NULL ELSE wake END, hold_ref = NULL WHERE id = ?", &[sv(id)]).await?;
            if spawn_held {
                self.store.all("UPDATE endpoints SET hibernate = NULL, wake_ref = NULL, wake_eta = NULL, hibernated_at = NULL, wake_tried = NULL, wake_fails = 0, wake_note = NULL, wake_declined = NULL, declined_message = NULL, declined_from = NULL, wake_ticket = NULL, wake_tickets = NULL, revive = NULL WHERE id = ?", &[sv(id)]).await?;
            }
            self.audit(
                "spawn_end",
                Some(id),
                None,
                json!({"by":address(&me),"target":address(&target),"held":held}),
            )
            .await?;
            let view = self.view(&self.must_endpoint(id).await?).await?;
            Ok::<_, RpcError>(json!({"endpoint":view,"held":held}))
        })
        .await?;
        if let Some(id) = ended["endpoint"]["id"].as_str() {
            for connection in self.state.connections.values() {
                if connection.waker.as_deref() == Some(id) {
                    connection.closed.notify_waiters();
                }
            }
            if !self.presence_moved(id, true, false).await? {
                self.bridge_changed(id);
            }
        }
        Ok(ended)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use serde_json::{Map, Value, json};
    use tokio::sync::Mutex;

    use super::{handback_output, keep_last};
    use crate::claims::{hash, token};
    use crate::core::{Core, SharedCore, integer, now_ms, text};
    use crate::paths::Paths;
    use crate::proto::Limits;
    use crate::state::ConnectionId;
    use crate::store::SqlValue;
    use crate::store::sqlite::SqliteStore;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    struct Fixture {
        core: Core,
        main: ConnectionId,
        worker: ConnectionId,
        worker_id: String,
        token: String,
    }

    async fn agent(core: &mut Core, handle: &str) -> (ConnectionId, String) {
        let conn = core.state.connect();
        let hello = core
            .dispatch(
                conn,
                "hello",
                &map(json!({"protocol":"scp/1","claim":{"handle":handle,"harness":"codex"}})),
            )
            .await
            .expect("hello");
        let id = hello["endpoint"]["id"].as_str().expect("id").to_owned();
        (conn, id)
    }

    async fn fixture(no_push: bool) -> Fixture {
        let dir = std::env::temp_dir().join(format!("scp-push-{:032x}", rand::random::<u128>()));
        tokio::fs::create_dir(&dir).await.expect("directory");
        let paths = Paths::new(dir.clone());
        let store = Arc::new(SqliteStore::open(&paths.database).expect("store"));
        let mut core = Core::new(store, Limits::default(), paths, dir.join("policy.json"))
            .await
            .expect("core");
        let (main, main_id) = agent(&mut core, "main").await;
        let (worker, worker_id) = agent(&mut core, "w1").await;
        let token = token("krt");
        let at = now_ms() - 1000;
        let mark = if no_push {
            SqlValue::Int(1)
        } else {
            SqlValue::Null
        };
        core.store.all("INSERT INTO grants (token_hash, issuer, under, name, labels, caps, groups, used_by, created_at, expires_at, spawn, no_push, steer) VALUES (?, ?, ?, 'w1', '{}', '[]', '[]', ?, ?, ?, 1, ?, 'key1')", &[SqlValue::Text(hash(&token)), SqlValue::Text(main_id.clone()), SqlValue::Text(main_id.clone()), SqlValue::Text(worker_id.clone()), SqlValue::Int(at), SqlValue::Int(at + 600_000), mark]).await.expect("grant");
        core.store
            .all(
                "UPDATE endpoints SET parent_ep = ?, tree = ?, depth = 1 WHERE id = ?",
                &[
                    SqlValue::Text(main_id.clone()),
                    SqlValue::Text(main_id),
                    SqlValue::Text(worker_id.clone()),
                ],
            )
            .await
            .expect("parent");
        Fixture {
            core,
            main,
            worker,
            worker_id,
            token,
        }
    }

    async fn send(core: &mut Core, from: ConnectionId, to: &str, body: &str) {
        core.dispatch(from, "send", &map(json!({"to":to,"body":body})))
            .await
            .expect("send");
    }

    async fn stop(core: &mut Core, conn: ConnectionId, peek: bool) -> Value {
        core.stop_wait(conn, &Map::new(), peek)
            .await
            .expect("stop_wait")
    }

    fn texts(result: &Value) -> Vec<String> {
        result["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .filter_map(|m| m["body"]["text"].as_str().map(str::to_owned))
            .collect()
    }

    #[tokio::test]
    async fn stop_shows_and_holds_worker_results_and_counts_pushes() {
        let Fixture {
            mut core,
            main,
            worker,
            ..
        } = fixture(false).await;
        assert_eq!(
            stop(&mut core, main, false).await["workers"],
            json!(["me/w1"])
        );
        send(&mut core, worker, "main", "done-42").await;
        assert!(stop(&mut core, main, true).await["hold"].is_null());
        let result = stop(&mut core, main, false).await;
        assert_eq!(texts(&result), ["done-42"]);
        assert_eq!(result["messages"][0]["relation"], "child");
        assert_eq!(result["pushes_left"], 20);
        assert!(result["hold"].is_string());
        assert_eq!(stop(&mut core, main, false).await["messages"], json!([]));
        let pushed = core
            .dispatch(
                main,
                "injected",
                &map(
                    json!({"seqs":result["offered"],"hold":result["hold"],"read":result["offered"],"push":true}),
                ),
            )
            .await
            .expect("injected");
        assert_eq!(pushed["pushed"], true);
        assert_eq!(pushed["injected"], 1);
        assert_eq!(stop(&mut core, main, false).await["pushes_left"], 19);
        send(&mut core, worker, "main", "chatty").await;
        assert_eq!(stop(&mut core, main, false).await["messages"], json!([]));
    }

    #[tokio::test]
    async fn others_follow_a_worker_result() {
        let Fixture {
            mut core,
            main,
            worker,
            ..
        } = fixture(false).await;
        let (peer, _) = agent(&mut core, "peer").await;
        for i in 0..3 {
            send(&mut core, peer, "main", &format!("peer {i}")).await;
        }
        send(&mut core, worker, "main", "done").await;
        let result = stop(&mut core, main, false).await;
        assert_eq!(texts(&result), ["done", "peer 0", "peer 1", "peer 2"]);
        assert_eq!(result["others_shown"], 3);
        assert_eq!(result["others"], 0);
    }

    #[tokio::test]
    async fn no_push_workers_hold_nothing() {
        let Fixture {
            mut core,
            main,
            worker,
            ..
        } = fixture(true).await;
        send(&mut core, worker, "main", "queued").await;
        let result = stop(&mut core, main, false).await;
        assert_eq!(result["workers"], json!([]));
        assert_eq!(result["messages"], json!([]));
        assert_eq!(result["others"], 1);
        assert_eq!(result["background"], json!(["me/w1"]));
    }

    #[tokio::test]
    async fn exit_hands_back_output_and_ends_the_worker() {
        let Fixture {
            mut core,
            main,
            worker_id,
            token,
            ..
        } = fixture(false).await;
        let exit = core
            .dispatch(
                main,
                "spawn_exit",
                &map(json!({"grant":token,"code":0,"output":"\u{1b}[1mdone\u{1b}[0m"})),
            )
            .await
            .expect("spawn_exit");
        assert_eq!(exit["joined"], true);
        assert_eq!(exit["endpoint"]["status"]["state"], "done");
        assert!(exit["handback"].is_string());
        let result = stop(&mut core, main, false).await;
        assert_eq!(result["workers"], json!([]));
        assert_eq!(texts(&result), ["worker me/w1 finished (exit 0)\n\ndone"]);
        let again = core
            .dispatch(main, "spawn_exit", &map(json!({"grant":token,"code":0})))
            .await
            .expect("again");
        assert!(again["handback"].is_null());
        let row = core.by_id(&worker_id).await.expect("row").expect("worker");
        assert_eq!(text(&row, "status_state"), Some("done"));
        let refused = core
            .dispatch(main, "spawn_exit", &map(json!({"grant":"krt_x","code":0})))
            .await;
        assert!(refused.is_err());
    }

    #[tokio::test]
    async fn steers_and_end() {
        let Fixture {
            mut core,
            main,
            worker_id,
            token,
            ..
        } = fixture(false).await;
        send(&mut core, main, "w1", "steer one").await;
        let steers = core
            .spawn_steers(main, &map(json!({"grant":token})))
            .await
            .expect("steers");
        assert_eq!(steers["joined"], true);
        assert_eq!(steers["steers"][0]["body"]["text"], "steer one");
        assert_eq!(steers["steers"][0]["relation"], "parent");
        let ended = core
            .spawn_end(main, &map(json!({"endpoint":"w1"})))
            .await
            .expect("end");
        assert_eq!(ended["held"], false);
        let grant = core
            .store
            .all(
                "SELECT ended_at FROM grants WHERE used_by = ?",
                &[SqlValue::Text(worker_id)],
            )
            .await
            .expect("grant");
        assert!(integer(&grant[0], "ended_at").is_some());
    }

    #[tokio::test]
    async fn waiting_stop_wakes_on_a_worker_message() {
        let Fixture {
            core, main, worker, ..
        } = fixture(false).await;
        let shared: SharedCore = Arc::new(Mutex::new(core));
        let waiting = tokio::spawn({
            let shared = shared.clone();
            async move {
                let guard = shared.clone().lock_owned().await;
                Core::execute(
                    shared,
                    guard,
                    main,
                    "stop_wait".into(),
                    map(json!({"wait_s":3})),
                )
                .await
            }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let began = Instant::now();
        send(&mut *shared.lock().await, worker, "main", "result").await;
        let result = waiting.await.expect("task").expect("stop_wait");
        assert!(began.elapsed() < Duration::from_secs(2));
        assert_eq!(texts(&result), ["result"]);
        assert!(result["hold"].is_string());
        let began = Instant::now();
        let guard = shared.clone().lock_owned().await;
        let idle = Core::execute(
            shared.clone(),
            guard,
            main,
            "stop_wait".into(),
            map(json!({"wait_s":0.2})),
        )
        .await
        .expect("idle");
        assert!(began.elapsed() >= Duration::from_millis(150));
        assert_eq!(idle["workers"], json!(["me/w1"]));
        let guard = shared.clone().lock_owned().await;
        let bad = Core::execute(
            shared,
            guard,
            main,
            "stop_wait".into(),
            map(json!({"wait_s":-1})),
        )
        .await;
        assert!(bad.is_err());
    }

    #[tokio::test]
    async fn workers_finishing_together_are_gathered() {
        let Fixture {
            mut core,
            main,
            worker,
            ..
        } = fixture(false).await;
        let (second, second_id) = agent(&mut core, "w2").await;
        let main_id = core
            .connection(main)
            .expect("main")
            .endpoint
            .expect("endpoint");
        let at = now_ms() - 1000;
        core.store.all("INSERT INTO grants (token_hash, issuer, under, name, labels, caps, groups, used_by, created_at, expires_at, spawn) VALUES (?, ?, ?, 'w2', '{}', '[]', '[]', ?, ?, ?, 1)", &[SqlValue::Text(hash(&token("krt"))), SqlValue::Text(main_id.clone()), SqlValue::Text(main_id), SqlValue::Text(second_id), SqlValue::Int(at), SqlValue::Int(at + 600_000)]).await.expect("grant");
        let shared: SharedCore = Arc::new(Mutex::new(core));
        let waiting = tokio::spawn({
            let shared = shared.clone();
            async move {
                let guard = shared.clone().lock_owned().await;
                Core::execute(
                    shared,
                    guard,
                    main,
                    "stop_wait".into(),
                    map(json!({"wait_s":3})),
                )
                .await
            }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        send(&mut *shared.lock().await, worker, "main", "one").await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let began = Instant::now();
        send(&mut *shared.lock().await, second, "main", "two").await;
        let result = waiting.await.expect("task").expect("stop_wait");
        assert!(began.elapsed() < Duration::from_secs(2));
        assert_eq!(texts(&result), ["one", "two"]);
    }

    #[test]
    fn output_keeps_the_tail_behind_a_cut_mark() {
        assert_eq!(
            handback_output("a\rb\nc\u{1b}[31m!\u{1b}[0m\n", false, 100),
            "b\nc!"
        );
        let lines = format!("{}\na longer last line", "x".repeat(50));
        assert_eq!(
            keep_last(&lines, 40, false),
            "[earlier output cut]\na longer last line"
        );
        let short_tail = format!("{}\nlast line", "x".repeat(50));
        assert_eq!(
            keep_last(&short_tail, 40, false),
            "[earlier output cut]\nxxxxxxxxx\nlast line"
        );
        assert_eq!(keep_last("short", 40, false), "short");
    }
}
