use std::{path::PathBuf, sync::Arc};

use scp_broker::store::{Engine, Row, SqlValue, Storage, sqlite::SqliteStore};
use serde_json::Value;

/// the engine under test: `$SCP_TEST_STORE` (`sqlite` or `turso`), else sqlite
pub fn engine() -> Engine {
    std::env::var("SCP_TEST_STORE")
        .ok()
        .filter(|name| !name.is_empty())
        .map_or(Engine::Sqlite, |name| name.parse().expect("SCP_TEST_STORE"))
}

enum Typed {
    Sqlite(Arc<SqliteStore>),
    #[cfg(feature = "turso")]
    Turso(Arc<scp_broker::store::turso::TursoStore>),
}

pub struct TempStore {
    pub store: Arc<dyn Storage>,
    pub dir: PathBuf,
    typed: Typed,
}

impl TempStore {
    pub async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("scp-store-{:032x}", rand::random::<u128>()));
        tokio::fs::create_dir(&dir)
            .await
            .expect("temporary directory");
        let path = dir.join("relay.db");
        let (store, typed): (Arc<dyn Storage>, Typed) = match engine() {
            Engine::Sqlite => {
                let store = Arc::new(SqliteStore::open(&path).expect("store"));
                (store.clone(), Typed::Sqlite(store))
            }
            #[cfg(feature = "turso")]
            Engine::Turso => {
                let store =
                    Arc::new(scp_broker::store::turso::TursoStore::open(&path).expect("store"));
                (store.clone(), Typed::Turso(store))
            }
            #[cfg(not(feature = "turso"))]
            Engine::Turso => panic!("SCP_TEST_STORE=turso needs the turso feature"),
        };
        Self { store, dir, typed }
    }

    pub async fn close(self) {
        drop(self.store);
        match self.typed {
            Typed::Sqlite(store) => {
                Arc::try_unwrap(store)
                    .ok()
                    .expect("sole store")
                    .close()
                    .await
            }
            #[cfg(feature = "turso")]
            Typed::Turso(store) => {
                Arc::try_unwrap(store)
                    .ok()
                    .expect("sole store")
                    .close()
                    .await
            }
        }
        .expect("close store");
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
