use super::*;

async fn fixture() -> (Arc<Hub>, Grant) {
    fixture_limits(&[]).await
}
async fn fixture_limits(overrides: &[&str]) -> (Arc<Hub>, Grant) {
    let mut limits = crate::http::Limits::default();
    for raw in overrides {
        limits.apply(raw).unwrap();
    }
    let store = scp_relay_store::connect("sqlite::memory:").await.unwrap();
    crate::admin::account(store.as_ref(), "acme").await.unwrap();
    let (a, m) = crate::admin::member(store.as_ref(), "acme", "member", None, None)
        .await
        .unwrap();
    let (_, credential) = crate::admin::credential(&a, &m, true, "test".into(), None);
    store.create_credential(credential.clone()).await.unwrap();
    let identity = match store
        .credential_by_id(&credential.id, crate::now_ms())
        .await
        .unwrap()
    {
        CredentialLookup::Active(i) => i,
        _ => panic!("credential must be active"),
    };
    (
        Arc::new(Hub::new(store, limits)),
        crate::http::grant(&identity),
    )
}
pub(in crate::hub) fn request(id: i64, method: &str, params: Value) -> Value {
    json!({"id":id,"method":method,"params":params})
}
async fn observer(hub: &Hub, grant: &Grant, method: &str, params: Value) -> Value {
    let responses = hub
        .rpc(
            grant.clone(),
            json!([
                request(1, "hello", json!({"protocol":"scp/1","observe":true})),
                request(2, method, params)
            ]),
        )
        .await;
    responses[1].clone()
}
pub(in crate::hub) async fn bridge(
    hub: &Hub,
    g: &Grant,
    machine: &str,
) -> (Arc<Mutex<AccountHub>>, String, mpsc::Receiver<String>) {
    let account = hub.account(g).await;
    let id = crate::random("socket_");
    let (texts, rx) = mpsc::channel(1024);
    let (close, _) = watch::channel(None);
    account.lock().await.connections.insert(
        id.clone(),
        Connection {
            grant: Some(g.clone()),
            socket: Some(SocketHandle { texts, close }),
            ..Connection::default()
        },
    );
    let result = hub
        .call(
            &account,
            &id,
            request(
                1,
                "hello",
                json!({"protocol":"scp/1","bridge":true,"machine":machine}),
            ),
            false,
        )
        .await;
    assert!(result.get("error").is_none(), "{result}");
    (account, id, rx)
}
pub(in crate::hub) fn view(name: &str) -> Value {
    json!({"address":format!("me/{name}"),"kind":"agent","presence":"online","harness":"cli","tree":name,"parent_ep":null,"depth":0})
}
#[tokio::test]
async fn claim_resume_long_poll_and_deduplication() {
    let (hub, g) = fixture().await;
    let claimed = hub
        .rpc(
            g.clone(),
            request(
                1,
                "hello",
                json!({"protocol":"scp/1","machine":"direct","claim":{"handle":"agent"}}),
            ),
        )
        .await;
    let token = claimed["result"]["token"].clone();
    let endpoint = claimed["result"]["endpoint"]["id"].clone();
    let waiting = {
        let hub = hub.clone();
        let g = g.clone();
        let token = token.clone();
        tokio::spawn(async move {
            hub.rpc(
                g,
                json!([
                    request(
                        1,
                        "hello",
                        json!({"protocol":"scp/1","machine":"direct","resume":token})
                    ),
                    request(2, "inbox", json!({"wait_s":2}))
                ]),
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (account, id, _rx) = bridge(&hub, &g, "source").await;
    let mirror = hub
        .call(
            &account,
            &id,
            request(
                2,
                "mirror",
                json!({"endpoints":[view("sender")],"full":true}),
            ),
            false,
        )
        .await;
    assert_eq!(mirror["result"]["changed"], 1);
    let send = request(
        3,
        "forward",
        json!({"from":"sender","params":{"to":"direct/agent","body":"hello","client_id":"stable"}}),
    );
    let sent = hub.call(&account, &id, send.clone(), false).await;
    assert!(sent.get("error").is_none(), "{sent}");
    let log = observer(&hub, &g, "log", json!({})).await;
    assert_eq!(
        log["result"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["ref"] == sent["result"]["id"])
            .unwrap()["endpoint"],
        "acme/source/sender"
    );
    let inbox = waiting.await.unwrap();
    assert_eq!(inbox[0]["result"]["endpoint"]["id"], endpoint);
    assert_eq!(
        inbox[1]["result"]["messages"][0]["id"],
        sent["result"]["id"]
    );
    let duplicate = hub.call(&account, &id, send, false).await;
    assert_eq!(duplicate["result"]["duplicate"], true);
    assert_eq!(duplicate["result"]["id"], sent["result"]["id"]);
    let inbox = hub
        .rpc(
            g.clone(),
            json!([
                request(
                    1,
                    "hello",
                    json!({"protocol":"scp/1","machine":"direct","resume":token})
                ),
                request(2, "inbox", json!({}))
            ]),
        )
        .await;
    assert_eq!(inbox[1]["result"]["messages"].as_array().unwrap().len(), 1);
    let conflict=hub.call(&account,&id,request(4,"forward",json!({"from":"sender","params":{"to":"direct/agent","body":"different","client_id":"stable"}})),false).await;
    assert_eq!(conflict["error"]["data"]["code"], "invalid_params");
    let hop=hub.call(&account,&id,request(5,"forward",json!({"from":"sender","hop_floor":65,"params":{"to":"direct/agent","body":"loop"}})),false).await;
    assert_eq!(hop["error"]["data"]["code"], "loop_guard");
}
#[tokio::test]
async fn mirror_sync_rename_placement_and_scope_caps() {
    let (hub, g) = fixture().await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let call = |id, params| request(id, "mirror", params);
    let result = hub
        .call(
            &account,
            &id,
            call(
                2,
                json!({"endpoints":[view("old"),view("other")],"full":true}),
            ),
            false,
        )
        .await;
    assert_eq!(result["result"]["changed"], 2);
    let mut renamed_view = view("new");
    renamed_view["was"] = json!("old");
    let renamed = hub
        .call(
            &account,
            &id,
            call(3, json!({"endpoints":[renamed_view]})),
            false,
        )
        .await;
    assert!(renamed.get("error").is_none());
    let root =
        json!({"address":"me/root","kind":"agent","presence":"online","parent_ep":null,"depth":0});
    let child = json!({"address":"me/child","kind":"agent","presence":"online","parent_ep":"root","depth":15,"tree":"fake"});
    hub.call(
        &account,
        &id,
        call(
            4,
            json!({"endpoints":[child,root],"sync":{"id":"sync","part":1,"parts":2}}),
        ),
        false,
    )
    .await;
    hub.call(
        &account,
        &id,
        call(
            5,
            json!({"endpoints":[],"sync":{"id":"sync","part":2,"parts":2}}),
        ),
        false,
    )
    .await;
    let listed = observer(&hub, &g, "list", json!({"all":true})).await;
    let endpoints = listed["result"]["endpoints"].as_array().unwrap();
    let child = endpoints
        .iter()
        .find(|e| e["address"] == "acme/host/child")
        .unwrap();
    assert_eq!(child["depth"], 1);
    assert_eq!(child["tree"], "root");
    assert!(!endpoints.iter().any(|e| e["address"] == "acme/host/old"));
    assert_eq!(
        endpoints
            .iter()
            .find(|e| e["address"] == "acme/host/other")
            .unwrap()["presence"],
        "offline"
    );
    let secret=hub.call(&account,&id,call(6,json!({"endpoints":[{"address":"me/secret","kind":"agent","token":format!("kre_{}","a".repeat(64))}]})),false).await;
    assert_eq!(secret["error"]["data"]["code"], "secret_refused");
    let invalid = hub
        .call(
            &account,
            &id,
            call(
                7,
                json!({"endpoints":[{"address":"me/bad","kind":"agent","caps":[]}]}),
            ),
            false,
        )
        .await;
    assert_eq!(invalid["error"]["data"]["code"], "invalid_params");
    account.lock().await.closed(&id, false).await;
}
#[tokio::test]
async fn scoped_admission_and_thread_membership() {
    let (hub, g) = fixture().await;
    let (account, a, _) = bridge(&hub, &g, "source").await;
    let (_, b, _) = bridge(&hub, &g, "sink").await;
    hub.call(
        &account,
        &a,
        request(2, "mirror", json!({"endpoints":[view("sender")]})),
        false,
    )
    .await;
    let mut target = view("target");
    target["rules"] = json!({"in":[]});
    hub.call(
        &account,
        &b,
        request(2, "mirror", json!({"endpoints":[target]})),
        false,
    )
    .await;
    let send = request(
        3,
        "forward",
        json!({"from":"sender","params":{"to":"sink/target","body":"blocked"}}),
    );
    assert_eq!(
        hub.call(&account, &a, send.clone(), false).await["error"]["data"]["code"],
        "not_found"
    );
    let mut target = view("target");
    target["rules"] = json!({"in":["machine:source"]});
    hub.call(
        &account,
        &b,
        request(3, "mirror", json!({"endpoints":[target]})),
        false,
    )
    .await;
    let sent = hub.call(&account, &a, send, false).await;
    assert!(sent.get("error").is_none(), "{sent}");
    let mut stranger = view("stranger");
    stranger["rules"] = Value::Null;
    hub.call(
        &account,
        &b,
        request(4, "mirror", json!({"endpoints":[stranger]})),
        false,
    )
    .await;
    let result=hub.call(&account,&b,request(5,"forward",json!({"from":"stranger","params":{"to":"source/sender","body":"intrude","thread":sent["result"]["thread"]}})),false).await;
    assert_eq!(result["error"]["data"]["code"], "not_found");
}

#[tokio::test]
async fn periodic_expiry_releases_idle_clients_and_preserves_bridges() {
    let (hub, g) = fixture().await;
    let account = hub.account(&g).await;
    account
        .lock()
        .await
        .limits
        .apply("clientMachineIdleS=1")
        .unwrap();
    hub.rpc(
        g.clone(),
        request(
            1,
            "hello",
            json!({"protocol":"scp/1","machine":"idle","claim":{"handle":"agent"}}),
        ),
    )
    .await;
    let (_, bridge_id, _) = bridge(&hub, &g, "durable").await;
    account.lock().await.closed(&bridge_id, false).await;
    let maintenance = tokio::spawn(hub.clone().maintain());
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let machines = observer(&hub, &g, "machines", json!({})).await;
            let machines = machines["result"]["machines"].as_array().unwrap();
            if !machines.iter().any(|m| m["name"] == "idle") {
                assert!(machines.iter().any(|m| m["name"] == "durable"));
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    hub.shutdown();
    maintenance.await.unwrap();
}

#[tokio::test]
async fn out_of_order_sync_parts_only_apply_deltas() {
    let (hub, g) = fixture().await;
    let (account, id, _) = bridge(&hub, &g, "host").await;
    hub.call(
        &account,
        &id,
        request(2, "mirror", json!({"endpoints":[view("keep")],"full":true})),
        false,
    )
    .await;
    for (n, part) in [1, 3, 1, 2, 3].into_iter().enumerate() {
        let result = hub
            .call(
                &account,
                &id,
                request(
                    n as i64 + 3,
                    "mirror",
                    json!({"endpoints":[view("new")],"sync":{"id":"broken","part":part,"parts":3}}),
                ),
                false,
            )
            .await;
        assert!(result.get("error").is_none(), "{result}");
    }
    let listed = observer(&hub, &g, "list", json!({"all":true})).await;
    assert_eq!(
        listed["result"]["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["address"] == "acme/host/keep")
            .unwrap()["presence"],
        "online"
    );
}

#[tokio::test]
async fn subscribe_pages_and_acknowledgements_share_a_durable_cursor() {
    let (hub, g) = fixture().await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    hub.call(
        &account,
        &id,
        request(2, "mirror", json!({"endpoints":[view("agent")]})),
        false,
    )
    .await;
    let endpoint = account
        .lock()
        .await
        .endpoints()
        .await
        .unwrap()
        .into_iter()
        .find(|e| e.handle == "agent")
        .unwrap();
    let store = account.lock().await.store.clone();
    let now = crate::now_ms();
    for n in 0..201 {
        let message_id = format!("msg_{n:016x}");
        let envelope = json!({"id":message_id,"thread":"thr_queue","reply_to":null,"kind":"message","from":{"address":"acme/source/sender","endpoint":"sender","user":"acme","auth":"account","claims":{"harness":"cli","model":null}},"to":"host/agent","body":{"text":"queued","mime":"text/markdown"},"attachments":[],"data_class":"public","hop":0,"created_at":iso(now),"expires_at":iso(now+60000)});
        store
            .store_message(
                &g.user_id,
                scp_relay_store::Message {
                    id: message_id,
                    thread: "thr_queue".into(),
                    reply_to: None,
                    kind: "message".into(),
                    from_ep: "sender".into(),
                    to_addr: "host/agent".into(),
                    created_at: now,
                    expires_at: now + 60000,
                    envelope: envelope.to_string(),
                },
                vec![scp_relay_store::NewDelivery {
                    endpoint: endpoint.id.clone(),
                    expires_at: now + 60000,
                    state: "{}".into(),
                }],
                None,
            )
            .await
            .unwrap();
    }
    let (texts, mut replay_rx) = mpsc::channel(32);
    let mut hub_state = account.lock().await;
    let socket = hub_state
        .connections
        .get_mut(&id)
        .unwrap()
        .socket
        .as_mut()
        .unwrap();
    socket.texts = texts;
    let closing = socket.close.subscribe();
    drop(hub_state);
    let replay = hub.call(
        &account,
        &id,
        request(3, "subscribe", json!({"after":0})),
        false,
    );
    let drain = async {
        let mut seqs = Vec::new();
        while seqs.len() < 201 {
            let frame = replay_rx.recv().await.unwrap();
            let frame: Value = serde_json::from_str(&frame).unwrap();
            assert_eq!(frame["method"], "deliver");
            seqs.push(frame["params"]["seq"].as_i64().unwrap());
        }
        seqs
    };
    let (replay, seqs) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(replay, drain)
    })
    .await
    .unwrap();
    assert_eq!(replay["result"]["replayed"], 201);
    assert!(closing.borrow().is_none());
    assert_eq!(seqs.len(), 201);
    assert!(seqs.windows(2).all(|w| w[0] < w[1]));
    for page in seqs.chunks(100) {
        let ack = hub
            .call(
                &account,
                &id,
                request(4, "ack", json!({"seqs":page})),
                false,
            )
            .await;
        assert_eq!(ack["result"]["acked"], page.len());
    }
    let replay = hub
        .call(
            &account,
            &id,
            request(5, "subscribe", json!({"after":0})),
            false,
        )
        .await;
    assert_eq!(replay["result"]["replayed"], 0);
}

#[tokio::test]
async fn null_incarnation_keeps_caps_and_a_new_holder_discards_delivery_rows() {
    let (hub, g) = fixture().await;
    let (account, source, _) = bridge(&hub, &g, "source").await;
    let (_, target, _) = bridge(&hub, &g, "sink").await;
    hub.call(
        &account,
        &source,
        request(2, "mirror", json!({"endpoints":[view("sender")]})),
        false,
    )
    .await;
    let mut endpoint = view("target");
    endpoint["incarnation"] = json!("holder.0");
    endpoint["caps"] =
        json!({"caps":[{"id":"bound","dir":"in","by":"human","sels":[{"sel":"machine:source"}]}]});
    hub.call(
        &account,
        &target,
        request(2, "mirror", json!({"endpoints":[endpoint]})),
        false,
    )
    .await;
    let sent = hub
        .call(
            &account,
            &source,
            request(
                3,
                "forward",
                json!({"from":"sender","params":{"to":"sink/target","body":"for the old holder"}}),
            ),
            false,
        )
        .await;
    assert!(sent.get("error").is_none(), "{sent}");
    let mut endpoint = view("target");
    endpoint["incarnation"] = Value::Null;
    endpoint["caps"] = Value::Null;
    hub.call(
        &account,
        &target,
        request(3, "mirror", json!({"endpoints":[endpoint]})),
        false,
    )
    .await;
    let rows = account.lock().await.endpoints().await.unwrap();
    let row = rows.iter().find(|e| e.handle == "target").unwrap();
    assert_eq!(fields(row)["incarnation"], "holder.0");
    assert_eq!(fields(row)["caps"]["caps"].as_array().unwrap().len(), 1);
    let store = account.lock().await.store.clone();
    assert_eq!(
        store
            .message_deliveries(&g.user_id, sent["result"]["id"].as_str().unwrap())
            .await
            .unwrap()
            .len(),
        1
    );
    let mut endpoint = view("target");
    endpoint["incarnation"] = json!("replacement");
    hub.call(
        &account,
        &target,
        request(4, "mirror", json!({"endpoints":[endpoint]})),
        false,
    )
    .await;
    assert!(
        store
            .message_deliveries(&g.user_id, sent["result"]["id"].as_str().unwrap())
            .await
            .unwrap()
            .is_empty()
    );
    hub.call(
        &account,
        &target,
        request(
            5,
            "mirror",
            json!({"endpoints":[{"address":"me/unknown","kind":"agent","tree":"fake"}]}),
        ),
        false,
    )
    .await;
    let rows = account.lock().await.endpoints().await.unwrap();
    let unknown = rows.iter().find(|e| e.handle == "unknown").unwrap();
    assert!(fields(unknown)["tree"].is_null());
    assert!(fields(unknown)["depth"].is_null());
}

#[tokio::test]
async fn idle_purge_preserves_tombstones() {
    let (hub, g) = fixture().await;
    let (account, id, _) = bridge(&hub, &g, "host").await;
    hub.call(
        &account,
        &id,
        request(2, "mirror", json!({"endpoints":[view("agent")]})),
        false,
    )
    .await;
    let mut account = account.lock().await;
    account.limits.apply("idlePurgeS=1").unwrap();
    account.revoke(&g.token_id).await;
    account.closed(&id, false).await;
    account
        .store
        .put_state(
            &g.user_id,
            "idle_since",
            Some(&json!(crate::now_ms() - 2000).to_string()),
        )
        .await
        .unwrap();
    account.sweep().await.unwrap();
    assert_eq!(account.store.tombstones(&g.user_id).await.unwrap().len(), 1);
    assert!(!account.endpoints().await.unwrap().is_empty());
    assert!(
        account
            .store
            .state(&g.user_id, "idle_since")
            .await
            .unwrap()
            .is_none()
    );
}

#[test]
fn credential_scanning_and_redaction_handle_unicode_boundaries() {
    let token = format!("scp_t_{}", "a".repeat(64));
    assert!(validation::secret(&format!("文{token}")));
    assert_eq!(
        validation::redact(&format!("文{token}")),
        "文[redacted implementation token]"
    );
    let ordinary = "token=abcdefghijklmnopqrst";
    assert!(!validation::secret(ordinary));
    let text = format!("{ordinary}; secret=abcdefghijklmnopqr12");
    assert_eq!(
        validation::redact(&text),
        format!("{ordinary}; [redacted assigned secret]")
    );
}

#[tokio::test]
async fn observer_hello_resets_idle_retention() {
    let (hub, g) = fixture().await;
    let account = hub.account(&g).await;
    account
        .lock()
        .await
        .store
        .put_state(&g.user_id, "idle_since", Some("0"))
        .await
        .unwrap();
    let response = observer(&hub, &g, "list", json!({})).await;
    assert!(response.get("error").is_none());
    assert!(
        account
            .lock()
            .await
            .store
            .state(&g.user_id, "idle_since")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn an_empty_http_batch_registers_no_connection() {
    let (hub, g) = fixture().await;
    let result = hub.rpc(g.clone(), json!([])).await;
    assert_eq!(result["error"]["code"], -32600);
    assert!(hub.account(&g).await.lock().await.connections.is_empty());
    let batch = vec![request(1, "missing", json!({})); 65];
    assert_eq!(hub.rpc(g, json!(batch)).await.as_array().unwrap().len(), 65);
}

#[tokio::test]
async fn cancelled_http_wait_removes_connection_with_large_wait_limit() {
    let (hub, g) = fixture().await;
    let store = hub.store.clone();
    let mut limits = crate::http::Limits::default();
    limits.apply("httpWaitS=18446744073709551615").unwrap();
    let hub = Arc::new(Hub::new(store, limits));
    let account = hub.account(&g).await;
    let task = {
        let hub = hub.clone();
        tokio::spawn(async move {
            hub.rpc(
                g,
                json!([
                    request(
                        1,
                        "hello",
                        json!({"protocol":"scp/1","machine":"direct","claim":{"handle":"waiting"}})
                    ),
                    request(2, "inbox", json!({"wait_s":1e300}))
                ]),
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if account
                .lock()
                .await
                .connections
                .values()
                .any(|c| !c.endpoint.is_empty())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!task.is_finished());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(2), async {
        while !account.lock().await.connections.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn bridge_close_announces_only_presence_changes() {
    let (hub, g) = fixture().await;
    let (account, source, _source_rx) = bridge(&hub, &g, "source").await;
    let (_, _, mut watcher_rx) = bridge(&hub, &g, "watcher").await;
    let mut sleeping = view("sleeping");
    sleeping["presence"] = json!("hibernated");
    sleeping["last_seen"] = json!("2026-01-01T00:00:00.000Z");
    let mut offline = view("offline");
    offline["presence"] = json!("offline");
    let result = hub
        .call(
            &account,
            &source,
            request(
                2,
                "mirror",
                json!({"endpoints":[view("awake"), sleeping, offline]}),
            ),
            false,
        )
        .await;
    assert!(result.get("error").is_none(), "{result}");
    while watcher_rx.try_recv().is_ok() {}
    let rows = account.lock().await.endpoints().await.unwrap();
    let sleeping = rows.iter().find(|e| e.handle == "sleeping").unwrap();
    assert_eq!(
        account.lock().await.view(sleeping)["last_seen"],
        "2026-01-01T00:00:00.000Z"
    );
    account.lock().await.closed(&source, false).await;
    let frame: Value = serde_json::from_str(&watcher_rx.recv().await.unwrap()).unwrap();
    assert_eq!(frame["method"], "endpoints");
    assert_eq!(frame["params"]["full"], false);
    let endpoints = frame["params"]["endpoints"].as_array().unwrap();
    assert_eq!(endpoints.len(), 1);
    assert!(
        endpoints[0]["address"]
            .as_str()
            .unwrap()
            .ends_with("/awake")
    );
    assert_eq!(endpoints[0]["presence"], "offline");
    let rows = account.lock().await.endpoints().await.unwrap();
    assert_eq!(
        fields(rows.iter().find(|e| e.handle == "sleeping").unwrap())["presence"],
        "hibernated"
    );
}

#[path = "limit_tests.rs"]
mod limit_tests;
#[path = "xacct_tests.rs"]
mod xacct_tests;
