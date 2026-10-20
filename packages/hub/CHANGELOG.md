# @scp-dev/hub

## 0.8.1

### Patch Changes

- 906bb6c: A machine waker hold that ends (its `declineHoldS` expiry at the alarm, or `RelayHub.clearWakeHold`) now wakes the machine once for mail already queued for its hibernated endpoints, under the same debounce, waking state and caps as a delivery; another account's mail only with cross-account wakes on.

## 0.8.0

### Minor Changes

- bce21aa: Machine waker: a `wake` option on `RelayHub` (`HUB_WAKE` defaults). `crossAccount` (off by default) lets a contact's message from another account wake a hibernated endpoint once every cross-account check passed, within per-hour caps per sender account and per target endpoint. An accepted wake shows the row `waking: true` in views, the graph and presence events until its claim mirrors in, or falls back to hibernated after `wakingTimeoutS`. The debounce, backoff and a decline's hold time are configurable, `clearWakeHold(machine?)` clears a hold, and the hold, debounce and backoff now live in the hub's storage, so a restarted hub keeps them. `EndpointView` gains the optional `waking` field.

### Patch Changes

- Updated dependencies [bce21aa]
  - @scp-dev/core@0.8.0

## 0.7.3

### Patch Changes

- Updated dependencies [a4ebb80]
- Updated dependencies [b866b51]
  - @scp-dev/core@0.7.1

## 0.7.2

### Patch Changes

- Updated dependencies [adff5e5]
- Updated dependencies [adff5e5]
  - @scp-dev/core@0.7.0

## 0.7.1

### Patch Changes

- Updated dependencies [03447b6]
  - @scp-dev/core@0.6.0

## 0.7.0

### Minor Changes

- 7600fb6: Wake hooks for hibernated sessions and remote spawn runners. A provider marks a session hibernated with `swarm hibernate --wake <provider> --ref <ref>`: it shows as `hibernated` (wakeable, never offline), and a delivery to it runs the provider's configured waker, which brings the session back to reclaim its endpoint and drain its queue. A machine whose bridge is down can register a signed wake webhook with `swarm machine wake-url`. `swarm spawn --via <runner>` hands the spawn to a configured runner that starts the session on another machine, where it shows under its parent through a cross-machine link and hands back to it.

### Patch Changes

- Updated dependencies [7600fb6]
  - @scp-dev/core@0.5.0

## 0.6.3

### Patch Changes

- Updated dependencies [4fbdc8f]
- Updated dependencies [53c05c3]
  - @scp-dev/core@0.4.0

## 0.6.2

### Patch Changes

- Updated dependencies [b8d27cf]
  - @scp-dev/core@0.3.1

## 0.6.1

### Patch Changes

- Updated dependencies [22e3409]
- Updated dependencies [e17aac8]
  - @scp-dev/core@0.3.0

## 0.6.0

### Minor Changes

- b571297: A session can be linked under a parent on another machine of the same account: `swarm join --under me/<machine>/<handle>` from the session, or `swarm adopt <child> --parent me/<machine>/<handle>` by the human at its terminal. The child stays a root of its own machine and records the parent as a remote address that its bridge mirrors, so every machine and the hub show it as the parent's child, and the dashboard graph and Sessions tree draw it under the parent with its machine tag. The parent and the child reach each other both ways through the hub, a link that would close a cycle is refused, and `swarm unlink` clears it.

### Patch Changes

- Updated dependencies [b571297]
- Updated dependencies [d1570ab]
  - @scp-dev/core@0.2.0

## 0.5.1

### Patch Changes

