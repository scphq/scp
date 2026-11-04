//! List, status, peers, watch, log, policy and why.

pub mod json;
pub mod mounts;
pub mod view;

use crate::open::Opened;
use crate::term::{note, out};
use crate::{Call, Done, Fail, Run, Verb, usage};
use json::Json;
use scp_core::protocol::CLI_NAME;
use scp_mcp::LocalFuture;
use scp_mcp::client::CallError;
use scp_mcp::render::receipt_lines;
use serde_json::{Map, Value};
use std::collections::HashSet;
use view::{pad_end, text, truthy};

pub const VERBS: &[Verb] = &[
    Verb {
        name: "list",
        run: Run::Opened(list),
    },
    Verb {
        name: "status",
        run: Run::Opened(status),
    },
    Verb {
        name: "peers",
        run: Run::Opened(peers),
    },
    Verb {
        name: "watch",
        run: Run::Opened(watch),
    },
    Verb {
        name: "log",
        run: Run::Opened(log),
    },
    Verb {
        name: "policy",
        run: Run::Opened(policy),
    },
    Verb {
        name: "why",
        run: Run::Opened(why),
    },
];

const QUOTED_NOTE: &str =
    "quoted text is written by the agents themselves, not checked by the relay";

/// a reply's result as the broker wrote it, keys in their order
fn result_of(line: &[u8]) -> Result<Json, Fail> {
    let message = Json::parse(line)
        .or_else(|| {
            serde_json::from_slice::<Value>(line)
                .ok()
                .map(|v| Json::from(&v))
        })
        .ok_or_else(|| {
            Fail::Call(CallError::Io(
                "the relay broker sent a line that is not JSON".into(),
            ))
        })?;
    Ok(message.get("result").cloned().unwrap_or(Json::Null))
}

type Asked = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Json, Fail>>>>;

/// a request sent now, its reply's result to come
pub(crate) fn ask(opened: &Opened, method: &str, params: Vec<(&str, Value)>) -> Asked {
    let params: Map<String, Value> = params.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
    let reply = opened.client.request_line(method, Value::Object(params));
    Box::pin(async move { result_of(&reply.await?) })
}

fn thrown(message: String) -> Fail {
    Fail::Call(CallError::Io(message))
}

fn missing(value: Option<&Json>, property: &str) -> Option<Fail> {
    let what = match value {
        None => "undefined",
        Some(Json::Null) => "null",
        Some(_) => return None,
    };
    Some(thrown(format!(
        "Cannot read properties of {what} (reading '{property}')"
    )))
}

/// a list the TypeScript CLI calls `<name>.<method>()` on: what Node throws when the reply holds none
fn reading<'j>(value: Option<&'j Json>, name: &str, method: &str) -> Result<&'j [Json], Fail> {
    if let Some(fail) = missing(value, method) {
        return Err(fail);
    }
    match value {
        Some(Json::Arr(items)) => Ok(items),
        _ => Err(thrown(format!("{name}.{method} is not a function"))),
    }
}

/// `value.length` where the TypeScript CLI tests it: a list's or a string's, else 0 as `undefined` tests
pub(crate) fn length(value: Option<&Json>) -> Result<usize, Fail> {
    if let Some(fail) = missing(value, "length") {
        return Err(fail);
    }
    Ok(match value {
        Some(Json::Arr(items)) => items.len(),
        Some(Json::Str(text)) => text.encode_utf16().count(),
        _ => 0,
    })
}

/// what the TypeScript CLI's `for (const x of <name>)` loops over: a list's items or a string's characters
pub(crate) fn iterating(value: Option<&Json>, name: &str) -> Result<Vec<Json>, Fail> {
    match value {
        Some(Json::Arr(items)) => Ok(items.clone()),
        Some(Json::Str(text)) => Ok(text.chars().map(|c| Json::Str(c.into())).collect()),
        _ => Err(thrown(format!("{name} is not iterable"))),
    }
}

fn field(value: &Json, key: &str) -> Json {
    value.get(key).cloned().unwrap_or(Json::Null)
}

fn home(call: &Call) -> String {
    call.env
        .get("HOME")
        .filter(|h| !h.is_empty())
        .cloned()
        .unwrap_or_else(scp_mcp::identity::home_dir)
}

fn notes(lines: impl IntoIterator<Item = String>) {
    for line in lines {
        note(&line);
    }
}

fn print(lines: Vec<String>) {
    for line in lines {
        out(&line);
    }
}

