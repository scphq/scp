//! What rules, group, admin, holds and peek print: a scope, a group result, an admin grant and a held message, as lines.

use crate::fleet::json::Json;
use crate::fleet::view::{pad_end, text, truthy};
use scp_mcp::render::{stamp, strip_control};

/// an array element in `Array.prototype.join`: nothing for null and undefined
fn element(value: Option<&Json>) -> String {
    match value {
        None | Some(Json::Null) => String::new(),
        some => text(some),
    }
}

/// `list.join(separator)`
pub fn join(list: Option<&Json>, separator: &str) -> String {
    match list {
        Some(Json::Arr(items)) => items
            .iter()
            .map(|item| element(Some(item)))
            .collect::<Vec<_>>()
            .join(separator),
        other => text(other),
    }
}

fn or_none(text: String) -> String {
    if text.is_empty() {
        "(none)".into()
    } else {
        text
    }
}

/// selector entries as `sel (via x)`, comma-separated
fn sels(list: Option<&Json>) -> String {
    list.map(Json::items)
        .unwrap_or_default()
        .iter()
        .map(|e| {
            let via = e.get("via");
            if truthy(via) {
                format!("{} (via {})", text(e.get("sel")), text(via))
            } else {
                element(e.get("sel"))
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// `  <word> <value>` when the value is truthy
fn tagged(word: &str, value: Option<&Json>) -> String {
    if truthy(value) {
        format!("  {word} {}", text(value))
    } else {
        String::new()
    }
}

/// `word` when the value is truthy
fn mark(value: Option<&Json>, word: &'static str) -> &'static str {
    if truthy(value) { word } else { "" }
}

/// `printScope`: an endpoint's preset, rules, caps and groups
pub fn scope_lines(view: &Json) -> Vec<String> {
    let rules = view.get("rules");
    let rule = |dir: &str| {
        let list = rules.and_then(|r| r.get(dir));
        if truthy(list) {
            or_none(join(list, ","))
        } else {
            "open".into()
        }
    };
    let mut lines = vec![
        format!(
            "{}  scope {}{}{}  depth {}",
            text(view.get("address")),
            text(view.get("preset")),
            tagged("tree", view.get("tree")),
            tagged("parent", view.get("parent")),
            text(view.get("depth"))
        ),
        format!("rules in: {}", rule("in")),
        format!("rules out: {}", rule("out")),
    ];
    for cap in view.get("caps").map(Json::items).unwrap_or_default() {
        lines.push(format!(
            "cap {} {} by {}: {}",
            text(cap.get("id")),
            text(cap.get("dir")),
            text(cap.get("by")),
            or_none(sels(cap.get("sels")))
        ));
    }
    let groups = view.get("groups");
    if groups.is_some_and(|g| !g.items().is_empty()) {
        lines.push(format!("groups: {}", join(groups, ", ")));
    }
    lines
}

/// `groupText`: the list, one group, a membership change or a drop
pub fn group_text(result: &Json) -> String {
    if let Json::Arr(groups) = result {
        if groups.is_empty() {
            return "no groups".into();
        }
        return groups
            .iter()
            .map(|g| {
                let members = g.get("members");
                let ignored = g.get("ignored");
                format!(
                    "{}  owner {}  {} member{}{}{}{}",
                    text(g.get("name")),
                    text(g.get("owner")),
                    text(members),
                    if members == Some(&Json::Num(1.0)) {
                        ""
                    } else {
                        "s"
                    },
                    mark(g.get("pinned"), "  pinned"),
                    mark(g.get("policy"), "  policy"),
                    if truthy(ignored) {
                        format!("  ignored: {}", text(ignored))
                    } else {
                        String::new()
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    let name = || text(result.get("name"));
    if truthy(result.get("dropped")) {
        return format!("group {} dropped", name());
    }
    if let Some(endpoint) = result.get("endpoint") {
        let change = if truthy(result.get("member")) {
            "joined"
        } else {
            "left"
        };
        return format!("{} {change} group {}", text(Some(endpoint)), name());
    }
    let members = result.get("members");
    if !matches!(members, Some(Json::Arr(_))) {
        return result.pretty();
    }
    let rules = result.get("rules");
    let rule = |dir: &str| match rules.and_then(|r| r.get(dir)) {
        list if truthy(list) => or_none(sels(list)),
        _ => "open".into(),
    };
    let members = join(members, ", ");
    [
        format!(
            "group {}  owner {}{}{}",
            name(),
            text(result.get("owner")),
            tagged("tree", result.get("tree")),
            mark(result.get("pinned"), "  pinned")
        ),
        format!("rules in: {}", rule("in")),
        format!("rules out: {}", rule("out")),
        format!(
            "members: {}",
            if members.is_empty() { "none" } else { &members }
        ),
    ]
    .join("\n")
}

/// an `admin ls` row
pub fn admin_line(row: &Json) -> String {
    let over = if truthy(row.get("tree")) {
        format!("tree {}", text(row.get("tree")))
    } else {
        format!("group {}", text(row.get("group")))
    };
    let stale = if truthy(row.get("stale")) {
        " (stale: granted on an earlier group of that name)"
    } else {
        ""
    };
    format!(
        "{} admin of {over} since {}{stale}",
        text(row.get("subject")),
        text(row.get("granted_at"))
    )
}

fn stamped(value: Option<&Json>) -> String {
    stamp(&value.map_or(serde_json::Value::Null, Json::to_value))
}

fn stripped(value: Option<&Json>) -> String {
    strip_control(&text(value))
}

/// `holds ls` table rows, the header first
pub fn hold_rows(holds: &[Json]) -> Vec<Vec<String>> {
    let header = ["ID", "FROM", "TO", "STATE", "HELD", "CATEGORIES", "REASON"];
    let mut rows = vec![header.iter().map(|h| (*h).to_owned()).collect()];
    for h in holds {
        rows.push(vec![
            text(h.get("id")),
            text(h.get("from")),
            join(h.get("to"), ","),
            text(h.get("state")),
            stamped(h.get("created_at")),
            or_dash(join(h.get("categories"), ",")),
            stripped(h.get("reason")),
        ]);
    }
    rows
}

fn or_dash(text: String) -> String {
    if text.is_empty() { "-".into() } else { text }
}

/// `holds show`: the labelled fields, a blank line, then the body
pub fn hold_lines(hold: &Json) -> Vec<String> {
    let redactions = hold
        .get("redactions")
        .map(Json::items)
        .unwrap_or_default()
        .iter()
        .map(|r| match r.get("quote") {
            None => text(r.get("kind")),
            quote => format!(
                "{}: {}",
                text(r.get("kind")),
                crate::args::js_string(&stripped(quote))
            ),
        })
        .collect::<Vec<_>>()
        .join("; ");
    let by = match hold.get("by") {
        None | Some(Json::Null) => "-".into(),
        by => text(by),
    };
    let fields = [
        ("id", text(hold.get("id"))),
        ("from", text(hold.get("from"))),
        ("to", join(hold.get("to"), ", ")),
        ("state", text(hold.get("state"))),
        ("held", stamped(hold.get("created_at"))),
        ("expires", stamped(hold.get("expires_at"))),
        ("boundary", text(hold.get("boundary"))),
        ("categories", or_dash(join(hold.get("categories"), ", "))),
        ("reason", stripped(hold.get("reason"))),
        ("redactions", or_dash(redactions)),
        ("by", by),
    ];
    let mut lines: Vec<String> = fields
        .into_iter()
        .map(|(label, value)| format!("{}{value}", pad_end(label, 12)))
        .collect();
    lines.push(String::new());
    lines.push(match hold.get("body") {
        None => "(body purged once resolved)".into(),
        body => stripped(body),
    });
    lines
}

/// a `peek --who` row: when, who, how, and how many turns
pub fn seen_line(seen: &Json) -> String {
    let turns = seen.get("turns");
    format!(
        "{} {} ({}) {} turn{}",
        stamped(seen.get("at")),
        text(seen.get("by")),
        text(seen.get("auth")),
        text(turns),
        if turns == Some(&Json::Num(1.0)) {
            ""
        } else {
            "s"
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Json {
        Json::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn a_scope_prints_its_rules_caps_and_groups() {
        let view = parse(
            r#"{"address":"me/a","preset":"tree","tree":"me/r","parent":null,"depth":1,"rules":{"in":[],"out":null},
            "caps":[{"id":"c1","dir":"in","by":"me/r","sels":[{"sel":"me/b","via":"g"},{"sel":"me/c"}]},{"id":"c2","dir":"out","by":"me/r","sels":[]}],
            "groups":["g","h"]}"#,
        );
        assert_eq!(
            scope_lines(&view),
            [
                "me/a  scope tree  tree me/r  depth 1",
                "rules in: (none)",
                "rules out: open",
                "cap c1 in by me/r: me/b (via g),me/c",
                "cap c2 out by me/r: (none)",
                "groups: g, h",
            ]
        );
    }

    #[test]
    fn group_results_read_as_the_typescript_cli_writes_them() {
        assert_eq!(group_text(&parse("[]")), "no groups");
        assert_eq!(
            group_text(&parse(
                r#"[{"name":"g","owner":"me/a","members":1,"pinned":true},{"name":"h","owner":"me/b","members":2,"policy":true,"ignored":"x"}]"#
            )),
            "g  owner me/a  1 member  pinned\nh  owner me/b  2 members  policy  ignored: x"
        );
        assert_eq!(
            group_text(&parse(r#"{"name":"g","dropped":true}"#)),
            "group g dropped"
        );
        assert_eq!(
            group_text(&parse(r#"{"name":"g","endpoint":null}"#)),
            "null left group g"
        );
        assert_eq!(
            group_text(&parse(r#"{"z":1,"a":2}"#)),
            "{\n  \"z\": 1,\n  \"a\": 2\n}"
        );
        assert_eq!(group_text(&Json::Null), "null");
        assert_eq!(
            group_text(&parse(
                r#"{"name":"g","owner":"me/a","tree":"me/r","members":[],"rules":{"in":[{"sel":"me/x","via":"v"}],"out":[]}}"#
            )),
            "group g  owner me/a  tree me/r\nrules in: me/x (via v)\nrules out: (none)\nmembers: none"
        );
    }

    #[test]
    fn a_hold_shows_its_fields_padded_and_its_body_stripped() {
        let hold = parse(
            r#"{"id":"h1","from":"me/a","to":["me/b","me/c"],"state":"held","created_at":"x","expires_at":"y","boundary":"b",
            "categories":[],"reason":"r\u0007","redactions":[{"kind":"key"},{"kind":"pii","quote":"a\"b"}],"by":null,"body":"hi\u001b"}"#,
        );
        assert_eq!(
            hold_lines(&hold),
            [
                "id          h1",
                "from        me/a",
                "to          me/b, me/c",
                "state       held",
                "held        x",
                "expires     y",
                "boundary    b",
                "categories  -",
                "reason      r",
                "redactions  key; pii: \"a\\\"b\"",
                "by          -",
                "",
                "hi",
            ]
        );
    }

    #[test]
    fn admin_and_peek_rows() {
        assert_eq!(
            admin_line(&parse(
                r#"{"subject":"me/a","group":"g","granted_at":"t","stale":true}"#
            )),
            "me/a admin of group g since t (stale: granted on an earlier group of that name)"
        );
        assert_eq!(
            seen_line(&parse(r#"{"at":"t","by":"me/a","auth":"tree","turns":1}"#)),
            "t me/a (tree) 1 turn"
        );
    }
}
