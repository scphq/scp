---
"@scp-dev/cli": patch
---

`swarm codex`, `swarm claude` and `swarm pi` pass every argument through untouched and honour your own config: the codex app-server now gets your `--profile`, model, sandbox and approval settings, `swarm codex --resume THREAD` reopens a thread in the TUI too, and a `--` after harness arguments reaches the harness. `swarm claude` adds the scp channel after your arguments so a prompt is never taken as a channel, accepts `--as`, and refuses to start without a wake-capable scp mount, naming `swarm setup --write`. `swarm pi` keeps pi's own `--name`.
