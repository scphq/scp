//! What the long-running launchers share: the relay channel they run in-process, the child they supervise, and how a run ends.

use crate::fleet::json::Json;
use crate::open::{errno_words, start_broker};
use scp_mcp::client::{CallError, Client, Start, connect_or_start};
use scp_mcp::identity::{IdentityInput, relay_identity};
use scp_mcp::ps::Env;
use scp_mcp::server::{Connect, Options, run};
use scp_mcp::tools::{MCP_PROTOCOLS, js_trim, truthy};
use scp_mcp::{Claim, LocalFuture};
use serde_json::{Map, Value};
use std::cell::{Cell, RefCell};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::rc::Rc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// what a waker asks of its harness: a reply, or the error's message
pub trait Transport {
    fn request(&self, method: &str, params: Json) -> LocalFuture<'static, Result<Json, String>>;
}

/// a child's signal dispositions as `child_process.spawn` leaves them: the default, whatever this process ignores
pub fn default_signals(command: &mut std::process::Command) {
    // SAFETY: only async-signal-safe calls between fork and exec
    unsafe {
        command.pre_exec(|| {
            for signal in 1..32 {
                if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                    libc::signal(signal, libc::SIG_DFL);
                }
            }
            Ok(())
        });
    }
}

/// Node's `spawn` failure: `spawn <bin> <code>`
pub fn spawn_error(bin: &str, error: &std::io::Error) -> String {
    let code = errno_words(error).map_or_else(|| error.to_string(), |(code, _)| code.to_owned());
    format!("spawn {bin} {code}")
}

/// the code a run ends with, once it is known; the first one given stands
#[derive(Clone, Default)]
pub struct Latch {
    code: Rc<watch::Sender<Option<i32>>>,
}

impl Latch {
    pub fn finish(&self, code: i32) {
        self.code.send_if_modified(|held| {
            let first = held.is_none();
            if first {
                *held = Some(code);
            }
            first
        });
    }

    pub async fn done(&self) -> i32 {
        let mut code = self.code.subscribe();
        let held = code.wait_for(Option::is_some).await;
        held.ok().and_then(|code| *code).unwrap_or(1)
    }

    pub fn finished(&self) -> bool {
        self.code.borrow().is_some()
    }
}

/// a child this launcher runs, its exit watched by a task of its own
pub struct Watched {
    pid: i32,
    exit: watch::Sender<Option<ExitStatus>>,
}

impl Watched {
    /// watches `child`; needs a LocalSet
    pub fn start(mut child: tokio::process::Child) -> Rc<Watched> {
        let watched = Rc::new(Watched {
            pid: child.id().map_or(0, |pid| pid as i32),
            exit: watch::Sender::new(None),
        });
        let watching = watched.clone();
        tokio::task::spawn_local(async move {
            let status = child.wait().await.ok();
            watching
                .exit
                .send_replace(Some(status.unwrap_or_else(|| ExitStatus::from_raw(1 << 8))));
        });
        watched
    }

    pub fn pid(&self) -> i32 {
        self.pid
    }

    pub fn running(&self) -> bool {
        self.exit.borrow().is_none()
    }

    pub fn kill(&self, signal: i32) {
        if self.running() {
            // SAFETY: signals the child this watches, which is not reaped yet
            unsafe { libc::kill(self.pid, signal) };
        }
    }

    pub async fn exited(&self) -> ExitStatus {
        let mut exit = self.exit.subscribe();
        let status = exit.wait_for(Option::is_some).await;
        status
            .ok()
            .and_then(|status| *status)
            .unwrap_or_else(|| ExitStatus::from_raw(1 << 8))
    }

    /// SIGTERM, and SIGKILL once `grace_ms` passed, until it is gone
    pub async fn terminate(&self, grace_ms: u64) {
        if !self.running() {
            return;
        }
        self.kill(libc::SIGTERM);
        let grace = Duration::from_millis(grace_ms);
        if tokio::time::timeout(grace, self.exited()).await.is_err() {
            self.kill(libc::SIGKILL);
            self.exited().await;
        }
    }
}

