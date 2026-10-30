# @scp-dev/core

## 0.18.3

### Patch Changes

- f05c1a3: A session started with `--under` an agent on another machine, including a background session a harness daemon hosts, now links even when the claim lands before the hub link is up or before the parent's machine mirrored it: a refused link stays pending on the endpoint and the broker tries it again each time it applies other machines' endpoints. A root may link under a worker of another tree when it may message that tree's root, the worker's inbound rules admit it and the policy does not refuse it. A refusal is no longer silent: the broker logs it, `whoami` (and `relay_whoami`, `swarm whoami`) shows `link_pending` with the reason, and a launcher whose broker is not linked to the hub yet warns. The hub bridge logs when it links and unlinks.

## 0.18.2

### Patch Changes

- 898fd9e: A Claude Code session sent to the background from its terminal keeps its name, children, grants, groups, title and unread mail. Its background process claims with the new `harness_handoff` flag, and the broker hands the origin's endpoint over even while the old terminal process still holds it, unless that process is still busy, then closes the old process's connections so it comes back under a fresh name. A fork started from another terminal stays a parallel fork with its own name. `swarm relink --dry-run` lists background sessions stranded by an older CLI next to their idle origin, and `swarm relink --live` applies them.

## 0.18.1

### Patch Changes

- 5c998c2: The broker stays responsive under heavy load: indexed audit lookups, a primary-key wake check instead of a per-pass endpoint scan, refused-claim retries that back off instead of flooding, a one-day retention for refusal noise, a larger SQLite cache, and no synchronous `ps` on the main loop.

## 0.18.0

### Minor Changes

- f65ee3e: Make the loop guards (hopMax, threadMax, ping-pong) configurable through limits and off by default, including the cross-account hop and thread caps. The hop is still computed and carried; hello and status report an off guard as null.

## 0.17.1

### Patch Changes

- 673d1be: A bridge's full mirror leaves out historic agents that are offline, not revivable and carry no wake, so a broker with thousands of old rows links under a hub's endpoint cap; it still sends the parents of the rows it keeps, and once more a left-out row it mirrored reachable on this link, so the hub marks it offline. A historic agent that comes back is mirrored at its next change, after any of its parents the link has not mirrored, so the hub places it. A hub's endpoint cap refusal names the cap and the count the claim or mirror would reach, and points at the `endpoints` key of `SCP_LIMITS`. The spec says how long retention keeps a child that sent a message (until the message expires) and a root (until handle reuse).
- 4f8d617: A background session that a harness daemon hosts, and resumes or revives in a process of its own, keeps its name, place and mail: a claim with no grant that lineage places nowhere takes back the released row of the same harness session, a holder whose process ended counts as released, and a session's own hook endpoint is never its lineage parent. `swarm claude --bg --resume` reuses the name, grant and parent request of the session's previous mount, also when the resume forks a new session id. `swarm relink` puts an auto-named root back on the endpoint its grant named and placed, and a takeover by a root moves it under that row's parent, bound by that row's caps as well as its own, and takes the grant that row spent. A shim whose session's hook endpoint is still connected is never placed under that endpoint.

## 0.17.0

### Minor Changes

- 5bec4a0: Agent names survive client restarts: a session resumed in process rehomes its fresh endpoint onto its named one, a forked Claude Code session claims the session it forks as `harness_origin` and takes that endpoint back, and a resume takes back a row whose harness process no longer runs inside a broker restart's grace window. New `relink` method and `swarm relink [--dry-run]` repair endpoints stranded earlier, for the human at a terminal.

## 0.16.0

### Minor Changes

- 075a127: A hibernated endpoint (any provider but `spawn`) wakes only for mail sent after its hibernation began; unread mail it already had stays queued and wakes nothing, and the wake request's unread count still counts it. Local agent facts gain `unread_at`. The Claude background idle stop no longer keeps a worker for unread mail, runs its waker after a stop or removal only for mail newer than the first read, and stops a finished worker after 120 s by default (`stop_after_s`).

### Patch Changes

- a2c4406: Durable codex exec and grok spawns: a codex exec worker is held and revived by the thread id its output names when its hooks report none, with its prompt in argv or on stdin; a grok -p worker's durable ref leaves out the allow rules launch adds again, so it fits. A handback says the worker stays resumable after its idle time only when its hold is durable, and a send to a held or hibernated worker reports that it wakes it.

## 0.15.0

### Minor Changes

