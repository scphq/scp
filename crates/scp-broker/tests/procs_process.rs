use scp_broker::procs::{Procs, parse_starts};

#[test]
fn parses_reference_process_table_format() {
    let starts = parse_starts(
        "    42 Thu Oct  9 10:00:00 2026  \n 12 Thu-Oct-9-10:00:00-2026\ninvalid\n8 !bad\n9\n",
    );
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[&42], "Thu-Oct-9-10:00:00-2026");
    assert_eq!(starts[&12], starts[&42]);
}

#[tokio::test]
async fn current_process_matches_reference_key_and_recycled_key_is_dead() {
    let procs = Procs::new();
    let pid = std::process::id();
    let starts = procs.start_times(&[pid]).await;
    let direct = tokio::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .output()
        .await
        .expect("ps");
    assert!(direct.status.success());
    let expected = String::from_utf8(direct.stdout)
        .expect("C locale")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    assert_eq!(starts[&pid], expected);
    assert!(procs.alive(&format!("pid:{pid}:{expected}")).await);
    assert!(procs.alive(&format!("pid:{pid}")).await);
    assert!(
        !procs
            .alive(&format!("pid:{pid}:Mon-Jan-1-00:00:00-1900"))
            .await
    );
    assert!(!procs.alive("pid:2147483647:Mon-Jan-1-00:00:00-1900").await);
    assert!(procs.alive("env:session").await);
    assert!(procs.alive("pid:0").await);
    assert!(!procs.alive("pid:999999999999999999999").await);
    assert!(procs.alive("pid:42:invalid!key").await);
}

#[tokio::test]
async fn an_exited_child_is_not_alive() {
    let procs = Procs::new();
    let mut child = tokio::process::Command::new("sleep")
        .arg("30")
        .kill_on_drop(true)
        .spawn()
        .expect("child");
    let pid = child.id().expect("pid");
    let starts = procs.start_times(&[pid]).await;
    let key = format!("pid:{pid}:{}", starts[&pid]);
    assert!(procs.alive(&key).await);
    child.kill().await.expect("stop child");
    child.wait().await.expect("reap child");
    assert!(!procs.alive(&key).await);
}
