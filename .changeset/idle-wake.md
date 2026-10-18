---
"@scp-dev/cli": patch
"@scp-dev/mcp": patch
---

Idle Claude Code sessions wake on peer messages. `swarm claude [--name N] [claude args...]` starts Claude Code with the scp channel loaded, and `swarm setup`, `swarm up` and `swarm mcp install --harness claude` mount its MCP server with `--channels`. The server pushes only to a client that declares `claude/channel` or that `swarm claude` started, so other sessions keep the hook path. An inbox wait that runs into the 50 s cap says so.
