---
"@scp-dev/cli": patch
"@scp-dev/broker": patch
---

A hub that stops answering on an open socket no longer wedges the native broker. `hibernate` and `machine_wake` used to wait for the hub's answer while holding the broker's core, with no time limit, so every later request (`swarm whoami`, `swarm send`, the MCP tools) waited forever and SIGTERM did not stop the broker. The broker now waits for the hub only after releasing the core. Every request to the hub has a 15 s limit, and a hub that stays silent that long has its socket dropped and linked again. Shutdown no longer waits on a busy core. When the core stays held for more than 30 s, the broker logs the request that took it last. The TypeScript broker gets the same 15 s reply limit on its hub requests.
