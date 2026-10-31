//! Periodic cleanup: expired mail, dead hooks, offline statuses, endpoint
//! retention, audit retention and idle groups.

use std::collections::{HashMap, HashSet};

use scp_core::protocol::LIMITS;

use crate::core::{Core, now_ms, text};
use crate::proto::RpcError;
use crate::store::SqlValue;
use crate::views::presence;

const GONE_PREFIX: &str = "_gone_";
const BROKER_WAKE_SQL: &str = "COALESCE(wake IN ('codex-queue'), 0)";

fn s(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

fn seconds(core: &Core, key: &str, fallback: u64) -> i64 {
    core.limits.get(key).unwrap_or(fallback) as i64
}

fn pid_of(process: &str) -> Option<u32> {
    let rest = process.strip_prefix("pid:")?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok().filter(|pid| *pid != 0)
}

/// the offline age after which a child or retired row is deleted; `None` keeps every row
fn retire_after_s(limits: &crate::proto::Limits) -> Option<i64> {
    match limits.0.get("endpointRetireS") {
        Some(None) => None,
        Some(Some(value)) => Some(*value as i64),
        None => Some(LIMITS.endpoint_retire_s as i64),
    }
}

/// the most rows one sweep retires; `usize::MAX` is no cap, 0 disables retiring
fn retire_max(limits: &crate::proto::Limits) -> usize {
    match limits.0.get("endpointRetireMax") {
        Some(None) => usize::MAX,
        Some(Some(value)) => *value as usize,
        None => LIMITS.endpoint_retire_max as usize,
    }
}

impl Core {
    pub async fn sweep(&mut self) -> Result<(), RpcError> {
        let now = now_ms();
        let purge_ms = seconds(self, "purgeAfterS", LIMITS.purge_after_s) * 1000;
        self.store
            .all(
                "DELETE FROM deliveries WHERE expires_at <= ? OR (acked_at IS NOT NULL AND acked_at <= ?)",
                &[SqlValue::Int(now), SqlValue::Int(now - purge_ms)],
            )
            .await?;
        self.store
            .all(
                "DELETE FROM deliveries WHERE substr(endpoint, 1, 6) = 'spawn:' AND substr(endpoint, 7) NOT IN (SELECT token_hash FROM grants WHERE used_by IS NULL AND revoked_at IS NULL AND expires_at > ?)",
                &[SqlValue::Int(now)],
            )
            .await?;
        self.store
            .all(
                "DELETE FROM messages WHERE expires_at <= ? AND id NOT IN (SELECT message_id FROM deliveries)",
                &[SqlValue::Int(now - purge_ms)],
            )
            .await?;
        self.store
            .all(
                "DELETE FROM idempotency WHERE created_at <= ?",
                &[SqlValue::Int(
                    now - seconds(self, "idempotencyS", LIMITS.idempotency_s) * 1000,
                )],
            )
            .await?;
        self.store
            .all(
                "DELETE FROM pair_events WHERE at <= ?",
                &[SqlValue::Int(now - 3_600_000)],
            )
            .await?;
        self.store
            .all("DELETE FROM blocks WHERE until <= ?", &[SqlValue::Int(now)])
            .await?;
        self.end_exited_at(now).await?;
        self.settle_offline_at(now).await?;
        self.settle_revived(now, None).await?;
        self.retire_endpoints(now).await?;
        self.prune_handle_bound(now).await?;
        crate::store::schema::prune_audit(
            self.store.as_ref(),
            now,
            self.limits.get("auditKeepS").map(|value| value as i64),
        )
        .await?;
        self.store
            .all(
                "DELETE FROM grants WHERE expires_at <= ? AND (used_by IS NULL OR used_by NOT IN (SELECT id FROM endpoints))",
                &[SqlValue::Int(now)],
            )
            .await?;
        self.store
            .all(
                "DELETE FROM tree_events WHERE at <= ?",
                &[SqlValue::Int(now - 3_600_000)],
            )
            .await?;
        self.store
            .all(
                "DELETE FROM group_members WHERE endpoint NOT IN (SELECT id FROM endpoints)",
                &[],
            )
            .await?;
        self.store
            .all(
                "DELETE FROM peek_turns WHERE endpoint NOT IN (SELECT id FROM endpoints WHERE peek IS NOT NULL AND substr(handle, 1, 6) != '_gone_')",
                &[],
            )
            .await?;
        self.drop_idle_groups(now).await
    }

    /// ends hook presence whose harness process exited, and lapses wakes no waker holds
    async fn end_exited_at(&mut self, now: i64) -> Result<(), RpcError> {
        let rows = self
            .store
            .all(
                "SELECT id, process FROM endpoints WHERE kind = 'agent' AND connections = 0 AND hook_seen IS NOT NULL AND process IS NOT NULL",
                &[],
            )
            .await?;
        let mut alive: HashMap<u32, bool> = HashMap::new();
        for row in rows {
            let (Some(id), Some(process)) = (text(&row, "id"), text(&row, "process")) else {
                continue;
            };
            let Some(pid) = pid_of(process) else { continue };
            let running = match alive.get(&pid) {
                Some(running) => *running,
                None => {
                    let running = self.procs.alive(&format!("pid:{pid}")).await;
                    alive.insert(pid, running);
                    running
                }
            };
            if running || self.by_id(id).await?.is_none() {
                continue;
            }
            self.store
                .all(
                    &format!(
                        "UPDATE endpoints SET hook_seen = NULL, hook_ended = ?, session = NULL, wake = CASE WHEN wakers = 0 AND NOT {BROKER_WAKE_SQL} THEN NULL ELSE wake END WHERE id = ? AND connections = 0"
                    ),
                    &[SqlValue::Int(now), s(id)],
                )
                .await?;
        }
        let grace = seconds(self, "restartGraceS", LIMITS.restart_grace_s) * 1000;
        let lapsed = self
            .store
            .all(
                "SELECT id FROM endpoints WHERE wake IS NOT NULL AND wakers = 0 AND waker_left < ?",
                &[SqlValue::Int(now - grace)],
            )
            .await?;
        for row in lapsed {
            if let Some(id) = text(&row, "id") {
                let id = id.to_owned();
                self.lapse_wake(&id, now).await?;
            }
        }
        Ok(())
    }

    /// an offline agent drops a working or waiting status nobody keeps current
    async fn settle_offline_at(&self, now: i64) -> Result<(), RpcError> {
        let rows = self
            .store
            .all(
                "SELECT * FROM endpoints WHERE kind = 'agent' AND connections = 0 AND status_state IN ('working', 'waiting')",
                &[],
            )
            .await?;
        for row in rows {
            if presence(&row, now) == "offline" {
                self.store
                    .all(
                        "UPDATE endpoints SET status_state = NULL, status_note = NULL WHERE id = ?",
                        &[SqlValue::Text(
                            text(&row, "id").unwrap_or_default().to_owned(),
                        )],
                    )
                    .await?;
            }
        }
        Ok(())
    }

    /// deletes child and retired rows offline past the retention age that nothing references
    async fn retire_endpoints(&mut self, now: i64) -> Result<usize, RpcError> {
        let Some(after_s) = retire_after_s(&self.limits) else {
            return Ok(0);
        };
        let max = retire_max(&self.limits);
        if max == 0 {
            return Ok(0);
        }
        let cutoff = now - after_s * 1000;
        let held = if self
            .store
            .all(
                "SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'judge_holds'",
                &[],
            )
            .await?
            .is_empty()
        {
            ""
        } else {
            "AND id NOT IN (SELECT from_ep FROM judge_holds WHERE state IN ('held', 'releasing'))"
        };
        let query = format!(
            "SELECT * FROM endpoints WHERE kind = 'agent' AND connections = 0
             AND ((parent_ep IS NOT NULL AND named IS NULL AND linked IS NULL) OR substr(handle, 1, 6) = '_gone_')
             AND COALESCE(last_seen, created_at) <= ? AND COALESCE(hook_seen, 0) <= ? AND COALESCE(hook_ended, 0) <= ?
             AND hibernate IS NULL AND wake IS NULL AND wakers = 0 AND wake_ticket IS NULL AND hold_ref IS NULL
             AND id NOT IN (SELECT parent_ep FROM endpoints WHERE parent_ep IS NOT NULL)
             AND id NOT IN (SELECT spawner FROM spawn_via)
             AND id NOT IN (SELECT tree FROM endpoints WHERE tree IS NOT NULL AND tree != id)
             AND id NOT IN (SELECT endpoint FROM deliveries WHERE acked_at IS NULL AND expires_at > ?)
             AND id NOT IN (SELECT from_ep FROM messages WHERE expires_at > ?)
             AND id NOT IN (SELECT d.endpoint FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.expires_at > ? AND (m.kind = 'request' OR m.require_reply = 1))
             {held}
             AND id NOT IN (SELECT owner FROM groups) AND id NOT IN (SELECT tree FROM groups WHERE tree IS NOT NULL)
             AND id NOT IN (SELECT subject FROM admins)
             AND id NOT IN (SELECT issuer FROM grants WHERE revoked_at IS NULL AND expires_at > ?)
             AND id NOT IN (SELECT under FROM grants WHERE revoked_at IS NULL AND expires_at > ?)
             AND id NOT IN (SELECT used_by FROM grants WHERE used_by IS NOT NULL AND revoked_at IS NULL AND expires_at > ?)
             ORDER BY COALESCE(last_seen, created_at), id"
        );
        let params: Vec<SqlValue> = [cutoff, cutoff, cutoff, now, now, now, now, now, now]
            .into_iter()
            .map(SqlValue::Int)
            .collect();
        let mut retired = 0_usize;
        for _pass in 0..8 {
            if retired >= max {
                break;
            }
            let rows = self.store.all(&query, &params).await?;
            let mut ids: Vec<String> = Vec::new();
            for row in rows {
                if ids.len() >= max - retired {
                    break;
                }
                let Some(id) = text(&row, "id") else { continue };
                if text(&row, "hibernate").is_some() {
                    continue;
                }
                let running = match text(&row, "process") {
                    None => false,
                    Some(key) => self.procs.alive(key).await,
                };
                if !running {
                    ids.push(id.to_owned());
                }
            }
            if ids.is_empty() {
                break;
            }
            let store = self.store.clone();
            let chunked = ids.clone();
            crate::store::transaction(store.clone(), async move {
                for chunk in chunked.chunks(50) {
                    let marks = vec!["?"; chunk.len()].join(", ");
                    let values: Vec<SqlValue> = chunk.iter().map(|id| s(id)).collect();
                    for (table, column) in [
                        ("deliveries", "endpoint"),
                        ("group_members", "endpoint"),
                        ("peek_turns", "endpoint"),
                        ("activity", "endpoint"),
                        ("idempotency", "from_ep"),
                        ("endpoints", "id"),
                    ] {
                        store
                            .all(
                                &format!("DELETE FROM {table} WHERE {column} IN ({marks})"),
                                &values,
                            )
                            .await?;
                    }
                }
                Ok::<_, RpcError>(())
            })
            .await?;
            retired += ids.len();
            self.forget(&ids);
        }
        Ok(retired)
    }

    /// deletes agent rows unreferenced for the handle bound; their mail and children keep them
    async fn prune_handle_bound(&mut self, now: i64) -> Result<(), RpcError> {
        let bound_ms = seconds(self, "handleBoundS", LIMITS.handle_bound_s) * 1000;
        let rows = self
            .store
            .all(
                "SELECT id FROM endpoints WHERE kind = 'agent' AND connections = 0 AND COALESCE(last_seen, created_at) <= ? AND (hibernate IS NULL OR revive IS NULL) AND id NOT IN (SELECT endpoint FROM deliveries) AND id NOT IN (SELECT from_ep FROM messages) AND id NOT IN (SELECT parent_ep FROM endpoints WHERE parent_ep IS NOT NULL) AND id NOT IN (SELECT spawner FROM spawn_via)",
                &[SqlValue::Int(now - bound_ms)],
            )
            .await?;
        let ids: Vec<String> = rows
            .iter()
            .filter_map(|row| text(row, "id").map(str::to_owned))
            .collect();
        for chunk in ids.chunks(50) {
            let marks = vec!["?"; chunk.len()].join(", ");
            let values: Vec<SqlValue> = chunk.iter().map(|id| s(id)).collect();
            self.store
                .all(
                    &format!("DELETE FROM endpoints WHERE id IN ({marks})"),
                    &values,
                )
                .await?;
        }
        self.forget(&ids);
        Ok(())
    }

    /// drops unpinned groups whose tree root is gone or idle past the group idle age
    async fn drop_idle_groups(&mut self, now: i64) -> Result<(), RpcError> {
        let idle_ms = seconds(self, "groupIdleS", LIMITS.group_idle_s) * 1000;
        let groups = self
            .store
            .all(
                "SELECT * FROM groups WHERE pinned = 0 AND tree IS NOT NULL",
                &[],
            )
            .await?;
        for group in groups {
            let (Some(name), Some(tree)) = (text(&group, "name"), text(&group, "tree")) else {
                continue;
            };
            let (name, tree) = (name.to_owned(), tree.to_owned());
            let root = self.by_id(&tree).await?;
            let gone = root
                .as_ref()
                .is_none_or(|row| text(row, "handle").unwrap_or("").starts_with(GONE_PREFIX));
            let seen = !self
                .store
                .all(
                    "SELECT 1 AS n FROM endpoints WHERE (id = ? OR tree = ?) AND (connections > 0 OR MAX(COALESCE(last_seen, created_at), COALESCE(hook_seen, 0)) > ?) LIMIT 1",
                    &[s(&tree), s(&tree), SqlValue::Int(now - idle_ms)],
                )
                .await?
                .is_empty();
            if gone || !seen {
                self.drop_group(&name).await?;
            }
        }
        Ok(())
    }

    fn forget(&mut self, ids: &[String]) {
        let gone: HashSet<&str> = ids.iter().map(String::as_str).collect();
        self.state
            .addresses
            .retain(|id, _| !gone.contains(id.as_str()));
        self.state.known.retain(|id, _| !gone.contains(id.as_str()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::integer;
    use crate::proto::Limits;

    #[test]
    fn retire_age_none_keeps_every_row_and_max_none_is_no_cap() {
        let mut limits = Limits::default();
        assert_eq!(retire_after_s(&limits), Some(86_400));
        limits.0.insert("endpointRetireS".into(), None);
        assert_eq!(retire_after_s(&limits), None);
        let mut limits = Limits::default();
        limits.0.insert("endpointRetireMax".into(), None);
        assert_eq!(retire_max(&limits), usize::MAX);
        let mut limits = Limits::default();
        limits.0.insert("endpointRetireMax".into(), Some(0));
        assert_eq!(retire_max(&limits), 0);
    }

    #[test]
    fn pid_parsing_skips_bare_and_zero() {
        assert_eq!(pid_of("pid:42:Mon-Jan-1-00:00:00-2026"), Some(42));
        assert_eq!(pid_of("pid:42"), Some(42));
        assert_eq!(pid_of("pid:0:x"), None);
        assert_eq!(pid_of("sub:1"), None);
        assert_eq!(pid_of("pid:"), None);
    }

    #[test]
    fn integer_rows_read_back() {
        let mut row = crate::store::Row::new();
        row.insert("n".into(), SqlValue::Int(7));
        assert_eq!(integer(&row, "n"), Some(7));
    }
}
