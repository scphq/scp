//! `swarm muse`: a headless `muse serve` session that relay messages wake: a message starts a turn on the idle session or steers a running one.

use super::attribute::{Placement, attribute, attributed, validate_under};
use super::channel::{
    Channel, ChannelSetup, Latch, Server, Transport, bind_channel, broker_connect, launcher_claim,
    pushed, start_server,
};
use crate::args::js_string;
use crate::fleet::json::Json;
use crate::fleet::mounts::{mcp_file, mounted_entry};
use crate::fleet::view::text;
use crate::open::block_on;
use crate::spawn::muse::{MUSE_MODE, muse_modes, write_muse_launch};
use crate::spawn::signals::Listener;
use crate::spawn::text::random_bytes;
use crate::{Call, Done, Fail, route, term, usage};
use scp_core::address::valid_handle;
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::{CallError, Client};
use scp_mcp::identity::{MuseLaunch, field, home_dir, relay_dir, safe_cwd};
use scp_mcp::ps::{Env, process_key, ps_start};
use scp_mcp::server::Connect;
use scp_mcp::tools::js_trim;
use scp_mcp::{Claim, LocalFuture};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::process::Stdio;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

const NO_USER_INPUT: &str = "--disable-request-user-input";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY: Duration = Duration::from_secs(2);
const BIND_TIMEOUT: Duration = Duration::from_secs(30);
const TERMINATE_MS: u64 = 3000;

/// `swarm muse` as parsed
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MuseArgs {
    pub name: Option<String>,
    pub root: bool,
    pub under: Option<String>,
    pub resume: Option<String>,
    pub approval_mode: String,
    pub serve_args: Vec<String>,
    pub env: Env,
}

/// Muse's tool approval modes, as the TUI names them, to the modes muse serve takes on the wire
fn approval(mode: &str) -> Option<&'static str> {
    match mode {
        "never" => Some("allowAll"),
        "on-request" => Some("onRequest"),
        "untrusted" => Some("promptUnmatched"),
        _ => None,
    }
}

/// the muse serve arguments and environment, without the launching session's identity
pub fn muse_launch(args: &[String], env: &Env) -> Result<MuseArgs, Fail> {
    let mut parsed = MuseArgs::default();
    let mut mode = "on-request".to_owned();
    let mut serve_args: Vec<String> = Vec::new();
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        if arg == "--" {
            serve_args.extend_from_slice(&args[i + 1..]);
            break;
        }
        let eq = if arg.starts_with("--") {
            arg.find('=').filter(|eq| *eq > 0)
        } else {
            None
        };
        let flag = eq.map_or(arg.as_str(), |eq| &arg[..eq]);
        let mut take = || match eq {
            Some(eq) => Ok(arg[eq + 1..].to_owned()),
            None => {
                i += 1;
                args.get(i)
                    .cloned()
                    .ok_or_else(|| usage(format!("{CLI_NAME} muse {flag} takes a value")))
            }
        };
        if flag == "--name" || flag == "--as" {
            parsed.name = Some(take()?);
        } else if arg == "--under" || arg.starts_with("--under=") {
            let under = if arg == "--under" {
                i += 1;
                args.get(i).cloned()
            } else {
                Some(arg["--under=".len()..].to_owned())
            };
            parsed.under = Some(under.ok_or_else(|| usage("--under takes an address"))?);
        } else if arg == "--root" {
            parsed.root = true;
        } else if flag == "--resume" {
            parsed.resume = Some(take()?);
        } else if flag == "--approval-mode" {
            mode = take()?;
        } else {
            serve_args.push(arg.clone());
        }
        i += 1;
    }
    validate_under(parsed.under.as_deref(), parsed.root)?;
    parsed.name = parsed
        .name
        .map(|name| name.strip_prefix("me/").unwrap_or(&name).to_owned());
    if let Some(name) = &parsed.name
        && !valid_handle(name)
    {
        return Err(usage(format!(
            "{} is not a valid agent handle",
            js_string(name)
        )));
    }
    let Some(approval_mode) = approval(&mode) else {
        return Err(usage(format!(
            "{CLI_NAME} muse --approval-mode takes never, on-request or untrusted, not {}",
            js_string(&mode)
        )));
    };
    parsed.approval_mode = approval_mode.to_owned();
    let modes = muse_modes(&serve_args);
    for mode in &modes {
        match mode.as_deref() {
            Some("off" | "on") => {}
            Some(mode) => {
                return Err(usage(format!(
                    "{CLI_NAME} muse: muse runs with {MUSE_MODE} off or on, not {}",
                    js_string(mode)
                )));
            }
            None => {
                return Err(usage(format!(
                    "{CLI_NAME} muse: muse runs with {MUSE_MODE} off or on, not a bare flag"
                )));
            }
        }
    }
    let mut words = Vec::new();
    if modes.is_empty() {
        words.extend([MUSE_MODE.to_owned(), "off".to_owned()]);
    }
    if !serve_args.iter().any(|word| word == NO_USER_INPUT) {
        words.push(NO_USER_INPUT.to_owned());
    }
    words.extend(serve_args);
    parsed.serve_args = words;
    let mut clean = env.clone();
    clean.remove("SCP_SESSION");
    clean.remove("SCP_PARENT");
    clean.insert("SCP_HARNESS".into(), "muse".into());
    if let Some(name) = &parsed.name {
        clean.insert("SCP_NAME".into(), name.clone());
    }
    parsed.env = clean;
    Ok(parsed)
}

