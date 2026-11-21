---
"@scp-dev/cli": patch
---

The repository's test suite runs its files in parallel worker processes (`bun run test`), and the test build helper builds `dist` once under a lock so the workers do not build over each other. Nothing in the published CLI changes.
