//! Wire types, error codes and limits of `scp/1`.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{borrow::Cow, collections::BTreeMap, fmt, str::FromStr};

pub use crate::address::valid_handle;

pub const PROTOCOL: &str = "scp/1";
/// The reference CLI's command, as refusals and notes name its verbs.
pub const CLI_NAME: &str = "swarm";

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident, $all:ident { $($variant:ident = $wire:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $wire)] $variant,)+
        }
        pub const $all: &[$name] = &[$($name::$variant),+];
        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire,)+ }
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
        impl std::str::FromStr for $name {
            type Err = ();
            fn from_str(s: &str) -> Result<Self, ()> {
                match s { $($wire => Ok(Self::$variant),)+ _ => Err(()) }
            }
        }
    };
}
pub(crate) use string_enum;

self::string_enum!(ErrorCode, ERROR_CODES {
    NotFound = "not_found",
    InboxFull = "inbox_full",
    RateLimited = "rate_limited",
    LoopGuard = "loop_guard",
    DataClassRefused = "data_class_refused",
    SecretRefused = "secret_refused",
    PolicyRefused = "policy_refused",
    TooLarge = "too_large",
    InvalidParams = "invalid_params",
    Unauthorized = "unauthorized",
    MethodNotFound = "method_not_found",
    ScopeRefused = "scope_refused",
    Unavailable = "unavailable",
    JudgeRefused = "judge_refused",
    NotLive = "not_live",
});

/// A refusal with its wire code; `detail` holds structured fields a client may show, never a message body.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct RelayError {
    pub code: ErrorCode,
    pub message: String,
    pub retry_after_s: Option<u64>,
    pub detail: Option<Map<String, Value>>,
}
impl RelayError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_s: None,
            detail: None,
        }
    }
    pub fn with_retry(mut self, retry_after_s: u64) -> Self {
        self.retry_after_s = Some(retry_after_s);
        self
    }
    pub fn with_detail(mut self, detail: Map<String, Value>) -> Self {
        self.detail = Some(detail);
        self
    }
}

string_enum!(ScopeDirection, SCOPE_DIRECTIONS { In = "in", Out = "out" });
string_enum!(ScopePreset, SCOPE_PRESETS { Open = "open", Tree = "tree", Parent = "parent", None = "none" });

/// A selector in a cap; `via` is the endpoint id (or `human`) that widened it, which clips what it admits.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeEntry {
    pub sel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    /// For `group:<name>`, the identity of the group of that name when the entry was set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// An inherited cap's base `*` via the parent: it still admits the parent's subtree once the parent is released.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub base: bool,
    /// A `group:<name>` allowance given by adding the endpoint to that group: it goes when the endpoint leaves.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub member: bool,
}

/// A list set from above: `by` is an endpoint id, `human`, `policy`, or `inherited` for a limited parent's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeCap {
    pub id: String,
    pub dir: ScopeDirection,
    pub by: String,
    pub sels: Vec<ScopeEntry>,
}

pub const CAPABILITIES: [&str; 4] = ["inbox.wait", "ask", "scopes", "groups"];
pub const BROKER_CAPABILITIES: [&str; 7] = [
    "inbox.wait",
    "ask",
    "scopes",
    "groups",
    "peek",
    "judge",
    "holds",
];

