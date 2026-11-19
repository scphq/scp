---
"@scp-dev/cli": patch
---

`swarm claude --bg` no longer reports a background session that died as it started. It watches the new session for a few seconds (`SCP_CLAUDE_BG_CONFIRM_S`, 5 s by default, 0 to skip) until its endpoint claims it, and fails with why when the session or `claude --bg` itself dies first: the exit code or signal, and memory pressure as the likely cause when free memory is low. `swarm claude ls` shows such a session as `failed`, and the launch warns first when free memory is under 10%.
