//! `swarm agy` and `swarm grok`: holds the endpoint and runs one headless turn per batch of new messages, resuming one conversation.

use super::attribute::{Placement, attribute, attributed, validate_under};
use super::channel::{
    Channel, ChannelSetup, Latch, Watched, address_in, broker_connect, default_signals,
    launcher_claim, pushed, result_text, spawn_error, temp_dir,
};
use crate::args::js_string;
use crate::fleet::json::Json;
use crate::help;
use crate::open::{block_on, node_fs_error};
use crate::setup::hook_cmd::AGY_HOOK_SET;
use crate::setup::hooks_install::hooks_target;
use crate::spawn::argv::{messaging_allow, which_on_path};
use crate::spawn::hold::read_conversation;
use crate::spawn::signals::Listener;
use crate::spawn::text::{agy_note, hex, random_bytes, random_uuid};
use crate::{Call, Done, Fail, route, term, usage};
use scp_core::address::valid_handle;
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::CallError;
use scp_mcp::identity::{field, private_dir, relay_dir, safe_cwd};
use scp_mcp::ps::{Env, join};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::rc::Rc;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Harness {
    #[default]
    Agy,
    Grok,
}

struct Spec {
    bin: &'static str,
    refused: &'static [&'static str],
    prompt: &'static [&'static str],
    ids: &'static [&'static str],
}

const AGY: Spec = Spec {
    bin: "SCP_AGY_BIN",
    refused: &[
        "-i",
        "--prompt-interactive",
        "-c",
        "--continue",
        "--input-format",
        "--remote-control",
    ],
    prompt: &["-p", "--print", "--prompt"],
    ids: &["--conversation"],
};

const GROK: Spec = Spec {
    bin: "SCP_GROK_BIN",
    refused: &["-c", "--continue", "--fork-session"],
    prompt: &["-p", "--single", "--prompt-file", "--prompt-json"],
    ids: &["-s", "--session-id", "-r", "--resume"],
};

impl Harness {
    fn name(self) -> &'static str {
        match self {
            Harness::Agy => "agy",
            Harness::Grok => "grok",
        }
    }

    fn spec(self) -> &'static Spec {
        match self {
            Harness::Agy => &AGY,
            Harness::Grok => &GROK,
        }
    }
}

/// `swarm agy` or `swarm grok` as parsed
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ResumeLaunch {
    pub harness: Harness,
    pub name: Option<String>,
    pub root: bool,
    pub under: Option<String>,
    /// the first turn's arguments when they hold a prompt: the user's as given
    pub first: Option<Vec<String>>,
    /// the user's arguments without prompt and conversation flags, which every other turn starts from
    pub base: Vec<String>,
    /// the conversation flags of a turn that opens the conversation with a message
    pub opening: Vec<String>,
    /// the conversation to resume, when known before a turn ran
    pub id: Option<String>,
    /// flags every turn adds
    pub extra: Vec<String>,
    pub env: Env,
}

/// `extra` before a `--` in `args`, else after them
fn insert(args: &[String], extra: &[String]) -> Vec<String> {
    let end = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    let mut out = args[..end].to_vec();
    out.extend_from_slice(extra);
    out.extend_from_slice(&args[end..]);
    out
}

fn given<'a>(arg: &str, flags: impl IntoIterator<Item = &'a &'static str>) -> Option<&'static str> {
    flags
        .into_iter()
        .find(|flag| {
            arg == **flag
                || arg
                    .strip_prefix(**flag)
                    .is_some_and(|rest| rest.starts_with('='))
        })
        .copied()
}

fn refusal(harness: &str, flag: &str) -> Fail {
    usage(format!(
        "{CLI_NAME} {harness}: {flag} is not supported: nothing local starts a turn in an interactive {harness} session; run plain {harness} for that"
    ))
}

