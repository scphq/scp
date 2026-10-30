use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::proto::RpcError;

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
