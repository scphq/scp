//! `swarm claude`: Claude Code with the scp channel loaded, in the foreground, in the background (`claude --bg`) with an scp mount that
//! claims its name and grant, or attached to a background session.

use super::bg_cmd::backgrounded;
use super::bg_io::LAUNCHER_IDENTITY;
use super::bg_state::{bg_dir, private_dir};
use crate::fleet::json::Json;
use crate::fleet::mounts::{entry_argv, gone_command, mcp_file, mounted_entry};
use crate::fleet::view::text;
use crate::launch::attribute::{
    Attribution, Placement, attribute, attributed, options_before, under_text, validate_under,
};
use crate::open::{block_on, errno_words, node_fs_error};
use crate::spawn::argv::{mcp_mount, mcp_words, mount_vars, pin_mode, which_on_path};
use crate::spawn::signals::Listener;
use crate::{Call, Done, Fail, route, term, usage};
use scp_core::address::valid_handle;
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::CallError;
use scp_mcp::identity::{derive_handle, safe_cwd};
use scp_mcp::membership::manual_join;
use scp_mcp::ps::{Env, basename, join};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;

pub const CHANNEL_FLAGS: [&str; 2] = ["--dangerously-load-development-channels", "server:scp"];
/// where the shim finds the broker and its labels, passed on since a background session's environment is the daemon's
const SHIM_VARS: [&str; 3] = ["SCP_LABELS", "SCP_DIR", "XDG_STATE_HOME"];
/// the words of Claude Code's `swarm mcp` mount
const CLAUDE_MCP: [&str; 3] = ["--harness", "claude", "--channels"];
const CLAUDE_SESSION_ENV: [&str; 8] = [
    "CLAUDE_BG_SOURCE",
    "CLAUDE_CODE_SESSION_KIND",
    "CLAUDE_CODE_IS_COWORK",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_WORKSPACE_HOST_PATHS",
];
const CHANNELS_ENV: &str = "SCP_CHANNELS";
const AGENTS_TIMEOUT_MS: u64 = 15_000;
const AGENTS_MAX_BUFFER: usize = 1024 * 1024;

fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|w| (*w).to_owned()).collect()
}

fn set<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    env.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

/// `swarm claude [--bg] [--name N | --as N] [--root] [--under ADDR] [--] [claude args...]`
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ClaudeArgv {
    pub name: Option<String>,
    pub bg: bool,
    pub root: bool,
    pub under: Option<String>,
    pub args: Vec<String>,
}

/// the handle, whether it runs in the background or as a root, and the arguments passed through to claude
pub fn claude_argv(argv: &[String]) -> Result<ClaudeArgv, Fail> {
    let mut parsed = ClaudeArgv::default();
    let mut i = 0;
    while let Some(arg) = argv.get(i) {
        if arg == "--bg" || arg == "--background" {
            parsed.bg = true;
            i += 1;
        } else if arg == "--under" || arg.starts_with("--under=") {
            let under = if arg == "--under" {
                i += 1;
                argv.get(i).cloned()
            } else {
                Some(arg["--under=".len()..].to_owned())
            };
            parsed.under = Some(under.ok_or_else(|| usage("--under takes an address"))?);
            i += 1;
        } else if arg == "--root" {
            parsed.root = true;
            i += 1;
        } else if arg == "--name" || arg == "--as" {
            let Some(name) = argv.get(i + 1) else {
                return Err(usage(format!("{CLI_NAME} claude {arg} takes a handle")));
            };
            parsed.name = Some(name.clone());
            i += 2;
        } else if arg.starts_with("--name=") || arg.starts_with("--as=") {
            parsed.name = Some(arg[arg.find('=').unwrap_or(0) + 1..].to_owned());
            i += 1;
        } else {
            break;
        }
    }
    if argv.get(i).is_some_and(|arg| arg == "--") {
        i += 1;
    }
    validate_under(parsed.under.as_deref(), parsed.root)?;
    if let Some(name) = parsed.name.take() {
        let name = name.strip_prefix("me/").map_or(name.clone(), str::to_owned);
        if !valid_handle(&name) {
            return Err(usage(format!(
                "--name {} is not a valid agent handle",
                crate::args::js_string(&name)
            )));
        }
        parsed.name = Some(name);
    }
    parsed.args = argv[i.min(argv.len())..].to_vec();
    if !parsed.bg {
        parsed.bg = options_before(&parsed.args)
            .iter()
            .any(|arg| arg == "--bg" || arg == "--background");
    }
    Ok(parsed)
}

