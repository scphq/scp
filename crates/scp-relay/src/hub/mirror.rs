use super::*;
use std::collections::{BTreeMap, HashSet};
use validation::{handle, labels, no_secret, pattern};

impl AccountHub {
    pub(super) async fn mirror(&mut self, c: &Connection, p: &Value) -> Result<Value> {
        let list = p["endpoints"]
            .as_array()
            .ok_or_else(|| invalid("endpoints must be a list"))?;
        let cap = self.limits.cap("endpoints").unwrap_or(4096);
        if list.len() as u64 > cap {
            return Err(Error::new("too_large", &format!("at most {cap} endpoints")));
        }
        let mut parsed = BTreeMap::new();
        for v in list {
            let (name, f) = parse(v, c.grant.as_ref())?;
            parsed.insert(name, (v.clone(), f));
        }
        let mut full = p["full"] == true;
        let mut seen = HashSet::new();
        let mut sync = None;
        if let Some(s) = p.get("sync").filter(|v| !v.is_null()) {
            let id = string(s, "id");
            let part = s["part"].as_u64().unwrap_or(0);
            let parts = s["parts"].as_u64().unwrap_or(0);
            if id.is_empty()
                || id.encode_utf16().count() > 64
                || part == 0
                || parts == 0
                || part > parts
                || parts > 4096
            {
                return Err(invalid("invalid mirror sync"));
            }
            sync = self.syncs.remove(&c.machine);
            let broken = self
                .broken_syncs
                .iter()
                .any(|(machine, prior)| machine == &c.machine && prior == id);
            if part == 1 && !broken && sync.as_ref().is_none_or(|s| s.id != id) {
                sync = Some(SyncState {
                    id: id.into(),
                    parts,
                    next: 1,
                    seen: HashSet::new(),
                });
            }
            let intact = sync
                .as_ref()
                .is_some_and(|s| s.id == id && s.parts == parts && s.next == part);
            full = intact && part == parts;
            if intact {
                if let Some(s) = &mut sync {
                    seen = s.seen.clone();
                    s.next += 1;
                }
            } else {
                if !broken {
                    if self.broken_syncs.len() >= 256 {
                        self.broken_syncs.pop_front();
                    }
                    self.broken_syncs.push_back((c.machine.clone(), id.into()));
                }
                sync = None;
            }
            if full {
                sync = None;
            }
        }
        let original = self.endpoints().await?;
        let mut endpoints = original.clone();
        let mut changes = HubWrite::default();
        let now = crate::now_ms();
        let raw_views: BTreeMap<String, Value> = parsed
            .iter()
            .map(|(name, (raw, _))| (name.clone(), raw.clone()))
            .collect();
        let mut renames = BTreeMap::new();
        let renamed: HashSet<String> = parsed
            .values()
            .map(|(raw, _)| string(raw, "was").to_string())
            .filter(|was| !was.is_empty())
            .collect();
        for (name, (raw, mut f)) in parsed {
            seen.insert(name.clone());
            if seen.len() > 65536 {
                return Err(Error::new(
                    "too_large",
                    "mirror sync has too many endpoints",
                ));
            }
            let was = string(&raw, "was");
            let named = original
                .iter()
                .find(|e| e.machine == c.machine && e.handle == name);
            let old = named
                .filter(|_| !renamed.contains(name.as_str()))
                .or_else(|| {
                    original.iter().find(|e| {
                        e.machine == c.machine
                            && handle(was)
                            && e.handle == was
                            && e.token_hash.is_none()
                    })
                })
                .or(named)
                .cloned();
            let existing = old
                .as_ref()
                .and_then(|old| endpoints.iter().position(|e| e.id == old.id));
            if old.is_none() {
                self.endpoint_room(&endpoints)?;
            }
            if old.as_ref().is_some_and(|e| e.token_hash.is_some()) {
                continue;
            }
            if let Some(old) = &old {
                let before = fields(old);
                if f["incarnation"].is_null() {
                    f["incarnation"] = before["incarnation"].clone();
                }
                let fresh = !f["incarnation"].is_null()
                    && !before["incarnation"].is_null()
                    && f["incarnation"] != before["incarnation"];
                for key in [
                    "tree",
                    "parent_ep",
                    "depth",
                    "parent_addr",
                    "rules",
                    "caps",
                    "title",
                    "wake",
                    "incarnation",
                ] {
                    if raw.get(key).is_none() {
                        f[key] = if fresh && key != "incarnation" {
                            Value::Null
                        } else {
                            before[key].clone()
                        };
                    }
                }
                for key in ["received_at", "received_hop"] {
                    if let Some(value) = before.get(key) {
                        f[key] = value.clone();
                    }
                }
                if !fresh {
                    f["caps"] = scope::sticky_caps(&before["caps"], &f["caps"]);
                }
                if fresh
                    && string(&f, "incarnation").split('.').next()
                        != string(&before, "incarnation").split('.').next()
                {
                    changes.clear_inboxes.push(old.id.clone());
                }
                if old.handle != name {
                    renames.insert(old.id.clone(), old.handle.clone());
                }
            }
            f["auth"] = json!("account+bridge");
            let online = matches!(string(&f, "presence"), "online" | "idle");
            let parsed_seen = raw["last_seen"]
                .as_str()
                .and_then(|s| {
                    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
                        .ok()
                })
                .map(|t| (t.unix_timestamp_nanos() / 1_000_000) as i64);
            let e = Endpoint {
                id: old
                    .as_ref()
                    .map_or_else(|| validation::new_id("ep_"), |e| e.id.clone()),
                machine: c.machine.clone(),
                handle: name,
                kind: string(&raw, "kind").into(),
                token_hash: None,
                last_seen: parsed_seen.or(if online {
                    Some(now)
                } else {
                    old.as_ref().and_then(|e| e.last_seen)
                }),
                created_at: old.as_ref().map_or(now, |e| e.created_at),
                fields: f.to_string(),
            };
            if let Some(i) = existing {
                if let Some(slot) = endpoints.get_mut(i) {
                    *slot = e;
                }
            } else {
                endpoints.push(e);
            }
        }
        let placed = endpoints.clone();
        let index: HashMap<_, _> = placed
            .iter()
            .map(|e| (format!("{}/{}", e.machine, e.handle), e))
            .collect();
        let agents: HashMap<_, _> = placed
            .iter()
            .filter(|e| e.machine == c.machine && e.kind == "agent" && e.token_hash.is_none())
            .map(|e| (e.handle.as_str(), e))
            .collect();
        let renaming: BTreeMap<_, _> = renames
            .iter()
            .filter_map(|(id, was)| {
                placed
                    .iter()
                    .find(|row| &row.id == id)
                    .map(|row| (was.clone(), row.handle.clone()))
            })
            .collect();
        for e in &mut endpoints {
            let mut f = fields(e);
            let mut placed_scope = false;
            if e.machine == c.machine && e.kind == "agent" && raw_views.contains_key(&e.handle) {
                if let Some((tree, parent, depth)) =
                    placement(&e.handle, &agents, &raw_views, &mut HashSet::new())
                {
                    placed_scope = true;
                    f["tree"] = tree;
                    f["parent_ep"] = parent;
                    f["depth"] = depth;
                } else {
                    let previous = original.iter().find(|row| row.id == e.id).map(fields);
                    let fresh = previous.as_ref().is_some_and(|old| {
                        !old["incarnation"].is_null() && old["incarnation"] != f["incarnation"]
                    });
                    for key in ["tree", "parent_ep", "depth"] {
                        f[key] = if fresh {
                            Value::Null
                        } else {
                            previous.as_ref().map_or(Value::Null, |v| v[key].clone())
                        };
                    }
                }
                if !f["parent_ep"].is_null() || linked_loop(e, &f, &index) {
                    f["parent_addr"] = Value::Null;
                }
            }
            if let Some(parent) = f["parent_addr"]
                .as_str()
                .and_then(|addr| addr.strip_prefix(&format!("{}/", c.machine)))
                .and_then(|name| renaming.get(name))
            {
                f["parent_addr"] = json!(format!("{}/{}", c.machine, parent));
            }
            if e.machine == c.machine {
                rename_refs(&mut f["caps"], &renaming);
                for key in ["tree", "parent_ep"] {
                    if placed_scope {
                        continue;
                    }
                    if let Some(name) = f[key].as_str().and_then(|name| renaming.get(name)) {
                        f[key] = json!(name);
                    }
                }
            }
            if full
                && e.machine == c.machine
                && e.token_hash.is_none()
                && !seen.contains(&e.handle)
                && matches!(string(&f, "presence"), "online" | "idle")
            {
                f["presence"] = json!("offline");
                e.last_seen = Some(now);
            }
            e.fields = f.to_string();
        }
        let mut notifications = Vec::new();
        for e in endpoints {
            let old = original.iter().find(|old| old.id == e.id);
            let changed = old.is_none_or(|old| {
                old.handle != e.handle || old.kind != e.kind || fields(old) != fields(&e)
            });
            if changed && e.machine == c.machine {
                let mut view = self.view(&e);
                if let Some(was) = renames.get(&e.id) {
                    view["was"] = json!(was);
                }
                notifications.push(view);
            }
            changes.endpoints.push(e);
        }
        self.store.hub_write(&self.account_id, changes).await?;
        if let Some(mut state) = sync {
            state.seen = seen;
            self.syncs.insert(c.machine.clone(), state);
        }
        let announced = if full {
            self.store
                .endpoints(&self.account_id, Some(&c.machine))
                .await?
                .iter()
                .map(|e| self.view(e))
                .collect()
        } else {
            notifications.clone()
        };
        self.announce(&c.machine, announced, full, false).await?;
        for v in &notifications {
            let before = original.iter().find(|e| e.id == v["id"]);
            if before.is_none_or(|e| fields(e)["presence"] != v["presence"])
                || v.get("was").is_some()
            {
                self.fleet(json!({"type":"presence","machine":c.machine,"endpoint":v["address"],"presence":v["presence"],"harness":v["harness"],"labels":v["labels"]}));
            }
            if before.is_some_and(|e| fields(e)["status"] != v["status"]) {
                self.fleet(json!({"type":"status","machine":c.machine,"endpoint":v["address"],"status":v["status"]}));
            }
        }
        Ok(json!({"changed":notifications.len()}))
    }
}
fn parse(v: &Value, grant: Option<&Grant>) -> Result<(String, Value)> {
    if !v.is_object() {
        return Err(invalid("an endpoint is an object"));
    }
    no_secret(&v.to_string())?;
    let address = v["address"]
        .as_str()
        .ok_or_else(|| invalid("an endpoint needs an address"))?;
    let name = address.rsplit('/').next().unwrap_or("");
    let kind = string(v, "kind");
    if !matches!(kind, "agent" | "human")
        || (kind == "human" && !name.is_empty())
        || (kind == "agent" && !handle(name))
    {
        return Err(invalid("invalid endpoint address or kind"));
    }
    let mut f = json!({});
    for (key, max) in [("harness", 32), ("model", 128), ("cwd", 1024)] {
        f[key] = text(v.get(key), key, max)?;
    }
    let title = v["title"]
        .as_str()
        .map(|s| json!(s.split_whitespace().collect::<Vec<_>>().join(" ")));
    f["title"] = text(title.as_ref().or(v.get("title")), "title", 64)?;
    if f["title"] == "" {
        f["title"] = Value::Null;
    }
    if !f["harness"].is_null() && !pattern!(r"^[a-z0-9][a-z0-9-]{0,31}$", string(&f, "harness")) {
        return Err(invalid("invalid harness"));
    }
    f["labels"] = labels(v.get("labels"), grant)?;
    f["presence"] = v.get("presence").cloned().unwrap_or(json!("offline"));
    if !matches!(
        string(&f, "presence"),
        "online" | "idle" | "offline" | "hibernated"
    ) {
        return Err(invalid("invalid presence"));
    }
    f["status"] = match v.get("status") {
        None | Some(Value::Null) => Value::Null,
        Some(s) => {
            if !matches!(
                string(s, "state"),
                "working" | "waiting" | "blocked" | "done"
            ) {
                return Err(invalid("invalid status state"));
            }
            json!({"state":s["state"],"note":text(s.get("note"),"note",280)?.as_str().unwrap_or("")})
        }
    };
    if kind == "agent" {
        for key in ["tree", "parent_ep"] {
            f[key] = text(v.get(key), key, 128)?;
            if f[key] == "" {
                return Err(invalid("invalid tree field"));
            }
        }
        f["depth"] = v.get("depth").cloned().unwrap_or(Value::Null);
        if !f["depth"].is_null() && f["depth"].as_u64().is_none_or(|n| n > 1000) {
            return Err(invalid("invalid depth"));
        }
        f["parent_addr"] = v.get("parent_addr").cloned().unwrap_or(Value::Null);
        if !f["parent_addr"].is_null() {
            let addr = string(&f, "parent_addr");
            let (m, h) = addr.split_once('/').unwrap_or(("", ""));
            if !crate::valid_name(m) || !handle(h) {
                return Err(invalid("invalid parent_addr"));
            }
        }
        f["rules"] = v.get("rules").cloned().unwrap_or(Value::Null);
        scope::validate_rules(&f["rules"])?;
        f["caps"] = v.get("caps").cloned().unwrap_or(Value::Null);
        scope::validate_caps(&f["caps"])?;
        if json!([f["rules"], f["caps"]]).to_string().len() > 16384 {
            return Err(Error::new("too_large", "rules and caps exceed 16384 bytes"));
        }
        f["incarnation"] = v.get("incarnation").cloned().unwrap_or(Value::Null);
        if !f["incarnation"].is_null()
            && !pattern!(r"^[A-Za-z0-9._:-]{1,128}$", string(&f, "incarnation"))
        {
            return Err(invalid("invalid incarnation"));
        }
        f["wake"] = v
            .get("wake")
            .filter(|v| {
                v.as_str().is_some_and(|s| {
                    include_str!("wakes.txt").lines().any(|wake| wake == s)
                        || pattern!(r"^hook:[a-z0-9][a-z0-9-]{0,31}$", s)
                })
            })
            .cloned()
            .unwrap_or(Value::Null);
    }
    no_secret(name)?;
    no_secret(&json!([f["model"], f["cwd"], f["labels"], f["status"], f["title"]]).to_string())?;
    Ok((name.into(), f))
}