/// the broker Muse's shim and hooks reach: Muse starts them without SCP_DIR or XDG_STATE_HOME, so the default one under HOME
pub fn muse_broker(env: &Env) -> String {
    let home = env
        .get("HOME")
        .filter(|home| !home.is_empty())
        .cloned()
        .unwrap_or_else(home_dir);
    relay_dir(&Env::from([("HOME".to_owned(), home)]))
}

/// a time-ordered UUID (version 7), which muse serve requires for command ids
pub fn uuidv7(now_ms: u64) -> String {
    let mut bytes = random_bytes::<16>();
    bytes[..6].copy_from_slice(&now_ms.to_be_bytes()[2..]);
    bytes[6] = bytes[6] & 15 | 0x70;
    bytes[8] = bytes[8] & 63 | 128;
    let hex = crate::spawn::text::hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn command_id() -> Json {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64);
    Json::str(uuidv7(now))
}

type Replies = HashMap<u64, oneshot::Sender<Result<Json, String>>>;
type OnMessage = Box<dyn Fn(&Rc<MuseHost>, &Json)>;

/// a JSON-RPC client of muse serve over its stdio, one message per line
pub struct MuseHost {
    writer: RefCell<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    next: Cell<u64>,
    closed: RefCell<Option<String>>,
    pending: RefCell<Replies>,
    on_message: OnMessage,
}

