//! Send, ask, ask-wait, reply, inbox, ack and show.

mod body;
mod text;

use crate::fleet::json::Json;
use crate::fleet::result_of;
use crate::open::Opened;
use crate::term::{note, out};
use crate::{Call, Done, Fail, Run, Verb, usage};
use body::{body_text, js_number};
use scp_core::protocol::{CLI_NAME, LIMITS};
use scp_mcp::LocalFuture;
use scp_mcp::client::CallError;
use scp_mcp::render::{PREAMBLE, list_of, reach_lines, short_id};
use scp_mcp::tools::{get, held_text, js, js_num, js_trim, truthy};
use serde_json::{Map, Value};
use text::{message_text, sent_lines};

pub use body::body_from_stdin;

pub const VERBS: &[Verb] = &[
    Verb {
        name: "send",
        run: Run::Opened(send),
    },
    Verb {
        name: "ask",
        run: Run::Opened(send),
    },
    Verb {
        name: "reply",
        run: Run::Opened(reply),
    },
    Verb {
        name: "ask-wait",
        run: Run::Opened(ask_wait),
    },
    Verb {
        name: "inbox",
        run: Run::Opened(inbox),
    },
    Verb {
        name: "show",
        run: Run::Opened(show),
    },
    Verb {
        name: "ack",
        run: Run::Opened(ack),
    },
];

const ACK_ALL_PAGES: u64 = (2 * LIMITS.inbox_max).div_ceil(LIMITS.inbox_page) + 1;

/// a reply's result, its keys in the order the broker wrote them
async fn request(opened: &Opened, method: &str, params: Map<String, Value>) -> Result<Json, Fail> {
    let line = opened
        .client
        .request_line(method, Value::Object(params))
        .await?;
    result_of(&line)
}

/// a message delivered to the caller by id, seq, unique suffix or `last`, with `member` also one in a thread the caller is in;
/// a reference the broker cannot resolve is a usage error saying why
async fn lookup(opened: &Opened, id: &str, member: bool) -> Result<Option<Json>, Fail> {
    let mut params = Map::new();
    params.insert("id".into(), Value::from(id));
    if member {
        params.insert("member".into(), Value::Bool(true));
    }
    match request(opened, "message", params).await {
        Ok(reply) => Ok(reply
            .get("message")
            .filter(|m| crate::fleet::view::truthy(Some(m)))
            .cloned()),
        Err(Fail::Call(CallError::Relay { code, message, .. })) if code == "invalid_params" => {
            Err(usage(message))
        }
        Err(error) => Err(error),
    }
}

/// the body: the text given, else stdin
async fn read_body(text: Option<&str>) -> Result<String, Fail> {
    if let Some(text) = text.filter(|t| *t != "-") {
        return Ok(text.to_owned());
    }
    let read = tokio::task::spawn_blocking(|| {
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut std::io::stdin().lock(), &mut bytes).map(|_| bytes)
    })
    .await
    .map_err(|error| Fail::Call(CallError::Io(error.to_string())))?;
    body_text(&stdin_bytes(read)?)
}

/// what Node's stdin stream yields for a read: a directory or a closed descriptor reads as empty, any other failure fails
fn stdin_bytes(read: std::io::Result<Vec<u8>>) -> Result<Vec<u8>, Fail> {
    match read {
        Ok(bytes) => Ok(bytes),
        Err(error) if matches!(error.raw_os_error(), Some(libc::EISDIR | libc::EBADF)) => {
            Ok(Vec::new())
        }
        Err(error) => Err(Fail::Call(CallError::Io(read_error(&error)))),
    }
}

/// a failed stdin read as Node words it: `EISDIR: illegal operation on a directory, read`
fn read_error(error: &std::io::Error) -> String {
    match crate::open::errno_words(error) {
        Some((code, words)) => format!("{code}: {words}, read"),
        None => error.to_string(),
    }
}

/// a reply's `messages`, failing as reading `.length` of null or undefined does in Node
fn messages_of(value: Option<&Value>) -> Result<&[Value], Fail> {
    let missing = match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(other) => return Ok(list_of(Some(other))),
    };
    Err(Fail::Call(CallError::Io(format!(
        "Cannot read properties of {missing} (reading 'length')"
    ))))
}

