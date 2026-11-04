//! The swarm CLI verbs, natively: what the TypeScript router hands the `swarm` binary under `SCP_NATIVE=1`.
//!
//! Each area owns a module and lists its verbs in `VERBS`; the registry (`swarm __verbs --json`) is their union. A verb this binary
//! does not run, or a flag it does not cover yet, goes to the TypeScript CLI (`SCP_CLI_ARGV`, else the one beside the native package).

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
}

/// a verb's failure, printed as the TypeScript CLI prints it
#[derive(Debug, Clone, PartialEq)]
pub enum Fail {
    /// a usage error: the message, then where usage is
    Usage(String),
    /// a broker refusal or a connection failure
    Call(CallError),
    /// the TypeScript CLI takes over, for the reason given
    Decline(String),
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
    let Some((name, rest)) = hoisted.split_first() else {
        return route::fallback(args, "", "usage", &env, host);
    };
    let Some(spec) = verb(name) else {
        return route::fallback(args, name, "unported", &env, host);
    };
    if let Some(reason) = route::declined(name, rest, &env) {
        return route::fallback(args, name, &reason, &env, host);
    }
    route::log(name, "native", "run");
    let parsed = match args::parse_verb(name, rest) {
        Ok(parsed) => parsed,
        Err(message) => return report(Fail::Usage(message)),
    };
    let call = Call {
        verb: name,
        parsed,
        env: &env,
        host,
    };
    let done = match &spec.run {
        Run::Parsed(run) => run(&call),
        Run::Opened(run) => open::with_opened(&call, *run),
    };
    match done {
        Ok(code) => code,
        Err(Fail::Decline(reason)) => route::fallback(args, name, &reason, &env, host),
        Err(fail) => report(fail),
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
        Fail::Decline(reason) => term::note(&format!("declined: {reason}")),
    }
    term::FAILED
}

/// `swarm __verbs [--json]`: the verbs this binary runs, and what it hands back even then
fn registry(args: &[String]) -> i32 {
    let verbs = native_verbs();
    if args.iter().any(|a| a == "--json") {
        let verbs = Value::from(verbs);
        let declines = Value::from(route::DECLINE_FLAGS.to_vec());
        let env = Value::from(
            route::DECLINE_ENV
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>(),
        );
        let version = Value::from(VERSION);
        term::json_entries(&[
            ("version", &version),
            ("verbs", &verbs),
            ("declines", &declines),
            ("decline_env", &env),
        ]);
    } else {
        for name in verbs {
            term::out(name);
        }
    }
    0
}
