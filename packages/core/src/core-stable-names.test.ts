import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const START = "Thu-Oct-15-10:00:00-2026"
const key = (pid: number) => `pid:${pid}:${START}`
const HUMAN: ScopeActor = { kind: "human", tty: true }
const self = (id: string): ScopeActor => ({ kind: "endpoint", id, auth: "session" })
const H = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const S0 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"

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
  const claim = (pid: number, extra: Record<string, unknown> = {}) => ({
    handle: "claude-app",
    harness: "claude-code",
    process: key(pid),
    session: key(pid),
    lineage: [key(pid), key(1)],
    ...extra,
  })
  const hook = (pid: number, extra: Record<string, unknown> = {}) => core.claim(claim(pid, extra), { transient: true })
  const shim = (pid: number, extra: Record<string, unknown> = {}) => core.claim(claim(pid, extra))
  const tool = (id: string, pid: number, session: string) =>
    core.event(id, { kind: "tool", tool: "Bash", session_id: session }, { transient: true, process: key(pid) })
  const peer = core.claim({ handle: "peer", harness: "codex" }).endpoint
  core.rulesSet(HUMAN, { endpoint: "peer", out: ["*"] })
  return { core, clock, dead, reused, hook, shim, tool, peer }
}

function failure(fn: () => unknown): RelayError {
  try {
    fn()
  } catch (error) {
    if (error instanceof RelayError) return error
    throw error
  }
  throw new Error("no error")
}

/** a named claude-code root `lead` of harness session H, with a title, a worker and unread mail, then ended */
function away(options: { end?: boolean } = {}) {
  const ctx = setup()
  const { core, clock, hook, shim, tool, peer } = ctx
  const old = shim(9, { harness_session: H }).endpoint
  hook(9, { harness_session: H })
  tool(old.id, 9, H)
  core.rename(self(old.id), { handle: "lead" })
  core.title(old.id, "the lead")
  const worker = core.claim({ handle: "w1", harness: "codex", process: key(20), session: key(20), lineage: [key(20), key(9)] }, { transient: true }).endpoint
  core.send(peer.id, { to: "lead", body: "while away" })
  if (options.end !== false) {
    core.disconnect(old.id)
    core.event(old.id, { kind: "session_end" }, { transient: true, process: key(9) })
    clock.now += (LIMITS.hookEndedGraceS + 1) * 1000
    expect(core.whoami(old.id).presence).toBe("offline")
  }
  return { ...ctx, old, worker }
}

describe("a session resumed in process", () => {
  for (const order of ["shim", "hook"] as const) {
    test(`its hook reporting the resumed session rehomes the fresh endpoint onto the named one (${order} first)`, () => {
      const { core, hook, shim, tool, old, worker } = away()
      const first = order === "shim" ? shim(10, { harness_session: S0 }) : hook(10, { harness_session: S0 })
      const fresh = first.endpoint
      const second = order === "shim" ? hook(10, { harness_session: S0 }) : shim(10, { harness_session: S0 })
      expect(second.endpoint.id).toBe(fresh.id)
      expect(fresh.address).toBe("me/claude-app")
      tool(fresh.id, 10, S0)
      const resumed = hook(10, { harness_session: H })
      expect(resumed.rehomed).toEqual({ from: "claude-app" })
      expect(resumed.endpoint).toMatchObject({ id: fresh.id, address: "me/lead", title: "the lead", presence: "online" })
      expect(core.whoami(worker.id).parent).toBe("me/lead")
      expect(core.inbox(fresh.id).map((m) => m.body.text)).toEqual(["while away"])
      expect(core.list({ all: true }).map((e) => e.id)).not.toContain(old.id)
      expect(core.log({}).find((row) => row.event === "rehome")?.detail).toEqual({ from: "claude-app", to: "lead", retired: old.id, by: "session" })
      const again = hook(10, { harness_session: H })
      expect([again.endpoint.address, again.rehomed]).toEqual(["me/lead", undefined])
    })
  }

  test("an auto-named endpoint it held keeps no name of its own: the named one's auto title is taken too", () => {
    const { core, hook, shim, old } = away()
    core.title(old.id, "")
    const fresh = shim(10, { harness_session: S0 }).endpoint
    const resumed = hook(10, { harness_session: H })
    expect(resumed.endpoint).toMatchObject({ id: fresh.id, address: "me/lead", title: null })
  })

  test("a named endpoint is never rehomed", () => {
    const { core, hook, shim, old } = away()
    const fresh = shim(10, { harness_session: S0 }).endpoint
    core.rename(self(fresh.id), { handle: "mine" })
    const resumed = hook(10, { harness_session: H })
    expect([resumed.endpoint.address, resumed.rehomed]).toEqual(["me/mine", undefined])
    expect(core.whoami(old.id).address).toBe("me/lead")
  })

  test("a live holder is never taken: neither a connected one nor one whose hooks still report from a running process", () => {
    const connected = away({ end: false })
    const fresh = connected.shim(10, { harness_session: S0 }).endpoint
    expect(connected.hook(10, { harness_session: H }).rehomed).toBeUndefined()
    expect(connected.core.whoami(fresh.id).address).toBe("me/claude-app")
    expect(connected.core.whoami(connected.old.id).address).toBe("me/lead")

    const hooked = away({ end: false })
    hooked.core.disconnect(hooked.old.id)
    hooked.clock.now += (LIMITS.hookOnlineS + 1) * 1000
    expect(hooked.core.whoami(hooked.old.id).presence).toBe("idle")
    const other = hooked.shim(10, { harness_session: S0 }).endpoint
    expect(hooked.hook(10, { harness_session: H }).rehomed).toBeUndefined()
    expect(hooked.core.whoami(other.id).address).toBe("me/claude-app")
    expect(hooked.core.whoami(hooked.old.id).address).toBe("me/lead")
  })

  test("another process's hook never rehomes the endpoint", () => {
    const { core, hook, shim, old } = away()
    const fresh = shim(10, { harness_session: S0 }).endpoint
    const stray = core.claim(
      { handle: "claude-app", harness: "claude-code", session: key(10), process: key(11), lineage: [key(11)], harness_session: H },
      { transient: true },
    )
    expect(stray.rehomed).toBeUndefined()
    expect(core.whoami(fresh.id).address).toBe("me/claude-app")
    expect(hook(10, { harness_session: S0 }).endpoint.id).toBe(fresh.id)
    expect(core.whoami(old.id).id).toBe(old.id)
  })
})

