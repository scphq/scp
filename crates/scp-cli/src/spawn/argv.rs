//! A harness command as spawn runs it: wrappers skipped, grant forwarding and relay permissions added, codex's prompt and resume words.

use super::muse::{MUSE_MODE, muse_mode_at};
use crate::args::{js_string, tables};
use crate::fleet::json::Json;
use crate::{Fail, usage};
use scp_core::protocol::{CLI_NAME, LIMITS};
use scp_mcp::identity::home_dir;
use scp_mcp::ps::{CODEX_VALUED, Env, basename, capture, dirname, join, resolve};
use scp_mcp::render::js_space;
use scp_mcp::spawn::muse_modes;
use scp_mcp::tools::js_num;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, mpsc};
use std::time::{Duration, Instant};
use toml::{Table, Value as Toml};

pub use scp_mcp::spawn::program_at;

const SERVER: &str = "scp";
/// the words of Codex's `swarm mcp` mount
const CODEX_MCP: [&str; 2] = ["--harness", "codex"];

/// what the relay MCP shim reads to claim its endpoint and find the broker; codex hands an MCP server only these when named in env_vars
const SHIM_ENV: [&str; 10] = [
    "SCP_GRANT",
    "SCP_NAME",
    "SCP_UNDER",
    "SCP_LABELS",
    "SCP_DIR",
    "XDG_STATE_HOME",
    "SCP_SHIM_BINDING",
    "SCP_SESSION",
    "SCP_HARNESS_PID",
    "SCP_CODEX_THREAD",
];

fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|w| (*w).to_owned()).collect()
}

/// `$HOME`, else the user database
pub fn home(env: &Env) -> String {
    env.get("HOME")
        .filter(|h| !h.is_empty())
        .cloned()
        .unwrap_or_else(home_dir)
}

/// codex's user config: `$CODEX_HOME/config.toml`, else under ~/.codex
pub fn codex_config(env: &Env) -> String {
    let dir = match env.get("CODEX_HOME").filter(|d| !d.is_empty()) {
        Some(dir) => dir.clone(),
        None => join(&[&home(env), ".codex"]),
    };
    join(&[&dir, "config.toml"])
}

/// codex's scp entry in its user config, if it has one
pub fn codex_mount(env: &Env) -> Option<Table> {
    let bytes = std::fs::read(codex_config(env)).ok()?;
    let config: Table = toml::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    if !config.values().all(lossless) {
        return None;
    }
    match config.get("mcp_servers")?.get(SERVER)? {
        Toml::Table(entry) => Some(entry.clone()),
        _ => None,
    }
}

/// whether every integer in `value` is one a JavaScript number holds exactly: the TOML reader the TypeScript CLI uses refuses the file otherwise
fn lossless(value: &Toml) -> bool {
    const SAFE: i64 = (1 << 53) - 1;
    match value {
        Toml::Integer(n) => n.abs_diff(0) <= SAFE as u64,
        Toml::Array(items) => items.iter().all(lossless),
        Toml::Table(table) => table.values().all(lossless),
        _ => true,
    }
}

/// whether `key` is an array index, which JavaScript's own-key order puts first
fn index_key(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}

/// a table's entries in `Object.entries` order: array indexes ascending, then the rest as written
fn entries(table: &Table) -> Vec<(&String, &Toml)> {
    let mut indexed: Vec<(u32, (&String, &Toml))> = table
        .iter()
        .filter_map(|(k, v)| index_key(k).map(|n| (n, (k, v))))
        .collect();
    indexed.sort_by_key(|(n, _)| *n);
    let mut out: Vec<(&String, &Toml)> = indexed.into_iter().map(|(_, e)| e).collect();
    out.extend(table.iter().filter(|(k, _)| index_key(k).is_none()));
    out
}

fn js_number(n: f64) -> String {
    if n.is_finite() {
        js_num(n)
    } else {
        "null".into()
    }
}

