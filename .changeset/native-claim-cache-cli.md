---
"@scp-dev/cli": patch
---

The native packages now carry the broker's claim-path speedup: claims read the in-memory endpoint cache instead of SQLite.
