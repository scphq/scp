use futures_util::{SinkExt, StreamExt};
use scp_relay::{
    admin,
    http::{AppState, Limits, router},
    now_ms,
};
use scp_relay_store::*;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

struct Server {
    url: String,
    store: Arc<dyn RelayStore>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn new() -> Self {
        let store = connect("sqlite::memory:").await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let mut limits = Limits::default();
        limits.apply("revalidateMs=20").unwrap();
        let state = AppState::new(store.clone(), url.clone(), limits)
            .with_cors_origins(vec!["https://console.example.test".into()]);
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self { url, store, task }
    }
    async fn mint(&self, handle: &str, device: bool) -> (String, Credential) {
        admin::account(self.store.as_ref(), handle).await.unwrap();
        let (a, m) = admin::member(self.store.as_ref(), handle, "owner", None, None)
            .await
            .unwrap();
        let (secret, c) = admin::credential(&a, &m, device, "cli".into(), None);
        self.store.create_credential(c.clone()).await.unwrap();
        (secret, c)
    }
}
#[tokio::test]
async fn public_routes_bearer_session_isolation_cors_and_removed_ui() {
    let s = Server::new().await;
    let client = reqwest::Client::new();
    let (a, _) = s.mint("team", false).await;
    let (b, _) = s.mint("other", true).await;
    for route in ["session", "overview", "graph", "events"] {
        let url = format!("{}/v1/dashboard/{route}", s.url);
        for token in [None, Some("scp_t_invalid")] {
            let mut req = client.get(&url);
            if let Some(token) = token {
                req = req.bearer_auth(token);
            }
            let response = req.send().await.unwrap();
            assert_eq!(response.status(), 401);
            assert_eq!(response.headers()["cache-control"], "no-store");
            assert_eq!(
                response.json::<Value>().await.unwrap(),
                json!({"error":"unauthorized"})
            );
        }
        for origin in ["https://console.example.test", "https://other.example.test"] {
            let response = client
                .request(reqwest::Method::OPTIONS, &url)
                .header("origin", origin)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 204);
            assert_eq!(
                response
                    .headers()
                    .get("access-control-allow-origin")
                    .is_some(),
                origin == "https://console.example.test"
            );
            assert!(
                !response
                    .headers()
                    .contains_key("access-control-allow-credentials")
            );
        }
    }
    for (token, account, scoped) in [(&a, "team", true), (&b, "other", false)] {
        let response = client
            .get(format!("{}/v1/dashboard/session?account=team", s.url))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert!(!response.headers().contains_key("set-cookie"));
        let session: Value = response.json().await.unwrap();
        assert_eq!(session["org"]["handle"], account);
        assert_eq!(session["scoped"], scoped);
        assert_eq!(session["member"]["role"], "owner");
        assert!(session.get("csrf").is_none());
    }
    for path in [
        "/",
        "/sign-in",
        "/orgs/team",
        "/selfhost.js",
        "/v1/dashboard/sign-in",
        "/v1/dashboard/sign-out",
        "/v1/dashboard/device",
        "/v1/dashboard/device/poll",
        "/orgs/team/events",
    ] {
        assert_eq!(
            client
                .get(format!("{}{path}", s.url))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
    }
    assert!(
        client
            .get(format!("{}/device", s.url))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
            .contains("device approve")
    );
    assert!(
        !client
            .get(format!("{}/health", s.url))
            .header("origin", "https://console.example.test")
            .send()
            .await
            .unwrap()
            .headers()
            .contains_key("access-control-allow-origin")
    );
}
#[tokio::test]
async fn websocket_and_sse_hello_ping_and_revocation() {
    let s = Server::new().await;
    let (token, c) = s.mint("team", false).await;
    let mut request = format!("{}/v1/dashboard/events", s.url.replace("http", "ws"))
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    let (mut ws, _) = connect_async(request).await.unwrap();
    let hello: Value =
        serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(hello["type"], "hello");
    ws.send(Message::Text("ping".into())).await.unwrap();
    assert_eq!(ws.next().await.unwrap().unwrap().to_text().unwrap(), "pong");
    let response = reqwest::Client::new()
        .get(format!("{}/v1/dashboard/events", s.url))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut stream = response;
    let hello = stream.chunk().await.unwrap().unwrap();
    assert!(String::from_utf8_lossy(&hello).contains("\"type\":\"hello\""));
    s.store.revoke_credential(&c.id, now_ms()).await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Close(Some(frame)) = closed else {
        panic!("close")
    };
    assert_eq!(u16::from(frame.code), 4003);
    assert!(
        tokio::time::timeout(Duration::from_secs(2), stream.chunk())
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn custom_chain_covers_http_and_both_socket_transports() {
    use scp_relay::{AuthChain, AuthOutcome, AuthRequest, Identity, RelayAuth};
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Custom {
        active: Arc<AtomicBool>,
        unavailable: Arc<AtomicBool>,
        identity: Identity,
    }
    #[async_trait::async_trait]
    impl RelayAuth for Custom {
        async fn authenticate(&self, request: &AuthRequest) -> AuthOutcome {
            assert!(request.peer.ip().is_loopback());
            if self.unavailable.load(Ordering::SeqCst) {
                return AuthOutcome::Unavailable("database offline".into());
            }
            if self.active.load(Ordering::SeqCst) {
                AuthOutcome::Identity(Box::new(self.identity.clone()))
            } else {
                AuthOutcome::Reject("unauthorized".into())
            }
        }
    }
    struct Fallback;
    #[async_trait::async_trait]
    impl RelayAuth for Fallback {
        async fn authenticate(&self, _: &AuthRequest) -> AuthOutcome {
            panic!("terminal authentication must not fall through")
        }
    }
    let store = connect("sqlite::memory:").await.unwrap();
    let a = admin::account(store.as_ref(), "custom").await.unwrap();
    let (_, m) = admin::member(store.as_ref(), "custom", "operator", None, None)
        .await
        .unwrap();
    let (_, c) = admin::credential(&a, &m, true, "custom".into(), None);
    let identity = scp_relay_store::Identity {
        account: a,
        member: m,
        credential: c,
    }
    .into();
    let active = Arc::new(AtomicBool::new(true));
    let unavailable = Arc::new(AtomicBool::new(false));
    let mut limits = Limits::default();
    limits.apply("revalidateMs=20").unwrap();
    let state = AppState::new(store, "http://localhost".into(), limits).with_auth(AuthChain(vec![
        Arc::new(Custom {
            active: active.clone(),
            unavailable: unavailable.clone(),
            identity,
        }),
        Arc::new(Fallback),
    ]));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let client = reqwest::Client::new();
    for path in [
        "/v1/whoami",
        "/v1/dashboard/session",
        "/v1/dashboard/overview",
        "/v1/dashboard/graph",
    ] {
        assert_eq!(
            client
                .get(format!("{url}{path}"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    let rpc: Value = client.post(format!("{url}/v1/relay/rpc")).json(&json!({"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":"scp/1","machine":"desk","claim":{"handle":"agent"}}})).send().await.unwrap().json().await.unwrap();
    assert!(rpc.get("result").is_some(), "{rpc}");
    let (mut relay, _) = connect_async(format!("{}/v1/relay/ws", url.replace("http", "ws")))
        .await
        .unwrap();
    let (mut dashboard, _) =
        connect_async(format!("{}/v1/dashboard/events", url.replace("http", "ws")))
            .await
            .unwrap();
    assert!(
        dashboard
            .next()
            .await
            .unwrap()
            .unwrap()
            .to_text()
            .unwrap()
            .contains("hello")
    );
    let mut sse = client
        .get(format!("{url}/v1/dashboard/events"))
        .send()
        .await
        .unwrap();
    assert!(sse.chunk().await.unwrap().is_some());
    unavailable.store(true, Ordering::SeqCst);
    for path in [
        "/v1/whoami",
        "/v1/dashboard/session",
        "/v1/dashboard/overview",
        "/v1/dashboard/graph",
        "/v1/dashboard/events",
    ] {
        let response = client.get(format!("{url}{path}")).send().await.unwrap();
        assert_eq!(response.status(), 503);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"error":"server_error"})
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(80), dashboard.next())
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(80), sse.chunk())
            .await
            .is_err()
    );
    let close = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(Ok(Message::Close(frame))) = relay.next().await {
                break frame;
            }
        }
    })
    .await
    .unwrap();
    assert!(matches!(close, Some(frame) if u16::from(frame.code) == 1013));
    unavailable.store(false, Ordering::SeqCst);
    dashboard.send(Message::Text("ping".into())).await.unwrap();
    assert_eq!(
        dashboard.next().await.unwrap().unwrap().to_text().unwrap(),
        "pong"
    );
    active.store(false, Ordering::SeqCst);
    assert_eq!(
        client
            .get(format!("{url}/v1/whoami"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let close = tokio::time::timeout(Duration::from_secs(2), dashboard.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(close,Message::Close(Some(frame)) if u16::from(frame.code)==4003));
    assert!(
        tokio::time::timeout(Duration::from_secs(2), sse.chunk())
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
    task.abort();
}

#[tokio::test]
async fn dashboard_never_uses_a_query_account() {
    let s = Server::new().await;
    let client = reqwest::Client::new();
    let (a, _) = s.mint("team", true).await;
    let (b, _) = s.mint("other", true).await;
    let hello: Value = client.post(format!("{}/v1/relay/rpc",s.url)).bearer_auth(&a).json(&json!({"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":"scp/1","machine":"desk","claim":{"handle":"agent"}}})).send().await.unwrap().json().await.unwrap();
    assert!(hello.get("result").is_some(), "{hello}");
    for route in ["overview", "graph"] {
        let url = format!("{}/v1/dashboard/{route}?account=team", s.url);
        let own = client
            .get(&url)
            .bearer_auth(&a)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(own.contains("team/desk/agent"), "{own}");
        let other = client
            .get(&url)
            .bearer_auth(&b)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(!other.contains("team/desk/agent"), "{other}");
    }
}

#[tokio::test]
async fn trusted_headers_use_tcp_peer_and_native_rejection_is_terminal() {
    use scp_relay::auth::{AuthChain, HeaderMapConfig, NativeAuth, TrustedHeaderAuth};
    for trusted in [true, false] {
        let store = connect("sqlite::memory:").await.unwrap();
        admin::account(store.as_ref(), "team").await.unwrap();
        let mapping: HeaderMapConfig = serde_json::from_value(json!({"default":null,"users":{"person@example.test":{"account":"team","member":"operator","role":"member"}}})).unwrap();
        let chain = AuthChain(vec![
            Arc::new(NativeAuth::new(store.clone())),
            Arc::new(
                TrustedHeaderAuth::new(
                    store.clone(),
                    vec![
                        if trusted {
                            "127.0.0.0/8"
                        } else {
                            "192.0.2.0/24"
                        }
                        .parse()
                        .unwrap(),
                    ],
                    "x-forwarded-user",
                    "x-forwarded-email",
                    mapping,
                )
                .unwrap(),
            ),
        ]);
        let state = AppState::new(store.clone(), "http://localhost".into(), Limits::default())
            .with_auth(chain);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::new();
        let response = client
            .get(format!("{url}/v1/dashboard/session"))
            .header("x-forwarded-user", "person")
            .header("x-forwarded-email", "person@example.test")
            .header("x-forwarded-for", "192.0.2.1")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), if trusted { 200 } else { 401 });
        if trusted {
            let session: Value = response.json().await.unwrap();
            assert_eq!(session["org"]["handle"], "team");
            assert_eq!(session["member"]["name"], "operator");
            assert_eq!(session["member"]["role"], "member");
            assert_eq!(session["scoped"], false);
            let response = client
                .get(format!("{url}/v1/dashboard/session"))
                .header("x-forwarded-user", "person@example.test")
                .bearer_auth("scp_t_unknown")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 401);
        }
        task.abort();
    }
}

