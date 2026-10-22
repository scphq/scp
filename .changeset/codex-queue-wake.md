---
"@scp-dev/core": minor
"@scp-dev/broker": minor
"@scp-dev/cli": minor
---

Wake Codex desktop, IDE and finished `codex exec` threads with the new `codex-queue` broker wake: the broker queues messages into the thread with `codex queue` and opens it in the desktop app when nobody else holds it. Codex threads an app server shares are their own endpoints, and `swarm codex --resume` refuses a thread another surface holds with a `codex fork` hint.
