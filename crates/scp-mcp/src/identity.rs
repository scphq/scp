//! The claim a harness session's shim makes: the shim and the hooks compute the same handle, harness and session key, so they land on
//! one endpoint.

use crate::Claim;
use crate::ps::{
    Env, PS_TIMEOUT_MS, PsCommTable, T3CODE, Table, app_server, basename, codex_desktop, dirname,
    inferring, join, js_trim, lineage, process_key, ps_start, read_ps_table, resolve, t3_hosted,
};
use scp_core::address::valid_handle;
use scp_core::protocol::{GENERIC_HARNESSES, valid_harness};
use serde_json::{Map, Value};
use std::cell::OnceCell;
use std::collections::HashSet;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::rc::Rc;

fn truthy<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    env.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

fn is(env: &Env, key: &str, value: &str) -> bool {
    env.get(key).map(String::as_str) == Some(value)
}

/// whether this process runs inside a Cowork session, local or cloud
pub fn cowork_live(env: &Env) -> bool {
    is(env, "CLAUDE_CODE_IS_COWORK", "1") || is(env, "CLAUDE_CODE_ENTRYPOINT", "remote_cowork")
}

/// the harness this process runs under, from the markers each harness puts in its children's environment
pub fn detect_harness(env: &Env) -> Option<&'static str> {
    if truthy(env, "GROK_SESSION_ID").is_some() || truthy(env, "GROK_HOOK_EVENT").is_some() {
        return Some("grok");
    }
    if truthy(env, "MUSE_SESSION_ID").is_some() {
        return Some("muse");
    }
    if is(env, "OPENCODE", "1") {
        return Some("opencode");
    }
    if is(env, "ANTIGRAVITY_AGENT", "1") || truthy(env, "ANTIGRAVITY_CONVERSATION_ID").is_some() {
        return Some("agy");
    }
    if is(env, "CLAUDECODE", "1") {
        return Some("claude-code");
    }
    if truthy(env, "CODEX_THREAD_ID").is_some() {
        return Some("codex");
    }
    if inferring(env)
        && (truthy(env, "CODEX_SANDBOX").is_some()
            || truthy(env, "CODEX_SANDBOX_NETWORK_DISABLED").is_some())
    {
        return Some("codex");
    }
    if cowork_live(env) {
        return Some("claude-code");
    }
    None
}

/// the harnesses whose codex shim publishes a binding
const BOUND_HARNESSES: [&str; 3] = ["codex", "codex-desktop", "t3code"];

/// `^[0-9a-f]{1,128}$`
fn binding_key(text: &str) -> bool {
    (1..=128).contains(&text.len())
        && text
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// the pid of a `pid:<pid>:<start>` process key
fn binding_pid(key: &str) -> Option<&str> {
    let rest = key.strip_prefix("pid:")?;
    let colon = rest.find(':')?;
    let (pid, start) = (&rest[..colon], &rest[colon + 1..]);
    let digits =
        !pid.is_empty() && pid.as_bytes()[0] != b'0' && pid.bytes().all(|c| c.is_ascii_digit());
    let started = (1..=64).contains(&start.len())
        && start
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b':' || c == b'-');
    (digits && started).then_some(pid)
}

/// whether this shell may recover its hidden codex harness from a shim binding
pub fn codex_shell(env: &Env) -> bool {
    is(env, "SCP_HARNESS", "codex")
        || is(env, "SCP_HARNESS", "codex-desktop")
        || (inferring(env) && detect_harness(env) == Some("codex"))
}

/// `$SCP_DIR`, else `$XDG_STATE_HOME/scp`, else ~/.local/state/scp
pub fn relay_dir(env: &Env) -> String {
    if let Some(dir) = truthy(env, "SCP_DIR") {
        return dir.to_string();
    }
    match truthy(env, "XDG_STATE_HOME") {
        Some(state) => join(&[state, "scp"]),
        None => {
            let home = truthy(env, "HOME")
                .map(String::from)
                .unwrap_or_else(home_dir);
            join(&[&home, ".local", "state", "scp"])
        }
    }
}

/// `os.homedir()`: $HOME, else the user database
pub fn home_dir() -> String {
    if let Ok(home) = std::env::var("HOME")
        && !home.is_empty()
    {
        return home;
    }
    unsafe {
        let mut pwd = std::mem::zeroed::<libc::passwd>();
        let mut result = std::ptr::null_mut();
        let mut buffer = vec![0u8; 16384];
        if libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        ) != 0
            || result.is_null()
            || pwd.pw_dir.is_null()
        {
            return String::new();
        }
        std::ffi::CStr::from_ptr(pwd.pw_dir)
            .to_string_lossy()
            .into_owned()
    }
}

