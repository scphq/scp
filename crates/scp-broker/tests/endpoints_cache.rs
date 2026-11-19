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

async fn value(
    endpoints: &Endpoints,
    store: &dyn Storage,
    id: &str,
    column: &str,
) -> Option<SqlValue> {
    endpoints
        .row(store, id)
        .await
        .expect("row")
        .map(|row| row.get(column).cloned().unwrap_or(SqlValue::Null))
}

#[tokio::test]
async fn a_row_read_inside_a_transaction_follows_its_writes_its_savepoints_and_its_rollback() {
    let (store, dir) = open().await;
    scp_broker::store::schema::migrate(store.as_ref(), 1)
        .await
        .expect("migrate");
    insert(store.as_ref(), "a").await;
    let endpoints = Endpoints::track(store.as_ref()).await;
    let title = |text: &str| Some(SqlValue::Text(text.into()));
    assert_eq!(
        value(&endpoints, store.as_ref(), "a", "title").await,
        Some(SqlValue::Null)
    );

    let refused = transaction(store.clone(), async {
        store
            .all("UPDATE endpoints SET title = 'first' WHERE id = 'a'", &[])
            .await?;
        assert_eq!(
            value(&endpoints, store.as_ref(), "a", "title").await,
            title("first")
        );
        insert(store.as_ref(), "b").await;
        assert!(value(&endpoints, store.as_ref(), "b", "id").await.is_some());
        store.all("SAVEPOINT inner", &[]).await?;
        store
            .all("UPDATE endpoints SET title = 'second' WHERE id = 'a'", &[])
            .await?;
        store
            .all("DELETE FROM endpoints WHERE id = 'b'", &[])
            .await?;
        assert_eq!(
            value(&endpoints, store.as_ref(), "a", "title").await,
            title("second")
        );
        assert!(value(&endpoints, store.as_ref(), "b", "id").await.is_none());
        store.all("ROLLBACK TO inner", &[]).await?;
        store.all("RELEASE inner", &[]).await?;
        assert_eq!(
            value(&endpoints, store.as_ref(), "a", "title").await,
            title("first")
        );
        assert!(value(&endpoints, store.as_ref(), "b", "id").await.is_some());
        Err::<(), _>(StoreError::Database("refused".into()))
    })
    .await;
    assert!(refused.is_err());
    assert_eq!(
        value(&endpoints, store.as_ref(), "a", "title").await,
        Some(SqlValue::Null)
    );
    assert!(value(&endpoints, store.as_ref(), "b", "id").await.is_none());

    let refused = transaction(store.clone(), async {
        store
            .all("UPDATE endpoints SET title = 'unread' WHERE id = 'a'", &[])
            .await?;
        insert(store.as_ref(), "c").await;
        Err::<(), _>(StoreError::Database("refused".into()))
    })
    .await;
    assert!(refused.is_err());
    assert_eq!(
        value(&endpoints, store.as_ref(), "a", "title").await,
        Some(SqlValue::Null)
    );
    assert!(value(&endpoints, store.as_ref(), "c", "id").await.is_none());

    transaction(store.clone(), async {
        store
            .all("UPDATE endpoints SET title = 'kept' WHERE id = 'a'", &[])
            .await?;
        assert_eq!(
            value(&endpoints, store.as_ref(), "a", "title").await,
            title("kept")
        );
        Ok::<(), StoreError>(())
    })
    .await
    .expect("commit");
    assert_eq!(
        value(&endpoints, store.as_ref(), "a", "title").await,
        title("kept")
    );
    let (rows, _) = cached(&endpoints, store.as_ref()).await;
    assert_eq!(rows, table(store.as_ref()).await);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_reader_waiting_on_another_tasks_transaction_sees_the_row_it_committed() {
    let (store, dir) = open().await;
    scp_broker::store::schema::migrate(store.as_ref(), 1)
        .await
        .expect("migrate");
    insert(store.as_ref(), "a").await;
    let endpoints = Arc::new(Endpoints::track(store.as_ref()).await);
    assert_eq!(
        value(&endpoints, store.as_ref(), "a", "title").await,
        Some(SqlValue::Null)
    );

    let (written, wrote) = tokio::sync::oneshot::channel();
    let (commit, release) = tokio::sync::oneshot::channel::<()>();
    let writer = tokio::spawn({
        let store = store.clone();
        async move {
            transaction(store.clone(), async {
                store
                    .all("UPDATE endpoints SET title = 'claimed' WHERE id = 'a'", &[])
                    .await?;
                let _ = written.send(());
                let _ = release.await;
                Ok::<(), StoreError>(())
            })
            .await
        }
    });
    wrote.await.expect("written");
    let reader = tokio::spawn({
        let (store, endpoints) = (store.clone(), endpoints.clone());
        async move { value(&endpoints, store.as_ref(), "a", "title").await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!reader.is_finished());
    let _ = commit.send(());
    writer.await.expect("writer").expect("commit");
    assert_eq!(
        reader.await.expect("reader"),
        Some(SqlValue::Text("claimed".into()))
    );
    let _ = std::fs::remove_dir_all(dir);
}

struct Counted {
    inner: Arc<dyn Storage>,
    statements: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl Storage for Counted {
    async fn all(
        &self,
        query: &str,
        params: &[SqlValue],
    ) -> scp_broker::store::StoreResult<Vec<Row>> {
        self.statements
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.all(query, params).await
    }

    async fn read(
        &self,
        query: &str,
        params: &[SqlValue],
    ) -> scp_broker::store::StoreResult<Vec<Row>> {
        self.inner.read(query, params).await
    }

    async fn begin(
        &self,
    ) -> scp_broker::store::StoreResult<Box<dyn scp_broker::store::Transaction>> {
        self.inner.begin().await
    }

    fn writes(&self) -> Option<u64> {
        self.inner.writes()
    }
}

#[tokio::test]
async fn rows_are_served_without_a_statement_until_the_store_writes() {
    let (inner, dir) = open().await;
    scp_broker::store::schema::migrate(inner.as_ref(), 1)
        .await
        .expect("migrate");
    insert(inner.as_ref(), "a").await;
    let store = Counted {
        inner,
        statements: Default::default(),
    };
    let endpoints = Endpoints::track(&store).await;
    let statements = || store.statements.load(std::sync::atomic::Ordering::SeqCst);
    value(&endpoints, &store, "a", "id").await;
    let warm = statements();
    for _ in 0..3 {
        assert!(value(&endpoints, &store, "a", "id").await.is_some());
        assert!(value(&endpoints, &store, "missing", "id").await.is_none());
    }
    store
        .all("SELECT * FROM endpoints WHERE id = 'a'", &[])
        .await
        .expect("select");
    value(&endpoints, &store, "a", "id").await;
    assert_eq!(statements(), warm + 1);
    store
        .all("UPDATE endpoints SET title = 'moved' WHERE id = 'a'", &[])
        .await
        .expect("update");
    assert_eq!(
        value(&endpoints, &store, "a", "title").await,
        Some(SqlValue::Text("moved".into()))
    );
    assert!(statements() > warm + 2);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn another_task_never_reads_rows_an_open_transaction_refreshed() {
    let (store, dir) = open().await;
    scp_broker::store::schema::migrate(store.as_ref(), 1)
        .await
        .expect("migrate");
    insert(store.as_ref(), "a").await;
    let endpoints = Arc::new(Endpoints::track(store.as_ref()).await);
    assert_eq!(
        value(&endpoints, store.as_ref(), "a", "title").await,
        Some(SqlValue::Null)
    );

    let (read, wrote) = tokio::sync::oneshot::channel();
    let (finish, release) = tokio::sync::oneshot::channel::<()>();
    let writer = tokio::spawn({
        let (store, endpoints) = (store.clone(), endpoints.clone());
        async move {
            transaction(store.clone(), async {
                store
                    .all(
                        "UPDATE endpoints SET title = 'uncommitted' WHERE id = 'a'",
                        &[],
                    )
                    .await?;
                let seen = value(&endpoints, store.as_ref(), "a", "title").await;
                let _ = read.send(seen);
                let _ = release.await;
                Err::<(), _>(StoreError::Database("refused".into()))
            })
            .await
        }
    });
    assert_eq!(
        wrote.await.expect("read"),
        Some(SqlValue::Text("uncommitted".into()))
    );
    let reader = tokio::spawn({
        let (store, endpoints) = (store.clone(), endpoints.clone());
        async move { value(&endpoints, store.as_ref(), "a", "title").await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(!reader.is_finished());
    let _ = finish.send(());
    assert!(writer.await.expect("writer").is_err());
    assert_eq!(reader.await.expect("reader"), Some(SqlValue::Null));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_batch_that_starts_with_a_select_still_counts_as_a_write() {
    let (store, dir) = open().await;
    scp_broker::store::schema::migrate(store.as_ref(), 1)
        .await
        .expect("migrate");
    insert(store.as_ref(), "a").await;
    let endpoints = Endpoints::track(store.as_ref()).await;
    assert_eq!(
        value(&endpoints, store.as_ref(), "a", "handle").await,
        Some(SqlValue::Text("a".into()))
    );
    store
        .all(
            "SELECT 1; UPDATE endpoints SET handle = 'renamed' WHERE id = 'a'",
            &[],
        )
        .await
        .expect("batch");
    assert_eq!(
        value(&endpoints, store.as_ref(), "a", "handle").await,
        Some(SqlValue::Text("renamed".into()))
    );
    let _ = std::fs::remove_dir_all(dir);
}
