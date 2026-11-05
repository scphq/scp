//! `swarm hooks install`: where each harness keeps its hooks, the content written there, the atomic write with its backup, and the hook
//! files setup brings up to date.

use super::hook_cmd::{
    AGY_HOOK_SET, AGY_UNVERIFIED, BLOCK_STOP, HookLaunch, HookOptions, PUSH_WAIT,
    PUSH_WAIT_DEFAULT_S, agy_hook_set, has_our_hooks, hook_entries, merge_hooks, muse_plugin,
    opencode_plugin, shell_quote,
};
use crate::fleet::json::Json;
use crate::open::node_fs_error;
use crate::term::out;
use crate::{Call, Done, Fail, usage};
use scp_core::protocol::{CLI_NAME, LIMITS};
use scp_mcp::client::CallError;
use scp_mcp::identity::{git_toplevel, home_dir, safe_cwd};
use scp_mcp::ps::{Env, basename, dirname, join, resolve};
use scp_mcp::render::js_space;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub const HOOK_HARNESSES: [&str; 5] = ["claude", "codex", "opencode", "agy", "muse"];

fn var<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    env.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

fn home(env: &Env) -> String {
    var(env, "HOME").map_or_else(home_dir, str::to_owned)
}

fn config_home(env: &Env) -> String {
    var(env, "XDG_CONFIG_HOME").map_or_else(|| join(&[&home(env), ".config"]), str::to_owned)
}

/// where `hooks install` writes for a harness and scope
pub fn hooks_target(harness: &str, scope: &str, env: &Env, cwd: &str) -> String {
    let project = git_toplevel(cwd).unwrap_or_else(|| cwd.to_owned());
    let user = scope == "user";
    match harness {
        "claude" if scope == "local" => join(&[&project, ".claude", "settings.local.json"]),
        "claude" if user => join(&[
            &var(env, "CLAUDE_CONFIG_DIR")
                .map_or_else(|| join(&[&home(env), ".claude"]), str::to_owned),
            "settings.json",
        ]),
        "claude" => join(&[&project, ".claude", "settings.json"]),
        "codex" if user => join(&[
            &var(env, "CODEX_HOME").map_or_else(|| join(&[&home(env), ".codex"]), str::to_owned),
            "hooks.json",
        ]),
        "codex" => join(&[&project, ".codex", "hooks.json"]),
        "opencode" if user => join(&[&config_home(env), "opencode", "plugin", "scp.ts"]),
        "opencode" => join(&[&project, ".opencode", "plugin", "scp.ts"]),
        "agy" if user => join(&[&home(env), ".gemini", "config", "hooks.json"]),
        "agy" => join(&[&project, ".agents", "hooks.json"]),
        _ => join(&[
            &config_home(env),
            "scp",
            "muse-plugin",
            ".muse-plugin",
            "plugin.json",
        ]),
    }
}

/// a native hook client a user-scope hooks file runs that is no longer an executable file; `guarded` hooks run the CLI without it
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoneClient {
    pub harness: String,
    pub file: String,
    pub bin: String,
    pub guarded: bool,
}

/// the gone native hook clients `file`, the hooks of `harness`, runs
pub fn gone_clients(harness: &str, file: &str) -> Vec<GoneClient> {
    crate::fleet::mounts::gone_clients(harness, file)
        .into_iter()
        .map(|(bin, guarded)| GoneClient {
            harness: harness.to_owned(),
            file: file.to_owned(),
            bin,
            guarded,
        })
        .collect()
}

/// the gone native hook clients the user-scope hooks of every harness run
pub fn gone_hook_clients(env: &Env, cwd: &str) -> Vec<GoneClient> {
    HOOK_HARNESSES
        .iter()
        .flat_map(|harness| gone_clients(harness, &hooks_target(harness, "user", env, cwd)))
        .collect()
}

/// what to say about a gone native hook client
pub fn gone_client_line(client: &GoneClient) -> String {
    let GoneClient {
        harness,
        file,
        bin,
        guarded,
    } = client;
    if *guarded {
        format!(
            "{file} runs the native hook client {bin}, which is gone: its hooks run through Node until {CLI_NAME} setup --write runs again"
        )
    } else {
        format!(
            "{file} runs every {harness} hook through {bin}, which is gone: those hooks fail until {CLI_NAME} setup --write runs again"
        )
    }
}

