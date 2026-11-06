---
"@scp-dev/cli": patch
"@scp-dev/core": patch
"@scp-dev/spec": patch
"scp-relay": patch
---

A worker's result reaches the session that spawned it. A background session resumed under a new id could not name itself in its hooks, so they registered a default `claude-<dir>-<n>` endpoint before its shim took back its named one. That default row kept the session's harness process with its harness session id wiped: the session's shells bound it because it sat shallower than the named endpoint, workers were placed under it, and the next session to reach that default handle took the row with its children and read their mail. Hooks of a daemon-hosted session now claim `join_only`: they join what their session owns and make no endpoint of their own, so that row never exists, and a command run before the shim connects is refused. For rows an older broker left, the endpoint a session holds now comes first among those holding one harness process, a left row lets go of the process, and handle search no longer takes a row on an unproven claim while a harness process still runs its session, or, for a claim that reports a harness session the row never did, while the row keeps a child, a worker on another machine or unread mail. Both brokers behave alike.
