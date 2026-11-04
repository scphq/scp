//! `swarm claude-bg-task`, `swarm claude-wake`, `swarm claude ls` and `swarm claude prune`.

use super::bg_io::{
    Claude, Outcome, Port, Work, acts, apply, arm_ticket, claude_of, current_config, follow_resume,
    now_ms, run_bg_task, transcript_gone,
};
use super::bg_plan::{Action, Index, PlanInput, attach_targets, js_space, parse_seconds, plan};
use super::bg_state::{
    Agent, BgState, Entry, PROVIDER, Records, read_records, read_state, read_states,
    read_task_state, ref_session, safe_name, session_id, short_id, wake_ticket, without,
    write_state, write_task_state,
};
use crate::fleet::json::Json;
use crate::fleet::view::table;
use crate::{Done, Fail, Host, term, usage};
use scp_core::protocol::{CLI_NAME, revive_record};
use scp_mcp::client::CallError;
use scp_mcp::ps::Env;
use std::collections::{HashMap, HashSet};
use std::future::Future;

const WAKE_PROMPT: &str = "You were woken by an SCP message: read it with relay_inbox.";

/// `future` on one thread, for a client that lives on a local set
fn block_on<T>(future: impl Future<Output = T>) -> Result<T, Fail> {
    let runtime = crate::open::runtime()?;
    let local = tokio::task::LocalSet::new();
    let value = local.block_on(&runtime, future);
    drop(local);
    runtime.shutdown_background();
    Ok(value)
}

fn thrown(message: String) -> Fail {
    Fail::Call(CallError::Io(message))
}

/// `swarm claude-bg-task`: one run of the broker's task on its socket as the human, keeping what it learnt in `claude-bg-task.json`
pub fn task(_args: &[String], env: &Env, host: &Host) -> Done {
    block_on(async {
        let port = match Port::open(env).await {
            Ok(port) => port,
            Err(error) => {
                term::note(&format!(
                    "{CLI_NAME} claude-bg-task: no relay broker ({})",
                    error.message()
                ));
                return 1;
            }
        };
        let mut state = read_task_state(env);
        let ran = run_bg_task(&mut state, &port, env, host).await;
        let _ = write_task_state(env, &state);
        port.close();
        match ran {
            Ok(()) => 0,
            Err(message) => {
                term::err(&format!("relay broker: task claude-bg failed: {message}"));
                1
            }
        }
    })
}

/// the short ids whose state files a plan reads: the recorded sessions and every listed background session
fn state_ids<'a>(records: &'a Records, entries: &'a [Entry]) -> HashSet<&'a str> {
    let listed = entries
        .iter()
        .filter_map(|entry| entry.id.as_deref())
        .filter(|id| short_id(id));
    records.keys().map(String::as_str).chain(listed).collect()
}

/// the Claude Code session the caller runs in, by its session id
fn own_sessions(env: &Env) -> HashSet<String> {
    env.get("CLAUDE_CODE_SESSION_ID")
        .filter(|id| !id.is_empty())
        .cloned()
        .into_iter()
        .collect()
}

fn role_of(agent: Option<&Agent>) -> &'static str {
    match agent {
        None => "unknown",
        Some(agent) if agent.parent.as_deref().is_none_or(str::is_empty) => "orchestrator",
        Some(agent) if agent.children > 0.0 => "orchestrator",
        Some(_) => "worker",
    }
}

fn nullable(value: Option<&str>) -> Json {
    value.map_or(Json::Null, Json::str)
}

/// what the policy would do with each session, by short id
async fn policy_lines(
    claude: &Claude,
    env: &Env,
    agents: &[Agent],
    records: &Records,
    entries: &[Entry],
    all: bool,
) -> HashMap<String, String> {
    let table = claude.ps().await;
    let config = current_config(env);
    let listed = if all { None } else { claude.list(true).await };
    let entries = listed.as_deref().unwrap_or(entries);
    let actions = plan(&PlanInput {
        entries,
        agents,
        records,
        states: &read_states(env, state_ids(records, entries).into_iter()),
        attached: &table.as_deref().map_or_else(HashSet::new, attach_targets),
        processes: table.as_deref(),
        now: now_ms(),
        config,
        older_than_s: None,
        stop_only: false,
        retry_refused: false,
        own_sessions: &own_sessions(env),
        own_pids: &claude.ancestors().await.unwrap_or_default(),
    });
    let mut policy = HashMap::new();
    for action in actions {
        let line = match &action {
            Action::Unhibernate(_) => continue,
            Action::Keep { reason, .. } => format!("kept: {reason}"),
            _ if table.is_none() => "ps failed, so attached is unknown".to_owned(),
            Action::Orphan { .. } => "due: remove, no endpoint".to_owned(),
            Action::Stop(_) => "due: stop".to_owned(),
            Action::Remove { .. } => "due: remove".to_owned(),
        };
        policy.insert(action.id().to_owned(), line);
    }
    policy
}

