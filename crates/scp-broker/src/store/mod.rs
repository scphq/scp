//! Persistence boundary. The core speaks SQL through [`Storage`], so a SQLite-dialect backend
//! other than sqlx (for example an embedded Turso build) can plug in without touching the core.

pub mod schema;
pub mod sqlite;
#[cfg(feature = "turso")]
pub mod turso;

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;

#[derive(Debug, Clone, PartialEq)]
pub enum SqlValue {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
}

pub type Row = BTreeMap<String, SqlValue>;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Database(String),
}

pub type StoreResult<T> = Result<T, StoreError>;

/// the storage engine the broker opens `relay.db` with
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Engine {
    #[default]
    Sqlite,
    Turso,
}

impl std::str::FromStr for Engine {
    type Err = String;

    fn from_str(name: &str) -> Result<Self, Self::Err> {
        match name.trim() {
            "sqlite" => Ok(Self::Sqlite),
            "turso" => Ok(Self::Turso),
            other => Err(format!(
                "unknown store engine {other:?}: expected sqlite or turso"
            )),
        }
    }
}

impl Engine {
    /// `$SCP_STORE`, else `store.engine` in config.json, else sqlite
    pub fn configured(
        env: &BTreeMap<String, String>,
        config_dir: &std::path::Path,
    ) -> Result<Self, String> {
        if let Some(name) = env.get("SCP_STORE").filter(|name| !name.is_empty()) {
            return name.parse();
        }
        let file =
            scp_mcp::identity::read_owned_file(&config_dir.join("config.json").to_string_lossy())
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        match file
            .as_ref()
            .and_then(|file| file.get("store"))
            .and_then(|store| store.get("engine"))
        {
            None | Some(serde_json::Value::Null) => Ok(Self::Sqlite),
            Some(serde_json::Value::String(name)) => name.parse(),
            Some(other) => Err(format!("store.engine must be a string, not {other}")),
        }
    }

    pub fn open(self, path: &std::path::Path) -> StoreResult<Arc<dyn Storage>> {
        match self {
            Self::Sqlite => Ok(Arc::new(sqlite::SqliteStore::open(path)?)),
            #[cfg(feature = "turso")]
            Self::Turso => Ok(Arc::new(turso::TursoStore::open(path)?)),
            #[cfg(not(feature = "turso"))]
            Self::Turso => Err(StoreError::Database(
                "this build has no turso store: rebuild with the turso feature".into(),
            )),
        }
    }
}

#[async_trait]
pub trait Storage: Send + Sync {
    /// runs one statement on the single writer connection and returns its rows
    async fn all(&self, query: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>>;
    /// runs a read-only statement on the WAL read pool
    async fn read(&self, query: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>>;
    /// owns the writer until commit or rollback on drop
    async fn begin(&self) -> StoreResult<Box<dyn Transaction>>;
}

#[async_trait]
pub trait Transaction: Send + Sync {
    async fn all(&self, query: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>>;
    async fn commit(&mut self) -> StoreResult<()>;
}

type ActiveTransaction = Arc<Mutex<Box<dyn Transaction>>>;

tokio::task_local! {
    static ACTIVE: (usize, ActiveTransaction);
}

pub(crate) fn active(store: &dyn Storage) -> Option<ActiveTransaction> {
    let key = store as *const dyn Storage as *const () as usize;
    ACTIVE
        .try_with(|(owner, transaction)| (*owner == key).then(|| transaction.clone()))
        .ok()
        .flatten()
}

pub async fn transaction<T, E>(
    store: Arc<dyn Storage>,
    work: impl Future<Output = Result<T, E>>,
) -> Result<T, E>
where
    E: From<StoreError>,
{
    let key = Arc::as_ptr(&store) as *const () as usize;
    let transaction = Arc::new(Mutex::new(store.begin().await?));
    ACTIVE
        .scope((key, transaction.clone()), async {
            let value = work.await?;
            transaction.lock().await.commit().await?;
            Ok(value)
        })
        .await
}
