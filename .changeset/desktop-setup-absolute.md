---
"@scp-dev/cli": minor
---

`swarm setup` writes every mount and the Claude Code and codex hooks by absolute paths (a node script as absolute node plus its real path), so desktop apps that start them without the shell's PATH find `swarm`; entries an earlier setup wrote with a bare `swarm` are rewritten in place. `swarm setup claude-desktop` builds `scp.mcpb`, a Claude desktop chat extension.
