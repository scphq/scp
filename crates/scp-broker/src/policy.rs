use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::core::Core;
use crate::proto::RpcError;
use crate::state::ConnectionId;
use crate::store::SqlValue;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Policy(pub Value);

pub fn valid_selector(value: &str, absolute: bool, group_rules: bool) -> bool {
    if value == "group:self" {
        return group_rules;
    }
    static SELECTOR: OnceLock<Regex> = OnceLock::new();
    let pattern = SELECTOR.get_or_init(|| {
        let name = "[a-z0-9][a-z0-9._-]{0,62}";
        Regex::new(&format!(r"^(?:\*|ep:{name}|handle:[a-z0-9._*-]{{1,63}}|harness:[a-z0-9-]{{1,32}}|kind:(?:agent|human)|label:[a-z0-9._-]{{1,32}}=[^\s]{{0,128}}|group:{name}(?:/{name})?|fleet:(?:\*|{name})|machine:[A-Za-z0-9][A-Za-z0-9._-]{{0,62}}|org:(?:\*|{name})|acct:(?:\*|[a-z0-9][a-z0-9-]{{0,63}})|tree:(?:self|root|parent|siblings|children)|tree:(?:ancestors|descendants)(?::(?:[1-9]|1[0-6]))?)$")).expect("constant selector pattern")
    });
    pattern.is_match(value) && !(absolute && value.starts_with("tree:"))
}

pub fn preset(name: &str) -> Option<Value> {
    match name {
        "open" => Some(Value::Null),
        "tree" => Some(json!(["tree:parent", "tree:descendants"])),
        "parent" => Some(json!(["tree:parent"])),
        "none" => Some(json!([])),
        _ => None,
    }
}

fn object<'a>(value: &'a Value, message: &str) -> Result<&'a Map<String, Value>, RpcError> {
    value
        .as_object()
        .ok_or_else(|| RpcError::invalid_params(message))
}

fn unknown(value: &Map<String, Value>, keys: &[&str], prefix: &str) -> Result<(), RpcError> {
    let extra: Vec<_> = value
        .keys()
        .filter(|key| !keys.contains(&key.as_str()))
        .cloned()
        .collect();
    if extra.is_empty() {
        Ok(())
    } else {
        Err(RpcError::invalid_params(format!(
            "{prefix}{}",
            extra.join(", ")
        )))
    }
}

fn list(
    value: Option<&Value>,
    where_: &str,
    absolute: bool,
    group_rules: bool,
) -> Result<Option<Value>, RpcError> {
    let Some(value) = value else { return Ok(None) };
    let values = value
        .as_array()
        .filter(|values| values.len() <= 64)
        .ok_or_else(|| RpcError::invalid_params(format!("{where_} must be a list")))?;
    for value in values {
        if !value
            .as_str()
            .is_some_and(|value| valid_selector(value, absolute, group_rules))
        {
            return Err(RpcError::invalid_params(format!(
                "{where_}: {value} is not a selector"
            )));
        }
    }
    Ok(Some(value.clone()))
}

