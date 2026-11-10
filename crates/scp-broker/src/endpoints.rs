//! The endpoint table in memory. Temp triggers on the writer connection note the id of every row an insert, update or delete touched;
//! a snapshot drains those ids and re-reads only their rows, so a scope read no longer scans the whole table. A rollback undoes the
//! notes with the writes, so ids drained inside [`crate::store::transaction`] stay due until a snapshot outside one; a snapshot that
//! fails or is cancelled part way reloads the whole table next time. A raw `SAVEPOINT` must run inside that wrapper. Writes to the
//! groups, memberships and admin grants note a NULL id, and those small tables are read again whole.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::store::{Row, SqlValue, Storage, StoreResult};
use crate::world::{Derived, Tables, World};

pub type Rows = Arc<HashMap<String, Arc<Row>>>;

/// A derivation and what it was made from: the row epoch with the other-machine mapping's, and the tables.
type Kept = ((u64, u64), Tables, Arc<Derived>);

const TRACK: &[&str] = &[
    "CREATE TEMP TABLE IF NOT EXISTS endpoints_touched (id TEXT)",
    "CREATE INDEX IF NOT EXISTS temp.endpoints_touched_id ON endpoints_touched (id)",
    "CREATE TEMP TRIGGER IF NOT EXISTS endpoints_touched_insert AFTER INSERT ON main.endpoints BEGIN INSERT INTO endpoints_touched (id) SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM endpoints_touched WHERE id = NEW.id); END",
    "CREATE TEMP TRIGGER IF NOT EXISTS endpoints_touched_update AFTER UPDATE ON main.endpoints BEGIN INSERT INTO endpoints_touched (id) SELECT OLD.id WHERE NOT EXISTS (SELECT 1 FROM endpoints_touched WHERE id = OLD.id); INSERT INTO endpoints_touched (id) SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM endpoints_touched WHERE id = NEW.id); END",
    "CREATE TEMP TRIGGER IF NOT EXISTS endpoints_touched_delete AFTER DELETE ON main.endpoints BEGIN INSERT INTO endpoints_touched (id) SELECT OLD.id WHERE NOT EXISTS (SELECT 1 FROM endpoints_touched WHERE id = OLD.id); END",
];

/// The other tables a scope reads; a write to any of them notes a NULL id.
const SCOPE_TABLES: &[&str] = &["groups", "group_members", "admins"];

const GROUPS: &str = "SELECT * FROM groups";
const MEMBERS: &str = "SELECT name, endpoint FROM group_members ORDER BY name";
const ADMINS: &str = "SELECT * FROM admins WHERE revoked_at IS NULL ORDER BY granted_at";

/// Columns no scope derivation reads: a change to only these keeps the derived scope.
const VOLATILE: &[&str] = &[
    "model",
    "cwd",
    "parent",
    "status_state",
    "status_note",
    "connections",
    "last_seen",
    "last_received_at",
    "last_received_hop",
    "created_at",
    "session",
    "hook_seen",
    "hook_ended",
    "process",
    "stop_blocks",
    "title",
    "reset_at",
    "spawned_at",
    "peek",
    "pushes",
    "prompts",
    "briefed",
    "introduced",
    "directive_holds",
    "harness_session",
    "harness_transcript",
    "auth",
    "incarnation",
    "scope_epoch",
    "mirrored_caps",
    "title_auto",
    "title_turn",
    "tldr_turn",
    "named",
    "linked",
    "wake",
    "wakers",
    "waker_left",
    "mirrored_presence",
    "parent_addr",
    "hibernate",
    "wake_ref",
    "hibernated_at",
    "wake_tried",
    "wake_fails",
    "wake_note",
    "wake_eta",
    "wake_declined",
    "declined_message",
    "declined_from",
    "hold_ref",
    "wake_ticket",
    "waking_until",
    "mail_at",
    "mirrored_active",
    "wake_tickets",
    "revive",
    "harness_origin",
    "link_under",
];

/// The groups, memberships and live admin grants a scope reads.
#[derive(Default, PartialEq)]
pub struct ScopeRows {
    pub groups: Vec<Row>,
    pub members: Vec<Row>,
    pub admins: Vec<Row>,
}

#[derive(Default)]
struct Cache {
    loaded: bool,
    rows: Rows,
    scope: Arc<ScopeRows>,
    epoch: u64,
    /// ids read inside an open transaction: a rollback undoes their writes and their notes alike, so they are read again
    unsure: HashSet<String>,
    /// the scope tables were read inside an open transaction
    scope_unsure: bool,
}

/// The endpoint rows, current as of the last snapshot, and the scope derived from them.
pub struct Endpoints {
    tracked: bool,
    cache: Mutex<Cache>,
    derived: std::sync::Mutex<Option<Kept>>,
}

/// Every endpoint row, and an epoch that moves whenever a row appears, goes, or changes outside the volatile columns.
pub struct Snapshot {
    pub rows: Rows,
    pub scope: Arc<ScopeRows>,
    pub epoch: u64,
}

