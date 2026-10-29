//! Persistence boundary. The core speaks SQL through [`Storage`], so a SQLite-dialect backend
//! other than sqlx (for example an embedded Turso build) can plug in without touching the core.

pub mod schema;
pub mod sqlite;

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
