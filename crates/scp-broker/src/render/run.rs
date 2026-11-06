//! One hook run: who the hook speaks for, what it posts, and the reply it offers.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use async_trait::async_trait;
use scp_core::address::valid_handle;
use scp_core::protocol::{ErrorCode, LIMITS};
use scp_mcp::Membership;
use scp_mcp::identity::{
    CODEX_THREAD_KEY, IdentityInput, cowork_live, detect_harness, field as claim_field,
    hook_format, joins_only, normalize_harness, relay_identity, session_key,
};
use scp_mcp::membership::membership;
use scp_mcp::ps::{Parent, PsCommTable, PsEntry, app_server, harness_at, harness_pid, process_key};
use scp_mcp::tools::{js, truthy};
use serde_json::{Map, Value, json};

use super::text::*;
use crate::core::now_ms;
use crate::hooks::HookProc;
use crate::proto::RpcError;

type Json = Map<String, Value>;
type Claim = Map<String, Value>;

/// a session end's deadline from process start: its handler times out after 2 s
pub const SESSION_END_DEADLINE_MS: f64 = 1800.0;
/// what a hook keeps for its round trip, printing and confirming once connected
pub const HOOK_AFTER_CONNECT_MS: f64 = 1000.0;
/// the hook's deadline past the end of its push wait
pub const PUSH_PRINT_MS: f64 = 1000.0;
/// inject is not asked for with less of the deadline left than this
pub const INJECT_MIN_MS: f64 = 300.0;
/// a reply that arrives with less left than this is not printed
pub const CONFIRM_MIN_MS: f64 = 150.0;
const SUBAGENT_HARNESSES: [&str; 2] = ["claude-code", "codex"];

/// a broker connection as the renderer uses it
#[async_trait]
pub trait Rpc: Send + Sync {
    async fn hello(&self, params: Json) -> Result<Value, RpcError>;
    async fn request(&self, method: &str, params: Json) -> Result<Value, RpcError>;
}

/// what runs a hook: its connections, deadline and output
#[async_trait]
pub trait Host: Send + Sync {
    async fn connect(&self) -> Arc<dyn Rpc>;
    /// moves the deadline to `ms` past the hook's origin
    fn deadline(&self, ms: f64);
    /// ms left before the deadline
    fn remaining(&self) -> f64;
    /// offers the reply; true once all of it went out
    async fn print(&self, text: &str) -> bool;
    fn stopping(&self) -> bool;
    fn allow_write(&self, path: &str) -> bool;
}

/// a hook call's inputs, as the hook binary sent them
#[derive(Debug, Clone)]
pub struct Hook {
    pub args: Vec<String>,
    pub payload: Json,
    pub env: Env,
    pub cwd: String,
    pub state_dir: String,
    /// when the hook process started, epoch ms; deadlines count from it
    pub began: f64,
    pub ppid: i64,
    pub procs: Vec<HookProc>,
    pub harness_pid: Option<i64>,
}

fn map(value: Value) -> Json {
    match value {
        Value::Object(map) => map,
        _ => Json::new(),
    }
}

fn now() -> f64 {
    now_ms() as f64
}

fn set(env: &Env, key: &str) -> bool {
    env.get(key).is_some_and(|v| !v.is_empty())
}

/// a hook's harness: its argument, except that a Claude Code hook Grok runs is grok; without one, the detected harness or `hook`
pub fn hook_harness(argument: Option<&str>, env: &Env) -> String {
    let Some(argument) = argument.filter(|a| !a.is_empty()) else {
        return detect_harness(env).unwrap_or("hook").into();
    };
    let named = normalize_harness(Some(argument), "hook");
    if named == "claude-code" && (set(env, "GROK_SESSION_ID") || set(env, "GROK_HOOK_EVENT")) {
        "grok".into()
    } else {
        named
    }
}

