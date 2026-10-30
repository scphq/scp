//! Rate limits and loop guards a send runs; every one is off unless configured.

use scp_core::protocol::{ErrorCode, LIMITS, PairBurst, PairLimits, PairRefusal};
use serde_json::{Value, json};

use crate::core::{Core, integer, text, timestamp};
use crate::proto::RpcError;
use crate::store::{Row, SqlValue};
use crate::views::address;

fn string(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

pub fn pair_key(a: &str, b: &str) -> String {
    if a < b {
        format!("{a}|{b}")
    } else {
        format!("{b}|{a}")
    }
}

fn ceil_s(ms: i64) -> i64 {
    (ms + 999).div_euclid(1000)
}

fn retry_after(first: Option<i64>, window_s: i64, now: i64) -> i64 {
    ceil_s(first.unwrap_or(now) + window_s * 1000 - now).max(1)
}

/// What a send asks of the guards: the sender, its resolved recipients and the facts each check needs.
pub struct SendGuard<'a> {
    pub sender: &'a Row,
    pub recipients: &'a [Row],
    pub addressed: &'a [String],
    pub thread: &'a str,
    pub hop: i64,
    pub has_parent: bool,
    pub tty: Option<i64>,
    pub fan_out: &'a [String],
}

/// A pair's live loop and rate limits, for `why`.
pub struct PairState {
    pub held: bool,
    pub lines: Vec<String>,
    pub pair: Option<PairLimits>,
}

impl Core {
    pub fn rate(&self, name: &str) -> Option<i64> {
        self.limits
            .get(name)
            .map(|v| v.min(i64::MAX as u64 / 1000) as i64)
    }

    async fn count(
        &self,
        statement: &str,
        params: &[SqlValue],
    ) -> Result<(i64, Option<i64>), RpcError> {
        let rows = self.store.all(statement, params).await?;
        let row = rows.first();
        Ok((
            row.and_then(|r| integer(r, "n")).unwrap_or(0),
            row.and_then(|r| integer(r, "first")),
        ))
    }

    /// audits a refusal and returns its error, with a retry hint when one is known
    pub async fn refuse(
        &self,
        endpoint: &str,
        code: ErrorCode,
        message: impl Into<String>,
        retry_after: Option<i64>,
        detail: Value,
    ) -> Result<RpcError, RpcError> {
        let message = message.into();
        let mut audit = json!({"code": code, "message": message});
        if let (Some(target), Some(extra)) = (audit.as_object_mut(), detail.as_object()) {
            target.extend(extra.clone());
            if let Some(after) = retry_after.filter(|v| *v > 0) {
                target.insert("retry_after_s".into(), json!(after));
            }
        }
        self.audit("refuse", Some(endpoint), None, audit).await?;
        let mut error = RpcError::new(code, message);
        if let (Some(after), Some(data)) = (retry_after.filter(|v| *v > 0), error.data.as_mut()) {
            data.extra.insert("retry_after".into(), json!(after));
        }
        Ok(error)
    }

    /// messages between two endpoints, both ways, in the burst window
    pub async fn pair_burst(
        &self,
        a: &str,
        b: &str,
        now: i64,
    ) -> Result<(i64, Option<i64>), RpcError> {
        self.count(
            "SELECT COUNT(*) AS n, MIN(at) AS first FROM pair_events WHERE ((from_ep = ? AND to_ep = ?) OR (from_ep = ? AND to_ep = ?)) AND at > ?",
            &[string(a), string(b), string(b), string(a), SqlValue::Int(now - LIMITS.pair_burst_window_s as i64 * 1000)],
        )
        .await
    }

