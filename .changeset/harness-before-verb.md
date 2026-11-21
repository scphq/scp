---
"@scp-dev/cli": patch
---

`--harness <h>` (and `--harness=<h>`) before the verb is now accepted, like `--as` and `--human`: `swarm --as x --harness cli whoami` runs the verb instead of failing with `unknown command "--harness"`.
