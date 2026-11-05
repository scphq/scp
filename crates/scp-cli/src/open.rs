//! Acting as the caller: the identity a command claims or binds to, and the broker connection that carries it (`common.ts::open`).

use crate::account::cloud::{Hub, machine_name, open_hub};
use crate::args::{Parsed, parse_verb};
use crate::fleet::json::Json;
use crate::fleet::result_of;
use crate::{Call, Done, Fail, route, term, usage};
use scp_core::protocol::{CLI_NAME, PROTOCOL};
use scp_mcp::LocalFuture;
use scp_mcp::client::{CallError, Client, Start, connect_or_start, relay_dir};
use scp_mcp::identity::{
    codex_shell, codex_thread, detect_harness, harness_variant, labels_for, safe_cwd, session_key,
    short_hostname,
};
use scp_mcp::membership::membership;
use scp_mcp::ps::{
    Env, PS_TIMEOUT_MS, PsCommTable, SHELL_PS_TIMEOUT_MS, Table, command, harness_lineage,
    inferring, read_ps_table,
};
use scp_mcp::tools::{get, truthy};
use scp_mcp::{Claim, Membership};
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::rc::Rc;

/// verbs that observe the hub, without an identity, on the cloud transport
pub const CLOUD_OBSERVE: [&str; 5] = ["list", "status", "watch", "log", "machines"];

/// verbs that run with no identity of the caller's
pub const OBSERVE: [&str; 14] = [
    "list",
    "status",
    "watch",
    "log",
    "policy",
    "machines",
    "rules",
    "group",
    "admin",
    "spawn-env",
    "spawn",
    "why",
    "peek",
    "set-peek",
];

/// what a shell whose process table read failed is told
pub const PS_UNREAD: &str = "could not read the process table (ps failed or timed out), so this shell's harness process is unknown; retry";

/// how the hello claims the caller
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// a handle: `--as`, `$SCP_NAME` or the session's joined handle
    As,
    /// a spawn-env grant bound by lineage
    Grant,
    /// the human inbox, or the agent whose lineage a terminal shows
    Human,
    /// no claim: the agent this shell's lineage shows, if any
    Observe,
}

impl Mode {
    fn word(self) -> &'static str {
        match self {
            Mode::As => "as",
            Mode::Grant => "grant",
            Mode::Human => "human",
            Mode::Observe => "observe",
        }
    }
}

/// the hello a command sends, before any connection
#[derive(Debug, Clone)]
pub struct Plan {
    pub hello: Map<String, Value>,
    pub mode: Mode,
    pub harness_pid: Option<i64>,
    pub unread: bool,
    pub shell: i64,
    /// the hub's machine and binding on the cloud transport, where the hello goes to the hub instead of the broker
    pub hub: Option<Hub>,
}

/// how a command came to act as an endpoint: `as`, `lineage` or `human`
pub type Bound = Option<&'static str>;

pub struct Opened {
    pub client: Client,
    /// the caller's endpoint, null when it acts as no one
    pub me: Value,
    /// `me` as the broker wrote it, its keys in that order
    pub endpoint: Json,
    pub broker: Value,
    pub bound: Bound,
    pub harness_pid: Option<i64>,
    /// on the cloud transport, which hub, account and machine the command runs on
    pub hub: Option<String>,
}

impl Opened {
    /// where the command runs, as status and watch print it without a broker in the snapshot
    pub fn place(&self) -> String {
        match &self.hub {
            Some(hub) => hub.clone(),
            None => crate::fleet::view::broker_line(&self.broker, None),
        }
    }

    /// the local broker's connection, refused on the cloud transport (`localClient`)
    pub fn local(&self, verb: &str) -> Result<(), Fail> {
        if self.broker.is_null() {
            return Err(usage(format!(
                "{CLI_NAME} {verb} is the local broker's; it has no --cloud form"
            )));
        }
        Ok(())
    }
}

