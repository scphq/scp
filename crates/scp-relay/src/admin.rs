//! Store-backed administrative operations, also usable while the server runs.
use crate::{hash, now_ms, random, valid_name};
use scp_relay_store::*;
use std::collections::BTreeMap;

/// Create an account idempotently by its validated handle.
pub async fn account(store: &dyn RelayStore, handle: &str) -> Result<Account> {
    if !valid_name(handle) {
        return Err(StoreError::Conflict);
    }
    store
        .create_account(Account {
            id: random("acc_"),
            handle: handle.into(),
            created_at: now_ms(),
        })
        .await
}
/// Resolve an account and create a member if absent. First member defaults to
/// owner; subsequent members default to member. Explicit roles apply on creation.
pub async fn member(
    store: &dyn RelayStore,
    handle: &str,
    name: &str,
    email: Option<String>,
    role: Option<Role>,
) -> Result<(Account, Member)> {
    let a = store.account(handle).await?.ok_or(StoreError::NotFound)?;
    if let Some(m) = store.member(&a.id, name).await? {
        return Ok((a, m));
    }
    if name.is_empty() {
        return Err(StoreError::Conflict);
    }
    let automatic_role = role.is_none();
    let m = Member {
        id: random("mem_"),
        account_id: a.id.clone(),
        name: name.into(),
        email,
        role: role.unwrap_or(Role::Member),
        created_at: now_ms(),
    };
    let m = store.ensure_member(m, automatic_role).await?;
    Ok((a, m))
}
/// Mint a credential and its one-time plaintext result. Callers output the secret
/// only to the requesting administrator or device client.
pub fn credential(
    a: &Account,
    m: &Member,
    device: bool,
    name: String,
    expires_at: Option<i64>,
) -> (String, Credential) {
    let secret = random(if device { "scp_d_" } else { "scp_t_" });
    let labels = if device {
        BTreeMap::new()
    } else {
        BTreeMap::from([("token".into(), name.clone())])
    };
    let c = Credential {
        id: random("cred_"),
        account_id: a.id.clone(),
        member_id: m.id.clone(),
        kind: if device {
            CredentialKind::Device
        } else {
            CredentialKind::Token
        },
        name,
        secret_hash: hash(&secret),
        labels,
        created_at: now_ms(),
        expires_at,
        revoked_at: None,
        last_used_at: None,
    };
    (secret, c)
}