/// a value as a TOML literal in a codex `-c` override: JSON strings with DEL escaped, arrays, inline tables
pub fn toml(value: &Toml) -> String {
    match value {
        Toml::String(text) => js_string(text).replace('\u{7f}', "\\u007f"),
        Toml::Array(items) => format!(
            "[{}]",
            items.iter().map(toml).collect::<Vec<_>>().join(", ")
        ),
        Toml::Table(table) => format!(
            "{{ {} }}",
            entries(table)
                .into_iter()
                .map(|(k, v)| format!("{} = {}", js_string(k), toml(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Toml::Datetime(_) => "{  }".into(),
        Toml::Integer(n) => js_number(*n as f64),
        Toml::Float(n) => js_number(*n),
        Toml::Boolean(on) => on.to_string(),
    }
}

/// a TOML value as `String()` writes it
fn js_text(value: &Toml) -> String {
    match value {
        Toml::String(text) => text.clone(),
        Toml::Integer(n) => js_num(*n as f64),
        Toml::Float(n) => js_num(*n),
        Toml::Boolean(on) => on.to_string(),
        Toml::Array(items) => items.iter().map(js_text).collect::<Vec<_>>().join(","),
        Toml::Table(_) => "[object Object]".into(),
        Toml::Datetime(at) => at.to_string(),
    }
}

/// a mount entry's command line: its command, then its args
fn entry_argv(entry: &Table) -> Vec<String> {
    let mut argv = vec![entry.get("command").map(js_text).unwrap_or_default()];
    if let Some(Toml::Array(args)) = entry.get("args") {
        argv.extend(args.iter().map(js_text));
    }
    argv
}

/// the words after `mcp` in a mount's command line, else `fallback`
pub fn mcp_words(argv: &[String], fallback: &[String]) -> Vec<String> {
    match argv.iter().position(|w| w == "mcp") {
        Some(at) => argv[at + 1..].to_vec(),
        None => fallback.to_vec(),
    }
}

/// what `SCP_NATIVE` runs natively: `all` for 1, `mcp` for mcp, else off
pub fn native_mode(env: &Env) -> &'static str {
    match env.get("SCP_NATIVE").map(String::as_str) {
        Some("1") => "all",
        Some("mcp") => "mcp",
        _ => "off",
    }
}

/// an MCP server a harness runs: its command line and the variables the mount adds to its environment
#[derive(Debug, Clone, PartialEq)]
pub struct Mount {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub native: bool,
}

/// the mount that runs `swarm mcp <words>` on the native `bin` when there is one, else on `launch`; a native one keeps `SCP_NATIVE=mcp`, else sets 1
pub fn mount_with(bin: Option<&str>, launch: &[String], words: &[String], env: &Env) -> Mount {
    let Some(bin) = bin else {
        let mut argv = launch.to_vec();
        argv.push("mcp".into());
        argv.extend_from_slice(words);
        return Mount {
            argv,
            env: Vec::new(),
            native: false,
        };
    };
    let mut argv = vec![bin.to_owned(), "mcp".into()];
    argv.extend_from_slice(words);
    let mode = if native_mode(env) == "mcp" {
        "mcp"
    } else {
        "1"
    };
    let mut vars = vec![("SCP_NATIVE".to_owned(), mode.to_owned())];
    if env.get("SCP_SWARM_BIN").is_some_and(|b| !b.is_empty()) {
        vars.push(("SCP_SWARM_BIN".into(), bin.to_owned()));
    }
    vars.push((
        "SCP_CLI_ARGV".into(),
        serde_json::to_string(launch).unwrap_or_default(),
    ));
    Mount {
        argv,
        env: vars,
        native: true,
    }
}

/// the variables a native mount sets, which a mount through Node drops
pub const NATIVE_MOUNT_VARS: [&str; 3] = ["SCP_NATIVE", "SCP_SWARM_BIN", "SCP_CLI_ARGV"];

/// the mount that runs `swarm mcp <words>`: under `SCP_NATIVE=1` or `mcp` the native `swarm` itself, told the words that start this CLI
/// (`launch`) and the mode; otherwise `launch` followed by `mcp`
pub fn mcp_mount(launch: &[String], words: &[String], env: &Env) -> Mount {
    mount_with(native_mount_bin(env).as_deref(), launch, words, env)
}

/// a kept mount's variables under `env`: with `SCP_NATIVE=mcp`, a saved `SCP_NATIVE=1` becomes mcp, so the mount never starts the native broker
pub fn pin_mode(vars: &Json, env: &Env) -> Json {
    let mut pinned = vars.clone();
    if native_mode(env) == "mcp" && vars.get("SCP_NATIVE").and_then(Json::as_str) == Some("1") {
        pinned.set("SCP_NATIVE", Json::str("mcp"));
    }
    pinned
}

/// `vars` without the ones a native mount sets, then with `mount`'s
pub fn mount_vars(vars: &Json, mount: &Mount) -> Json {
    let mut out = Json::Obj(
        vars.entries()
            .into_iter()
            .filter(|(k, _)| !NATIVE_MOUNT_VARS.contains(k))
            .map(|(k, v)| (k.to_owned(), v.clone()))
            .collect(),
    );
    for (key, value) in &mount.env {
        out.set(key, Json::str(value.as_str()));
    }
    out
}

/// whether `path` is an executable file
pub fn executable(path: &str) -> bool {
    let Ok(c_path) = std::ffi::CString::new(path.as_bytes()) else {
        return false;
    };
    // SAFETY: access reads a C string that outlives the call
    let allowed = unsafe { libc::access(c_path.as_ptr(), libc::X_OK) == 0 };
    allowed && std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// `<dir>/<name>` for the first directory of `$PATH` that has it as an executable file
pub fn which_on_path(name: &str, env: &Env) -> Option<String> {
    env.get("PATH")?
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| join(&[dir, name]))
        .find(|path| executable(path))
}

/// `$SCP_SWARM_BIN`, when it is an executable file whose `--version` prints `swarm <version>`, else this binary
fn native_swarm(env: &Env) -> Option<String> {
    let Some(given) = env.get("SCP_SWARM_BIN") else {
        let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
        return Some(exe.to_string_lossy().into_owned());
    };
    let bin = resolve(&scp_mcp::identity::safe_cwd(), given);
    if !executable(&bin) {
        return None;
    }
    let vars: Vec<(&str, String)> = env.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    let printed = capture(
        &[bin.as_str(), "--version"],
        Some(vars.as_slice()),
        Some(VERSION_TIMEOUT_MS),
        Some(VERSION_MAX_BYTES),
    )?;
    (printed == format!("{CLI_NAME} {}\n", crate::VERSION)).then_some(bin)
}

const VERSION_TIMEOUT_MS: u64 = 10_000;
const VERSION_MAX_BYTES: usize = 4096;

/// `process.platform`, `process.arch` and the native package this binary's platform has, as the router names them
fn platform() -> (&'static str, &'static str, Option<String>) {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let gnu = cfg!(target_env = "gnu");
    let key = match (os, arch) {
        ("darwin", "arm64" | "x64") => Some(format!("darwin-{arch}")),
        ("linux", "x64") => Some(format!("linux-x64-{}", if gnu { "gnu" } else { "musl" })),
        ("linux", "arm64") if gnu => Some("linux-arm64-gnu".to_owned()),
        _ => None,
    };
    (os, arch, key)
}

static MOUNT_NOTED: AtomicBool = AtomicBool::new(false);

/// with `SCP_NATIVE=1` or `mcp`, the native `swarm` whose `swarm mcp` a mount runs directly; a missing or mismatched one is noted once and mounts run through Node
pub fn native_mount_bin(env: &Env) -> Option<String> {
    if native_mode(env) == "off" {
        return None;
    }
    let bin = native_swarm(env);
    if bin.is_none() && !MOUNT_NOTED.swap(true, Ordering::Relaxed) {
        let (os, arch, key) = platform();
        let fix = match key {
            Some(key) => format!("install @scp-dev/native-{key} or set SCP_SWARM_BIN"),
            None => "set SCP_SWARM_BIN".to_owned(),
        };
        crate::term::note(&format!(
            "SCP_NATIVE={} but no native swarm {} binary for {os}-{arch} ({fix}); MCP mounts run swarm mcp through Node",
            env.get("SCP_NATIVE").map_or("", String::as_str),
            crate::VERSION
        ));
    }
    bin
}

/// whether `command` is an absolute path to no executable file, as a mount's native swarm is once an upgrade or uninstall removed it
pub fn gone_command(command: Option<&Toml>) -> bool {
    let Some(Toml::String(path)) = command else {
        return false;
    };
    if !path.starts_with('/') {
        return false;
    }
    let Ok(c_path) = std::ffi::CString::new(path.as_bytes()) else {
        return true;
    };
    if unsafe { libc::access(c_path.as_ptr(), libc::X_OK) } != 0 {
        return true;
    }
    !std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// the variable a kept codex mount needs set so it keeps the mode of `env`: `SCP_NATIVE=mcp` over a saved 1
fn pinned_mode(mount: Option<&Table>, env: &Env) -> Vec<(String, String)> {
    let saved = mount
        .and_then(|m| m.get("env"))
        .and_then(Toml::as_table)
        .and_then(|vars| vars.get("SCP_NATIVE"))
        .and_then(Toml::as_str);
    if native_mode(env) == "mcp" && saved == Some("1") {
        vec![("SCP_NATIVE".into(), "mcp".into())]
    } else {
        Vec::new()
    }
}

/// Pass shim variables by name to keep the grant out of argv. Headless Codex needs tool approval unless the mount sets it. Under
/// SCP_NATIVE=1 or mcp the server is the native `bin`'s `swarm mcp`, with the mount's words when there is one; a mount whose command is
/// gone runs this CLI's instead.
pub fn codex_overrides(
    env: &Env,
    mount: Option<&Table>,
    self_words: &[String],
    bin: Option<&str>,
) -> Vec<String> {
    let kept: Vec<Toml> = match mount.and_then(|m| m.get("env_vars")) {
        Some(Toml::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let names = SHIM_ENV.iter().filter(|name| {
        env.contains_key(**name)
            && !kept
                .iter()
                .any(|k| matches!(k, Toml::String(s) if s == **name))
    });
    let mut out = Vec::new();
    let mut set = |field: &str, value: &Toml| {
        out.push("-c".to_owned());
        out.push(format!("mcp_servers.{SERVER}.{field}={}", toml(value)));
    };
    let fallback = words(&CODEX_MCP);
    let mount_words = match mount {
        Some(entry) => mcp_words(&entry_argv(entry), &fallback),
        None => fallback,
    };
    let bin = bin.filter(|_| native_mode(env) != "off");
    let server = mount_with(bin, self_words, &mount_words, env);
    let strings = |list: &[String]| Toml::Array(list.iter().cloned().map(Toml::String).collect());
    if !(mount.is_some() && !server.native && !gone_command(mount.and_then(|m| m.get("command")))) {
        set("command", &Toml::String(server.argv[0].clone()));
        set("args", &strings(&server.argv[1..]));
    }
    let vars = if server.native {
        server.env.clone()
    } else {
        pinned_mode(mount, env)
    };
    for (name, value) in vars {
        set(&format!("env.{name}"), &Toml::String(value));
    }
    let mut listed = kept.clone();
    listed.extend(names.map(|n| Toml::String((*n).to_owned())));
    set("env_vars", &Toml::Array(listed));
    set("enabled", &Toml::Boolean(true));
    if !mount.is_some_and(|m| m.contains_key("default_tools_approval_mode")) {
        set(
            "default_tools_approval_mode",
            &Toml::String("approve".into()),
        );
    }
    out
}

/// codex subcommands that start a session and take their own `-c`, which replaces the top-level ones
const CODEX_SESSIONS: [&str; 5] = ["exec", "e", "review", "resume", "fork"];

/// codex exec's options that take a value
fn exec_valued(word: &str) -> bool {
    CODEX_VALUED.contains(&word)
        || matches!(
            word,
            "--output-schema" | "--color" | "-o" | "--output-last-message"
        )
}

fn valued(word: &str) -> bool {
    CODEX_VALUED.contains(&word)
}

/// where in codex's arguments `-c` overrides go: first, and again after a session subcommand (and after exec's own resume or review, past exec's options)
pub fn codex_override_at(args: &[String]) -> Vec<usize> {
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') && args[i] != "--" {
        i += if valued(&args[i]) { 2 } else { 1 };
    }
    if i >= args.len() || !CODEX_SESSIONS.contains(&args[i].as_str()) {
        return vec![0];
    }
    let mut at = vec![0, i + 1];
    if args[i] == "exec" || args[i] == "e" {
        let mut j = i + 1;
        while j < args.len() && args[j].starts_with('-') && args[j] != "--" {
            j += if exec_valued(&args[j]) { 2 } else { 1 };
        }
        if args.get(j).is_some_and(|w| w == "resume" || w == "review") {
            at.push(j + 1);
        }
    }
    at
}

/// whether `args`, up to a `--`, hold one of `flags`, alone or as `--flag=value`
pub fn has_flag(args: &[String], flags: &[&str]) -> bool {
    let end = args.iter().position(|w| w == "--").unwrap_or(args.len());
    args[..end].iter().any(|arg| {
        flags.iter().any(|flag| {
            arg == flag
                || (flag.starts_with("--")
                    && arg.len() > flag.len()
                    && arg.starts_with(flag)
                    && arg.as_bytes()[flag.len()] == b'=')
        })
    })
}

/// the relay tools a spawned worker messages with, as allow rules: never peek settings, groups or rules
pub const MESSAGING: [&str; 11] = [
    "mcp__scp__relay_send",
    "mcp__scp__relay_ask",
    "mcp__scp__relay_ask_wait",
    "mcp__scp__relay_reply",
    "mcp__scp__relay_inbox",
    "mcp__scp__relay_list",
    "mcp__scp__relay_peers",
    "mcp__scp__relay_whoami",
    "mcp__scp__relay_set_status",
    "mcp__scp__relay_set_now",
    "mcp__scp__relay_set_title",
];

/// a headless run of a harness that refuses the relay tools without an allow rule, and the flags with which the user decides that instead
pub struct Preset {
    pub headless: &'static [&'static str],
    pub own: &'static [&'static str],
    pub allow: fn() -> Vec<String>,
}

const CLAUDE: Preset = Preset {
    headless: &["-p", "--print"],
    own: &[
        "--allowedTools",
        "--allowed-tools",
        "--dangerously-skip-permissions",
        "--permission-mode",
    ],
    allow: || {
        std::iter::once("--allowedTools")
            .chain(MESSAGING)
            .map(str::to_owned)
            .collect()
    },
};
const GROK: Preset = Preset {
    headless: &["-p", "--single", "--prompt-file", "--prompt-json"],
    own: &[
        "--allow",
        "--allowedTools",
        "--allowed-tools",
        "--always-approve",
        "--permission-mode",
    ],
    allow: || {
        MESSAGING
            .iter()
            .flat_map(|tool| ["--allow".to_owned(), (*tool).to_owned()])
            .collect()
    },
};

pub fn preset(harness: &str) -> Option<&'static Preset> {
    match harness {
        "claude" => Some(&CLAUDE),
        "grok" => Some(&GROK),
        _ => None,
    }
}

/// the allow rules for the relay messaging tools that a headless `harness` needs, unless `args` hold a flag with which the user decides that
pub fn messaging_allow(harness: &str, args: &[String]) -> Vec<String> {
    match preset(harness) {
        Some(preset) if !has_flag(args, preset.own) => (preset.allow)(),
        _ => Vec::new(),
    }
}

const SKIP_GIT: &str = "--skip-git-repo-check";
/// how long spawn waits for `codex exec --help`
const PROBE: Duration = Duration::from_millis(3000);
const PROBE_MAX_BUFFER: usize = 1024 * 1024;

/// whether the codex at `program` lists --skip-git-repo-check in `codex exec --help`, asked once per program; false when it cannot tell in time
pub fn codex_skips_git_check(program: &str, env: &Env) -> bool {
    static PROBES: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let probes = PROBES.get_or_init(Default::default);
    if let Some(takes) = probes.lock().ok().and_then(|p| p.get(program).copied()) {
        return takes;
    }
    let takes = probe_help(program, env);
    if let Ok(mut p) = probes.lock() {
        p.insert(program.to_owned(), takes);
    }
    takes
}

fn probe_help(program: &str, env: &Env) -> bool {
    let child = Command::new(program)
        .args(["exec", "--help"])
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return false;
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    };
    let (sent, read) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = (&mut stdout)
            .take(PROBE_MAX_BUFFER as u64 + 1)
            .read_to_end(&mut out);
        let _ = sent.send(out);
    });
    let deadline = Instant::now() + PROBE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    };
    let Ok(out) = read.recv_timeout(deadline.saturating_duration_since(Instant::now())) else {
        return false;
    };
    status.code() == Some(0)
        && out.len() <= PROBE_MAX_BUFFER
        && String::from_utf8_lossy(&out).contains(SKIP_GIT)
}

