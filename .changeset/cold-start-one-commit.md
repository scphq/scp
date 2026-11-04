---
"@scp-dev/core": patch
"@scp-dev/hub": patch
"@scp-dev/cli": patch
---

`core.migrate()`, the hub's `init()` and the native broker's schema migration each run in one transaction, so a cold start commits once instead of about 110 times (126 for the hub), each with its own fsync under Node's default `synchronous=FULL`. With full fsync, the core migration's median went from 55 ms to 6 ms, the hub's from 79 ms to 7 ms, and the native broker's from 482 ms to 25 ms.