/// the working directory, never failing: when it is gone, $PWD, HOME, else "/"
pub fn safe_cwd() -> String {
    if let Ok(dir) = std::env::current_dir() {
        return dir.to_string_lossy().into_owned();
    }
    let pwd = std::env::var("PWD").ok();
    let home = std::env::var("HOME").ok();
    for dir in [pwd, home, Some(home_dir())].into_iter().flatten() {
        if dir.starts_with('/') {
            return dir;
        }
    }
    "/".into()
}

/// a private directory: created 0700, and refused when it is a link or someone else's
pub fn private_dir(path: &str) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } {
        return Err(io::Error::other(format!(
            "{path} is not a directory this user owns"
        )));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

/// a regular file owned by this uid, read without blocking on a special file or following a link
pub fn read_owned_file(path: &str) -> io::Result<String> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.uid() != unsafe { libc::getuid() } {
        return Err(io::Error::other("file is not regular or owned by this uid"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn write_private(path: &str, text: &str) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(text.as_bytes())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// what a codex shim publishes for shells whose sandbox hides its process
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShimBinding {
    pub process: String,
    pub handle: String,
    pub harness: String,
}

/// the binding files one shim wrote; [`Binding::remove`] deletes those that still hold its text
#[derive(Debug, Default)]
pub struct Binding {
    paths: Vec<String>,
    text: String,
}

impl Binding {
    pub fn remove(&mut self) {
        for path in self.paths.drain(..) {
            if read_owned_file(&path).is_ok_and(|text| text == self.text) {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// publish the codex shim's harness key for shells whose sandbox hides its process
pub fn write_shim_binding(claim: &ShimBinding, env: &Env) -> Binding {
    let Some(pid) = binding_pid(&claim.process) else {
        return Binding::default();
    };
    if !BOUND_HARNESSES.contains(&claim.harness.as_str()) {
        return Binding::default();
    }
    let text = format!(
        "{{\"process\":{},\"handle\":{},\"harness\":{}}}",
        json_string(&claim.process),
        json_string(&claim.handle),
        json_string(&claim.harness)
    );
    let mut names = vec![format!("pid-{pid}")];
    if let Some(key) = env.get("SCP_SHIM_BINDING").filter(|k| binding_key(k)) {
        names.push(format!("key-{key}"));
    }
    let mut paths = Vec::new();
    for name in names {
        let dir = join(&[&relay_dir(env), "bindings"]);
        let path = join(&[&dir, &format!("{name}.json")]);
        if private_dir(&dir)
            .and_then(|()| write_private(&path, &text))
            .is_ok()
        {
            paths.push(path);
        }
    }
    Binding { paths, text }
}

/// what a launcher hands a muse process's shim and hooks in place of SCP_NAME, SCP_GRANT, SCP_SESSION and SCP_HARNESS_PID
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MuseLaunch {
    pub name: Option<String>,
    pub grant: Option<String>,
    pub under: Option<String>,
    pub session: Option<String>,
    pub launcher: Option<String>,
}

/// `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`
fn session_shaped(text: &str) -> bool {
    let b = text.as_bytes();
    (1..=128).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(c))
}

/// what a launcher left for this muse process, when the file names exactly that process
pub fn read_muse_launch(key: &str, env: &Env, dir: Option<&str>) -> Option<MuseLaunch> {
    let pid = binding_pid(key)?;
    let base = dir.map(String::from).unwrap_or_else(|| relay_dir(env));
    let path = join(&[&base, "launch", &format!("muse-{pid}.json")]);
    let launch: Value = serde_json::from_str(&read_owned_file(&path).ok()?).ok()?;
    let launch = launch.as_object()?;
    if launch.get("process").and_then(Value::as_str) != Some(key) {
        return None;
    }
    let field = |name: &str, ok: &dyn Fn(&str) -> bool| {
        launch
            .get(name)
            .and_then(Value::as_str)
            .filter(|v| ok(v))
            .map(String::from)
    };
    Some(MuseLaunch {
        name: field("name", &valid_handle),
        grant: field("grant", &|v| !v.is_empty()),
        under: field("under", &|v| !v.is_empty()),
        session: field("session", &session_shaped),
        launcher: field("launcher", &|v| binding_pid(v).is_some()),
    })
}

/// a shim binding by launch key, else the first ancestor pid missing from the sandbox's process table
pub fn read_shim_binding(env: &Env, pid: i64, table: Option<&PsCommTable>) -> Option<ShimBinding> {
    let dir = relay_dir(env);
    let read = |name: &str, expected: Option<i64>| -> Option<ShimBinding> {
        let value: Value = serde_json::from_str(
            &read_owned_file(&join(&[&dir, "bindings", &format!("{name}.json")])).ok()?,
        )
        .ok()?;
        let process = value.get("process")?.as_str()?;
        let pid: f64 = binding_pid(process)?.parse().ok()?;
        let harness = value.get("harness").and_then(Value::as_str).unwrap_or("");
        let handle = value.get("handle")?.as_str()?;
        (pid > 1.0
            && expected.is_none_or(|e| e as f64 == pid)
            && BOUND_HARNESSES.contains(&harness)
            && valid_handle(handle))
        .then(|| ShimBinding {
            process: process.into(),
            handle: handle.into(),
            harness: harness.into(),
        })
    };
    if let Some(key) = env.get("SCP_SHIM_BINDING").filter(|k| binding_key(k))
        && let Some(binding) = read(&format!("key-{key}"), None)
    {
        return Some(binding);
    }
    let mut seen = HashSet::new();
    let mut pid = pid;
    while pid > 1 && seen.insert(pid) {
        match table.and_then(|t| t.get(&pid)) {
            None => return read(&format!("pid-{pid}"), Some(pid)),
            Some(entry) => pid = entry.ppid,
        }
    }
    None
}

/// `text.toLowerCase().replace(<runs of characters outside allowed>, "-")`
fn dash_runs(text: &str, allowed: &dyn Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut gap = false;
    for c in text.to_lowercase().chars() {
        if allowed(c) {
            out.push(c);
            gap = false;
        } else if !gap {
            out.push('-');
            gap = true;
        }
    }
    out
}

/// a harness name the relay accepts: lowercase, invalid characters to `-`; `fallback` when nothing is left
pub fn normalize_harness(raw: Option<&str>, fallback: &str) -> String {
    let name = dash_runs(raw.unwrap_or(""), &|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'
    });
    let name: String = name.trim_start_matches('-').chars().take(32).collect();
    let name = name.trim_end_matches('-');
    if name == "claude" {
        return "claude-code".into();
    }
    if valid_harness(name) {
        name.into()
    } else {
        fallback.into()
    }
}

/// `--harness` or $SCP_HARNESS, else the detected harness, else `fallback`
pub fn resolve_harness(explicit: Option<&str>, env: &Env, fallback: &str) -> String {
    match explicit
        .or(env.get("SCP_HARNESS").map(String::as_str))
        .filter(|n| !n.is_empty())
    {
        Some(named) => normalize_harness(Some(named), fallback),
        None => detect_harness(env)
            .map(String::from)
            .unwrap_or_else(|| normalize_harness(Some(fallback), "mcp")),
    }
}

/// the directory holding `.git` (a repository or a linked worktree) at or above `cwd`
pub fn git_toplevel(cwd: &str) -> Option<String> {
    let mut dir = resolve(&safe_cwd(), cwd);
    loop {
        if fs::metadata(join(&[&dir, ".git"])).is_ok() {
            return Some(dir);
        }
        let up = dirname(&dir);
        if up == dir {
            return None;
        }
        dir = up;
    }
}

/// a valid handle from free text: lowercased, invalid characters to `-`, trimmed, reserved names suffixed `-agent`
pub fn to_handle(raw: &str) -> String {
    let handle = dash_runs(raw, &|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c)
    });
    let handle =
        handle.trim_start_matches(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()));
    let handle: String = handle.chars().take(63).collect();
    let mut handle = handle.trim_end_matches(['-', '.']).to_string();
    if handle.is_empty() {
        handle = "agent".into();
    }
    if !valid_handle(&handle) {
        handle = format!("{}-agent", handle.chars().take(56).collect::<String>());
    }
    handle
}

fn short_name(harness: &str) -> &str {
    if harness == "claude-code" {
        "claude"
    } else {
        harness
    }
}

/// `<harness short>-<worktree>`: the worktree is the git toplevel's directory name, else the cwd's
pub fn derive_handle(harness: &str, cwd: &str) -> String {
    let top = git_toplevel(cwd).unwrap_or_else(|| resolve(&safe_cwd(), cwd));
    let base = basename(&top);
    to_handle(&format!(
        "{}-{}",
        short_name(harness),
        if base.is_empty() { "root" } else { base }
    ))
}

/// the first `count` UTF-16 units of `text`
fn utf16_prefix(text: &str, count: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(count).collect::<Vec<_>>())
}

/// the first attached folder, else the local Cowork session id
pub fn cowork_handle(env: &Env) -> String {
    let raw = env
        .get("CLAUDE_CODE_WORKSPACE_HOST_PATHS")
        .map(String::as_str)
        .unwrap_or("");
    let paths: Vec<Value> = if js_trim(raw).starts_with('[') {
        match serde_json::from_str::<Value>(raw) {
            Ok(Value::Array(items)) => items,
            _ => Vec::new(),
        }
    } else {
        raw.split(':').map(|p| Value::String(p.into())).collect()
    };
    let first = paths
        .iter()
        .filter_map(Value::as_str)
        .find(|p| !js_trim(p).is_empty());
    let folder = first
        .map(|p| basename(p.trim_end_matches(['\\', '/'])).to_string())
        .unwrap_or_default();
    let session = env
        .get("CLAUDE_CODE_SESSION_ID")
        .map(|s| utf16_prefix(s, 8))
        .filter(|s| !s.is_empty());
    let name = if !folder.is_empty() {
        folder
    } else {
        session.unwrap_or_else(|| "session".into())
    };
    to_handle(&format!("cowork-{name}"))
}

/// `^[a-z0-9][a-z0-9._-]{0,31}$`
fn label_key(key: &str) -> bool {
    let b = key.as_bytes();
    let plain = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    (1..=32).contains(&b.len()) && plain(&b[0]) && b.iter().all(|c| plain(c) || b"._-".contains(c))
}

/// `k=v,k=v` with invalid keys dropped
pub fn parse_labels(value: Option<&str>) -> Map<String, Value> {
    let mut labels = Map::new();
    for pair in value.unwrap_or("").split(',') {
        let Some(eq) = pair.find('=').filter(|eq| *eq > 0) else {
            continue;
        };
        let key = js_trim(&pair[..eq]);
        if label_key(key) {
            labels.insert(key.into(), Value::String(js_trim(&pair[eq + 1..]).into()));
        }
    }
    labels
}

fn system_hostname() -> String {
    if cfg!(target_os = "macos")
        && let Some(name) = crate::ps::capture(
            &["scutil", "--get", "LocalHostName"],
            None,
            Some(2000),
            None,
        )
        && !js_trim(&name).is_empty()
    {
        return js_trim(&name).to_string();
    }
    let mut buffer = [0u8; 256];
    if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } != 0 {
        return String::new();
    }
    let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

/// the lowercased first label of this machine's name: agents' machine label
pub fn short_hostname() -> String {
    static HOST: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let name = HOST.get_or_init(system_hostname);
    let first = name.split('.').next().unwrap_or("");
    let short = dash_runs(first, &|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c)
    });
    if short.is_empty() {
        "unknown".into()
    } else {
        short
    }
}