impl MuseHost {
    /// a client on `input` and `output`, which needs a LocalSet
    pub fn start<W, R>(input: Option<W>, output: Option<R>, on_message: OnMessage) -> Rc<MuseHost>
    where
        W: tokio::io::AsyncWrite + Unpin + 'static,
        R: tokio::io::AsyncRead + Unpin + 'static,
    {
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let host = Rc::new(MuseHost {
            writer: RefCell::new(Some(tx)),
            next: Cell::new(1),
            closed: RefCell::new(None),
            pending: RefCell::default(),
            on_message,
        });
        let writing = host.clone();
        tokio::task::spawn_local(async move {
            let Some(mut input) = input else { return };
            while let Some(line) = rx.recv().await {
                if let Err(error) = input.write_all(&line).await {
                    let code = scp_mcp::client::errno_code(&error);
                    writing
                        .close(&code.map_or_else(|| error.to_string(), |c| format!("write {c}")));
                    return;
                }
            }
        });
        let reading = host.clone();
        tokio::task::spawn_local(async move {
            if let Some(mut output) = output {
                let mut buffer: Vec<u8> = Vec::new();
                let mut chunk = vec![0u8; 65536];
                while let Ok(n) = output.read(&mut chunk).await {
                    if n == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                    while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                        let raw: Vec<u8> = buffer.drain(..=end).collect();
                        let line = String::from_utf8_lossy(&raw[..end]);
                        let line = js_trim(&line);
                        if !line.is_empty() {
                            reading.receive(line);
                        }
                    }
                }
            }
            reading.close("muse serve closed");
        });
        host
    }

    fn receive(self: &Rc<Self>, line: &str) {
        let Some(message) = Json::parse(line.as_bytes()) else {
            return;
        };
        let id = message.get("id").and_then(Json::as_f64);
        let reply = id
            .filter(|id| message.get("method").is_none() && id.fract() == 0.0 && *id >= 0.0)
            .and_then(|id| self.pending.borrow_mut().remove(&(id as u64)));
        let Some(reply) = reply else {
            (self.on_message)(self, &message);
            return;
        };
        let error = message
            .get("error")
            .filter(|e| crate::fleet::view::truthy(Some(e)));
        let _ = reply.send(match error {
            Some(error) => Err(error.compact()),
            None => Ok(message
                .get("result")
                .filter(|r| !matches!(r, Json::Null))
                .cloned()
                .unwrap_or(Json::Obj(Vec::new()))),
        });
    }

    /// `message` with the JSON-RPC version first
    pub fn send(&self, message: Vec<(&str, Json)>) -> Result<(), String> {
        if let Some(error) = self.closed.borrow().clone() {
            return Err(error);
        }
        let mut entries = vec![("jsonrpc", Json::str("2.0"))];
        entries.extend(message);
        let line = format!("{}\n", Json::object(entries).compact());
        if let Some(writer) = self.writer.borrow().as_ref() {
            let _ = writer.send(line.into_bytes());
        }
        Ok(())
    }

    /// sends the request at once; the reply comes through the future
    fn ask(
        self: Rc<Self>,
        method: String,
        params: Json,
    ) -> LocalFuture<'static, Result<Json, String>> {
        if let Some(error) = self.closed.borrow().clone() {
            return Box::pin(async move { Err(error) });
        }
        let id = self.next.get();
        self.next.set(id + 1);
        let (reply, answer) = oneshot::channel();
        self.pending.borrow_mut().insert(id, reply);
        let sent = self.send(vec![
            ("id", Json::Num(id as f64)),
            ("method", Json::str(method.clone())),
            ("params", params),
        ]);
        Box::pin(async move {
            if let Err(error) = sent {
                self.pending.borrow_mut().remove(&id);
                return Err(error);
            }
            match tokio::time::timeout(REQUEST_TIMEOUT, answer).await {
                Ok(Ok(reply)) => reply,
                Ok(Err(_)) => Err("muse serve closed".into()),
                Err(_) => {
                    self.pending.borrow_mut().remove(&id);
                    Err(format!("muse {method} timed out"))
                }
            }
        })
    }

    pub fn close(&self, error: &str) {
        self.closed
            .borrow_mut()
            .get_or_insert_with(|| error.to_owned());
        let closed = self.closed.borrow().clone().unwrap_or_default();
        for (_, reply) in self.pending.borrow_mut().drain() {
            let _ = reply.send(Err(closed.clone()));
        }
    }

    /// closes muse serve's stdin
    fn end(&self) {
        self.writer.borrow_mut().take();
    }
}

struct Host(Rc<MuseHost>);

impl Transport for Host {
    fn request(&self, method: &str, params: Json) -> LocalFuture<'static, Result<Json, String>> {
        self.0.clone().ask(method.to_owned(), params)
    }
}

/// hands channel messages to one session as a turn: started when it is idle, steered into the running one otherwise; retried every 2 s
pub struct MuseWaker {
    transport: Rc<dyn Transport>,
    session: String,
    retry: Duration,
    queue: RefCell<Vec<String>>,
    busy: Cell<bool>,
    timer: RefCell<Option<tokio::task::JoinHandle<()>>>,
    stopped: Cell<bool>,
}

impl MuseWaker {
    pub fn new(transport: Rc<dyn Transport>, session: &str, retry: Duration) -> Rc<MuseWaker> {
        Rc::new(MuseWaker {
            transport,
            session: session.to_owned(),
            retry,
            queue: RefCell::default(),
            busy: Cell::new(false),
            timer: RefCell::new(None),
            stopped: Cell::new(false),
        })
    }

    pub fn push(self: &Rc<Self>, text: &str) {
        self.queue.borrow_mut().push(text.to_owned());
        self.flush();
    }

    fn clear_timer(&self) {
        if let Some(timer) = self.timer.borrow_mut().take() {
            timer.abort();
        }
    }

