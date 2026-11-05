//! `swarm mcp`: the stdio MCP shim for this harness session.

use crate::identity::{
    Binding, IdentityInput, ShimBinding, cowork_live, field, relay_dir, relay_identity, safe_cwd,
    wake_ticket, write_shim_binding,
};
use crate::ps::{
    Env, PsCommTable, SHELL_PS_TIMEOUT_MS, Table, app_server, harness_at, harness_pid, js_integer,
    launcher_pid, ps_parent, read_ps_table,
};
use crate::server::{Options, SpawnRequest};
use crate::spawn::{spawn_detached, spawn_words, start_daemon};
use crate::{Claim, Membership};
use scp_core::address::valid_handle;
use scp_core::protocol::CLI_NAME;
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// how often the shim checks that the harness that started it still runs
const ORPHAN_CHECK_MS: u64 = 5000;
/// exit code for the CLI's own failures
pub const FAILED: i32 = 125;
/// the pid of the launcher `swarm claude` started a harness with channels from
pub const CHANNELS_ENV: &str = "SCP_CHANNELS";
/// the parent of the CLI process that started this binary in its place
pub const SHIM_PPID: &str = "SCP_SHIM_PPID";

const STRING_OPTIONS: [&str; 38] = [
    "machine",
    "token",
    "label",
    "push-wait",
    "as",
    "harness",
    "wait",
    "reply-to",
    "thread",
    "attach",
    "tool",
    "summary",
    "since",
    "limit",
    "idle",
    "policy",
    "scope",
    "in",
    "out",
    "allow",
    "rules",
    "group",
    "under",
    "ttl",
    "labels",
    "handback-bytes",
    "name",
    "title",
    "reason",
    "turns",
    "peek",
    "endpoint",
    "parent",
    "via",
    "wake",
    "eta",
    "ref",
    "secret-env",
];
const BOOLEAN_OPTIONS: [&str; 33] = [
    "cloud",
    "no-browser",
    "json",
    "channels",
    "cowork-only",
    "write",
    "print",
    "block-stop-on-unread",
    "all",
    "ack",
    "keep",
    "require-reply",
    "private",
    "human",
    "help",
    "tree",
    "roots",
    "contacts",
    "activity",
    "no-push",
    "durable",
    "no-durable",
    "bg",
    "fg",
    "judge",
    "redacted",
    "full",
    "who",
    "take-over",
    "dry-run",
    "live",
    "gone",
    "clear",
];
/// the flags `swarm mcp` takes
const MCP_OPTIONS: [&str; 5] = ["as", "harness", "human", "channels", "cowork-only"];

/// a usage error, as the CLI reports one
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Usage(pub String);

/// `swarm mcp`'s flags and words
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Values {
    pub as_: Option<String>,
    pub harness: Option<String>,
    pub human: bool,
    pub channels: bool,
    pub cowork_only: bool,
    pub help: bool,
    pub positionals: Vec<String>,
}

#[derive(PartialEq)]
enum Kind {
    Text,
    Flag,
    Unknown,
}

fn kind(name: &str) -> Kind {
    if STRING_OPTIONS.contains(&name) {
        Kind::Text
    } else if BOOLEAN_OPTIONS.contains(&name) {
        Kind::Flag
    } else {
        Kind::Unknown
    }
}

fn long_for_short(short: &str) -> String {
    if short == "h" {
        "help".into()
    } else {
        short.into()
    }
}

struct Token {
    name: String,
    raw: String,
    value: Option<String>,
    inline: bool,
}

