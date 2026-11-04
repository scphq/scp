//! One NDJSON JSON-RPC connection to the local broker.

use crate::tools::{get, js};
use scp_core::protocol::{CLI_NAME, PROTOCOL};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{mpsc, oneshot};

/// a broker refusal (`code: message`) or a transport failure
#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    Relay {
        code: String,
        message: String,
        retry_after_s: Option<f64>,
    },
    Io(String),
}

impl CallError {
    pub fn relay(code: &str, message: impl Into<String>) -> Self {
        CallError::Relay {
            code: code.into(),
            message: message.into(),
            retry_after_s: None,
        }
    }

    /// what an Error's `message` says
    pub fn message(&self) -> &str {
        match self {
            CallError::Relay { message, .. } | CallError::Io(message) => message,
        }
    }

    pub fn is_relay(&self) -> bool {
        matches!(self, CallError::Relay { .. })
    }
}

/// the broker's longest request line, in bytes
pub const MAX_LINE: usize = 256 * 1024;
/// the longest line the broker may send back
const READ_CAP: usize = 64 * 1024 * 1024;
const CLOSED: &str = "the relay broker closed the connection";

type Reply = oneshot::Sender<Result<Value, CallError>>;

struct Inner {
    next_id: Cell<u64>,
    pending: RefCell<HashMap<u64, Reply>>,
    closed: RefCell<Option<String>>,
    writer: RefCell<Option<mpsc::UnboundedSender<Vec<u8>>>>,
}

impl Inner {
    fn fail(&self, error: &str) {
        self.writer.borrow_mut().take();
        if self.closed.borrow().is_some() {
            return;
        }
        *self.closed.borrow_mut() = Some(error.to_string());
        let pending: Vec<Reply> = self
            .pending
            .borrow_mut()
            .drain()
            .map(|(_, reply)| reply)
            .collect();
        for reply in pending {
            let _ = reply.send(Err(CallError::Io(error.to_string())));
        }
    }

    fn dispatch(&self, line: &[u8]) -> Result<(), &'static str> {
        let message: Value = serde_json::from_slice(line)
            .map_err(|_| "the relay broker sent a line that is not JSON")?;
        if crate::tools::truthy(get(&message, "method")) {
            return Ok(());
        }
        let Some(id) = get(&message, "id").and_then(Value::as_u64) else {
            return Ok(());
        };
        let Some(reply) = self.pending.borrow_mut().remove(&id) else {
            return Ok(());
        };
        let result = match get(&message, "error").filter(|e| crate::tools::truthy(Some(e))) {
            Some(error) => {
                let data = get(error, "data");
                let code = match data.and_then(|d| get(d, "code")) {
                    None | Some(Value::Null) => "invalid_params".to_string(),
                    code => js(code),
                };
                Err(CallError::Relay {
                    code,
                    message: js(get(error, "message")),
                    retry_after_s: data
                        .and_then(|d| get(d, "retry_after"))
                        .and_then(Value::as_f64),
                })
            }
            None => Ok(get(&message, "result").cloned().unwrap_or(Value::Null)),
        };
        let _ = reply.send(result);
        Ok(())
    }
}

/// one connection to the broker; needs a tokio LocalSet, which runs its reader and writer
pub struct Client {
    inner: Rc<Inner>,
}

impl Client {
    /// a connection to the socket at `path`, as is
    pub async fn connect(path: &Path) -> Result<Client, CallError> {
        Self::open(path)
            .await
            .map_err(|error| CallError::Io(connect_error(&error, path)))
    }

    async fn open(path: &Path) -> io::Result<Client> {
        let stream = UnixStream::connect(path).await?;
        let (read, write) = stream.into_split();
        let (tx, rx) = mpsc::unbounded_channel();
        let inner = Rc::new(Inner {
            next_id: Cell::new(1),
            pending: RefCell::new(HashMap::new()),
            closed: RefCell::new(None),
            writer: RefCell::new(Some(tx)),
        });
        tokio::task::spawn_local(read_loop(inner.clone(), read));
        tokio::task::spawn_local(write_loop(inner.clone(), write, rx));
        Ok(Client { inner })
    }

