//! `swarm spawn --via <runner>`, which hands a spawn to a runner that starts the worker on another machine, and the spawn linked
//! `--under` an agent on another machine, which runs the harness as that agent's worker and hands its result back.

use super::argv::{
    Context, closed_stdin, codex_mount, codex_skips_git_check, harness_argv, native_mount_bin,
    program_at,
};
use super::grant::spawn_environment;
use super::harness::{Input, RunOptions, STDIN_WAIT_MS, harness_stdin, run_harness};
use super::output::{HarnessRun, harness_output, stderr_output};
use super::run::agent_shell;
use super::text::{name_suffix, spawn_title, worker_name};
use super::wake::linked_handback_body;
use crate::args::{Parsed, js_string};
use crate::open::{self, start_broker, terminal_attached};
use crate::{Call, Done, Fail, route, term, usage};
use scp_broker::runners::{Runner, parse_entries, run};
use scp_broker::spawn::runner_reply;
use scp_core::address::{valid_handle, valid_machine};
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::{CallError, Client, Start, connect_or_start, relay_dir};
use scp_mcp::identity::{labels_for, normalize_harness, safe_cwd, short_hostname};
use scp_mcp::ps::{Env, basename, join};
use scp_mcp::render::js_space;
use scp_mcp::tools::get;
use serde_json::{Map, Value, json};
use std::ffi::OsString;
use std::path::Path;
use std::rc::Rc;

/// the most UTF-16 units a worker's title takes
const TITLE_CHARS: usize = 64;
/// the flags `spawn --via` takes
const VIA_FLAGS: [&str; 8] = [
    "as", "harness", "name", "title", "labels", "bg", "json", "via",
];
/// the flags of a grant, which a worker linked under an agent on another machine runs without
const GRANT_FLAGS: [&str; 15] = [
    "scope",
    "rules",
    "in",
    "out",
    "allow",
    "group",
    "ttl",
    "peek",
    "no-push",
    "idle",
    "durable",
    "no-durable",
    "as",
    "human",
    "harness",
];

/// `$SCP_RUNNERS_FILE`, else runners.json beside the policy file
pub fn runners_path(env: &Env) -> String {
    if let Some(path) = env.get("SCP_RUNNERS_FILE").filter(|p| !p.is_empty()) {
        return path.clone();
    }
    let home = scp_broker::paths::account_home()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_else(|_| scp_mcp::identity::home_dir());
    join(&[&home, ".config", "scp", "runners.json"])
}

/// the configured runners, none when the file is missing
pub fn read_runners(path: &str) -> Result<Vec<(String, Runner)>, Fail> {
    if !Path::new(path).exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read(path).map_err(|error| Fail::Call(CallError::Io(error.to_string())))?;
    parse_entries(&String::from_utf8_lossy(&text), path).map_err(Fail::Usage)
}

pub fn runner_for(name: &str, runners: &[(String, Runner)], path: &str) -> Result<Runner, Fail> {
    if let Some((_, runner)) = runners.iter().find(|(known, _)| known == name) {
        return Ok(runner.clone());
    }
    let known: Vec<&str> = runners.iter().map(|(known, _)| known.as_str()).collect();
    let configured = if known.is_empty() {
        "none is configured".to_owned()
    } else {
        format!("configured: {}", known.join(", "))
    };
    Err(usage(format!(
        "no runner {} in {path}: {configured}",
        js_string(name)
    )))
}

