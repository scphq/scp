---
"@scp-dev/core": minor
"@scp-dev/broker": minor
"@scp-dev/cli": minor
---

Any idle Claude Code background worker stops after `lifecycle.idle_after_s` (default 10 minutes) and stays wakeable, sessions `swarm claude --bg` did not start included; `SCP_HISTORIC_AFTER_S` or `historic_after_s` sets when an agent turns historic, and `agents` reports live `subagents`.
