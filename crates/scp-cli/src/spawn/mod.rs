//! Spawn, spawn-wake and codex-wake.

use crate::{Run, Verb};

pub mod argv;
pub mod codex_queue;
pub mod grant;
pub mod harness;
pub mod hold;
pub mod muse;
pub mod output;
pub mod remote;
pub mod run;
pub mod runner;
pub mod settings;
pub mod signals;
pub mod text;
pub mod wake;

pub const VERBS: &[Verb] = &[
    Verb {
        name: "spawn",
        run: Run::Words(run::spawn),
    },
    Verb {
        name: "spawn-wake",
        run: Run::Words(wake::spawn_wake),
    },
    Verb {
        name: "codex-wake",
        run: Run::Words(|call, _| codex_queue::codex_wake(call)),
    },
];

/// verbs the broker runs: they take no flags, so no flag or variable hands them back
pub const BROKER_VERBS: [&str; 2] = ["spawn-wake", "codex-wake"];
