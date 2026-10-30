---
"@scp-dev/broker": patch
"@scp-dev/cli": patch
"@scp-dev/core": patch
"@scp-dev/mcp": patch
"@scp-dev/spec": patch
---

A session started with `--under` an agent on another machine, including a background session a harness daemon hosts, now links even when the claim lands before the hub link is up or before the parent's machine mirrored it: a refused link stays pending on the endpoint and the broker tries it again each time it applies other machines' endpoints. A root may link under a worker of another tree when it may message that tree's root, the worker's inbound rules admit it and the policy does not refuse it. A refusal is no longer silent: the broker logs it, `whoami` (and `relay_whoami`, `swarm whoami`) shows `link_pending` with the reason, and a launcher whose broker is not linked to the hub yet warns. The hub bridge logs when it links and unlinks.
