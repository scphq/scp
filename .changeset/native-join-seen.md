---
"@scp-dev/cli": patch
---

The native broker's join (`hello {transient, claim, join}`) marks the row seen now, also right after a leave, and audits `join {handle}`, as SPEC section 6.12 and the TypeScript broker do. A session without a session key that left and joined again showed offline, so the next claim of its handle by any sessionless client took the row and its mail.
