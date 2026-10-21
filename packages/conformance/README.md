# Hub wire conformance

Run from the repository root:

```sh
bun install
bun test packages/conformance
SCP_RELAY_BIN=./scp-relay bun test packages/conformance
SCP_RELAY_BIN=./scp-relay SCP_CONFORMANCE_PG=postgres://postgres:postgres@127.0.0.1:55432/postgres bun test packages/conformance
```

`ts` always runs. Without `SCP_RELAY_BIN`, `rust-sqlite` is explicitly skipped.
With the binary set, the same scenarios also run against `rust-sqlite`.
Setting `SCP_CONFORMANCE_PG` adds `rust-pg`, using a fresh database for each fixture.
The PostgreSQL login must be able to create and drop databases. The root test
preload captures these two settings before the CLI test isolation clears `SCP_*`.

The CLI fixture builds the real CLI with `ensureBuilt`, gives each machine its own
temporary home, configuration and broker directories, and starts foreground broker
processes. Persistent local wire clients keep the CLI-claimed agents online.
The runner invokes the built CLI on the destination machine and uses a bounded
worker lifetime. Teardown stops only spawned processes and removes fixture state.

Scenarios cover:

- Bridged messages, member-relative sender addresses and replies on the same thread.
- Presence across broker stop and restart.
- Offline delivery, exactly one inbox copy, both bridges reconnecting after a relay
  process restart, and a queued delivery surviving another relay restart.
- Cross-machine parent views, the mirrored `parent_addr`, and spawn-via handback.
- Direct cloud claims, send and inbox, and discovery of both bridged machines.
- Authentication bodies, HTTP methods, hello requirements and metadata, machine
  validation and ownership, bridge replacement, oversized frames, mirror changes,
  forward validation, replay cursors, acknowledgements and refusal notices.
- Raw hub mirrors and all mirrored fields, delta and full sweeps, in-place rename
  with queued mail, sync parts, bridge close and preserved hibernation.
- Raw forwarding address forms, fan-out, request and reply threads, idempotency,
  hop and scope refusal, client claims and resumes, inbox wake and watched status.
- Ordered HTTP batches, machine release, local event counts and live credential
  revocation with a per-test `revalidateMs=2000` limit.

`SCP_CONFORMANCE_SLOW=1 bun test packages/conformance` also checks that an empty
HTTP inbox requesting 60 seconds returns at the 25-second cap. This setting is
captured by the preload like the target settings.

All scenario assertions use CLI JSON, HTTP, WebSocket or local broker wire output.
No scenario reads a relay database or hub object. There are currently no TS-only
conformance skips.

The reference server can also run independently:

```sh
SCP_CONFORMANCE_ADMIN=local-secret bun packages/conformance/src/reference-server.ts --listen 127.0.0.1:0 --dir /tmp/scp-conformance
```

It prints the contract's JSON `listening` line. Its private `POST /_admin` route
requires the secret as a bearer credential and accepts `{action:"mint", account,
member, device?, name?}` or `{action:"revoke", credentialId}`. Credentials are
hashed in a file-backed table; each account has a separate file-backed hub database.
`Target.start(limits?)` passes each override as `--limit name=value`, supported by
the reference server and the Rust `serve` contract. Limits persist across restart;
only the revocation scenario overrides a limit.
Restart preserves both state and port. Rust targets use the contract's `serve`,
`account create`, `token create` and `token revoke` commands with the same store URL.