/// $SCP_LABELS plus `machine=<short hostname>` unless it names a machine itself
pub fn labels_for(env: &Env, host: &dyn Fn() -> String) -> Map<String, Value> {
    let mut labels = parse_labels(env.get("SCP_LABELS").map(String::as_str));
    if !labels.contains_key("machine") {
        labels.insert("machine".into(), Value::String(host()));
    }
    labels
}

/// `env:<$SCP_SESSION>`, never shaped like a process key, else the process key
pub fn session_key(env: &Env, harness_process: &str) -> String {
    match truthy(env, "SCP_SESSION") {
        Some(session) => format!("env:{session}"),
        None => harness_process.into(),
    }
}

/// the provider's hook format for hosted and desktop sessions
pub fn hook_format<'a>(claimed: &'a str, provider: &'a str) -> &'a str {
    let harness = if claimed == T3CODE { provider } else { claimed };
    match harness {
        "claude-desktop" | "claude-cowork" => "claude-code",
        "codex-desktop" => "codex",
        _ => harness,
    }
}

/// the session label shared by shims, hooks and shells
pub fn harness_variant(
    detected: &str,
    env: &Env,
    pid: i64,
    table: &dyn Fn() -> Table,
    hosted: Option<&dyn Fn(i64) -> bool>,
) -> String {
    let provider = hook_format(detected, detected);
    if provider == "codex" || provider == "claude-code" {
        let is_hosted = match hosted {
            Some(hosted) => hosted(pid),
            None => t3_hosted(env, pid, table),
        };
        if is_hosted {
            return T3CODE.into();
        }
    }
    if provider == "claude-code" {
        if detected == "claude-cowork" || cowork_live(env) {
            return "claude-cowork".into();
        }
        if detected == "claude-desktop" || is(env, "CLAUDE_CODE_ENTRYPOINT", "claude-desktop") {
            return "claude-desktop".into();
        }
    }
    if provider == "codex" && (detected == "codex-desktop" || codex_desktop(env, pid, table)) {
        return "codex-desktop".into();
    }
    provider.into()
}

