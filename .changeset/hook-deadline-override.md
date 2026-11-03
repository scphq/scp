---
"@scp-dev/cli": patch
"@scp-dev/spec": patch
---

`SCP_HOOK_DEADLINE_MS` sets a hook's deadline from process start, in place of the 3500 ms deadline and agy's 900 ms, in the TypeScript hook and the native `scp-hook` alike. It is for machines too loaded to meet the defaults; past the harness's own hook timeout the harness kills the hook first.
