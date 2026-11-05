//! `swarm codex-wake`, the broker's built-in `codex-queue` waker: queues a hibernated Codex thread's messages with `codex queue`, unless a
//! running `codex exec` holds the thread, and opens the thread in the desktop app when the app or nobody holds it.

use super::hold::framed;
use super::wake::{decline, read_all_stdin};
use crate::claude::bg_io::exec_file;
use crate::open::block_on;
use crate::{Call, Done, Fail, route, term};
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::{Client, connect_within, relay_dir};
use scp_mcp::identity::{codex_thread, home_dir, safe_cwd};
use scp_mcp::ps::{
    Env, PS_TIMEOUT_MS, PsCommTable, codex_subcommand, join, read_ps_table, resolve,
};
use scp_mcp::render::js_space;
use scp_mcp::tools::get;
use serde_json::{Value, json};
use std::cell::Cell;
use std::collections::HashSet;

const RUN_TIMEOUT_MS: u64 = 30_000;
const MAX_BUFFER: usize = 1 << 20;
/// how long the waker keeps trying a busy broker: well inside its run's timeout
const WAKER_CONNECT_MS: u64 = 15_000;
/// the most one `codex queue` message carries, under any argument length limit
const BATCH_BYTES: usize = 96 * 1024;
const PAGES: usize = 5;

/// who holds a Codex thread's writer lock
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    None,
    Desktop,
    Scp,
    Ide,
    AppServer,
    Exec,
    Tui,
    Other,
    Unknown,
}

/// how a command run as Node's `execFile` runs it ended: its exit code, None for a signal, a limit or a failed start
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ran {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub missing: bool,
}

/// the writer lock file of `thread`, a checked thread id, as an absolute path
pub fn codex_lock_path(thread: &str, env: &Env) -> String {
    let set = |key: &str| env.get(key).filter(|value| !value.is_empty()).cloned();
    let base = set("CODEX_HOME").unwrap_or_else(|| {
        let home = set("HOME").unwrap_or_else(home_dir);
        join(&[&home, ".codex"])
    });
    let file = format!("{thread}.lock");
    resolve(&safe_cwd(), &join(&[&base, "thread-writer-locks", &file]))
}

/// `/(^|\/)(ChatGPT|Codex)\.app\/Contents\/MacOS\//`
fn desktop_app(args: &str) -> bool {
    ["ChatGPT.app/Contents/MacOS/", "Codex.app/Contents/MacOS/"]
        .iter()
        .any(|marker| {
            args.match_indices(marker)
                .any(|(at, _)| at == 0 || args.as_bytes()[at - 1] == b'/')
        })
}

/// `/\.app\/Contents\/Resources\/codex-cli\//`
fn bundled(args: &str) -> bool {
    args.contains(".app/Contents/Resources/codex-cli/")
}

/// `/Visual Studio Code|Code Helper|Cursor\.app|Windsurf|\.vscode|\.cursor|JetBrains|extensions\/openai\.chatgpt/`
fn ide(args: &str) -> bool {
    [
        "Visual Studio Code",
        "Code Helper",
        "Cursor.app",
        "Windsurf",
        ".vscode",
        ".cursor",
        "JetBrains",
        "extensions/openai.chatgpt",
    ]
    .iter()
    .any(|marker| args.contains(marker))
}

/// `/--listen\s+unix:\/\/\S*\/scp-codex-[^/\s]*\/app\.sock/`
fn scp_server(args: &str) -> bool {
    args.match_indices("--listen").any(|(at, flag)| {
        let rest = &args[at + flag.len()..];
        let spaced = rest.trim_start_matches(js_space);
        if spaced.len() == rest.len() {
            return false;
        }
        let Some(path) = spaced.strip_prefix("unix://") else {
            return false;
        };
        let word = &path[..path.find(js_space).unwrap_or(path.len())];
        word.match_indices("/scp-codex-").any(|(at, marker)| {
            let name = &word[at + marker.len()..];
            name[name.find('/').unwrap_or(name.len())..].starts_with("/app.sock")
        })
    })
}

/// `/(^|\/)codex(\.js)?(\s|$)/`
fn codex_word(args: &str) -> bool {
    args.match_indices("codex").any(|(at, word)| {
        if at > 0 && args.as_bytes()[at - 1] != b'/' {
            return false;
        }
        let rest = &args[at + word.len()..];
        let rest = rest
            .strip_prefix(".js")
            .filter(|after| after.is_empty() || after.starts_with(js_space));
        let rest = rest.unwrap_or(&args[at + word.len()..]);
        rest.is_empty() || rest.starts_with(js_space)
    })
}

