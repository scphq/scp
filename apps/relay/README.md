# scp relay

The hosted demo relay: a Cloudflare Worker with D1. People sign in by email with a one-time code (Cloudflare Turnstile is the only throttle), create organizations, invite members, approve `swarm login` device codes and mint API tokens for headless agents. Each organization will get one hub Durable Object.

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
| `EMAIL` | `send_email` binding | Cloudflare Email Service, the default mailer |
| `MAILER` | var | `cloudflare` (default), `resend` or `log` |
| `MAIL_FROM` | var | sender address, `login@scp.dev` by default |
| `TURNSTILE_SITE_KEY` | var | Turnstile site key |
| `TURNSTILE_SECRET` | secret | Turnstile secret key |
| `SESSION_SECRET` | secret | signs CSRF tokens and the sign-in cookie, keys email code hashes |
| `RESEND_API_KEY` | secret | only with `MAILER=resend` |

## Credentials

| Credential | Prefix | Issued by | Acts as |
| --- | --- | --- | --- |
| Device credential | `scp_d_` | `swarm login`, approved at `/device` | the approving user, with their role, in one org |
| API token | `scp_t_` | an org member at `/orgs/<handle>/tokens` or `POST /v1/orgs/<handle>/tokens` | a member of one org, on its creator's behalf, labelling its endpoints `token=<name>` |

Only SHA-256 hashes are stored. Both die on revocation, expiry or when the user leaves the org. `authenticate` and `revalidate` in `src/credentials.ts` turn either into the `HubGrant` the hub admits.
