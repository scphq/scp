use std::sync::Arc;

use scp_broker::{
    core::{Core, now_ms},
    paths::Paths,
    proto::Limits,
    store::{SqlValue, sqlite::SqliteStore},
};

const DAY: i64 = 86_400_000;
const DEAD: &str = "pid:999999:Thu-Oct-15-10:00:00-2026";

async fn fixture() -> (Core, std::path::PathBuf) {
    fixture_with(Limits::default()).await
}

async fn fixture_with(limits: Limits) -> (Core, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("scp-sweep-{:032x}", rand::random::<u128>()));
    tokio::fs::create_dir(&dir)
        .await
        .expect("temporary directory");
    let paths = Paths::new(dir.clone());
    let core = Core::new(
        Arc::new(SqliteStore::open(&paths.database).expect("store")),
        limits,
        paths,
        dir.join("policy.json"),
    )
    .await
    .expect("core");
    (core, dir)
}

async fn cleanup(core: Core, dir: std::path::PathBuf) {
    drop(core);
    tokio::fs::remove_dir_all(dir).await.expect("cleanup");
}

fn t(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

async fn endpoint(core: &Core, id: &str, handle: &str, parent: Option<&str>, at: i64) {
    core.store
        .all(
            "INSERT INTO endpoints (id, handle, kind, harness, created_at, last_seen, parent_ep, process) VALUES (?, ?, 'agent', 'claude-code', ?, ?, ?, ?)",
            &[
                t(id),
                t(handle),
                SqlValue::Int(at),
                SqlValue::Int(at),
                parent.map_or(SqlValue::Null, t),
                t(DEAD),
            ],
        )
        .await
        .expect("endpoint");
}

async fn exists(core: &Core, id: &str) -> bool {
    !core
        .store
        .read("SELECT 1 AS n FROM endpoints WHERE id = ?", &[t(id)])
        .await
        .expect("exists")
        .is_empty()
}

async fn count(core: &Core, sql: &str) -> i64 {
    let rows = core.store.read(sql, &[]).await.expect("count");
    match rows[0].get("n") {
        Some(SqlValue::Int(n)) => *n,
        _ => panic!("count row"),
    }
}

async fn message(core: &Core, id: &str, from: &str, kind: &str, expires: i64) {
    core.store
        .all(
            "INSERT INTO messages (id, thread, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at) VALUES (?, 'thr', ?, ?, 'me/x', 'hi', 'text/plain', 'public', '[]', 0, ?, ?)",
            &[t(id), t(kind), t(from), SqlValue::Int(expires - DAY), SqlValue::Int(expires)],
        )
        .await
        .expect("message");
}

async fn delivery(core: &Core, message: &str, endpoint: &str, acked: Option<i64>, expires: i64) {
    core.store
        .all(
            "INSERT INTO deliveries (message_id, endpoint, acked_at, expires_at) VALUES (?, ?, ?, ?)",
            &[
                t(message),
                t(endpoint),
                acked.map_or(SqlValue::Null, SqlValue::Int),
                SqlValue::Int(expires),
            ],
        )
        .await
        .expect("delivery");
}

#[tokio::test]
async fn ended_child_past_age_is_retired_with_acked_mail_root_and_audit_stay() {
    let (mut core, dir) = fixture().await;
    let now = now_ms();
    endpoint(&core, "ep_root", "root", None, now - 3 * DAY).await;
    endpoint(
        &core,
        "ep_child",
        "root-gp-a1b2",
        Some("ep_root"),
        now - 3 * DAY,
    )
    .await;
    message(&core, "msg_1", "ep_root", "message", now + 7 * DAY).await;
    delivery(
        &core,
        "msg_1",
        "ep_child",
        Some(now - 2 * DAY),
        now + 7 * DAY,
    )
    .await;
    core.store
        .all(
            "INSERT INTO audit (at, event, endpoint, detail) VALUES (?, 'claim', 'ep_child', '{}')",
            &[SqlValue::Int(now - 3 * DAY)],
        )
        .await
        .expect("audit");
    core.sweep().await.expect("sweep");
    assert!(!exists(&core, "ep_child").await);
    assert!(exists(&core, "ep_root").await);
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM deliveries WHERE endpoint = 'ep_child'"
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM audit WHERE endpoint = 'ep_child'"
        )
        .await,
        1
    );
    cleanup(core, dir).await;
}

