//! `swarm mcp install`: the command, or config snippet, that mounts the relay MCP shim in a harness; printed, never run.

use super::hook_cmd::AGY_UNVERIFIED;
use crate::args::js_string;
use crate::fleet::json::Json;
use crate::term::out;
use crate::{Call, Done, Fail, usage};
use scp_core::address::valid_handle;
use scp_core::protocol::CLI_NAME;

/// the words after `mcp` the router hands to this binary; `swarm mcp` itself is the shim, which the TypeScript CLI still starts
pub const MCP_WORDS: [&str; 1] = ["install"];

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

/// `swarm mcp install --harness H [--as NAME]`; the shim itself goes to the TypeScript CLI
pub fn mcp(call: &Call) -> Done {
    let parsed = &call.parsed;
    if parsed.positionals.first().map(String::as_str) != Some("install") {
        return Err(Fail::Decline("the MCP shim".into()));
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
