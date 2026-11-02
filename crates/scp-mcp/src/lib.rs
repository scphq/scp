//! The SCP MCP server over stdio: `swarm mcp`.

pub mod client;
pub mod identity;
pub mod inbox;
pub mod membership;
pub mod ps;
pub mod render;
pub mod server;
pub mod shim;
pub mod spawn;
pub mod tools;

use serde_json::{Map, Value};
use std::future::Future;
use std::pin::Pin;

/// a claim as the broker's `hello` takes it
pub type Claim = Map<String, Value>;

/// a boxed future on the shim's single-threaded runtime
pub type LocalFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// whether a harness session is on the relay now
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Membership {
    /// off the relay, saying why
    Dark(String),
    /// on it, under the handle it joined as, if any
    Joined(Option<String>),
}

/// `swarm mcp <args>`: the words after `mcp`. Owns stdin and stdout, logs to stderr, returns the exit code.
pub fn main(args: &[String]) -> i32 {
    shim::main(args)
}
