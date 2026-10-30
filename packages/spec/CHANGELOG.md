# @scp-dev/spec

## 0.6.3

### Patch Changes

- f05c1a3: A session started with `--under` an agent on another machine, including a background session a harness daemon hosts, now links even when the claim lands before the hub link is up or before the parent's machine mirrored it: a refused link stays pending on the endpoint and the broker tries it again each time it applies other machines' endpoints. A root may link under a worker of another tree when it may message that tree's root, the worker's inbound rules admit it and the policy does not refuse it. A refusal is no longer silent: the broker logs it, `whoami` (and `relay_whoami`, `swarm whoami`) shows `link_pending` with the reason, and a launcher whose broker is not linked to the hub yet warns. The hub bridge logs when it links and unlinks.

## 0.6.2

### Patch Changes

- 898fd9e: A Claude Code session sent to the background from its terminal keeps its name, children, grants, groups, title and unread mail. Its background process claims with the new `harness_handoff` flag, and the broker hands the origin's endpoint over even while the old terminal process still holds it, unless that process is still busy, then closes the old process's connections so it comes back under a fresh name. A fork started from another terminal stays a parallel fork with its own name. `swarm relink --dry-run` lists background sessions stranded by an older CLI next to their idle origin, and `swarm relink --live` applies them.

## 0.6.1

### Patch Changes

- 673d1be: A bridge's full mirror leaves out historic agents that are offline, not revivable and carry no wake, so a broker with thousands of old rows links under a hub's endpoint cap; it still sends the parents of the rows it keeps, and once more a left-out row it mirrored reachable on this link, so the hub marks it offline. A historic agent that comes back is mirrored at its next change, after any of its parents the link has not mirrored, so the hub places it. A hub's endpoint cap refusal names the cap and the count the claim or mirror would reach, and points at the `endpoints` key of `SCP_LIMITS`. The spec says how long retention keeps a child that sent a message (until the message expires) and a root (until handle reuse).
- 4f8d617: A background session that a harness daemon hosts, and resumes or revives in a process of its own, keeps its name, place and mail: a claim with no grant that lineage places nowhere takes back the released row of the same harness session, a holder whose process ended counts as released, and a session's own hook endpoint is never its lineage parent. `swarm claude --bg --resume` reuses the name, grant and parent request of the session's previous mount, also when the resume forks a new session id. `swarm relink` puts an auto-named root back on the endpoint its grant named and placed, and a takeover by a root moves it under that row's parent, bound by that row's caps as well as its own, and takes the grant that row spent. A shim whose session's hook endpoint is still connected is never placed under that endpoint.

## 0.6.0

### Minor Changes

- 5bec4a0: Agent names survive client restarts: a session resumed in process rehomes its fresh endpoint onto its named one, a forked Claude Code session claims the session it forks as `harness_origin` and takes that endpoint back, and a resume takes back a row whose harness process no longer runs inside a broker restart's grace window. New `relink` method and `swarm relink [--dry-run]` repair endpoints stranded earlier, for the human at a terminal.

## 0.5.0

### Minor Changes

- 936f194: A hibernation whose ref is a revive record (harness, session, cwd, argv, via) makes the endpoint revivable: its view shows `revivable: true`, each waker run gets a one-time wake ticket, and the resumed session's claim with that ticket takes the same endpoint back with its mail, place, title and groups. A revivable endpoint is never renamed out of its handle or deleted while it sleeps. Durable spawns are revivable as they are, and the `claude-bg` waker now hibernates stopped and removed Claude Code background workers with a revive record, writes the ticket into the session's MCP config before `claude respawn` or `claude --bg --resume`, declines sessions `swarm claude --bg` did not start and declines `gone` when the transcript is gone. `swarm mcp` claims with `$SCP_WAKE_TICKET` and falls back to a plain claim when the ticket is spent.
- 88edeea: The broker stops a Claude Code background worker that `swarm claude --bg` started once it is done and idle for 600 s, and removes it once historic, never touching roots, orchestrators, attached sessions or ones with unread mail, and never forcing `claude rm`. The endpoint stays hibernated by the new `claude-bg` waker (`swarm claude-wake`), which respawns a stopped worker or resumes a removed one in its directory when a message arrives. `swarm claude ls` lists background sessions with their role and `swarm claude prune` applies the policy at once. The broker gains in-process tasks and the human-only `agents` method; the core gains `localAgents` and `brokerHibernate`.

