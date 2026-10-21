use super::*;
use scp_relay_store::{Event, EventLog};

pub(super) fn revalidate_delay(ms: u64, retry: bool) -> Duration {
    Duration::from_millis(if retry { ms.min(30_000) } else { ms }.max(1))
}

#[derive(Clone)]
pub(super) struct Bucket {
    rate: f64,
    tokens: f64,
    at: i64,
    refused: u64,
}
impl Bucket {
    pub(super) fn full(&self, now: i64) -> bool {
        !self.rate.is_finite()
            || self.tokens + (now - self.at) as f64 * self.rate / 60_000.0 >= self.rate
    }
    fn retry(&self, cost: f64) -> i64 {
        (((cost - self.tokens) * 60.0 / self.rate).ceil() as i64).max(1)
    }
}
#[derive(Default)]
pub(super) struct Refusals {
    minute: i64,
    written: u64,
    suppressed: u64,
}
impl AccountHub {
    fn bucket(&mut self, key: &str, limit: &str, now: i64) -> Bucket {
        let rate = self.limits.cap(limit).map_or(f64::INFINITY, |n| n as f64);
        let bucket = self.buckets.entry(key.into()).or_insert(Bucket {
            rate,
            tokens: rate,
            at: now,
            refused: 0,
        });
        bucket.tokens = rate.min(bucket.tokens + (now - bucket.at) as f64 * rate / 60_000.0);
        bucket.at = now;
        bucket.clone()
    }
    pub(super) async fn spend(
        &mut self,
        id: &str,
        c: &Connection,
        method: &str,
        p: &Value,
        now: i64,
    ) -> Result<()> {
        let token = &c
            .grant
            .as_ref()
            .ok_or_else(|| Error::new("unauthorized", "missing grant"))?
            .token_id;
        if (method == "ack" && matches!(c.role.as_str(), "client" | "bridge"))
            || (method == "reject" && c.role == "bridge")
        {
            let cost = if method == "ack" {
                p["seqs"].as_array().map_or(1, |v| v.len().clamp(1, 100))
            } else {
                1
            } as f64;
            let key = format!("{token}:ack");
            let mut token = self.bucket(&key, "acksPerMinute", now);
            let mut account = self.bucket("account:ack", "accountAcksPerMinute", now);
            for (bucket, scope) in [(&token, "a token"), (&account, "an account")] {
                if bucket.tokens < cost {
                    return Err(Error::rate(
                        &format!("at most {} acked seqs per minute on {scope}", bucket.rate),
                        bucket.retry(cost),
                    ));
                }
            }
            token.tokens -= cost;
            account.tokens -= cost;
            self.buckets.insert(key, token);
            self.buckets.insert("account:ack".into(), account);
            return Ok(());
        }
        let bridge =
            c.role == "bridge" || (c.role.is_empty() && method == "hello" && p["bridge"] == true);
        let key = format!("{token}:{}", if bridge { "bridge" } else { "client" });
        let mut token = self.bucket(
            &key,
            if bridge {
                "bridgeCallsPerMinute"
            } else {
                "callsPerMinute"
            },
            now,
        );
        let mut account = self.bucket("account", "accountCallsPerMinute", now);
        if method == "event" {
            for bucket in [&token, &account] {
                if bucket.tokens < bucket.rate / 4.0 {
                    return Err(Error::rate(
                        "activity events wait while the token or the account is near its call limit",
                        bucket.retry(bucket.rate / 4.0),
                    ));
                }
            }
        }
        if token.tokens < 1.0 {
            token.refused = token.refused.saturating_add(1);
            let close = token.refused as f64 >= token.rate;
            let error = Error::rate(
                &format!(
                    "at most {} {}calls per minute on a token",
                    token.rate,
                    if bridge { "bridge " } else { "" }
                ),
                token.retry(1.0),
            );
            self.buckets.insert(key, token);
            if close {
                if let Some(socket) = &c.socket {
                    socket.close(1013, "rate limited");
                }
                self.closed(id, false).await;
            }
            return Err(error);
        }
        if account.tokens < 1.0 {
            return Err(Error::rate(
                &format!("at most {} calls per minute on an account", account.rate),
                account.retry(1.0),
            ));
        }
        token.tokens -= 1.0;
        token.refused = 0;
        account.tokens -= 1.0;
        self.buckets.insert(key, token);
        self.buckets.insert("account".into(), account);
        Ok(())
    }
    pub(super) async fn poll(
        &mut self,
        id: &str,
        method: &str,
        p: &Value,
    ) -> Result<super::xacct::Dispatch> {
        let c = self
            .connections
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("unauthorized", "this connection is closed"))?;
        self.refuse_denied(id, &c).await?;
        self.dispatch_inner(id, &c, method, p).await
    }
    pub(super) async fn refuse_denied(&mut self, id: &str, c: &Connection) -> Result<()> {
        if let Some(g) = &c.grant {
            let key = format!("denied:{}", g.token_id);
            if let Some(at) = self
                .store
                .state(&self.account_id, &key)
                .await?
                .and_then(|v| serde_json::from_str::<i64>(&v).ok())
            {
                let age = self
                    .limits
                    .duration("deniedS", 3600)
                    .saturating_mul(1000)
                    .min(i64::MAX as u64) as i64;
                if at > crate::now_ms().saturating_sub(age) {
                    self.kick(id, "the token was revoked", 1008).await;
                    return Err(Error::new("unauthorized", "the token was revoked"));
                }
                self.store.put_state(&self.account_id, &key, None).await?;
            }
        }
        Ok(())
    }
    pub(super) async fn kick(&mut self, id: &str, reason: &str, code: u16) {
        if let Some(socket) = self.connections.get(id).and_then(|c| c.socket.as_ref()) {
            socket.finish(Closure {
                code,
                reason: reason.into(),
                notification: Some(
                    json!({"jsonrpc":"2.0","method":"revoked","params":{"reason":reason}})
                        .to_string(),
                ),
            });
        }
        self.closed(id, false).await;
    }
    pub(super) async fn revalidated(
        &mut self,
        id: &str,
        result: scp_relay_store::Result<CredentialLookup>,
        now: i64,
    ) -> bool {
        let Some(c) = self.connections.get(id).cloned() else {
            return false;
        };
        let Some(g) = c.grant.as_ref() else {
            return false;
        };
        if g.expires_at <= now {
            self.kick(id, "the token grant expired, reconnect", 4001)
                .await;
            return false;
        }
        let key = format!("revalidate_error:{}", g.token_id);
        if result.is_err() {
            tracing::warn!("relay_revalidate_error");
            let persisted = self
                .store
                .state(&self.account_id, &key)
                .await
                .ok()
                .flatten()
                .and_then(|v| serde_json::from_str::<i64>(&v).ok());
            let since = *self
                .revalidation_errors
                .entry(g.token_id.clone())
                .or_insert(persisted.unwrap_or(now));
            let _ = self
                .store
                .put_state(&self.account_id, &key, Some(&json!(since).to_string()))
                .await;
            let grace = self
                .limits
                .duration("revalidateMs", 300_000)
                .min(i64::MAX as u64) as i64;
            if now.saturating_sub(since) >= grace {
                self.kick(id, "the token could not be revalidated, try again", 1013)
                    .await;
            }
            return true;
        }
        self.revalidation_errors.remove(&g.token_id);
        let _ = self.store.put_state(&self.account_id, &key, None).await;
        if matches!(result, Ok(CredentialLookup::Revoked)) {
            self.revoke(&g.token_id).await;
        }
        let valid = if let Ok(CredentialLookup::Active(identity)) = result {
            let fresh = crate::http::grant(&identity);
            fresh.user_id == g.user_id
                && fresh.actor_id == g.actor_id
                && fresh.scoped == g.scoped
                && fresh.role == g.role
                && fresh.labels == g.labels
        } else {
            false
        };
        if !valid {
            self.kick(id, "the token is no longer valid", 1008).await;
        }
        false
    }
    pub(super) fn endpoint_room(&self, rows: &[Endpoint]) -> Result<()> {
        if let Some(cap) = self.limits.cap("endpoints")
            && (rows
                .iter()
                .filter(|e| e.kind != "system" && !e.handle.starts_with("_gone_"))
                .count() as u64
                + u64::from(
                    !rows
                        .iter()
                        .any(|e| e.kind == "human" && e.machine.is_empty()),
                ))
                >= cap
        {
            return Err(Error::new(
                "too_large",
                &format!("at most {cap} endpoints on this relay"),
            ));
        }
        Ok(())
    }
    pub(super) async fn room(&self, body: &Value) -> Result<()> {
        if let (Some(body), Some(cap)) = (body.as_str(), self.limits.cap("storedBytes"))
            && self
                .store
                .stored_bytes(&self.account_id)
                .await?
                .saturating_add(body.len() as u64)
                > cap
        {
            return Err(Error::new(
                "too_large",
                &format!(
                    "the account relay holds its cap of {cap} bytes of message bodies; ack or let messages expire, or release a machine with swarm machines rm"
                ),
            ));
        }
        Ok(())
    }
    pub(super) async fn refusal(
        &mut self,
        endpoint: Option<&str>,
        reference: Option<&str>,
        mut detail: Value,
        now: i64,
    ) -> Result<()> {
        if let Some(cap) = self.limits.cap("refusalsPerMinute") {
            let budget = self
                .refusals
                .entry(string(&detail, "code").into())
                .or_default();
            let minute = now / 60_000;
            if minute != budget.minute {
                budget.minute = minute;
                budget.written = 0;
            }
            if budget.written >= cap {
                budget.suppressed = budget.suppressed.saturating_add(1);
                return Ok(());
            }
            budget.written += 1;
            if budget.suppressed > 0 {
                detail["suppressed"] = json!(budget.suppressed);
                budget.suppressed = 0;
            }
        }
        self.store
            .append_event(
                &self.account_id,
                EventLog::Audit,
                Event {
                    id: 0,
                    at: now,
                    kind: "refuse".into(),
                    endpoint: endpoint.map(str::to_owned),
                    reference: reference.map(str::to_owned),
                    detail: detail.to_string(),
                },
            )
            .await?;
        Ok(())
    }
}