/// the arguments as the CLI's strict `parseArgs` with positionals reads them, checked as `swarm mcp` checks its flags
pub fn parse_args(args: &[String]) -> Result<Values, Usage> {
    let mut remaining: std::collections::VecDeque<String> = args.iter().cloned().collect();
    let mut tokens: Vec<Result<Token, String>> = Vec::new();
    while let Some(arg) = remaining.pop_front() {
        let chars: Vec<char> = arg.chars().collect();
        let next_present = !remaining.is_empty();
        if arg == "--" {
            tokens.extend(remaining.drain(..).map(Err));
            break;
        }
        if chars.len() == 2 && chars[0] == '-' && chars[1] != '-' {
            let name = long_for_short(&chars[1].to_string());
            let value = (kind(&name) == Kind::Text && next_present)
                .then(|| remaining.pop_front())
                .flatten();
            tokens.push(Ok(Token {
                name,
                raw: arg,
                value,
                inline: false,
            }));
            continue;
        }
        if chars.len() > 2 && chars[0] == '-' && chars[1] != '-' {
            let first = long_for_short(&chars[1].to_string());
            if kind(&first) != Kind::Text {
                let mut expanded = Vec::new();
                for index in 1..chars.len() {
                    let short = chars[index].to_string();
                    if kind(&long_for_short(&short)) != Kind::Text || index == chars.len() - 1 {
                        expanded.push(format!("-{short}"));
                    } else {
                        expanded.push(format!("-{}", chars[index..].iter().collect::<String>()));
                        break;
                    }
                }
                for word in expanded.into_iter().rev() {
                    remaining.push_front(word);
                }
            } else {
                let value: String = chars[2..].iter().collect();
                tokens.push(Ok(Token {
                    name: first,
                    raw: format!("-{}", chars[1]),
                    value: Some(value),
                    inline: true,
                }));
            }
            continue;
        }
        if chars.len() > 2 && arg.starts_with("--") {
            let first = arg[2..].chars().next().map_or(0, char::len_utf8);
            match arg[2 + first..].find('=').map(|at| at + 2 + first) {
                None => {
                    let name = arg[2..].to_string();
                    let value = (kind(&name) == Kind::Text && next_present)
                        .then(|| remaining.pop_front())
                        .flatten();
                    tokens.push(Ok(Token {
                        name,
                        raw: arg,
                        value,
                        inline: false,
                    }));
                }
                Some(eq) => {
                    let name = arg[2..eq].to_string();
                    tokens.push(Ok(Token {
                        raw: format!("--{name}"),
                        name,
                        value: Some(arg[eq + 1..].to_string()),
                        inline: true,
                    }));
                }
            }
            continue;
        }
        tokens.push(Err(arg));
    }

    let mut values = Values::default();
    let mut order: Vec<String> = Vec::new();
    for token in tokens {
        let token = match token {
            Err(positional) => {
                values.positionals.push(positional);
                continue;
            }
            Ok(token) => token,
        };
        let shown = if token.name == "help" {
            "-h, --help".to_string()
        } else {
            format!("--{}", token.name)
        };
        match kind(&token.name) {
            Kind::Unknown => {
                return Err(Usage(format!(
                    "Unknown option '{}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- {}",
                    token.raw,
                    serde_json::to_string(&token.raw).unwrap_or_default()
                )));
            }
            Kind::Text if token.value.is_none() => {
                return Err(Usage(format!("Option '{shown} <value>' argument missing")));
            }
            Kind::Flag if token.value.is_some() => {
                return Err(Usage(format!("Option '{shown}' does not take an argument")));
            }
            _ => {}
        }
        if let Some(value) = &token.value
            && !token.inline
            && value.encode_utf16().count() > 1
            && value.starts_with('-')
        {
            let example = if token.raw.starts_with("--") {
                format!("'{}=-XYZ'", token.raw)
            } else {
                format!("'--{}=-XYZ' or '{}-XYZ'", token.name, token.raw)
            };
            return Err(Usage(format!(
                "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use {example}.",
                raw = token.raw
            )));
        }
        if !order.contains(&token.name) {
            order.push(token.name.clone());
        }
        match token.name.as_str() {
            "as" => values.as_ = token.value,
            "harness" => values.harness = token.value,
            "human" => values.human = true,
            "channels" => values.channels = true,
            "cowork-only" => values.cowork_only = true,
            "help" => values.help = true,
            _ => {}
        }
    }
    if values.help {
        return Ok(values);
    }
    if let Some(key) = order
        .iter()
        .find(|key| !MCP_OPTIONS.contains(&key.as_str()))
    {
        return Err(Usage(format!("{CLI_NAME} mcp does not take --{key}")));
    }
    Ok(values)
}

/// the thread a codex tool call's `_meta` names; a subagent child's call names its root thread
pub fn call_thread(meta: &Map<String, Value>) -> Option<String> {
    let thread = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|t| crate::identity::codex_thread(t))
            .map(String::from)
    };
    let own = thread(meta.get("threadId"))?;
    let parent = meta
        .get("x-codex-turn-metadata")
        .and_then(Value::as_object)
        .and_then(|turn| thread(turn.get("parent_thread_id")));
    let session = thread(meta.get("sessionId")).filter(|s| *s != own);
    Some(session.or(parent).unwrap_or(own))
}

