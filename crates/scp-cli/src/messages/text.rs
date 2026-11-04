//! What the messaging verbs print: a message as `printMessage` writes it, and a send's outcome.

use scp_core::protocol::CLI_NAME;
use scp_mcp::render::{clock, delivery_text, list_of, reach_lines, short_id, wrap_message};
use scp_mcp::tools::{get, held_text, js, redacted_text, truthy};
use serde_json::Value;

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
