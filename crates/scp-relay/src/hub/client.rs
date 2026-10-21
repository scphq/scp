use super::activity::{activity_view, event_view};
use super::*;
use scp_relay_store::EventLog;
use validation::no_secret;

impl AccountHub {
    pub(super) async fn client_method(
        &mut self,
        id: &str,
        c: &Connection,
        method: &str,
        p: &Value,
    ) -> Result<Value> {
        match method {
            "list" => {
                if p["contacts"] == true {
                    return Ok(json!({"contacts":[]}));
                }
                let mut rows = self.endpoints().await?;
                rows.retain(|e| {
                    let f = fields(e);
                    e.kind != "system"
                        && (p["all"] == true
                            || string(&f, "presence") != "offline"
                            || e.last_seen
                                .is_some_and(|at| at > crate::now_ms() - 86400000))
                        && p.get("kind").is_none_or(|v| v == &e.kind)
                        && p.get("harness").is_none_or(|v| v == &f["harness"])
                        && p.get("machine").is_none_or(|v| v == &e.machine)
                        && p.get("presence").is_none_or(|v| v == &f["presence"])
                });
                Ok(json!({"endpoints":rows.iter().map(|e|self.view(e)).collect::<Vec<_>>()}))
            }
            "snapshot" | "watch" => {
                if method == "watch"
                    && let Some(c) = self.connections.get_mut(id)
                {
                    c.watching = true;
                }
                let rows = self.endpoints().await?;
                let mut unread = json!({});
                for e in rows.iter().filter(|e| e.kind != "system") {
                    let count = self
                        .store
                        .open_delivery_count(&self.account_id, &e.id, crate::now_ms())
                        .await?;
                    if count > 0 {
                        unread[self.address(e)] = json!(count);
                    }
                }
                let endpoints = rows
                    .iter()
                    .filter(|e| {
                        e.kind != "system"
                            && (p["all"] == true
                                || e.kind == "human"
                                || fields(e)["presence"] != "offline"
                                || e.last_seen
                                    .is_some_and(|at| at > crate::now_ms() - 86400000))
                    })
                    .map(|e| self.view(e))
                    .collect::<Vec<_>>();
                let activity = self
                    .store
                    .events(&self.account_id, EventLog::Activity, 0)
                    .await?;
                let limit = p["activity"].as_u64().unwrap_or(20).min(1000) as usize;
                let mut activity: Vec<_> = activity
                    .iter()
                    .rev()
                    .take(limit)
                    .map(|event| {
                        let mut value = activity_view(event);
                        if let Some(endpoint) =
                            rows.iter().find(|e| Some(&e.id) == event.endpoint.as_ref())
                        {
                            value["endpoint"] = json!(self.address(endpoint));
                        }
                        value
                    })
                    .collect();
                activity.reverse();
                Ok(json!({"endpoints":endpoints,"activity":activity,"unread":unread}))
            }
            "log" => {
                let since = p["since"].as_i64().unwrap_or(0).max(0);
                let mut rows = self
                    .store
                    .events(&self.account_id, EventLog::Audit, since)
                    .await?;
                let limit = p["limit"].as_u64().unwrap_or(100).clamp(1, 1000) as usize;
                if since == 0 {
                    rows = rows.into_iter().rev().take(limit).collect();
                    rows.reverse();
                } else {
                    rows.truncate(limit);
                }
                let endpoints = self.endpoints().await?;
                let rows: Vec<_> = rows
                    .iter()
                    .map(|event| {
                        let mut value = event_view(event);
                        if let Some(endpoint) = endpoints
                            .iter()
                            .find(|e| Some(&e.id) == event.endpoint.as_ref())
                        {
                            value["endpoint"] = json!(self.address(endpoint));
                        }
                        value
                    })
                    .collect();
                Ok(json!({"rows":rows}))
            }
            "machines" => self.machines().await,
            "machines_rm" => self.remove_machine(id, c, p).await,
            _ => {
                if c.endpoint.is_empty() {
                    return Err(Error::new(
                        if c.role == "observer"
                            && matches!(
                                method,
                                "whoami"
                                    | "send"
                                    | "ask"
                                    | "ask_wait"
                                    | "inbox"
                                    | "ack"
                                    | "status"
                                    | "event"
                            )
                        {
                            "unauthorized"
                        } else {
                            "method_not_found"
                        },
                        "this connection has no endpoint",
                    ));
                }
                let mut e = self
                    .endpoints()
                    .await?
                    .into_iter()
                    .find(|e| e.id == c.endpoint)
                    .ok_or_else(|| Error::new("unauthorized", "endpoint released"))?;
                match method {
                    "whoami" => Ok(self.view(&e)),
                    "send" | "ask" => {
                        let mut send = p.clone();
                        if method == "ask" {
                            send["kind"] = json!("request");
                        }
                        self.send_message(c, &c.endpoint, &send, 0, false).await
                    }
                    "inbox" => self.inbox(c, p).await,
                    "ask_wait" => {
                        let request = p["id"]
                            .as_str()
                            .ok_or_else(|| invalid("id is the request's message id"))?;
                        let stored = self
                            .store
                            .message(&self.account_id, request)
                            .await?
                            .filter(|m| m.from_ep == c.endpoint)
                            .ok_or_else(|| Error::new("not_found", "no request"))?;
                        if let Some(d) = self
                            .store
                            .reply_delivery(&self.account_id, &c.endpoint, request, crate::now_ms())
                            .await?
                        {
                            let reply = self.delivery_value(&d, true).await?;
                            self.received(&c.endpoint, std::slice::from_ref(&reply))
                                .await?;
                            return Ok(json!({"id":request,"reply":reply}));
                        }
                        Ok(if stored.expires_at <= crate::now_ms() {
                            json!({"id":request,"expired":true})
                        } else {
                            json!({"id":request,"pending":true})
                        })
                    }
                    "ack" => self.ack(c, p).await,
                    "status" => {
                        if !matches!(
                            string(p, "state"),
                            "working" | "waiting" | "blocked" | "done"
                        ) {
                            return Err(invalid("invalid status state"));
                        }
                        let note = text(p.get("note"), "note", 280)?
                            .as_str()
                            .unwrap_or("")
                            .to_owned();
                        no_secret(&note)?;
                        let mut f = fields(&e);
                        f["status"] = json!({"state":p["state"],"note":note});
                        e.fields = f.to_string();
                        self.store.put_endpoint(&self.account_id, e.clone()).await?;
                        let view = self.view(&e);
                        self.announce(&e.machine, vec![view.clone()], false, false)
                            .await?;
                        self.fleet(json!({"type":"status","machine":e.machine,"endpoint":self.address(&e),"status":view["status"]}));
                        Ok(view)
                    }
                    "event" => self.event(&e, p).await,
                    _ => Err(Error::new("method_not_found", "no method")),
                }
            }
        }
    }
}
