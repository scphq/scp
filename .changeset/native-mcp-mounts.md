---
"@scp-dev/cli": minor
"scp-relay": patch
---

`SCP_NATIVE=1` mounts the native `swarm mcp` directly: `swarm setup`, `swarm claude --bg`, `swarm codex` and codex spawns and wakes run the native binary with no Node process resident per session, falling back to the Node mount with a note. `swarm mcp` prefers the native `swarm` (`SCP_MCP_BIN` still overrides), and the native `swarm mcp` starts the native broker itself.
