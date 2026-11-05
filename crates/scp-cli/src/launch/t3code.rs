//! `swarm t3code`: holds an agent endpoint for one T3 Code thread and hands it each batch of relay messages as a user message.

use super::attribute::{Placement, attribute, attributed, validate_under};
use super::channel::{
    Channel, ChannelSetup, Latch, Transport, address_in, broker_connect, launcher_claim, pushed,
    result_text,
};
use super::ws::{Link, Upgrade};
use crate::args::js_string;
use crate::claude::bg_io::exec_with;
use crate::fleet::json::Json;
use crate::fleet::view::truthy;
use crate::help;
use crate::open::block_on;
use crate::spawn::argv::{home, which_on_path};
use crate::spawn::signals::Listener;
use crate::spawn::text::{hex, random_bytes, random_uuid};
use crate::{Call, Done, Fail, route, term, usage};
use scp_core::address::valid_handle;
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::client::CallError;
use scp_mcp::identity::{field, relay_dir, safe_cwd};
use scp_mcp::ps::{Env, join};
use scp_mcp::render::js_space;
use scp_mcp::tools::js_trim;
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::time::Duration;
use tokio::sync::oneshot;

/// the active-run statuses of a T3 Code run
const ACTIVE: [&str; 4] = ["preparing", "starting", "running", "waiting"];
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const RETRY: Duration = Duration::from_secs(2);
const ISSUE_TIMEOUT_MS: u64 = 30_000;
const ISSUE_MAX_BUFFER: usize = 1024 * 1024;

/// `swarm t3code` as parsed, with a fresh session and harness t3code in its environment
#[derive(Debug, Clone, PartialEq, Default)]
pub struct T3Launch {
    pub name: Option<String>,
    pub root: bool,
    pub under: Option<String>,
    pub thread: String,
    pub base_dir: Option<String>,
    pub env: Env,
}

pub fn t3_launch(args: &[String], env: &Env) -> Result<T3Launch, Fail> {
    let mut parsed = T3Launch::default();
    let mut thread = None;
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        if arg == "--root" {
            parsed.root = true;
            i += 1;
            continue;
        }
        let eq = if arg.starts_with("--") {
            arg.find('=').filter(|eq| *eq > 0)
        } else {
            None
        };
        let flag = eq.map_or(arg.as_str(), |eq| &arg[..eq]);
        if !["--under", "--name", "--as", "--thread", "--base-dir"].contains(&flag) {
            return Err(usage(format!(
                "{CLI_NAME} t3code takes --name, --root, --under, --thread and --base-dir, not {}",
                js_string(arg)
            )));
        }
        let value = match eq {
            Some(eq) => Some(arg[eq + 1..].to_owned()),
            None => {
                i += 1;
                args.get(i).cloned()
            }
        };
        let Some(value) = value.filter(|value| !value.is_empty()) else {
            return Err(usage(format!("{CLI_NAME} t3code {flag} takes a value")));
        };
        match flag {
            "--under" => parsed.under = Some(value),
            "--thread" => thread = Some(value),
            "--base-dir" => parsed.base_dir = Some(value),
            _ => parsed.name = Some(value),
        }
        i += 1;
    }
    let Some(thread) = thread else {
        return Err(usage(format!(
            "{CLI_NAME} t3code needs --thread THREAD: the T3 Code thread its messages wake"
        )));
    };
    parsed.thread = thread;
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
    let mut clean = env.clone();
    for key in ["SCP_PARENT", "SCP_HARNESS_PID"] {
        clean.remove(key);
    }
    clean.insert("SCP_HARNESS".into(), "t3code".into());
    clean.insert("SCP_SESSION".into(), hex(&random_bytes::<16>()));
    if let Some(name) = &parsed.name {
        clean.insert("SCP_NAME".into(), name.clone());
    }
    parsed.env = clean;
    Ok(parsed)
}

/// T3 Code's data directory: --base-dir, else $T3CODE_HOME, else ~/.t3
pub fn t3_home(env: &Env, base_dir: Option<&str>) -> String {
    base_dir
        .filter(|dir| !dir.is_empty())
        .map(str::to_owned)
        .or_else(|| env.get("T3CODE_HOME").filter(|d| !d.is_empty()).cloned())
        .unwrap_or_else(|| join(&[&home(env), ".t3"]))
}

