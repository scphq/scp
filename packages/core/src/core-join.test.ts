import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const HUMAN: ScopeActor = { kind: "human", tty: true }
const self = (id: string): ScopeActor => ({ kind: "endpoint", id, auth: "session" })

function setup() {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
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
  const peer = core.claim({ handle: "peer", harness: "codex" }).endpoint
  return { core, clock, claim, hook, peer }
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

describe("rename", () => {
  test("keeps the endpoint's id, inbox and threads; the session's later claims, with the old handle too, land on it", () => {
    const { core, hook, claim, peer } = setup()
    const root = hook(9).endpoint
    const sent = core.send(peer.id, { to: "claude-app", body: "before the rename" })
    const renamed = core.rename(self(root.id), { handle: "lead" })
    expect(renamed).toMatchObject({ from: "claude-app", session: key(9), endpoint: { id: root.id, address: "me/lead" } })
    expect(core.inbox(root.id).map((m) => [m.body.text, m.thread])).toEqual([["before the rename", sent.thread]])
    const reply = core.send(peer.id, { to: "lead", body: "after", thread: sent.thread })
    expect(reply.thread).toBe(sent.thread)
    expect(failure(() => core.send(peer.id, { to: "claude-app", body: "old name" })).code).toBe("not_found")
    expect(hook(9).endpoint).toMatchObject({ id: root.id, address: "me/lead" })
    expect(core.claim(claim(9)).endpoint).toMatchObject({ id: root.id, address: "me/lead" })
    expect(core.list({ all: true }).filter((e) => e.address === "me/claude-app")).toEqual([])
    expect(core.log({}).find((row) => row.event === "rename")?.detail).toEqual({ from: "claude-app", to: "lead" })
  })

  test("a spawned worker is refused unless the policy lets agents rename themselves; the human at a terminal renames it", () => {
    const { core, hook } = setup()
    const root = hook(9).endpoint
    const worker = core.claim({ handle: "w1", harness: "codex", process: key(20), session: key(20), lineage: [key(20), key(9)] }, { transient: true }).endpoint
    expect(worker.parent).toBe(root.address)
    const refused = failure(() => core.rename(self(worker.id), { handle: "w2" }))
    expect([refused.code, refused.message]).toEqual(["scope_refused", "spawned by me/claude-app; its name is set by the spawner"])
    expect(failure(() => core.rename(self(root.id), { endpoint: "w1", handle: "w2" })).code).toBe("scope_refused")
    expect(core.rename(HUMAN, { endpoint: "w1", handle: "w2" }).endpoint.address).toBe("me/w2")
    expect(failure(() => core.rename({ kind: "human", tty: false }, { endpoint: "w2", handle: "w3" })).code).toBe("scope_refused")
    core.setPolicy({ rules: [], defaults: { rename: "self" } })
    expect(core.rename(self(worker.id), { handle: "w3" }).endpoint.address).toBe("me/w3")
  })

  test("a handle a live or offline endpoint holds, a reserved or an invalid one is refused, never suffixed", () => {
    const { core, clock, hook } = setup()
    const root = hook(9).endpoint
    expect(failure(() => core.rename(self(root.id), { handle: "peer" })).message).toBe("peer is held by a live endpoint: pick another name")
    hook(30, { handle: "old" })
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    hook(9)
    expect(failure(() => core.rename(self(root.id), { handle: "old" })).message).toBe(
      "old is held by an offline endpoint: pick another name, or take it over with --take-over from a terminal",
    )
    for (const handle of ["relay", "me", "_human", "Bad Name", ""]) expect(failure(() => core.rename(self(root.id), { handle })).code).toBe("invalid_params")
    expect(core.whoami(root.id).address).toBe("me/claude-app")
  })

  test("rewrites the stored ep: selectors that named it", () => {
    const { core, hook, peer } = setup()
    const root = hook(9).endpoint
    core.rulesSet(self(peer.id), { in: ["ep:claude-app"] })
    core.rename(self(root.id), { handle: "lead" })
    expect(core.scopeView(self(peer.id)).rules.in).toEqual(["ep:lead"])
    expect(core.send(root.id, { to: "peer", body: "still allowed" }).deliveries).toHaveLength(1)
  })
})

describe("join and leave", () => {
  test("join registers a session with a name, leave takes it offline with its mail kept, join brings it back", () => {
    const { core, claim, peer } = setup()
    const joined = core.joinSession(claim(9), "lead")
    expect(joined).toMatchObject({ address: "me/lead", presence: "online" })
    core.send(peer.id, { to: "lead", body: "kept" })
    const left = core.leaveSession(self(joined.id))
    expect(left).toMatchObject({ session: key(9), endpoint: { address: "me/lead", presence: "offline" } })
    expect(core.inbox(joined.id).map((m) => m.body.text)).toEqual(["kept"])
    expect(core.joinSession(claim(9, { handle: "lead" }))).toMatchObject({ id: joined.id, address: "me/lead", presence: "online" })
  })

  test("a refused join name keeps nothing; a spawned worker is refused leave", () => {
    const { core, claim, hook } = setup()
    expect(failure(() => core.joinSession(claim(9), "peer")).code).toBe("invalid_params")
    expect(core.list({ all: true }).map((e) => e.address)).not.toContain("me/claude-app")
    const root = hook(9).endpoint
    const worker = core.claim({ handle: "w1", harness: "codex", process: key(20), session: key(20), lineage: [key(20), key(9)] }, { transient: true }).endpoint
    const refused = failure(() => core.leaveSession(self(worker.id)))
    expect([refused.code, refused.message]).toEqual(["scope_refused", `spawned by ${root.address}; a spawned worker stays joined while it runs`])
  })
})

describe("sends to an endpoint with no live session", () => {
  test("are queued with a warning; live refuses them not_live and queues nothing", () => {
    const { core, clock, hook, peer } = setup()
    const root = hook(9).endpoint
    expect(core.send(peer.id, { to: "claude-app", body: "now" }).warnings).toBeUndefined()
    clock.now += (LIMITS.hookIdleS + 60) * 1000
    expect(core.send(peer.id, { to: "claude-app", body: "later" }).warnings).toEqual(["queued: no live session holds me/claude-app"])
    const refused = failure(() => core.send(peer.id, { to: "claude-app", body: "only live", live: true }))
    expect([refused.code, refused.message]).toEqual(["not_live", "no live session holds me/claude-app: nothing was queued"])
    expect(core.inbox(root.id).map((m) => m.body.text)).toEqual(["now", "later"])
  })
})

describe("a resumed harness session", () => {
  const S = "0b8c6a52-5d2e-4c4f-9a3e-1f2d3c4b5a69"

  /** a named claude-code root holding harness session S, linked under boss by the human, with a worker and unread mail, then ended */
  function away() {
    const ctx = setup()
    const { core, clock, hook, peer } = ctx
    const boss = core.claim({ handle: "boss", harness: "codex" }).endpoint
    const root = hook(9, { harness_session: S }).endpoint
    core.event(root.id, { kind: "tool", tool: "Bash", session_id: S }, { transient: true, process: key(9) })
    core.rename(self(root.id), { handle: "lead" })
    core.adopt(HUMAN, { endpoint: "lead", parent: "boss" })
    const worker = core.claim({ handle: "w1", harness: "codex", process: key(20), session: key(20), lineage: [key(20), key(9)] }, { transient: true }).endpoint
    core.send(peer.id, { to: "lead", body: "while away" })
    core.event(root.id, { kind: "session_end" }, { transient: true, process: key(9) })
    clock.now += (LIMITS.hookEndedGraceS + 1) * 1000
    expect(core.whoami(root.id).presence).toBe("offline")
    return { ...ctx, boss, root, worker }
  }

  test("its hooks, then its shim, from a new harness process take back the endpoint with its name, place, worker and mail", () => {
    const { core, claim, hook, root, worker } = away()
    const resumed = hook(10, { handle: "claude-other", harness_session: S }).endpoint
    expect(resumed).toMatchObject({ id: root.id, address: "me/lead", parent: "me/boss", presence: "online" })
    const shim = core.claim(claim(10, { handle: "claude-other", harness_session: S }))
    expect(shim.endpoint.id).toBe(root.id)
    expect(shim.token).toBeDefined()
    expect(hook(10, { handle: "claude-other", harness_session: S }).endpoint.id).toBe(root.id)
    expect(core.whoami(worker.id).parent).toBe("me/lead")
    expect(core.inbox(root.id).map((m) => m.body.text)).toEqual(["while away"])
    expect(core.list({ all: true }).map((e) => e.address)).not.toContain("me/claude-other")
    expect(core.log({}).filter((row) => row.event === "scope_reset")).toEqual([])
    expect(core.log({}).find((row) => row.event === "claim" && row.detail?.resumed === true)?.detail).toMatchObject({ handle: "lead", transient: true })
  })

  test("its shim first, then its hooks, take it back too", () => {
    const { core, claim, hook, root } = away()
    const shim = core.claim(claim(10, { handle: "claude-other", harness_session: S }))
    expect(shim.endpoint).toMatchObject({ id: root.id, address: "me/lead", parent: "me/boss" })
    expect(shim.token).toBeDefined()
    expect(hook(10, { handle: "claude-other", harness_session: S }).endpoint.id).toBe(root.id)
    expect(core.inbox(root.id).map((m) => m.body.text)).toEqual(["while away"])
  })

  test("another harness session, or none, gets an endpoint of its own; an invalid one is refused", () => {
    const { core, hook, root } = away()
    const other = core.claim(
      { handle: "claude-other", harness: "claude-code", process: key(10), session: key(10), harness_session: "another" },
      { transient: true },
    )
    expect(other.endpoint.id).not.toBe(root.id)
    expect(hook(11, { handle: "claude-third" }).endpoint.id).not.toBe(root.id)
    expect(core.whoami(root.id).presence).toBe("offline")
    expect(failure(() => hook(12, { harness_session: "bad id" })).code).toBe("invalid_params")
  })

  test("a session stranded on a new endpoint renames onto its offline one: that one is retired, its worker, link and mail move over", () => {
    const { core, hook, root, worker } = away()
    const stranded = hook(10, { handle: "claude-other" }).endpoint
    core.event(stranded.id, { kind: "tool", tool: "Bash", session_id: S }, { transient: true, process: key(10) })
    const renamed = core.rename(self(stranded.id), { handle: "lead" })
    expect(renamed).toMatchObject({ retired: root.id, endpoint: { id: stranded.id, address: "me/lead", parent: "me/boss" } })
    expect(core.whoami(worker.id).parent).toBe("me/lead")
    expect(core.inbox(stranded.id).map((m) => m.body.text)).toEqual(["while away"])
    expect(
      core
        .list({ all: true })
        .filter((e) => e.address === "me/lead")
        .map((e) => e.id),
    ).toEqual([stranded.id])
    expect(core.log({}).find((row) => row.event === "take_over")?.detail).toEqual({
      from: "claude-other",
      to: "lead",
      retired: root.id,
      children: 1,
      by: "session",
    })
    expect(hook(10, { handle: "claude-other" }).endpoint).toMatchObject({ id: stranded.id, address: "me/lead" })
  })

  test("a join onto its offline endpoint takes it over the same way", () => {
    const { core, claim, hook, root, worker } = away()
    const stranded = hook(10, { handle: "claude-other" }).endpoint
    core.event(stranded.id, { kind: "tool", tool: "Bash", session_id: S }, { transient: true, process: key(10) })
    expect(core.joinSession(claim(10, { handle: "claude-other" }), "lead")).toMatchObject({ id: stranded.id, address: "me/lead" })
    expect(core.whoami(worker.id).parent).toBe("me/lead")
    expect(core.list({ all: true }).map((e) => e.id)).not.toContain(root.id)
  })

  test("--take-over is the human's at a terminal; a live holder is never taken", () => {
    const { core, hook, root } = away()
    const other = hook(10, { handle: "claude-other" }).endpoint
    expect(failure(() => core.rename(self(other.id), { handle: "lead" })).message).toBe(
      "lead is held by an offline endpoint: pick another name, or take it over with --take-over from a terminal",
    )
    expect(failure(() => core.rename(self(other.id), { handle: "lead", take_over: true })).code).toBe("scope_refused")
    expect(failure(() => core.rename({ kind: "human", tty: false }, { endpoint: "claude-other", handle: "lead", take_over: true })).code).toBe("scope_refused")
    expect(failure(() => core.rename(HUMAN, { endpoint: "claude-other", handle: "peer", take_over: true })).message).toBe(
      "peer is held by a live endpoint: pick another name",
    )
    expect(failure(() => core.rename(HUMAN, { endpoint: "claude-other", handle: "lead", take_over: "yes" })).code).toBe("invalid_params")
    expect(core.rename(HUMAN, { endpoint: "claude-other", handle: "lead", take_over: true })).toMatchObject({ retired: root.id, endpoint: { id: other.id } })
    expect(core.log({}).find((row) => row.event === "take_over")?.detail).toMatchObject({ by: "human", retired: root.id })
  })
})