/// whether `dir` or a directory above it holds a .git, a repository's directory or a worktree's file
pub fn in_git(dir: &str) -> bool {
    let mut at = dir.to_owned();
    loop {
        if std::path::Path::new(&join(&[&at, ".git"])).exists() {
            return true;
        }
        let up = dirname(&at);
        if up == at {
            return false;
        }
        at = up;
    }
}

/// exec's resume or review subcommand and its index
#[derive(Debug, Clone, PartialEq)]
pub struct Sub {
    pub name: &'static str,
    pub at: usize,
}

/// a `codex [opts] exec [opts] [resume|review] ...` command's shape
#[derive(Debug, Clone, PartialEq)]
pub struct CodexExec {
    pub exec: usize,
    pub sub: Option<Sub>,
    pub operands: Vec<String>,
    pub cd: Option<String>,
}

/// Locate exec, its subcommand and operands, tracking the last working-directory override.
pub fn codex_exec(args: &[String]) -> Option<CodexExec> {
    let mut cd: Option<String> = None;
    let mut options = |from: usize, exec: bool| {
        let mut i = from;
        while i < args.len() && args[i].starts_with('-') && args[i] != "--" && args[i] != "-" {
            let word = &args[i];
            if word == "-C" || word == "--cd" {
                cd = args.get(i + 1).cloned();
            } else if let Some(dir) = word.strip_prefix("--cd=") {
                cd = Some(dir.to_owned());
            }
            let takes = if exec {
                exec_valued(word)
            } else {
                valued(word)
            };
            i += if takes { 2 } else { 1 };
        }
        i
    };
    let exec = options(0, false);
    if !args.get(exec).is_some_and(|w| w == "exec" || w == "e") {
        return None;
    }
    let mut i = options(exec + 1, true);
    let sub = match args.get(i).map(String::as_str) {
        Some("resume") => Some(Sub {
            name: "resume",
            at: i,
        }),
        Some("review") => Some(Sub {
            name: "review",
            at: i,
        }),
        _ => None,
    };
    let mut operands = Vec::new();
    if sub.is_some() {
        i += 1;
    }
    while i < args.len() {
        i = options(i, true);
        if i >= args.len() {
            break;
        }
        if args[i] == "--" {
            operands.extend_from_slice(&args[i + 1..]);
            break;
        }
        operands.push(args[i].clone());
        i += 1;
    }
    Some(CodexExec {
        exec,
        sub,
        operands,
        cd,
    })
}