## 0.4.7

### Patch Changes

- 7692493: Default reach: an agent with no list now sees and messages its own tree, every root of its account on any machine, contacts' endpoints and the human, and no longer another tree's children; an agent's own rules, its groups and caps other agents set only narrow within it, and only the human, the policy or a `via` widening reaches further; `open` names this default. A root no longer sees another tree's worker that may message it, though it still reads and answers its messages. Another machine's row counts as a root only when its machine mirrored it at depth 0, so a hub or broker never takes an unplaced row for a root. SPEC sections 10.1, 10.3, 10.7 and 11.2 describe it.
- 7692493: Historic agents: an agent with no activity (a call, a hook, a read or a message to it) for `LIMITS.historicAfterS` (3600 s, `Infinity` disables it) is historic. `list`, `peers` and `snapshot` leave it out unless `all` or `historic` is set, views carry `active_at` and `historic: true`, and mail, wake and reach are unchanged. Endpoints gain a `mail_at` column. The hub derives the flag from mirrored `active_at` and the traffic it sees, filters its `list`, and serves `/v1/dashboard/overview` and `/v1/dashboard/graph` without historic agents unless `historic=1`. `relay_list` and `relay_peers` take `historic`, and `swarm list` and `swarm peers` show them with `--all` and count what they hide. SPEC section 11.4 describes it.

## 0.4.6

### Patch Changes

- 6881d37: Remote MCP endpoint: `RelayHub.mcp()` serves an account to MCP clients over Streamable HTTP with JSON responses and `Mcp-Session-Id` sessions. Each grant gets one client machine `<label>-<4 hex>` with a default endpoint named for the label and the forced `client` label; `relay_join` gives a session its own endpoint and `relay_leave` drops it. Endpoints are claimed with `in` and `out` of `["*"]`, so they stay within the account, and every result ends with the unread count. Waits are capped at `mcpWaitS` (50 s) and results at 150000 characters. Hub clients gain the `title`, `receipts`, `message`, `peers` and `leave` methods. SPEC section 14.9 describes the endpoint.

## 0.4.5

### Patch Changes

- 12259a0: Sessions of the Claude desktop app's Code tab are labelled `claude-desktop` and Codex desktop app threads `codex-desktop`, with the provider's hook format; dashboards show them with the Claude and Codex icons.

## 0.4.4

### Patch Changes

- bba5dc8: A queued message's machine waker call after a hold ends now counts against the sender account's per-hour cap once per message and window, and a call that only a per-hour cap refused is retried at the alarm once that cap's window resets, instead of waiting for the next new message.

## 0.4.3

### Patch Changes

- 906bb6c: A machine waker hold that ends (its `declineHoldS` expiry at the alarm, or `RelayHub.clearWakeHold`) now wakes the machine once for mail already queued for its hibernated endpoints, under the same debounce, waking state and caps as a delivery; another account's mail only with cross-account wakes on.

## 0.4.2

### Patch Changes

- bce21aa: Machine waker: a `wake` option on `RelayHub` (`HUB_WAKE` defaults). `crossAccount` (off by default) lets a contact's message from another account wake a hibernated endpoint once every cross-account check passed, within per-hour caps per sender account and per target endpoint. An accepted wake shows the row `waking: true` in views, the graph and presence events until its claim mirrors in, or falls back to hibernated after `wakingTimeoutS`. The debounce, backoff and a decline's hold time are configurable, `clearWakeHold(machine?)` clears a hold, and the hold, debounce and backoff now live in the hub's storage, so a restarted hub keeps them. `EndpointView` gains the optional `waking` field.

## 0.4.1

### Patch Changes

