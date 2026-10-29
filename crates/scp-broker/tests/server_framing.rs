use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use scp_broker::paths::socket_path;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::process::{Child, Command};
use tokio::time::{Instant, timeout};

struct Broker {
    child: Child,
    home: PathBuf,
    dir: PathBuf,
    socket: PathBuf,
}

impl Broker {
    async fn start(idle: &str) -> Self {
        let home = std::env::temp_dir().join(format!("scp-server-{:016x}", rand::random::<u64>()));
        let dir = home.join("state/scp");
        let socket = socket_path(&dir);
        tokio::fs::create_dir_all(&home).await.expect("home");
        let child = Self::command(&home, &dir, idle)
            .spawn()
            .expect("start broker");
        let mut broker = Self {
            child,
            home,
            dir,
            socket,
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Ok(stream) = UnixStream::connect(&broker.socket).await {
                drop(stream);
                return broker;
            }
            assert!(
                broker.child.try_wait().expect("child status").is_none(),
                "broker exited before listening"
            );
            assert!(Instant::now() < deadline, "broker did not start");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn command(home: &std::path::Path, dir: &std::path::Path, idle: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_scp-broker"));
        command
            .args(["daemon", "--idle", idle, "--policy"])
            .arg(home.join("policy.json"))
            .env_clear()
            .env("HOME", home)
            .env("SCP_DIR", dir)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null());
        command
    }

    async fn wire(&self) -> Wire {
        let (read, write) = UnixStream::connect(&self.socket)
            .await
            .expect("connect")
            .into_split();
        Wire {
            read: BufReader::new(read),
            write,
        }
    }

    async fn stop(mut self) {
        if let Some(pid) = self.child.id() {
            // Only the child created by this fixture is signalled.
            assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGTERM) }, 0);
            let status = timeout(Duration::from_secs(5), self.child.wait())
                .await
                .expect("shutdown timeout")
                .expect("shutdown");
            assert!(status.success());
        }
        assert!(tokio::fs::symlink_metadata(&self.socket).await.is_err());
        assert!(
            tokio::fs::symlink_metadata(self.dir.join("broker.lock"))
                .await
                .is_err()
        );
        tokio::fs::remove_dir_all(&self.home)
            .await
            .expect("remove home");
        if self.socket != self.dir.join("relay.sock") {
            let _ = tokio::fs::remove_dir(self.socket.parent().expect("socket parent")).await;
        }
    }
}

struct Wire {
    read: BufReader<OwnedReadHalf>,
    write: OwnedWriteHalf,
}

impl Wire {
    async fn raw(&mut self, data: &[u8]) {
        self.write.write_all(data).await.expect("write request");
    }
    async fn next(&mut self) -> Option<Value> {
        let mut line = String::new();
        let size = timeout(Duration::from_secs(5), self.read.read_line(&mut line))
            .await
            .expect("response timeout")
            .expect("response");
        if size == 0 {
            None
        } else {
            Some(serde_json::from_str(&line).expect("JSON frame"))
        }
    }
    async fn call(&mut self, id: Value, method: &str, params: Value) -> Value {
        self.raw(format!("{}\n", json!({"id":id,"method":method,"params":params})).as_bytes())
            .await;
        self.next().await.expect("response frame")
    }
    async fn observe(&mut self) -> Value {
        self.call(
            json!(1),
            "hello",
            json!({"protocol":"scp/1", "observe":true}),
        )
        .await
    }
}

#[tokio::test]
async fn hello_authorization_notifications_and_malformed_order() {
    let broker = Broker::start("600").await;
    let mut wire = broker.wire().await;
    for method in ["whoami", "unknown"] {
        assert_eq!(
            wire.call(json!(0), method, json!({})).await["error"]["data"]["code"],
            "unauthorized"
        );
    }
    assert_eq!(
        wire.call(
            json!(1),
            "hello",
            json!({"protocol":"scp/2", "observe":true})
        )
        .await["error"]["data"]["code"],
        "invalid_params"
    );
    wire.raw(b"not json\n   \n[1,2]\n{\"id\":{},\"method\":\"hello\"}\n{\"id\":7,\"method\":5}\n{\"id\":8,\"method\":\"hello\",\"params\":[]}\n").await;
    for code in [-32700, -32600, -32600, -32600, -32600] {
        assert_eq!(wire.next().await.expect("error")["error"]["code"], code);
    }
    wire.raw(b"{\"method\":\"hello\",\"params\":{\"protocol\":\"scp/1\",\"observe\":true}}\n{\"id\":\"after\",\"method\":\"cloud_status\"}\n").await;
    let frame = wire.next().await.expect("notification ran");
    assert_eq!(frame["id"], "after");
    assert_eq!(frame["result"], json!({"enabled":false}));
    assert_eq!(
        wire.observe().await["error"]["data"]["code"],
        "invalid_params"
    );
    drop(wire);
    broker.stop().await;
}

