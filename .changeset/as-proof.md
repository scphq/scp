---
"@scp-dev/core": patch
"@scp-dev/spec": patch
"scp-relay": patch
---

The spec now states what proves an identity for `--as`: the endpoint's own harness instance nearest on the caller's walk, the grant it spent, its resume token, or a restart in place from its parent's shells. Descent never does, so a worker's shell naming its parent, a sibling or any other live agent is refused `unauthorized`, and a background hand-off or rehome never moves an endpoint to a session below it, nor to a fork whose claim asks to sit under its origin. The native broker now refuses a `send` that names `from` or another relay-set field, as the TypeScript broker already did.
