use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use scp_core::protocol::CLI_NAME;

pub const DEFAULT_RELAY: &str = "https://app.scp.dev";

/// how the broker links to the hub, from the cloud file beside the relay selection and the credential store
#[derive(Clone, Debug)]
pub struct BridgeConfig {
    pub url: String,
    pub token: Option<String>,
    pub token_error: Option<String>,
    pub machine: String,
    pub mirror: Vec<String>,
    pub redact: bool,
    pub private_ok: bool,
    pub mirror_local: bool,
    pub local_flush: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    pub forward_wait: Duration,
    pub inject_backoff: Duration,
    pub env: BTreeMap<String, String>,
}

impl BridgeConfig {
    pub fn new(url: &str, machine: &str, token: Option<String>) -> Self {
        Self {
            url: url.to_owned(),
            token,
            token_error: None,
            machine: machine.to_owned(),
            mirror: vec!["*".into()],
            redact: false,
            private_ok: false,
            mirror_local: true,
            local_flush: Duration::from_secs(1),
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            forward_wait: Duration::from_secs(30),
            inject_backoff: Duration::from_secs(1),
            env: BTreeMap::new(),
        }
    }

    /// the credential read again, as before each reconnect
    pub fn credential(&self) -> Result<Option<String>, String> {
        relay_credential(&self.env, &self.url).map(|(token, _)| token)
    }
}

pub fn config_dir(env: &BTreeMap<String, String>) -> Result<PathBuf, String> {
    let base = env
        .get("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env.get("HOME")
                .filter(|v| !v.is_empty())
                .map(|home| PathBuf::from(home).join(".config"))
        })
        .ok_or_else(|| {
            "neither XDG_CONFIG_HOME nor HOME is set, so there is no place for the relay configuration"
                .to_owned()
        })?;
    Ok(base.join("scp"))
}

/// the origin of an absolute https URL (http only for localhost) without credentials
pub fn check_relay_url(text: &str, what: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(text).map_err(|_| {
        format!("{what} must be an absolute https URL (http is allowed only for localhost)")
    })?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(format!(
            "{what} must be an absolute https URL without credentials (http is allowed only for localhost)"
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn read_object(path: &PathBuf) -> Result<Option<serde_json::Map<String, Value>>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(format!("could not read {}", path.display())),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        _ => Err(format!("{} must contain a JSON object", path.display())),
    }
}

pub fn active_relay(env: &BTreeMap<String, String>) -> Result<String, String> {
    if let Some(url) = env.get("SCP_RELAY") {
        return check_relay_url(url, "$SCP_RELAY");
    }
    let path = config_dir(env)?.join("config.json");
    if let Some(relay) = read_object(&path)?.and_then(|config| config.get("relay").cloned()) {
        let what = format!("relay in {}", path.display());
        return match relay {
            Value::String(url) => check_relay_url(&url, &what),
            _ => Err(format!("{what} must be a URL")),
        };
    }
    Ok(DEFAULT_RELAY.into())
}

/// the hub credential for `origin`: SCP_TOKEN, else the stored login; with the problem when there is none
pub fn relay_credential(
    env: &BTreeMap<String, String>,
    origin: &str,
) -> Result<(Option<String>, Option<String>), String> {
    if let Some(token) = env
        .get("SCP_TOKEN")
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
    {
        return Ok((Some(token.to_owned()), None));
    }
    let path = config_dir(env)?.join("credentials.json");
    let entries = read_object(&path)?.unwrap_or_default();
    for entry in entries.values() {
        let valid = entry
            .get("token")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.trim().is_empty())
            && entry.get("saved_at").is_some_and(Value::is_string);
        if !valid {
            return Err(format!("{} contains an invalid credential", path.display()));
        }
    }
    let key = check_relay_url(origin, "relay URL")?;
    if let Some(token) = entries
        .get(&key)
        .and_then(|e| e.get("token"))
        .and_then(Value::as_str)
    {
        return Ok((Some(token.to_owned()), None));
    }
    Ok((
        None,
        Some(format!(
            "no login for {origin}: run {CLI_NAME} login, or set SCP_TOKEN"
        )),
    ))
}

pub struct CloudFile {
    pub machine: String,
    pub url: String,
    pub mirror: Option<Vec<String>>,
    pub redact: Option<bool>,
    pub private_ok: Option<bool>,
    pub mirror_local: Option<bool>,
}

pub fn cloud_file_path(env: &BTreeMap<String, String>) -> Result<PathBuf, String> {
    Ok(config_dir(env)?.join("cloud.json"))
}

