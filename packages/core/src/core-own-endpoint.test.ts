import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { LIMITS, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const self = (id: string): ScopeActor => ({ kind: "endpoint", id, auth: "self" })
const HUMAN: ScopeActor = { kind: "human", tty: true }
const DAEMON = 3
const CWD = "/work/app"
const session = (n: number) => `0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a${n.toString().padStart(2, "0")}`

/** an orchestrator `lead`, and the harness daemon's background sessions: each a process of its own whose hooks and shim claim apart */
function setup() {
  const clock = { now: 1_800_000_000_000 }
  const dead = new Set<number>()
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    alive: (pid) => !dead.has(pid),
    startOf: (_pid, expected) => expected,
  })
  core.migrate()
  const lead = core.claim({ handle: "lead", harness: "claude-code", process: key(5), session: key(5), lineage: [key(5), key(1)] }).endpoint
  const peer = core.claim({ handle: "peer", harness: "codex" }).endpoint
  core.rulesSet(HUMAN, { endpoint: "peer", out: ["*"] })
  const bg = (pid: number, extra: Record<string, unknown>) => ({
    harness: "claude-code",
    cwd: CWD,
    process: key(pid),
    session: key(pid),
    lineage: [key(pid), key(DAEMON)],
    ...extra,
  })
  /** a hook of the daemon's session `pid`: it has the daemon's environment, so the default handle, no name and no grant */
  const hook = (pid: number, harness_session: string) =>
    core.claim(bg(pid, { handle: "claude-app", derived: true, harness_session }), { transient: true }).endpoint
  const shim = (pid: number, extra: Record<string, unknown>) => core.claim(bg(pid, extra)).endpoint
  const tool = (id: string, pid: number, harness_session: string) =>
    core.event(id, { kind: "tool", tool: "Bash", session_id: harness_session }, { transient: true, process: key(pid) })
  /** what a command in session `pid`'s shell binds to: its walk ends at the daemon-hosted harness process */
  const shell = (pid: number) => core.placeLineage([key(pid)])
  /** a worker that session's shell spawned: the grant is minted as the shell's binding, and its claim comes from beneath the shell */
  const spawn = (pid: number, name: string, worker: number) => {
    const bound = shell(pid)!
    const token = core.grant(self(bound), { name }).token
    return core.claim({ handle: name, harness: "codex", grant: token, process: key(worker), session: key(worker), lineage: [key(worker), key(pid)] }).endpoint
  }
  /** a named background worker of `lead`, stopped by the claude-bg policy and woken by its ticket under a new session id, hooks first */
  const woken = (name: string, pid: number, n: number) => {
    const grant = core.grant(self(lead.id), { name }).token
    const started = session(n)
    hook(pid, started)
    const row = shim(pid, { handle: name, grant, harness_session: started })
    tool(row.id, pid, started)
    core.brokerHibernate(row.id, {
      wake: "claude-bg",
      ref: JSON.stringify({ via: "claude-bg", harness: "claude-code", session: started, cwd: CWD, argv: ["claude", "--bg", "--resume", started] }),
    })
    core.disconnect(row.id)
    dead.add(pid)
    core.send(peer.id, { to: name, body: "wake up" })
    clock.now += 1000
    const ticket = core.wakeDue(row.id)?.ticket
    expect(ticket).toMatch(/^kwt_/)
    const resumed = session(n + 1)
    const hooks = hook(pid + 1, resumed)
    expect(hooks.id).not.toBe(row.id)
    expect(shim(pid + 1, { handle: name, harness_session: resumed, harness_origin: started, ticket }).id).toBe(row.id)
    tool(row.id, pid + 1, resumed)
    return { row, hooks, pid: pid + 1, resumed }
  }
  const parentOf = (id: string) => core.whoami(id).parent
  const unread = (id: string) => core.inbox(id).map((message) => message.body.text)
  return { core, clock, dead, lead, peer, hook, shim, tool, shell, spawn, woken, parentOf, unread, sql }
}

