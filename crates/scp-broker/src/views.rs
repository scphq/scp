use serde_json::{Map, Value, json};

use crate::claims::valid_handle;
use crate::core::{Core, integer, now_ms, text, timestamp};
use crate::proto::{ErrorCode, RpcError};
use crate::store::{Row, SqlValue};

pub fn address(row: &Row) -> String {
    match text(row, "kind") {
        Some("human") => "me/".into(),
        Some("system") => "me/relay".into(),
        _ => format!("me/{}", text(row, "handle").unwrap_or("")),
    }
}

pub fn presence(row: &Row, now: i64) -> &'static str {
    if text(row, "hibernate").is_some() {
        return "hibernated";
    }
    if integer(row, "connections").unwrap_or(0) > 0 {
        return if integer(row, "last_seen").unwrap_or(0) >= now - 60_000 {
            "online"
        } else {
            "idle"
        };
    }
    match integer(row, "hook_seen").unwrap_or(0) {
        seen if seen >= now - 300_000 => "online",
        seen if seen >= now - 1_800_000 => "idle",
        _ if text(row, "wake").is_some_and(|v| v != "none")
            && (integer(row, "wakers").unwrap_or(0) > 0
                || integer(row, "waker_left").unwrap_or(0) >= now - 60_000) =>
        {
            "idle"
        }
        _ => "offline",
    }
}

