//! A muse spawn's words: where its options end, the session its exec logs, and the contributor mode it runs with.

use super::argv::program_at;
use crate::args::js_string;
use scp_mcp::identity::{MuseLaunch, private_dir, read_owned_file, relay_dir};
use scp_mcp::ps::{Env, join};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

pub use scp_mcp::spawn::{contributor_refusal, muse_modes};

pub const MUSE_MODE: &str = "--contributor-mode";
const MUSE_SESSION: &str = "--session-id";

/// muse's top-level options that take a value
const MUSE_VALUED: [&str; 27] = [
    "--agents",
    "--provider",
    "--preset",
    "--model",
    "--contributor-mode",
    "-c",
    "--config",
    "--reasoning-effort",
    "--effort",
    "--base-url",
    "--image",
    "--workspace",
    "--worktree-base",
    "--worktree-existing",
    "--approval-mode",
    "--permission-profile",
    "--approval-judge",
    "--sandbox-network",
    "--echo-delay-ms",
    "--prompt-file",
    "--session-id",
    "--context-compaction-strategy",
    "--context-compaction-soft-threshold",
    "--context-compaction-hard-threshold",
    "--output-schema",
    "--max-model-steps",
    "--max-tool-output-bytes",
];

/// muse exec's options a resume leaves out: the first prompt's file and images, the session id it sets itself, and a new worktree
const MUSE_FIRST_ONLY: [&str; 7] = [
    "--prompt-file",
    "--image",
    MUSE_SESSION,
    "-w",
    "--worktree",
    "--worktree-base",
    "--worktree-existing",
];

/// whether `word` takes the next word: a valued option, or an optional-valued one (`-w`, `--worktree`) followed by one of its values
fn takes(word: &str, next: Option<&String>) -> bool {
    MUSE_VALUED.contains(&word)
        || (matches!(word, "-w" | "--worktree")
            && matches!(
                next.map(String::as_str),
                Some("off" | "create" | "existing")
            ))
}

/// where muse's options from `start` end: the index of its subcommand, its prompt or a `--`
pub fn muse_options_end(args: &[String], start: usize) -> usize {
    let mut i = start;
    while i < args.len() && args[i].starts_with('-') && args[i] != "--" {
        let word = &args[i];
        i += if !word.contains('=') && takes(word, args.get(i + 1)) {
            2
        } else {
            1
        };
    }
    i
}

/// one of muse's options, or its exec subcommand: where it is, how many words it takes, its flag and value
#[derive(Debug, Clone, PartialEq)]
pub struct MuseOption {
    pub at: usize,
    pub size: usize,
    pub flag: String,
    pub value: Option<String>,
}

/// a headless `muse [opts] exec [opts] [prompt]` that logs its session: where exec is, where its options end, them read by arity, the session it names
#[derive(Debug, Clone, PartialEq)]
pub struct MuseExec {
    pub exec: usize,
    pub end: usize,
    pub options: Vec<MuseOption>,
    pub session: Option<String>,
}

pub fn muse_exec(args: &[String]) -> Option<MuseExec> {
    let exec = muse_options_end(args, 0);
    if !args.get(exec).is_some_and(|w| w == "exec") {
        return None;
    }
    let end = muse_options_end(args, exec + 1);
    let operands = match args.get(end) {
        Some(w) if w == "--" => args.len() - end - 1,
        _ => args.len().saturating_sub(end),
    };
    if operands > 1 {
        return None;
    }
    let mut options = Vec::new();
    let mut i = 0;
    while i < end {
        let word = &args[i];
        let eq = if word.starts_with('-') {
            word.find('=').filter(|eq| *eq > 0)
        } else {
            None
        };
        let size = if i == exec || eq.is_some() || !takes(word, args.get(i + 1)) {
            1
        } else {
            2
        };
        let (flag, value) = match eq {
            Some(eq) => (word[..eq].to_owned(), Some(word[eq + 1..].to_owned())),
            None if size == 2 => (word.clone(), args.get(i + 1).cloned()),
            None => (word.clone(), None),
        };
        options.push(MuseOption {
            at: i,
            size,
            flag,
            value,
        });
        i += size;
    }
    if options
        .iter()
        .any(|o| o.flag == "--no-session-log" || o.flag == "--api-key-stdin")
    {
        return None;
    }
    let session = options
        .iter()
        .rev()
        .find(|o| o.flag == MUSE_SESSION)
        .and_then(|o| o.value.clone());
    Some(MuseExec {
        exec,
        end,
        options,
        session,
    })
}

