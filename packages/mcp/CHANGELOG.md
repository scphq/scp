# @scp-dev/mcp

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