describe("a session's own endpoint", () => {
  test("a woken session's shell binds its named endpoint, never the row its hooks left", () => {
    const { shell, woken } = setup()
    const { row, pid } = woken("lane-a", 10, 1)
    expect(shell(pid)).toBe(row.id)
  })

  test("a spawn from a woken session's shell parents the worker under its named endpoint", () => {
    const { lead, spawn, woken, parentOf, core } = setup()
    const { row, pid } = woken("lane-a", 10, 1)
    const worker = spawn(pid, "lane-a-sol", 40)
    expect(parentOf(worker.id)).toBe(core.whoami(row.id).address)
    expect(parentOf(row.id)).toBe(lead.address)
  })

  test("a worker's result reaches the session that spawned it, not the next session woken", () => {
    const { core, clock, spawn, woken, unread } = setup()
    const a = woken("lane-a", 10, 1)
    const worker = spawn(a.pid, "lane-a-sol", 40)
    core.send(worker.id, { to: core.whoami(a.row.id).address, body: "finished" })
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    const b = woken("lane-b", 20, 3)
    expect(unread(a.row.id)).toEqual(["wake up", "finished"])
    expect(unread(b.hooks.id)).toEqual([])
    expect(unread(b.row.id)).toEqual(["wake up"])
  })

  test("a row a session's hooks left holds no harness process, so no lineage reaches it", () => {
    const { sql, woken } = setup()
    const { hooks } = woken("lane-a", 10, 1)
    expect(sql.all<{ process: string | null }>(`SELECT process FROM endpoints WHERE id = ?`, hooks.id)).toEqual([{ process: null }])
  })

  test("a worker spawned before the shim renames the hooks' row stays under that same row", () => {
    const { core, hook, shim, spawn, shell, lead, parentOf } = setup()
    const started = session(1)
    const grant = core.grant(self(lead.id), { name: "lane-a" }).token
    const hooks = hook(10, started)
    const worker = spawn(10, "early-sol", 40)
    expect(parentOf(worker.id)).toBe(core.whoami(hooks.id).address)
    const row = shim(10, { handle: "lane-a", grant, harness_session: started })
    expect(row.id).toBe(hooks.id)
    expect(shell(10)).toBe(row.id)
    expect(parentOf(worker.id)).toBe(core.whoami(row.id).address)
  })

  test("a worker spawned on a row its session then left stays there, out of every other session's reach", () => {
    const { core, lead, peer, hook, shim, tool, spawn, shell, dead, clock, parentOf } = setup()
    const grant = core.grant(self(lead.id), { name: "lane-a" }).token
    const started = session(1)
    hook(10, started)
    const row = shim(10, { handle: "lane-a", grant, harness_session: started })
    tool(row.id, 10, started)
    core.brokerHibernate(row.id, {
      wake: "claude-bg",
      ref: JSON.stringify({ via: "claude-bg", harness: "claude-code", session: started, cwd: CWD, argv: ["claude", "--bg", "--resume", started] }),
    })
    core.disconnect(row.id)
    dead.add(10)
    core.send(peer.id, { to: "lane-a", body: "wake up" })
    clock.now += 1000
    const ticket = core.wakeDue(row.id)?.ticket
    const resumed = session(2)
    const hooks = hook(11, resumed)
    const worker = spawn(11, "early-sol", 40)
    expect(shim(11, { handle: "lane-a", harness_session: resumed, ticket }).id).toBe(row.id)
    expect(shell(11)).toBe(row.id)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    expect(hook(60, session(9)).id).not.toBe(hooks.id)
    expect(parentOf(worker.id)).toBe(core.whoami(hooks.id).address)
  })
})

