//! Spawns a runner started elsewhere: their via records, and the peek a runner-backed worker answers from its record.

use scp_core::protocol::ErrorCode;
use serde_json::{Map, Value, json};

use crate::authority::Actor;
use crate::core::{Core, integer, now_ms, text};
use crate::proto::RpcError;
use crate::scrub::find_secret;
use crate::state::ConnectionId;
use crate::store::{Row, SqlValue};

/// a runner name: lowercase letters, digits and hyphens, at most 32
pub fn runner_name(value: &str) -> bool {
    crate::hibernate::wake_provider(value)
}

fn printable(value: &str, max: usize, allow_space: bool) -> bool {
    let count = value.chars().count();
    (1..=max).contains(&count)
        && value.chars().all(|c| {
            if allow_space {
                !(c < '\u{20}' || ('\u{7f}'..='\u{9f}').contains(&c))
            } else {
                ('\u{21}'..='\u{7e}').contains(&c)
            }
        })
}

/// a runner's `{address, machine, ref?, attach?}` for worker `name`; a field that looks like a credential is dropped
pub fn runner_reply(value: &Value, name: &str) -> Option<Map<String, Value>> {
    let machine = value.get("machine")?.as_str()?;
    let address = value.get("address")?.as_str()?;
    let rest = address.strip_prefix("me/")?;
    let (at, worker) = rest.split_once('/')?;
    if at != machine || !runner_name(at) || worker != name || worker.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert("address".into(), json!(address));
    out.insert("machine".into(), json!(machine));
    for (key, max, space) in [("ref", 256, false), ("attach", 1024, true)] {
        match value.get(key) {
            None => {}
            Some(Value::String(v)) if printable(v, max, space) => {
                if find_secret(v).is_none() {
                    out.insert(key.into(), json!(v));
                }
            }
            Some(_) => return None,
        }
    }
    Some(out)
}

impl Core {
    /// `spawn_via`: the spawning agent records the runner that started its worker `name`
    pub async fn spawn_via(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let me = self.actor_row(conn).await?;
        if text(&me, "kind") != Some("agent") {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "only the spawning agent records a runner",
            ));
        }
        let name = params.get("name").and_then(Value::as_str);
        let runner = params.get("runner").and_then(Value::as_str);
        let (Some(name), Some(runner)) = (
            name.filter(|n| crate::claims::valid_handle(n)),
            runner.filter(|r| runner_name(r)),
        ) else {
            return Err(RpcError::invalid_params(
                "a via record needs a worker name and runner name",
            ));
        };
        let has_address = params.contains_key("address") || params.contains_key("machine");
        let mut probe = Value::Object(params.clone());
        if !has_address {
            probe["address"] = json!(format!("me/unknown/{name}"));
            probe["machine"] = json!("unknown");
        }
        let reply = runner_reply(&probe, name)
            .ok_or_else(|| RpcError::invalid_params("invalid runner reply"))?;
        let id = text(&me, "id").unwrap_or("");
        let previous = self
            .store
            .all(
                "SELECT created_at FROM spawn_via WHERE spawner = ? AND name = ?",
                &[SqlValue::Text(id.into()), SqlValue::Text(name.into())],
            )
            .await?
            .first()
            .and_then(|r| integer(r, "created_at"))
            .unwrap_or(0);
        let field = |key: &str, keep: bool| {
            reply
                .get(key)
                .and_then(Value::as_str)
                .filter(|_| keep)
                .map_or(SqlValue::Null, |v| SqlValue::Text(v.into()))
        };
        self.store.all("INSERT OR REPLACE INTO spawn_via (spawner, name, runner, address, machine, ref, attach, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)", &[
            SqlValue::Text(id.into()), SqlValue::Text(name.into()), SqlValue::Text(runner.into()),
            field("address", has_address), field("machine", has_address), field("ref", true), field("attach", true),
            SqlValue::Int(now_ms().max(previous + 1)),
        ]).await?;
        Ok(json!({"recorded": true}))
    }

    /// the via record of a worker its runner started on another machine, under the record's spawner; a worker of this machine has none
    async fn via_for(&self, row: &Row) -> Result<Option<Row>, RpcError> {
        if self.local_row(row) {
            return Ok(None);
        }
        let Some(parent) = text(row, "parent_addr") else {
            return Ok(None);
        };
        let spawner = self.lookup(parent).await.ok();
        let spawner = spawner.as_ref().and_then(|s| text(s, "id"));
        Ok(self
            .store
            .all(
                "SELECT * FROM spawn_via WHERE address = ? ORDER BY created_at DESC",
                &[SqlValue::Text(crate::views::address(row))],
            )
            .await?
            .into_iter()
            .find(|record| text(record, "spawner") == spawner))
    }

    /// whether a row is this machine's own: the local broker holds no other machine's rows
    pub(crate) fn local_row(&self, row: &Row) -> bool {
        Self::is_local_row(row)
    }

    /// the peek a runner-backed worker answers from its status, or None when `peek` reads the endpoint's own turns
    pub async fn via_peek_answer(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Option<Value>, RpcError> {
        let Some(endpoint) = params.get("endpoint").and_then(Value::as_str) else {
            return Ok(None);
        };
        let Ok(row) = self.lookup(endpoint).await else {
            return Ok(None);
        };
        let Some(record) = self.via_for(&row).await? else {
            return Ok(None);
        };
        let actor = self.actor_of(conn)?;
        let me = self.actor_row(conn).await?;
        if !actor.at_terminal()
            && !matches!(actor, Actor::Human { .. })
            && !self.world().await?.discovers(
                text(&me, "id").unwrap_or(""),
                text(&row, "id").unwrap_or(""),
            )
        {
            return Err(crate::messages::unreachable(endpoint));
        }
        let view = self.view(&row).await?;
        let mut runner = json!({"name": text(&record, "runner")});
        for key in ["ref", "attach"] {
            if let Some(value) = text(&record, key) {
                runner[key] = json!(value);
            }
        }
        Ok(Some(json!({
            "endpoint": view["address"], "at": crate::core::timestamp(now_ms()), "level": null, "source": "status",
            "turns": [], "recent_tools": [], "status": view["status"], "title": view["title"], "unread": 0,
            "truncated": false, "runner": runner,
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_replies_name_the_worker_on_its_machine() {
        let ok = json!({"address": "me/box/w", "machine": "box", "ref": "r-1", "attach": "tmux attach -t w"});
        let reply = runner_reply(&ok, "w").unwrap();
        assert_eq!(reply["ref"], "r-1");
        assert_eq!(reply["attach"], "tmux attach -t w");
        assert!(runner_reply(&json!({"address": "me/box/w", "machine": "other"}), "w").is_none());
        assert!(runner_reply(&json!({"address": "me/box/x", "machine": "box"}), "w").is_none());
        assert!(
            runner_reply(
                &json!({"address": "me/box/w", "machine": "box", "ref": "a b"}),
                "w"
            )
            .is_none()
        );
        let secret =
            json!({"address": "me/box/w", "machine": "box", "ref": "AKIAABCDEFGHIJKLMNOP"});
        assert!(!runner_reply(&secret, "w").unwrap().contains_key("ref"));
    }
}
