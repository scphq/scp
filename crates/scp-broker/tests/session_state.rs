#[path = "messages_support.rs"]
mod support;

use scp_broker::core::{integer, text};
use scp_broker::proto::ErrorCode;
use scp_broker::session::{hook_title, one_line};
use scp_broker::state::Mode;
use scp_broker::store::{SqlValue, Storage};
use serde_json::json;
use support::{TestCore, params};

#[tokio::test]
async fn status_preserves_unspecified_fields_and_notes_reset_reminders() {
    let mut test = TestCore::new().await;
    assert_eq!(
        test.core
            .status("sender", &params(json!({"note":" first\n  task "})))
            .await
            .expect("status")["status"],
        json!({"state":"working","note":"first task"})
    );
    assert_eq!(
        test.core
            .status("sender", &params(json!({"state":"blocked"})))
            .await
            .expect("state")["status"],
        json!({"state":"blocked","note":"first task"})
    );
    assert_eq!(
        test.core
            .status("sender", &params(json!({"note":""})))
            .await
            .expect("empty")["status"],
        json!({"state":"blocked","note":""})
    );
    test.core.limits.0.insert("noteChars".into(), Some(3));
    assert_eq!(
        test.core
            .status("sender", &params(json!({"note":"four"})))
            .await
            .expect_err("too long")
            .data
            .expect("data")
            .code,
        ErrorCode::TooLarge
    );
    assert_eq!(
        test.core
            .status("sender", &params(json!({"state":null})))
            .await
            .expect_err("state null")
            .data
            .expect("data")
            .code,
        ErrorCode::InvalidParams
    );
    test.core.limits.0.insert("noteChars".into(), Some(280));
    assert_eq!(
        test.core
            .status("sender", &params(json!({"note":"scp_abcdefghijklmnop"})))
            .await
            .expect_err("secret")
            .data
            .expect("data")
            .code,
        ErrorCode::SecretRefused
    );
    test.close().await;
}

#[tokio::test]
async fn explicit_titles_collapse_clear_refuse_secrets_and_override_inference() {
    let mut test = TestCore::new().await;
    assert_eq!(
        test.core
            .title("sender", Some(&json!("  current\n  task ")), &Mode::Agent)
            .await
            .expect("title")["title"],
        "current task"
    );
    assert_eq!(
        test.core
            .title_infer(
                "sender",
                &params(json!({"from":"summary","text":"inferred"}))
            )
            .await
            .expect("explicit wins"),
        json!({"changed":false})
    );
    assert_eq!(
        test.core
            .title("sender", Some(&json!("")), &Mode::Agent)
            .await
            .expect("clear")["title"],
        json!(null)
    );
    assert_eq!(
        test.core
            .title("sender", Some(&json!("scp_abcdefghijklmnop")), &Mode::Agent)
            .await
            .expect_err("secret")
            .data
            .expect("data")
            .code,
        ErrorCode::SecretRefused
    );
    assert_eq!(
        test.core
            .title("sender", Some(&json!("hook")), &Mode::Transient)
            .await
            .expect_err("hook")
            .data
            .expect("data")
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        test.core
            .title("sender", Some(&json!("x".repeat(65))), &Mode::Agent)
            .await
            .expect_err("too long")
            .data
            .expect("data")
            .code,
        ErrorCode::TooLarge
    );
    test.close().await;
}

#[tokio::test]
async fn inferred_titles_refresh_after_configured_prompts_and_strip_credentials() {
    let mut test = TestCore::new().await;
    assert_eq!(
        test.core
            .title_infer(
                "sender",
                &params(json!({"from":"prompt","text":"first prompt"}))
            )
            .await
            .expect("prompt")["changed"],
        true
    );
    assert_eq!(
        test.core
            .title_infer(
                "sender",
                &params(json!({"from":"prompt","text":"later prompt"}))
            )
            .await
            .expect("later prompt")["changed"],
        false
    );
    assert_eq!(
        test.core
            .title_infer(
                "sender",
                &params(json!({"from":"summary","text":"summary"}))
            )
            .await
            .expect("first summary")["changed"],
        true
    );
    assert_eq!(
        test.core
            .title_infer(
                "sender",
                &params(json!({"from":"summary","text":"too soon"}))
            )
            .await
            .expect("rate")["changed"],
        false
    );
    test.core
        .limits
        .0
        .insert("titleRefreshTurns".into(), Some(2));
    for _ in 0..2 {
        test.core
            .prompted("sender", &params(json!({})))
            .await
            .expect("prompt");
    }
    assert_eq!(
        test.core
            .title_infer(
                "sender",
                &params(json!({"from":"summary","text":"new scp_abcdefghijklmnop title"}))
            )
            .await
            .expect("refresh")["changed"],
        true
    );
    let row = test
        .core
        .by_id("sender")
        .await
        .expect("lookup")
        .expect("row");
    assert_eq!(
        text(&row, "title"),
        Some("new [redacted implementation token] title")
    );
    assert_eq!(integer(&row, "title_turn"), Some(2));
    assert_eq!(hook_title(&"x".repeat(100)).expect("title").len(), 64);
    assert!(
        test.core
            .title_infer("sender", &params(json!({"from":"other","text":"value"})))
            .await
            .is_err()
    );
    test.close().await;
}

#[tokio::test]
async fn prompt_reminders_count_since_note_or_last_reminder() {
    let mut test = TestCore::new().await;
    let config = params(json!({"tldr_every":2}));
    assert_eq!(
        test.core.prompted("sender", &config).await.expect("first"),
        json!({"prompted":true})
    );
    assert_eq!(
        test.core.prompted("sender", &config).await.expect("second"),
        json!({"prompted":true,"tldr":true})
    );
    assert_eq!(
        test.core.prompted("sender", &config).await.expect("third"),
        json!({"prompted":true})
    );
    test.core
        .status("sender", &params(json!({"note":"updated"})))
        .await
        .expect("note");
    assert_eq!(
        test.core
            .prompted("sender", &config)
            .await
            .expect("after note"),
        json!({"prompted":true})
    );
    assert_eq!(
        test.core
            .prompted("sender", &config)
            .await
            .expect("due again"),
        json!({"prompted":true,"tldr":true})
    );
    test.store
        .all(
            "UPDATE endpoints SET pushes = 7, wake = 'codex-queue' WHERE id = 'sender'",
            &[],
        )
        .await
        .expect("wake");
    test.core
        .prompted("sender", &params(json!({"tldr_every":1.5})))
        .await
        .expect("noninteger");
    let row = test
        .core
        .by_id("sender")
        .await
        .expect("lookup")
        .expect("row");
    assert_eq!(integer(&row, "pushes"), Some(0));
    assert_eq!(row["wake"], SqlValue::Null);
    test.close().await;
}

#[test]
fn text_lengths_count_utf16_units_and_strip_controls_after_whitespace() {
    assert!(one_line(Some(&json!("😀😀")), "title", 3).is_err());
    assert_eq!(
        one_line(Some(&json!("a\u{202e}b\n\t c")), "title", 8).expect("text"),
        Some("ab c".into())
    );
}
