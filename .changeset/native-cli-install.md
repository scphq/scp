---
"@scp-dev/cli": minor
---

Under `SCP_NATIVE=1` the native `swarm` also runs `hooks install` and `mcp install`. The hook commands, plugin files and settings merges it writes are byte for byte the ones the TypeScript CLI writes, so an install by one is up to date for the other. `swarm mcp` itself, the MCP shim, and `swarm setup` stay on their current paths.
