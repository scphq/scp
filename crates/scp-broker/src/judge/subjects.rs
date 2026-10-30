use std::collections::HashMap;

use scp_core::scope::{PolicySubject, ScopeSubject, matches};

use crate::core::{Core, text};
use crate::proto::RpcError;
use crate::store::Row;
use crate::views::address;

impl Core {
    pub(crate) async fn judge_subject(&self, row: &Row) -> Result<PolicySubject, RpcError> {
        let id = text(row, "id").unwrap_or("");
        let ancestors = self.ancestors(row).await?;
        let root = self.by_id(text(row, "tree").unwrap_or(id)).await?;
        let mut groups = Vec::new();
        for group in self
            .store
            .all(
                "SELECT name FROM group_members WHERE endpoint = ?",
                &[super::string(id)],
            )
            .await?
        {
            if let Some(name) = text(&group, "name") {
                groups.push(name.to_owned());
            }
        }
        Ok(PolicySubject {
            handle: text(row, "handle").unwrap_or("").into(),
            harness: text(row, "harness").map(str::to_owned),
            kind: text(row, "kind").unwrap_or("").into(),
            labels: text(row, "labels")
                .and_then(|s| serde_json::from_str::<HashMap<String, String>>(s).ok())
                .unwrap_or_default(),
            scope: Some(ScopeSubject {
                id: id.into(),
                tree: text(row, "tree").unwrap_or(id).into(),
                ancestors,
                groups,
                root_handle: root
                    .as_ref()
                    .and_then(|r| text(r, "handle"))
                    .unwrap_or("")
                    .into(),
                machine: None,
                local: true,
                root: None,
            }),
            account: None,
        })
    }

    pub(crate) async fn judge_boundaries(
        &self,
        policy: &serde_json::Value,
        from: &Row,
        targets: &[String],
    ) -> Result<Vec<(String, Vec<String>)>, RpcError> {
        let sender = self.judge_subject(from).await?;
        let mut groups: Vec<(String, Vec<String>)> = Vec::new();
        for target in targets {
            let row = self.must_endpoint(target).await?;
            let recipient = self.judge_subject(&row).await?;
            for boundary in policy["boundaries"].as_array().into_iter().flatten() {
                let from = boundary["from"].as_str().unwrap_or("*");
                let to = boundary["to"].as_str().unwrap_or("*");
                if !matches(from, &sender, Some(&recipient), None)
                    || !matches(to, &recipient, Some(&sender), None)
                {
                    continue;
                }
                let across = boundary["across"] == "tree";
                if across
                    && sender
                        .scope
                        .as_ref()
                        .zip(recipient.scope.as_ref())
                        .is_none_or(|(a, b)| a.tree == b.tree)
                {
                    continue;
                }
                let label = format!(
                    "{from} to {to}{}",
                    if across { " (across trees)" } else { "" }
                );
                if let Some((_, to)) = groups.iter_mut().find(|(key, _)| key == &label) {
                    to.push(address(&row));
                } else {
                    groups.push((label, vec![address(&row)]));
                }
                break;
            }
        }
        Ok(groups)
    }
}