/// the surface process `pid` holding a writer lock belongs to, from the process table
pub fn owner_of(pid: i64, table: Option<&PsCommTable>) -> Owner {
    let Some(holder) = table.and_then(|table| table.get(&pid)) else {
        return Owner::Unknown;
    };
    let sub = codex_subcommand(&holder.args);
    if matches!(sub.as_deref(), Some("exec" | "e")) {
        return Owner::Exec;
    }
    if sub.as_deref() != Some("app-server") {
        return if codex_word(&holder.args) {
            Owner::Tui
        } else {
            Owner::Other
        };
    }
    if scp_server(&holder.args) {
        return Owner::Scp;
    }
    if bundled(&holder.args) {
        return Owner::Desktop;
    }
    let table = table.expect("the holder came from the table");
    let mut seen = HashSet::from([pid]);
    let mut at = holder.ppid;
    while at > 1 && !seen.contains(&at) && seen.len() < 32 {
        seen.insert(at);
        let args = table.get(&at).map_or("", |entry| entry.args.as_str());
        if ide(args) {
            return Owner::Ide;
        }
        if desktop_app(args) || bundled(args) {
            return Owner::Desktop;
        }
        at = table.get(&at).map_or(0, |entry| entry.ppid);
    }
    Owner::AppServer
}

/// one owner for several holders: their topmost processes (children inherit the lock's descriptor), an exec over all, desktop only when all are
pub fn owner_of_all(pids: &[i64], table: Option<&PsCommTable>) -> Owner {
    let held: HashSet<i64> = pids.iter().copied().collect();
    let parent = |pid: i64| {
        table
            .and_then(|table| table.get(&pid))
            .map_or(0, |e| e.ppid)
    };
    let top = pids.iter().copied().filter(|pid| {
        let mut seen = HashSet::from([*pid]);
        let mut at = parent(*pid);
        while at > 1 && !seen.contains(&at) {
            if held.contains(&at) {
                return false;
            }
            seen.insert(at);
            at = parent(at);
        }
        true
    });
    let owners: Vec<Owner> = top.map(|pid| owner_of(pid, table)).collect();
    if owners.contains(&Owner::Exec) {
        return Owner::Exec;
    }
    owners
        .into_iter()
        .find(|owner| *owner != Owner::Desktop)
        .unwrap_or(Owner::Desktop)
}

fn pid_of(digits: &str) -> i64 {
    digits.parse().unwrap_or(i64::MAX)
}

/// `[...text.matchAll(/^\s*(\d+)\s*$/gm)]`: the lines that hold one number
pub fn lsof_pids(text: &str) -> Vec<i64> {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .map(|line| line.trim_matches(js_space))
        .filter(|line| !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit()))
        .map(pid_of)
        .collect()
}

/// `[...text.replaceAll(path, " ").matchAll(/(?:^|\s)(\d+)[a-zA-Z]*(?=\s|$)/g)]`: the words that are a number and access letters
pub fn fuser_pids(text: &str, path: &str) -> Vec<i64> {
    let text = if path.is_empty() {
        text.to_owned()
    } else {
        text.replace(path, " ")
    };
    text.split(js_space)
        .filter_map(|word| {
            let digits = word.trim_end_matches(|c: char| c.is_ascii_alphabetic());
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
                .then(|| pid_of(digits))
        })
        .collect()
}

/// runs `bin` with `args` as Node's `execFile` does, never through a shell and without the wake request's variables: 30 s, then SIGTERM;
/// past 1 MiB on either stream SIGTERM too
pub async fn run_file(bin: &str, args: &[String], env: &Env) -> Ran {
    run_file_within(bin, args, env, RUN_TIMEOUT_MS).await
}

