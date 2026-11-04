//! The caller's own line: whoami, set-status, set-now, set-title and event.

use crate::fleet::json::Json;
use crate::fleet::{result_of, view};
use crate::open::Opened;
use crate::term::out;
use crate::{Call, Done, Run, Verb, usage};
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::render::presence_text;
use scp_mcp::tools::{get, js, truthy};
use serde_json::{Map, Value};

pub const VERBS: &[Verb] = &[
    Verb {
        name: "whoami",
        run: Run::Opened(whoami),
    },
    Verb {
        name: "set-status",
        run: Run::Opened(set_status),
    },
    Verb {
        name: "set-now",
        run: Run::Opened(set_now),
    },
    Verb {
        name: "set-title",
        run: Run::Opened(set_title),
    },
    Verb {
        name: "event",
        run: Run::Opened(event),
    },
];

/// a value in a template string, `undefined` when absent
fn field(value: &Value, key: &str) -> String {
    js(get(value, key))
}

/// `value ?? fallback` in a template string
fn or(value: &Value, key: &str, fallback: &str) -> String {
    match get(value, key) {
        None | Some(Value::Null) => fallback.into(),
        some => js(some),
    }
}

/// text an agent wrote, in double quotes so it reads as theirs
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn status_text(status: &Value) -> String {
    let note = get(status, "note");
    let tail = if truthy(note) {
        format!(": {}", quoted(&js(note)))
    } else {
        String::new()
    };
    format!("{}{tail}", field(status, "state"))
}

fn short_cwd(cwd: Option<&Value>, env: &scp_mcp::ps::Env) -> String {
    let home = env
        .get("HOME")
        .filter(|h| !h.is_empty())
        .cloned()
        .unwrap_or_else(scp_mcp::identity::home_dir);
    if !truthy(cwd) {
        return String::new();
    }
    let cwd = js(cwd);
    if cwd == home {
        return "~".into();
    }
    match cwd.strip_prefix(&format!("{home}/")) {
        Some(rest) => format!("~/{rest}"),
        None => cwd,
    }
}

/// an agent's depth as whoami shows it: depth counts its own machine's tree only
fn depth_text(e: &Value) -> String {
    let depth = or(e, "depth", "0");
    let parent = get(e, "parent");
    if truthy(parent) && js(parent).split('/').count() > 2 {
        format!("{depth} on this machine (parent on another machine)")
    } else {
        depth
    }
}

fn whoami<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let me = &opened.me;
        if !truthy(Some(me)) {
            return Err(usage(format!(
                "{CLI_NAME} whoami needs an identity: --as HANDLE or --human"
            )));
        }
        let kind = get(me, "kind").and_then(Value::as_str);
        let pending = if kind == Some("agent") && get(me, "parent") == Some(&Value::Null) {
            request(opened, "whoami", Map::new())
                .await
                .ok()
                .and_then(|reply| reply.get("link_pending").cloned())
                .filter(|p| view::truthy(Some(p)))
        } else {
            None
        };
        if call.parsed.on("json") {
            let bound = opened.bound.map_or(Json::Null, Json::str);
            let mut last = Vec::new();
            if let Some(pending) = &pending {
                last.push(("link_pending", pending.clone()));
            }
            last.push(("bound", bound));
            out(&Json::spread(vec![], &opened.endpoint, last).pretty());
            return Ok(0);
        }
        let pending = pending.map(|p| p.to_value());
        let harness = get(me, "harness");
        let harness = if truthy(harness) {
            format!(", {}", js(harness))
        } else {
            String::new()
        };
        out(&format!(
            "{} ({}{harness})",
            field(me, "address"),
            field(me, "kind")
        ));
        let how = match opened.bound {
            Some("as") => "--as",
            Some("lineage") => "this shell's harness process",
            Some("human") => "human inbox",
            _ => "-",
        };
        let status = get(me, "status").filter(|s| truthy(Some(s)));
        let mut fields: Vec<(&str, String)> = vec![
            ("presence", presence_text(me)),
            ("title", or(me, "title", "-")),
        ];
        if kind != Some("human") {
            fields.push(("status", status.map_or("-".into(), |s| or(s, "state", "-"))));
            let note = status
                .and_then(|s| get(s, "note"))
                .filter(|n| truthy(Some(n)));
            fields.push(("now", note.map_or("-".into(), |n| js(Some(n)))));
        }
        let cwd = short_cwd(get(me, "cwd"), call.env);
        fields.push(("cwd", if cwd.is_empty() { "-".into() } else { cwd }));
        if opened.bound != Some("as") {
            let pid = opened.harness_pid.filter(|p| *p != 0);
            fields.push(("harness pid", pid.map_or("-".into(), |p| p.to_string())));
        }
        let parent = match get(me, "parent") {
            None | Some(Value::Null) => match &pending {
                Some(p) => format!(
                    "root: not linked under {} yet ({}: {})",
                    field(p, "under"),
                    field(p, "code"),
                    field(p, "message")
                ),
                None => "root".into(),
            },
            some => js(some),
        };
        fields.push(("parent", parent));
        if kind == Some("agent") {
            fields.push(("depth", depth_text(me)));
        }
        fields.push(("bound", how.into()));
        for (label, value) in fields {
            out(&format!("{label:<12}{value}"));
        }
        Ok(0)
    })
}

