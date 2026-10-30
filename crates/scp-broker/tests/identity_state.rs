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

async fn call(core: &mut Core, conn: u64, method: &str, params: Value) -> Value {
    core.dispatch(conn, method, params.as_object().expect("params"))
        .await
        .expect(method)
}

#[tokio::test]
async fn fresh_grants_do_not_resume_another_spawns_session_or_origin() {
    for (reported, spent) in [
        ("harness_session", false),
        ("harness_origin", false),
        ("harness_session", true),
        ("harness_origin", true),
    ] {
        let (mut core, dir) = fixture().await;
        let (parent, _) = hello(
            &mut core,
            json!({"claim":{"handle":"parent","process":"pid:999999:parent"}}),
        )
        .await;
        let grant = call(&mut core, parent, "grant", json!({})).await;
        let (old_conn, old) = hello(
            &mut core,
            json!({"claim":{"handle":"old","harness":"codex","harness_session":"session-a","grant":grant["token"]}}),
        )
        .await;
        call(
            &mut core,
            parent,
            "send",
            json!({"to":"old","body":"private mail"}),
        )
        .await;
        core.disconnect(old_conn).await;
        core.store
            .all(
                "UPDATE endpoints SET harness_session = 'session-a' WHERE id = ?",
                &[SqlValue::Text(
                    old["endpoint"]["id"].as_str().expect("id").into(),
                )],
            )
            .await
            .expect("harness session");
        let grant = call(&mut core, parent, "grant", json!({})).await;
        if spent {
            hello(
                &mut core,
                json!({"claim":{"handle":"other","harness":"codex","grant":grant["token"]}}),
            )
            .await;
        }
        let mut claim = json!({"handle":"fresh","harness":"codex","grant":grant["token"],"lineage":["pid:999999:parent"]});
        claim[reported] = json!("session-a");
        let (fresh_conn, fresh) = hello(&mut core, json!({"claim":claim})).await;
        assert_ne!(fresh["endpoint"]["id"], old["endpoint"]["id"]);
        assert_ne!(fresh["token"], old["token"]);
        assert_eq!(fresh["endpoint"]["parent"], "me/parent");
        assert_eq!(
            call(&mut core, fresh_conn, "inbox", json!({})).await["messages"],
            json!([])
        );
        let (resumed_conn, resumed) = hello(&mut core, json!({"resume":old["token"]})).await;
        assert_eq!(resumed["endpoint"]["id"], old["endpoint"]["id"]);
        assert_eq!(
            call(&mut core, resumed_conn, "inbox", json!({})).await["messages"][0]["body"]["text"],
            "private mail"
        );
        drop(core);
        tokio::fs::remove_dir_all(dir).await.expect("cleanup");
    }
}

