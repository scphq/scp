use scp_broker::{
    claims::retry_link_under,
    core::Core,
    paths::Paths,
    proto::{Limits, RpcError},
    store::{SqlValue, sqlite::SqliteStore},
};
use serde_json::{Value, json};
use std::sync::Arc;

async fn fixture() -> (Core, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("scp-links-{:032x}", rand::random::<u128>()));
    tokio::fs::create_dir(&dir)
        .await
        .expect("temporary directory");
    let paths = Paths::new(dir.clone());
    let mut core = Core::new(
        Arc::new(SqliteStore::open(&paths.database).expect("store")),
        Limits::default(),
        paths,
        dir.join("policy.json"),
    )
    .await
    .expect("core");
    core.federation.machine = Some("laptop".into());
    (core, dir)
}

async fn hello(core: &mut Core, params: Value) -> (u64, Value) {
    let conn = core.state.connect();
    let mut params = params.as_object().expect("params").clone();
    params.insert("protocol".into(), json!("scp/1"));
    let result = core.dispatch(conn, "hello", &params).await.expect("hello");
    (conn, result)
}

async fn call(core: &mut Core, conn: u64, method: &str, params: Value) -> Result<Value, RpcError> {
    core.dispatch(conn, method, params.as_object().expect("params"))
        .await
}

fn agent(handle: &str, parent: Option<&str>, depth: i64, parent_addr: Option<&str>) -> Value {
    json!({
        "address": format!("me/{handle}"), "kind": "agent", "harness": "cli", "presence": "online",
        "tree": parent.map_or(handle, |_| "boss"), "parent_ep": parent, "depth": depth, "parent_addr": parent_addr,
    })
}

async fn desk(core: &mut Core, extra: Vec<Value>) {
    let mut views = vec![
        json!({"address": "me/", "kind": "human", "presence": "online"}),
        agent("boss", None, 0, None),
        agent("lead", Some("boss"), 1, None),
    ];
    views.extend(extra);
    core.mirror("desk", &Value::Array(views), true)
        .await
        .expect("mirror");
}

async fn column(core: &Core, handle: &str, name: &str) -> Option<String> {
    let rows = core
        .store
        .all(
            &format!("SELECT {name} FROM endpoints WHERE handle = ?"),
            &[SqlValue::Text(handle.into())],
        )
        .await
        .expect("row");
    match rows.first().and_then(|r| r.get(name)) {
        Some(SqlValue::Text(v)) => Some(v.clone()),
        _ => None,
    }
}

async fn refusals(core: &Core) -> usize {
    core.store
        .all(
            "SELECT id FROM audit WHERE event = 'claim_under_refused'",
            &[],
        )
        .await
        .expect("audit")
        .len()
}

fn code(error: &RpcError) -> String {
    serde_json::to_value(error.data.as_ref().expect("data").code)
        .expect("code")
        .as_str()
        .expect("code text")
        .to_owned()
}

