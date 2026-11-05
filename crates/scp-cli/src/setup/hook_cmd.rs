//! The hook commands and the hook files `hooks install` and setup write, byte for byte as the TypeScript CLI builds them.

use crate::args::js_string;
use crate::fleet::json::Json;
use crate::fleet::view::text;
use scp_core::protocol::CLI_NAME;
use scp_mcp::render::js_space;

pub use crate::fleet::mounts::{hook_client, shell_words};

pub const BLOCK_STOP: &str = "--block-stop-on-unread";
/// a hook whose caller has nowhere to put new messages: it reports activity and takes none
pub const NO_INJECT: &str = "--no-inject";
/// `--push-wait <s>`: how long a stop may wait on the workers `swarm spawn` started; the installed stop's timeout covers it, 0 turns it off
pub const PUSH_WAIT: &str = "--push-wait";
/// `--wake <s>`: wait up to that long for new messages and print them as the next turn's prompt
pub const WAKE: &str = "--wake";
pub const SUBAGENT: &str = "--subagent";
pub const PUSH_WAIT_DEFAULT_S: u32 = 600;
/// an installed stop's timeout past its push wait, so the wait ends and the reply prints well before the harness kills the hook
const PUSH_TIMEOUT_MARGIN_S: u32 = 30;
pub const AGY_UNVERIFIED: &str =
    "agy support follows its docs and binary; not yet checked in a live session";
/// the key of agy's hooks file that holds the set of ours
pub const AGY_HOOK_SET: &str = "scp";
/// runs the native client named by `$0` while it is executable, else the rest of the argv
pub const ARGV_GUARD: &str = "[ -x \"$0\" ] && exec \"$0\" \"$@\"; exec \"$@\"";

/// what the harness shows while a stop that may wait on workers runs
pub fn stop_status() -> String {
    format!("waiting for worker messages ({CLI_NAME})")
}

/// how a hook command starts this CLI: `launcher` (else `swarm` from PATH), behind the native hook client `native` when there is one
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookLaunch {
    pub launcher: Option<Vec<String>>,
    pub native: Option<String>,
}

impl HookLaunch {
    fn words(&self) -> Vec<String> {
        self.launcher
            .clone()
            .unwrap_or_else(|| vec![CLI_NAME.to_owned()])
    }

    fn native(&self) -> Option<&str> {
        self.native.as_deref().filter(|n| !n.is_empty())
    }
}

/// what an installed hook set does: hold stops while messages are unread, wait on workers, report only for Cowork, and how it starts
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookOptions {
    pub block_stop: bool,
    pub push_wait: Option<u32>,
    pub cowork: bool,
    pub launch: HookLaunch,
}

