---
"@scp-dev/mcp": patch
---

The server instructions say messages reach an agent by themselves, at its next turn or by a wake, so it should never poll `relay_inbox` or `swarm inbox` in a loop but end its turn; `wait_s` is for one short wait.