    /// whether the connection is closed, by either side
    pub fn closed(&self) -> bool {
        self.inner.closed.borrow().is_some()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, CallError> {
        if let Some(error) = self.inner.closed.borrow().clone() {
            return Err(CallError::Io(error));
        }
        let id = self.inner.next_id.get();
        self.inner.next_id.set(id + 1);
        let mut line =
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
        if line.len() > MAX_LINE {
            return Err(CallError::relay(
                "too_large",
                format!(
                    "the request is {} bytes as JSON, over the broker's {MAX_LINE} byte line limit (control characters count 6 bytes each once escaped)",
                    line.len()
                ),
            ));
        }
        line.push('\n');
        let (tx, rx) = oneshot::channel();
        self.inner.pending.borrow_mut().insert(id, tx);
        let sent = self
            .inner
            .writer
            .borrow()
            .as_ref()
            .is_some_and(|writer| writer.send(line.into_bytes()).is_ok());
        if !sent {
            self.inner.pending.borrow_mut().remove(&id);
            return Err(CallError::Io(
                "the connection to the relay broker is closed".into(),
            ));
        }
        rx.await
            .unwrap_or_else(|_| Err(CallError::Io(CLOSED.into())))
    }

    /// `hello` with the protocol and no capabilities, then `fields`
    pub async fn hello(&self, fields: Map<String, Value>) -> Result<Value, CallError> {
        let mut params = Map::new();
        params.insert("protocol".into(), PROTOCOL.into());
        params.insert("capabilities".into(), json!([]));
        params.extend(fields);
        self.request("hello", Value::Object(params)).await
    }

    /// ends the connection once what was written is flushed
    pub fn close(&self) {
        self.inner.writer.borrow_mut().take();
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.close();
    }
}

async fn read_loop(inner: Rc<Inner>, mut read: OwnedReadHalf) {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = match read.read(&mut chunk).await {
            Ok(0) => return inner.fail(CLOSED),
            Ok(n) => n,
            Err(error) => return inner.fail(&error.to_string()),
        };
        let start = buffer.len();
        buffer.extend_from_slice(&chunk[..n]);
        let mut from = 0;
        let mut scan = start;
        while let Some(at) = buffer[scan..].iter().position(|b| *b == b'\n') {
            let end = scan + at;
            if end - from > READ_CAP {
                return inner.fail("the relay broker sent a line over the size cap");
            }
            let line = &buffer[from..end];
            if !line.iter().all(u8::is_ascii_whitespace)
                && let Err(error) = inner.dispatch(line)
            {
                return inner.fail(error);
            }
            from = end + 1;
            scan = from;
        }
        buffer.drain(..from);
        if buffer.len() > READ_CAP {
            return inner.fail("the relay broker sent a line over the size cap");
        }
    }
}

async fn write_loop(
    inner: Rc<Inner>,
    mut write: OwnedWriteHalf,
    mut lines: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    while let Some(line) = lines.recv().await {
        if let Err(error) = write.write_all(&line).await {
            inner.fail(&error.to_string());
            return;
        }
    }
    let _ = write.shutdown().await;
}

fn errno_code(error: &io::Error) -> Option<&'static str> {
    Some(match error.raw_os_error()? {
        libc::EPERM => "EPERM",
        libc::EACCES => "EACCES",
        libc::ENOENT => "ENOENT",
        libc::EAGAIN => "EAGAIN",
        libc::ECONNREFUSED => "ECONNREFUSED",
        libc::ENOTSOCK => "ENOTSOCK",
        libc::ENOTDIR => "ENOTDIR",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::ECONNRESET => "ECONNRESET",
        libc::EADDRNOTAVAIL => "EADDRNOTAVAIL",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::EINVAL => "EINVAL",
        _ => return None,
    })
}

/// a failed connect as Node words it: `connect ENOENT <path>`
fn connect_error(error: &io::Error, path: &Path) -> String {
    match errno_code(error) {
        Some(code) => format!("connect {code} {}", path.display()),
        None => error.to_string(),
    }
}

