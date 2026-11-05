//! The hub (`remote.ts`): machine names, the connection a `--cloud` command opens to it, its machine inventory, and cloud.json, which links
//! the local broker to it.

use super::relay::{active_relay, relay_credential};
use super::ws;
use crate::fleet::json::Json;
use crate::fleet::view::{table, text, truthy};
use crate::fleet::{ask, reading, result_of};
use crate::open::{Bound, Opened};
use crate::term::out;
use crate::{Call, Done, Fail, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::ps::Env;
use serde_json::{Map, Value};

/// a machine name: lowercase letters, digits and -, at most 32, not `me`
pub fn valid_machine(name: &str) -> bool {
    let bytes = name.as_bytes();
    name != "me"
        && (1..=32).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// the short hostname, lowercased, as a machine name; `machine` when it makes none
pub fn host_machine(host: &str) -> String {
    let first = host.split('.').next().unwrap_or("").to_lowercase();
    let mut name = String::new();
    let mut dashed = false;
    for c in first.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
            name.push(c);
            dashed = false;
        } else if !dashed {
            name.push('-');
            dashed = true;
        }
    }
    let name: String = name.trim_matches('-').chars().take(32).collect();
    if valid_machine(&name) {
        name
    } else {
        "machine".into()
    }
}

/// this machine's name on the hub: the flag, else `$SCP_MACHINE`, else the short hostname
pub fn machine_name(flag: Option<&str>, env: &Env) -> Result<String, Fail> {
    let name = match flag.or(env.get("SCP_MACHINE").map(String::as_str)) {
        Some(name) => name.to_owned(),
        None => host_machine(scp_mcp::identity::this_hostname()),
    };
    if !valid_machine(&name) {
        return Err(usage(format!(
            "machine {} is not valid: lowercase letters, digits and -, at most 32, not \"me\"",
            crate::args::js_string(&name)
        )));
    }
    Ok(name)
}

/// a `--cloud` command's machine and how it is bound, beside the hello it sends
#[derive(Debug, Clone)]
pub struct Hub {
    pub machine: String,
    pub bound: Bound,
}

/// connects to the active relay's hub with its login and says `hello`
pub async fn open_hub(hello: Map<String, Value>, hub: Hub, env: &Env) -> Result<Opened, Fail> {
    let (url, _) = active_relay(env)?;
    let credential = relay_credential(env, &url)?;
    let Some(token) = credential.token else {
        return Err(usage(credential.problem.unwrap_or_default()));
    };
    let client = ws::connect(&url, &token).await?;
    let reply = client.request_line("hello", Value::Object(hello)).await;
    let hello = match reply.map_err(Fail::from).and_then(|line| result_of(&line)) {
        Ok(hello) => hello,
        Err(fail) => {
            client.close();
            return Err(fail);
        }
    };
    let endpoint = hello.get("endpoint").cloned().unwrap_or(Json::Null);
    Ok(Opened {
        client,
        me: endpoint.to_value(),
        endpoint,
        broker: Value::Null,
        bound: hub.bound,
        harness_pid: None,
        hub: Some(format!(
            "the relay at {url}, account {}, machine {}",
            text(hello.get("account")),
            hub.machine
        )),
    })
}

/// `swarm machines [rm NAME]`: the hub's machines, or one released
pub fn machines<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let words = &call.parsed.positionals;
        let json = call.parsed.on("json");
        match words.first().map(String::as_str) {
            Some("rm") => {
                let name = match words.as_slice() {
                    [_, name] if !name.is_empty() => name,
                    _ => {
                        return Err(usage(format!(
                            "{CLI_NAME} machines rm needs one machine name"
                        )));
                    }
                };
                let result = ask(
                    opened,
                    "machines_rm",
                    vec![("name", Value::from(name.as_str()))],
                )
                .await?;
                if json {
                    out(&result.pretty());
                } else {
                    out(&format!(
                        "released {} ({} endpoints dropped)",
                        text(result.get("removed")),
                        text(result.get("endpoints"))
                    ));
                }
                Ok(0)
            }
            Some(_) => Err(usage(format!(
                "{CLI_NAME} machines takes no argument, or rm NAME"
            ))),
            None => {
                let result = ask(opened, "machines", Vec::new()).await?;
                let machines = result.get("machines");
                if json {
                    let entries = machines.map(|m| ("machines", m.clone()));
                    out(&Json::object(entries.into_iter().collect()).pretty());
                    return Ok(0);
                }
                let mut rows = vec![
                    ["MACHINE", "KIND", "ONLINE", "BRIDGE", "LAST SEEN"]
                        .map(String::from)
                        .to_vec(),
                ];
                for m in reading(machines, "machines", "map")? {
                    let yes = |key: &str| if truthy(m.get(key)) { "yes" } else { "no" };
                    rows.push(vec![
                        text(m.get("name")),
                        text(m.get("kind")),
                        yes("online").into(),
                        yes("bridge").into(),
                        match m.get("last_seen") {
                            None | Some(Json::Null) => String::new(),
                            seen => text(seen),
                        },
                    ]);
                }
                for line in table(&rows) {
                    out(&line);
                }
                Ok(0)
            }
        }
    })
}