fn program_is(command: &[String], name: &str) -> Option<usize> {
    let at = program_at(command);
    command
        .get(at)
        .is_some_and(|p| basename(p) == name)
        .then_some(at)
}

/// Codex exec reads stdin for absent or "-" prompts; argv prompts accept context through harnessStdin.
pub fn closed_stdin(command: &[String]) -> bool {
    let Some(at) = program_is(command, "codex") else {
        return false;
    };
    let args = &command[at + 1..];
    let Some(run) = codex_exec(args) else {
        return false;
    };
    if run.operands.iter().any(|w| w == "-") {
        return false;
    }
    if run.sub.as_ref().is_some_and(|s| s.name == "resume") {
        let need = if has_flag(args, &["--last"]) { 1 } else { 2 };
        return run.operands.len() >= need;
    }
    run.sub.is_some() || !run.operands.is_empty()
}

/// what `harness_argv` reads besides the command: this CLI's words, codex's mount and the native swarm it runs, the working directory and the skip-git probe
pub struct Context<'a> {
    pub self_words: &'a [String],
    pub mount: &'a dyn Fn(&Env) -> Option<Table>,
    pub bin: Option<&'a str>,
    pub cwd: &'a str,
    pub probe: &'a dyn Fn(&str, &Env) -> bool,
}