    pub fn flush(self: &Rc<Self>) {
        if self.busy.get() || self.stopped.get() || self.queue.borrow().is_empty() {
            return;
        }
        self.clear_timer();
        let count = self.queue.borrow().len();
        let text = self.queue.borrow()[..count].join("\n\n");
        let params = Json::object(vec![
            ("commandId", command_id()),
            ("sessionId", Json::str(self.session.clone())),
            (
                "input",
                Json::Arr(vec![Json::object(vec![
                    ("type", Json::str("text")),
                    ("text", Json::str(text)),
                ])]),
            ),
            ("ifBusy", Json::str("steer")),
        ]);
        self.busy.set(true);
        let reply = self.transport.request("turn/start", params);
        let waker = self.clone();
        tokio::task::spawn_local(async move {
            let accepted = reply.await.is_ok_and(|result| {
                result.get("status").and_then(Json::as_str) == Some("accepted")
            });
            if accepted {
                waker.queue.borrow_mut().drain(..count);
            }
            waker.busy.set(false);
            if waker.stopped.get() || waker.queue.borrow().is_empty() {
                return;
            }
            if accepted {
                waker.flush();
            } else if waker.timer.borrow().is_none() {
                let again = waker.clone();
                let retry = waker.retry;
                let timer = tokio::task::spawn_local(async move {
                    tokio::time::sleep(retry).await;
                    again.timer.borrow_mut().take();
                    again.flush();
                });
                *waker.timer.borrow_mut() = Some(timer);
            }
        });
    }

    pub fn close(&self) {
        self.stopped.set(true);
        self.clear_timer();
    }
}

fn present(value: Option<&Json>) -> Option<&Json> {
    value.filter(|value| !matches!(value, Json::Null))
}

/// answers a server request of muse serve for a session no human watches: approvals are declined, anything else is refused
pub fn answer_request(host: &Rc<MuseHost>, message: &Json, log: &dyn Fn(&str)) {
    let id = message.get("id").cloned().unwrap_or(Json::Null);
    let method = message.get("method");
    if method.and_then(Json::as_str) != Some("approval/request") {
        let error = Json::object(vec![
            ("code", Json::Num(-32601.0)),
            (
                "message",
                Json::str(format!(
                    "{} is unsupported in a headless session",
                    text(method)
                )),
            ),
        ]);
        let _ = host.send(vec![("id", id), ("error", error)]);
        return;
    }
    let _ = host.send(vec![("id", id), ("result", Json::Obj(Vec::new()))]);
    let params = present(message.get("params"));
    let of = |key: &str| params.and_then(|params| present(params.get(key)));
    let raw = |key: &str| params.and_then(|params| params.get(key));
    let choices = match of("availableChoices") {
        Some(Json::Arr(choices)) => choices.as_slice(),
        _ => &[],
    };
    let decided = |decision: &str| {
        choices
            .iter()
            .find(|c| c.get("decision").and_then(Json::as_str) == Some(decision))
    };
    let choice = decided("denied").or_else(|| decided("abort"));
    let subject = of("subject");
    let named = subject
        .and_then(|s| present(s.get("command")))
        .or_else(|| subject.and_then(|s| present(s.get("kind"))));
    let what = named.map_or_else(|| "an approval".to_owned(), |named| text(Some(named)));
    log(&format!("{CLI_NAME} muse: declined {what}"));
    let Some(choice) = choice else { return };
    let mut decide = Vec::new();
    let mut put = |key: &'static str, value: Option<&Json>| {
        if let Some(value) = value {
            decide.push((key, value.clone()));
        }
    };
    put("approvalId", raw("approvalId"));
    put("choiceId", choice.get("choiceId"));
    let id = command_id();
    put("commandId", Some(&id));
    put("requirementId", raw("currentRequirementId"));
    put("sessionId", raw("sessionId"));
    let reply = host
        .clone()
        .ask("approval/decide".into(), Json::object(decide));
    tokio::task::spawn_local(async move {
        if let Err(error) = reply.await {
            term::err(&format!(
                "{CLI_NAME} muse: could not decline: Error: {error}"
            ));
        }
    });
}

fn failure_head() -> String {
    format!("{CLI_NAME} muse: muse serve failed")
}

/// `{ ...(env.SCP_NAME ? { name } : {}), ... }`: what the session's shim and hooks claim
fn launch_file(env: &Env) -> MuseLaunch {
    let set = |key: &str| env.get(key).filter(|value| !value.is_empty()).cloned();
    MuseLaunch {
        name: set("SCP_NAME"),
        grant: set("SCP_GRANT"),
        under: set("SCP_UNDER"),
        ..MuseLaunch::default()
    }
}

