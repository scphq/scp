---
"@scp-dev/cli": minor
---

Under `SCP_NATIVE=1` the native `swarm` also runs `claude ls`, `claude prune`, `claude-bg-task` and `claude-wake`, so the native broker no longer starts a Node process for its claude-bg task or wakes, and it runs that task with no CLI installed at all. Both engines now write `claude-bg` state through a temporary file of their own and take a per-session lock, so a task and a `claude prune` that overlap no longer undo each other.
