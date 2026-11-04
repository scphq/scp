//! The process table: one `ps` call, the harness a process runs and the lineage of process keys.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::time::{Duration, Instant};

pub type Env = HashMap<String, String>;

/// a process's parent pid, start time (as [`ps_start`] prints it) and command line
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PsEntry {
    pub ppid: i64,
    pub start: String,
    pub args: String,
}

pub type PsCommTable = HashMap<i64, PsEntry>;
/// a process table read, shared; None when the read failed
pub type Table = Option<Rc<PsCommTable>>;

/// how long the process table read may take
pub const PS_TIMEOUT_MS: u64 = 1500;
/// a shell command's process table deadline: a heavily loaded machine's ps can take seconds
pub const SHELL_PS_TIMEOUT_MS: u64 = 5000;
/// room for the whole table: long command lines on a busy machine pass the 1 MiB default
pub const PS_MAX_BUFFER: usize = 64 * 1024 * 1024;
const DEFAULT_MAX_BUFFER: usize = 1024 * 1024;

pub const SHELLS: [&str; 5] = ["sh", "bash", "zsh", "dash", "fish"];

/// `\s` in a JS regular expression
pub(crate) fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

pub(crate) fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// `path.basename` for POSIX paths
pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(at) => &trimmed[at + 1..],
        None => trimmed,
    }
}

/// `path.dirname` for POSIX paths
pub fn dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".into();
    }
    match trimmed.rfind('/') {
        None => ".".into(),
        Some(at) => {
            let parent = trimmed[..at].trim_end_matches('/');
            if !parent.is_empty() {
                parent.into()
            } else if path.starts_with('/') {
                "/".into()
            } else {
                ".".into()
            }
        }
    }
}

/// `path.normalize` for POSIX paths
pub(crate) fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            _ => parts.push(part),
        }
    }
    let mut out = parts.join("/");
    if absolute {
        out.insert(0, '/');
    }
    if out.is_empty() {
        return if absolute { "/".into() } else { ".".into() };
    }
    if trailing && !out.ends_with('/') {
        out.push('/');
    }
    out
}

/// `path.join` for POSIX paths
pub fn join(parts: &[&str]) -> String {
    normalize(
        &parts
            .iter()
            .filter(|p| !p.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// `path.resolve(cwd, path)` with an absolute `cwd`
pub fn resolve(cwd: &str, path: &str) -> String {
    let full = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{cwd}/{path}")
    };
    let out = normalize(&full);
    if out.len() > 1 {
        out.trim_end_matches('/').to_string()
    } else {
        out
    }
}

/// a command's stdout when it exits 0, else None; a command still running at `timeout_ms` is killed and counts as failed, and output
/// past `max_buffer` bytes kills it too. `env` replaces the environment when given
pub fn capture(
    argv: &[&str],
    env: Option<&[(&str, String)]>,
    timeout_ms: Option<u64>,
    max_buffer: Option<usize>,
) -> Option<String> {
    let (program, rest) = argv.split_first()?;
    let mut command = Command::new(program);
    command
        .args(rest)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(env) = env {
        command.env_clear();
        for (key, value) in env {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().ok()?;
    let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    let max = max_buffer.unwrap_or(DEFAULT_MAX_BUFFER);
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let fd = stdout.as_raw_fd();
    let mut out = Vec::new();
    let mut chunk = vec![0u8; 65536];
    let failed = loop {
        let wait = match deadline {
            Some(at) => {
                let left = at.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break true;
                }
                left.as_millis().min(i32::MAX as u128) as i32
            }
            None => -1,
        };
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut poll, 1, wait) };
        if ready < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break true;
        }
        if ready == 0 {
            continue;
        }
        match stdout.read(&mut chunk) {
            Ok(0) => break false,
            Ok(n) => {
                out.extend_from_slice(&chunk[..n]);
                if out.len() > max {
                    break true;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break true,
        }
    };
    drop(stdout);
    if failed {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if deadline.is_some_and(|at| Instant::now() >= at) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
            Err(_) => break None,
        }
    }?;
    status
        .success()
        .then(|| String::from_utf8_lossy(&out).into_owned())
}

fn ps_path() -> String {
    std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into())
}