impl Policy {
    pub fn parse(value: &Value) -> Result<Self, RpcError> {
        let input = object(value, "a policy is {rules: [...]}")?;
        unknown(
            input,
            &["rules", "groups", "defaults", "judge"],
            "unknown policy fields: ",
        )?;
        let rules = input
            .get("rules")
            .and_then(Value::as_array)
            .filter(|rules| rules.len() <= 256)
            .ok_or_else(|| RpcError::invalid_params("rules must be a list of at most 256 rules"))?;
        let mut parsed = json!({"rules": []});
        for (index, value) in rules.iter().enumerate() {
            let rule = object(value, &format!("rule {index} is not an object"))?;
            unknown(
                rule,
                &["match", "accept_from", "send_to", "scope"],
                &format!("rule {index} has unknown fields: "),
            )?;
            if !rule
                .get("match")
                .and_then(Value::as_str)
                .is_some_and(|value| valid_selector(value, true, false))
            {
                let named = rule
                    .get("match")
                    .map_or("undefined".into(), Value::to_string);
                return Err(RpcError::invalid_params(format!(
                    "rule {index} match: {named} is not a selector"
                )));
            }
            let mut output = json!({"match": rule["match"]});
            for key in ["accept_from", "send_to", "scope"] {
                let values = if key == "scope" {
                    match rule.get(key).and_then(Value::as_str).and_then(preset) {
                        Some(Value::Null) => None,
                        Some(values) => Some(values),
                        None => list(rule.get(key), &format!("rule {index} {key}"), false, false)?,
                    }
                } else {
                    list(rule.get(key), &format!("rule {index} {key}"), false, false)?
                };
                if let Some(values) = values {
                    output[key] = values;
                }
            }
            parsed["rules"]
                .as_array_mut()
                .ok_or_else(RpcError::internal)?
                .push(output);
        }
        if let Some(values) = input.get("groups") {
            let groups = values
                .as_array()
                .filter(|groups| groups.len() <= 64)
                .ok_or_else(|| {
                    RpcError::invalid_params("groups must be a list of at most 64 groups")
                })?;
            let mut names = HashSet::new();
            let mut output = Vec::new();
            for (index, value) in groups.iter().enumerate() {
                let group = object(value, &format!("group {index} is not an object"))?;
                unknown(
                    group,
                    &["name", "members", "in", "out", "rules"],
                    &format!("group {index} has unknown fields: "),
                )?;
                let name = group
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| {
                        *name != "self"
                            && valid_selector(&format!("ep:{name}"), true, false)
                            && names.insert((*name).to_owned())
                    })
                    .ok_or_else(|| {
                        RpcError::invalid_params(format!("group {index} needs a unique name"))
                    })?;
                let mut entry = json!({"name": name, "members": list(group.get("members"), &format!("group {name} members"), true, false)?.unwrap_or_else(|| json!([]))});
                for key in ["in", "out", "rules"] {
                    if let Some(values) =
                        list(group.get(key), &format!("group {name} {key}"), false, true)?
                    {
                        entry[key] = values;
                    }
                }
                output.push(entry);
            }
            parsed["groups"] = json!(output);
        }
        if let Some(value) = input.get("defaults") {
            let defaults = object(value, "defaults is an object")?;
            unknown(
                defaults,
                &[
                    "human_always",
                    "symmetric_presets",
                    "child_default",
                    "verify_lineage",
                    "rename",
                    "unlink",
                ],
                "unknown defaults: ",
            )?;
            for (key, value) in defaults {
                let valid = match key.as_str() {
                    "human_always" | "symmetric_presets" => value.is_boolean(),
                    "child_default" => value
                        .as_str()
                        .is_some_and(|value| value == "inherit" || preset(value).is_some()),
                    "verify_lineage" => value.is_boolean() || value == "spike",
                    "rename" => value == "root" || value == "self",
                    "unlink" => value == "human" || value == "self",
                    _ => false,
                };
                if !valid {
                    let choices = match key.as_str() {
                        "human_always" | "symmetric_presets" => "true or false",
                        "child_default" => "inherit or one of open, tree, parent, none",
                        "verify_lineage" => "spike, true or false",
                        "rename" => "root or self",
                        _ => "human or self",
                    };
                    return Err(RpcError::invalid_params(format!(
                        "defaults.{key} is {choices}"
                    )));
                }
                if key == "verify_lineage" && value == true {
                    return Err(RpcError::invalid_params(
                        "defaults.verify_lineage true needs the peer-pid check, which this relay does not have yet: use spike or false",
                    ));
                }
            }
            parsed["defaults"] = value.clone();
        }
        if let Some(judge) = input.get("judge") {
            parsed["judge"] = crate::judge::parse_policy(judge)?;
        }
        Ok(Self(parsed))
    }

    pub fn default_of(&self, name: &str) -> Value {
        self.0
            .get("defaults")
            .and_then(|defaults| defaults.get(name))
            .cloned()
            .unwrap_or_else(|| match name {
                "human_always" | "symmetric_presets" => json!(true),
                "child_default" => json!("inherit"),
                "verify_lineage" => json!("spike"),
                "rename" => json!("root"),
                "unlink" => json!("human"),
                _ => Value::Null,
            })
    }
}

const POLICY_LOADS_KEPT: i64 = 8;