#[derive(Debug, Clone, PartialEq)]
pub struct T3Server {
    pub host: String,
    pub port: f64,
}

fn pid_alive(pid: i64) -> bool {
    // SAFETY: signal 0 only checks that the process exists
    if unsafe { libc::kill(pid as i32, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn loopback(host: &str) -> String {
    if host.is_empty() || host == "0.0.0.0" || host == "::" || host == "[::]" {
        return "127.0.0.1".into();
    }
    host.strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host)
        .to_owned()
}

/// `Number(value)`
fn js_number(value: Option<&Json>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Json::Null) => 0.0,
        Some(Json::Bool(on)) => f64::from(u8::from(*on)),
        Some(Json::Num(n)) => *n,
        Some(Json::Str(text)) => {
            let text = text.trim_matches(js_space);
            if text.is_empty() {
                0.0
            } else if text
                .chars()
                .all(|c| c.is_ascii_digit() || "+-.eE".contains(c))
            {
                text.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
        Some(Json::Arr(items)) => match items.as_slice() {
            [] => 0.0,
            [one] => js_number(Some(one)),
            _ => f64::NAN,
        },
        Some(Json::Obj(_)) => f64::NAN,
    }
}

fn integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

/// the server to connect to: $SCP_T3_URL, else the one `dir`'s server-runtime.json names while its process runs
pub fn t3_server(env: &Env, dir: &str, alive: &dyn Fn(i64) -> bool) -> Result<T3Server, Fail> {
    if let Some(given) = env.get("SCP_T3_URL").filter(|url| !url.is_empty()) {
        let Ok(url) = reqwest::Url::parse(given) else {
            return Err(usage(format!(
                "$SCP_T3_URL {} is not a URL",
                js_string(given)
            )));
        };
        if url.scheme() != "http" && url.scheme() != "ws" {
            return Err(usage(format!(
                "$SCP_T3_URL takes an http:// or ws:// address, not {}:",
                url.scheme()
            )));
        }
        return Ok(T3Server {
            host: loopback(url.host_str().unwrap_or("")),
            port: f64::from(url.port().unwrap_or(80)),
        });
    }
    let file = join(&[dir, "userdata", "server-runtime.json"]);
    let runtime = std::fs::read(&file)
        .ok()
        .and_then(|bytes| Json::parse(String::from_utf8_lossy(&bytes).as_bytes()));
    let Some(runtime) = runtime else {
        return Err(usage(format!(
            "{CLI_NAME} t3code: no T3 Code server runs for {dir} (no {file}): start T3 Code or t3 serve, or set $SCP_T3_URL"
        )));
    };
    if matches!(runtime, Json::Null) {
        return Err(Fail::Call(CallError::Io(
            "Cannot read properties of null (reading 'port')".into(),
        )));
    }
    let port = js_number(runtime.get("port"));
    let pid = js_number(runtime.get("pid"));
    let Some(host) = runtime
        .get("host")
        .and_then(Json::as_str)
        .filter(|_| integer(port) && port > 0.0)
    else {
        return Err(usage(format!(
            "{CLI_NAME} t3code: {file} names no server address"
        )));
    };
    if integer(pid) && pid > 0.0 && !alive(pid as i64) {
        return Err(usage(format!(
            "{CLI_NAME} t3code: the T3 Code server {file} names (pid {}) is not running: start T3 Code or t3 serve",
            pid as i64
        )));
    }
    Ok(T3Server {
        host: loopback(host),
        port,
    })
}

/// the t3 arguments that issue a token for reading threads and sending to them
pub fn issue_argv(dir: &str) -> Vec<String> {
    let label = format!("{CLI_NAME} t3code");
    [
        "auth",
        "session",
        "issue",
        "--base-dir",
        dir,
        "--scope",
        "orchestration:read",
        "--scope",
        "orchestration:operate",
        "--ttl",
        "30d",
        "--label",
        &label,
        "--token-only",
    ]
    .iter()
    .map(|word| (*word).to_owned())
    .collect()
}

/// `$SCP_T3_TOKEN`, else a token t3 issues for `dir`
async fn t3_token(env: &Env, dir: &str) -> Result<String, Fail> {
    if let Some(given) = env
        .get("SCP_T3_TOKEN")
        .map(|token| js_trim(token))
        .filter(|token| !token.is_empty())
    {
        return Ok(given.to_owned());
    }
    let bin = env
        .get("SCP_T3_BIN")
        .filter(|bin| !bin.is_empty())
        .cloned()
        .or_else(|| which_on_path("t3", env));
    let Some(bin) = bin else {
        return Err(usage(format!(
            "{CLI_NAME} t3code: no token: set $SCP_T3_TOKEN, or put t3 on PATH (or set $SCP_T3_BIN) to issue one"
        )));
    };
    let argv = issue_argv(dir);
    let words: Vec<&str> = argv.iter().map(String::as_str).collect();
    let started = std::time::Instant::now();
    let ran = exec_with(
        &bin,
        &words,
        ISSUE_TIMEOUT_MS,
        ISSUE_MAX_BUFFER,
        env,
        None,
        std::process::Stdio::null(),
    )
    .await;
    let timed_out = started.elapsed() >= Duration::from_millis(ISSUE_TIMEOUT_MS);
    let unrun = if let Some(code) = &ran.unstarted {
        format!("spawnSync {bin} {code}")
    } else if timed_out && ran.code.is_none() {
        format!("spawnSync {bin} ETIMEDOUT")
    } else {
        String::new()
    };
    let (stdout, stderr) = (
        String::from_utf8_lossy(&ran.stdout).into_owned(),
        format!("{}{unrun}", String::from_utf8_lossy(&ran.stderr)),
    );
    let trimmed = js_trim(&stdout);
    let token = trimmed.rsplit('\n').next().map(js_trim).unwrap_or("");
    if ran.code != Some(0) || token.is_empty() || token.chars().any(js_space) {
        let lines: Vec<&str> = js_trim(&stderr).split('\n').collect();
        let tail = lines[lines.len().saturating_sub(3)..].join(" ");
        let why = if tail.is_empty() {
            String::new()
        } else {
            format!(": {tail}")
        };
        return Err(usage(format!(
            "{CLI_NAME} t3code: {bin} auth session issue failed{why}"
        )));
    }
    Ok(token.to_owned())
}

/// the first reason an Effect RPC failure exit gives
pub fn exit_reason(exit: &Json) -> String {
    for cause in exit.get("cause").map_or(&[][..], Json::items) {
        let error = cause
            .get("error")
            .filter(|e| !matches!(e, Json::Null))
            .or_else(|| cause.get("defect"));
        match error {
            Some(Json::Str(error)) => return error.clone(),
            Some(error @ (Json::Obj(_) | Json::Arr(_))) => {
                let named = |key: &str| error.get(key).filter(|v| !matches!(v, Json::Null));
                return named("message").or_else(|| named("_tag")).map_or_else(
                    || error.compact(),
                    |named| crate::fleet::view::text(Some(named)),
                );
            }
            _ => {}
        }
        if cause.get("_tag").and_then(Json::as_str) == Some("Interrupt") {
            return "interrupted".into();
        }
    }
    exit.compact()
}

type OnValue = Rc<dyn Fn(&Json)>;

struct Stream {
    tag: String,
    on_value: OnValue,
}

/// an Effect RPC client of the T3 Code server's /ws endpoint (JSON framing): requests, and streams it acknowledges chunk by chunk
pub struct T3Socket {
    link: RefCell<Option<Rc<Link>>>,
    next: Cell<u64>,
    pending: RefCell<HashMap<String, oneshot::Sender<Result<Json, String>>>>,
    streams: RefCell<HashMap<String, Stream>>,
}

fn connect_error(error: &std::io::Error, host: &str, port: u16) -> String {
    match scp_mcp::client::errno_code(error) {
        Some(code) => format!("connect {code} {host}:{port}"),
        None => format!("getaddrinfo ENOTFOUND {host}"),
    }
}

impl T3Socket {
    /// `on_close` runs once with the error that ended the connection, a stream's end included
    pub fn connect(server: &T3Server, token: &str, on_close: Box<dyn Fn(&str)>) -> Rc<T3Socket> {
        let socket = Rc::new(T3Socket {
            link: RefCell::new(None),
            next: Cell::new(1),
            pending: RefCell::default(),
            streams: RefCell::default(),
        });
        let (text, closed): (Weak<T3Socket>, Weak<T3Socket>) =
            (Rc::downgrade(&socket), Rc::downgrade(&socket));
        let port = server.port as u16;
        let host = server.host.clone();
        let named = if host.contains(':') {
            format!("[{host}]")
        } else {
            host.clone()
        };
        let upgrade = Upgrade {
            path: Some("/ws?orchestrationProtocol=2".into()),
            host: Some(format!("{named}:{port}")),
            headers: vec![("Authorization".into(), format!("Bearer {token}"))],
        };
        let link = Link::open(
            async move {
                tokio::net::TcpStream::connect((host.as_str(), port))
                    .await
                    .map_err(|error| connect_error(&error, &host, port))
            },
            upgrade,
            "T3 Code",
            Box::new(move |line| {
                if let Some(socket) = text.upgrade() {
                    socket.receive(line);
                }
            }),
            Box::new(move |error| {
                if let Some(socket) = closed.upgrade() {
                    for (_, reply) in socket.pending.borrow_mut().drain() {
                        let _ = reply.send(Err(error.to_owned()));
                    }
                    socket.streams.borrow_mut().clear();
                }
                on_close(error);
            }),
        );
        *socket.link.borrow_mut() = Some(link);
        socket
    }

    fn link(&self) -> Option<Rc<Link>> {
        self.link.borrow().clone()
    }

    fn fail(&self, error: &str) {
        if let Some(link) = self.link() {
            link.fail(error);
        }
    }

    fn send(&self, message: &Json) -> Result<(), String> {
        match self.link() {
            Some(link) => link.send(&message.compact()),
            None => Err("T3 Code socket closed".into()),
        }
    }

    fn receive(&self, text: &str) {
        let Some(message) = Json::parse(text.as_bytes()) else {
            self.fail("Unexpected token in JSON");
            return;
        };
        let id = crate::fleet::view::text(message.get("requestId"));
        match message.get("_tag").and_then(Json::as_str) {
            Some("Chunk") => {
                let on_value = self.streams.borrow().get(&id).map(|s| s.on_value.clone());
                let Some(on_value) = on_value else { return };
                for value in message.get("values").map_or(&[][..], Json::items) {
                    on_value(value);
                }
                let _ = self.send(&Json::object(vec![
                    ("_tag", Json::str("Ack")),
                    ("requestId", Json::str(id)),
                ]));
            }
            Some("Exit") => {
                let empty = Json::Obj(Vec::new());
                let exit = message
                    .get("exit")
                    .filter(|e| !matches!(e, Json::Null))
                    .unwrap_or(&empty);
                let failure = exit.get("_tag").and_then(Json::as_str) == Some("Failure");
                let stream = self.streams.borrow_mut().remove(&id);
                if let Some(stream) = stream {
                    let why = if failure {
                        format!(": {}", exit_reason(exit))
                    } else {
                        String::new()
                    };
                    self.fail(&format!("T3 Code ended {}{why}", stream.tag));
                    return;
                }
                let Some(reply) = self.pending.borrow_mut().remove(&id) else {
                    return;
                };
                let _ = reply.send(
                    if exit.get("_tag").and_then(Json::as_str) == Some("Success") {
                        Ok(exit
                            .get("value")
                            .filter(|v| !matches!(v, Json::Null))
                            .cloned()
                            .unwrap_or(Json::Obj(Vec::new())))
                    } else {
                        Err(exit_reason(exit))
                    },
                );
            }
            Some("Ping") => {
                let _ = self.send(&Json::object(vec![("_tag", Json::str("Pong"))]));
            }
            Some("Defect") => {
                let defect = message
                    .get("defect")
                    .map_or_else(|| "undefined".to_owned(), Json::compact);
                self.fail(&format!("T3 Code failed: {defect}"));
            }
            _ => {}
        }
    }

    pub async fn ready(&self) -> Result<(), String> {
        match self.link() {
            Some(link) => link.ready().await,
            None => Err("T3 Code socket closed".into()),
        }
    }

    fn request_line(&self, id: &str, tag: &str, payload: Json) -> Json {
        Json::object(vec![
            ("_tag", Json::str("Request")),
            ("id", Json::str(id)),
            ("tag", Json::str(tag)),
            ("payload", payload),
            ("headers", Json::Arr(Vec::new())),
        ])
    }

    fn take_id(&self) -> String {
        let id = self.next.get();
        self.next.set(id + 1);
        id.to_string()
    }

    fn ask(
        self: Rc<Self>,
        tag: String,
        payload: Json,
    ) -> LocalFuture<'static, Result<Json, String>> {
        Box::pin(async move {
            self.ready().await?;
            let id = self.take_id();
            let (reply, answer) = oneshot::channel();
            self.pending.borrow_mut().insert(id.clone(), reply);
            if let Err(error) = self.send(&self.request_line(&id, &tag, payload)) {
                self.pending.borrow_mut().remove(&id);
                return Err(error);
            }
            match tokio::time::timeout(REQUEST_TIMEOUT, answer).await {
                Ok(Ok(reply)) => reply,
                Ok(Err(_)) => Err("T3 Code socket closed".into()),
                Err(_) => {
                    self.pending.borrow_mut().remove(&id);
                    Err(format!("T3 Code {tag} timed out"))
                }
            }
        })
    }

    /// a stream the connection holds for its life: its end closes the connection
    pub async fn subscribe(
        &self,
        tag: &str,
        payload: Json,
        on_value: OnValue,
    ) -> Result<(), String> {
        self.ready().await?;
        let id = self.take_id();
        let stream = Stream {
            tag: tag.to_owned(),
            on_value,
        };
        self.streams.borrow_mut().insert(id.clone(), stream);
        self.send(&self.request_line(&id, tag, payload))
    }

    pub fn close(&self) {
        self.fail("T3 Code socket closed");
    }
}

struct Socket(Rc<T3Socket>);

impl Transport for Socket {
    fn request(&self, method: &str, params: Json) -> LocalFuture<'static, Result<Json, String>> {
        self.0.clone().ask(method.to_owned(), params)
    }
}