describe("a forked session", () => {
  test("a claim with a new harness session and the old one as its origin takes the named endpoint back", () => {
    const { core, hook, shim, old, worker } = away()
    const forked = hook(10, { handle: "claude-other", harness_session: S0, harness_origin: H }).endpoint
    expect(forked).toMatchObject({ id: old.id, address: "me/lead" })
    expect(shim(10, { handle: "claude-other", harness_session: S0, harness_origin: H }).endpoint.id).toBe(old.id)
    expect(core.whoami(worker.id).parent).toBe("me/lead")
    expect(core.inbox(old.id).map((m) => m.body.text)).toEqual(["while away"])
  })

  test("an invalid origin is refused", () => {
    const { hook } = setup()
    expect(failure(() => hook(10, { harness_origin: "bad id" })).code).toBe("invalid_params")
  })
})

describe("a broker restart", () => {
  for (const how of ["dead", "reused"] as const) {
    test(`a session resumed inside the restart window takes its endpoint back once its old process is ${how}`, () => {
      const { core, hook, shim, dead, reused, old } = away({ end: false })
      core.resetConnections()
      expect(core.whoami(old.id).presence).not.toBe("offline")
      ;(how === "dead" ? dead : reused).add(9)
      expect(hook(10, { handle: "claude-other", harness_session: H }).endpoint).toMatchObject({ id: old.id, address: "me/lead" })
      expect(shim(10, { handle: "claude-other", harness_session: H }).endpoint.id).toBe(old.id)
    })
  }

  test("a running old process keeps it", () => {
    const { core, hook, old } = away({ end: false })
    core.resetConnections()
    expect(hook(10, { handle: "claude-other", harness_session: H }).endpoint.id).not.toBe(old.id)
  })
})

