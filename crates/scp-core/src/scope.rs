use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::address::valid_handle;
use crate::protocol::{
    CLI_NAME, ErrorCode, RelayError, SCOPE_PRESETS, ScopeCap, ScopeDirection, ScopeEntry,
    ScopePreset,
};

mod selector;
pub use selector::*;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeRules {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#in: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups: Option<HashMap<ScopeDirection, HashMap<String, String>>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeCaps {
    pub caps: Vec<ScopeCap>,
    pub allow: HashMap<String, Vec<ScopeEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifted: Option<Vec<ScopeDirection>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeGroupRules {
    pub name: String,
    pub owner: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#in: Option<Vec<ScopeEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<Vec<ScopeEntry>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopePolicyCap {
    pub dir: ScopeDirection,
    pub r#match: String,
    pub sels: Vec<ScopeEntry>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeNode {
    pub id: String,
    pub address: String,
    pub subject: PolicySubject,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub human: Option<bool>,
    pub rules: ScopeRules,
    pub caps: ScopeCaps,
    pub groups: Vec<ScopeGroupRules>,
    pub policy: Vec<ScopePolicyCap>,
}

pub trait ScopeWorld {
    fn node(&self, id: &str) -> Option<&ScopeNode>;
    fn administers(&self, w: &str, x: &ScopeNode) -> bool;
    fn label(&self, _id: &str) -> Option<&str> {
        None
    }
    fn viewer(&self) -> Option<&str> {
        None
    }
    fn group(&self, name: &str) -> Option<ScopeGroupIdentity>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeGroupIdentity {
    pub id: String,
    pub policy: bool,
    pub pinned: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeList {
    pub source: String,
    pub by: String,
    pub entries: Vec<ScopeEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cap: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Admission {
    pub ok: bool,
    pub why: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeDecision {
    pub allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<ScopeDirection>,
    pub reasons: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admitted: Option<Vec<String>>,
}

pub type Memo = HashMap<String, bool>;

/// `None` is open; an empty slice is the none preset.
pub fn preset_lists(preset: ScopePreset) -> Option<&'static [&'static str]> {
    match preset {
        ScopePreset::Open => None,
        ScopePreset::Tree => Some(&["tree:parent", "tree:descendants"]),
        ScopePreset::Parent => Some(&["tree:parent"]),
        ScopePreset::None => Some(&[]),
    }
}

pub fn group_cap_key(group: &str, dir: ScopeDirection) -> String {
    format!("group:{group}:{dir}")
}

pub fn is_leaving(sel: &str) -> bool {
    sel == "*"
        || ["ep:", "fleet:", "machine:", "org:", "group:", "acct:"]
            .iter()
            .any(|p| sel.starts_with(p))
}

pub fn effective_selector(list: &ScopeList, entry: &ScopeEntry) -> String {
    if entry.sel == "group:self"
        && let Some(group) = list.group.as_ref().filter(|g| !g.is_empty())
    {
        return format!("group:{group}");
    }
    entry.sel.clone()
}

pub fn scope_lists(node: &ScopeNode, dir: ScopeDirection) -> Vec<ScopeList> {
    let mut lists = Vec::new();
    let own = match dir {
        ScopeDirection::In => &node.rules.r#in,
        ScopeDirection::Out => &node.rules.out,
    };
    if let Some(own) = own {
        let bound = node.rules.groups.as_ref().and_then(|g| g.get(&dir));
        lists.push(ScopeList {
            source: "own rules".into(),
            by: node.id.clone(),
            entries: own
                .iter()
                .map(|sel| ScopeEntry {
                    sel: sel.clone(),
                    group: bound
                        .and_then(|g| g.get(sel))
                        .filter(|g| !g.is_empty())
                        .cloned(),
                    ..Default::default()
                })
                .collect(),
            group: None,
            cap: None,
        });
    }
    for cap in node.caps.caps.iter().filter(|cap| cap.dir == dir) {
        lists.push(ScopeList {
            source: if cap.by == "inherited" {
                "inherited cap".into()
            } else {
                format!("cap {}", cap.id)
            },
            by: cap.by.clone(),
            entries: cap.sels.clone(),
            group: None,
            cap: Some(cap.id.clone()),
        });
    }
    for group in &node.groups {
        let rules = match dir {
            ScopeDirection::In => &group.r#in,
            ScopeDirection::Out => &group.out,
        };
        if let Some(rules) = rules {
            let mut entries = rules.clone();
            if let Some(allow) = node.caps.allow.get(&group_cap_key(&group.name, dir)) {
                entries.extend_from_slice(allow);
            }
            lists.push(ScopeList {
                source: format!("group:{}", group.name),
                by: group.owner.clone(),
                entries,
                group: Some(group.name.clone()),
                cap: None,
            });
        }
    }
    for cap in node.policy.iter().filter(|cap| cap.dir == dir) {
        lists.push(ScopeList {
            source: format!("policy ({})", cap.r#match),
            by: "policy".into(),
            entries: cap.sels.clone(),
            group: None,
            cap: None,
        });
    }
    lists
}

pub fn has_scope(node: &ScopeNode) -> bool {
    !scope_lists(node, ScopeDirection::In).is_empty()
        || !scope_lists(node, ScopeDirection::Out).is_empty()
}

pub fn is_root(x: &ScopeNode) -> bool {
    x.subject.account.is_none()
        && x.subject
            .scope
            .as_ref()
            .is_some_and(|s| s.ancestors.is_empty() && s.root != Some(false))
}

fn default_reach(e: &ScopeNode, x: &ScopeNode) -> bool {
    e.subject.kind != "agent"
        || e.subject.scope.is_none()
        || e.subject.account.is_some()
        || !cross_fleet(e, x)
        || x.subject.account.is_some()
        || x.subject.kind != "agent"
        || x.subject.scope.is_none()
        || is_root(x)
}

fn widens(world: &dyn ScopeWorld, list: &ScopeList, entry: &ScopeEntry) -> bool {
    entry.via.is_some()
        || list.by == "human"
        || list.by == "policy"
        || list
            .group
            .as_ref()
            .is_some_and(|g| world.group(g).is_some_and(|g| g.policy))
        || world
            .node(&list.by)
            .is_some_and(|n| n.subject.kind == "human")
}

const BEYOND: &str = "has the default reach: its own tree and the roots; only the human, the policy or a widening reaches further";

pub fn cross_fleet(e: &ScopeNode, x: &ScopeNode) -> bool {
    if e.subject.account.is_some() || x.subject.account.is_some() {
        return true;
    }
    let Some(b) = &x.subject.scope else {
        return false;
    };
    !b.local
        || e.subject
            .scope
            .as_ref()
            .is_none_or(|a| !a.local || a.tree != b.tree)
}

pub fn clip_passes(
    world: &dyn ScopeWorld,
    via: &str,
    x: &ScopeNode,
    dir: ScopeDirection,
    memo: Option<&mut Memo>,
    base: bool,
) -> bool {
    if via == "human" {
        return true;
    }
    let Some(w) = world.node(via) else {
        return base
            && x.subject
                .scope
                .as_ref()
                .is_some_and(|s| s.ancestors.iter().any(|a| a == via));
    };
    if x.id == w.id
        || x.subject
            .scope
            .as_ref()
            .is_some_and(|s| s.ancestors.contains(&w.id))
        || world.administers(&w.id, x)
    {
        return true;
    }
    let mut fresh = Memo::new();
    let memo = memo.unwrap_or(&mut fresh);
    let key = format!("{}|{dir}|{}", w.id, x.id);
    if let Some(seen) = memo.get(&key) {
        return *seen;
    }
    memo.insert(key.clone(), false);
    let ok = admits(world, w, dir, x, Some(memo)).ok;
    memo.insert(key, ok);
    ok
}

fn entry_admits(
    world: &dyn ScopeWorld,
    e: &ScopeNode,
    list: &ScopeList,
    entry: &ScopeEntry,
    dir: ScopeDirection,
    x: &ScopeNode,
    memo: &mut Memo,
) -> bool {
    let sel = effective_selector(list, entry);
    if !matches(&sel, &x.subject, Some(&e.subject), None) {
        return false;
    }
    if let Some(name) = sel.strip_prefix("group:")
        && entry.sel != "group:self"
    {
        let group = world.group(name);
        if match &entry.group {
            None => !group.as_ref().is_some_and(|g| g.policy),
            Some(id) => group.as_ref().is_none_or(|g| &g.id != id),
        } {
            return false;
        }
    }
    entry
        .via
        .as_ref()
        .is_none_or(|via| clip_passes(world, via, x, dir, Some(memo), entry.base))
}

pub fn leaves_fleet(world: &dyn ScopeWorld, list: &ScopeList, entry: &ScopeEntry) -> bool {
    let sel = effective_selector(list, entry);
    if !is_leaving(&sel) {
        return false;
    }
    let Some(name) = sel.strip_prefix("group:") else {
        return true;
    };
    let setter = entry.via.as_ref().unwrap_or(&list.by);
    setter == "human"
        || setter == "policy"
        || world.group(name).is_some_and(|g| {
            g.policy
                || (g.pinned && (entry.group.as_ref() == Some(&g.id) || entry.sel == "group:self"))
        })
}

fn admission(ok: bool, why: String, by: Vec<String>) -> Admission {
    Admission {
        ok,
        why,
        by: ok.then_some(by),
    }
}

pub fn admits(
    world: &dyn ScopeWorld,
    e: &ScopeNode,
    dir: ScopeDirection,
    x: &ScopeNode,
    memo: Option<&mut Memo>,
) -> Admission {
    let side = format!("{dir}({})", e.address);
    let lists = scope_lists(e, dir);
    if !has_scope(e) {
        if dir == ScopeDirection::In {
            return admission(true, format!("{side} is open"), vec![]);
        }
        return if default_reach(e, x) {
            admission(true, format!("{side} has the default reach"), vec![])
        } else {
            admission(false, format!("{side} {BEYOND}"), vec![])
        };
    }
    let cross = cross_fleet(e, x);
    if lists.is_empty() {
        return admission(
            !cross,
            if cross {
                format!("{side} admits only its own fleet")
            } else {
                format!("{side} has no list")
            },
            vec![],
        );
    }
    let bounded = dir == ScopeDirection::Out && !default_reach(e, x);
    let mut hits = Vec::new();
    let mut by = Vec::new();
    let mut fresh = Memo::new();
    let memo = memo.unwrap_or(&mut fresh);
    for list in &lists {
        let admitting: Vec<_> = list
            .entries
            .iter()
            .filter(|entry| entry_admits(world, e, list, entry, dir, x, memo))
            .collect();
        if admitting.is_empty() {
            return admission(false, limit_text(world, e, list, dir, x, false), vec![]);
        }
        let leaving: Vec<_> = admitting
            .iter()
            .copied()
            .filter(|entry| leaves_fleet(world, list, entry))
            .collect();
        if cross && leaving.is_empty() {
            return admission(false, limit_text(world, e, list, dir, x, true), vec![]);
        }
        let candidates = if cross { &leaving } else { &admitting };
        let entry = if bounded {
            candidates
                .iter()
                .copied()
                .find(|entry| widens(world, list, entry))
        } else {
            candidates.first().copied()
        };
        let Some(entry) = entry else {
            return admission(false, format!("{side} {BEYOND}"), vec![]);
        };
        let via = entry
            .via
            .as_deref()
            .map(|via| {
                if via == "human" {
                    "the human"
                } else {
                    world
                        .label(via)
                        .or_else(|| world.node(via).map(|n| n.address.as_str()))
                        .unwrap_or(via)
                }
            })
            .unwrap_or("");
        let sel = format!(
            "{}{}",
            effective_selector(list, entry),
            if via.is_empty() {
                String::new()
            } else {
                format!(" via {via}")
            }
        );
        hits.push(format!("by {sel} ({})", list_name(world, e, list)));
        by.push(sel);
    }
    admission(
        true,
        format!("{side} admits {} {}", x.address, hits.join(", ")),
        by,
    )
}

fn short(e: &ScopeNode) -> &str {
    e.address.strip_prefix("me/").unwrap_or(&e.address)
}

fn name_of(world: &dyn ScopeWorld, id: &str, e: &ScopeNode) -> String {
    if id == "human" {
        return "the human".into();
    }
    if Some(id) == world.viewer() {
        return "you".into();
    }
    if let Some(label) = world.label(id).filter(|s| !s.is_empty()) {
        return label.into();
    }
    let Some(node) = world.node(id) else {
        return "a released endpoint".into();
    };
    let ancestors = e
        .subject
        .scope
        .as_ref()
        .map(|s| s.ancestors.as_slice())
        .unwrap_or_default();
    let relation = if ancestors.first().is_some_and(|a| a == id) {
        Some("parent")
    } else if ancestors.iter().any(|a| a == id) {
        Some("ancestor")
    } else {
        None
    };
    match relation {
        Some(rel) => format!(
            "{} ({} {rel})",
            node.address,
            if world.viewer() == Some(&e.id) {
                "your".into()
            } else {
                format!("{}'s", short(e))
            }
        ),
        None => node.address.clone(),
    }
}

fn list_name(world: &dyn ScopeWorld, e: &ScopeNode, list: &ScopeList) -> String {
    if list.source == "own rules" {
        return if world.viewer() == Some(&e.id) {
            "your own rules".into()
        } else {
            format!("{}'s own rules", short(e))
        };
    }
    if list.source.starts_with("policy") {
        return format!("the {}", list.source);
    }
    if let Some(group) = list.group.as_ref().filter(|s| !s.is_empty()) {
        return format!("group {group}'s rules");
    }
    if list.by == "inherited" {
        return "an inherited limit".into();
    }
    format!("a limit set by {}", name_of(world, &list.by, e))
}

fn selector_for(x: &ScopeNode) -> String {
    if let Some(s) = &x.subject.scope
        && !s.local
        && let Some(machine) = s.machine.as_ref().filter(|s| !s.is_empty())
    {
        return format!("machine:{machine}");
    }
    if x.subject.kind == "agent" && valid_handle(&x.subject.handle) {
        return format!("ep:{}", x.subject.handle);
    }
    format!("kind:{}", x.subject.kind)
}

fn limit_text(
    world: &dyn ScopeWorld,
    e: &ScopeNode,
    list: &ScopeList,
    dir: ScopeDirection,
    x: &ScopeNode,
    cross: bool,
) -> String {
    let you = world.viewer() == Some(&e.id);
    let whose = if dir == ScopeDirection::Out {
        format!(
            "{} messages",
            if you {
                "your".into()
            } else {
                format!("{}'s", short(e))
            }
        )
    } else {
        format!("who may message {}", if you { "you" } else { short(e) })
    };
    let sels = unique(
        list.entries
            .iter()
            .map(|entry| effective_selector(list, entry))
            .collect(),
    );
    let joined = sels.join(",");
    let to = format!(
        "{}{}",
        if joined.is_empty() { "nobody" } else { &joined },
        if cross {
            " only within its own fleet"
        } else {
            ""
        }
    );
    let add = selector_for(x);
    let widen = format!(
        "widen with {CLI_NAME} rules widen {} --{dir} {add}",
        short(e)
    );
    if list.source == "own rules" {
        let mut added = sels;
        added.push(add);
        let set = format!("{CLI_NAME} rules set --{dir} {}", added.join(","));
        return if you {
            format!("your own rules limit {whose} to {to}; widen them with {set}")
        } else {
            format!(
                "{}'s own rules limit {whose} to {to}; {} widens them with {set}",
                short(e),
                short(e)
            )
        };
    }
    if list.source.starts_with("policy") {
        let source = list
            .source
            .strip_prefix("policy (")
            .and_then(|s| s.strip_suffix(')'))
            .map(|s| format!("policy rule for {s}"))
            .unwrap_or_else(|| list.source.clone());
        return format!(
            "the {source} limits {whose} to {to}; change it in the policy file ({CLI_NAME} policy path)"
        );
    }
    if let Some(group) = list.group.as_ref().filter(|s| !s.is_empty()) {
        return format!(
            "group {group}'s rules (set by {}) limit {whose} to {to}; {widen}",
            if list.by == "policy" {
                "the policy file".into()
            } else {
                name_of(world, &list.by, e)
            }
        );
    }
    if list.by == "inherited" {
        let reach = e
            .subject
            .scope
            .as_ref()
            .and_then(|s| s.ancestors.first())
            .filter(|s| !s.is_empty())
            .map(|parent| format!("what {} reaches", name_of(world, parent, e)))
            .unwrap_or_else(|| "what its parent reached".into());
        let limit = if dir == ScopeDirection::Out {
            format!("{whose} reach only {reach}")
        } else {
            format!(
                "only {reach} may message {}",
                if you { "you" } else { short(e) }
            )
        };
        return format!("{limit}, an inherited limit; {widen}");
    }
    let setter = name_of(world, &list.by, e);
    format!(
        "{setter} {} {whose} to {to}; {widen}",
        if setter == "you" { "limit" } else { "limits" }
    )
}

pub fn relation_text(peer: &PolicySubject, me: &PolicySubject) -> String {
    let Some(rel) = relation(peer, me) else {
        return "on the relay".into();
    };
    match rel.as_str() {
        "human" => "the human".into(),
        "tree" => "in your tree".into(),
        _ => {
            if let Some(group) = rel.strip_prefix("group:") {
                format!("in group {group} with you")
            } else if let Some(fleet) = rel.strip_prefix("fleet:") {
                format!("in fleet {fleet}")
            } else {
                format!("your {rel}")
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeDecisionOptions {
    pub human_always: bool,
    #[serde(default)]
    pub solicited: bool,
    #[serde(default)]
    pub linked: bool,
    #[serde(default)]
    pub unverified: bool,
    #[serde(default)]
    pub strict: bool,
}

pub fn scope_decision(
    world: &dyn ScopeWorld,
    a: &ScopeNode,
    b: &ScopeNode,
    options: ScopeDecisionOptions,
) -> ScopeDecision {
    let pass = |why| ScopeDecision {
        allowed: true,
        dir: None,
        reasons: vec![why],
        admitted: None,
    };
    if a.subject.kind == "system" || b.subject.kind == "system" {
        return pass("the relay itself".into());
    }
    if options.human_always
        && (b.human == Some(true) || (a.human == Some(true) && !options.unverified))
    {
        return pass("the human is always reachable".into());
    }
    if !options.strict && is_ancestor(a, b) {
        return pass(format!(
            "{} is an ancestor of {}: scopes never stop it",
            a.address, b.address
        ));
    }
    if options.solicited {
        return pass(format!("a reply to {}'s message in its thread", b.address));
    }
    if options.linked {
        return pass(format!(
            "{} and {} are parent and child across machines",
            a.address, b.address
        ));
    }
    let mut memo = Memo::new();
    let out = admits(world, a, ScopeDirection::Out, b, Some(&mut memo));
    if !out.ok {
        return ScopeDecision {
            allowed: false,
            dir: Some(ScopeDirection::Out),
            reasons: vec![out.why],
            admitted: None,
        };
    }
    let into = admits(world, b, ScopeDirection::In, a, Some(&mut memo));
    if !into.ok {
        return ScopeDecision {
            allowed: false,
            dir: Some(ScopeDirection::In),
            reasons: vec![out.why, into.why],
            admitted: None,
        };
    }
    ScopeDecision {
        allowed: true,
        dir: None,
        reasons: vec![out.why, into.why],
        admitted: Some(
            out.by
                .unwrap_or_default()
                .into_iter()
                .chain(into.by.unwrap_or_default())
                .collect(),
        ),
    }
}

pub fn clipped(
    world: &dyn ScopeWorld,
    via: &str,
    sel: &str,
    anchor: &ScopeNode,
    dir: ScopeDirection,
    candidates: &[ScopeNode],
) -> bool {
    let matching: Vec<_> = candidates
        .iter()
        .filter(|x| x.id != anchor.id && matches(sel, &x.subject, Some(&anchor.subject), None))
        .collect();
    !matching.is_empty()
        && !matching
            .iter()
            .any(|x| clip_passes(world, via, x, dir, None, false))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpandRulesParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ScopePreset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#in: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<Vec<String>>,
}

/// Missing keys leave a direction alone; `None` clears its list.
pub type ExpandedRules = HashMap<ScopeDirection, Option<Vec<String>>>;

pub fn expand_rules(
    params: &ExpandRulesParams,
    symmetric: bool,
) -> Result<ExpandedRules, RelayError> {
    let mut result = HashMap::new();
    if params.scope.is_some() || params.allow.is_some() {
        if params.scope == Some(ScopePreset::Open)
            && params.allow.as_ref().is_some_and(|a| !a.is_empty())
        {
            return Err(RelayError::new(
                ErrorCode::InvalidParams,
                "allow adds to a preset with a list: tree, parent or none",
            ));
        }
        let list = if params.scope == Some(ScopePreset::Open) {
            None
        } else {
            let mut list: Vec<_> = params
                .scope
                .and_then(preset_lists)
                .unwrap_or_default()
                .iter()
                .map(|s| (*s).into())
                .collect();
            list.extend(params.allow.clone().unwrap_or_default());
            Some(unique(list))
        };
        if symmetric {
            result.insert(ScopeDirection::In, list.clone());
        }
        result.insert(ScopeDirection::Out, list);
    }
    if let Some(list) = &params.r#in {
        result.insert(ScopeDirection::In, Some(unique(list.clone())));
    }
    if let Some(list) = &params.out {
        result.insert(ScopeDirection::Out, Some(unique(list.clone())));
    }
    Ok(result)
}

pub fn preset_of(node: &ScopeNode, symmetric: bool) -> &'static str {
    let set = |dir| {
        let lists = scope_lists(node, dir);
        let own: Vec<_> = lists
            .iter()
            .filter(|list| list.by != "inherited")
            .cloned()
            .collect();
        if own.is_empty() { lists } else { own }
    };
    let ins = set(ScopeDirection::In);
    let outs = set(ScopeDirection::Out);
    if ins.is_empty() && outs.is_empty() {
        return "open";
    }
    for &preset in SCOPE_PRESETS {
        let Some(list) = preset_lists(preset) else {
            continue;
        };
        let is = |lists: &[ScopeList]| {
            lists.len() == 1
                && same_set(
                    &lists[0]
                        .entries
                        .iter()
                        .map(|e| effective_selector(&lists[0], e))
                        .collect::<Vec<_>>(),
                    list,
                )
        };
        if if symmetric {
            is(&ins) && is(&outs)
        } else {
            is(&outs) && ins.is_empty()
        } {
            return preset.as_str();
        }
    }
    "custom"
}

pub fn narrower(next: Option<&[String]>, prev: Option<&[String]>) -> bool {
    let Some(prev) = prev else {
        return true;
    };
    next.is_some_and(|next| {
        next.iter().all(|sel| {
            prev.contains(sel)
                || (sel.starts_with("tree:") && prev.iter().any(|s| s == "tree:self"))
        })
    })
}

pub fn is_ancestor(a: &ScopeNode, b: &ScopeNode) -> bool {
    a.subject.kind == "agent"
        && a.subject
            .scope
            .as_ref()
            .zip(b.subject.scope.as_ref())
            .is_some_and(|(s, x)| {
                x.local && s.local && x.tree == s.tree && x.ancestors.contains(&a.id)
            })
}

pub fn relation(sender: &PolicySubject, recipient: &PolicySubject) -> Option<String> {
    if sender.kind == "human" {
        return Some("human".into());
    }
    let s = sender.scope.as_ref()?;
    let r = recipient.scope.as_ref()?;
    if !s.local || !r.local || s.tree != r.tree {
        return Some(format!("fleet:{}", s.root_handle));
    }
    if r.ancestors.first() == Some(&s.id) {
        return Some("parent".into());
    }
    if s.ancestors.first() == Some(&r.id) {
        return Some("child".into());
    }
    if r.ancestors.contains(&s.id) {
        return Some("ancestor".into());
    }
    if s.ancestors.contains(&r.id) {
        return Some("descendant".into());
    }
    if !s.ancestors.is_empty() && s.ancestors.first() == r.ancestors.first() {
        return Some("sibling".into());
    }
    if let Some(shared) = s
        .groups
        .iter()
        .find(|g| r.groups.contains(g))
        .filter(|s| !s.is_empty())
    {
        return Some(format!("group:{shared}"));
    }
    Some("tree".into())
}

fn unique(list: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for sel in list {
        if !result.contains(&sel) {
            result.push(sel);
        }
    }
    result
}

fn same_set(a: &[String], b: &[&str]) -> bool {
    a.len() == b.len() && a.iter().all(|sel| b.contains(&sel.as_str()))
}

#[cfg(test)]
mod tests;