/// `swarm claude ls [--all] [--json]`: the background sessions with their SCP role, orchestrators first
async fn ls(argv: &[String], env: &Env) -> Done {
    let all = argv.iter().any(|arg| arg == "--all");
    let json = argv.iter().any(|arg| arg == "--json");
    if let Some(unknown) = argv.iter().find(|arg| *arg != "--all" && *arg != "--json") {
        return Err(usage(format!(
            "{CLI_NAME} claude ls takes --all and --json, not {unknown}"
        )));
    }
    let claude = claude_of(env).ok_or_else(|| usage("claude is not on PATH"))?;
    let entries = claude
        .list(all)
        .await
        .ok_or_else(|| thrown(format!("{CLI_NAME} claude: claude agents --json failed")))?;
    let records = read_records(env);
    let agents = match Port::open(env).await {
        Ok(port) => {
            let agents = port.agents().await;
            port.close();
            agents
        }
        Err(error) => Err(error.message().to_owned()),
    };
    let agents = agents
        .map_err(|message| {
            term::note(&format!(
                "{CLI_NAME} claude: no endpoints, so every role shows unknown ({message})"
            ));
        })
        .ok();
    let policy = match &agents {
        Some(agents) => policy_lines(&claude, env, agents, &records, &entries, all).await,
        None => HashMap::new(),
    };
    let known = agents.unwrap_or_default();
    let index = Index::new(&known);
    let mut rows: Vec<Row> = entries
        .iter()
        .filter(|entry| entry.background() && entry.id.is_some())
        .map(|entry| {
            let id = entry.id.as_deref().unwrap_or_default();
            let record = records.get(id);
            let agent = index.endpoint_of(entry, record);
            Row {
                entry,
                id,
                role: role_of(agent),
                endpoint: agent.map(|agent| agent.address.as_str()),
                swarm: record.is_some(),
                policy: policy.get(id).map(String::as_str),
            }
        })
        .collect();
    rows.sort_by_key(|row| row.role != "orchestrator");
    if json {
        term::out(&Json::Arr(rows.iter().map(Row::to_json).collect()).compact());
    } else if rows.is_empty() {
        term::note(&format!("{CLI_NAME} claude: no background sessions"));
    } else {
        let head = ["ID", "NAME", "STATE", "ROLE", "ENDPOINT", "POLICY", "CWD"];
        let cells = std::iter::once(head.map(str::to_owned).to_vec())
            .chain(rows.iter().map(Row::cells))
            .collect::<Vec<_>>();
        for line in table(&cells) {
            term::out(&line);
        }
    }
    Ok(0)
}

struct Row<'a> {
    entry: &'a Entry,
    id: &'a str,
    role: &'static str,
    endpoint: Option<&'a str>,
    swarm: bool,
    policy: Option<&'a str>,
}

impl Row<'_> {
    fn to_json(&self) -> Json {
        let entry = self.entry;
        Json::object(vec![
            ("id", Json::str(self.id)),
            ("name", nullable(entry.name.as_deref())),
            ("state", nullable(entry.state.as_deref())),
            ("status", nullable(entry.status.as_deref())),
            ("role", Json::str(self.role)),
            ("endpoint", nullable(self.endpoint)),
            ("cwd", nullable(entry.cwd.as_deref())),
            ("swarm", Json::Bool(self.swarm)),
            ("policy", nullable(self.policy)),
        ])
    }

    fn cells(&self) -> Vec<String> {
        let entry = self.entry;
        let state = [entry.state.as_deref(), entry.status.as_deref()]
            .into_iter()
            .flatten()
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        vec![
            self.id.to_owned(),
            entry.name.clone().unwrap_or_default(),
            state,
            self.role.to_owned(),
            self.endpoint.unwrap_or("-").to_owned(),
            self.policy.unwrap_or("-").to_owned(),
            entry.cwd.clone().unwrap_or_default(),
        ]
    }
}

struct Prune {
    dry_run: bool,
    stop_only: bool,
    unrecorded: bool,
    older_than_s: Option<f64>,
}

