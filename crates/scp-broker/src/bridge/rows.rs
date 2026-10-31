//! Other machines' endpoints as rows of this broker: keyed by `remote` (`<machine>/<handle>`) under a handle no local claim can take.

use std::collections::{HashMap, HashSet};

use scp_core::protocol::{
    ErrorCode, HOP_FLOOR_MAX, LIMITS, PRESENCES, STATUS_STATES, ScopeDirection,
};
use scp_core::scope::{PolicySubject, ScopeList, effective_selector, group_cap_key, matches};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::{handle_part, is_foreign, machine_part, valid_account, valid_machine, valid_remote};
use crate::claims::{clean_labels, hash, valid_handle, valid_harness};
use crate::core::{Core, integer, now_ms, text};
use crate::messages::unreachable;
use crate::proto::RpcError;
use crate::scrub::find_secret;
use crate::session::clean_text;
use crate::store::{Row, SqlValue};
use crate::views::not_found;
use crate::world::{HUMAN_HANDLE, World};

pub const GONE_PREFIX: &str = "_gone_";
const REFS: [&str; 4] = ["human", "policy", "inherited", "gone"];
const SCOPE_BYTES: usize = 16 * 1024;
const DEPTH_MAX: i64 = 16;

fn sv(value: impl Into<String>) -> SqlValue {
    SqlValue::Text(value.into())
}

fn opt(value: Option<&str>) -> SqlValue {
    value.map_or(SqlValue::Null, sv)
}

fn bad(what: &str) -> RpcError {
    RpcError::invalid_params(format!("an endpoint's {what} is not valid"))
}

pub fn parse_time(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?;
    OffsetDateTime::parse(text, &Rfc3339)
        .ok()
        .map(|at| (at.unix_timestamp_nanos() / 1_000_000) as i64)
}

#[derive(Clone, Debug, PartialEq)]
struct Placement {
    tree: Option<String>,
    parent_ep: Option<String>,
    depth: Option<i64>,
}

const UNKNOWN: Placement = Placement {
    tree: None,
    parent_ep: None,
    depth: None,
};

fn stored(row: &Row) -> Placement {
    Placement {
        tree: text(row, "tree").map(str::to_owned),
        parent_ep: text(row, "parent_ep").map(str::to_owned),
        depth: integer(row, "depth"),
    }
}

/// a field of an agent's view: None when it was left out, Some(None) when it was null
type Given<T> = Option<Option<T>>;

#[derive(Default)]
struct ParsedScope {
    parent: Given<String>,
    depth: Given<i64>,
    parent_addr: Given<String>,
    rules: Given<Value>,
    caps: Given<Value>,
    title: Given<String>,
    wake: Given<String>,
    incarnation: Given<String>,
}

struct ParsedView {
    handle: String,
    kind: String,
    harness: Option<String>,
    model: Option<String>,
    cwd: Option<String>,
    labels: String,
    status: Option<(String, String)>,
    presence: String,
    last_seen: Option<i64>,
    active_at: Option<i64>,
    scope: ParsedScope,
    was: Option<String>,
}

fn given<'a>(view: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    view.get(key)
}

fn short_text(value: &Value, what: &str) -> Result<String, RpcError> {
    value
        .as_str()
        .filter(|v| !v.is_empty() && v.chars().count() <= 128)
        .map(str::to_owned)
        .ok_or_else(|| bad(what))
}

fn check_entries(value: &Value) -> Result<(), RpcError> {
    let list = value
        .as_array()
        .filter(|l| l.len() <= 64)
        .ok_or_else(|| bad("caps"))?;
    for entry in list {
        let sel = entry
            .get("sel")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("caps"))?;
        if !crate::policy::valid_selector(sel, true, true) {
            return Err(bad("caps"));
        }
        for key in ["via", "group"] {
            if let Some(v) = entry.get(key) {
                short_text(v, "caps")?;
            }
        }
    }
    Ok(())
}

fn parse_selectors(value: &Value, what: &str) -> Result<Value, RpcError> {
    let list = value
        .as_array()
        .filter(|l| l.len() <= 64)
        .ok_or_else(|| bad(what))?;
    if list.iter().any(|sel| {
        !sel.as_str()
            .is_some_and(|s| crate::policy::valid_selector(s, true, true))
    }) {
        return Err(bad(what));
    }
    Ok(value.clone())
}

fn parse_scope(view: &Map<String, Value>) -> Result<ParsedScope, RpcError> {
    let mut out = ParsedScope::default();
    if let Some(tree) = given(view, "tree")
        && !tree.is_null()
    {
        short_text(tree, "tree")?;
    }
    if let Some(parent) = given(view, "parent_ep") {
        out.parent = Some(if parent.is_null() {
            None
        } else {
            Some(short_text(parent, "parent_ep")?)
        });
    }
    if let Some(depth) = given(view, "depth") {
        out.depth = Some(match depth {
            Value::Null => None,
            value => Some(
                value
                    .as_i64()
                    .filter(|d| {
                        (0..=1000).contains(d) && value.as_f64().is_some_and(|f| f.fract() == 0.0)
                    })
                    .ok_or_else(|| bad("depth"))?,
            ),
        });
    }
    if let Some(key) = given(view, "parent_addr") {
        out.parent_addr = Some(match key {
            Value::Null => None,
            Value::String(key)
                if valid_remote(key)
                    && valid_machine(machine_part(key))
                    && valid_handle(handle_part(key)) =>
            {
                Some(key.clone())
            }
            _ => return Err(bad("parent_addr")),
        });
    }
    if let Some(rules) = given(view, "rules") {
        out.rules = Some(match rules {
            Value::Null => None,
            Value::Object(map) => {
                let mut parsed = Map::new();
                for dir in ["in", "out"] {
                    if let Some(list) = map.get(dir) {
                        parsed.insert(dir.into(), parse_selectors(list, "rules")?);
                    }
                }
                Some(Value::Object(parsed))
            }
            _ => return Err(bad("rules")),
        });
    }
    if let Some(caps) = given(view, "caps") {
        out.caps = Some(match caps {
            Value::Null => None,
            Value::Object(map) => {
                let list = map
                    .get("caps")
                    .and_then(Value::as_array)
                    .filter(|l| l.len() <= 64)
                    .ok_or_else(|| bad("caps"))?;
                let mut parsed = Vec::new();
                for cap in list {
                    let dir = cap
                        .get("dir")
                        .and_then(Value::as_str)
                        .filter(|d| matches!(*d, "in" | "out"))
                        .ok_or_else(|| bad("caps"))?;
                    let id = short_text(cap.get("id").unwrap_or(&Value::Null), "caps")?;
                    let by = short_text(cap.get("by").unwrap_or(&Value::Null), "caps")?;
                    let sels = cap.get("sels").cloned().unwrap_or(Value::Null);
                    check_entries(&sels)?;
                    parsed.push(json!({"id": id, "dir": dir, "by": by, "sels": sels}));
                }
                let allow = match map.get("allow") {
                    None => Map::new(),
                    Some(Value::Object(allow)) if allow.len() <= 64 => {
                        for (key, list) in allow {
                            short_text(&json!(key), "caps")?;
                            check_entries(list)?;
                        }
                        allow.clone()
                    }
                    Some(_) => return Err(bad("caps")),
                };
                Some(json!({"caps": parsed, "allow": allow}))
            }
            _ => return Err(bad("caps")),
        });
    }
    let size = json!([out.rules.clone().flatten(), out.caps.clone().flatten()])
        .to_string()
        .len();
    if size > SCOPE_BYTES {
        return Err(RpcError::new(
            ErrorCode::TooLarge,
            format!("an endpoint's rules and caps are more than {SCOPE_BYTES} bytes"),
        ));
    }
    if let Some(title) = given(view, "title") {
        out.title = Some(match title {
            Value::Null => None,
            Value::String(t) => {
                let joined = t.split_whitespace().collect::<Vec<_>>().join(" ");
                clean_text(Some(&json!(joined)), "title", 64)?.filter(|t| !t.is_empty())
            }
            other => clean_text(Some(other), "title", 64)?,
        });
    }
    if let Some(wake) = given(view, "wake") {
        out.wake = Some(
            wake.as_str()
                .filter(|w| *w != "none" && valid_wake(w))
                .map(str::to_owned),
        );
    }
    if let Some(incarnation) = given(view, "incarnation") {
        out.incarnation = Some(match incarnation {
            Value::Null => None,
            Value::String(v)
                if (1..=128).contains(&v.len())
                    && v.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c)) =>
            {
                Some(v.clone())
            }
            _ => return Err(bad("incarnation")),
        });
    }
    Ok(out)
}