fn digits(text: &str) -> Option<(i64, &str)> {
    let end = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    if end == 0 {
        return None;
    }
    Some((text[..end].parse::<f64>().ok()? as i64, &text[end..]))
}

/// past at least one whitespace character
fn spaced(text: &str) -> Option<&str> {
    let rest = text.trim_start_matches(js_space);
    (rest.len() < text.len()).then_some(rest)
}

fn word(text: &str) -> Option<(&str, &str)> {
    let end = text.find(js_space).unwrap_or(text.len());
    (end > 0).then(|| (&text[..end], &text[end..]))
}

fn parse_line(line: &str) -> Option<(i64, PsEntry)> {
    if line.contains(line_end) {
        return None;
    }
    let (pid, rest) = digits(line.trim_start_matches(js_space))?;
    let (ppid, rest) = digits(spaced(rest)?)?;
    let mut rest = spaced(rest)?;
    let mut start = Vec::with_capacity(5);
    for i in 0..5 {
        let (part, after) = word(rest)?;
        start.push(part);
        rest = if i < 4 { spaced(after)? } else { after };
    }
    let args = spaced(rest)?.trim_end_matches(js_space);
    if args.is_empty() {
        return None;
    }
    Some((
        pid,
        PsEntry {
            ppid,
            start: start.join("-"),
            args: args.to_string(),
        },
    ))
}

/// the output of `ps -axo pid=,ppid=,lstart=,args=` in the C locale, where lstart is five words
pub fn parse_ps_comm_table(text: &str) -> PsCommTable {
    text.split('\n').filter_map(parse_line).collect()
}

/// one ps call for the whole process table, in the C locale; None when ps cannot run or takes over `timeout_ms`
pub fn read_ps_table(timeout_ms: u64) -> Option<PsCommTable> {
    let env = [("PATH", ps_path()), ("LC_ALL", "C".to_string())];
    capture(
        &["ps", "-ww", "-axo", "pid=,ppid=,lstart=,args="],
        Some(&env),
        Some(timeout_ms),
        Some(PS_MAX_BUFFER),
    )
    .map(|text| parse_ps_comm_table(&text))
}

/// `text.replace(/\s+/g, "-")`
fn dashed(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut gap = false;
    for c in text.chars() {
        if js_space(c) {
            if !gap {
                out.push('-');
            }
            gap = true;
        } else {
            out.push(c);
            gap = false;
        }
    }
    out
}

/// `^[A-Za-z0-9:-]{1,64}$`
pub(crate) fn key_shaped(text: &str) -> bool {
    (1..=64).contains(&text.len())
        && text
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b':' || c == b'-')
}

/// when `pid` started, as ps prints it in the C locale, with spaces as `-`
pub fn ps_start(pid: i64) -> Option<String> {
    let env = [("PATH", ps_path()), ("LC_ALL", "C".to_string())];
    let text = capture(
        &["ps", "-o", "lstart=", "-p", &pid.to_string()],
        Some(&env),
        Some(PS_TIMEOUT_MS),
        None,
    )
    .unwrap_or_default();
    let started = dashed(js_trim(&text));
    key_shaped(&started).then_some(started)
}

/// `pid:<harness pid>:<its start time>`, so a recycled pid is a new key; `pid:<harness pid>` when the start time is unknown
pub fn process_key(pid: i64, start_of: &dyn Fn(i64) -> Option<String>) -> String {
    match start_of(pid) {
        Some(started) if !started.is_empty() => format!("pid:{pid}:{started}"),
        _ => format!("pid:{pid}"),
    }
}

/// the parent pid and command name of a process
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parent {
    pub ppid: i64,
    pub comm: String,
}

pub type ParentOf = dyn Fn(i64) -> Option<Parent>;

/// the parent pid and command name of `pid`, from one ps call
pub fn ps_parent(pid: i64) -> Option<Parent> {
    let env = [("PATH", ps_path())];
    let text = capture(
        &["ps", "-o", "ppid=,comm=", "-p", &pid.to_string()],
        Some(&env),
        None,
        None,
    )?;
    let (ppid, rest) = digits(text.trim_start_matches(js_space))?;
    let comm = spaced(rest)?.trim_end_matches(js_space);
    if comm.is_empty() || comm.contains(line_end) {
        return None;
    }
    Some(Parent {
        ppid,
        comm: comm.to_string(),
    })
}

