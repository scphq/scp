//! Hosted-relay JSON routes and pre-RPC authentication checks.
use crate::{
    admin,
    auth::{AuthChain, AuthOutcome, AuthRequest, NativeAuth},
    hash,
    hub::{Grant, Hub},
    now_ms, random, valid_name,
};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use scp_core::protocol::{LIMITS, LimitsError, RATE_DURATIONS, RATE_LIMITS, parse_limits};
use scp_relay_store::*;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};

/// Runtime hub limits; None removes a cap. Operational durations remain finite.
#[derive(Clone, Debug)]
pub struct Limits(pub BTreeMap<String, Option<u64>>);
const PROTOCOL_KEYS: [&str; 13] = [
    "userPerDay",
    "hopMax",
    "threadMax",
    "pingPongAlternations",
    "pingPongWindowS",
    "pingPongBlockS",
    "pairBurst",
    "pairPerMinute",
    "pairPerHour",
    "treePerMinute",
    "treePerHour",
    "treePauseS",
    "historicAfterS",
];
const HUB_DURATIONS: [&str; 6] = [
    "clientMachineIdleS",
    "idlePurgeS",
    "httpWaitS",
    "mcpWaitS",
    "revalidateMs",
    "deniedS",
];
impl Default for Limits {
    fn default() -> Self {
        let rates = PROTOCOL_KEYS.map(|key| {
            let value = RATE_LIMITS
                .get(key)
                .unwrap_or_else(|| LIMITS.get(key).map(Some).expect("a protocol limit"));
            (key, value)
        });
        Self(
            [
                ("machines", None),
                ("endpoints", None),
                ("sockets", None),
                ("frameBytes", Some(16777216)),
                ("callsPerMinute", None),
                ("bridgeCallsPerMinute", None),
                ("accountCallsPerMinute", None),
                ("acksPerMinute", None),
                ("accountAcksPerMinute", None),
                ("contactPerMinute", None),
                ("contactPerHour", None),
                ("contactPerDay", None),
                ("contactPerDayMax", None),
                ("storedBytes", None),
                ("refusalsPerMinute", None),
                ("clientMachineIdleS", Some(14 * 86400)),
                ("idlePurgeS", Some(30 * 86400)),
                ("httpWaitS", Some(25)),
                ("mcpWaitS", Some(50)),
                ("revalidateMs", Some(300000)),
                ("deniedS", Some(3600)),
            ]
            .into_iter()
            .chain(rates)
            .map(|(k, v)| (k.into(), v))
            .collect(),
        )
    }
}
impl Limits {
    /// Apply key=value; zero, null or Infinity disables caps. Durations remain finite.
    pub fn apply(&mut self, raw: &str) -> std::result::Result<(), String> {
        let (key, value) = raw.split_once('=').ok_or("limit must be key=value")?;
        if !self.0.contains_key(key) {
            return Err(format!("unknown limit: {key}"));
        }
        let duration = Self::is_duration(key);
        let parsed = if Self::is_ping_pong_duration(key) && matches!(value, "0" | "null") {
            Some(600)
        } else if matches!(value, "Infinity" | "null") && !duration {
            None
        } else {
            let n = value
                .parse::<u64>()
                .map_err(|_| "limit must be a nonnegative integer, or Infinity for caps")?;
            if duration && n == 0 {
                return Err("duration must be positive".into());
            }
            (n > 0).then_some(n)
        };
        self.0.insert(key.into(), parsed);
        Ok(())
    }
    fn is_ping_pong_duration(key: &str) -> bool {
        matches!(key, "pingPongWindowS" | "pingPongBlockS")
    }
    fn is_duration(key: &str) -> bool {
        HUB_DURATIONS.contains(&key) || RATE_DURATIONS.contains(&key)
    }
    /// Apply an SCP_LIMITS JSON object, rejecting unknown keys and invalid values.
    pub fn apply_json(&mut self, raw: &str) -> std::result::Result<(), String> {
        let value: Value = serde_json::from_str(raw).map_err(|e| format!("SCP_LIMITS: {e}"))?;
        let keys: Vec<&str> = self.0.keys().map(String::as_str).collect();
        let durations: Vec<&str> = keys
            .iter()
            .copied()
            .filter(|key| Self::is_duration(key))
            .collect();
        let parsed = parse_limits(&value, &keys, &durations).map_err(|e| match e {
            LimitsError::NotObject => "SCP_LIMITS must be a JSON object".to_owned(),
            LimitsError::Unknown(key) => format!("SCP_LIMITS: unknown limit: {key}"),
            LimitsError::Invalid(key) => {
                format!("SCP_LIMITS: {key} must be a nonnegative integer or null")
            }
        })?;
        for key in value.as_object().into_iter().flat_map(|o| o.keys()) {
            if let Some(cap) = parsed.get(key) {
                self.0.insert(key.clone(), *cap);
            } else if Self::is_ping_pong_duration(key) {
                self.0.insert(key.clone(), RATE_LIMITS.get(key).flatten());
            }
        }
        Ok(())
    }
    /// Read a finite configured duration in seconds or milliseconds.
    pub fn duration(&self, key: &str, fallback: u64) -> u64 {
        self.0.get(key).copied().flatten().unwrap_or(fallback)
    }
    /// Read a cap; None disables it.
    pub fn cap(&self, key: &str) -> Option<u64> {
        self.0.get(key).copied().flatten()
    }
    pub(crate) fn frame_bytes(&self) -> usize {
        self.0
            .get("frameBytes")
            .copied()
            .flatten()
            .map(|n| usize::try_from(n).unwrap_or(16777216))
            .unwrap_or(16777216)
    }
}
/// Shared application dependencies. public_url has no trailing slash.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<dyn RelayStore>,
    pub hub: Arc<Hub>,
    pub public_url: String,
    pub limits: Limits,
    pub auth: AuthChain,
    pub cors_origins: Vec<String>,
}
impl AppState {
    /// Replace native authentication with an ordered chain supplied by the embedder.
    /// Serve the router with `into_make_service_with_connect_info::<SocketAddr>()`
    /// so proxy methods receive the actual TCP peer. Methods run again for sockets.
    pub fn with_auth(mut self, chain: AuthChain) -> Self {
        self.auth = chain;
        self
    }
    /// Allow exact browser origins on the public dashboard API.
    pub fn with_cors_origins(mut self, origins: Vec<String>) -> Self {
        self.cors_origins = origins;
        self
    }
    /// Configure machine webhook calls before serving requests.
    pub fn with_wake(mut self, options: crate::hub::WakeOptions) -> Self {
        self.hub = Arc::new(Hub::new(self.store.clone(), self.limits.clone()).with_wake(options));
        self
    }
    /// Build shared state for a listener and its HTTP and WebSocket routes.
    pub fn new(store: Arc<dyn RelayStore>, public_url: String, limits: Limits) -> Self {
        Self {
            hub: Arc::new(Hub::new(store.clone(), limits.clone())),
            auth: AuthChain(vec![Arc::new(NativeAuth::new(store.clone()))]),
            store,
            public_url: public_url.trim_end_matches('/').into(),
            limits,
            cors_origins: Vec::new(),
        }
    }
}
/// Build the relay router. JSON bodies are limited independently of socket frames.
pub fn router(state: AppState) -> Router {
    let frame_bytes = state.limits.frame_bytes();
    let routes = Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"ok":true,"service":"scp-relay"})) }),
        )
        .route("/v1/whoami", get(whoami))
        .route("/v1/device/code", post(device_code))
        .route("/v1/device/token", post(device_token))
        .route("/v1/relay/ws", any(ws))
        .route("/v1/relay/rpc", any(rpc).layer(DefaultBodyLimit::disable()));
    let routes = crate::dashboard::routes(routes, &state)
        .fallback(|| async { (StatusCode::NOT_FOUND, Json(json!({"error":"not_found"}))) })
        .route(
            "/device",
            get(|| async {
                "Run scp-relay device approve <code> --account <handle> --member <name>"
            }),
        );
    routes
        .layer(DefaultBodyLimit::max(frame_bytes))
        .with_state(state)
}
#[derive(Debug)]
pub(crate) struct ApiError(pub(crate) StatusCode, pub(crate) Value);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}
pub(crate) type ApiResult<T> = std::result::Result<T, ApiError>;
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
pub(crate) fn backend(e: StoreError) -> ApiError {
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
pub(crate) async fn authenticate(
    state: &AppState,
    request: &AuthRequest,
) -> ApiResult<crate::Identity> {
    match state.auth.authenticate(request).await {
        AuthOutcome::Identity(i) => Ok(*i),
        AuthOutcome::Reject(reason) => Err(auth_error(&reason)),
        AuthOutcome::Unavailable(reason) => {
            tracing::error!(error=%reason,"authentication backend failed");
            Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error":"server_error"}),
            ))
        }
        AuthOutcome::Pass => Err(auth_error("unauthorized")),
    }
}
/// Validated TLS client certificate supplied by an embedding TLS listener.
#[derive(Clone)]
pub struct TlsClientCertDer(pub Vec<u8>);
/// Captures transport metadata once for authentication and socket revalidation.
pub(crate) struct RequestAuth(pub AuthRequest);
impl<S: Send + Sync> axum::extract::FromRequestParts<S> for RequestAuth {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _: &S,
    ) -> std::result::Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|p| p.0)
            .unwrap_or_else(|| "0.0.0.0:0".parse().unwrap());
        Ok(Self(AuthRequest {
            method: parts.method.clone(),
            path: parts.uri.path().into(),
            headers: parts.headers.clone(),
            peer,
            tls_client_cert_der: parts
                .extensions
                .get::<TlsClientCertDer>()
                .map(|cert| cert.0.clone()),
        }))
    }
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
async fn whoami(
    State(s): State<AppState>,
    RequestAuth(request): RequestAuth,
) -> ApiResult<Json<Value>> {
    let i = authenticate(&s, &request).await?;
    let g = i.grant();
    let c = i.stored().credential;
    Ok(Json(
        json!({"kind":c.kind,"org":i.account.handle,"email":i.member.email,"role":i.member.role,"label":c.name,"ambient":g.scoped,"endpoint_labels":g.labels,"expires_at":c.expires_at.map(crate::iso)}),
    ))
}
pub(crate) async fn device_code(
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
pub(crate) async fn device_token(
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
    RequestAuth(request): RequestAuth,
    method: Method,
    body: axum::body::Body,
) -> ApiResult<Response> {
    let i = authenticate(&s, &request).await?;
    if method != Method::POST {
        return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
    }
    // Escapes can shrink six raw bytes to one character, so the exact check runs in the hub.
    let ceiling = s
        .limits
        .frame_bytes()
        .saturating_mul(6)
        .saturating_add(1024);
    let Ok(bytes) = axum::body::to_bytes(body, ceiling).await else {
        return Ok(Json(s.hub.oversized()).into_response());
    };
    let body =
        match serde_json::from_slice(&bytes) {
            Ok(body) => body,
            Err(_) => return Ok(Json(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}),
            )
            .into_response()),
        };
    Ok(Json(s.hub.rpc(i.grant(), body).await).into_response())
}
async fn ws(
    State(s): State<AppState>,
    RequestAuth(auth_request): RequestAuth,
    headers: HeaderMap,
    mut request: Request,
) -> ApiResult<Response> {
    let i = authenticate(&s, &auth_request).await?;
    if !headers
        .get("upgrade")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
    {
        return Ok(StatusCode::UPGRADE_REQUIRED.into_response());
    }
    let response = tokio_tungstenite::tungstenite::handshake::server::create_response_with_body(
        &request,
        Body::empty,
    )
    .map_err(|_| ApiError(StatusCode::BAD_REQUEST, json!({"error":"invalid_request"})))?;
    if request
        .extensions()
        .get::<hyper::upgrade::OnUpgrade>()
        .is_none()
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            json!({"error":"invalid_request"}),
        ));
    }
    let upgrade = hyper::upgrade::on(&mut request);
    let frame = s.limits.frame_bytes();
    let revalidate_ms = s
        .limits
        .0
        .get("revalidateMs")
        .copied()
        .flatten()
        .unwrap_or(300_000);
    let lease = s.hub.track(&i.grant()).await.ok_or_else(|| {
        ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            json!({"error":"too_many_sockets"}),
        )
    })?;
    let transport_limit = frame.saturating_add(frame.clamp(1, 1 << 20));
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(transport_limit))
        .max_frame_size(Some(transport_limit));
    // Retain raw transport access for draining after WebSocket capacity errors.
    tokio::spawn(async move {
        let _lease = lease;
        if let Ok(upgraded) = upgrade.await {
            let socket = tokio_tungstenite::WebSocketStream::from_raw_socket(
                hyper_util::rt::TokioIo::new(upgraded),
                tokio_tungstenite::tungstenite::protocol::Role::Server,
                Some(config),
            )
            .await;
            s.hub
                .websocket(
                    i.grant(),
                    socket,
                    frame,
                    revalidate_ms,
                    s.auth.clone(),
                    auth_request,
                )
                .await;
        }
    });
    Ok(response)
}

