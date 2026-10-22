import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import type { Sql, SqlValue } from "./sql"

const OFFLINE = 5000
const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`

/** a core over `OFFLINE` long-offline agent rows in trees of ten, counting the rows each call reads */
function setup() {
  const now = 1_800_000_000_000
  const db = new Database(":memory:")
  let read = 0
  const sql: Sql = {
    all: <T>(query: string, ...params: SqlValue[]) => {
      const rows = db.query(query).all(...params) as T[]
      read += rows.length
      return rows
    },
  }
  const core = new RelayCore(sql, {
    now: () => now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    endpointRetireS: Number.POSITIVE_INFINITY,
  })
  core.migrate()
  const insert = db.query(
    `INSERT INTO endpoints (id, handle, kind, harness, labels, created_at, last_seen, parent_ep, tree, depth) VALUES (?, ?, 'agent', 'claude-code', '{}', ?, ?, ?, ?, ?)`,
  )
  db.transaction(() => {
    for (let i = 0; i < OFFLINE; i++) {
      const root = `ep_old${i - (i % 10)}`
      insert.run(`ep_old${i}`, `old-${i}`, now - 3 * 86_400_000, now - 2 * 86_400_000, i % 10 ? root : null, i % 10 ? root : null, i % 10 ? 1 : 0)
    }
  })()
  const claim = () => core.claim({ handle: "live", harness: "claude-code", process: key(7), session: key(7), lineage: [key(7)] }, { transient: true }).endpoint
  const reads = (fn: () => unknown) => {
    read = 0
    fn()
    return read
  }
  return { core, claim, reads }
}

describe("hot paths at scale", () => {
  test("a hook's claim, list and snapshot read a bounded number of rows however many offline endpoints there are", () => {
    const { core, claim, reads } = setup()
    const me = claim()
    expect(reads(claim)).toBeLessThan(200)
    expect(reads(() => core.whoami(me.id))).toBeLessThan(50)
    expect(reads(() => core.list())).toBeLessThan(200)
    expect(reads(() => core.snapshot())).toBeLessThan(400)
    expect(core.list().map((view) => view.address)).toContain(me.address)
  })

  test("a read pass derives each row once: peers and a full list stay linear", () => {
    const { core, claim, reads } = setup()
    const me = claim()
    expect(reads(() => core.peers(me.id))).toBeLessThan(3 * OFFLINE)
    expect(reads(() => core.list({ all: true }))).toBeLessThan(3 * OFFLINE)
    const started = performance.now()
    core.peers(me.id)
    core.list({ all: true })
    expect(performance.now() - started).toBeLessThan(5000)
  })
})
