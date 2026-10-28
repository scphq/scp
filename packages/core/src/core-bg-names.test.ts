import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { LIMITS, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const START = "Thu-Oct-15-10:00:00-2026"
const key = (pid: number, start = START) => `pid:${pid}:${start}`
const REBOOTED = "Sat-Oct-17-08:00:00-2026"
const HUMAN: ScopeActor = { kind: "human", tty: true }
const self = (id: string): ScopeActor => ({ kind: "endpoint", id, auth: "session" })
const S = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const S2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"
const DAEMON = 3
const CWD = "/work/app"

/** a parent `lead` in a terminal session, and a harness daemon (pid 3) that runs background sessions as its own children */
function setup() {
  const clock = { now: 1_800_000_000_000 }
  const dead = new Set<number>()
  const reused = new Set<number>()
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    alive: (pid) => !dead.has(pid),
    startOf: (pid, expected) => (reused.has(pid) ? "Fri-Oct-16-10:00:00-2026" : expected),
  })
  core.migrate()
  const lead = core.claim({ handle: "lead", harness: "claude-code", process: key(5), session: key(5), lineage: [key(5), key(1)] }).endpoint
  const bg = (pid: number, extra: Record<string, unknown> = {}) => ({
    harness: "claude-code",
    cwd: CWD,
    process: key(pid),
    session: key(pid),
    lineage: [key(pid), key(DAEMON)],
    ...extra,
  })
  /** a hook of the daemon's session `pid`: it has the daemon's environment, so no name and no grant */
  const hook = (pid: number, extra: Record<string, unknown> = {}) => core.claim(bg(pid, { handle: "claude-app", ...extra }), { transient: true })
  /** the scp shim of session `pid`, with the name and grant the launcher put in its mount */
  const shim = (pid: number, extra: Record<string, unknown> = {}) => core.claim(bg(pid, { handle: "claude-app", ...extra }))
  const tool = (id: string, pid: number, session: string) =>
    core.event(id, { kind: "tool", tool: "Bash", session_id: session }, { transient: true, process: key(pid) })
  const peer = core.claim({ handle: "peer", harness: "codex" }).endpoint
  core.rulesSet(HUMAN, { endpoint: "peer", out: ["*"] })
  return { core, clock, dead, reused, lead, hook, shim, tool, peer, sql }
}

const local = (core: RelayCore) =>
  core
    .list({ all: true })
    .filter((view) => view.kind === "agent" && view.presence !== "offline" && view.address.startsWith("me/") && view.address !== "me/peer")
    .map((view) => view.address)
    .sort()

/** `w1` launched in the background by `lead` with a grant, run in the daemon's session pid 10 of harness session S */
function launched(order: "hook" | "shim" = "hook") {
  const ctx = setup()
  const { core, lead, hook, shim, tool } = ctx
  const grant = core.grant(self(lead.id), { name: "w1" }).token
  const named = { handle: "w1", grant }
  if (order === "hook") hook(10, { harness_session: S })
  const w1 = shim(10, { ...named, harness_session: S }).endpoint
  if (order === "shim") hook(10, { harness_session: S })
  tool(w1.id, 10, S)
  return { ...ctx, grant, named, w1 }
}