async fn run_file_within(bin: &str, args: &[String], env: &Env, timeout_ms: u64) -> Ran {
    let env: Env = env
        .iter()
        .filter(|(key, _)| !key.starts_with("SCP_WAKE_"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let ran = exec_file(bin, &args, timeout_ms, MAX_BUFFER, &env, None).await;
    Ran {
        code: ran.code,
        stdout: String::from_utf8_lossy(&ran.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&ran.stderr).into_owned(),
        missing: ran.missing,
    }
}

fn bin(env: &Env, key: &str, default: &str) -> String {
    env.get(key)
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| default.to_owned())
}

/// the pids `lsof`, else `fuser`, names for the lock; None when neither could tell
async fn holders(path: &str, env: &Env) -> Option<Vec<i64>> {
    let lsof = run_file(
        &bin(env, "SCP_LSOF_BIN", "lsof"),
        &words(&["-t", "--", path]),
        env,
    )
    .await;
    let blank = |text: &str| text.trim_matches(js_space).is_empty();
    if !lsof.missing
        && (lsof.code == Some(0)
            || (lsof.code == Some(1) && blank(&lsof.stdout) && blank(&lsof.stderr)))
    {
        return Some(lsof_pids(&lsof.stdout));
    }
    let fuser = run_file(&bin(env, "SCP_FUSER_BIN", "fuser"), &words(&[path]), env).await;
    if fuser.missing || !matches!(fuser.code, Some(0 | 1)) {
        return None;
    }
    Some(fuser_pids(&fuser.stdout, path))
}

fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|word| (*word).to_owned()).collect()
}

/// who holds `thread` (a checked thread id) open for writing: no lock file is nobody, and a lock no tool could name is unknown
pub async fn codex_owner(thread: &str, env: &Env) -> Owner {
    let path = codex_lock_path(thread, env);
    if !std::path::Path::new(&path).exists() {
        return Owner::None;
    }
    let Some(pids) = holders(&path, env).await else {
        return Owner::Unknown;
    };
    let own: Vec<i64> = pids.into_iter().filter(|pid| *pid > 1).collect();
    if own.is_empty() {
        return Owner::None;
    }
    owner_of_all(&own, read_ps_table(PS_TIMEOUT_MS).as_ref())
}

/// the messages as `codex queue` messages of at most BATCH_BYTES each (one larger message goes alone), in order
pub fn batches(messages: &[Value]) -> Vec<Vec<Value>> {
    let mut out: Vec<Vec<Value>> = Vec::new();
    let mut size = 0;
    for message in messages {
        let bytes = framed(std::slice::from_ref(message)).len() + 2;
        if out.is_empty() || size + bytes > BATCH_BYTES {
            out.push(Vec::new());
            size = 0;
        }
        if let Some(last) = out.last_mut() {
            last.push(message.clone());
        }
        size += bytes;
    }
    out
}

fn seqs(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|message| get(message, "seq").cloned())
        .collect()
}

/// why a `codex queue` that did not exit 0 ends the waker: None for a thread with no rollout yet, which declines, else the note it fails with
fn queue_failure(result: &Ran) -> Option<String> {
    if result
        .stderr
        .to_ascii_lowercase()
        .contains("no rollout found")
    {
        return None;
    }
    let last = result
        .stderr
        .trim_matches(js_space)
        .split('\n')
        .next_back()
        .map(|line| line.trim_matches(js_space))
        .unwrap_or_default();
    let why = if result.missing {
        "is not installed".to_owned()
    } else if last.is_empty() {
        "failed".to_owned()
    } else {
        format!("failed: {last}")
    };
    Some(format!("{CLI_NAME} codex-wake: codex queue {why}"))
}

/// confirms queued messages read, retried once: a lost confirmation would queue them again; whether all of them were
async fn confirm(client: &Client, seqs: Vec<Value>, hold: &str) -> Result<bool, Fail> {
    let count = seqs.len();
    let params = json!({ "seqs": seqs, "hold": hold, "read": seqs });
    let reply = match client.request("injected", params.clone()).await {
        Ok(reply) => reply,
        Err(_) => client.request("injected", params).await?,
    };
    Ok(get(&reply, "injected").and_then(Value::as_f64) == Some(count as f64))
}

