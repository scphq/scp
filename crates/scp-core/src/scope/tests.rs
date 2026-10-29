use super::*;
use ScopeDirection::{In, Out};
use serde_json::json;

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).into()).collect()
}
fn entries(list: &[&str]) -> Vec<ScopeEntry> {
    list.iter()
        .map(|s| ScopeEntry {
            sel: (*s).into(),
            ..Default::default()
        })
        .collect()
}
fn node(id: &str, ancestors: &[&str]) -> ScopeNode {
    ScopeNode {
        id: id.into(),
        address: format!("me/{id}"),
        subject: PolicySubject {
            handle: id.into(),
            harness: Some("cli".into()),
            kind: "agent".into(),
            scope: Some(ScopeSubject {
                id: id.into(),
                tree: ancestors.last().unwrap_or(&id).to_string(),
                ancestors: strings(ancestors),
                groups: vec![],
                root_handle: ancestors.last().unwrap_or(&id).to_string(),
                machine: Some("laptop".into()),
                local: true,
                root: None,
            }),
            ..Default::default()
        },
        ..Default::default()
    }
}
fn cap(by: &str, dir: ScopeDirection, list: &[&str]) -> ScopeCap {
    ScopeCap {
        id: "c1".into(),
        by: by.into(),
        dir,
        sels: entries(list),
    }
}
fn via(sel: &str, widener: &str) -> ScopeEntry {
    ScopeEntry {
        sel: sel.into(),
        via: Some(widener.into()),
        ..Default::default()
    }
}
#[derive(Default)]
struct World {
    nodes: HashMap<String, ScopeNode>,
    groups: HashMap<String, ScopeGroupIdentity>,
    viewer: Option<String>,
    labels: HashMap<String, String>,
    admins: Vec<(String, String)>,
}
impl World {
    fn new(nodes: &[ScopeNode]) -> Self {
        Self {
            nodes: nodes.iter().map(|n| (n.id.clone(), n.clone())).collect(),
            ..Default::default()
        }
    }
    fn identity(&mut self, policy: bool, pinned: bool) {
        self.groups.insert(
            "team".into(),
            ScopeGroupIdentity {
                id: "g1".into(),
                policy,
                pinned,
            },
        );
    }
}
impl ScopeWorld for World {
    fn node(&self, id: &str) -> Option<&ScopeNode> {
        self.nodes.get(id)
    }
    fn administers(&self, w: &str, x: &ScopeNode) -> bool {
        self.admins.contains(&(w.into(), x.id.clone()))
    }
    fn group(&self, name: &str) -> Option<ScopeGroupIdentity> {
        self.groups.get(name).cloned()
    }
    fn viewer(&self) -> Option<&str> {
        self.viewer.as_deref()
    }
    fn label(&self, id: &str) -> Option<&str> {
        self.labels.get(id).map(String::as_str)
    }
}

#[test]
fn selector_grammar() {
    for sel in [
        "*",
        "ep:a",
        "ep:me",
        "handle:*a.b_-*",
        "harness:-a",
        "kind:agent",
        "kind:human",
        "label:._-=",
        "label:a=x=y",
        "group:team",
        "group:org/team",
        "fleet:r",
        "fleet:*",
        "machine:Desk._-1",
        "org:team",
        "org:*",
        "acct:peer",
        "acct:*",
        "tree:self",
        "tree:root",
        "tree:parent",
        "tree:siblings",
        "tree:children",
        "tree:ancestors",
        "tree:ancestors:16",
        "tree:descendants",
        "tree:descendants:1",
    ] {
        assert!(
            valid_selector(sel, ValidSelectorOptions::default()),
            "{sel}"
        );
        assert_eq!(
            valid_selector(
                sel,
                ValidSelectorOptions {
                    absolute: true,
                    ..Default::default()
                }
            ),
            !sel.starts_with("tree:"),
            "{sel}"
        );
    }
    for sel in [
        "",
        "a",
        "ep:A",
        "ep:-a",
        "ep:a*",
        "handle:a?",
        "handle:",
        "harness:a.b",
        "kind:system",
        "label:a=has space",
        "label:a=\u{feff}",
        "group:a/b/c",
        "fleet:",
        "machine:-a",
        "acct:Peer",
        "acct:p.q",
        "tree:ancestors:0",
        "tree:ancestors:17",
        "tree:descendants:01",
        "tree:children:1",
        "tree:cousins",
        "group:self",
    ] {
        assert!(
            !valid_selector(sel, ValidSelectorOptions::default()),
            "{sel}"
        );
    }
    assert!(valid_selector(
        "group:self",
        ValidSelectorOptions {
            absolute: true,
            group_rules: true
        }
    ));
    assert!(valid_group_name("self"));
    assert!(valid_group_name(&"a".repeat(63)));
    assert!(!valid_group_name(&"a".repeat(64)));
    assert!(!valid_group_name("A"));
    for (prefix, len) in [
        ("ep:", 63),
        ("handle:", 63),
        ("harness:", 32),
        ("machine:", 63),
        ("acct:", 64),
    ] {
        assert!(valid_selector(
            &format!("{prefix}{}", "a".repeat(len)),
            ValidSelectorOptions::default()
        ));
        assert!(!valid_selector(
            &format!("{prefix}{}", "a".repeat(len + 1)),
            ValidSelectorOptions::default()
        ));
    }
    assert!(valid_selector(
        &format!("label:k={}", "😀".repeat(64)),
        ValidSelectorOptions::default()
    ));
    assert!(!valid_selector(
        &format!("label:k={}", "😀".repeat(65)),
        ValidSelectorOptions::default()
    ));
    assert!(!valid_selector("ep:a\n", ValidSelectorOptions::default()));
}