/// `k=v,k=v` as `parseLabels` builds its object: invalid keys dropped, a repeated key keeping its first place and last value, array-index
/// keys first
fn ordered_labels(value: Option<&str>) -> Vec<(String, String)> {
    let mut labels: Vec<(String, String)> = Vec::new();
    for pair in value.unwrap_or("").split(',') {
        let Some(eq) = pair.find('=').filter(|eq| *eq > 0) else {
            continue;
        };
        let key = pair[..eq].trim_matches(js_space);
        if !label_key(key) {
            continue;
        }
        let value = pair[eq + 1..].trim_matches(js_space).to_owned();
        match labels.iter_mut().find(|(known, _)| known == key) {
            Some(entry) => entry.1 = value,
            None => labels.push((key.to_owned(), value)),
        }
    }
    let index = |key: &str| {
        key.parse::<u32>()
            .ok()
            .filter(|n| *n < u32::MAX && n.to_string() == key)
    };
    labels.sort_by_key(|(key, _)| index(key).map_or((1, 0), |n| (0, n)));
    labels
}

/// `^[a-z0-9][a-z0-9._-]{0,31}$`
fn label_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    let plain = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    (1..=32).contains(&bytes.len())
        && plain(&bytes[0])
        && bytes.iter().all(|c| plain(c) || b"._-".contains(c))
}

/// what a runner reads on stdin, as `JSON.stringify` writes it
pub fn spawn_request(
    name: &str,
    title: Option<&str>,
    command: &[String],
    cwd: &str,
    parent: &str,
    labels: &[(String, String)],
) -> String {
    let cmd: Vec<String> = command.iter().map(|word| js_string(word)).collect();
    let labels: Vec<String> = labels
        .iter()
        .map(|(key, value)| format!("{}:{}", js_string(key), js_string(value)))
        .collect();
    format!(
        "{{\"scp\":1,\"event\":\"spawn\",\"name\":{name},\"title\":{},\"cmd\":[{}],\"cwd\":{},\"parent\":{parent},\"labels\":{{{}}},\"join\":{{\"under\":{parent},\"name\":{name},\"mode\":\"account\"}}}}",
        title.map_or_else(|| "null".to_owned(), js_string),
        cmd.join(","),
        js_string(cwd),
        labels.join(","),
        name = js_string(name),
        parent = js_string(parent),
    )
}

/// a runner's reply in the order the CLI spreads it: address, machine, ref, attach
fn reply_entries(reply: &Map<String, Value>) -> Vec<(&'static str, String)> {
    ["address", "machine", "ref", "attach"]
        .into_iter()
        .filter_map(|key| {
            reply
                .get(key)
                .and_then(Value::as_str)
                .map(|value| (key, value.to_owned()))
        })
        .collect()
}

/// what `spawn --via` prints once the runner started the worker
pub fn via_started(
    name: &str,
    runner: &str,
    parent: &str,
    reply: Option<&Map<String, Value>>,
    json: bool,
) -> Vec<String> {
    let entries = reply.map(reply_entries).unwrap_or_default();
    let field = |key: &str| {
        entries
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.as_str())
    };
    if json {
        let mut fields = vec![
            format!("\"name\":{}", js_string(name)),
            format!("\"runner\":{}", js_string(runner)),
            format!("\"parent\":{}", js_string(parent)),
        ];
        fields.extend(
            entries
                .iter()
                .map(|(key, value)| format!("\"{key}\":{}", js_string(value))),
        );
        return vec![format!("{{{}}}", fields.join(","))];
    }
    let place = match reply {
        Some(_) => format!(
            "on machine {} and shows under you as {}",
            field("machine").unwrap_or_default(),
            field("address").unwrap_or_default()
        ),
        None => format!("on another machine and shows under you as me/<machine>/{name}"),
    };
    let mut lines = vec![format!(
        "{name} handed to runner {runner}: it starts {place}; its result arrives as a relay message by itself"
    )];
    if let Some(attach) = field("attach").filter(|attach| !attach.is_empty()) {
        lines.push(format!("attach: {attach}"));
    }
    lines
}

/// `--name`, else the default worker name, as a valid handle
fn spawn_name(values: &Parsed, command: &[String]) -> Result<String, Fail> {
    let name = match values.text("name") {
        Some(name) => name.strip_prefix("me/").unwrap_or(name).to_owned(),
        None => worker_name(command, name_suffix),
    };
    if !valid_handle(&name) {
        return Err(usage(format!(
            "--name {} is not a valid agent handle: lowercase letters, digits, . _ -",
            js_string(&name)
        )));
    }
    Ok(name)
}

