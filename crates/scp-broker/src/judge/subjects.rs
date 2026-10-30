use scp_core::scope::matches;

use crate::core::{Core, text};
use crate::proto::RpcError;
use crate::store::Row;
use crate::views::address;
use crate::world::World;

impl Core {
    pub(crate) async fn judge_boundaries(
        &self,
        policy: &serde_json::Value,
        from: &Row,
        targets: &[String],
    ) -> Result<Vec<(String, Vec<String>)>, RpcError> {
        let world = self.world().await?;
        let subject = |row: &Row| {
            world
                .subject(text(row, "id").unwrap_or_default())
                .cloned()
                .unwrap_or_else(|| World::plain_subject(row))
        };
        let sender = subject(from);
        let mut groups: Vec<(String, Vec<String>)> = Vec::new();
        for target in targets {
            let row = self.must_endpoint(target).await?;
            let recipient = subject(&row);
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
