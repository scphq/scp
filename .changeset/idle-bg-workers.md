---
"@scp-dev/core": minor
"@scp-dev/broker": minor
"@scp-dev/cli": minor
---

An idle Claude Code background worker `swarm claude --bg` started stops after `lifecycle.idle_after_s` (default 10 minutes) and stays wakeable; `SCP_HISTORIC_AFTER_S` or `historic_after_s` sets when an agent turns historic, and `agents` reports live `subagents`.
