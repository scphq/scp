//! Handles, machine and account names, and the addresses built from them.

/// Handles no agent may take.
pub const RESERVED_HANDLES: [&str; 3] = ["user", "me", "relay"];
/// User parts that always name the local user, besides its alias.
pub const LOCAL_USERS: [&str; 2] = ["me", "local"];
/// The local user alias when none is configured.
pub const DEFAULT_USER: &str = "me";
/// The stored handle of a broker's human endpoint; it renders as `<user>/`.
pub const HUMAN_HANDLE: &str = "_human";
/// The stored handle of a broker's system endpoint; it renders as `<user>/relay`.
pub const SYSTEM_HANDLE: &str = "_relay";

fn name(s: &str, max: usize, extra: &[u8]) -> bool {
    let b = s.as_bytes();
    let plain = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty()
        && b.len() <= max
        && plain(b[0])
        && b[1..].iter().all(|&c| plain(c) || extra.contains(&c))
}

/// `^[a-z0-9][a-z0-9._-]{0,62}$`, not reserved.
pub fn valid_handle(handle: &str) -> bool {
    name(handle, 63, b"._-") && !RESERVED_HANDLES.contains(&handle)
}
/// A machine name, `^[a-z0-9][a-z0-9-]{0,31}$`: one relay host of an account.
pub fn valid_machine(machine: &str) -> bool {
    name(machine, 32, b"-")
}
/// An account handle, `^[a-z0-9][a-z0-9-]{0,63}$`.
pub fn valid_account(account: &str) -> bool {
    name(account, 64, b"-")
}
/// A label name, `^[a-z0-9][a-z0-9._-]{0,31}$`.
pub fn valid_label(label: &str) -> bool {
    name(label, 32, b"._-")
}
/// A mirrored row's remote key, `<machine>/<handle>` (handle empty for the machine's human).
pub fn valid_remote(remote: &str) -> bool {
    remote
        .split_once('/')
        .is_some_and(|(m, h)| name(m, 64, b"._-") && (h.is_empty() || name(h, 63, b"._-")))
}
/// The machine of a remote key: the text before its first `/`.
pub fn machine_part(remote: &str) -> &str {
    remote.split_once('/').map_or("", |(m, _)| m)
}
/// The handle of a remote key: the text after its first `/`.
pub fn handle_part(remote: &str) -> &str {
    remote.split_once('/').map_or(remote, |(_, h)| h)
}
/// A remote key of another account starts with `@`.
pub fn is_foreign(remote: &str) -> bool {
    remote.starts_with('@')
}

/// An address split on `/`, trimmed; at most three segments.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Segments<'a> {
    One(&'a str),
    Two(&'a str, &'a str),
    Three(&'a str, &'a str, &'a str),
}
/// The segments of a non-blank address, or None for a blank one or one of more than three segments.
pub fn segments(address: &str) -> Option<Segments<'_>> {
    let text = address.trim();
    if text.is_empty() {
        return None;
    }
    let mut parts = text.split('/');
    let a = parts.next()?;
    let Some(b) = parts.next() else {
        return Some(Segments::One(a));
    };
    let Some(c) = parts.next() else {
        return Some(Segments::Two(a, b));
    };
    parts.next().is_none().then_some(Segments::Three(a, b, c))
}

/// Renders an endpoint of this host: an agent `<user>/<handle>`, the human `<user>/`, the system endpoint `<user>/relay`.
pub fn render(user: &str, handle: &str) -> String {
    match handle {
        HUMAN_HANDLE => format!("{user}/"),
        SYSTEM_HANDLE => format!("{user}/relay"),
        _ => format!("{user}/{handle}"),
    }
}

/// The names an address of this host may carry as its user part.
#[derive(Clone, Copy, Debug, Default)]
pub struct Users<'a> {
    pub user: &'a str,
    pub aliases: &'a [&'a str],
}
impl Users<'_> {
    pub fn local(&self, part: &str) -> bool {
        LOCAL_USERS.contains(&part) || part == self.user || self.aliases.contains(&part)
    }
}

/// Where an address points: `machine` None is this host, `handle` empty the human.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Located<'a> {
    pub machine: Option<&'a str>,
    pub handle: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocateError {
    /// Blank or not a string.
    Blank,
    /// No endpoint this host could name.
    Unreachable,
    /// `<account>/me` of a contact account whose endpoints reached this relay: a sender address only.
    ContactHuman(String),
}

/// What [`locate`] needs to know about this host.
pub struct Host<'a> {
    pub users: Users<'a>,
    /// This host's own machine name; addresses naming it stay local.
    pub machine: Option<&'a str>,
    /// The machine a bare handle resolves on, when one is in force.
    pub scope: Option<&'a str>,
    /// Whether an endpoint of account `part` ever reached this relay.
    pub known_account: &'a dyn Fn(&str) -> bool,
}

/// The machine and handle an address of this account names (section 6.3); handles are not validated here.
pub fn locate<'a>(address: &'a str, host: &Host<'a>) -> Result<Located<'a>, LocateError> {
    if address.trim().is_empty() {
        return Err(LocateError::Blank);
    }
    let (mut machine, mut handle) = match segments(address).ok_or(LocateError::Unreachable)? {
        Segments::One(h) => (None, h),
        Segments::Two(a, "me")
            if !host.users.local(a) && valid_account(a) && (host.known_account)(a) =>
        {
            return Err(LocateError::ContactHuman(a.into()));
        }
        Segments::Two(a, h) => ((!host.users.local(a)).then_some(a), h),
        Segments::Three(a, m, h) if host.users.local(a) => (Some(m), h),
        Segments::Three(..) => return Err(LocateError::Unreachable),
    };
    if machine.is_some() && handle == "me" {
        handle = "";
    }
    if machine.is_none() && !handle.is_empty() {
        machine = host.scope;
    }
    if machine.is_some() && machine == host.machine {
        machine = None;
    }
    Ok(Located { machine, handle })
}

