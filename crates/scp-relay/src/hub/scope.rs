use super::*;
use validation::{handle, pattern};

fn selector(v: &Value) -> bool {
    let Some(s) = v.as_str() else {
        return false;
    };
    pattern!(
        r"^(?:\*|ep:[a-z0-9][a-z0-9._-]{0,62}|handle:[a-z0-9._*?-]{1,63}|harness:[a-z0-9-]{1,32}|kind:(?:agent|human)|label:[a-z0-9._-]{1,32}=[^\s]{0,128}|group:[a-z0-9][a-z0-9._-]{0,62}(?:/[a-z0-9][a-z0-9._-]{0,62})?|fleet:(?:\*|[a-z0-9][a-z0-9._-]{0,62})|machine:[A-Za-z0-9][A-Za-z0-9._-]{0,62}|org:(?:\*|[a-z0-9][a-z0-9._-]{0,62})|acct:(?:\*|[a-z0-9][a-z0-9-]{0,63})|tree:(?:self|root|parent|siblings|children)|tree:(?:ancestors|descendants)(?::(?:[1-9]|1[0-6]))?)$",
        s,
    ) && s != "group:self"
}
fn selectors(v: &Value) -> Result<()> {
    if v.as_array()
        .is_none_or(|a| a.len() > 64 || a.iter().any(|s| !selector(s)))
    {
        Err(invalid("invalid selector list"))
    } else {
        Ok(())
    }
}
pub(super) fn validate_rules(v: &Value) -> Result<()> {
    if v.is_null() {
        return Ok(());
    }
    if !v.is_object() {
        return Err(invalid("invalid rules"));
    }
    for dir in ["in", "out"] {
        if let Some(list) = v.get(dir) {
            selectors(list)?;
        }
    }
    Ok(())
}
fn entries(v: &Value) -> Result<()> {
    let a = v
        .as_array()
        .ok_or_else(|| invalid("invalid cap selectors"))?;
    if a.len() > 64 {
        return Err(invalid("invalid cap selectors"));
    }
    for e in a {
        if !e.is_object() || !selector(&e["sel"]) {
            return Err(invalid("invalid cap selector"));
        }
        for key in ["via", "group"] {
            if let Some(value) = e.get(key)
                && value
                    .as_str()
                    .is_none_or(|s| s.is_empty() || s.encode_utf16().count() > 128)
            {
                return Err(invalid("invalid cap reference"));
            }
        }
    }
    Ok(())
}
pub(super) fn validate_caps(v: &Value) -> Result<()> {
    if v.is_null() {
        return Ok(());
    }
    let caps = v["caps"]
        .as_array()
        .ok_or_else(|| invalid("invalid caps"))?;
    if caps.len() > 64 {
        return Err(invalid("invalid caps"));
    }
    for cap in caps {
        if !matches!(string(cap, "dir"), "in" | "out") {
            return Err(invalid("invalid cap direction"));
        }
        for key in ["id", "by"] {
            if cap[key]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.encode_utf16().count() > 128)
            {
                return Err(invalid("invalid cap reference"));
            }
        }
        entries(&cap["sels"])?;
    }
    if let Some(allow) = v.get("allow") {
        let map = allow
            .as_object()
            .ok_or_else(|| invalid("invalid cap allowances"))?;
        if map.len() > 64 {
            return Err(invalid("invalid cap allowances"));
        }
        for (key, list) in map {
            if key.is_empty() || key.encode_utf16().count() > 128 {
                return Err(invalid("invalid cap reference"));
            }
            entries(list)?;
        }
    }
    Ok(())
}
pub(super) fn sticky_caps(old: &Value, next: &Value) -> Value {
    let Some(before) = old["caps"].as_array() else {
        return next.clone();
    };
    let mut caps = next["caps"].as_array().cloned().unwrap_or_default();
    for cap in &mut caps {
        if let Some(prior) = before.iter().find(|p| p["id"] == cap["id"]) {
            let old_sels = prior["sels"].as_array().cloned().unwrap_or_default();
            if let Some(sels) = cap["sels"].as_array_mut() {
                sels.retain(|e| {
                    e.get("via").is_some()
                        || old_sels.iter().any(|old| {
                            old.get("via").is_none()
                                && old["sel"] == e["sel"]
                                && old["group"] == e["group"]
                        })
                });
            }
        }
    }
    for cap in before {
        if !caps.iter().any(|n| n["id"] == cap["id"]) {
            caps.push(cap.clone());
        }
    }
    if caps.is_empty() && next["allow"].as_object().is_none_or(|m| m.is_empty()) {
        Value::Null
    } else {
        json!({"caps":caps,"allow":next.get("allow").cloned().unwrap_or_else(||json!({}))})
    }
}
pub(super) fn claim_rules(p: &Value) -> Result<Value> {
    let mut out = json!({});
    if p.get("scope").is_some() || p.get("allow").is_some() {
        let preset = p.get("scope").and_then(Value::as_str).unwrap_or("none");
        let base: Vec<Value> = match preset {
            "open" => Vec::new(),
            "none" => Vec::new(),
            "tree" => vec![json!("tree:parent"), json!("tree:descendants")],
            "parent" => vec![json!("tree:parent")],
            _ => return Err(invalid("invalid scope preset")),
        };
        if preset == "open" && p["allow"].as_array().is_some_and(|a| !a.is_empty()) {
            return Err(invalid("allow cannot widen open"));
        }
        let mut list = base;
        if let Some(allow) = p.get("allow") {
            selectors(allow)?;
            if let Some(a) = allow.as_array() {
                list.extend(a.iter().cloned());
            }
        }
        if preset != "open" {
            out["out"] = json!(list);
        }
    }
    for dir in ["in", "out"] {
        if let Some(v) = p.get(dir) {
            selectors(v)?;
            out[dir] = v.clone();
        }
    }
    Ok(if out.as_object().is_some_and(|o| o.is_empty()) {
        Value::Null
    } else {
        out
    })
}
fn glob(pattern: &[u8], value: &[u8]) -> bool {
    let (mut p, mut v) = (0, 0);
    let mut star = None;
    let mut retry = 0;
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = v;
        } else if let Some(s) = star {
            p = s + 1;
            retry += 1;
            v = retry;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}
