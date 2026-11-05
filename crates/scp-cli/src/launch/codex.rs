//! `swarm codex`: an app-server with relay messages waking an idle thread or steering a running turn, and either a remote TUI or, with
//! `--headless`, an ambient thread of its own.

use super::attribute::{Placement, attribute, attributed, options_before, validate_under};
use super::channel::{
    Channel, ChannelSetup, Latch, Server, Transport, Watched, bind_channel, broker_connect,
    default_signals, launcher_claim, os_tmpdir, pushed, spawn_error, start_server, temp_dir,
};
use super::ws::{Link, Upgrade};
use crate::args::js_string;
use crate::fleet::json::Json;
use crate::open::{block_on, node_fs_error};
use crate::spawn::argv::{
    codex_mount, codex_overrides, entries, home, lossless, native_mount_bin, toml,
};
use crate::spawn::codex_queue::{Owner, codex_owner};
use crate::spawn::signals::Listener;
use crate::spawn::text::{hex, random_bytes};
use crate::{Call, Done, Fail, route, term, usage};
use scp_core::address::valid_handle;
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::client::CallError;
use scp_mcp::identity::{codex_thread, field, relay_dir, safe_cwd};
use scp_mcp::ps::{CODEX_VALUED, Env, PS_TIMEOUT_MS, join, read_ps_table};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use toml::Value as Toml;

const WAKER_NAME: &str = "scp-waker";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const RETRY: Duration = Duration::from_secs(2);
const TERMINATE_MS: u64 = 2000;
const READY_MS: u64 = 20_000;
const INITIALIZE_MS: u64 = 1000;

/// `swarm codex` as parsed: the launcher's flags, then codex's own arguments and environment
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CodexLaunch {
    pub name: Option<String>,
    pub headless: bool,
    pub root: bool,
    pub under: Option<String>,
    pub resume: Option<String>,
    pub codex_args: Vec<String>,
    pub env: Env,
}

/// the codex arguments and environment, without the launching session's identity
pub fn codex_launch(args: &[String], env: &Env) -> Result<CodexLaunch, Fail> {
    let mut parsed = CodexLaunch::default();
    let mut codex_args: Vec<String> = Vec::new();
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        if arg == "--" {
            let from = if codex_args.is_empty() { i + 1 } else { i };
            codex_args.extend_from_slice(&args[from..]);
            break;
        }
        if arg == "--name" || arg == "--as" {
            i += 1;
            let Some(name) = args.get(i) else {
                return Err(usage(format!("{CLI_NAME} codex {arg} takes a name")));
            };
            parsed.name = Some(name.clone());
        } else if arg.starts_with("--name=") || arg.starts_with("--as=") {
            parsed.name = Some(arg[arg.find('=').unwrap_or(0) + 1..].to_owned());
        } else if arg == "--headless" {
            parsed.headless = true;
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
        } else if arg == "--resume" {
            i += 1;
            let Some(thread) = args.get(i) else {
                return Err(usage(format!("{CLI_NAME} codex --resume takes a thread")));
            };
            parsed.resume = Some(thread.clone());
        } else if let Some(thread) = arg.strip_prefix("--resume=") {
            parsed.resume = Some(thread.to_owned());
        } else {
            codex_args.push(arg.clone());
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
    let mut clean = env.clone();
    for key in ["SCP_SESSION", "SCP_PARENT", "SCP_CODEX_THREAD"] {
        clean.remove(key);
    }
    clean.insert("SCP_HARNESS".into(), "codex".into());
    clean.insert("SCP_SHIM_BINDING".into(), hex(&random_bytes::<16>()));
    if let Some(name) = &parsed.name {
        clean.insert("SCP_NAME".into(), name.clone());
    }
    if let Some(thread) = parsed.resume.as_ref().filter(|t| codex_thread(t)) {
        clean.insert("SCP_CODEX_THREAD".into(), thread.clone());
    }
    parsed.codex_args = match &parsed.resume {
        Some(resume) if !parsed.headless => {
            let mut all = vec!["resume".to_owned(), resume.clone()];
            all.extend(codex_args);
            all
        }
        _ => codex_args,
    };
    parsed.env = clean;
    Ok(parsed)
}

fn owner_name(owner: Owner) -> String {
    match owner {
        Owner::Desktop => "the Codex desktop app".into(),
        Owner::Scp => format!("another {CLI_NAME} codex"),
        Owner::Ide => "an IDE's Codex".into(),
        Owner::Exec => "a running codex exec".into(),
        Owner::Tui => "a codex session".into(),
        Owner::AppServer => "another Codex app server".into(),
        _ => "another process".into(),
    }
}

/// why `swarm codex --resume` cannot open `thread`: another surface holds it
fn held_thread_text(thread: &str, owner: Owner) -> String {
    format!(
        "{CLI_NAME} codex: thread {thread} is open in {}, which holds it. Close it there, or run `codex fork {thread}` to continue it in a new thread",
        owner_name(owner)
    )
}

/// the last value `names` gives among `args`
fn option(args: &[String], names: &[&str]) -> Result<Option<String>, Fail> {
    let mut value = None;
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        if names.contains(&arg.as_str()) {
            i += 1;
            let Some(given) = args.get(i) else {
                return Err(usage(format!("{CLI_NAME} codex {arg} takes a value")));
            };
            value = Some(given.clone());
        } else if names
            .iter()
            .any(|name| arg.strip_prefix(name).is_some_and(|r| r.starts_with('=')))
        {
            value = Some(arg[arg.find('=').unwrap_or(0) + 1..].to_owned());
        }
        i += 1;
    }
    Ok(value)
}

const SERVER_CONFIG: [&str; 4] = ["-c", "--config", "--enable", "--disable"];