/// the run a T3 Code thread is busy with, from its projection's runs
pub fn active_run(runs: Option<&Json>) -> Option<String> {
    let run = runs?.items().iter().rev().find(|run| {
        let status = crate::fleet::view::text(run.get("status"));
        ACTIVE.contains(&status.as_str())
    })?;
    run.get("id").and_then(Json::as_str).map(str::to_owned)
}

/// hands channel messages to one T3 Code thread as a user message: a new turn when it is idle, a steer of the active run otherwise;
/// retried every 2 s
pub struct T3Waker {
    transport: Rc<dyn Transport>,
    thread_id: String,
    retry: Duration,
    log: Box<dyn Fn(&str)>,
    queue: RefCell<Vec<String>>,
    busy: Cell<bool>,
    timer: RefCell<Option<tokio::task::JoinHandle<()>>>,
    stopped: Cell<bool>,
    failing: Cell<bool>,
    active: RefCell<Option<String>>,
    deleted: Cell<bool>,
}

impl T3Waker {
    pub fn new(
        transport: Rc<dyn Transport>,
        thread_id: &str,
        retry: Duration,
        log: Box<dyn Fn(&str)>,
    ) -> Rc<T3Waker> {
        Rc::new(T3Waker {
            transport,
            thread_id: thread_id.to_owned(),
            retry,
            log,
            queue: RefCell::default(),
            busy: Cell::new(false),
            timer: RefCell::new(None),
            stopped: Cell::new(false),
            failing: Cell::new(false),
            active: RefCell::new(None),
            deleted: Cell::new(false),
        })
    }