#[test]
fn relative_selectors() {
    let all = [
        node("r", &[]),
        node("c1", &["r"]),
        node("c2", &["r"]),
        node("g", &["c1", "r"]),
        node("h", &["g", "c1", "r"]),
    ];
    for (sel, anchor, expected) in [
        ("tree:self", 3, vec!["r", "c1", "c2", "g", "h"]),
        ("tree:root", 4, vec!["r"]),
        ("tree:parent", 3, vec!["c1"]),
        ("tree:ancestors", 4, vec!["r", "c1", "g"]),
        ("tree:ancestors:1", 4, vec!["g"]),
        ("tree:ancestors:2", 4, vec!["c1", "g"]),
        ("tree:children", 0, vec!["c1", "c2"]),
        ("tree:descendants", 0, vec!["c1", "c2", "g", "h"]),
        ("tree:descendants:2", 0, vec!["c1", "c2", "g"]),
        ("tree:siblings", 1, vec!["c2"]),
        ("tree:siblings", 0, vec![]),
        ("tree:parent", 0, vec![]),
    ] {
        let hits: Vec<_> = all
            .iter()
            .filter(|n| matches(sel, &n.subject, Some(&all[anchor].subject), None))
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(hits, expected, "{sel}");
    }
    assert!(!matches("tree:self", &all[3].subject, None, None));
    let mut remote = all[3].clone();
    remote.subject.scope.as_mut().unwrap().local = false;
    assert!(!matches(
        "tree:self",
        &remote.subject,
        Some(&all[0].subject),
        None
    ));
    let chain: Vec<_> = (0..20).map(|i| format!("n{i}")).collect();
    let mut deep = node("deep", &[]);
    deep.subject.scope.as_mut().unwrap().ancestors = chain;
    let mut root = node("n19", &[]);
    root.subject.scope.as_mut().unwrap().tree = "deep".into();
    assert!(matches(
        "tree:ancestors",
        &root.subject,
        Some(&deep.subject),
        None
    ));
    assert!(!matches(
        "tree:ancestors:16",
        &root.subject,
        Some(&deep.subject),
        None
    ));
}

#[test]
fn absolute_selectors_and_contacts() {
    let mut n = node("relay-a.b", &["r"]);
    n.subject.labels.insert("lane".into(), "relay".into());
    n.subject.scope.as_mut().unwrap().groups = strings(&["team"]);
    for sel in [
        "*",
        "ep:relay-a.b",
        "handle:relay-*.b",
        "handle:*a.b",
        "harness:cli",
        "kind:agent",
        "label:lane=relay",
        "group:team",
        "fleet:r",
        "fleet:*",
        "machine:laptop",
    ] {
        assert!(matches(sel, &n.subject, None, None), "{sel}");
    }
    for sel in [
        "ep:r",
        "handle:relay-axb",
        "handle:relay-a?b",
        "harness:other",
        "kind:human",
        "label:lane=other",
        "group:other",
        "group:self",
        "group:org/team",
        "fleet:other",
        "machine:desk",
        "org:*",
        "org:team",
        "acct:peer",
        "acct:*",
    ] {
        assert!(!matches(sel, &n.subject, None, None), "{sel}");
    }
    assert!(!matches("group:team", &n.subject, None, Some(&|_| false)));
    assert!(matches(
        "group:team",
        &n.subject,
        None,
        Some(&|g| g == "team")
    ));
    n.subject.scope.as_mut().unwrap().local = false;
    assert!(!matches("fleet:*", &n.subject, None, None));
    assert!(matches("machine:laptop", &n.subject, None, None));
    let human = PolicySubject {
        kind: "human".into(),
        ..Default::default()
    };
    assert!(matches("kind:human", &human, None, None));
    for sel in [
        "handle:*",
        "ep:",
        "tree:self",
        "group:team",
        "fleet:*",
        "machine:laptop",
    ] {
        assert!(!matches(sel, &human, Some(&n.subject), None));
    }
    n.subject.account = Some("peer".into());
    assert!(matches("acct:peer", &n.subject, None, None));
    assert!(matches("acct:*", &n.subject, None, None));
    for sel in [
        "*",
        "ep:relay-a.b",
        "handle:*",
        "harness:cli",
        "kind:agent",
        "label:lane=relay",
        "group:team",
        "fleet:*",
        "machine:laptop",
        "tree:self",
        "acct:other",
    ] {
        assert!(!matches(sel, &n.subject, Some(&n.subject), None));
    }
}

