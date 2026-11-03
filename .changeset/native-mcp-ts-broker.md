---
"@scp-dev/cli": minor
"@scp-dev/spec": patch
"scp-relay": patch
---

`SCP_NATIVE=mcp` runs only the MCP server natively and keeps the TypeScript broker: `swarm setup`, `swarm claude --bg`, `swarm codex` and codex spawns and wakes mount the native `swarm mcp` directly, as under `SCP_NATIVE=1`, but the mounts carry `SCP_NATIVE=mcp`, so a native server that finds no broker starts the TypeScript one through the CLI, and every broker any session or hook starts stays TypeScript. Under `SCP_NATIVE=mcp` the native `swarm daemon` refuses to run, and mounts kept as saved have a saved `SCP_NATIVE=1` replaced with `mcp`. `SCP_NATIVE=1` still runs both natively. `swarm status` names each harness mount's MCP engine and mode next to the broker engine (`mcp` in `--json`), and warns when the broker is native while a mount asks for the TypeScript one.