/// what in a shim's environment names its session or thread: a shim with any of it is never thread-hosted
const NAMED: [&str; 6] = [
    "CODEX_THREAD_ID",
    "SCP_CODEX_THREAD",
    "SCP_SESSION",
    "SCP_NAME",
    "SCP_SHIM_BINDING",
    "SCP_HARNESS_PID",
];

pub type ThreadClaim = Rc<dyn Fn(&Map<String, Value>) -> Option<Claim>>;

/// for a codex shim an app server starts per thread: the claim for the thread a tool call names; None for any other shim
pub fn thread_claims(input: &IdentityInput, claim: &Claim) -> Option<ThreadClaim> {
    let harness = field(claim, "harness");
    if input.as_.is_some()
        || (harness != "codex" && harness != "codex-desktop")
        || NAMED
            .iter()
            .any(|k| input.env.get(*k).is_some_and(|v| !v.is_empty()))
    {
        return None;
    }
    let table = match &input.ps_table {
        Some(read) => read(),
        None => read_ps_table(crate::ps::PS_TIMEOUT_MS).map(Rc::new),
    };
    let pid = (input.harness_pid)(harness);
    if !app_server(
        table
            .as_ref()
            .and_then(|t| t.get(&pid))
            .map(|e| e.args.as_str()),
    ) {
        return None;
    }
    let input = input.clone();
    let claims: RefCell<HashMap<String, Claim>> = RefCell::new(HashMap::new());
    Some(Rc::new(move |meta| {
        let id = call_thread(meta)?;
        let found = claims.borrow().get(&id).cloned().unwrap_or_else(|| {
            let mut threaded = input.clone();
            threaded.harness_session = Some(id.clone());
            relay_identity(&threaded)
        });
        claims.borrow_mut().insert(id, found.clone());
        Some(found)
    }))
}

/// the parent pid of `pid`, from the kernel
pub fn ppid_of(pid: i64) -> Option<i64> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn proc_pidinfo(
                pid: i32,
                flavor: i32,
                arg: u64,
                buffer: *mut libc::c_void,
                size: i32,
            ) -> i32;
        }
        let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
        let size = std::mem::size_of_val(&info) as i32;
        let read = unsafe {
            proc_pidinfo(
                i32::try_from(pid).ok()?,
                3,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (read == size).then_some(info.pbi_ppid as i64)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        stat.get(stat.rfind(')')? + 1..)?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()
    }
}

/// who started this shim: our parent, or, when the CLI that our parent is started us in its place, the CLI's parent
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Parentage {
    pub parent: i64,
    pub router: Option<i64>,
}

impl Parentage {
    pub fn of(env: &Env) -> Self {
        let ppid = unsafe { libc::getppid() } as i64;
        let routed = js_integer(env.get(SHIM_PPID).map(String::as_str)).filter(|pid| *pid > 0);
        match routed {
            Some(pid) if ppid_of(ppid).or_else(|| ps_parent(ppid).map(|p| p.ppid)) == Some(pid) => {
                Parentage {
                    parent: pid,
                    router: Some(ppid),
                }
            }
            _ => Parentage {
                parent: ppid,
                router: None,
            },
        }
    }

    /// whether the process that started this shim is gone: it was reparented away
    pub fn orphaned(&self) -> bool {
        let ppid = unsafe { libc::getppid() } as i64;
        match self.router {
            Some(router) => ppid != router || ppid_of(router) != Some(self.parent),
            None => ppid != self.parent,
        }
    }
}

/// whether this shim's harness is the process `swarm claude` started with channels loaded: its parent is the launcher named in the
/// environment
pub fn launched_with_channels(
    env: &Env,
    harness: &dyn Fn() -> i64,
    parent_of: &crate::ps::ParentOf,
) -> bool {
    let Some(launcher) = js_integer(env.get(CHANNELS_ENV).map(String::as_str)) else {
        return false;
    };
    launcher > 1 && parent_of(harness()).is_some_and(|p| p.ppid == launcher)
}