/// a hook's harness pid: $CLAUDE_PID for a Claude Code hook, $OPENCODE_PID for an OpenCode one, else the parent past a shell
pub fn hook_harness_pid(
    env: &Env,
    harness: &str,
    ppid: i64,
    parent_of: &scp_mcp::ps::ParentOf,
) -> i64 {
    let named = if hook_format(harness, harness) == "claude-code" {
        env.get("CLAUDE_PID")
    } else if harness == "opencode" {
        env.get("OPENCODE_PID")
    } else {
        None
    };
    let pid = js_number(named.map(String::as_str));
    if pid.fract() == 0.0 && pid > 1.0 && pid <= 9_007_199_254_740_991.0 {
        return pid as i64;
    }
    harness_pid(ppid, parent_of)
}

/// the claim socket a Claude Code background spare waits on, from its command line
pub fn spare_socket(args: Option<&str>) -> Option<&str> {
    let words: Vec<&str> = args
        .map(|a| a.split(scp_mcp::render::js_space).collect())
        .unwrap_or_default();
    for (i, word) in words.iter().enumerate() {
        if let Some(socket) = word.strip_prefix("--bg-spare=") {
            return (!socket.is_empty()).then_some(socket);
        }
        if *word != "--bg-spare" {
            continue;
        }
        return words
            .get(i + 1)
            .copied()
            .filter(|next| !next.is_empty() && !next.starts_with('-'));
    }
    None
}

/// whether a Claude Code hook runs in a background spare no session has claimed yet
pub fn unclaimed_spare(env: &Env, args: &dyn Fn() -> Option<String>) -> bool {
    if env.get("CLAUDE_CODE_SESSION_KIND").map(String::as_str) != Some("bg") {
        return false;
    }
    let args = args();
    spare_socket(args.as_deref()).is_some_and(|socket| std::path::Path::new(socket).exists())
}

/// the process table the hook binary sent
struct Procs {
    table: Rc<PsCommTable>,
    parents: HashMap<i64, Parent>,
}

impl Procs {
    fn new(procs: &[HookProc]) -> Self {
        let mut table = PsCommTable::new();
        let mut parents = HashMap::new();
        for proc in procs {
            let pid = proc.pid as i64;
            table.insert(
                pid,
                PsEntry {
                    ppid: proc.ppid as i64,
                    start: proc.start.clone().unwrap_or_default(),
                    args: proc.args.clone(),
                },
            );
            parents.insert(
                pid,
                Parent {
                    ppid: proc.ppid as i64,
                    comm: proc.comm.clone().unwrap_or_default(),
                },
            );
        }
        Self {
            table: Rc::new(table),
            parents,
        }
    }

    fn start_of(&self, pid: i64) -> Option<String> {
        self.table
            .get(&pid)
            .map(|e| e.start.clone())
            .filter(|s| !s.is_empty())
    }

    fn args_of(&self, pid: i64) -> Option<String> {
        self.table.get(&pid).map(|e| e.args.clone())
    }

    fn harness_pid(&self, hook: &Hook, harness: &str) -> i64 {
        hook.harness_pid.unwrap_or_else(|| {
            let parents = self.parents.clone();
            hook_harness_pid(&hook.env, harness, hook.ppid, &move |pid| {
                parents.get(&pid).cloned()
            })
        })
    }
}

struct Who<'a> {
    hook: &'a Hook,
    procs: &'a Procs,
    harness: &'a str,
    pid: i64,
    started: Option<String>,
}

impl Who<'_> {
    fn identify(&self, as_: Option<String>, harness_session: Option<String>, cwd: &str) -> Claim {
        let started = self.started.clone();
        let table = self.procs.table.clone();
        let infer = self.procs.table.clone();
        let env = self.hook.env.clone();
        let pid = self.pid;
        relay_identity(&IdentityInput {
            state_dir: Some(self.hook.state_dir.clone()),
            as_,
            harness: Some(self.harness.into()),
            fallback_harness: "hook".into(),
            cwd: cwd.into(),
            env: self.hook.env.clone(),
            harness_pid: Rc::new(move |_| pid),
            infer_harness: Some(Rc::new(move |at| {
                harness_at(at, Some(&infer), &env).map(String::from)
            })),
            start_of: Some(Rc::new(move |_| started.clone())),
            lineage_of: None,
            harness_session,
            t3_hosted: None,
            ps_table: Some(Rc::new(move || Some(table.clone()))),
        })
    }

    fn joined(&self) -> Membership {
        let key = process_key(self.pid, &|_| self.started.clone());
        membership(
            &self.hook.env,
            &session_key(&self.hook.env, &key),
            Some(&self.hook.state_dir),
        )
    }
}

