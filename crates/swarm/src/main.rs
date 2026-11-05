use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use clap::Parser;
use scp_broker::daemon::{self, DEFAULT_IDLE_S, idle_seconds};
use scp_broker::paths::Paths;

const VERSION: &str = env!("SWARM_VERSION");
const USAGE: &str = "usage:
  swarm daemon [--idle DURATION] [--policy FILE]   run the broker in the foreground
  swarm daemon stop|restart                        stop the running broker, or replace it with a fresh one
  swarm hook <harness> [args]                      run a harness hook (also [launcher...] hook <args>)
  swarm mcp                                        the MCP server
  swarm __verbs [--json]                           the CLI verbs this binary runs; any other goes to the swarm CLI
  swarm --version";

#[derive(Parser)]
#[command(name = "swarm daemon", no_binary_name = true)]
struct Daemon {
    /// stop or restart
    action: Option<String>,
    #[arg(long, value_parser = idle_seconds)]
    idle: Option<f64>,
    #[arg(long)]
    policy: Option<PathBuf>,
}

const HOST: scp_cli::Host = scp_cli::Host {
    daemon: daemon_command,
    beside: beside_cli,
};

fn beside_cli(env: &std::collections::HashMap<String, String>) -> Option<Vec<String>> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let env: BTreeMap<String, String> = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    scp_broker::launch::beside_package(&exe, &env)
}

fn main() {
    scp_cli::startup();
    let origin = scp_hook::now();
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let code = match args.first().map(String::as_str) {
        Some(_) if scp_cli::routed() => scp_cli::main(&args, &HOST),
        Some("--version" | "-V") => {
            let _ = writeln!(std::io::stdout(), "swarm {VERSION}");
            0
        }
        Some("--help" | "-h" | "help") => {
            let _ = writeln!(std::io::stdout(), "{USAGE}");
            0
        }
        Some("daemon") => daemon_command(&args[1..]),
        Some("mcp") => {
            if let Ok(exe) = std::env::current_exe() {
                scp_mcp::spawn::set_native_daemon(exe);
            }
            scp_mcp::main(&args[1..])
        }
        Some("spawn") => scp_cli::main(&args, &HOST),
        _ if runs_hook(&args) => {
            scp_hook::entry(origin, &args);
            0
        }
        Some(_) => scp_cli::main(&args, &HOST),
        None => {
            eprintln!("{USAGE}");
            2
        }
    };
    std::process::exit(code);
}

/// whether `args` run a hook: `hook` as the verb, or after the launcher a hook command names, one or two words that are `swarm` or
/// paths (the CLI's binary, or node and its script)
fn runs_hook(args: &[String]) -> bool {
    let launcher = |word: &String| word == scp_core::protocol::CLI_NAME || word.contains('/');
    match args.iter().position(|arg| arg == "hook") {
        Some(at) if at <= 2 => args[..at].iter().all(launcher),
        _ => false,
    }
}

fn daemon_command(args: &[String]) -> i32 {
    if std::env::var("SCP_NATIVE").is_ok_and(|mode| mode == "mcp") {
        eprintln!(
            "swarm: SCP_NATIVE=mcp keeps the TypeScript broker, so this native swarm runs no broker; start it with the swarm CLI (swarm daemon), or set SCP_NATIVE=1 for the native one"
        );
        return 2;
    }
    let options = match Daemon::try_parse_from(args) {
        Ok(options) => options,
        Err(error) => {
            let _ = error.print();
            return 2;
        }
    };
    match options.action.as_deref() {
        None => foreground(options),
        Some(action @ ("stop" | "restart"))
            if options.idle.is_none() && options.policy.is_none() =>
        {
            match control(action == "restart") {
                Ok(line) => {
                    println!("{line}");
                    0
                }
                Err(error) => {
                    eprintln!("swarm: {error}");
                    1
                }
            }
        }
        Some(_) => {
            eprintln!(
                "swarm daemon takes stop or restart, or --idle and --policy to run in the foreground"
            );
            2
        }
    }
}

fn foreground(options: Daemon) -> i32 {
    let idle = match options.idle {
        Some(idle) => idle,
        None => match std::env::var("SCP_IDLE") {
            Ok(raw) => match idle_seconds(&raw) {
                Ok(idle) => idle,
                Err(error) => {
                    eprintln!("swarm: SCP_IDLE: {error}");
                    return 2;
                }
            },
            Err(_) => DEFAULT_IDLE_S,
        },
    };
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("swarm broker: {error}");
            return 1;
        }
    };
    if let Ok(exe) = std::env::current_exe() {
        scp_broker::launch::set_native_verbs(exe, scp_cli::native_verbs());
    }
    match runtime.block_on(daemon::run(idle, options.policy)) {
        Ok(()) => 0,
        Err(error) if daemon::already_runs(error.as_ref()) => {
            eprintln!("swarm broker: {error}");
            0
        }
        Err(error) => {
            eprintln!("swarm broker: {error}");
            1
        }
    }
}

fn control(restart: bool) -> Result<String, Box<dyn std::error::Error>> {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let paths = Paths::from_env(&env)?;
    let script = scp_cli::daemon::cli_script(&env.clone().into_iter().collect()).or_else(|| {
        scp_broker::launch::recorded(&paths.dir).and_then(scp_cli::daemon::launcher_script)
    });
    let stopped = scp_cli::daemon::stop(&paths.dir, script.as_deref())?;
    if !restart {
        return Ok(match stopped {
            None => "no relay broker runs".into(),
            Some(pid) => {
                format!("stopped the relay broker (pid {pid}); the next command starts a fresh one")
            }
        });
    }
    let pid = start_detached(&paths)?;
    Ok(match stopped {
        None => format!("started a fresh one (pid {pid})"),
        Some(old) => format!("replaced the relay broker (pid {old}) with a fresh one (pid {pid})"),
    })
}

/// starts `swarm daemon` for `paths` detached, its output in broker.log, and waits until it serves
fn start_detached(paths: &Paths) -> Result<i32, Box<dyn std::error::Error>> {
    std::fs::create_dir_all(&paths.dir)?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(paths.dir.join("broker.log"))?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("daemon")
        .env("SCP_DIR", &paths.dir)
        .current_dir(&paths.dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // SAFETY: setsid is async-signal-safe and detaches the child from this terminal
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = command.spawn()?;
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if std::os::unix::net::UnixStream::connect(&paths.socket).is_ok()
            && let Some(pid) = daemon::broker_pid(&paths.dir)
        {
            return Ok(pid);
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the relay broker (pid {}) did not start within 12 s; see {}",
                child.id(),
                paths.dir.join("broker.log").display()
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::runs_hook;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn a_hook_runs_only_as_the_verb_or_after_a_launcher() {
        for hook in [
            &["hook", "claude"][..],
            &["swarm", "hook", "claude"],
            &["/opt/bin/swarm", "hook", "codex", "--cowork-only"],
            &["/usr/bin/node", "/opt/cli/dist/cli.js", "hook", "agy"],
        ] {
            assert!(runs_hook(&words(hook)), "{hook:?}");
        }
        for verb in [
            &["send", "x", "hook"][..],
            &["send", "hook"],
            &["list", "--as", "hook"],
            &["swarm", "send", "hook"],
            &["/opt/bin/swarm", "/opt/cli.js", "/x", "hook"],
            &["set-now", "fixing", "the", "hook"],
        ] {
            assert!(!runs_hook(&words(verb)), "{verb:?}");
        }
    }
}
