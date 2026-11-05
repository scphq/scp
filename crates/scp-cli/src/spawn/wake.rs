//! `swarm spawn-wake`, the broker's built-in `spawn` waker, and its detached runner, which takes a hibernated worker's endpoint back and
//! resumes its session for each batch of messages.

use super::argv::{Context, codex_mount, codex_skips_git_check, harness_argv, native_mount_bin};
use super::harness::{Input, RunOptions, run_harness};
use super::hold::{
    Held, framed, hold_endpoint, hold_loop, resumable, session_shaped, watch_signals, woke_by,
};
use super::output::{harness_output, stderr_output};
use super::runner::Channel;
use super::text::{hex, random_bytes};
use crate::args::js_string;
use crate::open::block_on;
use crate::{Call, Done, Fail, route, term};
use scp_broker::session::handback_output;
use scp_core::address::valid_handle;
use scp_core::protocol::{CLI_NAME, LIMITS};
use scp_mcp::Claim;
use scp_mcp::client::{CallError, Client, connect_broker, relay_dir};
use scp_mcp::ps::{Env, basename, process_key, ps_start};
use scp_mcp::tools::{get, js_num};
use serde_json::{Map, Value, json};
use std::io::Read;
use std::time::{Duration, Instant};

/// how long the runner tries to take the endpoint back, while the spawn that hibernated it lets go
const RECLAIM: Duration = Duration::from_secs(10);
const RECLAIM_PAUSE: Duration = Duration::from_millis(250);
/// the wake request's variables, which a resumed run does not get, with the grant and the parent
const DROPPED: [&str; 11] = [
    "SCP_WAKE_HANDLE",
    "SCP_WAKE_ENDPOINT",
    "SCP_WAKE_REF",
    "SCP_WAKE_PROVIDER",
    "SCP_WAKE_MESSAGE_ID",
    "SCP_WAKE_FROM",
    "SCP_WAKE_KIND",
    "SCP_WAKE_THREAD",
    "SCP_WAKE_TICKET",
    "SCP_GRANT",
    "SCP_PARENT",
];

/// a durable spawn's hibernation ref: the harness, its session, the directory it runs in, the resumed run's words before its prompt, the
/// idle timeout (None for none) and the parent the worker sits under
#[derive(Debug, Clone, PartialEq)]
pub struct HoldRef {
    pub harness: &'static str,
    pub session: String,
    pub cwd: String,
    pub argv: Vec<String>,
    pub idle_s: Option<f64>,
    pub parent: String,
}

impl HoldRef {
    /// the ref as `JSON.stringify` writes it
    pub fn text(&self) -> String {
        let argv: Vec<String> = self.argv.iter().map(|word| js_string(word)).collect();
        let idle = self.idle_s.map_or_else(|| "null".to_owned(), json_number);
        format!(
            "{{\"harness\":{},\"session\":{},\"cwd\":{},\"argv\":[{}],\"idle_s\":{idle},\"parent\":{}}}",
            js_string(self.harness),
            js_string(&self.session),
            js_string(&self.cwd),
            argv.join(","),
            js_string(&self.parent)
        )
    }
}

/// a number as `JSON.stringify` writes it
fn json_number(value: f64) -> String {
    if value.is_finite() {
        js_num(value)
    } else {
        "null".to_owned()
    }
}

/// a ref as `swarm spawn --durable` wrote it, or None
pub fn parse_hold_ref(text: Option<&str>) -> Option<HoldRef> {
    let value: Value = serde_json::from_str(text?).ok()?;
    let text_of = |key: &str| get(&value, key).and_then(Value::as_str);
    let harness = text_of("harness")?;
    let harness = ["codex", "agy", "grok", "muse"]
        .into_iter()
        .find(|known| *known == harness)?;
    let session = text_of("session").filter(|s| session_shaped(s))?;
    let cwd = text_of("cwd").filter(|cwd| cwd.starts_with('/'))?;
    let argv: Vec<String> = match get(&value, "argv") {
        Some(Value::Array(words)) if !words.is_empty() => words
            .iter()
            .map(|word| word.as_str().map(str::to_owned))
            .collect::<Option<_>>()?,
        _ => return None,
    };
    if resumable(&argv) != Some(harness) {
        return None;
    }
    let idle_s = match get(&value, "idle_s")? {
        Value::Null => None,
        Value::Number(number) => Some(number.as_f64().filter(|idle| *idle > 0.0)?),
        _ => return None,
    };
    let parent = text_of("parent").filter(|parent| !parent.is_empty())?;
    Some(HoldRef {
        harness,
        session: session.to_owned(),
        cwd: cwd.to_owned(),
        argv,
        idle_s,
        parent: parent.to_owned(),
    })
}

