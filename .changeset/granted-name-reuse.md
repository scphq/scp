---
"@scp-dev/cli": patch
"@scp-dev/core": patch
"@scp-dev/spec": patch
"scp-relay": patch
---

A background session started with a grant for a name its parent used before now gets that name. The old endpoint of that name had been hibernated as revivable when its session stopped, and handle search passed revivable rows by, so the granted claim landed on a suffixed handle, was refused `grant for another name` on every retry, and the session stayed on the default endpoint its hooks had made. A connecting claim whose unspent grant names the handle and places it under the row's own parent now takes over such a row once no connection holds it and its harness process is gone: a grant incarnation that ends the hibernation. A live holder, a row under another parent and a grant from another issuer are still refused. Hooks of a daemon-hosted Claude Code session now claim `join_only` also when Claude Code leaves `CLAUDE_CODE_SESSION_KIND` out of their environment, since the harness process's command line shows it runs as a background spare, so they no longer make a default endpoint before the session's shim. `agents` reports each agent's `surface`, and `swarm claude --bg` names the endpoint the broker shows for the session, by its harness session or its tool surface's: a `--name` that another handle holds fails with that address, and a session no connection holds yet is reported as not on SCP yet. Both brokers behave alike.
