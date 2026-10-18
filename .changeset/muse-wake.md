---
"@scp-dev/cli": minor
"@scp-dev/core": minor
---

`swarm muse [--name N] [--resume S] [--approval-mode never|on-request|untrusted] [-- muse serve args...]` runs a headless Muse session through `muse serve` that relay messages wake: each message starts a turn on the idle session or steers the running one, and the agent's replies print to standard output. It advertises the new wake value `muse-serve`, honours `swarm spawn-env` grants through a launch file the session's shim and hooks read, and fails loudly when the session's scp mount never joins. A prompt made of relay messages no longer becomes the session's inferred title.
