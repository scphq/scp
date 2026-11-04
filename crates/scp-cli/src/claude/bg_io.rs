//! The claude-bg policy at work: the `claude` and `ps` it runs, the broker over its socket as the human, and the steps that stop, remove
//! and wake a session.

use super::bg_plan::{
    Action, BgConfig, Due, Index, PlanInput, RemoveMode, Target, ancestors_of, attach_targets,
    attached_to, bg_config, commands_of, date_ms, js_trim, maybe_due, only_polls_inbox, plan,
    removable, remove_mode_of,
};
use super::bg_state::{
    Agent, BgRecord, BgState, Entry, PROVIDER, Records, TaskState, bg_dir, lock_session,
    read_records, read_state, read_states, remove_state, revive_ref, session_id, short_id,
    state_over, without, write_private, write_state,
};
use crate::fleet::json::Json;
use crate::{Host, term};
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::{CallError, Client, connect_broker, relay_dir};
use scp_mcp::identity::{home_dir, read_owned_file, safe_cwd};
use scp_mcp::ps::Env;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::pin::Pin;
use std::process::Stdio;
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, ReadBuf};

const LIST_TIMEOUT_MS: u64 = 15_000;
pub const ACT_TIMEOUT_MS: u64 = 30_000;
const OUTPUT_MAX: usize = 4 << 20;
/// how long a timed out child has to exit after SIGTERM before it gets SIGKILL
const KILL_GRACE: Duration = Duration::from_secs(5);
/// how long the output of an exited child is still read once the run is over
const DRAIN_GRACE: Duration = Duration::from_secs(1);
const MOUNT_VARS: [&str; 3] = ["SCP_NATIVE", "SCP_SWARM_BIN", "SCP_CLI_ARGV"];
const CLAUDE_MCP: [&str; 3] = ["--harness", "claude", "--channels"];
/// a launcher's own identity, which claude's daemon must not keep for the sessions it starts later
const LAUNCHER_IDENTITY: [&str; 18] = [
    "CLAUDE_BG_SOURCE",
    "CLAUDE_CODE_SESSION_KIND",
    "CLAUDE_CODE_IS_COWORK",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_WORKSPACE_HOST_PATHS",
    "SCP_NAME",
    "SCP_GRANT",
    "SCP_SESSION",
    "SCP_PARENT",
    "SCP_UNDER",
    "SCP_HARNESS",
    "SCP_SHIM_BINDING",
    "SCP_SPAWN_RUNNER",
    "SCP_HARNESS_ORIGIN",
    "SCP_CHANNELS",
];

pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// the settings as `config.json` and the environment give them now
pub fn current_config(env: &Env) -> BgConfig {
    bg_config(env, &config_file(env))
}

fn config_file(env: &Env) -> Json {
    let set = |key: &str| env.get(key).filter(|value| !value.is_empty());
    let base = set("XDG_CONFIG_HOME")
        .cloned()
        .or_else(|| set("HOME").map(|home| format!("{home}/.config")));
    let path = base.map(|base| Path::new(&base).join("scp/config.json"));
    path.and_then(|path| read_owned_file(&path.to_string_lossy()).ok())
        .and_then(|text| Json::parse(text.as_bytes()))
        .unwrap_or(Json::Obj(Vec::new()))
}

/// how one command ended: its exit code, None when a signal, a limit or a failed start ended it, and its stdout then its stderr
pub struct Ran {
    pub code: Option<i32>,
    pub out: String,
}

impl Ran {
    /// the first line of its output, else its exit code
    pub fn reason(&self) -> String {
        let line = first_line(&self.out);
        if !line.is_empty() {
            return line;
        }
        match self.code {
            Some(code) => format!("exit {code}"),
            None => "exit null".into(),
        }
    }
}

/// reads `stream` into `out`; false once it passed the limit
async fn capped<R: AsyncRead + Unpin>(stream: Option<R>, out: &RefCell<Vec<u8>>) -> bool {
    let Some(mut stream) = stream else {
        return true;
    };
    let mut chunk = [0; 8192];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return true,
            Ok(read) => {
                let mut out = out.borrow_mut();
                let room = OUTPUT_MAX - out.len();
                out.extend_from_slice(&chunk[..read.min(room)]);
                if read > room {
                    return false;
                }
            }
        }
    }
}

/// signals the child at `pid`, which the caller has not reaped
fn signal(pid: Option<i32>, signal: i32) {
    if let Some(pid) = pid {
        // SAFETY: the caller has not reaped the child, so its pid is still its own
        unsafe { libc::kill(pid, signal) };
    }
}

