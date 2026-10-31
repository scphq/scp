#[path = "fixtures/store_support.rs"]
mod support;

use scp_broker::store::{
    SqlValue, Storage,
    schema::{migrate, prune_audit},
};
use serde_json::{Value, json};
use support::{TempStore, json_rows};

const NOW: i64 = 1_700_000_000_000;
const MASTER: &str = "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name";
const FEDERATED: [(&str, &str); 8] = [
    ("remote", "TEXT"),
    ("auth", "TEXT"),
    ("incarnation", "TEXT"),
    ("scope_epoch", "INTEGER"),
    ("mirrored_caps", "TEXT"),
    ("mirrored_presence", "TEXT"),
    ("waking_until", "INTEGER"),
    ("mirrored_active", "INTEGER"),
];

fn expected_schema() -> Value {
    let mut rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/ts-schema.json")).expect("schema fixture");
    for (name, sql) in [
        (
            "judge_holds",
            "CREATE TABLE judge_holds (id TEXT PRIMARY KEY, from_ep TEXT NOT NULL, params TEXT NOT NULL, origin TEXT NOT NULL, verdict TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, by TEXT, resolved_at INTEGER)",
        ),
        (
            "judge_sent",
            "CREATE TABLE judge_sent (from_ep TEXT NOT NULL, client_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (from_ep, client_id))",
        ),
    ] {
        rows.push(json!({"type":"table","name":name,"tbl_name":name,"sql":sql}));
        rows.push(json!({"type":"index","name":format!("sqlite_autoindex_{name}_1"),"tbl_name":name,"sql":null}));
    }
    for row in &mut rows {
        if row["type"] == "table" && row["name"] == "endpoints" {
            let sql = row["sql"].as_str().expect("endpoints sql");
            let added: String = FEDERATED
                .iter()
                .map(|(column, kind)| format!(", {column} {kind}"))
                .collect();
            row["sql"] = json!(format!("{}{added})", &sql[..sql.len() - 1]));
        }
    }
    rows.push(json!({"type":"index","name":"endpoints_remote","tbl_name":"endpoints","sql":"CREATE UNIQUE INDEX endpoints_remote ON endpoints (remote) WHERE remote IS NOT NULL"}));
    rows.sort_by(|a, b| {
        a["type"]
            .as_str()
            .cmp(&b["type"].as_str())
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    json!(rows)
}

fn sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::String(value) => SqlValue::Text(value.clone()),
        Value::Number(value) => value.as_i64().map_or_else(
            || SqlValue::Real(value.as_f64().expect("number")),
            SqlValue::Int,
        ),
        _ => panic!("unsupported parameter"),
    }
}

fn normalize(mut rows: Value) -> Value {
    for row in rows.as_array_mut().expect("rows") {
        for column in ["rules", "caps", "detail"] {
            if let Some(Value::String(text)) = row.get(column) {
                row[column] = serde_json::from_str(text).expect("JSON column");
            }
        }
    }
    rows
}

#[tokio::test]
async fn fresh_schema_matches_reference_with_judge_tables() {
    let temp = TempStore::new().await;
    migrate(&temp.store, NOW).await.expect("migrate");
    let expected = expected_schema();
    assert_eq!(
        json_rows(temp.store.read(MASTER, &[]).await.expect("schema")),
        expected
    );
    let builtins = temp
        .store
        .read(
            "SELECT handle, kind, harness, labels, created_at FROM endpoints ORDER BY rowid",
            &[],
        )
        .await
        .expect("builtins");
    assert_eq!(
        json_rows(builtins),
        json!([
            {"handle": "_relay", "kind": "system", "harness": "relay", "labels": "{}", "created_at": NOW},
            {"handle": "_human", "kind": "human", "harness": "human", "labels": "{}", "created_at": NOW}
        ])
    );
    temp.close().await;
}

