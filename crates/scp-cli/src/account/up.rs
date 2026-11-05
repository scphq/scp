//! `swarm up`: logs in when needed, links the broker to the hub, installs the hooks and MCP mounts, and starts the broker.

use super::cloud::{enable, relink_broker};
use super::login::{Values, sign_in};
use super::relay::{active_relay, env_token, relay_credential};
use crate::fleet::json::Json;
use crate::fleet::view::{text, truthy};
use crate::setup::command::{SetupOptions, relay_setup};
use crate::setup::harness::{SETUP_HARNESSES, detect_harnesses, detect_t3};
use crate::spawn::argv::which_on_path;
use crate::term::out;
use crate::{Call, Done, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::identity::safe_cwd;

/// how each harness starts so peer messages wake it, not only reach it at its next turn boundary
fn wake_launch() -> [(&'static str, String); 7] {
    [
        (
            "claude",
            format!("{CLI_NAME} claude --name <name>     Claude Code with the scp channel: messages wake it"),
        ),
        (
            "codex",
            format!("{CLI_NAME} codex --name <name>      messages start or steer its turns"),
        ),
        (
            "pi",
            format!("{CLI_NAME} pi --name <name>         messages arrive as turns"),
        ),
        (
            "opencode",
            "opencode                          its scp plugin wakes an idle session (on by default)".to_owned(),
        ),
        (
            "agy",
            format!("{CLI_NAME} agy --name <name>        headless: each message resumes its conversation"),
        ),
        (
            "grok",
            format!("{CLI_NAME} grok --name <name>       headless: each message resumes its session"),
        ),
        (
            "t3code",
            format!("{CLI_NAME} t3code --thread <id>    T3 Code: messages start or steer the thread's turns"),
        ),
    ]
}

/// what `swarm up` prints last: the wake-enabled launch of each installed harness, and the fallback for a running session
fn next_steps(installed: &[&str]) -> Vec<String> {
    let mut lines = vec!["next: start each agent session wake-enabled:".to_owned()];
    lines.extend(
        wake_launch()
            .iter()
            .filter(|(harness, _)| installed.contains(harness))
            .map(|(_, line)| format!("  {line}")),
    );
    lines.push(format!(
        "  {CLI_NAME} join <name>                 in a session already running: it sees messages only at turn boundaries until relaunched as above"
    ));
    lines.push(format!(
        "  {CLI_NAME} setup                       checks the hooks and MCP mounts (it lists nothing to do once they are installed)"
    ));
    lines
}

/// `swarm up [--token T] [--label L] [--machine NAME] [--no-browser]`
pub fn up(call: &Call) -> Done {
    let flags = &call.parsed;
    let env = call.env;
    if !flags.positionals.is_empty() {
        return Err(usage(format!("{CLI_NAME} up takes only flags")));
    }
    let (url, _) = active_relay(env)?;
    let headless = flags.has("token") || env_token(env).is_some();
    if headless || relay_credential(env, &url)?.token.is_none() {
        let values = Values {
            token: flags.text("token"),
            label: flags.text("label"),
            no_browser: flags.on("no-browser"),
            json: false,
        };
        let code = crate::open::block_on(sign_in(env, &values))??;
        if code != 0 {
            return Ok(code);
        }
    } else {
        out(&format!("already logged in to {url}"));
    }
    enable(flags.text("machine"), false, env)?;
    let options = SetupOptions {
        write: true,
        ..SetupOptions::default()
    };
    let mut setup_env = env.clone();
    crate::route::caller_argv(&mut setup_env);
    let code = relay_setup(&options, setup_env, &safe_cwd())?;
    if code != 0 {
        return Ok(code);
    }
    let broker: Json = crate::open::block_on(relink_broker(env))??;
    if !truthy(broker.get("enabled")) {
        out(&format!(
            "the broker is still local-only; run `{CLI_NAME} daemon restart` to link it to {url}"
        ));
    } else {
        let linked = match broker.get("url") {
            None | Some(Json::Null) => url.clone(),
            some => text(some),
        };
        let state = if truthy(broker.get("connected")) {
            ""
        } else {
            " (connecting)"
        };
        out(&format!("broker linked to {linked}{state}"));
    }
    let which = |name: &str| which_on_path(name, env);
    let found = detect_harnesses(env, &which);
    let mut installed: Vec<&str> = SETUP_HARNESSES
        .iter()
        .filter(|harness| found.contains_key(*harness))
        .copied()
        .collect();
    if which("pi").is_some() {
        installed.push("pi");
    }
    if detect_t3(env, &which).is_some() {
        installed.push("t3code");
    }
    out("");
    for line in next_steps(&installed) {
        out(&line);
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_launches_are_those_of_what_is_installed() {
        let lines = next_steps(&["codex", "opencode"]);
        assert_eq!(lines.len(), 5);
        assert!(lines[1].starts_with("  swarm codex --name"));
        assert!(lines[2].starts_with("  opencode "));
    }
}
