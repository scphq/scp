use super::*;
use validation::{pattern, seqs};

impl AccountHub {
    pub(super) async fn ack(&self, c: &Connection, p: &Value) -> Result<Value> {
        let requested = seqs(p)?;
        let mut changes = HubWrite::default();
        let now = crate::now_ms();
        for mut e in self.endpoints().await?.into_iter().filter(|e| {
            if c.role == "bridge" {
                e.machine == c.machine && e.token_hash.is_none()
            } else {
                e.id == c.endpoint
            }
        }) {
            let mut messages = Vec::new();
            for mut d in self.pending(&e.id, 0).await? {
                if requested.contains(&d.seq) {
                    messages.push(self.delivery_value(&d, false).await?);
                    d.acked_at = Some(now);
                    changes.deliveries.push(d);
                }
            }
            if let Some(hop) = messages.iter().filter_map(|v| v["hop"].as_u64()).max() {
                let mut f = fields(&e);
                let old = if f["received_at"]
                    .as_i64()
                    .is_some_and(|at| at >= now - 120000)
                {
                    f["received_hop"].as_u64().unwrap_or(0)
                } else {
                    0
                };
                f["received_at"] = json!(now);
                f["received_hop"] = json!(old.max(hop));
                e.fields = f.to_string();
                changes.endpoints.push(e);
            }
        }
        let count = changes.deliveries.len();
        self.store.hub_write(&self.account_id, changes).await?;
        Ok(json!({"acked":count}))
    }
    pub(super) async fn reject(&mut self, c: &Connection, p: &Value) -> Result<Value> {
        let seq = p["seq"]
            .as_i64()
            .ok_or_else(|| invalid("seq must be an integer"))?;
        let code = string(p, "code");
        if !pattern!(r"^[a-z_]{1,32}$", code) {
            return Err(invalid("code is an error code"));
        }
        let rows = self.endpoints().await?;
        for e in rows
            .iter()
            .filter(|e| e.machine == c.machine && e.token_hash.is_none())
        {
            if let Some(mut d) = self
                .pending(&e.id, 0)
                .await?
                .into_iter()
                .find(|d| d.seq == seq)
            {
                let m = self
                    .store
                    .message(&self.account_id, &d.message_id)
                    .await?
                    .ok_or_else(|| Error::new("not_found", "no message"))?;
                d.acked_at = Some(crate::now_ms());
                d.rejected_at = d.acked_at;
                d.rejection = Some(code.into());
                let changes = HubWrite {
                    deliveries: vec![d],
                    ..HubWrite::default()
                };
                if let Some(sender) = rows.iter().find(|e| e.id == m.from_ep) {
                    self.post_notice(
                        Some(sender),
                        false,
                        &format!("{} refused message {} ({}).", self.address(e), m.id, code),
                        changes,
                    )
                    .await?;
                } else {
                    self.store.hub_write(&self.account_id, changes).await?;
                }
                return Ok(json!({"rejected":true}));
            }
        }
        Err(Error::new("not_found", "no unacked delivery"))
    }
}
