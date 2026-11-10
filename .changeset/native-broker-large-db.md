---
"scp-relay": patch
---

The native broker stays responsive on a large relay database. It keeps the endpoint table in memory and re-reads only the rows a write touched, so a scope check no longer reads and re-derives every endpoint, and it lists, mirrors and reconciles only the endpoints that can show instead of building a view of each one first. Its timed passes no longer hold up accepting connections, which under load had left clients refused with "it is busy".