    /// the guards that run before a send is written: hop, thread, daily, pair, inbox, tree and group limits
    pub async fn check_send(&self, guard: &SendGuard<'_>, now: i64) -> Result<(), RpcError> {
        let from = text(guard.sender, "id").ok_or_else(RpcError::internal)?;
        if let Some(hop_max) = self.rate("hopMax")
            && guard.hop > hop_max
        {
            let chain = if guard.has_parent {
                format!("this reply would be hop {} of a reply chain", guard.hop)
            } else {
                format!(
                    "this message would be hop {} of a chain of agent messages",
                    guard.hop
                )
            };
            return Err(self
                .refuse(
                    from,
                    ErrorCode::LoopGuard,
                    format!("{chain} (limit {hop_max}): agents may be answering each other in a loop; stop and report to your user"),
                    None,
                    json!({"to": guard.addressed, "hop": guard.hop, "limit": hop_max, "thread": guard.thread}),
                )
                .await?);
        }
        if let Some(thread_max) = self.rate("threadMax") {
            let (n, _) = self
                .count(
                    "SELECT COUNT(*) AS n FROM messages WHERE thread = ?",
                    &[string(guard.thread)],
                )
                .await?;
            if n >= thread_max {
                return Err(self
                    .refuse(
                        from,
                        ErrorCode::LoopGuard,
                        format!("thread {} reached {thread_max} messages", guard.thread),
                        None,
                        json!({"to": guard.addressed, "limit": thread_max, "thread": guard.thread}),
                    )
                    .await?);
            }
        }
        if let Some(per_day) = self.rate("userPerDay") {
            let today = if guard.tty == Some(1) {
                0
            } else {
                self.count(
                    "SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND (from_ep IN (SELECT id FROM endpoints WHERE kind = 'agent') OR sender_tty = 0)",
                    &[SqlValue::Int(now - 86_400_000)],
                )
                .await?
                .0
            };
            if today >= per_day {
                return Err(self
                    .refuse(
                        from,
                        ErrorCode::RateLimited,
                        format!("{per_day} messages in the last day"),
                        Some(3600),
                        json!({"to": guard.addressed, "limit": per_day, "window_s": 86_400}),
                    )
                    .await?);
            }
        }
        let first = address(guard.sender);
        for recipient in guard.recipients {
            let to = text(recipient, "id").ok_or_else(RpcError::internal)?;
            let second = address(recipient);
            let blocked = self
                .store
                .all(
                    "SELECT until FROM blocks WHERE pair = ? AND until > ?",
                    &[string(pair_key(from, to)), SqlValue::Int(now)],
                )
                .await?;
            if let Some(until) = blocked.first().and_then(|r| integer(r, "until")) {
                return Err(self
                    .refuse(
                        from,
                        ErrorCode::LoopGuard,
                        format!("messages between {first} and {second} are paused: they went back and forth too often"),
                        Some(ceil_s(until - now)),
                        json!({"to": [second], "until": timestamp(until)}),
                    )
                    .await?);
            }
            if let Some(burst) = self.rate("pairBurst") {
                let (n, first_at) = self.pair_burst(from, to, now).await?;
                if n >= burst {
                    let window = LIMITS.pair_burst_window_s as i64;
                    let after = retry_after(first_at, window, now);
                    return Err(self
                        .refuse(
                            from,
                            ErrorCode::RateLimited,
                            format!("{} messages between {first} and {second} in {window} s (limit {burst}): pausing this pair; retry after {after} s", n + 1),
                            Some(after),
                            json!({"to": [second], "limit": burst, "window_s": window}),
                        )
                        .await?);
                }
            }
            for (name, window) in [("pairPerMinute", 60), ("pairPerHour", 3600)] {
                let Some(limit) = self.rate(name) else {
                    continue;
                };
                let (n, first_at) = self
                    .count(
                        "SELECT COUNT(*) AS n, MIN(at) AS first FROM pair_events WHERE from_ep = ? AND to_ep = ? AND at > ?",
                        &[string(from), string(to), SqlValue::Int(now - window * 1000)],
                    )
                    .await?;
                if n >= limit {
                    let after = retry_after(first_at, window, now);
                    return Err(self
                        .refuse(
                            from,
                            ErrorCode::RateLimited,
                            format!("{} messages from {first} to {second} in {window} s (limit {limit}): retry after {after} s", n + 1),
                            Some(after),
                            json!({"to": [second], "limit": limit, "window_s": window}),
                        )
                        .await?);
                }
            }
            if let Some(refusal) = self.policy_refusal(guard.sender, recipient) {
                return Err(self
                    .refuse(
                        from,
                        ErrorCode::PolicyRefused,
                        format!("{refusal} ({second})"),
                        None,
                        json!({"to": [second]}),
                    )
                    .await?);
            }
        }
        let tree_sends = if text(guard.sender, "kind") == Some("agent") {
            guard
                .recipients
                .iter()
                .filter(|r| text(r, "kind") != Some("human"))
                .count() as i64
        } else {
            0
        };
        if tree_sends > 0 {
            self.tree_guard(guard.sender, tree_sends, now, guard.addressed)
                .await?;
        }
        if let Some(per_minute) = self.rate("groupPerMinute") {
            for name in guard.fan_out {
                let (n, first_at) = self
                    .count(
                        "SELECT COUNT(*) AS n, MIN(at) AS first FROM tree_events WHERE tree = ? AND at > ?",
                        &[string(format!("group:{name}")), SqlValue::Int(now - 60_000)],
                    )
                    .await?;
                if n >= per_minute {
                    return Err(self
                        .refuse(
                            from,
                            ErrorCode::RateLimited,
                            format!("{per_minute} messages to group:{name} in 60 s"),
                            Some(retry_after(first_at, 60, now)),
                            json!({"to": [format!("group:{name}")], "limit": per_minute, "window_s": 60}),
                        )
                        .await?);
                }
            }
        }
        Ok(())
    }

