//! The broker's periodic task, the CLI's claude-bg policy: one `<cli> claude-bg-task` process per interval, never two at once.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tokio::time::{Instant, MissedTickBehavior};

pub const CLAUDE_BG_EVERY: Duration = Duration::from_secs(120);
const RUN_LIMIT: Duration = Duration::from_secs(600);

/// the pid of the task process that runs now, 0 when none: its connections do not keep the broker from going idle
#[derive(Clone, Default)]
pub struct TaskPid(Arc<AtomicU32>);

impl TaskPid {
    pub fn is(&self, pid: Option<i32>) -> bool {
        let running = self.0.load(Ordering::Relaxed);
        running != 0 && pid.is_some_and(|pid| u32::try_from(pid).ok() == Some(running))
    }

    fn set(&self, pid: u32) {
        self.0.store(pid, Ordering::Relaxed);
    }
}

pub struct Task {
    pub cli: Vec<String>,
    pub dir: PathBuf,
    pub env: BTreeMap<String, String>,
    pub every: Duration,
}

/// runs the task every `every`, the first run one interval after the start, a run still going when the next is due skipping it
pub fn attach(task: Task, running: TaskPid) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval_at(Instant::now() + task.every, task.every);
        every.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut failed = false;
        loop {
            every.tick().await;
            run(&task, &running, &mut failed).await;
        }
    })
}

async fn run(task: &Task, running: &TaskPid, failed: &mut bool) {
    let Some((program, args)) = task.cli.split_first() else {
        return;
    };
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .arg("claude-bg-task")
        .env_clear()
        .envs(&task.env)
        .env("SCP_DIR", &task.dir)
        .current_dir(&task.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if !std::mem::replace(failed, true) {
                eprintln!("relay broker: task claude-bg failed: {program} did not start ({error})");
            }
            return;
        }
    };
    *failed = false;
    running.set(child.id().unwrap_or(0));
    if tokio::time::timeout(RUN_LIMIT, child.wait()).await.is_err() {
        let _ = child.kill().await;
        eprintln!(
            "relay broker: task claude-bg failed: still running after {} s, stopped",
            RUN_LIMIT.as_secs()
        );
    }
    running.set(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn each_run_starts_the_cli_task_in_the_relay_directory_one_at_a_time() {
        let dir = std::env::temp_dir().join(format!("scp-tasks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let script = r#"echo "$1 $SCP_DIR $(pwd) $KEPT" >> runs; sleep 0.3"#;
        let running = TaskPid::default();
        let handle = attach(
            Task {
                cli: vec!["/bin/sh".into(), "-c".into(), script.into(), "sh".into()],
                dir: dir.clone(),
                env: BTreeMap::from([("KEPT".to_owned(), "yes".to_owned())]),
                every: Duration::from_millis(100),
            },
            running.clone(),
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(running.0.load(Ordering::Relaxed) != 0);
        tokio::time::sleep(Duration::from_millis(600)).await;
        handle.abort();
        let _ = handle.await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let runs = std::fs::read_to_string(dir.join("runs")).unwrap();
        let lines: Vec<_> = runs.lines().collect();
        let shown = dir.display();
        assert!((2..=3).contains(&lines.len()), "{runs}");
        assert!(
            lines
                .iter()
                .all(|line| *line == format!("claude-bg-task {shown} {shown} yes")),
            "{runs}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_the_running_task_pid_matches() {
        let running = TaskPid::default();
        assert!(!running.is(Some(0)) && !running.is(None));
        running.set(42);
        assert!(running.is(Some(42)) && !running.is(Some(43)) && !running.is(None));
    }
}
