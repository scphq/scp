# @scp-dev/pi

## 0.1.1

### Patch Changes

- 100a961: Ambient pi swarms come up and stay clean. A broker whose state directory was wiped or whose socket another broker took over stops, so its shims reconnect to the live one. A pi session starts its shim only once the previous one exited and reports a shim that could not claim the endpoint, and a shim exits once its harness is gone. A named relaunch, or a session its harness restarted in process, takes back its own endpoint instead of minting a `-2`. A broker linked again under a new machine name relabels its endpoints, and bridges drop the rows of released machines and of their own former name. `swarm --version` reads the installed package.json, and a closed stdout pipe ends a command quietly.

## 0.1.0

### Minor Changes

- 90e8f69: `swarm pi [--name N]` runs pi with the new `@scp-dev/pi` extension: the relay tools become pi tools, and each new message steers a running turn or wakes an idle session to run one. A session started again with the same name receives what arrived while it was closed.