/// the harness pid behind a parent process: the parent, or the parent's parent when the parent is a shell (`sh -c`)
pub fn harness_pid(ppid: i64, parent_of: &ParentOf) -> i64 {
    if let Some(parent) = parent_of(ppid)
        && parent.ppid > 1
        && SHELLS.contains(&basename(
            parent.comm.strip_prefix('-').unwrap_or(&parent.comm),
        ))
    {
        return parent.ppid;
    }
    ppid
}

/// $SCP_HARNESS_PID when it is the parent of the harness process: `swarm agy` and `swarm grok` hold the endpoint across their per-turn
/// harness processes
pub fn launcher_pid(env: &Env, harness: &dyn Fn() -> i64, parent_of: &ParentOf) -> Option<i64> {
    let pid = js_integer(env.get("SCP_HARNESS_PID").map(String::as_str))?;
    if pid <= 1 {
        return None;
    }
    (parent_of(harness())?.ppid == pid).then_some(pid)
}

/// `Number(text)` when it is an integer (`Number(undefined)` is NaN)
pub(crate) fn js_integer(text: Option<&str>) -> Option<i64> {
    let text = js_trim(text?);
    if text.is_empty() {
        return Some(0);
    }
    let radix = |prefix: [&str; 2], radix: u32| {
        prefix
            .iter()
            .find_map(|p| text.strip_prefix(p))
            .map(|digits| {
                (!digits.is_empty() && digits.chars().all(|c| c.is_digit(radix)))
                    .then(|| u64::from_str_radix(digits, radix).ok())
                    .flatten()
            })
    };
    let value = if let Some(parsed) = radix(["0x", "0X"], 16)
        .or_else(|| radix(["0o", "0O"], 8))
        .or_else(|| radix(["0b", "0B"], 2))
    {
        parsed? as f64
    } else {
        if !text
            .bytes()
            .all(|c| c.is_ascii_digit() || b"+-.eE".contains(&c))
        {
            return None;
        }
        text.parse::<f64>().ok()?
    };
    (value.is_finite() && value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15)
        .then_some(value as i64)
}

/// process keys of `pid` and then its ancestors, nearest first, at most 16, stopping at pid 1 or a pid ps does not know
pub fn lineage(pid: i64, table: &PsCommTable) -> Vec<String> {
    let max = scp_core::protocol::LIMITS.lineage_max as usize;
    let mut keys = Vec::new();
    let mut seen = HashSet::new();
    let mut at = pid;
    while at > 1 && keys.len() < max && !seen.contains(&at) {
        let Some(entry) = table.get(&at) else { break };
        seen.insert(at);
        keys.push(if key_shaped(&entry.start) {
            format!("pid:{at}:{}", entry.start)
        } else {
            format!("pid:{at}")
        });
        at = entry.ppid;
    }
    keys
}

