use serde_json::{Map, Value, json};

use crate::claims::valid_handle;
use crate::core::{Core, integer, now_ms, text, timestamp};
use crate::proto::{ErrorCode, RpcError};
use std::collections::HashSet;

use crate::authority::Actor;
use crate::state::ConnectionId;
use crate::store::{Row, SqlValue};
use crate::world::{HUMAN_HANDLE, World};

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
    pub async fn list_endpoints(
        &mut self,
        params: &Map<String, Value>,
        viewer: Option<&str>,
    ) -> Result<Value, RpcError> {
        self.end_exited().await?;
        let mut world = None;
        if let Some(viewer) = viewer {
            let w = self.world().await?;
            let shown = w.row(viewer).map(|row| w.visible(row)).unwrap_or_default();
            world = Some((w, shown));
        }
        let rows = self.store.all("SELECT * FROM endpoints WHERE kind != 'system' AND substr(handle,1,5) != 'gone:' AND substr(handle,1,6) != '_gone_' ORDER BY created_at, id", &[]).await?;
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
            let mut view = self.view(&row).await?;
            if let (Some((w, shown)), Some(viewer)) = (&world, viewer) {
                let id = text(&row, "id").unwrap_or_default();
                if id != viewer && !w.may_message(viewer, id, w.is_human(viewer), false) {
                    continue;
                }
                if text(&row, "parent_ep").is_some_and(|p| !shown.contains(p)) {
                    view["parent"] = Value::Null;
                }
            }
            endpoints.push(view);
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
    pub async fn audit_log(
        &self,
        params: &Map<String, Value>,
        viewer: Option<&str>,
    ) -> Result<Value, RpcError> {
        let seen = match viewer {
            Some(viewer) => {
                let world = self.world().await?;
                let shown = world
                    .row(viewer)
                    .map(|row| world.visible(row))
                    .unwrap_or_default();
                Some((world, shown))
            }
            None => None,
        };
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
            if let Some((world, shown)) = &seen {
                let listed = text(&row, "endpoint").is_some_and(|id| shown.contains(id));
                let detail = text(&row, "detail")
                    .and_then(|v| serde_json::from_str::<Value>(v).ok())
                    .unwrap_or(json!({}));
                let reference = text(&row, "ref").map_or(Value::Null, |v| json!(v));
                if !listed
                    || mentions_hidden(world, shown, &reference)
                    || mentions_hidden(world, shown, &detail)
                {
                    continue;
                }
            }
            values.push(json!({"id":integer(&row,"id"),"at":integer(&row,"at").and_then(timestamp),"event":text(&row,"event"),"endpoint":match text(&row,"endpoint") {Some(id)=>Some(self.address_of(id).await?),None=>None},"ref":text(&row,"ref"),"detail":text(&row,"detail").and_then(|v|serde_json::from_str::<Value>(v).ok()).unwrap_or(json!({}))}));
        }
        Ok(json!({"rows":values}))
    }
}

/// Whether a value names, as `me/<handle>`, an endpoint outside `shown`.
fn mentions_hidden(world: &World, shown: &HashSet<String>, value: &Value) -> bool {
    match value {
        Value::String(text) => addresses_in(text).iter().any(|address| {
            let handle = address.split_once('/').map_or("", |(_, h)| h);
            let handle = if handle.is_empty() {
                HUMAN_HANDLE
            } else {
                handle
            };
            !world
                .by_handle(handle)
                .and_then(|row| text_of(row, "id"))
                .is_some_and(|id| shown.contains(id))
        }),
        Value::Array(values) => values.iter().any(|v| mentions_hidden(world, shown, v)),
        Value::Object(map) => map.values().any(|v| mentions_hidden(world, shown, v)),
        _ => false,
    }
}

fn address_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._/-".contains(c)
}

fn addresses_in(value: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for user in ["me/", "local/"] {
        for (at, _) in value.match_indices(user) {
            if value[..at].chars().next_back().is_some_and(address_char) {
                continue;
            }
            let end = value[at..]
                .char_indices()
                .find(|(_, c)| !address_char(*c))
                .map_or(value.len(), |(i, _)| at + i);
            out.push(&value[at..end]);
        }
    }
    out
}