    pub fn tree_of(sender: &Row) -> String {
        text(sender, "tree")
            .or_else(|| text(sender, "id"))
            .unwrap_or_default()
            .to_owned()
    }

    /// the per-tree circuit breaker: a paused tree sends only to the human; past the caps it pauses
    async fn tree_guard(
        &self,
        sender: &Row,
        sends: i64,
        now: i64,
        to: &[String],
    ) -> Result<(), RpcError> {
        let from = text(sender, "id").unwrap_or_default();
        let tree = Self::tree_of(sender);
        let root = self.by_id(&tree).await?;
        let name = root.as_ref().map(address).unwrap_or_else(|| tree.clone());
        let blocked = self
            .store
            .all(
                "SELECT until FROM blocks WHERE pair = ? AND until > ?",
                &[string(format!("tree:{tree}")), SqlValue::Int(now)],
            )
            .await?;
        if let Some(until) = blocked.first().and_then(|r| integer(r, "until")) {
            return Err(self
                .refuse(
                    from,
                    ErrorCode::LoopGuard,
                    format!("the tree of {name} is paused: it sent too many messages; only the human can be messaged"),
                    Some(ceil_s(until - now)),
                    json!({"to": to, "tree": name, "until": timestamp(until)}),
                )
                .await?);
        }
        let per_minute = self.rate("treePerMinute");
        let per_hour = self.rate("treePerHour");
        if per_minute.is_none() && per_hour.is_none() {
            return Ok(());
        }
        let tree_key = string(&tree);
        let mut counts = [0, 0];
        for (slot, (limit, window)) in [(per_minute, 60), (per_hour, 3600)].into_iter().enumerate()
        {
            if limit.is_some() {
                counts[slot] = self
                    .count(
                        "SELECT COUNT(*) AS n FROM tree_events WHERE tree = ? AND at > ?",
                        &[tree_key.clone(), SqlValue::Int(now - window * 1000)],
                    )
                    .await?
                    .0;
            }
        }
        let [minute, hour] = counts;
        let over_minute = per_minute.is_some_and(|limit| minute + sends > limit);
        let over_hour = per_hour.is_some_and(|limit| hour + sends > limit);
        if !over_minute && !over_hour {
            return Ok(());
        }
        let pause = self.rate("treePauseS").unwrap_or(600);
        let until = now + pause * 1000;
        self.store
            .all(
                "INSERT OR REPLACE INTO blocks (pair, until) VALUES (?, ?)",
                &[string(format!("tree:{tree}")), SqlValue::Int(until)],
            )
            .await?;
        self.audit(
            "loop_guard",
            Some(from),
            None,
            json!({"tree": name, "minute": minute, "hour": hour, "until": timestamp(until)}),
        )
        .await?;
        let minutes = pause as f64 / 60.0;
        let notice = format!(
            "relay paused the tree of {name} for {minutes} minutes: {minute} messages in the last minute, {hour} in the last hour. Messages to the human still pass."
        );
        self.notice(&notice, None).await?;
        if let Some(root) = root.as_ref()
            && text(root, "kind") == Some("agent")
            && !text(root, "handle").unwrap_or("").starts_with("_gone_")
        {
            self.notice(&notice, Some(root)).await?;
        }
        let (limit, window) = if over_minute {
            (per_minute, 60)
        } else {
            (per_hour, 3600)
        };
        Err(self
            .refuse(
                from,
                ErrorCode::LoopGuard,
                format!(
                    "the tree of {name} sent too many messages and is paused for {minutes} minutes"
                ),
                Some(pause),
                json!({"to": to, "tree": name, "limit": limit, "window_s": window}),
            )
            .await?)
    }

    /// records a written send for the pair and tree counters
    pub async fn record_send(
        &self,
        sender: &Row,
        recipient: &Row,
        tree_send: bool,
        now: i64,
    ) -> Result<(), RpcError> {
        let from = text(sender, "id").unwrap_or_default();
        let to = text(recipient, "id").unwrap_or_default();
        self.store
            .all(
                "INSERT INTO pair_events (from_ep, to_ep, at) VALUES (?, ?, ?)",
                &[string(from), string(to), SqlValue::Int(now)],
            )
            .await?;
        if tree_send && text(recipient, "kind") != Some("human") {
            self.store
                .all(
                    "INSERT INTO tree_events (tree, at) VALUES (?, ?)",
                    &[string(Self::tree_of(sender)), SqlValue::Int(now)],
                )
                .await?;
        }
        Ok(())
    }

    pub async fn record_group(&self, name: &str, now: i64) -> Result<(), RpcError> {
        self.store
            .all(
                "INSERT INTO tree_events (tree, at) VALUES (?, ?)",
                &[string(format!("group:{name}")), SqlValue::Int(now)],
            )
            .await?;
        Ok(())
    }

