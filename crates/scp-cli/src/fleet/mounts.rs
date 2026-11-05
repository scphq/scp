//! What `swarm status` reads off this machine: the broker's engine, the MCP mount each harness runs, and hooks whose native client is gone.

use super::json::Json;
use super::view::text;
use scp_core::protocol::CLI_NAME;
use scp_mcp::ps::{Env, capture, join};
use scp_mcp::render::js_space;
use std::collections::HashSet;

/// `path.basename`
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(at) => &trimmed[at + 1..],
        None => trimmed,
    }
}

/// `native` when process `pid` runs a native broker executable, `ts` for any other, None when the process table does not say
pub fn broker_engine(pid: &Json) -> Option<&'static str> {
    let pid = text(Some(pid));
    let program = capture(&["ps", "-p", &pid, "-o", "comm="], None, Some(2000), None)?;
    let program = program.trim_matches(js_space);
    if program.is_empty() {
        return None;
    }
    Some(match basename(program) {
        "swarm" | "scp-broker" => "native",
        _ => "ts",
    })
}

/// what `SCP_NATIVE` runs natively: `all` for `1`, `mcp` for `mcp`, else `off`
pub fn native_mode(value: Option<&str>) -> &'static str {
    match value {
        Some("1") => "all",
        Some("mcp") => "mcp",
        _ => "off",
    }
}

fn home(env: &Env) -> String {
    env.get("HOME")
        .filter(|h| !h.is_empty())
        .cloned()
        .unwrap_or_else(scp_mcp::identity::home_dir)
}

fn var<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    env.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

fn config_home(env: &Env) -> String {
    var(env, "XDG_CONFIG_HOME").map_or_else(|| join(&[&home(env), ".config"]), str::to_owned)
}

fn exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

/// a JSON object file: None when missing, {} when empty, Err when it is no JSON object
fn read_json(file: &str) -> Result<Option<Json>, ()> {
    if !exists(file) {
        return Ok(None);
    }
    let bytes = std::fs::read(file).map_err(|_| ())?;
    let text = String::from_utf8_lossy(&bytes);
    if text.trim_matches(js_space).is_empty() {
        return Ok(Some(Json::Obj(Vec::new())));
    }
    match Json::parse(text.as_bytes()) {
        Some(object @ Json::Obj(_)) => Ok(Some(object)),
        _ => Err(()),
    }
}

/// a TOML value as `smol-toml` hands it over: a date is an object with no keys of its own, never a string
pub(crate) fn from_toml(value: &toml::Value) -> Json {
    match value {
        toml::Value::String(s) => Json::Str(s.clone()),
        toml::Value::Integer(n) => Json::Num(*n as f64),
        toml::Value::Float(n) => Json::Num(*n),
        toml::Value::Boolean(on) => Json::Bool(*on),
        toml::Value::Datetime(_) => Json::Obj(Vec::new()),
        toml::Value::Array(items) => Json::Arr(items.iter().map(from_toml).collect()),
        toml::Value::Table(table) => Json::Obj(
            table
                .iter()
                .map(|(k, v)| (k.clone(), from_toml(v)))
                .collect(),
        ),
    }
}

fn read_toml(file: &str) -> Result<Option<Json>, ()> {
    if !exists(file) {
        return Ok(None);
    }
    let bytes = std::fs::read(file).map_err(|_| ())?;
    let text = String::from_utf8_lossy(&bytes);
    let table: toml::Table = text.parse().map_err(|_| ())?;
    Ok(Some(from_toml(&toml::Value::Table(table))))
}

const SERVER: &str = "scp";
const SETUP_HARNESSES: [&str; 6] = ["claude", "codex", "opencode", "grok", "muse", "agy"];

