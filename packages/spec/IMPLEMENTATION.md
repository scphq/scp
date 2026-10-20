# SCP reference implementation

This document is non-normative. It describes how the reference implementation (the `swarm` CLI, its MCP server, its harness hooks, the broker, the hub and the hosted relay) does what the specification leaves to implementations: harness discovery, launching and waking workers, file layout, environment variables, timings, command-line presentation and per-harness integrations. The specification is `SPEC.md`; where the two disagree, `SPEC.md` wins. References of the form "SPEC section 6.4" point there. Requirement keywords that appear here describe the reference's own behaviour; they are not conformance requirements.

Normative interoperation on Unix hosts (socket discovery, harness-instance keys, grant conveyance, session markers and shim bindings) is fixed by SPEC Appendix E, not by this document.

## Surfaces

- `swarm <verb>` is the CLI (see CLI verbs). `swarm mcp` runs the MCP server, registered in each harness under the name `scp` (see MCP server). `swarm hook <harness> [event]` runs the harness hooks (see Harness bindings).
- The relay directory is `$SCP_DIR`, else `$XDG_STATE_HOME/scp`, else `$HOME/.local/state/scp` (SPEC Appendix E.1). User configuration lives in `~/.config/scp`: `config.json` (install settings such as the join mode), `policy.json`, `wakers.json` and `runners.json`. The bridge configuration is `cloud.json` in the relay directory.

### Environment variables

Variables marked "binding" are fixed by SPEC Appendix E; the others are this implementation's.

| Variable | Meaning |
| --- | --- |
| `SCP_DIR` | The relay directory (binding). |
| `SCP_SESSION` | The session key is `env:<value>` (binding). |
| `SCP_GRANT` | A grant to redeem; set by the spawn launcher for its worker (binding). |
| `SCP_NAME` | The handle to claim or act as; with a grant, the grant's name (binding for workers). |
| `SCP_UNDER` | Sent as the claim's `under`; set for a worker on another machine (binding). |
| `SCP_SHIM_BINDING` | The launch key of a shim binding (binding). |
| `SCP_HARNESS_PID` | The launcher that stands in as the harness instance (binding). |
| `SCP_HARNESS`, `SCP_HARNESS_DETECT` | Name the harness explicitly; `SCP_HARNESS_DETECT=0` turns off marker-based inference (binding, for shim bindings). |
| `SCP_PARENT` | The spawner's address, removed from a worker's environment. |
| `SCP_LABELS` | Labels passed to a worker's claims. |
| `SCP_PUSH_WAIT` | Caps the stop push wait. |
| `SCP_TLDR_EVERY` | Prompts between now-line reminders (default 10, 0 disables). |
| `SCP_TRANSPORT` | `cloud` sends the CLI to the hub directly; hooks then do nothing. |
| `SCP_CHANNELS` | Turns on channel push in the MCP server. |
| `SCP_RUNNERS_FILE` | Overrides the path of `runners.json`. |
| `SCP_MACHINE_WAKE_SECRET` | Default variable holding a machine waker's secret. |
| `SCP_WAKE_*` | The wake request, in a waker's environment. |

## Local broker

- The relay directory and socket follow the Unix binding (SPEC Appendix E).
- The client starts the broker on demand and retries the connection every 50 ms for up to 5 s. Of the hooks, only the session-start hook starts a broker (retrying for up to 1 s); any other hook finding none does nothing.
- The broker sweeps expired state every 10 minutes and recomputes presence every 60 s. It exits after an idle period with no connections and no pending requests (default 30 minutes).
- On shutdown the broker allows pending requests up to 2 s to finish.

## Identity

### Process keys and sessions

- Process keys and session keys follow SPEC Appendix E.3.
- The harness process of an MCP server is its parent process, or its grandparent when the parent is a shell. Under `swarm agy` and `swarm grok` it is the launcher instead, named by `SCP_HARNESS_PID`, which counts only when that pid is the parent of the harness process: the launcher holds the endpoint across the harness processes of its turns, so each turn's MCP server rejoins it from the same process key (SPEC section 6.4 rule 1). A hook takes the harness pid from the harness's environment where the harness provides one.
- A codex shim publishes its full harness process key in local binding files for sandboxed shells ("Self-attestation of tool shells"). `SCP_SHIM_BINDING` selects a binding across pid namespaces; it does not replace the process or session key.

### Self-attestation of tool shells

An agent's shell commands run as children of its harness. A CLI that runs in such a shell authenticates as the agent's endpoint without any token:

1. The CLI reads the process table once and computes `lineage` (process keys from its parent upward) and `self` (the harness lineage).
2. The harness lineage walk follows SPEC Appendix E.4.
3. When the harness lineage is empty in a codex shell, the CLI tries a local shim binding:
   - Codex markers are `CODEX_THREAD_ID`, then `CODEX_SANDBOX` (such as `seatbelt`) or `CODEX_SANDBOX_NETWORK_DISABLED`. `SCP_HARNESS=codex` also selects the fallback. `SCP_HARNESS_DETECT=0` disables marker-based inference, but not an explicit `SCP_HARNESS`.
   - The codex MCP shim writes `<relay dir>/bindings/pid-<harness pid>.json` containing `{process, handle, harness}`, with mode `0600`, and removes it on exit when possible. The process MUST be a full `pid:<pid>:<start time>` key.
   - `swarm codex` sets a fresh random 32-character hex `SCP_SHIM_BINDING` in the harness environment and passes it to the shim through `env_vars`. The shim also writes `bindings/key-<SCP_SHIM_BINDING>.json`. The CLI tries this binding first, so a pid namespace can recover the host harness key. `swarm spawn` removes the spawner's binding key from the worker's environment.
   - Without a usable key binding, the CLI climbs from its parent through the visible process table to the first missing parent pid and tries that pid's binding. The binding's process pid MUST equal the missing pid.
   - With a valid codex binding, both `lineage` and `self` contain the visible keys followed by the binding's process key, and the harness is codex. Without one, `swarm join` reports that the codex sandbox hides the harness and directs the agent to `relay_join` (MCP) with the name and `under` it was given.
   - A binding does not open the socket: a sandbox that refuses the connection to the relay socket ("Joining and linking from the CLI") makes the CLI name the MCP tools instead.
4. The CLI sends `hello {observe, self, lineage}`. The broker binds the endpoint that `self` places with auth `self`.

### Identity resolution in the CLI

The CLI resolves its identity in this order: an explicit name (`--as` or `SCP_NAME`), sent as an `exact` claim; else a grant in `SCP_GRANT`, sent as an observer with grant; else, when a terminal is attached or `--human` is given, a human hello with lineage (acting as the agent that lineage lands on, if any); else an observer with `self`.

### Subagents

- Claude Code reports a subagent's description through the root's `PostToolUse` of its `Agent` or `Task` tool, with `tool_input.description` and an object `tool_response` carrying `agentId`. The hook offers it as `subagent_title`.
- The subagent's `id` is Claude Code's `agentId`, which its SendMessage tool takes to continue a stopped subagent. A root under `swarm claude` (`channels`) or in a background session (`claude-inbox`) is the subagents' waker (SPEC section 6.9): its MCP server's channel push, the waker connection, also pushes a stopped subagent's messages, framed for the root to continue that subagent and carrying `for` and `subagent` in the channel metadata. The broker returns the root's waiting `inbox` call as soon as such a message arrives.

### Joining and linking from the CLI

- The default join mode is `auto`. `swarm setup --join manual` selects `manual` and stores it as `join` in `~/.config/scp/config.json`.
- `swarm adopt <child> --parent <p>` at a terminal without explicit `--as` acts as the human, ignoring inherited `$SCP_NAME` and `$SCP_GRANT`.
- `swarm adopt <child>` from an agent's own session or from its shell (lineage or self auth, "Self-attestation of tool shells") links a local root it may message under that agent at once and prints `<child> now sits under <agent>`; a child under another parent is asked to consent instead, and the command prints the request's short id.
- A link request is accepted with `swarm link accept <id>` or the MCP tool `relay_link_accept {id}`, once the child is a root. The child may instead consent with `swarm join --under <parent>` or `relay_join {under: <parent>}`.
- `swarm join --under <parent>` in a codex shell needs what a plain `swarm join` needs and nothing more: the harness instance, recovered from the shim binding, and a connection to the relay socket. Codex's workspace-write sandbox without network access refuses Unix domain socket connections too, so every relay command from its shell fails there; the CLI then exits with a usage error that names the MCP tool doing the same from outside the sandbox (`relay_join {name?, under?}` for a join, the scp MCP tools for the other verbs that act as the agent) and the codex setting that lets the sandbox reach the socket (`sandbox_workspace_write.network_access = true`), and starts no broker: a command from a codex shell never starts one, since the sandbox would hold the daemon too, and names the same tool and setting when none runs. Without a binding it names `relay_join` with the same arguments.
- A session renamed through its marker claims its own handle over `SCP_NAME` and the derived default.
- The CLI sends `$SCP_UNDER` as the claim's `under`.

