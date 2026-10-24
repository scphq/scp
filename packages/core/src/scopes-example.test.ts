import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { RelayCore } from "./core"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const TEST_RATES = {
  pairBurst: 20,
  pairPerMinute: 30,
  pairPerHour: 300,
  userPerDay: 2000,
  treePerMinute: 120,
  treePerHour: 1200,
  treePauseS: 600,
  groupPerMinute: 60,
  peekPairPerMinute: 6,
  peekTargetPerHour: 60,
}

function bunSql(db: Database): Sql {
  return { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
}

function setup() {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const core = new RelayCore(bunSql(db), {
    limits: TEST_RATES,
    now: () => clock.now,
    hash: (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: (fn) => db.transaction(fn)(),
    machine: "laptop",
  })
  core.migrate()
  return { core, clock }
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

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const HUMAN: ScopeActor = { kind: "human", tty: true }

/** main, three orchestrators with four workers each in a team, and app-main as another fleet */
function fleet() {
  const { core, clock } = setup()
  const ids: Record<string, string> = {}
  const as = (name: string): ScopeActor => ({ kind: "endpoint", id: ids[name]!, auth: "session" })
  ids.main = core.claim({ handle: "main", harness: "claude-code", process: key(100), lineage: [key(100), key(1)] }).endpoint.id
  core.rulesSet(as("main"), { in: ["tree:children"] })
  for (const [n, o] of ["a", "b", "c"].entries()) {
    const allow = ["tree:parent", "tree:siblings", "tree:children", ...(o === "a" ? ["fleet:app-main"] : [])]
    const { token } = core.grant(as("main"), { name: `orch-${o}`, scope: "none", allow })
    const orch = 200 + n * 100
    ids[`orch-${o}`] = core.claim({
      handle: `orch-${o}`,
      harness: "codex",
      process: key(orch),
      lineage: [key(orch), key(orch - 1), key(100), key(1)],
      grant: token,
    }).endpoint.id
    core.group(as(`orch-${o}`), { action: "create", name: `team-${o}`, rules: ["group:self", "tree:parent"] })
    for (let i = 1; i <= 4; i++) {
      const grant = core.grant(as(`orch-${o}`), { name: `${o}${i}`, groups: [`team-${o}`] })
      ids[`${o}${i}`] = core.claim({
        handle: `${o}${i}`,
        harness: "codex",
        process: key(orch + 10 * i),
        lineage: [key(orch + 10 * i), key(orch + 10 * i - 1), key(orch), key(100)],
        grant: grant.token,
      }).endpoint.id
    }
  }
  ids["app-main"] = core.claim({ handle: "app-main", harness: "claude-code", process: key(900), lineage: [key(900), key(1)] }).endpoint.id
  ids.human = core.claimHuman(true).id
  return { core, clock, ids, as }
}

const ROWS = ["main", "orch-a", "orch-b", "a1", "app-main", "human"] as const
const COLUMNS = ["main", "orch-a", "orch-b", "a1", "a2", "b1", "app-main", "human"] as const
const address = (name: string) => (name === "human" ? "me/" : `me/${name}`)
const TABLE: Record<(typeof ROWS)[number], Partial<Record<(typeof COLUMNS)[number], boolean>>> = {
  main: { "orch-a": true, "orch-b": true, a1: true, a2: true, b1: true, "app-main": false, human: true },
  "orch-a": { main: true, "orch-b": true, a1: true, a2: true, b1: false, "app-main": true, human: true },
  "orch-b": { main: true, "orch-a": true, a1: false, a2: false, b1: true, "app-main": false, human: true },
  a1: { main: false, "orch-a": true, "orch-b": false, a2: true, b1: false, "app-main": false, human: true },
  "app-main": { main: false, "orch-a": false, "orch-b": false, a1: false, a2: false, b1: false, human: true },
  human: { main: true, "orch-a": true, "orch-b": true, a1: true, a2: true, b1: true, "app-main": true },
}

test("lineage and grants place the fleet: orchestrators under main, workers under their orchestrator, app-main a root", () => {
  const { core, as } = fleet()
  expect(core.scopeView(HUMAN, "orch-a")).toMatchObject({ tree: "me/main", parent: "me/main", depth: 1, preset: "custom" })
  expect(core.scopeView(HUMAN, "a3")).toMatchObject({ tree: "me/main", parent: "me/orch-a", depth: 2, groups: ["team-a"] })
  expect(core.scopeView(HUMAN, "c4")).toMatchObject({ parent: "me/orch-c", groups: ["team-c"] })
  expect(core.scopeView(HUMAN, "app-main")).toMatchObject({ tree: "me/app-main", parent: null, depth: 0, preset: "open" })
  expect(core.scopeView(as("main"), "a1").address).toBe("me/a1")
  expect(code(() => core.scopeView(as("a1"), "main"))).toBe("not_found")
})

test("the who-can-message-whom table holds through send and why", () => {
  const { core, ids } = fleet()
  for (const from of ROWS) {
    for (const to of COLUMNS) {
      const expected = TABLE[from][to]
      if (expected === undefined) continue
      const sent = code(() => core.send(ids[from]!, { to: address(to), body: `${from} to ${to}` }))
      expect([from, to, sent]).toEqual([from, to, expected ? undefined : "not_found"])
      expect([from, to, core.why(HUMAN, address(from), address(to)).allowed]).toEqual([from, to, expected])
    }
  }
  expect(core.why(HUMAN, "main", "a1").reasons).toEqual(["me/main is an ancestor of me/a1: scopes never stop it"])
  expect(core.why(HUMAN, "app-main", "a1").reasons.at(-1)).toBe(
    "out(me/app-main) has the default reach: its own tree and the roots; only the human, the policy or a widening reaches further",
  )
  expect(core.why(HUMAN, "app-main", "orch-a").reasons.at(-1)).toBe(
    "out(me/app-main) has the default reach: its own tree and the roots; only the human, the policy or a widening reaches further",
  )
  expect(core.why(HUMAN, "main", "app-main").reasons.at(-1)).toContain("out(me/main) admits only its own fleet")
  expect(core.why(HUMAN, "app-main", "main").reasons.at(-1)).toContain("who may message main")
  const refused = core.log({ scope: true }).filter((row) => row.event === "scope_refused")
  expect(refused.length).toBe(
    Object.values(TABLE)
      .flatMap((row) => Object.values(row))
      .filter((allowed) => !allowed).length,
  )
  expect(refused[0]!.detail).toMatchObject({ from: "me/main", to: "me/app-main", dir: "out" })
})

test("discovery: a third-order worker does not see main, and the error is the unknown-address one", () => {
  const { core, ids } = fleet()
  const listed = core.list({ all: true, viewer: ids.a1 }).map((view) => view.address)
  expect(listed).toContain("me/orch-a")
  expect(listed).toContain("me/a2")
  expect(listed).toContain("me/")
  expect(listed).not.toContain("me/main")
  expect(listed).not.toContain("me/b1")
  let message = ""
  try {
    core.send(ids.a1!, { to: "main", body: "hi" })
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toBe("no endpoint main that you can reach (swarm peers lists who you may message)")
  expect(core.peers(ids.a1!).find((peer) => peer.address === "me/orch-a")!.reason).toContain("tree:parent")
})

test("the widening steps apply in order, each with its audit row", () => {
  const { core, clock, ids, as } = fleet()
  const send = (from: string, to: string) => code(() => core.send(ids[from]!, { to: address(to), body: `${from} to ${to}` }))
  const lastScopeRow = () => core.log({ scope: true }).at(-1)!

  expect(core.rulesWiden(as("main"), { endpoint: "a1", out: ["handle:main"] })).toEqual({ added: ["handle:main"], clipped: [] })
  expect(lastScopeRow()).toMatchObject({ event: "scope_widen", detail: { by: "me/main", target: "me/a1", dir: "out", added: ["handle:main"] } })

  expect(core.rulesSet(as("main"), { in: ["tree:children", "handle:a1"] }).rules).toEqual({ in: ["tree:children", "handle:a1"] })
  expect(lastScopeRow()).toMatchObject({ event: "scope_widen", detail: { by: "me/main", target: "me/main", dir: "in" } })

  expect(send("a1", "main")).toBeUndefined()
  expect(send("a2", "main")).toBe("not_found")

  expect(code(() => core.rulesWiden(as("orch-b"), { endpoint: "b1", out: ["fleet:app-main"] }))).toBe("scope_refused")
  expect(lastScopeRow()).toMatchObject({ event: "scope_refused", detail: { by: "me/orch-b", target: "me/b1", clipped: ["fleet:app-main"] } })
  expect(send("b1", "app-main")).toBe("not_found")

  expect(core.rulesWiden(as("orch-a"), { endpoint: "a1", out: ["fleet:app-main"] })).toEqual({ added: ["fleet:app-main"], clipped: [] })
  expect(lastScopeRow()).toMatchObject({ event: "scope_widen", detail: { by: "me/orch-a", via: "me/orch-a", target: "me/a1", added: ["fleet:app-main"] } })
  expect(send("a1", "app-main")).toBeUndefined()
  expect(send("a2", "app-main")).toBe("not_found")

  core.rulesSet(as("main"), { endpoint: "orch-a", out: ["tree:parent", "tree:siblings", "tree:children"] })
  expect(lastScopeRow()).toMatchObject({
    event: "scope_narrow",
    detail: { by: "me/main", target: "me/orch-a", dir: "out", after: ["tree:parent", "tree:siblings", "tree:children"] },
  })
  expect(send("orch-a", "app-main")).toBe("not_found")
  expect(send("a1", "app-main")).toBe("not_found")
  expect(send("a1", "orch-a")).toBeUndefined()

  expect(code(() => core.rulesWiden(as("a1"), { endpoint: "a1", out: ["*"] }))).toBe("scope_refused")
  expect(code(() => core.rulesWiden(as("a1"), { endpoint: "a2", out: ["*"] }))).toBe("scope_refused")
  expect(lastScopeRow()).toMatchObject({ event: "scope_refused", detail: { by: "me/a1", target: "me/a2", reason: "no authority" } })

  expect(code(() => core.group(as("a1"), { action: "remove", name: "team-a", endpoint: "a1" }))).toBe("scope_refused")
  expect(lastScopeRow()).toMatchObject({ event: "scope_refused", detail: { by: "me/a1", target: "group:team-a" } })
  expect((core.group(HUMAN, { action: "show", name: "team-a" }) as { members: string[] }).members).toContain("me/a1")

  expect(code(() => core.rulesWiden(as("orch-a"), { endpoint: "b1", out: ["handle:a1"] }))).toBe("not_found")
  core.admin(HUMAN, { action: "grant", subject: "orch-a", tree: "main" })
  expect(lastScopeRow()).toMatchObject({ event: "scope_admin", detail: { by: "me/", target: "me/orch-a", action: "grant", tree: "me/main" } })
  expect(core.rulesWiden(as("orch-a"), { endpoint: "b1", out: ["handle:a1", "fleet:app-main"] })).toEqual({ added: ["handle:a1"], clipped: ["fleet:app-main"] })
  expect(send("b1", "a1")).toBe("not_found")
  expect(core.rulesWiden(as("orch-a"), { endpoint: "a1", in: ["handle:b1"] })).toEqual({ added: ["handle:b1"], clipped: [] })
  expect(send("b1", "a1")).toBeUndefined()
  expect(send("b1", "app-main")).toBe("not_found")

  clock.now += 3601 * 1000
  for (let i = 0; i <= LIMITS.pingPongAlternations; i++, clock.now += 4000) expect(i % 2 ? send("a3", "a2") : send("a2", "a3")).toBeUndefined()
  expect(send("a2", "a3")).toBe("loop_guard")

  clock.now += 61 * 1000
  const pairs = ["a1", "a2", "a3", "a4"].flatMap((from) => ["a1", "a2", "a3", "a4"].filter((to) => to !== from).map((to) => [from, to] as const))
  const open = pairs.filter(([from, to]) => !(["a2", "a3"].includes(from) && ["a2", "a3"].includes(to)))
  expect(open.length * 12).toBe(TEST_RATES.treePerMinute)
  for (const [k, [from, to]] of open.entries()) {
    if (k) clock.now += 6000
    for (let i = 0; i < 12; i++) expect(send(from, to)).toBeUndefined()
  }
  expect(send("a1", "a4")).toBe("loop_guard")
  expect(send("orch-b", "main")).toBe("loop_guard")
  expect(send("a1", "human")).toBeUndefined()
  core.rulesSet(HUMAN, { endpoint: "app-main", out: ["ep:orch-a"] })
  expect(send("app-main", "orch-a")).toBeUndefined()
  expect(core.inbox(ids.human!).some((m) => m.kind === "status" && m.body.text.includes("paused the tree of me/main"))).toBe(true)
  expect(core.inbox(ids.main!).some((m) => m.kind === "status" && m.body.text.includes("paused the tree of me/main"))).toBe(true)
  expect(
    core
      .log()
      .filter((row) => row.event === "loop_guard")
      .map((row) => Object.keys(row.detail).includes("tree")),
  ).toEqual([false, true])
  clock.now += TEST_RATES.treePauseS * 1000 + 1000
  expect(send("a1", "a4")).toBeUndefined()
})
