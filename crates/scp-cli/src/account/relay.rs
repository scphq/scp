//! The relay selection and the credentials beside it (`relay.ts`): config.json and credentials.json in the config directory, each written
//! privately and in one rename, with the keys of what was there kept in their order.

use crate::fleet::json::Json;
use crate::term::{note, out};
use crate::{Call, Done, Fail, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::CallError;
use scp_mcp::ps::{Env, join};
use scp_mcp::tools::js_trim;

pub const DEFAULT_RELAY: &str = "https://app.scp.dev";

/// `~/.config/scp`, or `$XDG_CONFIG_HOME/scp`
pub fn config_dir(env: &Env) -> Result<String, Fail> {
    let nonempty = |key: &str| env.get(key).filter(|v| !v.is_empty());
    let base = match (nonempty("XDG_CONFIG_HOME"), nonempty("HOME")) {
        (Some(base), _) => base.clone(),
        (None, Some(home)) => join(&[home, ".config"]),
        (None, None) => {
            return Err(usage(
                "neither XDG_CONFIG_HOME nor HOME is set, so there is no place for the relay configuration",
            ));
        }
    };
    Ok(join(&[&base, "scp"]))
}

pub fn config_file(env: &Env, name: &str) -> Result<String, Fail> {
    Ok(join(&[&config_dir(env)?, name]))
}

/// the origin of an absolute https URL without credentials, http only for localhost
pub fn check_relay_url(text: &str, what: &str) -> Result<String, Fail> {
    let url = reqwest::Url::parse(text).map_err(|_| {
        usage(format!(
            "{what} must be an absolute https URL (http is allowed only for localhost)"
        ))
    })?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some_and(|p| !p.is_empty())
    {
        return Err(usage(format!(
            "{what} must be an absolute https URL without credentials (http is allowed only for localhost)"
        )));
    }
    Ok(url.origin().ascii_serialization())
}

/// the JSON object at `path`, None when there is no file
pub fn read_object(path: &str) -> Result<Option<Json>, Fail> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(usage(format!("could not read {path}"))),
    };
    match Json::parse(String::from_utf8_lossy(&bytes).as_bytes()) {
        Some(object @ Json::Obj(_)) => Ok(Some(object)),
        _ => Err(usage(format!("{path} must contain a JSON object"))),
    }
}

fn fs_error(syscall: &str, path: &str) -> impl Fn(std::io::Error) -> Fail {
    let (syscall, path) = (syscall.to_owned(), path.to_owned());
    move |error| {
        Fail::Call(CallError::Io(crate::open::node_fs_error(
            &error, &syscall, &path,
        )))
    }
}

fn temp_name() -> String {
    let bytes: [u8; 16] = rand::random();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        ".{}-{}-4{}-{:x}{}-{}.tmp",
        &hex[..8],
        &hex[8..12],
        &hex[13..16],
        (bytes[8] & 0x3) | 0x8,
        &hex[17..20],
        &hex[20..]
    )
}

/// `value` as `JSON.stringify(value, null, 2)` at `path`: the directory made 0700, the file written 0600 beside it and renamed over
pub fn write_private_json(path: &str, value: &Json) -> Result<(), Fail> {
    let dir = scp_mcp::ps::dirname(path);
    private_dir(&dir)?;
    let temp = join(&[&dir, &temp_name()]);
    let written = write_temp(&temp, path, &format!("{}\n", value.pretty()));
    let _ = std::fs::remove_file(&temp);
    written
}

#[cfg(unix)]
fn private_dir(dir: &str) -> Result<(), Fail> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(fs_error("mkdir", dir))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(fs_error("chmod", dir))
}

#[cfg(not(unix))]
fn private_dir(dir: &str) -> Result<(), Fail> {
    std::fs::create_dir_all(dir).map_err(fs_error("mkdir", dir))
}

fn write_temp(temp: &str, path: &str, text: &str) -> Result<(), Fail> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        let mut file = options.open(temp).map_err(fs_error("open", temp))?;
        file.write_all(text.as_bytes())
            .map_err(fs_error("write", temp))?;
        drop(file);
        std::fs::set_permissions(temp, std::fs::Permissions::from_mode(0o600))
            .map_err(fs_error("chmod", temp))?;
    }
    #[cfg(not(unix))]
    {
        let mut file = options.open(temp).map_err(fs_error("open", temp))?;
        file.write_all(text.as_bytes())
            .map_err(fs_error("write", temp))?;
    }
    std::fs::rename(temp, path).map_err(fs_error("rename", &format!("{temp}' -> '{path}")))
}

