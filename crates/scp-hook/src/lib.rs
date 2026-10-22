pub mod process;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

struct Fd(i32);
impl Write for Fd {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = unsafe { libc::write(self.0, bytes.as_ptr().cast(), bytes.len()) };
        if count < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(count as usize)
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub const STDIN_CAP: u64 = 8 * 1024 * 1024;
pub const LINE_LIMIT: usize = 245760;
const DAEMON_ENV: &[&str] = &[
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "SCP_IDLE",
    "HOME",
    "XDG_CONFIG_HOME",
    "SCP_TOKEN",
    "SCP_RELAY",
    "SCP_MACHINE",
    "CODEX_HOME",
    "SCP_CODEX_BIN",
    "SCP_OPEN_BIN",
    "SCP_LSOF_BIN",
    "SCP_FUSER_BIN",
];

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn parse_argv(args: &[String]) -> Option<(&[String], &[String])> {
    let index = args.iter().position(|arg| arg == "hook")?;
    Some((&args[..index], &args[index + 1..]))
}

pub fn cowork_live(env: &HashMap<String, String>) -> bool {
    env.get("CLAUDE_CODE_IS_COWORK").is_some_and(|v| v == "1")
        || env
            .get("CLAUDE_CODE_ENTRYPOINT")
            .is_some_and(|v| v == "remote_cowork")
}

pub fn subagent_skip(args: &[String], raw: &[u8]) -> bool {
    args.iter().any(|a| a == "--subagent")
        && !raw.windows(10).any(|s| s == b"\"agent_id\"")
        && !raw.windows(9).any(|s| s == b"\"agentId\"")
}

pub fn hook_ends(agy: bool, origin: u64, loaded: u64) -> u64 {
    if agy {
        (origin + 3500).min(loaded + 900)
    } else {
        origin + 3500
    }
}

pub fn connect_budget(ends: u64, time: u64) -> u64 {
    ends.saturating_sub(time).saturating_sub(1000).min(2500)
}

fn nonempty<'a>(env: &'a HashMap<String, String>, key: &str) -> Option<&'a String> {
    env.get(key).filter(|s| !s.is_empty())
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => (),
            Component::ParentDir => {
                if result.file_name().is_some_and(|name| name != "..") {
                    result.pop();
                } else if !path.is_absolute() {
                    result.push("..");
                }
            }
            _ => result.push(part),
        }
    }
    if result.as_os_str().is_empty() {
        result.push(".");
    }
    result
}

pub fn relay_dir(env: &HashMap<String, String>) -> PathBuf {
    if let Some(dir) = nonempty(env, "SCP_DIR") {
        return PathBuf::from(dir);
    }
    let state = nonempty(env, "XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(
                nonempty(env, "HOME")
                    .cloned()
                    .or_else(process::home)
                    .unwrap_or_default(),
            )
            .join(".local/state")
        });
    normalize(&state.join("scp"))
}

pub fn socket_path(dir: &Path, uid: u32) -> PathBuf {
    let inside = normalize(&dir.join("relay.sock"));
    if inside.as_os_str().as_encoded_bytes().len() <= 100 {
        return inside;
    }
    let hash = Sha256::digest(dir.as_os_str().as_encoded_bytes());
    let key = hash[..6]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    PathBuf::from(format!("/tmp/scp-{uid}-{key}/relay.sock"))
}

pub fn shrink(value: &Value, cut: usize) -> Value {
    match value {
        Value::String(s) => Value::String(s.chars().take(cut).collect()),
        Value::Array(a) => Value::Array(a.iter().take(64).map(|v| shrink(v, cut)).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, v)| (k.clone(), shrink(v, cut))).collect())
        }
        _ => value.clone(),
    }
}

