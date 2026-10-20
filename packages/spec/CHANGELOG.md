# @scp-dev/spec

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
