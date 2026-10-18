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
    expect(failure(() => core.rename(self(root.id), { handle: "old" })).message).toBe("old is held by an offline endpoint: pick another name")
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
