//! The detached runner: the first process starts it and waits on a private pipe for the worker's name, and it answers once.

use crate::{Fail, route, term};
use scp_core::protocol::CLI_NAME;
use scp_mcp::client::CallError;
use scp_mcp::ps::{Env, SHELL_PS_TIMEOUT_MS, read_ps_table};
use scp_mcp::spawn::{handshake, walk_now};
use serde_json::{Value, json};
use std::path::Path;
use std::rc::Rc;

/// the fd a runner's starter leaves the handshake pipe on
const HANDSHAKE_FD: i32 = 3;

/// what a detached spawn's runner tells the spawn that started it, once: the worker started, or why it did not
pub struct Channel {
    fd: Option<i32>,
}

impl Channel {
    /// the handshake fd, close-on-exec so no harness inherits it; none when no pipe was left there. Call before anything opens an fd
    pub fn open() -> Channel {
        // SAFETY: only reads and sets the descriptor's flags
        let open = unsafe {
            let flags = libc::fcntl(HANDSHAKE_FD, libc::F_GETFD);
            flags >= 0 && libc::fcntl(HANDSHAKE_FD, libc::F_SETFD, flags | libc::FD_CLOEXEC) == 0
        };
        Channel {
            fd: open.then_some(HANDSHAKE_FD),
        }
    }

    /// no pipe: a run in the foreground, which tells no one
    pub fn none() -> Channel {
        Channel { fd: None }
    }

    /// `reply` as one line, then the pipe closed; later calls do nothing
    pub fn send(&mut self, reply: &Value) {
        let Some(fd) = self.fd.take() else {
            return;
        };
        let line = format!("{reply}\n");
        let mut bytes = line.as_bytes();
        while !bytes.is_empty() {
            // SAFETY: writes from a live slice of its own length
            let wrote = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
            if wrote <= 0 {
                break;
            }
            bytes = &bytes[wrote as usize..];
        }
        // SAFETY: closes the pipe this took
        unsafe { libc::close(fd) };
    }

    /// the worker started in this process
    pub fn started(&mut self, name: &str) {
        self.send(&json!({ "name": name, "pid": std::process::id() }));
    }

    /// the harness did not start: its message and exit code
    pub fn not_started(&mut self, message: &str, code: i32) {
        self.send(&json!({ "error": message, "code": code }));
    }

    /// the spawn failed before any harness
    pub fn failed(&mut self, fail: &Fail) {
        match fail {
            Fail::Usage(message) => self.send(&json!({ "error": message, "usage": true })),
            Fail::Call(error) => self.send(&json!({ "error": error.message() })),
            Fail::Decline(reason) => self.send(&json!({ "error": reason })),
        }
    }
}

fn ended() -> Fail {
    Fail::Call(CallError::Io(format!(
        "{CLI_NAME} spawn: the detached runner ended before the harness started"
    )))
}

/// a handshake's answer: the worker's name and the runner's pid, or the failure with the code to leave with
pub type Reply = Result<(String, u64), (String, i32)>;

/// what a handshake line says
pub fn read_reply(line: &str) -> Result<Reply, Fail> {
    let reply: Value = serde_json::from_str(line).map_err(|_| ended())?;
    let reply = reply.as_object().ok_or_else(ended)?;
    if let Some(error) = reply.get("error") {
        let message = error
            .as_str()
            .map_or_else(|| error.to_string(), str::to_owned);
        if reply
            .get("usage")
            .is_some_and(|usage| *usage == Value::Bool(true))
        {
            return Err(Fail::Usage(message));
        }
        return match reply.get("code").and_then(Value::as_i64) {
            Some(code) => Ok(Err((message, code as i32))),
            None => Err(Fail::Call(CallError::Io(message))),
        };
    }
    let name = reply.get("name").and_then(Value::as_str);
    let pid = reply.get("pid").and_then(Value::as_u64);
    match (name, pid) {
        (Some(name), Some(pid)) => Ok(Ok((name.to_owned(), pid))),
        _ => Err(ended()),
    }
}

/// Re-exec with the caller's walk and no caller stdio. Return once the private handshake confirms the harness started.
pub async fn detach_spawn(args: &[String], cwd: &str, env: &Env) -> Result<i32, Fail> {
    let table = read_ps_table(SHELL_PS_TIMEOUT_MS).map(Rc::new);
    let walk = walk_now(env, route::shell_pid(), table);
    let exe = std::env::current_exe().map_err(|_| ended())?;
    let launch = [exe.to_string_lossy().into_owned()];
    let mut env = env.clone();
    route::handed_on(&mut env);
    let line = handshake(&launch, args, Path::new(cwd), &env, &walk).await;
    match read_reply(&line)? {
        Ok((name, pid)) => {
            term::out(&format!(
                "{name} started (pid {pid}) and runs in the background: its result arrives as a relay message by itself; steer it with {CLI_NAME} send {name} <text>"
            ));
            Ok(0)
        }
        Err((message, code)) => {
            term::note(&message);
            Ok(code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_maps_as_the_cli_maps_it() {
        assert_eq!(
            read_reply(r#"{"name":"w1","pid":42}"#),
            Ok(Ok(("w1".into(), 42)))
        );
        assert_eq!(
            read_reply(r#"{"error":"swarm spawn: x: command not found","code":127}"#),
            Ok(Err(("swarm spawn: x: command not found".into(), 127)))
        );
        assert_eq!(
            read_reply(r#"{"error":"bad name","usage":true}"#),
            Err(Fail::Usage("bad name".into()))
        );
        assert_eq!(
            read_reply(r#"{"error":"refused"}"#),
            Err(Fail::Call(CallError::Io("refused".into())))
        );
        for line in ["", "{", "[]", r#"{"name":"w"}"#] {
            assert_eq!(read_reply(line), Err(ended()), "{line}");
        }
    }

    #[test]
    fn a_channel_answers_once_and_is_closed_on_exec() {
        let mut fds = [0; 2];
        // SAFETY: a fresh pipe, both ends closed below
        unsafe { assert_eq!(libc::pipe(fds.as_mut_ptr()), 0) };
        let mut channel = Channel { fd: Some(fds[1]) };
        channel.started("w1");
        channel.failed(&Fail::Usage("late".into()));
        let mut read = vec![0u8; 256];
        // SAFETY: reads into a live buffer of its length
        let count = unsafe { libc::read(fds[0], read.as_mut_ptr().cast(), read.len()) };
        read.truncate(count as usize);
        let line = String::from_utf8(read).unwrap();
        assert_eq!(
            line,
            format!("{{\"name\":\"w1\",\"pid\":{}}}\n", std::process::id())
        );
        // SAFETY: the write end is closed, so this reads its end
        assert_eq!(
            unsafe { libc::read(fds[0], [0u8; 1].as_mut_ptr().cast(), 1) },
            0
        );
        // SAFETY: closes the read end opened above
        unsafe { libc::close(fds[0]) };
    }
}