#[test]
fn default_reach_and_unlisted_direction() {
    let mut e = node("e", &["r"]);
    let root = node("other", &[]);
    let child = node("x", &["other"]);
    let world = World::default();
    assert_eq!(admits(&world, &e, In, &child, None).why, "in(me/e) is open");
    assert_eq!(
        admits(&world, &e, Out, &root, None).why,
        "out(me/e) has the default reach"
    );
    assert_eq!(
        admits(&world, &e, Out, &child, None).why,
        format!("out(me/e) {BEYOND}")
    );
    assert!(is_root(&root));
    let mut unplaced = root.clone();
    unplaced.subject.scope.as_mut().unwrap().root = Some(false);
    assert!(!is_root(&unplaced));
    assert!(!admits(&world, &e, Out, &unplaced, None).ok);
    e.rules.r#in = Some(vec![]);
    assert!(has_scope(&e));
    assert_eq!(
        admits(&world, &e, Out, &root, None).why,
        "out(me/e) admits only its own fleet"
    );
    assert_eq!(
        admits(&world, &e, Out, &node("s", &["r"]), None).why,
        "out(me/e) has no list"
    );
    let mut human = node("human", &[]);
    human.subject.scope = None;
    human.subject.kind = "human".into();
    assert!(!cross_fleet(&e, &human));
    assert!(cross_fleet(&human, &e));
    assert!(admits(&world, &human, Out, &child, None).ok);
}

#[test]
fn own_rules_and_caps_intersect() {
    let mut e = node("e", &["r"]);
    let sibling = node("s", &["r"]);
    let mut world = World::new(&[e.clone(), sibling.clone()]);
    world.viewer = Some("e".into());
    e.rules.out = Some(strings(&["tree:parent", "tree:siblings"]));
    assert_eq!(
        admits(&world, &e, Out, &sibling, None),
        Admission {
            ok: true,
            why: "out(me/e) admits me/s by tree:siblings (your own rules)".into(),
            by: Some(strings(&["tree:siblings"]))
        }
    );
    e.caps.caps.push(cap("human", Out, &["tree:parent"]));
    assert_eq!(
        admits(&world, &e, Out, &sibling, None).why,
        "the human limits your messages to tree:parent; widen with swarm rules widen e --out ep:s"
    );
    e.caps.caps[0].sels.push(via("ep:s", "human"));
    let admitted = admits(&world, &e, Out, &sibling, None);
    assert_eq!(
        admitted.by,
        Some(strings(&["tree:siblings", "ep:s via the human"]))
    );
    assert_eq!(
        admitted.why,
        "out(me/e) admits me/s by tree:siblings (your own rules), by ep:s via the human (a limit set by the human)"
    );
    e.rules.out = Some(vec![]);
    assert_eq!(
        admits(&world, &e, Out, &sibling, None).why,
        "your own rules limit your messages to nobody; widen them with swarm rules set --out ep:s"
    );
}

#[test]
fn cross_fleet_requires_leaving_and_widening_in_every_list() {
    let mut e = node("e", &["r"]);
    let root = node("other", &[]);
    let child = node("x", &["other"]);
    let world = World::default();
    e.rules.out = Some(strings(&["handle:*"]));
    assert_eq!(
        admits(&world, &e, Out, &root, None).why,
        "e's own rules limit e's messages to handle:* only within its own fleet; e widens them with swarm rules set --out handle:*,ep:other"
    );
    e.rules.out = Some(strings(&["*"]));
    assert!(admits(&world, &e, Out, &root, None).ok);
    assert_eq!(
        admits(&world, &e, Out, &child, None).why,
        format!("out(me/e) {BEYOND}")
    );
    e.rules.out = None;
    e.caps.caps.push(cap("human", Out, &["*"]));
    assert!(admits(&world, &e, Out, &child, None).ok);
    e.caps.caps.push(cap("e", Out, &["*"]));
    assert!(!admits(&world, &e, Out, &child, None).ok);
    e.caps.caps[1].sels[0].via = Some("human".into());
    assert!(admits(&world, &e, Out, &child, None).ok);
}

