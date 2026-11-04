//! Holding a worker's endpoint for resumed runs of its harness session: what spawn itself runs, and what `swarm spawn-wake` shares with it.

use super::argv::{messaging_allow, program_at, resume_argv, which_on_path};
use super::muse::{muse_first_run, muse_resume_base};
use super::settings::parse_seconds;
use super::signals::Listener;
use super::text::random_uuid;
use crate::args::js_string;
use crate::{Fail, usage};
use scp_broker::scrub::find_secret;
use scp_core::protocol::{CLI_NAME, LIMITS, SPAWN_PROVIDER};
use scp_mcp::Claim;
use scp_mcp::client::{CallError, Client, connect_broker, relay_dir};
use scp_mcp::identity::{labels_for, private_dir, short_hostname};
use scp_mcp::ps::{Env, basename, join, resolve};
use scp_mcp::render::{PREAMBLE, js_space, list_of, wrap_message};
use scp_mcp::tools::{get, js_num};
use serde_json::{Map, Value, json};
use std::time::Instant;

const STOPS: [i32; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

/// `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`: a harness session, and an agy conversation
pub fn session_shaped(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// `--idle <seconds|duration|Infinity>`: how long a held worker waits for a message; 0 holds nothing
pub fn idle_seconds(value: &str) -> Result<f64, Fail> {
    let trimmed = value.trim_matches(js_space);
    if trimmed == "Infinity" {
        return Ok(f64::INFINITY);
    }
    let (whole, fraction) = trimmed.split_once('.').unwrap_or((trimmed, ""));
    if !whole.is_empty() && whole.bytes().all(|b| b == b'0') && fraction.bytes().all(|b| b == b'0')
    {
        return Ok(0.0);
    }
    parse_seconds(value, "--idle").map_err(|message| usage(format!("{message}, or Infinity")))
}

/// the harness `command` runs, when spawn can resume its session
pub fn resumable(command: &[String]) -> Option<&'static str> {
    let name = basename(command.get(program_at(command))?);
    ["codex", "agy", "grok", "muse"]
        .into_iter()
        .find(|harness| *harness == name)
}

struct ResumeSpec {
    refused: &'static [&'static str],
    prompt: &'static [&'static str],
    ids: &'static [&'static str],
}