/// a reply's result, its keys in the order the broker wrote them
async fn request(
    opened: &Opened,
    method: &str,
    params: Map<String, Value>,
) -> Result<Json, crate::Fail> {
    let line = opened
        .client
        .request_line(method, Value::Object(params))
        .await?;
    result_of(&line)
}

fn set_status<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let words = &call.parsed.positionals;
        let mut params = Map::new();
        if let Some(state) = words.first() {
            params.insert("state".into(), Value::from(state.as_str()));
        }
        params.insert(
            "note".into(),
            Value::from(words.get(1..).unwrap_or(&[]).join(" ")),
        );
        let view = request(opened, "status", params).await?;
        if call.parsed.on("json") {
            out(&view.pretty());
        } else {
            let view = view.to_value();
            let status = get(&view, "status").filter(|s| !s.is_null());
            let state = status.map_or("undefined".into(), |s| field(s, "state"));
            let note = status
                .and_then(|s| get(s, "note"))
                .filter(|n| truthy(Some(n)));
            let tail = note.map_or(String::new(), |n| format!(": {}", js(Some(n))));
            out(&format!("{}: {state}{tail}", field(&view, "address")));
        }
        Ok(0)
    })
}

fn set_now<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let words = &call.parsed.positionals;
        if words.is_empty() {
            return Err(usage(format!(
                "{CLI_NAME} set-now takes the text of what you are doing now"
            )));
        }
        let mut params = Map::new();
        params.insert("note".into(), Value::from(words.join(" ")));
        let view = request(opened, "status", params).await?;
        if call.parsed.on("json") {
            out(&view.pretty());
        } else {
            let view = view.to_value();
            let status = get(&view, "status").filter(|s| truthy(Some(s)));
            let text = status.map_or("-".into(), status_text);
            out(&format!("{}: {text}", field(&view, "address")));
        }
        Ok(0)
    })
}

fn set_title<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let words = &call.parsed.positionals;
        if words.is_empty() {
            return Err(usage(format!(
                "{CLI_NAME} set-title takes the title text (\"\" clears it)"
            )));
        }
        let mut params = Map::new();
        params.insert("text".into(), Value::from(words.join(" ")));
        let view = request(opened, "title", params).await?;
        if call.parsed.on("json") {
            out(&view.pretty());
        } else {
            let view = view.to_value();
            out(&format!(
                "{}: title {}",
                field(&view, "address"),
                or(&view, "title", "cleared")
            ));
        }
        Ok(0)
    })
}

fn event<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let mut params = Map::new();
        if let Some(kind) = call.parsed.positionals.first() {
            params.insert("kind".into(), Value::from(kind.as_str()));
        }
        for key in ["tool", "summary"] {
            if let Some(text) = call.parsed.text(key) {
                params.insert(key.into(), Value::from(text));
            }
        }
        let row = request(opened, "event", params).await?;
        if call.parsed.on("json") {
            out(&row.pretty());
        }
        Ok(0)
    })
}