/// `YYYYMMDDHHMMSS` in local time
pub fn stamp(at_s: i64) -> String {
    let time = at_s as libc::time_t;
    // SAFETY: localtime_r writes only into the zeroed tm it is handed
    let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
    if unsafe { libc::localtime_r(&time, &mut tm) }.is_null() {
        return "00000000000000".into();
    }
    format!(
        "{}{:02}{:02}{:02}{:02}{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

/// what an atomic write did: nothing when the file already held the content, else the backup it made of the old one
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    pub changed: bool,
    pub backup: Option<String>,
}

fn exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

fn io(syscall: &str, path: &str) -> impl Fn(std::io::Error) -> String {
    let (syscall, path) = (syscall.to_owned(), path.to_owned());
    move |error| node_fs_error(&error, &syscall, &path)
}

/// Writes `content` over `target` via a temp file and rename, keeping its mode and backing it up first (with that mode); a symlinked
/// target is written through to the file it points at. Unchanged when the file already holds it.
pub fn write_atomic(target: &str, content: &str, now_s: i64) -> Result<Written, String> {
    let linked = exists(target)
        && std::fs::symlink_metadata(target).is_ok_and(|m| m.file_type().is_symlink());
    let file = if linked {
        std::fs::canonicalize(target)
            .map_err(io("realpath", target))?
            .to_string_lossy()
            .into_owned()
    } else {
        target.to_owned()
    };
    let existing = if exists(&file) {
        let bytes = std::fs::read(&file).map_err(io("open", &file))?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        None
    };
    if existing.as_deref() == Some(content) {
        return Ok(Written {
            changed: false,
            backup: None,
        });
    }
    let dir = dirname(&file);
    std::fs::create_dir_all(&dir).map_err(io("mkdir", &dir))?;
    let mut mode = 0o644;
    let mut backup = None;
    if existing.is_some() {
        mode = std::fs::metadata(&file)
            .map_err(io("stat", &file))?
            .permissions()
            .mode()
            & 0o7777;
        let stamped = format!("{file}.bak-{}", stamp(now_s));
        let mut path = stamped.clone();
        let mut n = 2;
        while exists(&path) {
            path = format!("{stamped}-{n}");
            n += 1;
        }
        std::fs::copy(&file, &path).map_err(io("copyfile", &file))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))
            .map_err(io("chmod", &path))?;
        backup = Some(path);
    }
    let temp = join(&[
        &dir,
        &format!(".{}.tmp-{}", basename(&file), std::process::id()),
    ]);
    let written = (|| {
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&temp)
            .map_err(io("open", &temp))?;
        out.write_all(content.as_bytes())
            .map_err(io("write", &temp))?;
        drop(out);
        std::fs::rename(&temp, &file).map_err(io("rename", &temp))
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(Written {
        changed: true,
        backup,
    })
}

/// `file` with every symlink on its last component followed, up to 40 hops
pub fn resolved(file: &str) -> Result<String, String> {
    let mut path = file.to_owned();
    for _ in 0..40 {
        let link = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta.file_type().is_symlink(),
            Err(_) => return Ok(path),
        };
        if !link {
            return Ok(path);
        }
        let Ok(to) = std::fs::read_link(&path) else {
            return Ok(path);
        };
        path = resolve(&dirname(&path), &to.to_string_lossy());
    }
    Err(format!("{file}: too many levels of symlinks"))
}

/// a JSON parse failure: Node's words for an empty file, one generic line for the rest, whose wording differs by engine and position
fn parse_error(text: &str) -> String {
    if text.trim_matches(js_space).is_empty() {
        "Unexpected end of JSON input".into()
    } else {
        "Unexpected token in JSON".into()
    }
}

/// `JSON.parse(text)`, or why it throws
pub fn parse_json(text: &str) -> Result<Json, String> {
    Json::parse(text.as_bytes()).ok_or_else(|| parse_error(text))
}

