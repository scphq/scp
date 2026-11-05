//! A WebSocket client on a stream of its own: the HTTP upgrade, masked text frames out, text frames in, pings answered.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::rc::Rc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tokio::task::AbortHandle;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;

const MAX_FRAME: u64 = 64 * 1024 * 1024;

/// the HTTP request that opens the link
#[derive(Debug, Clone, Default)]
pub struct Upgrade {
    pub path: Option<String>,
    pub host: Option<String>,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
enum Ready {
    Waiting,
    Open,
    Failed(String),
}

pub type OnText = Box<dyn Fn(&str)>;
pub type OnClose = Box<dyn Fn(&str)>;

/// one open WebSocket: `name` prefixes its errors, and `on_close` runs once, with the error that ended it
pub struct Link {
    name: String,
    key: String,
    ready: watch::Sender<Ready>,
    closed: RefCell<Option<String>>,
    writer: RefCell<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    on_text: OnText,
    on_close: OnClose,
    reader: RefCell<Option<AbortHandle>>,
    sender: RefCell<Option<AbortHandle>>,
    buffer: RefCell<Vec<u8>>,
    fragments: RefCell<Vec<u8>>,
    opened: Cell<bool>,
}

/// `io` as Node's stream error: `read ECONNRESET`
fn stream_error(syscall: &str, error: &std::io::Error) -> String {
    match scp_mcp::client::errno_code(error) {
        Some(code) => format!("{syscall} {code}"),
        None => error.to_string(),
    }
}

/// `^HTTP/1\.1 101\b`
fn switched(header: &str) -> bool {
    header.strip_prefix("HTTP/1.1 101").is_some_and(|rest| {
        rest.chars()
            .next()
            .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
    })
}

/// `^HTTP/1\.1 \d+`
fn has_status(header: &str) -> bool {
    header
        .strip_prefix("HTTP/1.1 ")
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
}

/// an outgoing frame of `opcode`, masked
fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let length = payload.len();
    let mut out = Vec::with_capacity(length + 14);
    out.push(128 | opcode);
    if length < 126 {
        out.push(128 | length as u8);
    } else if length < 65536 {
        out.push(128 | 126);
        out.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        out.push(128 | 127);
        out.extend_from_slice(&(length as u64).to_be_bytes());
    }
    let mask: [u8; 4] = rand::random();
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    out
}

impl Link {
    /// starts the link on the stream `connect` gives, whose failure is the link's error; needs a LocalSet
    pub fn open<S, F>(
        connect: F,
        upgrade: Upgrade,
        name: &str,
        on_text: OnText,
        on_close: OnClose,
    ) -> Rc<Link>
    where
        S: AsyncRead + AsyncWrite + 'static,
        F: Future<Output = Result<S, String>> + 'static,
    {
        let link = Rc::new(Link {
            name: name.to_owned(),
            key: generate_key(),
            ready: watch::Sender::new(Ready::Waiting),
            closed: RefCell::new(None),
            writer: RefCell::new(None),
            on_text,
            on_close,
            reader: RefCell::new(None),
            sender: RefCell::new(None),
            buffer: RefCell::new(Vec::new()),
            fragments: RefCell::new(Vec::new()),
            opened: Cell::new(false),
        });
        let (tx, rx) = mpsc::unbounded_channel();
        *link.writer.borrow_mut() = Some(tx);
        let running = link.clone();
        let task = tokio::task::spawn_local(async move {
            running.run(connect, upgrade, rx).await;
        });
        *link.reader.borrow_mut() = Some(task.abort_handle());
        link
    }

