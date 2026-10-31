//! The hub socket: hello, the full mirror, watch and subscribe; deltas out, endpoints and deliveries in.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use scp_core::protocol::{ErrorCode, PROTOCOL};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use super::route::{Injected, refusal_code};
use super::{BridgeConfig, LocalDelivery};
use crate::core::{Core, SharedCore, now_ms, text, timestamp};
use crate::proto::RpcError;
use crate::store::Row;

/// the endpoints one mirrorNow frame carries
const MIRROR_NOW_BATCH: usize = 32;
/// local deliveries waiting for the next batch; past this, new ones are dropped until it is sent
const LOCAL_BUFFER: usize = 1000;
const LOCAL_PER_FRAME: usize = 200;
const LOCAL_RECIPIENTS: usize = 64;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// room left in the hub's frame for the JSON-RPC envelope around a mirror's endpoints
pub const MIRROR_FRAME_BYTES: usize = 262_144 - 1024;
/// an inject that fails this many times in a row is rejected to the hub as a dead letter
const DEAD_LETTER_ATTEMPTS: u32 = 3;
const RECONCILE_EVERY: Duration = Duration::from_secs(2);

fn log(line: &str) {
    eprintln!("{line}");
}

fn id_hash(id: &str) -> String {
    hex::encode(Sha256::digest(id.as_bytes()))[..32].to_owned()
}

/// the handle an address ends in ("" for a human's `<...>/`)
pub fn handle_in(address: &str) -> &str {
    address.rsplit('/').next().unwrap_or("")
}

