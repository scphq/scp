use super::*;
use scp_relay_store::{EventLog, StoreError};

fn observer_hello() -> Value {
    request(1, "hello", json!({"protocol":"scp/1","observe":true}))
}
fn claim(machine: &str, name: &str) -> Value {
    request(
        1,
        "hello",
        json!({"protocol":"scp/1","machine":machine,"claim":{"handle":name}}),
    )
}
fn code(value: &Value) -> &Value {
    &value["error"]["data"]["code"]
}
async fn connection(
    hub: &Hub,
    g: &Grant,
) -> (
    Arc<Mutex<AccountHub>>,
    String,
    watch::Receiver<Option<Closure>>,
) {
    let account = hub.account(g).await;
    let (texts, _rx) = mpsc::channel(32);
    let (close, closing) = watch::channel(None);
    let id = crate::random("socket_");
    account.lock().await.connections.insert(
        id.clone(),
        Connection {
            grant: Some(g.clone()),
            socket: Some(SocketHandle { texts, close }),
            ..Connection::default()
        },
    );
    (account, id, closing)
}
#[tokio::test]
async fn calls_are_shared_by_reconnects_batches_and_notifications() {
    let (hub, g) = fixture_limits(&["callsPerMinute=2"]).await;
    let result = hub
        .rpc(g.clone(), json!([observer_hello(), {"method":"list"}]))
        .await;
    assert_eq!(result.as_array().unwrap().len(), 1);
    let result = hub.rpc(g.clone(), observer_hello()).await;
    assert_eq!(code(&result), "rate_limited");
    assert_eq!(
        result["error"]["message"],
        "at most 2 calls per minute on a token"
    );
    assert_eq!(result["error"]["data"]["retry_after"], 30);
    let mut other = g.clone();
    other.token_id = "another".into();
    assert!(
        hub.rpc(other, observer_hello())
            .await
            .get("error")
            .is_none()
    );
}
#[tokio::test]
async fn bridge_and_client_buckets_are_separate_and_refusals_close_1013() {
    let (hub, g) = fixture_limits(&["callsPerMinute=1", "bridgeCallsPerMinute=2"]).await;
    assert!(
        hub.rpc(g.clone(), observer_hello())
            .await
            .get("error")
            .is_none()
    );
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    assert!(
        hub.call(&account, &id, request(2, "list", json!({})), false)
            .await
            .get("error")
            .is_none()
    );
    let socket = account.lock().await.connections[&id]
        .socket
        .clone()
        .unwrap();
    let closing = socket.close.subscribe();
    for _ in 0..2 {
        let response = hub
            .call(&account, &id, request(3, "list", json!({})), false)
            .await;
        assert_eq!(code(&response), "rate_limited");
        assert_eq!(
            response["error"]["message"],
            "at most 2 bridge calls per minute on a token"
        );
    }
    assert_eq!(closing.borrow().as_ref().unwrap().code, 1013);
    assert_eq!(closing.borrow().as_ref().unwrap().reason, "rate limited");
    assert!(!account.lock().await.connections.contains_key(&id));
}
#[tokio::test]
async fn account_call_budget_spans_credentials_without_spending_refused_token() {
    let (hub, g) = fixture_limits(&["accountCallsPerMinute=1"]).await;
    assert!(
        hub.rpc(g.clone(), observer_hello())
            .await
            .get("error")
            .is_none()
    );
    let mut other = g.clone();
    other.token_id = "other".into();
    let response = hub.rpc(other.clone(), observer_hello()).await;
    assert_eq!(code(&response), "rate_limited");
    assert_eq!(
        response["error"]["message"],
        "at most 1 calls per minute on an account"
    );
    assert_eq!(response["error"]["data"]["retry_after"], 60);
    let account = hub.account(&g).await;
    let mut hub = account.lock().await;
    let now = crate::now_ms() + 60_000;
    let c = Connection {
        grant: Some(other),
        ..Connection::default()
    };
    hub.spend("absent", &c, "hello", &json!({}), now)
        .await
        .unwrap();
}
#[tokio::test]
async fn ack_buckets_charge_sequences_and_rejects_without_spending_calls() {
    let (hub, g) = fixture_limits(&[
        "bridgeCallsPerMinute=1",
        "acksPerMinute=3",
        "accountAcksPerMinute=4",
    ])
    .await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let ack = hub
        .call(
            &account,
            &id,
            request(2, "ack", json!({"seqs":[1,2]})),
            false,
        )
        .await;
    assert_eq!(ack["result"]["acked"], 0);
    let reject = hub
        .call(
            &account,
            &id,
            request(3, "reject", json!({"seq":1,"code":"policy_refused"})),
            false,
        )
        .await;
    assert_eq!(code(&reject), "not_found");
    let response = hub
        .call(&account, &id, request(4, "ack", json!({"seqs":[]})), false)
        .await;
    assert_eq!(
        response["error"]["message"],
        "at most 3 acked seqs per minute on a token"
    );
    assert_eq!(response["error"]["data"]["retry_after"], 20);
    assert!(
        account.lock().await.connections[&id]
            .socket
            .as_ref()
            .unwrap()
            .close
            .borrow()
            .is_none()
    );
    let mut other = g.clone();
    other.token_id = "other".into();
    let (account, other, _rx) = bridge(&hub, &other, "other").await;
    assert_eq!(
        hub.call(
            &account,
            &other,
            request(5, "ack", json!({"seqs":[]})),
            false
        )
        .await["result"]["acked"],
        0
    );
    let response = hub
        .call(
            &account,
            &other,
            request(6, "ack", json!({"seqs":[]})),
            false,
        )
        .await;
    assert_eq!(
        response["error"]["message"],
        "at most 4 acked seqs per minute on an account"
    );
    assert_eq!(response["error"]["data"]["retry_after"], 15);
}
#[tokio::test]
async fn buckets_refill_fractionally_and_events_preserve_quarter_for_calls() {
    let (hub, g) = fixture_limits(&["callsPerMinute=4", "accountCallsPerMinute=Infinity"]).await;
    let account = hub.account(&g).await;
    let mut hub = account.lock().await;
    let c = Connection {
        grant: Some(g),
        role: "client".into(),
        ..Connection::default()
    };
    for _ in 0..3 {
        hub.spend("id", &c, "whoami", &json!({}), 1_000)
            .await
            .unwrap();
    }
    hub.spend("id", &c, "event", &json!({}), 1_000)
        .await
        .unwrap();
    let error = hub
        .spend("id", &c, "event", &json!({}), 8_500)
        .await
        .unwrap_err();
    assert_eq!(error.retry, Some(8));
    let error = hub
        .spend("id", &c, "whoami", &json!({}), 8_500)
        .await
        .unwrap_err();
    assert_eq!(error.retry, Some(8));
    hub.spend("id", &c, "whoami", &json!({}), 16_000)
        .await
        .unwrap();
}
#[tokio::test]
async fn disabled_budgets_and_zero_budgets() {
    let (hub, g) = fixture_limits(&[
        "callsPerMinute=Infinity",
        "bridgeCallsPerMinute=Infinity",
        "accountCallsPerMinute=Infinity",
        "acksPerMinute=Infinity",
        "accountAcksPerMinute=Infinity",
    ])
    .await;
    let account = hub.account(&g).await;
    let mut hub = account.lock().await;
    let mut c = Connection {
        grant: Some(g),
        role: "client".into(),
        ..Connection::default()
    };
    for _ in 0..1300 {
        hub.spend("id", &c, "event", &json!({}), 0).await.unwrap();
        hub.spend("id", &c, "ack", &json!({"seqs":[1,2,3]}), 0)
            .await
            .unwrap();
    }
    c.role = "bridge".into();
    for _ in 0..610 {
        hub.spend("id", &c, "list", &json!({}), 0).await.unwrap();
    }
    drop(hub);
    let (hub, g) = fixture_limits(&["callsPerMinute=0"]).await;
    let response = hub.rpc(g, observer_hello()).await;
    assert!(response["error"].is_null(), "{response}");
}
#[tokio::test]
async fn machine_and_endpoint_caps_allow_updates_and_rollback_failed_claims() {
    let (hub, g) = fixture_limits(&["machines=1", "endpoints=2"]).await;
    let first = hub.rpc(g.clone(), claim("host", "one")).await;
    assert!(first.get("error").is_none(), "{first}");
    let response = hub.rpc(g.clone(), claim("other", "one")).await;
    assert_eq!(
        response["error"]["message"],
        "at most 1 machines per account; release one with swarm machines rm"
    );
    let response = hub.rpc(g.clone(), claim("host", "two")).await;
    assert_eq!(
        response["error"]["message"],
        "at most 2 endpoints on this relay, and this needs 3; the deployment raises the endpoints key of SCP_LIMITS"
    );
    assert!(
        hub.rpc(g.clone(), claim("host", "one"))
            .await
            .get("error")
            .is_none()
    );
    assert!(
        hub.rpc(g.clone(), observer_hello())
            .await
            .get("error")
            .is_none()
    );
    let human = request(
        1,
        "hello",
        json!({"protocol":"scp/1","machine":"human","human":true,"tty":true}),
    );
    assert!(hub.rpc(g.clone(), human).await.get("error").is_none());
    let account = hub.account(&g).await;
    assert_eq!(
        account
            .lock()
            .await
            .store
            .machines(&g.user_id)
            .await
            .unwrap()
            .len(),
        1
    );
    let (hub, g) = fixture_limits(&[
        "machines=Infinity",
        "endpoints=Infinity",
        "callsPerMinute=Infinity",
    ])
    .await;
    for n in 0..18 {
        assert!(
            hub.rpc(g.clone(), claim(&format!("host{n}"), "one"))
                .await
                .get("error")
                .is_none()
        );
    }
}
#[tokio::test]
async fn mirror_caps_count_other_machines_and_preserve_existing_rows() {
    let (hub, g) = fixture_limits(&["endpoints=3"]).await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let response = hub
        .call(
            &account,
            &id,
            request(2, "mirror", json!({"endpoints":[view("one"),view("two")]})),
            false,
        )
        .await;
    assert_eq!(response["result"]["changed"], 2);
    let response = hub
        .call(
            &account,
            &id,
            request(
                3,
                "mirror",
                json!({"endpoints":[view("one"),view("three")]}),
            ),
            false,
        )
        .await;
    assert_eq!(code(&response), "too_large");
    assert_eq!(account.lock().await.endpoints().await.unwrap().len(), 2);
    let response = hub
        .call(
            &account,
            &id,
            request(
                4,
                "mirror",
                json!({"endpoints":[view("one"),view("two"),view("three"),view("four")]}),
            ),
            false,
        )
        .await;
    assert_eq!(
        response["error"]["message"],
        "at most 3 endpoints on this relay, and this mirror carries 4; the deployment raises the endpoints key of SCP_LIMITS"
    );
    let response = hub.rpc(g, claim("other", "agent")).await;
    assert_eq!(code(&response), "too_large");
}
#[tokio::test]
async fn socket_reservations_include_pending_upgrades_and_release_on_drop() {
    let (hub, g) = fixture_limits(&["sockets=1"]).await;
    let first = hub.track(&g).await.unwrap();
    assert!(hub.track(&g).await.is_none());
    assert!(
        hub.rpc(g.clone(), observer_hello())
            .await
            .get("error")
            .is_none()
    );
    drop(first);
    assert!(hub.track(&g).await.is_some());
    let (hub, g) = fixture_limits(&["sockets=Infinity"]).await;
    let mut leases = Vec::new();
    for _ in 0..65 {
        leases.push(hub.track(&g).await.unwrap());
    }
}
#[tokio::test]
async fn stored_bytes_and_refusal_audits_are_bounded_per_code() {
    let (hub, g) = fixture_limits(&["storedBytes=4", "refusalsPerMinute=1"]).await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    hub.call(
        &account,
        &id,
        request(
            2,
            "mirror",
            json!({"endpoints":[view("sender"),view("target")]}),
        ),
        false,
    )
    .await;
    let send = |body| {
        request(
            3,
            "forward",
            json!({"from":"sender","params":{"to":"host/target","body":body}}),
        )
    };
    assert!(
        hub.call(&account, &id, send("ü"), false)
            .await
            .get("error")
            .is_none()
    );
    assert!(
        hub.call(&account, &id, send("ü"), false)
            .await
            .get("error")
            .is_none()
    );
    for _ in 0..3 {
        assert_eq!(
            code(&hub.call(&account, &id, send("a"), false).await),
            "too_large"
        );
    }
    assert_eq!(hub.store.stored_bytes(&g.user_id).await.unwrap(), 4);
    let mut a = account.lock().await;
    a.refusal(None, None, json!({"code":"unauthorized"}), 0)
        .await
        .unwrap();
    a.refusal(None, None, json!({"code":"unauthorized"}), 0)
        .await
        .unwrap();
    a.refusal(None, None, json!({"code":"unauthorized"}), 60_000)
        .await
        .unwrap();
    drop(a);
    let rows = hub
        .store
        .events(&g.user_id, EventLog::Audit, 0)
        .await
        .unwrap();
    let rows: Vec<_> = rows
        .iter()
        .filter(|r| r.kind == "refuse")
        .map(|r| serde_json::from_str::<Value>(&r.detail).unwrap())
        .collect();
    assert_eq!(rows,json!([{"code":"too_large"},{"code":"unauthorized"},{"code":"unauthorized","suppressed":1}]).as_array().unwrap().clone());
}
#[tokio::test]
async fn mirror_swaps_and_rename_chains_preserve_endpoint_identity() {
    let (hub, g) = fixture().await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    hub.call(
        &account,
        &id,
        request(2, "mirror", json!({"endpoints":[view("a"),view("b")]})),
        false,
    )
    .await;
    let original = account.lock().await.endpoints().await.unwrap();
    let mut a = view("a");
    a["was"] = json!("b");
    let mut b = view("b");
    b["was"] = json!("a");
    let response = hub
        .call(
            &account,
            &id,
            request(3, "mirror", json!({"endpoints":[a,b]})),
            false,
        )
        .await;
    assert_eq!(response["result"]["changed"], 2, "{response}");
    let swapped = account.lock().await.endpoints().await.unwrap();
    for endpoint in &swapped {
        assert_eq!(fields(endpoint)["tree"], endpoint.handle);
    }
    assert_eq!(
        original.iter().find(|e| e.handle == "a").unwrap().id,
        swapped.iter().find(|e| e.handle == "b").unwrap().id
    );
    assert_eq!(
        original.iter().find(|e| e.handle == "b").unwrap().id,
        swapped.iter().find(|e| e.handle == "a").unwrap().id
    );
    let mut a = view("b");
    a["was"] = json!("a");
    let mut b = view("c");
    b["was"] = json!("b");
    let response = hub
        .call(
            &account,
            &id,
            request(4, "mirror", json!({"endpoints":[a,b]})),
            false,
        )
        .await;
    assert!(response.get("error").is_none(), "{response}");
    let final_rows = account.lock().await.endpoints().await.unwrap();
    assert_eq!(
        final_rows.iter().find(|e| e.handle == "c").unwrap().id,
        swapped.iter().find(|e| e.handle == "b").unwrap().id
    );
}
#[tokio::test]
async fn revalidation_errors_share_persisted_grace_and_clear_after_recovery_or_close() {
    let (hub, g) = fixture_limits(&["revalidateMs=100"]).await;
    let (account, id, closing) = connection(&hub, &g).await;
    let key = format!("revalidate_error:{}", g.token_id);
    let failure = || Err(StoreError::Backend("offline".into()));
    let mut a = account.lock().await;
    assert!(a.revalidated(&id, failure(), 1_000).await);
    assert_eq!(
        hub.store.state(&g.user_id, &key).await.unwrap(),
        Some("1000".into())
    );
    assert!(a.revalidated(&id, failure(), 1_099).await);
    assert!(closing.borrow().is_none());
    let identity = hub
        .store
        .credential_by_id(&g.token_id, crate::now_ms())
        .await
        .unwrap();
    assert!(!a.revalidated(&id, Ok(identity), 1_099).await);
    assert!(hub.store.state(&g.user_id, &key).await.unwrap().is_none());
    a.revalidated(&id, failure(), 2_000).await;
    a.revalidated(&id, failure(), 2_100).await;
    let close = closing.borrow().clone().unwrap();
    assert_eq!(close.code, 1013);
    assert_eq!(
        close.reason,
        "the token could not be revalidated, try again"
    );
    assert!(hub.store.state(&g.user_id, &key).await.unwrap().is_none());
}
#[tokio::test]
async fn denied_timestamps_expire_at_denied_duration_and_kick_stale_grants() {
    let (hub, g) = fixture_limits(&["deniedS=1"]).await;
    let (account, id, closing) = connection(&hub, &g).await;
    hub.store
        .put_state(
            &g.user_id,
            &format!("denied:{}", g.token_id),
            Some(&json!(crate::now_ms()).to_string()),
        )
        .await
        .unwrap();
    let response = hub.call(&account, &id, observer_hello(), false).await;
    assert_eq!(response["error"]["message"], "the token was revoked");
    assert_eq!(closing.borrow().as_ref().unwrap().code, 1008);
    hub.store
        .put_state(
            &g.user_id,
            &format!("denied:{}", g.token_id),
            Some(&json!(crate::now_ms() - 1000).to_string()),
        )
        .await
        .unwrap();
    assert!(
        hub.rpc(g.clone(), observer_hello())
            .await
            .get("error")
            .is_none()
    );
    assert!(
        hub.store
            .state(&g.user_id, &format!("denied:{}", g.token_id))
            .await
            .unwrap()
            .is_none()
    );
}
#[tokio::test]
async fn endpoint_touch_is_throttled_at_ten_seconds() {
    let (hub, g) = fixture().await;
    let (account, id, _closing) = connection(&hub, &g).await;
    let response = hub.call(&account, &id, claim("host", "agent"), false).await;
    let initial = response["result"]["endpoint"]["last_seen"].clone();
    let response = hub
        .call(&account, &id, request(2, "whoami", json!({})), false)
        .await;
    assert_eq!(response["result"]["last_seen"], initial);
    let mut endpoint = account
        .lock()
        .await
        .endpoints()
        .await
        .unwrap()
        .pop()
        .unwrap();
    endpoint.last_seen = Some(crate::now_ms() - 10_000);
    hub.store.put_endpoint(&g.user_id, endpoint).await.unwrap();
    let response = hub
        .call(&account, &id, request(3, "whoami", json!({})), false)
        .await;
    assert!(response["result"]["last_seen"].as_str().unwrap() >= initial.as_str().unwrap());
}
#[tokio::test]
async fn replies_are_acked_only_after_transport_acceptance() {
    let (hub, g) = fixture().await;
    let (account, client, _closing) = connection(&hub, &g).await;
    let claimed = hub
        .call(&account, &client, claim("client", "agent"), false)
        .await;
    let endpoint = claimed["result"]["endpoint"]["id"].as_str().unwrap();
    let token = claimed["result"]["token"].clone();
    let (_, bridge, _rx) = bridge(&hub, &g, "host").await;
    hub.call(
        &account,
        &bridge,
        request(2, "mirror", json!({"endpoints":[view("responder")]})),
        false,
    )
    .await;
    let sent = hub
        .call(
            &account,
            &client,
            request(2, "ask", json!({"to":"host/responder","body":"question"})),
            false,
        )
        .await;
    let request_id = sent["result"]["id"].clone();
    let replied = hub.call(&account,&bridge,request(3,"forward",json!({"from":"responder","params":{"to":"client/agent","reply_to":request_id,"kind":"reply","body":"answer"}})),false).await;
    assert!(replied.get("error").is_none(), "{replied}");
    let response = hub
        .call(
            &account,
            &client,
            request(3, "ask_wait", json!({"id":request_id})),
            false,
        )
        .await;
    assert_eq!(response["result"]["reply"]["body"]["text"], "answer");
    let delivery = hub
        .store
        .reply_delivery(
            &g.user_id,
            endpoint,
            request_id.as_str().unwrap(),
            crate::now_ms(),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(delivery.acked_at.is_none());
    let socket = account.lock().await.connections[&client]
        .socket
        .clone()
        .unwrap();
    assert!(!socket.send(response.to_string()));
    assert!(
        hub.store
            .reply_delivery(
                &g.user_id,
                endpoint,
                request_id.as_str().unwrap(),
                crate::now_ms()
            )
            .await
            .unwrap()
            .unwrap()
            .acked_at
            .is_none()
    );
    let (texts, mut rx) = mpsc::channel(32);
    let (close, _closing) = watch::channel(None);
    let socket = SocketHandle { texts, close };
    assert!(socket.send(response.to_string()));
    hub.ack_response(&account, &client, &response).await;
    assert!(rx.recv().await.is_some());
    assert!(
        hub.store
            .reply_delivery(
                &g.user_id,
                endpoint,
                request_id.as_str().unwrap(),
                crate::now_ms()
            )
            .await
            .unwrap()
            .unwrap()
            .acked_at
            .is_some()
    );
    let response = hub
        .rpc(
            g.clone(),
            json!([
                request(
                    1,
                    "hello",
                    json!({"protocol":"scp/1","machine":"client","resume":token})
                ),
                request(2, "ask_wait", json!({"id":request_id}))
            ]),
        )
        .await;
    assert_eq!(response[1]["result"]["reply"]["seq"], delivery.seq);
}
#[tokio::test]
async fn http_wait_is_capped_and_polling_does_not_spend_calls() {
    let (hub, g) = fixture_limits(&["httpWaitS=1", "callsPerMinute=2"]).await;
    let started = tokio::time::Instant::now();
    let response = hub
        .rpc(
            g,
            json!([
                claim("host", "agent"),
                request(2, "inbox", json!({"wait_s":20}))
            ]),
        )
        .await;
    assert!(response[1].get("error").is_none(), "{response}");
    assert!(
        response[1]["result"]["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(started.elapsed() >= Duration::from_secs(1));
    assert!(started.elapsed() < Duration::from_secs(3));
}
#[tokio::test]
async fn idle_purge_ignores_transient_requests_and_denial_cleanup_respects_duration() {
    let (hub, g) = fixture_limits(&["idlePurgeS=1", "deniedS=2"]).await;
    let account = hub.account(&g).await;
    hub.store
        .put_state(
            &g.user_id,
            "idle_since",
            Some(&json!(crate::now_ms() - 1000).to_string()),
        )
        .await
        .unwrap();
    hub.store
        .put_state(&g.user_id, "marker", Some("1"))
        .await
        .unwrap();
    account.lock().await.connections.insert(
        "http".into(),
        Connection {
            grant: Some(g.clone()),
            ..Connection::default()
        },
    );
    account.lock().await.sweep().await.unwrap();
    assert!(
        hub.store
            .state(&g.user_id, "marker")
            .await
            .unwrap()
            .is_none()
    );
    let now = crate::now_ms();
    hub.store
        .put_state(
            &g.user_id,
            "denied:old",
            Some(&json!(now - 2000).to_string()),
        )
        .await
        .unwrap();
    hub.store
        .put_state(&g.user_id, "denied:recent", Some(&json!(now).to_string()))
        .await
        .unwrap();
    account.lock().await.sweep().await.unwrap();
    assert!(
        hub.store
            .state(&g.user_id, "denied:old")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        hub.store
            .state(&g.user_id, "denied:recent")
            .await
            .unwrap()
            .is_some()
    );
}

#[test]
fn revalidation_retry_is_short_and_bounded_by_configured_interval() {
    assert_eq!(
        limits::revalidate_delay(300_000, true),
        Duration::from_secs(30)
    );
    assert_eq!(
        limits::revalidate_delay(20, true),
        Duration::from_millis(20)
    );
    assert_eq!(
        limits::revalidate_delay(300_000, false),
        Duration::from_secs(300)
    );
}
#[tokio::test]
async fn malformed_params_spend_calls_and_http_batches_enforce_frame_limit() {
    let (hub, g) = fixture_limits(&["callsPerMinute=1"]).await;
    let response = hub.rpc(g.clone(), request(1, "hello", json!([]))).await;
    assert_eq!(code(&response), "invalid_params");
    assert_eq!(code(&hub.rpc(g, observer_hello()).await), "rate_limited");
    let (hub, g) = fixture_limits(&["frameBytes=1"]).await;
    let response = hub.rpc(g, observer_hello()).await;
    assert_eq!(response["error"]["message"], "a request is at most 1 bytes");
    assert_eq!(code(&response), "too_large");
}
#[tokio::test]
async fn disabled_storage_and_refusal_caps_allow_every_write() {
    let (hub, g) = fixture_limits(&["storedBytes=Infinity", "refusalsPerMinute=Infinity"]).await;
    let account = hub.account(&g).await;
    let mut a = account.lock().await;
    a.room(&json!("x".repeat(1_000))).await.unwrap();
    for _ in 0..12 {
        a.refusal(None, None, json!({"code":"too_large"}), 0)
            .await
            .unwrap();
    }
    assert_eq!(
        hub.store
            .events(&g.user_id, EventLog::Audit, 0)
            .await
            .unwrap()
            .len(),
        12
    );
}

#[tokio::test]
async fn unlimited_endpoint_cap_admits_a_mirror_beyond_default_cap() {
    let (hub, g) = fixture_limits(&["endpoints=Infinity"]).await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let views: Vec<_> = (0..513).map(|n| view(&format!("agent{n}"))).collect();
    let response = hub
        .call(
            &account,
            &id,
            request(2, "mirror", json!({"endpoints":views})),
            false,
        )
        .await;
    assert_eq!(response["result"]["changed"], 513, "{response}");
}
#[tokio::test]
async fn client_machine_expiry_keeps_queued_deliveries_and_unanswered_requests() {
    let (hub, g) = fixture_limits(&["clientMachineIdleS=1"]).await;
    let receiver = hub.rpc(g.clone(), claim("queued", "agent")).await;
    assert!(receiver.get("error").is_none());
    let asked = hub
        .rpc(
            g.clone(),
            json!([
                claim("asking", "agent"),
                request(2, "ask", json!({"to":"queued/agent","body":"question"}))
            ]),
        )
        .await;
    assert!(asked[1].get("error").is_none(), "{asked}");
    hub.rpc(g.clone(), claim("idle", "agent")).await;
    let account = hub.account(&g).await;
    let age_machines = || async {
        for mut machine in hub.store.machines(&g.user_id).await.unwrap() {
            machine.last_seen = Some(crate::now_ms() - 2_000);
            hub.store.put_machine(&g.user_id, machine).await.unwrap();
        }
    };
    age_machines().await;
    account.lock().await.sweep().await.unwrap();
    let names: Vec<_> = hub
        .store
        .machines(&g.user_id)
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.name)
        .collect();
    assert_eq!(names, vec!["asking", "queued"]);
    let endpoint = receiver["result"]["endpoint"]["id"].as_str().unwrap();
    let mut delivery = hub
        .store
        .open_deliveries(&g.user_id, endpoint, 0, crate::now_ms(), 100)
        .await
        .unwrap()
        .remove(0);
    delivery.acked_at = Some(crate::now_ms());
    hub.store
        .update_delivery(&g.user_id, delivery)
        .await
        .unwrap();
    age_machines().await;
    account.lock().await.sweep().await.unwrap();
    let names: Vec<_> = hub
        .store
        .machines(&g.user_id)
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.name)
        .collect();
    assert_eq!(names, vec!["asking"]);
}
#[tokio::test]
async fn shared_revalidation_failure_closes_each_socket_after_the_same_grace() {
    let (hub, g) = fixture_limits(&["revalidateMs=100"]).await;
    let (account, first, first_close) = connection(&hub, &g).await;
    let (_, second, second_close) = connection(&hub, &g).await;
    let failure = || Err(StoreError::Backend("offline".into()));
    let mut a = account.lock().await;
    a.revalidated(&first, failure(), 1_000).await;
    a.revalidated(&second, failure(), 1_050).await;
    assert_eq!(
        hub.store
            .state(&g.user_id, &format!("revalidate_error:{}", g.token_id))
            .await
            .unwrap(),
        Some("1000".into())
    );
    a.revalidated(&first, failure(), 1_100).await;
    a.revalidated(&second, failure(), 1_100).await;
    assert_eq!(first_close.borrow().as_ref().unwrap().code, 1013);
    assert_eq!(second_close.borrow().as_ref().unwrap().code, 1013);
}

#[tokio::test]
async fn oversized_ack_spends_at_most_a_page_even_when_validation_refuses_it() {
    let (hub, g) = fixture_limits(&["acksPerMinute=101", "accountAcksPerMinute=Infinity"]).await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let seqs: Vec<_> = (1..=101).collect();
    let response = hub
        .call(
            &account,
            &id,
            request(2, "ack", json!({"seqs":seqs})),
            false,
        )
        .await;
    assert_eq!(code(&response), "invalid_params");
    assert_eq!(response["error"]["message"], "at most 100 seqs per ack");
    let response = hub
        .call(&account, &id, request(3, "ack", json!({"seqs":[]})), false)
        .await;
    assert_eq!(response["result"]["acked"], 0);
    assert_eq!(
        code(
            &hub.call(&account, &id, request(4, "ack", json!({"seqs":[]})), false)
                .await
        ),
        "rate_limited"
    );
}
#[tokio::test]
async fn terminal_humans_keep_hops_and_spend_the_account_daily_message_budget() {
    let (hub, g) = fixture_limits(&["userPerDay=2000"]).await;
    let human_hello = || {
        request(
            1,
            "hello",
            json!({"protocol":"scp/1","machine":"terminal","human":true,"tty":true}),
        )
    };
    let human = hub.rpc(g.clone(), human_hello()).await;
    let endpoint = human["result"]["endpoint"]["id"].as_str().unwrap();
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    hub.call(
        &account,
        &id,
        request(2, "mirror", json!({"endpoints":[view("agent")]})),
        false,
    )
    .await;
    let sent = hub
        .call(
            &account,
            &id,
            request(
                3,
                "forward",
                json!({"from":"agent","hop_floor":5,"params":{"to":"acme/","body":"chain"}}),
            ),
            false,
        )
        .await;
    assert_eq!(sent["result"]["hop"], 5);
    let response = hub.rpc(g.clone(),json!([human_hello(),request(2,"send",json!({"to":"host/agent","reply_to":sent["result"]["id"],"body":"from terminal"}))])).await;
    assert_eq!(response[1]["result"]["hop"], 6, "{response}");
    let now = crate::now_ms();
    for n in 0..2000 {
        hub.store
            .store_message(
                &g.user_id,
                scp_relay_store::Message {
                    id: format!("seed{n}"),
                    thread: "daily".into(),
                    reply_to: None,
                    kind: "message".into(),
                    from_ep: endpoint.into(),
                    to_addr: "host/agent".into(),
                    created_at: now,
                    expires_at: now + 86_400_000,
                    envelope: json!({"body":{"text":"x"}}).to_string(),
                },
                vec![],
                None,
            )
            .await
            .unwrap();
    }
    let response = hub
        .rpc(
            g,
            json!([
                human_hello(),
                request(2, "send", json!({"to":"host/agent","body":"one more"}))
            ]),
        )
        .await;
    assert_eq!(code(&response[1]), "rate_limited");
    assert_eq!(
        response[1]["error"]["message"],
        "2000 messages in the last day"
    );
    assert_eq!(response[1]["error"]["data"]["retry_after"], 3600);
}

async fn guard_endpoints(hub: &Hub, g: &Grant) -> (Arc<Mutex<AccountHub>>, Endpoint, Endpoint) {
    let (account, id, _rx) = bridge(hub, g, "host").await;
    let response = hub
        .call(
            &account,
            &id,
            request(
                2,
                "mirror",
                json!({"endpoints":[view("sender"),view("target")]}),
            ),
            false,
        )
        .await;
    assert!(response["error"].is_null(), "{response}");
    let endpoints = account.lock().await.endpoints().await.unwrap();
    let sender = endpoints
        .iter()
        .find(|e| e.handle == "sender")
        .unwrap()
        .clone();
    let target = endpoints
        .iter()
        .find(|e| e.handle == "target")
        .unwrap()
        .clone();
    (account, sender, target)
}

#[tokio::test]
async fn configured_pair_and_tree_windows_and_pause() {
    for key in [
        "pairBurst",
        "pairPerMinute",
        "pairPerHour",
        "treePerMinute",
        "treePerHour",
    ] {
        let setting = format!("{key}=2");
        let (hub, g) = fixture_limits(&[&setting, "treePauseS=90"]).await;
        let (account, sender, target) = guard_endpoints(&hub, &g).await;
        let now = crate::now_ms();
        hub.store
            .hub_write(
                &g.user_id,
                HubWrite {
                    pairs: (0..2)
                        .map(|_| {
                            (
                                scp_relay_store::PairEvent {
                                    from_ep: sender.id.clone(),
                                    to_ep: target.id.clone(),
                                    at: now,
                                },
                                false,
                            )
                        })
                        .collect(),
                    ..HubWrite::default()
                },
            )
            .await
            .unwrap();
        let mut account = account.lock().await;
        let error = account
            .send_guards(
                &sender,
                std::slice::from_ref(&target),
                "fresh",
                None,
                "message",
                now,
            )
            .await
            .unwrap_err();
        if key.starts_with("tree") {
            assert_eq!(error.code, "loop_guard", "{key}");
            assert_eq!(error.retry, Some(90));
            let notices = hub.store.messages(&g.user_id, None, now, 10).await.unwrap();
            assert!(notices.iter().any(|m| m.envelope.contains("1.5 minutes")));
            let paused = account
                .send_guards(
                    &sender,
                    std::slice::from_ref(&target),
                    "fresh",
                    None,
                    "message",
                    now + 1,
                )
                .await
                .unwrap_err();
            assert_eq!(paused.message, "this tree is paused");
        } else {
            assert_eq!(error.code, "rate_limited", "{key}");
            account.limits.apply(&format!("{key}=0")).unwrap();
            account
                .send_guards(
                    &sender,
                    std::slice::from_ref(&target),
                    "fresh",
                    None,
                    "message",
                    now,
                )
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn default_rates_and_loop_guards_allow_more_than_two_thousand_messages() {
    let (hub, g) = fixture().await;
    let (account, sender, target) = guard_endpoints(&hub, &g).await;
    let now = crate::now_ms();
    for n in 0..2001 {
        hub.store
            .store_message(
                &g.user_id,
                scp_relay_store::Message {
                    id: format!("seed{n}"),
                    thread: "shared".into(),
                    reply_to: None,
                    kind: "message".into(),
                    from_ep: sender.id.clone(),
                    to_addr: "host/target".into(),
                    created_at: now,
                    expires_at: now + 86400000,
                    envelope: "{}".into(),
                },
                vec![],
                None,
            )
            .await
            .unwrap();
    }
    hub.store
        .hub_write(
            &g.user_id,
            HubWrite {
                pairs: (0..2001)
                    .map(|n| {
                        (
                            scp_relay_store::PairEvent {
                                from_ep: if n % 2 == 0 {
                                    sender.id.clone()
                                } else {
                                    target.id.clone()
                                },
                                to_ep: if n % 2 == 0 {
                                    target.id.clone()
                                } else {
                                    sender.id.clone()
                                },
                                at: now,
                            },
                            false,
                        )
                    })
                    .collect(),
                ..HubWrite::default()
            },
        )
        .await
        .unwrap();
    let mut account = account.lock().await;
    for _ in 0..32 {
        account
            .send_guards(
                &sender,
                std::slice::from_ref(&target),
                "shared",
                None,
                "message",
                now,
            )
            .await
            .unwrap();
    }
    assert!(
        account
            .ping_pong(&sender, std::slice::from_ref(&target), now)
            .await
            .unwrap()
            .is_empty()
    );
    drop(account);
    let hello = hub.rpc(g, observer_hello()).await;
    let report = &hello["result"]["limits"];
    for key in [
        "hopMax",
        "threadMax",
        "pingPongAlternations",
        "userPerDay",
        "pairBurst",
        "pairPerMinute",
        "pairPerHour",
        "treePerMinute",
        "treePerHour",
        "contactPerMinute",
        "contactPerHour",
        "contactPerDay",
        "contactPerDayMax",
    ] {
        assert!(report.get(key).unwrap().is_null(), "{key}");
    }
    assert_eq!(report["pingPongWindowS"], 600);
    assert_eq!(report["pingPongBlockS"], 600);
    assert_eq!(report["causalWindowS"], 120);
    assert_eq!(report["treePauseS"], 600);
    assert_eq!(report["pairBurstWindowS"], 10);
}

#[tokio::test]
async fn hop_and_thread_guards_are_opt_in() {
    let (hub, g) = fixture().await;
    let (account, sender, target) = guard_endpoints(&hub, &g).await;
    let mut account = account.lock().await;
    let c = Connection {
        grant: Some(g),
        ..Connection::default()
    };
    let mut parent = Value::Null;
    for hop in 0..220 {
        let mut params = json!({"to":"host/target","body":"chain"});
        if !parent.is_null() {
            params["reply_to"] = parent.clone();
        }
        let sent = account
            .send_message(&c, &sender.id, &params, 0, false)
            .await
            .unwrap();
        assert_eq!(sent["hop"], hop);
        parent = sent["id"].clone();
    }
    let params = json!({"to":"host/target","body":"chain","reply_to":parent});
    account.limits.apply_json(r#"{"hopMax":64}"#).unwrap();
    let error = account
        .send_message(&c, &sender.id, &params, 0, false)
        .await
        .unwrap_err();
    assert_eq!(error.code, "loop_guard");
    assert_eq!(error.message, "message exceeds the hop limit of 64");
    account
        .limits
        .apply_json(r#"{"hopMax":null,"threadMax":220}"#)
        .unwrap();
    let error = account
        .send_message(&c, &sender.id, &params, 0, false)
        .await
        .unwrap_err();
    assert_eq!(error.code, "loop_guard");
    assert_eq!(error.message, "thread reached 220 messages");
    account.limits.apply_json(r#"{"threadMax":0}"#).unwrap();
    let sent = account
        .send_message(&c, &sender.id, &params, 0, false)
        .await
        .unwrap();
    assert_eq!(sent["hop"], 220);
    let sent = account
        .send_message(
            &c,
            &sender.id,
            &json!({"to":"host/target","body":"floor"}),
            12345,
            false,
        )
        .await
        .unwrap();
    assert_eq!(sent["hop"], 12345);
    let stored = account
        .store
        .message(&account.account_id, sent["id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&stored.envelope).unwrap()["hop"],
        12345
    );
    account
        .send_guards(
            &sender,
            std::slice::from_ref(&target),
            "fresh",
            None,
            "message",
            crate::now_ms(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn ping_pong_detection_and_durations_are_opt_in() {
    let (hub, g) = fixture().await;
    let (account, sender, target) = guard_endpoints(&hub, &g).await;
    let now = crate::now_ms();
    hub.store
        .hub_write(
            &g.user_id,
            HubWrite {
                pairs: (0..100)
                    .map(|n| {
                        (
                            scp_relay_store::PairEvent {
                                from_ep: if n % 2 == 0 {
                                    sender.id.clone()
                                } else {
                                    target.id.clone()
                                },
                                to_ep: if n % 2 == 0 {
                                    target.id.clone()
                                } else {
                                    sender.id.clone()
                                },
                                at: now - 20_000 + n,
                            },
                            false,
                        )
                    })
                    .collect(),
                ..HubWrite::default()
            },
        )
        .await
        .unwrap();
    let mut account = account.lock().await;
    let recipients = std::slice::from_ref(&target);
    assert!(
        account
            .ping_pong(&sender, recipients, now)
            .await
            .unwrap()
            .is_empty()
    );
    account
        .limits
        .apply_json(r#"{"pingPongAlternations":100,"pingPongWindowS":10,"pingPongBlockS":30}"#)
        .unwrap();
    assert!(
        account
            .ping_pong(&sender, recipients, now)
            .await
            .unwrap()
            .is_empty()
    );
    account
        .limits
        .apply_json(r#"{"pingPongWindowS":60}"#)
        .unwrap();
    let changes = account.ping_pong(&sender, recipients, now).await.unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(
        serde_json::from_str::<i64>(changes[0].1.as_deref().unwrap()).unwrap(),
        now + 30_000
    );
    account
        .send_message(
            &Connection::default(),
            &sender.id,
            &json!({"to":"host/target","body":"ping"}),
            0,
            false,
        )
        .await
        .unwrap();
    let notices = hub.store.messages(&g.user_id, None, now, 10).await.unwrap();
    assert!(
        notices
            .iter()
            .any(|m| m.envelope.contains("0.5 minutes") && m.envelope.contains("100 times"))
    );
    let blocked_until = account
        .store
        .state(&g.user_id, &changes[0].0)
        .await
        .unwrap()
        .unwrap();
    let blocked_at = serde_json::from_str::<i64>(&blocked_until).unwrap() - 30_000;
    let error = account
        .send_guards(&sender, recipients, "fresh", None, "message", blocked_at)
        .await
        .unwrap_err();
    assert_eq!(error.code, "loop_guard");
    assert_eq!(error.retry, Some(30));
    account
        .send_guards(
            &sender,
            recipients,
            "fresh",
            None,
            "message",
            blocked_at + 30_000,
        )
        .await
        .unwrap();
    account
        .limits
        .apply_json(r#"{"pingPongAlternations":null}"#)
        .unwrap();
    assert!(
        account
            .ping_pong(&sender, recipients, now)
            .await
            .unwrap()
            .is_empty()
    );
    drop(account);
    let hello = hub.rpc(g, observer_hello()).await;
    assert_eq!(hello["result"]["limits"]["pingPongWindowS"], 60);
    assert_eq!(hello["result"]["limits"]["pingPongBlockS"], 30);
}

#[tokio::test]
async fn forwarded_hops_keep_their_value_and_validate_unsigned_integers() {
    let (hub, g) = fixture().await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let mirrored = hub
        .call(
            &account,
            &id,
            request(
                2,
                "mirror",
                json!({"endpoints":[view("sender"),view("target")]}),
            ),
            false,
        )
        .await;
    assert!(mirrored["error"].is_null(), "{mirrored}");
    for hop in [
        json!(-1),
        json!(1.5),
        json!(true),
        json!("3"),
        json!(1001),
        Value::Null,
    ] {
        let refused = hub.call(&account, &id, request(3, "forward", json!({"from":"sender","hop_floor":hop,"params":{"to":"host/target","body":"hop"}})), false).await;
        assert_eq!(code(&refused), "invalid_params", "{refused}");
    }
    for hop in [999, 1000] {
        let sent = hub.call(&account, &id, request(4, "forward", json!({"from":"sender","hop_floor":hop,"params":{"to":"host/target","body":"hop"}})), false).await;
        assert_eq!(sent["result"]["hop"], hop, "{sent}");
        let stored = hub
            .store
            .message(&g.user_id, sent["result"]["id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&stored.envelope).unwrap()["hop"],
            hop
        );
        let next = hub
            .call(
                &account,
                &id,
                request(
                    5,
                    "forward",
                    json!({"from":"sender","params":{"to":"host/target","body":"causal"}}),
                ),
                false,
            )
            .await;
        assert_eq!(next["result"]["hop"], hop, "{next}");
    }
    account.lock().await.limits.apply_json(r#"{"hopMax":64,"threadMax":200,"pingPongAlternations":100,"pingPongWindowS":12,"pingPongBlockS":34}"#).unwrap();
    let hello = hub.rpc(g, observer_hello()).await;
    let report = &hello["result"]["limits"];
    for (key, value) in [
        ("hopMax", 64),
        ("threadMax", 200),
        ("pingPongAlternations", 100),
        ("pingPongWindowS", 12),
        ("pingPongBlockS", 34),
    ] {
        assert_eq!(report[key], value, "{key}");
    }
}