/// `word` as one POSIX shell word
pub fn shell_quote(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/=@:+-".contains(c));
    if plain {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// the shell command that runs `swarm <words>` as `launch` says
pub fn hook_command(launch: &HookLaunch, words: &[String]) -> String {
    let rest: Vec<String> = launch
        .words()
        .iter()
        .map(|w| shell_quote(w))
        .chain(words.iter().cloned())
        .collect();
    let rest = rest.join(" ");
    match launch.native() {
        Some(native) => {
            let native = shell_quote(native);
            format!("[ -x {native} ] && exec {native} {rest} || exec {rest}")
        }
        None => rest,
    }
}

/// the same as an argv for a harness that runs it without a shell
pub fn hook_argv(launch: &HookLaunch, words: &[String]) -> Vec<String> {
    let rest = launch.words().into_iter().chain(words.iter().cloned());
    match launch.native() {
        Some(native) => ["/bin/sh", "-c", ARGV_GUARD, native]
            .into_iter()
            .map(str::to_owned)
            .chain(rest)
            .collect(),
        None => rest.collect(),
    }
}

/// the stop's flags: the unread hold, then the push wait (always written, so 0 keeps it off), and its timeout in seconds
fn stop_args(block_stop: bool, push_wait: Option<u32>) -> (Vec<String>, u32, bool) {
    let wait = push_wait.unwrap_or(PUSH_WAIT_DEFAULT_S);
    let mut args: Vec<String> = Vec::new();
    if block_stop {
        args.push(BLOCK_STOP.into());
    }
    args.push(PUSH_WAIT.into());
    args.push(wait.to_string());
    let timeout = if wait > 0 {
        wait + PUSH_TIMEOUT_MARGIN_S
    } else {
        5
    };
    (args, timeout, wait > 0)
}

fn strings(words: &[String]) -> Json {
    Json::Arr(words.iter().map(|w| Json::str(w.as_str())).collect())
}

fn num(n: u32) -> Json {
    Json::Num(f64::from(n))
}

fn handler(command: &str, timeout: u32, background: bool) -> Json {
    let mut entries = vec![
        ("type", Json::str("command")),
        ("command", Json::str(command)),
        ("timeout", num(timeout)),
    ];
    if background {
        entries.push(("async", Json::Bool(true)));
    }
    Json::object(entries)
}

fn group(handlers: Vec<Json>) -> Json {
    Json::object(vec![("hooks", Json::Arr(handlers))])
}

/// Prompt, stop, session end and Claude subagent context run in the foreground; activity runs in the background.
pub fn hook_entries(harness: &str, options: &HookOptions) -> Json {
    let claude = harness == "claude";
    let line = |extra: &[String]| {
        let mut words = vec!["hook".to_owned(), harness.to_owned()];
        if options.cowork {
            words.push("--cowork-only".into());
        }
        words.extend_from_slice(extra);
        hook_command(&options.launch, &words)
    };
    let command = line(&[]);
    let background = handler(&command, 5, true);
    let foreground = handler(&command, 5, false);
    let subagent = claude.then(|| line(&[SUBAGENT.to_owned()]));
    let (stop, timeout, waits) = stop_args(options.block_stop, options.push_wait);
    let mut stop_handler = handler(&line(&stop), timeout, false);
    if waits {
        stop_handler.set("statusMessage", Json::str(stop_status()));
    }
    let post = {
        let mut hooks = vec![background.clone()];
        hooks.extend(subagent.iter().map(|c| handler(c, 5, false)));
        if claude {
            Json::object(vec![
                ("matcher", Json::str("*")),
                ("hooks", Json::Arr(hooks)),
            ])
        } else {
            group(hooks)
        }
    };
    let mut subagent_stop = vec![background.clone()];
    subagent_stop.extend(subagent.iter().map(|c| handler(c, 5, true)));
    Json::object(vec![
        ("SessionStart", Json::Arr(vec![group(vec![background])])),
        ("UserPromptSubmit", Json::Arr(vec![group(vec![foreground])])),
        ("PostToolUse", Json::Arr(vec![post])),
        ("Stop", Json::Arr(vec![group(vec![stop_handler])])),
        ("SubagentStop", Json::Arr(vec![group(subagent_stop)])),
        (
            "SessionEnd",
            Json::Arr(vec![group(vec![handler(&command, 2, false)])]),
        ),
    ])
}

/// agy names events in argv and receives context before model calls, never after tools.
pub fn agy_hook_set(block_stop: bool, launch: &HookLaunch) -> Json {
    let handler = |event: &[&str], timeout: u32| {
        let words: Vec<String> = ["hook", "agy"]
            .iter()
            .chain(event)
            .map(|w| (*w).to_owned())
            .collect();
        handler(&hook_command(launch, &words), timeout, false)
    };
    let stop: &[&str] = if block_stop {
        &["Stop", BLOCK_STOP]
    } else {
        &["Stop"]
    };
    Json::object(vec![
        ("enabled", Json::Bool(true)),
        (
            "SessionStart",
            Json::Arr(vec![handler(&["SessionStart"], 2)]),
        ),
        (
            "PreInvocation",
            Json::Arr(vec![handler(&["PreInvocation"], 1)]),
        ),
        (
            "PostToolUse",
            Json::Arr(vec![Json::object(vec![
                ("matcher", Json::str(".*")),
                ("hooks", Json::Arr(vec![handler(&["PostToolUse"], 1)])),
            ])]),
        ),
        ("Stop", Json::Arr(vec![handler(stop, 1)])),
    ])
}

/// the Muse plugin manifest: Muse loads hooks only from plugins, and applies no background hook's output; the stop's timeout covers its push wait
pub fn muse_plugin(options: &HookOptions) -> Json {
    let (stop, timeout, _) = stop_args(options.block_stop, options.push_wait);
    let argv = |extra: &[String]| {
        let words: Vec<String> = ["hook", "muse"]
            .iter()
            .map(|w| (*w).to_owned())
            .chain(extra.iter().cloned())
            .collect();
        strings(&hook_argv(&options.launch, &words))
    };
    let hook = |id: &str, event: &str, extra: Vec<(&str, Json)>| {
        let mut hook = Json::object(vec![
            ("id", Json::str(id)),
            ("event", Json::str(event)),
            ("command", argv(&[event.to_owned()])),
            ("timeoutMs", num(5000)),
        ]);
        for (key, value) in extra {
            hook.set(key, value);
        }
        hook
    };
    let mut stop_words = vec!["Stop".to_owned()];
    stop_words.extend(stop);
    let stop_hook = hook(
        "stop",
        "Stop",
        vec![
            ("command", argv(&stop_words)),
            ("timeoutMs", num(timeout * 1000)),
        ],
    );
    Json::object(vec![
        ("schemaVersion", num(1)),
        ("name", Json::str("scp")),
        ("displayName", Json::str("scp")),
        ("version", Json::str("1.0.0")),
        (
            "description",
            Json::str(
                "Reports this session's activity to the local SCP broker and hands it new messages",
            ),
        ),
        (
            "compat",
            Json::object(vec![
                ("source", Json::str("native")),
                ("manifestDir", Json::str(".muse-plugin")),
            ]),
        ),
        (
            "capabilities",
            Json::object(vec![(
                "hooks",
                Json::Arr(vec![
                    hook(
                        "session-start",
                        "SessionStart",
                        vec![("async", Json::Bool(true))],
                    ),
                    hook("prompt", "UserPromptSubmit", Vec::new()),
                    hook("post-tool", "PostToolUse", Vec::new()),
                    stop_hook,
                    hook("session-end", "SessionEnd", vec![("timeoutMs", num(2000))]),
                ]),
            )]),
        ),
    ])
}

const OPENCODE_BODY: &str = include_str!("opencode-plugin.txt");

/// Root sessions receive context and wake while idle, and a message to a server with no session yet opens one; failed or aborted
/// sessions do not hold the stop.
pub fn opencode_plugin(block_stop: bool, launch: &HookLaunch) -> String {
    let words = launch
        .words()
        .iter()
        .map(|w| js_string(w))
        .collect::<Vec<_>>()
        .join(", ");
    let native = launch.native();
    let mut head = String::from(
        "// scp: reports this session to the local SCP broker and hands it new messages\nimport { spawn } from \"node:child_process\"\n",
    );
    if native.is_some() {
        head.push_str("import { accessSync, constants } from \"node:fs\"\n");
    }
    head.push_str("import { text as readAll } from \"node:stream/consumers\"\n");
    head.push_str(&format!("const BLOCK_STOP = {block_stop}"));
    if let Some(native) = native {
        head.push_str(&format!(
            "\nconst NATIVE = {}\n/** the native hook client while it is executable, else the CLI straight */\nconst launch = () => {{\n  try {{\n    accessSync(NATIVE, constants.X_OK)\n    return [NATIVE, {words}]\n  }} catch {{\n    return [{words}]\n  }}\n}}",
            js_string(native)
        ));
    }
    head.push('\n');
    let call = if native.is_some() {
        "...launch()".to_owned()
    } else {
        words
    };
    head + &OPENCODE_BODY.replace("@@LAUNCH@@", &call)
}

/// a word of a hook command's launcher: no space, quote or shell operator
fn word_char(c: char) -> bool {
    !(js_space(c)
        || matches!(
            c,
            '\'' | '"' | ';' | '|' | '&' | '<' | '>' | '`' | '$' | '\\'
        ))
}

/// the end of `lit` when `s` has it at `at`
fn lit(s: &[char], at: usize, lit: &str) -> Option<usize> {
    let mut end = at;
    for c in lit.chars() {
        if s.get(end) != Some(&c) {
            return None;
        }
        end += 1;
    }
    Some(end)
}

fn word_end(s: &[char], at: usize) -> usize {
    s[at.min(s.len())..]
        .iter()
        .position(|c| !word_char(*c))
        .map_or(s.len(), |n| at + n)
}

/// every place `(?:[^']|'\\'')*` from `at` can end, shortest first
fn quoted_ends(s: &[char], at: usize) -> Vec<usize> {
    let mut ends = vec![at];
    let mut end = at;
    while end < s.len() {
        end = if s[end] != '\'' {
            end + 1
        } else if let Some(next) = lit(s, end, "'\\''") {
            next
        } else {
            break;
        };
        ends.push(end);
    }
    ends
}

/// every place `\s+` from `at` can end
fn spaces(s: &[char], at: usize) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut end = at;
    while end < s.len() && js_space(s[end]) {
        end += 1;
        ends.push(end);
    }
    ends
}

/// every place a launcher word ending in `ending` can end: bare or with a path, plain or single-quoted
fn word_ending(s: &[char], at: usize, ending: &str) -> Vec<usize> {
    let slashed = format!("/{ending}");
    let mut ends: Vec<usize> = (at..=word_end(s, at))
        .filter_map(|p| lit(s, p, &slashed))
        .collect();
    ends.extend(lit(s, at, ending));
    if s.get(at) == Some(&'\'') {
        let quoted = format!("/{ending}'");
        ends.extend(
            quoted_ends(s, at + 1)
                .into_iter()
                .filter_map(|p| lit(s, p, &quoted)),
        );
    }
    ends.extend(lit(s, at, &format!("'{ending}'")));
    ends
}

const CLI_SCRIPTS: [&str; 2] = ["/@scp-dev/cli/dist/cli.js", "/packages/cli/dist/cli.js"];

/// every place the CLI's script path, plain or single-quoted, can end
fn script_ends(s: &[char], at: usize) -> Vec<usize> {
    let mut ends: Vec<usize> = (at..=word_end(s, at))
        .flat_map(|p| CLI_SCRIPTS.iter().filter_map(move |tail| lit(s, p, tail)))
        .collect();
    if s.get(at) == Some(&'\'') {
        for p in quoted_ends(s, at + 1) {
            for tail in CLI_SCRIPTS {
                ends.extend(lit(s, p, &format!("{tail}'")));
            }
        }
    }
    ends
}

fn word_break(s: &[char], at: usize) -> bool {
    at == s.len() || js_space(s[at])
}

/// whether a command (its guard removed) starts this CLI's hook: the launcher is the first command word, never an argument or a later
/// shell command
fn runs_our_hook(command: &str) -> bool {
    let s: Vec<char> = command.chars().collect();
    let s = s.as_slice();
    let mut starts = vec![0];
    for end in word_ending(s, 0, "scp-hook") {
        starts.extend(spaces(s, end));
    }
    starts.iter().any(|&start| {
        let swarm = word_ending(s, start, CLI_NAME).into_iter().any(|end| {
            spaces(s, end)
                .into_iter()
                .any(|at| lit(s, at, "hook").is_some_and(|h| word_break(s, h)))
        });
        swarm
            || word_ending(s, start, "node").into_iter().any(|end| {
                spaces(s, end).into_iter().any(|at| {
                    script_ends(s, at).into_iter().any(|script| {
                        spaces(s, script).into_iter().any(|at| {
                            lit(s, at, "hook").is_some_and(|h| {
                                spaces(s, h).into_iter().any(|at| {
                                    s.get(at).is_some_and(char::is_ascii_lowercase) && {
                                        let end = s[at + 1..]
                                            .iter()
                                            .position(|c| {
                                                !(c.is_ascii_lowercase()
                                                    || c.is_ascii_digit()
                                                    || *c == '-')
                                            })
                                            .map_or(s.len(), |n| at + 1 + n);
                                        word_break(s, end)
                                    }
                                })
                            })
                        })
                    })
                })
            })
    })
}

/// `command` without a leading native guard `[ -x N ] && exec N `
fn strip_guard(command: &str) -> String {
    let s: Vec<char> = command.chars().collect();
    let Some(at) = lit(&s, 0, "[ -x ") else {
        return command.to_owned();
    };
    let mut ends: Vec<usize> = (at..=word_end(&s, at)).rev().collect();
    if s.get(at) == Some(&'\'') {
        ends.extend(
            quoted_ends(&s, at + 1)
                .into_iter()
                .rev()
                .filter(|p| s.get(*p) == Some(&'\''))
                .map(|p| p + 1),
        );
    }
    for end in ends {
        let native = &s[at..end];
        let Some(after) = lit(&s, end, " ] && exec ") else {
            continue;
        };
        if s.len() > after + native.len()
            && s[after..after + native.len()] == *native
            && s[after + native.len()] == ' '
        {
            return s[after + native.len() + 1..].iter().collect();
        }
    }
    command.to_owned()
}

/// `String(value)` on a parsed JSON value: an object with its own `toString` key has no string form, and throws
fn js_to_string(value: &Json) -> Result<String, String> {
    match value {
        Json::Obj(_) if value.get("toString").is_some() => {
            Err("Cannot convert object to primitive value".into())
        }
        Json::Arr(items) => items
            .iter()
            .map(|item| match item {
                Json::Null => Ok(String::new()),
                item => js_to_string(item),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|parts| parts.join(",")),
        other => Ok(text(Some(other))),
    }
}

/// whether a hooks file's handler runs our hook: by its command words, or a launcher `prefixes` names; Err where JavaScript throws
pub fn ours(handler: &Json, prefixes: &[String]) -> Result<bool, String> {
    if !matches!(handler, Json::Obj(_) | Json::Arr(_)) {
        return Ok(false);
    }
    let full = match handler.get("command") {
        None | Some(Json::Null) => String::new(),
        Some(command) => js_to_string(command)?,
    };
    let command = strip_guard(&full);
    Ok(runs_our_hook(&command)
        || prefixes
            .iter()
            .any(|prefix| command.starts_with(&format!("{prefix} hook "))))
}

/// whether a Claude Code or Codex settings file already runs our hooks; false when it is missing or unreadable
pub fn has_our_hooks(file: &str, prefixes: &[String]) -> bool {
    let Ok(bytes) = std::fs::read(file) else {
        return false;
    };
    let Some(config) = Json::parse(String::from_utf8_lossy(&bytes).as_bytes()) else {
        return false;
    };
    let groups: Vec<&Json> = match config.get("hooks") {
        Some(Json::Arr(items)) => items.iter().collect(),
        Some(hooks @ Json::Obj(_)) => hooks.entries().into_iter().map(|(_, v)| v).collect(),
        _ => return false,
    };
    let handlers = groups
        .iter()
        .filter(|groups| matches!(groups, Json::Arr(_)))
        .flat_map(|groups| groups.items())
        .filter_map(|group| match group.get("hooks") {
            Some(Json::Arr(handlers)) => Some(handlers),
            _ => None,
        })
        .flatten();
    for handler in handlers {
        match ours(handler, prefixes) {
            Ok(true) => return true,
            Ok(false) => {}
            Err(_) => return false,
        }
    }
    false
}

/// `value` spread into an array literal as JavaScript does, or the TypeError it throws
fn spread(value: Option<&Json>) -> Result<Vec<Json>, String> {
    match value {
        None | Some(Json::Null) => Ok(Vec::new()),
        Some(Json::Arr(items)) => Ok(items.clone()),
        Some(Json::Str(s)) => Ok(s.chars().map(|c| Json::Str(c.to_string())).collect()),
        Some(_) => Err("(merged[event] ?? []) is not iterable".into()),
    }
}

/// `settings` with our hooks in place: other keys and other hooks kept, any earlier entries of ours replaced
pub fn merge_hooks(settings: &Json, entries: &Json, prefixes: &[String]) -> Result<Json, String> {
    if !matches!(settings, Json::Obj(_)) {
        return Err("the settings file is not a JSON object".into());
    }
    let hooks = match settings.get("hooks") {
        None | Some(Json::Null) => Json::Obj(Vec::new()),
        Some(hooks @ Json::Obj(_)) => hooks.clone(),
        Some(_) => return Err("its hooks key is not an object".into()),
    };
    let mut merged = Json::Obj(Vec::new());
    for (event, groups) in hooks.entries() {
        let Json::Arr(groups) = groups else {
            merged.set(event, groups.clone());
            continue;
        };
        let mut kept = Vec::new();
        for group in groups {
            let group = match group.get("hooks") {
                Some(Json::Arr(handlers)) if matches!(group, Json::Obj(_)) => {
                    let mut others = Vec::new();
                    for handler in handlers {
                        if !ours(handler, prefixes)? {
                            others.push(handler.clone());
                        }
                    }
                    let mut group = group.clone();
                    group.set("hooks", Json::Arr(others));
                    group
                }
                _ => group.clone(),
            };
            kept.push(group);
        }
        kept.retain(|group| {
            !(matches!(group, Json::Obj(_))
                && matches!(group.get("hooks"), Some(Json::Arr(h)) if h.is_empty()))
        });
        merged.set(event, Json::Arr(kept));
    }
    for (event, groups) in entries.entries() {
        let mut list = spread(merged.get(event))?;
        list.extend(groups.items().iter().cloned());
        merged.set(event, Json::Arr(list));
    }
    if let Json::Obj(events) = &mut merged {
        events.retain(|(_, groups)| !matches!(groups, Json::Arr(items) if items.is_empty()));
    }
    let mut out = settings.clone();
    out.set("hooks", merged);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| (*w).to_owned()).collect()
    }

    #[test]
    fn a_quoted_word_reads_back_as_itself() {
        for word in [
            "",
            "plain",
            "/opt/swarm",
            "a b",
            "it's",
            "'",
            "''",
            "a'b'c",
            "$HOME",
            "`x`",
            "tab\there",
            "line\nbreak",
            "back\\slash",
            "ünï",
            "\"",
            "--flag=1",
            "@scp-dev/cli",
        ] {
            let quoted = shell_quote(word);
            assert_eq!(
                shell_words(&quoted),
                Some(vec![(word.to_owned(), quoted != word)]),
                "{word:?} as {quoted}"
            );
        }
    }

    #[test]
    fn guarded_commands_name_their_client_and_are_ours() {
        let launch = HookLaunch {
            launcher: Some(words(&[
                "/usr/bin/node",
                "/opt/my cli/@scp-dev/cli/dist/cli.js",
            ])),
            native: Some("/opt/it's/scp-hook".into()),
        };
        let command = hook_command(&launch, &words(&["hook", "claude"]));
        assert_eq!(
            hook_client(&Json::str(command.as_str())),
            Some(("/opt/it's/scp-hook".to_owned(), true))
        );
        assert_eq!(
            ours(
                &Json::object(vec![("command", Json::str(command.as_str()))]),
                &[]
            ),
            Ok(true)
        );
        let argv = hook_argv(&launch, &words(&["hook", "muse"]));
        assert_eq!(
            hook_client(&strings(&argv)),
            Some(("/opt/it's/scp-hook".to_owned(), true))
        );
    }

    #[test]
    fn only_a_launcher_word_makes_a_command_ours() {
        let is = |command: &str| {
            ours(&Json::object(vec![("command", Json::str(command))]), &[]) == Ok(true)
        };
        assert!(is("swarm hook claude"));
        assert!(is("/x/swarm hook"));
        assert!(is("'/a b/swarm' hook codex"));
        assert!(is("/x/scp-hook swarm hook claude"));
        assert!(is(
            "node /x/packages/cli/dist/cli.js hook claude --subagent"
        ));
        assert!(!is("echo swarm hook claude"));
        assert!(!is("swarm hooky"));
        assert!(!is("node /x/cli.js hook claude"));
        assert!(!is("myswarm hook"));
    }
}
