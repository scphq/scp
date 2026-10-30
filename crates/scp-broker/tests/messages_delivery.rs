mod messages_support;

use messages_support::{TestCore, params};
use scp_core::protocol::ErrorCode;
use serde_json::json;

#[tokio::test]
async fn inbox_keeps_deliveries_unread_until_ack() {
    let mut test = TestCore::new().await;
    let sent = test
        .core
        .send_message(
            "sender",
            &params(json!({"to":"me/recipient","body":"line\n\u{0} text"})),
            scp_broker::messages::Origin::default(),
        )
        .await
        .expect("send");
    let first = test
        .core
        .inbox("recipient", &params(json!({})))
        .await
        .expect("inbox");
    assert_eq!(first["messages"][0]["body"]["text"], "line\n\u{0} text");
    assert_eq!(first["messages"][0]["thread"], sent["thread"]);
    assert_eq!(
        test.core
            .inbox("recipient", &params(json!({})))
            .await
            .expect("again"),
        first
    );
    assert_eq!(
        test.core
            .ack("outsider", &json!([first["next"]]))
            .await
            .expect("foreign ack"),
        json!({"acked":0})
    );
    assert_eq!(
        test.core
            .ack("recipient", &json!([first["next"], first["next"]]))
            .await
            .expect("ack"),
        json!({"acked":1})
    );
    assert_eq!(
        test.core
            .ack("recipient", &json!([first["next"]]))
            .await
            .expect("repeat ack"),
        json!({"acked":0})
    );
    assert!(
        test.core
            .inbox("recipient", &params(json!({})))
            .await
            .expect("empty")["messages"]
            .as_array()
            .expect("messages")
            .is_empty()
    );
    test.close().await;
}

#[tokio::test]
async fn thread_continuation_requires_membership_and_accepts_message_references() {
    let mut test = TestCore::new().await;
    let sent = test
        .core
        .send_message(
            "sender",
            &params(json!({"to":"recipient","body":"first","thread":"topic"})),
            scp_broker::messages::Origin::default(),
        )
        .await
        .expect("send");
    let id = sent["id"].as_str().expect("id");
    for reference in ["topic", id, &id[id.len() - 6..]] {
        assert_eq!(
            test.core
                .send_message(
                    "recipient",
                    &params(json!({"to":"sender","body":"continue","thread":reference})),
                    scp_broker::messages::Origin::default()
                )
                .await
                .expect("continue")["thread"],
            "topic"
        );
    }
    for reference in ["topic", "msg_missing"] {
        assert_eq!(
            test.core
                .send_message(
                    "outsider",
                    &params(json!({"to":"sender","body":"hidden","thread":reference})),
                    scp_broker::messages::Origin::default()
                )
                .await
                .expect_err("no access")
                .data
                .expect("data")
                .code,
            ErrorCode::NotFound
        );
    }
    test.close().await;
}

#[tokio::test]
async fn inbox_pages_deduplicated_recipients() {
    let mut test = TestCore::new().await;
    test.core.limits.0.insert("inboxPage".into(), Some(1));
    for body in ["one", "two"] {
        let sent = test
            .core
            .send_message(
                "sender",
                &params(json!({"to":["recipient","recipient"],"body":body})),
                scp_broker::messages::Origin::default(),
            )
            .await
            .expect("send");
        assert_eq!(sent["deliveries"].as_array().expect("deliveries").len(), 1);
    }
    let first = test
        .core
        .inbox("recipient", &params(json!({"limit":100})))
        .await
        .expect("page");
    assert_eq!(first["messages"].as_array().expect("messages").len(), 1);
    assert_eq!(first["messages"][0]["to"], "me/recipient");
    let second = test
        .core
        .inbox("recipient", &params(json!({"after":first["next"]})))
        .await
        .expect("next");
    assert_eq!(second["messages"][0]["body"]["text"], "two");
    assert!(test.core.ack("recipient", &json!([1.5])).await.is_err());
    test.close().await;
}
