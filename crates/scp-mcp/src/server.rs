//! The stdio MCP server: newline-delimited JSON-RPC 2.0 to the client, one broker connection behind it.

use crate::client::{CallError, Client};
use crate::inbox::{SessionInbox, send_to_session_inbox};
use crate::render::{
    INSTRUCTIONS, PREAMBLE, delivery_text, list_of, reach_lines, receipt_lines, short_id, strings,
    widen_text, wrap_message, wrap_peek,
};
use crate::tools::{
    MCP_PROTOCOLS, ToolInputError, ToolResult, ask_text, bool_arg, delivered, get, group_text,
    held_text, js, js_trim, list_line, one_of, peek_turns, quote, recipients, redacted_text,
    required, scope_text, seconds, seen_text, selectors, sent_content, shown_rows, status_line,
    str_arg, text, tool_names, tools_json, truthy,
};
use crate::{Claim, LocalFuture, Membership};
use scp_core::protocol::{CLI_NAME, LIMITS, STATUS_STATES};
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

/// what relay_spawn asks for: `swarm spawn --bg` of `command`, acting as `as_`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpawnRequest {
    pub command: Vec<String>,
    pub as_: String,
    pub harness: Option<String>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub no_push: bool,
    pub handback_bytes: Option<u64>,
    /// absolute and existing
    pub cwd: Option<PathBuf>,
}

impl SpawnRequest {
    /// the request as the reference server hands it to its spawn
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("command".into(), json!(self.command));
        out.insert("as".into(), json!(self.as_));
        let mut put = |key: &str, value: Option<Value>| {
            if let Some(value) = value {
                out.insert(key.into(), value);
            }
        };
        put("harness", self.harness.clone().map(Value::String));
        put("name", self.name.clone().map(Value::String));
        put("title", self.title.clone().map(Value::String));
        put("no_push", self.no_push.then_some(Value::Bool(true)));
        put("handback_bytes", self.handback_bytes.map(|b| json!(b)));
        put(
            "cwd",
            self.cwd
                .as_ref()
                .map(|c| Value::String(c.display().to_string())),
        );
        Value::Object(out)
    }
}

/// a started worker
#[derive(Debug, Clone, PartialEq)]
pub struct Spawned {
    pub name: String,
    pub pid: u32,
}

pub type Connect = Rc<dyn Fn() -> LocalFuture<'static, Result<Client, CallError>>>;
pub type SpawnFn = Rc<dyn Fn(SpawnRequest) -> LocalFuture<'static, Result<Spawned, String>>>;
pub type MembershipFn = Rc<dyn Fn(&str) -> Membership>;
pub type ThreadClaimFn = Rc<dyn Fn(&Map<String, Value>) -> Option<Claim>>;
pub type BoundFn = Rc<dyn Fn(&Claim)>;

pub struct Options {
    /// a fresh connection to the broker (starting it if needed)
    pub connect: Connect,
    /// the agent endpoint this shim claims
    pub claim: Claim,
    pub membership: Option<MembershipFn>,
    /// the claim for the thread a tools/call's `_meta` names; the first such call binds the shim for good
    pub thread_claim: Option<ThreadClaimFn>,
    pub defer_claim: bool,
    pub bound: Option<BoundFn>,
    pub env: HashMap<String, String>,
    pub channels: bool,
    pub launched_with_channels: bool,
    pub session_inbox: Option<SessionInbox>,
    pub wake: Option<String>,
    pub version: Option<String>,
    pub spawn: Option<SpawnFn>,
    /// diagnostics, never stdout
    pub log: Rc<dyn Fn(&str)>,
    pub heartbeat_ms: u64,
}

const MAX_INPUT_LINE: usize = 4 * 1024 * 1024;
const DELIVERED_KEEP: usize = 500;
const ASK_WAIT_DEFAULT_S: u64 = 30;
const RETRY_MAX_MS: u64 = 300_000;
const SESSION_INBOX_TIMEOUT: Duration = Duration::from_secs(5);

/// the channel poll's pause after its `failures`-th failure in a row: a refusal (a refused claim or grant) doubles up to five minutes
pub fn channel_retry_ms(error: &CallError, failures: u32) -> u64 {
    match error {
        CallError::Io(_) => 1000,
        CallError::Relay { code, .. } if code != "unauthorized" => 5000,
        CallError::Relay { .. } => (5000u64 << failures.min(16)).min(RETRY_MAX_MS),
    }
}

/// keys in insertion order, the oldest dropped past `keep`
struct Recent<V> {
    map: HashMap<String, (V, u64)>,
    order: VecDeque<(String, u64)>,
    next: u64,
    keep: usize,
}

impl<V> Recent<V> {
    fn new(keep: usize) -> Self {
        Recent {
            map: HashMap::new(),
            order: VecDeque::new(),
            next: 0,
            keep,
        }
    }

    fn get(&self, key: &str) -> Option<&V> {
        self.map.get(key).map(|(value, _)| value)
    }

    /// sets `key` as the newest entry
    fn set(&mut self, key: String, value: V) {
        self.next += 1;
        self.order.push_back((key.clone(), self.next));
        self.map.insert(key, (value, self.next));
        while self.map.len() > self.keep {
            let Some((oldest, at)) = self.order.pop_front() else {
                break;
            };
            if self.map.get(&oldest).is_some_and(|(_, set)| *set == at) {
                self.map.remove(&oldest);
            }
        }
        if self.order.len() > 4 * self.keep + 64 {
            let map = &self.map;
            self.order
                .retain(|(key, at)| map.get(key).is_some_and(|(_, set)| set == at));
        }
    }

    fn remove(&mut self, key: &str) {
        self.map.remove(key);
    }
}

#[derive(Clone)]
struct Origin {
    from: Option<Value>,
    thread: Option<Value>,
}

enum ToolError {
    Input(String),
    Call(CallError),
}

impl From<ToolInputError> for ToolError {
    fn from(error: ToolInputError) -> Self {
        ToolError::Input(error.0)
    }
}

impl From<CallError> for ToolError {
    fn from(error: CallError) -> Self {
        ToolError::Call(error)
    }
}

type Tool = Result<ToolResult, ToolError>;
type Opening = watch::Receiver<Option<Result<Rc<Client>, CallError>>>;

fn input<T>(message: impl Into<String>) -> Result<T, ToolError> {
    Err(ToolError::Input(message.into()))
}

fn put(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        map.insert(key.into(), value);
    }
}