/// the handback a linked worker sends its parent, as section 9.3 words it
pub fn linked_handback_body(address: &str, code: i32, output: &str, stderr: &str) -> String {
    let tail = if code != 0 && !stderr.is_empty() {
        format!("stderr (last {} KB):\n{stderr}", LIMITS.stderr_bytes / 1024)
    } else {
        String::new()
    };
    let kept = if !tail.is_empty() && !output.is_empty() {
        let bytes = LIMITS.handback_bytes as i64 - tail.len() as i64 - 2;
        handback_output(output, false, bytes)
    } else {
        output.to_owned()
    };
    let head = if kept.is_empty() {
        format!("worker {address} exited without replying (exit {code})")
    } else {
        format!("worker {address} finished (exit {code})")
    };
    [head, kept, tail]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// stdin as text, whole
pub fn read_all_stdin() -> String {
    let mut bytes = Vec::new();
    let _ = std::io::stdin().lock().read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// the decline the built-in wakers print for a ref they cannot resume
pub fn decline(reason: &str) -> i32 {
    term::out(&json!({ "declined": reason }).to_string());
    77
}

/// `swarm spawn-wake`: reads the wake request (SPEC section 19.2) on stdin and starts a detached runner that takes the worker's endpoint
/// back and resumes its session; exit 0 once the runner holds the endpoint, 77 declining (`unresumable`) a ref it cannot resume, 1 when
/// the runner could not take the endpoint
pub fn spawn_wake(call: &Call, args: &[String]) -> Done {
    if args.first().is_some_and(|arg| arg == "--run") {
        let channel = Channel::open();
        return block_on(wake_runner(call, channel))?;
    }
    let event: Value = serde_json::from_str(&read_all_stdin()).unwrap_or(Value::Null);
    let given = |key: &str, var: &str| match get(&event, key) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => call.env.get(var).cloned(),
    };
    let reference = parse_hold_ref(given("ref", "SCP_WAKE_REF").as_deref());
    let handle = given("handle", "SCP_WAKE_HANDLE").filter(|h| !h.is_empty() && valid_handle(h));
    let endpoint = given("endpoint", "SCP_WAKE_ENDPOINT").filter(|e| !e.is_empty());
    let (Some(reference), Some(handle), Some(endpoint)) = (reference, handle, endpoint) else {
        return Ok(decline("unresumable"));
    };
    if !std::fs::metadata(&reference.cwd).is_ok_and(|meta| meta.is_dir()) {
        return Ok(decline("unresumable"));
    }
    let mut env = call.env.clone();
    route::handed_on(&mut env);
    env.insert("SCP_WAKE_HANDLE".into(), handle);
    env.insert("SCP_WAKE_ENDPOINT".into(), endpoint);
    env.insert("SCP_WAKE_REF".into(), reference.text());
    let line = block_on(async {
        let Ok(exe) = std::env::current_exe() else {
            return String::new();
        };
        let mut command = tokio::process::Command::new(exe);
        command
            .args(["spawn-wake", "--run"])
            .current_dir(&reference.cwd)
            .env_clear()
            .envs(&env);
        scp_mcp::spawn::handshake_line(command).await
    })?;
    let reply: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    if scp_mcp::tools::truthy(get(&reply, "ok")) {
        return Ok(0);
    }
    let error = match get(&reply, "error") {
        None | Some(Value::Null) => "the runner ended before it held the endpoint".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    };
    term::note(&format!("{CLI_NAME} spawn-wake: {error}"));
    Ok(1)
}

fn set(env: &Env, key: &str) -> Option<String> {
    env.get(key).filter(|value| !value.is_empty()).cloned()
}

/// the waker's runner: takes the endpoint back where it sits, holds it, resumes the session with each batch and hands each run back
async fn wake_runner(call: &Call<'_>, mut channel: Channel) -> Done {
    let env = call.env;
    let reference = parse_hold_ref(env.get("SCP_WAKE_REF").map(String::as_str));
    let handle = set(env, "SCP_WAKE_HANDLE");
    let address = set(env, "SCP_WAKE_ENDPOINT");
    let ticket = set(env, "SCP_WAKE_TICKET");
    let (Some(reference), Some(handle), Some(_), Some(ticket)) =
        (reference, handle, address, ticket.clone())
    else {
        let error = if ticket.is_some() {
            "no resumable ref"
        } else {
            "no wake ticket: this broker cannot hand the endpoint back"
        };
        channel.send(&json!({ "error": error }));
        return Ok(1);
    };
    let session = hex(&random_bytes::<16>());
    let pid = std::process::id();
    let mut claim = Claim::new();
    claim.insert("handle".into(), Value::from(handle.as_str()));
    claim.insert("harness".into(), Value::from(reference.harness));
    claim.insert("cwd".into(), Value::from(reference.cwd.as_str()));
    claim.insert("session".into(), Value::from(format!("env:{session}")));
    claim.insert(
        "process".into(),
        Value::from(process_key(i64::from(pid), &ps_start)),
    );
    claim.insert("exact".into(), Value::Bool(true));
    claim.insert("ticket".into(), Value::from(ticket));
    let durable_text = reference.text();
    let durable = |_: &Value| Some(durable_text.clone());
    let mut failure = format!(
        "{} could not be taken back",
        env.get("SCP_WAKE_ENDPOINT").map_or("", String::as_str)
    );
    let deadline = Instant::now() + RECLAIM;
    let mut held = None;
    while held.is_none() && Instant::now() < deadline {
        let mut log = |line: &str| failure = line.to_owned();
        held = hold_endpoint(env, claim.clone(), Some(&durable), &mut log).await;
        if held.is_none() {
            tokio::time::sleep(RECLAIM_PAUSE).await;
        }
    }
    let Some(held) = held else {
        channel.send(&json!({ "error": failure }));
        return Ok(1);
    };
    channel.send(&json!({ "ok": true }));
    let mut run_env: Env = env
        .iter()
        .filter(|(key, _)| !DROPPED.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    route::caller_argv(&mut run_env);
    run_env.insert("SCP_NAME".into(), handle.clone());
    run_env.insert("SCP_SESSION".into(), session);
    run_env.insert("SCP_HARNESS_PID".into(), pid.to_string());
    let spare = resumed(env, held.token.as_deref()).await;
    let mut signals = watch_signals();
    let runs = Runs {
        reference: &reference,
        env: &run_env,
        self_words: super::run::self_words(call, env),
        held: &held,
        spare: spare.as_ref(),
        handle: &handle,
        failed: std::cell::RefCell::new(None),
    };
    hold_loop(
        &held,
        reference.idle_s.unwrap_or(f64::INFINITY),
        &mut signals,
        |messages: Vec<Value>| runs.resume(messages),
        || {
            if let Some(spare) = &spare {
                spare.close();
            }
        },
    )
    .await;
    drop(signals);
    if let Some(spare) = &spare {
        spare.close();
    }
    match runs.failed.into_inner() {
        Some(fail) => Err(fail),
        None => Ok(0),
    }
}

/// what each resumed run of a held worker shares
struct Runs<'a> {
    reference: &'a HoldRef,
    env: &'a Env,
    self_words: Vec<String>,
    held: &'a Held,
    spare: Option<&'a Client>,
    handle: &'a str,
    failed: std::cell::RefCell<Option<Fail>>,
}

impl Runs<'_> {
    async fn resume(&self, messages: Vec<Value>) {
        let mut argv = self.reference.argv.clone();
        argv.push(framed(&messages));
        let codex = argv
            .get(super::argv::program_at(&argv))
            .is_some_and(|program| basename(program) == "codex");
        let bin = codex.then(|| native_mount_bin(self.env)).flatten();
        let context = Context {
            self_words: &self.self_words,
            mount: &codex_mount,
            bin: bin.as_deref(),
            cwd: &self.reference.cwd,
            probe: &codex_skips_git_check,
        };
        let words = harness_argv(&argv, self.env, &context);
        let sink = std::fs::OpenOptions::new().write(true).open("/dev/null");
        let to = sink.as_ref().ok().map(|file| {
            let fd = std::os::fd::AsRawFd::as_raw_fd(file);
            (fd, fd)
        });
        let options = RunOptions {
            capture: Some(true),
            capture_err: Some(true),
            stdin: Input::Ignore,
            group: true,
            to,
            ..RunOptions::default()
        };
        let run = match run_harness(&words, self.env, options).await {
            Ok(run) => run,
            Err(fail) => {
                self.failed.replace(Some(fail));
                return;
            }
        };
        drop(sink);
        let code = run.code.min(255);
        let woke = woke_by(&messages);
        let address = get(&self.held.endpoint, "address")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let body = linked_handback_body(
            address,
            code,
            &harness_output(&run, None),
            &stderr_output(&run, None),
        );
        let parent = get(&self.held.endpoint, "parent")
            .and_then(Value::as_str)
            .filter(|parent| !parent.is_empty());
        let hand_back = async |client: &Client| -> Result<(), CallError> {
            if let Some(parent) = parent {
                let mut send = Map::new();
                send.insert("to".into(), Value::from(parent));
                send.insert("kind".into(), Value::from("message"));
                send.insert("body".into(), Value::from(body.as_str()));
                if let Some(woke) = &woke {
                    send.insert("reply_to".into(), Value::from(woke.as_str()));
                }
                client.request("send", Value::Object(send)).await?;
            }
            let status = json!({ "state": "done", "note": format!("exited {code}") });
            client.request("status", status).await?;
            Ok(())
        };
        let handed = match hand_back(&self.held.client).await {
            Ok(()) => Ok(()),
            Err(error) => match self.spare {
                Some(spare) if self.held.client.closed() => hand_back(spare).await,
                _ => Err(error),
            },
        };
        if let Err(error) = handed {
            term::note(&format!(
                "{CLI_NAME} spawn-wake: could not hand {}'s result back: {}",
                self.handle,
                error.message()
            ));
        }
    }
}