    /// pauses a pair that went back and forth more than pingPongAlternations times in the window
    pub async fn detect_ping_pong(&self, a: &Row, b: &Row, now: i64) -> Result<(), RpcError> {
        let (Some(first), Some(second)) = (text(a, "id"), text(b, "id")) else {
            return Ok(());
        };
        let Some(alternations_max) = self.rate("pingPongAlternations") else {
            return Ok(());
        };
        if first == second {
            return Ok(());
        }
        let window = self.rate("pingPongWindowS").unwrap_or(600);
        let events = self
            .store
            .all(
                "SELECT from_ep FROM pair_events WHERE ((from_ep = ? AND to_ep = ?) OR (from_ep = ? AND to_ep = ?)) AND at > ? ORDER BY at, rowid",
                &[string(first), string(second), string(second), string(first), SqlValue::Int(now - window * 1000)],
            )
            .await?;
        let alternations = events
            .windows(2)
            .filter(|pair| text(&pair[0], "from_ep") != text(&pair[1], "from_ep"))
            .count() as i64;
        if alternations < alternations_max {
            return Ok(());
        }
        let block = self.rate("pingPongBlockS").unwrap_or(600);
        let until = now + block * 1000;
        self.store
            .all(
                "INSERT OR REPLACE INTO blocks (pair, until) VALUES (?, ?)",
                &[string(pair_key(first, second)), SqlValue::Int(until)],
            )
            .await?;
        self.store
            .all(
                "DELETE FROM pair_events WHERE (from_ep = ? AND to_ep = ?) OR (from_ep = ? AND to_ep = ?)",
                &[string(first), string(second), string(second), string(first)],
            )
            .await?;
        self.audit(
            "loop_guard",
            Some(first),
            None,
            json!({"with": address(b), "alternations": alternations, "until": timestamp(until)}),
        )
        .await?;
        self.notice(
            &format!(
                "relay paused messages between {} and {} for {} minutes: they went back and forth {alternations} times in {} minutes.",
                address(a),
                address(b),
                block as f64 / 60.0,
                window as f64 / 60.0
            ),
            None,
        )
        .await
    }

    /// a pair's live loop and rate limits, shaped for `why`
    pub async fn pair_state(&self, a: &str, b: &str, now: i64) -> Result<PairState, RpcError> {
        let first = self.address_of(a).await?;
        let second = self.address_of(b).await?;
        let mut pair = PairLimits::default();
        let mut lines = Vec::new();
        let blocked = self
            .store
            .all(
                "SELECT until FROM blocks WHERE pair = ? AND until > ?",
                &[string(pair_key(a, b)), SqlValue::Int(now)],
            )
            .await?;
        if let Some(until) = blocked.first().and_then(|r| integer(r, "until")) {
            let at = timestamp(until).unwrap_or_default();
            lines.push(format!(
                "paused until {at}: {first} and {second} went back and forth too often"
            ));
            pair.paused_until = Some(at);
        }
        if let Some(limit) = self.rate("pairBurst") {
            let (n, _) = self.pair_burst(a, b, now).await?;
            if n >= limit {
                let window = LIMITS.pair_burst_window_s;
                lines.push(format!(
                    "burst: {n} messages between {first} and {second} in {window} s (limit {limit})"
                ));
                pair.burst = Some(PairBurst {
                    n: n as u64,
                    limit: limit as u64,
                    window_s: window,
                });
            }
        }
        let rows = self
            .store
            .all(
                "SELECT at, endpoint, detail FROM audit WHERE event = 'refuse' AND endpoint IN (?, ?) ORDER BY id DESC LIMIT 500",
                &[string(a), string(b)],
            )
            .await?;
        for row in rows {
            let detail: Value =
                serde_json::from_str(text(&row, "detail").unwrap_or("{}")).unwrap_or(Value::Null);
            let other = if text(&row, "endpoint") == Some(a) {
                &second
            } else {
                &first
            };
            let code = detail["code"].as_str().unwrap_or("");
            let names = detail["to"]
                .as_array()
                .is_some_and(|to| to.iter().any(|v| v.as_str() == Some(other.as_str())));
            if !matches!(code, "loop_guard" | "rate_limited") || !names {
                continue;
            }
            let refused = PairRefusal {
                at: integer(&row, "at").and_then(timestamp).unwrap_or_default(),
                code: code.to_owned(),
                message: detail["message"].as_str().unwrap_or("").to_owned(),
            };
            lines.push(format!(
                "last refused {}: {}: {}",
                refused.at, refused.code, refused.message
            ));
            pair.refused = Some(refused);
            break;
        }
        Ok(PairState {
            held: pair.paused_until.is_some() || pair.burst.is_some(),
            pair: (!lines.is_empty()).then_some(pair),
            lines,
        })
    }
}
