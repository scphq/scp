use std::collections::HashMap;

use scp_core::protocol::ScopeDirection;
use scp_core::scope::valid_group_name;
use serde_json::{Map, Value, json};

use crate::authority::Actor;
use crate::core::{Core, now_ms, text, timestamp};
use crate::proto::{ErrorCode, RpcError};
use crate::rules::{
    DIRS, Namer, cap_id, caps_json, optional, rule_get, rules_json, selector_list, set_rule,
};
use crate::state::{ConnectionId, Mode};
use crate::store::{Row, SqlValue};
use crate::views::{address, not_found};
use crate::world::{Group, GroupRules, World, caps_of};
use scp_core::protocol::{ScopeCap, ScopePreset};
use scp_core::scope::{ScopeCaps, ScopeRules, preset_lists};

pub const FAN_OUT_MAX: usize = 32;
pub const FAN_OUT_TOTAL: usize = 64;

pub(crate) fn grant_caps(grant: &Row) -> Vec<ScopeCap> {
    let issuer = text(grant, "issuer").unwrap_or_default();
    let caps: Vec<Value> = text(grant, "caps")
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();
    caps.into_iter()
        .filter_map(|cap| {
            Some(ScopeCap {
                id: cap_id(),
                dir: serde_json::from_value(cap.get("dir")?.clone()).ok()?,
                by: issuer.to_owned(),
                sels: serde_json::from_value(cap.get("sels")?.clone()).ok()?,
            })
        })
        .collect()
}

fn row_id(row: &Row) -> &str {
    text(row, "id").unwrap_or_default()
}

fn s(value: &str) -> SqlValue {
    SqlValue::Text(value.into())
}

pub fn group_name(value: Option<&Value>) -> Result<String, RpcError> {
    value
        .and_then(Value::as_str)
        .filter(|v| valid_group_name(v) && *v != "self")
        .map(str::to_owned)
        .ok_or_else(|| RpcError::invalid_params("a group name is lowercase letters, digits, . _ -"))
}

pub fn group_names(value: Option<&Value>, field: &str) -> Result<Vec<String>, RpcError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    let list = value.as_array().filter(|l| l.len() <= 16).ok_or_else(|| {
        RpcError::invalid_params(format!("{field} is a list of at most 16 group names"))
    })?;
    let mut out: Vec<String> = Vec::new();
    for v in list {
        let name = group_name(Some(v))?;
        if !out.contains(&name) {
            out.push(name);
        }
    }
    Ok(out)
}

fn group_view(world: &World, group: &Group, viewer: &Row) -> Value {
    let namer = Namer::new(world, viewer);
    let mut rules = json!({});
    for dir in DIRS {
        if let Some(list) = group.rules.get(dir) {
            rules[dir.as_str()] = namer.entries(list);
        }
    }
    json!({
        "name": group.name,
        "owner": owner_name(world, &group.owner),
        "tree": group.tree.as_deref().map_or(Value::Null, |t| namer.place(t)),
        "pinned": group.pinned,
        "policy": group.policy,
        "rules": rules,
        "members": world.members_for(row_id(viewer), group).into_iter().map(address).collect::<Vec<_>>(),
    })
}

fn owner_name(world: &World, owner: &str) -> String {
    if owner == "policy" {
        owner.to_owned()
    } else {
        world.row(owner).map_or_else(|| owner.to_owned(), address)
    }
}

impl Core {
    /// A group's rules from `rules` (both directions under symmetric presets, else out), `in` and `out`; entries new to a direction carry `via`.
    fn group_rules(
        &self,
        world: &World,
        me: &Row,
        params: &Map<String, Value>,
        prev: &GroupRules,
        via: Option<&str>,
    ) -> Result<GroupRules, RpcError> {
        let mut next: HashMap<ScopeDirection, Vec<String>> = HashMap::new();
        if let Some(v) = params.get("rules") {
            for dir in world.defaults.preset_dirs() {
                next.insert(*dir, selector_list(v, "rules", true)?);
            }
        }
        for dir in DIRS {
            if let Some(v) = params.get(dir.as_str()) {
                next.insert(dir, selector_list(v, dir.as_str(), true)?);
            }
        }
        for sels in next.values() {
            self.need_groups(world, me, sels, true)?;
        }
        let mut rules = prev.clone();
        for dir in DIRS {
            let Some(sels) = next.get(&dir) else { continue };
            let before = prev.get(dir);
            let mut unique: Vec<&String> = Vec::new();
            for sel in sels {
                if !unique.contains(&sel) {
                    unique.push(sel);
                }
            }
            let entries = unique
                .into_iter()
                .map(
                    |sel| match before.and_then(|b| b.iter().find(|e| &e.sel == sel)) {
                        Some(entry) => world.rebound(entry),
                        None => world.entry(sel, before.and(via)),
                    },
                )
                .collect();
            rules.set(dir, Some(entries));
        }
        Ok(rules)
    }

