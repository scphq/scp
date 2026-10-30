use std::collections::HashSet;

use rand::RngCore;
use serde_json::{Value, json};

use super::{Row, SqlValue, Storage, StoreError, StoreResult};

const AUDIT_NO_DELETE: &str = r#"CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
    WHEN OLD.at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000 AND NOT (OLD.event IN ('scope_refused') AND OLD.at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 86400000)
    BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END"#;

const MIGRATION: &[&str] = &[
    r#"CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    harness TEXT,
    model TEXT,
    cwd TEXT,
    parent TEXT,
    labels TEXT NOT NULL DEFAULT '{}',
    status_state TEXT,
    status_note TEXT,
    token_hash TEXT,
    connections INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER,
    last_received_at INTEGER,
    last_received_hop INTEGER,
    created_at INTEGER NOT NULL,
    session TEXT,
    hook_seen INTEGER,
    hook_ended INTEGER,
    process TEXT,
    stop_blocks INTEGER
  )"#,
    r#"CREATE UNIQUE INDEX IF NOT EXISTS endpoints_token ON endpoints (token_hash)"#,
    r#"CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread TEXT NOT NULL,
    reply_to TEXT,
    kind TEXT NOT NULL,
    from_ep TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    body TEXT NOT NULL,
    mime TEXT NOT NULL,
    data_class TEXT NOT NULL,
    attachments TEXT NOT NULL,
    hop INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    sender_tty INTEGER,
    require_reply INTEGER
  )"#,
    r#"CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread)"#,
    r#"CREATE INDEX IF NOT EXISTS messages_reply_to ON messages (reply_to)"#,
    r#"CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at)"#,
    r#"CREATE TABLE IF NOT EXISTS deliveries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    acked_at INTEGER,
    expires_at INTEGER NOT NULL,
    offered_until INTEGER,
    offered_hold TEXT,
    injected_at INTEGER,
    nudged_at INTEGER,
    deferred_at INTEGER,
    deferred_ack INTEGER
  )"#,
    r#"CREATE INDEX IF NOT EXISTS deliveries_inbox ON deliveries (endpoint, acked_at, seq)"#,
    r#"CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries (message_id)"#,
    r#"CREATE INDEX IF NOT EXISTS deliveries_expires ON deliveries (expires_at)"#,
    r#"CREATE TABLE IF NOT EXISTS idempotency (
    from_ep TEXT NOT NULL,
    client_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_ep, client_id)
  )"#,
    r#"CREATE TABLE IF NOT EXISTS pair_events (from_ep TEXT NOT NULL, to_ep TEXT NOT NULL, at INTEGER NOT NULL)"#,
    r#"CREATE TABLE IF NOT EXISTS judge_holds (id TEXT PRIMARY KEY, from_ep TEXT NOT NULL, params TEXT NOT NULL, origin TEXT NOT NULL, verdict TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, by TEXT, resolved_at INTEGER)"#,
    r#"CREATE TABLE IF NOT EXISTS judge_sent (from_ep TEXT NOT NULL, client_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (from_ep, client_id))"#,
    r#"CREATE INDEX IF NOT EXISTS pair_events_pair ON pair_events (from_ep, to_ep, at)"#,
    r#"CREATE TABLE IF NOT EXISTS blocks (pair TEXT PRIMARY KEY, until INTEGER NOT NULL)"#,
    r#"CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    event TEXT NOT NULL,
    endpoint TEXT,
    ref TEXT,
    detail TEXT NOT NULL DEFAULT '{}'
  )"#,
    r#"CREATE INDEX IF NOT EXISTS audit_at ON audit (at)"#,
    r#"CREATE TABLE IF NOT EXISTS grants (
    token_hash TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    under TEXT NOT NULL,
    name TEXT,
    labels TEXT,
    caps TEXT,
    groups TEXT,
    used_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    spent_cwd TEXT,
    title TEXT,
    bound_process TEXT
  )"#,
    r#"CREATE TABLE IF NOT EXISTS groups (name TEXT PRIMARY KEY, owner TEXT NOT NULL, tree TEXT, rules TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, id TEXT)"#,
    r#"CREATE TABLE IF NOT EXISTS group_members (name TEXT NOT NULL, endpoint TEXT NOT NULL, added_by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (name, endpoint))"#,
    r#"CREATE TABLE IF NOT EXISTS policy_binds (policy TEXT NOT NULL, name TEXT NOT NULL, grp TEXT NOT NULL, PRIMARY KEY (policy, name))"#,
    r#"CREATE TABLE IF NOT EXISTS policy_loads (policy TEXT PRIMARY KEY, at INTEGER NOT NULL)"#,
    r#"CREATE INDEX IF NOT EXISTS group_members_endpoint ON group_members (endpoint)"#,
    r#"CREATE TABLE IF NOT EXISTS admins (subject TEXT NOT NULL, scope_kind TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT, granted_at INTEGER NOT NULL, revoked_at INTEGER)"#,
    r#"CREATE TABLE IF NOT EXISTS tree_events (tree TEXT NOT NULL, at INTEGER NOT NULL)"#,
    r#"CREATE INDEX IF NOT EXISTS tree_events_tree ON tree_events (tree, at)"#,
    r#"CREATE TABLE IF NOT EXISTS spawn_via (
    spawner TEXT NOT NULL, name TEXT NOT NULL, runner TEXT NOT NULL, address TEXT, machine TEXT, ref TEXT, attach TEXT,
    created_at INTEGER NOT NULL, ended_at INTEGER, PRIMARY KEY (spawner, name)
  )"#,
    r#"CREATE INDEX IF NOT EXISTS spawn_via_address ON spawn_via(address)"#,
    r#"CREATE TABLE IF NOT EXISTS relay_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL)"#,
    r#"CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    kind TEXT NOT NULL,
    tool TEXT,
    summary TEXT,
    agent TEXT
  )"#,
    r#"CREATE TABLE IF NOT EXISTS peek_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL)"#,
    r#"CREATE INDEX IF NOT EXISTS peek_turns_endpoint ON peek_turns (endpoint, id)"#,
    r#"CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END"#,
    AUDIT_NO_DELETE,
];