- 100a961: Ambient pi swarms come up and stay clean. A broker whose state directory was wiped or whose socket another broker took over stops, so its shims reconnect to the live one. A pi session starts its shim only once the previous one exited and reports a shim that could not claim the endpoint, and a shim exits once its harness is gone. A named relaunch, or a session its harness restarted in process, takes back its own endpoint instead of minting a `-2`. A broker linked again under a new machine name relabels its endpoints, and bridges drop the rows of released machines and of their own former name. `swarm --version` reads the installed package.json, and a closed stdout pipe ends a command quietly.
- 100a961: A wakeable endpoint whose waker lives shows `idle`, never `offline`: the connection that set its wake (the MCP shim, the pi extension, the OpenCode plugin's waiter, the Codex launcher) counts as its waker until it closes or sets `none`, a hook waker for `LIMITS.restartGraceS` more while its harness starts the next one. `list` keeps such endpoints without `--all`, and the broker reports the waker's leaving like other presence changes. The hub and other machines show a live mirrored row with the presence its machine sent, not one its `last_seen` decays to.
- Updated dependencies [100a961]
- Updated dependencies [100a961]
  - @scp-dev/core@0.1.6

## 0.5.0

### Minor Changes

- 868ec53: Same-machine traffic shows on the dashboard. A linked broker reports metadata of deliveries between its own endpoints to the hub in batched `local_events` notifications: sender and recipient handles, kind, time and hashed message and thread ids, never a body, note, label or title. The hub counts them in the graph's message edges and streams them to watchers and the dashboard as `message` events marked `local`. `mirror_local: false` in `cloud.json` turns it off.

### Patch Changes

- 0a511fc: A claim that names no harness takes it from the harness process it runs under: `--as` commands, the MCP shim, hooks and `swarm join` infer it from the shell's process walk (claude, codex, opencode, pi, muse, agy, grok, gemini) or the harness's environment before falling back to `cli`, `hook` or `mcp`. Those generic harnesses never replace a known one, and a row created with one heals to the harness of its next claim. Claude Code hook text now fits Claude Code's caps (8000 characters and 200 lines of context, 2000 and 20 of a stop reason): bodies that would be cut end in `[truncated, N more chars: swarm show <id>]`, and the new `swarm show <id>` prints a delivered message whole. A hook shows up to 7168 bytes of wrapped messages at once (was 4096). `swarm up` ends with the wake-enabled launch of each installed harness.
- Updated dependencies [0a511fc]
  - @scp-dev/core@0.1.5

## 0.4.0

### Minor Changes

- 5be17ee: The relay dashboard's graph streams live: a member's same-origin event socket carries presence, endpoint changes and message metadata (never a body), so a message pulses along its edge as it is sent. A full-window view at `/orgs/<handle>/graph` suits a big screen. The layout settles once and holds still, machines are soft regions joined through the hub, and harnesses show their own marks. The hub gains a `dashboard` hook and `dashboardEvent`.

## 0.3.1

### Patch Changes

- 44d3bf6: Endpoints advertise how they wake when idle: `wake` is `channels`, `pi`, `opencode-plugin`, `codex-app-server` or null, set by whatever connects (the channels MCP shim, the pi extension, the OpenCode plugin waiter, the Codex launcher) and carried in `EndpointView`, the bridge mirror and the hub. `swarm list` gets a WAKE column, an idle agent no message wakes shows `idle (next turn)`, and send results say `delivered; waking it` or `delivered; it sees this at its next turn` for an idle recipient. Claude Code subagent handles are now `<parent>-<short type>-<id4>` from the parent's current handle, and a subagent's title comes from the description its parent launched it with.
- Updated dependencies [44d3bf6]
  - @scp-dev/core@0.1.4

## 0.3.0

### Minor Changes

- 171958d: The hub can judge its own account's sends between machines before delivery: `RelayHub.configureJudge` takes a judge policy, and `holds`, `holdShow`, `holdRelease` and `holdRefuse` review what it held. Without a policy the hub holds no judge and its send paths are unchanged. The judge gate moved from the broker into `@scp-dev/hub` as `JudgeGate`, with overridable caps and an injectable key file reader; the broker's behaviour is unchanged.

### Patch Changes

- 4422a53: A session started by hand can sit under an orchestrator: `swarm join --under <parent>` (MCP `relay_join` with `under`) links the session itself under an agent it may message, taking on a spawned worker's place and scope; `swarm adopt <child> [--parent <p>]` links any local root agent and its subtree, for the human at a terminal (an agent without one is refused); `swarm unlink [<child>]` puts it back at the root, for the human unless the policy sets `defaults.unlink: "self"`. Cycles are refused, both are audited as `adopt` and `unlink`, a linked session's later claims take it back where it sits, and the bridge resyncs so the hub, the other machines, `swarm list --tree`, the dashboard tree and the graph show the new parent.
- Updated dependencies [4422a53]
  - @scp-dev/core@0.1.3

## 0.2.0

### Minor Changes

- 8c6a142: The hub's `graph()` returns listed endpoints, spawn edges and per sender and recipient message counts over a recent window, with no message bodies. The relay dashboard draws it as a live graph of machines, agents and their links next to the table.

### Patch Changes

- ebd50b6: Sessions join the relay on demand: `swarm join [<handle>]` (MCP `relay_join`) puts the session that runs the shell on the relay, hooked or not, and names it once; `swarm name <handle>` renames a root session in place, keeping its id, mail, threads and relations, refusing a handle another endpoint holds (a spawned worker only with the policy's `defaults.rename: "self"`), and the hub renames its mirror in place; `swarm leave` (MCP `relay_leave`) takes it offline with its mail kept. `swarm setup --join manual` keeps hooked sessions off the relay until they join; `auto` stays the default. A send to an agent no live session holds says `queued: no live session holds <addr>`, and `--live` (MCP `live: true`) refuses it with `not_live` instead of queueing; `swarm list` shows live endpoints by default and offline ones with `--all`. `swarm claude` without `--name` asks the session to pick its own name with `swarm name`.
- 98a26dd: An endpoint whose harness process exited without a session end goes offline at the broker's next list, claim or presence check instead of after the hook idle window, so other machines stop seeing it live and its handle can be claimed again. A swarm command whose stdout is a socket, as Node hands a child, no longer ends it on exit, so the shell that ran it keeps writing instead of dying of SIGPIPE. The hosted relay revalidates a credential by its table rather than its id prefix. A member's current credential releases an offline machine that an older token of theirs bound. A `machine` label that names the hostname names the configured machine instead.
- 03eafb4: Hooks infer a title for an untitled session from the harness's own name for it or its first prompt, and never over an explicit one, and remind it every `SCP_TLDR_EVERY` prompts (default 10) to refresh its now line. Another org member's machines render as `<org>/<machine>/<handle>`, your own as `me/<machine>/<handle>`; both forms and `local/<handle>` are accepted as input.
- Updated dependencies [ebd50b6]
- Updated dependencies [98a26dd]
- Updated dependencies [451b2db]
- Updated dependencies [03eafb4]
  - @scp-dev/core@0.1.2

## 0.1.1

### Patch Changes

- f83cab6: First release through the CI release workflow, with provenance.
- Updated dependencies [f83cab6]
  - @scp-dev/core@0.1.1