/// whether a command takes the cloud transport: --cloud or `$SCP_TRANSPORT=cloud`
pub fn cloud_transport(parsed: &Parsed, env: &Env) -> bool {
    parsed.on("cloud") || env.get("SCP_TRANSPORT").is_some_and(|t| t == "cloud")
}

/// whether a terminal is attached: stdin is one, or, while the body does not come from stdin, stdout or stderr is
pub fn terminal_attached(body_from_stdin: bool) -> bool {
    // SAFETY: isatty only inspects the descriptor
    let tty = |fd| unsafe { libc::isatty(fd) == 1 };
    tty(0) || (!body_from_stdin && (tty(1) || tty(2)))
}

/// an --as handle: a local handle, with a leading `me/` dropped
pub fn local_handle(raw: &str) -> Result<String, Fail> {
    let handle = raw.strip_prefix("me/").unwrap_or(raw);
    if handle.is_empty() {
        return Err(usage("--as me/ names your own human inbox: use --human"));
    }
    if handle.contains('/') {
        return Err(usage(format!(
            "--as names a local handle, not {}",
            crate::args::js_string(raw)
        )));
    }
    Ok(handle.to_owned())
}

fn grant_token(text: &str) -> bool {
    text.strip_prefix("krt_").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn nonempty<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    env.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

/// this shell's process walk, as `walkNow` reads it
#[derive(Debug, Clone)]
pub struct Walk {
    pub keys: Vec<String>,
    pub own: Vec<String>,
    pub harness: Option<String>,
    pub unread: bool,
}

pub fn walk(env: &Env, shell: i64, table: Table) -> Walk {
    Walk::from_json(&scp_mcp::spawn::walk_now(env, shell, table))
}

impl Walk {
    /// a walk as `walkNow` writes it to JSON
    pub fn from_json(walk: &Value) -> Walk {
        let strings = |key: &str| -> Vec<String> {
            get(walk, key)
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };
        Walk {
            keys: strings("keys"),
            own: strings("self"),
            harness: get(walk, "harness")
                .and_then(Value::as_str)
                .map(str::to_owned),
            unread: truthy(get(walk, "unread")),
        }
    }
}

/// `pid` from a `pid:<n>...` process key
fn key_pid(key: &str) -> Option<i64> {
    let rest = key.strip_prefix("pid:")?;
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// an `--as` claim's harness: --harness or $SCP_HARNESS, else the harness this shell's walk or environment shows, else cli
pub fn claim_harness(parsed: &Parsed, env: &Env, walk: &Walk, shell: i64) -> String {
    let explicit = parsed
        .text("harness")
        .or_else(|| env.get("SCP_HARNESS").map(String::as_str));
    if let Some(explicit) = explicit.filter(|h| !h.is_empty()) {
        return explicit.to_owned();
    }
    if !inferring(env) {
        return "cli".into();
    }
    let detected = walk
        .harness
        .clone()
        .or_else(|| detect_harness(env).map(str::to_owned))
        .unwrap_or_else(|| "cli".into());
    let unread = walk.unread;
    let table = move || -> Table {
        if unread {
            None
        } else {
            read_ps_table(PS_TIMEOUT_MS).map(Rc::new)
        }
    };
    harness_variant(&detected, env, shell, &table, None)
}

/// the hello `verb` sends for `parsed` and `env` from the process `shell`
pub fn plan(verb: &str, parsed: &Parsed, env: &Env, shell: i64, tty: bool) -> Result<Plan, Fail> {
    plan_from(verb, parsed, env, shell, tty, None)
}

/// [`plan`] with a walk given from outside, as `open(..., walk)` takes it
pub fn plan_walked(
    verb: &str,
    parsed: &Parsed,
    env: &Env,
    shell: i64,
    tty: bool,
    here: &Walk,
) -> Result<Plan, Fail> {
    plan_from(verb, parsed, env, shell, tty, Some(here))
}

fn plan_from(
    verb: &str,
    parsed: &Parsed,
    env: &Env,
    shell: i64,
    tty: bool,
    given: Option<&Walk>,
) -> Result<Plan, Fail> {
    let named = parsed
        .text("as")
        .or_else(|| env.get("SCP_NAME").map(String::as_str));
    let named = named.filter(|n| !n.is_empty());
    let human = parsed.on("human");
    if named.is_some() && human {
        return Err(usage(
            "--human and --as (or $SCP_NAME) name two identities; pick one",
        ));
    }
    let grant = nonempty(env, "SCP_GRANT");
    let cloud = cloud_transport(parsed, env) || verb == "machines";
    if let Some(grant) = grant {
        if !grant_token(grant) {
            return Err(usage(format!(
                "$SCP_GRANT is not one spawn-env grant: pass spawn-env's lines as separate words: env $({CLI_NAME} spawn-env ...) cmd; in zsh env ${{=G}} cmd"
            )));
        }
        if human {
            return Err(usage(
                "--human and $SCP_GRANT name two identities: unset the grant to act as me/",
            ));
        }
        if cloud {
            return Err(usage(
                "a spawn-env grant is for this machine's relay broker, not the cloud transport",
            ));
        }
    }
    if cloud {
        if named.is_none() && !human && !tty && !OBSERVE.contains(&verb) {
            return Err(usage(format!(
                "{CLI_NAME} {verb} needs an identity: --as HANDLE (or $SCP_NAME) for an agent, or --human for your own inbox me/ (no terminal is attached, so me/ is not assumed)"
            )));
        }
        return hub_plan(verb, parsed, env, shell, tty, given, named, human);
    }
    if parsed.has("machine") {
        return Err(usage(
            "--machine names the machine of the cloud transport: add --cloud",
        ));
    }
    let read;
    let here = match given {
        Some(here) => here,
        None => {
            read = walk(env, shell, read_ps_table(SHELL_PS_TIMEOUT_MS).map(Rc::new));
            &read
        }
    };
    let joined = match (
        parsed.text("as").filter(|a| !a.is_empty()),
        named,
        here.own.last(),
    ) {
        (None, Some(_), Some(process)) => match membership(env, &session_key(env, process), None) {
            Membership::Joined(handle) => handle,
            Membership::Dark(_) => None,
        },
        _ => None,
    };
    let handle = match (joined, named) {
        (Some(handle), _) => Some(handle),
        (None, Some(named)) => Some(local_handle(named)?),
        (None, None) => None,
    };
    let harness_pid = here.own.last().and_then(|key| key_pid(key));
    let thread = codex_shell(env)
        .then(|| nonempty(env, "CODEX_THREAD_ID"))
        .flatten();
    let mut lineage = Map::new();
    if !here.keys.is_empty() {
        lineage.insert("lineage".into(), Value::from(here.keys.clone()));
        if let Some(thread) = thread.filter(|t| codex_thread(t)) {
            lineage.insert("harness_session".into(), Value::from(thread));
        }
    }
    let cwd = Value::from(safe_cwd());
    let own = (!here.own.is_empty()).then(|| Value::from(here.own.clone()));
    let mut hello = Map::new();
    let mode = if let Some(handle) = handle {
        let mut claim = Claim::new();
        claim.insert("handle".into(), Value::from(handle));
        claim.insert("exact".into(), Value::Bool(true));
        claim.insert(
            "harness".into(),
            Value::from(claim_harness(parsed, env, here, shell)),
        );
        claim.insert("cwd".into(), cwd);
        if let Some(parent) = nonempty(env, "SCP_PARENT") {
            claim.insert("parent".into(), Value::from(parent));
        }
        if let Some(under) = nonempty(env, "SCP_UNDER") {
            claim.insert("under".into(), Value::from(under));
        }
        claim.insert(
            "labels".into(),
            Value::Object(labels_for(env, &short_hostname)),
        );
        claim.extend(lineage);
        if let Some(grant) = grant {
            claim.insert("grant".into(), Value::from(grant));
        }
        hello.insert("claim".into(), Value::Object(claim));
        if let Some(own) = own {
            hello.insert("self".into(), own);
        }
        Mode::As
    } else if let Some(grant) = grant {
        hello.insert("observe".into(), Value::Bool(true));
        hello.extend(lineage);
        if let Some(own) = own {
            hello.insert("self".into(), own);
        }
        hello.insert("grant".into(), Value::from(grant));
        hello.insert("cwd".into(), cwd);
        Mode::Grant
    } else if human || tty {
        hello.insert("human".into(), Value::Bool(true));
        hello.insert("tty".into(), Value::Bool(tty));
        hello.insert("cwd".into(), cwd);
        hello.extend(lineage);
        Mode::Human
    } else {
        hello.insert("observe".into(), Value::Bool(true));
        hello.extend(lineage);
        if let Some(own) = own {
            hello.insert("self".into(), own);
        }
        hello.insert("cwd".into(), cwd);
        Mode::Observe
    };
    hello.insert("brief".into(), Value::Bool(true));
    Ok(Plan {
        hello,
        mode,
        harness_pid,
        unread: here.unread,
        shell,
        hub: None,
    })
}

/// the hello a `--cloud` command sends the hub: a claim with --as, an observer that binds no machine for the verbs that observe, else
/// the account's human inbox
#[allow(clippy::too_many_arguments)]
fn hub_plan(
    verb: &str,
    parsed: &Parsed,
    env: &Env,
    shell: i64,
    tty: bool,
    given: Option<&Walk>,
    named: Option<&str>,
    human: bool,
) -> Result<Plan, Fail> {
    let mut hello = Map::new();
    hello.insert("protocol".into(), Value::from(PROTOCOL));
    let (machine, mode, bound) = match named {
        Some(named) => {
            let handle = local_handle(named)?;
            let read;
            let here = match given {
                Some(here) => here,
                None => {
                    read = walk(env, shell, read_ps_table(SHELL_PS_TIMEOUT_MS).map(Rc::new));
                    &read
                }
            };
            let harness = claim_harness(parsed, env, here, shell);
            let machine = machine_name(parsed.text("machine"), env)?;
            let mut claim = Claim::new();
            claim.insert("handle".into(), Value::from(handle));
            claim.insert("harness".into(), Value::from(harness));
            claim.insert("cwd".into(), Value::from(safe_cwd()));
            if let Some(parent) = nonempty(env, "SCP_PARENT") {
                claim.insert("parent".into(), Value::from(parent));
            }
            let host = machine.clone();
            claim.insert(
                "labels".into(),
                Value::Object(labels_for(env, &move || host.clone())),
            );
            hello.insert("machine".into(), Value::from(machine.as_str()));
            hello.insert("claim".into(), Value::Object(claim));
            (machine, Mode::As, Some("as"))
        }
        None => {
            let machine = machine_name(parsed.text("machine"), env)?;
            if !human && CLOUD_OBSERVE.contains(&verb) {
                hello.insert("observe".into(), Value::Bool(true));
                hello.insert("machine".into(), Value::from(machine.as_str()));
                (machine, Mode::Observe, None)
            } else {
                hello.insert("machine".into(), Value::from(machine.as_str()));
                hello.insert("human".into(), Value::Bool(true));
                hello.insert("tty".into(), Value::Bool(tty));
                (machine, Mode::Human, Some("human"))
            }
        }
    };
    Ok(Plan {
        hello,
        mode,
        harness_pid: None,
        unread: false,
        shell,
        hub: Some(Hub { machine, bound }),
    })
}

/// the human at this terminal on the hub, as `openAdoptHuman` opens it with --cloud
pub fn hub_human(parsed: &Parsed, env: &Env) -> Result<Plan, Fail> {
    let machine = machine_name(parsed.text("machine"), env)?;
    let mut hello = Map::new();
    hello.insert("protocol".into(), Value::from(PROTOCOL));
    hello.insert("machine".into(), Value::from(machine.as_str()));
    hello.insert("human".into(), Value::Bool(true));
    hello.insert("tty".into(), Value::Bool(true));
    Ok(Plan {
        hello,
        mode: Mode::Human,
        harness_pid: None,
        unread: false,
        shell: 0,
        hub: Some(Hub {
            machine,
            bound: Some("human"),
        }),
    })
}

const INITS: [&str; 3] = ["init", "systemd", "launchd"];

/// whether `pid` has no harness on its walk and the walk ends at a pid 1 that is not init, as inside bwrap --unshare-pid
pub fn hidden_harness(pid: i64, table: Option<&PsCommTable>) -> bool {
    let Some(table) = table else {
        return false;
    };
    if !harness_lineage(pid, Some(table)).is_empty() {
        return false;
    }
    let mut seen = HashSet::new();
    let mut at = pid;
    while at > 1 && seen.insert(at) {
        let Some(entry) = table.get(&at) else {
            return false;
        };
        at = entry.ppid;
    }
    at == 1
        && table
            .get(&1)
            .is_some_and(|init| !INITS.contains(&command(&init.args).as_str()))
}

/// an OS error's code and description as libuv names them
pub fn errno_words(error: &std::io::Error) -> Option<(&'static str, &'static str)> {
    Some(match error.raw_os_error()? {
        libc::EACCES => ("EACCES", "permission denied"),
        libc::EEXIST => ("EEXIST", "file already exists"),
        libc::ENOENT => ("ENOENT", "no such file or directory"),
        libc::ENOTDIR => ("ENOTDIR", "not a directory"),
        libc::EPERM => ("EPERM", "operation not permitted"),
        libc::EROFS => ("EROFS", "read-only file system"),
        libc::ENOSPC => ("ENOSPC", "no space left on device"),
        libc::EISDIR => ("EISDIR", "illegal operation on a directory"),
        libc::ELOOP => ("ELOOP", "too many symbolic links encountered"),
        libc::ENAMETOOLONG => ("ENAMETOOLONG", "name too long"),
        libc::ESRCH => ("ESRCH", "no such process"),
        libc::ETXTBSY => ("ETXTBSY", "text file is busy"),
        libc::ENOEXEC => ("ENOEXEC", "exec format error"),
        libc::E2BIG => ("E2BIG", "argument list too long"),
        libc::ENOMEM => ("ENOMEM", "not enough memory"),
        libc::EAGAIN => ("EAGAIN", "resource temporarily unavailable"),
        libc::EMFILE => ("EMFILE", "too many open files"),
        libc::ENFILE => ("ENFILE", "file table overflow"),
        libc::EIO => ("EIO", "i/o error"),
        _ => return None,
    })
}

/// an fs failure as Node words it: `ENOTDIR: not a directory, mkdir '<path>'`
pub fn node_fs_error(error: &std::io::Error, syscall: &str, path: &str) -> String {
    match errno_words(error) {
        Some((code, words)) => format!("{code}: {words}, {syscall} '{path}'"),
        None => error.to_string(),
    }
}

/// starts the broker for `dir` as `startDaemon` does: its directory made private and its log checked as there, each failure as Node
/// words it; a broker that does not start is then the connection's to report
pub fn start_broker(dir: &str, env: &Env) -> Result<(), CallError> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    let fail = |syscall: &str, path: &str| {
        let (syscall, path) = (syscall.to_owned(), path.to_owned());
        move |error: std::io::Error| CallError::Io(node_fs_error(&error, &syscall, &path))
    };
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(fail("mkdir", dir))?;
    let meta = std::fs::symlink_metadata(dir).map_err(fail("lstat", dir))?;
    // SAFETY: getuid cannot fail
    if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } {
        return Err(CallError::Io(format!(
            "{dir} is not a directory this user owns"
        )));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(fail("chmod", dir))?;
    let log = scp_mcp::ps::join(&[dir, "broker.log"]);
    match std::fs::metadata(&log) {
        Ok(meta) if meta.len() > LOG_MAX_BYTES => {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&log)
                .and_then(|file| file.set_len(0))
                .map_err(fail("open", &log))?;
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(fail("stat", &log)(error)),
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log)
        .map_err(fail("open", &log))?;
    let _ = scp_mcp::spawn::start_daemon(dir, env);
    Ok(())
}

const LOG_MAX_BYTES: u64 = 1024 * 1024;

const BUSY: &str = "the relay broker is running but did not accept a connection";

/// the broker for `dir`, started when none runs, except from a codex shell, whose sandbox would hold the daemon too
pub async fn connect_shell(dir: &str, env: &Env, tool: &str) -> Result<Client, Fail> {
    let codex = codex_shell(env);
    let start: Option<Start> = if codex {
        None
    } else {
        let (dir, env) = (dir.to_owned(), env.clone());
        Some(Rc::new(move || start_broker(&dir, &env)))
    };
    match connect_or_start(std::path::Path::new(dir), start).await {
        Ok(client) => Ok(client),
        Err(CallError::Io(message)) if codex && !message.starts_with(BUSY) => Err(usage(format!(
            "{message}. In a codex sandbox use {tool} instead: the scp MCP server runs outside the sandbox. Or let the sandbox reach the socket (codex: sandbox_workspace_write.network_access = true)"
        ))),
        Err(error) => Err(error.into()),
    }
}

/// connects as `plan` says, failing as `open()` does when the broker binds the command to no one
pub async fn open(verb: &str, plan: Plan, env: &Env) -> Result<Opened, Fail> {
    if let Some(hub) = plan.hub {
        return open_hub(plan.hello, hub, env).await;
    }
    let dir = relay_dir(env).to_string_lossy().into_owned();
    let client = connect_shell(&dir, env, "the scp MCP tools (relay_*)").await?;
    let hello = match client.hello_line(plan.hello.clone()).await {
        Ok(line) => match result_of(&line) {
            Ok(hello) => hello,
            Err(fail) => {
                client.close();
                return Err(fail);
            }
        },
        Err(CallError::Relay {
            code,
            message,
            retry_after_s,
        }) if plan.unread && code == "unauthorized" => {
            client.close();
            return Err(Fail::Call(CallError::Relay {
                code,
                message: format!("{message}; {PS_UNREAD}"),
                retry_after_s,
            }));
        }
        Err(error) => {
            client.close();
            return Err(error.into());
        }
    };
    let endpoint = hello.get("endpoint").cloned().unwrap_or(Json::Null);
    let hello = hello.to_value();
    let me = get(&hello, "endpoint").cloned().unwrap_or(Value::Null);
    let bound = match plan.mode {
        Mode::As => Some("as"),
        Mode::Grant => {
            if !truthy(get(&hello, "grant_bound")) {
                client.close();
                return Err(usage(format!(
                    "the running {CLI_NAME} broker does not check spawn-env grants: let it exit (it stops when idle) and retry"
                )));
            }
            Some("lineage")
        }
        Mode::Human => Some(
            if get(&me, "kind").and_then(Value::as_str) == Some("human") {
                "human"
            } else {
                "lineage"
            },
        ),
        Mode::Observe => {
            let found = truthy(Some(&me));
            if !found && !OBSERVE.contains(&verb) {
                client.close();
                return Err(unbound(verb, &plan));
            }
            found.then_some("lineage")
        }
    };
    Ok(Opened {
        client,
        broker: get(&hello, "broker").cloned().unwrap_or(Value::Null),
        me,
        endpoint,
        bound,
        harness_pid: plan.harness_pid,
        hub: None,
    })
}

fn unbound(verb: &str, plan: &Plan) -> Fail {
    if plan.unread {
        return usage(format!(
            "{CLI_NAME} {verb}: {PS_UNREAD}, or pass --as HANDLE or --human"
        ));
    }
    let table = read_ps_table(SHELL_PS_TIMEOUT_MS);
    if hidden_harness(plan.shell, table.as_ref()) {
        return usage(format!(
            "{CLI_NAME} {verb}: sandbox pid namespace: this shell cannot see its harness; use the scp MCP tools"
        ));
    }
    let harness = match plan.harness_pid {
        Some(pid) if pid != 0 => format!("pid {pid}"),
        _ => "none found".into(),
    };
    usage(format!(
        "{CLI_NAME} {verb}: no relay agent runs this shell's harness process ({harness}); {CLI_NAME} join <name> puts this session on the relay, or pass --as HANDLE or --human (no terminal is attached, so me/ is not assumed)"
    ))
}

pub fn runtime() -> Result<tokio::runtime::Runtime, Fail> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| Fail::Call(CallError::Io(error.to_string())))
}

