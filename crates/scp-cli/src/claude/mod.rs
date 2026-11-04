//! Claude, claude-bg-task and claude-wake.

pub mod bg_cmd;
pub mod bg_io;
pub mod bg_plan;
pub mod bg_state;

use crate::{Run, Verb};

pub const VERBS: &[Verb] = &[
    Verb {
        name: "claude",
        run: Run::Words(bg_cmd::claude),
    },
    Verb {
        name: "claude-bg-task",
        run: Run::Words(bg_cmd::task),
    },
    Verb {
        name: "claude-wake",
        run: Run::Words(bg_cmd::wake),
    },
];

/// the first words `swarm claude` runs natively; any other goes to the TypeScript CLI
pub const CLAUDE_WORDS: [&str; 2] = ["ls", "prune"];
/// verbs the broker runs: they take no flags, so no flag or variable hands them back
pub const BROKER_VERBS: [&str; 2] = ["claude-bg-task", "claude-wake"];
