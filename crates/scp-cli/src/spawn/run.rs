//! `swarm spawn`: mint a process-bound grant, run or detach the harness, apply late steers, hold what can resume and hand its result back.

use super::argv::{
    Context, closed_stdin, codex_mount, codex_skips_git_check, handback_bytes, harness_argv,
    native_mount_bin, program_at, resume_argv, spawn_prompt, split_spawn, steer_argv,
};
use super::grant::{request_params, spawn_environment, spawn_params};
use super::harness::{self, Input, RunOptions, STDIN_WAIT_MS, harness_stdin, run_harness, tty};
use super::hold::{
    Held, HoldClaim, agy_conversation_dir, durable_ref, first_run, framed, hold_claim,
    hold_endpoint, hold_loop, idle_seconds, read_conversation, ref_problem, resumable, resume_base,
    resume_session, watch_signals, woke_by,
};
use super::muse::contributor_refusal;
use super::output::{
    HarnessRun, TRANSCRIPT_BYTES, claude_transcripts, codex_thread, harness_output, replies_output,
    stderr_output, transcript_replies,
};
use super::runner::{Channel, detach_spawn};
use super::settings::{SPAWN_IDLE_S, spawn_idle_default};
use super::text::{
    agy_note, hex, name_suffix, random_bytes, random_uuid, spawn_defaults, steer_prompt,
};
use crate::args::{Parsed, parse_flags, tables};
use crate::open::{self, PS_UNREAD, Walk, plan_walked, terminal_attached};
use crate::{Call, Done, Fail, route, term, usage};
use scp_core::protocol::{CLI_NAME, LIMITS};
use scp_mcp::client::{CallError, Client};
use scp_mcp::identity::{detect_harness, safe_cwd};
use scp_mcp::ps::{
    Env, SHELL_PS_TIMEOUT_MS, basename, join, process_key, ps_start, read_ps_table, resolve,
};
use scp_mcp::render::list_of;
use scp_mcp::spawn::SPAWN_RUNNER;
use scp_mcp::tools::get;
use serde_json::{Map, Value, json};
use std::rc::Rc;
use std::time::{SystemTime, UNIX_EPOCH};

/// how many times spawn resumes a codex exec worker that exited 0 for its parent's messages that came after its last step
const STEER_RESUMES: usize = 2;

/// Validate spawn flags and the harness command before starting a runner.
pub fn parse_spawn(args: &[String]) -> Result<(Parsed, Vec<String>), Fail> {
    let (flags, command) = split_spawn(args);
    let values = parse_flags(&flags, &tables().options).map_err(Fail::Usage)?;
    if values.has("help") {
        return Ok((values, command));
    }
    let allowed = tables().allowed("spawn").unwrap_or_default();
    for (key, _) in &values.values {
        if !allowed.contains(&key.as_str()) && !(key == "json" && values.has("via")) {
            return Err(usage(format!("{CLI_NAME} spawn does not take --{key}")));
        }
    }
    if values.on("bg") && values.on("fg") {
        return Err(usage("--bg and --fg: pick one"));
    }
    if command.is_empty() {
        return Err(usage(format!(
            "{CLI_NAME} spawn runs a harness command: {CLI_NAME} spawn [flags] [--] <harness cmd...>, e.g. {CLI_NAME} spawn codex exec \"...\""
        )));
    }
    if let Some(refusal) = contributor_refusal(&command) {
        return Err(usage(refusal));
    }
    if let Some(bytes) = values.text("handback-bytes") {
        handback_bytes(bytes)?;
    }
    Ok((values, command))
}

/// how long spawn holds a worker it can resume: --idle, else the settings' time when detached or --durable, else (in the foreground) not at all
pub fn spawn_idle(values: &Parsed, detached: bool, idle_after: f64) -> Result<f64, Fail> {
    if let Some(idle) = values.text("idle") {
        return idle_seconds(idle);
    }
    Ok(if detached || values.on("durable") {
        idle_after
    } else {
        0.0
    })
}

