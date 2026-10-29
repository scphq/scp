use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use clap::{Parser, Subcommand};
use scp_broker::paths::{Paths, account_home};
use scp_broker::proto::Limits;
use scp_broker::server::{Broker, BrokerOptions};

const EXPERIMENTAL: &str = "SCP_BROKER_EXPERIMENTAL";

#[derive(Parser)]
#[command(name = "scp-broker")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Daemon {
        #[arg(long, default_value = "1800", value_parser = idle_seconds)]
        idle: f64,
        #[arg(long)]
        policy: Option<PathBuf>,
    },
}

fn idle_seconds(raw: &str) -> Result<f64, String> {
    raw.parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= u32::MAX as f64)
        .ok_or_else(|| "idle must be a nonnegative number of seconds".into())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    if let Err(error) = run().await {
        eprintln!("scp-broker: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let Cli {
        command: Command::Daemon { idle, policy },
    } = Cli::parse();
    let env: BTreeMap<String, String> = std::env::vars().collect();
    if env.get(EXPERIMENTAL).map(String::as_str) != Some("1") {
        return Err(format!(
            "this native broker is experimental: list and log do not filter by visibility yet, so any session sees every endpoint and the whole audit log. Set {EXPERIMENTAL}=1 to run it anyway, never as a shared broker"
        )
        .into());
    }
    let path_env = env.clone();
    let (paths, policy_file) = tokio::task::spawn_blocking(move || {
        let paths = Paths::from_env(&path_env)?;
        let home =
            account_home().or_else(|error| path_env.get("HOME").map(PathBuf::from).ok_or(error));
        let policy_file = match policy {
            Some(path) => path,
            None => home?.join(".config/scp/policy.json"),
        };
        Ok::<_, std::io::Error>((paths, policy_file))
    })
    .await??;
    let limits = Limits::from_env(&env)
        .await
        .map_err(std::io::Error::other)?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let broker = Broker::start(BrokerOptions {
        paths,
        limits,
        policy_file,
        idle: Duration::from_secs_f64(idle),
    })
    .await?;
    broker
        .run(async move {
            tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
        })
        .await?;
    Ok(())
}
