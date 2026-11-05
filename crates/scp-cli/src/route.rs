//! The native side of the router: its variables, the route log and the TypeScript fallback.

use crate::Host;
use crate::term;
use scp_core::protocol::CLI_NAME;
use scp_mcp::ps::Env;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::sync::OnceLock;

/// the verbs only the TypeScript CLI runs: the experimental mesh is a TypeScript package a source checkout loads
pub const TS_VERBS: [&str; 1] = ["mesh"];
/// set by the router: `<its pid>:<its parent's pid>`, so a child it spawned walks from the shell that ran the command
pub const PARENT: &str = "SCP_CLI_PARENT";
/// `native` when the router handed this invocation over, `ts` on the TypeScript CLI this hands back to
pub const ROUTED: &str = "SCP_ROUTED";
/// the caller's own `SCP_CLI_ARGV`, which the router replaced with its launch words
pub const GIVEN_ARGV: &str = "SCP_CLI_ARGV_GIVEN";
/// a file each routing decision is appended to as `verb engine reason`
pub const LOG: &str = "SCP_ROUTE_LOG";

struct Start {
    parent: Option<String>,
    routed: bool,
    given: Option<String>,
}

static START: OnceLock<Start> = OnceLock::new();

pub fn startup() {
    START.get_or_init(|| {
        let parent = std::env::var(PARENT).ok();
        let routed = std::env::var(ROUTED).is_ok_and(|v| v == "native");
        let given = std::env::var(GIVEN_ARGV).ok();
        // SAFETY: called first in main, before any other thread starts
        unsafe {
            std::env::remove_var(PARENT);
            std::env::remove_var(ROUTED);
            std::env::remove_var(GIVEN_ARGV);
        }
        Start {
            parent,
            routed,
            given,
        }
    });
}

pub fn routed() -> bool {
    START.get().is_some_and(|s| s.routed)
}

/// the router's variables for a process this one starts in its own place, as the router handed them
pub fn handed_on(env: &mut Env) {
    if !routed() {
        return;
    }
    env.insert(ROUTED.into(), "native".into());
    if let Some(given) = START.get().and_then(|s| s.given.clone()) {
        env.insert(GIVEN_ARGV.into(), given);
    }
}

/// `SCP_CLI_ARGV` as the caller had it when a router replaced it: `Some(None)` for a caller without one, `None` when nothing was replaced
fn callers_argv() -> Option<Option<&'static str>> {
    START
        .get()
        .and_then(|start| replaced(start.routed, start.given.as_deref()))
}

fn replaced(routed: bool, given: Option<&str>) -> Option<Option<&str>> {
    routed.then_some(given)
}

/// `env` with `SCP_CLI_ARGV` as the caller had it, before a router replaced it
pub fn caller_argv(env: &mut Env) {
    restore_argv(env, callers_argv());
}

fn restore_argv(env: &mut Env, callers: Option<Option<&str>>) {
    match callers {
        Some(Some(given)) => {
            env.insert(scp_mcp::spawn::CLI_ARGV.into(), given.into());
        }
        Some(None) => {
            env.remove(scp_mcp::spawn::CLI_ARGV);
        }
        None => {}
    }
}

/// the pid a `<pid>:<ppid>` pair names as the shell, when its pid is `parent`
pub fn parent_shell(value: Option<&str>, parent: i64) -> Option<i64> {
    let (pid, ppid) = value?.split_once(':')?;
    let pid: i64 = pid.parse().ok()?;
    let ppid: i64 = ppid.parse().ok()?;
    (pid == parent && pid > 1 && ppid > 0).then_some(ppid)
}

fn parent_pid() -> i64 {
    // SAFETY: getppid cannot fail
    i64::from(unsafe { libc::getppid() })
}

/// the router's parent, when the router spawned this process and is still its parent
pub fn router_parent() -> Option<i64> {
    let given = START.get().and_then(|s| s.parent.as_deref());
    parent_shell(given, parent_pid())
}

/// the process that ran the command: the router's parent when the router spawned this one and is still its parent, else the parent
pub fn shell_pid() -> i64 {
    router_parent().unwrap_or_else(parent_pid)
}

/// appends `verb engine reason` to `$SCP_ROUTE_LOG`
pub fn log(verb: &str, engine: &str, reason: &str) {
    let Some(path) = std::env::var_os(LOG).filter(|p| !p.is_empty()) else {
        return;
    };
    let line = format!("{verb} {engine} {reason}\n");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// the words that start the TypeScript CLI: `$SCP_CLI_ARGV`, else the CLI beside this executable's native package
fn ts_launch(env: &Env, host: &Host) -> Option<Vec<String>> {
    scp_mcp::spawn::named_launcher(env).or_else(|| (host.beside)(env))
}

/// runs `args` on the TypeScript CLI in place of this process, for `reason`; returns only when it cannot
pub fn fallback(args: &[String], verb: &str, reason: &str, env: &Env, host: &Host) -> i32 {
    log(if verb.is_empty() { "-" } else { verb }, "ts", reason);
    let Some(launch) = ts_launch(env, host) else {
        term::note(&format!(
            "{CLI_NAME} {verb} is not native in this swarm {} ({reason}), and no TypeScript CLI was found to run it: install @scp-dev/cli, or set SCP_CLI_ARGV to the words that start it",
            crate::VERSION
        ));
        return term::FAILED;
    };
    let mut command = std::process::Command::new(&launch[0]);
    command.args(&launch[1..]).args(args).env(ROUTED, "ts");
    match callers_argv() {
        Some(Some(given)) => {
            command.env(scp_mcp::spawn::CLI_ARGV, given);
        }
        Some(None) => {
            command.env_remove(scp_mcp::spawn::CLI_ARGV);
        }
        None => {}
    }
    let error = command.exec();
    term::note(&format!(
        "the TypeScript CLI {} did not start: {error}",
        launch[0]
    ));
    term::FAILED
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_parent_pair_counts_only_from_the_router_that_is_the_parent() {
        assert_eq!(parent_shell(Some("40:7"), 40), Some(7));
        assert_eq!(parent_shell(Some("40:7"), 41), None);
        assert_eq!(parent_shell(Some("1:7"), 1), None);
        assert_eq!(parent_shell(Some("40"), 40), None);
        assert_eq!(parent_shell(Some("40:x"), 40), None);
        assert_eq!(parent_shell(None, 40), None);
    }

    #[test]
    fn a_harness_gets_the_callers_argv_not_the_routers() {
        let routers = Env::from([(
            scp_mcp::spawn::CLI_ARGV.to_owned(),
            "[\"router\"]".to_owned(),
        )]);
        let mut env = routers.clone();
        restore_argv(&mut env, replaced(false, Some("[\"caller\"]")));
        assert_eq!(env, routers);
        restore_argv(&mut env, replaced(true, None));
        assert!(env.is_empty());
        let mut env = routers.clone();
        restore_argv(&mut env, replaced(true, Some("[\"caller\"]")));
        assert_eq!(env[scp_mcp::spawn::CLI_ARGV], "[\"caller\"]");
    }
}
