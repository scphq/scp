//! Persistence boundary. The core speaks SQL through [`Storage`], so a SQLite-dialect backend
//! other than sqlx (for example an embedded Turso build) can plug in without touching the core.

pub mod schema;
pub mod sqlite;

use std::collections::BTreeMap;

use async_trait::async_trait;

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
}