#[test]
fn group_identity_and_allowances() {
    let mut e = node("e", &["r"]);
    let mut x = node("x", &["r"]);
    x.subject.scope.as_mut().unwrap().groups = strings(&["team"]);
    e.rules.out = Some(strings(&["group:team"]));
    let mut world = World::default();
    world.identity(false, false);
    assert!(!admits(&world, &e, Out, &x, None).ok);
    e.rules.groups = Some(HashMap::from([(
        Out,
        HashMap::from([("group:team".into(), "g1".into())]),
    )]));
    assert!(admits(&world, &e, Out, &x, None).ok);
    world.groups.get_mut("team").unwrap().id = "g2".into();
    assert!(!admits(&world, &e, Out, &x, None).ok);
    world.identity(true, false);
    e.rules.groups = None;
    assert!(admits(&world, &e, Out, &x, None).ok);
    e.rules.out = None;
    e.groups.push(ScopeGroupRules {
        name: "team".into(),
        owner: "r".into(),
        out: Some(entries(&["group:self"])),
        ..Default::default()
    });
    assert!(admits(&world, &e, Out, &x, None).ok);
    let other = node("other", &[]);
    assert!(!admits(&world, &e, Out, &other, None).ok);
    e.caps.allow.insert(
        group_cap_key("team", Out),
        vec![via("fleet:other", "human")],
    );
    assert_eq!(
        admits(&world, &e, Out, &other, None).by,
        Some(strings(&["fleet:other via the human"]))
    );
    let list = &scope_lists(&e, Out)[0];
    assert_eq!(effective_selector(list, &list.entries[0]), "group:team");
    world.identity(false, false);
    assert!(!leaves_fleet(&world, list, &list.entries[0]));
    world.identity(false, true);
    assert!(leaves_fleet(&world, list, &list.entries[0]));
    assert!(!leaves_fleet(&world, list, &entries(&["group:team"])[0]));
    assert!(leaves_fleet(&world, list, &via("group:team", "human")));
    world.identity(true, false);
    assert!(leaves_fleet(&world, list, &entries(&["group:team"])[0]));
}

#[test]
fn policy_caps_and_human_setters_widen() {
    let mut e = node("e", &["r"]);
    let x = node("x", &["other"]);
    let mut world = World::default();
    e.policy.push(ScopePolicyCap {
        dir: Out,
        r#match: "harness:cli".into(),
        sels: entries(&["ep:x"]),
    });
    assert!(admits(&world, &e, Out, &x, None).ok);
    e.policy[0].sels.clear();
    assert_eq!(
        admits(&world, &e, Out, &x, None).why,
        "the policy rule for harness:cli limits e's messages to nobody; change it in the policy file (swarm policy path)"
    );
    e.policy.clear();
    let mut human = node("h", &[]);
    human.subject.kind = "human".into();
    world.nodes.insert(human.id.clone(), human);
    e.caps.caps.push(cap("h", Out, &["ep:x"]));
    assert!(admits(&world, &e, Out, &x, None).ok);
    e.caps.caps.clear();
    e.groups.push(ScopeGroupRules {
        name: "team".into(),
        owner: "e".into(),
        out: Some(entries(&["ep:x"])),
        ..Default::default()
    });
    world.identity(true, false);
    assert!(admits(&world, &e, Out, &x, None).ok);
    world.identity(false, true);
    assert!(!admits(&world, &e, Out, &x, None).ok);
}

#[test]
fn clipping_tracks_widener_reach_cycles_and_release() {
    let mut e = node("e", &["r"]);
    let mut w = node("w", &["r"]);
    let x = node("x", &["other"]);
    e.caps.caps.push(cap("w", Out, &[]));
    e.caps.caps[0].sels = vec![via("ep:x", "w")];
    w.caps.caps.push(cap("human", Out, &["ep:x"]));
    let mut world = World::new(&[w.clone()]);
    world.labels.insert("w".into(), "your lead".into());
    assert_eq!(
        admits(&world, &e, Out, &x, None).by,
        Some(strings(&["ep:x via your lead"]))
    );
    w.caps.caps[0].sels.clear();
    world.nodes.insert("w".into(), w.clone());
    assert!(!admits(&world, &e, Out, &x, None).ok);
    world.admins.push(("w".into(), "x".into()));
    assert!(admits(&world, &e, Out, &x, None).ok);
    world.admins.clear();
    w.caps.caps[0].sels = vec![via("ep:x", "e")];
    world.nodes.insert("e".into(), e.clone());
    world.nodes.insert("w".into(), w);
    let mut memo = Memo::new();
    assert!(!clip_passes(&world, "w", &x, Out, Some(&mut memo), false));
    assert_eq!(memo.get("w|out|x"), Some(&false));
    assert!(clip_passes(&world, "human", &x, Out, None, false));
    assert!(clip_passes(
        &world,
        "w",
        &node("child", &["w", "r"]),
        Out,
        None,
        false
    ));
    assert!(clip_passes(
        &world,
        "w",
        world.node("w").unwrap(),
        Out,
        None,
        false
    ));
    world.nodes.remove("w");
    let child = node("child", &["w", "r"]);
    assert!(!clip_passes(&world, "w", &child, Out, None, false));
    assert!(clip_passes(&world, "w", &child, Out, None, true));
    assert!(!clip_passes(&world, "w", &x, Out, None, true));
    assert!(!clipped(
        &world,
        "w",
        "ep:future",
        &e,
        Out,
        std::slice::from_ref(&x)
    ));
    assert!(clipped(
        &world,
        "w",
        "ep:x",
        &e,
        Out,
        std::slice::from_ref(&x)
    ));
    assert!(!clipped(
        &world,
        "human",
        "ep:x",
        &e,
        Out,
        std::slice::from_ref(&x)
    ));
    assert!(!clipped(
        &world,
        "w",
        "ep:e",
        &e,
        Out,
        std::slice::from_ref(&e)
    ));
}

