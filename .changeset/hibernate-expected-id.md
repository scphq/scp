---
"@scp-dev/spec": patch
"@scp-dev/core": patch
"@scp-dev/broker": patch
"@scp-dev/cli": patch
"scp-relay": patch
---

`hibernate` takes `id` with `endpoint`: the endpoint id the caller expects the address to name, refused `not_found` with nothing changed when the address names another endpoint since. `swarm claude prune` and the claude-bg task pass it, so a worker renamed while they ran, whose old handle another endpoint took, never has that endpoint hibernated or cleared in its place.
