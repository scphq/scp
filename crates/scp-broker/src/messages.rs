use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::core::{Core, integer, now_ms, text, timestamp};
use crate::proto::{ErrorCode, RpcError};
use crate::session::clean_text;
use crate::store::{Row, SqlValue};
use crate::views::{address, presence};

fn string(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

fn new_id(prefix: &str, now: i64) -> String {
    let mut value = now.max(0) as u64;
    let mut encoded = Vec::new();
    while value > 0 {
        encoded.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize] as char);
        value /= 36;
    }
    let encoded: String = encoded.into_iter().rev().collect();
    format!("{prefix}_{encoded:0>9}{:016x}", rand::random::<u64>())
}

impl Core {
    fn limit(&self, name: &str, fallback: u64) -> i64 {
        self.limits
            .get(name)
            .unwrap_or(fallback)
            .min(i64::MAX as u64 / 1000) as i64
    }

    async fn thread_member(&self, thread: &str, endpoint: &str) -> Result<bool, RpcError> {
        Ok(!self.store.all("SELECT 1 FROM messages m WHERE thread = ? AND (from_ep = ? OR EXISTS (SELECT 1 FROM deliveries WHERE message_id = m.id AND endpoint = ?)) LIMIT 1", &[string(thread),string(endpoint),string(endpoint)]).await?.is_empty())
    }

    async fn message_thread_ref(
        &self,
        endpoint: &str,
        name: Option<String>,
    ) -> Result<Option<String>, RpcError> {
        let Some(name) = name else { return Ok(None) };
        if !self
            .store
            .all(
                "SELECT 1 FROM messages WHERE thread = ? LIMIT 1",
                &[string(&name)],
            )
            .await?
            .is_empty()
        {
            return Ok(Some(name));
        }
        let membership = "EXISTS (SELECT 1 FROM messages t WHERE t.thread = m.thread AND (t.from_ep = ? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = t.id AND d.endpoint = ?)))";
        let mut rows = self
            .store
            .all(
                &format!("SELECT * FROM messages m WHERE m.id = ? AND {membership}"),
                &[string(&name), string(endpoint), string(endpoint)],
            )
            .await?;
        if rows.is_empty()
            && name.len() >= 4
            && name
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        {
            rows = self.store.all(&format!("SELECT * FROM messages m WHERE substr(m.id, -?) = ? AND {membership} ORDER BY m.created_at DESC LIMIT 50"), &[SqlValue::Int(name.len() as i64),string(&name),string(endpoint),string(endpoint)]).await?;
            if rows.len() > 1 {
                let mut named = rows
                    .iter()
                    .take(5)
                    .filter_map(|row| text(row, "id"))
                    .map(|id| format!("{} ({id})", &id[id.len().saturating_sub(6)..]))
                    .collect::<Vec<_>>()
                    .join(", ");
                if rows.len() > 5 {
                    named.push_str(", ...");
                }
                return Err(RpcError::invalid_params(format!(
                    "{name} matches more than one message in your threads, newest first: {named}; give more of the id"
                )));
            }
        }
        if let Some(row) = rows.first() {
            return Ok(text(row, "thread").map(str::to_owned));
        }
        if name.starts_with("msg_") {
            return Err(RpcError::new(
                ErrorCode::NotFound,
                format!("no thread {name} to continue"),
            ));
        }
        Ok(Some(name))
    }

    pub async fn send(
        &mut self,
        from: &str,
        recipients: &[String],
        params: &Map<String, Value>,
        tty: bool,
    ) -> Result<Value, RpcError> {
        self.send_message(from, recipients, params, tty, false)
            .await
    }

    pub(crate) async fn send_link_request(
        &mut self,
        from: &str,
        to: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        self.send_message(from, &[to.to_owned()], params, false, true)
            .await
    }

