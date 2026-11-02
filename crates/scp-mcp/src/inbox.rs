//! Claude Code's per-session inbox socket.

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct SessionInbox {
    pub socket: String,
    pub token: Option<String>,
    pub session_id: Option<String>,
}

/// the inbox of the Claude Code session that started this process
pub fn session_inbox_of(_env: &HashMap<String, String>) -> Option<SessionInbox> {
    todo!()
}
