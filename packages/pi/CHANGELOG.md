# @scp-dev/pi

## 0.1.0

### Minor Changes

- 90e8f69: `swarm pi [--name N]` runs pi with the new `@scp-dev/pi` extension: the relay tools become pi tools, and each new message steers a running turn or wakes an idle session to run one. A session started again with the same name receives what arrived while it was closed.
