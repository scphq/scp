use std::collections::{HashMap, HashSet};

use scp_core::protocol::{CLI_NAME, ScopeCap, ScopeDirection, ScopeEntry, ScopePreset};
use scp_core::scope::{
    ExpandRulesParams, ExpandedRules, ScopeCaps, ScopeNode, ScopeRules, clipped, expand_rules,
    group_cap_key, narrower, preset_of,
};
use serde_json::{Map, Value, json};

use crate::authority::Actor;
use crate::core::{Core, integer, text};
use crate::policy::{preset, valid_selector};
use crate::proto::{ErrorCode, RpcError};
use crate::state::ConnectionId;
use crate::store::{Row, SqlValue};
use crate::views::{address, not_found};
use crate::world::{World, caps_of, rules_of};

const RESERVED_WORDS: [&str; 12] = [
    "open",
    "none",
    "tree",
    "parent",
    "self",
    "root",
    "children",
    "descendants",
    "ancestors",
    "siblings",
    "human",
    "me",
];
pub const DIRS: [ScopeDirection; 2] = [ScopeDirection::In, ScopeDirection::Out];

/// A selector list, a bare handle standing for `ep:<handle>`.
pub fn selector_list(
    value: &Value,
    field: &str,
    group_rules: bool,
) -> Result<Vec<String>, RpcError> {
    let values = value
        .as_array()
        .filter(|values| values.len() <= 64)
        .ok_or_else(|| {
            RpcError::invalid_params(format!("{field} is a list of at most 64 selectors"))
        })?;
    values
        .iter()
        .map(|value| {
            if let Some(word) = value.as_str().filter(|w| RESERVED_WORDS.contains(w)) {
                let scope = if word == "self" { "tree" } else { word };
                let relation = if word == "tree" { "self" } else { word };
                return Err(RpcError::invalid_params(format!(
                    "{field}: \"{word}\" is a scope word, not a handle: use --scope {scope} or tree:{relation}, or ep:{word} for an endpoint named {word}"
                )));
            }
            value
                .as_str()
                .map(|v| {
                    if !v.contains(':') && crate::claims::valid_handle(v) {
                        format!("ep:{v}")
                    } else {
                        v.to_owned()
                    }
                })
                .filter(|v| valid_selector(v, false, group_rules))
                .ok_or_else(|| RpcError::invalid_params(format!("{field}: {value} is not a selector")))
        })
        .collect()
}

pub fn rule_params(params: &Map<String, Value>) -> Result<ExpandRulesParams, RpcError> {
    let scope = params
        .get("scope")
        .map(|v| {
            v.as_str()
                .and_then(|v| v.parse::<ScopePreset>().ok())
                .ok_or_else(|| RpcError::invalid_params("scope is one of open, tree, parent, none"))
        })
        .transpose()?;
    let list = |key: &str| {
        params
            .get(key)
            .filter(|v| !v.is_null())
            .map(|v| selector_list(v, key, false))
            .transpose()
    };
    Ok(ExpandRulesParams {
        scope,
        allow: list("allow")?,
        r#in: list("in")?,
        out: list("out")?,
    })
}

pub fn expand(params: &ExpandRulesParams, symmetric: bool) -> Result<ExpandedRules, RpcError> {
    expand_rules(params, symmetric).map_err(|e| RpcError::invalid_params(e.message))
}

pub fn optional(params: &Map<String, Value>, key: &str) -> Result<Option<String>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(v)) => Ok(Some(v.clone())),
        Some(_) => Err(RpcError::invalid_params(format!("{key} must be a string"))),
    }
}

pub fn required(params: &Map<String, Value>, key: &str) -> Result<String, RpcError> {
    optional(params, key)?.ok_or_else(|| RpcError::invalid_params(format!("{key} is required")))
}

pub fn rule_get(rules: &ScopeRules, dir: ScopeDirection) -> Option<&Vec<String>> {
    match dir {
        ScopeDirection::In => rules.r#in.as_ref(),
        ScopeDirection::Out => rules.out.as_ref(),
    }
}

fn rule_slot(rules: &mut ScopeRules, dir: ScopeDirection) -> &mut Option<Vec<String>> {
    match dir {
        ScopeDirection::In => &mut rules.r#in,
        ScopeDirection::Out => &mut rules.out,
    }
}

/// Whether setting `next` as own rules in `dir` rebinds a kept `group:` selector to another group.
fn rebinds_rule(
    world: &World,
    rules: &ScopeRules,
    dir: ScopeDirection,
    next: Option<&Vec<String>>,
) -> bool {
    let before = rules.groups.as_ref().and_then(|g| g.get(&dir));
    next.into_iter().flatten().any(|sel| {
        rule_get(rules, dir).is_some_and(|r| r.contains(sel))
            && world
                .entry(sel, None)
                .group
                .or_else(|| before.and_then(|b| b.get(sel)).cloned())
                != before.and_then(|b| b.get(sel)).cloned()
    })
}

