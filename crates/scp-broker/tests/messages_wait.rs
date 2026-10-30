mod messages_support;

use std::sync::Arc;
use std::time::Duration;

use messages_support::{TestCore, params};
use scp_broker::core::Core;
use scp_broker::state::Mode;
use serde_json::json;
use tokio::sync::Mutex;

#[tokio::test]
async fn inbox_wait_releases_core_and_wakes_on_send() {
    let test = TestCore::new().await;
    let shared = Arc::new(Mutex::new(test.core));
    let mut guard = shared.clone().lock_owned().await;
    let conn = guard.state.connect();
    guard
        .state
        .bind(conn, Some("recipient".into()), Mode::Agent);
    let receiver = shared.clone();
    let waiting = tokio::spawn(Core::execute(
        receiver,
        guard,
        conn,
        "inbox".into(),
        params(json!({"wait_s":5})),
    ));
    let mut sender = tokio::time::timeout(Duration::from_secs(1), shared.clone().lock_owned())
        .await
        .expect("mutex released");
    sender
        .send_message(
            "sender",
            &params(json!({"to":"recipient","body":"ping"})),
            scp_broker::messages::Origin::default(),
        )
        .await
        .expect("send");
    drop(sender);
    let result = tokio::time::timeout(Duration::from_secs(1), waiting)
        .await
        .expect("wakes promptly")
        .expect("task")
        .expect("inbox");
    assert_eq!(result["messages"][0]["body"]["text"], "ping");
    let core = Arc::try_unwrap(shared)
        .ok()
        .expect("sole core")
        .into_inner();
    TestCore {
        core,
        store: test.store,
        dir: test.dir,
    }
    .close()
    .await;
}

#[tokio::test]
async fn inbox_wait_honors_configured_cap_and_disconnect() {
    let mut test = TestCore::new().await;
    test.core.limits.0.insert("waitMaxS".into(), Some(0));
    let shared = Arc::new(Mutex::new(test.core));
    let mut guard = shared.clone().lock_owned().await;
    let conn = guard.state.connect();
    guard
        .state
        .bind(conn, Some("recipient".into()), Mode::Agent);
    tokio::time::timeout(
        Duration::from_millis(300),
        Core::execute(
            shared.clone(),
            guard,
            conn,
            "inbox".into(),
            params(json!({"wait_s":5})),
        ),
    )
    .await
    .expect("cap")
    .expect("inbox");
    let mut guard = shared.clone().lock_owned().await;
    guard.limits.0.insert("waitMaxS".into(), Some(50));
    let waiting = tokio::spawn(Core::execute(
        shared.clone(),
        guard,
        conn,
        "inbox".into(),
        params(json!({"wait_s":5})),
    ));
    let mut guard = shared.clone().lock_owned().await;
    guard.disconnect(conn).await;
    drop(guard);
    tokio::time::timeout(Duration::from_secs(1), waiting)
        .await
        .expect("disconnect wakes")
        .expect("task")
        .expect("inbox");
    let core = Arc::try_unwrap(shared)
        .ok()
        .expect("sole core")
        .into_inner();
    TestCore {
        core,
        store: test.store,
        dir: test.dir,
    }
    .close()
    .await;
}
