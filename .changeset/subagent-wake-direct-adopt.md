---
"@scp-dev/core": minor
"@scp-dev/broker": minor
"@scp-dev/mcp": minor
"@scp-dev/cli": minor
"@scp-dev/spec": minor
"@scp-dev/relay": patch
---

A message to a stopped in-process subagent wakes its root: the root's waker is pushed the message tagged `for` the subagent (framed to continue it by its id), the subagent shows the root's wake and stays idle while that waker lives, and the message stays unread for the subagent without being shown twice. An agent now adopts a local root it may message directly (from its session or its shell), a child under another parent is still asked to consent, and `swarm join --under` in a codex sandbox that blocks the relay socket names `relay_join {under}` and the codex setting instead of a bare socket error; the relay dashboard words hook and spawn wakes.
