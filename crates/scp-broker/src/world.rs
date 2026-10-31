//! A read snapshot of the scope state: endpoint rows, groups, memberships, admins and the policy,
//! with every endpoint's scope node derived once. Decisions run synchronously against it.

use std::collections::{BTreeMap, HashMap, HashSet};

use scp_core::protocol::{ScopeCap, ScopeDirection, ScopeEntry};
use scp_core::scope::{
    PolicySubject, ScopeCaps, ScopeDecision, ScopeDecisionOptions, ScopeGroupIdentity,
    ScopeGroupRules, ScopeNode, ScopePolicyCap, ScopeRules, ScopeSubject, ScopeWorld, cross_fleet,
    has_scope, is_root, matches, scope_decision, valid_group_name,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::{integer, text};
use crate::store::Row;

pub const GONE: &str = "_gone_";
/// The retired-handle prefix an older store may hold.
pub const LEGACY_GONE: &str = "gone:";
/// A SQL condition on `handle` that leaves retired endpoints out.
pub const LIVE_HANDLE: &str = "substr(handle,1,5) != 'gone:' AND substr(handle,1,6) != '_gone_'";
pub const DEPTH_MAX: usize = 32;
pub const HUMAN_HANDLE: &str = "_human";
const HIDDEN: &str = "an ancestor or admin";
const DIRS: [ScopeDirection; 2] = [ScopeDirection::In, ScopeDirection::Out];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct GroupRules {
    #[serde(default, rename = "in", skip_serializing_if = "Option::is_none")]
    pub r#in: Option<Vec<ScopeEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<Vec<ScopeEntry>>,
}

impl GroupRules {
    pub fn get(&self, dir: ScopeDirection) -> Option<&Vec<ScopeEntry>> {
        match dir {
            ScopeDirection::In => self.r#in.as_ref(),
            ScopeDirection::Out => self.out.as_ref(),
        }
    }
    pub fn set(&mut self, dir: ScopeDirection, value: Option<Vec<ScopeEntry>>) {
        match dir {
            ScopeDirection::In => self.r#in = value,
            ScopeDirection::Out => self.out = value,
        }
    }
    pub fn ruled(&self) -> bool {
        self.r#in.is_some() || self.out.is_some()
    }
}

#[derive(Clone, Debug)]
pub struct Group {
    pub name: String,
    pub owner: String,
    pub tree: Option<String>,
    pub rules: GroupRules,
    pub pinned: bool,
    pub policy: bool,
    pub id: String,
}

#[derive(Clone, Debug)]
pub struct Admin {
    pub subject: String,
    pub scope_kind: String,
    pub scope: String,
    pub scope_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Defaults {
    pub human_always: bool,
    pub symmetric: bool,
    pub child_default: String,
}

impl Defaults {
    pub fn of(policy: Option<&Value>) -> Self {
        let get = |name: &str| {
            policy
                .and_then(|p| p.get("defaults"))
                .and_then(|d| d.get(name))
        };
        Self {
            human_always: get("human_always").and_then(Value::as_bool).unwrap_or(true),
            symmetric: get("symmetric_presets")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            child_default: get("child_default")
                .and_then(Value::as_str)
                .unwrap_or("inherit")
                .to_owned(),
        }
    }
    pub fn preset_dirs(&self) -> &'static [ScopeDirection] {
        if self.symmetric {
            &DIRS
        } else {
            &[ScopeDirection::Out]
        }
    }
}

/// The raw tables a world is built from.
pub struct Tables {
    pub endpoints: Vec<Row>,
    pub groups: Vec<Row>,
    pub members: Vec<Row>,
    pub admins: Vec<Row>,
    pub policy: Option<Value>,
    pub binds: HashMap<String, String>,
    pub local_users: HashSet<String>,
    pub machine: Option<String>,
}

pub struct World {
    rows: HashMap<String, Row>,
    listed: Vec<String>,
    runtime: BTreeMap<String, Group>,
    members: HashMap<String, Vec<String>>,
    admins: Vec<Admin>,
    pub policy: Option<Value>,
    binds: HashMap<String, String>,
    pub defaults: Defaults,
    subjects: HashMap<String, PolicySubject>,
    nodes: HashMap<String, ScopeNode>,
    viewer: Option<String>,
    shown: Option<HashSet<String>>,
    local_users: HashSet<String>,
    machine: Option<String>,
}

pub fn json_of(row: &Row, key: &str) -> Value {
    text(row, key)
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or(Value::Null)
}

pub fn caps_of(row: &Row) -> ScopeCaps {
    let value = json_of(row, "caps");
    ScopeCaps {
        caps: serde_json::from_value(value.get("caps").cloned().unwrap_or_default())
            .unwrap_or_default(),
        allow: serde_json::from_value(value.get("allow").cloned().unwrap_or_default())
            .unwrap_or_default(),
        lifted: serde_json::from_value::<Vec<ScopeDirection>>(
            value.get("lifted").cloned().unwrap_or_default(),
        )
        .ok()
        .filter(|v| !v.is_empty()),
    }
}

pub fn rules_of(row: &Row) -> ScopeRules {
    serde_json::from_value(json_of(row, "rules")).unwrap_or_default()
}

pub fn retired(handle: &str) -> bool {
    handle.starts_with(GONE) || handle.starts_with(LEGACY_GONE)
}

pub fn is_gone(row: &Row) -> bool {
    text(row, "handle").is_some_and(retired)
}

pub fn address(row: &Row) -> String {
    crate::views::address(row)
}

fn group_of(row: &Row) -> Option<Group> {
    Some(Group {
        name: text(row, "name")?.to_owned(),
        owner: text(row, "owner")?.to_owned(),
        tree: text(row, "tree").map(str::to_owned),
        rules: serde_json::from_value(json_of(row, "rules")).unwrap_or_default(),
        pinned: integer(row, "pinned") == Some(1),
        policy: false,
        id: text(row, "id").unwrap_or_default().to_owned(),
    })
}

impl World {
    pub fn build(tables: Tables) -> Self {
        let mut rows = HashMap::new();
        let mut listed = Vec::new();
        for row in tables.endpoints {
            let id = text(&row, "id").unwrap_or_default().to_owned();
            if text(&row, "kind") != Some("system") && !is_gone(&row) {
                listed.push(id.clone());
            }
            rows.insert(id, row);
        }
        listed.sort_by(|a, b| {
            let key = |id: &String| {
                let row = &rows[id];
                (
                    std::cmp::Reverse(text(row, "kind").unwrap_or("").to_owned()),
                    text(row, "handle").unwrap_or("").to_owned(),
                )
            };
            key(a).cmp(&key(b))
        });
        let runtime = tables
            .groups
            .iter()
            .filter_map(group_of)
            .map(|g| (g.name.clone(), g))
            .collect();
        let mut members: HashMap<String, Vec<String>> = HashMap::new();
        for row in &tables.members {
            if let (Some(endpoint), Some(name)) = (text(row, "endpoint"), text(row, "name")) {
                members
                    .entry(endpoint.to_owned())
                    .or_default()
                    .push(name.to_owned());
            }
        }
        for names in members.values_mut() {
            names.sort();
        }
        let admins = tables
            .admins
            .iter()
            .filter(|row| integer(row, "revoked_at").is_none())
            .filter_map(|row| {
                Some(Admin {
                    subject: text(row, "subject")?.to_owned(),
                    scope_kind: text(row, "scope_kind")?.to_owned(),
                    scope: text(row, "scope")?.to_owned(),
                    scope_id: text(row, "scope_id").map(str::to_owned),
                })
            })
            .collect();
        let defaults = Defaults::of(tables.policy.as_ref());
        let mut world = Self {
            rows,
            listed,
            runtime,
            members,
            admins,
            policy: tables.policy,
            binds: tables.binds,
            defaults,
            subjects: HashMap::new(),
            nodes: HashMap::new(),
            viewer: None,
            shown: None,
            local_users: tables.local_users,
            machine: tables.machine,
        };
        world.derive();
        world
    }

    fn derive(&mut self) {
        let ids: Vec<String> = self.rows.keys().cloned().collect();
        for id in &ids {
            let subject = self.subject_now(&self.rows[id]);
            self.subjects.insert(id.clone(), subject);
        }
        let mut limited = HashMap::new();
        for id in &ids {
            let node = self.node_now(&self.rows[id], &mut limited);
            self.nodes.insert(id.clone(), node);
        }
    }

    /// Reasons are written for `viewer`; with `hide`, a widener it does not see is named only as an ancestor or admin.
    pub fn view_as(&mut self, viewer: Option<&str>, hide: bool) {
        self.shown = match viewer {
            Some(id) if hide => self.row(id).map(|row| self.visible(row)),
            _ => None,
        };
        self.viewer = viewer.map(str::to_owned);
    }

    pub fn row(&self, id: &str) -> Option<&Row> {
        self.rows.get(id)
    }

    pub fn by_handle(&self, handle: &str) -> Option<&Row> {
        self.rows
            .values()
            .find(|row| text(row, "handle") == Some(handle))
    }

    pub fn human(&self) -> Option<&Row> {
        self.by_handle(HUMAN_HANDLE)
    }

    pub fn listed(&self) -> impl Iterator<Item = &Row> {
        self.listed.iter().map(|id| &self.rows[id])
    }

    pub fn agents(&self) -> impl Iterator<Item = &Row> {
        self.rows
            .values()
            .filter(|row| text(row, "kind") == Some("agent") && !is_gone(row))
    }

    pub fn node_of(&self, id: &str) -> Option<&ScopeNode> {
        self.nodes.get(id)
    }

    pub fn subject(&self, id: &str) -> Option<&PolicySubject> {
        self.subjects.get(id)
    }

    pub fn scope_subject(&self, id: &str) -> Option<&ScopeSubject> {
        self.subjects.get(id).and_then(|s| s.scope.as_ref())
    }

    pub fn groups_of(&self, id: &str) -> Vec<String> {
        self.scope_subject(id)
            .map(|s| s.groups.clone())
            .unwrap_or_default()
    }

    fn ancestors(&self, row: &Row) -> Vec<String> {
        let own = text(row, "id").unwrap_or_default();
        let mut out: Vec<String> = Vec::new();
        let mut next = text(row, "parent_ep").map(str::to_owned);
        while let Some(id) = next {
            if id == own || out.contains(&id) || out.len() > DEPTH_MAX {
                break;
            }
            next = self
                .rows
                .get(&id)
                .and_then(|r| text(r, "parent_ep"))
                .map(str::to_owned);
            out.push(id);
        }
        out
    }

    pub fn ancestors_of(&self, id: &str) -> Vec<String> {
        self.scope_subject(id)
            .map(|s| s.ancestors.clone())
            .or_else(|| self.rows.get(id).map(|row| self.ancestors(row)))
            .unwrap_or_default()
    }

    pub fn descendant_of(&self, id: &str, ancestor: &str) -> bool {
        self.rows.contains_key(id) && self.ancestors_of(id).iter().any(|a| a == ancestor)
    }

    fn fixed_groups(&self) -> Vec<&Value> {
        self.policy
            .as_ref()
            .and_then(|p| p.get("groups"))
            .and_then(Value::as_array)
            .map(|g| g.iter().collect())
            .unwrap_or_default()
    }

    pub fn plain_subject(row: &Row) -> PolicySubject {
        let human = text(row, "kind") == Some("human");
        PolicySubject {
            handle: if human {
                String::new()
            } else {
                text(row, "handle").unwrap_or_default().to_owned()
            },
            harness: text(row, "harness").map(str::to_owned),
            kind: text(row, "kind").unwrap_or_default().to_owned(),
            labels: serde_json::from_value(json_of(row, "labels")).unwrap_or_default(),
            scope: None,
            account: None,
        }
    }

    /// another machine's row sits in no local tree: a fleet of its own on its machine, with its mirrored ancestors
    fn remote_subject(&self, row: &Row, remote: &str) -> PolicySubject {
        let mut subject = Self::plain_subject(row);
        subject.handle = String::new();
        if crate::bridge::is_foreign(remote) {
            subject.account = Some(crate::bridge::machine_part(&remote[1..]).to_owned());
            return subject;
        }
        if text(row, "kind") == Some("system") {
            return subject;
        }
        let id = text(row, "id").unwrap_or_default().to_owned();
        subject.scope = Some(ScopeSubject {
            tree: text(row, "tree").unwrap_or(&id).to_owned(),
            ancestors: self.ancestors(row),
            groups: Vec::new(),
            root_handle: String::new(),
            machine: Some(crate::bridge::machine_part(remote).to_owned()),
            local: false,
            root: (text(row, "kind") == Some("agent") && !crate::bridge::rows::placed_root(row))
                .then_some(false),
            id,
        });
        subject
    }

    fn subject_now(&self, row: &Row) -> PolicySubject {
        if let Some(remote) = text(row, "remote") {
            return self.remote_subject(row, remote);
        }
        let mut subject = Self::plain_subject(row);
        if text(row, "kind") != Some("agent") {
            return subject;
        }
        let id = text(row, "id").unwrap_or_default().to_owned();
        let tree = text(row, "tree").unwrap_or(&id).to_owned();
        let root = if tree == id {
            Some(row)
        } else {
            self.rows.get(&tree)
        };
        let fixed: Vec<&str> = self
            .fixed_groups()
            .iter()
            .filter_map(|g| g.get("name").and_then(Value::as_str))
            .collect();
        let runtime: Vec<String> = self
            .members
            .get(&id)
            .into_iter()
            .flatten()
            .filter(|name| !fixed.contains(&name.as_str()))
            .cloned()
            .collect();
        subject.scope = Some(ScopeSubject {
            id: id.clone(),
            tree,
            ancestors: self.ancestors(row),
            groups: runtime.clone(),
            root_handle: root
                .and_then(|r| text(r, "handle"))
                .unwrap_or_default()
                .to_owned(),
            machine: None,
            local: true,
            root: None,
        });
        let bound = |name: &str| self.bound(name);
        let from_policy: Vec<String> = self
            .fixed_groups()
            .iter()
            .filter_map(|group| {
                let name = group.get("name")?.as_str()?;
                let hit = !runtime.iter().any(|r| r == name)
                    && group
                        .get("members")?
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|sel| matches(sel, &subject, None, Some(&bound)));
                hit.then(|| name.to_owned())
            })
            .collect();
        if let Some(scope) = subject.scope.as_mut() {
            scope.groups.extend(from_policy);
        }
        subject
    }

    fn node_now(&self, row: &Row, limited: &mut HashMap<String, bool>) -> ScopeNode {
        let id = text(row, "id").unwrap_or_default().to_owned();
        let subject = self.subjects.get(&id).cloned().unwrap_or_default();
        if let Some(remote) = text(row, "remote") {
            let foreign = crate::bridge::is_foreign(remote);
            let machine = crate::bridge::machine_part(remote);
            let human = !foreign
                && text(row, "kind") == Some("human")
                && crate::bridge::handle_part(remote).is_empty()
                && self.local_users.contains(machine);
            return ScopeNode {
                id,
                address: address(row),
                subject,
                human: Some(human),
                rules: if foreign {
                    ScopeRules::default()
                } else {
                    rules_of(row)
                },
                caps: if foreign {
                    ScopeCaps::default()
                } else {
                    caps_of(row)
                },
                ..ScopeNode::default()
            };
        }
        let human = text(row, "kind") == Some("human") && text(row, "handle") == Some(HUMAN_HANDLE);
        let mut node = ScopeNode {
            id: id.clone(),
            address: address(row),
            subject,
            human: Some(human),
            ..ScopeNode::default()
        };
        let Some(scope) = node.subject.scope.clone() else {
            return node;
        };
        node.groups = scope
            .groups
            .iter()
            .filter_map(|name| {
                let group = self.group_by_name(name)?;
                Some(ScopeGroupRules {
                    name: name.clone(),
                    owner: group.owner,
                    r#in: group.rules.r#in,
                    out: group.rules.out,
                })
            })
            .collect();
        let mut caps = caps_of(row);
        let inherited = self.inherited_caps(row, &caps, 0, limited);
        caps.caps.extend(inherited);
        node.rules = rules_of(row);
        node.caps = caps;
        node.policy = self.policy_caps(&node.subject);
        node
    }

    /// Under child_default inherit, a limited parent's limits on its child: `*` clipped via the parent.
    fn inherited_caps(
        &self,
        row: &Row,
        caps: &ScopeCaps,
        depth: usize,
        limited: &mut HashMap<String, bool>,
    ) -> Vec<ScopeCap> {
        let dirs: Vec<ScopeDirection> = DIRS
            .into_iter()
            .filter(|d| !caps.lifted.as_ref().is_some_and(|l| l.contains(d)))
            .collect();
        let Some(parent) = text(row, "parent_ep") else {
            return Vec::new();
        };
        if dirs.is_empty() || self.defaults.child_default != "inherit" {
            return Vec::new();
        }
        if let Some(prow) = self.rows.get(parent)
            && !self.limited(prow, depth + 1, limited)
        {
            return Vec::new();
        }
        dirs.into_iter()
            .map(|dir| {
                let key = format!("inherited:{dir}");
                let mut sels = vec![ScopeEntry {
                    sel: "*".into(),
                    via: Some(parent.to_owned()),
                    group: None,
                    base: true,
                    member: false,
                }];
                sels.extend(caps.allow.get(&key).cloned().unwrap_or_default());
                ScopeCap {
                    id: key,
                    dir,
                    by: "inherited".into(),
                    sels,
                }
            })
            .collect()
    }

    fn limited(&self, row: &Row, depth: usize, memo: &mut HashMap<String, bool>) -> bool {
        let id = text(row, "id").unwrap_or_default().to_owned();
        if let Some(known) = memo.get(&id) {
            return *known;
        }
        let result = depth > DEPTH_MAX + 1 || {
            let caps = caps_of(row);
            let subject = self.subjects.get(&id);
            !caps.caps.is_empty()
                || subject.and_then(|s| s.scope.as_ref()).is_some_and(|s| {
                    s.groups
                        .iter()
                        .any(|name| self.group_by_name(name).is_some_and(|g| g.rules.ruled()))
                })
                || subject.is_some_and(|s| !self.policy_caps(s).is_empty())
                || !self.inherited_caps(row, &caps, depth, memo).is_empty()
        };
        memo.insert(id, result);
        result
    }

    /// The policy's group of that name, else the runtime one: a runtime group a policy group shadows is ignored.
    pub fn group_by_name(&self, name: &str) -> Option<Group> {
        if let Some(fixed) = self
            .fixed_groups()
            .into_iter()
            .find(|g| g.get("name").and_then(Value::as_str) == Some(name))
        {
            let entries = |key: &str| {
                fixed.get(key).and_then(Value::as_array).map(|sels| {
                    sels.iter()
                        .filter_map(Value::as_str)
                        .map(|sel| self.policy_entry(sel))
                        .collect::<Vec<_>>()
                })
            };
            let mut rules = GroupRules::default();
            if let Some(list) = entries("rules") {
                for dir in self.defaults.preset_dirs() {
                    rules.set(*dir, Some(list.clone()));
                }
            }
            if let Some(list) = entries("in") {
                rules.r#in = Some(list);
            }
            if let Some(list) = entries("out") {
                rules.out = Some(list);
            }
            return Some(Group {
                name: name.to_owned(),
                owner: "policy".into(),
                tree: None,
                rules,
                pinned: true,
                policy: true,
                id: "policy".into(),
            });
        }
        self.runtime.get(name).cloned()
    }

    pub fn runtime_group(&self, name: &str) -> Option<&Group> {
        self.runtime.get(name)
    }

    pub fn all_groups(&self) -> Vec<Group> {
        let mut names: Vec<String> = self.runtime.keys().cloned().collect();
        for group in self.fixed_groups() {
            if let Some(name) = group.get("name").and_then(Value::as_str)
                && !names.iter().any(|n| n == name)
            {
                names.push(name.to_owned());
            }
        }
        names.iter().filter_map(|n| self.group_by_name(n)).collect()
    }

    pub fn runtime_members(&self, name: &str) -> Vec<&Row> {
        let mut rows: Vec<&Row> = self
            .members
            .iter()
            .filter(|(_, names)| names.iter().any(|n| n == name))
            .filter_map(|(id, _)| self.rows.get(id))
            .filter(|row| !is_gone(row))
            .collect();
        rows.sort_by_key(|row| text(row, "handle").unwrap_or_default().to_owned());
        rows
    }

    pub fn is_member(&self, name: &str, id: &str) -> bool {
        self.members
            .get(id)
            .is_some_and(|names| names.iter().any(|n| n == name))
    }

    pub fn group_members(&self, group: &Group) -> Vec<&Row> {
        if !group.policy {
            return self.runtime_members(&group.name);
        }
        let mut rows: Vec<&Row> = self
            .agents()
            .filter(|row| {
                self.groups_of(text(row, "id").unwrap_or_default())
                    .contains(&group.name)
            })
            .collect();
        rows.sort_by_key(|row| text(row, "handle").unwrap_or_default().to_owned());
        rows
    }

    /// Whether a policy `group:<name>` may match the group of that name now.
    pub fn bound(&self, name: &str) -> bool {
        match self.binds.get(name) {
            None => true,
            Some(bound) => self.group_by_name(name).is_some_and(|g| g.id == *bound),
        }
    }

    pub fn policy_entry(&self, sel: &str) -> ScopeEntry {
        let group = sel
            .strip_prefix("group:")
            .and_then(|name| self.binds.get(name))
            .cloned();
        ScopeEntry {
            sel: sel.into(),
            via: None,
            group,
            base: false,
            member: false,
        }
    }

    fn rules(&self) -> Vec<&Value> {
        self.policy
            .as_ref()
            .and_then(|p| p.get("rules"))
            .and_then(Value::as_array)
            .map(|r| r.iter().collect())
            .unwrap_or_default()
    }

    pub fn policy_caps(&self, subject: &PolicySubject) -> Vec<ScopePolicyCap> {
        let bound = |name: &str| self.bound(name);
        let mut out = Vec::new();
        for rule in self.rules() {
            let (Some(sels), Some(pattern)) = (
                rule.get("scope").and_then(Value::as_array),
                rule.get("match").and_then(Value::as_str),
            ) else {
                continue;
            };
            if !matches(pattern, subject, None, Some(&bound)) {
                continue;
            }
            for dir in self.defaults.preset_dirs() {
                out.push(ScopePolicyCap {
                    dir: *dir,
                    r#match: pattern.to_owned(),
                    sels: sels
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|sel| self.policy_entry(sel))
                        .collect(),
                });
            }
        }
        out
    }

    /// Why the policy refuses a message between two subjects, or None.
    pub fn policy_refusal_of(&self, from: &PolicySubject, to: &PolicySubject) -> Option<String> {
        let bound = |name: &str| self.bound(name);
        let any = |list: &Value, subject: &PolicySubject, anchor: &PolicySubject| {
            list.as_array().is_some_and(|sels| {
                sels.iter()
                    .filter_map(Value::as_str)
                    .any(|s| matches(s, subject, Some(anchor), Some(&bound)))
            })
        };
        for rule in self.rules() {
            let pattern = rule.get("match").and_then(Value::as_str).unwrap_or("");
            if let Some(list) = rule.get("send_to")
                && matches(pattern, from, None, Some(&bound))
                && !any(list, to, from)
            {
                return Some(format!(
                    "the relay policy ({pattern}, send_to) does not let this endpoint message that one"
                ));
            }
            if let Some(list) = rule.get("accept_from")
                && matches(pattern, to, None, Some(&bound))
                && !any(list, from, to)
            {
                return Some(format!(
                    "the relay policy ({pattern}, accept_from) does not let that endpoint receive from this one"
                ));
            }
        }
        None
    }

    pub fn policy_refusal(&self, from: &str, to: &str) -> Option<String> {
        let (a, b) = (self.subjects.get(from)?, self.subjects.get(to)?);
        self.policy_refusal_of(a, b)
    }

    pub fn decide(
        &self,
        a: &str,
        b: &str,
        solicited: bool,
        unverified: bool,
        strict: bool,
    ) -> ScopeDecision {
        let blank = ScopeNode::default();
        let linked = a != b
            && matches!((self.rows.get(a), self.rows.get(b)), (Some(x), Some(y))
                if crate::bridge::across::linked_across(x, y, self.machine.as_deref()));
        scope_decision(
            self,
            self.nodes.get(a).unwrap_or(&blank),
            self.nodes.get(b).unwrap_or(&blank),
            ScopeDecisionOptions {
                human_always: self.defaults.human_always,
                solicited,
                linked,
                unverified,
                strict,
            },
        )
    }

    pub fn refusal(&self, a: &str, b: &str, unverified: bool, strict: bool) -> Option<String> {
        let decision = self.decide(a, b, false, unverified, strict);
        (!decision.allowed).then(|| decision.reasons.last().cloned().unwrap_or_default())
    }

    pub fn may_message(&self, from: &str, to: &str, unverified: bool, strict: bool) -> bool {
        self.refusal(from, to, unverified, strict).is_none()
            && self.policy_refusal(from, to).is_none()
    }

    /// Whether `a` may message `b`, or `b` may message `a` while `b` has a list, sits in `a`'s tree or is a root.
    pub fn sees(&self, a: &str, b: &str) -> bool {
        if self.may_message(a, b, false, false) {
            return true;
        }
        let (Some(na), Some(nb)) = (self.nodes.get(a), self.nodes.get(b)) else {
            return false;
        };
        (has_scope(nb) || is_root(nb) || !cross_fleet(na, nb))
            && self.may_message(b, a, false, true)
    }

    pub fn is_human(&self, id: &str) -> bool {
        self.rows
            .get(id)
            .is_some_and(|r| text(r, "kind") == Some("human"))
    }

    pub fn is_agent(&self, id: &str) -> bool {
        self.rows
            .get(id)
            .is_some_and(|r| text(r, "kind") == Some("agent"))
    }

    pub fn visible_row(&self, me: &str, row: &str) -> bool {
        row == me
            || if self.is_human(me) {
                self.may_message(me, row, true, false)
            } else {
                self.sees(me, row)
            }
    }

    /// The ids `me` sees: those it may message or be messaged by, and itself.
    pub fn visible(&self, me: &Row) -> HashSet<String> {
        let me = text(me, "id").unwrap_or_default();
        self.listed
            .iter()
            .filter(|id| self.visible_row(me, id))
            .cloned()
            .collect()
    }

    /// The human; an ancestor; an admin of the endpoint's tree or of a group it is in. Never the endpoint itself.
    pub fn authority(&self, w: &str, d: &str) -> bool {
        if self.is_human(w) {
            return true;
        }
        if !self.is_agent(w) || w == d {
            return false;
        }
        self.ancestors_of(d).iter().any(|a| a == w)
            || self
                .scope_subject(d)
                .is_some_and(|s| self.administers(w, s))
    }

    /// Whether `me` may find `row` by address.
    pub fn discovers(&self, me: &str, row: &str) -> bool {
        self.is_human(me)
            || row == me
            || self.authority(me, row)
            || self.may_message(me, row, false, false)
    }

    fn granted_on(&self, admin: &Admin) -> bool {
        admin.scope_id.as_ref().is_some_and(|id| {
            self.group_by_name(&admin.scope)
                .is_some_and(|g| &g.id == id)
        })
    }

    pub fn admin_rows(&self, w: &str) -> impl Iterator<Item = &Admin> {
        self.admins.iter().filter(move |a| a.subject == w)
    }

    pub fn stale(&self, admin: &Admin) -> bool {
        admin.scope_kind == "group" && !self.granted_on(admin)
    }

    pub fn administers(&self, w: &str, x: &ScopeSubject) -> bool {
        self.admin_rows(w).any(|row| {
            if row.scope_kind == "tree" {
                row.scope == x.tree
            } else {
                x.groups.contains(&row.scope) && self.granted_on(row)
            }
        })
    }

    pub fn admin_of_group(&self, w: &str, group: &Group) -> bool {
        self.admin_rows(w).any(|row| {
            if row.scope_kind == "tree" {
                Some(&row.scope) == group.tree.as_ref()
            } else {
                row.scope == group.name && self.granted_on(row)
            }
        })
    }

    pub fn administers_id(&self, w: &str, d: &str) -> bool {
        self.scope_subject(d)
            .is_some_and(|s| self.administers(w, s))
    }

    /// Whether `me` may loosen a cap on `d` set by `by` (a group cap: `owner`).
    pub fn may_loosen(&self, me: &str, d: &str, by: &str, owner: Option<&str>) -> bool {
        let setter = owner.unwrap_or(by);
        if by == "policy" || setter == "policy" {
            return false;
        }
        if self.is_human(me) {
            return true;
        }
        if setter == "inherited" || setter == "human" || self.is_human(setter) {
            return false;
        }
        if self.administers_id(me, d) {
            return true;
        }
        setter == me || self.descendant_of(setter, me)
    }

    pub fn sees_group(&self, me: &str, group: &Group) -> bool {
        if self.is_human(me) || group.owner == me || self.admin_of_group(me, group) {
            return true;
        }
        if !group.policy && self.rows.contains_key(&group.owner) && self.authority(me, &group.owner)
        {
            return true;
        }
        self.groups_of(me).contains(&group.name)
    }

    pub fn stewards(&self, me: &str, group: &Group) -> bool {
        self.is_human(me)
            || me == group.owner
            || self.descendant_of(&group.owner, me)
            || self.admin_of_group(me, group)
    }

    /// The members `me` may see: a steward every one, others those it finds.
    pub fn members_for(&self, me: &str, group: &Group) -> Vec<&Row> {
        let all = self.group_members(group);
        if self.stewards(me, group) {
            return all;
        }
        all.into_iter()
            .filter(|row| self.discovers(me, text(row, "id").unwrap_or_default()))
            .collect()
    }

    /// A selector as set now, `via` a widener: a `group:<name>` binds to the group of that name, when there is one.
    pub fn entry(&self, sel: &str, via: Option<&str>) -> ScopeEntry {
        let group = sel
            .strip_prefix("group:")
            .filter(|name| valid_group_name(name) && *name != "self")
            .and_then(|name| self.group_by_name(name))
            .map(|g| g.id);
        ScopeEntry {
            sel: sel.into(),
            via: via.map(str::to_owned),
            group,
            base: false,
            member: false,
        }
    }

    /// A kept entry set again: a `group:<name>` binds to the group of that name now, when there is one.
    pub fn rebound(&self, entry: &ScopeEntry) -> ScopeEntry {
        match self.entry(&entry.sel, None).group {
            Some(group) if Some(&group) != entry.group.as_ref() => ScopeEntry {
                group: Some(group),
                ..entry.clone()
            },
            _ => entry.clone(),
        }
    }

    /// Whether `me` may name a group: the human any, an agent a policy or pinned one, the human's, one in its fleet or one it sees.
    pub fn nameable(&self, me: &str, name: &str) -> bool {
        if !valid_group_name(name) || name == "self" {
            return false;
        }
        let Some(group) = self.group_by_name(name) else {
            return false;
        };
        let tree = self
            .rows
            .get(me)
            .map(|row| text(row, "tree").unwrap_or(me).to_owned());
        self.is_human(me)
            || group.policy
            || group.pinned
            || group.tree.is_none()
            || group.tree == tree
            || self.sees_group(me, &group)
    }

    /// A name as `viewer` may read it: an agent viewer that does not see the id reads it as an ancestor or admin.
    pub fn hides(&self, viewer: &str, shown: &HashSet<String>, id: &str) -> bool {
        self.is_agent(viewer) && !shown.contains(id)
    }

    pub fn hidden() -> &'static str {
        HIDDEN
    }
}

