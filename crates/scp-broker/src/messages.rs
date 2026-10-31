use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use scp_core::protocol::{ErrorCode, LIMITS};
use serde_json::{Map, Value, json};
use tokio::sync::OwnedMutexGuard;
use tokio::time::Instant;

use crate::core::{Core, SharedCore, integer, now_ms, text, timestamp};
use crate::limits::SendGuard;
use crate::proto::RpcError;
use crate::scrub::find_secret;
use crate::session::clean_text;
use crate::state::{ConnectionId, Mode};
use crate::store::{Row, SqlValue};
use crate::views::{address, presence};

/// how long a recipient that dropped off counts as still there for an ask
const ASK_ENDED_GRACE_MS: i64 = 10_000;
const ASK_RECHECK: Duration = Duration::from_millis(1000);
const MESSAGE_KINDS: [&str; 4] = ["message", "request", "reply", "status"];

fn string(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

pub(crate) fn new_id(prefix: &str, now: i64) -> String {
    let mut value = now.max(0) as u64;
    let mut encoded = Vec::new();
    while value > 0 {
        encoded.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize] as char);
        value /= 36;
    }
    let encoded: String = encoded.into_iter().rev().collect();
    format!("{prefix}_{encoded:0>9}{:016x}", rand::random::<u64>())
}

/// a unique tail of a message id a caller may name it by
fn suffix(id: &str) -> bool {
    id.len() >= 4
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn short_id(id: &str) -> &str {
    &id[id.len().saturating_sub(6)..]
}

fn ambiguous(id: &str, ids: &[String], place: &str) -> RpcError {
    let mut named = ids
        .iter()
        .take(5)
        .map(|full| format!("{} ({full})", short_id(full)))
        .collect::<Vec<_>>()
        .join(", ");
    if ids.len() > 5 {
        named.push_str(", ...");
    }
    RpcError::invalid_params(format!(
        "{id} matches more than one message {place}, newest first: {named}; give more of the id"
    ))
}

pub(crate) fn unreachable(value: &str) -> RpcError {
    RpcError::new(
        ErrorCode::NotFound,
        format!(
            "no endpoint {} that you can reach (swarm peers lists who you may message)",
            value.trim()
        ),
    )
}

fn optional_ms(row: &Row, key: &str) -> i64 {
    integer(row, key).unwrap_or(0)
}

fn iso(value: Option<i64>) -> Value {
    value.and_then(timestamp).map_or(Value::Null, Value::String)
}

fn filter_event(event: &Value, seen: &HashSet<String>) -> Option<Value> {
    if event["type"] == "message" {
        if !event["from"]
            .as_str()
            .is_some_and(|from| seen.contains(from))
        {
            return None;
        }
        let to = event["to"]
            .as_array()?
            .iter()
            .filter(|to| to.as_str().is_some_and(|to| seen.contains(to)))
            .cloned()
            .collect::<Vec<_>>();
        if to.is_empty() {
            return None;
        }
        let mut shown = event.clone();
        shown["to"] = json!(to);
        Some(shown)
    } else if event["endpoint"]
        .as_str()
        .is_none_or(|endpoint| seen.contains(endpoint))
    {
        Some(event.clone())
    } else {
        None
    }
}

/// who sent: a human at a terminal or a script, and what the send stands for
#[derive(Default, Clone, Copy)]
pub struct Origin<'a> {
    pub tty: Option<bool>,
    pub unverified: bool,
    pub link: Option<&'a str>,
}

/// the paths a sender may attach: real files inside its working directory
async fn check_attachments(
    value: Option<&Value>,
    cwd: Option<&str>,
) -> Result<Option<Value>, RpcError> {
    let Some(value) = value else { return Ok(None) };
    let attachments = value
        .as_array()
        .ok_or_else(|| RpcError::invalid_params("attachments must be a list"))?;
    let real_or_self =
        |path: PathBuf| async move { tokio::fs::canonicalize(&path).await.unwrap_or(path) };
    let mut too_wide = vec![PathBuf::from("/")];
    if let Some(home) = std::env::var_os("HOME") {
        too_wide.push(real_or_self(PathBuf::from(home)).await);
    }
    let mut roots = Vec::new();
    if let Some(cwd) = cwd.filter(|cwd| Path::new(cwd).is_absolute()) {
        let root = real_or_self(PathBuf::from(cwd)).await;
        if !too_wide.contains(&root) {
            roots.push(root);
        }
    }
    let mut checked = Vec::new();
    for attachment in attachments {
        let path = attachment
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| {
                attachment.get("kind").and_then(Value::as_str) == Some("path")
                    && Path::new(path).is_absolute()
            })
            .ok_or_else(|| {
                RpcError::invalid_params("an attachment is {kind: path, path: an absolute path}")
            })?;
        let real = tokio::fs::canonicalize(path)
            .await
            .map_err(|_| RpcError::new(ErrorCode::NotFound, format!("no file at {path}")))?;
        if !roots.iter().any(|root| real.starts_with(root)) {
            return Err(RpcError::invalid_params(format!(
                "{path} is outside the sender's working directory and the relay's allowed roots"
            )));
        }
        checked.push(json!({"kind": "path", "path": real.to_string_lossy()}));
    }
    Ok(Some(Value::Array(checked)))
}

impl Core {
    fn limit(&self, name: &str, fallback: u64) -> i64 {
        self.limits
            .get(name)
            .unwrap_or(fallback)
            .min(i64::MAX as u64 / 1000) as i64
    }

    /// a watcher event, with its time, to every connection that called watch
    pub async fn notify_watchers(&self, event: Value) {
        let at = timestamp(now_ms());
        let mut views = HashMap::new();
        for connection in self.state.connections.values().filter(|c| c.watching) {
            let shown = if let Some(viewer) = self.viewer_of(connection.id) {
                if !views.contains_key(&viewer) {
                    views.insert(viewer.clone(), self.visible_to(&viewer).await.ok());
                }
                let Some(Some(seen)) = views.get(&viewer) else {
                    continue;
                };
                let Some(shown) = filter_event(&event, seen) else {
                    continue;
                };
                shown
            } else {
                event.clone()
            };
            self.state.notify_watcher(connection.id, shown, at.clone());
        }
    }