/// `{ <key>: rows, hidden? }` as list and peers print it
fn rows_json(key: &str, rows: &[&Json], hidden: usize) -> String {
    let mut entries = vec![(key, Json::Arr(rows.iter().map(|e| (*e).clone()).collect()))];
    if hidden > 0 {
        entries.push(("hidden", Json::Num(hidden as f64)));
    }
    Json::object(entries).pretty()
}

fn list<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        let json = flags.on("json");
        if flags.on("contacts") {
            if flags.on("all") || flags.on("tree") {
                return Err(usage(format!(
                    "{CLI_NAME} list --contacts takes no --all or --tree"
                )));
            }
            let reply = ask(opened, "list", vec![("contacts", Value::Bool(true))]).await?;
            let contacts = reply.get("contacts").cloned();
            if json {
                let entries = contacts.map(|c| ("contacts", c)).into_iter().collect();
                out(&Json::object(entries).pretty());
                return Ok(0);
            }
            if length(contacts.as_ref())? == 0 {
                note("no endpoints of contacts");
            } else {
                if matches!(contacts, Some(Json::Str(_))) {
                    return Err(missing(None, "padEnd").expect("undefined"));
                }
                for e in iterating(contacts.as_ref(), "contacts")? {
                    let harness = match e.get("harness") {
                        None | Some(Json::Null) => "unknown".into(),
                        some => text(some),
                    };
                    out(&format!(
                        "{} {} {}",
                        pad_end(&text(e.get("address")), 36),
                        pad_end(&harness, 14),
                        text(e.get("presence"))
                    ));
                }
            }
            return Ok(0);
        }
        let all = flags.on("all");
        let reply = ask(
            opened,
            "list",
            vec![("all", Value::Bool(all)), ("historic", Value::Bool(true))],
        )
        .await?;
        if all && json {
            let entries = reply.get("endpoints").map(|e| ("endpoints", e.clone()));
            out(&Json::object(entries.into_iter().collect()).pretty());
            return Ok(0);
        }
        let listed = reading(
            reply.get("endpoints"),
            if all { "endpoints" } else { "rows" },
            "filter",
        )?;
        let (endpoints, hidden, historic) = view::unlisted(listed, all);
        if json {
            out(&rows_json("endpoints", &endpoints, hidden + historic));
            return Ok(0);
        }
        let folded = if all || flags.on("roots") {
            HashSet::new()
        } else {
            view::unspawned(listed, &opened.me)
        };
        let shown: Vec<&Json> = endpoints
            .iter()
            .copied()
            .filter(|e| !folded.contains(&text(e.get("address"))))
            .collect();
        let home = home(call);
        print(if flags.on("tree") {
            view::tree(&shown, &opened.me, &home)
        } else {
            view::endpoints(
                &shown,
                &opened.me,
                &scp_mcp::identity::short_hostname(),
                &home,
            )
        });
        notes(view::hidden_note(hidden, historic));
        notes(view::fold_note(endpoints.len() - shown.len()));
        Ok(0)
    })
}

fn peers<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        let all = flags.on("all");
        let reply = ask(
            opened,
            "peers",
            vec![("all", Value::Bool(all)), ("historic", Value::Bool(true))],
        )
        .await?;
        if all && flags.on("json") {
            let entries = reply.get("peers").map(|p| ("peers", p.clone()));
            out(&Json::object(entries.into_iter().collect()).pretty());
            return Ok(0);
        }
        let listed = reading(
            reply.get("peers"),
            if all { "peers" } else { "rows" },
            "filter",
        )?;
        let (peers, hidden, historic) = view::unlisted(listed, all);
        if flags.on("json") {
            out(&rows_json("peers", &peers, hidden + historic));
            return Ok(0);
        }
        let folded = if all || flags.on("roots") {
            HashSet::new()
        } else {
            let everyone = ask(opened, "list", vec![("all", Value::Bool(true))]).await?;
            view::unspawned(
                reading(everyone.get("endpoints"), "endpoints", "map")?,
                &opened.me,
            )
        };
        let shown: Vec<&Json> = peers
            .iter()
            .copied()
            .filter(|p| !folded.contains(&text(p.get("address"))))
            .collect();
        if shown.is_empty() {
            note(if peers.is_empty() {
                "nobody you may message"
            } else {
                "nobody you may message but other sessions"
            });
        } else {
            print(view::peers(&shown));
        }
        notes(view::hidden_note(hidden, historic));
        notes(view::fold_note(peers.len() - shown.len()));
        Ok(0)
    })
}

