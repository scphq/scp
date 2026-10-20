# @scp-dev/mcp

## 0.3.3

### Patch Changes

- @scp-dev/broker@0.6.3

## 0.3.2

### Patch Changes

- Updated dependencies [bce21aa]
  - @scp-dev/core@0.8.0
  - @scp-dev/broker@0.6.2

## 0.3.1

### Patch Changes

- Updated dependencies [a4ebb80]
- Updated dependencies [b866b51]
  - @scp-dev/core@0.7.1
  - @scp-dev/broker@0.6.1

## 0.3.0

### Minor Changes

- adff5e5: A message to a stopped in-process subagent wakes its root: the root's waker is pushed the message tagged `for` the subagent (framed to continue it by its id), the subagent shows the root's wake and stays idle while that waker lives, and the message stays unread for the subagent without being shown twice. An agent now adopts a local root it may message directly (from its session or its shell), a child under another parent is still asked to consent, and `swarm join --under` in a codex sandbox that blocks the relay socket names `relay_join {under}` and the codex setting instead of a bare socket error; the relay dashboard words hook and spawn wakes.

### Patch Changes

- Updated dependencies [adff5e5]
- Updated dependencies [adff5e5]
  - @scp-dev/core@0.7.0
  - @scp-dev/broker@0.6.0

## 0.2.4

### Patch Changes

- Updated dependencies [03447b6]
  - @scp-dev/core@0.6.0
  - @scp-dev/broker@0.5.1

## 0.2.3

### Patch Changes

- Updated dependencies [7600fb6]
  - @scp-dev/core@0.5.0
  - @scp-dev/broker@0.5.0

## 0.2.2

### Patch Changes

- Updated dependencies [4fbdc8f]
- Updated dependencies [53c05c3]
  - @scp-dev/core@0.4.0
  - @scp-dev/broker@0.4.2

## 0.2.1

### Patch Changes

- Updated dependencies [b8d27cf]
  - @scp-dev/core@0.3.1
  - @scp-dev/broker@0.4.1

## 0.2.0

### Minor Changes

- 22e3409: Messages wake idle Claude Code sessions that run without channels, such as `claude --bg`: the scp MCP server queues each delivery as the next turn on the session's own inbox socket and advertises wake `claude-inbox`.
- e17aac8: Linking fixes. `swarm codex` honours a spawn-env grant (`env $(swarm spawn-env ...) swarm codex`): its MCP shim and channel spend the grant, so the session binds under the grant's parent with its title instead of coming up as a root. `swarm join` and other self-authenticating commands work from codex's sandboxed shell: the codex sandbox markers are recognised, and when the sandbox hides the harness process the CLI falls back to the binding the session's MCP shim records. An agent can now ask to adopt a root session: `swarm adopt <child>` from the agent's shell sends the child a link request, which the child accepts with `swarm link accept <id>`, the `relay_link_accept` tool or its own `swarm join --under`. The human at a terminal can adopt under a live parent with `--parent` even when the terminal inherited that parent's `$SCP_NAME`.

### Patch Changes

- Updated dependencies [22e3409]
- Updated dependencies [e17aac8]
  - @scp-dev/core@0.3.0
  - @scp-dev/broker@0.4.0

## 0.1.9

### Patch Changes

- Updated dependencies [b571297]
- Updated dependencies [d1570ab]
  - @scp-dev/core@0.2.0
  - @scp-dev/broker@0.3.0

## 0.1.8

### Patch Changes

- Updated dependencies [100a961]
- Updated dependencies [100a961]
  - @scp-dev/core@0.1.6
  - @scp-dev/broker@0.2.1

## 0.1.7

### Patch Changes

- Updated dependencies [868ec53]
- Updated dependencies [0a511fc]
  - @scp-dev/broker@0.2.0
  - @scp-dev/core@0.1.5

## 0.1.6

### Patch Changes

- @scp-dev/broker@0.1.6

## 0.1.5

### Patch Changes

- 44d3bf6: Endpoints advertise how they wake when idle: `wake` is `channels`, `pi`, `opencode-plugin`, `codex-app-server` or null, set by whatever connects (the channels MCP shim, the pi extension, the OpenCode plugin waiter, the Codex launcher) and carried in `EndpointView`, the bridge mirror and the hub. `swarm list` gets a WAKE column, an idle agent no message wakes shows `idle (next turn)`, and send results say `delivered; waking it` or `delivered; it sees this at its next turn` for an idle recipient. Claude Code subagent handles are now `<parent>-<short type>-<id4>` from the parent's current handle, and a subagent's title comes from the description its parent launched it with.
- Updated dependencies [44d3bf6]
  - @scp-dev/core@0.1.4
  - @scp-dev/broker@0.1.5

## 0.1.4

### Patch Changes

- 4422a53: A session started by hand can sit under an orchestrator: `swarm join --under <parent>` (MCP `relay_join` with `under`) links the session itself under an agent it may message, taking on a spawned worker's place and scope; `swarm adopt <child> [--parent <p>]` links any local root agent and its subtree, for the human at a terminal (an agent without one is refused); `swarm unlink [<child>]` puts it back at the root, for the human unless the policy sets `defaults.unlink: "self"`. Cycles are refused, both are audited as `adopt` and `unlink`, a linked session's later claims take it back where it sits, and the bridge resyncs so the hub, the other machines, `swarm list --tree`, the dashboard tree and the graph show the new parent.
- Updated dependencies [4422a53]
- Updated dependencies [171958d]
  - @scp-dev/core@0.1.3
  - @scp-dev/broker@0.1.4

## 0.1.3

### Patch Changes

- ebd50b6: Sessions join the relay on demand: `swarm join [<handle>]` (MCP `relay_join`) puts the session that runs the shell on the relay, hooked or not, and names it once; `swarm name <handle>` renames a root session in place, keeping its id, mail, threads and relations, refusing a handle another endpoint holds (a spawned worker only with the policy's `defaults.rename: "self"`), and the hub renames its mirror in place; `swarm leave` (MCP `relay_leave`) takes it offline with its mail kept. `swarm setup --join manual` keeps hooked sessions off the relay until they join; `auto` stays the default. A send to an agent no live session holds says `queued: no live session holds <addr>`, and `--live` (MCP `live: true`) refuses it with `not_live` instead of queueing; `swarm list` shows live endpoints by default and offline ones with `--all`. `swarm claude` without `--name` asks the session to pick its own name with `swarm name`.
- Updated dependencies [ebd50b6]
- Updated dependencies [98a26dd]
- Updated dependencies [451b2db]
- Updated dependencies [03eafb4]
  - @scp-dev/core@0.1.2
  - @scp-dev/broker@0.1.3

## 0.1.2

### Patch Changes

- 7c91739: Idle Claude Code sessions wake on peer messages. `swarm claude [--name N] [claude args...]` starts Claude Code with the scp channel loaded, and `swarm setup`, `swarm up` and `swarm mcp install --harness claude` mount its MCP server with `--channels`. The server pushes only to a client that declares `claude/channel` or that `swarm claude` started, so other sessions keep the hook path. An inbox wait that runs into the 50 s cap says so.
- Updated dependencies [f84dc9b]
  - @scp-dev/broker@0.1.2

## 0.1.1

### Patch Changes

- f83cab6: First release through the CI release workflow, with provenance.
- Updated dependencies [f83cab6]
  - @scp-dev/core@0.1.1
  - @scp-dev/broker@0.1.1