describe("a background session the harness daemon runs", () => {
  for (const order of ["hook", "shim"] as const) {
    test(`comes up as its name under its launcher (${order} first)`, () => {
      const { core, lead, w1 } = launched(order)
      expect(w1.address).toBe("me/w1")
      expect(core.whoami(w1.id).parent).toBe(lead.address)
      expect(local(core)).toEqual(["me/lead", "me/w1"])
    })
  }

  test("comes up under its launcher while its hook is still connected", () => {
    const { core, lead, hook, shim, sql } = setup()
    const grant = core.grant(self(lead.id), { name: "w1" }).token
    const first = hook(10, { harness_session: S }).endpoint
    sql.all(`UPDATE endpoints SET connections = 1 WHERE id = ?`, first.id)
    const w1 = shim(10, { handle: "w1", grant, harness_session: S }).endpoint
    expect(w1.address).toBe("me/w1")
    expect(core.whoami(w1.id).parent).toBe(lead.address)
  })

  for (const how of ["the hook", "the shim", "a shim without its name"] as const) {
    test(`resumed in a new daemon process, keeps its name, parent and mail, taken back by ${how}`, () => {
      const { core, lead, hook, shim, peer, named, w1, dead, clock } = launched()
      core.disconnect(w1.id)
      dead.add(10)
      core.send(peer.id, { to: "w1", body: "while away" })
      clock.now += 1000
      expect(core.whoami(w1.id).presence).not.toBe("offline")
      const back =
        how === "the hook"
          ? hook(11, { harness_session: S })
          : how === "the shim"
            ? shim(11, { ...named, harness_session: S })
            : shim(11, { harness_session: S })
      expect(back.endpoint.id).toBe(w1.id)
      const again = how === "the hook" ? shim(11, { ...named, harness_session: S }) : hook(11, { harness_session: S })
      expect(again.endpoint.id).toBe(w1.id)
      expect(core.whoami(w1.id).address).toBe("me/w1")
      expect(core.whoami(w1.id).parent).toBe(lead.address)
      expect(core.inbox(w1.id).map((m) => m.body.text)).toEqual(["while away"])
      expect(local(core)).toEqual(["me/lead", "me/w1"])
    })
  }

  test("resumed after its hook ended and the session went offline, as the daemon respawns it, keeps its name", () => {
    const { core, lead, hook, shim, named, w1, dead, clock } = launched()
    core.disconnect(w1.id)
    core.event(w1.id, { kind: "session_end" }, { transient: true, process: key(10) })
    dead.add(10)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    expect(hook(12, { harness_session: S }).endpoint.id).toBe(w1.id)
    expect(shim(12, { ...named, harness_session: S }).endpoint.id).toBe(w1.id)
    expect(core.whoami(w1.id).parent).toBe(lead.address)
    expect(local(core)).toEqual(["me/lead", "me/w1"])
  })

  test("forked on resume, a new harness session: the shim's name takes the endpoint back from the hook's", () => {
    const { core, lead, hook, shim, named, w1, dead, clock } = launched()
    core.disconnect(w1.id)
    dead.add(10)
    clock.now += 1000
    const fresh = hook(13, { harness_session: S2 }).endpoint
    expect(fresh.id).not.toBe(w1.id)
    expect(shim(13, { ...named, harness_session: S2 }).endpoint.id).toBe(w1.id)
    expect(hook(13, { harness_session: S2 }).endpoint.id).toBe(w1.id)
    expect(core.whoami(w1.id).address).toBe("me/w1")
    expect(core.whoami(w1.id).parent).toBe(lead.address)
    expect(local(core)).toEqual(["me/lead", "me/w1"])
  })

  test("after a broker restart and a reboot that recycled its pid, its sessions resume under their names", () => {
    const { core, lead, hook, shim, named, w1, reused, clock } = launched()
    core.disconnect(w1.id)
    core.disconnect(lead.id)
    reused.add(10)
    reused.add(5)
    clock.now += 2000
    const after = { process: key(10, REBOOTED), session: key(10, REBOOTED), lineage: [key(10, REBOOTED), key(DAEMON, REBOOTED)] }
    expect(hook(10, { ...after, harness_session: S }).endpoint.id).toBe(w1.id)
    expect(shim(10, { ...after, ...named, harness_session: S }).endpoint.id).toBe(w1.id)
    expect(core.whoami(w1.id).parent).toBe(lead.address)
    expect(local(core)).toEqual(["me/w1"])
  })

  test("a live holder of the name is never taken: a second session of the same id gets its own endpoint", () => {
    const { core, hook, w1 } = launched()
    const other = hook(14, { harness_session: S }).endpoint
    expect(other.id).not.toBe(w1.id)
    expect(core.whoami(w1.id).address).toBe("me/w1")
  })
})

describe("relink of a background session stranded on an auto-named root", () => {
  /** `w1`, placed by a narrowed grant, ended; its resume came up on a fresh root that reports the session's id */
  function stranded(report = true) {
    const ctx = setup()
    const { core, lead, hook, shim, tool, dead, clock } = ctx
    const grant = core.grant(self(lead.id), { name: "w1", out: ["tree:parent"] }).token
    const named = { handle: "w1", grant }
    hook(10, { harness_session: S })
    const w1 = shim(10, { ...named, harness_session: S }).endpoint
    tool(w1.id, 10, S)
    core.disconnect(w1.id)
    core.event(w1.id, { kind: "session_end" }, { transient: true, process: key(10) })
    dead.add(10)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    const fresh = hook(11, { harness_session: S2 }).endpoint
    if (report) tool(fresh.id, 11, S)
    return { ...ctx, grant, w1, fresh }
  }

  test("takes the grant-placed name, its parent and its caps", () => {
    const { core, lead, shim, grant, w1, fresh, dead, clock } = stranded()
    expect(core.whoami(fresh.id).parent).toBeNull()
    expect(core.relink(HUMAN)).toEqual({ relinked: [{ endpoint: fresh.id, from: "claude-app", to: "w1", by: "session", retired: w1.id }] })
    expect(core.whoami(fresh.id)).toMatchObject({ address: "me/w1", parent: lead.address })
    expect(() => core.send(fresh.id, { to: "peer", body: "out of scope" })).toThrow()
    expect(core.send(fresh.id, { to: "lead", body: "back" })).toBeTruthy()
    expect(local(core)).toEqual(["me/lead", "me/w1"])
    core.event(fresh.id, { kind: "session_end" }, { transient: true, process: key(11) })
    dead.add(11)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    expect(shim(12, { handle: "w1", grant, harness_session: S2 }).endpoint.id).toBe(fresh.id)
  })

  test("keeps its own caps as well as the grant's", () => {
    const { core, w1, fresh } = stranded()
    core.rulesSet(HUMAN, { endpoint: "claude-app", out: ["ep:peer"] })
    expect(core.relink(HUMAN).relinked[0]?.retired).toBe(w1.id)
    expect(() => core.send(fresh.id, { to: "peer", body: "the grant's caps" })).toThrow()
    expect(() => core.send(fresh.id, { to: "lead", body: "its own caps" })).toThrow()
  })

  test("the hook's next claim rehomes it the same way", () => {
    const { core, lead, hook, w1, fresh } = stranded(false)
    expect(hook(11, { harness_session: S }).endpoint.id).toBe(fresh.id)
    expect(core.whoami(fresh.id)).toMatchObject({ address: "me/w1", parent: lead.address })
    expect(core.whoami(w1.id).address).not.toBe("me/w1")
  })
})
