---
"@scp-dev/cli": patch
"@scp-dev/spec": patch
---

Under `SCP_NATIVE=1` or `mcp`, `swarm setup --cowork` and `swarm setup claude-desktop` build launchers that run the native `swarm mcp` by its absolute path while it is there, else the Node one as before, so local Cowork sessions and desktop chat keep no Node process resident. Cloud Cowork sessions still run the pinned CLI through npx.