/// `total + count` as JavaScript adds a reply's count: null adds nothing, anything but a number gives NaN
fn add_count(total: f64, count: Option<&Value>) -> f64 {
    match count {
        Some(Value::Null) => total,
        Some(n) => total + n.as_f64().unwrap_or(f64::NAN),
        None => f64::NAN,
    }
}

/// what an empty inbox says, naming the cap when the wait asked past it
fn empty_note(waited: f64) -> String {
    let tail = if waited > LIMITS.wait_max_s as f64 {
        format!("; waited {} s (cap)", LIMITS.wait_max_s)
    } else {
        String::new()
    };
    format!("no unread messages{tail}")
}

/// `--wait` as seconds, `fallback` when absent
fn wait_arg(value: Option<&str>, fallback: f64) -> Result<f64, Fail> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    match js_number(value) {
        Some(seconds) if seconds.is_finite() && seconds >= 0.0 => Ok(seconds),
        _ => Err(usage(format!(
            "--wait takes seconds, not {}",
            crate::args::js_string(value)
        ))),
    }
}

/// a number as JSON carries it from JavaScript
fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

fn print_message(message: &Value) {
    crate::term::print(&message_text(message));
}

/// what `ask` and `ask-wait` print for `result`, and the exit code: 0 with a reply, else 2
fn print_ask(answer: &Json, as_json: bool, to: &str) -> i32 {
    let result = &answer.to_value();
    let reply = get(result, "reply").filter(|r| truthy(Some(r)));
    let ended = list_of(get(result, "ended"));
    if as_json {
        let preamble = vec![("preamble", Json::str(PREAMBLE))];
        out(&Json::spread(preamble, answer, vec![]).pretty());
    } else if let Some(held) = get(result, "held").filter(|h| truthy(Some(h))) {
        out(&held_text(held));
    } else if let Some(reply) = reply {
        out(PREAMBLE);
        out("");
        print_message(reply);
    } else if truthy(get(result, "expired")) {
        note(&format!(
            "request {} expired without a reply",
            js(get(result, "id"))
        ));
    } else if !ended.is_empty() {
        for e in ended {
            let state = match get(e, "state") {
                None | Some(Value::Null) => "no status".into(),
                some => js(some),
            };
            note(&format!(
                "{} ended ({state}) without replying; the request stays queued",
                js(get(e, "address"))
            ));
        }
    } else {
        let late = reach_lines(list_of(get(result, "deliveries")), true);
        let id = js(get(result, "id"));
        note(&if late.is_empty() {
            format!(
                "no reply yet: {to} sees the request on its next tool turn or prompt; wait more with: {CLI_NAME} ask-wait {id}"
            )
        } else {
            format!("no reply yet; wait more with: {CLI_NAME} ask-wait {id}")
        });
        for line in late {
            note(&line);
        }
    }
    if reply.is_some() { 0 } else { 2 }
}

/// `--attach` paths as the broker takes them, relative ones under the working directory
fn attachments(paths: &[String]) -> Vec<Value> {
    if paths.is_empty() {
        return Vec::new();
    }
    let cwd = scp_mcp::identity::safe_cwd();
    paths
        .iter()
        .map(|path| {
            let path = if path.starts_with('/') {
                path.clone()
            } else {
                format!("{cwd}/{path}")
            };
            let mut attachment = Map::new();
            attachment.insert("kind".into(), Value::from("path"));
            attachment.insert("path".into(), Value::from(path));
            Value::Object(attachment)
        })
        .collect()
}

