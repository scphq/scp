# @scp-dev/mcp

## 0.5.14

### Patch Changes

- Updated dependencies [f092412]
  - @scp-dev/core@0.18.5
  - @scp-dev/broker@0.13.5

## 0.5.13

### Patch Changes

- Updated dependencies [4989901]
  - @scp-dev/core@0.18.4
  - @scp-dev/broker@0.13.4

## 0.5.12

### Patch Changes

- f05c1a3: A session started with `--under` an agent on another machine, including a background session a harness daemon hosts, now links even when the claim lands before the hub link is up or before the parent's machine mirrored it: a refused link stays pending on the endpoint and the broker tries it again each time it applies other machines' endpoints. A root may link under a worker of another tree when it may message that tree's root, the worker's inbound rules admit it and the policy does not refuse it. A refusal is no longer silent: the broker logs it, `whoami` (and `relay_whoami`, `swarm whoami`) shows `link_pending` with the reason, and a launcher whose broker is not linked to the hub yet warns. The hub bridge logs when it links and unlinks.
- Updated dependencies [f05c1a3]
  - @scp-dev/broker@0.13.3
  - @scp-dev/core@0.18.3

## 0.5.11

### Patch Changes

- Updated dependencies [898fd9e]
  - @scp-dev/broker@0.13.2
  - @scp-dev/core@0.18.2

## 0.5.10

### Patch Changes

- 5c998c2: The broker stays responsive under heavy load: indexed audit lookups, a primary-key wake check instead of a per-pass endpoint scan, refused-claim retries that back off instead of flooding, a one-day retention for refusal noise, a larger SQLite cache, and no synchronous `ps` on the main loop.
- Updated dependencies [5c998c2]
  - @scp-dev/core@0.18.1
  - @scp-dev/broker@0.13.1

## 0.5.9

### Patch Changes

- fa0fd3c: The server instructions say messages reach an agent by themselves, at its next turn or by a wake, so it should never poll `relay_inbox` or `swarm inbox` in a loop but end its turn; `wait_s` is for one short wait.
- Updated dependencies [f65ee3e]
  - @scp-dev/core@0.18.0
  - @scp-dev/broker@0.13.0

## 0.5.8

### Patch Changes

- Updated dependencies [673d1be]
- Updated dependencies [4f8d617]
  - @scp-dev/broker@0.12.1
  - @scp-dev/core@0.17.1

## 0.5.7

### Patch Changes

- Updated dependencies [5bec4a0]
  - @scp-dev/core@0.17.0
  - @scp-dev/broker@0.12.0

## 0.5.6

### Patch Changes

- @scp-dev/broker@0.11.3

## 0.5.5

### Patch Changes

- Updated dependencies [a2c4406]
- Updated dependencies [075a127]
  - @scp-dev/core@0.16.0
  - @scp-dev/broker@0.11.2

## 0.5.4

### Patch Changes

- Updated dependencies [6adf46a]
  - @scp-dev/core@0.15.0
  - @scp-dev/broker@0.11.1

## 0.5.3

### Patch Changes

- Updated dependencies [1538046]
- Updated dependencies [b43ec2c]
  - @scp-dev/core@0.14.0
  - @scp-dev/broker@0.11.0

## 0.5.2

### Patch Changes

- Updated dependencies [968c1d2]
  - @scp-dev/core@0.13.1
  - @scp-dev/broker@0.10.1

## 0.5.1

### Patch Changes

- Updated dependencies [770d3ec]
  - @scp-dev/core@0.13.0
  - @scp-dev/broker@0.10.0

## 0.5.0

### Minor Changes

- 936f194: A hibernation whose ref is a revive record (harness, session, cwd, argv, via) makes the endpoint revivable: its view shows `revivable: true`, each waker run gets a one-time wake ticket, and the resumed session's claim with that ticket takes the same endpoint back with its mail, place, title and groups. A revivable endpoint is never renamed out of its handle or deleted while it sleeps. Durable spawns are revivable as they are, and the `claude-bg` waker now hibernates stopped and removed Claude Code background workers with a revive record, writes the ticket into the session's MCP config before `claude respawn` or `claude --bg --resume`, declines sessions `swarm claude --bg` did not start and declines `gone` when the transcript is gone. `swarm mcp` claims with `$SCP_WAKE_TICKET` and falls back to a plain claim when the ticket is spent.

### Patch Changes

- Updated dependencies [936f194]
- Updated dependencies [88edeea]
  - @scp-dev/broker@0.9.0
  - @scp-dev/core@0.12.0

## 0.4.0

### Minor Changes

- 7692493: Historic agents: an agent with no activity (a call, a hook, a read or a message to it) for `LIMITS.historicAfterS` (3600 s, `Infinity` disables it) is historic. `list`, `peers` and `snapshot` leave it out unless `all` or `historic` is set, views carry `active_at` and `historic: true`, and mail, wake and reach are unchanged. Endpoints gain a `mail_at` column. The hub derives the flag from mirrored `active_at` and the traffic it sees, filters its `list`, and serves `/v1/dashboard/overview` and `/v1/dashboard/graph` without historic agents unless `historic=1`. `relay_list` and `relay_peers` take `historic`, and `swarm list` and `swarm peers` show them with `--all` and count what they hide. SPEC section 11.4 describes it.

### Patch Changes

- Updated dependencies [7692493]
- Updated dependencies [7692493]
- Updated dependencies [6448ba2]
  - @scp-dev/core@0.11.0
  - @scp-dev/broker@0.8.0

## 0.3.8

### Patch Changes

- Updated dependencies [14ea99a]
- Updated dependencies [14ea99a]
  - @scp-dev/core@0.10.1
  - @scp-dev/broker@0.7.3

## 0.3.7

### Patch Changes

- 6881d37: The MCP tool definitions and their result rendering live in `@scp-dev/core` (`TOOLS`, `MCP_PROTOCOLS` and the helpers), with `REMOTE_TOOLS`, the surface the remote MCP endpoint serves; the stdio MCP server uses them from there.
- Updated dependencies [6881d37]
  - @scp-dev/core@0.10.0
  - @scp-dev/broker@0.7.2

## 0.3.6

### Patch Changes

- e536f39: A Codex desktop or IDE thread is one endpoint: the MCP shim an app server starts per thread claims nothing until a tool call names its thread, then joins the endpoint its hooks claim, and the desktop app is recognised when codex options precede `app-server`. A Codex child thread's hooks claim a subagent under the root thread, and ephemeral forks the app makes claim no endpoint.

  Connecting to a busy or restarting broker is retried with backoff within a budget (3 s for hooks, longer for commands, shims and the codex waker), a running broker that keeps refusing is reported busy instead of sandboxed, a hook that gives up says so in one stderr line, and the broker asks for a larger listen backlog.

- Updated dependencies [e536f39]
  - @scp-dev/broker@0.7.1

## 0.3.5

### Patch Changes

- 12259a0: Build a local Claude Cowork plugin with guarded hooks and MCP, a dedicated harness label and attached-folder handles.
- Updated dependencies [6e8e028]
  - @scp-dev/core@0.9.0
  - @scp-dev/broker@0.7.0

## 0.3.4

### Patch Changes

- @scp-dev/broker@0.6.4

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
