//! What the messaging verbs print: a message as `printMessage` writes it, a send's outcome, and JSON whose own keys keep their order.

use crate::term::pretty;
use scp_core::protocol::CLI_NAME;
use scp_mcp::render::{clock, delivery_text, list_of, reach_lines, short_id, wrap_message};
use scp_mcp::tools::{get, held_text, js, redacted_text, truthy};
use serde_json::Value;

/// JSON as `JSON.stringify(v, null, 2)` writes an object literal the CLI builds: its keys in the order written
pub enum Json<'a> {
    Value(&'a Value),
    Object(Vec<(&'a str, Json<'a>)>),
    Array(Vec<Json<'a>>),
}

impl<'a> Json<'a> {
    /// `{ ...first, ...object, ...last }`: a later key takes an earlier one's value where it stands
    pub fn spread(
        first: &[(&'a str, Json<'a>)],
        object: &'a Value,
        last: Vec<(&'a str, Json<'a>)>,
    ) -> Json<'a> {
        let mut entries: Vec<(&str, Json)> = first.iter().map(|(k, v)| (*k, v.shallow())).collect();
        let middle = object
            .as_object()
            .into_iter()
            .flat_map(|m| m.iter().map(|(k, v)| (k.as_str(), Json::Value(v))));
        for (key, value) in middle.chain(last) {
            match entries.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = value,
                None => entries.push((key, value)),
            }
        }
        Json::Object(entries)
    }

    fn shallow(&self) -> Json<'a> {
        match self {
            Json::Value(v) => Json::Value(v),
            Json::Object(entries) => {
                Json::Object(entries.iter().map(|(k, v)| (*k, v.shallow())).collect())
            }
            Json::Array(items) => Json::Array(items.iter().map(Json::shallow).collect()),
        }
    }

    pub fn text(&self) -> String {
        let mut text = String::new();
        self.write(&mut text, 0);
        text
    }

    fn write(&self, text: &mut String, depth: usize) {
        let newline = |text: &mut String, depth: usize| {
            text.push('\n');
            text.push_str(&"  ".repeat(depth));
        };
        match self {
            Json::Value(value) => {
                text.push_str(&pretty(value).replace('\n', &format!("\n{}", "  ".repeat(depth))))
            }
            Json::Object(entries) if entries.is_empty() => text.push_str("{}"),
            Json::Array(items) if items.is_empty() => text.push_str("[]"),
            Json::Object(entries) => {
                text.push('{');
                for (at, (key, value)) in entries.iter().enumerate() {
                    if at > 0 {
                        text.push(',');
                    }
                    newline(text, depth + 1);
                    text.push_str(&crate::args::js_string(key));
                    text.push_str(": ");
                    value.write(text, depth + 1);
                }
                newline(text, depth);
                text.push('}');
            }
            Json::Array(items) => {
                text.push('[');
                for (at, item) in items.iter().enumerate() {
                    if at > 0 {
                        text.push(',');
                    }
                    newline(text, depth + 1);
                    item.write(text, depth + 1);
                }
                newline(text, depth);
                text.push(']');
            }
        }
    }
}

fn time(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".into(), clock)
}

/// a message's header line, its hook note and its wrapped text, then a blank line
pub fn message_text(message: &Value) -> String {
    let from = get(message, "from");
    let from_of = |key: &str| from.and_then(|f| get(f, key));
    let claim = |key: &str| from_of("claims").and_then(|c| get(c, key));
    let local = if claim("tty") == Some(&Value::Bool(false)) {
        "human, no terminal".to_owned()
    } else {
        match claim("harness") {
            None | Some(Value::Null) => "?".into(),
            some => js(some),
        }
    };
    let harness = match from_of("account") {
        Some(account) => format!(
            "{}, account {}, contact",
            if truthy(from_of("human")) {
                "human"
            } else {
                &local
            },
            js(Some(account))
        ),
        None => local,
    };
    let id = js(get(message, "id"));
    let reply_to = get(message, "reply_to").filter(|r| truthy(Some(r)));
    let mut text = format!(
        "#{} {} from {} ({harness}) {}  id {} ({id}){}\n",
        js(get(message, "seq")),
        js(get(message, "kind")),
        js(from_of("address")),
        time(get(message, "created_at")),
        short_id(&id),
        reply_to.map_or(String::new(), |r| format!("  reply to {}", js(Some(r))))
    );
    if let Some(shown) = get(message, "shown_at").filter(|s| truthy(Some(s))) {
        text.push_str(&format!(
            "(a hook already showed you this at {}; that copy may reach you after this command)\n",
            time(Some(shown))
        ));
    }
    text.push_str(&wrap_message(message));
    text.push_str("\n\n");
    text
}