- 6adf46a: A detached `swarm spawn` of a resumable harness holds its worker for `lifecycle.idle_after_s` (default 10 minutes) and then hibernates it, revivable, when it has a parent (`--no-durable` opts out); `agents` counts the not-done `subagents` of the root's current session.

## 0.14.0

### Minor Changes

- 1538046: Make send, peek, request and contact rates configurable and off by default. Report disabled caps as null and accept broker configuration and SCP_LIMITS overrides.
- b43ec2c: An idle Claude Code background worker `swarm claude --bg` started stops after `lifecycle.idle_after_s` (default 10 minutes) and stays wakeable; `SCP_HISTORIC_AFTER_S` or `historic_after_s` sets when an agent turns historic, and `agents` reports live `subagents`.

## 0.13.1

### Patch Changes

- 968c1d2: The local broker no longer caps a day's messages unless `SCP_DAILY_CAP` sets one. A hub keeps its 2000 a day.

## 0.13.0

### Minor Changes

- 770d3ec: Record runner workers, show runner attach and cached status in list and peek, and stop remote workers through swarm end.

## 0.12.0

### Minor Changes

- 936f194: A hibernation whose ref is a revive record (harness, session, cwd, argv, via) makes the endpoint revivable: its view shows `revivable: true`, each waker run gets a one-time wake ticket, and the resumed session's claim with that ticket takes the same endpoint back with its mail, place, title and groups. A revivable endpoint is never renamed out of its handle or deleted while it sleeps. Durable spawns are revivable as they are, and the `claude-bg` waker now hibernates stopped and removed Claude Code background workers with a revive record, writes the ticket into the session's MCP config before `claude respawn` or `claude --bg --resume`, declines sessions `swarm claude --bg` did not start and declines `gone` when the transcript is gone. `swarm mcp` claims with `$SCP_WAKE_TICKET` and falls back to a plain claim when the ticket is spent.
- 88edeea: The broker stops a Claude Code background worker that `swarm claude --bg` started once it is done and idle for 600 s, and removes it once historic, never touching roots, orchestrators, attached sessions or ones with unread mail, and never forcing `claude rm`. The endpoint stays hibernated by the new `claude-bg` waker (`swarm claude-wake`), which respawns a stopped worker or resumes a removed one in its directory when a message arrives. `swarm claude ls` lists background sessions with their role and `swarm claude prune` applies the policy at once. The broker gains in-process tasks and the human-only `agents` method; the core gains `localAgents` and `brokerHibernate`.

## 0.11.0

### Minor Changes

- 7692493: Default reach: an agent with no list now sees and messages its own tree, every root of its account on any machine, contacts' endpoints and the human, and no longer another tree's children; an agent's own rules, its groups and caps other agents set only narrow within it, and only the human, the policy or a `via` widening reaches further; `open` names this default. A root no longer sees another tree's worker that may message it, though it still reads and answers its messages. Another machine's row counts as a root only when its machine mirrored it at depth 0, so a hub or broker never takes an unplaced row for a root. SPEC sections 10.1, 10.3, 10.7 and 11.2 describe it.
- 7692493: Historic agents: an agent with no activity (a call, a hook, a read or a message to it) for `LIMITS.historicAfterS` (3600 s, `Infinity` disables it) is historic. `list`, `peers` and `snapshot` leave it out unless `all` or `historic` is set, views carry `active_at` and `historic: true`, and mail, wake and reach are unchanged. Endpoints gain a `mail_at` column. The hub derives the flag from mirrored `active_at` and the traffic it sees, filters its `list`, and serves `/v1/dashboard/overview` and `/v1/dashboard/graph` without historic agents unless `historic=1`. `relay_list` and `relay_peers` take `historic`, and `swarm list` and `swarm peers` show them with `--all` and count what they hide. SPEC section 11.4 describes it.

## 0.10.1

### Patch Changes

- 14ea99a: The broker's hot paths no longer scale with every endpoint it ever saw. A hello reads only the claimed row instead of every endpoint's view, `list` and `snapshot` read only rows they could show, and calls that visit every row derive each row's scope once per request. Ended subagent and lineage child rows offline for a day with no unread mail are retired by the sweep (`endpointRetireS`, `Infinity` keeps them). A hook's process table read gives up after 1.5 s.

## 0.10.0

### Minor Changes

