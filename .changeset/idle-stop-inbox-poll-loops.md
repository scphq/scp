---
"@scp-dev/cli": patch
---

The idle stop and `swarm claude prune` no longer keep a Claude Code background session whose only running Bash tool command is an inbox poll loop (`swarm inbox --wait` in a loop with nothing but shell keywords, `echo`, `sleep` and piped filters without file operands): it counts as idle, even while Claude Code shows it busy, unless its endpoint has unread mail; any other command, such as a CI watch loop, still keeps it. Bash tool shells started without a shell snapshot also count as running commands. `swarm inbox --help` says messages arrive by themselves, so never poll in a loop.
