# Releasing

Changesets drive npm releases. `@scp-dev/core`, `@scp-dev/hub`, `@scp-dev/broker`, `@scp-dev/mcp` and `@scp-dev/cli` are the publishable packages; `@scp-dev/spec` (SPEC.md only), `@scp-dev/web` and `@scp-dev/relay` are never published.
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
