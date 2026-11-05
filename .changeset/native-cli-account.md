---
"@scp-dev/cli": minor
---

Under `SCP_NATIVE=1` the native `swarm` also runs `relay`, `login`, `logout`, `cloud` and `machines`, and `--cloud` (or `SCP_TRANSPORT=cloud`) on every native verb talks to the hub directly instead of falling back to the TypeScript CLI. Credentials and cloud.json keep their format and private modes.
