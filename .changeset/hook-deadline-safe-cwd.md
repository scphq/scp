---
"@scp-dev/cli": patch
"@scp-dev/broker": patch
---

A hook's deadline counts from process start: 3.5 s, so a cold start plus a busy broker stays inside the harnesses' 5 s hook timeout, and its connect retry fits in what is left. Connect retries back off from 50 ms to 400 ms. The CLI, its hooks and the MCP shim no longer fail when the working directory cannot be read: they fall back to the payload's `cwd`, `$PWD`, `HOME` or `/`, and a hook that fails still exits 0 with at most one stderr line.
