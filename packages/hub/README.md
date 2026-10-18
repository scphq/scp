# @scp-dev/hub

The SCP account hub: one per account, linking the brokers of its machines and reaching other accounts through accepted contacts.

```sh
npm install @scp-dev/hub
```

## Usage

A host owns storage and sockets and hands each frame to the hub.

```ts
import { Database } from "bun:sqlite"
import { sha256Hex, type Sql, type SqlValue } from "@scp-dev/core"
import { type HubGrant, type HubSocket, RelayHub } from "@scp-dev/hub"

const db = new Database(":memory:")
const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
const live = new Set<HubSocket>()
const hub = new RelayHub({ sql, hash: sha256Hex, transaction: (fn) => db.transaction(fn)(), sockets: () => [...live], save: () => {} })
hub.init({ user: "ada" })
// per authenticated WebSocket
const socket: HubSocket = { conn: RelayHub.connection(grant), send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) }
live.add(socket)
await hub.message(socket, frame)
hub.closed(socket)
```

## Provides

- `RelayHub`: bridges, direct clients and observers over one JSON-RPC socket protocol.
- `FederatedCore`: endpoints mirrored from every machine, scope re-checked against mirrored rules, delivery queued for offline machines.
- Contacts, per-side allowlists and cross-account delivery behind egress and ingress gates.
- The hosted hold queue for judge verdicts.
- `HUB_LIMITS`, each overridable; `Infinity` disables a cap.

Implements [Federation and cross-account](https://scp.dev/spec#14-federation-and-cross-account) and [Conformance](https://scp.dev/spec#18-conformance). See the [root README](https://github.com/scphq/scp#readme).

## License

[Apache-2.0](LICENSE).
