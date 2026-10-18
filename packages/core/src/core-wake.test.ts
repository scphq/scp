import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const self = (id: string): ScopeActor => ({ kind: "endpoint", id, auth: "session" })

function setup() {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    alive: () => true,
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  })
  core.migrate()
  const peer = core.claim({ handle: "peer", harness: "codex" }).endpoint
  return { core, clock, db, peer }
}

function code(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof RelayError) return error.code
    throw error
  }
  return undefined
}

describe("wake", () => {
  test("an agent's wake is null until set, validated, none clears it, and only agents have one", () => {
    const { core, db, peer } = setup()
    expect(core.whoami(peer.id).wake).toBeNull()
    expect(db.query("SELECT wake FROM endpoints WHERE id = ?").get(peer.id)).toEqual({ wake: null })
    expect(core.setWake(peer.id, "channels")).toBe(true)
    expect(core.setWake(peer.id, "channels")).toBe(false)
    expect(core.whoami(peer.id).wake).toBe("channels")
    expect(core.list().find((e) => e.id === peer.id)!.wake).toBe("channels")
    expect(code(() => core.setWake(peer.id, "opencode-serve"))).toBe("invalid_params")
    expect(code(() => core.setWake(peer.id, 1))).toBe("invalid_params")
    expect(code(() => core.setWake(core.humanId(), "channels"))).toBe("invalid_params")
    expect(core.setWake(peer.id, "none")).toBe(true)
    expect(core.whoami(peer.id).wake).toBeNull()
    expect(core.whoami(core.humanId())).not.toHaveProperty("wake")
  })

  test("a hook sets it only for the process that holds the endpoint", () => {
    const { core } = setup()
    const id = core.claim({ handle: "oc", harness: "opencode", process: key(9), session: key(9) }, { transient: true }).endpoint.id
    expect(core.setWake(id, "opencode-plugin", { transient: true, process: key(8) })).toBe(false)
    expect(core.whoami(id).wake).toBeNull()
    expect(core.setWake(id, "opencode-plugin", { transient: true, process: key(9) })).toBe(true)
    expect(core.whoami(id).wake).toBe("opencode-plugin")
  })

  test("leave clears it", () => {
    const { core } = setup()
    const id = core.joinSession({ handle: "lead", harness: "claude-code", process: key(9), session: key(9), lineage: [key(9)] }).id
    core.setWake(id, "channels")
    expect(core.leaveSession(self(id)).endpoint.wake).toBeNull()
  })

  test("a send names an idle recipient's wake and idleness", () => {
    const { core, clock, peer } = setup()
    const woken = core.claim({ handle: "woken", harness: "pi" }).endpoint.id
    core.claim({ handle: "later", harness: "codex" })
    core.setWake(woken, "pi")
    expect(core.send(peer.id, { to: ["woken", "later"], body: "now" }).deliveries.map(({ wake, idle }) => ({ wake, idle }))).toEqual([
      { wake: "pi", idle: undefined },
      { wake: undefined, idle: undefined },
    ])
    clock.now += (LIMITS.onlineWithinS + 1) * 1000
    core.touch(peer.id)
    const sent = core.send(peer.id, { to: ["woken", "later"], body: "idle" })
    expect(sent.deliveries).toMatchObject([
      { address: "me/woken", state: "running", wake: "pi", idle: true },
      { address: "me/later", state: "running", idle: true },
    ])
    expect(sent.deliveries[1]).not.toHaveProperty("wake")
  })
})