fn server_setting(flag: &str) -> Option<&'static str> {
    match flag {
        "-m" | "--model" => Some("model"),
        "-s" | "--sandbox" => Some("sandbox_mode"),
        "-a" | "--ask-for-approval" => Some("approval_policy"),
        _ => None,
    }
}

/// a TOML datetime as the TOML reader's `toISOString` writes it: milliseconds, and the offset as given
fn iso_date(at: &toml::value::Datetime) -> String {
    let mut text = String::new();
    if let Some(date) = &at.date {
        text.push_str(&format!(
            "{:04}-{:02}-{:02}",
            date.year, date.month, date.day
        ));
    }
    if let Some(time) = &at.time {
        if at.date.is_some() {
            text.push('T');
        }
        text.push_str(&format!(
            "{:02}:{:02}:{:02}.{:03}",
            time.hour,
            time.minute,
            time.second,
            time.nanosecond / 1_000_000
        ));
    }
    match at.offset {
        Some(toml::value::Offset::Z) => text.push('Z'),
        Some(toml::value::Offset::Custom { minutes }) => {
            let sign = if minutes < 0 { '-' } else { '+' };
            let minutes = minutes.unsigned_abs();
            text.push_str(&format!("{sign}{:02}:{:02}", minutes / 60, minutes % 60));
        }
        None => {}
    }
    text
}

/// each leaf of `value` as a `-c key=value` override
fn leaves(value: &Toml, path: &mut Vec<String>, out: &mut Vec<String>) {
    match value {
        Toml::Table(table) => {
            for (key, child) in entries(table) {
                path.push(key.clone());
                leaves(child, path, out);
                path.pop();
            }
        }
        _ if path.is_empty() => {}
        Toml::Datetime(at) => {
            out.push("-c".into());
            out.push(format!(
                "{}={}",
                path.join("."),
                toml(&Toml::String(iso_date(at)))
            ));
        }
        leaf => {
            out.push("-c".into());
            out.push(format!("{}={}", path.join("."), toml(leaf)));
        }
    }
}

/// a profile file's overrides, or why it could not be read
fn profile_overrides(file: &str) -> Result<Vec<String>, String> {
    let bytes = std::fs::read(file).map_err(|error| {
        if error.raw_os_error() == Some(libc::EISDIR) {
            "EISDIR: illegal operation on a directory, read".to_owned()
        } else {
            node_fs_error(&error, "open", file)
        }
    })?;
    let table: toml::Table = toml::from_str(&String::from_utf8_lossy(&bytes))
        .map_err(|error| error.message().to_owned())?;
    if !table.values().all(lossless) {
        return Err("integer value cannot be represented losslessly".into());
    }
    let mut out = Vec::new();
    leaves(&Toml::Table(table), &mut Vec::new(), &mut out);
    Ok(out)
}

/// `^mcp_servers\.("scp"|scp)\.`
fn sets_scp(value: &str) -> bool {
    value
        .strip_prefix("mcp_servers.")
        .is_some_and(|rest| rest.starts_with("\"scp\".") || rest.starts_with("scp."))
}

/// the app-server options that give it the configuration `codex` would resolve from these arguments: profile, then -c and features,
/// then model, sandbox and approval
pub fn server_options(
    args: &[String],
    env: &Env,
    warn: &dyn Fn(&str),
) -> Result<Vec<String>, Fail> {
    let mut profile: Vec<String> = Vec::new();
    let mut config: Vec<String> = Vec::new();
    let mut settings: Vec<String> = Vec::new();
    let mut conflict = false;
    let set = |settings: &mut Vec<String>, key: &str, value: &str| {
        settings.push("-c".into());
        settings.push(format!("{key}={}", toml(&Toml::String(value.to_owned()))));
    };
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        if arg == "--" {
            break;
        }
        let eq = if arg.starts_with("--") {
            arg.find('=').filter(|eq| *eq > 0)
        } else {
            None
        };
        let flag = eq.map_or(arg.as_str(), |eq| &arg[..eq]);
        if flag == "--strict-config" {
            config.push(flag.to_owned());
        } else if flag == "--dangerously-bypass-approvals-and-sandbox" || flag == "--yolo" {
            set(&mut settings, "approval_policy", "never");
            set(&mut settings, "sandbox_mode", "danger-full-access");
        }
        if !CODEX_VALUED.contains(&flag) {
            i += 1;
            continue;
        }
        let value = match eq {
            Some(eq) => arg[eq + 1..].to_owned(),
            None => {
                i += 1;
                args.get(i)
                    .cloned()
                    .ok_or_else(|| usage(format!("{CLI_NAME} codex {flag} takes a value")))?
            }
        };
        if SERVER_CONFIG.contains(&flag) {
            conflict = conflict || sets_scp(&value);
            config.push(flag.to_owned());
            config.push(value);
        } else if flag == "-p" || flag == "--profile" {
            let dir = match env.get("CODEX_HOME").filter(|home| !home.is_empty()) {
                Some(dir) => dir.clone(),
                None => join(&[&home(env), ".codex"]),
            };
            let file = join(&[&dir, &format!("{value}.config.toml")]);
            profile.clear();
            if std::fs::metadata(&file).is_ok() {
                match profile_overrides(&file) {
                    Ok(overrides) => profile = overrides,
                    Err(why) => warn(&format!(
                        "{CLI_NAME} codex: could not read profile {file}: {why}"
                    )),
                }
            }
        } else if let Some(key) = server_setting(flag) {
            set(&mut settings, key, &value);
        }
        i += 1;
    }
    if conflict {
        warn(&format!(
            "{CLI_NAME} codex: your -c mcp_servers.scp settings override the ones {CLI_NAME} sets, so messages may not wake this session"
        ));
    }
    profile.extend(config);
    profile.extend(settings);
    Ok(profile)
}

