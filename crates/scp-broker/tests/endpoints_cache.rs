use std::collections::BTreeMap;
use std::sync::Arc;

use scp_broker::endpoints::Endpoints;
use scp_broker::store::sqlite::SqliteStore;
use scp_broker::store::{Row, SqlValue, Storage, StoreError, transaction};

async fn open() -> (Arc<dyn Storage>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("scp-endpoints-{:032x}", rand::random::<u128>()));
    std::fs::create_dir(&dir).expect("temporary directory");
    let store = SqliteStore::open(&dir.join("relay.db")).expect("store");
    (Arc::new(store), dir)
}

async fn table(store: &dyn Storage) -> BTreeMap<String, Row> {
    store
        .all("SELECT * FROM endpoints", &[])
        .await
        .expect("rows")
        .into_iter()
        .map(|row| match row.get("id") {
            Some(SqlValue::Text(id)) => (id.clone(), row),
            _ => panic!("row without id"),
        })
        .collect()
}

async fn cached(endpoints: &Endpoints, store: &dyn Storage) -> (BTreeMap<String, Row>, u64) {
    let snapshot = endpoints.snapshot(store).await.expect("snapshot");
    let rows = snapshot
        .rows
        .iter()
        .map(|(id, row)| (id.clone(), row.as_ref().clone()))
        .collect();
    (rows, snapshot.epoch)
}

async fn insert(store: &dyn Storage, id: &str) {
    store
        .all(
            "INSERT INTO endpoints (id, handle, kind, created_at) VALUES (?, ?, 'agent', 1)",
            &[SqlValue::Text(id.into()), SqlValue::Text(id.into())],
        )
        .await
        .expect("insert");
}

#[tokio::test]
async fn snapshots_follow_every_write_and_move_the_epoch_only_on_scope_changes() {
    let (store, dir) = open().await;
    scp_broker::store::schema::migrate(store.as_ref(), 1)
        .await
        .expect("migrate");
    insert(store.as_ref(), "a").await;
    let endpoints = Endpoints::track(store.as_ref()).await;
    let (rows, first) = cached(&endpoints, store.as_ref()).await;
    assert_eq!(rows, table(store.as_ref()).await);

    insert(store.as_ref(), "b").await;
    let (rows, epoch) = cached(&endpoints, store.as_ref()).await;
    assert_eq!(rows, table(store.as_ref()).await);
    assert!(epoch > first);

    store
        .all(
            "UPDATE endpoints SET last_seen = 5, connections = 1 WHERE id = 'a'",
            &[],
        )
        .await
        .expect("touch");
    let (rows, same) = cached(&endpoints, store.as_ref()).await;
    assert_eq!(rows, table(store.as_ref()).await);
    assert_eq!(same, epoch);

    store
        .all(
            "UPDATE endpoints SET parent_ep = 'a', tree = 'a' WHERE id = 'b'",
            &[],
        )
        .await
        .expect("link");
    let (rows, linked) = cached(&endpoints, store.as_ref()).await;
    assert_eq!(rows, table(store.as_ref()).await);
    assert!(linked > same);

    store
        .all(
            "UPDATE endpoints SET id = 'c', handle = 'c' WHERE id = 'b'",
            &[],
        )
        .await
        .expect("rekey");
    store
        .all("DELETE FROM endpoints WHERE id = 'a'", &[])
        .await
        .expect("delete");
    let (rows, _) = cached(&endpoints, store.as_ref()).await;
    assert_eq!(rows, table(store.as_ref()).await);
    assert!(rows.contains_key("c") && !rows.contains_key("a") && !rows.contains_key("b"));

    let members = |snapshot: &scp_broker::endpoints::Snapshot| snapshot.scope.members.len();
    let before = endpoints.snapshot(store.as_ref()).await.expect("snapshot");
    store
        .all(
            "INSERT INTO group_members (name, endpoint, added_by, at) VALUES ('ops', 'c', 'c', 1)",
            &[],
        )
        .await
        .expect("join");
    let after = endpoints.snapshot(store.as_ref()).await.expect("snapshot");
    assert_eq!((members(&before), members(&after)), (0, 1));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn rows_read_inside_a_transaction_or_savepoint_are_read_again_after() {
    let (store, dir) = open().await;
    scp_broker::store::schema::migrate(store.as_ref(), 1)
        .await
        .expect("migrate");
    insert(store.as_ref(), "a").await;
    let endpoints = Endpoints::track(store.as_ref()).await;
    cached(&endpoints, store.as_ref()).await;

    let refused = transaction(store.clone(), async {
        store
            .all("UPDATE endpoints SET caps = '{}' WHERE id = 'a'", &[])
            .await?;
        insert(store.as_ref(), "b").await;
        let (rows, _) = cached(&endpoints, store.as_ref()).await;
        assert!(rows.contains_key("b"));
        assert_eq!(rows["a"].get("caps"), Some(&SqlValue::Text("{}".into())));
        Err::<(), _>(StoreError::Database("refused".into()))
    })
    .await;
    assert!(refused.is_err());
    let (rows, _) = cached(&endpoints, store.as_ref()).await;
    assert_eq!(rows, table(store.as_ref()).await);
    assert!(!rows.contains_key("b"));
    assert_eq!(rows["a"].get("caps"), Some(&SqlValue::Null));

    transaction(store.clone(), async {
        store.all("SAVEPOINT inner", &[]).await?;
        store
            .all("UPDATE endpoints SET rules = '{}' WHERE id = 'a'", &[])
            .await?;
        let (rows, _) = cached(&endpoints, store.as_ref()).await;
        assert_eq!(rows["a"].get("rules"), Some(&SqlValue::Text("{}".into())));
        store.all("ROLLBACK TO inner", &[]).await?;
        store.all("RELEASE inner", &[]).await?;
        Ok::<(), StoreError>(())
    })
    .await
    .expect("commit");
    let (rows, _) = cached(&endpoints, store.as_ref()).await;
    assert_eq!(rows, table(store.as_ref()).await);
    assert_eq!(rows["a"].get("rules"), Some(&SqlValue::Null));
    let _ = std::fs::remove_dir_all(dir);
}
