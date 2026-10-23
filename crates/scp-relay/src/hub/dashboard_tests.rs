use super::*;
use scp_relay_store::{Event, EventLog, PairEvent, Tombstone};

#[tokio::test]
async fn dashboard_views_match_snapshot_and_aggregate_pair_tables() {
    let (hub, g) = fixture().await;
    let a = hub.store.account("acme").await.unwrap().unwrap();
    let mut events = hub.dashboard_events(&a).await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let parent = view("parent");
    let mut child = view("child");
    child["parent_ep"] = json!("parent");
    child["tree"] = json!("parent");
    child["depth"] = json!(1);
    let response = hub
        .call(
            &account,
            &id,
            request(2, "mirror", json!({"endpoints":[parent,child],"full":true})),
            false,
        )
        .await;
    assert!(response.get("error").is_none(), "{response}");
    let endpoints = account.lock().await.endpoints().await.unwrap();
    let parent = endpoints.iter().find(|e| e.handle == "parent").unwrap();
    let child = endpoints.iter().find(|e| e.handle == "child").unwrap();
    let at = crate::now_ms();
    for (from, to, time, local) in [
        (&parent.id, &child.id, at - 1000, false),
        (&parent.id, &child.id, at - 500, true),
        (&child.id, &parent.id, at - 200, false),
        (&child.id, &parent.id, at - 61 * 60000, false),
        (&parent.id, &parent.id, at, false),
    ] {
        hub.store
            .append_pair(
                &a.id,
                PairEvent {
                    from_ep: from.clone(),
                    to_ep: to.clone(),
                    at: time,
                },
                local,
            )
            .await
            .unwrap();
    }
    for n in 0..25 {
        hub.store
            .append_event(
                &a.id,
                EventLog::Activity,
                Event {
                    id: 0,
                    at: at + n,
                    kind: "note".into(),
                    endpoint: Some(child.id.clone()),
                    reference: None,
                    detail: json!({"endpoint":"stale/address","summary":"activity"}).to_string(),
                },
            )
            .await
            .unwrap();
    }
    hub.store
        .hub_write(
            &a.id,
            HubWrite {
                tombstones: vec![Tombstone {
                    name: "revoked".into(),
                    actor_id: Some(g.actor_id.clone()),
                    user_id: Some(g.user_id.clone()),
                    at,
                }],
                ..HubWrite::default()
            },
        )
        .await
        .unwrap();
    let overview = hub.overview(&a, 20).await.unwrap();
    let snapshot = observer(&hub, &g, "snapshot", json!({"activity":20})).await;
    assert_eq!(overview["endpoints"], snapshot["result"]["endpoints"]);
    assert_eq!(overview["activity"], snapshot["result"]["activity"]);
    assert_eq!(overview["activity"].as_array().unwrap().len(), 20);
    assert_eq!(overview["activity"][0]["endpoint"], "acme/host/child");
    assert_eq!(overview["machines"][0]["online"], true);
    assert_eq!(overview["machines"][1]["kind"], "revoked");
    let graph = hub.graph(&a, 15).await.unwrap();
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(graph["machines"][0]["actor"], g.actor_id);
    assert!(graph["machines"][1]["actor"].is_null());
    assert_eq!(
        graph["edges"],
        json!([
            {"kind":"spawn","from":"acme/host/parent","to":"acme/host/child"},
            {"kind":"message","from":"acme/host/child","to":"acme/host/parent","count":1,"last_at":iso(at-200)},
            {"kind":"message","from":"acme/host/parent","to":"acme/host/child","count":2,"last_at":iso(at-500)},
        ])
    );
    assert_eq!(hub.graph(&a, 0).await.unwrap()["minutes"], 1);
    assert_eq!(hub.graph(&a, 99).await.unwrap()["minutes"], 60);
    let mut saw_presence = false;
    let mut saw_endpoints = false;
    while let Ok(event) = events.try_recv() {
        saw_presence |= event["type"] == "presence";
        saw_endpoints |= event["type"] == "endpoints";
        for key in ["body", "note", "summary", "labels", "label"] {
            assert!(event.get(key).is_none());
        }
    }
    assert!(saw_presence && saw_endpoints);
}
#[test]
fn dashboard_event_mapping_filters_private_fields_and_invalid_events() {
    use crate::hub::dashboard::dashboard_event;
    assert_eq!(
        dashboard_event(&json!({"type":"activity","summary":"private"})),
        None
    );
    assert_eq!(
        dashboard_event(&json!({"type":"presence","endpoint":"a/b/c","presence":"hibernated"})),
        None
    );
    assert_eq!(
        dashboard_event(&json!({"type":"presence","endpoint":"a/b/c","presence":"invalid"})),
        None
    );
    assert_eq!(
        dashboard_event(&json!({"type":"message","from":"a/b/c","to":[]})),
        None
    );
    assert_eq!(
        dashboard_event(
            &json!({"type":"message","at":"now","from":"a/b/c","to":[null,"a/b/d",42],"body":"private","summary":"private","local":true})
        ),
        Some(
            json!({"type":"message","at":"now","kind":"message","from":"a/b/c","to":["a/b/d"],"local":true})
        )
    );
    assert_eq!(
        dashboard_event(
            &json!({"type":"presence","at":"now","endpoint":"a/b/c","presence":"idle","note":"private","waking":false})
        ),
        Some(
            json!({"type":"presence","at":"now","machine":null,"endpoint":"a/b/c","presence":"idle","waking":false})
        )
    );
}

