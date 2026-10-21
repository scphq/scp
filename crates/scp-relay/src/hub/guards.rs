use super::*;
use scp_relay_store::Message as StoredMessage;
fn pair_key(a: &str, b: &str) -> String {
    let mut ids = [a, b];
    ids.sort();
    format!("pause:pair:{}", crate::hash(&json!(ids).to_string()))
}
fn tree_key(e: &Endpoint) -> String {
    format!(
        "pause:tree:{}",
        crate::hash(&format!(
            "{}/{}",
            e.machine,
            fields(e)["tree"].as_str().unwrap_or(&e.id)
        ))
    )
}
impl AccountHub {
    async fn paused(&self, key: &str, now: i64) -> Result<Option<i64>> {
        Ok(self
            .store
            .state(&self.account_id, key)
            .await?
            .and_then(|v| serde_json::from_str::<i64>(&v).ok())
            .filter(|at| *at > now)
            .map(|at| (at - now + 999) / 1000))
    }
    pub(super) async fn send_guards(
        &mut self,
        sender: &Endpoint,
        recipients: &[Endpoint],
        thread: &str,
        parent: Option<&StoredMessage>,
        kind: &str,
        now: i64,
    ) -> Result<()> {
        let history = self
            .store
            .messages(&self.account_id, Some(thread), 0, 201)
            .await?;
        if history.len() >= 200 {
            return Err(Error::new("loop_guard", "thread reached 200 messages"));
        }
        if self
            .store
            .sent_count(&self.account_id, now - 86400000)
            .await?
            >= 2000
        {
            return Err(Error::rate("daily message limit", 3600));
        }
        let received_parent = if let Some(parent) = parent {
            self.store
                .message_deliveries(&self.account_id, &parent.id)
                .await?
                .iter()
                .any(|d| d.endpoint == sender.id)
        } else {
            false
        };
        let all = self
            .store
            .pairs(&self.account_id, None, None, now - 3600000, false)
            .await?;
        for e in recipients {
            if let Some(retry) = self.paused(&pair_key(&sender.id, &e.id), now).await? {
                return Err(Error {
                    code: "loop_guard".into(),
                    message: "messages between this pair are paused".into(),
                    retry: Some(retry),
                });
            }
            for (limit, seconds, both) in [(20, 10, true), (30, 60, false), (300, 3600, false)] {
                let events: Vec<_> = all
                    .iter()
                    .filter(|p| {
                        p.at > now - seconds * 1000
                            && ((p.from_ep == sender.id && p.to_ep == e.id)
                                || (both && p.from_ep == e.id && p.to_ep == sender.id))
                    })
                    .collect();
                if events.len() >= limit {
                    return Err(Error::rate(
                        "pair rate limit",
                        events
                            .first()
                            .map_or(1, |p| (p.at + seconds * 1000 - now + 999) / 1000),
                    ));
                }
            }
            let first_reply = kind == "reply"
                && received_parent
                && parent.is_some_and(|m| m.from_ep == e.id)
                && !history.iter().any(|m| {
                    m.reply_to.as_deref() == parent.map(|m| m.id.as_str())
                        && m.from_ep == sender.id
                        && m.kind == "reply"
                });
            if !first_reply
                && self
                    .store
                    .open_delivery_count(&self.account_id, &e.id, now)
                    .await?
                    >= 1000
            {
                return Err(Error::new(
                    "inbox_full",
                    "recipient has 1000 unread messages",
                ));
            }
        }
        let sends = recipients.iter().filter(|e| e.kind != "human").count();
        if sender.kind == "agent" && sends > 0 {
            let key = tree_key(sender);
            if let Some(retry) = self.paused(&key, now).await? {
                return Err(Error {
                    code: "loop_guard".into(),
                    message: "this tree is paused".into(),
                    retry: Some(retry),
                });
            }
            let rows = self.endpoints().await?;
            let root = fields(sender)["tree"]
                .as_str()
                .unwrap_or(&sender.handle)
                .to_owned();
            let members: Vec<_> = rows
                .iter()
                .filter(|e| {
                    e.machine == sender.machine
                        && fields(e)["tree"].as_str().unwrap_or(&e.handle) == root
                })
                .map(|e| e.id.as_str())
                .collect();
            for (limit, seconds) in [(120, 60), (1200, 3600)] {
                let count = all
                    .iter()
                    .filter(|p| {
                        p.at > now - seconds * 1000
                            && members.contains(&p.from_ep.as_str())
                            && rows.iter().any(|e| e.id == p.to_ep && e.kind != "human")
                    })
                    .count();
                if count + sends > limit {
                    let change = HubWrite {
                        states: vec![(key, Some(json!(now + 600000).to_string()))],
                        ..HubWrite::default()
                    };
                    let root = rows
                        .iter()
                        .find(|e| e.machine == sender.machine && e.handle == root)
                        .cloned();
                    self.post_notice(root.as_ref(),true,"relay paused this tree for 10 minutes because it sent too many messages. Messages to the human still pass.",change).await?;
                    return Err(Error {
                        code: "loop_guard".into(),
                        message: "tree rate limit".into(),
                        retry: Some(600),
                    });
                }
            }
        }
        Ok(())
    }
    pub(super) async fn ping_pong(
        &self,
        sender: &Endpoint,
        recipients: &[Endpoint],
        now: i64,
    ) -> Result<Vec<(String, Option<String>)>> {
        let all = self
            .store
            .pairs(&self.account_id, None, None, now - 600000, false)
            .await?;
        let mut changes = Vec::new();
        for e in recipients.iter().filter(|e| e.id != sender.id) {
            let mut senders: Vec<_> = all
                .iter()
                .filter(|p| {
                    (p.from_ep == sender.id && p.to_ep == e.id)
                        || (p.from_ep == e.id && p.to_ep == sender.id)
                })
                .map(|p| p.from_ep.as_str())
                .collect();
            senders.push(&sender.id);
            let alternations = senders.windows(2).filter(|w| w.first() != w.get(1)).count();
            if alternations >= 100 {
                changes.push((
                    pair_key(&sender.id, &e.id),
                    Some(json!(now + 600000).to_string()),
                ));
            }
        }
        Ok(changes)
    }
    pub(super) async fn post_notice(
        &self,
        to: Option<&Endpoint>,
        include_human: bool,
        body: &str,
        mut changes: HubWrite,
    ) -> Result<()> {
        let now = crate::now_ms();
        let rows = self.endpoints().await?;
        let human = rows
            .iter()
            .find(|e| e.kind == "human" && e.machine.is_empty())
            .cloned()
            .unwrap_or(Endpoint {
                id: "human".into(),
                machine: "".into(),
                handle: "".into(),
                kind: "human".into(),
                token_hash: None,
                last_seen: None,
                created_at: now,
                fields: json!({"presence":"offline","harness":null,"model":null,"labels":{}})
                    .to_string(),
            });
        let system = Endpoint {
            id: "system".into(),
            machine: "".into(),
            handle: "relay".into(),
            kind: "system".into(),
            token_hash: None,
            last_seen: None,
            created_at: now,
            fields: json!({"presence":"online","harness":null,"model":null,"labels":{}})
                .to_string(),
        };
        changes.endpoints.push(system);
        if !rows.iter().any(|e| e.id == human.id) {
            changes.endpoints.push(human.clone());
        }
        let mut recipients = if include_human {
            vec![human]
        } else {
            Vec::new()
        };
        if let Some(to) = to
            && !recipients.iter().any(|e| e.id == to.id)
        {
            recipients.push(to.clone());
        }
        let id = validation::new_id("msg_");
        let thread = validation::new_id("thr_");
        let expiry = now + 604800000;
        let envelope = json!({"id":id,"thread":thread,"reply_to":null,"kind":"status","from":{"address":format!("{}/relay",self.account_name()),"user":self.account_name(),"endpoint":"system","auth":"account","claims":{"harness":null,"model":null}},"to":recipients.iter().map(|e|self.address(e)).collect::<Vec<_>>().join(","),"body":{"text":body,"mime":"text/markdown"},"data_class":"public","attachments":[],"hop":0,"created_at":iso(now),"expires_at":iso(expiry)});
        let deliveries = self
            .store
            .route_message(
                &self.account_id,
                StoredMessage {
                    id,
                    thread,
                    reply_to: None,
                    kind: "status".into(),
                    from_ep: "system".into(),
                    to_addr: string(&envelope, "to").into(),
                    created_at: now,
                    expires_at: expiry,
                    envelope: envelope.to_string(),
                },
                recipients
                    .iter()
                    .map(|e| scp_relay_store::NewDelivery {
                        endpoint: e.id.clone(),
                        expires_at: expiry,
                        state: "{}".into(),
                    })
                    .collect(),
                None,
                changes,
            )
            .await?;
        self.push(&deliveries).await?;
        Ok(())
    }
}
