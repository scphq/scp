---
"@scp-dev/cli": patch
"@scp-dev/spec": patch
---

`SCP_CLAUDE_BG_EVERY_S` sets how often the broker runs its claude-bg task, in place of 120 s, in the TypeScript and the native broker alike. A test of the native broker now runs the task every second and checks that an idle broker still stops.
