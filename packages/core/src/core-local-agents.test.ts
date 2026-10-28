import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { RelayCore } from "./core"
import type { Sql, SqlValue } from "./sql"

test("local agents carry their parent's address and their newest unread message until it is acked", () => {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  })
  core.migrate()
  const lead = core.claim({ handle: "lead", harness: "codex" }).endpoint
  const quiet = core.claim({ handle: "quiet", harness: "codex" }).endpoint
  core.send(quiet.id, { to: lead.address, body: "first" })
  clock.now += 5000
  core.send(quiet.id, { to: lead.address, body: "second" })
  const agent = (id: string) => core.localAgents().find((one) => one.id === id)!
  expect(agent(lead.id)).toMatchObject({ unread: true, unread_at: new Date(clock.now).toISOString() })
  expect(agent(quiet.id)).toMatchObject({ unread: false, unread_at: null, parent: null })
  core.ack(
    lead.id,
    core.inbox(lead.id, {}).map((message) => message.seq),
  )
  expect(agent(lead.id)).toMatchObject({ unread: false, unread_at: null })
})
