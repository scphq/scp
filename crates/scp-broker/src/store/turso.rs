//! The experimental Turso store: the pure-Rust `turso_core` engine over the same `relay.db` and schema as
//! [`super::sqlite`]. Each connection lives on its own thread with a stack deep enough for the engine's planner,
//! and a caller waits for its statement within one poll, so a cancelled caller never leaves a statement half-run.

use std::{
    collections::HashMap,
    num::NonZero,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::Duration,
};

use async_trait::async_trait;
use tokio::sync::{Mutex, OnceCell, OwnedMutexGuard};
use turso_core::{
    Database, Numeric, OpenOptions, PlatformIO, SqliteDialect, Statement, StepResult, Value,
};

use super::{Row, SqlValue, Storage, StoreError, StoreResult};

const READERS: usize = 4;
const CACHED_STATEMENTS: usize = 512;
const STACK: usize = 16 * 1024 * 1024;

pub struct TursoStore {
    path: PathBuf,
    connections: OnceCell<Connections>,
}

struct Connections {
    database: Arc<Database>,
    writer: Arc<Mutex<Session>>,
    readers: Vec<Mutex<Session>>,
    next: AtomicUsize,
}

/// the handle of one engine connection's thread, and whether a dropped transaction still awaits its rollback
struct Session {
    commands: Option<mpsc::Sender<Command>>,
    worker: Option<JoinHandle<StoreResult<()>>>,
    abandoned: bool,
}

struct Command {
    sql: String,
    params: Vec<SqlValue>,
    rollback_first: bool,
    reply: mpsc::SyncSender<Reply>,
}

struct Reply {
    rolled_back: bool,
    rows: StoreResult<Vec<Row>>,
}

/// the connection and its prepared statements, owned by the session's thread
struct Worker {
    connection: Arc<turso_core::Connection>,
    statements: HashMap<String, Statement>,
}

fn database(error: impl std::fmt::Display) -> StoreError {
    StoreError::Database(error.to_string())
}

/// runs blocking engine work on this thread, telling a multi-thread runtime to move its other tasks away
fn inline<T>(work: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}

/// creates `path` owner-only, or restricts it when it exists
async fn private(path: &Path) -> StoreResult<()> {
    let mut file = tokio::fs::OpenOptions::new();
    file.write(true).create(true).truncate(false);
    #[cfg(unix)]
    file.mode(0o600);
    file.open(path).await.map_err(database)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(database)?;
    }
    Ok(())
}

fn bind(value: &SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Int(value) => Value::from_i64(*value),
        SqlValue::Real(value) => Value::from_f64(*value),
        SqlValue::Text(value) => Value::from_text(value.clone()),
    }
}

fn convert(value: &Value, column: &str) -> StoreResult<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Numeric(Numeric::Integer(value)) => SqlValue::Int(*value),
        Value::Numeric(Numeric::Float(value)) => SqlValue::Real(f64::from(*value)),
        Value::Text(value) => SqlValue::Text(value.as_str().to_owned()),
        Value::Blob(_) => {
            return Err(database(format!(
                "unsupported SQLite value type BLOB in {column}"
            )));
        }
    })
}

fn run(statement: &mut Statement, params: &[SqlValue]) -> StoreResult<Vec<Row>> {
    statement.reset().map_err(database)?;
    statement.clear_bindings();
    for (index, param) in params.iter().enumerate() {
        let position = NonZero::new(index + 1).expect("positions start at one");
        statement.bind_at(position, bind(param)).map_err(database)?;
    }
    let mut names: Option<Vec<String>> = None;
    let mut rows = Vec::new();
    loop {
        match statement.step().map_err(database)? {
            StepResult::Done => break,
            StepResult::Row => {
                let names = names.get_or_insert_with(|| {
                    (0..statement.num_columns())
                        .map(|index| statement.get_column_name(index).into_owned())
                        .collect()
                });
                let row = statement
                    .row()
                    .ok_or_else(|| database("a row step without a row"))?;
                if row.len() != names.len() {
                    return Err(database("a row does not match its statement's columns"));
                }
                let mut converted = Row::new();
                for (index, name) in names.iter().enumerate() {
                    converted.insert(name.clone(), convert(row.get_value(index), name)?);
                }
                rows.push(converted);
            }
            StepResult::IO | StepResult::Yield => statement._io().step().map_err(database)?,
            StepResult::Sleep { duration } => std::thread::sleep(duration),
            StepResult::Busy => return Err(database("database is locked")),
            StepResult::Interrupt => return Err(database("interrupted")),
        }
    }
    statement.reset().map_err(database)?;
    Ok(rows)
}

