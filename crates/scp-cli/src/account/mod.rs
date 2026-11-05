//! Relay, login, logout, cloud and machines, and the `--cloud` transport that talks to the hub directly.

pub mod cloud;
pub mod login;
pub mod relay;
pub mod ws;

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
    Verb {
        name: "machines",
        run: Run::Opened(cloud::machines),
    },
];
