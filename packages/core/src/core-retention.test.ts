import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { LIMITS, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const HUMAN: ScopeActor = { kind: "human", tty: true }
const DAY = 86_400_000

function setup(options: { endpointRetireS?: number; endpointRetireMax?: number } = {}) {
  const clock = { now: 1_800_000_000_000 }
  const dead = new Set<number>()
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    alive: (pid) => !dead.has(pid),
    ...options,
  })
  core.migrate()
  const hook = (pid: number, extra: Record<string, unknown> = {}) =>
    core.claim({ handle: "app", harness: "claude-code", process: key(pid), session: key(pid), lineage: [key(pid), key(1)], ...extra }, { transient: true })
      .endpoint
  const sub = (pid: number, id: string) => hook(pid, { subagent: { id, type: "Explore" } })
  /** marks `pids` exited, has a sweep notice it, then lets `days` pass */
  const end = (pids: number[], days = 2) => {
    for (const pid of pids) dead.add(pid)
    core.sweep()
    clock.now += days * DAY
  }
  const exists = (id: string) => db.query(`SELECT 1 FROM endpoints WHERE id = ?`).get(id) !== null
  return { core, clock, db, hook, sub, end, exists }
}

describe("endpoint retention", () => {
  test("an ended subagent's row offline past the retention age is deleted with its acked mail; its root and audit stay", () => {
    const { core, db, hook, sub, end, exists } = setup()
    const root = hook(9)
    const child = sub(9, "a1b2c3")
    core.send(root.id, { to: child.address, body: "hi" })
    const seq = (db.query(`SELECT seq FROM deliveries WHERE endpoint = ?`).get(child.id) as { seq: number }).seq
    core.ack(child.id, [seq])
    end([9], 0.5)
    core.sweep()
    expect(exists(child.id)).toBe(true)
    end([], 1)
    core.sweep()
    expect(exists(child.id)).toBe(false)
    expect(exists(root.id)).toBe(true)
    expect(db.query(`SELECT 1 FROM deliveries WHERE endpoint = ?`).get(child.id)).toBeNull()
    expect(db.query(`SELECT 1 FROM audit WHERE endpoint = ?`).get(child.id)).not.toBeNull()
  })

  test("a row with unread mail, a human-named row and a hibernated row stay", () => {
    const { core, db, hook, sub, end, exists } = setup()
    const root = hook(9)
    const unread = sub(9, "aaaa11")
    const named = sub(9, "bbbb22")
    const asleep = sub(9, "cccc33")
    core.send(root.id, { to: unread.address, body: "read me", ttl_s: 30 * 86_400 })
    core.rename(HUMAN, { endpoint: named.address, handle: "keeper" })
    db.query(`UPDATE endpoints SET hibernate = 'hook:test', hibernated_at = ? WHERE id = ?`).run(Date.now(), asleep.id)
    end([9], 3)
    core.sweep()
    expect([unread, named, asleep].map((row) => exists(row.id))).toEqual([true, true, true])
  })

  test("a row with a read but unexpired request stays, since it may still reply", () => {
    const { core, hook, sub, end, exists } = setup()
    const root = hook(9)
    const asked = sub(9, "dddd44")
    core.send(root.id, { to: asked.address, body: "answer later", kind: "request", ttl_s: 30 * 86_400 })
    core.ack(
      asked.id,
      core.inbox(asked.id).map((message) => message.seq),
    )
    end([9], 3)
    core.sweep()
    expect(exists(asked.id)).toBe(true)
  })

  test("a parent whose child still runs stays; once the child is retired, the parent goes too", () => {
    const { core, hook, end, exists } = setup()
    const root = hook(9)
    const mid = hook(10, { handle: "mid", lineage: [key(10), key(9)] })
    const leaf = hook(11, { handle: "leaf", lineage: [key(11), key(10)] })
    expect(core.whoami(leaf.id).parent).toBe(mid.address)
    end([10], 3)
    core.sweep()
    expect([exists(mid.id), exists(leaf.id)]).toEqual([true, true])
    end([11], 3)
    core.sweep()
    expect([exists(mid.id), exists(leaf.id), exists(root.id)]).toEqual([false, false, true])
  })

  test("Infinity keeps every row", () => {
    const { hook, sub, end, exists, core } = setup({ endpointRetireS: Infinity })
    hook(9)
    const child = sub(9, "a1b2c3")
    end([9], 20)
    core.sweep()
    expect(exists(child.id)).toBe(true)
  })

  test("one sweep retires at most endpointRetireMax rows, oldest first", () => {
    const { core, db, hook, sub, end, exists } = setup({ endpointRetireMax: 2 })
    hook(9)
    const children = ["aaaa11", "bbbb22", "cccc33", "dddd44", "eeee55"].map((id) => sub(9, id))
    end([9], 3)
    core.sweep()
    expect(children.map((row) => exists(row.id)).filter(Boolean)).toHaveLength(3)
    core.sweep()
    core.sweep()
    expect(children.some((row) => exists(row.id))).toBe(false)
    expect((db.query(`SELECT COUNT(*) AS n FROM endpoints WHERE kind = 'agent'`).get() as { n: number }).n).toBe(1)
  })

  test("the default age is a day", () => {
    expect(LIMITS.endpointRetireS).toBe(86_400)
  })
})
