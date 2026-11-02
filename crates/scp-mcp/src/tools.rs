//! The relay tools an MCP client sees, their argument checks, and the text their results read as.

use crate::render::{
    PREAMBLE, clock, js_space, list_of, presence_text, reach_lines, strings, wrap_message,
};
use scp_core::protocol::LIMITS;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

pub const MCP_PROTOCOLS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
pub const PEEK_TURNS_MAX: u64 = 10;

/// the tools as TOOLS lists them: one per line between the brackets
const TOOLS_JSON: &str = include_str!("../tools.json");

fn tool_lines() -> impl Iterator<Item = &'static str> {
    TOOLS_JSON
        .lines()
        .filter(|line| line.starts_with('{'))
        .map(|line| line.trim_end_matches(','))
}

fn tool_name(line: &str) -> Option<String> {
    let tool: Value = serde_json::from_str(line).ok()?;
    tool.get("name")?.as_str().map(str::to_string)
}

struct Listed {
    names: Vec<String>,
    json: String,
}

fn listed(spawn: bool) -> Listed {
    let lines: Vec<&str> = tool_lines()
        .filter(|line| spawn || tool_name(line).as_deref() != Some("relay_spawn"))
        .collect();
    Listed {
        names: lines.iter().filter_map(|line| tool_name(line)).collect(),
        json: format!("[{}]", lines.join(",")),
    }
}

static WITH_SPAWN: LazyLock<Listed> = LazyLock::new(|| listed(true));
static WITHOUT_SPAWN: LazyLock<Listed> = LazyLock::new(|| listed(false));

/// the tools list as JSON text in TOOLS order, relay_spawn only with a spawn
pub fn tools_json(spawn: bool) -> &'static str {
    if spawn {
        &WITH_SPAWN.json
    } else {
        &WITHOUT_SPAWN.json
    }
}

pub fn tool_names(spawn: bool) -> &'static [String] {
    if spawn {
        &WITH_SPAWN.names
    } else {
        &WITHOUT_SPAWN.names
    }
}

/// a tool's arguments do not fit its schema
#[derive(Debug, Clone, PartialEq)]
pub struct ToolInputError(pub String);

type Input<T> = Result<T, ToolInputError>;

fn refuse<T>(message: impl Into<String>) -> Input<T> {
    Err(ToolInputError(message.into()))
}

/// a field of an object, None when it is absent or `value` is no object
pub fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

/// JavaScript's truthiness
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// a number as JavaScript's String() writes it
pub fn js_num(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if f == 0.0 {
        return "0".into();
    }
    let abs = f.abs();
    if (1e-6..1e21).contains(&abs) {
        return format!("{f}");
    }
    let exp = format!("{f:e}");
    match exp.split_once('e') {
        Some((mantissa, power)) if !power.starts_with('-') => format!("{mantissa}e+{power}"),
        _ => exp,
    }
}

/// a value as a JavaScript template string writes it
pub fn js(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => i.to_string(),
            (_, Some(u)) => u.to_string(),
            _ => js_num(n.as_f64().unwrap_or(f64::NAN)),
        },
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(list)) => join(list, ","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// Array.prototype.join: null and undefined elements as empty
pub fn join(list: &[Value], separator: &str) -> String {
    list.iter()
        .map(|v| {
            if v.is_null() {
                String::new()
            } else {
                js(Some(v))
            }
        })
        .collect::<Vec<_>>()
        .join(separator)
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

fn is(value: Option<&Value>, number: f64) -> bool {
    value.and_then(Value::as_f64) == Some(number)
}

/// a tools/call result: one text block, whether it is an error, and structured content
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
    pub structured: Option<Value>,
}

impl ToolResult {
    pub fn with(mut self, structured: Value) -> Self {
        self.structured = Some(structured);
        self
    }

    /// the result as JSON, its keys in the order MCP clients see them from the reference server
    pub fn to_json(&self) -> String {
        let mut out = format!(
            "{{\"content\":[{{\"type\":\"text\",\"text\":{}}}]",
            Value::String(self.text.clone())
        );
        if self.is_error {
            out.push_str(",\"isError\":true");
        }
        if let Some(structured) = &self.structured {
            out.push_str(&format!(",\"structuredContent\":{structured}"));
        }
        out.push('}');
        out
    }
}

pub fn text(value: &str, is_error: bool) -> ToolResult {
    ToolResult {
        text: value.to_string(),
        is_error,
        structured: None,
    }
}

/// a string argument: absent is None unless `required`; a required one must not be blank
pub fn str_arg(args: &Map<String, Value>, key: &str, required: bool) -> Input<Option<String>> {
    match args.get(key) {
        None if !required => Ok(None),
        Some(Value::String(s)) if !required || !js_trim(s).is_empty() => Ok(Some(s.clone())),
        _ => refuse(format!("{key} must be a non-empty string")),
    }
}

/// a required, non-blank string argument
pub fn required(args: &Map<String, Value>, key: &str) -> Input<String> {
    Ok(str_arg(args, key, true)?.unwrap_or_default())
}

pub fn bool_arg(args: &Map<String, Value>, key: &str) -> Input<Option<bool>> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => refuse(format!("{key} must be true or false")),
    }
}

