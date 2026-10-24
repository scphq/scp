---
"@scp-dev/cli": patch
---

The idle stop leaves alone background sessions `swarm claude --bg` did not start, whose revival could not take their endpoint back, and creates its state directory before writing to it.