#[cfg(unix)]
pub use local::{cloud, enable, relink_broker, relink_running};

/// the verbs that link the local broker to the hub, which only a machine that runs one has
#[cfg(unix)]
mod local {
    use super::*;
    use crate::account::relay::{config_file, write_private_json};
    use crate::fleet::thrown;
    use crate::open::{block_on, node_fs_error, start_broker};
    use crate::term::note;
    use scp_mcp::client::{CallError, Client, Start, connect_broker, connect_or_start, relay_dir};
    use std::rc::Rc;

    const CLOUD_USAGE: &str = "cloud takes enable [--machine NAME], disable or status";

    /// cloud.json checked and filled in as the broker reads it: an error says what is wrong with it
    pub fn read_cloud_file(path: &str, env: &Env) -> Result<Json, String> {
        let bytes = std::fs::read(path).map_err(|error| node_fs_error(&error, "open", path))?;
        let value = Json::parse(String::from_utf8_lossy(&bytes).as_bytes())
            .ok_or_else(|| "Unexpected token in JSON".to_owned())?;
        if value == Json::Null {
            return Err("Cannot read properties of null (reading 'bridge')".into());
        }
        if value.get("bridge") != Some(&Json::Bool(true)) {
            return Err(format!("{path}: bridge is not true"));
        }
        let machine = match value.get("machine") {
            Some(Json::Str(machine)) if valid_machine(machine) => machine.clone(),
            _ => return Err(format!("{path}: machine is not a valid name")),
        };
        let message = |fail: Fail| match fail {
            Fail::Usage(message) | Fail::Decline(message) => message,
            Fail::Call(error) => error.message().to_owned(),
        };
        let url = match value.get("url") {
            None => active_relay(env).map_err(message)?.0,
            Some(Json::Str(url)) => {
                super::super::relay::check_relay_url(url, &format!("url in {path}"))
                    .map_err(message)?
            }
            Some(_) => return Err(format!("{path}: url must be a URL")),
        };
        let mirror = value.get("mirror");
        if let Some(mirror) = mirror {
            let Json::Arr(selectors) = mirror else {
                return Err(format!("{path}: mirror is a list of selectors"));
            };
            let scoped = selectors.iter().find_map(|sel| match sel {
                Json::Str(sel)
                    if ["group:", "fleet:", "tree:", "machine:", "org:"]
                        .iter()
                        .any(|prefix| sel.starts_with(prefix)) =>
                {
                    Some(sel)
                }
                _ => None,
            });
            if let Some(scoped) = scoped {
                return Err(format!(
                    "{path}: mirror selectors match by handle, harness, kind and label; {} is a scope selector",
                    crate::args::js_string(scoped)
                ));
            }
            if selectors.len() > 256 {
                return Err("rules must be a list of at most 256 rules".into());
            }
            for (index, sel) in selectors.iter().enumerate() {
                let valid = sel
                    .as_str()
                    .is_some_and(|sel| scp_broker::policy::valid_selector(sel, true, false));
                if !valid {
                    return Err(format!(
                        "rule {index} match: {} is not a selector",
                        sel.compact()
                    ));
                }
            }
        }
        let mut file = Json::object(vec![
            ("bridge", Json::Bool(true)),
            ("machine", Json::str(machine)),
            ("url", Json::str(url)),
        ]);
        if let Some(mirror) = mirror {
            file.set("mirror", mirror.clone());
        }
        for key in ["redact", "private_ok", "mirror_local"] {
            match value.get(key) {
                None => {}
                Some(flag @ Json::Bool(_)) => file.set(key, flag.clone()),
                Some(_) => return Err(format!("{path}: {key} is true or false")),
            }
        }
        Ok(file)
    }

    fn broker_start(env: &Env) -> (std::path::PathBuf, Start) {
        if let Ok(exe) = std::env::current_exe() {
            scp_mcp::spawn::set_native_daemon(exe);
        }
        let dir = relay_dir(env);
        let start: Start = {
            let (dir, env) = (dir.to_string_lossy().into_owned(), env.clone());
            Rc::new(move || start_broker(&dir, &env))
        };
        (dir, start)
    }