/// An agent (or, with an empty handle, the human) of a contact account on one of its machines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Foreign<'a> {
    pub account: &'a str,
    pub machine: &'a str,
    pub handle: &'a str,
}
/// `<account>/<machine>/<handle>` of another account (`me` as handle names its human), or None for any other address.
pub fn foreign_account<'a>(address: &'a str, users: &Users<'_>) -> Option<Foreign<'a>> {
    let Segments::Three(account, machine, handle) = segments(address)? else {
        return None;
    };
    if users.local(account) || !valid_account(account) || !valid_machine(machine) {
        return None;
    }
    let handle = match handle {
        "me" | "" => "",
        h if valid_handle(h) => h,
        _ => return None,
    };
    Some(Foreign {
        account,
        machine,
        handle,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles() {
        for ok in ["a", "0", "reviewer-1", "a.b_c-d", &"a".repeat(63)] {
            assert!(valid_handle(ok), "{ok}");
        }
        for bad in [
            "",
            "-a",
            ".a",
            "_a",
            "A",
            "a/b",
            "a b",
            "me",
            "user",
            "relay",
            &"a".repeat(64),
        ] {
            assert!(!valid_handle(bad), "{bad}");
        }
    }

    #[test]
    fn names() {
        assert!(valid_machine("mac-1") && valid_machine(&"m".repeat(32)));
        assert!(!valid_machine("mac.1") && !valid_machine(&"m".repeat(33)) && !valid_machine("-m"));
        assert!(
            valid_account(&"a".repeat(64))
                && !valid_account(&"a".repeat(65))
                && !valid_account("a_b")
        );
        assert!(valid_label("k.v_1-x") && !valid_label(&"k".repeat(33)));
        assert!(valid_remote("mac/") && valid_remote("mac/a.b") && valid_remote("m.x/h"));
        assert!(
            !valid_remote("mac")
                && !valid_remote("/h")
                && !valid_remote("mac/-h")
                && !valid_remote("a/b/c")
        );
        assert_eq!((machine_part("m/h"), handle_part("m/h")), ("m", "h"));
        assert!(is_foreign("@acct/m/h") && !is_foreign("m/h"));
    }

    #[test]
    fn splits() {
        assert_eq!(segments(" a "), Some(Segments::One("a")));
        assert_eq!(segments("me/"), Some(Segments::Two("me", "")));
        assert_eq!(segments("me/m/h"), Some(Segments::Three("me", "m", "h")));
        assert_eq!(segments("  "), None);
        assert_eq!(segments("a/b/c/d"), None);
    }

    #[test]
    fn renders() {
        assert_eq!(render("me", "a"), "me/a");
        assert_eq!(render("me", HUMAN_HANDLE), "me/");
        assert_eq!(render("alice", SYSTEM_HANDLE), "alice/relay");
    }

    #[test]
    fn locates() {
        let known = |a: &str| a == "acme";
        let host = Host {
            users: Users {
                user: "alice",
                aliases: &["team"],
            },
            machine: Some("laptop"),
            scope: None,
            known_account: &known,
        };
        let at = |machine, handle| Ok(Located { machine, handle });
        assert_eq!(locate("a", &host), at(None, "a"));
        assert_eq!(locate("me/a", &host), at(None, "a"));
        assert_eq!(locate("local/", &host), at(None, ""));
        assert_eq!(locate("team/a", &host), at(None, "a"));
        assert_eq!(locate("box/a", &host), at(Some("box"), "a"));
        assert_eq!(locate("box/me", &host), at(Some("box"), ""));
        assert_eq!(locate("laptop/a", &host), at(None, "a"));
        assert_eq!(locate("alice/box/a", &host), at(Some("box"), "a"));
        assert_eq!(locate("me/box/me", &host), at(Some("box"), ""));
        assert_eq!(locate("me/laptop/a", &host), at(None, "a"));
        assert_eq!(
            locate("acme/me", &host),
            Err(LocateError::ContactHuman("acme".into()))
        );
        assert_eq!(locate("other/me", &host), at(Some("other"), ""));
        assert_eq!(locate("acme/box/a", &host), Err(LocateError::Unreachable));
        assert_eq!(locate(" ", &host), Err(LocateError::Blank));
        assert_eq!(locate("me/a/b/c", &host), Err(LocateError::Unreachable));
        let scoped = Host {
            scope: Some("box"),
            ..host
        };
        assert_eq!(locate("a", &scoped), at(Some("box"), "a"));
        assert_eq!(locate("me/", &scoped), at(None, ""));
    }

    #[test]
    fn foreign() {
        let users = Users {
            user: "alice",
            aliases: &[],
        };
        let f = |account, machine, handle| {
            Some(Foreign {
                account,
                machine,
                handle,
            })
        };
        assert_eq!(foreign_account("acme/box/a", &users), f("acme", "box", "a"));
        assert_eq!(foreign_account("acme/box/me", &users), f("acme", "box", ""));
        assert_eq!(foreign_account("acme/box/", &users), f("acme", "box", ""));
        assert_eq!(foreign_account("me/box/a", &users), None);
        assert_eq!(foreign_account("alice/box/a", &users), None);
        assert_eq!(foreign_account("acme/b.x/a", &users), None);
        assert_eq!(foreign_account("acme/box/-a", &users), None);
        assert_eq!(foreign_account("acme/a", &users), None);
    }
}
