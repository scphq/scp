# Self-hosting

The relay is the hub your machines link through. The CLI uses `https://app.scp.dev` unless you point it elsewhere. You can run both halves of the hosted service on your own Cloudflare account:

- **The relay** (`apps/relay`): a Cloudflare Worker with a D1 database, one `OrgHub` Durable Object per org, email sign-in guarded by Turnstile, and an optional message judge.
- **The site** (`apps/web`, optional): the Next.js site with these docs and the spec, built with OpenNext and served by a Worker.

Cloudflare is one way to host it, not a requirement. The hub engine (`@scp-dev/hub`) is plain TypeScript over a single SQLite call, so any server that holds one SQLite database per org and speaks the bridge protocol in the [spec](/spec) can run it: Bun or Node on a VM, a container, your own platform. This guide covers the Cloudflare setup that app.scp.dev runs.

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
