use super::*;
use hmac::{Hmac, Mac};
use scp_relay_store::{Event, EventLog};
use sha2::Sha256;
use std::collections::HashSet;

const HOUR_MS: i64 = 3_600_000;
const MIN_RETRY_MS: i64 = 60_000;

/// Machine waker policy. Infinity disables caps or makes a decline indefinite.
#[derive(Clone, Debug)]
pub struct WakeOptions {
    pub(super) cross_account: bool,
    sender_account_per_hour: f64,
    target_per_hour: f64,
    debounce_s: f64,
    backoff_max_s: f64,
    waking_timeout_s: Option<f64>,
    decline_hold_s: f64,
}
impl Default for WakeOptions {
    fn default() -> Self {
        Self {
            cross_account: false,
            sender_account_per_hour: 6.0,
            target_per_hour: 12.0,
            debounce_s: 60.0,
            backoff_max_s: 900.0,
            waking_timeout_s: None,
            decline_hold_s: f64::INFINITY,
        }
    }
}
impl WakeOptions {
    /// Apply a key=value override, rejecting unknown keys and invalid values.
    pub fn apply(&mut self, raw: &str) -> std::result::Result<(), String> {
        let (key, value) = raw.split_once('=').ok_or("wake must be key=value")?;
        if key == "crossAccount" {
            self.cross_account = match value {
                "true" => true,
                "false" => false,
                _ => return Err("crossAccount must be true or false".into()),
            };
            return Ok(());
        }
        let capped = matches!(
            key,
            "senderAccountPerHour" | "targetPerHour" | "declineHoldS"
        );
        let n = if value == "Infinity" && capped {
            f64::INFINITY
        } else {
            value.parse::<f64>().map_err(|_| "invalid wake value")?
        };
        if n.is_nan()
            || n < 0.0
            || (!capped && (!n.is_finite() || n == 0.0))
            || (n.is_infinite() && value != "Infinity")
        {
            return Err("wake durations must be finite and positive; caps and declineHoldS may be nonnegative or Infinity".into());
        }
        let slot = match key {
            "senderAccountPerHour" => &mut self.sender_account_per_hour,
            "targetPerHour" => &mut self.target_per_hour,
            "debounceS" => &mut self.debounce_s,
            "backoffMaxS" => &mut self.backoff_max_s,
            "wakingTimeoutS" => self.waking_timeout_s.get_or_insert(self.debounce_s),
            "declineHoldS" => &mut self.decline_hold_s,
            _ => return Err(format!("unknown wake option: {key}")),
        };
        *slot = n;
        Ok(())
    }
    fn retry_ms(&self) -> i64 {
        ((self.debounce_s * 1000.0).ceil() as i64).max(MIN_RETRY_MS)
    }
}
fn after(now: i64, seconds: f64) -> i64 {
    now.saturating_add((seconds * 1000.0).ceil() as i64)
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct WakeState {
    next: i64,
    fails: u32,
    call: Option<String>,
    declined: Option<Decline>,
    retry_at: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Decline {
    reason: String,
    message: String,
    from: String,
    until: Option<i64>,
}
#[derive(Serialize, Deserialize)]
struct Count {
    n: u64,
    since: i64,
}
struct WakeCall {
    machine: String,
    recipient: String,
    id: String,
    now: i64,
    scheduled: i64,
    fails: u32,
    held: Option<Decline>,
    message: String,
    from: String,
}
struct Outcome {
    ok: bool,
    status: Option<u16>,
    error: Option<&'static str>,
    declined: Option<String>,
}
fn wake_key(machine: &str) -> String {
    format!("wake_state:{machine}")
}
pub(super) fn wake_url(value: &str) -> bool {
    if value.encode_utf16().count() > 2048 {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
}
impl AccountHub {
    async fn wake_state(&self, machine: &str) -> Result<Option<WakeState>> {
        self.store
            .state(&self.account_id, &wake_key(machine))
            .await?
            .map(|s| {
                serde_json::from_str(&s)
                    .map_err(|_| Error::new("unavailable", "invalid wake state"))
            })
            .transpose()
    }
    async fn set_wake_state(&self, machine: &str, state: &WakeState) -> Result<()> {
        self.store
            .put_state(
                &self.account_id,
                &wake_key(machine),
                Some(&json!(state).to_string()),
            )
            .await?;
        Ok(())
    }
    async fn wake_audit(&self, machine: &str, kind: &str, detail: Value) -> Result<()> {
        self.store
            .hub_write(
                &self.account_id,
                HubWrite {
                    events: vec![(
                        EventLog::Audit,
                        Event {
                            id: 0,
                            at: crate::now_ms(),
                            kind: kind.into(),
                            endpoint: None,
                            reference: Some(machine.into()),
                            detail: detail.to_string(),
                        },
                    )],
                    ..HubWrite::default()
                },
            )
            .await?;
        Ok(())
    }
    pub(super) async fn set_machine_wake(&self, machine: &str, p: &Value) -> Result<Value> {
        let url = p.get("url").filter(|v| !v.is_null());
        let registration = if let Some(url) = url {
            let url = url.as_str().filter(|s| wake_url(s)).ok_or_else(|| {
                invalid(
                    "url is https or loopback http, without credentials, at most 2048 characters",
                )
            })?;
            let secret = p["secret"]
                .as_str()
                .filter(|s| (16..=256).contains(&s.encode_utf16().count()))
                .ok_or_else(|| invalid("secret is 16 to 256 characters"))?;
            Some(json!({"url":url,"secret":secret}).to_string())
        } else {
            None
        };
        self.store
            .put_state(
                &self.account_id,
                &format!("wake:{machine}"),
                registration.as_deref(),
            )
            .await?;
        self.forget_wake_hold(Some(machine)).await?;
        self.wake_audit(
            machine,
            "machine_wake_set",
            json!({"machine":machine,"set":url.is_some()}),
        )
        .await?;
        Ok(json!({"set":url.is_some()}))
    }
    pub(super) async fn forget_wake_hold(&self, machine: Option<&str>) -> Result<Vec<String>> {
        let mut cleared = Vec::new();
        let mut changes = HubWrite::default();
        for m in self.store.machines(&self.account_id).await? {
            if machine.is_none_or(|name| name == m.name)
                && self.wake_state(&m.name).await?.is_some()
            {
                changes.states.push((wake_key(&m.name), None));
                cleared.push(m.name);
            }
        }
        let mut ended = Vec::new();
        for mut e in self.endpoints().await? {
            let mut f = fields(&e);
            if machine.is_none_or(|name| name == e.machine) && f["waking_until"].is_number() {
                f.as_object_mut().unwrap().remove("waking_until");
                e.fields = f.to_string();
                if e.token_hash.is_none() && f["presence"] == "hibernated" {
                    ended.push(e.clone());
                }
                changes.endpoints.push(e);
            }
        }
        self.store.hub_write(&self.account_id, changes).await?;
        for e in ended {
            self.wake_presence(&e, false);
        }
        Ok(cleared)
    }
    fn wake_presence(&self, e: &Endpoint, waking: bool) {
        self.fleet(json!({"type":"presence","machine":e.machine,"endpoint":self.address(e),"presence":"hibernated","waking":waking}));
    }
    async fn wake_target(
        &self,
        machine: &str,
        recipient: &str,
        message: &Value,
        now: i64,
    ) -> Result<Option<Endpoint>> {
        if let Some(d) = self.wake_state(machine).await?.and_then(|s| s.declined)
            && d.until.is_none_or(|at| at > now)
            && (message["id"] == d.message || message["from"]["address"] == d.from)
        {
            return Ok(None);
        }
        Ok(self.endpoints().await?.into_iter().find(|e| {
            let f = fields(e);
            e.id == recipient
                && e.machine == machine
                && e.token_hash.is_none()
                && f["presence"] == "hibernated"
                && f["waking_until"].as_i64().is_none_or(|at| at <= now)
        }))
    }
    async fn wake_counts(&self, now: i64) -> Result<BTreeMap<String, Count>> {
        let raw = self.store.state(&self.account_id, "wake_limits").await?;
        let mut counts: BTreeMap<String, Count> = raw
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|_| Error::new("unavailable", "invalid wake limits"))?
            .unwrap_or_default();
        counts.retain(|_, c| now.saturating_sub(c.since) < HOUR_MS);
        Ok(counts)
    }
    async fn wake_admitted(
        &self,
        sender: &str,
        recipient: &str,
        now: i64,
        seq: i64,
    ) -> Result<Option<i64>> {
        let mut counts = self.wake_counts(now).await?;
        let sender_key = format!("account:{sender}");
        let seq_key = format!("seq:{seq}");
        let counted = counts
            .get(&sender_key)
            .is_some_and(|c| c.n > 0 && counts.get(&seq_key).is_some_and(|s| s.since == c.since));
        let caps = [
            (
                sender_key.clone(),
                self.wake_options.sender_account_per_hour,
            ),
            (
                format!("endpoint:{recipient}"),
                self.wake_options.target_per_hour,
            ),
        ];
        let charged: Vec<_> = caps
            .into_iter()
            .filter(|(key, cap)| cap.is_finite() && !(counted && key == &sender_key))
            .collect();
        let mut reset = None;
        for (key, cap) in &charged {
            let (n, since) = counts.get(key).map_or((0, now), |c| (c.n, c.since));
            if n as f64 >= *cap {
                let at = if *cap > 0.0 && n > 0 {
                    since.saturating_add(HOUR_MS)
                } else {
                    i64::MAX
                };
                reset = Some(reset.map_or(at, |old: i64| old.max(at)));
            }
        }
        if reset.is_some() {
            return Ok(reset);
        }
        for (key, _) in charged {
            let count = counts.entry(key).or_insert(Count { n: 0, since: now });
            count.n = count.n.saturating_add(1);
        }
        if !counted
            && self.wake_options.sender_account_per_hour.is_finite()
            && let Some(c) = counts.get(&sender_key)
        {
            let since = c.since;
            counts.insert(seq_key, Count { n: 1, since });
        }
        self.store
            .put_state(
                &self.account_id,
                "wake_limits",
                Some(&json!(counts).to_string()),
            )
            .await?;
        Ok(None)
    }
    async fn retry_wake(&self, machine: &str, at: i64) -> Result<()> {
        if at == i64::MAX {
            return Ok(());
        }
        let mut state = self.wake_state(machine).await?.unwrap_or_default();
        state.retry_at = Some(at);
        self.set_wake_state(machine, &state).await
    }
    pub(super) async fn machine_wake(
        &self,
        machine: &str,
        recipient: &str,
        message: &Value,
        sender: Option<(&str, i64)>,
    ) -> Result<bool> {
        let now = crate::now_ms();
        let state = self.wake_state(machine).await?.unwrap_or_default();
        if state.next > now {
            return Ok(false);
        }
        let Some(target) = self.wake_target(machine, recipient, message, now).await? else {
            return Ok(false);
        };
        let Some(raw) = self
            .store
            .state(&self.account_id, &format!("wake:{machine}"))
            .await?
        else {
            return Ok(false);
        };
        let waker: Value = serde_json::from_str(&raw)
            .map_err(|_| Error::new("unavailable", "invalid machine waker"))?;
        if let Some((sender, seq)) = sender {
            if !self.wake_options.cross_account {
                return Ok(false);
            }
            if let Some(reset) = self.wake_admitted(sender, recipient, now, seq).await? {
                self.retry_wake(machine, reset).await?;
                return Ok(false);
            }
        }
        let scheduled = after(now, self.wake_options.debounce_s);
        let id = crate::random("wake_");
        let held = state.declined.filter(|d| d.until.is_none_or(|at| at > now));
        self.set_wake_state(
            machine,
            &WakeState {
                next: scheduled,
                fails: state.fails,
                call: Some(id.clone()),
                declined: held.clone(),
                retry_at: state.retry_at,
            },
        )
        .await?;
        let from_account = message["from"]["account"].as_str().unwrap_or(&self.handle);
        let address = self.address(&target);
        let event = json!({"scp":1,"event":"machine_wake","account":self.handle,"machine":machine,"endpoints":[address],"message":{"id":message["id"],"from":message["from"]["address"],"kind":message["kind"],"thread":message["thread"],"created_at":message["created_at"]},"from_account":from_account,"same_account":from_account==self.handle});
        let call = WakeCall {
            machine: machine.into(),
            recipient: recipient.into(),
            id,
            now,
            scheduled,
            fails: state.fails,
            held,
            message: string(message, "id").into(),
            from: string(&message["from"], "address").into(),
        };
        let owner = self.owner.clone();
        tokio::spawn(async move {
            let outcome = post_wake(&waker, event, now).await;
            if let Some(account) = owner.upgrade() {
                let hub = account.lock().await;
                if hub.settle_wake(&call, &outcome).await.is_err() {
                    tracing::warn!("machine wake settlement unavailable");
                }
                let mut detail = json!({"machine":call.machine,"ok":outcome.ok});
                if let Some(status) = outcome.status {
                    detail["status"] = json!(status);
                }
                if let Some(error) = outcome.error {
                    detail["error"] = json!(error);
                }
                if let Some(declined) = outcome.declined {
                    detail["declined"] = json!(declined);
                }
                let _ = hub.wake_audit(&call.machine, "machine_wake", detail).await;
            }
        });
        Ok(true)
    }
    async fn settle_wake(&self, call: &WakeCall, outcome: &Outcome) -> Result<()> {
        let Some(mut state) = self.wake_state(&call.machine).await? else {
            return Ok(());
        };
        if state.call.as_deref() != Some(&call.id) {
            return Ok(());
        }
        let now = crate::now_ms();
        state.call = None;
        state.declined = call
            .held
            .clone()
            .filter(|d| d.until.is_none_or(|at| at > now));
        let mut changes = HubWrite::default();
        let mut marked = None;
        if let Some(reason) = &outcome.declined {
            state.next = call.now;
            state.declined = Some(Decline {
                reason: reason.clone(),
                message: call.message.clone(),
                from: call.from.clone(),
                until: self
                    .wake_options
                    .decline_hold_s
                    .is_finite()
                    .then(|| after(now, self.wake_options.decline_hold_s)),
            });
        } else if outcome.ok {
            let until = after(
                now,
                self.wake_options
                    .waking_timeout_s
                    .unwrap_or(self.wake_options.debounce_s),
            );
            if let Some(mut e) = self.endpoints().await?.into_iter().find(|e| {
                e.id == call.recipient
                    && e.token_hash.is_none()
                    && fields(e)["presence"] == "hibernated"
            }) {
                let mut f = fields(&e);
                f["waking_until"] = json!(until);
                e.fields = f.to_string();
                changes.endpoints.push(e.clone());
                marked = Some(e);
            }
            state.next = if marked.is_some() {
                call.scheduled.max(until)
            } else {
                call.scheduled
            };
            state.fails = 0;
            state.retry_at = None;
        } else {
            state.fails = call.fails.saturating_add(1);
            let backoff = (self.wake_options.debounce_s * 2_f64.powf(state.fails as f64)).min(
                self.wake_options
                    .backoff_max_s
                    .max(self.wake_options.debounce_s),
            );
            state.next = after(call.now, backoff);
        }
        changes
            .states
            .push((wake_key(&call.machine), Some(json!(state).to_string())));
        self.store.hub_write(&self.account_id, changes).await?;
        if let Some(e) = marked {
            self.wake_presence(&e, true);
        }
        Ok(())
    }
    pub(super) async fn wake_queued(&self, machine: &str, retrying: bool) -> Result<()> {
        let now = crate::now_ms();
        let again = if retrying {
            now.saturating_add(self.wake_options.retry_ms())
        } else {
            i64::MAX
        };
        if self
            .wake_state(machine)
            .await?
            .is_some_and(|s| s.next > now)
        {
            return self.retry_wake(machine, again).await;
        }
        if self
            .connections
            .values()
            .any(|c| c.role == "bridge" && c.subscribed && c.machine == machine)
        {
            return Ok(());
        }
        if self
            .store
            .state(&self.account_id, &format!("wake:{machine}"))
            .await?
            .is_none()
        {
            return Ok(());
        }
        let result = self.scan_wake_queued(machine, now).await;
        if result.is_err() {
            self.retry_wake(machine, again).await?;
        }
        result
    }
    async fn scan_wake_queued(&self, machine: &str, now: i64) -> Result<()> {
        let inbox = if self.wake_options.cross_account {
            self.store.xinbox(&self.account_id).await?
        } else {
            vec![]
        };
        let endpoints = self.endpoints().await?;
        let mut tried = HashSet::new();
        let mut retry = i64::MAX;
        let mut cursor = 0;
        loop {
            let page = self
                .store
                .pending_machine_x(&self.account_id, machine, cursor, cursor, now, 200)
                .await?;
            for d in &page {
                let Some(e) = endpoints.iter().find(|e| e.id == d.endpoint) else {
                    continue;
                };
                let message = self.delivery_value(d, false).await?;
                let key = (e.id.clone(), string(&message["from"], "address").to_owned());
                if tried.contains(&key) {
                    continue;
                }
                // A foreign envelope is never admitted as local when cross-account wakes are off.
                let foreign = message["from"]["account"]
                    .as_str()
                    .is_some_and(|a| a != self.handle);
                if foreign {
                    let Some(x) = inbox
                        .iter()
                        .find(|x| x.seq == d.seq && !x.acked && x.expires_at > now)
                    else {
                        tried.insert(key);
                        continue;
                    };
                    let Some(contact) = self
                        .store
                        .contact(&self.account_id, &x.from_account)
                        .await?
                    else {
                        tried.insert(key);
                        continue;
                    };
                    if contact.state != "active"
                        || contact.config.dir == "out"
                        || self
                            .wake_target(machine, &e.id, &message, now)
                            .await?
                            .is_none()
                    {
                        tried.insert(key);
                        continue;
                    }
                    if let Some(at) = self
                        .wake_admitted(&x.from_account, &e.id, now, d.seq)
                        .await?
                    {
                        retry = retry.min(at);
                        continue;
                    }
                }
                tried.insert(key);
                self.retry_wake(machine, retry).await?;
                if self.machine_wake(machine, &e.id, &message, None).await? {
                    return Ok(());
                }
            }
            if let Some(d) = page.last() {
                cursor = d.seq;
            }
            if page.len() < 200 {
                break;
            }
        }
        self.retry_wake(machine, retry).await
    }
    pub(super) async fn sweep_wakes(&self, now: i64) -> Result<()> {
        let mut changes = HubWrite::default();
        let mut ended = Vec::new();
        for mut e in self.endpoints().await? {
            let mut f = fields(&e);
            if f["waking_until"].as_i64().is_some_and(|at| at <= now) {
                f.as_object_mut().unwrap().remove("waking_until");
                e.fields = f.to_string();
                if e.token_hash.is_none() && f["presence"] == "hibernated" {
                    ended.push(e.clone());
                }
                changes.endpoints.push(e);
            }
        }
        self.store.hub_write(&self.account_id, changes).await?;
        for e in ended {
            self.wake_presence(&e, false);
        }
        for machine in self.store.machines(&self.account_id).await? {
            let Some(mut state) = self.wake_state(&machine.name).await? else {
                continue;
            };
            let earliest = state.next.saturating_add(self.wake_options.retry_ms());
            let unheld = state
                .declined
                .as_ref()
                .and_then(|d| d.until)
                .is_some_and(|until| until.max(earliest) <= now);
            let retrying = state.retry_at.is_some_and(|at| at.max(earliest) <= now);
            if unheld {
                state.declined = None;
            }
            if retrying {
                state.retry_at = None;
            }
            if unheld || retrying {
                self.set_wake_state(&machine.name, &state).await?;
                if self.wake_queued(&machine.name, retrying).await.is_err() {
                    tracing::warn!("queued machine wake unavailable");
                }
            }
        }
        Ok(())
    }
}
async fn post_wake(waker: &Value, event: Value, now: i64) -> Outcome {
    let send = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(20))
            .timeout(Duration::from_secs(10))
            .build()?;
        let body = event.to_string();
        let timestamp = now.to_string();
        let mut mac = Hmac::<Sha256>::new_from_slice(string(waker, "secret").as_bytes())
            .expect("HMAC accepts any key length");
        mac.update(format!("{timestamp}.{body}").as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());
        let response = client
            .post(string(waker, "url"))
            .header("content-type", "application/json")
            .header("x-scp-timestamp", timestamp)
            .header("x-scp-signature", format!("sha256={signature}"))
            .body(body)
            .send()
            .await?;
        let status = response.status().as_u16();
        let declined = if status == 403 {
            response.json::<Value>().await.ok().and_then(|v| {
                v["declined"]
                    .as_str()
                    .filter(|s| validation::pattern!(r"^[a-z][a-z0-9_-]{0,31}$", s))
                    .map(str::to_owned)
            })
        } else {
            None
        };
        Ok::<_, reqwest::Error>(Outcome {
            ok: (200..300).contains(&status),
            status: Some(status),
            error: None,
            declined,
        })
    };
    match tokio::time::timeout(Duration::from_secs(10), send).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => Outcome {
            ok: false,
            status: None,
            error: Some(if error.is_timeout() {
                "TimeoutError"
            } else {
                "Error"
            }),
            declined: None,
        },
        Err(_) => Outcome {
            ok: false,
            status: None,
            error: Some("TimeoutError"),
            declined: None,
        },
    }
}

#[cfg(test)]
#[path = "wake_tests.rs"]
mod tests;
