import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { GONE_PREFIX, RelayCore } from "./core"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const HUMAN: ScopeActor = { kind: "human", tty: true }
const self = (id: string): ScopeActor => ({ kind: "endpoint", id, auth: "session" })
const ORIGIN = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const FORK = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"
const HANDOFF = { harness_session: FORK, harness_origin: ORIGIN, harness_handoff: true }

/** a named claude-code root `lead` of harness session ORIGIN, its shim still connected, with a worker and unread mail */
function live() {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    alive: () => true,
    startOf: (_pid, expected) => expected,
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
  const old = shim(9, { harness_session: ORIGIN }).endpoint
  hook(9, { harness_session: ORIGIN })
  tool(old.id, 9, ORIGIN)
  core.rename(self(old.id), { handle: "lead" })
  core.title(old.id, "the lead")
  const worker = core.claim({ handle: "w1", harness: "codex", process: key(20), session: key(20), lineage: [key(20), key(9)] }, { transient: true }).endpoint
  core.send(peer.id, { to: "lead", body: "while away" })
  return { core, clock, hook, shim, tool, old, worker }
}

const quiet = (clock: { now: number }) => {
  clock.now += (LIMITS.restartGraceS + 1) * 1000
}

describe("a background hand-off", () => {
  for (const order of ["hook", "shim"] as const) {
    test(`takes over the endpoint its idle origin still holds, with its name, children and mail (${order} first)`, () => {
      const { core, clock, hook, shim, old, worker } = live()
      quiet(clock)
      expect(core.whoami(old.id).presence).not.toBe("offline")
      const first = order === "hook" ? hook(30, HANDOFF) : shim(30, HANDOFF)
      expect(first.handedOff).toEqual({ from: "claude-app", retired: old.id })
      const fork = first.endpoint
      expect(fork.id).not.toBe(old.id)
      expect(core.whoami(fork.id)).toMatchObject({ address: "me/lead", title: "the lead" })
      expect(core.whoami(worker.id).parent).toBe("me/lead")
      expect(core.inbox(fork.id).map((m) => m.body.text)).toEqual(["while away"])
      expect(core.whoami(old.id).address.startsWith(`me/${GONE_PREFIX}`)).toBe(true)
      const second = order === "hook" ? shim(30, HANDOFF) : hook(30, HANDOFF)
      expect(second.endpoint.id).toBe(fork.id)
      expect(second.handedOff).toBeUndefined()
    })
  }

  test("a hook joining on demand reports the hand-off it made", () => {
    const { core, clock, old, worker } = live()
    quiet(clock)
    const heard: { from: string; retired: string }[] = []
    const fork = core.joinSession(
      { handle: "claude-app", harness: "claude-code", process: key(30), session: key(30), lineage: [key(30), key(1)], ...HANDOFF },
      undefined,
      undefined,
      (moved) => heard.push(moved),
    )
    expect(heard).toEqual([{ from: "claude-app", retired: old.id }])
    expect(fork.address).toBe("me/lead")
    expect(core.whoami(worker.id).parent).toBe("me/lead")
  })

  test("leaves the origin's process a fresh name of its own, never taken back by the fork", () => {
    const { core, clock, hook, shim, old } = live()
    quiet(clock)
    const fork = hook(30, HANDOFF).endpoint
    const back = shim(9, { harness_session: ORIGIN }).endpoint
    expect(back.id).not.toBe(old.id)
    expect(back.id).not.toBe(fork.id)
    expect(core.whoami(back.id).address).toBe("me/claude-app")
    quiet(clock)
    expect(hook(30, HANDOFF).handedOff).toBeUndefined()
    expect(core.whoami(fork.id).address).toBe("me/lead")
  })

  test("a parallel fork without the hand-off gets a name of its own", () => {
    const { core, clock, hook, shim, old, worker } = live()
    quiet(clock)
    const fork = hook(30, { harness_session: FORK, harness_origin: ORIGIN })
    expect(fork.handedOff).toBeUndefined()
    expect(shim(30, { harness_session: FORK, harness_origin: ORIGIN }).endpoint.id).toBe(fork.endpoint.id)
    expect(core.whoami(fork.endpoint.id).address).toBe("me/claude-app")
    expect(core.whoami(old.id).address).toBe("me/lead")
    expect(core.whoami(worker.id).parent).toBe("me/lead")
  })

  test("waits while the origin just reported, then takes over once it stayed quiet since", () => {
    const { core, clock, hook, old } = live()
    clock.now += 5000
    const fork = hook(30, HANDOFF)
    expect(fork.handedOff).toBeUndefined()
    expect(core.whoami(fork.endpoint.id).address).toBe("me/claude-app")
    clock.now += 5000
    expect(hook(30, HANDOFF).handedOff).toEqual({ from: "claude-app", retired: old.id })
    expect(core.whoami(fork.endpoint.id).address).toBe("me/lead")
  })

  test("never takes a busy origin: one whose hooks reported after the fork started", () => {
    const { core, clock, hook, tool, old } = live()
    clock.now += 5000
    const fork = hook(30, HANDOFF).endpoint
    clock.now += 1000
    tool(old.id, 9, ORIGIN)
    quiet(clock)
    expect(hook(30, HANDOFF).handedOff).toBeUndefined()
    expect(core.whoami(fork.id).address).toBe("me/claude-app")
    expect(core.whoami(old.id).address).toBe("me/lead")
  })

  test("a malformed flag is refused", () => {
    const { core } = live()
    const error = (() => {
      try {
        core.claim({ handle: "x", harness: "claude-code", harness_handoff: "yes" as unknown as boolean })
      } catch (error) {
        return error
      }
    })()
    expect(error).toBeInstanceOf(RelayError)
    expect((error as RelayError).code).toBe("invalid_params")
  })
})

describe("relink of a stranded background session", () => {
  test("lists a live idle origin for confirmation and applies it only with live", () => {
    const { core, clock, hook, old, worker } = live()
    quiet(clock)
    const fork = hook(30, { harness_session: FORK, harness_origin: ORIGIN }).endpoint
    const pair = { endpoint: fork.id, from: "claude-app", to: "lead", by: "origin" as const, live: true as const }
    expect(core.relink(HUMAN, { dry_run: true })).toEqual({ relinked: [pair] })
    expect(core.relink(HUMAN, {})).toEqual({ relinked: [pair] })
    expect(core.whoami(fork.id).address).toBe("me/claude-app")
    expect(core.relink(HUMAN, { live: true })).toEqual({ relinked: [{ ...pair, retired: old.id }] })
    expect(core.whoami(fork.id).address).toBe("me/lead")
    expect(core.whoami(worker.id).parent).toBe("me/lead")
    expect(core.inbox(fork.id).map((m) => m.body.text)).toEqual(["while away"])
  })

  test("skips an origin busy since the fork started", () => {
    const { core, clock, hook, tool, old } = live()
    quiet(clock)
    hook(30, { harness_session: FORK, harness_origin: ORIGIN })
    clock.now += 1000
    tool(old.id, 9, ORIGIN)
    expect(core.relink(HUMAN, { dry_run: true, live: true })).toEqual({ relinked: [] })
  })
})
