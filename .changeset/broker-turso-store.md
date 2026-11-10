---
"scp-relay": patch
"@scp-dev/spec": patch
"@scp-dev/cli": patch
---

The native broker can keep `relay.db` with the experimental Turso engine (`turso_core`, pure Rust) instead of SQLite: set `SCP_STORE=turso`, or `"store": {"engine": "turso"}` in `config.json`, on a binary built with the `turso` cargo feature. SQLite stays the default and release binaries leave Turso out. Both engines share the schema and the file, so a relay directory moves between them in either direction. A broker the CLI, MCP server or hook starts keeps `SCP_STORE`. The broker conformance suite gains a `rust-turso` target, run by an optional workflow that does not block CI.
