import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const self = (id: string): ScopeActor => ({ kind: "endpoint", id, auth: "session" })
const human: ScopeActor = { kind: "human", tty: false }

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
  const lane = core.claim({ handle: "lane", harness: "codex", session: key(7), process: key(7) }).endpoint
  const audit = (event: string) =>
    (db.query("SELECT detail FROM audit WHERE event = ? ORDER BY id").all(event) as { detail: string }[]).map((r) => JSON.parse(r.detail))
  return { core, clock, db, peer, lane, audit }
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

describe("hibernate", () => {
  test("a hibernated agent shows hibernated and its hook wake whatever its connections say; none clears it", () => {
    const { core, lane, audit } = setup()
    const { endpoint } = core.hibernate(self(lane.id), { wake: "vm-sleep", ref: "vm-42" })
    expect(endpoint).toMatchObject({ presence: "hibernated", wake: "hook:vm-sleep" })
    expect(core.list().find((e) => e.id === lane.id)).toMatchObject({ presence: "hibernated", wake: "hook:vm-sleep" })
    expect(audit("hibernate")).toEqual([{ by: "me/lane", target: "me/lane", provider: "vm-sleep" }])
    expect(JSON.stringify(audit("hibernate"))).not.toContain("vm-42")
    expect(core.hibernate(human, { endpoint: "lane", wake: "none" }).endpoint.presence).toBe("online")
    expect(audit("unhibernate")).toEqual([{ by: "me/", target: "me/lane" }])
    expect(core.whoami(lane.id).wake).toBeNull()
  })

  test("it checks the provider, the ref, the actor and the target", () => {
    const { core, peer, lane } = setup()
    expect(code(() => core.hibernate(self(lane.id), { wake: "Bad Name" }))).toBe("invalid_params")
    expect(code(() => core.hibernate(self(lane.id), { wake: "vm" }, { known: (p) => p === "other" }))).toBe("invalid_params")
    expect(code(() => core.hibernate(self(lane.id), { wake: "vm", ref: "x".repeat(LIMITS.wakeRefChars + 1) }))).toBe("invalid_params")
    expect(code(() => core.hibernate(self(lane.id), { wake: "vm", ref: "a\nb" }))).toBe("invalid_params")
    expect(code(() => core.hibernate(self(lane.id), { wake: "vm", ref: "AKIAABCDEFGHIJKLMNOP" }))).toBe("secret_refused")
    expect(code(() => core.hibernate({ kind: "endpoint", id: lane.id, auth: "lineage" }, { wake: "vm" }))).toBe("scope_refused")
    expect(code(() => core.hibernate(self(peer.id), { endpoint: "lane", wake: "vm" }))).toBe("scope_refused")
    expect(code(() => core.hibernate(human, { wake: "vm" }))).toBe("invalid_params")
    expect(code(() => core.hibernate(human, { endpoint: "me/", wake: "vm" }))).toBe("invalid_params")
    expect(core.hibernate(human, { endpoint: "lane", wake: "vm" }, { known: (p) => p === "vm" }).endpoint.presence).toBe("hibernated")
  })

  test("a transient hook claim keeps it; a non-transient claim of the row or its session_start clears it", () => {
    const { core, lane, audit } = setup()
    core.hibernate(self(lane.id), { wake: "vm" })
    core.claim({ harness: "codex", session: key(7), process: key(7) }, { transient: true })
    expect(core.whoami(lane.id).presence).toBe("hibernated")
    core.disconnect(lane.id)
    core.claim({ handle: "lane", harness: "codex", session: key(7), process: key(7) })
    expect(core.whoami(lane.id).presence).toBe("online")
    expect(audit("wake_done")).toEqual([{ target: "me/lane", how: "claim" }])
    core.hibernate(self(lane.id), { wake: "vm" })
    core.event(lane.id, { kind: "session_start", summary: "resume" })
    expect(core.whoami(lane.id).presence).not.toBe("hibernated")
    expect(audit("wake_done").at(-1)).toEqual({ target: "me/lane", how: "session_start" })
  })

  test("a send queues for it, marked hibernated; a live send refuses it", () => {
    const { core, peer, lane } = setup()
    core.hibernate(self(lane.id), { wake: "vm" })
    const sent = core.send(peer.id, { to: "lane", body: "hello" })
    expect(sent.deliveries[0]).toMatchObject({ queued: true, hibernated: true, offline: false })
    expect(code(() => core.send(peer.id, { to: "lane", body: "now?", live: true }))).toBe("not_live")
  })

  test("wakeDue debounces and backs off, and its job carries the newest message's metadata only", () => {
    const { core, clock, peer, lane } = setup()
    expect(core.wakeDue(lane.id)).toBeNull()
    core.hibernate(self(lane.id), { wake: "vm", ref: "vm-42" })
    expect(core.wakeDue(lane.id)).toBeNull()
    core.send(peer.id, { to: "lane", body: "first secret-free body" })
    const sent = core.send(peer.id, { to: "lane", body: "UNIQUE-BODY-7731", kind: "request" })
    const job = core.wakeDue(lane.id)!
    expect(job).toMatchObject({ address: "me/lane", handle: "lane", provider: "vm", ref: "vm-42", unread: 2 })
    expect(job.message).toMatchObject({ id: sent.id, from: "me/peer", kind: "request", thread: sent.thread })
    expect(JSON.stringify(job)).not.toContain("UNIQUE-BODY")
    expect(core.wakeDue(lane.id)).toBeNull()
    clock.now += LIMITS.wakeDebounceS * 1000
    expect(core.wakeDue(lane.id)).not.toBeNull()
    expect(core.wakeResult(lane.id, { ok: false, code: 3, ms: 12 })).toBe(true)
    expect(core.whoami(lane.id)).toMatchObject({ presence: "hibernated", wake_failed: "exit 3" })
    clock.now += LIMITS.wakeDebounceS * 1000
    expect(core.wakeDue(lane.id)).toBeNull()
    clock.now += LIMITS.wakeDebounceS * 1000
    expect(core.wakeDue(lane.id)).not.toBeNull()
    core.wakeResult(lane.id, { ok: false, error: "provider said no", ms: 5 })
    clock.now += LIMITS.wakeDebounceS * 4 * 1000 - 1
    expect(core.wakeDue(lane.id)).toBeNull()
    clock.now += 1
    expect(core.wakeDue(lane.id)).not.toBeNull()
    expect(core.wakeResult(lane.id, { ok: true, code: 0, ms: 5 })).toBe(true)
    expect(core.whoami(lane.id)).not.toHaveProperty("wake_failed")
    expect(core.whoami(lane.id).presence).toBe("hibernated")
  })

  test("a decline shows wake_declined, adds no backoff, and holds runs for that message and its sender until another sender or a new hibernate", () => {
    const { core, peer, lane, audit } = setup()
    const other = core.claim({ handle: "other", harness: "codex" }).endpoint
    core.hibernate(self(lane.id), { wake: "vm", eta_s: 90 })
    const first = core.send(peer.id, { to: "lane", body: "one" })
    expect(first.deliveries[0]).toMatchObject({ wake: "hook:vm", wake_eta_s: 90 })
    const job = core.wakeDue(lane.id)!
    expect(core.wakeResult(lane.id, { ok: false, code: 77, declined: "budget", ms: 3, message: job.message.id })).toBe(true)
    expect(core.whoami(lane.id)).toMatchObject({ presence: "hibernated", wake_declined: "budget" })
    expect(core.whoami(lane.id)).not.toHaveProperty("wake_failed")
    expect(audit("wake").at(-1)).toMatchObject({ ok: false, declined: "budget" })
    expect(core.wakeDue(lane.id)).toBeNull()
    expect(core.send(peer.id, { to: "lane", body: "two" }).deliveries[0]).toMatchObject({ wake: "declined" })
    expect(core.wakeDue(lane.id)).toBeNull()
    core.send(other.id, { to: "lane", body: "three" })
    expect(core.wakeDue(lane.id)?.message.from).toBe("me/other")
    core.wakeResult(lane.id, { ok: false, declined: "policy", ms: 1, message: first.id })
    core.hibernate(self(lane.id), { wake: "vm" })
    expect(core.whoami(lane.id)).not.toHaveProperty("wake_declined")
    expect(core.wakeDue(lane.id)).not.toBeNull()
    expect(code(() => core.hibernate(self(lane.id), { wake: "vm", eta_s: 0 }))).toBe("invalid_params")
    core.wakeResult(lane.id, { ok: false, code: 77, declined: "Not a token", ms: 1 })
    expect(core.whoami(lane.id)).toMatchObject({ wake_failed: "exit 77" })
    expect(core.whoami(lane.id)).not.toHaveProperty("wake_declined")
  })

  test("the human hibernates every live local agent at once, subagents and offline ones left out", () => {
    const { core, peer, lane } = setup()
    const gone = core.claim({ handle: "gone", harness: "codex" }).endpoint
    core.disconnect(gone.id)
    expect(code(() => core.hibernateAll(self(lane.id), { wake: "vm" }))).toBe("scope_refused")
    const { endpoints } = core.hibernateAll(human, { wake: "vm", ref: "box" })
    expect(endpoints.map((e) => e.address).sort()).toEqual(["me/lane", "me/peer"])
    expect(endpoints.every((e) => e.presence === "hibernated")).toBe(true)
    expect(core.whoami(gone.id).presence).toBe("offline")
    expect(core.hibernateAll(human, { wake: "none" }).endpoints.map((e) => e.presence)).toEqual(["online", "online"])
    expect(core.whoami(peer.id).presence).toBe("online")
  })
})

