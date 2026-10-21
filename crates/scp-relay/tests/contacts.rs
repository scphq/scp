use serde_json::{Value, json};
use std::{path::PathBuf, process::Command};

#[test]
fn contact_console_transitions_and_validation() {
    let base = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"));
    std::fs::create_dir_all(&base).unwrap();
    let path = base.join(format!("contacts-{}.db", rand::random::<u64>()));
    let url = format!("sqlite://{}", path.display());
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_scp-relay"))
            .args(["--store", &url])
            .args(args)
            .output()
            .unwrap()
    };
    for account in ["alpha", "beta"] {
        assert!(run(&["account", "create", account]).status.success());
    }
    let output = run(&["contact", "invite", "absent", "--account", "alpha"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unknown peer: absent"));
    assert!(output.stdout.is_empty());
    let output = run(&["contact", "invite", "beta", "--account", "absent"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("unknown account: absent"));
    for (action, account, peer, state) in [
        ("invite", "alpha", "beta", json!("pending_out")),
        ("accept", "beta", "alpha", json!("active")),
        ("update", "alpha", "beta", json!("active")),
        ("revoke", "alpha", "beta", Value::Null),
        ("block", "beta", "alpha", json!("blocked")),
        ("invite", "alpha", "beta", Value::Null),
    ] {
        let mut args = vec!["contact", action, peer, "--account", account];
        if action == "update" {
            args.extend([
                "--allow",
                r#"[{"machine":"*","sel":"tree:root"}]"#,
                "--dir",
                "in",
                "--limits",
                r#"{"per_minute":2}"#,
            ]);
        }
        let output = run(&args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let line = String::from_utf8(output.stdout).unwrap();
        assert_eq!(line.lines().count(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap(),
            json!({"account":account,"peer":peer,"state":state})
        );
    }
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}
