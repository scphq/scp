use super::*;
impl AccountHub {
    pub(super) async fn sweep(&mut self) -> Result<()> {
        let now = crate::now_ms();
        self.sweep_wakes(now).await?;
        self.store.xprune(&self.account_id).await?;
        self.xcounters
            .true_up(self.store.as_ref(), &self.account_id, now, None)
            .await?;
        self.store
            .hub_write(
                &self.account_id,
                HubWrite {
                    sweep_at: Some(now),
                    denied_before: Some(
                        now.saturating_sub(
                            self.limits
                                .duration("deniedS", 3600)
                                .saturating_mul(1000)
                                .min(i64::MAX as u64) as i64,
                        ),
                    ),
                    ..HubWrite::default()
                },
            )
            .await?;
        let endpoints = self.endpoints().await?;
        let cutoff = now.saturating_sub(
            self.limits
                .duration("clientMachineIdleS", 1209600)
                .saturating_mul(1000)
                .min(i64::MAX as u64) as i64,
        );
        for m in self.store.machines(&self.account_id).await? {
            if m.kind != "client"
                || m.last_seen.unwrap_or(m.created_at) > cutoff
                || self
                    .connections
                    .values()
                    .any(|c| super::machines::holds(c, &m.name, &endpoints))
                || self
                    .store
                    .machine_busy(&self.account_id, &m.name, now)
                    .await?
            {
                continue;
            }
            let rows = self
                .store
                .endpoints(&self.account_id, Some(&m.name))
                .await?;
            self.store
                .hub_write(
                    &self.account_id,
                    HubWrite {
                        events: vec![(
                            scp_relay_store::EventLog::Audit,
                            scp_relay_store::Event {
                                id: 0,
                                at: now,
                                kind: "machine_expire".into(),
                                endpoint: None,
                                reference: Some(m.name.clone()),
                                detail: json!({"machine":m.name,"endpoints":rows.len()})
                                    .to_string(),
                            },
                        )],
                        remove_machines: vec![m.name.clone()],
                        remove_endpoints: rows.into_iter().map(|e| e.id).collect(),
                        ..HubWrite::default()
                    },
                )
                .await?;
            self.announce(&m.name, vec![], true, true).await?;
        }
        for tomb in self.store.tombstones(&self.account_id).await? {
            if tomb.at > now - 3196800000
                || self
                    .store
                    .machine_busy(&self.account_id, &tomb.name, now)
                    .await?
            {
                continue;
            }
            let endpoints = self
                .store
                .endpoints(&self.account_id, Some(&tomb.name))
                .await?;
            self.store
                .hub_write(
                    &self.account_id,
                    HubWrite {
                        remove_machines: vec![tomb.name.clone()],
                        remove_endpoints: endpoints.into_iter().map(|e| e.id).collect(),
                        ..HubWrite::default()
                    },
                )
                .await?;
            self.announce(&tomb.name, vec![], true, true).await?;
        }
        self.buckets.retain(|_, b| !b.full(now));
        let mut idle = !self.connections.values().any(|c| c.socket.is_some())
            && self.store.machines(&self.account_id).await?.is_empty()
            && self.store.tombstones(&self.account_id).await?.is_empty();
        if idle {
            for endpoint in self.endpoints().await? {
                if !self.pending(&endpoint.id, 0).await?.is_empty() {
                    idle = false;
                    break;
                }
            }
        }
        let idle_since = self
            .store
            .state(&self.account_id, "idle_since")
            .await?
            .and_then(|s| serde_json::from_str::<i64>(&s).ok());
        if !idle {
            self.store
                .put_state(&self.account_id, "idle_since", None)
                .await?;
        } else if let Some(since) = idle_since {
            if now.saturating_sub(since)
                >= self
                    .limits
                    .duration("idlePurgeS", 2592000)
                    .saturating_mul(1000)
                    .min(i64::MAX as u64) as i64
            {
                self.store
                    .hub_write(
                        &self.account_id,
                        HubWrite {
                            purge: true,
                            ..HubWrite::default()
                        },
                    )
                    .await?;
                self.initialized = false;
                self.buckets.clear();
                self.refusals.clear();
            }
        } else {
            self.store
                .put_state(
                    &self.account_id,
                    "idle_since",
                    Some(&json!(now).to_string()),
                )
                .await?;
        }
        Ok(())
    }
}
