---
"@scp-dev/cli": patch
---

Separate the claude bg idle stop from the spawn hold: `claude_bg.idle_after_s` and `$SCP_CLAUDE_BG_IDLE_AFTER_S` now set only the Claude Code background idle stop, and the new `spawn.idle_after_s` and `$SCP_SPAWN_IDLE_AFTER_S` set only how long a detached spawn holds a resumable worker. `lifecycle.idle_after_s` and `$SCP_IDLE_AFTER_S` stay the shared default of both.
