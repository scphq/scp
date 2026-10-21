//! Per-account hub boundary. The transport owns socket I/O; account logic receives
//! grants and bounded socket handles. AccountHub serializes RPC and socket calls.
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use scp_relay_store::{CredentialLookup, RelayStore, Role};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, Notify, mpsc, watch};

/// Trusted authentication context passed to account logic.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub token_id: String,
    pub user_id: String,
    pub actor_id: String,
    pub role: Role,
    pub scoped: bool,
    pub labels: BTreeMap<String, String>,
    pub expires_at: i64,
    pub account: String,
}
/// Bounded socket output handle. A full queue requests closure with 1013.
#[derive(Clone)]
pub struct SocketHandle {
    texts: mpsc::Sender<String>,
    close: watch::Sender<Option<Closure>>,
}
#[derive(Clone)]
struct Closure {
    code: u16,
    reason: String,
    notification: Option<String>,
}
enum Output {
    Text(String),
    Close(Closure),
}
impl SocketHandle {
    /// Queue a text frame. Returns false after closure or on overload.
    pub fn send(&self, text: String) -> bool {
        if self.close.borrow().is_some() {
            return false;
        }
        match self.texts.try_send(text) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.close(1013, "slow client");
                false
            }
            Err(_) => false,
        }
    }
    /// Queue a text frame, waiting up to 10 s for room; a client that drains no faster is closed 1013.
    async fn send_wait(&self, text: String) -> bool {
        let mut closing = self.close.subscribe();
        tokio::select! { biased;
            _ = closing.wait_for(|v| v.is_some()) => false,
            result = self.texts.send(text) => result.is_ok(),
            _ = tokio::time::sleep(Duration::from_secs(10)) => {
                self.close(1013, "slow client");
                false
            }
        }
    }
    /// Ask the dedicated writer to close with a protocol code.
    pub fn close(&self, code: u16, reason: &str) {
        self.finish(Closure {
            code,
            reason: reason.into(),
            notification: None,
        });
    }
    fn frame_too_large(&self, cap: usize) {
        self.finish(Closure { code: 1009, reason: "frame too large".into(), notification: Some(json!({"jsonrpc":"2.0","id":null,"error":Error::new("too_large", &format!("a frame is at most {cap} bytes")).wire()}).to_string()) });
    }
    fn finish(&self, closure: Closure) {
        self.close.send_if_modified(|current| {
            if current.is_some() {
                false
            } else {
                *current = Some(closure);
                true
            }
        });
    }
}
mod activity;
mod bridge;
mod client;
mod guards;
mod hello;
mod limits;
mod machines;
mod mirror;
mod notify;
mod receipts;
mod scope;
mod send;
mod sweep;
mod validation;
mod wake;
pub use wake::WakeOptions;
pub mod xacct;
mod xcounters;
use crate::iso;
use scp_relay_store::{Endpoint, HubWrite};
use validation::{Error, Result, fields, invalid, string, text};

