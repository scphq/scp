---
"@scp-dev/broker": patch
"@scp-dev/core": patch
"@scp-dev/hub": patch
"@scp-dev/spec": patch
"scp-relay": patch
---

A bridge's full mirror leaves out historic agents that are offline, not revivable and carry no wake, so a broker with thousands of old rows links under a hub's endpoint cap; it still sends the parents of the rows it keeps, and once more a left-out row the hub may show reachable, so the hub marks it offline. A historic agent that comes back is mirrored at its next change. A hub's endpoint cap refusal names the cap and the count the claim or mirror would reach, and points at the `endpoints` key of `SCP_LIMITS`. The spec says how long retention keeps a child that sent a message (until the message expires) and a root (until handle reuse).
