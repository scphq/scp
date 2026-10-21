use clap::{Parser, Subcommand, ValueEnum};
use scp_relay::{
    admin,
    http::{AppState, Limits, router},
    normalize_code, now_ms,
};
use scp_relay_store::{Role, StoreError, connect};
use serde_json::json;
use std::{io::IsTerminal, net::SocketAddr};

#[derive(Parser)]
#[command(name = "scp-relay", version, about = "Self-hosted SCP relay")]
struct Cli {
    #[arg(
        long,
        global = true,
        env = "SCP_RELAY_STORE",
        default_value = "sqlite://relay.db"
    )]
    store: String,
    #[arg(long, global = true, env = "SCP_RELAY_LOG_FORMAT", value_enum)]
    log_format: Option<LogFormat>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Clone, Copy, ValueEnum)]
enum LogFormat {
    Json,
    Pretty,
}
#[derive(Clone, Copy, ValueEnum)]
enum RoleArg {
    Owner,
    Admin,
    Member,
}
impl From<RoleArg> for Role {
    fn from(v: RoleArg) -> Self {
        match v {
            RoleArg::Owner => Self::Owner,
            RoleArg::Admin => Self::Admin,
            RoleArg::Member => Self::Member,
        }
    }
}
#[derive(Clone, Copy, ValueEnum)]
enum ContactAction {
    Invite,
    Accept,
    Decline,
    Revoke,
    Block,
    Update,
}
#[derive(Clone, Copy, ValueEnum)]
enum ContactDirection {
    In,
    Out,
    Both,
}
#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long, env = "SCP_RELAY_LISTEN", default_value = "127.0.0.1:8787")]
        listen: SocketAddr,
        #[arg(long, env = "SCP_RELAY_PUBLIC_URL")]
        public_url: Option<String>,
        #[arg(long = "limit", env = "SCP_RELAY_LIMIT", value_delimiter = ',')]
        limits: Vec<String>,
    },
    Account {
        #[command(subcommand)]
        command: AccountCommand,
    },
    Token {
        #[command(subcommand)]
        command: TokenCommand,
    },
    Contact {
        #[arg(value_enum)]
        action: ContactAction,
        peer: String,
        #[arg(long, env = "SCP_RELAY_ACCOUNT")]
        account: String,
        #[arg(long)]
        allow: Option<String>,
        #[arg(long, value_enum)]
        dir: Option<ContactDirection>,
        #[arg(long)]
        limits: Option<String>,
    },
    Device {
        #[command(subcommand)]
        command: DeviceCommand,
    },
}
#[derive(Subcommand)]
enum AccountCommand {
    Create {
        #[arg(env = "SCP_RELAY_ACCOUNT")]
        handle: String,
    },
}
#[derive(Subcommand)]
enum TokenCommand {
    Create {
        #[arg(long, env = "SCP_RELAY_ACCOUNT")]
        account: String,
        #[arg(long, env = "SCP_RELAY_MEMBER")]
        member: String,
        #[arg(long, env = "SCP_RELAY_ROLE", value_enum)]
        role: Option<RoleArg>,
        #[arg(long, env = "SCP_RELAY_DEVICE")]
        device: bool,
        #[arg(long, env = "SCP_RELAY_NAME", default_value = "cli")]
        name: String,
        #[arg(long, env = "SCP_RELAY_EMAIL")]
        email: Option<String>,
        #[arg(long, env = "SCP_RELAY_EXPIRES_IN")]
        expires_in: Option<u64>,
    },
    Revoke {
        #[arg(env = "SCP_RELAY_CREDENTIAL_ID")]
        credential_id: String,
    },
}
#[derive(Subcommand)]
enum DeviceCommand {
    Approve {
        #[arg(env = "SCP_RELAY_USER_CODE")]
        user_code: String,
        #[arg(long, env = "SCP_RELAY_ACCOUNT")]
        account: String,
        #[arg(long, env = "SCP_RELAY_MEMBER")]
        member: String,
    },
    Deny {
        #[arg(env = "SCP_RELAY_USER_CODE")]
        user_code: String,
    },
}
#[tokio::main]
async fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    let format = cli.log_format.unwrap_or_else(|| {
        if std::io::stderr().is_terminal() {
            LogFormat::Pretty
        } else {
            LogFormat::Json
        }
    });
    match format {
        LogFormat::Json => tracing_subscriber::fmt()
            .json()
            .with_writer(std::io::stderr)
            .init(),
        LogFormat::Pretty => tracing_subscriber::fmt()
            .pretty()
            .with_writer(std::io::stderr)
            .init(),
    }
    match run(cli).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!(error=%e,"relay command failed");
            std::process::ExitCode::FAILURE
        }
    }
}
async fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    let store = connect(&cli.store).await?;
    match cli.command {
        Command::Serve {
            listen,
            public_url,
            limits,
        } => {
            let mut configured = Limits::default();
            for limit in limits {
                configured.apply(&limit).map_err(std::io::Error::other)?;
            }
            let listener = tokio::net::TcpListener::bind(listen).await?;
            let addr = listener.local_addr()?;
            let url = format!("http://{addr}");
            let state = AppState::new(store, public_url.unwrap_or_else(|| url.clone()), configured);
            let hub = state.hub.clone();
            let draining = hub.clone();
            let maintenance = tokio::spawn(hub.clone().maintain());
            println!("{}", json!({"event":"listening","url":url}));
            axum::serve(listener, router(state))
                .with_graceful_shutdown(async move {
                    shutdown_signal().await;
                    hub.shutdown();
                })
                .await?;
            let _ = maintenance.await;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), draining.wait_closed())
                .await;
        }
        Command::Account {
            command: AccountCommand::Create { handle },
        } => {
            let a = admin::account(store.as_ref(), &handle).await?;
            println!("{}", json!({"id":a.id,"handle":a.handle}));
        }
        Command::Contact {
            action,
            peer,
            account,
            allow,
            dir,
            limits,
        } => {
            let a = store
                .account(&account)
                .await?
                .ok_or_else(|| std::io::Error::other(format!("unknown account: {account}")))?;
            let b = store
                .account(&peer)
                .await?
                .ok_or_else(|| std::io::Error::other(format!("unknown peer: {peer}")))?;
            let now = now_ms();
            match action {
                ContactAction::Invite => store.contact_invite(&a.id, &b.id, now).await?,
                ContactAction::Accept => store.contact_accept(&a.id, &b.id, now).await?,
                ContactAction::Decline => store.contact_decline(&a.id, &b.id, now).await?,
                ContactAction::Revoke => store.contact_revoke(&a.id, &b.id, now).await?,
                ContactAction::Block => store.contact_block(&a.id, &b.id, now).await?,
                ContactAction::Update => {
                    let mut config = store
                        .contact(&a.id, &b.id)
                        .await?
                        .ok_or(StoreError::NotFound)?
                        .config;
                    if let Some(allow) = allow {
                        config.allow = serde_json::from_str(&allow)?;
                    }
                    if let Some(dir) = dir {
                        config.dir = match dir {
                            ContactDirection::In => "in",
                            ContactDirection::Out => "out",
                            ContactDirection::Both => "both",
                        }
                        .into();
                    }
                    if let Some(limits) = limits {
                        config.limits = serde_json::from_str(&limits)?;
                    }
                    store.contact_update(&a.id, &b.id, config, now).await?;
                }
            }
            let state = store.contact(&a.id, &b.id).await?.map(|c| c.state);
            println!(
                "{}",
                json!({"account":a.handle,"peer":b.handle,"state":state})
            );
        }
        Command::Token {
            command:
                TokenCommand::Create {
                    account,
                    member,
                    role,
                    device,
                    name,
                    email,
                    expires_in,
                },
        } => {
            let (a, m) = admin::member(
                store.as_ref(),
                &account,
                &member,
                email,
                role.map(Into::into),
            )
            .await?;
            let expiry = expires_in
                .map(|s| {
                    i64::try_from(s)
                        .ok()
                        .and_then(|v| v.checked_mul(1000))
                        .and_then(|v| now_ms().checked_add(v))
                        .ok_or(StoreError::Conflict)
                })
                .transpose()?;
            let (secret, c) = admin::credential(&a, &m, device, name, expiry);
            store.create_credential(c.clone()).await?;
            println!(
                "{}",
                json!({"token":secret,"credential_id":c.id,"kind":c.kind,"account":a.handle,"member":m.name})
            );
        }
        Command::Token {
            command: TokenCommand::Revoke { credential_id },
        } => {
            let revoked = store.revoke_credential(&credential_id, now_ms()).await?;
            println!("{}", json!({"revoked":revoked}));
        }
        Command::Device {
            command:
                DeviceCommand::Approve {
                    user_code,
                    account,
                    member,
                },
        } => {
            let (a, m) = admin::member(store.as_ref(), &account, &member, None, None).await?;
            store
                .approve_device(&normalize_code(&user_code), &a.id, &m.id, now_ms())
                .await?;
            println!("{}", json!({"approved":true}));
        }
        Command::Device {
            command: DeviceCommand::Deny { user_code },
        } => {
            store
                .deny_device(&normalize_code(&user_code), now_ms())
                .await?;
            println!("{}", json!({"denied":true}));
        }
    }
    Ok(())
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {_ = tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
            }
            Err(e) => {
                tracing::error!(error=%e,"cannot register termination signal");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