#[derive(Clone, Default)]
struct Connection {
    grant: Option<Grant>,
    socket: Option<SocketHandle>,
    role: String,
    machine: String,
    endpoint: String,
    watching: bool,
    subscribed: bool,
    tty: bool,
}
struct SyncState {
    id: String,
    parts: u64,
    next: u64,
    seen: std::collections::HashSet<String>,
}
/// Account-local state serialized behind one asynchronous lock.
pub struct AccountHub {
    account_id: String,
    handle: String,
    store: Arc<dyn RelayStore>,
    connections: HashMap<String, Connection>,
    syncs: HashMap<String, SyncState>,
    broken_syncs: std::collections::VecDeque<(String, String)>,
    limits: crate::http::Limits,
    initialized: bool,
    gate: Arc<dyn xacct::Gate>,
    xcounters: xcounters::Counters,
    xkey: Option<String>,
    buckets: HashMap<String, limits::Bucket>,
    refusals: HashMap<String, limits::Refusals>,
    sockets: Arc<AtomicUsize>,
    revalidation_errors: HashMap<String, i64>,
    wake_options: WakeOptions,
    owner: std::sync::Weak<Mutex<AccountHub>>,
}
impl AccountHub {
    async fn initialize(&mut self) -> Result<()> {
        if self.initialized {
            return Ok(());
        }
        let mut changes = HubWrite::default();
        for mut e in self.store.endpoints(&self.account_id, None).await? {
            let mut f = fields(&e);
            if f["presence"] != "hibernated" {
                f["presence"] = json!("offline");
            }
            e.fields = f.to_string();
            changes.endpoints.push(e);
        }
        self.store.hub_write(&self.account_id, changes).await?;
        self.initialized = true;
        Ok(())
    }
    async fn dispatch(&mut self, id: &str, method: &str, p: &Value) -> Result<xacct::Dispatch> {
        self.initialize().await?;
        let conn = self
            .connections
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("unauthorized", "connection closed"))?;
        self.refuse_denied(id, &conn).await?;
        self.spend(id, &conn, method, p, crate::now_ms()).await?;
        if !p.is_object() {
            return Err(invalid("params must be an object"));
        }
        self.dispatch_inner(id, &conn, method, p).await
    }
    async fn dispatch_inner(
        &mut self,
        id: &str,
        conn: &Connection,
        method: &str,
        p: &Value,
    ) -> Result<xacct::Dispatch> {
        if method == "hello" {
            return self.hello(id, conn, p).await.map(xacct::Dispatch::Done);
        }
        if conn.role.is_empty() {
            return Err(Error::new("unauthorized", "call hello first"));
        }
        if !conn.endpoint.is_empty()
            && let Some(mut endpoint) = self
                .endpoints()
                .await?
                .into_iter()
                .find(|e| e.id == conn.endpoint)
            && endpoint
                .last_seen
                .is_none_or(|at| at <= crate::now_ms() - 10_000)
        {
            endpoint.last_seen = Some(crate::now_ms());
            self.store.put_endpoint(&self.account_id, endpoint).await?;
        }
        if method == "list" && p["contacts"] == true {
            return Ok(xacct::Dispatch::List(
                self.store
                    .contacts(&self.account_id)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|c| c.config.dir != "in")
                    .collect(),
            ));
        }
        if conn.role == "bridge" && method == "forward" && self.has_foreign(&p["params"]["to"]) {
            return self.xforward(conn, p).await;
        }
        let result = if conn.role == "bridge" {
            self.bridge_method(id, conn, method, p).await
        } else {
            self.client_method(id, conn, method, p).await
        };
        result.map(xacct::Dispatch::Done)
    }
    async fn endpoints(&self) -> Result<Vec<Endpoint>> {
        Ok(self.store.endpoints(&self.account_id, None).await?)
    }
    fn account_name(&self) -> &str {
        &self.handle
    }
}
/// Account registry shared by both transports.
pub struct Hub {
    accounts: Mutex<HashMap<String, Arc<Mutex<AccountHub>>>>,
    store: Arc<dyn RelayStore>,
    limits: crate::http::Limits,
    shutdown: watch::Sender<bool>,
    active: AtomicUsize,
    drained: Notify,
    gate: Arc<dyn xacct::Gate>,
    wake_options: WakeOptions,
}
/// Tracks an accepted upgrade until its socket task has finished.
pub struct SocketLease(Arc<Hub>, Arc<AtomicUsize>);
impl Drop for SocketLease {
    fn drop(&mut self) {
        self.1.fetch_sub(1, Ordering::AcqRel);
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_one();
        }
    }
}
struct RpcConnection {
    account: Arc<Mutex<AccountHub>>,
    id: String,
    active: bool,
}
impl Drop for RpcConnection {
    fn drop(&mut self) {
        if self.active {
            let account = self.account.clone();
            let id = self.id.clone();
            tokio::spawn(async move {
                account.lock().await.closed(&id, false).await;
            });
        }
    }
}
impl Hub {
    /// Construct a registry over a single-process store.
    pub fn new(store: Arc<dyn RelayStore>, limits: crate::http::Limits) -> Self {
        let (shutdown, _) = watch::channel(false);
        Self {
            accounts: Mutex::new(HashMap::new()),
            store,
            limits,
            shutdown,
            active: AtomicUsize::new(0),
            drained: Notify::new(),
            gate: Arc::new(xacct::PassGate),
            wake_options: WakeOptions::default(),
        }
    }
    /// Construct a registry with host-supplied cross-account gates.
    pub fn with_gate(
        store: Arc<dyn RelayStore>,
        limits: crate::http::Limits,
        gate: Arc<dyn xacct::Gate>,
    ) -> Self {
        Self {
            gate,
            ..Self::new(store, limits)
        }
    }
    /// Configure machine webhook calls for every account.
    pub fn with_wake(mut self, options: WakeOptions) -> Self {
        self.wake_options = options;
        self
    }
    /// Clear machine wake holds and wake eligible queued mail. This is a host API.
    pub async fn clear_wake_hold(
        &self,
        account: &scp_relay_store::Account,
        machine: Option<&str>,
    ) -> std::result::Result<usize, Value> {
        let hub = self.account_by_id(&account.id, &account.handle).await;
        let local = hub.lock().await;
        let cleared = local
            .forget_wake_hold(machine)
            .await
            .map_err(|e| e.wire())?;
        for name in &cleared {
            if local.wake_queued(name, true).await.is_err() {
                tracing::warn!("queued machine wake unavailable");
            }
        }
        Ok(cleared.len())
    }
    async fn account(&self, grant: &Grant) -> Arc<Mutex<AccountHub>> {
        self.account_by_id(&grant.user_id, &grant.account).await
    }
    async fn account_by_id(&self, id: &str, handle: &str) -> Arc<Mutex<AccountHub>> {
        let mut accounts = self.accounts.lock().await;
        accounts
            .entry(id.to_owned())
            .or_insert_with(|| {
                Arc::new_cyclic(|owner| {
                    Mutex::new(AccountHub {
                        account_id: id.to_owned(),
                        handle: handle.to_owned(),
                        store: self.store.clone(),
                        connections: HashMap::new(),
                        syncs: HashMap::new(),
                        broken_syncs: std::collections::VecDeque::new(),
                        limits: self.limits.clone(),
                        initialized: false,
                        gate: self.gate.clone(),
                        xcounters: xcounters::Counters::default(),
                        xkey: None,
                        buckets: HashMap::new(),
                        refusals: HashMap::new(),
                        sockets: Arc::new(AtomicUsize::new(0)),
                        revalidation_errors: HashMap::new(),
                        wake_options: self.wake_options.clone(),
                        owner: owner.clone(),
                    })
                })
            })
            .clone()
    }
    /// Sweep account retention and idle bindings until server shutdown.
    pub async fn maintain(self: Arc<Self>) {
        let mut shutdown = self.shutdown.subscribe();
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                _ = interval.tick() => {
                    if self.store.purge_device_codes(crate::now_ms()).await.is_err() {
                        tracing::warn!("device code sweep unavailable");
                    }
                    match self.store.wake_accounts().await {
                        Ok(accounts) => for account in accounts { self.account_by_id(&account.id, &account.handle).await; },
                        Err(_) => tracing::warn!("wake account recovery unavailable"),
                    }
                    let accounts: Vec<_> = self.accounts.lock().await.values().cloned().collect();
                    for account in accounts {
                        let mut hub = account.lock().await;
                        if hub.initialize().await.is_err() || hub.sweep().await.is_err() { tracing::warn!("hub sweep unavailable"); }
                    }
                }
            }
        }
    }
    /// Process an authenticated HTTP request, including batches in input order.
    pub async fn rpc(&self, grant: Grant, body: Value) -> Value {
        if let Some(cap) = self.limits.cap("frameBytes")
            && body.to_string().encode_utf16().count() as u64 > cap
        {
            return json!({"jsonrpc":"2.0","id":null,"error":Error::new("too_large", &format!("a request is at most {cap} bytes")).wire()});
        }
        if body.as_array().is_some_and(Vec::is_empty) {
            return json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"an empty batch"}});
        }
        let account = self.account(&grant).await;
        let id = crate::random("http_");
        {
            let mut hub = account.lock().await;
            hub.connections.insert(
                id.clone(),
                Connection {
                    grant: Some(grant),
                    ..Connection::default()
                },
            );
        }
        let mut cleanup = RpcConnection {
            account: account.clone(),
            id: id.clone(),
            active: true,
        };
        let batch = body.is_array();
        let requests = match body {
            Value::Array(v) => v,
            v => vec![v],
        };
        let mut replies = Vec::new();
        for request in requests {
            let reply = self.call(&account, &id, request, true).await;
            if !reply.is_null() {
                replies.push(reply);
            }
        }
        for reply in &replies {
            self.ack_response(&account, &id, reply).await;
        }
        account.lock().await.closed(&id, false).await;
        cleanup.active = false;
        if batch {
            json!(replies)
        } else {
            replies.into_iter().next().unwrap_or(Value::Null)
        }
    }
    async fn call(
        &self,
        account: &Arc<Mutex<AccountHub>>,
        connection: &str,
        request: Value,
        http: bool,
    ) -> Value {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = string(&request, "method");
        let p = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if !request.is_object() {
            let mut error = invalid(if http {
                "a request is an object"
            } else {
                "one JSON-RPC request per frame"
            })
            .wire();
            error["code"] = json!(-32600);
            return json!({"jsonrpc":"2.0","id":if id.is_number()||id.is_string(){id}else{Value::Null},"error":error});
        }
        let notification = request.get("id").is_none();
        let result = if *self.shutdown.borrow() {
            Err(Error::new("unauthorized", "relay is stopping"))
        } else {
            self.execute(account, connection, method, &p).await
        };
        let result = match result {
            Ok(mut value) if matches!(method, "inbox" | "ask" | "ask_wait") => {
                let limit = if http {
                    self.limits.duration("httpWaitS", 25)
                } else {
                    50
                };
                let wait = p
                    .get("wait_s")
                    .map_or(Some(0.0), Value::as_f64)
                    .unwrap_or(f64::NAN);
                if !wait.is_finite() || wait < 0.0 {
                    Err(invalid("wait_s must be a number of seconds"))
                } else {
                    let now = tokio::time::Instant::now();
                    let deadline = now
                        .checked_add(
                            Duration::try_from_secs_f64(wait.min(limit as f64))
                                .unwrap_or(Duration::from_secs(u32::MAX as u64)),
                        )
                        .unwrap_or(now);
                    let sent = if method == "ask" {
                        Some(value.clone())
                    } else {
                        None
                    };
                    let query = if let Some(sent) = &sent {
                        json!({"id":sent["id"]})
                    } else {
                        p.clone()
                    };
                    let query_method = if method == "ask" { "ask_wait" } else { method };
                    if method == "ask" {
                        value = match self.poll(account, connection, query_method, &query).await {
                            Ok(value) => value,
                            Err(e) => return json!({"jsonrpc":"2.0","id":id,"error":e.wire()}),
                        };
                    }
                    loop {
                        if *self.shutdown.borrow() {
                            break Err(Error::new("unauthorized", "relay is stopping"));
                        }
                        let empty = if query_method == "inbox" {
                            value["messages"].as_array().is_none_or(Vec::is_empty)
                        } else {
                            value["reply"].is_null()
                        };
                        if !empty
                            || value["expired"] == true
                            || tokio::time::Instant::now() >= deadline
                        {
                            if let Some(sent) = &sent
                                && let (Some(out), Some(sent)) =
                                    (value.as_object_mut(), sent.as_object())
                            {
                                for (key, v) in sent {
                                    out.entry(key.clone()).or_insert_with(|| v.clone());
                                }
                            }
                            break Ok(value);
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        match self.poll(account, connection, query_method, &query).await {
                            Ok(v) => value = v,
                            Err(e) => break Err(e),
                        }
                    }
                }
            }
            other => other,
        };
        if notification {
            return Value::Null;
        }
        match result {
            Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
            Err(e) => json!({"jsonrpc":"2.0","id":id,"error":e.wire()}),
        }
    }
    async fn ack_response(&self, account: &Arc<Mutex<AccountHub>>, id: &str, response: &Value) {
        let Some(seq) = response["result"]["reply"]["seq"].as_i64() else {
            return;
        };
        for attempt in 0..3 {
            let result = {
                let hub = account.lock().await;
                let Some(c) = hub.connections.get(id) else {
                    return;
                };
                hub.ack(c, &json!({"seqs":[seq]})).await
            };
            if result.is_ok() {
                return;
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(25 << attempt)).await;
            }
        }
        tracing::warn!("reply acknowledgement unavailable");
    }
    /// Register an upgrade before returning HTTP 101, including pending upgrades.
    pub async fn track(self: &Arc<Self>, grant: &Grant) -> Option<SocketLease> {
        let account = self.account(grant).await;
        let hub = account.lock().await;
        let count = hub.sockets.load(Ordering::Acquire);
        if hub
            .limits
            .cap("sockets")
            .is_some_and(|cap| count as u64 >= cap)
        {
            return None;
        }
        hub.sockets.fetch_add(1, Ordering::AcqRel);
        self.active.fetch_add(1, Ordering::AcqRel);
        Some(SocketLease(self.clone(), hub.sockets.clone()))
    }
    /// Wait for accepted socket tasks to finish after shutdown is signaled.
    pub async fn wait_closed(&self) {
        loop {
            let notified = self.drained.notified();
            if self.active.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
    /// Signal all socket writer tasks to close with 1001.
    pub fn shutdown(&self) {
        self.shutdown.send_replace(true);
    }
    /// Attach an authenticated WebSocket. Output has a fixed 32-frame bound.
    pub async fn websocket(
        self: Arc<Self>,
        grant: Grant,
        socket: WebSocket,
        frame_bytes: usize,
        revalidate_ms: u64,
    ) {
        let account = self.account(&grant).await;
        let (mut sink, mut stream) = socket.split();
        let (texts, mut rx) = mpsc::channel::<String>(32);
        let (close, mut closing) = watch::channel::<Option<Closure>>(None);
        let handle = SocketHandle { texts, close };
        let socket_id = crate::random("socket_");
        {
            let mut hub = account.lock().await;
            hub.connections.insert(
                socket_id.clone(),
                Connection {
                    grant: Some(grant.clone()),
                    socket: Some(handle.clone()),
                    ..Connection::default()
                },
            );
        }
        let mut shutdown = self.shutdown.subscribe();
        let mut writer = tokio::spawn(async move {
            loop {
                let output = tokio::select! { biased;
                    _ = shutdown.wait_for(|v| *v) => Some(Output::Close(Closure { code: 1001, reason: "server shutdown".into(), notification: None })),
                    changed = closing.changed() => {
                        if changed.is_err() { return; }
                        let value = closing.borrow().clone();
                        value.map(Output::Close)
                    },
                    text = rx.recv() => text.map(Output::Text),
                };
                let Some(output) = output else {
                    return;
                };
                let (message, terminal) = match output {
                    Output::Text(text) => (Message::Text(text.into()), false),
                    Output::Close(closure) => {
                        if let Some(notification) = closure.notification
                            && !matches!(
                                tokio::time::timeout(
                                    Duration::from_secs(2),
                                    sink.send(Message::Text(notification.into()))
                                )
                                .await,
                                Ok(Ok(()))
                            )
                        {
                            return;
                        }
                        (
                            Message::Close(Some(CloseFrame {
                                code: closure.code,
                                reason: closure.reason.into(),
                            })),
                            true,
                        )
                    }
                };
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(2), sink.send(message)).await,
                    Ok(Ok(()))
                ) {
                    return;
                }
                if terminal {
                    return;
                }
            }
        });
        let expires = Duration::from_millis(
            u64::try_from(grant.expires_at.saturating_sub(crate::now_ms())).unwrap_or(0),
        );
        let expiry = tokio::time::sleep(expires);
        tokio::pin!(expiry);
        let revalidate = tokio::time::sleep(Duration::from_millis(revalidate_ms.max(1)));
        tokio::pin!(revalidate);
        let mut writer_finished = false;
        let mut polls = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _=&mut writer=>{writer_finished=true;break;},
                _=&mut expiry=>{account.lock().await.kick(&socket_id, "the token grant expired, reconnect", 4001).await;break;},
                _=&mut revalidate=>{
                    let now = crate::now_ms();
                    let result = self.store.credential_by_id(&grant.token_id, now).await;
                    let retry = account.lock().await.revalidated(&socket_id, result, now).await;
                    if handle.close.borrow().is_some() { break; }
                    let delay = limits::revalidate_delay(revalidate_ms, retry);
                    revalidate.as_mut().reset(tokio::time::Instant::now() + delay);
                },
                _=polls.join_next(), if !polls.is_empty()=>{},
                incoming=stream.next()=>match incoming {
                    Some(Ok(Message::Text(text)))=>{
                        if text.len()>frame_bytes {handle.frame_too_large(frame_bytes);break;}
                        let body = match serde_json::from_str::<Value>(&text) {
                            Ok(body) => body,
                            Err(_) => {handle.send(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse_error"}}).to_string());continue;}
                        };
                        if matches!(string(&body,"method"),"inbox"|"ask"|"ask_wait") && body["params"]["wait_s"].as_f64().is_some_and(|s|s>0.0) {
                            if polls.len() >= 32 {handle.close(1013,"too many pending requests");break;}
                            let hub = self.clone();let account = account.clone();let id = socket_id.clone();let output = handle.clone();
                            polls.spawn(async move {let response=hub.call(&account,&id,body,false).await;if !response.is_null() && output.send(response.to_string()) {hub.ack_response(&account,&id,&response).await;}});
                            continue;
                        }
                        let replay = string(&body, "method") == "subscribe";
                        let response=self.call(&account,&socket_id,body,false).await;
                        if !response.is_null() {
                            let sent = if replay { handle.send_wait(response.to_string()).await } else { handle.send(response.to_string()) };
                            if !sent { break; }
                            self.ack_response(&account, &socket_id, &response).await;
                        }
                    },
                    Some(Ok(Message::Binary(_)))=>{handle.send(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"text frames required","data":{"code":"invalid_params"}}}).to_string());},
                    Some(Ok(Message::Close(_)))|None=>{handle.close(1000,"closed");break;},
                    Some(Err(_))=>{handle.frame_too_large(frame_bytes);break;},
                    _=>{},
                }
            }
        }
        polls.abort_all();
        if !writer_finished {
            let _ = writer.await;
        }
        account.lock().await.closed(&socket_id, false).await;
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    #[test]
    fn full_queue_closes_slow_socket() {
        let (texts, _receiver) = mpsc::channel(32);
        let (close, reason) = watch::channel(None);
        let socket = SocketHandle { texts, close };
        for _ in 0..32 {
            assert!(socket.send("frame".into()));
        }
        assert!(!socket.send("overflow".into()));
        assert_eq!(reason.borrow().as_ref().map(|c| c.code), Some(1013));
        assert!(!socket.send("closed".into()));
    }
}

#[cfg(test)]
#[path = "hub/tests.rs"]
mod tests;
