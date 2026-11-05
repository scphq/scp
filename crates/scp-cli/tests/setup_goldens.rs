//! The native hooks install and mcp install against goldens the TypeScript generators wrote (`bun scripts/setup-goldens.ts`).

use scp_cli::Fail;
use scp_cli::fleet::json::Json;
use scp_cli::setup::hook_cmd::{
    HookLaunch, HookOptions, agy_hook_set, hook_argv, hook_client, hook_command, hook_entries,
    merge_hooks, muse_plugin, opencode_plugin, shell_quote, shell_words,
};
use scp_cli::setup::hooks_install::{
    InstallOptions, hook_content, install_hooks, launcher_prefixes,
};
use scp_cli::setup::mcp_install::mcp_install;
use scp_cli::spawn::argv::{Mount, mount_vars, mount_with, pin_mode};
use scp_mcp::client::CallError;
use scp_mcp::ps::Env;
use serde_json::Value;
use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::{Once, OnceLock};

fn goldens() -> &'static Value {
    static GOLDENS: OnceLock<Value> = OnceLock::new();
    static UTC: Once = Once::new();
    UTC.call_once(|| {
        // SAFETY: the first thing any test here does, under the Once, before any of them reads a local time
        unsafe { std::env::set_var("TZ", "UTC") };
    });
    GOLDENS.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/setup.json")).expect("setup.json")
    })
}

fn json(value: &Value) -> Json {
    Json::parse(value.to_string().as_bytes()).expect("json")
}