/// the user-level file that holds a harness's MCP servers
pub(crate) fn mcp_file(harness: &str, env: &Env) -> String {
    match harness {
        "claude" => match var(env, "CLAUDE_CONFIG_DIR") {
            Some(dir) => join(&[dir, ".claude.json"]),
            None => join(&[&home(env), ".claude.json"]),
        },
        "codex" => join(&[
            &var(env, "CODEX_HOME").map_or_else(|| join(&[&home(env), ".codex"]), str::to_owned),
            "config.toml",
        ]),
        "grok" => join(&[&home(env), ".grok", "config.toml"]),
        "muse" => join(&[&config_home(env), "muse", "settings.json"]),
        "agy" => join(&[&home(env), ".gemini", "config", "mcp_config.json"]),
        _ => {
            let dir = join(&[&config_home(env), "opencode"]);
            let files: Vec<String> = ["opencode.json", "opencode.jsonc", "config.json"]
                .iter()
                .map(|name| join(&[&dir, name]))
                .filter(|file| exists(file))
                .collect();
            let unreadable = files.iter().find(|file| read_json(file).is_err());
            let mounted = files.iter().find(|file| {
                unreadable.is_none()
                    && read_json(file)
                        .ok()
                        .flatten()
                        .and_then(|config| config.get("mcp").and_then(|m| m.get(SERVER)).cloned())
                        .is_some_and(|entry| super::view::truthy(Some(&entry)))
            });
            unreadable
                .or(mounted)
                .or(files.first())
                .cloned()
                .unwrap_or_else(|| join(&[&dir, "opencode.json"]))
        }
    }
}

/// the scp entry a harness has now
pub(crate) fn mounted_entry(harness: &str, file: &str) -> Result<Option<Json>, ()> {
    let toml = harness == "codex" || harness == "grok";
    let config = if toml {
        read_toml(file)?
    } else {
        read_json(file)?
    };
    let key = match harness {
        "codex" | "grok" => "mcp_servers",
        "opencode" => "mcp",
        _ => "mcpServers",
    };
    let entry = config
        .as_ref()
        .and_then(|c| c.get(key))
        .filter(|t| matches!(t, Json::Obj(_)))
        .and_then(|t| t.get(SERVER));
    Ok(entry.filter(|e| matches!(e, Json::Obj(_))).cloned())
}

pub(crate) fn entry_argv(harness: &str, entry: &Json) -> Vec<String> {
    let strings = |value: Option<&Json>| match value {
        Some(Json::Arr(items)) => items.iter().map(|i| text(Some(i))).collect(),
        _ => Vec::new(),
    };
    if harness == "opencode" {
        return strings(entry.get("command"));
    }
    let command = match entry.get("command") {
        None | Some(Json::Null) => String::new(),
        some => text(some),
    };
    std::iter::once(command)
        .chain(strings(entry.get("args")))
        .collect()
}

/// an entry's `SCP_NATIVE`, when it is a string
fn entry_native<'a>(harness: &str, entry: &'a Json) -> Option<&'a str> {
    let key = if harness == "opencode" {
        "environment"
    } else {
        "env"
    };
    entry
        .get(key)
        .filter(|vars| matches!(vars, Json::Obj(_)))
        .and_then(|vars| vars.get("SCP_NATIVE"))
        .and_then(Json::as_str)
}

/// the MCP server a harness's user mount runs
#[derive(Debug, Clone, PartialEq)]
pub struct MountEngine {
    pub harness: &'static str,
    pub engine: &'static str,
    pub mode: &'static str,
}

/// the engine of each harness's user mount, leaving out harnesses with none or an unreadable file
pub fn mount_engines(env: &Env) -> Vec<MountEngine> {
    SETUP_HARNESSES
        .iter()
        .filter_map(|harness| {
            let entry = mounted_entry(harness, &mcp_file(harness, env))
                .ok()
                .flatten()?;
            let mode = native_mode(entry_native(harness, &entry));
            let native = entry_argv(harness, &entry).get(1).map(String::as_str) == Some("mcp")
                && mode != "off";
            Some(MountEngine {
                harness,
                engine: if native { "native" } else { "node" },
                mode: if native { mode } else { "off" },
            })
        })
        .collect()
}