const PASS_THROUGH: [&str; 21] = [
    "sh",
    "bash",
    "zsh",
    "dash",
    "fish",
    "ash",
    "ksh",
    "env",
    "timeout",
    "nohup",
    "nice",
    "time",
    "stdbuf",
    "xargs",
    "script",
    "caffeinate",
    "flock",
    "sandbox-exec",
    "bwrap",
    "codex-linux-sandbox",
    "codex-linux-san",
];
const INTERPRETERS: [&str; 6] = ["node", "nodejs", "bun", "deno", "ruby", "perl"];
const RUNNERS: [&str; 3] = ["npm", "pnpm", "yarn"];
/// package runners that fetch and start an installed tool
const FETCHERS: [&str; 4] = ["npx", "bunx", "pnpx", "uvx"];
const SCRIPT_RUNNERS: [&str; 4] = ["tsx", "ts-node", "vite-node", "esno"];
/// inline code: what follows is the code and its arguments, not a program
const INLINE: [&str; 6] = ["-c", "-e", "--eval", "-p", "--print", "-"];
/// interpreter flags whose value is a file it loads first
const VALUED: [&str; 12] = [
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "-I",
    "-M",
    "-W",
    "-X",
    "-C",
    "--conditions",
    "--preload",
];
const HARNESSES: [&str; 13] = [
    "claude",
    "claude-code",
    "codex",
    "opencode",
    "opencode-ai",
    "grok",
    "grok-cli",
    "muse",
    "agy",
    "antigravity",
    "gemini",
    "gemini-cli",
    "pi-coding-agent",
];
/// harness ids by the program or package name a harness process runs as
const HARNESS_IDS: [(&str, &str); 14] = [
    ("claude", "claude-code"),
    ("claude-code", "claude-code"),
    ("codex", "codex"),
    ("opencode", "opencode"),
    ("opencode-ai", "opencode"),
    ("grok", "grok"),
    ("grok-cli", "grok"),
    ("muse", "muse"),
    ("agy", "agy"),
    ("antigravity", "agy"),
    ("gemini", "gemini"),
    ("gemini-cli", "gemini"),
    ("pi", "pi"),
    ("pi-coding-agent", "pi"),
];
/// where installed tools live: a script from one of these is a program in its own right
const INSTALLED_DIRS: [&str; 14] = [
    "node_modules",
    "site-packages",
    "dist-packages",
    ".npm",
    ".bun",
    ".cache",
    ".local",
    ".cargo",
    ".volta",
    ".nvm",
    ".pyenv",
    ".rbenv",
    "Cellar",
    "Applications",
];

/// `str.split(/\s+/)`
pub(crate) fn js_words(text: &str) -> Vec<&str> {
    let mut words = Vec::new();
    let mut start = 0;
    let mut gap = false;
    for (at, c) in text.char_indices() {
        if js_space(c) {
            if !gap {
                words.push(&text[start..at]);
                gap = true;
            }
        } else if gap {
            start = at;
            gap = false;
        }
    }
    words.push(if gap { "" } else { &text[start..] });
    words
}

/// the executable's name from a ps command line, lowercased, without a login shell's `-`
pub fn command(args: &str) -> String {
    let first = js_words(args)[0];
    basename(first.strip_prefix('-').unwrap_or(first)).to_lowercase()
}

/// a name lowercased without its extension
fn stem(name: &str) -> String {
    let lower = name.to_lowercase();
    let from = lower.rfind(line_end).map_or(0, |at| at + 1);
    match lower[from..].find('.') {
        Some(at) => lower[..from + at].to_string(),
        None => lower,
    }
}

fn harness_id(name: &str) -> Option<&'static str> {
    let stem = stem(name);
    HARNESS_IDS
        .iter()
        .find(|(key, _)| *key == stem)
        .map(|(_, id)| *id)
}

fn names_harness(words: &[&str]) -> bool {
    words.iter().any(|word| {
        !word.starts_with('-')
            && word
                .split('/')
                .any(|part| HARNESSES.contains(&stem(part).as_str()))
    })
}

fn python(name: &str) -> bool {
    name.strip_prefix("python")
        .is_some_and(|rest| rest.bytes().all(|c| c.is_ascii_digit() || c == b'.'))
}

/// the harness a command line runs: its program's name, else, for an interpreter or package runner, a later word naming one
pub fn harness_of(args: Option<&str>) -> Option<&'static str> {
    let args = args.filter(|a| !a.is_empty())?;
    let name = command(args);
    if let Some(own) = harness_id(&name) {
        return Some(own);
    }
    let n = name.as_str();
    if !INTERPRETERS.contains(&n) && !RUNNERS.contains(&n) && !FETCHERS.contains(&n) && !python(n) {
        return None;
    }
    for word in js_words(args).into_iter().skip(1) {
        if word.starts_with('-') {
            continue;
        }
        for part in word.split('/').rev() {
            if part != "pi"
                && let Some(id) = harness_id(part)
            {
                return Some(id);
            }
        }
    }
    None
}

/// whether claims may infer an unnamed harness: off with $SCP_HARNESS_DETECT=0, as the test suite runs
pub fn inferring(env: &Env) -> bool {
    env.get("SCP_HARNESS_DETECT").map(String::as_str) != Some("0")
}