type Replies = HashMap<u64, oneshot::Sender<Result<Json, String>>>;
type OnMessage = Box<dyn Fn(&Json, &CodexSocket)>;

/// a JSON-RPC WebSocket client on a private unix socket
pub struct CodexSocket {
    link: RefCell<Option<Rc<Link>>>,
    next: Cell<u64>,
    pending: RefCell<Replies>,
    on_message: OnMessage,
}

impl CodexSocket {
    pub fn connect(path: &str, on_message: OnMessage) -> Rc<CodexSocket> {
        let socket = Rc::new(CodexSocket {
            link: RefCell::new(None),
            next: Cell::new(1),
            pending: RefCell::new(HashMap::new()),
            on_message,
        });
        let (text, closed): (Weak<CodexSocket>, Weak<CodexSocket>) =
            (Rc::downgrade(&socket), Rc::downgrade(&socket));
        let shown = path.to_owned();
        let target = path.to_owned();
        let link = Link::open(
            async move {
                tokio::net::UnixStream::connect(&target)
                    .await
                    .map_err(|error| connect_error(&error, &shown))
            },
            Upgrade::default(),
            "codex",
            Box::new(move |line| {
                if let Some(socket) = text.upgrade() {
                    socket.receive(line);
                }
            }),
            Box::new(move |error| {
                if let Some(socket) = closed.upgrade() {
                    socket.reject(error);
                }
            }),
        );
        *socket.link.borrow_mut() = Some(link);
        socket
    }

    fn link(&self) -> Option<Rc<Link>> {
        self.link.borrow().clone()
    }

    fn reject(&self, error: &str) {
        for (_, reply) in self.pending.borrow_mut().drain() {
            let _ = reply.send(Err(error.to_owned()));
        }
    }

    fn receive(&self, text: &str) {
        let Some(message) = Json::parse(text.as_bytes()) else {
            if let Some(link) = self.link() {
                link.fail("Unexpected token in JSON");
            }
            return;
        };
        let id = message.get("id").and_then(Json::as_f64);
        let plain = !crate::fleet::view::truthy(message.get("method"));
        let reply = id
            .filter(|id| plain && id.fract() == 0.0 && *id >= 0.0)
            .and_then(|id| self.pending.borrow_mut().remove(&(id as u64)));
        let Some(reply) = reply else {
            (self.on_message)(&message, self);
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

    pub fn send(&self, message: &Json) -> Result<(), String> {
        match self.link() {
            Some(link) => link.send(&message.compact()),
            None => Err("codex socket closed".into()),
        }
    }

    pub async fn ready(&self) -> Result<(), String> {
        match self.link() {
            Some(link) => link.ready().await,
            None => Err("codex socket closed".into()),
        }
    }

    fn ask(
        self: Rc<Self>,
        method: String,
        params: Json,
    ) -> LocalFuture<'static, Result<Json, String>> {
        Box::pin(async move {
            self.ready().await?;
            let id = self.next.get();
            self.next.set(id + 1);
            let (reply, answer) = oneshot::channel();
            self.pending.borrow_mut().insert(id, reply);
            let request = Json::object(vec![
                ("jsonrpc", Json::str("2.0")),
                ("id", Json::Num(id as f64)),
                ("method", Json::str(method.clone())),
                ("params", params),
            ]);
            if let Err(error) = self.send(&request) {
                self.pending.borrow_mut().remove(&id);
                return Err(error);
            }
            match tokio::time::timeout(REQUEST_TIMEOUT, answer).await {
                Ok(Ok(reply)) => reply,
                Ok(Err(_)) => Err("codex socket closed".into()),
                Err(_) => {
                    self.pending.borrow_mut().remove(&id);
                    Err(format!("codex {method} timed out"))
                }
            }
        })
    }

    pub fn close(&self) {
        if let Some(link) = self.link() {
            link.fail("codex socket closed");
        }
    }
}

/// the socket a waker talks through
struct Socket(Rc<CodexSocket>);

impl Transport for Socket {
    fn request(&self, method: &str, params: Json) -> LocalFuture<'static, Result<Json, String>> {
        self.0.clone().ask(method.to_owned(), params)
    }
}

/// Node's connect failure on a unix socket
fn connect_error(error: &std::io::Error, path: &str) -> String {
    match scp_mcp::client::errno_code(error) {
        Some(code) => format!("connect {code} {path}"),
        None => error.to_string(),
    }
}

/// queues channel messages for the current top-level thread, steering active turns
pub struct CodexWaker {
    transport: Rc<dyn Transport>,
    thread_id: Option<String>,
    status: RefCell<HashMap<String, String>>,
    changed: RefCell<HashMap<String, u64>>,
    parents: RefCell<HashMap<String, bool>>,
    waiting: RefCell<HashSet<String>>,
    queue: RefCell<Vec<String>>,
    busy: Cell<bool>,
    again: Cell<bool>,
    timer: RefCell<Option<tokio::task::JoinHandle<()>>>,
    stopped: Cell<bool>,
    clock: Cell<u64>,
}

fn text_input(text: String) -> Json {
    Json::Arr(vec![Json::object(vec![
        ("type", Json::str("text")),
        ("text", Json::str(text)),
    ])])
}

impl CodexWaker {
    pub fn new(transport: Rc<dyn Transport>, thread_id: Option<String>) -> Rc<CodexWaker> {
        Rc::new(CodexWaker {
            transport,
            thread_id,
            status: RefCell::default(),
            changed: RefCell::default(),
            parents: RefCell::default(),
            waiting: RefCell::default(),
            queue: RefCell::default(),
            busy: Cell::new(false),
            again: Cell::new(false),
            timer: RefCell::new(None),
            stopped: Cell::new(false),
            clock: Cell::new(0),
        })
    }

