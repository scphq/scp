//! The server under a fixed test setup (`SCP_MCP_TEST`): a broker socket, a claim and canned membership, thread claims and spawns.
//!
//! The spec is JSON: `{socket, claim, env, channels, launched, wake, version, heartbeat_ms, defer_claim, membership, thread_claims,
//! session_inbox, spawn}`. `membership` is `{dark}`, `{handle}` or `{}`; `thread_claims` maps a `_meta.threadId` to its claim;
//! `spawn` is `{pid, name?, fallback?, error?, refuse?: {<name>: <message>}, log?}`, appending each request to `log` as a JSON line.
//! Each broker connection and binding is logged to stderr as `test: connect` and `test: bound <session>`.

use scp_mcp::client::Client;
use scp_mcp::inbox::SessionInbox;
use scp_mcp::server::{self, MembershipFn, Options, SpawnFn, Spawned, ThreadClaimFn};
use scp_mcp::tools::{get, js};
use scp_mcp::{Claim, Membership};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;

fn text(spec: &Value, key: &str) -> Option<String> {
    get(spec, key).and_then(Value::as_str).map(str::to_string)
}

fn flag(spec: &Value, key: &str) -> bool {
    get(spec, key).and_then(Value::as_bool).unwrap_or(false)
}

fn membership(spec: &Value) -> Option<Membership> {
    let fixed = get(spec, "membership")?.as_object()?;
    Some(
        match (
            fixed.get("dark").and_then(Value::as_str),
            fixed.get("handle").and_then(Value::as_str),
        ) {
            (Some(why), _) => Membership::Dark(why.into()),
            (None, handle) => Membership::Joined(handle.map(str::to_string)),
        },
    )
}

fn spawner(spec: &Value) -> Option<SpawnFn> {
    let spawn = get(spec, "spawn")?.clone();
    Some(Rc::new(move |request| {
        let spawn = spawn.clone();
        Box::pin(async move {
            if let Some(log) = text(&spawn, "log") {
                let line = format!("{}\n", request.to_json());
                let file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(log);
                file.and_then(|mut f| f.write_all(line.as_bytes()))
                    .map_err(|e| e.to_string())?;
            }
            if let Some(error) = text(&spawn, "error") {
                return Err(error);
            }
            if let Some(refusal) = request
                .name
                .as_deref()
                .and_then(|name| get(&spawn, "refuse").and_then(|r| get(r, name)))
            {
                return Err(js(Some(refusal)));
            }
            let name = text(&spawn, "name")
                .or(request.name.clone())
                .or_else(|| text(&spawn, "fallback"))
                .unwrap_or_else(|| "worker".into());
            let pid = get(&spawn, "pid").and_then(Value::as_u64).unwrap_or(1) as u32;
            Ok(Spawned { name, pid })
        })
    }))
}

fn options(spec: &Value) -> Options {
    let socket = PathBuf::from(text(spec, "socket").unwrap_or_default());
    let fixed = membership(spec);
    let threads: Map<String, Value> = get(spec, "thread_claims")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let env: HashMap<String, String> = get(spec, "env")
        .and_then(Value::as_object)
        .map(|env| {
            env.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let session_inbox = get(spec, "session_inbox").and_then(|inbox| {
        Some(SessionInbox {
            socket: text(inbox, "socket")?,
            token: text(inbox, "token"),
            session_id: text(inbox, "sessionId"),
        })
    });
    Options {
        connect: Rc::new(move || {
            let socket = socket.clone();
            eprintln!("test: connect");
            Box::pin(async move { Client::connect(&socket).await })
        }),
        claim: get(spec, "claim")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        membership: fixed.map(|fixed| Rc::new(move |_: &str| fixed.clone()) as MembershipFn),
        thread_claim: (!threads.is_empty()).then(|| {
            Rc::new(move |meta: &Map<String, Value>| {
                let thread = meta.get("threadId")?.as_str()?;
                threads.get(thread)?.as_object().cloned()
            }) as ThreadClaimFn
        }),
        defer_claim: flag(spec, "defer_claim"),
        bound: Some(Rc::new(|claim: &Claim| {
            eprintln!("test: bound {}", js(claim.get("session")))
        })),
        env,
        channels: flag(spec, "channels"),
        launched_with_channels: flag(spec, "launched"),
        session_inbox,
        wake: text(spec, "wake"),
        version: text(spec, "version"),
        spawn: spawner(spec),
        log: Rc::new(|line| eprintln!("{line}")),
        heartbeat_ms: get(spec, "heartbeat_ms")
            .and_then(Value::as_u64)
            .unwrap_or(30_000),
    }
}

/// serves MCP on stdin and stdout under the test setup `spec`, returning the exit code
pub fn main(spec: &str) -> i32 {
    let spec: Value = match serde_json::from_str(spec) {
        Ok(spec) => spec,
        Err(error) => {
            eprintln!("SCP_MCP_TEST is not JSON: {error}");
            return 2;
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("no runtime: {error}");
            return 1;
        }
    };
    let output: Rc<dyn Fn(&str)> = Rc::new(|line: &str| {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(line.as_bytes()).and_then(|()| out.flush());
    });
    let local = tokio::task::LocalSet::new();
    local.block_on(
        &runtime,
        server::run(options(&spec), tokio::io::stdin(), output),
    );
    drop(local);
    runtime.shutdown_background();
    0
}
