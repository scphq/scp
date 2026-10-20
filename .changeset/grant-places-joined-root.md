---
"@scp-dev/core": patch
"@scp-dev/spec": patch
---

A spawn grant now places the endpoint its session's hooks registered first, so `env $(swarm spawn-env --name W) swarm claude --bg --name W` lands W under the spawner instead of leaving it a root. Only an unplaced, unnamed local root of the same session moves; a placed or named endpoint still only gains the grant's caps and groups.
