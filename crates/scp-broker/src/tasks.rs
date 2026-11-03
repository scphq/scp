//! The broker's periodic task, the CLI's claude-bg policy: one `<cli> claude-bg-task` process per interval, never two at once.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::time::Instant;

pub const CLAUDE_BG_EVERY: Duration = Duration::from_secs(120);
const RUN_LIMIT: Duration = Duration::from_secs(600);
const OUTPUT_MAX: u64 = 64 * 1024;

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

/// runs the task every `every` from one interval after the start; a run still going when the next is due skips it
pub fn attach(task: Task, running: TaskPid) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut due = Instant::now() + task.every;
        let mut failure = None;
        loop {
            tokio::time::sleep_until(due).await;
            run(&task, &running, &mut failure).await;
            let now = Instant::now();
            while due <= now {
                due += task.every;
            }
        }
    })
}

/// one run; its stderr goes to the broker's, except a failure the same as the last one
async fn run(task: &Task, running: &TaskPid, failure: &mut Option<String>) {
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
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    let (ok, output) = match command.spawn() {
        Err(error) => (false, format!("{program} did not start ({error})")),
        Ok(mut child) => {
            running.set(child.id().unwrap_or(0));
            let mut group = crate::wake::Group(child.id().and_then(|pid| i32::try_from(pid).ok()));
            let mut stderr = child.stderr.take();
            let read = async {
                let mut out = Vec::new();
                if let Some(stderr) = stderr.as_mut() {
                    let _ = (&mut *stderr).take(OUTPUT_MAX).read_to_end(&mut out).await;
                    let _ = tokio::io::copy(stderr, &mut tokio::io::sink()).await;
                }
                out
            };
            let ran =
                tokio::time::timeout(RUN_LIMIT, async { tokio::join!(child.wait(), read) }).await;
            running.set(0);
            if matches!(ran, Ok((Ok(_), _))) {
                group.0 = None;
            }
            match ran {
                Err(_) => {
                    let _ = child.kill().await;
                    (
                        false,
                        format!("still running after {} s, stopped", RUN_LIMIT.as_secs()),
                    )
                }
                Ok((status, out)) => {
                    let text = String::from_utf8_lossy(&out).trim_end().to_owned();
                    match status {
                        Ok(status) if status.success() => (true, text),
                        Ok(status) if text.is_empty() => (false, format!("{status}")),
                        Ok(_) => (false, text),
                        Err(error) => (false, error.to_string()),
                    }
                }
            }
        }
    };
    if ok {
        *failure = None;
        if !output.is_empty() {
            eprintln!("{output}");
        }
    } else if failure.as_deref() != Some(output.as_str()) {
        eprintln!("relay broker: task claude-bg failed: {output}");
        *failure = Some(output);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("scp-tasks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn task(dir: &std::path::Path, script: &str, every_ms: u64) -> Task {
        Task {
            cli: vec!["/bin/sh".into(), "-c".into(), script.into(), "sh".into()],
            dir: dir.to_path_buf(),
            env: BTreeMap::from([("KEPT".to_owned(), "yes".to_owned())]),
            every: Duration::from_millis(every_ms),
        }
    }

    #[tokio::test]
    async fn runs_start_on_the_interval_with_the_relay_directory_and_a_long_run_skips_the_next() {
        let dir = scratch("runs");
        let script = r#"echo "$1 $KEPT" >> "$SCP_DIR/runs"; sleep 0.25"#;
        let running = TaskPid::default();
        let started = Instant::now();
        let handle = attach(task(&dir, script, 200), running.clone());
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(running.0.load(Ordering::Relaxed) != 0);
        tokio::time::sleep(Duration::from_millis(600)).await;
        handle.abort();
        let _ = handle.await;
        assert!(started.elapsed() < Duration::from_millis(1300));
        let runs = std::fs::read_to_string(dir.join("runs")).unwrap();
        assert_eq!(runs.lines().count(), 2, "{runs}");
        assert!(
            runs.lines().all(|line| line == "claude-bg-task yes"),
            "{runs}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_failure_like_the_last_one_is_not_logged_again() {
        let dir = scratch("failure");
        let mut failure = None;
        let running = TaskPid::default();
        run(
            &task(&dir, "echo broken >&2; exit 3", 1),
            &running,
            &mut failure,
        )
        .await;
        assert_eq!(failure.as_deref(), Some("broken"));
        run(&task(&dir, "exit 3", 1), &running, &mut failure).await;
        assert_eq!(failure.as_deref(), Some("exit status: 3"));
        run(&task(&dir, "echo fine >&2", 1), &running, &mut failure).await;
        assert_eq!(failure, None);
        let mut missing = task(&dir, "", 1);
        missing.cli = vec![dir.join("nothing").display().to_string()];
        run(&missing, &running, &mut failure).await;
        assert!(
            failure
                .as_deref()
                .is_some_and(|f| f.contains("did not start"))
        );
        assert!(!running.is(Some(0)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn stopping_the_runner_stops_the_run_and_what_it_started() {
        let dir = scratch("stop");
        let handle = attach(
            task(&dir, r#"sleep 30 & echo $! > "$SCP_DIR/pid"; wait"#, 50),
            TaskPid::default(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        let pid = loop {
            assert!(Instant::now() < deadline, "the run never started");
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Some(pid) = std::fs::read_to_string(dir.join("pid"))
                .ok()
                .and_then(|t| t.trim().parse::<i32>().ok())
            {
                break pid;
            }
        };
        handle.abort();
        let _ = handle.await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        // SAFETY: signal 0 only checks that the process exists
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
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
