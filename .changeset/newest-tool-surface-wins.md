---
"@scp-dev/broker": patch
"@scp-dev/core": patch
"@scp-dev/mcp": patch
"@scp-dev/spec": patch
"scp-relay": patch
---

A session's new MCP server keeps the session's endpoint. Claude Code starts a new MCP server for a session it reconnects (as after `/login`) and leaves the old one running and connected, so the new server's claim found the session's endpoint held by a live connection under another handle and got a fresh default-named child instead: the session then acted as that child while mail to its name went to the abandoned server. MCP servers now send an `instance` with every hello, and a claim from one takes over the endpoint its harness process holds for the same harness session, keeping name, title, place, children and mail. The older server is told `superseded`, closed and refused from then on, also after a broker restart and when it predates this change; it stays idle and answers its tools with `superseded`, so the two never take the endpoint from each other in turn. Another harness session of the same process, hooks, exact and subagent claims never supersede, and a claim from another session of a process that hosts several no longer joins a live endpoint by handle. Both brokers and both MCP servers behave alike.