- 6881d37: The MCP tool definitions and their result rendering live in `@scp-dev/core` (`TOOLS`, `MCP_PROTOCOLS` and the helpers), with `REMOTE_TOOLS`, the surface the remote MCP endpoint serves; the stdio MCP server uses them from there.

## 0.9.0

### Minor Changes

- 6e8e028: Wake Codex desktop, IDE and finished `codex exec` threads with the new `codex-queue` broker wake: the broker queues messages into the thread with `codex queue` and opens it in the desktop app when nobody else holds it. Codex threads an app server shares are their own endpoints, and `swarm codex --resume` refuses a thread another surface holds with a `codex fork` hint.

## 0.8.0

### Minor Changes

- bce21aa: Machine waker: a `wake` option on `RelayHub` (`HUB_WAKE` defaults). `crossAccount` (off by default) lets a contact's message from another account wake a hibernated endpoint once every cross-account check passed, within per-hour caps per sender account and per target endpoint. An accepted wake shows the row `waking: true` in views, the graph and presence events until its claim mirrors in, or falls back to hibernated after `wakingTimeoutS`. The debounce, backoff and a decline's hold time are configurable, `clearWakeHold(machine?)` clears a hold, and the hold, debounce and backoff now live in the hub's storage, so a restarted hub keeps them. `EndpointView` gains the optional `waking` field.

## 0.7.1

### Patch Changes

- a4ebb80: A spawn grant now places the endpoint its session's hooks registered first, so `env $(swarm spawn-env --name W) swarm claude --bg --name W` lands W under the spawner instead of leaving it a root. Only an unplaced, unnamed local root of the same session moves; a placed or named endpoint still only gains the grant's caps and groups.
- b866b51: A stop no longer holds a session that a message wakes anyway (a wake with a live waker, as under `swarm claude`): it shows the worker messages already unread and lets the turn end, and the waker brings the later ones. A held stop now counts a worker only while it or its `swarm spawn` process still runs, comparing the process start time as well as the pid, so a spawn that died before its worker joined, or a worker whose harness and spawn are both gone, no longer keeps it waiting. `swarm setup` gives the Claude Code and Codex stop hooks the status line "waiting for worker messages (swarm)".

## 0.7.0

### Minor Changes

- adff5e5: A message to a stopped in-process subagent wakes its root: the root's waker is pushed the message tagged `for` the subagent (framed to continue it by its id), the subagent shows the root's wake and stays idle while that waker lives, and the message stays unread for the subagent without being shown twice. An agent now adopts a local root it may message directly (from its session or its shell), a child under another parent is still asked to consent, and `swarm join --under` in a codex sandbox that blocks the relay socket names `relay_join {under}` and the codex setting instead of a bare socket error; the relay dashboard words hook and spawn wakes.
- adff5e5: Wakeable spawns: a codex exec, agy -p, grok -p or muse exec worker stays held after its run (wake `spawn-resume`), and each message resumes the same harness session and hands the run back as a reply, until `--idle`, `swarm end <worker>` (`spawn_end`) or a signal. `--durable` hibernates the worker instead, also after a crash or broker restart, and the broker's built-in `spawn` waker resumes it on the next message as the same endpoint (a one-time wake ticket), keeping its labels, groups, peek and caps.

## 0.6.0

### Minor Changes

- 03447b6: T3 Code harness. Codex and Claude Code sessions that T3 Code runs claim harness `t3code` (from T3 Code's codex originator, or a T3 Code server as the harness's parent) while their hooks keep the provider's output format, and `swarm setup` reports T3 Code, which needs no setup of its own. `swarm t3code [--name N] --thread <id> [--base-dir DIR]` holds an endpoint for one T3 Code thread and wakes it: each batch of relay messages goes to the thread over T3 Code's WebSocket API, starting a turn when it is idle or steering the active run, retried every 2 s. It advertises the new wake value `t3code`, finds the server and a token by itself, and refuses to start without a server, a token or the thread. The relay overview draws the T3 Code mark.

## 0.5.0

### Minor Changes

- 7600fb6: Wake hooks for hibernated sessions and remote spawn runners. A provider marks a session hibernated with `swarm hibernate --wake <provider> --ref <ref>`: it shows as `hibernated` (wakeable, never offline), and a delivery to it runs the provider's configured waker, which brings the session back to reclaim its endpoint and drain its queue. A machine whose bridge is down can register a signed wake webhook with `swarm machine wake-url`. `swarm spawn --via <runner>` hands the spawn to a configured runner that starts the session on another machine, where it shows under its parent through a cross-machine link and hands back to it.

