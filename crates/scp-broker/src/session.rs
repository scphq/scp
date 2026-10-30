use std::collections::HashSet;

use scp_core::protocol::ErrorCode;
use serde_json::{Map, Value, json};

use crate::claims::same_harness;
use crate::core::{Core, integer, now_ms, text};
use crate::proto::RpcError;
use crate::scrub::{find_secret, redact_secrets, strip_control};
use crate::state::{ConnectionId, Mode};
use crate::store::{Row, SqlValue};

pub fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn clean_text(
    value: Option<&Value>,
    field: &str,
    max: u64,
) -> Result<Option<String>, RpcError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| RpcError::invalid_params(format!("{field} must be a string")))?;
    let value = strip_control(value).trim_matches(js_whitespace).to_owned();
    if value.encode_utf16().count() as u64 > max {
        return Err(RpcError::new(
            ErrorCode::TooLarge,
            format!("{field} is longer than {max} characters"),
        ));
    }
    Ok(Some(value))
}

pub fn one_line(value: Option<&Value>, field: &str, max: u64) -> Result<Option<String>, RpcError> {
    if let Some(value) = value.and_then(Value::as_str) {
        let collapsed = value
            .split(js_whitespace)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        clean_text(Some(&Value::String(collapsed)), field, max)
    } else {
        clean_text(value, field, max)
    }
}

fn utf16_cut(value: &str, max: usize) -> String {
    let mut remaining = max;
    value
        .chars()
        .take_while(|c| {
            if remaining < c.len_utf16() {
                return false;
            }
            remaining -= c.len_utf16();
            true
        })
        .collect()
}

pub fn hook_title(value: &str) -> Option<String> {
    let value = utf16_cut(value, 4096);
    let collapsed = value
        .split(js_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let value = strip_control(&redact_secrets(&collapsed));
    let value = utf16_cut(&value, 64).trim_matches(js_whitespace).to_owned();
    (!value.is_empty() && find_secret(&value).is_none()).then_some(value)
}

impl Core {
    pub async fn secret_refused(
        &self,
        endpoint: &str,
        message: &str,
    ) -> Result<RpcError, RpcError> {
        self.audit(
            "refuse",
            Some(endpoint),
            None,
            json!({"code":"secret_refused", "message":message}),
        )
        .await?;
        Ok(RpcError::new(ErrorCode::SecretRefused, message))
    }

    pub async fn status(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        if let Some(state) = params.get("state")
            && !state
                .as_str()
                .is_some_and(|state| ["working", "waiting", "blocked", "done"].contains(&state))
        {
            return Err(RpcError::invalid_params(
                "state must be one of working, waiting, blocked, done",
            ));
        }
        let note = one_line(
            params.get("note"),
            "note",
            self.limits.get("noteChars").unwrap_or(280),
        )?;
        if note
            .as_deref()
            .is_some_and(|note| find_secret(note).is_some())
        {
            return Err(self
                .secret_refused(
                    endpoint,
                    "the status note looks like it carries a credential",
                )
                .await?);
        }
        self.store.all("UPDATE endpoints SET status_state = COALESCE(?, status_state, 'working'), status_note = COALESCE(?, status_note, ''), last_seen = ?, tldr_turn = CASE WHEN ? THEN COALESCE(prompts, 0) ELSE tldr_turn END WHERE id = ?", &[
            params.get("state").and_then(Value::as_str).map_or(SqlValue::Null, |v| SqlValue::Text(v.into())),
            note.as_ref().map_or(SqlValue::Null, |v| SqlValue::Text(v.clone())), SqlValue::Int(now_ms()), SqlValue::Int(i64::from(note.is_some())), SqlValue::Text(endpoint.into()),
        ]).await?;
        let view = self.view(&self.must_endpoint(endpoint).await?).await?;
        self.notify_watchers(
            json!({"type":"status","endpoint":view["address"],"status":view["status"]}),
        )
        .await;
        Ok(view)
    }

    pub async fn title(
        &mut self,
        endpoint: &str,
        value: Option<&Value>,
        mode: &Mode,
    ) -> Result<Value, RpcError> {
        if *mode == Mode::Transient {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "a hook connection cannot set a title",
            ));
        }
        let row = self.must_endpoint(endpoint).await?;
        if text(&row, "kind") != Some("agent") {
            return Err(RpcError::invalid_params(
                "only an agent endpoint has a title",
            ));
        }
        let title = one_line(value, "title", 64)?.filter(|title| !title.is_empty());
        if title
            .as_deref()
            .is_some_and(|title| find_secret(title).is_some())
        {
            return Err(self
                .secret_refused(endpoint, "the title looks like it carries a credential")
                .await?);
        }
        self.store
            .all(
                "UPDATE endpoints SET title = ?, title_auto = NULL, title_turn = NULL WHERE id = ?",
                &[
                    title
                        .as_ref()
                        .map_or(SqlValue::Null, |value| SqlValue::Text(value.clone())),
                    SqlValue::Text(endpoint.into()),
                ],
            )
            .await?;
        self.audit("title", Some(endpoint), None, json!({"title":title}))
            .await?;
        self.view(&self.must_endpoint(endpoint).await?).await
    }

    pub async fn title_infer_rpc(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let (endpoint, hook) = self.hook_of(conn)?;
        self.title_infer_as(&endpoint, params, &hook).await
    }

    pub async fn title_infer(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        self.title_infer_as(endpoint, params, &HookOf::default())
            .await
    }

    async fn title_infer_as(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
        hook: &HookOf,
    ) -> Result<Value, RpcError> {
        let from = params
            .get("from")
            .and_then(Value::as_str)
            .filter(|value| ["summary", "prompt"].contains(value))
            .ok_or_else(|| RpcError::invalid_params("from is summary or prompt"))?;
        let value = params
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid_params("text must be a string"))?;
        let row = self.must_endpoint(endpoint).await?;
        if text(&row, "kind") != Some("agent") || !self.holds(&row, hook).await? {
            return Ok(json!({"changed":false}));
        }
        let Some(title) = hook_title(value) else {
            return Ok(json!({"changed":false}));
        };
        let old = text(&row, "title");
        let turn = integer(&row, "prompts").unwrap_or(0);
        if text(&row, "kind") != Some("agent")
            || old == Some(title.as_str())
            || (old.is_some() && old != text(&row, "title_auto"))
            || (from == "prompt" && old.is_some())
            || (from == "summary"
                && old.is_some()
                && integer(&row, "title_turn").is_some_and(|last| {
                    turn - last < self.limits.get("titleRefreshTurns").unwrap_or(5) as i64
                }))
        {
            return Ok(json!({"changed":false}));
        }
        self.store
            .all(
                "UPDATE endpoints SET title = ?, title_auto = ?, title_turn = ? WHERE id = ?",
                &[
                    SqlValue::Text(title.clone()),
                    SqlValue::Text(title),
                    if from == "summary" {
                        SqlValue::Int(turn)
                    } else {
                        SqlValue::Null
                    },
                    SqlValue::Text(endpoint.into()),
                ],
            )
            .await?;
        Ok(json!({"changed":true}))
    }

    pub async fn prompted_rpc(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let (endpoint, hook) = self.hook_of(conn)?;
        self.prompted_as(&endpoint, params, &hook).await
    }

    pub async fn prompted(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        self.prompted_as(endpoint, params, &HookOf::default()).await
    }

    async fn prompted_as(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
        hook: &HookOf,
    ) -> Result<Value, RpcError> {
        if !self
            .holds(&self.must_endpoint(endpoint).await?, hook)
            .await?
        {
            return Ok(json!({"prompted":false}));
        }
        self.store
            .all(
                "UPDATE endpoints SET prompts = COALESCE(prompts, 0) + 1, pushes = 0 WHERE id = ?",
                &[SqlValue::Text(endpoint.into())],
            )
            .await?;
        self.turn_runs(endpoint).await?;
        self.settle(endpoint).await?;
        self.state.wake(endpoint);
        let row = self.must_endpoint(endpoint).await?;
        let turn = integer(&row, "prompts").unwrap_or(0);
        let every = params
            .get("tldr_every")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0 && value.fract() == 0.0);
        let due = text(&row, "kind") == Some("agent")
            && every.is_some_and(|every| {
                (turn - integer(&row, "tldr_turn").unwrap_or(0)) as f64 >= every
            });
        if due {
            self.store
                .all(
                    "UPDATE endpoints SET tldr_turn = ? WHERE id = ?",
                    &[SqlValue::Int(turn), SqlValue::Text(endpoint.into())],
                )
                .await?;
        }
        Ok(if due {
            json!({"prompted":true,"tldr":true})
        } else {
            json!({"prompted":true})
        })
    }
}

