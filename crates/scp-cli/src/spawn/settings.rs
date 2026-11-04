//! How long spawn holds a worker: durations as the CLI reads them, and the idle settings from the environment and config.json.

use super::output::well_formed;
use scp_mcp::identity::read_owned_file;
use scp_mcp::ps::{Env, join};
use scp_mcp::render::js_space;
use serde_json::Value;

/// how long a spawn holds a worker it can resume while no message comes, in seconds, unless a setting or `swarm spawn --idle` says otherwise
pub const SPAWN_IDLE_S: f64 = 600.0;

/// `String.prototype.trim`
fn js_trim(text: &str) -> &str {
    text.trim_matches(js_space)
}

/// `^\d+(\.\d+)?` at the start of `text`: how many bytes it takes
fn number_len(text: &str) -> usize {
    let bytes = text.as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let whole = digits(0);
    if whole == 0 || bytes.get(whole) != Some(&b'.') {
        return whole;
    }
    match digits(whole + 1) {
        0 => whole,
        fraction => whole + 1 + fraction,
    }
}

/// `text` when all of it matches `^\d+(\.\d+)?$`, as a number
fn plain_number(text: &str) -> Option<f64> {
    (!text.is_empty() && number_len(text) == text.len())
        .then(|| text.parse().unwrap_or(f64::INFINITY))
}

/// the seconds of a duration such as `1h30m`, when all of `text` is one
fn duration(mut text: &str) -> Option<f64> {
    let mut seconds = 0.0;
    if text.is_empty() {
        return None;
    }
    while !text.is_empty() {
        let at = number_len(text);
        if at == 0 {
            return None;
        }
        let value: f64 = text[..at].parse().unwrap_or(f64::INFINITY);
        let rest = &text[at..];
        let (unit, size) = [
            ("ms", 0.001),
            ("s", 1.0),
            ("m", 60.0),
            ("h", 3600.0),
            ("d", 86400.0),
        ]
        .into_iter()
        .find(|(unit, _)| rest.starts_with(unit))?;
        seconds += value * size;
        text = &rest[unit.len()..];
    }
    Some(seconds)
}

/// `90s`, `30m`, `1h30m`; a bare number is seconds. Whole seconds out, at least one.
pub fn parse_seconds(text: &str, flag: &str) -> Result<f64, String> {
    let trimmed = js_trim(text);
    let seconds = plain_number(trimmed).or_else(|| duration(trimmed));
    let Some(seconds) = seconds else {
        return Err(format!(
            "{flag} {} is not a duration like 90s, 30m or 1h30m",
            crate::args::js_string(text)
        ));
    };
    if seconds.is_nan() || seconds <= 0.0 {
        return Err(format!("{flag} must be more than zero"));
    }
    Ok(seconds.ceil().max(1.0))
}

fn seconds_text(text: &str) -> Option<f64> {
    if text == "Infinity" {
        return Some(f64::INFINITY);
    }
    plain_number(js_trim(text)).or_else(|| parse_seconds(text, "stop_after_s").ok())
}

/// idle seconds: a number, a duration such as 30m, or Infinity; None when unreadable
pub fn seconds(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite() && *n >= 0.0),
        Value::String(text) => seconds_text(text),
        _ => None,
    }
}

/// the relay configuration's directory: `$XDG_CONFIG_HOME`, else ~/.config, then `scp`
fn config_dir(env: &Env) -> Option<String> {
    let nonempty = |key: &str| env.get(key).filter(|v| !v.is_empty());
    let base = match nonempty("XDG_CONFIG_HOME") {
        Some(base) => base.clone(),
        None => join(&[nonempty("HOME")?, ".config"]),
    };
    Some(join(&[&base, "scp"]))
}

/// config.json, empty when unreadable
pub fn config_file(env: &Env) -> Value {
    config_dir(env)
        .and_then(|dir| read_owned_file(&join(&[&dir, "config.json"])).ok())
        .and_then(|text| serde_json::from_str::<Value>(&well_formed(&text)).ok())
        .filter(|value| value.is_object() || value.is_array())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

fn section_idle<'a>(file: &'a Value, key: &str) -> Option<&'a Value> {
    file.as_object()?.get(key)?.as_object()?.get("idle_after_s")
}

/// `$<own>`, else `<key>.idle_after_s`, else the shared `$SCP_IDLE_AFTER_S`, else `lifecycle.idle_after_s`; None when none is set
pub fn idle_setting(env: &Env, file: &Value, own: &str, key: &str) -> Option<f64> {
    let var = |name: &str| env.get(name).and_then(|text| seconds_text(text));
    var(own)
        .or_else(|| seconds(section_idle(file, key)))
        .or_else(|| var("SCP_IDLE_AFTER_S"))
        .or_else(|| seconds(section_idle(file, "lifecycle")))
}

/// how long a spawn holds a worker it can resume, by the settings, else 600 s
pub fn spawn_idle_default(env: &Env) -> f64 {
    idle_setting(env, &config_file(env), "SCP_SPAWN_IDLE_AFTER_S", "spawn").unwrap_or(SPAWN_IDLE_S)
}
