//! Persistence for a single relay process. The relay serializes hub operations per
//! account; different accounts may call concurrently. Each method is atomic and
//! compound writes commit together. Backends never read the clock: all times are
//! caller-supplied Unix milliseconds. Lists have the ordering documented below.
//! Missing optional reads return `None`; missing mutations return `NotFound`,
//! unless documented otherwise. Constraint violations return `Conflict`; all
//! other failures return `Backend`. Failed writes leave no partial changes.

mod contacts;
mod sql;
use async_trait::async_trait;
pub use contacts::*;
use serde::{Deserialize, Serialize};
pub use sql::{PostgresStore, SqliteStore, connect};
use std::{collections::BTreeMap, sync::Arc};

/// A constraint conflict, absent row, or backend failure. Implementations must not panic.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// A unique key, foreign key, state transition, or other constraint failed.
    #[error("conflict")]
    Conflict,
    /// A bounded store collection is full.
    #[error("capacity")]
    Capacity,
    /// The requested row does not exist.
    #[error("not found")]
    NotFound,
    /// An operational failure; callers must not expose its text to clients.
    #[error("backend: {0}")]
    Backend(String),
}
/// A store operation's result.
pub type Result<T> = std::result::Result<T, StoreError>;

/// An account, addressed by its globally unique handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub handle: String,
    pub created_at: i64,
}
/// A member of one account. Names are unique within that account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub email: Option<String>,
    pub role: Role,
    pub created_at: i64,
}
/// A member's account role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Admin,
    Member,
}
/// Credential kind. Tokens carry forced endpoint labels; devices are full logins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CredentialKind {
    Device,
    Token,
}
/// A credential. Only a SHA-256 digest is persisted, never the bearer secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credential {
    pub id: String,
    pub account_id: String,
    pub member_id: String,
    pub kind: CredentialKind,
    pub name: String,
    pub secret_hash: String,
    pub labels: BTreeMap<String, String>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub last_used_at: Option<i64>,
}
/// A resolved credential, including its account and current member role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub credential: Credential,
    pub account: Account,
    pub member: Member,
}
/// Lookup outcome. Revocation takes precedence over expiration at `now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialLookup {
    Invalid,
    Revoked,
    Expired,
    Active(Box<Identity>),
}
/// The persisted device login state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceState {
    Pending,
    Approved,
    Denied,
    Redeemed,
}
/// A hashed device code. Approval records the account/member; redemption records
/// the credential id. No bearer secret is stored in this record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceCode {
    pub device_code_hash: String,
    pub user_code: String,
    pub label: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_poll_at: Option<i64>,
    pub state: DeviceState,
    pub account_id: Option<String>,
    pub member_id: Option<String>,
    pub credential_id: Option<String>,
}
/// Atomic poll outcome. Polls inside `interval_ms` return SlowDown and still
/// advance last_poll_at. Terminal states take precedence over throttling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePoll {
    Invalid,
    Denied,
    Expired,
    SlowDown,
    Pending,
    Approved(DeviceCode),
}
/// A machine binding. `token_id` is a host credential id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub name: String,
    pub token_id: String,
    pub actor_id: String,
    pub user_id: String,
    pub kind: String,
    pub created_at: i64,
    pub last_seen: Option<i64>,
}
/// A revoked machine binding that restricts who may reclaim its name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tombstone {
    pub name: String,
    pub actor_id: Option<String>,
    pub user_id: Option<String>,
    pub at: i64,
}
/// A mirrored or directly claimed endpoint. `fields` preserves the remaining
/// broker columns (rules, labels, status, lineage and hook metadata) as JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    pub id: String,
    pub machine: String,
    pub handle: String,
    pub kind: String,
    pub token_hash: Option<String>,
    pub last_seen: Option<i64>,
    pub created_at: i64,
    pub fields: String,
}
/// A stored message. `envelope` is complete JSON text including body/attachments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub thread: String,
    pub reply_to: Option<String>,
    pub kind: String,
    pub from_ep: String,
    pub to_addr: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub envelope: String,
}
/// A delivery. Sequence numbers increase globally and survive deletion; gaps are
/// allowed. Reject and ack state are independent nullable caller timestamps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Delivery {
    pub seq: i64,
    pub message_id: String,
    pub endpoint: String,
    pub expires_at: i64,
    pub acked_at: Option<i64>,
    pub rejected_at: Option<i64>,
    pub rejection: Option<String>,
    pub state: String,
}
/// Delivery input; sequence allocation belongs to the backend transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewDelivery {
    pub endpoint: String,
    pub expires_at: i64,
    pub state: String,
}
/// A replay result keyed by sender and client id, with its payload digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Idempotency {
    pub from_ep: String,
    pub client_id: String,
    pub payload_hash: String,
    pub result: String,
    pub created_at: i64,
}
/// A local or routed pair event used for rate accounting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairEvent {
    pub from_ep: String,
    pub to_ep: String,
    pub at: i64,
}
/// An append-only activity or audit entry. `detail` is JSON text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub id: i64,
    pub at: i64,
    pub kind: String,
    pub endpoint: Option<String>,
    pub reference: Option<String>,
    pub detail: String,
}
/// Selects the append-only event log.
#[derive(Debug, Clone, Copy)]
pub enum EventLog {
    Activity,
    Audit,
}