#[test]
fn contacts_require_account_selectors_in_all_lists() {
    let mut e = node("e", &[]);
    let mut peer = node("review", &[]);
    peer.subject.scope = None;
    peer.subject.account = Some("peer".into());
    let world = World::default();
    assert!(cross_fleet(&e, &peer));
    assert!(admits(&world, &e, Out, &peer, None).ok);
    e.rules.out = Some(strings(&["*"]));
    assert!(!admits(&world, &e, Out, &peer, None).ok);
    e.rules.out = Some(strings(&["acct:peer"]));
    assert!(admits(&world, &e, Out, &peer, None).ok);
    e.caps.caps.push(cap("human", Out, &["fleet:*"]));
    assert!(!admits(&world, &e, Out, &peer, None).ok);
    e.caps.caps[0].sels = entries(&["acct:*"]);
    assert!(admits(&world, &e, Out, &peer, None).ok);
    for sel in [
        "*",
        "ep:x",
        "fleet:*",
        "machine:desk",
        "org:*",
        "group:team",
        "acct:peer",
    ] {
        assert!(is_leaving(sel));
    }
    for sel in [
        "handle:*",
        "kind:agent",
        "harness:cli",
        "tree:self",
        "label:k=v",
    ] {
        assert!(!is_leaving(sel));
    }
}

#[test]
fn decision_reasons_and_bypasses() {
    let mut a = node("a", &["r"]);
    let mut b = node("b", &["r"]);
    let mut world = World::default();
    let opts = ScopeDecisionOptions::default();
    assert_eq!(
        scope_decision(&world, &a, &b, opts),
        ScopeDecision {
            allowed: true,
            dir: None,
            reasons: strings(&["out(me/a) has the default reach", "in(me/b) is open"]),
            admitted: Some(vec![])
        }
    );
    a.rules.out = Some(vec![]);
    let no = scope_decision(&world, &a, &b, opts);
    assert_eq!(no.dir, Some(Out));
    assert_eq!(
        no.reasons,
        strings(&[
            "a's own rules limit a's messages to nobody; a widens them with swarm rules set --out ep:b"
        ])
    );
    a.rules.out = Some(strings(&["ep:b"]));
    b.rules.r#in = Some(vec![]);
    world.viewer = Some("b".into());
    let no = scope_decision(&world, &a, &b, opts);
    assert_eq!(no.dir, Some(In));
    assert_eq!(
        no.reasons,
        strings(&[
            "out(me/a) admits me/b by ep:b (a's own rules)",
            "your own rules limit who may message you to nobody; widen them with swarm rules set --in ep:a"
        ])
    );
    b.rules.r#in = Some(strings(&["ep:a"]));
    assert_eq!(
        scope_decision(&world, &a, &b, opts).admitted,
        Some(strings(&["ep:b", "ep:a"]))
    );
    b.rules.r#in = Some(vec![]);
    for (options, reason) in [
        (
            ScopeDecisionOptions {
                solicited: true,
                ..opts
            },
            "a reply to me/b's message in its thread",
        ),
        (
            ScopeDecisionOptions {
                linked: true,
                ..opts
            },
            "me/a and me/b are parent and child across machines",
        ),
    ] {
        assert_eq!(
            scope_decision(&world, &a, &b, options).reasons,
            strings(&[reason])
        );
    }
    a.subject.kind = "system".into();
    assert_eq!(
        scope_decision(&world, &a, &b, opts).reasons,
        strings(&["the relay itself"])
    );
    a.subject.kind = "human".into();
    a.human = Some(true);
    let human_opts = ScopeDecisionOptions {
        human_always: true,
        ..opts
    };
    assert_eq!(
        scope_decision(&world, &a, &b, human_opts).reasons,
        strings(&["the human is always reachable"])
    );
    assert!(
        !scope_decision(
            &world,
            &a,
            &b,
            ScopeDecisionOptions {
                unverified: true,
                ..human_opts
            }
        )
        .allowed
    );
    a.human = Some(false);
    assert!(!scope_decision(&world, &a, &b, human_opts).allowed);
    b.human = Some(true);
    assert!(scope_decision(&world, &a, &b, human_opts).allowed);
    let root = node("r", &[]);
    b.human = None;
    assert_eq!(
        scope_decision(&world, &root, &b, opts).reasons,
        strings(&["me/r is an ancestor of me/b: scopes never stop it"])
    );
    assert!(
        !scope_decision(
            &world,
            &root,
            &b,
            ScopeDecisionOptions {
                strict: true,
                ..opts
            }
        )
        .allowed
    );
}