/// Sets own rules in `dir` to `next` (None clears them): a group selector binds to the group of that name now, or keeps its binding.
pub fn set_rule(
    world: &World,
    rules: &mut ScopeRules,
    dir: ScopeDirection,
    next: Option<Vec<String>>,
) {
    let before = rules
        .groups
        .as_ref()
        .and_then(|g| g.get(&dir))
        .cloned()
        .unwrap_or_default();
    let mut bound = HashMap::new();
    for sel in next.iter().flatten() {
        let kept = rule_get(rules, dir)
            .is_some_and(|r| r.contains(sel))
            .then(|| before.get(sel).cloned())
            .flatten();
        if let Some(id) = world.entry(sel, None).group.or(kept) {
            bound.insert(sel.clone(), id);
        }
    }
    *rule_slot(rules, dir) = next;
    let mut groups = rules.groups.take().unwrap_or_default();
    if bound.is_empty() {
        groups.remove(&dir);
    } else {
        groups.insert(dir, bound);
    }
    rules.groups = (!groups.is_empty()).then_some(groups);
}

pub fn rules_json(rules: &ScopeRules) -> SqlValue {
    if rules.r#in.is_none() && rules.out.is_none() && rules.groups.is_none() {
        SqlValue::Null
    } else {
        SqlValue::Text(json!(rules).to_string())
    }
}

pub fn caps_json(caps: &mut ScopeCaps) -> SqlValue {
    caps.allow.retain(|_, entries| !entries.is_empty());
    if caps.caps.is_empty()
        && caps.allow.is_empty()
        && caps.lifted.as_ref().is_none_or(Vec::is_empty)
    {
        SqlValue::Null
    } else {
        SqlValue::Text(json!(caps).to_string())
    }
}

pub fn cap_id() -> String {
    crate::claims::token("cap").chars().take(20).collect()
}

/// Endpoint ids as `viewer` may read them: an agent viewer that does not see an id reads it as an ancestor or admin.
pub struct Namer<'a> {
    world: &'a World,
    viewer: String,
    shown: HashSet<String>,
}

impl<'a> Namer<'a> {
    pub fn new(world: &'a World, viewer: &Row) -> Self {
        let shown = if text(viewer, "kind") == Some("agent") {
            world.visible(viewer)
        } else {
            HashSet::new()
        };
        Self {
            world,
            viewer: text(viewer, "id").unwrap_or_default().to_owned(),
            shown,
        }
    }
    fn hides(&self, id: &str) -> bool {
        self.world.hides(&self.viewer, &self.shown, id)
    }
    pub fn address(&self, id: &str) -> String {
        self.world.row(id).map_or_else(|| id.to_owned(), address)
    }
    pub fn name(&self, id: &str) -> String {
        if id == "human" || id == "policy" {
            id.to_owned()
        } else if self.hides(id) {
            World::hidden().to_owned()
        } else {
            self.address(id)
        }
    }
    pub fn place(&self, id: &str) -> Value {
        if self.hides(id) {
            Value::Null
        } else {
            json!(self.address(id))
        }
    }
    pub fn entries(&self, list: &[ScopeEntry]) -> Value {
        json!(
            list.iter()
                .map(|e| match &e.via {
                    Some(via) => json!({"sel": e.sel, "via": self.name(via)}),
                    None => json!({"sel": e.sel}),
                })
                .collect::<Vec<_>>()
        )
    }
}

fn row_id(row: &Row) -> &str {
    text(row, "id").unwrap_or_default()
}

fn opposite(dir: ScopeDirection) -> ScopeDirection {
    match dir {
        ScopeDirection::In => ScopeDirection::Out,
        ScopeDirection::Out => ScopeDirection::In,
    }
}

#[derive(Default)]
pub struct Change {
    pub added: Vec<String>,
    pub clipped: Vec<String>,
    pub mirrored: Vec<Value>,
    pub refused: Vec<Value>,
}

impl Change {
    fn view(&self) -> Value {
        let mut out = json!({"added": self.added, "clipped": self.clipped});
        if !self.mirrored.is_empty() {
            out["mirrored"] = json!(self.mirrored);
        }
        if !self.refused.is_empty() {
            out["refused"] = json!(self.refused);
        }
        out
    }
}

