//! What list, peers, status and watch print, as lines: the tables, the tree, the summary and the event lines.

use super::json::Json;
use scp_mcp::render::{clock, js_space, presence_text};
use scp_mcp::tools::js_num;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;

/// JavaScript string length, in UTF-16 units
pub fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.padEnd(width)`
pub fn pad_end(text: &str, width: usize) -> String {
    let mut out = text.to_owned();
    for _ in units(text)..width {
        out.push(' ');
    }
    out
}

/// `printTable`: each column as wide as its widest cell, two spaces apart, trailing space trimmed
pub fn table(rows: &[Vec<String>]) -> Vec<String> {
    let columns = rows.first().map_or(0, Vec::len);
    let widths: Vec<usize> = (0..columns)
        .map(|c| {
            rows.iter()
                .map(|row| row.get(c).map_or(0, |cell| units(cell)))
                .max()
                .unwrap_or(0)
        })
        .collect();
    rows.iter()
        .map(|row| {
            let line = row
                .iter()
                .enumerate()
                .map(|(c, cell)| pad_end(cell, widths.get(c).copied().unwrap_or(0)))
                .collect::<Vec<_>>()
                .join("  ");
            line.trim_end_matches(js_space).to_owned()
        })
        .collect()
}

/// `a < b` as Array.prototype.sort compares strings: by UTF-16 units
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// a collation element: its primary, secondary (accent) and tertiary (case) weight
type Element = (u32, u8, u8);

/// the accented Latin-1 letters, each set with its accent's rank among the root collation's secondary weights
const ACCENTED: [(&str, u8); 8] = [
    ("áéíóúýÁÉÍÓÚÝ", 1),
    ("àèìòùÀÈÌÒÙ", 2),
    ("âêîôûÂÊÎÔÛ", 4),
    ("åÅ", 6),
    ("äëïöüÿÄËÏÖÜŸ", 7),
    ("ãñõÃÑÕ", 9),
    ("çÇ", 12),
    ("øØ", 14),
];

/// the secondary weight of æ and ß, which sort after every accented spelling of their letters
const LIGATURE: u8 = 20;

/// the base letter of an accented Latin-1 letter, as its decomposition starts
fn base(c: char) -> Option<char> {
    let bases = [
        ("àáâãäå", 'a'),
        ("ç", 'c'),
        ("èéêë", 'e'),
        ("ìíîï", 'i'),
        ("ñ", 'n'),
        ("òóôõöø", 'o'),
        ("ùúûü", 'u'),
        ("ýÿ", 'y'),
    ];
    let lower = c.to_lowercase().next()?;
    bases
        .iter()
        .find(|(set, _)| set.contains(lower))
        .map(|(_, b)| *b)
}

const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

fn letter(c: char) -> u32 {
    200 + c.to_ascii_lowercase() as u32 - 'a' as u32
}

/// a character's collation elements in the root locale: whitespace, punctuation and symbols, digits, then letters, accents and case
/// after; none for a character it ignores
fn elements(c: char) -> Vec<Element> {
    let case = u8::from(c.is_uppercase());
    let one = |primary: u32, secondary: u8| vec![(primary, secondary, case)];
    match c {
        '\u{0}'..='\u{8}' | '\u{e}'..='\u{1f}' | '\u{7f}' => Vec::new(),
        '\t' => one(1, 0),
        '\n' => one(2, 0),
        '\u{b}' => one(3, 0),
        '\u{c}' => one(4, 0),
        '\r' => one(5, 0),
        ' ' => one(6, 0),
        '0'..='9' => one(100 + c as u32 - '0' as u32, 0),
        'a'..='z' | 'A'..='Z' => one(letter(c), 0),
        'æ' | 'Æ' => vec![(letter('a'), LIGATURE, case), (letter('e'), LIGATURE, case)],
        'ß' => vec![(letter('s'), LIGATURE, 0), (letter('s'), LIGATURE, 0)],
        _ => {
            if let Some(at) = PUNCTUATION.find(c) {
                return one(10 + at as u32, 0);
            }
            match (base(c), ACCENTED.iter().find(|(set, _)| set.contains(c))) {
                (Some(b), Some((_, rank))) => one(letter(b), *rank),
                _ => one(1000 + c as u32, 0),
            }
        }
    }
}

/// `a.localeCompare(b)` in the root locale, for ASCII and the Latin-1 letters: base letters first, then accents, then case
pub fn locale_cmp(a: &str, b: &str) -> Ordering {
    let of = |s: &str| s.chars().flat_map(elements).collect::<Vec<_>>();
    let (a, b) = (of(a), of(b));
    let level = |pick: fn(&Element) -> u32| {
        let a: Vec<u32> = a.iter().map(pick).collect();
        let b: Vec<u32> = b.iter().map(pick).collect();
        a.cmp(&b)
    };
    level(|e| e.0)
        .then_with(|| level(|e| u32::from(e.1)))
        .then_with(|| level(|e| u32::from(e.2)))
}

/// a value in a template string
pub fn text(value: Option<&Json>) -> String {
    match value {
        None => "undefined".into(),
        Some(Json::Null) => "null".into(),
        Some(Json::Bool(on)) => on.to_string(),
        Some(Json::Num(n)) => js_num(*n),
        Some(Json::Str(s)) => s.clone(),
        Some(Json::Arr(items)) => items
            .iter()
            .map(|item| match item {
                Json::Null => String::new(),
                item => text(Some(item)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Json::Obj(_)) => "[object Object]".into(),
    }
}

pub fn truthy(value: Option<&Json>) -> bool {
    match value {
        None | Some(Json::Null) => false,
        Some(Json::Bool(on)) => *on,
        Some(Json::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(Json::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `value ?? fallback` in a template string
fn or(value: Option<&Json>, fallback: &str) -> String {
    match value {
        None | Some(Json::Null) => fallback.into(),
        some => text(some),
    }
}

fn is(value: Option<&Json>, word: &str) -> bool {
    value.and_then(Json::as_str) == Some(word)
}

/// text an agent wrote, in double quotes so it reads as theirs
pub fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn status_text(status: &Json) -> String {
    let note = status.get("note");
    let tail = if truthy(note) {
        format!(": {}", quoted(&text(note)))
    } else {
        String::new()
    };
    format!("{}{tail}", text(status.get("state")))
}

/// an endpoint's status cell: its status, else nothing for the human and `-` for an agent
fn status_cell(e: &Json) -> String {
    match e.get("status") {
        status if truthy(status) => status_text(status.unwrap_or(&Json::Null)),
        _ if is(e.get("kind"), "human") => String::new(),
        _ => "-".into(),
    }
}

pub fn wake_text(e: &Json) -> String {
    if !is(e.get("kind"), "agent") {
        return "-".into();
    }
    let wake = e.get("wake");
    if truthy(wake) && !is(wake, "none") {
        text(wake)
    } else {
        "turn".into()
    }
}

pub fn short_cwd(cwd: Option<&Json>, home: &str) -> String {
    if !truthy(cwd) {
        return String::new();
    }
    let cwd = text(cwd);
    if cwd == home {
        return "~".into();
    }
    match cwd.strip_prefix(&format!("{home}/")) {
        Some(rest) => format!("~/{rest}"),
        None => cwd,
    }
}

/// whether `e` is the caller's own endpoint
fn mine(e: &Json, me: &Value) -> bool {
    let Some(me) = me.as_object() else {
        return false;
    };
    e.get("id").map(Json::to_value) == me.get("id").cloned()
}

/// an endpoint's address, marked `(you)` when it is the caller's
fn address_cell(e: &Json, me: &Value) -> String {
    let address = text(e.get("address"));
    if mine(e, me) {
        format!("{address} (you)")
    } else {
        address
    }
}

fn labels(e: &Json) -> String {
    e.get("labels")
        .map(Json::entries)
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, _)| *k != "machine")
        .map(|(k, v)| format!("{k}={}", text(Some(v))))
        .collect::<Vec<_>>()
        .join(",")
}

fn runner_cell(e: &Json) -> String {
    let runner = e.get("runner");
    if !truthy(runner) {
        return String::new();
    }
    let runner = runner.unwrap_or(&Json::Null);
    let attach = runner.get("attach");
    let tail = if truthy(attach) {
        format!("  attach: {}", text(attach))
    } else {
        String::new()
    };
    format!("{}{tail}", text(runner.get("name")))
}

fn presence(e: &Json) -> String {
    presence_text(&e.to_value())
}

/// rows under their group's name, in the order the names came
type Groups<'a> = Vec<(String, Vec<&'a Json>)>;

/// the human inbox first, then the agents under a header per machine (this one first) and per harness
pub fn endpoints(list: &[&Json], me: &Value, host: &str, home: &str) -> Vec<String> {
    let runner = list.iter().any(|e| truthy(e.get("runner")));
    let peek = list.iter().any(|e| truthy(e.get("peekable")));
    let row = |e: &Json, indent: &str| {
        let mut cells = vec![
            format!("{indent}{}", address_cell(e, me)),
            or(e.get("title"), ""),
            presence(e),
            wake_text(e),
            status_cell(e),
            labels(e),
            short_cwd(e.get("cwd"), home),
        ];
        if peek {
            cells.push(or(e.get("peekable"), ""));
        }
        if runner {
            cells.push(runner_cell(e));
        }
        cells
    };
    let blank = |first: String| {
        let mut cells = vec![first];
        cells.resize(7 + usize::from(peek) + usize::from(runner), String::new());
        cells
    };
    let mut header: Vec<String> = [
        "ADDRESS", "TITLE", "PRESENCE", "WAKE", "STATUS", "LABELS", "CWD",
    ]
    .map(String::from)
    .to_vec();
    if peek {
        header.push("PEEK".into());
    }
    if runner {
        header.push("RUNNER".into());
    }
    let mut rows = vec![header];
    rows.extend(
        list.iter()
            .filter(|e| is(e.get("kind"), "human"))
            .map(|e| row(e, "")),
    );
    let mut machines: Vec<(String, Groups)> = Vec::new();
    for e in list.iter().filter(|e| !is(e.get("kind"), "human")) {
        let label = e.get("labels").and_then(|l| l.get("machine"));
        let machine = if truthy(label) {
            text(label)
        } else {
            host.to_owned()
        };
        let harness = or(e.get("harness"), "");
        let at = match machines.iter().position(|(m, _)| *m == machine) {
            Some(at) => at,
            None => {
                machines.push((machine, Vec::new()));
                machines.len() - 1
            }
        };
        let harnesses = &mut machines[at].1;
        match harnesses.iter_mut().find(|(h, _)| *h == harness) {
            Some((_, group)) => group.push(e),
            None => harnesses.push((harness, vec![e])),
        }
    }
    machines.sort_by(|(a, _), (b, _)| {
        if a == host {
            Ordering::Less
        } else if b == host {
            Ordering::Greater
        } else {
            locale_cmp(a, b)
        }
    });
    for (machine, mut harnesses) in machines {
        rows.push(blank(machine));
        harnesses.sort_by(|(a, _), (b, _)| utf16_cmp(a, b));
        for (harness, group) in harnesses {
            rows.push(blank(format!("  {harness}")));
            rows.extend(group.into_iter().map(|e| row(e, "    ")));
        }
    }
    table(&rows)
}

/// endpoints nested under their parents, with a scope column
pub fn tree(list: &[&Json], me: &Value, home: &str) -> Vec<String> {
    let addresses: HashSet<String> = list.iter().map(|e| text(e.get("address"))).collect();
    let mut children: Groups = Vec::new();
    let mut roots: Vec<&Json> = Vec::new();
    for e in list {
        let parent = e.get("parent");
        let parent_text = text(parent);
        if truthy(parent)
            && addresses.contains(&parent_text)
            && parent_text != text(e.get("address"))
        {
            match children.iter_mut().find(|(p, _)| *p == parent_text) {
                Some((_, group)) => group.push(e),
                None => children.push((parent_text, vec![e])),
            }
        } else {
            roots.push(e);
        }
    }
    let runner = list.iter().any(|e| truthy(e.get("runner")));
    let mut header: Vec<String> = [
        "ADDRESS", "SCOPE", "TITLE", "PRESENCE", "WAKE", "STATUS", "LABELS", "CWD",
    ]
    .map(String::from)
    .to_vec();
    if runner {
        header.push("RUNNER".into());
    }
    let mut rows = vec![header];
    let mut seen = HashSet::new();
    fn walk<'a>(
        e: &'a Json,
        depth: usize,
        seen: &mut HashSet<String>,
        rows: &mut Vec<Vec<String>>,
        children: &[(String, Vec<&'a Json>)],
        visit: &dyn Fn(&Json, usize) -> Vec<String>,
    ) {
        let address = text(e.get("address"));
        if !seen.insert(address.clone()) {
            return;
        }
        rows.push(visit(e, depth));
        if let Some((_, group)) = children.iter().find(|(p, _)| *p == address) {
            for child in group {
                walk(child, depth + 1, seen, rows, children, visit);
            }
        }
    }
    let visit = |e: &Json, depth: usize| {
        let mut cells = vec![
            format!("{}{}", "  ".repeat(depth), address_cell(e, me)),
            if is(e.get("kind"), "human") {
                String::new()
            } else {
                or(e.get("scope"), "open")
            },
            or(e.get("title"), ""),
            presence(e),
            wake_text(e),
            status_cell(e),
            labels(e),
            short_cwd(e.get("cwd"), home),
        ];
        if runner {
            cells.push(runner_cell(e));
        }
        cells
    };
    for root in roots {
        walk(root, 0, &mut seen, &mut rows, &children, &visit);
    }
    table(&rows)
}

/// the peers table: who the caller may message, and what admitted each
pub fn peers(shown: &[&Json]) -> Vec<String> {
    let peek = shown.iter().any(|p| truthy(p.get("peekable")));
    let mut header: Vec<String> = [
        "ADDRESS",
        "KIND",
        "PRESENCE",
        "TITLE",
        "STATUS",
        "ADMITTED BY",
    ]
    .map(String::from)
    .to_vec();
    if peek {
        header.push("PEEK".into());
    }
    let mut rows = vec![header];
    for p in shown {
        let mut row = vec![
            text(p.get("address")),
            text(p.get("kind")),
            text(p.get("presence")),
            or(p.get("title"), ""),
            status_cell(p),
            text(p.get("reason")),
        ];
        if peek {
            row.push(or(p.get("peekable"), ""));
        }
        rows.push(row);
    }
    table(&rows)
}

/// one audit row of `swarm log`
pub fn log_line(row: &Json) -> String {
    let reference = row.get("ref");
    let reference = if truthy(reference) {
        format!(" {}", text(reference))
    } else {
        String::new()
    };
    let at = match row.get("at") {
        Some(at) => scp_mcp::render::stamp(&at.to_value()),
        None => "undefined".into(),
    };
    let detail = row.get("detail").map_or("undefined".into(), Json::compact);
    format!(
        "{} {at} {} {}{reference} {detail}",
        text(row.get("id")),
        text(row.get("event")),
        or(row.get("endpoint"), "-")
    )
}

/// what list and peers show without `all`: no historic rows, and no offline ones but the human's; with the offline and historic counts
pub fn unlisted(rows: &[Json], all: bool) -> (Vec<&Json>, usize, usize) {
    if all {
        return (rows.iter().collect(), 0, 0);
    }
    let shown: Vec<&Json> = rows
        .iter()
        .filter(|row| {
            !truthy(row.get("historic"))
                && (is(row.get("kind"), "human") || !is(row.get("presence"), "offline"))
        })
        .collect();
    let historic = rows
        .iter()
        .filter(|row| truthy(row.get("historic")))
        .count();
    let hidden = rows.len() - shown.len() - historic;
    (shown, hidden, historic)
}

pub fn hidden_note(offline: usize, historic: usize) -> Option<String> {
    let mut parts = Vec::new();
    if offline > 0 {
        parts.push(format!("{offline} offline"));
    }
    if historic > 0 {
        parts.push(format!("{historic} historic"));
    }
    (!parts.is_empty()).then(|| format!("{} hidden (--all lists them)", parts.join(", ")))
}

/// the agents nobody spawned that spawned nobody, the caller aside: list and peers fold them into one line
pub fn unspawned(list: &[Json], me: &Value) -> HashSet<String> {
    let parents: Vec<Option<&Json>> = list.iter().map(|e| e.get("parent")).collect();
    let me_id = me.as_object().and_then(|m| m.get("id")).cloned();
    list.iter()
        .filter(|e| {
            let address = e.get("address");
            is(e.get("kind"), "agent")
                && !truthy(e.get("parent"))
                && !parents.contains(&address)
                && e.get("id").map(Json::to_value) != me_id
        })
        .map(|e| text(e.get("address")))
        .collect()
}

pub fn fold_note(folded: usize) -> Option<String> {
    (folded > 0).then(|| {
        format!(
            "{folded} other session{} (--all or --roots shows them)",
            if folded == 1 { "" } else { "s" }
        )
    })
}

const STATES: [&str; 4] = ["working", "waiting", "blocked", "done"];

/// the caller's line atop `swarm status`, when it acts as someone
pub fn you_line(me: &Value) -> Option<String> {
    let me = Json::from(me);
    if !truthy(Some(&me)) {
        return None;
    }
    let harness = me.get("harness");
    let harness = if truthy(harness) {
        format!(", {}", text(harness))
    } else {
        String::new()
    };
    let title = me.get("title");
    let title = if truthy(title) {
        format!(" {}", quoted(&text(title)))
    } else {
        String::new()
    };
    let status = if is(me.get("kind"), "human") {
        String::new()
    } else {
        let status = me.get("status");
        let shown = if truthy(status) {
            status_text(status.unwrap_or(&Json::Null))
        } else {
            "-".into()
        };
        format!(", status {shown}")
    };
    Some(format!(
        "you: {} ({}{harness}) {}{title}{status}",
        text(me.get("address")),
        text(me.get("kind")),
        presence(&me)
    ))
}

/// the summary of `swarm status` and whether it showed an agent's own words
pub fn summary(snapshot: &Json, me: &Value, all: bool) -> (Vec<String>, bool) {
    let mut lines: Vec<String> = you_line(me).into_iter().collect();
    let me = Json::from(me);
    let endpoints = snapshot.get("endpoints").map_or(&[][..], Json::items);
    let agents: Vec<&Json> = endpoints
        .iter()
        .filter(|e| !is(e.get("kind"), "human"))
        .collect();
    let count = |presence: &str| {
        agents
            .iter()
            .filter(|e| is(e.get("presence"), presence))
            .count()
    };
    lines.push(String::new());
    let hibernated = count("hibernated");
    let hibernated = if hibernated > 0 {
        format!("{hibernated} hibernated, ")
    } else {
        String::new()
    };
    lines.push(format!(
        "agents: {} online, {} idle, {hibernated}{} offline",
        count("online"),
        count("idle"),
        count("offline")
    ));
    let counted: Vec<&Json> = agents
        .iter()
        .copied()
        .filter(|e| all || !is(e.get("presence"), "offline"))
        .collect();
    let mut harnesses: Groups = Vec::new();
    for e in &counted {
        let harness = or(e.get("harness"), "?");
        match harnesses.iter_mut().find(|(h, _)| *h == harness) {
            Some((_, group)) => group.push(e),
            None => harnesses.push((harness, vec![e])),
        }
    }
    harnesses.sort_by(|(a, _), (b, _)| utf16_cmp(a, b));
    let state = |e: &Json| e.get("status").and_then(|s| s.get("state")).cloned();
    for (harness, group) in &harnesses {
        let mut parts: Vec<(usize, &str)> = STATES
            .iter()
            .map(|s| {
                (
                    group
                        .iter()
                        .filter(|e| state(e) == Some(Json::str(*s)))
                        .count(),
                    *s,
                )
            })
            .collect();
        parts.push((
            group.iter().filter(|e| !truthy(e.get("status"))).count(),
            "no status",
        ));
        let parts: Vec<String> = parts
            .into_iter()
            .filter(|(n, _)| *n > 0)
            .map(|(n, label)| format!("{n} {label}"))
            .collect();
        lines.push(format!("  {harness}: {}", parts.join(", ")));
    }
    let mut stuck: Vec<&Json> = counted
        .iter()
        .copied()
        .filter(|e| matches!(state(e), Some(Json::Str(s)) if s == "waiting" || s == "blocked"))
        .collect();
    stuck.sort_by(|a, b| locale_cmp(&text(a.get("address")), &text(b.get("address"))));
    if !stuck.is_empty() {
        lines.push(String::new());
        lines.push("waiting or blocked:".into());
        for e in &stuck {
            lines.push(format!(
                "  {} {}",
                text(e.get("address")),
                status_text(e.get("status").unwrap_or(&Json::Null))
            ));
        }
    }
    let mut unread: Vec<(&str, &Json)> = snapshot
        .get("unread")
        .map(Json::entries)
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, n)| number(n) > 0.0)
        .collect();
    unread.sort_by(|(a, _), (b, _)| locale_cmp(a, b));
    if !unread.is_empty() {
        lines.push(String::new());
        let parts: Vec<String> = unread
            .iter()
            .map(|(address, n)| format!("{address} {}", text(Some(n))))
            .collect();
        lines.push(format!("unread: {}", parts.join(", ")));
    }
    let quotes = (truthy(Some(&me)) && !is(me.get("kind"), "human")) || !stuck.is_empty();
    (lines, quotes)
}

/// `Number(value)`
pub fn number(value: &Json) -> f64 {
    match value {
        Json::Null => 0.0,
        Json::Bool(on) => f64::from(u8::from(*on)),
        Json::Num(n) => *n,
        Json::Str(s) => {
            let s = s.trim_matches(js_space);
            if s.is_empty() {
                return 0.0;
            }
            let radix = |prefix: &str, radix: u32| {
                s.strip_prefix(prefix)
                    .or_else(|| s.strip_prefix(&prefix.to_uppercase()))
                    .map(|digits| {
                        u64::from_str_radix(digits, radix)
                            .ok()
                            .filter(|_| !digits.starts_with('+'))
                            .map_or(f64::NAN, |n| n as f64)
                    })
            };
            if let Some(n) = radix("0x", 16)
                .or_else(|| radix("0o", 8))
                .or_else(|| radix("0b", 2))
            {
                return n;
            }
            match s {
                "Infinity" | "+Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                _ if s.contains(|c: char| c.is_ascii_alphabetic() && c != 'e' && c != 'E') => {
                    f64::NAN
                }
                _ => s.parse().unwrap_or(f64::NAN),
            }
        }
        Json::Arr(items) if items.is_empty() => 0.0,
        Json::Arr(items) if items.len() == 1 => number(&Json::Str(text(Some(value)))),
        _ => f64::NAN,
    }
}

/// `time(iso)`: an ISO time as `HH:MM:SS` in local time, else as given
pub fn time(at: &str) -> String {
    clock(&Value::String(at.to_owned()))
}

pub fn activity_line(row: &Json, at: &str) -> String {
    let agent = row.get("agent");
    let agent = if truthy(agent) {
        format!(" [{}]", text(agent))
    } else {
        String::new()
    };
    let tool = row.get("tool");
    let tool = if truthy(tool) {
        format!(" {}", text(tool))
    } else {
        String::new()
    };
    let summary = row.get("summary");
    let summary = if truthy(summary) {
        format!(": {}", quoted(&text(summary)))
    } else {
        String::new()
    };
    format!(
        "{} {}{agent} {}{tool}{summary}",
        time(at),
        text(row.get("endpoint")),
        text(row.get("kind"))
    )
}

/// one fleet event of `swarm watch` as a line
pub fn fleet_line(event: &Json) -> String {
    let raw = text(event.get("at"));
    let at = time(&raw);
    match event.get("type").and_then(Json::as_str) {
        Some("presence") => {
            let harness = event.get("harness");
            let harness = if truthy(harness) {
                format!(" ({})", text(harness))
            } else {
                String::new()
            };
            format!(
                "{at} {} is {}{harness}",
                text(event.get("endpoint")),
                text(event.get("presence"))
            )
        }
        Some("message") => {
            let to = event
                .get("to")
                .map_or(&[][..], Json::items)
                .iter()
                .map(|t| match t {
                    Json::Null => String::new(),
                    t => text(Some(t)),
                })
                .collect::<Vec<_>>()
                .join(", ");
            let hop = event.get("hop").map_or(f64::NAN, number);
            let hop = if hop != 0.0 && !hop.is_nan() {
                format!(" hop {}", text(event.get("hop")))
            } else {
                String::new()
            };
            format!(
                "{at} {} -> {to} {} {}{hop}",
                text(event.get("from")),
                text(event.get("kind")),
                text(event.get("id"))
            )
        }
        Some("status") => {
            let status = event.get("status");
            let shown = if truthy(status) {
                status_text(status.unwrap_or(&Json::Null))
            } else {
                "cleared".into()
            };
            format!("{at} {} status {shown}", text(event.get("endpoint")))
        }
        Some("activity") => activity_line(event, &raw),
        _ => format!("{at} {}", event.compact()),
    }
}

/// `broker <socket> (pid <pid>[, engine <engine>]); <policy>`
pub fn broker_line(broker: &Value, engine: Option<&str>) -> String {
    let broker = Json::from(broker);
    let policy = broker.get("policy").unwrap_or(&Json::Null);
    let file = text(policy.get("file"));
    let policy = match policy.get("state").and_then(Json::as_str) {
        Some("open") => format!("no policy at {file}, open"),
        Some("loaded") => format!("policy {file}"),
        _ => format!("policy {file} unusable, sends refused"),
    };
    let engine = engine.map_or(String::new(), |e| format!(", engine {e}"));
    format!(
        "broker {} (pid {}{engine}); {policy}",
        text(broker.get("socket")),
        text(broker.get("pid"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_are_as_wide_as_javascript_counts() {
        let rows = vec![
            vec!["A".to_string(), "B".into(), "".into()],
            vec!["😀x".to_string(), "é".into(), "".into()],
        ];
        assert_eq!(table(&rows), vec!["A    B", "😀x  é"]);
    }

    #[test]
    fn strings_sort_as_the_root_collation_does() {
        let mut words = vec![
            "b", "B", "a-b", "ab", "a_b", "aB", "Ab", "a1", "a.b", "me/x", "me/X", "me-x", "a", "A",
        ];
        words.sort_by(|a, b| locale_cmp(a, b));
        assert_eq!(
            words,
            vec![
                "a", "A", "a_b", "a-b", "a.b", "a1", "ab", "aB", "Ab", "b", "B", "me-x", "me/x",
                "me/X"
            ]
        );
        assert_eq!(locale_cmp("\u{1}a", "a"), Ordering::Equal);
    }

    #[test]
    fn number_reads_as_javascript_does() {
        for (text, n) in [
            ("2", 2.0),
            (" 3 ", 3.0),
            ("", 0.0),
            ("0x10", 16.0),
            ("1e2", 100.0),
            ("x", f64::NAN),
            ("Infinity", f64::INFINITY),
        ] {
            let got = number(&Json::str(text));
            assert!(got == n || (got.is_nan() && n.is_nan()), "{text}");
        }
    }
}
