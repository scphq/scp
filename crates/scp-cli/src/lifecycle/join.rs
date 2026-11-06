//! `swarm join [<handle>]`: puts the harness session that runs this shell on the relay, as its hooks would claim it (`join.ts`).

use crate::fleet::json::Json;
use crate::fleet::result_of;
use crate::fleet::view::{text, truthy};
use crate::open::{PS_UNREAD, connect_shell, local_handle, runtime, walk};
use crate::term::out;
use crate::{Call, Done, Fail, route, usage};
use scp_core::protocol::{CLI_NAME, PROTOCOL};
use scp_mcp::Claim;
use scp_mcp::client::relay_dir;
use scp_mcp::identity::{
    CODEX_THREAD_KEY, IdentityInput, codex_shell, hook_format, joins_only, relay_identity,
    safe_cwd, session_key,
};
use scp_mcp::membership::read_session_marker;
use scp_mcp::ps::{Env, SHELL_PS_TIMEOUT_MS, Table, harness_at, read_ps_table};
use serde_json::{Map, Value, json};
use std::rc::Rc;

/// the MCP tool that joins from outside a codex sandbox, as the usage errors name it
pub fn join_tool(handle: Option<&str>, under: Option<&str>) -> String {
    let under = under.filter(|u| !u.is_empty());
    let args: Vec<String> = [
        handle.map(|h| format!("name: \"{h}\"")),
        under.map(|u| format!("under: \"{u}\"")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let args = if args.is_empty() {
        String::new()
    } else {
        format!(" {{{}}}", args.join(", "))
    };
    format!("relay_join{args} (MCP)")
}

/// a harness process key `pid:<pid>:<start>` split, as `/^pid:(\d+):(.+)$/` matches it
pub fn process_key(key: &str) -> Option<(i64, String)> {
    let (pid, start) = key.strip_prefix("pid:")?.split_once(':')?;
    let terminator = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if start.is_empty() || start.contains(terminator) {
        return None;
    }
    Some((pid.parse().ok()?, start.to_owned()))
}

struct Session {
    pid: i64,
    start: String,
    keys: Vec<String>,
    key: String,
    table: Table,
}

fn identify(session: &Session, known: Option<String>, call: &Call, cwd: &str) -> Claim {
    let mut env: Env = call.env.clone();
    env.remove("SCP_HARNESS_ORIGIN");
    let at = session
        .keys
        .iter()
        .position(|k| *k == session.key)
        .unwrap_or(0);
    let lineage = session.keys[at..].to_vec();
    let (pid, start) = (session.pid, session.start.clone());
    let (table, infer_table) = (session.table.clone(), session.table.clone());
    let infer_env = env.clone();
    relay_identity(&IdentityInput {
        state_dir: None,
        as_: known.filter(|k| !k.is_empty()),
        harness: call.parsed.text("harness").map(str::to_owned),
        fallback_harness: "cli".into(),
        cwd: cwd.to_owned(),
        env,
        harness_pid: Rc::new(move |_| pid),
        infer_harness: Some(Rc::new(move |at| {
            harness_at(at, infer_table.as_deref(), &infer_env).map(str::to_owned)
        })),
        start_of: Some(Rc::new(move |_| Some(start.clone()))),
        lineage_of: Some(Rc::new(move |_| lineage.clone())),
        harness_session: None,
        t3_hosted: None,
        ps_table: Some(Rc::new(move || table.clone())),
    })
}

pub fn join(call: &Call) -> Done {
    let words = &call.parsed.positionals;
    if words.len() > 1 {
        return Err(usage(format!(
            "{CLI_NAME} join takes one handle, or none to keep the session's name"
        )));
    }
    let handle = words.first().map(|w| local_handle(w)).transpose()?;
    let under = call.parsed.text("under");
    let tool = join_tool(handle.as_deref(), under);
    let table: Table = read_ps_table(SHELL_PS_TIMEOUT_MS).map(Rc::new);
    let here = walk(call.env, route::shell_pid(), table.clone());
    let key = here.own.last().cloned();
    let Some((key, (pid, start))) = key.and_then(|k| process_key(&k).map(|m| (k, m))) else {
        if here.unread {
            return Err(usage(format!("{CLI_NAME} join: {PS_UNREAD}")));
        }
        if codex_shell(call.env) {
            return Err(usage(format!(
                "{CLI_NAME} join: the codex sandbox hides the harness; use {tool} instead"
            )));
        }
        return Err(usage(format!(
            "{CLI_NAME} join runs in an agent session's shell: no harness process runs this shell"
        )));
    };
    let dir = relay_dir(call.env).to_string_lossy().into_owned();
    let marked = |session: &str| read_session_marker(&dir, session).and_then(|m| m.handle);
    let session = Session {
        pid,
        start,
        keys: here.keys,
        key,
        table,
    };
    let cwd = safe_cwd();
    let keyed = identify(
        &session,
        marked(&session_key(call.env, &session.key)),
        call,
        &cwd,
    );
    let keyed_session = keyed
        .get("session")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut claim = if keyed_session.starts_with(CODEX_THREAD_KEY) {
        identify(&session, marked(&keyed_session), call, &cwd)
    } else {
        keyed
    };
    let harness = claim
        .get("harness")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if joins_only(call.env, hook_format(harness, harness)) {
        claim.insert("join_only".into(), Value::Bool(true));
    }
    let mut joining = Map::new();
    if let Some(handle) = &handle {
        joining.insert("handle".into(), Value::from(handle.as_str()));
    }
    if let Some(under) = under.filter(|u| !u.is_empty()) {
        joining.insert("under".into(), Value::from(under));
    }
    let hello = json!({
        "protocol": PROTOCOL,
        "capabilities": [],
        "transient": true,
        "claim": Value::Object(claim),
        "join": Value::Object(joining),
    });
    if let Ok(exe) = std::env::current_exe() {
        scp_mcp::spawn::set_native_daemon(exe);
    }
    let runtime = runtime()?;
    let local = tokio::task::LocalSet::new();
    let view = local.block_on(&runtime, async {
        let client = connect_shell(&dir, call.env, &tool).await?;
        let reply = client.request_line("hello", hello).await;
        client.close();
        let result = result_of(&reply?)?;
        Ok::<Json, Fail>(result.get("endpoint").cloned().unwrap_or(Json::Null))
    });
    drop(local);
    runtime.shutdown_background();
    let view = view?;
    if call.parsed.on("json") {
        out(&view.pretty());
    } else {
        let parent = view.get("parent");
        let under = if truthy(parent) {
            format!(" under {}", text(parent))
        } else {
            String::new()
        };
        out(&format!(
            "joined as {}{under}: peers can message it, and its hooks hand it new messages at turn boundaries",
            text(view.get("address"))
        ));
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_names_the_handle_and_parent_given() {
        assert_eq!(join_tool(None, None), "relay_join (MCP)");
        assert_eq!(join_tool(None, Some("")), "relay_join (MCP)");
        assert_eq!(join_tool(Some("w"), None), "relay_join {name: \"w\"} (MCP)");
        assert_eq!(
            join_tool(Some("w"), Some("lead")),
            "relay_join {name: \"w\", under: \"lead\"} (MCP)"
        );
        assert_eq!(
            join_tool(None, Some("lead")),
            "relay_join {under: \"lead\"} (MCP)"
        );
    }

    #[test]
    fn a_process_key_needs_a_pid_and_a_start() {
        assert_eq!(
            process_key("pid:42:Mon Nov  3 10:00:00 2026"),
            Some((42, "Mon Nov  3 10:00:00 2026".into()))
        );
        assert_eq!(process_key("pid:42"), None);
        assert_eq!(process_key("pid:42:"), None);
        assert_eq!(process_key("pid::x"), None);
        assert_eq!(process_key("pid:4x:y"), None);
        assert_eq!(process_key("pid:4:a\nb"), None);
        assert_eq!(process_key("env:x"), None);
    }
}
