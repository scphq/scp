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
        let mut core = Self {
            store,
            limits,
            policy: None,
            procs: Procs::new(),
            state,
            paths,
            policy_file,
            policy_error: None,
        };
        core.load_policy().await;
        Ok(core)
    }

    pub async fn load_policy(&mut self) {
        match tokio::fs::read_to_string(&self.policy_file).await {
            Ok(text) => match serde_json::from_str::<Value>(&text)
                .map_err(|e| e.to_string())
                .and_then(|v| {
                    crate::policy::Policy::parse(&v)
                        .map(|p| p.0)
                        .map_err(|e| e.message)
                }) {
                Ok(policy) => {
                    self.policy = Some(policy);
                    self.policy_error = None;
                }
                Err(error) => {
                    self.policy = None;
                    self.policy_error = Some(format!("the relay policy is invalid ({error})"));
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if tokio::fs::symlink_metadata(&self.policy_file).await.is_ok() {
                    self.policy_error = Some("the relay policy is a link to a missing file".into());
                } else {
                    self.policy = None;
                    self.policy_error = None;
                }
            }
            Err(error) => {
                self.policy = None;
                self.policy_error = Some(format!("the relay policy cannot be read ({error})"));
            }
        }
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
        if connection.mode == Mode::Observer
            && !matches!(
                method,
                "list"
                    | "snapshot"
                    | "watch"
                    | "log"
                    | "policy"
                    | "policy_check"
                    | "cloud_status"
                    | "bridge_relink"
            )
        {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "this connection only observes",
            ));
        }
        if connection.mode == Mode::Transient {
            if matches!(method, "rules" | "rules_set" | "grant" | "group" | "admin") {
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
        let endpoint = connection.endpoint.clone().unwrap_or_default();
        if !endpoint.is_empty() {
            self.touch(&endpoint).await?;
        }
        match method {
            "whoami" => self.view(&self.must_endpoint(&endpoint).await?).await,
            "list" => self.list_endpoints(params).await,
            "rename" => self.rename(conn, params).await,
            "leave" => self.leave(conn, params).await,
            "adopt" => self.adopt(conn, params).await,
            "relink" => self.relink(conn, params).await,
            "event" => self.event(conn, params).await,
            "grant" => self.grant(conn, params).await,
            "log" => self.audit_log(params).await,
            "send" | "ask" => self.send_rpc(conn, method, params).await,
            "ask_wait" => self.ask_wait(&endpoint, params).await,
            "inbox" if params.get("offer") == Some(&Value::Bool(true)) => {
                self.offer(conn, &endpoint, params).await
            }
            "inbox" => self.inbox(&endpoint, params).await,
            "ack" => {
                self.ack(&endpoint, params.get("seqs").unwrap_or(&Value::Null))
                    .await
            }
            "message" => self.message_rpc(&endpoint, params).await,
            "receipts" => self.receipts(&endpoint, params).await,
            "watch" => self.watch(conn).await,
            "policy" => self.policy_rpc(conn).await,
            "status" => self.status(&endpoint, params).await,
            "title" => {
                self.title(&endpoint, params.get("text"), &connection.mode)
                    .await
            }
            "title_infer" => self.title_infer(&endpoint, params).await,
            "prompted" => self.prompted(&endpoint, params).await,
            "rules" => self.rules(&endpoint).await,
            "rules_set" => self.rules_set(&endpoint, params).await,
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
        crate::claims::hello_claim(self, conn, params).await
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
            view["scope"] = json!(crate::rules::scope_of(row));
            view["wake"] = text(row, "wake").map_or(Value::Null, |v| json!(v));
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
        Ok(view)
    }

    pub async fn disconnect(&mut self, conn: ConnectionId) {
        if let Some(connection) = self.state.disconnect(conn)
            && connection.counts_presence()
            && let Some(endpoint) = connection.endpoint
        {
            let result = self.store.all("UPDATE endpoints SET connections = MAX(connections - 1, 0), last_seen = ?, session = CASE WHEN connections <= 1 AND (hook_seen IS NULL OR hook_seen < ?) THEN NULL ELSE session END WHERE id = ?", &[SqlValue::Int(now_ms()), SqlValue::Int(now_ms()-1_800_000), SqlValue::Text(endpoint.clone())]).await;
            if let Err(error) = result {
                tracing::error!(%error, "disconnect failed");
            } else if !connection.brief {
                let settled = self.store.all("UPDATE endpoints SET status_state = NULL, status_note = NULL WHERE id = ? AND connections = 0 AND (hook_seen IS NULL OR hook_seen < ?) AND status_state IN ('working','waiting')", &[SqlValue::Text(endpoint), SqlValue::Int(now_ms()-1_800_000)]).await;
                if let Err(error) = settled {
                    tracing::error!(%error, "disconnect settlement failed");
                }
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
        guard.dispatch(conn, &method, &params).await
    }
}

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