/// the identity input `swarm mcp` builds: fallback harness `mcp`, this cwd, the process table read once it succeeds
pub fn identity_input(values: &Values, env: &Env, parentage: Parentage) -> IdentityInput {
    let cache: Rc<RefCell<Table>> = Rc::new(RefCell::new(None));
    let ps_table: Rc<dyn Fn() -> Table> = Rc::new(move || {
        let mut cached = cache.borrow_mut();
        if cached.is_none() {
            *cached = read_ps_table(SHELL_PS_TIMEOUT_MS).map(Rc::new);
        }
        cached.clone()
    });
    let pid: Rc<RefCell<Option<i64>>> = Rc::new(RefCell::new(None));
    let launch_env = env.clone();
    let parent = parentage.parent;
    let harness_pid: Rc<dyn Fn(&str) -> i64> = Rc::new(move |_| {
        if let Some(pid) = *pid.borrow() {
            return pid;
        }
        let found = launcher_pid(&launch_env, &|| harness_pid(parent, &ps_parent), &ps_parent)
            .unwrap_or_else(|| harness_pid(parent, &ps_parent));
        *pid.borrow_mut() = Some(found);
        found
    });
    let infer_env = env.clone();
    let infer_table = ps_table.clone();
    IdentityInput {
        state_dir: None,
        as_: values.as_.clone(),
        harness: values.harness.clone(),
        fallback_harness: "mcp".into(),
        cwd: safe_cwd(),
        env: env.clone(),
        harness_pid,
        infer_harness: Some(Rc::new(move |at| {
            let table = infer_table().unwrap_or_else(|| Rc::new(PsCommTable::new()));
            harness_at(at, Some(&table), &infer_env).map(String::from)
        })),
        start_of: None,
        lineage_of: None,
        harness_session: None,
        t3_hosted: None,
        ps_table: Some(ps_table),
    }
}

fn note(message: &str) {
    let prefix = if message.starts_with(&format!("{CLI_NAME} ")) {
        String::new()
    } else {
        format!("{CLI_NAME}: ")
    };
    eprintln!("{prefix}{message}");
}

fn usage(message: &str) -> i32 {
    note(message);
    note(&format!("run `{CLI_NAME} --help` for usage"));
    FAILED
}

fn process_env() -> Env {
    std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

/// the claim `swarm mcp` makes with these words, as JSON: what [`main`] would claim, without its wake ticket
pub fn identity_main(args: &[String]) -> i32 {
    let values = match parse_args(args) {
        Ok(values) => values,
        Err(Usage(message)) => return usage(&message),
    };
    let env = process_env();
    let input = identity_input(&values, &env, Parentage::of(&env));
    println!("{}", Value::Object(relay_identity(&input)));
    0
}

/// a JSON value as `JSON.stringify` writes it, for the values a request id holds
fn js_json(value: &Value) -> String {
    match value {
        Value::Number(n) if n.as_i64().is_none() && n.as_u64().is_none() => {
            crate::tools::js_num(n.as_f64().unwrap_or(0.0))
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(js_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!(
                    "{}:{}",
                    serde_json::to_string(k).unwrap_or_default(),
                    js_json(v)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

fn inert_reply(line: &str, instructions: &str) -> Option<String> {
    let request: Value = serde_json::from_str(line).ok()?;
    let request = request.as_object()?;
    let id = request.get("id")?;
    let method = request.get("method").and_then(Value::as_str);
    let result = match method {
        Some("initialize") => {
            let version = request
                .get("params")
                .and_then(Value::as_object)
                .and_then(|p| p.get("protocolVersion"));
            let version = version
                .map(|v| format!("\"protocolVersion\":{},", js_json(v)))
                .unwrap_or_default();
            Some(format!(
                "{{{version}\"capabilities\":{{}},\"serverInfo\":{{\"name\":\"scp\",\"version\":\"0.0.0\"}},\"instructions\":{}}}",
                serde_json::to_string(instructions).unwrap_or_default()
            ))
        }
        Some("tools/list") => Some("{\"tools\":[]}".into()),
        Some("ping") => Some("{}".into()),
        _ => None,
    };
    let body = match result {
        Some(result) => format!("\"result\":{result}"),
        None => "\"error\":{\"code\":-32601,\"message\":\"Method not found\"}".into(),
    };
    Some(format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{},{body}}}\n",
        js_json(id)
    ))
}

/// a newline-delimited MCP server with no tools or relay connection
pub async fn inert_mcp<R: tokio::io::AsyncRead + Unpin>(
    mut input: R,
    output: &dyn Fn(&str),
    instructions: &str,
) {
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 65536];
    loop {
        let n = match input.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&chunk[..n]);
        while let Some(end) = pending.iter().position(|c| *c == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            if let Some(reply) = inert_reply(&String::from_utf8_lossy(&line[..end]), instructions) {
                output(&reply);
            }
        }
    }
    let rest = String::from_utf8_lossy(&pending).into_owned();
    if !crate::ps::js_trim(&rest).is_empty()
        && let Some(reply) = inert_reply(&rest, instructions)
    {
        output(&reply);
    }
}

/// the synced plugin stays connected without claiming a terminal session: whether the shim served an inert MCP instead
pub async fn cowork_mcp_guard<R: tokio::io::AsyncRead + Unpin>(
    values: &Values,
    env: &Env,
    input: R,
    output: &dyn Fn(&str),
) -> bool {
    if !values.cowork_only {
        return false;
    }
    let cloud = env.get("CLAUDE_CODE_ENTRYPOINT").map(String::as_str) == Some("remote_cowork")
        && !Path::new(&relay_dir(env)).exists();
    if cloud {
        inert_mcp(
            input,
            output,
            "SCP has no relay in this cloud session; use the SCP connector.",
        )
        .await;
        return true;
    }
    if cowork_live(env) {
        return false;
    }
    inert_mcp(input, output, "SCP is inactive outside Cowork.").await;
    true
}

static SIGNAL_FD: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(signal: libc::c_int) {
    let fd = SIGNAL_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = signal as u8;
        unsafe {
            libc::write(fd, (&byte as *const u8).cast(), 1);
        }
    }
}

const SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

/// the read end of a pipe each of [`SIGNALS`] writes its number to
fn watch_signals() -> Option<tokio::net::unix::pipe::Receiver> {
    use std::os::fd::{FromRawFd, OwnedFd};
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } < 0 {
        return None;
    }
    for fd in fds {
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
    unsafe {
        libc::fcntl(
            fds[1],
            libc::F_SETFL,
            libc::fcntl(fds[1], libc::F_GETFL) | libc::O_NONBLOCK,
        );
    }
    let read = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    SIGNAL_FD.store(fds[1], Ordering::Relaxed);
    for signal in SIGNALS {
        unsafe {
            let mut action = std::mem::zeroed::<libc::sigaction>();
            action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
            action.sa_flags = libc::SA_RESTART;
            libc::sigemptyset(&mut action.sa_mask);
            libc::sigaction(signal, &action, std::ptr::null_mut());
        }
    }
    tokio::net::unix::pipe::Receiver::from_owned_fd(read).ok()
}

/// die of `signal` as a process without a handler would
fn reraise(signal: libc::c_int) -> ! {
    unsafe {
        libc::signal(signal, libc::SIG_DFL);
        libc::raise(signal);
    }
    std::process::exit(128 + signal)
}

fn write_stdout(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes()).and_then(|()| out.flush());
}

/// `swarm mcp <args>`: the words after `mcp`, with `install` taken by the CLI. Owns stdin and stdout, logs to stderr, returns the exit code.
pub fn main(args: &[String]) -> i32 {
    let values = match parse_args(args) {
        Ok(values) => values,
        Err(Usage(message)) => return usage(&message),
    };
    if values.help {
        write_stdout(&format!(
            "usage: {CLI_NAME} mcp [--as NAME] [--harness H] [--channels] [--cowork-only]   the relay MCP server over stdio\n"
        ));
        return 0;
    }
    let env = process_env();
    if !values.positionals.is_empty() {
        return usage(&format!(
            "{CLI_NAME} mcp takes no arguments (did you mean {CLI_NAME} mcp install?)"
        ));
    }
    if values.human {
        return usage("the relay MCP shim is always an agent: --human is not available to it");
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            note(&error.to_string());
            return FAILED;
        }
    };
    let local = tokio::task::LocalSet::new();
    let code = local.block_on(&runtime, serve(values, env));
    drop(local);
    runtime.shutdown_background();
    code
}

