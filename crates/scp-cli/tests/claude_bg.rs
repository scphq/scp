//! The native claude-bg policy against goldens the TypeScript policy wrote (`bun scripts/cli-goldens.ts`), and the frozen state fixtures.

use scp_cli::claude::bg_cmd::backgrounded;
use scp_cli::claude::bg_plan::{
    Action, BgConfig, PlanInput, RemoveMode, ancestors_of, attach_targets, bg_config,
    only_polls_inbox, parse_seconds, plan, polls_inbox, runs_command,
};
use scp_cli::claude::bg_state::{
    Agent, BgRecord, BgState, Entry, Records, TaskState, ref_session, revive_ref,
};
use scp_cli::fleet::json::Json;
use scp_mcp::ps::Env;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Once, OnceLock};

fn goldens() -> &'static Value {
    static GOLDENS: OnceLock<Value> = OnceLock::new();
    static UTC: Once = Once::new();
    UTC.call_once(|| {
        // SAFETY: the first thing any test here does, under the Once, before any of them reads a local time
        unsafe { std::env::set_var("TZ", "UTC") };
    });
    GOLDENS.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/claude-bg.json")).expect("claude-bg.json")
    })
}

fn json(value: &Value) -> Json {
    Json::parse(value.to_string().as_bytes()).expect("json")
}

fn strings(value: Option<&Value>) -> HashSet<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|one| one.as_str().unwrap().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn seconds(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::INFINITY)
}

fn remove_mode(value: &Value) -> RemoveMode {
    match value.as_str() {
        Some("on_stop") => RemoveMode::OnStop,
        Some("historic") => RemoveMode::Historic,
        _ => RemoveMode::Never,
    }
}

fn config(value: &Value) -> BgConfig {
    BgConfig {
        stop_after_s: seconds(&value["stopAfterS"]),
        idle_after_s: seconds(&value["idleAfterS"]),
        remove: remove_mode(&value["remove"]),
    }
}

fn records(value: &Value) -> Records {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, record)| {
            (
                id.clone(),
                BgRecord {
                    file: record["file"].as_str().unwrap().to_owned(),
                    handle: record["handle"].as_str().map(str::to_owned),
                    parented: record["parented"] == true,
                },
            )
        })
        .collect()
}

fn summary(action: &Action) -> Value {
    let (kind, last) = match action {
        Action::Keep { reason, .. } => ("keep", Value::from(reason.as_str())),
        Action::Remove { live, .. } => ("remove", Value::from(*live)),
        Action::Stop(_) => ("stop", Value::Null),
        Action::Unhibernate(_) => ("unhibernate", Value::Null),
        Action::Orphan { .. } => ("orphan", Value::Null),
    };
    let agent = action
        .agent()
        .map_or(Value::Null, |agent| agent.id.as_str().into());
    Value::from(vec![kind.into(), action.id().into(), agent, last])
}

#[test]
fn plans_match_the_typescript_planner() {
    let golden = goldens();
    let dims = &golden["dims"];
    let cases = golden["plans"].as_array().unwrap();
    assert!(cases.len() > 1000);
    for case in cases {
        let at = |at: usize| case["dims"][at].as_u64().unwrap() as usize;
        let dim = |name: &str, index: usize| &dims[name][index];
        let entries: Vec<Entry> = dim("entries", at(0))
            .as_array()
            .unwrap()
            .iter()
            .map(|one| Entry::new(json(one)))
            .collect();
        let agents: Vec<Agent> = dim("agents", at(1))
            .as_array()
            .unwrap()
            .iter()
            .map(|one| Agent::new(&json(one)))
            .collect();
        let records = records(dim("records", at(2)));
        let states: HashMap<String, BgState> = dim("states", at(3))
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, state)| (id.clone(), BgState::parse(&state.to_string()).unwrap()))
            .collect();
        let options = dim("options", at(5));
        let own_pids: HashSet<i64> = options
            .get("selfPids")
            .and_then(Value::as_array)
            .map(|pids| pids.iter().map(|pid| pid.as_i64().unwrap()).collect())
            .unwrap_or_default();
        let actions = plan(&PlanInput {
            entries: &entries,
            agents: &agents,
            records: &records,
            states: &states,
            attached: &strings(options.get("attached")),
            processes: dim("tables", at(6)).as_str(),
            now: golden["now"].as_f64().unwrap(),
            config: config(dim("configs", at(4))),
            older_than_s: options.get("olderThanS").and_then(Value::as_f64),
            stop_only: options.get("stopOnly") == Some(&Value::Bool(true)),
            retry_refused: options.get("retryRefused") == Some(&Value::Bool(true)),
            own_sessions: &strings(options.get("self")),
            own_pids: &own_pids,
        });
        let got: Vec<Value> = actions.iter().map(summary).collect();
        assert_eq!(Value::from(got), case["actions"], "{}", case["dims"]);
    }
}