#[tokio::test]
async fn endpoint_events_only_follow_full_or_structural_mirrors() {
    let (hub, g) = fixture().await;
    let a = hub.store.account("acme").await.unwrap().unwrap();
    let mut events = hub.dashboard_events(&a).await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let mut endpoint = view("agent");
    for (n, full, structural) in [(1, false, true), (2, false, false), (3, true, true)] {
        if n == 2 {
            endpoint["presence"] = json!("idle");
        }
        let response = hub
            .call(
                &account,
                &id,
                request(n, "mirror", json!({"endpoints":[endpoint],"full":full})),
                false,
            )
            .await;
        assert!(response.get("error").is_none(), "{response}");
        let mut got_endpoints = false;
        while let Ok(event) = events.try_recv() {
            got_endpoints |= event["type"] == "endpoints";
        }
        assert_eq!(got_endpoints, structural);
    }
    account.lock().await.closed(&id, false).await;
    while let Ok(event) = events.try_recv() {
        assert_ne!(event["type"], "endpoints");
    }
}

#[tokio::test]
async fn historic_filters_and_observed_activity() {
    let (hub, g) = fixture_limits(&["historicAfterS=1"]).await;
    let a = hub.store.account("acme").await.unwrap().unwrap();
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let old = crate::now_ms() - 10_000;
    let mut stale = view("stale");
    stale["active_at"] = json!(iso(old));
    stale["last_seen"] = json!(iso(old));
    stale["historic"] = json!(false);
    let mut fresh = view("fresh");
    fresh["active_at"] = json!(iso(crate::now_ms()));
    fresh["last_seen"] = json!(iso(old));
    let response = hub
        .call(
            &account,
            &id,
            request(2, "mirror", json!({"endpoints":[stale,fresh]})),
            false,
        )
        .await;
    assert!(response.get("error").is_none(), "{response}");
    let rows = account.lock().await.endpoints().await.unwrap();
    let stale = rows.iter().find(|e| e.handle == "stale").unwrap();
    let fresh = rows.iter().find(|e| e.handle == "fresh").unwrap();
    hub.store
        .append_pair(
            &a.id,
            PairEvent {
                from_ep: fresh.id.clone(),
                to_ep: stale.id.clone(),
                at: crate::now_ms(),
            },
            false,
        )
        .await
        .unwrap();
    let listed = observer(&hub, &g, "list", json!({})).await;
    assert_eq!(listed["result"]["endpoints"].as_array().unwrap().len(), 1);
    for p in [json!({"all":true}), json!({"historic":true})] {
        let listed = observer(&hub, &g, "list", p).await;
        let rows = listed["result"]["endpoints"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter()
                .find(|e| e["address"] == "acme/host/stale")
                .unwrap()["historic"],
            true
        );
    }
    assert_eq!(
        hub.overview(&a, 20).await.unwrap()["endpoints"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let graph = hub.graph(&a, 15).await.unwrap();
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 1);
    assert!(graph["edges"].as_array().unwrap().is_empty());
    let graph = hub.graph_historic(&a, 15, true).await.unwrap();
    assert_eq!(graph["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(graph["edges"].as_array().unwrap().len(), 1);
    assert_eq!(
        hub.overview_historic(&a, 20, true).await.unwrap()["endpoints"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let sent = hub
        .call(
            &account,
            &id,
            request(
                3,
                "forward",
                json!({"from":"fresh","params":{"to":"host/stale","body":"activity"}}),
            ),
            false,
        )
        .await;
    assert!(sent.get("error").is_none(), "{sent}");
    {
        let mut h = account.lock().await;
        assert!(!h.historic(stale, crate::now_ms()));
        assert!(!h.historic(fresh, crate::now_ms()));
        h.observed_activity.clear();
        assert!(h.historic(stale, crate::now_ms()));
        assert!(!h.historic(stale, old + 999));
        assert!(h.historic(stale, old + 1000));
        h.event(stale, &json!({"kind":"tool"})).await.unwrap();
        assert!(!h.historic(stale, crate::now_ms()));
        h.observed_activity.clear();
        h.local_events(&Connection { machine:"host".into(), ..Connection::default() },&json!({"events":[{"kind":"message","at":crate::now_ms(),"from":"fresh","to":["stale"]}]})).await.unwrap();
        assert!(!h.historic(stale, crate::now_ms()));
        assert_eq!(
            h.endpoints()
                .await
                .unwrap()
                .iter()
                .find(|e| e.id == stale.id)
                .unwrap()
                .last_seen,
            stale.last_seen
        );
        h.observed_activity.clear();
        h.limits.apply("historicAfterS=Infinity").unwrap();
        assert!(!h.historic(stale, crate::now_ms()));
        h.limits.apply("historicAfterS=0").unwrap();
        let mut human = stale.clone();
        human.kind = "human".into();
        assert!(!h.historic(&human, crate::now_ms()));
    }
}

#[tokio::test]
async fn mirrored_activity_is_clamped_to_now() {
    let (hub, g) = fixture_limits(&["historicAfterS=1"]).await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let now = crate::now_ms();
    let mut future = view("future");
    future["active_at"] = json!(iso(now + 86_400_000));
    future["last_seen"] = json!(iso(now - 10_000));
    let response = hub
        .call(
            &account,
            &id,
            request(2, "mirror", json!({"endpoints":[future]})),
            false,
        )
        .await;
    assert!(response.get("error").is_none(), "{response}");
    let h = account.lock().await;
    let rows = h.endpoints().await.unwrap();
    let e = rows.iter().find(|e| e.handle == "future").unwrap();
    assert_eq!(h.active_at(e, now), now);
    assert!(!h.historic(e, now));
    assert_eq!(h.active_at(e, now + 1000), now + 1000);
}

#[tokio::test]
async fn local_events_observe_event_time_for_sender_and_recipients() {
    let (hub, g) = fixture_limits(&["historicAfterS=1"]).await;
    let (account, id, _rx) = bridge(&hub, &g, "host").await;
    let old = crate::now_ms() - 10_000;
    let mut sender = view("sender");
    sender["active_at"] = json!(iso(old));
    sender["last_seen"] = json!(iso(old));
    let mut recipient = sender.clone();
    recipient["address"] = json!("me/recipient");
    let response = hub
        .call(
            &account,
            &id,
            request(2, "mirror", json!({"endpoints":[sender,recipient]})),
            false,
        )
        .await;
    assert!(response.get("error").is_none(), "{response}");
    let mut h = account.lock().await;
    let rows = h.endpoints().await.unwrap();
    let c = Connection {
        machine: "host".into(),
        ..Connection::default()
    };
    let at = crate::now_ms() - 5000;
    let result = h
        .local_events(
            &c,
            &json!({"events":[{"kind":"message","at":at,"from":"sender","to":["recipient"]}]}),
        )
        .await
        .unwrap();
    assert_eq!(result["recorded"], 1);
    for e in &rows {
        assert_eq!(h.observed_activity.get(&e.id), Some(&at));
        assert!(h.historic(e, crate::now_ms()));
    }
    let before = crate::now_ms();
    h.local_events(&c, &json!({"events":[{"kind":"message","at":before + 86_400_000,"from":"sender","to":["recipient"]}]})).await.unwrap();
    let after = crate::now_ms();
    for e in &rows {
        let observed = h.observed_activity[&e.id];
        assert!((before..=after).contains(&observed));
        assert!(!h.historic(e, after));
    }
}