    async fn send_message(
        &mut self,
        from: &str,
        recipients: &[String],
        params: &Map<String, Value>,
        tty: bool,
        link: bool,
    ) -> Result<Value, RpcError> {
        validate_send(params, &self.limits)?;
        let sender = self.must_endpoint(from).await?;
        let body = params
            .get("body")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid_params("body must be a string"))?;
        let requested = clean_text(params.get("thread"), "thread", 64)?;
        let thread = self
            .message_thread_ref(from, requested)
            .await?
            .unwrap_or_else(|| new_id("thr", now_ms()));
        let existing = !self
            .store
            .all(
                "SELECT 1 FROM messages WHERE thread = ? LIMIT 1",
                &[string(&thread)],
            )
            .await?
            .is_empty();
        if existing && !self.thread_member(&thread, from).await? {
            return Err(RpcError::new(
                ErrorCode::NotFound,
                format!("no thread {thread} to continue"),
            ));
        }
        let mut seen = HashSet::new();
        let mut targets = Vec::new();
        for id in recipients {
            if seen.insert(id) {
                targets.push(self.must_endpoint(id).await?);
            }
        }
        // Scope decisions and messaging guards run before the write transaction.
        let now = now_ms();
        let id = new_id("msg", now);
        let kind = if link { "request" } else { "message" };
        let ttl = if link {
            86400
        } else {
            self.limit("ttlDefaultS", 604800)
        };
        let expires = now.saturating_add(ttl.saturating_mul(1000));
        let to = params
            .get("to")
            .map(|value| match value {
                Value::Array(values) => values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(","),
                Value::String(value) => value.clone(),
                _ => String::new(),
            })
            .unwrap_or_default();
        let result = crate::store::transaction(self.store.clone(), async {
            self.store.all("INSERT INTO messages (id,thread,reply_to,kind,from_ep,to_addr,body,mime,data_class,attachments,hop,created_at,expires_at,sender_tty,link_parent) VALUES (?,?,NULL,?,?,?,?,'text/markdown','public','[]',0,?,?,?,?)", &[
                string(&id), string(&thread), string(kind), string(from), string(to), string(body), SqlValue::Int(now), SqlValue::Int(expires),
                if text(&sender,"kind") == Some("human") { SqlValue::Int(i64::from(tty)) } else { SqlValue::Null },
                if link { string(address(&sender)) } else { SqlValue::Null },
            ]).await?;
            let mut deliveries = Vec::new();
            for recipient in &targets {
                let endpoint = text(recipient,"id").ok_or_else(RpcError::internal)?;
                let rows = self.store.all("INSERT INTO deliveries (message_id,endpoint,expires_at) VALUES (?,?,?) RETURNING seq", &[string(&id),string(endpoint),SqlValue::Int(expires)]).await?;
                let seq = rows.first().and_then(|row|integer(row,"seq")).ok_or_else(RpcError::internal)?;
                self.store.all("UPDATE endpoints SET mail_at = ? WHERE id = ?", &[SqlValue::Int(now),string(endpoint)]).await?;
                let view = self.view(recipient).await?;
                let offline = presence(recipient,now) == "offline" && now - integer(recipient,"last_seen").unwrap_or(0).max(integer(recipient,"hook_seen").unwrap_or(0)) >= 30_000;
                deliveries.push(json!({"endpoint":endpoint,"address":view["address"],"seq":seq,"offline":offline,"last_seen":view["last_seen"]}));
            }
            self.audit("send",Some(from),Some(&id),json!({"to":targets.iter().map(address).collect::<Vec<_>>(),"kind":kind,"bytes":body.len(),"hop":0,"thread":thread,"data_class":"public"})).await?;
            Ok::<_, RpcError>(json!({"id":id,"thread":thread,"hop":0,"deliveries":deliveries}))
        }).await?;
        for target in &targets {
            if let Some(id) = text(target, "id") {
                self.state.wake(id);
            }
        }
        Ok(result)
    }

    pub async fn inbox(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let now = now_ms();
        let page = self.limit("inboxPage", 100);
        let limit = params
            .get("limit")
            .and_then(Value::as_f64)
            .unwrap_or(page as f64)
            .floor()
            .max(1.0)
            .min(page as f64) as i64;
        let after = params
            .get("after")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .floor()
            .max(0.0)
            .min(i64::MAX as f64) as i64;
        let rows = self.store.all("SELECT m.*, d.seq AS seq, d.deferred_at AS deferred_at, d.acked_at AS acked_at FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND (d.acked_at IS NULL OR d.deferred_at > ?) AND d.expires_at > ? AND d.seq > ? ORDER BY d.seq LIMIT ?", &[string(endpoint),SqlValue::Int(now-self.limit("deferredShowS",600)*1000),SqlValue::Int(now),SqlValue::Int(after),SqlValue::Int(limit)]).await?;
        if let Some(hop) = rows.iter().filter_map(|row| integer(row, "hop")).max() {
            self.store.all("UPDATE endpoints SET last_received_at = ?, last_received_hop = MAX(?, CASE WHEN last_received_at >= ? THEN COALESCE(last_received_hop, 0) ELSE 0 END) WHERE id = ?", &[SqlValue::Int(now),SqlValue::Int(hop),SqlValue::Int(now-self.limit("causalWindowS",120)*1000),string(endpoint)]).await?;
        }
        let mut messages = Vec::new();
        for row in &rows {
            messages.push(self.message_envelope(row, endpoint).await?);
        }
        Ok(
            json!({"messages":messages,"next":rows.last().and_then(|row|integer(row,"seq")).unwrap_or(after)}),
        )
    }

    pub async fn message_envelope(&self, row: &Row, endpoint: &str) -> Result<Value, RpcError> {
        let sender_id = text(row, "from_ep").ok_or_else(RpcError::internal)?;
        let sender = self.by_id(sender_id).await?;
        let recipient = self.by_id(endpoint).await?;
        let mut from = json!({"address":sender.as_ref().map(address).unwrap_or_else(||sender_id.into()),"endpoint":sender_id,"user":"me","auth":"local-uid","claims":{"harness":sender.as_ref().and_then(|row|text(row,"harness")),"model":sender.as_ref().and_then(|row|text(row,"model"))}});
        if let Some(tty) = integer(row, "sender_tty") {
            from["claims"]["tty"] = json!(tty == 1);
        }
        let to = text(row, "to_addr").unwrap_or("");
        let to = if to.contains(',') {
            recipient.as_ref().map(address).unwrap_or_else(|| to.into())
        } else {
            to.into()
        };
        let mut envelope = json!({"seq":integer(row,"seq"),"id":text(row,"id"),"thread":text(row,"thread"),"reply_to":text(row,"reply_to"),"kind":text(row,"kind"),"from":from,"to":to,"body":{"text":text(row,"body"),"mime":text(row,"mime")},"data_class":text(row,"data_class"),"attachments":serde_json::from_str::<Value>(text(row,"attachments").unwrap_or("[]")).map_err(|_|RpcError::internal())?,"hop":integer(row,"hop").unwrap_or(0),"created_at":integer(row,"created_at").and_then(timestamp),"expires_at":integer(row,"expires_at").and_then(timestamp)});
        if let Some(parent) = text(row, "link_parent") {
            envelope["link"] = json!({"parent":parent});
        }
        if integer(row, "require_reply") == Some(1) {
            envelope["require_reply"] = json!(true);
        }
        if integer(row, "acked_at").is_some()
            && let Some(at) = integer(row, "deferred_at")
        {
            envelope["shown_at"] = json!(timestamp(at));
        }
        Ok(envelope)
    }

    pub async fn ack(&mut self, endpoint: &str, seqs: &Value) -> Result<Value, RpcError> {
        let page = self.limit("inboxPage", 100);
        let seqs = seqs
            .as_array()
            .filter(|seqs| {
                seqs.iter().all(|value| {
                    value
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && n.fract() == 0.0)
                })
            })
            .ok_or_else(|| RpcError::invalid_params("seqs must be a list of integers"))?;
        if seqs.len() as u64 > page as u64 {
            return Err(RpcError::invalid_params(format!(
                "at most {page} seqs per ack"
            )));
        }
        let mut acked = 0;
        for value in seqs {
            let Some(seq) = value
                .as_f64()
                .filter(|seq| *seq >= i64::MIN as f64 && *seq < i64::MAX as f64)
                .map(|seq| seq as i64)
            else {
                continue;
            };
            let now = now_ms();
            acked += self.store.all("UPDATE deliveries SET acked_at = ? WHERE seq = ? AND endpoint = ? AND acked_at IS NULL RETURNING seq", &[SqlValue::Int(now),SqlValue::Int(seq),string(endpoint)]).await?.len();
            self.store.all("UPDATE deliveries SET acked_at = ?, deferred_ack = NULL WHERE seq = ? AND endpoint = ? AND deferred_ack IS NOT NULL", &[SqlValue::Int(now),SqlValue::Int(seq),string(endpoint)]).await?;
            self.store.all("UPDATE deliveries SET deferred_at = NULL WHERE seq = ? AND endpoint = ? AND deferred_at IS NOT NULL", &[SqlValue::Int(seq),string(endpoint)]).await?;
        }
        if acked > 0 {
            self.audit("ack", Some(endpoint), None, json!({"count":acked}))
                .await?;
        }
        Ok(json!({"acked":acked}))
    }
}

/// envelope fields only the relay sets: a sender naming one, `from` above all, is refused
const SERVER_FIELDS: [&str; 9] = [
    "from",
    "id",
    "seq",
    "hop",
    "created_at",
    "auth",
    "expires_at",
    "relation",
    "link",
];

pub fn validate_send(
    params: &Map<String, Value>,
    _limits: &crate::proto::Limits,
) -> Result<(), RpcError> {
    if let Some(field) = SERVER_FIELDS
        .iter()
        .find(|field| params.contains_key(**field))
    {
        return Err(RpcError::invalid_params(format!(
            "{field} is set by the relay, not the sender"
        )));
    }
    if !params.get("body").is_some_and(Value::is_string) {
        return Err(RpcError::invalid_params("body must be a string"));
    }
    Ok(())
}