#[tokio::test]
async fn historic_dashboard_query_includes_flagged_agents() {
    let s = Server::new().await;
    let (token, _) = s.mint("team", false).await;
    let account = s.store.account("team").await.unwrap().unwrap();
    let old = now_ms() - 3_700_000;
    for (id, kind) in [("stale", "agent"), ("human", "human")] {
        s.store
            .put_endpoint(
                &account.id,
                Endpoint {
                    id: id.into(),
                    machine: "host".into(),
                    handle: id.into(),
                    kind: kind.into(),
                    token_hash: None,
                    last_seen: Some(old),
                    created_at: old,
                    fields: json!({"presence":"online"}).to_string(),
                },
            )
            .await
            .unwrap();
    }
    let client = reqwest::Client::new();
    for (route, key) in [("overview", "endpoints"), ("graph", "nodes")] {
        for query in [
            "",
            "?historic=0",
            "?historic=false",
            "?historic=1",
            "?historic=true",
        ] {
            let response = client
                .get(format!("{}/v1/dashboard/{route}{query}", s.url))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            let body: Value = response.json().await.unwrap();
            let rows = body[key].as_array().unwrap();
            let include = matches!(query, "?historic=1" | "?historic=true");
            assert_eq!(
                rows.len(),
                if include { 2 } else { 1 },
                "{route}{query}: {body}"
            );
            assert!(
                rows.iter()
                    .find(|e| e["kind"] == "human")
                    .unwrap()
                    .get("historic")
                    .is_none()
            );
            if include {
                assert_eq!(
                    rows.iter().find(|e| e["kind"] == "agent").unwrap()["historic"],
                    true
                );
            }
        }
    }
}