    async fn thread_member(&self, thread: &str, endpoint: &str) -> Result<bool, RpcError> {
        Ok(!self.store.all("SELECT 1 FROM messages m WHERE thread = ? AND (from_ep = ? OR EXISTS (SELECT 1 FROM deliveries WHERE message_id = m.id AND endpoint = ?)) LIMIT 1", &[string(thread),string(endpoint),string(endpoint)]).await?.is_empty())
    }

    /// another endpoint's message in a thread `endpoint` sent or got a message in, by id or a unique suffix
    async fn member_message(&self, endpoint: &str, id: &str) -> Result<Option<Row>, RpcError> {
        let membership = "EXISTS (SELECT 1 FROM messages t WHERE t.thread = m.thread AND (t.from_ep = ? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = t.id AND d.endpoint = ?)))";
        let exact = self
            .store
            .all(
                &format!("SELECT * FROM messages m WHERE m.id = ? AND {membership}"),
                &[string(id), string(endpoint), string(endpoint)],
            )
            .await?;
        if !exact.is_empty() || !suffix(id) {
            return Ok(exact.into_iter().next());
        }
        let rows = self.store.all(&format!("SELECT * FROM messages m WHERE substr(m.id, -?) = ? AND {membership} ORDER BY m.created_at DESC LIMIT 50"), &[SqlValue::Int(id.len() as i64),string(id),string(endpoint),string(endpoint)]).await?;
        if rows.len() > 1 {
            let ids = rows
                .iter()
                .filter_map(|row| text(row, "id").map(str::to_owned))
                .collect::<Vec<_>>();
            return Err(ambiguous(id, &ids, "in your threads"));
        }
        Ok(rows.into_iter().next())
    }

    /// a send's thread as named: a thread id as is, a message in one of the sender's threads names its thread
    async fn thread_ref(
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
        if let Some(row) = self.member_message(endpoint, &name).await? {
            return Ok(text(&row, "thread").map(str::to_owned));
        }
        if name.starts_with("msg_") {
            return Err(RpcError::new(
                ErrorCode::NotFound,
                format!("no thread {name} to continue"),
            ));
        }
        Ok(Some(name))
    }

    /// the message a reply names: one in a thread the sender is in
    pub(crate) async fn reply_parent(&self, from: &str, id: &Value) -> Result<Row, RpcError> {
        let name = match id {
            Value::String(value) => value.clone(),
            other => other.to_string(),
        };
        let parent = self
            .store
            .all("SELECT * FROM messages WHERE id = ?", &[string(&name)])
            .await?
            .into_iter()
            .next();
        match parent {
            Some(parent)
                if self
                    .thread_member(text(&parent, "thread").unwrap_or(""), from)
                    .await? =>
            {
                Ok(parent)
            }
            _ => Err(RpcError::new(
                ErrorCode::NotFound,
                format!("no message {name} to reply to"),
            )),
        }
    }

    /// inserts one delivery, marks the recipient's mail watermark and returns the seq
    pub async fn insert_delivery(
        &self,
        message: &str,
        endpoint: &str,
        expires: i64,
    ) -> Result<i64, RpcError> {
        let rows = self.store.all("INSERT INTO deliveries (message_id,endpoint,expires_at) VALUES (?,?,?) RETURNING seq", &[string(message),string(endpoint),SqlValue::Int(expires)]).await?;
        let seq = rows
            .first()
            .and_then(|row| integer(row, "seq"))
            .ok_or_else(RpcError::internal)?;
        self.store
            .all(
                "UPDATE endpoints SET mail_at = ? WHERE id = ?",
                &[SqlValue::Int(now_ms()), string(endpoint)],
            )
            .await?;
        Ok(seq)
    }

    /// a status message from the relay itself, into the human inbox unless `to` names another endpoint
    pub async fn notice(&self, body: &str, to: Option<&Row>) -> Result<(), RpcError> {
        let system = self.by_handle("_relay").await?;
        let target = match to {
            Some(row) => Some(row.clone()),
            None => self.by_handle("_human").await?,
        };
        let (Some(system), Some(target)) = (system, target) else {
            return Ok(());
        };
        let now = now_ms();
        let id = new_id("msg", now);
        let expires = now + LIMITS.ttl_default_s as i64 * 1000;
        self.store.all("INSERT INTO messages (id,thread,reply_to,kind,from_ep,to_addr,body,mime,data_class,attachments,hop,created_at,expires_at) VALUES (?,?,NULL,'status',?,?,?,'text/plain','public','[]',0,?,?)", &[
            string(&id), string(new_id("thr", now)), string(text(&system,"id").unwrap_or("")), string(address(&target)), string(body), SqlValue::Int(now), SqlValue::Int(expires),
        ]).await?;
        let to = text(&target, "id").unwrap_or("").to_owned();
        self.insert_delivery(&id, &to, expires).await?;
        self.state.wake(&to);
        Ok(())
    }

