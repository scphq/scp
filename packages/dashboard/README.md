# @scp-dev/dashboard

Optional dashboard server for the SCP relay. Requires Node 18 or later and has no runtime dependencies.
The browser UI uses the hosted relay's renderers. Build from the repository root with `bun install`
and `bun run --filter @scp-dev/dashboard build`.

```sh
npx @scp-dev/dashboard --relay https://relay.example.com
```

Open `http://127.0.0.1:8788` and sign in with a relay token or device code. Approve device codes with
`scp-relay device approve <code> --account <handle> --member <name>` on the relay host.
Members and tokens are managed with the relay admin CLI.

| Option | Environment | Default |
| --- | --- | --- |
| `--relay <url>` | `SCP_DASHBOARD_RELAY` | Required relay origin |
| `--listen <host:port>` | `SCP_DASHBOARD_LISTEN` | `127.0.0.1:8788` |
| `--public-url <url>` | `SCP_DASHBOARD_PUBLIC_URL` | Request origin |
| `--forward-header <name>` (repeatable) | `SCP_DASHBOARD_FORWARD_HEADERS` (comma separated) | None |

`--help` shows usage, `--version` prints the relay release version, and `--health` checks the local
listener's `/health` route without contacting the relay.

Credentials stay server side in memory. The browser receives an opaque HttpOnly, SameSite=Strict cookie
and a session-bound CSRF token. Every authenticated request checks the relay session; a relay 401 signs
the browser out. Event WebSockets use the session's bearer and revalidate every 30 seconds. A dashboard
restart signs everyone out. POST requests require JSON, a matching Origin and a valid CSRF token.

Use an HTTPS reverse proxy and set `--public-url https://dashboard.example.com` for Secure host cookies
and external Origin checks. The proxy must support WebSocket upgrades.

## Container

```sh
docker run --rm -p 8788:8788 \
  -e SCP_DASHBOARD_RELAY=https://relay.example.com \
  -e SCP_DASHBOARD_PUBLIC_URL=https://dashboard.example.com \
  ghcr.io/scphq/scp-dashboard:latest
```

The image runs as uid 65532, listens on `0.0.0.0:8788`, and health checks the dashboard independently
of relay availability. See the [self-hosting guide](https://scp.dev/docs/self-host) for Compose with
Postgres, relay and dashboard. Build locally from the repository root with
`docker build -f packages/dashboard/Dockerfile -t scp-dashboard:local .`.

## SSO

Put the dashboard itself behind an authenticating SSO proxy. Set `--forward-header` for each identity
header expected by the relay. The proxy must overwrite these headers and block direct dashboard access.
Run the relay with `--auth trusted-header` and include the dashboard host's IP in `--trusted-proxy`.
Only explicitly named identity headers are forwarded on every request, including event upgrades.
The relay accepts or rejects that identity; no bearer is stored or sent by the browser in this mode.
Signing out clears the cookie, but the SSO proxy may authenticate the next request again.

To build a separate UI, see [docs/openapi/relay-dashboard.yaml](https://github.com/scphq/scp/blob/main/docs/openapi/relay-dashboard.yaml).
The relay's `--cors-origin` lets a UI on another origin call that API directly with a bearer.
