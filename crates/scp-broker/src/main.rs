use std::path::PathBuf;

use clap::{Parser, Subcommand};
use scp_broker::daemon::{self, idle_seconds};

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

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    let Cli {
        command: Command::Daemon { idle, policy },
    } = Cli::parse();
    if let Err(error) = daemon::run(idle, policy).await {
        eprintln!("scp-broker: {error}");
        std::process::exit(1);
    }
}