    pub fn push(self: &Rc<Self>, text: &str) {
        self.queue.borrow_mut().push(text.to_owned());
        self.flush();
    }

    pub fn notification(self: &Rc<Self>, message: &Json) {
        if message.get("method").and_then(Json::as_str) != Some("thread/status/changed") {
            return;
        }
        let params = message.get("params");
        let thread = params
            .and_then(|p| p.get("threadId"))
            .and_then(Json::as_str);
        let status = params
            .and_then(|p| p.get("status"))
            .and_then(|s| s.get("type"))
            .and_then(Json::as_str);
        let (Some(thread), Some(status)) = (thread, status) else {
            return;
        };
        self.status
            .borrow_mut()
            .insert(thread.to_owned(), status.to_owned());
        self.clock.set(self.clock.get() + 1);
        self.changed
            .borrow_mut()
            .insert(thread.to_owned(), self.clock.get());
        if status == "idle" {
            self.waiting.borrow_mut().remove(thread);
        }
        self.flush();
    }

    /// the thread messages go to: the one this waker has, else the top-level loaded thread that changed last
    async fn target(&self) -> Result<Option<String>, String> {
        if let Some(thread) = &self.thread_id {
            return Ok(Some(thread.clone()));
        }
        let loaded = self
            .transport
            .request("thread/loaded/list", Json::Obj(Vec::new()))
            .await?;
        let Some(Json::Arr(ids)) = loaded.get("data") else {
            return Err("no thread list".into());
        };
        let mut best: Option<String> = None;
        for id in ids {
            let id = id.as_str().unwrap_or("").to_owned();
            if !self.parents.borrow().contains_key(&id) {
                let params = Json::object(vec![("threadId", Json::str(id.clone()))]);
                let read = self.transport.request("thread/read", params).await?;
                let Some(thread) = read.get("thread") else {
                    return Err("no thread".into());
                };
                let child = crate::fleet::view::truthy(thread.get("parentThreadId"));
                self.parents.borrow_mut().insert(id.clone(), child);
            }
            if self.parents.borrow().get(&id) == Some(&true) {
                continue;
            }
            let changed = self.changed.borrow();
            let at = |id: &str| changed.get(id).copied().unwrap_or(0);
            if best.as_ref().is_none_or(|best| at(&id) >= at(best)) {
                best = Some(id);
            }
        }
        Ok(best)
    }

    /// one pass: sends what is queued, true when another pass should follow at once
    async fn pass(&self) -> bool {
        let thread = match self.target().await {
            Ok(Some(thread)) if !self.stopped.get() => thread,
            _ => return false,
        };
        let status = self.status.borrow().get(&thread).cloned();
        if self.waiting.borrow().contains(&thread)
            || status
                .as_deref()
                .is_some_and(|status| !status.is_empty() && status != "idle" && status != "active")
        {
            return false;
        }
        let count = self.queue.borrow().len();
        let input = text_input(self.queue.borrow()[..count].join("\n\n"));
        let id = Json::str(thread.clone());
        if status.as_deref() == Some("active") {
            let steered = async {
                let params = Json::object(vec![("threadId", id.clone())]);
                let turns = self.transport.request("thread/turns/list", params).await?;
                let running = turns.get("data").and_then(|data| {
                    data.items().iter().find(|turn| {
                        turn.get("status").and_then(Json::as_str) == Some("inProgress")
                    })
                });
                let Some(turn) = running else {
                    return Err("no running turn".to_owned());
                };
                let params = Json::object(vec![
                    ("threadId", id.clone()),
                    (
                        "expectedTurnId",
                        turn.get("id").cloned().unwrap_or(Json::Null),
                    ),
                    ("input", input.clone()),
                ]);
                self.transport.request("turn/steer", params).await
            }
            .await;
            if steered.is_err() {
                if self.status.borrow().get(&thread).map(String::as_str) == Some("idle") {
                    self.again.set(true);
                    return true;
                }
                self.waiting.borrow_mut().insert(thread);
                return false;
            }
        } else {
            let params = Json::object(vec![("threadId", id), ("input", input)]);
            if self.transport.request("turn/start", params).await.is_err() {
                return false;
            }
        }
        self.queue.borrow_mut().drain(..count);
        true
    }

    fn clear_timer(&self) {
        if let Some(timer) = self.timer.borrow_mut().take() {
            timer.abort();
        }
    }