/// this broker's machine on the hub, refusing when the broker is not linked to one
async fn hub_machine(client: &Client, why: &str) -> Result<String, Fail> {
    let bridge = client.request("cloud_status", json!({})).await?;
    let enabled = scp_mcp::tools::truthy(get(&bridge, "enabled"));
    match get(&bridge, "machine").and_then(Value::as_str) {
        Some(machine) if enabled && !machine.is_empty() => Ok(machine.to_owned()),
        _ => Err(usage(format!(
            "{why}, but this relay broker is not linked to a hub ({CLI_NAME} login, then {CLI_NAME} cloud enable)"
        ))),
    }
}

/// the environment a runner gets: the caller's, without the spawner's identity
fn runner_env(env: &Env) -> Vec<(OsString, OsString)> {
    let mut parent = env.clone();
    route::caller_argv(&mut parent);
    spawn_environment(&parent, &Map::new(), None)
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect()
}

/// `swarm spawn --via <runner>`: hand the spawn to a runner that starts the worker on another machine, linked under the caller
pub async fn via_spawn(values: &Parsed, command: &[String], cwd: &str, env: &Env) -> Done {
    let via = values.text("via").unwrap_or_default();
    if let Some((extra, _)) = values
        .values
        .iter()
        .find(|(key, _)| !VIA_FLAGS.contains(&key.as_str()))
    {
        return Err(usage(format!(
            "--via starts the worker on another machine under you, without a local grant: it takes --name, --title, --labels and --json, not --{extra}"
        )));
    }
    let path = runners_path(env);
    let runner = runner_for(via, &read_runners(&path)?, &path)?;
    let name = spawn_name(values, command)?;
    let title = match values.text("title") {
        Some(title) => Some(title.to_owned()),
        None => spawn_title(command),
    };
    if title
        .as_ref()
        .is_some_and(|title| title.encode_utf16().count() > TITLE_CHARS)
    {
        return Err(usage(format!(
            "--title is longer than {TITLE_CHARS} characters"
        )));
    }
    let plan = open::plan(
        "spawn",
        values,
        env,
        route::shell_pid(),
        terminal_attached(false),
    )?;
    let opened = open::open("spawn", plan, env).await?;
    if opened.broker.is_null() {
        opened.client.close();
        return Err(usage(format!(
            "{CLI_NAME} spawn is the local broker's; it has no --cloud form"
        )));
    }
    let client = &opened.client;
    let done = via_run(
        client,
        &opened.me,
        via,
        &runner,
        &name,
        title.as_deref(),
        values,
        command,
        cwd,
        env,
    )
    .await;
    client.close();
    done
}