impl Core {
    pub async fn by_id(&self, id: &str) -> Result<Option<Row>, RpcError> {
        Ok(self
            .store
            .all(
                "SELECT * FROM endpoints WHERE id = ?",
                &[SqlValue::Text(id.into())],
            )
            .await?
            .into_iter()
            .next())
    }
    pub async fn by_handle(&self, handle: &str) -> Result<Option<Row>, RpcError> {
        Ok(self
            .store
            .all(
                "SELECT * FROM endpoints WHERE handle = ?",
                &[SqlValue::Text(handle.into())],
            )
            .await?
            .into_iter()
            .next())
    }
    pub async fn must_endpoint(&self, id: &str) -> Result<Row, RpcError> {
        self.by_id(id).await?.ok_or_else(|| {
            RpcError::new(ErrorCode::Unauthorized, "this connection has no endpoint")
        })
    }
    pub async fn lookup(&self, value: &str) -> Result<Row, RpcError> {
        let value = value.trim();
        if value.is_empty() {
            return Err(RpcError::invalid_params(
                "an address is user/handle, or a handle",
            ));
        }
        let handle = if let Some((user, handle)) = value.split_once('/') {
            if !matches!(user, "me" | "local") {
                return Err(not_found(value));
            }
            if handle.is_empty() { "_human" } else { handle }
        } else {
            value
        };
        if handle != "_human" && !valid_handle(handle) {
            return Err(not_found(value));
        }
        self.by_handle(handle)
            .await?
            .ok_or_else(|| not_found(value))
    }
    pub async fn address_of(&self, id: &str) -> Result<String, RpcError> {
        Ok(self
            .by_id(id)
            .await?
            .as_ref()
            .map(address)
            .unwrap_or_else(|| id.into()))
    }
    pub async fn view(&self, row: &Row) -> Result<Value, RpcError> {
        let mut view = self.endpoint_view(row)?;
        if let Some(parent) = text(row, "parent_ep") {
            view["parent"] = self
                .by_id(parent)
                .await?
                .as_ref()
                .map(address)
                .map_or(Value::Null, Value::String);
        }
        Ok(view)
    }
    pub async fn ancestors(&self, row: &Row) -> Result<Vec<String>, RpcError> {
        let mut out = Vec::new();
        let mut next = text(row, "parent_ep").map(str::to_owned);
        while let Some(id) = next {
            if out.contains(&id) || out.len() >= 64 {
                break;
            }
            out.push(id.clone());
            next = self
                .by_id(&id)
                .await?
                .and_then(|r| text(&r, "parent_ep").map(str::to_owned));
        }
        Ok(out)
    }
    pub async fn list_endpoints(&mut self, params: &Map<String, Value>) -> Result<Value, RpcError> {
        self.end_exited().await?;
        let rows = self.store.all("SELECT * FROM endpoints WHERE kind != 'system' AND substr(handle,1,5) != 'gone:' ORDER BY created_at, id", &[]).await?;
        let mut endpoints = Vec::new();
        for row in rows {
            if ["harness", "kind"].iter().any(|k| {
                params
                    .get(*k)
                    .and_then(Value::as_str)
                    .is_some_and(|v| text(&row, k) != Some(v))
            }) {
                continue;
            }
            let active = [
                "created_at",
                "last_seen",
                "hook_seen",
                "last_received_at",
                "mail_at",
            ]
            .iter()
            .filter_map(|k| integer(&row, k))
            .max()
            .unwrap_or(0);
            if params.get("all") != Some(&Value::Bool(true)) && text(&row, "kind") == Some("agent")
            {
                if active < now_ms() - 86_400_000 {
                    continue;
                }
                if params.get("historic") != Some(&Value::Bool(true))
                    && self
                        .limits
                        .get("historicAfterS")
                        .is_some_and(|s| now_ms() - active >= s as i64 * 1000)
                {
                    continue;
                }
            }
            if params
                .get("presence")
                .and_then(Value::as_str)
                .is_some_and(|v| v != presence(&row, now_ms()))
            {
                continue;
            }
            endpoints.push(self.view(&row).await?);
        }
        Ok(json!({"endpoints":endpoints}))
    }
    pub async fn audit(
        &self,
        event: &str,
        endpoint: Option<&str>,
        reference: Option<&str>,
        detail: Value,
    ) -> Result<(), RpcError> {
        self.store
            .all(
                "INSERT INTO audit (at,event,endpoint,ref,detail) VALUES (?,?,?,?,?)",
                &[
                    SqlValue::Int(now_ms()),
                    SqlValue::Text(event.into()),
                    opt(endpoint),
                    opt(reference),
                    SqlValue::Text(detail.to_string()),
                ],
            )
            .await?;
        Ok(())
    }
    pub async fn touch(&self, id: &str) -> Result<(), RpcError> {
        self.store
            .all(
                "UPDATE endpoints SET last_seen = ? WHERE id = ?",
                &[SqlValue::Int(now_ms()), opt(Some(id))],
            )
            .await?;
        Ok(())
    }
    pub async fn audit_log(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
        let mut sql = "SELECT * FROM audit WHERE id > ?".to_owned();
        for (key, clause) in [
            ("scope", " AND substr(event,1,6) = 'scope_'"),
            ("judge", " AND substr(event,1,6) = 'judge_'"),
            ("peek", " AND event IN ('peek','peek_set')"),
        ] {
            if params.get(key) == Some(&Value::Bool(true)) {
                sql.push_str(clause);
            }
        }
        sql.push_str(if params.contains_key("since") {
            " ORDER BY id ASC LIMIT ?"
        } else {
            " ORDER BY id DESC LIMIT ?"
        });
        let mut rows = self
            .store
            .all(
                &sql,
                &[
                    SqlValue::Int(
                        params
                            .get("since")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                            .max(0),
                    ),
                    SqlValue::Int(
                        params
                            .get("limit")
                            .and_then(Value::as_i64)
                            .unwrap_or(200)
                            .clamp(1, 1000),
                    ),
                ],
            )
            .await?;
        if !params.contains_key("since") {
            rows.reverse();
        }
        let mut values = Vec::new();
        for row in rows {
            values.push(json!({"id":integer(&row,"id"),"at":integer(&row,"at").and_then(timestamp),"event":text(&row,"event"),"endpoint":match text(&row,"endpoint") {Some(id)=>Some(self.address_of(id).await?),None=>None},"ref":text(&row,"ref"),"detail":text(&row,"detail").and_then(|v|serde_json::from_str::<Value>(v).ok()).unwrap_or(json!({}))}));
        }
        Ok(json!({"rows":values}))
    }
}

pub fn opt(value: Option<&str>) -> SqlValue {
    value.map_or(SqlValue::Null, |v| SqlValue::Text(v.into()))
}
pub fn not_found(value: &str) -> RpcError {
    RpcError::new(ErrorCode::NotFound, format!("no endpoint {value}"))
}
