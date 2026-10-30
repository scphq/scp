use std::future::Future;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Mutex, Notify, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::core::{Core, SharedCore};
use crate::hooks::{HookCalls, HookHandler};
use crate::paths::{BrokerLock, Paths};
use crate::proto::{Limits, RpcError};
use crate::store::sqlite::SqliteStore;

pub const MAX_LINE: usize = 256 * 1024;
const MAX_PENDING: usize = 32;
const OUTBOUND_CAP: usize = 4 * 1024 * 1024;
const PARTIAL_LINE_TIMEOUT: Duration = Duration::from_secs(30);

pub struct BrokerOptions {
    pub paths: Paths,
    pub limits: Limits,
    pub policy_file: PathBuf,
    pub idle: Duration,
}

pub struct Broker {
    listener: UnixListener,
    pub core: SharedCore,
    paths: Paths,
    lock: BrokerLock,
    socket_inode: u64,
    idle: Duration,
    hook: Option<Arc<dyn HookHandler>>,
}

impl Broker {
    /// Serves the `hook` RPC through `handler` and advertises the "hook" capability.
    pub fn with_hook(mut self, handler: Arc<dyn HookHandler>) -> Self {
        self.hook = Some(handler);
        self
    }

    pub async fn start(options: BrokerOptions) -> io::Result<Self> {
        options.paths.prepare().await?;
        let lock = BrokerLock::acquire(&options.paths.lock).await?;
        let result = Self::initialize(options).await;
        match result {
            Ok((listener, core, paths, idle, socket_inode)) => Ok(Self {
                listener,
                core,
                paths,
                idle,
                lock,
                socket_inode,
                hook: None,
            }),
            Err(error) => {
                lock.release().await;
                Err(error)
            }
        }
    }

    async fn initialize(
        options: BrokerOptions,
    ) -> io::Result<(UnixListener, SharedCore, Paths, Duration, u64)> {
        let store = SqliteStore::open(&options.paths.database).map_err(io::Error::other)?;
        let core = Core::new(
            Arc::new(store),
            options.limits,
            options.paths.clone(),
            options.policy_file,
        )
        .await
        .map_err(io::Error::other)?;
        tokio::fs::set_permissions(
            &options.paths.database,
            std::fs::Permissions::from_mode(0o600),
        )
        .await?;
        match tokio::fs::remove_file(&options.paths.socket).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let listener = UnixListener::bind(&options.paths.socket)?;
        if let Err(error) = tokio::fs::set_permissions(
            &options.paths.socket,
            std::fs::Permissions::from_mode(0o600),
        )
        .await
        {
            let _ = tokio::fs::remove_file(&options.paths.socket).await;
            return Err(error);
        }
        let inode = tokio::fs::symlink_metadata(&options.paths.socket)
            .await?
            .ino();
        Ok((
            listener,
            Arc::new(Mutex::new(core)),
            options.paths,
            options.idle,
            inode,
        ))
    }

    async fn owns_socket(&self) -> bool {
        self.lock.owned().await
            && tokio::fs::symlink_metadata(&self.paths.socket)
                .await
                .is_ok_and(|meta| meta.ino() == self.socket_inode)
    }

    pub async fn run(self, shutdown: impl Future<Output = ()>) -> io::Result<()> {
        tokio::pin!(shutdown);
        let (stop, stopping) = watch::channel(false);
        let mut connections = JoinSet::new();
        let mut idle_since = Instant::now();
        let mut ownership = tokio::time::interval(Duration::from_secs(2));
        let result = loop {
            let deadline = if connections.is_empty() && !self.idle.is_zero() {
                idle_since + self.idle
            } else {
                Instant::now() + Duration::from_secs(86400)
            };
            tokio::select! {
                _ = &mut shutdown => break Ok(()),
                _ = tokio::time::sleep_until(deadline), if connections.is_empty() && !self.idle.is_zero() => break Ok(()),
                _ = ownership.tick() => if !self.owns_socket().await { break Ok(()); },
                joined = connections.join_next(), if !connections.is_empty() => {
                    if let Some(Err(error)) = joined { tracing::error!(%error, "connection task failed"); }
                    if connections.is_empty() { idle_since = Instant::now(); }
                }
                accepted = self.listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        let core = self.core.clone();
                        let stopping = stopping.clone();
                        let hook = self.hook.clone();
                        connections.spawn(async move { serve_connection(stream, core, stopping, hook).await; });
                    }
                    Err(error) => break Err(error),
                }
            }
        };
        let _ = stop.send(true);
        let drain = async { while connections.join_next().await.is_some() {} };
        if tokio::time::timeout(Duration::from_secs(2), drain)
            .await
            .is_err()
        {
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        }
        if self.owns_socket().await {
            let _ = tokio::fs::remove_file(&self.paths.socket).await;
        }
        self.lock.release().await;
        if self.paths.socket != self.paths.dir.join("relay.sock")
            && let Some(parent) = self.paths.socket.parent()
        {
            let _ = tokio::fs::remove_dir(parent).await;
        }
        result
    }
}

