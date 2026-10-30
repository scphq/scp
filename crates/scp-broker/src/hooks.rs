//! Hook RPC: a plain observer hands a native hook run to the in-process renderer.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use scp_core::protocol::{ErrorCode, PROTOCOL};
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, oneshot, watch};
use tokio::task::JoinHandle;

use crate::core::{Core, SharedCore, now_ms};
use crate::proto::RpcError;
use crate::state::{ConnectionId, Mode};

const HOOK_ENV: &str = include_str!("../../../packages/spec/schema/broker/hook-env.json");
const PARAM_KEYS: [&str; 9] = [
    "args",
    "payload",
    "cwd",
    "env",
    "origin",
    "ends",
    "ppid",
    "procs",
    "harness_pid",
];
const PROC_KEYS: [&str; 5] = ["pid", "ppid", "start", "args", "comm"];
const NOT_PLAIN: [&str; 5] = ["self", "lineage", "grant", "ticket", "claim"];
const MAX_PROCS: usize = 64;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const MAX_TIMER_MS: f64 = 2_147_483_647.0;
const COMMIT_WAIT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq)]
pub struct HookProc {
    pub pid: u64,
    pub ppid: u64,
    pub start: Option<String>,
    pub args: String,
    pub comm: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HookParams {
    pub args: Vec<String>,
    pub payload: Map<String, Value>,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub origin: f64,
    pub ends: f64,
    pub ppid: u64,
    pub procs: Vec<HookProc>,
    pub harness_pid: Option<u64>,
}

/// What the renderer answers when it does not offer output through `print`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HookOutput {
    pub stdout: Option<String>,
    pub stderr: Option<String>,
}

impl HookOutput {
    fn wire(self) -> Value {
        let mut value = json!({"exit": 0});
        if let Some(stdout) = self.stdout {
            value["stdout"] = json!(stdout);
        }
        if let Some(stderr) = self.stderr {
            value["stderr"] = json!(stderr);
        }
        value
    }
}

/// The renderer behind the `hook` method; the broker advertises "hook" only when one is set.
#[async_trait]
pub trait HookHandler: Send + Sync {
    async fn handle(
        &self,
        params: HookParams,
        context: HookContext,
    ) -> Result<HookOutput, RpcError>;
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn hook_env() -> &'static [String] {
    static NAMES: OnceLock<Vec<String>> = OnceLock::new();
    NAMES.get_or_init(|| serde_json::from_str(HOOK_ENV).unwrap_or_default())
}

fn closed(value: &Map<String, Value>, keys: &[&str]) -> bool {
    value.keys().all(|key| keys.contains(&key.as_str()))
}

fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= MAX_SAFE).then_some(number as i64)
}

fn pid(value: &Value) -> Option<u64> {
    safe_integer(value)
        .filter(|n| *n > 0)
        .map(|n| n.unsigned_abs())
}

fn optional<T>(value: Option<&Value>, read: impl Fn(&Value) -> Option<T>) -> Option<Option<T>> {
    match value {
        None => Some(None),
        Some(value) => read(value).map(Some),
    }
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn start_ok(start: &str) -> bool {
    (1..=64).contains(&start.len())
        && start
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'-')
}

/// Checks hook params exactly as the reference broker does.
pub fn validate_hook(value: &Map<String, Value>) -> Result<HookParams, RpcError> {
    parse_hook(value).ok_or_else(|| RpcError::invalid_params("malformed hook params"))
}