    async fn join(&self, name: &str, endpoint: &str, by: &str) -> Result<(), RpcError> {
        self.store
            .all(
                "INSERT OR IGNORE INTO group_members (name, endpoint, added_by, at) VALUES (?, ?, ?, ?)",
                &[s(name), s(endpoint), s(by), SqlValue::Int(now_ms())],
            )
            .await?;
        Ok(())
    }

    /// A member leaves, and its allowances into the group's caps, and those its membership gave, go with it.
    pub(crate) async fn leave_group(&self, name: &str, endpoint: &str) -> Result<(), RpcError> {
        self.store
            .all(
                "DELETE FROM group_members WHERE name = ? AND endpoint = ?",
                &[s(name), s(endpoint)],
            )
            .await?;
        let Some(row) = self.by_id(endpoint).await? else {
            return Ok(());
        };
        if text(&row, "caps").is_none() {
            return Ok(());
        }
        let mut caps = caps_of(&row);
        for dir in DIRS {
            caps.allow
                .remove(&scp_core::scope::group_cap_key(name, dir));
        }
        let sel = format!("group:{name}");
        for cap in &mut caps.caps {
            cap.sels.retain(|e| !(e.member && e.sel == sel));
        }
        for entries in caps.allow.values_mut() {
            entries.retain(|e| !(e.member && e.sel == sel));
        }
        self.store
            .all(
                "UPDATE endpoints SET caps = ? WHERE id = ?",
                &[crate::rules::caps_json(&mut caps), s(endpoint)],
            )
            .await?;
        Ok(())
    }

    async fn drop_group(&self, name: &str) -> Result<(), RpcError> {
        for row in self
            .store
            .all(
                "SELECT endpoint FROM group_members WHERE name = ?",
                &[s(name)],
            )
            .await?
        {
            self.leave_group(name, text(&row, "endpoint").unwrap_or_default())
                .await?;
        }
        self.store
            .all("DELETE FROM groups WHERE name = ?", &[s(name)])
            .await?;
        Ok(())
    }

    pub async fn group(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let me = self.actor_endpoint(&actor).await?;
        let target_text = params.get("name").map(|n| {
            format!(
                "group:{}",
                n.as_str().map_or_else(|| n.to_string(), str::to_owned)
            )
        });
        self.need_tty(&actor, &me, target_text).await?;
        let action = params.get("action").and_then(Value::as_str).unwrap_or("");
        let world = self.world().await?;
        let me_id = row_id(&me).to_owned();
        if action == "ls" {
            return Ok(self.group_ls(&world, &me));
        }
        if action == "create" {
            return self.group_create(&world, &actor, &me, params).await;
        }
        if !matches!(
            action,
            "add" | "remove" | "rules" | "show" | "drop" | "pin" | "unpin"
        ) {
            return Err(RpcError::invalid_params(
                "action is create, add, remove, rules, ls, show, drop, pin or unpin",
            ));
        }
        let name = group_name(params.get("name"))?;
        let group = world.group_by_name(&name);
        let under_owner = action == "add"
            && group
                .as_ref()
                .is_some_and(|g| world.descendant_of(&me_id, &g.owner));
        let Some(group) = group.filter(|g| world.sees_group(&me_id, g) || under_owner) else {
            return Err(RpcError::new(
                ErrorCode::NotFound,
                format!("no group {name}"),
            ));
        };
        let detail = json!({"by": address(&me), "auth": actor.auth(), "target": format!("group:{name}"), "action": action});
        match action {
            "show" => Ok(group_view(&world, &group, &me)),
            "add" => {
                self.group_add(&world, &actor, &me, &group, params, detail)
                    .await
            }
            "remove" => {
                self.group_remove(&world, &actor, &me, &group, params, detail)
                    .await
            }
            "rules" => {
                self.group_set_rules(&world, &actor, &me, &group, params, detail)
                    .await
            }
            "drop" => self.group_drop(&world, &actor, &me, &group, detail).await,
            _ => self.group_pin(&actor, &me, &group, action, detail).await,
        }
    }