fn prune_flags(argv: &[String]) -> Result<Prune, Fail> {
    let mut flags = Prune {
        dry_run: false,
        stop_only: false,
        unrecorded: false,
        older_than_s: None,
    };
    let mut words = argv.iter();
    while let Some(arg) = words.next() {
        match arg.as_str() {
            "--dry-run" => flags.dry_run = true,
            "--stop-only" => flags.stop_only = true,
            "--unhibernate-unrecorded" => flags.unrecorded = true,
            "--older-than" => {
                let value = words.next().ok_or_else(|| {
                    usage(format!(
                        "{CLI_NAME} claude prune --older-than takes a duration such as 30m, 2h or 1d"
                    ))
                })?;
                flags.older_than_s = Some(parse_seconds(value, "--older-than").map_err(usage)?);
            }
            _ => match arg.strip_prefix("--older-than=") {
                Some(value) => {
                    flags.older_than_s = Some(parse_seconds(value, "--older-than").map_err(usage)?);
                }
                None => {
                    return Err(usage(format!(
                        "{CLI_NAME} claude prune takes --dry-run, --stop-only, --older-than <duration> and --unhibernate-unrecorded, not {arg}"
                    )));
                }
            },
        }
    }
    if flags.unrecorded && (flags.stop_only || flags.older_than_s.is_some()) {
        return Err(usage(format!(
            "{CLI_NAME} claude prune --unhibernate-unrecorded stops nothing: it does not go with --stop-only or --older-than"
        )));
    }
    Ok(flags)
}

/// clears the `claude-bg` hibernation of every endpoint whose listed session has no launcher record; stops, removes and respawns nothing
async fn unhibernate_unrecorded(
    entries: &[Entry],
    records: &Records,
    port: &Port,
    dry_run: bool,
) -> Result<i32, String> {
    let ids: HashMap<&str, &str> = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.id.as_deref().filter(|id| short_id(id))?;
            let session = entry.session_id.as_deref().filter(|id| !id.is_empty())?;
            (!records.contains_key(id)).then_some((session, id))
        })
        .collect();
    let mut failed = false;
    for agent in port.agents().await? {
        let id = agent
            .harness_session
            .as_deref()
            .filter(|_| agent.hibernate.as_deref() == Some(PROVIDER))
            .and_then(|session| ids.get(session).copied());
        let Some(id) = id else {
            continue;
        };
        let stopped = entries
            .iter()
            .any(|entry| entry.id.as_deref() == Some(id) && entry.pid.is_none());
        let after = if stopped {
            ": it stays stopped, and a message waits in its mailbox"
        } else {
            ""
        };
        if dry_run {
            term::out(&format!("would unhibernate {id} {}{after}", agent.address));
            continue;
        }
        match port.unhibernate(&agent).await {
            Ok(()) => term::out(&format!("unhibernated {id} {}{after}", agent.address)),
            Err(why) => {
                failed = true;
                term::out(&format!("kept {id} {}: {why}", agent.address));
            }
        }
    }
    Ok(i32::from(failed))
}

async fn prune_on(
    flags: &Prune,
    claude: &Claude,
    port: &Port,
    env: &Env,
    host: &Host,
) -> Result<i32, String> {
    let entries = claude
        .list(true)
        .await
        .ok_or_else(|| format!("{CLI_NAME} claude: claude agents --json --all failed"))?;
    if flags.unrecorded {
        let records = read_records(env);
        return unhibernate_unrecorded(&entries, &records, port, flags.dry_run).await;
    }
    let table = claude.ps().await;
    let own_pids = claude.ancestors().await;
    let (Some(table), Some(own_pids)) = (table, own_pids) else {
        return Err(format!(
            "{CLI_NAME} claude: ps failed, so attached sessions are unknown"
        ));
    };
    let records = read_records(env);
    let agents = port.agents().await?;
    let actions = plan(&PlanInput {
        entries: &entries,
        agents: &agents,
        records: &records,
        states: &read_states(env, state_ids(&records, &entries).into_iter()),
        attached: &attach_targets(&table),
        processes: Some(&table),
        now: now_ms(),
        config: current_config(env),
        older_than_s: flags.older_than_s,
        stop_only: flags.stop_only,
        retry_refused: true,
        own_sessions: &own_sessions(env),
        own_pids: &own_pids,
    });
    for action in &actions {
        if let Action::Keep { id, agent, reason } = action {
            let address = agent
                .as_ref()
                .map_or_else(String::new, |agent| format!(" {}", agent.address));
            term::out(&format!("keep {id}{address}: {reason}"));
        }
    }
    let acting: Vec<Action> = acts(actions)
        .into_iter()
        .filter(|action| !matches!(action, Action::Unhibernate(_)))
        .collect();
    if flags.dry_run {
        for action in &acting {
            let word = match action {
                Action::Stop(_) => "stop",
                _ => "remove",
            };
            term::out(&format!("would {word} {} {}", action.id(), action.place()));
        }
        return Ok(0);
    }
    let work = Work { claude, env, port };
    let mut failed = false;
    for Outcome {
        action,
        failed: why,
    } in apply(acting, &work, host).await
    {
        let (id, place) = (action.id(), action.place());
        match why {
            None => term::out(&format!("{} {id} {place}", action.verb())),
            Some(why) => {
                failed = true;
                term::out(&format!("kept {id} {place}: {why}"));
            }
        }
    }
    Ok(i32::from(failed))
}