/// `added` placed before any `--`, after the user's own arguments so a variadic option of ours never takes their prompt
fn before_dashes(args: &[String], added: Vec<String>) -> Vec<String> {
    let at = options_before(args).len();
    let mut out = args[..at].to_vec();
    out.extend(added);
    out.extend_from_slice(&args[at..]);
    out
}

/// claude's arguments with the scp channel and what SCP adds placed before any `--`
pub fn claude_launch_args(args: &[String], added: Vec<String>) -> Vec<String> {
    let loaded = format!("{}=server:scp", CHANNEL_FLAGS[0]);
    let has = options_before(args)
        .iter()
        .any(|arg| arg == "server:scp" || *arg == loaded);
    let mut all = if has {
        Vec::new()
    } else {
        words(&CHANNEL_FLAGS)
    };
    all.extend(added);
    before_dashes(args, all)
}

/// `vars` as an object: an array's items under their indexes, as spreading it gives them
fn as_object(vars: &Json) -> Json {
    match vars {
        Json::Arr(items) => Json::Obj(
            items
                .iter()
                .enumerate()
                .map(|(at, item)| (at.to_string(), item.clone()))
                .collect(),
        ),
        Json::Obj(_) => vars.clone(),
        _ => Json::Obj(Vec::new()),
    }
}

/// The scp server of a background session: the user's mount with `--channels`, else this CLI's (`launch`), with the name, parent
/// request and grant in its env, and the session a resume continues as `SCP_HARNESS_ORIGIN`. Under SCP_NATIVE=1 it runs the native
/// `swarm mcp` directly, with the user's mount's words when it has `--channels`, as it does through Node when the mount's command is
/// gone. It has the mount's name, so it replaces the mount for that session; the grant is set even when empty, so one in the daemon's
/// environment never applies
pub fn bg_mount(env: &Env, name: Option<&str>, origin: Option<&str>, launch: &[String]) -> Json {
    let entry = mounted_entry("claude", &mcp_file("claude", env))
        .ok()
        .flatten();
    let mounted = entry
        .as_ref()
        .map(|entry| entry_argv("claude", entry))
        .unwrap_or_default();
    let channels = mounted.iter().any(|word| word == "--channels");
    let words_of = if channels {
        mcp_words(&mounted, &words(&CLAUDE_MCP))
    } else {
        words(&CLAUDE_MCP)
    };
    let fresh = mcp_mount(launch, &words_of, env);
    let repaired = channels && gone_command(&mounted[0]);
    let argv = if fresh.native || !channels || repaired {
        fresh.argv.clone()
    } else {
        mounted
    };
    let base = match entry.as_ref().and_then(|entry| entry.get("env")) {
        Some(vars @ (Json::Obj(_) | Json::Arr(_))) => as_object(vars),
        _ => Json::Obj(Vec::new()),
    };
    let mut vars = if fresh.native || repaired {
        mount_vars(&base, &fresh)
    } else {
        pin_mode(&base, env)
    };
    for key in SHIM_VARS {
        if let Some(value) = set(env, key) {
            vars.set(key, Json::str(value));
        }
    }
    if let Some(name) = name {
        vars.set("SCP_NAME", Json::str(name));
    }
    let given = |key: &str| Json::str(env.get(key).map_or("", String::as_str));
    vars.set("SCP_UNDER", given("SCP_UNDER"));
    vars.set("SCP_GRANT", given("SCP_GRANT"));
    if let Some(origin) = origin {
        vars.set("SCP_HARNESS_ORIGIN", Json::str(origin));
    }
    Json::object(vec![
        ("type", Json::str("stdio")),
        ("command", Json::str(argv[0].as_str())),
        (
            "args",
            Json::Arr(argv[1..].iter().map(|w| Json::str(w.as_str())).collect()),
        ),
        ("env", vars),
    ])
}

fn strict_hint() -> String {
    format!(
        "{CLI_NAME} claude: --strict-mcp-config without --mcp-config drops the scp mount, so messages cannot wake this session"
    )
}

/// whether claude will mount an MCP server named scp from somewhere this launcher cannot see: a config passed on the command line
fn external_mcp(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "--mcp-config" || arg.starts_with("--mcp-config="))
}

/// without --name, the line that asks the session to name itself, unless it does not join at start or the arguments set a system prompt
pub fn name_prompt(name: Option<&str>, args: &[String], env: &Env, cwd: &str) -> Vec<String> {
    let prompted = args
        .iter()
        .any(|arg| arg.starts_with("--system-prompt") || arg.starts_with("--append-system-prompt"));
    if name.is_some() || manual_join(env) || prompted {
        return Vec::new();
    }
    let handle =
        set(env, "SCP_NAME").map_or_else(|| derive_handle("claude-code", cwd), str::to_owned);
    vec![
        "--append-system-prompt".into(),
        format!(
            "You are on the SCP network as {handle}. Pick a short descriptive name for yourself with `{CLI_NAME} name <name>` when you know what you're working on."
        ),
    ]
}