fn handle_of(membership: &Membership) -> Option<String> {
    match membership {
        Membership::Joined(handle) => handle.clone(),
        Membership::Dark(_) => None,
    }
}

/// who a regular hook speaks for, or None when it stays silent
struct Speaker {
    claim: Claim,
    format: String,
}

fn speaker(hook: &Hook, harness: &str, event: &HookEvent, child: bool) -> Option<Speaker> {
    let procs = Procs::new(&hook.procs);
    let pid = procs.harness_pid(hook, harness);
    let who = Who {
        hook,
        procs: &procs,
        harness,
        pid,
        started: procs.start_of(pid),
    };
    let keyed = who.joined();
    let payload = &hook.payload;
    let harness_session = if event.agent.is_some() && !child {
        None
    } else {
        as_string(field(payload, &["session_id", "sessionId"])).map(String::from)
    };
    if hook_format(harness, harness) == "claude-code"
        && unclaimed_spare(&hook.env, &|| procs.args_of(pid))
    {
        return None;
    }
    let cwd = event.cwd.clone().unwrap_or_else(|| hook.cwd.clone());
    let mut claim = who.identify(handle_of(&keyed), harness_session.clone(), &cwd);
    let session = claim_field(&claim, "session").to_string();
    if session.starts_with(CODEX_THREAD_KEY) {
        let joined = membership(&hook.env, &session, Some(&hook.state_dir));
        if let Membership::Dark(_) = joined {
            return None;
        }
        claim = who.identify(handle_of(&joined), harness_session, &cwd);
    } else if let Membership::Dark(_) = keyed {
        return None;
    }
    if !valid_handle(claim_field(&claim, "handle")) {
        return None;
    }
    let format = hook_format(claim_field(&claim, "harness"), harness).to_string();
    if joins_only(&hook.env, &format) {
        claim.insert("join_only".into(), Value::Bool(true));
    }
    let transcript = if payload.contains_key("transcript_path") {
        payload.get("transcript_path")
    } else {
        payload.get("transcriptPath")
    };
    if transcript.is_some_and(Value::is_null)
        && format == "codex"
        && app_server(procs.args_of(pid).as_deref())
    {
        return None;
    }
    Some(Speaker { claim, format })
}

fn wake_speaker(hook: &Hook, harness: &str) -> Option<(Claim, String)> {
    let procs = Procs::new(&hook.procs);
    let pid = procs.harness_pid(hook, harness);
    let who = Who {
        hook,
        procs: &procs,
        harness,
        pid,
        started: procs.start_of(pid),
    };
    let joined = who.joined();
    if let Membership::Dark(_) = joined {
        return None;
    }
    let payload = &hook.payload;
    let harness_session = as_string(field(payload, &["session_id", "sessionId"])).map(String::from);
    let cwd = as_string(payload.get("cwd"))
        .map(String::from)
        .unwrap_or_else(|| hook.cwd.clone());
    let mut claim = who.identify(handle_of(&joined), harness_session, &cwd);
    if !valid_handle(claim_field(&claim, "handle")) {
        return None;
    }
    let format = hook_format(claim_field(&claim, "harness"), harness).to_string();
    if joins_only(&hook.env, &format) {
        claim.insert("join_only".into(), Value::Bool(true));
    }
    Some((claim, format))
}

