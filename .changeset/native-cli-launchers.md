---
"@scp-dev/cli": minor
---

Under `SCP_NATIVE=1` the native `swarm` also runs the long-running harness launchers itself: `swarm codex`, `swarm muse`, `swarm t3code`, `swarm agy`, `swarm grok`, `swarm opencode` and `swarm pi`, with the same grant attribution, `--under` placement, harness arguments and environment, output and exit codes as the TypeScript CLI. The relay channel of `codex`, `muse`, `t3code`, `agy` and `grok` runs in the native process, and the native `swarm` embeds the pi extension for installs without the TypeScript CLI beside it.