/// `config.projects[cwd].mcpServers.scp` of Claude Code's user config, when it is an object (or array)
fn local_entry(file: &str, cwd: &str) -> Result<Option<Json>, ()> {
    if std::fs::metadata(file).is_err() {
        return Ok(None);
    }
    let bytes = std::fs::read(file).map_err(|_| ())?;
    let config = Json::parse(String::from_utf8_lossy(&bytes).as_bytes()).ok_or(())?;
    let local = config
        .get("projects")
        .and_then(|projects| projects.get(cwd))
        .and_then(|project| project.get("mcpServers"))
        .and_then(|servers| servers.get("scp"));
    Ok(local
        .filter(|entry| matches!(entry, Json::Obj(_) | Json::Arr(_)))
        .cloned())
}

fn entry_command(entry: &Json) -> Option<&Json> {
    entry.get("command")
}

/// why Claude Code's scp mount cannot wake this session, with the fix, else None; user, local and project scopes count
pub fn mount_hint(env: &Env, cwd: &str) -> Option<String> {
    let file = mcp_file("claude", env);
    let mut entries: Vec<Json> = Vec::new();
    let read = mounted_entry("claude", &file).and_then(|user| {
        entries.extend(user);
        local_entry(&file, cwd)
    });
    match read {
        Ok(local) => entries.extend(local),
        Err(()) => {
            return Some(format!(
                "{CLI_NAME} claude: {file} is unreadable, so the scp mount is unchecked; fix it or run {CLI_NAME} setup --write"
            ));
        }
    }
    let project = join(&[cwd, ".mcp.json"]);
    if std::fs::metadata(&project).is_ok()
        && let Ok(Some(entry)) = mounted_entry("claude", &project)
    {
        entries.push(entry);
    }
    if entries.is_empty() {
        return Some(format!(
            "{CLI_NAME} claude: Claude Code has no scp MCP mount, so messages cannot wake this session; run {CLI_NAME} setup --write"
        ));
    }
    let channels: Vec<&Json> = entries
        .iter()
        .filter(|entry| {
            entry_argv("claude", entry)
                .iter()
                .any(|w| w == "--channels")
        })
        .collect();
    if channels.is_empty() {
        return Some(format!(
            "{CLI_NAME} claude: the scp mount lacks --channels, so messages cannot wake this session; run {CLI_NAME} setup --write"
        ));
    }
    let gone = |entry: &&Json| {
        entry_command(entry)
            .and_then(Json::as_str)
            .is_some_and(gone_command)
    };
    if channels.iter().all(gone) {
        return Some(format!(
            "{CLI_NAME} claude: the scp mount runs {}, which is gone (moved by an upgrade?); run {CLI_NAME} setup --write",
            text(entry_command(channels[0]))
        ));
    }
    None
}

