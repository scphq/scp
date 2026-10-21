use crate::*;

/// One account's endpoint allowlist entry for a contact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XAllow {
    pub machine: String,
    pub sel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_worker: Option<bool>,
}
/// Positive contact limits; the hub applies protocol caps separately.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct XLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_minute: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_hour: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_day: Option<i64>,
}
/// Permissions governing this account's own endpoints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContactConfig {
    pub allow: Vec<XAllow>,
    pub dir: String,
    pub limits: Option<XLimits>,
}
impl Default for ContactConfig {
    fn default() -> Self {
        Self {
            allow: vec![XAllow {
                machine: "*".into(),
                sel: "tree:root".into(),
                allow_worker: None,
            }],
            dir: "both".into(),
            limits: None,
        }
    }
}
/// A contact row joined with its peer's current handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contact {
    pub peer_id: String,
    pub peer_handle: String,
    pub state: String,
    pub updated_at: i64,
    #[serde(flatten)]
    pub config: ContactConfig,
}
/// A retained cross-account receipt. Envelope and delivery share its sequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XInbox {
    pub seq: i64,
    pub id: String,
    pub endpoint: String,
    pub from_account: String,
    pub sender: String,
    pub client_id: String,
    pub message: String,
    pub thread: String,
    pub grant: Option<String>,
    pub expires_at: i64,
    pub at: i64,
    pub acked: bool,
}
