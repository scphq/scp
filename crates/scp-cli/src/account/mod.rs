//! Relay, login, logout and cloud.

pub mod cloud;
pub mod login;
pub mod relay;

use crate::{Run, Verb};

pub const VERBS: &[Verb] = &[
    Verb {
        name: "relay",
        run: Run::Parsed(relay::relay),
    },
    Verb {
        name: "login",
        run: Run::Parsed(login::login),
    },
    Verb {
        name: "logout",
        run: Run::Parsed(relay::logout),
    },
    #[cfg(unix)]
    Verb {
        name: "cloud",
        run: Run::Parsed(cloud::cloud),
    },
];