impl Worker {
    fn statement(&mut self, sql: &str) -> StoreResult<&mut Statement> {
        if !self.statements.contains_key(sql) {
            if self.statements.len() >= CACHED_STATEMENTS {
                self.statements.clear();
            }
            let prepared = self.connection.prepare(sql).map_err(database)?;
            self.statements.insert(sql.to_owned(), prepared);
        }
        Ok(self.statements.get_mut(sql).expect("just prepared"))
    }

    fn execute(&mut self, sql: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>> {
        let statement = self.statement(sql)?;
        let result = run(statement, params);
        if result.is_err() {
            statement.reset_best_effort();
        }
        result
    }

    fn serve(mut self, commands: mpsc::Receiver<Command>) -> StoreResult<()> {
        for command in commands {
            let rolled_back = !command.rollback_first
                || self.connection.get_auto_commit()
                || self.execute("ROLLBACK", &[]).is_ok();
            let rows = if rolled_back {
                self.execute(&command.sql, &command.params)
            } else {
                Err(database("the abandoned transaction did not roll back"))
            };
            let _ = command.reply.send(Reply { rolled_back, rows });
        }
        self.statements.clear();
        self.connection.close().map_err(database)
    }
}

/// runs `work` on a fresh thread with the engine's stack and waits for it
fn deep<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> StoreResult<T> {
    let worker = std::thread::Builder::new()
        .name("scp-turso".into())
        .stack_size(STACK)
        .spawn(work)
        .map_err(database)?;
    inline(|| worker.join()).map_err(|_| database("the turso thread panicked"))
}

impl Session {
    fn new(db: &Arc<Database>, query_only: bool) -> StoreResult<Self> {
        let db = db.clone();
        let (commands, inbox) = mpsc::channel::<Command>();
        let (ready, started) = mpsc::sync_channel::<StoreResult<()>>(1);
        let worker = std::thread::Builder::new()
            .name("scp-turso".into())
            .stack_size(STACK)
            .spawn(move || {
                let opened = db.connect().map_err(database).and_then(|connection| {
                    connection.set_busy_timeout(Duration::from_secs(5));
                    let mut worker = Worker {
                        connection,
                        statements: HashMap::new(),
                    };
                    if query_only {
                        worker.execute("PRAGMA query_only = 1", &[])?;
                    }
                    Ok(worker)
                });
                match opened {
                    Ok(worker) => {
                        let _ = ready.send(Ok(()));
                        worker.serve(inbox)
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        Ok(())
                    }
                }
            })
            .map_err(database)?;
        inline(|| started.recv()).map_err(|_| database("the turso thread stopped"))??;
        Ok(Self {
            commands: Some(commands),
            worker: Some(worker),
            abandoned: false,
        })
    }

    fn execute(&mut self, sql: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>> {
        let stopped = || database("the turso thread stopped");
        let (reply, answer) = mpsc::sync_channel(1);
        self.commands
            .as_ref()
            .ok_or_else(stopped)?
            .send(Command {
                sql: sql.to_owned(),
                params: params.to_vec(),
                rollback_first: self.abandoned,
                reply,
            })
            .map_err(|_| stopped())?;
        let Reply { rolled_back, rows } = inline(|| answer.recv()).map_err(|_| stopped())?;
        if rolled_back {
            self.abandoned = false;
        }
        rows
    }

    fn close(mut self) -> StoreResult<()> {
        self.commands = None;
        match self.worker.take() {
            Some(worker) => {
                inline(|| worker.join()).map_err(|_| database("the turso thread panicked"))?
            }
            None => Ok(()),
        }
    }
}

impl TursoStore {
    pub fn open(path: &Path) -> StoreResult<Self> {
        Ok(Self {
            path: path.to_owned(),
            connections: OnceCell::new(),
        })
    }