#[tokio::test]
async fn recent_child_and_unread_named_hibernated_children_stay() {
    let (mut core, dir) = fixture().await;
    let now = now_ms();
    endpoint(&core, "ep_root", "root", None, now - 3 * DAY).await;
    endpoint(
        &core,
        "ep_recent",
        "root-gp-rece",
        Some("ep_root"),
        now - 3_600_000,
    )
    .await;
    endpoint(
        &core,
        "ep_unread",
        "root-gp-unre",
        Some("ep_root"),
        now - 3 * DAY,
    )
    .await;
    endpoint(&core, "ep_named", "keeper", Some("ep_root"), now - 3 * DAY).await;
    endpoint(
        &core,
        "ep_asleep",
        "root-gp-asle",
        Some("ep_root"),
        now - 3 * DAY,
    )
    .await;
    core.store
        .all(
            "UPDATE endpoints SET named = ? WHERE id = 'ep_named'",
            &[SqlValue::Int(now)],
        )
        .await
        .expect("named");
    core.store
        .all("UPDATE endpoints SET hibernate = 'hook:test', hibernated_at = ? WHERE id = 'ep_asleep'", &[SqlValue::Int(now)])
        .await
        .expect("hibernate");
    message(&core, "msg_1", "ep_root", "message", now + 30 * DAY).await;
    delivery(&core, "msg_1", "ep_unread", None, now + 30 * DAY).await;
    core.sweep().await.expect("sweep");
    for id in ["ep_recent", "ep_unread", "ep_named", "ep_asleep"] {
        assert!(exists(&core, id).await, "{id} stays");
    }
    cleanup(core, dir).await;
}

#[tokio::test]
async fn read_unexpired_request_keeps_child_until_it_expires() {
    let (mut core, dir) = fixture().await;
    let now = now_ms();
    endpoint(&core, "ep_root", "root", None, now - 3 * DAY).await;
    endpoint(
        &core,
        "ep_asked",
        "root-gp-aske",
        Some("ep_root"),
        now - 3 * DAY,
    )
    .await;
    message(&core, "msg_1", "ep_root", "request", now + 30 * DAY).await;
    delivery(
        &core,
        "msg_1",
        "ep_asked",
        Some(now - 2 * DAY),
        now + 30 * DAY,
    )
    .await;
    core.sweep().await.expect("sweep");
    assert!(exists(&core, "ep_asked").await);
    cleanup(core, dir).await;
}

#[tokio::test]
async fn child_that_sent_stays_until_its_message_expires() {
    let (mut core, dir) = fixture().await;
    let now = now_ms();
    endpoint(&core, "ep_root", "root", None, now - 3 * DAY).await;
    endpoint(
        &core,
        "ep_child",
        "root-gp-sent",
        Some("ep_root"),
        now - 3 * DAY,
    )
    .await;
    message(&core, "msg_1", "ep_child", "message", now + 7 * DAY).await;
    delivery(
        &core,
        "msg_1",
        "ep_root",
        Some(now - 2 * DAY),
        now + 7 * DAY,
    )
    .await;
    core.sweep().await.expect("sweep");
    assert!(exists(&core, "ep_child").await);
    core.store
        .all(
            "UPDATE messages SET expires_at = ? WHERE id = 'msg_1'",
            &[SqlValue::Int(now - 1000)],
        )
        .await
        .expect("expire message");
    core.sweep().await.expect("sweep");
    assert!(!exists(&core, "ep_child").await);
    cleanup(core, dir).await;
}

