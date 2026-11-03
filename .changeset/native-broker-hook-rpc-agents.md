---
"@scp-dev/spec": patch
"scp-relay": patch
---

The native broker serves the hook RPC: it renders every harness's hooks (Claude Code, Codex, Grok, agy, OpenCode, Muse) itself, so a native `swarm hook` or `scp-hook` no longer starts Node for each hook, and a bare `swarm hook` works against a native broker. The native broker also answers `agents`, the local agents' facts `swarm relink --check` and `swarm claude ls` read, for the human only. The `agents` result schema lists `unread_at`, which brokers already send.
