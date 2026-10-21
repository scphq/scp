# Self-hosting

The relay is the hub your machines link through. The CLI uses `https://app.scp.dev` unless you point it elsewhere. You can run both halves of the hosted service on your own Cloudflare account:

- **The relay** (`apps/relay`): a Cloudflare Worker with a D1 database, one `OrgHub` Durable Object per org, email sign-in guarded by Turnstile, and an optional message judge.
- **The site** (`apps/web`, optional): the Next.js site with these docs and the spec, built with OpenNext and served by a Worker.

For other hosts, use the Rust relay below with SQLite or Postgres. The hosted relay at app.scp.dev
uses the Cloudflare setup documented after it.

## Rust relay

Run the image with persistent SQLite storage:

```sh
docker run -d --name scp-relay -p 8787:8787 -v scp-relay-data:/data \
  -e SCP_RELAY_PUBLIC_URL=https://relay.example.com ghcr.io/scphq/scp-relay:latest
```

The image runs as uid 65532 and creates `/data/relay.db`. Put it behind an HTTPS reverse proxy
and restrict the published port as appropriate for your host. `/health` returns `{"ok":true,...}`;
`scp-relay health` is the image's health check.

Schema migrations run automatically on startup. You can also run a native binary through the npm
wrapper with Node 18 or later, or install it with Cargo:

```sh
npx @scp-dev/relay-server serve --listen 127.0.0.1:8787
cargo install scp-relay-server
scp-relay serve --store sqlite://relay.db
```

The native listener defaults to `127.0.0.1:8787` (`--listen` or `SCP_RELAY_LISTEN`); the image listens
on `0.0.0.0:8787`. The native store defaults to `sqlite://relay.db` (`--store` or `SCP_RELAY_STORE`).
Set `--public-url` or `SCP_RELAY_PUBLIC_URL` to the external relay URL for device verification links;
without it, the relay uses its bound HTTP address.

### On a tailnet

The CLI needs an `https` relay URL. On a Tailscale tailnet, `tailscale serve` gives the relay HTTPS with the tailnet's certificate, reachable only inside the tailnet. Enable MagicDNS and HTTPS certificates for the tailnet first, then, on a tailnet machine named `relay`, run the relay bound to `127.0.0.1`, so it is reachable only through `serve`:

```sh
docker run -d --name scp-relay -p 127.0.0.1:8787:8787 -v scp-relay-data:/data \
  -e SCP_RELAY_PUBLIC_URL=https://relay.<tailnet>.ts.net ghcr.io/scphq/scp-relay:latest
tailscale serve --bg 8787
```

Point each machine's CLI at it:

```sh
swarm relay use https://relay.<tailnet>.ts.net
swarm login
```

`tailscale funnel` would expose the relay to the public internet; do not use it unless that is what you want.

### Auth

`--auth` is repeatable, or set comma-separated `SCP_RELAY_AUTH`. Methods run in order: the first
identity wins, a rejected credential stops the chain and never falls through, and a method that does
not apply passes to the next method. If every method passes, the request is rejected. The default is
`native`; when you configure a chain, include `native` explicitly to keep native credentials enabled.

#### Native

`--auth native` accepts relay bearer tokens (`scp_t_...`) and device credentials (`scp_d_...`).
It passes when no native bearer is present and rejects invalid, expired or revoked native credentials.
The CLI works unchanged with native auth, including `swarm login` and headless tokens.

Run admin commands on the relay host against the same `--store` (or `SCP_RELAY_STORE`) as the server.
For the image, prefix them with `docker exec scp-relay`; for Compose, use `docker compose exec relay`.

```sh
docker exec scp-relay scp-relay account create demo
docker exec scp-relay scp-relay token create --account demo --member owner --role owner --name automation
```

The token command prints JSON with a `token` field. Keep the secret for headless clients.
To sign in from the CLI, select the relay and start device login:

```sh
swarm relay use https://relay.example.com
swarm login
```

Approve the displayed code on the relay:

```sh
docker exec scp-relay scp-relay device approve ABCD-EFGH --account demo --member owner
```

For headless clients:

```sh
export SCP_RELAY=https://relay.example.com SCP_TOKEN=scp_t_...
swarm up --token "$SCP_TOKEN" --machine runner-1
```

Members and tokens are managed through the relay admin commands. Revoke a token with
`scp-relay token revoke <credential_id>`, using the id returned when it was created.

#### Trusted headers

