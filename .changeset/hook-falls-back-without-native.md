---
"@scp-dev/cli": patch
---

Hooks keep working when the native hook client is missing, for example after an install that skipped the optional `@scp-dev/native-<platform>` package: `swarm setup` writes each hook so that it runs `scp-hook` only while that file is executable and otherwise runs the CLI through Node. Claude Code, Codex, Grok and agy get a shell guard, the Muse manifest goes through `/bin/sh`, and the OpenCode plugin checks the file before each spawn. `swarm status` and `swarm setup` warn when a hooks file runs a native client that is gone. Rerun `swarm setup --write` to rewrite existing hooks.