pub fn hook_frame(mut params: Value) -> Value {
    let original = params["payload"].clone();
    let frame = |p: Value| json!({"jsonrpc":"2.0","id":2,"method":"hook","params":p});
    if encoded_len(&frame(params.clone())) <= LINE_LIMIT {
        return frame(params);
    }
    for cut in [8192, 1024, 128] {
        params["payload"] = shrink(&original, cut);
        if encoded_len(&frame(params.clone())) <= LINE_LIMIT {
            return frame(params);
        }
    }
    params["payload"] = Value::Object(
        original
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, v)| match v {
                Value::String(s) => s.chars().count() <= 128,
                Value::Null | Value::Bool(_) | Value::Number(_) => true,
                _ => false,
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    );
    frame(params)
}

fn encoded_len(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |s| s.len() + 1)
}

struct State {
    ends: u64,
    printed: bool,
    attempted: bool,
    child: Option<i32>,
}
#[derive(Clone)]
pub struct Deadline {
    shared: Arc<(Mutex<State>, Condvar)>,
    agy: bool,
}

impl Deadline {
    pub fn new(ends: u64, agy: bool) -> Self {
        Self {
            shared: Arc::new((
                Mutex::new(State {
                    ends,
                    printed: false,
                    attempted: false,
                    child: None,
                }),
                Condvar::new(),
            )),
            agy,
        }
    }
    pub fn ends(&self) -> u64 {
        self.shared.0.lock().unwrap_or_else(|e| e.into_inner()).ends
    }
    pub fn move_to(&self, ends: u64) {
        self.shared.0.lock().unwrap_or_else(|e| e.into_inner()).ends = ends;
        self.shared.1.notify_all();
    }
    pub fn watchdog(&self) {
        let deadline = self.clone();
        std::thread::spawn(move || {
            let (mutex, condvar) = &*deadline.shared;
            let mut state = mutex.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                let left = state.ends.saturating_sub(now());
                if left == 0 {
                    if let Some(pid) = state.child {
                        unsafe {
                            libc::kill(pid, libc::SIGKILL);
                        }
                    }
                    if !state.attempted && deadline.agy {
                        let _ = Fd(1).write_all(b"{}\n");
                    }
                    unsafe {
                        libc::_exit(0);
                    }
                }
                state = condvar
                    .wait_timeout(state, Duration::from_millis(left))
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
        });
    }
    pub fn print(&self, text: Option<&str>) -> bool {
        let mut state = self.shared.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.attempted {
            return false;
        }
        state.attempted = true;
        let text = if now() >= state.ends { None } else { text };
        let text = text
            .filter(|s| !s.is_empty())
            .or(if self.agy { Some("{}") } else { None });
        if let Some(text) = text {
            drop(state);
            let printed = Fd(1).write_all(format!("{text}\n").as_bytes()).is_ok();
            self.shared
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .printed = printed;
            return printed;
        }
        state.printed
    }
}