/// `<origin>/v1/relay/ws` with ws or wss
pub fn relay_socket_url(origin: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(origin).map_err(|e| e.to_string())?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .map_err(|_| "not a hub URL".to_owned())?;
    url.set_path("/v1/relay/ws");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

/// the reconnect wait after `attempt` failures: half the backoff plus up to half again at random
pub fn backoff(min: Duration, max: Duration, attempt: u32, random: f64) -> Duration {
    let base = (min.as_secs_f64() * 2f64.powi(attempt.min(16) as i32)).min(max.as_secs_f64());
    Duration::from_secs_f64(base / 2.0 + random * (base / 2.0))
}

/// what a peer can still reach: not offline, a human, active within historicAfterS, or woken by a message
pub fn reachable(view: &Value) -> bool {
    view["kind"] != "agent"
        || view["presence"] != "offline"
        || view["historic"] != true
        || view["revivable"] == true
        || !matches!(view.get("wake"), None | Some(Value::Null)) && view["wake"] != "none"
}

/// the frames a full mirror goes out in, each within the hub's frame; several share a sync and only the first keeps `full`
pub fn mirror_frames(views: Vec<Value>, sync_id: &str) -> Result<Vec<Value>, RpcError> {
    let mut frames: Vec<Vec<Value>> = vec![Vec::new()];
    let mut bytes = 0;
    for view in views {
        let size = view.to_string().len() + 1;
        if size > MIRROR_FRAME_BYTES {
            return Err(RpcError::new(
                ErrorCode::TooLarge,
                format!(
                    "{} mirrors {size} bytes, over the hub's {MIRROR_FRAME_BYTES} byte frame",
                    view["address"].as_str().unwrap_or("")
                ),
            ));
        }
        if bytes + size > MIRROR_FRAME_BYTES {
            frames.push(Vec::new());
            bytes = 0;
        }
        if let Some(last) = frames.last_mut() {
            last.push(view);
        }
        bytes += size;
    }
    if frames.len() == 1 {
        return Ok(vec![
            json!({"endpoints": frames.pop().unwrap_or_default(), "full": true}),
        ]);
    }
    let parts = frames.len();
    Ok(frames
        .into_iter()
        .enumerate()
        .map(|(i, endpoints)| json!({"endpoints": endpoints, "full": i == 0, "sync": {"id": sync_id, "part": i + 1, "parts": parts}}))
        .collect())
}

fn fingerprint(view: &Value) -> String {
    let mut view = view.clone();
    if let Some(map) = view.as_object_mut() {
        map.remove("last_seen");
        map.remove("active_at");
    }
    view.to_string()
}

struct Failure {
    error: RpcError,
    hub: bool,
}

impl Failure {
    fn link(message: impl Into<String>) -> Self {
        Self {
            error: RpcError::new(ErrorCode::Unavailable, message),
            hub: false,
        }
    }
    fn code(&self) -> Option<ErrorCode> {
        refusal_code(&self.error)
    }
}

fn hub_error(error: &Value) -> RpcError {
    let message = error["message"]
        .as_str()
        .unwrap_or("the hub refused")
        .to_owned();
    let code = error["data"]["code"]
        .as_str()
        .and_then(|c| c.parse::<ErrorCode>().ok())
        .unwrap_or(ErrorCode::Unavailable);
    let mut out = RpcError::new(code, message);
    if let (Some(data), Some(retry)) = (out.data.as_mut(), error["data"].get("retry_after")) {
        data.extra.insert("retry_after".into(), retry.clone());
    }
    out
}

fn retry_after(error: &RpcError) -> Option<f64> {
    error.data.as_ref()?.extra.get("retry_after")?.as_f64()
}

enum Command {
    Changed(String),
    Resync,
    Renamed(String, String),
    Activity(String, Value),
    Local(LocalDelivery),
    FlushLocal,
}

enum Inbound {
    Endpoints(Map<String, Value>),
    Fleet(Map<String, Value>),
}

struct Link {
    writer: Option<mpsc::UnboundedSender<Message>>,
    generation: u64,
    connected: bool,
    ready: bool,
    stopped: bool,
    shut_down: bool,
    last_error: Option<String>,
    since: String,
    attempt: u32,
    revoked_reason: Option<String>,
    handshake_error: Option<String>,
    token: Option<String>,
    known: HashSet<String>,
    sent: HashMap<String, String>,
    inflight: BTreeSet<i64>,
    acked_max: i64,
    local_queue: Vec<Value>,
    local_armed: bool,
}

pub struct Bridge {
    pub config: BridgeConfig,
    link: StdMutex<Link>,
    pending: StdMutex<HashMap<u64, oneshot::Sender<Result<Value, Failure>>>>,
    next_id: AtomicU64,
    commands: mpsc::UnboundedSender<Command>,
    receiver: StdMutex<Option<mpsc::UnboundedReceiver<Command>>>,
    up: watch::Sender<bool>,
    kick: Notify,
}

impl Bridge {
    /// a bridge for `core`, linked once [`Bridge::spawn`] runs it
    pub fn attach(config: BridgeConfig, core: &mut Core) -> Arc<Self> {
        let (commands, receiver) = mpsc::unbounded_channel();
        let last_error = match &config.token {
            Some(_) => None,
            None => Some(
                config
                    .token_error
                    .clone()
                    .unwrap_or_else(|| "no hub credential; the broker runs local-only".into()),
            ),
        };
        let bridge = Arc::new(Self {
            link: StdMutex::new(Link {
                writer: None,
                generation: 0,
                connected: false,
                ready: false,
                stopped: false,
                shut_down: false,
                last_error,
                since: timestamp(now_ms()).unwrap_or_default(),
                attempt: 0,
                revoked_reason: None,
                handshake_error: None,
                token: config.token.clone(),
                known: HashSet::new(),
                sent: HashMap::new(),
                inflight: BTreeSet::new(),
                acked_max: 0,
                local_queue: Vec::new(),
                local_armed: false,
            }),
            config,
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            commands,
            receiver: StdMutex::new(Some(receiver)),
            up: watch::channel(false).0,
            kick: Notify::new(),
        });
        core.federation.machine = Some(bridge.config.machine.clone());
        core.federation.bridge = Some(bridge.clone());
        bridge
    }

    fn link(&self) -> std::sync::MutexGuard<'_, Link> {
        self.link
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn connected(&self) -> bool {
        self.link().connected
    }

    fn ready(&self) -> bool {
        self.link().ready
    }

    fn set_state(&self, up: bool, error: Option<String>) {
        let mut link = self.link();
        if up != link.connected || error != link.last_error {
            link.since = timestamp(now_ms()).unwrap_or_default();
            if up {
                log(&format!(
                    "relay bridge: linked to {} as machine {}",
                    self.config.url, self.config.machine
                ));
            } else {
                log(&format!(
                    "relay bridge: not linked to the hub: {}",
                    error.as_deref().unwrap_or("stopped")
                ));
            }
        }
        link.connected = up;
        link.last_error = error;
        drop(link);
        self.up.send_replace(up);
    }

    pub fn unavailable(&self) -> RpcError {
        let last = self.link().last_error.clone();
        let mut error = RpcError::new(
            ErrorCode::Unavailable,
            format!(
                "the hub is not connected{}; try again",
                last.map(|l| format!(" ({l})")).unwrap_or_default()
            ),
        );
        if let Some(data) = error.data.as_mut() {
            data.extra.insert("retry_after".into(), json!(5));
        }
        error
    }

    pub fn status(&self) -> Value {
        let link = self.link();
        json!({"enabled": true, "machine": self.config.machine, "url": self.config.url, "connected": link.connected, "last_error": link.last_error, "since": link.since})
    }

    /// reads the credential again and reconnects now, also after the hub revoked or replaced this bridge
    pub fn relink(&self) {
        let mut link = self.link();
        if link.shut_down {
            return;
        }
        link.stopped = false;
        link.attempt = 0;
        let open = link.writer.is_some();
        drop(link);
        if !open {
            self.kick.notify_one();
        }
    }

    pub fn stop(&self) {
        let writer = {
            let mut link = self.link();
            link.stopped = true;
            link.shut_down = true;
            link.local_queue.clear();
            link.connected = false;
            link.ready = false;
            link.writer.take()
        };
        self.up.send_replace(false);
        self.reject_pending("the bridge stopped");
        if let Some(writer) = writer {
            let _ = writer.send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "the broker stopped".into(),
            })));
        }
        self.kick.notify_one();
    }

    fn reject_pending(&self, why: &str) {
        let waiters: Vec<_> = self
            .pending
            .lock()
            .map(|mut pending| pending.drain().map(|(_, tx)| tx).collect())
            .unwrap_or_default();
        for tx in waiters {
            let _ = tx.send(Err(Failure::link(why)));
        }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, Failure> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let link = self.link();
            let Some(writer) = link.writer.clone() else {
                return Err(Failure::link("the hub is not connected"));
            };
            drop(link);
            if let Ok(mut pending) = self.pending.lock() {
                pending.insert(id, tx);
            }
            let frame = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
            if let Err(error) = writer.send(Message::text(frame.to_string())) {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                return Err(Failure::link(format!(
                    "the hub connection failed ({error})"
                )));
            }
        }
        rx.await
            .unwrap_or_else(|_| Err(Failure::link("the hub connection closed")))
    }

    fn fire_and_forget(self: &Arc<Self>, method: &'static str, params: Value) {
        let bridge = self.clone();
        tokio::spawn(async move {
            if let Err(failure) = bridge.request(method, params).await
                && failure.code() != Some(ErrorCode::Unavailable)
            {
                log(&format!(
                    "relay bridge: {method} failed: {}",
                    failure.error.message
                ));
            }
        });
    }

    fn command(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    pub fn changed(&self, endpoint: &str) {
        self.command(Command::Changed(endpoint.to_owned()));
    }

    pub fn resync(&self) {
        self.command(Command::Resync);
    }

    pub fn renamed(&self, endpoint: &str, was: &str) {
        self.command(Command::Renamed(endpoint.to_owned(), was.to_owned()));
    }

    pub fn activity(&self, endpoint: &str, row: &Value) {
        self.command(Command::Activity(endpoint.to_owned(), row.clone()));
    }

    pub fn local(&self, event: LocalDelivery) {
        if self.config.mirror_local {
            self.command(Command::Local(event));
        }
    }

    /// a forward to the hub; a hub that is briefly unavailable is tried again with backoff within forwardWaitMs
    pub async fn forward_request(&self, request: Value) -> Result<Value, RpcError> {
        let deadline = tokio::time::Instant::now() + self.config.forward_wait;
        let mut tries = 0;
        loop {
            match self.request("forward", request.clone()).await {
                Ok(result) => return Ok(result),
                Err(failure) if failure.code() != Some(ErrorCode::Unavailable) => {
                    return Err(failure.error);
                }
                Err(failure) if failure.hub => {
                    let base = backoff(
                        self.config.backoff_min,
                        self.config.backoff_max,
                        tries,
                        rand::random(),
                    );
                    tries += 1;
                    let wait = base.max(Duration::from_secs_f64(
                        retry_after(&failure.error).unwrap_or(0.0),
                    ));
                    if tokio::time::Instant::now() + wait >= deadline {
                        return Err(failure.error);
                    }
                    tokio::time::sleep(wait).await;
                }
                Err(_) => return Err(self.unavailable()),
            }
        }
    }

    /// sets or clears the URL the hub calls to wake this machine
    pub async fn machine_wake(&self, params: Value) -> Result<Value, RpcError> {
        if !self.connected() {
            return Err(self.unavailable());
        }
        self.request("machine_wake", params)
            .await
            .map_err(|f| f.error)
    }

    /// mirrors these endpoints now: true once the hub took the delta
    pub async fn mirror_now(&self, core: &Core, ids: Vec<String>) -> bool {
        if !self.ready() {
            return false;
        }
        let Ok(world) = core.world().await else {
            return false;
        };
        let mut views = Vec::new();
        for id in ids {
            let Ok(Some(row)) = core.by_id(&id).await else {
                continue;
            };
            if !core.mirrored(&self.config.mirror, &row) {
                continue;
            }
            let Ok(view) = core.view(&row).await else {
                continue;
            };
            let Ok(out) = core.outward(&world, &row, &view, self.config.redact).await else {
                continue;
            };
            let mut link = self.link();
            link.known
                .insert(handle_in(view["address"].as_str().unwrap_or("")).to_owned());
            link.sent.insert(id, fingerprint(&out));
            drop(link);
            views.push(out);
        }
        if views.is_empty() {
            return false;
        }
        for batch in views.chunks(MIRROR_NOW_BATCH) {
            if self
                .request("mirror", json!({"endpoints": batch, "full": false}))
                .await
                .is_err()
            {
                return false;
            }
        }
        true
    }

    /// the lowest seq a fresh subscribe must replay from: every delivery at or below it was acked
    fn cursor(&self) -> i64 {
        let link = self.link();
        link.inflight
            .first()
            .map_or(link.acked_max, |first| first - 1)
    }

    fn settle(&self, seq: i64) {
        let mut link = self.link();
        link.inflight.remove(&seq);
        link.acked_max = link.acked_max.max(seq);
    }

    /// runs the link until the broker stops it
    pub fn spawn(self: &Arc<Self>, core: SharedCore) {
        let Some(receiver) = self.receiver.lock().ok().and_then(|mut r| r.take()) else {
            return;
        };
        tokio::spawn(self.clone().commands(core.clone(), receiver));
        tokio::spawn(self.clone().run(core));
    }

    async fn run(self: Arc<Self>, core: SharedCore) {
        let (inbound_tx, inbound_rx) = mpsc::unbounded_channel();
        let (deliveries_tx, deliveries_rx) = mpsc::unbounded_channel();
        tokio::spawn(self.clone().inbound(core.clone(), inbound_rx));
        tokio::spawn(self.clone().deliveries(core.clone(), deliveries_rx));
        loop {
            let (stopped, shut_down, token) = {
                let link = self.link();
                (link.stopped, link.shut_down, link.token.clone())
            };
            if shut_down {
                return;
            }
            if stopped || token.is_none() {
                self.kick.notified().await;
                self.reread_credential();
                let missing = {
                    let link = self.link();
                    link.token.is_none() && !link.shut_down
                };
                if missing {
                    self.set_state(false, Some("no hub credential; log in again".into()));
                }
                continue;
            }
            self.connect(
                &core,
                token.unwrap_or_default(),
                &inbound_tx,
                &deliveries_tx,
            )
            .await;
            let (stopped, attempt) = {
                let mut link = self.link();
                let attempt = link.attempt;
                link.attempt += 1;
                (link.stopped, attempt)
            };
            if stopped {
                continue;
            }
            let wait = backoff(
                self.config.backoff_min,
                self.config.backoff_max,
                attempt,
                rand::random(),
            );
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = self.kick.notified() => {}
            }
            self.reread_credential();
        }
    }

    fn reread_credential(&self) {
        if self.link().stopped || self.config.env.is_empty() {
            return;
        }
        match self.config.credential() {
            Ok(Some(token)) => self.link().token = Some(token),
            Ok(None) => {}
            Err(error) => log(&format!(
                "relay bridge: the credential could not be read again: {error}"
            )),
        }
    }

    async fn connect(
        self: &Arc<Self>,
        core: &SharedCore,
        token: String,
        inbound: &mpsc::UnboundedSender<Inbound>,
        deliveries: &mpsc::UnboundedSender<(i64, Value, Value)>,
    ) {
        let request = relay_socket_url(&self.config.url).and_then(|url| {
            let mut request = url.into_client_request().map_err(|e| e.to_string())?;
            let header = format!("Bearer {token}")
                .parse()
                .map_err(|_| "the credential is not a valid header".to_owned())?;
            request.headers_mut().insert("Authorization", header);
            Ok(request)
        });
        let request = match request {
            Ok(request) => request,
            Err(error) => {
                self.set_state(false, Some(format!("cannot open the hub socket ({error})")));
                return;
            }
        };
        let socket =
            match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request))
                .await
            {
                Ok(Ok((socket, _))) => socket,
                _ => {
                    self.set_state(
                        false,
                        Some(format!("cannot connect to {} (1006)", self.config.url)),
                    );
                    return;
                }
            };
        let (mut sink, mut stream) = socket.split();
        let (writer, mut outgoing) = mpsc::unbounded_channel::<Message>();
        let generation = {
            let mut link = self.link();
            link.writer = Some(writer);
            link.generation += 1;
            link.revoked_reason = None;
            link.handshake_error = None;
            link.generation
        };
        tokio::spawn(async move {
            while let Some(message) = outgoing.recv().await {
                let closing = matches!(message, Message::Close(_));
                if sink.send(message).await.is_err() || closing {
                    break;
                }
            }
        });
        tokio::spawn(self.clone().handshake(core.clone(), generation));
        let mut close: Option<(u16, String)> = None;
        while let Some(message) = stream.next().await {
            match message {
                Ok(Message::Text(text)) => self.on_frame(text.as_str(), inbound, deliveries),
                Ok(Message::Close(frame)) => {
                    close = Some(frame.map_or((1005, String::new()), |f| {
                        (u16::from(f.code), f.reason.to_string())
                    }));
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let (was_up, revoked, handshake_error) = {
            let mut link = self.link();
            if link.generation == generation {
                link.writer = None;
            }
            link.ready = false;
            (
                link.connected,
                link.revoked_reason.clone(),
                link.handshake_error.take(),
            )
        };
        self.reject_pending("the hub connection closed");
        if self.link().shut_down {
            return;
        }
        let (code, reason) = close.unwrap_or((1006, String::new()));
        let why = if reason.is_empty() {
            code.to_string()
        } else {
            format!("{code} {reason}")
        };
        let message = match code {
            1008 => {
                self.link().stopped = true;
                let shown = revoked.unwrap_or_else(|| {
                    if reason.is_empty() {
                        "the hub closed the bridge".into()
                    } else {
                        reason.clone()
                    }
                });
                format!("revoked or unauthorized: {shown}")
            }
            4000 => {
                self.link().stopped = true;
                format!(
                    "replaced: {}",
                    if reason.is_empty() {
                        "another bridge connected for this machine"
                    } else {
                        &reason
                    }
                )
            }
            4001 => format!("the credential expired, reconnecting ({why})"),
            _ => handshake_error.unwrap_or_else(|| {
                if was_up {
                    format!("disconnected ({why})")
                } else {
                    format!("cannot connect to {} ({why})", self.config.url)
                }
            }),
        };
        self.set_state(false, Some(message));
    }

    fn on_frame(
        &self,
        text: &str,
        inbound: &mpsc::UnboundedSender<Inbound>,
        deliveries: &mpsc::UnboundedSender<(i64, Value, Value)>,
    ) {
        let Ok(frame) = serde_json::from_str::<Value>(text) else {
            log("relay bridge: the hub sent a frame that is not JSON");
            return;
        };
        if let Some(method) = frame["method"].as_str() {
            let params = frame["params"].as_object().cloned().unwrap_or_default();
            match method {
                "deliver" => {
                    let Some(seq) = params.get("seq").and_then(Value::as_i64) else {
                        return;
                    };
                    self.link().inflight.insert(seq);
                    let _ = deliveries.send((
                        seq,
                        params.get("endpoint").cloned().unwrap_or(Value::Null),
                        params.get("message").cloned().unwrap_or(Value::Null),
                    ));
                }
                "endpoints" => {
                    let _ = inbound.send(Inbound::Endpoints(params));
                }
                "fleet" => {
                    let _ = inbound.send(Inbound::Fleet(params));
                }
                "revoked" => {
                    self.link().revoked_reason = params
                        .get("reason")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
                _ => {}
            }
            return;
        }
        let Some(id) = frame["id"].as_u64() else {
            return;
        };
        let Some(waiter) = self.pending.lock().ok().and_then(|mut p| p.remove(&id)) else {
            return;
        };
        let result = match frame.get("error") {
            Some(error) if !error.is_null() => Err(Failure {
                error: hub_error(error),
                hub: true,
            }),
            _ => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = waiter.send(result);
    }

    fn current(&self, generation: u64) -> bool {
        let link = self.link();
        link.generation == generation && link.writer.is_some()
    }

    async fn handshake(self: Arc<Self>, core: SharedCore, generation: u64) {
        let result = self.handshake_steps(&core, generation).await;
        let Err(failure) = result else {
            return;
        };
        if !self.current(generation) {
            return;
        }
        let message = failure.error.message.clone();
        let error = match failure.code() {
            Some(ErrorCode::Unauthorized | ErrorCode::InvalidParams) => {
                self.link().stopped = true;
                format!("the hub refused this bridge: {message}")
            }
            Some(ErrorCode::TooLarge) => {
                format!("the hub refused this bridge for now, retrying: {message}")
            }
            _ => format!("the handshake failed: {message}"),
        };
        let writer = {
            let mut link = self.link();
            link.handshake_error = Some(error);
            link.writer.clone()
        };
        if let Some(writer) = writer {
            let _ = writer.send(Message::Close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "handshake failed".into(),
            })));
        }
    }

    async fn handshake_steps(&self, core: &SharedCore, generation: u64) -> Result<(), Failure> {
        let hello = self
            .request(
                "hello",
                json!({"protocol": PROTOCOL, "machine": self.config.machine, "bridge": true}),
            )
            .await?;
        let account = hello["account"].as_str().unwrap_or_default().to_owned();
        let others: Vec<String> = hello["others"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        let frames = {
            let mut guard = core.lock().await;
            guard.federation.account = Some(account.clone());
            guard.federation.aliases = HashSet::from([account.clone()]);
            super::set_others(&account, others);
            {
                let mut link = self.link();
                link.ready = true;
                link.known.clear();
                link.sent.clear();
            }
            self.apply_remote(&mut guard, &hello["endpoints"], true)
                .await;
            link_pending(&mut guard, false).await;
            self.full_mirror(&mut guard)
                .await
                .map_err(|error| Failure { error, hub: false })?
        };
        for frame in frames {
            self.request("mirror", frame).await?;
        }
        self.request("watch", json!({})).await?;
        self.request("subscribe", json!({"after": self.cursor()}))
            .await?;
        if !self.current(generation) {
            return Ok(());
        }
        self.link().attempt = 0;
        self.set_state(true, None);
        Ok(())
    }

    /// the other machines' endpoints, grouped by machine; with `full`, a known machine the hub no longer lists was released
    async fn apply_remote(&self, core: &mut Core, views: &Value, full: bool) {
        let mut by_machine: Vec<(String, Vec<Value>)> = Vec::new();
        for view in views.as_array().into_iter().flatten() {
            let Some(machine) = view["machine"].as_str() else {
                continue;
            };
            if machine == self.config.machine {
                continue;
            }
            match by_machine.iter_mut().find(|(m, _)| m == machine) {
                Some((_, list)) => list.push(view.clone()),
                None => by_machine.push((machine.to_owned(), vec![view.clone()])),
            }
        }
        if full {
            let _ = core.drop_machine(&self.config.machine).await;
            let account = core.federation.account.clone();
            for machine in core.remote_machines().await.unwrap_or_default() {
                if Some(&machine) != account.as_ref()
                    && !by_machine.iter().any(|(m, _)| *m == machine)
                {
                    let _ = core.drop_machine(&machine).await;
                }
            }
        }
        for (name, list) in by_machine {
            if let Err(error) = core.mirror(&name, &Value::Array(list), full).await {
                log(&format!(
                    "relay bridge: the endpoints of {name} were not applied: {}",
                    error.message
                ));
            }
        }
    }

    /// the full mirror: the reachable rows and their parents, plus what the hub may still show reachable so it learns otherwise
    async fn full_mirror(&self, core: &mut Core) -> Result<Vec<Value>, RpcError> {
        let world = core.world().await?;
        let rows: Vec<(Row, Value)> = core
            .local_rows(false)
            .await?
            .into_iter()
            .filter(|(row, _)| core.mirrored(&self.config.mirror, row))
            .collect();
        let all: Vec<(Row, Value)> = core
            .local_rows(true)
            .await?
            .into_iter()
            .filter(|(row, _)| core.mirrored(&self.config.mirror, row))
            .collect();
        let known = self.link().known.clone();
        let index = |address: &str| -> Option<(bool, usize)> {
            rows.iter()
                .position(|(_, v)| v["address"] == address)
                .map(|i| (true, i))
                .or_else(|| {
                    all.iter()
                        .position(|(_, v)| v["address"] == address)
                        .map(|i| (false, i))
                })
        };
        let get = |(local, i): (bool, usize)| if local { &rows[i] } else { &all[i] };
        let mut kept: Vec<(bool, usize)> = Vec::new();
        let mut sent: Vec<(bool, usize)> = Vec::new();
        for (i, (_, view)) in rows.iter().enumerate() {
            if !reachable(view) {
                if known.contains(handle_in(view["address"].as_str().unwrap_or("")))
                    && !sent.contains(&(true, i))
                {
                    sent.push((true, i));
                }
                continue;
            }
            let mut at = Some((true, i));
            while let Some(key) = at {
                let key = match key {
                    (false, j) => {
                        index(all[j].1["address"].as_str().unwrap_or("")).unwrap_or((false, j))
                    }
                    other => other,
                };
                if kept.contains(&key) {
                    break;
                }
                kept.push(key);
                if !sent.contains(&key) {
                    sent.push(key);
                }
                at = get(key).1["parent"].as_str().and_then(index);
            }
        }
        let mut known = HashSet::new();
        for key in &kept {
            known.insert(handle_in(get(*key).1["address"].as_str().unwrap_or("")).to_owned());
        }
        let mut views = Vec::new();
        let mut prints = HashMap::new();
        for key in sent {
            let (row, view) = get(key);
            let out = core.outward(&world, row, view, self.config.redact).await?;
            prints.insert(
                text(row, "id").unwrap_or_default().to_owned(),
                fingerprint(&out),
            );
            views.push(out);
        }
        let frames = mirror_frames(views, &crate::messages::new_id("sync", now_ms()))?;
        let mut link = self.link();
        link.known = known;
        link.sent.extend(prints);
        Ok(frames)
    }

    /// a delta's rows for `id`, after the parents the hub may not have on this link; empty when no delta goes out
    async fn delta(&self, core: &Core, id: &str) -> Result<Vec<Value>, RpcError> {
        let Some(row) = core.by_id(id).await? else {
            return Ok(Vec::new());
        };
        if !core.mirrored(&self.config.mirror, &row) {
            return Ok(Vec::new());
        }
        let view = core.view(&row).await?;
        let handle = handle_in(view["address"].as_str().unwrap_or("")).to_owned();
        let reach = reachable(&view);
        {
            let mut link = self.link();
            if reach {
                link.known.insert(handle);
            } else if !link.known.remove(&handle) {
                return Ok(Vec::new());
            }
        }
        let world = core.world().await?;
        let mut chain = vec![(row, view)];
        let parent = chain[0].1["parent"]
            .as_str()
            .map(str::to_owned)
            .filter(|parent| reach && !self.link().known.contains(handle_in(parent)));
        if let Some(parent) = parent {
            let all = core.local_rows(true).await?;
            let mut at = Some(parent);
            while let Some(address) = at {
                let Some((row, view)) = all.iter().find(|(r, v)| {
                    v["address"] == address.as_str() && core.mirrored(&self.config.mirror, r)
                }) else {
                    break;
                };
                let handle = handle_in(&address).to_owned();
                if chain.iter().any(|(_, v)| v["address"] == address.as_str())
                    || self.link().known.contains(&handle)
                {
                    break;
                }
                self.link().known.insert(handle);
                chain.insert(0, (row.clone(), view.clone()));
                at = view["parent"].as_str().map(str::to_owned);
            }
        }
        let mut out = Vec::new();
        for (row, view) in &chain {
            let wire = core.outward(&world, row, view, self.config.redact).await?;
            self.link().sent.insert(
                text(row, "id").unwrap_or_default().to_owned(),
                fingerprint(&wire),
            );
            out.push(wire);
        }
        Ok(out)
    }

    async fn commands(
        self: Arc<Self>,
        core: SharedCore,
        mut receiver: mpsc::UnboundedReceiver<Command>,
    ) {
        let mut tick = tokio::time::interval(RECONCILE_EVERY);
        loop {
            let command = tokio::select! {
                command = receiver.recv() => match command { Some(c) => c, None => return },
                _ = tick.tick() => {
                    self.reconcile(&core).await;
                    continue;
                }
            };
            if self.link().shut_down {
                return;
            }
            if !self.ready() && !matches!(command, Command::FlushLocal) {
                continue;
            }
            match command {
                Command::Changed(id) => {
                    let guard = core.lock().await;
                    match self.delta(&guard, &id).await {
                        Ok(rows) if !rows.is_empty() => self
                            .fire_and_forget("mirror", json!({"endpoints": rows, "full": false})),
                        Ok(_) => {}
                        Err(error) => {
                            log(&format!("relay bridge: mirror failed: {}", error.message))
                        }
                    }
                }
                Command::Resync => {
                    let mut guard = core.lock().await;
                    match self.full_mirror(&mut guard).await {
                        Ok(frames) => {
                            for frame in frames {
                                self.fire_and_forget("mirror", frame);
                            }
                        }
                        Err(error) => {
                            log(&format!("relay bridge: mirror failed: {}", error.message))
                        }
                    }
                }
                Command::Renamed(id, was) => {
                    let guard = core.lock().await;
                    let Ok(Some(row)) = guard.by_id(&id).await else {
                        continue;
                    };
                    if !guard.mirrored(&self.config.mirror, &row) {
                        drop(guard);
                        self.resync();
                        continue;
                    }
                    let (Ok(view), Ok(world)) = (guard.view(&row).await, guard.world().await)
                    else {
                        continue;
                    };
                    let Ok(mut out) = guard.outward(&world, &row, &view, self.config.redact).await
                    else {
                        continue;
                    };
                    {
                        let mut link = self.link();
                        link.known.remove(&was);
                        link.known
                            .insert(handle_in(view["address"].as_str().unwrap_or("")).to_owned());
                        link.sent.insert(id, fingerprint(&out));
                    }
                    out["was"] = json!(was);
                    self.fire_and_forget("mirror", json!({"endpoints": [out], "full": false}));
                }
                Command::Activity(id, row) => {
                    let guard = core.lock().await;
                    let Ok(Some(endpoint)) = guard.by_id(&id).await else {
                        continue;
                    };
                    if !guard.mirrored(&self.config.mirror, &endpoint) {
                        continue;
                    }
                    let handle = if text(&endpoint, "kind") == Some("human") {
                        ""
                    } else {
                        text(&endpoint, "handle").unwrap_or("")
                    };
                    let mut event = json!({"from": handle, "kind": row["kind"]});
                    if row["tool"].is_string() {
                        event["tool"] = row["tool"].clone();
                    }
                    if !self.config.redact && row["summary"].is_string() {
                        event["summary"] = row["summary"].clone();
                    }
                    self.fire_and_forget("event", event);
                }
                Command::Local(event) => {
                    if self.link().local_queue.len() >= LOCAL_BUFFER {
                        continue;
                    }
                    let guard = core.lock().await;
                    let handle_of = |row: Option<Row>| {
                        row.filter(|r| guard.mirrored(&self.config.mirror, r))
                            .map(|r| {
                                if text(&r, "kind") == Some("human") {
                                    String::new()
                                } else {
                                    text(&r, "handle").unwrap_or("").to_owned()
                                }
                            })
                    };
                    let Some(from) = handle_of(guard.by_id(&event.from).await.ok().flatten())
                    else {
                        continue;
                    };
                    let mut to = Vec::new();
                    for id in &event.to {
                        if let Some(handle) = handle_of(guard.by_id(id).await.ok().flatten()) {
                            to.push(handle);
                        }
                    }
                    drop(guard);
                    if to.is_empty() {
                        continue;
                    }
                    to.truncate(LOCAL_RECIPIENTS);
                    let arm = {
                        let mut link = self.link();
                        link.local_queue.push(json!({"from": from, "to": to, "kind": event.kind, "at": event.at, "id": id_hash(&event.id), "thread": id_hash(&event.thread)}));
                        !std::mem::replace(&mut link.local_armed, true)
                    };
                    if arm {
                        let bridge = self.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(bridge.config.local_flush).await;
                            bridge.command(Command::FlushLocal);
                        });
                    }
                }
                Command::FlushLocal => {
                    let (batch, ready) = {
                        let mut link = self.link();
                        link.local_armed = false;
                        (std::mem::take(&mut link.local_queue), link.ready)
                    };
                    if !ready {
                        continue;
                    }
                    for chunk in batch.chunks(LOCAL_PER_FRAME) {
                        self.fire_and_forget("local_events", json!({"events": chunk}));
                    }
                }
            }
        }
    }

    /// any mirrored row whose view moved since it was last sent goes out as a delta
    async fn reconcile(self: &Arc<Self>, core: &SharedCore) {
        if !self.ready() {
            return;
        }
        let guard = core.lock().await;
        let (Ok(rows), Ok(world)) = (guard.local_rows(false).await, guard.world().await) else {
            return;
        };
        for (row, view) in rows {
            if !guard.mirrored(&self.config.mirror, &row) {
                continue;
            }
            let id = text(&row, "id").unwrap_or_default().to_owned();
            let Ok(out) = guard.outward(&world, &row, &view, self.config.redact).await else {
                continue;
            };
            let print = fingerprint(&out);
            let known = handle_in(view["address"].as_str().unwrap_or(""));
            let moved = {
                let link = self.link();
                match link.sent.get(&id) {
                    Some(sent) => *sent != print,
                    None => reachable(&view) || link.known.contains(known),
                }
            };
            if !moved {
                continue;
            }
            match self.delta(&guard, &id).await {
                Ok(rows) if !rows.is_empty() => {
                    self.fire_and_forget("mirror", json!({"endpoints": rows, "full": false}))
                }
                Ok(_) => {
                    self.link().sent.insert(id, print);
                }
                Err(_) => {}
            }
        }
    }

    async fn inbound(
        self: Arc<Self>,
        core: SharedCore,
        mut receiver: mpsc::UnboundedReceiver<Inbound>,
    ) {
        while let Some(inbound) = receiver.recv().await {
            let mut guard = core.lock().await;
            match inbound {
                Inbound::Endpoints(params) => {
                    let Some(machine) = params
                        .get("machine")
                        .and_then(Value::as_str)
                        .filter(|m| *m != self.config.machine)
                    else {
                        continue;
                    };
                    if let Some(own) = params.get("own").and_then(Value::as_bool) {
                        super::set_other(machine, !own);
                    }
                    let applied = if params.get("released") == Some(&Value::Bool(true)) {
                        guard.drop_machine(machine).await.map(|_| ())
                    } else {
                        let full = params.get("full") == Some(&Value::Bool(true));
                        guard
                            .mirror(
                                machine,
                                params.get("endpoints").unwrap_or(&Value::Null),
                                full,
                            )
                            .await
                    };
                    if let Err(error) = applied {
                        log(&format!(
                            "relay bridge: the endpoints of {machine} were not applied: {}",
                            error.message
                        ));
                    }
                    if link_pending(&mut guard, true).await {
                        self.resync();
                    }
                }
                Inbound::Fleet(event) => self.remote_fleet(&guard, event).await,
            }
        }
    }

    async fn remote_fleet(&self, core: &Core, event: Map<String, Value>) {
        if event.get("machine").and_then(Value::as_str) == Some(self.config.machine.as_str()) {
            return;
        }
        if let (Some("message"), Some(Value::Array(to)), Some(account)) = (
            event.get("type").and_then(Value::as_str),
            event.get("to"),
            core.federation.account.as_deref(),
        ) {
            let own = format!("{account}/{}/", self.config.machine);
            if to
                .iter()
                .any(|t| t.as_str().is_some_and(|t| t.starts_with(&own)))
            {
                return;
            }
        }
        let mut local = event.clone();
        for key in ["from", "endpoint"] {
            if let Some(value) = event.get(key) {
                local.insert(key.into(), core.local_address(value));
            }
        }
        if let Some(Value::Array(to)) = event.get("to") {
            local.insert(
                "to".into(),
                Value::Array(to.iter().map(|t| core.local_address(t)).collect()),
            );
        }
        core.notify_watchers(Value::Object(local)).await;
    }

    async fn deliveries(
        self: Arc<Self>,
        core: SharedCore,
        mut receiver: mpsc::UnboundedReceiver<(i64, Value, Value)>,
    ) {
        while let Some((seq, target, message)) = receiver.recv().await {
            if let Err(error) = self.deliver(&core, seq, &target, &message).await
                && refusal_code(&error) != Some(ErrorCode::Unavailable)
            {
                log(&format!(
                    "relay bridge: delivery {seq} failed: {}",
                    error.message
                ));
            }
        }
    }

    async fn deliver(
        &self,
        core: &SharedCore,
        seq: i64,
        target: &Value,
        message: &Value,
    ) -> Result<(), RpcError> {
        let mut attempts = 0;
        let refused = loop {
            let result = core.lock().await.inject_remote(target, message).await;
            match result {
                Ok(Injected::Admitted(endpoint)) => {
                    super::wake_delivered(core, &endpoint).await;
                    break None;
                }
                Ok(Injected::Duplicate) => break None,
                Ok(Injected::Refused(code)) => break Some(code),
                Err(error) => {
                    attempts += 1;
                    let why = error.message.clone();
                    log(&format!(
                        "relay bridge: delivery {seq} failed (attempt {attempts} of {DEAD_LETTER_ATTEMPTS}): {why}"
                    ));
                    if attempts >= DEAD_LETTER_ATTEMPTS {
                        self.settled("reject", json!({"seq": seq, "code": "dead_letter"}))
                            .await?;
                        self.settle(seq);
                        let shown = target
                            .as_str()
                            .map_or_else(|| target.to_string(), str::to_owned);
                        core.lock()
                            .await
                            .audit("dead_letter", None, message["id"].as_str(), json!({"seq": seq, "target": shown, "attempts": attempts, "error": why}))
                            .await?;
                        return Ok(());
                    }
                    tokio::time::sleep(self.config.inject_backoff * 2u32.pow(attempts - 1)).await;
                }
            }
        };
        match refused {
            Some(code) => {
                self.settled("reject", json!({"seq": seq, "code": code}))
                    .await?
            }
            None => self.settled("ack", json!({"seqs": [seq]})).await?,
        }
        self.settle(seq);
        Ok(())
    }

    /// an ack or reject; one the hub's ack limit refuses waits its retry_after and goes again, while the link holds
    async fn settled(&self, method: &str, params: Value) -> Result<(), RpcError> {
        loop {
            match self.request(method, params.clone()).await {
                Ok(_) => return Ok(()),
                Err(failure) if failure.code() == Some(ErrorCode::RateLimited) => {
                    tokio::time::sleep(Duration::from_secs_f64(
                        retry_after(&failure.error).unwrap_or(1.0),
                    ))
                    .await;
                }
                Err(failure) => return Err(failure.error),
            }
        }
    }
}