/// Add grant forwarding and messaging permissions while preserving wrappers and explicit harness permissions.
pub fn harness_argv(command: &[String], env: &Env, context: &Context) -> Vec<String> {
    let at = program_at(command);
    let Some(program) = command.get(at) else {
        return command.to_vec();
    };
    let name = basename(program);
    let args = &command[at + 1..];
    if let Some(preset) = preset(name) {
        if !has_flag(args, preset.headless) || has_flag(args, preset.own) {
            return command.to_vec();
        }
        let split = args
            .iter()
            .position(|w| w == "--")
            .map_or(command.len(), |end| at + 1 + end);
        let mut out = command[..split].to_vec();
        out.extend((preset.allow)());
        out.extend_from_slice(&command[split..]);
        return out;
    }
    if name == "muse" {
        if !muse_modes(args).is_empty() {
            return command.to_vec();
        }
        let mode = at + 1 + muse_mode_at(args);
        let mut out = command[..mode].to_vec();
        out.extend([MUSE_MODE.to_owned(), "off".to_owned()]);
        out.extend_from_slice(&command[mode..]);
        return out;
    }
    if name != "codex" {
        return command.to_vec();
    }
    let run = codex_exec(args);
    let skip = run.as_ref().is_some_and(|run| {
        !run.sub.as_ref().is_some_and(|s| s.name == "review")
            && !has_flag(args, &[SKIP_GIT])
            && !in_git(&resolve(context.cwd, run.cd.as_deref().unwrap_or(".")))
            && (context.probe)(program, env)
    });
    let after = run
        .as_ref()
        .map(|run| run.sub.as_ref().map_or(run.exec, |s| s.at) + 1);
    let mut words = args.to_vec();
    if skip && let Some(after) = after {
        words.insert(after, SKIP_GIT.to_owned());
    }
    let overrides = codex_overrides(
        env,
        (context.mount)(env).as_ref(),
        context.self_words,
        context.bin,
    );
    let points = codex_override_at(&words);
    let mut out = command[..at + 1].to_vec();
    for (i, arg) in words.iter().enumerate() {
        if points.contains(&i) {
            out.extend(overrides.iter().cloned());
        }
        out.push(arg.clone());
    }
    if points.contains(&words.len()) {
        out.extend(overrides);
    }
    out
}

