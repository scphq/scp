---
"@scp-dev/cli": patch
---

The Cowork plugin works in cloud sessions: the `--cowork-only` guard also accepts `CLAUDE_CODE_ENTRYPOINT=remote_cowork`, the plugin falls back to `npx -y @scp-dev/cli@<version>` pinned to the building CLI when the host paths are missing, and a cloud session without a relay directory starts no broker.
