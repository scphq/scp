import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { RelayError, type ScopeActor } from "./protocol"
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
    hold()
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

  test("a wake ticket waits while the endpoint is still held, and a newer run's ticket replaces it", () => {
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
    expect(code(() => core.claim({ handle: "w1", harness: "codex", process: key(25), session: "env:old", ticket: first }))).toBe("unauthorized")
    expect(core.claim({ handle: "w1", harness: "codex", process: key(26), session: "env:new", ticket: second }).endpoint.id).toBe(worker.id)
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

  test("only a spawn hibernation mints a wake ticket", () => {
    const { core, main, worker } = setup()
    core.hibernate({ kind: "endpoint", id: worker.id, auth: "session" }, { wake: "vm", ref: "box" })
    core.send(main.id, { to: "w1", body: "wake" })
    expect(core.wakeDue(worker.id)?.ticket).toBeUndefined()
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