/// `swarm codex-wake`: reads the wake request (SPEC section 19.2), binds to the endpoint with the run's wake ticket, queues the offered
/// messages into the Codex thread named by the ref and confirms them read, then opens the thread in the desktop app when the app or
/// nobody holds it. A running `codex exec` keeps them for its hooks; exit 0, 77 declining (`no-rollout`, `unresumable`), or 1 on a failure
pub fn codex_wake(call: &Call) -> Done {
    let event: Value = serde_json::from_str(&read_all_stdin()).unwrap_or(Value::Null);
    let reference = match get(&event, "ref") {
        None | Some(Value::Null) => call
            .env
            .get("SCP_WAKE_REF")
            .map(|r| Value::from(r.as_str())),
        Some(given) => Some(given.clone()),
    };
    let Some(thread) = reference
        .as_ref()
        .and_then(Value::as_str)
        .filter(|thread| codex_thread(thread))
        .map(str::to_owned)
    else {
        return Ok(decline("unresumable"));
    };
    let Some(ticket) = call
        .env
        .get("SCP_WAKE_TICKET")
        .filter(|ticket| !ticket.is_empty())
        .cloned()
    else {
        term::note(&format!(
            "{CLI_NAME} codex-wake: no wake ticket: this broker cannot hand the messages over"
        ));
        return Ok(1);
    };
    let mut env = call.env.clone();
    route::caller_argv(&mut env);
    block_on(wake(&thread, &ticket, &env))?
}

async fn wake(thread: &str, ticket: &str, env: &Env) -> Done {
    if codex_owner(thread, env).await == Owner::Exec {
        return Ok(0);
    }
    let client = connect_within(&relay_dir(env), None, WAKER_CONNECT_MS).await?;
    let queued = Cell::new(false);
    let done = queue(&client, thread, ticket, env, &queued).await;
    client.close();
    if let Some(code) = done? {
        return Ok(code);
    }
    let darwin = cfg!(target_os = "macos");
    let open_bin = env.get("SCP_OPEN_BIN").filter(|bin| !bin.is_empty());
    if !queued.get() || (!darwin && open_bin.is_none()) {
        return Ok(0);
    }
    if !matches!(codex_owner(thread, env).await, Owner::None | Owner::Desktop) {
        return Ok(0);
    }
    let url = format!("codex://threads/wake/{thread}");
    let opened = run_file(
        &bin(env, "SCP_OPEN_BIN", "open"),
        &words(&["-g", &url]),
        env,
    )
    .await;
    if opened.code != Some(0) {
        let stderr = opened.stderr.trim_matches(js_space);
        let why = if stderr.is_empty() {
            format!(
                "exit {}",
                opened.code.map_or("null".to_owned(), |c| c.to_string())
            )
        } else {
            stderr.to_owned()
        };
        term::note(&format!(
            "{CLI_NAME} codex-wake: queued, but the desktop app did not open the thread ({why})"
        ));
    }
    Ok(0)
}