#[allow(clippy::too_many_arguments)]
async fn via_run(
    client: &Client,
    me: &Value,
    via: &str,
    runner: &Runner,
    name: &str,
    title: Option<&str>,
    values: &Parsed,
    command: &[String],
    cwd: &str,
    env: &Env,
) -> Done {
    let address = get(me, "address").and_then(Value::as_str).unwrap_or("");
    let agent = get(me, "kind").and_then(Value::as_str) == Some("agent");
    let Some(handle) = address.strip_prefix("me/").filter(|_| agent) else {
        return Err(usage(format!(
            "{CLI_NAME} spawn --via starts a worker under you: run it from an agent's session, or name the agent with --as"
        )));
    };
    let why = format!("{CLI_NAME} spawn --via shows the worker under you through the hub");
    let parent = format!("me/{}/{handle}", hub_machine(client, &why).await?);
    let labels = ordered_labels(values.text("labels"));
    let request = spawn_request(name, title, command, cwd, &parent, &labels);
    let result = run(
        &runner.command,
        runner.timeout_s,
        &request,
        &runner_env(env),
        Path::new(cwd),
        libc::SIGTERM,
    )
    .await;
    if result.code == 0 {
        let reply = serde_json::from_str::<Value>(result.stdout.trim_matches(js_space))
            .ok()
            .and_then(|value| runner_reply(&value, name));
        let mut params = reply.clone().unwrap_or_default();
        params.insert("name".into(), Value::from(name));
        params.insert("runner".into(), Value::from(via));
        if let Err(error) = client.request("spawn_via", Value::Object(params)).await {
            term::err(&format!(
                "{name} started, but the broker did not record it: {CLI_NAME} end cannot stop it through the runner ({})",
                error.message()
            ));
        }
        for line in via_started(name, via, &parent, reply.as_ref(), values.on("json")) {
            term::out(&line);
        }
        return Ok(0);
    }
    let failed = if result.timed_out {
        format!("did not finish within {} s", runner.timeout_s)
    } else {
        format!("failed (exit {})", result.code)
    };
    let stderr = if result.stderr.is_empty() {
        String::new()
    } else {
        format!(":\n{}", result.stderr)
    };
    term::note(&format!("{CLI_NAME} spawn: runner {via} {failed}{stderr}"));
    Ok(result.code)
}

/// a spawn linked under an agent on another machine: the parent, this broker's machine, the worker's name, its title and labels
#[derive(Debug, Clone, PartialEq)]
pub struct LinkedPlan {
    pub parent: String,
    pub machine: String,
    pub name: String,
    pub title: Option<String>,
    pub labels: Option<String>,
}

/// the machine `me/<machine>/<handle>` names, when `under` is one
fn machine_of(under: &str) -> Option<&str> {
    let (machine, agent) = under.strip_prefix("me/")?.split_once('/')?;
    (valid_machine(machine) && !agent.is_empty() && !agent.contains('/')).then_some(machine)
}

/// `--under me/<machine>/<handle>` naming an agent on another machine: the linked spawn's plan; None for an agent of this machine
pub async fn linked_plan(
    values: &Parsed,
    command: &[String],
    env: &Env,
) -> Result<Option<LinkedPlan>, Fail> {
    let Some(under) = values.text("under") else {
        return Ok(None);
    };
    let Some(remote) = machine_of(under) else {
        return Ok(None);
    };
    let machine = {
        let client = connect(env).await?;
        let mut hello = Map::new();
        hello.insert("observe".into(), Value::Bool(true));
        let why = format!("--under {under} names an agent on machine {remote}");
        let machine = match client.hello(hello).await {
            Ok(_) => hub_machine(&client, &why).await,
            Err(error) => Err(error.into()),
        };
        client.close();
        machine?
    };
    if machine == remote {
        return Ok(None);
    }
    if values.has("via") {
        return Err(usage(
            "--via and --under an agent on another machine: the runner already starts this spawn there",
        ));
    }
    if let Some((granted, _)) = values
        .values
        .iter()
        .find(|(key, _)| GRANT_FLAGS.contains(&key.as_str()))
    {
        return Err(usage(format!(
            "a worker under an agent on another machine runs without a grant: --{granted} does not apply"
        )));
    }
    Ok(Some(LinkedPlan {
        parent: under.to_owned(),
        machine,
        name: spawn_name(values, command)?,
        title: values.text("title").map(str::to_owned),
        labels: values.text("labels").map(str::to_owned),
    }))
}

/// a connection to this machine's broker, started when it does not run
async fn connect(env: &Env) -> Result<Client, CallError> {
    let dir = relay_dir(env);
    let start: Start = {
        let (dir, env) = (dir.to_string_lossy().into_owned(), env.clone());
        Rc::new(move || start_broker(&dir, &env))
    };
    connect_or_start(&dir, Some(start)).await
}