impl Endpoints {
    /// installs the change triggers; a store that cannot hold them reads the whole table on every snapshot instead
    pub async fn track(store: &dyn Storage) -> Self {
        let mut statements: Vec<String> = TRACK.iter().map(|s| (*s).to_owned()).collect();
        for table in SCOPE_TABLES {
            for event in ["INSERT", "UPDATE", "DELETE"] {
                statements.push(format!("CREATE TEMP TRIGGER IF NOT EXISTS {table}_touched_{} AFTER {event} ON main.{table} BEGIN INSERT INTO endpoints_touched (id) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM endpoints_touched WHERE id IS NULL); END", event.to_lowercase()));
            }
        }
        let mut tracked = true;
        for statement in &statements {
            if store.all(statement, &[]).await.is_err() {
                tracked = false;
                break;
            }
        }
        Self {
            tracked,
            cache: Mutex::new(Cache::default()),
            derived: std::sync::Mutex::new(None),
        }
    }

    /// The world over the rows now; its derivation is reused while no scope input moved. `tables` carries what the store does not hold.
    pub async fn world(&self, store: &dyn Storage, mut tables: Tables) -> StoreResult<World> {
        let Snapshot { rows, scope, epoch } = self.snapshot(store).await?;
        let epoch = (epoch, crate::bridge::others_moved());
        tables.groups.clone_from(&scope.groups);
        tables.members.clone_from(&scope.members);
        tables.admins.clone_from(&scope.admins);
        let world = World::assemble(rows, tables.clone());
        let mut derived = self.derived.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, inputs, kept)) = derived.as_ref()
            && *at == epoch
            && *inputs == tables
        {
            return Ok(world.with_derived(kept.clone()));
        }
        let mut world = world;
        world.derive();
        *derived = Some((epoch, tables, world.derived()));
        Ok(world)
    }

    pub async fn snapshot(&self, store: &dyn Storage) -> StoreResult<Snapshot> {
        let mut cache = self.cache.lock().await;
        let open = crate::store::active(store).is_some();
        if !self.tracked || !cache.loaded {
            if self.tracked {
                store.all("DELETE FROM endpoints_touched", &[]).await?;
            }
            let rows = store.all("SELECT * FROM endpoints", &[]).await?;
            cache.rows = Arc::new(
                rows.into_iter()
                    .filter_map(|row| Some((id_of(&row)?, Arc::new(row))))
                    .collect(),
            );
            cache.scope = Arc::new(scope_rows(store).await?);
            cache.loaded = !open;
            cache.unsure.clear();
            cache.scope_unsure = false;
            cache.epoch += 1;
            return Ok(Snapshot {
                rows: cache.rows.clone(),
                scope: cache.scope.clone(),
                epoch: cache.epoch,
            });
        }
        cache.loaded = false;
        let notes = store
            .all("DELETE FROM endpoints_touched RETURNING id", &[])
            .await?;
        let mut touched: HashSet<String> = notes.iter().filter_map(id_of).collect();
        let scoped = cache.scope_unsure
            || notes
                .iter()
                .any(|note| note.get("id") == Some(&SqlValue::Null));
        touched.extend(cache.unsure.drain());
        if open {
            cache.unsure.clone_from(&touched);
            cache.scope_unsure = scoped;
        } else {
            cache.scope_unsure = false;
        }
        if scoped {
            cache.scope = Arc::new(scope_rows(store).await?);
        }
        if !touched.is_empty() {
            let ids: Vec<String> = touched.into_iter().collect();
            let mut fresh = HashMap::new();
            for chunk in ids.chunks(256) {
                let marks = vec!["?"; chunk.len()].join(",");
                let params: Vec<SqlValue> =
                    chunk.iter().map(|id| SqlValue::Text(id.clone())).collect();
                for row in store
                    .all(
                        &format!("SELECT * FROM endpoints WHERE id IN ({marks})"),
                        &params,
                    )
                    .await?
                {
                    if let Some(id) = id_of(&row) {
                        fresh.insert(id, row);
                    }
                }
            }
            let Cache { rows, epoch, .. } = &mut *cache;
            let rows = Arc::make_mut(rows);
            let mut moved = false;
            for id in ids {
                match fresh.remove(&id) {
                    Some(row) => {
                        moved |= rows.get(&id).is_none_or(|old| !same_scope(old, &row));
                        rows.insert(id, Arc::new(row));
                    }
                    None => moved |= rows.remove(&id).is_some(),
                }
            }
            if moved {
                *epoch += 1;
            }
        }
        cache.loaded = true;
        Ok(Snapshot {
            rows: cache.rows.clone(),
            scope: cache.scope.clone(),
            epoch: cache.epoch,
        })
    }
}

async fn scope_rows(store: &dyn Storage) -> StoreResult<ScopeRows> {
    Ok(ScopeRows {
        groups: store.all(GROUPS, &[]).await?,
        members: store.all(MEMBERS, &[]).await?,
        admins: store.all(ADMINS, &[]).await?,
    })
}

fn id_of(row: &Row) -> Option<String> {
    match row.get("id") {
        Some(SqlValue::Text(id)) => Some(id.clone()),
        _ => None,
    }
}

/// whether two versions of a row agree on every column a scope derivation may read
fn same_scope(a: &Row, b: &Row) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b.iter())
            .all(|((ka, va), (kb, vb))| ka == kb && (va == vb || VOLATILE.contains(&ka.as_str())))
}