#[tokio::test]
async fn parent_stays_while_child_runs_then_both_go() {
    let (mut core, dir) = fixture().await;
    let now = now_ms();
    endpoint(&core, "ep_root", "root", None, now - 6 * DAY).await;
    endpoint(&core, "ep_mid", "mid", Some("ep_root"), now - 6 * DAY).await;
    endpoint(&core, "ep_leaf", "leaf", Some("ep_mid"), now - 6 * DAY).await;
    core.sweep().await.expect("sweep");
    assert!(!exists(&core, "ep_leaf").await);
    assert!(!exists(&core, "ep_mid").await);
    assert!(exists(&core, "ep_root").await);
    cleanup(core, dir).await;
}

#[tokio::test]
async fn infinite_retention_age_keeps_every_row() {
    let mut limits = Limits::default();
    limits.0.insert("endpointRetireS".into(), None);
    let (mut core, dir) = fixture_with(limits).await;
    let now = now_ms();
    endpoint(&core, "ep_root", "root", None, now - 20 * DAY).await;
    endpoint(
        &core,
        "ep_child",
        "root-gp-a1b2",
        Some("ep_root"),
        now - 20 * DAY,
    )
    .await;
    core.sweep().await.expect("sweep");
    assert!(exists(&core, "ep_child").await);
    cleanup(core, dir).await;
}

#[tokio::test]
async fn one_sweep_retires_at_most_the_max_oldest_first() {
    let mut limits = Limits::default();
    limits.0.insert("endpointRetireMax".into(), Some(2));
    let (mut core, dir) = fixture_with(limits).await;
    let now = now_ms();
    endpoint(&core, "ep_root", "root", None, now - 3 * DAY).await;
    for (index, id) in ["aaaa11", "bbbb22", "cccc33", "dddd44", "eeee55"]
        .iter()
        .enumerate()
    {
        let at = now - 3 * DAY + index as i64 * 60_000;
        endpoint(
            &core,
            &format!("ep_{id}"),
            &format!("root-gp-{id}"),
            Some("ep_root"),
            at,
        )
        .await;
    }
    core.sweep().await.expect("sweep");
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM endpoints WHERE kind = 'agent'"
        )
        .await,
        4
    );
    assert!(!exists(&core, "ep_aaaa11").await);
    assert!(!exists(&core, "ep_bbbb22").await);
    core.sweep().await.expect("sweep");
    core.sweep().await.expect("sweep");
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM endpoints WHERE kind = 'agent'"
        )
        .await,
        1
    );
    cleanup(core, dir).await;
}

#[tokio::test]
async fn sweep_drops_old_refusals_and_keeps_other_events() {
    let (mut core, dir) = fixture().await;
    let now = now_ms();
    for (event, at) in [
        ("scope_refused", now - 2 * DAY),
        ("scope_refused", now - 3_600_000),
        ("claim", now - 2 * DAY),
    ] {
        core.store
            .all(
                "INSERT INTO audit (at, event, detail) VALUES (?, ?, '{}')",
                &[SqlValue::Int(at), t(event)],
            )
            .await
            .expect("audit");
    }
    core.sweep().await.expect("sweep");
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM audit WHERE event = 'scope_refused'"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM audit WHERE event = 'claim'"
        )
        .await,
        1
    );
    cleanup(core, dir).await;
}

#[tokio::test]
async fn refusal_backlog_drains_a_bounded_chunk_per_sweep() {
    let (mut core, dir) = fixture().await;
    let now = now_ms();
    core.store
        .all(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000) INSERT INTO audit (at, event, detail) SELECT ?, 'scope_refused', '{}' FROM n",
            &[SqlValue::Int(now - 2 * DAY)],
        )
        .await
        .expect("backlog");
    core.sweep().await.expect("sweep");
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM audit WHERE event = 'scope_refused'"
        )
        .await,
        1000
    );
    core.sweep().await.expect("sweep");
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM audit WHERE event = 'scope_refused'"
        )
        .await,
        0
    );
    cleanup(core, dir).await;
}

