use super::*;

impl Hub {
    /// Read the account dashboard without creating a protocol connection.
    pub async fn overview(
        &self,
        account: &scp_relay_store::Account,
        activity: u64,
    ) -> std::result::Result<Value, Value> {
        let hub = self.account_by_id(&account.id, &account.handle).await;
        let mut hub = hub.lock().await;
        hub.initialize().await.map_err(|e| e.wire())?;
        let mut snapshot = hub
            .client_method(
                "",
                &Connection::default(),
                "snapshot",
                &json!({"activity":activity}),
            )
            .await
            .map_err(|e| e.wire())?;
        snapshot.as_object_mut().unwrap().remove("unread");
        snapshot["machines"] = hub.machines().await.map_err(|e| e.wire())?["machines"].clone();
        Ok(snapshot)
    }
    /// Read listed endpoints and message pairs over a bounded time window.
    pub async fn graph(
        &self,
        account: &scp_relay_store::Account,
        minutes: i64,
    ) -> std::result::Result<Value, Value> {
        let hub = self.account_by_id(&account.id, &account.handle).await;
        let mut hub = hub.lock().await;
        hub.initialize().await.map_err(|e| e.wire())?;
        hub.graph(minutes.clamp(1, 60)).await.map_err(|e| e.wire())
    }
    /// Subscribe before reading the initial dashboard state to avoid missed events.
    pub async fn dashboard_events(
        &self,
        account: &scp_relay_store::Account,
    ) -> tokio::sync::broadcast::Receiver<Value> {
        self.account_by_id(&account.id, &account.handle)
            .await
            .lock()
            .await
            .dashboard
            .subscribe()
    }
}
impl AccountHub {
    async fn graph(&mut self, minutes: i64) -> Result<Value> {
        let listed = self
            .client_method("", &Connection::default(), "list", &json!({}))
            .await?;
        let endpoints = listed["endpoints"].as_array().unwrap();
        let by_id: BTreeMap<_, _> = endpoints
            .iter()
            .map(|e| {
                (
                    e["id"].as_str().unwrap_or(""),
                    e["address"].as_str().unwrap_or(""),
                )
            })
            .collect();
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        for e in endpoints {
            let mut node = json!({});
            for key in [
                "address",
                "kind",
                "harness",
                "title",
                "presence",
                "status",
                "last_seen",
                "parent",
            ] {
                node[key] = e[key].clone();
            }
            for key in ["wake", "waking"] {
                if let Some(value) = e.get(key) {
                    node[key] = value.clone();
                }
            }
            if let Some(parent) = e["parent"].as_str()
                && e["address"] != parent
                && by_id.values().any(|a| *a == parent)
            {
                edges.push(json!({"kind":"spawn","from":parent,"to":e["address"]}));
            }
            nodes.push(node);
        }
        let since = crate::now_ms().saturating_sub(minutes * 60000);
        let mut pairs: BTreeMap<(String, String), (u64, i64)> = BTreeMap::new();
        for local in [false, true] {
            for pair in self
                .store
                .pairs(&self.account_id, None, None, since.saturating_add(1), local)
                .await?
            {
                let (Some(from), Some(to)) = (
                    by_id.get(pair.from_ep.as_str()),
                    by_id.get(pair.to_ep.as_str()),
                ) else {
                    continue;
                };
                if from == to {
                    continue;
                }
                let entry = pairs.entry(((*from).into(), (*to).into())).or_default();
                entry.0 += 1;
                entry.1 = entry.1.max(pair.at);
            }
        }
        let mut traffic: Vec<_> = pairs.into_iter().collect();
        traffic.sort_by(|(a, _), (b, _)| {
            address_order(&a.0, &b.0).then_with(|| address_order(&a.1, &b.1))
        });
        for ((from, to), (count, last)) in traffic {
            edges.push(
                json!({"kind":"message","from":from,"to":to,"count":count,"last_at":iso(last)}),
            );
        }
        let bindings = self.store.machines(&self.account_id).await?;
        let mut machines = self.machines().await?["machines"]
            .as_array()
            .unwrap()
            .clone();
        for machine in &mut machines {
            machine["actor"] = json!(
                bindings
                    .iter()
                    .find(|m| machine["name"] == m.name)
                    .map(|m| &m.actor_id)
            );
        }
        Ok(json!({"minutes":minutes,"machines":machines,"nodes":nodes,"edges":edges}))
    }
}

pub(super) fn dashboard_event(event: &Value) -> Option<Value> {
    match event["type"].as_str()? {
        "message" => {
            let from = event["from"].as_str().filter(|s| !s.is_empty())?;
            let to: Vec<_> = event["to"]
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect();
            if to.is_empty() {
                return None;
            }
            let mut out = json!({"type":"message","at":event["at"],"kind":event["kind"].as_str().unwrap_or("message"),"from":from,"to":to});
            if event["local"] == true {
                out["local"] = json!(true);
            }
            Some(out)
        }
        "presence" => {
            let endpoint = event["endpoint"].as_str().filter(|s| !s.is_empty())?;
            let presence = event["presence"].as_str()?;
            if !matches!(presence, "online" | "idle" | "offline" | "hibernated")
                || (presence == "hibernated" && !event["waking"].is_boolean())
            {
                return None;
            }
            let mut out = json!({"type":"presence","at":event["at"],"machine":event["machine"].as_str(),"endpoint":endpoint,"presence":presence});
            if event["waking"].is_boolean() {
                out["waking"] = event["waking"].clone();
            }
            Some(out)
        }
        _ => None,
    }
}

fn address_order(a: &str, b: &str) -> std::cmp::Ordering {
    // Lowercase ASCII address punctuation follows localeCompare ordering.
    let rank = |byte| match byte {
        b'_' => 0,
        b'-' => 1,
        b'.' => 2,
        b'/' => 3,
        _ => u16::from(byte) + 4,
    };
    a.bytes().map(rank).cmp(b.bytes().map(rank))
}

#[cfg(test)]
mod tests {
    #[test]
    fn graph_traffic_uses_address_locale_order() {
        let mut addresses = ["a/b/ab", "a/b/a.b", "a/b/a_b", "a/b/a-b"];
        addresses.sort_by(|a, b| super::address_order(a, b));
        assert_eq!(addresses, ["a/b/a_b", "a/b/a-b", "a/b/a.b", "a/b/ab"]);
    }
}
