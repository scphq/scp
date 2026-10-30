---
"@scp-dev/cli": patch
"@scp-dev/core": patch
"@scp-dev/spec": patch
---

A hook fired by one of Claude Code's pre-warmed background spares before any session claims it no longer registers an agent named after the daemon's cwd, so a background session no longer leaves a stray auto-named endpoint on the relay beside its own. `swarm whoami` shows the agent's depth and says when it counts only this machine's tree because the parent is on another machine; SPEC section 11 says `depth` is local.