#[tokio::test]
async fn expired_mail_purges_and_handle_bound_prunes_unreferenced_rows() {
    let (mut core, dir) = fixture().await;
    let now = now_ms();
    endpoint(&core, "ep_a", "a", None, now).await;
    endpoint(&core, "ep_old", "old", None, now - 31 * DAY).await;
    endpoint(&core, "ep_kept", "kept", None, now - 31 * DAY).await;
    message(&core, "msg_dead", "ep_a", "message", now - 7 * DAY - 1000).await;
    delivery(&core, "msg_dead", "ep_a", None, now - 7 * DAY - 1000).await;
    message(&core, "msg_live", "ep_kept", "message", now + 7 * DAY).await;
    core.sweep().await.expect("sweep");
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM messages WHERE id = 'msg_dead'"
        )
        .await,
        0
    );
    assert!(!exists(&core, "ep_old").await);
    assert!(exists(&core, "ep_kept").await);
    cleanup(core, dir).await;
}

#[tokio::test]
async fn sweep_settles_offline_status_and_ends_exited_hooks() {
    let (mut core, dir) = fixture().await;
    let now = now_ms();
    endpoint(&core, "ep_gone", "gone-w", None, now - 3 * DAY).await;
    endpoint(&core, "ep_blocked", "gone-b", None, now - 3 * DAY).await;
    endpoint(&core, "ep_live", "live", None, now).await;
    endpoint(&core, "ep_exited", "exited", None, now).await;
    for (id, state) in [
        ("ep_gone", "working"),
        ("ep_blocked", "blocked"),
        ("ep_live", "working"),
    ] {
        core.store
            .all(
                "UPDATE endpoints SET status_state = ?, status_note = 'x' WHERE id = ?",
                &[t(state), t(id)],
            )
            .await
            .expect("status");
    }
    core.store
        .all(
            "UPDATE endpoints SET connections = 1, last_seen = ? WHERE id = 'ep_live'",
            &[SqlValue::Int(now)],
        )
        .await
        .expect("live");
    core.store
        .all(
            "UPDATE endpoints SET hook_seen = ? WHERE id IN ('ep_gone', 'ep_blocked')",
            &[SqlValue::Int(now - 2 * DAY)],
        )
        .await
        .expect("offline hooks");
    core.store
        .all(
            "UPDATE endpoints SET hook_seen = ? WHERE id = 'ep_exited'",
            &[SqlValue::Int(now - 60_000)],
        )
        .await
        .expect("exited hook");
    core.sweep().await.expect("sweep");
    let status = |rows: Vec<scp_broker::store::Row>| {
        rows.first().and_then(|row| match row.get("status_state") {
            Some(SqlValue::Text(value)) => Some(value.clone()),
            _ => None,
        })
    };
    let gone = core
        .store
        .read(
            "SELECT status_state FROM endpoints WHERE id = 'ep_gone'",
            &[],
        )
        .await
        .expect("gone");
    assert_eq!(status(gone), None);
    let blocked = core
        .store
        .read(
            "SELECT status_state FROM endpoints WHERE id = 'ep_blocked'",
            &[],
        )
        .await
        .expect("blocked");
    assert_eq!(status(blocked).as_deref(), Some("blocked"));
    let live = core
        .store
        .read(
            "SELECT status_state FROM endpoints WHERE id = 'ep_live'",
            &[],
        )
        .await
        .expect("live");
    assert_eq!(status(live).as_deref(), Some("working"));
    let exited = core
        .store
        .read(
            "SELECT hook_seen, hook_ended FROM endpoints WHERE id = 'ep_exited'",
            &[],
        )
        .await
        .expect("exited");
    assert_eq!(exited[0].get("hook_seen"), Some(&SqlValue::Null));
    assert!(matches!(
        exited[0].get("hook_ended"),
        Some(SqlValue::Int(_))
    ));
    cleanup(core, dir).await;
}

