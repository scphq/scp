---
"@scp-dev/cli": patch
---

Hook handlers that setup and `hooks install` write for Claude Code, Codex and Muse now time out after 10 s instead of 5 s, so a heavily loaded machine no longer shows "hook timed out" errors before the hook's own deadline ends it. Installs with the old 5 s timeouts are updated by the next `swarm setup --write` or `hooks install --write`.
