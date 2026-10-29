#[path = "fixtures/store_support.rs"]
mod support;

use scp_broker::store::{SqlValue, Storage};
use support::{TempStore, json_rows};

#[tokio::test]
async fn transactions_roll_back_errors_and_cancellation_before_reusing_writer() {
    use scp_broker::store::{StoreError, transaction};
    use std::sync::Arc;

    let temp = TempStore::new().await;
    let store = Arc::new(temp.store);
    store
        .all("CREATE TABLE counts (value INTEGER)", &[])
        .await
        .expect("table");
    let error = transaction(store.clone(), async {
        store.all("INSERT INTO counts VALUES (1)", &[]).await?;
        Err::<(), _>(StoreError::Database("refused".into()))
    })
    .await
    .expect_err("rollback");
    assert!(error.to_string().contains("refused"));

    let ready = Arc::new(tokio::sync::Notify::new());
    let task_store = store.clone();
    let task_ready = ready.clone();
    let task = tokio::spawn(async move {
        transaction(task_store.clone(), async {
            task_store.all("INSERT INTO counts VALUES (2)", &[]).await?;
            task_ready.notify_one();
            std::future::pending::<()>().await;
            Ok::<(), StoreError>(())
        })
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), ready.notified())
        .await
        .expect("write started");
    task.abort();
    assert!(task.await.expect_err("cancelled").is_cancelled());

    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        transaction(store.clone(), async {
            store.all("INSERT INTO counts VALUES (3)", &[]).await?;
            Ok::<(), StoreError>(())
        }),
    )
    .await
    .expect("writer released")
    .expect("commit");
    assert_eq!(
        store
            .read("SELECT value FROM counts", &[])
            .await
            .expect("committed rows")[0]["value"],
        SqlValue::Int(3)
    );
    assert_eq!(
        store
            .read("SELECT COUNT(*) AS n FROM counts", &[])
            .await
            .expect("count")[0]["n"],
        SqlValue::Int(1)
    );
    Arc::try_unwrap(store)
        .ok()
        .expect("sole store")
        .close()
        .await
        .expect("close");
    tokio::fs::remove_dir_all(temp.dir).await.expect("cleanup");
}

#[tokio::test]
async fn positional_values_round_trip_on_writer_and_readers() {
    let temp = TempStore::new().await;
    let values = [
        SqlValue::Null,
        SqlValue::Int(i64::MIN),
        SqlValue::Real(1.25),
        SqlValue::Text("quotes ' ? \" and λ".to_owned()),
    ];
    for reader in [false, true] {
        let rows = if reader {
            temp.store
                .read("SELECT ? AS n, ? AS i, ? AS r, ? AS t", &values)
                .await
        } else {
            temp.store
                .all("SELECT ? AS n, ? AS i, ? AS r, ? AS t", &values)
                .await
        }
        .expect("bound values");
        for (column, expected) in ["n", "i", "r", "t"].into_iter().zip(&values) {
            assert_eq!(rows[0].get(column), Some(expected));
        }
    }
    temp.store
        .all("CREATE TABLE values_test (v INTEGER)", &[])
        .await
        .expect("table");
    for value in [
        SqlValue::Int(7),
        SqlValue::Real(1.25),
        SqlValue::Text("text".into()),
        SqlValue::Null,
    ] {
        let rows = temp
            .store
            .all(
                "INSERT INTO values_test (v) VALUES (?) RETURNING v",
                std::slice::from_ref(&value),
            )
            .await
            .expect("dynamic type");
        assert_eq!(rows[0]["v"], value);
    }
    assert_eq!(
        json_rows(
            temp.store
                .read("SELECT v FROM values_test ORDER BY rowid", &[])
                .await
                .expect("read rows")
        ),
        serde_json::json!([{"v": 7}, {"v": 1.25}, {"v": "text"}, {"v": null}])
    );
    assert!(
        temp.store
            .all("SELECT x'ff' AS blob", &[])
            .await
            .expect_err("unsupported blob")
            .to_string()
            .contains("BLOB")
    );
    temp.close().await;
}

