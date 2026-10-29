use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use async_trait::async_trait;
use sqlx::{
    Column, Connection, Row as _, SqliteConnection, SqlitePool, TypeInfo, ValueRef,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow},
};
use tokio::sync::{Mutex, OnceCell};

use super::{Row, SqlValue, Storage, StoreError, StoreResult};

pub struct SqliteStore {
    path: PathBuf,
    connections: OnceCell<Connections>,
}

struct Connections {
    writer: Mutex<SqliteConnection>,
    readers: SqlitePool,
}

fn database(error: impl std::fmt::Display) -> StoreError {
    StoreError::Database(error.to_string())
}

impl SqliteStore {
    pub fn open(path: &Path) -> StoreResult<Self> {
        Ok(Self {
            path: path.to_owned(),
            connections: OnceCell::new(),
        })
    }

    async fn connections(&self) -> StoreResult<&Connections> {
        self.connections
            .get_or_try_init(|| async {
                let mut file = tokio::fs::OpenOptions::new();
                file.write(true).create(true).truncate(false);
                #[cfg(unix)]
                file.mode(0o600);
                file.open(&self.path).await.map_err(database)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    tokio::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
                        .await
                        .map_err(database)?;
                }
                let options = SqliteConnectOptions::new()
                    .filename(&self.path)
                    .foreign_keys(false)
                    .busy_timeout(Duration::from_secs(5))
                    .pragma("cache_size", "-65536")
                    .pragma("mmap_size", "268435456")
                    .statement_cache_capacity(512);
                let writer = SqliteConnection::connect_with(
                    &options.clone().journal_mode(SqliteJournalMode::Wal),
                )
                .await
                .map_err(database)?;
                let readers = SqlitePoolOptions::new()
                    .max_connections(4)
                    .connect_lazy_with(options.read_only(true));
                Ok(Connections {
                    writer: Mutex::new(writer),
                    readers,
                })
            })
            .await
    }

    pub async fn close(self) -> StoreResult<()> {
        if let Some(connections) = self.connections.into_inner() {
            connections.readers.close().await;
            connections
                .writer
                .into_inner()
                .close()
                .await
                .map_err(database)?;
        }
        Ok(())
    }
}

fn query<'a>(
    statement: &'a str,
    params: &'a [SqlValue],
) -> sqlx::query::Query<'a, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'a>> {
    let mut query = sqlx::query(statement);
    for param in params {
        query = match param {
            SqlValue::Null => query.bind(Option::<i64>::None),
            SqlValue::Int(value) => query.bind(*value),
            SqlValue::Real(value) => query.bind(*value),
            SqlValue::Text(value) => query.bind(value),
        };
    }
    query
}

fn rows(rows: Vec<SqliteRow>) -> StoreResult<Vec<Row>> {
    rows.into_iter()
        .map(|row| {
            row.columns()
                .iter()
                .map(|column| {
                    let index = column.ordinal();
                    let raw = row.try_get_raw(index).map_err(database)?;
                    let value = if raw.is_null() {
                        SqlValue::Null
                    } else {
                        match raw.type_info().name() {
                            "INTEGER" => SqlValue::Int(row.try_get(index).map_err(database)?),
                            "REAL" => SqlValue::Real(row.try_get(index).map_err(database)?),
                            "TEXT" => SqlValue::Text(row.try_get(index).map_err(database)?),
                            kind => {
                                return Err(database(format!(
                                    "unsupported SQLite value type {kind} in {}",
                                    column.name()
                                )));
                            }
                        }
                    };
                    Ok((column.name().to_owned(), value))
                })
                .collect()
        })
        .collect()
}

#[async_trait]
impl Storage for SqliteStore {
    async fn all(&self, statement: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>> {
        let mut writer = self.connections().await?.writer.lock().await;
        rows(
            query(statement, params)
                .fetch_all(&mut *writer)
                .await
                .map_err(database)?,
        )
    }

    async fn read(&self, statement: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>> {
        let connections = self.connections().await?;
        rows(
            query(statement, params)
                .fetch_all(&connections.readers)
                .await
                .map_err(database)?,
        )
    }
}
