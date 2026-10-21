//! Ordered authentication for relay transports and the public dashboard API.
use crate::{admin, hash, now_ms};
use async_trait::async_trait;
use axum::http::{HeaderMap, Method};
use scp_relay_store::{
    Account, Credential, CredentialKind, CredentialLookup, Member, RelayStore, Role, StoreError,
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

/// Immutable transport metadata. The peer is the TCP peer, never a forwarded header.
#[derive(Clone, Debug)]
pub struct AuthRequest {
    pub method: Method,
    pub path: String,
    pub headers: HeaderMap,
    pub peer: SocketAddr,
    pub tls_client_cert_der: Option<Vec<u8>>,
}
/// A resolved account and member with a stable credential binding.
#[derive(Clone, Debug)]
pub struct Identity {
    pub account: Account,
    pub member: Member,
    pub credential: Credential,
    pub scoped: bool,
    pub label: String,
}
impl From<scp_relay_store::Identity> for Identity {
    fn from(i: scp_relay_store::Identity) -> Self {
        Self {
            scoped: i.credential.kind == CredentialKind::Token,
            label: i.credential.name.clone(),
            account: i.account,
            member: i.member,
            credential: i.credential,
        }
    }
}
impl Identity {
    pub(crate) fn stored(&self) -> scp_relay_store::Identity {
        let mut credential = self.credential.clone();
        credential.kind = if self.scoped {
            CredentialKind::Token
        } else {
            CredentialKind::Device
        };
        credential.name = self.label.clone();
        scp_relay_store::Identity {
            account: self.account.clone(),
            member: self.member.clone(),
            credential,
        }
    }
    /// Resolve the trusted context consumed by the hub.
    pub fn grant(&self) -> crate::hub::Grant {
        crate::http::grant(&self.stored())
    }
}
/// Pass does not apply. Reject and backend Unavailable are terminal for this attempt.
#[derive(Debug)]
#[non_exhaustive]
pub enum AuthOutcome {
    Identity(Box<Identity>),
    Reject(String),
    Unavailable(String),
    Pass,
}
/// Implementations must recheck mutable identity and credential state on every call.
/// Return Unavailable when a backend failure prevents a decision, Reject for a
/// definitive denial, and Pass only when the method does not apply.
/// JWT extensions should cache JWKS keys and validate RS256/ES256, issuer, audience
/// and expiry before mapping claims. mTLS extensions should validate the supplied
/// client certificate against an explicit trust policy before mapping its subject.
#[async_trait]
pub trait RelayAuth: Send + Sync {
    async fn authenticate(&self, request: &AuthRequest) -> AuthOutcome;
}
/// First identity wins; rejection prevents fallback to a weaker method.
///
/// ```
/// use std::sync::Arc;
/// use scp_relay::{AuthChain, RelayAuth, auth::NativeAuth, http::{AppState, Limits}};
/// use scp_relay_store::RelayStore;
/// fn state(store: Arc<dyn RelayStore>, custom: Arc<dyn RelayAuth>) -> AppState {
///     let native = Arc::new(NativeAuth::new(store.clone()));
///     AppState::new(store, "http://localhost:8787".into(), Limits::default())
///         .with_auth(AuthChain(vec![native, custom]))
/// }
/// ```
#[derive(Clone, Default)]
pub struct AuthChain(pub Vec<Arc<dyn RelayAuth>>);
impl AuthChain {
    pub async fn authenticate(&self, request: &AuthRequest) -> AuthOutcome {
        for method in &self.0 {
            match method.authenticate(request).await {
                AuthOutcome::Pass => {}
                outcome => return outcome,
            }
        }
        let bearer = request
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                let parts: Vec<_> = v.split_whitespace().collect();
                parts.len() == 2 && parts[0].eq_ignore_ascii_case("bearer")
            });
        AuthOutcome::Reject(if bearer { "invalid" } else { "unauthorized" }.into())
    }
}
/// Native device and scoped bearer credentials, resolved against the store.
pub struct NativeAuth {
    store: Arc<dyn RelayStore>,
    touches: tokio::sync::Mutex<BTreeMap<String, i64>>,
}
impl NativeAuth {
    pub fn new(store: Arc<dyn RelayStore>) -> Self {
        Self {
            store,
            touches: Default::default(),
        }
    }
}
#[async_trait]
impl RelayAuth for NativeAuth {
    async fn authenticate(&self, r: &AuthRequest) -> AuthOutcome {
        let values = r.headers.get_all("authorization");
        let native = values.iter().find(|header| {
            let raw = String::from_utf8_lossy(header.as_bytes());
            let mut parts = raw.split_whitespace();
            parts
                .next()
                .is_some_and(|v| v.eq_ignore_ascii_case("bearer"))
                && parts.next().is_some_and(|v| v.starts_with("scp_"))
        });
        let Some(header) = native else {
            return AuthOutcome::Pass;
        };
        let Ok(raw) = header.to_str() else {
            return AuthOutcome::Reject("invalid".into());
        };
        if values.iter().count() != 1 {
            return AuthOutcome::Reject("invalid".into());
        }
        let mut parts = raw.split_whitespace();
        let (Some(scheme), Some(secret)) = (parts.next(), parts.next()) else {
            return AuthOutcome::Pass;
        };
        if !scheme.eq_ignore_ascii_case("bearer") || !secret.starts_with("scp_") {
            return AuthOutcome::Pass;
        }
        let reject = |s: &str| AuthOutcome::Reject(s.into());
        if parts.next().is_some()
            || secret.len() > 128
            || !(secret.starts_with("scp_d_") || secret.starts_with("scp_t_"))
        {
            return reject("invalid");
        }
        let identity = match self.store.credential_by_hash(&hash(secret), now_ms()).await {
            Ok(CredentialLookup::Active(i)) => *i,
            Ok(CredentialLookup::Revoked) => return reject("revoked"),
            Ok(CredentialLookup::Expired) => return reject("expired"),
            Ok(_) => return reject("invalid"),
            Err(e @ StoreError::Backend(_)) => return AuthOutcome::Unavailable(e.to_string()),
            Err(_) => return reject("invalid"),
        };
        if (identity.credential.kind == CredentialKind::Device) != secret.starts_with("scp_d_") {
            return reject("invalid");
        }
        let now = now_ms();
        let due = {
            let mut touches = self.touches.lock().await;
            touches.retain(|_, at| now.saturating_sub(*at) < 10_000);
            let due = !touches.contains_key(&identity.credential.id);
            if due {
                touches.insert(identity.credential.id.clone(), now);
            }
            due
        };
        if due
            && let Err(e) = self
                .store
                .touch_credential(&identity.credential.id, now)
                .await
        {
            self.touches.lock().await.remove(&identity.credential.id);
            return match e {
                StoreError::Backend(_) => AuthOutcome::Unavailable(e.to_string()),
                _ => reject("invalid"),
            };
        }
        AuthOutcome::Identity(Box::new(identity.into()))
    }
}
/// An IPv4 or IPv6 network. Address families are matched explicitly.
#[derive(Clone, Debug)]
pub struct Cidr {
    address: IpAddr,
    prefix: u8,
}
impl std::str::FromStr for Cidr {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        let (ip, prefix) = s.split_once('/').ok_or("trusted proxy must be a CIDR")?;
        let address: IpAddr = ip.parse().map_err(|_| "invalid proxy address")?;
        let prefix = prefix.parse().map_err(|_| "invalid proxy prefix")?;
        if prefix > if address.is_ipv4() { 32 } else { 128 } {
            return Err("invalid proxy prefix".into());
        }
        if let IpAddr::V6(ip) = address
            && let Some(ip) = ip.to_ipv4_mapped()
        {
            if prefix < 96 {
                return Err("IPv4-mapped proxy prefix must be at least 96".into());
            }
            return Ok(Self {
                address: IpAddr::V4(ip),
                prefix: prefix - 96,
            });
        }
        Ok(Self { address, prefix })
    }
}
impl Cidr {
    fn contains(&self, ip: IpAddr) -> bool {
        match (self.address, ip.to_canonical()) {
            (IpAddr::V4(a), IpAddr::V4(b)) => {
                self.prefix == 0 || (u32::from(a) ^ u32::from(b)) >> (32 - self.prefix) == 0
            }
            (IpAddr::V6(a), IpAddr::V6(b)) => {
                self.prefix == 0 || (u128::from(a) ^ u128::from(b)) >> (128 - self.prefix) == 0
            }
            _ => false,
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeaderMapping {
    pub account: String,
    pub member: String,
    pub role: Role,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeaderDefault {
    pub account: String,
    pub role: Role,
}
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeaderMapConfig {
    pub default: Option<HeaderDefault>,
    #[serde(default)]
    pub users: BTreeMap<String, HeaderMapping>,
}
/// Identity supplied by an explicitly trusted reverse proxy.
pub struct TrustedHeaderAuth {
    store: Arc<dyn RelayStore>,
    proxies: Vec<Cidr>,
    user: axum::http::HeaderName,
    email: axum::http::HeaderName,
    mapping: HeaderMapConfig,
}
impl TrustedHeaderAuth {
    pub fn new(
        store: Arc<dyn RelayStore>,
        proxies: Vec<Cidr>,
        user: &str,
        email: &str,
        mapping: HeaderMapConfig,
    ) -> Result<Self, String> {
        if proxies.is_empty() {
            return Err("trusted-header requires --trusted-proxy".into());
        }
        Ok(Self {
            store,
            proxies,
            user: user.parse().map_err(|_| "invalid user header")?,
            email: email.parse().map_err(|_| "invalid email header")?,
            mapping,
        })
    }
}
#[async_trait]
impl RelayAuth for TrustedHeaderAuth {
    async fn authenticate(&self, r: &AuthRequest) -> AuthOutcome {
        let reject = || AuthOutcome::Reject("unauthorized".into());
        if !r.headers.contains_key(&self.user) && !r.headers.contains_key(&self.email) {
            return AuthOutcome::Pass;
        }
        if r.peer.ip().is_unspecified() || !self.proxies.iter().any(|p| p.contains(r.peer.ip())) {
            return reject();
        }
        if r.headers.get_all(&self.user).iter().count() > 1
            || r.headers.get_all(&self.email).iter().count() > 1
        {
            return reject();
        }
        let user = r
            .headers
            .get(&self.user)
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.trim().is_empty());
        let email = r
            .headers
            .get(&self.email)
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.trim().is_empty());
        let Some(name) = user.or(email) else {
            return reject();
        };
        let mapped = self
            .mapping
            .users
            .get(name)
            .or_else(|| email.and_then(|e| self.mapping.users.get(e)));
        let (account, member, role) = match (mapped, &self.mapping.default) {
            (Some(m), _) => (m.account.as_str(), m.member.as_str(), m.role),
            (None, Some(d)) => (d.account.as_str(), name, d.role),
            _ => return reject(),
        };
        let (account, member) = match admin::member(
            self.store.as_ref(),
            account,
            member,
            email.map(str::to_owned),
            Some(role),
        )
        .await
        {
            Ok(identity) => identity,
            Err(e @ StoreError::Backend(_)) => {
                return AuthOutcome::Unavailable(e.to_string());
            }
            Err(_) => return reject(),
        };
        let credential = Credential {
            id: format!("hdr:{}:{}", account.id, member.id),
            account_id: account.id.clone(),
            member_id: member.id.clone(),
            kind: CredentialKind::Device,
            name: name.into(),
            secret_hash: String::new(),
            labels: BTreeMap::new(),
            created_at: 0,
            expires_at: None,
            revoked_at: None,
            last_used_at: None,
        };
        AuthOutcome::Identity(Box::new(Identity {
            account,
            member,
            credential,
            scoped: false,
            label: name.into(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(peer: &str, user: Option<&str>) -> AuthRequest {
        let mut headers = HeaderMap::new();
        if let Some(user) = user {
            headers.insert("x-forwarded-user", user.parse().unwrap());
        }
        AuthRequest {
            method: Method::GET,
            path: "/v1/whoami".into(),
            headers,
            peer: peer.parse().unwrap(),
            tls_client_cert_der: None,
        }
    }
    async fn fixture() -> (Arc<dyn RelayStore>, HeaderMapConfig) {
        let store = scp_relay_store::connect("sqlite::memory:").await.unwrap();
        admin::account(store.as_ref(), "team").await.unwrap();
        let mapping = serde_json::from_value(serde_json::json!({"default":null,"users":{"alice":{"account":"team","member":"operator","role":"admin"}}})).unwrap();
        (store, mapping)
    }
    #[tokio::test]
    async fn proxy_trust_mapping_and_default_preserve_existing_role() {
        let (store, mapping) = fixture().await;
        assert!(
            TrustedHeaderAuth::new(
                store.clone(),
                vec![],
                "x-forwarded-user",
                "x-forwarded-email",
                mapping.clone()
            )
            .is_err()
        );
        let mut auth = TrustedHeaderAuth::new(
            store,
            vec!["127.0.0.0/8".parse().unwrap(), "::1/128".parse().unwrap()],
            "x-forwarded-user",
            "x-forwarded-email",
            mapping,
        )
        .unwrap();
        assert!(matches!(
            auth.authenticate(&request("192.0.2.1:1", Some("alice")))
                .await,
            AuthOutcome::Reject(_)
        ));
        assert!(matches!(
            auth.authenticate(&request("192.0.2.1:1", None)).await,
            AuthOutcome::Pass
        ));
        assert!(matches!(
            auth.authenticate(&request("127.0.0.1:1", Some("unknown")))
                .await,
            AuthOutcome::Reject(_)
        ));
        let AuthOutcome::Identity(first) = auth
            .authenticate(&request("127.0.0.1:1", Some("alice")))
            .await
        else {
            panic!("identity")
        };
        assert_eq!(first.account.handle, "team");
        assert_eq!(first.member.name, "operator");
        assert_eq!(first.member.role, Role::Admin);
        assert!(!first.scoped);
        assert_eq!(
            first.credential.id,
            format!("hdr:{}:{}", first.account.id, first.member.id)
        );
        auth.mapping.users.get_mut("alice").unwrap().role = Role::Owner;
        let AuthOutcome::Identity(second) =
            auth.authenticate(&request("[::1]:1", Some("alice"))).await
        else {
            panic!("identity")
        };
        assert_eq!(second.member.role, Role::Admin);
        assert_eq!(second.credential.id, first.credential.id);
        auth.mapping.default = Some(HeaderDefault {
            account: "team".into(),
            role: Role::Member,
        });
        let AuthOutcome::Identity(default) = auth
            .authenticate(&request("127.0.0.1:1", Some("new-user")))
            .await
        else {
            panic!("identity")
        };
        assert_eq!(default.member.name, "new-user");
        assert_eq!(default.member.role, Role::Member);
    }
    #[tokio::test]
    async fn first_identity_wins_and_invalid_native_never_falls_through() {
        let (store, mapping) = fixture().await;
        let (a, m) = admin::member(store.as_ref(), "team", "native", None, None)
            .await
            .unwrap();
        let (secret, c) = admin::credential(&a, &m, true, "cli".into(), None);
        store.create_credential(c.clone()).await.unwrap();
        let native = Arc::new(NativeAuth::new(store.clone()));
        let header = Arc::new(
            TrustedHeaderAuth::new(
                store.clone(),
                vec!["127.0.0.0/8".parse().unwrap()],
                "x-forwarded-user",
                "x-forwarded-email",
                mapping,
            )
            .unwrap(),
        );
        let chain = AuthChain(vec![native.clone(), header.clone()]);
        let mut r = request("127.0.0.1:1", Some("alice"));
        r.headers
            .insert("authorization", format!("Bearer {secret}").parse().unwrap());
        let AuthOutcome::Identity(i) = chain.authenticate(&r).await else {
            panic!("identity")
        };
        assert_eq!(i.member.name, "native");
        let AuthOutcome::Identity(i) = AuthChain(vec![header, native]).authenticate(&r).await
        else {
            panic!("identity")
        };
        assert_eq!(i.member.name, "operator");
        store.revoke_credential(&c.id, now_ms()).await.unwrap();
        assert!(matches!(
            chain.authenticate(&r).await,
            AuthOutcome::Reject(_)
        ));
        r.headers
            .insert("authorization", "Bearer scp_t_unknown".parse().unwrap());
        assert!(matches!(
            chain.authenticate(&r).await,
            AuthOutcome::Reject(_)
        ));
        r.headers
            .insert("authorization", "Bearer other-provider".parse().unwrap());
        assert!(matches!(
            chain.authenticate(&r).await,
            AuthOutcome::Identity(_)
        ));
        r.headers
            .append("authorization", "Bearer scp_t_unknown".parse().unwrap());
        assert!(matches!(
            chain.authenticate(&r).await,
            AuthOutcome::Reject(_)
        ));
        r.headers.remove("authorization");
        assert!(matches!(
            chain.authenticate(&r).await,
            AuthOutcome::Identity(_)
        ));
        assert!(matches!(
            AuthChain::default().authenticate(&r).await,
            AuthOutcome::Reject(_)
        ));
    }
    #[test]
    fn cidr_boundaries_and_address_families() {
        let v4: Cidr = "192.0.2.128/25".parse().unwrap();
        assert!(v4.contains("192.0.2.255".parse().unwrap()));
        assert!(!v4.contains("192.0.2.127".parse().unwrap()));
        assert!(v4.contains("::ffff:192.0.2.255".parse().unwrap()));
        assert!(!v4.contains("::ffff:192.0.2.127".parse().unwrap()));
        let mapped: Cidr = "::ffff:10.0.0.0/104".parse().unwrap();
        assert!(mapped.contains("10.1.2.3".parse().unwrap()));
        assert!(mapped.contains("::ffff:10.1.2.3".parse().unwrap()));
        assert_eq!(
            "::ffff:10.0.0.0/64".parse::<Cidr>().unwrap_err(),
            "IPv4-mapped proxy prefix must be at least 96"
        );
        let v6: Cidr = "2001:db8::/32".parse().unwrap();
        assert!(v6.contains("2001:db8::1".parse().unwrap()));
        assert!(!v6.contains("2001:db9::1".parse().unwrap()));
        for invalid in ["127.0.0.1", "127.0.0.1/33", "::1/129", "oops/0"] {
            assert!(invalid.parse::<Cidr>().is_err());
        }
    }
    #[tokio::test]
    async fn credential_touch_advances_after_ten_seconds() {
        let (store, _) = fixture().await;
        let (a, m) = admin::member(store.as_ref(), "team", "touch", None, None)
            .await
            .unwrap();
        let (secret, c) = admin::credential(&a, &m, true, "cli".into(), None);
        store.create_credential(c.clone()).await.unwrap();
        let auth = NativeAuth::new(store.clone());
        let mut r = request("127.0.0.1:1", None);
        r.headers
            .insert("authorization", format!("Bearer {secret}").parse().unwrap());
        assert!(matches!(
            auth.authenticate(&r).await,
            AuthOutcome::Identity(_)
        ));
        auth.touches
            .lock()
            .await
            .insert(c.id.clone(), now_ms() - 10000);
        assert!(matches!(
            auth.authenticate(&r).await,
            AuthOutcome::Identity(_)
        ));
        let CredentialLookup::Active(i) = store.credential_by_id(&c.id, now_ms()).await.unwrap()
        else {
            panic!("identity")
        };
        assert_eq!(
            i.credential.last_used_at,
            Some(auth.touches.lock().await[&c.id])
        );
    }
}