/// `path` with `.` and `..` resolved lexically, as `path.resolve` does
pub fn normalize(path: &Path) -> PathBuf {
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

/// `$SCP_DIR`, else `$XDG_STATE_HOME/scp`, else ~/.local/state/scp
pub fn relay_dir(env: &HashMap<String, String>) -> PathBuf {
    let nonempty = |key: &str| env.get(key).filter(|v| !v.is_empty()).cloned();
    if let Some(dir) = nonempty("SCP_DIR") {
        return PathBuf::from(dir);
    }
    let state = nonempty("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = nonempty("HOME")
                .map(PathBuf::from)
                .or_else(std::env::home_dir)
                .unwrap_or_default();
            home.join(".local/state")
        });
    normalize(&state.join("scp"))
}

/// the broker's socket: inside the relay dir unless that is too long for a unix socket, then a per-user, per-dir directory under /tmp
pub fn socket_path(dir: &Path) -> PathBuf {
    let inside = normalize(&dir.join("relay.sock"));
    if inside.as_os_str().as_encoded_bytes().len() <= 100 {
        return inside;
    }
    let hash = Sha256::digest(dir.as_os_str().as_encoded_bytes());
    // SAFETY: getuid cannot fail
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!(
        "/tmp/scp-{uid}-{}/relay.sock",
        hex::encode(&hash[..6])
    ))
}

/// whether `path` is a directory of this user's, not a link, that nobody else may write: where a socket can be trusted
pub fn own_private_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| {
        // SAFETY: getuid cannot fail
        meta.is_dir()
            && meta.uid() == unsafe { libc::getuid() }
            && meta.permissions().mode() & 0o022 == 0
    })
}

fn boot_time() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut boot = libc::timeval {
            tv_sec: 0,
            tv_usec: 0,
        };
        let mut size = std::mem::size_of_val(&boot);
        let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
        // SAFETY: sysctl writes at most `size` bytes into `boot`
        let done = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                (&mut boot as *mut libc::timeval).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if done == 0 { boot.tv_sec as u64 } else { 0 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        fs::read_to_string("/proc/stat")
            .ok()
            .and_then(|s| {
                s.lines().find_map(|l| {
                    l.strip_prefix("btime ")
                        .and_then(|v| v.trim().parse::<u64>().ok())
                })
            })
            .unwrap_or(0)
    }
}

