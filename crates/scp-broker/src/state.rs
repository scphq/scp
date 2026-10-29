use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Notify;

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
}

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
