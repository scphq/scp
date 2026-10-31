use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use scp_core::protocol::{BROKER_CAPABILITIES, ErrorCode, PROTOCOL};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::paths::Paths;
use crate::procs::Procs;
use crate::proto::{Limits, PREAMBLE, RpcError};
use crate::state::{ConnectionId, Mode, State};
use crate::store::{Row, SqlValue, Storage};

pub type SharedCore = Arc<Mutex<Core>>;

pub struct Core {
    pub store: Arc<dyn Storage>,
    pub limits: Limits,
    pub policy: Option<Value>,
    pub procs: Procs,
    pub state: State,
    pub paths: Paths,
    pub policy_file: PathBuf,
    pub policy_error: Option<String>,
    pub judge: crate::judge::JudgeGate,
    pub policy_text: Option<Option<String>>,
    pub policy_binds: std::collections::HashMap<String, String>,
    pub noise: std::sync::Mutex<std::collections::HashMap<String, i64>>,
    pub wakers: crate::wake::Wakers,
}

impl Core {
    pub async fn new(
        store: Arc<dyn Storage>,
        limits: Limits,
        paths: Paths,
        policy_file: PathBuf,
    ) -> Result<Self, RpcError> {
        crate::store::schema::migrate(store.as_ref(), now_ms()).await?;
        store
            .all(
                "UPDATE judge_holds SET state = 'held' WHERE state = 'releasing'",
                &[],
            )
            .await?;
        store
            .all("UPDATE endpoints SET connections = 0, hook_seen = CASE WHEN kind = 'agent' AND hook_ended IS NULL THEN MAX(COALESCE(hook_seen,0), ?) ELSE hook_seen END WHERE connections > 0", &[SqlValue::Int(now_ms()-1_740_000)])
            .await?;
        store
            .all(
                "UPDATE endpoints SET wakers = 0, waker_left = ? WHERE wakers > 0",
                &[SqlValue::Int(now_ms())],
            )
            .await?;
        let mut state = State::default();
        for row in store.read("SELECT * FROM endpoints", &[]).await? {
            if let Some(id) = text(&row, "id") {
                state.presence.insert(id.to_owned(), 0);
                state
                    .addresses
                    .insert(id.to_owned(), crate::views::address(&row));
            }
        }
        let judge = crate::judge::JudgeGate::new(&limits);
        let wakers = crate::wake::Wakers::new(
            policy_file.parent().map_or_else(
                || PathBuf::from("wakers.json"),
                |dir| dir.join("wakers.json"),
            ),
            crate::wake::Wakers::builtin(),
        );
        let mut core = Self {
            store,
            limits,
            policy: None,
            procs: Procs::new(),
            state,
            paths,
            policy_file,
            policy_error: None,
            judge,
            policy_text: None,
            policy_binds: Default::default(),
            noise: Default::default(),
            wakers,
        };
        core.load_policy().await?;
        core.hibernate_held(None).await?;
        Ok(core)
    }

    pub fn broker_info(&self) -> Value {
        let mut policy = json!({"file": self.policy_file, "state": if self.policy_error.is_some() { "error" } else if self.policy.is_some() { "loaded" } else { "open" }});
        if let Some(error) = &self.policy_error {
            policy["error"] = json!(error);
        }
        json!({"socket": self.paths.socket, "dir": self.paths.dir, "pid": std::process::id(), "policy": policy})
    }

    pub fn hello_result(&self, endpoint: Value, token: Option<String>) -> Value {
        let mut result = json!({"endpoint": endpoint, "capabilities": BROKER_CAPABILITIES, "server_time": timestamp(now_ms()), "limits": self.limits, "preamble": PREAMBLE, "broker": self.broker_info()});
        if let Some(token) = token {
            result["token"] = json!(token);
        }
        result
    }

