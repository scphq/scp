//! What a launcher gives the session it starts: a grant from the agent whose harness runs this shell, an explicit parent, or neither.

use crate::open::{Walk, terminal_attached, walk};
use crate::spawn::grant::spawn_environment;
use crate::{Fail, route, usage};
use scp_core::address::{valid_handle, valid_machine};
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::{CallError, connect_within, relay_dir};
use scp_mcp::identity::{codex_shell, codex_thread};
use scp_mcp::ps::{Env, SHELL_PS_TIMEOUT_MS, read_ps_table};
use scp_mcp::tools::{get, truthy};
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

/// what the launcher gives the session it starts: the grant's variables in place of the caller's identity, and the agent it links
/// under. Without `parent` it only drops the caller's identity, for a session started as a root from an agent's shell
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Attribution {
    pub env: Map<String, Value>,
    pub parent: Option<String>,
}

/// how a launcher was asked to place its session
#[derive(Debug, Clone, Copy, Default)]
pub struct Placement<'a> {
    pub name: Option<&'a str>,
    pub root: bool,
    pub under: Option<&'a str>,
    pub resume: bool,
    /// the broker to ask, when it is not the one `env` names
    pub dir: Option<&'a str>,
}

/// how long a launcher waits on the broker for attribution before it starts the session unlinked
pub const ATTRIBUTE_TIMEOUT_MS: u64 = 5000;

/// `me/<machine>/<handle>`: the machine and the handle
fn machine_address(address: &str) -> Option<(&str, &str)> {
    let (machine, handle) = address.strip_prefix("me/")?.split_once('/')?;
    (valid_machine(machine) && !handle.is_empty() && !handle.contains('/'))
        .then_some((machine, handle))
}

/// an explicit parent address, checked before a harness starts
pub fn validate_under(under: Option<&str>, root: bool) -> Result<(), Fail> {
    let Some(under) = under else {
        return Ok(());
    };
    if root {
        return Err(usage("--under and --root cannot be used together"));
    }
    let handle = match machine_address(under) {
        Some((_, handle)) => handle,
        None => under.strip_prefix("me/").unwrap_or(under),
    };
    if !valid_handle(handle) {
        return Err(usage(format!(
            "--under {} is not a valid agent address",
            crate::args::js_string(under)
        )));
    }
    Ok(())
}

/// why an attribution stopped
enum Stop {
    Call(CallError),
    /// the broker did not answer in time
    Late(String),
}

impl Stop {
    fn message(&self) -> &str {
        match self {
            Stop::Call(error) => error.message(),
            Stop::Late(message) => message,
        }
    }
}

impl From<CallError> for Stop {
    fn from(error: CallError) -> Self {
        Stop::Call(error)
    }
}

/// a connect failure that only says no broker runs for this user here: no agent runs this shell then
fn no_broker(error: &CallError) -> bool {
    match error {
        CallError::Io(message) => {
            message.starts_with("no relay broker at ")
                || message.starts_with("the relay broker did not start within ")
                || message.ends_with(
                    ", not this user's, or writable by others; refusing the relay socket in it",
                )
        }
        CallError::Relay { .. } => false,
    }
}

fn broker_dir(broker: Option<&str>, env: &Env) -> PathBuf {
    broker.map_or_else(|| relay_dir(env), PathBuf::from)
}

/// the explicit parent `under`, with a parent on this broker's own machine as a local address; another machine's needs a hub link
async fn place_under(
    launcher: &str,
    under: &str,
    broker: Option<&str>,
    env: &Env,
    warn: &dyn Fn(&str),
) -> Result<Attribution, Fail> {
    let mut parent = under.to_owned();
    if let Some((machine, handle)) = machine_address(under) {
        let dir = broker_dir(broker, env);
        let shown = dir.to_string_lossy().into_owned();
        let ms = ATTRIBUTE_TIMEOUT_MS;
        let check = async {
            let start: scp_mcp::client::Start = {
                let (dir, env) = (shown.clone(), env.clone());
                Rc::new(move || crate::open::start_broker(&dir, &env))
            };
            let client = connect_within(&dir, Some(start), ms).await?;
            let checked = async {
                let mut hello = Map::new();
                hello.insert("observe".into(), Value::Bool(true));
                client.hello(hello).await?;
                let bridge = client.request("cloud_status", json!({})).await?;
                Ok::<Value, Fail>(bridge)
            }
            .await;
            client.close();
            let bridge = checked?;
            let linked = get(&bridge, "machine").filter(|m| truthy(Some(m)));
            if !truthy(get(&bridge, "enabled")) || linked.is_none() {
                return Err(usage(format!(
                    "--under {under} names an agent on machine {machine}, but this relay broker is not linked to a hub ({CLI_NAME} login, then {CLI_NAME} cloud enable)"
                )));
            }
            if linked.and_then(Value::as_str) == Some(machine) {
                return Ok(Some(format!("me/{handle}")));
            }
            if get(&bridge, "connected") == Some(&Value::Bool(false)) {
                let why = get(&bridge, "last_error")
                    .filter(|e| !e.is_null())
                    .map_or_else(|| "connecting".to_owned(), js_text);
                warn(&format!(
                    "{CLI_NAME} {launcher}: this relay broker is not linked to the hub yet ({why}); the session starts as a root and links under {under} once the link is up ({CLI_NAME} whoami shows why it is not)"
                ));
            }
            Ok(None)
        };
        match tokio::time::timeout(Duration::from_millis(ms), check).await {
            Ok(Ok(Some(local))) => parent = local,
            Ok(Ok(None)) => {}
            Ok(Err(fail)) => return Err(fail),
            Err(_) => {
                return Err(usage(format!(
                    "no answer from the relay broker at {shown} within {ms} ms"
                )));
            }
        }
    }
    let mut vars = Map::new();
    vars.insert("SCP_UNDER".into(), Value::from(parent.clone()));
    Ok(Attribution {
        env: vars,
        parent: Some(parent),
    })
}

