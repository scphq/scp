use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// a hub that links the bridge and then goes silent: it keeps every socket open and answers nothing more
async fn silent_hub(listener: TcpListener, silent: Arc<AtomicBool>) {
    loop {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let silent = silent.clone();
        tokio::spawn(async move {
            let Ok(mut socket) = tokio_tungstenite::accept_async(tcp).await else {
                return;
            };
            while let Some(Ok(message)) = socket.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let frame: Value = serde_json::from_str(text.as_str()).unwrap_or_default();
                if silent.load(Ordering::SeqCst) || !frame["id"].is_u64() {
                    continue;
                }
                let method = frame["method"].as_str().unwrap_or_default();
                let result = match method {
                    "hello" => json!({"account": "acct", "others": [], "endpoints": []}),
                    _ => json!({}),
                };
                let reply = json!({"jsonrpc": "2.0", "id": frame["id"], "result": result});
                if socket.send(Message::text(reply.to_string())).await.is_err() {
                    return;
                }
                if method == "subscribe" {
                    silent.store(true, Ordering::SeqCst);
                }
            }
        });
    }
}

struct Client {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
    next: u64,
}

impl Client {
    fn open(dir: &Path) -> Client {
        let stream = UnixStream::connect(dir.join("relay.sock")).expect("connect");
        let reader = BufReader::new(stream.try_clone().expect("clone"));
        Client {
            stream,
            reader,
            next: 1,
        }
    }

    fn send(&mut self, method: &str, params: Value) {
        let frame = json!({"jsonrpc": "2.0", "id": self.next, "method": method, "params": params});
        self.next += 1;
        writeln!(self.stream, "{frame}").expect("write");
    }

    /// the next answer within `wait`, None when the broker says nothing in time
    fn answer(&mut self, wait: Duration) -> Option<Value> {
        self.stream.set_read_timeout(Some(wait)).expect("timeout");
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(n) if n > 0 => Some(serde_json::from_str(&line).expect("JSON")),
            _ => None,
        }
    }

    fn call(&mut self, method: &str, params: Value, wait: Duration) -> Option<Value> {
        self.send(method, params);
        self.answer(wait)
    }
}

struct Broker {
    child: Child,
    home: PathBuf,
}

impl Broker {
    fn start(hub: &str) -> Broker {
        let home = PathBuf::from(format!("/tmp/scp-bs-{:08x}", rand::random::<u32>()));
        let config = home.join(".config");
        std::fs::create_dir_all(config.join("scp")).expect("config");
        std::fs::write(
            config.join("scp/cloud.json"),
            json!({"bridge": true, "machine": "m1"}).to_string(),
        )
        .expect("cloud.json");
        let child = Command::new(env!("CARGO_BIN_EXE_scp-broker"))
            .args(["daemon", "--idle", "120", "--policy"])
            .arg(home.join("policy.json"))
            .env_clear()
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin")
            .env("SCP_DIR", home.join("relay"))
            .env("XDG_CONFIG_HOME", &config)
            .env("SCP_RELAY", hub)
            .env("SCP_TOKEN", "t")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("run scp-broker");
        Broker { child, home }
    }

    fn dir(&self) -> PathBuf {
        self.home.join("relay")
    }

    fn linked(&self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if self.dir().join("relay.sock").exists() {
                let mut client = Client::open(&self.dir());
                let hello = client.call(
                    "hello",
                    json!({"protocol": "scp/1", "human": true}),
                    Duration::from_secs(5),
                );
                let status = client.call("cloud_status", json!({}), Duration::from_secs(5));
                if hello.is_some()
                    && status.is_some_and(|s| s["result"]["connected"] == Value::Bool(true))
                {
                    return true;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    /// SIGTERM, then whether the broker exited within `wait`
    fn terminates_within(&mut self, wait: Duration) -> bool {
        // SAFETY: the pid is this test's own child
        unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM) };
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline {
            if self.child.try_wait().expect("wait").is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

impl Drop for Broker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

async fn hub() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("address"));
    tokio::spawn(silent_hub(listener, Arc::new(AtomicBool::new(false))));
    url
}

fn result(answer: Option<Value>, what: &str) -> Value {
    let answer = answer.unwrap_or_else(|| panic!("{what}: no answer"));
    answer
        .get("result")
        .cloned()
        .unwrap_or_else(|| panic!("{what}: {answer}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hibernate_while_the_hub_is_silent_keeps_the_broker_answering_and_stoppable() {
    let url = hub().await;
    tokio::task::spawn_blocking(move || {
        let mut broker = Broker::start(&url);
        assert!(broker.linked(), "the bridge never linked to the fake hub");
        let mut agent = Client::open(&broker.dir());
        result(
            agent.call(
                "hello",
                json!({"protocol": "scp/1", "claim": {"handle": "w1", "harness": "codex"}}),
                Duration::from_secs(5),
            ),
            "agent hello",
        );
        agent.send("hibernate", json!({"wake": "none"}));
        std::thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        let mut human = Client::open(&broker.dir());
        let hello = human.call(
            "hello",
            json!({"protocol": "scp/1", "human": true}),
            Duration::from_secs(5),
        );
        assert!(
            hello.is_some(),
            "the broker stopped answering while a hibernate waited on the silent hub"
        );
        result(
            human.call("list", json!({}), Duration::from_secs(5)),
            "list",
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        let hibernated = result(agent.answer(Duration::from_secs(20)), "hibernate");
        assert_eq!(hibernated["mirrored"], Value::Bool(false), "{hibernated}");
        assert!(
            broker.terminates_within(Duration::from_secs(5)),
            "SIGTERM did not stop the broker"
        );
    })
    .await
    .expect("test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigterm_stops_the_broker_while_a_machine_wake_waits_on_the_silent_hub() {
    let url = hub().await;
    tokio::task::spawn_blocking(move || {
        let mut broker = Broker::start(&url);
        assert!(broker.linked(), "the bridge never linked to the fake hub");
        let mut waking = Client::open(&broker.dir());
        result(
            waking.call(
                "hello",
                json!({"protocol": "scp/1", "human": true}),
                Duration::from_secs(5),
            ),
            "hello",
        );
        waking.send("machine_wake", json!({"url": null}));
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            broker.terminates_within(Duration::from_secs(5)),
            "SIGTERM did not stop the broker"
        );
    })
    .await
    .expect("test");
}