const AGY: ResumeSpec = ResumeSpec {
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

const GROK: ResumeSpec = ResumeSpec {
    refused: &["-c", "--continue", "--fork-session"],
    prompt: &["-p", "--single", "--prompt-file", "--prompt-json"],
    ids: &["-s", "--session-id", "-r", "--resume"],
};

/// a headless agy or grok command as `swarm agy` and `swarm grok` read its arguments
#[derive(Debug, Clone, PartialEq)]
pub struct ResumeWords {
    /// the first turn's arguments when they hold a prompt
    pub first: Option<Vec<String>>,
    /// the arguments without prompt and conversation flags
    pub base: Vec<String>,
    /// the conversation to resume, when known before a turn ran
    pub id: Option<String>,
}

fn given(word: &str, flag: &str) -> bool {
    word == flag
        || word
            .strip_prefix(flag)
            .is_some_and(|rest| rest.starts_with('='))
}

/// `extra` before a `--` in `args`, else after them
fn insert(args: &[String], extra: Vec<String>) -> Vec<String> {
    let end = args.iter().position(|w| w == "--").unwrap_or(args.len());
    let mut out = args[..end].to_vec();
    out.extend(extra);
    out.extend_from_slice(&args[end..]);
    out
}

/// `resumeLaunch`'s words for `rest`, a harness's own arguments; None for what it refuses
pub fn resume_words(
    harness: &str,
    rest: &[String],
    uuid: impl FnOnce() -> String,
) -> Option<ResumeWords> {
    let spec = if harness == "agy" { &AGY } else { &GROK };
    if harness == "agy" && rest.first().is_some_and(|w| w == "remote-control") {
        return None;
    }
    let mut base = Vec::new();
    let mut ids: Vec<(&str, String)> = Vec::new();
    let mut prompt = false;
    let mut j = 0;
    while j < rest.len() {
        let arg = &rest[j];
        if arg == "--" {
            base.extend_from_slice(&rest[j..]);
            break;
        }
        if spec.refused.iter().any(|flag| given(arg, flag)) {
            return None;
        }
        let flags = spec.prompt.iter().chain(spec.ids.iter());
        let Some(valued) = flags.copied().find(|flag| given(arg, flag)) else {
            base.push(arg.clone());
            j += 1;
            continue;
        };
        let value = if arg == valued {
            j += 1;
            rest.get(j)?.clone()
        } else {
            arg[valued.len() + 1..].to_owned()
        };
        if spec.prompt.contains(&valued) {
            prompt = true;
        } else {
            ids.retain(|(flag, _)| *flag != valued);
            ids.push((valued, value));
        }
        j += 1;
    }
    let id_of = |flag: &str| ids.iter().find(|(f, _)| *f == flag).map(|(_, v)| v.clone());
    if harness == "agy" {
        return Some(ResumeWords {
            first: prompt.then(|| rest.to_vec()),
            base,
            id: id_of("--conversation"),
        });
    }
    let chosen = id_of("-r")
        .or_else(|| id_of("--resume"))
        .or_else(|| id_of("-s"))
        .or_else(|| id_of("--session-id"));
    let named = chosen.as_ref().is_some_and(|id| !id.is_empty());
    let id = chosen.unwrap_or_else(uuid);
    let first = prompt.then(|| {
        let mut extra = Vec::new();
        if !named {
            extra.extend(["-s".to_owned(), id.clone()]);
        }
        extra.extend(messaging_allow("grok", rest));
        insert(rest, extra)
    });
    Some(ResumeWords {
        first,
        base,
        id: Some(id),
    })
}

/// a headless agy or grok command (a prompt flag, no `--`) as its launch reads it, with the words before its arguments
fn headless(
    harness: &str,
    command: &[String],
    uuid: impl FnOnce() -> String,
) -> Option<(Vec<String>, ResumeWords)> {
    let at = program_at(command);
    let words = resume_words(harness, command.get(at + 1..).unwrap_or(&[]), uuid)?;
    (words.first.is_some() && !words.base.iter().any(|w| w == "--"))
        .then(|| (command[..at + 1].to_vec(), words))
}

/// the first run of a command spawn may resume, and the session it names: a grok or muse exec without a session of its own starts one
pub fn first_run(
    command: &[String],
    uuid: impl FnOnce() -> String,
) -> (Vec<String>, Option<String>) {
    match resumable(command) {
        Some("muse") => match muse_first_run(command, uuid) {
            Some((command, session)) => (command, Some(session)),
            None => (command.to_vec(), None),
        },
        Some("grok") => match headless("grok", command, uuid) {
            Some((mut prefix, words)) => match (words.first, words.id) {
                (Some(first), Some(id)) if !id.is_empty() => {
                    prefix.extend(first);
                    (prefix, Some(id))
                }
                _ => (command.to_vec(), None),
            },
            None => (command.to_vec(), None),
        },
        _ => (command.to_vec(), None),
    }
}

/// the session a resumed run of `command` names: codex's from its hooks or its output, agy's from the conversation file, grok's and muse's the one it was given
pub fn resume_session(command: &[String], session: Option<&str>) -> Option<String> {
    let session = match (session, resumable(command)) {
        (None, Some("agy")) => headless("agy", command, random_uuid).and_then(|(_, w)| w.id),
        (session, _) => session.map(str::to_owned),
    };
    session.filter(|s| session_shaped(s))
}

/// a resumed run's words before its prompt, which goes last; None for any other command, an ephemeral codex, a muse without a session log, or one that is not headless
pub fn resume_base(command: &[String], session: &str) -> Option<Vec<String>> {
    if !session_shaped(session) {
        return None;
    }
    let harness = resumable(command)?;
    if harness == "codex" {
        let mut argv = resume_argv(command, session, "")?;
        argv.pop();
        return Some(argv);
    }
    if harness == "muse" {
        return muse_resume_base(command, session);
    }
    let (mut out, words) = headless(harness, command, random_uuid)?;
    out.extend(words.base);
    let flag = if harness == "agy" {
        "--conversation"
    } else {
        "--resume"
    };
    out.extend([flag.to_owned(), session.to_owned(), "-p".to_owned()]);
    Some(out)
}

/// messages as one resume prompt: each framed as a channel push, joined by a blank line
pub fn framed(messages: &[Value]) -> String {
    messages
        .iter()
        .map(|message| format!("{PREAMBLE}\n\n{}", wrap_message(message)))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// a durable spawn's hibernation ref, as `JSON.stringify` writes it for `parseHoldRef`, its program found on PATH so the broker's waker runs the same binary
pub fn durable_ref(
    harness: &str,
    session: &str,
    cwd: &str,
    base: &[String],
    idle_s: f64,
    parent: &str,
    env: &Env,
) -> String {
    let at = program_at(base);
    let word = &base[at];
    let program = if word.contains('/') {
        resolve(cwd, word)
    } else {
        which_on_path(word, env).unwrap_or_else(|| word.clone())
    };
    let argv: Vec<String> = base
        .iter()
        .enumerate()
        .map(|(i, word)| js_string(if i == at { &program } else { word }))
        .collect();
    let idle = if idle_s.is_finite() {
        js_num(idle_s)
    } else {
        "null".to_owned()
    };
    format!(
        "{{\"harness\":{},\"session\":{},\"cwd\":{},\"argv\":[{}],\"idle_s\":{idle},\"parent\":{}}}",
        js_string(harness),
        js_string(session),
        js_string(cwd),
        argv.join(","),
        js_string(parent)
    )
}

/// why a durable spawn cannot keep `reference`, else None
pub fn ref_problem(reference: &str) -> Option<String> {
    let chars = reference.encode_utf16().count();
    if chars > LIMITS.wake_ref_chars as usize {
        return Some(format!(
            "its resume command and directory take {chars} characters, over {}",
            LIMITS.wake_ref_chars
        ));
    }
    if reference.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Some("its resume command holds control characters".to_owned());
    }
    find_secret(reference).map(|_| "its resume command looks like it carries a credential".into())
}

/// the claim with which a spawn holds its worker's endpoint once the harness exited: its grant, the spawner's lineage, `process` its own
pub struct HoldClaim<'a> {
    pub name: &'a str,
    pub harness: &'a str,
    pub cwd: &'a str,
    pub session: &'a str,
    pub lineage: &'a [String],
    pub grant: &'a str,
    pub process: &'a str,
    pub env: &'a Env,
}

