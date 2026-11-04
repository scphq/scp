//! Spawn, spawn-wake and codex-wake.

use crate::{Run, Verb};

pub mod argv;
pub mod grant;
pub mod harness;
pub mod hold;
pub mod muse;
pub mod output;
pub mod run;
pub mod runner;
pub mod settings;
pub mod signals;
pub mod text;

pub const VERBS: &[Verb] = &[Verb {
    name: "spawn",
    run: Run::Words(run::spawn),
}];