/// One atomic account-state update. Endpoint removals also discard their deliveries.
#[derive(Debug, Clone, Default)]
pub struct HubWrite {
    /// Clear all hub data for this account before applying other changes.
    pub purge: bool,
    /// Prune expired hub data at this caller-supplied time.
    pub sweep_at: Option<i64>,
    /// Remove denial timestamps at or before this boundary.
    pub denied_before: Option<i64>,
    /// Endpoint rows to upsert after removals.
    pub endpoints: Vec<Endpoint>,
    /// Endpoint ids to delete together with all their deliveries.
    pub remove_endpoints: Vec<String>,
    /// Delete every delivery for these endpoints without deleting their rows.
    pub clear_inboxes: Vec<String>,
    /// Machine bindings to upsert, clearing their tombstones.
    pub machines: Vec<Machine>,
    /// Bindings to delete together with their tombstones and wake state.
    pub remove_machines: Vec<String>,
    /// Tombstones to upsert after binding changes.
    pub tombstones: Vec<Tombstone>,
    /// Delivery states to update, preserving their identity.
    pub deliveries: Vec<Delivery>,
    /// Renew unacknowledged, unexpired deliveries of these endpoints with fresh
    /// sequences, preserving message order. Each tuple supplies endpoint and now.
    pub renew_deliveries: Vec<(String, i64)>,
    /// Pair events to append; true selects the local traffic log.
    pub pairs: Vec<(PairEvent, bool)>,
    /// State keys to upsert or remove for None.
    pub states: Vec<(String, Option<String>)>,
    /// Events to append, ignoring their input ids.
    pub events: Vec<(EventLog, Event)>,
}

