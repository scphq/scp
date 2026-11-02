//! One NDJSON JSON-RPC connection to the local broker.

use serde_json::Value;
use std::path::Path;
use std::rc::Rc;

/// a broker refusal (`code: message`) or a transport failure
#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    Relay {
        code: String,
        message: String,
        retry_after_s: Option<f64>,
    },
    Io(String),
}

pub struct Client {}

impl Client {
    pub async fn request(&self, _method: &str, _params: Value) -> Result<Value, CallError> {
        todo!()
    }
    pub fn close(&self) {}
}

/// a connection to the broker for `dir`, starting it with `start` when it is not running (connectBroker)
pub async fn connect_broker(_dir: &Path, _start: Option<Rc<dyn Fn()>>) -> Result<Client, CallError> {
    todo!()
}