/// whether JSON text escapes a UTF-16 surrogate that is not half of a pair: JavaScript keeps it, a Rust string cannot
pub fn lone_surrogate(text: &str) -> bool {
    let bytes = text.as_bytes();
    let unit = |at: usize| -> Option<u32> {
        let hex = bytes.get(at..at + 6)?;
        if &hex[..2] != b"\\u" {
            return None;
        }
        u32::from_str_radix(std::str::from_utf8(&hex[2..]).ok()?, 16).ok()
    };
    let (mut at, mut in_string) = (0, false);
    while at < bytes.len() {
        match bytes[at] {
            b'"' => in_string = !in_string,
            b'\\' if in_string => {
                match unit(at) {
                    Some(0xd800..=0xdbff) => {
                        if !unit(at + 6).is_some_and(|low| (0xdc00..=0xdfff).contains(&low)) {
                            return true;
                        }
                        at += 12;
                        continue;
                    }
                    Some(0xdc00..=0xdfff) => return true,
                    _ => {}
                }
                at += 2;
                continue;
            }
            _ => {}
        }
        at += 1;
    }
    false
}

/// why a file is left as it is rather than rewritten with a value changed: no Rust string keeps a lone surrogate
pub const LONE_SURROGATE: &str =
    "it has a lone surrogate escape, which rewriting it here would change";
/// the same for bytes that are no UTF-8, which reading it as text would replace
pub const NOT_UTF8: &str = "it is not valid UTF-8, which reading it as text would change";
/// the same for a hooks key that a merge cannot carry over
pub const PROTO_EVENT: &str = "its hooks have a __proto__ event, which a merge would lose";

