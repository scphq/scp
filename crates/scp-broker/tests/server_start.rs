use std::process::{Command, Stdio};

#[test]
fn starts_without_an_opt_in_flag() {
    let home = std::env::temp_dir().join(format!("scp-start-{:016x}", rand::random::<u64>()));
    std::fs::create_dir_all(&home).expect("home");
    let output = Command::new(env!("CARGO_BIN_EXE_scp-broker"))
        .args(["daemon", "--idle", "0.2", "--policy"])
        .arg(home.join("policy.json"))
        .env_clear()
        .env("HOME", &home)
        .env("SCP_DIR", home.join("state/scp"))
        .stdin(Stdio::null())
        .output()
        .expect("run scp-broker");
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let listened = home.join("state/scp").exists();
    std::fs::remove_dir_all(&home).ok();
    assert!(output.status.success(), "{stderr}");
    assert!(listened, "never opened the relay directory");
}
