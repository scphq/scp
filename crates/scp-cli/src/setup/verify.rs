//! The check after `swarm setup --write`: what each harness's own listing says of the mount, and of the Muse plugin.

use super::files::read_json;
use super::harness::{
    RunResult, SERVER, entry_right, is_object, last_line, mounted_entry, strip_ansi,
};
use super::plan::same_path;
use crate::fleet::json::Json;
use crate::fleet::mounts::mcp_file;
use crate::spawn::argv::Mount;
use scp_mcp::ps::{Env, basename};
use scp_mcp::render::js_space;
use sha2::{Digest, Sha256};

pub type Check = (bool, String);

fn listing(harness: &str) -> Option<&'static [&'static str]> {
    match harness {
        "claude" => Some(&["mcp", "get", SERVER]),
        "muse" => None,
        _ => Some(&["mcp", "list"]),
    }
}

fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// whether `text` has `what` as a whole word, ignoring case: `/\bwhat\b/i`
fn has_word(text: &str, what: &str) -> bool {
    let text = text.to_ascii_lowercase();
    text.match_indices(what).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + what.len()..].chars().next();
        !before.is_some_and(word) && !after.is_some_and(word)
    })
}

/// whether a listing line names the server: `(^|\s)scp(:|\s|$)`
fn names_server(line: &str) -> bool {
    line.match_indices(SERVER).any(|(at, _)| {
        let before = line[..at].chars().next_back();
        let after = line[at + SERVER.len()..].chars().next();
        before.is_none_or(js_space) && after.is_none_or(|c| c == ':' || js_space(c))
    })
}

fn flatten(line: &str) -> String {
    let mut flat = String::with_capacity(line.len());
    let mut gap = false;
    for c in line.chars() {
        if js_space(c) {
            if !gap {
                flat.push(' ');
            }
            gap = true;
        } else {
            flat.push(c);
            gap = false;
        }
    }
    flat
}

/// Whether a harness's own MCP listing shows the mount `want` or, without `want`, that it is gone. Claude and OpenCode start the server
/// and report it connected; Codex, Grok and agy only list it.
pub fn verify_mount(
    harness: &str,
    cli: &str,
    env: &Env,
    run: &dyn Fn(&[String]) -> RunResult,
    want: Option<&Mount>,
) -> Check {
    let file = mcp_file(harness, env);
    let Some(args) = listing(harness) else {
        let read = mounted_entry(harness, &file);
        if let (None, Err(error)) = (want, &read) {
            return (false, format!("unknown: {file} is unreadable ({error})"));
        }
        let entry = read.ok().flatten();
        let right = entry
            .as_ref()
            .is_some_and(|e| want.is_none_or(|w| entry_right(harness, e, w)));
        let place = format!("in {file} (Muse has no MCP listing command)");
        if want.is_none() {
            let word = if entry.is_some() {
                "still configured"
            } else {
                "removed"
            };
            return (entry.is_none(), format!("{word} {place}"));
        }
        let word = if right {
            "configured"
        } else if entry.is_some() {
            "failed: a different scp is configured"
        } else {
            "failed: missing"
        };
        return (right, format!("{word} {place}"));
    };
    let command = format!("{} {}", basename(cli), args.join(" "));
    let mut argv = vec![cli.to_owned()];
    argv.extend(args.iter().map(|w| (*w).to_owned()));
    let result = run(&argv);
    let text = strip_ansi(&result.output);
    let lines: Vec<&str> = text.split('\n').map(|l| l.trim_matches(js_space)).collect();
    let listed = if harness == "claude" {
        result.code == 0 && text.contains(&format!("{SERVER}:"))
    } else {
        lines.iter().any(|line| names_server(line))
    };
    let Some(mount) = want else {
        let gone = if harness == "claude" {
            text.contains(&format!("No MCP server named \"{SERVER}\""))
        } else {
            result.code == 0 && !listed
        };
        let line = if gone {
            format!("removed ({command})")
        } else if listed {
            format!("still listed by {command}")
        } else {
            format!(
                "unknown: {command} exited {}: {}",
                result.code,
                last_line(&result.output)
            )
        };
        return (gone, line);
    };
    if !listed {
        let why = if result.code != 0 {
            format!(" (exit {}: {})", result.code, last_line(&result.output))
        } else {
            String::new()
        };
        return (
            false,
            format!("failed: {command} does not list {SERVER}{why}"),
        );
    }
    let expected = mount.argv.join(" ");
    if harness == "claude" {
        let field = |name: &str| {
            lines
                .iter()
                .find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))
                .map(|rest| rest.trim_matches(js_space))
                .filter(|value| !value.is_empty())
        };
        let runs = [field("Command"), field("Args")]
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        if runs != expected {
            let shown = if runs.is_empty() {
                "an unlisted command"
            } else {
                runs.as_str()
            };
            return (
                false,
                format!("failed ({command}: it runs {shown}, not {expected})"),
            );
        }
    }
    if harness == "opencode" {
        let entry = mounted_entry(harness, &file).ok().flatten();
        if !entry.is_some_and(|e| entry_right(harness, &e, mount)) {
            return (
                false,
                format!(
                    "failed: the {SERVER} in {file} is not this local one ({command} lists a {SERVER})"
                ),
            );
        }
    }
    if harness == "claude" || harness == "opencode" {
        let status = if harness == "claude" {
            lines.iter().find(|line| line.starts_with("Status:"))
        } else {
            lines.iter().find(|line| names_server(line))
        };
        let shown = status.copied().unwrap_or("");
        let lower = shown.to_ascii_lowercase();
        let connected = shown.contains(['✔', '✓'])
            && has_word(shown, "connected")
            && !lower.contains("disconnected")
            && !lower.contains("fail");
        let shown = status.copied().unwrap_or("no status");
        let word = if connected { "mounted" } else { "failed" };
        return (connected, format!("{word} ({command}: {shown})"));
    }
    let line = lines
        .iter()
        .find(|line| names_server(line))
        .copied()
        .unwrap_or_default();
    let flat = flatten(line);
    let right =
        format!(" {flat} ").contains(&format!(" {expected} ")) && !has_word(&flat, "disabled");
    if right {
        (
            true,
            format!(
                "configured ({command} lists it; {} does not start servers to check them)",
                basename(cli)
            ),
        )
    } else {
        (false, format!("failed ({command}: {line})"))
    }
}

