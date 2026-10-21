//! Backend conformance suite. Each invocation requires a fresh, empty store.
use crate::*;
use std::collections::BTreeMap;

/// Exercise every store method, cross-account isolation, rollback, ordering,
/// expiry boundaries and concurrent single-use redemption on an empty store.
pub async fn run_suite(s: Arc<dyn RelayStore>) {
    let a = s
        .create_account(Account {
            id: "a".into(),
            handle: "alpha".into(),
            created_at: 10,
        })
        .await
        .unwrap();
    let b = s
        .create_account(Account {
            id: "b".into(),
            handle: "beta".into(),
            created_at: 10,
        })
        .await
        .unwrap();
    assert_eq!(
        s.create_account(Account {
            id: "unused".into(),
            handle: "alpha".into(),
            created_at: 99
        })
        .await
        .unwrap(),
        a
    );
    assert_eq!(s.account("alpha").await.unwrap(), Some(a.clone()));
    assert!(s.account("absent").await.unwrap().is_none());
    contacts_suite(s.clone()).await;
    xinbox_suite(s.clone()).await;
    for account in [&a, &b] {
        let m = Member {
            id: format!("{}m", account.id),
            account_id: account.id.clone(),
            name: "operator".into(),
            email: Some("operator@example.test".into()),
            role: Role::Owner,
            created_at: 20,
        };
        s.create_member(m.clone()).await.unwrap();
        assert!(matches!(
            s.create_member(m.clone()).await,
            Err(StoreError::Conflict)
        ));
        assert_eq!(
            s.member(&account.id, "operator").await.unwrap(),
            Some(m.clone())
        );
        assert_eq!(s.members(&account.id).await.unwrap(), vec![m]);
    }
    assert!(s.member("absent", "operator").await.unwrap().is_none());
    let first = Member {
        id: "first".into(),
        account_id: "a".into(),
        name: "operator".into(),
        email: None,
        role: Role::Member,
        created_at: 99,
    };
    assert_eq!(s.ensure_member(first, true).await.unwrap().id, "am");
    let second = Member {
        id: "second".into(),
        account_id: "a".into(),
        name: "second".into(),
        email: None,
        role: Role::Admin,
        created_at: 99,
    };
    assert_eq!(
        s.ensure_member(second, true).await.unwrap().role,
        Role::Member
    );
    let third = Member {
        id: "third".into(),
        account_id: "a".into(),
        name: "third".into(),
        email: None,
        role: Role::Admin,
        created_at: 100,
    };
    assert_eq!(
        s.ensure_member(third, false).await.unwrap().role,
        Role::Admin
    );
    s.create_account(Account {
        id: "c".into(),
        handle: "gamma".into(),
        created_at: 10,
    })
    .await
    .unwrap();
    let mut member_tasks = tokio::task::JoinSet::new();
    for n in 0..8 {
        let s = s.clone();
        member_tasks.spawn(async move {
            s.ensure_member(
                Member {
                    id: format!("cm{n}"),
                    account_id: "c".into(),
                    name: format!("member{n}"),
                    email: None,
                    role: Role::Member,
                    created_at: 20,
                },
                true,
            )
            .await
        });
    }
    let mut owners = 0;
    while let Some(m) = member_tasks.join_next().await {
        if m.unwrap().unwrap().role == Role::Owner {
            owners += 1;
        }
    }
    assert_eq!(owners, 1);

    let c = credential("credential", "a", "am");
    s.create_credential(c.clone()).await.unwrap();
    assert!(matches!(
        s.create_credential(c.clone()).await,
        Err(StoreError::Conflict)
    ));
    let identity = match s.credential_by_hash(&c.secret_hash, 30).await.unwrap() {
        CredentialLookup::Active(i) => i,
        _ => panic!("active credential missing"),
    };
    assert_eq!(identity.account, a);
    assert_eq!(identity.member.id, "am");
    assert_eq!(
        s.credential_by_id(&c.id, 30).await.unwrap(),
        CredentialLookup::Active(identity)
    );
    assert_eq!(
        s.credential_by_hash("absent", 30).await.unwrap(),
        CredentialLookup::Invalid
    );
    assert_eq!(
        s.credential_by_id("absent", 30).await.unwrap(),
        CredentialLookup::Invalid
    );
    s.touch_credential(&c.id, 50).await.unwrap();
    s.touch_credential(&c.id, 40).await.unwrap();
    match s.credential_by_id(&c.id, 30).await.unwrap() {
        CredentialLookup::Active(i) => assert_eq!(i.credential.last_used_at, Some(50)),
        _ => panic!("credential missing"),
    }
    assert!(matches!(
        s.touch_credential("absent", 40).await,
        Err(StoreError::NotFound)
    ));
    let mut expired = credential("expired", "a", "am");
    expired.expires_at = Some(60);
    s.create_credential(expired.clone()).await.unwrap();
    assert!(matches!(
        s.credential_by_hash(&expired.secret_hash, 59)
            .await
            .unwrap(),
        CredentialLookup::Active(_)
    ));
    assert_eq!(
        s.credential_by_hash(&expired.secret_hash, 60)
            .await
            .unwrap(),
        CredentialLookup::Expired
    );
    assert!(s.revoke_credential(&expired.id, 61).await.unwrap());
    assert_eq!(
        s.credential_by_id(&expired.id, 62).await.unwrap(),
        CredentialLookup::Revoked
    );
    assert!(s.revoke_credential(&c.id, 60).await.unwrap());
    assert!(!s.revoke_credential(&c.id, 70).await.unwrap());
    assert!(!s.revoke_credential("absent", 70).await.unwrap());
    assert_eq!(
        s.credential_by_hash(&c.secret_hash, 70).await.unwrap(),
        CredentialLookup::Revoked
    );
    let mut wrong = credential("wrong", "a", "bm");
    assert!(matches!(
        s.create_credential(wrong.clone()).await,
        Err(StoreError::Conflict)
    ));
    wrong.member_id = "am".into();
    s.create_credential(wrong).await.unwrap();

    let code = device("code");
    s.create_device_code(code.clone()).await.unwrap();
    assert!(matches!(
        s.create_device_code(code.clone()).await,
        Err(StoreError::Conflict)
    ));
    assert_eq!(
        s.device_code(&code.user_code).await.unwrap(),
        Some(code.clone())
    );
    assert!(s.device_code("absent").await.unwrap().is_none());
    assert_eq!(
        s.poll_device("absent", 100, 5000).await.unwrap(),
        DevicePoll::Invalid
    );
    assert_eq!(
        s.poll_device(&code.device_code_hash, 100, 5000)
            .await
            .unwrap(),
        DevicePoll::Pending
    );
    assert_eq!(
        s.poll_device(&code.device_code_hash, 101, 5000)
            .await
            .unwrap(),
        DevicePoll::SlowDown
    );
    assert_eq!(
        s.poll_device(&code.device_code_hash, 5101, 5000)
            .await
            .unwrap(),
        DevicePoll::Pending
    );
    assert!(matches!(
        s.approve_device("absent", "a", "am", 100).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        s.approve_device(&code.user_code, "a", "bm", 100).await,
        Err(StoreError::Conflict)
    ));
    s.approve_device(&code.user_code, "a", "am", 5200)
        .await
        .unwrap();
    assert!(matches!(
        s.approve_device(&code.user_code, "a", "am", 5300).await,
        Err(StoreError::Conflict)
    ));
    assert!(matches!(
        s.deny_device(&code.user_code, 5300).await,
        Err(StoreError::Conflict)
    ));
    assert!(matches!(
        s.poll_device(&code.device_code_hash, 10101, 5000)
            .await
            .unwrap(),
        DevicePoll::Approved(_)
    ));
    let mut bad = credential("bad-device", "a", "am");
    bad.kind = CredentialKind::Device;
    bad.name = code.label.clone();
    bad.secret_hash = c.secret_hash.clone();
    assert!(matches!(
        s.redeem_device(&code.device_code_hash, bad, 11000).await,
        Err(StoreError::Conflict)
    ));
    assert_eq!(
        s.device_code(&code.user_code).await.unwrap().unwrap().state,
        DeviceState::Approved
    );
    let mut tasks = tokio::task::JoinSet::new();
    for n in 0..12 {
        let s = s.clone();
        let code = code.clone();
        tasks.spawn(async move {
            let mut c = credential(&format!("redeem-{n}"), "a", "am");
            c.kind = CredentialKind::Device;
            c.name = code.label;
            s.redeem_device(&code.device_code_hash, c, 12000).await
        });
    }
    let mut winners = 0;
    while let Some(result) = tasks.join_next().await {
        match result.unwrap() {
            Ok(()) => winners += 1,
            Err(StoreError::Conflict) => {}
            Err(e) => panic!("redemption error: {e}"),
        }
    }
    assert_eq!(winners, 1);
    assert_eq!(
        s.poll_device(&code.device_code_hash, 13000, 5000)
            .await
            .unwrap(),
        DevicePoll::Invalid
    );
    let denied = device("denied");
    s.create_device_code(denied.clone()).await.unwrap();
    s.deny_device(&denied.user_code, 100).await.unwrap();
    assert_eq!(
        s.poll_device(&denied.device_code_hash, 101, 5000)
            .await
            .unwrap(),
        DevicePoll::Denied
    );
    let expired = device("expired-code");
    s.create_device_code(expired.clone()).await.unwrap();
    assert_eq!(
        s.poll_device(&expired.device_code_hash, expired.expires_at, 5000)
            .await
            .unwrap(),
        DevicePoll::Expired
    );
    assert!(matches!(
        s.deny_device(&expired.user_code, expired.expires_at).await,
        Err(StoreError::Conflict)
    ));

    s.purge_device_codes(900000).await.unwrap();
    let pending = device("cleanup-pending");
    let approved = device("cleanup-approved");
    let denied = device("cleanup-denied");
    let redeemed = device("cleanup-redeemed");
    let mut expired = device("cleanup-expired");
    expired.expires_at = 1;
    for code in [&pending, &approved, &denied, &redeemed, &expired] {
        s.create_device_code(code.clone()).await.unwrap();
    }
    s.approve_device(&approved.user_code, "a", "am", 0)
        .await
        .unwrap();
    s.deny_device(&denied.user_code, 0).await.unwrap();
    s.approve_device(&redeemed.user_code, "a", "am", 0)
        .await
        .unwrap();
    let mut login = credential("cleanup-login", "a", "am");
    login.kind = CredentialKind::Device;
    login.name = redeemed.label.clone();
    s.redeem_device(&redeemed.device_code_hash, login, 0)
        .await
        .unwrap();
    assert_eq!(s.purge_device_codes(1).await.unwrap(), 3);
    for code in [&expired, &denied, &redeemed] {
        assert!(s.device_code(&code.user_code).await.unwrap().is_none());
    }
    for code in [&pending, &approved] {
        assert!(s.device_code(&code.user_code).await.unwrap().is_some());
    }
    for n in 0..998 {
        s.create_device_code(device(&format!("capacity-{n}")))
            .await
            .unwrap();
    }
    let mut tasks = tokio::task::JoinSet::new();
    for n in 0..12 {
        let s = s.clone();
        tasks.spawn(async move {
            s.create_device_code(device(&format!("capacity-race-{n}")))
                .await
        });
    }
    let mut winners = 0;
    while let Some(result) = tasks.join_next().await {
        match result.unwrap() {
            Ok(()) => winners += 1,
            Err(StoreError::Capacity) => {}
            Err(e) => panic!("device code error: {e}"),
        }
    }
    assert_eq!(winners, 1);
    assert_eq!(s.purge_device_codes(900000).await.unwrap(), 1001);
    assert_eq!(s.purge_device_codes(900000).await.unwrap(), 0);
    s.create_device_code(device("after-capacity"))
        .await
        .unwrap();

    let machine = Machine {
        name: "laptop".into(),
        token_id: c.id.clone(),
        actor_id: "am".into(),
        user_id: "a".into(),
        kind: "bridge".into(),
        created_at: 100,
        last_seen: Some(110),
    };
    for account in ["a", "b"] {
        s.put_machine(account, machine.clone()).await.unwrap();
    }
    assert_eq!(s.machines("a").await.unwrap(), vec![machine.clone()]);
    let tomb = Tombstone {
        name: machine.name.clone(),
        actor_id: Some("am".into()),
        user_id: Some("a".into()),
        at: 120,
    };
    s.remove_machine("a", &machine.name, Some(tomb.clone()))
        .await
        .unwrap();
    assert!(s.machines("a").await.unwrap().is_empty());
    assert_eq!(s.machines("b").await.unwrap().len(), 1);
    assert_eq!(s.tombstones("a").await.unwrap(), vec![tomb.clone()]);
    assert!(s.tombstones("b").await.unwrap().is_empty());
    s.put_state("a", "idle_since", Some("123")).await.unwrap();
    s.put_machine("a", machine.clone()).await.unwrap();
    assert!(s.tombstones("a").await.unwrap().is_empty());
    assert!(s.state("a", "idle_since").await.unwrap().is_none());
    s.remove_machine("a", &machine.name, Some(tomb))
        .await
        .unwrap();
    assert!(s.remove_tombstone("a", &machine.name).await.unwrap());
    assert!(!s.remove_tombstone("a", &machine.name).await.unwrap());
    assert!(matches!(
        s.remove_machine("a", "absent", None).await,
        Err(StoreError::NotFound)
    ));
    let mut ep = Endpoint {
        id: "endpoint".into(),
        machine: "laptop".into(),
        handle: "agent".into(),
        kind: "agent".into(),
        token_hash: Some("endpoint-hash".into()),
        last_seen: Some(100),
        created_at: 90,
        fields: "{\"labels\":{}}".into(),
    };
    for account in ["a", "b"] {
        s.put_endpoint(account, ep.clone()).await.unwrap();
    }
    ep.last_seen = Some(200);
    s.put_endpoint("a", ep.clone()).await.unwrap();
    assert_eq!(
        s.endpoints("a", Some("laptop")).await.unwrap(),
        vec![ep.clone()]
    );
    assert_eq!(s.endpoints("a", None).await.unwrap(), vec![ep.clone()]);
    assert!(s.endpoints("a", Some("other")).await.unwrap().is_empty());
    assert_eq!(
        s.endpoints("b", None)
            .await
            .unwrap()
            .first()
            .unwrap()
            .last_seen,
        Some(100)
    );
    assert!(s.remove_endpoint("a", &ep.id).await.unwrap());
    assert!(!s.remove_endpoint("a", &ep.id).await.unwrap());
    assert_eq!(s.endpoints("b", None).await.unwrap().len(), 1);

    let msg = message("message");
    let idem = Idempotency {
        from_ep: "sender".into(),
        client_id: "retry".into(),
        payload_hash: "digest".into(),
        result: "{\"ok\":true}".into(),
        created_at: 100,
    };
    let ds = vec![
        NewDelivery {
            endpoint: "recipient".into(),
            expires_at: 1000,
            state: "{}".into(),
        },
        NewDelivery {
            endpoint: "recipient".into(),
            expires_at: 1000,
            state: "{}".into(),
        },
    ];
    let stored = s
        .store_message("a", msg.clone(), ds.clone(), Some(idem.clone()))
        .await
        .unwrap();
    assert_eq!(stored.len(), 2);
    assert!(stored[0].seq < stored[1].seq);
    assert_eq!(s.message("a", &msg.id).await.unwrap(), Some(msg.clone()));
    assert!(s.message("b", &msg.id).await.unwrap().is_none());
    assert!(s.deliveries("b", "recipient", 0).await.unwrap().is_empty());
    assert_eq!(
        s.deliveries("a", "recipient", stored[0].seq).await.unwrap(),
        vec![stored[1].clone()]
    );
    assert_eq!(
        s.idempotency("a", "sender", "retry").await.unwrap(),
        Some(idem.clone())
    );
    assert!(
        s.idempotency("b", "sender", "retry")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        s.open_deliveries("a", "recipient", 0, 999, 1)
            .await
            .unwrap(),
        vec![stored[0].clone()]
    );
    assert_eq!(
        s.open_deliveries("a", "recipient", stored[0].seq, 999, 200)
            .await
            .unwrap(),
        vec![stored[1].clone()]
    );
    assert!(
        s.open_deliveries("b", "recipient", 0, 999, 200)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        s.open_delivery_count("a", "recipient", 999).await.unwrap(),
        2
    );
    assert_eq!(
        s.open_delivery_count("b", "recipient", 999).await.unwrap(),
        0
    );
    assert_eq!(s.open_delivery_count("a", "absent", 999).await.unwrap(), 0);
    assert_eq!(
        s.open_delivery_count("a", "recipient", 1000).await.unwrap(),
        0
    );
    assert!(
        s.open_deliveries("a", "recipient", 0, 1000, 200)
            .await
            .unwrap()
            .is_empty()
    );
    for rejected in [false, true] {
        let mut d = stored[0].clone();
        if rejected {
            d.rejected_at = Some(300);
        } else {
            d.acked_at = Some(300);
        }
        s.update_delivery("a", d).await.unwrap();
        assert_eq!(
            s.open_delivery_count("a", "recipient", 999).await.unwrap(),
            1
        );
        assert_eq!(
            s.open_deliveries("a", "recipient", 0, 999, 200)
                .await
                .unwrap(),
            vec![stored[1].clone()]
        );
    }
    s.update_delivery("a", stored[0].clone()).await.unwrap();
    let mut delivery = stored[0].clone();
    delivery.acked_at = Some(300);
    delivery.rejected_at = Some(301);
    delivery.rejection = Some("rejected".into());
    delivery.state = "{\"offered_until\":10}".into();
    s.update_delivery("a", delivery.clone()).await.unwrap();
    assert_eq!(
        s.deliveries("a", "recipient", 0).await.unwrap().first(),
        Some(&delivery)
    );
    assert!(matches!(
        s.update_delivery("b", delivery).await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        s.store_message("a", message("rollback"), ds.clone(), Some(idem))
            .await,
        Err(StoreError::Conflict)
    ));
    assert!(s.message("a", "rollback").await.unwrap().is_none());
    assert_eq!(s.deliveries("a", "recipient", 0).await.unwrap().len(), 2);
    let invalid = vec![
        ds[0].clone(),
        NewDelivery {
            state: "invalid-json".into(),
            ..ds[0].clone()
        },
    ];
    assert!(matches!(
        s.store_message("a", message("rollback-json"), invalid, None)
            .await,
        Err(StoreError::Conflict)
    ));
    assert!(s.message("a", "rollback-json").await.unwrap().is_none());
    assert_eq!(s.deliveries("a", "recipient", 0).await.unwrap().len(), 2);
    s.store_message("b", msg, ds, None).await.unwrap();
    assert_eq!(s.purge_messages("a", 1000, 101).await.unwrap(), 1);
    assert!(s.deliveries("a", "recipient", 0).await.unwrap().is_empty());
    assert!(
        s.idempotency("a", "sender", "retry")
            .await
            .unwrap()
            .is_none()
    );
    assert!(s.message("b", "message").await.unwrap().is_some());
    s.put_state("a", "key", Some("{\"n\":1}")).await.unwrap();
    s.put_state("b", "key", Some("2")).await.unwrap();
    assert_eq!(s.state("a", "key").await.unwrap(), Some("{\"n\":1}".into()));
    s.put_state("a", "key", Some("3")).await.unwrap();
    assert_eq!(s.state("a", "key").await.unwrap(), Some("3".into()));
    s.put_state("a", "key", None).await.unwrap();
    assert!(s.state("a", "key").await.unwrap().is_none());
    assert_eq!(s.state("b", "key").await.unwrap(), Some("2".into()));
    for local in [false, true] {
        let event = PairEvent {
            from_ep: "from".into(),
            to_ep: "to".into(),
            at: 100,
        };
        s.append_pair("a", event.clone(), local).await.unwrap();
        s.append_pair("b", event.clone(), local).await.unwrap();
        assert_eq!(
            s.pairs("a", Some("from"), Some("to"), 100, local)
                .await
                .unwrap(),
            vec![event.clone()]
        );
        assert_eq!(
            s.pairs("a", None, None, 100, local).await.unwrap(),
            vec![event]
        );
        assert!(
            s.pairs("a", Some("other"), None, 100, local)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            s.pairs("a", None, None, 101, local)
                .await
                .unwrap()
                .is_empty()
        );
    }
    for log in [EventLog::Activity, EventLog::Audit] {
        let mut event = Event {
            id: 999,
            at: 100,
            kind: "send".into(),
            endpoint: Some("endpoint".into()),
            reference: Some("message".into()),
            detail: "{}".into(),
        };
        let id = s.append_event("a", log, event.clone()).await.unwrap();
        event.id = id;
        assert_eq!(s.events("a", log, 0).await.unwrap(), vec![event.clone()]);
        assert!(s.events("a", log, id).await.unwrap().is_empty());
        assert!(s.events("b", log, 0).await.unwrap().is_empty());
        s.append_event("b", log, event).await.unwrap();
    }
    s.purge_events("a", 101).await.unwrap();
    for log in [EventLog::Activity, EventLog::Audit] {
        assert!(s.events("a", log, 0).await.unwrap().is_empty());
        assert_eq!(s.events("b", log, 0).await.unwrap().len(), 1);
    }
    for local in [false, true] {
        assert!(s.pairs("a", None, None, 0, local).await.unwrap().is_empty());
        assert_eq!(s.pairs("b", None, None, 0, local).await.unwrap().len(), 1);
    }
    reply_suite(s.clone()).await;
    hub_suite(s.clone()).await;
}
async fn reply_suite(s: Arc<dyn RelayStore>) {
    let mut request = message("asked");
    request.kind = "request".into();
    let addressed = s
        .store_message(
            "a",
            request.clone(),
            vec![NewDelivery {
                endpoint: "responder".into(),
                expires_at: 1000,
                state: "{}".into(),
            }],
            None,
        )
        .await
        .unwrap();
    let mut reply = message("answer");
    reply.kind = "reply".into();
    reply.from_ep = "other".into();
    reply.reply_to = Some(request.id.clone());
    let delivery = NewDelivery {
        endpoint: "sender".into(),
        expires_at: 1000,
        state: "{}".into(),
    };
    s.store_message("a", reply.clone(), vec![delivery.clone()], None)
        .await
        .unwrap();
    assert!(
        s.reply_delivery("a", "sender", &request.id, 999)
            .await
            .unwrap()
            .is_none()
    );
    reply.id = "valid-answer".into();
    reply.from_ep = addressed[0].endpoint.clone();
    let mut d = s
        .store_message("a", reply, vec![delivery.clone()], None)
        .await
        .unwrap()[0]
        .clone();
    assert_eq!(
        s.reply_delivery("a", "sender", &request.id, 999)
            .await
            .unwrap(),
        Some(d.clone())
    );
    assert!(
        s.reply_delivery("b", "sender", &request.id, 999)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        s.reply_delivery("a", "other", &request.id, 999)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        s.reply_delivery("a", "sender", &request.id, 1000)
            .await
            .unwrap()
            .is_none()
    );
    d.acked_at = Some(500);
    s.update_delivery("a", d.clone()).await.unwrap();
    assert_eq!(
        s.reply_delivery("a", "sender", &request.id, 999)
            .await
            .unwrap(),
        Some(d)
    );
    let request = message("forwarded-ask");
    s.store_message("a", request.clone(), vec![], None)
        .await
        .unwrap();
    let mut reply = message("forwarded-answer");
    reply.kind = "reply".into();
    reply.reply_to = Some(request.id.clone());
    let d = s
        .store_message("a", reply, vec![delivery], None)
        .await
        .unwrap()[0]
        .clone();
    assert_eq!(
        s.reply_delivery("a", "sender", &request.id, 999)
            .await
            .unwrap(),
        Some(d)
    );
}
async fn hub_suite(s: Arc<dyn RelayStore>) {
    s.create_account(Account {
        id: "hub".into(),
        handle: "hub".into(),
        created_at: 0,
    })
    .await
    .unwrap();
    let endpoint = Endpoint {
        id: "hub-ep".into(),
        machine: "host".into(),
        handle: "agent".into(),
        kind: "agent".into(),
        token_hash: None,
        last_seen: Some(1),
        created_at: 1,
        fields: "{}".into(),
    };
    let machine = Machine {
        name: "host".into(),
        token_id: "credential".into(),
        actor_id: "member".into(),
        user_id: "hub".into(),
        kind: "client".into(),
        created_at: 1,
        last_seen: Some(1),
    };
    let pair = PairEvent {
        from_ep: endpoint.id.clone(),
        to_ep: endpoint.id.clone(),
        at: 2,
    };
    let change = HubWrite {
        endpoints: vec![endpoint.clone()],
        machines: vec![machine.clone()],
        pairs: vec![(pair.clone(), false), (pair.clone(), true)],
        states: vec![("state".into(), Some("true".into()))],
        events: vec![(
            EventLog::Audit,
            Event {
                id: 99,
                at: 2,
                kind: "test".into(),
                endpoint: Some(endpoint.id.clone()),
                reference: None,
                detail: "{}".into(),
            },
        )],
        ..HubWrite::default()
    };
    s.hub_write("hub", change.clone()).await.unwrap();
    assert_eq!(
        s.endpoints("hub", None).await.unwrap(),
        vec![endpoint.clone()]
    );
    assert_eq!(s.machines("hub").await.unwrap(), vec![machine.clone()]);
    assert_eq!(
        s.state("hub", "state").await.unwrap().as_deref(),
        Some("true")
    );
    for local in [false, true] {
        assert_eq!(
            s.pairs("hub", None, None, 0, local).await.unwrap(),
            vec![pair.clone()]
        );
    }
    assert_eq!(s.events("hub", EventLog::Audit, 0).await.unwrap().len(), 1);
    let mut invalid = change.clone();
    invalid.endpoints[0].fields = "invalid".into();
    invalid.states = vec![("state".into(), Some("false".into()))];
    assert!(matches!(
        s.hub_write("hub", invalid).await,
        Err(StoreError::Conflict)
    ));
    assert_eq!(
        s.state("hub", "state").await.unwrap().as_deref(),
        Some("true")
    );
    assert_eq!(s.events("hub", EventLog::Audit, 0).await.unwrap().len(), 1);
    assert!(
        s.endpoints("b", None)
            .await
            .unwrap()
            .iter()
            .all(|e| e.id != endpoint.id)
    );
    let message = Message {
        id: "hub-msg".into(),
        thread: "thread".into(),
        reply_to: None,
        kind: "request".into(),
        from_ep: endpoint.id.clone(),
        to_addr: "host/agent".into(),
        created_at: 3,
        expires_at: 100,
        envelope: "{}".into(),
    };
    let delivery = NewDelivery {
        endpoint: endpoint.id.clone(),
        expires_at: 100,
        state: "{}".into(),
    };
    let idempotency = Idempotency {
        from_ep: endpoint.id.clone(),
        client_id: "send".into(),
        payload_hash: "digest".into(),
        result: r#"{"deliveries":[{}]}"#.into(),
        created_at: 3,
    };
    let mut invalid = HubWrite::default();
    invalid
        .states
        .push(("invalid".into(), Some("invalid".into())));
    assert!(
        s.route_message(
            "hub",
            message.clone(),
            vec![delivery.clone()],
            Some(idempotency.clone()),
            invalid
        )
        .await
        .is_err()
    );
    assert!(s.message("hub", &message.id).await.unwrap().is_none());
    assert!(
        s.deliveries("hub", &endpoint.id, 0)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        s.idempotency("hub", &endpoint.id, "send")
            .await
            .unwrap()
            .is_none()
    );
    let mut ds = s
        .route_message(
            "hub",
            message.clone(),
            vec![delivery],
            Some(idempotency),
            HubWrite {
                states: vec![("sent".into(), Some("true".into()))],
                ..HubWrite::default()
            },
        )
        .await
        .unwrap();
    let result: serde_json::Value = serde_json::from_str(
        &s.idempotency("hub", &endpoint.id, "send")
            .await
            .unwrap()
            .unwrap()
            .result,
    )
    .unwrap();
    assert_eq!(result["deliveries"][0]["seq"], ds[0].seq);
    assert_eq!(s.sent_count("hub", 0).await.unwrap(), 1);
    assert_eq!(s.sent_count("hub", 4).await.unwrap(), 0);
    assert_eq!(s.sent_count("b", 0).await.unwrap(), 1);
    assert_eq!(s.sent_count("absent", 0).await.unwrap(), 0);
    assert_eq!(
        s.pending_machine("hub", "host", 0, 99, 200).await.unwrap(),
        ds
    );
    assert!(
        s.pending_machine("hub", "host", ds[0].seq, 99, 200)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        s.pending_machine("hub", "host", 0, 100, 200)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        s.pending_machine("b", "host", 0, 99, 200)
            .await
            .unwrap()
            .is_empty()
    );
    let mut claimed = endpoint.clone();
    claimed.token_hash = Some("client".into());
    s.hub_write(
        "hub",
        HubWrite {
            endpoints: vec![claimed],
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    assert!(
        s.pending_machine("hub", "host", 0, 99, 200)
            .await
            .unwrap()
            .is_empty()
    );
    s.hub_write(
        "hub",
        HubWrite {
            endpoints: vec![endpoint.clone()],
            renew_deliveries: vec![(endpoint.id.clone(), 99)],
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    let renewed = s.pending_machine("hub", "host", 0, 99, 200).await.unwrap();
    assert_eq!(renewed.len(), 1);
    assert!(renewed[0].seq > ds[0].seq);
    assert_eq!(renewed[0].message_id, ds[0].message_id);
    ds = renewed;
    assert_eq!(s.message_deliveries("hub", &message.id).await.unwrap(), ds);
    assert!(
        s.message_deliveries("b", &message.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        s.message_deliveries("hub", "absent")
            .await
            .unwrap()
            .is_empty()
    );

    assert!(
        s.thread_member("hub", "thread", &endpoint.id)
            .await
            .unwrap()
    );
    assert!(!s.thread_member("b", "thread", &endpoint.id).await.unwrap());
    assert!(!s.thread_member("hub", "thread", "absent").await.unwrap());
    assert_eq!(
        s.member_messages("hub", &endpoint.id, "-msg")
            .await
            .unwrap(),
        vec![message.clone()]
    );
    assert!(
        s.member_messages("hub", "absent", "hub-msg")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        s.member_messages("b", &endpoint.id, "hub-msg")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        s.member_messages("hub", &endpoint.id, "msg")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(s.machine_busy("hub", "host", 99).await.unwrap());
    assert!(!s.machine_busy("hub", "host", 100).await.unwrap());
    assert!(!s.machine_busy("b", "host", 1).await.unwrap());
    assert_eq!(
        s.messages("hub", Some("thread"), 0, 100).await.unwrap(),
        vec![message.clone()]
    );
    assert!(
        s.messages("hub", Some("absent"), 0, 100)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(s.messages("hub", None, 4, 100).await.unwrap().is_empty());
    assert!(
        s.messages("b", None, 0, 100)
            .await
            .unwrap()
            .iter()
            .all(|m| m.id != message.id)
    );
    let mut ack = ds[0].clone();
    ack.acked_at = Some(5);
    s.hub_write(
        "hub",
        HubWrite {
            deliveries: vec![ack.clone()],
            states: vec![("state".into(), None)],
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        s.deliveries("hub", &endpoint.id, 0).await.unwrap(),
        vec![ack.clone()]
    );
    assert!(s.machine_busy("hub", "host", 99).await.unwrap());
    assert!(s.state("hub", "state").await.unwrap().is_none());
    ack.seq += 1000;
    assert!(matches!(
        s.hub_write(
            "hub",
            HubWrite {
                deliveries: vec![ack],
                remove_endpoints: vec![endpoint.id.clone()],
                ..HubWrite::default()
            }
        )
        .await,
        Err(StoreError::NotFound)
    ));
    assert_eq!(
        s.endpoints("hub", None).await.unwrap(),
        vec![endpoint.clone()]
    );
    s.hub_write(
        "b",
        HubWrite {
            clear_inboxes: vec![endpoint.id.clone()],
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    assert!(
        !s.deliveries("hub", &endpoint.id, 0)
            .await
            .unwrap()
            .is_empty()
    );
    s.hub_write(
        "hub",
        HubWrite {
            clear_inboxes: vec![endpoint.id.clone()],
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    assert!(
        s.deliveries("hub", &endpoint.id, 0)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(s.message("hub", &message.id).await.unwrap().is_some());
    let tomb = Tombstone {
        name: "host".into(),
        actor_id: Some("member".into()),
        user_id: Some("hub".into()),
        at: 5,
    };
    s.hub_write(
        "hub",
        HubWrite {
            remove_machines: vec!["host".into()],
            tombstones: vec![tomb.clone()],
            remove_endpoints: vec![endpoint.id.clone()],
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(s.tombstones("hub").await.unwrap(), vec![tomb]);
    assert!(
        s.deliveries("hub", &endpoint.id, 0)
            .await
            .unwrap()
            .is_empty()
    );
    s.hub_write(
        "hub",
        HubWrite {
            machines: vec![machine],
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    assert!(s.tombstones("hub").await.unwrap().is_empty());
    s.put_state("hub", "object-state", Some(r#"{"nested":true}"#))
        .await
        .unwrap();
    s.put_state("hub", "pause:old", Some("100")).await.unwrap();
    s.put_state("hub", "denied:future", Some("604800102"))
        .await
        .unwrap();
    s.hub_write(
        "hub",
        HubWrite {
            sweep_at: Some(604800101),
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    assert!(s.state("hub", "object-state").await.unwrap().is_some());
    assert!(s.state("hub", "pause:old").await.unwrap().is_none());
    assert!(s.state("hub", "denied:future").await.unwrap().is_some());
    assert!(s.messages("hub", None, 0, 100).await.unwrap().is_empty());
    s.hub_write(
        "hub",
        HubWrite {
            purge: true,
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    assert!(s.machines("hub").await.unwrap().is_empty());
    assert!(s.state("hub", "sent").await.unwrap().is_none());
    assert!(
        s.events("hub", EventLog::Audit, 0)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(s.account("hub").await.unwrap().is_some());
}

fn credential(id: &str, a: &str, m: &str) -> Credential {
    Credential {
        id: id.into(),
        account_id: a.into(),
        member_id: m.into(),
        kind: CredentialKind::Token,
        name: id.into(),
        secret_hash: format!("hash-{id}"),
        labels: BTreeMap::new(),
        created_at: 10,
        expires_at: None,
        revoked_at: None,
        last_used_at: None,
    }
}
fn device(id: &str) -> DeviceCode {
    DeviceCode {
        device_code_hash: format!("hash-{id}"),
        user_code: format!("USER-{id}"),
        label: "cli".into(),
        created_at: 0,
        expires_at: 900000,
        last_poll_at: None,
        state: DeviceState::Pending,
        account_id: None,
        member_id: None,
        credential_id: None,
    }
}
fn message(id: &str) -> Message {
    Message {
        id: id.into(),
        thread: "thread".into(),
        reply_to: None,
        kind: "message".into(),
        from_ep: "sender".into(),
        to_addr: "recipient".into(),
        created_at: 100,
        expires_at: 1000,
        envelope: "{\"body\":\"hello\"}".into(),
    }
}

async fn contacts_suite(s: Arc<dyn RelayStore>) {
    let now = 1_000_000;
    assert!(s.contact("a", "b").await.unwrap().is_none());
    assert!(matches!(
        s.contact_invite("a", "a", now).await,
        Err(StoreError::Conflict)
    ));
    assert!(matches!(
        s.contact_invite("a", "missing", now).await,
        Err(StoreError::NotFound)
    ));
    s.contact_invite("a", "b", now).await.unwrap();
    assert_eq!(
        s.contact("a", "b").await.unwrap().unwrap().state,
        "pending_out"
    );
    assert_eq!(
        s.contact("b", "a").await.unwrap().unwrap().state,
        "pending_in"
    );
    s.contact_decline("b", "a", now).await.unwrap();
    assert!(s.contact("b", "a").await.unwrap().is_none());
    assert_eq!(
        s.contact("a", "b").await.unwrap().unwrap().state,
        "pending_out"
    );
    s.contact_invite("a", "b", now).await.unwrap();
    s.contact_invite("b", "a", now).await.unwrap();
    for (a, b) in [("a", "b"), ("b", "a")] {
        let c = s.contact(a, b).await.unwrap().unwrap();
        assert_eq!(c.state, "active");
        assert_eq!(c.config, ContactConfig::default());
    }
    let before = s.contact("a", "b").await.unwrap().unwrap();
    for config in [
        ContactConfig {
            allow: vec![
                XAllow {
                    machine: "*".into(),
                    sel: "tree:root".into(),
                    allow_worker: None
                };
                33
            ],
            ..ContactConfig::default()
        },
        ContactConfig {
            limits: Some(XLimits {
                per_day: Some(10001),
                ..XLimits::default()
            }),
            ..ContactConfig::default()
        },
        ContactConfig {
            limits: Some(XLimits {
                per_hour: Some(0),
                ..XLimits::default()
            }),
            ..ContactConfig::default()
        },
        ContactConfig {
            dir: "sideways".into(),
            ..ContactConfig::default()
        },
    ] {
        assert!(matches!(
            s.contact_update("a", "b", config, now + 1).await,
            Err(StoreError::Conflict)
        ));
        assert_eq!(s.contact("a", "b").await.unwrap().unwrap(), before);
    }
    let config = ContactConfig {
        dir: "in".into(),
        limits: Some(XLimits {
            per_minute: Some(1),
            per_hour: Some(10000),
            per_day: Some(2000),
        }),
        ..ContactConfig::default()
    };
    s.contact_update("a", "b", config.clone(), now + 1)
        .await
        .unwrap();
    assert_eq!(s.contacts("a").await.unwrap()[0].config, config);
    assert_eq!(
        s.contact("b", "a").await.unwrap().unwrap().config,
        ContactConfig::default()
    );
    s.contact_block("a", "b", now + 2).await.unwrap();
    s.contact_invite("b", "a", now + 3).await.unwrap();
    assert!(s.contact("b", "a").await.unwrap().is_none());
    assert!(s.contacts("a").await.unwrap().is_empty());
    s.contact_revoke("b", "a", now + 4).await.unwrap();
    assert_eq!(s.contact("a", "b").await.unwrap().unwrap().state, "blocked");
    assert!(
        s.contact("a", "b")
            .await
            .unwrap()
            .unwrap()
            .config
            .allow
            .is_empty()
    );
    s.create_account(Account {
        id: "cap".into(),
        handle: "cap".into(),
        created_at: 0,
    })
    .await
    .unwrap();
    for n in 0..51 {
        let id = format!("cp{n:02}");
        s.create_account(Account {
            id: id.clone(),
            handle: id.clone(),
            created_at: 0,
        })
        .await
        .unwrap();
        let day = 86_400_000 * (n + 1);
        s.contact_invite("cap", &id, day).await.unwrap();
        let accepted = s.contact_accept(&id, "cap", day).await;
        if n == 50 {
            assert!(matches!(accepted, Err(StoreError::Capacity)));
            assert_eq!(
                s.contact("cap", &id).await.unwrap().unwrap().state,
                "pending_out"
            );
            assert_eq!(
                s.contact(&id, "cap").await.unwrap().unwrap().state,
                "pending_in"
            );
        } else {
            accepted.unwrap();
        }
    }
    assert_eq!(s.contacts("cap").await.unwrap().len(), 50);
}

async fn xinbox_suite(s: Arc<dyn RelayStore>) {
    for id in ["xa", "xb"] {
        s.create_account(Account {
            id: id.into(),
            handle: id.into(),
            created_at: 0,
        })
        .await
        .unwrap();
    }
    s.contact_invite("xa", "xb", 0).await.unwrap();
    s.contact_accept("xb", "xa", 0).await.unwrap();
    let e = Endpoint {
        id: "xe".into(),
        machine: "desk".into(),
        handle: "root".into(),
        kind: "agent".into(),
        token_hash: None,
        last_seen: None,
        created_at: 0,
        fields: "{}".into(),
    };
    s.put_endpoint("xb", e.clone()).await.unwrap();
    let mut inserted = Vec::new();
    for n in 0..3 {
        let mut m = message(&format!("msg_cross{n:04}"));
        m.created_at = 1000;
        m.expires_at = 2000;
        let x = XInbox {
            seq: 0,
            id: m.id.clone(),
            endpoint: "desk/root".into(),
            from_account: "xa".into(),
            sender: "xa/laptop/root".into(),
            client_id: format!("c{n}"),
            message: m.envelope.clone(),
            thread: m.thread.clone(),
            grant: Some("grant".into()),
            expires_at: m.expires_at,
            at: 1000,
            acked: false,
        };
        let (stored, dup) = s.xinsert("xb", m.clone(), x.clone()).await.unwrap();
        assert!(!dup);
        let (again, dup) = s.xinsert("xb", m, x).await.unwrap();
        assert!(dup);
        assert_eq!(again, stored);
        inserted.push(stored);
    }
    assert_eq!(
        s.stored_bytes("xb").await.unwrap(),
        3 * message("x").envelope.len() as i64
    );
    assert_eq!(
        s.pending_machine_x("xb", "desk", 100000, 0, 1000, 200)
            .await
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        s.xack("xb", std::slice::from_ref(&e.id), &[inserted[2].seq], 1000)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        s.xack("xb", std::slice::from_ref(&e.id), &[inserted[0].seq], 1000)
            .await
            .unwrap(),
        1
    );
    assert_eq!(s.open_delivery_count("xb", &e.id, 1000).await.unwrap(), 2);
    assert!(s.xinbox("xa").await.unwrap().is_empty());
    let changes = HubWrite {
        deliveries: vec![Delivery {
            seq: i64::MAX,
            message_id: "missing".into(),
            endpoint: e.id.clone(),
            expires_at: 2000,
            acked_at: Some(1000),
            rejected_at: None,
            rejection: None,
            state: "{}".into(),
        }],
        ..HubWrite::default()
    };
    assert!(
        s.acknowledge(
            "xb",
            changes,
            std::slice::from_ref(&e.id),
            &[inserted[1].seq],
            1000
        )
        .await
        .is_err()
    );
    assert!(!s.xinbox("xb").await.unwrap()[1].acked);
    s.contact_revoke("xa", "xb", 1000).await.unwrap();
    assert!(
        s.pending_machine_x("xb", "desk", 0, 0, 1000, 200)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(s.xprune("xb").await.unwrap(), 3);
    assert!(s.xinbox("xb").await.unwrap().is_empty());
    s.contact_invite("xa", "xb", 1000).await.unwrap();
    s.contact_accept("xb", "xa", 1000).await.unwrap();
    let mut m = message("msg_retained");
    m.created_at = 1000;
    m.expires_at = 2000;
    let (x, _) = s
        .xinsert(
            "xb",
            m.clone(),
            XInbox {
                seq: 0,
                id: m.id.clone(),
                endpoint: "desk/root".into(),
                from_account: "xa".into(),
                sender: "xa/laptop/root".into(),
                client_id: "last".into(),
                message: m.envelope.clone(),
                thread: m.thread.clone(),
                grant: None,
                expires_at: 2000,
                at: 1000,
                acked: false,
            },
        )
        .await
        .unwrap();
    assert!(x.seq > inserted[2].seq);
    s.hub_write(
        "xb",
        HubWrite {
            sweep_at: Some(86_400_999),
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(s.xinbox("xb").await.unwrap().len(), 1);
    s.hub_write(
        "xb",
        HubWrite {
            sweep_at: Some(86_401_000),
            ..HubWrite::default()
        },
    )
    .await
    .unwrap();
    assert!(s.xinbox("xb").await.unwrap().is_empty());
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;
    macro_rules! seed_legacy {
        ($pool:expr, $schema:expr) => {{
            for statement in $schema.split(';').filter(|s| !s.trim().is_empty()) {
                sqlx::query(statement).execute($pool).await.unwrap();
            }
            sqlx::query("CREATE TABLE relay_migrations(name TEXT PRIMARY KEY,at BIGINT NOT NULL)").execute($pool).await.unwrap();
            sqlx::query("INSERT INTO relay_migrations(name,at) VALUES('0001_init',0)").execute($pool).await.unwrap();
            let account = Account { id:"legacy".into(),handle:"legacy".into(),created_at:7 };
            let member = Member { id:"legacy".into(),account_id:"legacy".into(),name:"legacy".into(),email:Some("legacy@example.test".into()),role:Role::Admin,created_at:8 };
            let credential = credential("legacy","legacy","legacy");
            let mut code = device("legacy"); code.state=DeviceState::Redeemed; code.account_id=Some("legacy".into()); code.member_id=Some("legacy".into()); code.credential_id=Some("legacy".into()); code.last_poll_at=Some(42);
            sqlx::query("INSERT INTO accounts(id,handle,created_at,payload) VALUES('legacy','legacy',7,$1)").bind(serde_json::to_string(&account).unwrap()).execute($pool).await.unwrap();
            sqlx::query("INSERT INTO members(id,account_id,name,created_at,payload) VALUES('legacy','legacy','legacy',8,$1)").bind(serde_json::to_string(&member).unwrap()).execute($pool).await.unwrap();
            sqlx::query("INSERT INTO credentials(id,account_id,member_id,kind,name,secret_hash,created_at,payload) VALUES('legacy','legacy','legacy','token','legacy','legacy',10,$1)").bind(serde_json::to_string(&credential).unwrap()).execute($pool).await.unwrap();
            sqlx::query("INSERT INTO device_codes(device_code_hash,user_code,expires_at,payload) VALUES('legacy','legacy',900000,$1)").bind(serde_json::to_string(&code).unwrap()).execute($pool).await.unwrap();
        }};
    }
    macro_rules! check_upgrade {
        ($pool:expr) => {{
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT role FROM members WHERE id='legacy'")
                    .fetch_one($pool)
                    .await
                    .unwrap(),
                "admin"
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT email FROM members WHERE id='legacy'")
                    .fetch_one($pool)
                    .await
                    .unwrap(),
                "legacy@example.test"
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>(
                    "SELECT state FROM device_codes WHERE device_code_hash='legacy'"
                )
                .fetch_one($pool)
                .await
                .unwrap(),
                "redeemed"
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT last_poll_at FROM device_codes WHERE device_code_hash='legacy'"
                )
                .fetch_one($pool)
                .await
                .unwrap(),
                42
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM relay_migrations")
                    .fetch_one($pool)
                    .await
                    .unwrap(),
                4
            );
            for table in ["device_codes", "credentials", "members", "accounts"] {
                sqlx::query(&format!("DELETE FROM {table}"))
                    .execute($pool)
                    .await
                    .unwrap();
            }
        }};
    }
    #[tokio::test]
    async fn sqlite_memory() {
        run_suite(Arc::new(
            SqliteStore::connect("sqlite::memory:").await.unwrap(),
        ))
        .await;
    }
    #[tokio::test]
    async fn sqlite_file_reconnect() {
        let base = std::env::var("CARGO_TARGET_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target")
            });
        tokio::fs::create_dir_all(&base).await.unwrap();
        let file = base.join(format!("store-test-{}.db", rand::random::<u64>()));
        let url = format!("sqlite://{}", file.display());
        {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(&file)
                        .create_if_missing(true),
                )
                .await
                .unwrap();
            seed_legacy!(&pool, include_str!("../migrations/sqlite/0001_init.sql"));
            let s = Arc::new(SqliteStore::connect(&url).await.unwrap());
            check_upgrade!(&pool);
            run_suite(s).await;
            pool.close().await;
        }
        let s = SqliteStore::connect(&url).await.unwrap();
        assert_eq!(s.account("alpha").await.unwrap().unwrap().id, "a");
        drop(s);
        let _ = tokio::fs::remove_file(file).await;
    }
    #[tokio::test]
    async fn postgres() {
        let Ok(url) = std::env::var("SCP_RELAY_TEST_PG") else {
            eprintln!("skip PostgreSQL: SCP_RELAY_TEST_PG is unset");
            return;
        };
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(3))
            .connect(&url)
            .await
            .expect("SCP_RELAY_TEST_PG is set but PostgreSQL is unreachable");
        let name = format!("scp_relay_test_{:016x}", rand::random::<u64>());
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
        let (base, query) = url.split_once('?').unwrap_or((&url, ""));
        let (prefix, _) = base.rsplit_once('/').unwrap();
        let test_url = format!(
            "{prefix}/{name}{}",
            if query.is_empty() {
                String::new()
            } else {
                format!("?{query}")
            }
        );
        let task = tokio::spawn(async move {
            let pool = PgPoolOptions::new()
                .max_connections(1)
                .connect(&test_url)
                .await
                .unwrap();
            seed_legacy!(&pool, include_str!("../migrations/postgres/0001_init.sql"));
            let s = Arc::new(PostgresStore::connect(&test_url).await.unwrap());
            check_upgrade!(&pool);
            run_suite(s).await;
            pool.close().await;
            let reconnected = PostgresStore::connect(&test_url).await.unwrap();
            assert_eq!(reconnected.account("alpha").await.unwrap().unwrap().id, "a");
        })
        .await;
        sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
        task.unwrap();
    }
}