fn client_id() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "mcp_{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn is_directory(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// relay_spawn's arguments as a spawn request, all but who spawns and its harness
fn spawn_request(args: &Map<String, Value>) -> Result<SpawnRequest, ToolError> {
    if args.contains_key("command") == args.contains_key("harness") {
        return input("give command (the harness command as argv) or harness and task");
    }
    let command = if let Some(words) = args.get("command") {
        let words: Option<Vec<String>> = match words {
            Value::Array(list) if !list.is_empty() => list
                .iter()
                .map(|w| w.as_str().map(str::to_string))
                .collect(),
            _ => None,
        };
        let Some(words) =
            words.filter(|w| w.first().is_some_and(|first| !js_trim(first).is_empty()))
        else {
            return input(
                "command must be the harness command as a list of words, e.g. [\"codex\", \"exec\", \"<task>\"]",
            );
        };
        if args.contains_key("task") || args.contains_key("model") {
            return input("task and model go with harness; with command, put them in it");
        }
        words
    } else {
        let harness = one_of(args, "harness", &["claude", "codex"])?;
        let model = str_arg(args, "model", false)?;
        let mut command: Vec<String> = if harness == "claude" {
            vec!["claude".into(), "-p".into()]
        } else {
            vec!["codex".into(), "exec".into()]
        };
        command.push(required(args, "task")?);
        if let Some(model) = model.filter(|m| !m.is_empty()) {
            command.extend(["--model".to_string(), model]);
        }
        command
    };
    let bytes = match args.get("handback_bytes") {
        None => None,
        Some(value) => match value.as_f64() {
            Some(b) if b.fract() == 0.0 && (1.0..=LIMITS.handback_bytes as f64).contains(&b) => {
                Some(b as u64)
            }
            _ => {
                return input(format!(
                    "handback_bytes must be whole bytes, 1 to {}",
                    LIMITS.handback_bytes
                ));
            }
        },
    };
    let name = if args.contains_key("name") {
        Some(required(args, "name")?)
    } else {
        None
    };
    let title = str_arg(args, "title", false)?;
    let no_push = bool_arg(args, "no_push")?;
    let cwd = str_arg(args, "cwd", false)?;
    if let Some(cwd) = &cwd {
        if !Path::new(cwd).is_absolute() {
            return input("cwd must be an absolute path");
        }
        if !is_directory(cwd) {
            return input(format!("cwd {cwd} is not an existing directory"));
        }
    }
    Ok(SpawnRequest {
        command,
        name: name.filter(|n| !n.is_empty()),
        title,
        no_push: no_push == Some(true),
        handback_bytes: bytes,
        cwd: cwd.map(PathBuf::from),
        ..SpawnRequest::default()
    })
}

fn capped(wait: Option<&Value>) -> bool {
    wait.and_then(Value::as_f64)
        .is_some_and(|w| w > LIMITS.wait_max_s as f64)
}

fn nullish_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        other => js(other),
    }
}

/// a JSON-RPC response line, its keys in the reference server's order
fn response(id: &Value, result: &str) -> String {
    format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{result}}}\n")
}