fn parse_hook(value: &Map<String, Value>) -> Option<HookParams> {
    if !closed(value, &PARAM_KEYS) {
        return None;
    }
    let args = value
        .get("args")?
        .as_array()?
        .iter()
        .map(string)
        .collect::<Option<Vec<_>>>()?;
    let payload = value.get("payload")?.as_object()?.clone();
    let names = hook_env();
    let env = value
        .get("env")?
        .as_object()?
        .iter()
        .map(|(key, entry)| Some((key.clone(), string(entry)?)))
        .collect::<Option<BTreeMap<_, _>>>()?;
    if !env.keys().all(|key| names.contains(key)) {
        return None;
    }
    let cwd = optional(value.get("cwd"), string)?;
    let origin = value.get("origin")?.as_f64().filter(|n| n.is_finite())?;
    let ends = value.get("ends")?.as_f64().filter(|n| n.is_finite())?;
    let ppid = pid(value.get("ppid")?)?;
    let harness_pid = optional(value.get("harness_pid"), pid)?;
    let entries = value.get("procs")?.as_array()?;
    if entries.len() > MAX_PROCS {
        return None;
    }
    let mut procs: Vec<HookProc> = Vec::with_capacity(entries.len());
    for entry in entries {
        let entry = entry.as_object()?;
        if !closed(entry, &PROC_KEYS) {
            return None;
        }
        let id = pid(entry.get("pid")?)?;
        if procs.iter().any(|proc| proc.pid == id) {
            return None;
        }
        let parent = safe_integer(entry.get("ppid")?).filter(|n| *n >= 0)?;
        let start = match entry.get("start")? {
            Value::Null => None,
            Value::String(start) if start_ok(start) => Some(start.clone()),
            _ => return None,
        };
        let args = string(entry.get("args")?)?;
        let comm = optional(entry.get("comm"), string)?;
        if id == ppid && comm.is_none() {
            return None;
        }
        procs.push(HookProc {
            pid: id,
            ppid: parent.unsigned_abs(),
            start,
            args,
            comm,
        });
    }
    Some(HookParams {
        args,
        payload,
        cwd,
        env,
        origin,
        ends,
        ppid,
        procs,
        harness_pid,
    })
}

/// Whether a hello's params rule out a plain observer.
pub fn not_plain(params: &Map<String, Value>) -> bool {
    NOT_PLAIN.iter().any(|key| params.contains_key(*key))
}

/// Adds the "hook" capability to a hello result.
pub fn advertise(result: &mut Value) {
    if let Some(capabilities) = result.get_mut("capabilities").and_then(Value::as_array_mut)
        && !capabilities.iter().any(|c| c == "hook")
    {
        capabilities.push(json!("hook"));
    }
}

type Notification = Box<dyn Fn(Value) + Send + Sync>;

/// One connection's hook calls and the offers awaiting `hook_commit`.
pub struct HookCalls {
    core: SharedCore,
    conn: ConnectionId,
    closed: watch::Sender<bool>,
    notification: Mutex<Option<Notification>>,
    offers: Mutex<HashMap<String, Arc<Call>>>,
    running: Mutex<HashMap<u64, Arc<Call>>>,
    next: AtomicU64,
}

