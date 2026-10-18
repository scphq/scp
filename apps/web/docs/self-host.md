# Self-host a relay

The relay is the hub your machines link through. The CLI uses `https://app.scp.dev` unless you point it elsewhere. The relay in `apps/relay` is a Cloudflare Worker with D1 and one Durable Object hub per org, and you can deploy it to your own account.

## Point the CLI at your relay

```sh
swarm relay use https://relay.example.com
swarm relay show        # the active relay, where it came from, and whether you have a login for it
swarm login
swarm cloud enable
```

`relay use` saves the URL in `~/.config/scp/config.json`. `SCP_RELAY` overrides it for one shell or one command. Logins are stored per relay URL, so switching back to another relay keeps its login. A relay URL is `https`; plain `http` is allowed only for `localhost`.

## What you deploy

| Part | Role |
| --- | --- |
| Worker | Email sign-in with a one-time code, orgs and invites, device approval for `swarm login`, API tokens, the hub routes |
| D1 database | Users, orgs, members, credentials; schema in `apps/relay/migrations/` |
| `OrgHub` Durable Object | One per org: machines, mirrored endpoints, deliveries, over its own SQLite storage |
| Email Service | Sends sign-in codes |
| Turnstile | Guards sign-in |

Only SHA-256 hashes of credentials are stored. The hub revalidates every connection against D1 every 5 minutes, and revoking a credential or removing a member closes their sockets at once. The relay sets no hub caps.

## Deploy

```sh
git clone https://github.com/scphq/scp
cd scp && bun install
cd apps/relay
bunx wrangler login
bunx wrangler d1 create scp-relay
```

Edit `wrangler.jsonc`:

- `database_id`: the id `d1 create` printed.
- `routes`: your domain in place of `app.scp.dev`.
- `MAIL_FROM`: a sender address on a domain set up for Cloudflare Email Service.
- `TURNSTILE_SITE_KEY`: the site key of a Turnstile widget for your domain.

Then apply the schema, set the secrets and deploy:

```sh
bunx wrangler d1 migrations apply scp-relay --remote
openssl rand -hex 32 | bunx wrangler secret put SESSION_SECRET
bunx wrangler secret put TURNSTILE_SECRET
bunx wrangler deploy
curl https://relay.example.com/health
```

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `MAILER` | var | `cloudflare` (default), `resend` or `log` |
| `MAIL_FROM` | var | Sender address |
| `TURNSTILE_SITE_KEY` | var | Turnstile site key |
| `TURNSTILE_SECRET` | secret | Turnstile secret key |
| `SESSION_SECRET` | secret | Signs CSRF tokens and the sign-in cookie, keys email code hashes |
| `RESEND_API_KEY` | secret | Only with `MAILER=resend` |

`MAILER=log` writes each mail, sign-in codes included, to the Worker log (`bunx wrangler tail`). Use it only for testing.

## Run it locally

```sh
cd apps/relay
cp .dev.vars.example .dev.vars    # log mailer and Turnstile test keys
bun run dev                       # applies the migrations locally, then wrangler dev
swarm relay use http://localhost:8787
```
