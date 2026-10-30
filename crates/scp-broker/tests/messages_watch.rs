mod messages_support;

use messages_support::{TestCore, params};
use scp_broker::core::{Core, now_ms};
use scp_broker::messages::Origin;
use scp_broker::state::{ConnectionId, Mode};
use scp_broker::store::{SqlValue, Storage};
use serde_json::{Value, json};
use tokio::sync::mpsc;

fn watcher(
    core: &mut Core,
    endpoint: Option<&str>,
    mode: Mode,
) -> (ConnectionId, mpsc::UnboundedReceiver<Value>) {
    let conn = core.state.connect();
    core.state.bind(conn, endpoint.map(str::to_owned), mode);
    let (events, receiver) = mpsc::unbounded_channel();
    core.state
        .connections
        .get_mut(&conn)
        .expect("connection")
        .events = Some(events);
    (conn, receiver)
}

async fn isolate(core: &mut Core, endpoint: &str) {
    let conn = core.state.connect();
    core.state.bind(conn, Some(endpoint.into()), Mode::Agent);
    core.rules_set(conn, &params(json!({"scope":"none"})))
        .await
        .expect("isolate");
}

#[tokio::test]
async fn agent_watcher_hides_other_endpoints_messages_while_observer_sees_them() {
    let mut test = TestCore::new().await;
    isolate(&mut test.core, "outsider").await;
    let (agent, mut scoped) = watcher(&mut test.core, Some("outsider"), Mode::Agent);
    let (observer, mut all) = watcher(&mut test.core, None, Mode::Observer);
    test.core.watch(agent).await.expect("agent watch");
    test.core.watch(observer).await.expect("observer watch");

    let sent = test
        .core
        .send_message(
            "sender",
            &params(json!({"to":"recipient","body":"private"})),
            Origin::default(),
        )
        .await
        .expect("send");

    assert!(matches!(
        scoped.try_recv(),
        Err(mpsc::error::TryRecvError::Empty)
    ));
    let frame = all.try_recv().expect("observer message");
    assert_eq!(frame["method"], "fleet");
    assert_eq!(frame["params"]["type"], "message");
    assert_eq!(frame["params"]["id"], sent["id"]);
    assert_eq!(frame["params"]["from"], "me/sender");
    assert_eq!(frame["params"]["to"], json!(["me/recipient"]));
    assert!(frame["params"]["at"].is_string());
    test.close().await;
}

#[tokio::test]
async fn scoped_events_require_visible_sender_and_recipient_and_trim_recipients() {
    let mut test = TestCore::new().await;
    isolate(&mut test.core, "recipient").await;
    let (agent, mut scoped) = watcher(&mut test.core, Some("sender"), Mode::Agent);
    test.core.watch(agent).await.expect("watch");
    for event in [
        json!({"type":"message","from":"me/recipient","to":["me/sender"]}),
        json!({"type":"message","from":"me/sender","to":["me/recipient"]}),
        json!({"type":"presence","endpoint":"me/recipient","presence":"online"}),
    ] {
        test.core.notify_watchers(event).await;
        assert!(matches!(
            scoped.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }
    let mut shown = json!({"type":"message","id":"message-id","from":"me/sender","to":["me/sender","me/recipient"]});
    test.core.notify_watchers(shown.clone()).await;
    shown["to"] = json!(["me/sender"]);
    let mut frame = scoped.try_recv().expect("visible message");
    frame["params"]
        .as_object_mut()
        .expect("params")
        .remove("at");
    assert_eq!(frame["params"], shown);

    for event in [
        json!({"type":"presence","endpoint":"me/sender","presence":"online"}),
        json!({"type":"broker","state":"ready"}),
    ] {
        test.core.notify_watchers(event.clone()).await;
        let mut frame = scoped.try_recv().expect("visible event");
        frame["params"]
            .as_object_mut()
            .expect("params")
            .remove("at");
        assert_eq!(frame["params"], event);
    }
    test.close().await;
}

#[tokio::test]
async fn watch_snapshot_scopes_endpoints_activity_and_unread_before_limiting() {
    let mut test = TestCore::new().await;
    test.store
        .all(
            "UPDATE endpoints SET handle = 'renamed' WHERE id = 'sender'",
            &[],
        )
        .await
        .expect("rename");
    for endpoint in ["sender", "recipient"] {
        test.store
            .all(
                "INSERT INTO activity (at,endpoint,kind) VALUES (?,?,'tool')",
                &[SqlValue::Int(now_ms()), SqlValue::Text(endpoint.into())],
            )
            .await
            .expect("activity");
    }
    test.core
        .send_message(
            "outsider",
            &params(json!({"to":["renamed","recipient"],"body":"mail"})),
            Origin::default(),
        )
        .await
        .expect("send");
    isolate(&mut test.core, "sender").await;
    let (agent, _) = watcher(&mut test.core, Some("sender"), Mode::Agent);
    let (observer, _) = watcher(&mut test.core, None, Mode::Observer);
    let (terminal, _) = watcher(&mut test.core, None, Mode::Human { tty: true });
    assert_eq!(test.core.viewer_of(agent).as_deref(), Some("sender"));
    let human = test.core.human_id().await.expect("human");
    assert!(human.is_some());
    assert_eq!(test.core.viewer_of(observer), human);
    assert_eq!(test.core.viewer_of(terminal), None);
    let snapshot = test.core.watch(agent).await.expect("watch");
    let agents: Vec<&Value> = snapshot["endpoints"]
        .as_array()
        .expect("endpoints")
        .iter()
        .filter(|e| e["kind"] == "agent")
        .collect();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["address"], "me/renamed");
    assert_eq!(snapshot["unread"], json!({"me/renamed":1}));
    let snapshot = test
        .core
        .snapshot_for(agent, &params(json!({"activity": 1})))
        .await
        .expect("snapshot");
    assert_eq!(snapshot["activity"].as_array().expect("activity").len(), 1);
    assert_eq!(snapshot["activity"][0]["endpoint"], "me/renamed");

    let snapshot = test.core.watch(terminal).await.expect("terminal snapshot");
    assert!(snapshot["endpoints"].as_array().expect("endpoints").len() >= 3);
    assert_eq!(snapshot["activity"].as_array().expect("activity").len(), 2);
    assert_eq!(snapshot["unread"], json!({"me/renamed":1,"me/recipient":1}));
    test.close().await;
}
