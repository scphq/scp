use super::*;
use scp_relay_store::{Idempotency, Message as StoredMessage, NewDelivery, PairEvent};
use validation::{cursor, no_secret, server_fields};

impl AccountHub {
    pub(super) async fn send_message(
        &mut self,
        c: &Connection,
        from: &str,
        p: &Value,
        floor: u64,
        notice: bool,
    ) -> Result<Value> {
        if !notice && let Err(error) = self.room(&p["body"]).await {
            self.refusal(
                Some(from),
                None,
                json!({"code":error.code}),
                crate::now_ms(),
            )
            .await?;
            return Err(error);
        }
        let result = self.send_inner(c, from, p, floor, notice).await;
        if let Err(error) = &result
            && matches!(
                error.code.as_str(),
                "loop_guard" | "rate_limited" | "inbox_full" | "secret_refused"
            )
        {
            self.refusal(
                Some(from),
                None,
                json!({"code":error.code}),
                crate::now_ms(),
            )
            .await?;
        }
        result
    }
    async fn send_inner(
        &mut self,
        c: &Connection,
        from: &str,
        p: &Value,
        floor: u64,
        notice: bool,
    ) -> Result<Value> {
        if !notice {
            server_fields(p)?;
        }
        let rows = self.endpoints().await?;
        let sender = rows
            .iter()
            .find(|e| e.id == from)
            .ok_or_else(|| Error::new("not_found", "no sender"))?;
        let body = p["body"]
            .as_str()
            .ok_or_else(|| invalid("body must be a string"))?;
        if body.len() > 65536 {
            return Err(Error::new("too_large", "body exceeds 65536 bytes"));
        }
        no_secret(body)?;
        let kind = match p.get("kind") {
            None => "message",
            Some(Value::String(s)) => s,
            _ => return Err(invalid("invalid message kind")),
        };
        if !matches!(kind, "message" | "request" | "reply" | "status") {
            return Err(invalid("invalid message kind"));
        }
        let data_class = match p.get("data_class") {
            None => "public",
            Some(Value::String(s)) => s,
            _ => return Err(invalid("invalid data_class")),
        };
        if !matches!(data_class, "public" | "private") {
            return Err(invalid("data_class must be public or private"));
        }
        for key in ["require_reply", "live"] {
            if p.get(key).is_some_and(|v| !v.is_boolean()) {
                return Err(invalid("invalid boolean"));
            }
        }
        if p["require_reply"] == true && kind != "request" {
            return Err(invalid("require_reply goes only on a request"));
        }
        let ttl = match p.get("ttl_s") {
            None => 604800,
            Some(v) => v
                .as_i64()
                .filter(|n| *n > 0 && *n <= 2592000)
                .ok_or_else(|| invalid("ttl_s must be 1 to 2592000"))?,
        };
        let mime = text(p.get("mime"), "mime", 64)?
            .as_str()
            .unwrap_or("text/markdown")
            .to_owned();
        let attachments = p.get("attachments").cloned().unwrap_or_else(|| json!([]));
        let a = attachments
            .as_array()
            .ok_or_else(|| invalid("attachments must be a list"))?;
        if a.len() > 16 {
            return Err(invalid("at most 16 attachments"));
        }
        for item in a {
            if item["kind"] != "path" || !string(item, "path").starts_with('/') {
                return Err(invalid("invalid attachment"));
            }
            no_secret(string(item, "path"))?;
        }
        let client_id = text(p.get("client_id"), "client_id", 128)?
            .as_str()
            .unwrap_or("")
            .to_owned();
        let now = crate::now_ms();
        let parent = if let Some(id) = p.get("reply_to") {
            let id = id
                .as_str()
                .ok_or_else(|| invalid("reply_to must be a message id"))?;
            let m = self
                .store
                .message(&self.account_id, id)
                .await?
                .ok_or_else(|| Error::new("not_found", "no message to reply to"))?;
            if !self
                .store
                .thread_member(&self.account_id, &m.thread, from)
                .await?
            {
                return Err(Error::new(
                    "not_found",
                    "message is not in this endpoint's threads",
                ));
            }
            Some(m)
        } else {
            None
        };
        let targets = if let Some(a) = p["to"].as_array() {
            a.clone()
        } else {
            vec![p["to"].clone()]
        };
        if targets.is_empty() || targets.len() > 16 {
            return Err(invalid("to takes 1 to 16 addresses"));
        }
        let mut recipients = Vec::new();
        for target in &targets {
            if target == "tree:children" || target.as_str().is_some_and(|s| s.starts_with("group:"))
            {
                return Err(Error::new("not_found", "fan-out is local to a broker"));
            } else {
                let e = self.resolve(target, &c.machine, &rows)?;
                let solicited = kind == "reply"
                    && parent
                        .as_ref()
                        .is_some_and(|m| m.from_ep == e.id && e.id != from)
                    && self
                        .store
                        .message_deliveries(
                            &self.account_id,
                            parent.as_ref().map_or("", |m| m.id.as_str()),
                        )
                        .await?
                        .iter()
                        .any(|d| d.endpoint == from);
                if !notice && !scope::allowed(sender, e, &rows, solicited, c.tty) {
                    return Err(Error::new("not_found", "no endpoint at address"));
                }
                recipients.push(e.clone());
            }
        }
        let mut unique = std::collections::HashSet::new();
        recipients.retain(|e| unique.insert(e.id.clone()));
        if recipients.len() > 64 {
            return Err(Error::new(
                "too_large",
                "send reaches more than 64 endpoints",
            ));
        }
        if p["live"] == true
            && recipients.iter().any(|e| {
                e.kind == "agent"
                    && (fields(e)["presence"] == "hibernated"
                        || (fields(e)["presence"] == "offline"
                            && e.last_seen.is_none_or(|at| now - at >= 10000)))
            })
        {
            return Err(Error::new(
                "not_live",
                "no live session holds the recipient",
            ));
        }
        let mut requested_thread = text(p.get("thread"), "thread", 64)?;
        if let Some(name) = requested_thread.as_str() {
            let messages = self
                .store
                .messages(&self.account_id, Some(name), 0, 1)
                .await?;
            if messages.is_empty() {
                let matches = self
                    .store
                    .member_messages(&self.account_id, from, name)
                    .await?;
                if matches.len() > 1 {
                    return Err(invalid("thread reference is ambiguous"));
                }
                if let Some(message) = matches.first() {
                    requested_thread = json!(message.thread);
                } else if name.starts_with("msg_") {
                    return Err(Error::new("not_found", "no thread to continue"));
                }
            }
        }
        let mut recipient_ids: Vec<_> = recipients.iter().map(|e| &e.id).collect();
        recipient_ids.sort();
        let payload = crate::hash(
            &json!([
                recipient_ids,
                body,
                kind,
                requested_thread,
                parent.as_ref().map(|m| &m.id),
                data_class,
                a.iter()
                    .map(|a| string(a, "path"))
                    .collect::<std::collections::BTreeSet<_>>(),
                mime,
                ttl,
                p["require_reply"] == true
            ])
            .to_string(),
        );
        if !client_id.is_empty()
            && let Some(seen) = self
                .store
                .idempotency(&self.account_id, from, &client_id)
                .await?
            && seen.created_at >= now - 86400000
        {
            if seen.payload_hash != payload {
                return Err(invalid(
                    "client_id was already used for a different message",
                ));
            }
            let mut result: Value = serde_json::from_str(&seen.result)
                .map_err(|_| Error::new("unavailable", "invalid stored result"))?;
            result["duplicate"] = json!(true);
            return Ok(result);
        }
        let sf = fields(sender);
        let causal = if sf["received_at"]
            .as_i64()
            .is_some_and(|at| at >= now - 120000)
        {
            sf["received_hop"].as_u64().unwrap_or(0) + 1
        } else {
            0
        };
        let parent_hop = parent
            .as_ref()
            .and_then(|m| serde_json::from_str::<Value>(&m.envelope).ok())
            .and_then(|v| v["hop"].as_u64())
            .map_or(0, |h| h + 1);
        let hop = floor.min(65).max(causal).max(parent_hop);
        if !notice && hop > 64 {
            return Err(Error::new(
                "loop_guard",
                "message exceeds the hop limit of 64",
            ));
        }
        let thread = parent
            .as_ref()
            .map(|m| m.thread.clone())
            .or_else(|| requested_thread.as_str().map(str::to_owned))
            .unwrap_or_else(|| validation::new_id("thr_"));
        if !notice
            && !self
                .store
                .messages(&self.account_id, Some(&thread), 0, 1)
                .await?
                .is_empty()
            && !self
                .store
                .thread_member(&self.account_id, &thread, from)
                .await?
        {
            return Err(Error::new("not_found", "no thread to continue"));
        }
        if !notice {
            self.send_guards(sender, &recipients, &thread, parent.as_ref(), kind, now)
                .await?;
        }
        let id = validation::new_id("msg_");
        let expires = now + ttl * 1000;
        let to = targets
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(",");
        let auth = if notice {
            "account"
        } else {
            sf["auth"].as_str().unwrap_or("account")
        };
        let mut claims = json!({"harness":sf["harness"],"model":sf["model"]});
        if sender.kind == "human" {
            claims["tty"] = json!(c.tty);
        }
        let mut envelope = json!({"id":id,"thread":thread,"reply_to":parent.as_ref().map(|m|&m.id),"kind":kind,"from":{"address":self.address(sender),"endpoint":from,"user":self.account_name(),"auth":auth,"claims":claims,"machine":sender.machine},"to":to,"body":{"text":body,"mime":mime},"data_class":data_class,"attachments":attachments,"hop":hop,"created_at":iso(now),"expires_at":iso(expires)});
        if sender.machine.is_empty()
            && let Some(from) = envelope["from"].as_object_mut()
        {
            from.remove("machine");
        }
        if sender.kind == "human" && !sender.machine.is_empty() && c.tty {
            envelope["from"]["human"] = json!(true);
        }
        if p["require_reply"] == true {
            envelope["require_reply"] = json!(true);
        }
        let mut result = json!({"id":id,"thread":thread,"hop":hop,"deliveries":recipients.iter().map(|e|{
            let f=fields(e);let presence=string(&f,"presence");let mut d=json!({"endpoint":e.id,"address":self.address(e),"offline":presence=="offline" && e.last_seen.is_none_or(|at|now-at>=10000),"last_seen":e.last_seen.map(iso)});
            if matches!(presence,"offline"|"hibernated"){d["queued"]=json!(true);}
                if presence=="hibernated"{d["hibernated"]=json!(true);}
                if presence=="idle"{d["idle"]=json!(true);}
                if !f["wake"].is_null(){d["wake"]=f["wake"].clone();}d
        }).collect::<Vec<_>>()});
        let warnings: Vec<_> = recipients
            .iter()
            .filter(|e| {
                e.kind == "agent"
                    && fields(e)["presence"] == "offline"
                    && e.last_seen.is_none_or(|at| now - at >= 10000)
            })
            .map(|e| format!("queued: no live session holds {}", self.address(e)))
            .collect();
        if !warnings.is_empty() {
            result["warnings"] = json!(warnings);
        }
        let idem = if client_id.is_empty() {
            None
        } else {
            Some(Idempotency {
                from_ep: from.into(),
                client_id,
                payload_hash: payload,
                result: result.to_string(),
                created_at: now,
            })
        };
        let mut changes = HubWrite::default();
        if !notice {
            for e in &recipients {
                changes.pairs.push((
                    PairEvent {
                        from_ep: from.into(),
                        to_ep: e.id.clone(),
                        at: now,
                    },
                    false,
                ));
            }
            changes
                .states
                .extend(self.ping_pong(sender, &recipients, now).await?);
            changes.events.push((scp_relay_store::EventLog::Audit,scp_relay_store::Event{id:0,at:now,kind:"send".into(),endpoint:Some(from.into()),reference:Some(id.clone()),detail:json!({"kind":kind,"hop":hop,"thread":thread,"to":recipients.iter().map(|e|self.address(e)).collect::<Vec<_>>(),"bytes":body.len(),"data_class":data_class}).to_string()}));
        }
        if let Some(parent) = &parent {
            for mut d in self
                .store
                .message_deliveries(&self.account_id, &parent.id)
                .await?
            {
                if d.endpoint == from && d.acked_at.is_none() {
                    d.acked_at = Some(now);
                    changes.deliveries.push(d);
                }
            }
        }
        let paused_pair = changes
            .states
            .iter()
            .any(|(key, _)| key.starts_with("pause:pair:"));
        let deliveries = self
            .store
            .route_message(
                &self.account_id,
                StoredMessage {
                    id: id.clone(),
                    thread: thread.clone(),
                    reply_to: parent.map(|m| m.id),
                    kind: kind.into(),
                    from_ep: from.into(),
                    to_addr: to,
                    created_at: now,
                    expires_at: expires,
                    envelope: envelope.to_string(),
                },
                recipients
                    .iter()
                    .map(|e| NewDelivery {
                        endpoint: e.id.clone(),
                        expires_at: expires,
                        state: "{}".into(),
                    })
                    .collect(),
                idem,
                changes,
            )
            .await?;
        if let Some(values) = result["deliveries"].as_array_mut() {
            for (v, d) in values.iter_mut().zip(&deliveries) {
                v["seq"] = json!(d.seq);
            }
        }
        self.push(&deliveries).await?;
        if paused_pair {
            self.post_notice(
                None,
                true,
                "relay paused a pair for 10 minutes because it went back and forth 100 times.",
                HubWrite::default(),
            )
            .await?;
        }
        self.fleet(json!({"type":"message","id":id,"thread":thread,"kind":kind,"from":self.address(sender),"to":recipients.iter().map(|e|self.address(e)).collect::<Vec<_>>()}));
        Ok(result)
    }
    pub(super) async fn inbox(&self, c: &Connection, p: &Value) -> Result<Value> {
        let after = cursor(p)?;
        let limit = match p.get("limit") {
            None => 100,
            Some(v) => v
                .as_u64()
                .filter(|v| *v > 0)
                .ok_or_else(|| invalid("limit must be positive"))?
                .min(100) as usize,
        };
        let deliveries = self
            .store
            .open_deliveries(&self.account_id, &c.endpoint, after, crate::now_ms(), limit)
            .await?;
        let mut messages = Vec::new();
        for d in deliveries.iter().take(limit) {
            messages.push(self.delivery_value(d, true).await?);
        }
        self.received(&c.endpoint, &messages).await?;
        Ok(
            json!({"next":messages.last().and_then(|v|v["seq"].as_i64()).unwrap_or(after),"messages":messages}),
        )
    }
    pub(super) async fn pending(
        &self,
        endpoint: &str,
        after: i64,
    ) -> Result<Vec<scp_relay_store::Delivery>> {
        let now = crate::now_ms();
        let mut cursor = after;
        let mut deliveries = Vec::new();
        loop {
            let page = self
                .store
                .open_deliveries(&self.account_id, endpoint, cursor, now, 200)
                .await?;
            let done = page.len() < 200;
            if let Some(last) = page.last() {
                cursor = last.seq;
            }
            deliveries.extend(page);
            if done {
                break;
            }
        }
        Ok(deliveries)
    }
    pub(super) async fn received(&self, endpoint: &str, messages: &[Value]) -> Result<()> {
        let Some(hop) = messages.iter().filter_map(|v| v["hop"].as_u64()).max() else {
            return Ok(());
        };
        let Some(mut e) = self
            .endpoints()
            .await?
            .into_iter()
            .find(|e| e.id == endpoint)
        else {
            return Ok(());
        };
        let now = crate::now_ms();
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
        self.store.put_endpoint(&self.account_id, e).await?;
        Ok(())
    }
}
