use serde_json::{Map, Value, json};

use crate::core::{Core, integer, text};
use crate::policy::{Policy, preset, valid_selector};
use crate::proto::RpcError;
use crate::store::SqlValue;
use crate::views::address;

fn selectors(value: &Value, field: &str) -> Result<Value, RpcError> {
    let values = value
        .as_array()
        .filter(|values| values.len() <= 64)
        .ok_or_else(|| {
            RpcError::invalid_params(format!("{field} is a list of at most 64 selectors"))
        })?;
    let mut result = Vec::new();
    for value in values {
        let named = value.as_str().map(|value| {
            if !value.contains(':') && crate::claims::valid_handle(value) {
                format!("ep:{value}")
            } else {
                value.into()
            }
        });
        if let Some(word) = value.as_str().filter(|word| {
            [
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
            ]
            .contains(word)
        }) {
            let scope = if word == "self" { "tree" } else { word };
            let relation = if word == "tree" { "self" } else { word };
            return Err(RpcError::invalid_params(format!(
                "{field}: \"{word}\" is a scope word, not a handle: use --scope {scope} or tree:{relation}, or ep:{word} for an endpoint named {word}"
            )));
        }
        let named = named
            .filter(|value| valid_selector(value, false, false))
            .ok_or_else(|| {
                RpcError::invalid_params(format!("{field}: {value} is not a selector"))
            })?;
        let entry = Value::String(named);
        if !result.contains(&entry) {
            result.push(entry);
        }
    }
    Ok(json!(result))
}

impl Core {
    pub async fn rules(&self, endpoint: &str) -> Result<Value, RpcError> {
        let row = self.must_endpoint(endpoint).await?;
        if text(&row, "kind") != Some("agent") {
            return Err(RpcError::invalid_params(
                "the human has no scope; name an endpoint",
            ));
        }
        let stored: Value = text(&row, "rules")
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| RpcError::internal())?
            .unwrap_or_else(|| json!({}));
        let mut rules = json!({});
        for dir in ["in", "out"] {
            if let Some(list) = stored.get(dir) {
                rules[dir] = list.clone();
            }
        }
        let caps: Value = text(&row, "caps")
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| RpcError::internal())?
            .unwrap_or_else(|| json!({}));
        let groups = self
            .store
            .all(
                "SELECT name FROM group_members WHERE endpoint = ?",
                &[SqlValue::Text(endpoint.into())],
            )
            .await?
            .iter()
            .filter_map(|row| text(row, "name").map(str::to_owned))
            .collect::<Vec<_>>();
        let symmetric = Policy(self.policy.clone().unwrap_or_else(|| json!({})))
            .default_of("symmetric_presets")
            == true;
        let dirs: &[&str] = if symmetric { &["in", "out"] } else { &["out"] };
        let mut name = "custom";
        if dirs.iter().all(|dir| rules.get(*dir).is_none()) {
            name = "open";
        }
        for candidate in ["tree", "parent", "none"] {
            let expected = preset(candidate).ok_or_else(RpcError::internal)?;
            if dirs.iter().all(|dir| {
                rules
                    .get(*dir)
                    .is_some_and(|value| same_set(value, &expected))
            }) {
                name = candidate;
            }
        }
        Ok(
            json!({"address":address(&row), "tree":self.address_of(text(&row,"tree").unwrap_or(endpoint)).await?, "parent": match text(&row,"parent_ep") {Some(id)=>Some(self.address_of(id).await?),None=>None}, "depth":integer(&row,"depth").unwrap_or(0), "rules":rules, "caps":caps.get("caps").cloned().unwrap_or_else(|| json!([])), "groups":groups, "preset":name}),
        )
    }

    pub async fn rules_set(
        &mut self,
        endpoint: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let row = self.must_endpoint(endpoint).await?;
        if text(&row, "kind") != Some("agent") {
            return Err(RpcError::invalid_params(
                "the human has no rules of its own; name an endpoint",
            ));
        }
        let mut stored: Value = text(&row, "rules")
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| RpcError::internal())?
            .unwrap_or_else(|| json!({}));
        let object = stored.as_object_mut().ok_or_else(RpcError::internal)?;
        let mut changes = Map::new();
        if params.contains_key("scope") || params.contains_key("allow") {
            let scope = params
                .get("scope")
                .map(|value| {
                    value
                        .as_str()
                        .filter(|value| preset(value).is_some())
                        .ok_or_else(|| {
                            RpcError::invalid_params(
                                "scope must be one of open, tree, parent, none",
                            )
                        })
                })
                .transpose()?;
            let allow = params
                .get("allow")
                .map(|value| selectors(value, "allow"))
                .transpose()?;
            if scope == Some("open")
                && allow
                    .as_ref()
                    .and_then(Value::as_array)
                    .is_some_and(|list| !list.is_empty())
            {
                return Err(RpcError::invalid_params(
                    "allow adds to a preset with a list: tree, parent or none",
                ));
            }
            let mut list = scope.and_then(preset).unwrap_or_else(|| json!([]));
            if let Some(allow) = allow.and_then(|value| value.as_array().cloned())
                && let Some(list) = list.as_array_mut()
            {
                for value in allow {
                    if !list.contains(&value) {
                        list.push(value);
                    }
                }
            }
            let symmetric = Policy(self.policy.clone().unwrap_or_else(|| json!({})))
                .default_of("symmetric_presets")
                == true;
            if symmetric {
                changes.insert("in".into(), list.clone());
            }
            changes.insert("out".into(), list);
        }
        for dir in ["in", "out"] {
            if let Some(value) = params.get(dir) {
                changes.insert(dir.into(), selectors(value, dir)?);
            }
        }
        if changes.is_empty() {
            return Err(RpcError::invalid_params("set in, out, scope or allow"));
        }
        for (dir, list) in changes {
            if list.is_null() {
                object.remove(&dir);
            } else {
                object.insert(dir, list);
            }
        }
        self.store
            .all(
                "UPDATE endpoints SET rules = ? WHERE id = ?",
                &[
                    SqlValue::Text(stored.to_string()),
                    SqlValue::Text(endpoint.into()),
                ],
            )
            .await?;
        self.rules(endpoint).await
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
