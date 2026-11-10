---
"@scp-dev/cli": patch
"@scp-dev/spec": patch
"scp-relay": patch
---

A worker spawned `--as` a subagent's endpoint keeps reporting to that subagent, and both sides now say so. Its result was always addressed to the subagent; once the subagent had stopped, the broker offered it to the subagent's root session framed for that subagent, so a coordinator saw its subagents' workers' results by design. The spawn's started line now names the endpoint the result goes to and keeps `--as` in its steer command, where it used to suggest a plain `swarm send` that a subagent's shell sends as its parent session. A subagent also hears, with its own address, that what reaches it once it stops waits in its inbox, offered to its parent session to continue it with while that session can be woken, and how to wait for a result instead.
