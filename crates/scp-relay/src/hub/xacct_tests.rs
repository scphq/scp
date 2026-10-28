use super::*;
use crate::hub::xacct::{Gate, GateContext, GateVerdict, Redacted, XMessage};
use scp_relay_store::{ContactConfig, XAllow, XLimits};

struct Linked {
    hub: Arc<Hub>,
    ga: Grant,
    gb: Grant,
    a: Arc<Mutex<AccountHub>>,
    b: Arc<Mutex<AccountHub>>,
    ai: String,
    bi: String,
    arx: mpsc::Receiver<String>,
    brx: mpsc::Receiver<String>,
}
async fn linked(gate: Option<Arc<dyn Gate>>) -> Linked {
    linked_limits(gate, &[]).await
}
async fn linked_limits(gate: Option<Arc<dyn Gate>>, overrides: &[&str]) -> Linked {
    let (hub, ga) = fixture_limits(overrides).await;
    crate::admin::account(hub.store.as_ref(), "beta")
        .await
        .unwrap();
    let (account, member) =
        crate::admin::member(hub.store.as_ref(), "beta", "operator", None, None)
            .await
            .unwrap();
    let (_, credential) = crate::admin::credential(&account, &member, true, "bridge".into(), None);
    hub.store
        .create_credential(credential.clone())
        .await
        .unwrap();
    let gb = Grant {
        token_id: credential.id,
        user_id: account.id,
        actor_id: member.id,
        role: Role::Owner,
        scoped: false,
        labels: BTreeMap::new(),
        expires_at: i64::MAX,
        account: "beta".into(),
    };
    let hub = if let Some(gate) = gate {
        Arc::new(Hub::with_gate(
            hub.store.clone(),
            crate::http::Limits::default(),
            gate,
        ))
    } else {
        hub
    };
    hub.store
        .contact_invite(&ga.user_id, &gb.user_id, crate::now_ms())
        .await
        .unwrap();
    hub.store
        .contact_accept(&gb.user_id, &ga.user_id, crate::now_ms())
        .await
        .unwrap();
    let (a, ai, arx) = bridge(&hub, &ga, "laptop").await;
    let (b, bi, brx) = bridge(&hub, &gb, "desk").await;
    for (account, id) in [(&a, &ai), (&b, &bi)] {
        let result = hub
            .call(
                account,
                id,
                request(
                    2,
                    "mirror",
                    json!({"endpoints":[view("root"),view("other")]}),
                ),
                false,
            )
            .await;
        assert!(result.get("error").is_none(), "{result}");
        let result = hub
            .call(
                account,
                id,
                request(3, "subscribe", json!({"after":0})),
                false,
            )
            .await;
        assert!(result.get("error").is_none(), "{result}");
    }
    Linked {
        hub,
        ga,
        gb,
        a,
        b,
        ai,
        bi,
        arx,
        brx,
    }
}
impl Linked {
    async fn send(&self, reverse: bool, params: Value) -> Value {
        let (a, id, to) = if reverse {
            (&self.b, &self.bi, "acme/laptop/root")
        } else {
            (&self.a, &self.ai, "beta/desk/root")
        };
        let mut p = json!({"to":to,"body":"hello"});
        for (k, v) in params.as_object().unwrap() {
            p[k] = v.clone();
        }
        self.hub
            .call(
                a,
                id,
                request(7, "forward", json!({"from":"root","params":p})),
                false,
            )
            .await
    }
    async fn config(&self, reverse: bool, config: ContactConfig) {
        let (a, b) = if reverse {
            (&self.gb.user_id, &self.ga.user_id)
        } else {
            (&self.ga.user_id, &self.gb.user_id)
        };
        self.hub
            .store
            .contact_update(a, b, config, crate::now_ms())
            .await
            .unwrap();
    }
    async fn rules(&self, reverse: bool, rules: Value) {
        let account = if reverse { &self.b } else { &self.a };
        let hub = account.lock().await;
        let mut e = hub
            .endpoints()
            .await
            .unwrap()
            .into_iter()
            .find(|e| e.handle == "root")
            .unwrap();
        let mut f = fields(&e);
        f["rules"] = rules;
        e.fields = f.to_string();
        hub.store.put_endpoint(&hub.account_id, e).await.unwrap();
    }
    async fn call_b(&self, method: &str, p: Value) -> Value {
        self.hub
            .call(&self.b, &self.bi, request(8, method, p), false)
            .await
    }
}
fn deliveries(rx: &mut mpsc::Receiver<String>) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(s) = rx.try_recv() {
        let v: Value = serde_json::from_str(&s).unwrap();
        if v["method"] == "deliver" {
            out.push(v["params"].clone());
        }
    }
    out
}
#[tokio::test]
async fn contact_delivery_and_reply_grant() {
    let mut r = linked(None).await;
    r.rules(false, json!({"in":[],"out":["acct:beta"]})).await;
    r.rules(true, json!({"in":["acct:acme"],"out":[]})).await;
    let sent = r
        .send(false, json!({"kind":"request","client_id":"first"}))
        .await;
    assert!(sent["error"].is_null(), "{sent}");
    assert_eq!(
        sent["result"]["deliveries"],
        json!([{"endpoint":"beta/desk/root","address":"beta/desk/root","seq":0,"offline":false,"last_seen":null}])
    );
    let got = deliveries(&mut r.brx);
    assert_eq!(got.len(), 1);
    let m = &got[0]["message"];
    assert_eq!(got[0]["endpoint"], "desk/root");
    assert_eq!(
        m["from"],
        json!({"address":"acme/laptop/root","endpoint":"acme/laptop/root","user":"acme","auth":"contact","machine":"laptop","claims":{"harness":"cli","model":null},"rel":"contact:acme","account":"acme"})
    );
    assert_eq!(m["data_class"], "public");
    assert_eq!(m["attachments"], json!([]));
    assert_eq!(
        r.send(true, json!({})).await["error"]["data"]["code"],
        "not_found"
    );
    let reply = r
        .send(
            true,
            json!({"reply_to":m["id"],"kind":"reply","thread":"ignored"}),
        )
        .await;
    assert!(reply["error"].is_null(), "{reply}");
    assert_eq!(reply["result"]["thread"], m["thread"]);
    assert_eq!(reply["result"]["hop"], 1);
    let back = deliveries(&mut r.arx);
    assert_eq!(back.len(), 1);
    assert_eq!(back[0]["message"]["reply_to"], m["id"]);
    assert_eq!(
        r.send(true, json!({"to":"acme/laptop/other","reply_to":m["id"]}))
            .await["error"]["data"]["code"],
        "not_found"
    );
}
#[tokio::test]
async fn contact_direction_allowlist_and_scopes_fail_closed() {
    let r = linked(None).await;
    for reverse in [false, true] {
        r.config(
            reverse,
            ContactConfig {
                dir: if reverse { "out" } else { "in" }.into(),
                ..ContactConfig::default()
            },
        )
        .await;
        assert_eq!(
            r.send(false, json!({})).await["error"]["data"]["code"],
            "not_found"
        );
        r.config(reverse, ContactConfig::default()).await;
        r.config(
            reverse,
            ContactConfig {
                allow: vec![],
                ..ContactConfig::default()
            },
        )
        .await;
        assert_eq!(
            r.send(false, json!({})).await["error"]["data"]["code"],
            "not_found"
        );
        r.config(reverse, ContactConfig::default()).await;
        for rules in [json!({"in":[],"out":[]}), json!({"in":["*"],"out":["*"]})] {
            r.rules(reverse, rules).await;
            assert_eq!(
                r.send(false, json!({})).await["error"]["data"]["code"],
                "not_found"
            );
        }
        r.rules(reverse, Value::Null).await;
    }
    r.hub
        .store
        .contact_revoke(&r.ga.user_id, &r.gb.user_id, crate::now_ms())
        .await
        .unwrap();
    assert_eq!(
        r.send(false, json!({})).await["error"]["data"]["code"],
        "not_found"
    );
}
#[tokio::test]
async fn cross_limits_and_deduplication() {
    let mut r = linked_limits(None, &["contactPerMinute=10"]).await;
    assert_eq!(
        r.send(false, json!({"body":"é".repeat(8193)})).await["error"]["data"]["code"],
        "too_large"
    );
    assert_eq!(
        r.send(false, json!({"data_class":"private"})).await["error"]["data"]["code"],
        "data_class_refused"
    );
    assert_eq!(
        r.send(false, json!({"attachments":[{"name":"file"}]}))
            .await["error"]["data"]["code"],
        "data_class_refused"
    );
    r.a.lock()
        .await
        .limits
        .apply_json(r#"{"hopMax":8}"#)
        .unwrap();
    let hop = r
        .hub
        .call(
            &r.a,
            &r.ai,
            request(
                9,
                "forward",
                json!({"from":"root","hop_floor":9,"params":{"to":"beta/desk/root","body":"hi"}}),
            ),
            false,
        )
        .await;
    assert_eq!(hop["error"]["data"]["code"], "loop_guard");
    let first = r.send(false, json!({"client_id":"same"})).await;
    let dup = r
        .send(false, json!({"client_id":"same","body":"ignored on retry"}))
        .await;
    assert_eq!(dup["result"]["id"], first["result"]["id"]);
    assert_eq!(dup["result"]["duplicate"], true);
    assert_eq!(deliveries(&mut r.brx).len(), 1);
    for _ in 0..8 {
        assert!(r.send(false, json!({})).await["error"].is_null());
    }
    let limit = r.send(false, json!({})).await;
    assert_eq!(limit["error"]["data"]["code"], "rate_limited");
    assert!(limit["error"]["data"]["retry_after"].as_i64().unwrap() > 0);
}
#[tokio::test]
async fn contact_discovery_and_pruning() {
    let mut r = linked(None).await;
    r.config(
        true,
        ContactConfig {
            allow: vec![XAllow {
                machine: "desk".into(),
                sel: "ep:desk/root".into(),
                allow_worker: None,
            }],
            ..ContactConfig::default()
        },
    )
    .await;
    let listed = observer(&r.hub, &r.ga, "list", json!({"contacts":true})).await;
    assert_eq!(
        listed["result"],
        json!({"contacts":[{"address":"beta/desk/root","harness":"cli","presence":"online"}]})
    );
    r.b.lock()
        .await
        .connections
        .get_mut(&r.bi)
        .unwrap()
        .subscribed = false;
    assert_eq!(
        r.send(false, json!({})).await["result"]["deliveries"][0]["offline"],
        true
    );
    r.hub
        .store
        .contact_revoke(&r.ga.user_id, &r.gb.user_id, crate::now_ms())
        .await
        .unwrap();
    let replay = r.call_b("subscribe", json!({"after":0})).await;
    assert_eq!(replay["result"]["replayed"], 0);
    assert!(deliveries(&mut r.brx).is_empty());
    assert_eq!(r.hub.store.xinbox(&r.gb.user_id).await.unwrap().len(), 1);
    r.b.lock().await.sweep().await.unwrap();
    assert!(r.hub.store.xinbox(&r.gb.user_id).await.unwrap().is_empty());
}
#[tokio::test]
async fn opposite_sends_never_hold_two_account_locks() {
    let mut r = linked(None).await;
    let (a, b) = tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(r.send(false, json!({})), r.send(true, json!({})))
    })
    .await
    .expect("cross-account sends deadlocked");
    assert!(a["error"].is_null(), "{a}");
    assert!(b["error"].is_null(), "{b}");
    assert_eq!(deliveries(&mut r.arx).len(), 1);
    assert_eq!(deliveries(&mut r.brx).len(), 1);
}
#[tokio::test]
async fn independent_replay_cursor_and_prefix_ack_reject() {
    let mut r = linked(None).await;
    r.b.lock()
        .await
        .connections
        .get_mut(&r.bi)
        .unwrap()
        .subscribed = false;
    for i in 0..3 {
        assert!(r.send(false, json!({"body":format!("{i}")})).await["error"].is_null());
    }
    let xs = r.hub.store.xinbox(&r.gb.user_id).await.unwrap();
    let seqs: Vec<_> = xs.iter().map(|x| x.seq).collect();
    assert_eq!(
        r.call_b("subscribe", json!({"after":seqs[2]+100})).await["result"]["replayed"],
        3
    );
    deliveries(&mut r.brx);
    assert_eq!(
        r.call_b("ack", json!({"seqs":[seqs[2]]})).await["result"]["acked"],
        0
    );
    assert_eq!(
        r.call_b("reject", json!({"seq":seqs[1],"code":"policy_refused"}))
            .await["result"]["rejected"],
        true
    );
    assert_eq!(
        r.call_b("ack", json!({"seqs":[seqs[0]]})).await["result"]["acked"],
        1
    );
    assert_eq!(
        r.call_b("subscribe", json!({"after":0})).await["result"]["replayed"],
        2
    );
    assert_eq!(
        r.call_b("ack", json!({"seqs":[seqs[1],seqs[2]]})).await["result"]["acked"],
        2
    );
    assert_eq!(
        r.call_b("subscribe", json!({"after":0})).await["result"]["replayed"],
        0
    );
}
#[tokio::test]
async fn receiver_applies_declared_limits_and_counts_after_restart() {
    let r = linked(None).await;
    r.config(
        false,
        ContactConfig {
            limits: Some(XLimits {
                per_minute: Some(1),
                ..XLimits::default()
            }),
            ..ContactConfig::default()
        },
    )
    .await;
    assert!(r.send(false, json!({})).await["error"].is_null());
    r.a.lock().await.xcounters = xcounters::Counters::default();
    assert_eq!(
        r.send(false, json!({})).await["error"]["data"]["code"],
        "rate_limited"
    );
}
struct VerdictGate {
    side: &'static str,
    verdict: GateVerdict,
}
#[async_trait::async_trait]
impl Gate for VerdictGate {
    async fn egress(&self, _: &XMessage, _: &GateContext) -> GateVerdict {
        if self.side == "egress" {
            self.verdict.clone()
        } else {
            GateVerdict::Pass
        }
    }
    async fn ingress(&self, _: &XMessage, _: &GateContext) -> GateVerdict {
        if self.side == "ingress" {
            self.verdict.clone()
        } else {
            GateVerdict::Pass
        }
    }
}
#[tokio::test]
async fn gate_hold_duplicate_refusal_and_redaction_shapes() {
    for side in ["egress", "ingress"] {
        for verdict in [
            GateVerdict::Hold {
                hold_id: "hold_one".into(),
            },
            GateVerdict::Duplicate {
                hold_id: "hold_one".into(),
            },
            GateVerdict::Refuse {
                code: "judge_refused".into(),
                categories: vec!["credential".into()],
                retry_after: Some(9),
            },
        ] {
            let mut r = linked(Some(Arc::new(VerdictGate {
                side,
                verdict: verdict.clone(),
            })))
            .await;
            let result = r.send(false, json!({})).await;
            match verdict {
                GateVerdict::Hold { .. } => assert_eq!(
                    result["result"]["held"],
                    json!({"hold_id":"hold_one","side":side})
                ),
                GateVerdict::Duplicate { .. } => assert_eq!(result["result"]["duplicate"], true),
                GateVerdict::Refuse { .. } => assert_eq!(
                    result["error"]["data"],
                    json!({"code":"judge_refused","side":side,"categories":["credential"]})
                ),
                _ => unreachable!(),
            }
            assert!(deliveries(&mut r.brx).is_empty());
            assert!(r.hub.store.xinbox(&r.gb.user_id).await.unwrap().is_empty());
            assert_eq!(
                r.hub
                    .store
                    .state(&r.ga.user_id, &format!("xcounters:{}", r.gb.user_id))
                    .await
                    .unwrap()
                    .is_some(),
                side == "ingress"
            );
        }
        let mut r = linked(Some(Arc::new(VerdictGate {
            side,
            verdict: GateVerdict::Redact {
                body: "safe".into(),
                redacted: Redacted {
                    n: 1,
                    kinds: vec!["value".into()],
                },
            },
        })))
        .await;
        let result = r.send(false, json!({})).await;
        assert_eq!(
            result["result"]["redacted"],
            json!({"n":1,"kinds":["value"]})
        );
        assert_eq!(deliveries(&mut r.brx)[0]["message"]["body"]["text"], "safe");
    }
}

