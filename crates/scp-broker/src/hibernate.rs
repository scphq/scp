//! Hibernation: a provider suspends a local agent's session and its wake hook resumes it once mail arrives.

use scp_core::protocol::{ErrorCode, SPAWN_PROVIDER};
use serde_json::{Map, Value, json};

use crate::authority::Actor;
use crate::claims::{harness_fits, hash, valid_harness, valid_token};
use crate::core::{Core, integer, now_ms, text};
use crate::proto::RpcError;
use crate::scrub::find_secret;
use crate::state::ConnectionId;
use crate::store::{Row, SqlValue};
use crate::views::{address, session_presence};

/// how many earlier wake tickets a revivable hibernation keeps valid
const REVIVE_TICKETS_KEPT: usize = 16;

pub(crate) const CLEAR_HIBERNATION: &str = "UPDATE endpoints SET hibernate = NULL, wake_ref = NULL, wake_eta = NULL, hibernated_at = NULL, wake_tried = NULL, wake_fails = 0, wake_note = NULL, wake_declined = NULL, declined_message = NULL, declined_from = NULL, wake_ticket = NULL, wake_tickets = NULL, revive = NULL WHERE id = ?";

/// a hibernation to set: the provider (or `none`), its opaque ref and the wake time it announced
pub struct Hibernation {
    pub wake: String,
    pub reference: Option<String>,
    pub eta: Option<i64>,
}

