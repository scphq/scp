---
"@scp-dev/cli": patch
---

The idle stop also stops a finished Claude background worker with unread mail; its waker runs at once, so the revived session reads it.