impl ScopeWorld for World {
    fn node(&self, id: &str) -> Option<&ScopeNode> {
        self.rows
            .get(id)
            .filter(|row| !is_gone(row))
            .and_then(|_| self.nodes.get(id))
    }
    fn administers(&self, w: &str, x: &ScopeNode) -> bool {
        x.subject
            .scope
            .as_ref()
            .is_some_and(|s| World::administers(self, w, s))
    }
    fn label(&self, id: &str) -> Option<&str> {
        self.shown
            .as_ref()
            .filter(|shown| !shown.contains(id))
            .map(|_| HIDDEN)
    }
    fn viewer(&self) -> Option<&str> {
        self.viewer.as_deref()
    }
    fn group(&self, name: &str) -> Option<ScopeGroupIdentity> {
        if !valid_group_name(name) {
            return None;
        }
        self.group_by_name(name).map(|g| ScopeGroupIdentity {
            id: g.id,
            policy: g.policy,
            pinned: g.pinned,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SqlValue;
    use serde_json::json;

    fn agent(id: &str, parent: Option<&str>, tree: Option<&str>) -> Row {
        let mut row = Row::new();
        row.insert("id".into(), SqlValue::Text(id.into()));
        row.insert("handle".into(), SqlValue::Text(id.into()));
        row.insert("kind".into(), SqlValue::Text("agent".into()));
        row.insert("labels".into(), SqlValue::Text("{}".into()));
        if let Some(parent) = parent {
            row.insert("parent_ep".into(), SqlValue::Text(parent.into()));
        }
        if let Some(tree) = tree {
            row.insert("tree".into(), SqlValue::Text(tree.into()));
        }
        row
    }

    fn world(endpoints: Vec<Row>, policy: Option<Value>) -> World {
        let mut human = Row::new();
        human.insert("id".into(), SqlValue::Text("h".into()));
        human.insert("handle".into(), SqlValue::Text(HUMAN_HANDLE.into()));
        human.insert("kind".into(), SqlValue::Text("human".into()));
        human.insert("labels".into(), SqlValue::Text("{}".into()));
        let mut rows = endpoints;
        rows.push(human);
        World::build(Tables {
            endpoints: rows,
            groups: vec![],
            members: vec![],
            admins: vec![],
            policy,
            binds: HashMap::new(),
            local_users: HashSet::new(),
            machine: None,
        })
    }

    #[test]
    fn default_reach_is_own_tree_and_roots() {
        let w = world(
            vec![
                agent("r", None, None),
                agent("c", Some("r"), Some("r")),
                agent("x", None, None),
                agent("y", Some("x"), Some("x")),
            ],
            None,
        );
        assert!(w.may_message("c", "r", false, false));
        assert!(w.may_message("c", "x", false, false));
        assert!(!w.may_message("c", "y", false, false));
        assert!(w.authority("r", "c"));
        assert!(!w.authority("c", "r"));
        assert_eq!(w.ancestors_of("c"), vec!["r".to_owned()]);
    }

    #[test]
    fn policy_groups_and_caps_derive_from_selectors() {
        let policy = json!({"rules":[{"match":"handle:c","scope":["tree:parent"]}],"groups":[{"name":"ops","members":["handle:x"]}]});
        let w = world(
            vec![
                agent("r", None, None),
                agent("c", Some("r"), Some("r")),
                agent("x", None, None),
            ],
            Some(policy),
        );
        assert_eq!(w.groups_of("x"), vec!["ops".to_owned()]);
        assert_eq!(w.node_of("c").map(|n| n.policy.len()), Some(2));
        assert!(!w.may_message("c", "x", false, false));
        assert!(w.may_message("c", "r", false, false));
    }
}
