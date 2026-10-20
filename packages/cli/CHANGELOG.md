# @scp-dev/cli

## 0.11.3

### Patch Changes

- Updated dependencies [bba5dc8]
  - @scp-dev/hub@0.8.2
  - @scp-dev/broker@0.6.4
  - @scp-dev/mcp@0.3.4

## 0.11.2

### Patch Changes

- Updated dependencies [906bb6c]
  - @scp-dev/hub@0.8.1
  - @scp-dev/broker@0.6.3
  - @scp-dev/mcp@0.3.3

## 0.11.1

### Patch Changes

- Updated dependencies [bce21aa]
  - @scp-dev/hub@0.8.0
  - @scp-dev/core@0.8.0
  - @scp-dev/broker@0.6.2
  - @scp-dev/mcp@0.3.2

## 0.11.0

### Minor Changes

- d4c599a: Launchers attribute what they start: `swarm claude` (also `--bg`), `codex`, `muse`, `pi`, `opencode`, `agy`, `grok` and `t3code` run from an agent's shell mint the grant `swarm spawn-env --name N` would mint there, with the agent's own authority, so the new session links under that agent without `env $(swarm spawn-env ...)`. `swarm claude --bg` prints `under me/<agent>`. A grant minted for the session in `$SCP_GRANT` still applies, `--root` starts a root, a resumed session keeps its place, a plain terminal is unchanged, and a failed mint warns and launches unlinked.

### Patch Changes

- b866b51: A stop no longer holds a session that a message wakes anyway (a wake with a live waker, as under `swarm claude`): it shows the worker messages already unread and lets the turn end, and the waker brings the later ones. A held stop now counts a worker only while it or its `swarm spawn` process still runs, comparing the process start time as well as the pid, so a spawn that died before its worker joined, or a worker whose harness and spawn are both gone, no longer keeps it waiting. `swarm setup` gives the Claude Code and Codex stop hooks the status line "waiting for worker messages (swarm)".
- Updated dependencies [a4ebb80]
- Updated dependencies [b866b51]
  - @scp-dev/core@0.7.1
  - @scp-dev/broker@0.6.1
  - @scp-dev/hub@0.7.3
  - @scp-dev/mcp@0.3.1

## 0.10.0

### Minor Changes

- adff5e5: A message to a stopped in-process subagent wakes its root: the root's waker is pushed the message tagged `for` the subagent (framed to continue it by its id), the subagent shows the root's wake and stays idle while that waker lives, and the message stays unread for the subagent without being shown twice. An agent now adopts a local root it may message directly (from its session or its shell), a child under another parent is still asked to consent, and `swarm join --under` in a codex sandbox that blocks the relay socket names `relay_join {under}` and the codex setting instead of a bare socket error; the relay dashboard words hook and spawn wakes.
- adff5e5: Wakeable spawns: a codex exec, agy -p, grok -p or muse exec worker stays held after its run (wake `spawn-resume`), and each message resumes the same harness session and hands the run back as a reply, until `--idle`, `swarm end <worker>` (`spawn_end`) or a signal. `--durable` hibernates the worker instead, also after a crash or broker restart, and the broker's built-in `spawn` waker resumes it on the next message as the same endpoint (a one-time wake ticket), keeping its labels, groups, peek and caps.

### Patch Changes

- Updated dependencies [adff5e5]
- Updated dependencies [adff5e5]
  - @scp-dev/core@0.7.0
  - @scp-dev/broker@0.6.0
  - @scp-dev/mcp@0.3.0
  - @scp-dev/hub@0.7.2

## 0.9.0

### Minor Changes

- 03447b6: T3 Code harness. Codex and Claude Code sessions that T3 Code runs claim harness `t3code` (from T3 Code's codex originator, or a T3 Code server as the harness's parent) while their hooks keep the provider's output format, and `swarm setup` reports T3 Code, which needs no setup of its own. `swarm t3code [--name N] --thread <id> [--base-dir DIR]` holds an endpoint for one T3 Code thread and wakes it: each batch of relay messages goes to the thread over T3 Code's WebSocket API, starting a turn when it is idle or steering the active run, retried every 2 s. It advertises the new wake value `t3code`, finds the server and a token by itself, and refuses to start without a server, a token or the thread. The relay overview draws the T3 Code mark.

### Patch Changes

- Updated dependencies [03447b6]
  - @scp-dev/core@0.6.0
  - @scp-dev/broker@0.5.1
  - @scp-dev/hub@0.7.1
  - @scp-dev/mcp@0.2.4

## 0.8.0

### Minor Changes

