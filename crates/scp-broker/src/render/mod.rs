//! The broker's hook renderer: what a native hook binary hands over through the `hook` RPC, rendered in process.

pub mod run;
pub mod text;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Map, Value};

use crate::core::now_ms;
use crate::hooks::{HookClient, HookContext, HookHandler, HookOutput, HookParams};
use crate::proto::RpcError;
use run::{Hook, Host, Rpc, run_hook};

/// how often a running hook checks whether its connections must close
const WATCH: Duration = Duration::from_millis(25);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[async_trait]
impl Rpc for HookClient {
    async fn hello(&self, params: Map<String, Value>) -> Result<Value, RpcError> {
        HookClient::hello(self, params).await
    }

    async fn request(&self, method: &str, params: Map<String, Value>) -> Result<Value, RpcError> {
        HookClient::request(self, method, params).await
    }
}

/// renders hooks for the relay in `dir`; writes a hook asks for go only there or to the config dir
pub struct Renderer {
    dir: PathBuf,
    config_dir: PathBuf,
}

impl Renderer {
    pub fn new(dir: PathBuf, config_dir: PathBuf) -> Self {
        Self { dir, config_dir }
    }
}

/// `$XDG_CONFIG_HOME/scp`, else `$HOME/.config/scp`
pub fn config_dir(env: &std::collections::BTreeMap<String, String>) -> std::io::Result<PathBuf> {
    let nonempty = |key: &str| env.get(key).filter(|v| !v.is_empty());
    let base = match (nonempty("XDG_CONFIG_HOME"), nonempty("HOME")) {
        (Some(config), _) => PathBuf::from(config),
        (None, Some(home)) => Path::new(home).join(".config"),
        (None, None) => crate::paths::account_home()?.join(".config"),
    };
    Ok(base.join("scp"))
}

/// whether `path` is a file whose directory is `root` or inside it, links resolved
fn inside(path: &str, roots: &[&Path]) -> bool {
    let parent = match Path::new(path).parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let Ok(parent) = std::fs::canonicalize(parent) else {
        return false;
    };
    roots
        .iter()
        .any(|root| std::fs::canonicalize(root).is_ok_and(|root| parent.starts_with(root)))
}

struct Live {
    context: HookContext,
    origin: f64,
    ends: Mutex<f64>,
    clients: Mutex<Vec<Arc<HookClient>>>,
    dir: PathBuf,
    config_dir: PathBuf,
}

impl Live {
    async fn close(&self) {
        let clients: Vec<_> = lock(&self.clients).clone();
        for client in clients {
            client.close().await;
        }
    }
}

#[async_trait]
impl Host for Live {
    async fn connect(&self) -> Arc<dyn Rpc> {
        let client = Arc::new(self.context.connect().await);
        lock(&self.clients).push(client.clone());
        client
    }

    fn deadline(&self, ms: f64) {
        let ends = self.origin + ms;
        *lock(&self.ends) = ends;
        self.context.notify(ends as i64);
    }

    fn remaining(&self) -> f64 {
        *lock(&self.ends) - now_ms() as f64
    }

    async fn print(&self, text: &str) -> bool {
        self.context.print(text).await
    }

    fn stopping(&self) -> bool {
        self.context.closed()
    }

    fn allow_write(&self, path: &str) -> bool {
        inside(path, &[&self.dir, &self.config_dir])
    }
}

async fn watch(live: Arc<Live>) {
    loop {
        tokio::time::sleep(WATCH).await;
        if live.context.closed() || now_ms() as f64 >= *lock(&live.ends) {
            live.close().await;
        }
    }
}

/// the first absolute of the hook's cwd, its $PWD and its $HOME, else `/`
fn hook_cwd(params: &HookParams) -> String {
    [
        params.cwd.as_ref(),
        params.env.get("PWD"),
        params.env.get("HOME"),
    ]
    .into_iter()
    .flatten()
    .find(|path| path.starts_with('/'))
    .cloned()
    .unwrap_or_else(|| "/".into())
}

#[async_trait]
impl HookHandler for Renderer {
    async fn handle(
        &self,
        params: HookParams,
        context: HookContext,
    ) -> Result<HookOutput, RpcError> {
        let live = Arc::new(Live {
            context,
            origin: params.origin,
            ends: Mutex::new(params.ends),
            clients: Mutex::default(),
            dir: self.dir.clone(),
            config_dir: self.config_dir.clone(),
        });
        let hook = Hook {
            cwd: hook_cwd(&params),
            args: params.args,
            payload: params.payload,
            env: params.env.into_iter().collect(),
            state_dir: self.dir.to_string_lossy().into_owned(),
            began: params.origin,
            ppid: params.ppid as i64,
            procs: params.procs,
            harness_pid: params.harness_pid.map(|pid| pid as i64),
        };
        let watcher = tokio::spawn(watch(live.clone()));
        let result = run_hook(&hook, live.as_ref()).await;
        watcher.abort();
        live.close().await;
        result.map(|stdout| HookOutput {
            stdout: stdout.filter(|s| !s.is_empty()),
            stderr: None,
        })
    }
}

#[cfg(test)]
mod tests;