fn why<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let words = &call.parsed.positionals;
        let (from, to) = match words.as_slice() {
            [from, to] if !from.is_empty() && !to.is_empty() => (from, to),
            _ => return Err(usage(format!("{CLI_NAME} why takes <from> <to>"))),
        };
        let result = ask(
            opened,
            "why",
            vec![
                ("from", Value::from(from.as_str())),
                ("to", Value::from(to.as_str())),
            ],
        )
        .await?;
        let allowed = truthy(result.get("allowed"));
        if call.parsed.on("json") {
            out(&result.pretty());
        } else {
            out(&if allowed {
                format!("{from} may message {to}")
            } else {
                format!("{from} may not message {to}")
            });
            for reason in iterating(result.get("reasons"), "result.reasons")? {
                out(&format!("  {}", text(Some(&reason))));
            }
        }
        Ok(if allowed { 0 } else { 1 })
    })
}

/// a `--since` or `--limit` count: digits only, as a number
fn count_arg(value: Option<&str>, flag: &str) -> Result<Option<Value>, Fail> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(usage(format!(
            "{flag} takes a whole number, not {}",
            crate::args::js_string(value)
        )));
    }
    let number: f64 = value.parse().unwrap_or(f64::INFINITY);
    Ok(Some(match scp_mcp::tools::js_num(number).parse::<u64>() {
        Ok(whole) => Value::from(whole),
        Err(_) => Value::from(number),
    }))
}

fn log<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let flags = &call.parsed;
        let since = count_arg(flags.text("since"), "--since")?;
        let limit = count_arg(flags.text("limit"), "--limit")?;
        let picks = ["scope", "judge", "peek"];
        if picks.iter().filter(|k| flags.on(k)).count() > 1 {
            return Err(usage(format!(
                "{CLI_NAME} log takes one of --scope, --judge or --peek"
            )));
        }
        let mut params: Vec<(&str, Value)> = [("since", since), ("limit", limit)]
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k, v)))
            .collect();
        params.extend(
            picks
                .into_iter()
                .filter(|k| flags.on(k))
                .map(|k| (k, Value::Bool(true))),
        );
        let reply = ask(opened, "log", params).await?;
        if flags.on("json") {
            let entries = reply.get("rows").map(|r| ("rows", r.clone()));
            out(&Json::object(entries.into_iter().collect()).pretty());
            return Ok(0);
        }
        for row in iterating(reply.get("rows"), "rows")? {
            out(&view::log_line(&row));
        }
        Ok(0)
    })
}

fn policy<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let json = call.parsed.on("json");
        let words = &call.parsed.positionals;
        let action = words.first().map(String::as_str);
        if action == Some("path") {
            let broker = Json::from(&opened.broker);
            let file = broker.get("policy").and_then(|p| p.get("file")).cloned();
            if json {
                let entries = file.map(|f| ("file", f)).into_iter().collect();
                out(&Json::object(entries).pretty());
            } else {
                out(&text(file.as_ref()));
            }
            return Ok(0);
        }
        if action == Some("show") {
            let shown = ask(opened, "policy", Vec::new()).await?;
            let state = shown.get("state").and_then(Json::as_str);
            if json {
                out(&shown.pretty());
            } else if state == Some("open") {
                out(&format!(
                    "no policy at {}: every agent may message every other",
                    text(shown.get("file"))
                ));
            } else if state == Some("error") {
                out(&text(shown.get("error")));
            } else {
                let policy = shown.get("policy").map_or("undefined".into(), Json::pretty);
                out(&format!("{}:\n{policy}", text(shown.get("file"))));
            }
            return Ok(if state == Some("error") { 1 } else { 0 });
        }
        if let (Some("check"), Some(from), Some(to)) = (action, words.get(1), words.get(2))
            && !from.is_empty()
            && !to.is_empty()
        {
            let result = ask(
                opened,
                "policy_check",
                vec![
                    ("from", Value::from(from.as_str())),
                    ("to", Value::from(to.as_str())),
                ],
            )
            .await?;
            let allowed = truthy(result.get("allowed"));
            if json {
                out(&result.pretty());
            } else if allowed {
                out(&format!("{from} may message {to}"));
            } else {
                out(&format!("refused: {}", text(result.get("reason"))));
            }
            return Ok(if allowed { 0 } else { 1 });
        }
        Err(usage(format!(
            "{CLI_NAME} policy takes show, path, or check <from> <to>"
        )))
    })
}