/// Backend contract for host authentication and per-account hub state.
/// Every method is atomic; no backend reads wall time or panics on bad input.
/// Hub methods must scope every read and write by `account_id`. A missing account
/// is a constraint conflict for inserts. JSON inputs must be valid JSON text.
///
/// # Host accounts, members and credentials
/// Account handles and account/member names are unique. Authentication reads
/// preserve revoked and expired outcomes. Member creation can select the first
/// owner atomically. Only credential digests are stored.
///
/// # Host device login
/// Pending codes move once to approved or denied; approved codes move once to
/// redeemed. Poll and redeem are distinct atomic operations. Redeem inserts the
/// credential in the same transaction as consuming its approval.
///
/// # Hub machines and endpoints
/// All keys are account-local. Machine binding also clears its tombstone and idle
/// state. Endpoint JSON is opaque to the backend and round-trips unchanged.
///
/// # Hub messages and deliveries
/// Message insertion, delivery allocation and idempotency insertion commit as a
/// unit. Delivery sequences increase; callers must tolerate gaps. Expiration is
/// explicit, with purge boundaries supplied by the caller.
///
/// # Hub state and logs
/// State values and log details are JSON text. Activity, audit and pair events
/// append without deduplication. Only explicit purge methods remove old entries.
#[async_trait]
pub trait RelayStore: Send + Sync + 'static {
    // Host accounts and members.
    /// Insert an account, or return the existing handle's row atomically.
    async fn create_account(&self, account: Account) -> Result<Account>;
    /// Read an account by handle, returning None when absent.
    async fn account(&self, handle: &str) -> Result<Option<Account>>;
    /// Insert a member. Duplicate id or account/name is Conflict.
    async fn create_member(&self, member: Member) -> Result<()>;
    /// Return an existing account/name or insert the supplied member atomically.
    /// With automatic_role, choose Owner for the first member, Member otherwise;
    /// without it, honor the supplied role. Existing members are never changed.
    async fn ensure_member(&self, member: Member, automatic_role: bool) -> Result<Member>;
    /// Read a member by account and name.
    async fn member(&self, account_id: &str, name: &str) -> Result<Option<Member>>;
    /// List members ordered by creation time, then id.
    async fn members(&self, account_id: &str) -> Result<Vec<Member>>;
    /// Read this side of a contact, including non-active states.
    async fn contact(&self, account_id: &str, peer_id: &str) -> Result<Option<Contact>>;
    /// Active contacts ordered by peer handle, then id.
    async fn contacts(&self, account_id: &str) -> Result<Vec<Contact>>;
    /// Invite atomically on both accounts; crossed invites activate both.
    async fn contact_invite(&self, account_id: &str, peer_id: &str, now: i64) -> Result<()>;
    /// Accept an incoming invitation, activating both with default permissions.
    async fn contact_accept(&self, account_id: &str, peer_id: &str, now: i64) -> Result<()>;
    /// Delete only this side's incoming invitation.
    async fn contact_decline(&self, account_id: &str, peer_id: &str, now: i64) -> Result<()>;
    /// Delete both sides except blocked rows.
    async fn contact_revoke(&self, account_id: &str, peer_id: &str, now: i64) -> Result<()>;
    /// Block here and delete the peer's row atomically.
    async fn contact_block(&self, account_id: &str, peer_id: &str, now: i64) -> Result<()>;
    /// Replace this active contact's permissions, validating bounds.
    async fn contact_update(
        &self,
        account_id: &str,
        peer_id: &str,
        config: ContactConfig,
        now: i64,
    ) -> Result<()>;
    /// All retained cross-account inbox rows, ordered by sequence.
    async fn xinbox(&self, account_id: &str) -> Result<Vec<XInbox>>;
    /// Insert message, delivery and inbox metadata atomically, or return its duplicate.
    async fn xinsert(
        &self,
        account_id: &str,
        message: Message,
        inbox: XInbox,
    ) -> Result<(XInbox, bool)>;
    /// Advance each endpoint's cross-account cursor over the leading requested run.
    async fn xack(
        &self,
        account_id: &str,
        endpoints: &[String],
        seqs: &[i64],
        now: i64,
    ) -> Result<usize>;
    /// Apply local receipts and advance cross-account cursors in one transaction.
    async fn acknowledge(
        &self,
        account_id: &str,
        changes: HubWrite,
        endpoints: &[String],
        seqs: &[i64],
        now: i64,
    ) -> Result<usize>;
    /// Delete inbox messages from accounts that are no longer inbound contacts.
    async fn xprune(&self, account_id: &str) -> Result<u64>;
    // Host credentials.
    /// Insert a credential. Duplicate hash/id or live token name is Conflict.
    async fn create_credential(&self, credential: Credential) -> Result<()>;
    /// Resolve a digest at now; expired and revoked rows remain distinguishable.
    async fn credential_by_hash(&self, hash: &str, now: i64) -> Result<CredentialLookup>;
    /// Resolve an id at now, with the same semantics as digest lookup.
    async fn credential_by_id(&self, id: &str, now: i64) -> Result<CredentialLookup>;
    /// Set last_used_at to now only when it advances; missing id is NotFound.
    async fn touch_credential(&self, id: &str, now: i64) -> Result<()>;
    /// Revoke once at now. Return false for missing or already revoked ids.
    async fn revoke_credential(&self, id: &str, now: i64) -> Result<bool>;
    // Host device login.
    /// Delete expired, redeemed or denied device codes. Return the deleted count.
    async fn purge_device_codes(&self, now: i64) -> Result<u64>;
    /// Insert a pending code, pruning at created_at. Duplicate digest/user code
    /// is Conflict; 1000 unexpired pending codes globally is Capacity.
    async fn create_device_code(&self, code: DeviceCode) -> Result<()>;
    /// Read by normalized user code; this read does not change polling state.
    async fn device_code(&self, user_code: &str) -> Result<Option<DeviceCode>>;
    /// Atomically approve an unexpired pending code for an existing member.
    /// Missing code is NotFound; expired or decided code is Conflict.
    async fn approve_device(
        &self,
        user_code: &str,
        account_id: &str,
        member_id: &str,
        now: i64,
    ) -> Result<()>;
    /// Atomically deny an unexpired pending code with the same error semantics.
    async fn deny_device(&self, user_code: &str, now: i64) -> Result<()>;
    /// Atomically record a poll and return its state at now; interval is in ms.
    async fn poll_device(&self, hash: &str, now: i64, interval_ms: i64) -> Result<DevicePoll>;
    /// Atomically insert a matching device credential and consume an approved,
    /// unexpired code. Concurrent redemption has exactly one winner; all losers
    /// return Conflict. A missing hash is NotFound. Failure inserts nothing.
    async fn redeem_device(&self, hash: &str, credential: Credential, now: i64) -> Result<()>;
    // Hub machines and endpoints.
    /// Upsert a binding and remove its tombstone and idle_since state together.
    async fn put_machine(&self, account_id: &str, machine: Machine) -> Result<()>;
    /// List machines ordered by name.
    async fn machines(&self, account_id: &str) -> Result<Vec<Machine>>;
    /// Remove a binding and optionally create its tombstone atomically.
    /// A missing binding is NotFound. Endpoint/message purges are separate.
    async fn remove_machine(
        &self,
        account_id: &str,
        name: &str,
        tombstone: Option<Tombstone>,
    ) -> Result<()>;
    /// List machine tombstones ordered by name.
    async fn tombstones(&self, account_id: &str) -> Result<Vec<Tombstone>>;
    /// Delete a tombstone, returning false when absent.
    async fn remove_tombstone(&self, account_id: &str, name: &str) -> Result<bool>;
    /// Upsert one endpoint, enforcing unique machine/handle and token digest.
    async fn put_endpoint(&self, account_id: &str, endpoint: Endpoint) -> Result<()>;
    /// List endpoints, optionally for one machine, ordered by machine/handle/id.
    async fn endpoints(&self, account_id: &str, machine: Option<&str>) -> Result<Vec<Endpoint>>;
    /// Delete an endpoint, returning false when absent.
    async fn remove_endpoint(&self, account_id: &str, id: &str) -> Result<bool>;
    /// Apply every supplied change in one transaction, scoped to this account.
    /// Missing removals are no-ops. Invalid JSON or a conflict rolls back all
    /// changes. Machine removal clears its wake state and tombstone. Delivery
    /// updates retain identity and fail with NotFound when absent.
    async fn hub_write(&self, account_id: &str, changes: HubWrite) -> Result<()>;
    // Hub messaging.
    /// Insert a message, all deliveries and optional idempotency row in ONE
    /// transaction. Any conflict rolls everything back. Return deliveries in
    /// input order with allocated sequences. All JSON is validated before commit.
    async fn store_message(
        &self,
        account_id: &str,
        message: Message,
        deliveries: Vec<NewDelivery>,
        idempotency: Option<Idempotency>,
    ) -> Result<Vec<Delivery>>;
    /// Store a message and apply admission effects in the same transaction.
    /// Delivery sequence values are inserted into the idempotency result's
    /// deliveries array, when present, before it is saved. All other guarantees
    /// of store_message and hub_write apply to the complete transaction.
    async fn route_message(
        &self,
        account_id: &str,
        message: Message,
        deliveries: Vec<NewDelivery>,
        idempotency: Option<Idempotency>,
        changes: HubWrite,
    ) -> Result<Vec<Delivery>>;
    /// Read a message by account/id.
    async fn message(&self, account_id: &str, id: &str) -> Result<Option<Message>>;
    /// Count messages created at or after since, excluding the relay's stable
    /// system sender id. Expired messages count until retention removes them.
    async fn sent_count(&self, account_id: &str, since: i64) -> Result<i64>;
    /// List at most limit messages created at or after since, optionally in one
    /// thread, ordered by created_at/id. Limit is clamped to 1..=2001.
    async fn messages(
        &self,
        account_id: &str,
        thread: Option<&str>,
        since: i64,
        limit: usize,
    ) -> Result<Vec<Message>>;
    /// Whether this machine has an unexpired unacknowledged delivery or an
    /// unexpired outgoing request with no reply. Missing machines return false.
    async fn machine_busy(&self, account_id: &str, machine: &str, now: i64) -> Result<bool>;
    /// List a machine's unacknowledged, unexpired mirrored deliveries after the
    /// cursor, ordered by sequence. Limit is clamped to 1..=200. Now is supplied
    /// by the caller. Direct-client rows and other accounts are excluded.
    async fn pending_machine(
        &self,
        account_id: &str,
        machine: &str,
        after: i64,
        now: i64,
        limit: usize,
    ) -> Result<Vec<Delivery>>;
    /// Pending deliveries with an independent cross-account replay cursor.
    async fn pending_machine_x(
        &self,
        account_id: &str,
        machine: &str,
        after: i64,
        xafter: i64,
        now: i64,
        limit: usize,
    ) -> Result<Vec<Delivery>>;
    /// Whether the endpoint sent or received any message in this thread.
    async fn thread_member(&self, account_id: &str, thread: &str, endpoint: &str) -> Result<bool>;
    /// Find at most two member messages whose id equals reference or ends in it.
    /// Suffixes shorter than four characters match nothing. Exact matches take
    /// precedence. Results are ordered newest first by created_at/id.
    async fn member_messages(
        &self,
        account_id: &str,
        endpoint: &str,
        reference: &str,
    ) -> Result<Vec<Message>>;
    /// List all deliveries of one account's message, ordered by sequence,
    /// including acknowledged, rejected and expired rows. Missing is empty.
    async fn message_deliveries(&self, account_id: &str, message: &str) -> Result<Vec<Delivery>>;
    /// List deliveries for an endpoint with seq > after, in ascending sequence.
    /// Include acknowledged/rejected/expired rows; the caller filters at its now.
    async fn deliveries(
        &self,
        account_id: &str,
        endpoint: &str,
        after: i64,
    ) -> Result<Vec<Delivery>>;
    /// List open, unexpired deliveries after the cursor, ordered by sequence.
    /// Limit is clamped to 1..=200.
    async fn open_deliveries(
        &self,
        account_id: &str,
        endpoint: &str,
        after: i64,
        now: i64,
        limit: usize,
    ) -> Result<Vec<Delivery>>;
    /// Count open, unexpired deliveries for one endpoint.
    async fn open_delivery_count(&self, account_id: &str, endpoint: &str, now: i64) -> Result<i64>;
    /// First unexpired reply delivery to this request's sender from an addressed
    /// recipient. Include acknowledged replies; requests without deliveries
    /// accept any sender. Missing or foreign requests return None.
    async fn reply_delivery(
        &self,
        account_id: &str,
        endpoint: &str,
        request: &str,
        now: i64,
    ) -> Result<Option<Delivery>>;
    /// Replace a delivery's ack/reject/state fields atomically, retaining identity.
    async fn update_delivery(&self, account_id: &str, delivery: Delivery) -> Result<()>;
    /// Read an idempotency result by account, sender and client id.
    async fn idempotency(
        &self,
        account_id: &str,
        from_ep: &str,
        client_id: &str,
    ) -> Result<Option<Idempotency>>;
    /// Delete messages expired at now, their deliveries, and idempotency rows
    /// created before idempotency_before together. Return deleted message count.
    async fn purge_messages(
        &self,
        account_id: &str,
        now: i64,
        idempotency_before: i64,
    ) -> Result<u64>;
    // Hub limits.
    /// UTF-8 bytes of all retained local message bodies plus the stored
    /// cross-account inbox messages, including acknowledged and expired ones
    /// until retention removes them. Missing accounts hold zero.
    async fn stored_bytes(&self, account_id: &str) -> Result<u64>;

    // Hub key/value state and event logs.
    /// Read a JSON state value by key.
    async fn state(&self, account_id: &str, key: &str) -> Result<Option<String>>;
    /// Upsert a JSON state value, or remove it for None (missing is a no-op).
    async fn put_state(&self, account_id: &str, key: &str, value: Option<&str>) -> Result<()>;
    /// Append a local or routed pair event. Duplicate events are allowed.
    async fn append_pair(&self, account_id: &str, event: PairEvent, local: bool) -> Result<()>;
    /// List pair events at or after since, ordered by at/from/to. None selects
    /// all senders or recipients. `local` selects local_events or pair_events.
    async fn pairs(
        &self,
        account_id: &str,
        from: Option<&str>,
        to: Option<&str>,
        since: i64,
        local: bool,
    ) -> Result<Vec<PairEvent>>;
    /// Append activity/audit, ignoring input id and returning a monotonic id.
    async fn append_event(&self, account_id: &str, log: EventLog, event: Event) -> Result<i64>;
    /// List activity/audit after id, ascending by id.
    async fn events(&self, account_id: &str, log: EventLog, after: i64) -> Result<Vec<Event>>;
    /// Delete pair events and activity/audit older than before atomically.
    /// Caller enforces retention policy; the backend never reads wall time.
    async fn purge_events(&self, account_id: &str, before: i64) -> Result<()>;
}

#[cfg(any(test, feature = "testsuite"))]
pub mod testsuite;
