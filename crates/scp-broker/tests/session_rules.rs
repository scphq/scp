#[path = "messages_support.rs"]
mod support;

use scp_broker::state::Mode;
use scp_broker::store::{SqlValue, Storage};
use serde_json::json;
use support::{TestCore, params};

#[tokio::test]
async fn rule_storage_preserves_directions_and_expands_presets() {
    let mut test = TestCore::new().await;
    let sender = test.core.state.connect();
    test.core
        .state
        .bind(sender, Some("sender".into()), Mode::Agent);
    let view = test
        .core
        .rules_set(
            sender,
            &params(json!({"in":["ep:recipient","ep:recipient"]})),
        )
        .await
        .expect("set");
    assert_eq!(view["rules"], json!({"in":["ep:recipient"]}));
    assert_eq!(
        test.core
            .rules_set(sender, &params(json!({"out":["outsider"]})))
            .await
            .expect("out")["rules"],
        json!({"in":["ep:recipient"],"out":["ep:outsider"]})
    );
    assert_eq!(
        test.core
            .rules_set(sender, &params(json!({"scope":"parent"})))
            .await
            .expect("preset")["preset"],
        "parent"
    );
    assert_eq!(
        test.core
            .rules_set(sender, &params(json!({"scope":"open"})))
            .await
            .expect("open")["rules"],
        json!({})
    );
    assert!(
        test.core
            .rules_set(sender, &params(json!({})))
            .await
            .is_err()
    );
    assert!(
        test.core
            .rules_set(sender, &params(json!({"in":["tree"]})))
            .await
            .is_err()
    );
    assert!(
        test.core
            .rules_set(sender, &params(json!({"in":["tree:ancestors:17"]})))
            .await
            .is_err()
    );
    assert!(
        test.core
            .rules_set(
                sender,
                &params(json!({"scope":"open","allow":["ep:recipient"]}))
            )
            .await
            .is_err()
    );
    test.close().await;
}

#[tokio::test]
async fn rename_rewrites_only_exact_selectors_in_every_stored_location() {
    let test = TestCore::new().await;
    let stored = json!({"in":["ep:sender","ep:sender-extra","fleet:sender"]}).to_string();
    test.store
        .all(
            "UPDATE endpoints SET rules = ?, caps = ? WHERE id = 'recipient'",
            &[
                SqlValue::Text(stored.clone()),
                SqlValue::Text(stored.clone()),
            ],
        )
        .await
        .expect("endpoint");
    test.store
        .all(
            "INSERT INTO groups (name,owner,rules,created_at) VALUES ('build','recipient',?,0)",
            &[SqlValue::Text(stored.clone())],
        )
        .await
        .expect("group");
    test.store.all("INSERT INTO grants (token_hash,issuer,under,caps,created_at,expires_at) VALUES ('token','recipient','recipient',?,0,1)",&[SqlValue::Text(stored)]).await.expect("grant");
    test.core
        .rewrite_selectors("sender", "lead")
        .await
        .expect("rewrite");
    let expected = json!({"in":["ep:lead","ep:sender-extra","fleet:lead"]});
    for (table, column) in [
        ("endpoints", "rules"),
        ("endpoints", "caps"),
        ("groups", "rules"),
        ("grants", "caps"),
    ] {
        let rows = test
            .store
            .all(
                &format!("SELECT {column} AS value FROM {table} WHERE {column} IS NOT NULL"),
                &[],
            )
            .await
            .expect("rows");
        assert!(rows.iter().any(|row| match &row["value"] {
            SqlValue::Text(value) =>
                serde_json::from_str::<serde_json::Value>(value).expect("json") == expected,
            _ => false,
        }));
    }
    test.store
        .all(
            "UPDATE endpoints SET parent_ep = 'recipient' WHERE id = 'sender'",
            &[],
        )
        .await
        .expect("child");
    test.core
        .rewrite_selectors("sender", "worker")
        .await
        .expect("child rewrite");
    test.close().await;
}