/// the launch of `swarm agy` or `swarm grok`: leading launcher flags, then the harness's own arguments
pub fn resume_launch(harness: Harness, args: &[String], env: &Env) -> Result<ResumeLaunch, Fail> {
    let word = harness.name();
    let mut parsed = ResumeLaunch {
        harness,
        ..ResumeLaunch::default()
    };
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        if arg == "--name" || arg == "--as" {
            i += 1;
            let Some(name) = args.get(i) else {
                return Err(usage(format!("{CLI_NAME} {word} {arg} takes a name")));
            };
            parsed.name = Some(name.clone());
        } else if arg.starts_with("--name=") || arg.starts_with("--as=") {
            parsed.name = Some(arg[arg.find('=').unwrap_or(0) + 1..].to_owned());
        } else if arg == "--under" || arg.starts_with("--under=") {
            let under = if arg == "--under" {
                i += 1;
                args.get(i).cloned()
            } else {
                Some(arg["--under=".len()..].to_owned())
            };
            parsed.under = Some(under.ok_or_else(|| usage("--under takes an address"))?);
        } else if arg == "--root" {
            parsed.root = true;
        } else {
            break;
        }
        i += 1;
    }
    if args.get(i).is_some_and(|arg| arg == "--") {
        i += 1;
    }
    let rest = &args[i.min(args.len())..];
    validate_under(parsed.under.as_deref(), parsed.root)?;
    parsed.name = parsed
        .name
        .map(|name| name.strip_prefix("me/").unwrap_or(&name).to_owned());
    if let Some(name) = &parsed.name
        && !valid_handle(name)
    {
        return Err(usage(format!(
            "{} is not a valid agent handle",
            js_string(name)
        )));
    }
    if harness == Harness::Agy && rest.first().is_some_and(|arg| arg == "remote-control") {
        return Err(refusal(word, "remote-control"));
    }
    let spec = harness.spec();
    let mut base: Vec<String> = Vec::new();
    let mut ids: Vec<(&str, String)> = Vec::new();
    let mut prompt = false;
    let mut j = 0;
    while let Some(arg) = rest.get(j) {
        if arg == "--" {
            base.extend_from_slice(&rest[j..]);
            break;
        }
        if let Some(flag) = given(arg, spec.refused) {
            return Err(refusal(word, flag));
        }
        let Some(valued) = given(arg, spec.prompt.iter().chain(spec.ids)) else {
            base.push(arg.clone());
            j += 1;
            continue;
        };
        let value = if arg == valued {
            j += 1;
            rest.get(j).cloned()
        } else {
            Some(arg[valued.len() + 1..].to_owned())
        };
        let Some(value) = value else {
            return Err(usage(format!("{CLI_NAME} {word} {valued} takes a value")));
        };
        if spec.prompt.contains(&valued) {
            prompt = true;
        } else {
            ids.retain(|(flag, _)| *flag != valued);
            ids.push((valued, value));
        }
        j += 1;
    }
    let id_of = |flag: &str| {
        ids.iter()
            .find(|(given, _)| *given == flag)
            .map(|(_, value)| value.clone())
    };
    let mut clean = env.clone();
    for key in ["SCP_PARENT", "SCP_HARNESS_PID"] {
        clean.remove(key);
    }
    clean.insert("SCP_HARNESS".into(), word.into());
    clean.insert("SCP_SESSION".into(), hex(&random_bytes::<16>()));
    if let Some(name) = &parsed.name {
        clean.insert("SCP_NAME".into(), name.clone());
    }
    parsed.env = clean;
    parsed.base = base;
    if harness == Harness::Agy {
        let id = id_of("--conversation");
        parsed.first = prompt.then(|| rest.to_vec());
        parsed.opening = id
            .iter()
            .flat_map(|id| ["--conversation".to_owned(), id.clone()])
            .collect();
        parsed.id = id;
        return Ok(parsed);
    }
    let resumed = id_of("-r").or_else(|| id_of("--resume"));
    let chosen = id_of("-s").or_else(|| id_of("--session-id"));
    let named = resumed.clone().or(chosen);
    let id = named.clone().unwrap_or_else(random_uuid);
    let extra = messaging_allow("grok", rest);
    if prompt {
        let mut added = Vec::new();
        if named.as_deref().is_none_or(str::is_empty) {
            added.extend(["-s".to_owned(), id.clone()]);
        }
        added.extend_from_slice(&extra);
        parsed.first = Some(insert(rest, &added));
    }
    let flag = if resumed.is_some() { "--resume" } else { "-s" };
    parsed.opening = vec![flag.to_owned(), id.clone()];
    parsed.id = Some(id);
    parsed.extra = extra;
    Ok(parsed)
}