#[tokio::test]
async fn sweep_purges_counters_grants_memberships_peek_turns_and_idle_groups() {
    let (mut core, dir) = fixture().await;
    let now = now_ms();
    endpoint(&core, "ep_root", "root", None, now).await;
    core.store.all("INSERT INTO idempotency (from_ep, client_id, payload_hash, result, created_at) VALUES ('ep_root', 'old', '', '{}', ?), ('ep_root', 'new', '', '{}', ?)", &[SqlValue::Int(now - 2 * DAY), SqlValue::Int(now)]).await.expect("idempotency");
    core.store.all("INSERT INTO pair_events (from_ep, to_ep, at) VALUES ('ep_root', 'ep_root', ?), ('ep_root', 'ep_root', ?)", &[SqlValue::Int(now - 7_200_000), SqlValue::Int(now)]).await.expect("pair events");
    core.store
        .all(
            "INSERT INTO blocks (pair, until) VALUES ('a|b', ?), ('c|d', ?)",
            &[SqlValue::Int(now - 1000), SqlValue::Int(now + DAY)],
        )
        .await
        .expect("blocks");
    core.store
        .all(
            "INSERT INTO tree_events (tree, at) VALUES ('ep_root', ?), ('ep_root', ?)",
            &[SqlValue::Int(now - 7_200_000), SqlValue::Int(now)],
        )
        .await
        .expect("tree events");
    core.store.all("INSERT INTO grants (token_hash, issuer, under, created_at, expires_at) VALUES ('gone', 'ep_root', 'ep_root', ?, ?), ('kept', 'ep_root', 'ep_root', ?, ?)", &[SqlValue::Int(now - DAY), SqlValue::Int(now - 1000), SqlValue::Int(now - DAY), SqlValue::Int(now + DAY)]).await.expect("grants");
    core.store
        .all(
            "UPDATE grants SET used_by = 'ep_root' WHERE token_hash = 'kept'",
            &[],
        )
        .await
        .expect("grant used");
    core.store.all("INSERT INTO grants (token_hash, issuer, under, created_at, expires_at, used_by) VALUES ('spent', 'ep_root', 'ep_root', ?, ?, 'ep_root')", &[SqlValue::Int(now - DAY), SqlValue::Int(now - 1000)]).await.expect("spent grant");
    core.store.all("INSERT INTO group_members (name, endpoint, added_by, at) VALUES ('g', 'ep_missing', 'ep_root', ?), ('g', 'ep_root', 'ep_root', ?)", &[SqlValue::Int(now), SqlValue::Int(now)]).await.expect("members");
    core.store.all("INSERT INTO peek_turns (endpoint, at, role, text) VALUES ('ep_missing', ?, 'user', 'x'), ('ep_root', ?, 'user', 'x')", &[SqlValue::Int(now), SqlValue::Int(now)]).await.expect("peek turns");
    core.store.all("INSERT INTO groups (name, owner, tree, pinned, created_at) VALUES ('idle', 'ep_root', 'ep_missing', 0, ?), ('busy', 'ep_root', 'ep_root', 0, ?)", &[SqlValue::Int(now), SqlValue::Int(now)]).await.expect("groups");
    core.sweep().await.expect("sweep");
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM idempotency WHERE client_id = 'old'"
        )
        .await,
        0
    );
    assert_eq!(
        count(&core, "SELECT COUNT(*) AS n FROM pair_events").await,
        1
    );
    assert_eq!(count(&core, "SELECT COUNT(*) AS n FROM blocks").await, 1);
    assert_eq!(
        count(&core, "SELECT COUNT(*) AS n FROM tree_events").await,
        1
    );
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM grants WHERE token_hash = 'gone'"
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM grants WHERE token_hash = 'spent'"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM group_members WHERE endpoint = 'ep_missing'"
        )
        .await,
        0
    );
    assert_eq!(
        count(&core, "SELECT COUNT(*) AS n FROM peek_turns").await,
        0
    );
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM groups WHERE name = 'idle'"
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &core,
            "SELECT COUNT(*) AS n FROM groups WHERE name = 'busy'"
        )
        .await,
        1
    );
    cleanup(core, dir).await;
}