#[derive(Default)]
pub struct LineReader {
    pending: Vec<u8>,
}

impl LineReader {
    pub fn buffered(&self) -> usize {
        self.pending.len()
    }

    pub fn push(&mut self, chunk: &[u8]) -> (Vec<String>, bool) {
        let mut lines = Vec::new();
        for part in chunk.split_inclusive(|byte| *byte == b'\n') {
            let complete = part.last() == Some(&b'\n');
            let bytes = if complete {
                &part[..part.len() - 1]
            } else {
                part
            };
            if self.pending.len() + bytes.len() > MAX_LINE {
                return (lines, true);
            }
            self.pending.extend_from_slice(bytes);
            if complete {
                let line = String::from_utf8_lossy(&self.pending).into_owned();
                self.pending.clear();
                if !line.trim().is_empty() {
                    lines.push(line);
                }
            }
        }
        (lines, false)
    }
}

pub struct Request {
    pub id: Option<Value>,
    pub method: String,
    pub params: Map<String, Value>,
}

pub fn parse_request(line: &str) -> Result<Request, Value> {
    let value: Value =
        serde_json::from_str(line).map_err(|_| RpcError::parse().frame(Value::Null))?;
    let object = value.as_object().ok_or_else(|| {
        RpcError::invalid_request("a request is a JSON object").frame(Value::Null)
    })?;
    let id = object.get("id").cloned();
    let reply_id = id.clone().unwrap_or(Value::Null);
    if !reply_id.is_null() && !reply_id.is_string() && !reply_id.is_number() {
        return Err(
            RpcError::invalid_request("a request id is a string or a number").frame(Value::Null),
        );
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RpcError::invalid_request("a request needs a method").frame(reply_id.clone())
        })?;
    let params = match object.get("params") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(params)) => params.clone(),
        _ => return Err(RpcError::invalid_request("params is an object").frame(reply_id)),
    };
    Ok(Request {
        id,
        method: method.to_owned(),
        params,
    })
}

#[derive(Clone)]
struct Output {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    failed: Arc<Notify>,
}

impl Output {
    fn send(&self, frame: Value) {
        let Ok(mut bytes) = serde_json::to_vec(&frame) else {
            return;
        };
        bytes.push(b'\n');
        let old = self.queued.fetch_add(bytes.len(), Ordering::Relaxed);
        if old > 0 && old.saturating_add(bytes.len()) > OUTBOUND_CAP {
            self.queued.fetch_sub(bytes.len(), Ordering::Relaxed);
            self.failed.notify_one();
            return;
        }
        if let Err(error) = self.tx.send(bytes) {
            self.queued.fetch_sub(error.0.len(), Ordering::Relaxed);
            self.failed.notify_one();
        }
    }
}

