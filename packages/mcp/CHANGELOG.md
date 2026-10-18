# @scp-dev/mcp

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