#[tokio::test]
async fn reference_database_adds_judge_tables_without_changing_rows() {
    let temp = TempStore::new().await;
    let schema: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/ts-schema.json")).expect("schema fixture");
    for kind in ["table", "index", "trigger"] {
        for entry in &schema {
            if entry["type"] == kind
                && entry["name"] != "sqlite_sequence"
                && let Some(sql) = entry["sql"].as_str()
            {
                temp.store.all(sql, &[]).await.expect("recreate schema");
            }
        }
    }
    let data: Value =
        serde_json::from_str(include_str!("fixtures/ts-relay.json")).expect("data fixture");
    for table in ["endpoints", "relay_migrations"] {
        for row in data[table].as_array().expect("fixture rows") {
            let row = row.as_object().expect("row");
            let columns = row
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(", ");
            let placeholders = vec!["?"; row.len()].join(", ");
            let params = row.values().map(sql_value).collect::<Vec<_>>();
            temp.store
                .all(
                    &format!("INSERT INTO {table} ({columns}) VALUES ({placeholders})"),
                    &params,
                )
                .await
                .expect("fixture data");
        }
    }
    let (store, schema) = (&temp.store, &schema);
    let snapshot = |pass: i64| async move {
        let mut result = serde_json::Map::new();
        result.insert(
            "schema".into(),
            json_rows(store.all(MASTER, &[]).await.expect("schema")),
        );
        for entry in schema {
            if entry["type"] == "table" {
                let table = entry["name"].as_str().expect("table name");
                result.insert(
                    table.into(),
                    json_rows(
                        store
                            .all(
                                &format!("SELECT * FROM {table} ORDER BY rowid -- pass {pass}"),
                                &[],
                            )
                            .await
                            .expect("table"),
                    ),
                );
            }
        }
        Value::Object(result)
    };
    let mut before = snapshot(0).await;
    before["schema"] = expected_schema();
    for row in before["endpoints"].as_array_mut().expect("endpoint rows") {
        for (column, _) in FEDERATED {
            row[column] = Value::Null;
        }
    }
    for now in [NOW + 1, NOW + 2] {
        migrate(&temp.store, now)
            .await
            .expect("idempotent migration");
        assert_eq!(snapshot(now).await, before);
    }
    temp.close().await;
}

#[tokio::test]
async fn tree_preset_rewrite_and_audits_match_reference() {
    let temp = TempStore::new().await;
    migrate(&temp.store, NOW).await.expect("migrate");
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/ts-tree.json")).expect("tree fixture");
    for seed in fixture["seed"].as_array().expect("seed") {
        let params = seed["params"]
            .as_array()
            .expect("params")
            .iter()
            .map(sql_value)
            .collect::<Vec<_>>();
        temp.store
            .all(seed["query"].as_str().expect("query"), &params)
            .await
            .expect("seed statement");
    }
    migrate(&temp.store, NOW).await.expect("tree migration");
    for (table, query) in [
        (
            "endpoints",
            "SELECT id, rules, caps FROM endpoints WHERE kind = 'agent' ORDER BY rowid",
        ),
        (
            "grants",
            "SELECT token_hash, caps FROM grants ORDER BY rowid",
        ),
        (
            "audit",
            "SELECT at, event, endpoint, ref, detail FROM audit ORDER BY id",
        ),
    ] {
        let expected = normalize(fixture["after"][table].clone());
        assert_eq!(
            normalize(json_rows(
                temp.store.read(query, &[]).await.expect("migrated rows")
            )),
            expected,
            "{table}"
        );
        migrate(&temp.store, NOW + 1)
            .await
            .expect("idempotent rewrite");
        assert_eq!(
            normalize(json_rows(
                temp.store.read(query, &[]).await.expect("unchanged rows")
            )),
            expected,
            "{table}"
        );
    }
    temp.close().await;
}

