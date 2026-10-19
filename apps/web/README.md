# scp.dev

The site for the Swarm Communication Protocol: a short landing page, the docs at `/docs` and the specification at `/spec`, rendered at build time from `docs/*.md` and `packages/spec/SPEC.md`; `packages/spec/IMPLEMENTATION.md` renders as the docs page `/docs/implementation`.

Next.js (App Router), deployed to Cloudflare Workers through OpenNext.

## Develop

```sh
bun install
bun run dev        # next dev on http://localhost:3000
```

Page copy lives in `app/content.ts`. The swarm view is `app/swarm.tsx`, the scripted fleet view is `app/demo.tsx`. Docs pages are Markdown in `docs/`, listed in `lib/docs.ts`. Edit `packages/spec/SPEC.md` to change the spec; headings get stable anchors (`/spec#7-9-untrusted-content-framing`).

## Build and preview

```sh
bun run build      # next build
bun run preview    # OpenNext build, then wrangler dev serving the Worker locally
```

`bun run preview -- --port 4321` picks the port.

## Deploy

```sh
bun run deploy     # OpenNext build, then wrangler deploy
```

`wrangler.jsonc` deploys the Worker `scp-dev` with custom domains `scp.dev` and `www.scp.dev`. No account id is checked in: wrangler uses the account you are logged in to, or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in CI.