    /// a local agent recipient's reach for a send
    fn reach(recipient: &Row, offline: bool) -> Option<&'static str> {
        if text(recipient, "kind") != Some("agent") {
            return None;
        }
        if text(recipient, "status_state") == Some("done") {
            let resumes = if text(recipient, "hibernate").is_some() {
                recipient
                    .get("wake_declined")
                    .is_none_or(|v| *v == SqlValue::Null)
            } else {
                text(recipient, "wake") == Some("spawn-resume")
                    && optional_ms(recipient, "wakers") > 0
            };
            return Some(if resumes { "running" } else { "ended" });
        }
        Some(if offline { "offline" } else { "running" })
    }

    /// `send` and `ask` from a connection: checks the policy and attachments, then sends as its endpoint
    pub async fn send_rpc(
        &mut self,
        conn: ConnectionId,
        method: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        validate_send(params, &self.limits)?;
        self.policy_gate().await?;
        let connection = self.connection(conn)?;
        let endpoint = connection
            .endpoint
            .clone()
            .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "call hello first"))?;
        let mut send = params.clone();
        send.remove("wait_s");
        if let Some(attachments) =
            check_attachments(params.get("attachments"), connection.cwd.as_deref()).await?
        {
            send.insert("attachments".into(), attachments);
        }
        if method == "ask" {
            send.insert("kind".into(), json!("request"));
        }
        let origin = match connection.mode {
            Mode::Human { tty } => Origin {
                tty: Some(tty),
                unverified: !tty,
                link: None,
            },
            _ => Origin::default(),
        };
        let sent = self.judged_send(&endpoint, &send, origin).await?;
        if method == "send" || sent.get("held").is_some() {
            return Ok(sent);
        }
        let id = sent["id"].as_str().unwrap_or("").to_owned();
        let present = present(&sent);
        Ok(
            match self
                .ask_check(&endpoint, &id, present.as_deref(), Some(&sent))
                .await?
            {
                Some(done) => done,
                None => pending(Some(&sent), &id),
            },
        )
    }

    pub(crate) async fn send_link_request(
        &mut self,
        from: &str,
        to: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let target = self.must_endpoint(to).await?;
        let mut send = params.clone();
        send.insert("to".into(), json!(address(&target)));
        send.insert("kind".into(), json!("request"));
        self.judged_send(
            from,
            &send,
            Origin {
                link: Some("session"),
                ..Origin::default()
            },
        )
        .await
    }

    pub async fn send_message(
        &mut self,
        from: &str,
        params: &Map<String, Value>,
        origin: Origin<'_>,
    ) -> Result<Value, RpcError> {
        if params.contains_key("link") {
            return Err(RpcError::invalid_params(
                "link is set by the relay, not the sender",
            ));
        }
        if self.remote_send(params.get("to")).await? {
            return self.forward(from, params, origin).await;
        }
        let sender = self.must_endpoint(from).await?;
        let human = text(&sender, "kind") == Some("human");
        let sender_tty = human.then(|| i64::from(origin.tty == Some(true)));
        let unverified = human && origin.unverified;
        let now = now_ms();
        let client_id = clean_text(params.get("client_id"), "client_id", 128)?;
        let body = params
            .get("body")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid_params("body must be a string"))?;
        if let Some(cap) = body_cap(&self.limits).filter(|cap| body.len() as u64 > *cap) {
            return Err(RpcError::new(
                ErrorCode::TooLarge,
                format!("the body is {} bytes, more than {cap}", body.len()),
            ));
        }
        let kind = match params.get("kind") {
            None => "message",
            Some(value) => value
                .as_str()
                .filter(|kind| MESSAGE_KINDS.contains(kind))
                .ok_or_else(|| {
                    RpcError::invalid_params(format!(
                        "kind must be one of {}",
                        MESSAGE_KINDS.join(", ")
                    ))
                })?,
        };
        let data_class = match params.get("data_class") {
            None => "public",
            Some(value) => value
                .as_str()
                .filter(|v| matches!(*v, "public" | "private"))
                .ok_or_else(|| RpcError::invalid_params("data_class must be public or private"))?,
        };
        let require_reply = match params.get("require_reply") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => {
                return Err(RpcError::invalid_params(
                    "require_reply must be true or false",
                ));
            }
        };
        if require_reply && kind != "request" {
            return Err(RpcError::invalid_params(
                "require_reply goes only on a request (swarm ask)",
            ));
        }
        let mime =
            clean_text(params.get("mime"), "mime", 64)?.unwrap_or_else(|| "text/markdown".into());
        let ttl_max = LIMITS.ttl_max_s as i64;
        let ttl = match params.get("ttl_s") {
            None => LIMITS.ttl_default_s as i64,
            Some(value) => value
                .as_f64()
                .filter(|v| v.fract() == 0.0 && *v >= 1.0 && *v <= ttl_max as f64)
                .map(|v| v as i64)
                .ok_or_else(|| RpcError::invalid_params(format!("ttl_s must be 1 to {ttl_max}")))?,
        };
        let attachments = match params.get("attachments") {
            None => Vec::new(),
            Some(value) => value
                .as_array()
                .filter(|list| list.len() as u64 <= LIMITS.attachments)
                .ok_or_else(|| {
                    RpcError::invalid_params(format!("at most {} attachments", LIMITS.attachments))
                })?
                .iter()
                .map(|attachment| {
                    attachment
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|path| {
                            attachment.get("kind").and_then(Value::as_str) == Some("path")
                                && path.starts_with('/')
                        })
                        .map(str::to_owned)
                        .ok_or_else(|| {
                            RpcError::invalid_params(
                                "an attachment is {kind: path, path: an absolute path}",
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?,
        };
        if let Some(secret) =
            find_secret(body).or_else(|| attachments.iter().find_map(|path| find_secret(path)))
        {
            return Err(self
                .refuse(
                    from,
                    ErrorCode::SecretRefused,
                    format!("the message looks like it carries a credential ({secret}); send a reference instead"),
                    None,
                    json!({}),
                )
                .await?);
        }
        let targets = match params.get("to") {
            Some(Value::Array(list)) => list.clone(),
            Some(value) => vec![value.clone()],
            None => Vec::new(),
        };
        let max = LIMITS.recipients as usize;
        if targets.is_empty() || targets.len() > max {
            return Err(RpcError::invalid_params(format!(
                "to takes 1 to {max} addresses"
            )));
        }
        let parent = match params.get("reply_to") {
            None => None,
            Some(id) => Some(self.reply_parent(from, id).await?),
        };
        let reply_scope = if kind == "reply" {
            parent.as_ref()
        } else {
            None
        };
        let mut resolved = Vec::new();
        let mut fan_out = Vec::new();
        for target in &targets {
            let value = target
                .as_str()
                .ok_or_else(|| RpcError::invalid_params("to is an address or list"))?
                .trim();
            if value == "tree:children" || value.starts_with("group:") {
                resolved.extend(self.expand(&sender, value, reply_scope).await?);
                if let Some(name) = value.strip_prefix("group:") {
                    fan_out.push(name.to_owned());
                }
                continue;
            }
            let row = self.lookup(value).await?;
            self.check_scope(&sender, &row, value, reply_scope, unverified)
                .await?;
            resolved.push(row);
        }
        let mut seen = HashSet::new();
        let recipients = resolved
            .into_iter()
            .filter(|row| seen.insert(text(row, "id").unwrap_or("").to_owned()))
            .collect::<Vec<_>>();
        let live = match params.get("live") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => return Err(RpcError::invalid_params("live must be true or false")),
        };
        let dark = recipients
            .iter()
            .filter(|r| {
                text(r, "kind") == Some("agent")
                    && presence(r, now) == "offline"
                    && (now - optional_ms(r, "last_seen").max(optional_ms(r, "hook_seen"))
                        >= ASK_ENDED_GRACE_MS
                        || (text(r, "session").is_none()
                            && text(r, "token_hash").is_none()
                            && integer(r, "hook_ended").is_some()))
            })
            .collect::<Vec<_>>();
        if live {
            let asleep = recipients
                .iter()
                .filter(|r| text(r, "kind") == Some("agent") && text(r, "hibernate").is_some());
            let names = dark
                .iter()
                .copied()
                .chain(asleep)
                .map(address)
                .collect::<Vec<_>>();
            if !names.is_empty() {
                return Err(RpcError::new(
                    ErrorCode::NotLive,
                    format!(
                        "no live session holds {}: nothing was queued",
                        names.join(", ")
                    ),
                ));
            }
        }
        let warnings = dark
            .iter()
            .map(|r| format!("queued: no live session holds {}", address(r)))
            .collect::<Vec<_>>();
        let total = LIMITS.fan_out_total as usize;
        if recipients.len() > total {
            return Err(RpcError::new(
                ErrorCode::TooLarge,
                format!(
                    "the send reaches {} endpoints, more than {total}",
                    recipients.len()
                ),
            ));
        }
        if origin.link.is_some()
            && (text(&sender, "kind") != Some("agent")
                || kind != "request"
                || recipients.len() != 1
                || text(&recipients[0], "kind") != Some("agent"))
        {
            return Err(RpcError::invalid_params(
                "a link request is from an agent to one local agent",
            ));
        }
        let requested = self
            .thread_ref(from, clean_text(params.get("thread"), "thread", 64)?)
            .await?;
        let mut ids = recipients
            .iter()
            .filter_map(|r| text(r, "id"))
            .collect::<Vec<_>>();
        ids.sort_unstable();
        let mut paths = attachments.iter().map(String::as_str).collect::<Vec<_>>();
        paths.sort_unstable();
        let mut payload = vec![
            json!(ids),
            json!(body),
            json!(kind),
            json!(requested),
            json!(parent.as_ref().and_then(|p| text(p, "id"))),
            json!(data_class),
            json!(paths),
            json!(mime),
            json!(ttl),
            json!(require_reply),
        ];
        if let Some(link) = origin.link {
            payload.push(json!(link));
        }
        let payload_hash = crate::claims::hash(&Value::Array(payload).to_string());
        if let Some(client_id) = &client_id {
            let seen = self.store.all("SELECT result, payload_hash, created_at FROM idempotency WHERE from_ep = ? AND client_id = ?", &[string(from), string(client_id)]).await?;
            if let Some(row) = seen.first()
                && optional_ms(row, "created_at") >= now - LIMITS.idempotency_s as i64 * 1000
            {
                if text(row, "payload_hash") != Some(payload_hash.as_str()) {
                    return Err(RpcError::invalid_params(format!(
                        "client_id {client_id} was already used for a different message"
                    )));
                }
                let mut result: Value = serde_json::from_str(text(row, "result").unwrap_or("{}"))
                    .map_err(|_| RpcError::internal())?;
                result["duplicate"] = json!(true);
                return Ok(result);
            }
        }
        let addressed = recipients.iter().map(address).collect::<Vec<_>>();
        let thread = parent
            .as_ref()
            .and_then(|p| text(p, "thread").map(str::to_owned))
            .or(requested)
            .unwrap_or_else(|| new_id("thr", now));
        let causal = match integer(&sender, "last_received_at") {
            Some(at) if at >= now - LIMITS.causal_window_s as i64 * 1000 => {
                integer(&sender, "last_received_hop").unwrap_or(0) + 1
            }
            _ => 0,
        };
        let hop = if sender_tty == Some(1) {
            0
        } else {
            parent
                .as_ref()
                .map_or(0, |p| optional_ms(p, "hop") + 1)
                .max(causal)
        };
        let existing = !self
            .store
            .all(
                "SELECT 1 FROM messages WHERE thread = ? LIMIT 1",
                &[string(&thread)],
            )
            .await?
            .is_empty();
        if existing && parent.is_none() && !self.thread_member(&thread, from).await? {
            return Err(RpcError::new(
                ErrorCode::NotFound,
                format!("no thread {thread} to continue"),
            ));
        }
        self.check_send(
            &SendGuard {
                sender: &sender,
                recipients: &recipients,
                addressed: &addressed,
                thread: &thread,
                hop,
                has_parent: parent.is_some(),
                tty: sender_tty,
                fan_out: &fan_out,
            },
            now,
        )
        .await?;
        for recipient in &recipients {
            let to = text(recipient, "id").unwrap_or("");
            let first_reply = kind == "reply"
                && parent
                    .as_ref()
                    .is_some_and(|p| text(p, "from_ep") == Some(to))
                && {
                    let parent_id = parent.as_ref().and_then(|p| text(p, "id")).unwrap_or("");
                    !self.store.all("SELECT 1 FROM deliveries WHERE message_id = ? AND endpoint = ?", &[string(parent_id), string(from)]).await?.is_empty()
                        && self.store.all("SELECT 1 FROM messages WHERE reply_to = ? AND from_ep = ? AND kind = 'reply'", &[string(parent_id), string(from)]).await?.is_empty()
                };
            if first_reply {
                continue;
            }
            let unacked = self.store.all("SELECT COUNT(*) AS n FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ?", &[string(to), SqlValue::Int(now)]).await?.first().and_then(|r| integer(r, "n")).unwrap_or(0);
            if unacked >= LIMITS.inbox_max as i64 {
                let name = address(recipient);
                return Err(self
                    .refuse(
                        from,
                        ErrorCode::InboxFull,
                        format!("{name} has {unacked} unread messages"),
                        None,
                        json!({"to": [name], "limit": LIMITS.inbox_max}),
                    )
                    .await?);
            }
        }
        let tree_send = text(&sender, "kind") == Some("agent");
        let id = new_id("msg", now);
        let expires = now.saturating_add(ttl.saturating_mul(1000));
        let to = if targets.len() == 1 {
            targets[0].as_str().unwrap_or("").to_owned()
        } else {
            targets
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        };
        let attachments_json = Value::Array(
            attachments
                .iter()
                .map(|path| json!({"kind": "path", "path": path}))
                .collect(),
        )
        .to_string();
        let result = crate::store::transaction(self.store.clone(), async {
            self.store.all("INSERT INTO messages (id,thread,reply_to,kind,from_ep,to_addr,body,mime,data_class,attachments,hop,created_at,expires_at,sender_tty,require_reply,link_parent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", &[
                string(&id), string(&thread), parent.as_ref().and_then(|p| text(p,"id")).map_or(SqlValue::Null, string), string(kind), string(from), string(&to), string(body), string(&mime), string(data_class), string(&attachments_json), SqlValue::Int(hop), SqlValue::Int(now), SqlValue::Int(expires),
                sender_tty.map_or(SqlValue::Null, SqlValue::Int),
                if require_reply { SqlValue::Int(1) } else { SqlValue::Null },
                if origin.link.is_some() { string(address(&sender)) } else { SqlValue::Null },
            ]).await?;
            if let Some(parent_id) = parent.as_ref().and_then(|p| text(p, "id")) {
                self.store.all("UPDATE deliveries SET acked_at = ? WHERE message_id = ? AND endpoint = ? AND acked_at IS NULL", &[SqlValue::Int(now), string(parent_id), string(from)]).await?;
            }
            let mut deliveries = Vec::new();
            for recipient in &recipients {
                let endpoint = text(recipient, "id").ok_or_else(RpcError::internal)?;
                let seq = self.insert_delivery(&id, endpoint, expires).await?;
                self.record_send(&sender, recipient, tree_send, now).await?;
                let view = self.view(recipient).await?;
                let state = view["presence"].as_str().unwrap_or("offline");
                let hibernated = state == "hibernated";
                let queued = state == "offline" || hibernated;
                let offline = state == "offline"
                    && now - optional_ms(recipient, "last_seen").max(optional_ms(recipient, "hook_seen")) >= ASK_ENDED_GRACE_MS;
                let reach = Self::reach(recipient, offline);
                let woken = reach == Some("running") && text(recipient, "status_state") == Some("done");
                let mut delivery = json!({"endpoint": endpoint, "address": view["address"], "seq": seq, "offline": offline});
                if queued {
                    delivery["queued"] = json!(true);
                }
                delivery["last_seen"] = view["last_seen"].clone();
                if let Some(reach) = reach {
                    delivery["state"] = json!(reach);
                }
                if hibernated && integer(recipient, "wake_declined").is_some() {
                    delivery["wake"] = json!("declined");
                } else if let Some(wake) = view["wake"].as_str().filter(|w| *w != "none") {
                    delivery["wake"] = json!(wake);
                }
                if state == "idle" || woken {
                    delivery["idle"] = json!(true);
                }
                if hibernated {
                    delivery["hibernated"] = json!(true);
                    if let Some(eta) = integer(recipient, "wake_eta") {
                        delivery["wake_eta_s"] = json!(eta);
                    }
                }
                deliveries.push(delivery);
            }
            for name in &fan_out {
                self.record_group(name, now).await?;
            }
            let mut sent = json!({"id": id, "thread": thread, "hop": hop, "deliveries": deliveries});
            if !warnings.is_empty() {
                sent["warnings"] = json!(warnings);
            }
            if let Some(client_id) = &client_id {
                self.store.all("INSERT OR REPLACE INTO idempotency (from_ep, client_id, payload_hash, result, created_at) VALUES (?, ?, ?, ?, ?)", &[string(from), string(client_id), string(&payload_hash), string(sent.to_string()), SqlValue::Int(now)]).await?;
            }
            self.audit("send", Some(from), Some(&id), json!({"to": addressed, "kind": kind, "bytes": body.len(), "hop": hop, "thread": thread, "data_class": data_class})).await?;
            if let Some(auth) = origin.link {
                self.audit("adopt_request", Some(from), Some(&id), json!({"by": address(&sender), "auth": auth, "target": addressed[0], "parent": address(&sender)})).await?;
            }
            for recipient in &recipients {
                self.detect_ping_pong(&sender, recipient, now).await?;
            }
            Ok::<_, RpcError>(sent)
        })
        .await?;
        for recipient in &recipients {
            if let Some(id) = text(recipient, "id") {
                self.state.wake(id);
            }
        }
        self.notify_watchers(json!({"type": "message", "id": result["id"], "thread": result["thread"], "kind": kind, "from": address(&sender), "to": addressed, "hop": hop})).await;
        self.report_local(from, kind, &result);
        Ok(result)
    }

    /// reading messages counts as receiving them for the causal hop
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
        self.received(endpoint, &rows, now).await?;
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
        if let Some(remote) = sender.as_ref().and_then(|s| text(s, "remote")) {
            from["auth"] = json!(
                sender
                    .as_ref()
                    .and_then(|s| text(s, "auth"))
                    .unwrap_or("local-uid")
            );
            let machine = crate::bridge::machine_part(remote);
            if !crate::bridge::is_foreign(remote) && !self.is_local_user(machine) {
                from["machine"] = json!(machine);
                if sender.as_ref().and_then(|s| text(s, "kind")) == Some("human")
                    && integer(row, "sender_tty") == Some(1)
                {
                    from["human"] = json!(true);
                }
            }
        }
        let to = text(row, "to_addr").unwrap_or("");
        let to = if to.contains(',') || to == "tree:children" || to.starts_with("group:") {
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
        if integer(row, "seq").is_some() {
            let kin = self
                .kinship(
                    sender.as_ref(),
                    recipient.as_ref(),
                    integer(row, "created_at").unwrap_or(0),
                )
                .await?;
            if let Some(object) = envelope.as_object_mut() {
                object.extend(kin);
            }
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

    /// `message`: a delivery to `endpoint` by id, seq, unique suffix or `last`; with `member`, another endpoint's message in its threads
    pub async fn message_rpc(
        &self,
        endpoint: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let id = params
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid_params("id is a message id"))?;
        if let Some(found) = self.message_by_ref(endpoint, id).await? {
            return Ok(json!({"message": found}));
        }
        if params.get("member") != Some(&Value::Bool(true)) {
            return Ok(json!({"message": null}));
        }
        let row = self.member_message(endpoint, id).await?;
        let Some(row) = row.filter(|row| text(row, "from_ep") != Some(endpoint)) else {
            return Ok(json!({"message": null}));
        };
        let from = text(&row, "from_ep").unwrap_or("");
        Ok(json!({"message": {
            "id": text(&row, "id"), "thread": text(&row, "thread"), "kind": text(&row, "kind"),
            "created_at": iso(integer(&row, "created_at")),
            "from": {"address": self.address_of(from).await?, "endpoint": from},
        }}))
    }

    async fn message_by_ref(&self, endpoint: &str, id: &str) -> Result<Option<Value>, RpcError> {
        let query = "SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND d.expires_at > ?";
        let now = now_ms();
        let base = [string(endpoint), SqlValue::Int(now)];
        let first = |rows: Vec<Row>| rows.into_iter().next();
        let exact = first(
            self.store
                .all(
                    &format!("{query} AND m.id = ? ORDER BY d.seq LIMIT 1"),
                    &[base[0].clone(), base[1].clone(), string(id)],
                )
                .await?,
        );
        if let Some(row) = exact {
            return Ok(Some(self.message_envelope(&row, endpoint).await?));
        }
        if id == "last" {
            let newest = first(
                self.store
                    .all(
                        &format!("{query} ORDER BY d.seq DESC LIMIT 1"),
                        &[base[0].clone(), base[1].clone()],
                    )
                    .await?,
            );
            let Some(newest) = newest else {
                return Ok(None);
            };
            let seq = integer(&newest, "seq").unwrap_or(0);
            let unread = !self.store.all("SELECT 1 FROM deliveries WHERE seq = ? AND COALESCE(acked_at, injected_at) IS NULL", &[SqlValue::Int(seq)]).await?.is_empty();
            let envelope = self.message_envelope(&newest, endpoint).await?;
            if unread {
                return Err(RpcError::invalid_params(format!(
                    "a newer message arrived from {} ({}); read it first or name the id",
                    envelope["from"]["address"].as_str().unwrap_or(""),
                    short_id(text(&newest, "id").unwrap_or(""))
                )));
            }
            return Ok(Some(envelope));
        }
        let by_seq = if !id.is_empty() && id.len() <= 15 && id.bytes().all(|c| c.is_ascii_digit()) {
            first(
                self.store
                    .all(
                        &format!("{query} AND d.seq = ?"),
                        &[
                            base[0].clone(),
                            base[1].clone(),
                            SqlValue::Int(id.parse().unwrap_or(0)),
                        ],
                    )
                    .await?,
            )
        } else {
            None
        };
        if !suffix(id) {
            return match by_seq {
                Some(row) => Ok(Some(self.message_envelope(&row, endpoint).await?)),
                None => Ok(None),
            };
        }
        let rows = self
            .store
            .all(
                &format!("{query} AND substr(m.id, -?) = ? ORDER BY d.seq DESC LIMIT 50"),
                &[
                    base[0].clone(),
                    base[1].clone(),
                    SqlValue::Int(id.len() as i64),
                    string(id),
                ],
            )
            .await?;
        let mut ids: Vec<String> = Vec::new();
        for row in &rows {
            if let Some(found) = text(row, "id")
                && !ids.iter().any(|v| v == found)
            {
                ids.push(found.to_owned());
            }
        }
        if ids.len() > 1 {
            return Err(ambiguous(id, &ids, "delivered to you"));
        }
        if let (Some(seq), Some(row)) = (&by_seq, rows.first())
            && text(seq, "id") != text(row, "id")
        {
            return Err(RpcError::invalid_params(format!(
                "{id} is the seq of one message and the short id of another ({}); give the full id",
                short_id(text(row, "id").unwrap_or(""))
            )));
        }
        match by_seq.or_else(|| rows.into_iter().next()) {
            Some(row) => Ok(Some(self.message_envelope(&row, endpoint).await?)),
            None => Ok(None),
        }
    }

    /// `receipts`: for a message `endpoint` sent, when each recipient read it and when a hook showed it
    pub async fn receipts(
        &self,
        endpoint: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let id = params
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| RpcError::invalid_params("id is a message id"))?;
        let sent = "SELECT id, thread FROM messages WHERE from_ep = ?";
        let mut rows = if id == "last" {
            self.store
                .all(
                    &format!("{sent} ORDER BY created_at DESC, id DESC LIMIT 1"),
                    &[string(endpoint)],
                )
                .await?
        } else {
            self.store
                .all(
                    &format!("{sent} AND id = ?"),
                    &[string(endpoint), string(id)],
                )
                .await?
        };
        if rows.is_empty() && suffix(id) {
            rows = self
                .store
                .all(
                    &format!("{sent} AND substr(id, -?) = ? ORDER BY created_at DESC LIMIT 6"),
                    &[string(endpoint), SqlValue::Int(id.len() as i64), string(id)],
                )
                .await?;
        }
        if rows.len() > 1 {
            let ids = rows
                .iter()
                .filter_map(|row| text(row, "id").map(str::to_owned))
                .collect::<Vec<_>>();
            return Err(ambiguous(id, &ids, "you sent"));
        }
        let message = rows.into_iter().next().ok_or_else(|| {
            RpcError::new(
                ErrorCode::NotFound,
                format!("no message {id} that you sent"),
            )
        })?;
        let message_id = text(&message, "id").unwrap_or("");
        let deliveries = self.store.all("SELECT endpoint, acked_at, injected_at, deferred_ack FROM deliveries WHERE message_id = ? ORDER BY seq", &[string(message_id)]).await?;
        let mut recipients = Vec::new();
        for delivery in &deliveries {
            let mut entry = json!({"address": self.address_of(text(delivery, "endpoint").unwrap_or("")).await?});
            if integer(delivery, "deferred_ack").is_some_and(|v| v != 0) {
                entry["read_at"] = Value::Null;
                entry["delivered_at"] = iso(integer(delivery, "acked_at"));
            } else {
                entry["read_at"] = iso(integer(delivery, "acked_at"));
            }
            entry["shown_at"] = iso(integer(delivery, "injected_at"));
            recipients.push(entry);
        }
        Ok(json!({"id": message_id, "thread": text(&message, "thread"), "recipients": recipients}))
    }

    async fn own_request(&self, endpoint: &str, request: &str) -> Result<Row, RpcError> {
        self.store
            .all("SELECT * FROM messages WHERE id = ?", &[string(request)])
            .await?
            .into_iter()
            .next()
            .filter(|row| text(row, "from_ep") == Some(endpoint))
            .ok_or_else(|| {
                RpcError::new(
                    ErrorCode::NotFound,
                    format!("no request {request} from this endpoint"),
                )
            })
    }

    /// the first reply to a request this endpoint sent, from one of the request's recipients; reading it counts as receiving
    async fn reply_to(&self, endpoint: &str, request: &str) -> Result<Option<Value>, RpcError> {
        self.own_request(endpoint, request).await?;
        let now = now_ms();
        let rows = self.store.all("SELECT m.*, d.seq AS seq FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE m.reply_to = ? AND m.kind = 'reply' AND d.endpoint = ? AND d.expires_at > ? AND (m.from_ep IN (SELECT a.endpoint FROM deliveries a WHERE a.message_id = m.reply_to) OR NOT EXISTS (SELECT 1 FROM deliveries a WHERE a.message_id = m.reply_to)) ORDER BY d.seq LIMIT 1", &[string(request), string(endpoint), SqlValue::Int(now)]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        self.received(endpoint, &rows, now).await?;
        Ok(Some(self.message_envelope(row, endpoint).await?))
    }

    /// the recipients that were present for a request, once every one has ended, with their states
    async fn request_ended(
        &self,
        endpoint: &str,
        request: &str,
        present: Option<&[String]>,
    ) -> Result<Option<Value>, RpcError> {
        let asked = self.own_request(endpoint, request).await?;
        let created = optional_ms(&asked, "created_at");
        let now = now_ms();
        let rows = self.store.all("SELECT * FROM endpoints WHERE id IN (SELECT endpoint FROM deliveries WHERE message_id = ?) AND id != ? ORDER BY handle", &[string(request), string(endpoint)]).await?;
        let rows = rows
            .into_iter()
            .filter(|row| match present {
                Some(present) => present
                    .iter()
                    .any(|id| Some(id.as_str()) == text(row, "id")),
                None => {
                    presence(row, now) != "offline"
                        || optional_ms(row, "last_seen")
                            .max(optional_ms(row, "hook_seen"))
                            .max(optional_ms(row, "hook_ended"))
                            >= created
                }
            })
            .collect::<Vec<_>>();
        let gone = |row: &Row| {
            presence(row, now) == "offline"
                && (optional_ms(row, "hook_ended") >= created
                    && integer(row, "hook_ended").is_some()
                    || text(row, "status_state") == Some("done")
                    || now - optional_ms(row, "last_seen").max(optional_ms(row, "hook_seen"))
                        >= ASK_ENDED_GRACE_MS)
        };
        if rows.is_empty() || !rows.iter().all(gone) {
            return Ok(None);
        }
        Ok(Some(Value::Array(
            rows.iter()
                .map(|row| json!({"address": address(row), "state": text(row, "status_state")}))
                .collect(),
        )))
    }

    /// an ask's outcome once it has one: the reply (acked), expiry or every present recipient ended
    pub async fn ask_check(
        &mut self,
        endpoint: &str,
        request: &str,
        present: Option<&[String]>,
        sent: Option<&Value>,
    ) -> Result<Option<Value>, RpcError> {
        let mut result = sent.cloned().unwrap_or_else(|| json!({}));
        result["id"] = json!(request);
        if let Some(reply) = self.reply_to(endpoint, request).await? {
            self.ack(endpoint, &json!([reply["seq"]])).await?;
            result["reply"] = reply;
            return Ok(Some(result));
        }
        let expired = self
            .store
            .all(
                "SELECT expires_at FROM messages WHERE id = ?",
                &[string(request)],
            )
            .await?
            .first()
            .is_none_or(|row| optional_ms(row, "expires_at") <= now_ms());
        if expired {
            result["expired"] = json!(true);
            return Ok(Some(result));
        }
        if let Some(ended) = self.request_ended(endpoint, request, present).await? {
            result["pending"] = json!(true);
            result["ended"] = ended;
            return Ok(Some(result));
        }
        Ok(None)
    }

    pub async fn ask_wait(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let id = params
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid_params("id is the request's message id"))?
            .to_owned();
        Ok(match self.ask_check(endpoint, &id, None, None).await? {
            Some(done) => done,
            None => pending(None, &id),
        })
    }

    /// `watch`: marks the connection a watcher and returns the current fleet
    pub async fn watch(&mut self, conn: ConnectionId) -> Result<Value, RpcError> {
        if let Some(connection) = self.state.connections.get_mut(&conn) {
            connection.watching = true;
        }
        let mut params = Map::new();
        params.insert("activity".into(), json!(20));
        self.snapshot_for(conn, &params).await
    }

    /// long polls of inbox, ask and ask_wait: waits outside the core lock for a delivery, the deadline, a close or shutdown
    pub async fn poll(
        shared: SharedCore,
        mut guard: OwnedMutexGuard<Self>,
        conn: ConnectionId,
        method: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let wait = wait_seconds(params.get("wait_s"), guard.limit("waitMaxS", 50))?;
        let mut result = guard.dispatch(conn, method, params).await?;
        let finished = |method: &str, result: &Value| {
            if method == "inbox" {
                !result["messages"].as_array().is_some_and(Vec::is_empty)
            } else {
                ["reply", "expired", "ended", "held"]
                    .iter()
                    .any(|key| result.get(*key).is_some())
            }
        };
        if wait.is_zero() || finished(method, &result) {
            return Ok(result);
        }
        let deadline = Instant::now() + wait;
        let request = result["id"].as_str().unwrap_or("").to_owned();
        let present = (method == "ask").then(|| present(&result)).flatten();
        let sent = (method == "ask").then(|| {
            let mut sent = result.clone();
            if let Some(object) = sent.as_object_mut() {
                object.remove("pending");
            }
            sent
        });
        loop {
            let connection =
                guard.state.connections.get(&conn).ok_or_else(|| {
                    RpcError::new(ErrorCode::Unauthorized, "connection is closed")
                })?;
            let endpoint = connection
                .endpoint
                .clone()
                .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "call hello first"))?;
            let closed = connection.closed.clone();
            let stopping = guard.state.stopping.clone();
            let waiter = guard.state.waiter(&endpoint);
            let notified = waiter.notified();
            let disconnected = closed.notified();
            let stopped = stopping.notified();
            tokio::pin!(notified, disconnected, stopped);
            notified.as_mut().enable();
            disconnected.as_mut().enable();
            stopped.as_mut().enable();
            let until = if method == "inbox" {
                deadline
            } else {
                deadline.min(Instant::now() + ASK_RECHECK)
            };
            drop(guard);
            let mut gone = false;
            tokio::select! {
                _ = &mut notified => {},
                _ = &mut disconnected => gone = true,
                _ = &mut stopped => {},
                _ = tokio::time::sleep_until(until) => {},
            }
            guard = shared.clone().lock_owned().await;
            if guard.state.closing {
                return Err(RpcError::new(
                    ErrorCode::Unauthorized,
                    "the relay broker is stopping",
                ));
            }
            if gone || !guard.state.connections.contains_key(&conn) {
                return Ok(result);
            }
            if method == "inbox" {
                result = guard.dispatch(conn, method, params).await?;
                if finished(method, &result) {
                    return Ok(result);
                }
            } else if let Some(done) = guard
                .ask_check(&endpoint, &request, present.as_deref(), sent.as_ref())
                .await?
            {
                return Ok(done);
            }
            if Instant::now() >= deadline {
                return Ok(result);
            }
        }
    }
}

