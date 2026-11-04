//! Running a harness as `runHarness` does: stdio inherited or teed, signals forwarded, its code and output kept for the handback.

use super::argv::program_at;
use super::muse::{LaunchFile, write_muse_launch};
use super::output::{HarnessRun, Head};
use super::signals::Listener;
use crate::open::errno_words;
use crate::{Fail, term};
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::CallError;
use scp_mcp::identity::MuseLaunch;
use scp_mcp::ps::{Env, basename, process_key, ps_start};
use std::cell::RefCell;
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::task::JoinSet;

const FORWARDED: [i32; 4] = [libc::SIGINT, libc::SIGQUIT, libc::SIGTERM, libc::SIGHUP];
/// how much of the harness's latest output a run keeps for its handback
const TAIL_BYTES: usize = 16 * 1024;
/// how much of the start of its output a run keeps
const HEAD_BYTES: usize = 4096;
/// how long after the harness exits its output may still drain, from a process it left holding the pipe
const DRAIN: Duration = Duration::from_secs(2);
const CHUNK: usize = 64 * 1024;
/// time for an agent shell's pipe to provide data before falling back to /dev/null
pub const STDIN_WAIT_MS: u64 = 300;

/// whether `fd` is a terminal
pub fn tty(fd: i32) -> bool {
    // SAFETY: isatty only inspects the descriptor
    unsafe { libc::isatty(fd) == 1 }
}

/// a pipe's first and last bytes
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Kept {
    pub head: Vec<u8>,
    pub tail: Vec<u8>,
    pub cut: bool,
}

impl Kept {
    pub fn add(&mut self, chunk: &[u8]) {
        if self.head.len() < HEAD_BYTES {
            let room = HEAD_BYTES - self.head.len();
            self.head.extend_from_slice(&chunk[..room.min(chunk.len())]);
        }
        self.tail.extend_from_slice(chunk);
        if self.tail.len() > TAIL_BYTES {
            self.tail.drain(..self.tail.len() - TAIL_BYTES);
            self.cut = true;
        }
    }
}

/// `bytes` on `fd` as is, failing quietly
fn write_fd(fd: i32, mut bytes: &[u8]) {
    while !bytes.is_empty() {
        // SAFETY: writes from a live slice of its own length
        let wrote = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if wrote > 0 {
            bytes = &bytes[wrote as usize..];
        } else if wrote == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR)
        {
            return;
        }
    }
}

/// whether a spawn note already waited out the drain on a reader that stopped reading, after which notes no longer wait
static GAVE_UP: AtomicBool = AtomicBool::new(false);

/// a spawn note on stderr, written off this thread and waited on for the drain at most, or not at all once a note ran out of it
pub fn note(message: &str) {
    let message = message.to_owned();
    bounded(&GAVE_UP, move || term::note(&message));
}

fn bounded(gave_up: &AtomicBool, write: impl FnOnce() + Send + 'static) {
    let wait = if gave_up.load(Ordering::Relaxed) {
        Duration::ZERO
    } else {
        DRAIN
    };
    let (done, written) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        write();
        let _ = done.send(());
    });
    if written.recv_timeout(wait).is_err() {
        gave_up.store(true, Ordering::Relaxed);
    }
}

/// writes on to stdout, stderr or `fd` off the runtime, returning when `bytes` were taken, so a slow reader holds back only its own pipe
async fn write_on(fd: i32, bytes: Vec<u8>) {
    let _ = tokio::task::spawn_blocking(move || match fd {
        1 => term::print_bytes(&bytes),
        2 => term::eprint_bytes(&bytes),
        fd => write_fd(fd, &bytes),
    })
    .await;
}

/// keeps what `from` gives in `kept` as it writes it on unchanged, waiting for each write, until the pipe ends
async fn tee(mut from: impl AsyncRead + Unpin, fd: i32, kept: Rc<RefCell<Kept>>) {
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let count = match from.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(count) => count,
        };
        kept.borrow_mut().add(&buffer[..count]);
        write_on(fd, buffer[..count].to_vec()).await;
    }
}

