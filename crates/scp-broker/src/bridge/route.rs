//! Messages across machines: a send to other machines goes through the bridge, a hub delivery is admitted here.

use scp_core::protocol::{CLI_NAME, ErrorCode, LIMITS};
use serde_json::{Map, Value, json};

use super::rows::parse_time;
use super::{LocalDelivery, handle_part, is_foreign, valid_remote};
use crate::claims::{hash, valid_harness};
use crate::core::{Core, integer, now_ms, text};
use crate::messages::{Origin, new_id};
use crate::proto::RpcError;
use crate::scrub::find_secret;
use crate::session::clean_text;
use crate::store::{Row, SqlValue};
use crate::views::address;

const MESSAGE_KINDS: [&str; 4] = ["message", "request", "reply", "status"];
const AUTHS: [&str; 4] = ["local-uid", "account", "account+bridge", "contact"];
const XBODY_BYTES: usize = 16 * 1024;

fn sv(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

fn targets_of(to: Option<&Value>) -> Vec<Value> {
    match to {
        Some(Value::Array(list)) => list.clone(),
        Some(value) => vec![value.clone()],
        None => vec![Value::Null],
    }
}

/// the code an error refuses with, or None for one worth trying again
pub fn refusal_code(error: &RpcError) -> Option<ErrorCode> {
    error.data.as_ref().map(|d| d.code)
}

/// what an inbound delivery came to
pub enum Injected {
    Refused(String),
    Duplicate,
    Admitted(String),
}

impl Core {
    /// whether a send goes to other machines: all recipients remote, or none; a mixed list is refused
    pub async fn remote_send(&self, to: Option<&Value>) -> Result<bool, RpcError> {
        let targets = targets_of(to);
        let mut remote = 0;
        for target in &targets {
            if self.is_remote(target).await {
                remote += 1;
            }
        }
        if remote > 0 && remote != targets.len() {
            return Err(RpcError::invalid_params(
                "a message goes to endpoints on this machine or on other machines, not both; send it twice",
            ));
        }
        Ok(remote > 0)
    }

    /// a send whose recipients are all on other machines, on behalf of the local endpoint `from`
    pub async fn forward(
        &mut self,
        from: &str,
        params: &Map<String, Value>,
        origin: Origin<'_>,
    ) -> Result<Value, RpcError> {
        let Some(bridge) = self.bridge() else {
            let shown: Vec<String> = targets_of(params.get("to"))
                .iter()
                .map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned))
                .collect();
            return Err(RpcError::new(
                ErrorCode::NotFound,
                format!(
                    "no endpoint {}: this broker is not linked to a hub ({CLI_NAME} cloud enable)",
                    shown.join(", ")
                ),
            ));
        };
        let sender = self.must_endpoint(from).await?;
        let sender_address = address(&sender);
        let targets = targets_of(params.get("to"));
        let texts: Vec<String> = targets
            .iter()
            .map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned))
            .collect();
        if texts.iter().any(|to| self.foreign_account(to).is_some()) {
            cross_account(params, targets.len())?;
        }
        let parent = match params.get("reply_to").and_then(Value::as_str) {
            Some(id) => self
                .store
                .all("SELECT * FROM messages WHERE id = ?", &[sv(id)])
                .await?
                .into_iter()
                .next(),
            None => None,
        };
        for to in &texts {
            if self.foreign_account(to).is_some() {
                continue;
            }
            let Some(row) = self.resolve_remote(to).await? else {
                return Err(crate::views::not_found(to.trim()));
            };
            self.check_scope(&sender, &row, to.trim(), parent.as_ref(), origin.unverified)
                .await?;
            if let Some(refusal) = self.policy_refusal(&sender, &row).await? {
                return Err(RpcError::new(
                    ErrorCode::PolicyRefused,
                    format!("{refusal} ({to})"),
                ));
            }
        }
        let body = params
            .get("body")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid_params("body must be a string"))?;
        if params.get("data_class").and_then(Value::as_str) == Some("private")
            && !bridge.config.private_ok
        {
            return Err(RpcError::new(
                ErrorCode::DataClassRefused,
                "a private message stays on this machine; allow private messages in the bridge configuration to send them through the hub",
            ));
        }
        let attachments = params
            .get("attachments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let secret = find_secret(body).or_else(|| {
            attachments.iter().find_map(|a| {
                find_secret(&a.get("path").map_or_else(String::new, |p| {
                    p.as_str().map_or_else(|| p.to_string(), str::to_owned)
                }))
            })
        });
        if let Some(secret) = secret {
            return Err(RpcError::new(
                ErrorCode::SecretRefused,
                format!(
                    "the message looks like it carries a credential ({secret}); send a reference instead"
                ),
            ));
        }
        if let Some(earlier) = self.forwarded(from, params).await? {
            return Ok(earlier);
        }
        if !self.mirrored(&bridge.config.mirror, &sender) {
            return Err(RpcError::new(
                ErrorCode::PolicyRefused,
                format!(
                    "{sender_address} is not mirrored to the hub (the bridge's mirror selectors), so it can't message other machines"
                ),
            ));
        }
        let handle = if text(&sender, "kind") == Some("human") {
            String::new()
        } else {
            text(&sender, "handle").unwrap_or("").to_owned()
        };
        if !bridge.connected() {
            return Err(bridge.unavailable());
        }
        let client_id = match params.get("client_id").and_then(Value::as_str) {
            Some(id) => id.to_owned(),
            None => new_id("fwd", now_ms()),
        };
        let mut routes = Vec::new();
        for to in &texts {
            routes.push(json!(self.route(to).await?.unwrap_or_default()));
        }
        let mut sent = params.clone();
        sent.insert("client_id".into(), json!(client_id));
        sent.insert("to".into(), Value::Array(routes));
        sent.remove("wait_s");
        sent.remove("attachments");
        let mut request =
            json!({"from": handle, "params": sent, "hop_floor": self.causal_hop(from).await?});
        if let Some(tty) = origin.tty {
            request["tty"] = json!(tty);
        }
        let result = bridge.forward_request(request).await?;
        let mut recorded = params.clone();
        recorded.insert("client_id".into(), json!(client_id));
        self.record_forward(&sender, &recorded, &result, origin)
            .await?;
        let to: Vec<Value> = result["deliveries"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| d["address"].clone())
            .collect();
        let kind = params
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("message");
        if result.get("duplicate") != Some(&Value::Bool(true)) {
            self.notify_watchers(json!({"type": "message", "id": result["id"], "thread": result["thread"], "kind": kind, "from": sender_address, "to": to, "hop": result["hop"]}))
                .await;
        }
        Ok(result)
    }

    fn forward_hash(params: &Map<String, Value>) -> String {
        let mut targets: Vec<String> = targets_of(params.get("to"))
            .iter()
            .map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned))
            .collect();
        targets.sort();
        let mut paths: Vec<String> = params
            .get("attachments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|a| a.get("path").and_then(Value::as_str).map(str::to_owned))
            .collect();
        paths.sort();
        let field = |key: &str| params.get(key).cloned().unwrap_or(Value::Null);
        hash(
            &json!([
                "forward",
                targets,
                field("body"),
                params.get("kind").cloned().unwrap_or(json!("message")),
                field("thread"),
                field("reply_to"),
                params.get("data_class").cloned().unwrap_or(json!("public")),
                paths,
                field("mime"),
                field("ttl_s"),
            ])
            .to_string(),
        )
    }

    /// the earlier result of a forwarded send with this client_id; a different message under the same client_id is refused
    pub async fn forwarded(
        &self,
        from: &str,
        params: &Map<String, Value>,
    ) -> Result<Option<Value>, RpcError> {
        let Some(client_id) = clean_text(params.get("client_id"), "client_id", 128)? else {
            return Ok(None);
        };
        let Some(seen) = self
            .store
            .all(
                "SELECT result, payload_hash, created_at FROM idempotency WHERE from_ep = ? AND client_id = ?",
                &[sv(from), sv(&client_id)],
            )
            .await?
            .into_iter()
            .next()
        else {
            return Ok(None);
        };
        if integer(&seen, "created_at").unwrap_or(0) < now_ms() - LIMITS.idempotency_s as i64 * 1000
        {
            return Ok(None);
        }
        if text(&seen, "payload_hash") != Some(Self::forward_hash(params).as_str()) {
            return Err(RpcError::invalid_params(format!(
                "client_id {client_id} was already used for a different message"
            )));
        }
        let mut result: Value = serde_json::from_str(text(&seen, "result").unwrap_or("{}"))
            .map_err(|_| RpcError::internal())?;
        result["duplicate"] = json!(true);
        Ok(Some(result))
    }

    /// a send the hub accepted, stored under the hub's id with no deliveries, so replies and a retried client_id work
    async fn record_forward(
        &self,
        sender: &Row,
        params: &Map<String, Value>,
        result: &Value,
        origin: Origin<'_>,
    ) -> Result<(), RpcError> {
        let from = text(sender, "id").unwrap_or_default().to_owned();
        let now = now_ms();
        let ttl = params
            .get("ttl_s")
            .and_then(Value::as_i64)
            .unwrap_or(LIMITS.ttl_default_s as i64);
        let to: Vec<String> = targets_of(params.get("to"))
            .iter()
            .map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_owned))
            .collect();
        let kind = params
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("message")
            .to_owned();
        let attachments: Vec<Value> = params
            .get("attachments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|a| json!({"kind": "path", "path": a.get("path")}))
            .collect();
        let tty = if text(sender, "kind") == Some("human") {
            SqlValue::Int(i64::from(origin.tty == Some(true)))
        } else {
            SqlValue::Null
        };
        let reply_to = params
            .get("reply_to")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let require = params.get("require_reply") == Some(&Value::Bool(true)) && kind == "request";
        let store = self.store.clone();
        let work = async {
            self.store.all(
                "INSERT OR IGNORE INTO messages (id, thread, reply_to, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at, sender_tty, require_reply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    sv(result["id"].as_str().unwrap_or_default()),
                    sv(result["thread"].as_str().unwrap_or_default()),
                    reply_to.clone().map_or(SqlValue::Null, sv),
                    sv(&kind),
                    sv(&from),
                    sv(to.join(",")),
                    sv(params.get("body").and_then(Value::as_str).unwrap_or_default()),
                    sv(params.get("mime").and_then(Value::as_str).unwrap_or("text/markdown")),
                    sv(params.get("data_class").and_then(Value::as_str).unwrap_or("public")),
                    sv(Value::Array(attachments).to_string()),
                    SqlValue::Int(result["hop"].as_i64().unwrap_or(0)),
                    SqlValue::Int(now),
                    SqlValue::Int(now + ttl * 1000),
                    tty,
                    if require { SqlValue::Int(1) } else { SqlValue::Null },
                ],
            ).await?;
            if let Some(client_id) = clean_text(params.get("client_id"), "client_id", 128)? {
                let mut stored = result.clone();
                if let Some(map) = stored.as_object_mut() {
                    map.remove("duplicate");
                }
                self.store
                    .all(
                        "INSERT OR REPLACE INTO idempotency (from_ep, client_id, payload_hash, result, created_at) VALUES (?, ?, ?, ?, ?)",
                        &[sv(&from), sv(client_id), sv(Self::forward_hash(params)), sv(stored.to_string()), SqlValue::Int(now)],
                    )
                    .await?;
            }
            if let Some(reply_to) = &reply_to {
                self.store
                    .all(
                        "UPDATE deliveries SET acked_at = ? WHERE message_id = ? AND endpoint = ? AND acked_at IS NULL",
                        &[SqlValue::Int(now), sv(reply_to), sv(&from)],
                    )
                    .await?;
            }
            let addresses: Vec<Value> = result["deliveries"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|d| d["address"].clone())
                .collect();
            self.audit("forward", Some(&from), result["id"].as_str(), json!({"to": addresses, "kind": kind, "hop": result["hop"], "thread": result["thread"]}))
                .await
        };
        crate::store::transaction(store, work).await
    }

    /// a local delivery's metadata for the hub, after a send on this machine
    pub fn report_local(&self, from: &str, kind: &str, result: &Value) {
        if result.get("duplicate") == Some(&Value::Bool(true)) {
            return;
        }
        let to = result["deliveries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|d| d["endpoint"].as_str().map(str::to_owned))
            .collect();
        self.bridge_local(LocalDelivery {
            id: result["id"].as_str().unwrap_or_default().to_owned(),
            thread: result["thread"].as_str().unwrap_or_default().to_owned(),
            kind: kind.to_owned(),
            from: from.to_owned(),
            to,
            at: now_ms(),
        });
    }

    fn check_envelope(message: &Value) -> Result<(i64, i64), RpcError> {
        let bad =
            |what: &str| RpcError::invalid_params(format!("the message's {what} is not valid"));
        if !message.is_object() {
            return Err(bad("shape"));
        }
        let id = message["id"].as_str().ok_or_else(|| bad("id"))?;
        let id_ok = id.split_once('_').is_some_and(|(p, rest)| {
            (2..=8).contains(&p.len())
                && p.chars().all(|c| c.is_ascii_lowercase())
                && (8..=64).contains(&rest.len())
                && rest
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        });
        if !id_ok {
            return Err(bad("id"));
        }
        if !message["thread"]
            .as_str()
            .is_some_and(|t| !t.is_empty() && t.len() <= 128)
        {
            return Err(bad("thread"));
        }
        if !message["reply_to"].is_null()
            && !message["reply_to"].as_str().is_some_and(|r| r.len() <= 128)
        {
            return Err(bad("reply_to"));
        }
        if !message["kind"]
            .as_str()
            .is_some_and(|k| MESSAGE_KINDS.contains(&k))
        {
            return Err(bad("kind"));
        }
        if !message["to"].as_str().is_some_and(|t| t.len() <= 4096) {
            return Err(bad("to"));
        }
        let body = message["body"]["text"]
            .as_str()
            .ok_or_else(|| bad("body"))?;
        if !message["body"]["mime"]
            .as_str()
            .is_some_and(|m| m.len() <= 64)
        {
            return Err(bad("body"));
        }
        if body.len() as u64 > LIMITS.body_bytes {
            return Err(RpcError::new(
                ErrorCode::TooLarge,
                format!("the body is more than {} bytes", LIMITS.body_bytes),
            ));
        }
        if !matches!(message["data_class"].as_str(), Some("public" | "private")) {
            return Err(bad("data_class"));
        }
        let attachments = message["attachments"]
            .as_array()
            .ok_or_else(|| bad("attachments"))?;
        if attachments.len() as u64 > LIMITS.attachments
            || attachments.iter().any(|a| {
                a["kind"] != "path" || !a["path"].as_str().is_some_and(|p| p.starts_with('/'))
            })
        {
            return Err(bad("attachments"));
        }
        if !message["hop"].as_i64().is_some_and(|h| h >= 0)
            || !message["hop"].is_i64() && !message["hop"].is_u64()
        {
            return Err(bad("hop"));
        }
        let from = &message["from"];
        if !from["address"].is_string()
            || !from["user"].is_string()
            || !from["claims"].is_object()
            || !from["auth"].as_str().is_some_and(|a| AUTHS.contains(&a))
        {
            return Err(bad("sender"));
        }
        if !from["claims"]["tty"].is_null() && !from["claims"]["tty"].is_boolean() {
            return Err(bad("sender"));
        }
        let (Some(created), Some(expires)) = (
            parse_time(message.get("created_at")),
            parse_time(message.get("expires_at")),
        ) else {
            return Err(bad("timestamps"));
        };
        if let Some(secret) = find_secret(body) {
            return Err(RpcError::new(
                ErrorCode::SecretRefused,
                format!("the message looks like it carries a credential ({secret})"),
            ));
        }
        Ok((created, expires))
    }

    async fn insert_proxy(
        &mut self,
        remote: &str,
        kind: &str,
        harness: Option<&str>,
        auth: &str,
    ) -> Result<String, RpcError> {
        if let Some(cap) = self.limits.get("endpoints") {
            let rows = self
                .store
                .all("SELECT COUNT(*) AS n FROM endpoints WHERE kind != 'system' AND substr(handle, 1, 6) != '_gone_'", &[])
                .await?;
            let live = rows.first().and_then(|r| integer(r, "n")).unwrap_or(0) as u64;
            if live + 1 > cap {
                return Err(RpcError::new(
                    ErrorCode::TooLarge,
                    format!(
                        "at most {cap} endpoints on this relay, and this needs {}; the deployment raises the endpoints key of SCP_LIMITS",
                        live + 1
                    ),
                ));
            }
        }
        let id = new_id("ep", now_ms());
        self.store
            .all(
                "INSERT INTO endpoints (id, handle, kind, harness, labels, created_at, remote, auth) VALUES (?, ?, ?, ?, '{}', ?, ?, ?)",
                &[sv(&id), sv(format!("_r_{id}")), sv(kind), harness.map_or(SqlValue::Null, sv), SqlValue::Int(now_ms()), sv(remote), sv(auth)],
            )
            .await?;
        self.state.presence.insert(id.clone(), 0);
        self.state
            .addresses
            .insert(id.clone(), super::remote_address(remote));
        Ok(id)
    }

    /// the row standing for a message's sender: its mirrored row, else a proxy made for it
    async fn proxy_for(&mut self, from: &Value) -> Result<String, RpcError> {
        let auth = from["auth"].as_str().unwrap_or("account").to_owned();
        let harness = from["claims"]["harness"]
            .as_str()
            .filter(|h| valid_harness(h))
            .map(str::to_owned);
        if auth == "contact" {
            let bad = || {
                RpcError::invalid_params(format!(
                    "the sender {} is not an endpoint of a contact",
                    from["address"]
                ))
            };
            let account = from["account"]
                .as_str()
                .filter(|a| {
                    super::valid_account(a)
                        && !self.is_local_user(a)
                        && from["user"].as_str() == Some(*a)
                })
                .ok_or_else(bad)?;
            let address = from["address"].as_str().unwrap_or_default();
            let (remote, kind) = if from["human"] == true {
                if address != format!("{account}/me") {
                    return Err(bad());
                }
                (format!("@{account}/me"), "human")
            } else {
                let (acct, machine, handle) = self
                    .foreign_account(address)
                    .filter(|(a, _, _)| a == account)
                    .ok_or_else(bad)?;
                (format!("@{acct}/{machine}/{handle}"), "agent")
            };
            return match self.by_remote(&remote).await? {
                Some(row) => {
                    let id = text(&row, "id").unwrap_or_default().to_owned();
                    if text(&row, "harness") != harness.as_deref() {
                        self.store
                            .all(
                                "UPDATE endpoints SET harness = ? WHERE id = ?",
                                &[harness.map_or(SqlValue::Null, sv), sv(&id)],
                            )
                            .await?;
                    }
                    Ok(id)
                }
                None => {
                    self.insert_proxy(&remote, kind, harness.as_deref(), &auth)
                        .await
                }
            };
        }
        let user = from["user"].as_str().unwrap_or_default();
        let address = from["address"].as_str().unwrap_or_default();
        let rest = address
            .strip_prefix(&format!("{user}/"))
            .ok_or_else(|| RpcError::invalid_params("the sender's address is not of its user"))?;
        let remote = if rest.contains('/') {
            rest.to_owned()
        } else {
            format!("{user}/{rest}")
        };
        if !valid_remote(&remote) {
            return Err(RpcError::invalid_params(format!(
                "the sender's address {address} is not valid"
            )));
        }
        let kind = if handle_part(&remote).is_empty() {
            "human"
        } else if rest.contains('/') {
            "agent"
        } else {
            "system"
        };
        let model = clean_text(from["claims"].get("model"), "model", 128)?;
        let existing = self.by_remote(&remote).await?;
        let id = match &existing {
            Some(row) => text(row, "id").unwrap_or_default().to_owned(),
            None => {
                self.insert_proxy(&remote, kind, harness.as_deref(), &auth)
                    .await?
            }
        };
        if existing.as_ref().is_none_or(|row| {
            text(row, "harness") != harness.as_deref()
                || text(row, "model") != model.as_deref()
                || text(row, "auth") != Some(auth.as_str())
        }) {
            self.store
                .all(
                    "UPDATE endpoints SET harness = ?, model = ?, auth = ? WHERE id = ?",
                    &[
                        harness.map_or(SqlValue::Null, sv),
                        model.map_or(SqlValue::Null, sv),
                        sv(&auth),
                        sv(&id),
                    ],
                )
                .await?;
        }
        Ok(id)
    }

    /// why the local policy or scope refuses a hub delivery to the local `endpoint`, or None; a scope refusal is not_found
    async fn inbound_refusal(
        &mut self,
        endpoint: &str,
        message: &Value,
    ) -> Result<Option<String>, RpcError> {
        let recipient = self.must_endpoint(endpoint).await?;
        Self::check_envelope(message)?;
        let sender_id = self.proxy_for(&message["from"]).await?;
        let sender = self.must_endpoint(&sender_id).await?;
        if text(&sender, "kind") == Some("system") {
            return Ok(None);
        }
        let id = message["id"].as_str().unwrap_or_default();
        let had = !self
            .store
            .all(
                "SELECT 1 FROM deliveries WHERE message_id = ? AND endpoint = ?",
                &[sv(id), sv(endpoint)],
            )
            .await?
            .is_empty();
        let foreign = text(&sender, "remote").is_some_and(is_foreign);
        if !had && !foreign {
            let parent = match (message["kind"].as_str(), message["reply_to"].as_str()) {
                (Some("reply"), Some(reply_to)) => self
                    .store
                    .all("SELECT * FROM messages WHERE id = ?", &[sv(reply_to)])
                    .await?
                    .into_iter()
                    .next(),
                _ => None,
            };
            self.check_scope(
                &sender,
                &recipient,
                &address(&recipient),
                parent.as_ref(),
                false,
            )
            .await?;
        }
        self.policy_refusal(&sender, &recipient).await
    }

    /// a hub delivery stored under the hub's id from its sender's row; idempotent, refused inbox_full past the inbox cap
    async fn admit(&mut self, endpoint: &str, message: &Value) -> Result<bool, RpcError> {
        self.must_endpoint(endpoint).await?;
        let (created, expires) = Self::check_envelope(message)?;
        let id = message["id"].as_str().unwrap_or_default().to_owned();
        let sender = self.proxy_for(&message["from"]).await?;
        let had = !self
            .store
            .all(
                "SELECT seq FROM deliveries WHERE message_id = ? AND endpoint = ?",
                &[sv(&id), sv(endpoint)],
            )
            .await?
            .is_empty();
        if had {
            return Ok(true);
        }
        let sender_row = self.must_endpoint(&sender).await?;
        if text(&sender_row, "kind") != Some("system") {
            let parent_from = match (message["kind"].as_str(), message["reply_to"].as_str()) {
                (Some("reply"), Some(reply_to)) => self
                    .store
                    .all(
                        "SELECT id, from_ep FROM messages WHERE id = ?",
                        &[sv(reply_to)],
                    )
                    .await?
                    .into_iter()
                    .next(),
                _ => None,
            };
            let first_reply = match &parent_from {
                Some(parent) if text(parent, "from_ep") == Some(endpoint) => self
                    .store
                    .all(
                        "SELECT 1 FROM messages WHERE reply_to = ? AND from_ep = ? AND kind = 'reply' AND id != ?",
                        &[sv(text(parent, "id").unwrap_or_default()), sv(&sender), sv(&id)],
                    )
                    .await?
                    .is_empty(),
                _ => false,
            };
            if !first_reply {
                let unacked = self
                    .store
                    .all(
                        "SELECT COUNT(*) AS n FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ?",
                        &[sv(endpoint), SqlValue::Int(now_ms())],
                    )
                    .await?
                    .first()
                    .and_then(|r| integer(r, "n"))
                    .unwrap_or(0);
                if unacked as u64 >= LIMITS.inbox_max {
                    let to = self.address_of(endpoint).await?;
                    return Err(self
                        .refuse(
                            &sender,
                            ErrorCode::InboxFull,
                            format!("{to} has {unacked} unread messages"),
                            None,
                            json!({}),
                        )
                        .await?);
                }
            }
        }
        let attachments: Vec<Value> = message["attachments"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|a| json!({"kind": "path", "path": a["path"]}))
            .collect();
        let tty = match message["from"]["claims"]["tty"].as_bool() {
            Some(tty) => SqlValue::Int(i64::from(tty)),
            None => SqlValue::Null,
        };
        let require = message["require_reply"] == true && message["kind"] == "request";
        let opt = |v: &Value| v.as_str().map_or(SqlValue::Null, sv);
        self.store
            .all(
                "INSERT OR IGNORE INTO messages (id, thread, reply_to, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at, sender_tty, require_reply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    sv(&id),
                    opt(&message["thread"]),
                    opt(&message["reply_to"]),
                    opt(&message["kind"]),
                    sv(&sender),
                    opt(&message["to"]),
                    opt(&message["body"]["text"]),
                    opt(&message["body"]["mime"]),
                    opt(&message["data_class"]),
                    sv(Value::Array(attachments).to_string()),
                    SqlValue::Int(message["hop"].as_i64().unwrap_or(0)),
                    SqlValue::Int(created),
                    SqlValue::Int(expires),
                    tty,
                    if require { SqlValue::Int(1) } else { SqlValue::Null },
                ],
            )
            .await?;
        self.insert_delivery(&id, endpoint, expires).await?;
        self.audit(
            "inject",
            Some(endpoint),
            Some(&id),
            json!({"from": message["from"]["address"], "hop": message["hop"]}),
        )
        .await?;
        Ok(false)
    }

    /// a hub address (`<account>/<machine>/<handle>` or `<account>/<handle>`) as this broker writes it
    pub fn local_address(&self, value: &Value) -> Value {
        let (Some(address), Some(account)) = (value.as_str(), self.federation.account.as_deref())
        else {
            return value.clone();
        };
        let Some(rest) = address.strip_prefix(&format!("{account}/")) else {
            return value.clone();
        };
        json!(if rest.contains('/') {
            super::remote_address(rest)
        } else {
            format!("me/{account}/{rest}")
        })
    }

    /// admits a delivery to its local endpoint and tells the local watchers
    pub async fn inject_remote(
        &mut self,
        target: &Value,
        message: &Value,
    ) -> Result<Injected, RpcError> {
        let endpoint = match self.local_target(target).await {
            Ok(endpoint) => endpoint,
            Err(error) => {
                return Ok(Injected::Refused(
                    refusal_code(&error)
                        .map_or("not_found", |c| c.as_str())
                        .into(),
                ));
            }
        };
        let store = self.store.clone();
        let decided = crate::store::transaction(store, async {
            self.load_policy().await?;
            if self.policy_error.is_some()
                || self.inbound_refusal(&endpoint, message).await?.is_some()
            {
                return Ok::<_, RpcError>(Some(Injected::Refused("policy_refused".into())));
            }
            Ok(self
                .admit(&endpoint, message)
                .await?
                .then_some(Injected::Duplicate))
        })
        .await;
        match decided {
            Ok(Some(done)) => return Ok(done),
            Ok(None) => {}
            Err(error) => {
                return match refusal_code(&error) {
                    Some(code) => Ok(Injected::Refused(code.as_str().into())),
                    None => Err(error),
                };
            }
        }
        let to = self.address_of(&endpoint).await?;
        let from = self.local_address(&message["from"]["address"]);
        self.notify_watchers(json!({
            "type": "message", "machine": message["from"].get("machine").cloned().unwrap_or(Value::Null), "id": message["id"],
            "thread": message["thread"], "kind": message["kind"], "from": from, "to": [to], "hop": message["hop"],
        }))
        .await;
        Ok(Injected::Admitted(endpoint))
    }
}