impl HookCalls {
    pub fn new(
        core: SharedCore,
        conn: ConnectionId,
        notification: impl Fn(Value) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            core,
            conn,
            closed: watch::Sender::new(false),
            notification: Mutex::new(Some(Box::new(notification))),
            offers: Mutex::default(),
            running: Mutex::default(),
            next: AtomicU64::new(0),
        })
    }

    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Serves `hook` or `hook_commit`; `plain` is false once a hello carried lineage, self, grant, ticket or claim.
    pub async fn dispatch(
        self: &Arc<Self>,
        handler: Arc<dyn HookHandler>,
        plain: bool,
        method: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let observer = self
            .core
            .lock()
            .await
            .state
            .connections
            .get(&self.conn)
            .is_some_and(|c| c.mode == Mode::Observer);
        if !plain || !observer {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "hook requires a plain observer",
            ));
        }
        if method == "hook" {
            self.run(handler, validate_hook(params)?).await
        } else {
            self.commit(params).await
        }
    }

    pub async fn run(
        self: &Arc<Self>,
        handler: Arc<dyn HookHandler>,
        params: HookParams,
    ) -> Result<Value, RpcError> {
        let (answer, answered) = oneshot::channel();
        let call = Arc::new(Call {
            calls: self.clone(),
            state: Mutex::new(CallState {
                ends: params.ends,
                offered: false,
                cancelled: false,
                answer: Some(answer),
                release: None,
                token: None,
            }),
            rearm: Notify::new(),
            done: watch::Sender::new(false),
        });
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        lock(&self.running).insert(id, call.clone());
        let timer = tokio::spawn(watch_deadline(call.clone()));
        let context = HookContext { call: call.clone() };
        tokio::spawn(async move {
            let finish = Finish {
                call: call.clone(),
                id,
                timer,
            };
            let result = handler.handle(params, context).await.map(HookOutput::wire);
            let answer = {
                let mut state = lock(&call.state);
                if state.offered {
                    None
                } else {
                    state.answer.take()
                }
            };
            if let Some(answer) = answer {
                let _ = answer.send(result);
            }
            drop(finish);
        });
        let mut closed = self.closed.subscribe();
        tokio::select! {
            answer = answered => answer.unwrap_or_else(|_| Err(RpcError::internal())),
            _ = closed.wait_for(|closed| *closed) => Err(RpcError::new(ErrorCode::Unauthorized, "connection is closed")),
        }
    }

    pub async fn commit(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
        let token = match params.get("commit") {
            Some(Value::String(token)) if closed(params, &["commit"]) => token,
            _ => return Err(RpcError::invalid_params("commit is a string")),
        };
        let offer = lock(&self.offers).get(token).cloned();
        if let Some(call) = offer {
            call.accept();
            let mut done = call.done.subscribe();
            let _ = tokio::time::timeout(COMMIT_WAIT, done.wait_for(|done| *done)).await;
        }
        Ok(json!({}))
    }

    /// Cancels every running call; their handlers see `closed()` and a false `print`.
    pub fn close(&self) {
        self.closed.send_replace(true);
        lock(&self.notification).take();
        let running: Vec<_> = lock(&self.running).values().cloned().collect();
        for call in running {
            call.cancel();
        }
        lock(&self.offers).clear();
    }

    fn deadline(&self, ends: i64) {
        if let Some(notification) = lock(&self.notification).as_ref() {
            notification(
                json!({"jsonrpc": "2.0", "method": "hook_deadline", "params": {"ends": ends}}),
            );
        }
    }
}

struct CallState {
    ends: f64,
    offered: bool,
    cancelled: bool,
    answer: Option<oneshot::Sender<Result<Value, RpcError>>>,
    release: Option<oneshot::Sender<bool>>,
    token: Option<String>,
}

struct Call {
    calls: Arc<HookCalls>,
    state: Mutex<CallState>,
    rearm: Notify,
    done: watch::Sender<bool>,
}

impl Call {
    fn cancel(&self) {
        let mut state = lock(&self.state);
        state.cancelled = true;
        if let Some(release) = state.release.take() {
            let _ = release.send(false);
        }
    }

    fn accept(&self) {
        let mut state = lock(&self.state);
        let printed = !state.cancelled && !self.calls.is_closed() && (now_ms() as f64) < state.ends;
        if let Some(release) = state.release.take() {
            let _ = release.send(printed);
        }
    }
}

async fn watch_deadline(call: Arc<Call>) {
    loop {
        let ends = lock(&call.state).ends;
        let wait = (ends - now_ms() as f64).clamp(0.0, MAX_TIMER_MS).ceil();
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(wait as u64)) => {
                if now_ms() as f64 >= lock(&call.state).ends {
                    call.cancel();
                    return;
                }
            }
            _ = call.rearm.notified() => {}
        }
    }
}

struct Finish {
    call: Arc<Call>,
    id: u64,
    timer: JoinHandle<()>,
}

impl Drop for Finish {
    fn drop(&mut self) {
        self.timer.abort();
        let token = {
            let mut state = lock(&self.call.state);
            state.answer.take();
            state.token.take()
        };
        self.call.done.send_replace(true);
        let calls = &self.call.calls;
        if let Some(token) = token {
            lock(&calls.offers).remove(&token);
        }
        lock(&calls.running).remove(&self.id);
    }
}

/// The renderer's view of one hook call.
#[derive(Clone)]
pub struct HookContext {
    call: Arc<Call>,
}