fn error_line(id: &Value, code: i64, message: &str) -> String {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{{\"code\":{code},\"message\":{}}}}}\n",
        Value::String(message.into())
    )
}

struct Shim {
    options: Options,
    output: Rc<dyn Fn(&str)>,
    spawns: bool,
    home: Option<String>,
    sent: RefCell<Recent<Origin>>,
    client: RefCell<Option<Rc<Client>>>,
    connecting: RefCell<Option<Opening>>,
    token: RefCell<Option<String>>,
    me: RefCell<Option<Value>>,
    announced: Cell<bool>,
    initialized: Cell<bool>,
    channel_client: Cell<bool>,
    inbox: RefCell<Option<SessionInbox>>,
    stopped: Cell<bool>,
    channel_pushed: RefCell<Recent<()>>,
    channel_loop: Cell<bool>,
    /// None until initialize; then the wake to advertise, None advertising nothing
    wake: RefCell<Option<Option<String>>>,
    advertised: RefCell<Option<(Weak<Client>, String)>>,
    bound: RefCell<Option<Claim>>,
    rebound: Cell<bool>,
    in_flight: watch::Sender<usize>,
}

impl Shim {
    fn log(&self, line: &str) {
        (self.options.log)(line);
    }

    fn write(&self, line: &str) {
        if !self.stopped.get() {
            (self.output)(line);
        }
    }

    fn remember(&self, message: &Value) {
        let id = js(get(message, "id"));
        let origin = Origin {
            from: get(message, "from")
                .and_then(|f| get(f, "address"))
                .cloned(),
            thread: get(message, "thread").cloned(),
        };
        let mut sent = self.sent.borrow_mut();
        sent.remove(&id);
        sent.set(id, origin);
    }

    /// the bound claim as the session's membership names it; a session off the relay, or a deferred shim not yet bound, is refused
    fn session_claim(&self) -> Result<Claim, CallError> {
        let Some(bound) = self.bound.borrow().clone() else {
            return Err(CallError::relay(
                "unavailable",
                "no thread is bound to this shim yet",
            ));
        };
        let Some(membership) = &self.options.membership else {
            return Ok(bound);
        };
        match membership(&nullish_or_empty(bound.get("session"))) {
            Membership::Dark(why) => Err(CallError::relay("unavailable", why)),
            Membership::Joined(Some(handle)) if !handle.is_empty() => {
                let mut claim = bound;
                claim.insert("handle".into(), Value::String(handle));
                Ok(claim)
            }
            Membership::Joined(_) => Ok(bound),
        }
    }

    /// a deferred shim's first tools/call binds it for good; a later call naming another session keeps the binding
    fn bind(&self, claim: Claim) {
        if let Some(bound) = self.bound.borrow().as_ref() {
            if bound.get("session") != claim.get("session") && !self.rebound.get() {
                self.rebound.set(true);
                self.log(&format!(
                    "{CLI_NAME} mcp: a tool call named session {}; this shim stays bound to {}",
                    nullish_or_empty(claim.get("session")),
                    nullish_or_empty(bound.get("session"))
                ));
            }
            return;
        }
        *self.bound.borrow_mut() = Some(claim.clone());
        if let Some(bound) = &self.options.bound {
            bound(&claim);
        }
    }

    fn cwd_of(claim: &Claim) -> Map<String, Value> {
        let mut fields = Map::new();
        put(&mut fields, "cwd", claim.get("cwd").cloned());
        fields
    }

    /// a claim's hello; a wake ticket is good once, so the shim drops it once a claim took it or the broker refused it
    async fn claim_hello(&self, next: &Client, claim: &Claim) -> Result<Value, CallError> {
        let hello = |claim: Claim| {
            let mut fields = Map::new();
            fields.insert("claim".into(), Value::Object(claim.clone()));
            fields.extend(Self::cwd_of(&claim));
            fields
        };
        if !claim.contains_key("ticket") {
            return next.hello(hello(claim.clone())).await;
        }
        let mut plain = claim.clone();
        plain.remove("ticket");
        let spend = || {
            if let Some(bound) = self.bound.borrow_mut().as_mut() {
                bound.remove("ticket");
            }
        };
        match next.hello(hello(claim.clone())).await {
            Ok(result) => {
                spend();
                return Ok(result);
            }
            Err(CallError::Relay { code, message, .. }) if code == "unauthorized" => {
                self.log(&format!(
                    "{CLI_NAME} mcp: the wake ticket was refused ({message}); claiming without it"
                ));
            }
            Err(error) => return Err(error),
        }
        spend();
        next.hello(hello(plain)).await
    }

    async fn open(self: &Rc<Self>) -> Result<Rc<Client>, CallError> {
        let claim = self.session_claim()?;
        let next = Rc::new((self.options.connect)().await?);
        let opened: Result<(), CallError> = async {
            let mut hello = None;
            let token = self.token.borrow().clone();
            if let Some(token) = token {
                let mut fields = Map::new();
                fields.insert("resume".into(), Value::String(token));
                fields.extend(Self::cwd_of(&claim));
                match next.hello(fields).await {
                    Ok(result) => hello = Some(result),
                    Err(error) if error.is_relay() => {}
                    Err(error) => return Err(error),
                }
            }
            let hello = match hello {
                Some(hello) => hello,
                None => self.claim_hello(&next, &claim).await?,
            };
            if let Some(token) = get(&hello, "token").filter(|t| truthy(Some(t))) {
                *self.token.borrow_mut() = Some(js(Some(token)));
            }
            *self.me.borrow_mut() = get(&hello, "endpoint").filter(|e| !e.is_null()).cloned();
            if !self.announced.get() {
                next.request("status", json!({ "state": "working" }))
                    .await?;
                self.announced.set(true);
            }
            Ok(())
        }
        .await;
        if let Err(error) = opened {
            next.close();
            return Err(error);
        }
        if self.stopped.get() {
            next.close();
            return Err(CallError::Io("the relay MCP shim is stopping".into()));
        }
        *self.client.borrow_mut() = Some(next.clone());
        self.advertise();
        Ok(next)
    }

    /// tells the broker how a message wakes this session, once per connection and value, once both it and the client are known
    fn advertise(&self) {
        let Some(client) = self.client.borrow().clone() else {
            return;
        };
        let Some(wake) = self.wake.borrow().clone() else {
            return;
        };
        let via = wake.unwrap_or_else(|| "none".into());
        {
            let advertised = self.advertised.borrow();
            let same = advertised.as_ref().is_some_and(|(sent, at)| {
                Weak::ptr_eq(sent, &Rc::downgrade(&client)) && *at == via
            });
            if same || (via == "none" && advertised.is_none()) {
                return;
            }
        }
        *self.advertised.borrow_mut() = Some((Rc::downgrade(&client), via.clone()));
        tokio::task::spawn_local(async move {
            let _ = client.request("wake", json!({ "via": via })).await;
        });
    }

    async fn ensure(self: &Rc<Self>) -> Result<Rc<Client>, CallError> {
        if let Some(client) = self.client.borrow().clone() {
            return Ok(client);
        }
        let existing = self.connecting.borrow().clone();
        let mut opening = match existing {
            Some(opening) => opening,
            None => {
                let (tx, rx) = watch::channel(None);
                *self.connecting.borrow_mut() = Some(rx.clone());
                let shim = self.clone();
                tokio::task::spawn_local(async move {
                    let opened = shim.open().await;
                    shim.connecting.borrow_mut().take();
                    let _ = tx.send(Some(opened));
                });
                rx
            }
        };
        let opened = opening
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|value| value.clone());
        opened.unwrap_or_else(|| Err(CallError::Io("the relay MCP shim is stopping".into())))
    }

    /// a broker call; a dropped connection is reopened (resume, else the same claim) and the call tried once more
    async fn call(self: &Rc<Self>, method: &str, params: Value) -> Result<Value, CallError> {
        let first = self.ensure().await?;
        match first.request(method, params.clone()).await {
            Ok(result) => Ok(result),
            Err(error) if error.is_relay() || self.stopped.get() => Err(error),
            Err(_) => {
                let current = self.client.borrow().clone();
                if current.is_some_and(|c| Rc::ptr_eq(&c, &first)) {
                    self.client.borrow_mut().take();
                    first.close();
                }
                self.ensure().await?.request(method, params).await
            }
        }
    }

    fn me_view(&self) -> Option<Value> {
        self.me.borrow().clone()
    }

    async fn tool(self: &Rc<Self>, name: &str, args: &Map<String, Value>) -> Tool {
        match name {
            "relay_whoami" => {
                let view = self.call("whoami", json!({})).await?;
                let labels: Vec<String> = get(&view, "labels")
                    .and_then(Value::as_object)
                    .map(|labels| {
                        labels
                            .iter()
                            .map(|(k, v)| format!("{k}={}", js(Some(v))))
                            .collect()
                    })
                    .unwrap_or_default();
                let title = get(&view, "title").filter(|t| truthy(Some(t)));
                let mut lines = vec![
                    format!("address: {}", js(get(&view, "address"))),
                    format!("harness: {}", nullish_or(get(&view, "harness"), "unknown")),
                    format!(
                        "title: {}",
                        title.map_or("none".into(), |t| quote(&js(Some(t))))
                    ),
                    format!(
                        "labels: {}",
                        if labels.is_empty() {
                            "none".into()
                        } else {
                            labels.join(",")
                        }
                    ),
                ];
                if let Some(peek) = get(&view, "peek") {
                    let by = list_of(get(&view, "peeked_by"));
                    lines.push(format!("peek: {}", nullish_or(Some(peek), "off")));
                    lines.push(format!(
                        "peeked by: {}",
                        if by.is_empty() {
                            "nobody".into()
                        } else {
                            by.iter().map(seen_text).collect::<Vec<_>>().join(", ")
                        }
                    ));
                }
                if let Some(pending) = get(&view, "link_pending").filter(|p| truthy(Some(p))) {
                    lines.push(format!(
                        "parent: none yet, not linked under {} ({}: {}); tried again as other machines' endpoints arrive",
                        js(get(pending, "under")),
                        js(get(pending, "code")),
                        js(get(pending, "message"))
                    ));
                }
                Ok(text(&lines.join("\n"), false))
            }
            "relay_list" => {
                if bool_arg(args, "contacts")? == Some(true) {
                    let listed = self.call("list", json!({ "contacts": true })).await?;
                    let contacts = list_of(get(&listed, "contacts"));
                    if contacts.is_empty() {
                        return Ok(text("no endpoints of contacts", false));
                    }
                    let mut lines = vec![format!(
                        "{} endpoint{} of other accounts:",
                        contacts.len(),
                        if contacts.len() == 1 { "" } else { "s" }
                    )];
                    for e in contacts {
                        lines.push(format!(
                            "{}  {}  {}",
                            js(get(e, "address")),
                            nullish_or(get(e, "harness"), "unknown"),
                            js(get(e, "presence"))
                        ));
                    }
                    return Ok(text(&lines.join("\n"), false));
                }
                let all = bool_arg(args, "all")? == Some(true);
                let listed = self
                    .call("list", json!({ "all": all, "historic": true }))
                    .await?;
                let agents: Vec<Value> = list_of(get(&listed, "endpoints"))
                    .iter()
                    .filter(|e| get(e, "kind").and_then(Value::as_str) == Some("agent"))
                    .cloned()
                    .collect();
                let historic = bool_arg(args, "historic")? == Some(true);
                let (agents, hidden) = shown_rows(&agents, all, historic, false);
                if agents.is_empty() {
                    let mut lines = vec!["no agents on the relay".to_string()];
                    lines.extend(hidden);
                    return Ok(text(&lines.join("\n"), false));
                }
                let me = self.me_view();
                let mut lines = vec![format!(
                    "{} agent{} (quoted titles, notes and directories are written by the agents themselves):",
                    agents.len(),
                    if agents.len() == 1 { "" } else { "s" }
                )];
                lines.extend(
                    agents
                        .iter()
                        .map(|e| list_line(e, me.as_ref(), self.home.as_deref())),
                );
                lines.extend(hidden);
                Ok(text(&lines.join("\n"), false))
            }
            "relay_send" => {
                let mut params = Map::new();
                params.insert("to".into(), recipients(args)?);
                params.insert("body".into(), Value::String(required(args, "body")?));
                if args.contains_key("thread") {
                    put(
                        &mut params,
                        "thread",
                        str_arg(args, "thread", false)?.map(Value::String),
                    );
                }
                if bool_arg(args, "private")? == Some(true) {
                    params.insert("data_class".into(), "private".into());
                }
                if bool_arg(args, "live")? == Some(true) {
                    params.insert("live".into(), Value::Bool(true));
                }
                params.insert("client_id".into(), Value::String(client_id()));
                let result = self.call("send", Value::Object(params)).await?;
                if let Some(held) = get(&result, "held").filter(|h| truthy(Some(h))) {
                    return Ok(text(&held_text(held), false));
                }
                let deliveries = list_of(get(&result, "deliveries"));
                let mut lines = reach_lines(deliveries, false);
                lines.extend(strings(get(&result, "warnings")));
                let to = deliveries
                    .iter()
                    .map(|d| {
                        if lines.is_empty() {
                            delivery_text(d)
                        } else {
                            nullish_or_empty(get(d, "address"))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                let read = deliveries.iter().any(|d| {
                    matches!(
                        get(d, "state").and_then(Value::as_str),
                        Some("running" | "starting")
                    )
                });
                let id = js(get(&result, "id"));
                let mut all = vec![format!(
                    "sent {id} (thread {}) to {to}{}",
                    js(get(&result, "thread")),
                    redacted_text(get(&result, "redacted"))
                )];
                all.extend(lines);
                if read {
                    all.push(format!(
                        "relay_status with id {} shows when it is read",
                        short_id(&id)
                    ));
                }
                Ok(text(&all.join("\n"), false).with(sent_content(&result)))
            }
            "relay_spawn" => {
                let mut request = spawn_request(args)?;
                let Some(spawn) = self.options.spawn.clone() else {
                    return Err(CallError::relay("method_not_found", "no tool relay_spawn").into());
                };
                let view = self.call("whoami", json!({})).await?;
                let cwd = request.cwd.clone().or_else(|| {
                    get(&view, "cwd")
                        .and_then(Value::as_str)
                        .filter(|cwd| {
                            !cwd.is_empty() && Path::new(cwd).is_absolute() && is_directory(cwd)
                        })
                        .map(PathBuf::from)
                });
                request.as_ = js(get(&view, "address"));
                request.harness = get(&view, "harness")
                    .filter(|h| truthy(Some(h)))
                    .map(|h| js(Some(h)));
                request.cwd = cwd;
                match spawn(request).await {
                    Ok(started) => Ok(text(
                        &format!(
                            "{name} started (pid {pid}) and runs in the background: its messages and its handback reach you by themselves, after your tool calls or when you stop; steer it with relay_send to {name} (it gets the message after its next tool call or before it finishes)",
                            name = started.name,
                            pid = started.pid
                        ),
                        false,
                    )
                    .with(json!({ "name": started.name, "pid": started.pid }))),
                    Err(message) => Ok(text(&message, true)),
                }
            }
            "relay_status" => {
                let receipts = self
                    .call("receipts", json!({ "id": required(args, "id")? }))
                    .await?;
                let lines = receipt_lines(&receipts);
                let mut all = vec![format!("{}:", js(get(&receipts, "id")))];
                if lines.is_empty() {
                    all.push("no deliveries of it are kept any more".into());
                } else {
                    all.extend(lines);
                }
                let structured = Value::Object(receipts.as_object().cloned().unwrap_or_default());
                Ok(text(&all.join("\n"), false).with(structured))
            }
            "relay_reply" => {
                let mut id = required(args, "id")?;
                let body = required(args, "body")?;
                let mut original = self.sent.borrow().get(&id).cloned();
                if original.is_none() {
                    let found = self
                        .call("message", json!({ "id": id, "member": true }))
                        .await?;
                    if let Some(message) = get(&found, "message").filter(|m| truthy(Some(m))) {
                        self.remember(message);
                        id = js(get(message, "id"));
                    }
                    original = self.sent.borrow().get(&id).cloned();
                }
                let Some(original) = original else {
                    return input(format!(
                        "no message {id} was delivered to this session or is in its threads; use relay_send to write to an agent"
                    ));
                };
                let mut params = Map::new();
                put(&mut params, "to", original.from.clone());
                params.insert("body".into(), Value::String(body));
                params.insert("kind".into(), "reply".into());
                params.insert("reply_to".into(), Value::String(id.clone()));
                put(&mut params, "thread", original.thread.clone());
                params.insert("client_id".into(), Value::String(client_id()));
                let result = self.call("send", Value::Object(params)).await?;
                if let Some(held) = get(&result, "held").filter(|h| truthy(Some(h))) {
                    return Ok(text(&held_text(held), false));
                }
                let deliveries = list_of(get(&result, "deliveries"));
                let to = deliveries
                    .iter()
                    .map(|d| nullish_or_empty(get(d, "address")))
                    .collect::<Vec<_>>()
                    .join(", ");
                let mut lines = vec![format!(
                    "replied {} to {to}, answering {} from {} ({id}){}",
                    js(get(&result, "id")),
                    short_id(&id),
                    js(original.from.as_ref()),
                    redacted_text(get(&result, "redacted"))
                )];
                lines.extend(reach_lines(deliveries, true));
                Ok(text(&lines.join("\n"), false).with(sent_content(&result)))
            }
            "relay_inbox" => {
                let ack = bool_arg(args, "ack")?.unwrap_or(true);
                let result = self
                    .call("inbox", json!({ "wait_s": seconds(args, 0)? }))
                    .await?;
                let messages = list_of(get(&result, "messages"));
                if messages.is_empty() {
                    let cap = if capped(args.get("wait_s")) {
                        format!("; waited {} s (cap)", LIMITS.wait_max_s)
                    } else {
                        String::new()
                    };
                    return Ok(text(&format!("no unread messages{cap}"), false));
                }
                for message in messages {
                    self.remember(message);
                }
                if ack {
                    let seqs: Vec<Value> = messages
                        .iter()
                        .map(|m| get(m, "seq").cloned().unwrap_or(Value::Null))
                        .collect();
                    self.call("ack", json!({ "seqs": seqs })).await?;
                }
                Ok(text(&delivered(messages), false))
            }
            "relay_ask" => {
                let mut params = Map::new();
                params.insert("to".into(), Value::String(required(args, "to")?));
                params.insert("body".into(), Value::String(required(args, "body")?));
                params.insert("wait_s".into(), seconds(args, ASK_WAIT_DEFAULT_S)?);
                if bool_arg(args, "require_reply")? == Some(true) {
                    params.insert("require_reply".into(), Value::Bool(true));
                }
                params.insert("client_id".into(), Value::String(client_id()));
                let result = self.call("ask", Value::Object(params)).await?;
                if let Some(held) = get(&result, "held").filter(|h| truthy(Some(h))) {
                    return Ok(text(&held_text(held), false));
                }
                if let Some(reply) = get(&result, "reply").filter(|r| truthy(Some(r))) {
                    self.remember(reply);
                }
                let redacted = get(&result, "redacted").filter(|r| truthy(Some(r)));
                let head = match redacted {
                    Some(redacted) => format!(
                        "request {} delivered{}\n",
                        js(get(&result, "id")),
                        redacted_text(Some(redacted))
                    ),
                    None => String::new(),
                };
                Ok(text(&format!("{head}{}", ask_text(&result)), false))
            }
            "relay_ask_wait" => {
                let result = self
                    .call("ask_wait", json!({ "id": required(args, "id")?, "wait_s": seconds(args, ASK_WAIT_DEFAULT_S)? }))
                    .await?;
                if let Some(reply) = get(&result, "reply").filter(|r| truthy(Some(r))) {
                    self.remember(reply);
                }
                Ok(text(&ask_text(&result), false))
            }
            "relay_set_status" => {
                let state = required(args, "state")?;
                if !STATUS_STATES.iter().any(|s| s.as_str() == state) {
                    let all: Vec<&str> = STATUS_STATES.iter().map(|s| s.as_str()).collect();
                    return input(format!("state must be one of {}", all.join(", ")));
                }
                let note = str_arg(args, "note", false)?.unwrap_or_default();
                let view = self
                    .call("status", json!({ "state": state, "note": note }))
                    .await?;
                Ok(text(&status_text(&view), false))
            }
            "relay_set_now" => {
                let Some(Value::String(now)) = args.get("now") else {
                    return input("now must be a string");
                };
                let view = self.call("status", json!({ "note": now })).await?;
                Ok(text(&status_text(&view), false))
            }
            "relay_join" => {
                let name = str_arg(args, "name", false)?.filter(|n| !n.is_empty());
                let under = str_arg(args, "under", false)?.filter(|u| !u.is_empty());
                let current = self
                    .bound
                    .borrow()
                    .clone()
                    .unwrap_or_else(|| self.options.claim.clone());
                let mut claim = current.clone();
                if let Some(membership) = &self.options.membership
                    && let Membership::Joined(Some(handle)) =
                        membership(&nullish_or_empty(current.get("session")))
                    && !handle.is_empty()
                {
                    claim.insert("handle".into(), Value::String(handle));
                }
                let next = (self.options.connect)().await?;
                let mut join = Map::new();
                put(&mut join, "handle", name.map(Value::String));
                put(&mut join, "under", under.map(Value::String));
                let mut fields = Map::new();
                fields.insert("transient".into(), Value::Bool(true));
                fields.insert("claim".into(), Value::Object(claim));
                fields.insert("join".into(), Value::Object(join));
                let joined = next.hello(fields).await;
                next.close();
                let hello = joined?;
                *self.me.borrow_mut() = get(&hello, "endpoint").filter(|e| !e.is_null()).cloned();
                self.ensure().await?;
                let me = self.me_view();
                let me = me.as_ref();
                let parent = me
                    .and_then(|m| get(m, "parent"))
                    .filter(|p| truthy(Some(p)));
                Ok(text(
                    &format!(
                        "joined the relay as {}{}: peers can message you, and new messages reach you after your tool calls",
                        js(me.and_then(|m| get(m, "address"))),
                        parent.map_or(String::new(), |p| format!(" under {}", js(Some(p))))
                    ),
                    false,
                ))
            }
            "relay_link_accept" => {
                let result = self
                    .call("link_accept", json!({ "id": required(args, "id")? }))
                    .await?;
                let endpoint = get(&result, "endpoint");
                *self.me.borrow_mut() = endpoint.filter(|e| !e.is_null()).cloned();
                Ok(text(
                    &format!(
                        "{} now sits under {} as its worker",
                        js(endpoint.and_then(|e| get(e, "address"))),
                        js(get(&result, "parent"))
                    ),
                    false,
                ))
            }
            "relay_leave" => {
                let view = self.call("leave", json!({})).await?;
                if let Some(client) = self.client.borrow_mut().take() {
                    client.close();
                }
                self.token.borrow_mut().take();
                Ok(text(
                    &format!(
                        "{} left the relay: it shows offline and gets no new messages pushed; its mail is kept until relay_join",
                        js(get(&view, "address"))
                    ),
                    false,
                ))
            }
            "relay_set_title" => {
                let Some(Value::String(title)) = args.get("title") else {
                    return input("title must be a string");
                };
                let view = self.call("title", json!({ "text": title })).await?;
                let shown = match get(&view, "title").filter(|t| truthy(Some(t))) {
                    Some(title) => format!("title {}", quote(&js(Some(title)))),
                    None => "title cleared".into(),
                };
                Ok(text(
                    &format!("{}: {shown}", js(get(&view, "address"))),
                    false,
                ))
            }
            "relay_rules" => self.rules(args).await,
            "relay_group" => {
                let action = one_of(
                    args,
                    "action",
                    &["create", "add", "remove", "rules", "ls", "show", "drop"],
                )?;
                let mut params = Map::new();
                params.insert("action".into(), Value::String(action));
                put(
                    &mut params,
                    "name",
                    str_arg(args, "name", false)?.map(Value::String),
                );
                put(
                    &mut params,
                    "endpoint",
                    str_arg(args, "endpoint", false)?.map(Value::String),
                );
                for key in ["rules", "in", "out"] {
                    put(&mut params, key, selectors(args, key)?.map(|s| json!(s)));
                }
                let result = self.call("group", Value::Object(params)).await?;
                Ok(text(&group_text(&result), false))
            }
            "relay_peers" => {
                let all = bool_arg(args, "all")? == Some(true);
                let listed = self
                    .call("peers", json!({ "all": all, "historic": true }))
                    .await?;
                let rows = list_of(get(&listed, "peers"));
                let historic = bool_arg(args, "historic")? == Some(true);
                let (peers, hidden) = shown_rows(rows, all, historic, true);
                let mut lines: Vec<String> = if peers.is_empty() {
                    vec!["nobody you may message".into()]
                } else {
                    peers.iter().map(|p| peer_line(p)).collect()
                };
                lines.extend(hidden);
                Ok(text(&lines.join("\n"), false))
            }
            "relay_peek" => {
                if bool_arg(args, "who")? == Some(true) {
                    let params = if args.contains_key("endpoint") {
                        json!({ "endpoint": required(args, "endpoint")? })
                    } else {
                        json!({})
                    };
                    let result = self.call("peek_who", params).await?;
                    let seen = list_of(get(&result, "peeked_by"));
                    let shown = if seen.is_empty() {
                        "nobody peeked".to_string()
                    } else {
                        seen.iter().map(seen_text).collect::<Vec<_>>().join("\n")
                    };
                    return Ok(text(&shown, false));
                }
                let turns = peek_turns(args)?;
                let mut params = Map::new();
                params.insert(
                    "endpoint".into(),
                    Value::String(required(args, "endpoint")?),
                );
                put(&mut params, "turns", turns.map(|t| json!(t)));
                if bool_arg(args, "full")? == Some(true) {
                    params.insert("full".into(), Value::Bool(true));
                }
                let result = self.call("peek", Value::Object(params)).await?;
                Ok(text(
                    &format!("{PREAMBLE}\n\n{}", wrap_peek(&result)),
                    false,
                ))
            }
            "relay_set_peek" => {
                let Some(on) = bool_arg(args, "on")? else {
                    return input("on must be true or false");
                };
                let result = self
                    .call(
                        "peek_set",
                        json!({ "level": if on { "on" } else { "off" } }),
                    )
                    .await?;
                Ok(text(
                    &format!(
                        "{}: peek {}",
                        js(get(&result, "endpoint")),
                        nullish_or(get(&result, "peek"), "off")
                    ),
                    false,
                ))
            }
            _ => Err(CallError::relay("method_not_found", format!("no tool {name}")).into()),
        }
    }

    async fn rules(self: &Rc<Self>, args: &Map<String, Value>) -> Tool {
        let action = one_of(args, "action", &["show", "set", "widen", "lift", "why"])?;
        let endpoint = str_arg(args, "endpoint", false)?;
        let named = endpoint.clone().filter(|e| !e.is_empty());
        match action.as_str() {
            "show" => {
                let params = match &named {
                    Some(endpoint) => json!({ "endpoint": endpoint }),
                    None => json!({}),
                };
                Ok(text(&scope_text(&self.call("rules", params).await?), false))
            }
            "set" => {
                let rules_in = selectors(args, "in")?;
                let rules_out = selectors(args, "out")?;
                let scope = if args.contains_key("scope") {
                    Some(one_of(args, "scope", &["open", "tree", "parent", "none"])?)
                } else {
                    None
                };
                let allow = selectors(args, "allow")?;
                if rules_in.is_none() && rules_out.is_none() && scope.is_none() && allow.is_none() {
                    return input("set takes in, out, scope or allow");
                }
                let mut params = Map::new();
                put(&mut params, "endpoint", endpoint.map(Value::String));
                put(&mut params, "in", rules_in.map(|s| json!(s)));
                put(&mut params, "out", rules_out.map(|s| json!(s)));
                put(&mut params, "scope", scope.map(Value::String));
                put(&mut params, "allow", allow.map(|s| json!(s)));
                Ok(text(
                    &scope_text(&self.call("rules_set", Value::Object(params)).await?),
                    false,
                ))
            }
            "widen" => {
                let Some(endpoint) = named else {
                    return input("widen takes the endpoint to loosen");
                };
                let mut params = Map::new();
                params.insert("endpoint".into(), Value::String(endpoint.clone()));
                put(&mut params, "in", selectors(args, "in")?.map(|s| json!(s)));
                put(
                    &mut params,
                    "out",
                    selectors(args, "out")?.map(|s| json!(s)),
                );
                let change = self.call("rules_widen", Value::Object(params)).await?;
                Ok(text(&widen_text(&change, &endpoint).join("\n"), false))
            }
            "lift" => {
                let Some(endpoint) = named else {
                    return input("lift takes the endpoint and the cap id");
                };
                let params = json!({ "endpoint": endpoint, "cap": required(args, "cap")? });
                Ok(text(
                    &scope_text(&self.call("rules_lift", params).await?),
                    false,
                ))
            }
            _ => {
                let from = match str_arg(args, "from", false)? {
                    Some(from) => Some(Value::String(from)),
                    None => get(&self.call("whoami", json!({})).await?, "address").cloned(),
                };
                let mut params = Map::new();
                put(&mut params, "from", from.clone());
                params.insert("to".into(), Value::String(required(args, "to")?));
                let result = self.call("why", Value::Object(params)).await?;
                let mut lines = vec![format!(
                    "{} {} message {}",
                    js(from.as_ref()),
                    if truthy(get(&result, "allowed")) {
                        "may"
                    } else {
                        "may not"
                    },
                    js(args.get("to"))
                )];
                lines.extend(
                    strings(get(&result, "reasons"))
                        .into_iter()
                        .map(|r| format!("  {r}")),
                );
                Ok(text(&lines.join("\n"), false))
            }
        }
    }

    async fn call_tool(self: &Rc<Self>, params: &Map<String, Value>) -> ToolResult {
        let name = js(params.get("name"));
        let args = match params.get("arguments") {
            None | Some(Value::Null) => Map::new(),
            Some(Value::Object(args)) => args.clone(),
            Some(_) => return text("invalid_params: arguments must be an object", true),
        };
        match self.tool(&name, &args).await {
            Ok(result) => result,
            Err(ToolError::Input(message)) => text(&format!("invalid_params: {message}"), true),
            Err(ToolError::Call(CallError::Relay {
                code,
                message,
                retry_after_s,
            })) => {
                let retry = match retry_after_s.filter(|s| *s != 0.0 && !s.is_nan()) {
                    Some(s) => format!(" (retry in {} s)", crate::tools::js_num(s)),
                    None => String::new(),
                };
                text(&format!("{code}: {message}{retry}"), true)
            }
            Err(ToolError::Call(CallError::Io(message))) => text(
                &format!("unavailable: the relay broker cannot be reached ({message})"),
                true,
            ),
        }
    }

    async fn push_channel(self: Rc<Self>) {
        let mut failures = 0u32;
        while !self.stopped.get() && (self.channel_client.get() || self.inbox.borrow().is_some()) {
            if let Err(error) = self.push_round(&mut failures).await {
                if self.stopped.get() {
                    break;
                }
                self.log(&format!(
                    "{CLI_NAME} mcp: channel poll failed: {}",
                    error.message()
                ));
                let pause = channel_retry_ms(&error, failures);
                failures += 1;
                tokio::time::sleep(Duration::from_millis(pause)).await;
            }
        }
        self.channel_loop.set(false);
    }

    async fn push_round(self: &Rc<Self>, failures: &mut u32) -> Result<(), CallError> {
        let result = self
            .call(
                "inbox",
                json!({ "wait_s": LIMITS.inject_hold_s, "offer": true }),
            )
            .await?;
        *failures = 0;
        let messages = list_of(get(&result, "messages"));
        for message in messages {
            let Some(seq) = get(message, "seq") else {
                continue;
            };
            let key = seq.to_string();
            if self.stopped.get() || self.channel_pushed.borrow().get(&key).is_some() {
                continue;
            }
            self.channel_pushed.borrow_mut().set(key.clone(), ());
            self.remember(message);
            let content = format!("{PREAMBLE}\n\n{}", wrap_message(message));
            let inbox = self.inbox.borrow().clone();
            if let Some(inbox) = inbox {
                if let Err(error) =
                    send_to_session_inbox(&inbox, &content, SESSION_INBOX_TIMEOUT).await
                {
                    self.channel_pushed.borrow_mut().remove(&key);
                    return Err(CallError::Io(error));
                }
            } else {
                self.write(&channel_line(message, seq, &content));
            }
        }
        let pushed: Vec<Value> = messages
            .iter()
            .filter_map(|m| get(m, "seq"))
            .filter(|seq| self.channel_pushed.borrow().get(&seq.to_string()).is_some())
            .cloned()
            .collect();
        if !pushed.is_empty() {
            let mut params = Map::new();
            params.insert("seqs".into(), Value::Array(pushed));
            put(&mut params, "hold", get(&result, "hold").cloned());
            self.call("injected", Value::Object(params)).await?;
        }
        Ok(())
    }

    fn initialize(&self, params: &Map<String, Value>) -> String {
        let asked = params.get("protocolVersion").and_then(Value::as_str);
        let protocol = asked
            .filter(|v| MCP_PROTOCOLS.contains(v))
            .unwrap_or(MCP_PROTOCOLS[0]);
        self.initialized.set(true);
        let channel = params
            .get("capabilities")
            .and_then(|c| get(c, "experimental"))
            .and_then(|e| get(e, "claude/channel"));
        let channel_client = matches!(channel, Some(Value::Object(_) | Value::Array(_)))
            || self.options.launched_with_channels;
        self.channel_client.set(channel_client);
        let client_name = params.get("clientInfo").and_then(|c| get(c, "name"));
        let named = client_name.and_then(Value::as_str);
        let env = |key: &str| self.options.env.get(key).map(String::as_str);
        let cowork = env("CLAUDE_CODE_IS_COWORK") == Some("1")
            || env("CLAUDE_CODE_ENTRYPOINT") == Some("remote_cowork");
        let claude = named == Some("claude-code")
            || (cowork && named.is_some_and(|n| n.starts_with("claude")));
        let inbox = if self.options.channels && !channel_client && claude {
            self.options.session_inbox.clone()
        } else {
            None
        };
        let wake = if self.options.channels && channel_client {
            Some(self.options.wake.clone().unwrap_or_else(|| {
                if named == Some("pi") {
                    "pi".into()
                } else {
                    "channels".into()
                }
            }))
        } else if inbox.is_some() {
            Some("claude-inbox".into())
        } else {
            None
        };
        *self.inbox.borrow_mut() = inbox;
        *self.wake.borrow_mut() = Some(wake);
        self.advertise();
        let experimental = if self.options.channels {
            ",\"experimental\":{\"claude/channel\":{}}"
        } else {
            ""
        };
        format!(
            "{{\"protocolVersion\":{},\"capabilities\":{{\"tools\":{{}}{experimental}}},\"serverInfo\":{{\"name\":\"scp\",\"version\":{}}},\"instructions\":{}}}",
            Value::String(protocol.into()),
            Value::String(
                self.options
                    .version
                    .clone()
                    .unwrap_or_else(|| "0.1.0".into())
            ),
            Value::String(INSTRUCTIONS.clone())
        )
    }

    /// one request or notification; a tools/call runs on its own task, everything else answers at once
    fn handle(self: &Rc<Self>, message: Map<String, Value>) {
        let has_id = message.contains_key("id");
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        if has_id && !matches!(id, Value::Null | Value::String(_) | Value::Number(_)) {
            return self.write(&error_line(
                &Value::Null,
                -32600,
                "a request id is a string, a number or null",
            ));
        }
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            if has_id {
                self.write(&error_line(&id, -32600, "a request names its method"));
            }
            return;
        };
        let params = match message.get("params") {
            Some(Value::Object(params)) => params.clone(),
            _ => Map::new(),
        };
        if !has_id {
            if method == "notifications/initialized"
                && self.options.channels
                && (self.channel_client.get() || self.inbox.borrow().is_some())
                && !self.channel_loop.get()
            {
                self.channel_loop.set(true);
                tokio::task::spawn_local(self.clone().push_channel());
            }
            return;
        }
        match method {
            "initialize" => {
                let result = self.initialize(&params);
                self.write(&response(&id, &result));
            }
            "ping" => self.write(&response(&id, "{}")),
            "tools/list" => self.write(&response(
                &id,
                &format!("{{\"tools\":{}}}", tools_json(self.spawns)),
            )),
            "tools/call" => {
                if !self.initialized.get() {
                    return self.write(&error_line(&id, -32002, "call initialize first"));
                }
                let name = params.get("name").and_then(Value::as_str);
                if !name.is_some_and(|name| tool_names(self.spawns).iter().any(|t| t == name)) {
                    let shown = params
                        .get("name")
                        .map_or("undefined".into(), Value::to_string);
                    return self.write(&error_line(&id, -32602, &format!("unknown tool {shown}")));
                }
                let meta = match params.get("_meta") {
                    Some(Value::Object(meta)) => meta.clone(),
                    _ => Map::new(),
                };
                match self
                    .options
                    .thread_claim
                    .as_ref()
                    .and_then(|claim| claim(&meta))
                {
                    Some(named) => self.bind(named),
                    None if self.bound.borrow().is_none() => self.bind(self.options.claim.clone()),
                    None => {}
                }
                self.in_flight.send_modify(|n| *n += 1);
                let shim = self.clone();
                tokio::task::spawn_local(async move {
                    let result = shim.call_tool(&params).await;
                    shim.write(&response(&id, &result.to_json()));
                    shim.in_flight.send_modify(|n| *n -= 1);
                });
            }
            _ => self.write(&error_line(
                &id,
                -32601,
                &format!("method not found: {method}"),
            )),
        }
    }

    fn line(self: &Rc<Self>, raw: &[u8]) {
        let raw = String::from_utf8_lossy(raw);
        if js_trim(&raw).is_empty() {
            return;
        }
        match serde_json::from_str::<Value>(&raw) {
            Err(_) => self.write(&error_line(&Value::Null, -32700, "parse error")),
            Ok(Value::Object(message)) => self.handle(message),
            Ok(_) => self.write(&error_line(
                &Value::Null,
                -32600,
                "a request is a JSON object",
            )),
        }
    }
}

fn nullish_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.to_string(),
        other => js(other),
    }
}