#[tokio::test]
async fn observer_hello_limits_and_line_cap() {
    let broker = Broker::start("600").await;
    let mut wire = broker.wire().await;
    let hello = wire.observe().await;
    assert!(hello["result"]["endpoint"].is_null());
    assert_eq!(hello["result"]["limits"]["bodyBytes"], 65536);
    assert!(hello["result"]["limits"]["hopMax"].is_null());
    assert_eq!(
        hello["result"]["capabilities"]
            .as_array()
            .expect("capabilities")
            .len(),
        7
    );
    assert!(
        !hello["result"]["preamble"]
            .as_str()
            .expect("preamble")
            .is_empty()
    );
    let frame = wire
        .call(
            json!("under"),
            "cloud_status",
            json!({"pad":"x".repeat(250 * 1024)}),
        )
        .await;
    assert_eq!(frame["result"], json!({"enabled":false}));
    wire.raw(
        format!(
            "{{\"id\":\"before\",\"method\":\"cloud_status\"}}\n{}\n",
            "x".repeat(256 * 1024 + 1)
        )
        .as_bytes(),
    )
    .await;
    assert_eq!(wire.next().await.expect("earlier response")["id"], "before");
    let frame = wire.next().await.expect("oversize error");
    assert_eq!(frame["error"]["code"], -32600);
    assert_eq!(frame["error"]["data"]["code"], "too_large");
    assert!(wire.next().await.is_none());
    broker.stop().await;
}

#[tokio::test]
async fn human_no_bridge_single_instance_and_permissions() {
    let broker = Broker::start("600").await;
    for (path, mode) in [
        (broker.dir.as_path(), 0o700),
        (broker.socket.parent().expect("parent"), 0o700),
        (broker.socket.as_path(), 0o600),
        (broker.dir.join("relay.db").as_path(), 0o600),
    ] {
        assert_eq!(
            tokio::fs::metadata(path)
                .await
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            mode
        );
    }
    let mut second = Broker::command(&broker.home, &broker.dir, "600")
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("second broker");
    timeout(Duration::from_secs(5), second.wait())
        .await
        .expect("second exits")
        .expect("second status");
    let mut wire = broker.wire().await;
    let hello = wire
        .call(
            json!(1),
            "hello",
            json!({"protocol":"scp/1", "human":true, "tty":true}),
        )
        .await;
    assert_eq!(hello["result"]["endpoint"]["address"], "me/");
    assert_eq!(hello["result"]["endpoint"]["kind"], "human");
    assert_eq!(hello["result"]["endpoint"]["presence"], "online");
    assert_eq!(
        wire.call(json!(2), "cloud_status", json!({})).await["result"],
        json!({"enabled":false})
    );
    assert_eq!(
        wire.call(json!(3), "bridge_relink", json!({})).await["result"],
        json!({"enabled":false})
    );
    assert_eq!(
        wire.call(json!(4), "machine_wake", json!({"url":null}))
            .await["error"]["data"]["code"],
        "unavailable"
    );
    assert_eq!(
        wire.call(json!(5), "unknown", json!({})).await["error"]["code"],
        -32601
    );
    drop(wire);
    broker.stop().await;
}

#[tokio::test]
async fn idle_waits_until_connections_close() -> io::Result<()> {
    let mut broker = Broker::start("0.2").await;
    let mut wire = broker.wire().await;
    wire.observe().await;
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert!(broker.child.try_wait()?.is_none());
    drop(wire);
    let status = timeout(Duration::from_secs(5), broker.child.wait())
        .await
        .expect("idle exit")?;
    assert!(status.success());
    broker.stop().await;
    Ok(())
}