pub(crate) async fn serve_connection(
    stream: UnixStream,
    core: SharedCore,
    mut stopping: watch::Receiver<bool>,
    hook: Option<Arc<dyn HookHandler>>,
) {
    let (conn, closed) = {
        let mut core = core.lock().await;
        let conn = core.state.connect();
        (conn, core.state.connections[&conn].closed.clone())
    };
    let closing = closed.notified();
    tokio::pin!(closing);
    closing.as_mut().enable();
    let (mut reader, mut writer) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let queued = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(Notify::new());
    let output = Output {
        tx,
        queued: queued.clone(),
        failed: failed.clone(),
    };
    let writer_failed = failed.clone();
    let writer_task = tokio::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                writer_failed.notify_one();
                return;
            }
            queued.fetch_sub(bytes.len(), Ordering::Relaxed);
        }
        let _ = writer.shutdown().await;
    });
    let mut lines = LineReader::default();
    let mut requests = JoinSet::new();
    let mut chunk = [0u8; 64 * 1024];
    let mut partial_since: Option<Instant> = None;
    let mut too_large = false;
    let hooks = hook.as_ref().map(|_| {
        let output = output.clone();
        HookCalls::new(core.clone(), conn, move |frame| output.send(frame))
    });
    let mut not_plain = false;
    'connection: loop {
        if *stopping.borrow() {
            break;
        }
        if too_large && requests.is_empty() {
            output.send(RpcError::too_large().frame(Value::Null));
            break;
        }
        let deadline = partial_since.unwrap_or_else(Instant::now) + PARTIAL_LINE_TIMEOUT;
        tokio::select! {
            _ = &mut closing => break,
            _ = stopping.changed() => break,
            _ = failed.notified() => break,
            _ = requests.join_next(), if !requests.is_empty() => {},
            _ = tokio::time::sleep_until(deadline), if partial_since.is_some() && !too_large => {
                output.send(RpcError::invalid_request("the request line was not finished in time").frame(Value::Null));
                break;
            }
            read = reader.read(&mut chunk), if !too_large => {
                let size = match read { Ok(0) | Err(_) => break, Ok(size) => size };
                let (batch, over_cap) = lines.push(&chunk[..size]);
                if lines.buffered() == 0 || !batch.is_empty() { partial_since = None; }
                if lines.buffered() > 0 && partial_since.is_none() { partial_since = Some(Instant::now()); }
                for line in batch {
                    while requests.len() >= MAX_PENDING {
                        tokio::select! {
                            _ = &mut closing => break 'connection,
                            _ = stopping.changed() => break 'connection,
                            _ = failed.notified() => break 'connection,
                            _ = requests.join_next() => {},
                        }
                    }
                    let request = match parse_request(&line) {
                        Ok(request) => request,
                        Err(frame) => { output.send(frame); continue; }
                    };
                    if request.method == "hello" { not_plain |= crate::hooks::not_plain(&request.params); }
                    if let (Some(handler), Some(calls)) = (&hook, &hooks)
                        && matches!(request.method.as_str(), "hook" | "hook_commit")
                    {
                        let (handler, calls, output, plain) = (handler.clone(), calls.clone(), output.clone(), !not_plain);
                        requests.spawn(async move {
                            let result = calls.dispatch(handler, plain, &request.method, &request.params).await;
                            if let Some(id) = request.id {
                                output.send(match result {
                                    Ok(result) => json!({"jsonrpc":"2.0", "id":id, "result":result}),
                                    Err(error) => error.frame(id),
                                });
                            }
                        });
                        continue;
                    }
                    let guard = tokio::select! {
                        _ = &mut closing => break 'connection,
                        _ = stopping.changed() => break 'connection,
                        _ = failed.notified() => break 'connection,
                        guard = core.clone().lock_owned() => guard,
                    };
                    let core = core.clone();
                    let output = output.clone();
                    let advertise = hook.is_some() && request.method == "hello";
                    requests.spawn(async move {
                        let mut result = Core::execute(core, guard, conn, request.method, request.params).await;
                        if advertise && let Ok(result) = &mut result { crate::hooks::advertise(result); }
                        if let Some(id) = request.id {
                            output.send(match result {
                                Ok(result) => json!({"jsonrpc":"2.0", "id":id, "result":result}),
                                Err(error) => error.frame(id),
                            });
                        }
                    });
                }
                too_large = over_cap;
            }
        }
    }
    if let Some(calls) = &hooks {
        calls.close();
    }
    core.lock().await.disconnect(conn).await;
    while requests.join_next().await.is_some() {}
    drop(output);
    let mut writer_task = writer_task;
    if tokio::time::timeout(Duration::from_secs(2), &mut writer_task)
        .await
        .is_err()
    {
        writer_task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Row, SqlValue, Storage, StoreResult, Transaction};
    use async_trait::async_trait;
    use std::sync::atomic::AtomicBool;

    struct PausedStore {
        inner: Arc<dyn Storage>,
        pause: AtomicBool,
        written: Notify,
        finish: Notify,
    }

    #[async_trait]
    impl Storage for PausedStore {
        async fn all(&self, statement: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>> {
            let result = if let Some(transaction) = crate::store::active(self) {
                transaction.lock().await.all(statement, params).await
            } else {
                self.inner.all(statement, params).await
            };
            if statement.starts_with("INSERT INTO endpoints")
                && self.pause.swap(false, Ordering::SeqCst)
            {
                self.written.notify_one();
                self.finish.notified().await;
            }
            result
        }

        async fn read(&self, statement: &str, params: &[SqlValue]) -> StoreResult<Vec<Row>> {
            self.inner.read(statement, params).await
        }

        async fn begin(&self) -> StoreResult<Box<dyn Transaction>> {
            self.inner.begin().await
        }
    }

    #[tokio::test]
    async fn disconnect_mid_hello_finishes_and_next_hello_persists() {
        let dir =
            std::env::temp_dir().join(format!("scp-disconnect-{:032x}", rand::random::<u128>()));
        tokio::fs::create_dir(&dir).await.expect("directory");
        let paths = Paths::new(dir.clone());
        let store = Arc::new(SqliteStore::open(&paths.database).expect("store"));
        let mut core = Core::new(
            store.clone(),
            Limits::default(),
            paths.clone(),
            dir.join("policy.json"),
        )
        .await
        .expect("core");
        let paused = Arc::new(PausedStore {
            inner: store.clone(),
            pause: AtomicBool::new(true),
            written: Notify::new(),
            finish: Notify::new(),
        });
        core.store = paused.clone();
        let core = Arc::new(Mutex::new(core));
        let (_stop, stopping) = watch::channel(false);
        let (server, mut client) = UnixStream::pair().expect("socket pair");
        let mut connection = tokio::spawn(serve_connection(
            server,
            core.clone(),
            stopping.clone(),
            None,
        ));
        client.write_all(b"{\"id\":1,\"method\":\"hello\",\"params\":{\"protocol\":\"scp/1\",\"claim\":{\"handle\":\"first\"}}}\n").await.expect("hello");
        tokio::time::timeout(Duration::from_secs(2), paused.written.notified())
            .await
            .expect("hello wrote inside transaction");
        drop(client);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut connection)
                .await
                .is_err()
        );
        paused.finish.notify_one();
        tokio::time::timeout(Duration::from_secs(2), connection)
            .await
            .expect("connection finishes")
            .expect("connection task");

        let (server, mut client) = UnixStream::pair().expect("socket pair");
        let connection = tokio::spawn(serve_connection(server, core.clone(), stopping, None));
        client.write_all(b"{\"id\":2,\"method\":\"hello\",\"params\":{\"protocol\":\"scp/1\",\"claim\":{\"handle\":\"second\"}}}\n").await.expect("next hello");
        let mut response = String::new();
        use tokio::io::AsyncBufReadExt;
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::io::BufReader::new(&mut client).read_line(&mut response),
        )
        .await
        .expect("next response")
        .expect("read response");
        let response: Value = serde_json::from_str(&response).expect("response JSON");
        assert_eq!(response["result"]["endpoint"]["address"], "me/second");
        drop(client);
        tokio::time::timeout(Duration::from_secs(2), connection)
            .await
            .expect("next connection finishes")
            .expect("next connection task");
        drop(core);
        drop(paused);
        Arc::try_unwrap(store)
            .ok()
            .expect("sole store")
            .close()
            .await
            .expect("close store");
        let reopened = SqliteStore::open(&paths.database).expect("reopen");
        let rows = reopened.read("SELECT handle,connections FROM endpoints WHERE handle IN ('first','second') ORDER BY handle", &[]).await.expect("persisted endpoints");
        assert_eq!(rows.len(), 2);
        assert_eq!(crate::core::text(&rows[0], "handle"), Some("first"));
        assert!(
            rows.iter()
                .all(|row| crate::core::integer(row, "connections") == Some(0))
        );
        reopened.close().await.expect("close reopened store");
        tokio::fs::remove_dir_all(dir).await.expect("cleanup");
    }
}
