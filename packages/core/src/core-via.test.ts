import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { FederatedCore } from "../../hub/src/federation"
import { runnerInput } from "../../broker/src/runners"
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

function viaFixture() {
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(q: string, ...args: SqlValue[]) => db.query(q).all(...args) as T[] }
  let now = 1_800_000_000_000
  const core = new FederatedCore(sql, {
    machine: "laptop",
    now: () => now++,
    hash: (text) => new Bun.CryptoHasher("sha256").update(text).digest("hex"),
  })
  core.migrate()
  const claim = (handle: string, scope: "tree" | "open" = "tree") => core.claim({ handle, harness: "cli", session: handle, scope }).endpoint
  const actor = (id: string) => ({ kind: "endpoint", id, auth: "session" }) as const
  const mirror = (machine: string, name: string, parent: string) =>
    core.mirror(machine, [{ address: `me/${name}`, kind: "agent", harness: "cli", presence: "online", parent_addr: `laptop/${parent}` }])
  return { db, core, claim, actor, mirror }
}

for (const visible of [false, true]) {
  test(`a spawner ending a worker under someone else respects discovery (visible: ${visible})`, () => {
    const { db, core, claim, actor, mirror } = viaFixture()
    try {
      const lead = claim("lead")
      claim("other", "open")
      mirror("vm", "w", "other")
      if (visible) {
        core.rulesSet(actor(lead.id), { scope: "open" })
        core.rulesSet({ kind: "human", tty: true }, { endpoint: "lead", out: ["tree:self"] })
        core.rulesWiden({ kind: "human", tty: true }, { endpoint: "lead", out: ["*"] })
      }
      core.spawnVia(lead.id, { name: "w", runner: "vm", address: "me/vm/w", machine: "vm" })
      for (const endpoint of ["w", "me/vm/w"]) {
        expect(() => core.endVia(actor(lead.id), { endpoint })).toThrow(
          !visible ? unreachable(endpoint) : new RelayError("unauthorized", "the worker is not under this runner's spawner"),
        )
      }
      expect(core.viaRecords()[0]!.ended_at).toBeNull()
    } finally {
      db.close()
    }
  })
}

test("an address-less record never stops a same-named worker under someone else", () => {
  const { db, core, claim, actor, mirror } = viaFixture()
  try {
    const lead = claim("lead")
    claim("other")
    mirror("vm", "w", "other")
    mirror("desk", "w", "other")
    core.spawnVia(lead.id, { name: "w", runner: "vm" })
    expect(() => core.endVia(actor(lead.id), { endpoint: "w" })).toThrow("that you can reach")
    expect(() => core.endVia({ kind: "human", tty: true }, { endpoint: "w" })).toThrow("not under this runner's spawner")
    mirror("owned", "w", "lead")
    expect(core.endVia(actor(lead.id), { endpoint: "w" })?.endpoint?.address).toBe("me/owned/w")
    mirror("also-owned", "w", "lead")
    expect(() => core.endVia(actor(lead.id), { endpoint: "w" })).toThrow("ambiguous via worker")
  } finally {
    db.close()
  }
})

test("the human and a shared ancestor prefer the record tied to its spawner's worker", () => {
  const { db, core, claim, actor, mirror } = viaFixture()
  try {
    const root = claim("root")
    const child = (handle: string) => {
      const grant = core.grant(actor(root.id), { name: handle })
      return core.claim({ handle, harness: "cli", session: handle, grant: grant.token }).endpoint
    }
    const a = child("a"),
      b = child("b")
    core.spawnVia(a.id, { name: "w", runner: "vm", address: "me/vm/w", machine: "vm" })
    core.spawnVia(b.id, { name: "w", runner: "vm", address: "me/desk/w", machine: "desk" })
    mirror("vm", "w", "a")
    mirror("desk", "w", "a")
    // Only a's record matches its worker's parent.
    for (const caller of [actor(root.id), { kind: "human", tty: true } as const]) {
      expect(core.endVia(caller, { endpoint: "w" })?.record.spawner).toBe(a.id)
    }
    expect(core.viaRecords().find((r) => r.spawner === b.id)?.ended_at).toBeNull()
    mirror("desk", "w", "b")
    expect(() => core.endVia(actor(root.id), { endpoint: "w" })).toThrow("ambiguous via worker")
  } finally {
    db.close()
  }
})

test("taking over a spawner moves via records, keeps newer collisions and updates runner parent", () => {
  const { db, core, claim, actor, mirror } = viaFixture()
  try {
    const held = claim("held"),
      row = claim("replacement")
    core.spawnVia(held.id, { name: "w", runner: "vm", address: "me/vm/w", machine: "vm" })
    core.spawnVia(held.id, { name: "new-on-row", runner: "old" })
    core.spawnVia(row.id, { name: "new-on-row", runner: "new" })
    core.spawnVia(row.id, { name: "new-on-held", runner: "old" })
    core.spawnVia(held.id, { name: "new-on-held", runner: "new" })
    mirror("vm", "w", "held")
    core.disconnect(held.id)
    core.rename({ kind: "human", tty: true }, { endpoint: "replacement", handle: "held", take_over: true })
    expect(core.viaRecords()).toHaveLength(3)
    expect(core.viaRecords().every((r) => r.spawner === row.id)).toBe(true)
    expect(
      core
        .viaRecords()
        .filter((r) => r.name !== "w")
        .map((r) => r.runner),
    ).toEqual(["new", "new"])
    const ended = core.endVia(actor(row.id), { endpoint: "me/vm/w" })!
    expect(ended.endpoint?.address).toBe("me/vm/w")
    expect(runnerInput(core, ended.record, "stop").parent).toBe("me/laptop/held")
    expect(core.viaRecords().find((r) => r.name === "w")?.ended_at).toBeNumber()
  } finally {
    db.close()
  }
})