/// `swarm claude prune [--dry-run] [--stop-only] [--older-than <dur>]`: stops and removes finished workers now, with the policy's guards;
/// `--unhibernate-unrecorded` only clears the `claude-bg` hibernation of sessions `swarm claude --bg` did not start
async fn prune(argv: &[String], env: &Env, host: &Host) -> Done {
    let flags = prune_flags(argv)?;
    let claude = claude_of(env).ok_or_else(|| usage("claude is not on PATH"))?;
    let port = Port::open(env).await.map_err(|error| {
        thrown(format!(
            "{CLI_NAME} claude prune needs the relay broker, which knows each session's endpoint ({}); start it with {CLI_NAME} daemon",
            error.message()
        ))
    })?;
    let done = prune_on(&flags, &claude, &port, env, host).await;
    port.close();
    done.map_err(thrown)
}

/// `swarm claude ls` and `swarm claude prune`; the router hands no other word here
pub fn claude(args: &[String], env: &Env, host: &Host) -> Done {
    let (verb, rest) = args
        .split_first()
        .map_or(("", args), |(verb, rest)| (verb.as_str(), rest));
    block_on(async {
        if verb == "ls" {
            ls(rest, env).await
        } else {
            prune(rest, env, host).await
        }
    })?
}

fn decline(reason: &str) -> i32 {
    term::out(&Json::object(vec![("declined", Json::str(reason))]).compact());
    77
}

/// the `backgrounded <mark> <short id>` a `claude --bg` prints: the short id
pub fn backgrounded(text: &str) -> Option<&str> {
    text.match_indices("backgrounded").find_map(|(at, word)| {
        let rest = text[at + word.len()..].trim_start_matches(js_space);
        let mark = rest.chars().next().filter(|c| c.len_utf16() == 1)?;
        let id = rest[mark.len_utf8()..].trim_start_matches(js_space);
        id.get(..8).filter(|id| short_id(id))
    })
}

/// whether the wake is for the endpoint's own session: the handle its stop saved, else the harness session its hooks reported, else its
/// launcher record's handle must match
fn owned(
    env: &Env,
    reference: &str,
    state: Option<&BgState>,
    record_handle: Option<&str>,
    recorded: bool,
) -> bool {
    let endpoint = env
        .get("SCP_WAKE_ENDPOINT")
        .map(|endpoint| endpoint.rsplit('/').next().unwrap_or(endpoint));
    let handles: Vec<&str> = [env.get("SCP_WAKE_HANDLE").map(String::as_str), endpoint]
        .into_iter()
        .flatten()
        .collect();
    if let Some(saved) = state.and_then(BgState::handle) {
        return handles.iter().all(|handle| *handle == saved);
    }
    match env
        .get("SCP_WAKE_SESSION")
        .filter(|session| !session.is_empty())
    {
        Some(session) => session == reference,
        None => recorded && handles.iter().all(|handle| Some(*handle) == record_handle),
    }
}

