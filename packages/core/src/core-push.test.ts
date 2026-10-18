import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { parsePolicy } from "./policy"
import { LIMITS, type ScopeActor } from "./protocol"
import { steerNote, wrapMessage } from "./render"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Fri-Oct-17-09:00:00-2026`

/** `main` on pid 1; `spawn(name, pid)` mints a grant bound to pid+1000 and claims it from pid under that key, as `relay spawn` and its harness do */
function setup() {
  const clock = { now: 1_800_000_000_000 }
  const dead = new Set<number>()
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    alive: (pid: number) => !dead.has(pid),
  })
  core.migrate()
  const main = core.claim({ handle: "main", harness: "claude-code", process: key(1), lineage: [key(1)] }).endpoint
  const as = (id: string): ScopeActor => ({ kind: "endpoint", id, auth: "session" })
  const spawn = (name: string, pid: number, options: { spawn?: boolean; by?: string; parents?: number[]; join?: boolean } = {}) => {
    const grant = core.grant(as(options.by ?? main.id), {
      name,
      ttl_s: 3600,
      bind_process: key(pid + 1000),
      ...(options.spawn === false ? {} : { spawn: true }),
    })
    const parents = options.parents ?? [1]
    const endpoint =
      options.join === false
        ? null
        : core.claim({ handle: "w", harness: "codex", process: key(pid), session: key(pid), lineage: [key(pid), key(pid + 1000), ...parents.map(key)] })
            .endpoint
    return { grant: grant.token, steer: grant.steer, endpoint }
  }
  return { core, clock, db, dead, main, as, spawn }
}

describe("relation on delivered envelopes", () => {
  test("parent for the issuer of the grant the recipient spent and for an ancestor, child for a descendant, none for peers, humans and the relay", () => {
    const { core, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    const sub = spawn("sub", 20, { by: w1.id, parents: [10, 1] }).endpoint!
    const peer = core.claim({ handle: "peer", harness: "codex", process: key(30), lineage: [key(30)] }).endpoint
    const human = core.humanId()
    core.send(main.id, { to: "w1", body: "steer" })
    core.send(main.id, { to: "sub", body: "from above" })
    core.send(w1.id, { to: "main", body: "progress" })
    core.send(sub.id, { to: "main", body: "deep progress" })
    core.send(sub.id, { to: "w1", body: "sub progress" })
    core.send(peer.id, { to: "w1", body: "hi" })
    core.send(human, { to: "w1", body: "from the human" }, { tty: true })
    const relations = (id: string) => core.inbox(id).map((m) => [m.body.text, m.relation ?? null])
    expect(relations(w1.id)).toEqual([
      ["steer", "parent"],
      ["sub progress", "child"],
      ["hi", null],
      ["from the human", null],
    ])
    expect(relations(sub.id)).toEqual([["from above", "ancestor"]])
    expect(relations(main.id)).toEqual([
      ["progress", "child"],
      ["deep progress", "child"],
    ])
  })

  test("the issuer is a parent even when the spawn sits elsewhere, and a sender cannot claim a relation", () => {
    const { core, main, as, db } = setup()
    const lead = core.claim({ handle: "lead", harness: "codex", process: key(40), lineage: [key(40), key(1)] }).endpoint
    const token = core.grant(as(main.id), { name: "deep", under: "lead" }).token
    const deep = core.claim({ handle: "deep", harness: "codex", process: key(41), lineage: [key(41)], grant: token }).endpoint
    expect(deep.parent).toBe("me/lead")
    db.query("UPDATE endpoints SET parent_ep = NULL, tree = NULL, depth = 0 WHERE id = ?").run(deep.id)
    core.send(main.id, { to: "deep", body: "issuer" })
    core.send(lead.id, { to: "deep", body: "was its parent" })
    core.send(deep.id, { to: "main", body: "up", relation: "parent" } as never)
    expect(core.inbox(deep.id).map((m) => [m.body.text, m.relation ?? null])).toEqual([
      ["issuer", "parent"],
      ["was its parent", null],
    ])
    expect(core.inbox(main.id)[0]!.relation).toBeUndefined()
  })

  test("a message from before the sender's row was taken over by another spawn has none; ask replies, inject and delivered carry it", () => {
    const { core, clock, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    const ask = core.send(main.id, { to: "w1", body: "status?", kind: "request" })
    expect(core.inject(w1.id).messages[0]!.relation).toBe("parent")
    expect(core.delivered(w1.id, ask.id)!.relation).toBe("parent")
    core.send(w1.id, { to: "main", body: "fine", kind: "reply", reply_to: ask.id })
    expect(core.replyTo(main.id, ask.id)!.relation).toBe("child")
    core.send(w1.id, { to: "main", body: "old" })
    core.disconnect(w1.id)
    clock.now += 1000
    spawn("w1", 50, { join: false })
    const taken = core.claim({ handle: "w1", harness: "codex", process: key(50), session: key(50), lineage: [key(50), key(1050), key(1)] }).endpoint
    expect(taken.id).toBe(w1.id)
    expect(core.inbox(main.id).find((m) => m.body.text === "old")!.relation).toBeUndefined()
  })
})

describe("stop_wait", () => {
  test("a spawn grant is marked; live workers are unspent unexpired spawn grants and joined spenders not done and not offline", () => {
    const { core, clock, db, main, spawn, as } = setup()
    expect(core.stopWait(main.id)).toEqual({ messages: [], offered: [], hold: null, more: 0, workers: [], starting: 0, others: 0, pushes_left: LIMITS.pushes })
    const w1 = spawn("w1", 10)
    spawn("w2", 20, { join: false })
    spawn("env", 30, { spawn: false })
    expect((db.query("SELECT name, spawn FROM grants ORDER BY rowid").all() as { name: string; spawn: number | null }[]).map((g) => [g.name, g.spawn])).toEqual(
      [
        ["w1", 1],
        ["w2", 1],
        ["env", null],
      ],
    )
    expect(core.stopWait(main.id)).toMatchObject({ workers: ["me/w1"], starting: 1 })
    expect(core.inject(main.id, { stop: true })).toMatchObject({ block: false, workers: 2 })
    core.spawnExit(as(main.id), { grant: w1.grant, code: 0 })
    expect(core.stopWait(main.id)).toMatchObject({ workers: [], starting: 1 })
    clock.now += 3601_000
    expect(core.stopWait(main.id)).toMatchObject({ workers: [], starting: 0 })
    expect(core.inject(main.id, { stop: true })).not.toHaveProperty("workers")
  })

  test("a joined worker that goes offline is live only while its spawn process runs to hand back; a spawn-env grant never holds a stop", () => {
    const { core, clock, dead, main, spawn } = setup()
    const env = spawn("env", 30, { spawn: false }).endpoint!
    expect(core.stopWait(main.id).workers).toEqual([])
    core.send(env.id, { to: "main", body: "from a spawn-env child" })
    expect(core.stopWait(main.id)).toMatchObject({ messages: [], others: 1 })
    expect(core.inject(main.id, { stop: true })).not.toHaveProperty("worker_unread")
    const w1 = spawn("w1", 10).endpoint!
    expect(core.stopWait(main.id).workers).toEqual(["me/w1"])
    core.disconnect(w1.id)
    clock.now += LIMITS.onlineWithinS * 1000
    expect(core.stopWait(main.id).workers).toEqual(["me/w1"])
    dead.add(1010)
    expect(core.stopWait(main.id).workers).toEqual([])
  })

  test("returns the workers' unread messages and the relay's handbacks, then the other unread ones, held for the hook; read on confirm", () => {
    const { core, db, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    const peer = core.claim({ handle: "peer", harness: "codex", process: key(30), lineage: [key(30)] }).endpoint
    core.send(peer.id, { to: "main", body: "unrelated" })
    core.send(w1.id, { to: "main", body: "done-42" })
    const relay = (db.query("SELECT id FROM endpoints WHERE handle = '_relay'").get() as { id: string }).id
    core.send(relay, { to: "main", body: "worker me/w2 finished (exit 0), not a relay agent" })
    core.send(relay, { to: "main", body: "some other notice" })
    expect(core.inject(main.id, { stop: true })).toMatchObject({ block: false, workers: 1, worker_unread: 2 })
    const result = core.stopWait(main.id)
    expect(result.messages.map((m) => [m.body.text, m.relation ?? null])).toEqual([
      ["done-42", "child"],
      ["worker me/w2 finished (exit 0), not a relay agent", null],
      ["unrelated", null],
      ["some other notice", null],
    ])
    expect(result).toMatchObject({ workers: ["me/w1"], starting: 0, others: 0, others_shown: 2, more: 0 })
    expect(result.offered).toEqual(result.messages.map((m) => m.seq!))
    expect(core.stopWait(main.id).messages).toEqual([])
    expect(core.inject(main.id).messages).toEqual([])
    core.injected(result.offered, result.hold, { endpoint: main.id, read: result.offered })
    expect(core.inbox(main.id)).toEqual([])
    expect(core.inject(main.id, { stop: true })).not.toHaveProperty("worker_unread")
  })

  test("other messages fill what the workers' leave of the budget, newest first and whole; the rest stay for a later hook, counted", () => {
    const { core, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    const peer = core.claim({ handle: "lead", harness: "codex", process: key(30), lineage: [key(30)] }).endpoint
    core.send(peer.id, { to: "main", body: "oldest" })
    core.send(peer.id, { to: "main", body: "b".repeat(Math.floor(LIMITS.pushBytes * 0.7)) })
    core.send(peer.id, { to: "main", body: "older" })
    core.send(peer.id, { to: "main", body: "newest" })
    core.send(w1.id, { to: "main", body: "w".repeat(Math.floor(LIMITS.pushBytes / 3)) })
    const result = core.stopWait(main.id)
    expect(result.messages.map((m) => m.body.text.slice(0, 6))).toEqual(["wwwwww", "oldest", "older", "newest"])
    expect(Buffer.byteLength(result.messages.map(wrapMessage).join(""))).toBeLessThanOrEqual(LIMITS.pushBytes)
    expect(result).toMatchObject({ more: 0, others: 1, others_shown: 3 })
    expect(result.offered).toEqual(result.messages.map((m) => m.seq!))
    core.injected(result.offered, result.hold, { endpoint: main.id, read: result.offered })
    expect(core.inbox(main.id).map((m) => m.body.text[0])).toEqual(["b"])
  })

  test("only with a worker message to show, at most the inject count of them, and none another hook holds", () => {
    const { core, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    const peer = core.claim({ handle: "lead", harness: "codex", process: key(30), lineage: [key(30)] }).endpoint
    core.send(peer.id, { to: "main", body: "held" })
    expect(core.stopWait(main.id)).toMatchObject({ messages: [], others: 1 })
    expect(core.stopWait(main.id)).not.toHaveProperty("others_shown")
    const held = core.inject(main.id)
    expect(held.messages.map((m) => m.body.text)).toEqual(["held"])
    for (let i = 0; i < LIMITS.injectMessages + 1; i++) core.send(peer.id, { to: "main", body: `peer ${i}` })
    core.send(w1.id, { to: "main", body: "done" })
    const result = core.stopWait(main.id)
    expect(result.messages.map((m) => m.body.text)).toEqual(["done", ...Array.from({ length: LIMITS.injectMessages }, (_, i) => `peer ${i + 1}`)])
    expect(result).toMatchObject({ others: 2, others_shown: LIMITS.injectMessages })
  })

  test("fits its messages in the push budget, counts the rest, and offers one too big for any hook without showing it", () => {
    const { core, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    core.send(w1.id, { to: "main", body: "x".repeat(LIMITS.pushBytes) })
    for (let i = 0; i < 3; i++) core.send(w1.id, { to: "main", body: `${i}`.repeat(Math.floor(LIMITS.pushBytes / 3)) })
    const result = core.stopWait(main.id)
    expect(result.messages.map((m) => m.body.text[0])).toEqual(["0", "1"])
    expect(Buffer.byteLength(result.messages.map(wrapMessage).join(""))).toBeLessThanOrEqual(LIMITS.pushBytes)
    expect(result.offered).toHaveLength(3)
    expect(result.more).toBe(2)
  })

  test("a peek shows what a stop would without holding it, so the stop after it still takes it", () => {
    const { core, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    core.send(w1.id, { to: "main", body: "done-42" })
    const peek = core.stopWait(main.id, { peek: true })
    expect(peek).toMatchObject({ hold: null, workers: ["me/w1"], more: 0 })
    expect(peek.messages.map((m) => m.body.text)).toEqual(["done-42"])
    const result = core.stopWait(main.id)
    expect(result.messages.map((m) => m.body.text)).toEqual(["done-42"])
    expect(result.hold).not.toBeNull()
    expect(core.stopWait(main.id, { peek: true }).messages).toEqual([])
  })

  test("a hook of another process than the one holding the endpoint gets nothing", () => {
    const { core, main, spawn } = setup()
    spawn("w1", 10)
    expect(core.stopWait(main.id, { transient: true, process: key(99) }).workers).toEqual([])
    expect(core.stopWait(main.id, { transient: true, process: key(1) }).workers).toEqual(["me/w1"])
  })

  test("an unspent grant whose spawn process is gone is revoked, not counted as starting", () => {
    const { core, db, dead, main, spawn } = setup()
    spawn("w1", 10, { join: false })
    spawn("w2", 20, { join: false })
    expect(core.stopWait(main.id).starting).toBe(2)
    dead.add(1010)
    expect(core.stopWait(main.id).starting).toBe(1)
    expect(core.inject(main.id, { stop: true })).toMatchObject({ workers: 1 })
    expect((db.query("SELECT name FROM grants WHERE revoked_at IS NOT NULL").all() as { name: string }[]).map((g) => g.name)).toEqual(["w1"])
    dead.add(1020)
    expect(core.inject(main.id, { stop: true })).not.toHaveProperty("workers")
  })

  test("a no_push worker is not waited on: its messages and handbacks stay ordinary unread ones, counted in others", () => {
    const { core, db, main, as, spawn } = setup()
    const bg = core.grant(as(main.id), { name: "bg", ttl_s: 3600, bind_process: key(1010), spawn: true, no_push: true })
    const idle = core.grant(as(main.id), { name: "idle", ttl_s: 3600, bind_process: key(1030), spawn: true, no_push: true })
    expect(core.stopWait(main.id)).toMatchObject({ workers: [], starting: 0, background: ["me/bg", "me/idle"] })
    const worker = core.claim({ handle: "w", harness: "codex", process: key(10), session: key(10), lineage: [key(10), key(1010), key(1)] }).endpoint
    spawn("fg", 20)
    expect(
      (db.query("SELECT name, no_push FROM grants ORDER BY rowid").all() as { name: string; no_push: number | null }[]).map((g) => [g.name, g.no_push]),
    ).toEqual([
      ["bg", 1],
      ["idle", 1],
      ["fg", null],
    ])
    core.send(worker.id, { to: "main", body: "queued note" })
    core.spawnExit(as(main.id), { grant: bg.token, code: 0, output: "bg done" })
    core.spawnExit(as(main.id), { grant: idle.token, code: 1 })
    expect(core.stopWait(main.id)).toMatchObject({ messages: [], workers: ["me/fg"], starting: 0, others: 3 })
    expect(core.stopWait(main.id)).not.toHaveProperty("background")
    expect(core.inject(main.id, { stop: true })).toMatchObject({ workers: 1 })
    expect(core.inject(main.id, { stop: true })).not.toHaveProperty("worker_unread")
    expect(core.inbox(main.id).map((m) => m.body.text)).toEqual([
      "queued note",
      "worker me/bg finished (exit 0)\n\nbg done",
      "worker idle finished (exit 1), not a relay agent",
    ])
    expect(() => core.grant(as(main.id), { name: "x", spawn: true, no_push: "yes" as unknown as boolean })).toThrow("no_push is true or false")
  })
})

describe("push budget and pacing", () => {
  test("a printed push counts toward the prompt's budget, which a prompt resets; with none left nothing is shown", () => {
    const { core, clock, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    for (let i = 0; i < LIMITS.pushes; i++) {
      core.send(w1.id, { to: "main", body: `step ${i}` })
      const result = core.stopWait(main.id)
      expect(result).toMatchObject({ pushes_left: LIMITS.pushes - i, messages: [{ body: { text: `step ${i}` } }] })
      core.injected(result.offered, result.hold, { endpoint: main.id, read: result.offered })
      expect(core.pushed(main.id, result.offered)).toBe(true)
      clock.now += LIMITS.pushGapS * 1000
    }
    core.send(w1.id, { to: "main", body: "one too many" })
    expect(core.stopWait(main.id)).toMatchObject({ pushes_left: 0, messages: [], workers: ["me/w1"] })
    expect(core.pushed(main.id, [])).toBe(false)
    expect(core.inject(main.id, { stop: true })).toMatchObject({ workers: 1, worker_unread: 1, pushes_left: 0 })
    expect(core.prompted(main.id)).toBe(true)
    expect(core.stopWait(main.id)).toMatchObject({ pushes_left: LIMITS.pushes, messages: [{ body: { text: "one too many" } }] })
  })

  test("a live worker's messages wait the push gap after a push showed one of its own; another worker's and a finished one's do not", () => {
    const { core, clock, main, spawn, as } = setup()
    const one = spawn("w1", 10)
    const w2 = spawn("w2", 20).endpoint!
    core.send(one.endpoint!.id, { to: "main", body: "first" })
    const first = core.stopWait(main.id)
    core.injected(first.offered, first.hold, { endpoint: main.id, read: first.offered })
    core.pushed(main.id, first.offered)
    core.send(one.endpoint!.id, { to: "main", body: "chatty" })
    expect(core.stopWait(main.id)).toMatchObject({ messages: [], more: 0, workers: ["me/w1", "me/w2"] })
    core.send(w2.id, { to: "main", body: "from w2" })
    const other = core.stopWait(main.id)
    expect(other.messages.map((m) => m.body.text)).toEqual(["from w2"])
    core.injected(other.offered, other.hold, { endpoint: main.id, read: other.offered })
    clock.now += LIMITS.pushGapS * 1000 - 1
    expect(core.stopWait(main.id).messages).toEqual([])
    clock.now += 1
    expect(core.stopWait(main.id).messages.map((m) => m.body.text)).toEqual(["chatty"])
    const again = spawn("w3", 30)
    core.send(again.endpoint!.id, { to: "main", body: "w3 a" })
    const shown = core.stopWait(main.id)
    core.injected(shown.offered, shown.hold, { endpoint: main.id, read: shown.offered })
    core.pushed(main.id, shown.offered)
    core.send(again.endpoint!.id, { to: "main", body: "w3 b" })
    core.spawnExit(as(main.id), { grant: again.grant, code: 0 })
    expect(core.stopWait(main.id).messages.map((m) => m.body.text)).toEqual(["w3 b", "worker me/w3 exited (exit 0) with no final output"])
  })

  test("a prompt after the stop began says so to the waiting stop; a prompt from another process changes nothing", () => {
    const { core, main, spawn } = setup()
    spawn("w1", 10)
    const mark = core.inject(main.id, { stop: true }).prompts!
    expect(core.stopWait(main.id, { prompts: mark })).not.toHaveProperty("prompted")
    expect(core.prompted(main.id, { transient: true, process: key(99) })).toBe(false)
    expect(core.stopWait(main.id, { prompts: mark })).not.toHaveProperty("prompted")
    expect(core.prompted(main.id, { transient: true, process: key(1) })).toBe(true)
    expect(core.stopWait(main.id, { prompts: mark })).toMatchObject({ prompted: true })
    expect(core.stopWait(main.id)).not.toHaveProperty("prompted")
  })
})

describe("parent directives", () => {
  test("a spawned worker's inject names its spawner as intro until a hook confirms it, again after a session start; a peer or a spawn-env child gets none", () => {
    const { core, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    const env = spawn("env", 30, { spawn: false }).endpoint!
    const peer = core.claim({ handle: "peer", harness: "codex", process: key(40), lineage: [key(40)] }).endpoint
    expect(core.inject(w1.id)).toMatchObject({ messages: [], intro: "me/main" })
    expect(core.inject(w1.id, { count: true })).toMatchObject({ intro: "me/main" })
    expect(core.inject(w1.id, { stop: true })).not.toHaveProperty("intro")
    expect(core.inject(env.id)).not.toHaveProperty("intro")
    expect(core.inject(peer.id)).not.toHaveProperty("intro")
    expect(core.inject(main.id)).not.toHaveProperty("intro")
    expect(core.introduced(w1.id, { transient: true, process: key(99) })).toBe(false)
    expect(core.introduced(w1.id)).toBe(true)
    expect(core.inject(w1.id)).not.toHaveProperty("intro")
    core.event(w1.id, { kind: "session_start" }, { transient: true, process: key(10) })
    expect(core.inject(w1.id)).toMatchObject({ intro: "me/main" })
  })

  test("the full preamble is shown once a session: inject, a stop and stop_wait say brief once a hook confirmed it, until a session start", () => {
    const { core, main, spawn } = setup()
    spawn("w1", 10)
    expect(core.inject(main.id)).not.toHaveProperty("brief")
    expect(core.stopWait(main.id)).not.toHaveProperty("brief")
    expect(core.briefed(main.id, { transient: true, process: key(99) })).toBe(false)
    expect(core.briefed(main.id)).toBe(true)
    expect(core.inject(main.id)).toMatchObject({ brief: true })
    expect(core.inject(main.id, { stop: true })).toMatchObject({ brief: true })
    expect(core.stopWait(main.id)).toMatchObject({ brief: true })
    core.event(main.id, { kind: "session_start" }, { transient: true, process: key(1) })
    expect(core.inject(main.id)).not.toHaveProperty("brief")
  })

  test("a stop that asks for directives is held for a parent's message still unread, shown within the push budget, and restated once", () => {
    const { core, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    const peer = core.claim({ handle: "peer", harness: "codex", process: key(40), lineage: [key(40)] }).endpoint
    core.send(peer.id, { to: "w1", body: "fyi" })
    const steer = core.send(main.id, { to: "w1", body: "echo PINEAPPLE" })
    expect(core.inject(w1.id, { stop: true })).toMatchObject({ block: false })
    expect(core.inject(w1.id, { stop: true })).not.toHaveProperty("directives")
    const held = core.inject(w1.id, { stop: true, directives: true })
    expect(held).toMatchObject({ block: true, forced: false, unread: 2 })
    expect(held.directives!.map((m) => [m.id, m.relation])).toEqual([[steer.id, "parent"]])
    expect(held.directive_seqs).toEqual([held.directives![0]!.seq!])
    expect(held.offered).toEqual(held.directive_seqs!)
    expect(typeof held.hold).toBe("string")
    core.injected(held.offered, held.hold, { endpoint: w1.id, read: held.offered })
    expect(core.restated(w1.id, held.directive_seqs, held.offered, { transient: true, process: key(99) })).toBe(0)
    expect(core.restated(w1.id, held.directive_seqs, held.offered)).toBe(1)
    expect(core.inbox(w1.id).map((m) => m.body.text)).toEqual(["fyi"])
    expect(core.inject(w1.id, { stop: true, directives: true })).toMatchObject({ block: false, offered: [] })
    expect(core.inject(w1.id, { stop: true, directives: true })).not.toHaveProperty("directives")
  })

  test("a directive injected at or after the last tool event holds the stop, one injected before a later tool event does not, nor one the agent read itself", () => {
    const { core, clock, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    core.event(w1.id, { kind: "tool", tool: "Bash" })
    core.send(main.id, { to: "w1", body: "late" })
    const shown = core.inject(w1.id)
    core.injected(shown.offered, shown.hold, { endpoint: w1.id, read: shown.offered })
    expect(core.inject(w1.id, { stop: true, directives: true }).directives!.map((m) => m.body.text)).toEqual(["late"])
    clock.now += 1000
    core.event(w1.id, { kind: "tool", tool: "Edit", agent: "Explore a1b2c3" })
    expect(core.inject(w1.id, { stop: true, directives: true }).directives!.map((m) => m.body.text)).toEqual(["late"])
    core.event(w1.id, { kind: "tool", tool: "Edit" })
    expect(core.inject(w1.id, { stop: true, directives: true })).not.toHaveProperty("directives")
    core.send(main.id, { to: "w1", body: "read by hand" })
    core.ack(
      w1.id,
      core.inbox(w1.id).map((m) => m.seq),
    )
    expect(core.inject(w1.id, { stop: true, directives: true })).not.toHaveProperty("directives")
  })

  test("a pointer restates without reading, and the directive holds of a session are bounded until a session start", () => {
    const { core, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    for (let i = 0; i < LIMITS.directiveHolds; i++) {
      core.send(main.id, { to: "w1", body: `steer ${i}` })
      const held = core.inject(w1.id, { stop: true, directives: true })
      expect(held.block).toBe(true)
      expect(core.restated(w1.id, held.directive_seqs, [])).toBe(1)
    }
    expect(core.inbox(w1.id)).toHaveLength(LIMITS.directiveHolds)
    core.send(main.id, { to: "w1", body: "one too many" })
    expect(core.inject(w1.id, { stop: true, directives: true })).toMatchObject({ block: false })
    core.event(w1.id, { kind: "session_start" }, { transient: true, process: key(10) })
    expect(core.inject(w1.id, { stop: true, directives: true }).directives!.map((m) => m.body.text)).toEqual(["one too many"])
  })
})

describe("ancestors and the stop hold", () => {
  test("a parent's late message holds the stop behind more than a page of other unread messages", () => {
    const { core, clock, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    const peer = core.claim({ handle: "peer", harness: "codex", process: key(40), lineage: [key(40)] }).endpoint
    for (let i = 0; i < LIMITS.inboxPage; i++) {
      core.send(peer.id, { to: "w1", body: `fyi ${i}` })
      clock.now += 2100
    }
    core.send(main.id, { to: "w1", body: "late steer" })
    const held = core.inject(w1.id, { stop: true, directives: true })
    expect(held.directives!.map((m) => m.body.text)).toEqual(["late steer"])
  })

  test("a keyed worker's ancestor above its spawner is relayed context: relation ancestor, no parent framing, no stop hold; an unkeyed child keeps parent", () => {
    const { core, main, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    const sub = spawn("sub", 20, { by: w1.id, parents: [10, 1] }).endpoint!
    core.send(main.id, { to: "sub", body: "from above" })
    const [above] = core.inbox(sub.id)
    expect([above!.relation, above!.parent_key ?? null]).toEqual(["ancestor", null])
    expect(wrapMessage(above!)).not.toContain("from your parent")
    expect(core.inject(sub.id, { stop: true, directives: true })).toMatchObject({ block: false })
    const plain = spawn("plain", 30, { spawn: false }).endpoint!
    core.send(main.id, { to: "plain", body: "steer" })
    expect(core.inbox(plain.id)[0]!.relation).toBe("parent")
    expect(core.inject(plain.id, { stop: true, directives: true }).directives!.map((m) => m.body.text)).toEqual(["steer"])
  })
})

describe("steer keys", () => {
  test("a spawn grant gets a steer key and its issuer's address; a spawn-env grant none; the audit never names the key", () => {
    const { core, main, as } = setup()
    const spawned = core.grant(as(main.id), { name: "w9", spawn: true })
    expect(spawned.steer).toEqual({ key: expect.stringMatching(/^[0-9a-z]{6}$/), parent: "me/main" })
    expect(core.grant(as(main.id), { name: "w9", spawn: true }).steer!.key).not.toBe(spawned.steer!.key)
    expect(core.grant(as(main.id), { name: "w8" })).not.toHaveProperty("steer")
    expect(JSON.stringify(core.log())).not.toContain(spawned.steer!.key)
  })

  test("only the grant issuer's messages to the worker that spent it carry the key, never a peer's or an ancestor's, nor once the grant is revoked", () => {
    const { core, db, main, spawn } = setup()
    const w1 = spawn("w1", 10)
    const sub = spawn("sub", 20, { by: w1.endpoint!.id, parents: [10, 1] })
    const peer = core.claim({ handle: "peer", harness: "codex", process: key(30), lineage: [key(30)] }).endpoint
    core.send(main.id, { to: "w1", body: "steer" })
    core.send(peer.id, { to: "w1", body: "hi" })
    core.send(main.id, { to: "sub", body: "from above" })
    core.send(w1.endpoint!.id, { to: "sub", body: "from w1" })
    core.send(w1.endpoint!.id, { to: "main", body: "progress" })
    const keys = (id: string) => core.inbox(id).map((m) => [m.body.text, m.relation ?? null, m.parent_key ?? null])
    expect(keys(w1.endpoint!.id)).toEqual([
      ["steer", "parent", w1.steer!.key],
      ["hi", null, null],
    ])
    expect(keys(sub.endpoint!.id)).toEqual([
      ["from above", "ancestor", null],
      ["from w1", "parent", sub.steer!.key],
    ])
    expect(JSON.stringify(core.inbox(main.id))).not.toContain(w1.steer!.key)
    expect(wrapMessage(core.inbox(w1.endpoint!.id)[0]!)).toContain(`relation="parent" key="${w1.steer!.key}"`)
    expect(core.inject(w1.endpoint!.id)).toMatchObject({ intro: "me/main", intro_key: w1.steer!.key })
    db.query("UPDATE grants SET revoked_at = 1 WHERE used_by = ?").run(w1.endpoint!.id)
    expect(keys(w1.endpoint!.id)[0]).toEqual(["steer", "parent", null])
  })

  test("a turn's digest drops a spawn's prompt note, so a peek never shows the key", () => {
    const { core, main, as, spawn } = setup()
    const w1 = spawn("w1", 10).endpoint!
    core.peekSet(as(w1.id), { level: "on" })
    expect(core.peekTurn(w1.id, { role: "user", text: `do the docs${steerNote("me/main", "k3y9ab")}` })).toEqual({ stored: true })
    expect(core.peek(as(main.id), { endpoint: "w1" }).turns.map((t) => t.text)).toEqual(["do the docs"])
  })
})

describe("a send's reach", () => {
  test("each recipient's state: running, ended, offline, or starting while a relay spawn of it has not joined; none for the human", () => {
    const { core, clock, main, spawn, as } = setup()
    const reach = (to: string | string[]) => core.send(main.id, { to, body: "steer" }).deliveries.map((d) => [d.address, d.state])
    const w1 = spawn("w1", 10)
    expect(reach("w1")).toEqual([["me/w1", "running"]])
    core.spawnExit(as(main.id), { grant: w1.grant, code: 0 })
    core.disconnect(w1.endpoint!.id)
    expect(reach("w1")).toEqual([["me/w1", "ended"]])
    const idle = core.claim({ handle: "idle", harness: "codex" }).endpoint
    core.disconnect(idle.id)
    clock.now += 60_000
    expect(reach(["idle", "me/"])).toEqual([
      ["me/idle", "offline"],
      ["me/", undefined],
    ])

    const before = core.send(main.id, { to: "w1", body: "for the run that ended" }).id
    clock.now += 1000
    spawn("w1", 11, { join: false })
    const steer = core.send(main.id, { to: "w1", body: "for the next run" })
    expect(steer.deliveries.map((d) => [d.address, d.state])).toEqual([["me/w1", "starting"]])
    const rejoined = core.claim({ handle: "w", harness: "codex", process: key(11), session: key(11), lineage: [key(11), key(1011), key(1)] }).endpoint
    expect(rejoined.id).toBe(w1.endpoint!.id)
    expect(core.inbox(rejoined.id).map((m) => m.id)).toEqual([steer.id])
    expect(core.inbox(rejoined.id).map((m) => m.id)).not.toContain(before)
    expect(reach("w1")).toEqual([["me/w1", "running"]])

    expect(() => core.send(main.id, { to: "bob/w1", body: "elsewhere" })).toThrow("no endpoint bob/w1")
  })

  test("a send from its spawner to a spawn that has not joined yet waits for it and reaches it as it joins, with the parent key", () => {
    const { core, db, main, spawn } = setup()
    const peer = core.claim({ handle: "peer", harness: "codex", process: key(30), lineage: [key(30)] }).endpoint
    const w9 = spawn("w9", 90, { join: false })
    const steer = core.send(main.id, { to: ["w9", "peer"], body: "also do X" })
    expect(steer.deliveries.map((d) => [d.address, d.state])).toEqual([
      ["me/peer", "running"],
      ["me/w9", "starting"],
    ])
    expect(core.send(main.id, { to: "me/w9", body: "and Y" }).deliveries[0]).toMatchObject({ address: "me/w9", state: "starting" })
    expect(() => core.send(peer.id, { to: "w9", body: "not yours" })).toThrow("no endpoint w9")
    expect(() => core.send(main.id, { to: "bob/w9", body: "elsewhere" })).toThrow("no endpoint bob/w9")
    expect(core.list({ all: true }).map((e) => e.address)).not.toContain("me/w9")
    const joined = core.claim({ handle: "w", harness: "codex", process: key(90), session: key(90), lineage: [key(90), key(1090), key(1)] }).endpoint
    expect(joined.address).toBe("me/w9")
    const inbox = core.inbox(joined.id)
    expect(inbox.map((m) => m.body.text)).toEqual(["also do X", "and Y"])
    expect(inbox[0]).toMatchObject({ relation: "parent", parent_key: w9.steer!.key })
    expect(db.query("SELECT COUNT(*) AS n FROM deliveries WHERE endpoint LIKE 'spawn:%'").get()).toEqual({ n: 0 })
  })

  test("a spawn that never joined takes its pending steers with it, named in the handback; one the policy refuses at join is dropped", () => {
    const { core, db, main, spawn, as } = setup()
    const never = spawn("never", 40, { join: false })
    core.send(main.id, { to: "never", body: "never seen" })
    const exit = core.spawnExit(as(main.id), { grant: never.grant, code: 0 })
    expect(core.inbox(main.id).find((m) => m.id === exit.handback)!.body.text).toContain("1 message you sent it never reached it")
    expect(db.query("SELECT COUNT(*) AS n FROM deliveries WHERE endpoint LIKE 'spawn:%'").get()).toEqual({ n: 0 })

    spawn("guarded", 50, { join: false })
    core.send(main.id, { to: "guarded", body: "refused at join" })
    core.setPolicy(parsePolicy({ rules: [{ match: "handle:guarded", accept_from: ["kind:human"] }] }))
    const guarded = core.claim({ handle: "w", harness: "codex", process: key(50), session: key(50), lineage: [key(50), key(1050), key(1)] }).endpoint
    expect(core.inbox(guarded.id)).toEqual([])
    expect(core.log({ endpoint: main.id }).find((row) => row.event === "refuse")!.detail).toMatchObject({
      code: "policy_refused",
      to: ["me/guarded"],
      dropped: 1,
    })
  })
})

describe("inbox after a background hook", () => {
  const handback = (core: RelayCore, main: { id: string }, grant: string) =>
    core.spawnExit({ kind: "endpoint", id: main.id, auth: "session" }, { grant, code: 0, output: "the result" })
  const showDeferred = (core: RelayCore, id: string, deferred = true) => {
    const shown = core.inject(id, { transient: true, process: key(1) })
    core.injected(shown.offered, shown.hold, { endpoint: id, read: shown.offered, deferred })
    return shown
  }

  test("a handback a background hook showed is still listed by inbox, marked as shown, until inbox acks it", () => {
    const { core, clock, main, spawn } = setup()
    const { grant } = spawn("w1", 10)
    handback(core, main, grant)
    clock.now += 1000
    expect(showDeferred(core, main.id).messages).toHaveLength(1)
    clock.now += 20_000
    const listed = core.inbox(main.id)
    expect(listed.map((m) => m.from.address)).toEqual(["me/w1"])
    expect(listed[0]!.shown_at).toBe(new Date(clock.now - 20_000).toISOString())
    expect(
      core.ack(
        main.id,
        listed.map((m) => m.seq),
      ),
    ).toBe(0)
    expect(core.inbox(main.id)).toEqual([])
  })

  test("a later tool event or a prompt settles it; a foreground hook's showing was never deferred", () => {
    const { core, clock, main, spawn } = setup()
    handback(core, main, spawn("w1", 10).grant)
    showDeferred(core, main.id)
    core.event(main.id, { kind: "tool", tool: "Bash" }, { transient: true, process: key(1) })
    expect(core.inbox(main.id)).toHaveLength(1)
    clock.now += 3000
    core.event(main.id, { kind: "tool", tool: "Bash" }, { transient: true, process: key(1) })
    expect(core.inbox(main.id)).toEqual([])

    handback(core, main, spawn("w2", 20).grant)
    showDeferred(core, main.id)
    clock.now += 3000
    core.prompted(main.id, { transient: true, process: key(1) })
    expect(core.inbox(main.id)).toEqual([])

    handback(core, main, spawn("w3", 30).grant)
    showDeferred(core, main.id, false)
    expect(core.inbox(main.id)).toEqual([])
  })

  test("a stop event leaves it listed, and it ages out of inbox after the window", () => {
    const { core, clock, main, spawn } = setup()
    handback(core, main, spawn("w1", 10).grant)
    showDeferred(core, main.id)
    clock.now += 3000
    core.event(main.id, { kind: "stop" }, { transient: true, process: key(1) })
    expect(core.inbox(main.id)).toHaveLength(1)
    clock.now += LIMITS.deferredShowS * 1000
    expect(core.inbox(main.id)).toEqual([])
  })
})