/// a send's outcome as lines: held, else who it went to, then when each sees it
pub fn sent_lines(result: &Value) -> Vec<String> {
    if let Some(held) = get(result, "held").filter(|h| truthy(Some(h))) {
        return vec![held_text(held)];
    }
    let deliveries = list_of(get(result, "deliveries"));
    let reach = reach_lines(deliveries, false);
    let to = deliveries
        .iter()
        .map(|d| {
            if reach.is_empty() {
                delivery_text(d)
            } else {
                js(get(d, "address"))
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let id = js(get(result, "id"));
    let mut lines = vec![format!(
        "sent {id} to {to}{}",
        redacted_text(get(result, "redacted"))
    )];
    let warnings = list_of(get(result, "warnings")).iter().map(|w| js(Some(w)));
    lines.extend(reach.into_iter().chain(warnings).map(|l| format!("  {l}")));
    let pending = deliveries.iter().any(|d| {
        matches!(
            get(d, "state").and_then(Value::as_str),
            Some("running" | "starting")
        )
    });
    if pending {
        lines.push(format!(
            "  {CLI_NAME} status {} shows when it is read",
            short_id(&id)
        ));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spread_keys_keep_their_place_and_later_ones_append() {
        let result = json!({"b": 1, "a": {"y": [1], "x": null}});
        let preamble = json!("p");
        let printed = Json::spread(&[("preamble", Json::Value(&preamble))], &result, vec![]).text();
        assert_eq!(
            printed,
            "{\n  \"preamble\": \"p\",\n  \"a\": {\n    \"x\": null,\n    \"y\": [\n      1\n    ]\n  },\n  \"b\": 1\n}"
        );
        let (id, short) = (json!("msg_1"), json!("1"));
        let answered = Json::Object(vec![
            ("id", Json::Value(&id)),
            ("short", Json::Value(&short)),
        ]);
        let printed = Json::spread(
            &[],
            &json!({"z": 0, "reply_to": 1}),
            vec![("reply_to", answered)],
        )
        .text();
        assert_eq!(
            printed,
            "{\n  \"reply_to\": {\n    \"id\": \"msg_1\",\n    \"short\": \"1\"\n  },\n  \"z\": 0\n}"
        );
        assert_eq!(Json::Array(vec![]).text(), "[]");
        assert_eq!(Json::Object(vec![]).text(), "{}");
    }

    #[test]
    fn a_send_reads_as_the_cli_writes_it() {
        let held = json!({"id": "msg_x", "deliveries": [], "held": {"hold_id": "hold_1"}});
        assert_eq!(
            sent_lines(&held),
            ["held for review by your human: hold hold_1; nothing was delivered"]
        );
        let queued = json!({"id": "msg_0abcdef", "deliveries": [{"address": "me/a", "queued": true}], "warnings": ["w"]});
        assert_eq!(
            sent_lines(&queued),
            [
                "sent msg_0abcdef to me/a (queued: recipient not connected right now)",
                "  w"
            ]
        );
        let running = json!({
            "id": "msg_0abcdef",
            "deliveries": [{"address": "me/a", "state": "running"}, {"address": "me/b", "state": "ended"}],
            "redacted": {"n": 2, "kinds": ["email", "phone"]}
        });
        assert_eq!(
            sent_lines(&running),
            [
                "sent msg_0abcdef to me/a, me/b; redacted 2 spans (email, phone) before delivery",
                "  me/a: delivered; it sees this at its next tool call or when its turn ends",
                "  me/b: its run ended; it will not see this unless it is started again",
                "  swarm status abcdef shows when it is read"
            ]
        );
    }

    #[test]
    fn a_message_header_names_its_sender_and_ids() {
        let message = json!({
            "seq": 3,
            "kind": "message",
            "id": "msg_0abc123",
            "thread": "thr_1",
            "data_class": "public",
            "created_at": "not a time",
            "reply_to": "msg_0prev",
            "from": {"address": "me/a", "auth": "local-uid", "account": "acct", "human": true, "claims": {"harness": "codex"}},
            "body": {"text": "hi"}
        });
        let text = message_text(&message);
        let head = text.lines().next().unwrap();
        assert_eq!(
            head,
            "#3 message from me/a (human, account acct, contact) not a time  id abc123 (msg_0abc123)  reply to msg_0prev"
        );
        assert!(text.ends_with("\n\n"));
        let bare =
            json!({"from": {"address": "me/b", "claims": {"tty": false}}, "id": "msg_1234567"});
        assert!(message_text(&bare).starts_with(
            "#undefined undefined from me/b (human, no terminal) undefined  id 234567 (msg_1234567)\n"
        ));
    }
}