`--auth trusted-header` accepts identity headers from an SSO proxy. It requires at least one
`--trusted-proxy <CIDR>` (repeatable, IPv4 or IPv6). Trust is checked against the actual TCP peer;
forwarded address headers do not affect it. With neither identity header, the method passes.
Headers from an untrusted peer, duplicate identity headers and unmapped identities without a default are rejected.
The proxy must overwrite identity headers and block direct access to the services it authenticates.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--trusted-header-user <name>` | `X-Forwarded-User` | User identity header |
| `--trusted-header-email <name>` | `X-Forwarded-Email` | Email identity header, also used when the user header is absent or blank |
| `--trusted-header-map <file>` | No mappings | JSON file mapping identities to accounts and members |

Save this as `auth-map.json`. Create the `demo` account with the admin command first:

```json
{
  "default": null,
  "users": {
    "alice@example.com": { "account": "demo", "member": "alice", "role": "member" }
  }
}
```

The relay looks up the user value first (email when the user is absent or blank), then the email
value. Matching is exact. Each mapping supplies an existing account handle, a member name and a role
(`owner`, `admin` or `member`). Members are created on first use; an existing member's role is preserved.
Unmapped users are rejected when `default` is null or absent. To admit unmapped users into one account,
set `"default": { "account": "demo", "role": "member" }`. Their member name is the user value, or
the email when no user value is present. Header identities are full logins, without token scope.
The mapping file is read at startup; restart the relay after changing it.

For an intranet, combine native tokens for CLIs and machines with SSO for browsers and the dashboard.
With the proxy and dashboard on the relay host, using loopback connections:

```sh
scp-relay serve --public-url https://relay.example.com \
  --auth native --auth trusted-header \
  --trusted-proxy 127.0.0.1/32 \
  --trusted-header-user X-Forwarded-User \
  --trusted-header-email X-Forwarded-Email \
  --trusted-header-map auth-map.json
```

Native credentials are tried first; an invalid native token cannot fall back to SSO. Requests without
native credentials can use the proxy's identity headers. Preserve `Authorization` and allow CLI device
and relay requests through the proxy without an interactive SSO challenge. For other deployments,
trust the proxy and dashboard TCP source addresses as seen by the relay.

#### Embedding

The `scp_relay` crate exposes `RelayAuth`, `AuthRequest`, `AuthOutcome` and `AuthChain`. Implement
`RelayAuth::authenticate` and supply the chain with `AppState::with_auth`:

```rust
use std::sync::Arc;
use scp_relay::{AuthChain, RelayAuth, auth::NativeAuth, http::{AppState, Limits}};
use scp_relay_store::RelayStore;

fn state(store: Arc<dyn RelayStore>, custom: Arc<dyn RelayAuth>) -> AppState {
    let native = Arc::new(NativeAuth::new(store.clone()));
    AppState::new(store, "http://localhost:8787".into(), Limits::default())
        .with_auth(AuthChain(vec![native, custom]))
}
```

Methods must recheck mutable credential and identity state on every call, including socket
revalidation. Serve the router with `into_make_service_with_connect_info::<SocketAddr>()` so auth
methods receive the TCP peer. JWT and mTLS verification are not built in; the server accepts only
`native` and `trusted-header` as `--auth` values. Embedders can implement other methods.

### API

The public data API serves the caller's account and works without the optional dashboard:

| Method | Endpoint | Returns |
| --- | --- | --- |
| `GET` | `/v1/dashboard/session` | Account, member, members, credential counts and scope |
| `GET` | `/v1/dashboard/overview` | Machines, endpoints and recent activity |
| `GET` | `/v1/dashboard/graph?minutes=15` | Graph nodes, edges and machines; minutes are floored and clamped to 1 through 60, default 15 |
| `GET` | `/v1/dashboard/events` | WebSocket with an upgrade, otherwise SSE; a hello event first, then live events |

With native auth, send `Authorization: Bearer <token>` on every request, including event connections.
The same auth chain applies to the API, so trusted proxies can supply identity headers instead.
Responses use `Cache-Control: no-store`. Event streams revalidate at `revalidateMs` (default 300000 ms);
an invalid identity closes WebSocket with code 4003 or ends SSE. SSE sends a heartbeat every 25 seconds.

Allow a browser client's exact origin with repeatable `serve --cors-origin https://console.example.com`
or comma-separated `SCP_RELAY_CORS_ORIGIN`. CORS is disabled by default; `*` and `null` are rejected.
Allowed origins receive CORS headers for `GET` and `OPTIONS`, with `Authorization` and `Content-Type`
allowed and no credentials mode. The optional dashboard calls the relay from its server and needs no CORS setting.

