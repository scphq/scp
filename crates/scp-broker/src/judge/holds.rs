use serde_json::{Map, Value, json};

use crate::core::{Core, integer, now_ms, text, timestamp};
use crate::proto::RpcError;
use crate::scrub::strip_control;
use crate::state::ConnectionId;
use crate::store::{Row, SqlValue};
use crate::views::address;
use scp_core::protocol::ErrorCode;

use super::runtime::hash;
use super::verdict::apply_redactions;
use super::{new_id, no_hold, required, stored, stored_detail, string, verdict};

impl Core {
    pub async fn review_hold(
        &mut self,
        conn: ConnectionId,
        method: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        if !self.at_terminal(conn) {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "only the human at a terminal reviews held messages",
            ));
        }
        match method {
            "holds" => {
                if params.get("state").is_some_and(|s| !s.is_string()) {
                    return Err(RpcError::invalid_params("state must be a string"));
                }
                let rows = if let Some(state) = params.get("state").and_then(Value::as_str) {
                    self.store.all("SELECT * FROM judge_holds WHERE state = ? ORDER BY created_at DESC,rowid DESC LIMIT 200",&[string(state)]).await?
                } else {
                    self.store.all("SELECT * FROM judge_holds ORDER BY created_at DESC,rowid DESC LIMIT 200",&[]).await?
                };
                let mut holds = Vec::new();
                for row in rows {
                    holds.push(self.hold_view(&row).await?);
                }
                Ok(json!({"holds":holds}))
            }
            "hold_show" => {
                let row = self.hold_row(required(params, "id")?).await?;
                let mut view = self.hold_view(&row).await?;
                let p = stored(&row, "params")?;
                if let Some(body) = p.get("body") {
                    view["body"] = body.clone();
                }
                view["redactions"] = stored(&row, "verdict")?["redactions"].clone();
                Ok(view)
            }
            "hold_release" => {
                let id = required(params, "id")?;
                self.load_policy().await?;
                if let Some(error) = &self.policy_error {
                    return Err(RpcError::new(ErrorCode::PolicyRefused, error));
                }
                self.release_hold(conn, id, params.get("redacted") == Some(&Value::Bool(true)))
                    .await
            }
            "hold_refuse" => {
                let reason = required(params, "reason")?;
                if reason.chars().count() > self.limits.get("noteChars").unwrap_or(512) as usize {
                    return Err(RpcError::invalid_params(
                        "reason takes at most 512 characters",
                    ));
                }
                self.judge_sweep().await?;
                let id = required(params, "id")?;
                let row = self.hold_row(id).await?;
                if text(&row, "state") != Some("held") {
                    return Err(no_hold(id));
                }
                let from = text(&row, "from_ep").ok_or_else(RpcError::internal)?;
                let by = self
                    .address_of(self.connection(conn)?.endpoint.as_deref().unwrap_or(""))
                    .await?;
                let reason = strip_control(reason);
                let mut detail = stored_detail(&row)?;
                detail["by"] = json!(by);
                detail["action"] = json!("refuse");
                detail["reason"] = json!(reason);
                self.resolve_hold(&row, "refused", Some(&by)).await?;
                self.audit("judge_override", Some(from), Some(id), detail)
                    .await?;
                self.judge_notice(from,&format!("relay: your message held for review as {id} was refused by your human: {reason}")).await?;
                self.hold_view(&self.hold_row(id).await?).await
            }
            _ => Err(RpcError::internal()),
        }
    }

    async fn release_hold(
        &mut self,
        conn: ConnectionId,
        id: &str,
        redacted: bool,
    ) -> Result<Value, RpcError> {
        let rows=self.store.all("UPDATE judge_holds SET state = 'releasing' WHERE id = ? AND state = 'held' AND expires_at > ? RETURNING *",&[string(id),SqlValue::Int(now_ms())]).await?;
        let row = rows.first().ok_or_else(|| no_hold(id))?;
        let from = text(row, "from_ep").ok_or_else(RpcError::internal)?;
        let params = stored(row, "params")?;
        let original = params.as_object().ok_or_else(RpcError::internal)?;
        let verdict = stored(row, "verdict")?;
        let mut sent = original.clone();
        let mut redactions = None;
        if redacted {
            let spans =
                serde_json::from_value::<Vec<verdict::Redaction>>(verdict["redactions"].clone())
                    .map_err(|_| RpcError::internal())?;
            let applied = apply_redactions(params["body"].as_str().unwrap_or(""), &spans);
            if applied.n == 0 {
                self.store
                    .all(
                        "UPDATE judge_holds SET state = 'held' WHERE id = ?",
                        &[string(id)],
                    )
                    .await?;
                return Err(RpcError::invalid_params(format!(
                    "hold {id} has no redactions: release it as it is or refuse it"
                )));
            }
            sent.insert("body".into(), json!(applied.text));
            redactions = Some(json!({"n":applied.n,"kinds":applied.kinds}));
        }
        let origin = stored(row, "origin")?;
        let delivery = self
            .send_message(
                from,
                &sent,
                crate::messages::Origin {
                    tty: origin["tty"].as_bool(),
                    unverified: origin["unverified"] == true,
                    link: origin["link"].as_str().map(|_| "session"),
                },
            )
            .await;
        let mut result = match delivery {
            Ok(result) => result,
            Err(error) => {
                self.store
                    .all(
                        "UPDATE judge_holds SET state = 'held' WHERE id = ?",
                        &[string(id)],
                    )
                    .await?;
                return Err(error);
            }
        };
        if let Some(redactions) = &redactions {
            result["redacted"] = redactions.clone();
        }
        self.judge_remember(from, original, &result).await?;
        let by = self
            .address_of(self.connection(conn)?.endpoint.as_deref().unwrap_or(""))
            .await?;
        let mut detail = stored_detail(row)?;
        detail["by"] = json!(by);
        detail["action"] = json!(if redactions.is_some() {
            "release_redacted"
        } else {
            "release"
        });
        if let Some(redactions) = redactions {
            detail["redacted"] = redactions;
        }
        self.resolve_hold(row, "released", Some(&by)).await?;
        self.audit("judge_override", Some(from), Some(id), detail)
            .await?;
        self.judge_notice(from,&format!("relay: your message held for review as {id} was released by your human{} and delivered as {}",if redacted {" with redactions"} else {""},result["id"].as_str().unwrap_or(""))).await?;
        Ok(result)
    }

    async fn hold_row(&self, id: &str) -> Result<Row, RpcError> {
        self.store
            .all("SELECT * FROM judge_holds WHERE id = ?", &[string(id)])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| no_hold(id))
    }

    async fn hold_view(&self, row: &Row) -> Result<Value, RpcError> {
        let params = stored(row, "params")?;
        let verdict = stored(row, "verdict")?;
        Ok(
            json!({"id":text(row,"id"),"from":self.address_of(text(row,"from_ep").unwrap_or("")).await?,"to":verdict["to"],"state":text(row,"state"),"created_at":integer(row,"created_at").and_then(timestamp),"expires_at":integer(row,"expires_at").and_then(timestamp),"categories":verdict["categories"],"reason":verdict["reason"],"boundary":verdict["boundary"],"source":verdict["source"],"bytes":params["bytes"].as_u64().unwrap_or_else(||params["body"].as_str().unwrap_or("").len() as u64),"by":text(row,"by"),"resolved_at":integer(row,"resolved_at").and_then(timestamp)}),
        )
    }

    async fn resolve_hold(&self, row: &Row, state: &str, by: Option<&str>) -> Result<(), RpcError> {
        let mut params = stored(row, "params")?;
        let body = params
            .as_object_mut()
            .ok_or_else(RpcError::internal)?
            .remove("body")
            .unwrap_or(Value::Null);
        let body = body.as_str().unwrap_or("");
        params["bytes"] = json!(body.len());
        params["sha256"] = json!(hash(body));
        let mut verdict = stored(row, "verdict")?;
        verdict["redactions"] = json!(
            verdict["redactions"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|r| json!({"kind":r["kind"]}))
                .collect::<Vec<_>>()
        );
        self.store.all("UPDATE judge_holds SET state = ?,by = ?,resolved_at = ?,params = ?,verdict = ? WHERE id = ?",&[string(state),by.map_or(SqlValue::Null,string),SqlValue::Int(now_ms()),string(params.to_string()),string(verdict.to_string()),string(text(row,"id").unwrap_or(""))]).await?;
        Ok(())
    }

    pub async fn judge_sweep(&mut self) -> Result<(), RpcError> {
        let now = now_ms();
        for row in self
            .store
            .all(
                "SELECT * FROM judge_holds WHERE state = 'held' AND expires_at <= ?",
                &[SqlValue::Int(now)],
            )
            .await?
        {
            let from = text(&row, "from_ep").ok_or_else(RpcError::internal)?;
            let id = text(&row, "id").ok_or_else(RpcError::internal)?;
            let detail = stored_detail(&row)?;
            self.resolve_hold(&row, "expired", None).await?;
            self.audit("judge_expire", Some(from), Some(id), detail)
                .await?;
            self.judge_notice(from,&format!("relay: your message held for review as {id} expired without review and was not delivered")).await?;
        }
        self.store.all("DELETE FROM judge_holds WHERE state IN ('released','refused','expired') AND resolved_at <= ?",&[SqlValue::Int(now-self.limits.get("auditKeepS").unwrap_or(2_592_000) as i64*1000)]).await?;
        self.store
            .all(
                "DELETE FROM judge_sent WHERE created_at <= ?",
                &[SqlValue::Int(
                    now - self.limits.get("idempotencyS").unwrap_or(86400) as i64 * 1000,
                )],
            )
            .await?;
        self.judge.sweep(now);
        Ok(())
    }

    async fn judge_notice(&mut self, endpoint: &str, body: &str) -> Result<(), RpcError> {
        let Some(target) = self.by_id(endpoint).await? else {
            return Ok(());
        };
        let relay = self
            .by_handle("_relay")
            .await?
            .ok_or_else(RpcError::internal)?;
        let now = now_ms();
        let expires = now + self.limits.get("ttlDefaultS").unwrap_or(604800) as i64 * 1000;
        let id = new_id("msg");
        crate::store::transaction(self.store.clone(),async {
            self.store.all("INSERT INTO messages (id,thread,kind,from_ep,to_addr,body,mime,data_class,attachments,hop,created_at,expires_at) VALUES (?,?,'status',?,?,?,'text/plain','public','[]',0,?,?)",&[string(&id),string(new_id("thr")),string(text(&relay,"id").unwrap_or("")),string(address(&target)),string(body),SqlValue::Int(now),SqlValue::Int(expires)]).await?;
            self.store.all("INSERT INTO deliveries (message_id,endpoint,expires_at) VALUES (?,?,?)",&[string(&id),string(endpoint),SqlValue::Int(expires)]).await?;
            self.store.all("UPDATE endpoints SET mail_at = ? WHERE id = ?",&[SqlValue::Int(now),string(endpoint)]).await?;
            Ok::<_,RpcError>(())
        }).await?;
        self.state.wake(endpoint);
        Ok(())
    }
}