describe("relink", () => {
  /** a session stranded on a fresh endpoint whose hooks already report the resumed session */
  function stranded() {
    const ctx = away()
    const fresh = ctx.shim(10, { harness_session: S0 }).endpoint
    ctx.tool(fresh.id, 10, H)
    return { ...ctx, fresh }
  }

  test("a dry run lists the pairs and changes nothing; the run applies them", () => {
    const { core, fresh, old, worker } = stranded()
    const pair = { endpoint: fresh.id, from: "claude-app", to: "lead", by: "session" as const }
    expect(core.relink(HUMAN, { dry_run: true })).toEqual({ relinked: [pair] })
    expect(core.whoami(fresh.id).address).toBe("me/claude-app")
    expect(core.whoami(old.id).address).toBe("me/lead")
    expect(core.relink(HUMAN)).toEqual({ relinked: [{ ...pair, retired: old.id }] })
    expect(core.whoami(fresh.id)).toMatchObject({ address: "me/lead", title: "the lead" })
    expect(core.whoami(worker.id).parent).toBe("me/lead")
    expect(core.inbox(fresh.id).map((m) => m.body.text)).toEqual(["while away"])
    expect(core.relink(HUMAN)).toEqual({ relinked: [] })
  })

  test("pairs by the forked session's origin, never onto a live holder", () => {
    const { core, shim, tool, old } = away({ end: false })
    const fork = shim(10, { harness_session: S0, harness_origin: H }).endpoint
    tool(fork.id, 10, S0)
    expect(core.relink(HUMAN, { dry_run: true })).toEqual({ relinked: [] })
    core.disconnect(old.id)
    core.event(old.id, { kind: "session_end" }, { transient: true, process: key(9) })
    expect(core.relink(HUMAN, { dry_run: true }).relinked).toEqual([{ endpoint: fork.id, from: "claude-app", to: "lead", by: "origin" }])
  })

  test("is the human's at a terminal", () => {
    const { core, fresh } = stranded()
    expect(failure(() => core.relink(self(fresh.id))).code).toBe("scope_refused")
    expect(failure(() => core.relink({ kind: "human", tty: false })).code).toBe("scope_refused")
    expect(failure(() => core.relink(HUMAN, { dry_run: "yes" })).code).toBe("invalid_params")
    expect(core.whoami(fresh.id).address).toBe("me/claude-app")
  })
})

const S3 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d"

/**
 * session H of process 9 on the derived `claude-app` (or `claude-app-2` with a live holder of `claude-app`), titled, linked under `boss`,
 * with a grant it issued and unread mail, then ended
 */
function lane(options: { taken?: boolean; handle?: string; root?: boolean } = {}) {
  const ctx = setup()
  const { core, clock, hook, shim, tool, peer } = ctx
  core.claim({ handle: "boss", harness: "codex" })
  const holder = options.taken ? shim(30, { harness_session: S3, derived: true }).endpoint : undefined
  const extra = options.handle ? { handle: options.handle } : { derived: true }
  const old = shim(9, { harness_session: H, ...extra }).endpoint
  hook(9, { harness_session: H, ...extra })
  tool(old.id, 9, H)
  const handle = old.address.slice(3)
  core.title(old.id, "the lane")
  if (!options.root) core.adopt(HUMAN, { endpoint: handle, parent: "boss" })
  const grant = core.grant(self(old.id), { name: "w1" }).token
  core.send(peer.id, { to: handle, body: "for the lane" })
  core.disconnect(old.id)
  core.event(old.id, { kind: "session_end" }, { transient: true, process: key(9) })
  clock.now += (LIMITS.restartGraceS + 1) * 1000
  expect(core.whoami(old.id).presence).toBe("offline")
  return { ...ctx, old, handle, holder, grant, parent: options.root ? null : "me/boss" }
}

/** that the ended lane kept its handle, title, place, mail and grants */
function kept(ctx: ReturnType<typeof lane>) {
  const { core, old, handle, grant, parent } = ctx
  expect(core.whoami(old.id)).toMatchObject({ address: `me/${handle}`, title: "the lane", parent })
  expect(core.inbox(old.id).map((m) => m.body.text)).toEqual(["for the lane"])
  expect(core.claim({ handle: "w1", harness: "codex", grant }).endpoint.parent).toBe(`me/${handle}`)
}