/// the active relay and where it was chosen: `SCP_RELAY`, `config` or `default`
pub fn active_relay(env: &Env) -> Result<(String, &'static str), Fail> {
    if let Some(relay) = env.get("SCP_RELAY") {
        return Ok((check_relay_url(relay, "$SCP_RELAY")?, "SCP_RELAY"));
    }
    let path = config_file(env, "config.json")?;
    match read_object(&path)?.as_ref().and_then(|c| c.get("relay")) {
        None => Ok((DEFAULT_RELAY.into(), "default")),
        Some(Json::Str(url)) => Ok((check_relay_url(url, &format!("relay in {path}"))?, "config")),
        Some(_) => Err(usage(format!("relay in {path} must be a URL"))),
    }
}

/// the stored logins by origin, each checked to hold a token and when it was saved
pub fn read_credentials(env: &Env) -> Result<Json, Fail> {
    let path = config_file(env, "credentials.json")?;
    let entries = read_object(&path)?.unwrap_or(Json::Obj(Vec::new()));
    for (_, entry) in entries.entries() {
        let token = entry.get("token").and_then(Json::as_str);
        let valid = matches!(entry, Json::Obj(_))
            && token.is_some_and(|t| !js_trim(t).is_empty())
            && matches!(entry.get("saved_at"), Some(Json::Str(_)));
        if !valid {
            return Err(usage(format!("{path} contains an invalid credential")));
        }
    }
    Ok(entries)
}

/// stores `credential` for `origin`, stamped with the time
pub fn save_credential(env: &Env, origin: &str, credential: Vec<(&str, Json)>) -> Result<(), Fail> {
    let url = check_relay_url(origin, "relay URL")?;
    let path = config_file(env, "credentials.json")?;
    let mut entries = read_credentials(env)?;
    let mut entry = Json::object(credential);
    entry.set("saved_at", Json::str(iso_now()));
    entries.set(&url, entry);
    write_private_json(&path, &entries)
}

/// drops the login for `origin`: whether there was one
pub fn remove_credential(env: &Env, origin: &str) -> Result<bool, Fail> {
    let entries = read_credentials(env)?;
    let url = check_relay_url(origin, "relay URL")?;
    let Json::Obj(mut list) = entries else {
        return Ok(false);
    };
    let before = list.len();
    list.retain(|(key, _)| *key != url);
    if list.len() == before {
        return Ok(false);
    }
    write_private_json(&config_file(env, "credentials.json")?, &Json::Obj(list))?;
    Ok(true)
}

/// the token for `origin`: `$SCP_TOKEN`, else the stored login
pub struct Credential {
    pub token: Option<String>,
    pub source: Option<&'static str>,
    pub problem: Option<String>,
}

pub fn env_token(env: &Env) -> Option<&str> {
    env.get("SCP_TOKEN")
        .map(|t| js_trim(t))
        .filter(|t| !t.is_empty())
}

pub fn relay_credential(env: &Env, origin: &str) -> Result<Credential, Fail> {
    if let Some(token) = env_token(env) {
        return Ok(Credential {
            token: Some(token.to_owned()),
            source: Some("SCP_TOKEN"),
            problem: None,
        });
    }
    let entries = read_credentials(env)?;
    let stored = entries
        .get(&check_relay_url(origin, "relay URL")?)
        .and_then(|e| e.get("token"))
        .and_then(Json::as_str);
    Ok(match stored {
        Some(token) => Credential {
            token: Some(token.to_owned()),
            source: Some("credentials"),
            problem: None,
        },
        None => Credential {
            token: None,
            source: None,
            problem: Some(format!(
                "no login for {origin}: run {CLI_NAME} login, or set SCP_TOKEN"
            )),
        },
    })
}

/// now as `Date.prototype.toISOString` writes it
pub fn iso_now() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    iso(ms)
}

pub fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

/// `swarm relay use <url>` and `swarm relay show`
pub fn relay(call: &Call) -> Done {
    let words = &call.parsed.positionals;
    let json = call.parsed.on("json");
    let env = call.env;
    match words
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["use", text] => {
            let url = check_relay_url(text, "relay URL")?;
            let path = config_file(env, "config.json")?;
            let mut config = read_object(&path)?.unwrap_or(Json::Obj(Vec::new()));
            config.set("relay", Json::str(url.clone()));
            write_private_json(&path, &config)?;
            if json {
                out(&Json::object(vec![("url", Json::str(url))]).compact());
            } else {
                out(&format!("saved relay {url}"));
            }
            if env.contains_key("SCP_RELAY") {
                note("$SCP_RELAY still selects the active relay");
            }
            Ok(0)
        }
        ["show"] => {
            let (url, source) = active_relay(env)?;
            let credential = relay_credential(env, &url)?;
            let found = if credential.token.is_some() {
                "found"
            } else {
                "missing"
            };
            if json {
                let result = Json::object(vec![
                    ("url", Json::str(url)),
                    ("source", Json::str(source)),
                    ("credential", Json::str(found)),
                    (
                        "credential_source",
                        credential.source.map_or(Json::Null, Json::str),
                    ),
                ]);
                out(&result.compact());
            } else {
                let from = credential
                    .source
                    .map(|s| format!(" ({s})"))
                    .unwrap_or_default();
                out(&format!("{url} ({source}); credential {found}{from}"));
            }
            Ok(0)
        }
        _ => Err(usage(format!("{CLI_NAME} relay takes use <url> or show"))),
    }
}