impl HookContext {
    /// An in-process connection to the broker core, closed on `close` or drop.
    pub async fn connect(&self) -> HookClient {
        let core = self.call.calls.core.clone();
        let conn = core.lock().await.state.connect();
        HookClient {
            core,
            conn,
            open: AtomicBool::new(true),
        }
    }

    /// Moves the deadline and tells the hook binary.
    pub fn notify(&self, ends: i64) {
        lock(&self.call.state).ends = ends as f64;
        self.call.rearm.notify_one();
        self.call.calls.deadline(ends);
    }

    pub fn closed(&self) -> bool {
        lock(&self.call.state).cancelled || self.call.calls.is_closed()
    }

    /// Offers stdout as the RPC answer; true once the hook binary commits it in time.
    pub async fn print(&self, stdout: impl Into<String>) -> bool {
        let printed = {
            let mut state = lock(&self.call.state);
            if state.offered
                || state.cancelled
                || self.call.calls.is_closed()
                || now_ms() as f64 >= state.ends
            {
                return false;
            }
            state.offered = true;
            let token = hex::encode(rand::random::<[u8; 24]>());
            let (release, printed) = oneshot::channel();
            state.release = Some(release);
            state.token = Some(token.clone());
            lock(&self.call.calls.offers).insert(token.clone(), self.call.clone());
            if let Some(answer) = state.answer.take() {
                let _ = answer.send(Ok(
                    json!({"stdout": stdout.into(), "exit": 0, "commit": token}),
                ));
            }
            printed
        };
        printed.await.unwrap_or(false)
    }
}

/// An internal broker connection for the renderer.
pub struct HookClient {
    core: SharedCore,
    conn: ConnectionId,
    open: AtomicBool,
}

impl HookClient {
    pub fn id(&self) -> ConnectionId {
        self.conn
    }

    pub fn closed(&self) -> bool {
        !self.open.load(Ordering::SeqCst)
    }

    pub async fn hello(&self, mut params: Map<String, Value>) -> Result<Value, RpcError> {
        params.insert("protocol".into(), json!(PROTOCOL));
        self.request("hello", params).await
    }

    pub async fn request(
        &self,
        method: &str,
        params: Map<String, Value>,
    ) -> Result<Value, RpcError> {
        if self.closed() {
            return Err(RpcError::new(
                ErrorCode::Unavailable,
                "hook connection closed",
            ));
        }
        let guard = self.core.clone().lock_owned().await;
        let mut result = Core::execute(
            self.core.clone(),
            guard,
            self.conn,
            method.to_owned(),
            params,
        )
        .await;
        if method == "hello"
            && let Ok(result) = &mut result
        {
            advertise(result);
        }
        result
    }

    pub async fn close(&self) {
        if self.open.swap(false, Ordering::SeqCst) {
            self.core.lock().await.disconnect(self.conn).await;
        }
    }
}