/// for a muse process `pid`, whose shim and hooks Muse starts without SCP_* variables: a launch file with the run's identity
fn muse_launch_file(argv: &[String], env: &Env, pid: Option<u32>) -> Option<LaunchFile> {
    let pid = i64::from(pid?);
    let program = argv.get(program_at(argv))?;
    let set = |key: &str| env.get(key).filter(|v| !v.is_empty()).cloned();
    let (name, grant, under) = (set("SCP_NAME"), set("SCP_GRANT"), set("SCP_UNDER"));
    if basename(program) != "muse" || (name.is_none() && grant.is_none() && under.is_none()) {
        return None;
    }
    let launcher = env
        .get("SCP_HARNESS_PID")
        .and_then(|text| text.trim().parse::<i64>().ok())
        .filter(|pid| *pid > 1)
        .map(|pid| process_key(pid, &ps_start));
    let launch = MuseLaunch {
        name,
        grant,
        under,
        session: set("SCP_SESSION"),
        launcher,
    };
    write_muse_launch(&process_key(pid, &ps_start), &launch, env).ok()
}

/// what a harness that did not start says, and its code
#[derive(Debug, Clone, PartialEq)]
pub struct Failed {
    pub message: String,
    pub code: i32,
}

/// a harness's stdin
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Input {
    #[default]
    Inherit,
    Ignore,
    /// the first chunk read while probing stdin, followed by the rest of it
    Piped(Vec<u8>),
}

impl Input {
    fn stdio(&self) -> Stdio {
        match self {
            Input::Inherit => Stdio::inherit(),
            Input::Ignore => Stdio::null(),
            Input::Piped(_) => Stdio::piped(),
        }
    }
}

/// told once the harness started, or why it did not
pub type Started<'a> = &'a mut dyn FnMut(Option<&Failed>);

/// how a run takes its stdio and what it tells of its start
#[derive(Default)]
pub struct RunOptions<'a> {
    /// keep stdout, by default when it is no terminal
    pub capture: Option<bool>,
    /// keep stderr, by default when it is no terminal
    pub capture_err: Option<bool>,
    pub stdin: Input,
    pub started: Option<Started<'a>>,
    /// lead a process group, without a terminal attached
    pub group: bool,
    /// where captured stdout and stderr go on to, by default 1 and 2
    pub to: Option<(i32, i32)>,
}

fn os_failure(program: &str, error: &std::io::Error) -> Failed {
    let enoent = error.raw_os_error() == Some(libc::ENOENT);
    let words = if enoent {
        "command not found".to_owned()
    } else {
        match errno_words(error) {
            Some((code, _)) => format!("spawn {program} {code}"),
            None => error.to_string(),
        }
    };
    Failed {
        message: format!("{CLI_NAME} spawn: {program}: {words}"),
        code: if enoent { 127 } else { 126 },
    }
}

/// `first`, then what stdin gives, into the harness's stdin, which ends with it
async fn feed(mut to: ChildStdin, first: Vec<u8>) {
    if to.write_all(&first).await.is_err() {
        return;
    }
    loop {
        let read = tokio::task::spawn_blocking(|| read_stdin(None)).await;
        let Ok(Some(chunk)) = read else {
            return;
        };
        if to.write_all(&chunk).await.is_err() {
            return;
        }
    }
}

fn deliver(signal: i32, pid: i32, group: bool, tty: bool) {
    if tty && matches!(signal, libc::SIGINT | libc::SIGQUIT) {
        return;
    }
    let target = if group { -pid } else { pid };
    // SAFETY: signals the child, which is not yet reaped, or its group
    unsafe { libc::kill(target, signal) };
}