describe("an unrelated session claiming a colliding name", () => {
  for (const how of ["shim", "hook"] as const)
    for (const taken of [false, true])
      test(`never inherits the ended lane's row, title, mail, place or grants (${how}, ${taken ? "walked to -2" : "own handle"})`, () => {
        const ctx = lane({ taken })
        const claim = how === "shim" ? ctx.shim : ctx.hook
        const fresh = claim(10, { harness_session: S0, derived: true }).endpoint
        expect(fresh.id).not.toBe(ctx.old.id)
        expect(fresh).toMatchObject({ title: null, parent: null })
        expect(ctx.core.inbox(fresh.id)).toEqual([])
        kept(ctx)
      })

  test("a hook with no derived flag walking past its own handle still gets a new row", () => {
    const ctx = lane({ taken: true })
    const fresh = ctx.hook(10, { harness_session: S0 }).endpoint
    expect(fresh.id).not.toBe(ctx.old.id)
    expect(fresh.address).toBe("me/claude-app-3")
    kept(ctx)
  })

  test("an explicit name restarts its own endpoint, with its mail, from another session", () => {
    const ctx = lane({ handle: "lane-a" })
    const back = ctx.shim(10, { handle: "lane-a", harness_session: S0 }).endpoint
    expect(back).toMatchObject({ id: ctx.old.id, address: "me/lane-a", title: "the lane" })
    expect(ctx.core.inbox(back.id).map((m) => m.body.text)).toEqual(["for the lane"])
  })

  test("a live holder is never displaced: neither a connected one nor one whose hooks report from a running process", () => {
    const ctx = lane({ taken: true })
    const { core, hook, shim } = ctx
    for (const extra of [{ derived: true }, {}]) expect(shim(10, { harness_session: S0, ...extra }).endpoint.id).not.toBe(ctx.holder!.id)
    const hooked = hook(31, { handle: "lane-b", harness_session: S3 }).endpoint
    expect(shim(11, { handle: "lane-b", harness_session: S0 }).endpoint.address).toBe("me/lane-b-2")
    expect(core.whoami(hooked.id).address).toBe("me/lane-b")
    expect(core.whoami(ctx.holder!.id).address).toBe("me/claude-app")
  })
})

describe("a resumed session", () => {
  for (const how of ["shim", "hook"] as const)
    test(`takes back only its own ended row: by its session or its origin, never an unrelated one's (${how})`, () => {
      for (const extra of [{ harness_session: H }, { harness_session: S0, harness_origin: H }]) {
        const ctx = lane()
        const claim = how === "shim" ? ctx.shim : ctx.hook
        expect(claim(10, { ...extra, derived: true }).endpoint).toMatchObject({ id: ctx.old.id, address: "me/claude-app", title: "the lane" })
      }
      const ctx = lane()
      const claim = how === "shim" ? ctx.shim : ctx.hook
      expect(claim(10, { harness_session: S3, derived: true }).endpoint.id).not.toBe(ctx.old.id)
      kept(ctx)
    })

  for (const origin of [true, false])
    test(`a shim taking back its explicit name after its hook's derived claim keeps it (${origin ? "with" : "without"} origin)`, () => {
      const ctx = lane({ handle: "lane-a", root: true })
      const { core, clock, hook, shim, tool, old } = ctx
      const derived = hook(10, { harness_session: S0, derived: true }).endpoint
      tool(derived.id, 10, S0)
      clock.now += 1000
      const named = shim(10, { handle: "lane-a", harness_session: S0, ...(origin ? { harness_origin: H } : {}) }).endpoint
      expect(named).toMatchObject({ id: old.id, address: "me/lane-a" })
      const again = hook(10, { harness_session: S0, derived: true })
      expect([again.endpoint.id, again.endpoint.address, again.rehomed]).toEqual([old.id, "me/lane-a", undefined])
      tool(old.id, 10, S0)
      expect(hook(10, { harness_session: S0, derived: true }).endpoint.address).toBe("me/lane-a")
      expect(core.log({}).filter((row) => row.event === "rehome")).toEqual([])
      expect(core.inbox(old.id).map((m) => m.body.text)).toEqual(["for the lane"])
    })

  test("a launcher's name given on resume lands the session on that name, never on another lane's row", () => {
    const ctx = lane({ handle: "lane-a", root: true })
    const { core, clock, hook, shim, tool } = ctx
    const holder = shim(30, { harness_session: S3, derived: true }).endpoint
    const other = shim(32, { harness_session: "older-lane", derived: true }).endpoint
    tool(other.id, 32, "older-lane")
    expect(other.address).toBe("me/claude-app-2")
    core.title(other.id, "older lane")
    core.disconnect(other.id)
    core.event(other.id, { kind: "session_end" }, { transient: true, process: key(32) })
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    const derived = hook(10, { harness_session: S0, derived: true }).endpoint
    tool(derived.id, 10, S0)
    const named = shim(10, { handle: "renamed", harness_session: S0, harness_origin: H }).endpoint
    expect(named.address).toBe("me/renamed")
    expect([named.id === other.id, named.id === ctx.old.id]).toEqual([false, false])
    expect(hook(10, { harness_session: S0, derived: true }).endpoint.address).toBe("me/renamed")
    expect(core.whoami(other.id)).toMatchObject({ address: "me/claude-app-2", title: "older lane" })
    expect(core.whoami(holder.id)).toMatchObject({ address: "me/claude-app", presence: "idle" })
    kept(ctx)
  })
})
