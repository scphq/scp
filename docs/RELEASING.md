# Releasing

Changesets drive npm releases. `@scp-dev/core`, `@scp-dev/hub`, `@scp-dev/broker`, `@scp-dev/mcp` and `@scp-dev/cli` are the publishable packages; `@scp-dev/spec` (SPEC.md and IMPLEMENTATION.md), `@scp-dev/web` and `@scp-dev/relay` are never published.
A package is published once it drops `private: true`; until then `changeset publish` skips it.

## Day to day

Run `bun changeset` in a PR that changes a published package and commit the generated `.changeset/*.md`.
On every push to `main`, `.github/workflows/release.yml` either opens or updates the `chore: release` PR (while changesets are pending)
or, with none pending, runs the checks, builds `dist/`, pins `workspace:*` ranges and runs `changeset publish`, which publishes every
public package whose version is not on npm yet, with provenance.

The release PR is opened with `GITHUB_TOKEN`, so CI does not run on it by itself; close and reopen it, or push to its branch, to run the checks.

## One-time setup

### 1. npm scope

The packages publish under the npm organization `scp-dev`: `@scp-dev/core` and `@scp-dev/cli`.

### 2. GitHub settings

Under Settings > Actions > General, allow GitHub Actions to create and approve pull requests, so the workflow can open the release PR.

### 3. First publish of each new package

npm configures a trusted publisher from the package's own settings page, so a name that has never been published cannot get one yet.
The first version of each package goes out with a token:

1. Create a granular access token on npmjs.com with read and write permission on all packages of the `scp-dev` organization (a name that
   does not exist yet cannot be selected on its own) and a short expiry.
2. Add it as the repository secret `NPM_TOKEN`.
3. Remove `"private": true` from the packages to publish, add a changeset and merge the `chore: release` PR. The release finds no OIDC
   trust for the new names, falls back to `NPM_TOKEN` and creates them, still with provenance.

Without `NPM_TOKEN`, `scripts/check-publish-targets.ts` fails the release before the first upload and names every package that is not on npm yet.

### 4. Trusted publishing

For each package, on npmjs.com under Settings > Trusted Publisher, add a GitHub Actions publisher:

- Organization or user: `scphq`
- Repository: `scp`
- Workflow filename: `release.yml`
- Environment: leave empty (the release job declares none)

A new trusted publisher configuration expires if it does not complete a publish within 2 days, so add it shortly before the next release.
Once a release has published every package through OIDC, delete the `NPM_TOKEN` secret, revoke the token, and set each package's publishing
access to "Require two-factor authentication and disallow tokens".

## NPM_TOKEN fallback

The release step always passes `secrets.NPM_TOKEN` to npm as `NODE_AUTH_TOKEN`. npm (11.5.1 or later, from Node 24) tries the OIDC exchange
first and uses the token only when that fails, so the token is a fallback that applies automatically while the secret exists and does nothing
once it is deleted. Keep it only for bootstrapping new package names.

## Deploys

`.github/workflows/deploy.yml` deploys on every push to `main`, each app only when its sources changed; a manual run deploys both.

- `web` (scp.dev): on changes under `apps/web/` or `packages/spec/`, runs `bun run deploy` in `apps/web`.
- `relay` (app.scp.dev): on changes under `apps/relay/`, `packages/core/`, `packages/hub/` or `packages/broker/`, applies the D1
  migrations to `scp-relay` with `--remote`, then runs `wrangler deploy`.

Each job ends with a smoke check that expects a 200 from `https://scp.dev/` or `https://app.scp.dev/health`.
Both jobs need two repository secrets: `CLOUDFLARE_API_TOKEN` (a token with Workers Scripts, Workers Routes and D1 edit permission)
and `CLOUDFLARE_ACCOUNT_ID`.

## Relay releases

Changesets versions the Rust relay too. Its version anchor is the private workspace package `scp-relay` in
`crates/package.json`; `changeset publish` skips it because it is private, and `scripts/check-publish-targets.ts` fails
the npm release if it ever stops being private. In a PR that changes the relay, the npm wrapper or the dashboard, run
`bun changeset` and pick `scp-relay`.

The `chore: release` PR then bumps `crates/package.json`, writes `crates/CHANGELOG.md`, and `version-packages` runs
`bun scripts/relay-version.ts sync`, which copies the version into both crates, the exact store dependency pin,
`Cargo.lock`, the npm wrapper's version and optional dependencies, and `packages/dashboard/package.json`. CI runs
`bun scripts/relay-version.ts --check`. The dashboard stays `private: true` in source and is excluded from changesets.
The wrapper in `crates/npm/relay-server` is outside the Bun workspaces, so changesets and the regular npm publish checks
ignore it.

Merging the release PR releases the relay: **Release relay** (`release-relay.yml`) runs on every push to `main`, and
its `gate` job stops there unless the tag `scp-relay@X.Y.Z` for the anchor version does not exist yet. A new version
checks the synced versions and the npm bootstrap before building, creates `scp-relay@X.Y.Z` at the pushed revision,
then publishes:

- Six binary archives with SHA-256 checksums on the release: macOS arm64 and x64, Linux glibc arm64
  and x64, Linux musl x64, and Windows x64.
- `scp-relay-server` and `scp-relay-store` on crates.io.
- `@scp-dev/relay-server`, its six optional platform packages, and `@scp-dev/dashboard` on npm, with provenance.
  The npm job builds the dashboard and removes `private` from a temporary publish copy.
- `ghcr.io/scphq/scp-relay` and `ghcr.io/scphq/scp-dashboard` for amd64 and arm64, tagged `vX.Y.Z`, `X.Y` and `latest`, with provenance,
  SBOMs and a keyless signature on the manifest digest. Main pushes also publish `edge`.

One-time setup:

1. After the first image push, set both GHCR packages' visibility to **Public**.
2. Add `CARGO_REGISTRY_TOKEN` with permission to publish both crates. With no token, the crates job
   reports a notice and skips publication.
3. Bootstrap all eight npm names: either set a temporary `NPM_TOKEN` repository secret for the first
   release, or manually publish each platform package, the wrapper and the dashboard once. Trusted publishing cannot
   create a new name. With missing names and no token, `prepare` fails before builds, tags or uploads.
4. For each npm package, configure a trusted publisher on npmjs.com for owner `scphq`, repository
   `scp`, workflow filename `release-relay.yml`, and no environment. Configure it shortly before a release.
5. Once OIDC publication works for every name, remove `NPM_TOKEN` and revoke the bootstrap token.

The npm job uses Node 24 and passes `NPM_TOKEN` as `NODE_AUTH_TOKEN` only as a bootstrap fallback.
Already published npm versions are skipped; the dashboard publishes after the relay wrapper. Already published crate
versions are skipped too. A created release tag is never overwritten, and a manual run of the workflow skips a tagged
version like a push does: complete a partial release by re-running the failed jobs of its run while its build artifacts last (7 days). A manual run releases a
version whose push run failed before tagging.
