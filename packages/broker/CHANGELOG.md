# @scp-dev/broker

## 0.1.2

### Patch Changes

- f84dc9b: A bridge the hub revoked or replaced links again after `swarm login`, `swarm cloud enable` or `swarm up`, through the new `bridge_relink` call; a broker started before its cloud config existed restarts to pick it up. `swarm daemon stop` and `swarm daemon restart` stop or replace the running broker.

## 0.1.1

### Patch Changes

- f83cab6: First release through the CI release workflow, with provenance.
- Updated dependencies [f83cab6]
  - @scp-dev/core@0.1.1
  - @scp-dev/hub@0.1.1