/// claude's options that take a value, so the word after one is no prompt
const CLAUDE_VALUED: [&str; 26] = [
    "--model",
    "--fallback-model",
    "--output-format",
    "--input-format",
    "--permission-mode",
    "--settings",
    "--setting-sources",
    "--mcp-config",
    "--allowedTools",
    "--allowed-tools",
    "--disallowedTools",
    "--disallowed-tools",
    "--tools",
    "--add-dir",
    "--append-system-prompt",
    "--system-prompt",
    "--session-id",
    "--resume",
    "-r",
    "--max-turns",
    "--agents",
    "--agent",
    "--plugin-dir",
    "--permission-prompt-tool",
    "--effort",
    "--betas",
];

/// where a headless harness's prompt is: the word at `at`, joined from `from` when claude's prompt follows a `--`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Prompt {
    pub at: usize,
    pub from: Option<usize>,
}

/// Locate Claude print's last operand or Codex exec's first, skipping flag values and stdin prompts.
pub fn prompt_at(command: &[String]) -> Option<Prompt> {
    let at = program_at(command);
    let name = basename(command.get(at)?);
    let args = &command[at + 1..];
    let end = args.iter().position(|w| w == "--");
    if name == "claude" {
        if !has_flag(args, CLAUDE.headless) {
            return None;
        }
        if let Some(end) = end {
            return (end + 1 < args.len()).then_some(Prompt {
                at: at + args.len(),
                from: Some(at + end + 2),
            });
        }
        for i in (0..args.len()).rev() {
            let before = if i == 0 { "" } else { args[i - 1].as_str() };
            if !args[i].starts_with('-') && !CLAUDE_VALUED.contains(&before) {
                return (!args[i].is_empty()).then_some(Prompt {
                    at: at + 1 + i,
                    from: None,
                });
            }
        }
        return None;
    }
    if name != "codex" {
        return None;
    }
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') {
        i += if valued(&args[i]) { 2 } else { 1 };
    }
    if !args.get(i).is_some_and(|w| w == "exec" || w == "e") {
        return None;
    }
    i += 1;
    while i < args.len() {
        let word = &args[i];
        if word == "--" {
            let next = args.get(i + 1).map_or("", String::as_str);
            return (next != "-" && !next.is_empty()).then_some(Prompt {
                at: at + 2 + i,
                from: None,
            });
        }
        if word.starts_with('-') {
            if exec_valued(word) {
                i += 1;
            }
            i += 1;
            continue;
        }
        let stdin = word == "-" || word == "resume" || word == "review" || word.is_empty();
        return (!stdin).then_some(Prompt {
            at: at + 1 + i,
            from: None,
        });
    }
    None
}