/// `--durable`: a command spawn can resume whose resume fits a hibernation ref, and an idle timeout that holds it at all
pub fn durable_check(
    values: &Parsed,
    command: &[String],
    cwd: &str,
    idle_after: f64,
    env: &Env,
) -> Result<(), Fail> {
    let idle = match values.text("idle") {
        Some(idle) => idle_seconds(idle)?,
        None => idle_after,
    };
    if values.on("durable") && values.on("no-durable") {
        return Err(usage("--durable and --no-durable conflict"));
    }
    if !values.on("durable") {
        return Ok(());
    }
    if idle == 0.0 {
        return Err(usage(
            "--durable holds the worker: it does not go with an idle time of 0 (--idle, $SCP_SPAWN_IDLE_AFTER_S, spawn.idle_after_s, $SCP_IDLE_AFTER_S or lifecycle.idle_after_s)",
        ));
    }
    let session = "0".repeat(64);
    let harness = resumable(command);
    let base = harness.and_then(|_| resume_base(command, &session));
    let (Some(harness), Some(base)) = (harness, base) else {
        return Err(usage(
            "--durable resumes a headless session: codex exec (not --ephemeral), agy -p or grok -p with its prompt in the command, or muse exec with a session log",
        ));
    };
    let parent = format!("me/{}", "x".repeat(63));
    let reference = durable_ref(
        harness,
        &session,
        &resolve(cwd, "."),
        &base,
        SPAWN_IDLE_S,
        &parent,
        env,
    );
    match ref_problem(&reference) {
        Some(problem) => Err(usage(format!(
            "--durable cannot keep this worker: {problem}"
        ))),
        None => Ok(()),
    }
}

/// an agent's shell: a harness's environment markers or a relay identity in the environment (spawn also needs stdin not a terminal)
pub fn agent_shell(env: &Env) -> bool {
    detect_harness(env).is_some()
        || ["SCP_NAME", "SCP_GRANT", "SCP_SESSION"]
            .iter()
            .any(|key| env.get(*key).is_some_and(|v| !v.is_empty()))
}

/// whether `--under` names an agent on a machine, which only the TypeScript CLI's hub lookup can place
fn linked_under(values: &Parsed) -> bool {
    let Some(rest) = values.text("under").and_then(|u| u.strip_prefix("me/")) else {
        return false;
    };
    let Some((machine, agent)) = rest.split_once('/') else {
        return false;
    };
    let bytes = machine.as_bytes();
    (1..=32).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && !agent.is_empty()
        && !agent.contains('/')
}

/// this CLI as the words a codex mount falls back on: what the router named, else the CLI beside this package, else this binary, whose `mcp` runs without Node
pub(crate) fn self_words(call: &Call, env: &Env) -> Vec<String> {
    scp_mcp::spawn::named_launcher(env)
        .or_else(|| (call.host.beside)(env))
        .unwrap_or_else(|| {
            let exe = std::env::current_exe().unwrap_or_default();
            vec![exe.to_string_lossy().into_owned()]
        })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// the words of `swarm spawn`, with the runner's variable read and removed from the process
fn take_runner(env: &Env) -> Option<String> {
    let runner = env.get(SPAWN_RUNNER).cloned();
    // SAFETY: no other thread runs yet: the runtime starts after this
    unsafe { std::env::remove_var(SPAWN_RUNNER) };
    runner
}

/// the verb
pub fn spawn(call: &Call, args: &[String]) -> Done {
    let (values, command) = parse_spawn(args)?;
    if values.has("help") {
        return Err(Fail::Decline("help".into()));
    }
    if linked_under(&values) {
        return Err(Fail::Decline("under".into()));
    }
    let bytes = values
        .text("handback-bytes")
        .map(handback_bytes)
        .transpose()?
        .map(|bytes| bytes as i64);
    let cwd = safe_cwd();
    let idle_after = spawn_idle_default(call.env);
    durable_check(&values, &command, &cwd, idle_after, call.env)?;
    let runner = take_runner(call.env);
    let mut env = call.env.clone();
    env.remove(SPAWN_RUNNER);
    let mut channel = if runner.is_some() {
        Channel::open()
    } else {
        Channel::none()
    };
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let detach = runner.is_none()
        && (values.on("bg") || (!values.on("fg") && (!tty(1) || (!tty(0) && agent_shell(&env)))));
    open::block_on(async {
        if detach {
            return detach_spawn(args, &cwd, &env).await;
        }
        let spawned = Spawn {
            self_words: self_words(call, &env),
            detached: runner.is_some(),
            env: &env,
            command: &command,
            cwd: &cwd,
            bytes,
            idle_after,
        };
        let done = spawned.run(values, runner.as_deref(), &mut channel).await;
        if let Err(fail) = &done {
            channel.failed(fail);
        }
        done
    })?
}

/// a worker's harness session, its transcript and its spawner's unread steers to it
struct Steers {
    session: Option<String>,
    steers: Vec<Value>,
    transcript: Option<String>,
    joined: bool,
}

/// the worker's run after its grant
struct Grant {
    env: Map<String, Value>,
    steer: Option<Value>,
    values: Parsed,
}

/// what a later run adds to its spawn_exit
#[derive(Default)]
struct Exit {
    code: i32,
    output: String,
    stderr: String,
    unapplied: Vec<String>,
    exits: Vec<i64>,
    not_started: bool,
    run: Option<u64>,
    reply_to: Option<String>,
}

/// the hold of a worker, with the words and environment of its resumed runs
struct HeldWorker {
    held: Held,
    base: Vec<String>,
    env: Env,
}

/// what stays the same across a spawn's steps
struct Spawn<'a> {
    self_words: Vec<String>,
    detached: bool,
    env: &'a Env,
    command: &'a [String],
    cwd: &'a str,
    bytes: Option<i64>,
    idle_after: f64,
}

