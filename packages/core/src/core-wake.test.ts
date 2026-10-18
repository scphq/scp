import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const self = (id: string): ScopeActor => ({ kind: "endpoint", id, auth: "session" })

function setup(alive: (pid: number) => boolean = () => true) {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    alive,
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

  test("a lasting waker keeps a wakeable endpoint idle and listed, and it goes offline once the waker closes", () => {
    const { core, clock } = setup()
    const id = core.claim({ handle: "cx", harness: "codex", process: key(9), session: key(9) }, { transient: true }).endpoint.id
    core.setWake(id, "codex-app-server")
    core.waker(id, true)
    clock.now += (LIMITS.listOfflineWithinS + 1) * 1000
    expect(core.list().find((e) => e.id === id)?.presence).toBe("idle")
    core.waker(id, false)
    expect(core.whoami(id).presence).toBe("offline")
  })

  test("a hook waker keeps it idle across the gap before the next one; a wake of none or a lapsed grace lets it go", () => {
    const { core, clock } = setup()
    const id = core.claim({ handle: "oc", harness: "opencode", process: key(9), session: key(9) }, { transient: true }).endpoint.id
    core.setWake(id, "opencode-plugin", { transient: true, process: key(9) })
    core.waker(id, true)
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    core.waker(id, false, { grace: true })
    clock.now += (LIMITS.restartGraceS - 1) * 1000
    expect(core.whoami(id).presence).toBe("idle")
    core.waker(id, true)
    core.waker(id, false, { grace: true })
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    expect(core.whoami(id).presence).toBe("offline")
    core.waker(id, true)
    core.resetConnections()
    expect(core.whoami(id).presence).toBe("idle")
    core.setWake(id, "none")
    expect(core.whoami(id).presence).toBe("offline")
  })

  describe("an ended session clears it", () => {
    const hooked = (core: RelayCore) => {
      const id = core.claim({ handle: "oc", harness: "opencode", process: key(9), session: key(9) }, { transient: true }).endpoint.id
      core.setWake(id, "opencode-plugin", { transient: true, process: key(9) })
      return id
    }

    test("by its hook's session_end, but not while a live waker holds it", () => {
      const { core } = setup()
      const id = hooked(core)
      core.waker(id, true)
      core.event(id, { kind: "session_end" }, { transient: true, process: key(9) })
      expect(core.whoami(id).wake).toBe("opencode-plugin")
      core.waker(id, false)
      expect(core.whoami(id).wake).toBeNull()
      core.setWake(id, "opencode-plugin", { transient: true, process: key(9) })
      core.event(id, { kind: "session_end" }, { transient: true, process: key(9) })
      expect(core.whoami(id).wake).toBeNull()
    })

    test("when its harness process exited", () => {
      const dead = new Set<number>()
      const { core } = setup((pid) => !dead.has(pid))
      const id = hooked(core)
      dead.add(9)
      core.endExited()
      expect(core.whoami(id).wake).toBeNull()
    })

    test("when its hook waker left and the grace ran out", () => {
      const { core, clock } = setup()
      const id = hooked(core)
      core.waker(id, true)
      core.waker(id, false, { grace: true })
      clock.now += (LIMITS.restartGraceS - 1) * 1000
      expect(core.list().find((e) => e.id === id)!.wake).toBe("opencode-plugin")
      clock.now += 2000
      expect(core.list({ all: true }).find((e) => e.id === id)!.wake).toBeNull()
    })

    test("when another process takes the endpoint over", () => {
      const { core, clock } = setup()
      const id = hooked(core)
      clock.now += (LIMITS.hookIdleS + 1) * 1000
      expect(core.claim({ handle: "oc", harness: "opencode", process: key(8), session: key(8) }).endpoint).toMatchObject({ id, wake: null })
    })
  })
})
