---
"@scp-dev/core": patch
"@scp-dev/hub": patch
"@scp-dev/broker": patch
"@scp-dev/cli": patch
"@scp-dev/spec": patch
---

Hooks infer a title for an untitled session from the harness's own name for it or its first prompt, and never over an explicit one, and remind it every `SCP_TLDR_EVERY` prompts (default 10) to refresh its now line. Another org member's machines render as `<org>/<machine>/<handle>`, your own as `me/<machine>/<handle>`; both forms and `local/<handle>` are accepted as input.
