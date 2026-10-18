---
"@scp-dev/hub": minor
"@scp-dev/broker": minor
"@scp-dev/cli": minor
"@scp-dev/spec": patch
---

Same-machine traffic shows on the dashboard. A linked broker reports metadata of deliveries between its own endpoints to the hub in batched `local_events` notifications: sender and recipient handles, kind, time and hashed message and thread ids, never a body, note, label or title. The hub counts them in the graph's message edges and streams them to watchers and the dashboard as `message` events marked `local`. `mirror_local: false` in `cloud.json` turns it off.