/// a turn's arguments: one that opens the conversation with `text`, or resumes conversation `id` with it
pub fn turn_argv(launch: &ResumeLaunch, text: &str, id: Option<&str>) -> Vec<String> {
    let mut added = match id {
        None => launch.opening.clone(),
        Some(id) if launch.harness == Harness::Agy => {
            vec!["--conversation".to_owned(), id.to_owned()]
        }
        Some(id) => vec!["--resume".to_owned(), id.to_owned()],
    };
    added.extend(["-p".to_owned(), text.to_owned()]);
    added.extend_from_slice(&launch.extra);
    insert(&launch.base, &added)
}

/// the error that stops `swarm agy` when neither the project's nor the user's agy hooks hold the swarm set
pub fn agy_hooks_problem(env: &Env, cwd: &str) -> Option<String> {
    for scope in ["project", "user"] {
        let config = std::fs::read(hooks_target("agy", scope, env, cwd))
            .ok()
            .and_then(|bytes| Json::parse(String::from_utf8_lossy(&bytes).as_bytes()));
        let set = config.as_ref().and_then(|config| config.get(AGY_HOOK_SET));
        let Some(set) = set.filter(|set| crate::fleet::view::truthy(Some(set))) else {
            continue;
        };
        let started =
            matches!(set.get("SessionStart"), Some(Json::Arr(hooks)) if !hooks.is_empty());
        if set.get("enabled") != Some(&Json::Bool(false)) && started {
            return None;
        }
    }
    Some(format!(
        "{CLI_NAME} agy: agy has no {CLI_NAME} hooks, so it cannot report the conversation to resume; run {CLI_NAME} setup --write"
    ))
}

/// a signal as Node names it in an exit
fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGQUIT => "SIGQUIT".into(),
        libc::SIGILL => "SIGILL".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGFPE => "SIGFPE".into(),
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGPIPE => "SIGPIPE".into(),
        libc::SIGALRM => "SIGALRM".into(),
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGBUS => "SIGBUS".into(),
        libc::SIGUSR1 => "SIGUSR1".into(),
        libc::SIGUSR2 => "SIGUSR2".into(),
        other => other.to_string(),
    }
}

/// the conversation a run keeps going
struct Run {
    launch: ResumeLaunch,
    bin: String,
    file: Option<String>,
    env: RefCell<Env>,
    queue: RefCell<Vec<String>>,
    id: RefCell<Option<String>>,
    opened: Cell<bool>,
    ready: Cell<bool>,
    stopping: Cell<bool>,
    running: RefCell<Option<Rc<Watched>>>,
    latch: Latch,
}

