import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Mon-Oct-19-10:00:00-2026`
const REF = JSON.stringify({ harness: "codex", session: "019a-s", cwd: "/w", argv: ["codex", "exec", "resume", "019a-s"], idle_s: 60 })

function setup() {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const exited = new Set<number>()
  const core = new RelayCore(sql, {
    alive: (pid) => !exited.has(pid),
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  })
  core.migrate()
  const main = core.claim({ handle: "main", harness: "claude-code", process: key(1), session: key(1), lineage: [key(1)] }).endpoint
  const actor: ScopeActor = { kind: "endpoint", id: main.id, auth: "session" }
  const grant = core.grant(actor, { name: "w1", spawn: true, bind_process: key(1) })
  const worker = core.claim({
    handle: "w1",
    harness: "codex",
    process: key(6),
    session: key(6),
    lineage: [key(6), key(5), key(1)],
    grant: grant.token,
  }).endpoint
  /** the worker's harness exited; spawn takes its endpoint with the spent grant and holds it, durably with `ref` */
  const hold = (ref?: string) => {
    exited.add(6)
    core.disconnect(worker.id)
    const held = core.claim({
      handle: "w1",
      harness: "codex",
      cwd: "/w",
      session: "env:held",
      process: key(9),
      lineage: [key(1)],
      grant: grant.token,
      exact: true,
    })
    core.setWake(held.endpoint.id, "spawn-resume", ref ? { ref } : {})
    core.waker(held.endpoint.id, true)
    return held.endpoint
  }
  const row = (id: string) => db.query("SELECT wake, hold_ref, hibernate, wake_ref FROM endpoints WHERE id = ?").get(id)
  const audit = (event: string) =>
    (db.query("SELECT detail FROM audit WHERE event = ? ORDER BY id").all(event) as { detail: string }[]).map((r) => JSON.parse(r.detail))
  const message = (id: string) => db.query("SELECT thread, reply_to, from_ep, body FROM messages WHERE id = ?").get(id) as Record<string, string>
  return { core, clock, db, main, actor, grant, worker, hold, row, audit, message }
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

describe("a held spawn", () => {
  test("spawn takes the exited worker's endpoint back with its spent grant and holds it with wake spawn-resume", () => {
    const { core, worker, hold, row } = setup()
    const held = hold(REF)
    expect(held.id).toBe(worker.id)
    expect(held.address).toBe("me/w1")
    expect(core.whoami(worker.id)).toMatchObject({ wake: "spawn-resume", presence: "online", parent: "me/main" })
    expect(row(worker.id)).toMatchObject({ wake: "spawn-resume", hold_ref: REF, hibernate: null })
  })

  test("a durable ref goes only with spawn-resume from a holding connection: no other wake, no hook, no credential, at most 512 characters", () => {
    const { core, worker, hold, row } = setup()
    hold()
    expect(code(() => core.setWake(worker.id, "channels", { ref: REF }))).toBe("invalid_params")
    expect(code(() => core.setWake(worker.id, "spawn-resume", { ref: REF, transient: true, process: key(9) }))).toBe("invalid_params")
    expect(code(() => core.setWake(worker.id, "spawn-resume", { ref: "x".repeat(513) }))).toBe("invalid_params")
    expect(code(() => core.setWake(worker.id, "spawn-resume", { ref: "AKIAABCDEFGHIJKLMNOP" }))).toBe("secret_refused")
    core.setWake(worker.id, "spawn-resume", { ref: REF })
    core.setWake(worker.id, "none", { transient: true, process: key(9) })
    expect(row(worker.id)).toMatchObject({ wake: null, hold_ref: REF })
    core.setWake(worker.id, "spawn-resume")
    expect(row(worker.id)).toMatchObject({ wake: "spawn-resume", hold_ref: null })
  })

  test("its first handback says it stays resumable; each later run hands back once, as a reply in the spawn thread", () => {
    const { core, actor, main, grant, worker, hold, message } = setup()
    hold(REF)
    const first = core.spawnExit(actor, { grant: grant.token, code: 0, output: "first result" })
    expect(message(first.handback!).body).toBe("worker me/w1 finished (exit 0)\n\nfirst result\n\nme/w1 stays resumable: message it to resume its session")
    expect(core.whoami(worker.id)).toMatchObject({ wake: "spawn-resume", status: { state: "done", note: "exited 0" } })
    expect(core.spawnExit(actor, { grant: grant.token, code: 0, output: "again" }).handback).toBeNull()
    const steer = core.send(main.id, { to: "w1", body: "one more", thread: "thr_work" })
    const second = core.spawnExit(actor, { grant: grant.token, code: 0, output: "second result", run: 2, reply_to: steer.id })
    expect(message(second.handback!)).toMatchObject({
      thread: "thr_work",
      reply_to: steer.id,
      from_ep: worker.id,
      body: "worker me/w1 finished (exit 0)\n\nsecond result\n\nme/w1 stays resumable: message it to resume its session",
    })
    expect(core.spawnExit(actor, { grant: grant.token, code: 0, output: "dup", run: 2 }).handback).toBeNull()
    const third = core.spawnExit(actor, { grant: grant.token, code: 3, stderr: "boom", run: 3, reply_to: "msg_unknown" })
    expect(message(third.handback!)).toMatchObject({
      thread: message(first.handback!).thread,
      reply_to: first.handback,
      body: "worker me/w1 exited without replying (exit 3)\n\nstderr (last 1 KB):\nboom\n\nme/w1 stays resumable: message it to resume its session",
    })
    expect(core.spawnExit(actor, { grant: grant.token, code: 0, run: 2 }).handback).toBeNull()
    expect(core.inbox(main.id).map((m) => m.id)).toEqual([first.handback!, second.handback!, third.handback!])
    expect(code(() => core.spawnExit(actor, { grant: grant.token, code: 0, run: 0 }))).toBe("invalid_params")
  })

  test("a plain hold's handback says it stays resumable only until the spawn's idle time runs out", () => {
    const { core, actor, grant, hold, message } = setup()
    hold()
    const first = core.spawnExit(actor, { grant: grant.token, code: 0, output: "done" })
    expect(message(first.handback!).body).toBe(
      "worker me/w1 finished (exit 0)\n\ndone\n\nme/w1 stays resumable until its spawn's idle time runs out: message it before then to resume its session",
    )
  })

  test("a send to a done worker its spawn holds or hibernated wakes it; once let go its run ended", () => {
    const { core, actor, main, grant, worker, hold } = setup()
    hold(REF)
    core.spawnExit(actor, { grant: grant.token, code: 0, output: "done" })
    expect(core.send(main.id, { to: "w1", body: "held" }).deliveries[0]).toMatchObject({ state: "running", wake: "spawn-resume", idle: true })
    core.hibernateHeld(worker.id)
    core.waker(worker.id, false)
    expect(core.send(main.id, { to: "w1", body: "hibernated" }).deliveries[0]).toMatchObject({ state: "running", hibernated: true, idle: true })
    core.spawnEnd(actor, { endpoint: "w1" })
    expect(core.send(main.id, { to: "w1", body: "gone" }).deliveries[0]).toMatchObject({ state: "ended" })
  })

  test("a durable hold whose connection goes without a hibernate or an end is hibernated by the broker with its ref; one woken plainly is not", () => {
    const { core, worker, hold, row, audit } = setup()
    hold(REF)
    expect(core.hibernateHeld(worker.id).map((view) => [view.address, view.presence, view.wake])).toEqual([["me/w1", "hibernated", "hook:spawn"]])
    core.waker(worker.id, false)
    expect(row(worker.id)).toMatchObject({ hibernate: "spawn", wake_ref: REF, hold_ref: null })
    expect(audit("hibernate")).toEqual([{ by: "broker", target: "me/w1", provider: "spawn" }])
    expect(core.hibernateHeld(worker.id)).toEqual([])
    const plain = setup()
    plain.hold()
    expect(plain.core.hibernateHeld(plain.worker.id)).toEqual([])
  })

  test("the broker's start hibernates every endpoint a durable spawn still held", () => {
    const { core, worker, hold, row } = setup()
    hold(REF)
    core.resetConnections()
    expect(core.hibernateHeld().map((view) => view.address)).toEqual(["me/w1"])
    expect(row(worker.id)).toMatchObject({ hibernate: "spawn", wake_ref: REF })
  })

  test("its own hibernate clears the durable ref, so closing after it hibernates nothing again", () => {
    const { core, worker, hold, row } = setup()
    hold(REF)
    core.hibernate({ kind: "endpoint", id: worker.id, auth: "session" }, { wake: "spawn", ref: REF })
    expect(row(worker.id)).toMatchObject({ hibernate: "spawn", hold_ref: null })
    expect(core.hibernateHeld(worker.id)).toEqual([])
  })

  test("a spawn waker run's ticket takes the hibernated worker back as its resumed session, never an incarnation", () => {
    const { core, db, main, worker, hold, audit } = setup()
    hold(REF)
    db.query(`UPDATE endpoints SET labels = '{"team":"a"}', peek = 'local', title = 'durable' WHERE id = ?`).run(worker.id)
    db.query("INSERT INTO group_members (name, endpoint, added_by, at) VALUES ('crew', ?, ?, 0)").run(worker.id, main.id)
    core.waker(worker.id, false)
    core.hibernateHeld(worker.id)
    core.disconnect(worker.id)
    core.send(main.id, { to: "w1", body: "remember?" })
    const job = core.wakeDue(worker.id)!
    const ticket = job.ticket!
    expect(ticket).toMatch(/^kwt_[0-9a-f]{64}$/)
    expect(code(() => core.claim({ handle: "w1", harness: "codex", exact: true, process: key(20), session: "env:woken" }))).toBe("unauthorized")
    expect(code(() => core.claim({ handle: "w1", harness: "codex", process: key(21), session: "env:x", ticket: `kwt_${"0".repeat(64)}` }))).toBe("unauthorized")
    expect(code(() => core.claim({ handle: "w1", harness: "grok", process: key(21), session: "env:x", ticket }))).toBe("unauthorized")
    const back = core.claim({ handle: "w1", harness: "codex", exact: true, process: key(22), session: "env:woken", ticket }).endpoint
    expect([back.id, back.parent, back.presence, back.title]).toEqual([worker.id, "me/main", "online", "durable"])
    expect(back.labels).toMatchObject({ team: "a" })
    expect(db.query("SELECT peek, hibernate, wake_ticket FROM endpoints WHERE id = ?").get(worker.id)).toEqual({
      peek: "local",
      hibernate: null,
      wake_ticket: null,
    })
    expect(db.query("SELECT name FROM group_members WHERE endpoint = ?").all(worker.id)).toEqual([{ name: "crew" }])
    expect(audit("scope_reset")).toEqual([])
    expect(audit("claim").at(-1)).toMatchObject({ handle: "w1", resumed: true })
    core.disconnect(worker.id)
    expect(code(() => core.claim({ handle: "w1", harness: "codex", process: key(23), session: "env:again", ticket }))).toBe("unauthorized")
  })

  test("a wake ticket waits while held and survives a later revivable run", () => {
    const { core, clock, main, worker, hold } = setup()
    hold(REF)
    core.hibernate({ kind: "endpoint", id: worker.id, auth: "session" }, { wake: "spawn", ref: REF })
    core.send(main.id, { to: "w1", body: "wake" })
    const first = core.wakeDue(worker.id)!.ticket!
    expect(code(() => core.claim({ handle: "w1", harness: "codex", process: key(24), session: "env:early", ticket: first }))).toBe("unavailable")
    core.waker(worker.id, false)
    core.disconnect(worker.id)
    clock.now += 61_000
    const second = core.wakeDue(worker.id)!.ticket!
    expect(second).not.toBe(first)
    expect(core.claim({ handle: "w1", harness: "codex", process: key(25), session: "env:old", ticket: first }).endpoint.id).toBe(worker.id)
    core.disconnect(worker.id)
    expect(code(() => core.claim({ handle: "w1", harness: "codex", ticket: second }))).toBe("unauthorized")
  })

  for (const hooks of [false, true]) {
    test(`a new session skips a revivable handle with hooks ${hooks}`, () => {
      const { core, db, main, worker } = setup()
      core.disconnect(main.id)
      core.brokerHibernate(main.id, { wake: "claude-bg", ref: REF })
      core.send(worker.id, { to: "main", body: "waiting" })
      const ticket = core.wakeDue(main.id)!.ticket!
      if (hooks) core.claim({ handle: "hook", harness: "claude-code", process: key(70), session: key(70) }, { transient: true })
      const next = core.claim({ handle: "main", harness: "claude-code", process: key(70), session: key(70) }).endpoint
      expect(next.address).toBe("me/main-2")
      expect(core.whoami(main.id)).toHaveProperty("revivable", true)
      expect(core.inbox(main.id)).toHaveLength(1)
      expect(db.query("SELECT wake_ticket FROM endpoints WHERE id = ?").get(main.id)).toEqual({
        wake_ticket: new Bun.CryptoHasher("sha256").update(ticket).digest("hex"),
      })
    })
  }

  test("a revivable row's own session keeps its state from a new process", () => {
    const { core, db, main, audit } = setup()
    core.claim({ handle: "main", harness: "claude-code", session: key(1), process: key(1) }, { transient: true })
    core.disconnect(main.id)
    db.query("UPDATE endpoints SET peek = 'local' WHERE id = ?").run(main.id)
    core.brokerHibernate(main.id, { wake: "claude-bg", ref: REF })
    const back = core.claim({ handle: "other", harness: "claude-code", session: key(1), process: key(73) }).endpoint
    expect(back.id).toBe(main.id)
    expect(back.address).toBe("me/main")
    expect(db.query("SELECT peek, session FROM endpoints WHERE id = ?").get(main.id)).toEqual({ peek: "local", session: key(1) })
    expect(audit("scope_reset")).toEqual([])
  })

  test("revive tickets survive repeated kicks and runs until claimed", () => {
    const { core, main, worker } = setup()
    core.disconnect(main.id)
    core.brokerHibernate(main.id, { wake: "claude-bg", ref: REF })
    core.send(worker.id, { to: "main", body: "waiting" })
    const first = core.wakeDue(main.id)!.ticket!
    for (let n = 0; n < 3; n++) {
      core.brokerHibernate(main.id, { wake: "claude-bg", ref: REF })
      expect(core.wakeDue(main.id)?.ticket).toMatch(/^kwt_[0-9a-f]{64}$/)
    }
    expect(core.claim({ handle: "main", harness: "claude-code", session: "revived", process: key(71), ticket: first }).endpoint.id).toBe(main.id)
    core.disconnect(main.id)
    expect(code(() => core.claim({ handle: "main", harness: "claude-code", ticket: first }))).toBe("unauthorized")
  })

  test("a transient hook resumes a local revivable child by harness session before its ticketed claim", () => {
    const { core, db, main, worker } = setup()
    db.query("UPDATE endpoints SET harness_session = ? WHERE id = ?").run("019a-s", worker.id)
    core.disconnect(worker.id)
    core.brokerHibernate(worker.id, { wake: "claude-bg", ref: REF })
    core.send(main.id, { to: "w1", body: "waiting" })
    const ticket = core.wakeDue(worker.id)!.ticket!
    for (const session of ["start", "prompt"]) {
      const hook = core.claim({ handle: "root", harness: "codex", session, process: key(72), harness_session: "019a-s" }, { transient: true })
      expect(hook.endpoint.id).toBe(worker.id)
      expect(hook.endpoint.parent).toBe("me/main")
      expect(hook.endpoint).toHaveProperty("revivable", true)
    }
    expect(core.claim({ handle: "w1", harness: "codex", session: "mcp", process: key(72), ticket }).endpoint.id).toBe(worker.id)
    expect(core.inbox(worker.id)).toHaveLength(1)
  })

  for (const shim of [true, false]) {
    test(`a revived session's session_start keeps its tickets for the shim, with the shim claiming ${shim}`, () => {
      const { core, clock, db, main, worker, audit } = setup()
      db.query("UPDATE endpoints SET harness_session = ? WHERE id = ?").run("019a-s", worker.id)
      core.disconnect(worker.id)
      core.brokerHibernate(worker.id, { wake: "claude-bg", ref: REF })
      core.send(main.id, { to: "w1", body: "waiting" })
      const ticket = core.wakeDue(worker.id)!.ticket!
      clock.now += 5_000
      const hook = core.claim({ handle: "root", harness: "codex", session: "start", process: key(74), harness_session: "019a-s" }, { transient: true })
      expect(hook.endpoint.id).toBe(worker.id)
      core.event(worker.id, { kind: "session_start", session_id: "019a-s" }, { transient: true, process: key(74) })
      expect(core.whoami(worker.id)).toHaveProperty("revivable", true)
      if (shim) {
        clock.now += 2_000
        const back = core.claim({ handle: "w1", harness: "codex", session: "mcp", process: key(74), ticket }).endpoint
        expect([back.id, back.address]).toEqual([worker.id, "me/w1"])
        expect(back).not.toHaveProperty("revivable")
        expect(audit("wake_done").at(-1)).toMatchObject({ how: "claim" })
        return
      }
      clock.now += (LIMITS.restartGraceS - 1) * 1000
      core.event(worker.id, { kind: "tool", tool: "Read" }, { transient: true, process: key(74) })
      core.sweep()
      expect(core.wakeDue(worker.id)).toBeNull()
      expect(core.whoami(worker.id)).toHaveProperty("revivable", true)
      clock.now += 2_000
      core.sweep()
      expect(core.whoami(worker.id)).not.toHaveProperty("revivable")
      expect(audit("wake_done").at(-1)).toMatchObject({ how: "session_start" })
      expect(code(() => core.claim({ handle: "w1", harness: "codex", session: "mcp", process: key(74), ticket }))).toBe("unauthorized")
    })
  }

  test("a session_start of a revivable row no wake ran for clears it at once", () => {
    const { core, db, worker, audit } = setup()
    db.query("UPDATE endpoints SET harness_session = ? WHERE id = ?").run("019a-s", worker.id)
    core.disconnect(worker.id)
    core.brokerHibernate(worker.id, { wake: "claude-bg", ref: REF })
    core.claim({ handle: "root", harness: "codex", session: "start", process: key(75), harness_session: "019a-s" }, { transient: true })
    core.event(worker.id, { kind: "session_start" }, { transient: true, process: key(75) })
    expect(core.whoami(worker.id)).not.toHaveProperty("revivable")
    expect(audit("wake_done").at(-1)).toMatchObject({ how: "session_start" })
  })

  test("provider spawn hibernates only a durably held worker with its own ref, whoever asks", () => {
    const { core, worker, hold } = setup()
    const human = { kind: "human" as const, tty: false }
    expect(code(() => core.hibernate(human, { endpoint: "main", wake: "spawn", ref: REF }))).toBe("invalid_params")
    expect(code(() => core.hibernateAll(human, { wake: "spawn", ref: REF }))).toBe("invalid_params")
    hold(REF)
    expect(code(() => core.hibernate(human, { endpoint: "w1", wake: "spawn", ref: `${REF} ` }))).toBe("invalid_params")
    expect(core.hibernate(human, { endpoint: "w1", wake: "spawn", ref: REF }).endpoint.id).toBe(worker.id)
  })

  test("only a spawn or revivable hibernation mints a wake ticket", () => {
    const { core, main, worker } = setup()
    core.hibernate({ kind: "endpoint", id: worker.id, auth: "session" }, { wake: "vm", ref: "box" })
    core.send(main.id, { to: "w1", body: "wake" })
    expect(core.wakeDue(worker.id)?.ticket).toBeUndefined()
  })

  test("a durable spawn's hibernation is revivable, and so is any hibernation whose ref is a revive record", () => {
    const { core, clock, db, main, worker, hold } = setup()
    hold(REF)
    core.waker(worker.id, false)
    expect(core.hibernateHeld(worker.id)[0]).toMatchObject({ presence: "hibernated", revivable: true })
    expect(db.query("SELECT revive FROM endpoints WHERE id = ?").get(worker.id)).toEqual({ revive: "spawn" })
    const record = JSON.stringify({ via: "claude-bg", harness: "claude-code", session: "5f0c", cwd: "/w", argv: ["claude", "--bg"] })
    const view = core.brokerHibernate(main.id, { wake: "claude-bg", ref: record })
    expect(view).toMatchObject({ presence: "hibernated", wake: "hook:claude-bg", revivable: true })
    expect(db.query("SELECT revive FROM endpoints WHERE id = ?").get(main.id)).toEqual({ revive: "claude-bg" })
    for (const ref of ["5f0c", "{}", JSON.stringify({ harness: "claude-code", session: "5f0c", cwd: "w", argv: ["claude"] })])
      expect(core.brokerHibernate(main.id, { wake: "claude-bg", ref })).not.toHaveProperty("revivable")
    core.brokerHibernate(main.id, { wake: "claude-bg", ref: record })
    expect(core.brokerHibernate(main.id, { wake: "none" })).not.toHaveProperty("revivable")
    expect(db.query("SELECT revive FROM endpoints WHERE id = ?").get(main.id)).toEqual({ revive: null })
    core.brokerHibernate(main.id, { wake: "claude-bg", ref: record })
    core.disconnect(main.id)
    core.send(worker.id, { to: "main", body: "back?" })
    clock.now += 61_000
    const ticket = core.wakeDue(main.id)!.ticket!
    expect(ticket).toMatch(/^kwt_[0-9a-f]{64}$/)
    const back = core.claim({ handle: "other", harness: "claude-code", process: key(40), session: "env:revived", ticket }).endpoint
    expect([back.id, back.address, back.presence]).toEqual([main.id, "me/main", "online"])
    expect(back).not.toHaveProperty("revivable")
  })

  test("a revivable endpoint keeps its handle and row however long it sleeps", () => {
    const { core, clock, db, worker } = setup()
    const record = JSON.stringify({ harness: "codex", session: "5f0c", cwd: "/w", argv: ["codex", "exec"] })
    core.brokerHibernate(worker.id, { wake: "claude-bg", ref: record })
    core.disconnect(worker.id)
    clock.now += 40 * 86_400_000
    core.sweep()
    expect(core.claim({ handle: "w1", harness: "codex", process: key(50), session: key(50) }).endpoint.address).toBe("me/w1-2")
    expect(db.query("SELECT handle, hibernate FROM endpoints WHERE id = ?").get(worker.id)).toEqual({ handle: "w1", hibernate: "claude-bg" })
  })

  test("spawn_end lets the worker go: its wake, durable ref and spawn hibernation clear, for its spawner or an ancestor only", () => {
    const { core, actor, grant, worker, hold, row, audit, db } = setup()
    hold(REF)
    const stranger = core.claim({ handle: "stranger", harness: "codex", process: key(30), session: key(30) }).endpoint
    expect(code(() => core.spawnEnd({ kind: "endpoint", id: stranger.id, auth: "session" }, { endpoint: "w1" }))).toBe("not_found")
    expect(code(() => core.spawnEnd(actor, { endpoint: "nobody" }))).toBe("not_found")
    const ended = core.spawnEnd(actor, { endpoint: "w1" })
    expect([ended.held, ended.endpoint.wake]).toEqual([true, null])
    expect(row(worker.id)).toMatchObject({ wake: null, hold_ref: null })
    expect(audit("spawn_end")).toEqual([{ by: "me/main", target: "me/w1", held: true }])
    expect((db.query("SELECT ended_at FROM grants WHERE name = 'w1'").get() as { ended_at: number | null }).ended_at).not.toBeNull()
    expect(core.hibernateHeld(worker.id)).toEqual([])
    core.setWake(worker.id, "spawn-resume", { ref: REF })
    core.hibernateHeld(worker.id)
    expect(core.spawnEnd({ kind: "human", tty: true }, { endpoint: "w1" }).endpoint.presence).not.toBe("hibernated")
    expect(row(worker.id)).toMatchObject({ hibernate: null })
    expect(core.spawnExit(actor, { grant: grant.token, code: 0 }).joined).toBe(true)
  })
})
