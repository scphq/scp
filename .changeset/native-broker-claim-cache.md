---
"scp-relay": patch
---

The native broker answers claims and hooks faster on a large relay database. A claim reads endpoint rows from the in-memory endpoint table instead of one SQL read per row, and that table is checked against the database only after a write. The exited-hook check reads each process once instead of every endpoint row.