/// a harness server: the watched child, or why it did not start, and the last of its stderr
pub struct Server {
    pub child: Option<Rc<Watched>>,
    pub error: Option<String>,
    stderr: Rc<RefCell<Vec<u8>>>,
    died: Rc<Cell<bool>>,
}

const STDERR_KEPT: usize = 8192;
/// how long what a server wrote last may take to reach the end of its stderr, once it exited
const STDERR_WAIT: Duration = Duration::from_millis(100);

/// the server `command` starts, its stderr piped, finishing `latch` with 1 when it ends; its stdin and stdout, when piped
pub fn start_server(
    mut command: tokio::process::Command,
    bin: &str,
    latch: &Latch,
) -> (
    Server,
    Option<tokio::process::ChildStdin>,
    Option<tokio::process::ChildStdout>,
) {
    default_signals(command.as_std_mut());
    let stderr = Rc::new(RefCell::new(Vec::new()));
    let died = Rc::new(Cell::new(false));
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            died.set(true);
            latch.finish(1);
            let server = Server {
                child: None,
                error: Some(spawn_error(bin, &error)),
                stderr,
                died,
            };
            return (server, None, None);
        }
    };
    let input = child.stdin.take();
    let output = child.stdout.take();
    let pipe = child.stderr.take();
    let (drained, mut read) = tokio::sync::oneshot::channel::<()>();
    let kept = stderr.clone();
    tokio::task::spawn_local(async move {
        let Some(mut pipe) = pipe else { return };
        let mut chunk = vec![0u8; 8192];
        while let Ok(n) = pipe.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            let mut kept = kept.borrow_mut();
            kept.extend_from_slice(&chunk[..n]);
            let over = kept.len().saturating_sub(STDERR_KEPT);
            kept.drain(..over);
        }
        let _ = drained.send(());
    });
    let watched = Watched::start(child);
    let (ended, gone, exiting) = (latch.clone(), died.clone(), watched.clone());
    tokio::task::spawn_local(async move {
        exiting.exited().await;
        let _ = tokio::time::timeout(STDERR_WAIT, &mut read).await;
        gone.set(true);
        ended.finish(1);
    });
    let server = Server {
        child: Some(watched),
        error: None,
        stderr,
        died,
    };
    (server, input, output)
}

impl Server {
    pub fn died(&self) -> bool {
        self.died.get()
    }

    /// `head`, with why it failed and what it wrote to stderr
    pub fn failure(&self, head: &str) -> String {
        let mut text = head.to_owned();
        if let Some(error) = &self.error {
            text.push_str(&format!(": {error}"));
        }
        let stderr = self.stderr.borrow();
        if !stderr.is_empty() {
            text.push('\n');
            text.push_str(js_trim(&String::from_utf8_lossy(&stderr)));
        }
        text
    }

    pub async fn terminate(&self, grace_ms: u64) {
        if let Some(child) = &self.child {
            child.terminate(grace_ms).await;
        }
    }
}

/// the claim a launcher makes for the session in harness process `pid`
pub fn launcher_claim(harness: &str, cwd: &str, env: &Env, pid: i64) -> Claim {
    relay_identity(&IdentityInput {
        state_dir: None,
        as_: None,
        harness: Some(harness.to_owned()),
        fallback_harness: harness.to_owned(),
        cwd: cwd.to_owned(),
        env: env.clone(),
        harness_pid: Rc::new(move |_| pid),
        infer_harness: None,
        start_of: None,
        lineage_of: None,
        harness_session: None,
        t3_hosted: None,
        ps_table: None,
    })
}

/// a connection to the broker for `dir`, started with `env` when it does not run
pub fn broker_connect(dir: &str, env: &Env) -> Connect {
    let (dir, env) = (dir.to_owned(), env.clone());
    Rc::new(move || {
        let (dir, env) = (dir.clone(), env.clone());
        Box::pin(async move {
            let shown = dir.clone();
            let start: Start = Rc::new(move || start_broker(&shown, &env));
            connect_or_start(Path::new(&dir), Some(start)).await
        })
    })
}