/// what a claim is made from: flags, the environment and how to read the process table
#[derive(Clone)]
pub struct IdentityInput {
    pub state_dir: Option<String>,
    pub as_: Option<String>,
    pub harness: Option<String>,
    /// the harness when none is named or detected
    pub fallback_harness: String,
    pub cwd: String,
    pub env: Env,
    pub harness_pid: Rc<dyn Fn(&str) -> i64>,
    /// the harness the harness process runs, for a claim that names none and detects none
    pub infer_harness: Option<Rc<dyn Fn(i64) -> Option<String>>>,
    pub start_of: Option<Rc<dyn Fn(i64) -> Option<String>>>,
    /// process keys of the harness and its ancestors (default [`lineage`])
    pub lineage_of: Option<Rc<dyn Fn(i64) -> Vec<String>>>,
    /// a Claude Code hook's payload session id, or a codex hook's thread id
    pub harness_session: Option<String>,
    pub t3_hosted: Option<Rc<dyn Fn(i64) -> bool>>,
    /// process table shared by hosted harness detection and lineage
    pub ps_table: Option<Rc<dyn Fn() -> Table>>,
}

/// a Codex thread id: a UUID of any version
pub fn codex_thread(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// the session key prefix of a codex thread claimed by its id
pub const CODEX_THREAD_KEY: &str = "codex:";

/// the session a Claude Code command line forks: with `--fork-session`, the id `--resume` (`-r`) names, or the `<id>.jsonl` transcript
/// path it names
pub fn fork_origin(args: Option<&str>) -> Option<String> {
    let words = args.map(crate::ps::js_words).unwrap_or_default();
    if !words.contains(&"--fork-session") {
        return None;
    }
    for (i, word) in words.iter().enumerate() {
        let value = match word.strip_prefix("--resume=") {
            Some(value) => Some(value),
            None if *word == "--resume" || *word == "-r" => words.get(i + 1).copied(),
            None => None,
        };
        let Some(value) = value.filter(|v| !v.starts_with('-')) else {
            continue;
        };
        let base = basename(value);
        let id = base.strip_suffix(".jsonl").unwrap_or(base);
        return session_shaped(id).then(|| id.to_string());
    }
    None
}

/// whether this Claude Code session is the background session its terminal session was moved to
pub fn background_handoff(env: &Env) -> bool {
    is(env, "CLAUDE_CODE_SESSION_KIND", "bg") && is(env, "CLAUDE_BG_SOURCE", "slash")
}

/// the claim a shim or hook makes for this harness session
pub fn relay_identity(input: &IdentityInput) -> Claim {
    let env = &input.env;
    let resolved = resolve_harness(input.harness.as_deref(), env, &input.fallback_harness);
    let pid = (input.harness_pid)(&resolved);
    let inferred = if GENERIC_HARNESSES.contains(&resolved.as_str()) {
        input
            .infer_harness
            .as_ref()
            .and_then(|infer| infer(pid))
            .filter(|h| !h.is_empty())
    } else {
        None
    };
    let detected = inferred.unwrap_or_else(|| resolved.clone());
    let provider = hook_format(&detected, &detected).to_string();
    let table: OnceCell<Table> = OnceCell::new();
    let ps = || -> Table {
        table
            .get_or_init(|| match &input.ps_table {
                Some(read) => read(),
                None => read_ps_table(PS_TIMEOUT_MS).map(Rc::new),
            })
            .clone()
    };
    let hosted = input
        .t3_hosted
        .as_ref()
        .map(|h| h.as_ref() as &dyn Fn(i64) -> bool);
    let harness = harness_variant(&detected, env, pid, &ps, hosted);
    let cwd = if input.cwd.starts_with('/') {
        input.cwd.clone()
    } else {
        resolve(&safe_cwd(), &input.cwd)
    };
    let own = match &input.start_of {
        Some(start_of) => process_key(pid, start_of.as_ref()),
        None => process_key(pid, &ps_start),
    };
    let launched = if harness == "muse"
        && truthy(env, "SCP_NAME").is_none()
        && truthy(env, "SCP_GRANT").is_none()
    {
        read_muse_launch(&own, env, input.state_dir.as_deref())
    } else {
        None
    };
    let named = input
        .as_
        .clone()
        .or_else(|| env.get("SCP_NAME").cloned())
        .or_else(|| launched.as_ref().and_then(|l| l.name.clone()));
    let derived = named.is_none();
    let handle = named.unwrap_or_else(|| {
        if harness == "claude-cowork" {
            cowork_handle(env)
        } else {
            derive_handle(&harness, &cwd)
        }
    });
    let grant = truthy(env, "SCP_GRANT")
        .map(String::from)
        .or_else(|| launched.as_ref().and_then(|l| l.grant.clone()));
    let under = truthy(env, "SCP_UNDER")
        .map(String::from)
        .or_else(|| launched.as_ref().and_then(|l| l.under.clone()));
    let launcher = launched.as_ref().and_then(|l| l.launcher.clone());
    let harness_process = launcher.clone().unwrap_or_else(|| own.clone());
    let claimed = launcher
        .as_deref()
        .and_then(binding_pid)
        .and_then(|p| p.parse::<i64>().ok())
        .unwrap_or(pid);
    let session_env;
    let key_env = match launched.as_ref().and_then(|l| l.session.clone()) {
        Some(session) => {
            let mut copy = env.clone();
            copy.insert("SCP_SESSION".into(), session);
            session_env = copy;
            &session_env
        }
        None => env,
    };
    let keys = match &input.lineage_of {
        Some(lineage_of) => lineage_of(claimed),
        None => ps().map(|t| lineage(claimed, &t)).unwrap_or_default(),
    };
    let pick = |candidates: [Option<&str>; 3], ok: fn(&str) -> bool| {
        candidates
            .into_iter()
            .flatten()
            .find(|id| ok(id))
            .map(String::from)
    };
    let harness_session = match provider.as_str() {
        "claude-code" => pick(
            [
                input.harness_session.as_deref(),
                env.get("CLAUDE_CODE_SESSION_ID").map(String::as_str),
                None,
            ],
            session_shaped,
        ),
        "codex" => pick(
            [
                input.harness_session.as_deref(),
                env.get("CODEX_THREAD_ID").map(String::as_str),
                env.get("SCP_CODEX_THREAD").map(String::as_str),
            ],
            codex_thread,
        ),
        _ => None,
    };
    let args_of = |at: i64| ps().and_then(|t| t.get(&at).map(|e| e.args.clone()));
    let forked = if provider == "claude-code" {
        fork_origin(args_of(pid).as_deref())
    } else {
        None
    };
    let origin = forked.filter(|f| Some(f) != harness_session.as_ref());
    let threaded = harness_session.is_some()
        && (harness == "codex" || harness == "codex-desktop")
        && launched.is_none()
        && truthy(env, "SCP_SESSION").is_none()
        && truthy(env, "SCP_SHIM_BINDING").is_none()
        && (harness == "codex-desktop" || app_server(args_of(pid).as_deref()));

    let mut claim = Map::new();
    let text = |s: &str| Value::String(s.into());
    claim.insert("handle".into(), text(&handle));
    claim.insert("harness".into(), text(&harness));
    claim.insert("cwd".into(), text(&cwd));
    let session = match (&harness_session, threaded) {
        (Some(id), true) => format!("{CODEX_THREAD_KEY}{id}"),
        _ => session_key(key_env, &harness_process),
    };
    claim.insert("session".into(), Value::String(session));
    claim.insert("process".into(), text(&harness_process));
    claim.insert(
        "labels".into(),
        Value::Object(labels_for(env, &short_hostname)),
    );
    if let Some(parent) = truthy(env, "SCP_PARENT") {
        claim.insert("parent".into(), text(parent));
    }
    if let Some(under) = under {
        claim.insert("under".into(), Value::String(under));
    }
    let bare = format!("pid:{pid}");
    let lineage: Vec<String> = if threaded {
        keys.into_iter()
            .filter(|k| *k != own && *k != bare)
            .collect()
    } else {
        keys
    };
    if threaded || !lineage.is_empty() {
        claim.insert(
            "lineage".into(),
            Value::Array(lineage.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(grant) = grant {
        claim.insert("grant".into(), Value::String(grant));
    }
    if let Some(id) = harness_session {
        claim.insert("harness_session".into(), Value::String(id));
    }
    if let Some(origin) = origin {
        claim.insert("harness_origin".into(), Value::String(origin));
        if background_handoff(env) {
            claim.insert("harness_handoff".into(), Value::Bool(true));
        }
    }
    mark_derived(&mut claim, derived);
    claim
}

/// a handle from the harness and cwd default rather than a name given: `derived: true`, else no key
fn mark_derived(claim: &mut Claim, derived: bool) {
    if derived {
        claim.insert("derived".into(), Value::Bool(true));
    }
}

/// `$SCP_WAKE_TICKET` as a claim's `ticket`: a waker that revives a session hands it to the session's shim
pub fn wake_ticket(env: &Env) -> Option<String> {
    let ticket = env.get("SCP_WAKE_TICKET")?;
    let hex = ticket.strip_prefix("kwt_")?;
    (hex.len() == 64
        && hex
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
    .then(|| ticket.clone())
}

/// a claim field as text
pub fn field<'a>(claim: &'a Claim, key: &str) -> &'a str {
    claim.get(key).and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn input(env: Env, cwd: &str) -> IdentityInput {
        IdentityInput {
            state_dir: None,
            as_: None,
            harness: None,
            fallback_harness: "mcp".into(),
            cwd: cwd.into(),
            env,
            harness_pid: Rc::new(|_| 4242),
            infer_harness: None,
            start_of: Some(Rc::new(|_| Some("Mon-Jan-1-00:00:00-2026".into()))),
            lineage_of: Some(Rc::new(|pid| {
                vec![
                    format!("pid:{pid}:Mon-Jan-1-00:00:00-2026"),
                    "pid:1000:x".into(),
                ]
            })),
            harness_session: None,
            t3_hosted: Some(Rc::new(|_| false)),
            ps_table: Some(Rc::new(|| None)),
        }
    }

    #[test]
    fn harness_names() {
        assert_eq!(normalize_harness(Some("Claude"), "x"), "claude-code");
        assert_eq!(normalize_harness(Some("--My Harness!!"), "x"), "my-harness");
        assert_eq!(normalize_harness(Some("___"), "x"), "x");
        assert_eq!(
            resolve_harness(None, &env(&[("CLAUDECODE", "1")]), "mcp"),
            "claude-code"
        );
        assert_eq!(
            resolve_harness(Some(""), &env(&[("SCP_HARNESS", "codex")]), "mcp"),
            "mcp"
        );
        assert_eq!(
            resolve_harness(None, &env(&[("SCP_HARNESS", "codex")]), "mcp"),
            "codex"
        );
        assert_eq!(
            detect_harness(&env(&[
                ("CODEX_SANDBOX", "seatbelt"),
                ("SCP_HARNESS_DETECT", "0")
            ])),
            None
        );
    }

    #[test]
    fn handles() {
        assert_eq!(to_handle("Hello World"), "hello-world");
        assert_eq!(to_handle("..."), "agent");
        assert_eq!(to_handle("me"), "me-agent");
        assert_eq!(to_handle(&"a".repeat(80)).len(), 63);
        assert_eq!(
            cowork_handle(&env(&[(
                "CLAUDE_CODE_WORKSPACE_HOST_PATHS",
                "[\"/x/My Proj/\"]"
            )])),
            "cowork-my-proj"
        );
        assert_eq!(
            cowork_handle(&env(&[("CLAUDE_CODE_SESSION_ID", "ABCDEFGHIJ")])),
            "cowork-abcdefgh"
        );
        assert_eq!(
            cowork_handle(&env(&[("CLAUDE_CODE_WORKSPACE_HOST_PATHS", "[bad")])),
            "cowork-session"
        );
    }

    #[test]
    fn labels() {
        let labels = labels_for(&env(&[("SCP_LABELS", " team = a ,=x,Bad=y,ok=")]), &|| {
            "host".into()
        });
        assert_eq!(
            serde_json::to_string(&labels).unwrap(),
            r#"{"machine":"host","ok":"","team":"a"}"#
        );
        let named = labels_for(&env(&[("SCP_LABELS", "machine=m")]), &|| "host".into());
        assert_eq!(named["machine"], "m");
    }

    #[test]
    fn forks() {
        assert_eq!(
            fork_origin(Some("claude --fork-session -r abc")).as_deref(),
            Some("abc")
        );
        assert_eq!(
            fork_origin(Some("claude --fork-session --resume=/x/abc.jsonl")).as_deref(),
            Some("abc")
        );
        assert_eq!(fork_origin(Some("claude --resume abc")), None);
        assert_eq!(fork_origin(Some("claude --fork-session --resume -x")), None);
    }

    #[test]
    fn threads_and_tickets() {
        assert!(codex_thread("0199a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6b"));
        assert!(codex_thread("0199A1B2-C3D4-7E8F-9A0B-1C2D3E4F5A6B"));
        assert!(!codex_thread("0199a1b2c3d47e8f9a0b1c2d3e4f5a6b"));
        let ticket = format!("kwt_{}", "a".repeat(64));
        assert_eq!(
            wake_ticket(&env(&[("SCP_WAKE_TICKET", &ticket)])),
            Some(ticket)
        );
        assert_eq!(wake_ticket(&env(&[("SCP_WAKE_TICKET", "kwt_x")])), None);
    }

    #[test]
    fn claims() {
        let dir = std::env::temp_dir().join(format!("scp-mcp-id-{}", std::process::id()));
        let project = dir.join("Proj One");
        fs::create_dir_all(project.join(".git")).unwrap();
        let cwd = project.to_str().unwrap().to_string();
        let claim = relay_identity(&input(
            env(&[
                ("CLAUDECODE", "1"),
                ("CLAUDE_CODE_SESSION_ID", "sess-1"),
                ("SCP_LABELS", "machine=m"),
            ]),
            &cwd,
        ));
        assert_eq!(
            Value::Object(claim),
            serde_json::json!({
                "handle": "claude-proj-one", "harness": "claude-code", "cwd": cwd, "session": "pid:4242:Mon-Jan-1-00:00:00-2026",
                "process": "pid:4242:Mon-Jan-1-00:00:00-2026", "labels": {"machine": "m"},
                "lineage": ["pid:4242:Mon-Jan-1-00:00:00-2026", "pid:1000:x"], "harness_session": "sess-1", "derived": true,
            })
        );
        let named = relay_identity(&input(
            env(&[
                ("SCP_NAME", "worker"),
                ("SCP_SESSION", "s1"),
                ("SCP_GRANT", "g"),
                ("SCP_UNDER", "me/boss"),
                ("SCP_PARENT", "me/p"),
                ("SCP_LABELS", "machine=m"),
            ]),
            &cwd,
        ));
        assert_eq!(named["handle"], "worker");
        assert_eq!(named["harness"], "mcp");
        assert_eq!(named["session"], "env:s1");
        assert_eq!(named["grant"], "g");
        assert_eq!(named["under"], "me/boss");
        assert_eq!(named["parent"], "me/p");
        assert!(!named.contains_key("derived"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn threaded_codex_claims() {
        let thread = "0199a1b2-c3d4-7e8f-9a0b-1c2d3e4f5a6b";
        let mut with = input(
            env(&[
                ("SCP_HARNESS", "codex-desktop"),
                ("SCP_LABELS", "machine=m"),
            ]),
            "/",
        );
        with.harness_session = Some(thread.into());
        let claim = relay_identity(&with);
        assert_eq!(claim["session"], format!("codex:{thread}"));
        assert_eq!(claim["lineage"], serde_json::json!(["pid:1000:x"]));
    }

    #[test]
    fn bindings_round_trip() {
        let dir = std::env::temp_dir().join(format!("scp-mcp-bind-{}", std::process::id()));
        let e = env(&[
            ("SCP_DIR", dir.to_str().unwrap()),
            ("SCP_SHIM_BINDING", "abc"),
        ]);
        let claim = ShimBinding {
            process: "pid:77:Mon-x".into(),
            handle: "codex-a".into(),
            harness: "codex".into(),
        };
        let mut binding = write_shim_binding(&claim, &e);
        assert_eq!(binding.paths.len(), 2);
        let text = fs::read_to_string(dir.join("bindings/pid-77.json")).unwrap();
        assert_eq!(
            text,
            r#"{"process":"pid:77:Mon-x","handle":"codex-a","harness":"codex"}"#
        );
        assert_eq!(read_shim_binding(&e, 77, None), Some(claim.clone()));
        let mut none = write_shim_binding(
            &ShimBinding {
                harness: "claude-code".into(),
                ..claim
            },
            &e,
        );
        assert!(none.paths.is_empty());
        none.remove();
        binding.remove();
        assert!(!dir.join("bindings/pid-77.json").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