/// runs `bin` with `args`, never through a shell, as Node's `execFile` does: its exit code, None for a signal, a failed start or more than
/// 4 MiB on either stream. Past `timeout_ms` a running child gets SIGTERM, then SIGKILL once `KILL_GRACE` passes; a child that already
/// exited is never signalled, and its code stands though a process it left behind holds its pipes. It returns only once the child is reaped
pub async fn exec(bin: &str, args: &[&str], timeout_ms: u64, env: &Env, cwd: Option<&str>) -> Ran {
    let mut command = tokio::process::Command::new(bin);
    command
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let Ok(mut child) = command.spawn() else {
        return Ran {
            code: None,
            out: String::new(),
        };
    };
    let stdin = child.stdin.take();
    let pid = child.id().and_then(|pid| i32::try_from(pid).ok());
    let (out, err) = (RefCell::new(Vec::new()), RefCell::new(Vec::new()));
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let streams = async {
        tokio::join!(
            capped(stdout.map(Pipe::Out), &out),
            capped(stderr.map(Pipe::Err), &err)
        )
    };
    tokio::pin!(streams);
    let wait = child.wait();
    tokio::pin!(wait);
    let deadline = tokio::time::sleep(Duration::from_millis(timeout_ms));
    tokio::pin!(deadline);
    let mut status: Option<Option<i32>> = None;
    let mut drained = false;
    let mut overflow = false;
    let mut timed_out = false;
    while !(drained && status.is_some()) && !(timed_out && status.is_some()) {
        tokio::select! {
            biased;
            exited = &mut wait, if status.is_none() => {
                status = Some(exited.ok().and_then(|exited| exited.code()));
            }
            (whole_out, whole_err) = &mut streams, if !drained => {
                drained = true;
                if !(whole_out && whole_err) {
                    overflow = true;
                    if status.is_none() {
                        signal(pid, libc::SIGTERM);
                    }
                }
            }
            () = &mut deadline, if !timed_out => {
                timed_out = true;
                if status.is_some() {
                    continue;
                }
                signal(pid, libc::SIGTERM);
                let ended = tokio::time::timeout(KILL_GRACE, &mut wait).await;
                let exited = match ended {
                    Ok(exited) => exited,
                    Err(_) => {
                        signal(pid, libc::SIGKILL);
                        (&mut wait).await
                    }
                };
                status = Some(exited.ok().and_then(|exited| exited.code()));
            }
        }
    }
    if !drained {
        let _ = tokio::time::timeout(DRAIN_GRACE, &mut streams).await;
    }
    drop(stdin);
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.borrow()),
        String::from_utf8_lossy(&err.borrow())
    );
    Ran {
        code: status.flatten().filter(|_| !overflow),
        out: text,
    }
}

/// either captured stream of a child
enum Pipe {
    Out(tokio::process::ChildStdout),
    Err(tokio::process::ChildStderr),
}

impl AsyncRead for Pipe {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Pipe::Out(pipe) => Pin::new(pipe).poll_read(context, buffer),
            Pipe::Err(pipe) => Pin::new(pipe).poll_read(context, buffer),
        }
    }
}

fn first_line(text: &str) -> String {
    let line = js_trim(text).split('\n').next().unwrap_or_default();
    let mut left = 200;
    line.chars()
        .filter(|c| !matches!(*c, '\u{0}'..='\u{1f}' | '\u{7f}'))
        .take_while(|c| {
            let units = c.len_utf16();
            let fits = units <= left;
            left = left.saturating_sub(units);
            fits
        })
        .collect()
}

fn executable(path: &Path) -> bool {
    let Ok(text) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: access only reads the path it is given
    let allowed = unsafe { libc::access(text.as_ptr(), libc::X_OK) } == 0;
    allowed && std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

fn which_on_path(name: &str, env: &Env) -> Option<String> {
    env.get("PATH")?
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(name))
        .find(|path| executable(path))
        .map(|path| path.to_string_lossy().into_owned())
}

pub struct Claude {
    pub bin: String,
    pub env: Env,
}

