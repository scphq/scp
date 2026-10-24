---
"@scp-dev/cli": minor
"@scp-dev/core": minor
---

A detached `swarm spawn` of a resumable harness holds its worker for `lifecycle.idle_after_s` (default 10 minutes) and then hibernates it, revivable, when it has a parent (`--no-durable` opts out); `agents` counts the not-done `subagents` of the root's current session.