describe("a daemon-hosted session's hooks", () => {
  /** the hook of daemon session `pid`, which cannot tell whose endpoint it is: it only joins */
  function joining(ctx: ReturnType<typeof setup>) {
    return (pid: number, harness_session: string) =>
      ctx.core.claim(
        {
          handle: "claude-app",
          derived: true,
          join_only: true,
          harness: "claude-code",
          cwd: CWD,
          process: key(pid),
          session: key(pid),
          lineage: [key(pid), key(DAEMON)],
          harness_session,
        },
        { transient: true },
      ).endpoint
  }

  test("make no row before the shim has one, so nothing but the session's own endpoint ever holds its process", () => {
    const ctx = setup()
    const { core, sql, shim, shell, spawn, parentOf, lead } = ctx
    const hook = joining(ctx)
    const grant = core.grant(self(lead.id), { name: "lane-a" }).token
    expect(() => hook(10, session(1))).toThrow("no endpoint yet")
    expect(sql.all(`SELECT id FROM endpoints WHERE handle LIKE 'claude-app%'`)).toEqual([])
    expect(shell(10)).toBeNull()
    const row = shim(10, { handle: "lane-a", grant, harness_session: session(1) })
    expect(parentOf(row.id)).toBe(lead.address)
    expect(hook(10, session(1)).id).toBe(row.id)
    expect(shell(10)).toBe(row.id)
    expect(parentOf(spawn(10, "lane-sol", 40).id)).toBe(core.whoami(row.id).address)
  })

  test("take back their own stopped session by its harness session, and take nothing by a default handle", () => {
    const ctx = setup()
    const { core, clock, dead, hook: plain, tool } = ctx
    const hook = joining(ctx)
    const started = session(1)
    const own = plain(10, started)
    tool(own.id, 10, started)
    dead.add(10)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    expect(hook(11, started).id).toBe(own.id)
    dead.add(11)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    expect(() => hook(12, session(2))).toThrow("no endpoint yet")
    expect(core.whoami(own.id).address).toBe("me/claude-app")
  })

  test("only a hook's claim is join-only, and it is a boolean", () => {
    const { core } = setup()
    const claim = { handle: "claude-app", harness: "claude-code", process: key(10), session: key(10) }
    expect(core.claim({ ...claim, join_only: true }).endpoint.address).toBe("me/claude-app")
    expect(() => core.claim({ ...claim, join_only: "yes" as unknown as boolean })).toThrow("join_only is true or false")
  })

  test("a subagent's claim still makes its endpoint under the session's", () => {
    const ctx = setup()
    const { core, lead, shim } = ctx
    const grant = core.grant(self(lead.id), { name: "lane-a" }).token
    const row = shim(10, { handle: "lane-a", grant, harness_session: session(1) })
    const sub = core.claim(
      {
        handle: "claude-app",
        join_only: true,
        harness: "claude-code",
        process: key(10),
        session: key(10),
        lineage: [key(10)],
        subagent: { id: "a1", type: "Explore" },
      },
      { transient: true },
    ).endpoint
    expect(sub.parent).toBe(core.whoami(row.id).address)
  })
})

describe("a row left behind by an older broker", () => {
  /** the state a broker before this rule left: a root that still holds the harness process of the session it lost, with the workers bound to it */
  function legacy() {
    const ctx = setup()
    const { sql, woken } = ctx
    const a = woken("lane-a", 10, 1)
    sql.all(`UPDATE endpoints SET process = ? WHERE id = ?`, key(a.pid), a.hooks.id)
    const worker = ctx.core.claim({
      handle: "old-sol",
      harness: "codex",
      grant: ctx.core.grant(self(a.hooks.id), { name: "old-sol" }).token,
      process: key(40),
      session: key(40),
      lineage: [key(40)],
    }).endpoint
    return { ...ctx, a, worker }
  }

  test("the session's shell binds its named endpoint and new workers go there", () => {
    const { a, shell, spawn, parentOf, core } = legacy()
    expect(shell(a.pid)).toBe(a.row.id)
    expect(parentOf(spawn(a.pid, "new-sol", 41).id)).toBe(core.whoami(a.row.id).address)
  })

  test("a released default row with children is passed by, by a hook and by a shim of another session", () => {
    const { a, core, clock, dead, hook, shim, parentOf, unread, worker } = legacy()
    const address = core.whoami(a.hooks.id).address
    core.send(worker.id, { to: address, body: "finished" })
    dead.add(a.pid)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    const other = hook(60, session(9))
    expect(other.id).not.toBe(a.hooks.id)
    expect(unread(other.id)).toEqual([])
    const named = shim(70, { handle: "claude-app", derived: true, harness_session: session(10) })
    expect(named.id).not.toBe(a.hooks.id)
    expect(parentOf(worker.id)).toBe(address)
  })

  test("a claim with a given name still takes that row, as a human's name for it", () => {
    const { a, core, clock, dead, shim } = legacy()
    dead.add(a.pid)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    const handle = core.whoami(a.hooks.id).address.slice(3)
    expect(shim(70, { handle, harness_session: session(10) }).id).toBe(a.hooks.id)
  })
})