/// `swarm logout`: drops the stored login for the active relay
pub fn logout(call: &Call) -> Done {
    if !call.parsed.positionals.is_empty() {
        return Err(usage(format!("{CLI_NAME} logout takes no arguments")));
    }
    let env = call.env;
    let (url, _) = active_relay(env)?;
    let removed = remove_credential(env, &url)?;
    let env_token = env_token(env).is_some();
    if call.parsed.on("json") {
        let result = Json::object(vec![
            ("url", Json::str(url)),
            ("removed", Json::Bool(removed)),
            ("env_token", Json::Bool(env_token)),
        ]);
        out(&result.compact());
    } else if removed {
        out(&format!("logged out of {url}"));
    } else {
        out(&format!("no stored login for {url}"));
    }
    if env_token {
        note("$SCP_TOKEN still applies");
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> (String, Env) {
        let home = std::env::temp_dir()
            .join(format!("cli-account-{name}-{}", std::process::id()))
            .display()
            .to_string();
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        (home.clone(), Env::from([("HOME".to_owned(), home)]))
    }

    #[test]
    fn relay_urls_keep_only_the_origin_and_refuse_plain_http_off_localhost() {
        for url in [
            "https://relay.example/path?q=1#part",
            "https://relay.example/",
        ] {
            assert_eq!(check_relay_url(url, "x").unwrap(), "https://relay.example");
        }
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            assert_eq!(
                check_relay_url(&format!("http://{host}:1234/path"), "x").unwrap(),
                format!("http://{host}:1234")
            );
        }
        for url in [
            "relay.example",
            "/relay",
            "http://relay.example",
            "ftp://localhost",
            "https://user:secret@relay.example",
        ] {
            let Err(Fail::Usage(message)) = check_relay_url(url, "chosen relay") else {
                panic!("{url} passed");
            };
            assert!(message.starts_with("chosen relay must be an absolute https URL"));
        }
    }

    #[test]
    fn iso_times_read_as_to_iso_string_writes_them() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_793_871_296_789), "2026-11-05T09:34:56.789Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[cfg(unix)]
    #[test]
    fn credentials_stay_per_origin_private_and_in_their_order() {
        use std::os::unix::fs::PermissionsExt;
        let (home, env) = scratch("store");
        let dir = config_dir(&env).unwrap();
        assert_eq!(dir, format!("{home}/.config/scp"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/credentials.json"), "{}").unwrap();
        std::fs::set_permissions(
            format!("{dir}/credentials.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        save_credential(
            &env,
            "https://two.example/x",
            vec![("token", Json::str("second"))],
        )
        .unwrap();
        save_credential(
            &env,
            "https://one.example",
            vec![("token", Json::str("first"))],
        )
        .unwrap();
        save_credential(
            &env,
            "https://two.example",
            vec![("token", Json::str("again"))],
        )
        .unwrap();
        let stored = read_credentials(&env).unwrap();
        let keys: Vec<&str> = stored.entries().iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, ["https://two.example", "https://one.example"]);
        let mode = |path: &str| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&format!("{dir}/credentials.json")), 0o600);
        let token = |env: &Env| relay_credential(env, "https://two.example").unwrap().token;
        assert_eq!(token(&env).as_deref(), Some("again"));
        let mut opaque = env.clone();
        opaque.insert("SCP_TOKEN".into(), "  opaque ".into());
        assert_eq!(token(&opaque).as_deref(), Some("opaque"));
        assert!(remove_credential(&env, "https://two.example").unwrap());
        assert!(!remove_credential(&env, "https://two.example").unwrap());
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["credentials.json"]);
        std::fs::write(format!("{dir}/credentials.json"), "{\"secret-token\":").unwrap();
        let Err(Fail::Usage(message)) = read_credentials(&env) else {
            panic!("a malformed store read");
        };
        assert_eq!(
            message,
            format!("{dir}/credentials.json must contain a JSON object")
        );
        std::fs::remove_dir_all(&home).unwrap();
    }
}
