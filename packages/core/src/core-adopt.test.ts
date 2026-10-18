import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const HUMAN: ScopeActor = { kind: "human", tty: true }
const NO_TTY: ScopeActor = { kind: "human", tty: false }
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
  const claim = (handle: string, pid: number) => ({ handle, harness: "claude-code", process: key(pid), session: key(pid), lineage: [key(pid), key(1)] })
  const hook = (handle: string, pid: number) => core.claim(claim(handle, pid), { transient: true }).endpoint
  const lead = hook("lead", 10)
  const peer = core.claim({ handle: "peer", harness: "codex" }).endpoint
  const send = (from: string, to: string) => {
    try {
      core.send(from, { to, body: "hi" })
      return "ok"
    } catch (error) {
      if (error instanceof RelayError) return error.code
      throw error
    }
  }
  return { core, clock, db, claim, hook, lead, peer, send }
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

describe("join under a parent", () => {
  test("a session links itself under a parent: the tree shows it and it takes on a worker's scope", () => {
    const { core, claim, peer, send } = setup()
    core.setPolicy({ rules: [], defaults: { child_default: "parent" } })
    const before = core.joinSession(claim("app", 20))
    expect(before.parent ?? null).toBeNull()
    expect(send(before.id, "peer")).toBe("ok")
    const joined = core.joinSession(claim("app", 20), undefined, "lead")
    expect(joined).toMatchObject({ id: before.id, parent: "me/lead", depth: 1 })
    expect(core.list({ all: true }).find((v) => v.id === before.id)?.parent).toBe("me/lead")
    expect(send(before.id, "lead")).toBe("ok")
    expect(send(before.id, peer.address)).toBe("not_found")
    const audit = core.log({}).find((row) => row.event === "adopt")
    expect(audit?.detail).toMatchObject({ by: "me/app", target: "me/app", parent: "me/lead" })
    expect(core.joinSession(claim("app", 20), undefined, "lead").parent).toBe("me/lead")
  })

  test("under the default inherit scope the linked session reaches only what its parent reaches", () => {
    const { core, claim, send } = setup()
    const root = core.joinSession(claim("app", 20))
    core.rulesSet(HUMAN, { endpoint: "lead", out: ["tree:children"], in: ["*"] })
    expect(send(root.id, "peer")).toBe("ok")
    const app = core.joinSession(claim("app", 20), undefined, "lead")
    expect(app.parent).toBe("me/lead")
    expect(send(app.id, "peer")).toBe("not_found")
  })

  test("its later root claims, after it went offline too, take back the linked endpoint", () => {
    const { core, clock, claim, hook } = setup()
    const app = core.joinSession(claim("app", 20), undefined, "lead")
    expect(hook("app", 20)).toMatchObject({ id: app.id, parent: "me/lead" })
    core.leaveSession(self(app.id))
    clock.now += 3_600_000
    expect(core.joinSession(claim("app", 21))).toMatchObject({ id: app.id, parent: "me/lead" })
  })

  test("refuses a parent it cannot reach, another parent and its own descendant", () => {
    const { core, claim, lead } = setup()
    core.rulesSet(self(lead.id), { in: [] })
    expect(failure(() => core.joinSession(claim("app", 20), undefined, "lead")).code).toBe("not_found")
    expect(core.list({ all: true }).find((v) => v.address === "me/app")).toBeUndefined()
    core.joinSession(claim("app", 20))
    core.joinSession(claim("other", 30), undefined, "peer")
    const err = failure(() => core.joinSession(claim("other", 30), undefined, "app"))
    expect(err.message).toContain("already sits under me/peer")
    const app = core.list({ all: true }).find((v) => v.address === "me/app")!
    core.adopt(HUMAN, { endpoint: "peer", parent: "me/app" })
    expect(failure(() => core.joinSession(claim("app", 20), undefined, "other")).message).toContain("its own descendant")
    expect(failure(() => core.joinSession(claim("app", 20), undefined, "app")).message).toContain("its own descendant")
    expect(core.whoami(app.id).parent ?? null).toBeNull()
  })
})

