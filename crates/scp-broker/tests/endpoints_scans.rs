use std::sync::Arc;

use scp_broker::core::{Core, now_ms};
use scp_broker::paths::Paths;
use scp_broker::proto::Limits;
use scp_broker::store::sqlite::SqliteStore;
use scp_broker::store::{SqlValue, Storage};
use serde_json::{Map, json};

const ACTIVE: &str = "MAX(created_at, COALESCE(last_seen,0), COALESCE(hook_seen,0), COALESCE(last_received_at,0), COALESCE(mail_at,0))";
const LIVE: &str = "substr(handle,1,5) != 'gone:' AND substr(handle,1,6) != '_gone_'";

async fn core() -> (Core, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("scp-scans-{:032x}", rand::random::<u128>()));
    std::fs::create_dir(&dir).expect("temporary directory");
    let store: Arc<dyn Storage> =
        Arc::new(SqliteStore::open(&dir.join("relay.db")).expect("store"));
    let core = Core::new(
        store,
        Limits::default(),
        Paths::new(dir.clone()),
        dir.join("policy.json"),
    )
    .await
    .expect("core");
    (core, dir)
}

async fn seed(core: &Core) {
    let now = now_ms();
    let old = now - 3 * 86_400_000;
    let text = |value: &str| SqlValue::Text(value.into());
    let null = || SqlValue::Null;
    let rows: Vec<[SqlValue; 9]> = vec![
        [
            text("a1"),
            text("zed"),
            text("agent"),
            null(),
            null(),
            SqlValue::Int(now),
            null(),
            null(),
            null(),
        ],
        [
            text("a2"),
            text("amy"),
            text("agent"),
            null(),
            null(),
            SqlValue::Int(old),
            null(),
            null(),
            null(),
        ],
        [
            text("a3"),
            text("gone:old"),
            text("agent"),
            null(),
            null(),
            SqlValue::Int(now),
            null(),
            null(),
            null(),
        ],
        [
            text("a4"),
            text("_gone_x"),
            text("agent"),
            null(),
            null(),
            SqlValue::Int(now),
            null(),
            null(),
            null(),
        ],
        [
            text("a5"),
            text("bob"),
            text("agent"),
            text("sub:abc:s1"),
            null(),
            SqlValue::Int(now),
            text("a1"),
            null(),
            null(),
        ],
        [
            text("a6"),
            text("m1-x"),
            text("agent"),
            null(),
            text("m1/x"),
            SqlValue::Int(now),
            null(),
            null(),
            null(),
        ],
        [
            text("a7"),
            text("acct-x"),
            text("agent"),
            null(),
            text("@acct/x"),
            SqlValue::Int(now),
            null(),
            null(),
            null(),
        ],
        [
            text("a8"),
            text("sleepy"),
            text("agent"),
            text("s8"),
            null(),
            SqlValue::Int(old),
            null(),
            text("claude-inbox"),
            null(),
        ],
        [
            text("a9"),
            text("queued"),
            text("agent"),
            null(),
            null(),
            SqlValue::Int(old),
            null(),
            null(),
            text("codex-queue"),
        ],
        [
            text("a10"),
            text("plainwake"),
            text("agent"),
            null(),
            null(),
            SqlValue::Int(old),
            null(),
            null(),
            text("claude-inbox"),
        ],
        [
            text("a11"),
            text("kid"),
            text("agent"),
            text("s11"),
            null(),
            SqlValue::Int(now),
            text("a1"),
            null(),
            null(),
        ],
        [
            text("a12"),
            text("amy2"),
            text("agent"),
            null(),
            null(),
            SqlValue::Int(old),
            null(),
            null(),
            null(),
        ],
        [
            text("h2"),
            text("peer"),
            text("human"),
            null(),
            null(),
            SqlValue::Int(old),
            null(),
            null(),
            null(),
        ],
    ];
    for row in rows {
        core.store
            .all(
                "INSERT INTO endpoints (id, handle, kind, session, remote, created_at, parent_ep, hibernate, wake) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &row,
            )
            .await
            .expect("insert");
    }
    for statement in [
        "UPDATE endpoints SET created_at = (SELECT created_at FROM endpoints WHERE id = 'a2') WHERE id = 'a12'",
        "UPDATE endpoints SET mail_at = 9999999999999 WHERE id = 'a2'",
    ] {
        core.store.all(statement, &[]).await.expect("update");
    }
}

async fn ids(core: &Core, statement: &str, params: &[SqlValue]) -> Vec<String> {
    core.store
        .all(statement, params)
        .await
        .expect("oracle")
        .iter()
        .filter_map(|row| match row.get("id") {
            Some(SqlValue::Text(id)) => Some(id.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn listings_read_cached_rows_in_the_order_the_sql_gives() {
    let (mut core, dir) = core().await;
    seed(&core).await;
    let floor = now_ms() - 86_400_000;

    for historic in [false, true] {
        let expected = ids(&core, &format!("SELECT * FROM endpoints WHERE remote IS NULL AND kind != 'system' AND {LIVE} AND (? OR kind != 'agent' OR {ACTIVE} >= ?) ORDER BY created_at, id"), &[SqlValue::Int(i64::from(historic)), SqlValue::Int(floor)]).await;
        let local: Vec<String> = core
            .local_rows(historic)
            .await
            .expect("local rows")
            .iter()
            .filter_map(|(row, _)| match row.get("id") {
                Some(SqlValue::Text(id)) => Some(id.clone()),
                _ => None,
            })
            .collect();
        let shown: Vec<&String> = expected.iter().filter(|id| local.contains(id)).collect();
        assert_eq!(
            local.iter().collect::<Vec<_>>(),
            shown,
            "historic {historic}"
        );
        if historic {
            assert_eq!(local, expected);
        }
    }

    let expected = ids(&core, &format!("SELECT * FROM endpoints WHERE kind != 'system' AND {LIVE} AND (remote IS NULL OR substr(remote,1,1) != '@') AND (? OR kind != 'agent' OR remote IS NOT NULL OR {ACTIVE} >= ?) ORDER BY created_at, id"), &[SqlValue::Int(1), SqlValue::Int(floor)]).await;
    let mut params = Map::new();
    params.insert("all".into(), json!(true));
    let listed: Vec<String> = core.list_endpoints(&params, None).await.expect("list")["endpoints"]
        .as_array()
        .expect("endpoints")
        .iter()
        .filter_map(|view| view["id"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(listed, expected);

    assert!(listed.contains(&"a6".to_owned()) && !listed.contains(&"a7".to_owned()));

    core.store
        .all("UPDATE endpoints SET cwd = '/moved' WHERE id = 'a1'", &[])
        .await
        .expect("update");
    let moved = core.local_rows(false).await.expect("local rows");
    let a1 = moved
        .iter()
        .find(|(row, _)| row.get("id") == Some(&SqlValue::Text("a1".into())))
        .expect("a1");
    assert_eq!(a1.0.get("cwd"), Some(&SqlValue::Text("/moved".into())));

    let _ = std::fs::remove_dir_all(dir);
}
