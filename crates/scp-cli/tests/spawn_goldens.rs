//! The native spawn argv and output functions against goldens the TypeScript CLI wrote (`bun scripts/spawn-goldens.ts`).

use scp_cli::Fail;
use scp_cli::args::{Parsed, Val};
use scp_cli::spawn::argv::{
    Context, Prompt, closed_stdin, codex_exec, codex_mount, codex_override_at, codex_overrides,
    codex_skips_git_check, handback_bytes, harness_argv, has_flag, in_git, messaging_allow,
    program_at, prompt_at, resume_argv, spawn_prompt, split_spawn, steer_argv, toml,
};
use scp_cli::spawn::grant::{grant_params, spawn_environment};
use scp_cli::spawn::hold::{
    HoldClaim, durable_ref, first_run, framed, hold_claim, idle_seconds, read_conversation,
    ref_problem, resume_base, resume_session, woke_by,
};
use scp_cli::spawn::muse::{
    contributor_refusal, muse_exec, muse_first_run, muse_mode_at, muse_modes, muse_options_end,
    muse_resume_base,
};
use scp_cli::spawn::output::{
    HarnessRun, Head, TRANSCRIPT_BYTES, codex_thread, harness_output, replies_output,
    stderr_output, transcript_replies,
};
use scp_cli::spawn::run::{durable_check, parse_spawn, spawn_idle};
use scp_cli::spawn::settings::{config_file, idle_setting};
use scp_cli::spawn::text::{agy_note, spawn_defaults, spawn_title, steer_prompt, worker_name};
use scp_mcp::ps::Env;
use serde_json::{Value, json};
use toml::Value as Toml;

const SWARM: &str = "<swarm>";
const SELF: [&str; 2] = ["node", "/cli.js"];

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

fn env_of(value: &Value) -> Env {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .collect()
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap()
}

fn bytes_of(value: &Value) -> Vec<u8> {
    let hex = text(value).as_bytes();
    let digit = |c: u8| (c as char).to_digit(16).unwrap() as u8;
    hex.chunks(2)
        .map(|pair| digit(pair[0]) * 16 + digit(pair[1]))
        .collect()
}

fn opt_num(value: &Value) -> Option<i64> {
    value.as_i64()
}

fn to_toml(value: &Value) -> Toml {
    match value {
        Value::String(text) => Toml::String(text.clone()),
        Value::Bool(on) => Toml::Boolean(*on),
        Value::Number(n) => n
            .as_i64()
            .map_or_else(|| Toml::Float(n.as_f64().unwrap()), Toml::Integer),
        Value::Array(items) => Toml::Array(items.iter().map(to_toml).collect()),
        other => panic!("no TOML for {other}"),
    }
}

fn optional<T: Into<Value>>(value: Option<T>) -> Value {
    value.map_or(Value::Null, Into::into)
}

fn prompt_json(found: Option<Prompt>) -> Value {
    match found {
        None => Value::Null,
        Some(Prompt { at, from: None }) => json!({ "at": at }),
        Some(Prompt {
            at,
            from: Some(from),
        }) => json!({ "at": at, "from": from }),
    }
}

fn parsed_of(value: &Value) -> Parsed {
    let mut values = Parsed::default();
    for entry in value.as_array().unwrap() {
        let value = match &entry[1] {
            Value::Bool(on) => Val::Flag(*on),
            Value::Array(_) => Val::List(strings(&entry[1])),
            other => Val::Text(text(other).to_owned()),
        };
        values.values.push((text(&entry[0]).to_owned(), value));
    }
    values
}