#[test]
fn inbox_polls_match() {
    let golden = goldens();
    let rows = golden["polls"].as_array().unwrap();
    assert!(rows.len() > 1000);
    for row in rows {
        let text = row[0].as_str().unwrap();
        assert_eq!(polls_inbox(text), row[1] == true, "{text:?}");
    }
}

#[test]
fn process_tables_read_the_same() {
    for row in goldens()["processes"].as_array().unwrap() {
        let table = row[0].as_str().unwrap();
        let pid = row[1].as_i64().unwrap();
        let after = match &row[2] {
            Value::Null => None,
            Value::String(_) => Some(f64::NAN),
            value => value.as_f64(),
        };
        assert_eq!(runs_command(table, pid), row[3] == true, "{table:?} {pid}");
        assert_eq!(
            only_polls_inbox(table, pid, after),
            row[4] == true,
            "{table:?} {pid} {after:?}"
        );
    }
}

#[test]
fn attach_targets_and_ancestors_match() {
    let golden = goldens();
    for row in golden["attach"].as_array().unwrap() {
        assert_eq!(
            attach_targets(row[0].as_str().unwrap()),
            strings(Some(&row[1]))
        );
    }
    for row in golden["ancestors"].as_array().unwrap() {
        let mut chain: Vec<i64> = ancestors_of(row[0].as_str().unwrap(), row[1].as_i64().unwrap())
            .into_iter()
            .collect();
        chain.sort_unstable();
        assert_eq!(Value::from(chain), row[2], "{row}");
    }
}

#[test]
fn settings_read_the_same() {
    for row in goldens()["configs"].as_array().unwrap() {
        let env: Env = row["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
            .collect();
        let file = match json(&row["file"]) {
            file @ (Json::Obj(_) | Json::Arr(_)) => file,
            _ => Json::Obj(Vec::new()),
        };
        assert_eq!(bg_config(&env, &file), config(&row["config"]), "{row}");
    }
}

#[test]
fn durations_read_the_same() {
    for row in goldens()["durations"].as_array().unwrap() {
        let parsed = parse_seconds(row[0].as_str().unwrap(), "--older-than");
        match row.get(2) {
            Some(message) => assert_eq!(parsed.unwrap_err(), message.as_str().unwrap(), "{row}"),
            None => assert_eq!(parsed.unwrap(), row[1].as_f64().unwrap(), "{row}"),
        }
    }
}

#[test]
fn revive_refs_read_the_same() {
    let golden = &goldens()["refs"];
    let session = golden["session"].as_str().unwrap();
    for row in golden["made"].as_array().unwrap() {
        let made = revive_ref(session, row["cwd"].as_str().unwrap(), row["name"].as_str());
        assert_eq!(made, row["ref"].as_str().unwrap(), "{row}");
    }
    for row in golden["reads"].as_array().unwrap() {
        assert_eq!(
            ref_session(row[0].as_str().unwrap()),
            row[1].as_str().unwrap()
        );
    }
}

#[test]
fn a_new_short_id_reads_the_same() {
    for row in goldens()["backgrounded"].as_array().unwrap() {
        assert_eq!(
            backgrounded(row[0].as_str().unwrap()),
            row[1].as_str(),
            "{row}"
        );
    }
}

fn fixtures(name: &str) -> Vec<(String, String)> {
    let dir: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/spec/schema/cli/fixtures")
        .join(name);
    let mut files: Vec<(String, String)> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|file| {
            (
                file.file_name().to_string_lossy().into_owned(),
                std::fs::read_to_string(file.path()).unwrap(),
            )
        })
        .collect();
    files.sort();
    files
}

#[test]
fn state_fixtures_read_and_rewrite_byte_for_byte() {
    let files = fixtures("claude-bg-state");
    assert!(files.len() > 5);
    for (name, text) in files {
        match BgState::parse(&text) {
            None => assert!(name.starts_with("invalid-"), "{name}"),
            Some(state) => {
                assert!(!name.starts_with("invalid-"), "{name}");
                assert_eq!(format!("{}\n", state.0.pretty()), text, "{name}");
            }
        }
    }
}

#[test]
fn record_fixtures_read_as_the_policy_needs() {
    for (name, text) in fixtures("claude-bg-mcp-config") {
        let record = BgRecord::parse("/f".into(), &text);
        assert_eq!(record.is_none(), name.starts_with("invalid-"), "{name}");
    }
}

#[test]
fn task_fixtures_read_and_rewrite() {
    let fresh = TaskState::default();
    for (name, text) in fixtures("claude-bg-task") {
        let state = TaskState::parse(&text);
        if name.starts_with("invalid-") {
            assert_eq!(state, fresh, "{name}");
        } else if !name.starts_with("tolerated-") {
            assert_eq!(
                state.to_json().to_value(),
                serde_json::from_str::<Value>(&text).unwrap(),
                "{name}"
            );
        }
    }
}
