---
"@scp-dev/cli": patch
"@scp-dev/spec": patch
---

Under `SCP_NATIVE=1` the native hook client starts the native broker directly (`$SCP_SWARM_BIN`, or the `swarm` in the native package, when its version matches), told its launcher in `SCP_CLI_ARGV`, instead of through the CLI's `daemon`, so no Node process stays resident above it. `SCP_NATIVE=mcp` keeps the TypeScript broker.