/// unread messages recounted before printing, so concurrent hooks do not point at messages already shown
async fn more_now(client: &dyn Rpc, injected: &Value) -> i64 {
    let more = int(injected, "more");
    if more == 0 {
        return 0;
    }
    let counted = client
        .request("inject", map(json!({"count": true})))
        .await
        .ok();
    match counted
        .as_ref()
        .and_then(|c| c.get("waiting"))
        .and_then(Value::as_f64)
    {
        Some(waiting) => {
            waiting as i64 + list(injected, "offered").len() as i64
                - list(injected, "messages").len() as i64
        }
        None => more,
    }
}

fn not_found(error: &RpcError) -> bool {
    error
        .data
        .as_ref()
        .is_some_and(|d| d.code == ErrorCode::NotFound)
}

fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

/// posts a hook's activity and offers its context on one connection; only printed replies are confirmed
pub async fn run_hook(hook: &Hook, host: &dyn Host) -> Result<Option<String>, RpcError> {
    let (args, env, payload) = (&hook.args, &hook.env, &hook.payload);
    if has(args, "--cowork-only") && !cowork_live(env) {
        return Ok(None);
    }
    let block_stop = has(args, BLOCK_STOP);
    let takes = !has(args, NO_INJECT);
    let subagents = has(args, SUBAGENT);
    let waits = push_wait(args, env);
    let wake_s = match args.iter().position(|a| a == WAKE) {
        Some(at) => js_number(args.get(at + 1).map(String::as_str)),
        None => 0.0,
    };
    let positional = hook_args(args);
    let (harness_arg, event_arg) = (positional.first().copied(), positional.get(1).copied());
    if harness_arg == Some("agy") {
        record_agy_conversation(payload, env, &|path| host.allow_write(path));
    }
    if wake_s.is_finite() && wake_s > 0.0 {
        return wake_hook(harness_arg, wake_s, hook, host).await;
    }
    let Some(event) = map_hook_payload(payload, event_arg) else {
        return Ok(None);
    };
    if env.get("SCP_TRANSPORT").map(String::as_str) == Some("cloud") {
        return Ok(None);
    }
    let harness = normalize_harness(Some(&hook_harness(harness_arg, env)), "hook");
    let child = hook_format(&harness, &harness) == "codex" && event.agent.is_some();
    let sub = if (subagents && matches!(event.kind, "tool" | "stop"))
        || (child && matches!(event.kind, "prompt" | "tool" | "stop" | "session_end"))
    {
        subagent_of(payload)
    } else {
        None
    };
    if (subagents || child) && sub.is_none() {
        return Ok(None);
    }
    if event.kind == "session_end" {
        host.deadline(SESSION_END_DEADLINE_MS);
    }
    let Some(Speaker { claim, format }) = speaker(hook, &harness, &event, child) else {
        return Ok(None);
    };
    let named =
        event_name(as_string(field(payload, &["hook_event_name", "hookEventName"])).or(event_arg));
    let ended = format != "agy"
        || payload.get("terminationReason").and_then(Value::as_str) == Some("NO_TOOL_CALL");
    let stop = event.kind == "stop" && named == "stop" && ended;
    let counts = stop || (format == "opencode" && event.kind == "prompt");
    if sub.is_some() && !SUBAGENT_HARNESSES.contains(&format.as_str()) {
        return Ok(None);
    }
    let client = host.connect().await;
    let client = client.as_ref();
    if let Some(sub) = sub {
        return subagent_hook(client, &claim, &format, &sub, &event, takes, host).await;
    }
    let inject = takes
        && event.agent.is_none()
        && (stop || injects_at(&format, event.kind))
        && host.remaining() >= INJECT_MIN_MS;
    let hello = client
        .hello(map(json!({"transient": true, "claim": claim})))
        .await;
    let every = tldr_every(env);
    let prompted = if event.kind == "prompt" && named == "userpromptsubmit" {
        let params = if every > 0 {
            map(json!({"tldr_every": every}))
        } else {
            Json::new()
        };
        Some(client.request("prompted", params).await)
    } else {
        None
    };
    if event.kind != "prompt" {
        let session = if event.agent.is_some() {
            None
        } else {
            as_string(field(payload, &["session_id", "sessionId"]))
        };
        let transcript = session
            .filter(|_| format == "claude-code")
            .and_then(|_| as_string(field(payload, &["transcript_path", "transcriptPath"])));
        let mut params = map(json!({"kind": event.kind}));
        for (key, value) in [
            ("tool", event.tool.as_deref()),
            ("summary", event.summary.as_deref()),
            ("agent", event.agent.as_deref()),
            ("session_id", session),
            ("transcript_path", transcript),
        ] {
            if let Some(value) = value {
                params.insert(key.into(), json!(value));
            }
        }
        let _ = client.request("event", params).await;
    }
    if let Some(state) = event.status {
        let _ = client.request("status", map(json!({"state": state}))).await;
    }
    if let Some((role, text)) = peek_turn(&event, &named, payload) {
        let _ = client
            .request("peek_turn", map(json!({"role": role, "text": text})))
            .await;
    }
    if let Some((text, from)) = inferred_title(&format, &event, &named, payload) {
        let _ = client
            .request("title_infer", map(json!({"text": text, "from": from})))
            .await;
    }
    if let Some((id, title)) = launched_subagent(&format, &event, payload) {
        let _ = client
            .request("subagent_title", map(json!({"id": id, "title": title})))
            .await;
    }
    let injected = if inject {
        let mut params = Json::new();
        if counts {
            params.insert("count".into(), json!(true));
            if stop {
                params.insert("stop".into(), json!(true));
                params.insert("directives".into(), json!(true));
                if block_stop {
                    params.insert("hold_unread".into(), json!(true));
                }
            }
        }
        Some(client.request("inject", params).await)
    } else {
        None
    };
    let endpoint = hello.as_ref().ok().and_then(|h| h.get("endpoint"));
    let end = async || {
        if stop && hello.is_ok() {
            queue_wake(client, &claim, &format, endpoint, env).await;
        }
    };
    if event.kind == "session_start" {
        let untitled = endpoint
            .and_then(Value::as_object)
            .and_then(|e| e.get("title"))
            .is_some_and(Value::is_null);
        return Ok((untitled && (format == "claude-code" || format == "codex"))
            .then(|| hook_reply(&format, event.kind, &NUDGE, 0, true)));
    }
    let tldr = prompted
        .as_ref()
        .and_then(|p| p.as_ref().ok())
        .and_then(|p| p.get("tldr"))
        == Some(&Value::Bool(true));
    let tldr = tldr.then(|| TLDR.to_string());
    let result = match injected {
        Some(Ok(result)) if truthy(Some(&result)) => result,
        _ => {
            end().await;
            return Ok(tldr.map(|t| hook_reply(&format, event.kind, &t, 0, true)));
        }
    };
    let continues = !stop
        || format != "claude-code"
        || stop_continues(claude_version(payload, env, &|| "/".into()).as_deref());
    if stop && !flag(&result, "block") {
        let workers = flag(&result, "workers") || flag(&result, "worker_unread");
        let exhausted = result.get("pushes_left").and_then(Value::as_f64) == Some(0.0);
        let Some(waits) =
            waits.filter(|_| PUSHES.contains(&format.as_str()) && workers && !exhausted)
        else {
            end().await;
            return Ok(None);
        };
        let pushed = push(
            client,
            &format,
            waits * 1000.0,
            hook.began,
            result.get("prompts").cloned(),
            host,
            continues,
            result.get("wakeable") == Some(&Value::Bool(true)),
        )
        .await?;
        if pushed.is_none() {
            end().await;
        }
        return Ok(pushed);
    }
    let directive = stop.then(|| directive_text(&format, &result)).flatten();
    let forced = stop
        && match result.get("forced") {
            None | Some(Value::Null) => true,
            forced => truthy(forced),
        };
    let pointer = forced
        .then(|| {
            let unread = if block_stop {
                int(&result, "unread") - directive.as_ref().map_or(0, |d| d.read.len() as i64)
            } else {
                0
            };
            unread_pointer(unread, int(&result, "awaiting"))
        })
        .flatten();
    let nudged: &[Value] = if stop { list(&result, "nudge") } else { &[] };
    let intro = (!stop && flag(&result, "intro")).then(|| {
        intro_text(
            &js(result.get("intro")),
            result.get("intro_key").and_then(Value::as_str),
        )
    });
    let shown = if stop || counts {
        None
    } else {
        let more = more_now(client, &result).await;
        injection_text(&result, more, format != "agy")
    };
    let text = if stop {
        joined(
            [
                directive.as_ref().map(|d| d.text.clone()),
                Some(joined(
                    [
                        pointer.clone(),
                        nudge_text(nudged, int(&result, "nudge_more")),
                    ],
                    "\n",
                )),
            ],
            "\n\n",
        )
    } else {
        let counted = if counts {
            unread_pointer(int(&result, "unread"), int(&result, "awaiting"))
        } else {
            shown.clone()
        };
        joined([intro.clone(), counted, tldr], "\n\n")
    };
    if text.is_empty() || host.remaining() < CONFIRM_MIN_MS {
        end().await;
        return Ok(None);
    }
    let reply = hook_reply(
        &format,
        event.kind,
        &text,
        int(&result, "unread"),
        continues,
    );
    let offered = list(&result, "offered");
    if (stop || !offered.is_empty() || intro.is_some()) && host.print(&reply).await {
        let read = match &directive {
            Some(d) => d.read.clone(),
            None if format == "agy" => vec![],
            None => seqs(list(&result, "messages")),
        };
        let full = match &directive {
            Some(d) => d.full,
            None => {
                shown.is_some() && !flag(&result, "brief") && !list(&result, "messages").is_empty()
            }
        };
        let seqs = if directive.is_some() && !PUSHES.contains(&format.as_str()) {
            vec![]
        } else {
            offered.to_vec()
        };
        let mut params = map(json!({"seqs": seqs}));
        if let Some(hold) = result.get("hold") {
            params.insert("hold".into(), hold.clone());
        }
        if !read.is_empty() {
            params.insert("read".into(), json!(read));
        }
        if forced && (pointer.is_some() || directive.is_none()) {
            params.insert("stop".into(), json!(true));
        }
        if !nudged.is_empty() {
            let ids: Vec<Value> = nudged
                .iter()
                .map(|n| n.get("seq").cloned().unwrap_or(Value::Null))
                .collect();
            params.insert("nudged".into(), json!(ids));
        }
        if let Some(d) = &directive {
            params.insert("restated".into(), json!(d.restated));
        }
        if full {
            params.insert("preamble".into(), json!(true));
        }
        if intro.is_some() {
            params.insert("intro".into(), json!(true));
        }
        if event.kind == "tool" && DEFERS.contains(&format.as_str()) {
            params.insert("deferred".into(), json!(true));
        }
        let _ = client.request("injected", params).await;
    }
    Ok(Some(reply))
}