/// Tee captured output, retain its tail and forward signals. Detached harnesses lead a process group; terminal Ctrl-C already reaches it.
pub async fn run_harness(
    argv: &[String],
    env: &Env,
    options: RunOptions<'_>,
) -> Result<HarnessRun, Fail> {
    let RunOptions {
        capture,
        capture_err,
        stdin,
        mut started,
        group,
        to,
    } = options;
    let (out_fd, err_fd) = to.unwrap_or((1, 2));
    if argv[0].is_empty() {
        return Err(Fail::Call(CallError::Io(
            "The argument 'file' cannot be empty. Received ''".into(),
        )));
    }
    let capture = capture.unwrap_or(!tty(1));
    let capture_err = capture_err.unwrap_or(!tty(2));
    let on_tty = tty(0);
    let group = group && !on_tty && !tty(1) && !tty(2);
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .env_clear()
        .envs(env)
        .stdin(stdin.stdio())
        .stdout(if capture {
            Stdio::piped()
        } else {
            Stdio::inherit()
        })
        .stderr(if capture_err {
            Stdio::piped()
        } else {
            Stdio::inherit()
        });
    // SAFETY: only async-signal-safe calls between fork and exec
    unsafe {
        command.pre_exec(move || {
            for signal in 1..32 {
                if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                    libc::signal(signal, libc::SIG_DFL);
                }
            }
            if group && libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut signals = Listener::new(&FORWARDED);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let failed = os_failure(&argv[0], &error);
            match started.as_mut() {
                Some(started) => started(Some(&failed)),
                None => note(&failed.message),
            }
            return Ok(HarnessRun {
                code: failed.code,
                head: Some(Head::default()),
                ..HarnessRun::default()
            });
        }
    };
    let pid = child.id().map_or(0, |pid| pid as i32);
    let launch_file = muse_launch_file(argv, env, child.id());
    let feeder = match (child.stdin.take(), stdin) {
        (Some(to), Input::Piped(first)) => Some(tokio::task::spawn_local(feed(to, first))),
        _ => None,
    };
    let out = Rc::new(RefCell::new(Kept::default()));
    let err = Rc::new(RefCell::new(Kept::default()));
    let mut tees = JoinSet::new();
    if let Some(pipe) = child.stdout.take() {
        tees.spawn_local(tee(pipe, out_fd, out.clone()));
    }
    if let Some(pipe) = child.stderr.take() {
        tees.spawn_local(tee(pipe, err_fd, err.clone()));
    }
    if let Some(started) = started.as_mut() {
        started(None);
    }
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            signal = signals.recv() => deliver(signal, pid, group, on_tty),
        }
    };
    let code = match status {
        Ok(status) => status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
        Err(_) => 1,
    };
    if let Some(file) = launch_file {
        file.remove();
    }
    let drained = async { while tees.join_next().await.is_some() {} };
    if tokio::time::timeout(DRAIN, drained).await.is_err() {
        tees.abort_all();
        while tees.join_next().await.is_some() {}
    }
    if let Some(feeder) = feeder {
        feeder.abort();
    }
    let (out, err) = (out.borrow(), err.borrow());
    Ok(HarnessRun {
        code,
        tail: out.tail.clone(),
        cut: out.cut,
        err: err.tail.clone(),
        err_cut: err.cut,
        head: Some(Head {
            out: out.head.clone(),
            err: err.head.clone(),
        }),
        started: true,
    })
}

/// one chunk of stdin once it has one, waiting at most `wait_ms`; None at its end, on a failure or when the wait ran out, nothing taken then
fn read_stdin(wait_ms: Option<u64>) -> Option<Vec<u8>> {
    let deadline = wait_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    let mut poll = libc::pollfd {
        fd: 0,
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        let timeout = deadline.map_or(-1, |at| {
            at.saturating_duration_since(Instant::now())
                .as_millis()
                .min(i32::MAX as u128) as i32
        });
        // SAFETY: one pollfd it owns
        let ready = unsafe { libc::poll(&mut poll, 1, timeout) };
        if ready == 0 {
            return None;
        }
        if ready < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return None;
        }
        let mut chunk = vec![0u8; CHUNK];
        // SAFETY: reads into a live buffer of its length
        let count = unsafe { libc::read(0, chunk.as_mut_ptr().cast(), chunk.len()) };
        if count > 0 {
            chunk.truncate(count as usize);
            return Some(chunk);
        }
        let again = matches!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EINTR | libc::EAGAIN)
        );
        if count == 0 || !again {
            return None;
        }
    }
}

