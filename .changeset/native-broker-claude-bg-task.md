---
"@scp-dev/cli": patch
"scp-relay": patch
---

The native broker runs the claude-bg policy that stops and removes idle `swarm claude --bg` workers: every 120 s it starts `swarm claude-bg-task`, one run of the task the TypeScript broker runs in process, on the broker's socket as the human, with what the last run learnt kept in `claude-bg-task.json` in the relay directory. A run still going skips the next one, and its connection does not keep an idle broker running.
