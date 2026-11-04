---
"@scp-dev/cli": patch
"@scp-dev/spec": patch
---

The native broker audits the hibernations its claude-bg task makes over the socket `{by: "broker"}`, as the TypeScript broker's in-process task does, instead of as the human's. It knows the task's connection by its peer pid.
