# scp relay

The hosted demo relay: a Cloudflare Worker with D1. People sign in by email with a one-time code (Cloudflare Turnstile is the only throttle), create organizations, invite members, approve `swarm login` device codes and mint API tokens for headless agents. Each organization has one hub Durable Object; its overview page at `/orgs/<handle>` lists the hub's machines, agents and recent activity, draws them as a live graph of spawn and message links, and refreshes itself. `/orgs/<handle>/graph` shows the graph alone, filling the window; both pulse each message as the hub streams it over `/orgs/<handle>/events`, a members-only socket of presence, endpoint and message metadata that never carries a body.

## Develop

```sh
cp .dev.vars.example .dev.vars   # log mailer and Turnstile test keys
bun run dev                      # applies D1 migrations locally, then wrangler dev --local
bun test                         # Miniflare, under bun test
```

The log mailer prints each mail, sign-in codes included, as a `scp-relay mail` line.

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `DB` | D1 binding | the `scp-relay` database, schema in `migrations/` |
| `HUB` | Durable Object binding | `OrgHub`, one per organization |
| `EMAIL` | `send_email` binding | Cloudflare Email Service, the default mailer |
| `MAILER` | var | `cloudflare` (default), `resend` or `log` |
| `MAIL_FROM` | var | sender address, `login@scp.dev` by default |
| `TURNSTILE_SITE_KEY` | var | Turnstile site key |
| `TURNSTILE_SECRET` | secret | Turnstile secret key |
| `SESSION_SECRET` | secret | signs CSRF tokens and the sign-in cookie, keys email code hashes |
| `RESEND_API_KEY` | secret | only with `MAILER=resend` |

Self-hosting: replace `database_id` in `wrangler.jsonc` with the id of your own D1 database.

## Credentials

| Credential | Prefix | Issued by | Acts as |
| --- | --- | --- | --- |
| Device credential | `scp_d_` | `swarm login`, approved at `/device` | the approving user, with their role, in one org |
| API token | `scp_t_` | an org member at `/orgs/<handle>/tokens` or `POST /v1/orgs/<handle>/tokens` | a member of one org, on its creator's behalf, labelling its endpoints `token=<name>` |

Only SHA-256 hashes are stored. Both die on revocation, expiry or when the user leaves the org.

## Hub

`/v1/relay/ws` (WebSocket) and `/v1/relay/rpc` (JSON-RPC over POST) take either credential as `Authorization: Bearer`. The Worker authenticates it against D1 and hands the request to the org's `OrgHub` (`idFromName("hub:" + orgId)`) with the grant in an internal header: the org is the hub account, the member its actor, and an API token a scoped member whose endpoints carry `token=<name>`. The object runs `RelayHub` from `@scp-dev/hub` over its SQLite storage, hibernates its sockets and revalidates every grant against D1 every 5 minutes. Revoking a credential or removing a member closes their sockets at once.

The demo relay sets every hub cap (machines, endpoints, sockets, frame size, call rates, stored bytes) to `Infinity`. Addresses reach only within the org. The code under `src/hub/` is the Cloudflare glue and holds no hub logic.

