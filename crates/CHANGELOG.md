# scp-relay

## 0.4.9

### Patch Changes

- 1ef6cc9: The native broker serves the hook RPC: it renders every harness's hooks (Claude Code, Codex, Grok, agy, OpenCode, Muse) itself, so a native `swarm hook` or `scp-hook` no longer starts Node for each hook, and a bare `swarm hook` works against a native broker. The native broker also answers `agents`, the local agents' facts `swarm relink --check` and `swarm claude ls` read, for the human only. The `agents` result schema lists `unread_at`, which brokers already send.
- 448fc2a: `SCP_NATIVE=mcp` runs only the MCP server natively and keeps the TypeScript broker: `swarm setup`, `swarm claude --bg`, `swarm codex` and codex spawns and wakes mount the native `swarm mcp` directly, as under `SCP_NATIVE=1`, but the mounts carry `SCP_NATIVE=mcp`, so a native server that finds no broker starts the TypeScript one through the CLI, and every broker any session or hook starts stays TypeScript. Under `SCP_NATIVE=mcp` the native `swarm daemon` refuses to run, and mounts kept as saved have a saved `SCP_NATIVE=1` replaced with `mcp`. `SCP_NATIVE=1` still runs both natively. `swarm status` names each harness mount's MCP engine and mode next to the broker engine (`mcp` in `--json`), and warns when the broker is native while a mount asks for the TypeScript one.

## 0.4.8

### Patch Changes

- 93f45ee: A removed Claude Code background worker woken by a message keeps its endpoint. The waker sets the resumed session as `SCP_HARNESS_ORIGIN` in the session file it resumes with. A ticketed claim now lets go of the auto-named endpoint the session's hooks registered first, so no `claude-<dir>-<n>` endpoint is left beside the woken worker. When Claude Code brings the session back under a new id, the waker links the new short id to the worker's session file and records the new session id. The policy then stops the worker again, and its next wake resumes the new session.

## 0.4.7

### Patch Changes

- f2da524: A Claude Code background session resumed with `swarm claude --bg -- --resume <session id>` keeps its endpoint when Claude Code resumes it under a new session id. The launcher puts the resumed session in the scp mount as `SCP_HARNESS_ORIGIN`, so the shim's claim carries it as `harness_origin`. A connecting claim whose hooks already registered an auto-named endpoint now takes back the endpoint that its harness session or origin owns at the name it asks for, including one the claude-bg policy hibernated when it stopped the worker. Before, such a resume was refused with `grant used` on every retry. The session then lived only on its hooks' default `claude-<dir>-<n>` root, which the policy never hibernates, so nothing could wake it.

## 0.4.6

### Patch Changes

- eb2a72b: `SCP_NATIVE=1` mounts the native `swarm mcp` directly: `swarm setup`, `swarm claude --bg`, `swarm codex` and codex spawns and wakes run the native binary with no Node process resident per session, falling back to the Node mount with a note. `swarm mcp` prefers the native `swarm` (`SCP_MCP_BIN` still overrides), and the native `swarm mcp` starts the native broker itself.

## 0.4.5

### Patch Changes

- 4860318: Native MCP server: the Rust `scp-mcp` crate serves `swarm mcp` with the same tools, instructions, identity and channel push, opt-in under `SCP_NATIVE=1`.
- 704e6f2: `SCP_NATIVE=1` runs the native `swarm` broker for `swarm daemon` and on-demand starts, falling back to the TypeScript broker with a note, and `swarm status` names the broker engine.
- 2038a9c: An endpoint's name, mail and title never pass to an unrelated session. A claim takes over a released endpoint of another harness session only at a handle it was given (never a derived default it walked to), with the grant that endpoint spent, or from the harness process that holds it; the CLI marks its default handles with the new claim field `derived`. A session whose shim takes back its own name after its hooks claimed a default one is no longer moved back onto that default. `swarm relink --check` lists each endpoint at a background session's name, or moved off it, that another session now holds, and changes nothing.

## 0.4.4

### Patch Changes

- fd9003e: Native broker: hub bridge (auth, endpoint mirroring, cross-machine sends, wakes and reconnect) and cross-machine links.
- 14be1c9: Native broker: wake hooks, hibernation and revive tickets, spawn holds and durable spawns, peek, and the periodic retention sweep.
- 10c5e99: The native broker delivers messages: send and ask with receipts, inbox, injection and stop push, spawn results, hook RPCs, per-viewer watch streams and rate limits, on the shared scp-core protocol types.
- 56d8391: The native broker enforces scopes, groups, grants, policy and the judge gate, and filters list, log, peers and snapshots by visibility. It no longer needs an opt-in flag to start.

## 0.4.3

### Patch Changes

- 4989901: The spec now states what proves an identity for `--as`: the endpoint's own harness instance nearest on the caller's walk, the grant it spent, its resume token, or a restart in place from its parent's shells. Descent never does, so a worker's shell naming its parent, a sibling or any other live agent is refused `unauthorized`, and a background hand-off or rehome never moves an endpoint to a session below it, nor to a fork whose claim asks to sit under its origin. The native broker now refuses a `send` that names `from` or another relay-set field, as the TypeScript broker already did.

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
