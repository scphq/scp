use super::*;

impl AccountHub {
    pub(super) async fn machines(&self) -> Result<Value> {
        let endpoints = self.endpoints().await?;
        let mut out = Vec::new();
        let machines = self.store.machines(&self.account_id).await?;
        for m in &machines {
            let online = self
                .connections
                .values()
                .any(|c| c.socket.is_some() && holds(c, &m.name, &endpoints));
            let bridge = self
                .connections
                .values()
                .any(|c| c.socket.is_some() && c.machine == m.name && c.role == "bridge");
            out.push(json!({"name":m.name,"kind":m.kind,"online":online,"bridge":bridge,"created_at":iso(m.created_at),"last_seen":m.last_seen.map(iso),"wake":self.store.state(&self.account_id,&format!("wake:{}",m.name)).await?.is_some()}));
        }
        for t in self.store.tombstones(&self.account_id).await? {
            if machines.iter().any(|m| m.name == t.name) {
                continue;
            }
            out.push(json!({"name":t.name,"kind":"revoked","online":false,"bridge":false,"created_at":null,"last_seen":iso(t.at)}));
        }
        Ok(json!({"machines":out}))
    }
    pub(super) async fn remove_machine(
        &mut self,
        id: &str,
        c: &Connection,
        p: &Value,
    ) -> Result<Value> {
        let name = string(p, "name");
        if !crate::valid_name(name) {
            return Err(invalid("name is a machine name"));
        }
        let g = c
            .grant
            .as_ref()
            .ok_or_else(|| Error::new("unauthorized", "missing grant"))?;
        let bound = self
            .store
            .machines(&self.account_id)
            .await?
            .into_iter()
            .find(|m| m.name == name);
        let tomb = self
            .store
            .tombstones(&self.account_id)
            .await?
            .into_iter()
            .find(|m| m.name == name);
        let actor = bound
            .as_ref()
            .map(|m| m.actor_id.as_str())
            .or_else(|| tomb.as_ref().and_then(|t| t.actor_id.as_deref()))
            .ok_or_else(|| Error::new("not_found", "no machine"))?;
        let endpoints = self.endpoints().await?;
        let live = self
            .connections
            .values()
            .any(|c| holds(c, name, &endpoints));
        if !(bound.as_ref().is_some_and(|m| m.token_id == g.token_id)
            || (!g.scoped && (actor == g.actor_id || matches!(g.role, Role::Owner | Role::Admin)))
            || (bound.is_some() && actor == g.actor_id && !live))
        {
            return Err(Error::new("unauthorized", "cannot release this machine"));
        }
        let rows = self.store.endpoints(&self.account_id, Some(name)).await?;
        let changes = HubWrite {
            remove_endpoints: rows.iter().map(|e| e.id.clone()).collect(),
            remove_machines: vec![name.into()],
            ..HubWrite::default()
        };
        self.store.hub_write(&self.account_id, changes).await?;
        let keys:Vec<_>=self.connections.iter().filter(|(key,c)|key.as_str()!=id&&c.machine==name&&(c.role=="bridge"||!c.endpoint.is_empty())).map(|(key,c)|{if let Some(s)=&c.socket{s.finish(Closure{code:1008,reason:"machine released".into(),notification:Some(json!({"jsonrpc":"2.0","method":"revoked","params":{"reason":"machine released"}}).to_string())});}key.clone()}).collect();
        for key in keys {
            self.connections.remove(&key);
        }
        self.syncs.remove(name);
        self.announce(name, vec![], true, true).await?;
        Ok(json!({"removed":name,"endpoints":rows.len()}))
    }
}

pub(super) fn holds(c: &Connection, machine: &str, rows: &[Endpoint]) -> bool {
    c.machine == machine
        && (c.role == "bridge"
            || rows
                .iter()
                .any(|e| e.id == c.endpoint && e.machine == machine))
}
