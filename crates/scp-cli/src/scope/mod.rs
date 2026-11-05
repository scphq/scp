//! Rules, group, admin, spawn-env, holds, peek and set-peek.

pub mod holds;
pub mod peek;
pub mod rules;
pub mod spawn_env;
pub mod text;

use crate::fleet::json::Json;
use crate::{Run, Verb};

pub const VERBS: &[Verb] = &[
    Verb {
        name: "rules",
        run: Run::Opened(rules::rules),
    },
    Verb {
        name: "group",
        run: Run::Opened(rules::group),
    },
    Verb {
        name: "admin",
        run: Run::Opened(rules::admin),
    },
    Verb {
        name: "spawn-env",
        run: Run::Opened(spawn_env::spawn_env),
    },
    Verb {
        name: "holds",
        run: Run::Parsed(holds::holds),
    },
    Verb {
        name: "peek",
        run: Run::Opened(peek::peek),
    },
    Verb {
        name: "set-peek",
        run: Run::Opened(peek::set_peek),
    },
];

/// `{ <key> }` as a shorthand object literal prints it: without the key when the reply lacked it
fn shorthand(key: &str, value: Option<&Json>) -> String {
    Json::object(value.map(|v| (key, v.clone())).into_iter().collect()).pretty()
}