async fn receipts(call: &Call<'_>, opened: &Opened) -> Done {
    let flags = &call.parsed;
    let words = &flags.positionals;
    if words.len() > 1 || flags.on("all") || flags.on("activity") {
        return Err(usage(format!(
            "{CLI_NAME} status takes one message id, or --all and --activity for the fleet"
        )));
    }
    if !scp_mcp::tools::truthy(Some(&opened.me)) {
        return Err(usage(format!(
            "{CLI_NAME} status <id> reads a message you sent: pass --as HANDLE, or run it from the agent's shell or your terminal"
        )));
    }
    let receipts = ask(
        opened,
        "receipts",
        vec![("id", Value::from(words[0].as_str()))],
    )
    .await?;
    if flags.on("json") {
        out(&receipts.pretty());
        return Ok(0);
    }
    out(&format!("{}:", text(receipts.get("id"))));
    reading(receipts.get("recipients"), "receipts.recipients", "map")?;
    let lines = receipt_lines(&receipts.to_value());
    if lines.is_empty() {
        out("  no deliveries of it are kept any more");
    }
    for line in lines {
        out(&format!("  {line}"));
    }
    Ok(0)
}

fn status<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        if !call.parsed.positionals.is_empty() {
            return receipts(call, opened).await;
        }
        let flags = &call.parsed;
        let all = flags.on("all");
        let mut snapshot = ask(opened, "snapshot", vec![("all", Value::Bool(all))]).await?;
        let broker = snapshot.get("broker").filter(|b| truthy(Some(b))).cloned();
        let engine = broker
            .as_ref()
            .and_then(|b| mounts::broker_engine(&field(b, "pid")));
        notes(
            mounts::gone_hook_lines(call.env)
                .into_iter()
                .map(|line| format!("! {line}")),
        );
        let mounted = mounts::mount_engines(call.env);
        if flags.on("json") {
            if let (Some(mut broker), Some(engine)) = (broker, engine) {
                broker.set("engine", Json::str(engine));
                snapshot.set("broker", broker);
            }
            snapshot.set("mcp", mounts::mounts_json(call.env, &mounted));
            out(&snapshot.pretty());
            return Ok(0);
        }
        out(&match &broker {
            Some(broker) => view::broker_line(&broker.to_value(), engine),
            None => view::broker_line(&opened.broker, None),
        });
        if let Some(line) = mounts::mcp_line(&mounted) {
            out(&line);
        }
        if engine == Some("native") && mounted.iter().any(|m| m.mode == "mcp") {
            note(&format!(
                "! the broker is the native one, but mounts with SCP_NATIVE=mcp run on the TypeScript broker: {CLI_NAME} daemon restart without SCP_NATIVE=1 replaces it"
            ));
        }
        if let Err(fail) = reading(snapshot.get("endpoints"), "snapshot.endpoints", "filter") {
            if let Some(line) = view::you_line(&opened.me) {
                out(&line);
            }
            return Err(fail);
        }
        let (lines, quotes) = view::summary(&snapshot, &opened.me, all);
        print(lines);
        let shown = flags.on("activity") && length(snapshot.get("activity"))? > 0;
        if shown {
            out("");
            for row in iterating(snapshot.get("activity"), "snapshot.activity")? {
                out(&view::activity_line(&row, &text(row.get("at"))));
            }
        }
        if quotes || shown {
            note(QUOTED_NOTE);
        }
        Ok(0)
    })
}

/// what the TypeScript CLI exits with once the broker closes a watch: Node's code for a top-level await left pending
const UNSETTLED: i32 = 13;

extern "C" fn interrupted(_: libc::c_int) {
    // SAFETY: _exit is async-signal-safe, and every line went out unbuffered
    unsafe { libc::_exit(0) }
}