fn strs(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|w| w.as_str().unwrap().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn launch(value: &Value) -> HookLaunch {
    HookLaunch {
        launcher: value.get("launcher").map(strs),
        native: value
            .get("native")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

fn options(value: &Value) -> HookOptions {
    HookOptions {
        block_stop: value["blockStop"].as_bool() == Some(true),
        push_wait: value["pushWait"].as_u64().map(|w| w as u32),
        cowork: value["cowork"].as_bool() == Some(true),
        launch: launch(value),
    }
}

fn env(value: &Value) -> Env {
    value
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                .collect()
        })
        .unwrap_or_default()
}

fn text(json: &Json) -> String {
    format!("{}\n", json.pretty())
}

fn client(found: Option<(String, bool)>) -> Value {
    match found {
        Some((bin, guarded)) => serde_json::json!({ "bin": bin, "guarded": guarded }),
        None => Value::Null,
    }
}

fn words_value(words: Option<Vec<(String, bool)>>) -> Value {
    match words {
        Some(words) => Value::Array(
            words
                .into_iter()
                .map(|(text, quoted)| serde_json::json!({ "text": text, "quoted": quoted }))
                .collect(),
        ),
        None => Value::Null,
    }
}

fn fail_message(fail: Fail) -> String {
    match fail {
        Fail::Usage(message) | Fail::Call(CallError::Io(message)) => message,
        other => panic!("unexpected failure {other:?}"),
    }
}

/// the same normalization the golden script applies to messages an engine words its own way
fn normalize(message: &str) -> String {
    if message.contains("is not iterable") || message.contains("Spread syntax") {
        return "<not iterable>".into();
    }
    let message = message.replace("Cannot convert object to primitive value", "<no primitive>");
    let message = message.as_str();
    match (message.find("is not valid JSON ("), message.rfind(')')) {
        (Some(at), Some(end)) if end > at => format!(
            "{}is not valid JSON (<parse error>){}",
            &message[..at],
            &message[end + 1..]
        ),
        _ => message.to_owned(),
    }
}

#[test]
fn shell_quoting_and_words_match() {
    for case in goldens()["quote"].as_array().unwrap() {
        let word = case["word"].as_str().unwrap();
        let quoted = shell_quote(word);
        assert_eq!(quoted, case["quoted"].as_str().unwrap(), "{word:?}");
        assert_eq!(words_value(shell_words(&quoted)), case["words"], "{word:?}");
    }
    for case in goldens()["words"].as_array().unwrap() {
        let command = case["command"].as_str().unwrap();
        assert_eq!(
            words_value(shell_words(command)),
            case["words"],
            "{command:?}"
        );
    }
}

#[test]
fn hook_commands_argv_and_clients_match() {
    for case in goldens()["launches"].as_array().unwrap() {
        let launch = launch(&case["launch"]);
        let command = hook_command(
            &launch,
            &strs(&serde_json::json!(["hook", "claude", "--subagent"])),
        );
        assert_eq!(command, case["command"].as_str().unwrap());
        let argv = hook_argv(&launch, &strs(&serde_json::json!(["hook", "muse", "Stop"])));
        assert_eq!(argv, strs(&case["argv"]));
        assert_eq!(
            client(hook_client(&Json::str(command.as_str()))),
            case["client"]
        );
        let argv = Json::Arr(argv.iter().map(|w| Json::str(w.as_str())).collect());
        assert_eq!(client(hook_client(&argv)), case["argvClient"]);
        assert_eq!(launcher_prefixes(&launch), strs(&case["prefixes"]));
    }
}

#[test]
fn hook_files_match() {
    let g = goldens();
    for case in g["entries"].as_array().unwrap() {
        let harness = case["harness"].as_str().unwrap();
        assert_eq!(
            text(&hook_entries(harness, &options(&case["options"]))),
            case["text"].as_str().unwrap(),
            "{case}"
        );
    }
    for case in g["agy"].as_array().unwrap() {
        let set = agy_hook_set(
            case["blockStop"].as_bool().unwrap(),
            &launch(&case["launch"]),
        );
        assert_eq!(text(&set), case["text"].as_str().unwrap());
    }
    for case in g["muse"].as_array().unwrap() {
        assert_eq!(
            text(&muse_plugin(&options(&case["options"]))),
            case["text"].as_str().unwrap()
        );
    }
    for case in g["opencode"].as_array().unwrap() {
        let plugin = opencode_plugin(
            case["blockStop"].as_bool().unwrap(),
            &launch(&case["launch"]),
        );
        assert_eq!(plugin, case["text"].as_str().unwrap(), "{}", case["launch"]);
    }
}

#[test]
fn merges_keep_other_hooks_and_replace_ours() {
    let g = goldens();
    let handlers = strs(&g["handlers"]);
    for case in g["ours"].as_array().unwrap() {
        let prefixes = strs(&case["prefixes"]);
        let kept: Vec<bool> = handlers
            .iter()
            .map(|command| {
                let settings = json(&serde_json::json!({ "hooks": { "E": [{ "hooks": [{ "type": "command", "command": command }] }] } }));
                let merged = merge_hooks(&settings, &Json::Obj(Vec::new()), &prefixes).unwrap();
                merged.get("hooks").unwrap().get("E").is_some()
            })
            .collect();
        let want: Vec<bool> = case["kept"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_bool().unwrap())
            .collect();
        for ((command, got), want) in handlers.iter().zip(&kept).zip(&want) {
            assert_eq!(got, want, "{command:?} under {prefixes:?}");
        }
    }
    let entries = hook_entries("claude", &HookOptions::default());
    for case in g["merges"].as_array().unwrap() {
        let settings = Json::parse(case["text"].as_str().unwrap().as_bytes()).unwrap();
        let got = merge_hooks(&settings, &entries, &strs(&case["prefixes"]));
        match (&case["out"], got) {
            (Value::String(want), Ok(merged)) => {
                assert_eq!(&text(&merged), want, "{}", case["text"])
            }
            (Value::Null, Err(error)) => {
                assert_eq!(normalize(&error), case["error"].as_str().unwrap())
            }
            (want, got) => panic!("{}: want {want}, got {got:?}", case["text"]),
        }
    }
}

#[test]
fn setup_hook_content_matches() {
    for case in goldens()["contents"].as_array().unwrap() {
        let got = hook_content(
            case["kind"].as_str().unwrap(),
            case["existing"].as_str(),
            case["blockStop"].as_bool().unwrap(),
            &launch(&case["launch"]),
        );
        match (&case["out"], got) {
            (Value::String(want), Ok(content)) => assert_eq!(&content, want, "{case}"),
            (Value::Null, Err(_)) => assert_eq!(case["error"], true),
            (want, got) => panic!("{case}: want {want}, got {got:?}"),
        }
    }
}

struct Snapshot {
    files: BTreeMap<String, String>,
    modes: BTreeMap<String, u32>,
    links: BTreeMap<String, String>,
}

fn snapshot(root: &Path) -> Snapshot {
    fn walk(dir: &Path, rel: &str, into: &mut Snapshot) {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for name in names {
            if name == ".git" {
                continue;
            }
            let path = dir.join(&name);
            let at = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let meta = std::fs::symlink_metadata(&path).unwrap();
            if meta.file_type().is_symlink() {
                into.links.insert(
                    at,
                    std::fs::read_link(&path)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                );
            } else if meta.is_dir() {
                walk(&path, &at, into);
            } else {
                into.files
                    .insert(at.clone(), std::fs::read_to_string(&path).unwrap());
                into.modes.insert(at, meta.permissions().mode() & 0o777);
            }
        }
    }
    let mut snap = Snapshot {
        files: BTreeMap::new(),
        modes: BTreeMap::new(),
        links: BTreeMap::new(),
    };
    walk(root, "", &mut snap);
    snap
}

fn scratch() -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!(
        "setup-goldens-{}-{}",
        std::process::id(),
        rand_suffix()
    ));
    std::fs::create_dir_all(&base).unwrap();
    base.canonicalize().unwrap()
}

