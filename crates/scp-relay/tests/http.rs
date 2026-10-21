use futures_util::{SinkExt, StreamExt};
use scp_relay::{
    admin, hash,
    http::{AppState, Limits, router},
    now_ms,
};
use scp_relay_store::*;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

struct Server {
    url: String,
    store: Arc<dyn RelayStore>,
    state: AppState,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.state.hub.shutdown();
        self.task.abort();
    }
}
async fn start() -> Server {
    start_with_limits(Limits::default()).await
}
async fn start_with_limits(limits: Limits) -> Server {
    let store = connect("sqlite::memory:").await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let state = AppState::new(store.clone(), url.clone(), limits);
    let app = router(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Server {
        url,
        store,
        state,
        task,
    }
}
async fn mint(s: &Server, device: bool, expiry: Option<i64>) -> (String, Credential) {
    let (a, m) = admin::member(
        s.store.as_ref(),
        "acme",
        "operator",
        Some("operator@example.test".into()),
        None,
    )
    .await
    .unwrap();
    let (secret, c) = admin::credential(&a, &m, device, scp_relay::random("cli-"), expiry);
    s.store.create_credential(c.clone()).await.unwrap();
    (secret, c)
}
async fn body(response: reqwest::Response, status: u16) -> Value {
    assert_eq!(response.status().as_u16(), status);
    response.json().await.unwrap()
}

#[tokio::test]
async fn routes_and_authentication() {
    let s = start().await;
    admin::account(s.store.as_ref(), "acme").await.unwrap();
    let client = reqwest::Client::new();
    assert_eq!(
        body(
            client
                .get(format!("{}/health", s.url))
                .send()
                .await
                .unwrap(),
            200
        )
        .await,
        json!({"ok":true,"service":"scp-relay"})
    );
    assert_eq!(
        body(
            client
                .get(format!("{}/unknown", s.url))
                .send()
                .await
                .unwrap(),
            404
        )
        .await,
        json!({"error":"not_found"})
    );
    let (secret, c) = mint(&s, true, None).await;
    let who = body(
        client
            .get(format!("{}/v1/whoami", s.url))
            .bearer_auth(&secret)
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    assert_eq!(who["kind"], "device");
    assert_eq!(who["org"], "acme");
    assert_eq!(who["role"], "owner");
    assert_eq!(who["email"], "operator@example.test");
    assert_eq!(who["ambient"], false);
    assert!(who["expires_at"].is_null());
    for path in ["/v1/whoami", "/v1/relay/rpc"] {
        let req = if path.ends_with("rpc") {
            client
                .post(format!("{}{path}", s.url))
                .json(&json!({"method":"hello","id":1}))
        } else {
            client.get(format!("{}{path}", s.url))
        };
        assert_eq!(
            body(req.send().await.unwrap(), 401).await["error"],
            "unauthorized"
        );
    }
    for value in ["unknown".to_string(), format!("scp_t_{}", "x".repeat(129))] {
        assert_eq!(
            body(
                client
                    .get(format!("{}/v1/whoami", s.url))
                    .bearer_auth(value)
                    .send()
                    .await
                    .unwrap(),
                401
            )
            .await["error"],
            "invalid"
        );
    }
    assert_eq!(
        body(
            client
                .get(format!("{}/v1/whoami?token={secret}", s.url))
                .header("cookie", format!("token={secret}"))
                .send()
                .await
                .unwrap(),
            401
        )
        .await["error"],
        "unauthorized"
    );
    let (token, _) = mint(&s, false, None).await;
    let who = body(
        client
            .get(format!("{}/v1/whoami", s.url))
            .bearer_auth(token)
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    assert_eq!(who["ambient"], true);
    assert!(who["endpoint_labels"]["token"].as_str().is_some());
    let (expired, _) = mint(&s, true, Some(now_ms() - 1)).await;
    assert_eq!(
        body(
            client
                .get(format!("{}/v1/whoami", s.url))
                .bearer_auth(expired)
                .send()
                .await
                .unwrap(),
            401
        )
        .await["error"],
        "expired"
    );
    s.store.revoke_credential(&c.id, now_ms()).await.unwrap();
    assert_eq!(
        body(
            client
                .get(format!("{}/v1/whoami", s.url))
                .bearer_auth(secret)
                .send()
                .await
                .unwrap(),
            401
        )
        .await["error"],
        "revoked"
    );
    assert_eq!(
        client
            .get(format!("{}/v1/relay/ws", s.url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .get(format!("{}/v1/relay/rpc", s.url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let (secret, _) = mint(&s, true, None).await;
    let response=body(client.post(format!("{}/v1/relay/rpc",s.url)).bearer_auth(secret).json(&json!([{"jsonrpc":"2.0","id":2,"method":"hello"},{"jsonrpc":"2.0","id":3,"method":"other"}])).send().await.unwrap(),200).await;
    assert_eq!(response[0]["id"], 2);
    assert_eq!(response[1]["id"], 3);
    assert_eq!(response[0]["error"]["code"], -32602);
}
#[tokio::test]
async fn device_flow_and_json_validation() {
    let s = start().await;
    admin::account(s.store.as_ref(), "acme").await.unwrap();
    let client = reqwest::Client::new();
    for payload in ["[]", "null", "broken"] {
        let response = body(
            client
                .post(format!("{}/v1/device/code", s.url))
                .header("content-type", "application/json")
                .body(payload)
                .send()
                .await
                .unwrap(),
            400,
        )
        .await;
        assert_eq!(response["error"], "invalid_request");
        assert!(response["error_description"].is_string());
    }
    assert_eq!(
        body(
            client
                .post(format!("{}/v1/device/code", s.url))
                .header("content-type", "application/x-www-form-urlencoded")
                .body("label=cli")
                .send()
                .await
                .unwrap(),
            400
        )
        .await["error"],
        "invalid_request"
    );
    assert_eq!(
        body(
            client
                .post(format!("{}/v1/device/code", s.url))
                .json(&json!({"label":"BAD"}))
                .send()
                .await
                .unwrap(),
            400
        )
        .await["error"],
        "invalid_request"
    );
    let code = body(
        client
            .post(format!("{}/v1/device/code", s.url))
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    assert_eq!(code["interval"], 5);
    assert_eq!(code["expires_in"], 900);
    assert_eq!(code["verification_uri"], format!("{}/device", s.url));
    let raw = code["device_code"].as_str().unwrap();
    let input = json!({"device_code":raw,"grant_type":"ignored"});
    assert_eq!(
        body(
            client
                .post(format!("{}/v1/device/token", s.url))
                .json(&input)
                .send()
                .await
                .unwrap(),
            400
        )
        .await["error"],
        "authorization_pending"
    );
    assert_eq!(
        body(
            client
                .post(format!("{}/v1/device/token", s.url))
                .json(&input)
                .send()
                .await
                .unwrap(),
            400
        )
        .await["error"],
        "slow_down"
    );
    let (a, m) = admin::member(s.store.as_ref(), "acme", "operator", None, None)
        .await
        .unwrap();
    s.store
        .approve_device(
            &scp_relay::normalize_code(code["user_code"].as_str().unwrap()),
            &a.id,
            &m.id,
            now_ms(),
        )
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5050)).await;
    let result = body(
        client
            .post(format!("{}/v1/device/token", s.url))
            .json(&input)
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    assert_eq!(result["org"], "acme");
    assert_eq!(result["label"], "cli");
    assert_eq!(result["relay"], s.url);
    assert_eq!(result["token_type"], "Bearer");
    let secret = result["access_token"].as_str().unwrap();
    assert!(secret.starts_with("scp_d_"));
    assert_eq!(
        body(
            client
                .get(format!("{}/v1/whoami", s.url))
                .bearer_auth(secret)
                .send()
                .await
                .unwrap(),
            200
        )
        .await["kind"],
        "device"
    );
    assert_eq!(
        body(
            client
                .post(format!("{}/v1/device/token", s.url))
                .json(&input)
                .send()
                .await
                .unwrap(),
            400
        )
        .await["error"],
        "invalid_grant"
    );
    for (state, error) in [
        (DeviceState::Denied, "access_denied"),
        (DeviceState::Pending, "expired_token"),
    ] {
        let raw = scp_relay::random("");
        let code = DeviceCode {
            device_code_hash: hash(&raw),
            user_code: raw.clone(),
            label: "cli".into(),
            created_at: 0,
            expires_at: if state == DeviceState::Pending {
                1
            } else {
                i64::MAX
            },
            last_poll_at: None,
            state: DeviceState::Pending,
            account_id: None,
            member_id: None,
            credential_id: None,
        };
        s.store.create_device_code(code).await.unwrap();
        if state == DeviceState::Denied {
            s.store.deny_device(&raw, now_ms()).await.unwrap();
        }
        assert_eq!(
            body(
                client
                    .post(format!("{}/v1/device/token", s.url))
                    .json(&json!({"device_code":raw}))
                    .send()
                    .await
                    .unwrap(),
                400
            )
            .await["error"],
            error
        );
    }
}
async fn socket(
    s: &Server,
    secret: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = s.url.replacen("http://", "ws://", 1);
    let mut request = format!("{url}/v1/relay/ws").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {secret}").parse().unwrap());
    connect_async(request).await.unwrap().0
}
#[tokio::test]
async fn websocket_frames_expiry_and_shutdown() {
    let s = start().await;
    admin::account(s.store.as_ref(), "acme").await.unwrap();
    let (secret, _) = mint(&s, true, None).await;
    let mut ws = socket(&s, &secret).await;
    ws.send(Message::Text(
        json!({"jsonrpc":"2.0","id":7,"method":"hello"})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let frame = ws.next().await.unwrap().unwrap();
    let response: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(response["id"], 7);
    assert_eq!(response["error"]["code"], -32602);
    ws.send(Message::Text("x".repeat(262145).into()))
        .await
        .unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let error: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(error["error"]["data"]["code"], "too_large");
    let frame = ws.next().await.unwrap().unwrap();
    match frame {
        Message::Close(Some(c)) => assert_eq!(u16::from(c.code), 1009),
        other => panic!("unexpected frame {other:?}"),
    }
    let mut ws = socket(&s, &secret).await;
    s.state.hub.shutdown();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match frame {
        Message::Close(Some(c)) => assert_eq!(u16::from(c.code), 1001),
        other => panic!("unexpected frame {other:?}"),
    }
    let s = start().await;
    admin::account(s.store.as_ref(), "acme").await.unwrap();
    let (secret, _) = mint(&s, true, Some(now_ms() + 200)).await;
    let mut ws = socket(&s, &secret).await;
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let notice: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(notice["method"], "revoked");
    assert_eq!(
        notice["params"]["reason"],
        "the token grant expired, reconnect"
    );
    let frame = ws.next().await.unwrap().unwrap();
    match frame {
        Message::Close(Some(c)) => assert_eq!(u16::from(c.code), 4001),
        other => panic!("unexpected frame {other:?}"),
    }
}
#[test]
fn limits_validate() {
    let mut l = Limits::default();
    l.apply("machines=Infinity").unwrap();
    assert_eq!(l.0["machines"], None);
    l.apply("frameBytes=42").unwrap();
    assert_eq!(l.0["frameBytes"], Some(42));
    assert!(l.apply("httpWaitS=Infinity").is_err());
    assert!(l.apply("unknown=1").is_err());
    assert!(l.apply("revalidateMs=0").is_err());
}

#[tokio::test]
async fn websocket_revocation_sends_notification_before_close() {
    let mut limits = Limits::default();
    limits.apply("revalidateMs=20").unwrap();
    let s = start_with_limits(limits).await;
    admin::account(s.store.as_ref(), "acme").await.unwrap();
    let (secret, credential) = mint(&s, true, None).await;
    let mut ws = socket(&s, &secret).await;
    s.store
        .revoke_credential(&credential.id, now_ms())
        .await
        .unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let notification: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(notification["method"], "revoked");
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match frame {
        Message::Close(Some(close)) => assert_eq!(u16::from(close.code), 1008),
        other => panic!("unexpected frame {other:?}"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn process_sigterm_flushes_socket_close() {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let binary = env!("CARGO_BIN_EXE_scp-relay");
    let target = std::env::var("CARGO_TARGET_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"));
    tokio::fs::create_dir_all(&target).await.unwrap();
    let file = target.join(format!("signal-test-{}.db", scp_relay::random("")));
    let store = format!("sqlite://{}", file.display());
    let mut process = tokio::process::Command::new(binary)
        .args(["serve", "--listen", "127.0.0.1:0", "--store", &store])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut line = String::new();
    let mut stdout = BufReader::new(process.stdout.take().unwrap());
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        stdout.read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    let event: Value = serde_json::from_str(&line).unwrap();
    let account = tokio::process::Command::new(binary)
        .args(["account", "create", "acme", "--store", &store])
        .output()
        .await
        .unwrap();
    assert!(account.status.success());
    let output = tokio::process::Command::new(binary)
        .args([
            "token",
            "create",
            "--account",
            "acme",
            "--member",
            "operator",
            "--device",
            "--store",
            &store,
        ])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let credential: Value = serde_json::from_slice(&output.stdout).unwrap();
    let address = event["url"]
        .as_str()
        .unwrap()
        .replacen("http://", "ws://", 1);
    let mut request = format!("{address}/v1/relay/ws")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", credential["token"].as_str().unwrap())
            .parse()
            .unwrap(),
    );
    let (mut ws, _) = connect_async(request).await.unwrap();
    let killed = tokio::process::Command::new("kill")
        .args(["-TERM", &process.id().unwrap().to_string()])
        .status()
        .await
        .unwrap();
    assert!(killed.success());
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match frame {
        Message::Close(Some(close)) => assert_eq!(u16::from(close.code), 1001),
        other => panic!("unexpected frame {other:?}"),
    }
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), process.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    tokio::fs::remove_file(file).await.unwrap();
}

#[tokio::test]
async fn device_code_capacity_and_pruning() {
    let s = start().await;
    let now = now_ms();
    for n in 0..1000 {
        s.store
            .create_device_code(DeviceCode {
                device_code_hash: format!("capacity-{n}"),
                user_code: format!("CAPACITY{n}"),
                label: "cli".into(),
                created_at: now,
                expires_at: now + 900000,
                last_poll_at: None,
                state: DeviceState::Pending,
                account_id: None,
                member_id: None,
                credential_id: None,
            })
            .await
            .unwrap();
    }
    let client = reqwest::Client::new();
    let response = body(
        client
            .post(format!("{}/v1/device/code", s.url))
            .json(&json!({}))
            .send()
            .await
            .unwrap(),
        429,
    )
    .await;
    assert_eq!(response["error"], "slow_down");
    s.store.deny_device("CAPACITY0", now).await.unwrap();
    let response = body(
        client
            .post(format!("{}/v1/device/code", s.url))
            .json(&json!({}))
            .send()
            .await
            .unwrap(),
        200,
    )
    .await;
    assert!(response["device_code"].is_string());
    assert!(s.store.device_code("CAPACITY0").await.unwrap().is_none());
}

#[tokio::test]
async fn socket_cap_returns_http_429_and_rpc_does_not_consume_a_socket() {
    let mut limits = Limits::default();
    limits.apply("sockets=1").unwrap();
    let s = start_with_limits(limits).await;
    admin::account(s.store.as_ref(), "acme").await.unwrap();
    let (secret, _) = mint(&s, true, None).await;
    let mut first = socket(&s, &secret).await;
    let mut request = format!("{}/v1/relay/ws", s.url.replace("http://", "ws://"))
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {secret}").parse().unwrap());
    match connect_async(request).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status().as_u16(), 429);
            assert_eq!(
                serde_json::from_slice::<Value>(response.body().as_ref().unwrap()).unwrap(),
                json!({"error":"too_many_sockets"})
            );
        }
        other => panic!("unexpected upgrade result {other:?}"),
    }
    let response = reqwest::Client::new()
        .post(format!("{}/v1/relay/rpc", s.url))
        .bearer_auth(&secret)
        .json(&json!({"id":1,"method":"hello","params":{"protocol":"scp/1","observe":true}}))
        .send()
        .await
        .unwrap();
    assert!(body(response, 200).await.get("error").is_none());
    first.close(None).await.unwrap();
    let _ = first.next().await;
    tokio::time::timeout(std::time::Duration::from_secs(3), s.state.hub.wait_closed())
        .await
        .unwrap();
    let _second = socket(&s, &secret).await;
}
#[tokio::test]
async fn authenticated_requests_throttle_credential_last_used_writes() {
    let s = start().await;
    admin::account(s.store.as_ref(), "acme").await.unwrap();
    let (secret, c) = mint(&s, true, None).await;
    let client = reqwest::Client::new();
    let mut last = None;
    for _ in 0..3 {
        let response = client
            .get(format!("{}/v1/whoami", s.url))
            .bearer_auth(&secret)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let CredentialLookup::Active(identity) =
            s.store.credential_by_id(&c.id, now_ms()).await.unwrap()
        else {
            panic!("inactive credential")
        };
        let at = identity.credential.last_used_at;
        assert!(at.is_some());
        if let Some(last) = last {
            assert_eq!(at, Some(last));
        }
        last = at;
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn oversized_frames_send_too_large_before_closing_1009() {
    let mut limits = Limits::default();
    limits.apply("frameBytes=128").unwrap();
    let s = start_with_limits(limits).await;
    admin::account(s.store.as_ref(), "acme").await.unwrap();
    let (secret, _) = mint(&s, true, None).await;
    let mut ws = socket(&s, &secret).await;
    ws.send(Message::Text("x".repeat(129).into()))
        .await
        .unwrap();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let response: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
    assert_eq!(response["error"]["data"]["code"], "too_large");
    assert_eq!(response["error"]["message"], "a frame is at most 128 bytes");
    let frame = ws.next().await.unwrap().unwrap();
    match frame {
        Message::Close(Some(close)) => assert_eq!(u16::from(close.code), 1009),
        other => panic!("unexpected frame {other:?}"),
    }
    let response = reqwest::Client::new()
        .post(format!("{}/v1/relay/rpc", s.url))
        .bearer_auth(&secret)
        .json(&json!({"method":"hello","params":{"padding":"x".repeat(129)}}))
        .send()
        .await
        .unwrap();
    let response = body(response, 200).await;
    assert_eq!(response["error"]["data"]["code"], "too_large");
    assert_eq!(
        response["error"]["message"],
        "a request is at most 128 bytes"
    );
}