/// the harness process `pid` runs, from the ps table
pub fn harness_at(pid: i64, table: Option<&PsCommTable>, env: &Env) -> Option<&'static str> {
    if !inferring(env) {
        return None;
    }
    harness_of(table.and_then(|t| t.get(&pid)).map(|e| e.args.as_str()))
}

fn installed(path: &str) -> bool {
    ["/opt/", "/usr/", "/Library/", "/nix/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
        || path.split('/').any(|part| INSTALLED_DIRS.contains(&part))
}

fn real(path: &str) -> String {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_else(|| path.to_string())
}

/// `os.tmpdir()`
fn tmpdir() -> String {
    let dir = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|d| !d.is_empty()))
        .unwrap_or_else(|| "/tmp".into());
    if dir.len() > 1 && dir.ends_with('/') {
        dir[..dir.len() - 1].to_string()
    } else {
        dir
    }
}

/// where an agent's own scripts live: this process's cwd, its git toplevel and the temp dirs, real paths
fn workspace_roots() -> &'static [String] {
    static ROOTS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    ROOTS.get_or_init(|| {
        let mut found = vec![
            crate::identity::safe_cwd(),
            tmpdir(),
            "/tmp".into(),
            "/private/tmp".into(),
            "/var/folders".into(),
            "/private/var/folders".into(),
        ];
        if let Some(top) = capture(
            &["git", "rev-parse", "--show-toplevel"],
            None,
            Some(PS_TIMEOUT_MS),
            None,
        ) {
            found.push(js_trim(&top).to_string());
        }
        let mut roots: Vec<String> = Vec::new();
        for path in found
            .into_iter()
            .filter(|p| !p.is_empty())
            .map(|p| real(&p))
        {
            if !roots.contains(&path) {
                roots.push(path);
            }
        }
        roots
    })
}

/// `^[a-z][a-z0-9+.-]*:` ignoring case
fn scheme(operand: &str) -> bool {
    let mut chars = operand.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || "+.-".contains(c)) {
            return false;
        }
    }
    false
}

/// a script operand of the agent's own: no scheme, nothing under a place tools are installed, and either relative or under this
/// process's cwd, its git toplevel or a temp dir
fn own_script(operand: Option<&str>) -> bool {
    let Some(operand) = operand else { return true };
    if operand == "-" {
        return true;
    }
    if scheme(operand) || operand.starts_with('~') || installed(operand) {
        return false;
    }
    if !operand.starts_with('/') {
        return !operand.split('/').any(|part| part == "..");
    }
    let path = real(operand);
    if installed(&path) {
        return false;
    }
    workspace_roots()
        .iter()
        .any(|root| path == *root || path.starts_with(&format!("{root}/")))
}