fn status_text(view: &Value) -> String {
    let status = get(view, "status");
    let note = match status
        .and_then(|s| get(s, "note"))
        .filter(|n| truthy(Some(n)))
    {
        Some(note) => format!(": {}", quote(&js(Some(note)))),
        None => String::new(),
    };
    format!(
        "{}: {}{note}",
        js(get(view, "address")),
        js(status.and_then(|s| get(s, "state")))
    )
}

fn peer_line(p: &Value) -> String {
    let title = get(p, "title")
        .filter(|t| truthy(Some(t)))
        .map(|t| format!("title {}", quote(&js(Some(t)))));
    let status = get(p, "status")
        .filter(|s| truthy(Some(s)))
        .map(status_line);
    let shown = |key: &str| get(p, key).filter(|v| truthy(Some(v))).map(|v| js(Some(v)));
    [
        shown("address"),
        shown("kind"),
        shown("presence"),
        title,
        status,
        shown("reason"),
        truthy(get(p, "peekable")).then(|| "peekable".to_string()),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("  ")
}

/// a channel push of one delivered message
fn channel_line(message: &Value, seq: &Value, content: &str) -> String {
    let mut meta = Vec::new();
    let mut field = |key: &str, value: Option<&Value>| {
        if let Some(value) = value {
            meta.push(format!("{}:{value}", Value::String(key.into())));
        }
    };
    field("from", get(message, "from").and_then(|f| get(f, "address")));
    field("id", get(message, "id"));
    let seq = Value::String(js(Some(seq)));
    field("seq", Some(&seq));
    field("thread", get(message, "thread"));
    if let Some(target) = get(message, "for").filter(|f| truthy(Some(f))) {
        field("for", get(target, "address"));
        field("subagent", get(target, "subagent"));
    }
    format!(
        "{{\"jsonrpc\":\"2.0\",\"method\":\"notifications/claude/channel\",\"params\":{{\"content\":{},\"meta\":{{{}}}}}}}\n",
        Value::String(content.into()),
        meta.join(",")
    )
}

/// serves MCP on `input` until it ends, writing each JSON-RPC line (newline included) with `output`; runs on a tokio LocalSet
pub async fn run<R>(options: Options, mut input: R, output: Rc<dyn Fn(&str)>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let heartbeat_ms = options.heartbeat_ms.max(1);
    let bound = (!options.defer_claim).then(|| options.claim.clone());
    let shim = Rc::new(Shim {
        spawns: options.spawn.is_some(),
        home: options.env.get("HOME").cloned(),
        options,
        output,
        sent: RefCell::new(Recent::new(DELIVERED_KEEP)),
        client: RefCell::new(None),
        connecting: RefCell::new(None),
        token: RefCell::new(None),
        me: RefCell::new(None),
        announced: Cell::new(false),
        initialized: Cell::new(false),
        channel_client: Cell::new(false),
        inbox: RefCell::new(None),
        stopped: Cell::new(false),
        channel_pushed: RefCell::new(Recent::new(DELIVERED_KEEP)),
        channel_loop: Cell::new(false),
        wake: RefCell::new(None),
        advertised: RefCell::new(None),
        bound: RefCell::new(bound),
        rebound: Cell::new(false),
        in_flight: watch::Sender::new(0),
    });
    if shim.session_claim().is_ok() {
        let first = shim.clone();
        tokio::task::spawn_local(async move {
            if let Err(error) = first.ensure().await {
                first.log(&format!(
                    "{CLI_NAME} mcp: could not reach the relay broker yet: {}",
                    error.message()
                ));
            }
        });
    }
    let beat = shim.clone();
    let heartbeat = tokio::task::spawn_local(async move {
        let period = Duration::from_millis(heartbeat_ms);
        let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        loop {
            ticks.tick().await;
            let shim = beat.clone();
            tokio::task::spawn_local(async move {
                let _ = shim.call("whoami", json!({})).await;
            });
        }
    });

    let mut buffer: Vec<u8> = Vec::new();
    let mut scanned = 0;
    let mut skipping = false;
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = match input.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buffer.extend_from_slice(&chunk[..n]);
        let mut from = 0;
        while let Some(at) = buffer[scanned..].iter().position(|b| *b == b'\n') {
            let end = scanned + at;
            if skipping {
                skipping = false;
            } else {
                shim.line(&buffer[from..end]);
            }
            from = end + 1;
            scanned = from;
        }
        buffer.drain(..from);
        scanned = buffer.len();
        if buffer.len() > MAX_INPUT_LINE {
            if !skipping {
                shim.write(&error_line(&Value::Null, -32600, "request too large"));
            }
            skipping = true;
            buffer.clear();
            scanned = 0;
        }
    }
    if !buffer.is_empty() && !skipping {
        shim.line(&buffer);
    }
    let mut idle = shim.in_flight.subscribe();
    let cap = Duration::from_secs(LIMITS.wait_max_s + 10);
    let _ = tokio::time::timeout(cap, idle.wait_for(|n| *n == 0)).await;
    shim.stopped.set(true);
    heartbeat.abort();
    if let Some(client) = shim.client.borrow_mut().take() {
        client.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn a_refused_claim_backs_off_to_five_minutes_and_other_failures_keep_their_pause() {
        let refused = CallError::relay("unauthorized", "grant refused: grant invalid");
        assert_eq!(
            [0, 1, 2, 3].map(|n| channel_retry_ms(&refused, n)),
            [5000, 10_000, 20_000, 40_000]
        );
        assert_eq!(channel_retry_ms(&refused, 10), 300_000);
        assert_eq!(channel_retry_ms(&refused, 10_000), 300_000);
        assert_eq!(
            channel_retry_ms(&CallError::relay("unavailable", "down"), 10),
            5000
        );
        assert_eq!(
            channel_retry_ms(&CallError::Io("socket closed".into()), 10),
            1000
        );
    }

    #[test]
    fn recent_keeps_the_newest() {
        let mut recent = Recent::new(2);
        recent.set("a".into(), 1);
        recent.set("b".into(), 2);
        recent.remove("a");
        recent.set("a".into(), 3);
        recent.set("c".into(), 4);
        assert_eq!(
            (recent.get("a"), recent.get("b"), recent.get("c")),
            (Some(&3), None, Some(&4))
        );
    }

    #[test]
    fn spawn_arguments_become_a_request() {
        let args = |v: Value| v.as_object().cloned().unwrap_or_default();
        let request = spawn_request(&args(
            json!({ "harness": "codex", "task": "fix", "model": "m", "no_push": true }),
        ))
        .ok();
        assert_eq!(
            request.map(|r| (r.command, r.no_push)),
            Some((
                vec![
                    "codex".into(),
                    "exec".into(),
                    "fix".into(),
                    "--model".into(),
                    "m".into()
                ],
                true
            ))
        );
        for bad in [
            json!({}),
            json!({ "command": [] }),
            json!({ "command": ["x"], "task": "t" }),
            json!({ "command": ["x"], "handback_bytes": 0 }),
        ] {
            assert!(matches!(
                spawn_request(&args(bad)),
                Err(ToolError::Input(_))
            ));
        }
    }

    fn serve(lines: &str) -> Vec<Value> {
        let written = Rc::new(RefCell::new(String::new()));
        let sink = written.clone();
        let options = Options {
            connect: Rc::new(|| Box::pin(async { Err(CallError::Io("no broker".into())) })),
            claim: Map::new(),
            membership: None,
            thread_claim: None,
            defer_claim: true,
            bound: None,
            env: HashMap::new(),
            channels: false,
            launched_with_channels: false,
            session_inbox: None,
            wake: None,
            version: None,
            spawn: None,
            log: Rc::new(|_| {}),
            heartbeat_ms: 60_000,
        };
        let input = lines.as_bytes().to_vec();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok();
        let local = tokio::task::LocalSet::new();
        if let Some(runtime) = runtime {
            local.block_on(
                &runtime,
                run(
                    options,
                    &input[..],
                    Rc::new(move |line: &str| sink.borrow_mut().push_str(line)),
                ),
            );
        }
        let out = written.borrow().clone();
        assert!(out.ends_with('\n'));
        out.lines()
            .map(|l| serde_json::from_str(l).unwrap_or(Value::Null))
            .collect()
    }

    #[test]
    fn framing_errors_answer_by_their_codes() {
        let out = serve(concat!(
            "not json\n",
            "[1]\n",
            "{\"jsonrpc\":\"2.0\",\"id\":41}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":{\"x\":1},\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1.5,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":\"s\",\"method\":\"tools/call\",\"params\":{\"name\":\"relay_whoami\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"nope\"}\n",
            "\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"ping\"}"
        ));
        let codes: Vec<Value> = out.iter().map(|m| m["error"]["code"].clone()).collect();
        assert_eq!(
            codes,
            [
                json!(-32700),
                json!(-32600),
                json!(-32600),
                json!(-32600),
                Value::Null,
                json!(-32002),
                json!(-32601),
                Value::Null
            ]
        );
        assert_eq!(out[4]["id"], json!(1.5));
        assert_eq!(out[7]["id"], json!(3));
    }

    #[test]
    fn an_oversized_line_is_refused_once_and_the_next_one_served() {
        let big = format!(
            "{}\n{{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"ping\"}}\n",
            "x".repeat(MAX_INPUT_LINE + 70_000)
        );
        let out = serve(&big);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["error"]["message"], "request too large");
        assert_eq!(out[1]["id"], 9);
    }

    #[test]
    fn tools_list_hides_spawn_and_a_call_reaches_no_broker_as_unavailable() {
        let out = serve(concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"1999\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"relay_spawn\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"relay_inbox\",\"arguments\":{}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"relay_inbox\",\"arguments\":[]}}\n",
        ));
        assert_eq!(out[0]["result"]["protocolVersion"], MCP_PROTOCOLS[0]);
        assert_eq!(out[0]["result"]["instructions"], INSTRUCTIONS.as_str());
        assert_eq!(out[1]["result"]["tools"].as_array().map(Vec::len), Some(19));
        assert_eq!(out[2]["error"]["message"], "unknown tool \"relay_spawn\"");
        let by_id = |id: i64| {
            out.iter()
                .find(|m| m["id"] == id)
                .cloned()
                .unwrap_or(Value::Null)
        };
        assert_eq!(
            by_id(3)["result"]["content"][0]["text"],
            "unavailable: the relay broker cannot be reached (no broker)"
        );
        assert_eq!(
            by_id(4)["result"]["content"][0]["text"],
            "invalid_params: arguments must be an object"
        );
    }
}