    async fn group_refused(
        &self,
        actor: &Actor,
        me: &Row,
        group: &Group,
        reason: &str,
        message: &str,
    ) -> RpcError {
        self.refused(
            actor,
            me,
            json!({"target": format!("group:{}", group.name), "reason": reason}),
            message,
        )
        .await
    }

    fn group_ls(&self, world: &World, me: &Row) -> Value {
        let me_id = row_id(me);
        let human = text(me, "kind") == Some("human");
        let mut out = Vec::new();
        for group in world.all_groups() {
            if !world.sees_group(me_id, &group) {
                continue;
            }
            out.push(json!({"name": group.name, "owner": owner_name(world, &group.owner), "members": world.members_for(me_id, &group).len(), "pinned": group.pinned, "policy": group.policy}));
            if human
                && group.policy
                && let Some(shadowed) = world.runtime_group(&group.name)
            {
                out.push(json!({"name": shadowed.name, "owner": owner_name(world, &shadowed.owner), "members": world.runtime_members(&shadowed.name).len(), "pinned": shadowed.pinned, "policy": false, "ignored": "a policy group has this name"}));
            }
        }
        json!(out)
    }

    async fn group_create(
        &self,
        world: &World,
        actor: &Actor,
        me: &Row,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let name = group_name(params.get("name"))?;
        if let Some(taken) = world.group_by_name(&name) {
            let owner = if taken.policy {
                "the policy file".to_owned()
            } else {
                Namer::new(world, me)
                    .place(&taken.owner)
                    .as_str()
                    .map_or_else(|| "another endpoint".to_owned(), str::to_owned)
            };
            return Err(RpcError::invalid_params(format!(
                "group {name} is owned by {owner}; pick another name"
            )));
        }
        let rules = self.group_rules(world, me, params, &GroupRules::default(), None)?;
        let now = now_ms();
        let agent = text(me, "kind") == Some("agent");
        let tree = agent.then(|| text(me, "tree").unwrap_or(row_id(me)).to_owned());
        let id = format!("grp_{now:x}{}", &crate::claims::token("g")[2..14]);
        self.store
            .all(
                "INSERT INTO groups (name, owner, tree, rules, pinned, created_at, id) VALUES (?, ?, ?, ?, 0, ?, ?)",
                &[s(&name), s(row_id(me)), crate::views::opt(tree.as_deref()), s(&json!(rules).to_string()), SqlValue::Int(now), s(&id)],
            )
            .await?;
        self.audit("scope_group", Some(row_id(me)), None, json!({"by": address(me), "auth": actor.auth(), "target": format!("group:{name}"), "action": "create", "after": rules}))
            .await?;
        let world = self.world().await?;
        let group = world.group_by_name(&name).ok_or_else(RpcError::internal)?;
        Ok(group_view(&world, &group, me))
    }

