---
"@scp-dev/cli": minor
---

`swarm claude --bg [--name N]` starts a Claude Code background session that claims its name and the caller's grant through a passed `--mcp-config`, so `env $(swarm spawn-env --name N)` links it under the caller and messages wake it through its inbox; it prints the short id and the address. `swarm claude attach <id|name> [--name N]` attaches, renaming the endpoint first, and `swarm claude --resume <id>` of a live background session attaches to it.
