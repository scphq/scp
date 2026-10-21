//! Hosted-relay JSON routes and pre-RPC authentication checks.
use crate::{
    admin, hash,
    hub::{Grant, Hub},
    now_ms, random, valid_name,
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State, WebSocketUpgrade},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use scp_relay_store::*;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};

/// Runtime hub limits; None removes a cap. Durations always remain finite.
#[derive(Clone, Debug)]
pub struct Limits(pub BTreeMap<String, Option<u64>>);
impl Default for Limits {
    fn default() -> Self {
        Self(
            [
                ("machines", 16),
                ("endpoints", 512),
                ("sockets", 64),
                ("frameBytes", 262144),
                ("callsPerMinute", 120),
                ("bridgeCallsPerMinute", 600),
                ("accountCallsPerMinute", 1200),
                ("acksPerMinute", 1200),
                ("accountAcksPerMinute", 4800),
                ("storedBytes", 256 * 1024 * 1024),
                ("refusalsPerMinute", 10),
                ("clientMachineIdleS", 14 * 86400),
                ("idlePurgeS", 30 * 86400),
                ("httpWaitS", 25),
                ("revalidateMs", 300000),
                ("deniedS", 3600),
            ]
            .into_iter()
            .map(|(k, v)| (k.into(), Some(v)))
            .collect(),
        )
    }
}
impl Limits {
    /// Apply key=value or key=Infinity, rejecting unknown keys and infinite durations.
    pub fn apply(&mut self, raw: &str) -> std::result::Result<(), String> {
        let (key, value) = raw.split_once('=').ok_or("limit must be key=value")?;
        if !self.0.contains_key(key) {
            return Err(format!("unknown limit: {key}"));
        }
        let duration = matches!(
            key,
            "clientMachineIdleS" | "idlePurgeS" | "httpWaitS" | "revalidateMs" | "deniedS"
        );
        let parsed = if value == "Infinity" && !duration {
            None
        } else {
            Some(
                value
                    .parse::<u64>()
                    .map_err(|_| "limit must be a nonnegative integer, or Infinity for caps")?,
            )
        };
        if duration && parsed == Some(0) {
            return Err("duration must be positive".into());
        }
        self.0.insert(key.into(), parsed);
        Ok(())
    }
    /// Read a finite configured duration in seconds or milliseconds.
    pub fn duration(&self, key: &str, fallback: u64) -> u64 {
        self.0.get(key).copied().flatten().unwrap_or(fallback)
    }
    fn frame_bytes(&self) -> usize {
        self.0
            .get("frameBytes")
            .copied()
            .flatten()
            .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
            .unwrap_or(usize::MAX)
    }
}
/// Shared application dependencies. public_url has no trailing slash.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn RelayStore>,
    pub hub: Arc<Hub>,
    pub public_url: String,
    pub limits: Limits,
}
impl AppState {
    /// Build shared state for a listener and its HTTP and WebSocket routes.
    pub fn new(store: Arc<dyn RelayStore>, public_url: String, limits: Limits) -> Self {
        Self {
            hub: Arc::new(Hub::new(store.clone(), limits.clone())),
            store,
            public_url: public_url.trim_end_matches('/').into(),
            limits,
        }
    }
}
/// Build the relay router. JSON bodies are limited independently of socket frames.
pub fn router(state: AppState) -> Router {
    let frame_bytes = state.limits.frame_bytes();
    Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"ok":true,"service":"scp-relay"})) }),
        )
        .route(
            "/device",
            get(|| async {
                "Run scp-relay device approve <code> --account <handle> --member <name>"
            }),
        )
        .route("/v1/whoami", get(whoami))
        .route("/v1/device/code", post(device_code))
        .route("/v1/device/token", post(device_token))
        .route("/v1/relay/ws", any(ws))
        .route("/v1/relay/rpc", any(rpc))
        .fallback(|| async { (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))) })
        .layer(DefaultBodyLimit::max(frame_bytes))
        .with_state(state)
}
struct ApiError(StatusCode, Value);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}
type ApiResult<T> = std::result::Result<T, ApiError>;
fn auth_error(error: &str) -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        json!({"error":error,"message":error}),
    )
}
fn device_error(error: &str, description: &str) -> ApiError {
    ApiError(
        StatusCode::BAD_REQUEST,
        json!({"error":error,"error_description":description}),
    )
}
fn backend(e: StoreError) -> ApiError {
    tracing::error!(error=%e,"store operation failed");
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error":"server_error"}),
    )
}
fn input(headers: &HeaderMap, bytes: &Bytes) -> ApiResult<Value> {
    if let Some(ct) = headers.get("content-type")
        && !ct
            .to_str()
            .unwrap_or("")
            .split(';')
            .next()
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(device_error("invalid_request", "Use a JSON object body."));
    }
    let v = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(bytes)
            .map_err(|_| device_error("invalid_request", "Invalid JSON body."))?
    };
    if !v.is_object() {
        return Err(device_error("invalid_request", "Use a JSON object body."));
    }
    Ok(v)
}
async fn authenticate(state: &AppState, headers: &HeaderMap) -> ApiResult<Identity> {
    let raw = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| auth_error("unauthorized"))?;
    let mut parts = raw.split_whitespace();
    let scheme = parts.next().ok_or_else(|| auth_error("unauthorized"))?;
    let secret = parts.next().ok_or_else(|| auth_error("unauthorized"))?;
    if !scheme.eq_ignore_ascii_case("Bearer") || parts.next().is_some() {
        return Err(auth_error("unauthorized"));
    }
    if secret.len() > 128 || !(secret.starts_with("scp_d_") || secret.starts_with("scp_t_")) {
        return Err(auth_error("invalid"));
    }
    let identity = match state
        .store
        .credential_by_hash(&hash(secret), now_ms())
        .await
        .map_err(backend)?
    {
        CredentialLookup::Active(i) => *i,
        CredentialLookup::Invalid => return Err(auth_error("invalid")),
        CredentialLookup::Revoked => return Err(auth_error("revoked")),
        CredentialLookup::Expired => return Err(auth_error("expired")),
    };
    if (identity.credential.kind == CredentialKind::Device) != secret.starts_with("scp_d_") {
        return Err(auth_error("invalid"));
    }
    state
        .store
        .touch_credential(&identity.credential.id, now_ms())
        .await
        .map_err(backend)?;
    Ok(identity)
}
/// Map a resolved credential into the hub's trusted account/member context.
pub fn grant(i: &Identity) -> Grant {
    let c = &i.credential;
    Grant {
        token_id: c.id.clone(),
        user_id: i.account.id.clone(),
        actor_id: i.member.id.clone(),
        role: i.member.role,
        scoped: c.kind == CredentialKind::Token,
        labels: if c.kind == CredentialKind::Token {
            BTreeMap::from([("token".into(), c.name.clone())])
        } else {
            c.labels.clone()
        },
        expires_at: c
            .expires_at
            .unwrap_or_else(|| now_ms().saturating_add(365 * 86400000)),
        account: i.account.handle.clone(),
    }
}
async fn whoami(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let i = authenticate(&s, &headers).await?;
    let g = grant(&i);
    let c = i.credential;
    Ok(Json(
        json!({"kind":c.kind,"org":i.account.handle,"email":i.member.email,"role":i.member.role,"label":c.name,"ambient":g.scoped,"endpoint_labels":g.labels,"expires_at":c.expires_at.map(crate::iso)}),
    ))
}
async fn device_code(
    State(s): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    let v = input(&headers, &bytes)?;
    let label = match v.get("label") {
        None => "cli",
        Some(Value::String(v)) if v.is_empty() => "cli",
        Some(Value::String(v)) => v,
        _ => {
            return Err(device_error(
                "invalid_request",
                "label must be a machine name.",
            ));
        }
    };
    if !valid_name(label) {
        return Err(device_error(
            "invalid_request",
            "label must be a machine name.",
        ));
    }
    let code = random("");
    let now = now_ms();
    let mut user = String::new();
    for _ in 0..4 {
        use rand::Rng;
        const ALPHABET: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
        user = (0..8)
            .filter_map(|_| {
                ALPHABET
                    .get(rand::thread_rng().gen_range(0..ALPHABET.len()))
                    .copied()
                    .map(char::from)
            })
            .collect();
        let c = DeviceCode {
            device_code_hash: hash(&code),
            user_code: user.clone(),
            label: label.into(),
            created_at: now,
            expires_at: now + 900000,
            last_poll_at: None,
            state: DeviceState::Pending,
            account_id: None,
            member_id: None,
            credential_id: None,
        };
        match s.store.create_device_code(c).await {
            Ok(()) => break,
            Err(StoreError::Capacity) => {
                return Err(ApiError(
                    StatusCode::TOO_MANY_REQUESTS,
                    json!({"error":"slow_down"}),
                ));
            }
            Err(StoreError::Conflict) => {
                user.clear();
            }
            Err(e) => return Err(backend(e)),
        }
    }
    if user.is_empty() {
        return Err(backend(StoreError::Conflict));
    }
    let shown = format!(
        "{}-{}",
        user.get(..4).unwrap_or(""),
        user.get(4..).unwrap_or("")
    );
    let uri = format!("{}/device", s.public_url);
    Ok(Json(
        json!({"device_code":code,"user_code":shown,"verification_uri":uri,"verification_uri_complete":format!("{uri}?code={shown}"),"expires_in":900,"interval":5}),
    ))
}
async fn device_token(
    State(s): State<AppState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> ApiResult<Json<Value>> {
    let v = input(&headers, &bytes)?;
    let raw = v.get("device_code").and_then(Value::as_str).unwrap_or("");
    let h = hash(raw);
    let now = now_ms();
    let code = match s.store.poll_device(&h, now, 5000).await.map_err(backend)? {
        DevicePoll::Invalid => {
            return Err(device_error(
                "invalid_grant",
                "Unknown or already redeemed device code.",
            ));
        }
        DevicePoll::Denied => return Err(device_error("access_denied", "The login was denied.")),
        DevicePoll::Expired => {
            return Err(device_error("expired_token", "The device code expired."));
        }
        DevicePoll::SlowDown => {
            return Err(device_error(
                "slow_down",
                "Add 5 seconds to the polling interval.",
            ));
        }
        DevicePoll::Pending => {
            return Err(device_error(
                "authorization_pending",
                "Waiting for approval.",
            ));
        }
        DevicePoll::Approved(c) => c,
    };
    let account_id = code
        .account_id
        .ok_or_else(|| device_error("access_denied", "Approval is no longer valid."))?;
    let member_id = code
        .member_id
        .ok_or_else(|| device_error("access_denied", "Approval is no longer valid."))?;
    let member = s
        .store
        .members(&account_id)
        .await
        .map_err(backend)?
        .into_iter()
        .find(|m| m.id == member_id)
        .ok_or_else(|| device_error("access_denied", "Member is no longer present."))?;
    let placeholder = Account {
        id: account_id,
        handle: String::new(),
        created_at: 0,
    };
    let (secret, c) = admin::credential(&placeholder, &member, true, code.label.clone(), None);
    match s.store.redeem_device(&h, c.clone(), now).await {
        Ok(()) => {}
        Err(StoreError::Conflict | StoreError::NotFound) => {
            return Err(device_error(
                "invalid_grant",
                "Unknown or already redeemed device code.",
            ));
        }
        Err(e) => return Err(backend(e)),
    }
    let identity = match s
        .store
        .credential_by_id(&c.id, now)
        .await
        .map_err(backend)?
    {
        CredentialLookup::Active(i) => i,
        _ => {
            return Err(device_error(
                "access_denied",
                "Approval is no longer valid.",
            ));
        }
    };
    Ok(Json(
        json!({"access_token":secret,"token_type":"Bearer","credential_id":c.id,"org":identity.account.handle,"email":member.email,"label":code.label,"relay":s.public_url}),
    ))
}
async fn rpc(
    State(s): State<AppState>,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> ApiResult<Response> {
    let i = authenticate(&s, &headers).await?;
    if method != Method::POST {
        return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
    }
    let body = serde_json::from_slice(&bytes)
        .map_err(|_| device_error("invalid_request", "Invalid JSON body."))?;
    Ok(Json(s.hub.rpc(grant(&i), body).await).into_response())
}
async fn ws(
    State(s): State<AppState>,
    headers: HeaderMap,
    upgrade: std::result::Result<
        WebSocketUpgrade,
        axum::extract::ws::rejection::WebSocketUpgradeRejection,
    >,
) -> ApiResult<Response> {
    let i = authenticate(&s, &headers).await?;
    if !headers
        .get("upgrade")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
    {
        return Ok(StatusCode::UPGRADE_REQUIRED.into_response());
    }
    let upgrade = upgrade
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, json!({"error":"invalid_request"})))?;
    let frame = s.limits.frame_bytes();
    let revalidate_ms = s
        .limits
        .0
        .get("revalidateMs")
        .copied()
        .flatten()
        .unwrap_or(300_000);
    let lease = s.hub.track();
    Ok(upgrade
        .max_message_size(frame)
        .max_frame_size(frame)
        .on_upgrade(move |socket| async move {
            let _lease = lease;
            s.hub
                .websocket(grant(&i), socket, frame, revalidate_ms)
                .await;
        }))
}
