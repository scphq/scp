use crate::authority::Actor;
use crate::claims::{busy_since, harness_fits, revivable, same_provider, valid_handle};
use crate::core::{Core, integer, now_ms, text};
use crate::proto::RpcError;
use crate::rules::{cap_id, caps_json};
use crate::state::{ConnectionId, Mode};
use crate::store::{Row, SqlValue};
use crate::views::{address, not_found, opt, presence};
use crate::world::caps_of;
use scp_core::protocol::CLI_NAME;
use scp_core::protocol::ErrorCode;
use scp_core::protocol::{ScopeCap, ScopeDirection, ScopePreset};
use scp_core::scope::{admits, has_scope, preset_lists};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

impl Core {
    pub async fn rename(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        if params.get("take_over").is_some_and(|v| !v.is_boolean()) {
            return Err(RpcError::invalid_params("take_over is true or false"));
        }
        self.need_terminal(conn).await?;
        let me = self.actor_row(conn).await?;
        let c = self.connection(conn)?;
        if c.lineage.is_some() && !c.own {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "only the session itself renames it",
            ));
        }
        let target = match params.get("endpoint") {
            Some(v) => {
                self.lookup(
                    v.as_str()
                        .ok_or_else(|| RpcError::invalid_params("endpoint is an address"))?,
                )
                .await?
            }
            None => me.clone(),
        };
        let human = matches!(c.mode, Mode::Human { .. });
        if !human && text(&target, "id") != text(&me, "id") {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "an agent renames only itself",
            ));
        }
        if text(&target, "kind") != Some("agent") {
            return Err(RpcError::invalid_params(
                "only a local agent endpoint can be renamed",
            ));
        }
        crate::store::transaction(
            self.store.clone(),
            self.rename_row(
                &target,
                params.get("handle").unwrap_or(&Value::Null),
                human,
                params.get("take_over") == Some(&Value::Bool(true)),
            ),
        )
        .await?;
        self.view(
            &self
                .must_endpoint(text(&target, "id").unwrap_or(""))
                .await?,
        )
        .await
    }
    pub async fn rename_row(
        &mut self,
        row: &Row,
        value: &Value,
        human: bool,
        take_over: bool,
    ) -> Result<Option<String>, RpcError> {
        let raw = value.as_str().unwrap_or("").trim();
        let handle = raw.strip_prefix("me/").unwrap_or(raw);
        if !valid_handle(handle) {
            return Err(RpcError::invalid_params(
                "handle is not valid: lowercase letters, digits, . _ -",
            ));
        }
        if crate::scrub::find_secret(handle).is_some() {
            return Err(RpcError::new(
                ErrorCode::SecretRefused,
                "the handle carries a credential",
            ));
        }
        let id = text(row, "id").ok_or_else(RpcError::internal)?;
        if text(row, "handle") == Some(handle) {
            self.store
                .all(
                    "UPDATE endpoints SET named = COALESCE(named,?) WHERE id = ?",
                    &[SqlValue::Int(now_ms()), opt(Some(id))],
                )
                .await?;
            return Ok(None);
        }
        if !human && text(row, "parent_ep").is_some() && self.default_of("rename") != Some("self") {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "a spawned agent's name is set by its spawner",
            ));
        }
        let mut retired = None;
        if let Some(held) = self.by_handle(handle).await? {
            let offline = text(&held, "kind") == Some("agent")
                && integer(&held, "connections").unwrap_or(0) == 0
                && presence(&held, now_ms()) == "offline";
            let same = text(&held, "harness_session").is_some()
                && text(&held, "harness_session") == text(row, "harness_session");
            if take_over && !human && !same {
                return Err(RpcError::new(
                    ErrorCode::ScopeRefused,
                    "only the human at a terminal takes over another endpoint",
                ));
            }
            if !offline
                || text(&held, "session").is_some_and(|v| v.starts_with("sub:"))
                || !(same
                    || (take_over
                        && harness_fits(
                            text(&held, "harness"),
                            text(row, "harness").unwrap_or("cli"),
                        )))
            {
                return Err(RpcError::invalid_params(
                    "handle is held by another endpoint",
                ));
            }
            retired = Some(
                self.take_over(row, &held, if same { "session" } else { "human" })
                    .await?,
            );
        }
        self.move_handle(row, handle).await?;
        Ok(retired)
    }
    pub async fn move_handle(&mut self, row: &Row, handle: &str) -> Result<(), RpcError> {
        let id = text(row, "id").ok_or_else(RpcError::internal)?;
        let from = text(row, "handle").unwrap_or("");
        self.store
            .all(
                "UPDATE endpoints SET handle = ?,named = ? WHERE id = ?",
                &[opt(Some(handle)), SqlValue::Int(now_ms()), opt(Some(id))],
            )
            .await?;
        self.store
            .all(
                "UPDATE grants SET name = ? WHERE used_by = ? AND name = ?",
                &[opt(Some(handle)), opt(Some(id)), opt(Some(from))],
            )
            .await?;
        self.rewrite_selectors(from, handle).await?;
        self.state
            .addresses
            .insert(id.into(), format!("me/{handle}"));
        self.audit("rename", Some(id), None, json!({"from":from,"to":handle}))
            .await
    }
    pub async fn link_endpoint(&self, row: &Row, parent: &Row, auth: &str) -> Result<(), RpcError> {
        self.link(row, parent, json!({"by": address(row), "auth": auth}))
            .await
    }
    /// `row`, a root, and its subtree moved under `parent`, a local agent that is neither `row` nor below it; `by` is the actor detail
    pub async fn link(&self, row: &Row, parent: &Row, by: Value) -> Result<(), RpcError> {
        let id = text(row, "id").ok_or_else(RpcError::internal)?;
        let parent_id = text(parent, "id").ok_or_else(RpcError::internal)?;
        if text(parent, "kind") != Some("agent") {
            return Err(RpcError::invalid_params("the parent is an agent endpoint"));
        }
        if text(row, "parent_ep") == Some(parent_id) {
            return Ok(());
        }
        if id == parent_id || self.ancestors(parent).await?.iter().any(|v| v == id) {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                format!(
                    "{} sits under {}: a session cannot go under its own descendant",
                    address(parent),
                    address(row)
                ),
            ));
        }
        if text(row, "parent_ep").is_some() || text(row, "parent_addr").is_some() {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                format!(
                    "{} already sits under {}; unlink it first",
                    address(row),
                    self.parent_address(row).await?
                ),
            ));
        }
        let depth = integer(parent, "depth").unwrap_or(0) + 1;
        let shift = depth - integer(row, "depth").unwrap_or(0);
        let tree = text(parent, "tree").unwrap_or(parent_id);
        self.shift_subtree(id, tree, shift).await?;
        let world = self.world().await?;
        let mut caps = caps_of(row);
        if let Ok(preset) = world.defaults.child_default.parse::<ScopePreset>()
            && let Some(list) = preset_lists(preset)
            && !caps.caps.iter().any(|cap| cap.by == "policy")
        {
            for dir in world.defaults.preset_dirs() {
                caps.caps.push(ScopeCap {
                    id: cap_id(),
                    dir: *dir,
                    by: "policy".into(),
                    sels: list.iter().map(|sel| world.entry(sel, None)).collect(),
                });
            }
        }
        self.store.all("UPDATE endpoints SET parent_ep = ?,parent_addr = NULL,tree = ?,depth = ?,linked = ?,caps = ? WHERE id = ?",&[opt(Some(parent_id)),opt(Some(tree)),SqlValue::Int(depth),SqlValue::Int(now_ms()),caps_json(&mut caps),opt(Some(id))]).await?;
        let request = by.get("request").and_then(Value::as_str).map(str::to_owned);
        let mut detail = by;
        detail["target"] = json!(address(row));
        detail["parent"] = json!(address(parent));
        self.audit("adopt", Some(id), request.as_deref(), detail)
            .await
    }
    /// whether `me`, a root, may link under `parent`: it may message it, or with no scope of its own it may message the tree's root and `parent` admits it
    pub async fn may_link_under(&self, me: &Row, parent: &Row) -> Result<bool, RpcError> {
        let world = self.world().await?;
        let (me_id, parent_id) = (
            text(me, "id").unwrap_or_default(),
            text(parent, "id").unwrap_or_default(),
        );
        if !world.is_agent(parent_id) || world.may_message(me_id, parent_id, false, false) {
            return Ok(true);
        }
        let Some(node) = world.node_of(me_id) else {
            return Ok(false);
        };
        if has_scope(node) {
            return Ok(false);
        }
        let Some(root) = world.ancestors_of(parent_id).last().cloned() else {
            return Ok(false);
        };
        if !world.is_agent(&root) || !world.may_message(me_id, &root, false, false) {
            return Ok(false);
        }
        if world.policy_refusal(me_id, parent_id).is_some() {
            return Ok(false);
        }
        let Some(target) = world.node_of(parent_id) else {
            return Ok(false);
        };
        Ok(admits(&world, target, ScopeDirection::In, node, None).ok)
    }
    async fn shift_subtree(&self, id: &str, tree: &str, shift: i64) -> Result<(), RpcError> {
        let below = "WITH RECURSIVE below(id) AS (SELECT id FROM endpoints WHERE parent_ep = ? UNION SELECT e.id FROM endpoints e JOIN below b ON e.parent_ep = b.id)";
        let deepest=self.store.all(&format!("{below} SELECT MAX(depth) AS d FROM endpoints WHERE id IN (SELECT id FROM below)"),&[opt(Some(id))]).await?.into_iter().next().and_then(|r|integer(&r,"d")).unwrap_or(0);
        if deepest + shift > 32 {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "subtree would exceed depthMax",
            ));
        }
        self.store.all(&format!("{below} UPDATE endpoints SET tree = ?,depth = depth + ? WHERE id IN (SELECT id FROM below)"),&[opt(Some(id)),opt(Some(tree)),SqlValue::Int(shift)]).await?;
        Ok(())
    }
    pub async fn take_over(&self, row: &Row, held: &Row, by: &str) -> Result<String, RpcError> {
        let id = text(row, "id").ok_or_else(RpcError::internal)?;
        let retired = text(held, "id").ok_or_else(RpcError::internal)?;
        if self.ancestors(row).await?.iter().any(|v| v == retired) {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "an endpoint cannot take over its own ancestor",
            ));
        }
        if text(row, "parent_ep").is_none() && text(row, "parent_addr").is_none() {
            if let Some(parent) = text(held, "parent_ep").map(str::to_owned)
                && let Some(parent) = self.by_id(&parent).await?
            {
                self.link_endpoint(row, &parent, by).await?;
            } else if text(held, "parent_addr").is_some() {
                self.store
                    .all(
                        "UPDATE endpoints SET parent_addr = ?,linked = ? WHERE id = ?",
                        &[
                            opt(text(held, "parent_addr")),
                            SqlValue::Int(integer(held, "linked").unwrap_or(now_ms())),
                            opt(Some(id)),
                        ],
                    )
                    .await?;
            }
        }
        let place = self.must_endpoint(id).await?;
        self.shift_subtree(
            retired,
            text(&place, "tree").unwrap_or(id),
            integer(&place, "depth").unwrap_or(0) - integer(held, "depth").unwrap_or(0),
        )
        .await?;
        let children = self
            .store
            .all(
                "UPDATE endpoints SET parent_ep = ? WHERE parent_ep = ? RETURNING id",
                &[opt(Some(id)), opt(Some(retired))],
            )
            .await?
            .len();
        self.store
            .all(
                "UPDATE deliveries SET endpoint = ? WHERE endpoint = ? AND acked_at IS NULL",
                &[opt(Some(id)), opt(Some(retired))],
            )
            .await?;
        for column in ["issuer", "under", "used_by"] {
            self.store
                .all(
                    &format!("UPDATE grants SET {column} = ? WHERE {column} = ?"),
                    &[opt(Some(id)), opt(Some(retired))],
                )
                .await?;
        }
        self.store.all("DELETE FROM spawn_via AS old WHERE spawner = ? AND EXISTS (SELECT 1 FROM spawn_via AS newer WHERE newer.spawner = ? AND newer.name = old.name AND newer.created_at > old.created_at)",&[opt(Some(retired)),opt(Some(id))]).await?;
        self.store.all("DELETE FROM spawn_via WHERE spawner = ? AND name IN (SELECT name FROM spawn_via WHERE spawner = ?)",&[opt(Some(id)),opt(Some(retired))]).await?;
        self.store
            .all(
                "UPDATE spawn_via SET spawner = ? WHERE spawner = ?",
                &[opt(Some(id)), opt(Some(retired))],
            )
            .await?;
        self.store
            .all(
                "UPDATE groups SET owner = ? WHERE owner = ?",
                &[opt(Some(id)), opt(Some(retired))],
            )
            .await?;
        self.store.all("INSERT OR IGNORE INTO group_members (name,endpoint,added_by,at) SELECT name,?,added_by,at FROM group_members WHERE endpoint = ?",&[opt(Some(id)),opt(Some(retired))]).await?;
        self.store
            .all(
                "DELETE FROM group_members WHERE endpoint = ?",
                &[opt(Some(retired))],
            )
            .await?;
        self.store.all("UPDATE endpoints SET harness_session = ?,harness_transcript = ? WHERE id = ? AND harness_session IS NULL",&[opt(text(held,"harness_session")),opt(text(held,"harness_transcript")),opt(Some(id))]).await?;
        self.store.all("UPDATE endpoints SET handle = ?,session = NULL,token_hash = NULL,peek = NULL WHERE id = ?",&[opt(Some(&format!("{}{retired}", crate::world::GONE))),opt(Some(retired))]).await?;
        self.wake_done(retired, "retired").await?;
        self.audit("take_over",Some(id),None,json!({"from":text(row,"handle"),"to":text(held,"handle"),"retired":retired,"children":children,"by":by})).await?;
        Ok(retired.into())
    }
    pub async fn retake(&mut self, row: &Row, held: &Row, human: bool) -> Result<String, RpcError> {
        if !human && text(row, "parent_ep").is_some() && self.default_of("rename") != Some("self") {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "a spawned agent's name is set by its spawner",
            ));
        }
        let retired = self
            .take_over(row, held, if human { "human" } else { "session" })
            .await?;
        self.move_handle(row, text(held, "handle").unwrap_or(""))
            .await?;
        let inferred =
            text(row, "title").is_none() || text(row, "title") == text(row, "title_auto");
        self.store.all("UPDATE endpoints SET named = ?,title = CASE WHEN ? THEN ? ELSE title END,title_auto = CASE WHEN ? THEN ? ELSE title_auto END WHERE id = ?",&[integer(held,"named").map_or(SqlValue::Null,SqlValue::Int),SqlValue::Int(i64::from(inferred)),opt(text(held,"title")),SqlValue::Int(i64::from(inferred)),opt(text(held,"title_auto")),opt(text(row,"id"))]).await?;
        Ok(retired)
    }
    pub async fn leave(
        &self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        self.need_terminal(conn).await?;
        let c = self.connection(conn)?;
        let me = self.actor_row(conn).await?;
        if c.lineage.is_some() && !c.own {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "only the session itself leaves",
            ));
        }
        let target = match params.get("endpoint") {
            Some(v) => {
                self.lookup(
                    v.as_str()
                        .ok_or_else(|| RpcError::invalid_params("endpoint is an address"))?,
                )
                .await?
            }
            None => me.clone(),
        };
        if !matches!(c.mode, Mode::Human { .. }) && text(&target, "id") != text(&me, "id") {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "an agent leaves only for itself",
            ));
        }
        if text(&target, "kind") != Some("agent") {
            return Err(RpcError::invalid_params(
                "only a local agent endpoint can leave",
            ));
        }
        if text(&target, "parent_ep").is_some() && integer(&target, "linked").is_none() {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "a spawned worker stays joined while it runs",
            ));
        }
        self.store.all("UPDATE endpoints SET session = NULL,token_hash = NULL,hook_seen = NULL,hook_ended = ?,wake = NULL,hold_ref = NULL WHERE id = ?",&[SqlValue::Int(now_ms()),opt(text(&target,"id"))]).await?;
        self.wake_done(text(&target, "id").unwrap_or(""), "leave")
            .await?;
        self.audit(
            "leave",
            text(&target, "id"),
            None,
            json!({"handle":text(&target,"handle")}),
        )
        .await?;
        self.view(
            &self
                .must_endpoint(text(&target, "id").unwrap_or(""))
                .await?,
        )
        .await
    }
    fn actor_detail(actor: &Actor, me: &Row) -> Value {
        json!({"by": address(me), "auth": actor.auth()})
    }
    /// the human links a local root directly; an agent adopts a root it may message under itself, and asks a child of another parent to link
    pub async fn adopt(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let terminal = self.connection(conn)?.terminal;
        let human = matches!(actor, Actor::Human { .. });
        if !human && !terminal {
            self.policy_gate().await?;
        }
        let me = self.actor_endpoint(&actor).await?;
        let named = params.get("endpoint").and_then(Value::as_str);
        if human {
            self.need_tty(&actor, &me, named.map(str::to_owned)).await?;
        }
        let named = named.ok_or_else(|| RpcError::invalid_params("endpoint is an address"))?;
        let target = self.lookup(named).await?;
        if text(&target, "kind") != Some("agent") {
            return Err(RpcError::invalid_params(
                "only a local agent endpoint can be linked",
            ));
        }
        let parent = match params.get("parent").filter(|v| !v.is_null()) {
            Some(value) => {
                let value = value
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| RpcError::invalid_params("parent is an address"))?;
                self.lookup(value).await?
            }
            None if !human => me.clone(),
            None => {
                return Err(RpcError::invalid_params(
                    "the human names the parent to link under",
                ));
            }
        };
        let detail = json!({"target": address(&target), "reason": "adopt"});
        if !human && text(&parent, "id") != text(&me, "id") {
            return Err(self
                .refused(&actor, &me, detail, "an agent adopts only under itself")
                .await);
        }
        let mut result = json!({"endpoint": self.view(&target).await?, "parent": address(&parent)});
        let target_id = text(&target, "id")
            .ok_or_else(RpcError::internal)?
            .to_owned();
        if human || terminal {
            self.link(&target, &parent, Self::actor_detail(&actor, &me))
                .await?;
            result["endpoint"] = self.view(&self.must_endpoint(&target_id).await?).await?;
            return Ok(result);
        }
        if !self
            .world()
            .await?
            .discovers(text(&me, "id").unwrap_or_default(), &target_id)
        {
            return Err(not_found(named));
        }
        let reason = if text(&target, "id") == text(&me, "id") {
            Some("an agent cannot adopt itself".to_owned())
        } else if self.ancestors(&me).await?.contains(&target_id) {
            Some(format!(
                "{} sits above you: an agent cannot adopt its own ancestor",
                address(&target)
            ))
        } else if text(&target, "session").is_some_and(|v| v.starts_with("sub:")) {
            Some(format!(
                "{} is a subagent's endpoint: it stays under its root",
                address(&target)
            ))
        } else {
            None
        };
        if let Some(reason) = reason {
            return Err(self.refused(&actor, &me, detail, &reason).await);
        }
        if text(&target, "parent_ep") == text(&me, "id") {
            return Ok(result);
        }
        if text(&target, "parent_ep").is_some() || text(&target, "parent_addr").is_some() {
            if actor.auth() == "lineage" {
                return Err(self
                    .refused(
                        &actor,
                        &me,
                        detail,
                        "only the session itself may ask a child that sits under another parent to link",
                    )
                    .await);
            }
            let under = self.parent_address(&target).await?;
            let parent = address(&parent);
            let params = json!({"to":address(&target),"kind":"request","ttl_s":86_400,"body":format!("{parent} asks you to link under it as its worker. You sit under {under} now: you can accept only once you are a root again. To accept, run {CLI_NAME} link accept <id> with this message's id, or {CLI_NAME} join --under {parent} (relay_link_accept {{id}} or relay_join {{under: \"{parent}\"}}).")});
            let sent = self
                .send_link_request(
                    text(&me, "id").ok_or_else(RpcError::internal)?,
                    &target_id,
                    params.as_object().ok_or_else(RpcError::internal)?,
                )
                .await?;
            if let Some(held) = sent.get("held").filter(|v| !v.is_null()) {
                result["held"] = held.clone();
            } else {
                result["requested"] = sent["id"].clone();
            }
            return Ok(result);
        }
        self.check_scope(&me, &target, named, None, false).await?;
        if let Some(policy) = self.policy_refusal(&me, &target).await? {
            return Err(RpcError::new(
                ErrorCode::PolicyRefused,
                format!("{policy} ({})", address(&target)),
            ));
        }
        self.link(&target, &me, Self::actor_detail(&actor, &me))
            .await?;
        result["endpoint"] = self.view(&self.must_endpoint(&target_id).await?).await?;
        Ok(result)
    }
    /// a link request delivered to `endpoint`: by its id, a delivery seq, or a unique id suffix
    async fn delivered_request(&self, endpoint: &str, id: &str) -> Result<Option<Row>, RpcError> {
        let query = "SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND d.expires_at > ?";
        let now = SqlValue::Int(now_ms());
        if let Some(row) = self
            .store
            .all(
                &format!("{query} AND m.id = ? ORDER BY d.seq LIMIT 1"),
                &[opt(Some(endpoint)), now.clone(), opt(Some(id))],
            )
            .await?
            .into_iter()
            .next()
        {
            return Ok(Some(row));
        }
        if !id.is_empty()
            && id.len() <= 15
            && id.bytes().all(|b| b.is_ascii_digit())
            && let Some(row) = self
                .store
                .all(
                    &format!("{query} AND d.seq = ?"),
                    &[
                        opt(Some(endpoint)),
                        now.clone(),
                        SqlValue::Int(id.parse().unwrap_or(0)),
                    ],
                )
                .await?
                .into_iter()
                .next()
        {
            return Ok(Some(row));
        }
        if id.len() < 4
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
        {
            return Ok(None);
        }
        let rows = self
            .store
            .all(
                &format!("{query} AND substr(m.id, -?) = ? ORDER BY d.seq DESC LIMIT 50"),
                &[
                    opt(Some(endpoint)),
                    now,
                    SqlValue::Int(id.len() as i64),
                    opt(Some(id)),
                ],
            )
            .await?;
        let ids: HashSet<&str> = rows.iter().filter_map(|r| text(r, "id")).collect();
        if ids.len() > 1 {
            return Err(RpcError::invalid_params(format!(
                "{id} matches more than one message delivered to you; give more of the id"
            )));
        }
        Ok(rows.into_iter().next())
    }
    /// accepts a broker-issued link request delivered to the caller's own session
    pub async fn link_accept(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        if matches!(actor, Actor::Human { .. }) || actor.auth() == "lineage" {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "only the session itself accepts a link request",
            ));
        }
        let me = self.actor_endpoint(&actor).await?;
        let id = params
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::invalid_params("id is a message id"))?;
        let request = self
            .delivered_request(text(&me, "id").unwrap_or_default(), id)
            .await?
            .filter(|r| text(r, "link_parent").is_some() && text(r, "kind") == Some("request"))
            .ok_or_else(|| {
                RpcError::new(
                    ErrorCode::NotFound,
                    "no link request delivered to this endpoint",
                )
            })?;
        let parent = self
            .must_endpoint(text(&request, "from_ep").unwrap_or_default())
            .await?;
        if text(&parent, "kind") != Some("agent") {
            return Err(RpcError::invalid_params(
                "the requesting parent is no longer an agent",
            ));
        }
        let mut by = Self::actor_detail(&actor, &me);
        by["request"] = json!(text(&request, "id"));
        crate::store::transaction(self.store.clone(), self.link(&me, &parent, by)).await?;
        Ok(
            json!({"endpoint": self.view(&self.must_endpoint(text(&me, "id").unwrap_or_default()).await?).await?, "parent": address(&parent)}),
        )
    }
    /// a linked agent back to a root with its subtree; the human at a terminal unlinks any, an agent itself only when the policy lets it
    pub async fn unlink(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let me = self.actor_endpoint(&actor).await?;
        let named = params.get("endpoint").filter(|v| !v.is_null());
        let human = matches!(actor, Actor::Human { .. });
        if human {
            self.need_tty(
                &actor,
                &me,
                named.and_then(Value::as_str).map(str::to_owned),
            )
            .await?;
        } else if actor.auth() == "lineage" {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "only the session itself unlinks it: run this from the session's own shell",
            ));
        }
        let target = match named {
            Some(value) => {
                self.lookup(
                    value
                        .as_str()
                        .ok_or_else(|| RpcError::invalid_params("endpoint is an address"))?,
                )
                .await?
            }
            None => me.clone(),
        };
        if !human && text(&target, "id") != text(&me, "id") {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "an agent unlinks only itself",
            ));
        }
        if text(&target, "kind") != Some("agent") {
            return Err(RpcError::invalid_params(
                "only a local agent endpoint can be unlinked",
            ));
        }
        if text(&target, "parent_ep").is_none() && text(&target, "parent_addr").is_none() {
            return Err(RpcError::invalid_params(format!(
                "{} is a root: it has no parent",
                address(&target)
            )));
        }
        if !human && self.default_of("unlink") != Some("self") {
            return Err(self
                .refused(
                    &actor,
                    &me,
                    json!({"target": address(&target), "reason": "unlink"}),
                    "unlinking widens a worker's scope: only the human at a terminal unlinks it (policy defaults.unlink: self lets it)",
                )
                .await);
        }
        let id = text(&target, "id")
            .ok_or_else(RpcError::internal)?
            .to_owned();
        let from = self.parent_address(&target).await?;
        let mut detail = Self::actor_detail(&actor, &me);
        detail["target"] = json!(address(&target));
        detail["parent"] = json!(from);
        if text(&target, "parent_ep").is_none() {
            self.store
                .all(
                    "UPDATE endpoints SET parent_addr = NULL,linked = NULL WHERE id = ?",
                    &[opt(Some(&id))],
                )
                .await?;
        } else {
            let shift = integer(&target, "depth").unwrap_or(0);
            let mut caps = caps_of(&target);
            caps.caps.retain(|cap| cap.by != "policy");
            crate::store::transaction(self.store.clone(), async {
                self.store.all("WITH RECURSIVE below(id) AS (SELECT id FROM endpoints WHERE parent_ep = ? UNION SELECT e.id FROM endpoints e JOIN below b ON e.parent_ep = b.id) UPDATE endpoints SET tree = ?, depth = depth - ? WHERE id IN (SELECT id FROM below)",&[opt(Some(&id)),opt(Some(&id)),SqlValue::Int(shift)]).await?;
                self.store.all("UPDATE endpoints SET tree = NULL,parent_ep = NULL,depth = 0,linked = NULL,caps = ? WHERE id = ?",&[caps_json(&mut caps),opt(Some(&id))]).await?;
                Ok::<_, RpcError>(())
            })
            .await?;
        }
        self.audit("unlink", Some(&id), None, detail).await?;
        Ok(json!({"endpoint": self.view(&self.must_endpoint(&id).await?).await?, "parent": from}))
    }
    async fn parent_address(&self, row: &Row) -> Result<String, RpcError> {
        if let Some(parent) = text(row, "parent_ep")
            && let Some(parent) = self.by_id(parent).await?
        {
            return Ok(address(&parent));
        }
        Ok(text(row, "parent_addr").unwrap_or("another agent").into())
    }
    pub async fn relink(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        if params.get("dry_run").is_some_and(|v| !v.is_boolean()) {
            return Err(RpcError::invalid_params("dry_run is true or false"));
        }
        if params.get("live").is_some_and(|v| !v.is_boolean()) {
            return Err(RpcError::invalid_params("live is true or false"));
        }
        if !self.at_terminal(conn) {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                "only the human at a terminal relinks endpoints",
            ));
        }
        let rows=self.store.all("SELECT * FROM endpoints WHERE kind = 'agent' AND substr(handle,1,5) != 'gone:' AND substr(handle,1,6) != '_gone_' AND (session IS NULL OR substr(session,1,4) != 'sub:') ORDER BY COALESCE(last_seen,created_at) DESC",&[]).await?;
        let grants = self
            .store
            .all(
                "SELECT used_by FROM grants WHERE name IS NOT NULL AND used_by IS NOT NULL",
                &[],
            )
            .await?;
        let chosen: HashSet<String> = rows
            .iter()
            .filter(|r| {
                integer(r, "named").is_some()
                    || grants.iter().any(|g| text(g, "used_by") == text(r, "id"))
            })
            .filter_map(|r| text(r, "id").map(str::to_owned))
            .collect();
        let now = now_ms();
        let mut pairs = Vec::new();
        for row in &rows {
            if chosen.contains(text(row, "id").unwrap_or("")) {
                continue;
            }
            for held in &rows {
                if !chosen.contains(text(held, "id").unwrap_or(""))
                    || (!harness_fits(text(held, "harness"), text(row, "harness").unwrap_or("cli"))
                        && !same_provider(
                            text(held, "harness"),
                            text(row, "harness").unwrap_or("cli"),
                        ))
                {
                    continue;
                }
                if text(held, "parent_ep") != text(row, "parent_ep")
                    && !(text(row, "parent_ep").is_none() && text(row, "parent_addr").is_none())
                {
                    continue;
                }
                let hs = text(held, "harness_session");
                let by = if hs.is_some() && hs == text(row, "harness_session") {
                    Some("session")
                } else if hs.is_some() && hs == text(row, "harness_origin") {
                    Some("origin")
                } else {
                    None
                };
                if let Some(by) = by {
                    let live = !self.released(held).await;
                    if live
                        && (by != "origin"
                            || integer(held, "created_at").unwrap_or(0)
                                >= integer(row, "created_at").unwrap_or(0)
                            || revivable(held)
                            || busy_since(
                                held,
                                integer(row, "created_at").unwrap_or(0),
                                false,
                                now,
                                self.limits.get("restartGraceS").unwrap_or(60) as i64 * 1000,
                            ))
                    {
                        continue;
                    }
                    pairs.push((row.clone(), held.clone(), by, live));
                }
            }
        }
        pairs.sort_by_key(|(row, _, by, live)| {
            (
                *live,
                *by != "session",
                presence(row, now) == "offline",
                -integer(row, "last_seen")
                    .or_else(|| integer(row, "created_at"))
                    .unwrap_or(0),
            )
        });
        let mut taken = HashSet::new();
        let mut relinked = Vec::new();
        for (row, held, by, live) in pairs {
            let id = text(&row, "id").unwrap_or("");
            let retired = text(&held, "id").unwrap_or("");
            if taken.contains(id) || taken.contains(retired) {
                continue;
            }
            taken.insert(id.to_owned());
            taken.insert(retired.to_owned());
            let mut pair =
                json!({"endpoint":id,"from":text(&row,"handle"),"to":text(&held,"handle"),"by":by});
            if live {
                pair["live"] = json!(true);
            }
            if params.get("dry_run") != Some(&Value::Bool(true))
                && (!live || params.get("live") == Some(&Value::Bool(true)))
            {
                if let Err(error) =
                    crate::store::transaction(self.store.clone(), self.retake(&row, &held, true))
                        .await
                {
                    let Some(data) = error.data else {
                        return Err(error);
                    };
                    self.audit(
                        "relink_refused",
                        Some(id),
                        None,
                        json!({"from":pair["from"],"to":pair["to"],"code":data.code}),
                    )
                    .await?;
                    continue;
                }
                pair["retired"] = json!(retired);
                self.audit("relink", Some(id), None, pair.clone()).await?;
                self.state.close_endpoint(retired, conn);
            }
            relinked.push(pair);
        }
        Ok(json!({"relinked":relinked}))
    }
}
