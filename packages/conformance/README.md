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
The PostgreSQL login must be able to create and drop databases. For slow database
creation or migrations, add `--timeout 60000` to the Bun test command. The root test
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
- Contact state transitions, contact envelopes and reply grants, root discovery,
  ingress direction, allowlists and scopes, revocation, byte limits and pair quotas.
- Socket, machine, endpoint and call limits, positive retry delays, and uncapped
  limits advertised as null in hello.
- Signed machine wake webhooks, metadata-only payloads, waking state, debounce,
  decline holds, and cross-account wake opt-in.
- Public dashboard bearer auth, account isolation, overview and graph views,
  WebSocket and SSE events, revocation and exact-origin CORS on every target.
- Device login approval, denial and single redemption, live credential expiry,
  malformed HTTP JSON and oversized HTTP requests.

`SCP_CONFORMANCE_SLOW=1 bun test packages/conformance` also checks that an empty
HTTP inbox requesting 60 seconds returns at the 25-second cap. This setting is
captured by the preload like the target settings.

All scenario assertions use CLI JSON, HTTP, WebSocket or local broker wire output.
No scenario reads a relay database or hub object. Dashboard and protocol scenarios
use the same assertions across all targets.

An oversized HTTP RPC request follows the existing hub behavior: HTTP 200 with
JSON-RPC error `-32000`, `id: null` and `data.code: "too_large"`. It does not return
HTTP 413. Both implementations use the same assertions.

The reference server can also run independently:

```sh
SCP_CONFORMANCE_ADMIN=local-secret bun packages/conformance/src/reference-server.ts --listen 127.0.0.1:0 --dir /tmp/scp-conformance
```

It prints the contract's JSON `listening` line. Its private `POST /_admin` route
requires the secret as a bearer credential. It accepts:

- `{action:"mint", account, member, device?, name?, expiresIn?}`.
- `{action:"revoke", credentialId}`.
- `{action:"contact", op, account, peer, allow?, dir?, limits?}`.
- `{action:"approve", userCode, account, member}` or `{action:"deny", userCode}`.

Credentials, contacts and device codes use `credentials.db`; each account has a
separate file-backed hub database. Credentials and device codes are stored hashed.
`Target.start(limits?, wake?, extraServeArgs?)` passes overrides as `--limit name=value` and
`--wake name=value`. Rust targets pass the hosted hub limits and wake rate defaults explicitly, then
apply scenario overrides. Their self-host defaults are unlimited. Extra serve
arguments enable options such as `--cors-origin`. Limits, wake options and extra
arguments persist across restart, as do state and port. Rust targets
use the contract's `serve`, `account create`, `token create`, `token revoke`,
`contact` and `device approve|deny` commands with the same store URL.

Container smoke tests use a local image and clean up their own containers and named volumes:

```sh
SCP_CONFORMANCE_IMAGE=scp-relay:local SCP_CONFORMANCE_TARGETS=docker \
  bun test packages/conformance --timeout 30000 --test-name-pattern 'HTTP checks credentials|HTTP requests are fresh|hello advertises|container preserves|dashboard public API'
```

`SCP_CONFORMANCE_TARGETS` is a comma-separated target filter. Without it, all available targets run.
The Docker target binds random host ports on `127.0.0.1`. Its smoke test mints a native credential and reads the public dashboard API.
