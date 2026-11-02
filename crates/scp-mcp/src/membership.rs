//! Whether a harness session is on the relay now, from the marker the broker leaves for it.

use crate::Membership;
use crate::identity::{read_owned_file, relay_dir};
use crate::ps::{Env, join};
use scp_core::protocol::CLI_NAME;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// what the broker last decided about a harness session: whether it joined or left, and the handle it goes by
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMarker {
    pub joined: bool,
    pub handle: Option<String>,
}

fn marker_path(dir: &str, session: &str) -> String {
    let hash = hex::encode(Sha256::digest(session.as_bytes()));
    join(&[dir, "sessions", &format!("{}.json", &hash[..32])])
}

pub fn read_session_marker(dir: &str, session: &str) -> Option<SessionMarker> {
    let value: Value =
        serde_json::from_str(&read_owned_file(&marker_path(dir, session)).ok()?).ok()?;
    let joined = value.get("joined")?.as_bool()?;
    Some(SessionMarker {
        joined,
        handle: value
            .get("handle")
            .and_then(Value::as_str)
            .map(String::from),
    })
}

/// how hooked sessions join: manual only when the config says so; auto when unset or unreadable
pub fn manual_join(env: &Env) -> bool {
    let nonempty = |key: &str| env.get(key).filter(|v| !v.is_empty());
    let base = match (nonempty("XDG_CONFIG_HOME"), nonempty("HOME")) {
        (Some(config), _) => config.clone(),
        (None, Some(home)) => join(&[home, ".config"]),
        (None, None) => return false,
    };
    let Ok(text) = read_owned_file(&join(&[&base, "scp", "config.json"])) else {
        return false;
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|config| {
            config
                .get("join")
                .and_then(Value::as_str)
                .map(|mode| mode == "manual")
        })
        .unwrap_or(false)
}

/// whether a harness session is on the relay now: off it after a leave, or in manual join mode before a join; else the handle it joined
/// under
pub fn membership(env: &Env, session: &str, dir: Option<&str>) -> Membership {
    let dir = dir.map(String::from).unwrap_or_else(|| relay_dir(env));
    let marker = read_session_marker(&dir, session);
    if marker.as_ref().is_some_and(|m| !m.joined) {
        return Membership::Dark(format!(
            "this session left the relay; {CLI_NAME} join (or relay_join) joins it again"
        ));
    }
    if marker.is_none() && manual_join(env) {
        return Membership::Dark(format!(
            "this session has not joined the relay; {CLI_NAME} join <name> (or relay_join) joins it"
        ));
    }
    Membership::Joined(marker.and_then(|m| m.handle).filter(|h| !h.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn markers_and_join_mode() {
        let root = std::env::temp_dir().join(format!("scp-mcp-member-{}", std::process::id()));
        let dir = root.join("state");
        let home = root.join("home");
        fs::create_dir_all(dir.join("sessions")).unwrap();
        fs::create_dir_all(home.join(".config/scp")).unwrap();
        let mut env = Env::new();
        env.insert("HOME".into(), home.to_str().unwrap().into());
        env.insert("SCP_DIR".into(), dir.to_str().unwrap().into());
        assert_eq!(membership(&env, "pid:1:x", None), Membership::Joined(None));
        fs::write(home.join(".config/scp/config.json"), r#"{"join":"manual"}"#).unwrap();
        assert!(
            matches!(membership(&env, "pid:1:x", None), Membership::Dark(text) if text.contains("has not joined"))
        );
        let path = marker_path(dir.to_str().unwrap(), "pid:1:x");
        fs::write(&path, r#"{"joined":true,"handle":"named"}"#).unwrap();
        assert_eq!(
            membership(&env, "pid:1:x", None),
            Membership::Joined(Some("named".into()))
        );
        fs::write(&path, r#"{"joined":false}"#).unwrap();
        assert_eq!(
            membership(&env, "pid:1:x", None),
            Membership::Dark(
                "this session left the relay; swarm join (or relay_join) joins it again".into()
            )
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
