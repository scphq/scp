//! What spawn fills in and notes before a worker starts: its title from the prompt, its name from the program, the headless agy note.

use super::argv::{has_flag, home, program_at, spawn_prompt};
use super::output::well_formed;
use crate::args::{Parsed, Val};
use scp_broker::scrub::{find_secret, redact_secrets};
use scp_core::protocol::CLI_NAME;
use scp_mcp::ps::{Env, basename, join};
use scp_mcp::render::{js_space, strip_control};
use serde_json::Value;

/// the title cap the broker enforces, in UTF-16 units
const TITLE_UNITS: usize = 64;

/// `text.replace(/\s+/g, " ").trim()`
fn squeeze(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if js_space(c) {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    out
}

/// Redact the prompt's first nonempty line before clipping on a character boundary.
pub fn spawn_title(command: &[String]) -> Option<String> {
    let prompt = spawn_prompt(command)?;
    let first = prompt
        .split('\n')
        .map(|text| squeeze(&strip_control(text)))
        .find(|text| !text.is_empty())?;
    let line: Vec<u16> = redact_secrets(&first).encode_utf16().collect();
    let high = |u: u16| (0xd800..=0xdbff).contains(&u);
    let end = if line.len() > TITLE_UNITS && high(line[TITLE_UNITS - 1]) {
        TITLE_UNITS - 1
    } else {
        TITLE_UNITS
    };
    let clipped = String::from_utf16_lossy(&line[..end.min(line.len())]);
    let title = clipped.trim_matches(js_space);
    find_secret(title).is_none().then(|| title.to_owned())
}

const NAME_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// five random characters of the handle alphabet
pub fn name_suffix() -> String {
    let mut bytes = [0u8; 5];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes))
        .is_err()
    {
        use std::hash::{BuildHasher, Hasher};
        let seed = std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish();
        bytes.copy_from_slice(&seed.to_le_bytes()[..5]);
    }
    bytes
        .iter()
        .map(|b| NAME_ALPHABET[*b as usize % NAME_ALPHABET.len()] as char)
        .collect()
}

/// a worker's handle without --name: `<harness>-<5 random characters>`, the harness its program's basename as a valid handle
pub fn worker_name(command: &[String], random: impl FnOnce() -> String) -> String {
    let program = command.get(program_at(command)).map_or("", |p| basename(p));
    let mut dashed = String::new();
    let mut run = false;
    for c in program.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
            dashed.push(c);
            run = false;
        } else if !run {
            dashed.push('-');
            run = true;
        }
    }
    let alnum = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let harness: String = dashed
        .trim_matches(|c: char| !alnum(c))
        .chars()
        .take(57)
        .collect();
    let harness = if harness.is_empty() {
        "worker"
    } else {
        &harness
    };
    format!("{harness}-{}", random())
}

/// No scope by default: the worker has the default reach, its whole tree and the roots. A title and a name fill in when absent.
pub fn spawn_defaults(
    values: &Parsed,
    command: &[String],
    random: impl FnOnce() -> String,
) -> Parsed {
    let mut out = values.clone();
    if !values.has("title")
        && let Some(title) = spawn_title(command)
    {
        out.values.push(("title".into(), Val::Text(title)));
    }
    if !values.has("name") {
        out.values
            .push(("name".into(), Val::Text(worker_name(command, random))));
    }
    out
}

/// agy's CLI settings, which hold the permission rules setup writes
pub fn agy_settings_file(env: &Env) -> String {
    join(&[&home(env), ".gemini", "antigravity-cli", "settings.json"])
}

/// the rules that let agy call each relay tool
pub fn agy_rules() -> Vec<String> {
    scp_mcp::tools::tool_names(true)
        .iter()
        .map(|tool| format!("mcp(scp/{tool})"))
        .collect()
}

/// a note for a headless agy whose settings lack the permission rules `swarm setup` writes: it denies the relay tools without them
pub fn agy_note(command: &[String], env: &Env, verb: &str) -> Option<String> {
    let at = program_at(command);
    let args = command.get(at + 1..).unwrap_or(&[]);
    if command.get(at).is_none_or(|p| basename(p) != "agy")
        || !has_flag(args, &["-p", "--print", "--prompt"])
        || has_flag(args, &["--dangerously-skip-permissions"])
    {
        return None;
    }
    let file = agy_settings_file(env);
    let settings = std::fs::read(&file).ok().and_then(|bytes| {
        serde_json::from_str::<Value>(&well_formed(&String::from_utf8_lossy(&bytes))).ok()
    });
    let allow = settings
        .as_ref()
        .and_then(|s| s.as_object()?.get("permissions")?.as_object()?.get("allow"))
        .and_then(Value::as_array);
    if let Some(allow) = allow
        && agy_rules()
            .iter()
            .all(|rule| allow.iter().any(|v| v.as_str() == Some(rule)))
    {
        return None;
    }
    Some(format!(
        "{CLI_NAME} {verb}: headless agy denies the relay tools without the permission rules {CLI_NAME} setup writes to {file}; run {CLI_NAME} setup"
    ))
}
