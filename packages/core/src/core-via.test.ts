import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { LIMITS, RelayError } from "./protocol"
import { type EndpointRow, RelayCore, unreachable } from "./core"
import type { Sql, SqlValue } from "./sql"

test("via records migrate additively, persist across core restarts and replace only the same spawner's name", () => {
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(q: string, ...args: SqlValue[]) => db.query(q).all(...args) as T[] }
  let now = 1_800_000_000_000
  const options = { now: () => now, hash: (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex") }
  const core = new RelayCore(sql, options)
  core.migrate()
  const a = core.claim({ handle: "a", harness: "cli", session: "a" }).endpoint
  const b = core.claim({ handle: "b", harness: "cli", session: "b" }).endpoint
  core.spawnVia(a.id, { name: "w", runner: "vm" })
  core.spawnVia(b.id, { name: "w", runner: "vm" })
  const old = core.viaRecords().find((r) => r.spawner === a.id)!
  core.spawnVia(a.id, { name: "w", runner: "new", ref: "job-1", attach: "ssh vm" })
  const restarted = new RelayCore(sql, options)
  restarted.migrate()
  expect(restarted.viaRecords()).toHaveLength(2)
  expect(restarted.viaRecords().find((r) => r.spawner === a.id)).toMatchObject({
    runner: "new",
    ref: "job-1",
    attach: "ssh vm",
    ended_at: null,
    created_at: old.created_at + 1,
  })
  expect(() => restarted.spawnVia(restarted.humanId(), { name: "w", runner: "vm" })).toThrow("only the spawning agent")
  expect(() => restarted.spawnVia(a.id, { name: "w;evil", runner: "vm" })).toThrow("worker name")
  const actor = { kind: "endpoint", id: a.id, auth: "session" } as const
  restarted.endVia(actor, { endpoint: "w" })
  expect(restarted.viaRecords().find((r) => r.spawner === a.id)?.ended_at).toBeNumber()
  expect(restarted.viaRecords().find((r) => r.spawner === b.id)?.ended_at).toBeNull()
  const audit = restarted.log({}).find((e) => e.event === "spawn_end")
  expect(audit?.detail).toMatchObject({ runner: "new", target: "w", held: false })
  restarted.disconnect(a.id)
  restarted.disconnect(b.id)
  now += (LIMITS.handleBoundS + 1) * 1000
  restarted.sweep()
  expect(restarted.whoami(a.id).id).toBe(a.id)
  expect(restarted.whoami(b.id).id).toBe(b.id)
  db.close()
})

test("via records do not reveal an undiscoverable worker to another agent", () => {
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(q: string, ...args: SqlValue[]) => db.query(q).all(...args) as T[] }
  class ViaCore extends RelayCore {
    protected override localRow(row: EndpointRow): boolean {
      return row.handle !== "joined"
    }
  }
  const core = new ViaCore(sql, { hash: (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex") })
  core.migrate()
  const lead = core.claim({ handle: "lead", harness: "cli", session: "lead" }).endpoint
  const stranger = core.claim({ handle: "stranger", harness: "cli", session: "stranger" }).endpoint
  const actor = { kind: "endpoint", id: stranger.id, auth: "session" } as const
  core.spawnVia(lead.id, { name: "w", runner: "vm", address: "me/vm/w", machine: "vm" })
  core.spawnVia(lead.id, { name: "unjoined", runner: "vm" })
  const grant = core.grant({ kind: "endpoint", id: lead.id, auth: "session" }, { name: "joined" })
  core.claim({ handle: "joined", harness: "cli", session: "joined", grant: grant.token })
  core.spawnVia(lead.id, { name: "joined", runner: "vm" })
  for (const endpoint of ["w", "me/w", "me/vm/w", "unjoined", "joined", "me/joined"]) {
    expect(() => core.endVia(actor, { endpoint })).toThrow(unreachable(endpoint))
    try {
      core.endVia(actor, { endpoint })
    } catch (error) {
      expect(error).toBeInstanceOf(RelayError)
      expect((error as RelayError).code).toBe("not_found")
    }
  }
  expect(core.viaRecords().every((record) => record.ended_at === null)).toBe(true)
  db.close()
})