/// what a linked spawn shares with its run
pub struct Linked<'a> {
    pub call: &'a Call<'a>,
    pub env: &'a Env,
    pub command: &'a [String],
    pub cwd: &'a str,
    pub group: bool,
    pub bytes: Option<i64>,
}

/// Run the harness as `plan.name` linked under its parent on another machine, then hand its result back as the worker.
pub async fn linked_spawn(
    plan: &LinkedPlan,
    linked: &Linked<'_>,
    started: Option<super::harness::Started<'_>>,
) -> Done {
    let mut parent = linked.env.clone();
    route::caller_argv(&mut parent);
    let mut grant = Map::new();
    grant.insert("SCP_NAME".into(), Value::from(plan.name.as_str()));
    grant.insert("SCP_UNDER".into(), Value::from(plan.parent.as_str()));
    let env = spawn_environment(&parent, &grant, plan.labels.as_deref());
    let command = linked.command;
    let codex = command
        .get(program_at(command))
        .is_some_and(|program| basename(program) == "codex");
    let bin = codex.then(|| native_mount_bin(&env)).flatten();
    let self_words = super::run::self_words(linked.call, linked.env);
    let here = safe_cwd();
    let context = Context {
        self_words: &self_words,
        mount: &codex_mount,
        bin: bin.as_deref(),
        cwd: &here,
        probe: &codex_skips_git_check,
    };
    let argv = harness_argv(command, &env, &context);
    let stdin = if closed_stdin(command) {
        let wait = agent_shell(linked.env).then_some(STDIN_WAIT_MS);
        harness_stdin(wait).await
    } else if closed_stdin(&argv) {
        Input::Ignore
    } else {
        Input::Inherit
    };
    let options = RunOptions {
        group: linked.group,
        stdin,
        started,
        ..RunOptions::default()
    };
    let run = run_harness(&argv, &env, options).await?;
    if run.started {
        linked_handback(plan, linked, &env, &run).await;
    }
    Ok(run.code)
}

async fn linked_handback(plan: &LinkedPlan, linked: &Linked<'_>, env: &Env, run: &HarnessRun) {
    if let Err(error) = try_handback(plan, linked, env, run).await {
        super::harness::note(&format!(
            "{CLI_NAME} spawn: could not hand {}'s result back to {}: {}",
            plan.name,
            plan.parent,
            error.message()
        ));
    }
}