mod push;
pub use push::{LiveWorkers, wakes};

const GONE_PREFIX: &str = "_gone_";

/// who calls for an endpoint: a hook connection names the harness process it runs in
#[derive(Clone, Debug, Default)]
pub struct HookOf {
    pub transient: bool,
    pub process: Option<String>,
}

fn sv(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

pub fn flag(params: &Map<String, Value>, key: &str) -> bool {
    params.get(key) == Some(&Value::Bool(true))
}

fn hold_id(now: i64) -> String {
    format!("hld_{:x}{:016x}", now.max(0), rand::random::<u64>())
}

pub fn seq_list(value: Option<&Value>, page: i64) -> Result<Vec<i64>, RpcError> {
    let list = value
        .and_then(Value::as_array)
        .filter(|list| {
            list.iter().all(|value| {
                value
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && n.fract() == 0.0)
            })
        })
        .ok_or_else(|| RpcError::invalid_params("seqs must be a list of integers"))?;
    if list.len() as i64 > page {
        return Err(RpcError::invalid_params(format!(
            "at most {page} seqs per ack"
        )));
    }
    Ok(list
        .iter()
        .filter_map(Value::as_f64)
        .filter(|n| n.abs() < 9.0e15)
        .map(|n| n as i64)
        .collect())
}

