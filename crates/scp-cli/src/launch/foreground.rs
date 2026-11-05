//! `swarm opencode` and `swarm pi`: the harness in the foreground, its exit code handed on.

use super::attribute::{Placement, attribute, attributed, has_flag, validate_under};
use super::channel::{default_signals, spawn_error};
use crate::args::js_string;
use crate::fleet::mounts::{mcp_file, mounted_entry};
use crate::open::{block_on, node_fs_error};
use crate::setup::hook_cmd::{HookLaunch, opencode_plugin};
use crate::setup::hooks_install::hooks_target;
use crate::spawn::argv::which_on_path;
use crate::spawn::signals::Listener;
use crate::{Call, Done, Fail, route, term, usage};
use scp_core::address::valid_handle;
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::CallError;
use scp_mcp::identity::{git_toplevel, private_dir, relay_dir, safe_cwd};
use scp_mcp::ps::{Env, dirname, join};
use std::os::unix::fs::OpenOptionsExt;
use std::process::Stdio;

/// a harness run to its end: the argv and environment, and how it was asked to be placed
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Foreground {
    pub name: Option<String>,
    pub root: bool,
    pub under: Option<String>,
    pub argv: Vec<String>,
    pub env: Env,
}

/// the leading `--under VALUE` of `arg`, its value and how many words it took
fn under_of(args: &[String], i: usize) -> Result<(String, usize), Fail> {
    let arg = &args[i];
    if arg == "--under" {
        let value = args.get(i + 1).cloned();
        return Ok((value.ok_or_else(|| usage("--under takes an address"))?, 2));
    }
    Ok((arg["--under=".len()..].to_owned(), 1))
}

/// the name without its `me/`, checked
fn named(name: Option<String>) -> Result<Option<String>, Fail> {
    let name = name.map(|name| name.strip_prefix("me/").unwrap_or(&name).to_owned());
    if let Some(name) = &name
        && !valid_handle(name)
    {
        return Err(usage(format!(
            "{} is not a valid agent handle",
            js_string(name)
        )));
    }
    Ok(name)
}

/// the opencode argv and the env it runs with: the name becomes $SCP_NAME, the harness opencode, wake on
pub fn opencode_launch(args: &[String], env: &Env, bin: &str) -> Result<Foreground, Fail> {
    let mut parsed = Foreground::default();
    let mut rest: Vec<String> = Vec::new();
    let mut name = None;
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        if arg == "--" {
            rest.extend_from_slice(&args[i + 1..]);
            break;
        }
        if arg == "--name" || arg == "--as" {
            i += 1;
            let Some(given) = args.get(i) else {
                return Err(usage(format!("{CLI_NAME} opencode {arg} takes a name")));
            };
            name = Some(given.clone());
        } else if arg.starts_with("--name=") || arg.starts_with("--as=") {
            name = Some(arg[arg.find('=').unwrap_or(0) + 1..].to_owned());
        } else if arg == "--under" || arg.starts_with("--under=") {
            let (under, words) = under_of(args, i)?;
            parsed.under = Some(under);
            i += words - 1;
        } else if arg == "--root" {
            parsed.root = true;
        } else {
            rest.push(arg.clone());
        }
        i += 1;
    }
    validate_under(parsed.under.as_deref(), parsed.root)?;
    parsed.name = named(name)?;
    parsed.argv = std::iter::once(bin.to_owned()).chain(rest).collect();
    let mut vars = env.clone();
    vars.insert("SCP_HARNESS".into(), "opencode".into());
    vars.insert("SCP_WAKE".into(), "1".into());
    if let Some(name) = &parsed.name {
        vars.insert("SCP_NAME".into(), name.clone());
    }
    parsed.env = vars;
    Ok(parsed)
}