impl Run {
    fn word(&self) -> &'static str {
        self.launch.harness.name()
    }

    fn turn(self: &Rc<Self>, argv: &[String]) {
        let mut command = std::process::Command::new(&self.bin);
        command
            .args(argv)
            .env_clear()
            .envs(&*self.env.borrow())
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        default_signals(&mut command);
        let child = match tokio::process::Command::from(command).spawn() {
            Ok(child) => child,
            Err(error) => {
                term::err(&format!(
                    "{CLI_NAME} {}: could not start {}: {}",
                    self.word(),
                    self.bin,
                    spawn_error(&self.bin, &error)
                ));
                self.latch.finish(1);
                return;
            }
        };
        let watched = Watched::start(child);
        *self.running.borrow_mut() = Some(watched.clone());
        let run = self.clone();
        tokio::task::spawn_local(async move {
            let status = watched.exited().await;
            run.running.borrow_mut().take();
            run.ended(status);
        });
    }

    fn ended(self: &Rc<Self>, status: std::process::ExitStatus) {
        if self.stopping.get() {
            self.latch.finish(0);
            return;
        }
        if status.code() != Some(0) {
            let how = status.code().map_or_else(
                || signal_name(status.signal().unwrap_or(0)),
                |code| code.to_string(),
            );
            term::err(&format!(
                "{CLI_NAME} {}: turn failed (exit {how}); undelivered messages stay unread in relay_inbox",
                self.word()
            ));
            self.latch.finish(status.code().unwrap_or(1));
            return;
        }
        self.opened.set(true);
        if self.launch.harness == Harness::Agy
            && let Some(id) = read_conversation(self.file.as_deref())
        {
            *self.id.borrow_mut() = Some(id);
        }
        if self.id.borrow().is_none() {
            term::err(&format!(
                "{CLI_NAME} agy: agy's {CLI_NAME} hooks did not report the conversation, so it cannot be resumed; run {CLI_NAME} setup --write"
            ));
            self.latch.finish(1);
            return;
        }
        self.next();
    }

    fn next(self: &Rc<Self>) {
        if !self.ready.get()
            || self.running.borrow().is_some()
            || self.stopping.get()
            || self.queue.borrow().is_empty()
        {
            return;
        }
        let text = self.queue.take().join("\n\n");
        let id = self.id.borrow().clone().filter(|_| self.opened.get());
        self.turn(&turn_argv(&self.launch, &text, id.as_deref()));
    }

    fn stop(&self, signal: i32) {
        self.stopping.set(true);
        let running = self.running.borrow().clone();
        match running {
            Some(child) => child.kill(signal),
            None => self.latch.finish(0),
        }
    }
}

/// what joins the relay and hands the conversation its first turn
async fn serve(run: &Rc<Run>, channel: &Channel, whoami: oneshot::Receiver<Value>) -> Done {
    let word = run.word();
    channel.initialize(&format!("scp-{word}")).await;
    channel.whoami().await;
    let result = tokio::select! {
        result = whoami => result.ok(),
        code = run.latch.done() => return Ok(code),
    };
    let Some(result) = result else {
        return Ok(run.latch.done().await);
    };
    let text = result_text(&result);
    let address = address_in(&text).map(str::to_owned);
    let failed = scp_mcp::tools::truthy(result.get("isError"));
    let Some(address) = address.filter(|_| !failed) else {
        let why = if text.is_empty() { "no answer" } else { &text };
        return Err(usage(format!(
            "{CLI_NAME} {word}: could not join the relay: {why}"
        )));
    };
    let handle = address.rsplit('/').next().unwrap_or(&address).to_owned();
    run.env.borrow_mut().insert("SCP_NAME".into(), handle);
    run.ready.set(true);
    match &run.launch.first {
        Some(first) => run.turn(first),
        None => {
            term::err(&format!(
                "{CLI_NAME} {word}: {address} waiting for messages"
            ));
            run.next();
        }
    }
    Ok(run.latch.done().await)
}

