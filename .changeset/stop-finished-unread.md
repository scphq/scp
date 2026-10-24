---
"@scp-dev/cli": patch
---

The idle stop no longer keeps a Claude background worker for unread mail: its waker runs right after the stop, so the revived session reads it.
