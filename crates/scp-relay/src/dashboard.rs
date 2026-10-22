//! Stable v1 dashboard data and event streams, authenticated on every request.
use crate::{
    AuthOutcome, AuthRequest, Identity,
    http::{self, ApiError, ApiResult, AppState, RequestAuth, backend},
    iso, now_ms,
};
use axum::{
    Json, Router,
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{CloseFrame, Message},
    },
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::get,
};
use futures_util::{SinkExt, StreamExt, stream};
use serde_json::{Value, json};
use std::{collections::HashMap, convert::Infallible, time::Duration};

async fn identity(s: &AppState, request: &AuthRequest) -> ApiResult<Identity> {
    http::authenticate(s, request).await.map_err(|e| {
        if e.0 == StatusCode::UNAUTHORIZED {
            ApiError(e.0, json!({"error":"unauthorized"}))
        } else {
            e
        }
    })
}
enum Validation {
    Valid,
    Invalid,
    Unavailable,
}
async fn valid(s: &AppState, request: &AuthRequest, original: &Identity) -> Validation {
    match s.auth.authenticate(request).await {
        AuthOutcome::Identity(i) => {
            let a = i.grant();
            let b = original.grant();
            if a.token_id == b.token_id
                && a.user_id == b.user_id
                && a.actor_id == b.actor_id
                && a.role == b.role
                && a.scoped == b.scoped
                && a.labels == b.labels
                && a.expires_at > now_ms()
            {
                Validation::Valid
            } else {
                Validation::Invalid
            }
        }
        AuthOutcome::Unavailable(_) => Validation::Unavailable,
        _ => Validation::Invalid,
    }
}
async fn session(
    State(s): State<AppState>,
    RequestAuth(request): RequestAuth,
) -> ApiResult<Json<Value>> {
    let i = identity(&s, &request).await?;
    let members = s.store.members(&i.account.id).await.map_err(backend)?;
    let (devices, tokens) = s
        .store
        .credential_counts(&i.account.id, now_ms())
        .await
        .map_err(backend)?;
    Ok(Json(
        json!({"org":{"handle":i.account.handle,"name":i.account.handle},"member":{"id":i.member.id,"name":i.member.name,"role":i.member.role},"members":members.into_iter().map(|m|json!({"id":m.id,"name":m.name})).collect::<Vec<_>>(),"devices":devices,"tokens":tokens,"scoped":i.scoped}),
    ))
}
fn include_historic(query: &HashMap<String, String>) -> bool {
    query
        .get("historic")
        .is_some_and(|v| matches!(v.as_str(), "1" | "true"))
}
async fn overview(
    State(s): State<AppState>,
    RequestAuth(request): RequestAuth,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let i = identity(&s, &request).await?;
    Ok(Json(
        s.hub
            .overview_historic(&i.account, 20, include_historic(&query))
            .await
            .map_err(|_| {
                ApiError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({"error":"server_error"}),
                )
            })?,
    ))
}
async fn graph(
    State(s): State<AppState>,
    RequestAuth(request): RequestAuth,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let i = identity(&s, &request).await?;
    let minutes = query
        .get("minutes")
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .map(|v| v.floor().clamp(1.0, 60.0) as i64)
        .unwrap_or(15);
    Ok(Json(
        s.hub
            .graph_historic(&i.account, minutes, include_historic(&query))
            .await
            .map_err(|_| {
                ApiError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({"error":"server_error"}),
                )
            })?,
    ))
}
async fn events(
    State(s): State<AppState>,
    RequestAuth(request): RequestAuth,
    upgrade: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> ApiResult<Response> {
    let i = identity(&s, &request).await?;
    let mut receiver = s.hub.dashboard_events(&i.account).await;
    let mut shutdown = s.hub.dashboard_shutdown();
    let period = Duration::from_millis(s.limits.duration("revalidateMs", 300000).max(1));
    let mut revalidate = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    let hello = json!({"type":"hello","at":iso(now_ms())});
    if request
        .headers
        .get(header::UPGRADE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h.eq_ignore_ascii_case("websocket"))
    {
        let upgrade = upgrade
            .map_err(|_| ApiError(StatusCode::BAD_REQUEST, json!({"error":"invalid_request"})))?;
        return Ok(upgrade.max_message_size(4096).max_frame_size(4096).on_upgrade(move |socket| async move {
            let (mut sink, mut stream) = socket.split();
            let mut outgoing = Some(Message::Text(hello.to_string().into()));
            loop {
                if let Some(message) = outgoing.take() && !matches!(tokio::time::timeout(Duration::from_secs(2), sink.send(message)).await, Ok(Ok(()))) { break; }
                tokio::select! {
                    _ = shutdown.changed() => break,
                    _ = revalidate.tick() => if matches!(valid(&s, &request, &i).await, Validation::Invalid) {
                        let _ = tokio::time::timeout(Duration::from_secs(2), sink.send(Message::Close(Some(CloseFrame { code:4003, reason:"unauthorized".into() })))).await;
                        break;
                    },
                    value = receiver.recv() => match value {
                        Ok(value) => outgoing = Some(Message::Text(value.to_string().into())),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {},
                        Err(_) => break,
                    },
                    value = stream.next() => match value {
                        Some(Ok(Message::Text(text))) if text == "ping" => outgoing = Some(Message::Text("pong".into())),
                        None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                        _ => {},
                    }
                }
            }
        }));
    }
    let events = stream::unfold(
        (s, request, i, receiver, shutdown, revalidate, Some(hello)),
        |(s, request, i, mut receiver, mut shutdown, mut revalidate, mut hello)| async move {
            let value = if let Some(hello) = hello.take() {
                hello
            } else {
                loop {
                    tokio::select! {
                        _ = shutdown.changed() => return None,
                        _ = revalidate.tick() => if matches!(valid(&s, &request, &i).await, Validation::Invalid) { return None; },
                        value = receiver.recv() => match value {
                            Ok(value) => break value,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {},
                            Err(_) => return None,
                        }
                    }
                }
            };
            Some((
                Ok::<_, Infallible>(Event::default().data(value.to_string())),
                (s, request, i, receiver, shutdown, revalidate, hello),
            ))
        },
    );
    Ok(Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(25))
                .text("heartbeat"),
        )
        .into_response())
}
async fn headers(
    State(s): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .filter(|v| {
            v.to_str().is_ok_and(|v| {
                s.cors_origins
                    .iter()
                    .any(|allowed| allowed != "*" && allowed != "null" && allowed == v)
            })
        })
        .cloned();
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    // All dashboard responses vary by origin, including denied origins.
    headers.insert(header::VARY, "origin".parse().unwrap());
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "authorization, content-type".parse().unwrap(),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET, OPTIONS".parse().unwrap(),
        );
        headers.insert(header::ACCESS_CONTROL_MAX_AGE, "600".parse().unwrap());
    }
    response
}
pub(crate) fn routes(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    router.merge(
        Router::new()
            .route(
                "/v1/dashboard/session",
                get(session).options(|| async { StatusCode::NO_CONTENT }),
            )
            .route(
                "/v1/dashboard/overview",
                get(overview).options(|| async { StatusCode::NO_CONTENT }),
            )
            .route(
                "/v1/dashboard/graph",
                get(graph).options(|| async { StatusCode::NO_CONTENT }),
            )
            .route(
                "/v1/dashboard/events",
                get(events).options(|| async { StatusCode::NO_CONTENT }),
            )
            .layer(middleware::from_fn_with_state(state.clone(), headers)),
    )
}
#[cfg(test)]
mod tests {
    #[test]
    fn openapi_covers_router() {
        let yaml = include_str!("../../../docs/openapi/relay-dashboard.yaml");
        let paths: Vec<_> = include_str!("dashboard.rs")
            .split(".route(")
            .skip(1)
            .filter_map(|part| part.split('"').nth(1))
            .filter(|path| path.starts_with(concat!("/v1/", "dashboard/")))
            .collect();
        assert_eq!(paths.len(), 4);
        assert_eq!(yaml.matches("name: historic").count(), 2);
        assert_eq!(yaml.matches("        historic:").count(), 2);
        assert!(yaml.contains("        active_at:"));
        for path in paths {
            assert!(yaml.contains(&format!("  {path}:")), "missing {path}");
        }
    }
}