async fn launch(
    call: &Call<'_>,
    harness: Harness,
    args: &[String],
    env: &Env,
    cwd: &str,
    parsed: ResumeLaunch,
    bin: String,
) -> Done {
    let word = harness.name();
    let resume = matches!(
        parsed.opening.first().map(String::as_str),
        Some("--resume" | "--conversation")
    );
    let placement = Placement {
        name: parsed.name.as_deref(),
        root: parsed.root,
        under: parsed.under.as_deref(),
        resume,
        dir: None,
    };
    let warn = |line: &str| term::err(line);
    let attribution = attribute(word, placement, call.env, cwd, &warn).await?;
    let launch = match &attribution {
        Some(attribution) => resume_launch(harness, args, &attributed(env, Some(attribution)))?,
        None => parsed,
    };
    let mut run_env = launch.env.clone();
    let pid = std::process::id();
    run_env.insert("SCP_HARNESS_PID".into(), pid.to_string());
    let claim = launcher_claim(word, cwd, &run_env, i64::from(pid));
    let handle = field(&claim, "handle").to_owned();
    if !valid_handle(&handle) {
        return Err(usage(format!(
            "{} is not a valid agent handle",
            js_string(&handle)
        )));
    }
    let broker = relay_dir(&run_env);
    let dir = if harness == Harness::Agy {
        let parent = join(&[&broker, "agy"]);
        let fail = |syscall: &'static str, path: String| {
            move |error: std::io::Error| {
                Fail::Call(CallError::Io(node_fs_error(&error, syscall, &path)))
            }
        };
        private_dir(&parent).map_err(fail("mkdir", parent.clone()))?;
        let prefix = join(&[&parent, "resume-"]);
        let made = temp_dir(&prefix).map_err(fail("mkdtemp", format!("{prefix}XXXXXX")))?;
        Some(made.to_string_lossy().into_owned())
    } else {
        None
    };
    let file = dir.as_ref().map(|dir| join(&[dir, "conversation"]));
    if let Some(file) = &file {
        run_env.insert("SCP_AGY_CONVERSATION_FILE".into(), file.clone());
    }
    let id = launch.id.clone();
    let run = Rc::new(Run {
        launch,
        bin,
        file,
        env: RefCell::new(run_env.clone()),
        queue: RefCell::default(),
        id: RefCell::new(id),
        opened: Cell::new(false),
        ready: Cell::new(false),
        stopping: Cell::new(false),
        running: RefCell::new(None),
        latch: Latch::default(),
    });
    let (joined, whoami) = oneshot::channel::<Value>();
    let joined = RefCell::new(Some(joined));
    let pushing = run.clone();
    let channel = Channel::start(
        ChannelSetup {
            connect: broker_connect(&broker, call.env),
            claim,
            wake: if harness == Harness::Agy {
                "agy-resume"
            } else {
                "grok-resume"
            },
            env: run_env,
            log: Rc::new(term::err),
            on_message: Rc::new(move |message| {
                if message.get("id").and_then(Value::as_i64) == Some(2)
                    && let Some(joined) = joined.borrow_mut().take()
                {
                    let result = message.get("result").cloned().unwrap_or(Value::Null);
                    let _ = joined.send(result);
                }
                if let Some(content) = pushed(message) {
                    pushing.queue.borrow_mut().push(content.to_owned());
                    pushing.next();
                }
            }),
        },
        Rc::new(Cell::new(false)),
    );
    let mut listener = Listener::new(&[libc::SIGINT, libc::SIGTERM, libc::SIGHUP]);
    let stopping = run.clone();
    let signals = tokio::task::spawn_local(async move {
        loop {
            let signal = listener.recv().await;
            stopping.stop(signal);
        }
    });
    let result = serve(&run, &channel, whoami).await;
    signals.abort();
    let _ = signals.await;
    channel.end().await;
    let running = run.running.borrow().clone();
    if let Some(child) = running {
        child.kill(libc::SIGTERM);
    }
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir_all(dir);
    }
    result
}