fn valid_wake(wake: &str) -> bool {
    if let Some(name) = wake.strip_prefix("hook:") {
        return valid_machine(name) || name == "me";
    }
    !wake.is_empty()
        && wake.len() <= 32
        && wake
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn parse_view(value: &Value, now: i64) -> Result<ParsedView, RpcError> {
    let view = value
        .as_object()
        .ok_or_else(|| RpcError::invalid_params("an endpoint is an object"))?;
    let address = view
        .get("address")
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::invalid_params("an endpoint needs an address"))?;
    let handle = address.rsplit('/').next().unwrap_or("").to_owned();
    let kind = view
        .get("kind")
        .and_then(Value::as_str)
        .filter(|k| matches!(*k, "agent" | "human"))
        .ok_or_else(|| RpcError::invalid_params("an endpoint's kind is agent or human"))?
        .to_owned();
    if if kind == "human" {
        !handle.is_empty()
    } else {
        !valid_handle(&handle)
    } {
        return Err(RpcError::invalid_params(format!(
            "{} is not a valid endpoint address",
            Value::String(address.into())
        )));
    }
    let harness = clean_text(view.get("harness"), "harness", 32)?;
    if let Some(h) = &harness
        && !valid_harness(h)
    {
        return Err(RpcError::invalid_params(format!(
            "harness {} is not a valid name",
            Value::String(h.clone())
        )));
    }
    let status = match view.get("status") {
        None | Some(Value::Null) => None,
        Some(status) => {
            let state = status
                .get("state")
                .and_then(Value::as_str)
                .filter(|s| STATUS_STATES.iter().any(|v| v.as_str() == *s))
                .ok_or_else(|| {
                    RpcError::invalid_params(format!(
                        "state must be one of {}",
                        STATUS_STATES
                            .iter()
                            .map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ))
                })?;
            let note =
                clean_text(status.get("note"), "note", LIMITS.note_chars)?.unwrap_or_default();
            Some((state.to_owned(), note))
        }
    };
    let presence = match view.get("presence") {
        None | Some(Value::Null) => "offline".to_owned(),
        Some(p) => p
            .as_str()
            .filter(|p| PRESENCES.iter().any(|v| v.as_str() == *p))
            .ok_or_else(|| {
                RpcError::invalid_params("presence is online, idle, offline or hibernated")
            })?
            .to_owned(),
    };
    let labels = clean_labels(view.get("labels"))?.to_string();
    let scope = if kind == "agent" {
        parse_scope(view)?
    } else {
        ParsedScope::default()
    };
    let was = view
        .get("was")
        .and_then(Value::as_str)
        .filter(|w| kind == "agent" && valid_handle(w) && *w != handle)
        .map(str::to_owned);
    let out = ParsedView {
        model: clean_text(view.get("model"), "model", 128)?,
        cwd: clean_text(view.get("cwd"), "cwd", 1024)?,
        last_seen: parse_time(view.get("last_seen")),
        active_at: if kind == "agent" {
            parse_time(view.get("active_at")).map(|at| at.min(now))
        } else {
            None
        },
        handle,
        kind,
        harness,
        labels,
        status,
        presence,
        scope,
        was,
    };
    let title = out.scope.title.clone().flatten();
    let leaked = [
        Some(out.handle.as_str()),
        out.model.as_deref(),
        out.cwd.as_deref(),
        Some(out.labels.as_str()),
        out.status.as_ref().map(|s| s.1.as_str()),
        title.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(find_secret);
    if let Some(leaked) = leaked {
        return Err(RpcError::new(
            ErrorCode::SecretRefused,
            format!("an endpoint looks like it carries a credential ({leaked})"),
        ));
    }
    Ok(out)
}

fn entries_map(list: &Value, f: &dyn Fn(&str) -> String) -> Value {
    Value::Array(
        list.as_array()
            .into_iter()
            .flatten()
            .map(|entry| {
                let mut entry = entry.clone();
                if let Some(via) = entry.get("via").and_then(Value::as_str).map(str::to_owned) {
                    entry["via"] = json!(f(&via));
                }
                entry
            })
            .collect(),
    )
}

/// caps with every endpoint reference (`by`, `via`) passed through `f`
fn map_refs(caps: &Value, f: &dyn Fn(&str) -> String) -> Value {
    let list: Vec<Value> = caps["caps"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|cap| {
            let mut cap = cap.clone();
            cap["by"] = json!(f(cap["by"].as_str().unwrap_or("")));
            cap["sels"] = entries_map(&cap["sels"], f);
            cap
        })
        .collect();
    let allow: Map<String, Value> = caps["allow"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, list)| (key.clone(), entries_map(list, f)))
        .collect();
    json!({"caps": list, "allow": allow})
}