pub fn mounts_json(env: &Env, mounts: &[MountEngine]) -> Json {
    Json::object(vec![
        (
            "mode",
            Json::str(native_mode(env.get("SCP_NATIVE").map(String::as_str))),
        ),
        (
            "mounts",
            Json::Arr(
                mounts
                    .iter()
                    .map(|m| {
                        Json::object(vec![
                            ("harness", Json::str(m.harness)),
                            ("engine", Json::str(m.engine)),
                            ("mode", Json::str(m.mode)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}

/// the MCP line of `swarm status`: each harness mount's engine; None without mounts
pub fn mcp_line(mounts: &[MountEngine]) -> Option<String> {
    let words: Vec<String> = mounts
        .iter()
        .map(|m| {
            let mode = if m.engine == "native" {
                format!(
                    " (SCP_NATIVE={})",
                    if m.mode == "all" { "1" } else { m.mode }
                )
            } else {
                String::new()
            };
            format!("{} {}{mode}", m.harness, m.engine)
        })
        .collect();
    (!words.is_empty()).then(|| format!("mcp: {}", words.join(", ")))
}

/// a command line's words with shell quoting and escapes removed, each marked when quoting touched it; None when a quote is left open
pub fn shell_words(command: &str) -> Option<Vec<(String, bool)>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let (mut open, mut quoted) = (false, false);
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some('\'') => {
                if c == '\'' {
                    quote = None;
                } else {
                    word.push(c);
                }
            }
            Some(_) => {
                if c == '"' {
                    quote = None;
                } else if c == '\\' && chars.peek().is_some() {
                    word.extend(chars.next());
                } else {
                    word.push(c);
                }
            }
            None if js_space(c) => {
                if open {
                    words.push((std::mem::take(&mut word), quoted));
                }
                word.clear();
                open = false;
                quoted = false;
            }
            None => {
                open = true;
                if c == '\'' || c == '"' {
                    quote = Some(c);
                } else if c == '\\' && chars.peek().is_some() {
                    word.extend(chars.next());
                } else {
                    word.push(c);
                }
                if matches!(c, '\'' | '"' | '\\') {
                    quoted = true;
                }
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if open {
        words.push((word, quoted));
    }
    Some(words)
}

const ARGV_GUARD: &str = "[ -x \"$0\" ] && exec \"$0\" \"$@\"; exec \"$@\"";

/// whether `words` start this CLI's hook: a launcher of one or two words, then `hook`
fn runs_hook(words: &[String]) -> bool {
    words.get(1).is_some_and(|w| w == "hook") || words.get(2).is_some_and(|w| w == "hook")
}

/// the native hook client a hook command of ours starts, and whether the command runs the CLI without it once it is gone
pub fn hook_client(command: &Json) -> Option<(String, bool)> {
    if let Json::Arr(items) = command {
        let words: Vec<String> = items
            .iter()
            .map(|w| w.as_str().map(str::to_owned))
            .collect::<Option<_>>()?;
        if words.len() > 3
            && words[0] == "/bin/sh"
            && words[1] == "-c"
            && words[2] == ARGV_GUARD
            && !words[3].is_empty()
            && runs_hook(&words[4..])
        {
            return Some((words[3].clone(), true));
        }
        return (words
            .first()
            .is_some_and(|w| !w.is_empty() && basename(w) == "scp-hook")
            && runs_hook(&words[1..]))
        .then(|| (words[0].clone(), false));
    }
    let parsed = shell_words(command.as_str()?)?;
    let texts: Vec<String> = parsed.iter().map(|(t, _)| t.clone()).collect();
    let words: Vec<String> = parsed
        .iter()
        .map(|(t, q)| if *q { format!("'{t}") } else { t.clone() })
        .collect();
    let at = |i: usize| words.get(i).map(String::as_str);
    let or = words.iter().position(|w| w == "||");
    let bin = texts.get(2).filter(|b| !b.is_empty());
    if let (Some(bin), Some(or)) = (bin, or)
        && at(0) == Some("[")
        && at(1) == Some("-x")
        && at(3) == Some("]")
        && at(4) == Some("&&")
        && at(5) == Some("exec")
        && at(6) == at(2)
        && or > 7
    {
        let rest = &words[7..or];
        let fallback = &words[or + 1..];
        return (fallback.first().is_some_and(|w| w == "exec")
            && fallback[1..] == *rest
            && runs_hook(&texts[7..or]))
        .then(|| (bin.clone(), true));
    }
    (texts.first().is_some_and(|w| basename(w) == "scp-hook") && runs_hook(&texts[1..]))
        .then(|| (texts[0].clone(), false))
}

/// whether `bin` is an absolute path that is no executable file
pub(crate) fn gone_command(bin: &str) -> bool {
    if !bin.starts_with('/') {
        return false;
    }
    let Ok(path) = std::ffi::CString::new(bin) else {
        return true;
    };
    // SAFETY: a NUL-terminated path it owns
    if unsafe { libc::access(path.as_ptr(), libc::X_OK) } != 0 {
        return true;
    }
    !std::fs::metadata(bin).is_ok_and(|m| m.is_file())
}

fn commands<'a>(value: &'a Json, out: &mut Vec<&'a Json>) {
    match value {
        Json::Arr(items) => {
            for item in items {
                commands(item, out);
            }
        }
        Json::Obj(_) => {
            for (key, inner) in value.entries() {
                if key == "command" {
                    out.push(inner);
                } else {
                    commands(inner, out);
                }
            }
        }
        _ => {}
    }
}

/// the end of a JavaScript string literal `"..."` at the start of `text`, as `"(?:[^"\\]|\\.)*"` matches it
fn literal(text: &str) -> Option<usize> {
    let mut chars = text.char_indices();
    if chars.next()?.1 != '"' {
        return None;
    }
    while let Some((at, c)) = chars.next() {
        match c {
            '"' => return Some(at + 1),
            '\\' => match chars.next() {
                Some((_, '\n' | '\r' | '\u{2028}' | '\u{2029}')) | None => return None,
                Some(_) => {}
            },
            _ => {}
        }
    }
    None
}

fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// the hook client a user-scope OpenCode plugin runs: its `const NATIVE` line, else its first argv word
fn opencode_client(text: &str) -> Result<Option<(String, bool)>, ()> {
    let guarded = text.split(line_end).find_map(|line| {
        let rest = line.strip_prefix("const NATIVE = ")?;
        (literal(rest)? == rest.len()).then_some(rest)
    });
    let plain = || {
        text.match_indices("const args = [")
            .find_map(|(at, found)| {
                let rest = &text[at + found.len()..];
                literal(rest).map(|end| &rest[..end])
            })
    };
    let source = match guarded {
        Some(found) => Some(found),
        None => plain(),
    };
    let Some(source) = source else {
        return Ok(None);
    };
    let bin: String = match Json::parse(source.as_bytes()) {
        Some(Json::Str(bin)) => bin,
        _ => return Err(()),
    };
    Ok(
        (!bin.is_empty() && (guarded.is_some() || basename(&bin) == "scp-hook"))
            .then_some((bin, guarded.is_some())),
    )
}

/// the gone native hook clients `file`, the hooks of `harness`, runs, as (bin, guarded)
pub fn gone_clients(harness: &str, file: &str) -> Vec<(String, bool)> {
    let found: Vec<(String, bool)> = (|| -> Result<Vec<(String, bool)>, ()> {
        if !exists(file) {
            return Ok(Vec::new());
        }
        let bytes = std::fs::read(file).map_err(|_| ())?;
        let text = String::from_utf8_lossy(&bytes);
        if harness == "opencode" {
            return Ok(opencode_client(&text)?.into_iter().collect());
        }
        let config = Json::parse(text.as_bytes()).ok_or(())?;
        if config == Json::Null {
            return Err(());
        }
        let hooks = match harness {
            "agy" => config.get("scp"),
            "muse" => config.get("capabilities").and_then(|c| c.get("hooks")),
            _ => config.get("hooks"),
        };
        let mut list = Vec::new();
        if let Some(hooks) = hooks {
            commands(hooks, &mut list);
        }
        Ok(list.into_iter().filter_map(hook_client).collect())
    })()
    .unwrap_or_default();
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|(bin, guarded)| gone_command(bin) && seen.insert((bin.clone(), *guarded)))
        .collect()
}

/// where `hooks install` writes for a harness at user scope
fn hooks_target(harness: &str, env: &Env) -> String {
    match harness {
        "claude" => join(&[
            &var(env, "CLAUDE_CONFIG_DIR")
                .map_or_else(|| join(&[&home(env), ".claude"]), str::to_owned),
            "settings.json",
        ]),
        "codex" => join(&[
            &var(env, "CODEX_HOME").map_or_else(|| join(&[&home(env), ".codex"]), str::to_owned),
            "hooks.json",
        ]),
        "opencode" => join(&[&config_home(env), "opencode", "plugin", "scp.ts"]),
        "agy" => join(&[&home(env), ".gemini", "config", "hooks.json"]),
        _ => join(&[
            &config_home(env),
            "scp",
            "muse-plugin",
            ".muse-plugin",
            "plugin.json",
        ]),
    }
}

/// what to say about each gone native hook client the user-scope hooks of every harness run
pub fn gone_hook_lines(env: &Env) -> Vec<String> {
    ["claude", "codex", "opencode", "agy", "muse"]
        .iter()
        .flat_map(|harness| {
            let file = hooks_target(harness, env);
            gone_clients(harness, &file)
                .into_iter()
                .map(move |(bin, guarded)| {
                    if guarded {
                        format!(
                            "{file} runs the native hook client {bin}, which is gone: its hooks run through Node until {CLI_NAME} setup --write runs again"
                        )
                    } else {
                        format!(
                            "{file} runs every {harness} hook through {bin}, which is gone: those hooks fail until {CLI_NAME} setup --write runs again"
                        )
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_clients_are_read_off_the_commands_setup_writes() {
        let guard = Json::str(
            "[ -x '/opt/scp-hook' ] && exec '/opt/scp-hook' swarm hook claude || exec swarm hook claude",
        );
        assert_eq!(hook_client(&guard), Some(("/opt/scp-hook".into(), true)));
        let plain = Json::str("/opt/bin/scp-hook swarm hook codex");
        assert_eq!(
            hook_client(&plain),
            Some(("/opt/bin/scp-hook".into(), false))
        );
        let argv = Json::Arr(
            [
                "/bin/sh",
                "-c",
                ARGV_GUARD,
                "/opt/scp-hook",
                "swarm",
                "hook",
                "agy",
            ]
            .map(Json::str)
            .to_vec(),
        );
        assert_eq!(hook_client(&argv), Some(("/opt/scp-hook".into(), true)));
        assert_eq!(hook_client(&Json::str("swarm hook claude")), None);
        assert_eq!(hook_client(&Json::str("'open")), None);
    }

    #[test]
    fn an_opencode_plugin_names_its_client_on_its_native_line() {
        assert_eq!(
            opencode_client("x\nconst NATIVE = \"/a/b\"\nconst args = [\"/c/scp-hook\"]"),
            Ok(Some(("/a/b".into(), true)))
        );
        assert_eq!(
            opencode_client("const args = [\"/c/scp-hook\", \"hook\"]"),
            Ok(Some(("/c/scp-hook".into(), false)))
        );
        assert_eq!(opencode_client("const args = [\"/c/node\"]"), Ok(None));
        assert_eq!(opencode_client("const NATIVE = \"\\x\""), Err(()));
    }
}