struct ControlledGate {
    fail_ingress: std::sync::atomic::AtomicBool,
    hold_egress: bool,
    seen: Mutex<Vec<(XMessage, GateContext)>>,
}
#[async_trait::async_trait]
impl Gate for ControlledGate {
    async fn egress(&self, m: &XMessage, c: &GateContext) -> GateVerdict {
        self.seen.lock().await.push((m.clone(), c.clone()));
        if self.hold_egress {
            GateVerdict::Hold {
                hold_id: "msg_held0001".into(),
            }
        } else {
            GateVerdict::Pass
        }
    }
    async fn ingress(&self, _: &XMessage, _: &GateContext) -> GateVerdict {
        if self.fail_ingress.load(Ordering::Relaxed) {
            GateVerdict::Refuse {
                code: "unavailable".into(),
                categories: vec![],
                retry_after: Some(5),
            }
        } else {
            GateVerdict::Pass
        }
    }
}
#[tokio::test]
async fn unavailable_refunds_all_sender_windows() {
    let gate = Arc::new(ControlledGate {
        fail_ingress: std::sync::atomic::AtomicBool::new(true),
        hold_egress: false,
        seen: Mutex::new(vec![]),
    });
    let r = linked(Some(gate.clone())).await;
    for _ in 0..55 {
        assert_eq!(
            r.send(false, json!({"thread":"same"})).await["error"]["data"]["code"],
            "unavailable"
        );
    }
    gate.fail_ingress.store(false, Ordering::Relaxed);
    assert!(r.send(false, json!({"thread":"same"})).await["error"].is_null());
}
#[tokio::test]
async fn released_egress_hold_keeps_id_client_id_and_reply_grant() {
    let gate = Arc::new(ControlledGate {
        fail_ingress: std::sync::atomic::AtomicBool::new(false),
        hold_egress: true,
        seen: Mutex::new(vec![]),
    });
    let mut r = linked(Some(gate.clone())).await;
    r.rules(false, json!({"in":[],"out":["acct:beta"]})).await;
    let held = r
        .send(false, json!({"kind":"request","client_id":"held"}))
        .await;
    assert_eq!(held["result"]["id"], "msg_held0001");
    let (message, ctx) = gate.seen.lock().await[0].clone();
    let account = r.hub.store.account("acme").await.unwrap().unwrap();
    let release = xacct::XRelease::Egress {
        hold_id: "msg_held0001".into(),
        sender: ctx.sender.unwrap(),
        peer: "beta".into(),
        message,
    };
    let sent = r.hub.xrelease(&account, release.clone()).await.unwrap();
    assert_eq!(sent["id"], "msg_held0001");
    assert_eq!(
        r.hub.xrelease(&account, release).await.unwrap()["duplicate"],
        true
    );
    let got = deliveries(&mut r.brx);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["message"]["id"], "msg_held0001");
    let reply = r
        .send(true, json!({"reply_to":"msg_held0001","kind":"reply"}))
        .await;
    assert!(!reply["result"]["held"].is_null());
    let (message, ctx) = gate.seen.lock().await.last().unwrap().clone();
    let peer = r.hub.store.account("beta").await.unwrap().unwrap();
    let sent = r
        .hub
        .xrelease(
            &peer,
            xacct::XRelease::Egress {
                hold_id: "msg_held0002".into(),
                sender: ctx.sender.unwrap(),
                peer: "acme".into(),
                message,
            },
        )
        .await
        .unwrap();
    assert_eq!(sent["thread"], held["result"]["thread"]);
    assert_eq!(sent["hop"], 1);
    assert_eq!(
        deliveries(&mut r.arx)[0]["message"]["reply_to"],
        "msg_held0001"
    );
}
#[tokio::test]
async fn workers_and_unknown_depth_follow_allowlists() {
    let r = linked(None).await;
    for (depth, allow_worker, expected) in [
        (Some(1), false, true),
        (Some(2), false, false),
        (Some(2), true, true),
        (None, true, false),
    ] {
        let hub = r.b.lock().await;
        let mut e = hub
            .endpoints()
            .await
            .unwrap()
            .into_iter()
            .find(|e| e.handle == "root")
            .unwrap();
        let mut f = fields(&e);
        f["depth"] = json!(depth);
        e.fields = f.to_string();
        hub.store.put_endpoint(&hub.account_id, e).await.unwrap();
        drop(hub);
        r.config(
            true,
            ContactConfig {
                allow: vec![XAllow {
                    machine: "desk".into(),
                    sel: "ep:desk/root".into(),
                    allow_worker: Some(allow_worker),
                }],
                ..ContactConfig::default()
            },
        )
        .await;
        let sent = r.send(false, json!({})).await;
        assert_eq!(sent["error"].is_null(), expected, "{sent}");
    }
}

