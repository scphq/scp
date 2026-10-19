# @scp-dev/relay

## 0.3.7

### Patch Changes

- 03447b6: T3 Code harness. Codex and Claude Code sessions that T3 Code runs claim harness `t3code` (from T3 Code's codex originator, or a T3 Code server as the harness's parent) while their hooks keep the provider's output format, and `swarm setup` reports T3 Code, which needs no setup of its own. `swarm t3code [--name N] --thread <id> [--base-dir DIR]` holds an endpoint for one T3 Code thread and wakes it: each batch of relay messages goes to the thread over T3 Code's WebSocket API, starting a turn when it is idle or steering the active run, retried every 2 s. It advertises the new wake value `t3code`, finds the server and a token by itself, and refuses to start without a server, a token or the thread. The relay overview draws the T3 Code mark.
- Updated dependencies [03447b6]
  - @scp-dev/core@0.6.0
  - @scp-dev/hub@0.7.1

## 0.3.6

### Patch Changes

- Updated dependencies [7600fb6]
  - @scp-dev/core@0.5.0
  - @scp-dev/hub@0.7.0

## 0.3.5

### Patch Changes

- Updated dependencies [4fbdc8f]
- Updated dependencies [53c05c3]
  - @scp-dev/core@0.4.0
  - @scp-dev/hub@0.6.3

## 0.3.4

### Patch Changes

- Updated dependencies [b8d27cf]
  - @scp-dev/core@0.3.1
  - @scp-dev/hub@0.6.2

## 0.3.3

### Patch Changes

- Updated dependencies [22e3409]
- Updated dependencies [e17aac8]
  - @scp-dev/core@0.3.0
  - @scp-dev/hub@0.6.1

## 0.3.2

### Patch Changes

- b571297: A session can be linked under a parent on another machine of the same account: `swarm join --under me/<machine>/<handle>` from the session, or `swarm adopt <child> --parent me/<machine>/<handle>` by the human at its terminal. The child stays a root of its own machine and records the parent as a remote address that its bridge mirrors, so every machine and the hub show it as the parent's child, and the dashboard graph and Sessions tree draw it under the parent with its machine tag. The parent and the child reach each other both ways through the hub, a link that would close a cycle is refused, and `swarm unlink` clears it.
- Updated dependencies [b571297]
- Updated dependencies [d1570ab]
  - @scp-dev/core@0.2.0
  - @scp-dev/hub@0.6.0

## 0.3.1

### Patch Changes

- Updated dependencies [100a961]
- Updated dependencies [100a961]
  - @scp-dev/core@0.1.6
  - @scp-dev/hub@0.5.1

## 0.3.0

### Minor Changes

- d406fa4: The relay dashboard gets one tab bar per org: Overview (live counts, what agents are doing now, held judge messages and a fleet strip), Activity, Sessions, Graph, Tokens and devices (now with the hub's machines) and Members. Each tab has its own URL, and older paths redirect. The organizations list counts devices and live agents with their harness marks and moves the create form to its own tab. Every page except sign-in uses the wide layout. The full-window graph moves to `/orgs/<handle>/graph/full`.

### Patch Changes

- Updated dependencies [868ec53]
- Updated dependencies [0a511fc]
  - @scp-dev/hub@0.5.0
  - @scp-dev/core@0.1.5

## 0.2.0

### Minor Changes

- 5be17ee: The relay dashboard's graph streams live: a member's same-origin event socket carries presence, endpoint changes and message metadata (never a body), so a message pulses along its edge as it is sent. A full-window view at `/orgs/<handle>/graph` suits a big screen. The layout settles once and holds still, machines are soft regions joined through the hub, and harnesses show their own marks. The hub gains a `dashboard` hook and `dashboardEvent`.

### Patch Changes

- Updated dependencies [5be17ee]
  - @scp-dev/hub@0.4.0

## 0.1.2

### Patch Changes

- 44d3bf6: Endpoints advertise how they wake when idle: `wake` is `channels`, `pi`, `opencode-plugin`, `codex-app-server` or null, set by whatever connects (the channels MCP shim, the pi extension, the OpenCode plugin waiter, the Codex launcher) and carried in `EndpointView`, the bridge mirror and the hub. `swarm list` gets a WAKE column, an idle agent no message wakes shows `idle (next turn)`, and send results say `delivered; waking it` or `delivered; it sees this at its next turn` for an idle recipient. Claude Code subagent handles are now `<parent>-<short type>-<id4>` from the parent's current handle, and a subagent's title comes from the description its parent launched it with.
- Updated dependencies [44d3bf6]
  - @scp-dev/core@0.1.4
  - @scp-dev/hub@0.3.1

## 0.1.1

### Patch Changes

- Updated dependencies [4422a53]
- Updated dependencies [171958d]
  - @scp-dev/core@0.1.3
  - @scp-dev/hub@0.3.0

## 0.1.0

### Minor Changes

- 8c6a142: The hub's `graph()` returns listed endpoints, spawn edges and per sender and recipient message counts over a recent window, with no message bodies. The relay dashboard draws it as a live graph of machines, agents and their links next to the table.

### Patch Changes

- 98a26dd: An endpoint whose harness process exited without a session end goes offline at the broker's next list, claim or presence check instead of after the hook idle window, so other machines stop seeing it live and its handle can be claimed again. A swarm command whose stdout is a socket, as Node hands a child, no longer ends it on exit, so the shell that ran it keeps writing instead of dying of SIGPIPE. The hosted relay revalidates a credential by its table rather than its id prefix. A member's current credential releases an offline machine that an older token of theirs bound. A `machine` label that names the hostname names the configured machine instead.
- Updated dependencies [ebd50b6]
- Updated dependencies [98a26dd]
- Updated dependencies [451b2db]
- Updated dependencies [8c6a142]
- Updated dependencies [03eafb4]
  - @scp-dev/core@0.1.2
  - @scp-dev/hub@0.2.0

## 0.0.1

### Patch Changes

- Updated dependencies [f83cab6]
  - @scp-dev/core@0.1.1
  - @scp-dev/hub@0.1.1