/// the short id `claude --bg` prints for a session: eight lowercase hex digits
fn short_id(text: &str) -> bool {
    text.len() == 8
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// a session id, any case
fn session_id(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `bin args` as `spawnSync` runs it, with stdin closed and stderr dropped: its stdout whatever its exit, what it printed before the
/// timeout's SIGTERM, or the first `max` bytes once it printed more, which ends it too
fn stdout_of(bin: &str, args: &[&str], env: &Env, timeout_ms: u64, max: usize) -> Option<String> {
    let mut child = std::process::Command::new(bin)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut pipe = child.stdout.take()?;
    let kept = Arc::new(Mutex::new(Vec::new()));
    let (tx, ended) = std::sync::mpsc::channel();
    let shared = kept.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 65536];
        let mut over = false;
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let mut out = shared
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let room = max.saturating_sub(out.len());
            out.extend_from_slice(&chunk[..n.min(room)]);
            if n > room {
                over = true;
                break;
            }
        }
        let _ = tx.send(over);
    });
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let over = ended
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok();
    loop {
        match child.try_wait() {
            Ok(None) if over == Some(true) || Instant::now() >= deadline => {
                // SAFETY: signals the child it started and has not reaped
                unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
            _ => break,
        }
    }
    if over.is_none() {
        let _ = ended.recv_timeout(Duration::from_millis(100));
    }
    let out = kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// claude's live background sessions, from `claude agents --json`
fn live_agents(bin: &str, env: &Env) -> Vec<Json> {
    let Some(listed) = stdout_of(
        bin,
        &["agents", "--json"],
        env,
        AGENTS_TIMEOUT_MS,
        AGENTS_MAX_BUFFER,
    ) else {
        return Vec::new();
    };
    match Json::parse(listed.as_bytes()) {
        Some(Json::Arr(agents)) => agents
            .into_iter()
            .filter(|agent| {
                agent.get("id").and_then(Json::as_str).is_some()
                    && agent.get("state").and_then(Json::as_str) != Some("failed")
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn field<'a>(agent: &'a Json, key: &str) -> Option<&'a str> {
    agent.get(key).and_then(Json::as_str)
}

/// the name, grant and parent request the scp mount of the background session `--resume` names ran with, from `<short id>.json`: a
/// resumed session, or a fork of it under a new id, claims them again rather than the caller's
fn prior_mount(args: &[String], env: &Env) -> Option<[(&'static str, String); 3]> {
    let target = resume_target(args)?;
    let short = target.get(..8).filter(|short| short_id(short))?;
    let bytes = std::fs::read(bg_dir(env).join(format!("{short}.json"))).ok()?;
    let config = Json::parse(String::from_utf8_lossy(&bytes).as_bytes())?;
    let vars = config.get("mcpServers")?.get("scp")?.get_any("env")?;
    let of = |key: &str| {
        vars.get(key)
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_owned()
    };
    Some([
        ("SCP_NAME", of("SCP_NAME")),
        ("SCP_GRANT", of("SCP_GRANT")),
        ("SCP_UNDER", of("SCP_UNDER")),
    ])
}

trait AnyGet {
    /// a field that is an object or an array
    fn get_any(&self, key: &str) -> Option<&Json>;
}

impl AnyGet for Json {
    fn get_any(&self, key: &str) -> Option<&Json> {
        self.get(key)
            .filter(|value| matches!(value, Json::Obj(_) | Json::Arr(_)))
    }
}

/// whether claude's options resume or continue a stored session
pub fn resumes(args: &[String]) -> bool {
    options_before(args).iter().any(|arg| {
        ["-c", "--continue", "-r", "--resume", "--from-pr"].contains(&arg.as_str())
            || arg.starts_with("--resume=")
    })
}

/// the session `--resume`/`-r` names among claude's options
pub fn resume_target(args: &[String]) -> Option<String> {
    let options = options_before(args);
    for (i, arg) in options.iter().enumerate() {
        if let Some(target) = arg.strip_prefix("--resume=") {
            return Some(target.to_owned());
        }
        if (arg == "--resume" || arg == "-r")
            && let Some(next) = options
                .get(i + 1)
                .filter(|next| !next.is_empty() && !next.starts_with('-'))
        {
            return Some(next.clone());
        }
    }
    None
}

/// the session id `--resume` names, by id or `<id>.jsonl` transcript path: Claude Code may resume a background session under a new id,
/// whose claims then carry it as their origin
pub fn resumed_session(args: &[String]) -> Option<String> {
    let target = resume_target(args)?;
    let base = basename(&target);
    let id = base.strip_suffix(".jsonl").unwrap_or(base);
    session_id(id).then(|| id.to_owned())
}

/// `128 + n` for the signals Node numbers here, else 129
fn signal_code(signal: i32) -> i32 {
    128 + match signal {
        libc::SIGHUP | libc::SIGINT | libc::SIGKILL | libc::SIGTERM => signal,
        _ => 1,
    }
}

/// runs claude with the terminal passed through, its stdout also kept when `pipe`; its exit code and what it printed
fn run_claude(
    bin: &str,
    args: &[String],
    env: &Env,
    cwd: &str,
    pipe: bool,
) -> Result<(i32, Vec<u8>), Fail> {
    let mut command = tokio::process::Command::new(bin);
    command
        .args(args)
        .env_clear()
        .envs(env)
        .current_dir(cwd)
        .stdin(Stdio::inherit())
        .stdout(if pipe {
            Stdio::piped()
        } else {
            Stdio::inherit()
        })
        .stderr(Stdio::inherit());
    // SAFETY: only async-signal-safe calls between fork and exec
    unsafe {
        command.as_std_mut().pre_exec(|| {
            for signal in 1..32 {
                if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                    libc::signal(signal, libc::SIG_DFL);
                }
            }
            Ok(())
        });
    }
    block_on(async move {
        let mut signals = Listener::new(&[libc::SIGINT, libc::SIGTERM, libc::SIGHUP]);
        let mut child = command.spawn().map_err(|error| {
            let code =
                errno_words(&error).map_or_else(|| error.to_string(), |(code, _)| code.to_owned());
            Fail::Call(CallError::Io(format!("spawn {bin} {code}")))
        })?;
        let pid = child.id().map_or(0, |pid| pid as i32);
        let mut out = child.stdout.take();
        let (tee, chunks) = std::sync::mpsc::channel::<Vec<u8>>();
        let writer = out.is_some().then(|| {
            std::thread::spawn(move || {
                for chunk in chunks {
                    term::print_bytes(&chunk);
                }
            })
        });
        let mut printed = Vec::new();
        let mut chunk = vec![0u8; 65536];
        let mut status = None;
        while status.is_none() || out.is_some() {
            tokio::select! {
                read = async { out.as_mut().unwrap().read(&mut chunk).await }, if out.is_some() => match read {
                    Ok(n) if n > 0 => {
                        let _ = tee.send(chunk[..n].to_vec());
                        printed.extend_from_slice(&chunk[..n]);
                    }
                    _ => out = None,
                },
                done = child.wait(), if status.is_none() => status = Some(done),
                signal = signals.recv() => {
                    if signal != libc::SIGINT && status.is_none() {
                        // SAFETY: signals the child it started and has not reaped
                        unsafe { libc::kill(pid, signal) };
                    }
                }
            }
        }
        drop(tee);
        if let Some(writer) = writer {
            let _ = writer.join();
        }
        let code = match status {
            Some(Ok(status)) => status
                .code()
                .unwrap_or_else(|| status.signal().map_or(1, signal_code)),
            _ => 1,
        };
        Ok((code, printed))
    })?
}

fn io_fail(error: &std::io::Error, syscall: &str, path: &Path) -> Fail {
    Fail::Call(CallError::Io(node_fs_error(
        error,
        syscall,
        &path.to_string_lossy(),
    )))
}

/// writes `text` to `path` as `writeFileSync(path, text, { mode: 0o600 })` does: a new file gets the mode, a link is followed
fn write_file(path: &Path, text: &str) -> Result<(), Fail> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| io_fail(&error, "open", path))?;
    file.write_all(text.as_bytes())
        .map_err(|error| io_fail(&error, "write", path))
}

fn without(env: &Env, keys: &[&str]) -> Env {
    env.iter()
        .filter(|(key, _)| !keys.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// what a launch shares across its steps
struct Launch<'a> {
    bin: String,
    cwd: String,
    /// this CLI as the words a fresh mount runs
    words: Vec<String>,
    call: &'a Call<'a>,
}

impl Launch<'_> {
    /// `swarm claude --bg`: claude in the background with an scp mount that claims the name and the caller's grant, since the session's
    /// env is the daemon's
    fn background(
        &self,
        name: Option<&str>,
        args: &[String],
        env: &Env,
        attribution: Option<&Attribution>,
    ) -> Done {
        let handle = name.or_else(|| set(env, "SCP_NAME")).map(str::to_owned);
        let dir = bg_dir(env);
        private_dir(&dir).map_err(|message| Fail::Call(CallError::Io(message)))?;
        let random: [u8; 8] = rand::random();
        let file = dir.join(format!(
            "{}.json",
            random
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ));
        let origin = resumed_session(args);
        let mount = bg_mount(env, handle.as_deref(), origin.as_deref(), &self.words);
        let record = Json::object(vec![("mcpServers", Json::object(vec![("scp", mount)]))]);
        write_file(&file, &format!("{}\n", record.pretty()))?;
        let options = options_before(args);
        let mut added = Vec::new();
        if !options
            .iter()
            .any(|arg| arg == "--bg" || arg == "--background")
        {
            added.push("--bg".to_owned());
        }
        let named = options
            .iter()
            .any(|arg| arg == "-n" || arg == "--name" || arg.starts_with("--name="));
        if let Some(handle) = handle.as_ref().filter(|_| !named) {
            added.extend(["--name".to_owned(), handle.clone()]);
        }
        added.extend(name_prompt(handle.as_deref(), args, env, &self.cwd));
        added.extend([
            "--mcp-config".to_owned(),
            file.to_string_lossy().into_owned(),
        ]);
        let clean = without(env, &LAUNCHER_IDENTITY);
        let (code, printed) = run_claude(
            &self.bin,
            &before_dashes(args, added),
            &clean,
            &self.cwd,
            true,
        )?;
        let printed = String::from_utf8_lossy(&printed);
        let Some(id) = backgrounded(&printed) else {
            std::fs::remove_file(&file).map_err(|error| io_fail(&error, "unlink", &file))?;
            return Ok(if code == 0 { 1 } else { code });
        };
        let link = dir.join(format!("{id}.json"));
        let _ = std::fs::remove_file(&link);
        let target = file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        std::os::unix::fs::symlink(&target, &link).map_err(|error| {
            let words = errno_words(&error).map(|(code, words)| {
                format!(
                    "{code}: {words}, symlink '{target}' -> '{}'",
                    link.display()
                )
            });
            Fail::Call(CallError::Io(words.unwrap_or_else(|| error.to_string())))
        })?;
        let address = format!(
            "me/{}",
            handle.unwrap_or_else(|| derive_handle("claude-code", &self.cwd))
        );
        term::out(&format!(
            "{CLI_NAME} claude: background session {id} is {address} on SCP{}; messages wake it through its inbox. {CLI_NAME} claude attach {id} opens it",
            under_text(attribution)
        ));
        Ok(code)
    }

    /// `swarm claude attach <id|name> [--name N]`: `claude attach`, renaming the session's endpoint first
    fn attach(&self, argv: &[String], env: &Env) -> Done {
        let mut target: Option<&String> = None;
        let mut rename: Option<String> = None;
        let mut i = 0;
        while let Some(arg) = argv.get(i) {
            if arg == "--name" || arg == "--as" {
                i += 1;
                let Some(name) = argv.get(i) else {
                    return Err(usage(format!(
                        "{CLI_NAME} claude attach {arg} takes a handle"
                    )));
                };
                rename = Some(name.clone());
            } else if arg.starts_with("--name=") || arg.starts_with("--as=") {
                rename = Some(arg[arg.find('=').unwrap_or(0) + 1..].to_owned());
            } else if target.is_none() {
                target = Some(arg);
            } else {
                return Err(usage(format!(
                    "{CLI_NAME} claude attach takes one session: <id|name> [--name N]"
                )));
            }
            i += 1;
        }
        let Some(target) = target else {
            return Err(usage(format!(
                "{CLI_NAME} claude attach takes a background session: <id|name> [--name N]"
            )));
        };
        if let Some(rename) = rename {
            let rename = rename
                .strip_prefix("me/")
                .map_or(rename.clone(), str::to_owned);
            if !valid_handle(&rename) {
                return Err(usage(format!(
                    "--name {} is not a valid agent handle",
                    crate::args::js_string(&rename)
                )));
            }
            self.rename_background(target, &rename, env)?;
        }
        let attach = ["attach".to_owned(), target.clone()];
        Ok(run_claude(&self.bin, &attach, env, &self.cwd, false)?.0)
    }

    /// renames the endpoint of the background session `target` (its short id, or its name) to `to`, and the name its scp mount claims
    /// on resume
    fn rename_background(&self, target: &str, to: &str, env: &Env) -> Result<(), Fail> {
        let short = short_id(target);
        let id = if short {
            Some(target.to_owned())
        } else {
            live_agents(&self.bin, env)
                .into_iter()
                .find(|agent| {
                    field(agent, "name") == Some(target)
                        || field(agent, "sessionId") == Some(target)
                })
                .and_then(|agent| field(&agent, "id").map(str::to_owned))
        };
        let link = id.map(|id| bg_dir(env).join(format!("{id}.json")));
        let mut config = link
            .as_ref()
            .and_then(|link| std::fs::read(link).ok())
            .and_then(|bytes| Json::parse(String::from_utf8_lossy(&bytes).as_bytes()));
        let vars = config
            .as_ref()
            .and_then(|config| config.get("mcpServers"))
            .and_then(|servers| servers.get("scp"))
            .and_then(|scp| scp.get("env"))
            .filter(|vars| crate::fleet::view::truthy(Some(vars)));
        let from = match vars.and_then(|vars| vars.get("SCP_NAME")) {
            Some(Json::Null) | None => (!short).then(|| target.to_owned()),
            Some(name) => Some(text(Some(name))),
        };
        let (Some(link), true, Some(from)) = (link, vars.is_some(), from) else {
            term::err(&format!(
                "{CLI_NAME} claude: {target} was not started by {CLI_NAME} claude --bg --name, so its name is unknown; run {CLI_NAME} name {to} in it"
            ));
            return Ok(());
        };
        if from == to {
            return Ok(());
        }
        let words = ["--endpoint".to_owned(), format!("me/{from}"), to.to_owned()];
        let code = crate::run_verb("name", &words, self.call.env, self.call.host)?;
        if code != 0 {
            term::err(&format!("{CLI_NAME} claude: me/{from} keeps its name"));
            return Ok(());
        }
        let Some(config) = config.as_mut() else {
            return Ok(());
        };
        set_name(config, to);
        write_file(&link, &format!("{}\n", config.pretty()))
    }
}

/// `config.mcpServers.scp.env.SCP_NAME = to`, where that env is an object
fn set_name(config: &mut Json, to: &str) {
    let Json::Obj(top) = config else { return };
    let Some((_, Json::Obj(servers))) = top.iter_mut().find(|(k, _)| k == "mcpServers") else {
        return;
    };
    let Some((_, Json::Obj(scp))) = servers.iter_mut().find(|(k, _)| k == "scp") else {
        return;
    };
    if let Some((_, vars @ Json::Obj(_))) = scp.iter_mut().find(|(k, _)| k == "env") {
        vars.set("SCP_NAME", Json::str(to));
    }
}

/// `swarm claude`: claude with the scp channel loaded and the terminal passed through, or in the background, or attached, or the
/// background sessions' `ls` and `prune`; returns its exit code
pub fn claude(call: &Call, argv: &[String]) -> Done {
    let first = argv.first().map(String::as_str);
    if matches!(first, Some("--help" | "-h")) {
        return Err(Fail::Decline("help".into()));
    }
    if matches!(first, Some("ls" | "prune")) {
        return super::bg_cmd::claude(argv, call.env, call.host);
    }
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let mut env = call.env.clone();
    route::caller_argv(&mut env);
    let bin = which_on_path("claude", &env);
    let launch = |bin: String| Launch {
        bin,
        cwd: safe_cwd(),
        words: crate::spawn::run::self_words(call, call.env),
        call,
    };
    if first == Some("attach") {
        let bin = bin.ok_or_else(|| usage("claude is not on PATH"))?;
        return launch(bin).attach(&argv[1..], &env);
    }
    let parsed = claude_argv(argv)?;
    let bin = bin.ok_or_else(|| usage("claude is not on PATH"))?;
    let launch = launch(bin);
    let args = &parsed.args;
    let placement = Placement {
        name: parsed.name.as_deref(),
        root: parsed.root,
        under: parsed.under.as_deref(),
        resume: resumes(args),
    };
    let warn = |line: &str| term::err(line);
    if parsed.bg {
        let attribution = block_on(attribute("claude", placement, call.env, &launch.cwd, &warn))??;
        let prior = if attribution.is_some() || parsed.root {
            None
        } else {
            prior_mount(args, &env)
        };
        if let Some(prior) = prior {
            let mut resumed = env.clone();
            for (key, value) in &prior {
                resumed.insert((*key).to_owned(), value.clone());
            }
            let name = parsed
                .name
                .clone()
                .or_else(|| Some(prior[0].1.clone()).filter(|n| !n.is_empty()));
            return launch.background(name.as_deref(), args, &resumed, None);
        }
        let launched = attributed(&env, attribution.as_ref());
        return launch.background(
            parsed.name.as_deref(),
            args,
            &launched,
            attribution.as_ref(),
        );
    }
    if let Some(resume) = resume_target(args) {
        let live = live_agents(&launch.bin, &env).into_iter().find(|agent| {
            field(agent, "id") == Some(resume.as_str())
                || field(agent, "sessionId") == Some(resume.as_str())
        });
        if let Some(id) = live.as_ref().and_then(|agent| field(agent, "id")) {
            term::err(&format!(
                "{CLI_NAME} claude: {resume} is a live background session, already woken through claude-inbox; attaching to it (claude attach {id})"
            ));
            let attach = ["attach".to_owned(), id.to_owned()];
            return Ok(run_claude(&launch.bin, &attach, &env, &launch.cwd, false)?.0);
        }
    }
    let external = external_mcp(args);
    let hint = if external {
        None
    } else if args.iter().any(|arg| arg == "--strict-mcp-config") {
        Some(strict_hint())
    } else {
        mount_hint(&env, &launch.cwd)
    };
    if let Some(hint) = hint {
        return Err(usage(hint));
    }
    if external {
        term::err(&format!(
            "{CLI_NAME} claude: using your --mcp-config; it needs the scp server with --channels for messages to wake this session"
        ));
    }
    let attribution = block_on(attribute("claude", placement, call.env, &launch.cwd, &warn))??;
    let launch_env = attributed(&env, attribution.as_ref());
    let added = name_prompt(parsed.name.as_deref(), args, &launch_env, &launch.cwd);
    let mut run_env = without(&launch_env, &CLAUDE_SESSION_ENV);
    if let Some(name) = &parsed.name {
        run_env.insert("SCP_NAME".into(), name.clone());
    }
    run_env.insert(CHANNELS_ENV.into(), std::process::id().to_string());
    Ok(run_claude(
        &launch.bin,
        &claude_launch_args(args, added),
        &run_env,
        &launch.cwd,
        false,
    )?
    .0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(list: &[&str]) -> Vec<String> {
        words(list)
    }

    #[test]
    fn a_leading_name_is_taken_and_everything_else_goes_to_claude() {
        assert_eq!(claude_argv(&[]).unwrap(), ClaudeArgv::default());
        let parsed = claude_argv(&w(&["--name", "lead", "-c", "--model", "opus"])).unwrap();
        assert_eq!(
            (parsed.name.as_deref(), parsed.args),
            (Some("lead"), w(&["-c", "--model", "opus"]))
        );
        let parsed = claude_argv(&w(&["--name=lead", "--", "--name", "x"])).unwrap();
        assert_eq!(
            (parsed.name.as_deref(), parsed.args),
            (Some("lead"), w(&["--name", "x"]))
        );
        assert_eq!(
            claude_argv(&w(&["--name"])),
            Err(usage(format!("{CLI_NAME} claude --name takes a handle")))
        );
        assert_eq!(
            claude_argv(&w(&["--name", "me"])),
            Err(usage("--name \"me\" is not a valid agent handle"))
        );
        let parsed =
            claude_argv(&w(&["--as", "me/lead", "--name", "x", "--model", "opus"])).unwrap();
        assert_eq!(
            (parsed.name.as_deref(), parsed.args),
            (Some("x"), w(&["--model", "opus"]))
        );
        let parsed = claude_argv(&w(&["--model", "opus", "--name", "session"])).unwrap();
        assert_eq!(
            (parsed.name, parsed.args),
            (None, w(&["--model", "opus", "--name", "session"]))
        );
    }

    #[test]
    fn bg_counts_before_the_terminator_and_under_stays_with_its_value() {
        let parsed = claude_argv(&w(&["--", "--model", "opus", "--bg"])).unwrap();
        assert!(parsed.bg);
        assert_eq!(parsed.args, w(&["--model", "opus", "--bg"]));
        let parsed = claude_argv(&w(&["--bg", "--name", "x", "--", "-p", "--", "--bg"])).unwrap();
        assert!(parsed.bg);
        assert_eq!(parsed.args, w(&["-p", "--", "--bg"]));
        assert!(!claude_argv(&w(&["--", "-p", "--", "--bg"])).unwrap().bg);
        let parsed = claude_argv(&w(&[
            "--under=me/vm/lead",
            "--bg",
            "--",
            "--resume",
            "session",
        ]))
        .unwrap();
        assert_eq!(
            (parsed.under.as_deref(), parsed.bg, parsed.args),
            (Some("me/vm/lead"), true, w(&["--resume", "session"]))
        );
        assert_eq!(
            claude_argv(&w(&["--", "--under", "prompt"])).unwrap().args,
            w(&["--under", "prompt"])
        );
        for args in [
            w(&["--root", "--under=lead"]),
            w(&["--under=lead", "--root"]),
            w(&["--under"]),
            w(&["--under=me/vm/lead/extra"]),
        ] {
            assert!(
                matches!(claude_argv(&args), Err(Fail::Usage(_))),
                "{args:?}"
            );
        }
    }

    #[test]
    fn the_channel_goes_before_any_terminator_once() {
        let flags = w(&CHANNEL_FLAGS);
        let mut want = w(&["fix the bug"]);
        want.extend(flags.clone());
        assert_eq!(claude_launch_args(&w(&["fix the bug"]), Vec::new()), want);
        let mut want = w(&["--resume", "abc"]);
        want.extend(flags.clone());
        want.extend(w(&["--", "-p"]));
        assert_eq!(
            claude_launch_args(&w(&["--resume", "abc", "--", "-p"]), Vec::new()),
            want
        );
        let own = w(&[CHANNEL_FLAGS[0], "server:mine", "server:scp"]);
        assert_eq!(claude_launch_args(&own, Vec::new()), own);
    }

    #[test]
    fn resume_targets_and_sessions() {
        assert_eq!(resume_target(&w(&["--resume=abc"])).as_deref(), Some("abc"));
        assert_eq!(resume_target(&w(&["--resume", "--model", "x"])), None);
        assert_eq!(resume_target(&w(&["--", "--resume", "abc"])), None);
        assert_eq!(resume_target(&w(&["-r", ""])), None);
        let session = "1A2B3C4D-0000-4000-8000-000000000000";
        assert_eq!(
            resumed_session(&w(&["-r", &format!("/t/{session}.jsonl")])).as_deref(),
            Some(session)
        );
        assert_eq!(resumed_session(&w(&["-r", "1a2b3c4d"])), None);
        assert!(resumes(&w(&["--from-pr"])));
        assert!(resumes(&w(&["--resume=x"])));
        assert!(!resumes(&w(&["--", "-c"])));
    }

    #[test]
    fn signals_map_as_node_numbers_them() {
        assert_eq!(signal_code(libc::SIGTERM), 143);
        assert_eq!(signal_code(libc::SIGKILL), 137);
        assert_eq!(signal_code(libc::SIGSEGV), 129);
    }
}
