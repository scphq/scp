#![cfg(feature = "turso")]

use std::path::{Path, PathBuf};

use scp_broker::store::{
    Row, SqlValue, Storage, schema::migrate, sqlite::SqliteStore, turso::TursoStore,
};

const NOW: i64 = 1_700_000_000_000;

async fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("scp-turso-{:032x}", rand::random::<u128>()));
    tokio::fs::create_dir(&dir)
        .await
        .expect("temporary directory");
    dir
}

fn recent() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64
}

fn text(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

async fn write_rows(store: &dyn Storage, tag: &str, now: i64) {
    store
        .all(
            "INSERT INTO endpoints (id, handle, kind, labels, created_at) VALUES (?, ?, 'agent', '{}', ?)",
            &[text(&format!("ep_{tag}")), text(tag), SqlValue::Int(now)],
        )
        .await
        .expect("endpoint");
    store
        .all(
            "INSERT INTO messages (id, thread, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at) VALUES (?, ?, 'note', ?, 'me/x', ?, 'text/plain', 'internal', '[]', 0, ?, ?)",
            &[
                text(&format!("msg_{tag}")),
                text(&format!("msg_{tag}")),
                text(&format!("ep_{tag}")),
                text(&format!("body λ {tag}")),
                SqlValue::Int(now),
                SqlValue::Int(now + 86_400_000),
            ],
        )
        .await
        .expect("message");
    let delivered = store
        .all(
            "INSERT INTO deliveries (message_id, endpoint, expires_at) VALUES (?, ?, ?) RETURNING seq",
            &[
                text(&format!("msg_{tag}")),
                text(&format!("ep_{tag}")),
                SqlValue::Int(now + 86_400_000),
            ],
        )
        .await
        .expect("delivery");
    assert!(matches!(delivered[0]["seq"], SqlValue::Int(_)));
    store
        .all(
            "INSERT INTO audit (at, event, endpoint, detail) VALUES (?, 'bench', ?, ?)",
            &[
                SqlValue::Int(recent()),
                text(&format!("ep_{tag}")),
                text(&format!("{{\"tag\":\"{tag}\"}}")),
            ],
        )
        .await
        .expect("audit");
}

async fn snapshot(store: &dyn Storage) -> Vec<Vec<Row>> {
    let mut tables = Vec::new();
    for query in [
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
        "SELECT id, handle, kind, labels, created_at FROM endpoints ORDER BY rowid",
        "SELECT * FROM messages ORDER BY rowid",
        "SELECT * FROM deliveries ORDER BY seq",
        "SELECT id, at, event, endpoint, detail FROM audit ORDER BY id",
        "SELECT name, seq FROM sqlite_sequence ORDER BY name",
    ] {
        tables.push(store.read(query, &[]).await.expect(query));
    }
    tables
}

/// DDL text without the quoting, spacing and `IF NOT EXISTS` either engine may store
fn normalized(sql: &SqlValue) -> SqlValue {
    let SqlValue::Text(sql) = sql else {
        return sql.clone();
    };
    let flat = sql
        .replacen("IF NOT EXISTS ", "", 1)
        .replace('"', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" (", "(")
        .replace("( ", "(")
        .replace(" )", ")");
    SqlValue::Text(flat)
}

/// every schema object outside the engines' own bookkeeping: each table's columns and indexes (unique, partial),
/// each index's keys, and each index's and trigger's DDL
async fn columns(store: &dyn Storage) -> Vec<(String, String, Vec<Row>)> {
    let mut out = Vec::new();
    for row in store
        .read(
            "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso_internal_%' ORDER BY type, name",
            &[],
        )
        .await
        .expect("objects")
    {
        let (SqlValue::Text(kind), SqlValue::Text(name)) = (&row["type"], &row["name"]) else {
            panic!("object row");
        };
        let mut rows = Vec::new();
        let details = match kind.as_str() {
            "table" => vec![
                format!("PRAGMA table_info(\"{name}\")"),
                format!("SELECT name, \"unique\", partial FROM pragma_index_list('{name}') ORDER BY name"),
            ],
            "index" => vec![format!("PRAGMA index_info(\"{name}\")")],
            _ => Vec::new(),
        };
        for detail in details {
            rows.extend(store.read(&detail, &[]).await.expect(&detail));
        }
        if kind != "table" {
            rows.push(Row::from([("sql".to_owned(), normalized(&row["sql"]))]));
        }
        out.push((kind.clone(), name.clone(), rows));
    }
    out
}

async fn assert_sound(store: &dyn Storage) {
    assert_eq!(
        store
            .all("PRAGMA integrity_check", &[])
            .await
            .expect("integrity")[0]
            .values()
            .next(),
        Some(&text("ok"))
    );
    let refused = store
        .all("DELETE FROM audit WHERE event = 'bench'", &[])
        .await
        .expect_err("recent audit rows stay");
    assert!(refused.to_string().contains("append-only"), "{refused}");
}

async fn sqlite_writes(path: &Path, tag: &str, now: i64) -> Vec<Vec<Row>> {
    let store = SqliteStore::open(path).expect("sqlite");
    migrate(&store, now).await.expect("sqlite migrate");
    write_rows(&store, tag, now).await;
    assert_sound(&store).await;
    let rows = snapshot(&store).await;
    store.close().await.expect("close sqlite");
    rows
}

async fn turso_writes(path: &Path, tag: &str, now: i64) -> Vec<Vec<Row>> {
    let store = TursoStore::open(path).expect("turso");
    migrate(&store, now).await.expect("turso migrate");
    write_rows(&store, tag, now).await;
    assert_sound(&store).await;
    let rows = snapshot(&store).await;
    store.close().await.expect("close turso");
    rows
}

#[tokio::test]
async fn one_relay_db_moves_between_sqlite_and_turso_both_ways() {
    let dir = temp_dir().await;
    let path = dir.join("relay.db");
    let first = sqlite_writes(&path, "first", NOW).await;
    let turso = TursoStore::open(&path).expect("turso");
    assert_eq!(
        snapshot(&turso).await,
        first,
        "turso reads what sqlite wrote"
    );
    turso.close().await.expect("close");
    let second = turso_writes(&path, "second", NOW + 1).await;
    assert_eq!(
        second[0], first[0],
        "turso migrates sqlite's schema in place"
    );
    assert_eq!(second[4].len(), first[4].len() + 1);
    let sqlite = SqliteStore::open(&path).expect("sqlite");
    assert_eq!(
        snapshot(&sqlite).await,
        second,
        "sqlite reads what turso wrote"
    );
    sqlite.close().await.expect("close");
    let third = sqlite_writes(&path, "third", NOW + 2).await;
    assert_eq!(third[1].len(), second[1].len() + 1);
    let fresh = dir.join("fresh.db");
    let from_turso = turso_writes(&fresh, "first", NOW).await;
    assert_eq!(
        from_turso[1..].iter().map(Vec::len).collect::<Vec<_>>(),
        first[1..].iter().map(Vec::len).collect::<Vec<_>>(),
        "turso writes as many rows as sqlite does"
    );
    assert_eq!(
        from_turso[2..4],
        first[2..4],
        "turso writes the messages and deliveries sqlite does"
    );
    let sqlite = SqliteStore::open(&fresh).expect("sqlite");
    assert_sound(&sqlite).await;
    let reference = SqliteStore::open(&path).expect("sqlite");
    assert_eq!(
        columns(&sqlite).await,
        columns(&reference).await,
        "a fresh turso schema is sqlite's"
    );
    reference.close().await.expect("close");
    sqlite.close().await.expect("close");
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

#[tokio::test]
async fn a_crash_left_wal_is_replayed_by_the_other_engine() {
    let dir = temp_dir().await;
    let copy = |from: &Path, to: &Path| {
        for suffix in ["", "-wal"] {
            std::fs::copy(
                format!("{}{suffix}", from.display()),
                format!("{}{suffix}", to.display()),
            )
            .expect("copy while open");
        }
    };
    let source = dir.join("sqlite.db");
    let sqlite = SqliteStore::open(&source).expect("sqlite");
    migrate(&sqlite, NOW).await.expect("migrate");
    write_rows(&sqlite, "unclean", NOW).await;
    let written = snapshot(&sqlite).await;
    let crashed = dir.join("crashed-sqlite.db");
    copy(&source, &crashed);
    sqlite.close().await.expect("close");
    let turso = TursoStore::open(&crashed).expect("turso");
    assert_eq!(snapshot(&turso).await, written);
    assert_sound(&turso).await;
    turso.close().await.expect("close");

    let source = dir.join("turso.db");
    let turso = TursoStore::open(&source).expect("turso");
    migrate(&turso, NOW).await.expect("migrate");
    write_rows(&turso, "unclean", NOW).await;
    let written = snapshot(&turso).await;
    let crashed = dir.join("crashed-turso.db");
    copy(&source, &crashed);
    turso.close().await.expect("close");
    let sqlite = SqliteStore::open(&crashed).expect("sqlite");
    assert_eq!(snapshot(&sqlite).await, written);
    assert_sound(&sqlite).await;
    sqlite.close().await.expect("close");
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

#[tokio::test]
async fn files_stay_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_dir().await;
    let path = dir.join("relay.db");
    tokio::fs::write(&path, []).await.expect("existing file");
    tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
        .await
        .expect("permissions");
    let store = TursoStore::open(&path).expect("turso");
    migrate(&store, NOW).await.expect("migrate");
    write_rows(&store, "private", NOW).await;
    for file in ["relay.db", "relay.db-wal"] {
        let mode = tokio::fs::metadata(dir.join(file))
            .await
            .expect(file)
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{file}");
    }
    store.close().await.expect("close");
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

async fn ids(store: &dyn Storage) -> Vec<i64> {
    store
        .read("SELECT id FROM activity ORDER BY id", &[])
        .await
        .expect("ids")
        .iter()
        .map(|row| match row["id"] {
            SqlValue::Int(id) => id,
            _ => panic!("integer id"),
        })
        .collect()
}

async fn add_activity(store: &dyn Storage) -> i64 {
    match store
        .all(
            "INSERT INTO activity (at, endpoint, kind) VALUES (1, 'ep', 'tool') RETURNING id",
            &[],
        )
        .await
        .expect("insert")[0]["id"]
    {
        SqlValue::Int(id) => id,
        _ => panic!("integer id"),
    }
}

#[tokio::test]
async fn autoincrement_never_reuses_an_id_across_engines() {
    for turso_first in [true, false] {
        let dir = temp_dir().await;
        let path = dir.join("relay.db");
        let mut issued = Vec::new();
        for turn in 0..4 {
            let turso = (turn % 2 == 0) == turso_first;
            let (sqlite, tursos) = if turso {
                (None, Some(TursoStore::open(&path).expect("turso")))
            } else {
                (Some(SqliteStore::open(&path).expect("sqlite")), None)
            };
            let store: &dyn Storage = match (&sqlite, &tursos) {
                (Some(store), _) => store,
                (_, Some(store)) => store,
                _ => unreachable!(),
            };
            migrate(store, NOW).await.expect("migrate");
            for _ in 0..2 {
                issued.push(add_activity(store).await);
            }
            let top = *ids(store).await.last().expect("rows");
            store
                .all("DELETE FROM activity WHERE id = ?", &[SqlValue::Int(top)])
                .await
                .expect("delete newest");
            if let Some(store) = sqlite {
                store.close().await.expect("close sqlite");
            }
            if let Some(store) = tursos {
                store.close().await.expect("close turso");
            }
        }
        let mut sorted = issued.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            sorted, issued,
            "turso first: {turso_first}, issued {issued:?}"
        );
        tokio::fs::remove_dir_all(dir).await.expect("cleanup");
    }
}

#[tokio::test]
async fn sqlite_inserts_into_a_schema_turso_created_without_rows() {
    let dir = temp_dir().await;
    let path = dir.join("relay.db");
    let turso = TursoStore::open(&path).expect("turso");
    migrate(&turso, NOW).await.expect("migrate");
    turso.close().await.expect("close");
    let sqlite = SqliteStore::open(&path).expect("sqlite");
    let first = add_activity(&sqlite).await;
    sqlite.close().await.expect("close");
    let turso = TursoStore::open(&path).expect("turso");
    assert!(add_activity(&turso).await > first);
    turso.close().await.expect("close");
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

#[tokio::test]
async fn a_cached_statement_forgets_earlier_parameters() {
    let dir = temp_dir().await;
    let store = TursoStore::open(&dir.join("relay.db")).expect("turso");
    let bound = store
        .all("SELECT ? AS v, ? AS w", &[text("first"), text("second")])
        .await
        .expect("bound");
    assert_eq!(bound[0]["v"], text("first"));
    let unbound = store
        .all("SELECT ? AS v, ? AS w", &[text("again")])
        .await
        .expect("fewer parameters");
    assert_eq!(unbound[0]["v"], text("again"));
    assert_eq!(unbound[0]["w"], SqlValue::Null);
    store.close().await.expect("close");
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

#[tokio::test]
async fn a_reprepared_statement_reports_its_new_columns() {
    let dir = temp_dir().await;
    let store = TursoStore::open(&dir.join("relay.db")).expect("turso");
    store
        .all("CREATE TABLE shapes (a INTEGER)", &[])
        .await
        .expect("table");
    store
        .all("INSERT INTO shapes (a) VALUES (1)", &[])
        .await
        .expect("row");
    let before = store
        .all("SELECT * FROM shapes", &[])
        .await
        .expect("before");
    assert_eq!(before[0].keys().collect::<Vec<_>>(), ["a"]);
    store
        .all("ALTER TABLE shapes ADD COLUMN b TEXT DEFAULT 'x'", &[])
        .await
        .expect("add column");
    let after = store.all("SELECT * FROM shapes", &[]).await.expect("after");
    assert_eq!(after[0]["a"], SqlValue::Int(1));
    assert_eq!(after[0]["b"], text("x"));
    store.close().await.expect("close");
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_transactions_and_readers_see_whole_commits() {
    use scp_broker::store::{StoreError, transaction};
    use std::sync::Arc;

    let dir = temp_dir().await;
    let typed = Arc::new(TursoStore::open(&dir.join("relay.db")).expect("turso"));
    let store: Arc<dyn Storage> = typed.clone();
    store
        .all("CREATE TABLE pairs (tag INTEGER, half INTEGER)", &[])
        .await
        .expect("table");
    let mut tasks = Vec::new();
    for writer in 0..6_i64 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            for round in 0..40_i64 {
                let tag = writer * 1000 + round;
                let inner = store.clone();
                transaction(store.clone(), async move {
                    for half in 0..2 {
                        inner
                            .all(
                                "INSERT INTO pairs (tag, half) VALUES (?, ?)",
                                &[SqlValue::Int(tag), SqlValue::Int(half)],
                            )
                            .await?;
                        tokio::task::yield_now().await;
                    }
                    Ok::<_, StoreError>(())
                })
                .await
                .expect("commit");
            }
        }));
    }
    for _ in 0..3 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            for _ in 0..80 {
                let torn = store
                    .read(
                        "SELECT COUNT(*) AS n FROM (SELECT tag FROM pairs GROUP BY tag HAVING COUNT(*) != 2)",
                        &[],
                    )
                    .await
                    .expect("read");
                assert_eq!(torn[0]["n"], SqlValue::Int(0), "a reader saw half a commit");
                tokio::task::yield_now().await;
            }
        }));
    }
    for task in tasks {
        task.await.expect("task");
    }
    assert_eq!(
        store
            .read("SELECT COUNT(*) AS n FROM pairs", &[])
            .await
            .expect("count")[0]["n"],
        SqlValue::Int(480)
    );
    drop(store);
    Arc::try_unwrap(typed)
        .ok()
        .expect("sole store")
        .close()
        .await
        .expect("close");
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}
