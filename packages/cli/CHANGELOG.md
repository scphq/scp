# @scp-dev/cli

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