#[tokio::test]
async fn adopt_requests_consent_and_direct_links_refuse_existing_parents() {
    let (mut core, dir) = fixture().await;
    let (first, _) = hello(&mut core, json!({"claim":{"handle":"first"}})).await;
    let (second, _) = hello(&mut core, json!({"claim":{"handle":"second"}})).await;
    let (child, _) = hello(&mut core, json!({"claim":{"handle":"child"}})).await;
    let (human, _) = hello(&mut core, json!({"human":true,"tty":true})).await;
    let adopted = call(
        &mut core,
        human,
        "adopt",
        json!({"endpoint":"child","parent":"first"}),
    )
    .await;
    assert_eq!(adopted["endpoint"]["parent"], "me/first");
    assert!(
        call(&mut core, first, "adopt", json!({"endpoint":"child"}))
            .await
            .get("requested")
            .is_none()
    );
    let requested = call(&mut core, second, "adopt", json!({"endpoint":"child"})).await;
    assert_eq!(requested["endpoint"]["parent"], "me/first");
    assert!(requested["requested"].is_string());
    let inbox = call(&mut core, child, "inbox", json!({})).await;
    assert_eq!(inbox["messages"][0]["id"], requested["requested"]);
    assert_eq!(inbox["messages"][0]["kind"], "request");
    assert_eq!(inbox["messages"][0]["link"]["parent"], "me/second");
    assert!(
        inbox["messages"][0]["body"]["text"]
            .as_str()
            .expect("body")
            .contains("only once you are a root again")
    );
    let error = core
        .dispatch(
            human,
            "adopt",
            json!({"endpoint":"child","parent":"second"})
                .as_object()
                .expect("params"),
        )
        .await
        .expect_err("already linked");
    assert_eq!(
        error.data.expect("code").code,
        scp_core::protocol::ErrorCode::ScopeRefused
    );
    assert!(error.message.contains("unlink it first"));
    let c = core.state.connections.get_mut(&second).expect("connection");
    c.lineage = c.endpoint.clone();
    let error = core
        .dispatch(
            second,
            "adopt",
            json!({"endpoint":"child"}).as_object().expect("params"),
        )
        .await
        .expect_err("lineage cannot ask");
    assert_eq!(
        error.data.expect("code").code,
        scp_core::protocol::ErrorCode::ScopeRefused
    );
    assert!(error.message.contains("only the session itself"));
    assert_eq!(
        call(&mut core, child, "whoami", json!({})).await["parent"],
        "me/first"
    );
    let error = core
        .dispatch(
            first,
            "adopt",
            json!({"endpoint":"first"}).as_object().expect("params"),
        )
        .await
        .expect_err("self adoption");
    assert_eq!(
        error.data.expect("code").code,
        scp_core::protocol::ErrorCode::ScopeRefused
    );
    let error = core
        .dispatch(
            child,
            "adopt",
            json!({"endpoint":"first"}).as_object().expect("params"),
        )
        .await
        .expect_err("ancestor adoption");
    assert_eq!(
        error.data.expect("code").code,
        scp_core::protocol::ErrorCode::ScopeRefused
    );
    drop(core);
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
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
        scp_core::protocol::ErrorCode::InvalidParams
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

async fn handoff_origin(core: &mut Core) -> (u64, Value) {
    let (conn, origin) = hello(
        core,
        json!({"claim":{"handle":"app","harness":"agent-test","harness_session":"origin"}}),
    )
    .await;
    call(
        core,
        conn,
        "event",
        json!({"kind":"tool","session_id":"origin"}),
    )
    .await;
    call(core, conn, "rename", json!({"handle":"lead"})).await;
    core.store
        .all(
            "UPDATE endpoints SET created_at = ?,hook_seen = NULL WHERE id = ?",
            &[
                SqlValue::Int(scp_broker::core::now_ms() - 120_000),
                SqlValue::Text(origin["endpoint"]["id"].as_str().unwrap().into()),
            ],
        )
        .await
        .expect("older origin");
    (conn, origin)
}

fn handoff_claim() -> Value {
    json!({"handle":"app","harness":"agent-test","session":"fork-process","harness_session":"fork","harness_origin":"origin","harness_handoff":true})
}

#[tokio::test]
async fn handoff_moves_children_and_mail_for_hooks_and_connecting_claims() {
    for transient in [true, false] {
        let (mut core, dir) = fixture().await;
        let (old, origin) = handoff_origin(&mut core).await;
        let (human, _) = hello(&mut core, json!({"human":true,"tty":true})).await;
        let (child, _) = hello(&mut core, json!({"claim":{"handle":"worker"}})).await;
        call(
            &mut core,
            human,
            "adopt",
            json!({"endpoint":"worker","parent":"lead"}),
        )
        .await;
        call(
            &mut core,
            human,
            "send",
            json!({"to":"lead","body":"waiting"}),
        )
        .await;
        let closed = core.state.connections[&old].closed.clone();
        let notified = closed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let (fork_conn, fork) = hello(
            &mut core,
            json!({"transient":transient,"claim":handoff_claim()}),
        )
        .await;
        assert_eq!(fork["endpoint"]["address"], "me/lead");
        assert_ne!(fork["endpoint"]["id"], origin["endpoint"]["id"]);
        tokio::time::timeout(std::time::Duration::from_secs(1), notified)
            .await
            .expect("origin closed");
        assert_eq!(
            call(&mut core, child, "whoami", json!({})).await["parent"],
            "me/lead"
        );
        if !transient {
            assert_eq!(
                call(&mut core, fork_conn, "inbox", json!({})).await["messages"][0]["body"]["text"],
                "waiting"
            );
        }
        let row = core
            .must_endpoint(fork["endpoint"]["id"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(
            scp_broker::core::text(&row, "harness_session"),
            Some("fork")
        );
        drop(core);
        tokio::fs::remove_dir_all(dir).await.expect("cleanup");
    }
}

#[tokio::test]
async fn handoff_waits_for_recent_hooks_and_skips_origins_busy_since_creation() {
    for busy in [false, true] {
        let (mut core, dir) = fixture().await;
        let (_, origin) = handoff_origin(&mut core).await;
        let origin_id = origin["endpoint"]["id"].as_str().unwrap();
        core.store
            .all(
                "UPDATE endpoints SET hook_seen = ? WHERE id = ?",
                &[
                    SqlValue::Int(scp_broker::core::now_ms() - 1000),
                    SqlValue::Text(origin_id.into()),
                ],
            )
            .await
            .unwrap();
        let (_, fork) = hello(&mut core, json!({"transient":true,"claim":handoff_claim()})).await;
        assert_eq!(fork["endpoint"]["address"], "me/app");
        if busy {
            core.store
                .all(
                    "UPDATE endpoints SET hook_seen = ? WHERE id = ?",
                    &[
                        SqlValue::Int(scp_broker::core::now_ms() + 1000),
                        SqlValue::Text(origin_id.into()),
                    ],
                )
                .await
                .unwrap();
        }
        let (_, retry) = hello(&mut core, json!({"transient":true,"claim":handoff_claim()})).await;
        assert_eq!(retry["endpoint"]["id"], fork["endpoint"]["id"]);
        assert_eq!(
            retry["endpoint"]["address"],
            if busy { "me/app" } else { "me/lead" }
        );
        drop(core);
        tokio::fs::remove_dir_all(dir).await.expect("cleanup");
    }
}

#[tokio::test]
async fn relink_lists_live_origins_and_requires_live_to_apply() {
    let (mut core, dir) = fixture().await;
    let (old, origin) = handoff_origin(&mut core).await;
    let (human, _) = hello(&mut core, json!({"human":true,"tty":true})).await;
    let mut claim = handoff_claim();
    claim["harness_handoff"] = json!(false);
    let (_, fork) = hello(&mut core, json!({"transient":true,"claim":claim})).await;
    let pair = json!({"endpoint":fork["endpoint"]["id"],"from":"app","to":"lead","by":"origin","live":true});
    for params in [
        json!({"dry_run":true}),
        json!({}),
        json!({"dry_run":true,"live":true}),
    ] {
        assert_eq!(
            call(&mut core, human, "relink", params).await,
            json!({"relinked":[pair]})
        );
    }
    let closed = core.state.connections[&old].closed.clone();
    let notified = closed.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    let applied = call(&mut core, human, "relink", json!({"live":true})).await;
    assert_eq!(applied["relinked"][0]["retired"], origin["endpoint"]["id"]);
    assert_eq!(applied["relinked"][0]["live"], true);
    tokio::time::timeout(std::time::Duration::from_secs(1), notified)
        .await
        .expect("origin closed");
    drop(core);
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

#[tokio::test]
async fn handoff_and_relink_flags_require_booleans() {
    let (mut core, dir) = fixture().await;
    let (human, _) = hello(&mut core, json!({"human":true,"tty":true})).await;
    for value in [Value::Null, json!("yes"), json!(1), json!({})] {
        for (method, params, message) in [
            (
                "hello",
                json!({"protocol":"scp/1","claim":{"harness_handoff":value}}),
                "harness_handoff is true or false",
            ),
            ("relink", json!({"live":value}), "live is true or false"),
        ] {
            let conn = if method == "hello" {
                core.state.connect()
            } else {
                human
            };
            let error = core
                .dispatch(conn, method, params.as_object().unwrap())
                .await
                .expect_err("invalid flag");
            assert_eq!(
                error.data.unwrap().code,
                scp_core::protocol::ErrorCode::InvalidParams
            );
            assert_eq!(error.message, message);
        }
    }
    drop(core);
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

#[tokio::test]
async fn refused_handoff_preserves_the_claim_and_audits_the_reason() {
    let (mut core, dir) = fixture().await;
    let (_, origin) = handoff_origin(&mut core).await;
    let (human, _) = hello(&mut core, json!({"human":true,"tty":true})).await;
    let mut claim = handoff_claim();
    claim["harness_handoff"] = json!(false);
    let (_, fork) = hello(&mut core, json!({"transient":true,"claim":claim})).await;
    call(
        &mut core,
        human,
        "adopt",
        json!({"endpoint":"app","parent":"lead"}),
    )
    .await;
    let (_, retry) = hello(&mut core, json!({"transient":true,"claim":handoff_claim()})).await;
    assert_eq!(retry["endpoint"]["id"], fork["endpoint"]["id"]);
    assert_eq!(retry["endpoint"]["address"], "me/app");
    let row = core
        .must_endpoint(fork["endpoint"]["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(scp_broker::core::text(&row, "harness_session"), None);
    assert_eq!(
        core.view(
            &core
                .must_endpoint(origin["endpoint"]["id"].as_str().unwrap())
                .await
                .unwrap()
        )
        .await
        .unwrap()["address"],
        "me/lead"
    );
    let audit = core
        .store
        .all(
            "SELECT detail FROM audit WHERE event = 'handoff_refused'",
            &[],
        )
        .await
        .unwrap();
    let detail: Value =
        serde_json::from_str(scp_broker::core::text(&audit[0], "detail").unwrap()).unwrap();
    assert_eq!(
        detail,
        json!({"from":"app","to":"lead","code":"scope_refused"})
    );
    drop(core);
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

#[tokio::test]
async fn handoff_and_live_relink_skip_ineligible_origins() {
    for change in [
        "hibernate = 'sleep',revive = '{}'",
        "session = 'sub:worker'",
        "created_at = 9999999999999",
        "harness = 'other'",
        "handle = '_gone_retired'",
        "hook_seen = 9999999999999",
    ] {
        let (mut core, dir) = fixture().await;
        let (_, origin) = handoff_origin(&mut core).await;
        let (human, _) = hello(&mut core, json!({"human":true,"tty":true})).await;
        core.store
            .all(
                &format!("UPDATE endpoints SET {change} WHERE id = ?"),
                &[SqlValue::Text(
                    origin["endpoint"]["id"].as_str().unwrap().into(),
                )],
            )
            .await
            .unwrap();
        let (_, fork) = hello(&mut core, json!({"transient":true,"claim":handoff_claim()})).await;
        assert_eq!(fork["endpoint"]["address"], "me/app", "{change}");
        assert_eq!(
            call(&mut core, human, "relink", json!({"live":true})).await,
            json!({"relinked":[]}),
            "{change}"
        );
        drop(core);
        tokio::fs::remove_dir_all(dir).await.expect("cleanup");
    }
}
