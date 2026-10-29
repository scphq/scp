use crate::core::{Core, text};
use crate::proto::{ErrorCode, RpcError};
use crate::state::{Connection, ConnectionId, Mode};
use crate::store::Row;
use crate::views::address;
use serde_json::{Value, json};

impl Core {
    pub fn connection(&self, conn: ConnectionId) -> Result<Connection, RpcError> {
        self.state
            .connections
            .get(&conn)
            .cloned()
            .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "connection is closed"))
    }
    pub async fn actor_row(&self, conn: ConnectionId) -> Result<Row, RpcError> {
        let c = self.connection(conn)?;
        self.must_endpoint(c.endpoint.as_deref().ok_or_else(|| {
            RpcError::new(ErrorCode::Unauthorized, "this connection has no endpoint")
        })?)
        .await
    }
    pub fn at_terminal(&self, conn: ConnectionId) -> bool {
        self.state
            .connections
            .get(&conn)
            .is_some_and(|c| matches!(c.mode, Mode::Human { tty: true }))
    }
    pub async fn need_terminal(&self, conn: ConnectionId) -> Result<(), RpcError> {
        if matches!(self.connection(conn)?.mode, Mode::Human { tty: false }) {
            return Err(self
                .scope_refused(
                    conn,
                    json!({"target":null,"reason":"no terminal"}),
                    "only the human at a terminal sets caps, grants, groups and admins",
                )
                .await?);
        }
        Ok(())
    }
    pub async fn scope_refused(
        &self,
        conn: ConnectionId,
        detail: Value,
        message: &str,
    ) -> Result<RpcError, RpcError> {
        let row = self.actor_row(conn).await?;
        let c = self.connection(conn)?;
        let auth = match c.mode {
            Mode::Human { tty: true } => "tty",
            Mode::Human { tty: false } => "no-tty",
            _ if c.lineage.is_some() => {
                if c.own {
                    "self"
                } else {
                    "lineage"
                }
            }
            _ => "session",
        };
        let mut data = json!({"by":address(&row),"auth":auth});
        if let (Some(dst), Some(src)) = (data.as_object_mut(), detail.as_object()) {
            dst.extend(src.clone());
        }
        self.audit("scope_refused", text(&row, "id"), None, data)
            .await?;
        Ok(RpcError::new(ErrorCode::ScopeRefused, message))
    }
    pub async fn authority(&self, actor: &Row, target: &Row) -> Result<bool, RpcError> {
        if text(actor, "kind") == Some("human") {
            return Ok(true);
        }
        let id = text(actor, "id").unwrap_or("");
        Ok(text(actor, "kind") == Some("agent")
            && text(target, "id") != Some(id)
            && self.ancestors(target).await?.iter().any(|v| v == id))
    }
    pub fn default_of(&self, name: &str) -> Option<&str> {
        self.policy.as_ref()?.get("defaults")?.get(name)?.as_str()
    }
}