/// The policy as text that ignores the order of rules, groups and selector lists.
pub fn canonical(policy: &Value) -> String {
    let sorted = |value: Option<&Value>| {
        value.and_then(Value::as_array).map(|list| {
            let mut list: Vec<String> = list
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            list.sort();
            list
        })
    };
    let mut rules: Vec<String> = policy
        .get("rules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|rule| {
            let mut rule = rule.clone();
            for key in ["accept_from", "send_to", "scope"] {
                if let Some(list) = sorted(rule.get(key)) {
                    rule[key] = json!(list);
                }
            }
            rule.to_string()
        })
        .collect();
    rules.sort();
    let mut groups: Vec<Value> = policy
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|group| {
            let mut group = group.clone();
            for key in ["members", "in", "out", "rules"] {
                if let Some(list) = sorted(group.get(key)) {
                    group[key] = json!(list);
                }
            }
            group
        })
        .collect();
    groups.sort_by_key(|g| {
        g.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    });
    let mut out = json!({"rules": rules, "groups": groups, "defaults": policy.get("defaults").cloned().unwrap_or_else(|| json!({}))});
    if let Some(judge) = policy.get("judge") {
        out["judge"] = judge.clone();
    }
    out.to_string()
}

fn group_selectors(policy: &Value) -> Vec<String> {
    let mut sels = Vec::new();
    let mut take = |value: Option<&Value>| {
        if let Some(list) = value {
            match list {
                Value::String(sel) => sels.push(sel.clone()),
                Value::Array(list) => {
                    sels.extend(list.iter().filter_map(Value::as_str).map(str::to_owned))
                }
                _ => {}
            }
        }
    };
    for rule in policy
        .get("rules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for key in ["match", "scope", "send_to", "accept_from"] {
            take(rule.get(key));
        }
    }
    for group in policy
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for key in ["members", "rules", "in", "out"] {
            take(group.get(key));
        }
    }
    sels
}

impl Core {
    /// Reads the policy file when its text changed; an unreadable or invalid file refuses messages until it is fixed.
    pub async fn load_policy(&mut self) -> Result<(), RpcError> {
        self.read_policy().await?;
        self.judge
            .configure(self.policy.as_ref().and_then(|p| p.get("judge")));
        Ok(())
    }

    async fn read_policy(&mut self) -> Result<(), RpcError> {
        let file = self.policy_file.display().to_string();
        let text = match tokio::fs::read_to_string(&self.policy_file).await {
            Ok(text) => Some(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if tokio::fs::symlink_metadata(&self.policy_file).await.is_ok() {
                    self.policy_text = None;
                    self.policy_error = Some(format!(
                        "the relay policy at {file} is a link to a missing file; messages are refused until it is fixed"
                    ));
                    return Ok(());
                }
                None
            }
            Err(error) => {
                self.policy_text = None;
                self.policy_error = Some(format!(
                    "the relay policy at {file} cannot be read ({error}); messages are refused until it is fixed"
                ));
                return Ok(());
            }
        };
        if self.policy_text.as_ref() == Some(&text) {
            return Ok(());
        }
        self.policy_text = Some(text.clone());
        let Some(text) = text else {
            self.set_policy(None).await?;
            self.policy_error = None;
            return Ok(());
        };
        match serde_json::from_str::<Value>(&text)
            .map_err(|e| e.to_string())
            .and_then(|v| Policy::parse(&v).map(|p| p.0).map_err(|e| e.message))
        {
            Ok(policy) => {
                self.set_policy(Some(policy)).await?;
                self.policy_error = None;
            }
            Err(error) => {
                self.policy_error = Some(format!(
                    "the relay policy at {file} is invalid ({error}); messages are refused until it is fixed"
                ));
            }
        }
        Ok(())
    }