const HOT_INDEXES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS audit_event ON audit (event, endpoint, id)",
    "CREATE INDEX IF NOT EXISTS audit_ref ON audit (event, ref)",
    "CREATE INDEX IF NOT EXISTS endpoints_hooked ON endpoints (process) WHERE hook_seen IS NOT NULL AND process IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS endpoints_wake ON endpoints (waker_left) WHERE wake IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS endpoints_status ON endpoints (status_state) WHERE status_state IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS endpoints_revive ON endpoints (wake_tried) WHERE hibernate IS NOT NULL AND revive IS NOT NULL AND wake_ticket IS NOT NULL",
];

const ENDPOINT_COLUMNS: &[(&str, &str)] = &[
    ("tree", "TEXT"),
    ("parent_ep", "TEXT"),
    ("parent_addr", "TEXT"),
    ("depth", "INTEGER"),
    ("rules", "TEXT"),
    ("caps", "TEXT"),
    ("title", "TEXT"),
    ("reset_at", "INTEGER"),
    ("spawned_at", "INTEGER"),
    ("peek", "TEXT"),
    ("pushes", "INTEGER"),
    ("prompts", "INTEGER"),
    ("briefed", "INTEGER"),
    ("introduced", "INTEGER"),
    ("directive_holds", "INTEGER"),
    ("harness_session", "TEXT"),
    ("harness_origin", "TEXT"),
    ("harness_transcript", "TEXT"),
    ("title_auto", "TEXT"),
    ("title_turn", "INTEGER"),
    ("tldr_turn", "INTEGER"),
    ("named", "INTEGER"),
    ("linked", "INTEGER"),
    ("wake", "TEXT"),
    ("wakers", "INTEGER NOT NULL DEFAULT 0"),
    ("waker_left", "INTEGER"),
    ("hibernate", "TEXT"),
    ("wake_ref", "TEXT"),
    ("hibernated_at", "INTEGER"),
    ("wake_tried", "INTEGER"),
    ("wake_fails", "INTEGER NOT NULL DEFAULT 0"),
    ("wake_note", "TEXT"),
    ("wake_eta", "INTEGER"),
    ("wake_declined", "TEXT"),
    ("declined_message", "TEXT"),
    ("declined_from", "TEXT"),
    ("hold_ref", "TEXT"),
    ("wake_ticket", "TEXT"),
    ("wake_tickets", "TEXT"),
    ("mail_at", "INTEGER"),
    ("revive", "TEXT"),
];

fn error(message: impl std::fmt::Display) -> StoreError {
    StoreError::Database(message.to_string())
}

fn text<'a>(row: &'a Row, column: &str) -> StoreResult<&'a str> {
    match row.get(column) {
        Some(SqlValue::Text(value)) => Ok(value),
        _ => Err(error(format!("expected text in {column}"))),
    }
}

