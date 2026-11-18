---
"@scp-dev/cli": minor
"@scp-dev/spec": patch
"scp-relay": patch
---

The native `swarm` is now the default wherever its package is installed: with `SCP_NATIVE` unset the CLI hands the commands the native `swarm` implements to it, `swarm daemon` and the on-demand start run the native broker, `swarm mcp` and the mounts `swarm setup --write` writes run the native MCP server, and the native hook client starts the native broker, as `SCP_NATIVE=1` did. `SCP_NATIVE=0` keeps the CLI, broker, MCP server and mounts on TypeScript (rerun `swarm setup --write` with it to move existing mounts back), and `SCP_NATIVE=mcp` keeps only the MCP server native. Without a matching native `swarm` (a platform with no native package, an install that skipped the optional dependency, or a Node without `process.execve` for the commands) everything runs on TypeScript as before, with no message; `SCP_NATIVE=1` still notes a missing binary. A broker that is already running keeps serving, whichever engine started it, until `swarm daemon restart`.
