---
"@scp-dev/cli": minor
---

Under `SCP_NATIVE=1` the native `swarm` also runs `swarm setup` itself: the plan, `--write`, `--undo`, `--engine` and `--join`, with the same output, files and `setup.json` as the TypeScript CLI. A config file holding a lone surrogate, a `__proto__` event under `hooks`, or bytes that are not UTF-8 is now refused with a line saying why and left as it was.
