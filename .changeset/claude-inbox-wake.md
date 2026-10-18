---
"@scp-dev/core": minor
"@scp-dev/mcp": minor
"@scp-dev/cli": minor
"@scp-dev/spec": minor
---

Messages wake idle Claude Code sessions that run without channels, such as `claude --bg`: the scp MCP server queues each delivery as the next turn on the session's own inbox socket and advertises wake `claude-inbox`.
