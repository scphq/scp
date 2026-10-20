---
"@scp-dev/cli": minor
"@scp-dev/spec": patch
---

Launchers attribute what they start: `swarm claude` (also `--bg`), `codex`, `muse`, `pi`, `opencode`, `agy`, `grok` and `t3code` run from an agent's shell mint the grant `swarm spawn-env --name N` would mint there, with the agent's own authority, so the new session links under that agent without `env $(swarm spawn-env ...)`. `swarm claude --bg` prints `under me/<agent>`. `$SCP_GRANT` set keeps that grant, `--root` starts a root, a plain terminal is unchanged, and a failed mint warns and launches unlinked.