fn command(call: &Call, harness: Harness, args: &[String]) -> Done {
    if matches!(args.first().map(String::as_str), Some("--help" | "-h")) {
        return help::show_text(match harness {
            Harness::Agy => help::AGY,
            Harness::Grok => help::GROK,
        });
    }
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let mut env = call.env.clone();
    route::caller_argv(&mut env);
    let cwd = safe_cwd();
    let word = harness.name();
    let parsed = resume_launch(harness, args, &env)?;
    let spec = harness.spec();
    let bin = env
        .get(spec.bin)
        .filter(|bin| !bin.is_empty())
        .cloned()
        .or_else(|| which_on_path(word, &env));
    let Some(bin) = bin else {
        return Err(usage(format!(
            "{word} is not on PATH: install it, or set ${} to its binary",
            spec.bin
        )));
    };
    if harness == Harness::Agy {
        if let Some(problem) = agy_hooks_problem(&env, &cwd) {
            return Err(usage(problem));
        }
        let mut words = vec!["agy".to_owned(), "-p".to_owned(), String::new()];
        words.extend_from_slice(&parsed.base);
        if let Some(note) = agy_note(&words, &env, "agy") {
            term::err(&note);
        }
    }
    block_on(launch(call, harness, args, &env, &cwd, parsed, bin))?
}

pub fn agy(call: &Call, args: &[String]) -> Done {
    command(call, Harness::Agy, args)
}

pub fn grok(call: &Call, args: &[String]) -> Done {
    command(call, Harness::Grok, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn agy_keeps_its_prompt_and_resumes_by_conversation() {
        let env = Env::new();
        let parsed = resume_launch(
            Harness::Agy,
            &w(&["--name", "lead", "--", "--model", "m", "-p", "hi"]),
            &env,
        )
        .unwrap();
        assert_eq!(parsed.first, Some(w(&["--model", "m", "-p", "hi"])));
        assert_eq!(parsed.base, w(&["--model", "m"]));
        assert!(parsed.opening.is_empty());
        assert_eq!(
            turn_argv(&parsed, "go", Some("c1")),
            w(&["--model", "m", "--conversation", "c1", "-p", "go"])
        );
        let given = resume_launch(Harness::Agy, &w(&["--conversation=c9"]), &env).unwrap();
        assert_eq!(given.opening, w(&["--conversation", "c9"]));
        assert_eq!(given.id.as_deref(), Some("c9"));
    }

    #[test]
    fn refused_flags_say_why() {
        let env = Env::new();
        for (harness, args) in [
            (Harness::Agy, w(&["-i"])),
            (Harness::Agy, w(&["remote-control"])),
            (Harness::Grok, w(&["--fork-session"])),
        ] {
            assert!(matches!(
                resume_launch(harness, &args, &env),
                Err(Fail::Usage(message)) if message.contains("is not supported")
            ));
        }
        assert_eq!(
            resume_launch(Harness::Grok, &w(&["-p"]), &env),
            Err(usage(format!("{CLI_NAME} grok -p takes a value")))
        );
    }

    #[test]
    fn grok_names_its_session_and_a_terminator_stays_last() {
        let env = Env::new();
        let parsed =
            resume_launch(Harness::Grok, &w(&["-s", "s1", "--x", "--", "tail"]), &env).unwrap();
        assert_eq!(parsed.opening, w(&["-s", "s1"]));
        assert_eq!(parsed.base, w(&["--x", "--", "tail"]));
        let turn = turn_argv(&parsed, "go", None);
        assert_eq!(&turn[..5], &w(&["--x", "-s", "s1", "-p", "go"])[..]);
        assert_eq!(&turn[turn.len() - 2..], &w(&["--", "tail"])[..]);
        let resumed = resume_launch(Harness::Grok, &w(&["--resume=r1"]), &env).unwrap();
        assert_eq!(resumed.opening, w(&["--resume", "r1"]));
        let fresh = resume_launch(Harness::Grok, &w(&["-p", "hi"]), &env).unwrap();
        let first = fresh.first.unwrap();
        assert_eq!(&first[..3], &w(&["-p", "hi", "-s"])[..]);
        assert_eq!(first[3], fresh.id.unwrap());
    }
}
