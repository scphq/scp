# scp-relay

## 0.4.2

### Patch Changes

- 898fd9e: A Claude Code session sent to the background from its terminal keeps its name, children, grants, groups, title and unread mail. Its background process claims with the new `harness_handoff` flag, and the broker hands the origin's endpoint over even while the old terminal process still holds it, unless that process is still busy, then closes the old process's connections so it comes back under a fresh name. A fork started from another terminal stays a parallel fork with its own name. `swarm relink --dry-run` lists background sessions stranded by an older CLI next to their idle origin, and `swarm relink --live` applies them.
- 2000742: Native local broker crate with the socket server, SQLite store, identity and claims

## 0.4.1

### Patch Changes

- 87f659b: The relay crates share a new `scp-dev-core` crate for protocol constants, limits parsing, handle and address rules, and scope decisions.

## 0.4.0

### Minor Changes

- f65ee3e: Make the relay loop guards (hopMax, threadMax, ping-pong) configurable and off by default.

## 0.3.1

### Patch Changes

- 673d1be: A bridge's full mirror leaves out historic agents that are offline, not revivable and carry no wake, so a broker with thousands of old rows links under a hub's endpoint cap; it still sends the parents of the rows it keeps, and once more a left-out row it mirrored reachable on this link, so the hub marks it offline. A historic agent that comes back is mirrored at its next change, after any of its parents the link has not mirrored, so the hub places it. A hub's endpoint cap refusal names the cap and the count the claim or mirror would reach, and points at the `endpoints` key of `SCP_LIMITS`. The spec says how long retention keeps a child that sent a message (until the message expires) and a root (until handle reuse).

## 0.3.0

### Minor Changes

- 1538046: Make relay send and contact rates configurable and off by default.

## 0.2.0

### Minor Changes

- 35bc814: The Rust relay hides historic agents, enforces the tree-scoped default reach, and accepts the mcpWaitS limit.