/// an agent's last work for the wake watermark: its claim, a hook, a read or a message queued to it, never a keepalive
pub fn worked_at(row: &Row) -> i64 {
    ["created_at", "hook_seen", "last_received_at", "mail_at"]
        .iter()
        .map(|key| optional_ms(row, key))
        .max()
        .unwrap_or(0)
}

impl Core {
    /// per endpoint id, when its newest unread message was sent
    pub async fn unread_at(&self) -> Result<std::collections::HashMap<String, i64>, RpcError> {
        Ok(self.store.all("SELECT d.endpoint AS endpoint, MAX(m.created_at) AS at FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.acked_at IS NULL AND d.expires_at > ? GROUP BY d.endpoint", &[SqlValue::Int(now_ms())]).await?
            .iter()
            .filter_map(|row| Some((text(row, "endpoint")?.to_owned(), integer(row, "at")?)))
            .collect())
    }
}

/// the recipients of an ask that were not offline at the send
fn present(sent: &Value) -> Option<Vec<String>> {
    sent["deliveries"].as_array().map(|deliveries| {
        deliveries
            .iter()
            .filter(|d| d["offline"] != Value::Bool(true))
            .filter_map(|d| d["endpoint"].as_str().map(str::to_owned))
            .collect()
    })
}

fn pending(sent: Option<&Value>, id: &str) -> Value {
    let mut result = sent.cloned().unwrap_or_else(|| json!({}));
    result["id"] = json!(id);
    result["pending"] = json!(true);
    result
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

/// the body cap from the limits, `None` when disabled
pub(crate) fn body_cap(limits: &crate::proto::Limits) -> Option<u64> {
    limits
        .0
        .get("bodyBytes")
        .copied()
        .unwrap_or(Some(LIMITS.body_bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::Limits;

    fn code(params: Value, limits: &Limits) -> Option<ErrorCode> {
        validate_send(params.as_object().unwrap(), limits)
            .err()
            .and_then(|e| e.data.map(|d| d.code))
    }

    #[test]
    fn body_cap_defaults_and_can_be_lifted() {
        let mut limits = Limits::default();
        assert_eq!(body_cap(&limits), Some(LIMITS.body_bytes));
        limits.0.insert("bodyBytes".into(), Some(10));
        assert_eq!(body_cap(&limits), Some(10));
        limits.0.insert("bodyBytes".into(), None);
        assert_eq!(body_cap(&limits), None);
        assert_eq!(
            code(json!({"body":1}), &limits),
            Some(ErrorCode::InvalidParams)
        );
        assert_eq!(
            code(json!({"body":"hi","id":"x"}), &limits),
            Some(ErrorCode::InvalidParams)
        );
    }
}
