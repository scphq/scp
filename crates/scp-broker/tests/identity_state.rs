use scp_broker::{
    core::Core,
    paths::Paths,
    proto::Limits,
    store::{SqlValue, sqlite::SqliteStore},
};
use serde_json::{Value, json};
use std::sync::Arc;

async fn fixture() -> (Core, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("scp-identity-{:032x}", rand::random::<u128>()));
    tokio::fs::create_dir(&dir)
        .await
        .expect("temporary directory");
    let paths = Paths::new(dir.clone());
    let core = Core::new(
        Arc::new(SqliteStore::open(&paths.database).expect("store")),
        Limits::default(),
        paths,
        dir.join("policy.json"),
    )
    .await
    .expect("core");
    (core, dir)
}
async fn hello(core: &mut Core, params: Value) -> (u64, Value) {
    let conn = core.state.connect();
    let mut params = params.as_object().expect("params").clone();
    params.insert("protocol".into(), json!("scp/1"));
    let result = core.dispatch(conn, "hello", &params).await.expect("hello");
    (conn, result)
}
#[tokio::test]
async fn refused_join_rolls_back_claim_and_mail_survives_resume() {
    let (mut core, dir) = fixture().await;
    let (_, peer) = hello(&mut core, json!({"claim":{"handle":"peer"}})).await;
    let conn = core.state.connect();
    let params = json!({"protocol":"scp/1","transient":true,"claim":{"handle":"app"},"join":{"handle":"peer"}});
    let error = core
        .dispatch(conn, "hello", params.as_object().expect("params"))
        .await
        .expect_err("occupied join");
    assert_eq!(
        error.data.expect("error code").code,
        scp_broker::proto::ErrorCode::InvalidParams
    );
    assert!(core.by_handle("app").await.expect("lookup").is_none());
    let (_, resumed) = hello(&mut core, json!({"resume":peer["token"]})).await;
    assert_eq!(resumed["endpoint"]["id"], peer["endpoint"]["id"]);
    drop(core);
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}
#[tokio::test]
async fn disconnect_retains_recent_hooks_and_restart_grace() {
    let (mut core, dir) = fixture().await;
    let (conn, hello) = hello(&mut core, json!({"claim":{"handle":"app"}})).await;
    let id = hello["endpoint"]["id"].as_str().expect("id");
    core.store
        .all(
            "UPDATE endpoints SET hook_seen = ?,session = 'session' WHERE id = ?",
            &[
                SqlValue::Int(scp_broker::core::now_ms()),
                SqlValue::Text(id.into()),
            ],
        )
        .await
        .expect("hook");
    core.disconnect(conn).await;
    let row = core.must_endpoint(id).await.expect("endpoint");
    assert_eq!(scp_broker::core::text(&row, "session"), Some("session"));
    assert_eq!(core.view(&row).await.expect("view")["presence"], "online");
    drop(core);
    let paths = Paths::new(dir.clone());
    let core = Core::new(
        Arc::new(SqliteStore::open(&paths.database).expect("store")),
        Limits::default(),
        paths,
        dir.join("policy.json"),
    )
    .await
    .expect("restart");
    assert_eq!(
        core.view(&core.must_endpoint(id).await.expect("endpoint"))
            .await
            .expect("view")["presence"],
        "online"
    );
    drop(core);
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

#[tokio::test]
async fn hook_exit_checks_pid_existence_without_comparing_start_keys() {
    let (mut core, dir) = fixture().await;
    let process = format!("pid:{}:Mon-Jan-1-00:00:00-1900", std::process::id());
    let (_, hello) = hello(
        &mut core,
        json!({"transient":true,"claim":{"handle":"app","process":process,"session":"active"}}),
    )
    .await;
    let id = hello["endpoint"]["id"].as_str().expect("id");
    core.end_exited().await.expect("refresh presence");
    let row = core.must_endpoint(id).await.expect("endpoint");
    assert_eq!(scp_broker::core::text(&row, "session"), Some("active"));
    assert!(scp_broker::core::integer(&row, "hook_seen").is_some());
    assert!(scp_broker::core::integer(&row, "hook_ended").is_none());
    drop(core);
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}
