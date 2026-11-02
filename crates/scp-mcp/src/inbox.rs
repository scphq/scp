//! Claude Code's per-session inbox socket.

use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

#[derive(Debug, Clone, PartialEq)]
pub struct SessionInbox {
    pub socket: String,
    pub token: Option<String>,
    pub session_id: Option<String>,
}

fn nonempty(env: &HashMap<String, String>, key: &str) -> Option<String> {
    env.get(key).filter(|v| !v.is_empty()).cloned()
}

/// the inbox of the Claude Code session that started this process
pub fn session_inbox_of(env: &HashMap<String, String>) -> Option<SessionInbox> {
    let socket =
        nonempty(env, "CLAUDE_CODE_MESSAGING_SOCKET").filter(|s| Path::new(s).is_absolute())?;
    Some(SessionInbox {
        socket,
        token: nonempty(env, "CLAUDE_CODE_MESSAGING_TOKEN"),
        session_id: nonempty(env, "CLAUDE_CODE_SESSION_ID"),
    })
}

/// the lines that queue `content` as the session's next user turn: an auth line when there is a token, then the turn
pub fn inbox_lines(inbox: &SessionInbox, content: &str) -> String {
    let mut out = String::new();
    if let Some(token) = &inbox.token {
        out.push_str(&format!(
            "{{\"type\":\"auth\",\"token\":{}}}\n",
            Value::String(token.clone())
        ));
    }
    let session = match &inbox.session_id {
        Some(id) => format!(",\"session_id\":{}", Value::String(id.clone())),
        None => String::new(),
    };
    let content = Value::String(content.to_string());
    out.push_str(&format!(
        "{{\"type\":\"user\"{session},\"priority\":\"next\",\"message\":{{\"role\":\"user\",\"content\":{content}}}}}\n"
    ));
    out
}

/// queues one user turn on a Claude Code session's inbox socket; done once the lines are written and the socket closed
pub async fn send_to_session_inbox(
    inbox: &SessionInbox,
    content: &str,
    timeout: Duration,
) -> Result<(), String> {
    let lines = inbox_lines(inbox, content);
    let send = async {
        let mut socket = UnixStream::connect(&inbox.socket).await?;
        socket.write_all(lines.as_bytes()).await?;
        socket.shutdown().await?;
        let mut sink = [0u8; 512];
        while socket.read(&mut sink).await? > 0 {}
        Ok::<(), std::io::Error>(())
    };
    match tokio::time::timeout(timeout, send).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("session inbox timed out".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_inbox_comes_from_an_absolute_socket() {
        let env = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<HashMap<_, _>>()
        };
        assert_eq!(
            session_inbox_of(&env(&[("CLAUDE_CODE_MESSAGING_SOCKET", "rel.sock")])),
            None
        );
        assert_eq!(
            session_inbox_of(&env(&[
                ("CLAUDE_CODE_MESSAGING_SOCKET", "/s.sock"),
                ("CLAUDE_CODE_MESSAGING_TOKEN", "")
            ])),
            Some(SessionInbox {
                socket: "/s.sock".into(),
                token: None,
                session_id: None
            })
        );
    }

    #[test]
    fn lines_carry_auth_then_the_turn() {
        let inbox = SessionInbox {
            socket: "/s".into(),
            token: Some("tok".into()),
            session_id: Some("s1".into()),
        };
        assert_eq!(
            inbox_lines(&inbox, "hi\n"),
            "{\"type\":\"auth\",\"token\":\"tok\"}\n{\"type\":\"user\",\"session_id\":\"s1\",\"priority\":\"next\",\"message\":{\"role\":\"user\",\"content\":\"hi\\n\"}}\n"
        );
    }
}