/// a message to another account: one recipient, a short body, nothing private or attached
fn cross_account(params: &Map<String, Value>, targets: usize) -> Result<(), RpcError> {
    if targets != 1 {
        return Err(RpcError::invalid_params(
            "a message to another account goes to exactly one endpoint: no lists, groups or tree:",
        ));
    }
    if let Some(body) = params.get("body").and_then(Value::as_str)
        && body.len() > XBODY_BYTES
    {
        return Err(RpcError::new(
            ErrorCode::TooLarge,
            format!(
                "a message to another account is at most {XBODY_BYTES} bytes; this one is {}",
                body.len()
            ),
        ));
    }
    if params
        .get("attachments")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
    {
        return Err(RpcError::new(
            ErrorCode::DataClassRefused,
            "attachments stay in this account; send a reference instead",
        ));
    }
    if params.get("data_class").and_then(Value::as_str) == Some("private") {
        return Err(RpcError::new(
            ErrorCode::DataClassRefused,
            "a private message stays in this account",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope() -> Value {
        json!({"id": "msg_0000000001", "thread": "thr_1", "reply_to": null, "kind": "message", "to": "desk/bob",
            "from": {"address": "ada/laptop/ada", "user": "ada", "auth": "account", "claims": {}},
            "body": {"text": "hi", "mime": "text/markdown"}, "data_class": "public", "attachments": [], "hop": 0,
            "created_at": "2026-01-01T00:00:00Z", "expires_at": "2026-01-02T00:00:00Z"})
    }

    #[test]
    fn envelopes_are_checked_before_they_are_admitted() {
        assert!(Core::check_envelope(&envelope()).is_ok());
        for (key, value) in [
            ("id", json!("x")),
            ("kind", json!("shout")),
            ("hop", json!(-1)),
            ("created_at", json!("soon")),
        ] {
            let mut bad = envelope();
            bad[key] = value;
            assert!(Core::check_envelope(&bad).is_err(), "{key}");
        }
        let mut bad = envelope();
        bad["from"]["auth"] = json!("root");
        assert!(Core::check_envelope(&bad).is_err());
    }

    #[test]
    fn cross_account_messages_take_one_short_public_recipient() {
        let params = |v: Value| v.as_object().unwrap().clone();
        assert!(cross_account(&params(json!({"body": "hi"})), 1).is_ok());
        assert!(cross_account(&params(json!({"body": "hi"})), 2).is_err());
        assert!(cross_account(&params(json!({"body": "hi", "data_class": "private"})), 1).is_err());
    }
}
