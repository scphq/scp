---
"@scp-dev/cli": minor
---

Claude Code background workers leave `claude agents` as they hibernate: the broker runs `claude rm` right after it stops a worker `swarm claude --bg` started, and a message resumes it with `claude --bg --resume` on the same endpoint, name and directory. `claude_bg.remove` (`$SCP_CLAUDE_BG_REMOVE`) is now `on_stop` (default; `true` and `1` mean it too), `historic` (the previous behaviour: only once the endpoint is historic) or `false`. A worker in a worktree Claude made for it keeps the `historic` timing, since `claude rm` deletes that worktree. A worker whose own workers have all finished is removed too, where it used to be kept for having any worker at all, and a stopped worker whose endpoint is gone, so nothing could wake it, is removed unless it started as a root; its transcript stays for `claude --resume`.
