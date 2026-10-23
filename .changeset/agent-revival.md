---
"@scp-dev/cli": minor
"@scp-dev/broker": minor
"@scp-dev/core": minor
"@scp-dev/mcp": minor
"@scp-dev/spec": minor
---

A hibernation whose ref is a revive record (harness, session, cwd, argv, via) makes the endpoint revivable: its view shows `revivable: true`, each waker run gets a one-time wake ticket, and the resumed session's claim with that ticket takes the same endpoint back with its mail, place, title and groups. A revivable endpoint is never renamed out of its handle or deleted while it sleeps. Durable spawns are revivable as they are, and the `claude-bg` waker now hibernates stopped and removed Claude Code background workers with a revive record, writes the ticket into the session's MCP config before `claude respawn` or `claude --bg --resume`, declines sessions `swarm claude --bg` did not start and declines `gone` when the transcript is gone. `swarm mcp` claims with `$SCP_WAKE_TICKET` and falls back to a plain claim when the ticket is spent.