/// the offered pages queued and confirmed batch by batch; Some(code) when the waker ends there
async fn queue(
    client: &Client,
    thread: &str,
    ticket: &str,
    env: &Env,
    queued: &Cell<bool>,
) -> Result<Option<i32>, Fail> {
    let mut hello = serde_json::Map::new();
    hello.insert("observe".into(), Value::Bool(true));
    hello.insert("ticket".into(), Value::from(ticket));
    client.hello(hello).await?;
    let codex = bin(env, "SCP_CODEX_BIN", "codex");
    for _ in 0..PAGES {
        let page = client.request("inbox", json!({ "offer": true })).await?;
        let messages = scp_mcp::render::list_of(get(&page, "messages"));
        let hold = match get(&page, "hold") {
            Some(Value::String(hold)) if !hold.is_empty() => hold.clone(),
            _ => break,
        };
        if !messages.iter().any(|message| get(message, "seq").is_some()) {
            break;
        }
        for batch in batches(messages) {
            client.request("whoami", json!({})).await?;
            let args = [
                "queue".to_owned(),
                format!("--thread={thread}"),
                format!("--message={}", framed(&batch)),
            ];
            let result = run_file(&codex, &args, env).await;
            if result.code != Some(0) {
                return Ok(Some(match queue_failure(&result) {
                    None => decline("no-rollout"),
                    Some(note) => {
                        term::note(&note);
                        1
                    }
                }));
            }
            queued.set(true);
            if !confirm(client, seqs(&batch), &hold).await? {
                term::note(&format!(
                    "{CLI_NAME} codex-wake: queued, but the broker no longer held the messages for this run"
                ));
                return Ok(Some(1));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use scp_mcp::ps::PsEntry;

    const START: &str = "Fri-Oct-17-09:00:00-2026";
    const DESKTOP_CLI: &str =
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

    fn table(rows: &[(i64, i64, &str)]) -> PsCommTable {
        rows.iter()
            .map(|(pid, ppid, args)| {
                (
                    *pid,
                    PsEntry {
                        ppid: *ppid,
                        start: START.into(),
                        args: (*args).into(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn the_holder_and_its_ancestors_name_the_surface() {
        let desktop = format!(
            "{DESKTOP_CLI} -c features.code_mode_host=true app-server --analytics-default-enabled"
        );
        let desktop_exec = format!("{DESKTOP_CLI} exec hi");
        let ps = table(&[
            (10, 9, &desktop),
            (9, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
            (
                20,
                19,
                "/opt/codex app-server --listen unix:///tmp/scp-codex-AbC123/app.sock -c mcp_servers.scp.enabled=true",
            ),
            (
                30,
                29,
                "/home/u/.vscode/extensions/openai.chatgpt-1.0/bin/codex app-server",
            ),
            (
                29,
                1,
                "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
            ),
            (
                40,
                39,
                "/u/.codex/packages/app-server-daemon/releases/0.163.0/bin/codex app-server --listen unix://",
            ),
            (
                39,
                1,
                "/u/.codex/packages/app-server-daemon/releases/0.163.0/bin/codex app-server daemon pid-update-loop",
            ),
            (
                50,
                49,
                "codex exec -C /work -m gpt --sandbox workspace-write fix the app-server",
            ),
            (51, 49, "codex -c model=x e hello"),
            (60, 49, "codex resume 01a1602d-b655-70a1-b717-0af8f5083d80"),
            (61, 49, "codex --model gpt"),
            (
                62,
                49,
                r#"codex -c mcp_servers.scp.env_vars=["SCP_GRANT", "SCP_NAME"] -C /a/b exec fix it"#,
            ),
            (63, 49, &desktop_exec),
            (64, 49, "/usr/bin/vim notes"),
            (66, 49, "codex fix exec crash"),
            (65, 10, "/bin/zsh -lc make"),
            (49, 1, "-zsh"),
        ]);
        let expected = [
            (10, Owner::Desktop),
            (20, Owner::Scp),
            (30, Owner::Ide),
            (40, Owner::AppServer),
            (50, Owner::Exec),
            (51, Owner::Exec),
            (60, Owner::Tui),
            (61, Owner::Tui),
            (62, Owner::Exec),
            (63, Owner::Exec),
            (64, Owner::Other),
            (66, Owner::Tui),
            (99, Owner::Unknown),
        ];
        for (pid, owner) in expected {
            assert_eq!(owner_of(pid, Some(&ps)), owner, "{pid}");
        }
        assert_eq!(owner_of(10, None), Owner::Unknown);
    }

    #[test]
    fn several_holders_count_as_their_topmost_and_an_exec_wins() {
        let desktop = format!("{DESKTOP_CLI} app-server");
        let ps = table(&[
            (10, 9, &desktop),
            (9, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
            (11, 10, "/bin/zsh -lc make"),
            (50, 1, "codex exec hi"),
        ]);
        assert_eq!(owner_of_all(&[11, 10], Some(&ps)), Owner::Desktop);
        assert_eq!(owner_of_all(&[10, 50], Some(&ps)), Owner::Exec);
        let looped = table(&[(5, 6, "a"), (6, 5, "b")]);
        assert_eq!(owner_of_all(&[5, 6], Some(&looped)), Owner::Desktop);
    }

    #[test]
    fn the_word_matchers_follow_the_patterns() {
        assert!(codex_word("codex"));
        assert!(codex_word("/usr/bin/codex.js --x"));
        assert!(codex_word("node /x/codex.js"));
        assert!(!codex_word("xcodex run"));
        assert!(!codex_word("codexx"));
        assert!(!codex_word("/opt/codex.jsx"));
        assert!(codex_word("/a/codex.jsx /b/codex"));
        assert!(!scp_server("x --listen  unix:///a b/scp-codex-1/app.sock"));
        assert!(scp_server("x --listen\tunix:///t/scp-codex-/app.socket"));
        assert!(!scp_server("x --listen unix:///t/scp-codex-a/b/app.sock"));
        assert!(scp_server(
            "x --listen unix:///t/scp-codex-a/b/scp-codex-c/app.sock"
        ));
        assert!(!scp_server("x --listenunix:///t/scp-codex-a/app.sock"));
        assert!(desktop_app("/Applications/Codex.app/Contents/MacOS/Codex"));
        assert!(!desktop_app(
            "/Applications/MyCodex.app/Contents/MacOS/Codex"
        ));
    }

    #[test]
    fn lsof_and_fuser_output_name_the_pids() {
        assert_eq!(lsof_pids("12\n  34 \n5 6\nx7\n\n"), vec![12, 34]);
        assert_eq!(lsof_pids(""), Vec::<i64>::new());
        let path = "/h/.codex/thread-writer-locks/t.lock";
        assert_eq!(
            fuser_pids(&format!("{path}: 10 11c 12a3 x13"), path),
            vec![10, 11]
        );
        assert_eq!(fuser_pids("  42m\n", path), vec![42]);
    }

    #[test]
    fn large_messages_split_into_batches_one_oversized_message_alone() {
        let message = |id: &str, body: String| json!({ "id": id, "seq": 1, "from": { "address": "me/peer" }, "kind": "message", "body": { "text": body }, "ts": 0 });
        let small: Vec<Value> = (0..3)
            .map(|i| message(&format!("m{i}"), "hi".into()))
            .collect();
        assert_eq!(batches(&small).len(), 1);
        let big = vec![
            message("a", "a".repeat(60_000)),
            message("b", "b".repeat(60_000)),
            message("c", "c".repeat(200_000)),
            message("d", "d".into()),
        ];
        let split = batches(&big);
        assert_eq!(
            split.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![1, 1, 1, 1]
        );
        assert!(batches(&[]).is_empty());
    }

    fn timed_out(script: &str) -> (Ran, std::time::Duration) {
        let args = ["-c".to_owned(), script.to_owned()];
        let env = Env::from([("PATH".to_owned(), "/usr/bin:/bin".to_owned())]);
        let started = std::time::Instant::now();
        let ran = block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_secs(20),
                run_file_within("/bin/sh", &args, &env, 300),
            )
            .await
        })
        .unwrap()
        .expect("the run returns");
        (ran, started.elapsed())
    }

    #[test]
    fn a_child_that_writes_as_it_is_stopped_returns_with_only_what_came_before() {
        let (ran, took) = timed_out(
            "echo before; echo early >&2; trap 'head -c 300000 /dev/zero; head -c 300000 /dev/zero >&2; exit 3' TERM; while :; do sleep 0.05; done",
        );
        assert!(took < std::time::Duration::from_secs(5), "{took:?}");
        assert_eq!(ran.code, Some(3));
        assert_eq!(
            (ran.stdout.as_str(), ran.stderr.as_str()),
            ("before\n", "early\n")
        );
        let env = Env::from([("PATH".to_owned(), "/usr/bin:/bin".to_owned())]);
        let missing = block_on(run_file("/nowhere/codex", &[], &env)).unwrap();
        assert_eq!((missing.code, missing.missing), (None, true));
        assert_eq!(
            queue_failure(&missing).as_deref(),
            Some("swarm codex-wake: codex queue is not installed")
        );
    }

    #[test]
    fn a_rollout_error_printed_once_stopped_fails_the_wake_instead_of_declining() {
        let (ran, took) = timed_out(
            "trap 'echo \"Error: no rollout found for thread id x\" >&2; exit 1' TERM; while :; do sleep 0.05; done",
        );
        assert!(took < std::time::Duration::from_secs(5), "{took:?}");
        assert_eq!((ran.code, ran.stderr.as_str()), (Some(1), ""));
        assert_eq!(
            queue_failure(&ran).as_deref(),
            Some("swarm codex-wake: codex queue failed")
        );
        let early = Ran {
            code: Some(1),
            stderr: "Error: No Rollout Found for thread id x\n".into(),
            ..Ran::default()
        };
        assert_eq!(queue_failure(&early), None);
        let failed = Ran {
            code: Some(1),
            stderr: "warn\nError: daemon unavailable\n".into(),
            ..Ran::default()
        };
        assert_eq!(
            queue_failure(&failed).as_deref(),
            Some("swarm codex-wake: codex queue failed: Error: daemon unavailable")
        );
    }

    #[test]
    fn the_lock_path_is_under_codex_home_else_home() {
        let env = Env::from([("CODEX_HOME".to_owned(), "/c".to_owned())]);
        assert_eq!(codex_lock_path("t", &env), "/c/thread-writer-locks/t.lock");
        let env = Env::from([("HOME".to_owned(), "/h".to_owned())]);
        assert_eq!(
            codex_lock_path("t", &env),
            "/h/.codex/thread-writer-locks/t.lock"
        );
    }
}