- a4ebb80: A spawn grant now places the endpoint its session's hooks registered first, so `env $(swarm spawn-env --name W) swarm claude --bg --name W` lands W under the spawner instead of leaving it a root. Only an unplaced, unnamed local root of the same session moves; a placed or named endpoint still only gains the grant's caps and groups.
- d4c599a: Launchers attribute what they start: `swarm claude` (also `--bg`), `codex`, `muse`, `pi`, `opencode`, `agy`, `grok` and `t3code` run from an agent's shell mint the grant `swarm spawn-env --name N` would mint there, with the agent's own authority, so the new session links under that agent without `env $(swarm spawn-env ...)`. `swarm claude --bg` prints `under me/<agent>`. A grant minted for the session in `$SCP_GRANT` still applies, `--root` starts a root, a resumed session keeps its place, a plain terminal is unchanged, and a failed mint warns and launches unlinked.
- b866b51: A stop no longer holds a session that a message wakes anyway (a wake with a live waker, as under `swarm claude`): it shows the worker messages already unread and lets the turn end, and the waker brings the later ones. A held stop now counts a worker only while it or its `swarm spawn` process still runs, comparing the process start time as well as the pid, so a spawn that died before its worker joined, or a worker whose harness and spawn are both gone, no longer keeps it waiting. `swarm setup` gives the Claude Code and Codex stop hooks the status line "waiting for worker messages (swarm)".

## 0.4.0

### Minor Changes

- adff5e5: A message to a stopped in-process subagent wakes its root: the root's waker is pushed the message tagged `for` the subagent (framed to continue it by its id), the subagent shows the root's wake and stays idle while that waker lives, and the message stays unread for the subagent without being shown twice. An agent now adopts a local root it may message directly (from its session or its shell), a child under another parent is still asked to consent, and `swarm join --under` in a codex sandbox that blocks the relay socket names `relay_join {under}` and the codex setting instead of a bare socket error; the relay dashboard words hook and spawn wakes.
- adff5e5: Wakeable spawns: a codex exec, agy -p, grok -p or muse exec worker stays held after its run (wake `spawn-resume`), and each message resumes the same harness session and hands the run back as a reply, until `--idle`, `swarm end <worker>` (`spawn_end`) or a signal. `--durable` hibernates the worker instead, also after a crash or broker restart, and the broker's built-in `spawn` waker resumes it on the next message as the same endpoint (a one-time wake ticket), keeping its labels, groups, peek and caps.

### Patch Changes

- a6ed4fe: Mesh links are sealed. `mesh_hello` carries a fresh X25519 key, `mesh_auth` signs both keys and which side dialed, and after the handshake every frame is a binary AES-256-GCM frame with a key per direction and a frame counter as its nonce, so a tap on the path reads nothing and a replayed, altered or cleartext frame closes the link. This changes the experimental wire: update every machine of a mesh together. A listener closes connections past 64 still authenticating, a machine whose name already has a live link under another machine key is refused along with its records, and a sender sends its newer record before a forward, so a worker that claimed its endpoint just before handing back its result is known on the other machine. Records carry the wake binding and, after a rename, the previous handle, so a renamed endpoint keeps its threads on other machines. `swarm mesh init --account-key -` reads the key from stdin, and `init`, `listen`, `on` and `off` say that `swarm daemon restart` applies them.

## 0.3.0

### Minor Changes

- 03447b6: T3 Code harness. Codex and Claude Code sessions that T3 Code runs claim harness `t3code` (from T3 Code's codex originator, or a T3 Code server as the harness's parent) while their hooks keep the provider's output format, and `swarm setup` reports T3 Code, which needs no setup of its own. `swarm t3code [--name N] --thread <id> [--base-dir DIR]` holds an endpoint for one T3 Code thread and wakes it: each batch of relay messages goes to the thread over T3 Code's WebSocket API, starting a turn when it is idle or steering the active run, retried every 2 s. It advertises the new wake value `t3code`, finds the server and a token by itself, and refuses to start without a server, a token or the thread. The relay overview draws the T3 Code mark.

## 0.2.0

### Minor Changes