/// prints the snapshot `swarm watch` opens with, and again after it fell behind
fn snapshot(
    call: &Call<'_>,
    opened: &Opened,
    snapshot: &Json,
    noted: &mut bool,
) -> Result<(), Fail> {
    if call.parsed.on("json") {
        let mut line = Json::object(vec![("type", Json::str("snapshot"))]);
        for (key, value) in snapshot.entries() {
            line.set(key, value.clone());
        }
        out(&line.compact());
        return Ok(());
    }
    let endpoints = reading(snapshot.get("endpoints"), "snapshot.endpoints", "filter")?;
    let shown: Vec<&Json> = endpoints
        .iter()
        .filter(|e| {
            e.get("kind").and_then(Json::as_str) == Some("human")
                || e.get("presence").and_then(Json::as_str) != Some("offline")
        })
        .collect();
    let broker = snapshot.get("broker").filter(|b| truthy(Some(b)));
    out(&view::broker_line(
        &broker.map_or_else(|| opened.broker.clone(), Json::to_value),
        None,
    ));
    out("");
    print(view::endpoints(
        &shown,
        &opened.me,
        &scp_mcp::identity::short_hostname(),
        &home(call),
    ));
    out("");
    let activity = iterating(snapshot.get("activity"), "snapshot.activity")?;
    for row in &activity {
        out(&view::activity_line(row, &text(row.get("at"))));
    }
    let agents = shown
        .iter()
        .any(|e| e.get("kind").and_then(Json::as_str) != Some("human"));
    if (agents || !activity.is_empty()) && !*noted {
        note(QUOTED_NOTE);
        *noted = true;
    }
    let hidden = endpoints.len() - shown.len();
    if hidden > 0 {
        note(&format!(
            "{hidden} offline not shown ({CLI_NAME} list --all lists them)"
        ));
    }
    note("watching the fleet (Ctrl-C to stop)");
    Ok(())
}

/// the first of the snapshots asked for whose reply came, as its place and the reply
async fn first_ready(
    pending: &mut std::collections::VecDeque<Asked>,
) -> (usize, Result<Json, Fail>) {
    std::future::poll_fn(|cx| {
        for (at, reply) in pending.iter_mut().enumerate() {
            if let std::task::Poll::Ready(reply) = reply.as_mut().poll(cx) {
                return std::task::Poll::Ready((at, reply));
            }
        }
        std::task::Poll::Pending
    })
    .await
}

/// `swarm watch`: events print as they arrive, also while a snapshot is asked for, as the TypeScript CLI's listener does; a reply and
/// the events read with it print events first
fn watch<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        // SAFETY: installs a handler that only calls _exit
        unsafe {
            libc::signal(
                libc::SIGINT,
                interrupted as extern "C" fn(libc::c_int) as libc::sighandler_t,
            );
        }
        let json = call.parsed.on("json");
        let mut noted = false;
        let mut events = opened.client.notifications();
        let mut pending: std::collections::VecDeque<Asked> = std::collections::VecDeque::new();
        pending.push_back(ask(opened, "watch", Vec::new()));
        loop {
            let line = tokio::select! {
                biased;
                line = events.recv() => line,
                (at, reply) = first_ready(&mut pending), if !pending.is_empty() => {
                    pending.remove(at);
                    snapshot(call, opened, &reply?, &mut noted)?;
                    continue;
                }
            };
            let Some(line) = line else {
                let mut failed = None;
                for reply in pending.drain(..) {
                    match reply.await {
                        Ok(reply) => snapshot(call, opened, &reply, &mut noted)?,
                        Err(fail) => failed = failed.or(Some(fail)),
                    }
                }
                return failed.map_or(Ok(UNSETTLED), Err);
            };
            let Some(message) = Json::parse(&line) else {
                continue;
            };
            if message.get("method").and_then(Json::as_str) != Some("fleet") {
                continue;
            }
            let event = message.get("params");
            let kind = event.and_then(|e| e.get("type")).and_then(Json::as_str);
            if json {
                out(&event.map_or("undefined".into(), Json::compact));
            } else if kind != Some("lagged") {
                if matches!(kind, Some("status" | "activity")) && !noted {
                    note(QUOTED_NOTE);
                    noted = true;
                }
                out(&view::fleet_line(event.unwrap_or(&Json::Null)));
            }
            if kind == Some("lagged") {
                if !json {
                    note(
                        "watch fell behind and missed events; starting over from a fresh snapshot",
                    );
                }
                pending.push_back(ask(opened, "watch", Vec::new()));
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_take_digits_only() {
        assert_eq!(count_arg(None, "--since"), Ok(None));
        assert_eq!(count_arg(Some("007"), "--since"), Ok(Some(Value::from(7))));
        assert_eq!(
            count_arg(Some("-1"), "--limit"),
            Err(usage("--limit takes a whole number, not \"-1\""))
        );
        assert_eq!(
            count_arg(Some("1000000000000000128"), "--since"),
            Ok(Some(Value::from(1_000_000_000_000_000_100_u64)))
        );
        assert_eq!(
            count_arg(Some("99999999999999999999"), "--limit"),
            Ok(Some(Value::from(1e20)))
        );
    }
}