/// a muse exec spawn may resume: with its own session id, else with `--session-id <uuid>` after exec, the session returned
pub fn muse_first_run(
    command: &[String],
    uuid: impl FnOnce() -> String,
) -> Option<(Vec<String>, String)> {
    let at = program_at(command);
    let run = muse_exec(command.get(at + 1..).unwrap_or(&[]))?;
    if let Some(session) = run.session {
        return Some((command.to_vec(), session));
    }
    let session = uuid();
    let exec = at + 1 + run.exec + 1;
    let mut out = command[..exec].to_vec();
    out.push(MUSE_SESSION.into());
    out.push(session.clone());
    out.extend_from_slice(&command[exec..]);
    Some((out, session))
}

/// a resumed muse exec's words before its prompt: its options without the first-run ones, then `--session-id <session>`
pub fn muse_resume_base(command: &[String], session: &str) -> Option<Vec<String>> {
    let at = program_at(command);
    let args = command.get(at + 1..).unwrap_or(&[]);
    let run = muse_exec(args)?;
    let mut out = command[..at + 1].to_vec();
    for option in &run.options {
        if !MUSE_FIRST_ONLY.contains(&option.flag.as_str()) {
            out.extend_from_slice(&args[option.at..(option.at + option.size).min(args.len())]);
        }
    }
    out.push(MUSE_SESSION.into());
    out.push(session.to_owned());
    Some(out)
}

/// where muse's contributor mode goes: after exec, which takes its own, else right after the program
pub fn muse_mode_at(args: &[String]) -> usize {
    let i = muse_options_end(args, 0);
    if args.get(i).is_some_and(|w| w == "exec") {
        i + 1
    } else {
        0
    }
}

/// `^pid:([1-9][0-9]*):[A-Za-z0-9:-]{1,64}$`: the pid of a process key with its start time
fn binding_pid(key: &str) -> Option<&str> {
    let (pid, start) = key.strip_prefix("pid:")?.split_once(':')?;
    let shaped = pid.bytes().all(|b| b.is_ascii_digit())
        && !pid.starts_with('0')
        && !pid.is_empty()
        && (1..=64).contains(&start.len())
        && start
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'-');
    shaped.then_some(pid)
}

/// a launch file `write_muse_launch` left, removed while it still holds what was written
pub struct LaunchFile {
    path: String,
    text: String,
}

impl LaunchFile {
    pub fn remove(self) {
        if read_owned_file(&self.path).is_ok_and(|text| text == self.text) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// `launch` as `JSON.stringify({ process: key, ...launch })` writes it
pub fn launch_text(key: &str, launch: &MuseLaunch) -> String {
    let fields = [
        ("name", &launch.name),
        ("grant", &launch.grant),
        ("under", &launch.under),
        ("session", &launch.session),
        ("launcher", &launch.launcher),
    ];
    let mut parts = vec![format!("\"process\":{}", js_string(key))];
    for (field, value) in fields {
        if let Some(value) = value {
            parts.push(format!("\"{field}\":{}", js_string(value)));
        }
    }
    format!("{{{}}}", parts.join(","))
}

/// leaves `launch` for the muse process `key`, whose shim and hooks Muse starts without SCP_* variables
pub fn write_muse_launch(key: &str, launch: &MuseLaunch, env: &Env) -> std::io::Result<LaunchFile> {
    let Some(pid) = binding_pid(key) else {
        return Err(std::io::Error::other(format!(
            "muse serve has no process key ({key})"
        )));
    };
    let dir = join(&[&relay_dir(env), "launch"]);
    private_dir(&dir)?;
    let path = join(&[&dir, &format!("muse-{pid}.json")]);
    let text = launch_text(key, launch);
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, text.as_bytes()))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(LaunchFile { path, text })
}
