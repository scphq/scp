import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import type { Sql, SqlValue } from "./sql"

const DAY = 86_400_000

class Core extends RelayCore {
  write(event: string, endpoint: string | null, detail: Record<string, unknown>): void {
    this.audit(event, endpoint, null, detail)
  }
  writeOnce(event: string, endpoint: string | null, detail: Record<string, unknown>): void {
    this.auditOnce(event, endpoint, detail)
  }
}

function setup() {
  const clock = { now: Date.now() }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new Core(sql, {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  })
  core.migrate()
  const insert = (event: string, at: number) => db.query(`INSERT INTO audit (at, event, detail) VALUES (?, ?, '{}')`).run(at, event).lastInsertRowid
  const has = (id: number | bigint) => db.query(`SELECT 1 FROM audit WHERE id = ?`).get(id) !== null
  const count = (event: string) => (db.query(`SELECT COUNT(*) AS n FROM audit WHERE event = ?`).get(event) as { n: number }).n
  return { core, clock, db, insert, has, count }
}

describe("audit noise", () => {
  test("a sweep drops refusals older than a day and keeps every other event for the full retention", () => {
    const { core, insert, has } = setup()
    const old = insert("scope_refused", Date.now() - 2 * DAY)
    const fresh = insert("scope_refused", Date.now() - 3_600_000)
    const claim = insert("claim", Date.now() - 2 * DAY)
    core.sweep()
    expect(has(old)).toBe(false)
    expect(has(fresh)).toBe(true)
    expect(has(claim)).toBe(true)
  })

  test("a backlog of old refusals drains a bounded chunk per sweep", () => {
    const { core, db, insert, count } = setup()
    db.transaction(() => {
      for (let i = 0; i < 6000; i++) insert("scope_refused", Date.now() - 2 * DAY)
    })()
    core.sweep()
    expect(count("scope_refused")).toBe(1000)
    core.sweep()
    expect(count("scope_refused")).toBe(0)
  })

  test("the audit stays append-only for every row the noise retention does not cover", () => {
    const { db, insert } = setup()
    const claim = insert("claim", Date.now() - 2 * DAY)
    const fresh = insert("scope_refused", Date.now() - 3_600_000)
    expect(() => db.query(`DELETE FROM audit WHERE id = ?`).run(claim)).toThrow("append-only")
    expect(() => db.query(`DELETE FROM audit WHERE id = ?`).run(fresh)).toThrow("append-only")
  })

  test("a database with the old guard gets the new one on migrate", () => {
    const { core, db, insert, has } = setup()
    db.run(`DROP TRIGGER audit_no_delete`)
    db.run(`CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
      WHEN OLD.at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000
      BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END`)
    core.migrate()
    const old = insert("scope_refused", Date.now() - 2 * DAY)
    core.sweep()
    expect(has(old)).toBe(false)
    const triggers = db.query(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_no_delete'`).get() as { n: number }
    expect(triggers.n).toBe(1)
  })

  test("a retried refusal is audited once a minute; a different one is not held back", () => {
    const { core, clock, count } = setup()
    for (let i = 0; i < 50; i++) core.writeOnce("scope_refused", null, { target: "a", reason: "grant invalid" })
    core.writeOnce("scope_refused", "ep_x", { target: "a", reason: "grant invalid" })
    core.writeOnce("scope_refused", null, { target: "b", reason: "grant invalid" })
    expect(count("scope_refused")).toBe(3)
    clock.now += 61_000
    core.writeOnce("scope_refused", null, { target: "a", reason: "grant invalid" })
    expect(count("scope_refused")).toBe(4)
    for (let i = 0; i < 3; i++) core.write("scope_refused", null, { target: "c", reason: "no terminal" })
    expect(count("scope_refused")).toBe(7)
  })

  test("a claim retried with a refused grant writes one refusal row", () => {
    const { core, count } = setup()
    for (let i = 0; i < 20; i++) expect(() => core.claim({ handle: "w", harness: "codex", grant: `krt_${"0".repeat(64)}` })).toThrow("grant refused")
    expect(count("scope_refused")).toBe(1)
  })
})

describe("query plans", () => {
  const plans: [string, string, SqlValue[]][] = [
    [
      "spawn_exit refs",
      `SELECT 1 FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE m.from_ep = ? AND d.endpoint = ? AND m.created_at >= ?
       AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.event = 'spawn_exit' AND a.ref = m.id) LIMIT 1`,
      ["a", "b", 0],
    ],
    ["refusals of a pair", `SELECT at, endpoint, detail FROM audit WHERE event = 'refuse' AND endpoint IN (?, ?) ORDER BY id DESC LIMIT 500`, ["a", "b"]],
    ["peek log", `SELECT at, detail FROM audit WHERE event = 'peek' AND endpoint = ? ORDER BY id DESC LIMIT ?`, ["a", 5]],
    [
      "peek count",
      `SELECT COUNT(*) AS n, MIN(at) AS first FROM audit WHERE event = 'peek' AND endpoint = ? AND at > ? AND json_extract(detail, '$.auth') != 'tty'`,
      ["a", 0],
    ],
    ["hooked processes", `SELECT id, process FROM endpoints WHERE kind = 'agent' AND connections = 0 AND hook_seen IS NOT NULL AND process IS NOT NULL`, []],
    ["lapsed wakes", `SELECT * FROM endpoints WHERE wake IS NOT NULL AND wakers = 0 AND waker_left < ?`, [0]],
    ["offline statuses", `SELECT * FROM endpoints WHERE kind = 'agent' AND connections = 0 AND status_state IN ('working', 'waiting')`, []],
    [
      "revived sessions",
      `SELECT id FROM endpoints WHERE kind = 'agent' AND hibernate IS NOT NULL AND revive IS NOT NULL
       AND wake_ticket IS NOT NULL AND hook_ended IS NULL AND hook_seen >= wake_tried AND wake_tried <= ?`,
      [0],
    ],
    ["noise retention", `DELETE FROM audit WHERE event IN ('scope_refused') AND at <= ?`, [0]],
  ]
  for (const [name, query, params] of plans)
    test(`${name} scans no table`, () => {
      const { db } = setup()
      const plan = (db.query(`EXPLAIN QUERY PLAN ${query}`).all(...params) as { detail: string }[]).map((row) => row.detail)
      expect(plan.filter((detail) => /^SCAN (audit|endpoints|a)\b/.test(detail))).toEqual([])
    })
})