fn text_of<'a>(row: &'a Row, key: &str) -> Option<&'a str> {
    text(row, key)
}

impl Core {
    pub async fn list_for(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let viewer = self.viewer_of(conn);
        self.list_endpoints(params, viewer.as_deref()).await
    }

    pub async fn log_for(
        &self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let viewer = self.viewer_of(conn);
        self.audit_log(params, viewer.as_deref()).await
    }

    /// The addresses `viewer` sees: those it may message or be messaged by, and itself.
    pub async fn visible_to(&self, viewer: &str) -> Result<HashSet<String>, RpcError> {
        let world = self.world().await?;
        let Some(row) = world.row(viewer) else {
            return Ok(HashSet::new());
        };
        Ok(world
            .visible(row)
            .iter()
            .filter_map(|id| world.row(id).map(address))
            .collect())
    }

    pub async fn snapshot_for(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let viewer = self.viewer_of(conn);
        self.snapshot(params, viewer.as_deref()).await
    }

    /// The fleet now: the listed endpoints, the latest activity, and unread mail of each endpoint the viewer may message.
    pub async fn snapshot(
        &mut self,
        params: &Map<String, Value>,
        viewer: Option<&str>,
    ) -> Result<Value, RpcError> {
        let viewer = viewer.map(str::to_owned);
        let mut filters = Map::new();
        for key in ["all", "historic"] {
            if params.get(key) == Some(&Value::Bool(true)) {
                filters.insert(key.into(), Value::Bool(true));
            }
        }
        let endpoints =
            self.list_endpoints(&filters, viewer.as_deref()).await?["endpoints"].clone();
        let world = self.world().await?;
        let mut unread = Map::new();
        for row in self.store.all("SELECT endpoint, COUNT(*) AS n FROM deliveries WHERE acked_at IS NULL AND expires_at > ? GROUP BY endpoint", &[SqlValue::Int(now_ms())]).await? {
            let id = text(&row, "endpoint").unwrap_or_default();
            let Some(target) = world.row(id) else { continue };
            if text(target, "kind") == Some("system") || crate::world::is_gone(target) {
                continue;
            }
            if let Some(viewer) = viewer.as_deref()
                && id != viewer
                && !world.may_message(viewer, id, world.is_human(viewer), false)
            {
                continue;
            }
            unread.insert(address(target), json!(integer(&row, "n").unwrap_or(0)));
        }
        let among: Vec<String> = endpoints
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["id"].as_str().map(str::to_owned))
            .collect();
        let limit = params
            .get("activity")
            .and_then(Value::as_i64)
            .unwrap_or(50)
            .clamp(1, 1000);
        let activity = self.activity_among(&world, &among, limit).await?;
        Ok(
            json!({"endpoints": endpoints, "activity": activity, "unread": unread, "broker": self.broker_info()}),
        )
    }

    async fn activity_among(
        &self,
        world: &World,
        among: &[String],
        limit: i64,
    ) -> Result<Vec<Value>, RpcError> {
        if among.is_empty() {
            return Ok(Vec::new());
        }
        let marks = vec!["?"; among.len()].join(", ");
        let mut values: Vec<SqlValue> = among.iter().map(|id| SqlValue::Text(id.clone())).collect();
        values.push(SqlValue::Int(limit));
        let mut rows = self
            .store
            .all(
                &format!(
                    "SELECT * FROM activity WHERE endpoint IN ({marks}) ORDER BY id DESC LIMIT ?"
                ),
                &values,
            )
            .await?;
        rows.reverse();
        Ok(rows
            .iter()
            .map(|row| {
                let endpoint = text(row, "endpoint").unwrap_or_default();
                json!({"id": integer(row, "id"), "at": integer(row, "at").and_then(timestamp), "endpoint": world.row(endpoint).map_or_else(|| endpoint.to_owned(), address), "kind": text(row, "kind"), "tool": text(row, "tool"), "summary": text(row, "summary"), "agent": text(row, "agent")})
            })
            .collect())
    }

    /// The endpoints the viewer may message under its scope and the policy, with the rule that admits each.
    pub async fn peers(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let viewer = match self.viewer_of(conn) {
            Some(viewer) => viewer,
            None => self
                .connection(conn)?
                .endpoint
                .ok_or_else(RpcError::internal)?,
        };
        let me = self.must_endpoint(&viewer).await?;
        let unverified = text(&me, "kind") == Some("human") && !self.at_terminal(conn);
        let historic = params.get("all") == Some(&Value::Bool(true))
            || params.get("historic") == Some(&Value::Bool(true));
        let mut world = self.world().await?;
        world.view_as(Some(&viewer), true);
        let mut peers = Vec::new();
        let rows: Vec<Row> = world.listed().cloned().collect();
        for row in rows {
            let id = text(&row, "id").unwrap_or_default();
            if id == viewer || !world.may_message(&viewer, id, unverified, false) {
                continue;
            }
            let view = self.view(&row).await?;
            if !historic && view.get("historic") == Some(&Value::Bool(true)) {
                continue;
            }
            let decision = world.decide(&viewer, id, false, unverified, false);
            let reason = match &decision.admitted {
                None => decision.reasons.join("; "),
                Some(admitted) => {
                    let (Some(peer), Some(mine)) = (world.subject(id), world.subject(&viewer))
                    else {
                        return Err(RpcError::internal());
                    };
                    let list = if admitted.is_empty() {
                        "open".to_owned()
                    } else {
                        admitted.join(", ")
                    };
                    format!("{} ({list})", scp_core::scope::relation_text(peer, mine))
                }
            };
            let mut peer = json!({"address": view["address"], "kind": view["kind"], "presence": view["presence"], "title": view["title"], "status": view["status"], "reason": reason});
            if view.get("historic") == Some(&Value::Bool(true)) {
                peer["historic"] = json!(true);
            }
            peers.push(peer);
        }
        Ok(json!({"peers": peers}))
    }

    async fn pair_state(&self, _a: &str, _b: &str, _now: i64) -> Result<Value, RpcError> {
        Ok(json!({}))
    }

    /// Whether `from` may message `to` and why; an agent asks only about pairs it holds or has authority over, each side one it sees.
    pub async fn why(&self, actor: &Actor, from: &str, to: &str) -> Result<Value, RpcError> {
        let me = self.actor_endpoint(actor).await?;
        let (a, b) = (self.lookup(from).await?, self.lookup(to).await?);
        let me_id = text(&me, "id").unwrap_or_default().to_owned();
        let (a_id, b_id) = (
            text(&a, "id").unwrap_or_default(),
            text(&b, "id").unwrap_or_default(),
        );
        let mut world = self.world().await?;
        if text(&me, "kind") == Some("agent") {
            let mine = |id: &str| id == me_id || world.authority(&me_id, id);
            let hidden = [a_id, b_id]
                .iter()
                .position(|id| !mine(id) && !world.sees(&me_id, id));
            if hidden.is_some() || !(mine(a_id) || mine(b_id)) {
                return Err(not_found(if hidden == Some(1) { to } else { from }));
            }
            world.view_as(Some(&me_id), true);
        } else if !actor.at_terminal()
            && let Some(hidden) = [a_id, b_id]
                .iter()
                .position(|id| *id != me_id && !world.may_message(&me_id, id, true, false))
        {
            return Err(not_found(if hidden == 0 { from } else { to }));
        }
        let decision = world.decide(a_id, b_id, false, false, false);
        let policy = world.policy_refusal(a_id, b_id);
        let limits = self.pair_state(a_id, b_id, now_ms()).await?;
        let mut reasons = decision.reasons.clone();
        reasons.extend(policy.clone());
        reasons.extend(
            limits["lines"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        );
        let held = limits["held"] == Value::Bool(true);
        let mut result =
            json!({"allowed": decision.allowed && policy.is_none() && !held, "reasons": reasons});
        if let Some(pair) = limits.get("pair") {
            result["pair"] = pair.clone();
        }
        Ok(result)
    }
}

pub fn opt(value: Option<&str>) -> SqlValue {
    value.map_or(SqlValue::Null, |v| SqlValue::Text(v.into()))
}
pub fn not_found(value: &str) -> RpcError {
    RpcError::new(ErrorCode::NotFound, format!("no endpoint {value}"))
}
