//! Claude, claude-bg-task and claude-wake.

pub mod bg_cmd;
pub mod bg_io;
pub mod bg_plan;
pub mod bg_state;
pub mod launch;

use crate::{Run, Verb};

pub const VERBS: &[Verb] = &[
    Verb {
        name: "claude",
        run: Run::Words(launch::claude),
    },
    Verb {
        name: "claude-bg-task",
        run: Run::Words(|call, words| bg_cmd::task(words, call.env, call.host)),
    },
    Verb {
        name: "claude-wake",
        run: Run::Words(|call, words| bg_cmd::wake(words, call.env, call.host)),
    },
];

/// verbs the broker runs: they take no flags, so no flag or variable hands them back
pub const BROKER_VERBS: [&str; 2] = ["claude-bg-task", "claude-wake"];
