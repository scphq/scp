---
"@scp-dev/hub": minor
---

`HUB_LIMITS` no longer caps machines, endpoints, sockets or stored bytes by default, and the new `hubLimits(env)` applies an `SCP_LIMITS` JSON object over the defaults for embedders.
