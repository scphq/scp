//! What a spawn asks the broker for, and the environment its harness runs in.

use super::settings::parse_seconds;
use crate::args::{Parsed, Val, js_string};
use crate::{Fail, usage};
use scp_mcp::ps::Env;
use scp_mcp::render::js_space;
use scp_mcp::spawn::SPAWN_RUNNER;
use serde_json::{Map, Value};

/// the grant's life unless --ttl sets it, in seconds
const SPAWN_GRANT_TTL_S: i64 = 3600;
const PRESETS: [&str; 4] = ["open", "tree", "parent", "none"];

/// the spawner's own identity, which the harness it starts must not inherit
const SPAWNER_IDENTITY: [&str; 20] = [
    "CLAUDE_BG_SOURCE",
    "CLAUDE_CODE_SESSION_KIND",
    "CLAUDE_CODE_IS_COWORK",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_WORKSPACE_HOST_PATHS",
    "SCP_NAME",
    "SCP_SESSION",
    "SCP_GRANT",
    "SCP_PARENT",
    "SCP_UNDER",
    "SCP_HARNESS",
    "SCP_SHIM_BINDING",
    "SCP_HARNESS_PID",
    "SCP_HARNESS_ORIGIN",
    SPAWN_RUNNER,
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    "SCP_AGY_CONVERSATION_FILE",
];

/// a request's parameters in the order the CLI writes them
pub type Params = Vec<(String, Value)>;

/// `object[key] = value`, which keeps a key where it was
fn assign(params: &mut Params, key: &str, value: Value) {
    match params.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = value,
        None => params.push((key.to_owned(), value)),
    }
}

/// `a,b, c` as a selector list; repeated flags add up
fn selector_list(values: &Parsed, key: &str) -> Option<Vec<String>> {
    let words = match values.get(key)? {
        Val::Flag(_) => return None,
        Val::Text(text) => std::slice::from_ref(text),
        Val::List(items) => items.as_slice(),
    };
    Some(
        words
            .iter()
            .flat_map(|word| word.split(','))
            .map(|word| word.trim_matches(js_space))
            .filter(|word| !word.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

fn preset(values: &Parsed) -> Result<Option<String>, Fail> {
    match values.get("scope") {
        None => Ok(None),
        Some(Val::Text(text)) if PRESETS.contains(&text.as_str()) => Ok(Some(text.clone())),
        Some(_) => Err(usage("--scope takes open, tree, parent or none")),
    }
}

fn seconds_value(seconds: f64) -> Value {
    if seconds.abs() < 9_007_199_254_740_992.0 {
        Value::from(seconds as i64)
    } else {
        Value::from(seconds)
    }
}

/// `grantParams`: the flags of a grant, in the order the CLI writes them
pub fn grant_params(values: &Parsed) -> Result<Params, Fail> {
    let rules = selector_list(values, "rules");
    if rules.is_some() && values.has("scope") {
        return Err(usage("--rules and --scope both set a preset; pick one"));
    }
    let mut allow = rules.clone().unwrap_or_default();
    allow.extend(selector_list(values, "allow").unwrap_or_default());
    let scope = if rules.is_some() {
        Some("none".to_owned())
    } else {
        preset(values)?
    };
    let groups = selector_list(values, "group");
    let mut params = Params::new();
    let mut put = |key: &str, value: Value| params.push((key.to_owned(), value));
    if let Some(name) = values.text("name").filter(|name| !name.is_empty()) {
        put("name", Value::from(name));
    }
    if let Some(title) = values.text("title") {
        put("title", Value::from(title));
    }
    if let Some(under) = values.text("under").filter(|under| !under.is_empty()) {
        put("under", Value::from(under));
    }
    if let Some(scope) = scope.filter(|scope| !scope.is_empty()) {
        put("scope", Value::from(scope));
    }
    if let Some(incoming) = selector_list(values, "in") {
        put("in", Value::from(incoming));
    }
    if let Some(outgoing) = selector_list(values, "out") {
        put("out", Value::from(outgoing));
    }
    if !allow.is_empty() {
        put("allow", Value::from(allow));
    }
    if let Some(groups) = groups.filter(|groups| !groups.is_empty()) {
        put("groups", Value::from(groups));
    }
    if let Some(ttl) = values.text("ttl") {
        put(
            "ttl_s",
            seconds_value(parse_seconds(ttl, "--ttl").map_err(Fail::Usage)?),
        );
    }
    if values.on("no-push") {
        put("no_push", Value::Bool(true));
    }
    if let Some(peek) = values.text("peek") {
        if peek != "local" {
            return Err(usage(format!(
                "--peek takes local (peekable on this machine from its start), not {}",
                js_string(peek)
            )));
        }
        put("peek", Value::from("local"));
    }
    Ok(params)
}

/// `{ ttl_s, ...grantParams, bind_process, spawn: true, prompt }`
pub fn spawn_params(
    values: &Parsed,
    bound: Option<&str>,
    prompt: Option<&str>,
) -> Result<Params, Fail> {
    let mut params = vec![("ttl_s".to_owned(), Value::from(SPAWN_GRANT_TTL_S))];
    for (key, value) in grant_params(values)? {
        assign(&mut params, &key, value);
    }
    if let Some(bound) = bound {
        assign(&mut params, "bind_process", Value::from(bound));
    }
    assign(&mut params, "spawn", Value::Bool(true));
    if let Some(prompt) = prompt.filter(|prompt| !prompt.is_empty()) {
        assign(&mut params, "prompt", Value::from(prompt));
    }
    Ok(params)
}

/// `params` as a request's object
pub fn request_params(params: Params) -> Value {
    Value::Object(params.into_iter().collect::<Map<_, _>>())
}

/// the harness's environment: ours without the spawner's identity, plus the grant's variables and --labels
pub fn spawn_environment(parent: &Env, grant: &Map<String, Value>, labels: Option<&str>) -> Env {
    let mut env: Env = parent
        .iter()
        .filter(|(key, _)| !SPAWNER_IDENTITY.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    for (key, value) in grant {
        if let Some(value) = value.as_str() {
            env.insert(key.clone(), value.to_owned());
        }
    }
    if let Some(labels) = labels {
        env.insert("SCP_LABELS".into(), labels.to_owned());
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_params_keep_the_cli_key_order() {
        let values = Parsed {
            values: vec![
                ("ttl".into(), Val::Text("2h".into())),
                ("name".into(), Val::Text("w".into())),
                ("peek".into(), Val::Text("local".into())),
            ],
            positionals: Vec::new(),
        };
        let keys = |params: Params| params.into_iter().map(|(k, _)| k).collect::<Vec<_>>();
        let params = spawn_params(&values, Some("pid:1:x"), Some("the task")).unwrap();
        assert_eq!(params[0], ("ttl_s".to_owned(), Value::from(7200)));
        assert_eq!(
            keys(params),
            ["ttl_s", "name", "peek", "bind_process", "spawn", "prompt"]
        );
        let plain = spawn_params(&Parsed::default(), None, Some("")).unwrap();
        assert_eq!(keys(plain.clone()), ["ttl_s", "spawn"]);
        assert_eq!(plain[0].1, Value::from(3600));
    }
}