#[tokio::test]
async fn human_terminal_identity_and_credential_scan() {
    let mut r = linked(None).await;
    let mirrored=r.hub.call(&r.a,&r.ai,request(10,"mirror",json!({"endpoints":[{"address":"me/","kind":"human","presence":"online","harness":"human"}]})),false).await;
    assert!(mirrored["error"].is_null(), "{mirrored}");
    for (tty, address, human) in [(true, "acme/me", true), (false, "acme/laptop/me", false)] {
        let result=r.hub.call(&r.a,&r.ai,request(10,"forward",json!({"from":"","tty":tty,"params":{"to":"beta/desk/root","body":"from human"}})),false).await;
        assert!(result["error"].is_null(), "{result}");
        let got = deliveries(&mut r.brx);
        assert_eq!(got[0]["message"]["from"]["address"], address);
        assert_eq!(got[0]["message"]["from"]["human"] == true, human);
    }
    let result = r
        .send(false, json!({"body":format!("Bearer {}","a".repeat(32))}))
        .await;
    assert_eq!(result["error"]["data"]["code"], "secret_refused");
    assert!(deliveries(&mut r.brx).is_empty());
}
#[tokio::test]
async fn incoming_bytes_count_against_both_paths() {
    let r = linked(None).await;
    r.b.lock().await.limits.apply("storedBytes=4096").unwrap();
    assert!(r.send(false, json!({"body":"a".repeat(1800)})).await["error"].is_null());
    assert_eq!(
        r.send(false, json!({"body":"b".repeat(1800)})).await["error"]["data"]["code"],
        "inbox_full"
    );
    let local = r
        .hub
        .call(
            &r.b,
            &r.bi,
            request(
                10,
                "forward",
                json!({"from":"root","params":{"to":"desk/other","body":"c".repeat(2000)}}),
            ),
            false,
        )
        .await;
    assert_eq!(local["error"]["data"]["code"], "too_large");
}
#[tokio::test]
async fn forged_expired_and_redirected_reply_grants_fail_closed() {
    let gate = Arc::new(ControlledGate {
        fail_ingress: std::sync::atomic::AtomicBool::new(false),
        hold_egress: false,
        seen: Mutex::new(vec![]),
    });
    let r = linked(Some(gate.clone())).await;
    r.rules(false, json!({"in":[],"out":["acct:beta"]})).await;
    let sent = r.send(false, json!({})).await;
    assert!(sent["error"].is_null());
    let parent = gate.seen.lock().await[0].0.clone();
    {
        let local = r.a.lock().await;
        let mut other = local
            .endpoints()
            .await
            .unwrap()
            .into_iter()
            .find(|e| e.handle == "other")
            .unwrap();
        let mut f = fields(&other);
        f["rules"] = json!({"in":[],"out":["acct:beta"]});
        other.fields = f.to_string();
        local
            .store
            .put_endpoint(&local.account_id, other)
            .await
            .unwrap();
    }
    let from = xacct::XFrom {
        account: "beta".into(),
        address: "beta/desk/root".into(),
        human: false,
        auth: "contact".into(),
        rel: "contact:beta".into(),
        machine: Some("desk".into()),
        harness: Some("cli".into()),
    };
    let base = XMessage {
        from,
        to: "laptop/root".into(),
        id: "msg_reply001".into(),
        client_id: "reply-1".into(),
        reply_to: Some(parent.id.clone()),
        reply_grant: parent.grant.clone(),
        reply_grant_expires_at: Some(parent.expires_at),
        hop: 1,
        ..parent
    };
    let a = r.hub.store.account("acme").await.unwrap().unwrap();
    for n in 0..4 {
        let mut message = base.clone();
        message.client_id = format!("bad-{n}");
        match n {
            0 => message.reply_grant = Some("0".repeat(64)),
            1 => message.reply_to = Some("msg_wrong001".into()),
            2 => message.reply_grant_expires_at = Some(crate::now_ms() - 1),
            _ => message.to = "laptop/other".into(),
        }
        assert_eq!(
            r.hub
                .xrelease(
                    &a,
                    xacct::XRelease::Ingress {
                        from_account: r.gb.user_id.clone(),
                        message
                    }
                )
                .await
                .unwrap_err()["data"]["code"],
            "not_found"
        );
    }
    assert!(
        r.hub
            .xrelease(
                &a,
                xacct::XRelease::Ingress {
                    from_account: r.gb.user_id.clone(),
                    message: base
                }
            )
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn cross_account_hop_and_thread_guards_are_opt_in() {
    let r = linked(None).await;
    let mut parent = Value::Null;
    let mut thread = Value::Null;
    for hop in 0..110 {
        let mut params = json!({});
        if !parent.is_null() {
            params["reply_to"] = parent.clone();
        }
        let sent = r.send(hop % 2 == 1, params).await;
        assert!(sent["error"].is_null(), "{sent}");
        assert_eq!(sent["result"]["hop"], hop);
        if thread.is_null() {
            thread = sent["result"]["thread"].clone();
        }
        assert_eq!(sent["result"]["thread"], thread);
        parent = sent["result"]["id"].clone();
    }
    let reply = json!({"reply_to":parent});
    r.a.lock()
        .await
        .limits
        .apply_json(r#"{"hopMax":64}"#)
        .unwrap();
    let refused = r.send(false, reply.clone()).await;
    assert_eq!(refused["error"]["data"]["code"], "loop_guard");
    assert_eq!(
        refused["error"]["message"],
        "message exceeds the hop limit of 64 across accounts"
    );
    r.a.lock()
        .await
        .limits
        .apply_json(r#"{"hopMax":null}"#)
        .unwrap();
    r.b.lock()
        .await
        .limits
        .apply_json(r#"{"hopMax":64}"#)
        .unwrap();
    let refused = r.send(false, reply.clone()).await;
    assert_eq!(refused["error"]["data"]["code"], "loop_guard");
    assert_eq!(
        refused["error"]["message"],
        "hop is past the limit across accounts (64)"
    );
    r.b.lock()
        .await
        .limits
        .apply_json(r#"{"hopMax":0,"threadMax":55}"#)
        .unwrap();
    let refused = r.send(false, reply.clone()).await;
    assert_eq!(refused["error"]["data"]["code"], "loop_guard");
    assert_eq!(
        refused["error"]["message"],
        format!(
            "thread {} reached 55 messages across accounts",
            thread.as_str().unwrap()
        )
    );
    r.b.lock()
        .await
        .limits
        .apply_json(r#"{"threadMax":null}"#)
        .unwrap();
    r.a.lock()
        .await
        .limits
        .apply_json(r#"{"threadMax":55}"#)
        .unwrap();
    let refused = r.send(false, reply.clone()).await;
    assert_eq!(refused["error"]["data"]["code"], "loop_guard");
    assert_eq!(
        refused["error"]["message"],
        format!(
            "thread {} reached 55 messages across accounts",
            thread.as_str().unwrap()
        )
    );
    r.a.lock()
        .await
        .limits
        .apply_json(r#"{"threadMax":0}"#)
        .unwrap();
    let sent = r.send(false, reply).await;
    assert_eq!(sent["result"]["hop"], 110, "{sent}");
    let high = r.hub.call(&r.a, &r.ai, request(9, "forward", json!({"from":"root","hop_floor":1000,"params":{"to":"beta/desk/root","body":"high"}})), false).await;
    assert_eq!(high["result"]["hop"], 1000, "{high}");
    r.a.lock()
        .await
        .limits
        .apply_json(r#"{"hopMax":8}"#)
        .unwrap();
    let refused = r
        .hub
        .call(
            &r.a,
            &r.ai,
            request(
                9,
                "forward",
                json!({"from":"root","hop_floor":9,"params":{"to":"beta/desk/root","body":"high"}}),
            ),
            false,
        )
        .await;
    assert_eq!(refused["error"]["data"]["code"], "loop_guard");
}