fn json_column(row: &Row, column: &str, fallback: Value) -> StoreResult<Value> {
    match row.get(column) {
        None | Some(SqlValue::Null) => Ok(fallback),
        Some(SqlValue::Text(value)) if value.is_empty() => Ok(fallback),
        Some(SqlValue::Text(value)) => serde_json::from_str(value).map_err(error),
        _ => Err(error(format!("expected JSON text in {column}"))),
    }
}

fn value(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

fn new_id(prefix: &str, now_ms: i64) -> String {
    let mut now = now_ms.unsigned_abs();
    let mut digits = Vec::new();
    loop {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(now % 36) as usize] as char);
        now /= 36;
        if now == 0 {
            break;
        }
    }
    let timestamp: String = digits.into_iter().rev().collect();
    let timestamp = if now_ms < 0 {
        format!("-{timestamp}")
    } else {
        timestamp
    };
    let mut random = [0_u8; 8];
    rand::thread_rng().fill_bytes(&mut random);
    format!("{prefix}_{timestamp:0>9}{}", hex::encode(random))
}

async fn columns(store: &dyn Storage, table: &str) -> StoreResult<HashSet<String>> {
    store
        .all(&format!("PRAGMA table_info({table})"), &[])
        .await?
        .iter()
        .map(|row| text(row, "name").map(str::to_owned))
        .collect()
}

async fn add_columns(
    store: &dyn Storage,
    table: &str,
    columns: &[(&str, &str)],
    existing: &HashSet<String>,
) -> StoreResult<()> {
    for (column, kind) in columns {
        if !existing.contains(*column) {
            store
                .all(
                    &format!("ALTER TABLE {table} ADD COLUMN {column} {kind}"),
                    &[],
                )
                .await?;
        }
    }
    Ok(())
}

