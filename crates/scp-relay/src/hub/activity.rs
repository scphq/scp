use super::*;
use scp_relay_store::{Event, EventLog, PairEvent};
use validation::pattern;

impl AccountHub {
    pub(super) async fn event(&self, e: &Endpoint, p: &Value) -> Result<Value> {
        let kind = string(p, "kind");
        if !matches!(
            kind,
            "session_start" | "tool" | "stop" | "note" | "session_end"
        ) {
            return Err(invalid("invalid activity kind"));
        }
        let clean = |key: &str, max| -> Result<Value> {
            let value = text(p.get(key), key, max)?;
            Ok(value
                .as_str()
                .map_or(Value::Null, |s| json!(validation::redact(s))))
        };
        let tool = clean("tool", 64)?;
        let agent = clean("agent", 64)?;
        let summary = clean("summary", 4096)?
            .as_str()
            .map(|s| s.chars().take(200).collect::<String>());
        let now = crate::now_ms();
        let mut row = json!({"at":iso(now),"kind":kind,"endpoint":self.address(e),"tool":tool,"agent":agent,"summary":summary});
        let id = self
            .store
            .append_event(
                &self.account_id,
                EventLog::Activity,
                Event {
                    id: 0,
                    at: now,
                    kind: kind.into(),
                    endpoint: Some(e.id.clone()),
                    reference: None,
                    detail: row.to_string(),
                },
            )
            .await?;
        row["id"] = json!(id);
        let mut fleet = row.clone();
        fleet["type"] = json!("activity");
        fleet["machine"] = json!(e.machine);
        self.fleet(fleet);
        Ok(row)
    }
    pub(super) async fn local_events(&self, c: &Connection, p: &Value) -> Result<Value> {
        let events = p["events"]
            .as_array()
            .filter(|a| a.len() <= 200)
            .ok_or_else(|| invalid("events must be a list of at most 200"))?;
        let rows = self.endpoints().await?;
        let now = crate::now_ms();
        let mut changes = HubWrite::default();
        let mut recorded = 0;
        for e in events {
            if !matches!(
                string(e, "kind"),
                "message" | "request" | "reply" | "status" | "handback" | "spawn"
            ) {
                continue;
            }
            let Some(at) = e["at"].as_f64().filter(|at| at.is_finite()) else {
                continue;
            };
            let at = at.clamp((now - 300000) as f64, now as f64) as i64;
            let Some(from) = rows
                .iter()
                .find(|r| r.machine == c.machine && r.handle == string(e, "from"))
            else {
                continue;
            };
            let Some(to) = e["to"].as_array().filter(|a| a.len() <= 64) else {
                continue;
            };
            let mut recipients = Vec::new();
            for t in to {
                if let Some(r) = rows.iter().find(|r| {
                    r.machine == c.machine
                        && Some(r.handle.as_str()) == t.as_str()
                        && r.id != from.id
                }) && !recipients.contains(&r.id)
                {
                    recipients.push(r.id.clone());
                    changes.pairs.push((
                        PairEvent {
                            from_ep: from.id.clone(),
                            to_ep: r.id.clone(),
                            at,
                        },
                        true,
                    ));
                }
            }
            if recipients.is_empty() {
                continue;
            }
            recorded += 1;
            let mut event = json!({"type":"message","machine":c.machine,"local":true,"kind":e["kind"],"from":self.address(from),"to":rows.iter().filter(|r|recipients.contains(&r.id)).map(|r|self.address(r)).collect::<Vec<_>>()});
            for key in ["id", "thread"] {
                if e[key]
                    .as_str()
                    .is_some_and(|s| pattern!(r"^[0-9a-f]{8,64}$", s))
                {
                    event[key] = e[key].clone();
                }
            }
            self.fleet(event);
        }
        self.store.hub_write(&self.account_id, changes).await?;
        Ok(json!({"recorded":recorded}))
    }
}
pub(super) fn event_view(e: &Event) -> Value {
    json!({"id":e.id,"at":iso(e.at),"event":e.kind,"endpoint":e.endpoint,"ref":e.reference,"detail":serde_json::from_str::<Value>(&e.detail).unwrap_or(Value::Null)})
}

pub(super) fn activity_view(e: &Event) -> Value {
    let mut row: Value = serde_json::from_str(&e.detail).unwrap_or_else(|_| json!({}));
    row["id"] = json!(e.id);
    row["at"] = json!(iso(e.at));
    row["kind"] = json!(e.kind);
    row
}