/// the plugin file OpenCode would load for `cwd`, and whether it is the one this CLI writes
fn plugin_state(env: &Env, cwd: &str) -> (Option<String>, bool) {
    let launch = HookLaunch::default();
    let current = [
        opencode_plugin(false, &launch),
        opencode_plugin(true, &launch),
    ];
    let files: Vec<String> = ["project", "user"]
        .iter()
        .map(|scope| hooks_target("opencode", scope, env, cwd))
        .filter(|file| std::fs::metadata(file).is_ok())
        .collect();
    for file in &files {
        if let Ok(bytes) = std::fs::read(file)
            && current.contains(&String::from_utf8_lossy(&bytes).into_owned())
        {
            return (Some(file.clone()), true);
        }
    }
    (files.into_iter().next(), false)
}

/// the error that stops a launch without a current plugin
pub fn plugin_problem(env: &Env, cwd: &str) -> Option<String> {
    let (file, current) = plugin_state(env, cwd);
    if current {
        return None;
    }
    let fix = format!(
        "run {CLI_NAME} setup --write (or {CLI_NAME} hooks install --harness opencode --scope user --write)"
    );
    Some(match file {
        Some(file) => format!(
            "{CLI_NAME} opencode: {file} is not this {CLI_NAME}'s plugin, so wake is not guaranteed; {fix}"
        ),
        None => format!(
            "{CLI_NAME} opencode: OpenCode has no {CLI_NAME} plugin, so messages would not wake it; {fix}"
        ),
    })
}

/// a one-line hint when neither the user's nor the project's OpenCode config mounts the scp MCP server
pub fn opencode_mount_hint(env: &Env, cwd: &str) -> Option<String> {
    let project = git_toplevel(cwd).unwrap_or_else(|| cwd.to_owned());
    let files = [
        mcp_file("opencode", env),
        join(&[&project, "opencode.json"]),
        join(&[&project, "opencode.jsonc"]),
    ];
    let mounted = files.iter().any(|file| {
        std::fs::metadata(file).is_ok() && matches!(mounted_entry("opencode", file), Ok(Some(_)))
    });
    (!mounted).then(|| {
        format!(
            "{CLI_NAME} opencode: OpenCode has no scp MCP mount, so the session has no relay tools; run {CLI_NAME} setup --write"
        )
    })
}

/// runs `argv` with the terminal passed through, handing on SIGTERM and SIGHUP; a signal that ended it counts as 1
async fn run_foreground(argv: &[String], env: &Env) -> Done {
    let mut command = std::process::Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .env_clear()
        .envs(env)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    default_signals(&mut command);
    let mut child = tokio::process::Command::from(command)
        .spawn()
        .map_err(|error| {
            usage(format!(
                "could not start {}: {}",
                argv[0],
                spawn_error(&argv[0], &error)
            ))
        })?;
    let pid = child.id().map_or(0, |pid| pid as i32);
    let mut signals = Listener::new(&[libc::SIGINT, libc::SIGTERM, libc::SIGHUP]);
    loop {
        tokio::select! {
            status = child.wait() => {
                return Ok(status.map_or(1, super::exit_code));
            }
            signal = signals.recv() => {
                if signal != libc::SIGINT {
                    // SAFETY: signals the child it started and has not reaped
                    unsafe { libc::kill(pid, signal) };
                }
            }
        }
    }
}

/// `swarm opencode`: runs OpenCode in the foreground, wake on, exiting with its code
pub fn opencode(call: &Call, args: &[String]) -> Done {
    let own = super::attribute::options_before(args);
    if own.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Err(Fail::Decline("help".into()));
    }
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let mut env = call.env.clone();
    route::caller_argv(&mut env);
    let cwd = safe_cwd();
    let bin = env
        .get("SCP_OPENCODE_BIN")
        .filter(|bin| !bin.is_empty())
        .cloned()
        .or_else(|| which_on_path("opencode", &env));
    let Some(bin) = bin else {
        return Err(usage(format!(
            "opencode is not on PATH: install it with npm i -g opencode-ai, then run {CLI_NAME} setup --write"
        )));
    };
    let parsed = opencode_launch(args, &env, &bin)?;
    if let Some(problem) = plugin_problem(&env, &cwd) {
        return Err(usage(problem));
    }
    if let Some(hint) = opencode_mount_hint(&env, &cwd) {
        term::err(&hint);
    }
    let resume = has_flag(&parsed.argv[1..], &["-c", "--continue", "-s", "--session"]);
    block_on(async {
        let warn = |line: &str| term::err(line);
        let placement = Placement {
            name: parsed.name.as_deref(),
            root: parsed.root,
            under: parsed.under.as_deref(),
            resume,
            dir: None,
        };
        let attribution = attribute("opencode", placement, call.env, &cwd, &warn).await?;
        let launch = match &attribution {
            Some(attribution) => opencode_launch(args, &attributed(&env, Some(attribution)), &bin)?,
            None => parsed.clone(),
        };
        run_foreground(&launch.argv, &launch.env).await
    })?
}