    async fn connections(&self) -> StoreResult<&Connections> {
        self.connections
            .get_or_try_init(|| async {
                let wal = PathBuf::from(format!("{}-wal", self.path.display()));
                private(&self.path).await?;
                private(&wal).await?;
                let path = self
                    .path
                    .to_str()
                    .ok_or_else(|| database("the database path is not UTF-8"))?
                    .to_owned();
                let opened = deep(move || {
                    let io = Arc::new(PlatformIO::new().map_err(database)?);
                    Database::open(io, &path, OpenOptions::new(Arc::new(SqliteDialect)))
                        .map_err(database)
                })??;
                let mut writer = Session::new(&opened, false)?;
                let mode = writer.execute("PRAGMA journal_mode = WAL", &[])?;
                if !mode.iter().flat_map(|row| row.values()).any(
                    |value| matches!(value, SqlValue::Text(mode) if mode.eq_ignore_ascii_case("wal")),
                ) {
                    return Err(database("the database did not switch to WAL"));
                }
                private(&wal).await?;
                let readers = (0..READERS)
                    .map(|_| Session::new(&opened, true).map(Mutex::new))
                    .collect::<StoreResult<Vec<_>>>()?;
                Ok(Connections {
                    database: opened,
                    writer: Arc::new(Mutex::new(writer)),
                    readers,
                    next: AtomicUsize::new(0),
                })
            })
            .await
    }

    /// checkpoints the WAL into the database file and closes every connection
    pub async fn close(self) -> StoreResult<()> {
        if let Some(connections) = self.connections.into_inner() {
            let mut writer = Arc::try_unwrap(connections.writer)
                .map_err(|_| database("writer is still in use"))?
                .into_inner();
            for reader in connections.readers {
                reader.into_inner().close()?;
            }
            writer.execute("PRAGMA wal_checkpoint(TRUNCATE)", &[])?;
            writer.close()?;
            deep(move || drop(connections.database))?;
        }
        Ok(())
    }
}

#[async_trait]
impl Storage for TursoStore {
    async fn all(&self, statement: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>> {
        if let Some(transaction) = super::active(self) {
            return transaction.lock().await.all(statement, params).await;
        }
        self.connections()
            .await?
            .writer
            .lock()
            .await
            .execute(statement, params)
    }

    async fn read(&self, statement: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>> {
        let connections = self.connections().await?;
        let index = connections.next.fetch_add(1, Ordering::Relaxed) % connections.readers.len();
        connections.readers[index]
            .lock()
            .await
            .execute(statement, params)
    }

    async fn begin(&self) -> StoreResult<Box<dyn super::Transaction>> {
        let mut writer = self.connections().await?.writer.clone().lock_owned().await;
        writer.execute("BEGIN IMMEDIATE", &[])?;
        Ok(Box::new(TursoTransaction {
            writer: Mutex::new(writer),
            open: true,
        }))
    }
}

struct TursoTransaction {
    writer: Mutex<OwnedMutexGuard<Session>>,
    open: bool,
}

#[async_trait]
impl super::Transaction for TursoTransaction {
    async fn all(&self, statement: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>> {
        self.writer.lock().await.execute(statement, params)
    }

    async fn commit(&mut self) -> StoreResult<()> {
        self.writer.get_mut().execute("COMMIT", &[])?;
        self.open = false;
        Ok(())
    }
}

impl Drop for TursoTransaction {
    fn drop(&mut self) {
        if self.open {
            self.writer.get_mut().abandoned = true;
        }
    }
}