/// Inherit a nonempty file, forward a pipe with data, or use /dev/null for empty or idle input.
pub async fn harness_stdin(wait_ms: Option<u64>) -> Input {
    if tty(0) {
        return Input::Ignore;
    }
    let mut stat = std::mem::MaybeUninit::<libc::stat>::zeroed();
    // SAFETY: fstat fills the struct it is given
    if unsafe { libc::fstat(0, stat.as_mut_ptr()) } != 0 {
        return Input::Ignore;
    }
    // SAFETY: fstat succeeded, so the struct is filled
    let stat = unsafe { stat.assume_init() };
    match stat.st_mode & libc::S_IFMT {
        libc::S_IFREG if stat.st_size > 0 => Input::Inherit,
        libc::S_IFIFO | libc::S_IFSOCK => {
            match tokio::task::spawn_blocking(move || read_stdin(wait_ms)).await {
                Ok(Some(first)) => Input::Piped(first),
                _ => Input::Ignore,
            }
        }
        _ => Input::Ignore,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pipe_keeps_its_first_and_last_bytes() {
        let mut kept = Kept::default();
        kept.add(&[1; 3000]);
        kept.add(&[2; 3000]);
        assert_eq!(kept.head.len(), HEAD_BYTES);
        assert_eq!(kept.head[2999..3001], [1, 2]);
        assert!(!kept.cut);
        kept.add(&[3; TAIL_BYTES]);
        assert!(kept.cut);
        assert_eq!(kept.tail, vec![3; TAIL_BYTES]);
        assert_eq!(kept.head.len(), HEAD_BYTES);
    }

    /// a pipe whose write end is full and whose read end nobody reads
    fn full_pipe() -> [i32; 2] {
        let mut fds = [0; 2];
        // SAFETY: a fresh pipe, filled through a nonblocking write end that is made blocking again
        unsafe {
            assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
            let flags = libc::fcntl(fds[1], libc::F_GETFL);
            libc::fcntl(fds[1], libc::F_SETFL, flags | libc::O_NONBLOCK);
            let chunk = [0u8; 4096];
            while libc::write(fds[1], chunk.as_ptr().cast(), chunk.len()) > 0 {}
            libc::fcntl(fds[1], libc::F_SETFL, flags);
        }
        fds
    }

    #[test]
    fn a_reader_that_never_reads_holds_the_handback_for_the_drain_only() {
        let _signals = crate::spawn::signals::tests::SERIAL.lock();
        let fds = full_pipe();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let local = tokio::task::LocalSet::new();
        let argv: Vec<String> = ["sh", "-c", "head -c 5000 /dev/zero >&2; echo out; exit 3"]
            .iter()
            .map(|w| (*w).to_owned())
            .collect();
        let env: Env = std::env::vars().collect();
        let started = Instant::now();
        let run = local.block_on(&runtime, async {
            let options = RunOptions {
                capture: Some(true),
                capture_err: Some(true),
                stdin: Input::Ignore,
                to: Some((fds[1], fds[1])),
                ..RunOptions::default()
            };
            tokio::time::timeout(Duration::from_secs(20), run_harness(&argv, &env, options)).await
        });
        let run = run.expect("the drain is bounded").unwrap();
        let took = started.elapsed();
        assert!(
            took >= DRAIN && took < DRAIN + Duration::from_secs(5),
            "{took:?}"
        );
        assert_eq!(run.code, 3);
        assert_eq!(run.err.len(), 5000);
        drop(local);
        runtime.shutdown_background();
        // SAFETY: closes the pipe opened above
        unsafe {
            libc::close(fds[0]);
            libc::close(fds[1]);
        }
    }

    #[test]
    fn a_note_waits_on_a_reader_that_stopped_for_the_drain_once_then_not_at_all() {
        let fds = full_pipe();
        let gave_up = AtomicBool::new(false);
        let (wrote, written) = std::sync::mpsc::channel();
        bounded(&gave_up, move || wrote.send(()).unwrap());
        assert!(written.try_recv().is_ok());
        assert!(!gave_up.load(Ordering::Relaxed));
        let write = move || write_fd(fds[1], b"note\n");
        let started = Instant::now();
        bounded(&gave_up, write);
        let took = started.elapsed();
        assert!(
            took >= DRAIN && took < DRAIN + Duration::from_secs(2),
            "{took:?}"
        );
        assert!(gave_up.load(Ordering::Relaxed));
        let started = Instant::now();
        bounded(&gave_up, write);
        assert!(started.elapsed() < Duration::from_millis(500));
        // SAFETY: closes the read end, which fails the writes still blocked on the pipe
        unsafe { libc::close(fds[0]) };
    }

    #[test]
    fn a_failed_start_says_why_as_the_cli_does() {
        let gone = std::io::Error::from_raw_os_error(libc::ENOENT);
        assert_eq!(
            os_failure("nope", &gone),
            Failed {
                message: "swarm spawn: nope: command not found".into(),
                code: 127
            }
        );
        let denied = std::io::Error::from_raw_os_error(libc::EACCES);
        assert_eq!(
            os_failure("/tmp", &denied),
            Failed {
                message: "swarm spawn: /tmp: spawn /tmp EACCES".into(),
                code: 126
            }
        );
    }
}
