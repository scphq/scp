use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};

pub type ConnectionId = u64;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Unbound,
    Agent,
    Human {
        tty: bool,
    },
    Observer,
    Transient,
}

#[derive(Debug, Clone, Default)]
pub struct Connection {
    pub id: ConnectionId,
    pub endpoint: Option<String>,
    pub mode: Mode,
    pub lineage: Option<String>,
    pub lineage_keys: Vec<String>,
    pub self_keys: Vec<String>,
    pub harness_session: Option<String>,
    pub brief: bool,
    pub own: bool,
    pub process: Option<String>,
    pub terminal: bool,
    pub cwd: Option<String>,
    pub closed: Arc<Notify>,
    pub watching: bool,
    pub events: Option<mpsc::UnboundedSender<Value>>,
    /// the endpoint this connection counts as the waker of
    pub waker: Option<String>,
    /// claimed with a grant or a wake ticket: it may give a durable spawn ref
    pub holder: bool,
    /// the wake ticket a broker wake's run bound this connection with
    pub ticket: Option<String>,
    /// ended by the broker: the connection closes
    pub ended: bool,
    /// the broker's own task process, matched by peer pid at accept
    pub task: bool,
    /// the connection holds its endpoint as a harness session's tool surface, which a newer one of that session supersedes
    pub surface: Option<Surface>,
    /// the frame the connection sends as the broker closes it
    pub farewell: Option<Value>,
}

/// a tool surface: its own id, the harness-instance key and the harness session id it claimed with
#[derive(Debug, Clone, Default)]
pub struct Surface {
    pub instance: String,
    pub process: Option<String>,
    pub harness_session: Option<String>,
}

/// superseded tool surfaces the broker keeps refusing, newest kept
const SUPERSEDED_KEPT: usize = 1024;

impl Connection {
    pub fn bound(&self) -> bool {
        self.mode != Mode::Unbound
    }
    pub fn counts_presence(&self) -> bool {
        self.endpoint.is_some()
            && self.lineage.is_none()
            && matches!(self.mode, Mode::Agent | Mode::Human { .. })
    }
}

#[derive(Default)]
pub struct State {
    pub connections: HashMap<ConnectionId, Connection>,
    pub presence: HashMap<String, usize>,
    pub addresses: HashMap<String, String>,
    pub waiters: HashMap<String, Arc<Notify>>,
    pub closing: bool,
    pub stopping: Arc<Notify>,
    pub subagent_titles: VecDeque<(String, String)>,
    pub deferred: Option<(Option<String>, Value)>,
    /// the presence and address last reported to watchers, by endpoint id
    pub known: HashMap<String, (String, String)>,
    /// the instances of superseded tool surfaces, oldest first
    pub superseded: VecDeque<String>,
    next_id: ConnectionId,
}

impl State {
    pub fn connect(&mut self) -> ConnectionId {
        self.next_id += 1;
        let id = self.next_id;
        self.connections.insert(
            id,
            Connection {
                id,
                ..Connection::default()
            },
        );
        id
    }

    /// a `fleet` notification to one watching connection
    pub fn notify_watcher(&self, conn: ConnectionId, event: Value, at: Option<String>) {
        let mut params = json!({"at": at});
        if let (Some(target), Some(fields)) = (params.as_object_mut(), event.as_object()) {
            target.extend(fields.clone());
        }
        let frame = json!({"jsonrpc": "2.0", "method": "fleet", "params": params});
        if let Some(connection) = self.connections.get(&conn)
            && connection.watching
            && let Some(events) = &connection.events
        {
            let _ = events.send(frame);
        }
    }

    pub fn waiter(&mut self, endpoint: &str) -> Arc<Notify> {
        self.waiters.entry(endpoint.to_owned()).or_default().clone()
    }

    pub fn wake(&self, endpoint: &str) {
        if let Some(waiter) = self.waiters.get(endpoint) {
            waiter.notify_waiters();
        }
    }

    pub fn bind(&mut self, id: ConnectionId, endpoint: Option<String>, mode: Mode) {
        if let Some(connection) = self.connections.get_mut(&id) {
            connection.endpoint = endpoint;
            connection.mode = mode;
            if connection.counts_presence()
                && let Some(endpoint) = &connection.endpoint
            {
                *self.presence.entry(endpoint.clone()).or_default() += 1;
            }
        }
    }

    /// the tool surfaces connections other than `except` hold `endpoint` with
    pub fn surfaces(&self, endpoint: &str, except: ConnectionId) -> Vec<Surface> {
        self.connections
            .values()
            .filter(|c| c.id != except && c.endpoint.as_deref() == Some(endpoint))
            .filter_map(|c| c.surface.clone())
            .collect()
    }

    /// the endpoints connections hold as tool surfaces of harness instance `process` and harness session `session`
    pub fn holders(&self, process: &str, session: &str) -> Vec<String> {
        self.connections
            .values()
            .filter(|c| {
                c.surface.as_ref().is_some_and(|s| {
                    s.process.as_deref() == Some(process)
                        && s.harness_session.as_deref() == Some(session)
                })
            })
            .filter_map(|c| c.endpoint.clone())
            .collect()
    }

    /// tells the tool surfaces of `process` other than `except` holding `endpoint` (at `address`) that a newer one took it over, closes
    /// them, and refuses their instances from now on
    pub fn supersede(
        &mut self,
        endpoint: &str,
        address: &str,
        process: Option<&str>,
        except: ConnectionId,
    ) {
        let mut retired = Vec::new();
        for connection in self.connections.values_mut() {
            let Some(surface) = &connection.surface else {
                continue;
            };
            if connection.id == except
                || connection.endpoint.as_deref() != Some(endpoint)
                || surface.process.as_deref() != process
            {
                continue;
            }
            retired.push(surface.instance.clone());
            connection.farewell = Some(
                json!({"jsonrpc": "2.0", "method": "superseded", "params": {"endpoint": address}}),
            );
            connection.closed.notify_waiters();
        }
        for instance in retired {
            self.superseded.retain(|v| *v != instance);
            self.superseded.push_back(instance);
        }
        while self.superseded.len() > SUPERSEDED_KEPT {
            self.superseded.pop_front();
        }
    }

    pub fn close_endpoint(&self, endpoint: &str, except: ConnectionId) {
        for connection in self.connections.values() {
            if connection.id != except && connection.endpoint.as_deref() == Some(endpoint) {
                connection.closed.notify_waiters();
            }
        }
    }

    pub fn disconnect(&mut self, id: ConnectionId) -> Option<Connection> {
        let connection = self.connections.remove(&id)?;
        connection.closed.notify_waiters();
        if connection.counts_presence()
            && let Some(endpoint) = &connection.endpoint
        {
            if let Some(count) = self.presence.get_mut(endpoint) {
                *count = count.saturating_sub(1);
            }
            self.wake(endpoint);
        }
        Some(connection)
    }
}
