use scp_broker::{
    bridge::{config::BridgeConfig, link::Bridge, route::Injected},
    core::{Core, now_ms, timestamp},
    paths::Paths,
    proto::{Limits, RpcError},
    store::SqlValue,
    store::sqlite::SqliteStore,
};
use serde_json::{Value, json};
use std::sync::Arc;

async fn fixture(policy: Option<Value>) -> (Core, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("scp-accounts-{:032x}", rand::random::<u128>()));
    tokio::fs::create_dir(&dir)
        .await
        .expect("temporary directory");
    if let Some(policy) = policy {
        tokio::fs::write(dir.join("policy.json"), policy.to_string())
            .await
            .expect("policy");
    }
    let paths = Paths::new(dir.clone());
    let mut core = Core::new(
        Arc::new(SqliteStore::open(&paths.database).expect("store")),
        Limits::default(),
        paths,
        dir.join("policy.json"),
    )
    .await
    .expect("core");
    core.load_policy().await.expect("load policy");
    Bridge::attach(
        BridgeConfig::new("ws://127.0.0.1:9", "laptop", Some("token".into())),
        &mut core,
    );
    (core, dir)
}

async fn claim(core: &mut Core, handle: &str) -> u64 {
    let conn = core.state.connect();
    let params = json!({"protocol": "scp/1", "claim": {"handle": handle, "harness": "cli"}});
    core.dispatch(conn, "hello", params.as_object().expect("params"))
        .await
        .expect("hello");
    conn
}

async fn call(core: &mut Core, conn: u64, method: &str, params: Value) -> Result<Value, RpcError> {
    core.dispatch(conn, method, params.as_object().expect("params"))
        .await
}

fn code(error: &RpcError) -> String {
    serde_json::to_value(error.data.as_ref().expect("data").code)
        .expect("code")
        .as_str()
        .expect("code text")
        .to_owned()
}

fn envelope(id: &str, from: &str, kind: &str, reply_to: Option<&str>) -> Value {
    let now = now_ms();
    json!({
        "id": id, "thread": id, "reply_to": reply_to, "kind": kind, "to": "laptop/alice",
        "body": {"text": "hello", "mime": "text/plain"}, "data_class": "public", "attachments": [], "hop": 0,
        "created_at": timestamp(now), "expires_at": timestamp(now + 3_600_000),
        "from": {"address": from, "user": "otherco", "account": "otherco", "auth": "contact", "claims": {}},
    })
}

async fn inject(core: &mut Core, message: Value) -> String {
    match core
        .inject_remote(&json!("laptop/alice"), &message)
        .await
        .expect("inject")
    {
        Injected::Admitted(_) => "admitted".into(),
        Injected::Duplicate => "duplicate".into(),
        Injected::Refused(code) => code,
    }
}