async fn try_handback(
    plan: &LinkedPlan,
    linked: &Linked<'_>,
    env: &Env,
    run: &HarnessRun,
) -> Result<(), CallError> {
    let command = linked.command;
    let program = command.get(program_at(command)).map_or("", |p| basename(p));
    let harness = normalize_harness(Some(program), "cli");
    let client = connect(linked.env).await?;
    let done = async {
        let mut claim = Map::new();
        claim.insert("handle".into(), Value::from(plan.name.as_str()));
        claim.insert("exact".into(), Value::Bool(true));
        claim.insert("harness".into(), Value::from(harness));
        claim.insert("cwd".into(), Value::from(linked.cwd));
        claim.insert("under".into(), Value::from(plan.parent.as_str()));
        claim.insert(
            "labels".into(),
            Value::Object(labels_for(env, &short_hostname)),
        );
        let mut hello = Map::new();
        hello.insert("claim".into(), Value::Object(claim));
        let hello = client.hello(hello).await?;
        let me = get(&hello, "endpoint").cloned().unwrap_or(Value::Null);
        let own = get(&me, "address").and_then(Value::as_str).unwrap_or("");
        let address = format!("me/{}/{}", plan.machine, own.get(3..).unwrap_or(""));
        let titled = scp_mcp::tools::truthy(get(&me, "title"));
        if let Some(title) = plan.title.as_deref().filter(|t| !t.is_empty() && !titled) {
            client.request("title", json!({ "text": title })).await?;
        }
        let code = run.code.min(255);
        let body = linked_handback_body(
            &address,
            code,
            &harness_output(run, linked.bytes),
            &stderr_output(run, None),
        );
        let send = json!({ "to": plan.parent, "kind": "message", "body": body });
        client.request("send", send).await?;
        let status = json!({ "state": "done", "note": format!("exited {code}") });
        client.request("status", status).await?;
        Ok(())
    }
    .await;
    client.close();
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spawn_request_is_written_as_json_stringify_writes_it() {
        let labels = ordered_labels(Some("team=a,2=x,b=y,team=c,1=z, Bad=q"));
        assert_eq!(
            labels,
            vec![
                ("1".to_owned(), "z".to_owned()),
                ("2".to_owned(), "x".to_owned()),
                ("team".to_owned(), "c".to_owned()),
                ("b".to_owned(), "y".to_owned()),
            ]
        );
        let command = [
            "codex".to_owned(),
            "exec".to_owned(),
            "say \"hi\"".to_owned(),
        ];
        assert_eq!(
            spawn_request("w", None, &command, "/w", "me/m/lead", &labels[2..3]),
            r#"{"scp":1,"event":"spawn","name":"w","title":null,"cmd":["codex","exec","say \"hi\""],"cwd":"/w","parent":"me/m/lead","labels":{"team":"c"},"join":{"under":"me/m/lead","name":"w","mode":"account"}}"#
        );
        assert!(
            spawn_request("w", Some("t"), &command, "/w", "p", &[]).contains(r#""title":"t","#)
        );
    }

    #[test]
    fn the_started_lines_name_the_machine_and_attach() {
        let reply: Map<String, Value> = serde_json::from_str(
            r#"{"machine":"vm","attach":"ssh vm","address":"me/vm/w","ref":"r1"}"#,
        )
        .unwrap();
        assert_eq!(
            via_started("w", "vm", "me/l/lead", Some(&reply), true),
            vec![
                r#"{"name":"w","runner":"vm","parent":"me/l/lead","address":"me/vm/w","machine":"vm","ref":"r1","attach":"ssh vm"}"#
            ]
        );
        assert_eq!(
            via_started("w", "vm", "me/l/lead", Some(&reply), false),
            vec![
                "w handed to runner vm: it starts on machine vm and shows under you as me/vm/w; its result arrives as a relay message by itself",
                "attach: ssh vm"
            ]
        );
        assert_eq!(
            via_started("w", "vm", "me/l/lead", None, false),
            vec![
                "w handed to runner vm: it starts on another machine and shows under you as me/<machine>/w; its result arrives as a relay message by itself"
            ]
        );
        assert_eq!(
            via_started("w", "vm", "me/l/lead", None, true),
            vec![r#"{"name":"w","runner":"vm","parent":"me/l/lead"}"#]
        );
    }

    #[test]
    fn an_unknown_runner_names_those_configured_in_file_order() {
        let runners = parse_entries(
            r#"{"b":{"command":["x"]},"a":{"command":["y"]},"7":{"command":["z"]}}"#,
            "r.json",
        )
        .unwrap();
        assert_eq!(
            runner_for("nope", &runners, "r.json"),
            Err(usage(r#"no runner "nope" in r.json: configured: 7, b, a"#))
        );
        assert_eq!(
            runner_for("x", &[], "r.json"),
            Err(usage(r#"no runner "x" in r.json: none is configured"#))
        );
        assert_eq!(
            runner_for("a", &runners, "r.json").unwrap().command,
            vec!["y"]
        );
    }

    #[test]
    fn only_an_agent_on_a_named_machine_is_linked() {
        assert_eq!(machine_of("me/box/lead"), Some("box"));
        assert_eq!(machine_of("me/b0x-1/a.b"), Some("b0x-1"));
        for local in [
            "lead",
            "me/lead",
            "me/Box/lead",
            "me/-box/lead",
            "me/box/",
            "me/box/a/b",
        ] {
            assert_eq!(machine_of(local), None, "{local}");
        }
    }
}