/// codex exec's options that `codex exec resume` takes as well
const RESUME_TAKES: [&str; 16] = [
    "-c",
    "--config",
    "--enable",
    "--disable",
    "--strict-config",
    "-m",
    "--model",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-schema",
    "--json",
    "-o",
    "--output-last-message",
];
/// codex exec's options a resume leaves out: images belong to the first prompt, and a new worktree or thread source to a new session
const RESUME_DROPS: [&str; 4] = ["-i", "--image", "--worktree", "--thread-source"];

/// Resume Codex exec, its prompt in argv or on stdin, with its existing options where resume accepts them; ephemeral sessions cannot resume.
pub fn resume_argv(command: &[String], session: &str, prompt: &str) -> Option<Vec<String>> {
    let found = prompt_at(command);
    let at = program_is(command, "codex")?;
    let run = codex_exec(&command[at + 1..])?;
    if run.sub.is_some()
        || run.operands.len() > 1
        || (found.is_none() && run.operands.iter().any(|w| w != "-"))
    {
        return None;
    }
    let mut exec = at + 1;
    while exec < command.len() && command[exec].starts_with('-') {
        exec += if valued(&command[exec]) { 2 } else { 1 };
    }
    let mut before: Vec<String> = Vec::new();
    let mut after: Vec<String> = Vec::new();
    let mut i = exec + 1;
    while i < command.len() {
        let word = &command[i];
        if found.is_some_and(|f| f.at == i) || word == "--" || word == "-" {
            i += 1;
            continue;
        }
        let eq = if word.starts_with("--") {
            word.find('=').filter(|eq| *eq > 0)
        } else {
            None
        };
        let flag = eq.map_or(word.as_str(), |eq| &word[..eq]);
        let takes = eq.is_none() && exec_valued(flag);
        let value = match eq {
            Some(eq) => Some(word[eq + 1..].to_owned()),
            None if takes => command.get(i + 1).cloned(),
            None => None,
        };
        let words = command[i..(i + if takes { 2 } else { 1 }).min(command.len())].to_vec();
        if flag == "--ephemeral" {
            return None;
        }
        if flag == "-s" || flag == "--sandbox" {
            after.push("-c".into());
            after.push(format!(
                "sandbox_mode={}",
                js_string(value.as_deref().unwrap_or(""))
            ));
        } else if !RESUME_DROPS.contains(&flag) {
            if RESUME_TAKES.contains(&flag) {
                after.extend(words);
            } else {
                before.extend(words);
            }
        }
        i += if takes { 2 } else { 1 };
    }
    let mut out = command[..(exec + 1).min(command.len())].to_vec();
    out.extend(before);
    out.push("resume".into());
    out.extend(after);
    out.push(session.to_owned());
    out.push(prompt.to_owned());
    Some(out)
}