/// what a run holds across its steps
struct Run<'a> {
    launch: &'a MuseArgs,
    env: &'a Env,
    broker: &'a str,
    router_env: &'a Env,
    cwd: &'a str,
    server: &'a Server,
    host: Rc<MuseHost>,
    latch: Latch,
    stopping: Rc<Cell<bool>>,
    unlaunch: RefCell<Option<crate::spawn::muse::LaunchFile>>,
    waker: RefCell<Option<Rc<MuseWaker>>>,
    channel: RefCell<Option<Rc<Channel>>>,
}

fn io_fail(error: String) -> Fail {
    Fail::Call(CallError::Io(error))
}

impl Run<'_> {
    fn failure(&self) -> Fail {
        usage(self.server.failure(&failure_head()))
    }

    /// the session muse serve opened
    async fn session(&self) -> Result<String, String> {
        let name = Json::object(vec![
            ("name", Json::str("scp_waker")),
            ("version", Json::str("0.1.0")),
        ]);
        let hello = Json::object(vec![("clientInfo", name)]);
        self.host.clone().ask("initialize".into(), hello).await?;
        self.host.send(vec![("method", Json::str("initialized"))])?;
        let result = match &self.launch.resume {
            Some(resume) if !resume.is_empty() => {
                let params = Json::object(vec![
                    ("commandId", command_id()),
                    ("sessionId", Json::str(resume.clone())),
                    ("excludeItems", Json::Bool(true)),
                ]);
                self.host.clone().ask("session/resume".into(), params).await
            }
            _ => {
                let params = Json::object(vec![
                    ("commandId", command_id()),
                    ("approvalMode", Json::str(self.launch.approval_mode.clone())),
                    ("workspaceRoot", Json::str(self.cwd)),
                ]);
                self.host.clone().ask("session/start".into(), params).await
            }
        }?;
        let session = result.get("session").filter(|s| matches!(s, Json::Obj(_)));
        let Some(session) = session else {
            return Err("Cannot read properties of undefined (reading 'sessionId')".into());
        };
        Ok(session
            .get("sessionId")
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_owned())
    }

    async fn serve(&self) -> Done {
        if self.server.died() || self.server.child.is_none() {
            return Err(self.failure());
        }
        let pid = self.server.child.as_ref().map_or(0, |child| child.pid());
        let key = process_key(i64::from(pid), &ps_start);
        let written = write_muse_launch(&key, &launch_file(self.env), self.env)
            .map_err(|e| io_fail(e.to_string()))?;
        *self.unlaunch.borrow_mut() = Some(written);
        let started = tokio::select! {
            session = self.session() => Some(session.map_err(io_fail)?),
            _ = self.latch.done() => None,
        };
        if self.stopping.get() {
            return Ok(0);
        }
        let started = match started {
            Some(session) if !session.is_empty() && !self.server.died() => session,
            _ => return Err(self.failure()),
        };
        let claim = launcher_claim("muse", self.cwd, self.env, i64::from(pid));
        let ended = Rc::new(Cell::new(false));
        let connect = broker_connect(self.broker, self.router_env);
        let deadline = Instant::now() + BIND_TIMEOUT;
        let bound = {
            let stopped = || {
                ended.get()
                    || self.stopping.get()
                    || self.server.died()
                    || Instant::now() > deadline
            };
            tokio::select! {
                client = bind_channel(&connect, &claim, self.cwd, &stopped) => Some(client),
                _ = self.latch.done() => None,
            }
        };
        if self.stopping.get() {
            return Ok(0);
        }
        if self.server.died() {
            return Err(self.failure());
        }
        let first = match bound {
            Some(Ok(client)) => client,
            other => {
                let why = if Instant::now() > deadline {
                    "the session's scp shim never joined".to_owned()
                } else {
                    let reason = match other {
                        Some(Err(error)) => error.message().to_owned(),
                        _ => "undefined".to_owned(),
                    };
                    format!("its channel could not bind ({reason})")
                };
                return Err(usage(format!(
                    "{CLI_NAME} muse: {why}, so messages cannot wake it; check the mount {CLI_NAME} setup --write installs"
                )));
            }
        };
        let waker = MuseWaker::new(Rc::new(Host(self.host.clone())), &started, RETRY);
        *self.waker.borrow_mut() = Some(waker.clone());
        let channel = self.open_channel(first, connect, claim.clone(), waker, ended);
        channel.initialize("scp-waker").await;
        term::err(&format!(
            "{CLI_NAME} muse: {} waiting for messages (session {started})",
            field(&claim, "handle")
        ));
        let code = self.latch.done().await;
        if self.server.died() && !self.stopping.get() {
            term::err(&self.server.failure(&failure_head()));
            return Ok(1);
        }
        Ok(code)
    }

    fn open_channel(
        &self,
        first: Client,
        connect: Connect,
        claim: Claim,
        waker: Rc<MuseWaker>,
        ended: Rc<Cell<bool>>,
    ) -> Rc<Channel> {
        let held = Rc::new(RefCell::new(Some(first)));
        let (bound_claim, cwd) = (claim.clone(), self.cwd.to_owned());
        let stopped = ended.clone();
        let bind: Connect = Rc::new(move || {
            let (held, connect, claim, cwd, stopped) = (
                held.clone(),
                connect.clone(),
                bound_claim.clone(),
                cwd.clone(),
                stopped.clone(),
            );
            Box::pin(async move {
                let first = held.borrow_mut().take();
                match first {
                    Some(client) => Ok(client),
                    None => bind_channel(&connect, &claim, &cwd, &|| stopped.get()).await,
                }
            })
        });
        let channel = Rc::new(Channel::start(
            ChannelSetup {
                connect: bind,
                claim,
                wake: "muse-serve",
                env: self.env.clone(),
                log: Rc::new(term::err),
                on_message: Rc::new(move |message: &Value| {
                    if let Some(content) = pushed(message) {
                        waker.push(content);
                    }
                }),
            },
            ended,
        ));
        *self.channel.borrow_mut() = Some(channel.clone());
        channel
    }
}