- 7600fb6: Wake hooks for hibernated sessions and remote spawn runners. A provider marks a session hibernated with `swarm hibernate --wake <provider> --ref <ref>`: it shows as `hibernated` (wakeable, never offline), and a delivery to it runs the provider's configured waker, which brings the session back to reclaim its endpoint and drain its queue. A machine whose bridge is down can register a signed wake webhook with `swarm machine wake-url`. `swarm spawn --via <runner>` hands the spawn to a configured runner that starts the session on another machine, where it shows under its parent through a cross-machine link and hands back to it.

### Patch Changes

- Updated dependencies [7600fb6]
  - @scp-dev/core@0.5.0
  - @scp-dev/broker@0.5.0
  - @scp-dev/hub@0.7.0
  - @scp-dev/mcp@0.2.3

## 0.7.0

### Minor Changes

- 4fbdc8f: `swarm agy` and `swarm grok` run the harness headless and wake it: the launcher holds the endpoint, and each batch of new messages becomes a turn that resumes the same conversation (`agy --conversation <id> -p`, `grok --resume <id> -p`). grok's session id is preassigned with `-s`; agy's scp hooks report the conversation it opened. The endpoint advertises the new wake values `agy-resume` and `grok-resume`. Interactive flags are refused.
- 53c05c3: `swarm muse [--name N] [--resume S] [--approval-mode never|on-request|untrusted] [-- muse serve args...]` runs a headless Muse session through `muse serve` that relay messages wake: each message starts a turn on the idle session or steers the running one, and the agent's replies print to standard output. It advertises the new wake value `muse-serve`, honours `swarm spawn-env` grants through a launch file the session's shim and hooks read, and fails loudly when the session's scp mount never joins. A prompt made of relay messages no longer becomes the session's inferred title.

### Patch Changes

- Updated dependencies [4fbdc8f]
- Updated dependencies [53c05c3]
  - @scp-dev/core@0.4.0
  - @scp-dev/broker@0.4.2
  - @scp-dev/hub@0.6.3
  - @scp-dev/mcp@0.2.2

## 0.6.0

### Minor Changes

- a064e0f: `swarm claude --bg [--name N]` starts a Claude Code background session that claims its name and the caller's grant through a passed `--mcp-config`, so `env $(swarm spawn-env --name N)` links it under the caller and messages wake it through its inbox; it prints the short id and the address. `swarm claude attach <id|name> [--name N]` attaches, renaming the endpoint first, and `swarm claude --resume <id>` of a live background session attaches to it.

### Patch Changes

- b8d27cf: A resumed Claude Code session takes back its offline endpoint by its harness session id, and `swarm name <handle> --take-over` merges a stranded session onto its old endpoint.
- Updated dependencies [b8d27cf]
  - @scp-dev/core@0.3.1
  - @scp-dev/broker@0.4.1
  - @scp-dev/hub@0.6.2
  - @scp-dev/mcp@0.2.1

## 0.5.0

### Minor Changes

- 22e3409: Messages wake idle Claude Code sessions that run without channels, such as `claude --bg`: the scp MCP server queues each delivery as the next turn on the session's own inbox socket and advertises wake `claude-inbox`.
- e17aac8: Linking fixes. `swarm codex` honours a spawn-env grant (`env $(swarm spawn-env ...) swarm codex`): its MCP shim and channel spend the grant, so the session binds under the grant's parent with its title instead of coming up as a root. `swarm join` and other self-authenticating commands work from codex's sandboxed shell: the codex sandbox markers are recognised, and when the sandbox hides the harness process the CLI falls back to the binding the session's MCP shim records. An agent can now ask to adopt a root session: `swarm adopt <child>` from the agent's shell sends the child a link request, which the child accepts with `swarm link accept <id>`, the `relay_link_accept` tool or its own `swarm join --under`. The human at a terminal can adopt under a live parent with `--parent` even when the terminal inherited that parent's `$SCP_NAME`.

### Patch Changes

- Updated dependencies [22e3409]
- Updated dependencies [e17aac8]
  - @scp-dev/core@0.3.0
  - @scp-dev/mcp@0.2.0
  - @scp-dev/broker@0.4.0
  - @scp-dev/hub@0.6.1

## 0.4.0

### Minor Changes

- b571297: A session can be linked under a parent on another machine of the same account: `swarm join --under me/<machine>/<handle>` from the session, or `swarm adopt <child> --parent me/<machine>/<handle>` by the human at its terminal. The child stays a root of its own machine and records the parent as a remote address that its bridge mirrors, so every machine and the hub show it as the parent's child, and the dashboard graph and Sessions tree draw it under the parent with its machine tag. The parent and the child reach each other both ways through the hub, a link that would close a cycle is refused, and `swarm unlink` clears it.

