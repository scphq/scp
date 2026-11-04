//! The native side of the router: its variables, the route log, the flags handed back and the TypeScript fallback.

use crate::Host;
use crate::term;
use scp_core::protocol::CLI_NAME;
use scp_mcp::ps::Env;
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::sync::OnceLock;

/// flags the native verbs hand to the TypeScript CLI, which the router also checks before it hands a verb over
pub const DECLINE_FLAGS: [&str; 4] = ["--help", "-h", "--cloud", "--via"];
/// variables that do the same
pub const DECLINE_ENV: [(&str, &str); 1] = [("SCP_TRANSPORT", "cloud")];
/// set by the router: `<its pid>:<its parent's pid>`, so a child it spawned walks from the shell that ran the command
pub const PARENT: &str = "SCP_CLI_PARENT";
/// `native` when the router handed this invocation over, `ts` on the TypeScript CLI this hands back to
pub const ROUTED: &str = "SCP_ROUTED";
/// a file each routing decision is appended to as `verb engine reason`
pub const LOG: &str = "SCP_ROUTE_LOG";

struct Start {
    parent: Option<String>,
    routed: bool,
}

static START: OnceLock<Start> = OnceLock::new();

pub fn startup() {
    START.get_or_init(|| {
        let parent = std::env::var(PARENT).ok();
        let routed = std::env::var(ROUTED).is_ok_and(|v| v == "native");
        // SAFETY: called first in main, before any other thread starts
        unsafe {
            std::env::remove_var(PARENT);
            std::env::remove_var(ROUTED);
        }
        Start { parent, routed }
    });
}

pub fn routed() -> bool {
    START.get().is_some_and(|s| s.routed)
}

/// the pid a `<pid>:<ppid>` pair names as the shell, when its pid is `parent`
pub fn parent_shell(value: Option<&str>, parent: i64) -> Option<i64> {
    let (pid, ppid) = value?.split_once(':')?;
    let pid: i64 = pid.parse().ok()?;
    let ppid: i64 = ppid.parse().ok()?;
    (pid == parent && pid > 1 && ppid > 0).then_some(ppid)
}

/// the process that ran the command: the router's parent when the router spawned this one and is still its parent, else the parent
pub fn shell_pid() -> i64 {
    // SAFETY: getppid cannot fail
    let parent = i64::from(unsafe { libc::getppid() });
    let given = START.get().and_then(|s| s.parent.as_deref());
    parent_shell(given, parent).unwrap_or(parent)
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

/// whether `word` gives `flag`: a long flag alone or with `=value`, a short one anywhere in a short group
pub fn gives(word: &str, flag: &str) -> bool {
    match flag.strip_prefix("--") {
        Some(_) => word == flag || word.strip_prefix(flag).is_some_and(|r| r.starts_with('=')),
        None => {
            let short = &flag[1..];
            word.starts_with('-')
                && !word.starts_with("--")
                && word.len() > 1
                && word[1..].contains(short)
        }
    }
}

/// why `verb` with `words` goes to the TypeScript CLI, if it does: a flag or variable the native verbs do not cover yet
pub fn declined(verb: &str, words: &[String], env: &Env) -> Option<String> {
    if crate::claude::BROKER_VERBS.contains(&verb) {
        return None;
    }
    let first = words.first().map(String::as_str).unwrap_or_default();
    if verb == "claude" && !crate::claude::CLAUDE_WORDS.contains(&first) {
        return Some("unported".into());
    }
    for word in words {
        if word == "--" {
            break;
        }
        if let Some(flag) = DECLINE_FLAGS.iter().find(|flag| gives(word, flag)) {
            return Some(match *flag {
                "--help" | "-h" => "help".into(),
                flag => flag.trim_start_matches('-').into(),
            });
        }
    }
    DECLINE_ENV
        .iter()
        .find(|(key, value)| env.get(*key).is_some_and(|v| v == value))
        .map(|(key, _)| key.to_lowercase())
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
    let error = std::process::Command::new(&launch[0])
        .args(&launch[1..])
        .args(args)
        .env(ROUTED, "ts")
        .exec();
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
    fn declined_flags_stop_at_the_terminator() {
        let words = |list: &[&str]| list.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        let env = Env::new();
        assert_eq!(
            declined("whoami", &words(&["--help"]), &env).as_deref(),
            Some("help")
        );
        assert_eq!(
            declined("whoami", &words(&["-xh"]), &env).as_deref(),
            Some("help")
        );
        assert_eq!(
            declined("whoami", &words(&["--cloud=1"]), &env).as_deref(),
            Some("cloud")
        );
        assert_eq!(
            declined("spawn", &words(&["--via", "m"]), &env).as_deref(),
            Some("via")
        );
        assert_eq!(declined("set-now", &words(&["--", "-h"]), &env), None);
        assert_eq!(declined("set-now", &words(&["--helpful"]), &env), None);
        let cloud = Env::from([("SCP_TRANSPORT".to_owned(), "cloud".to_owned())]);
        assert_eq!(
            declined("whoami", &[], &cloud).as_deref(),
            Some("scp_transport")
        );
    }
}
