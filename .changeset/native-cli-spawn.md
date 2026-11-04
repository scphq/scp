---
"@scp-dev/cli": minor
---

Under `SCP_NATIVE=1` the CLI also hands `spawn` to the native `swarm`, in the foreground and with `--bg`: a detached worker's runner, its holds and an MCP `relay_spawn` no longer keep a Node process per worker. `--via` and `--under` an agent on another machine stay on the TypeScript CLI.