/// the `claude` on PATH, with the environment it runs in: the caller's, without a launcher's identity or a wake request
pub fn claude_of(env: &Env) -> Option<Claude> {
    let bin = which_on_path("claude", env)?;
    let env = env
        .iter()
        .filter(|(key, _)| {
            !LAUNCHER_IDENTITY.contains(&key.as_str()) && !key.starts_with("SCP_WAKE_")
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    Some(Claude { bin, env })
}

impl Claude {
    pub async fn act(&self, args: &[&str], cwd: Option<&str>) -> Ran {
        exec(&self.bin, args, ACT_TIMEOUT_MS, &self.env, cwd).await
    }

    /// `claude agents --json [--all]`; None when it failed
    pub async fn list(&self, all: bool) -> Option<Vec<Entry>> {
        let args: &[&str] = if all {
            &["agents", "--json", "--all"]
        } else {
            &["agents", "--json"]
        };
        let run = exec(&self.bin, args, LIST_TIMEOUT_MS, &self.env, None).await;
        if run.code != Some(0) {
            return None;
        }
        match Json::parse(run.out.as_bytes())? {
            Json::Arr(items) => Some(
                items
                    .into_iter()
                    .filter(|item| matches!(item, Json::Obj(_) | Json::Arr(_)))
                    .map(Entry::new)
                    .collect(),
            ),
            _ => None,
        }
    }

    async fn entry(&self, id: &str) -> Option<Entry> {
        self.list(true)
            .await?
            .into_iter()
            .find(|one| one.id.as_deref() == Some(id))
    }

    /// the process table, `ps -Ao pid=,ppid=,lstart=,args=`; None when it cannot be read
    pub async fn ps(&self) -> Option<String> {
        let mut env = self.env.clone();
        env.insert("LC_ALL".into(), "C".into());
        let run = exec(
            "ps",
            &["-Ao", "pid=,ppid=,lstart=,args="],
            LIST_TIMEOUT_MS,
            &env,
            None,
        )
        .await;
        (run.code == Some(0)).then_some(run.out)
    }

    /// this process and its ancestors; None when the process table cannot be read
    pub async fn ancestors(&self) -> Option<HashSet<i64>> {
        let run = exec(
            "ps",
            &["-Ao", "pid=,ppid="],
            LIST_TIMEOUT_MS,
            &self.env,
            None,
        )
        .await;
        (run.code == Some(0)).then(|| ancestors_of(&run.out, i64::from(std::process::id())))
    }
}

/// the broker over its socket as the human: `agents`, and `hibernate` with an endpoint, which also runs a due waker
pub struct Port {
    client: Client,
}

impl Port {
    pub async fn open(env: &Env) -> Result<Port, CallError> {
        let client = connect_broker(&relay_dir(env), None).await?;
        let mut hello = Map::new();
        hello.insert("human".into(), Value::Bool(true));
        hello.insert(
            "tty".into(),
            Value::Bool(crate::open::terminal_attached(false)),
        );
        hello.insert("cwd".into(), Value::from(safe_cwd()));
        hello.insert("brief".into(), Value::Bool(true));
        match client.hello(hello).await {
            Ok(_) => Ok(Port { client }),
            Err(error) => {
                client.close();
                Err(error)
            }
        }
    }

    pub fn close(&self) {
        self.client.close();
    }

    pub async fn agents(&self) -> Result<Vec<Agent>, String> {
        let line = self
            .client
            .request_line("agents", json!({}))
            .await
            .map_err(|error| error.message().to_owned())?;
        let reply = Json::parse(&line)
            .ok_or_else(|| "the relay broker sent a line that is not JSON".to_owned())?;
        let agents = reply.get("result").and_then(|result| result.get("agents"));
        Ok(agents
            .map(Json::items)
            .unwrap_or_default()
            .iter()
            .map(Agent::new)
            .collect())
    }

    /// the broker refuses the call when the address no longer names the planned endpoint; one that ignores `id` is caught after
    async fn request(
        &self,
        agent: &Agent,
        wake: &str,
        reference: Option<&str>,
    ) -> Result<(), String> {
        let mut params = json!({"endpoint": agent.address, "id": agent.id, "wake": wake});
        if let Some(reference) = reference {
            params["ref"] = Value::from(reference);
        }
        let result = self
            .client
            .request("hibernate", params)
            .await
            .map_err(|error| error.message().to_owned())?;
        let id = result
            .get("endpoint")
            .and_then(|endpoint| endpoint.get("id"));
        if id.and_then(Value::as_str) != Some(agent.id.as_str()) {
            return Err(format!("{} is another endpoint now", agent.address));
        }
        Ok(())
    }

    pub async fn hibernate(&self, agent: &Agent, reference: &str) -> Result<(), String> {
        self.request(agent, PROVIDER, Some(reference)).await
    }

    pub async fn unhibernate(&self, agent: &Agent) -> Result<(), String> {
        self.request(agent, "none", None).await
    }

    /// the waker runs at once when a message is due
    async fn kick(&self, agent: &Agent, reference: &str) -> Result<(), String> {
        self.hibernate(agent, reference).await
    }

    async fn current(&self, agent: &Agent) -> Result<Option<Agent>, String> {
        Ok(self
            .agents()
            .await?
            .into_iter()
            .find(|one| one.id == agent.id))
    }
}

fn later(now: Option<&str>, then: Option<&str>) -> bool {
    now.is_some_and(|now| !now.is_empty() && then.is_none_or(|then| date_ms(now) > date_ms(then)))
}

/// the session got mail or did work since `then` (unread mail it already had is no change), gained live workers, lost its parent, or is gone
fn changed(agents: &[Agent], then: &Agent) -> bool {
    let Some(now) = agents.iter().find(|one| one.id == then.id) else {
        return true;
    };
    (now.unread && !then.unread)
        || later(Some(&now.worked_at), Some(&then.worked_at))
        || later(now.mail_at.as_deref(), then.mail_at.as_deref())
        || (then.parent.is_some() && now.parent.as_deref().is_none_or(str::is_empty))
        || Index::new(agents).live_children(now) > 0.0
}

/// what one run acts with
pub struct Work<'a> {
    pub claude: &'a Claude,
    pub env: &'a Env,
    pub port: &'a Port,
}

/// why the planned worker may no longer be stopped or removed: it changed since the plan, a `claude attach` holds it now, or a command
/// still runs under its process
async fn moved(target: &Target, work: &Work<'_>) -> Result<Option<String>, String> {
    let agents = work.port.agents().await?;
    if changed(&agents, &target.agent) {
        return Ok(Some("it got work".into()));
    }
    let Some(table) = work.claude.ps().await else {
        return Ok(Some("ps failed, so attached sessions are unknown".into()));
    };
    if attached_to(&target.entry, &attach_targets(&table)) {
        return Ok(Some("attached".into()));
    }
    let Some(pid) = target.entry.pid.map(|pid| pid as i64) else {
        return Ok(None);
    };
    let unread = agents
        .iter()
        .find(|one| one.id == target.agent.id)
        .is_some_and(|one| one.unread);
    if only_polls_inbox(&table, pid, None) && unread {
        return Ok(Some("polling its inbox, which has unread mail".into()));
    }
    Ok(commands_of(Some(&table), pid))
}

/// None while `claude agents` still shows the session idle with the planned pid, or busy only polling its inbox by a process table read
/// after it, right before `claude stop`; a turn that starts in the moment between these reads and the stop is not caught
async fn still_idle(target: &Target, work: &Work<'_>) -> Option<String> {
    let listed = work.claude.entry(&target.id).await;
    let status = |one: &Entry| one.status.clone().unwrap_or_else(|| "busy".into());
    let pid = target.entry.pid;
    let Some(one) = listed
        .as_ref()
        .filter(|one| pid.is_some() && one.pid == pid)
    else {
        let shown = listed.as_ref().map_or("unlisted".into(), status);
        return Some(format!("claude shows it {shown}"));
    };
    match one.status.as_deref() {
        Some("idle") => None,
        Some("busy") => {
            let after = date_ms(&target.agent.worked_at);
            let pid = pid.unwrap_or(0.0) as i64;
            let table = work.claude.ps().await;
            let waiting = table.is_some_and(|table| only_polls_inbox(&table, pid, Some(after)));
            (!waiting).then(|| "claude shows it busy".to_owned())
        }
        _ => Some(format!("claude shows it {}", status(one))),
    }
}

/// None while `claude agents` lists the session with no process, read right before `claude rm`
async fn still_stopped(claude: &Claude, id: &str) -> Option<String> {
    let Some(listed) = claude.entry(id).await else {
        return Some("claude agents failed or no longer lists it".into());
    };
    listed.pid.map(|_| {
        format!(
            "claude shows it running again ({})",
            listed.status.as_deref().unwrap_or("busy")
        )
    })
}

fn resumable(entry: &Entry) -> Result<(&str, &str), String> {
    entry
        .session_id
        .as_deref()
        .filter(|id| session_id(id))
        .zip(entry.cwd.as_deref().filter(|cwd| !cwd.is_empty()))
        .ok_or_else(|| "no session id or cwd".to_owned())
}

/// hibernates the worker, checks nothing reached it, stops it, then brings it back at once when a message raced in: through its waker
/// while that message is unread, else by respawning it awake, since its shim may have handed the message to the session just before the
/// stop. Unread mail it already had at the plan never brings it back
async fn stop_worker(target: &Target, work: &Work<'_>, host: &Host) -> Result<(), String> {
    let Target {
        id, entry, agent, ..
    } = target;
    let Work { claude, env, port } = work;
    let (session, cwd) = resumable(entry)?;
    let reference = revive_ref(session, cwd, entry.name.as_deref());
    let previous = read_state(env, id);
    let fresh = || {
        state_over(
            Json::Obj(Vec::new()),
            session,
            cwd,
            entry.name.as_deref(),
            Some(&agent.handle),
        )
    };
    let restore = || match &previous {
        Some(BgState(state)) => write_state(env, id, state),
        None => remove_state(env, id),
    };
    write_state(env, id, &fresh())?;
    port.hibernate(agent, &reference).await?;
    let why = match moved(target, work).await? {
        Some(why) => Some(why),
        None => still_idle(target, work).await,
    };
    if let Some(why) = why {
        port.unhibernate(agent).await?;
        restore()?;
        return Err(why);
    }
    let stopped = claude.act(&["stop", id], None).await;
    if stopped.code != Some(0) {
        port.unhibernate(agent).await?;
        restore()?;
        return Err(format!("claude stop failed: {}", stopped.reason()));
    }
    let mut state = fresh();
    state.set("stoppedAt", Json::Num(now_ms()));
    write_state(env, id, &state)?;
    let Some(after) = port.current(agent).await? else {
        return Ok(());
    };
    if later(after.unread_at.as_deref(), agent.mail_at.as_deref()) {
        port.kick(agent, &reference).await?;
        return Err("mail raced the stop, so its waker brings it back".into());
    }
    if !later(after.mail_at.as_deref(), agent.mail_at.as_deref()) {
        if after.hibernate.as_deref() != Some(PROVIDER) {
            port.hibernate(agent, &reference).await?;
        }
        return Ok(());
    }
    port.unhibernate(agent).await?;
    if let Some(record) = &target.record {
        arm_ticket(&record.file, None, env, None, host);
    }
    let respawned = claude.act(&["respawn", id], None).await;
    if respawned.code == Some(0) {
        return Err("mail raced the stop, so it was respawned".into());
    }
    port.hibernate(agent, &reference).await?;
    Err(format!(
        "mail raced the stop and claude respawn failed: {}",
        respawned.reason()
    ))
}

/// the state a removal starts from, its last removal and refusal dropped
fn before_removal(env: &Env, id: &str) -> Json {
    read_state(env, id).map_or(Json::Obj(Vec::new()), |BgState(state)| {
        without(&state, &["removedAt", "rmRefused"])
    })
}

fn refused_state(state: &Json, reason: &str) -> Json {
    let mut refused = state.clone();
    refused.set(
        "rmRefused",
        Json::object(vec![
            ("at", Json::Num(now_ms())),
            ("reason", Json::str(reason)),
        ]),
    );
    refused
}

async fn remove_worker(
    target: &Target,
    live: bool,
    work: &Work<'_>,
    host: &Host,
) -> Result<(), String> {
    let Target {
        id, entry, agent, ..
    } = target;
    let Work { claude, env, port } = work;
    let (session, cwd) = resumable(entry)?;
    let name = entry.name.as_deref();
    let reference = revive_ref(session, cwd, name);
    if live {
        stop_worker(target, work, host).await?;
    } else {
        let previous = read_state(env, id).map_or(Json::Obj(Vec::new()), |state| state.0);
        write_state(
            env,
            id,
            &state_over(previous, session, cwd, name, Some(&agent.handle)),
        )?;
        if agent.hibernate.as_deref() != Some(PROVIDER) {
            port.hibernate(agent, &reference).await?;
        }
    }
    let why = match moved(target, work).await? {
        Some(why) => Some(why),
        None => still_stopped(claude, id).await,
    };
    if let Some(why) = why {
        port.kick(agent, &reference).await?;
        return Err(why);
    }
    let state = state_over(
        before_removal(env, id),
        session,
        cwd,
        name,
        Some(&agent.handle),
    );
    write_state(env, id, &state)?;
    let removed = claude.act(&["rm", id], None).await;
    if removed.code != Some(0) {
        let reason = removed.reason();
        write_state(env, id, &refused_state(&state, &reason))?;
        return Err(format!("claude rm refused: {reason}"));
    }
    let mut kept = without(&state, &["rmRefused"]);
    kept.set("removedAt", Json::Num(now_ms()));
    write_state(env, id, &kept)?;
    let after = port.current(agent).await?;
    if later(
        after.as_ref().and_then(|one| one.unread_at.as_deref()),
        agent.mail_at.as_deref(),
    ) {
        port.kick(agent, &reference).await?;
    }
    Ok(())
}

/// removes a stopped session whose endpoint is gone from Claude's list: no hibernation to keep and no waker to run, so it only checks the
/// endpoint is still gone, no `claude attach` took it and Claude still lists it stopped, then runs `claude rm`; its transcript stays for
/// a `claude --resume` by hand
async fn remove_orphan(
    id: &str,
    entry: &Entry,
    record: &BgRecord,
    work: &Work<'_>,
) -> Result<(), String> {
    let Work { claude, env, port } = work;
    let (session, cwd) = resumable(entry)?;
    let agents = port.agents().await?;
    if Index::new(&agents)
        .endpoint_of(entry, Some(record))
        .is_some()
    {
        return Err("it has an endpoint again".into());
    }
    let Some(table) = claude.ps().await else {
        return Err("ps failed, so attached sessions are unknown".into());
    };
    if attached_to(entry, &attach_targets(&table)) {
        return Err("attached".into());
    }
    if let Some(why) = still_stopped(claude, id).await {
        return Err(why);
    }
    let state = state_over(
        before_removal(env, id),
        session,
        cwd,
        entry.name.as_deref(),
        None,
    );
    let removed = claude.act(&["rm", id], None).await;
    if removed.code != Some(0) {
        let reason = removed.reason();
        write_state(env, id, &refused_state(&state, &reason))?;
        return Err(format!("claude rm refused: {reason}"));
    }
    let mut kept = state;
    kept.set("removedAt", Json::Num(now_ms()));
    write_state(env, id, &kept)
}

pub struct Outcome {
    pub action: Action,
    pub failed: Option<String>,
}

async fn act(action: &Action, work: &Work<'_>, host: &Host) -> Result<(), String> {
    let lock = lock_session(work.env, action.id())?;
    if lock.is_none() {
        return Err("another claude-bg run is acting on it".into());
    }
    match action {
        Action::Unhibernate(target) => work.port.unhibernate(&target.agent).await,
        Action::Orphan { id, entry, record } => remove_orphan(id, entry, record, work).await,
        Action::Stop(target) => stop_worker(target, work, host).await,
        Action::Remove { target, live } => remove_worker(target, *live, work, host).await,
        Action::Keep { .. } => Ok(()),
    }
}

/// runs each action under its session's lock, the next one whatever became of the last
pub async fn apply(actions: Vec<Action>, work: &Work<'_>, host: &Host) -> Vec<Outcome> {
    let mut outcomes = Vec::new();
    for action in actions {
        let failed = act(&action, work, host).await.err();
        outcomes.push(Outcome { action, failed });
    }
    outcomes
}

pub fn acts(actions: Vec<Action>) -> Vec<Action> {
    actions
        .into_iter()
        .filter(|action| !matches!(action, Action::Keep { .. }))
        .collect()
}

/// a Claude Code endpoint whose hooks named its session: it may run in a background session no record covers
fn claude_agent(agent: &Agent) -> bool {
    agent.harness.as_deref() == Some("claude-code") && agent.harness_session.is_some()
}

fn unrecorded(agent: &Agent, state: &TaskState, records: &Records) -> bool {
    let id = agent
        .harness_session
        .as_ref()
        .and_then(|session| state.sessions.get(session));
    claude_agent(agent) && id.is_none_or(|id| !records.contains_key(id))
}

/// what deciding whether a run has work reads
struct Scan<'a> {
    records: &'a Records,
    handles: HashMap<&'a str, &'a str>,
    config: BgConfig,
    env: &'a Env,
}

