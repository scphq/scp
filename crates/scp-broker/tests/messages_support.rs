use std::path::PathBuf;
use std::sync::Arc;

use scp_broker::core::{Core, now_ms};
use scp_broker::paths::Paths;
use scp_broker::proto::Limits;
use scp_broker::store::{SqlValue, Storage, sqlite::SqliteStore};
use serde_json::{Map, Value};

pub struct TestCore {
    pub core: Core,
    pub store: Arc<SqliteStore>,
    pub dir: PathBuf,
}

impl TestCore {
    pub async fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("scp-messages-{:032x}", rand::random::<u128>()));
        tokio::fs::create_dir(&dir)
            .await
            .expect("temporary directory");
        let paths = Paths::new(dir.clone());
        let store = Arc::new(SqliteStore::open(&paths.database).expect("store"));
        let core = Core::new(
            store.clone(),
            Limits::default(),
            paths,
            dir.join("policy.json"),
        )
        .await
        .expect("core");
        for name in ["sender", "recipient", "outsider"] {
            store.all("INSERT INTO endpoints (id,handle,kind,created_at,last_seen,connections,depth,tree) VALUES (?,?,'agent',?,?,1,0,?)", &[
                SqlValue::Text(name.into()),SqlValue::Text(name.into()),SqlValue::Int(now_ms()),SqlValue::Int(now_ms()),SqlValue::Text(name.into()),
            ]).await.expect("endpoint");
        }
        Self { core, store, dir }
    }

    pub async fn close(self) {
        drop(self.core);
        Arc::try_unwrap(self.store)
            .ok()
            .expect("sole store")
            .close()
            .await
            .expect("close");
        tokio::fs::remove_dir_all(self.dir)
            .await
            .expect("remove directory");
    }
}

pub fn params(value: Value) -> Map<String, Value> {
    value.as_object().expect("params").clone()
}