/// runs `future` to its end on a single-threaded runtime with a LocalSet, as a verb's connections need
pub fn block_on<F: Future>(future: F) -> Result<F::Output, Fail> {
    let runtime = runtime()?;
    let local = tokio::task::LocalSet::new();
    let out = local.block_on(&runtime, future);
    drop(local);
    runtime.shutdown_background();
    Ok(out)
}

/// opens as the caller, then runs `run` on the connection, which it closes after
pub fn with_opened(
    call: &Call,
    run: for<'a> fn(&'a Call<'a>, &'a Opened) -> LocalFuture<'a, Done>,
) -> Done {
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let plan = plan(
        call.verb,
        &call.parsed,
        call.env,
        route::shell_pid(),
        terminal_attached(crate::messages::body_from_stdin(call.verb, &call.parsed)),
    )?;
    let hub = plan.hub.is_some();
    let runtime = runtime()?;
    let local = tokio::task::LocalSet::new();
    let done = local.block_on(&runtime, async {
        let opened = open(call.verb, plan, call.env).await?;
        let done = run(call, &opened).await;
        opened.client.close();
        done
    });
    finish(runtime, local, hub);
    done
}

/// ends a command's runtime; with a hub connection, after the hub took its close or `HUB_CLOSE` passed
pub fn finish(runtime: tokio::runtime::Runtime, local: tokio::task::LocalSet, hub: bool) {
    if hub {
        runtime.block_on(async {
            let _ = tokio::time::timeout(HUB_CLOSE, local).await;
        });
    } else {
        drop(local);
    }
    runtime.shutdown_background();
}