fn send<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let parsed = &call.parsed;
        let words = &parsed.positionals;
        let Some(to) = words.first().filter(|t| !t.is_empty()) else {
            return Err(usage(format!(
                "{CLI_NAME} {} needs an address: a handle, me/<handle>, or me/ for your own inbox",
                call.verb
            )));
        };
        let reply_to = match parsed.text("reply-to").filter(|r| !r.is_empty()) {
            Some(reference) => Some(
                lookup(opened, reference, true)
                    .await?
                    .and_then(|m| m.get("id").map(Json::to_value))
                    .filter(|id| !id.is_null())
                    .unwrap_or_else(|| Value::from(reference)),
            ),
            None => None,
        };
        let mut params = Map::new();
        params.insert("to".into(), Value::from(to.as_str()));
        let body = read_body(words.get(1).map(String::as_str)).await?;
        params.insert("body".into(), Value::from(body));
        if let Some(reply_to) = reply_to.filter(|r| truthy(Some(r))) {
            params.insert("reply_to".into(), reply_to);
            params.insert("kind".into(), Value::from("reply"));
        }
        if let Some(thread) = parsed.text("thread").filter(|t| !t.is_empty()) {
            params.insert("thread".into(), Value::from(thread));
        }
        if parsed.on("private") {
            params.insert("data_class".into(), Value::from("private"));
        }
        let attachments = attachments(parsed.list("attach"));
        if !attachments.is_empty() {
            params.insert("attachments".into(), Value::Array(attachments));
        }
        let as_json = parsed.on("json");
        if call.verb == "send" {
            if parsed.on("live") {
                params.insert("live".into(), Value::Bool(true));
            }
            let result = request(opened, "send", params).await?;
            if as_json {
                out(&result.pretty());
            } else {
                for line in sent_lines(&result.to_value()) {
                    out(&line);
                }
            }
            return Ok(0);
        }
        if parsed.on("require-reply") {
            params.insert("require_reply".into(), Value::Bool(true));
        }
        let wait = wait_arg(parsed.text("wait"), 50.0)?;
        params.insert("wait_s".into(), number(wait));
        let result = request(opened, "ask", params).await?;
        Ok(print_ask(&result, as_json, js_trim(to)))
    })
}

fn reply<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let words = &call.parsed.positionals;
        let Some(id) = words.first().filter(|i| !i.is_empty() && words.len() <= 2) else {
            return Err(usage(format!(
                "{CLI_NAME} reply needs the message's id: {CLI_NAME} reply <id> [text|-]"
            )));
        };
        let Some(message) = lookup(opened, id, true).await? else {
            return Err(usage(format!(
                "no message {id} was delivered to you or sits in a thread you are in; {CLI_NAME} send writes to an agent"
            )));
        };
        let message = message.to_value();
        let from = get(&message, "from").and_then(|f| get(f, "address"));
        let mut params = Map::new();
        if let Some(from) = from {
            params.insert("to".into(), from.clone());
        }
        let body = read_body(words.get(1).map(String::as_str)).await?;
        params.insert("body".into(), Value::from(body));
        params.insert("kind".into(), Value::from("reply"));
        for (key, field) in [("reply_to", "id"), ("thread", "thread")] {
            if let Some(value) = get(&message, field) {
                params.insert(key.into(), value.clone());
            }
        }
        let answer = request(opened, "send", params).await?;
        let result = answer.to_value();
        let id_value = get(&message, "id").cloned().unwrap_or(Value::Null);
        let message_id = js(get(&message, "id"));
        let short = Value::from(short_id(&message_id));
        let from = Value::from(js(from));
        if call.parsed.on("json") {
            let answered = Json::object(vec![
                ("id", Json::from(&id_value)),
                ("short", Json::from(&short)),
                ("from", Json::from(&from)),
            ]);
            out(&Json::spread(vec![], &answer, vec![("reply_to", answered)]).pretty());
            return Ok(0);
        }
        let deliveries = list_of(get(&result, "deliveries"));
        let to = deliveries
            .iter()
            .map(|d| js(get(d, "address")))
            .collect::<Vec<_>>()
            .join(", ");
        out(&format!(
            "replied {} to {to}, answering {} from {} ({message_id})",
            js(get(&result, "id")),
            js(Some(&short)),
            js(Some(&from))
        ));
        for line in reach_lines(deliveries, true) {
            out(&format!("  {line}"));
        }
        Ok(0)
    })
}

