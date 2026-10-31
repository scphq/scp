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

    /// whether `row` is a worker of another machine whose linked parent is `record`'s spawner
    async fn via_owned(&self, row: &Row, record: &Row) -> Result<bool, RpcError> {
        if self.local_row(row) {
            return Ok(false);
        }
        let Some(parent) = text(row, "parent_addr") else {
            return Ok(false);
        };
        let spawner = self.by_key(parent).await?;
        Ok(spawner
            .as_ref()
            .and_then(|s| text(s, "id"))
            .is_some_and(|id| text(record, "spawner") == Some(id)))
    }

    /// the via record of a worker its runner started on another machine, under the record's spawner; a worker of this machine has none
    pub(crate) async fn via_for(&self, row: &Row) -> Result<Option<Row>, RpcError> {
        if self.local_row(row) {
            return Ok(None);
        }
        for record in self
            .store
            .all(
                "SELECT * FROM spawn_via WHERE address = ? ORDER BY created_at DESC",
                &[SqlValue::Text(crate::views::address(row))],
            )
            .await?
        {
            if self.via_owned(row, &record).await? {
                return Ok(Some(record));
            }
        }
        Ok(None)
    }

    /// the spawner, its ancestor or the human at a terminal may end a via worker
    async fn via_authority(&self, tty: bool, me: &Row, record: &Row) -> Result<bool, RpcError> {
        let me = text(me, "id").unwrap_or("");
        let spawner = text(record, "spawner").unwrap_or("");
        if tty || me == spawner {
            return Ok(true);
        }
        Ok(match self.by_id(spawner).await? {
            Some(row) => self.ancestors(&row).await?.iter().any(|a| a == me),
            None => false,
        })
    }

    /// the via workers `record` names: the resolved `target`, or the agents under its spawner whose address ends in its name
    async fn via_workers(
        &self,
        me: &Row,
        record: &Row,
        target: Option<&Row>,
    ) -> Result<Vec<Row>, RpcError> {
        if let Some(address) = text(record, "address") {
            return Ok(self.lookup(address).await.ok().into_iter().collect());
        }
        if let Some(target) = target {
            return Ok(vec![target.clone()]);
        }
        let world = self.world().await?;
        let me = text(me, "id").unwrap_or("");
        let mut workers = Vec::new();
        for row in self
            .store
            .all("SELECT * FROM endpoints WHERE kind = 'agent'", &[])
            .await?
        {
            let address = crate::views::address(&row);
            if self.via_owned(&row, record).await?
                && world.discovers(me, text(&row, "id").unwrap_or(""))
                && address.starts_with("me/")
                && address.rsplit('/').next() == text(record, "name")
            {
                workers.push(row);
            }
        }
        Ok(workers)
    }

    /// `spawn_end` of a worker a runner started elsewhere: its via record ends and the worker's view, if it is known, comes back; None when no via record names it
    pub async fn end_via(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Option<(Row, Option<Value>)>, RpcError> {
        let me = self.actor_row(conn).await?;
        let tty = self.at_terminal(conn);
        let Some(endpoint) = params.get("endpoint").and_then(Value::as_str) else {
            return Err(RpcError::invalid_params(
                "endpoint is an address or worker name",
            ));
        };
        let target = self.lookup(endpoint).await.ok();
        if target.as_ref().is_some_and(|t| self.local_row(t)) {
            return Ok(None);
        }
        let target_address = target.as_ref().map(crate::views::address);
        let matches: Vec<Row> = self
            .store
            .all("SELECT * FROM spawn_via ORDER BY created_at DESC", &[])
            .await?
            .into_iter()
            .filter(|r| {
                let address = text(r, "address");
                let name = text(r, "name").unwrap_or("");
                address == Some(endpoint)
                    || (address.is_some() && address == target_address.as_deref())
                    || name == endpoint
                    || format!("me/{name}") == endpoint
            })
            .collect();
        if matches.is_empty() {
            return Ok(None);
        }
        let me_id = text(&me, "id").unwrap_or("").to_owned();
        let agent = text(&me, "kind") == Some("agent");
        let mut allowed = Vec::new();
        for record in &matches {
            if self.via_authority(tty, &me, record).await? {
                allowed.push(record.clone());
            }
        }
        if allowed.is_empty() {
            let world = self.world().await?;
            let mut visible = false;
            for record in &matches {
                let worker = match text(record, "address") {
                    Some(address) => self.lookup(address).await.ok(),
                    None => target.clone(),
                };
                if worker.is_some_and(|w| world.discovers(&me_id, text(&w, "id").unwrap_or(""))) {
                    visible = true;
                    break;
                }
            }
            if agent && !visible {
                return Err(crate::messages::unreachable(endpoint));
            }
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "only the spawner, its ancestor or the human at a terminal ends a via worker",
            ));
        }
        let mut tied = Vec::new();
        for record in &allowed {
            for worker in self.via_workers(&me, record, target.as_ref()).await? {
                if self.via_owned(&worker, record).await? {
                    tied.push(record.clone());
                    break;
                }
            }
        }
        let remaining = if tied.is_empty() { allowed } else { tied };
        let [record] = remaining.as_slice() else {
            return Err(RpcError::invalid_params(
                "ambiguous via worker: name its full address",
            ));
        };
        let candidates = self.via_workers(&me, record, target.as_ref()).await?;
        if candidates.len() > 1 {
            return Err(RpcError::invalid_params(
                "ambiguous via worker: record its full address",
            ));
        }
        let name = text(record, "name").unwrap_or("");
        let mut worker = candidates.into_iter().next();
        if worker.is_none() && text(record, "address").is_none() && target.is_none() {
            for row in self
                .store
                .all("SELECT * FROM endpoints WHERE kind = 'agent'", &[])
                .await?
            {
                let address = crate::views::address(&row);
                if !self.local_row(&row)
                    && address.starts_with("me/")
                    && address.rsplit('/').next() == Some(name)
                    && !self.via_owned(&row, record).await?
                {
                    worker = Some(row);
                    break;
                }
            }
        }
        if let Some(worker) = &worker
            && !self.via_owned(worker, record).await?
        {
            if agent
                && !self
                    .world()
                    .await?
                    .discovers(&me_id, text(worker, "id").unwrap_or(""))
            {
                return Err(crate::messages::unreachable(endpoint));
            }
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "the worker is not under this runner's spawner",
            ));
        }
        let spawner = text(record, "spawner").unwrap_or("").to_owned();
        let audited = worker
            .as_ref()
            .and_then(|w| text(w, "id"))
            .unwrap_or(&spawner)
            .to_owned();
        let detail = json!({
            "by": crate::views::address(&me),
            "target": text(record, "address").unwrap_or(name),
            "held": false,
            "runner": text(record, "runner"),
        });
        let view = crate::store::transaction(self.store.clone(), async {
            self.store
                .all(
                    "UPDATE spawn_via SET ended_at = COALESCE(ended_at, ?) WHERE spawner = ? AND name = ?",
                    &[SqlValue::Int(now_ms()), SqlValue::Text(spawner.clone()), SqlValue::Text(name.into())],
                )
                .await?;
            self.audit("spawn_end", Some(&audited), None, detail).await?;
            match &worker {
                Some(worker) => Ok::<_, RpcError>(Some(self.view(worker).await?)),
                None => Ok(None),
            }
        })
        .await?;
        Ok(Some((record.clone(), view)))
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
        if let Some(id) = text(&row, "id") {
            self.runner_job = self
                .enrich_job(vec![("/runner".into(), id.to_owned())])
                .await?;
        }
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
