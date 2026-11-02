//! The stdio MCP server: newline-delimited JSON-RPC 2.0 to the client, one broker connection behind it.

use crate::client::{CallError, Client};
use crate::inbox::SessionInbox;
use crate::{Claim, LocalFuture, Membership};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

/// what relay_spawn asks for: `swarm spawn --bg` of `command`, acting as `as_`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpawnRequest {
    pub command: Vec<String>,
    pub as_: String,
    pub harness: Option<String>,
    pub name: Option<String>,
    pub title: Option<String>,
    pub no_push: bool,
    pub handback_bytes: Option<u64>,
    /// absolute and existing
    pub cwd: Option<PathBuf>,
}

/// a started worker
#[derive(Debug, Clone, PartialEq)]
pub struct Spawned {
    pub name: String,
    pub pid: u32,
}

pub type Connect = Rc<dyn Fn() -> LocalFuture<'static, Result<Client, CallError>>>;
pub type SpawnFn = Rc<dyn Fn(SpawnRequest) -> LocalFuture<'static, Result<Spawned, String>>>;

pub struct Options {
    /// a fresh connection to the broker (starting it if needed)
    pub connect: Connect,
    /// the agent endpoint this shim claims
    pub claim: Claim,
    pub membership: Option<Rc<dyn Fn(&str) -> Membership>>,
    /// the claim for the thread a tools/call's `_meta` names; the first such call binds the shim for good
    pub thread_claim: Option<Rc<dyn Fn(&Map<String, Value>) -> Option<Claim>>>,
    pub defer_claim: bool,
    pub bound: Option<Rc<dyn Fn(&Claim)>>,
    pub env: HashMap<String, String>,
    pub channels: bool,
    pub launched_with_channels: bool,
    pub session_inbox: Option<SessionInbox>,
    pub wake: Option<String>,
    pub version: Option<String>,
    pub spawn: Option<SpawnFn>,
    /// diagnostics, never stdout
    pub log: Rc<dyn Fn(&str)>,
    pub heartbeat_ms: u64,
}

/// serves MCP on `input` until it ends, writing each JSON-RPC line (newline included) with `output`
pub async fn run<R>(_options: Options, _input: R, _output: Rc<dyn Fn(&str)>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    todo!()
}
