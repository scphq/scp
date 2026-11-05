//! Setup, hooks install and mcp install.

pub mod command;
pub mod cowork;
pub mod desktop;
pub mod files;
pub mod harness;
pub mod hook_cmd;
pub mod hooks_install;
pub mod mcp_install;
pub mod plan;
pub mod verify;

use crate::{Run, Verb};

pub use mcp_install::MCP_WORDS;

pub const VERBS: &[Verb] = &[
    Verb {
        name: "hooks",
        run: Run::Parsed(hooks_install::hooks),
    },
    Verb {
        name: "mcp",
        run: Run::Parsed(mcp_install::mcp),
    },
    Verb {
        name: "setup",
        run: Run::Words(command::setup),
    },
];