/// whether `muse plugins list --json` shows the scp plugin from `dir` at `manifest`'s hash; without `manifest`, that it is gone
pub fn verify_muse_plugin(
    cli: &str,
    dir: &str,
    run: &dyn Fn(&[String]) -> RunResult,
    manifest: Option<&str>,
) -> Check {
    let argv: Vec<String> = [cli, "plugins", "list", "--json"]
        .iter()
        .map(|w| (*w).to_owned())
        .collect();
    let result = run(&argv);
    let Some(report) = Json::parse(result.output.as_bytes()) else {
        return (
            false,
            format!(
                "unknown: muse plugins list --json exited {}: {}",
                result.code,
                last_line(&result.output)
            ),
        );
    };
    if report == Json::Null {
        return (
            false,
            format!(
                "unknown: muse plugins list --json exited {}: {}",
                result.code,
                last_line(&result.output)
            ),
        );
    }
    let record = report.get("plugins").and_then(|plugins| {
        let found = plugins.items().iter().find(|plugin| {
            is_object(plugin)
                && plugin
                    .get("record")
                    .filter(|record| is_object(record))
                    .is_some_and(|record| record.get("id").and_then(Json::as_str) == Some(SERVER))
        })?;
        found.get("record").filter(|record| is_object(record))
    });
    let from = record
        .and_then(|r| r.get("source"))
        .filter(|source| is_object(source))
        .map(|source| crate::fleet::view::text(source.get("path")));
    let ours = same_path(from.as_deref(), dir);
    let Some(manifest) = manifest else {
        let line = if ours {
            "still installed (muse plugins list)"
        } else {
            "removed (muse plugins list)"
        };
        return (!ours, line.to_owned());
    };
    if !ours {
        return (
            false,
            "failed: muse plugins list does not show the scp plugin from setup".to_owned(),
        );
    }
    let digest: String = Sha256::digest(manifest.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let record = record.cloned().unwrap_or(Json::Null);
    let current = record.get("manifest_sha256").and_then(Json::as_str)
        == Some(format!("sha256:{digest}").as_str())
        && record.get("enabled") != Some(&Json::Bool(false));
    let line = if current {
        "installed (muse plugins list)"
    } else {
        "failed: Muse has another version of the plugin, or it is disabled (muse plugins list)"
    };
    (current, line.to_owned())
}

/// keeps `claude --version` where the hooks read it, so a stop of an older Claude Code blocks; a failure keeps the last one
pub fn cache_claude_version(cli: &str, env: &Env, run: &dyn Fn(&[String]) -> RunResult) {
    let result = run(&[cli.to_owned(), "--version".to_owned()]);
    let version = super::harness::dotted_version(&result.output);
    let (0, Some(version)) = (result.code, version) else {
        return;
    };
    let file = super::harness::claude_version_file(env);
    if std::fs::create_dir_all(scp_mcp::ps::dirname(&file)).is_ok() {
        let _ = std::fs::write(&file, format!("{version}\n"));
    }
}

/// how many of the agy rules `file` allows
pub fn agy_rules_present(file: &str, rules: &[String]) -> usize {
    let config = read_json(file).ok().flatten();
    let allow = config
        .as_ref()
        .and_then(|c| c.get("permissions"))
        .and_then(|p| p.get("allow"));
    let Some(Json::Arr(allow)) = allow else {
        return 0;
    };
    rules
        .iter()
        .filter(|rule| {
            allow
                .iter()
                .any(|item| item.as_str() == Some(rule.as_str()))
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_names_the_server_only_as_a_word() {
        assert!(names_server("scp: /bin/x"));
        assert!(names_server("  scp /bin/x"));
        assert!(names_server("a scp"));
        assert!(!names_server("scpx"));
        assert!(!names_server("xscp:"));
    }

    #[test]
    fn a_connected_status_is_a_whole_word() {
        assert!(has_word("✓ Connected", "connected"));
        assert!(!has_word("Disconnected", "connected"));
        assert_eq!(flatten("a  \t b"), "a b");
    }
}