### Patch Changes

- d1570ab: An ended session no longer advertises its wake: a hook's session_end, an exited harness process, a closed waker past its grace and a takeover clear it, while a live waker still keeps it, and the OpenCode waiter of a session that left sets none. A leftover mesh.json loads the mesh only when it is enabled, and a CLI without the mesh module warns and runs without it.
- Updated dependencies [b571297]
- Updated dependencies [d1570ab]
  - @scp-dev/core@0.2.0
  - @scp-dev/broker@0.3.0
  - @scp-dev/hub@0.6.0
  - @scp-dev/mcp@0.1.9

## 0.3.1

### Patch Changes

- 100a961: Ambient pi swarms come up and stay clean. A broker whose state directory was wiped or whose socket another broker took over stops, so its shims reconnect to the live one. A pi session starts its shim only once the previous one exited and reports a shim that could not claim the endpoint, and a shim exits once its harness is gone. A named relaunch, or a session its harness restarted in process, takes back its own endpoint instead of minting a `-2`. A broker linked again under a new machine name relabels its endpoints, and bridges drop the rows of released machines and of their own former name. `swarm --version` reads the installed package.json, and a closed stdout pipe ends a command quietly.
- Updated dependencies [100a961]
- Updated dependencies [100a961]
  - @scp-dev/core@0.1.6
  - @scp-dev/broker@0.2.1
  - @scp-dev/hub@0.5.1
  - @scp-dev/mcp@0.1.8

## 0.3.0

### Minor Changes

- 868ec53: Same-machine traffic shows on the dashboard. A linked broker reports metadata of deliveries between its own endpoints to the hub in batched `local_events` notifications: sender and recipient handles, kind, time and hashed message and thread ids, never a body, note, label or title. The hub counts them in the graph's message edges and streams them to watchers and the dashboard as `message` events marked `local`. `mirror_local: false` in `cloud.json` turns it off.
- 241807f: `swarm opencode [--name N]` runs OpenCode with the user's own config and arguments, wake on, and refuses to start without the current plugin. The OpenCode plugin's waiter now runs from load, so a freshly started OpenCode advertises `opencode-plugin` and a message opens a session when none is open yet.

### Patch Changes

- 8c02d45: `swarm codex`, `swarm claude` and `swarm pi` pass every argument through untouched and honour your own config: the codex app-server now gets your `--profile`, model, sandbox and approval settings, `swarm codex --resume THREAD` reopens a thread in the TUI too, and a `--` after harness arguments reaches the harness. `swarm claude` adds the scp channel after your arguments so a prompt is never taken as a channel, accepts `--as`, and refuses to start without a wake-capable scp mount, naming `swarm setup --write`. `swarm pi` keeps pi's own `--name`.
- 0a511fc: A claim that names no harness takes it from the harness process it runs under: `--as` commands, the MCP shim, hooks and `swarm join` infer it from the shell's process walk (claude, codex, opencode, pi, muse, agy, grok, gemini) or the harness's environment before falling back to `cli`, `hook` or `mcp`. Those generic harnesses never replace a known one, and a row created with one heals to the harness of its next claim. Claude Code hook text now fits Claude Code's caps (8000 characters and 200 lines of context, 2000 and 20 of a stop reason): bodies that would be cut end in `[truncated, N more chars: swarm show <id>]`, and the new `swarm show <id>` prints a delivered message whole. A hook shows up to 7168 bytes of wrapped messages at once (was 4096). `swarm up` ends with the wake-enabled launch of each installed harness.
- Updated dependencies [868ec53]
- Updated dependencies [0a511fc]
  - @scp-dev/hub@0.5.0
  - @scp-dev/broker@0.2.0
  - @scp-dev/core@0.1.5
  - @scp-dev/mcp@0.1.7

## 0.2.4

### Patch Changes

- Updated dependencies [5be17ee]
  - @scp-dev/hub@0.4.0
  - @scp-dev/broker@0.1.6
  - @scp-dev/mcp@0.1.6

## 0.2.3

### Patch Changes