fn root(e: &Endpoint) -> String {
    fields(e)["tree"].as_str().unwrap_or(&e.handle).to_owned()
}
fn ancestors(e: &Endpoint, all: &[Endpoint]) -> Vec<String> {
    let mut out = Vec::new();
    let mut row = e;
    for _ in 0..128 {
        let f = fields(row);
        let Some(parent) = f["parent_ep"].as_str() else {
            break;
        };
        let Some(next) = all
            .iter()
            .find(|r| r.machine == row.machine && r.handle == parent)
        else {
            break;
        };
        if out.contains(&next.id) {
            break;
        }
        out.push(next.id.clone());
        row = next;
    }
    out
}
fn same_tree(a: &Endpoint, b: &Endpoint) -> bool {
    a.machine.is_empty() && b.machine.is_empty() && root(a) == root(b)
}
pub(super) fn matches(sel: &str, x: &Endpoint, e: &Endpoint, all: &[Endpoint]) -> bool {
    let f = fields(x);
    if let Some(peer) = f["xaccount"].as_str() {
        return sel == "acct:*" || sel == format!("acct:{peer}");
    }
    match sel {
        "*" => true,
        "tree:self" => same_tree(x, e),
        "tree:root" => same_tree(x, e) && fields(x)["depth"] == 0,
        "tree:parent" => {
            same_tree(x, e) && x.machine == e.machine && fields(e)["parent_ep"] == x.handle
        }
        "tree:children" => {
            same_tree(x, e) && x.machine == e.machine && fields(x)["parent_ep"] == e.handle
        }
        "tree:siblings" => {
            same_tree(x, e)
                && !fields(e)["parent_ep"].is_null()
                && fields(x)["parent_ep"] == fields(e)["parent_ep"]
        }
        _ => {
            let (kind, value) = sel.split_once(':').unwrap_or(("", ""));
            match kind {
                "ep" => x.handle == value,
                "kind" => x.kind == value,
                "harness" => f["harness"] == value,
                "handle" => glob(value.as_bytes(), x.handle.as_bytes()),
                "machine" => x.machine == value,
                "org" => false,
                "fleet" => x.machine.is_empty() && (value == "*" || root(x) == value),
                "label" => value
                    .split_once('=')
                    .is_some_and(|(key, value)| f["labels"][key] == value),
                "tree" => {
                    let (relation, depth) = value.split_once(':').unwrap_or((value, "16"));
                    let max = depth.parse::<usize>().unwrap_or(16);
                    if !same_tree(x, e) {
                        return false;
                    }
                    let list = if relation == "ancestors" {
                        ancestors(e, all)
                    } else if relation == "descendants" {
                        ancestors(x, all)
                    } else {
                        return false;
                    };
                    let id = if relation == "ancestors" {
                        &x.id
                    } else {
                        &e.id
                    };
                    list.iter().position(|a| a == id).is_some_and(|n| n < max)
                }
                _ => false,
            }
        }
    }
}
fn lists(e: &Endpoint, dir: &str) -> Vec<Vec<Value>> {
    let f = fields(e);
    let mut out = Vec::new();
    if let Some(a) = f["rules"][dir].as_array() {
        out.push(a.iter().map(|s| json!({"sel":s})).collect());
    }
    if let Some(caps) = f["caps"]["caps"].as_array() {
        for cap in caps {
            if cap["dir"] == dir {
                let sels = cap["sels"].as_array().cloned().unwrap_or_default();

                out.push(sels);
            }
        }
    }
    out
}
/// who set each of `lists(e, dir)`: `self` for the endpoint's own rules, else the cap's `by`
fn setters(e: &Endpoint, dir: &str) -> Vec<String> {
    let f = fields(e);
    let mut out = Vec::new();
    if f["rules"][dir].is_array() {
        out.push("self".to_owned());
    }
    if let Some(caps) = f["caps"]["caps"].as_array() {
        for cap in caps.iter().filter(|cap| cap["dir"] == dir) {
            out.push(string(cap, "by").to_owned());
        }
    }
    out
}
/// what an agent with no list reaches out to: its own tree, the roots, contacts' endpoints and every non-agent
fn default_reach(e: &Endpoint, x: &Endpoint) -> bool {
    e.kind != "agent"
        || !fields(e)["xaccount"].is_null()
        || same_tree(e, x)
        || !fields(x)["xaccount"].is_null()
        || (fields(x)["parent_ep"].is_null() && (x.machine.is_empty() || fields(x)["depth"] == 0))
        || x.kind != "agent"
}
fn admits(
    e: &Endpoint,
    dir: &str,
    x: &Endpoint,
    all: &[Endpoint],
    trail: &mut Vec<String>,
) -> bool {
    let key = format!("{}:{dir}:{}", e.id, x.id);
    if trail.contains(&key) || trail.len() > 64 {
        return false;
    }
    trail.push(key);
    let scoped = !lists(e, "in").is_empty() || !lists(e, "out").is_empty();
    if !scoped {
        trail.pop();
        return dir == "in" || default_reach(e, x);
    }
    let cross = !same_tree(e, x);
    let free = dir == "in" || default_reach(e, x);
    let lists = lists(e, dir);
    let setters = setters(e, dir);
    let result = if lists.is_empty() {
        !cross
    } else {
        lists.iter().zip(&setters).all(|(list, by)| {
            let leaves = free || by == "human" || by == "policy";
            list.iter().any(|entry| {
                if !leaves && entry.get("via").and_then(Value::as_str).is_none() {
                    return false;
                }
                let sel = string(entry, "sel");
                if !matches(sel, x, e, all)
                    || (cross
                        && !(sel == "*"
                            || ["ep:", "fleet:", "machine:", "org:", "acct:"]
                                .iter()
                                .any(|p| sel.starts_with(p))))
                {
                    return false;
                }
                let Some(via) = entry.get("via").and_then(Value::as_str) else {
                    return true;
                };
                if via == "human" {
                    return true;
                }
                let Some(w) = all.iter().find(|r| {
                    r.machine == e.machine && via.strip_prefix("ep:") == Some(r.handle.as_str())
                }) else {
                    return false;
                };
                x.id == w.id || ancestors(x, all).contains(&w.id) || admits(w, dir, x, all, trail)
            })
        })
    };
    trail.pop();
    result
}
pub(super) fn cross_allowed(e: &Endpoint, dir: &str, peer: &str, all: &[Endpoint]) -> bool {
    let foreign = Endpoint {
        id: format!("@{peer}"),
        machine: "@".into(),
        handle: "".into(),
        kind: "agent".into(),
        token_hash: None,
        last_seen: None,
        created_at: 0,
        fields: json!({"xaccount":peer}).to_string(),
    };
    admits(e, dir, &foreign, all, &mut Vec::new())
}
pub(super) fn allowed(
    a: &Endpoint,
    b: &Endpoint,
    all: &[Endpoint],
    solicited: bool,
    verified: bool,
) -> bool {
    if a.kind == "system"
        || b.kind == "system"
        || (b.kind == "human" && b.machine.is_empty())
        || (a.kind == "human" && a.machine.is_empty() && verified)
        || solicited
    {
        return true;
    }
    if same_tree(a, b) && ancestors(b, all).contains(&a.id) {
        return true;
    }
    let af = fields(a);
    let bf = fields(b);
    if af["parent_addr"] == format!("{}/{}", b.machine, b.handle)
        || bf["parent_addr"] == format!("{}/{}", a.machine, a.handle)
    {
        return true;
    }
    admits(a, "out", b, all, &mut Vec::new()) && admits(b, "in", a, all, &mut Vec::new())
}
pub(super) fn relation(a: &Endpoint, b: &Endpoint) -> Option<String> {
    if a.kind == "human" {
        return Some("human".into());
    }
    if a.kind != "agent" || b.kind != "agent" {
        return None;
    }
    if !same_tree(a, b) {
        return Some(format!("fleet:{}", root(a)));
    }
    if fields(b)["parent_ep"] == a.handle {
        return Some("parent".into());
    }
    if fields(a)["parent_ep"] == b.handle {
        return Some("child".into());
    }
    Some("tree".into())
}
impl AccountHub {
    pub(super) fn resolve<'a>(
        &self,
        address: &Value,
        machine: &str,
        rows: &'a [Endpoint],
    ) -> Result<&'a Endpoint> {
        let s = address
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| invalid("an address is machine/handle, user/handle, or a handle"))?
            .trim();
        let parts: Vec<&str> = s.split('/').collect();
        let own = |s: &str| matches!(s, "me" | "local") || s == self.account_name();
        let (m, h) = match parts.as_slice() {
            [h] => (machine, *h),
            [a, h] if own(a) => (if h.is_empty() { "" } else { machine }, *h),
            [m, h] => (*m, *h),
            [a, m, h] if own(a) => (*m, *h),
            _ => return Err(Error::new("not_found", "no endpoint at address")),
        };
        let h = if h == "me" { "" } else { h };
        if !h.is_empty() && !handle(h) {
            return Err(Error::new("not_found", "no endpoint at address"));
        }
        rows.iter()
            .find(|e| e.machine == m && e.handle == h)
            .ok_or_else(|| Error::new("not_found", "no endpoint at address"))
    }
}

