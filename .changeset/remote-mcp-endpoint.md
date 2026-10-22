---
"@scp-dev/hub": minor
"@scp-dev/spec": patch
---

Remote MCP endpoint: `RelayHub.mcp()` serves an account to MCP clients over Streamable HTTP with JSON responses and `Mcp-Session-Id` sessions. Each grant gets one client machine `<label>-<4 hex>` with a default endpoint named for the label and the forced `client` label; `relay_join` gives a session its own endpoint and `relay_leave` drops it. Endpoints are claimed with `in` and `out` of `["*"]`, so they stay within the account, and every result ends with the unread count. Waits are capped at `mcpWaitS` (50 s) and results at 150000 characters. Hub clients gain the `title`, `receipts`, `message`, `peers` and `leave` methods. SPEC section 14.9 describes the endpoint.
