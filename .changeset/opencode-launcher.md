---
"@scp-dev/cli": minor
---

`swarm opencode [--name N]` runs OpenCode with the user's own config and arguments, wake on, and refuses to start without the current plugin. The OpenCode plugin's waiter now runs from load, so a freshly started OpenCode advertises `opencode-plugin` and a message opens a session when none is open yet.