    pub fn flush(self: &Rc<Self>) {
        if self.busy.get() {
            self.again.set(true);
            return;
        }
        if self.stopped.get() || self.queue.borrow().is_empty() {
            return;
        }
        self.busy.set(true);
        let waker = self.clone();
        tokio::task::spawn_local(async move {
            loop {
                waker.again.set(false);
                if waker.stopped.get() || waker.queue.borrow().is_empty() {
                    break;
                }
                let more = waker.pass().await;
                if !more || !waker.again.get() || waker.queue.borrow().is_empty() {
                    break;
                }
            }
            waker.busy.set(false);
            let empty = waker.queue.borrow().is_empty();
            if empty {
                waker.clear_timer();
            }
            if !waker.stopped.get() && !empty && waker.timer.borrow().is_none() {
                let again = waker.clone();
                let timer = tokio::task::spawn_local(async move {
                    tokio::time::sleep(RETRY).await;
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

/// the app-server process `pid` runs, following wrappers that run it as a child
fn app_server_pid(pid: i64) -> i64 {
    let table = read_ps_table(PS_TIMEOUT_MS);
    let mut seen = HashSet::new();
    let mut at = pid;
    while seen.insert(at) {
        let child = table.as_ref().and_then(|table| {
            table
                .iter()
                .filter(|(_, entry)| entry.ppid == at && runs_app_server(&entry.args))
                .map(|(child, _)| *child)
                .min()
        });
        match child {
            Some(child) => at = child,
            None => break,
        }
    }
    at
}

/// `\sapp-server(?:\s|$)`
fn runs_app_server(args: &str) -> bool {
    args.match_indices("app-server").any(|(at, word)| {
        let before = args[..at].chars().next_back();
        let after = args[at + word.len()..].chars().next();
        before.is_some_and(scp_mcp::render::js_space) && after.is_none_or(scp_mcp::render::js_space)
    })
}

/// what a run holds across its steps
struct Run {
    latch: Latch,
    stopping: Rc<Cell<bool>>,
    waker: Rc<RefCell<Option<Rc<CodexWaker>>>>,
    tui: Rc<RefCell<Option<Rc<Watched>>>>,
    headless: bool,
}

impl Run {
    fn stop(&self) {
        self.stopping.set(true);
        self.latch.finish(0);
    }

    /// a message of the app-server that is no reply to this client
    fn message(&self, message: &Json, socket: &CodexSocket) {
        let waker = self.waker.borrow().clone();
        if let Some(waker) = waker {
            waker.notification(message);
        }
        if !self.headless {
            return;
        }
        let method = message.get("method").and_then(Json::as_str);
        if let (Some(id), Some(method)) = (message.get("id"), method) {
            let answer = if method.ends_with("/requestApproval") {
                term::err(&format!("{CLI_NAME} codex: declined {method}"));
                Json::object(vec![
                    ("id", id.clone()),
                    (
                        "result",
                        Json::object(vec![("decision", Json::str("decline"))]),
                    ),
                ])
            } else {
                Json::object(vec![
                    ("id", id.clone()),
                    (
                        "error",
                        Json::object(vec![
                            ("code", Json::Num(-32601.0)),
                            ("message", Json::str("unsupported server request")),
                        ]),
                    ),
                ])
            };
            let _ = socket.send(&answer);
        }
        if method == Some("item/completed") {
            let item = message.get("params").and_then(|p| p.get("item"));
            let text = item
                .and_then(|item| item.get("text"))
                .and_then(Json::as_str);
            if item
                .and_then(|item| item.get("type"))
                .and_then(Json::as_str)
                == Some("agentMessage")
                && let Some(text) = text
            {
                term::print(&format!("{text}\n"));
            }
        }
    }
}

fn initialize_params() -> Json {
    Json::object(vec![(
        "clientInfo",
        Json::object(vec![
            ("name", Json::str(WAKER_NAME)),
            ("version", Json::str("0.1.0")),
        ]),
    )])
}

/// connects to the app-server at `path`, retrying until it answers, the time is up, it died or the run stops
async fn open_socket(
    path: &str,
    run: &Rc<Run>,
    died: &dyn Fn() -> bool,
) -> Option<Rc<CodexSocket>> {
    let end = Instant::now() + Duration::from_millis(READY_MS);
    while Instant::now() < end && !died() && !run.stopping.get() {
        let handler = run.clone();
        let candidate = CodexSocket::connect(
            path,
            Box::new(move |message, socket| handler.message(message, socket)),
        );
        let left = end.saturating_duration_since(Instant::now());
        let wait = left.min(Duration::from_millis(INITIALIZE_MS));
        let hello = async {
            candidate.ready().await?;
            candidate
                .clone()
                .ask("initialize".into(), initialize_params())
                .await?;
            candidate.send(&Json::object(vec![("method", Json::str("initialized"))]))
        };
        match tokio::time::timeout(wait, hello).await {
            Ok(Ok(())) => return Some(candidate),
            _ => {
                candidate.close();
                if !died() {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }
    None
}

/// the launch once its app-server started
struct Session<'a> {
    launch: &'a CodexLaunch,
    path: &'a str,
    bin: &'a str,
    cwd: &'a str,
    thread: Option<&'a str>,
    server: &'a Server,
    router_env: &'a Env,
    channel: RefCell<Option<Rc<Channel>>>,
    socket: RefCell<Option<Rc<CodexSocket>>>,
}

/// what the run does once its app-server runs
async fn serve(run: &Rc<Run>, session: &Session<'_>) -> Done {
    let Session {
        launch,
        path,
        bin,
        cwd,
        thread,
        server,
        router_env,
        channel,
        socket,
    } = session;
    let died = || server.died();
    let opened = open_socket(path, run, &died).await;
    *socket.borrow_mut() = opened.clone();
    if run.stopping.get() {
        return Ok(0);
    }
    let Some(opened) = opened.filter(|_| !died()) else {
        return Err(fail_server(server));
    };
    let mut thread_id: Option<String> = None;
    if launch.headless {
        let model = option(&launch.codex_args, &["-m", "--model"])?;
        let sandbox = option(&launch.codex_args, &["-s", "--sandbox"])?;
        let resume = launch.resume.as_deref().filter(|resume| !resume.is_empty());
        let mut params = Vec::new();
        match resume {
            Some(resume) => params.push(("threadId", Json::str(resume))),
            None => params.push(("cwd", Json::str(*cwd))),
        }
        params.push(("approvalPolicy", Json::str("never")));
        if let Some(model) = model {
            params.push(("model", Json::str(model)));
        }
        if let Some(sandbox) = sandbox {
            params.push(("sandbox", Json::str(sandbox)));
        }
        let method = if resume.is_some() {
            "thread/resume"
        } else {
            "thread/start"
        };
        let result = opened
            .clone()
            .ask(method.to_owned(), Json::object(params))
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                let Some(resume) = resume.filter(|_| error.contains("active writer")) else {
                    return Err(Fail::Call(CallError::Io(error)));
                };
                let owner = match thread {
                    Some(thread) => codex_owner(thread, &launch.env).await,
                    None => Owner::Unknown,
                };
                term::err(&held_thread_text(resume, owner));
                return Ok(1);
            }
        };
        let Some(Json::Obj(_)) = result.get("thread") else {
            return Err(Fail::Call(CallError::Io(
                "Cannot read properties of undefined (reading 'id')".into(),
            )));
        };
        thread_id = result
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(Json::as_str)
            .map(str::to_owned);
    }
    if run.stopping.get() {
        return Ok(0);
    }
    let waker = CodexWaker::new(Rc::new(Socket(opened.clone())), thread_id.clone());
    *run.waker.borrow_mut() = Some(waker.clone());
    let pid = server
        .child
        .as_ref()
        .map_or(0, |child| i64::from(child.pid()));
    let pid = app_server_pid(pid);
    let claim = launcher_claim("codex", cwd, &launch.env, pid);
    let broker = relay_dir(&launch.env);
    let connect = broker_connect(&broker, router_env);
    let ended = Rc::new(Cell::new(false));
    let stopped = ended.clone();
    let (bound_claim, bound_cwd) = (claim.clone(), cwd.to_string());
    let bind: scp_mcp::server::Connect = Rc::new(move || {
        let (connect, claim, cwd, stopped) = (
            connect.clone(),
            bound_claim.clone(),
            bound_cwd.clone(),
            stopped.clone(),
        );
        Box::pin(async move { bind_channel(&connect, &claim, &cwd, &|| stopped.get()).await })
    });
    let pushing = waker.clone();
    let opened_channel = Rc::new(Channel::start(
        ChannelSetup {
            connect: bind,
            claim: claim.clone(),
            wake: "codex-app-server",
            env: launch.env.clone(),
            log: Rc::new(term::err),
            on_message: Rc::new(move |message| {
                if let Some(content) = pushed(message) {
                    pushing.push(content);
                }
            }),
        },
        ended,
    ));
    *channel.borrow_mut() = Some(opened_channel.clone());
    opened_channel.initialize(WAKER_NAME).await;
    if launch.headless {
        let handle = launch.name.as_deref().unwrap_or(field(&claim, "handle"));
        let thread = thread_id.as_deref().unwrap_or("undefined");
        term::err(&format!(
            "{CLI_NAME} codex: {handle} waiting for messages (thread {thread})"
        ));
    } else {
        start_tui(run, launch, path, bin);
    }
    let code = run.latch.done().await;
    if server.died() {
        term::err(&server.failure(&failure_head()));
        return Ok(1);
    }
    Ok(code)
}

fn failure_head() -> String {
    format!("{CLI_NAME} codex: app-server failed")
}

fn fail_server(server: &Server) -> Fail {
    usage(server.failure(&failure_head()))
}

/// the TUI on the app-server, the terminal passed through
fn start_tui(run: &Rc<Run>, launch: &CodexLaunch, path: &str, bin: &str) {
    let mut command = std::process::Command::new(bin);
    command
        .arg("--remote")
        .arg(format!("unix://{path}"))
        .args(&launch.codex_args)
        .env_clear()
        .envs(&launch.env)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    default_signals(&mut command);
    let mut command = tokio::process::Command::from(command);
    match command.spawn() {
        Err(error) => {
            term::err(&format!("{CLI_NAME} codex: {}", spawn_error(bin, &error)));
            run.latch.finish(1);
        }
        Ok(child) => {
            let watched = Watched::start(child);
            let (latch, tui) = (run.latch.clone(), watched.clone());
            tokio::task::spawn_local(async move {
                latch.finish(super::exit_code(tui.exited().await));
            });
            *run.tui.borrow_mut() = Some(watched);
        }
    }
}

/// `swarm codex`: an app-server with a channel waker and either a remote TUI or an ambient thread; returns its exit code
pub fn codex(call: &Call, args: &[String]) -> Done {
    if matches!(args.first().map(String::as_str), Some("--help" | "-h")) {
        return Err(Fail::Decline("help".into()));
    }
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let mut env = call.env.clone();
    route::caller_argv(&mut env);
    let cwd = safe_cwd();
    let parsed = codex_launch(args, &env)?;
    block_on(launch(call, args, &env, &cwd, parsed))?
}

async fn launch(
    call: &Call<'_>,
    args: &[String],
    env: &Env,
    cwd: &str,
    parsed: CodexLaunch,
) -> Done {
    let resume = parsed.resume.is_some()
        || options_before(&parsed.codex_args)
            .iter()
            .any(|word| word == "resume");
    let placement = Placement {
        name: parsed.name.as_deref(),
        root: parsed.root,
        under: parsed.under.as_deref(),
        resume,
        dir: None,
    };
    let warn = |line: &str| term::err(line);
    let attribution = attribute("codex", placement, call.env, cwd, &warn).await?;
    let launch = match &attribution {
        Some(attribution) => codex_launch(args, &attributed(env, Some(attribution)))?,
        None => parsed,
    };
    let bin = launch
        .env
        .get("SCP_CODEX_BIN")
        .filter(|bin| !bin.is_empty())
        .cloned()
        .unwrap_or_else(|| "codex".to_owned());
    let thread = launch.resume.as_deref().filter(|t| codex_thread(t));
    let owner = match thread {
        Some(thread) => codex_owner(thread, &launch.env).await,
        None => Owner::None,
    };
    if let Some(thread) = thread
        && owner != Owner::None
        && owner != Owner::Unknown
    {
        term::err(&held_thread_text(thread, owner));
        return Ok(1);
    }
    let self_words = crate::spawn::run::self_words(call, call.env);
    let mount_bin = native_mount_bin(&launch.env);
    let mount = codex_mount(&launch.env);
    let mut overrides = codex_overrides(
        &launch.env,
        mount.as_ref(),
        &self_words,
        mount_bin.as_deref(),
    );
    overrides.extend(server_options(&launch.codex_args, &launch.env, &warn)?);
    let tmp = join(&[&os_tmpdir(&launch.env), "scp-codex-"]);
    let dir = temp_dir(&tmp).map_err(|error| {
        Fail::Call(CallError::Io(node_fs_error(
            &error,
            "mkdtemp",
            &format!("{tmp}XXXXXX"),
        )))
    })?;
    let dir_text = dir.to_string_lossy().into_owned();
    let path = join(&[&dir_text, "app.sock"]);
    let mut command = tokio::process::Command::new(&bin);
    command
        .arg("app-server")
        .arg("--listen")
        .arg(format!("unix://{path}"))
        .args(&overrides)
        .env_clear()
        .envs(&launch.env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let latch = Latch::default();
    let (server, _, _) = start_server(command, &bin, &latch);
    let run = Rc::new(Run {
        latch: latch.clone(),
        stopping: Rc::new(Cell::new(false)),
        waker: Rc::default(),
        tui: Rc::default(),
        headless: launch.headless,
    });
    let mut listener = Listener::new(&[libc::SIGINT, libc::SIGTERM, libc::SIGHUP]);
    let on_signal = run.clone();
    let signals = tokio::task::spawn_local(async move {
        loop {
            let signal = listener.recv().await;
            if on_signal.headless {
                on_signal.stop();
                continue;
            }
            if signal == libc::SIGINT {
                continue;
            }
            let tui = on_signal.tui.borrow().clone();
            match tui {
                Some(tui) => tui.kill(signal),
                None => on_signal.stop(),
            }
        }
    });
    let session = Session {
        launch: &launch,
        path: &path,
        bin: &bin,
        cwd,
        thread,
        server: &server,
        router_env: call.env,
        channel: RefCell::new(None),
        socket: RefCell::new(None),
    };
    let result = serve(&run, &session).await;
    signals.abort();
    let _ = signals.await;
    let result = match result {
        Err(_) if server.died() => Err(fail_server(&server)),
        other => other,
    };
    let waker = run.waker.borrow().clone();
    if let Some(waker) = waker {
        waker.close();
    }
    let open = session.channel.borrow().clone();
    if let Some(channel) = open {
        channel.end().await;
    }
    let held = session.socket.borrow().clone();
    if let Some(socket) = held {
        socket.close();
    }
    let tui = run.tui.borrow().clone();
    if let Some(tui) = tui {
        tui.terminate(TERMINATE_MS).await;
    }
    server.terminate(TERMINATE_MS).await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn the_launcher_flags_come_out_and_the_rest_goes_to_codex() {
        let env = Env::from([
            ("SCP_SESSION".to_owned(), "caller".to_owned()),
            ("SCP_PARENT".to_owned(), "p".to_owned()),
            ("SCP_CODEX_THREAD".to_owned(), "old".to_owned()),
        ]);
        let parsed = codex_launch(
            &w(&["--name", "me/lead", "--model", "gpt", "--", "--name", "x"]),
            &env,
        )
        .unwrap();
        assert_eq!(parsed.name.as_deref(), Some("lead"));
        assert_eq!(
            parsed.codex_args,
            w(&["--model", "gpt", "--", "--name", "x"])
        );
        assert_eq!(parsed.env["SCP_HARNESS"], "codex");
        assert_eq!(parsed.env["SCP_NAME"], "lead");
        assert_eq!(parsed.env["SCP_SHIM_BINDING"].len(), 32);
        for key in ["SCP_SESSION", "SCP_PARENT", "SCP_CODEX_THREAD"] {
            assert!(!parsed.env.contains_key(key));
        }
        assert_eq!(
            codex_launch(&w(&["--", "--name", "x"]), &env)
                .unwrap()
                .codex_args,
            w(&["--name", "x"])
        );
        assert_eq!(
            codex_launch(&w(&["--name"]), &env),
            Err(usage(format!("{CLI_NAME} codex --name takes a name")))
        );
        assert_eq!(
            codex_launch(&w(&["--name", "me"]), &env),
            Err(usage("\"me\" is not a valid agent handle"))
        );
    }

    #[test]
    fn a_resume_reopens_the_thread_in_the_tui_and_in_the_app_server_when_headless() {
        let thread = "019bd3c6-f4a2-7c3e-9d5e-1f2a3b4c5d6e";
        let env = Env::new();
        let tui = codex_launch(&w(&["--resume", thread, "-m", "x"]), &env).unwrap();
        assert_eq!(tui.codex_args, w(&["resume", thread, "-m", "x"]));
        assert_eq!(tui.env["SCP_CODEX_THREAD"], thread);
        let headless = codex_launch(&w(&["--headless", "--resume=abc"]), &env).unwrap();
        assert_eq!(headless.codex_args, Vec::<String>::new());
        assert!(!headless.env.contains_key("SCP_CODEX_THREAD"));
    }

    #[test]
    fn server_options_keep_their_order_of_precedence() {
        let dir = std::env::temp_dir().join(format!("scp-profile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("mock.config.toml"),
            "model = \"mock\"\nwhen = 2024-01-02T03:04:05Z\nday = 2024-01-02\n[a]\nb = 1\nc = [1, \"x\"]\n",
        )
        .unwrap();
        let env = Env::from([("CODEX_HOME".to_owned(), dir.to_string_lossy().into_owned())]);
        let warned = RefCell::new(Vec::new());
        let warn = |line: &str| warned.borrow_mut().push(line.to_owned());
        let args = w(&[
            "-m",
            "m",
            "--profile=mock",
            "-c",
            "mcp_servers.scp.x=1",
            "--enable",
            "f",
            "--strict-config",
            "--yolo",
            "-s",
            "read-only",
            "--",
            "-m",
            "after",
        ]);
        assert_eq!(
            server_options(&args, &env, &warn).unwrap(),
            w(&[
                "-c",
                "model=\"mock\"",
                "-c",
                "when=\"2024-01-02T03:04:05.000Z\"",
                "-c",
                "day=\"2024-01-02\"",
                "-c",
                "a.b=1",
                "-c",
                "a.c=[1, \"x\"]",
                "-c",
                "mcp_servers.scp.x=1",
                "--enable",
                "f",
                "--strict-config",
                "-c",
                "model=\"m\"",
                "-c",
                "approval_policy=\"never\"",
                "-c",
                "sandbox_mode=\"danger-full-access\"",
                "-c",
                "sandbox_mode=\"read-only\"",
            ])
        );
        assert_eq!(warned.borrow().len(), 1);
        assert_eq!(
            server_options(&w(&["-m"]), &env, &warn),
            Err(usage(format!("{CLI_NAME} codex -m takes a value")))
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_app_server_word_stands_alone() {
        assert!(runs_app_server("codex app-server --listen x"));
        assert!(runs_app_server("codex app-server"));
        assert!(!runs_app_server("codex my-app-server"));
        assert!(!runs_app_server("app-server"));
    }

    #[test]
    fn a_datetime_is_written_with_its_milliseconds_and_offset() {
        let at = |text: &str| iso_date(&text.parse().unwrap());
        assert_eq!(at("2024-01-02"), "2024-01-02");
        assert_eq!(at("03:04:05"), "03:04:05.000");
        assert_eq!(at("2024-01-02T03:04:05.250"), "2024-01-02T03:04:05.250");
        assert_eq!(
            at("2024-01-02T03:04:05+01:30"),
            "2024-01-02T03:04:05.000+01:30"
        );
    }

    type Calls = Rc<RefCell<Vec<(String, Json)>>>;
    type Reply = Box<dyn Fn(&str) -> Result<Json, String>>;

    struct Fake {
        calls: Calls,
        reply: Reply,
    }

    impl Transport for Fake {
        fn request(
            &self,
            method: &str,
            params: Json,
        ) -> LocalFuture<'static, Result<Json, String>> {
            self.calls.borrow_mut().push((method.to_owned(), params));
            let reply = (self.reply)(method);
            Box::pin(async move { reply })
        }
    }

    fn local(future: impl std::future::Future<Output = ()>) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, future);
    }

    fn status(thread: &str, kind: &str) -> Json {
        Json::object(vec![
            ("method", Json::str("thread/status/changed")),
            (
                "params",
                Json::object(vec![
                    ("threadId", Json::str(thread)),
                    ("status", Json::object(vec![("type", Json::str(kind))])),
                ]),
            ),
        ])
    }

    #[test]
    fn messages_start_a_turn_on_an_idle_thread_and_steer_an_active_one() {
        local(async {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let fake = Fake {
                calls: calls.clone(),
                reply: Box::new(|method| {
                    Ok(match method {
                        "thread/turns/list" => Json::object(vec![(
                            "data",
                            Json::Arr(vec![Json::object(vec![
                                ("id", Json::str("turn-1")),
                                ("status", Json::str("inProgress")),
                            ])]),
                        )]),
                        _ => Json::Obj(Vec::new()),
                    })
                }),
            };
            let waker = CodexWaker::new(Rc::new(fake), Some("t".into()));
            waker.push("one");
            tokio::time::sleep(Duration::from_millis(1)).await;
            waker.notification(&status("t", "active"));
            waker.push("two");
            tokio::time::sleep(Duration::from_millis(1)).await;
            let methods: Vec<String> = calls.borrow().iter().map(|c| c.0.clone()).collect();
            assert_eq!(methods, ["turn/start", "thread/turns/list", "turn/steer"]);
            assert_eq!(
                calls.borrow()[2].1.compact(),
                "{\"threadId\":\"t\",\"expectedTurnId\":\"turn-1\",\"input\":[{\"type\":\"text\",\"text\":\"two\"}]}"
            );
            waker.close();
        });
    }

    #[test]
    fn a_failed_turn_is_retried_and_a_thread_with_a_parent_is_passed_over() {
        local(async {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let tries = Rc::new(Cell::new(0));
            let counted = tries.clone();
            let fake = Fake {
                calls: calls.clone(),
                reply: Box::new(move |method| match method {
                    "thread/loaded/list" => Ok(Json::object(vec![(
                        "data",
                        Json::Arr(vec![Json::str("child"), Json::str("top")]),
                    )])),
                    "thread/read" => Ok(Json::object(vec![(
                        "thread",
                        Json::object(vec![(
                            "parentThreadId",
                            if counted.get() == 0 {
                                counted.set(1);
                                Json::str("top")
                            } else {
                                Json::Null
                            },
                        )]),
                    )])),
                    "turn/start" if counted.get() == 1 => {
                        counted.set(2);
                        Err("busy".into())
                    }
                    _ => Ok(Json::Obj(Vec::new())),
                }),
            };
            let waker = CodexWaker::new(Rc::new(fake), None);
            waker.push("one");
            waker.push("two");
            tokio::time::sleep(Duration::from_millis(1)).await;
            assert_eq!(tries.get(), 2);
            tokio::time::sleep(RETRY + Duration::from_millis(10)).await;
            let turns: Vec<String> = calls
                .borrow()
                .iter()
                .filter(|c| c.0 == "turn/start")
                .map(|c| c.1.compact())
                .collect();
            assert_eq!(
                turns.last().map(String::as_str),
                Some(
                    "{\"threadId\":\"top\",\"input\":[{\"type\":\"text\",\"text\":\"one\\n\\ntwo\"}]}"
                )
            );
            assert!(waker.queue.borrow().is_empty());
            waker.close();
        });
    }
}