async fn serve(values: Values, env: Env) -> i32 {
    if cowork_mcp_guard(&values, &env, tokio::io::stdin(), &write_stdout).await {
        return 0;
    }
    let parentage = Parentage::of(&env);
    let input = identity_input(&values, &env, parentage);
    let mut claim = relay_identity(&input);
    if let Some(ticket) = wake_ticket(&env) {
        claim.insert("ticket".into(), Value::String(ticket));
    }
    let handle = field(&claim, "handle").to_string();
    if !valid_handle(&handle) {
        return usage(&format!(
            "{} is not a valid agent handle (me, user and relay are reserved)",
            serde_json::to_string(&handle).unwrap_or_default()
        ));
    }
    let dir = relay_dir(&env);
    let thread_claim = thread_claims(&input, &claim);
    let binding = Rc::new(RefCell::new(if thread_claim.is_some() {
        Binding::default()
    } else {
        write_shim_binding(&shim_binding(&claim), &env)
    }));
    let bound_env = env.clone();
    let rebinding = binding.clone();
    let bound: Rc<dyn Fn(&Claim)> = Rc::new(move |next| {
        rebinding.borrow_mut().remove();
        *rebinding.borrow_mut() = write_shim_binding(&shim_binding(next), &bound_env);
    });

    if let Some(mut signals) = watch_signals() {
        let binding = binding.clone();
        tokio::task::spawn_local(async move {
            let mut byte = [0u8; 1];
            if let Ok(1) = signals.read(&mut byte).await {
                binding.borrow_mut().remove();
                reraise(byte[0] as libc::c_int);
            }
        });
    }
    let orphan_binding = binding.clone();
    tokio::task::spawn_local(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(ORPHAN_CHECK_MS));
        tick.tick().await;
        loop {
            tick.tick().await;
            if parentage.orphaned() {
                orphan_binding.borrow_mut().remove();
                std::process::exit(0);
            }
        }
    });

    let start_env = env.clone();
    let start_dir = dir.clone();
    let start: Rc<dyn Fn()> = Rc::new(move || {
        if let Err(error) = start_daemon(&start_dir, &start_env) {
            note(&error.to_string());
        }
    });
    let connect_dir = PathBuf::from(&dir);
    let member_env = env.clone();
    let spawn_env = env.clone();
    let claim_cwd = PathBuf::from(field(&claim, "cwd"));
    let channels_env = env.clone();
    let launched = values.channels
        && launched_with_channels(
            &channels_env,
            &|| harness_pid(parentage.parent, &ps_parent),
            &ps_parent,
        );
    let options = Options {
        connect: Rc::new(move || {
            let dir = connect_dir.clone();
            let start = start.clone();
            Box::pin(async move { crate::client::connect_broker(&dir, Some(start)).await })
        }),
        claim: claim.clone(),
        membership: Some(Rc::new(move |session: &str| -> Membership {
            crate::membership::membership(&member_env, session, None)
        })),
        defer_claim: thread_claim.is_some(),
        bound: thread_claim.is_some().then_some(bound),
        thread_claim,
        env: env.clone(),
        channels: values.channels,
        launched_with_channels: launched,
        session_inbox: crate::inbox::session_inbox_of(&env),
        wake: None,
        version: None,
        spawn: Some(Rc::new(move |request: SpawnRequest| {
            let env = spawn_env.clone();
            let cwd = request.cwd.clone().unwrap_or_else(|| claim_cwd.clone());
            Box::pin(async move {
                spawn_detached(spawn_words(&request), &cwd, &env, parentage.parent).await
            })
        })),
        log: Rc::new(|line: &str| eprintln!("{line}")),
        heartbeat_ms: 30_000,
    };
    crate::server::run(options, tokio::io::stdin(), Rc::new(write_stdout)).await;
    binding.borrow_mut().remove();
    0
}