impl Drop for HookClient {
    fn drop(&mut self) {
        if self.open.swap(false, Ordering::SeqCst)
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let core = self.core.clone();
            let conn = self.conn;
            runtime.spawn(async move { core.lock().await.disconnect(conn).await });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Paths;
    use crate::proto::Limits;
    use crate::store::sqlite::SqliteStore;
    use std::future::Future;
    use std::path::PathBuf;
    use std::pin::Pin;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
    use tokio::sync::{Mutex as AsyncMutex, mpsc};

    type Mutate = Box<dyn Fn(&mut Value)>;
    type Run = Box<
        dyn Fn(
                HookParams,
                HookContext,
            ) -> Pin<Box<dyn Future<Output = Result<HookOutput, RpcError>> + Send>>
            + Send
            + Sync,
    >;

    struct TestHandler(Run);

    #[async_trait]
    impl HookHandler for TestHandler {
        async fn handle(
            &self,
            params: HookParams,
            context: HookContext,
        ) -> Result<HookOutput, RpcError> {
            (self.0)(params, context).await
        }
    }

    fn handler<F, Fut>(run: F) -> Arc<dyn HookHandler>
    where
        F: Fn(HookParams, HookContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<HookOutput, RpcError>> + Send + 'static,
    {
        Arc::new(TestHandler(Box::new(move |params, context| {
            Box::pin(run(params, context))
        })))
    }

    struct Broker {
        dir: PathBuf,
        core: SharedCore,
        _stop: watch::Sender<bool>,
        stopping: watch::Receiver<bool>,
    }

    impl Broker {
        async fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("scp-hooks-{:032x}", rand::random::<u128>()));
            tokio::fs::create_dir(&dir).await.expect("directory");
            let paths = Paths::new(dir.clone());
            let store = Arc::new(SqliteStore::open(&paths.database).expect("store"));
            let core = Core::new(store, Limits::default(), paths, dir.join("policy.json"))
                .await
                .expect("core");
            let (stop, stopping) = watch::channel(false);
            Self {
                dir,
                core: Arc::new(AsyncMutex::new(core)),
                _stop: stop,
                stopping,
            }
        }

        fn open(&self, hook: Option<Arc<dyn HookHandler>>) -> (Client, JoinHandle<()>) {
            let (server, client) = UnixStream::pair().expect("socket pair");
            let task = tokio::spawn(crate::server::serve_connection(
                server,
                self.core.clone(),
                self.stopping.clone(),
                hook,
            ));
            let (reader, writer) = client.into_split();
            (
                Client {
                    reader: BufReader::new(reader),
                    writer,
                },
                task,
            )
        }

        async fn cleanup(self) {
            let _ = tokio::fs::remove_dir_all(self.dir).await;
        }
    }

    struct Client {
        reader: BufReader<OwnedReadHalf>,
        writer: OwnedWriteHalf,
    }

    impl Client {
        async fn send(&mut self, frame: Value) {
            let mut bytes = serde_json::to_vec(&frame).expect("frame");
            bytes.push(b'\n');
            self.writer.write_all(&bytes).await.expect("write");
        }

        async fn next(&mut self) -> Value {
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(5), self.reader.read_line(&mut line))
                .await
                .expect("frame in time")
                .expect("read");
            serde_json::from_str(&line).expect("frame JSON")
        }