macro_rules! limits {
    ($name:ident, $constant:ident, $ty:ty, {$($(#[$meta:meta])* $field:ident => $key:literal = $value:expr),+ $(,)?}) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub struct $name {
            $($(#[$meta])* pub $field: $ty,)+
        }
        pub const $constant: $name = $name { $($field: $value,)+ };
        impl $name {
            pub const KEYS: &'static [&'static str] = &[$($key,)+];
            pub fn get(&self, key: &str) -> Option<$ty> {
                match key { $($key => Some(self.$field),)+ _ => None }
            }
            pub fn entries(&self) -> Vec<(&'static str, $ty)> {
                vec![$(($key, self.$field),)+]
            }
        }
    };
}

limits!(Limits, LIMITS, u64, {
    body_bytes => "bodyBytes" = 64 * 1024,
    recipients => "recipients" = 16,
    attachments => "attachments" = 16,
    ttl_default_s => "ttlDefaultS" = 7 * 86_400,
    ttl_max_s => "ttlMaxS" = 30 * 86_400,
    purge_after_s => "purgeAfterS" = 7 * 86_400,
    inbox_max => "inboxMax" = 1000,
    inbox_page => "inboxPage" = 100,
    wait_max_s => "waitMaxS" = 50,
    /// how long after an agent received a message its next send counts as caused by it, one hop further down the chain
    causal_window_s => "causalWindowS" = 120,
    pair_burst_window_s => "pairBurstWindowS" = 10,
    online_within_s => "onlineWithinS" = 60,
    hook_online_s => "hookOnlineS" = 300,
    hook_idle_s => "hookIdleS" = 1800,
    hook_ended_grace_s => "hookEndedGraceS" = 30,
    restart_grace_s => "restartGraceS" = 60,
    inject_messages => "injectMessages" = 5,
    inject_bytes => "injectBytes" = 7168,
    push_bytes => "pushBytes" = 20480,
    /// the stops a session's push may continue between two prompts
    pushes => "pushes" = 20,
    /// how long a live worker's next message waits after a push showed one of its own
    push_gap_s => "pushGapS" = 30,
    /// with other workers still running, how long a stop's push waits for one more worker result before it goes
    push_quiet_s => "pushQuietS" = 3,
    /// the longest a stop's push gathers worker results, from the first it has to show
    push_grace_s => "pushGraceS" = 6,
    stop_blocks => "stopBlocks" = 3,
    /// the stops a session's late parent directives may hold
    directive_holds => "directiveHolds" = 5,
    inject_hold_s => "injectHoldS" = 10,
    /// how long inbox still lists a message a background hook showed, whose text the harness may hand the agent only after its next tool call
    deferred_show_s => "deferredShowS" = 600,
    /// a deferred showing older than this settles at the session's next tool event or prompt: the harness has handed it over by then
    deferred_settle_ms => "deferredSettleMs" = 2000,
    list_offline_within_s => "listOfflineWithinS" = 86_400,
    /// an agent with no activity for this long is historic: list, peers and snapshots leave it out unless asked; Infinity disables it
    historic_after_s => "historicAfterS" = 3600,
    handle_bound_s => "handleBoundS" = 30 * 86_400,
    /// how long an offline child endpoint (a subagent's, a worker's) or a `_gone_` row that nothing references stays before the sweep retires it
    endpoint_retire_s => "endpointRetireS" = 86_400,
    /// the most endpoint rows one sweep retires
    endpoint_retire_max => "endpointRetireMax" = 1000,
    idempotency_s => "idempotencyS" = 86_400,
    audit_keep_s => "auditKeepS" = 30 * 86_400,
    note_chars => "noteChars" = 280,
    handback_bytes => "handbackBytes" = 16384,
    stderr_bytes => "stderrBytes" = 1024,
    activity_keep => "activityKeep" = 5000,
    activity_summary_chars => "activitySummaryChars" = 200,
    text_field => "textField" = 512,
    lineage_max => "lineageMax" = 16,
    depth_max => "depthMax" = 32,
    fan_out_max => "fanOutMax" = 32,
    fan_out_total => "fanOutTotal" = 64,
    grant_ttl_s => "grantTtlS" = 7 * 86_400,
    group_idle_s => "groupIdleS" = 86_400,
    policy_loads_kept => "policyLoadsKept" = 8,
    /// the prompts between two refreshes of a title a hook inferred
    title_refresh_turns => "titleRefreshTurns" = 5,
    /// the least time between two wake hook runs for one hibernated endpoint
    wake_debounce_s => "wakeDebounceS" = 60,
    /// the longest backoff after failed wake hook runs
    wake_backoff_max_s => "wakeBackoffMaxS" = 900,
    /// the longest opaque wake reference a provider stores with a hibernation
    wake_ref_chars => "wakeRefChars" = 512,
    /// the longest wake time a provider may announce with a hibernation
    wake_eta_max_s => "wakeEtaMaxS" = 3600,
});

limits!(RateLimits, RATE_LIMITS, Option<u64>, {
    user_per_day => "userPerDay" = None,
    pair_burst => "pairBurst" = None,
    pair_per_minute => "pairPerMinute" = None,
    pair_per_hour => "pairPerHour" = None,
    tree_per_minute => "treePerMinute" = None,
    tree_per_hour => "treePerHour" = None,
    tree_pause_s => "treePauseS" = Some(600),
    group_per_minute => "groupPerMinute" = None,
    peek_pair_per_minute => "peekPairPerMinute" = None,
    peek_target_per_hour => "peekTargetPerHour" = None,
    /// loop guards: the longest causal hop chain, the most messages in one thread, the back-and-forth alternations that pause a pair
    hop_max => "hopMax" = None,
    thread_max => "threadMax" = None,
    ping_pong_alternations => "pingPongAlternations" = None,
    ping_pong_window_s => "pingPongWindowS" = Some(600),
    ping_pong_block_s => "pingPongBlockS" = Some(600),
});

pub const RATE_DURATIONS: [&str; 3] = ["treePauseS", "pingPongWindowS", "pingPongBlockS"];
/// The largest hop_floor a forward carries.
pub const HOP_FLOOR_MAX: u64 = 1000;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LimitsError {
    #[error("limits must be a JSON object")]
    NotObject,
    #[error("unknown limit {0}")]
    Unknown(String),
    #[error("{0} must be a positive integer, null or 0")]
    Invalid(String),
}

impl LimitsError {
    pub fn message(&self, source: &str) -> String {
        format!("{source}: {self}")
    }
}

pub fn parse_limits(
    raw: &Value,
    keys: &[&str],
    durations: &[&str],
) -> Result<BTreeMap<String, Option<u64>>, LimitsError> {
    let object = raw.as_object().ok_or(LimitsError::NotObject)?;
    let mut parsed = BTreeMap::new();
    for (key, value) in object {
        if !keys.contains(&key.as_str()) {
            return Err(LimitsError::Unknown(key.clone()));
        }
        if value.is_null() || value.as_f64() == Some(0.0) {
            if !durations.contains(&key.as_str()) {
                parsed.insert(key.clone(), None);
            }
            continue;
        }
        let integer = value.as_u64().filter(|n| *n > 0).or_else(|| {
            let number = value.as_f64()?;
            // The exclusive bound avoids the rounded f64 representation of u64::MAX.
            (number > 0.0 && number.fract() == 0.0 && number < 18_446_744_073_709_551_616.0)
                .then_some(number as u64)
        });
        let integer = integer.ok_or_else(|| LimitsError::Invalid(key.clone()))?;
        parsed.insert(key.clone(), Some(integer));
    }
    Ok(parsed)
}

pub fn wire_limits(limits: &BTreeMap<String, Option<u64>>) -> Map<String, Value> {
    limits
        .iter()
        .map(|(key, value)| (key.clone(), value.map_or(Value::Null, Value::from)))
        .collect()
}

string_enum!(EndpointKind, ENDPOINT_KINDS { Agent = "agent", Human = "human", System = "system" });
string_enum!(MessageKind, MESSAGE_KINDS { Message = "message", Request = "request", Reply = "reply", Status = "status" });
string_enum!(DataClass, DATA_CLASSES { Public = "public", Private = "private" });
string_enum!(Presence, PRESENCES { Online = "online", Idle = "idle", Offline = "offline", Hibernated = "hibernated" });
string_enum!(StatusState, STATUS_STATES { Working = "working", Waiting = "waiting", Blocked = "blocked", Done = "done" });
string_enum!(ActivityKind, ACTIVITY_KINDS { SessionStart = "session_start", Tool = "tool", Stop = "stop", Note = "note", SessionEnd = "session_end" });
string_enum!(Reach, REACHES { Running = "running", Ended = "ended", Offline = "offline", Starting = "starting" });
string_enum!(PeekLevel, PEEK_LEVELS { Local = "local" });

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Wake {
    Channels,
    Pi,
    OpencodePlugin,
    CodexAppServer,
    ClaudeInbox,
    AgyResume,
    GrokResume,
    MuseServe,
    T3code,
    SpawnResume,
    CodexQueue,
    None,
    Hook(String),
}

pub const WAKES: &[Wake] = &[
    Wake::Channels,
    Wake::Pi,
    Wake::OpencodePlugin,
    Wake::CodexAppServer,
    Wake::ClaudeInbox,
    Wake::AgyResume,
    Wake::GrokResume,
    Wake::MuseServe,
    Wake::T3code,
    Wake::SpawnResume,
    Wake::CodexQueue,
    Wake::None,
];
pub const BROKER_WAKES: &[Wake] = &[Wake::CodexQueue];
pub const SPAWN_PROVIDER: &str = "spawn";

impl Wake {
    pub fn wire(&self) -> Cow<'_, str> {
        Cow::Borrowed(match self {
            Self::Channels => "channels",
            Self::Pi => "pi",
            Self::OpencodePlugin => "opencode-plugin",
            Self::CodexAppServer => "codex-app-server",
            Self::ClaudeInbox => "claude-inbox",
            Self::AgyResume => "agy-resume",
            Self::GrokResume => "grok-resume",
            Self::MuseServe => "muse-serve",
            Self::T3code => "t3code",
            Self::SpawnResume => "spawn-resume",
            Self::CodexQueue => "codex-queue",
            Self::None => "none",
            Self::Hook(provider) => return Cow::Owned(format!("hook:{provider}")),
        })
    }
}

impl FromStr for Wake {
    type Err = ();
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if let Some(provider) = value.strip_prefix("hook:") {
            return Ok(Self::Hook(provider.to_owned()));
        }
        WAKES
            .iter()
            .find(|wake| wake.wire() == value)
            .cloned()
            .ok_or(())
    }
}

impl fmt::Display for Wake {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.wire())
    }
}

