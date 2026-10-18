# @scp-dev/cli

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