fn ask_wait<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let Some(id) = call.parsed.positionals.first().filter(|i| !i.is_empty()) else {
            return Err(usage(format!("{CLI_NAME} ask-wait needs the request's id")));
        };
        let wait = wait_arg(call.parsed.text("wait"), 50.0)?;
        let mut params = Map::new();
        params.insert("id".into(), Value::from(id.as_str()));
        params.insert("wait_s".into(), number(wait));
        let result = request(opened, "ask_wait", params).await?;
        Ok(print_ask(&result, call.parsed.on("json"), "the receiver"))
    })
}

fn inbox<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let parsed = &call.parsed;
        if parsed.on("ack") && parsed.on("keep") {
            return Err(usage("--ack and --keep: pick one"));
        }
        let waited = wait_arg(parsed.text("wait"), 0.0)?;
        let mut params = Map::new();
        params.insert("wait_s".into(), number(waited));
        let reply = request(opened, "inbox", params).await?;
        let listed = reply.get("messages");
        if parsed.on("json") {
            let mut entries = vec![("preamble", Json::str(PREAMBLE))];
            if let Some(listed) = listed {
                entries.push(("messages", listed.clone()));
            }
            out(&Json::object(entries).pretty());
            if parsed.on("keep") {
                return Ok(0);
            }
        }
        let listed = listed.map(Json::to_value);
        let messages = messages_of(listed.as_ref())?;
        if !parsed.on("json") && messages.is_empty() {
            note(&empty_note(waited));
        } else if !parsed.on("json") {
            out(PREAMBLE);
            out("");
            for message in messages {
                print_message(message);
            }
        }
        if !parsed.on("keep") && !messages.is_empty() {
            let seqs = messages
                .iter()
                .map(|m| get(m, "seq").cloned().unwrap_or(Value::Null))
                .collect();
            let mut params = Map::new();
            params.insert("seqs".into(), Value::Array(seqs));
            request(opened, "ack", params).await?;
        }
        Ok(0)
    })
}

fn show<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let [id] = call.parsed.positionals.as_slice() else {
            return Err(usage(format!("{CLI_NAME} show takes one message id")));
        };
        let Some(message) = lookup(opened, id, false).await? else {
            return Err(usage(format!("no message {id} was delivered to you")));
        };
        if call.parsed.on("json") {
            let entries = vec![("preamble", Json::str(PREAMBLE)), ("message", message)];
            out(&Json::object(entries).pretty());
        } else {
            out(PREAMBLE);
            out("");
            print_message(&message.to_value());
        }
        Ok(0)
    })
}

fn digits(word: &str) -> bool {
    !word.is_empty() && word.bytes().all(|b| b.is_ascii_digit())
}

/// whether `word` names a message for `ack`: a seq, a full id, `last` or an id's suffix
pub fn ack_word(word: &str) -> bool {
    let full = word
        .strip_prefix("msg_")
        .is_some_and(|rest| !rest.is_empty() && !rest.chars().any(scp_mcp::render::js_space));
    let suffix = word.len() >= 4
        && word
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase());
    digits(word) || full || word == "last" || suffix
}

/// acks `seqs` a page at a time: how many the broker acked
async fn ack_seqs(opened: &Opened, seqs: &[Value]) -> Result<f64, Fail> {
    let mut acked = 0.0;
    for chunk in seqs.chunks(LIMITS.inbox_page as usize) {
        let mut params = Map::new();
        params.insert("seqs".into(), Value::Array(chunk.to_vec()));
        let reply = request(opened, "ack", params).await?.to_value();
        acked = add_count(acked, get(&reply, "acked"));
    }
    Ok(acked)
}