fn private_dir(path: &Path, create: bool) -> io::Result<()> {
    if create {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir()
        || meta.uid() != unsafe { libc::getuid() }
        || (!create && meta.mode() & 0o022 != 0)
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "untrusted relay directory",
        ));
    }
    if create {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn start_daemon(dir: &Path, launcher: &[String], env: &HashMap<String, String>) -> io::Result<()> {
    let Some(program) = launcher.first() else {
        return Err(io::Error::other("no launcher"));
    };
    private_dir(dir, true)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(dir.join("broker.log"))?;
    if log.metadata()?.len() > 1024 * 1024 {
        log.set_len(0)?;
    }
    let mut cmd = Command::new(program);
    cmd.args(&launcher[1..])
        .arg("daemon")
        .env_clear()
        .env("SCP_DIR", dir)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    for key in DAEMON_ENV {
        if let Some(value) = env.get(*key) {
            cmd.env(key, value);
        }
    }
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn broker_live(dir: &Path) -> bool {
    let Ok(content) = fs::read_to_string(dir.join("broker.lock")) else {
        return false;
    };
    let mut fields = content.trim().split(':');
    let Some(pid) = fields
        .next()
        .and_then(|v| v.parse::<i32>().ok())
        .filter(|pid| *pid > 0)
    else {
        return false;
    };
    if let Some(started) = fields.next().and_then(|v| v.parse::<u64>().ok()) {
        #[cfg(target_os = "macos")]
        let boot = {
            let mut boot = unsafe { std::mem::zeroed::<libc::timeval>() };
            let mut size = std::mem::size_of_val(&boot);
            let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
            if unsafe {
                libc::sysctl(
                    mib.as_mut_ptr(),
                    2,
                    (&mut boot as *mut libc::timeval).cast(),
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                )
            } == 0
            {
                boot.tv_sec as u64
            } else {
                0
            }
        };
        #[cfg(target_os = "linux")]
        let boot = fs::read_to_string("/proc/stat")
            .ok()
            .and_then(|s| {
                s.lines()
                    .find_map(|l| l.strip_prefix("btime ").and_then(|v| v.parse::<u64>().ok()))
            })
            .unwrap_or(0);
        if started < boot.saturating_sub(60) {
            return false;
        }
    }
    unsafe {
        libc::kill(pid, 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

fn timed_connect(path: &Path, until: u64) -> io::Result<UnixStream> {
    let mut addr = unsafe { std::mem::zeroed::<libc::sockaddr_un>() };
    let bytes = path.as_os_str().as_encoded_bytes();
    if bytes.len() >= addr.sun_path.len() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in addr.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    let size =
        (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as libc::socklen_t;
    #[cfg(target_os = "macos")]
    {
        addr.sun_len = size as u8;
    }
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    unsafe {
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
    }
    stream.set_nonblocking(true)?;
    if unsafe { libc::connect(fd, (&addr as *const libc::sockaddr_un).cast(), size) } < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(error);
        }
        loop {
            let mut poll = libc::pollfd {
                fd: stream.as_raw_fd(),
                events: libc::POLLOUT,
                revents: 0,
            };
            let left = until.saturating_sub(now()).min(i32::MAX as u64) as i32;
            let count = unsafe { libc::poll(&mut poll, 1, left) };
            if count == 0 {
                return Err(io::ErrorKind::TimedOut.into());
            }
            if count < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(io::Error::last_os_error());
            }
            if let Some(error) = stream.take_error()? {
                return Err(error);
            }
            break;
        }
    }
    stream.set_nonblocking(false)?;
    Ok(stream)
}

fn error_code(error: &io::Error) -> &'static str {
    match error.raw_os_error() {
        Some(libc::EPERM) => "EPERM",
        Some(libc::EACCES) => "EACCES",
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::EAGAIN) => "EAGAIN",
        Some(libc::ECONNREFUSED) => "ECONNREFUSED",
        _ => "refused",
    }
}

fn warning(message: &str) {
    let _ = writeln!(
        io::stderr(),
        "swarm hook: relay broker unreachable, hook skipped: {message}"
    );
}

fn connect(
    dir: &Path,
    launcher: &[String],
    env: &HashMap<String, String>,
    start: bool,
    deadline: &Deadline,
) -> io::Result<UnixStream> {
    let path = socket_path(dir, unsafe { libc::getuid() });
    let budget = connect_budget(deadline.ends(), now());
    let until = now() + budget;
    let mut started = false;
    let mut attempt = 0;
    loop {
        let error = match timed_connect(&path, until) {
            Ok(stream) => {
                private_dir(path.parent().unwrap_or(Path::new(".")), false)?;
                return Ok(stream);
            }
            Err(error) => error,
        };
        let code = error_code(&error);
        let live = broker_live(dir);
        if ["EPERM", "EACCES"].contains(&code)
            || (live
                && ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"]
                    .iter()
                    .any(|k| nonempty(env, k).is_some())
                && code != "ENOENT")
        {
            warning(&format!(
                "the sandbox blocks the relay socket ({code}); allow {} or run outside the sandbox",
                path.display()
            ));
            return Err(error);
        }
        if !live && !started {
            if !start {
                return Err(error);
            }
            start_daemon(dir, launcher, env)?;
            started = true;
        }
        let left = until.saturating_sub(now());
        if left == 0 || (live && !["ECONNREFUSED", "EAGAIN", "ENOENT"].contains(&code)) {
            if live {
                warning(&format!(
                    "the relay broker is running but did not accept a connection within {budget} ms ({code}): it is busy; swarm status shows it"
                ));
            }
            return Err(error);
        }
        let base = (50u64 << attempt.min(3)).min(400);
        let jitter = u64::from(std::process::id()) ^ now();
        std::thread::sleep(Duration::from_millis(
            (base + jitter % (base / 2 + 1)).min(400).min(left),
        ));
        attempt += 1;
    }
}

struct Rpc {
    reader: BufReader<UnixStream>,
    deadline: Deadline,
}
impl Rpc {
    fn send(&mut self, frame: &Value) -> io::Result<()> {
        let left = self.deadline.ends().saturating_sub(now());
        if left == 0 {
            return Err(io::ErrorKind::TimedOut.into());
        }
        self.reader
            .get_mut()
            .set_write_timeout(Some(Duration::from_millis(left)))?;
        let mut bytes = serde_json::to_vec(frame)?;
        bytes.push(b'\n');
        self.reader.get_mut().write_all(&bytes)
    }
    fn response(&mut self, id: u64) -> io::Result<Value> {
        loop {
            let left = self.deadline.ends().saturating_sub(now());
            if left == 0 {
                return Err(io::ErrorKind::TimedOut.into());
            }
            self.reader
                .get_mut()
                .set_read_timeout(Some(Duration::from_millis(left)))?;
            let mut bytes = Vec::new();
            let size = (&mut self.reader)
                .take(64 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut bytes)?;
            if size == 0 || size > 64 * 1024 * 1024 || bytes.last() != Some(&b'\n') {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            if bytes.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            let frame: Value = serde_json::from_slice(&bytes)?;
            if frame["method"] == "hook_deadline" {
                if let Some(ends) = frame["params"]["ends"].as_u64() {
                    self.deadline.move_to(ends);
                }
            } else if frame["id"].as_u64() == Some(id) {
                return frame
                    .get("result")
                    .cloned()
                    .ok_or_else(|| io::Error::other("RPC error"));
            }
        }
    }
}

fn fallback(
    launcher: &[String],
    args: &[String],
    raw: Vec<u8>,
    deadline: &Deadline,
) -> io::Result<()> {
    let Some(program) = launcher.first() else {
        return Ok(());
    };
    let mut child = Command::new(program)
        .args(&launcher[1..])
        .arg("hook")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    if let Some(mut input) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = input.write_all(&raw);
        });
    }
    deadline
        .shared
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .child = Some(child.id() as i32);
    let forwarding = child.stdout.take().map(|mut output| {
        let deadline = deadline.clone();
        std::thread::spawn(move || {
            let mut bytes = [0u8; 8192];
            loop {
                match output.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        deadline
                            .shared
                            .0
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .attempted = true;
                        let _ = Fd(1).write_all(&bytes[..n]);
                    }
                }
            }
        })
    });
    loop {
        if child.try_wait()?.is_some() {
            deadline
                .shared
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .child = None;
            if let Some(thread) = forwarding {
                let _ = thread.join();
            }
            deadline.print(None);
            return Ok(());
        }
        if now() >= deadline.ends() {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub fn run(origin: u64, argv: &[String]) -> io::Result<()> {
    let Some((launcher, args)) = parse_argv(argv) else {
        return Ok(());
    };
    let env: HashMap<String, String> = std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect();
    if args.iter().any(|a| a == "--cowork-only") && !cowork_live(&env) {
        return Ok(());
    }
    let agy = args.first().is_some_and(|a| a == "agy");
    let deadline = Deadline::new(hook_ends(agy, origin, now()), agy);
    deadline.watchdog();
    let mut raw = Vec::new();
    if let Err(error) = io::stdin().take(STDIN_CAP).read_to_end(&mut raw) {
        deadline.print(None);
        return Err(error);
    }
    if subagent_skip(args, &raw) {
        return Ok(());
    }
    if env.get("SCP_ENGINE").is_some_and(|s| s == "ts") {
        let result = fallback(launcher, args, raw, &deadline);
        deadline.print(None);
        return result;
    }
    let result = run_rpc(origin, launcher, args, raw, &env, &deadline);
    deadline.print(None);
    result
}

pub fn session_start(args: &[String], payload: &Value, env: &HashMap<String, String>) -> bool {
    if env.get("SCP_TRANSPORT").is_some_and(|s| s == "cloud")
        || args.iter().any(|s| s == "--subagent")
    {
        return false;
    }
    if let Some(index) = args.iter().position(|s| s == "--wake")
        && args
            .get(index + 1)
            .and_then(|s| s.parse::<f64>().ok())
            .is_some_and(|n| n.is_finite() && n > 0.0)
    {
        return false;
    }
    let positional: Vec<_> = args
        .iter()
        .enumerate()
        .filter(|(i, arg)| {
            ![
                "--cowork-only",
                "--block-stop-on-unread",
                "--no-inject",
                "--subagent",
                "--push-wait",
                "--wake",
            ]
            .contains(&arg.as_str())
                && !i
                    .checked_sub(1)
                    .is_some_and(|prev| ["--push-wait", "--wake"].contains(&args[prev].as_str()))
        })
        .map(|(_, s)| s)
        .collect();
    let named = payload
        .get("hook_event_name")
        .filter(|v| !v.is_null())
        .or_else(|| payload.get("hookEventName"));
    let event = named
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| positional.get(1).map(|s| s.as_str()))
        .unwrap_or("");
    event
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .eq_ignore_ascii_case("sessionstart")
}

fn run_rpc(
    origin: u64,
    launcher: &[String],
    args: &[String],
    raw: Vec<u8>,
    env: &HashMap<String, String>,
    deadline: &Deadline,
) -> io::Result<()> {
    let mut payload: Value = serde_json::from_slice(&raw).unwrap_or(json!({}));
    if !payload.is_object() {
        payload = json!({});
    }
    let ppid = unsafe { libc::getppid() };
    let procs = process::collect(ppid, env);
    let dir = relay_dir(env);
    let start = session_start(args, &payload, env)
        && !(env
            .get("CLAUDE_CODE_ENTRYPOINT")
            .is_some_and(|s| s == "remote_cowork")
            && !dir.exists());
    let stream = connect(&dir, launcher, env, start, deadline)?;
    let mut rpc = Rpc {
        reader: BufReader::new(stream),
        deadline: deadline.clone(),
    };
    rpc.send(&json!({"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":"scp/1","observe":true}}))?;
    let hello = rpc.response(1)?;
    if !hello["capabilities"]
        .as_array()
        .is_some_and(|a| a.iter().any(|c| c == "hook"))
    {
        drop(rpc);
        return fallback(launcher, args, raw, deadline);
    }
    let names: Vec<String> = serde_json::from_str(include_str!(
        "../../../packages/spec/schema/broker/hook-env.json"
    ))?;
    let filtered: HashMap<_, _> = env.iter().filter(|(k, _)| names.contains(k)).collect();
    let mut params = json!({"args":args,"payload":payload,"env":filtered,"origin":origin,"ends":deadline.ends(),"ppid":ppid,"procs":procs});
    if let Some(cwd) = std::env::current_dir()
        .ok()
        .and_then(|cwd| cwd.to_str().map(str::to_owned))
    {
        params["cwd"] = json!(cwd);
    }
    rpc.send(&hook_frame(params))?;
    let result = rpc.response(2)?;
    if let Some(stderr) = result["stderr"].as_str().filter(|s| !s.is_empty()) {
        let _ = writeln!(io::stderr(), "{}", stderr.lines().next().unwrap_or(""));
    }
    let stdout = result["stdout"].as_str().filter(|s| !s.is_empty());
    let printed = deadline.print(stdout);
    if printed
        && stdout.is_some()
        && now() < deadline.ends()
        && let Some(commit) = result["commit"].as_str()
    {
        rpc.send(
            &json!({"jsonrpc":"2.0","id":3,"method":"hook_commit","params":{"commit":commit}}),
        )?;
        rpc.response(3)?;
    }
    Ok(())
}