/// a message of muse serve that is no reply to this client
fn on_message(host: &Rc<MuseHost>, message: &Json) {
    if message.get("id").is_some() && message.get("method").and_then(Json::as_str).is_some() {
        answer_request(host, message, &term::err);
        return;
    }
    if message.get("method").and_then(Json::as_str) != Some("item/completed") {
        return;
    }
    let item = present(message.get("params")).and_then(|params| present(params.get("item")));
    let kind = item
        .and_then(|item| item.get("kind"))
        .and_then(Json::as_str);
    let line = item
        .and_then(|item| item.get("text"))
        .and_then(Json::as_str);
    if kind == Some("agentMessage")
        && let Some(line) = line.filter(|line| !line.is_empty())
    {
        term::print(&format!("{line}\n"));
    }
}

/// `swarm muse`: muse serve with one session that relay messages wake, printing the agent's messages; returns its exit code
pub fn muse(call: &Call, args: &[String]) -> Done {
    if matches!(args.first().map(String::as_str), Some("--help" | "-h")) {
        return Err(Fail::Decline("help".into()));
    }
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let mut env = call.env.clone();
    route::caller_argv(&mut env);
    let cwd = safe_cwd();
    let parsed = muse_launch(args, &env)?;
    let file = mcp_file("muse", &parsed.env);
    match mounted_entry("muse", &file) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Err(usage(format!(
                "{CLI_NAME} muse: Muse has no scp MCP mount, so messages cannot wake this session; run {CLI_NAME} setup --write"
            )));
        }
        Err(()) => {
            return Err(usage(format!(
                "{CLI_NAME} muse: {file} is unreadable, so the scp mount is unchecked; fix it or run {CLI_NAME} setup --write"
            )));
        }
    }
    block_on(launch(call, args, &env, &cwd, parsed))?
}