impl Serialize for Wake {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.wire())
    }
}

impl<'de> Deserialize<'de> for Wake {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        value
            .parse()
            .map_err(|()| serde::de::Error::custom("invalid wake"))
    }
}

pub fn valid_wake_decline(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
}

pub fn wake_decline_of(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| valid_wake_decline(value))
}

pub fn valid_harness(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

pub const GENERIC_HARNESSES: [&str; 4] = ["cli", "hook", "mcp", "shell"];

fn generic_harness(value: Option<&str>) -> bool {
    value.is_none_or(|value| GENERIC_HARNESSES.contains(&value))
}

pub fn harness_fits(held: Option<&str>, claimed: &str) -> bool {
    held == Some(claimed) || generic_harness(held)
}

pub fn kept_harness<'a>(held: Option<&'a str>, claimed: &'a str) -> &'a str {
    match held {
        Some(held) if generic_harness(Some(claimed)) && !generic_harness(Some(held)) => held,
        _ => claimed,
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReviveRecord {
    pub harness: String,
    pub session: String,
    pub cwd: String,
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
}

pub fn revive_record(r: Option<&str>) -> Option<ReviveRecord> {
    let r = r.filter(|r| r.starts_with('{'))?;
    let value: Value = serde_json::from_str(r).ok()?;
    let object = value.as_object()?;
    // A present null is invalid, even though serde maps it to None.
    if object.get("via").is_some_and(|via| !via.is_string()) {
        return None;
    }
    let record: ReviveRecord = serde_json::from_value(value).ok()?;
    let session = record.session.as_bytes();
    (valid_harness(&record.harness)
        && (1..=128).contains(&session.len())
        && session[0].is_ascii_alphanumeric()
        && session
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(c))
        && record.cwd.starts_with('/')
        && !record.argv.is_empty()
        && record.via.as_deref().is_none_or(valid_harness))
    .then_some(record)
}

// Preserve absent versus explicit null for optional nullable wire fields.
fn optional_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

string_enum!(ScopeSetting, SCOPE_SETTINGS { Open = "open", Tree = "tree", Parent = "parent", None = "none", Custom = "custom" });
string_enum!(ScopeAuth, SCOPE_AUTHS { Session = "session", Self_ = "self", Lineage = "lineage" });
string_enum!(PeekRole, PEEK_ROLES { User = "user", Assistant = "assistant" });
string_enum!(PeekSource, PEEK_SOURCES { Digest = "digest", Status = "status" });
string_enum!(AttachmentKind, ATTACHMENT_KINDS { Path = "path" });
string_enum!(SenderAuth, SENDER_AUTHS { LocalUid = "local-uid", Account = "account", AccountBridge = "account+bridge", Contact = "contact" });
string_enum!(Relation, RELATIONS { Parent = "parent", Ancestor = "ancestor", Child = "child" });
string_enum!(JudgeSide, JUDGE_SIDES { Local = "local", Egress = "egress", Ingress = "ingress" });
string_enum!(DeclinedWake, DECLINED_WAKES { Declined = "declined" });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ScopeActor {
    Human { tty: bool },
    Endpoint { id: String, auth: ScopeAuth },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SendTo {
    One(String),
    Many(Vec<String>),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DeliveryWake {
    Wake(Wake),
    Declined(DeclinedWake),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Claim {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    /// A harness session's key, shared by its shim and hooks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// A harness process key: `pid:<pid>:<start time>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    /// The harness's stable session id, used to reclaim an offline endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_session: Option<String>,
    /// The harness session this fork continues.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_origin: Option<String>,
    /// Take over the idle origin endpoint for this background session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_handoff: Option<bool>,
    /// Ancestor process keys, nearest first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<Vec<String>>,
    /// A spawn grant carrying placement, caps and groups.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<String>,
    /// The handle as named, never suffixed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exact: Option<bool>,
    /// A hook's claim for an in-process subagent under its lineage endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent: Option<SubagentClaim>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ScopePreset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#in: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<String>>,
    /// A root claim links under this agent address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub under: Option<String>,
    /// A wake ticket reclaiming its hibernated endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SubagentClaim {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ScopeRules {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#in: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScopeView {
    pub address: String,
    /// The root's address, null when hidden from the viewer.
    pub tree: Option<String>,
    pub parent: Option<String>,
    pub depth: u64,
    pub rules: ScopeRules,
    /// Stored caps plus group and policy caps, with addresses for by and via.
    pub caps: Vec<ScopeCap>,
    pub groups: Vec<String>,
    pub preset: ScopeSetting,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ScopeChange {
    pub added: Vec<String>,
    pub clipped: Vec<String>,
    /// Added selectors whose other end was widened to admit this endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirrored: Option<Vec<ScopeMirrored>>,
    /// Other ends still refusing this endpoint, with a widening command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<Vec<ScopeRefused>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScopeMirrored {
    pub endpoint: String,
    pub dir: ScopeDirection,
    pub added: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScopeRefused {
    pub endpoint: String,
    pub dir: ScopeDirection,
    pub fix: String,
    /// The other end was not found and was not checked.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unseen: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EndpointStatus {
    pub state: StatusState,
    pub note: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PeerView {
    pub address: String,
    pub kind: EndpointKind,
    pub presence: Presence,
    pub title: Option<String>,
    pub status: Option<EndpointStatus>,
    /// The rule that admits the message.
    pub reason: String,
    /// Set only when the viewer may peek this endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peekable: Option<PeekLevel>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub historic: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WhyResult {
    pub allowed: bool,
    pub reasons: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pair: Option<PairLimits>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PairLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused_until: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub burst: Option<PairBurst>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<PairRefusal>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PairBurst {
    pub n: u64,
    pub limit: u64,
    pub window_s: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PairRefusal {
    pub at: String,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RunnerView {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attach: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<RunnerStatus>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RunnerStatus {
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EndpointView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner: Option<RunnerView>,
    pub id: String,
    pub address: String,
    pub kind: EndpointKind,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub title: Option<String>,
    pub presence: Presence,
    pub status: Option<EndpointStatus>,
    pub last_seen: Option<String>,
    /// The parent endpoint's address, null for a root.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_nullable"
    )]
    pub parent: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ScopeSetting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peekable: Option<PeekLevel>,
    /// How a message wakes an idle agent; null or none reads at its next turn.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_nullable"
    )]
    pub wake: Option<Option<Wake>>,
    /// The last wake hook failure reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_failed: Option<String>,
    /// The provider declined the last wake.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_declined: Option<String>,
    /// A message restores the same harness session from its revive record.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub revivable: bool,
    /// A machine waker accepted the wake, pending reclaim or timeout.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub waking: bool,
    /// The agent's last activity.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_nullable"
    )]
    pub active_at: Option<Option<String>>,
    /// Derived after historicAfterS without activity; clears on activity.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub historic: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PeekTurn {
    pub role: PeekRole,
    pub at: String,
    pub text: String,
    pub tools: Vec<String>,
}

/// A short, redacted view of an endpoint's last turns; bodies are untrusted data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PeekResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner: Option<RunnerView>,
    pub endpoint: String,
    pub at: String,
    pub level: Option<PeekLevel>,
    pub source: PeekSource,
    pub turns: Vec<PeekTurn>,
    pub recent_tools: Vec<String>,
    pub status: Option<EndpointStatus>,
    pub title: Option<String>,
    pub unread: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PeekSeen {
    pub at: String,
    pub by: String,
    pub auth: String,
    pub turns: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PeekState {
    pub peek: Option<PeekLevel>,
    pub peeked_by: Vec<PeekSeen>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    pub kind: AttachmentKind,
    pub path: String,
}

/// A request named once to its recipient by sender and id, never its text.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StopNudge {
    pub seq: u64,
    pub from: String,
    pub id: String,
    pub unread: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    pub id: String,
    pub thread: String,
    pub reply_to: Option<String>,
    pub kind: MessageKind,
    pub from: EnvelopeFrom,
    pub to: String,
    pub body: EnvelopeBody,
    pub data_class: DataClass,
    pub attachments: Vec<Attachment>,
    pub hop: u64,
    pub created_at: String,
    pub expires_at: String,
    /// The sender holds the recipient's stop until it replies.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub require_reply: bool,
    /// A broker-issued request to link under its sender.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<EnvelopeLink>,
    /// A background hook already showed this message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shown_at: Option<String>,
    /// The sender's relation as the local broker sees it from the recipient.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<Relation>,
    /// The steer key of the issuer's spawn grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_key: Option<String>,
    /// An idle in-process subagent offered to its root waker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#for: Option<EnvelopeFor>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EnvelopeFrom {
    pub address: String,
    pub endpoint: String,
    pub user: String,
    pub auth: SenderAuth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    /// The contact sender's account handle, set by relays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub claims: SenderClaims,
    /// The sender as seen from the recipient.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rel: Option<String>,
    /// A human at a terminal on another machine, set by the relay.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub human: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SenderClaims {
    pub harness: Option<String>,
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tty: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EnvelopeBody {
    pub text: String,
    pub mime: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EnvelopeLink {
    pub parent: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EnvelopeFor {
    pub address: String,
    pub subagent: String,
}

/// Thread metadata sufficient to reply, without the body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThreadMessage {
    pub id: String,
    pub thread: String,
    pub kind: MessageKind,
    pub created_at: String,
    pub from: ThreadFrom,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ThreadFrom {
    pub address: String,
    pub endpoint: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StopWaitResult {
    pub messages: Vec<Envelope>,
    pub offered: Vec<u64>,
    pub hold: Option<String>,
    pub more: u64,
    pub workers: Vec<String>,
    pub starting: u64,
    /// Live workers whose stops do not wait for them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<Vec<String>>,
    pub others: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub others_shown: Option<u64>,
    pub pushes_left: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub prompted: bool,
    /// A message wakes this session through a live waker.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub wakeable: bool,
    /// A hook already showed the full preamble.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub brief: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SendParams {
    pub to: SendTo,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MessageKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_class: Option<DataClass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_s: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    /// For a request, hold the recipient's stop until it replies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_reply: Option<bool>,
    /// Refuse not_live without queueing when an agent has no live session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AskResult {
    pub id: String,
    /// Deliveries when this call sent the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliveries: Option<Vec<Delivery>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<Envelope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expired: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<Vec<EndedRecipient>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<JudgeHeld>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<JudgeRedacted>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EndedRecipient {
    pub address: String,
    pub state: Option<StatusState>,
}

/// A send held for human review, with nothing delivered.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JudgeHeld {
    pub hold_id: String,
    pub side: JudgeSide,
}

/// A send delivered with spans replaced, by kind.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct JudgeRedacted {
    pub n: u64,
    pub kinds: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SendResult {
    pub id: String,
    pub thread: String,
    pub hop: u64,
    pub deliveries: Vec<Delivery>,
    /// One line per agent recipient with no live session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duplicate: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<JudgeHeld>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<JudgeRedacted>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Delivery {
    pub endpoint: String,
    pub address: String,
    pub seq: u64,
    pub offline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued: Option<bool>,
    pub last_seen: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<Reach>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake: Option<DeliveryWake>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub idle: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hibernated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_eta_s: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AdoptResult {
    pub endpoint: EndpointView,
    pub parent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<JudgeHeld>,
}

/// Per-recipient read, delivered and shown times, or null.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MessageReceipts {
    pub id: String,
    pub thread: String,
    pub recipients: Vec<RecipientReceipt>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RecipientReceipt {
    pub address: String,
    pub read_at: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_nullable"
    )]
    pub delivered_at: Option<Option<String>>,
    pub shown_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AuditRow {
    pub id: u64,
    pub at: String,
    pub event: String,
    pub endpoint: Option<String>,
    pub r#ref: Option<String>,
    pub detail: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivityRow {
    pub id: u64,
    pub at: String,
    pub endpoint: String,
    pub kind: ActivityKind,
    pub tool: Option<String>,
    pub summary: Option<String>,
    /// The subagent reported by a hook.
    pub agent: Option<String>,
}

/// Fields only the server sets; a client sending them gets invalid_params.
pub const SERVER_FIELDS: [&str; 9] = [
    "from",
    "id",
    "seq",
    "hop",
    "created_at",
    "auth",
    "expires_at",
    "relation",
    "link",
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn limit_tables_have_ordered_entries_and_unknown_keys() {
        assert_eq!(LIMITS.get("bodyBytes"), Some(64 * 1024));
        assert_eq!(LIMITS.get("missing"), None);
        assert_eq!(RATE_LIMITS.get("userPerDay"), Some(None));
        assert_eq!(RATE_LIMITS.get("treePauseS"), Some(Some(600)));
        assert_eq!(RATE_LIMITS.get("missing"), None);
        assert_eq!(
            LIMITS
                .entries()
                .iter()
                .map(|(key, _)| *key)
                .collect::<Vec<_>>(),
            Limits::KEYS
        );
        assert_eq!(
            RATE_LIMITS
                .entries()
                .iter()
                .map(|(key, _)| *key)
                .collect::<Vec<_>>(),
            RateLimits::KEYS
        );
    }

    #[test]
    fn parse_limits_accepts_integers_and_off_values() {
        for raw in [json!(1), json!(1.0), json!(42), json!(u64::MAX)] {
            let parsed = parse_limits(&json!({"n": raw}), &["n"], &[]).unwrap();
            assert_eq!(parsed["n"], Some(raw.as_u64().unwrap_or(1)));
        }
        for value in [Value::Null, json!(0), json!(0.0), json!(-0.0)] {
            assert_eq!(
                parse_limits(&json!({"n": value}), &["n"], &[]).unwrap()["n"],
                None
            );
        }
        assert!(parse_limits(&json!({}), &[], &[]).unwrap().is_empty());
    }

    #[test]
    fn parse_limits_keeps_duration_defaults_only_when_off() {
        for value in [Value::Null, json!(0), json!(0.0), json!(-0.0)] {
            assert!(
                parse_limits(
                    &json!({"treePauseS": value}),
                    RateLimits::KEYS,
                    &RATE_DURATIONS
                )
                .unwrap()
                .is_empty()
            );
        }
        assert_eq!(
            parse_limits(
                &json!({"treePauseS": 12}),
                RateLimits::KEYS,
                &RATE_DURATIONS
            )
            .unwrap()["treePauseS"],
            Some(12)
        );
        assert_eq!(
            parse_limits(&json!({"treePauseS": 0}), RateLimits::KEYS, &[]).unwrap()["treePauseS"],
            None
        );
    }

    #[test]
    fn parse_limits_rejects_invalid_values_and_reports_exact_errors() {
        for value in [
            Value::Null,
            json!([]),
            json!(true),
            json!(2),
            json!("limits"),
        ] {
            let error = parse_limits(&value, &["n"], &[]).unwrap_err();
            assert_eq!(error, LimitsError::NotObject);
            assert_eq!(error.to_string(), "limits must be a JSON object");
            assert_eq!(
                error.message("config"),
                "config: limits must be a JSON object"
            );
        }
        let error = parse_limits(&json!({"other": null}), &["n"], &[]).unwrap_err();
        assert_eq!(error, LimitsError::Unknown("other".into()));
        assert_eq!(error.to_string(), "unknown limit other");
        assert_eq!(error.message("config"), "config: unknown limit other");
        for value in [
            json!(-1),
            json!(-1.0),
            json!(1.5),
            json!("1"),
            json!(true),
            json!(false),
            json!([]),
            json!({}),
            json!(18_446_744_073_709_551_616.0),
        ] {
            let error = parse_limits(&json!({"n": value}), &["n"], &[]).unwrap_err();
            assert_eq!(error, LimitsError::Invalid("n".into()));
            assert_eq!(error.to_string(), "n must be a positive integer, null or 0");
            assert_eq!(
                error.message("config"),
                "config: n must be a positive integer, null or 0"
            );
        }
    }

    #[test]
    fn wire_limits_serializes_off_as_null() {
        let parsed = BTreeMap::from([("on".into(), Some(12)), ("off".into(), None)]);
        assert_eq!(
            Value::Object(wire_limits(&parsed)),
            json!({"on": 12, "off": null})
        );
        assert!(wire_limits(&BTreeMap::new()).is_empty());
    }

    #[test]
    fn wakes_round_trip_named_and_hook_values() {
        for wake in WAKES.iter().cloned().chain([
            Wake::Hook("x".into()),
            Wake::Hook(String::new()),
            Wake::Hook("a:b/c".into()),
        ]) {
            let wire = wake.wire();
            assert_eq!(wire.parse::<Wake>(), Ok(wake.clone()));
            assert_eq!(wake.to_string(), wire);
            let value = serde_json::to_value(&wake).unwrap();
            assert_eq!(value, json!(wire));
            assert_eq!(serde_json::from_value::<Wake>(value).unwrap(), wake);
        }
        for value in [json!("unknown"), json!("hook"), json!(null), json!(12)] {
            assert!(serde_json::from_value::<Wake>(value).is_err());
        }
    }

    #[test]
    fn decline_tokens_match_the_wire_grammar() {
        for token in ["a", "budget", "a_0-", &"a".repeat(32)] {
            assert!(valid_wake_decline(token));
            let value = json!(token);
            assert_eq!(wake_decline_of(&value), Some(token));
        }
        for token in ["", "0a", "A", "a.b", "a\n", "é", &"a".repeat(33)] {
            assert!(!valid_wake_decline(token));
            assert_eq!(wake_decline_of(&json!(token)), None);
        }
        for value in [Value::Null, json!(true), json!(1), json!({})] {
            assert_eq!(wake_decline_of(&value), None);
        }
    }

    #[test]
    fn harness_rules_preserve_specific_names() {
        for harness in ["a", "0", "agent-2", &"a".repeat(32)] {
            assert!(valid_harness(harness));
        }
        for harness in ["", "-a", "A", "a_b", "a.b", "a\n", "é", &"a".repeat(33)] {
            assert!(!valid_harness(harness));
        }
        for held in [
            None,
            Some("cli"),
            Some("hook"),
            Some("mcp"),
            Some("shell"),
            Some("agent"),
        ] {
            assert!(harness_fits(held, "agent"));
        }
        assert!(!harness_fits(Some("agent"), "other"));
        assert!(!harness_fits(Some("agent"), "cli"));
        assert_eq!(kept_harness(Some("agent"), "hook"), "agent");
        assert_eq!(kept_harness(Some("cli"), "agent"), "agent");
        assert_eq!(kept_harness(None, "agent"), "agent");
        assert_eq!(kept_harness(None, "cli"), "cli");
        assert_eq!(kept_harness(Some("agent"), "other"), "other");
        assert_eq!(kept_harness(Some("cli"), "hook"), "hook");
    }

    fn revive_value() -> Value {
        json!({"harness": "agent", "session": "A0.a_b:c-d", "cwd": "/work", "argv": ["resume", ""]})
    }

    #[test]
    fn revive_records_validate_and_drop_provider_members() {
        let mut value = revive_value();
        value["provider_data"] = json!({"private": true});
        let record = revive_record(Some(&value.to_string())).unwrap();
        assert_eq!(record.harness, "agent");
        assert_eq!(record.argv, ["resume", ""]);
        assert_eq!(record.via, None);
        assert_eq!(serde_json::to_value(record).unwrap(), revive_value());
        value["via"] = json!("spawn");
        assert_eq!(
            revive_record(Some(&value.to_string()))
                .unwrap()
                .via
                .as_deref(),
            Some("spawn")
        );
        value["session"] = json!("a".repeat(128));
        assert!(revive_record(Some(&value.to_string())).is_some());
    }

    #[test]
    fn revive_records_reject_invalid_refs_and_members() {
        assert_eq!(revive_record(None), None);
        for raw in ["", "{}", "{", "null", "[]", " {\"harness\":\"agent\"}"] {
            assert_eq!(revive_record(Some(raw)), None);
        }
        for (key, bad) in [
            ("harness", json!("Bad")),
            ("harness", json!(null)),
            ("session", json!("")),
            ("session", json!("_start")),
            ("session", json!("bad/session")),
            ("session", json!("a".repeat(129))),
            ("cwd", json!("relative")),
            ("cwd", json!(1)),
            ("argv", json!([])),
            ("argv", json!([1])),
            ("argv", json!("resume")),
            ("via", json!(null)),
            ("via", json!("Bad")),
            ("via", json!(true)),
        ] {
            let mut value = revive_value();
            value[key] = bad;
            assert_eq!(
                revive_record(Some(&value.to_string())),
                None,
                "{key}: {value}"
            );
        }
        for key in ["harness", "session", "cwd", "argv"] {
            let mut value = revive_value();
            value.as_object_mut().unwrap().remove(key);
            assert_eq!(revive_record(Some(&value.to_string())), None);
        }
    }

    #[test]
    fn claim_round_trips_exact_wire_fields() {
        let value = json!({
            "handle": "worker", "harness": "agent", "model": "model", "cwd": "/work",
            "parent": "ep-parent", "labels": {"team": "core"}, "session": "session",
            "process": "pid:12:34", "harness_session": "resume", "harness_origin": "origin",
            "harness_handoff": true, "lineage": ["pid:12:34"], "grant": "grant", "exact": false,
            "subagent": {"id": "sub", "type": "explore", "stop": false},
            "scope": "tree", "in": ["*"], "out": ["parent"], "groups": ["team"],
            "under": "me/root", "ticket": "ticket"
        });
        let claim: Claim = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(claim.harness_handoff, Some(true));
        assert_eq!(claim.r#in, Some(vec!["*".into()]));
        assert_eq!(
            claim.subagent.as_ref().unwrap().r#type.as_deref(),
            Some("explore")
        );
        assert_eq!(serde_json::to_value(claim).unwrap(), value);
        assert_eq!(serde_json::to_value(Claim::default()).unwrap(), json!({}));
    }

    #[test]
    fn envelope_round_trips_exact_wire_fields() {
        let value = json!({
            "seq": 4, "id": "m", "thread": "t", "reply_to": null, "kind": "request",
            "from": {"address": "me/root", "endpoint": "ep-root", "user": "me", "auth": "local-uid",
                "machine": "host", "account": "sender", "claims": {"harness": null, "model": "model", "tty": false},
                "rel": "parent", "human": true},
            "to": "me/worker", "body": {"text": "hello", "mime": "text/plain"}, "data_class": "private",
            "attachments": [{"kind": "path", "path": "/work/result"}], "hop": 1,
            "created_at": "2026-01-01T00:00:00Z", "expires_at": "2026-01-02T00:00:00Z",
            "require_reply": true, "link": {"parent": "me/root"}, "shown_at": "2026-01-01T00:00:00Z",
            "relation": "parent", "parent_key": "key", "for": {"address": "me/worker", "subagent": "sub"}
        });
        let envelope: Envelope = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(envelope.kind, MessageKind::Request);
        assert_eq!(envelope.r#for.as_ref().unwrap().subagent, "sub");
        assert_eq!(serde_json::to_value(envelope).unwrap(), value);
    }

    #[test]
    fn optional_nullable_fields_preserve_missing_null_and_value() {
        for value in [
            json!({"address": "me/a", "read_at": null, "shown_at": null}),
            json!({"address": "me/a", "read_at": null, "shown_at": null, "delivered_at": null}),
            json!({"address": "me/a", "read_at": null, "shown_at": null, "delivered_at": "time"}),
        ] {
            let receipt: RecipientReceipt = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(receipt).unwrap(), value);
        }
    }

    #[test]
    fn tagged_scope_actors_and_delivery_wakes_round_trip() {
        for value in [
            json!({"kind": "human", "tty": false}),
            json!({"kind": "endpoint", "id": "ep", "auth": "self"}),
        ] {
            let actor: ScopeActor = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(actor).unwrap(), value);
        }
        for value in [json!("declined"), json!("hook:provider"), json!("none")] {
            let wake: DeliveryWake = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(wake).unwrap(), value);
        }
        for value in [json!("me/worker"), json!(["me/a", "me/b"])] {
            let to: SendTo = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(to).unwrap(), value);
        }
    }
}
