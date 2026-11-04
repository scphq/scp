//! `swarm daemon`: the broker in the foreground, or `stop` and `restart`, read as the TypeScript CLI reads them and run natively.

use crate::{Call, Done, Fail, Run, Verb, term, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::CallError;

pub const VERBS: &[Verb] = &[Verb {
    name: "daemon",
    run: Run::Parsed(daemon),
}];

fn daemon(call: &Call) -> Done {
    let parsed = &call.parsed;
    let idle = parsed.text("idle");
    let policy = parsed.text("policy");
    let mut words: Vec<String> = Vec::new();
    if let Some(action) = parsed.positionals.first() {
        if parsed.positionals.len() != 1
            || (action != "stop" && action != "restart")
            || parsed.has("idle")
            || parsed.has("policy")
        {
            return Err(usage(format!(
                "{CLI_NAME} daemon takes stop or restart, or --idle and --policy to run in the foreground"
            )));
        }
        let stopped = (call.host.daemon_stop)().map_err(|e| Fail::Call(CallError::Io(e)))?;
        if action == "stop" {
            term::out(&match stopped {
                None => "no relay broker runs".into(),
                Some(pid) => format!(
                    "stopped the relay broker (pid {pid}); the next command starts a fresh one"
                ),
            });
            return Ok(0);
        }
        let pid = fresh_broker(call.env)?;
        let head = match stopped {
            None => "started".into(),
            Some(old) => format!("replaced the relay broker (pid {old}) with"),
        };
        term::out(&format!("{head} a fresh one (pid {pid})"));
        return Ok(0);
    }
    if let Some(idle) = idle {
        words.extend(["--idle".to_owned(), idle.to_owned()]);
    }
    if let Some(policy) = policy.filter(|p| !p.is_empty()) {
        let cwd = scp_mcp::identity::safe_cwd();
        let absolute = scp_mcp::client::normalize(&std::path::Path::new(&cwd).join(policy));
        words.extend([
            "--policy".to_owned(),
            absolute.to_string_lossy().into_owned(),
        ]);
    }
    hangup_stops();
    Ok((call.host.daemon)(&words))
}

/// the pid of the broker a connection starts, as `daemon restart` reports it
fn fresh_broker(env: &scp_mcp::ps::Env) -> Result<String, Fail> {
    let dir = scp_mcp::client::relay_dir(env)
        .to_string_lossy()
        .into_owned();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| Fail::Call(CallError::Io(error.to_string())))?;
    let local = tokio::task::LocalSet::new();
    let pid = local.block_on(&runtime, async {
        if let Ok(exe) = std::env::current_exe() {
            scp_mcp::spawn::set_native_daemon(exe);
        }
        let start: scp_mcp::client::Start = {
            let (dir, env) = (dir.clone(), env.clone());
            std::rc::Rc::new(move || crate::open::start_broker(&dir, &env))
        };
        let client =
            scp_mcp::client::connect_or_start(std::path::Path::new(&dir), Some(start)).await?;
        let mut observe = serde_json::Map::new();
        observe.insert("observe".into(), serde_json::Value::Bool(true));
        let hello = client.hello(observe).await;
        client.close();
        let hello = hello?;
        Ok::<_, Fail>(scp_mcp::tools::js(
            hello.get("broker").and_then(|b| b.get("pid")),
        ))
    });
    drop(local);
    runtime.shutdown_background();
    pid
}

extern "C" fn hangup(_: libc::c_int) {
    // SAFETY: getpid and kill are async-signal-safe
    unsafe {
        libc::kill(libc::getpid(), libc::SIGTERM);
    }
}

/// a hangup stops the broker as SIGTERM does, as the CLI that ran it in the foreground did
fn hangup_stops() {
    // SAFETY: installs a handler that only calls async-signal-safe functions
    unsafe {
        libc::signal(
            libc::SIGHUP,
            hangup as extern "C" fn(libc::c_int) as libc::sighandler_t,
        );
    }
}