fn pause() -> tokio::time::Sleep {
    tokio::time::sleep(Duration::from_millis(100))
}

/// binds the channel only once the mounted shim has claimed the harness process: a connection that asks the broker for no claim of its
/// own, and answers the channel's hello with the endpoint it found
pub async fn bind_channel(
    connect: &Connect,
    claim: &Claim,
    cwd: &str,
    stopped: &dyn Fn() -> bool,
) -> Result<Client, CallError> {
    let grant = claim.get("grant").filter(|grant| truthy(Some(grant)));
    while !stopped() {
        let client = connect().await?;
        let mut hello = Map::new();
        hello.insert("observe".into(), Value::Bool(true));
        let process = claim.get("process").cloned().unwrap_or(Value::Null);
        hello.insert("self".into(), Value::Array(vec![process]));
        if let Some(grant) = grant {
            hello.insert("grant".into(), grant.clone());
        }
        hello.insert("cwd".into(), Value::from(cwd));
        match client.hello(hello).await {
            Ok(bound) => {
                if truthy(bound.get("endpoint")) {
                    client.keep_hello(bound);
                    return Ok(client);
                }
            }
            Err(CallError::Relay { code, .. }) if grant.is_some() && code == "unauthorized" => {
                client.close();
            }
            Err(error) => {
                client.close();
                return Err(error);
            }
        }
        client.close();
        pause().await;
    }
    Err(CallError::Io("codex channel stopped".into()))
}

/// the relay MCP server a launcher runs in-process, as its only client
pub struct Channel {
    input: RefCell<Option<DuplexStream>>,
    ended: Rc<Cell<bool>>,
    serving: RefCell<Option<JoinHandle<()>>>,
}

/// what a launcher gives its channel
pub struct ChannelSetup {
    pub connect: Connect,
    pub claim: Claim,
    pub wake: &'static str,
    pub env: Env,
    pub log: Rc<dyn Fn(&str)>,
    /// each JSON-RPC message the server writes
    pub on_message: Rc<dyn Fn(&Value)>,
}

const INPUT_BYTES: usize = 1 << 16;

impl Channel {
    /// starts serving; `ended` reads true from the moment [`Channel::end`] ran
    pub fn start(setup: ChannelSetup, ended: Rc<Cell<bool>>) -> Channel {
        let (write, read) = tokio::io::duplex(INPUT_BYTES);
        let options = Options {
            connect: setup.connect,
            claim: setup.claim,
            membership: None,
            thread_claim: None,
            defer_claim: false,
            bound: None,
            env: setup.env,
            channels: true,
            launched_with_channels: false,
            session_inbox: None,
            wake: Some(setup.wake.to_owned()),
            version: None,
            spawn: None,
            log: setup.log,
            heartbeat_ms: 30_000,
        };
        let on_message = setup.on_message;
        let output = Rc::new(move |text: &str| {
            for line in text.split('\n').filter(|line| !line.is_empty()) {
                if let Ok(message) = serde_json::from_str::<Value>(line) {
                    on_message(&message);
                }
            }
        });
        let serving = tokio::task::spawn_local(run(options, read, output));
        Channel {
            input: RefCell::new(Some(write)),
            ended,
            serving: RefCell::new(Some(serving)),
        }
    }

    async fn write(&self, line: String) {
        let input = self.input.borrow_mut().take();
        if let Some(mut input) = input {
            let _ = input.write_all(line.as_bytes()).await;
            *self.input.borrow_mut() = Some(input);
        }
    }