async fn launch(call: &Call<'_>, args: &[String], env: &Env, cwd: &str, parsed: MuseArgs) -> Done {
    let warn = |line: &str| term::err(line);
    let dir = muse_broker(call.env);
    let placement = Placement {
        name: parsed.name.as_deref(),
        root: parsed.root,
        under: parsed.under.as_deref(),
        resume: parsed.resume.is_some(),
        dir: Some(&dir),
    };
    let attribution = attribute("muse", placement, call.env, cwd, &warn).await?;
    let launch = match &attribution {
        Some(attribution) => muse_launch(args, &attributed(env, Some(attribution)))?,
        None => parsed,
    };
    let broker = muse_broker(&launch.env);
    if relay_dir(&launch.env) != broker {
        term::err(&format!(
            "{CLI_NAME} muse: Muse starts its shim and hooks without SCP_DIR or XDG_STATE_HOME, so this session uses {broker}"
        ));
    }
    let mut run_env = launch.env.clone();
    run_env.insert("SCP_DIR".into(), broker.clone());
    let bin = run_env
        .get("SCP_MUSE_BIN")
        .filter(|bin| !bin.is_empty())
        .cloned()
        .unwrap_or_else(|| "muse".to_owned());
    let mut command = tokio::process::Command::new(&bin);
    command
        .arg("serve")
        .args(&launch.serve_args)
        .env_clear()
        .envs(&launch.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let latch = Latch::default();
    let (server, input, output) = start_server(command, &bin, &latch);
    let stopping = Rc::new(Cell::new(false));
    let mut listener = Listener::new(&[libc::SIGINT, libc::SIGTERM, libc::SIGHUP]);
    let (stop, stopped) = (latch.clone(), stopping.clone());
    let signals = tokio::task::spawn_local(async move {
        loop {
            listener.recv().await;
            stopped.set(true);
            stop.finish(0);
        }
    });
    let host = MuseHost::start(input, output, Box::new(on_message));
    let run = Run {
        launch: &launch,
        env: &run_env,
        broker: &broker,
        router_env: call.env,
        cwd,
        server: &server,
        host: host.clone(),
        latch,
        stopping,
        unlaunch: RefCell::new(None),
        waker: RefCell::new(None),
        channel: RefCell::new(None),
    };
    let result = run.serve().await;
    signals.abort();
    let _ = signals.await;
    let result = match result {
        Err(_) if server.died() => Err(run.failure()),
        other => other,
    };
    let waker = run.waker.borrow().clone();
    if let Some(waker) = waker {
        waker.close();
    }
    let channel = run.channel.borrow().clone();
    if let Some(channel) = channel {
        channel.end().await;
    }
    host.close("muse serve closed");
    host.end();
    server.terminate(TERMINATE_MS).await;
    if let Some(file) = run.unlaunch.borrow_mut().take() {
        file.remove();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn serve_arguments_get_the_defaults_a_headless_session_needs() {
        let env = Env::new();
        let parsed = muse_launch(&w(&["--name=lead", "--model", "m"]), &env).unwrap();
        assert_eq!(parsed.name.as_deref(), Some("lead"));
        assert_eq!(parsed.approval_mode, "onRequest");
        assert_eq!(
            parsed.serve_args,
            w(&[MUSE_MODE, "off", NO_USER_INPUT, "--model", "m"])
        );
        let own = muse_launch(
            &w(&[
                "--approval-mode",
                "never",
                "--",
                MUSE_MODE,
                "on",
                NO_USER_INPUT,
            ]),
            &env,
        )
        .unwrap();
        assert_eq!(own.approval_mode, "allowAll");
        assert_eq!(own.serve_args, w(&[MUSE_MODE, "on", NO_USER_INPUT]));
    }

    #[test]
    fn bad_values_are_refused() {
        let env = Env::new();
        assert_eq!(
            muse_launch(&w(&["--approval-mode=yes"]), &env),
            Err(usage(format!(
                "{CLI_NAME} muse --approval-mode takes never, on-request or untrusted, not \"yes\""
            )))
        );
        assert_eq!(
            muse_launch(&w(&["--resume"]), &env),
            Err(usage(format!("{CLI_NAME} muse --resume takes a value")))
        );
        assert_eq!(
            muse_launch(&w(&[MUSE_MODE]), &env),
            Err(usage(format!(
                "{CLI_NAME} muse: muse runs with {MUSE_MODE} off or on, not a bare flag"
            )))
        );
        assert_eq!(
            muse_launch(&w(&[MUSE_MODE, "max"]), &env),
            Err(usage(format!(
                "{CLI_NAME} muse: muse runs with {MUSE_MODE} off or on, not \"max\""
            )))
        );
    }

    #[test]
    fn a_command_id_is_a_version_7_uuid_of_the_time() {
        let id = uuidv7(0x0123_4567_89ab);
        assert_eq!(&id[..13], "01234567-89ab");
        assert_eq!(&id[14..15], "7");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    }

    #[test]
    fn the_broker_is_the_default_one_under_home() {
        let env = Env::from([
            ("HOME".to_owned(), "/h".to_owned()),
            ("SCP_DIR".to_owned(), "/elsewhere".to_owned()),
            ("XDG_STATE_HOME".to_owned(), "/s".to_owned()),
        ]);
        assert_eq!(muse_broker(&env), "/h/.local/state/scp");
    }
}
