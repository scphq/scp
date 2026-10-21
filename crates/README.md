# Self-hosted relay

Build with `cargo build --locked --bin scp-relay` in this directory. The relay serves a stable public dashboard data API, with no embedded UI. See [the OpenAPI contract](../docs/openapi/relay-dashboard.yaml).

Every dashboard request uses an Authorization bearer credential. The always-on routes are `GET /v1/dashboard/session`, `/v1/dashboard/overview`, `/v1/dashboard/graph?minutes=15`, and `/v1/dashboard/events`. Events use WebSocket when upgraded, otherwise SSE so browser clients can fetch with an Authorization header. Both send hello first, then metadata events. SSE sends a comment heartbeat every 25 seconds. Revocation closes WebSockets with 4003 and ends SSE at the configured revalidation interval. All data comes from the resolved account, never a query or path account.

Allow browser origins with repeatable `--cors-origin https://console.example.test` or comma-separated `SCP_RELAY_CORS_ORIGIN`. Matching is exact, the default allows none, and credentials mode is not used.

Authentication uses an ordered chain selected by repeatable `--auth native` and `--auth trusted-header`, or comma-separated `SCP_RELAY_AUTH` (default `native`). The first identity wins. A presented invalid native credential rejects immediately, so it cannot fall through to a proxy identity. Device login endpoints continue minting native credentials.

Trusted headers require at least one repeatable `--trusted-proxy <CIDR>` (IPv4 or IPv6). The relay checks the TCP peer, never forwarded address headers. Configure `--trusted-header-user` (default `X-Forwarded-User`), `--trusted-header-email` (default `X-Forwarded-Email`), and `--trusted-header-map <file>`:

```json
{"default":null,"users":{"alice@example.test":{"account":"team","member":"alice","role":"member"}}}
```

User values are matched first, then email values. Unknown users reject unless `default` contains an account and role, for example `{"account":"team","role":"member"}`. A default creates the member under the user value. Accounts must already exist. Member creation uses the atomic store ensure path and never changes existing roles. Header identities are full logins with stable `hdr:<account-id>:<member-id>` credential bindings.

Embedders can implement the public async `RelayAuth::authenticate(&self, &AuthRequest) -> AuthOutcome` trait, then call `AppState::with_auth(AuthChain(vec![...]))` before `http::router(state)`. `AuthRequest` includes method, path, headers, TCP peer and optional TLS client certificate DER. Serve with `into_make_service_with_connect_info::<SocketAddr>()` to supply the peer; a missing peer cannot authenticate trusted headers. TLS listeners may supply `http::TlsClientCertDer` through request extensions. Open sockets rerun the chain against their original metadata and reject changed identities. JWT/JWKS and mTLS verification are deferred; their extension requirements are sketched on the trait.

Self-host defaults remove account caps and rates. Override each hub key with `--limit key=value` or comma-separated `SCP_RELAY_LIMIT` values. `Infinity` disables a cap. Durations must remain finite and positive.

| Key | Default | Meaning |
| --- | --- | --- |
| machines | Infinity | Machine bindings per account |
| endpoints | Infinity | Endpoints per account |
| sockets | Infinity | Relay sockets per account |
| frameBytes | 16777216 | Maximum frame size, 16 MiB |
| callsPerMinute | Infinity | Client calls per token |
| bridgeCallsPerMinute | Infinity | Bridge calls per token |
| accountCallsPerMinute | Infinity | Calls per account |
| acksPerMinute | Infinity | Acknowledgements per token |
| accountAcksPerMinute | Infinity | Acknowledgements per account |
| storedBytes | Infinity | Retained message bytes per account |
| refusalsPerMinute | Infinity | Stored refusal events per code |
| clientMachineIdleS | 1209600 | Idle client machine retention, 14 days |
| idlePurgeS | 2592000 | Idle account data retention, 30 days |
| httpWaitS | 25 | Maximum HTTP polling wait in seconds |
| revalidateMs | 300000 | Credential revalidation interval in milliseconds |
| deniedS | 3600 | Revocation denial retention in seconds |

When `frameBytes=Infinity`, transport input still has a 16 MiB safety ceiling. HTTP RPC permits JSON escaping overhead up to six times the frame ceiling plus 1024 bytes. Other HTTP request bodies use the frame ceiling. An unlimited endpoint cap permits up to 1000000 entries in a single mirror call, still bounded by the frame ceiling.

Machine wake options use `--wake key=value`:

| Key | Default | Meaning |
| --- | --- | --- |
| senderAccountPerHour | Infinity | Wake calls per sending account per hour |
| targetPerHour | Infinity | Wake calls per target endpoint per hour |
| crossAccount | false | Permit cross-account machine wakes |
| debounceS | 60 | Wake debounce in seconds |
| backoffMaxS | 900 | Maximum retry backoff in seconds |
| wakingTimeoutS | debounceS | Waking presence timeout in seconds |
| declineHoldS | Infinity | Hold after an explicit decline until cleared |