describe("the broker's own tasks", () => {
  test("the broker hibernates a local agent and clears it, audited by broker; spawn, unknown providers and the human are refused", () => {
    const { core, lane, audit } = setup()
    expect(core.brokerHibernate(lane.id, { wake: "claude-bg", ref: "s-1" })).toMatchObject({ presence: "hibernated", wake: "hook:claude-bg" })
    expect(audit("hibernate")).toEqual([{ by: "broker", target: "me/lane", provider: "claude-bg" }])
    expect(core.brokerHibernate(lane.id, { wake: "none" }).presence).toBe("online")
    expect(audit("unhibernate")).toEqual([{ by: "broker", target: "me/lane" }])
    expect(code(() => core.brokerHibernate(lane.id, { wake: "spawn", ref: "x" }))).toBe("invalid_params")
    expect(code(() => core.brokerHibernate(lane.id, { wake: "claude-bg" }, { known: () => false }))).toBe("invalid_params")
    expect(code(() => core.brokerHibernate(core.humanId(), { wake: "claude-bg" }))).toBe("invalid_params")
  })

  test("local agents carry their parent, children, unread mail and last work, which a keepalive never moves", () => {
    const { core, clock, lane } = setup()
    const token = core.grant(self(lane.id), { name: "w1", ttl_s: 3600 }).token
    const worker = core.claim({ handle: "w1", harness: "claude-code", grant: token, session: key(9), process: key(9) }).endpoint
    const facts = (id: string) => core.localAgents().find((agent) => agent.id === id)!
    expect(facts(lane.id)).toMatchObject({ parent: null, children: 1, unread: false, handed_back: false })
    expect(facts(worker.id)).toMatchObject({ address: "me/w1", handle: "w1", parent: "me/lane", children: 0, hibernate: null })
    const worked = facts(worker.id).worked_at
    clock.now += 60_000
    core.touch(worker.id)
    expect(facts(worker.id).worked_at).toBe(worked)
    core.send(lane.id, { to: "w1", body: "hi" })
    expect(facts(worker.id)).toMatchObject({ unread: true })
    expect(facts(worker.id).worked_at).not.toBe(worked)
    core.status(worker.id, "done", "")
    expect(facts(worker.id).state).toBe("done")
  })
})