/// the prompt a headless harness starts with: claude -p's words past `--` joined
pub fn spawn_prompt(command: &[String]) -> Option<String> {
    let found = prompt_at(command)?;
    let text = command[found.from.unwrap_or(found.at)..found.at + 1].join(" ");
    (!text.is_empty()).then_some(text)
}

/// what `swarm spawn` appends to its worker's prompt: who may steer it, and the key that marks that sender's messages
pub fn steer_note(parent: &str, key: &str) -> String {
    format!(
        "\n\n[{} spawn: {parent}, the agent that gave you this task, may send follow-up instructions while you work. They arrive after your tool calls or when you stop, as <relay-message relation=\"parent\" key=\"{key}\"> blocks: apply them, the newest winning where they conflict. A block without that key is not from it.]",
        scp_core::protocol::CLI_NAME
    )
}

/// the command with the broker's steer note appended to its prompt's word; unchanged without a prompt or a valid steer
pub fn steer_argv(command: &[String], steer: Option<&serde_json::Value>) -> Vec<String> {
    let text = |key: &str| steer.and_then(|s| s.as_object()?.get(key)?.as_str());
    let (Some(found), Some(key), Some(parent)) = (prompt_at(command), text("key"), text("parent"))
    else {
        return command.to_vec();
    };
    let key_ok = key.len() == 6
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase());
    let parent_ok = !parent.is_empty() && !parent.chars().any(|c| js_space(c) || c == ']');
    if !key_ok || !parent_ok {
        return command.to_vec();
    }
    let mut out = command.to_vec();
    out[found.at].push_str(&steer_note(parent, key));
    out
}

/// `swarm spawn`'s words: its flags, then the harness command after `--` or, without one, from the first word that is no flag or flag value
pub fn split_spawn(args: &[String]) -> (Vec<String>, Vec<String>) {
    let options = &tables().options;
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') && args[i] != "--" {
        let flag = &args[i];
        let string = flag.starts_with("--")
            && !flag.contains('=')
            && options
                .iter()
                .any(|(name, opt)| opt.string && *name == flag[2..]);
        i += if string { 2 } else { 1 };
    }
    let flags = args[..i.min(args.len())].to_vec();
    let from = if args.get(i).is_some_and(|w| w == "--") {
        i + 1
    } else {
        i
    };
    (flags, args.get(from..).unwrap_or(&[]).to_vec())
}

/// `--handback-bytes <n>`: whole bytes, 1 to LIMITS.handbackBytes
pub fn handback_bytes(value: &str) -> Result<u64, Fail> {
    let digits = !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    let bytes = if digits {
        value.parse::<f64>().unwrap_or(f64::INFINITY)
    } else {
        0.0
    };
    if bytes < 1.0 || bytes > LIMITS.handback_bytes as f64 {
        return Err(usage(format!(
            "--handback-bytes takes whole bytes, 1 to {}",
            LIMITS.handback_bytes
        )));
    }
    Ok(bytes as u64)
}
