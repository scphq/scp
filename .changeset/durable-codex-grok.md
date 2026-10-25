---
"@scp-dev/cli": patch
"@scp-dev/core": patch
---

Durable codex exec and grok spawns: a codex exec worker is held and revived by the thread id its output names when its hooks report none, with its prompt in argv or on stdin; a grok -p worker's durable ref leaves out the allow rules launch adds again, so it fits. A handback says the worker stays resumable after its idle time only when its hold is durable, and a send to a held or hibernated worker reports that it wakes it.