#[test]
fn refusal_setter_names_and_inherited_limits() {
    let mut e = node("e", &["p", "r"]);
    let x = node("x", &["r"]);
    let mut world = World::new(&[node("p", &["r"]), node("r", &[])]);
    world.viewer = Some("e".into());
    e.caps.caps.push(cap("inherited", Out, &[]));
    assert_eq!(
        admits(&world, &e, Out, &x, None).why,
        "your messages reach only what me/p (your parent) reaches, an inherited limit; widen with swarm rules widen e --out ep:x"
    );
    e.caps.caps[0].dir = In;
    assert_eq!(
        admits(&world, &e, In, &x, None).why,
        "only what me/p (your parent) reaches may message you, an inherited limit; widen with swarm rules widen e --in ep:x"
    );
    e.caps.caps[0].by = "r".into();
    assert_eq!(
        admits(&world, &e, In, &x, None).why,
        "me/r (your ancestor) limits who may message you to nobody; widen with swarm rules widen e --in ep:x"
    );
    world.viewer = Some("r".into());
    assert_eq!(
        admits(&world, &e, In, &x, None).why,
        "you limit who may message e to nobody; widen with swarm rules widen e --in ep:x"
    );
    world.viewer = None;
    world.labels.insert("r".into(), "the root".into());
    assert!(
        admits(&world, &e, In, &x, None)
            .why
            .starts_with("the root limits")
    );
    world.nodes.remove("r");
    world.labels.clear();
    assert!(
        admits(&world, &e, In, &x, None)
            .why
            .starts_with("a released endpoint limits")
    );
    e.caps.caps.clear();
    e.groups.push(ScopeGroupRules {
        name: "team".into(),
        owner: "policy".into(),
        r#in: Some(vec![]),
        ..Default::default()
    });
    assert_eq!(
        admits(&world, &e, In, &x, None).why,
        "group team's rules (set by the policy file) limit who may message e to nobody; widen with swarm rules widen e --in ep:x"
    );
}

#[test]
fn rule_expansion_and_narrowing() {
    for (params, symmetric, expected) in [
        (json!({}), true, json!({})),
        (
            json!({"scope":"tree"}),
            true,
            json!({"in":["tree:parent","tree:descendants"],"out":["tree:parent","tree:descendants"]}),
        ),
        (
            json!({"scope":"parent","allow":["fleet:x"]}),
            true,
            json!({"in":["tree:parent","fleet:x"],"out":["tree:parent","fleet:x"]}),
        ),
        (json!({"scope":"none"}), false, json!({"out":[]})),
        (json!({"scope":"open"}), true, json!({"in":null,"out":null})),
        (
            json!({"scope":"open","in":[]}),
            true,
            json!({"in":[],"out":null}),
        ),
        (
            json!({"scope":"tree","in":["*"]}),
            true,
            json!({"in":["*"],"out":["tree:parent","tree:descendants"]}),
        ),
        (
            json!({"allow":["tree:children","tree:children"]}),
            true,
            json!({"in":["tree:children"],"out":["tree:children"]}),
        ),
        (
            json!({"scope":"parent","allow":["tree:parent"],"out":["*","*"]}),
            false,
            json!({"out":["*"]}),
        ),
    ] {
        let params = serde_json::from_value(params).unwrap();
        assert_eq!(
            serde_json::to_value(expand_rules(&params, symmetric).unwrap()).unwrap(),
            expected
        );
    }
    let err = expand_rules(
        &ExpandRulesParams {
            scope: Some(ScopePreset::Open),
            allow: Some(strings(&["*"])),
            ..Default::default()
        },
        true,
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidParams);
    assert_eq!(
        err.message,
        "allow adds to a preset with a list: tree, parent or none"
    );
    assert!(narrower(None, None));
    assert!(!narrower(None, Some(&strings(&["a"]))));
    for (next, prev, expected) in [
        (vec!["a"], vec!["a", "b"], true),
        (vec!["c"], vec!["a"], false),
        (vec![], vec!["a"], true),
        (
            vec!["tree:parent", "tree:descendants"],
            vec!["tree:self"],
            true,
        ),
        (
            vec![
                "tree:root",
                "tree:siblings",
                "tree:children",
                "tree:ancestors:2",
                "tree:descendants:3",
                "tree:self",
            ],
            vec!["tree:self", "fleet:x"],
            true,
        ),
        (vec!["tree:parent", "fleet:x"], vec!["tree:self"], false),
        (
            vec!["tree:self"],
            vec!["tree:parent", "tree:descendants"],
            false,
        ),
        (vec!["tree:children"], vec!["tree:descendants"], false),
    ] {
        assert_eq!(
            narrower(Some(&strings(&next)), Some(&strings(&prev))),
            expected
        );
    }
}

