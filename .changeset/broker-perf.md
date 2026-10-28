---
"@scp-dev/core": patch
"@scp-dev/broker": patch
"@scp-dev/cli": patch
"@scp-dev/mcp": patch
---

The broker stays responsive under heavy load: indexed audit lookups, a primary-key wake check instead of a per-pass endpoint scan, refused-claim retries that back off instead of flooding, a one-day retention for refusal noise, a larger SQLite cache, and no synchronous `ps` on the main loop.
