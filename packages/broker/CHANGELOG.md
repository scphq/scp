# @scp-dev/broker

## 0.4.0

### Minor Changes

- e17aac8: Linking fixes. `swarm codex` honours a spawn-env grant (`env $(swarm spawn-env ...) swarm codex`): its MCP shim and channel spend the grant, so the session binds under the grant's parent with its title instead of coming up as a root. `swarm join` and other self-authenticating commands work from codex's sandboxed shell: the codex sandbox markers are recognised, and when the sandbox hides the harness process the CLI falls back to the binding the session's MCP shim records. An agent can now ask to adopt a root session: `swarm adopt <child>` from the agent's shell sends the child a link request, which the child accepts with `swarm link accept <id>`, the `relay_link_accept` tool or its own `swarm join --under`. The human at a terminal can adopt under a live parent with `--parent` even when the terminal inherited that parent's `$SCP_NAME`.

### Patch Changes

- Updated dependencies [22e3409]
- Updated dependencies [e17aac8]
  - @scp-dev/core@0.3.0
  - @scp-dev/hub@0.6.1

## 0.3.0

### Minor Changes

- b571297: A session can be linked under a parent on another machine of the same account: `swarm join --under me/<machine>/<handle>` from the session, or `swarm adopt <child> --parent me/<machine>/<handle>` by the human at its terminal. The child stays a root of its own machine and records the parent as a remote address that its bridge mirrors, so every machine and the hub show it as the parent's child, and the dashboard graph and Sessions tree draw it under the parent with its machine tag. The parent and the child reach each other both ways through the hub, a link that would close a cycle is refused, and `swarm unlink` clears it.

### Patch Changes

- d1570ab: An ended session no longer advertises its wake: a hook's session_end, an exited harness process, a closed waker past its grace and a takeover clear it, while a live waker still keeps it, and the OpenCode waiter of a session that left sets none. A leftover mesh.json loads the mesh only when it is enabled, and a CLI without the mesh module warns and runs without it.
- Updated dependencies [b571297]
- Updated dependencies [d1570ab]
  - @scp-dev/core@0.2.0
  - @scp-dev/hub@0.6.0

## 0.2.1

### Patch Changes

