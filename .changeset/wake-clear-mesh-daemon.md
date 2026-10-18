---
"@scp-dev/core": patch
"@scp-dev/broker": patch
"@scp-dev/cli": patch
---

An ended session no longer advertises its wake: a hook's session_end, an exited harness process, a closed waker past its grace and a takeover clear it, while a live waker still keeps it, and the OpenCode waiter of a session that left sets none. A leftover mesh.json loads the mesh only when it is enabled, and a CLI without the mesh module warns and runs without it.
