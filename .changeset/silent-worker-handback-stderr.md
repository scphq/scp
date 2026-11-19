---
"@scp-dev/cli": patch
"@scp-dev/core": patch
"@scp-dev/spec": patch
---

A spawned worker that exits without output now hands back the tail of its stderr even when it exits 0, so a harness that explains a silent failure on stderr (a headless permission denial, say) no longer reaches the spawner as a bare "exited without replying". The rule is the same in both CLIs and both brokers, and SPEC section 9.3 says so.
