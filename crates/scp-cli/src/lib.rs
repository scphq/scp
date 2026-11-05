//! The swarm CLI verbs, natively: what the TypeScript router hands the `swarm` binary under `SCP_NATIVE=1`.
//!
//! Each area owns a module and lists its verbs in `VERBS`; the registry (`swarm __verbs --json`) is their union. Only `route::TS_VERBS`
//! go to the TypeScript CLI (`SCP_CLI_ARGV`, else the one beside the native package).

pub mod account;
pub mod args;
pub mod claude;
pub mod daemon;
pub mod fleet;
pub mod help;
pub mod launch;
pub mod lifecycle;
pub mod messages;
pub mod open;
pub mod own;
pub mod route;
pub mod scope;
pub mod setup;
pub mod spawn;
pub mod term;

use args::Parsed;
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::client::CallError;
use scp_mcp::ps::Env;
use serde_json::Value;

/// the version this binary was built for, which the router's registry check compares with the CLI's
pub const VERSION: &str = env!("SWARM_VERSION");

/// what the binary around this crate provides
pub struct Host {
    /// `swarm daemon <args>` as the native binary runs it, for the broker in the foreground
    pub daemon: fn(&[String]) -> i32,
    /// the TypeScript CLI beside this executable's native package, as the words that start it
    pub beside: fn(&Env) -> Option<Vec<String>>,
    /// `[launcher...] hook <args>` as the native binary runs it, for the given parent process
    pub hook: fn(&[String], i64) -> i32,
}

/// a verb's failure, printed as the TypeScript CLI prints it
#[derive(Debug, Clone, PartialEq)]
pub enum Fail {
    /// a usage error: the message, then where usage is
    Usage(String),
    /// a broker refusal or a connection failure
    Call(CallError),
}

impl From<CallError> for Fail {
    fn from(error: CallError) -> Self {
        Fail::Call(error)
    }
}

pub type Done = Result<i32, Fail>;

/// a usage error
pub fn usage(message: impl Into<String>) -> Fail {
    Fail::Usage(message.into())
}

/// one invocation: the verb, its parsed words and the environment
pub struct Call<'a> {
    pub verb: &'a str,
    pub parsed: Parsed,
    pub env: &'a Env,
    pub host: &'a Host,
}

/// how a verb runs
pub enum Run {
    /// on its parsed words
    Parsed(fn(&Call) -> Done),
    /// on its parsed words and a connection opened as the caller
    Opened(for<'a> fn(&'a Call<'a>, &'a open::Opened) -> LocalFuture<'a, Done>),
    /// on its words as given, which it parses itself: `Call::parsed` is empty
    Words(fn(&Call, &[String]) -> Done),
}

pub struct Verb {
    pub name: &'static str,
    pub run: Run,
}

const AREAS: [&[Verb]; 12] = [
    own::VERBS,
    daemon::VERBS,
    messages::VERBS,
    fleet::VERBS,
    scope::VERBS,
    lifecycle::VERBS,
    spawn::VERBS,
    claude::VERBS,
    launch::VERBS,
    account::VERBS,
    setup::VERBS,
    help::VERBS,
];

/// the verbs this binary runs, sorted
pub fn native_verbs() -> Vec<&'static str> {
    let mut names: Vec<&str> = AREAS
        .iter()
        .flat_map(|area| area.iter().map(|v| v.name))
        .collect();
    names.sort_unstable();
    names
}

fn verb(name: &str) -> Option<&'static Verb> {
    AREAS
        .iter()
        .flat_map(|area| area.iter())
        .find(|v| v.name == name)
}

/// reads and clears the router's variables; call first, before any thread or child starts
pub fn startup() {
    route::startup();
}

/// whether the TypeScript router handed this invocation over
pub fn routed() -> bool {
    route::routed()
}

/// `swarm <args>` for every word the binary does not take itself; returns the exit code
pub fn main(args: &[String], host: &Host) -> i32 {
    match args.first().map(String::as_str) {
        Some("__verbs") => return registry(&args[1..]),
        Some("__probe") => return open::probe(&args[1..]),
        _ => {}
    }
    let env: Env = std::env::vars().collect();
    let hoisted = args::hoist_identity(args);
    let (name, rest) = match hoisted.split_first() {
        Some((name, rest)) if !name.is_empty() => (name.as_str(), rest),
        Some((_, rest)) => ("--help", rest),
        None => ("--help", &[][..]),
    };
    let Some(spec) = verb(name) else {
        if route::TS_VERBS.contains(&name) {
            return route::fallback(args, name, "unported", &env, host);
        }
        route::log(name, "native", "unknown");
        return report(help::unknown(name));
    };
    route::log(name, "native", "run");
    match run_spec(spec, name, rest, &env, host) {
        Ok(code) => code,
        Err(fail) => report(fail),
    }
}

fn run_spec(spec: &Verb, name: &str, rest: &[String], env: &Env, host: &Host) -> Done {
    let parsed = match &spec.run {
        Run::Words(_) => Parsed::default(),
        _ => args::parse_verb(name, rest).map_err(Fail::Usage)?,
    };
    if parsed.has("help") {
        return help::show(name, parsed.on("all"));
    }
    let call = Call {
        verb: name,
        parsed,
        env,
        host,
    };
    match &spec.run {
        Run::Parsed(run) => run(&call),
        Run::Opened(run) => open::with_opened(&call, *run),
        Run::Words(run) => run(&call, rest),
    }
}

/// `swarm <name> <words>` run in this process, as the TypeScript CLI runs one verb from another: its failure returned, not printed
pub fn run_verb(name: &str, words: &[String], env: &Env, host: &Host) -> Done {
    match verb(name) {
        Some(spec) => run_spec(spec, name, words, env, host),
        None => Err(help::unknown(name)),
    }
}

/// prints `fail` as the TypeScript CLI's top level does, returning its exit code
pub fn report(fail: Fail) -> i32 {
    match fail {
        Fail::Usage(message) => {
            term::note(&message);
            term::note(&format!("run `{CLI_NAME} --help` for usage"));
        }
        Fail::Call(CallError::Relay {
            message,
            retry_after_s,
            ..
        }) => {
            term::note(&message);
            if let Some(retry) = retry_after_s.filter(|s| *s != 0.0 && !s.is_nan()) {
                term::note(&format!("retry in {} s", scp_mcp::tools::js_num(retry)));
            }
        }
        Fail::Call(CallError::Io(message)) => term::note(&message),
    }
    term::FAILED
}

/// `swarm __verbs [--json]`: the verbs this binary runs, and the ones it hands to the TypeScript CLI
fn registry(args: &[String]) -> i32 {
    let verbs = native_verbs();
    if args.iter().any(|a| a == "--json") {
        let verbs = Value::from(verbs);
        let ts_verbs = Value::from(route::TS_VERBS.to_vec());
        let version = Value::from(VERSION);
        term::json_entries(&[
            ("version", &version),
            ("verbs", &verbs),
            ("ts_verbs", &ts_verbs),
        ]);
    } else {
        for name in verbs {
            term::out(name);
        }
    }
    0
}