    async fn observe(client: &Client) -> Result<Value, CallError> {
        let mut hello = Map::new();
        hello.insert("observe".into(), Value::Bool(true));
        client.hello(hello).await
    }

    /// the broker's link to the hub, from the broker this starts when none runs
    pub async fn cloud_status(env: &Env) -> Result<Json, Fail> {
        let (dir, start) = broker_start(env);
        let client = connect_or_start(&dir, Some(start)).await?;
        let status = async {
            observe(&client).await?;
            result_of(
                &client
                    .request_line("cloud_status", Value::Object(Map::new()))
                    .await?,
            )
        }
        .await;
        client.close();
        status
    }

    /// asks the broker to link again with the cloud config and login on disk, starting one when none runs; one that cannot take the
    /// config restarts, and the status is the new broker's
    pub async fn relink_broker(env: &Env) -> Result<Json, Fail> {
        let (dir, start) = broker_start(env);
        let client = connect_or_start(&dir, Some(start)).await?;
        let asked = async {
            let hello = observe(&client).await?;
            let pid = hello
                .get("broker")
                .and_then(|b| b.get("pid"))
                .and_then(Value::as_i64);
            let result = client
                .request("bridge_relink", Value::Object(Map::new()))
                .await?;
            Ok::<_, CallError>((pid, result))
        }
        .await;
        client.close();
        let (pid, result) = match asked {
            Ok(asked) => asked,
            Err(CallError::Relay { code, .. }) if code == "method_not_found" => {
                return cloud_status(env).await;
            }
            Err(error) => return Err(error.into()),
        };
        if !scp_mcp::tools::truthy(result.get("restarting")) {
            return Ok(Json::from(&result));
        }
        if let Some(pid) = pid {
            exited(pid as i32).await;
        }
        cloud_status(env).await
    }

    async fn exited(pid: i32) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let alive = || {
            // SAFETY: signal 0 only checks that the process exists
            let found = unsafe { libc::kill(pid, 0) } == 0;
            found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        };
        while alive() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    /// relinks a broker that already runs; a failure only warns, as the login or config it follows stands
    pub fn relink_running(env: &Env) {
        let _ = block_on(async {
            match connect_broker(&relay_dir(env), None).await {
                Ok(client) => client.close(),
                Err(_) => return,
            }
            if let Err(fail) = relink_broker(env).await.map(drop) {
                let message = match fail {
                    Fail::Usage(message) | Fail::Decline(message) => message,
                    Fail::Call(error) => error.message().to_owned(),
                };
                note(&format!(
                    "the running broker did not link again ({message}); run `{CLI_NAME} daemon restart`"
                ));
            }
        });
    }

    /// writes cloud.json, which links the broker to the active relay as `machine`, and says so
    pub fn enable(machine: Option<&str>, json: bool, env: &Env) -> Result<(), Fail> {
        let path = config_file(env, "cloud.json")?;
        let machine = machine_name(machine, env)?;
        let (url, _) = active_relay(env)?;
        let problem = relay_credential(env, &url)?.problem;
        let file = Json::object(vec![
            ("bridge", Json::Bool(true)),
            ("machine", Json::str(machine.clone())),
            ("url", Json::str(url.clone())),
        ]);
        write_private_json(&path, &file)?;
        if json {
            let token = if problem.is_some() {
                "missing"
            } else {
                "found"
            };
            let shown = Json::spread(
                vec![("file", Json::str(path))],
                &file,
                vec![("token", Json::str(token))],
            );
            out(&shown.pretty());
        } else {
            out(&format!(
                "the relay broker links to {url} as machine {machine} ({path})"
            ));
            if let Some(problem) = problem {
                note(&problem);
            }
        }
        Ok(())
    }