/// the pi argv and the env it runs with: a leading name becomes $SCP_NAME, the harness pi, and everything after it goes to pi untouched
pub fn pi_launch(args: &[String], env: &Env, extension: &str) -> Result<Foreground, Fail> {
    let mut parsed = Foreground::default();
    let mut name = None;
    let mut i = 0;
    while let Some(arg) = args.get(i) {
        if arg == "--name" || arg == "--as" {
            i += 1;
            let Some(given) = args.get(i) else {
                return Err(usage(format!("{CLI_NAME} pi {arg} takes a name")));
            };
            name = Some(given.clone());
        } else if arg.starts_with("--name=") || arg.starts_with("--as=") {
            name = Some(arg[arg.find('=').unwrap_or(0) + 1..].to_owned());
        } else if arg == "--under" || arg.starts_with("--under=") {
            let (under, words) = under_of(args, i)?;
            parsed.under = Some(under);
            i += words - 1;
        } else if arg == "--root" {
            parsed.root = true;
        } else {
            break;
        }
        i += 1;
    }
    if args.get(i).is_some_and(|arg| arg == "--") {
        i += 1;
    }
    let rest = &args[i.min(args.len())..];
    validate_under(parsed.under.as_deref(), parsed.root)?;
    parsed.name = named(name)?;
    let bin = env
        .get("SCP_PI_BIN")
        .filter(|bin| !bin.is_empty())
        .map_or("pi", String::as_str);
    parsed.argv = vec![
        bin.to_owned(),
        "--extension".to_owned(),
        extension.to_owned(),
    ];
    parsed.argv.extend_from_slice(rest);
    let mut vars = env.clone();
    vars.insert("SCP_HARNESS".into(), "pi".into());
    if let Some(name) = &parsed.name {
        vars.insert("SCP_NAME".into(), name.clone());
    }
    parsed.env = vars;
    Ok(parsed)
}

/// the extension the TypeScript CLI bundles, kept in step with it by a test
const PI_EXTENSION: &str = include_str!("pi-extension.txt");

/// the embedded extension as a file under the relay directory, written when it is not there yet
fn embedded_extension(env: &Env) -> Result<String, Fail> {
    let dir = join(&[&relay_dir(env), "pi"]);
    let fail = |syscall: &'static str, path: String| {
        move |error: std::io::Error| {
            Fail::Call(CallError::Io(node_fs_error(&error, syscall, &path)))
        }
    };
    private_dir(&dir).map_err(fail("mkdir", dir.clone()))?;
    let file = join(&[&dir, &format!("extension-{}.js", crate::VERSION)]);
    if std::fs::read(&file).is_ok_and(|held| held == PI_EXTENSION.as_bytes()) {
        return Ok(file);
    }
    let temp = format!("{file}.{}", std::process::id());
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)
        .and_then(|mut out| std::io::Write::write_all(&mut out, PI_EXTENSION.as_bytes()))
        .map_err(fail("open", temp.clone()))?;
    std::fs::rename(&temp, &file).map_err(fail("rename", file.clone()))?;
    Ok(file)
}