fn shim_binding(claim: &Claim) -> ShimBinding {
    ShimBinding {
        process: field(claim, "process").into(),
        handle: field(claim, "handle").into(),
        harness: field(claim, "harness").into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn flags_parse_like_the_cli() {
        assert_eq!(
            parse_args(&args(&[
                "--as",
                "w",
                "--harness=codex",
                "--channels",
                "--cowork-only"
            ])),
            Ok(Values {
                as_: Some("w".into()),
                harness: Some("codex".into()),
                channels: true,
                cowork_only: true,
                ..Values::default()
            })
        );
        assert_eq!(
            parse_args(&args(&["install", "--as=x"])).map(|v| v.positionals),
            Ok(args(&["install"]))
        );
        assert_eq!(
            parse_args(&args(&["--", "--as"])).map(|v| v.positionals),
            Ok(args(&["--as"]))
        );
        assert_eq!(
            parse_args(&args(&["--cloud"])),
            Err(Usage("swarm mcp does not take --cloud".into()))
        );
        assert_eq!(
            parse_args(&args(&["-h", "--cloud"])).map(|v| v.help),
            Ok(true)
        );
        assert_eq!(
            parse_args(&args(&["--nope"])),
            Err(Usage(
                "Unknown option '--nope'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--nope\""
                    .into()
            ))
        );
        assert_eq!(
            parse_args(&args(&["--as"])),
            Err(Usage("Option '--as <value>' argument missing".into()))
        );
        assert_eq!(
            parse_args(&args(&["--human=1"])),
            Err(Usage("Option '--human' does not take an argument".into()))
        );
        assert!(
            matches!(parse_args(&args(&["-h=1"])), Err(Usage(m)) if m.starts_with("Unknown option '-='"))
        );
        assert!(
            matches!(parse_args(&args(&["--é=1"])), Err(Usage(m)) if m.starts_with("Unknown option '--é'"))
        );
        assert_eq!(
            parse_args(&args(&["--as", "-x"])),
            Err(Usage("Option '--as' argument is ambiguous.\nDid you forget to specify the option argument for '--as'?\nTo specify an option argument starting with a dash use '--as=-XYZ'.".into()))
        );
        assert!(
            matches!(parse_args(&args(&["-hx"])), Err(Usage(m)) if m.starts_with("Unknown option '-x'"))
        );
        assert_eq!(
            parse_args(&args(&["--as=-x"])).map(|v| v.as_),
            Ok(Some("-x".into()))
        );
    }

    #[test]
    fn call_threads() {
        let a = "0199a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6b";
        let b = "0199a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6c";
        let c = "0199a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6d";
        let meta = |v: Value| v.as_object().cloned().unwrap();
        assert_eq!(
            call_thread(&meta(serde_json::json!({"threadId": a}))).as_deref(),
            Some(a)
        );
        assert_eq!(
            call_thread(&meta(serde_json::json!({"threadId": a, "sessionId": b}))).as_deref(),
            Some(b)
        );
        assert_eq!(
            call_thread(&meta(
                serde_json::json!({"threadId": a, "x-codex-turn-metadata": {"parent_thread_id": c}})
            ))
            .as_deref(),
            Some(c)
        );
        assert_eq!(
            call_thread(&meta(serde_json::json!({"threadId": "x", "sessionId": b}))),
            None
        );
    }

    #[test]
    fn inert_replies() {
        let instructions = "SCP is inactive outside Cowork.";
        assert_eq!(
            inert_reply(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#, instructions).as_deref(),
            Some("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"serverInfo\":{\"name\":\"scp\",\"version\":\"0.0.0\"},\"instructions\":\"SCP is inactive outside Cowork.\"}}\n")
        );
        assert_eq!(
            inert_reply(r#"{"id":"a","method":"tools/list"}"#, instructions).as_deref(),
            Some("{\"jsonrpc\":\"2.0\",\"id\":\"a\",\"result\":{\"tools\":[]}}\n")
        );
        assert_eq!(
            inert_reply(r#"{"id":2.50,"method":"x"}"#, instructions).as_deref(),
            Some(
                "{\"jsonrpc\":\"2.0\",\"id\":2.5,\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}\n"
            )
        );
        assert_eq!(inert_reply(r#"{"method":"ping"}"#, instructions), None);
        assert_eq!(inert_reply("nope", instructions), None);
    }

    #[test]
    fn inert_server_reads_lines_and_a_last_partial_one() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let out = RefCell::new(String::new());
        let input: &[u8] = b"{\"id\":1,\"method\":\"ping\"}\n\n{\"id\":2,\"method\":\"ping\"}";
        runtime.block_on(inert_mcp(
            input,
            &|line| out.borrow_mut().push_str(line),
            "x",
        ));
        assert_eq!(
            out.into_inner(),
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n"
        );
    }

    #[test]
    fn channels_need_the_launcher_as_parent() {
        let mut env = Env::new();
        let parent = |_: i64| {
            Some(crate::ps::Parent {
                ppid: 50,
                comm: "swarm".into(),
            })
        };
        assert!(!launched_with_channels(&env, &|| 10, &parent));
        env.insert(CHANNELS_ENV.into(), "50".into());
        assert!(launched_with_channels(&env, &|| 10, &parent));
        env.insert(CHANNELS_ENV.into(), "51".into());
        assert!(!launched_with_channels(&env, &|| 10, &parent));
    }

    #[test]
    fn parentage_without_a_router() {
        let parentage = Parentage::of(&Env::new());
        assert_eq!(parentage.router, None);
        assert!(!parentage.orphaned());
        assert_eq!(ppid_of(std::process::id() as i64), Some(parentage.parent));
    }
}