impl Scan<'_> {
    fn id_of<'s>(&'s self, agent: &Agent, state: &'s TaskState) -> Option<&'s str> {
        agent
            .harness_session
            .as_ref()
            .and_then(|session| state.sessions.get(session))
            .map(String::as_str)
            .or_else(|| self.handles.get(agent.handle.as_str()).copied())
    }

    fn orphaned(&self, agents: &[Agent], state: &TaskState) -> bool {
        let index = Index::new(agents);
        self.config.remove != RemoveMode::Never
            && state.stopped.iter().any(|(id, entry)| {
                let record = self.records.get(id);
                record.is_some_and(|record| record.parented)
                    && index.endpoint_of(entry, record).is_none()
                    && removable(read_state(self.env, id).as_ref(), now_ms())
            })
    }

    fn is_due(&self, agents: &[Agent], state: &TaskState) -> bool {
        let index = Index::new(agents);
        let due = agents.iter().any(|agent| {
            let Some(id) = self
                .id_of(agent, state)
                .filter(|id| self.records.contains_key(*id))
            else {
                return unrecorded(agent, state, self.records)
                    && agent.hibernate.as_deref() == Some(PROVIDER)
                    && agent.connections > 0.0;
            };
            let stopped = state.stopped.get(id);
            let mut config = self.config;
            config.remove =
                remove_mode_of(&self.config, stopped.and_then(|entry| entry.cwd.as_deref()));
            maybe_due(
                agent,
                &index,
                &Due {
                    state: &|| read_state(self.env, id),
                    config,
                    now: now_ms(),
                    recorded: true,
                    stopped: stopped.is_some(),
                },
            )
        });
        due || self.orphaned(agents, state)
    }
}

