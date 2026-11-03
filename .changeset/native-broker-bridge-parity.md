---
"scp-relay": patch
---

The native broker writes timestamps with milliseconds, as the TypeScript broker does, so `swarm cloud status` shows the same `since`, and it refuses a cloud.json that lists more than 256 mirror selectors like the TypeScript broker.
