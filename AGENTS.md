# SCP

SCP (Swarm Communication Protocol) is an open protocol for addressing and exchanging messages between agents in a swarm.

## Layout

```
packages/spec/   SPEC.md, the protocol source of truth, plus the spec identifier
packages/core/   protocol types: message envelope, endpoint address, wire types
packages/cli/    the scp command line tool
apps/web/        the scp.dev site (Next.js on Cloudflare via OpenNext), renders SPEC.md at /spec
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

Commits and squash merges end with these trailers:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Co-Authored-By: GPT 6.1 Sol <codex@openai.com>
Co-Authored-By: Muse Wonder
Co-Authored-By: Argon 4
```