    async fn group_add(
        &self,
        world: &World,
        actor: &Actor,
        me: &Row,
        group: &Group,
        params: &Map<String, Value>,
        detail: Value,
    ) -> Result<Value, RpcError> {
        if group.policy {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "policy group",
                    "the policy file sets this group's members",
                )
                .await);
        }
        let target = match optional(params, "endpoint")? {
            None => me.clone(),
            Some(value) => self.scope_target(world, me, &value).await?,
        };
        if text(&target, "kind") != Some("agent") {
            return Err(RpcError::invalid_params("only agent endpoints join groups"));
        }
        let (me_id, id) = (row_id(me), row_id(&target));
        if id != me_id && actor.narrow_only() {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "narrow only",
                    "adding another endpoint to a group needs an authenticated session",
                )
                .await);
        }
        let ok = if id == me_id {
            id == group.owner || world.descendant_of(id, &group.owner)
        } else {
            world.is_human(me_id)
                || (me_id == group.owner && world.descendant_of(id, me_id))
                || world.administers_id(me_id, id)
        };
        if !ok {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "no authority",
                    &format!("no authority to add {} to {}", address(&target), group.name),
                )
                .await);
        }
        self.join(&group.name, id, me_id).await?;
        let mut row = detail.clone();
        row["endpoint"] = json!(address(&target));
        self.audit("scope_group", Some(id), None, row).await?;
        if id != me_id && world.authority(me_id, id) {
            let sel = vec![format!("group:{}", group.name)];
            let lists = HashMap::from([
                (ScopeDirection::In, sel.clone()),
                (ScopeDirection::Out, sel),
            ]);
            let mut row = detail;
            row["via"] = json!(address(me));
            row["target"] = json!(address(&target));
            row["group"] = json!(group.name);
            self.allow_into(me, &target, &lists, row, Some(&group.name))
                .await?;
        }
        Ok(json!({"name": group.name, "endpoint": address(&target), "member": true}))
    }

    /// Whether `me` may loosen the group's caps on every runtime member.
    fn loosens_all(&self, world: &World, me: &Row, group: &Group) -> bool {
        let me_id = row_id(me);
        world.runtime_members(&group.name).iter().all(|row| {
            let id = row_id(row);
            (id == me_id || world.authority(me_id, id))
                && world.may_loosen(
                    me_id,
                    id,
                    &format!("group:{}", group.name),
                    Some(&group.owner),
                )
        })
    }

    async fn group_remove(
        &self,
        world: &World,
        actor: &Actor,
        me: &Row,
        group: &Group,
        params: &Map<String, Value>,
        detail: Value,
    ) -> Result<Value, RpcError> {
        if group.policy {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "policy group",
                    "the policy file sets this group's members",
                )
                .await);
        }
        let me_id = row_id(me);
        let endpoint = optional(params, "endpoint")?;
        let named = match (&endpoint, world.stewards(me_id, group)) {
            (Some(value), true) => self.lookup(value).await.ok(),
            _ => None,
        };
        let target = match named.filter(|r| world.is_member(&group.name, row_id(r))) {
            Some(row) => row,
            None => match &endpoint {
                None => me.clone(),
                Some(value) => self.scope_target(world, me, value).await?,
            },
        };
        let id = row_id(&target);
        if !world.is_member(&group.name, id) {
            return Err(RpcError::new(
                ErrorCode::NotFound,
                format!("{} is not in {}", address(&target), group.name),
            ));
        }
        if group.rules.ruled() {
            if actor.narrow_only() {
                return Err(self.group_refused(actor, me, group, "narrow only", "removing a member lifts the group's caps: it needs an authenticated session").await);
            }
            if !world.authority(me_id, id)
                || !world.may_loosen(
                    me_id,
                    id,
                    &format!("group:{}", group.name),
                    Some(&group.owner),
                )
            {
                return Err(self
                    .group_refused(
                        actor,
                        me,
                        group,
                        "no authority",
                        &format!(
                            "removing {} from {} lifts its caps, which needs widening authority",
                            address(&target),
                            group.name
                        ),
                    )
                    .await);
            }
        } else if id != me_id
            && !world.is_human(me_id)
            && me_id != group.owner
            && !world.authority(me_id, id)
        {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "no authority",
                    &format!("no authority over {}", address(&target)),
                )
                .await);
        }
        self.leave_group(&group.name, id).await?;
        let mut row = detail;
        row["endpoint"] = json!(address(&target));
        self.audit("scope_group", Some(id), None, row).await?;
        Ok(json!({"name": group.name, "endpoint": address(&target), "member": false}))
    }

    async fn group_set_rules(
        &self,
        world: &World,
        actor: &Actor,
        me: &Row,
        group: &Group,
        params: &Map<String, Value>,
        detail: Value,
    ) -> Result<Value, RpcError> {
        if group.policy {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "policy group",
                    "the policy file sets this group's rules",
                )
                .await);
        }
        let me_id = row_id(me);
        if !world.stewards(me_id, group) {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "no authority",
                    &format!(
                        "only the owner, its ancestors, an admin or the human change {}'s rules",
                        group.name
                    ),
                )
                .await);
        }
        let via = if world.is_human(me_id) {
            "human"
        } else {
            me_id
        };
        let rules = self.group_rules(world, me, params, &group.rules, Some(via))?;
        let widened = DIRS.iter().any(|dir| {
            group
                .rules
                .get(*dir)
                .is_some_and(|before| match rules.get(*dir) {
                    None => true,
                    Some(after) => after
                        .iter()
                        .any(|e| !before.iter().any(|b| b.sel == e.sel && b.group == e.group)),
                })
        });
        if widened && actor.narrow_only() {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "narrow only",
                    "loosening a group needs an authenticated session",
                )
                .await);
        }
        if widened && !self.loosens_all(world, me, group) {
            return Err(self.group_refused(actor, me, group, "no authority", &format!("loosening {} lifts caps on its members, which needs widening authority over each", group.name)).await);
        }
        self.store
            .all(
                "UPDATE groups SET rules = ? WHERE name = ?",
                &[s(&json!(rules).to_string()), s(&group.name)],
            )
            .await?;
        let mut row = detail;
        if widened {
            row["via"] = json!(address(me));
        }
        row["before"] = json!(group.rules);
        row["after"] = json!(rules);
        self.audit("scope_group", Some(me_id), None, row).await?;
        let world = self.world().await?;
        let fresh = world
            .group_by_name(&group.name)
            .ok_or_else(RpcError::internal)?;
        Ok(group_view(&world, &fresh, me))
    }

    async fn group_drop(
        &self,
        world: &World,
        actor: &Actor,
        me: &Row,
        group: &Group,
        detail: Value,
    ) -> Result<Value, RpcError> {
        if group.policy {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "policy group",
                    "the policy file defines this group",
                )
                .await);
        }
        if !world.stewards(row_id(me), group) {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "no authority",
                    &format!(
                        "only the owner, its ancestors, an admin or the human drop {}",
                        group.name
                    ),
                )
                .await);
        }
        let ruled = group.rules.ruled();
        if ruled && actor.narrow_only() {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "narrow only",
                    "dropping a group lifts its caps: it needs an authenticated session",
                )
                .await);
        }
        if ruled && !self.loosens_all(world, me, group) {
            return Err(self.group_refused(actor, me, group, "no authority", &format!("dropping {} lifts caps on its members, which needs widening authority over each", group.name)).await);
        }
        self.drop_group(&group.name).await?;
        self.audit("scope_group", Some(row_id(me)), None, detail)
            .await?;
        Ok(json!({"name": group.name, "dropped": true}))
    }

    async fn group_pin(
        &self,
        actor: &Actor,
        me: &Row,
        group: &Group,
        action: &str,
        detail: Value,
    ) -> Result<Value, RpcError> {
        if !actor.at_terminal() {
            return Err(self
                .group_refused(
                    actor,
                    me,
                    group,
                    "human only",
                    "only the human at a terminal pins a group",
                )
                .await);
        }
        if group.policy {
            return Err(RpcError::invalid_params("a policy group is always pinned"));
        }
        self.store
            .all(
                "UPDATE groups SET pinned = ? WHERE name = ?",
                &[SqlValue::Int(i64::from(action == "pin")), s(&group.name)],
            )
            .await?;
        self.audit("scope_group", Some(row_id(me)), None, detail)
            .await?;
        let world = self.world().await?;
        let fresh = world
            .group_by_name(&group.name)
            .ok_or_else(RpcError::internal)?;
        Ok(group_view(&world, &fresh, me))
    }

    /// Admins of a tree or a group: granted and revoked by the human at a terminal; an agent lists its own, a row of a dropped group as stale.
    pub async fn admin(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let me = self.actor_endpoint(&actor).await?;
        let subject_text = params
            .get("subject")
            .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned));
        self.need_tty(&actor, &me, subject_text.clone()).await?;
        let action = params.get("action").and_then(Value::as_str).unwrap_or("");
        let agent = text(&me, "kind") == Some("agent");
        if action == "ls" {
            let rows = if agent {
                self.store.all("SELECT * FROM admins WHERE revoked_at IS NULL AND subject = ? ORDER BY granted_at", &[s(row_id(&me))]).await?
            } else {
                self.store
                    .all(
                        "SELECT * FROM admins WHERE revoked_at IS NULL ORDER BY granted_at",
                        &[],
                    )
                    .await?
            };
            return self.admins_listed(rows).await;
        }
        if action != "grant" && action != "revoke" {
            return Err(RpcError::invalid_params("action is grant, revoke or ls"));
        }
        if !actor.at_terminal() {
            return Err(self
                .refused(
                    &actor,
                    &me,
                    json!({"target": subject_text, "reason": "human only"}),
                    "only the human at a terminal grants or revokes admins",
                )
                .await);
        }
        let subject = self.lookup(&subject_text.unwrap_or_default()).await?;
        if text(&subject, "kind") != Some("agent") {
            return Err(RpcError::invalid_params("an admin is an agent endpoint"));
        }
        let (tree, group) = (optional(params, "tree")?, params.get("group"));
        if tree.is_some() == group.is_some() {
            return Err(RpcError::invalid_params("name a tree or a group"));
        }
        let (kind, scope, scope_id) = if let Some(tree) = tree {
            let root = self.lookup(&tree).await?;
            if text(&root, "kind") != Some("agent") {
                return Err(RpcError::invalid_params(
                    "a tree is named by one of its endpoints",
                ));
            }
            (
                "tree",
                text(&root, "tree").unwrap_or(row_id(&root)).to_owned(),
                None,
            )
        } else {
            let name = group_name(group)?;
            let found = self.world().await?.group_by_name(&name);
            if found.is_none() && action == "grant" {
                return Err(RpcError::new(
                    ErrorCode::NotFound,
                    format!("no group {name}"),
                ));
            }
            ("group", name, found.map(|g| g.id))
        };
        let now = SqlValue::Int(now_ms());
        let held = "subject = ? AND scope_kind = ? AND scope = ? AND revoked_at IS NULL";
        let keys = [s(row_id(&subject)), s(kind), s(&scope)];
        if action == "grant" {
            let mut probe = keys.to_vec();
            probe.push(crate::views::opt(scope_id.as_deref()));
            let active = !self
                .store
                .all(
                    &format!("SELECT 1 FROM admins WHERE {held} AND scope_id IS ?"),
                    &probe,
                )
                .await?
                .is_empty();
            if !active {
                let mut update = vec![now.clone()];
                update.extend(keys.iter().cloned());
                self.store
                    .all(
                        &format!("UPDATE admins SET revoked_at = ? WHERE {held}"),
                        &update,
                    )
                    .await?;
                self.store
                    .all("INSERT INTO admins (subject, scope_kind, scope, scope_id, granted_at) VALUES (?, ?, ?, ?, ?)", &[s(row_id(&subject)), s(kind), s(&scope), crate::views::opt(scope_id.as_deref()), now])
                    .await?;
            }
        } else {
            if self
                .store
                .all(&format!("SELECT 1 FROM admins WHERE {held}"), &keys)
                .await?
                .is_empty()
            {
                return Err(RpcError::new(
                    ErrorCode::NotFound,
                    format!("{} is no admin of that {kind}", address(&subject)),
                ));
            }
            let mut update = vec![now];
            update.extend(keys.iter().cloned());
            self.store
                .all(
                    &format!("UPDATE admins SET revoked_at = ? WHERE {held}"),
                    &update,
                )
                .await?;
        }
        let mut detail = json!({"by": address(&me), "auth": actor.auth(), "target": address(&subject), "action": action});
        if kind == "tree" {
            detail["tree"] = json!(self.address_of(&scope).await?);
        } else {
            detail["group"] = json!(scope);
        }
        self.audit("scope_admin", Some(row_id(&subject)), None, detail)
            .await?;
        let rows = self
            .store
            .all(
                "SELECT * FROM admins WHERE subject = ? AND revoked_at IS NULL ORDER BY granted_at",
                &[s(row_id(&subject))],
            )
            .await?;
        self.admins_listed(rows).await
    }

    async fn admins_listed(&self, rows: Vec<Row>) -> Result<Value, RpcError> {
        let world = self.world().await?;
        let mut out = Vec::new();
        for row in rows {
            let kind = text(&row, "scope_kind").unwrap_or_default();
            let scope = text(&row, "scope").unwrap_or_default();
            let mut item = json!({"subject": self.address_of(text(&row, "subject").unwrap_or_default()).await?, "granted_at": crate::core::integer(&row, "granted_at").and_then(timestamp)});
            if kind == "tree" {
                item["tree"] = json!(self.address_of(scope).await?);
            } else {
                item["group"] = json!(scope);
                let admin = crate::world::Admin {
                    subject: String::new(),
                    scope_kind: kind.into(),
                    scope: scope.into(),
                    scope_id: text(&row, "scope_id").map(str::to_owned),
                };
                if world.stale(&admin) {
                    item["stale"] = json!(true);
                }
            }
            out.push(item);
        }
        Ok(json!(out))
    }

    /// The endpoints one `to` address of a send reaches: a group's members or the sender's children within its scope, or one endpoint it may message.
    pub async fn send_targets(
        &self,
        sender_id: &str,
        value: &str,
        conn: ConnectionId,
    ) -> Result<Vec<Row>, RpcError> {
        let tty = !matches!(self.connection(conn)?.mode, Mode::Human { tty: false });
        self.send_targets_as(sender_id, value, tty).await
    }

    /// the recipients `value` names for `sender_id` under the current scope rules; `tty` is whether a human sender has a terminal
    pub async fn send_targets_as(
        &self,
        sender_id: &str,
        value: &str,
        tty: bool,
    ) -> Result<Vec<Row>, RpcError> {
        let sender = self.must_endpoint(sender_id).await?;
        let trimmed = value.trim();
        if trimmed.starts_with("group:") || trimmed == "tree:children" {
            return self.expand(&sender, trimmed).await;
        }
        let row = self.lookup(value).await?;
        let unverified = text(&sender, "kind") == Some("human") && !tty;
        self.check_scope(&sender, &row, trimmed, None, unverified)
            .await?;
        Ok(vec![row])
    }

    async fn expand(&self, sender: &Row, value: &str) -> Result<Vec<Row>, RpcError> {
        let world = self.world().await?;
        let sender_id = row_id(sender);
        let members: Vec<Row> = if value == "tree:children" {
            let mut rows: Vec<Row> = world
                .agents()
                .filter(|r| text(r, "parent_ep") == Some(sender_id))
                .cloned()
                .collect();
            rows.sort_by_key(|r| text(r, "handle").unwrap_or_default().to_owned());
            rows
        } else {
            let name = &value["group:".len()..];
            let group = valid_group_name(name)
                .then(|| world.group_by_name(name))
                .flatten();
            match group {
                Some(group)
                    if text(sender, "kind") == Some("agent")
                        && world.groups_of(sender_id).contains(&group.name) =>
                {
                    world.group_members(&group).into_iter().cloned().collect()
                }
                _ => return Err(not_found(value)),
            }
        };
        let reached: Vec<Row> = members
            .into_iter()
            .filter(|row| {
                row_id(row) != sender_id
                    && world
                        .refusal(sender_id, row_id(row), false, false)
                        .is_none()
            })
            .collect();
        if reached.is_empty() {
            return Err(not_found(value));
        }
        if reached.len() > FAN_OUT_MAX {
            return Err(RpcError::new(
                ErrorCode::TooLarge,
                format!(
                    "{value} reaches {} endpoints, more than {FAN_OUT_MAX}",
                    reached.len()
                ),
            ));
        }
        Ok(reached)
    }

    /// A placed claim's own rules, bound to the groups named now, with its grant's caps and groups and the policy's child default.
    pub async fn place_scope(
        &self,
        row: &Row,
        parent: Option<&Row>,
        grant: Option<&Row>,
        depth: i64,
        rules: &Value,
    ) -> Result<(), RpcError> {
        let world = self.world().await?;
        let id = row_id(row).to_owned();
        let mut caps = ScopeCaps::default();
        if let Some(grant) = grant {
            caps.caps.extend(grant_caps(grant));
        }
        let own: ScopeRules = serde_json::from_value(rules.clone()).unwrap_or_default();
        let mut bound = ScopeRules::default();
        for dir in DIRS {
            if let Some(list) = rule_get(&own, dir) {
                set_rule(&world, &mut bound, dir, Some(list.clone()));
            }
        }
        let child = world.defaults.child_default.clone();
        if parent.is_some()
            && caps.caps.is_empty()
            && let Ok(preset) = child.parse::<ScopePreset>()
            && let Some(list) = preset_lists(preset)
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
        caps.caps.extend(caps_of(row).caps);
        let tree = parent.map(|p| text(p, "tree").unwrap_or(row_id(p)).to_owned());
        self.store
            .all(
                "UPDATE endpoints SET tree = ?, parent_ep = ?, parent_addr = NULL, depth = ?, rules = ?, caps = ? WHERE id = ?",
                &[crate::views::opt(tree.as_deref()), crate::views::opt(parent.map(row_id)), SqlValue::Int(depth), rules_json(&bound), caps_json(&mut caps), s(&id)],
            )
            .await?;
        let world = self.world().await?;
        let placed = world.row(&id).cloned().ok_or_else(RpcError::internal)?;
        for dir in DIRS {
            if let Some(list) = rule_get(&own, dir) {
                self.need_groups(&world, &placed, list, false)?;
            }
        }
        if let Some(grant) = grant {
            self.join_grant(grant, &id).await?;
        }
        Ok(())
    }

    /// The grant's groups, each while it is still the group it was issued for, with the issuer's membership allowance when it could widen.
    pub(crate) async fn join_grant(&self, grant: &Row, endpoint: &str) -> Result<(), RpcError> {
        let entries: Vec<Value> = text(grant, "groups")
            .and_then(|v| serde_json::from_str(v).ok())
            .unwrap_or_default();
        let issuer = text(grant, "issuer").unwrap_or_default().to_owned();
        for entry in entries {
            let world = self.world().await?;
            let Some(group) = entry["name"].as_str().and_then(|n| world.group_by_name(n)) else {
                continue;
            };
            if group.policy || Some(group.id.as_str()) != entry["id"].as_str() {
                continue;
            }
            self.join(&group.name, endpoint, &issuer).await?;
            let world = self.world().await?;
            let (Some(by), Some(target)) =
                (world.row(&issuer).cloned(), world.row(endpoint).cloned())
            else {
                continue;
            };
            if entry["allow"] == Value::Bool(true)
                && !crate::world::is_gone(&by)
                && world.authority(&issuer, endpoint)
            {
                let sel = vec![format!("group:{}", group.name)];
                let lists = HashMap::from([
                    (ScopeDirection::In, sel.clone()),
                    (ScopeDirection::Out, sel),
                ]);
                let detail = json!({"by": address(&by), "auth": "grant", "via": address(&by), "target": address(&target), "group": group.name});
                self.allow_into(&by, &target, &lists, detail, Some(&group.name))
                    .await?;
            }
        }
        Ok(())
    }

    /// A grant's caps by its issuer and its groups, each checked as the actor may name and add to it.
    pub async fn grant_scope(
        &self,
        actor: &Actor,
        me: &Row,
        params: &Map<String, Value>,
    ) -> Result<(Value, Value), RpcError> {
        let world = self.world().await?;
        let expanded = crate::rules::expand(
            &crate::rules::rule_params(params)?,
            world.defaults.symmetric,
        )?;
        let mut caps = Vec::new();
        for dir in DIRS {
            if let Some(Some(sels)) = expanded.get(&dir) {
                self.need_groups(&world, me, sels, false)?;
                caps.push(json!({"dir": dir, "sels": sels.iter().map(|sel| world.entry(sel, None)).collect::<Vec<_>>()}));
            }
        }
        if actor.narrow_only()
            && let Ok(preset) = world.defaults.child_default.parse::<ScopePreset>()
            && let Some(list) = preset_lists(preset)
        {
            for dir in world.defaults.preset_dirs() {
                caps.push(json!({"dir": dir, "sels": list.iter().map(|sel| json!({"sel": sel})).collect::<Vec<_>>()}));
            }
        }
        let me_id = row_id(me);
        let mut groups = Vec::new();
        for name in group_names(params.get("groups"), "groups")? {
            let group = world
                .group_by_name(&name)
                .filter(|g| !g.policy && world.sees_group(me_id, g))
                .ok_or_else(|| RpcError::new(ErrorCode::NotFound, format!("no group {name}")))?;
            if world.is_agent(me_id) && group.owner != me_id && !world.admin_of_group(me_id, &group)
            {
                return Err(self
                    .refused(
                        actor,
                        me,
                        json!({"target": format!("group:{name}"), "reason": "not the owner"}),
                        &format!("only the owner adds to group {name}"),
                    )
                    .await);
            }
            let mut entry = json!({"name": group.name, "id": group.id});
            if !actor.narrow_only() {
                entry["allow"] = json!(true);
            }
            groups.push(entry);
        }
        Ok((json!(caps), json!(groups)))
    }

    /// The send guards that run before the write: the fan-out cap and the policy, each refusal audited.
    pub async fn send_guards(&self, sender: &Row, targets: &[Row]) -> Result<(), RpcError> {
        if targets.len() > FAN_OUT_TOTAL {
            return Err(RpcError::new(
                ErrorCode::TooLarge,
                format!(
                    "the send reaches {} endpoints, more than {FAN_OUT_TOTAL}",
                    targets.len()
                ),
            ));
        }
        if self.policy.is_none() {
            return Ok(());
        }
        let world = self.world().await?;
        for target in targets {
            if let Some(refusal) = world.policy_refusal(row_id(sender), row_id(target)) {
                let to = address(target);
                let message = format!("{refusal} ({to})");
                self.audit(
                    "refuse",
                    Some(row_id(sender)),
                    None,
                    json!({"code": "policy_refused", "message": message, "to": [to]}),
                )
                .await?;
                return Err(RpcError::new(ErrorCode::PolicyRefused, message));
            }
        }
        Ok(())
    }
}