    pub async fn dispatch(
        &mut self,
        conn: ConnectionId,
        method: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        if method == "hello" {
            return self.hello(conn, params).await;
        }
        let connection = self.connection(conn)?;
        if !connection.bound() {
            return Err(RpcError::new(ErrorCode::Unauthorized, "call hello first"));
        }
        let observes = OBSERVER_METHODS.contains(&method);
        let scoped = SCOPE_METHODS.contains(&method);
        if connection.mode == Mode::Observer
            && !observes
            && !(scoped && (connection.lineage.is_some() || method == "why"))
        {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "this connection only observes: say hello as an agent or the human",
            ));
        }
        if connection.mode == Mode::Transient {
            if scoped {
                return Err(RpcError::new(
                    ErrorCode::ScopeRefused,
                    "a hook connection cannot read or change scopes, groups or grants",
                ));
            }
            if !matches!(
                method,
                "event"
                    | "status"
                    | "whoami"
                    | "inject"
                    | "injected"
                    | "peek_turn"
                    | "stop_wait"
                    | "prompted"
                    | "title_infer"
                    | "subagent_title"
                    | "wake"
            ) {
                return Err(RpcError::new(
                    ErrorCode::Unauthorized,
                    "a hook connection only posts activity and status",
                ));
            }
        }
        if let Some(ticket) = &connection.ticket
            && self.wake_ticket_holder(&json!(ticket)).await? != connection.endpoint
        {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "the wake ticket is spent: its run ended",
            ));
        }
        let endpoint = connection.endpoint.clone().unwrap_or_default();
        if !endpoint.is_empty() {
            self.touch(&endpoint).await?;
        }
        match method {
            "whoami" => {
                let row = self.must_endpoint(&endpoint).await?;
                let mut view = self.view(&row).await?;
                if connection.mode != Mode::Transient {
                    let state = self.peek_state(&endpoint).await?;
                    if let (Some(dst), Some(src)) = (view.as_object_mut(), state.as_object()) {
                        dst.extend(src.clone());
                    }
                    if let Some(pending) = self.link_pending_of(&endpoint).await? {
                        view["link_pending"] = pending;
                    }
                }
                Ok(view)
            }
            "peek_turn" => self.peek_turn(conn, params).await,
            "peek" => {
                if let Some(view) = self.via_peek_answer(conn, params).await? {
                    return Ok(view);
                }
                self.peek(conn, params).await
            }
            "peek_set" => self.peek_set(conn, params).await,
            "peek_who" => self.peek_who(conn, params).await,
            "list" => self.list_for(conn, params).await,
            "rename" => {
                let view = self.rename(conn, params).await?;
                if let Some(id) = view["id"].as_str() {
                    self.state.known.remove(id);
                    let id = id.to_owned();
                    self.presence_moved(&id, true, true).await?;
                }
                Ok(view)
            }
            "leave" => self.leave(conn, params).await,
            "adopt" => self.adopt(conn, params).await,
            "link_accept" => self.link_accept(conn, params).await,
            "unlink" => self.unlink(conn, params).await,
            "relink" => self.relink(conn, params).await,
            "event" => {
                let row = self.event(conn, params).await?;
                if !endpoint.is_empty() {
                    self.presence_moved(&endpoint, true, true).await?;
                }
                Ok(row)
            }
            "grant" => self.grant(conn, params).await,
            "log" => self.log_for(conn, params).await,
            "send" | "ask" => self.send_rpc(conn, method, params).await,
            "ask_wait" => self.ask_wait(&endpoint, params).await,
            "inbox" if crate::session::flag(params, "offer") => self.offer(&endpoint, params).await,
            "inbox" => self.inbox(&endpoint, params).await,
            "ack" => {
                self.ack(&endpoint, params.get("seqs").unwrap_or(&Value::Null))
                    .await
            }
            "message" => self.message_rpc(&endpoint, params).await,
            "receipts" => self.receipts(&endpoint, params).await,
            "watch" => self.watch(conn).await,
            "status" => self.status(&endpoint, params).await,
            "title" => {
                self.title(&endpoint, params.get("text"), &connection.mode)
                    .await
            }
            "title_infer" => self.title_infer_rpc(conn, params).await,
            "prompted" => self.prompted_rpc(conn, params).await,
            "inject" => self.inject(conn, params).await,
            "injected" => self.injected_rpc(conn, params).await,
            "stop_wait" => self.stop_wait(conn, params, false).await,
            "subagent_title" => self.subagent_title(conn, params).await,
            "spawn_exit" => self.spawn_exit(conn, params).await,
            "spawn_steers" => self.spawn_steers(conn, params).await,
            "spawn_end" => self.spawn_end(conn, params).await,
            "spawn_via" => self.spawn_via(conn, params).await,
            "wake" => self.wake_rpc(conn, params).await,
            "hibernate" => self.hibernate_rpc(conn, params).await,
            "holds" | "hold_show" | "hold_release" | "hold_refuse" => {
                self.review_hold(conn, method, params).await
            }
            "rules" => self.scope_view(conn, params).await,
            "rules_set" => self.rules_set(conn, params).await,
            "rules_widen" => self.rules_widen(conn, params).await,
            "rules_lift" => self.rules_lift(conn, params).await,
            "group" => self.group(conn, params).await,
            "admin" => self.admin(conn, params).await,
            "peers" => self.peers(conn, params).await,
            "why" => {
                let actor = self.actor_of(conn)?;
                let field = |key: &str| {
                    params
                        .get(key)
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .ok_or_else(|| RpcError::invalid_params(format!("{key} is required")))
                };
                self.why(&actor, &field("from")?, &field("to")?).await
            }
            "snapshot" => self.snapshot_for(conn, params).await,
            "policy" => self.policy_view(conn).await,
            "policy_check" => self.policy_check(conn, params).await,
            "cloud_status" | "bridge_relink" => Ok(json!({"enabled": false})),
            "machine_wake" => Err(RpcError::new(
                ErrorCode::Unavailable,
                "this broker has no hub link: the machine waker lives on the hub",
            )),
            _ => Err(RpcError::new(
                ErrorCode::MethodNotFound,
                format!("no method {method}"),
            )),
        }
    }

    async fn hello(
        &mut self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        let connection = self
            .state
            .connections
            .get(&conn)
            .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "connection is closed"))?;
        if connection.bound() {
            return Err(RpcError::invalid_params(
                "hello was already called on this connection",
            ));
        }
        if params.get("protocol").and_then(Value::as_str) != Some(PROTOCOL) {
            return Err(RpcError::invalid_params("this broker speaks scp/1"));
        }
        let result = crate::claims::hello_claim(self, conn, params).await?;
        let brief = self.state.connections.get(&conn).is_some_and(|c| c.brief);
        if let Some(id) = result["endpoint"]["id"].as_str() {
            let id = id.to_owned();
            self.presence_moved(&id, !brief, true).await?;
        }
        Ok(result)
    }

    /// records an endpoint's presence and address; when either moved since the last report and `notify`, watchers hear it
    pub async fn presence_moved(
        &mut self,
        id: &str,
        notify: bool,
        full: bool,
    ) -> Result<bool, RpcError> {
        let Some(row) = self.by_id(id).await? else {
            return Ok(false);
        };
        let view = self.endpoint_view(&row)?;
        let now = (
            view["presence"].as_str().unwrap_or("offline").to_owned(),
            view["address"].as_str().unwrap_or("").to_owned(),
        );
        let moved = self
            .state
            .known
            .get(id)
            .map_or(now.0 != "offline", |was| *was != now);
        self.state.known.insert(id.to_owned(), now);
        if !moved || !notify {
            return Ok(false);
        }
        let mut event =
            json!({"type": "presence", "endpoint": view["address"], "presence": view["presence"]});
        if full {
            event["harness"] = view["harness"].clone();
            event["labels"] = view["labels"].clone();
        }
        self.notify_watchers(event).await;
        Ok(true)
    }

    pub fn endpoint_view(&self, row: &Row) -> Result<Value, RpcError> {
        let handle = text(row, "handle").ok_or_else(RpcError::internal)?;
        let labels = text(row, "labels")
            .map(serde_json::from_str::<Value>)
            .transpose()
            .map_err(|_| RpcError::internal())?
            .unwrap_or_else(|| json!({}));
        let status = text(row, "status_state")
            .map(|state| json!({"state":state,"note":text(row,"status_note").unwrap_or("")}));
        let mut view = json!({
            "id": text(row, "id"), "address": if handle == "_human" { "me/".to_owned() } else { format!("me/{handle}") },
            "kind": text(row, "kind"), "harness": text(row, "harness"), "model": text(row, "model"), "cwd": text(row, "cwd"),
            "labels": labels, "title": text(row, "title"), "presence": crate::views::presence(row, now_ms()),
            "status": status, "last_seen": integer(row, "last_seen").and_then(timestamp),
        });
        if text(row, "kind") == Some("agent") {
            view["parent"] = text(row, "parent_ep")
                .and_then(|id| self.state.addresses.get(id))
                .map_or_else(
                    || text(row, "parent_addr").map_or(Value::Null, |v| json!(v)),
                    |v| json!(v),
                );
            view["depth"] = json!(integer(row, "depth").unwrap_or(0));
            view["scope"] = json!(crate::rules::scope_of(
                row,
                crate::world::Defaults::of(self.policy.as_ref()).symmetric,
            ));
            view["wake"] = match text(row, "hibernate") {
                Some(provider) => json!(format!("hook:{provider}")),
                None => crate::wake::wake_of(row).map_or(Value::Null, |v| json!(v)),
            };
            let active = [
                "created_at",
                "last_seen",
                "hook_seen",
                "last_received_at",
                "mail_at",
            ]
            .iter()
            .filter_map(|k| integer(row, k))
            .max()
            .unwrap_or(0);
            view["active_at"] = json!(timestamp(active));
            if self
                .limits
                .get("historicAfterS")
                .is_some_and(|s| now_ms() - active >= s as i64 * 1000)
            {
                view["historic"] = json!(true);
            }
        }
        let shows_wake = text(row, "hibernate").is_some()
            || text(row, "wake").is_some_and(|w| w == "codex-queue");
        if shows_wake && let Some(note) = text(row, "wake_note") {
            view["wake_failed"] = json!(note.strip_prefix("wake_failed: ").unwrap_or(note));
        }
        if shows_wake && let Some(declined) = text(row, "wake_declined") {
            view["wake_declined"] = json!(declined);
        }
        if crate::claims::revivable(row) {
            view["revivable"] = json!(true);
        }
        Ok(view)
    }

    pub async fn disconnect(&mut self, conn: ConnectionId) {
        let connection = self.state.disconnect(conn);
        if let Some(waker) = connection.as_ref().and_then(|c| c.waker.clone()) {
            let transient = connection
                .as_ref()
                .is_some_and(|c| c.mode == Mode::Transient);
            if let Err(error) = self.waker_closed(&waker, transient).await {
                tracing::error!(%error, "waker close failed");
            }
        }
        if let Some(connection) = connection
            && connection.counts_presence()
            && let Some(endpoint) = connection.endpoint
        {
            let result = self.store.all("UPDATE endpoints SET connections = MAX(connections - 1, 0), last_seen = ?, session = CASE WHEN connections <= 1 AND (hook_seen IS NULL OR hook_seen < ?) THEN NULL ELSE session END WHERE id = ?", &[SqlValue::Int(now_ms()), SqlValue::Int(now_ms()-1_800_000), SqlValue::Text(endpoint.clone())]).await;
            if let Err(error) = result {
                tracing::error!(%error, "disconnect failed");
            } else if !connection.brief {
                let settled = self.store.all("UPDATE endpoints SET status_state = NULL, status_note = NULL WHERE id = ? AND connections = 0 AND (hook_seen IS NULL OR hook_seen < ?) AND status_state IN ('working','waiting') RETURNING id", &[SqlValue::Text(endpoint.clone()), SqlValue::Int(now_ms()-1_800_000)]).await;
                if let Err(error) = self.presence_moved(&endpoint, true, false).await {
                    tracing::error!(%error, "disconnect presence failed");
                }
                match settled {
                    Err(error) => tracing::error!(%error, "disconnect settlement failed"),
                    Ok(rows) if !rows.is_empty() => {
                        let address = self.state.addresses.get(&endpoint).cloned();
                        if let Some(address) = address {
                            self.notify_watchers(
                                json!({"type": "status", "endpoint": address, "status": null}),
                            )
                            .await;
                        }
                    }
                    Ok(_) => {}
                }
            } else {
                let _ = self.presence_moved(&endpoint, false, false).await;
            }
        }
    }

    pub async fn execute(
        shared: SharedCore,
        mut guard: OwnedMutexGuard<Self>,
        conn: ConnectionId,
        method: String,
        params: Map<String, Value>,
    ) -> Result<Value, RpcError> {
        if matches!(method.as_str(), "inbox" | "ask" | "ask_wait") {
            return Self::poll(shared, guard, conn, &method, &params).await;
        }
        if method == "stop_wait" && guard.connection(conn)?.bound() {
            return Self::stop_wait_poll(shared, guard, conn, params).await;
        }
        let mut result = guard.dispatch(conn, &method, &params).await?;
        let wait_s = params
            .get("wait_s")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0)
            .min(guard.limits.get("waitMaxS").unwrap_or(50) as f64);
        let list = "offered";
        let waits = method == "inject"
            && !crate::session::flag(&params, "stop")
            && !crate::session::flag(&params, "count");
        if !waits || wait_s == 0.0 {
            return Ok(result);
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs_f64(wait_s);
        loop {
            if !result
                .get(list)
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty)
            {
                return Ok(result);
            }
            let connection =
                guard.state.connections.get(&conn).ok_or_else(|| {
                    RpcError::new(ErrorCode::Unauthorized, "connection is closed")
                })?;
            let endpoint = connection
                .endpoint
                .clone()
                .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "call hello first"))?;
            let closed = connection.closed.clone();
            let waiter = guard.state.waiter(&endpoint);
            let notified = waiter.notified();
            let disconnected = closed.notified();
            tokio::pin!(notified, disconnected);
            notified.as_mut().enable();
            disconnected.as_mut().enable();
            drop(guard);
            tokio::select! {
                _ = &mut notified => {},
                _ = &mut disconnected => return Ok(result),
                _ = tokio::time::sleep_until(deadline) => return Ok(result),
            }
            guard = shared.clone().lock_owned().await;
            if !guard.state.connections.contains_key(&conn) {
                return Ok(result);
            }
            result = guard.dispatch(conn, &method, &params).await?;
        }
    }
}

const OBSERVER_METHODS: [&str; 8] = [
    "list",
    "snapshot",
    "watch",
    "log",
    "policy",
    "policy_check",
    "cloud_status",
    "bridge_relink",
];
const SCOPE_METHODS: [&str; 16] = [
    "rules",
    "rules_set",
    "rules_widen",
    "rules_lift",
    "grant",
    "group",
    "admin",
    "peers",
    "why",
    "spawn_exit",
    "spawn_steers",
    "spawn_end",
    "spawn_via",
    "peek",
    "peek_set",
    "peek_who",
];

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

pub fn timestamp(ms: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

pub fn text<'a>(row: &'a Row, key: &str) -> Option<&'a str> {
    match row.get(key) {
        Some(SqlValue::Text(value)) => Some(value),
        _ => None,
    }
}

pub fn integer(row: &Row, key: &str) -> Option<i64> {
    match row.get(key) {
        Some(SqlValue::Int(value)) => Some(*value),
        _ => None,
    }
}
