use std::collections::HashMap;

use crate::core::{Core, integer, now_ms, text};
use crate::proto::RpcError;
use crate::state::{Connection, ConnectionId, Mode};
use crate::store::{Row, SqlValue};
use crate::views::{address, not_found};
use crate::world::{HUMAN_HANDLE, Tables, World};
use scp_core::protocol::ErrorCode;
use serde_json::{Value, json};

const REFUSAL_DEDUPE_MS: i64 = 60_000;

/// Who a scope call acts as: the human (at a terminal or not), or an endpoint by its session, its own shell or a plain shell's lineage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Actor {
    Human { tty: bool },
    Endpoint { id: String, auth: &'static str },
}

impl Actor {
    pub fn at_terminal(&self) -> bool {
        matches!(self, Actor::Human { tty: true })
    }
    /// A plain shell's lineage and the human without a terminal may only narrow.
    pub fn narrow_only(&self) -> bool {
        match self {
            Actor::Human { tty } => !tty,
            Actor::Endpoint { auth, .. } => *auth == "lineage",
        }
    }
    pub fn auth(&self) -> &'static str {
        match self {
            Actor::Human { tty: true } => "tty",
            Actor::Human { tty: false } => "no-tty",
            Actor::Endpoint { auth, .. } => auth,
        }
    }
}

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
    pub fn actor_of(&self, conn: ConnectionId) -> Result<Actor, RpcError> {
        let c = self.connection(conn)?;
        if let Some(id) = c.lineage {
            return Ok(Actor::Endpoint {
                id,
                auth: if c.own { "self" } else { "lineage" },
            });
        }
        match c.mode {
            Mode::Human { tty } => Ok(Actor::Human { tty }),
            Mode::Observer => Ok(Actor::Human { tty: false }),
            _ => Ok(Actor::Endpoint {
                id: c
                    .endpoint
                    .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "call hello first"))?,
                auth: "session",
            }),
        }
    }
    /// The endpoint whose view a connection gets; None for the human at a terminal, which sees everything.
    pub fn viewer_of(&self, conn: ConnectionId) -> Option<String> {
        let c = self.state.connections.get(&conn)?;
        if c.lineage.is_some() {
            return c.lineage.clone();
        }
        match c.mode {
            Mode::Human { tty: true } => None,
            Mode::Human { .. } | Mode::Observer => Some(
                self.state
                    .addresses
                    .iter()
                    .find(|(_, address)| address.as_str() == "me/")
                    .map_or_else(String::new, |(id, _)| id.clone()),
            ),
            _ => c.endpoint.clone(),
        }
    }
    pub async fn human_id(&self) -> Result<Option<String>, RpcError> {
        Ok(self
            .by_handle(HUMAN_HANDLE)
            .await?
            .and_then(|r| text(&r, "id").map(str::to_owned)))
    }
    pub async fn actor_endpoint(&self, actor: &Actor) -> Result<Row, RpcError> {
        match actor {
            Actor::Human { .. } => self
                .by_handle(HUMAN_HANDLE)
                .await?
                .ok_or_else(RpcError::internal),
            Actor::Endpoint { id, .. } => {
                let row = self.must_endpoint(id).await?;
                if text(&row, "kind") != Some("agent") {
                    return Err(RpcError::new(
                        ErrorCode::Unauthorized,
                        "this connection has no agent endpoint",
                    ));
                }
                Ok(row)
            }
        }
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
    /// The human's powers need a terminal: without one, a claim to be the human is any local process's.
    pub async fn need_tty(
        &self,
        actor: &Actor,
        me: &Row,
        target: Option<String>,
    ) -> Result<(), RpcError> {
        if matches!(actor, Actor::Human { tty: false }) {
            return Err(self
                .refused(
                    actor,
                    me,
                    json!({"target":target,"reason":"no terminal"}),
                    "only the human at a terminal sets caps, grants, groups and admins",
                )
                .await);
        }
        Ok(())
    }
    /// A scope refusal with its audit row.
    pub async fn refused(&self, actor: &Actor, me: &Row, detail: Value, message: &str) -> RpcError {
        let mut data = json!({"by":address(me),"auth":actor.auth()});
        if let (Some(dst), Some(src)) = (data.as_object_mut(), detail.as_object()) {
            dst.extend(src.clone());
        }
        if let Err(error) = self
            .audit("scope_refused", text(me, "id"), None, data)
            .await
        {
            return error;
        }
        RpcError::new(ErrorCode::ScopeRefused, message)
    }
    pub async fn scope_refused(
        &self,
        conn: ConnectionId,
        detail: Value,
        message: &str,
    ) -> Result<RpcError, RpcError> {
        let row = self.actor_row(conn).await?;
        let actor = self.actor_of(conn)?;
        Ok(self.refused(&actor, &row, detail, message).await)
    }
    pub async fn authority(&self, actor: &Row, target: &Row) -> Result<bool, RpcError> {
        let world = self.world().await?;
        Ok(world.authority(
            text(actor, "id").unwrap_or_default(),
            text(target, "id").unwrap_or_default(),
        ))
    }
    pub fn default_of(&self, name: &str) -> Option<&str> {
        self.policy.as_ref()?.get("defaults")?.get(name)?.as_str()
    }

    /// The scope state as one read snapshot.
    pub async fn world(&self) -> Result<World, RpcError> {
        Ok(World::build(Tables {
            endpoints: self.store.all("SELECT * FROM endpoints", &[]).await?,
            groups: self.store.all("SELECT * FROM groups", &[]).await?,
            members: self
                .store
                .all(
                    "SELECT name, endpoint FROM group_members ORDER BY name",
                    &[],
                )
                .await?,
            admins: self
                .store
                .all(
                    "SELECT * FROM admins WHERE revoked_at IS NULL ORDER BY granted_at",
                    &[],
                )
                .await?,
            policy: self.policy.clone(),
            binds: self.policy_binds.clone(),
            local_users: self
                .federation
                .aliases
                .iter()
                .cloned()
                .chain(["me".to_owned(), "local".to_owned()])
                .collect(),
            machine: self.federation.machine.clone(),
        }))
    }

    /// Whether `row` got `message` since its last takeover.
    async fn got(&self, message: &Row, row: &Row) -> Result<bool, RpcError> {
        let created = integer(message, "created_at").unwrap_or(0);
        if integer(row, "reset_at").is_some_and(|reset| created <= reset) {
            return Ok(false);
        }
        Ok(!self
            .store
            .all(
                "SELECT 1 FROM deliveries WHERE message_id = ? AND endpoint = ?",
                &[
                    SqlValue::Text(text(message, "id").unwrap_or_default().into()),
                    SqlValue::Text(text(row, "id").unwrap_or_default().into()),
                ],
            )
            .await?
            .is_empty())
    }

    /// Whether a reply to `reply_to` from `a` answers `b`'s own message.
    pub async fn solicited(
        &self,
        a: &Row,
        b: &Row,
        reply_to: Option<&Row>,
    ) -> Result<bool, RpcError> {
        let Some(message) = reply_to else {
            return Ok(false);
        };
        let (a_id, b_id) = (text(a, "id"), text(b, "id"));
        let after_reset = integer(message, "created_at").unwrap_or(0)
            > integer(b, "reset_at").unwrap_or(i64::MIN);
        Ok(text(message, "from_ep") == b_id
            && a_id != b_id
            && after_reset
            && self.got(message, a).await?)
    }

    /// Why the scope refuses a message from `from` to `to`, or None; `strict` drops an ancestor's pass.
    pub async fn scope_refusal(
        &self,
        from: &Row,
        to: &Row,
        reply_to: Option<&Row>,
        unverified: bool,
        strict: bool,
    ) -> Result<Option<String>, RpcError> {
        let world = self.world().await?;
        let solicited = self.solicited(from, to, reply_to).await?;
        let decision = world.decide(
            text(from, "id").unwrap_or_default(),
            text(to, "id").unwrap_or_default(),
            solicited,
            unverified,
            strict,
        );
        Ok((!decision.allowed).then(|| decision.reasons.last().cloned().unwrap_or_default()))
    }

    /// Refuses a message the scope does not allow and audits why: scope_refused to an agent with authority over `to`, else not_found.
    pub async fn check_scope(
        &self,
        from: &Row,
        to: &Row,
        address_text: &str,
        reply_to: Option<&Row>,
        unverified: bool,
    ) -> Result<(), RpcError> {
        let mut world = self.world().await?;
        let (a, b) = (
            text(from, "id").unwrap_or_default(),
            text(to, "id").unwrap_or_default(),
        );
        world.view_as(Some(a), false);
        let solicited = self.solicited(from, to, reply_to).await?;
        let decision = world.decide(a, b, solicited, unverified, false);
        if decision.allowed {
            return Ok(());
        }
        let refusal = decision.reasons.last().cloned().unwrap_or_default();
        self.audit_once(
            "scope_refused",
            Some(a),
            json!({"from":address(from),"to":address(to),"dir":decision.dir,"reason":refusal}),
        )
        .await?;
        if text(from, "kind") == Some("agent") && world.authority(a, b) {
            return Err(RpcError::new(ErrorCode::ScopeRefused, refusal));
        }
        Err(not_found(address_text))
    }

    /// Why the policy refuses a message from `from` to `to`, or None.
    pub async fn policy_refusal(&self, from: &Row, to: &Row) -> Result<Option<String>, RpcError> {
        if self.policy.is_none() {
            return Ok(None);
        }
        let world = self.world().await?;
        Ok(world.policy_refusal(
            text(from, "id").unwrap_or_default(),
            text(to, "id").unwrap_or_default(),
        ))
    }

    /// An audit row, skipped when an identical one was written within the dedupe window.
    pub async fn audit_once(
        &self,
        event: &str,
        endpoint: Option<&str>,
        detail: Value,
    ) -> Result<(), RpcError> {
        let key = format!("{event}\n{}\n{detail}", endpoint.unwrap_or(""));
        let now = now_ms();
        {
            let mut noise = self.noise.lock().map_err(|_| RpcError::internal())?;
            if noise
                .get(&key)
                .is_some_and(|at| now - at < REFUSAL_DEDUPE_MS)
            {
                return Ok(());
            }
            if noise.len() >= 4096 {
                *noise = HashMap::new();
            }
            noise.insert(key, now);
        }
        self.audit(event, endpoint, None, detail).await
    }
}