async fn wake_run(env: &Env, host: &Host) -> i32 {
    let raw = env
        .get("SCP_WAKE_REF")
        .map(String::as_str)
        .unwrap_or_default();
    let revive = revive_record(Some(raw));
    let reference = ref_session(raw);
    let id = reference.chars().take(8).collect::<String>();
    if !session_id(&reference) || !short_id(&id) {
        return decline("unresumable");
    }
    let given = env
        .get("SCP_WAKE_TICKET")
        .filter(|ticket| !ticket.is_empty());
    let ticket = given
        .filter(|ticket| wake_ticket(ticket))
        .map(String::as_str);
    if given.is_some() && ticket.is_none() {
        return 1;
    }
    let Some(claude) = claude_of(env) else {
        term::note(&format!("{CLI_NAME} claude-wake: claude is not on PATH"));
        return 1;
    };
    let Some(entries) = claude.list(true).await else {
        term::note(&format!(
            "{CLI_NAME} claude-wake: claude agents --json --all failed"
        ));
        return 1;
    };
    let same = |one: &&Entry, id: &str| one.id.as_deref() == Some(id) && one.background();
    let entry = entries
        .iter()
        .find(|one| one.session_id.as_deref() == Some(&reference) || same(one, &id));
    let records = read_records(env);
    let record = records.get(&id);
    let state = read_state(env, &id);
    let handle = record.and_then(|record| record.handle.as_deref());
    let other_session = entry
        .and_then(|entry| entry.session_id.as_deref())
        .is_some_and(|session| session != reference);
    let other_revive = revive.as_ref().is_some_and(|revive| {
        revive.harness != "claude-code"
            || state
                .as_ref()
                .is_some_and(|state| state.session_id() != revive.session)
    });
    if (record.is_none() && state.is_none())
        || other_session
        || !owned(env, &reference, state.as_ref(), handle, record.is_some())
        || other_revive
    {
        return decline("unresumable");
    }
    let moved = state
        .as_ref()
        .and_then(BgState::moved_to)
        .filter(|_| entry.is_none())
        .and_then(|to| entries.iter().find(|one| same(one, to)));
    let listed = entry.or(moved);
    if let Some(record) = record {
        let origin = listed.is_none().then_some(reference.as_str());
        if !arm_ticket(&record.file, ticket, env, origin, host) {
            term::note(&format!(
                "{CLI_NAME} claude-wake: could not update the wake ticket"
            ));
            return 1;
        }
    }
    if listed.is_some_and(|one| one.pid.is_some()) {
        return 0;
    }
    if let Some(short) = listed.and_then(|one| one.id.as_deref()) {
        let run = claude.act(&["respawn", short], None).await;
        if run.code == Some(0) {
            return 0;
        }
        term::note(&format!(
            "{CLI_NAME} claude-wake: claude respawn {short} failed: {}",
            run.reason()
        ));
        return 1;
    }
    let Some(state) = state.filter(|state| state.session_id() == reference) else {
        return decline("unresumable");
    };
    let directory = std::fs::metadata(state.cwd()).is_ok_and(|meta| meta.is_dir());
    if !directory || transcript_gone(env, &reference) {
        return decline("gone");
    }
    let mut args = vec!["--bg", "--resume", &reference];
    if let Some(name) = state.name().filter(|name| safe_name(name)) {
        args.extend(["--name", name]);
    }
    args.push(WAKE_PROMPT);
    if let Some(record) = record {
        args.extend(["--mcp-config", &record.file]);
    }
    let run = claude.act(&args, Some(state.cwd())).await;
    if run.code != Some(0) {
        term::note(&format!(
            "{CLI_NAME} claude-wake: claude --bg --resume failed: {}",
            run.reason()
        ));
        return 1;
    }
    let resumed = without(&state.0, &["removedAt", "movedTo"]);
    let to = backgrounded(&run.out).filter(|to| *to != id);
    let mut saved = resumed.clone();
    if let Some(to) = to {
        saved.set("movedTo", Json::str(to));
    }
    let written = write_state(env, &id, &saved);
    let followed = match (written, to) {
        (Err(error), _) => Err(error),
        (Ok(()), Some(to)) => follow_resume(env, &claude, to, &resumed, record).await,
        (Ok(()), None) => Ok(()),
    };
    match followed {
        Ok(()) => 0,
        Err(message) => {
            term::note(&message);
            crate::term::FAILED
        }
    }
}

/// `swarm claude-wake`, the broker's built-in `claude-bg` waker: the ref is the revive record (or the bare session id) of a worker the
/// policy stopped or removed. A stopped session is respawned; a removed one is resumed in the background in its own directory, with its
/// MCP config when `swarm claude --bg` started it. Either way the run's wake ticket goes into that config first, so the session's shim
/// takes the same endpoint back with it. It wakes only the endpoint's own session, and never one with neither a record nor a saved stop
pub fn wake(_args: &[String], env: &Env, host: &Host) -> Done {
    block_on(wake_run(env, host))
}
