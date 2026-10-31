use scp_core::protocol::{ErrorCode, LIMITS};
use serde_json::{Map, Value, json};

use crate::authority::Actor;
use crate::core::{Core, integer, now_ms, text, timestamp};
use crate::messages::unreachable;
use crate::proto::RpcError;
use crate::scrub::{
    clip, drop_quoted, redact_secrets, strip_control, strip_relay_spans, strip_steer_note,
};
use crate::state::{ConnectionId, Mode};
use crate::store::{Row, SqlValue};
use crate::views::{address, opt};
use crate::world::World;

const RING: i64 = 20;
const STORE_CHARS: usize = 2000;
const TURN_CHARS: usize = 600;
const FULL_CHARS: usize = 2000;
const TOTAL_BYTES: usize = 8 * 1024;
const TURNS_DEFAULT: i64 = 3;
const TURNS_MAX: i64 = 10;
const WHO_KEEP: i64 = 50;
const STATE_KEEP: i64 = 5;
const TOOLS_KEEP: i64 = 20;
const QUOTE_BODIES: i64 = 50;

fn sv(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

/// a turn's text as stored
pub fn digest_text(raw: &str, delivered: &[String]) -> String {
    let raw_chars = LIMITS.body_bytes as usize;
    let cut: String = strip_steer_note(raw).chars().take(raw_chars).collect();
    let cleaned = strip_relay_spans(&strip_control(&cut));
    let bodies: Vec<String> = delivered.iter().map(|b| strip_control(b)).collect();
    clip(
        &redact_secrets(&drop_quoted(&cleaned, &bodies)),
        STORE_CHARS,
    )
    .0
}

/// a stored turn's text as read
pub fn read_text(stored: &str, max: usize) -> (String, bool) {
    clip(
        &redact_secrets(&strip_relay_spans(&strip_control(stored))),
        max,
    )
}

fn peek_level(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        Some(Value::String(v)) if v == "on" || v == "local" => Some(Some("local".to_owned())),
        Some(Value::String(v)) if v == "off" => Some(None),
        _ => None,
    }
}

fn actor_detail(actor: &Actor, me: &Row) -> Value {
    json!({"by": address(me), "auth": actor.auth()})
}

/// whether `me` may peek `target`; `tty` is the human at a terminal
pub fn may_peek_world(world: &World, me: &Row, target: &Row, tty: bool) -> bool {
    if text(target, "kind") != Some("agent") {
        return false;
    }
    let me_id = text(me, "id").unwrap_or_default();
    let target_id = text(target, "id").unwrap_or_default();
    if target_id == me_id || (text(me, "kind") == Some("human") && tty) {
        return true;
    }
    if text(target, "peek").is_none() {
        return false;
    }
    if text(me, "kind") == Some("human") {
        world.may_message(me_id, target_id, true, false)
    } else {
        world.may_message(me_id, target_id, false, false) || world.authority(me_id, target_id)
    }
}

