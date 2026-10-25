---
"@scp-dev/cli": patch
---

The idle stop and `swarm claude prune` keep a Claude Code background session while a Bash tool command still runs under it, such as a `run_in_background` command left running when its turn ended, and `swarm claude ls` shows it as `kept: running a background command`. An unreadable process table keeps every live session.