/// a provider name: lowercase letters, digits and hyphens, at most 32
pub fn wake_provider(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn revive_session(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// the revive record `{harness, session, cwd, argv, via?}` a hibernation ref holds
pub fn revive_record(reference: Option<&str>) -> Option<Map<String, Value>> {
    let reference = reference.filter(|r| r.starts_with('{'))?;
    let record = serde_json::from_str::<Value>(reference).ok()?;
    let record = record.as_object()?;
    let harness = record.get("harness")?.as_str()?;
    let session = record.get("session")?.as_str()?;
    let cwd = record.get("cwd")?.as_str()?;
    let argv = record.get("argv")?.as_array()?;
    if !valid_harness(harness)
        || !revive_session(session)
        || !cwd.starts_with('/')
        || argv.is_empty()
        || !argv.iter().all(Value::is_string)
    {
        return None;
    }
    let mut out = Map::new();
    for key in ["harness", "session", "cwd", "argv"] {
        out.insert(key.into(), record[key].clone());
    }
    match record.get("via") {
        None => {}
        Some(Value::String(via)) if valid_harness(via) => {
            out.insert("via".into(), json!(via));
        }
        Some(_) => return None,
    }
    Some(out)
}

/// how a hibernation's session was started when its ref is a revive record: the record's `via`, else the provider
pub fn revive_via(reference: Option<&str>, provider: &str) -> Option<String> {
    revive_record(reference).map(|record| {
        record
            .get("via")
            .and_then(Value::as_str)
            .unwrap_or(provider)
            .to_owned()
    })
}

pub fn revivable(row: &Row) -> bool {
    crate::claims::revivable(row)
}

fn sv(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

impl Core {
    // bridge seam
    pub(crate) fn bridge_changed(&self, _endpoint: &str) {}

    // bridge seam
    pub(crate) async fn bridge_mirror(&self, _ids: Vec<String>) -> Option<bool> {
        None
    }

    /// a provider's opaque reference to a session: bounded, without control characters or a credential
    pub(crate) fn wake_ref(&self, value: &Value) -> Result<String, RpcError> {
        let max = self.cap("wakeRefChars", 512) as usize;
        let text = value
            .as_str()
            .filter(|v| v.encode_utf16().count() <= max && !v.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}'))
            .ok_or_else(|| {
                RpcError::invalid_params(format!(
                    "ref is a string of at most {max} characters with no control characters"
                ))
            })?;
        if find_secret(text).is_some() {
            return Err(RpcError::new(
                ErrorCode::SecretRefused,
                "the wake ref looks like it carries a credential",
            ));
        }
        Ok(text.to_owned())
    }

    fn hibernation(&self, params: &Map<String, Value>) -> Result<Hibernation, RpcError> {
        let wake = params
            .get("wake")
            .and_then(Value::as_str)
            .filter(|w| *w == "none" || wake_provider(w))
            .ok_or_else(|| {
                RpcError::invalid_params(
                    "wake is a provider name (lowercase letters, digits and hyphens, at most 32) or none",
                )
            })?;
        let reference = match params.get("ref") {
            None | Some(Value::Null) => None,
            Some(value) => Some(self.wake_ref(value)?),
        };
        let max = self.cap("wakeEtaMaxS", 3600);
        let eta = match params.get("eta_s") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_f64()
                    .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= max as f64)
                    .map(|n| n as i64)
                    .ok_or_else(|| {
                        RpcError::invalid_params(format!(
                            "eta_s is a whole number of seconds from 1 to {max}"
                        ))
                    })?,
            ),
        };
        if wake != "none" && !self.wakers.known(wake) {
            return Err(RpcError::invalid_params(format!(
                "no waker {wake} is configured"
            )));
        }
        Ok(Hibernation {
            wake: wake.to_owned(),
            reference,
            eta,
        })
    }

    /// `hibernate`: an agent hibernates itself, the human one agent or, with `all`, every live local agent
    pub async fn hibernate_rpc(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let all = match params.get("all") {
            None => false,
            Some(Value::Bool(true)) => true,
            Some(_) => return Err(RpcError::invalid_params("all is true or absent")),
        };
        if all && params.contains_key("endpoint") {
            return Err(RpcError::invalid_params("all names no endpoint"));
        }
        let actor = self.actor_of(conn)?;
        let me = self.actor_row(conn).await?;
        let views = if all {
            if !matches!(actor, Actor::Human { .. }) {
                return Err(RpcError::new(
                    ErrorCode::ScopeRefused,
                    "only the human hibernates every agent",
                ));
            }
            let set = self.hibernation(params)?;
            if set.wake == SPAWN_PROVIDER {
                return Err(RpcError::invalid_params(format!(
                    "{SPAWN_PROVIDER} hibernates only a durably held worker, by its own ref"
                )));
            }
            let now = now_ms();
            let rows = self.store.all("SELECT * FROM endpoints WHERE kind = 'agent' AND substr(handle,1,6) != '_gone_' AND substr(handle,1,5) != 'gone:' AND (session IS NULL OR substr(session,1,4) != 'sub:') ORDER BY handle", &[]).await?;
            let mut views = Vec::new();
            for row in rows {
                let take = if set.wake == "none" {
                    text(&row, "hibernate").is_some()
                } else {
                    session_presence(&row, now) != "offline"
                };
                if take {
                    views.push(self.set_hibernation(Some(&me), &row, &set).await?);
                }
            }
            views
        } else {
            let set = self.hibernation(params)?;
            if matches!(actor, Actor::Endpoint { auth: "lineage", .. }) {
                return Err(RpcError::new(
                    ErrorCode::ScopeRefused,
                    "only the session itself hibernates: run this from the session's own shell",
                ));
            }
            let target = match params.get("endpoint") {
                None => {
                    if text(&me, "kind") != Some("agent") {
                        return Err(RpcError::invalid_params("the human names the endpoint"));
                    }
                    me.clone()
                }
                Some(value) => {
                    self.lookup(
                        value
                            .as_str()
                            .ok_or_else(|| RpcError::invalid_params("endpoint is an address"))?,
                    )
                    .await?
                }
            };
            if matches!(actor, Actor::Endpoint { .. }) && text(&target, "id") != text(&me, "id") {
                return Err(RpcError::new(
                    ErrorCode::ScopeRefused,
                    "an agent hibernates only itself",
                ));
            }
            if text(&target, "kind") != Some("agent") {
                return Err(RpcError::invalid_params(
                    "only a local agent endpoint hibernates",
                ));
            }
            if set.wake == SPAWN_PROVIDER
                && (text(&target, "hold_ref").is_none()
                    || set.reference.as_deref() != text(&target, "hold_ref"))
            {
                return Err(RpcError::invalid_params(format!(
                    "{SPAWN_PROVIDER} hibernates only a durably held worker, with the ref its hold gave"
                )));
            }
            vec![self.set_hibernation(Some(&me), &target, &set).await?]
        };
        let ids: Vec<String> = views
            .iter()
            .filter_map(|v| v["id"].as_str().map(str::to_owned))
            .collect();
        for id in &ids {
            self.presence_moved(id, true, false).await?;
            self.bridge_changed(id);
        }
        let mirrored = self.bridge_mirror(ids.clone()).await.unwrap_or(false);
        for id in &ids {
            self.wakers.kick(id);
        }
        let mut result = if all {
            json!({"endpoints": views})
        } else {
            json!({"endpoint": views[0]})
        };
        result["mirrored"] = json!(mirrored);
        Ok(result)
    }

    /// the broker's own tasks mark a local agent hibernated by `wake` with `reference`, or clear it with `none`
    pub async fn broker_hibernate(
        &mut self,
        endpoint: &str,
        wake: &str,
        reference: Option<&str>,
    ) -> Result<Value, RpcError> {
        let mut params = Map::new();
        params.insert("wake".into(), json!(wake));
        if let Some(reference) = reference {
            params.insert("ref".into(), json!(reference));
        }
        let set = self.hibernation(&params)?;
        let target = self.by_id(endpoint).await?;
        let Some(target) = target.filter(|t| text(t, "kind") == Some("agent")) else {
            return Err(RpcError::invalid_params(
                "only a local agent endpoint hibernates",
            ));
        };
        if set.wake == SPAWN_PROVIDER {
            return Err(RpcError::invalid_params(format!(
                "{SPAWN_PROVIDER} hibernates only a durably held worker, by its own ref"
            )));
        }
        let view = self.set_hibernation(None, &target, &set).await?;
        self.presence_moved(endpoint, true, false).await?;
        self.wakers.kick(endpoint);
        Ok(view)
    }

    /// sets or clears `target`'s hibernation, audited with who did it (`broker` for `by` none)
    async fn set_hibernation(
        &self,
        by: Option<&Row>,
        target: &Row,
        set: &Hibernation,
    ) -> Result<Value, RpcError> {
        let id = text(target, "id").unwrap_or("");
        let by = by.map_or_else(|| "broker".to_owned(), address);
        if set.wake == "none" {
            if text(target, "hibernate").is_some() {
                self.clear_hibernation(id).await?;
                self.audit(
                    "unhibernate",
                    Some(id),
                    None,
                    json!({"by": by, "target": address(target)}),
                )
                .await?;
            }
            return self.view(&self.must_endpoint(id).await?).await;
        }
        let same = text(target, "hibernate") == Some(set.wake.as_str())
            && text(target, "wake_ref") == set.reference.as_deref();
        if revivable(target) && same {
            self.store
                .all(
                    "UPDATE endpoints SET wake_tried = NULL WHERE id = ?",
                    &[sv(id)],
                )
                .await?;
            return self.view(&self.must_endpoint(id).await?).await;
        }
        let at = integer(target, "hibernated_at")
            .filter(|_| same)
            .unwrap_or_else(now_ms);
        self.clear_hibernation(id).await?;
        self.store.all("UPDATE endpoints SET hibernate = ?, wake_ref = ?, wake_eta = ?, hibernated_at = ?, hold_ref = NULL, revive = ? WHERE id = ?", &[
            sv(&set.wake),
            set.reference.as_deref().map_or(SqlValue::Null, sv),
            set.eta.map_or(SqlValue::Null, SqlValue::Int),
            SqlValue::Int(at),
            revive_via(set.reference.as_deref(), &set.wake).map_or(SqlValue::Null, sv),
            sv(id),
        ]).await?;
        self.audit(
            "hibernate",
            Some(id),
            None,
            json!({"by": by, "target": address(target), "provider": set.wake}),
        )
        .await?;
        self.view(&self.must_endpoint(id).await?).await
    }

    /// the held spawn `endpoint` whose holding connection closed, or with none every durably held endpoint (at startup): hibernated by the
    /// built-in spawn provider with the hold's ref. The views of the endpoints it hibernated
    pub async fn hibernate_held(&self, endpoint: Option<&str>) -> Result<Vec<Value>, RpcError> {
        let filter = endpoint.map_or(SqlValue::Null, sv);
        let rows = self.store.all("SELECT * FROM endpoints WHERE kind = 'agent' AND hold_ref IS NOT NULL AND hibernate IS NULL AND wakers <= 1 AND (? IS NULL OR id = ?) ORDER BY handle", &[filter.clone(), filter]).await?;
        let mut views = Vec::new();
        for row in rows {
            let id = text(&row, "id").unwrap_or("");
            self.clear_hibernation(id).await?;
            self.store.all("UPDATE endpoints SET hibernate = ?, wake_ref = hold_ref, hold_ref = NULL, hibernated_at = ?, revive = ? WHERE id = ?", &[
                sv(SPAWN_PROVIDER),
                SqlValue::Int(now_ms()),
                revive_via(text(&row, "hold_ref"), SPAWN_PROVIDER).map_or(SqlValue::Null, sv),
                sv(id),
            ]).await?;
            self.audit(
                "hibernate",
                Some(id),
                None,
                json!({"by": "broker", "target": address(&row), "provider": SPAWN_PROVIDER}),
            )
            .await?;
            views.push(self.view(&self.must_endpoint(id).await?).await?);
        }
        Ok(views)
    }

    /// revivable rows whose resumed session's hooks ran for the restart grace since its `session_start` with no ticketed claim: the session
    /// is back, so the hibernation clears
    pub async fn settle_revived(&mut self, now: i64, endpoint: Option<&str>) -> Result<(), RpcError> {
        let grace = self.cap("restartGraceS", 60) * 1000;
        let filter = endpoint.map_or(SqlValue::Null, sv);
        let rows = self.store.all("SELECT id FROM endpoints WHERE (? IS NULL OR id = ?) AND kind = 'agent' AND hibernate IS NOT NULL AND revive IS NOT NULL AND wake_ticket IS NOT NULL AND hook_ended IS NULL AND hook_seen >= wake_tried AND wake_tried <= ?", &[filter.clone(), filter, SqlValue::Int(now - grace)]).await?;
        for row in rows {
            if let Some(id) = text(&row, "id") {
                self.wake_done(id, "session_start").await?;
            }
        }
        Ok(())
    }

    /// the hibernated session is back, or gone: its hibernation clears
    pub(crate) async fn wake_done(&self, endpoint: &str, how: &str) -> Result<(), RpcError> {
        let Some(row) = self.by_id(endpoint).await? else {
            return Ok(());
        };
        if text(&row, "hibernate").is_none() {
            return Ok(());
        }
        self.clear_hibernation(endpoint).await?;
        self.audit(
            "wake_done",
            Some(endpoint),
            None,
            json!({"target": address(&row), "how": how}),
        )
        .await
    }

    pub(crate) async fn clear_hibernation(&self, endpoint: &str) -> Result<(), RpcError> {
        self.store.all(CLEAR_HIBERNATION, &[sv(endpoint)]).await?;
        Ok(())
    }

    /// a revivable row a ticketed wake run resumed: its `session_start` leaves the tickets to the shim's ticketed claim
    pub(crate) fn awaits_ticket(&self, row: &Row) -> bool {
        revivable(row) && text(row, "wake_ticket").is_some()
    }

    /// the connectionless row hibernated by the spawn provider, or revivable, whose outstanding wake ticket hashes to `ticket`
    pub(crate) async fn ticketed(&self, ticket: &str, harness: &str) -> Result<Row, RpcError> {
        let row = self.store.all("SELECT * FROM endpoints WHERE kind = 'agent' AND (wake_ticket = ? OR EXISTS (SELECT 1 FROM json_each(wake_tickets) WHERE value = ?)) AND (hibernate = ? OR (hibernate IS NOT NULL AND revive IS NOT NULL))", &[sv(ticket), sv(ticket), sv(SPAWN_PROVIDER)]).await?.into_iter().next();
        let Some(row) = row.filter(|r| harness_fits(text(r, "harness"), harness)) else {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "the wake ticket is unknown or spent",
            ));
        };
        if integer(&row, "connections").unwrap_or(0) > 0 {
            return Err(RpcError::new(
                ErrorCode::Unavailable,
                "the endpoint is still held: try again once it lets go",
            ));
        }
        Ok(row)
    }

    /// the local agent, not hibernated, whose broker wake's run in flight got `ticket`
    pub async fn wake_ticket_holder(&self, ticket: &Value) -> Result<Option<String>, RpcError> {
        let Some(ticket) = ticket.as_str().filter(|t| valid_token(t, "kwt_")) else {
            return Ok(None);
        };
        let row = self
            .store
            .all(
                "SELECT * FROM endpoints WHERE kind = 'agent' AND wake_ticket = ?",
                &[sv(hash(ticket))],
            )
            .await?
            .into_iter()
            .next();
        Ok(row
            .filter(|r| text(r, "hibernate").is_none())
            .and_then(|r| text(&r, "id").map(str::to_owned)))
    }

    /// the tickets a revivable hibernation keeps valid after a new run's ticket replaces the current one
    pub(crate) fn kept_tickets(row: &Row) -> Option<String> {
        if !revivable(row) {
            return None;
        }
        let mut previous: Vec<String> = text(row, "wake_tickets")
            .and_then(|t| serde_json::from_str(t).ok())
            .unwrap_or_default();
        if let Some(current) = text(row, "wake_ticket") {
            previous.push(current.to_owned());
        }
        let skip = previous.len().saturating_sub(REVIVE_TICKETS_KEPT);
        (!previous.is_empty()).then(|| json!(previous[skip..]).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revive_records_need_every_field() {
        let good = r#"{"via":"vm","harness":"claude-code","session":"s-42","cwd":"/work","argv":["claude","--resume","s-42"]}"#;
        assert_eq!(revive_via(Some(good), "x").as_deref(), Some("vm"));
        let bare = r#"{"harness":"codex","session":"s","cwd":"/w","argv":["codex"]}"#;
        assert_eq!(revive_via(Some(bare), "spawn").as_deref(), Some("spawn"));
        for bad in [
            "box-42",
            r#"{"harness":"codex","session":"s","cwd":"w","argv":["codex"]}"#,
            r#"{"harness":"codex","session":"s","cwd":"/w","argv":[]}"#,
            r#"{"harness":"codex","session":"s","cwd":"/w","argv":["a"],"via":1}"#,
            r#"{"harness":"codex","session":" s","cwd":"/w","argv":["a"]}"#,
        ] {
            assert!(revive_record(Some(bad)).is_none(), "{bad}");
        }
    }

    #[test]
    fn provider_names() {
        assert!(wake_provider("vm"));
        assert!(wake_provider("codex-queue"));
        assert!(!wake_provider("Bad Name"));
        assert!(!wake_provider("-x"));
        assert!(!wake_provider(&"a".repeat(33)));
    }
}
