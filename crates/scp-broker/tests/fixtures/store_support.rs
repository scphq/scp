use std::path::PathBuf;

use scp_broker::store::{Row, SqlValue, sqlite::SqliteStore};
use serde_json::Value;

pub struct TempStore {
    pub store: SqliteStore,
    pub dir: PathBuf,
}

impl TempStore {
    pub async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("scp-store-{:032x}", rand::random::<u128>()));
        tokio::fs::create_dir(&dir)
            .await
            .expect("temporary directory");
        let store = SqliteStore::open(&dir.join("relay.db")).expect("store");
        Self { store, dir }
    }

    pub async fn close(self) {
        self.store.close().await.expect("close store");
        tokio::fs::remove_dir_all(self.dir)
            .await
            .expect("remove temporary directory");
    }
}

pub fn json_rows(rows: Vec<Row>) -> Value {
    Value::Array(
        rows.into_iter()
            .map(|row| {
                Value::Object(
                    row.into_iter()
                        .map(|(key, value)| {
                            (
                                key,
                                match value {
                                    SqlValue::Null => Value::Null,
                                    SqlValue::Int(value) => value.into(),
                                    SqlValue::Real(value) => value.into(),
                                    SqlValue::Text(value) => value.into(),
                                },
                            )
                        })
                        .collect(),
                )
            })
            .collect(),
    )
}