/// whether the broker for `dir` runs: its lock names a live process that took it since this boot
fn broker_live(dir: &Path) -> bool {
    let Ok(content) = fs::read_to_string(dir.join("broker.lock")) else {
        return false;
    };
    let mut fields = content.split(':');
    let Some(pid) = fields
        .next()
        .and_then(|v| v.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0)
    else {
        return false;
    };
    if let Some(started) = fields.next().and_then(|v| v.trim().parse::<u64>().ok())
        && started < boot_time().saturating_sub(60)
    {
        return false;
    }
    // SAFETY: signal 0 only probes the process
    unsafe {
        libc::kill(pid, 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// how long a connect keeps trying: a busy or restarting broker, or one it started
pub const CONNECT_BUDGET_MS: u64 = 12_000;
const RETRY_MIN_MS: f64 = 50.0;
const RETRY_MAX_MS: f64 = 400.0;
/// what a full listen backlog or a broker restarting between unlink and listen answers
const TRANSIENT: [&str; 3] = ["ECONNREFUSED", "EAGAIN", "ENOENT"];
/// environment markers of a sandbox that may refuse unix sockets
const SANDBOX_MARKERS: [&str; 2] = ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"];

/// the pause before try `attempt + 1`: doubling from the least, up to half again in jitter, never above the most or `left`
pub fn retry_delay(attempt: u32, left: f64, random: f64) -> f64 {
    let base = RETRY_MAX_MS.min(RETRY_MIN_MS * 2f64.powi(attempt.min(16) as i32));
    left.min(RETRY_MAX_MS)
        .min(base * (1.0 + random / 2.0))
        .max(0.0)
}

/// a connection to the broker for `dir`, starting it once with `start` when it is not running
pub async fn connect_broker(dir: &Path, start: Option<Rc<dyn Fn()>>) -> Result<Client, CallError> {
    let budget = CONNECT_BUDGET_MS;
    let path = socket_path(dir);
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let refuse = |code: &str| {
        CallError::Io(format!(
            "the sandbox blocks the relay socket ({code}); allow {} or run outside the sandbox",
            path.display()
        ))
    };
    let sandboxed = SANDBOX_MARKERS
        .iter()
        .any(|key| std::env::var_os(key).is_some_and(|v| !v.is_empty()));
    let deadline = Instant::now() + Duration::from_millis(budget);
    let mut started = false;
    let mut attempt = 0u32;
    loop {
        let failure = match Client::open(&path).await {
            Ok(client) => {
                if own_private_dir(&parent) {
                    return Ok(client);
                }
                client.close();
                return Err(CallError::Io(format!(
                    "{} is a link, not this user's, or writable by others; refusing the relay socket in it",
                    parent.display()
                )));
            }
            Err(error) => error,
        };
        let code = errno_code(&failure);
        let reason = connect_error(&failure, &path);
        if let Some(code @ ("EPERM" | "EACCES")) = code {
            return Err(refuse(code));
        }
        let live = broker_live(dir);
        if live && sandboxed && code != Some("ENOENT") {
            return Err(refuse(code.unwrap_or("refused")));
        }
        if !live && !started {
            let Some(start) = &start else {
                return Err(CallError::Io(format!(
                    "no relay broker at {} ({reason})",
                    path.display()
                )));
            };
            start();
            started = true;
        }
        let left = deadline
            .saturating_duration_since(Instant::now())
            .as_secs_f64()
            * 1000.0;
        if left <= 0.0 || (live && !code.is_some_and(|c| TRANSIENT.contains(&c))) {
            if !live {
                return Err(CallError::Io(format!(
                    "the relay broker did not start within {budget} ms ({reason})"
                )));
            }
            return Err(CallError::Io(format!(
                "the relay broker is running but did not accept a connection within {budget} ms ({}): it is busy; {CLI_NAME} status shows it",
                code.unwrap_or(&reason)
            )));
        }
        let pause = retry_delay(attempt, left, rand::random::<f64>());
        tokio::time::sleep(Duration::from_secs_f64(pause / 1000.0)).await;
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_double_with_jitter_under_the_cap() {
        assert_eq!(retry_delay(0, 10_000.0, 0.0), 50.0);
        assert_eq!(retry_delay(1, 10_000.0, 1.0), 150.0);
        assert_eq!(retry_delay(5, 10_000.0, 1.0), 400.0);
        assert_eq!(retry_delay(0, 20.0, 0.5), 20.0);
        assert_eq!(retry_delay(40, -5.0, 0.5), 0.0);
    }

    #[test]
    fn the_socket_moves_to_tmp_when_its_path_is_too_long() {
        assert_eq!(
            socket_path(Path::new("/a/./b/../scp")),
            PathBuf::from("/a/scp/relay.sock")
        );
        let long = PathBuf::from(format!("/{}", "x".repeat(120)));
        assert!(socket_path(&long).starts_with("/tmp"));
        let env: HashMap<String, String> =
            [("XDG_STATE_HOME".to_string(), "/s".to_string())].into();
        assert_eq!(relay_dir(&env), PathBuf::from("/s/scp"));
    }

    #[test]
    fn a_refusal_carries_its_code_and_retry() {
        let inner = Inner {
            next_id: Cell::new(1),
            pending: RefCell::new(HashMap::new()),
            closed: RefCell::new(None),
            writer: RefCell::new(None),
        };
        let (tx, mut rx) = oneshot::channel();
        inner.pending.borrow_mut().insert(3, tx);
        let line = br#"{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"slow down","data":{"code":"rate_limited","retry_after":2}}}"#;
        assert_eq!(inner.dispatch(line), Ok(()));
        assert_eq!(
            rx.try_recv().ok(),
            Some(Err(CallError::Relay {
                code: "rate_limited".into(),
                message: "slow down".into(),
                retry_after_s: Some(2.0)
            }))
        );
        assert!(inner.dispatch(b"nope").is_err());
    }
}