## 0.4.0

### Minor Changes

- 4fbdc8f: `swarm agy` and `swarm grok` run the harness headless and wake it: the launcher holds the endpoint, and each batch of new messages becomes a turn that resumes the same conversation (`agy --conversation <id> -p`, `grok --resume <id> -p`). grok's session id is preassigned with `-s`; agy's scp hooks report the conversation it opened. The endpoint advertises the new wake values `agy-resume` and `grok-resume`. Interactive flags are refused.
- 53c05c3: `swarm muse [--name N] [--resume S] [--approval-mode never|on-request|untrusted] [-- muse serve args...]` runs a headless Muse session through `muse serve` that relay messages wake: each message starts a turn on the idle session or steers the running one, and the agent's replies print to standard output. It advertises the new wake value `muse-serve`, honours `swarm spawn-env` grants through a launch file the session's shim and hooks read, and fails loudly when the session's scp mount never joins. A prompt made of relay messages no longer becomes the session's inferred title.

## 0.3.1

### Patch Changes

- b8d27cf: A resumed Claude Code session takes back its offline endpoint by its harness session id, and `swarm name <handle> --take-over` merges a stranded session onto its old endpoint.

## 0.3.0

### Minor Changes

- 22e3409: Messages wake idle Claude Code sessions that run without channels, such as `claude --bg`: the scp MCP server queues each delivery as the next turn on the session's own inbox socket and advertises wake `claude-inbox`.
- e17aac8: Linking fixes. `swarm codex` honours a spawn-env grant (`env $(swarm spawn-env ...) swarm codex`): its MCP shim and channel spend the grant, so the session binds under the grant's parent with its title instead of coming up as a root. `swarm join` and other self-authenticating commands work from codex's sandboxed shell: the codex sandbox markers are recognised, and when the sandbox hides the harness process the CLI falls back to the binding the session's MCP shim records. An agent can now ask to adopt a root session: `swarm adopt <child>` from the agent's shell sends the child a link request, which the child accepts with `swarm link accept <id>`, the `relay_link_accept` tool or its own `swarm join --under`. The human at a terminal can adopt under a live parent with `--parent` even when the terminal inherited that parent's `$SCP_NAME`.

## 0.2.0

### Minor Changes

- b571297: A session can be linked under a parent on another machine of the same account: `swarm join --under me/<machine>/<handle>` from the session, or `swarm adopt <child> --parent me/<machine>/<handle>` by the human at its terminal. The child stays a root of its own machine and records the parent as a remote address that its bridge mirrors, so every machine and the hub show it as the parent's child, and the dashboard graph and Sessions tree draw it under the parent with its machine tag. The parent and the child reach each other both ways through the hub, a link that would close a cycle is refused, and `swarm unlink` clears it.

### Patch Changes

- d1570ab: An ended session no longer advertises its wake: a hook's session_end, an exited harness process, a closed waker past its grace and a takeover clear it, while a live waker still keeps it, and the OpenCode waiter of a session that left sets none. A leftover mesh.json loads the mesh only when it is enabled, and a CLI without the mesh module warns and runs without it.

## 0.1.6

### Patch Changes