#[test]
fn presets_ignore_inherited_limits_beside_other_lists() {
    let mut e = node("e", &["r"]);
    assert_eq!(preset_of(&e, true), "open");
    for preset in [ScopePreset::Tree, ScopePreset::Parent, ScopePreset::None] {
        let list = preset_lists(preset).unwrap();
        e.rules.out = Some(strings(list));
        e.rules.r#in = None;
        assert_eq!(preset_of(&e, false), preset.as_str());
        assert_eq!(preset_of(&e, true), "custom");
        e.rules.r#in = Some(strings(list));
        assert_eq!(preset_of(&e, true), preset.as_str());
        e.caps.caps.push(cap("inherited", Out, &["*"]));
        assert_eq!(preset_of(&e, true), preset.as_str());
        e.caps.caps.clear();
    }
    e.rules = ScopeRules::default();
    e.caps.caps.push(cap("inherited", Out, &["tree:parent"]));
    assert_eq!(preset_of(&e, false), "parent");
    e.caps.caps.push(cap("human", Out, &["tree:parent"]));
    assert_eq!(preset_of(&e, false), "parent");
    e.caps.caps.push(cap("human", Out, &["tree:parent"]));
    assert_eq!(preset_of(&e, false), "custom");
    e.caps.caps.clear();
    e.rules.out = Some(strings(&["tree:parent", "tree:parent"]));
    assert_eq!(preset_of(&e, false), "tree");
}

#[test]
fn relations_prefer_lineage_then_groups() {
    let r = node("r", &[]);
    let p = node("p", &["r"]);
    let x = node("x", &["p", "r"]);
    let s = node("s", &["p", "r"]);
    for (a, b, expected, text) in [
        (&p, &x, "parent", "your parent"),
        (&x, &p, "child", "your child"),
        (&r, &x, "ancestor", "your ancestor"),
        (&x, &r, "descendant", "your descendant"),
        (&x, &s, "sibling", "your sibling"),
        (&r, &r, "tree", "in your tree"),
    ] {
        assert_eq!(relation(&a.subject, &b.subject).as_deref(), Some(expected));
        assert_eq!(relation_text(&a.subject, &b.subject), text);
    }
    let mut a = node("a", &["p", "r"]);
    let mut b = node("b", &["q", "r"]);
    a.subject.scope.as_mut().unwrap().groups = strings(&["team", "second"]);
    b.subject.scope.as_mut().unwrap().groups = strings(&["second", "team"]);
    assert_eq!(
        relation_text(&a.subject, &b.subject),
        "in group team with you"
    );
    b.subject.scope.as_mut().unwrap().local = false;
    assert_eq!(relation_text(&a.subject, &b.subject), "in fleet r");
    b.subject.scope = None;
    assert_eq!(relation_text(&a.subject, &b.subject), "on the relay");
    a.subject.kind = "human".into();
    assert_eq!(relation_text(&a.subject, &b.subject), "the human");
}

#[test]
fn scope_data_round_trip() {
    let mut e = node("e", &["r"]);
    e.rules.out = Some(strings(&["group:team"]));
    e.rules.groups = Some(HashMap::from([(
        Out,
        HashMap::from([("group:team".into(), "g1".into())]),
    )]));
    e.caps.caps.push(cap("human", Out, &["*"]));
    e.caps.lifted = Some(vec![In]);
    let value = serde_json::to_value(&e).unwrap();
    assert_eq!(value["subject"]["scope"]["rootHandle"], "r");
    assert_eq!(value["rules"]["groups"]["out"]["group:team"], "g1");
    assert!(value.get("human").is_none());
    assert_eq!(serde_json::from_value::<ScopeNode>(value).unwrap(), e);
}