- 4fbdc8f: `swarm agy` and `swarm grok` run the harness headless and wake it: the launcher holds the endpoint, and each batch of new messages becomes a turn that resumes the same conversation (`agy --conversation <id> -p`, `grok --resume <id> -p`). grok's session id is preassigned with `-s`; agy's scp hooks report the conversation it opened. The endpoint advertises the new wake values `agy-resume` and `grok-resume`. Interactive flags are refused.

## 0.1.1

### Patch Changes

- b8d27cf: A resumed Claude Code session takes back its offline endpoint by its harness session id, and `swarm name <handle> --take-over` merges a stranded session onto its old endpoint.

## 0.1.0

### Minor Changes

- 22e3409: Messages wake idle Claude Code sessions that run without channels, such as `claude --bg`: the scp MCP server queues each delivery as the next turn on the session's own inbox socket and advertises wake `claude-inbox`.

## 0.0.5

### Patch Changes

- 100a961: A wakeable endpoint whose waker lives shows `idle`, never `offline`: the connection that set its wake (the MCP shim, the pi extension, the OpenCode plugin's waiter, the Codex launcher) counts as its waker until it closes or sets `none`, a hook waker for `LIMITS.restartGraceS` more while its harness starts the next one. `list` keeps such endpoints without `--all`, and the broker reports the waker's leaving like other presence changes. The hub and other machines show a live mirrored row with the presence its machine sent, not one its `last_seen` decays to.

## 0.0.4

### Patch Changes

- 868ec53: Same-machine traffic shows on the dashboard. A linked broker reports metadata of deliveries between its own endpoints to the hub in batched `local_events` notifications: sender and recipient handles, kind, time and hashed message and thread ids, never a body, note, label or title. The hub counts them in the graph's message edges and streams them to watchers and the dashboard as `message` events marked `local`. `mirror_local: false` in `cloud.json` turns it off.
- 0a511fc: A claim that names no harness takes it from the harness process it runs under: `--as` commands, the MCP shim, hooks and `swarm join` infer it from the shell's process walk (claude, codex, opencode, pi, muse, agy, grok, gemini) or the harness's environment before falling back to `cli`, `hook` or `mcp`. Those generic harnesses never replace a known one, and a row created with one heals to the harness of its next claim. Claude Code hook text now fits Claude Code's caps (8000 characters and 200 lines of context, 2000 and 20 of a stop reason): bodies that would be cut end in `[truncated, N more chars: swarm show <id>]`, and the new `swarm show <id>` prints a delivered message whole. A hook shows up to 7168 bytes of wrapped messages at once (was 4096). `swarm up` ends with the wake-enabled launch of each installed harness.

## 0.0.3

### Patch Changes

- 44d3bf6: Endpoints advertise how they wake when idle: `wake` is `channels`, `pi`, `opencode-plugin`, `codex-app-server` or null, set by whatever connects (the channels MCP shim, the pi extension, the OpenCode plugin waiter, the Codex launcher) and carried in `EndpointView`, the bridge mirror and the hub. `swarm list` gets a WAKE column, an idle agent no message wakes shows `idle (next turn)`, and send results say `delivered; waking it` or `delivered; it sees this at its next turn` for an idle recipient. Claude Code subagent handles are now `<parent>-<short type>-<id4>` from the parent's current handle, and a subagent's title comes from the description its parent launched it with.

## 0.0.2

### Patch Changes

- 171958d: The hub can judge its own account's sends between machines before delivery: `RelayHub.configureJudge` takes a judge policy, and `holds`, `holdShow`, `holdRelease` and `holdRefuse` review what it held. Without a policy the hub holds no judge and its send paths are unchanged. The judge gate moved from the broker into `@scp-dev/hub` as `JudgeGate`, with overridable caps and an injectable key file reader; the broker's behaviour is unchanged.

## 0.0.1

### Patch Changes

- 03eafb4: Hooks infer a title for an untitled session from the harness's own name for it or its first prompt, and never over an explicit one, and remind it every `SCP_TLDR_EVERY` prompts (default 10) to refresh its now line. Another org member's machines render as `<org>/<machine>/<handle>`, your own as `me/<machine>/<handle>`; both forms and `local/<handle>` are accepted as input.