describe("handle search", () => {
  /** a root at the default handle that reported no harness session, with `extra` claims */
  function bare() {
    const ctx = setup()
    const { core, dead, clock, hook } = ctx
    const row = hook(10, session(1))
    dead.add(10)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    return { ...ctx, row, core }
  }

  test("an empty row of no session stays free for the next session's hook", () => {
    const { row, hook } = bare()
    expect(hook(11, session(2)).id).toBe(row.id)
  })

  test("a row of no session with unread mail is not another session's to read", () => {
    const { core, row, hook, peer } = bare()
    core.send(peer.id, { to: core.whoami(row.id).address, body: "for whoever ran here" })
    const other = hook(11, session(2))
    expect(other.id).not.toBe(row.id)
    expect(core.inbox(other.id)).toEqual([])
  })

  test("a quiet session whose process still runs keeps its row, by a claim of another session", () => {
    const { core, clock, hook } = setup()
    const row = hook(10, session(1))
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    expect(core.whoami(row.id).presence).toBe("offline")
    expect(hook(11, session(2)).id).not.toBe(row.id)
    const bare = core.claim({
      handle: "claude-app",
      derived: true,
      harness: "claude-code",
      cwd: CWD,
      process: key(12),
      session: key(12),
      lineage: [key(12)],
    }).endpoint
    expect(bare.id).not.toBe(row.id)
  })

  test("a session takes its own row back, children and all, by its harness session or process", () => {
    const { core, clock, dead, hook, tool, spawn, parentOf } = setup()
    const started = session(1)
    const row = hook(10, started)
    tool(row.id, 10, started)
    const worker = spawn(10, "own-sol", 40)
    dead.add(10)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    expect(hook(11, started).id).toBe(row.id)
    expect(parentOf(worker.id)).toBe(core.whoami(row.id).address)
  })

  test("a claim that reports no harness session keeps taking back its restarted row, children and all", () => {
    const { core, clock, dead, hook, tool, spawn, parentOf } = setup()
    const started = session(1)
    const row = hook(10, started)
    tool(row.id, 10, started)
    const worker = spawn(10, "own-sol", 40)
    dead.add(10)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    const other = core.claim({
      handle: "claude-app",
      derived: true,
      harness: "claude-code",
      cwd: CWD,
      process: key(60),
      session: key(60),
      lineage: [key(60)],
    }).endpoint
    expect(other.id).toBe(row.id)
    expect(parentOf(worker.id)).toBe(core.whoami(row.id).address)
  })

  test("a spawned session's grant still places it after its hooks passed a row with children by", () => {
    const { core, lead, hook, shim, tool, spawn, dead, clock, parentOf } = setup()
    const started = session(1)
    const row = hook(10, started)
    tool(row.id, 10, started)
    spawn(10, "own-sol", 40)
    dead.add(10)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    const grant = core.grant(self(lead.id), { name: "fresh" }).token
    const next = session(2)
    expect(hook(11, next).id).not.toBe(row.id)
    const fresh = shim(11, { handle: "fresh", grant, harness_session: next })
    expect(fresh.id).not.toBe(row.id)
    expect(parentOf(fresh.id)).toBe(lead.address)
  })
})