/// at a turn's end, a codex thread no launcher runs and no other wake wakes takes `codex-queue`
async fn queue_wake(
    client: &dyn Rpc,
    claim: &Claim,
    format: &str,
    endpoint: Option<&Value>,
    env: &Env,
) {
    let harness = claim_field(claim, "harness");
    let Some(endpoint) = endpoint.filter(|e| truthy(Some(e))) else {
        return;
    };
    if format != "codex"
        || (harness != "codex" && harness != "codex-desktop")
        || !truthy(claim.get("harness_session"))
    {
        return;
    }
    if set(env, "SCP_SESSION") || set(env, "SCP_SHIM_BINDING") || set(env, "SCP_GRANT") {
        return;
    }
    let wake = endpoint.get("wake");
    let retry = wake.and_then(Value::as_str) == Some("codex-queue")
        && (flag(endpoint, "wake_failed") || flag(endpoint, "wake_declined"));
    if wake != Some(&Value::Null) && !retry {
        return;
    }
    let _ = client
        .request("wake", map(json!({"via": "codex-queue"})))
        .await;
}

/// waits for context to start the harness's next turn and confirms only printed output
async fn wake_hook(
    harness_arg: Option<&str>,
    wait_s: f64,
    hook: &Hook,
    host: &dyn Host,
) -> Result<Option<String>, RpcError> {
    let (env, payload) = (&hook.env, &hook.payload);
    if env.get("SCP_TRANSPORT").map(String::as_str) == Some("cloud")
        || truthy(field(
            payload,
            &[
                "agent_id",
                "agentId",
                "agent_type",
                "agentType",
                "subagentType",
            ],
        ))
    {
        return Ok(None);
    }
    let harness = normalize_harness(Some(&hook_harness(harness_arg, env)), "hook");
    let Some((claim, format)) = wake_speaker(hook, &harness) else {
        return Ok(None);
    };
    let wait_ms = wait_s.min(LIMITS.wait_max_s as f64) * 1000.0;
    host.deadline(now() - hook.began + wait_ms + PUSH_PRINT_MS + HOOK_AFTER_CONNECT_MS);
    let client = host.connect().await;
    let client = client.as_ref();
    let joins = claim.contains_key("join_only");
    match client
        .hello(map(json!({"transient": true, "claim": claim})))
        .await
    {
        Ok(_) => {}
        Err(error) if joins && not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    }
    let _ = client
        .request("wake", map(json!({"via": OPENCODE_WAKE})))
        .await;
    let result = client
        .request("inject", map(json!({"wait_s": wait_ms / 1000.0})))
        .await?;
    let offered = list(&result, "offered");
    if offered.is_empty() {
        return Ok(None);
    }
    let intro = flag(&result, "intro").then(|| {
        intro_text(
            &js(result.get("intro")),
            result.get("intro_key").and_then(Value::as_str),
        )
    });
    let more = more_now(client, &result).await;
    let shown = injection_text(&result, more, true);
    let text = joined([intro.clone(), shown.clone()], "\n\n");
    if text.is_empty() {
        return Ok(None);
    }
    let reply = hook_reply(&format, "prompt", &text, 0, true);
    if host.stopping() {
        return Ok(None);
    }
    if host.print(&reply).await {
        let messages = list(&result, "messages");
        let read = seqs(messages);
        let mut params = map(json!({"seqs": offered}));
        if let Some(hold) = result.get("hold") {
            params.insert("hold".into(), hold.clone());
        }
        if !read.is_empty() {
            params.insert("read".into(), json!(read));
        }
        params.insert("deferred".into(), json!(true));
        if shown.is_some() && !flag(&result, "brief") && !messages.is_empty() {
            params.insert("preamble".into(), json!(true));
        }
        if intro.is_some() {
            params.insert("intro".into(), json!(true));
        }
        client.request("injected", params).await?;
    }
    Ok(Some(reply))
}