fn seconds(n: f64) -> Value {
    if n.is_infinite() {
        json!("Infinity")
    } else if n.fract() == 0.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `{ ok }` or the usage error's `{ error }`, as the goldens write them
fn usage<T>(result: Result<T, Fail>, ok: impl FnOnce(T) -> Value) -> Value {
    match result {
        Ok(value) => json!({ "ok": ok(value) }),
        Err(Fail::Usage(message)) => json!({ "error": message }),
        Err(other) => panic!("{other:?}"),
    }
}

fn number(value: &Value) -> f64 {
    match value {
        Value::String(text) if text == "Infinity" => f64::INFINITY,
        other => other.as_f64().unwrap(),
    }
}

fn bin_of(env: &Env) -> Option<&'static str> {
    (env.get("SCP_SWARM_BIN").map(String::as_str) == Some(SWARM)).then_some(SWARM)
}

fn replay(name: &str, i: &Value) -> Value {
    let self_words: Vec<String> = SELF.iter().map(|w| (*w).to_owned()).collect();
    match name {
        "programAt" => json!(program_at(&strings(&i["command"]))),
        "hasFlag" => {
            let flags = strings(&i["flags"]);
            let flags: Vec<&str> = flags.iter().map(String::as_str).collect();
            json!(has_flag(&strings(&i["args"]), &flags))
        }
        "toml" => match i.get("key") {
            None => json!(toml(&to_toml(&i["value"]))),
            Some(key) => {
                let mut env = Env::new();
                env.insert("CODEX_HOME".into(), text(&i["home"]).to_owned());
                optional(
                    codex_mount(&env)
                        .and_then(|mount| mount.get(text(key)).cloned())
                        .map(|value| toml(&value)),
                )
            }
        },
        "codexMount" => {
            optional(codex_mount(&env_of(&i["env"])).map(|mount| toml(&Toml::Table(mount))))
        }
        "codexOverrides" => {
            let env = env_of(&i["env"]);
            json!(codex_overrides(
                &env,
                codex_mount(&env).as_ref(),
                &self_words,
                bin_of(&env)
            ))
        }
        "codexOverrideAt" => json!(codex_override_at(&strings(&i["args"]))),
        "messagingAllow" => json!(messaging_allow(text(&i["harness"]), &strings(&i["args"]))),
        "harnessArgv" => {
            let env = env_of(&i["env"]);
            let probe = i["probe"].as_bool().unwrap();
            let context = Context {
                self_words: &self_words,
                mount: &codex_mount,
                bin: bin_of(&env),
                cwd: text(&i["cwd"]),
                probe: &|_, _| probe,
            };
            json!(harness_argv(&strings(&i["command"]), &env, &context))
        }
        "codexSkipsGitCheck" => json!(codex_skips_git_check(
            text(&i["program"]),
            &env_of(&i["env"])
        )),
        "inGit" => json!(in_git(text(&i["dir"]))),
        "museModes" => json!(muse_modes(&strings(&i["args"]))),
        "contributorRefusal" => optional(contributor_refusal(&strings(&i["command"]))),
        "museFirstRun" => optional(
            muse_first_run(&strings(&i["command"]), || {
                "00000000-0000-4000-8000-000000000000".to_owned()
            })
            .map(|(command, session)| json!({ "command": command, "session": session })),
        ),
        "museResumeBase" => optional(muse_resume_base(
            &strings(&i["command"]),
            text(&i["session"]),
        )),
        "museExec" => optional(muse_exec(&strings(&i["args"])).map(|run| {
            let options: Vec<Value> = run
                .options
                .iter()
                .map(|o| {
                    let mut option = json!({ "at": o.at, "size": o.size, "flag": o.flag });
                    if let Some(value) = &o.value {
                        option["value"] = json!(value);
                    }
                    option
                })
                .collect();
            let mut out = json!({ "exec": run.exec, "end": run.end, "options": options });
            if let Some(session) = &run.session {
                out["session"] = json!(session);
            }
            out
        })),
        "museOptionsEnd" => json!(muse_options_end(
            &strings(&i["args"]),
            i["start"].as_u64().unwrap() as usize
        )),
        "museModeAt" => json!(muse_mode_at(&strings(&i["args"]))),
        "closedStdin" => json!(closed_stdin(&strings(&i["command"]))),
        "codexExec" => optional(codex_exec(&strings(&i["args"])).map(|run| {
            let mut out = json!({ "exec": run.exec, "operands": run.operands });
            if let Some(sub) = &run.sub {
                out["sub"] = json!({ "name": sub.name, "at": sub.at });
            }
            if let Some(cd) = &run.cd {
                out["cd"] = json!(cd);
            }
            out
        })),
        "promptAt" => prompt_json(prompt_at(&strings(&i["command"]))),
        "resumeArgv" => optional(resume_argv(
            &strings(&i["command"]),
            text(&i["session"]),
            text(&i["prompt"]),
        )),
        "spawnPrompt" => optional(spawn_prompt(&strings(&i["command"]))),
        "steerArgv" => json!(steer_argv(&strings(&i["command"]), i.get("steer"))),
        "spawnTitle" => optional(spawn_title(&strings(&i["command"]))),
        "workerName" => json!(worker_name(&strings(&i["command"]), || "abcde".to_owned())),
        "splitSpawn" => {
            let (flags, command) = split_spawn(&strings(&i["args"]));
            json!({ "flags": flags, "command": command })
        }
        "spawnDefaults" => {
            let mut values = Parsed::default();
            for entry in i["values"].as_array().unwrap() {
                let value = match &entry[1] {
                    Value::Bool(on) => Val::Flag(*on),
                    other => Val::Text(text(other).to_owned()),
                };
                values.values.push((text(&entry[0]).to_owned(), value));
            }
            let out = spawn_defaults(&values, &strings(&i["command"]), || "abcde".to_owned());
            Value::from(
                out.values
                    .iter()
                    .map(|(k, v)| json!([k, v.to_json()]))
                    .collect::<Vec<_>>(),
            )
        }
        "handbackBytes" => match handback_bytes(text(&i["value"])) {
            Ok(bytes) => json!({ "ok": bytes }),
            Err(Fail::Usage(message)) => json!({ "error": message }),
            Err(other) => panic!("{other:?}"),
        },
        "agyNote" => optional(agy_note(
            &strings(&i["command"]),
            &env_of(&i["env"]),
            i.get("verb").map_or("spawn", text),
        )),
        "codexThread" => {
            let head = i["head"].as_object().map(|head| Head {
                out: bytes_of(&head["out"]),
                err: bytes_of(&head["err"]),
            });
            optional(codex_thread(&HarnessRun {
                head,
                ..HarnessRun::default()
            }))
        }
        "harnessOutput" => json!(harness_output(
            &HarnessRun {
                tail: bytes_of(&i["tail"]),
                cut: i["cut"].as_bool().unwrap(),
                ..HarnessRun::default()
            },
            opt_num(&i["bytes"])
        )),
        "stderrOutput" => json!(stderr_output(
            &HarnessRun {
                err: bytes_of(&i["err"]),
                err_cut: i["cut"].as_bool().unwrap(),
                ..HarnessRun::default()
            },
            i.get("bytes").and_then(opt_num)
        )),
        "transcriptReplies" => json!(transcript_replies(
            text(&i["path"]),
            text(&i["session"]),
            text(&i["root"]),
            i.get("bytes")
                .and_then(Value::as_u64)
                .unwrap_or(TRANSCRIPT_BYTES)
        )),
        "repliesOutput" => json!(replies_output(
            &strings(&i["replies"]),
            i.get("bytes").and_then(opt_num)
        )),
        "firstRun" => {
            let (command, session) = first_run(&strings(&i["command"]), || {
                "00000000-0000-4000-8000-000000000000".to_owned()
            });
            match session {
                Some(session) => json!({ "command": command, "session": session }),
                None => json!({ "command": command }),
            }
        }
        "resumeSession" => optional(resume_session(
            &strings(&i["command"]),
            i["session"].as_str(),
        )),
        "resumeBase" => optional(resume_base(&strings(&i["command"]), text(&i["session"]))),
        "durableRef" => json!({ "ref": durable_ref(
            text(&i["harness"]),
            text(&i["session"]),
            text(&i["cwd"]),
            &strings(&i["base"]),
            i.get("idle").map_or(f64::INFINITY, number),
            text(&i["parent"]),
            &env_of(&i["env"]),
        ) }),
        "refProblem" => optional(ref_problem(text(&i["ref"]))),
        "idleSeconds" => usage(idle_seconds(text(&i["value"])), seconds),
        "spawnIdle" => usage(
            spawn_idle(
                &parsed_of(&i["values"]),
                i["detached"].as_bool().unwrap(),
                number(&i["idleAfter"]),
            ),
            seconds,
        ),
        "spawnIdleAfterS" => {
            let env = env_of(&i["env"]);
            let found = idle_setting(&env, &config_file(&env), "SCP_SPAWN_IDLE_AFTER_S", "spawn");
            json!({ "ok": found.map_or(Value::Null, seconds) })
        }
        "framed" => json!(framed(i["messages"].as_array().unwrap())),
        "wokeBy" => optional(woke_by(i["messages"].as_array().unwrap())),
        "steerPrompt" => json!(steer_prompt(i["messages"].as_array().unwrap())),
        "readConversation" => optional(read_conversation(i["file"].as_str())),
        "holdClaim" => {
            let lineage = strings(&i["lineage"]);
            let env = env_of(&i["env"]);
            Value::Object(hold_claim(&HoldClaim {
                name: text(&i["name"]),
                harness: text(&i["harness"]),
                cwd: text(&i["cwd"]),
                session: text(&i["session"]),
                lineage: &lineage,
                grant: text(&i["grant"]),
                process: "<process>",
                env: &env,
            }))
        }
        "parseSpawn" => usage(parse_spawn(&strings(&i["args"])), |(values, command)| {
            let values: Vec<Value> = values
                .values
                .iter()
                .map(|(k, v)| json!([k, v.to_json()]))
                .collect();
            json!({ "values": values, "command": command })
        }),
        "durableCheck" => usage(
            durable_check(
                &parsed_of(&i["values"]),
                &strings(&i["command"]),
                text(&i["cwd"]),
                number(&i["idleAfter"]),
                &Env::new(),
            ),
            |()| Value::Null,
        ),
        "grantParams" => usage(grant_params(&parsed_of(&i["values"])), |params| {
            Value::from(
                params
                    .into_iter()
                    .map(|(k, v)| json!([k, v]))
                    .collect::<Vec<_>>(),
            )
        }),
        "spawnEnvironment" => {
            let grant = i["grant"].as_object().unwrap();
            let mut env: Vec<(String, String)> =
                spawn_environment(&env_of(&i["parent"]), grant, i["labels"].as_str())
                    .into_iter()
                    .collect();
            env.sort();
            Value::from(
                env.into_iter()
                    .map(|(k, v)| json!([k, v]))
                    .collect::<Vec<_>>(),
            )
        }
        other => panic!("no replay for {other}"),
    }
}

#[test]
fn spawn_matches_the_typescript_cli() {
    let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/spawn");
    let text = include_str!("fixtures/spawn.json").replace("<fixtures>", fixtures);
    let rows: Vec<Value> = serde_json::from_str(&text).expect("spawn.json");
    assert!(rows.len() > 150);
    let mut failed = Vec::new();
    for row in &rows {
        let name = row["fn"].as_str().unwrap();
        let got = replay(name, &row["input"]);
        let want = match name {
            "durableRef" => json!({ "ref": row["output"]["ref"] }),
            _ => row["output"].clone(),
        };
        if got != want {
            failed.push(format!(
                "{name} {}\n  got      {got}\n  expected {}",
                row["input"], row["output"]
            ));
        }
    }
    assert!(
        failed.is_empty(),
        "{} of {} cases differ:\n{}",
        failed.len(),
        rows.len(),
        failed.join("\n")
    );
}