pub async fn migrate(store: &dyn Storage, now_ms: i64) -> StoreResult<()> {
    for statement in MIGRATION {
        store.all(statement, &[]).await?;
    }
    add_columns(
        store,
        "idempotency",
        &[("payload_hash", "TEXT NOT NULL DEFAULT ''")],
        &columns(store, "idempotency").await?,
    )
    .await?;
    add_columns(
        store,
        "messages",
        &[
            ("sender_tty", "INTEGER"),
            ("require_reply", "INTEGER"),
            ("link_parent", "TEXT"),
        ],
        &columns(store, "messages").await?,
    )
    .await?;
    let endpoints = columns(store, "endpoints").await?;
    add_columns(
        store,
        "endpoints",
        &[
            ("session", "TEXT"),
            ("hook_seen", "INTEGER"),
            ("hook_ended", "INTEGER"),
        ],
        &endpoints,
    )
    .await?;
    if !endpoints.contains("process") {
        store
            .all("ALTER TABLE endpoints ADD COLUMN process TEXT", &[])
            .await?;
        store
            .all(
                "UPDATE endpoints SET process = session WHERE session GLOB 'pid:[0-9]*'",
                &[],
            )
            .await?;
    }
    add_columns(
        store,
        "endpoints",
        &[("stop_blocks", "INTEGER")],
        &endpoints,
    )
    .await?;
    add_columns(store, "endpoints", ENDPOINT_COLUMNS, &endpoints).await?;
    add_columns(
        store,
        "admins",
        &[("scope_id", "TEXT")],
        &columns(store, "admins").await?,
    )
    .await?;
    add_columns(
        store,
        "grants",
        &[
            ("spent_cwd", "TEXT"),
            ("title", "TEXT"),
            ("bound_process", "TEXT"),
            ("peek", "TEXT"),
            ("prompt", "TEXT"),
            ("spawn", "INTEGER"),
            ("no_push", "INTEGER"),
            ("handback", "TEXT"),
            ("pushed_at", "INTEGER"),
            ("steer", "TEXT"),
            ("run", "INTEGER"),
            ("ended_at", "INTEGER"),
        ],
        &columns(store, "grants").await?,
    )
    .await?;
    for statement in [
        "CREATE INDEX IF NOT EXISTS grants_bound ON grants (bound_process)",
        "CREATE INDEX IF NOT EXISTS grants_issuer ON grants (issuer)",
        "CREATE INDEX IF NOT EXISTS grants_used ON grants (used_by)",
    ] {
        store.all(statement, &[]).await?;
    }
    add_columns(
        store,
        "groups",
        &[("id", "TEXT")],
        &columns(store, "groups").await?,
    )
    .await?;
    for row in store
        .all("SELECT name FROM groups WHERE id IS NULL", &[])
        .await?
    {
        store
            .all(
                "UPDATE groups SET id = ? WHERE name = ?",
                &[value(&new_id("grp", now_ms)), value(text(&row, "name")?)],
            )
            .await?;
    }
    for statement in [
        "CREATE INDEX IF NOT EXISTS endpoints_process ON endpoints (process)",
        "CREATE INDEX IF NOT EXISTS endpoints_parent ON endpoints (parent_ep)",
        "CREATE INDEX IF NOT EXISTS endpoints_session ON endpoints (session)",
        "CREATE INDEX IF NOT EXISTS endpoints_seen ON endpoints (COALESCE(last_seen, created_at))",
    ] {
        store.all(statement, &[]).await?;
    }
    add_columns(
        store,
        "deliveries",
        &[
            ("offered_until", "INTEGER"),
            ("offered_hold", "TEXT"),
            ("injected_at", "INTEGER"),
            ("nudged_at", "INTEGER"),
            ("restated_at", "INTEGER"),
            ("deferred_at", "INTEGER"),
            ("deferred_ack", "INTEGER"),
        ],
        &columns(store, "deliveries").await?,
    )
    .await?;
    add_columns(
        store,
        "activity",
        &[("agent", "TEXT")],
        &columns(store, "activity").await?,
    )
    .await?;
    for (handle, kind, harness) in [("_relay", "system", "relay"), ("_human", "human", "human")] {
        if store
            .all("SELECT * FROM endpoints WHERE handle = ?", &[value(handle)])
            .await?
            .is_empty()
        {
            store.all("INSERT INTO endpoints (id, handle, kind, harness, labels, created_at) VALUES (?, ?, ?, ?, '{}', ?)", &[value(&new_id("ep", now_ms)), value(handle), value(kind), value(harness), SqlValue::Int(now_ms)]).await?;
        }
    }
    for index in HOT_INDEXES {
        store.all(index, &[]).await?;
    }
    let trigger = store
        .all(
            "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_no_delete'",
            &[],
        )
        .await?;
    let flat = |sql: &str| {
        sql.replacen("IF NOT EXISTS ", "", 1)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    if trigger
        .first()
        .map(|row| text(row, "sql").map(&flat))
        .transpose()?
        .as_deref()
        != Some(&flat(AUDIT_NO_DELETE))
    {
        store
            .all("DROP TRIGGER IF EXISTS audit_no_delete", &[])
            .await?;
        store.all(AUDIT_NO_DELETE, &[]).await?;
    }
    migrate_tree_preset(store, now_ms).await
}

fn old_entries(entries: &Value) -> bool {
    entries
        .as_array()
        .is_some_and(|entries| entries.len() == 1 && entries[0] == json!({"sel": "tree:self"}))
}

fn narrowed() -> Value {
    json!([{"sel": "tree:parent"}, {"sel": "tree:descendants"}])
}

fn change(list: String, dir: Value) -> Value {
    json!({"list": list, "dir": dir, "before": ["tree:self"], "after": ["tree:parent", "tree:descendants"]})
}

fn address(row: &Row) -> StoreResult<String> {
    Ok(match text(row, "kind")? {
        "human" => "me/".to_owned(),
        "system" => "me/relay".to_owned(),
        _ => format!("me/{}", text(row, "handle")?),
    })
}

async fn audit(store: &dyn Storage, now_ms: i64, endpoint: &str, detail: Value) -> StoreResult<()> {
    store.all("INSERT INTO audit (at, event, endpoint, ref, detail) VALUES (?, 'scope_migrate', ?, NULL, ?)", &[SqlValue::Int(now_ms), value(endpoint), value(&detail.to_string())]).await?;
    Ok(())
}

async fn migrate_tree_preset(store: &dyn Storage, now_ms: i64) -> StoreResult<()> {
    let name = value("tree_preset_narrowed");
    if !store
        .all(
            "SELECT name FROM relay_migrations WHERE name = ?",
            std::slice::from_ref(&name),
        )
        .await?
        .is_empty()
    {
        return Ok(());
    }
    store.all("BEGIN IMMEDIATE", &[]).await?;
    let result = rewrite_tree_preset(store, now_ms).await;
    if let Err(error) = result {
        let _ = store.all("ROLLBACK", &[]).await;
        return Err(error);
    }
    if let Err(error) = store.all("COMMIT", &[]).await {
        let _ = store.all("ROLLBACK", &[]).await;
        return Err(error);
    }
    Ok(())
}

async fn rewrite_tree_preset(store: &dyn Storage, now_ms: i64) -> StoreResult<()> {
    for row in store
        .all(
            "SELECT * FROM endpoints WHERE rules IS NOT NULL OR caps IS NOT NULL ORDER BY rowid",
            &[],
        )
        .await?
    {
        let mut lists = Vec::new();
        let mut rules = json_column(&row, "rules", json!({}))?;
        for dir in ["in", "out"] {
            if rules.get(dir) == Some(&json!(["tree:self"])) {
                rules[dir] = json!(["tree:parent", "tree:descendants"]);
                lists.push(change("own rules".to_owned(), json!(dir)));
            }
        }
        let stored = json_column(&row, "caps", json!({}))?;
        let mut caps = stored.get("caps").cloned().unwrap_or(json!([]));
        let mut allow = stored.get("allow").cloned().unwrap_or(json!({}));
        for cap in caps
            .as_array_mut()
            .ok_or_else(|| error("caps must be an array"))?
        {
            if cap.get("sels").is_some_and(old_entries) {
                cap["sels"] = narrowed();
                lists.push(change(
                    format!(
                        "cap {}",
                        cap.get("id").and_then(Value::as_str).unwrap_or("undefined")
                    ),
                    cap.get("dir").cloned().unwrap_or(Value::Null),
                ));
            }
        }
        if lists.is_empty() {
            continue;
        }
        let rules = if rules.as_object().is_some_and(|rules| rules.is_empty()) {
            SqlValue::Null
        } else {
            value(&rules.to_string())
        };
        store
            .all(
                "UPDATE endpoints SET rules = ? WHERE id = ?",
                &[rules, value(text(&row, "id")?)],
            )
            .await?;
        if let Some(allow) = allow.as_object_mut() {
            allow.retain(|_, entries| entries.as_array().is_none_or(|entries| !entries.is_empty()));
        }
        let mut saved = json!({"caps": caps, "allow": allow});
        if let Some(lifted) = stored
            .get("lifted")
            .filter(|list| list.as_array().is_some_and(|list| !list.is_empty()))
        {
            saved["lifted"] = lifted.clone();
        }
        let nonempty = saved["caps"]
            .as_array()
            .is_some_and(|caps| !caps.is_empty())
            || saved["allow"]
                .as_object()
                .is_some_and(|allow| !allow.is_empty())
            || saved.get("lifted").is_some();
        store
            .all(
                "UPDATE endpoints SET caps = ? WHERE id = ?",
                &[
                    if nonempty {
                        value(&saved.to_string())
                    } else {
                        SqlValue::Null
                    },
                    value(text(&row, "id")?),
                ],
            )
            .await?;
        audit(
            store,
            now_ms,
            text(&row, "id")?,
            json!({"target": address(&row)?, "lists": lists}),
        )
        .await?;
    }
    for row in store.all("SELECT * FROM grants WHERE used_by IS NULL AND revoked_at IS NULL AND caps IS NOT NULL ORDER BY rowid", &[]).await? {
        let mut caps = json_column(&row, "caps", json!([]))?;
        let mut lists = Vec::new();
        for cap in caps.as_array_mut().ok_or_else(|| error("grant caps must be an array"))? {
            if cap.get("sels").is_some_and(old_entries) {
                cap["sels"] = narrowed();
                lists.push(change("grant".to_owned(), cap.get("dir").cloned().unwrap_or(Value::Null)));
            }
        }
        if lists.is_empty() { continue; }
        store.all("UPDATE grants SET caps = ? WHERE token_hash = ?", &[value(&caps.to_string()), value(text(&row, "token_hash")?)]).await?;
        let under = text(&row, "under")?;
        let target = store.all("SELECT * FROM endpoints WHERE id = ?", &[value(under)]).await?;
        let target = target.first().map(address).transpose()?.unwrap_or_else(|| under.to_owned());
        audit(store, now_ms, under, json!({"target": target, "grant": true, "lists": lists})).await?;
    }
    store
        .all(
            "INSERT INTO relay_migrations (name, at) VALUES (?, ?)",
            &[value("tree_preset_narrowed"), SqlValue::Int(now_ms)],
        )
        .await?;
    Ok(())
}

pub async fn prune_audit(
    store: &dyn Storage,
    now_ms: i64,
    keep_s: Option<i64>,
) -> StoreResult<u64> {
    let Some(keep_s) = keep_s else {
        return Ok(0);
    };
    let cutoff = now_ms.saturating_sub(keep_s.saturating_mul(1000));
    let mut removed = store
        .all(
            "DELETE FROM audit WHERE at <= ? RETURNING id",
            &[SqlValue::Int(cutoff)],
        )
        .await?
        .len() as u64;
    removed += store.all("DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE event IN ('scope_refused') AND at <= ? LIMIT 5000) RETURNING id", &[SqlValue::Int(now_ms.saturating_sub(86_400_000))]).await?.len() as u64;
    Ok(removed)
}