pub fn selectors(args: &Map<String, Value>, key: &str) -> Input<Option<Vec<String>>> {
    let list: Vec<&str> = match args.get(key) {
        None => return Ok(None),
        Some(Value::String(s)) => s.split(',').collect(),
        Some(Value::Array(list)) if list.iter().all(Value::is_string) => {
            list.iter().filter_map(Value::as_str).collect()
        }
        Some(_) => return refuse(format!("{key} must be a list of selectors")),
    };
    Ok(Some(
        list.into_iter()
            .map(js_trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    ))
}

pub fn one_of(args: &Map<String, Value>, key: &str, values: &[&str]) -> Input<String> {
    match args.get(key).and_then(Value::as_str) {
        Some(value) if values.contains(&value) => Ok(value.to_string()),
        _ => refuse(format!("{key} must be one of {}", values.join(", "))),
    }
}

/// wait_s, capped at the broker's longest wait
pub fn seconds(args: &Map<String, Value>, fallback: u64) -> Input<Value> {
    let Some(value) = args.get("wait_s") else {
        return Ok(json!(fallback));
    };
    match value.as_f64() {
        Some(f) if value.is_number() && f >= 0.0 => Ok(if f > LIMITS.wait_max_s as f64 {
            json!(LIMITS.wait_max_s)
        } else {
            value.clone()
        }),
        _ => refuse(format!(
            "wait_s must be a number of seconds from 0 to {}",
            LIMITS.wait_max_s
        )),
    }
}

pub fn recipients(args: &Map<String, Value>) -> Input<Value> {
    let blank = |v: &Value| v.as_str().is_none_or(|s| js_trim(s).is_empty());
    match args.get("to") {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Ok(Value::String(s.clone())),
        Some(Value::Array(list))
            if !list.is_empty()
                && list.len() as u64 <= LIMITS.recipients
                && !list.iter().any(blank) =>
        {
            Ok(Value::Array(list.clone()))
        }
        _ => refuse(format!(
            "to must be an address or a list of 1 to {} addresses",
            LIMITS.recipients
        )),
    }
}

pub fn peek_turns(args: &Map<String, Value>) -> Input<Option<u64>> {
    let Some(value) = args.get("turns") else {
        return Ok(None);
    };
    match value.as_f64() {
        Some(f) if f.fract() == 0.0 && (1.0..=PEEK_TURNS_MAX as f64).contains(&f) => {
            Ok(Some(f as u64))
        }
        _ => refuse(format!(
            "turns must be a whole number from 1 to {PEEK_TURNS_MAX}"
        )),
    }
}

pub fn quote(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    let mut out = String::with_capacity(escaped.len() + 2);
    out.push('"');
    let mut space = false;
    for c in escaped.chars() {
        if js_space(c) {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out.push('"');
    out
}

pub fn status_line(status: &Value) -> String {
    let note = match get(status, "note").filter(|v| truthy(Some(v))) {
        Some(note) => format!(": {}", quote(&js(Some(note)))),
        None => String::new(),
    };
    format!("{}{note}", js(get(status, "state")))
}

pub fn hidden_note(hidden: usize, historic: usize) -> Vec<String> {
    let mut notes = Vec::new();
    if hidden > 0 {
        notes.push(format!("{hidden} offline hidden (all: true lists them)"));
    }
    if historic > 0 {
        notes.push(format!(
            "{historic} historic hidden (historic: true lists them)"
        ));
    }
    notes
}

/// the rows a list or peers tool shows, with the notes that count what it left out
pub fn shown_rows(
    rows: &[Value],
    all: bool,
    historic: bool,
    human: bool,
) -> (Vec<&Value>, Vec<String>) {
    if all {
        return (rows.iter().collect(), Vec::new());
    }
    let (mut shown, mut offline, mut old) = (Vec::new(), 0, 0);
    for row in rows {
        let is_historic = truthy(get(row, "historic"));
        let show = if is_historic {
            historic
        } else {
            get(row, "presence").and_then(Value::as_str) != Some("offline")
                || (human && get(row, "kind").and_then(Value::as_str) == Some("human"))
        };
        if show {
            shown.push(row);
        } else if is_historic {
            old += 1;
        } else {
            offline += 1;
        }
    }
    (shown, hidden_note(offline, old))
}

pub fn held_text(held: &Value) -> String {
    format!(
        "held for review by your human: hold {}; nothing was delivered",
        js(get(held, "hold_id"))
    )
}

pub fn sent_content(result: &Value) -> Value {
    let mut content = Map::new();
    for key in ["id", "thread"] {
        if let Some(value) = get(result, key) {
            content.insert(key.into(), value.clone());
        }
    }
    let recipients = list_of(get(result, "deliveries"))
        .iter()
        .map(|d| {
            let mut recipient = Map::new();
            if let Some(address) = get(d, "address") {
                recipient.insert("address".into(), address.clone());
            }
            for key in ["state", "wake"] {
                if let Some(value) = get(d, key).filter(|v| truthy(Some(v))) {
                    recipient.insert(key.into(), value.clone());
                }
            }
            Value::Object(recipient)
        })
        .collect();
    content.insert("recipients".into(), Value::Array(recipients));
    Value::Object(content)
}

pub fn redacted_text(redacted: Option<&Value>) -> String {
    let Some(redacted) = redacted.filter(|v| truthy(Some(v))) else {
        return String::new();
    };
    let n = get(redacted, "n");
    format!(
        "; redacted {} span{} ({}) before delivery",
        js(n),
        if is(n, 1.0) { "" } else { "s" },
        strings(get(redacted, "kinds")).join(", ")
    )
}

fn sels(list: &[Value]) -> String {
    list.iter()
        .map(|e| match get(e, "via").filter(|v| truthy(Some(v))) {
            Some(via) => format!("{} (via {})", js(get(e, "sel")), js(Some(via))),
            None => js(get(e, "sel")),
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn or_none(text: String) -> String {
    if text.is_empty() {
        "(none)".into()
    } else {
        text
    }
}

pub fn scope_text(view: &Value) -> String {
    let rule = |list: Option<&Value>| match list {
        None | Some(Value::Null) => "open".to_string(),
        Some(list) => or_none(match list {
            Value::Array(list) => join(list, ","),
            other => js(Some(other)),
        }),
    };
    let rules = get(view, "rules");
    let mut head = format!(
        "{}: scope {}",
        js(get(view, "address")),
        js(get(view, "preset"))
    );
    if let Some(tree) = get(view, "tree").filter(|v| truthy(Some(v))) {
        head.push_str(&format!(", tree {}", js(Some(tree))));
    }
    if let Some(parent) = get(view, "parent").filter(|v| truthy(Some(v))) {
        head.push_str(&format!(", parent {}", js(Some(parent))));
    }
    head.push_str(&format!(", depth {}", js(get(view, "depth"))));
    let mut lines = vec![
        head,
        format!("rules in: {}", rule(rules.and_then(|r| get(r, "in")))),
        format!("rules out: {}", rule(rules.and_then(|r| get(r, "out")))),
    ];
    for cap in list_of(get(view, "caps")) {
        lines.push(format!(
            "cap {} {} by {}: {}",
            js(get(cap, "id")),
            js(get(cap, "dir")),
            js(get(cap, "by")),
            or_none(sels(list_of(get(cap, "sels"))))
        ));
    }
    let groups = list_of(get(view, "groups"));
    if !groups.is_empty() {
        lines.push(format!("groups: {}", join(groups, ", ")));
    }
    lines.join("\n")
}

pub fn group_text(result: &Value) -> String {
    if let Value::Array(groups) = result {
        if groups.is_empty() {
            return "no groups".into();
        }
        return groups
            .iter()
            .map(|g| {
                let members = get(g, "members");
                format!(
                    "{}  owner {}  {} member{}{}{}",
                    js(get(g, "name")),
                    js(get(g, "owner")),
                    js(members),
                    if is(members, 1.0) { "" } else { "s" },
                    if truthy(get(g, "pinned")) {
                        "  pinned"
                    } else {
                        ""
                    },
                    if truthy(get(g, "policy")) {
                        "  policy"
                    } else {
                        ""
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    let name = js(get(result, "name"));
    if truthy(get(result, "dropped")) {
        return format!("group {name} dropped");
    }
    if let Some(endpoint) = get(result, "endpoint") {
        let joined = if truthy(get(result, "member")) {
            "joined"
        } else {
            "left"
        };
        return format!("{} {joined} group {name}", js(Some(endpoint)));
    }
    let Some(Value::Array(members)) = get(result, "members") else {
        return serde_json::to_string_pretty(result).unwrap_or_default();
    };
    let rules = get(result, "rules");
    let rule = |list: Option<&Value>| match list {
        None | Some(Value::Null) => "open".to_string(),
        Some(list) => or_none(sels(list_of(Some(list)))),
    };
    let mut head = format!("group {name}  owner {}", js(get(result, "owner")));
    if let Some(tree) = get(result, "tree").filter(|v| truthy(Some(v))) {
        head.push_str(&format!("  tree {}", js(Some(tree))));
    }
    if truthy(get(result, "pinned")) {
        head.push_str("  pinned");
    }
    let members = join(members, ", ");
    [
        head,
        format!("rules in: {}", rule(rules.and_then(|r| get(r, "in")))),
        format!("rules out: {}", rule(rules.and_then(|r| get(r, "out")))),
        format!(
            "members: {}",
            if members.is_empty() { "none" } else { &members }
        ),
    ]
    .join("\n")
}

pub fn seen_text(seen: &Value) -> String {
    let turns = get(seen, "turns");
    format!(
        "{} ({}, {}, {} turn{})",
        js(get(seen, "by")),
        js(get(seen, "at")),
        js(get(seen, "auth")),
        js(turns),
        if is(turns, 1.0) { "" } else { "s" }
    )
}

/// delivered messages behind the preamble, each saying when a hook already showed it
pub fn delivered(messages: &[Value]) -> String {
    let mut parts = vec![PREAMBLE.to_string()];
    for message in messages {
        let shown = match get(message, "shown_at").filter(|v| truthy(Some(v))) {
            Some(at) => format!(
                "(a hook already showed you this at {}; that copy may reach you after this call)\n",
                clock(at)
            ),
            None => String::new(),
        };
        parts.push(format!("{shown}{}", wrap_message(message)));
    }
    parts.join("\n\n")
}

/// one agent's line in relay_list
pub fn list_line(e: &Value, me: Option<&Value>, home: Option<&str>) -> String {
    let cwd = get(e, "cwd").filter(|v| truthy(Some(v))).map(|v| {
        let cwd = js(Some(v));
        match home.filter(|h| !h.is_empty()) {
            Some(home) if cwd == home || cwd.starts_with(&format!("{home}/")) => {
                format!("~{}", &cwd[home.len()..])
            }
            _ => cwd,
        }
    });
    let you = me.is_some_and(|me| get(e, "id") == get(me, "id"));
    let harness = match get(e, "harness") {
        None | Some(Value::Null) => get(e, "kind"),
        harness => harness,
    };
    let runner = get(e, "runner").filter(|v| truthy(Some(v)));
    let attach = runner
        .and_then(|r| get(r, "attach"))
        .filter(|v| truthy(Some(v)));
    let title = get(e, "title").filter(|v| truthy(Some(v)));
    let status = get(e, "status").filter(|v| truthy(Some(v)));
    [
        Some(format!(
            "{}{}",
            js(get(e, "address")),
            if you { " (you)" } else { "" }
        )),
        truthy(harness).then(|| js(harness)),
        Some(presence_text(e)),
        title.map(|t| format!("title {}", quote(&js(Some(t))))),
        status.map(status_line),
        cwd.filter(|c| !c.is_empty()).map(|c| quote(&c)),
        runner.map(|r| format!("runner {}", js(get(r, "name")))),
        attach.map(|a| format!("attach: {}", js(Some(a)))),
        truthy(get(e, "peekable")).then(|| "peekable".to_string()),
        truthy(get(e, "historic")).then(|| "historic".to_string()),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("  ")
}

pub fn ask_text(result: &Value) -> String {
    if let Some(reply) = get(result, "reply").filter(|v| truthy(Some(v))) {
        return delivered(std::slice::from_ref(reply));
    }
    let id = js(get(result, "id"));
    if truthy(get(result, "expired")) {
        return format!("request {id} expired without a reply");
    }
    let ended = list_of(get(result, "ended"));
    if !ended.is_empty() {
        return ended
            .iter()
            .map(|e| {
                let state = match get(e, "state") {
                    None | Some(Value::Null) => "no status".to_string(),
                    state => js(state),
                };
                format!(
                    "{} ended ({state}) without replying; the request stays queued",
                    js(get(e, "address"))
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    let mut lines = vec![format!("no reply yet, call relay_ask_wait with id {id}")];
    lines.extend(reach_lines(list_of(get(result, "deliveries")), true));
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn the_tools_list_keeps_order_and_drops_spawn_without_one() {
        assert_eq!(tool_names(true).len(), 20);
        assert_eq!(tool_names(false).len(), 19);
        assert!(!tool_names(false).iter().any(|n| n == "relay_spawn"));
        let all: Vec<Value> = serde_json::from_str(tools_json(true)).unwrap_or_default();
        assert_eq!(all.len(), 20);
        assert_eq!(all[0]["name"], "relay_whoami");
        assert!(serde_json::from_str::<Vec<Value>>(tools_json(false)).is_ok());
    }

    #[test]
    fn arguments_are_checked_as_the_schema_says() {
        assert_eq!(
            str_arg(&args(json!({ "to": " " })), "to", true),
            Err(ToolInputError("to must be a non-empty string".into()))
        );
        assert_eq!(
            str_arg(&args(json!({ "to": "" })), "to", false),
            Ok(Some(String::new()))
        );
        assert_eq!(
            selectors(&args(json!({ "in": " a, ,b" })), "in"),
            Ok(Some(vec!["a".into(), "b".into()]))
        );
        assert!(selectors(&args(json!({ "in": [1] })), "in").is_err());
        assert_eq!(seconds(&args(json!({ "wait_s": 99 })), 0), Ok(json!(50)));
        assert_eq!(seconds(&args(json!({ "wait_s": 1.5 })), 0), Ok(json!(1.5)));
        assert!(seconds(&args(json!({ "wait_s": -1 })), 0).is_err());
        assert!(recipients(&args(json!({ "to": [] }))).is_err());
        assert_eq!(peek_turns(&args(json!({ "turns": 2.0 }))), Ok(Some(2)));
        assert!(peek_turns(&args(json!({ "turns": 2.5 }))).is_err());
        assert_eq!(
            one_of(&args(json!({ "a": "x" })), "a", &["y", "z"]),
            Err(ToolInputError("a must be one of y, z".into()))
        );
    }

    #[test]
    fn values_read_as_javascript_writes_them() {
        assert_eq!(quote("a  \"b\"\\\n c"), "\"a \\\"b\\\"\\\\ c\"");
        assert_eq!(js(Some(&json!(2.0))), "2");
        assert_eq!(js(Some(&json!(0.5))), "0.5");
        assert_eq!(js(Some(&json!([1, null, "x"]))), "1,,x");
        assert_eq!(js_num(1e21), "1e+21");
        assert_eq!(js_num(1.5e-7), "1.5e-7");
        assert_eq!(js(None), "undefined");
    }

    #[test]
    fn list_lines_shorten_home_and_quote_what_agents_wrote() {
        let e = json!({ "id": "e1", "address": "me/a", "harness": "codex", "kind": "agent", "presence": "online", "cwd": "/work/proj", "status": { "state": "blocked", "note": "x  y" } });
        let me = json!({ "id": "e1" });
        assert_eq!(
            list_line(&e, Some(&me), Some("/work")),
            "me/a (you)  codex  online  blocked: \"x y\"  \"~/proj\""
        );
        let rows = [
            json!({ "kind": "agent", "presence": "offline" }),
            json!({ "kind": "agent", "presence": "online", "historic": true }),
        ];
        let (shown, notes) = shown_rows(&rows, false, false, false);
        assert!(shown.is_empty());
        assert_eq!(
            notes,
            [
                "1 offline hidden (all: true lists them)",
                "1 historic hidden (historic: true lists them)"
            ]
        );
    }

    #[test]
    fn scope_and_group_text() {
        let view = json!({ "address": "me/a", "preset": "tree", "depth": 1, "parent": "me/p", "rules": { "in": [], "out": null }, "caps": [{ "id": "c1", "dir": "in", "by": "human", "sels": [{ "sel": "*", "via": "e2" }] }], "groups": ["g"] });
        assert_eq!(
            scope_text(&view),
            "me/a: scope tree, parent me/p, depth 1\nrules in: (none)\nrules out: open\ncap c1 in by human: * (via e2)\ngroups: g"
        );
        assert_eq!(
            group_text(&json!([{ "name": "crew", "owner": "me/a", "members": 1 }])),
            "crew  owner me/a  1 member"
        );
        assert_eq!(
            group_text(&json!({ "name": "crew", "endpoint": "me/b", "member": true })),
            "me/b joined group crew"
        );
    }
}
