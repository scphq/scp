use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::paths::Paths;
use crate::procs::Procs;
use crate::proto::{CAPABILITIES, ErrorCode, Limits, PREAMBLE, PROTOCOL, RpcError};
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
            .all("UPDATE endpoints SET connections = 0", &[])
            .await?;
        store
            .all(
                "UPDATE endpoints SET wakers = 0, waker_left = ? WHERE wakers > 0",
                &[SqlValue::Int(now_ms())],
            )
            .await?;
        let mut state = State::default();
        for row in store.read("SELECT id FROM endpoints", &[]).await? {
            if let Some(id) = text(&row, "id") {
                state.presence.insert(id.to_owned(), 0);
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
            Ok(text) => match serde_json::from_str(&text) {
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
        let mut result = json!({"endpoint": endpoint, "capabilities": CAPABILITIES, "server_time": timestamp(now_ms()), "limits": self.limits, "preamble": PREAMBLE, "broker": self.broker_info()});
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
        let connection = self
            .state
            .connections
            .get(&conn)
            .filter(|c| c.bound())
            .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "call hello first"))?;
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
                "this connection only observes: say hello as an agent or the human",
            ));
        }
        match method {
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
        if params.get("transient") == Some(&Value::Bool(true)) {
            return crate::claims::hello_claim(self, conn, params).await;
        }
        if params.get("observe") == Some(&Value::Bool(true)) {
            self.state.bind(conn, None, Mode::Observer);
            if let Some(connection) = self.state.connections.get_mut(&conn) {
                connection.lineage_keys = params
                    .get("lineage")
                    .and_then(Value::as_array)
                    .map(|v| {
                        v.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                connection.self_keys = params
                    .get("self")
                    .and_then(Value::as_array)
                    .map(|v| {
                        v.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                connection.harness_session = params
                    .get("harness_session")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            return Ok(self.hello_result(Value::Null, None));
        }
        if params.get("human") == Some(&Value::Bool(true)) && !params.contains_key("resume") {
            let tty = params.get("tty") == Some(&Value::Bool(true));
            let rows = self.store.all("UPDATE endpoints SET connections = connections + 1, last_seen = ? WHERE handle = '_human' RETURNING *", &[SqlValue::Int(now_ms())]).await?;
            let row = rows.first().ok_or_else(RpcError::internal)?;
            let id = text(row, "id").ok_or_else(RpcError::internal)?.to_owned();
            self.state.bind(conn, Some(id.clone()), Mode::Human { tty });
            if let Some(connection) = self.state.connections.get_mut(&conn) {
                connection.brief = params.get("brief") == Some(&Value::Bool(true));
                connection.cwd = params.get("cwd").and_then(Value::as_str).map(str::to_owned);
            }
            self.store
                .all(
                    "INSERT INTO audit (at, event, endpoint, detail) VALUES (?, 'claim', ?, ?)",
                    &[
                        SqlValue::Int(now_ms()),
                        SqlValue::Text(id),
                        SqlValue::Text(
                            json!({"handle":"", "harness":"human", "tty":tty}).to_string(),
                        ),
                    ],
                )
                .await?;
            return Ok(self.hello_result(self.endpoint_view(row)?, None));
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
            "labels": labels, "title": text(row, "title"), "presence": if integer(row, "connections").unwrap_or(0) > 0 { "online" } else { "offline" },
            "status": status, "last_seen": integer(row, "last_seen").and_then(timestamp),
        });
        if text(row, "kind") == Some("agent") {
            view["parent"] = Value::Null;
            view["depth"] = json!(integer(row, "depth").unwrap_or(0));
            view["scope"] = json!("open");
            view["wake"] = text(row, "wake").map_or(Value::Null, |v| json!(v));
            view["active_at"] = json!(integer(row, "last_seen").and_then(timestamp));
        }
        Ok(view)
    }

    pub async fn disconnect(&mut self, conn: ConnectionId) {
        if let Some(connection) = self.state.disconnect(conn)
            && connection.counts_presence()
            && let Some(endpoint) = connection.endpoint
        {
            let result = self.store.all("UPDATE endpoints SET connections = MAX(connections - 1, 0), last_seen = ? WHERE id = ?", &[SqlValue::Int(now_ms()), SqlValue::Text(endpoint)]).await;
            if let Err(error) = result {
                tracing::error!(%error, "disconnect failed");
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
        let mut result = guard.dispatch(conn, &method, &params).await?;
        let wait_s = params
            .get("wait_s")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.0)
            .min(50.0);
        if method != "inbox" || wait_s == 0.0 {
            return Ok(result);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs_f64(wait_s);
        loop {
            if !result
                .get("messages")
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
            result = guard.dispatch(conn, &method, &params).await?;
        }
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