fn plain(entry: &Value) -> bool {
    entry.get("via").is_none()
}

fn same_entry(a: &Value, b: &Value) -> bool {
    plain(b) && a.get("sel") == b.get("sel") && a.get("group") == b.get("group")
}

/// a later view's caps over the ones seen before: a cap it leaves out stays, and a cap seen before gains only widened entries
pub fn sticky_caps(seen: &Value, next: &Value) -> Value {
    let old_caps = seen["caps"].as_array().cloned().unwrap_or_default();
    let next_caps = next["caps"].as_array().cloned().unwrap_or_default();
    let mut caps: Vec<Value> = next_caps
        .iter()
        .map(
            |cap| match old_caps.iter().find(|had| had["id"] == cap["id"]) {
                Some(old) => {
                    let mut cap = cap.clone();
                    let sels: Vec<Value> = cap["sels"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|entry| {
                            !plain(entry)
                                || old["sels"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .any(|had| same_entry(entry, had))
                        })
                        .cloned()
                        .collect();
                    cap["sels"] = json!(sels);
                    cap
                }
                None => cap.clone(),
            },
        )
        .collect();
    for old in &old_caps {
        if !next_caps.iter().any(|cap| cap["id"] == old["id"]) {
            caps.push(old.clone());
        }
    }
    json!({"caps": caps, "allow": next.get("allow").cloned().unwrap_or_else(|| json!({}))})
}

/// whether `next` drops a cap of `seen` or gives one of them a plain entry
pub fn loosens(seen: &Value, next: &Value) -> bool {
    let next_caps = next["caps"].as_array().cloned().unwrap_or_default();
    seen["caps"].as_array().into_iter().flatten().any(|old| {
        match next_caps.iter().find(|c| c["id"] == old["id"]) {
            None => true,
            Some(cap) => cap["sels"].as_array().into_iter().flatten().any(|entry| {
                plain(entry)
                    && !old["sels"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|had| same_entry(entry, had))
            }),
        }
    })
}

fn caps_empty(caps: &Value) -> bool {
    caps["caps"].as_array().is_none_or(Vec::is_empty)
        && caps["allow"].as_object().is_none_or(Map::is_empty)
}

/// a mirrored row's activity: what its machine mirrored, else its last_seen, and what this broker saw of it
pub fn remote_active(row: &Row, observed: &HashMap<String, i64>) -> i64 {
    let seen = text(row, "id")
        .and_then(|id| observed.get(id))
        .copied()
        .unwrap_or(0);
    integer(row, "mirrored_active")
        .or_else(|| integer(row, "last_seen"))
        .or_else(|| integer(row, "created_at"))
        .unwrap_or(0)
        .max(seen)
}

/// the presence a mirrored row shows: what its machine mirrored while it is live, hibernated while it stays so
pub fn remote_presence(row: &Row, base: &str) -> String {
    let mirrored = text(row, "mirrored_presence");
    if mirrored == Some("hibernated") {
        return "hibernated".into();
    }
    if integer(row, "connections").unwrap_or(0) > 0
        && let Some(p @ ("online" | "idle")) = mirrored
    {
        return p.into();
    }
    base.into()
}

/// whether another machine's row is a root: its machine placed it at depth 0
pub fn placed_root(row: &Row) -> bool {
    text(row, "parent_ep").is_none()
        && (integer(row, "depth") == Some(0) || text(row, "token_hash").is_some())
}

impl Core {
    pub fn is_local_user(&self, part: &str) -> bool {
        matches!(part, "me" | "local") || self.federation.aliases.contains(part)
    }

    /// `<account>/<machine>/<handle>` of another account, or None for any other address
    pub fn foreign_account(&self, address: &str) -> Option<(String, String, String)> {
        let parts: Vec<&str> = address.trim().split('/').collect();
        let [account, machine, handle] = parts.as_slice() else {
            return None;
        };
        if self.is_local_user(account) || !valid_account(account) || !valid_machine(machine) {
            return None;
        }
        if *handle != "me" && !handle.is_empty() && !valid_handle(handle) {
            return None;
        }
        let handle = if *handle == "me" { "" } else { handle };
        Some(((*account).into(), (*machine).into(), handle.into()))
    }

    async fn known_account(&self, part: &str) -> Result<bool, RpcError> {
        if self.is_local_user(part) || !valid_account(part) {
            return Ok(false);
        }
        let prefix = format!("@{part}/");
        Ok(!self
            .store
            .all(
                "SELECT 1 FROM endpoints WHERE substr(remote, 1, ?) = ? LIMIT 1",
                &[SqlValue::Int(prefix.len() as i64), sv(prefix)],
            )
            .await?
            .is_empty())
    }

    /// the machine (None for this one) and handle an address names
    pub async fn locate(&self, address: &str) -> Result<(Option<String>, String), RpcError> {
        let text = address.trim();
        if text.is_empty() {
            return Err(RpcError::invalid_params(
                "an address is machine/handle, user/handle, or a handle",
            ));
        }
        let parts: Vec<&str> = text.split('/').collect();
        let (mut machine, mut handle) = match parts.as_slice() {
            [handle] => (None, (*handle).to_owned()),
            [user, "me"] if self.known_account(user).await? => {
                return Err(RpcError::invalid_params(format!(
                    "{text} is account {user}'s human, which takes no messages yet; message one of its endpoints ({user}/<machine>/<handle>)"
                )));
            }
            [user, handle] => (
                (!self.is_local_user(user)).then(|| (*user).to_owned()),
                (*handle).to_owned(),
            ),
            [user, machine, handle] if self.is_local_user(user) => {
                (Some((*machine).to_owned()), (*handle).to_owned())
            }
            _ => return Err(unreachable(text)),
        };
        if machine.is_some() && handle == "me" {
            handle = String::new();
        }
        if machine.is_some() && machine == self.federation.machine {
            machine = None;
        }
        Ok((machine, handle))
    }

    /// the hub-side address (`<machine>/<handle>`) an address names, another account's as it is, or None when it is on this machine
    pub async fn route(&self, address: &str) -> Result<Option<String>, RpcError> {
        if self.foreign_account(address).is_some() {
            return Ok(Some(address.trim().to_owned()));
        }
        let (machine, handle) = self.locate(address).await?;
        Ok(machine.map(|machine| format!("{machine}/{handle}")))
    }

    /// whether an address names an endpoint on another machine or of another account; malformed addresses are not remote
    pub async fn is_remote(&self, address: &Value) -> bool {
        match address.as_str() {
            Some(address) => matches!(self.route(address).await, Ok(Some(_))),
            None => false,
        }
    }

    pub async fn by_remote(&self, remote: &str) -> Result<Option<Row>, RpcError> {
        Ok(self
            .store
            .all("SELECT * FROM endpoints WHERE remote = ?", &[sv(remote)])
            .await?
            .into_iter()
            .next())
    }

    /// the mirrored row an address on another machine names
    pub async fn resolve_remote(&self, value: &str) -> Result<Option<Row>, RpcError> {
        if !value.contains('/') {
            return Ok(None);
        }
        if let Some((account, machine, handle)) = self.foreign_account(value) {
            return self
                .by_remote(&format!("@{account}/{machine}/{handle}"))
                .await?
                .map_or_else(|| Err(not_found(value)), |row| Ok(Some(row)));
        }
        let (machine, handle) = self.locate(value).await?;
        let Some(machine) = machine else {
            return Ok(None);
        };
        self.by_remote(&format!("{machine}/{handle}"))
            .await?
            .map_or_else(|| Err(not_found(value.trim())), |row| Ok(Some(row)))
    }

    /// the local endpoint id a hub delivery for `<machine>/<handle>` is for
    pub async fn local_target(&self, target: &Value) -> Result<String, RpcError> {
        let shown = target
            .as_str()
            .map_or_else(|| target.to_string(), str::to_owned);
        let missing = || {
            RpcError::new(
                ErrorCode::NotFound,
                format!("no endpoint {shown} on this machine"),
            )
        };
        let Some(target) = target.as_str().filter(|t| valid_remote(t)) else {
            return Err(missing());
        };
        if Some(machine_part(target)) != self.federation.machine.as_deref() {
            return Err(missing());
        }
        let handle = handle_part(target);
        let row = if handle.is_empty() {
            self.by_handle(HUMAN_HANDLE).await?
        } else if valid_handle(handle) {
            self.by_handle(handle).await?
        } else {
            None
        };
        row.and_then(|r| text(&r, "id").map(str::to_owned))
            .ok_or_else(missing)
    }

    /// the live row of `<machine>/<handle>`
    pub async fn remote_endpoint(&self, machine: &str, handle: &str) -> Result<String, RpcError> {
        if handle.contains('/') {
            return Err(RpcError::invalid_params(
                "from is a handle on the bridge's own machine",
            ));
        }
        self.by_remote(&format!("{machine}/{handle}"))
            .await?
            .and_then(|r| text(&r, "id").map(str::to_owned))
            .ok_or_else(|| {
                RpcError::new(
                    ErrorCode::NotFound,
                    format!("no endpoint {machine}/{handle}"),
                )
            })
    }

    async fn insert_remote(
        &mut self,
        remote: &str,
        kind: &str,
        harness: Option<&str>,
        auth: Option<&str>,
        now: i64,
    ) -> Result<String, RpcError> {
        let id = crate::messages::new_id("ep", now);
        self.store
            .all(
                "INSERT INTO endpoints (id, handle, kind, harness, labels, created_at, remote, auth) VALUES (?, ?, ?, ?, '{}', ?, ?, ?)",
                &[sv(&id), sv(format!("_r_{id}")), sv(kind), opt(harness), SqlValue::Int(now), sv(remote), opt(auth)],
            )
            .await?;
        self.state.presence.insert(id.clone(), 0);
        self.state
            .addresses
            .insert(id.clone(), super::remote_address(remote));
        Ok(id)
    }

    async fn check_cap(&self, adding: usize) -> Result<(), RpcError> {
        let Some(cap) = self.limits.get("endpoints") else {
            return Ok(());
        };
        let rows = self
            .store
            .all(
                "SELECT COUNT(*) AS n FROM endpoints WHERE kind != 'system' AND substr(handle, 1, 6) != '_gone_'",
                &[],
            )
            .await?;
        let live = rows.first().and_then(|r| integer(r, "n")).unwrap_or(0) as u64;
        if live + adding as u64 > cap {
            return Err(RpcError::new(
                ErrorCode::TooLarge,
                format!(
                    "at most {cap} endpoints on this relay, and this needs {}; the deployment raises the endpoints key of SCP_LIMITS",
                    live + adding as u64
                ),
            ));
        }
        Ok(())
    }

    /// wire caps of `machine` with their `ep:<handle>` references as this broker's row ids; one the machine does not mirror is `gone`
    async fn local_caps(&self, machine: &str, caps: &Value) -> Result<Value, RpcError> {
        let mut refs = HashMap::new();
        let mut names = HashSet::new();
        for cap in caps["caps"].as_array().into_iter().flatten() {
            names.insert(cap["by"].as_str().unwrap_or("").to_owned());
            for entry in cap["sels"].as_array().into_iter().flatten() {
                if let Some(via) = entry["via"].as_str() {
                    names.insert(via.to_owned());
                }
            }
        }
        for list in caps["allow"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(_, l)| l)
        {
            for entry in list.as_array().into_iter().flatten() {
                if let Some(via) = entry["via"].as_str() {
                    names.insert(via.to_owned());
                }
            }
        }
        for name in names {
            let mapped = if REFS.contains(&name.as_str()) {
                name.clone()
            } else {
                let handle = name.strip_prefix("ep:").unwrap_or("");
                let row = if valid_handle(handle) {
                    self.by_remote(&format!("{machine}/{handle}")).await?
                } else {
                    None
                };
                row.filter(|r| text(r, "token_hash").is_none() && text(r, "kind") == Some("agent"))
                    .and_then(|r| text(&r, "id").map(str::to_owned))
                    .unwrap_or_else(|| "gone".into())
            };
            refs.insert(name, mapped);
        }
        Ok(map_refs(caps, &|v| {
            refs.get(v).cloned().unwrap_or_else(|| "gone".into())
        }))
    }

    /// caps with this broker's row ids named as `ep:<handle>`, as they cross machines
    fn wire_caps(world: &World, caps: &Value) -> Value {
        map_refs(caps, &|value| {
            if REFS.contains(&value) {
                return value.to_owned();
            }
            match world.row(value) {
                Some(row)
                    if text(row, "kind") == Some("human")
                        && text(row, "remote").is_none()
                        && text(row, "handle") == Some(HUMAN_HANDLE) =>
                {
                    "human".into()
                }
                Some(row) if text(row, "kind") == Some("agent") => format!(
                    "ep:{}",
                    text(row, "remote")
                        .map_or_else(|| text(row, "handle").unwrap_or(""), handle_part)
                ),
                _ => "gone".into(),
            }
        })
    }

    /// the place each agent of a mirror batch gets: a root has no parent and depth 0, a child sits one below a mirrored agent parent
    async fn placements(
        &self,
        machine: &str,
        batch: &[(ParsedView, String, Option<Row>)],
    ) -> Result<HashMap<String, Option<Placement>>, RpcError> {
        let agents: HashMap<&str, usize> = batch
            .iter()
            .enumerate()
            .filter(|(_, (view, _, _))| view.kind == "agent")
            .map(|(i, (view, _, _))| (view.handle.as_str(), i))
            .collect();
        let mut rows = HashMap::new();
        for (view, _, _) in batch {
            if let Some(Some(parent)) = &view.scope.parent
                && valid_handle(parent)
                && !rows.contains_key(parent)
            {
                rows.insert(
                    parent.clone(),
                    self.by_remote(&format!("{machine}/{parent}")).await?,
                );
            }
        }
        fn place(
            handle: &str,
            trail: &mut Vec<String>,
            batch: &[(ParsedView, String, Option<Row>)],
            agents: &HashMap<&str, usize>,
            rows: &HashMap<String, Option<Row>>,
        ) -> Option<Placement> {
            if trail.iter().any(|h| h == handle) {
                return Some(UNKNOWN);
            }
            let scope = &batch[agents[handle]].0.scope;
            match (&scope.parent, &scope.depth) {
                (None, None) => None,
                (None, _) => Some(UNKNOWN),
                (Some(None), depth) => Some(if *depth == Some(Some(0)) {
                    Placement {
                        tree: None,
                        parent_ep: None,
                        depth: Some(0),
                    }
                } else {
                    UNKNOWN
                }),
                (Some(Some(parent)), _) => {
                    let row = rows.get(parent).cloned().flatten();
                    let Some(row) = row.filter(|r| {
                        text(r, "token_hash").is_none() && text(r, "kind") == Some("agent")
                    }) else {
                        return Some(UNKNOWN);
                    };
                    let up = if let Some(&i) = agents.get(parent.as_str()) {
                        trail.push(handle.to_owned());
                        let up = place(parent, trail, batch, agents, rows);
                        trail.pop();
                        up.or_else(|| batch[i].2.as_ref().map(stored))
                            .unwrap_or(UNKNOWN)
                    } else {
                        stored(&row)
                    };
                    let id = text(&row, "id").unwrap_or_default().to_owned();
                    Some(match up.depth {
                        Some(depth) if depth < DEPTH_MAX => Placement {
                            tree: Some(up.tree.unwrap_or_else(|| id.clone())),
                            parent_ep: Some(id),
                            depth: Some(depth + 1),
                        },
                        _ => UNKNOWN,
                    })
                }
            }
        }
        let mut out = HashMap::new();
        for handle in agents.keys() {
            out.insert(
                (*handle).to_owned(),
                place(handle, &mut Vec::new(), batch, &agents, &rows),
            );
        }
        Ok(out)
    }

    /// whether a link of `row` under `key` closes a cycle in what this broker mirrors
    async fn loops(&self, row: &Row, key: &str) -> Result<bool, RpcError> {
        let own = text(row, "remote").map(str::to_owned);
        let id = text(row, "id").unwrap_or_default().to_owned();
        let mut at = if valid_remote(key) {
            self.by_remote(key).await?
        } else {
            None
        };
        let mut seen = HashSet::new();
        while let Some(next) = at {
            let next_id = text(&next, "id").unwrap_or_default().to_owned();
            if next_id == id
                || own
                    .as_deref()
                    .is_some_and(|o| text(&next, "remote") == Some(o))
            {
                return Ok(true);
            }
            if !seen.insert(next_id) || seen.len() > 64 {
                return Ok(false);
            }
            at = match (text(&next, "parent_ep"), text(&next, "parent_addr")) {
                (Some(parent), _) => self.by_id(parent).await?,
                (None, Some(addr)) if valid_remote(addr) => self.by_remote(addr).await?,
                _ => None,
            };
        }
        Ok(false)
    }

    /// an earlier holder's queue goes when another incarnation of a mirrored agent takes its row
    async fn drop_earlier_holder(
        &self,
        row: &Row,
        incarnation: Option<&str>,
    ) -> Result<(), RpcError> {
        let holder = |v: Option<&str>| v.and_then(|v| v.split_once('.')).map(|(h, _)| h.to_owned());
        let (was, next) = (holder(text(row, "incarnation")), holder(incarnation));
        let (Some(was), Some(next)) = (was, next) else {
            return Ok(());
        };
        if was == next {
            return Ok(());
        }
        let id = text(row, "id").unwrap_or_default();
        let deliveries = self
            .store
            .all(
                "DELETE FROM deliveries WHERE endpoint = ? RETURNING seq",
                &[sv(id)],
            )
            .await?
            .len();
        self.audit(
            "mirror_reset",
            Some(id),
            None,
            json!({"target": text(row, "remote"), "xinbox": 0, "deliveries": deliveries}),
        )
        .await
    }

    /// upserts a machine's endpoints from its views; `full` marks its mirrored rows missing from the list offline
    pub async fn mirror(
        &mut self,
        machine: &str,
        views: &Value,
        full: bool,
    ) -> Result<(), RpcError> {
        if !valid_machine(machine) {
            return Err(RpcError::invalid_params(format!(
                "machine {} is not a valid name",
                Value::String(machine.into())
            )));
        }
        let views = views
            .as_array()
            .ok_or_else(|| RpcError::invalid_params("endpoints must be a list"))?;
        if views.len() > 4096 {
            return Err(RpcError::new(ErrorCode::TooLarge, "at most 4096 endpoints"));
        }
        let now = now_ms();
        let mut parsed: Vec<ParsedView> = Vec::new();
        for view in views {
            let view = parse_view(view, now)?;
            match parsed.iter().position(|p| p.handle == view.handle) {
                Some(i) => parsed[i] = view,
                None => parsed.push(view),
            }
        }
        let store = self.store.clone();
        crate::store::transaction(store, self.apply_mirror(machine, parsed, full, now)).await
    }

    async fn apply_mirror(
        &mut self,
        machine: &str,
        parsed: Vec<ParsedView>,
        full: bool,
        now: i64,
    ) -> Result<(), RpcError> {
        let mut added = 0;
        for view in &parsed {
            let fresh = self
                .by_remote(&format!("{machine}/{}", view.handle))
                .await?
                .is_none();
            let renamed = match &view.was {
                Some(was) => self.by_remote(&format!("{machine}/{was}")).await?.is_some(),
                None => false,
            };
            if fresh && !renamed {
                added += 1;
            }
        }
        if added > 0 {
            self.check_cap(added).await?;
        }
        let mut seen = HashSet::new();
        let mut batch: Vec<(ParsedView, String, Option<Row>)> = Vec::new();
        for view in parsed {
            let remote = format!("{machine}/{}", view.handle);
            seen.insert(remote.clone());
            let mut before = self.by_remote(&remote).await?;
            if before.is_none()
                && let Some(was) = &view.was
                && let Some(old) = self.by_remote(&format!("{machine}/{was}")).await?
                && text(&old, "token_hash").is_none()
            {
                let id = text(&old, "id").unwrap_or_default().to_owned();
                self.store
                    .all(
                        "UPDATE endpoints SET remote = ? WHERE id = ?",
                        &[sv(&remote), sv(&id)],
                    )
                    .await?;
                self.store
                    .all(
                        "UPDATE endpoints SET parent_addr = ? WHERE parent_addr = ?",
                        &[sv(&remote), sv(format!("{machine}/{was}"))],
                    )
                    .await?;
                self.state
                    .addresses
                    .insert(id.clone(), super::remote_address(&remote));
                before = self.by_id(&id).await?;
            }
            if before
                .as_ref()
                .is_some_and(|b| text(b, "token_hash").is_some())
            {
                continue;
            }
            let id = match &before {
                Some(row) => text(row, "id").unwrap_or_default().to_owned(),
                None => {
                    self.insert_remote(&remote, &view.kind, view.harness.as_deref(), None, now)
                        .await?
                }
            };
            batch.push((view, id, before));
        }
        let places = self.placements(machine, &batch).await?;
        for (view, id, before) in &batch {
            let Some(row) = (match before {
                Some(row) => Some(row.clone()),
                None => self.by_id(id).await?,
            }) else {
                continue;
            };
            if before.is_some() && view.kind == "agent" {
                self.drop_earlier_holder(&row, view.scope.incarnation.clone().flatten().as_deref())
                    .await?;
            }
            let live = view.presence != "offline" && view.presence != "hibernated";
            let mut next: Vec<(&str, SqlValue)> = vec![
                ("kind", sv(&view.kind)),
                ("harness", opt(view.harness.as_deref())),
                ("model", opt(view.model.as_deref())),
                ("cwd", opt(view.cwd.as_deref())),
                ("labels", sv(&view.labels)),
                (
                    "status_state",
                    opt(view.status.as_ref().map(|s| s.0.as_str())),
                ),
                (
                    "status_note",
                    opt(view.status.as_ref().map(|s| s.1.as_str())),
                ),
                ("token_hash", SqlValue::Null),
                ("connections", SqlValue::Int(i64::from(live))),
                ("mirrored_presence", sv(&view.presence)),
                (
                    "waking_until",
                    if view.presence == "hibernated" {
                        row.get("waking_until").cloned().unwrap_or(SqlValue::Null)
                    } else {
                        SqlValue::Null
                    },
                ),
                (
                    "last_seen",
                    match view.last_seen {
                        Some(at) => SqlValue::Int(at),
                        None if live => SqlValue::Int(now),
                        None => before
                            .as_ref()
                            .and_then(|b| b.get("last_seen").cloned())
                            .unwrap_or(SqlValue::Null),
                    },
                ),
                (
                    "mirrored_active",
                    view.active_at.map_or(SqlValue::Null, SqlValue::Int),
                ),
                ("auth", row.get("auth").cloned().unwrap_or(SqlValue::Null)),
            ];
            if view.kind == "agent" {
                next.extend(
                    self.scope_columns(
                        machine,
                        &view.scope,
                        &row,
                        places.get(&view.handle).cloned().flatten(),
                    )
                    .await?,
                );
            }
            let changed: Vec<(&str, SqlValue)> = next
                .into_iter()
                .filter(|(column, value)| row.get(*column).unwrap_or(&SqlValue::Null) != value)
                .collect();
            if changed.is_empty() {
                continue;
            }
            let sql = format!(
                "UPDATE endpoints SET {} WHERE id = ?",
                changed
                    .iter()
                    .map(|(c, _)| format!("{c} = ?"))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let mut params: Vec<SqlValue> = changed.into_iter().map(|(_, v)| v).collect();
            params.push(sv(id));
            self.store.all(&sql, &params).await?;
        }
        if full {
            let prefix = format!("{machine}/");
            let missing = self
                .store
                .all(
                    "SELECT id, remote FROM endpoints WHERE substr(remote, 1, ?) = ? AND token_hash IS NULL AND connections > 0",
                    &[SqlValue::Int(prefix.len() as i64), sv(&prefix)],
                )
                .await?;
            for row in missing {
                if text(&row, "remote").is_some_and(|r| !seen.contains(r)) {
                    self.store
                        .all(
                            "UPDATE endpoints SET connections = 0, last_seen = ? WHERE id = ?",
                            &[SqlValue::Int(now), opt(text(&row, "id"))],
                        )
                        .await?;
                }
            }
        }
        Ok(())
    }

    /// an agent row's place, rules, caps, title and incarnation after a view: what it left out stays, unless the endpoint is a new incarnation
    async fn scope_columns(
        &self,
        machine: &str,
        scope: &ParsedScope,
        row: &Row,
        placement: Option<Placement>,
    ) -> Result<Vec<(&'static str, SqlValue)>, RpcError> {
        let incarnation = scope.incarnation.clone().flatten();
        let fresh = incarnation.is_some()
            && text(row, "incarnation").is_some()
            && incarnation.as_deref() != text(row, "incarnation");
        let place = placement.unwrap_or_else(|| if fresh { UNKNOWN } else { stored(row) });
        let mut caps = if fresh {
            None
        } else {
            text(row, "caps").map(str::to_owned)
        };
        if let Some(next) = &scope.caps {
            let next = self
                .local_caps(
                    machine,
                    next.as_ref().unwrap_or(&json!({"caps": [], "allow": {}})),
                )
                .await?;
            let merged = match (
                fresh,
                text(row, "caps").and_then(|c| serde_json::from_str::<Value>(c).ok()),
            ) {
                (false, Some(seen)) => sticky_caps(&seen, &next),
                _ => next,
            };
            caps = (!caps_empty(&merged)).then(|| merged.to_string());
        }
        let rules = match &scope.rules {
            Some(Some(rules)) if rules.get("in").is_some() || rules.get("out").is_some() => {
                Some(rules.to_string())
            }
            Some(_) => None,
            None if fresh => None,
            None => text(row, "rules").map(str::to_owned),
        };
        let linked = match &scope.parent_addr {
            Some(key) => key.clone(),
            None if fresh => None,
            None => text(row, "parent_addr").map(str::to_owned),
        };
        let linked = match linked {
            Some(key) if place.parent_ep.is_some() || self.loops(row, &key).await? => None,
            other => other,
        };
        let keep = |given: &Given<String>, column: &str| match given {
            Some(value) => opt(value.as_deref()),
            None if fresh => SqlValue::Null,
            None => opt(text(row, column)),
        };
        Ok(vec![
            ("tree", opt(place.tree.as_deref())),
            ("parent_ep", opt(place.parent_ep.as_deref())),
            ("depth", place.depth.map_or(SqlValue::Null, SqlValue::Int)),
            ("parent_addr", opt(linked.as_deref())),
            ("rules", opt(rules.as_deref())),
            ("caps", opt(caps.as_deref())),
            ("title", keep(&scope.title, "title")),
            ("wake", keep(&scope.wake, "wake")),
            (
                "incarnation",
                opt(incarnation.as_deref().or(text(row, "incarnation"))),
            ),
        ])
    }

    /// a bridge went away: its mirrored rows show offline
    pub async fn mark_offline(&self, machine: &str) -> Result<(), RpcError> {
        let prefix = format!("{machine}/");
        self.store
            .all(
                "UPDATE endpoints SET connections = 0, last_seen = ? WHERE substr(remote, 1, ?) = ? AND token_hash IS NULL AND connections > 0",
                &[SqlValue::Int(now_ms()), SqlValue::Int(prefix.len() as i64), sv(prefix)],
            )
            .await?;
        Ok(())
    }

    /// a released machine: its rows are retired like a gone handle and can't be resolved again
    pub async fn drop_machine(&mut self, machine: &str) -> Result<usize, RpcError> {
        let prefix = format!("{machine}/");
        let rows = self
            .store
            .all(
                "UPDATE endpoints SET handle = ? || id, remote = NULL, token_hash = NULL, connections = 0 WHERE substr(remote, 1, ?) = ? RETURNING id",
                &[sv(GONE_PREFIX), SqlValue::Int(prefix.len() as i64), sv(prefix)],
            )
            .await?;
        for row in &rows {
            if let Some(id) = text(row, "id") {
                self.state.addresses.remove(id);
            }
        }
        Ok(rows.len())
    }

    /// the machines this broker holds mirrored rows of
    pub async fn remote_machines(&self) -> Result<HashSet<String>, RpcError> {
        Ok(self
            .store
            .all("SELECT remote FROM endpoints WHERE remote IS NOT NULL", &[])
            .await?
            .iter()
            .filter_map(|r| text(r, "remote"))
            .filter(|r| !is_foreign(r))
            .map(|r| machine_part(r).to_owned())
            .collect())
    }

    /// a local agent's place, rules and caps as the bridge mirrors them, with its title; nothing for another row
    pub async fn mirror_scope(
        &self,
        world: &World,
        row: &Row,
    ) -> Result<Map<String, Value>, RpcError> {
        if text(row, "kind") != Some("agent") || text(row, "remote").is_some() {
            return Ok(Map::new());
        }
        let id = text(row, "id").unwrap_or_default();
        let Some(node) = world.node_of(id) else {
            return Ok(Map::new());
        };
        let mut caps: Vec<Value> = node
            .caps
            .caps
            .iter()
            .map(|c| serde_json::to_value(c).unwrap_or(Value::Null))
            .collect();
        for group in &node.groups {
            for (dir, rules) in [
                (ScopeDirection::In, &group.r#in),
                (ScopeDirection::Out, &group.out),
            ] {
                let Some(rules) = rules else {
                    continue;
                };
                let key = group_cap_key(&group.name, dir);
                let list = ScopeList {
                    source: String::new(),
                    by: group.owner.clone(),
                    entries: Vec::new(),
                    group: Some(group.name.clone()),
                    cap: None,
                };
                let sels: Vec<Value> = rules
                    .iter()
                    .chain(node.caps.allow.get(&key).into_iter().flatten())
                    .map(|entry| {
                        let mut value = serde_json::to_value(entry).unwrap_or(Value::Null);
                        value["sel"] = json!(effective_selector(&list, entry));
                        value
                    })
                    .collect();
                caps.push(json!({"id": key, "dir": dir, "by": group.owner, "sels": sels}));
            }
        }
        for cap in &node.policy {
            let dir = serde_json::to_value(cap.dir).unwrap_or(Value::Null);
            caps.push(json!({"id": format!("policy:{}:{}", cap.r#match, dir.as_str().unwrap_or("")), "dir": dir, "by": "policy", "sels": cap.sels}));
        }
        let allow: Map<String, Value> = node
            .caps
            .allow
            .iter()
            .filter(|(key, _)| key.starts_with("inherited:"))
            .map(|(key, list)| {
                (
                    key.clone(),
                    serde_json::to_value(list).unwrap_or(Value::Null),
                )
            })
            .collect();
        let mut rules = Map::new();
        if let Some(list) = &node.rules.r#in {
            rules.insert("in".into(), json!(list));
        }
        if let Some(list) = &node.rules.out {
            rules.insert("out".into(), json!(list));
        }
        let wire = (!caps.is_empty() || !allow.is_empty())
            .then(|| Self::wire_caps(world, &json!({"caps": caps, "allow": allow})));
        let epoch = self.scope_epoch(row, wire.as_ref()).await?;
        let handle_of = |id: Option<&str>| {
            id.and_then(|id| world.row(id))
                .and_then(|r| text(r, "handle"))
                .map(str::to_owned)
        };
        let tree = match text(row, "tree") {
            Some(tree) => handle_of(Some(tree)),
            None => text(row, "handle").map(str::to_owned),
        };
        let seed = match integer(row, "spawned_at") {
            Some(at) => format!("{id}@{at}"),
            None => id.to_owned(),
        };
        let mut out = Map::new();
        out.insert("tree".into(), json!(tree));
        out.insert("parent_ep".into(), json!(handle_of(text(row, "parent_ep"))));
        out.insert("depth".into(), json!(integer(row, "depth").unwrap_or(0)));
        out.insert("parent_addr".into(), json!(text(row, "parent_addr")));
        out.insert(
            "rules".into(),
            if rules.is_empty() {
                Value::Null
            } else {
                Value::Object(rules)
            },
        );
        out.insert("caps".into(), wire.unwrap_or(Value::Null));
        out.insert("title".into(), json!(text(row, "title")));
        out.insert(
            "incarnation".into(),
            json!(format!("{}.{epoch}", &hash(&seed)[..24])),
        );
        Ok(out)
    }

    async fn scope_epoch(&self, row: &Row, caps: Option<&Value>) -> Result<i64, RpcError> {
        let epoch = integer(row, "scope_epoch").unwrap_or(0);
        let next_text = caps.map(Value::to_string);
        let seen_text = text(row, "mirrored_caps");
        if next_text.as_deref() == seen_text {
            return Ok(epoch);
        }
        let seen = seen_text.and_then(|s| serde_json::from_str::<Value>(s).ok());
        let empty = json!({"caps": []});
        let next = match &seen {
            Some(seen) if loosens(seen, caps.unwrap_or(&empty)) => epoch + 1,
            _ => epoch,
        };
        self.store
            .all(
                "UPDATE endpoints SET scope_epoch = ?, mirrored_caps = ? WHERE id = ?",
                &[
                    if next == 0 {
                        SqlValue::Null
                    } else {
                        SqlValue::Int(next)
                    },
                    opt(next_text.as_deref()),
                    opt(text(row, "id")),
                ],
            )
            .await?;
        Ok(next)
    }

    /// whether a local view is mirrored to the hub under the bridge's selectors
    pub fn mirrored(&self, selectors: &[String], row: &Row) -> bool {
        if text(row, "kind") == Some("system")
            || text(row, "remote").is_some()
            || text(row, "handle").is_some_and(crate::world::retired)
        {
            return false;
        }
        let human = text(row, "kind") == Some("human");
        let subject = PolicySubject {
            handle: if human {
                String::new()
            } else {
                text(row, "handle").unwrap_or("").to_owned()
            },
            harness: text(row, "harness").map(str::to_owned),
            kind: text(row, "kind").unwrap_or("").to_owned(),
            labels: text(row, "labels")
                .and_then(|l| serde_json::from_str(l).ok())
                .unwrap_or_default(),
            scope: None,
            account: None,
        };
        selectors
            .iter()
            .any(|sel| matches(sel, &subject, None, None))
    }

    /// what a local endpoint looks like to the hub, given its view
    pub async fn outward(
        &self,
        world: &World,
        row: &Row,
        view: &Value,
        redact: bool,
    ) -> Result<Value, RpcError> {
        let mut scope = self.mirror_scope(world, row).await?;
        let title = scope.remove("title");
        let mut out = Value::Object(scope);
        if let Some(title) = title {
            out["title"] = if redact { Value::Null } else { title };
        }
        out["address"] = view["address"].clone();
        out["kind"] = view["kind"].clone();
        out["harness"] = view["harness"].clone();
        out["model"] = view["model"].clone();
        out["cwd"] = if redact {
            Value::Null
        } else {
            view["cwd"].clone()
        };
        out["labels"] = view["labels"].clone();
        out["status"] = match &view["status"] {
            Value::Object(status) => {
                json!({"state": status.get("state"), "note": if redact { json!("") } else { status.get("note").cloned().unwrap_or(json!("")) }})
            }
            _ => Value::Null,
        };
        out["presence"] = view["presence"].clone();
        out["last_seen"] = view["last_seen"].clone();
        if view["kind"] == "agent" {
            out["wake"] = view.get("wake").cloned().unwrap_or(Value::Null);
            out["active_at"] = view.get("active_at").cloned().unwrap_or(Value::Null);
        }
        Ok(out)
    }

    /// the local rows the bridge may mirror, oldest first, with their views
    pub async fn local_rows(&self, historic: bool) -> Result<Vec<(Row, Value)>, RpcError> {
        let rows = self
            .store
            .all(
                "SELECT * FROM endpoints WHERE remote IS NULL AND kind != 'system' AND substr(handle,1,5) != 'gone:' AND substr(handle,1,6) != '_gone_' ORDER BY created_at, id",
                &[],
            )
            .await?;
        let mut out = Vec::new();
        for row in rows {
            let view = self.view(&row).await?;
            if !historic
                && view["kind"] == "agent"
                && parse_time(view.get("active_at")).is_some_and(|at| at < now_ms() - 86_400_000)
            {
                continue;
            }
            out.push((row, view));
        }
        Ok(out)
    }

    /// the causal hop a send of `endpoint` carries: one past the last it received within the window
    pub async fn causal_hop(&self, endpoint: &str) -> Result<i64, RpcError> {
        let row = self.must_endpoint(endpoint).await?;
        Ok(match integer(&row, "last_received_at") {
            Some(at) if at >= now_ms() - LIMITS.causal_window_s as i64 * 1000 => {
                (integer(&row, "last_received_hop").unwrap_or(0) + 1).min(HOP_FLOOR_MAX as i64)
            }
            _ => 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sticky_caps_keep_seen_caps_and_take_only_widened_entries() {
        let seen = json!({"caps": [{"id": "a", "dir": "in", "by": "x", "sels": [{"sel": "*"}]}, {"id": "b", "dir": "out", "by": "x", "sels": []}], "allow": {}});
        let next = json!({"caps": [{"id": "a", "dir": "in", "by": "x", "sels": [{"sel": "*"}, {"sel": "kind:human"}, {"sel": "kind:agent", "via": "y"}]}], "allow": {}});
        let merged = sticky_caps(&seen, &next);
        assert_eq!(
            merged["caps"][0]["sels"],
            json!([{"sel": "*"}, {"sel": "kind:agent", "via": "y"}])
        );
        assert_eq!(merged["caps"][1]["id"], "b");
        assert!(loosens(&seen, &next));
        assert!(!loosens(&seen, &merged));
    }

    #[test]
    fn views_parse_with_their_scope_and_refuse_bad_addresses() {
        let view = parse_view(&json!({"address": "me/bob", "kind": "agent", "presence": "online", "parent_ep": null, "depth": 0, "incarnation": "abc.0"}), 0).unwrap();
        assert_eq!(
            (view.handle.as_str(), view.presence.as_str()),
            ("bob", "online")
        );
        assert_eq!(view.scope.parent, Some(None));
        assert_eq!(view.scope.depth, Some(Some(0)));
        assert!(parse_view(&json!({"address": "me/", "kind": "agent"}), 0).is_err());
        assert!(parse_view(&json!({"address": "me/x", "kind": "human"}), 0).is_err());
        assert!(
            parse_view(
                &json!({"address": "me/x", "kind": "agent", "presence": "away"}),
                0
            )
            .is_err()
        );
        assert_eq!(
            parse_view(&json!({"address": "me/", "kind": "human"}), 0)
                .unwrap()
                .presence,
            "offline"
        );
    }

    #[test]
    fn mirrored_presence_shows_while_live() {
        let mut row = Row::new();
        row.insert("mirrored_presence".into(), sv("online"));
        row.insert("connections".into(), SqlValue::Int(1));
        assert_eq!(remote_presence(&row, "idle"), "online");
        row.insert("connections".into(), SqlValue::Int(0));
        assert_eq!(remote_presence(&row, "offline"), "offline");
        row.insert("mirrored_presence".into(), sv("hibernated"));
        assert_eq!(remote_presence(&row, "offline"), "hibernated");
    }
}