/// the claims' pending links under a parent on another machine, tried again once its endpoints arrived; true when one linked and `sync` asks for a resync
async fn link_pending(core: &mut Core, sync: bool) -> bool {
    let linked = crate::claims::retry_link_under(core).await;
    for (address, parent) in &linked {
        log(&format!("relay bridge: {address} linked under {parent}"));
    }
    sync && !linked.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_url_follows_the_hub_origin() {
        assert_eq!(
            relay_socket_url("https://hub.example").unwrap(),
            "wss://hub.example/v1/relay/ws"
        );
        assert_eq!(
            relay_socket_url("http://127.0.0.1:8080").unwrap(),
            "ws://127.0.0.1:8080/v1/relay/ws"
        );
    }

    #[test]
    fn backoff_doubles_from_the_minimum_to_the_maximum() {
        let (min, max) = (Duration::from_secs(1), Duration::from_secs(60));
        assert_eq!(backoff(min, max, 0, 0.0), Duration::from_millis(500));
        assert_eq!(backoff(min, max, 0, 1.0), Duration::from_secs(1));
        assert_eq!(backoff(min, max, 3, 1.0), Duration::from_secs(8));
        assert_eq!(backoff(min, max, 30, 1.0), Duration::from_secs(60));
        assert_eq!(backoff(min, max, 30, 0.0), Duration::from_secs(30));
    }

    #[test]
    fn historic_offline_agents_without_a_wake_are_not_reachable() {
        let agent = |extra: Value| {
            let mut view = json!({"kind": "agent", "presence": "offline", "historic": true});
            for (k, v) in extra.as_object().unwrap() {
                view[k] = v.clone();
            }
            view
        };
        assert!(!reachable(&agent(json!({}))));
        assert!(!reachable(&agent(json!({"wake": "none"}))));
        assert!(reachable(&agent(json!({"wake": "channels"}))));
        assert!(reachable(&agent(json!({"presence": "idle"}))));
        assert!(reachable(&agent(json!({"historic": null}))));
        assert!(reachable(
            &json!({"kind": "human", "presence": "offline", "historic": true})
        ));
    }

    #[test]
    fn a_full_mirror_splits_into_sync_parts_within_the_frame() {
        let big = "x".repeat(100_000);
        let views: Vec<Value> = (0..5)
            .map(|i| json!({"address": format!("me/a{i}"), "cwd": big}))
            .collect();
        let frames = mirror_frames(views, "sync_1").unwrap();
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0]["full"], true);
        assert_eq!(frames[1]["full"], false);
        assert_eq!(
            frames[2]["sync"],
            json!({"id": "sync_1", "part": 3, "parts": 3})
        );
        assert_eq!(
            mirror_frames(vec![json!({"address": "me/a"})], "s").unwrap(),
            vec![json!({"endpoints": [{"address": "me/a"}], "full": true})]
        );
        assert!(
            mirror_frames(
                vec![json!({"address": "me/a", "cwd": "x".repeat(MIRROR_FRAME_BYTES)})],
                "s"
            )
            .is_err()
        );
    }

    #[test]
    fn hub_errors_keep_their_code_and_retry_after() {
        let error = hub_error(
            &json!({"message": "slow down", "data": {"code": "rate_limited", "retry_after": 2}}),
        );
        assert_eq!(refusal_code(&error), Some(ErrorCode::RateLimited));
        assert_eq!(retry_after(&error), Some(2.0));
        assert_eq!(
            refusal_code(&hub_error(&json!({"message": "x"}))),
            Some(ErrorCode::Unavailable)
        );
    }
}