/// one worker's identity once it has a grant
struct Worker<'a> {
    spawn: &'a Spawn<'a>,
    values: Parsed,
    walk: Walk,
    token: String,
    name: String,
}

impl Spawn<'_> {
    async fn connect(&self, values: &Parsed, walk: &Walk) -> Result<open::Opened, Fail> {
        let plan = plan_walked(
            "spawn",
            values,
            self.env,
            route::shell_pid(),
            terminal_attached(false),
            walk,
        )?;
        open::open("spawn", plan, self.env).await
    }

    fn local(&self, opened: open::Opened) -> Result<Client, Fail> {
        if opened.broker.is_null() {
            opened.client.close();
            return Err(usage(format!(
                "{CLI_NAME} spawn is the local broker's; it has no --cloud form"
            )));
        }
        Ok(opened.client)
    }

    async fn grant(&self, values: Parsed, walk: &Walk) -> Result<Grant, Fail> {
        let pid = std::process::id();
        let own = process_key(i64::from(pid), &ps_start);
        let bound = own.starts_with(&format!("pid:{pid}:")).then_some(own);
        let prompt = values
            .has("peek")
            .then(|| spawn_prompt(self.command))
            .flatten()
            .map(|prompt| {
                let units: Vec<u16> = prompt
                    .encode_utf16()
                    .take(LIMITS.body_bytes as usize)
                    .collect();
                String::from_utf16_lossy(&units)
            });
        let opened = self.connect(&values, walk).await?;
        if opened.bound.is_none() && walk.unread {
            opened.client.close();
            return Err(usage(format!(
                "{CLI_NAME} spawn: {PS_UNREAD}, or pass --as HANDLE or --human"
            )));
        }
        let client = self.local(opened)?;
        let values = spawn_defaults(&values, self.command, name_suffix);
        let params = match spawn_params(&values, bound.as_deref(), prompt.as_deref()) {
            Ok(params) => params,
            Err(fail) => {
                client.close();
                return Err(fail);
            }
        };
        let granted = client.request("grant", request_params(params)).await;
        client.close();
        let granted = granted?;
        Ok(Grant {
            env: get(&granted, "env")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            steer: get(&granted, "steer").cloned(),
            values,
        })
    }

    async fn run(
        &self,
        values: Parsed,
        runner: Option<&str>,
        channel: &mut Channel,
    ) -> Result<i32, Fail> {
        let walk = match runner {
            Some(text) => {
                let walk = serde_json::from_str(text).map_err(|error: serde_json::Error| {
                    Fail::Call(CallError::Io(error.to_string()))
                })?;
                Walk::from_json(&walk)
            }
            None => open::walk(
                self.env,
                route::shell_pid(),
                read_ps_table(SHELL_PS_TIMEOUT_MS).map(Rc::new),
            ),
        };
        let Grant { env, steer, values } = self.grant(values, &walk).await?;
        let name = values.text("name").unwrap_or_default().to_owned();
        let token = env
            .get("SCP_GRANT")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let mut parent = self.env.clone();
        route::caller_argv(&mut parent);
        let mut run_env = spawn_environment(&parent, &env, values.text("labels"));
        if let Some(note) = agy_note(self.command, self.env, "spawn") {
            term::note(&note);
        }
        let worker = Worker {
            spawn: self,
            values,
            walk,
            token,
            name,
        };
        let idle_s = spawn_idle(&worker.values, self.detached, self.idle_after)?;
        let harness = (idle_s > 0.0).then(|| resumable(self.command)).flatten();
        let mut signals = harness.map(|_| watch_signals());
        let agy_dir = if harness == Some("agy") {
            let dir = agy_conversation_dir(&run_env)
                .map_err(|error| Fail::Call(CallError::Io(error.to_string())))?;
            run_env.insert(
                "SCP_AGY_CONVERSATION_FILE".into(),
                join(&[&dir, "conversation"]),
            );
            Some(dir)
        } else {
            None
        };
        let done = worker
            .supervise(harness, idle_s, run_env, steer, &mut signals, channel)
            .await;
        drop(signals);
        if let Some(dir) = agy_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        done
    }
}