/// one run of the broker's task: stops and removes idle workers by the configured policy, read again on each run
pub async fn run_bg_task(
    state: &mut TaskState,
    port: &Port,
    env: &Env,
    host: &Host,
) -> Result<(), String> {
    let records = read_records(env);
    let agents = port.agents().await?;
    if records.is_empty()
        && !agents
            .iter()
            .any(|agent| unrecorded(agent, state, &records))
    {
        return Ok(());
    }
    let scan = Scan {
        records: &records,
        handles: records
            .iter()
            .filter_map(|(id, record)| Some((record.handle.as_deref()?, id.as_str())))
            .collect(),
        config: current_config(env),
        env,
    };
    let unseen = records.keys().any(|id| !state.seen.contains(id));
    if state.listed && !unseen && !scan.is_due(&agents, state) {
        return Ok(());
    }
    let Some(claude) = claude_of(env) else {
        return Ok(());
    };
    let Some(entries) = claude.list(true).await else {
        return Ok(());
    };
    state.listed = true;
    state.seen = records.keys().cloned().collect();
    state.sessions.clear();
    state.stopped.clear();
    for entry in &entries {
        let id = entry
            .id
            .as_deref()
            .filter(|id| entry.background() && short_id(id));
        let session = entry.session_id.as_deref().filter(|id| !id.is_empty());
        if let (Some(id), Some(session)) = (id, session) {
            state.sessions.insert(session.to_owned(), id.to_owned());
            if entry.pid.is_none() && records.contains_key(id) {
                state.stopped.insert(id.to_owned(), entry.clone());
            }
        }
    }
    let agents = port.agents().await?;
    if !scan.is_due(&agents, state) {
        return Ok(());
    }
    let table = claude.ps().await;
    let own_pids = claude.ancestors().await;
    let (Some(table), Some(own_pids)) = (table, own_pids) else {
        return Ok(());
    };
    let agents = port.agents().await?;
    let actions = plan(&PlanInput {
        entries: &entries,
        agents: &agents,
        records: &records,
        states: &read_states(env, state.sessions.values().map(String::as_str)),
        attached: &attach_targets(&table),
        processes: Some(&table),
        now: now_ms(),
        config: scan.config,
        older_than_s: None,
        stop_only: false,
        retry_refused: false,
        own_sessions: &HashSet::new(),
        own_pids: &own_pids,
    });
    let work = Work {
        claude: &claude,
        env,
        port,
    };
    for Outcome { action, failed } in apply(acts(actions), &work, host).await {
        let id = action.id().to_owned();
        let ok = failed.is_none();
        let unhibernate = matches!(action, Action::Unhibernate(_));
        if !unhibernate || !ok {
            let verb = if ok { action.verb() } else { "kept" };
            let why = failed.map_or_else(String::new, |why| format!(": {why}"));
            term::err(&format!(
                "{CLI_NAME} claude: {verb} {id} ({}){why}",
                action.place()
            ));
        }
        if unhibernate || !records.contains_key(&id) {
            continue;
        }
        match &action {
            Action::Stop(target) if ok => {
                state.stopped.insert(id, target.entry.without_pid());
            }
            Action::Remove { target, .. } if !ok => {
                state.stopped.insert(id, target.entry.without_pid());
            }
            Action::Remove { .. } | Action::Orphan { .. } if ok => {
                state.stopped.shift_remove(&id);
            }
            _ => {}
        }
    }
    Ok(())
}

