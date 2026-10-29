use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

fn daemon(experimental: Option<&str>) -> (Output, PathBuf) {
    let home = std::env::temp_dir().join(format!("scp-guard-{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&home).expect("home");
    let mut command = Command::new(env!("CARGO_BIN_EXE_scp-broker"));
    command
        .args(["daemon", "--idle", "0.2", "--policy"])
        .arg(home.join("policy.json"))
        .env_clear()
        .env("HOME", &home)
        .env("SCP_DIR", home.join("state/scp"))
        .stdin(Stdio::null());
    if let Some(value) = experimental {
        command.env("SCP_BROKER_EXPERIMENTAL", value);
    }
    let output = command.output().expect("run scp-broker");
    (output, home)
}

#[test]
fn refuses_to_start_without_the_experimental_flag() {
    for flag in [None, Some("0"), Some("true")] {
        let (output, home) = daemon(flag);
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let touched = home.join("state/scp").exists();
        std::fs::remove_dir_all(&home).ok();
        assert!(!output.status.success(), "started with {flag:?}");
        assert!(stderr.contains("SCP_BROKER_EXPERIMENTAL=1"), "{stderr}");
        assert!(stderr.contains("visibility"), "{stderr}");
        assert!(!touched, "created the relay directory with {flag:?}");
    }
}

#[test]
fn starts_with_the_experimental_flag() {
    let (output, home) = daemon(Some("1"));
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let listened = home.join("state/scp").exists();
    std::fs::remove_dir_all(&home).ok();
    assert!(output.status.success(), "{stderr}");
    assert!(listened, "never opened the relay directory");
}
