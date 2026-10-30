use scp_core::protocol::ErrorCode;
use serde_json::{Map, Value, json};

use crate::core::{Core, integer, now_ms, text};
use crate::proto::RpcError;
use crate::scrub::{find_secret, redact_secrets, strip_control};
use crate::state::Mode;
use crate::store::SqlValue;

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
        self.view(&self.must_endpoint(endpoint).await?).await
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

    pub async fn title_infer(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
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

    pub async fn prompted(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        self.must_endpoint(endpoint).await?;
        self.store
            .all(
                "UPDATE endpoints SET prompts = COALESCE(prompts, 0) + 1, pushes = 0 WHERE id = ?",
                &[SqlValue::Text(endpoint.into())],
            )
            .await?;
        self.store.all("UPDATE endpoints SET wake = NULL WHERE id = ? AND hibernate IS NULL AND wake = 'codex-queue'", &[SqlValue::Text(endpoint.into())]).await?;
        self.store.all("UPDATE deliveries SET deferred_at = NULL WHERE endpoint = ? AND deferred_at IS NOT NULL AND deferred_at <= ?", &[SqlValue::Text(endpoint.into()), SqlValue::Int(now_ms() - self.limits.get("deferredSettleMs").unwrap_or(2000) as i64)]).await?;
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