    async fn run<S, F>(
        self: Rc<Self>,
        connect: F,
        upgrade: Upgrade,
        mut outgoing: mpsc::UnboundedReceiver<Vec<u8>>,
    ) where
        S: AsyncRead + AsyncWrite + 'static,
        F: Future<Output = Result<S, String>>,
    {
        let stream = match connect.await {
            Ok(stream) => stream,
            Err(error) => {
                self.fail(&error);
                return;
            }
        };
        let (mut read, mut write) = tokio::io::split(stream);
        let headers: String = upgrade
            .headers
            .iter()
            .map(|(key, value)| format!("{key}: {value}\r\n"))
            .collect();
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n{headers}\r\n",
            upgrade.path.as_deref().unwrap_or("/"),
            upgrade.host.as_deref().unwrap_or("localhost"),
            self.key
        );
        if let Err(error) = write.write_all(request.as_bytes()).await {
            self.fail(&stream_error("write", &error));
            return;
        }
        let writing = self.clone();
        let sending = tokio::task::spawn_local(async move {
            while let Some(bytes) = outgoing.recv().await {
                if let Err(error) = write.write_all(&bytes).await {
                    writing.fail(&stream_error("write", &error));
                    return;
                }
            }
        });
        *self.sender.borrow_mut() = Some(sending.abort_handle());
        let mut chunk = vec![0u8; 65536];
        loop {
            match read.read(&mut chunk).await {
                Ok(0) => {
                    self.fail(&format!("{} socket closed", self.name));
                    return;
                }
                Ok(n) => {
                    if let Err(error) = self.feed(&chunk[..n]) {
                        self.fail(&error);
                    }
                    if self.destroyed() {
                        return;
                    }
                }
                Err(error) => {
                    self.fail(&stream_error("read", &error));
                    return;
                }
            }
        }
    }

    pub fn destroyed(&self) -> bool {
        self.closed.borrow().is_some()
    }

    /// resolves once the upgrade went through, with the error that stopped it otherwise
    pub async fn ready(&self) -> Result<(), String> {
        let mut state = self.ready.subscribe();
        let seen = state
            .wait_for(|ready| *ready != Ready::Waiting)
            .await
            .map(|ready| ready.clone());
        match seen {
            Ok(Ready::Failed(error)) => Err(error),
            Ok(_) => Ok(()),
            Err(_) => Err(format!("{} socket closed", self.name)),
        }
    }

    /// ends the link with `error`: frames the stream takes at once still go, the rest is dropped
    pub fn fail(&self, error: &str) {
        self.ready.send_if_modified(|ready| {
            let waiting = *ready == Ready::Waiting;
            if waiting {
                *ready = Ready::Failed(error.to_owned());
            }
            waiting
        });
        self.writer.borrow_mut().take();
        if let Some(reader) = self.reader.borrow_mut().take() {
            reader.abort();
        }
        if let Some(sender) = self.sender.borrow_mut().take() {
            tokio::task::spawn_local(async move {
                tokio::task::yield_now().await;
                sender.abort();
            });
        }
        if self.destroyed() {
            return;
        }
        *self.closed.borrow_mut() = Some(error.to_owned());
        (self.on_close)(error);
    }

    fn write(&self, bytes: Vec<u8>) {
        if let Some(writer) = self.writer.borrow().as_ref() {
            let _ = writer.send(bytes);
        }
    }

    /// sends one text frame
    pub fn send(&self, text: &str) -> Result<(), String> {
        if self.destroyed() {
            return Err(format!("{} socket closed", self.name));
        }
        self.write(frame(1, text.as_bytes()));
        Ok(())
    }

    fn upgraded(&self, buffer: &mut Vec<u8>) -> Result<bool, String> {
        let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") else {
            return Ok(false);
        };
        let header = String::from_utf8_lossy(&buffer[..end]).into_owned();
        let accept = derive_accept_key(self.key.as_bytes());
        let want = format!("sec-websocket-accept: {accept}").to_lowercase();
        if !switched(&header) || !header.to_lowercase().contains(&want) {
            let line = header.split("\r\n").next().unwrap_or("");
            let status = if has_status(&header) {
                format!(" ({})", line.get(9..).unwrap_or(""))
            } else {
                String::new()
            };
            return Err(format!("{} WebSocket upgrade failed{status}", self.name));
        }
        buffer.drain(..end + 4);
        self.opened.set(true);
        self.ready.send_replace(Ready::Open);
        Ok(true)
    }

    fn feed(&self, data: &[u8]) -> Result<(), String> {
        self.buffer.borrow_mut().extend_from_slice(data);
        if !self.opened.get() {
            let mut buffer = self.buffer.take();
            let upgraded = self.upgraded(&mut buffer);
            *self.buffer.borrow_mut() = buffer;
            if !upgraded? {
                return Ok(());
            }
        }
        while let Some((opcode, end, payload)) = self.next_frame()? {
            if opcode == 8 {
                self.fail(&format!("{} WebSocket closed", self.name));
                return Ok(());
            }
            if opcode == 9 {
                self.write(frame(10, &payload));
            }
            if opcode != 1 && opcode != 0 {
                continue;
            }
            self.fragments.borrow_mut().extend_from_slice(&payload);
            if !end {
                continue;
            }
            let whole = self.fragments.take();
            (self.on_text)(&String::from_utf8_lossy(&whole));
            if self.destroyed() {
                return Ok(());
            }
        }
        Ok(())
    }

    /// the first whole frame in the buffer, taken out of it
    #[allow(clippy::type_complexity)]
    fn next_frame(&self) -> Result<Option<(u8, bool, Vec<u8>)>, String> {
        let mut buffer = self.buffer.borrow_mut();
        if buffer.len() < 2 {
            return Ok(None);
        }
        let opcode = buffer[0] & 15;
        let last = buffer[0] & 128 != 0;
        let masked = buffer[1] & 128 != 0;
        let mut length = u64::from(buffer[1] & 127);
        let mut offset = 2;
        if length == 126 {
            if buffer.len() < 4 {
                return Ok(None);
            }
            length = u64::from(u16::from_be_bytes([buffer[2], buffer[3]]));
            offset = 4;
        } else if length == 127 {
            if buffer.len() < 10 {
                return Ok(None);
            }
            let mut size = [0u8; 8];
            size.copy_from_slice(&buffer[2..10]);
            length = u64::from_be_bytes(size);
            if length > MAX_FRAME {
                return Err(format!("{} WebSocket frame too large", self.name));
            }
            offset = 10;
        }
        let start = offset + if masked { 4 } else { 0 };
        let length = length as usize;
        if buffer.len() < start + length {
            return Ok(None);
        }
        let mut payload = buffer[start..start + length].to_vec();
        if masked {
            for (i, byte) in payload.iter_mut().enumerate() {
                *byte ^= buffer[offset + i % 4];
            }
        }
        buffer.drain(..start + length);
        Ok(Some((opcode, last, payload)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_link_drops_what_the_stream_does_not_take() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async {
            let (near, mut far) = tokio::io::duplex(4096);
            let link = Link::open(
                async move { Ok(near) },
                Upgrade::default(),
                "test",
                Box::new(|_| {}),
                Box::new(|_| {}),
            );
            let mut request = vec![0u8; 1024];
            let n = far.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..n]).into_owned();
            let key = request
                .split("\r\n")
                .find_map(|line| line.strip_prefix("Sec-WebSocket-Key: "))
                .unwrap();
            let accept = derive_accept_key(key.as_bytes());
            let reply = format!(
                "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
            );
            far.write_all(reply.as_bytes()).await.unwrap();
            link.ready().await.unwrap();
            let big = "x".repeat(1 << 20);
            link.send("small").unwrap();
            link.send(&big).unwrap();
            link.fail("stop");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let mut sent = Vec::new();
            let read = far.read_to_end(&mut sent);
            tokio::time::timeout(std::time::Duration::from_secs(5), read)
                .await
                .unwrap()
                .unwrap();
            assert!(sent.len() < 1 << 20, "{}", sent.len());
            assert!(sent.len() > 5);
        });
    }

    #[test]
    fn the_status_line_decides_the_upgrade() {
        assert!(switched("HTTP/1.1 101 Switching Protocols"));
        assert!(switched("HTTP/1.1 101"));
        assert!(!switched("HTTP/1.1 1011"));
        assert!(!switched("HTTP/1.1 401 Unauthorized"));
        assert!(has_status("HTTP/1.1 401 Unauthorized"));
        assert!(!has_status("garbage"));
    }

    #[test]
    fn frames_are_masked_at_each_length() {
        for (size, head) in [(5, 2), (200, 4), (70_000, 10)] {
            let payload = vec![7u8; size];
            let bytes = frame(1, &payload);
            assert_eq!(bytes[0], 129);
            assert_eq!(bytes.len(), head + 4 + size);
            let mask = &bytes[head..head + 4];
            let body: Vec<u8> = bytes[head + 4..]
                .iter()
                .enumerate()
                .map(|(i, b)| b ^ mask[i % 4])
                .collect();
            assert_eq!(body, payload);
        }
    }
}
