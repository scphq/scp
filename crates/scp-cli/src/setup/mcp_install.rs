//! `swarm mcp install`: the command, or config snippet, that mounts the relay MCP shim in a harness; printed, never run.

use super::hook_cmd::AGY_UNVERIFIED;
use crate::args::{js_string, parse_verb};
use crate::fleet::json::Json;
use crate::spawn::argv::executable;
use crate::term::{note, out};
use crate::{Call, Done, Fail, help, route, usage};
use scp_core::address::valid_handle;
use scp_core::protocol::CLI_NAME;
use scp_mcp::shim::SHIM_PPID;
use std::os::unix::process::CommandExt;
use std::path::Path;

fn shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/=-".contains(c));
    if plain {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

fn strings(words: &[String]) -> Json {
    Json::Arr(words.iter().map(|w| Json::str(w.as_str())).collect())
}

/// the lines `mcp install` prints for `harness`, mounting the shim as `name` when given
pub fn mcp_install(harness: Option<&str>, name: Option<&str>) -> Result<Vec<String>, Fail> {
    if let Some(name) = name
        && !valid_handle(name)
    {
        return Err(usage(format!(
            "--as {} is not a valid agent handle",
            js_string(name)
        )));
    }
    let args = |extra: &[&str]| -> Vec<String> {
        let mut words = vec!["mcp".to_owned()];
        words.extend(extra.iter().map(|w| (*w).to_owned()));
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            words.extend(["--as".to_owned(), name.to_owned()]);
        }
        words
    };
    let line = |cli: &str, extra: &[&str]| -> String {
        [cli, "mcp", "add", "scp", "--", CLI_NAME]
            .iter()
            .map(|w| (*w).to_owned())
            .chain(args(extra))
            .map(|w| shell_word(&w))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let snippet = |root: &str, server: Vec<(&str, Json)>| {
        Json::object(vec![(
            root,
            Json::object(vec![("scp", Json::object(server))]),
        )])
        .pretty()
    };
    Ok(match harness {
        Some("claude") => vec![line("claude", &["--harness", "claude", "--channels"])],
        Some("codex") => vec![line("codex", &["--harness", "codex"])],
        Some("grok") => vec![line("grok", &["--harness", "grok"])],
        Some("opencode") => {
            let mut command = vec![CLI_NAME.to_owned()];
            command.extend(args(&["--harness", "opencode"]));
            vec![
                line("opencode", &["--harness", "opencode"]),
                "# that writes OpenCode's global config; for one project, add this to its opencode.json instead:".into(),
                snippet(
                    "mcp",
                    vec![
                        ("type", Json::str("local")),
                        ("command", strings(&command)),
                        ("enabled", Json::Bool(true)),
                    ],
                ),
            ]
        }
        Some("agy") => vec![
            line("agy", &["--harness", "agy"]),
            "# that always writes your user file ~/.gemini/config/mcp_config.json; for one project, add this to <repo>/.agents/mcp_config.json instead:".into(),
            snippet(
                "mcpServers",
                vec![
                    ("command", Json::str(CLI_NAME)),
                    ("args", strings(&args(&["--harness", "agy"]))),
                ],
            ),
            format!("# {AGY_UNVERIFIED}"),
        ],
        Some("muse") => vec![
            "# Muse has no mcp add: merge this into ~/.config/muse/settings.json (never add a mcp_servers key next to mcpServers, Muse then drops every MCP server)".into(),
            snippet(
                "mcpServers",
                vec![
                    ("type", Json::str("stdio")),
                    ("command", Json::str(CLI_NAME)),
                    ("args", strings(&args(&["--harness", "muse"]))),
                    ("mode", Json::str("optional")),
                ],
            ),
        ],
        _ => {
            return Err(usage(
                "mcp install takes --harness claude, codex, opencode, grok, muse or agy",
            ));
        }
    })
}

/// the server `$SCP_MCP_BIN` names in place of this process, as a routed `swarm mcp` runs it; returns when it cannot, saying so
fn exec_named_server(bin: &str, words: &[String]) {
    if !(Path::new(bin).is_absolute() && executable(bin)) {
        note(&format!(
            "no usable native MCP server ({bin} is not an executable file); the built-in one serves this session"
        ));
        return;
    }
    let _ = std::process::Command::new(bin).args(words).exec();
    note(&format!(
        "could not start the native MCP server {bin}; the built-in one serves this session"
    ));
}

/// tells the shim who the harness is when a router stands between them
fn hand_parent_to_shim() {
    // SAFETY: no other thread runs yet: the shim's runtime starts after this
    unsafe {
        match route::router_parent() {
            Some(parent) => std::env::set_var(SHIM_PPID, parent.to_string()),
            None => std::env::remove_var(SHIM_PPID),
        }
    }
}

/// `swarm mcp`, the stdio shim, or `swarm mcp install --harness H [--as NAME]`
pub fn mcp(call: &Call, words: &[String]) -> Done {
    let parsed = parse_verb("mcp", words).map_err(Fail::Usage)?;
    if parsed.has("help") {
        return help::show("mcp", parsed.on("all"));
    }
    if parsed.positionals.first().map(String::as_str) != Some("install") {
        if let Ok(exe) = std::env::current_exe() {
            scp_mcp::spawn::set_native_daemon(exe);
        }
        if route::routed() {
            hand_parent_to_shim();
            if let Some(bin) = call.env.get("SCP_MCP_BIN") {
                exec_named_server(bin, words);
            }
        }
        return Ok(scp_mcp::main(words));
    }
    if parsed.positionals.len() > 1 || parsed.on("human") || parsed.on("channels") {
        return Err(usage(format!(
            "{CLI_NAME} mcp install takes --harness H and optionally --as NAME"
        )));
    }
    for line in mcp_install(parsed.text("harness"), parsed.text("as"))? {
        out(&line);
    }
    Ok(0)
}
