---
"@scp-dev/cli": minor
"@scp-dev/broker": minor
"@scp-dev/core": minor
"@scp-dev/spec": minor
---

The broker stops a Claude Code background worker that `swarm claude --bg` started once it is done and idle for 600 s, and removes it once historic, never touching roots, orchestrators, attached sessions or ones with unread mail, and never forcing `claude rm`. The endpoint stays hibernated by the new `claude-bg` waker (`swarm claude-wake`), which respawns a stopped worker or resumes a removed one in its directory when a message arrives. `swarm claude ls` lists background sessions with their role and `swarm claude prune` applies the policy at once. The broker gains in-process tasks and the human-only `agents` method; the core gains `localAgents` and `brokerHibernate`.