describe("adopt", () => {
  test("the human at a terminal links a root, its subtree moving along", () => {
    const { core, claim, lead } = setup()
    const app = core.joinSession(claim("app", 20))
    core.adopt(HUMAN, { endpoint: "peer", parent: "app" })
    const result = core.adopt(HUMAN, { endpoint: "app", parent: "lead" })
    expect(result).toMatchObject({ parent: "me/lead", endpoint: { id: app.id, parent: "me/lead", depth: 1 } })
    const peer = core.list({ all: true }).find((v) => v.address === "me/peer")!
    expect(peer).toMatchObject({ parent: "me/app", depth: 2 })
    expect(core.scopeView(HUMAN, "peer").tree).toBe(lead.address)
    expect(core.log({}).find((row) => row.event === "adopt" && row.detail?.target === "me/app")?.detail).toMatchObject({
      by: "me/",
      auth: "tty",
      parent: "me/lead",
    })
  })

  test("an agent without a terminal and the human without one are refused; the human names the parent", () => {
    const { core, lead } = setup()
    expect(failure(() => core.adopt(self(lead.id), { endpoint: "peer" })).code).toBe("scope_refused")
    expect(failure(() => core.adopt(NO_TTY, { endpoint: "peer", parent: "lead" })).code).toBe("scope_refused")
    expect(failure(() => core.adopt(HUMAN, { endpoint: "peer" })).code).toBe("invalid_params")
    expect(core.list({ all: true }).find((v) => v.address === "me/peer")?.parent ?? null).toBeNull()
  })

  test("an agent with a terminal attached links under itself by default", () => {
    const { core, lead } = setup()
    expect(core.adopt(self(lead.id), { endpoint: "peer" }, { tty: true }).endpoint.parent).toBe("me/lead")
  })

  test("refuses a cycle", () => {
    const { core } = setup()
    core.adopt(HUMAN, { endpoint: "peer", parent: "lead" })
    expect(failure(() => core.adopt(HUMAN, { endpoint: "lead", parent: "peer" })).message).toContain("its own descendant")
    expect(failure(() => core.adopt(HUMAN, { endpoint: "lead", parent: "lead" })).message).toContain("its own descendant")
  })

  test("a relay of one machine finds no parent on another machine and links nothing", () => {
    const { core, claim } = setup()
    expect(failure(() => core.adopt(HUMAN, { endpoint: "peer", parent: "me/desk/lead" })).code).toBe("not_found")
    expect(failure(() => core.joinSession(claim("app", 20), undefined, "me/desk/lead")).code).toBe("not_found")
    expect(core.list({ all: true }).map((v) => v.parent ?? null)).toEqual([null, null, null])
  })
})

describe("unlink", () => {
  test("the human puts a linked agent back to a root, with its subtree and without the child scope", () => {
    const { core, claim, send } = setup()
    core.setPolicy({ rules: [], defaults: { child_default: "parent" } })
    const app = core.joinSession(claim("app", 20), undefined, "lead")
    core.adopt(HUMAN, { endpoint: "peer", parent: "app" })
    expect(send(app.id, "peer")).toBe("ok")
    const result = core.unlink(HUMAN, { endpoint: "app" })
    expect(result).toMatchObject({ parent: "me/lead", endpoint: { id: app.id, parent: null, depth: 0 } })
    expect(core.list({ all: true }).find((v) => v.address === "me/peer")).toMatchObject({ parent: "me/app", depth: 1 })
    expect(core.scopeView(HUMAN, "app")).toMatchObject({ parent: null, tree: "me/app", caps: [] })
    expect(core.log({}).find((row) => row.event === "unlink")?.detail).toMatchObject({ target: "me/app", parent: "me/lead" })
    expect(failure(() => core.unlink(HUMAN, { endpoint: "app" })).code).toBe("invalid_params")
  })

  test("the agent itself only when the policy lets it", () => {
    const { core, claim } = setup()
    const app = core.joinSession(claim("app", 20), undefined, "lead")
    expect(failure(() => core.unlink(self(app.id))).code).toBe("scope_refused")
    expect(failure(() => core.unlink(NO_TTY, { endpoint: "app" })).code).toBe("scope_refused")
    core.setPolicy({ rules: [], defaults: { unlink: "self" } })
    expect(core.unlink(self(app.id)).endpoint.parent).toBeNull()
  })
})