fn rand_suffix() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

#[test]
fn install_lines_and_files_match_in_scratch_homes() {
    let g = goldens();
    let now_s = g["now"].as_i64().unwrap() / 1000;
    for spec in g["scenarios"].as_array().unwrap() {
        let name = spec["name"].as_str().unwrap();
        let root = scratch();
        let at = |rel: &str| root.join(rel);
        std::fs::create_dir_all(at("proj/.git")).unwrap();
        for dir in strs(&spec["dirs"]) {
            std::fs::create_dir_all(at(&dir)).unwrap();
        }
        for (rel, content) in spec["files"].as_object().into_iter().flatten() {
            std::fs::create_dir_all(at(rel).parent().unwrap()).unwrap();
            std::fs::write(at(rel), content.as_str().unwrap()).unwrap();
        }
        for (rel, mode) in spec["modes"].as_object().into_iter().flatten() {
            std::fs::set_permissions(
                at(rel),
                std::fs::Permissions::from_mode(mode.as_u64().unwrap() as u32),
            )
            .unwrap();
        }
        for (rel, to) in spec["links"].as_object().into_iter().flatten() {
            std::fs::create_dir_all(at(rel).parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(to.as_str().unwrap(), at(rel)).unwrap();
        }
        let root_text = root.to_string_lossy().into_owned();
        let strip = |text: &str| text.replace(&root_text, "<root>");
        for case in spec["runs"].as_array().unwrap() {
            let run = &case["run"];
            let mut vars: Env = [
                ("HOME", root_text.clone()),
                ("CLAUDE_CONFIG_DIR", format!("{root_text}/.claude")),
                ("CODEX_HOME", format!("{root_text}/.codex")),
                ("XDG_CONFIG_HOME", format!("{root_text}/.config")),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect();
            for (key, value) in env(&run["env"]) {
                vars.insert(key, value.replace("<root>", &root_text));
            }
            let options = InstallOptions {
                harness: run["harness"].as_str().map(str::to_owned),
                scope: run["scope"].as_str().map(str::to_owned),
                write: run["write"].as_bool() == Some(true),
                block_stop: run["blockStop"].as_bool() == Some(true),
                push_wait: run["pushWait"].as_f64(),
            };
            let cwd = at(run["cwd"].as_str().unwrap_or("proj"))
                .to_string_lossy()
                .into_owned();
            let mut lines = Vec::new();
            let done = install_hooks(&options, &vars, &cwd, now_s, &mut |line| {
                lines.push(strip(&line))
            });
            let error = done
                .err()
                .map(|fail| strip(&normalize(&fail_message(fail))));
            assert_eq!(lines, strs(&case["lines"]), "{name}: {run}");
            assert_eq!(error.as_deref(), case["error"].as_str(), "{name}: {run}");
            let snap = snapshot(&root);
            let want_files: BTreeMap<String, String> = case["files"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                .collect();
            for (file, want) in &want_files {
                assert_eq!(snap.files.get(file), Some(want), "{name}: {run}: {file}");
            }
            assert_eq!(
                snap.files.keys().collect::<Vec<_>>(),
                want_files.keys().collect::<Vec<_>>(),
                "{name}: {run}"
            );
            let want_modes: BTreeMap<String, u32> = case["modes"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_u64().unwrap() as u32))
                .collect();
            assert_eq!(snap.modes, want_modes, "{name}: {run}");
            let want_links: BTreeMap<String, String> = case["links"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                .collect();
            assert_eq!(snap.links, want_links, "{name}: {run}");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}

#[test]
fn mcp_install_lines_match() {
    for case in goldens()["mcp"].as_array().unwrap() {
        let got = mcp_install(case["harness"].as_str(), case["name"].as_str());
        match got {
            Ok(lines) => {
                assert_eq!(lines, strs(&case["lines"]), "{case}");
                assert!(case["error"].is_null(), "{case}");
            }
            Err(fail) => assert_eq!(
                fail_message(fail),
                case["error"].as_str().unwrap(),
                "{case}"
            ),
        }
    }
}

fn parsed(value: &Value) -> Json {
    Json::parse(value.as_str().unwrap().as_bytes()).expect("json text")
}

fn mount_text(mount: &Mount) -> String {
    let vars = Json::Obj(
        mount
            .env
            .iter()
            .map(|(k, v)| (k.clone(), Json::str(v.as_str())))
            .collect(),
    );
    let argv = Json::Arr(mount.argv.iter().map(|w| Json::str(w.as_str())).collect());
    Json::object(vec![
        ("argv", argv),
        ("env", vars),
        ("native", Json::Bool(mount.native)),
    ])
    .compact()
}

fn mount(value: &Value) -> Mount {
    let value = parsed(value);
    Mount {
        argv: value
            .get("argv")
            .unwrap()
            .items()
            .iter()
            .map(|w| w.as_str().unwrap().to_owned())
            .collect(),
        env: value
            .get("env")
            .unwrap()
            .entries()
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.as_str().unwrap().to_owned()))
            .collect(),
        native: value.get("native") == Some(&Json::Bool(true)),
    }
}

#[test]
fn mount_builders_match() {
    let g = goldens();
    let launch = strs(&serde_json::json!(["/usr/bin/node", "/x/cli.js"]));
    let words = strs(&serde_json::json!(["--harness", "claude", "--channels"]));
    for case in g["mounts"].as_array().unwrap() {
        let got = mount_with(case["bin"].as_str(), &launch, &words, &env(&case["env"]));
        assert_eq!(mount_text(&got), case["mount"].as_str().unwrap(), "{case}");
    }
    for case in g["vars"].as_array().unwrap() {
        let got = mount_vars(&parsed(&case["vars"]), &mount(&case["mount"]));
        assert_eq!(got.compact(), case["out"].as_str().unwrap(), "{case}");
    }
    for case in g["pins"].as_array().unwrap() {
        let got = pin_mode(&parsed(&case["vars"]), &env(&case["env"]));
        assert_eq!(got.compact(), case["out"].as_str().unwrap(), "{case}");
    }
}