pub(super) fn preset(e: &Endpoint) -> &'static str {
    let ins = lists(e, "in");
    let outs = lists(e, "out");
    if ins.is_empty() && outs.is_empty() {
        return "open";
    }
    if !ins.is_empty() || outs.len() != 1 {
        return "custom";
    }
    let names: std::collections::BTreeSet<_> = outs
        .first()
        .into_iter()
        .flatten()
        .map(|e| string(e, "sel"))
        .collect();
    if names.is_empty() {
        "none"
    } else if names == std::collections::BTreeSet::from(["tree:parent"]) {
        "parent"
    } else if names == std::collections::BTreeSet::from(["tree:parent", "tree:descendants"]) {
        "tree"
    } else {
        "custom"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_globs() {
        for (pattern, value, expected) in [
            ("*", "", true),
            ("a*?c", "abc", true),
            ("a*?c", "ac", false),
            ("a*b*c", "axbyc", true),
            ("a*b*c", "abx", false),
            ("a.b", "a.b", true),
            ("a.b", "axb", false),
            ("*a*a*b", "aaaaab", true),
            ("?", "a", true),
            ("?", "", false),
        ] {
            assert_eq!(
                glob(pattern.as_bytes(), value.as_bytes()),
                expected,
                "{pattern}: {value}"
            );
        }
        assert!(selector(&json!("handle:agent-?*")));
    }
}