/// a command that names an absolute path to no executable file, as a mount's native swarm is once an upgrade or uninstall removed it
fn gone_command(command: Option<&Json>) -> bool {
    command
        .and_then(Json::as_str)
        .is_some_and(|command| command.starts_with('/') && !executable(Path::new(command)))
}

/// the mount a session whose command is gone runs instead: the native `swarm` under `SCP_NATIVE=1` or `mcp`, told the words that start
/// the CLI when there is one, else the CLI, else this executable
fn fresh_mount(
    words: Vec<String>,
    env: &Env,
    host: &Host,
) -> (Vec<String>, Vec<(&'static str, String)>) {
    let exe = std::env::current_exe()
        .map(|exe| exe.to_string_lossy().into_owned())
        .unwrap_or_else(|_| CLI_NAME.to_owned());
    let cli = scp_mcp::spawn::named_launcher(env).or_else(|| (host.beside)(env));
    let mode = env.get("SCP_NATIVE").map(String::as_str);
    let tail = std::iter::once("mcp".to_owned()).chain(words);
    if !matches!(mode, Some("1" | "mcp")) {
        let launch = cli.unwrap_or_else(|| vec![exe]);
        return (launch.into_iter().chain(tail).collect(), Vec::new());
    }
    let named = env.get("SCP_SWARM_BIN").filter(|bin| !bin.is_empty());
    let bin = named
        .filter(|bin| executable(Path::new(bin)))
        .cloned()
        .unwrap_or(exe);
    let mut vars = vec![(
        "SCP_NATIVE",
        if mode == Some("mcp") { "mcp" } else { "1" }.to_owned(),
    )];
    if named.is_some() {
        vars.push(("SCP_SWARM_BIN", bin.clone()));
    }
    if let Some(cli) = cli {
        let words = Json::Arr(cli.into_iter().map(Json::str).collect());
        vars.push(("SCP_CLI_ARGV", words.compact()));
    }
    (std::iter::once(bin).chain(tail).collect(), vars)
}

fn plain_word(word: &Json) -> String {
    word.as_str().map_or_else(|| word.compact(), str::to_owned)
}

/// the scp server of `config` with the ticket and origin set; None when nothing changes
fn armed_server(
    scp: &Json,
    ticket: Option<&str>,
    origin: Option<&str>,
    env: &Env,
    host: &Host,
) -> Option<Json> {
    let vars = match scp.get("env") {
        Some(vars @ Json::Obj(_)) => vars.clone(),
        _ => Json::Obj(Vec::new()),
    };
    let stale = gone_command(scp.get("command"));
    let pinned = env.get("SCP_NATIVE").is_some_and(|mode| mode == "mcp")
        && vars.get("SCP_NATIVE").and_then(Json::as_str) == Some("1");
    let same = |key: &str, want: Option<&str>| match vars.get(key) {
        None => want.is_none(),
        Some(value) => value.as_str().is_some() && value.as_str() == want,
    };
    if same("SCP_WAKE_TICKET", ticket) && same("SCP_HARNESS_ORIGIN", origin) && !stale && !pinned {
        return None;
    }
    let mut armed = without(&vars, &["SCP_WAKE_TICKET", "SCP_HARNESS_ORIGIN"]);
    if pinned {
        armed.set("SCP_NATIVE", Json::str("mcp"));
    }
    if let Some(ticket) = ticket {
        armed.set("SCP_WAKE_TICKET", Json::str(ticket));
    }
    if let Some(origin) = origin {
        armed.set("SCP_HARNESS_ORIGIN", Json::str(origin));
    }
    let mut server = scp.clone();
    if stale {
        let mounted: Vec<String> = std::iter::once(scp.get("command"))
            .flatten()
            .chain(scp.get("args").map(Json::items).unwrap_or_default())
            .map(plain_word)
            .collect();
        let words = match mounted.iter().position(|word| word == "mcp") {
            Some(at) => mounted[at + 1..].to_vec(),
            None => CLAUDE_MCP.iter().map(|word| (*word).to_owned()).collect(),
        };
        let (argv, mount) = fresh_mount(words, env, host);
        server.set("command", Json::str(argv[0].clone()));
        server.set("args", Json::Arr(argv[1..].iter().map(Json::str).collect()));
        armed = without(&armed, &MOUNT_VARS);
        for (key, value) in mount {
            armed.set(key, Json::Str(value));
        }
    }
    server.set("env", armed);
    Some(server)
}

/// puts the run's wake ticket in the scp server env of a session's MCP config, or takes a stale one out, so the revived session's shim
/// takes its endpoint back with it; a server whose command is gone runs this CLI's mount instead, and under SCP_NATIVE=mcp a saved
/// SCP_NATIVE=1 becomes mcp. False when the config cannot be read or written
pub fn arm_ticket(
    file: &str,
    ticket: Option<&str>,
    env: &Env,
    origin: Option<&str>,
    host: &Host,
) -> bool {
    let Some(mut config) = std::fs::read(file)
        .ok()
        .and_then(|bytes| Json::parse(String::from_utf8_lossy(&bytes).as_bytes()))
    else {
        return false;
    };
    let Some(mut servers) = config.get("mcpServers").cloned() else {
        return false;
    };
    let Some(scp @ Json::Obj(_)) = servers.get("scp") else {
        return false;
    };
    let Some(armed) = armed_server(scp, ticket, origin, env, host) else {
        return true;
    };
    servers.set("scp", armed);
    config.set("mcpServers", servers);
    write_private(Path::new(file), &format!("{}\n", config.pretty())).is_ok()
}

/// a resume Claude Code brought back under a new short id `moved`: its `<moved>.json` links to the session file the resume ran with, and
/// its state carries the new session id, so the policy stops it again and its next wake resumes the new session
pub async fn follow_resume(
    env: &Env,
    claude: &Claude,
    moved: &str,
    state: &Json,
    record: Option<&BgRecord>,
) -> Result<(), String> {
    if let Some(record) = record {
        let link = bg_dir(env).join(format!("{moved}.json"));
        let _ = std::fs::remove_file(&link);
        if let Some(name) = Path::new(&record.file).file_name() {
            let _ = std::os::unix::fs::symlink(name, &link);
        }
    }
    let listed = claude.list(true).await.unwrap_or_default();
    let session = listed
        .into_iter()
        .find(|one| one.id.as_deref() == Some(moved) && one.background())
        .and_then(|one| one.session_id)
        .filter(|session| session_id(session) && session.starts_with(moved));
    if let Some(session) = session {
        let mut state = state.clone();
        state.set("sessionId", Json::Str(session));
        write_state(env, moved, &state)?;
    }
    Ok(())
}

/// whether Claude Code's transcripts are readable and none of them is the session's: its transcript is gone, so no resume can bring it back
pub fn transcript_gone(env: &Env, session: &str) -> bool {
    let root = match env.get("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        Some(dir) => Path::new(dir).join("projects"),
        None => {
            let home = env
                .get("HOME")
                .filter(|home| !home.is_empty())
                .cloned()
                .unwrap_or_else(home_dir);
            Path::new(&home).join(".claude/projects")
        }
    };
    let Ok(projects) = std::fs::read_dir(&root) else {
        return false;
    };
    !projects
        .flatten()
        .any(|project| project.path().join(format!("{session}.jsonl")).exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(script: &str, timeout_ms: u64) -> (Ran, Duration) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let env: Env = std::env::vars().collect();
        let started = std::time::Instant::now();
        let ran = runtime.block_on(exec("/bin/sh", &["-c", script], timeout_ms, &env, None));
        (ran, started.elapsed())
    }

    #[test]
    fn an_exit_stands_while_a_process_it_left_holds_the_pipes() {
        let (ran, took) = run("echo hi; sleep 2 & exit 0", 300);
        assert_eq!(ran.code, Some(0));
        assert!(ran.out.starts_with("hi"));
        assert!(took < Duration::from_millis(1800), "{took:?}");
        let (ran, _) = run("exit 3", 5_000);
        assert_eq!(ran.code, Some(3));
    }

    #[test]
    fn a_timed_out_child_finishes_its_term_handler_before_it_is_reaped() {
        let dir = std::env::temp_dir().join(format!("scp-exec-term-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let script = format!(
            "trap 'sleep 0.3; echo done > {}; exit 7' TERM; while :; do sleep 0.05; done",
            dir.display()
        );
        let (ran, took) = run(&script, 300);
        assert_eq!(std::fs::read_to_string(&dir).unwrap().trim(), "done");
        assert_eq!(ran.code, Some(7));
        assert!(took < KILL_GRACE, "{took:?}");
        std::fs::remove_file(&dir).unwrap();
    }

    #[test]
    fn a_child_that_ignores_term_is_killed_after_the_grace() {
        let (ran, took) = run("trap '' TERM; while :; do sleep 0.05; done", 200);
        assert_eq!(ran.code, None);
        assert!(took >= KILL_GRACE && took < KILL_GRACE * 2, "{took:?}");
    }

    #[test]
    fn output_past_the_cap_fails_the_run() {
        let (ran, _) = run("head -c 5000000 /dev/zero", 10_000);
        assert_eq!(ran.code, None);
        assert_eq!(ran.out.len(), OUTPUT_MAX);
    }
}