    /// Installs a policy and binds each `group:<name>` naming no policy group to the group of that name at load.
    pub async fn set_policy(&mut self, policy: Option<Value>) -> Result<(), RpcError> {
        self.policy = policy;
        self.policy_binds.clear();
        let Some(policy) = self.policy.clone() else {
            return Ok(());
        };
        let key = crate::claims::hash(&canonical(&policy));
        let fixed: Vec<String> = policy
            .get("groups")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|g| g.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect();
        let text = |v: &str| SqlValue::Text(v.into());
        let store = self.store.clone();
        let binds = crate::store::transaction(store.clone(), async {
            store.all("DELETE FROM policy_loads WHERE policy = ?", &[text(&key)]).await?;
            store.all("INSERT INTO policy_loads (policy, at) VALUES (?, ?)", &[text(&key), SqlValue::Int(crate::core::now_ms())]).await?;
            store.all(&format!("DELETE FROM policy_loads WHERE policy NOT IN (SELECT policy FROM policy_loads ORDER BY at DESC, rowid DESC LIMIT {POLICY_LOADS_KEPT})"), &[]).await?;
            store.all("DELETE FROM policy_binds WHERE policy NOT IN (SELECT policy FROM policy_loads)", &[]).await?;
            let mut binds = std::collections::HashMap::new();
            for row in store.all("SELECT name, grp FROM policy_binds WHERE policy = ?", &[text(&key)]).await? {
                if let (Some(name), Some(grp)) = (crate::core::text(&row, "name"), crate::core::text(&row, "grp")) {
                    binds.insert(name.to_owned(), grp.to_owned());
                }
            }
            for sel in group_selectors(&policy) {
                let Some(name) = sel.strip_prefix("group:") else { continue };
                if name == "self" || fixed.iter().any(|f| f == name) || binds.contains_key(name) {
                    continue;
                }
                let group = if scp_core::scope::valid_group_name(name) {
                    store.all("SELECT id FROM groups WHERE name = ?", &[text(name)]).await?.into_iter().next().and_then(|r| crate::core::text(&r, "id").map(str::to_owned))
                } else {
                    None
                };
                let group = group.unwrap_or_else(|| "none".into());
                store.all("INSERT INTO policy_binds (policy, name, grp) VALUES (?, ?, ?)", &[text(&key), text(name), text(&group)]).await?;
                binds.insert(name.to_owned(), group);
            }
            Ok::<_, RpcError>(binds)
        })
        .await?;
        self.policy_binds = binds;
        Ok(())
    }

    pub async fn policy_info(&mut self) -> Result<Value, RpcError> {
        self.load_policy().await?;
        Ok(self.broker_info()["policy"].clone())
    }

    /// The policy state; only the human reads its text.
    pub async fn policy_view(&mut self, conn: ConnectionId) -> Result<Value, RpcError> {
        let mut info = self.policy_info().await?;
        let human = matches!(self.actor_of(conn)?, crate::authority::Actor::Human { .. });
        info["policy"] = match &self.policy_text {
            Some(Some(text)) if human && info["state"] == "loaded" => {
                serde_json::from_str(text).unwrap_or(Value::Null)
            }
            _ => Value::Null,
        };
        Ok(info)
    }

    pub async fn policy_check(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let from = params.get("from").map(param_text).unwrap_or_default();
        let to = params.get("to").map(param_text).unwrap_or_default();
        if self.viewer_of(conn).is_some() {
            let actor = self.actor_of(conn)?;
            self.why(&actor, &from, &to).await?;
        }
        let info = self.policy_info().await?;
        let file = info["file"].clone();
        if let Some(error) = info.get("error") {
            return Ok(json!({"allowed": false, "reason": error, "file": file}));
        }
        let (a, b) = (self.lookup(&from).await?, self.lookup(&to).await?);
        let reason = self.policy_refusal(&a, &b).await?;
        Ok(json!({"allowed": reason.is_none(), "reason": reason, "file": file}))
    }

    /// Refuses a send while the policy file is unreadable or invalid.
    pub async fn policy_gate(&mut self) -> Result<(), RpcError> {
        self.load_policy().await?;
        match &self.policy_error {
            Some(error) => Err(RpcError::new(
                scp_core::protocol::ErrorCode::PolicyRefused,
                error.clone(),
            )),
            None => Ok(()),
        }
    }
}

fn param_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_defaults_rules_and_groups() {
        let policy = Policy::parse(&json!({"rules":[{"match":"ep:worker", "scope":"tree", "accept_from":[]}], "groups":[{"name":"build", "rules":["group:self"]}], "defaults":{"rename":"self", "verify_lineage":false}})).expect("policy");
        assert_eq!(policy.default_of("rename"), "self");
        assert_eq!(policy.default_of("human_always"), true);
        assert_eq!(
            policy.0["rules"][0]["scope"],
            json!(["tree:parent", "tree:descendants"])
        );
        assert_eq!(policy.0["groups"][0]["members"], json!([]));
        assert!(Policy::parse(&json!({"rules":[], "defaults":{"verify_lineage":true}})).is_err());
        assert!(Policy::parse(&json!({"rules":[{"match":"tree:self"}]})).is_err());
        assert!(Policy::parse(&json!({"rules":[], "unknown":true})).is_err());
    }

    #[test]
    fn selectors_are_strict() {
        assert!(valid_selector("tree:ancestors:16", false, false));
        assert!(!valid_selector("tree:ancestors:17", false, false));
        assert!(!valid_selector("group:self", false, false));
        assert!(valid_selector("group:self", false, true));
        assert!(!valid_selector("ep:UPPER", false, false));
    }
}