impl Worker<'_> {
    /// the harness run of `argv`, its words as `harness_argv` makes them; `stdin` overrides what `argv` asks for
    async fn launch(
        &self,
        argv: &[String],
        mut options: RunOptions<'_>,
        given_stdin: bool,
        env: &Env,
    ) -> Result<HarnessRun, Fail> {
        let codex = argv
            .get(program_at(argv))
            .is_some_and(|program| basename(program) == "codex");
        let bin = codex.then(|| native_mount_bin(env)).flatten();
        let cwd = safe_cwd();
        let context = Context {
            self_words: &self.spawn.self_words,
            mount: &codex_mount,
            bin: bin.as_deref(),
            cwd: &cwd,
            probe: &codex_skips_git_check,
        };
        let words = harness_argv(argv, env, &context);
        if !given_stdin && closed_stdin(argv) {
            options.stdin = Input::Ignore;
        }
        options.group = self.spawn.detached;
        run_harness(&words, env, options).await
    }

    /// a worker's harness session, its transcript and its spawner's unread steers to it, with `take` taken; None from a broker without spawn_steers or on a failure
    async fn steers(&self, take: bool) -> Option<Steers> {
        let opened = self.spawn.connect(&self.values, &self.walk).await.ok()?;
        let client = self.spawn.local(opened).ok()?;
        let params = json!({ "grant": self.token, "take": take });
        let reply = client.request("spawn_steers", params).await;
        client.close();
        let reply = reply.ok()?;
        let text = |key: &str| get(&reply, key).and_then(Value::as_str).map(str::to_owned);
        Some(Steers {
            session: text("session"),
            steers: list_of(get(&reply, "steers")).to_vec(),
            transcript: text("transcript"),
            joined: get(&reply, "joined") == Some(&Value::Bool(true)),
        })
    }

    /// Report exit, unapplied steers and output using the original walk, even after the caller's shell exits.
    async fn exit(&self, exit: Exit) {
        if let Err(error) = self.try_exit(exit).await {
            let message = match &error {
                Fail::Usage(message) => message.as_str(),
                Fail::Call(error) => error.message(),
                Fail::Decline(reason) => reason.as_str(),
            };
            harness::note(&format!(
                "{CLI_NAME} spawn: could not mark {} as exited: {message}",
                self.name
            ));
        }
    }

    async fn try_exit(&self, exit: Exit) -> Result<(), Fail> {
        let opened = self.spawn.connect(&self.values, &self.walk).await?;
        let client = self.spawn.local(opened)?;
        let mut params = Map::new();
        if let Some(run) = exit.run {
            params.insert("run".into(), Value::from(run));
        }
        if let Some(reply_to) = exit.reply_to {
            params.insert("reply_to".into(), Value::from(reply_to));
        }
        params.insert("grant".into(), Value::from(self.token.as_str()));
        params.insert("code".into(), Value::from(exit.code.min(255)));
        if !exit.output.is_empty() {
            params.insert("output".into(), Value::from(exit.output));
        }
        if !exit.stderr.is_empty() {
            params.insert("stderr".into(), Value::from(exit.stderr));
        }
        if !exit.unapplied.is_empty() {
            params.insert("unapplied".into(), Value::from(exit.unapplied));
        }
        if !exit.exits.is_empty() {
            params.insert("exits".into(), Value::from(exit.exits));
        }
        if exit.not_started {
            params.insert("started".into(), Value::Bool(false));
        }
        let reply = client.request("spawn_exit", Value::Object(params)).await;
        client.close();
        reply?;
        Ok(())
    }

    /// holds a worker's endpoint for resumed runs of its harness session, durably unless --no-durable
    async fn hold(
        &self,
        harness: &str,
        session: &str,
        env: &Env,
        idle_s: f64,
    ) -> Option<HeldWorker> {
        let spawn = self.spawn;
        let base = resume_base(spawn.command, session)?;
        let cwd = resolve(spawn.cwd, ".");
        let durable = !self.values.on("no-durable");
        let keep = |endpoint: &Value| -> Option<String> {
            let parent = get(endpoint, "parent")
                .and_then(Value::as_str)
                .filter(|parent| !parent.is_empty());
            let parent = parent.filter(|_| durable)?;
            let reference = durable_ref(harness, session, &cwd, &base, idle_s, parent, env);
            match ref_problem(&reference) {
                Some(problem) => {
                    harness::note(&format!(
                        "{CLI_NAME} spawn: {} is held, not durably: {problem}",
                        self.name
                    ));
                    None
                }
                None => Some(reference),
            }
        };
        let key = hex(&random_bytes::<16>());
        let pid = std::process::id();
        let process = process_key(i64::from(pid), &ps_start);
        let claim = hold_claim(&HoldClaim {
            name: &self.name,
            harness,
            cwd: &cwd,
            session: &key,
            lineage: &self.walk.keys,
            grant: &self.token,
            process: &process,
            env,
        });
        let mut log = |line: &str| harness::note(line);
        let held = hold_endpoint(spawn.env, claim, Some(&keep), &mut log).await?;
        let mut env = env.clone();
        env.insert("SCP_SESSION".into(), key);
        env.insert("SCP_HARNESS_PID".into(), pid.to_string());
        Some(HeldWorker { held, base, env })
    }

    async fn supervise(
        &self,
        harness: Option<&'static str>,
        idle_s: f64,
        env: Env,
        steer: Option<Value>,
        signals: &mut Option<super::signals::Listener>,
        channel: &mut Channel,
    ) -> Result<i32, Fail> {
        let spawn = self.spawn;
        let command = spawn.command;
        let (opening, session) = match harness {
            Some(_) => first_run(command, random_uuid),
            None => (command.to_vec(), None),
        };
        let first = steer_argv(&opening, steer.as_ref());
        let stdin = if closed_stdin(&first) {
            let wait = agent_shell(spawn.env).then_some(STDIN_WAIT_MS);
            Some(harness_stdin(wait).await)
        } else {
            None
        };
        let codex = harness == Some("codex");
        let name = self.name.clone();
        let mut started = |failed: Option<&super::harness::Failed>| match failed {
            Some(failed) => channel.not_started(&failed.message, failed.code),
            None => channel.started(&name),
        };
        let given_stdin = stdin.is_some();
        let options = RunOptions {
            capture: codex.then_some(true),
            capture_err: codex.then_some(true),
            stdin: stdin.unwrap_or_default(),
            started: spawn.detached.then_some(&mut started as _),
            ..RunOptions::default()
        };
        let mut run = self.launch(&first, options, given_stdin, &env).await?;
        if !run.started {
            let exit = Exit {
                code: run.code,
                not_started: true,
                ..Exit::default()
            };
            self.exit(exit).await;
            return Ok(run.code);
        }
        let mut exits = vec![now_ms()];
        let mut unapplied = Vec::new();
        for _ in 0..STEER_RESUMES {
            if run.code != 0 || resume_argv(command, "", "").is_none() {
                break;
            }
            let Some(pending) = self.steers(true).await else {
                break;
            };
            let Some(session) = pending.session.filter(|s| !s.is_empty()) else {
                break;
            };
            if pending.steers.is_empty() {
                break;
            }
            let Some(argv) = resume_argv(command, &session, &steer_prompt(&pending.steers)) else {
                break;
            };
            let resumed = self
                .launch(&argv, RunOptions::default(), false, &env)
                .await?;
            exits.push(now_ms());
            if resumed.code != 0 {
                unapplied = pending
                    .steers
                    .iter()
                    .filter_map(|m| get(m, "id").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect();
                break;
            }
            run = resumed;
        }
        let worker = self.steers(false).await;
        let replies = match &worker {
            Some(Steers {
                session: Some(session),
                transcript: Some(transcript),
                ..
            }) if !session.is_empty() && !transcript.is_empty() => {
                let root = claude_transcripts(spawn.env);
                let found = transcript_replies(transcript, session, &root, TRANSCRIPT_BYTES);
                replies_output(&found, spawn.bytes)
            }
            _ => String::new(),
        };
        let caught = signals.as_ref().is_some_and(|signals| signals.caught());
        let joined = worker.as_ref().is_some_and(|worker| worker.joined);
        let resumed_session = match harness.filter(|_| joined && !caught) {
            Some("agy") => resume_session(
                command,
                read_conversation(env.get("SCP_AGY_CONVERSATION_FILE").map(String::as_str))
                    .as_deref(),
            ),
            Some("grok" | "muse") => resume_session(command, session.as_deref()),
            Some(_) => {
                let thread = worker
                    .as_ref()
                    .and_then(|worker| worker.session.clone())
                    .or_else(|| codex_thread(&run));
                resume_session(command, thread.as_deref())
            }
            None => None,
        };
        let held = match (harness, resumed_session) {
            (Some(harness), Some(session)) => self.hold(harness, &session, &env, idle_s).await,
            _ => None,
        };
        let output = if replies.is_empty() {
            harness_output(&run, spawn.bytes)
        } else {
            replies
        };
        self.exit(Exit {
            code: run.code,
            output,
            stderr: stderr_output(&run, None),
            unapplied,
            exits,
            ..Exit::default()
        })
        .await;
        if let (Some(held), Some(signals)) = (held, signals.as_mut()) {
            self.hold_runs(held, idle_s, signals).await?;
        }
        Ok(run.code)
    }

    /// the resumed runs of a held worker, one per batch of messages, each handed back as its own run
    async fn hold_runs(
        &self,
        held: HeldWorker,
        idle_s: f64,
        signals: &mut super::signals::Listener,
    ) -> Result<(), Fail> {
        let HeldWorker { held, base, env } = held;
        let run_number = std::cell::Cell::new(1);
        let failed = std::cell::RefCell::new(None);
        hold_loop(
            &held,
            idle_s,
            signals,
            |messages: Vec<Value>| {
                let (base, env, run_number, failed) = (&base, &env, &run_number, &failed);
                async move {
                    let mut argv = base.clone();
                    argv.push(framed(&messages));
                    let options = RunOptions {
                        stdin: Input::Ignore,
                        ..RunOptions::default()
                    };
                    let resumed = match self.launch(&argv, options, true, env).await {
                        Ok(resumed) => resumed,
                        Err(fail) => {
                            failed.replace(Some(fail));
                            return;
                        }
                    };
                    run_number.set(run_number.get() + 1);
                    self.exit(Exit {
                        code: resumed.code,
                        output: harness_output(&resumed, self.spawn.bytes),
                        stderr: stderr_output(&resumed, None),
                        run: Some(run_number.get()),
                        reply_to: woke_by(&messages),
                        ..Exit::default()
                    })
                    .await;
                }
            },
            || {},
        )
        .await;
        match failed.into_inner() {
            Some(fail) => Err(fail),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn under(value: &str) -> Parsed {
        Parsed {
            values: vec![("under".into(), crate::args::Val::Text(value.into()))],
            positionals: Vec::new(),
        }
    }

    #[test]
    fn only_an_agent_on_a_machine_goes_to_the_typescript_cli() {
        for linked in [
            "me/box/lead",
            "me/b0x-1/a.b",
            &format!("me/{}/x", "m".repeat(32)),
        ] {
            assert!(linked_under(&under(linked)), "{linked}");
        }
        for local in [
            "lead",
            "me/lead",
            "me/Box/lead",
            "me/-box/lead",
            "me/box/",
            "me/box/a/b",
            &format!("me/{}/x", "m".repeat(33)),
            "you/box/lead",
        ] {
            assert!(!linked_under(&under(local)), "{local}");
        }
        assert!(!linked_under(&Parsed::default()));
    }

    #[test]
    fn an_agent_shell_is_a_harness_or_a_relay_identity() {
        let env = |pairs: &[(&str, &str)]| -> Env {
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect()
        };
        assert!(!agent_shell(&env(&[])));
        assert!(!agent_shell(&env(&[("SCP_NAME", "")])));
        assert!(agent_shell(&env(&[("SCP_GRANT", "krt_x")])));
        assert!(agent_shell(&env(&[("SCP_SESSION", "s")])));
    }
}
