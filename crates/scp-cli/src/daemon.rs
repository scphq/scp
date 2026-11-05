//! `swarm daemon`: the broker in the foreground, or `stop` and `restart`, read as the TypeScript CLI reads them and run natively; and
//! `swarm hook`, the other verb the binary around this crate runs.

use crate::{Call, Done, Fail, Run, Verb, term, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::CallError;

pub const VERBS: &[Verb] = &[
    Verb {
        name: "daemon",
        run: Run::Parsed(daemon),
    },
    Verb {
        name: "hook",
        run: Run::Words(hook),
    },
];

/// `swarm hook <args>`: the hook client, given the words that start this CLI for a broker it starts
fn hook(call: &Call, words: &[String]) -> Done {
    let mut argv = scp_mcp::spawn::named_launcher(call.env)
        .or_else(|| (call.host.beside)(call.env))
        .unwrap_or_default();
    argv.push("hook".into());
    argv.extend_from_slice(words);
    Ok((call.host.hook)(&argv, crate::route::shell_pid()))
}

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
        let stopped = stop_broker(call.env)?;
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

/// the pid in the broker lock of `dir` when that process runs a broker: a `daemon` command of scp, swarm or this CLI's script
pub fn broker_pid(dir: &std::path::Path, script: Option<&str>) -> Option<i32> {
    let text = std::fs::read_to_string(dir.join("broker.lock")).ok()?;
    let pid: f64 = text.split(':').next()?.trim().parse().ok()?;
    if pid.fract() != 0.0 || pid <= 0.0 || pid > f64::from(i32::MAX) {
        return None;
    }
    let pid = pid as i32;
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|out| out.status.success());
    let command = output.map_or(String::new(), |out| {
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    });
    let daemon = command.split_whitespace().any(|word| word == "daemon");
    let ours = command.contains("scp")
        || command.contains("swarm")
        || script.is_some_and(|script| !script.is_empty() && command.contains(script));
    (daemon && ours).then_some(pid)
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// a failed kill as Node words it: `kill <ERRNO>`
pub fn kill_error(error: &std::io::Error) -> String {
    match crate::open::errno_words(error) {
        Some((code, _)) => format!("kill {code}"),
        None => error.to_string(),
    }
}

/// the script of the CLI that runs this command, from `$SCP_CLI_ARGV`, whose brokers run as `<node> <script> daemon`
pub fn cli_script(env: &scp_mcp::ps::Env) -> Option<String> {
    scp_mcp::spawn::named_launcher(env).and_then(launcher_script)
}

/// the script a `<node> <script>` launcher runs, None for a bare program or an empty script
pub fn launcher_script(words: Vec<String>) -> Option<String> {
    (words.len() > 1)
        .then(|| words.last().cloned())
        .flatten()
        .filter(|script| !script.is_empty())
}

/// stops the broker of the relay dir with SIGTERM and waits up to 5 s for it: its pid, None when none ran
fn stop_broker(env: &scp_mcp::ps::Env) -> Result<Option<i32>, Fail> {
    let dir = scp_mcp::client::relay_dir(env);
    stop(&dir, cli_script(env).as_deref()).map_err(|message| Fail::Call(CallError::Io(message)))
}

/// stops the broker of `dir`, one `script` runs among them, with SIGTERM and waits up to 5 s for it: its pid, None when none ran
pub fn stop(dir: &std::path::Path, script: Option<&str>) -> Result<Option<i32>, String> {
    let Some(pid) = broker_pid(dir, script) else {
        return Ok(None);
    };
    // SAFETY: kill(2) on a pid read from the broker lock and checked with ps
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(None),
            _ => Err(kill_error(&error)),
        };
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while alive(pid) {
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "the relay broker (pid {pid}) did not stop within 5 s"
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Ok(Some(pid))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_broker_runs_as_scp_swarm_or_this_clis_script() {
        let dir = std::env::temp_dir().join(format!("cli-daemon-pid-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("tool/cli.js").display().to_string();
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30; :", &script, "daemon"])
            .spawn()
            .unwrap();
        std::fs::write(dir.join("broker.lock"), format!("{}:0", child.id())).unwrap();
        let pid = i32::try_from(child.id()).ok();
        for _ in 0..50 {
            if broker_pid(&dir, Some(&script)).is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(broker_pid(&dir, Some(&script)), pid);
        assert_eq!(broker_pid(&dir, None), None);
        assert_eq!(broker_pid(&dir, Some("/elsewhere/cli.js")), None);
        assert_eq!(broker_pid(&dir, Some("")), None);
        let words = |w: &[&str]| w.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        assert_eq!(launcher_script(words(&["node", ""])), None);
        assert_eq!(launcher_script(words(&["node"])), None);
        assert_eq!(
            launcher_script(words(&["node", "/a/cli.js"])).as_deref(),
            Some("/a/cli.js")
        );
        std::fs::write(dir.join("broker.lock"), "1.5:0").unwrap();
        assert_eq!(broker_pid(&dir, Some(&script)), None);
        assert_eq!(
            kill_error(&std::io::Error::from_raw_os_error(libc::EPERM)),
            "kill EPERM"
        );
        let _ = child.kill();
        let _ = child.wait();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
