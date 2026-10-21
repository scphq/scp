use super::*;
use scp_relay_store::{Delivery, Tombstone};

impl AccountHub {
    pub(super) fn address(&self, e: &Endpoint) -> String {
        if e.kind == "human" && e.machine.is_empty() {
            format!("{}/", self.account_name())
        } else if e.kind == "system" {
            format!("{}/relay", self.account_name())
        } else {
            format!("{}/{}/{}", self.account_name(), e.machine, e.handle)
        }
    }
    pub(super) fn view(&self, e: &Endpoint) -> Value {
        let f = fields(e);
        let mut view = json!({"id":e.id,"address":self.address(e),"machine":e.machine,"kind":e.kind,"harness":f["harness"],"model":f["model"],"cwd":f["cwd"],"labels":f.get("labels").cloned().unwrap_or_else(||json!({})),"status":f["status"],"presence":f.get("presence").cloned().unwrap_or(json!("offline")),"last_seen":e.last_seen.map(iso),"title":f["title"]});
        if e.kind == "agent" {
            for key in [
                "tree",
                "parent_ep",
                "parent_addr",
                "depth",
                "rules",
                "caps",
                "incarnation",
            ] {
                view[key] = f[key].clone();
            }
            let parent = f["parent_addr"]
                .as_str()
                .map(|s| format!("{}/{s}", self.account_name()))
                .or_else(|| {
                    f["parent_ep"]
                        .as_str()
                        .map(|s| format!("{}/{}/{s}", self.account_name(), e.machine))
                });
            view["parent"] = json!(parent);
            view["wake"] = f["wake"].clone();
            view["scope"] = json!(scope::preset(e));
        }
        if e.token_hash.is_none()
            && f["presence"] == "hibernated"
            && f["waking_until"]
                .as_i64()
                .is_some_and(|at| at > crate::now_ms())
        {
            view["waking"] = json!(true);
        }
        view
    }
    pub(super) fn notification(socket: &SocketHandle, method: &str, params: &Value) {
        socket.send(json!({"jsonrpc":"2.0","method":method,"params":params}).to_string());
    }
    pub(super) fn fleet(&self, mut event: Value) {
        event["at"] = json!(iso(crate::now_ms()));
        if let Some(dash) = super::dashboard::dashboard_event(&event) {
            let _ = self.dashboard.send(dash);
        }
        for c in self.connections.values().filter(|c| c.watching) {
            if let Some(s) = &c.socket {
                Self::notification(s, "fleet", &event);
            }
        }
    }
    pub(super) fn dashboard_endpoints(&self, machine: &str) {
        let _ = self
            .dashboard
            .send(json!({"type":"endpoints","at":iso(crate::now_ms()),"machine":machine}));
    }
    pub(super) async fn announce(
        &self,
        machine: &str,
        endpoints: Vec<Value>,
        full: bool,
        released: bool,
    ) -> Result<()> {
        if released {
            self.dashboard_endpoints(machine);
        }
        let machines = self.store.machines(&self.account_id).await?;
        let bound = machines.iter().find(|m| m.name == machine);
        for c in self
            .connections
            .values()
            .filter(|c| c.role == "bridge" && c.machine != machine)
        {
            if let Some(s) = &c.socket {
                let mut p = json!({"machine":machine,"endpoints":endpoints,"full":full});
                if let Some(bound) = bound {
                    p["own"] = json!(
                        c.grant
                            .as_ref()
                            .is_some_and(|g| g.actor_id == bound.actor_id)
                    );
                }
                if released {
                    p["released"] = json!(true);
                }
                Self::notification(s, "endpoints", &p);
            }
        }
        Ok(())
    }
    pub(super) async fn closed(&mut self, id: &str, replaced: bool) {
        let Some(c) = self.connections.get(id).cloned() else {
            return;
        };
        let mut changes = HubWrite::default();
        let offline_bridge = c.role == "bridge"
            && !replaced
            && !self.connections.iter().any(|(key, other)| {
                key != id && other.role == "bridge" && other.machine == c.machine
            });
        let rows = match self.endpoints().await {
            Ok(rows) => rows,
            Err(_) => {
                self.connections.remove(id);
                return;
            }
        };
        let mut updated = Vec::new();
        let mut adopted = Vec::new();
        let bound = c.role == "bridge"
            || rows
                .iter()
                .any(|e| e.id == c.endpoint && e.machine == c.machine);
        for mut e in rows {
            let direct = c.role == "client"
                && e.id == c.endpoint
                && !self
                    .connections
                    .iter()
                    .any(|(key, other)| key != id && other.endpoint == e.id);
            if direct || (offline_bridge && e.machine == c.machine && e.token_hash.is_none()) {
                let mut f = fields(&e);
                let changed = !matches!(string(&f, "presence"), "hibernated" | "offline");
                if changed {
                    f["presence"] = json!("offline");
                }
                e.fields = f.to_string();
                if direct
                    && e.token_hash.is_some()
                    && self
                        .connections
                        .values()
                        .any(|other| other.role == "bridge" && other.machine == e.machine)
                {
                    e.token_hash = None;
                    changes
                        .renew_deliveries
                        .push((e.id.clone(), crate::now_ms()));
                    adopted.push(e.id.clone());
                }
                e.last_seen = Some(crate::now_ms());
                if changed {
                    updated.push(self.view(&e));
                }
                changes.endpoints.push(e);
            }
        }
        if bound
            && let Ok(machines) = self.store.machines(&self.account_id).await
            && let Some(mut m) = machines.into_iter().find(|m| m.name == c.machine)
        {
            m.last_seen = Some(crate::now_ms());
            changes.machines.push(m);
        }
        if self
            .store
            .hub_write(&self.account_id, changes)
            .await
            .is_ok()
        {
            if bound {
                let _ = self
                    .announce(&c.machine, updated.clone(), false, false)
                    .await;
            }
            for view in updated {
                self.fleet(json!({"type":"presence","machine":c.machine,"endpoint":view["address"],"presence":view["presence"]}));
            }
            for endpoint in &adopted {
                if let Ok(pending) = self.pending(endpoint, 0).await {
                    let _ = self.push(&pending).await;
                }
            }
        }
        self.connections.remove(id);
        if let Some(g) = &c.grant
            && !self.connections.values().any(|other| {
                other.socket.is_some()
                    && other
                        .grant
                        .as_ref()
                        .is_some_and(|grant| grant.token_id == g.token_id)
            })
        {
            self.revalidation_errors.remove(&g.token_id);
            let _ = self
                .store
                .put_state(
                    &self.account_id,
                    &format!("revalidate_error:{}", g.token_id),
                    None,
                )
                .await;
        }
        if !self
            .connections
            .values()
            .any(|other| other.machine == c.machine && other.role == "bridge")
        {
            self.syncs.remove(&c.machine);
            self.broken_syncs
                .retain(|(machine, _)| machine != &c.machine);
        }
    }
    pub(super) async fn revoke(&mut self, token: &str) {
        let now = crate::now_ms();
        let mut changes = HubWrite::default();
        if let Ok(machines) = self.store.machines(&self.account_id).await {
            for m in machines.into_iter().filter(|m| m.token_id == token) {
                changes.remove_machines.push(m.name.clone());
                changes.tombstones.push(Tombstone {
                    name: m.name,
                    actor_id: Some(m.actor_id),
                    user_id: Some(m.user_id),
                    at: now,
                });
            }
        }
        changes
            .states
            .push((format!("denied:{token}"), Some(json!(now).to_string())));
        let _ = self.store.hub_write(&self.account_id, changes).await;
    }
    pub(super) async fn delivery_value(&self, d: &Delivery, inbox: bool) -> Result<Value> {
        let message = self
            .store
            .message(&self.account_id, &d.message_id)
            .await?
            .ok_or_else(|| Error::new("not_found", "message expired"))?;
        let mut value: Value = serde_json::from_str(&message.envelope)
            .map_err(|_| Error::new("unavailable", "invalid stored message"))?;
        let endpoints = self.endpoints().await?;
        if let Some(e) = endpoints.iter().find(|e| e.id == d.endpoint) {
            if value["to"].as_str().is_some_and(|s| s.contains(',')) {
                value["to"] = json!(self.address(e));
            }
            if let Some(sender) = endpoints.iter().find(|e| e.id == message.from_ep) {
                value["from"]["address"] = json!(self.address(sender));
                let f = fields(sender);
                value["from"]["claims"]["harness"] = f["harness"].clone();
                value["from"]["claims"]["model"] = f["model"].clone();
                if let Some(rel) = scope::relation(sender, e) {
                    value["from"]["rel"] = json!(if sender.kind == "human"
                        && value["from"]["claims"]["tty"] == false
                    {
                        "human, no terminal".into()
                    } else {
                        rel
                    });
                }
            }
        }
        if inbox {
            value["seq"] = json!(d.seq);
        }
        Ok(value)
    }
    pub(super) async fn push(&self, deliveries: &[Delivery]) -> Result<()> {
        self.push_with_capacity(deliveries, false).await
    }
    pub(super) async fn push_with_capacity(
        &self,
        deliveries: &[Delivery],
        wait: bool,
    ) -> Result<()> {
        let endpoints = self.endpoints().await?;
        for d in deliveries {
            let Some(e) = endpoints.iter().find(|e| e.id == d.endpoint) else {
                continue;
            };
            let mut pushed = false;
            for c in self.connections.values().filter(|c| {
                c.role == "bridge"
                    && c.subscribed
                    && c.machine == e.machine
                    && e.token_hash.is_none()
            }) {
                if let Some(s) = &c.socket {
                    pushed = true;
                    let frame = json!({"jsonrpc":"2.0","method":"deliver","params":{"seq":d.seq,"endpoint":format!("{}/{}",e.machine,e.handle),"message":self.delivery_value(d,false).await?}}).to_string();
                    if wait {
                        if !s.send_wait(frame).await {
                            return Err(Error::new("unavailable", "connection closed"));
                        }
                    } else {
                        s.send(frame);
                    }
                }
            }
            if !pushed && e.token_hash.is_none() {
                let message = self.delivery_value(d, false).await?;
                if message["from"]["account"]
                    .as_str()
                    .is_none_or(|a| a == self.handle)
                    && self
                        .machine_wake(&e.machine, &e.id, &message, None)
                        .await
                        .is_err()
                {
                    tracing::warn!("machine wake unavailable");
                }
            }
        }
        Ok(())
    }
}