#[test]
fn example_fleet_message_matrix() {
    let mut main = node("main", &[]);
    main.rules.r#in = Some(strings(&["tree:children"]));
    let mut all = vec![main];
    let mut world = World::default();
    for team in ["a", "b", "c"] {
        let lead = format!("orch-{team}");
        let group = format!("team-{team}");
        let mut orch = node(&lead, &["main"]);
        let mut rules = vec!["tree:parent", "tree:siblings", "tree:children"];
        if team == "a" {
            rules.push("fleet:app-main");
        }
        for dir in [In, Out] {
            orch.caps.caps.push(cap("main", dir, &rules));
        }
        all.push(orch);
        world.groups.insert(
            group.clone(),
            ScopeGroupIdentity {
                id: format!("g-{team}"),
                policy: false,
                pinned: false,
            },
        );
        for i in 1..=4 {
            let mut worker = node(&format!("{team}{i}"), &[&lead, "main"]);
            worker.subject.scope.as_mut().unwrap().groups = vec![group.clone()];
            worker.groups.push(ScopeGroupRules {
                name: group.clone(),
                owner: lead.clone(),
                r#in: Some(entries(&["group:self", "tree:parent"])),
                out: Some(entries(&["group:self", "tree:parent"])),
            });
            for dir in [In, Out] {
                let mut inherited = cap("inherited", dir, &[]);
                inherited.sels.push(ScopeEntry {
                    base: true,
                    ..via("*", &lead)
                });
                worker.caps.caps.push(inherited);
            }
            all.push(worker);
        }
    }
    all.push(node("app-main", &[]));
    let mut human = node("human", &[]);
    human.subject.scope = None;
    human.subject.kind = "human".into();
    human.human = Some(true);
    human.address = "me/".into();
    all.push(human);
    world.nodes = all.into_iter().map(|n| (n.id.clone(), n)).collect();
    let columns = [
        "main", "orch-a", "orch-b", "a1", "a2", "b1", "app-main", "human",
    ];
    let rows = [
        (
            "main",
            [
                None,
                Some(true),
                Some(true),
                Some(true),
                Some(true),
                Some(true),
                Some(false),
                Some(true),
            ],
        ),
        (
            "orch-a",
            [
                Some(true),
                None,
                Some(true),
                Some(true),
                Some(true),
                Some(false),
                Some(true),
                Some(true),
            ],
        ),
        (
            "orch-b",
            [
                Some(true),
                Some(true),
                None,
                Some(false),
                Some(false),
                Some(true),
                Some(false),
                Some(true),
            ],
        ),
        (
            "a1",
            [
                Some(false),
                Some(true),
                Some(false),
                None,
                Some(true),
                Some(false),
                Some(false),
                Some(true),
            ],
        ),
        (
            "app-main",
            [
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                None,
                Some(true),
            ],
        ),
        (
            "human",
            [
                Some(true),
                Some(true),
                Some(true),
                Some(true),
                Some(true),
                Some(true),
                Some(true),
                None,
            ],
        ),
    ];
    let options = ScopeDecisionOptions {
        human_always: true,
        ..Default::default()
    };
    for (from, expected) in rows {
        for (to, expected) in columns.iter().zip(expected) {
            if let Some(expected) = expected {
                let decision = scope_decision(
                    &world,
                    world.node(from).unwrap(),
                    world.node(to).unwrap(),
                    options,
                );
                assert_eq!(
                    decision.allowed, expected,
                    "{from} to {to}: {:?}",
                    decision.reasons
                );
            }
        }
    }
}

#[test]
fn handle_globs_backtrack_and_treat_dots_literally() {
    for (pattern, handle, expected) in [
        ("*", "", true),
        ("a*b*c", "axybzc", true),
        ("a*b*c", "ac", false),
        ("a*a", "ababa", true),
        ("a**b", "ab", true),
        ("a.b", "axb", false),
        ("a.b", "a.b", true),
        ("*.b", "a.b", true),
        ("a*", "ba", false),
        ("*b", "ba", false),
        ("*", "a\nb", false),
        ("*", "a\r", false),
        ("*", "a\u{2028}b", false),
        ("*", "a\u{2029}b", false),
        ("*", "a😀b", true),
    ] {
        let subject = PolicySubject {
            handle: handle.into(),
            kind: "agent".into(),
            ..Default::default()
        };
        assert_eq!(
            matches(&format!("handle:{pattern}"), &subject, None, None),
            expected,
            "{pattern} matches {handle:?}"
        );
    }
}

#[test]
fn pinned_groups_leave_fleets_but_only_authorized_lists_widen() {
    let mut e = node("e", &["r"]);
    let mut root = node("other", &[]);
    let mut child = node("x", &["other"]);
    for n in [&mut root, &mut child] {
        n.subject.scope.as_mut().unwrap().groups = strings(&["team"]);
    }
    let mut world = World::default();
    world.identity(false, false);
    e.rules.out = Some(strings(&["group:team"]));
    e.rules.groups = Some(HashMap::from([(
        Out,
        HashMap::from([("group:team".into(), "g1".into())]),
    )]));
    assert!(!admits(&world, &e, Out, &root, None).ok);
    world.identity(false, true);
    assert!(admits(&world, &e, Out, &root, None).ok);
    assert_eq!(
        admits(&world, &e, Out, &child, None).why,
        format!("out(me/e) {BEYOND}")
    );
    world.identity(true, false);
    assert!(admits(&world, &e, Out, &root, None).ok);
    assert!(!admits(&world, &e, Out, &child, None).ok);
    e.rules = ScopeRules::default();
    e.policy.push(ScopePolicyCap {
        dir: Out,
        r#match: "*".into(),
        sels: entries(&["group:team"]),
    });
    assert!(admits(&world, &e, Out, &child, None).ok);
}
