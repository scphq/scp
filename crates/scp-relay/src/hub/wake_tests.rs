use super::*;
use crate::hub::tests::{bridge, request, view};
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
};
use scp_relay_store::{Account, ContactConfig};
use std::collections::VecDeque;

const SECRET: &str = "wake-secret-0123456789abcdef";
#[derive(Clone)]
struct Receiver {
    calls: mpsc::UnboundedSender<(HeaderMap, String)>,
    answers: Arc<Mutex<VecDeque<(u16, Value)>>>,
    release: Arc<tokio::sync::Semaphore>,
    blocked: bool,
}
struct Server {
    url: String,
    calls: mpsc::UnboundedReceiver<(HeaderMap, String)>,
    release: Arc<tokio::sync::Semaphore>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn receive(
    State(s): State<Receiver>,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, axum::Json<Value>) {
    s.calls
        .send((headers, String::from_utf8(body.to_vec()).unwrap()))
        .unwrap();
    if s.blocked {
        s.release.acquire().await.unwrap().forget();
    }
    let (status, value) = s
        .answers
        .lock()
        .await
        .pop_front()
        .unwrap_or((200, json!({})));
    (StatusCode::from_u16(status).unwrap(), axum::Json(value))
}
impl Server {
    async fn new(answers: Vec<(u16, Value)>, blocked: bool) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/wake", listener.local_addr().unwrap());
        let (calls, rx) = mpsc::unbounded_channel();
        let answers = Arc::new(Mutex::new(answers.into()));
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let app = Router::new()
            .route("/wake", post(receive))
            .with_state(Receiver {
                calls,
                answers: answers.clone(),
                release: release.clone(),
                blocked,
            });
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            url,
            calls: rx,
            release,
            task,
        }
    }
    async fn call(&mut self) -> (HeaderMap, String) {
        tokio::time::timeout(Duration::from_secs(3), self.calls.recv())
            .await
            .unwrap()
            .unwrap()
    }
    async fn none(&mut self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(30), self.calls.recv())
                .await
                .is_err()
        );
    }
}
struct Env {
    hub: Arc<Hub>,
    grant: Grant,
    account: Account,
    local: Arc<Mutex<AccountHub>>,
    source: String,
    watcher: mpsc::Receiver<String>,
    target: String,
}
async fn identity(store: &dyn RelayStore) -> (Account, Grant) {
    let name: String = crate::random("wake").chars().take(24).collect();
    let account = crate::admin::account(store, &name).await.unwrap();
    let (_, member) = crate::admin::member(store, &name, "member", None, None)
        .await
        .unwrap();
    let (_, credential) = crate::admin::credential(&account, &member, true, "test".into(), None);
    store.create_credential(credential.clone()).await.unwrap();
    let grant = Grant {
        token_id: credential.id,
        user_id: account.id.clone(),
        actor_id: member.id,
        role: Role::Owner,
        scoped: false,
        labels: BTreeMap::new(),
        expires_at: i64::MAX,
        account: name,
    };
    (account, grant)
}
async fn env(server: &Server, options: &[&str]) -> Env {
    env_store(
        server,
        options,
        &std::env::var("SCP_RELAY_TEST_PG").unwrap_or_else(|_| "sqlite::memory:".into()),
    )
    .await
}
async fn env_store(server: &Server, options: &[&str], url: &str) -> Env {
    let store = scp_relay_store::connect(url).await.unwrap();
    let (account, grant) = identity(store.as_ref()).await;
    let mut wake = WakeOptions::default();
    for option in options {
        wake.apply(option).unwrap();
    }
    let hub = Arc::new(Hub::new(store, crate::http::Limits::default()).with_wake(wake));
    let (local, source, watcher) = bridge(&hub, &grant, "laptop").await;
    let result = hub
        .call(
            &local,
            &source,
            request(
                2,
                "mirror",
                json!({"endpoints":[view("root"), view("other")]}),
            ),
            false,
        )
        .await;
    assert!(result["error"].is_null(), "{result}");
    local
        .lock()
        .await
        .connections
        .get_mut(&source)
        .unwrap()
        .watching = true;
    let (_, desk, _rx) = bridge(&hub, &grant, "desk").await;
    let mut row = view("review");
    row["presence"] = json!("hibernated");
    row["wake"] = json!("hook:vm");
    for (method, params) in [
        ("mirror", json!({"endpoints":[row]})),
        ("machine_wake", json!({"url":server.url,"secret":SECRET})),
    ] {
        let result = hub
            .call(&local, &desk, request(3, method, params), false)
            .await;
        assert!(result["error"].is_null(), "{result}");
    }
    local.lock().await.closed(&desk, false).await;
    let target = local
        .lock()
        .await
        .endpoints()
        .await
        .unwrap()
        .iter()
        .find(|e| e.machine == "desk")
        .unwrap()
        .id
        .clone();
    Env {
        hub,
        grant,
        account,
        local,
        source,
        watcher,
        target,
    }
}
impl Env {
    async fn send(&self, sender: &str) -> Value {
        let reply = self.hub.call(&self.local, &self.source, request(5, "forward", json!({"from":sender,"params":{"to":"desk/review","body":"PRIVATE-MESSAGE-BODY","kind":"request"}})), false).await;
        assert!(reply["error"].is_null(), "{reply}");
        reply["result"].clone()
    }
    async fn state(&self) -> WakeState {
        self.local
            .lock()
            .await
            .wake_state("desk")
            .await
            .unwrap()
            .unwrap()
    }
    async fn settled(&self) -> WakeState {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let s = self.state().await;
                if s.call.is_none() {
                    break s;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn shown(&self) -> Value {
        let hub = self.local.lock().await;
        let row = hub
            .endpoints()
            .await
            .unwrap()
            .into_iter()
            .find(|e| e.id == self.target)
            .unwrap();
        hub.view(&row)
    }
    async fn due(&self) {
        let hub = self.local.lock().await;
        let mut s = hub.wake_state("desk").await.unwrap().unwrap();
        s.next = crate::now_ms() - MIN_RETRY_MS - 1;
        if let Some(d) = &mut s.declined {
            d.until = Some(crate::now_ms() - 1);
        }
        if s.retry_at.is_some() {
            s.retry_at = Some(crate::now_ms() - 1);
        }
        hub.set_wake_state("desk", &s).await.unwrap();
    }
    async fn alarm(&self) {
        self.local
            .lock()
            .await
            .sweep_wakes(crate::now_ms())
            .await
            .unwrap();
    }
    async fn restart(&mut self) {
        let (store, options) = {
            let hub = self.local.lock().await;
            (hub.store.clone(), hub.wake_options.clone())
        };
        self.hub = Arc::new(Hub::new(store, crate::http::Limits::default()).with_wake(options));
        self.local = self.hub.account(&self.grant).await;
        self.local.lock().await.initialize().await.unwrap();
        let (local, source, watcher) = bridge(&self.hub, &self.grant, "laptop").await;
        self.local = local;
        self.source = source;
        self.watcher = watcher;
    }
    async fn presence(&mut self, waking: bool) {
        let mut found = false;
        while let Ok(text) = self.watcher.try_recv() {
            let v: Value = serde_json::from_str(&text).unwrap();
            if v["params"]["type"] == "presence" && v["params"]["waking"] == waking {
                found = true;
            }
        }
        assert!(found, "missing waking={waking} presence");
    }
}
#[tokio::test]
async fn signed_metadata_debounce_waking_timeout_and_restart() {
    let mut server = Server::new(vec![], false).await;
    let mut e = env(&server, &["debounceS=0.04", "wakingTimeoutS=30"]).await;
    let sent = e.send("root").await;
    let (headers, raw) = server.call().await;
    assert_eq!(headers["content-type"], "application/json");
    let timestamp = headers["x-scp-timestamp"].to_str().unwrap();
    assert!((crate::now_ms() - timestamp.parse::<i64>().unwrap()).abs() < 3000);
    let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
    mac.update(format!("{timestamp}.{raw}").as_bytes());
    assert_eq!(
        headers["x-scp-signature"],
        format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
    );
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        body,
        json!({"scp":1,"event":"machine_wake","account":e.account.handle,"machine":"desk","endpoints":[format!("{}/desk/review",e.account.handle)],"message":{"id":sent["id"],"from":format!("{}/laptop/root",e.account.handle),"kind":"request","thread":sent["thread"],"created_at":body["message"]["created_at"]},"from_account":e.account.handle,"same_account":true})
    );
    assert!(!raw.contains("PRIVATE-MESSAGE-BODY"));
    assert!(!raw.contains(SECRET));
    e.settled().await;
    assert_eq!(e.shown().await["waking"], true);
    e.presence(true).await;
    e.send("root").await;
    server.none().await;
    e.restart().await;
    assert_eq!(e.shown().await["waking"], true);
    {
        let h = e.local.lock().await;
        let mut row = h
            .endpoints()
            .await
            .unwrap()
            .into_iter()
            .find(|row| row.id == e.target)
            .unwrap();
        let mut f = fields(&row);
        f["waking_until"] = json!(crate::now_ms() - 1);
        row.fields = f.to_string();
        h.store.put_endpoint(&h.account_id, row).await.unwrap();
    }
    e.due().await;
    assert!(e.shown().await.get("waking").is_none());
    e.local
        .lock()
        .await
        .connections
        .get_mut(&e.source)
        .unwrap()
        .watching = true;
    e.alarm().await;
    e.presence(false).await;
    e.send("root").await;
    server.call().await;
    e.settled().await;
    let events = e
        .hub
        .store
        .events(&e.account.id, EventLog::Audit, 0)
        .await
        .unwrap();
    let details: Vec<_> = events
        .iter()
        .filter(|x| x.kind.starts_with("machine_wake"))
        .collect();
    assert_eq!(details.len(), 3);
    for event in details {
        assert!(!event.detail.contains(SECRET));
        assert!(!event.detail.contains(&server.url));
    }
}
#[tokio::test]
async fn failures_double_backoff_and_waking_defaults_to_debounce() {
    let mut server = Server::new(vec![(500, json!({})), (500, json!({}))], false).await;
    let e = env(&server, &["debounceS=0.5", "backoffMaxS=1.5"]).await;
    e.send("root").await;
    let (headers, _) = server.call().await;
    let at: i64 = headers["x-scp-timestamp"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    let state = e.settled().await;
    assert_eq!(state.fails, 1);
    assert_eq!(state.next, at + 1000);
    {
        let h = e.local.lock().await;
        let mut held = state.clone();
        held.next = crate::now_ms() + 60000;
        h.set_wake_state("desk", &held).await.unwrap();
    }
    e.send("root").await;
    server.none().await;
    e.due().await;
    e.send("root").await;
    let (headers, _) = server.call().await;
    let at: i64 = headers["x-scp-timestamp"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    let state = e.settled().await;
    assert_eq!(state.fails, 2);
    assert_eq!(state.next, at + 1500);
    e.due().await;
    let before = crate::now_ms();
    e.send("root").await;
    server.call().await;
    let state = e.settled().await;
    let finished = crate::now_ms();
    assert_eq!(state.fails, 0);
    let h = e.local.lock().await;
    let row = h
        .endpoints()
        .await
        .unwrap()
        .into_iter()
        .find(|x| x.id == e.target)
        .unwrap();
    let until = fields(&row)["waking_until"].as_i64().unwrap();
    assert!(until >= before + 500 && until <= finished + 500);
}
#[tokio::test]
async fn decline_expiry_retries_oldest_queued_mail_and_clear_is_host_only() {
    let mut server = Server::new(
        vec![
            (403, json!({"declined":"budget"})),
            (403, json!({"declined":"policy"})),
        ],
        false,
    )
    .await;
    let mut e = env(
        &server,
        &["debounceS=0.01", "wakingTimeoutS=30", "declineHoldS=30"],
    )
    .await;
    let first = e.send("root").await;
    server.call().await;
    assert_eq!(e.settled().await.declined.unwrap().reason, "budget");
    e.restart().await;
    e.send("root").await;
    server.none().await;
    e.alarm().await;
    server.none().await;
    // The alarm has a one-minute floor even for short holds.
    e.due().await;
    e.alarm().await;
    let (_, raw) = server.call().await;
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap()["message"]["id"],
        first["id"]
    );
    assert_eq!(e.settled().await.declined.unwrap().reason, "policy");
    assert_eq!(
        e.hub
            .clear_wake_hold(&e.account, Some("desk"))
            .await
            .unwrap(),
        1
    );
    server.call().await;
    e.settled().await;
    assert_eq!(e.shown().await["waking"], true);
    let invalid = e
        .hub
        .call(
            &e.local,
            &e.source,
            request(7, "clearWakeHold", json!({})),
            false,
        )
        .await;
    assert_eq!(invalid["error"]["data"]["code"], "method_not_found");
}
#[tokio::test]
async fn decline_holds_only_its_sender_and_survives_another_failure() {
    let mut server = Server::new(
        vec![(403, json!({"declined":"budget"})), (500, json!({}))],
        false,
    )
    .await;
    let e = env(&server, &["debounceS=0.01", "wakingTimeoutS=2"]).await;
    e.send("root").await;
    server.call().await;
    e.settled().await;
    e.send("root").await;
    server.none().await;
    e.send("other").await;
    server.call().await;
    let state = e.settled().await;
    assert_eq!(state.fails, 1);
    assert_eq!(state.declined.unwrap().reason, "budget");
    tokio::time::sleep(Duration::from_millis(25)).await;
    e.send("root").await;
    server.none().await;
}
#[tokio::test]
async fn late_outcomes_cannot_replace_new_registration_hibernation_or_clear() {
    for reset in ["registration", "hibernation", "clear"] {
        let mut server = Server::new(vec![], true).await;
        let e = env(&server, &["debounceS=0.01", "wakingTimeoutS=2"]).await;
        e.send("root").await;
        server.call().await;
        // The handler remains pending while account operations acquire the mutex.
        tokio::time::timeout(Duration::from_secs(2), e.shown())
            .await
            .unwrap();
        if reset == "clear" {
            e.hub
                .clear_wake_hold(&e.account, Some("desk"))
                .await
                .unwrap();
            server.call().await;
        } else {
            let (_, id, _rx) = bridge(&e.hub, &e.grant, "desk").await;
            let mut hub = e.local.lock().await;
            let c = hub.connections[&id].clone();
            if reset == "registration" {
                hub.set_machine_wake("desk", &json!({"url":server.url,"secret":SECRET}))
                    .await
                    .unwrap();
            } else {
                hub.mirror(&c, &json!({"endpoints":[view("review")]}))
                    .await
                    .unwrap();
                let mut row = view("review");
                row["presence"] = json!("hibernated");
                hub.mirror(&c, &json!({"endpoints":[row]})).await.unwrap();
            }
            hub.closed(&id, false).await;
        }
        server.release.add_permits(1);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(e.shown().await.get("waking").is_none(), "{reset}");
        if reset == "clear" {
            server.release.add_permits(1);
            e.settled().await;
            assert_eq!(e.shown().await["waking"], true);
        }
    }
}

#[test]
fn options_and_url_validation() {
    for raw in [
        "unknown=1",
        "crossAccount=1",
        "debounceS=Infinity",
        "wakingTimeoutS=-1",
        "targetPerHour=NaN",
        "declineHoldS=-1",
        "backoffMaxS=inf",
    ] {
        assert!(WakeOptions::default().apply(raw).is_err(), "{raw}");
    }
    for raw in [
        "senderAccountPerHour=Infinity",
        "targetPerHour=0",
        "declineHoldS=Infinity",
        "declineHoldS=0",
        "debounceS=0",
        "debounceS=0.01",
        "crossAccount=true",
    ] {
        assert!(WakeOptions::default().apply(raw).is_ok(), "{raw}");
    }
    for url in [
        "https://example.test/wake",
        "http://localhost/wake",
        "http://127.0.0.1:1/",
        "http://[::1]/",
        "https://example.test/?email=a@b",
    ] {
        assert!(wake_url(url), "{url}");
    }
    for url in [
        "http://example.test",
        "https://user:pass@example.test",
        "http://127.0.0.2/",
        "file:///tmp/wake",
        "https://",
        "junk",
    ] {
        assert!(!wake_url(url), "{url}");
    }
    assert!(!wake_url(&format!(
        "https://example.test/{}",
        "a".repeat(2048)
    )));
}

struct Peer {
    account: Account,
    local: Arc<Mutex<AccountHub>>,
    id: String,
    _rx: mpsc::Receiver<String>,
}
async fn peer(e: &Env) -> Peer {
    let (account, grant) = identity(e.hub.store.as_ref()).await;
    let now = crate::now_ms();
    e.hub
        .store
        .contact_invite(&account.id, &e.account.id, now)
        .await
        .unwrap();
    e.hub
        .store
        .contact_accept(&e.account.id, &account.id, now)
        .await
        .unwrap();
    let (local, id, rx) = bridge(&e.hub, &grant, "source").await;
    let mut row = view("root");
    row["rules"] = json!({"in":[],"out":[format!("acct:{}", e.account.handle)]});
    let reply = e
        .hub
        .call(
            &local,
            &id,
            request(2, "mirror", json!({"endpoints":[row]})),
            false,
        )
        .await;
    assert!(reply["error"].is_null(), "{reply}");
    let h = e.local.lock().await;
    let mut target = h
        .endpoints()
        .await
        .unwrap()
        .into_iter()
        .find(|x| x.id == e.target)
        .unwrap();
    let mut f = fields(&target);
    f["rules"] = json!({"in":["acct:*"],"out":[]});
    target.fields = f.to_string();
    h.store.put_endpoint(&h.account_id, target).await.unwrap();
    Peer {
        account,
        local,
        id,
        _rx: rx,
    }
}
impl Peer {
    async fn send(&self, e: &Env) -> Value {
        let reply = e.hub.call(&self.local, &self.id, request(8, "forward", json!({"from":"root","params":{"to":format!("{}/desk/review",e.account.handle),"body":"public mail","kind":"request"}})), false).await;
        assert!(reply["error"].is_null(), "{reply}");
        reply["result"].clone()
    }
}
async fn expire_windows(e: &Env) {
    let h = e.local.lock().await;
    let mut counts = h.wake_counts(crate::now_ms()).await.unwrap();
    for c in counts.values_mut() {
        c.since = crate::now_ms() - HOUR_MS;
    }
    h.store
        .put_state(
            &h.account_id,
            "wake_limits",
            Some(&json!(counts).to_string()),
        )
        .await
        .unwrap();
}
#[tokio::test]
async fn cross_account_is_off_by_default_and_checks_current_contact_on_retry() {
    let mut server = Server::new(vec![], false).await;
    let e = env(&server, &[]).await;
    let p = peer(&e).await;
    p.send(&e).await;
    server.none().await;
    e.local
        .lock()
        .await
        .set_wake_state("desk", &WakeState::default())
        .await
        .unwrap();
    e.hub
        .clear_wake_hold(&e.account, Some("desk"))
        .await
        .unwrap();
    server.none().await;
    assert_eq!(e.hub.store.xinbox(&e.account.id).await.unwrap().len(), 1);

    let e = env(
        &server,
        &[
            "crossAccount=true",
            "senderAccountPerHour=1",
            "targetPerHour=Infinity",
        ],
    )
    .await;
    let p = peer(&e).await;
    let sent = p.send(&e).await;
    let (_, raw) = server.call().await;
    let event: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(event["from_account"], p.account.handle);
    assert_eq!(event["same_account"], false);
    assert_eq!(event["message"]["id"], sent["id"]);
    e.settled().await;
    e.hub
        .store
        .contact_update(
            &e.account.id,
            &p.account.id,
            ContactConfig {
                dir: "out".into(),
                ..ContactConfig::default()
            },
            crate::now_ms(),
        )
        .await
        .unwrap();
    e.hub
        .clear_wake_hold(&e.account, Some("desk"))
        .await
        .unwrap();
    server.none().await;
    e.hub
        .store
        .contact_revoke(&e.account.id, &p.account.id, crate::now_ms())
        .await
        .unwrap();
    e.local
        .lock()
        .await
        .set_wake_state("desk", &WakeState::default())
        .await
        .unwrap();
    e.hub
        .clear_wake_hold(&e.account, Some("desk"))
        .await
        .unwrap();
    server.none().await;
}
#[tokio::test]
async fn queued_retries_charge_sender_once_and_retry_target_cap_at_reset_after_restart() {
    let mut server = Server::new(vec![(403, json!({"declined":"budget"})); 3], false).await;
    let mut e = env(
        &server,
        &[
            "crossAccount=true",
            "senderAccountPerHour=1",
            "targetPerHour=3",
            "declineHoldS=0.01",
            "debounceS=0.01",
        ],
    )
    .await;
    let p = peer(&e).await;
    let first = p.send(&e).await;
    server.call().await;
    e.settled().await;
    for _ in 0..2 {
        e.due().await;
        e.alarm().await;
        let (_, raw) = server.call().await;
        assert_eq!(
            serde_json::from_str::<Value>(&raw).unwrap()["message"]["id"],
            first["id"]
        );
        e.settled().await;
    }
    e.due().await;
    e.alarm().await;
    server.none().await;
    let counts = e
        .local
        .lock()
        .await
        .wake_counts(crate::now_ms())
        .await
        .unwrap();
    assert_eq!(counts[&format!("account:{}", p.account.id)].n, 1);
    assert_eq!(counts[&format!("endpoint:{}", e.target)].n, 3);
    assert_eq!(
        e.state().await.retry_at,
        Some(counts[&format!("endpoint:{}", e.target)].since + HOUR_MS)
    );
    e.restart().await;
    e.alarm().await;
    server.none().await;
    expire_windows(&e).await;
    e.due().await;
    e.alarm().await;
    let (_, raw) = server.call().await;
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap()["message"]["id"],
        first["id"]
    );
    assert!(e.settled().await.retry_at.is_none());
    let counts = e
        .local
        .lock()
        .await
        .wake_counts(crate::now_ms())
        .await
        .unwrap();
    assert_eq!(counts[&format!("account:{}", p.account.id)].n, 1);
    assert_eq!(counts[&format!("endpoint:{}", e.target)].n, 1);
}
#[tokio::test]
async fn per_sender_and_target_caps_zero_infinity_and_latest_window_reset() {
    for options in [
        vec![
            "crossAccount=true",
            "senderAccountPerHour=1",
            "targetPerHour=Infinity",
        ],
        vec![
            "crossAccount=true",
            "senderAccountPerHour=Infinity",
            "targetPerHour=1",
        ],
    ] {
        let mut server = Server::new(vec![], false).await;
        let e = env(&server, &options).await;
        let p = peer(&e).await;
        p.send(&e).await;
        server.call().await;
        e.settled().await;
        e.due().await;
        {
            let h = e.local.lock().await;
            let mut row = h
                .endpoints()
                .await
                .unwrap()
                .into_iter()
                .find(|x| x.id == e.target)
                .unwrap();
            let mut f = fields(&row);
            f["waking_until"] = Value::Null;
            row.fields = f.to_string();
            h.store.put_endpoint(&h.account_id, row).await.unwrap();
        }
        p.send(&e).await;
        server.none().await;
        assert!(e.state().await.retry_at.unwrap() > crate::now_ms());
    }
    let mut server = Server::new(vec![], false).await;
    let e = env(&server, &["crossAccount=true", "senderAccountPerHour=0"]).await;
    let p = peer(&e).await;
    p.send(&e).await;
    server.none().await;
    assert!(
        e.local
            .lock()
            .await
            .wake_state("desk")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        e.local
            .lock()
            .await
            .wake_counts(crate::now_ms())
            .await
            .unwrap()
            .is_empty()
    );
    let e = env(
        &server,
        &[
            "crossAccount=true",
            "senderAccountPerHour=Infinity",
            "targetPerHour=Infinity",
        ],
    )
    .await;
    let p = peer(&e).await;
    p.send(&e).await;
    server.call().await;
    e.settled().await;
    assert!(
        e.local
            .lock()
            .await
            .wake_counts(crate::now_ms())
            .await
            .unwrap()
            .is_empty()
    );
    let e = env(
        &server,
        &[
            "crossAccount=true",
            "senderAccountPerHour=1",
            "targetPerHour=1",
        ],
    )
    .await;
    let now = crate::now_ms();
    let h = e.local.lock().await;
    h.store.put_state(&h.account_id, "wake_limits", Some(&json!({"account:sender":{"n":1,"since":now-2000},format!("endpoint:{}",e.target):{"n":1,"since":now-1000}}).to_string())).await.unwrap();
    assert_eq!(
        h.wake_admitted("sender", &e.target, now, 99).await.unwrap(),
        Some(now - 1000 + HOUR_MS)
    );
}
#[tokio::test]
async fn expired_decline_allows_new_delivery_and_live_claim_prevents_late_waking() {
    let mut server = Server::new(vec![(403, json!({"declined":"policy"}))], false).await;
    let e = env(&server, &["declineHoldS=0.04", "debounceS=0.01"]).await;
    e.send("root").await;
    server.call().await;
    e.settled().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    e.send("root").await;
    server.call().await;
    e.settled().await;
    let mut server = Server::new(vec![], true).await;
    let e = env(&server, &[]).await;
    e.send("root").await;
    server.call().await;
    let (_, desk, _rx) = bridge(&e.hub, &e.grant, "desk").await;
    let reply = e
        .hub
        .call(
            &e.local,
            &desk,
            request(9, "mirror", json!({"endpoints":[view("review")]})),
            false,
        )
        .await;
    assert!(reply["error"].is_null(), "{reply}");
    server.release.add_permits(1);
    e.settled().await;
    assert_eq!(e.shown().await["presence"], "online");
    assert!(e.shown().await.get("waking").is_none());
}

#[tokio::test]
async fn subscribed_bridge_gets_mail_without_webhook_and_registration_stays_private() {
    let mut server = Server::new(vec![], false).await;
    let e = env(&server, &[]).await;
    let (_, id, mut rx) = bridge(&e.hub, &e.grant, "desk").await;
    let reply = e
        .hub
        .call(&e.local, &id, request(3, "subscribe", json!({})), false)
        .await;
    assert!(reply["error"].is_null(), "{reply}");
    e.send("root").await;
    server.none().await;
    assert!(
        std::iter::from_fn(|| rx.try_recv().ok())
            .any(|s| serde_json::from_str::<Value>(&s).unwrap()["method"] == "deliver")
    );
    let replies = e
        .hub
        .rpc(
            e.grant.clone(),
            json!([
                request(3, "hello", json!({"protocol":"scp/1", "observe":true})),
                request(4, "machines", json!({}))
            ]),
        )
        .await;
    let machines = &replies[1];
    assert_eq!(
        machines["result"]["machines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["name"] == "desk")
            .unwrap()["wake"],
        true
    );
    assert!(!machines.to_string().contains(SECRET));
    assert!(!machines.to_string().contains(&server.url));
    for params in [
        json!({"url":"http://example.test/","secret":SECRET}),
        json!({"url":server.url,"secret":"short"}),
        json!({"url":"https://user:pass@example.test/","secret":SECRET}),
    ] {
        let reply = e
            .hub
            .call(&e.local, &id, request(5, "machine_wake", params), false)
            .await;
        assert_eq!(reply["error"]["data"]["code"], "invalid_params");
    }
    let reply = e
        .hub
        .call(
            &e.local,
            &id,
            request(6, "machine_wake", json!({"url":null})),
            false,
        )
        .await;
    assert_eq!(reply["result"], json!({"set":false}));
    e.local.lock().await.closed(&id, false).await;
    e.send("root").await;
    server.none().await;
}
#[tokio::test]
async fn restarted_maintenance_resumes_queued_retry_without_a_connection() {
    let mut server = Server::new(vec![(403, json!({"declined":"budget"}))], false).await;
    let e = env_store(
        &server,
        &["declineHoldS=0.01", "debounceS=0.01"],
        "sqlite::memory:",
    )
    .await;
    let first = e.send("root").await;
    server.call().await;
    e.settled().await;
    e.due().await;
    let store = e.hub.store.clone();
    let options = e.local.lock().await.wake_options.clone();
    let restarted = Arc::new(Hub::new(store, crate::http::Limits::default()).with_wake(options));
    let task = tokio::spawn(restarted.clone().maintain());
    let (_, raw) = server.call().await;
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap()["message"]["id"],
        first["id"]
    );
    restarted.shutdown();
    task.await.unwrap();
}
#[tokio::test]
async fn clear_all_ends_waking_and_calls_nothing_when_mail_was_acked() {
    let mut server = Server::new(vec![], false).await;
    let mut e = env(&server, &[]).await;
    e.send("root").await;
    server.call().await;
    e.settled().await;
    let h = e.local.lock().await;
    for mut d in h
        .store
        .deliveries(&h.account_id, &e.target, 0)
        .await
        .unwrap()
    {
        d.acked_at = Some(crate::now_ms());
        h.store.update_delivery(&h.account_id, d).await.unwrap();
    }
    drop(h);
    assert_eq!(e.hub.clear_wake_hold(&e.account, None).await.unwrap(), 1);
    server.none().await;
    assert!(e.shown().await.get("waking").is_none());
    e.presence(false).await;
    assert_eq!(e.hub.clear_wake_hold(&e.account, None).await.unwrap(), 0);
}
#[tokio::test]
async fn target_window_is_shared_by_senders_but_separate_for_each_endpoint() {
    let mut server = Server::new(vec![], false).await;
    let e = env(
        &server,
        &[
            "crossAccount=true",
            "senderAccountPerHour=Infinity",
            "targetPerHour=1",
            "debounceS=0.01",
            "wakingTimeoutS=0.01",
        ],
    )
    .await;
    let one = peer(&e).await;
    let two = peer(&e).await;
    one.send(&e).await;
    server.call().await;
    e.settled().await;
    tokio::time::sleep(Duration::from_millis(15)).await;
    two.send(&e).await;
    server.none().await;
    let h = e.local.lock().await;
    assert_eq!(
        h.wake_admitted(&two.account.id, "another-endpoint", crate::now_ms(), 999)
            .await
            .unwrap(),
        None
    );
    let counts = h.wake_counts(crate::now_ms()).await.unwrap();
    assert_eq!(counts["endpoint:another-endpoint"].n, 1);
    assert!(!counts.keys().any(|k| k.starts_with("account:")));
}