        async fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
            self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .await;
            self.next().await
        }

        async fn observe(&mut self, extra: Value) -> Value {
            let mut params = json!({"protocol": PROTOCOL, "observe": true});
            if let (Some(params), Some(extra)) = (params.as_object_mut(), extra.as_object()) {
                params.extend(extra.clone());
            }
            self.call(1, "hello", params).await
        }
    }

    fn params(ends: i64) -> Value {
        json!({
            "args": ["claude", "Stop"],
            "payload": {"hook_event_name": "Stop"},
            "env": {"HOME": "/tmp", "SCP_NAME": "worker"},
            "cwd": "/tmp",
            "origin": now_ms(),
            "ends": ends,
            "ppid": 4242,
            "procs": [{"pid": 4242, "ppid": 1, "start": "Mon-12:00", "args": "claude", "comm": "claude"}],
        })
    }

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    fn error(frame: &Value) -> (&str, &str) {
        (
            frame["error"]["data"]["code"].as_str().unwrap_or(""),
            frame["error"]["message"].as_str().unwrap_or(""),
        )
    }

    #[test]
    fn validate_accepts_well_formed_params() {
        let mut value = map(params(now_ms() + 5000));
        value.insert("harness_pid".into(), json!(77));
        let parsed = validate_hook(&value).expect("valid");
        assert_eq!(parsed.ppid, 4242);
        assert_eq!(parsed.harness_pid, Some(77));
        assert_eq!(parsed.procs[0].start.as_deref(), Some("Mon-12:00"));
        let mut float = map(params(now_ms() + 5000));
        float.insert("ppid".into(), json!(4242.0));
        float["procs"][0]["start"] = Value::Null;
        assert!(validate_hook(&float).is_ok());
    }

    #[test]
    fn validate_rejects_malformed_params() {
        let base = params(now_ms() + 5000);
        let cases: Vec<(&str, Mutate)> = vec![
            ("unknown key", Box::new(|v| v["extra"] = json!(1))),
            (
                "args not strings",
                Box::new(|v| v["args"] = json!(["a", 1])),
            ),
            (
                "missing args",
                Box::new(|v| {
                    if let Some(o) = v.as_object_mut() {
                        o.remove("args");
                    }
                }),
            ),
            ("payload array", Box::new(|v| v["payload"] = json!([]))),
            (
                "env value number",
                Box::new(|v| v["env"]["HOME"] = json!(1)),
            ),
            (
                "env key unknown",
                Box::new(|v| v["env"]["SECRET_TOKEN"] = json!("x")),
            ),
            ("cwd null", Box::new(|v| v["cwd"] = Value::Null)),
            ("origin string", Box::new(|v| v["origin"] = json!("now"))),
            (
                "ends missing",
                Box::new(|v| {
                    if let Some(o) = v.as_object_mut() {
                        o.remove("ends");
                    }
                }),
            ),
            ("ppid zero", Box::new(|v| v["ppid"] = json!(0))),
            ("ppid fraction", Box::new(|v| v["ppid"] = json!(1.5))),
            (
                "ppid unsafe",
                Box::new(|v| v["ppid"] = json!(9_007_199_254_740_992u64)),
            ),
            (
                "harness_pid null",
                Box::new(|v| v["harness_pid"] = Value::Null),
            ),
            ("procs object", Box::new(|v| v["procs"] = json!({}))),
            (
                "too many procs",
                Box::new(|v| {
                    v["procs"] = Value::Array((1..=65).map(|pid| json!({"pid": pid + 5000, "ppid": 1, "start": null, "args": ""})).collect());
                }),
            ),
            (
                "proc unknown key",
                Box::new(|v| v["procs"][0]["env"] = json!({})),
            ),
            (
                "proc duplicate pid",
                Box::new(|v| {
                    let first = v["procs"][0].clone();
                    if let Some(p) = v["procs"].as_array_mut() {
                        p.push(first);
                    }
                }),
            ),
            (
                "proc negative ppid",
                Box::new(|v| v["procs"][0]["ppid"] = json!(-1)),
            ),
            (
                "proc start missing",
                Box::new(|v| {
                    if let Some(o) = v["procs"][0].as_object_mut() {
                        o.remove("start");
                    }
                }),
            ),
            (
                "proc start bad chars",
                Box::new(|v| v["procs"][0]["start"] = json!("Mon 12:00")),
            ),
            (
                "proc start empty",
                Box::new(|v| v["procs"][0]["start"] = json!("")),
            ),
            (
                "proc start long",
                Box::new(|v| v["procs"][0]["start"] = json!("a".repeat(65))),
            ),
            (
                "proc args number",
                Box::new(|v| v["procs"][0]["args"] = json!(1)),
            ),
            (
                "proc comm null",
                Box::new(|v| v["procs"][0]["comm"] = Value::Null),
            ),
            (
                "parent without comm",
                Box::new(|v| {
                    if let Some(o) = v["procs"][0].as_object_mut() {
                        o.remove("comm");
                    }
                }),
            ),
        ];
        for (name, mutate) in cases {
            let mut value = base.clone();
            mutate(&mut value);
            let error = validate_hook(&map(value)).expect_err(name);
            assert_eq!(error.code, -32602, "{name}");
            assert_eq!(error.message, "malformed hook params", "{name}");
        }
    }

    #[tokio::test]
    async fn capability_and_method_only_with_handler() {
        let broker = Broker::new().await;
        let (mut plain, _task) = broker.open(None);
        let hello = plain.observe(json!({})).await;
        let capabilities = hello["result"]["capabilities"]
            .as_array()
            .expect("capabilities");
        assert!(!capabilities.iter().any(|c| c == "hook"));
        let refused = plain.call(2, "hook", params(now_ms() + 5000)).await;
        assert!(refused.get("error").is_some());

        let ok = handler(|_, _| async { Ok(HookOutput::default()) });
        let (mut hooked, _task) = broker.open(Some(ok));
        let hello = hooked.observe(json!({})).await;
        let capabilities = hello["result"]["capabilities"]
            .as_array()
            .expect("capabilities");
        assert!(capabilities.iter().any(|c| c == "hook"));
        broker.cleanup().await;
    }

    #[tokio::test]
    async fn hook_requires_plain_observer_and_valid_params() {
        let broker = Broker::new().await;
        let ok = handler(|_, _| async { Ok(HookOutput::default()) });
        let (mut unbound, _task) = broker.open(Some(ok.clone()));
        let refused = unbound.call(2, "hook", params(now_ms() + 5000)).await;
        assert_eq!(
            error(&refused),
            ("unauthorized", "hook requires a plain observer")
        );
        let refused = unbound.call(3, "hook_commit", json!({"commit": "x"})).await;
        assert_eq!(
            error(&refused),
            ("unauthorized", "hook requires a plain observer")
        );

        let (mut claimed, _task) = broker.open(Some(ok.clone()));
        let hello = claimed
            .observe(json!({"claim": {"handle": "someone"}}))
            .await;
        assert!(hello["result"]["endpoint"].is_null());
        let refused = claimed.call(2, "hook", params(now_ms() + 5000)).await;
        assert_eq!(
            error(&refused),
            ("unauthorized", "hook requires a plain observer")
        );

        let (mut observer, _task) = broker.open(Some(ok));
        observer.observe(json!({})).await;
        let mut bad = params(now_ms() + 5000);
        bad["env"]["SECRET_TOKEN"] = json!("x");
        let refused = observer.call(2, "hook", bad).await;
        assert_eq!(error(&refused), ("invalid_params", "malformed hook params"));
        let refused = observer.call(3, "hook_commit", json!({"commit": 1})).await;
        assert_eq!(error(&refused), ("invalid_params", "commit is a string"));
        let refused = observer
            .call(4, "hook_commit", json!({"commit": "x", "more": true}))
            .await;
        assert_eq!(error(&refused), ("invalid_params", "commit is a string"));
        let unknown = observer
            .call(5, "hook_commit", json!({"commit": "nope"}))
            .await;
        assert_eq!(unknown["result"], json!({}));
        let done = observer.call(6, "hook", params(now_ms() + 5000)).await;
        assert_eq!(done["result"], json!({"exit": 0}));
        broker.cleanup().await;
    }

    #[tokio::test]
    async fn deadline_notification_precedes_result() {
        let broker = Broker::new().await;
        let moved = now_ms() + 60_000;
        let notifying = handler(move |params, context| async move {
            assert_eq!(params.args, vec!["claude", "Stop"]);
            context.notify(moved);
            Ok(HookOutput {
                stdout: Some("shown".into()),
                stderr: Some("note".into()),
            })
        });
        let (mut client, _task) = broker.open(Some(notifying));
        client.observe(json!({})).await;
        client
            .send(json!({"jsonrpc":"2.0","id":2,"method":"hook","params":params(now_ms() + 5000)}))
            .await;
        let notification = client.next().await;
        assert_eq!(
            notification,
            json!({"jsonrpc":"2.0","method":"hook_deadline","params":{"ends": moved}})
        );
        let result = client.next().await;
        assert_eq!(result["id"], 2);
        assert_eq!(
            result["result"],
            json!({"stdout":"shown","stderr":"note","exit":0})
        );
        broker.cleanup().await;
    }

    #[tokio::test]
    async fn commit_confirms_print() {
        let broker = Broker::new().await;
        let (seen, mut printed) = mpsc::unbounded_channel();
        let printing = handler(move |_, context| {
            let seen = seen.clone();
            async move {
                let shown = context.print("rendered").await;
                let _ = seen.send(shown);
                Ok(HookOutput::default())
            }
        });
        let (mut client, _task) = broker.open(Some(printing));
        client.observe(json!({})).await;
        let result = client.call(2, "hook", params(now_ms() + 5000)).await;
        assert_eq!(result["result"]["stdout"], "rendered");
        assert_eq!(result["result"]["exit"], 0);
        let token = result["result"]["commit"].as_str().expect("commit token");
        assert_eq!(token.len(), 48);
        assert!(printed.try_recv().is_err());
        let committed = client
            .call(3, "hook_commit", json!({"commit": token}))
            .await;
        assert_eq!(committed["result"], json!({}));
        assert_eq!(printed.try_recv(), Ok(true));
        let again = client
            .call(4, "hook_commit", json!({"commit": token}))
            .await;
        assert_eq!(again["result"], json!({}));
        broker.cleanup().await;
    }

    #[tokio::test]
    async fn expiry_cancels_a_running_hook() {
        let broker = Broker::new().await;
        let waiting = handler(|_, context| async move {
            while !context.closed() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let shown = context.print("late").await;
            Ok(HookOutput {
                stdout: Some(format!("printed={shown}")),
                stderr: None,
            })
        });
        let (mut client, _task) = broker.open(Some(waiting));
        client.observe(json!({})).await;
        let result = client.call(2, "hook", params(now_ms() + 100)).await;
        assert_eq!(result["result"], json!({"stdout":"printed=false","exit":0}));
        broker.cleanup().await;
    }

    #[tokio::test]
    async fn close_mid_hook_releases_handlers() {
        let broker = Broker::new().await;
        let (seen, mut outcome) = mpsc::unbounded_channel();
        let waiting = {
            let seen = seen.clone();
            handler(move |_, context| {
                let seen = seen.clone();
                async move {
                    while !context.closed() {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    let _ = seen.send(("waiting", context.print("gone").await));
                    Ok(HookOutput::default())
                }
            })
        };
        let (mut client, task) = broker.open(Some(waiting));
        client.observe(json!({})).await;
        client
            .send(
                json!({"jsonrpc":"2.0","id":2,"method":"hook","params":params(now_ms() + 60_000)}),
            )
            .await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(client);
        let closed = tokio::time::timeout(Duration::from_secs(5), outcome.recv())
            .await
            .expect("handler saw close");
        assert_eq!(closed, Some(("waiting", false)));
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("connection finishes")
            .expect("connection task");

        let printing = handler(move |_, context| {
            let seen = seen.clone();
            async move {
                let _ = seen.send(("offered", context.print("unconfirmed").await));
                Ok(HookOutput::default())
            }
        });
        let (mut client, task) = broker.open(Some(printing));
        client.observe(json!({})).await;
        let result = client.call(2, "hook", params(now_ms() + 60_000)).await;
        assert!(result["result"]["commit"].is_string());
        drop(client);
        let closed = tokio::time::timeout(Duration::from_secs(5), outcome.recv())
            .await
            .expect("offer released on close");
        assert_eq!(closed, Some(("offered", false)));
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("connection finishes")
            .expect("connection task");
        broker.cleanup().await;
    }

    #[tokio::test]
    async fn context_connects_to_the_core() {
        let broker = Broker::new().await;
        let (seen, mut outcome) = mpsc::unbounded_channel();
        let connecting = handler(move |_, context| {
            let seen = seen.clone();
            async move {
                let client = context.connect().await;
                let hello = client
                    .hello(map(json!({"claim": {"handle": "rendered"}})))
                    .await?;
                let _ = seen.send(hello["endpoint"]["address"].clone());
                client.close().await;
                let closed = client.request("whoami", Map::new()).await;
                let _ = seen.send(json!(closed.is_err()));
                Ok(HookOutput::default())
            }
        });
        let (mut client, _task) = broker.open(Some(connecting));
        client.observe(json!({})).await;
        let result = client.call(2, "hook", params(now_ms() + 5000)).await;
        assert_eq!(result["result"], json!({"exit": 0}));
        assert_eq!(outcome.recv().await, Some(json!("me/rendered")));
        assert_eq!(outcome.recv().await, Some(json!(true)));
        broker.cleanup().await;
    }
}
