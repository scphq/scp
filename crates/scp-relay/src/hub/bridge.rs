use super::*;
use validation::cursor;

impl AccountHub {
    pub(super) async fn bridge_method(
        &mut self,
        id: &str,
        c: &Connection,
        method: &str,
        p: &Value,
    ) -> Result<Value> {
        match method {
            "mirror" => self.mirror(c, p).await,
            "forward" => {
                let from = p["from"]
                    .as_str()
                    .filter(|s| !s.contains('/'))
                    .ok_or_else(|| invalid("from is a handle on the bridge's own machine"))?;
                let rows = self.endpoints().await?;
                let sender = rows
                    .iter()
                    .find(|e| e.machine == c.machine && e.handle == from)
                    .ok_or_else(|| Error::new("not_found", "no mirrored sender"))?;
                let mut params = p.get("params").cloned().unwrap_or_else(|| json!({}));
                if !params.is_object() {
                    return Err(invalid("params must be an object"));
                }
                if let Some(map) = params.as_object_mut() {
                    map.remove("attachments");
                    map.remove("wait_s");
                }
                let hop = match p.get("hop_floor") {
                    None => 0,
                    Some(v) => v
                        .as_u64()
                        .filter(|n| *n <= 1000)
                        .ok_or_else(|| invalid("hop_floor is a hop count"))?,
                };
                if hop > 0 {
                    self.received(&sender.id, &[json!({"hop":hop.min(65)-1})])
                        .await?;
                }
                let mut origin = c.clone();
                origin.tty = p["tty"] == true;
                self.send_message(&origin, &sender.id, &params, hop, false)
                    .await
            }
            "subscribe" => {
                let after = cursor(p)?;
                if let Some(conn) = self.connections.get_mut(id) {
                    conn.subscribed = true;
                }
                let mut replayed = 0;
                let mut cursor = 0;
                loop {
                    let page = self
                        .store
                        .pending_machine_x(
                            &self.account_id,
                            &c.machine,
                            cursor.max(after),
                            cursor,
                            crate::now_ms(),
                            200,
                        )
                        .await?;
                    self.push_with_capacity(&page, true).await?;
                    replayed += page.len();
                    if let Some(d) = page.last() {
                        cursor = d.seq;
                    }
                    if page.len() < 200 {
                        break;
                    }
                }
                Ok(json!({"replayed":replayed,"next":cursor.max(after)}))
            }
            "ack" => self.ack(c, p).await,
            "reject" => self.reject(c, p).await,
            "event" => {
                let sender = self
                    .endpoints()
                    .await?
                    .into_iter()
                    .find(|e| e.machine == c.machine && e.handle == string(p, "from"))
                    .ok_or_else(|| Error::new("not_found", "no mirrored sender"))?;
                self.event(&sender, p).await
            }
            "local_events" => self.local_events(c, p).await,
            "list" | "watch" => self.client_method(id, c, method, p).await,
            "machine_wake" => {
                let url = p.get("url").filter(|v| !v.is_null());
                let key = format!("wake:{}", c.machine);
                if let Some(url) = url {
                    let url = url
                        .as_str()
                        .ok_or_else(|| invalid("url must be a string"))?;
                    let parsed =
                        axum::http::Uri::try_from(url).map_err(|_| invalid("invalid wake URL"))?;
                    let host = parsed.host().unwrap_or("");
                    if url.len() > 2048
                        || url.contains('@')
                        || !(parsed.scheme_str() == Some("https")
                            || (parsed.scheme_str() == Some("http")
                                && matches!(host, "localhost" | "127.0.0.1" | "[::1]")))
                    {
                        return Err(invalid("url must be https or loopback http"));
                    }
                    let secret = p["secret"]
                        .as_str()
                        .filter(|s| (16..=256).contains(&s.chars().count()))
                        .ok_or_else(|| invalid("secret is 16 to 256 characters"))?;
                    self.store
                        .put_state(
                            &self.account_id,
                            &key,
                            Some(&json!({"url":url,"secret":secret}).to_string()),
                        )
                        .await?;
                } else {
                    self.store.put_state(&self.account_id, &key, None).await?;
                }
                Ok(json!({"set":url.is_some()}))
            }
            _ => Err(Error::new("method_not_found", "no method on a bridge")),
        }
    }
}