/// how long a command waits for the hub to take its close before it exits
const HUB_CLOSE: std::time::Duration = std::time::Duration::from_secs(1);

/// `swarm __probe identity <verb> [flags]`: the hello the verb would send from here, as JSON, connecting to nothing
pub fn probe(args: &[String]) -> i32 {
    let (Some("identity"), Some(verb)) = (args.first().map(String::as_str), args.get(1)) else {
        term::note("__probe takes identity <verb> [flags]");
        return 2;
    };
    let env: Env = std::env::vars().collect();
    let parsed = match parse_verb(verb, &args[2..]) {
        Ok(parsed) => parsed,
        Err(message) => return crate::report(Fail::Usage(message)),
    };
    match plan(
        verb,
        &parsed,
        &env,
        route::shell_pid(),
        terminal_attached(false),
    ) {
        Ok(plan) => {
            let hello = Value::Object(plan.hello);
            let mode = Value::from(plan.mode.word());
            let harness_pid = plan.harness_pid.map_or(Value::Null, Value::from);
            let shell = Value::from(plan.shell);
            term::json_entries(&[
                ("hello", &hello),
                ("mode", &mode),
                ("harness_pid", &harness_pid),
                ("shell", &shell),
            ]);
            0
        }
        Err(fail) => crate::report(fail),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_broker_start_fails_at_the_step_and_path_node_names() {
        let dir = std::env::temp_dir().join(format!("cli-start-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("broker.log");
        std::os::unix::fs::symlink(&log, &log).unwrap();
        let dir_text = format!("{}/", dir.display());
        assert_eq!(
            start_broker(&dir_text, &Env::new()),
            Err(CallError::Io(format!(
                "ELOOP: too many symbolic links encountered, stat '{}'",
                log.display()
            )))
        );
        let file = dir.join("file");
        std::fs::write(&file, "").unwrap();
        let nested = file.join("x").display().to_string();
        assert_eq!(
            start_broker(&nested, &Env::new()),
            Err(CallError::Io(format!(
                "ENOTDIR: not a directory, mkdir '{nested}'"
            )))
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
