//! The spawn wakers against the frozen hold-ref and codex-thread-lock fixtures.

use scp_cli::fleet::json::Json;
use scp_cli::spawn::codex_queue::codex_lock_path;
use scp_cli::spawn::wake::parse_hold_ref;
use scp_mcp::identity::codex_thread;
use scp_mcp::ps::Env;
use std::path::{Path, PathBuf};

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
fn hold_refs_parse_as_spawn_wrote_them_and_rewrite_as_json_stringify_does() {
    let files = fixtures("hold-ref");
    assert!(files.len() > 5);
    for (name, text) in files {
        match parse_hold_ref(Some(&text)) {
            None => assert!(name.starts_with("invalid-"), "{name}"),
            Some(reference) => {
                assert!(!name.starts_with("invalid-"), "{name}");
                let compact = Json::parse(text.as_bytes()).unwrap().compact();
                assert_eq!(reference.text(), compact, "{name}");
            }
        }
    }
}

#[test]
fn a_lock_names_a_thread_only_by_a_uuid() {
    let env = Env::from([("CODEX_HOME".to_owned(), "/c".to_owned())]);
    for (name, text) in fixtures("codex-thread-lock") {
        let thread = text.trim().strip_suffix(".lock").unwrap_or_default();
        assert_eq!(
            codex_thread(thread),
            !name.starts_with("invalid-"),
            "{name}"
        );
        if codex_thread(thread) {
            assert_eq!(
                codex_lock_path(thread, &env),
                format!("/c/thread-writer-locks/{}", text.trim())
            );
        }
    }
}
