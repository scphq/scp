---
"@scp-dev/cli": patch
"@scp-dev/core": patch
"@scp-dev/spec": patch
"scp-relay": patch
---

A Claude Code background session resumed with `swarm claude --bg -- --resume <session id>` keeps its endpoint when Claude Code resumes it under a new session id. The launcher puts the resumed session in the scp mount as `SCP_HARNESS_ORIGIN`, so the shim's claim carries it as `harness_origin`. A connecting claim whose hooks already registered an auto-named endpoint now takes back the endpoint that its harness session or origin owns at the name it asks for, including one the claude-bg policy hibernated when it stopped the worker. Before, such a resume was refused with `grant used` on every retry. The session then lived only on its hooks' default `claude-<dir>-<n>` root, which the policy never hibernates, so nothing could wake it.