impl Core {
    async fn peek_target(&self, value: Option<&Value>) -> Result<Row, RpcError> {
        let raw = value
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| RpcError::invalid_params("endpoint is an address"))?;
        let row = self.lookup(raw).await?;
        if text(&row, "kind") != Some("agent") {
            return Err(unreachable(raw));
        }
        Ok(row)
    }

    async fn peeked_by(&self, endpoint: &str, limit: i64) -> Result<Vec<Value>, RpcError> {
        let rows = self
            .store
            .all(
                "SELECT at, detail FROM audit WHERE event = 'peek' AND endpoint = ? ORDER BY id DESC LIMIT ?",
                &[sv(endpoint), SqlValue::Int(limit)],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let detail: Value = text(row, "detail")
                    .and_then(|v| serde_json::from_str(v).ok())
                    .unwrap_or(json!({}));
                json!({
                    "at": integer(row, "at").and_then(timestamp),
                    "by": detail.get("by").and_then(Value::as_str).unwrap_or(""),
                    "auth": detail.get("auth").and_then(Value::as_str).unwrap_or(""),
                    "turns": detail.get("turns").and_then(Value::as_i64).unwrap_or(0),
                })
            })
            .collect())
    }

    /// an endpoint's own peek level and the last few who peeked it
    pub async fn peek_state(&self, endpoint: &str) -> Result<Value, RpcError> {
        let row = self.must_endpoint(endpoint).await?;
        let peeked = self
            .peeked_by(text(&row, "id").unwrap_or_default(), STATE_KEEP)
            .await?;
        Ok(
            json!({"peek": text(&row, "peek").map_or(Value::Null, |v| json!(v)), "peeked_by": peeked}),
        )
    }

    /// the refused link a claim asked for, for whoami; empty when there is none
    pub async fn link_pending_of(&self, endpoint: &str) -> Result<Option<Value>, RpcError> {
        let row = self.must_endpoint(endpoint).await?;
        Ok(Self::link_pending_row(&row).map(|pending| json!(pending)))
    }

    /// a hook's digest turn for its own endpoint
    pub async fn peek_turn(
        &self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let connection = self.connection(conn)?;
        let endpoint = connection
            .endpoint
            .clone()
            .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "call hello first"))?;
        let row = self.must_endpoint(&endpoint).await?;
        let owns = connection.mode == Mode::Transient
            && self.hook_owns(&row, connection.process.as_deref());
        if !owns {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "only a hook of the endpoint's own harness process posts digest turns",
            ));
        }
        let role = params
            .get("role")
            .and_then(Value::as_str)
            .filter(|v| *v == "user" || *v == "assistant")
            .ok_or_else(|| RpcError::invalid_params("role is user or assistant"))?;
        let raw = params
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid_params("text is a string"))?;
        if text(&row, "kind") != Some("agent") || text(&row, "peek").is_none() {
            return Ok(json!({"stored": false}));
        }
        let id = text(&row, "id").unwrap_or_default();
        let delivered: Vec<String> = self
            .store
            .all(
                "SELECT m.body AS body FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND m.created_at > ? ORDER BY d.seq DESC LIMIT ?",
                &[
                    sv(id),
                    SqlValue::Int(integer(&row, "reset_at").unwrap_or(-1)),
                    SqlValue::Int(QUOTE_BODIES),
                ],
            )
            .await?
            .iter()
            .filter_map(|r| text(r, "body").map(str::to_owned))
            .collect();
        let stored = digest_text(raw, &delivered);
        if stored.trim().is_empty() {
            return Ok(json!({"stored": false}));
        }
        self.store
            .all(
                "INSERT INTO peek_turns (endpoint, at, role, text) VALUES (?, ?, ?, ?)",
                &[sv(id), SqlValue::Int(now_ms()), sv(role), sv(&stored)],
            )
            .await?;
        self.store
            .all(
                "DELETE FROM peek_turns WHERE endpoint = ? AND id NOT IN (SELECT id FROM peek_turns WHERE endpoint = ? ORDER BY id DESC LIMIT ?)",
                &[sv(id), sv(id), SqlValue::Int(RING)],
            )
            .await?;
        Ok(json!({"stored": true}))
    }

    /// an endpoint's peek level
    pub async fn peek_set(
        &self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let me = self.actor_endpoint(&actor).await?;
        let level = peek_level(params.get("level"))
            .ok_or_else(|| RpcError::invalid_params("level is on, local or off"))?;
        let endpoint_param = match params.get("endpoint") {
            None | Some(Value::Null) => None,
            Some(Value::String(v)) => Some(v.clone()),
            Some(_) => return Err(RpcError::invalid_params("endpoint must be a string")),
        };
        let target = match &endpoint_param {
            None => {
                if text(&me, "kind") != Some("agent") {
                    return Err(RpcError::invalid_params("the human names the endpoint"));
                }
                me.clone()
            }
            Some(raw) => self.peek_target(Some(&Value::String(raw.clone()))).await?,
        };
        let me_id = text(&me, "id").unwrap_or_default().to_owned();
        let target_id = text(&target, "id").unwrap_or_default().to_owned();
        if text(&me, "kind") == Some("agent") && target_id != me_id {
            let world = self.world().await?;
            if !world.authority(&me_id, &target_id) {
                return Err(unreachable(endpoint_param.as_deref().unwrap_or("")));
            }
        }
        let target_address = address(&target);
        let before = text(&target, "peek").map(str::to_owned);
        if level == before {
            return Ok(json!({"endpoint": target_address, "peek": level}));
        }
        if level.is_some() {
            let own = target_id == me_id
                && matches!(&actor, Actor::Endpoint { auth, .. } if *auth != "lineage");
            if !own && !actor.at_terminal() {
                return Err(self
                    .refused(
                        &actor,
                        &me,
                        json!({"target": target_address, "reason": "peek raise"}),
                        "only the endpoint itself or the human at a terminal turns peek on",
                    )
                    .await);
            }
        }
        self.store
            .all(
                "UPDATE endpoints SET peek = ? WHERE id = ?",
                &[opt(level.as_deref()), sv(&target_id)],
            )
            .await?;
        if level.is_none() {
            self.store
                .all(
                    "DELETE FROM peek_turns WHERE endpoint = ?",
                    &[sv(&target_id)],
                )
                .await?;
        }
        let mut detail = actor_detail(&actor, &me);
        if let Some(obj) = detail.as_object_mut() {
            obj.insert("target".into(), json!(target_address));
            obj.insert("before".into(), before.map_or(Value::Null, |v| json!(v)));
            obj.insert(
                "after".into(),
                level.clone().map_or(Value::Null, |v| json!(v)),
            );
        }
        self.audit("peek_set", Some(&target_id), None, detail)
            .await?;
        Ok(json!({"endpoint": target_address, "peek": level}))
    }

    async fn tools_between(
        &self,
        endpoint: &str,
        after: i64,
        until: i64,
    ) -> Result<Vec<String>, RpcError> {
        let rows = self
            .store
            .all(
                "SELECT tool FROM activity WHERE endpoint = ? AND kind = 'tool' AND tool IS NOT NULL AND at > ? AND at <= ? ORDER BY id DESC LIMIT ?",
                &[
                    sv(endpoint),
                    SqlValue::Int(after),
                    SqlValue::Int(until),
                    SqlValue::Int(TOOLS_KEEP),
                ],
            )
            .await?;
        let mut tools: Vec<String> = rows
            .iter()
            .filter_map(|r| text(r, "tool").map(str::to_owned))
            .collect();
        tools.reverse();
        Ok(tools)
    }

    /// another endpoint's last turns
    pub async fn peek(
        &self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let me = self.actor_endpoint(&actor).await?;
        let turns: i64 = match params.get("turns") {
            None | Some(Value::Null) => TURNS_DEFAULT,
            Some(v)
                if v.as_f64()
                    .is_some_and(|n| n.fract() == 0.0 && (1.0..=10.0).contains(&n)) =>
            {
                v.as_f64().expect("checked number") as i64
            }
            Some(_) => {
                return Err(RpcError::invalid_params(format!(
                    "turns is 1 to {TURNS_MAX}"
                )));
            }
        };
        let endpoint_raw = params
            .get("endpoint")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let target = self.peek_target(params.get("endpoint")).await?;
        let tty = actor.at_terminal();
        let me_id = text(&me, "id").unwrap_or_default().to_owned();
        let target_id = text(&target, "id").unwrap_or_default().to_owned();
        let world = self.world().await?;
        if !may_peek_world(&world, &me, &target, tty) {
            return Err(unreachable(&endpoint_raw));
        }
        let now = now_ms();
        if !tty {
            for (name, window_s, pair) in [
                ("peekPairPerMinute", 60i64, true),
                ("peekTargetPerHour", 3600i64, false),
            ] {
                let Some(limit) = self.rate(name) else {
                    continue;
                };
                let (n, first) = if pair {
                    let rows = self
                        .store
                        .all(
                            "SELECT COUNT(*) AS n, MIN(at) AS first FROM audit WHERE event = 'peek' AND endpoint = ? AND at > ? AND ref = ? AND json_extract(detail, '$.auth') != 'tty'",
                            &[sv(&target_id), SqlValue::Int(now - window_s * 1000), sv(&me_id)],
                        )
                        .await?;
                    (
                        rows.first().and_then(|r| integer(r, "n")).unwrap_or(0),
                        rows.first().and_then(|r| integer(r, "first")),
                    )
                } else {
                    let rows = self
                        .store
                        .all(
                            "SELECT COUNT(*) AS n, MIN(at) AS first FROM audit WHERE event = 'peek' AND endpoint = ? AND at > ? AND json_extract(detail, '$.auth') != 'tty'",
                            &[sv(&target_id), SqlValue::Int(now - window_s * 1000)],
                        )
                        .await?;
                    (
                        rows.first().and_then(|r| integer(r, "n")).unwrap_or(0),
                        rows.first().and_then(|r| integer(r, "first")),
                    )
                };
                if n >= limit {
                    let after = ((first.unwrap_or(now) + window_s * 1000 - now) as f64 / 1000.0)
                        .ceil()
                        .max(1.0) as i64;
                    let what = if pair {
                        "of this endpoint"
                    } else {
                        "of it by anyone"
                    };
                    return Err(self
                        .refuse(
                            &me_id,
                            ErrorCode::RateLimited,
                            format!("{limit} peeks {what} in {window_s} s: retry after {after} s"),
                            Some(after),
                            json!({"limit": limit, "window_s": window_s}),
                        )
                        .await?);
                }
            }
        }
        let mut rows = self
            .store
            .all(
                "SELECT at, role, text FROM peek_turns WHERE endpoint = ? ORDER BY id DESC LIMIT ?",
                &[sv(&target_id), SqlValue::Int(turns + 1)],
            )
            .await?;
        rows.reverse();
        let since = integer(&target, "reset_at").unwrap_or(0);
        let max = if params.get("full") == Some(&Value::Bool(true)) {
            FULL_CHARS
        } else {
            TURN_CHARS
        };
        let mut truncated = rows.len() as i64 > turns;
        let over = rows.len().saturating_sub(turns as usize);
        let shown_rows = &rows[over..];
        let mut shown: Vec<Value> = Vec::new();
        for (i, row) in shown_rows.iter().enumerate() {
            let at = integer(row, "at").unwrap_or(0);
            let prev = if i > 0 {
                integer(&shown_rows[i - 1], "at").unwrap_or(0)
            } else if rows.len() as i64 > turns {
                integer(&rows[0], "at").unwrap_or(0)
            } else {
                since
            };
            let (txt, cut) = read_text(text(row, "text").unwrap_or(""), max);
            if cut {
                truncated = true;
            }
            let tools = if text(row, "role") == Some("assistant") {
                self.tools_between(&target_id, prev.max(since - 1), at)
                    .await?
            } else {
                Vec::new()
            };
            shown.push(json!({
                "role": text(row, "role"),
                "at": timestamp(at),
                "text": txt,
                "tools": tools,
            }));
        }
        let size = |shown: &[Value]| -> usize {
            shown
                .iter()
                .map(|t| t.get("text").and_then(Value::as_str).map_or(0, str::len))
                .sum()
        };
        while shown.len() > 1 && size(&shown) > TOTAL_BYTES {
            shown.remove(0);
            truncated = true;
        }
        let last_at = rows.last().and_then(|r| integer(r, "at"));
        let recent = self
            .tools_between(&target_id, last_at.unwrap_or(since - 1).max(since - 1), now)
            .await?;
        let view = self.endpoint_view(&target)?;
        let unread = self
            .store
            .all(
                "SELECT COUNT(*) AS n FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ?",
                &[sv(&target_id), SqlValue::Int(now)],
            )
            .await?
            .first()
            .and_then(|r| integer(r, "n"))
            .unwrap_or(0);
        let source = if shown.is_empty() { "status" } else { "digest" };
        let bytes = size(&shown);
        let result = json!({
            "endpoint": address(&target),
            "at": timestamp(now),
            "level": text(&target, "peek").map_or(Value::Null, |v| json!(v)),
            "source": source,
            "turns": shown,
            "recent_tools": recent,
            "status": view.get("status").cloned().unwrap_or(Value::Null),
            "title": view.get("title").cloned().unwrap_or(Value::Null),
            "unread": unread,
            "truncated": truncated,
        });
        let shown_len = result
            .get("turns")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        let mut detail = actor_detail(&actor, &me);
        if let Some(obj) = detail.as_object_mut() {
            obj.insert("turns".into(), json!(shown_len));
            obj.insert("bytes".into(), json!(bytes));
            obj.insert("source".into(), json!(source));
            obj.insert(
                "level".into(),
                text(&target, "peek").map_or(Value::Null, |v| json!(v)),
            );
        }
        self.audit("peek", Some(&target_id), Some(&me_id), detail)
            .await?;
        Ok(result)
    }

    /// who peeked an endpoint
    pub async fn peek_who(
        &self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let me = self.actor_endpoint(&actor).await?;
        let endpoint_param = match params.get("endpoint") {
            None | Some(Value::Null) => None,
            Some(Value::String(v)) => Some(v.clone()),
            Some(_) => return Err(RpcError::invalid_params("endpoint must be a string")),
        };
        let target = match &endpoint_param {
            None => {
                if text(&me, "kind") != Some("agent") {
                    return Err(RpcError::invalid_params("the human names the endpoint"));
                }
                me.clone()
            }
            Some(raw) => self.peek_target(Some(&Value::String(raw.clone()))).await?,
        };
        let me_id = text(&me, "id").unwrap_or_default().to_owned();
        let target_id = text(&target, "id").unwrap_or_default().to_owned();
        let world = self.world().await?;
        let allowed = target_id == me_id
            || if text(&me, "kind") == Some("agent") {
                world.authority(&me_id, &target_id)
            } else {
                actor.at_terminal() || world.may_message(&me_id, &target_id, true, false)
            };
        if !allowed {
            return Err(unreachable(endpoint_param.as_deref().unwrap_or("")));
        }
        Ok(json!({"peeked_by": self.peeked_by(&target_id, WHO_KEEP).await?}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_scrubs_and_clips() {
        let secret = format!("ghp_{}", "A1b2C3d4".repeat(5));
        let out = digest_text(
            &format!("before <relay-message from=\"me/z\">plan</relay-message> after {secret}"),
            &[],
        );
        assert_eq!(
            out,
            "before [relay message omitted] after [redacted github token]"
        );
        let long = digest_text(&format!("{} {secret} tail", "word ".repeat(398)), &[]);
        assert!(long.chars().count() <= 2000);
        assert!(!long.contains("ghp_"));
        let (read, _) = read_text(&long, 600);
        assert!(read.chars().count() <= 600);
        assert!(!read.ends_with("wor..."));
    }

    #[tokio::test]
    async fn dispatch_round_trip() {
        use crate::paths::Paths;
        use crate::proto::Limits;
        use crate::store::sqlite::SqliteStore;
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!("scp-peek-{:032x}", rand::random::<u128>()));
        tokio::fs::create_dir(&dir).await.expect("directory");
        let paths = Paths::new(dir.clone());
        let store = Arc::new(SqliteStore::open(&paths.database).expect("store"));
        let mut core = Core::new(store, Limits::default(), paths, dir.join("policy.json"))
            .await
            .expect("core");
        for (id, handle, kind) in [("ep-lane", "lane", "agent"), ("ep-other", "other", "agent")] {
            core.store
                .all(
                    "INSERT INTO endpoints (id, handle, kind, harness, labels, created_at, process) VALUES (?, ?, ?, 'claude-code', '{}', 1, 'pid:300:Fri-Oct-17-09:00:00-2026')",
                    &[sv(id), sv(handle), sv(kind)],
                )
                .await
                .expect("seed");
        }
        let conn = |core: &mut Core, endpoint: &str, mode: Mode, process: Option<&str>| {
            let id = core.state.connect();
            let connection = core.state.connections.get_mut(&id).expect("connection");
            connection.endpoint = Some(endpoint.to_owned());
            connection.mode = mode;
            connection.process = process.map(str::to_owned);
            id
        };
        let lane = conn(&mut core, "ep-lane", Mode::Agent, None);
        let other = conn(&mut core, "ep-other", Mode::Agent, None);
        let hook = conn(
            &mut core,
            "ep-lane",
            Mode::Transient,
            Some("pid:300:Fri-Oct-17-09:00:00-2026"),
        );
        let params = |value: Value| value.as_object().expect("params").clone();
        let turn = params(
            json!({"role": "user", "text": "before <relay-message from=\"me/z\">plan</relay-message> after"}),
        );
        assert_eq!(
            core.dispatch(hook, "peek_turn", &turn)
                .await
                .expect("turn while off"),
            json!({"stored": false})
        );
        assert_eq!(
            core.dispatch(lane, "peek_set", &params(json!({"level": "on"})))
                .await
                .expect("peek_set"),
            json!({"endpoint": "me/lane", "peek": "local"})
        );
        assert_eq!(
            core.dispatch(hook, "peek_turn", &turn).await.expect("turn"),
            json!({"stored": true})
        );
        let seen = core
            .dispatch(other, "peek", &params(json!({"endpoint": "lane"})))
            .await
            .expect("peek");
        assert_eq!(seen["source"], json!("digest"));
        assert_eq!(
            seen["turns"][0]["text"],
            json!("before [relay message omitted] after")
        );
        let whoami = core
            .dispatch(lane, "whoami", &params(json!({})))
            .await
            .expect("whoami");
        assert_eq!(whoami["peek"], json!("local"));
        assert_eq!(whoami["peeked_by"][0]["by"], json!("me/other"));
        let hook_whoami = core
            .dispatch(hook, "whoami", &params(json!({})))
            .await
            .expect("hook whoami");
        assert!(hook_whoami.get("peek").is_none());
        core.dispatch(lane, "peek_set", &params(json!({"level": "off"})))
            .await
            .expect("off");
        core.dispatch(lane, "peek_set", &params(json!({"level": "on"})))
            .await
            .expect("on again");
        let empty = core
            .dispatch(lane, "peek", &params(json!({"endpoint": "lane"})))
            .await
            .expect("empty peek");
        assert_eq!(empty["source"], json!("status"));
        assert_eq!(empty["turns"], json!([]));
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[test]
    fn levels_parse() {
        assert_eq!(
            peek_level(Some(&json!("on"))),
            Some(Some("local".to_owned()))
        );
        assert_eq!(peek_level(Some(&json!("off"))), Some(None));
        assert_eq!(peek_level(Some(&json!("account"))), None);
    }
}