/// claims a child endpoint for tool (and Codex prompt) events; a stop or session end only marks an existing child done
async fn subagent_hook(
    client: &dyn Rpc,
    claim: &Claim,
    format: &str,
    sub: &(String, Option<String>),
    event: &HookEvent,
    takes: bool,
    host: &dyn Host,
) -> Result<Option<String>, RpcError> {
    let stop = matches!(event.kind, "stop" | "session_end");
    let mut subagent = map(json!({"id": sub.0}));
    if let Some(kind) = &sub.1 {
        subagent.insert("type".into(), json!(kind));
    }
    if stop {
        subagent.insert("stop".into(), json!(true));
    }
    let mut claim = claim.clone();
    claim.insert("subagent".into(), Value::Object(subagent));
    let hello = match client
        .hello(map(json!({"transient": true, "claim": claim})))
        .await
    {
        Ok(hello) => hello,
        Err(error) if stop && not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    if !flag(&hello, "subagent") {
        return Ok(None);
    }
    if stop {
        client
            .request("status", map(json!({"state": "done"})))
            .await?;
        return Ok(None);
    }
    let inject = takes && host.remaining() >= INJECT_MIN_MS;
    let injected = if inject {
        client.request("inject", Json::new()).await.ok()
    } else {
        None
    };
    let intro = (flag(&hello, "created") && flag(&hello, "endpoint"))
        .then(|| subagent_intro(&js(hello["endpoint"].get("address"))));
    let shown = match &injected {
        Some(injected) => {
            let more = more_now(client, injected).await;
            injection_text(injected, more, true)
        }
        None => None,
    };
    let text = joined([intro, shown], "\n\n");
    if text.is_empty() || host.remaining() < CONFIRM_MIN_MS {
        return Ok(None);
    }
    let kind = if event.kind == "prompt" {
        "prompt"
    } else {
        "tool"
    };
    let reply = hook_reply(format, kind, &text, 0, true);
    if let Some(injected) = injected.filter(|i| !list(i, "offered").is_empty())
        && host.print(&reply).await
    {
        let messages = list(&injected, "messages");
        let read = seqs(messages);
        let mut params = map(json!({"seqs": list(&injected, "offered")}));
        if let Some(hold) = injected.get("hold") {
            params.insert("hold".into(), hold.clone());
        }
        if !read.is_empty() {
            params.insert("read".into(), json!(read));
        }
        if !(flag(&injected, "brief") || messages.is_empty()) {
            params.insert("preamble".into(), json!(true));
        }
        if format == "codex" && event.kind == "tool" {
            params.insert("deferred".into(), json!(true));
        }
        let _ = client.request("injected", params).await;
    }
    Ok(Some(reply))
}

/// waits for worker messages, the broker's grace period gathering results before the deadline; a session a message wakes only looks
/// once, unless that look finds it no longer wakeable with workers still running
#[allow(clippy::too_many_arguments)]
async fn push(
    client: &dyn Rpc,
    harness: &str,
    wait_ms: f64,
    began: f64,
    prompts: Option<Value>,
    host: &dyn Host,
    continues: bool,
    mut wakes: bool,
) -> Result<Option<String>, RpcError> {
    let wait = |ms: f64| {
        let end = now() + ms;
        if ms > 0.0 {
            host.deadline(end - began + LIMITS.push_grace_s as f64 * 1000.0 + PUSH_PRINT_MS);
        }
        end
    };
    let mut end = wait(if wakes { 0.0 } else { wait_ms });
    let result = loop {
        let mut params = map(json!({
            "wait_s": ((end - now()) / 1000.0).min(LIMITS.wait_max_s as f64).max(0.0)
        }));
        if let Some(prompts) = &prompts {
            params.insert("prompts".into(), prompts.clone());
        }
        let result = client.request("stop_wait", params).await?;
        let shown = !list(&result, "messages").is_empty() || flag(&result, "more");
        let running = list(&result, "workers").len() as f64 + num(&result, "starting") > 0.0;
        let pushes_left = result.get("pushes_left").and_then(Value::as_f64);
        let idle =
            !shown && !flag(&result, "prompted") && pushes_left.is_some_and(|n| n > 0.0) && running;
        if wakes && !flag(&result, "wakeable") && idle && wait_ms > 0.0 {
            wakes = false;
            end = wait(wait_ms);
            continue;
        }
        if shown
            || flag(&result, "prompted")
            || flag(&result, "wakeable")
            || pushes_left == Some(0.0)
            || !running
            || now() >= end
        {
            break result;
        }
    };
    let Some(text) = push_text(&result) else {
        return Ok(None);
    };
    if host.remaining() < CONFIRM_MIN_MS {
        return Ok(None);
    }
    let reply = hook_reply(harness, "stop", &text, 0, continues);
    let offered = list(&result, "offered");
    if !offered.is_empty() && host.print(&reply).await {
        let messages = list(&result, "messages");
        let read = seqs(messages);
        let mut params = map(json!({"seqs": offered}));
        if let Some(hold) = result.get("hold") {
            params.insert("hold".into(), hold.clone());
        }
        if !read.is_empty() {
            params.insert("read".into(), json!(read));
        }
        params.insert("push".into(), json!(true));
        if !(flag(&result, "brief") || messages.is_empty()) {
            params.insert("preamble".into(), json!(true));
        }
        let _ = client.request("injected", params).await;
    }
    Ok(Some(reply))
}