async fn scope_refusals(core: &Core, dir: &str) -> usize {
    core.store
        .all("SELECT detail FROM audit WHERE event = 'scope_refused'", &[])
        .await
        .expect("audit")
        .iter()
        .filter(|row| {
            matches!(row.get("detail"), Some(SqlValue::Text(d)) if d.contains(&format!(r#""dir":"{dir}""#)))
        })
        .count()
}

async fn sent_to(core: &Core, id: &str, from: &str, to: &str) {
    let now = SqlValue::Int(now_ms());
    let alice = core
        .store
        .all("SELECT id FROM endpoints WHERE handle = 'alice'", &[])
        .await
        .expect("alice")
        .remove(0)
        .remove("id")
        .expect("id");
    let from = if from == "alice" {
        alice
    } else {
        SqlValue::Text(from.into())
    };
    core.store
        .all(
            "INSERT INTO messages (id, thread, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at) VALUES (?, ?, 'message', ?, ?, 'hi', 'text/plain', 'public', '[]', 0, ?, ?)",
            &[SqlValue::Text(id.into()), SqlValue::Text(id.into()), from, SqlValue::Text(to.into()), now.clone(), SqlValue::Int(now_ms() + 3_600_000)],
        )
        .await
        .expect("message");
}

#[tokio::test]
async fn a_delivery_from_another_account_passes_the_recipient_in_lists_only_by_acct_or_as_a_solicited_reply()
 {
    let (mut core, dir) = fixture(None).await;
    let alice = claim(&mut core, "alice").await;
    claim(&mut core, "carol").await;
    call(&mut core, alice, "rules_set", json!({"in": ["ep:carol"]}))
        .await
        .expect("rules");

    assert_eq!(
        inject(
            &mut core,
            envelope("msg_stranger01", "otherco/mac/bob", "message", None)
        )
        .await,
        "not_found"
    );
    assert_eq!(scope_refusals(&core, "in").await, 1);

    sent_to(&core, "msg_asked0001", "alice", "otherco/mac/bob").await;
    assert_eq!(
        inject(
            &mut core,
            envelope(
                "msg_answer001",
                "otherco/mac/bob",
                "reply",
                Some("msg_asked0001")
            )
        )
        .await,
        "admitted"
    );
    sent_to(&core, "msg_asked0002", "alice", "otherco/mac/eve").await;
    assert_eq!(
        inject(
            &mut core,
            envelope(
                "msg_answer002",
                "otherco/mac/bob",
                "reply",
                Some("msg_asked0002")
            )
        )
        .await,
        "not_found"
    );

    call(
        &mut core,
        alice,
        "rules_set",
        json!({"in": ["acct:otherco"]}),
    )
    .await
    .expect("rules");
    assert_eq!(
        inject(
            &mut core,
            envelope("msg_stranger02", "otherco/mac/bob", "message", None)
        )
        .await,
        "admitted"
    );
    drop(core);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn a_send_to_another_account_passes_the_sender_out_lists_only_by_acct_or_as_a_reply_to_that_address()
 {
    let (mut core, dir) = fixture(None).await;
    let alice = claim(&mut core, "alice").await;
    claim(&mut core, "carol").await;
    call(
        &mut core,
        alice,
        "rules_set",
        json!({"in": ["acct:otherco"], "out": ["ep:carol"]}),
    )
    .await
    .expect("rules");
    let send = |to: &str, reply_to: Option<&str>| {
        let mut params = json!({"to": to, "body": "hi there"});
        if let Some(id) = reply_to {
            params["reply_to"] = json!(id);
        }
        params
    };

    let refused = call(&mut core, alice, "send", send("otherco/mac/bob", None))
        .await
        .expect_err("refused");
    assert_eq!(code(&refused), "not_found");
    assert_eq!(refused.message, "no endpoint otherco/mac/bob");
    assert_eq!(scope_refusals(&core, "out").await, 1);

    assert_eq!(
        inject(
            &mut core,
            envelope("msg_question1", "otherco/mac/bob", "message", None)
        )
        .await,
        "admitted"
    );
    let answered = call(
        &mut core,
        alice,
        "send",
        send("otherco/mac/bob", Some("msg_question1")),
    )
    .await
    .expect_err("hub is down");
    assert_eq!(code(&answered), "unavailable");
    let elsewhere = call(
        &mut core,
        alice,
        "send",
        send("otherco/mac/eve", Some("msg_question1")),
    )
    .await
    .expect_err("refused");
    assert_eq!(code(&elsewhere), "not_found");

    call(
        &mut core,
        alice,
        "rules_set",
        json!({"out": ["acct:otherco"]}),
    )
    .await
    .expect("rules");
    let admitted = call(&mut core, alice, "send", send("otherco/mac/bob", None))
        .await
        .expect_err("hub is down");
    assert_eq!(code(&admitted), "unavailable");
    drop(core);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn a_send_to_another_account_is_checked_against_the_relay_policy() {
    let policy = json!({"rules": [{"match": "*", "send_to": ["acct:partner"]}]});
    let (mut core, dir) = fixture(Some(policy)).await;
    let alice = claim(&mut core, "alice").await;
    let refused = call(
        &mut core,
        alice,
        "send",
        json!({"to": "otherco/mac/bob", "body": "hi there"}),
    )
    .await
    .expect_err("refused");
    assert_eq!(code(&refused), "policy_refused");
    assert_eq!(
        refused.message,
        "the relay policy (*, send_to) does not let this endpoint message that one (otherco/mac/bob)"
    );
    let allowed = call(
        &mut core,
        alice,
        "send",
        json!({"to": "partner/mac/bob", "body": "hi there"}),
    )
    .await
    .expect_err("hub is down");
    assert_eq!(code(&allowed), "unavailable");
    drop(core);
    let _ = tokio::fs::remove_dir_all(dir).await;
}