#[cfg(test)]
mod default_reach_tests {
    use super::*;

    fn row(handle: &str, tree: &str, parent: Option<&str>) -> Endpoint {
        Endpoint {
            id: handle.into(),
            machine: String::new(),
            handle: handle.into(),
            kind: "agent".into(),
            token_hash: None,
            last_seen: None,
            created_at: 0,
            fields: json!({"tree":tree,"parent_ep":parent}).to_string(),
        }
    }

    #[test]
    fn default_reach_and_explicit_widening() {
        let r1 = row("r1", "r1", None);
        let w1 = row("w1", "r1", Some("r1"));
        let r2 = row("r2", "r2", None);
        let w2 = row("w2", "r2", Some("r2"));
        let sibling = row("sibling", "r1", Some("r1"));
        let rows = vec![
            r1.clone(),
            w1.clone(),
            r2.clone(),
            w2.clone(),
            sibling.clone(),
        ];
        for (from, to, expected) in [
            (&w1, &r2, true),
            (&r1, &r2, true),
            (&w1, &w2, false),
            (&r1, &w2, false),
            (&w1, &sibling, true),
            (&w1, &r1, true),
        ] {
            assert_eq!(
                allowed(from, to, &rows, false, false),
                expected,
                "{} -> {}",
                from.handle,
                to.handle
            );
        }
        let mut wide = w1.clone();
        wide.fields = json!({"tree":"r1","parent_ep":"r1","rules":{"out":["*"]}}).to_string();
        assert!(!allowed(&wide, &w2, &rows, false, false));
        wide.fields = json!({"tree":"r1","parent_ep":"r1","caps":{"caps":[{"id":"c","dir":"out","by":"human","sels":[{"sel":"*"}]}]}}).to_string();
        assert!(allowed(&wide, &w2, &rows, false, false));
        wide.fields = json!({"tree":"r1","parent_ep":"r1","caps":{"caps":[{"id":"c","dir":"out","by":"r1","sels":[{"sel":"*"}]}]}}).to_string();
        assert!(!allowed(&wide, &w2, &rows, false, false));
        let mut remote = w2.clone();
        remote.machine = "remote".into();
        for (f, expected) in [
            (json!({}), false),
            (json!({"parent_ep":"r2","depth":1}), false),
            (json!({"parent_ep":null,"depth":0}), true),
            (json!({"parent_addr":"other/root"}), false),
            (
                json!({"parent_ep":null,"depth":0,"parent_addr":"other/root"}),
                true,
            ),
        ] {
            remote.fields = f.to_string();
            assert_eq!(allowed(&w1, &remote, &rows, false, false), expected);
        }
        let mut contact = remote;
        contact.fields = json!({"xaccount":"peer"}).to_string();
        assert!(allowed(&w1, &contact, &rows, false, false));
    }
}