- 100a961: Ambient pi swarms come up and stay clean. A broker whose state directory was wiped or whose socket another broker took over stops, so its shims reconnect to the live one. A pi session starts its shim only once the previous one exited and reports a shim that could not claim the endpoint, and a shim exits once its harness is gone. A named relaunch, or a session its harness restarted in process, takes back its own endpoint instead of minting a `-2`. A broker linked again under a new machine name relabels its endpoints, and bridges drop the rows of released machines and of their own former name. `swarm --version` reads the installed package.json, and a closed stdout pipe ends a command quietly.
- 100a961: A wakeable endpoint whose waker lives shows `idle`, never `offline`: the connection that set its wake (the MCP shim, the pi extension, the OpenCode plugin's waiter, the Codex launcher) counts as its waker until it closes or sets `none`, a hook waker for `LIMITS.restartGraceS` more while its harness starts the next one. `list` keeps such endpoints without `--all`, and the broker reports the waker's leaving like other presence changes. The hub and other machines show a live mirrored row with the presence its machine sent, not one its `last_seen` decays to.

## 0.1.5

### Patch Changes

- 0a511fc: A claim that names no harness takes it from the harness process it runs under: `--as` commands, the MCP shim, hooks and `swarm join` infer it from the shell's process walk (claude, codex, opencode, pi, muse, agy, grok, gemini) or the harness's environment before falling back to `cli`, `hook` or `mcp`. Those generic harnesses never replace a known one, and a row created with one heals to the harness of its next claim. Claude Code hook text now fits Claude Code's caps (8000 characters and 200 lines of context, 2000 and 20 of a stop reason): bodies that would be cut end in `[truncated, N more chars: swarm show <id>]`, and the new `swarm show <id>` prints a delivered message whole. A hook shows up to 7168 bytes of wrapped messages at once (was 4096). `swarm up` ends with the wake-enabled launch of each installed harness.

## 0.1.4

### Patch Changes

- 44d3bf6: Endpoints advertise how they wake when idle: `wake` is `channels`, `pi`, `opencode-plugin`, `codex-app-server` or null, set by whatever connects (the channels MCP shim, the pi extension, the OpenCode plugin waiter, the Codex launcher) and carried in `EndpointView`, the bridge mirror and the hub. `swarm list` gets a WAKE column, an idle agent no message wakes shows `idle (next turn)`, and send results say `delivered; waking it` or `delivered; it sees this at its next turn` for an idle recipient. Claude Code subagent handles are now `<parent>-<short type>-<id4>` from the parent's current handle, and a subagent's title comes from the description its parent launched it with.

## 0.1.3

### Patch Changes

- 4422a53: A session started by hand can sit under an orchestrator: `swarm join --under <parent>` (MCP `relay_join` with `under`) links the session itself under an agent it may message, taking on a spawned worker's place and scope; `swarm adopt <child> [--parent <p>]` links any local root agent and its subtree, for the human at a terminal (an agent without one is refused); `swarm unlink [<child>]` puts it back at the root, for the human unless the policy sets `defaults.unlink: "self"`. Cycles are refused, both are audited as `adopt` and `unlink`, a linked session's later claims take it back where it sits, and the bridge resyncs so the hub, the other machines, `swarm list --tree`, the dashboard tree and the graph show the new parent.

## 0.1.2

### Patch Changes

- ebd50b6: Sessions join the relay on demand: `swarm join [<handle>]` (MCP `relay_join`) puts the session that runs the shell on the relay, hooked or not, and names it once; `swarm name <handle>` renames a root session in place, keeping its id, mail, threads and relations, refusing a handle another endpoint holds (a spawned worker only with the policy's `defaults.rename: "self"`), and the hub renames its mirror in place; `swarm leave` (MCP `relay_leave`) takes it offline with its mail kept. `swarm setup --join manual` keeps hooked sessions off the relay until they join; `auto` stays the default. A send to an agent no live session holds says `queued: no live session holds <addr>`, and `--live` (MCP `live: true`) refuses it with `not_live` instead of queueing; `swarm list` shows live endpoints by default and offline ones with `--all`. `swarm claude` without `--name` asks the session to pick its own name with `swarm name`.
- 98a26dd: An endpoint whose harness process exited without a session end goes offline at the broker's next list, claim or presence check instead of after the hook idle window, so other machines stop seeing it live and its handle can be claimed again. A swarm command whose stdout is a socket, as Node hands a child, no longer ends it on exit, so the shell that ran it keeps writing instead of dying of SIGPIPE. The hosted relay revalidates a credential by its table rather than its id prefix. A member's current credential releases an offline machine that an older token of theirs bound. A `machine` label that names the hostname names the configured machine instead.
- 451b2db: Idle OpenCode sessions wake on new messages. The OpenCode plugin keeps one `swarm hook opencode --wake 50` waiting while no session of the process runs a turn, and submits what it prints as a new prompt; a starting turn stops the waiter, and printed messages are confirmed so turn-boundary injection never shows them again. `SCP_WAKE=0` turns it off. `inject` takes `wait_s` to wait for a delivery to offer.
- 03eafb4: Hooks infer a title for an untitled session from the harness's own name for it or its first prompt, and never over an explicit one, and remind it every `SCP_TLDR_EVERY` prompts (default 10) to refresh its now line. Another org member's machines render as `<org>/<machine>/<handle>`, your own as `me/<machine>/<handle>`; both forms and `local/<handle>` are accepted as input.

## 0.1.1

### Patch Changes

- f83cab6: First release through the CI release workflow, with provenance.