/// a second connection to the held endpoint, resumed with its token before a harness run replaces it: `spawn_end` closes only the holding
/// connection, so a run in flight still hands back over this one
async fn resumed(env: &Env, token: Option<&str>) -> Option<Client> {
    let token = token?;
    let client = connect_broker(&relay_dir(env), None).await.ok()?;
    let mut hello = Map::new();
    hello.insert("resume".into(), Value::from(token));
    match client.hello(hello).await {
        Ok(_) => Some(client),
        Err(_) => {
            client.close();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ref_parses_only_as_spawn_wrote_it() {
        let reference = r#"{"harness":"codex","session":"019a-s","cwd":"/w","argv":["/bin/codex","exec","resume","019a-s"],"idle_s":1800,"parent":"me/lead"}"#;
        let parsed = parse_hold_ref(Some(reference)).unwrap();
        assert_eq!(parsed.text(), reference);
        let null = reference.replace("1800", "null");
        assert_eq!(parse_hold_ref(Some(&null)).unwrap().idle_s, None);
        let extra = reference.replace("\"parent\"", "\"x\":1,\"parent\"");
        assert_eq!(parse_hold_ref(Some(&extra)).unwrap().text(), reference);
        for bad in [
            reference.replace("\"codex\",\"session", "\"muse\",\"session"),
            reference.replace(
                r#"["/bin/codex","exec","resume","019a-s"]"#,
                r#"["/bin/agy","-p"]"#,
            ),
            reference.replace("\"/w\"", "\"rel\""),
            reference.replace("019a-s\",\"cwd", "a b\",\"cwd"),
            reference.replace("1800", "0"),
            reference.replace("1800", "-1"),
            reference.replace("1800", "\"1800\""),
            reference.replace(",\"idle_s\":1800", ""),
            reference.replace("me/lead", ""),
            reference.replace(r#"["/bin/codex","exec","resume","019a-s"]"#, "[]"),
            reference.replace(r#""exec","resume""#, r#""exec",7"#),
            "not json".to_owned(),
            "[]".to_owned(),
            "null".to_owned(),
        ] {
            assert_eq!(parse_hold_ref(Some(&bad)), None, "{bad}");
        }
        assert_eq!(parse_hold_ref(None), None);
        let fraction = reference.replace("1800", "1800.5e0");
        assert!(
            parse_hold_ref(Some(&fraction))
                .unwrap()
                .text()
                .contains("\"idle_s\":1800.5,")
        );
    }

    #[test]
    fn a_linked_handback_keeps_the_stderr_tail_of_a_failed_run() {
        assert_eq!(
            linked_handback_body("me/m/w", 0, "done", "warn"),
            "worker me/m/w finished (exit 0)\n\ndone"
        );
        assert_eq!(
            linked_handback_body("me/m/w", 2, "", "boom"),
            "worker me/m/w exited without replying (exit 2)\n\nstderr (last 1 KB):\nboom"
        );
        assert_eq!(
            linked_handback_body("me/m/w", 1, "", ""),
            "worker me/m/w exited without replying (exit 1)"
        );
        let long = "x".repeat(20_000);
        let body = linked_handback_body("me/w", 1, &long, "err");
        assert!(body.ends_with("\n\nstderr (last 1 KB):\nerr"));
        let kept = body.split("\n\n").nth(1).unwrap();
        assert!(
            kept.len() <= LIMITS.handback_bytes as usize - "stderr (last 1 KB):\nerr".len() - 2
        );
        assert_eq!(kept, handback_output(&long, false, 16384 - 23 - 2));
    }
}