fn ack<'a>(call: &'a Call<'a>, opened: &'a Opened) -> LocalFuture<'a, Done> {
    Box::pin(async move {
        let parsed = &call.parsed;
        let words = &parsed.positionals;
        let all = parsed.on("all");
        if all != words.is_empty() || !words.iter().all(|w| ack_word(w)) {
            return Err(usage(format!(
                "{CLI_NAME} ack takes message ids or seq numbers, or --all"
            )));
        }
        let mut acked = 0.0;
        let mut resolved: Vec<(Value, Value, Value)> = Vec::new();
        if all {
            for _ in 0..ACK_ALL_PAGES {
                let mut params = Map::new();
                params.insert("wait_s".into(), Value::from(0));
                let reply = request(opened, "inbox", params).await?.to_value();
                let messages = messages_of(get(&reply, "messages"))?;
                if messages.is_empty() {
                    break;
                }
                let seqs: Vec<Value> = messages
                    .iter()
                    .filter_map(|m| get(m, "seq").cloned())
                    .collect();
                acked += ack_seqs(opened, &seqs).await?;
            }
        } else {
            let mut seqs = Vec::new();
            for word in words {
                let message = lookup(opened, word, false).await?.map(|m| m.to_value());
                match message.as_ref().and_then(|m| get(m, "seq").map(|s| (m, s))) {
                    Some((message, seq)) => {
                        seqs.push(seq.clone());
                        let id = get(message, "id").cloned().unwrap_or(Value::Null);
                        if !resolved.iter().any(|(known, _, _)| *known == id) {
                            let short = Value::from(short_id(&js(Some(&id))));
                            let from = Value::from(js(
                                get(message, "from").and_then(|f| get(f, "address"))
                            ));
                            resolved.push((id, short, from));
                        }
                    }
                    None if digits(word) => seqs.push(number(js_number(word).unwrap_or(f64::NAN))),
                    None => {}
                }
            }
            acked += ack_seqs(opened, &seqs).await?;
        }
        if parsed.on("json") {
            let mut entries = vec![("acked", Json::from(&number(acked)))];
            if !resolved.is_empty() {
                let messages = resolved
                    .iter()
                    .map(|(id, short, from)| {
                        Json::object(vec![
                            ("id", Json::from(id)),
                            ("short", Json::from(short)),
                            ("from", Json::from(from)),
                        ])
                    })
                    .collect();
                entries.push(("messages", Json::Arr(messages)));
            }
            out(&Json::object(entries).pretty());
        } else {
            let mut lines = vec![format!("{} acked", js_num(acked))];
            lines.extend(resolved.iter().map(|(id, short, from)| {
                format!(
                    "  {} from {} ({})",
                    js(Some(short)),
                    js(Some(from)),
                    js(Some(id))
                )
            }));
            out(&lines.join("\n"));
        }
        Ok(0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn counts_add_as_javascript_adds_them() {
        assert_eq!(add_count(2.0, Some(&json!(3))), 5.0);
        assert_eq!(add_count(2.0, Some(&Value::Null)), 2.0);
        assert!(add_count(2.0, None).is_nan());
        assert!(add_count(2.0, Some(&json!(true))).is_nan());
    }

    #[test]
    fn a_reply_without_messages_fails_as_node_reads_its_length() {
        assert_eq!(messages_of(Some(&json!([1]))).unwrap(), &[json!(1)]);
        for (value, word) in [(None, "undefined"), (Some(&Value::Null), "null")] {
            assert_eq!(
                messages_of(value),
                Err(Fail::Call(CallError::Io(format!(
                    "Cannot read properties of {word} (reading 'length')"
                ))))
            );
        }
    }

    #[test]
    fn a_directory_or_closed_stdin_reads_empty_as_in_node() {
        for code in [libc::EISDIR, libc::EBADF] {
            assert_eq!(
                stdin_bytes(Err(std::io::Error::from_raw_os_error(code))),
                Ok(Vec::new())
            );
        }
        assert_eq!(
            stdin_bytes(Err(std::io::Error::from_raw_os_error(libc::EACCES))),
            Err(Fail::Call(CallError::Io(
                "EACCES: permission denied, read".into()
            )))
        );
    }

    #[test]
    fn a_failed_stdin_read_reads_as_node_words_it() {
        assert_eq!(
            read_error(&std::io::Error::from_raw_os_error(libc::EISDIR)),
            "EISDIR: illegal operation on a directory, read"
        );
    }

    #[test]
    fn ack_words_are_seqs_ids_last_or_suffixes() {
        for word in ["12", "msg_0a\u{e9}b", "last", "abcd", "0a1b2c"] {
            assert!(ack_word(word), "{word}");
        }
        for word in ["abc", "ab!d", "msg_", "msg_a b", "ABCD", ""] {
            assert!(!ack_word(word), "{word}");
        }
    }
}