/// why the content of a hooks file could not be built
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HookError {
    /// what JavaScript throws, as Node words it
    Thrown(String),
    /// the file is readable, and rewriting it would lose something in it
    Refused(&'static str),
}

impl HookError {
    pub fn message(&self) -> &str {
        match self {
            HookError::Thrown(message) => message,
            HookError::Refused(reason) => reason,
        }
    }
}

impl From<String> for HookError {
    fn from(message: String) -> Self {
        HookError::Thrown(message)
    }
}

/// a settings file's text as `JSON.parse` reads it, refused when writing it back would change it
pub fn read_settings(text: &str) -> Result<Json, HookError> {
    let settings = parse_json(text)?;
    if lone_surrogate(text) {
        return Err(HookError::Refused(LONE_SURROGATE));
    }
    Ok(settings)
}

/// the text of a file about to be rewritten, refused when it is no UTF-8
pub fn utf8_text(bytes: Vec<u8>) -> Result<String, HookError> {
    String::from_utf8(bytes).map_err(|_| HookError::Refused(NOT_UTF8))
}

/// `settings` refused when its hooks hold a `__proto__` event: assigning one sets the merged object's prototype, so the event goes
pub fn mergeable(settings: &Json) -> Result<(), HookError> {
    let hooks = settings.get("hooks");
    if hooks.is_some_and(|h| h.get("__proto__").is_some()) {
        return Err(HookError::Refused(PROTO_EVENT));
    }
    Ok(())
}

/// `JSON.stringify(value, null, 2)` and a newline, as every hooks file is written
pub fn json_text(value: &Json) -> String {
    format!("{}\n", value.pretty())
}

/// the command starts of hooks of ours a launch may have written, with and without its native client
pub fn launcher_prefixes(launch: &HookLaunch) -> Vec<String> {
    let Some(launcher) = &launch.launcher else {
        return Vec::new();
    };
    let mut starts = vec![launcher.clone()];
    if let Some(native) = launch.native.as_deref().filter(|n| !n.is_empty()) {
        starts.push(
            std::iter::once(native.to_owned())
                .chain(launcher.iter().cloned())
                .collect(),
        );
    }
    starts
        .iter()
        .map(|words| {
            words
                .iter()
                .map(|w| shell_quote(w))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect()
}

/// what setup writes into a hooks file that holds `existing`
pub fn hook_content(
    kind: &str,
    existing: Option<&str>,
    block_stop: bool,
    launch: &HookLaunch,
) -> Result<String, HookError> {
    let options = HookOptions {
        block_stop,
        launch: launch.clone(),
        ..HookOptions::default()
    };
    match kind {
        "opencode" => return Ok(opencode_plugin(block_stop, launch)),
        "muse" => return Ok(json_text(&muse_plugin(&options))),
        _ => {}
    }
    let settings = match existing {
        None => Json::Obj(Vec::new()),
        Some(text) => read_settings(text)?,
    };
    if kind == "agy" {
        if !matches!(settings, Json::Obj(_)) {
            return Err(HookError::Thrown("not a JSON object".into()));
        }
        let mut next = settings;
        next.set(AGY_HOOK_SET, agy_hook_set(block_stop, launch));
        return Ok(json_text(&next));
    }
    mergeable(&settings)?;
    let merged = merge_hooks(
        &settings,
        &hook_entries(kind, &options),
        &launcher_prefixes(launch),
    )?;
    Ok(json_text(&merged))
}

/// what `hooks install --scope user --write` would write, or None when the file already has it
pub fn desired_hooks(
    kind: &str,
    target: &str,
    block_stop: bool,
    launch: &HookLaunch,
) -> Result<Option<String>, HookError> {
    let file = resolved(target)?;
    let existing = if exists(&file) {
        let bytes = std::fs::read(&file).map_err(io("open", &file))?;
        Some(utf8_text(bytes)?)
    } else {
        None
    };
    let content = hook_content(kind, existing.as_deref(), block_stop, launch)?;
    Ok((existing.as_deref() != Some(content.as_str())).then_some(content))
}

/// what `hooks install` is asked to do
#[derive(Debug, Clone, Default)]
pub struct InstallOptions {
    pub harness: Option<String>,
    pub scope: Option<String>,
    pub write: bool,
    pub block_stop: bool,
    pub push_wait: Option<f64>,
}

/// `swarm hooks install`: prints the snippet and its target with `out`, and with `write` merges it in
pub fn install_hooks(
    options: &InstallOptions,
    env: &Env,
    cwd: &str,
    now_s: i64,
    out: &mut dyn FnMut(String),
) -> Result<(), Fail> {
    if env.get("SCP_TRANSPORT").map(String::as_str) == Some("cloud") {
        return Err(usage(format!(
            "relay hooks report to the local broker, and SCP_TRANSPORT=cloud bypasses it; link the broker instead ({CLI_NAME} cloud enable) and install the hooks without it"
        )));
    }
    let harness = options.harness.as_deref().unwrap_or("");
    if options.harness.as_deref() == Some("grok") {
        return Err(usage(
            "Grok runs the Claude Code hooks (install those with --harness claude) and is labelled grok by them; it drops a prompt hook's context, so new messages reach it after tools only",
        ));
    }
    if options.harness.is_none() || !HOOK_HARNESSES.contains(&harness) {
        return Err(usage(
            "hooks install takes --harness claude, codex, opencode, agy or muse",
        ));
    }
    let scope = options.scope.as_deref().unwrap_or(match harness {
        "claude" => "local",
        "muse" => "user",
        _ => "project",
    });
    if scope != "project" && scope != "user" && !(scope == "local" && harness == "claude") {
        return Err(usage(
            "--scope is project or user (and local for claude, its default: .claude/settings.local.json, the per-person file)",
        ));
    }
    let target = hooks_target(harness, scope, env, cwd);
    if let Some(wait) = options.push_wait
        && !(wait.fract() == 0.0 && (0.0..=3600.0).contains(&wait))
    {
        return Err(usage(format!("{PUSH_WAIT} takes whole seconds, 0 to 3600")));
    }
    let hook_options = HookOptions {
        block_stop: options.block_stop,
        push_wait: options.push_wait.map(|w| w as u32),
        ..HookOptions::default()
    };
    let content = match harness {
        "opencode" => opencode_plugin(options.block_stop, &HookLaunch::default()),
        "muse" => json_text(&muse_plugin(&hook_options)),
        _ => {
            let mut settings = Json::Obj(Vec::new());
            if options.write && exists(&target) {
                let read = std::fs::read(&target)
                    .map_err(|error| match error.raw_os_error() {
                        Some(libc::EISDIR) => {
                            "EISDIR: illegal operation on a directory, read".to_owned()
                        }
                        _ => node_fs_error(&error, "open", &target),
                    })
                    .map_err(HookError::Thrown)
                    .and_then(|bytes| {
                        let settings = read_settings(&utf8_text(bytes)?)?;
                        if harness != "agy" {
                            mergeable(&settings)?;
                        }
                        Ok(settings)
                    });
                settings = read.map_err(|error| match error {
                    HookError::Thrown(error) => usage(format!(
                        "{target} is not valid JSON ({error}); fix it or add the hooks by hand"
                    )),
                    HookError::Refused(reason) => usage(format!(
                        "{target}: {reason}; fix it or add the hooks by hand"
                    )),
                })?;
            }
            let built = if harness == "agy" {
                if matches!(settings, Json::Obj(_)) {
                    settings.set(
                        AGY_HOOK_SET,
                        agy_hook_set(options.block_stop, &HookLaunch::default()),
                    );
                    Ok(settings)
                } else {
                    Err("the hooks file is not a JSON object".to_owned())
                }
            } else if options.write {
                merge_hooks(&settings, &hook_entries(harness, &hook_options), &[])
            } else {
                Ok(Json::object(vec![(
                    "hooks",
                    hook_entries(harness, &hook_options),
                )]))
            };
            let built = built.map_err(|error| {
                usage(format!(
                    "{target}: {error}; fix it or add the hooks by hand"
                ))
            })?;
            json_text(&built)
        }
    };
    if harness == "claude" && scope == "local" {
        let shared = hooks_target("claude", "project", env, cwd);
        if has_our_hooks(&shared, &[]) {
            out(format!(
                "# {shared} already runs the {CLI_NAME} hooks; remove them there, or every event reports twice"
            ));
        }
    }
    if !options.write {
        let what = if harness == "opencode" || harness == "muse" {
            "the plugin file"
        } else {
            "merge into"
        };
        out(format!("# {what} {target} (or rerun with --write)"));
        out(content.trim_end_matches(js_space).to_owned());
    } else {
        let written =
            write_atomic(&target, &content, now_s).map_err(|e| Fail::Call(CallError::Io(e)))?;
        out(if written.changed {
            match written.backup {
                Some(backup) => format!("wrote {target} (backup {backup})"),
                None => format!("wrote {target}"),
            }
        } else {
            format!("{target} already has the {CLI_NAME} hooks")
        });
        if written.changed {
            out(
                "# restart sessions started before this install: harnesses read hooks only at session start".into(),
            );
        }
    }
    let wait = options.push_wait.map_or(PUSH_WAIT_DEFAULT_S, |w| w as u32);
    for line in injection_notes(harness, scope, &target, options.block_stop, wait) {
        out(format!("# {line}"));
    }
    Ok(())
}

/// how new relay messages reach each harness, and what it lacks
fn injection_notes(
    harness: &str,
    scope: &str,
    target: &str,
    block_stop: bool,
    wait: u32,
) -> Vec<String> {
    let stop = format!(
        "a stop names each request not yet answered once, and is held while a require_reply request waits (at most {} times a session)",
        LIMITS.stop_blocks
    );
    let held = if block_stop {
        format!("{stop}; with {BLOCK_STOP} it is also held while messages are unread")
    } else {
        format!("{stop}; add {BLOCK_STOP} to also hold it while messages are unread")
    };
    let pushed = if wait > 0 {
        format!(
            "while workers you started with {CLI_NAME} spawn still run, a stop waits up to {wait} s for their next message or handback and hands it to the model, which goes on (on by default, since spawning is explicit; {PUSH_WAIT} 0 turns it off, SCP_PUSH_WAIT=<s> lowers it per session, 0 opts out); spawn itself returns at once without a terminal, so the model never backgrounds it"
        )
    } else {
        format!(
            "the stop never waits on workers started with {CLI_NAME} spawn ({PUSH_WAIT} 0); {PUSH_WAIT} <s> lets it wait for their next message"
        )
    };
    let reach = format!(
        "new relay messages reach the model after each tool call and with each prompt; {held}"
    );
    match harness {
        "claude" => vec![
            reach,
            pushed,
            "Grok runs these hooks too, but drops a prompt hook's context: it gets new messages after tools".into(),
        ],
        "codex" => vec![
            reach,
            pushed,
            "Codex runs new hooks only after you review them in /hooks".into(),
        ],
        "agy" => vec![
            format!(
                "agy reads nothing from a PostToolUse hook, so new relay messages go in before each model call (PreInvocation) as ephemeral steps; {held}"
            ),
            AGY_UNVERIFIED.into(),
        ],
        "opencode" => vec![
            "new relay messages are appended to tool results; a prompt gets only how many are unread".into(),
            format!(
                "OpenCode has no stop hook: when the session goes idle, the plugin starts a new turn instead of holding a stop; {held}"
            ),
        ],
        _ => vec![
            format!(
                "Muse loads hooks only from plugins: muse plugins install {} --scope {scope}, then muse plugins approve scp (a headless muse exec runs no hook Muse holds for review)",
                dirname(&dirname(target))
            ),
            reach,
            pushed,
            "Muse hands plugin hooks no SCP_* variables: they key the session by the harness process, so set no SCP_SESSION for Muse's shim".into(),
        ],
    }
}

fn now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// `swarm hooks install [--harness H] [--scope S] [--write] [--block-stop-on-unread] [--push-wait S]`
pub fn hooks(call: &Call) -> Done {
    let parsed = &call.parsed;
    if parsed.positionals.first().map(String::as_str) != Some("install")
        || parsed.positionals.len() > 1
    {
        return Err(usage(format!(
            "{CLI_NAME} hooks takes install --harness claude|codex|opencode|agy|muse"
        )));
    }
    if parsed.on("write") && parsed.on("print") {
        return Err(usage("--print and --write: pick one"));
    }
    let push_wait = match parsed.text("push-wait") {
        None => None,
        Some(value) if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
            Some(value.parse::<f64>().unwrap_or(f64::INFINITY))
        }
        Some(_) => return Err(usage("--push-wait takes whole seconds, 0 to 3600")),
    };
    let options = InstallOptions {
        harness: parsed.text("harness").map(str::to_owned),
        scope: parsed.text("scope").map(str::to_owned),
        write: parsed.on("write"),
        block_stop: parsed.on("block-stop-on-unread"),
        push_wait,
    };
    install_hooks(&options, call.env, &safe_cwd(), now_s(), &mut |line| {
        out(&line)
    })?;
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_unpaired_surrogate_escape_is_lone() {
        for (text, lone) in [
            (r#"{"a":"😀"}"#, false),
            (r#"{"a":"😀x"}"#, false),
            (r#"{"a":"\ud800"}"#, true),
            (r#"{"\udc00":1}"#, true),
            (r#"{"a":"\ud800A"}"#, true),
            (r#"{"a":"\\ud800"}"#, false),
            (r#"{"a":"é \" \ud800"}"#, true),
            (r#"{"a":"plain"}"#, false),
        ] {
            assert_eq!(lone_surrogate(text), lone, "{text}");
        }
    }

    #[test]
    fn a_settings_file_with_a_lone_surrogate_is_refused() {
        let read = read_settings(r#"{"keep":"\ud800"}"#);
        assert_eq!(read, Err(HookError::Refused(LONE_SURROGATE)));
        assert!(matches!(read_settings("{x"), Err(HookError::Thrown(_))));
    }

    #[test]
    fn a_proto_event_is_refused_and_only_for_a_merge() {
        let text = r#"{"hooks":{"__proto__":[]}}"#;
        let launch = HookLaunch::default();
        let refused = Err(HookError::Refused(PROTO_EVENT));
        assert_eq!(hook_content("claude", Some(text), false, &launch), refused);
        assert_eq!(hook_content("codex", Some(text), false, &launch), refused);
        assert!(hook_content("agy", Some(text), false, &launch).is_ok());
        let top = r#"{"__proto__":{"a":1},"k":1}"#;
        assert!(hook_content("claude", Some(top), false, &launch).is_ok());
    }
}
