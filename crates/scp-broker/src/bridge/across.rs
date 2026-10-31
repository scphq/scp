//! Links between a local agent and a parent on another machine: the parent's key on the child's row, checked against cycles.

use std::collections::HashSet;

use scp_core::protocol::ErrorCode;

use super::{handle_part, is_foreign, machine_part, remote_address, valid_remote};
use crate::claims::valid_handle;
use crate::core::{Core, text};
use crate::proto::RpcError;
use crate::store::{Row, SqlValue};
use crate::views::address;

const DEPTH_MAX: usize = 32;

/// `<machine>/<handle>` of a row of this account: a mirrored row's remote, a local one's on `machine`; None for another account's or without a machine
pub fn key_of(row: &Row, machine: Option<&str>) -> Option<String> {
    match text(row, "remote") {
        Some(remote) => (!is_foreign(remote)).then(|| remote.to_owned()),
        None => machine.map(|m| format!("{m}/{}", text(row, "handle").unwrap_or_default())),
    }
}

/// whether `a` and `b` are a parent and its child on different machines
pub fn linked_across(a: &Row, b: &Row, machine: Option<&str>) -> bool {
    let (ka, kb) = (key_of(a, machine), key_of(b, machine));
    let points = |row: &Row, key: &Option<String>| {
        key.is_some() && text(row, "parent_addr").is_some_and(|v| Some(v) == key.as_deref())
    };
    points(a, &kb) || points(b, &ka)
}

impl Core {
    pub fn key_of(&self, row: &Row) -> Option<String> {
        key_of(row, self.federation.machine.as_deref())
    }

    /// the row `<machine>/<handle>` names: a local one on this machine, else a mirrored one
    pub async fn by_key(&self, key: &str) -> Result<Option<Row>, RpcError> {
        if !valid_remote(key) {
            return Ok(None);
        }
        let handle = handle_part(key);
        if Some(machine_part(key)) == self.federation.machine.as_deref() {
            if !valid_handle(handle) {
                return Ok(None);
            }
            return Ok(self.by_handle(handle).await?.filter(Core::is_local_row));
        }
        self.by_remote(key).await
    }

    /// whether walking up from `start` (local and mirrored parents, then a link across machines) reaches a row whose id or key is in `targets`
    pub async fn reaches_up(
        &self,
        start: Row,
        targets: &HashSet<String>,
    ) -> Result<bool, RpcError> {
        let mut seen = HashSet::new();
        let mut at = Some(start);
        while let Some(row) = at {
            let id = text(&row, "id").unwrap_or_default().to_owned();
            if seen.contains(&id) || seen.len() > DEPTH_MAX * 4 {
                return Ok(false);
            }
            if targets.contains(&id) || self.key_of(&row).is_some_and(|k| targets.contains(&k)) {
                return Ok(true);
            }
            seen.insert(id);
            at = match (text(&row, "parent_ep"), text(&row, "parent_addr")) {
                (Some(parent), _) => self.by_id(parent).await?,
                (None, Some(key)) => self.by_key(key).await?,
                _ => None,
            };
        }
        Ok(false)
    }

    /// the key `<machine>/<handle>` that links `row`, a local agent, under `parent`, a mirrored agent of this account that neither is nor sits under `row` or one of its descendants
    pub async fn link_across(&self, row: &Row, parent: &Row) -> Result<String, RpcError> {
        let remote = text(parent, "remote")
            .filter(|r| {
                !is_foreign(r)
                    && text(parent, "kind") == Some("agent")
                    && !handle_part(r).is_empty()
            })
            .ok_or_else(|| {
                RpcError::invalid_params("the parent is an agent endpoint of this account")
            })?
            .to_owned();
        if text(row, "parent_addr") == Some(remote.as_str()) {
            return Ok(remote);
        }
        let id = text(row, "id").unwrap_or_default();
        let mut targets: HashSet<String> = self
            .store
            .all(
                "SELECT id FROM endpoints WHERE tree = ?",
                &[SqlValue::Text(id.into())],
            )
            .await?
            .iter()
            .filter_map(|r| text(r, "id").map(str::to_owned))
            .collect();
        targets.insert(id.to_owned());
        targets.extend(self.key_of(row));
        if self.reaches_up(parent.clone(), &targets).await? {
            return Err(RpcError::new(
                ErrorCode::ScopeRefused,
                format!(
                    "{} sits under {}: a session cannot go under its own descendant",
                    address(parent),
                    address(row)
                ),
            ));
        }
        Ok(remote)
    }

    /// the address of `row`'s parent on another machine, None when it has none; with `shown`, None for a parent outside it
    pub async fn linked_parent(
        &self,
        row: &Row,
        shown: Option<&HashSet<String>>,
    ) -> Result<Option<String>, RpcError> {
        let Some(key) = text(row, "parent_addr") else {
            return Ok(None);
        };
        Ok(match self.by_key(key).await? {
            Some(parent) => shown
                .is_none_or(|s| s.contains(text(&parent, "id").unwrap_or_default()))
                .then(|| address(&parent)),
            None => shown.is_none().then(|| remote_address(key)),
        })
    }

    /// whether a link of `row` under `key` closes a cycle in what this broker mirrors
    pub async fn loops(&self, row: &Row, key: &str) -> Result<bool, RpcError> {
        let Some(parent) = self.by_key(key).await? else {
            return Ok(false);
        };
        let mut targets = HashSet::from([text(row, "id").unwrap_or_default().to_owned()]);
        targets.extend(self.key_of(row));
        self.reaches_up(parent, &targets).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pairs: &[(&str, &str)]) -> Row {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), SqlValue::Text((*v).into())))
            .collect()
    }

    #[test]
    fn a_pair_is_linked_across_only_by_the_childs_key_of_its_parent() {
        let local = row(&[("id", "a"), ("handle", "lead")]);
        let child = row(&[
            ("id", "b"),
            ("remote", "desk/child"),
            ("parent_addr", "laptop/lead"),
        ]);
        let other = row(&[
            ("id", "c"),
            ("remote", "desk/other"),
            ("parent_addr", "laptop/else"),
        ]);
        let foreign = row(&[
            ("id", "d"),
            ("remote", "@acme/desk/x"),
            ("parent_addr", "laptop/lead"),
        ]);
        assert!(linked_across(&local, &child, Some("laptop")));
        assert!(linked_across(&child, &local, Some("laptop")));
        assert!(!linked_across(&local, &other, Some("laptop")));
        assert!(!linked_across(&local, &child, None));
        assert!(!linked_across(
            &foreign,
            &row(&[("id", "e"), ("remote", "desk/x")]),
            Some("laptop")
        ));
        assert_eq!(key_of(&foreign, Some("laptop")), None);
        assert_eq!(
            key_of(&local, Some("laptop")).as_deref(),
            Some("laptop/lead")
        );
    }
}