- 2c90f37: `swarm setup` approves the Muse plugin's hooks after installing it, so a headless `muse exec` worker joins the relay, and matches Muse's canonical plugin path on symlinked homes.
- fe06b48: The pi extension targets @earendil-works/pi-coding-agent, the renamed pi package
- cc8413e: `swarm pi` works from the published CLI: the pi extension now ships inside the package as `dist/pi-extension.js`.
- 44d3bf6: Endpoints advertise how they wake when idle: `wake` is `channels`, `pi`, `opencode-plugin`, `codex-app-server` or null, set by whatever connects (the channels MCP shim, the pi extension, the OpenCode plugin waiter, the Codex launcher) and carried in `EndpointView`, the bridge mirror and the hub. `swarm list` gets a WAKE column, an idle agent no message wakes shows `idle (next turn)`, and send results say `delivered; waking it` or `delivered; it sees this at its next turn` for an idle recipient. Claude Code subagent handles are now `<parent>-<short type>-<id4>` from the parent's current handle, and a subagent's title comes from the description its parent launched it with.
- Updated dependencies [44d3bf6]
  - @scp-dev/core@0.1.4
  - @scp-dev/broker@0.1.5
  - @scp-dev/hub@0.3.1
  - @scp-dev/mcp@0.1.5

## 0.2.2

### Patch Changes

- 4422a53: A session started by hand can sit under an orchestrator: `swarm join --under <parent>` (MCP `relay_join` with `under`) links the session itself under an agent it may message, taking on a spawned worker's place and scope; `swarm adopt <child> [--parent <p>]` links any local root agent and its subtree, for the human at a terminal (an agent without one is refused); `swarm unlink [<child>]` puts it back at the root, for the human unless the policy sets `defaults.unlink: "self"`. Cycles are refused, both are audited as `adopt` and `unlink`, a linked session's later claims take it back where it sits, and the bridge resyncs so the hub, the other machines, `swarm list --tree`, the dashboard tree and the graph show the new parent.
- Updated dependencies [4422a53]
- Updated dependencies [171958d]
  - @scp-dev/core@0.1.3
  - @scp-dev/broker@0.1.4
  - @scp-dev/hub@0.3.0
  - @scp-dev/mcp@0.1.4

## 0.2.1

### Patch Changes

- ebd50b6: Sessions join the relay on demand: `swarm join [<handle>]` (MCP `relay_join`) puts the session that runs the shell on the relay, hooked or not, and names it once; `swarm name <handle>` renames a root session in place, keeping its id, mail, threads and relations, refusing a handle another endpoint holds (a spawned worker only with the policy's `defaults.rename: "self"`), and the hub renames its mirror in place; `swarm leave` (MCP `relay_leave`) takes it offline with its mail kept. `swarm setup --join manual` keeps hooked sessions off the relay until they join; `auto` stays the default. A send to an agent no live session holds says `queued: no live session holds <addr>`, and `--live` (MCP `live: true`) refuses it with `not_live` instead of queueing; `swarm list` shows live endpoints by default and offline ones with `--all`. `swarm claude` without `--name` asks the session to pick its own name with `swarm name`.
- 558955e: Add swarm codex to wake idle sessions and run ambient workers on relay messages.
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
  - @scp-dev/broker@0.1.3
  - @scp-dev/mcp@0.1.3

## 0.2.0

### Minor Changes

- 90e8f69: `swarm pi [--name N]` runs pi with the new `@scp-dev/pi` extension: the relay tools become pi tools, and each new message steers a running turn or wakes an idle session to run one. A session started again with the same name receives what arrived while it was closed.

## 0.1.3

### Patch Changes

- f84dc9b: A bridge the hub revoked or replaced links again after `swarm login`, `swarm cloud enable` or `swarm up`, through the new `bridge_relink` call; a broker started before its cloud config existed restarts to pick it up. `swarm daemon stop` and `swarm daemon restart` stop or replace the running broker.
- 7c91739: Idle Claude Code sessions wake on peer messages. `swarm claude [--name N] [claude args...]` starts Claude Code with the scp channel loaded, and `swarm setup`, `swarm up` and `swarm mcp install --harness claude` mount its MCP server with `--channels`. The server pushes only to a client that declares `claude/channel` or that `swarm claude` started, so other sessions keep the hook path. An inbox wait that runs into the 50 s cap says so.
- Updated dependencies [f84dc9b]
- Updated dependencies [7c91739]
  - @scp-dev/broker@0.1.2
  - @scp-dev/mcp@0.1.2

## 0.1.2

### Patch Changes

- Updated dependencies [f83cab6]
  - @scp-dev/core@0.1.1
  - @scp-dev/hub@0.1.1
  - @scp-dev/broker@0.1.1
  - @scp-dev/mcp@0.1.1

## 0.1.1

### Patch Changes

- 3ab9bde: Package README with the npm badge and install line.
