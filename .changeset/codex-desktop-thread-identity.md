---
"@scp-dev/cli": patch
"@scp-dev/mcp": patch
"@scp-dev/broker": patch
---

A Codex desktop or IDE thread is one endpoint: the MCP shim an app server starts per thread claims nothing until a tool call names its thread, then joins the endpoint its hooks claim, and the desktop app is recognised when codex options precede `app-server`. A Codex child thread's hooks claim a subagent under the root thread, and ephemeral forks the app makes claim no endpoint.

Connecting to a busy or restarting broker is retried with backoff within a budget (3 s for hooks, longer for commands, shims and the codex waker), a running broker that keeps refusing is reported busy instead of sandboxed, a hook that gives up says so in one stderr line, and the broker asks for a larger listen backlog.
