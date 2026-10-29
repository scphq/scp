# scp-relay

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
