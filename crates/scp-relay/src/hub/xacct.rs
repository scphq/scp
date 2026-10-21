use super::*;
use async_trait::async_trait;
use scp_relay_store::{Contact, Message as StoredMessage, XAllow, XInbox, XLimits};
use subtle::ConstantTimeEq;
use validation::{handle, no_secret, pattern, server_fields};

/// Trusted sender fields set by the sending account's hub.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XFrom {
    pub account: String,
    pub address: String,
    pub human: bool,
    pub auth: String,
    #[serde(default)]
    pub rel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    pub harness: Option<String>,
}
/// Internal account-to-account wire message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XMessage {
    pub id: String,
    pub from: XFrom,
    pub to: String,
    pub body: String,
    pub kind: String,
    pub thread: String,
    pub reply_to: Option<String>,
    pub hop: u64,
    pub client_id: String,
    pub created_at: i64,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_grant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_grant_expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<XLimits>,
}
/// Gate redaction metadata, combined across both accounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Redacted {
    pub n: u64,
    pub kinds: Vec<String>,
}
/// Host gate decision for one side of a cross-account message.
#[derive(Debug, Clone)]
pub enum GateVerdict {
    Pass,
    Refuse {
        code: String,
        categories: Vec<String>,
        retry_after: Option<i64>,
    },
    Redact {
        body: String,
        redacted: Redacted,
    },
    Hold {
        hold_id: String,
    },
    Duplicate {
        hold_id: String,
    },
}
/// Trusted context supplied to a host gate.
#[derive(Debug, Clone)]
pub struct GateContext {
    pub side: String,
    pub account: String,
    pub peer: String,
    pub peer_id: String,
    pub sender: Option<String>,
}
/// Host-controlled egress and ingress policy.
#[async_trait]
pub trait Gate: Send + Sync {
    async fn egress(&self, message: &XMessage, context: &GateContext) -> GateVerdict;
    async fn ingress(&self, message: &XMessage, context: &GateContext) -> GateVerdict;
}
/// Default policy, after protocol checks and credential scanning.
pub struct PassGate;
#[async_trait]
impl Gate for PassGate {
    async fn egress(&self, _: &XMessage, _: &GateContext) -> GateVerdict {
        GateVerdict::Pass
    }
    async fn ingress(&self, _: &XMessage, _: &GateContext) -> GateVerdict {
        GateVerdict::Pass
    }
}
/// A hold claimed by the host's human console before release.
#[derive(Debug, Clone)]
pub enum XRelease {
    Egress {
        hold_id: String,
        sender: String,
        peer: String,
        message: XMessage,
    },
    Ingress {
        from_account: String,
        message: XMessage,
    },
}
#[derive(Clone, Default)]
struct Origin {
    tty: bool,
    hop: u64,
    judged: bool,
    id: Option<String>,
    client_id: Option<String>,
}
pub(super) enum Dispatch {
    Done(Value),
    Send(Box<Pending>),
    List(Vec<Contact>),
}
pub(super) struct Pending {
    contact: Contact,
    message: XMessage,
    refund: xcounters::Refund,
    machine: String,
    redacted: Option<Redacted>,
}
struct Target {
    account: String,
    machine: String,
    handle: String,
}
fn missing() -> Error {
    Error::new("not_found", "no endpoint at address")
}
fn remote(e: &Endpoint) -> String {
    format!("{}/{}", e.machine, e.handle)
}
fn machine(s: &str) -> bool {
    pattern!(r"^[a-z0-9][a-z0-9-]{0,31}$", s)
}
fn mirrored(e: &Endpoint) -> bool {
    !e.machine.is_empty() && e.token_hash.is_none() && e.kind != "system"
}
fn allowlisted(allow: &[XAllow], e: &Endpoint) -> bool {
    let f = fields(e);
    allow.iter().any(|a| {
        if a.machine != "*" && a.machine != e.machine {
            return false;
        }
        if e.handle.is_empty() {
            return true;
        }
        let Some(depth) = f["depth"].as_u64() else {
            return false;
        };
        if a.sel == "tree:root" {
            depth == 0
        } else {
            a.sel == format!("ep:{}", remote(e)) && (depth < 2 || a.allow_worker == Some(true))
        }
    })
}
fn grant(key: &str, id: &str, address: &str, peer: &str, expiry: i64) -> String {
    crate::hash(&format!("{key}|{id}|{address}|{peer}|{expiry}|{key}"))
}
fn same_secret(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

fn join(a: Option<Redacted>, b: Option<Redacted>) -> Option<Redacted> {
    match (a, b) {
        (Some(a), Some(b)) => {
            let mut kinds = a.kinds;
            kinds.extend(b.kinds);
            kinds.sort();
            kinds.dedup();
            Some(Redacted {
                n: a.n + b.n,
                kinds,
            })
        }
        (a, b) => a.or(b),
    }
}
fn refusal(code: String, categories: Vec<String>, retry: Option<i64>, side: &str) -> Error {
    let code = if matches!(
        code.as_str(),
        "not_found"
            | "inbox_full"
            | "rate_limited"
            | "loop_guard"
            | "data_class_refused"
            | "secret_refused"
            | "policy_refused"
            | "too_large"
            | "invalid_params"
            | "unauthorized"
            | "method_not_found"
            | "scope_refused"
            | "unavailable"
            | "judge_refused"
    ) {
        code
    } else {
        "policy_refused".into()
    };
    let categories: Vec<String> = categories
        .into_iter()
        .map(|s| s.chars().take(64).collect())
        .collect();
    let what = if code == "judge_refused" {
        "relay judge"
    } else {
        "relay"
    };
    let account = if side == "egress" {
        "sending"
    } else {
        "receiving"
    };
    let suffix = if categories.is_empty() {
        String::new()
    } else {
        format!(" ({})", categories.join(", "))
    };
    let mut e = Error::new(
        &code,
        &format!("the {account} account's {what} refused this message{suffix}"),
    );
    if code == "judge_refused" {
        e.details = Some(json!({"side":side,"categories":categories}));
    } else {
        e.retry = retry.filter(|v| *v > 0);
    }
    e
}
impl AccountHub {
    fn foreign(&self, v: &Value) -> Option<Target> {
        let parts: Vec<_> = v.as_str()?.trim().split('/').collect();
        let [account, machine_name, h] = parts.as_slice() else {
            return None;
        };
        if matches!(*account, "me" | "local")
            || *account == self.handle
            || !pattern!(r"^[a-z0-9][a-z0-9-]{0,63}$", account)
            || !machine(machine_name)
            || (!h.is_empty() && *h != "me" && !handle(h))
        {
            return None;
        }
        Some(Target {
            account: (*account).into(),
            machine: (*machine_name).into(),
            handle: if *h == "me" { "".into() } else { (*h).into() },
        })
    }
    pub(super) fn has_foreign(&self, to: &Value) -> bool {
        to.as_array().map_or_else(
            || self.foreign(to).is_some(),
            |a| a.iter().any(|v| self.foreign(v).is_some()),
        )
    }
    async fn xkey(&mut self) -> Result<String> {
        if let Some(key) = &self.xkey {
            return Ok(key.clone());
        }
        let key = match self.store.state(&self.account_id, "xstate:key").await? {
            Some(value) => serde_json::from_str::<String>(&value)
                .map_err(|_| Error::new("unavailable", "invalid account key"))?,
            None => {
                let key = crate::random("");
                self.store
                    .put_state(
                        &self.account_id,
                        "xstate:key",
                        Some(&json!(key).to_string()),
                    )
                    .await?;
                key
            }
        };
        self.xkey = Some(key.clone());
        Ok(key)
    }
    pub(super) async fn xforward(&mut self, c: &Connection, p: &Value) -> Result<Dispatch> {
        let from = p["from"]
            .as_str()
            .filter(|s| !s.contains('/'))
            .ok_or_else(|| invalid("from is a handle on the bridge's own machine"))?;
        let sender = self
            .endpoints()
            .await?
            .into_iter()
            .find(|e| e.machine == c.machine && e.handle == from && mirrored(e))
            .ok_or_else(missing)?;
        let hop = match p.get("hop_floor") {
            None => 0,
            Some(v) => v
                .as_u64()
                .filter(|n| *n <= 1000)
                .ok_or_else(|| invalid("hop_floor is a hop count"))?,
        };
        let mut send = p["params"].clone();
        if !send.is_object() {
            return Err(invalid("params must be an object"));
        }
        if let Some(map) = send.as_object_mut() {
            map.remove("wait_s");
        }
        server_fields(&send)?;
        self.xsend(
            &sender,
            &send,
            Origin {
                tty: p["tty"] == true,
                hop,
                ..Origin::default()
            },
        )
        .await
    }
    async fn xsend(&mut self, sender: &Endpoint, send: &Value, origin: Origin) -> Result<Dispatch> {
        let Origin {
            tty,
            hop: origin_hop,
            judged,
            ..
        } = origin.clone();
        let targets = send["to"]
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![send["to"].clone()]);
        if targets.len() != 1 {
            return Err(invalid(
                "a message to another account goes to exactly one endpoint: no lists, groups or tree:",
            ));
        }
        let target = self.foreign(&targets[0]).ok_or_else(missing)?;
        let body = send["body"]
            .as_str()
            .ok_or_else(|| invalid("body must be a string"))?;
        if body.len() > 16384 {
            return Err(Error::new(
                "too_large",
                &format!(
                    "a message to another account is at most 16384 bytes; this one is {}",
                    body.len()
                ),
            ));
        }
        if send
            .get("attachments")
            .is_some_and(|a| a.as_array().is_none_or(|a| !a.is_empty()))
        {
            return Err(Error::new(
                "data_class_refused",
                "attachments stay in this account",
            ));
        }
        if send["data_class"] == "private" {
            return Err(Error::new(
                "data_class_refused",
                "a private message stays in this account",
            ));
        }
        if send.get("data_class").is_some_and(|v| v != "public") {
            return Err(invalid("data_class must be public or private"));
        }
        let kind = send
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("message");
        if !matches!(kind, "message" | "request" | "reply" | "status")
            || send.get("kind").is_some_and(|v| !v.is_string())
        {
            return Err(invalid(
                "kind must be one of message, request, reply, status",
            ));
        }
        if send.get("reply_to").is_some_and(|v| !v.is_string()) {
            return Err(invalid("reply_to is a message id"));
        }
        if origin_hop > 8 {
            return Err(Error::new(
                "loop_guard",
                "message exceeds the hop limit of 8 across accounts",
            ));
        }
        let peer = self
            .store
            .account(&target.account)
            .await
            .ok()
            .flatten()
            .ok_or_else(missing)?;
        let contact = self
            .store
            .contact(&self.account_id, &peer.id)
            .await
            .ok()
            .flatten()
            .filter(|c| {
                c.state == "active" && c.config.dir != "in" && c.peer_handle == target.account
            })
            .ok_or_else(missing)?;
        if !mirrored(sender) || !allowlisted(&contact.config.allow, sender) {
            return Err(missing());
        }
        let address = format!(
            "{}/{}/{}",
            target.account,
            target.machine,
            if target.handle.is_empty() {
                "me"
            } else {
                &target.handle
            }
        );
        let reply_to = send["reply_to"].as_str().map(str::to_owned);
        let parent = if let Some(id) = &reply_to {
            self.store
                .xinbox(&self.account_id)
                .await?
                .into_iter()
                .find(|x| {
                    x.id == *id
                        && x.endpoint == remote(sender)
                        && x.from_account == contact.peer_id
                        && serde_json::from_str::<Value>(&x.message)
                            .ok()
                            .is_some_and(|m| m["from"]["address"] == address)
                })
        } else {
            None
        };
        let rows = self.endpoints().await?;
        if parent.is_none() && !scope::cross_allowed(sender, "out", &target.account, &rows) {
            return Err(missing());
        }
        let now = crate::now_ms();
        let thread = parent
            .as_ref()
            .map(|x| x.thread.clone())
            .or(text(send.get("thread"), "thread", 64)?
                .as_str()
                .map(str::to_owned))
            .unwrap_or_else(|| validation::new_id("thr_"));
        let hop = origin_hop.max(
            parent
                .as_ref()
                .and_then(|x| serde_json::from_str::<Value>(&x.message).ok())
                .and_then(|m| m["hop"].as_u64())
                .map_or(0, |h| h + 1),
        );
        if hop > 8 {
            return Err(Error::new(
                "loop_guard",
                "message exceeds the hop limit of 8 across accounts",
            ));
        }
        self.xcounters
            .check(
                self.store.as_ref(),
                &self.account_id,
                &contact,
                (&remote(sender), &address, &thread),
                now,
            )
            .await?;
        no_secret(body)?;
        let ttl = match send.get("ttl_s") {
            None => 604800,
            Some(v) => v
                .as_i64()
                .filter(|n| (1..=2592000).contains(n))
                .ok_or_else(|| invalid("ttl_s must be 1 to 2592000"))?,
        };
        let own = format!(
            "{}/{}/{}",
            self.handle,
            sender.machine,
            if sender.handle.is_empty() {
                "me"
            } else {
                &sender.handle
            }
        );
        let human = sender.kind == "human" && sender.handle.is_empty() && tty;
        let id = origin
            .id
            .clone()
            .unwrap_or_else(|| validation::new_id("msg_"));
        let expiry = now + ttl * 1000;
        let client = text(send.get("client_id"), "client_id", 128)?
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| validation::new_id("cid_"));
        let key = self.xkey().await?;
        let message =
            XMessage {
                id: id.clone(),
                from: XFrom {
                    account: self.handle.clone(),
                    address: if human {
                        format!("{}/me", self.handle)
                    } else {
                        own.clone()
                    },
                    human,
                    auth: "contact".into(),
                    rel: format!("contact:{}", self.handle),
                    machine: Some(sender.machine.clone()),
                    harness: fields(sender)["harness"].as_str().map(str::to_owned),
                },
                to: format!("{}/{}", target.machine, target.handle),
                body: body.into(),
                kind: kind.into(),
                thread: thread.clone(),
                reply_to,
                hop,
                client_id: origin
                    .client_id
                    .clone()
                    .unwrap_or_else(|| crate::hash(&format!("{own}|{address}|{client}"))),
                created_at: now,
                expires_at: expiry,
                reply_grant: parent.as_ref().and_then(|x| x.grant.clone()),
                reply_grant_expires_at: parent
                    .as_ref()
                    .filter(|x| x.grant.is_some())
                    .map(|x| x.expires_at),
                grant: Some(grant(&key, &id, &own, &contact.peer_id, expiry)),
                limits: contact.config.limits.clone().filter(|l| {
                    l.per_minute.is_some() || l.per_hour.is_some() || l.per_day.is_some()
                }),
            };
        let verdict = if judged {
            GateVerdict::Pass
        } else {
            self.gate
                .egress(
                    &message,
                    &GateContext {
                        side: "egress".into(),
                        account: self.handle.clone(),
                        peer: contact.peer_handle.clone(),
                        peer_id: contact.peer_id.clone(),
                        sender: Some(sender.id.clone()),
                    },
                )
                .await
        };
        match verdict {
            GateVerdict::Refuse {
                code,
                categories,
                retry_after,
            } => return Err(refusal(code, categories, retry_after, "egress")),
            GateVerdict::Hold { hold_id } => {
                return Ok(Dispatch::Done(
                    json!({"id":hold_id,"thread":thread,"hop":hop,"deliveries":[],"held":{"hold_id":hold_id,"side":"egress"}}),
                ));
            }
            GateVerdict::Duplicate { hold_id } => {
                return Ok(Dispatch::Done(
                    json!({"id":hold_id,"thread":thread,"hop":hop,"deliveries":[],"duplicate":true}),
                ));
            }
            GateVerdict::Redact { body, redacted } => {
                let mut send = send.clone();
                send["body"] = json!(body);
                let mut out = Box::pin(self.xsend(
                    sender,
                    &send,
                    Origin {
                        judged: true,
                        ..origin
                    },
                ))
                .await?;
                match &mut out {
                    Dispatch::Send(p) => p.redacted = join(Some(redacted), p.redacted.take()),
                    Dispatch::Done(v) => {
                        v["redacted"] = json!(redacted);
                    }
                    _ => {}
                }
                return Ok(out);
            }
            GateVerdict::Pass => {}
        }
        let now = crate::now_ms();
        self.xcounters
            .check(
                self.store.as_ref(),
                &self.account_id,
                &contact,
                (&remote(sender), &address, &thread),
                now,
            )
            .await?;
        let refund = self
            .xcounters
            .sent(
                self.store.as_ref(),
                &self.account_id,
                &contact,
                (&remote(sender), &address, &thread),
                now,
            )
            .await?;
        Ok(Dispatch::Send(Box::new(Pending {
            contact,
            message,
            refund,
            machine: sender.machine.clone(),
            redacted: None,
        })))
    }
    async fn xreceive(&mut self, from_account: &str, msg: XMessage, judged: bool) -> Result<Value> {
        self.initialize().await?;
        validate_message(&msg)?;
        let contact = self
            .store
            .contact(&self.account_id, from_account)
            .await
            .ok()
            .flatten()
            .filter(|c| {
                c.state == "active" && c.config.dir != "out" && c.peer_handle == msg.from.account
            })
            .ok_or_else(missing)?;
        let rows = self.endpoints().await?;
        let target = rows
            .iter()
            .find(|e| remote(e) == msg.to && mirrored(e) && allowlisted(&contact.config.allow, e))
            .ok_or_else(missing)?;
        let address = format!(
            "{}/{}/{}",
            self.handle,
            target.machine,
            if target.handle.is_empty() {
                "me"
            } else {
                &target.handle
            }
        );
        let key = self.xkey().await?;
        let granted = msg
            .reply_to
            .as_ref()
            .zip(msg.reply_grant.as_ref())
            .zip(msg.reply_grant_expires_at)
            .is_some_and(|((id, g), expiry)| {
                expiry > crate::now_ms()
                    && same_secret(g, &grant(&key, id, &address, from_account, expiry))
            });
        if !granted && !scope::cross_allowed(target, "in", &contact.peer_handle, &rows) {
            return Err(missing());
        }
        let parts: Vec<_> = msg.from.address.split('/').collect();
        let honest = if msg.from.address == format!("{}/me", msg.from.account) {
            msg.from.human
        } else {
            !msg.from.human
                && parts.len() == 3
                && parts[0] == msg.from.account
                && machine(parts[1])
                && (parts[2].is_empty() || parts[2] == "me" || handle(parts[2]))
        };
        if !honest {
            return Err(invalid("the sender is not one its relay may name"));
        }
        if msg.body.len() > 16384 {
            return Err(Error::new(
                "too_large",
                "a message from another account is at most 16384 bytes",
            ));
        }
        if msg.hop > 8 {
            return Err(Error::new(
                "loop_guard",
                "hop is past the limit across accounts (8)",
            ));
        }
        if msg.expires_at <= crate::now_ms() {
            return Err(invalid("the message expired"));
        }
        if let Some(x) = self
            .store
            .xinbox(&self.account_id)
            .await?
            .into_iter()
            .find(|x| x.from_account == from_account && x.client_id == msg.client_id)
        {
            return Ok(
                json!({"id":x.id,"state":if x.acked{"delivered"}else{"queued"},"duplicate":true}),
            );
        }
        let mut from = json!({"address":msg.from.address,"endpoint":msg.from.address,"user":contact.peer_handle,"auth":"contact","claims":{"harness":msg.from.harness,"model":null},"rel":format!("contact:{}",contact.peer_handle),"account":contact.peer_handle});
        if let Some(m) = &msg.from.machine {
            from["machine"] = json!(m);
        }
        if msg.from.human {
            from["human"] = json!(true);
        }
        let envelope = json!({"id":msg.id,"thread":msg.thread,"reply_to":msg.reply_to,"kind":msg.kind,"from":from,"to":address,"body":{"text":msg.body,"mime":"text/markdown"},"data_class":"public","attachments":[],"hop":msg.hop,"created_at":iso(msg.created_at),"expires_at":iso(msg.expires_at)});
        let encoded = envelope.to_string();
        self.xadmit(from_account, &contact, &msg, target, encoded.len())
            .await?;
        no_secret(&msg.body)?;
        let verdict = if judged {
            GateVerdict::Pass
        } else {
            self.gate
                .ingress(
                    &msg,
                    &GateContext {
                        side: "ingress".into(),
                        account: self.handle.clone(),
                        peer: contact.peer_handle.clone(),
                        peer_id: from_account.into(),
                        sender: None,
                    },
                )
                .await
        };
        match verdict {
            GateVerdict::Refuse {
                code,
                categories,
                retry_after,
            } => return Err(refusal(code, categories, retry_after, "ingress")),
            GateVerdict::Hold { hold_id } => {
                return Ok(json!({"id":msg.id,"state":"queued","held":{"hold_id":hold_id}}));
            }
            GateVerdict::Duplicate { .. } => {
                return Ok(json!({"id":msg.id,"state":"delivered","duplicate":true}));
            }
            GateVerdict::Redact { body, redacted } => {
                let mut out =
                    Box::pin(self.xreceive(from_account, XMessage { body, ..msg }, true)).await?;
                out["redacted"] = json!(redacted);
                return Ok(out);
            }
            GateVerdict::Pass => {}
        }
        self.xadmit(from_account, &contact, &msg, target, encoded.len())
            .await?;
        let now = crate::now_ms();
        let (x, duplicate) = self
            .store
            .xinsert(
                &self.account_id,
                StoredMessage {
                    id: msg.id.clone(),
                    thread: msg.thread.clone(),
                    reply_to: msg.reply_to.clone(),
                    kind: msg.kind.clone(),
                    from_ep: msg.from.address.clone(),
                    to_addr: address.clone(),
                    created_at: msg.created_at,
                    expires_at: msg.expires_at,
                    envelope: encoded.clone(),
                },
                XInbox {
                    seq: 0,
                    id: msg.id.clone(),
                    endpoint: remote(target),
                    from_account: from_account.into(),
                    sender: msg.from.address.clone(),
                    client_id: msg.client_id.clone(),
                    message: encoded,
                    thread: msg.thread.clone(),
                    grant: msg.grant.clone(),
                    expires_at: msg.expires_at,
                    at: now,
                    acked: false,
                },
            )
            .await?;
        if duplicate {
            return Ok(
                json!({"id":x.id,"state":if x.acked{"delivered"}else{"queued"},"duplicate":true}),
            );
        }
        let mut pushed = false;
        for c in self
            .connections
            .values()
            .filter(|c| c.role == "bridge" && c.subscribed && c.machine == target.machine)
        {
            if let Some(socket) = &c.socket {
                socket.send(json!({"jsonrpc":"2.0","method":"deliver","params":{"seq":x.seq,"endpoint":x.endpoint,"message":envelope}}).to_string());
                pushed = true;
            }
        }
        self.fleet(json!({"type":"message","machine":msg.from.machine,"id":msg.id,"thread":msg.thread,"kind":msg.kind,"from":msg.from.address,"to":[address],"hop":msg.hop}));
        Ok(json!({"id":msg.id,"state":if pushed{"delivered"}else{"queued"}}))
    }
    async fn xadmit(
        &self,
        peer: &str,
        c: &Contact,
        msg: &XMessage,
        target: &Endpoint,
        bytes: usize,
    ) -> Result<()> {
        let now = crate::now_ms();
        let inbox = self.store.xinbox(&self.account_id).await?;
        let (minute, hour, day) = xcounters::caps(c.config.limits.as_ref(), msg.limits.as_ref());
        let to = remote(target);
        for (cap, ms, unit) in [(minute, 60_000, "minute"), (hour, 3_600_000, "hour")] {
            let times: Vec<_> = inbox
                .iter()
                .filter(|x| {
                    x.from_account == peer
                        && x.sender == msg.from.address
                        && x.endpoint == to
                        && x.at > now - ms
                })
                .map(|x| x.at)
                .collect();
            if times.len() as i64 >= cap {
                return Err(Error::rate(
                    &format!(
                        "{cap} messages from {} to {} a {unit}",
                        msg.from.address, msg.to
                    ),
                    (times.iter().min().copied().unwrap_or(now) + ms - now + 999) / 1000,
                ));
            }
        }
        if inbox
            .iter()
            .filter(|x| x.from_account == peer && x.at >= xcounters::day_start(now))
            .count() as i64
            >= day
        {
            return Err(Error::rate(
                &format!("{day} messages from {} today", c.peer_handle),
                xcounters::until_tomorrow(now),
            ));
        }
        if inbox
            .iter()
            .filter(|x| x.endpoint == to && x.thread == msg.thread)
            .count()
            >= 50
        {
            return Err(Error::new(
                "loop_guard",
                &format!("thread {} reached 50 messages across accounts", msg.thread),
            ));
        }
        let cap = self.limits.cap("storedBytes").unwrap_or(u64::MAX);
        if self
            .store
            .stored_bytes(&self.account_id)
            .await?
            .saturating_add(bytes as u64)
            > cap
        {
            return Err(Error::new(
                "inbox_full",
                &format!("the receiving account's relay holds its cap of {cap} bytes of messages"),
            ));
        }
        // Include retained unread receipts even when a contact was just revoked.
        let cross = inbox
            .iter()
            .filter(|x| x.endpoint == to && !x.acked && x.expires_at > now)
            .count() as i64;
        let local = self
            .store
            .deliveries(&self.account_id, &target.id, 0)
            .await?
            .iter()
            .filter(|d| {
                d.acked_at.is_none() && d.expires_at > now && !inbox.iter().any(|x| x.seq == d.seq)
            })
            .count() as i64;
        if local + cross >= 1000 {
            return Err(Error::new(
                "inbox_full",
                &format!("{} has {} unread messages", msg.to, local + cross),
            ));
        }
        Ok(())
    }
    async fn xlist(&mut self, peer: &str) -> Vec<Value> {
        if self.initialize().await.is_err() {
            return vec![];
        }
        let Some(c) = self
            .store
            .contact(&self.account_id, peer)
            .await
            .ok()
            .flatten()
            .filter(|c| c.state == "active" && c.config.dir != "out")
        else {
            return vec![];
        };
        let mut rows = self.endpoints().await.unwrap_or_default();
        rows.sort_by_key(remote);
        rows.iter().filter(|e|mirrored(e) && allowlisted(&c.config.allow,e)).map(|e|json!({"address":format!("{}/{}/{}",self.handle,e.machine,if e.handle.is_empty(){"me"}else{&e.handle}),"harness":fields(e)["harness"],"presence":fields(e)["presence"].as_str().unwrap_or("offline")})).collect()
    }
}
impl Hub {
    /// Release a host-claimed hold, rerunning protocol checks with its gate skipped.
    pub async fn xrelease(
        &self,
        account: &scp_relay_store::Account,
        hold: XRelease,
    ) -> std::result::Result<Value, Value> {
        self.release_hold(account, hold).await.map_err(|e| e.wire())
    }
    async fn release_hold(
        &self,
        account: &scp_relay_store::Account,
        hold: XRelease,
    ) -> Result<Value> {
        if self
            .store
            .account(&account.handle)
            .await?
            .is_none_or(|a| a.id != account.id)
        {
            return Err(missing());
        }
        let hub = self.account_by_id(&account.id, &account.handle).await;
        let step = {
            let mut local = hub.lock().await;
            local.initialize().await?;
            match hold {
                XRelease::Ingress {
                    from_account,
                    message,
                } => Dispatch::Done(local.xreceive(&from_account, message, true).await?),
                XRelease::Egress {
                    hold_id,
                    sender,
                    peer,
                    message,
                } => {
                    let left = (message.expires_at - crate::now_ms() + 999) / 1000;
                    if left < 1 {
                        return Err(invalid("the held message expired"));
                    }
                    let sender = local
                        .endpoints()
                        .await?
                        .into_iter()
                        .find(|e| e.id == sender)
                        .ok_or_else(missing)?;
                    let mut send = json!({"to":format!("{peer}/{}{}",message.to,if message.to.ends_with('/') {"me"}else{""}),"body":message.body,"kind":message.kind,"thread":message.thread,"ttl_s":left.min(2592000)});
                    if let Some(reply) = message.reply_to {
                        send["reply_to"] = json!(reply);
                    }
                    local
                        .xsend(
                            &sender,
                            &send,
                            Origin {
                                tty: message.from.human,
                                hop: message.hop,
                                judged: true,
                                id: Some(hold_id),
                                client_id: Some(message.client_id),
                            },
                        )
                        .await?
                }
            }
        };
        self.complete(&hub, step).await
    }
    /// Push a host-generated status notice to a held message's sender.
    pub async fn xnotice(
        &self,
        account: &scp_relay_store::Account,
        endpoint: &str,
        text: &str,
    ) -> std::result::Result<(), Value> {
        let result = async {
            if self
                .store
                .account(&account.handle)
                .await?
                .is_none_or(|a| a.id != account.id)
            {
                return Err(missing());
            }
            let hub = self.account_by_id(&account.id, &account.handle).await;
            let mut local = hub.lock().await;
            local.initialize().await?;
            let sender = local
                .endpoints()
                .await?
                .into_iter()
                .find(|e| e.id == endpoint)
                .ok_or_else(missing)?;
            local
                .post_notice(Some(&sender), false, text, HubWrite::default())
                .await
        }
        .await;
        result.map_err(|e| e.wire())
    }
    pub(super) async fn execute(
        &self,
        account: &Arc<Mutex<AccountHub>>,
        connection: &str,
        method: &str,
        p: &Value,
    ) -> Result<Value> {
        let step = account.lock().await.dispatch(connection, method, p).await?;
        self.complete(account, step).await
    }
    pub(super) async fn poll(
        &self,
        account: &Arc<Mutex<AccountHub>>,
        connection: &str,
        method: &str,
        p: &Value,
    ) -> Result<Value> {
        let step = account.lock().await.poll(connection, method, p).await?;
        self.complete(account, step).await
    }
    async fn complete(&self, account: &Arc<Mutex<AccountHub>>, step: Dispatch) -> Result<Value> {
        match step {
            Dispatch::Done(v) => Ok(v),
            Dispatch::List(contacts) => {
                let own = account.lock().await.account_id.clone();
                let mut listed = Vec::new();
                for c in contacts {
                    let peer = self.account_by_id(&c.peer_id, &c.peer_handle).await;
                    listed.extend(peer.lock().await.xlist(&own).await);
                }
                Ok(json!({"contacts":listed}))
            }
            Dispatch::Send(pending) => {
                let Pending {
                    contact,
                    message,
                    refund,
                    machine,
                    redacted,
                } = *pending;
                let own = account.lock().await.account_id.clone();
                let peer = self
                    .account_by_id(&contact.peer_id, &contact.peer_handle)
                    .await;
                let delivered = peer
                    .lock()
                    .await
                    .xreceive(&own, message.clone(), false)
                    .await;
                let mut sender = account.lock().await;
                let delivered = match delivered {
                    Ok(v) => v,
                    Err(e) => {
                        if e.code == "unavailable" {
                            sender.xcounters.refund(refund);
                        }
                        return Err(e);
                    }
                };
                let address = format!(
                    "{}/{}/{}",
                    contact.peer_handle,
                    message.to.split_once('/').map_or("", |p| p.0),
                    message
                        .to
                        .split_once('/')
                        .map_or("me", |p| if p.1.is_empty() { "me" } else { p.1 })
                );
                sender.fleet(json!({"type":"message","machine":machine,"id":delivered["id"],"thread":message.thread,"kind":message.kind,"from":message.from.address,"to":[address],"hop":message.hop}));
                let mut out = json!({"id":delivered["id"],"thread":message.thread,"hop":message.hop,"deliveries":[{"endpoint":address,"address":address,"seq":0,"offline":delivered["state"]=="queued","last_seen":null}]});
                if delivered["duplicate"] == true {
                    out["duplicate"] = json!(true);
                }
                if !delivered["held"].is_null() {
                    out["held"] = json!({"hold_id":delivered["held"]["hold_id"],"side":"ingress"});
                }
                let incoming = delivered
                    .get("redacted")
                    .and_then(|v| serde_json::from_value::<Redacted>(v.clone()).ok());
                if let Some(r) = join(redacted, incoming) {
                    out["redacted"] = json!(r);
                }
                Ok(out)
            }
        }
    }
}
fn validate_message(m: &XMessage) -> Result<()> {
    let text = |s: &str, max: usize| !s.is_empty() && s.encode_utf16().count() <= max;
    let sender = &m.from;
    let target =
        m.to.split_once('/')
            .is_some_and(|(machine_name, h)| machine(machine_name) && (h.is_empty() || handle(h)));
    if !pattern!(r"^[a-z]{2,8}_[a-z0-9]{8,64}$", &m.id) || !text(&m.id, 128) {
        return Err(invalid("the cross-account message's id is not valid"));
    }
    if !pattern!(r"^[a-z0-9][a-z0-9-]{0,63}$", &sender.account)
        || !text(&sender.address, 200)
        || sender.auth != "contact"
        || sender.machine.as_ref().is_some_and(|m| !text(m, 32))
        || sender.harness.as_ref().is_some_and(|m| !text(m, 32))
    {
        return Err(invalid("the cross-account message's sender is not valid"));
    }
    if !target
        || !matches!(m.kind.as_str(), "message" | "request" | "reply" | "status")
        || !text(&m.thread, 128)
        || m.reply_to.as_ref().is_some_and(|s| !text(s, 128))
        || !text(&m.client_id, 128)
        || m.grant.as_ref().is_some_and(|s| !text(s, 128))
        || m.reply_grant.as_ref().is_some_and(|s| !text(s, 128))
        || m.reply_grant_expires_at.is_some_and(|n| n <= 0)
    {
        return Err(invalid("the cross-account message's shape is not valid"));
    }
    if let Some(l) = &m.limits
        && [l.per_minute, l.per_hour, l.per_day]
            .into_iter()
            .flatten()
            .any(|n| n <= 0)
    {
        return Err(invalid("the cross-account message's limits are not valid"));
    }
    Ok(())
}