pub fn hold_claim(options: &HoldClaim) -> Claim {
    let mut claim = Claim::new();
    claim.insert("handle".into(), Value::from(options.name));
    claim.insert("harness".into(), Value::from(options.harness));
    claim.insert("cwd".into(), Value::from(options.cwd));
    claim.insert(
        "session".into(),
        Value::from(format!("env:{}", options.session)),
    );
    claim.insert("process".into(), Value::from(options.process));
    claim.insert("exact".into(), Value::Bool(true));
    claim.insert(
        "labels".into(),
        Value::Object(labels_for(options.env, &short_hostname)),
    );
    if !options.lineage.is_empty() {
        claim.insert("lineage".into(), Value::from(options.lineage.to_vec()));
    }
    claim.insert("grant".into(), Value::from(options.grant));
    claim
}

/// the durable ref a hold keeps for its endpoint, if any
pub type Durable<'a> = &'a dyn Fn(&Value) -> Option<String>;

/// a held endpoint
pub struct Held {
    pub client: Client,
    pub endpoint: Value,
    /// the durable ref the broker took, when it did
    pub durable: Option<String>,
    /// the session's resume token, before any harness run claims the session and replaces it
    pub token: Option<String>,
}

async fn claim_and_wake(
    client: &Client,
    claim: Claim,
    handle: &str,
    durable: Option<Durable<'_>>,
    log: &mut dyn FnMut(&str),
) -> Result<(Value, Option<String>, Option<String>), CallError> {
    let mut hello = Map::new();
    hello.insert("claim".into(), Value::Object(claim));
    let reply = client.hello(hello).await?;
    let endpoint = get(&reply, "endpoint").cloned().unwrap_or(Value::Null);
    let token = get(&reply, "token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_owned);
    let mut kept = durable.and_then(|durable| durable(&endpoint));
    let mut wake = json!({ "via": "spawn-resume" });
    if let Some(kept) = &kept {
        wake["ref"] = Value::from(kept.as_str());
    }
    if let Err(error) = client.request("wake", wake).await {
        let retry = kept.is_some()
            && matches!(&error, CallError::Relay { code, .. } if code != "unauthorized");
        if !retry {
            return Err(error);
        }
        log(&format!(
            "{CLI_NAME} spawn: {handle} is held, not durably: {}",
            error.message()
        ));
        kept = None;
        client
            .request("wake", json!({ "via": "spawn-resume" }))
            .await?;
    }
    Ok((endpoint, kept, token))
}

/// claims the worker's endpoint and holds it with wake `spawn-resume`, durably with `durable` when the broker can (else held plainly, said
/// in a line to `log`); None, with a line to `log`, when the claim or the wake fails
pub async fn hold_endpoint(
    env: &Env,
    claim: Claim,
    durable: Option<Durable<'_>>,
    log: &mut dyn FnMut(&str),
) -> Option<Held> {
    let handle = get(&Value::Object(claim.clone()), "handle")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let client = match connect_broker(&relay_dir(env), None).await {
        Ok(client) => client,
        Err(error) => {
            log(&cannot_hold(&handle, &error));
            return None;
        }
    };
    match claim_and_wake(&client, claim, &handle, durable, log).await {
        Ok((endpoint, durable, token)) => Some(Held {
            client,
            endpoint,
            durable,
            token,
        }),
        Err(error) => {
            client.close();
            log(&cannot_hold(&handle, &error));
            None
        }
    }
}

fn cannot_hold(handle: &str, error: &CallError) -> String {
    format!(
        "{CLI_NAME} spawn: {handle} cannot be held for a resume: {}",
        error.message()
    )
}

/// SIGINT, SIGTERM and SIGHUP caught from now on, instead of ending the process, until the listener drops
pub fn watch_signals() -> Listener {
    Listener::new(&STOPS)
}

/// why a hold let go
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldEnd {
    Idle,
    Ended,
    Signal,
}

async fn let_go(held: &Held, why: HoldEnd) -> HoldEnd {
    if let Some(reference) = &held.durable {
        let params = json!({ "wake": SPAWN_PROVIDER, "ref": reference });
        let _ = held.client.request("hibernate", params).await;
    }
    held.client.close();
    why
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// holds a worker's endpoint until it was idle for `idle_s` seconds, a signal came or its connection closed (`spawn_end`, or the broker going
/// away). Each batch of messages, taken and marked read once nothing else runs, starts one resumed run (`resume`); the idle time starts again
/// after it. `before_go` runs as the hold lets go; a durable hold then hibernates the endpoint by the built-in waker, waiting for the answer
pub async fn hold_loop<R, F>(
    held: &Held,
    idle_s: f64,
    signals: &mut Listener,
    mut resume: R,
    before_go: impl FnOnce(),
) -> HoldEnd
where
    R: FnMut(Vec<Value>) -> F,
    F: Future<Output = ()>,
{
    let client = &held.client;
    let idle_ms = idle_s * 1000.0;
    let start = Instant::now();
    let mut deadline = idle_ms;
    loop {
        if signals.caught() {
            before_go();
            return let_go(held, HoldEnd::Signal).await;
        }
        let left = deadline - elapsed_ms(start);
        let wait_s = if left > 0.0 {
            (left / 1000.0).min(LIMITS.wait_max_s as f64)
        } else {
            0.0
        };
        let params = json!({ "wait_s": wait_s, "offer": true });
        let page = tokio::select! {
            page = client.request("inbox", params) => page,
            () = signals.next() => {
                before_go();
                return let_go(held, HoldEnd::Signal).await;
            }
        };
        let Ok(page) = page else {
            client.close();
            return HoldEnd::Ended;
        };
        let messages = list_of(get(&page, "messages"));
        if !messages.is_empty() {
            let seqs: Vec<Value> = messages
                .iter()
                .filter_map(|message| get(message, "seq").cloned())
                .collect();
            let mut injected = json!({ "seqs": seqs, "read": seqs });
            if let Some(hold) = get(&page, "hold") {
                injected["hold"] = hold.clone();
            }
            let status = json!({ "state": "working", "note": "" });
            let told = match client.request("injected", injected).await {
                Ok(_) => client.request("status", status).await,
                Err(error) => Err(error),
            };
            if told.is_err() {
                client.close();
                return HoldEnd::Ended;
            }
            resume(messages.to_vec()).await;
            deadline = elapsed_ms(start) + idle_ms;
            continue;
        }
        if left <= 0.0 {
            before_go();
            return let_go(held, HoldEnd::Idle).await;
        }
    }
}

/// the message that woke a run and came from the worker's parent, the newest of them
pub fn woke_by(messages: &[Value]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|m| get(m, "relation").and_then(Value::as_str) == Some("parent"))
        .and_then(|m| get(m, "id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// the conversation id agy's hooks wrote to `file`, when it is one
pub fn read_conversation(file: Option<&str>) -> Option<String> {
    let bytes = std::fs::read(file?).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let id = text.trim_matches(js_space);
    session_shaped(id).then(|| id.to_owned())
}

/// a private directory under the relay's agy directory for one spawn's conversation file
pub fn agy_conversation_dir(env: &Env) -> std::io::Result<String> {
    let parent = join(&[&scp_mcp::identity::relay_dir(env), "agy"]);
    private_dir(&parent)?;
    let template = std::ffi::CString::new(join(&[&parent, "spawn-XXXXXX"]))?;
    let mut bytes = template.into_bytes_with_nul();
    // SAFETY: mkdtemp rewrites the template, a NUL-terminated buffer it owns for the call
    if unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) }.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    bytes.pop();
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