fn attr(value: &str) -> String {
    strip_control(value)
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// plain text with control characters out and only a framing tag's `<` escaped
fn escape_body(text: &str) -> String {
    static FRAME: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let frame = FRAME.get_or_init(|| {
        regex::Regex::new(r"(?i)^(?:\s*[/\x{ff0f}]\s*)?(?:relay|channel|system[-_]?reminder)")
            .expect("constant framing pattern")
    });
    let text = strip_control(text);
    let mut out = String::with_capacity(text.len());
    for (i, c) in text.char_indices() {
        if matches!(c, '<' | '\u{ff1c}' | '\u{fe64}') {
            let rest = &text[i + c.len_utf8()..];
            if let Some(found) = frame.find(rest)
                && !rest[found.end()..]
                    .chars()
                    .next()
                    .is_some_and(|n| n.is_ascii_alphanumeric())
            {
                out.push_str("&lt;");
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// a delivered message as the data block a hook hands the model, then what its sender expects
pub fn wrap_message(m: &Value) -> String {
    let s = |v: &Value| v.as_str().unwrap_or("").to_owned();
    let address = s(&m["from"]["address"]);
    let human = m["from"]["human"] == json!(true);
    let from = if human && address.ends_with('/') {
        format!("{address}me")
    } else {
        address
    };
    let mut attrs: Vec<(&str, String)> = vec![("from", from.clone())];
    if let Some(relation) = m["relation"].as_str() {
        attrs.push(("relation", relation.into()));
    }
    if let Some(key) = m["parent_key"].as_str() {
        attrs.push(("key", key.into()));
    }
    if human {
        attrs.push(("human", "true".into()));
    }
    if let Some(account) = m["from"]["account"].as_str() {
        attrs.push(("account", account.into()));
        attrs.push(("contact", "true".into()));
    }
    attrs.push((
        "harness",
        m["from"]["claims"]["harness"]
            .as_str()
            .unwrap_or("unknown")
            .into(),
    ));
    attrs.push(("auth", s(&m["from"]["auth"])));
    if m["from"]["claims"]["tty"] == json!(false) {
        attrs.push(("tty", "false".into()));
    }
    let kind = s(&m["kind"]);
    let id = s(&m["id"]);
    attrs.push(("kind", kind.clone()));
    attrs.push(("class", s(&m["data_class"])));
    attrs.push(("id", id.clone()));
    attrs.push(("short", id[id.len().saturating_sub(6)..].to_owned()));
    attrs.push(("thread", s(&m["thread"])));
    if let Some(reply_to) = m["reply_to"].as_str() {
        attrs.push(("reply_to", reply_to.into()));
    }
    if let Some(seq) = m["seq"].as_i64() {
        attrs.push(("seq", seq.to_string()));
    }
    let target = m.get("for").filter(|v| v.is_object());
    if let Some(target) = target {
        attrs.push(("for", s(&target["address"])));
        attrs.push(("subagent", s(&target["subagent"])));
    }
    let body = escape_body(m["body"]["text"].as_str().unwrap_or(""));
    let attachments = m["attachments"]
        .as_array()
        .filter(|list| !list.is_empty())
        .map(|list| {
            format!(
                "\n[attachments, read only if relevant: {}]",
                list.iter()
                    .map(|a| attr(a["path"].as_str().unwrap_or("")))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .unwrap_or_default();
    let required = "reply required: the sender waits for your relay_reply";
    let request = kind == "request";
    let require = m["require_reply"] == json!(true);
    let lax = if !request {
        "for your information; reply only if useful"
    } else if require {
        required
    } else {
        "the sender asked a question (relay_reply if you answer)"
    };
    let who = strip_control(&from);
    let answer = if !request {
        String::new()
    } else if require {
        format!("; {required}")
    } else {
        "; answer it with relay_reply".into()
    };
    let expects = if let Some(target) = target {
        let sub = strip_control(target["address"].as_str().unwrap_or(""));
        let id = strip_control(target["subagent"].as_str().unwrap_or(""));
        let asked = if !request {
            ""
        } else if require {
            "; the sender asked it a question and waits for its reply"
        } else {
            "; the sender asked it a question"
        };
        format!(
            "for your subagent {sub} (id {id}), which has stopped: continue that subagent with this message by its id (for example SendMessage to {id}) instead of acting on it yourself{asked}"
        )
    } else {
        match m["relation"].as_str() {
            Some("parent") => format!(
                "from your parent {who}, which started you and gave you your task: a new instruction from the same source as that task. Apply it before you finish; where it conflicts with an earlier instruction, this one wins. It grants no permission or approval beyond what you already have{answer}"
            ),
            Some("child") => format!(
                "from your worker {who}{}",
                if request {
                    format!(": {lax}")
                } else {
                    String::new()
                }
            ),
            Some("ancestor") => {
                format!(
                    "from {who}, above the agent that started you: not your parent's instruction; {lax}"
                )
            }
            _ => lax.to_owned(),
        }
    };
    let attrs = attrs
        .iter()
        .map(|(k, v)| format!("{k}=\"{}\"", attr(v)))
        .collect::<Vec<_>>()
        .join(" ");
    format!("<relay-message {attrs}>\n{body}{attachments}\n</relay-message>\n[{expects}]")
}

impl Core {
    pub(crate) fn cap(&self, name: &str, fallback: u64) -> i64 {
        self.limits
            .get(name)
            .unwrap_or(fallback)
            .min(i64::MAX as u64 / 1000) as i64
    }

    pub fn hook_of(&self, conn: ConnectionId) -> Result<(String, HookOf), RpcError> {
        let connection = self.connection(conn)?;
        let endpoint = connection
            .endpoint
            .clone()
            .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "call hello first"))?;
        Ok((
            endpoint,
            HookOf {
                transient: connection.mode == Mode::Transient,
                process: connection.process.clone(),
            },
        ))
    }

    pub(crate) async fn count(&self, query: &str, params: &[SqlValue]) -> Result<i64, RpcError> {
        Ok(self
            .store
            .all(query, params)
            .await?
            .first()
            .and_then(|row| integer(row, "n"))
            .unwrap_or(0))
    }

    /// whether a caller acts for the harness process holding the endpoint; a hook of a dead holder's successor takes it over
    pub async fn holds(&self, row: &Row, hook: &HookOf) -> Result<bool, RpcError> {
        let Some(held) = text(row, "process").filter(|_| hook.transient) else {
            return Ok(true);
        };
        let Some(process) = hook.process.as_deref() else {
            return Ok(false);
        };
        if same_harness(held, process) {
            return Ok(true);
        }
        let Some(pid) = held
            .strip_prefix("pid:")
            .and_then(|rest| rest.split(':').next())
            .and_then(|pid| pid.parse::<u32>().ok())
            .filter(|pid| *pid > 0)
        else {
            return Ok(false);
        };
        if self.procs.alive(&format!("pid:{pid}")).await {
            return Ok(false);
        }
        self.store
            .all(
                "UPDATE endpoints SET process = ? WHERE id = ? AND process = ?",
                &[sv(process), sv(text(row, "id").unwrap_or("")), sv(held)],
            )
            .await?;
        Ok(true)
    }

    pub fn hook_owns(&self, row: &Row, process: Option<&str>) -> bool {
        process
            .zip(text(row, "process"))
            .is_some_and(|(a, b)| same_harness(b, a))
    }

    /// holds deliveries from the hooks under a new hold id; None when there are none
    pub(crate) async fn hold_seqs(
        &self,
        seqs: &[i64],
        now: i64,
        hold_s: Option<i64>,
    ) -> Result<Option<String>, RpcError> {
        if seqs.is_empty() {
            return Ok(None);
        }
        let hold = hold_id(now);
        let until = now + hold_s.unwrap_or_else(|| self.cap("injectHoldS", 10)) * 1000;
        for seq in seqs {
            self.store
                .all(
                    "UPDATE deliveries SET offered_until = ?, offered_hold = ? WHERE seq = ?",
                    &[SqlValue::Int(until), sv(&hold), SqlValue::Int(*seq)],
                )
                .await?;
        }
        Ok(Some(hold))
    }

    /// reading counts as receiving for the causal hop
    pub(crate) async fn received(
        &self,
        endpoint: &str,
        rows: &[Row],
        now: i64,
    ) -> Result<(), RpcError> {
        let Some(hop) = rows.iter().filter_map(|row| integer(row, "hop")).max() else {
            return Ok(());
        };
        self.store.all("UPDATE endpoints SET last_received_at = ?, last_received_hop = MAX(?, CASE WHEN last_received_at >= ? THEN COALESCE(last_received_hop, 0) ELSE 0 END) WHERE id = ?", &[SqlValue::Int(now), SqlValue::Int(hop), SqlValue::Int(now - self.cap("causalWindowS", 120) * 1000), sv(endpoint)]).await?;
        Ok(())
    }

    /// issuers of the unrevoked spawn grants with a steer key that `recipient` spent
    pub(crate) async fn steer_issuers(&self, recipient: &Row) -> Result<Vec<String>, RpcError> {
        Ok(self.store.all("SELECT DISTINCT issuer FROM grants WHERE used_by = ? AND spawn = 1 AND revoked_at IS NULL AND steer IS NOT NULL", &[sv(text(recipient, "id").unwrap_or(""))]).await?
            .iter().filter_map(|row| text(row, "issuer").map(str::to_owned)).collect())
    }

    /// how a local agent recipient stands to a local agent sender: parent, child or none
    pub(crate) async fn kin_of(
        &self,
        sender: Option<&Row>,
        recipient: Option<&Row>,
        sent_at: i64,
    ) -> Result<Option<&'static str>, RpcError> {
        let (Some(sender), Some(recipient)) = (sender, recipient) else {
            return Ok(None);
        };
        let (Some(from), Some(to)) = (text(sender, "id"), text(recipient, "id")) else {
            return Ok(None);
        };
        if from == to
            || text(sender, "kind") != Some("agent")
            || text(recipient, "kind") != Some("agent")
            || text(sender, "handle").is_some_and(|h| h.starts_with(GONE_PREFIX))
            || integer(sender, "reset_at").unwrap_or(0) > sent_at
        {
            return Ok(None);
        }
        if self.ancestors(recipient).await?.iter().any(|id| id == from)
            || !self
                .store
                .all(
                    "SELECT 1 FROM grants WHERE issuer = ? AND used_by = ? AND revoked_at IS NULL LIMIT 1",
                    &[sv(from), sv(to)],
                )
                .await?
                .is_empty()
        {
            return Ok(Some("parent"));
        }
        Ok(self
            .ancestors(sender)
            .await?
            .iter()
            .any(|id| id == to)
            .then_some("child"))
    }

    /// relation and steer key of a message: a parent without the key, to a recipient whose spawn grant has one, is only an ancestor
    pub async fn kinship(
        &self,
        sender: Option<&Row>,
        recipient: Option<&Row>,
        sent_at: i64,
    ) -> Result<Map<String, Value>, RpcError> {
        let mut out = Map::new();
        let Some(kin) = self.kin_of(sender, recipient, sent_at).await? else {
            return Ok(out);
        };
        let (Some(sender), Some(recipient)) = (sender, recipient) else {
            return Ok(out);
        };
        if kin != "parent" {
            out.insert("relation".into(), json!(kin));
            return Ok(out);
        }
        let key = self.store.all("SELECT steer FROM grants WHERE issuer = ? AND used_by = ? AND spawn = 1 AND revoked_at IS NULL AND steer IS NOT NULL AND created_at <= ? ORDER BY created_at DESC LIMIT 1", &[sv(text(sender, "id").unwrap_or("")), sv(text(recipient, "id").unwrap_or("")), SqlValue::Int(sent_at)]).await?
            .first().and_then(|row| text(row, "steer").map(str::to_owned));
        if key.is_some() || self.steer_issuers(recipient).await?.is_empty() {
            out.insert("relation".into(), json!("parent"));
            if let Some(key) = key {
                out.insert("parent_key".into(), json!(key));
            }
        } else {
            out.insert("relation".into(), json!("ancestor"));
        }
        Ok(out)
    }

    /// up to injectMessages rows, oldest first, whose wrapped text fits in `bytes`; `offered` adds each one too big, except a pushable one
    pub(crate) async fn budget(
        &self,
        rows: &[Row],
        endpoint: &str,
        bytes: i64,
        pushable: Option<(&Row, i64)>,
    ) -> Result<(Vec<Row>, Vec<Value>, Vec<i64>), RpcError> {
        let mut shown = Vec::new();
        let mut envelopes = Vec::new();
        let mut offered = Vec::new();
        let mut used = 0;
        let mut push: Option<HashSet<i64>> = None;
        let messages = self.cap("injectMessages", 5) as usize;
        let push_bytes = self.cap("pushBytes", 20480);
        for row in rows {
            let seq = integer(row, "seq").unwrap_or(0);
            let envelope = self.message_envelope(row, endpoint).await?;
            let size = wrap_message(&envelope).len() as i64;
            if size > bytes {
                if let Some((me, now)) = pushable
                    && size <= push_bytes
                {
                    if push.is_none() {
                        push = Some(self.pushable(me, now).await?);
                    }
                    if push.as_ref().is_some_and(|set| set.contains(&seq)) {
                        continue;
                    }
                }
                offered.push(seq);
                continue;
            }
            if shown.len() >= messages || used + size > bytes {
                break;
            }
            shown.push(row.clone());
            envelopes.push(envelope);
            offered.push(seq);
            used += size;
        }
        Ok((shown, envelopes, offered))
    }

    /// the agent whose unrevoked spawn grant `me` spent, while it stands to `me` as its parent, and the grant's steer key
    async fn spawner_of(
        &self,
        me: &Row,
        now: i64,
    ) -> Result<Option<(Row, Option<String>)>, RpcError> {
        let Some(grant) = self.store.all("SELECT issuer, steer FROM grants WHERE used_by = ? AND spawn = 1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", &[sv(text(me, "id").unwrap_or(""))]).await?.into_iter().next() else {
            return Ok(None);
        };
        let Some(issuer) = self.by_id(text(&grant, "issuer").unwrap_or("")).await? else {
            return Ok(None);
        };
        Ok(
            (self.kin_of(Some(&issuer), Some(me), now).await? == Some("parent"))
                .then(|| (issuer, text(&grant, "steer").map(str::to_owned))),
        )
    }

    /// the parent's messages to `me` a stop restates: not restated yet and unread or injected at or after its last tool event
    async fn late_directives(&self, me: &Row, now: i64) -> Result<Vec<Row>, RpcError> {
        let id = text(me, "id").unwrap_or("");
        let tool = self.count("SELECT COALESCE(MAX(at), 0) AS n FROM activity WHERE endpoint = ? AND kind = 'tool' AND agent IS NULL", &[sv(id)]).await?;
        let mut senders = self.steer_issuers(me).await?;
        if senders.is_empty() {
            senders = self.ancestors(me).await?;
            for row in self
                .store
                .all(
                    "SELECT issuer FROM grants WHERE used_by = ? AND revoked_at IS NULL",
                    &[sv(id)],
                )
                .await?
            {
                if let Some(issuer) = text(&row, "issuer")
                    && !senders.iter().any(|s| s == issuer)
                {
                    senders.push(issuer.to_owned());
                }
            }
        }
        if senders.is_empty() {
            return Ok(Vec::new());
        }
        let marks = vec!["?"; senders.len()].join(", ");
        let mut params = vec![sv(id), SqlValue::Int(now), SqlValue::Int(tool)];
        params.extend(senders.iter().map(sv));
        params.push(SqlValue::Int(self.cap("inboxPage", 100)));
        let rows = self.store.all(&format!("SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND d.expires_at > ? AND d.restated_at IS NULL AND (d.acked_at IS NULL OR d.injected_at >= ?) AND m.from_ep IN ({marks}) ORDER BY d.seq LIMIT ?"), &params).await?;
        let mut out = Vec::new();
        for row in rows {
            let sender = self.by_id(text(&row, "from_ep").unwrap_or("")).await?;
            let kin = self
                .kinship(
                    sender.as_ref(),
                    Some(me),
                    integer(&row, "created_at").unwrap_or(0),
                )
                .await?;
            if kin.get("relation") == Some(&json!("parent")) {
                out.push(row);
            }
        }
        Ok(out)
    }

    /// unread deliveries no hook has shown yet, held from other hooks; a stop or a count only counts, and a stop says whether to block
    pub async fn inject(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let (endpoint, hook) = self.hook_of(conn)?;
        let endpoint = endpoint.as_str();
        let now = now_ms();
        let me = self.must_endpoint(endpoint).await?;
        if !self.holds(&me, &hook).await? {
            return Ok(
                json!({"messages":[],"offered":[],"hold":null,"more":0,"unread":0,"block":false}),
            );
        }
        let (stop, count) = (flag(params, "stop"), flag(params, "count"));
        let wake = !stop
            && !count
            && params
                .get("wait_s")
                .and_then(Value::as_f64)
                .is_some_and(|v| v.is_finite() && v > 0.0);
        let mut extra = Map::new();
        if integer(&me, "briefed").is_some_and(|v| v != 0) {
            extra.insert("brief".into(), json!(true));
        }
        if !stop
            && !integer(&me, "introduced").is_some_and(|v| v != 0)
            && let Some((spawner, steer)) = self.spawner_of(&me, now).await?
        {
            extra.insert("intro".into(), json!(crate::views::address(&spawner)));
            if let Some(steer) = steer {
                extra.insert("intro_key".into(), json!(steer));
            }
        }
        let live = "d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ?";
        let fresh = format!(
            "{live} AND d.injected_at IS NULL AND (d.offered_until IS NULL OR d.offered_until <= ?)"
        );
        let id = || sv(endpoint);
        let unread = self
            .count(
                &format!("SELECT COUNT(*) AS n FROM deliveries d WHERE {live}"),
                &[id(), SqlValue::Int(now)],
            )
            .await?;
        if stop || count {
            let awaiting = self.count("SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND d.expires_at > ? AND m.require_reply = 1 AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.from_ep = d.endpoint AND r.kind = 'reply')", &[id(), SqlValue::Int(now)]).await?;
            if awaiting > 0 {
                extra.insert("awaiting".into(), json!(awaiting));
            }
            if !stop {
                let waiting = self
                    .count(
                        &format!("SELECT COUNT(*) AS n FROM deliveries d WHERE {fresh}"),
                        &[id(), SqlValue::Int(now), SqlValue::Int(now)],
                    )
                    .await?;
                let mut out = json!({"messages":[],"offered":[],"hold":null,"more":0,"unread":unread,"waiting":waiting,"block":false});
                out.as_object_mut()
                    .ok_or_else(RpcError::internal)?
                    .extend(extra);
                return Ok(out);
            }
            let forced = (awaiting > 0 || (flag(params, "hold_unread") && unread > 0))
                && integer(&me, "stop_blocks").unwrap_or(0) < self.cap("stopBlocks", 3);
            let asked = "FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND d.expires_at > ? AND d.nudged_at IS NULL AND m.kind = 'request' AND COALESCE(m.require_reply, 0) <> 1 AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.from_ep = d.endpoint AND r.kind = 'reply')";
            let total = self
                .count(
                    &format!("SELECT COUNT(*) AS n {asked}"),
                    &[id(), SqlValue::Int(now)],
                )
                .await?;
            let mut nudge = Vec::new();
            for row in self.store.all(&format!("SELECT d.seq AS seq, m.id AS id, m.from_ep AS from_ep, d.acked_at AS acked_at {asked} ORDER BY d.seq LIMIT ?"), &[id(), SqlValue::Int(now), SqlValue::Int(self.cap("injectMessages", 5))]).await? {
                nudge.push(json!({"seq":integer(&row,"seq"),"from":self.address_of(text(&row,"from_ep").unwrap_or("")).await?,"id":text(&row,"id"),"unread":integer(&row,"acked_at").is_none()}));
            }
            let workers = self.live_workers(&me, now, false).await?;
            let workers = workers.workers.len() as i64 + workers.starting;
            let from_workers = self.worker_unread(&me, now, true).await?;
            let late = if flag(params, "directives")
                && integer(&me, "directive_holds").unwrap_or(0) < self.cap("directiveHolds", 5)
            {
                self.late_directives(&me, now).await?
            } else {
                Vec::new()
            };
            let (shown, envelopes, offered) = self
                .budget(&late, endpoint, self.cap("pushBytes", 20480), None)
                .await?;
            let hold = self.hold_seqs(&offered, now, None).await?;
            self.received(endpoint, &shown, now).await?;
            let mut out = json!({"messages":[],"offered":offered,"hold":hold,"more":0,"unread":unread,"block":forced || !nudge.is_empty() || !late.is_empty(),"forced":forced});
            let object = out.as_object_mut().ok_or_else(RpcError::internal)?;
            if total > nudge.len() as i64 {
                object.insert("nudge_more".into(), json!(total - nudge.len() as i64));
            }
            if !nudge.is_empty() {
                object.insert("nudge".into(), json!(nudge));
            }
            if workers > 0 {
                object.insert("workers".into(), json!(workers));
            }
            if from_workers > 0 {
                object.insert("worker_unread".into(), json!(from_workers));
            }
            if workers + from_workers > 0 {
                object.insert("pushes_left".into(), json!(self.pushes_left(&me)));
                object.insert(
                    "prompts".into(),
                    json!(integer(&me, "prompts").unwrap_or(0)),
                );
                if wakes(&me) {
                    object.insert("wakeable".into(), json!(true));
                }
            }
            if !late.is_empty() {
                object.insert("directives".into(), json!(envelopes));
                object.insert(
                    "directive_seqs".into(),
                    json!(
                        late.iter()
                            .filter_map(|row| integer(row, "seq"))
                            .collect::<Vec<_>>()
                    ),
                );
            }
            object.extend(extra);
            return Ok(out);
        }
        let waiting = self
            .count(
                &format!("SELECT COUNT(*) AS n FROM deliveries d WHERE {fresh}"),
                &[id(), SqlValue::Int(now), SqlValue::Int(now)],
            )
            .await?;
        let rows = self.store.all(&format!("SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE {fresh} ORDER BY d.seq LIMIT ?"), &[id(), SqlValue::Int(now), SqlValue::Int(now), SqlValue::Int(self.cap("inboxPage", 100))]).await?;
        let (shown, envelopes, offered) = self
            .budget(
                &rows,
                endpoint,
                self.cap("injectBytes", 7168),
                (!wake).then_some((&me, now)),
            )
            .await?;
        let hold = self.hold_seqs(&offered, now, None).await?;
        self.received(endpoint, &shown, now).await?;
        let mut out = json!({"messages":envelopes,"offered":offered,"hold":hold,"more":waiting - shown.len() as i64,"unread":unread,"block":false});
        out.as_object_mut()
            .ok_or_else(RpcError::internal)?
            .extend(extra);
        Ok(out)
    }

    /// a channel push's page: the oldest unacked deliveries no hook showed or holds, held under `hold` until confirmed
    pub async fn offer(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let now = now_ms();
        let page = self.cap("inboxPage", 100);
        let limit = params
            .get("limit")
            .and_then(Value::as_f64)
            .unwrap_or(page as f64)
            .floor()
            .clamp(1.0, page as f64) as i64;
        let rows = self.store.all("SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ? AND d.injected_at IS NULL AND (d.offered_until IS NULL OR d.offered_until <= ?) ORDER BY d.seq LIMIT ?", &[sv(endpoint), SqlValue::Int(now), SqlValue::Int(now), SqlValue::Int(limit)]).await?;
        let seqs: Vec<i64> = rows.iter().filter_map(|row| integer(row, "seq")).collect();
        let hold = self.hold_seqs(&seqs, now, None).await?;
        self.received(endpoint, &rows, now).await?;
        let mut messages = Vec::new();
        for row in &rows {
            messages.push(self.message_envelope(row, endpoint).await?);
        }
        let after = params
            .get("after")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .floor()
            .max(0.0) as i64;
        Ok(json!({"messages":messages,"hold":hold,"next":seqs.last().copied().unwrap_or(after)}))
    }

    /// a hook or channel showed deliveries offered under `hold`; those `read` and delivered to `endpoint` are acked
    pub async fn injected(
        &mut self,
        endpoint: &str,
        seqs: Option<&Value>,
        hold: Option<&Value>,
        read: Option<&Value>,
        deferred: bool,
    ) -> Result<i64, RpcError> {
        let page = self.cap("inboxPage", 100);
        let list = seq_list(seqs, page)?;
        let Some(hold) = hold.and_then(Value::as_str) else {
            return Ok(0);
        };
        let read: HashSet<i64> = match read {
            Some(read) => seq_list(Some(read), page)?.into_iter().collect(),
            None => HashSet::new(),
        };
        let now = now_ms();
        let (mut marked, mut acked) = (0, 0);
        for seq in list {
            let hit = self.store.all("UPDATE deliveries SET injected_at = ? WHERE seq = ? AND offered_hold = ? AND injected_at IS NULL RETURNING seq", &[SqlValue::Int(now), SqlValue::Int(seq), sv(hold)]).await?.len() as i64;
            marked += hit;
            if hit > 0 && read.contains(&seq) {
                let at = if deferred {
                    SqlValue::Int(now)
                } else {
                    SqlValue::Null
                };
                let mark = if deferred {
                    SqlValue::Int(1)
                } else {
                    SqlValue::Null
                };
                acked += self.store.all("UPDATE deliveries SET acked_at = ?, deferred_at = ?, deferred_ack = ? WHERE seq = ? AND endpoint = ? AND acked_at IS NULL RETURNING seq", &[SqlValue::Int(now), at, mark, SqlValue::Int(seq), sv(endpoint)]).await?.len();
            }
        }
        if acked > 0 {
            self.audit(
                "ack",
                Some(endpoint),
                None,
                json!({"count":acked,"via":"inject"}),
            )
            .await?;
        }
        Ok(marked)
    }

    pub async fn injected_rpc(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let (endpoint, hook) = self.hook_of(conn)?;
        let injected = self
            .injected(
                &endpoint,
                params.get("seqs"),
                params.get("hold"),
                params.get("read"),
                flag(params, "deferred"),
            )
            .await?;
        let mut out = Map::new();
        out.insert("injected".into(), json!(injected));
        if flag(params, "stop") {
            out.insert(
                "held".into(),
                json!(self.stop_held(&endpoint, &hook).await?),
            );
        }
        if flag(params, "push") {
            let pushed = self.pushed(&endpoint, params.get("read"), &hook).await?;
            out.insert("pushed".into(), json!(pushed));
        }
        if params.contains_key("nudged") {
            let nudged = self.nudged(&endpoint, params.get("nudged"), &hook).await?;
            out.insert("nudged".into(), json!(nudged));
        }
        if params.contains_key("restated") {
            let restated = self
                .restated(&endpoint, params.get("restated"), params.get("read"), &hook)
                .await?;
            out.insert("restated".into(), json!(restated));
        }
        if flag(params, "preamble") {
            out.insert(
                "briefed".into(),
                json!(self.mark_session(&endpoint, "briefed", &hook).await?),
            );
        }
        if flag(params, "intro") {
            out.insert(
                "introduced".into(),
                json!(self.mark_session(&endpoint, "introduced", &hook).await?),
            );
        }
        Ok(Value::Object(out))
    }

    /// a hook printed a stop's nudges: those deliveries are never nudged about again
    async fn nudged(
        &self,
        endpoint: &str,
        seqs: Option<&Value>,
        hook: &HookOf,
    ) -> Result<i64, RpcError> {
        let list = seq_list(seqs, self.cap("inboxPage", 100))?;
        if !self
            .holds(&self.must_endpoint(endpoint).await?, hook)
            .await?
        {
            return Ok(0);
        }
        let now = now_ms();
        let mut marked = 0;
        for seq in list {
            marked += self.store.all("UPDATE deliveries SET nudged_at = ? WHERE seq = ? AND endpoint = ? AND nudged_at IS NULL RETURNING seq", &[SqlValue::Int(now), SqlValue::Int(seq), sv(endpoint)]).await?.len() as i64;
        }
        Ok(marked)
    }

    /// a hook printed a held stop: it counts toward the session's stopBlocks
    async fn stop_held(&self, endpoint: &str, hook: &HookOf) -> Result<bool, RpcError> {
        if !self
            .holds(&self.must_endpoint(endpoint).await?, hook)
            .await?
        {
            return Ok(false);
        }
        Ok(!self.store.all("UPDATE endpoints SET stop_blocks = COALESCE(stop_blocks, 0) + 1 WHERE id = ? AND COALESCE(stop_blocks, 0) < ? RETURNING id", &[sv(endpoint), SqlValue::Int(self.cap("stopBlocks", 3))]).await?.is_empty())
    }

    /// a hook printed a stop restating late parent directives: none is restated again, those `read` are acked
    async fn restated(
        &self,
        endpoint: &str,
        seqs: Option<&Value>,
        read: Option<&Value>,
        hook: &HookOf,
    ) -> Result<i64, RpcError> {
        let page = self.cap("inboxPage", 100);
        let list = seq_list(seqs, page)?;
        if !self
            .holds(&self.must_endpoint(endpoint).await?, hook)
            .await?
        {
            return Ok(0);
        }
        let acks: HashSet<i64> = match read {
            Some(read) => seq_list(Some(read), page)?.into_iter().collect(),
            None => HashSet::new(),
        };
        let now = now_ms();
        let (mut marked, mut acked) = (0, 0);
        for seq in list {
            let hit = self.store.all("UPDATE deliveries SET restated_at = ? WHERE seq = ? AND endpoint = ? AND restated_at IS NULL RETURNING seq", &[SqlValue::Int(now), SqlValue::Int(seq), sv(endpoint)]).await?.len() as i64;
            marked += hit;
            if hit > 0 && acks.contains(&seq) {
                acked += self.store.all("UPDATE deliveries SET acked_at = ? WHERE seq = ? AND acked_at IS NULL RETURNING seq", &[SqlValue::Int(now), SqlValue::Int(seq)]).await?.len();
            }
        }
        if acked > 0 {
            self.audit(
                "ack",
                Some(endpoint),
                None,
                json!({"count":acked,"via":"inject"}),
            )
            .await?;
        }
        if marked > 0 {
            self.store.all("UPDATE endpoints SET directive_holds = COALESCE(directive_holds, 0) + 1 WHERE id = ?", &[sv(endpoint)]).await?;
        }
        Ok(marked)
    }

    /// a hook printed the preamble or the intro: later hooks of the session skip it
    async fn mark_session(
        &self,
        endpoint: &str,
        column: &str,
        hook: &HookOf,
    ) -> Result<bool, RpcError> {
        if !self
            .holds(&self.must_endpoint(endpoint).await?, hook)
            .await?
        {
            return Ok(false);
        }
        let column = if column == "briefed" {
            "briefed"
        } else {
            "introduced"
        };
        self.store
            .all(
                &format!("UPDATE endpoints SET {column} = 1 WHERE id = ?"),
                &[sv(endpoint)],
            )
            .await?;
        Ok(true)
    }

    /// background showings older than deferredSettleMs reached the agent: inbox no longer lists them
    pub(crate) async fn settle(&self, endpoint: &str) -> Result<(), RpcError> {
        self.store.all("UPDATE deliveries SET deferred_at = NULL WHERE endpoint = ? AND deferred_at IS NOT NULL AND deferred_at <= ?", &[sv(endpoint), SqlValue::Int(now_ms() - self.cap("deferredSettleMs", 2000))]).await?;
        Ok(())
    }

    /// a turn runs, so its hooks deliver: a broker wake clears until its stop sets it again
    pub(crate) async fn turn_runs(&self, endpoint: &str) -> Result<(), RpcError> {
        self.store.all("UPDATE endpoints SET wake = NULL WHERE id = ? AND hibernate IS NULL AND COALESCE(wake IN ('codex-queue'), 0)", &[sv(endpoint)]).await?;
        Ok(())
    }

    /// a hook's activity: cleaned, capped, redacted; session_start and session_end move hook presence for the holding process
    pub async fn event(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let kinds = ["session_start", "tool", "stop", "note", "session_end"];
        let kind = params
            .get("kind")
            .and_then(Value::as_str)
            .filter(|v| kinds.contains(v))
            .ok_or_else(|| {
                RpcError::invalid_params(format!("kind must be one of {}", kinds.join(", ")))
            })?;
        let (endpoint, hook) = self.hook_of(conn)?;
        let id = endpoint.as_str();
        let tool = clean_text(params.get("tool"), "tool", 64)?;
        let summary = clean_text(params.get("summary"), "summary", 4096)?;
        let agent = clean_text(params.get("agent"), "agent", 64)?;
        let now = now_ms();
        let opt = |v: Option<String>| v.map_or(SqlValue::Null, SqlValue::Text);
        let stored_summary = summary.as_deref().map(|v| {
            utf16_cut(
                &redact_secrets(v),
                self.cap("activitySummaryChars", 200) as usize,
            )
        });
        let row = self.store.all("INSERT INTO activity (at, endpoint, kind, tool, summary, agent) VALUES (?, ?, ?, ?, ?, ?) RETURNING id", &[SqlValue::Int(now), sv(id), sv(kind), opt(tool.as_deref().map(redact_secrets)), opt(stored_summary.clone()), opt(agent.as_deref().map(redact_secrets))]).await?;
        let activity = row
            .first()
            .and_then(|row| integer(row, "id"))
            .ok_or_else(RpcError::internal)?;
        self.store
            .all(
                "DELETE FROM activity WHERE id <= ?",
                &[SqlValue::Int(activity - self.cap("activityKeep", 5000))],
            )
            .await?;
        let me = self.must_endpoint(id).await?;
        let own = self.holds(&me, &hook).await?;
        if own && agent.is_none() && kind == "tool" {
            self.settle(id).await?;
            self.turn_runs(id).await?;
        }
        if own
            && agent.is_none()
            && let Some(session) = params
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|v| crate::claims::harness_session(v))
        {
            let transcript = params
                .get("transcript_path")
                .and_then(Value::as_str)
                .filter(|v| v.starts_with('/'));
            self.store
                .all(
                    "UPDATE endpoints SET harness_session = ?, harness_transcript = ? WHERE id = ?",
                    &[sv(session), opt(transcript.map(str::to_owned)), sv(id)],
                )
                .await?;
        }
        if kind == "session_end" {
            if own {
                self.store.all("UPDATE endpoints SET hook_seen = NULL, hook_ended = ?, session = CASE WHEN connections = 0 THEN NULL ELSE session END, wake = CASE WHEN wakers = 0 AND NOT COALESCE(wake IN ('codex-queue'), 0) THEN NULL ELSE wake END WHERE id = ?", &[SqlValue::Int(now), sv(id)]).await?;
            }
        } else if kind == "session_start" {
            if own {
                self.turn_runs(id).await?;
            }
            let fresh = own && !matches!(summary.as_deref(), Some("compact" | "resume"));
            let own = SqlValue::Int(i64::from(own));
            let fresh = SqlValue::Int(i64::from(fresh));
            self.store.all("UPDATE endpoints SET hook_seen = COALESCE(?, hook_seen), hook_ended = NULL, stop_blocks = CASE WHEN ? THEN 0 ELSE stop_blocks END, pushes = CASE WHEN ? THEN 0 ELSE pushes END, briefed = CASE WHEN ? THEN NULL ELSE briefed END, introduced = CASE WHEN ? THEN NULL ELSE introduced END, directive_holds = CASE WHEN ? THEN NULL ELSE directive_holds END, title = CASE WHEN ? AND title = title_auto THEN NULL ELSE title END, title_auto = CASE WHEN ? THEN NULL ELSE title_auto END WHERE id = ?", &[
                if hook.transient { SqlValue::Int(now) } else { SqlValue::Null },
                own.clone(), own.clone(), own.clone(), own.clone(), own, fresh.clone(), fresh, sv(id),
            ]).await?;
        } else if hook.transient {
            self.store.all("UPDATE endpoints SET hook_seen = ? WHERE id = ? AND (hook_ended IS NULL OR hook_ended < ?)", &[SqlValue::Int(now), sv(id), SqlValue::Int(now - self.cap("hookEndedGraceS", 30) * 1000)]).await?;
        }
        self.touch(id).await?;
        let result = json!({"id":activity,"at":crate::core::timestamp(now),"endpoint":crate::views::address(&me),"kind":kind,"tool":tool.as_deref().map(redact_secrets),"summary":stored_summary,"agent":agent.as_deref().map(redact_secrets)});
        let mut event = json!({"type":"activity"});
        if let (Some(event), Some(row)) = (event.as_object_mut(), result.as_object()) {
            event.extend(row.clone());
        }
        self.notify_watchers(event).await;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_tags_are_escaped_in_bodies() {
        assert_eq!(
            escape_body("a < relay and </relay-message> <relayx <System_Reminder>"),
            "a < relay and &lt;/relay-message> <relayx &lt;System_Reminder>"
        );
    }

    #[test]
    fn wrapped_message_names_sender_and_expectation() {
        let envelope = json!({"id":"msg_abcdef123456","thread":"thr_1","kind":"request","require_reply":true,"seq":7,"data_class":"public","attachments":[],"relation":"child","from":{"address":"me/w1","auth":"local-uid","claims":{"harness":"codex"}},"body":{"text":"done & \"ok\""}});
        let wrapped = wrap_message(&envelope);
        assert!(wrapped.starts_with("<relay-message from=\"me/w1\" relation=\"child\" harness=\"codex\" auth=\"local-uid\" kind=\"request\" class=\"public\" id=\"msg_abcdef123456\" short=\"123456\" thread=\"thr_1\" seq=\"7\">\ndone & \"ok\"\n</relay-message>\n"));
        assert!(wrapped.ends_with(
            "[from your worker me/w1: reply required: the sender waits for your relay_reply]"
        ));
    }

    #[test]
    fn seq_lists_are_integers_within_a_page() {
        assert_eq!(seq_list(Some(&json!([1, 2.0])), 100).ok(), Some(vec![1, 2]));
        assert!(seq_list(Some(&json!([1.5])), 100).is_err());
        assert!(seq_list(None, 100).is_err());
        assert!(seq_list(Some(&json!([1, 2, 3])), 2).is_err());
    }
}