pub fn read_cloud_file(
    path: &PathBuf,
    env: &BTreeMap<String, String>,
) -> Result<CloudFile, String> {
    let shown = path.display();
    let text = std::fs::read_to_string(path).map_err(|error| format!("{shown}: {error}"))?;
    let value: Value = serde_json::from_str(&text).map_err(|error| format!("{shown}: {error}"))?;
    if value.get("bridge") != Some(&Value::Bool(true)) {
        return Err(format!("{shown}: bridge is not true"));
    }
    let machine = value
        .get("machine")
        .and_then(Value::as_str)
        .filter(|m| super::valid_machine(m))
        .ok_or_else(|| format!("{shown}: machine is not a valid name"))?
        .to_owned();
    let url = match value.get("url") {
        None => active_relay(env)?,
        Some(Value::String(url)) => check_relay_url(url, &format!("url in {shown}"))?,
        Some(_) => return Err(format!("{shown}: url must be a URL")),
    };
    let mirror = match value.get("mirror") {
        None => None,
        Some(Value::Array(list)) => {
            let mut selectors = Vec::new();
            for sel in list {
                let Some(sel) = sel.as_str() else {
                    return Err(format!("{shown}: mirror is a list of selectors"));
                };
                if ["group:", "fleet:", "tree:", "machine:", "org:"]
                    .iter()
                    .any(|prefix| sel.starts_with(prefix))
                {
                    return Err(format!(
                        "{shown}: mirror selectors match by handle, harness, kind and label; {} is a scope selector",
                        Value::String(sel.into())
                    ));
                }
                if !crate::policy::valid_selector(sel, true, false) {
                    return Err(format!("{shown}: mirror selector {sel} is not valid"));
                }
                selectors.push(sel.to_owned());
            }
            Some(selectors)
        }
        Some(_) => return Err(format!("{shown}: mirror is a list of selectors")),
    };
    let flag = |key: &str| -> Result<Option<bool>, String> {
        match value.get(key) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(format!("{shown}: {key} is true or false")),
        }
    };
    Ok(CloudFile {
        machine,
        url,
        mirror,
        redact: flag("redact")?,
        private_ok: flag("private_ok")?,
        mirror_local: flag("mirror_local")?,
    })
}

/// the broker's bridge from cloud.json, or None when there is none; a missing token keeps the bridge down with a reason
pub fn daemon_bridge(env: &BTreeMap<String, String>, log: impl Fn(&str)) -> Option<BridgeConfig> {
    let path = cloud_file_path(env).ok()?;
    if !path.exists() {
        return None;
    }
    let file = match read_cloud_file(&path, env) {
        Ok(file) => file,
        Err(error) => {
            log(&format!("relay broker: {error}; running local-only"));
            return None;
        }
    };
    let (token, problem) =
        relay_credential(env, &file.url).unwrap_or_else(|error| (None, Some(error)));
    if let Some(problem) = &problem {
        log(&format!("relay broker: {problem}; running local-only"));
    }
    let mut config = BridgeConfig::new(&file.url, &file.machine, token);
    config.token_error = problem.map(|p| format!("{p}; running local-only"));
    if let Some(mirror) = file.mirror {
        config.mirror = mirror;
    }
    config.redact = file.redact == Some(true);
    config.private_ok = file.private_ok == Some(true);
    config.mirror_local = file.mirror_local != Some(false);
    config.env = env.clone();
    Some(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(dir: &std::path::Path) -> BTreeMap<String, String> {
        BTreeMap::from([("XDG_CONFIG_HOME".into(), dir.display().to_string())])
    }

    #[test]
    fn relay_urls_keep_the_origin_and_refuse_plain_http_off_localhost() {
        assert_eq!(
            check_relay_url("https://hub.example/x?y", "u").unwrap(),
            "https://hub.example"
        );
        assert_eq!(
            check_relay_url("http://127.0.0.1:9/", "u").unwrap(),
            "http://127.0.0.1:9"
        );
        assert!(check_relay_url("http://hub.example", "u").is_err());
        assert!(check_relay_url("https://a:b@hub.example", "u").is_err());
    }

    #[test]
    fn the_cloud_file_and_credentials_build_the_bridge() {
        let dir = std::env::temp_dir().join(format!("scp-bridge-config-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("scp")).unwrap();
        let mut env = env(&dir);
        env.insert("SCP_RELAY".into(), "http://localhost:7".into());
        std::fs::write(
            dir.join("scp/cloud.json"),
            r#"{"bridge":true,"machine":"desk","private_ok":true}"#,
        )
        .unwrap();
        let config = daemon_bridge(&env, |_| {}).unwrap();
        assert_eq!(
            (config.url.as_str(), config.machine.as_str()),
            ("http://localhost:7", "desk")
        );
        assert!(config.token.is_none() && config.private_ok && config.mirror_local);
        std::fs::write(
            dir.join("scp/credentials.json"),
            r#"{"http://localhost:7":{"token":"t1","saved_at":"x"}}"#,
        )
        .unwrap();
        assert_eq!(config.credential().unwrap().as_deref(), Some("t1"));
        env.insert("SCP_TOKEN".into(), " t2 ".into());
        assert_eq!(
            daemon_bridge(&env, |_| {}).unwrap().token.as_deref(),
            Some("t2")
        );
        std::fs::write(
            dir.join("scp/cloud.json"),
            r#"{"bridge":true,"machine":"me"}"#,
        )
        .unwrap();
        assert!(daemon_bridge(&env, |_| {}).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
