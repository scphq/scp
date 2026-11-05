---
"@scp-dev/cli": minor
---

Under `SCP_NATIVE=1` the native `swarm` also runs `spawn-wake` and `codex-wake`, the broker's built-in `spawn` and `codex-queue` wakers, so waking a hibernated spawn worker or a Codex thread starts no Node process. `spawn --via` and `spawn --under` an agent on another machine run natively too, so every `spawn` now stays on the native `swarm`.
