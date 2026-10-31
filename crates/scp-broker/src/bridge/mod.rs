//! The broker's link to a hub: other machines' endpoints as rows, sends forwarded to them, their deliveries injected here.

pub mod across;
pub mod config;
pub mod link;
pub mod route;
pub mod rows;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, OnceLock, RwLock};

use regex::Regex;
use scp_core::protocol::ErrorCode;
use serde_json::{Map, Value, json};
use tokio::sync::Notify;

use crate::core::Core;
use crate::proto::RpcError;
use crate::state::{ConnectionId, Mode};

pub use config::{BridgeConfig, daemon_bridge};
pub use link::{Bridge, relay_socket_url};

/// what this broker knows of the hub's account: its machine name, the account handle and the hub's endpoint rows seen in memory
#[derive(Default)]
pub struct Federation {
    pub machine: Option<String>,
    pub account: Option<String>,
    pub aliases: HashSet<String>,
    pub bridge: Option<Arc<Bridge>>,
    pub observed: HashMap<String, i64>,
    pub env: BTreeMap<String, String>,
    pub restart: Arc<Notify>,
}

struct Others {
    account: String,
    machines: HashSet<String>,
}

static OTHERS: RwLock<Option<Others>> = RwLock::new(None);

/// the account handle another member's machines render under; this member's own stay `me/<machine>/<handle>`
pub fn set_others(account: &str, machines: impl IntoIterator<Item = String>) {
    if let Ok(mut others) = OTHERS.write() {
        *others = Some(Others {
            account: account.to_owned(),
            machines: machines.into_iter().collect(),
        });
    }
}

pub fn set_other(machine: &str, other: bool) {
    if let Ok(mut guard) = OTHERS.write()
        && let Some(others) = guard.as_mut()
    {
        if other {
            others.machines.insert(machine.to_owned());
        } else {
            others.machines.remove(machine);
        }
    }
}

/// how this host renders `<machine>/<handle>` of its own account, or the address of another account's stand-in
pub fn remote_address(remote: &str) -> String {
    if let Some(foreign) = remote.strip_prefix('@') {
        return foreign.to_owned();
    }
    let machine = machine_part(remote);
    let user = OTHERS
        .read()
        .ok()
        .and_then(|guard| {
            guard
                .as_ref()
                .filter(|others| others.machines.contains(machine))
                .map(|others| others.account.clone())
        })
        .unwrap_or_else(|| "me".into());
    format!("{user}/{remote}")
}

pub fn machine_part(remote: &str) -> &str {
    remote
        .split_once('/')
        .map_or(remote, |(machine, _)| machine)
}

pub fn handle_part(remote: &str) -> &str {
    remote.split_once('/').map_or("", |(_, handle)| handle)
}

pub fn is_foreign(remote: &str) -> bool {
    remote.starts_with('@')
}

pub fn valid_machine(name: &str) -> bool {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    name != "me"
        && PATTERN
            .get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,31}$").expect("constant pattern"))
            .is_match(name)
}

pub fn valid_account(name: &str) -> bool {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,63}$").expect("constant pattern"))
        .is_match(name)
}

/// `<machine>/<handle>` as the hub keys an endpoint, the handle empty for a machine's human
pub fn valid_remote(key: &str) -> bool {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            Regex::new(r"^[a-z0-9][a-z0-9._-]{0,63}/([a-z0-9][a-z0-9._-]{0,62})?$")
                .expect("constant pattern")
        })
        .is_match(key)
}

/// a delivery the broker made on its own machine, by local endpoint ids
#[derive(Clone, Debug)]
pub struct LocalDelivery {
    pub id: String,
    pub thread: String,
    pub kind: String,
    pub from: String,
    pub to: Vec<String>,
    pub at: i64,
}

impl Core {
    /// whether a row is this machine's own, not another machine's mirrored or proxied one
    pub fn is_local_row(row: &crate::store::Row) -> bool {
        crate::core::text(row, "remote").is_none()
    }

    pub fn bridge(&self) -> Option<Arc<Bridge>> {
        self.federation.bridge.clone()
    }

    /// a local endpoint was claimed, let go or changed its presence, status or wake: mirrored as a delta
    pub(crate) fn bridge_changed(&self, endpoint: &str) {
        if let Some(bridge) = &self.federation.bridge {
            bridge.changed(endpoint);
        }
    }

    /// rules, caps, groups or a title changed: every mirrored endpoint is sent again
    pub fn bridge_resync(&self) {
        if let Some(bridge) = &self.federation.bridge {
            bridge.resync();
        }
    }

    /// a local endpoint took another handle: the hub renames its mirror in place
    pub fn bridge_renamed(&self, endpoint: &str, was: &str) {
        if let Some(bridge) = &self.federation.bridge {
            bridge.renamed(endpoint, was);
        }
    }

    /// a local endpoint's activity, posted to the hub
    pub fn bridge_activity(&self, endpoint: &str, row: &Value) {
        if let Some(bridge) = &self.federation.bridge {
            bridge.activity(endpoint, row);
        }
    }

    /// a delivery between endpoints of this machine, reported to the hub in the next batch
    pub fn bridge_local(&self, event: LocalDelivery) {
        if let Some(bridge) = &self.federation.bridge {
            bridge.local(event);
        }
    }

    /// links the bridge again with the credential on disk; a configuration this broker cannot take without a restart stops it
    pub fn bridge_relink(&mut self) -> Value {
        let config = daemon_bridge(&self.federation.env, |line| eprintln!("{line}"));
        let bridge = self.federation.bridge.clone();
        match (config, bridge) {
            (None, None) => json!({"enabled": false}),
            (None, Some(bridge)) => {
                bridge.relink();
                bridge.status()
            }
            (Some(config), Some(bridge))
                if config.url == bridge.config.url && config.machine == bridge.config.machine =>
            {
                bridge.relink();
                bridge.status()
            }
            _ => {
                self.federation.restart.notify_one();
                json!({"enabled": false, "restarting": true})
            }
        }
    }

    /// sets or clears the URL the hub calls to wake this machine; only the human sets it
    pub async fn machine_wake(
        &self,
        conn: ConnectionId,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        if !matches!(self.connection(conn)?.mode, Mode::Human { .. }) {
            return Err(RpcError::new(
                ErrorCode::Unauthorized,
                "only the human sets this machine's waker",
            ));
        }
        let Some(bridge) = self.bridge() else {
            return Err(RpcError::new(
                ErrorCode::Unavailable,
                "this broker has no hub link: the machine waker lives on the hub",
            ));
        };
        let url = params.get("url").cloned().unwrap_or(Value::Null);
        if !url.is_null() && !url.is_string() {
            return Err(RpcError::invalid_params(
                "url is an https URL, or null to clear it",
            ));
        }
        let mut sent = json!({"url": url});
        match params.get("secret") {
            None => {}
            Some(Value::String(secret)) => sent["secret"] = json!(secret),
            Some(_) => return Err(RpcError::invalid_params("secret is a string")),
        }
        bridge.machine_wake(sent).await
    }

    /// mirrors these endpoints now: true once the hub took the delta, false when it did not; None without a bridge
    #[allow(dead_code)]
    pub(crate) async fn bridge_mirror(&self, ids: Vec<String>) -> Option<bool> {
        let bridge = self.federation.bridge.clone()?;
        Some(bridge.mirror_now(self, ids).await)
    }
}

/// releases the inbox waiters of an endpoint that got a message from the hub
pub async fn wake_delivered(core: &Arc<tokio::sync::Mutex<Core>>, endpoint: &str) {
    core.lock().await.state.wake(endpoint);
}