/// `String(value)`
fn js_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => scp_mcp::tools::js_num(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => items.iter().map(js_text).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

/// The grant `swarm spawn-env [--name N]` from this shell would mint, so the session a launcher starts links under the agent whose
/// harness runs this shell: bound as spawn-env binds (self attestation, lineage only at a terminal), with that agent's authority and no
/// more. A $SCP_GRANT is the caller's own when it binds this shell (a spawned agent's spent grant), and is replaced; any other applies
/// as is. An explicit parent replaces caller attribution with a claim request, including on resume. Nothing for a resumed session, on
/// the cloud transport, or when no agent runs this shell, which stays silent. Once a harness or agent is found, a failure warns and the
/// session starts unlinked; with `root`, or once the caller is known, without the caller's identity. `env` is the environment as the
/// router handed it, whose `SCP_CLI_ARGV` starts a broker
pub async fn attribute(
    launcher: &str,
    placement: Placement<'_>,
    env: &Env,
    cwd: &str,
    warn: &dyn Fn(&str),
) -> Result<Option<Attribution>, Fail> {
    validate_under(placement.under, placement.root)?;
    if let Some(under) = placement.under {
        return place_under(launcher, under, placement.dir, env, warn)
            .await
            .map(Some);
    }
    if placement.resume || env.get("SCP_TRANSPORT").is_some_and(|t| t == "cloud") {
        return Ok(None);
    }
    if placement.root {
        return Ok(Some(Attribution::default()));
    }
    let walk = walk(
        env,
        route::shell_pid(),
        read_ps_table(SHELL_PS_TIMEOUT_MS).map(Rc::new),
    );
    if walk.keys.is_empty() {
        return Ok(None);
    }
    Ok(caller_grant(launcher, placement, &walk, env, cwd, warn).await)
}

async fn caller_grant(
    launcher: &str,
    placement: Placement<'_>,
    walk: &Walk,
    env: &Env,
    cwd: &str,
    warn: &dyn Fn(&str),
) -> Option<Attribution> {
    let name = placement.name;
    let grant = env.get("SCP_GRANT").filter(|g| !g.is_empty());
    let own = if grant.is_some() || !terminal_attached(false) {
        walk.own.clone()
    } else {
        Vec::new()
    };
    let harnessed = walk.harness.is_some() || codex_shell(env);
    let unlinked = |why: &str| {
        warn(&format!(
            "{CLI_NAME} {launcher}: not linked under the agent that ran it ({why}); it starts as a root, {CLI_NAME} adopt <name> links it later"
        ))
    };
    let caller: RefCell<Option<String>> = RefCell::new(None);
    let ms = ATTRIBUTE_TIMEOUT_MS;
    let mint = async {
        let client = connect_within(&broker_dir(placement.dir, env), None, ms)
            .await
            .map_err(Stop::from)?;
        let minted: Result<Option<Attribution>, Stop> = async {
            let mut hello = Map::new();
            hello.insert("observe".into(), Value::Bool(true));
            hello.insert("lineage".into(), Value::from(walk.keys.clone()));
            let thread = codex_shell(env)
                .then(|| env.get("CODEX_THREAD_ID"))
                .flatten()
                .filter(|thread| codex_thread(thread));
            if let Some(thread) = thread {
                hello.insert("harness_session".into(), Value::from(thread.clone()));
            }
            if !own.is_empty() {
                hello.insert("self".into(), Value::from(own.clone()));
            }
            if let Some(grant) = grant {
                hello.insert("grant".into(), Value::from(grant.clone()));
            }
            hello.insert("cwd".into(), Value::from(cwd));
            hello.insert("brief".into(), Value::Bool(true));
            let bound = match client.hello(hello).await {
                Ok(bound) => bound,
                Err(_) if grant.is_some() => return Ok(None),
                Err(error) => return Err(Stop::from(error)),
            };
            *caller.borrow_mut() = get(&bound, "endpoint")
                .and_then(|endpoint| get(endpoint, "address"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            match client.request("rules", json!({})).await {
                Ok(rules) => {
                    *caller.borrow_mut() = get(&rules, "address")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
                Err(error) if caller.borrow().is_some() => return Err(Stop::from(error)),
                Err(_) => return Ok(None),
            }
            let Some(address) = caller.borrow().clone() else {
                return Ok(None);
            };
            let handle = address.rsplit('/').next().unwrap_or(&address);
            if let Some(named) = env.get("SCP_NAME").filter(|n| !n.is_empty())
                && named.strip_prefix("me/").unwrap_or(named) != handle
            {
                unlinked(&format!(
                    "$SCP_NAME names {named}, but this shell runs under {address}"
                ));
                *caller.borrow_mut() = None;
                return Ok(None);
            }
            let params = match name {
                Some(name) => json!({ "name": name }),
                None => json!({}),
            };
            let granted = client.request("grant", params).await.map_err(Stop::from)?;
            let vars = get(&granted, "env")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            Ok(Some(Attribution {
                env: vars,
                parent: Some(address),
            }))
        }
        .await;
        client.close();
        minted
    };
    let stopped = match tokio::time::timeout(Duration::from_millis(ms), mint).await {
        Ok(Ok(attribution)) => return attribution,
        Ok(Err(stop)) => stop,
        Err(_) => Stop::Late(format!("no answer from the relay broker within {ms} ms")),
    };
    let known = caller.borrow().is_some();
    let quiet = match &stopped {
        Stop::Call(error) => error.is_relay() || no_broker(error),
        Stop::Late(_) => false,
    };
    if !known && (!harnessed || quiet) {
        return None;
    }
    unlinked(stopped.message());
    known.then(Attribution::default)
}

/// the launch environment: the caller's identity swapped for the grant's, or `env` unchanged without one
pub fn attributed(env: &Env, attribution: Option<&Attribution>) -> Env {
    match attribution {
        Some(attribution) => spawn_environment(env, &attribution.env, None),
        None => env.clone(),
    }
}

/// the arguments before any `--`: a launched harness's own options
pub fn options_before(args: &[String]) -> &[String] {
    match args.iter().position(|arg| arg == "--") {
        Some(at) => &args[..at],
        None => args,
    }
}

/// whether `args` carries one of `flags` (bare or `--flag=value`) before any `--`
pub fn has_flag(args: &[String], flags: &[&str]) -> bool {
    options_before(args)
        .iter()
        .any(|arg| flags.contains(&arg.split('=').next().unwrap_or(arg)))
}

/// the note a launcher adds to its address line when a grant links the session
pub fn under_text(attribution: Option<&Attribution>) -> String {
    match attribution.and_then(|a| a.parent.as_deref()) {
        Some(parent) if !parent.is_empty() => format!(" under {parent}"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| (*w).to_owned()).collect()
    }

    #[test]
    fn an_explicit_parent_is_checked_before_anything_runs() {
        for address in ["lead", "me/lead", "me/vm/lead"] {
            assert!(validate_under(Some(address), false).is_ok());
        }
        assert_eq!(
            validate_under(Some("lead"), true),
            Err(usage("--under and --root cannot be used together"))
        );
        for bad in [
            "",
            "me/VM/lead",
            "me/-vm/lead",
            "me/vm/Bad",
            "me/vm/lead/extra",
            "me/",
        ] {
            assert_eq!(
                validate_under(Some(bad), false),
                Err(usage(format!(
                    "--under {} is not a valid agent address",
                    crate::args::js_string(bad)
                ))),
                "{bad}"
            );
        }
        assert!(validate_under(None, true).is_ok());
    }

    #[test]
    fn explicit_placement_skips_the_caller_and_strips_identity_even_on_resume() {
        let env: Env = [
            ("SCP_NAME", "caller"),
            ("SCP_GRANT", "spent"),
            ("SCP_SESSION", "caller-session"),
            ("SCP_UNDER", "old"),
            ("SCP_DIR", "/tmp/unused"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        let placement = Placement {
            under: Some("me/lead"),
            resume: true,
            ..Placement::default()
        };
        let got = crate::open::block_on(attribute("pi", placement, &env, "/tmp", &|_| {}))
            .unwrap()
            .unwrap()
            .unwrap();
        let mut vars = Map::new();
        vars.insert("SCP_UNDER".into(), Value::from("me/lead"));
        assert_eq!(
            got,
            Attribution {
                env: vars,
                parent: Some("me/lead".into())
            }
        );
        let launched = attributed(&env, Some(&got));
        let mut keys: Vec<_> = launched.iter().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                (&"SCP_DIR".to_owned(), &"/tmp/unused".to_owned()),
                (&"SCP_UNDER".to_owned(), &"me/lead".to_owned())
            ]
        );
    }

    #[test]
    fn flags_count_before_the_terminator_only() {
        let args = words(&["--model=x", "--", "--resume"]);
        assert_eq!(options_before(&args), &args[..1]);
        assert!(has_flag(&args, &["--model"]));
        assert!(!has_flag(&args, &["--resume"]));
        assert_eq!(under_text(None), "");
        let linked = Attribution {
            env: Map::new(),
            parent: Some("me/lead".into()),
        };
        assert_eq!(under_text(Some(&linked)), " under me/lead");
    }
}
