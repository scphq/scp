---
"scp-relay": patch
"@scp-dev/core": patch
---

The native broker's human agent list, `list` and the bridge's 2 s reconcile no longer read every matching endpoint row from the database. They select only the ids and take the rows from the endpoint table the broker already keeps in memory, and the agent list resolves parents and subagent roots there too instead of one lookup each. The check for exited hook processes probes each process once per pass instead of once per endpoint. Both brokers add two indexes: one on `messages.expires_at`, so the retention pass no longer reads every message to find the expired ones, and one on `endpoints.harness_session`, which each claim looks up. The indexes are additive, so an older broker of either engine still opens the database.