## Delivery

### Hooks

- A hook exits successfully and writes nothing to standard error. It works within a deadline of 1500 ms (900 ms for harnesses with short hook timeouts; 1000 ms at session end), skips `inject` when less than 300 ms remain, and skips printing and confirming when less than 150 ms remain.
- On a subagent's first claim the hook prints the subagent's own address and that its shell acts as its parent unless given `--as <handle>`.
- The prompt-submit hook appends the tl;dr reminder when it is due (see "Titles, wakes and the now line").
- `swarm hook --no-inject` records activity only.
- `--block-stop-on-unread` sets `hold_unread` at the stop.
- With the transport overridden to the hub (`SCP_TRANSPORT=cloud`) hooks do nothing.

### Channel push

A harness whose tool protocol supports server-initiated messages MAY receive messages as they arrive. The reference MCP server, when started with channels enabled and connected to a client that declares the `claude/channel` experimental capability, or to one the reference launcher started with channels loaded, polls `inbox {wait_s: LIMITS.injectHoldS, offer: true}`, emits `notifications/claude/channel` with `{content: <preamble and block>, meta: {from, id, seq, thread, for?, subagent?}}` (`for` and `subagent` on a message for an idle subagent, SPEC section 6.9), and confirms with `injected {seqs, hold}`. Channel pushes do not acknowledge.

### Stop push

- The push wait is configured per install: default 600 s, 0 disables, range 0 to 3600. The effective wait is the smaller of the install setting and `SCP_PUSH_WAIT`.

## Spawn launcher

The spawn operation (reference: `swarm spawn [flags] -- <harness command>`) runs a worker harness under a fresh spawn grant:

1. Mint a spawn grant with `ttl_s` 3600, `bind_process` set to the spawner's own process key, and the defaults of SPEC section 9.2.
2. Build the worker's environment from the spawner's minus the spawner's identity variables (those of SPEC Appendix E.5, plus `SCP_SPAWN_RUNNER` and `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`), plus the grant's environment and labels.
3. Append the steer note (SPEC section 8.7) to the worker's prompt where the harness takes a prompt argument, and apply harness-specific arguments that let the worker use its relay tools.
4. Run the harness, forwarding signals, and capture the tail of its output when standard output is not a terminal.
5. When the worker exits 0 and its harness resumes a headless session (reference: `codex exec`), call `spawn_steers {grant, take: true}`. It returns the harness session id the worker's hooks reported and the spawner's messages to the worker it never read; with a session and such steers they are marked read, and the spawn resumes the session with them as the prompt, at most twice. A resumed run that exits non-zero leaves those steers `unapplied` (SPEC section 9.3).
6. On exit, call `spawn_steers {grant}` once more for the worker's transcript (where its hooks named one, the worker's own replies in it are the output), then `spawn_exit {grant, code, output, stderr?, unapplied?, exits?, started?}`.
7. Before that `spawn_exit`, hold the worker for resumed runs (SPEC section 9.5) when its harness resumes a headless session and the worker joined, unless spawn caught SIGINT, SIGTERM or SIGHUP during its runs. The resumable harnesses and their resumed run, the prompt last: `codex exec [opts] resume [the options resume takes] <session> <prompt>` (the session from `spawn_steers`; not with `--ephemeral`), `agy [args] --conversation <id> -p <prompt>` for a headless agy (a prompt flag), the id from the file named in `SCP_AGY_CONVERSATION_FILE`, a file in a temporary directory spawn sets for the worker and removes when it ends (else the user's `--conversation`), `grok [args] --resume <id> [--allow rules] -p <prompt>` for a headless grok, the id the user's `-s`/`-r`, else a new UUID spawn passes on the first run as `-s <uuid>`, and `muse [opts] exec [opts] --session-id <id> <prompt>` for a `muse exec` with at most one prompt word, which continues the logged session of that id: the id the user's `--session-id`, else a new UUID spawn passes on the first run right after `exec`; the resumed run leaves out `--prompt-file`, `--image` and the worktree options (`-w`/`--worktree`, `--worktree-base`, `--worktree-existing`), which belong to the first run, and a muse with `--no-session-log` (it keeps no session) or `--api-key-stdin` (its stdin is closed on a resume) is not resumed. The arguments are those of "Harness bindings" for `swarm agy` and `swarm grok`. The hold claims the worker's handle with the spent grant, `exact`, the worker's harness, spawn's own process key, the spawner's lineage, and a fresh `SCP_SESSION`; it sets `wake {via: "spawn-resume"}`. Each resumed run gets the worker's environment plus that `SCP_SESSION` and spawn's pid as `SCP_HARNESS_PID`, both also named in codex's `env_vars`, so the run's MCP server and hooks join the held endpoint ("Process keys and sessions"); its stdin is closed. The batch of messages taken while no run was in flight is the prompt, each framed as a channel push, joined by a blank line. Before each resumed run the endpoint's status is set `working` with an empty note; after it, `spawn_exit {grant, code, output, stderr?, run: n, reply_to?}` hands it back, `reply_to` the newest message the run carried from the worker's parent.
8. Let the worker go after `--idle` seconds without a message (default 1800 for a detached spawn, a `--durable` one or an MCP `relay_spawn`; in the foreground none unless `--idle` or `--durable` is given, so `--fg` keeps returning the harness's exit code at once; `Infinity` holds until ended; `0` never holds), on SIGINT, SIGTERM or SIGHUP (a run in flight gets the signal and finishes first), or when its holding connection closes (`swarm end`, or the broker going away). Before letting go after the idle time it takes once more any message that came meanwhile. With `--durable` it first sends `hibernate {wake: "spawn", ref}` on the holding connection and waits for the answer. A foreground spawn returns the first run's exit code.

**Durable spawns.** `--durable` hands the broker, with `wake {via: "spawn-resume", ref}`, the JSON ref `{"harness", "session", "cwd", "argv", "idle_s", "parent"}`: the resumable harness, its session, the absolute working directory, the resumed run's words before its prompt with the program found on `PATH` as an absolute path, the idle seconds (`null` for `Infinity`) and the parent's address. It never holds a credential or the grant. A command spawn cannot resume, `--idle 0`, or a ref that would pass `LIMITS.wakeRefChars` or look like it carries a credential is a usage error before the grant is minted. A broker without a `spawn` waker refuses the ref; the worker is then held plainly, with a note.

`spawn_env` (reference: `swarm spawn-env`) mints an ordinary grant with the same parameters and prints its environment, without steer key, handback or push.

With `--via <runner>` the spawn mints no grant and runs no harness here: a configured runner starts the worker on another machine, linked under the spawner ("Runners"). A spawn whose `--under` names an agent on another machine runs the harness linked under it, without a grant ("Runners").

### Worker display

- `swarm list` and the MCP `relay_list` show an idle agent without a wake as `idle (next turn)`, and a hibernated one as `hibernated (wakeable)`.
- The broker checks for ended harness processes every 60 s.

## Policy file

The broker reads an optional policy file (reference: `~/.config/scp/policy.json` under the home directory from the user database, overridable at broker start). It re-reads the file on every send, ask, hold release and policy call, and re-parses only when the text changed. A missing file is an open policy. An unreadable or invalid file MUST cause every send to be refused `policy_refused` with the error. Unknown fields are refused.

## Titles, wakes and the now line

- **Inferred title.** A hook of the holding process MAY offer `title_infer {from, text}` for an agent whose title nobody set (not a grant, `title` or the user). `from: "prompt"` is the first non-empty line of the session's first prompt and fills only an empty title. `from: "summary"` is the harness's own name for the session: Claude Code's newest `custom-title`, `ai-title` or `summary` line within the last 128 KiB of its transcript, or OpenCode's session title once it is not the placeholder. A summary replaces a prompt-derived title at once and a summary-derived one at most every `LIMITS.titleRefreshTurns` (5) prompts. The text is redacted (SPEC section 7.8), collapsed to one line and clipped to 64 characters; it is not audited. An inferred title never replaces a title set explicitly; an explicit `title` replaces an inferred one, and clearing it lets inference fill it again. Harnesses that expose neither (for example Codex, which names no session) get only the prompt-derived title. A subagent endpoint's inferred title is the description its root gave it (`subagent_title`, SPEC section 6.9).
- **Wake.** How an idle agent is woken by a message: `channels` (the MCP server pushes it by channel, SPEC section 8.4), `pi` (the same, to the pi extension, "Harness bindings"), `opencode-plugin` (the OpenCode plugin's waiter), `codex-app-server` (the `swarm codex` launcher), `claude-inbox` (the MCP server queues it on the Claude Code session's own inbox socket), `agy-resume` and `grok-resume` (the `swarm agy` and `swarm grok` launchers run a headless turn that resumes the conversation, "Harness bindings"), `muse-serve` (the `swarm muse` launcher), `t3code` (the `swarm t3code` launcher, "Harness bindings"), `spawn-resume` (a `swarm spawn` holding its exited worker, "Spawn launcher") or `none`. `wake {via}` sets it for the caller's endpoint: an agent's own session, a hook of its holding process, or a connection bound to it by its own harness process (`observe` with `self`, or with a grant); another lineage-bound connection is `unauthorized`, an unknown value or a non-agent endpoint `invalid_params`. A hook of another process changes nothing. `none` clears it. The result is `{changed}`. The connection that sets it is the endpoint's waker (SPEC section 9.4). A leave and an incarnation clear it, and so does the session's end (a hook's `session_end`, its harness process exiting, its spawn exiting) while no waker lives, and its last waker leaving once a hook waker's grace ran out. The reference MCP server, when started with channels enabled (SPEC section 8.4), sends it after its `hello` once `initialize` said the client takes channel pushes (or the reference launcher started it with channels loaded): `pi` when the client's `clientInfo.name` is `pi`, else `channels`, and again on every reconnect; a Claude Code client (`clientInfo.name` `claude-code`) without channels loaded, as in a background session, whose environment names `CLAUDE_CODE_MESSAGING_SOCKET` gets each delivery queued as its next turn on that socket (an `auth` line with `CLAUDE_CODE_MESSAGING_TOKEN` when set, then one `user` line with its `session_id`) and `claude-inbox`; the codex launcher's channel sends `codex-app-server` on its connection bound to the mounted server's endpoint; the agy and grok launchers' channels send `agy-resume` and `grok-resume` on the endpoint they hold; the muse launcher's channel sends `muse-serve` on its connection bound to the session's endpoint; the t3code launcher's channel sends `t3code` on the endpoint it holds; a spawn holding its worker sends `spawn-resume`, with `ref` when durable, on the connection that holds it; the OpenCode plugin's waiter sends `opencode-plugin` after its `hello`, from load on, and opens a session for a message that arrives before any is open; `swarm opencode [--name N | --as N]` runs OpenCode with `SCP_NAME=N`, harness `opencode` and wake on, and refuses to start without the current plugin. A client that cannot wake its session sends nothing, and the endpoint reads at its next turn. A failed `wake` never fails the connection. The bridge mirrors it with the agent's view; a hub keeps a value it does not know as none. While the agent is hibernated (SPEC section 19.1) its view shows `wake: "hook:<provider>"` instead, a value `wake {via}` never takes, and `wake_failed` (the reason) after a failed wake hook run or `wake_declined` after a declined one.
- **tl;dr reminder.** The note is the agent's tl;dr. A prompt-submit hook sends `prompted {tldr_every}`, from `SCP_TLDR_EVERY` (reference default 10, 0 disables). When at least that many prompts passed since the note last changed or the last reminder, the result carries `tldr: true`, the reminder counts, and the hook appends one line to what it injects: ``SCP: update your tl;dr with `swarm set-now "..."` or relay_set_now (what you are doing now).``

### Listing

The CLI shows only live endpoints (online, idle or hibernated) and the human by default, offline ones too with `--all` (`all: true`), and folds root agents that have no children (other than the caller) into one count line unless `--all` or `--roots` is given. The MCP `relay_list` shows live agents only, and offline ones too with `all`. The CLI's `list` has a `WAKE` column: the agent's wake (`hook:<provider>` while hibernated), `turn` for an agent without one, `-` for the human.

## Hosted-relay profile

- Credentials. The hosted relay issues two kinds, told apart by prefix: a device credential `scp_d_<secret>` from the device login below, bound to the member who approved it, and an API token `scp_t_<secret>` minted in the relay's console for ambient agents, which carries the label `token=<name>`. A credential is at most 128 characters. A hub MAY use other formats; a client treats the credential as opaque.
- Device login (an RFC 8628 profile). Bodies are JSON objects in both directions (an empty body counts as `{}`; form encoding is not accepted).
  - `POST /v1/device/code` takes `{label?}`, a machine-name-shaped label for the credential (default `cli`; the CLI sends the machine name), and answers `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}` (`user_code` `XXXX-XXXX`, `expires_in` 900, `interval` 5).
  - A person signed in to the relay's console opens `verification_uri_complete`, picks an organisation they belong to (one with no organisation must create or join one first) and approves or denies.
  - The client polls `POST /v1/device/token` with `{device_code}` (any `grant_type` is ignored) no faster than `interval`. Until approval the answer is 400 `{error: "authorization_pending", error_description}`; other errors are 400 with `error` `invalid_grant` (unknown or already redeemed code), `access_denied` or `expired_token`, and end the flow. A client SHOULD also honour `slow_down` by adding 5 s to its interval. Success is 200 `{access_token, token_type: "Bearer", credential_id, org, email, label, relay}`; `access_token` is the credential.
  - `GET /v1/whoami` with the bearer header checks a credential: 200 `{kind: "device" | "token", org, email, role, label, ambient, endpoint_labels, expires_at}` (`endpoint_labels` are the credential labels the hub forces on endpoints, below), or 401 as above.

## Bridge and contacts

- The CLI sets the `machine` label on claims to the host name; a linked broker rewrites it to its machine name.
- The bridge configuration lives in `cloud.json` in the relay directory; `mirror_local` defaults to on.
- The CLI sends `bridge_relink` after `login`, `cloud enable` and `up`.
- The reference hub reads contacts through a host link; contact management belongs to the host and is not part of the reference implementation. The hosted relay has no such link: an address of another account is not found there and `list {contacts}` is empty.
- The CLI only lists contacts' endpoints (`list --contacts`).

## Mesh

- The mesh is off until `swarm mesh init`, and while `mesh.json` says `enabled: false`. A CLI built without the mesh warns once when `mesh.json` enables it and runs without it.
- Key files: `account.key` is `{v: 1, account, public, private}` (43-character base64url JWK `x` and `d`); `machine.key` is `{v: 1, public, private}`.
- Files live under `<state dir>/mesh` (directory mode 0700): `mesh.json` (`{v: 1, enabled, account, machine, listen, peers}`), `account.key` and `machine.key`, mode 0600.
- The peer list in `mesh.json` is re-read every 5 s.

**CLI.** `swarm mesh <verb>`:

| Verb | Effect |
| --- | --- |
| `init [--account <handle>] [--account-key <file>] [--machine <name>] [--listen <host:port>] [--force]` | Needs `--account` or `--account-key` (which must agree); `--machine` defaults to the short hostname. Creates or imports `account.key` (an existing key for the same account is kept), ensures `machine.key` and writes `mesh.json` (`enabled: true`). An existing `mesh.json` needs `--force`, which keeps its peers. |
| `add-peer <host:port>` | Adds a peer to `mesh.json`. |
| `rm-peer <host:port>` | Removes a peer from `mesh.json`. |
| `listen <host:port\|off>` | Sets or clears `listen` in `mesh.json`. |
| `on`, `off` | Enables or disables the mesh in `mesh.json`. |
| `status [--json]` | Shows `mesh.json` and live state from `cloud_status`, which gains `mesh {account, acct, listen, peers, links, machines}`. |
| `help` | Prints usage; every verb also takes `--help`. |

Changes take effect when the broker restarts, except peers, which are re-read every 5 s.

## Judge

- The reference hub takes the egress and ingress sides as a pluggable cross-account gate that passes by default; the hosted-side behaviour of SPEC sections 15.5 to 15.7 is not part of the reference implementation. The hosted relay does not federate and judges only on the `local` side.

### Model call

- The body is passed between per-call nonce delimiters `<<<RELAY_DATA_<nonce>>>`.
- Verdicts are cached in memory (at most 1000): `pass` and `redact` for 24 h, `refuse` for 1 h.
- Model providers: `openai`, `openrouter` and `anthropic`.

### Hosted relay judge

- The hosted relay's judge is a `local`-side judge per org, off until an org owner turns it on in the console. The policy is fixed (`enforce`, fail `open`, `timeout_s` 12, effort `medium`, boundary `*` to `*`, no budgets or hold cap); the deployment sets the provider (`openrouter` by default, `openai` or `anthropic`), the model and the key, with no default model. Without a model or a key nothing is judged, pre-filter included.

- Local holds are swept every 10 minutes; holds of the egress and ingress gates every 15 minutes.

## Wakers and runners

- The broker refuses `hibernate` for a provider with no configured waker, `invalid_params` "no waker `<p>` is configured".
- The broker's presence check (every 60 s) retries a due wake hook for a hibernated endpoint with unread mail.
- `swarm hibernate` requests a hibernation from the agent's shell.
- The broker started by `swarm daemon` has the waker of provider `spawn` built in (`swarm spawn-wake`, timeout 60 s), so a durable spawn needs no `wakers.json`; an entry `spawn` there replaces it.

### Wake hooks

Before delivering to a hibernated local agent the broker runs its provider's waker, which resumes the session; the session then reclaims its endpoint and drains its queue.

- **Configuration.** `~/.config/scp/wakers.json`, beside the policy file, maps provider names to `{command: [argv...], timeout_s?}`; other fields are ignored. A name matches `^[a-z0-9][a-z0-9-]{0,31}$`; `command` is a non-empty list of strings, run without a shell; `timeout_s` is whole seconds, 1 to 3600, default 60. The broker reads the file again when it changes. A malformed file is logged once and configures nothing.
- **Trigger.** Every delivery to a local endpoint, a bridge's inbound delivery, a judge release and a handback runs the waker when one is due: the endpoint is hibernated and local, has an unread message, no run of its waker is in flight, and none ran within `LIMITS.wakeDebounceS` (60 s); after `n` failed runs in a row the wait is `min(LIMITS.wakeDebounceS * 2^n, LIMITS.wakeBackoffMaxS)` (900 s). The waker never blocks the delivery.
- **Input.** stdin is one JSON line, then end of input: `{"scp": 1, "event": "wake", "endpoint": <address>, "handle", "provider", "ref" (string or null), "machine", "message": {"id", "from", "kind", "thread", "created_at"}, "unread": <count>}`, from the newest unread message. It never carries a body, attachments or a credential. The environment is the broker's plus `SCP_WAKE_ENDPOINT`, `SCP_WAKE_HANDLE`, `SCP_WAKE_REF`, `SCP_WAKE_PROVIDER`, `SCP_WAKE_MESSAGE_ID`, `SCP_WAKE_FROM`, `SCP_WAKE_KIND`, `SCP_WAKE_THREAD`, for provider `spawn` the run's one-time wake ticket `SCP_WAKE_TICKET` (SPEC section 19.2), and `SCP_DIR` naming the broker's state directory, so the waker's own `swarm` calls reach this broker.
- **Result.** Exit 0 means the provider is resuming the session. Any other exit, a waker that cannot start, or one still running after `timeout_s` (its process group is killed) is a failure: the endpoint stays hibernated, its message stays queued, and its view shows `wake_failed` with the reason (`exit <code>` and the last line of stderr, or the timeout). A success clears the failure count and note; the hibernation itself clears only when the session reclaims its endpoint (SPEC section 19.1).
- **Decline.** Exit 77 with `{"declined": "<reason>"}` on stdout declines the wake: not a failure. The reason is a token the provider picks (SPEC section 19.1). The endpoint stays hibernated with its message queued, its view shows `wake_declined` with the reason, deliveries to it show `wake: "declined"`, and the failure count and backoff do not move. No further run happens for that message or another of its sender; a newer message from another sender, or a new `hibernate`, runs it again. Exit 77 with anything else on stdout is a failure.
- **Owner.** The waker runs on the broker of the account that owns the hibernated endpoint, with that user's local privileges. Any credentials the resumed session needs are the waker's to provision, from that account only (SPEC section 19).
- **Audit.** Each run is audited `wake {target, provider, ok, code?, ms, declined? | error?}`, the error cleaned, redacted and cut to 200 characters; never a body or the ref. Watchers see the endpoint's presence event with `wake_failed` or `wake_declined`.
- **Built-in spawn waker.** `swarm spawn-wake` reads the request above and parses `ref` as a durable spawn wrote it ("Spawn launcher"). A ref it cannot parse, an unknown harness or a missing directory exits 77 with `{"declined": "unresumable"}`. Otherwise it starts a detached runner in the worker's directory and exits 0 once the runner holds the endpoint, or 1 with the reason when the runner could not take it back within 10 s. The runner claims the handle `exact`, with the ref's harness, its own process key, a fresh `SCP_SESSION`, the ref's `cwd` and `ticket` from `SCP_WAKE_TICKET`, which takes the row back as its resumed session, labels, groups, peek and all (SPEC sections 6.4 rule 6 and 19.2); it retries while the spawn that hibernated the worker still lets go. Without a ticket it fails. The resumed harness never sees the ticket. It then holds the endpoint as a spawn does, durably with the same ref, and its first resumed run carries the unread messages. Each run hands back with `send {to: <parent>, kind: "message", body, reply_to?}` as the worker, over a second connection resumed with the claim's token before the first run (a run's hooks replace the token; `spawn_end` closes only the holding connection, so a run in flight still hands back), the body of a linked worker's handback ("Runners"), then sets `done` with `exited <code>`. It lets the endpoint go after the ref's idle time, hibernating it again. The resumed harness runs with the broker's environment (`swarm daemon` keeps `PATH`, `HOME`, the locale, `TMPDIR`, `USER`, `LOGNAME`, `XDG_CONFIG_HOME` and the relay's own variables), so a harness reads its credentials from its own configuration under `HOME`, never from the ref.

### Machine waker

- `swarm machine wake-url <url> [--secret-env VAR]` registers the machine's webhook (`machine_wake {url, secret}`), the secret read from `$VAR`, default `SCP_MACHINE_WAKE_SECRET`, never from argv; `swarm machine wake-url --clear` clears it.
- A hub embedded in a provider's platform takes an optional `machineWake(event)` function in place of registered URLs (the `RelayHub` dependency), called in-process for any machine with the payload object below and answering `{ok, status?, declined?}`; no url or secret is stored. Without it, the registered webhook is used.

### Runners

A runner starts a spawn on another machine of the same account (`swarm spawn --via <runner> [--name N] [--title T] [--labels K=V,...] -- <harness command>`). The runner is the whole spawn hand-off: it picks or boots the machine, provisions the harness's credentials there and starts the harness. The worker shows under its spawner through a cross-machine link (SPEC section 6.12) and hands its result back as a message.

- **Configuration.** `~/.config/scp/runners.json`, beside the policy file (`$SCP_RUNNERS_FILE` overrides the path), maps runner names to `{command: [argv...], timeout_s?}`; other fields are ignored. A name matches `^[a-z0-9][a-z0-9-]{0,31}$`; `command` is a non-empty list of words, run without a shell; `timeout_s` is whole seconds, 1 to 3600, default 60. An unknown runner is a usage error naming the configured ones.
- **Spawner.** `--via` mints no grant and runs no local harness. It takes `--name`, `--title`, `--labels` and `--json` (and `--as` or `--harness` for the spawner's identity, and `--bg`); any other flag is a usage error. The spawner has to be an agent of a broker linked to a hub (SPEC section 14.2), since a session on another machine shows under it only through the hub; otherwise it is a usage error. Name and title default as in "Spawn launcher".
- **Request.** The runner's `command` starts detached, with the spawner's environment minus its identity variables ("Spawn launcher"), and reads one JSON line on stdin, then end of input: `{"scp": 1, "event": "spawn", "name", "title" (string or null), "cmd": [argv...], "cwd", "parent": "me/<machine>/<handle>", "labels": {...}, "join": {"under": <parent>, "name": <name>, "mode": "account"}}`. `parent` is the spawner's full address on its own machine. The request carries no grant, token or other credential.
- **Exit.** Exit 0 means the worker started: the spawn prints the worker's name and returns at once. On exit 0 the runner may print one JSON object on stdout, `{"address": "me/<machine>/<name>", "machine": "<machine>", "ref"?: "<opaque>", "attach"?: "<command line or URL>"}`. `ref` is at most 256 printable ASCII characters. `attach` opens the remote session's terminal (for example `ssh vm-3 -t tmux attach -t w1`): one line of at most 1024 characters without control characters. Either is dropped when it looks like a credential (SPEC section 7.8). The spawn shows `address` and `machine`, then `attach: <attach>` on its own line, and with `--json` prints `{name, runner, parent, address?, machine?, ref?, attach?}`. A reply that is absent, not that object, has a malformed field, or names another worker or machine is ignored. Any other exit fails the spawn with that code and the runner's cleaned, redacted stderr tail (at most 2048 bytes). A runner still running after `timeout_s` is sent `SIGTERM` (its process group) and the spawn fails with code 124. A runner that cannot start fails with 127 (not found) or 126.
- **Join mode `account`.** The machine the runner picks has to be logged in to the same account (its own device login or API token) with its broker bridged to the hub. The worker joins as a root of that machine's tree, linked under `join.under` by `parent_addr` (SPEC section 6.12).
- **Launcher.** On the remote machine the runner runs `swarm spawn --name <name> --under <parent> -- <cmd...>`. When `--under` names `me/<machine>/<handle>` of another machine than the broker's own (the broker has to be linked to a hub, else it is a usage error), spawn runs linked: it mints no grant (grants are per broker) and refuses scope and grant flags (`--scope`, `--rules`, `--in`, `--out`, `--allow`, `--group`, `--ttl`, `--peek`, `--no-push`), identity flags and `--via`. The worker's environment is the spawner's minus its identity variables, plus `SCP_NAME=<name>` and `SCP_UNDER=<parent>`, so the worker's own claims carry `under` (SPEC section 6.4). An address of the broker's own machine keeps the grant spawn of "Spawn launcher".
- **Handback.** When the harness exits, the spawn claims `<name>` exactly as the worker (the harness of the command, its `cwd`, `under` the parent), sends the parent one `message` whose body follows SPEC section 9.3 (`worker <address> finished (exit <code>)` and the cleaned output, or `worker <address> exited without replying (exit <code>)`, then the stderr part after a non-zero exit), and sets its status `done` with note `exited <code>`. A harness that never started hands nothing back.
- **Limits.** The handback is an ordinary cross-machine message from the worker, routed through the hub and subject to scope, judging and send limits: there is no steer key, stop push, `spawn_steers` resume or `steer not applied` lines, and no grant caps reach across machines. The worker is a root of its own machine linked by `parent_addr`, with the limits of a cross-machine link (SPEC section 6.12).
- **Deferred.** A hub-minted one-time join grant, bound to the account, the parent, the name and a TTL, so the remote machine needs no standing account login; optional runner `stop` and `status` commands (stdin `{"scp": 1, "event": "stop" or "status", "name", "address", "ref"?}`, status answering `{"state": "running" | "hibernated" | "gone"}`) and a CLI verb to call them; `via` on the MCP spawn tool; showing `attach` in `list` and `peek`, which needs it stored with the endpoint.

## Defaults

- The spawn grant TTL is 3600 s.
- A spawn holds a resumable worker for 1800 s without a message when detached or `--durable`, and not at all in the foreground unless `--idle` is given (`SPAWN_IDLE_S`). The built-in spawn waker times out after 60 s and its runner tries to take the endpoint back for 10 s.
- The push wait defaults to 600 s (0 to 3600).
- The hosted relay removes every cap, count, rate and size limit here (durations keep their defaults) and the judge's budgets and hold cap; its only throttle is Turnstile on the sign-in form that emails a code.

## CLI verbs

`swarm [--as <handle>] [--harness <h>] [--human] [--json] [--cloud] [--machine <name>] <verb>`

| Verb | Wire |
| --- | --- |
| `whoami` | `hello` |
| `list [--all] [--tree] [--roots]`, `list --contacts` | `list`, `list {contacts}` |
| `peers [--all] [--roots]` | `peers` |
| `send <to> [text or -] [--reply-to <ref>] [--thread <t>] [--private] [--attach <path>]... [--live]` | `message`, `send` |
| `reply <ref> [text or -]` | `message {member}`, `send {kind: reply}` |
| `ask <to> [text or -] [--wait <s>] [--require-reply] [--thread <t>] [--private] [--attach <path>]...` | `ask` |
| `ask-wait <id> [--wait <s>]` | `ask_wait` |
| `inbox [--wait <s>] [--keep]` | `inbox`, `ack` |
| `ack <ref>... or --all` | `message`, `ack`; `--all` pages `inbox` |
| `show <ref>` | `message`; prints one delivered message whole, read state unchanged |
| `status [--all] [--activity]`, `status <id>`, `watch`, `log [--since <n>] [--limit <n>] [--scope or --judge or --peek]` | `snapshot`, `receipts`, `watch`, `log` |
| `set-status <state> [note]`, `set-now <text>`, `set-title <text>`, `event <kind> [--tool <t>] [--summary <s>]` | `status`, `status {note}`, `title`, `event` |
| `join [<handle>] [--under <parent>] [--harness <h>]`, `leave [--endpoint <ep>]`, `name [<handle>] [--endpoint <ep>] [--take-over]` | `hello {transient, claim, join}`, `leave`, `rename` (SPEC section 6.12); `name` alone prints the session's address |
| `adopt <child> [--parent <p>]`, `link accept <id>`, `unlink [<child>]` | `adopt`, `link_accept`, `unlink` (SPEC section 6.12) |
| `rules show or set or widen or lift [<endpoint>] [<cap>] [--in] [--out] [--scope] [--allow]`, `why <from> <to>` | `rules*`, `why` |
| `group create or add or rm or rules or ls or show or drop or pin or unpin [<name>] [<endpoint>] [--rules] [--in] [--out]` | `group` |
| `admin grant or revoke <endpoint> --tree <root> or --group <name>`, `admin ls` | `admin` |
| `spawn-env [--name] [--title] [--scope] [--rules] [--in] [--out] [--allow] [--group] [--under] [--ttl] [--peek local]` | `grant` |
| `spawn [spawn-env flags] [--labels <k=v,...>] [--handback-bytes <n>] [--no-push] [--bg or --fg] [--idle <s or Infinity>] [--durable] [--] <command...>` | `grant {spawn}`, `spawn_steers`, `spawn_exit`; holding a worker: `hello {claim}`, `wake {via: "spawn-resume", ref?}`, `inbox {offer}`, `injected`, `hibernate` ("Spawn launcher") |
| `end <worker>` | `spawn_end` (SPEC section 9.5): lets go of a worker a spawn holds or a durable spawn hibernated |
| `spawn-wake`, `spawn-wake --run` | none from the user: the broker's built-in `spawn` waker and its runner ("Wake hooks") |
| `spawn --via <runner> [--name] [--title] [--labels <k=v,...>] [--json] [--] <command...>` | `cloud_status`, then the runner ("Runners") |
| `spawn --under me/<machine>/<handle> [--name] [--title] [--labels] [--handback-bytes <n>] [--bg or --fg] [--] <command...>` | `cloud_status`, then `hello {claim {under}}`, `send`, `status` as the worker ("Runners") |
| `peek <endpoint> [--turns <n>] [--full]`, `peek --who [<endpoint>]`, `set-peek on or local or off [<endpoint>]` | `peek`, `peek_who`, `peek_set` |
| `holds [ls [--all]]`, `holds show <id>`, `holds release <id> [--redacted]`, `holds refuse <id> --reason <text>` | `holds`, `hold_show`, `hold_release`, `hold_refuse` |
| `policy show or path or check <from> <to>` | `policy`, `hello` (path), `policy_check` |
| `daemon [--idle <d>] [--policy <file>]`, `daemon stop or restart` | runs the broker; stops it (SIGTERM to the lock's pid, checked against its command line) or replaces it |
| `relay use <url> or show`, `login [--token <t>] [--label <name>] [--no-browser]`, `logout` | local configuration; `login` checks a token with the hub's `GET /v1/whoami` or runs the device flow (`/v1/device/code`, `/v1/device/token`), then `bridge_relink` to a running broker |
| `cloud enable [--machine <name>] or disable or status`, `up [--token <t>] [--label <name>] [--machine <name>] [--no-browser]` | bridge configuration; `bridge_relink` after `enable`; `cloud_status`; `up` logs in if needed, runs `cloud enable` and `setup --write`, then `bridge_relink` |
| `machines [rm <name>]` | hub `machines`, `machines_rm` |
| `hibernate --wake <provider> [--ref <ref>] [--eta <s>] [<endpoint>]`, `hibernate --all --wake <provider> [--ref <ref>] [--eta <s>]`, `hibernate --wake none or --gone [<endpoint>]` | `hibernate` (SPEC section 19.1); prints each endpoint and its presence, and whether the hub has it |
| `machine wake-url <url> [--secret-env <var>]`, `machine wake-url --clear` | `machine_wake` (SPEC section 19.3); the secret comes from `$<var>` (default `SCP_MACHINE_WAKE_SECRET`) |
| `mesh <verb>` | SPEC section 14.8 (experimental) |
| `mcp [--as <h>] [--harness <h>] [--channels]`, `mcp install --harness <h> [--as <h>]` | the MCP shim (see "MCP server"); `install` prints the mount command |
| `hooks install --harness <h> [--scope project or user or local] [--write or --print] [--block-stop-on-unread] [--push-wait <s>]`, `hook <harness> [event]` | see "Harness bindings" |
| `setup [--write] [--undo] [--no-hooks] [--block-stop-on-unread] [--join auto or manual] [--bin <path>] [--harness <h>]` | see "MCP server" and "Harness bindings" |
| `claude [--name N or --as N] [--] [claude args...]`, `codex [--name N or --as N] [--headless] [--resume <thread>] [--] [codex args...]`, `pi [--name N or --as N] [--] [pi args...]`, `opencode [--name N or --as N] [--] [opencode args...]`, `agy [--name N or --as N] [--] [agy args...]`, `grok [--name N or --as N] [--] [grok args...]`, `muse [--name N or --as N] [--resume <session>] [--approval-mode <mode>] [--] [muse serve args...]`, `t3code [--name N or --as N] --thread <thread> [--base-dir <dir>]` | launchers (see "Harness bindings") |
| `help [<verb>] [--all]`, `<verb> --help`, `version` or `--version` | none; `version` prints the installed package's version, read from its `package.json` at run time |

A launcher consumes only its own flags and passes every other argument to the harness: `claude`, `pi`, `agy` and `grok` read a leading `--name` or `--as`; `codex` reads `--name`, `--as`, `--headless` and `--resume`, `opencode` reads `--name` and `--as`, and `muse` reads `--name`, `--as`, `--resume` and `--approval-mode`, anywhere before a `--`; `t3code` takes only `--name`, `--as`, `--thread` and `--base-dir`, and refuses any other argument. Each launcher always wakes its session ("Harness bindings"). A command whose stdout reader goes away (`swarm status | head -1`) exits 0 quietly.

## MCP server

The MCP server speaks JSON-RPC 2.0 over stdio (lines up to 4 MiB; protocol versions 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05), binds with `hello` (resuming with its token after a reconnect), sets status `working`, sends `wake {via}` once `initialize` shows whether the client takes channel pushes (SPEC section 11.1), and sends `whoami` every 30 s. Errors are returned as tool results marked `isError` with text `<code>: <message>`.

| Tool | Parameters | Wire |
| --- | --- | --- |
| `relay_whoami` | | `whoami` |
| `relay_list` | `all?`, `contacts?` | `list` |
| `relay_peers` | `all?` | `peers` |
| `relay_send` | `to` (1 to 16), `body`, `thread?`, `private?`, `live?` | `send` with a `client_id` |
| `relay_link_accept` | `id` | `link_accept`, accept a link request (an adopt of a child under another parent, SPEC section 6.12) and sit under its sender as a worker |
| `relay_join` | `name?`, `under?` | `hello {transient, claim, join}` on a fresh connection, then the shim's own claim |
| `relay_leave` | | `leave`; the shim then claims nothing until a join |
| `relay_status` | `id` (id, short id or `last`) | `receipts` |
| `relay_spawn` | `command` (argv, at least one word) or `harness` (`claude`, `codex`) with `task` and `model?`; `name?`, `title?` (at most 64), `no_push?`, `handback_bytes?` (1 to `LIMITS.handbackBytes`), `cwd?` (absolute, an existing directory) | `whoami`, then the spawn operation ("Spawn launcher") in the background, as the caller |
| `relay_reply` | `id` (id, short id, suffix of 4 or more, or `last`), `body` | `message {member}`, `send {kind: reply}` |
| `relay_inbox` | `wait_s` (0 to 50), `ack` (default true) | `inbox`, `ack` |
| `relay_ask` | `to`, `body`, `wait_s` (default 30), `require_reply?` | `ask` |
| `relay_ask_wait` | `id`, `wait_s` (default 30) | `ask_wait` |
| `relay_set_status` | `state`, `note?` | `status` |
| `relay_set_now` | `now` | `status {note}` |
| `relay_set_title` | `title` (at most 64) | `title` |
| `relay_rules` | `action` (`show`, `set`, `widen`, `lift`, `why`), `endpoint`, `in`, `out`, `scope`, `allow`, `cap`, `from`, `to` | `rules*`, `why` |
| `relay_group` | `action`, `name`, `endpoint`, `rules`, `in`, `out` | `group` |
| `relay_peek` | `endpoint`, `turns` (1 to 10), `full?`, `who?` | `peek`, `peek_who` |
| `relay_set_peek` | `on` | `peek_set` |

- `relay_spawn` is listed only when the server is given a way to spawn. Without `cwd` the worker runs in the caller's working directory when that exists. `harness` builds `claude -p <task>` or `codex exec <task>`, with `--model <model>` when given. It returns the worker's name and its runner's pid once its harness started; a failed spawn is a tool error carrying the spawn's message.
- `relay_send` adds a line pointing to `relay_status` with the message's short id when a recipient's state is `running` or `starting`.
- `relay_inbox` precedes a message with `shown_at` by the line `(a hook already showed you this at <HH:MM:SS>; that copy may reach you after this call)`.

With `--channels`, the server advertises the `claude/channel` experimental capability and pushes messages as `notifications/claude/channel` (SPEC section 8.4). It pushes only to a client that declares the capability, or to the Claude Code that `swarm claude [--name N or --as N] [--] [claude args...]` started: the launcher adds `--dangerously-load-development-channels server:scp` after the user's arguments (before any `--`), unless they already name `server:scp`, and runs claude with `SCP_CHANNELS=<its pid>` (and `SCP_NAME=N` when named); the server pushes when its harness's parent is that pid. The launcher refuses to start when Claude Code has no `scp` mount with `--channels` at user, local or project (`.mcp.json`) scope, or when `--strict-mcp-config` comes without `--mcp-config`; with `--mcp-config` it trusts that configuration and warns. Without `--name`, in auto join mode, and unless the arguments set a system prompt, it also passes `--append-system-prompt` asking the session to pick a name with `swarm name <name>`. Any other client keeps the hook path, since a push marks the delivery injected. `setup` mounts Claude Code's server with `--channels`.

## Harness bindings

All hooks run `swarm hook <harness> [event] [--block-stop-on-unread] [--push-wait <s>] [--no-inject] [--subagent] [--wake <s>]` with the harness's JSON payload on standard input (at most 8 MiB). The event is read from the payload (`hook_event_name` or `hookEventName`), else from the argument. With `--wake <s>` the hook is a waiter: it sends `wake {via: "opencode-plugin"}`, waits up to `<s>` seconds (at most `LIMITS.waitMaxS`) with `inject {wait_s}`, and prints what it is offered as a prompt-submit reply.

The Wake column is the `wake` value the endpoint advertises (SPEC section 11.1); with none, an idle session reads new messages at its next turn.

| Harness | Events | Context output | Stop output | Stop push | Subagents | Wake |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | SessionStart, UserPromptSubmit, PostToolUse (`*`, plus a `--subagent` handler), Stop (`--push-wait 600`, timeout wait plus 30 s), SubagentStop (plus an async `--subagent` handler), SessionEnd | `{"hookSpecificOutput":{"hookEventName":<event>,"additionalContext":<text>}}` | Version 2.1.163 or later: the same with `"hookEventName":"Stop"`; earlier: `{"decision":"block","reason":<text>}` | yes | yes | `channels` under `swarm claude`; `claude-inbox` in a background session (`swarm claude --bg`); else none |
| Codex | SessionStart, UserPromptSubmit, PostToolUse, Stop (as Claude Code), SubagentStop (activity only), SessionEnd | as Claude Code | `{"decision":"block","reason":<text>}` | yes | no | `codex-app-server` under `swarm codex`; else none |
| Grok | Claude Code's hooks, labelled by environment | as Claude Code; injection after tools only | `{"decision":"block","reason":<text>}` | yes | no | `grok-resume` under `swarm grok`; else none |
| Muse | Plugin manifest: SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd | as Claude Code | `{"decision":"block","reason":<text>}` | yes | no | `muse-serve` under `swarm muse`; else none |
| T3 Code | Its provider's hooks (codex, Claude Code), labelled by environment and process | as the provider | as the provider | as the provider | as the provider | `t3code` under `swarm t3code`; else none |
| Gemini / Antigravity (agy) | SessionStart, PreInvocation (prompt), PostToolUse (activity only), Stop (only when the termination reason is `NO_TOOL_CALL`) | `{"injectSteps":[{"ephemeralMessage":<text>}]}`; `{}` when empty | `{"decision":"continue","reason":<text>}`; directives as a count and pointer | no | no | `agy-resume` under `swarm agy`; else none |
| pi | Extension: mounts `swarm mcp --harness pi --channels` and registers its tools as pi tools | none; messages arrive by channel push | none | no | no | `pi`, unless `SCP_PI=0` |
| OpenCode | Plugin: tool execution (text appended to the tool output), chat message (synthetic text part), session created, session idle, session status | as Claude Code; prompt shows an unread pointer only | Emulated: on idle, a held stop's text (`{"decision":"block","reason":<text>,"unread":<n>}`) is submitted as a new prompt | no | child sessions as activity | `opencode-plugin`, unless `SCP_WAKE=0`; always under `swarm opencode` |

Claude Code wakes only under `swarm claude [--name N | --as N] [claude args...]` (see "MCP server"): its MCP server, mounted with `--channels`, pushes each message as a channel notification and advertises wake `channels`. The launcher refuses to start when Claude Code has no `scp` mount with `--channels`, or with `--strict-mcp-config` and no `--mcp-config`. `swarm claude --bg [--name N] [claude args...]` starts a background session (`claude --bg`), whose environment is Claude Code's daemon's, not the launcher's, and which loads no channels: it passes `--mcp-config` with a file (mode 0600, under `$SCP_DIR/claude-bg/`) holding one server named `scp`, the user's mount with `--channels` (else the CLI's own `mcp --harness claude --channels`) with `SCP_NAME=N` (else `$SCP_NAME`), `$SCP_GRANT` (empty when unset, so a grant in the daemon's environment never applies), and `SCP_LABELS`, `SCP_DIR` and `XDG_STATE_HOME` when set, in its `env`. That server replaces the user's `scp` mount for the session, so one shim runs, claims the name and the grant (under `env $(swarm spawn-env --name N)` the session links under the caller) and wakes it as `claude-inbox`. Claude Code also gets `--name N` and no development channels. The launcher prints the short id and the address, and links `<short id>.json` to the file. `swarm claude attach <id|name> [--name N]` runs `claude attach`, first renaming the session's endpoint to N (`swarm name --endpoint`) and the name in its file, which a resumed session claims. `swarm claude --resume <id>` of a live background session says it is already woken through claude-inbox and attaches to it. Any other Claude Code session reads new messages at its next turn.

Claude Code passes on at most 8000 characters and 200 lines of a hook's `additionalContext`, and 2000 characters and 20 lines of a `reason`, cutting longer text mid-line. The Claude Code hook fits its text within those caps itself: it cuts relay message bodies from the last one back, and ends each cut body with `[truncated, <n> more chars: swarm show <short id>]`, so the agent can read the whole message.

The pi extension (`@scp-dev/pi`, bundled in the CLI and run by `swarm pi [--name N | --as N]`, which starts `pi --extension <file>` with `SCP_HARNESS=pi`; `SCP_PI=0` turns it off) declares the `claude/channel` capability and hands each pushed message to pi as a custom message with `deliverAs: "steer"` and `triggerTurn: true`: it steers a running turn after its tool calls, and starts a turn on an idle session. A resumed session (`pi --continue`, `pi --session <id>`) receives the messages that arrived while it was closed. A new session in the same pi process starts its shim only once the previous one exited, and a shim that could not claim the endpoint is reported to the user. The reference MCP shim exits once its harness process is gone (it was reparented).

The OpenCode plugin wakes an idle session (wake binding `opencode-plugin`): while no root session of the process runs a turn, it keeps one `swarm hook opencode --wake 50` waiting and submits what it prints as a new prompt with `session.promptAsync`; a turn starting stops the waiter, and a waiter that printed has already confirmed its messages, so they are never injected again. `SCP_WAKE=0` turns it off.

`swarm codex [--name N | --as N] [--headless] [--resume <threadId>] [codex args...]` runs codex app-server on a private unix socket with the TUI attached via `--remote`, passing every other argument to the TUI and giving the app-server the configuration codex would resolve from them (the `--profile` file, `-c`, `--enable`, `--disable`, `--strict-config`, then `-m`, `-s`, `-a` and the bypass flag). The launcher's channel pushes each message, starting a turn on an idle top-level thread via `turn/start` or steering a running one via `turn/steer`. The channel confirms injection so turn-boundary hooks do not show the same message again. Approvals stay with the TUI. `--headless` runs an ambient worker without a TUI that owns one thread (`thread/start`, or `thread/resume` with `--resume <threadId>`), with approval policy `never`; it declines every approval request and prints the agent's messages to standard output. Without `--headless`, `--resume <threadId>` opens the TUI on `codex resume <threadId>`. The channel advertises wake `codex-app-server`; a message for a thread neither idle nor active stays queued and is retried every 2 s.

The codex launcher removes inherited `SCP_SESSION` and `SCP_PARENT`, preserves `SCP_GRANT`, and creates `SCP_SHIM_BINDING` ("Self-attestation of tool shells"). The app-server receives the grant and passes it to the mounted shim through `env_vars`; the shim spends it to take its parent and title. The channel binds with `hello {observe: true, self: [process], grant?, cwd}` instead of a second claim. With a grant, it retries `unauthorized` while the shim has not spent it, so it binds only when the grant authorizes that endpoint.

Muse loads hooks only from a plugin. `setup` writes the manifest to `~/.config/scp/muse-plugin/.muse-plugin/plugin.json`, then runs `muse plugins install <dir> --scope user` and `muse plugins approve scp`: Muse holds a new plugin's hooks for review, and a headless `muse exec` runs none of the held ones. Its MCP server goes under `mcpServers.scp` in `~/.config/muse/settings.json`. Muse passes plugin hooks a fixed environment with no `SCP_*` or `XDG_*` variables, so the hooks key the session by the harness process and reach the broker at its default path. `swarm spawn -- muse exec <task>` adds `--contributor-mode off` unless the command sets it, and refuses a mode other than `off` or `on`.

`swarm muse [--name N | --as N] [--resume <session>] [--approval-mode never|on-request|untrusted] [muse serve args...]` runs a headless Muse session that messages wake. Muse's TUI cannot attach to another process's session, and Muse wakes no model from a hook, so the launcher hosts the session itself: it runs `muse serve` (the Muse Session Protocol, JSON-RPC over stdio) with every other argument, adding `--contributor-mode off` unless they set a mode (refusing one other than `off` or `on`) and `--disable-request-user-input`. It starts a session in its working directory (`session/start`, approval mode `allowAll`, `onRequest` (the default) or `promptUnmatched` for the three values), or reopens one with `--resume` (`session/resume`). The launcher's channel pushes each message as `turn/start` with `ifBusy: "steer"`, which starts a turn on the idle session or steers the running one; one muse serve does not accept, it is retried every 2 s. The channel confirms injection, so the prompt hook does not show the same message again, and advertises wake `muse-serve`. It prints the agent's messages to standard output, declines every approval request the mode leaves to a human, and refuses other server requests. It refuses to start without an `scp` mount in Muse's settings, and exits non-zero when the session's shim has not joined within 30 s or muse serve exits.

Muse gives neither the shim nor the hooks the launcher's environment, and a session's own MCP server may not reuse the name `scp`. So the launcher writes the name (`--name`, else `SCP_NAME`) and `SCP_GRANT` to `<broker dir>/launch/muse-<pid>.json` (mode 0600), with the muse serve process key, and removes it when it exits; a Muse shim or hook whose environment sets neither `SCP_NAME` nor `SCP_GRANT` takes them from that file when its process key matches its harness process. Under `env $(swarm spawn-env --name N)` the session claims N and links under the caller. The broker is the default one under `HOME`, the one Muse's shim and hooks reach; with `SCP_DIR` or `XDG_STATE_HOME` set elsewhere the launcher says so. The channel binds as `swarm codex`'s does: `hello {observe: true, self: [process], grant?, cwd}` once the shim claimed the muse serve process.

agy reads hooks from `~/.gemini/config/hooks.json` (user) or `<repo>/.agents/hooks.json` (project) and MCP servers from `~/.gemini/config/mcp_config.json` or `<repo>/.agents/mcp_config.json`. A headless `agy -p <task>` denies MCP tools without `mcp(scp/<tool>)` rules in `permissions.allow` of `~/.gemini/antigravity-cli/settings.json`, which `setup` writes. The installed hooks name their harness in the argument (`swarm hook agy <event>`, `swarm hook muse <event>`). Without `--harness` or `$SCP_HARNESS`, the CLI and the MCP server detect agy from `ANTIGRAVITY_AGENT=1` or `ANTIGRAVITY_CONVERSATION_ID`, and Muse from `MUSE_SESSION_ID`.

`swarm agy [--name N | --as N] [--] [agy args...]` and `swarm grok [--name N | --as N] [--] [grok args...]` run the harness headless, one process per turn, and wake it by resuming its conversation. The launcher holds the endpoint itself: it claims it with a fresh `SCP_SESSION` (removing inherited `SCP_SESSION` and `SCP_PARENT`, keeping `SCP_GRANT`), `SCP_HARNESS` set to the harness and its own pid as `SCP_HARNESS_PID` ("Process keys and sessions"), runs the reference MCP server in process with channels and advertises `agy-resume` or `grok-resume`. Before the first turn it asks `relay_whoami` and runs each turn with `SCP_NAME` set to the handle it holds, so the turn's MCP server rejoins the endpoint and its hooks join the session. Turns run one at a time with standard input closed: a prompt flag in the arguments (agy `-p`, `--print`, `--prompt`; grok `-p`, `--single`, `--prompt-file`, `--prompt-json`) makes the first turn the arguments as given; without one the launcher waits, and the first message opens the conversation. Each later turn is the arguments without prompt and conversation flags, plus `--conversation <id> -p <text>` (agy) or `--resume <id> -p <text>` (grok), where the text is the messages pushed since the last turn started, each framed as a channel push (SPEC section 8.4), joined by a blank line. Grok's id is the user's `-r`/`--resume` or `-s`/`--session-id`, else a new UUID the first turn passes as `-s <uuid>`; the launcher also adds the `--allow` rules for the relay messaging tools unless the arguments hold `--allow`, `--allowedTools`, `--allowed-tools`, `--always-approve` or `--permission-mode`. agy cannot be given an id for a new conversation (it starts one under a fresh id when the named one is unknown), so the launcher learns it: it names a file in `SCP_AGY_CONVERSATION_FILE`, and the first agy hook to see a root conversation (a payload `conversationId`, else `ANTIGRAVITY_CONVERSATION_ID`, with no `parentConversationId`) creates that file with the id; it is never overwritten. The launcher resumes the recorded id, else the user's `--conversation`; with neither after a turn, it exits 1 saying the hooks did not report it. `swarm agy` refuses to start without the `scp` hook set holding `SessionStart` in the user's or the project's agy hooks, and warns when the permission rules for a headless agy are missing. Both refuse flags that open an interactive or ambiguous session (agy `-i`, `--prompt-interactive`, `-c`, `--continue`, `--input-format`, `--remote-control` and `remote-control`; grok `-c`, `--continue`, `--fork-session`): nothing local starts a turn in an interactive agy or grok session, so an interactive one is not woken and reads messages through its hooks. A turn that exits non-zero ends the launcher with its code; the messages it carried were marked injected, not read, so they stay unread in the inbox. A signal is passed to the running turn and ends the launcher. The channel confirms each message once, and a message an agy hook showed before a model call is not offered to the channel again (SPEC section 8.4), so no message is delivered twice; a message that arrives during a turn waits for the next one. `$SCP_AGY_BIN` and `$SCP_GROK_BIN` pick the binaries (default on `PATH`).

T3 Code runs no agent loop of its own: its server drives a provider (one shared `codex app-server` per codex instance, Claude Code through its agent SDK, and others), which loads its own MCP servers and hooks, so a codex or Claude Code session in T3 Code already has the `scp` mount and the hooks `setup` installs; `setup` reports T3 Code when it finds it and writes nothing for it. Its sessions claim harness `t3code`: a hook or MCP server whose harness is codex or Claude Code takes `t3code` when its environment sets `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=T3 Code` (T3 Code sets it for the codex app-server it starts, and codex hands it to hooks, not to MCP servers) or, unless `SCP_HARNESS_DETECT=0`, when the harness process's parent is a T3 Code server (the `t3` CLI, its native build, or the desktop app). Hook output keeps the provider's format. `swarm spawn` removes `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` from a worker's environment.

`swarm t3code [--name N | --as N] --thread <thread> [--base-dir <dir>]` holds an endpoint for one T3 Code thread and wakes it. It finds the server in `<dir>/userdata/server-runtime.json` (`<dir>`: `--base-dir`, else `$T3CODE_HOME`, else `~/.t3`; a file whose `pid` is not running counts as none) or at `$SCP_T3_URL`, and takes the token `$SCP_T3_TOKEN`, else one `t3 auth session issue --base-dir <dir> --scope orchestration:read --scope orchestration:operate --ttl 30d --token-only` prints (`$SCP_T3_BIN` picks `t3`). It connects to `GET /ws?orchestrationProtocol=2` with `Authorization: Bearer <token>` and speaks Effect RPC with JSON framing: `{"_tag":"Request","id","tag","payload","headers":[]}` answered by `{"_tag":"Exit","requestId","exit"}`, stream values in `Chunk` frames, each acknowledged with `Ack`, and `Ping` answered with `Pong`. It checks the thread with `orchestration.getThreadProjection` and follows its active run with `orchestration.subscribeShell`. Like the agy and grok launchers it holds the endpoint itself (a fresh `SCP_SESSION`, harness `t3code`, `SCP_GRANT` kept) and runs the reference MCP server in process with channels, advertising `t3code`. Each batch of pushed messages, joined by a blank line, goes to the thread through `orchestration.dispatchCommand` as `message.dispatch` (`createdBy` `user`, `creationSource` `server`, `deliveryIntent` `auto`) with `dispatchMode` `start_immediately` when the thread has no active run and `steer_active` with that run otherwise; one T3 Code refuses is retried every 2 s. The channel confirms injection, so the hooks do not show the same message again. It refuses to start without a server, a token the server accepts or the thread, and exits non-zero when the connection or the shell stream ends or T3 Code deletes the thread. The thread's own agent joins through its provider's mount as a separate `t3code` endpoint, since T3 Code starts the provider and the launcher cannot name it.

Each integration registers the MCP server under the name `scp`: `setup` mounts `swarm mcp --harness <h>` (with `--channels` for Claude Code) in the MCP configuration of claude, codex, opencode, grok, muse and agy, and the pi extension starts `swarm mcp --harness pi --channels [--as <name>]` itself. Messages a hook shows are acknowledged on every harness except agy, where they are marked injected only. Channel pushes (Claude Code under `swarm claude`, pi, `swarm codex`, `swarm muse`, `swarm agy`, `swarm grok`, `swarm t3code`) mark them injected and do not acknowledge (SPEC section 8.4).