#[tokio::test]
async fn a_claim_under_an_unknown_remote_parent_stays_pending_and_links_once_mirrored() {
    let (mut core, dir) = fixture().await;
    let (worker, _) = hello(
        &mut core,
        json!({"claim": {"handle": "worker", "under": "me/desk/lead"}}),
    )
    .await;
    let me = call(&mut core, worker, "whoami", json!({}))
        .await
        .expect("whoami");
    assert_eq!(me["parent"], Value::Null);
    assert_eq!(me["link_pending"]["under"], "me/desk/lead");
    assert_eq!(me["link_pending"]["code"], "not_found");
    let stored = column(&core, "worker", "link_under")
        .await
        .expect("pending");
    assert!(stored.starts_with(r#"{"under":"me/desk/lead","code":"not_found","message":"#));
    assert_eq!(refusals(&core).await, 1);
    let retried = retry_link_under(&mut core).await.expect("retry");
    assert!(retried.linked.is_empty() && retried.refused.is_empty());
    assert_eq!(refusals(&core).await, 1);

    desk(&mut core, vec![]).await;
    let world = core.world().await.expect("world");
    let id = |remote: &str| {
        world
            .listed()
            .find(|r| r.get("remote") == Some(&SqlValue::Text(remote.into())))
            .and_then(|r| match r.get("id") {
                Some(SqlValue::Text(v)) => Some(v.clone()),
                _ => None,
            })
            .expect("mirrored")
    };
    let me = me["id"].as_str().expect("id");
    assert!(!world.may_message(me, &id("desk/lead"), false, false));
    assert!(world.may_message(me, &id("desk/boss"), false, false));
    let retried = retry_link_under(&mut core).await.expect("retry");
    assert_eq!(
        retried.linked,
        vec![("me/worker".to_owned(), "me/desk/lead".to_owned())]
    );
    assert_eq!(
        column(&core, "worker", "parent_addr").await.as_deref(),
        Some("desk/lead")
    );
    assert_eq!(column(&core, "worker", "link_under").await, None);
    let me = call(&mut core, worker, "whoami", json!({}))
        .await
        .expect("whoami");
    assert_eq!(me["parent"], "me/desk/lead");
    assert_eq!(me["depth"], 0);
    assert!(me.get("link_pending").is_none());
    assert!(
        retry_link_under(&mut core)
            .await
            .expect("retry")
            .linked
            .is_empty()
    );
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn a_scoped_claim_may_not_link_under_a_non_root_it_cannot_message() {
    let (mut core, dir) = fixture().await;
    desk(&mut core, vec![]).await;
    let (worker, _) = hello(
        &mut core,
        json!({"claim": {"handle": "worker", "under": "me/desk/lead", "out": ["other"]}}),
    )
    .await;
    let me = call(&mut core, worker, "whoami", json!({}))
        .await
        .expect("whoami");
    assert_eq!(me["parent"], Value::Null);
    assert_eq!(me["link_pending"]["code"], "not_found");
    assert_eq!(column(&core, "worker", "parent_addr").await, None);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn a_remote_human_or_another_accounts_row_is_no_parent() {
    let (mut core, dir) = fixture().await;
    desk(&mut core, vec![]).await;
    let (_, _) = hello(&mut core, json!({"claim": {"handle": "worker"}})).await;
    let (human, _) = hello(&mut core, json!({"human": true, "tty": true})).await;
    let error = call(
        &mut core,
        human,
        "adopt",
        json!({"endpoint": "worker", "parent": "me/desk/me"}),
    )
    .await
    .expect_err("a remote human");
    assert_eq!(code(&error), "invalid_params");
    assert_eq!(column(&core, "worker", "parent_addr").await, None);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn a_mirrored_row_is_never_adopted_or_unlinked_here() {
    let (mut core, dir) = fixture().await;
    desk(&mut core, vec![]).await;
    let (_, _) = hello(&mut core, json!({"claim": {"handle": "worker"}})).await;
    let (human, _) = hello(&mut core, json!({"human": true, "tty": true})).await;
    let error = call(
        &mut core,
        human,
        "adopt",
        json!({"endpoint": "me/desk/boss", "parent": "worker"}),
    )
    .await
    .expect_err("a mirrored target");
    assert_eq!(error.message, "only a local agent endpoint can be linked");
    let error = call(
        &mut core,
        human,
        "unlink",
        json!({"endpoint": "me/desk/lead"}),
    )
    .await
    .expect_err("a mirrored target");
    assert_eq!(error.message, "only a local agent endpoint can be unlinked");
    let parent = core
        .store
        .all(
            "SELECT parent_ep FROM endpoints WHERE remote = 'desk/boss'",
            &[],
        )
        .await
        .expect("row");
    assert_eq!(parent[0].get("parent_ep"), Some(&SqlValue::Null));
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn a_link_across_refuses_a_cycle_and_a_second_parent_and_unlinks() {
    let (mut core, dir) = fixture().await;
    desk(
        &mut core,
        vec![agent("below", None, 0, Some("laptop/worker"))],
    )
    .await;
    let (worker, _) = hello(&mut core, json!({"claim": {"handle": "worker"}})).await;
    let (human, _) = hello(&mut core, json!({"human": true, "tty": true})).await;
    let error = call(
        &mut core,
        human,
        "adopt",
        json!({"endpoint": "worker", "parent": "me/desk/below"}),
    )
    .await
    .expect_err("a cycle");
    assert_eq!(code(&error), "scope_refused");
    assert_eq!(
        error.message,
        "me/desk/below sits under me/worker: a session cannot go under its own descendant"
    );
    let linked = call(
        &mut core,
        human,
        "adopt",
        json!({"endpoint": "worker", "parent": "me/desk/lead"}),
    )
    .await
    .expect("adopt");
    assert_eq!(linked["endpoint"]["parent"], "me/desk/lead");
    let error = call(
        &mut core,
        human,
        "adopt",
        json!({"endpoint": "worker", "parent": "me/desk/boss"}),
    )
    .await
    .expect_err("a second parent");
    assert_eq!(
        error.message,
        "me/worker already sits under me/desk/lead; unlink it first"
    );
    let me = call(&mut core, worker, "whoami", json!({}))
        .await
        .expect("whoami");
    assert_eq!(me["parent"], "me/desk/lead");
    let unlinked = call(&mut core, human, "unlink", json!({"endpoint": "worker"}))
        .await
        .expect("unlink");
    assert_eq!(unlinked["parent"], "me/desk/lead");
    assert_eq!(unlinked["endpoint"]["parent"], Value::Null);
    assert_eq!(column(&core, "worker", "parent_addr").await, None);
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn a_mirrored_link_that_closes_a_cycle_is_dropped() {
    let (mut core, dir) = fixture().await;
    desk(&mut core, vec![agent("solo", None, 0, None)]).await;
    let (_, _) = hello(
        &mut core,
        json!({"claim": {"handle": "worker", "under": "me/desk/solo"}}),
    )
    .await;
    assert_eq!(
        column(&core, "worker", "parent_addr").await.as_deref(),
        Some("desk/solo")
    );
    desk(
        &mut core,
        vec![agent("solo", None, 0, Some("laptop/worker"))],
    )
    .await;
    let solo = core
        .store
        .all(
            "SELECT parent_addr FROM endpoints WHERE remote = 'desk/solo'",
            &[],
        )
        .await
        .expect("row");
    assert_eq!(solo[0].get("parent_addr"), Some(&SqlValue::Null));
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn an_own_machine_key_names_only_the_local_row() {
    let (mut core, dir) = fixture().await;
    let (_, _) = hello(&mut core, json!({"claim": {"handle": "lead"}})).await;
    desk(
        &mut core,
        vec![agent("child", None, 0, Some("laptop/lead"))],
    )
    .await;
    let local = core.by_key("laptop/lead").await.expect("key").expect("row");
    assert!(Core::is_local_row(&local));
    assert!(core.by_key("laptop/_r_x").await.expect("key").is_none());
    let child = core
        .by_remote("desk/child")
        .await
        .expect("row")
        .expect("child");
    let view = core.view(&child).await.expect("view");
    assert_eq!(view["parent"], "me/lead");
    let local = core.lookup("me/laptop/lead").await.expect("lookup");
    assert!(Core::is_local_row(&local));
    let _ = tokio::fs::remove_dir_all(dir).await;
}

#[tokio::test]
async fn a_renamed_parent_keeps_its_remote_children() {
    let (mut core, dir) = fixture().await;
    let (lead, _) = hello(&mut core, json!({"claim": {"handle": "lead"}})).await;
    desk(
        &mut core,
        vec![agent("child", None, 0, Some("laptop/lead"))],
    )
    .await;
    call(&mut core, lead, "rename", json!({"handle": "chief"}))
        .await
        .expect("rename");
    let child = core
        .by_remote("desk/child")
        .await
        .expect("row")
        .expect("child");
    assert_eq!(
        child.get("parent_addr"),
        Some(&SqlValue::Text("laptop/chief".into()))
    );
    let _ = tokio::fs::remove_dir_all(dir).await;
}