impl Core {
    pub fn scope_view_of(&self, world: &World, row: &Row, viewer: &Row) -> Result<Value, RpcError> {
        let node = world.node_of(row_id(row)).ok_or_else(RpcError::internal)?;
        let namer = Namer::new(world, viewer);
        let mut caps: Vec<Value> = node
            .caps
            .caps
            .iter()
            .map(|cap| {
                let by = if cap.by == "inherited" {
                    format!(
                        "inherited from {}",
                        namer.name(
                            cap.sels
                                .first()
                                .and_then(|e| e.via.as_deref())
                                .unwrap_or("")
                        )
                    )
                } else {
                    namer.name(&cap.by)
                };
                json!({"id": cap.id, "dir": cap.dir, "by": by, "sels": namer.entries(&cap.sels)})
            })
            .collect();
        for group in &node.groups {
            for dir in DIRS {
                let rules = match dir {
                    ScopeDirection::In => &group.r#in,
                    ScopeDirection::Out => &group.out,
                };
                if let Some(rules) = rules {
                    let key = group_cap_key(&group.name, dir);
                    let mut sels = rules.clone();
                    sels.extend(node.caps.allow.get(&key).cloned().unwrap_or_default());
                    caps.push(json!({"id": key, "dir": dir, "by": format!("group:{}", group.name), "sels": namer.entries(&sels)}));
                }
            }
        }
        for cap in &node.policy {
            caps.push(json!({"id": format!("policy:{}:{}", cap.r#match, cap.dir), "dir": cap.dir, "by": "policy", "sels": namer.entries(&cap.sels)}));
        }
        let mut rules = json!({});
        for dir in DIRS {
            if let Some(list) = rule_get(&node.rules, dir) {
                rules[dir.as_str()] = json!(list);
            }
        }
        let id = row_id(row);
        Ok(json!({
            "address": address(row),
            "tree": namer.place(text(row, "tree").unwrap_or(id)),
            "parent": text(row, "parent_ep").map_or(Value::Null, |p| namer.place(p)),
            "depth": integer(row, "depth").unwrap_or(0),
            "rules": rules,
            "caps": caps,
            "groups": world.groups_of(id),
            "preset": preset_of(node, world.defaults.symmetric),
        }))
    }

    /// An agent endpoint the actor finds by address: itself, one it has authority over, or one it may message; else not_found.
    pub async fn scope_target(
        &self,
        world: &World,
        me: &Row,
        value: &str,
    ) -> Result<Row, RpcError> {
        let row = self.lookup(value).await?;
        if text(&row, "kind") != Some("agent")
            || (text(me, "kind") == Some("agent") && !world.discovers(row_id(me), row_id(&row)))
        {
            return Err(not_found(value));
        }
        Ok(row)
    }

    /// Refuses a `group:<name>` naming no group `me` may name; a group elsewhere answers as no group.
    pub fn need_groups(
        &self,
        world: &World,
        me: &Row,
        sels: &[String],
        group_rules: bool,
    ) -> Result<(), RpcError> {
        for sel in sels {
            let Some(name) = sel.strip_prefix("group:") else {
                continue;
            };
            if group_rules && name == "self" {
                continue;
            }
            if !world.nameable(row_id(me), name) {
                return Err(RpcError::invalid_params(format!("no group {name}")));
            }
        }
        Ok(())
    }

    pub async fn scope_view(
        &self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let me = self.actor_endpoint(&actor).await?;
        let endpoint = optional(params, "endpoint")?;
        let agent = text(&me, "kind") == Some("agent");
        let Some(value) = endpoint.as_deref() else {
            if !agent {
                return Err(RpcError::invalid_params(
                    "the human has no scope; name an endpoint",
                ));
            }
            let world = self.world().await?;
            return self.scope_view_of(&world, &me, &me);
        };
        let target = self.lookup(value).await?;
        let world = self.world().await?;
        let (me_id, id) = (row_id(&me), row_id(&target));
        let hidden = if agent {
            id != me_id && !world.authority(me_id, id)
        } else {
            !actor.at_terminal() && !world.may_message(me_id, id, true, false)
        };
        if text(&target, "kind") != Some("agent") || hidden {
            return Err(not_found(value));
        }
        self.scope_view_of(&world, &target, &me)
    }

    /// Own rules per direction without an endpoint (a plain shell may only tighten them); with one, the actor's cap on it.
    pub async fn rules_set(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let me = self.actor_endpoint(&actor).await?;
        let endpoint = optional(params, "endpoint")?;
        self.need_tty(&actor, &me, endpoint.clone()).await?;
        let world = self.world().await?;
        let changes = expand(&rule_params(params)?, world.defaults.symmetric)?;
        let dirs: Vec<ScopeDirection> = DIRS
            .into_iter()
            .filter(|d| changes.contains_key(d))
            .collect();
        if dirs.is_empty() {
            return Err(RpcError::invalid_params("set in, out, scope or allow"));
        }
        let target = match endpoint.as_deref() {
            None => me.clone(),
            Some(value) => self.scope_target(&world, &me, value).await?,
        };
        for list in changes.values().flatten() {
            self.need_groups(&world, &me, list, false)?;
        }
        let me_id = row_id(&me).to_owned();
        let detail = |target: &Row| json!({"by": address(&me), "auth": actor.auth(), "target": address(target)});
        if row_id(&target) == me_id {
            if text(&me, "kind") != Some("agent") {
                return Err(RpcError::invalid_params(
                    "the human has no rules of its own; name an endpoint",
                ));
            }
            let mut rules = rules_of(&me);
            let wider: Vec<ScopeDirection> = dirs
                .iter()
                .copied()
                .filter(|dir| {
                    let next = changes[dir].as_ref();
                    !narrower(
                        next.map(Vec::as_slice),
                        rule_get(&rules, *dir).map(Vec::as_slice),
                    ) || rebinds_rule(&world, &rules, *dir, next)
                })
                .collect();
            if let Some(dir) = wider.first()
                && actor.narrow_only()
            {
                return Err(self
                    .refused(
                        &actor,
                        &me,
                        json!({"target": address(&me), "dir": dir, "reason": "narrow only"}),
                        "this connection may only tighten the rules",
                    )
                    .await);
            }
            for dir in &dirs {
                let before = rule_get(&rules, *dir).cloned();
                let next = changes[dir].clone();
                set_rule(&world, &mut rules, *dir, next.clone());
                let mut row = detail(&me);
                row["dir"] = json!(dir);
                row["before"] = json!(before);
                row["after"] = json!(next);
                let event = if wider.contains(dir) {
                    "scope_widen"
                } else {
                    "scope_narrow"
                };
                self.audit(event, Some(&me_id), None, row).await?;
            }
            self.store
                .all(
                    "UPDATE endpoints SET rules = ? WHERE id = ?",
                    &[rules_json(&rules), SqlValue::Text(me_id.clone())],
                )
                .await?;
            let world = self.world().await?;
            let fresh = world.row(&me_id).cloned().ok_or_else(RpcError::internal)?;
            return self.scope_view_of(&world, &fresh, &me);
        }
        let target_id = row_id(&target).to_owned();
        if !world.authority(&me_id, &target_id) {
            return Err(self
                .refused(
                    &actor,
                    &me,
                    json!({"target": address(&target), "reason": "no authority"}),
                    &format!("no authority over {}", address(&target)),
                )
                .await);
        }
        let mut caps = caps_of(&target);
        let by = if text(&me, "kind") == Some("human") {
            "human".to_owned()
        } else {
            me_id.clone()
        };
        let widens = |caps: &ScopeCaps, dir: ScopeDirection| {
            caps.caps
                .iter()
                .find(|c| c.dir == dir && c.by == by)
                .is_some_and(|cap| match &changes[&dir] {
                    None => true,
                    Some(next) => next.iter().any(|sel| {
                        !cap.sels
                            .iter()
                            .any(|e| &e.sel == sel && world.rebound(e) == *e)
                    }),
                })
        };
        if actor.narrow_only() && dirs.iter().any(|d| widens(&caps, *d)) {
            return Err(self
                .refused(
                    &actor,
                    &me,
                    json!({"target": address(&target), "reason": "narrow only"}),
                    "this connection may only narrow",
                )
                .await);
        }
        for dir in &dirs {
            let at = caps.caps.iter().position(|c| c.dir == *dir && c.by == by);
            let next = changes[dir].clone();
            let mut row = detail(&target);
            row["dir"] = json!(dir);
            match (next, at) {
                (None, None) => continue,
                (None, Some(at)) => {
                    let cap = caps.caps.remove(at);
                    row["before"] = json!(cap.sels.iter().map(|e| &e.sel).collect::<Vec<_>>());
                    row["after"] = Value::Null;
                    self.audit("scope_lift", Some(&target_id), None, row)
                        .await?;
                }
                (Some(next), None) => {
                    caps.caps.push(ScopeCap {
                        id: cap_id(),
                        dir: *dir,
                        by: by.clone(),
                        sels: next.iter().map(|s| world.entry(s, None)).collect(),
                    });
                    row["before"] = Value::Null;
                    row["after"] = json!(next);
                    self.audit("scope_narrow", Some(&target_id), None, row)
                        .await?;
                }
                (Some(next), Some(at)) => {
                    let cap = &mut caps.caps[at];
                    let before: Vec<String> = cap.sels.iter().map(|e| e.sel.clone()).collect();
                    let added: Vec<&String> = next.iter().filter(|s| !before.contains(s)).collect();
                    cap.sels = next
                        .iter()
                        .map(|sel| match cap.sels.iter().find(|e| &e.sel == sel) {
                            Some(e) => world.rebound(e),
                            None => world.entry(sel, Some(&by)),
                        })
                        .collect();
                    if !added.is_empty() {
                        row["via"] = json!(address(&me));
                        row["added"] = json!(added);
                    }
                    row["before"] = json!(before);
                    row["after"] = json!(next);
                    self.audit(
                        if added.is_empty() {
                            "scope_narrow"
                        } else {
                            "scope_widen"
                        },
                        Some(&target_id),
                        None,
                        row,
                    )
                    .await?;
                }
            }
        }
        self.store
            .all(
                "UPDATE endpoints SET caps = ? WHERE id = ?",
                &[caps_json(&mut caps), SqlValue::Text(target_id.clone())],
            )
            .await?;
        let world = self.world().await?;
        let fresh = world
            .row(&target_id)
            .cloned()
            .ok_or_else(RpcError::internal)?;
        self.scope_view_of(&world, &fresh, &me)
    }

    /// An allowance for `endpoint` in each cap of the direction the actor may loosen, stored via the actor and clipped to its reach.
    pub async fn rules_widen(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let me = self.actor_endpoint(&actor).await?;
        let endpoint = optional(params, "endpoint")?;
        self.need_tty(&actor, &me, endpoint.clone()).await?;
        let mut picked = Map::new();
        for key in ["in", "out"] {
            if let Some(v) = params.get(key) {
                picked.insert(key.into(), v.clone());
            }
        }
        let lists = rule_params(&picked)?;
        let lists: HashMap<ScopeDirection, Vec<String>> = [
            (ScopeDirection::In, lists.r#in),
            (ScopeDirection::Out, lists.out),
        ]
        .into_iter()
        .filter_map(|(d, l)| l.filter(|l| !l.is_empty()).map(|l| (d, l)))
        .collect();
        if lists.is_empty() {
            return Err(RpcError::invalid_params("widen takes in or out selectors"));
        }
        let endpoint = endpoint.ok_or_else(|| RpcError::invalid_params("endpoint is required"))?;
        let world = self.world().await?;
        let target = self.scope_target(&world, &me, &endpoint).await?;
        let all: Vec<String> = lists.values().flatten().cloned().collect();
        self.need_groups(&world, &me, &all, false)?;
        let detail = json!({"target": address(&target)});
        if actor.narrow_only() {
            return Err(self
                .refused(
                    &actor,
                    &me,
                    json!({"target": address(&target), "reason": "narrow only"}),
                    "widening needs an authenticated session",
                )
                .await);
        }
        if !world.authority(row_id(&me), row_id(&target)) {
            return Err(self
                .refused(
                    &actor,
                    &me,
                    json!({"target": address(&target), "reason": "no authority"}),
                    &format!("no authority over {}", address(&target)),
                )
                .await);
        }
        let mut row = json!({"by": address(&me), "auth": actor.auth(), "via": address(&me)});
        row["target"] = detail["target"].clone();
        let mut change = self.allow_into(&me, &target, &lists, row, None).await?;
        if change.added.is_empty() {
            return Err(self.refused(&actor, &me, json!({"target": address(&target), "clipped": change.clipped, "reason": "clipped"}), &format!("nothing to widen: {} clipped to what {} reaches, or no cap it may loosen", change.clipped.join(", "), address(&me))).await);
        }
        self.widen_back(&actor, &me, &target, &lists, &mut change)
            .await?;
        Ok(change.view())
    }

    async fn widen_back(
        &self,
        actor: &Actor,
        me: &Row,
        target: &Row,
        lists: &HashMap<ScopeDirection, Vec<String>>,
        change: &mut Change,
    ) -> Result<(), RpcError> {
        for dir in [ScopeDirection::Out, ScopeDirection::In] {
            let other = opposite(dir);
            for sel in lists.get(&dir).into_iter().flatten() {
                let Some(handle) = sel.strip_prefix("ep:") else {
                    continue;
                };
                if !change.added.contains(sel) {
                    continue;
                }
                let back = format!("ep:{}", text(target, "handle").unwrap_or_default());
                let fix =
                    |address: &str| format!("{CLI_NAME} rules widen {address} --{other} {back}");
                let world = self.world().await?;
                let peer = world.by_handle(handle).cloned();
                if peer.as_ref().is_some_and(|p| row_id(p) == row_id(target)) {
                    continue;
                }
                let Some(peer) = peer.filter(|p| {
                    text(p, "kind") == Some("agent")
                        && (text(me, "kind") != Some("agent")
                            || world.discovers(row_id(me), row_id(p)))
                }) else {
                    let address = format!("me/{handle}");
                    change.refused.push(json!({"endpoint": address, "dir": other, "fix": fix(&address), "unseen": true}));
                    continue;
                };
                let peer_id = row_id(&peer).to_owned();
                let (from, to) = if dir == ScopeDirection::Out {
                    (row_id(target).to_owned(), peer_id.clone())
                } else {
                    (peer_id.clone(), row_id(target).to_owned())
                };
                let refuses = |world: &World| {
                    let decision = world.decide(&from, &to, false, false, false);
                    !decision.allowed && decision.dir == Some(other)
                };
                if !refuses(&world) {
                    continue;
                }
                if world.authority(row_id(me), &peer_id) {
                    let lists = HashMap::from([(other, vec![back.clone()])]);
                    let row = json!({"by": address(me), "auth": actor.auth(), "via": address(me), "target": address(&peer), "mirror": address(target)});
                    let added = self.allow_into(me, &peer, &lists, row, None).await?.added;
                    if !added.is_empty() {
                        change.mirrored.push(
                            json!({"endpoint": address(&peer), "dir": other, "added": added}),
                        );
                    }
                    if !refuses(&self.world().await?) {
                        continue;
                    }
                }
                change.refused.push(
                    json!({"endpoint": address(&peer), "dir": other, "fix": fix(&address(&peer))}),
                );
            }
        }
        Ok(())
    }

    /// Puts `lists` into each cap of `target`'s that `me` may loosen, via `me`; with `member`, the allowance a membership of that group gives.
    pub async fn allow_into(
        &self,
        me: &Row,
        target: &Row,
        lists: &HashMap<ScopeDirection, Vec<String>>,
        detail: Value,
        member: Option<&str>,
    ) -> Result<Change, RpcError> {
        let world = self.world().await?;
        let (me_id, target_id) = (row_id(me), row_id(target));
        let node = world
            .node_of(target_id)
            .cloned()
            .ok_or_else(RpcError::internal)?;
        let candidates: Vec<ScopeNode> = if member.is_none() {
            world
                .agents()
                .filter_map(|r| world.node_of(row_id(r)).cloned())
                .collect()
        } else {
            Vec::new()
        };
        let via = if text(me, "kind") == Some("human") {
            "human".to_owned()
        } else {
            me_id.to_owned()
        };
        let mut caps = caps_of(target);
        let mut change = Change::default();
        let mut audits = Vec::new();
        for dir in DIRS {
            let Some(sels) = lists.get(&dir).filter(|l| !l.is_empty()) else {
                continue;
            };
            let stored: Vec<usize> = (0..caps.caps.len())
                .filter(|i| {
                    caps.caps[*i].dir == dir
                        && world.may_loosen(me_id, target_id, &caps.caps[*i].by, None)
                })
                .collect();
            let groups: Vec<String> = node
                .groups
                .iter()
                .filter(|g| {
                    let rules = if dir == ScopeDirection::In {
                        &g.r#in
                    } else {
                        &g.out
                    };
                    rules.is_some()
                        && Some(g.name.as_str()) != member
                        && world.may_loosen(
                            me_id,
                            target_id,
                            &format!("group:{}", g.name),
                            Some(&g.owner),
                        )
                })
                .map(|g| g.name.clone())
                .collect();
            let inherited: Vec<String> = if node
                .caps
                .caps
                .iter()
                .any(|c| c.dir == dir && c.by == "inherited")
            {
                vec![format!("inherited:{dir}")]
            } else {
                Vec::new()
            };
            let keys: Vec<String> = groups
                .iter()
                .map(|g| group_cap_key(g, dir))
                .chain(inherited.iter().cloned())
                .collect();
            let snapshot = |caps: &ScopeCaps| {
                let mut out = Map::new();
                for i in &stored {
                    out.insert(
                        caps.caps[*i].id.clone(),
                        json!(
                            caps.caps[*i]
                                .sels
                                .iter()
                                .map(|e| &e.sel)
                                .collect::<Vec<_>>()
                        ),
                    );
                }
                for g in &node.groups {
                    if groups.contains(&g.name) {
                        let key = group_cap_key(&g.name, dir);
                        let rules = if dir == ScopeDirection::In {
                            &g.r#in
                        } else {
                            &g.out
                        };
                        let sels: Vec<&String> = rules
                            .iter()
                            .flatten()
                            .chain(caps.allow.get(&key).into_iter().flatten())
                            .map(|e| &e.sel)
                            .collect();
                        out.insert(key, json!(sels));
                    }
                }
                for key in &inherited {
                    let mut sels = vec!["*".to_owned()];
                    sels.extend(
                        caps.allow
                            .get(key)
                            .into_iter()
                            .flatten()
                            .map(|e| e.sel.clone()),
                    );
                    out.insert(key.clone(), json!(sels));
                }
                Value::Object(out)
            };
            let before = snapshot(&caps);
            let (mut added, mut cut) = (Vec::new(), Vec::new());
            for sel in sels {
                if (stored.is_empty() && keys.is_empty())
                    || (via != "human" && clipped(&world, &via, sel, &node, dir, &candidates))
                {
                    cut.push(sel.clone());
                } else {
                    let put = |list: &mut Vec<ScopeEntry>| match list
                        .iter()
                        .position(|e| &e.sel == sel && e.via.as_deref() == Some(via.as_str()))
                    {
                        None => list.push(ScopeEntry {
                            member: member.is_some(),
                            ..world.entry(sel, Some(&via))
                        }),
                        Some(at) => {
                            let was = list[at].member;
                            let kept = world.rebound(&list[at]);
                            list[at] = ScopeEntry {
                                member: member.is_some() && was,
                                ..kept
                            };
                        }
                    };
                    for i in &stored {
                        put(&mut caps.caps[*i].sels);
                    }
                    for key in &keys {
                        put(caps.allow.entry(key.clone()).or_default());
                    }
                    added.push(sel.clone());
                }
            }
            change.added.extend(added.iter().cloned());
            change.clipped.extend(cut.iter().cloned());
            if !added.is_empty() || member.is_none() {
                audits.push(json!({"dir": dir, "added": added, "clipped": cut, "before": before, "after": snapshot(&caps)}));
            }
        }
        if change.added.is_empty() {
            return Ok(change);
        }
        self.store
            .all(
                "UPDATE endpoints SET caps = ? WHERE id = ?",
                &[caps_json(&mut caps), SqlValue::Text(target_id.into())],
            )
            .await?;
        for row in audits {
            let mut out = detail.clone();
            if let (Some(dst), Some(src)) = (out.as_object_mut(), row.as_object()) {
                dst.extend(src.clone());
            }
            self.audit("scope_widen", Some(target_id), None, out)
                .await?;
        }
        Ok(change)
    }

    /// Removes a stored cap the actor may loosen; an inherited cap only the human at a terminal lifts.
    pub async fn rules_lift(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let actor = self.actor_of(conn)?;
        let me = self.actor_endpoint(&actor).await?;
        let endpoint = optional(params, "endpoint")?;
        self.need_tty(&actor, &me, endpoint.clone()).await?;
        let endpoint = endpoint.ok_or_else(|| RpcError::invalid_params("endpoint is required"))?;
        let cap_name = required(params, "cap")?;
        let world = self.world().await?;
        let target = self.scope_target(&world, &me, &endpoint).await?;
        let (me_id, target_id) = (row_id(&me).to_owned(), row_id(&target).to_owned());
        let detail = |extra: Value| {
            let mut row = json!({"target": address(&target)});
            if let (Some(dst), Some(src)) = (row.as_object_mut(), extra.as_object()) {
                dst.extend(src.clone());
            }
            row
        };
        if actor.narrow_only() {
            return Err(self
                .refused(
                    &actor,
                    &me,
                    detail(json!({"reason": "narrow only"})),
                    "lifting a cap needs an authenticated session",
                )
                .await);
        }
        if !world.authority(&me_id, &target_id) {
            return Err(self
                .refused(
                    &actor,
                    &me,
                    detail(json!({"reason": "no authority"})),
                    &format!("no authority over {}", address(&target)),
                )
                .await);
        }
        let mut caps = caps_of(&target);
        let audit = |dir: ScopeDirection, before: Value| {
            let mut row = detail(
                json!({"by": address(&me), "auth": actor.auth(), "dir": dir, "before": before, "after": null}),
            );
            row["target"] = json!(address(&target));
            row
        };
        if cap_name == "inherited:in" || cap_name == "inherited:out" {
            if !actor.at_terminal() {
                return Err(self
                    .refused(
                        &actor,
                        &me,
                        detail(json!({"reason": "human only"})),
                        "only the human at a terminal lifts an inherited cap",
                    )
                    .await);
            }
            let node = world.node_of(&target_id).ok_or_else(RpcError::internal)?;
            let derived = node
                .caps
                .caps
                .iter()
                .find(|c| c.by == "inherited" && c.id == cap_name)
                .cloned()
                .ok_or_else(|| {
                    RpcError::new(
                        ErrorCode::NotFound,
                        format!("no cap {cap_name} on {}", address(&target)),
                    )
                })?;
            caps.lifted.get_or_insert_with(Vec::new).push(derived.dir);
            caps.allow.remove(&derived.id);
            self.store
                .all(
                    "UPDATE endpoints SET caps = ? WHERE id = ?",
                    &[caps_json(&mut caps), SqlValue::Text(target_id.clone())],
                )
                .await?;
            let via = derived
                .sels
                .first()
                .and_then(|e| e.via.clone())
                .unwrap_or_default();
            let parent = world.row(&via).map_or(via.clone(), address);
            self.audit(
                "scope_lift",
                Some(&target_id),
                None,
                audit(derived.dir, json!([format!("inherited from {parent}")])),
            )
            .await?;
        } else {
            let Some(at) = caps.caps.iter().position(|c| c.id == cap_name) else {
                if cap_name.starts_with("group:") || cap_name.starts_with("policy:") {
                    return Err(self.refused(&actor, &me, detail(json!({"reason": "not a stored cap"})), "a group cap goes with the membership, a policy cap with the policy file").await);
                }
                return Err(RpcError::new(
                    ErrorCode::NotFound,
                    format!("no cap {cap_name} on {}", address(&target)),
                ));
            };
            let cap = caps.caps[at].clone();
            if !world.may_loosen(&me_id, &target_id, &cap.by, None) {
                return Err(self
                    .refused(
                        &actor,
                        &me,
                        detail(json!({"dir": cap.dir, "reason": "set above"})),
                        &format!("{} was set above {}", cap.id, address(&me)),
                    )
                    .await);
            }
            caps.caps.remove(at);
            self.store
                .all(
                    "UPDATE endpoints SET caps = ? WHERE id = ?",
                    &[caps_json(&mut caps), SqlValue::Text(target_id.clone())],
                )
                .await?;
            self.audit(
                "scope_lift",
                Some(&target_id),
                None,
                audit(
                    cap.dir,
                    json!(cap.sels.iter().map(|e| &e.sel).collect::<Vec<_>>()),
                ),
            )
            .await?;
        }
        let world = self.world().await?;
        let fresh = world
            .row(&target_id)
            .cloned()
            .ok_or_else(RpcError::internal)?;
        self.scope_view_of(&world, &fresh, &me)
    }

    pub async fn rewrite_selectors(
        &self,
        old_handle: &str,
        new_handle: &str,
    ) -> Result<(), RpcError> {
        let root = self
            .by_handle(new_handle)
            .await?
            .or(self.by_handle(old_handle).await?)
            .is_some_and(|row| text(&row, "parent_ep").is_none());
        for prefix in if root {
            &["ep:", "fleet:"][..]
        } else {
            &["ep:"][..]
        } {
            let old = serde_json::to_string(&format!("{prefix}{old_handle}"))
                .map_err(|_| RpcError::internal())?;
            let new = serde_json::to_string(&format!("{prefix}{new_handle}"))
                .map_err(|_| RpcError::internal())?;
            for (table, column) in [
                ("endpoints", "rules"),
                ("endpoints", "caps"),
                ("groups", "rules"),
                ("grants", "caps"),
            ] {
                self.store.all(&format!("UPDATE {table} SET {column} = REPLACE({column}, ?, ?) WHERE instr({column}, ?) > 0"), &[SqlValue::Text(old.clone()), SqlValue::Text(new.clone()),SqlValue::Text(old.clone())]).await?;
            }
        }
        Ok(())
    }
}

fn same_set(a: &Value, b: &Value) -> bool {
    match (a.as_array(), b.as_array()) {
        (Some(a), Some(b)) => a.len() == b.len() && a.iter().all(|value| b.contains(value)),
        _ => false,
    }
}

pub fn scope_of(row: &crate::store::Row) -> &'static str {
    let rules = text(row, "rules")
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or_else(|| json!({}));
    let caps = text(row, "caps")
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or_else(|| json!({}));
    if caps
        .get("caps")
        .and_then(Value::as_array)
        .is_some_and(|caps| !caps.is_empty())
    {
        return "custom";
    }
    if ["in", "out"].iter().all(|dir| rules.get(*dir).is_none()) {
        return "open";
    }
    for name in ["tree", "parent", "none"] {
        if let Some(expected) = preset(name)
            && ["in", "out"].iter().all(|dir| {
                rules
                    .get(*dir)
                    .is_some_and(|value| same_set(value, &expected))
            })
        {
            return name;
        }
    }
    "custom"
}
