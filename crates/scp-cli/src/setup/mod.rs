//! Setup, hooks install and mcp install.

pub mod hook_cmd;
pub mod hooks_install;
pub mod mcp_install;

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
];
