---
"scp-relay": patch
---

The native broker reads `historic_after_s` (alias `lifecycle.historic_after_s`) from `config.json` and takes durations such as `2h` in `SCP_HISTORIC_AFTER_S`, as the TypeScript daemon does.
