use serde_json::{Map, Value, json};

use crate::proto::RpcError;

fn object<'a>(v: &'a Value, keys: &[&str], name: &str) -> Result<&'a Map<String, Value>, RpcError> {
    let v = v
        .as_object()
        .ok_or_else(|| bad(format!("{name} is an object")))?;
    if v.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err(bad(format!("unknown {name} fields")));
    }
    Ok(v)
}

fn bad(message: impl AsRef<str>) -> RpcError {
    RpcError::invalid_params(format!("judge: {}", message.as_ref()))
}

fn count(value: Option<&Value>, default: u64, max: u64, name: &str) -> Result<u64, RpcError> {
    match value {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|n| *n >= 1 && *n <= max)
            .ok_or_else(|| bad(format!("{name} is 1 to {max}"))),
    }
}

pub fn parse_policy(value: &Value) -> Result<Value, RpcError> {
    let v = object(
        value,
        &["mode", "fail", "timeout_s", "model", "budget", "boundaries"],
        "judge",
    )?;
    if crate::scrub::find_secret(&value.to_string()).is_some() {
        return Err(bad(
            "the section holds a credential: reference model.key_env or model.key_file",
        ));
    }
    let mode = v.get("mode").unwrap_or(&Value::Null);
    let fail = v.get("fail").unwrap_or(&Value::Null);
    if !mode.is_null() && !matches!(mode.as_str(), Some("off" | "shadow" | "enforce")) {
        return Err(bad("mode is off, shadow or enforce"));
    }
    if !fail.is_null() && !matches!(fail.as_str(), Some("open" | "closed")) {
        return Err(bad("fail is open or closed"));
    }
    if v.get("mode").is_some_and(Value::is_null) || v.get("fail").is_some_and(Value::is_null) {
        return Err(bad("mode and fail must be strings"));
    }
    let boundaries = v
        .get("boundaries")
        .and_then(Value::as_array)
        .filter(|b| !b.is_empty() && b.len() <= 64)
        .ok_or_else(|| bad("boundaries is a list of 1 to 64 boundaries"))?;
    let mut parsed = Vec::new();
    for boundary in boundaries {
        let b = object(boundary, &["from", "to", "across"], "boundary")?;
        let mut out = json!({"from":"*", "to":"*"});
        for field in ["from", "to"] {
            if let Some(sel) = b.get(field) {
                if !sel
                    .as_str()
                    .is_some_and(|s| scp_core::scope::valid_selector(s, Default::default()))
                {
                    return Err(bad(format!("boundary {field} is not a selector")));
                }
                out[field] = sel.clone();
            }
        }
        if let Some(across) = b.get("across") {
            if across != "tree" {
                return Err(bad("boundary across is tree"));
            }
            out["across"] = across.clone();
        }
        parsed.push(out);
    }
    let mut out = json!({"mode":mode.as_str().unwrap_or("shadow"), "fail":fail.as_str().unwrap_or("open"), "timeout_s":count(v.get("timeout_s"),12,30,"timeout_s")?, "boundaries":parsed});
    if let Some(budget) = v.get("budget") {
        let b = object(budget, &["per_minute", "per_hour"], "budget")?;
        out["budget"] = json!({"per_minute":count(b.get("per_minute"),120,10000,"budget.per_minute")?, "per_hour":count(b.get("per_hour"),1200,100000,"budget.per_hour")?});
    }
    if let Some(model) = v.get("model") {
        let m = object(model, &["id", "effort", "key_env", "key_file"], "model")?;
        let id = m
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("model.id is provider/name"))?;
        super::provider::model(id)
            .map_err(|_| bad("model.id is provider/name with a known provider"))?;
        let effort = m
            .get("effort")
            .map_or(Some("medium"), Value::as_str)
            .filter(|e| matches!(*e, "low" | "medium" | "high" | "xhigh"))
            .ok_or_else(|| bad("invalid model.effort"))?;
        if m.contains_key("key_env") == m.contains_key("key_file") {
            return Err(bad("model needs exactly one of key_env or key_file"));
        }
        let mut parsed = json!({"id":id,"effort":effort});
        if let Some(env) = m.get("key_env") {
            let name = env
                .as_str()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 64
                        && s.bytes().enumerate().all(|(i, c)| {
                            c == b'_' || c.is_ascii_uppercase() || i > 0 && c.is_ascii_digit()
                        })
                })
                .ok_or_else(|| bad("model.key_env is an environment variable name"))?;
            parsed["key_env"] = json!(name);
        }
        if let Some(file) = m.get("key_file") {
            let path = file
                .as_str()
                .filter(|s| s.starts_with('/') && s.len() <= 1024)
                .ok_or_else(|| bad("model.key_file is an absolute path"))?;
            parsed["key_file"] = json!(path);
        }
        out["model"] = parsed;
    }
    Ok(out)
}