    /// a thread shell from the shell stream: the thread's active run
    pub fn thread(&self, shell: &Json) {
        if shell.get("id").and_then(Json::as_str) != Some(self.thread_id.as_str()) {
            return;
        }
        *self.active.borrow_mut() = shell
            .get("activeRunId")
            .and_then(Json::as_str)
            .map(str::to_owned);
        if truthy(shell.get("deletedAt")) {
            self.deleted.set(true);
        }
    }

    pub fn push(self: &Rc<Self>, text: &str) {
        self.queue.borrow_mut().push(text.to_owned());
        self.flush();
    }

    /// the dispatch of `text`: the server settles a stale view itself (deliveryIntent auto)
    pub fn command(&self, text: &str) -> Json {
        let mode = match self.active.borrow().as_deref() {
            Some(run) if !run.is_empty() => Json::object(vec![
                ("type", Json::str("steer_active")),
                ("targetRunId", Json::str(run)),
            ]),
            _ => Json::object(vec![("type", Json::str("start_immediately"))]),
        };
        Json::object(vec![
            ("type", Json::str("message.dispatch")),
            ("commandId", Json::str(random_uuid())),
            ("createdBy", Json::str("user")),
            ("creationSource", Json::str("server")),
            ("threadId", Json::str(self.thread_id.clone())),
            ("messageId", Json::str(random_uuid())),
            ("text", Json::str(text)),
            ("attachments", Json::Arr(Vec::new())),
            ("dispatchMode", mode),
            ("deliveryIntent", Json::str("auto")),
        ])
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
        self.busy.set(true);
        let reply = self
            .transport
            .request("orchestration.dispatchCommand", self.command(&text));
        let waker = self.clone();
        tokio::task::spawn_local(async move {
            let ok = match reply.await {
                Ok(_) => {
                    waker.queue.borrow_mut().drain(..count);
                    waker.failing.set(false);
                    true
                }
                Err(error) => {
                    if !waker.failing.get() && !waker.stopped.get() {
                        (waker.log)(&format!(
                            "{CLI_NAME} t3code: T3 Code did not take the message ({error}); retrying every 2 s"
                        ));
                    }
                    waker.failing.set(true);
                    false
                }
            };
            waker.busy.set(false);
            if waker.stopped.get() || waker.queue.borrow().is_empty() {
                return;
            }
            if ok {
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

/// the threads a shell stream value names
fn shell_threads(value: &Json) -> Vec<&Json> {
    if value.get("kind").and_then(Json::as_str) == Some("snapshot") {
        return value
            .get("snapshot")
            .and_then(|snapshot| snapshot.get("threads"))
            .map_or_else(Vec::new, |threads| threads.items().iter().collect());
    }
    value
        .get("thread")
        .filter(|thread| truthy(Some(thread)))
        .into_iter()
        .collect()
}

/// `swarm t3code`: holds an endpoint and wakes one T3 Code thread with each batch of new messages
pub fn t3code(call: &Call, args: &[String]) -> Done {
    if matches!(args.first().map(String::as_str), Some("--help" | "-h")) {
        return help::show_text(help::T3CODE);
    }
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let mut env = call.env.clone();
    route::caller_argv(&mut env);
    let cwd = safe_cwd();
    let parsed = t3_launch(args, &env)?;
    let dir = t3_home(&env, parsed.base_dir.as_deref());
    let server = t3_server(&env, &dir, &pid_alive)?;
    block_on(launch(call, args, &env, &cwd, parsed, dir, server))?
}

/// a run's end, and the signals that bring it
struct Run {
    latch: Latch,
    stopping: Rc<Cell<bool>>,
    live: Rc<Cell<bool>>,
}

impl Run {
    fn on_close(&self) -> Box<dyn Fn(&str)> {
        let (latch, stopping, live) =
            (self.latch.clone(), self.stopping.clone(), self.live.clone());
        Box::new(move |error| {
            if stopping.get() || !live.get() {
                return;
            }
            term::err(&format!(
                "{CLI_NAME} t3code: the T3 Code connection closed: {error}"
            ));
            latch.finish(1);
        })
    }
}

/// the attached part of a run: the T3 Code connection up, the channel joined
#[allow(clippy::too_many_arguments)]
async fn serve(
    run: &Run,
    socket: &Rc<T3Socket>,
    launch: &T3Launch,
    router_env: &Env,
    cwd: &str,
    place: &str,
    held_waker: &RefCell<Option<Rc<T3Waker>>>,
    held_channel: &RefCell<Option<Rc<Channel>>>,
) -> Done {
    let ready = tokio::time::timeout(CONNECT_TIMEOUT, socket.ready()).await;
    let connected = match ready {
        Ok(result) => result,
        Err(_) => Err("timed out".to_owned()),
    };
    if let Err(why) = connected {
        let refused = if why
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .any(|word| word == "401")
        {
            " (the token was refused)"
        } else {
            ""
        };
        return Err(usage(format!(
            "{CLI_NAME} t3code: could not connect to T3 Code at {place}: {why}{refused}"
        )));
    }
    run.live.set(true);
    let thread = launch.thread.clone();
    let payload = Json::object(vec![("threadId", Json::str(thread.clone()))]);
    let projection = socket
        .clone()
        .ask("orchestration.getThreadProjection".into(), payload)
        .await
        .map_err(|why| {
            usage(format!(
                "{CLI_NAME} t3code: T3 Code has no thread {thread} ({why})"
            ))
        })?;
    if run.stopping.get() {
        return Ok(0);
    }
    let waker = T3Waker::new(
        Rc::new(Socket(socket.clone())),
        &thread,
        RETRY,
        Box::new(term::err),
    );
    *held_waker.borrow_mut() = Some(waker.clone());
    *waker.active.borrow_mut() = active_run(projection.get("runs"));
    let (shells, stopping, latch, named) = (
        waker.clone(),
        run.stopping.clone(),
        run.latch.clone(),
        thread.clone(),
    );
    socket
        .subscribe(
            "orchestration.subscribeShell",
            Json::Obj(Vec::new()),
            Rc::new(move |value| {
                for shell in shell_threads(value) {
                    shells.thread(shell);
                }
                if shells.deleted.get() && !stopping.get() {
                    term::err(&format!(
                        "{CLI_NAME} t3code: T3 Code deleted thread {named}"
                    ));
                    latch.finish(1);
                }
            }),
        )
        .await
        .map_err(|error| Fail::Call(CallError::Io(error)))?;
    let pid = i64::from(std::process::id());
    let claim = launcher_claim("t3code", cwd, &launch.env, pid);
    let handle = field(&claim, "handle").to_owned();
    if !valid_handle(&handle) {
        return Err(usage(format!(
            "{} is not a valid agent handle",
            js_string(&handle)
        )));
    }
    let broker = relay_dir(&launch.env);
    let (joined, whoami) = oneshot::channel::<Value>();
    let joined = RefCell::new(Some(joined));
    let pushing = waker.clone();
    let channel = Rc::new(Channel::start(
        ChannelSetup {
            connect: broker_connect(&broker, router_env),
            claim,
            wake: "t3code",
            env: launch.env.clone(),
            log: Rc::new(term::err),
            on_message: Rc::new(move |message| {
                if message.get("id").and_then(Value::as_i64) == Some(2)
                    && let Some(joined) = joined.borrow_mut().take()
                {
                    let result = message.get("result").cloned().unwrap_or(Value::Null);
                    let _ = joined.send(result);
                }
                if let Some(content) = pushed(message) {
                    pushing.push(content);
                }
            }),
        },
        Rc::new(Cell::new(false)),
    ));
    *held_channel.borrow_mut() = Some(channel.clone());
    channel.initialize("scp-t3code").await;
    channel.whoami().await;
    let result = tokio::select! {
        result = whoami => result.ok(),
        code = run.latch.done() => return Ok(code),
    };
    let Some(result) = result else {
        return Ok(run.latch.done().await);
    };
    let text = result_text(&result);
    let address = address_in(&text).map(str::to_owned);
    let failed = scp_mcp::tools::truthy(result.get("isError"));
    let Some(address) = address.filter(|_| !failed) else {
        let why = if text.is_empty() { "no answer" } else { &text };
        return Err(usage(format!(
            "{CLI_NAME} t3code: could not join the relay: {why}"
        )));
    };
    term::err(&format!(
        "{CLI_NAME} t3code: {address} waking T3 Code thread {thread} at {place}"
    ));
    Ok(run.latch.done().await)
}

async fn launch(
    call: &Call<'_>,
    args: &[String],
    env: &Env,
    cwd: &str,
    parsed: T3Launch,
    dir: String,
    server: T3Server,
) -> Done {
    let token = t3_token(env, &dir).await?;
    let warn = |line: &str| term::err(line);
    let placement = Placement {
        name: parsed.name.as_deref(),
        root: parsed.root,
        under: parsed.under.as_deref(),
        resume: false,
        dir: None,
    };
    let attribution = attribute("t3code", placement, call.env, cwd, &warn).await?;
    let launch = match &attribution {
        Some(attribution) => t3_launch(args, &attributed(env, Some(attribution)))?,
        None => parsed,
    };
    if server.port > 65535.0 {
        return Err(Fail::Call(CallError::Io(format!(
            "Port should be >= 0 and < 65536. Received type number ({}).",
            server.port as i64
        ))));
    }
    let run = Run {
        latch: Latch::default(),
        stopping: Rc::new(Cell::new(false)),
        live: Rc::new(Cell::new(false)),
    };
    let socket = T3Socket::connect(&server, &token, run.on_close());
    let place = format!("{}:{}", server.host, server.port as u16);
    let mut listener = Listener::new(&[libc::SIGINT, libc::SIGTERM, libc::SIGHUP]);
    let (stop, stopped) = (run.latch.clone(), run.stopping.clone());
    let signals = tokio::task::spawn_local(async move {
        loop {
            listener.recv().await;
            stopped.set(true);
            stop.finish(0);
        }
    });
    let waker = RefCell::new(None);
    let channel = RefCell::new(None);
    let result = serve(
        &run, &socket, &launch, call.env, cwd, &place, &waker, &channel,
    )
    .await;
    signals.abort();
    let _ = signals.await;
    run.stopping.set(true);
    let held = waker.borrow().clone();
    if let Some(waker) = held {
        waker.close();
    }
    let open = channel.borrow().clone();
    if let Some(channel) = open {
        channel.end().await;
    }
    socket.close();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn the_flags_are_all_it_takes() {
        let env = Env::from([
            ("SCP_SESSION".to_owned(), "caller".to_owned()),
            ("SCP_HARNESS_PID".to_owned(), "1".to_owned()),
        ]);
        let parsed = t3_launch(
            &w(&["--thread=t", "--name", "me/x", "--base-dir", "/b"]),
            &env,
        )
        .unwrap();
        assert_eq!(parsed.thread, "t");
        assert_eq!(parsed.name.as_deref(), Some("x"));
        assert_eq!(parsed.base_dir.as_deref(), Some("/b"));
        assert_eq!(parsed.env["SCP_HARNESS"], "t3code");
        assert_eq!(parsed.env["SCP_SESSION"].len(), 32);
        assert!(!parsed.env.contains_key("SCP_HARNESS_PID"));
        assert_eq!(
            t3_launch(&w(&["--model"]), &env),
            Err(usage(format!(
                "{CLI_NAME} t3code takes --name, --root, --under, --thread and --base-dir, not \"--model\""
            )))
        );
        assert_eq!(
            t3_launch(&w(&["--thread="]), &env),
            Err(usage(format!("{CLI_NAME} t3code --thread takes a value")))
        );
        assert_eq!(
            t3_launch(&[], &env),
            Err(usage(format!(
                "{CLI_NAME} t3code needs --thread THREAD: the T3 Code thread its messages wake"
            )))
        );
    }

    #[test]
    fn a_url_names_the_server_and_any_host_means_this_one() {
        let at = |url: &str| {
            let env = Env::from([("SCP_T3_URL".to_owned(), url.to_owned())]);
            t3_server(&env, "/none", &|_| true)
        };
        assert_eq!(
            at("http://[::1]:8080"),
            Ok(T3Server {
                host: "::1".into(),
                port: 8080.0
            })
        );
        assert_eq!(
            at("ws://0.0.0.0"),
            Ok(T3Server {
                host: "127.0.0.1".into(),
                port: 80.0
            })
        );
        assert_eq!(
            at("https://x"),
            Err(usage(
                "$SCP_T3_URL takes an http:// or ws:// address, not https:"
            ))
        );
        assert_eq!(at("nope"), Err(usage("$SCP_T3_URL \"nope\" is not a URL")));
    }

    #[test]
    fn an_exit_gives_its_first_reason() {
        let parse = |text: &str| Json::parse(text.as_bytes()).unwrap();
        assert_eq!(
            exit_reason(&parse("{\"cause\":[{\"error\":\"boom\"}]}")),
            "boom"
        );
        assert_eq!(
            exit_reason(&parse("{\"cause\":[{\"defect\":{\"message\":\"m\"}}]}")),
            "m"
        );
        assert_eq!(
            exit_reason(&parse("{\"cause\":[{\"error\":{\"_tag\":\"T\"}}]}")),
            "T"
        );
        assert_eq!(
            exit_reason(&parse("{\"cause\":[{\"error\":{\"x\":1,\"a\":2}}]}")),
            "{\"x\":1,\"a\":2}"
        );
        assert_eq!(
            exit_reason(&parse("{\"cause\":[{\"_tag\":\"Interrupt\"}]}")),
            "interrupted"
        );
        assert_eq!(exit_reason(&parse("{\"a\":1}")), "{\"a\":1}");
    }

    #[test]
    fn the_last_active_run_counts() {
        let runs = Json::parse(
            b"[{\"id\":\"a\",\"status\":\"running\"},{\"id\":\"b\",\"status\":\"starting\"},{\"id\":\"c\",\"status\":\"done\"}]",
        )
        .unwrap();
        assert_eq!(active_run(Some(&runs)).as_deref(), Some("b"));
        assert_eq!(active_run(None), None);
    }
}