    /// `initialize` and `notifications/initialized`, as client `name`
    pub async fn initialize(&self, name: &str) {
        let hello = Json::object(vec![
            ("id", Json::Num(1.0)),
            ("method", Json::str("initialize")),
            (
                "params",
                Json::object(vec![
                    ("protocolVersion", Json::str(MCP_PROTOCOLS[0])),
                    (
                        "capabilities",
                        Json::object(vec![(
                            "experimental",
                            Json::object(vec![("claude/channel", Json::Obj(Vec::new()))]),
                        )]),
                    ),
                    (
                        "clientInfo",
                        Json::object(vec![
                            ("name", Json::str(name)),
                            ("version", Json::str("0.1.0")),
                        ]),
                    ),
                ]),
            ),
        ]);
        self.write(format!("{}\n", hello.compact())).await;
        self.write("{\"method\":\"notifications/initialized\"}\n".into())
            .await;
    }

    /// `relay_whoami` as call 2, whose reply says the claim joined
    pub async fn whoami(&self) {
        self.write(
            "{\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"relay_whoami\",\"arguments\":{}}}\n"
                .into(),
        )
        .await;
    }

    /// ends the input, which the server takes as the client leaving, and waits for it
    pub async fn end(&self) {
        self.ended.set(true);
        let input = self.input.borrow_mut().take();
        drop(input);
        let serving = self.serving.borrow_mut().take();
        if let Some(serving) = serving {
            let _ = serving.await;
        }
    }
}

/// the message text a channel push carries
pub fn pushed(message: &Value) -> Option<&str> {
    if message.get("method").and_then(Value::as_str) != Some("notifications/claude/channel") {
        return None;
    }
    message.get("params")?.get("content")?.as_str()
}

/// `^address: (\S+)$`, multiline
pub fn address_in(text: &str) -> Option<&str> {
    text.split('\n').find_map(|line| {
        let address = line.strip_prefix("address: ")?;
        (!address.is_empty() && !address.chars().any(scp_mcp::render::js_space)).then_some(address)
    })
}

/// the lines of a tool result's text parts
pub fn result_text(result: &Value) -> String {
    let parts = result.get("content").and_then(Value::as_array);
    parts
        .map(|parts| {
            parts
                .iter()
                .map(|part| part.get("text").and_then(Value::as_str).unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// `mkdtempSync(prefix)`, its random part filled in
pub fn temp_dir(prefix: &str) -> std::io::Result<PathBuf> {
    let template = std::ffi::CString::new(format!("{prefix}XXXXXX"))?;
    let mut bytes = template.into_bytes_with_nul();
    // SAFETY: mkdtemp rewrites the template, a NUL-terminated buffer it owns for the call
    if unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) }.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    bytes.pop();
    Ok(PathBuf::from(String::from_utf8_lossy(&bytes).into_owned()))
}

/// `os.tmpdir()`: $TMPDIR, $TMP or $TEMP without a trailing slash, else /tmp
pub fn os_tmpdir(env: &Env) -> String {
    let dir = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| env.get(*key).filter(|value| !value.is_empty()))
        .map_or("/tmp", String::as_str);
    if dir.len() > 1 {
        dir.strip_suffix('/').unwrap_or(dir).to_owned()
    } else {
        dir.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_the_line_that_names_one() {
        assert_eq!(
            address_in("handle: x\naddress: me/vm/x\nmore"),
            Some("me/vm/x")
        );
        assert_eq!(address_in("address: two words"), None);
        assert_eq!(address_in("no"), None);
    }

    #[test]
    fn the_temp_dir_is_trimmed_as_node_trims_it() {
        let env = Env::from([("TMPDIR".to_owned(), "/var/t/".to_owned())]);
        assert_eq!(os_tmpdir(&env), "/var/t");
        assert_eq!(os_tmpdir(&Env::new()), "/tmp");
    }

    #[test]
    fn a_push_is_a_channel_notification_with_text() {
        let push = serde_json::json!({"method": "notifications/claude/channel", "params": {"content": "hi"}});
        assert_eq!(pushed(&push), Some("hi"));
        assert_eq!(pushed(&serde_json::json!({"method": "other"})), None);
    }
}