#[cfg(test)]
mod default_tests {
    use super::*;
    #[test]
    fn self_host_caps_are_unlimited_and_frames_remain_bounded() {
        let mut limits = Limits::default();
        for key in [
            "machines",
            "endpoints",
            "sockets",
            "callsPerMinute",
            "bridgeCallsPerMinute",
            "accountCallsPerMinute",
            "acksPerMinute",
            "accountAcksPerMinute",
            "storedBytes",
            "refusalsPerMinute",
        ] {
            assert_eq!(limits.cap(key), None, "{key}");
        }
        for key in [
            "userPerDay",
            "pairBurst",
            "pairPerMinute",
            "pairPerHour",
            "treePerMinute",
            "treePerHour",
            "contactPerMinute",
            "contactPerHour",
            "contactPerDay",
            "contactPerDayMax",
        ] {
            assert_eq!(limits.cap(key), None, "{key}");
        }
        assert_eq!(limits.duration("treePauseS", 0), 600);
        assert_eq!(limits.frame_bytes(), 16777216);
        limits.apply("frameBytes=Infinity").unwrap();
        assert_eq!(limits.frame_bytes(), 16777216);
        limits.apply("machines=4").unwrap();
        assert_eq!(limits.cap("machines"), Some(4));
    }
    #[test]
    fn json_limits_validate_and_merge_atomically() {
        let mut limits = Limits::default();
        limits
            .apply_json(r#"{"pairBurst":7,"userPerDay":9,"treePauseS":90}"#)
            .unwrap();
        assert_eq!(limits.cap("pairBurst"), Some(7));
        limits
            .apply_json(r#"{"pairBurst":null,"userPerDay":0,"treePauseS":null,"httpWaitS":0}"#)
            .unwrap();
        assert_eq!(limits.cap("pairBurst"), None);
        assert_eq!(limits.cap("userPerDay"), None);
        assert_eq!(limits.duration("treePauseS", 0), 90);
        assert_eq!(limits.duration("httpWaitS", 0), 25);
        for raw in [
            "[]",
            "null",
            "1",
            "bad",
            r#"{"unknown":1}"#,
            r#"{"pairBurst":-1}"#,
            r#"{"pairBurst":1.5}"#,
            r#"{"pairBurst":true}"#,
            r#"{"pairBurst":"Infinity"}"#,
            r#"{"pairBurst":18446744073709551616}"#,
            r#"{"treePauseS":false}"#,
        ] {
            assert!(limits.apply_json(raw).is_err(), "{raw}");
        }
        assert!(limits.apply_json(r#"{"pairBurst":3,"unknown":1}"#).is_err());
        assert_eq!(limits.cap("pairBurst"), None);
        limits.apply("userPerDay=3").unwrap();
        limits.apply("userPerDay=0").unwrap();
        assert_eq!(limits.cap("userPerDay"), None);
        assert!(limits.apply("treePauseS=0").is_err());
        assert!(limits.apply("treePauseS=Infinity").is_err());
    }
    #[test]
    fn loop_limits_and_ping_pong_durations() {
        let mut limits = Limits::default();
        let counts = ["hopMax", "threadMax", "pingPongAlternations"];
        let durations = ["pingPongWindowS", "pingPongBlockS"];
        for key in counts {
            assert_eq!(limits.cap(key), None, "{key}");
        }
        for key in durations {
            assert_eq!(limits.duration(key, 0), 600, "{key}");
        }
        limits.apply_json(r#"{"hopMax":64,"threadMax":200,"pingPongAlternations":100,"pingPongWindowS":12,"pingPongBlockS":34}"#).unwrap();
        assert_eq!(limits.cap("hopMax"), Some(64));
        assert_eq!(limits.cap("threadMax"), Some(200));
        assert_eq!(limits.cap("pingPongAlternations"), Some(100));
        assert_eq!(limits.duration("pingPongWindowS", 0), 12);
        assert_eq!(limits.duration("pingPongBlockS", 0), 34);
        for value in ["0", "null"] {
            for key in counts {
                limits.apply_json(&format!(r#"{{"{key}":5}}"#)).unwrap();
                limits
                    .apply_json(&format!(r#"{{"{key}":{value}}}"#))
                    .unwrap();
                assert_eq!(limits.cap(key), None, "{key}");
                limits.apply(&format!("{key}=5")).unwrap();
                limits.apply(&format!("{key}={value}")).unwrap();
                assert_eq!(limits.cap(key), None, "{key}");
            }
            for key in durations {
                limits.apply_json(&format!(r#"{{"{key}":5}}"#)).unwrap();
                limits
                    .apply_json(&format!(r#"{{"{key}":{value}}}"#))
                    .unwrap();
                assert_eq!(limits.duration(key, 0), 600, "{key}");
                limits.apply(&format!("{key}=5")).unwrap();
                limits.apply(&format!("{key}={value}")).unwrap();
                assert_eq!(limits.duration(key, 0), 600, "{key}");
            }
        }
        for key in counts.into_iter().chain(durations) {
            for value in ["-1", "1.5", "true", r#""Infinity""#] {
                assert!(
                    limits
                        .apply_json(&format!(r#"{{"{key}":{value}}}"#))
                        .is_err()
                );
            }
        }
        for key in durations {
            assert!(limits.apply(&format!("{key}=Infinity")).is_err());
        }
    }
}