- 100a961: Ambient pi swarms come up and stay clean. A broker whose state directory was wiped or whose socket another broker took over stops, so its shims reconnect to the live one. A pi session starts its shim only once the previous one exited and reports a shim that could not claim the endpoint, and a shim exits once its harness is gone. A named relaunch, or a session its harness restarted in process, takes back its own endpoint instead of minting a `-2`. A broker linked again under a new machine name relabels its endpoints, and bridges drop the rows of released machines and of their own former name. `swarm --version` reads the installed package.json, and a closed stdout pipe ends a command quietly.
- 100a961: A wakeable endpoint whose waker lives shows `idle`, never `offline`: the connection that set its wake (the MCP shim, the pi extension, the OpenCode plugin's waiter, the Codex launcher) counts as its waker until it closes or sets `none`, a hook waker for `LIMITS.restartGraceS` more while its harness starts the next one. `list` keeps such endpoints without `--all`, and the broker reports the waker's leaving like other presence changes. The hub and other machines show a live mirrored row with the presence its machine sent, not one its `last_seen` decays to.
- Updated dependencies [100a961]
- Updated dependencies [100a961]
  - @scp-dev/core@0.1.6
  - @scp-dev/hub@0.5.1

## 0.2.0

### Minor Changes

- 868ec53: Same-machine traffic shows on the dashboard. A linked broker reports metadata of deliveries between its own endpoints to the hub in batched `local_events` notifications: sender and recipient handles, kind, time and hashed message and thread ids, never a body, note, label or title. The hub counts them in the graph's message edges and streams them to watchers and the dashboard as `message` events marked `local`. `mirror_local: false` in `cloud.json` turns it off.

### Patch Changes

- Updated dependencies [868ec53]
- Updated dependencies [0a511fc]
  - @scp-dev/hub@0.5.0
  - @scp-dev/core@0.1.5

## 0.1.6

### Patch Changes

- Updated dependencies [5be17ee]
  - @scp-dev/hub@0.4.0

## 0.1.5

### Patch Changes

- 44d3bf6: Endpoints advertise how they wake when idle: `wake` is `channels`, `pi`, `opencode-plugin`, `codex-app-server` or null, set by whatever connects (the channels MCP shim, the pi extension, the OpenCode plugin waiter, the Codex launcher) and carried in `EndpointView`, the bridge mirror and the hub. `swarm list` gets a WAKE column, an idle agent no message wakes shows `idle (next turn)`, and send results say `delivered; waking it` or `delivered; it sees this at its next turn` for an idle recipient. Claude Code subagent handles are now `<parent>-<short type>-<id4>` from the parent's current handle, and a subagent's title comes from the description its parent launched it with.
- Updated dependencies [44d3bf6]
  - @scp-dev/core@0.1.4
  - @scp-dev/hub@0.3.1

## 0.1.4

### Patch Changes

- 4422a53: A session started by hand can sit under an orchestrator: `swarm join --under <parent>` (MCP `relay_join` with `under`) links the session itself under an agent it may message, taking on a spawned worker's place and scope; `swarm adopt <child> [--parent <p>]` links any local root agent and its subtree, for the human at a terminal (an agent without one is refused); `swarm unlink [<child>]` puts it back at the root, for the human unless the policy sets `defaults.unlink: "self"`. Cycles are refused, both are audited as `adopt` and `unlink`, a linked session's later claims take it back where it sits, and the bridge resyncs so the hub, the other machines, `swarm list --tree`, the dashboard tree and the graph show the new parent.
- 171958d: The hub can judge its own account's sends between machines before delivery: `RelayHub.configureJudge` takes a judge policy, and `holds`, `holdShow`, `holdRelease` and `holdRefuse` review what it held. Without a policy the hub holds no judge and its send paths are unchanged. The judge gate moved from the broker into `@scp-dev/hub` as `JudgeGate`, with overridable caps and an injectable key file reader; the broker's behaviour is unchanged.
- Updated dependencies [4422a53]
- Updated dependencies [171958d]
  - @scp-dev/core@0.1.3
  - @scp-dev/hub@0.3.0

## 0.1.3

### Patch Changes

- ebd50b6: Sessions join the relay on demand: `swarm join [<handle>]` (MCP `relay_join`) puts the session that runs the shell on the relay, hooked or not, and names it once; `swarm name <handle>` renames a root session in place, keeping its id, mail, threads and relations, refusing a handle another endpoint holds (a spawned worker only with the policy's `defaults.rename: "self"`), and the hub renames its mirror in place; `swarm leave` (MCP `relay_leave`) takes it offline with its mail kept. `swarm setup --join manual` keeps hooked sessions off the relay until they join; `auto` stays the default. A send to an agent no live session holds says `queued: no live session holds <addr>`, and `--live` (MCP `live: true`) refuses it with `not_live` instead of queueing; `swarm list` shows live endpoints by default and offline ones with `--all`. `swarm claude` without `--name` asks the session to pick its own name with `swarm name`.
- 98a26dd: An endpoint whose harness process exited without a session end goes offline at the broker's next list, claim or presence check instead of after the hook idle window, so other machines stop seeing it live and its handle can be claimed again. A swarm command whose stdout is a socket, as Node hands a child, no longer ends it on exit, so the shell that ran it keeps writing instead of dying of SIGPIPE. The hosted relay revalidates a credential by its table rather than its id prefix. A member's current credential releases an offline machine that an older token of theirs bound. A `machine` label that names the hostname names the configured machine instead.
- 451b2db: Idle OpenCode sessions wake on new messages. The OpenCode plugin keeps one `swarm hook opencode --wake 50` waiting while no session of the process runs a turn, and submits what it prints as a new prompt; a starting turn stops the waiter, and printed messages are confirmed so turn-boundary injection never shows them again. `SCP_WAKE=0` turns it off. `inject` takes `wait_s` to wait for a delivery to offer.
- 03eafb4: Hooks infer a title for an untitled session from the harness's own name for it or its first prompt, and never over an explicit one, and remind it every `SCP_TLDR_EVERY` prompts (default 10) to refresh its now line. Another org member's machines render as `<org>/<machine>/<handle>`, your own as `me/<machine>/<handle>`; both forms and `local/<handle>` are accepted as input.
- Updated dependencies [ebd50b6]
- Updated dependencies [98a26dd]
- Updated dependencies [451b2db]
- Updated dependencies [8c6a142]
- Updated dependencies [03eafb4]
  - @scp-dev/core@0.1.2
  - @scp-dev/hub@0.2.0

## 0.1.2

### Patch Changes

- f84dc9b: A bridge the hub revoked or replaced links again after `swarm login`, `swarm cloud enable` or `swarm up`, through the new `bridge_relink` call; a broker started before its cloud config existed restarts to pick it up. `swarm daemon stop` and `swarm daemon restart` stop or replace the running broker.

## 0.1.1

### Patch Changes

- f83cab6: First release through the CI release workflow, with provenance.
- Updated dependencies [f83cab6]
  - @scp-dev/core@0.1.1
  - @scp-dev/hub@0.1.1
