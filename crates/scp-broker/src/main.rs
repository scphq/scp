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

fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .init();
    let Cli {
        command: Command::Daemon { idle, policy },
    } = Cli::parse();
    let result = daemon::runtime()
        .map_err(Into::into)
        .and_then(|runtime| runtime.block_on(daemon::run(idle, policy)));
    if let Err(error) = result {
        eprintln!("scp-broker: {error}");
        std::process::exit(1);
    }
}
