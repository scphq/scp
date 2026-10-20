---
"@scp-dev/cli": minor
"@scp-dev/core": minor
"@scp-dev/broker": minor
"@scp-dev/spec": minor
---

Wakeable spawns. A codex exec, agy -p or grok -p worker stays resumable after its run: `swarm spawn` holds its endpoint with the new wake `spawn-resume`, and each message to it resumes the same harness session, handing every run back as a reply (`spawn_exit {run, reply_to}`), until `--idle` passes (default 1800 s when detached), `swarm end <worker>` (`spawn_end`) or a signal. `--durable` hibernates the worker instead of letting it go, also when spawn crashes or the broker restarts, and the broker's built-in `spawn` waker resumes it on the next message as the same endpoint, keeping its labels, groups, peek and caps.