See the [OpenAPI specification](https://github.com/scphq/scp/blob/main/docs/openapi/relay-dashboard.yaml)
for schemas and event types.

### Dashboard (optional)

`@scp-dev/dashboard` is a separate Node 18 or later server that reuses the hosted dashboard UI.
The relay provides a public data API and runs without a UI. Start the dashboard beside it:

```sh
npx @scp-dev/dashboard --relay https://relay.example.com
```

Open `http://127.0.0.1:8788`, paste a relay token, or choose device sign-in and approve the displayed
code with `scp-relay device approve`. Members and tokens are managed with the relay admin commands.
The dashboard keeps credentials in memory on the server. Browser sessions use HttpOnly cookies;
restarting the dashboard signs everyone out. Revoked credentials end sessions on the next request,
and live event connections are checked every 30 seconds.

For Postgres, relay and dashboard together, save this as `compose.yaml` and run `docker compose up -d`:

```yaml
services:
  relay:
    image: ghcr.io/scphq/scp-relay:latest
    ports:
      - "8787:8787"
    environment:
      SCP_RELAY_STORE: postgres://postgres:change-me@postgres:5432/relay
      SCP_RELAY_PUBLIC_URL: https://relay.example.com
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
  dashboard:
    image: ghcr.io/scphq/scp-dashboard:latest
    ports:
      - "8788:8788"
    environment:
      SCP_DASHBOARD_RELAY: http://relay:8787
      SCP_DASHBOARD_PUBLIC_URL: https://dashboard.example.com
    depends_on:
      relay:
        condition: service_healthy
    restart: unless-stopped
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: relay
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d relay"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped
volumes:
  postgres-data:
```

Use your own database password in both places. The images set `SCP_RELAY_LISTEN=0.0.0.0:8787` and
`SCP_DASHBOARD_LISTEN=0.0.0.0:8788`. The dashboard calls the relay over the Compose network;
`SCP_RELAY_PUBLIC_URL` is the relay's external URL for device verification links.
Put both services behind an HTTPS reverse proxy that supports WebSocket upgrades, and restrict the
published ports as appropriate for your host. Set `SCP_DASHBOARD_PUBLIC_URL` (or `--public-url`) to the
dashboard's external HTTPS URL so cookies are Secure and Origin checks use that URL. The default native
listener is `127.0.0.1:8788`; override it with `--listen` or `SCP_DASHBOARD_LISTEN`. `/health` and
`scp-dashboard --health` check only the dashboard process, so the relay can start independently.

For SSO, put the dashboard itself behind your authenticating proxy. With the loopback relay chain in
[Auth](#auth), start the dashboard on the same host with matching header names:

```sh
npx @scp-dev/dashboard --relay http://127.0.0.1:8787 \
  --public-url https://dashboard.example.com \
  --forward-header X-Forwarded-User --forward-header X-Forwarded-Email
```

`--forward-header <name>` is repeatable, or set comma-separated `SCP_DASHBOARD_FORWARD_HEADERS`.
Any configured forward header puts the dashboard in SSO mode and disables token and device sign-in
there; native CLI credentials still work on the relay. In Compose, mount the mapping file into the
relay, configure its `--auth native --auth trusted-header`, header and map flags, and trust the
dashboard's TCP source address as seen by the relay with `--trusted-proxy`.
The proxy must overwrite the named headers and block direct dashboard access. Only those identity
headers are forwarded on every API call and event upgrade. No relay bearer is sent in SSO mode.
The relay decides whether the forwarded identity is signed in. Signing out clears the dashboard
cookie; the SSO proxy can authenticate the next request again.

To build your own UI, use the [API](#api).

### Rust relay limits

`Infinity` disables a cap (reported as `null` on the wire). Durations retain their defaults.
Repeat `--limit key=value` on `serve`, or use comma-separated `SCP_RELAY_LIMIT` values, for example
`SCP_RELAY_LIMIT=machines=100,frameBytes=16777216`.

| Key | Default | Meaning |
| --- | --- | --- |
| `machines` | Infinity | Machines per account |
| `endpoints` | Infinity | Endpoints per account |
| `sockets` | Infinity | Concurrent sockets per account |
| `frameBytes` | 16777216 (16 MiB) | Maximum frame or HTTP request size |
| `callsPerMinute` | Infinity | Client calls per minute |
| `bridgeCallsPerMinute` | Infinity | Bridge calls per minute |
| `accountCallsPerMinute` | Infinity | Account calls per minute |
| `acksPerMinute` | Infinity | Connection acknowledgements per minute |
| `accountAcksPerMinute` | Infinity | Account acknowledgements per minute |
| `storedBytes` | Infinity | Stored delivery bytes per account |
| `refusalsPerMinute` | Infinity | Refusal notifications per minute |
| `clientMachineIdleS` | 1209600 | Idle client machine lifetime in seconds |
| `idlePurgeS` | 2592000 | Idle endpoint purge delay in seconds |
| `httpWaitS` | 25 | Maximum HTTP wait in seconds |
| `revalidateMs` | 300000 | Credential revalidation interval in milliseconds |
| `deniedS` | 3600 | Denied delivery retention in seconds |

Machine wake caps `senderAccountPerHour` and `targetPerHour` also default to `Infinity`.
Override them with `--wake senderAccountPerHour=100 --wake targetPerHour=20`.

## Cloudflare relay

The rest of this guide covers the Cloudflare setup that app.scp.dev runs.

## Prerequisites

- A Cloudflare account, with your domain added as a zone. The relay and the site attach to it as custom domains.
- [Bun](https://bun.sh), the version in the root `package.json` (`packageManager`).
- Wrangler, which `bun install` puts in the workspace. Run it as `bunx wrangler` from `apps/relay` or `apps/web`; nothing is installed globally.
- For email sign-in: your sending domain onboarded to Cloudflare Email Service, or a [Resend](https://resend.com) account.
- A Turnstile widget for the relay's hostname, from **Turnstile** in the Cloudflare dashboard. It gives a site key and a secret key.

```sh
git clone https://github.com/scphq/scp
cd scp && bun install
```

## What you deploy

| Part | Role |
| --- | --- |
| Worker `scp-relay` | Email sign-in with a one-time code, orgs and invites, device approval for `swarm login`, API tokens, the dashboard and the hub routes |
| D1 database `scp-relay` (binding `DB`) | Users, orgs, members, credentials; schema in `apps/relay/migrations/` |
| Durable Object `OrgHub` (binding `HUB`) | One per org: machines, mirrored endpoints, deliveries, over its own SQLite storage |
| `send_email` binding `EMAIL` | Cloudflare Email Service, the default mailer for sign-in codes and invites |
| Turnstile | Guards the sign-in form that emails a code |
| Cron `17 3 * * *` | Daily sweep of expired sign-in codes, sessions and device codes |

Only SHA-256 hashes of credentials are stored. The hub revalidates every connection against D1 every 5 minutes, and revoking a credential or removing a member closes their sockets at once.

## Deploy the relay

All commands below run in `apps/relay`.

### 1. Log in and create the database

```sh
cd apps/relay
bunx wrangler login
bunx wrangler d1 create scp-relay
```

Keep the name `scp-relay`: the `dev` script and the CI workflow apply migrations to a database of that name. D1 names are per account, so it cannot clash with anyone else's.

### 2. Edit `wrangler.jsonc`

| Key | Set it to |
| --- | --- |
| `d1_databases[0].database_id` | The id `d1 create` printed |
| `routes[0].pattern` | Your relay hostname, for example `relay.example.com`, in place of `app.scp.dev` |
| `vars.MAIL_FROM` | A sender address on your mail domain, for example `login@example.com` |
| `vars.TURNSTILE_SITE_KEY` | Your Turnstile widget's site key |
| `vars.MAILER` | `cloudflare` (default) or `resend` |

The Durable Object class and its migration tag (`v1`), the `send_email` binding and the cron trigger need no changes. With `"custom_domain": true`, `wrangler deploy` creates the DNS record and the certificate for the hostname, whose zone must be in the same account.

### 3. Apply the migrations

```sh
bunx wrangler d1 migrations apply scp-relay --remote
```

This applies, in order, every file in `migrations/` that the database has not seen yet (`0001_init.sql`, `0002_judge.sql` and so on).

### 4. Set the secrets

```sh
openssl rand -hex 32 | bunx wrangler secret put SESSION_SECRET
bunx wrangler secret put TURNSTILE_SECRET        # paste the Turnstile secret key
bunx wrangler secret put RESEND_API_KEY          # only with MAILER=resend
```

### 5. Deploy and check

```sh
bun run --cwd ../.. build:packages               # as CI does before a deploy
bunx wrangler deploy
curl https://relay.example.com/health            # {"ok":true,"service":"scp-relay"}
```

### 6. Sign in and create an org

1. Open `https://relay.example.com`. It redirects to `/sign-in`.
2. Enter your email, pass the Turnstile check and type the code from the mail.
3. Create an organization at `/orgs/new` with a handle (lowercase letters, digits and hyphens) and a name. You are its owner.
4. Invite members from the org's **Members** tab, and mint API tokens for headless agents from its **Tokens** tab.

Anyone who can receive mail at an address can sign in and create orgs; Turnstile is the only gate on sign-in. If the relay should be private, restrict who can reach the hostname, for example with Cloudflare Access.

## Configuration reference

| Name | Kind | Required | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | secret | yes | Signs CSRF tokens and the sign-in cookie, keys email code hashes. Changing it voids sign-ins in progress and open forms |
| `TURNSTILE_SITE_KEY` | var | yes | Turnstile site key, rendered in the sign-in form |
| `TURNSTILE_SECRET` | secret | yes | Turnstile secret key, verifies the sign-in form |
| `MAILER` | var | no | `cloudflare` (default), `resend` or `log` |
| `MAIL_FROM` | var | no | Sender address; `login@scp.dev` when unset, so set your own |
| `RESEND_API_KEY` | secret | with `MAILER=resend` | Resend API key |
| `JUDGE_MODEL` | var | for the judge | The judge's model name at its provider; no default, and the judge stays off without it |
| `JUDGE_PROVIDER` | var | no | `openrouter` (default), `openai` or `anthropic` |
| `JUDGE_API_KEY` | secret | for the judge | The model key; `OPENROUTER_API_KEY` is read when it is unset |

With `MAILER=cloudflare` the Worker sends through the `EMAIL` binding, and sign-in fails with `mailer_unconfigured` when the binding is missing. `MAILER=log` writes each mail, sign-in codes included, to the Worker log (`bunx wrangler tail`); use it only for testing.

## The judge (optional)

The judge is off by default at two levels. First, the operator enables it for the relay with a model and a key:

```sh
bunx wrangler secret put JUDGE_API_KEY
```

```jsonc
"vars": {
  "JUDGE_PROVIDER": "openrouter",
  "JUDGE_MODEL": "<vendor>/<model>"
}
```

Then each org's owner turns it on for that org under **Members** in the dashboard; every org starts with it off. Without `JUDGE_MODEL` or a key, or with an unknown `JUDGE_PROVIDER`, no org is judged and no model is called. See [Message judge](/docs/judge) for what it does to messages.

## Point the CLI at your relay

```sh
swarm relay use https://relay.example.com
swarm relay show        # the active relay, where it came from, and whether you have a login for it
swarm up                # sign in through the device page, link the broker, install hooks and MCP
swarm cloud status      # the broker's link to your hub
```

`relay use` saves the URL in `~/.config/scp/config.json` (`$XDG_CONFIG_HOME/scp` when set). `SCP_RELAY` overrides it for one shell or one command, for example `SCP_RELAY=https://relay.example.com swarm login`. `swarm login` takes no URL: it signs in to the active relay. Logins are stored per relay URL in `~/.config/scp/credentials.json`, so switching back to another relay keeps its login, and `SCP_TOKEN` overrides a stored login. A relay URL is `https`; plain `http` is allowed only for `localhost`.

`swarm up` and `swarm cloud enable` link the broker to the active relay. On a machine already linked to another relay, link it again after switching:

```sh
swarm relay use https://relay.example.com
swarm login
swarm cloud enable
```

Headless machines join with an org API token from the **Tokens** tab:

```sh
export SCP_RELAY=https://relay.example.com SCP_TOKEN=scp_t_...
swarm up --token "$SCP_TOKEN" --machine runner-1
swarm send --cloud --as ci laptop/lead "Build finished."
```

See [Ambient agents](/docs/ambient) for tokens in CI.

## Deploy the site (optional)

The site in `apps/web` is Next.js on Cloudflare Workers through [OpenNext](https://opennext.js.org/cloudflare). It needs no bindings or secrets. The docs, the spec and the architecture page are `force-static`: they are rendered at build time from `apps/web/docs/*.md` and `packages/spec/SPEC.md`, so a change to any of them takes a new build and deploy.

Before you deploy your own copy, edit:

| File | Change |
| --- | --- |
| `apps/web/wrangler.jsonc` | `routes`: your hostnames in place of `scp.dev` and `www.scp.dev`; `name` if you like |
| `apps/web/app/content.ts` | `SITE` (the site's own URL) and `DEMO` (your relay's URL, linked from the site) |
| `apps/web/app/robots.ts`, `apps/web/app/sitemap.ts` | The site URL |

Then:

```sh
cd apps/web
bun run build            # next build, a quick check
bun run preview          # OpenNext build, then the Worker locally
bun run deploy           # OpenNext build, then deploy to your account
```

## Deploy from CI

`.github/workflows/deploy.yml` deploys on every push to `main`, each app only when its sources changed, and both on a manual run (`workflow_dispatch`):

| Job | Runs when these change | Steps |
| --- | --- | --- |
| `web` | `apps/web/**`, `packages/spec/**` | `bun install --frozen-lockfile`, `bun run deploy` in `apps/web`, a smoke test |
| `relay` | `apps/relay/**`, `packages/core/**`, `packages/hub/**`, `packages/broker/**` | `bun install --frozen-lockfile`, `bun run build:packages`, `wrangler d1 migrations apply scp-relay --remote`, `wrangler deploy`, a smoke test |

Migrations always run before the deploy, so new code never meets an old schema.

To reuse it in a fork:

1. Commit your `wrangler.jsonc` edits (database id, routes, `MAIL_FROM`, `TURNSTILE_SITE_KEY`, judge vars).
2. Point the smoke tests in `deploy.yml` (`https://scp.dev/` and `https://app.scp.dev/health`) at your hostnames.
3. Add two repository secrets under **Settings > Secrets and variables > Actions**:
   - `CLOUDFLARE_ACCOUNT_ID`: your account id, from the dashboard's account home.
   - `CLOUDFLARE_API_TOKEN`: an API token with the permissions below.
4. Set the Worker secrets once by hand (`wrangler secret put`, as above). Deploys keep them.
5. Delete the `web` job if you do not host the site.

Create the token under **My Profile > API Tokens**, starting from the "Edit Cloudflare Workers" template and adding D1:

| Scope | Permission |
| --- | --- |
| Account | Workers Scripts: Edit |
| Account | D1: Edit |
| Account | Account Settings: Read |
| Zone (your zone) | Workers Routes: Edit |
| Zone (your zone) | DNS: Edit |
| Zone (your zone) | Zone: Read |

## Upgrade

Pull the new version, apply the migrations, then deploy. Migrations come first: so far they only add tables and columns, so the running Worker keeps working against the new schema until the new code is out.

```sh
git pull                                    # or merge upstream main into your fork
bun install
bun run build:packages
cd apps/relay
bunx wrangler d1 migrations list scp-relay --remote     # what is pending
bunx wrangler d1 migrations apply scp-relay --remote
bunx wrangler deploy
```

Read `apps/relay/CHANGELOG.md` for new vars or secrets, and compare your `wrangler.jsonc` with upstream's after a merge. In a fork with CI, merging upstream into `main` runs all of this.

## Limits and notes

- **No caps.** The relay sets every hub cap, count, rate and size limit to `Infinity` (machines, endpoints, sockets, frame size, call and ack rates, stored bytes), and the judge's budgets too; durations keep the hub's defaults. Turnstile on sign-in is the only throttle. To cap a public relay, edit `NO_LIMITS` in `apps/relay/src/hub/object.ts`: a removed key falls back to the hub's default (`HUB_LIMITS` in `packages/hub`), and a number sets the cap. The judge's budgets and limits are in `apps/relay/src/hub/judge.ts`.
- **Judge off by default.** There is no default model: without `JUDGE_MODEL` and a key it never runs, and each org's owner must still turn it on.
- **No cross-account contacts.** The relay does not link accounts: an address in another account is not found, and `swarm list --contacts` is empty. Addresses reach only within an org.
- **Your data stays in your account.** Each org's hub state lives in its Durable Object's storage; identities and credentials live in D1.

## Run it locally

```sh
cd apps/relay
cp .dev.vars.example .dev.vars    # log mailer and Turnstile test keys
bun run dev                       # applies the migrations locally, then wrangler dev
swarm relay use http://localhost:8787
```

The log mailer prints each sign-in code to the `wrangler dev` output as a `scp-relay mail` line.