fn skip_flags<'a>(mut rest: &'a [&'a str]) -> &'a [&'a str] {
    while rest.first().is_some_and(|w| w.starts_with('-')) {
        rest = &rest[1..];
    }
    rest
}

/// an interpreter running a helper script: no operand under a place tools are installed and no word naming a harness
fn helper(args: &str) -> bool {
    let words = js_words(args);
    if names_harness(&words[1..]) {
        return false;
    }
    let name = command(args);
    let n = name.as_str();
    let mut rest: &[&str] = &words[1..];
    if FETCHERS.contains(&n) {
        rest = skip_flags(rest);
        return rest.first().is_some_and(|w| SCRIPT_RUNNERS.contains(w))
            && rest[1..]
                .iter()
                .all(|word| word.starts_with('-') || own_script(Some(word)));
    }
    if n == "uv" || RUNNERS.contains(&n) {
        if rest.first() != Some(&"run") {
            return false;
        }
        if n != "uv" {
            return true;
        }
        rest = skip_flags(&rest[1..]);
        let Some(first) = rest.first() else {
            return true;
        };
        let inner = rest.join(" ");
        let program = command(&inner);
        return if python(&program) || INTERPRETERS.contains(&program.as_str()) {
            helper(&inner)
        } else {
            own_script(Some(first))
        };
    }
    if !INTERPRETERS.contains(&n) && !python(n) {
        return false;
    }
    if n == "bun" && rest.first() == Some(&"x") {
        return false;
    }
    if (n == "bun" || n == "deno") && rest.first() == Some(&"run") {
        rest = &rest[1..];
        if n == "deno" {
            rest = skip_flags(rest);
        }
        if let Some(target) = rest.iter().find(|w| !w.starts_with('-'))
            && !target.contains(['/', '.'])
        {
            return false;
        }
    }
    let mut i = 0;
    while i < rest.len() {
        let word = rest[i];
        if word == "-m" {
            return false;
        }
        if INLINE.contains(&word) {
            return true;
        }
        if VALUED.contains(&word) {
            i += 1;
            if !own_script(rest.get(i).copied()) {
                return false;
            }
        } else if !word.starts_with('-') {
            return own_script(Some(word));
        }
        i += 1;
    }
    true
}

/// the lineage of `pid` up to and including its nearest harness: the first process that is not a shell, a wrapper or a helper
/// script's interpreter; with no harness above the helpers, the whole lineage; empty when there is none
pub fn harness_lineage(pid: i64, table: Option<&PsCommTable>) -> Vec<String> {
    let Some(table) = table else {
        return Vec::new();
    };
    let keys = lineage(pid, table);
    let mut first = None;
    let mut at = pid;
    for i in 0..keys.len() {
        let Some(entry) = table.get(&at) else { break };
        if !PASS_THROUGH.contains(&command(&entry.args).as_str()) {
            if !helper(&entry.args) {
                return keys[..=i].to_vec();
            }
            first.get_or_insert(i);
        }
        at = entry.ppid;
    }
    if first.is_none() { Vec::new() } else { keys }
}

/// the harness a session T3 Code runs claims, whatever provider runs it
pub const T3CODE: &str = "t3code";
/// the originator T3 Code sets in the environment of the codex app-server it starts
pub const T3_ORIGINATOR: &str = "T3 Code";

/// whether a command line is a T3 Code server: the t3 CLI (its native build too) or the desktop app
pub fn t3_process(args: Option<&str>) -> bool {
    let Some(args) = args.filter(|a| !a.is_empty()) else {
        return false;
    };
    if args
        .match_indices("T3 Code.app/")
        .any(|(at, _)| at == 0 || args[..at].ends_with('/'))
    {
        return true;
    }
    let name = command(args);
    name == "t3" || name == "t3code"
}

/// whether T3 Code runs the harness process `pid`: its codex app-server carries T3 Code's originator, and the server is the harness's
/// parent
pub fn t3_hosted(env: &Env, pid: i64, table: &dyn Fn() -> Table) -> bool {
    if env
        .get("CODEX_INTERNAL_ORIGINATOR_OVERRIDE")
        .map(String::as_str)
        == Some(T3_ORIGINATOR)
    {
        return true;
    }
    if !inferring(env) {
        return false;
    }
    let Some(ps) = table() else { return false };
    let Some(parent) = ps.get(&pid).map(|e| e.ppid) else {
        return false;
    };
    t3_process(ps.get(&parent).map(|e| e.args.as_str()))
}

/// codex's top-level options that take a value
pub const CODEX_VALUED: [&str; 20] = [
    "-c",
    "--config",
    "--enable",
    "--disable",
    "--remote",
    "--remote-auth-token-env",
    "-i",
    "--image",
    "-m",
    "--model",
    "--local-provider",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-C",
    "--cd",
    "--add-dir",
    "-a",
    "--ask-for-approval",
];

/// `(^|\/)codex(\.js)?$`
fn codex_binary(word: &str) -> bool {
    let base = word.strip_suffix(".js").unwrap_or(word);
    base == "codex" || base.ends_with("/codex")
}

/// a codex command line's subcommand: its first word past the binary and the options, an option value split by spaces skipped
pub fn codex_subcommand(args: &str) -> Option<String> {
    let words = js_words(args);
    let Some(binary) = words.iter().position(|w| codex_binary(w)) else {
        return words
            .iter()
            .find(|w| matches!(**w, "exec" | "e" | "app-server"))
            .map(|w| w.to_string());
    };
    let mut depth: i64 = 0;
    let mut i = binary + 1;
    while i < words.len() {
        let word = words[i];
        if depth == 0 && !word.starts_with('-') {
            return Some(word.to_string());
        }
        if depth == 0 && CODEX_VALUED.contains(&word) {
            i += 1;
        }
        for c in words.get(i).copied().unwrap_or("").chars() {
            depth += match c {
                '[' | '{' => 1,
                ']' | '}' => -1,
                _ => 0,
            };
        }
        depth = depth.max(0);
        i += 1;
    }
    None
}

/// whether a command line runs codex's `app-server` subcommand
pub fn app_server(args: Option<&str>) -> bool {
    args.is_some_and(|a| !a.is_empty() && codex_subcommand(a).as_deref() == Some("app-server"))
}

/// the desktop app's bundled codex binary that starts `args`
fn desktop_codex(args: &str) -> Option<&str> {
    if !args.starts_with('/') {
        return None;
    }
    let line = &args[..args.find('\n').unwrap_or(args.len())];
    let marker = ".app/Contents/Resources/codex-cli/";
    let ends_word = |end: usize| args[end..].chars().next().is_none_or(js_space);
    for (found, _) in line.match_indices(marker) {
        let after = found + marker.len();
        let tail = &line[after..];
        let nested = tail
            .match_indices("/codex")
            .map(|(at, _)| after + at + "/codex".len())
            .filter(|end| ends_word(*end))
            .last();
        if let Some(end) = nested {
            return Some(&args[..end]);
        }
        if tail.starts_with("codex") && ends_word(after + "codex".len()) {
            return Some(&args[..after + "codex".len()]);
        }
    }
    None
}

/// whether the codex harness process runs the desktop app's bundled CLI
pub fn codex_desktop(env: &Env, pid: i64, table: &dyn Fn() -> Table) -> bool {
    if env
        .get("CODEX_INTERNAL_ORIGINATOR_OVERRIDE")
        .map(String::as_str)
        == Some("Codex Desktop")
    {
        return true;
    }
    if !inferring(env) {
        return false;
    }
    let Some(ps) = table() else { return false };
    let Some(args) = ps.get(&pid).map(|e| e.args.as_str()) else {
        return false;
    };
    if !app_server(Some(args)) {
        return false;
    }
    let Some(binary) = desktop_codex(args) else {
        return false;
    };
    !binary
        .char_indices()
        .any(|(at, c)| js_space(c) && binary[at + c.len_utf8()..].starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(rows: &[(i64, i64, &str)]) -> PsCommTable {
        rows.iter()
            .map(|(pid, ppid, args)| {
                (
                    *pid,
                    PsEntry {
                        ppid: *ppid,
                        start: "Mon-Jan-1-00:00:00-2026".into(),
                        args: args.to_string(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn parses_ps_lines() {
        let text = "  1     0 Mon Jan  5 10:00:00 2026     /sbin/launchd\n  42  1 Tue Feb 10 09:08:07 2026 claude --resume x  \nbad line\n";
        let t = parse_ps_comm_table(text);
        assert_eq!(t.len(), 2);
        assert_eq!(
            t[&42],
            PsEntry {
                ppid: 1,
                start: "Tue-Feb-10-09:08:07-2026".into(),
                args: "claude --resume x".into()
            }
        );
        assert_eq!(t[&1].start, "Mon-Jan-5-10:00:00-2026");
    }

    #[test]
    fn reads_the_real_table() {
        let t = read_ps_table(SHELL_PS_TIMEOUT_MS).expect("ps runs");
        let own = std::process::id() as i64;
        assert!(t.contains_key(&own));
        assert!(ps_start(own).is_some_and(|s| s == t[&own].start));
        assert_eq!(ps_parent(own).map(|p| p.ppid), Some(t[&own].ppid));
    }

    #[test]
    fn paths() {
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename(""), "");
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("/"), "/");
        assert_eq!(join(&["/a/", "./b", "../c"]), "/a/c");
        assert_eq!(resolve("/x/y", "../z/"), "/x/z");
        assert_eq!(normalize("a/../.."), "..");
    }

    #[test]
    fn words_split_like_js() {
        assert_eq!(js_words(" a  b "), vec!["", "a", "b", ""]);
        assert_eq!(js_words("a"), vec!["a"]);
        assert_eq!(dashed("Mon Jan  5"), "Mon-Jan-5");
    }

    #[test]
    fn harness_of_programs() {
        assert_eq!(
            harness_of(Some("/usr/local/bin/claude --x")),
            Some("claude-code")
        );
        assert_eq!(
            harness_of(Some("node /opt/codex/bin/codex.js exec")),
            Some("codex")
        );
        assert_eq!(harness_of(Some("node /x/pi")), None);
        assert_eq!(harness_of(Some("bash -c x")), None);
        assert_eq!(harness_of(Some("-zsh")), None);
        assert_eq!(harness_of(Some("python3.12 -m muse")), Some("muse"));
    }

    #[test]
    fn codex_subcommands() {
        assert_eq!(
            codex_subcommand("codex -c k=[\"a\", \"b\"] app-server").as_deref(),
            Some("app-server")
        );
        assert_eq!(
            codex_subcommand("/x/codex --model m exec hi").as_deref(),
            Some("exec")
        );
        assert_eq!(
            codex_subcommand("node y app-server").as_deref(),
            Some("app-server")
        );
        assert!(app_server(Some("codex app-server")));
        let env = Env::new();
        let desktop = table(&[(
            5,
            1,
            "/Applications/Codex.app/Contents/Resources/codex-cli/codex app-server",
        )]);
        assert!(codex_desktop(&env, 5, &|| Some(Rc::new(desktop.clone()))));
        let spaced = table(&[(
            5,
            1,
            "/Applications/My Codex.app/Contents/Resources/codex-cli/codex app-server",
        )]);
        assert!(codex_desktop(&env, 5, &|| Some(Rc::new(spaced.clone()))));
        let plain = table(&[(5, 1, "/usr/local/bin/codex app-server")]);
        assert!(!codex_desktop(&env, 5, &|| Some(Rc::new(plain.clone()))));
    }

    #[test]
    fn t3() {
        assert!(t3_process(Some(
            "/Applications/T3 Code.app/Contents/MacOS/T3 Code"
        )));
        assert!(t3_process(Some("/usr/bin/t3 serve")));
        assert!(!t3_process(Some("/x/MyT3 Code.app/")));
    }

    #[test]
    fn lineage_walks() {
        let t = table(&[(30, 20, "zsh"), (20, 10, "claude"), (10, 1, "launchd")]);
        assert_eq!(lineage(30, &t).len(), 3);
        assert_eq!(harness_lineage(30, Some(&t)).len(), 2);
        let helpers = table(&[(30, 20, "node ./x.js"), (20, 1, "bash")]);
        assert_eq!(harness_lineage(30, Some(&helpers)).len(), 2);
        let none = table(&[(30, 20, "bash"), (20, 1, "zsh")]);
        assert!(harness_lineage(30, Some(&none)).is_empty());
    }

    #[test]
    fn shell_hop() {
        let parent = |pid: i64| {
            (pid == 7).then(|| Parent {
                ppid: 3,
                comm: "-zsh".into(),
            })
        };
        assert_eq!(harness_pid(7, &parent), 3);
        assert_eq!(harness_pid(8, &parent), 8);
        let mut env = Env::new();
        env.insert("SCP_HARNESS_PID".into(), "3".into());
        assert_eq!(launcher_pid(&env, &|| 7, &parent), Some(3));
        env.insert("SCP_HARNESS_PID".into(), "1".into());
        assert_eq!(launcher_pid(&env, &|| 7, &parent), None);
    }

    #[test]
    fn integers() {
        assert_eq!(js_integer(Some(" 12 ")), Some(12));
        assert_eq!(js_integer(Some("1.5")), None);
        assert_eq!(js_integer(Some("x")), None);
        assert_eq!(js_integer(Some("")), Some(0));
        assert_eq!(js_integer(Some("0x10")), Some(16));
        assert_eq!(js_integer(None), None);
    }
}