#[tokio::test]
async fn wal_readers_see_committed_rows_while_writer_has_a_transaction() {
    let temp = TempStore::new().await;
    temp.store
        .all("CREATE TABLE counts (value INTEGER)", &[])
        .await
        .expect("table");
    temp.store
        .all("INSERT INTO counts VALUES (1)", &[])
        .await
        .expect("seed");
    temp.store.all("BEGIN IMMEDIATE", &[]).await.expect("begin");
    temp.store
        .all("UPDATE counts SET value = 2", &[])
        .await
        .expect("write");
    let reads = async {
        let (first, second, third) = tokio::join!(
            temp.store.read("SELECT value FROM counts", &[]),
            temp.store.read("SELECT value FROM counts", &[]),
            temp.store.read("SELECT value FROM counts", &[])
        );
        for rows in [first, second, third] {
            assert_eq!(rows.expect("snapshot")[0]["value"], SqlValue::Int(1));
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), reads)
        .await
        .expect("readers do not wait for writer");
    temp.store.all("COMMIT", &[]).await.expect("commit");
    assert_eq!(
        temp.store
            .read("SELECT value FROM counts", &[])
            .await
            .expect("committed")[0]["value"],
        SqlValue::Int(2)
    );
    assert!(
        temp.store
            .read("INSERT INTO counts VALUES (3)", &[])
            .await
            .is_err()
    );
    temp.close().await;
}

#[tokio::test]
async fn concurrent_writes_serialize_on_one_connection() {
    let temp = TempStore::new().await;
    temp.store
        .all("CREATE TABLE counter (n INTEGER)", &[])
        .await
        .expect("table");
    temp.store
        .all("INSERT INTO counter VALUES (0)", &[])
        .await
        .expect("seed");
    let increment = || async {
        for _ in 0..25 {
            temp.store
                .all("UPDATE counter SET n = n + 1", &[])
                .await
                .expect("increment");
        }
    };
    tokio::join!(increment(), increment(), increment(), increment());
    assert_eq!(
        temp.store
            .all("SELECT n FROM counter", &[])
            .await
            .expect("counter")[0]["n"],
        SqlValue::Int(100)
    );
    temp.close().await;
}

#[tokio::test]
async fn opens_with_reference_pragmas_and_private_file_modes() {
    let temp = TempStore::new().await;
    for (pragma, expected) in [
        ("journal_mode", SqlValue::Text("wal".into())),
        ("busy_timeout", SqlValue::Int(5000)),
        ("synchronous", SqlValue::Int(2)),
        ("foreign_keys", SqlValue::Int(0)),
        ("cache_size", SqlValue::Int(-65536)),
        ("mmap_size", SqlValue::Int(268435456)),
    ] {
        for rows in [
            temp.store.all(&format!("PRAGMA {pragma}"), &[]).await,
            temp.store.read(&format!("PRAGMA {pragma}"), &[]).await,
        ] {
            assert_eq!(
                rows.expect("pragma")[0].values().next(),
                Some(&expected),
                "{pragma}"
            );
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in ["relay.db", "relay.db-wal", "relay.db-shm"] {
            let metadata = tokio::fs::metadata(temp.dir.join(file))
                .await
                .expect("database file");
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600, "{file}");
        }
    }
    temp.close().await;
}

#[tokio::test]
async fn existing_database_permissions_are_restricted() {
    let temp = TempStore::new().await;
    tokio::fs::write(temp.dir.join("relay.db"), [])
        .await
        .expect("existing file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(
            temp.dir.join("relay.db"),
            std::fs::Permissions::from_mode(0o644),
        )
        .await
        .expect("permissions");
    }
    temp.store
        .all("SELECT 1", &[])
        .await
        .expect("open existing");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            tokio::fs::metadata(temp.dir.join("relay.db"))
                .await
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    temp.close().await;
}