#[tokio::test]
async fn older_schema_columns_data_and_trigger_upgrade() {
    let temp = TempStore::new().await;
    migrate(&temp.store, NOW).await.expect("migrate");
    for index in ["endpoints_process", "endpoints_hooked", "grants_bound"] {
        temp.store
            .all(&format!("DROP INDEX {index}"), &[])
            .await
            .expect("drop index");
    }
    for (table, column) in [
        ("endpoints", "process"),
        ("messages", "link_parent"),
        ("grants", "bound_process"),
        ("deliveries", "restated_at"),
        ("activity", "agent"),
        ("idempotency", "payload_hash"),
    ] {
        temp.store
            .all(&format!("ALTER TABLE {table} DROP COLUMN {column}"), &[])
            .await
            .expect("older column set");
    }
    temp.store.all("INSERT INTO endpoints (id, handle, kind, session, created_at) VALUES ('ep_legacy', 'legacy', 'agent', 'pid:42:Thu-Oct-9-10:00:00-2026', 0)", &[]).await.expect("legacy process");
    temp.store
        .all(
            "INSERT INTO groups (name, owner, created_at) VALUES ('group', 'ep_legacy', 0)",
            &[],
        )
        .await
        .expect("legacy group");
    temp.store
        .all("DROP TRIGGER audit_no_delete", &[])
        .await
        .expect("drop trigger");
    temp.store.all("CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'old trigger'); END", &[]).await.expect("old trigger");
    migrate(&temp.store, NOW).await.expect("upgrade");
    assert_eq!(
        temp.store
            .read("SELECT process FROM endpoints WHERE id = 'ep_legacy'", &[])
            .await
            .expect("process")[0]["process"],
        SqlValue::Text("pid:42:Thu-Oct-9-10:00:00-2026".into())
    );
    let groups = temp
        .store
        .read("SELECT id FROM groups", &[])
        .await
        .expect("groups");
    let SqlValue::Text(id) = &groups[0]["id"] else {
        panic!("group id");
    };
    assert!(id.starts_with("grp_0loyw3v28"));
    assert_eq!(id.len(), 29);
    let trigger = temp
        .store
        .read(
            "SELECT sql FROM sqlite_master WHERE name = 'audit_no_delete'",
            &[],
        )
        .await
        .expect("trigger");
    let schema: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/ts-schema.json")).expect("fixture");
    let expected = schema
        .iter()
        .find(|entry| entry["name"] == "audit_no_delete")
        .expect("expected trigger");
    assert_eq!(json_rows(trigger)[0]["sql"], expected["sql"]);
    temp.close().await;
}

#[tokio::test]
async fn failed_tree_rewrite_rolls_back_data_and_audits() {
    let temp = TempStore::new().await;
    migrate(&temp.store, NOW).await.expect("migrate");
    temp.store
        .all("DELETE FROM relay_migrations", &[])
        .await
        .expect("reset marker");
    temp.store.all("INSERT INTO endpoints (id, handle, kind, rules, created_at) VALUES ('ep_valid', 'valid', 'agent', '{\"in\":[\"tree:self\"]}', 0), ('ep_invalid', 'invalid', 'agent', 'invalid json', 0)", &[]).await.expect("seed");
    assert!(migrate(&temp.store, NOW).await.is_err());
    assert_eq!(
        temp.store
            .read("SELECT rules FROM endpoints WHERE id = 'ep_valid'", &[])
            .await
            .expect("rules")[0]["rules"],
        SqlValue::Text("{\"in\":[\"tree:self\"]}".into())
    );
    assert!(
        temp.store
            .read("SELECT * FROM audit", &[])
            .await
            .expect("audit")
            .is_empty()
    );
    assert!(
        temp.store
            .read("SELECT * FROM relay_migrations", &[])
            .await
            .expect("markers")
            .is_empty()
    );
    temp.close().await;
}

#[tokio::test]
async fn audit_retention_honors_forever_noise_limit_and_append_only_trigger() {
    let temp = TempStore::new().await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as i64;
    migrate(&temp.store, now).await.expect("migrate");
    let day = 86_400_000;
    for (at, event) in [
        (now - 31 * day, "expired"),
        (now - 2 * day, "kept"),
        (now - day + 60_000, "scope_refused"),
    ] {
        temp.store
            .all(
                "INSERT INTO audit (at, event) VALUES (?, ?)",
                &[SqlValue::Int(at), SqlValue::Text(event.into())],
            )
            .await
            .expect("audit row");
    }
    temp.store.all("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5001) INSERT INTO audit (at, event) SELECT ?, 'scope_refused' FROM n", &[SqlValue::Int(now - 2 * day)]).await.expect("noise backlog");
    assert_eq!(
        prune_audit(&temp.store, now, None)
            .await
            .expect("keep forever"),
        0
    );
    assert_eq!(
        prune_audit(&temp.store, now, Some(30 * 86_400))
            .await
            .expect("first prune"),
        5001
    );
    assert_eq!(
        prune_audit(&temp.store, now, Some(30 * 86_400))
            .await
            .expect("second prune"),
        1
    );
    assert_eq!(
        prune_audit(&temp.store, now, Some(30 * 86_400))
            .await
            .expect("empty prune"),
        0
    );
    assert_eq!(
        temp.store
            .read("SELECT count(*) AS n FROM audit", &[])
            .await
            .expect("remaining")[0]["n"],
        SqlValue::Int(2)
    );
    assert!(temp.store.all("DELETE FROM audit", &[]).await.is_err());
    assert!(
        temp.store
            .all("UPDATE audit SET detail = '{}'", &[])
            .await
            .is_err()
    );
    temp.close().await;
}
