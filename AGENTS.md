# SCP

SCP (Swarm Communication Protocol) is an open protocol for addressing and exchanging messages between agents in a swarm.

## Layout

```
packages/spec/   SPEC.md, the protocol source of truth
packages/core/   protocol types: message envelope, endpoint address, wire types
packages/cli/    the swarm command line tool
apps/web/        the scp.dev site (Next.js on Cloudflare via OpenNext), renders the docs at /docs and SPEC.md at /spec
apps/relay/      the hosted demo relay: a Cloudflare Worker with D1 for sign-in, orgs, device login and API tokens
```

## Commands

Package manager is **bun**.

```sh
bun install
bun run typecheck        # every workspace
bun test

cd apps/web
bun run dev              # http://localhost:3000
bun run build            # next build
bun run preview          # OpenNext build, then wrangler dev serving the Worker locally
```

Run `bun run typecheck` and `bun test` before opening a PR.

## Conventions

- TypeScript strict (`tsconfig.base.json`). Do not loosen compiler options.
- Comments are terse and only where the code is not understandable without them. No narration, no history, no ticket or PR references.
- No em or en dashes in prose, docs or comments. Use commas, colons, parentheses or a plain hyphen.
- SPEC.md and the code must agree. A change to the wire format, addressing or semantics updates `packages/spec/SPEC.md` and the code in the same PR.

## Commits and PRs

- Titles are conventional commits: `type(scope): summary`, imperative and concise. Scope is a package or area (`spec`, `core`, `cli`, `web`, `ci`, `deps`).
- Examples: `feat(core): message envelope`, `fix(cli): address parsing`, `docs(spec): clarify framing`.
- PRs target `main` only and are squash merged.

PR bodies follow `.github/pull_request_template.md`:

- **TL;DR**: written by a human, always. Agents leave the placeholder and never fill it in.
- **Summary**: concise bullets, written by the agent. What changed, not how.
- **Test plan**: check-boxes (`- [ ]`) the author fulfills before requesting review.
- **Screenshots**: only for UI changes. Delete the section otherwise.

## Co-authors

Every model that worked on a change (implemented, reviewed, scouted or wrote copy) is credited as a co-author in the PR body, so the squash merge carries it onto main. Models with a GitHub identity use their address; models without one are credited by name only:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Co-Authored-By: GPT 6.1 Sol <codex@openai.com>
Co-Authored-By: Muse Wonder
Co-Authored-By: Argon 4
```

Add any other model that took part the same way, for example `Co-Authored-By: Grok 4.7`. Credit the model, never the tool or CLI.

The trailers must be the last paragraph of the PR body, after the `Generated with` line, with nothing below them. Git and GitHub only read trailers from the final paragraph, so co-authors placed earlier are silently dropped from the squash commit.