fn placement(
    name: &str,
    rows: &HashMap<&str, &Endpoint>,
    raw: &BTreeMap<String, Value>,
    trail: &mut HashSet<String>,
) -> Option<(Value, Value, Value)> {
    let unknown = || (Value::Null, Value::Null, Value::Null);
    if !trail.insert(name.into()) || trail.len() > 128 {
        return Some(unknown());
    }
    let result = if let Some(view) = raw.get(name) {
        if view.get("parent_ep").is_none() && view.get("depth").is_none() {
            None
        } else if view.get("parent_ep").is_none() {
            Some(unknown())
        } else if view["parent_ep"].is_null() {
            Some(if view["depth"] == 0 {
                (json!(name), Value::Null, json!(0))
            } else {
                unknown()
            })
        } else if let Some(parent) = view["parent_ep"].as_str().and_then(|h| rows.get(h)) {
            let f = fields(parent);
            let up = placement(&parent.handle, rows, raw, trail).unwrap_or((
                f["tree"].clone(),
                f["parent_ep"].clone(),
                f["depth"].clone(),
            ));
            Some(if let Some(depth) = up.2.as_u64().filter(|d| *d < 32) {
                (
                    if up.0.is_null() {
                        json!(parent.handle)
                    } else {
                        up.0
                    },
                    json!(parent.handle),
                    json!(depth + 1),
                )
            } else {
                unknown()
            })
        } else {
            Some(unknown())
        }
    } else {
        None
    };
    trail.remove(name);
    result
}
fn linked_loop(e: &Endpoint, fields: &Value, rows: &HashMap<String, &Endpoint>) -> bool {
    let Some(mut key) = fields["parent_addr"].as_str().map(str::to_owned) else {
        return false;
    };
    let mut seen = HashSet::from([format!("{}/{}", e.machine, e.handle)]);
    for _ in 0..128 {
        if !seen.insert(key.clone()) {
            return true;
        }
        let Some(row) = rows.get(&key) else {
            return false;
        };
        let f = validation::fields(row);
        if let Some(p) = f["parent_ep"].as_str() {
            key = format!("{}/{p}", row.machine);
        } else if let Some(p) = f["parent_addr"].as_str() {
            key = p.into();
        } else {
            return false;
        }
    }
    true
}

fn rename_refs(value: &mut Value, renames: &BTreeMap<String, String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if matches!(key.as_str(), "by" | "via")
                    && let Some(name) = value
                        .as_str()
                        .and_then(|s| s.strip_prefix("ep:"))
                        .and_then(|s| renames.get(s))
                {
                    *value = json!(format!("ep:{name}"));
                    continue;
                }
                rename_refs(value, renames);
            }
        }
        Value::Array(values) => {
            for value in values {
                rename_refs(value, renames);
            }
        }
        _ => {}
    }
}