/// the extension file: $SCP_PI_EXTENSION, else the one the CLI beside this binary bundles or the workspace package's source, as the
/// TypeScript CLI finds them, else the embedded one
fn extension_path(call: &Call, env: &Env) -> Result<String, Fail> {
    if let Some(file) = env.get("SCP_PI_EXTENSION").filter(|file| !file.is_empty()) {
        return Ok(file.clone());
    }
    let words = scp_mcp::spawn::named_launcher(call.env).or_else(|| (call.host.beside)(call.env));
    let script = words.as_ref().and_then(|words| words.last());
    if let Some(script) = script.filter(|script| script.starts_with('/')) {
        let dir = dirname(script);
        for candidate in [
            join(&[&dir, "pi-extension.js"]),
            scp_mcp::ps::resolve(&dir, "../../pi/src/index.ts"),
        ] {
            if std::fs::metadata(&candidate).is_ok() {
                return Ok(candidate);
            }
        }
    }
    embedded_extension(env)
}

/// `swarm pi`: runs pi in the foreground with the extension loaded, exiting with its code
pub fn pi(call: &Call, args: &[String]) -> Done {
    if matches!(args.first().map(String::as_str), Some("--help" | "-h")) {
        return Err(Fail::Decline("help".into()));
    }
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let mut env = call.env.clone();
    route::caller_argv(&mut env);
    let extension = extension_path(call, &env)?;
    let parsed = pi_launch(args, &env, &extension)?;
    let resume = has_flag(
        parsed.argv.get(3..).unwrap_or(&[]),
        &["-c", "--continue", "-r", "--resume", "--session"],
    );
    let cwd = safe_cwd();
    block_on(async {
        let warn = |line: &str| term::err(line);
        let placement = Placement {
            name: parsed.name.as_deref(),
            root: parsed.root,
            under: parsed.under.as_deref(),
            resume,
            dir: None,
        };
        let attribution = attribute("pi", placement, call.env, &cwd, &warn).await?;
        let launch = match &attribution {
            Some(attribution) => pi_launch(args, &attributed(&env, Some(attribution)), &extension)?,
            None => parsed.clone(),
        };
        run_foreground(&launch.argv, &launch.env).await
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(list: &[&str]) -> Vec<String> {
        list.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn opencode_takes_its_flags_anywhere_and_pi_only_leading() {
        let env = Env::new();
        let opencode =
            opencode_launch(&w(&["run", "--name=x", "--", "--name", "y"]), &env, "oc").unwrap();
        assert_eq!(opencode.name.as_deref(), Some("x"));
        assert_eq!(opencode.argv, w(&["oc", "run", "--name", "y"]));
        assert_eq!(opencode.env["SCP_WAKE"], "1");
        let pi = pi_launch(&w(&["--as", "me/x", "--name", "session"]), &env, "/e").unwrap();
        assert_eq!(pi.name.as_deref(), Some("session"));
        assert_eq!(pi.argv, w(&["pi", "--extension", "/e"]));
        let pi = pi_launch(&w(&["--model", "m", "--name", "session"]), &env, "/e").unwrap();
        assert_eq!(pi.name, None);
        assert_eq!(
            pi.argv,
            w(&[
                "pi",
                "--extension",
                "/e",
                "--model",
                "m",
                "--name",
                "session"
            ])
        );
        assert_eq!(
            pi_launch(&w(&["--name"]), &env, "/e"),
            Err(usage(format!("{CLI_NAME} pi --name takes a name")))
        );
        assert_eq!(
            opencode_launch(&w(&["--as"]), &env, "oc"),
            Err(usage(format!("{CLI_NAME} opencode --as takes a name")))
        );
    }

    #[test]
    fn the_embedded_extension_lands_once_with_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("scp-pi-{}", std::process::id()));
        let env = Env::from([("SCP_DIR".to_owned(), dir.to_string_lossy().into_owned())]);
        let file = embedded_extension(&env).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), PI_EXTENSION);
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::write(&file, "tampered").unwrap();
        assert_eq!(embedded_extension(&env).unwrap(), file);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), PI_EXTENSION);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
