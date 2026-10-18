# @scp-dev/core

The SCP protocol core: wire types, message framing, scopes, policy, the judge and the relay core that brokers and hubs run on.

```sh
npm install @scp-dev/core
```

## Usage

```ts
import { Database } from "bun:sqlite"
import { RelayCore, sha256Hex, type Sql, type SqlValue, wrapMessage } from "@scp-dev/core"

const db = new Database(":memory:")
const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
const core = new RelayCore(sql, { hash: sha256Hex, transaction: (fn) => db.transaction(fn)() })
core.migrate()
const orch = core.claim({ handle: "orch", harness: "claude-code" })
const parser = core.claim({ handle: "parser", harness: "codex" })
core.send(orch.endpoint.id, { to: "parser", body: "Also cover the empty-input case." })
for (const message of core.inbox(parser.endpoint.id)) console.log(wrapMessage(message))
```

`RelayCore` runs on any synchronous `Sql` store: SQLite locally, a Durable Object in the cloud.

## Provides

- `RelayCore`: endpoints, claims, inboxes, threads, replies, asks, grants, loop guards and rate limits.
- Wire types, `LIMITS` and `RelayError` codes for `scp/1`.
- Untrusted-content framing: `wrapMessage`, `wrapPeek` and the delivery preambles.
- Scopes and policy: `parsePolicy`, `scopeDecision` and the tree selectors.
- Credential and PII scanning: `findSecret`, `redactSecrets`, `redactPii`.
- The judge: `prefilter`, `runJudge`, `parseJudgePolicy`, `HttpJudgeClient`, with no default model.

Implements [Messages](https://scp.dev/spec#7-messages), [Authorization](https://scp.dev/spec#10-authorization) and [Judging](https://scp.dev/spec#15-judging). See the [root README](https://github.com/scphq/scp#readme).

## License

[Apache-2.0](LICENSE).