    /// `swarm cloud enable [--machine NAME] | disable | status`
    pub fn cloud(call: &Call) -> Done {
        let flags = &call.parsed;
        let env = call.env;
        let json = flags.on("json");
        let [action] = flags.positionals.as_slice() else {
            return Err(usage(format!("{CLI_NAME} {CLOUD_USAGE}")));
        };
        let path = config_file(env, "cloud.json")?;
        if action == "enable" {
            enable(flags.text("machine"), json, env)?;
            relink_running(env);
            return Ok(0);
        }
        if flags.has("machine") {
            return Err(usage(format!(
                "{CLI_NAME} cloud {action} does not take --machine"
            )));
        }
        match action.as_str() {
            "disable" => {
                let had = std::path::Path::new(&path).exists();
                match std::fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(thrown(node_fs_error(&error, "rm", &path))),
                }
                if json {
                    let shown = Json::object(vec![
                        ("file", Json::str(path)),
                        ("removed", Json::Bool(had)),
                    ]);
                    out(&shown.pretty());
                } else if had {
                    out(&format!(
                        "removed {path}; the running broker keeps its link until it exits"
                    ));
                } else {
                    out(&format!("no {path}; the broker is local-only"));
                }
                Ok(0)
            }
            "status" => {
                let (file, file_error) = if std::path::Path::new(&path).exists() {
                    match read_cloud_file(&path, env) {
                        Ok(file) => (Some(file), None),
                        Err(error) => (None, Some(error)),
                    }
                } else {
                    (None, None)
                };
                let broker = block_on(cloud_status(env))??;
                if json {
                    let mut shown = Json::object(vec![
                        ("file", Json::str(path)),
                        ("config", file.unwrap_or(Json::Null)),
                    ]);
                    if let Some(error) = file_error {
                        shown.set("config_error", Json::str(error));
                    }
                    shown.set("broker", broker);
                    out(&shown.pretty());
                    return Ok(0);
                }
                out(&match (&file, &file_error) {
                    (Some(file), _) => format!(
                        "{path}: machine {} at {}",
                        text(file.get("machine")),
                        text(file.get("url"))
                    ),
                    (None, Some(error)) => error.clone(),
                    (None, None) => format!("no {path}: the broker is local-only"),
                });
                if !truthy(broker.get("enabled")) {
                    out(if file.is_some() {
                        "the running broker started before this file existed and is local-only until it restarts"
                    } else {
                        "the broker is local-only"
                    });
                } else {
                    let error = broker
                        .get("last_error")
                        .filter(|e| truthy(Some(e)))
                        .map(|e| format!("; {}", text(Some(e))))
                        .unwrap_or_default();
                    out(&format!(
                        "broker: {} to {} as {} since {}{error}",
                        if truthy(broker.get("connected")) {
                            "connected"
                        } else {
                            "not connected"
                        },
                        text(broker.get("url")),
                        text(broker.get("machine")),
                        text(broker.get("since"))
                    ));
                }
                Ok(0)
            }
            _ => Err(usage(format!("{CLI_NAME} {CLOUD_USAGE}"))),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn cloud_json_mirror_refuses_scope_selectors_and_fills_in_the_relay() {
            let dir = std::env::temp_dir().join(format!("cli-cloud-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join("cloud.json").display().to_string();
            let env = Env::from([("SCP_RELAY".to_owned(), "http://localhost:9".to_owned())]);
            std::fs::write(&file, r#"{"bridge":true,"machine":"laptop","mirror":["harness:codex"],"private_ok":true}"#).unwrap();
            assert_eq!(
                read_cloud_file(&file, &env).unwrap().compact(),
                r#"{"bridge":true,"machine":"laptop","url":"http://localhost:9","mirror":["harness:codex"],"private_ok":true}"#
            );
            std::fs::write(
                &file,
                r#"{"bridge":true,"machine":"laptop","mirror":["tree:children"]}"#,
            )
            .unwrap();
            assert_eq!(
                read_cloud_file(&file, &env).unwrap_err(),
                format!(
                    "{file}: mirror selectors match by handle, harness, kind and label; \"tree:children\" is a scope selector"
                )
            );
            std::fs::write(
                &file,
                r#"{"bridge":true,"machine":"laptop","private_ok":"yes"}"#,
            )
            .unwrap();
            assert_eq!(
                read_cloud_file(&file, &env).unwrap_err(),
                format!("{file}: private_ok is true or false")
            );
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_names_come_from_the_flag_then_the_environment_then_the_host() {
        let env = Env::from([("SCP_MACHINE".to_owned(), "desk".to_owned())]);
        assert_eq!(machine_name(Some("ci"), &env).unwrap(), "ci");
        assert_eq!(machine_name(None, &env).unwrap(), "desk");
        for name in ["me", "", "Upper", "a_b", &"x".repeat(33)] {
            let Err(Fail::Usage(message)) = machine_name(Some(name), &Env::new()) else {
                panic!("{name} passed");
            };
            assert!(message.contains("is not valid"));
        }
        assert_eq!(host_machine("My_Laptop.local"), "my-laptop");
        assert_eq!(host_machine("--.x"), "machine");
        assert_eq!(host_machine("me"), "machine");
        assert_eq!(host_machine(&"a".repeat(40)), "a".repeat(32));
    }
}
