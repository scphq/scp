import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { matches, parsePolicy, type PolicySubject, validSelector } from "./policy"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import { expandRules, narrower } from "./scopes"
import { findSecret } from "./scrub"
import type { Sql, SqlValue } from "./sql"

function bunSql(db: Database): Sql {
  return { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
}

function setup() {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const stats = { queries: 0 }
  const sql = bunSql(db)
  const counted: Sql = {
    all: <T>(query: string, ...params: SqlValue[]) => {
      stats.queries++
      return sql.all<T>(query, ...params)
    },
  }
  const options = {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    machine: "laptop",
  }
  const core = new RelayCore(counted, options)
  core.migrate()
  /** another core on the same database, as after a broker restart */
  const restarted = () => {
    const next = new RelayCore(sql, options)
    next.migrate()
    return next
  }
  const ids: Record<string, string> = {}
  /** claims `handle` from process `pid` whose ancestors are `parents` (pids, nearest first) */
  const claim = (handle: string, pid: number, parents: number[] = [], extra: Record<string, unknown> = {}) => {
    const result = core.claim({ handle, harness: "codex", process: key(pid), lineage: [key(pid), ...parents.map(key)], ...extra })
    ids[handle] = result.endpoint.id
    return result.endpoint
  }
  const as = (handle: string, auth: "session" | "self" | "lineage" = "session"): ScopeActor => ({ kind: "endpoint", id: ids[handle]!, auth })
  const send = (from: string, to: string, extra: Record<string, unknown> = {}) => code(() => core.send(ids[from]!, { to, body: `${from} to ${to}`, ...extra }))
  return { core, clock, db, ids, claim, as, send, stats, restarted }
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

describe("selectors", () => {
  const node = (id: string, ancestors: string[], extra: Partial<PolicySubject> = {}): PolicySubject => ({
    handle: id,
    harness: "codex",
    kind: "agent",
    labels: {},
    scope: { id, tree: "r", ancestors, groups: id === "g" ? ["team"] : [], rootHandle: "r", machine: "laptop", local: true },
    ...extra,
  })
  const r = node("r", [])
  const c1 = node("c1", ["r"])
  const c2 = node("c2", ["r"])
  const g = node("g", ["c1", "r"])
  const h = node("h", ["g", "c1", "r"])
  const everyone = [r, c1, c2, g, h]
  const hits = (sel: string, anchor: PolicySubject) => everyone.filter((x) => matches(sel, x, anchor)).map((x) => x.handle)

  test("tree selectors are relative to the list's owner", () => {
    expect(hits("tree:self", g)).toEqual(["r", "c1", "c2", "g", "h"])
    expect(hits("tree:root", h)).toEqual(["r"])
    expect(hits("tree:parent", g)).toEqual(["c1"])
    expect(hits("tree:ancestors", h)).toEqual(["r", "c1", "g"])
    expect(hits("tree:ancestors:1", h)).toEqual(["g"])
    expect(hits("tree:ancestors:2", h)).toEqual(["c1", "g"])
    expect(hits("tree:children", r)).toEqual(["c1", "c2"])
    expect(hits("tree:descendants", r)).toEqual(["c1", "c2", "g", "h"])
    expect(hits("tree:descendants:2", r)).toEqual(["c1", "c2", "g"])
    expect(hits("tree:siblings", c1)).toEqual(["c2"])
    expect(hits("tree:siblings", r)).toEqual([])
    expect(hits("tree:parent", r)).toEqual([])
    expect(matches("tree:self", g)).toBe(false)
  })

  test("group, fleet, machine, org and * selectors", () => {
    expect(hits("group:team", r)).toEqual(["g"])
    expect(hits("group:self", r)).toEqual([])
    expect(hits("fleet:r", r)).toEqual(["r", "c1", "c2", "g", "h"])
    expect(hits("fleet:other", r)).toEqual([])
    expect(hits("fleet:*", r).length).toBe(5)
    expect(hits("machine:laptop", r).length).toBe(5)
    expect(hits("machine:desk", r)).toEqual([])
    for (const sel of ["org:*", "org:acme", "group:acme/review"]) expect(hits(sel, r)).toEqual([])
    expect(hits("*", r).length).toBe(5)
    const human: PolicySubject = { handle: "", harness: "human", kind: "human", labels: {} }
    for (const sel of ["tree:self", "group:team", "fleet:*", "fleet:r", "machine:laptop"]) expect(matches(sel, human, r)).toBe(false)
    expect(matches("tree:self", node("x", [], { scope: { ...r.scope!, id: "x", tree: "other" } }), r)).toBe(false)
  })

  test("the grammar: depth 1 to 16, group:self only in group rules, no relative selector in match", () => {
    expect(validSelector("tree:ancestors:16")).toBe(true)
    expect(validSelector("tree:ancestors:17")).toBe(false)
    expect(validSelector("tree:descendants:0")).toBe(false)
    expect(validSelector("tree:cousins")).toBe(false)
    expect(validSelector("group:self")).toBe(false)
    expect(validSelector("group:self", { groupRules: true })).toBe(true)
    expect(validSelector("tree:self", { absolute: true })).toBe(false)
    expect(validSelector("fleet:bo-main", { absolute: true })).toBe(true)
    expect(code(() => parsePolicy({ rules: [{ match: "tree:children", send_to: ["*"] }] }))).toBe("invalid_params")
    expect(parsePolicy({ rules: [{ match: "harness:codex", send_to: ["tree:parent"] }] }).rules[0]!.send_to).toEqual(["tree:parent"])
  })
})

describe("presets and own rules", () => {
  test("presets expand per symmetric_presets, allow appends, in and out win for their direction", () => {
    expect(expandRules({ scope: "tree" }, true)).toEqual({ in: ["tree:parent", "tree:descendants"], out: ["tree:parent", "tree:descendants"] })
    expect(expandRules({ scope: "parent", allow: ["fleet:x"] }, true)).toEqual({ in: ["tree:parent", "fleet:x"], out: ["tree:parent", "fleet:x"] })
    expect(expandRules({ scope: "none" }, false)).toEqual({ out: [] })
    expect(expandRules({ scope: "open" }, true)).toEqual({ in: null, out: null })
    expect(expandRules({ scope: "tree", in: ["*"] }, true)).toEqual({ in: ["*"], out: ["tree:parent", "tree:descendants"] })
    expect(expandRules({ allow: ["tree:children"] }, true)).toEqual({ in: ["tree:children"], out: ["tree:children"] })
    expect(code(() => expandRules({ scope: "open", allow: ["*"] }, true))).toBe("invalid_params")
    expect(narrower(["a"], ["a", "b"])).toBe(true)
    expect(narrower(["c"], ["a"])).toBe(false)
    expect(narrower(null, ["a"])).toBe(false)
    expect(narrower(["c"], undefined)).toBe(true)
  })

  test("a claim's scope sets its own rules, and the view names the preset", () => {
    const { core, claim, as } = setup()
    expect(claim("w", 1, [], { scope: "tree" }).scope).toBe("tree")
    expect(core.scopeView(as("w")).rules).toEqual({ in: ["tree:parent", "tree:descendants"], out: ["tree:parent", "tree:descendants"] })
    expect(claim("v", 2, [], { scope: "parent", in: ["*"] }).scope).toBe("custom")
    expect(claim("u", 3).scope).toBe("open")
  })

  test("the tree preset reaches the endpoint's parent and its own subtree, never a sibling lead's", () => {
    const { core, claim, as, send } = setup()
    claim("orch", 1)
    claim("a", 2, [1], { grant: core.grant(as("orch"), { scope: "tree" }).token })
    claim("b", 3, [1], { grant: core.grant(as("orch"), { scope: "tree" }).token })
    claim("a1", 4, [2, 1])
    claim("a2", 5, [4, 2, 1])
    claim("b1", 6, [3, 1])
    for (const [from, to] of [
      ["a", "b"],
      ["b", "a"],
      ["a", "b1"],
      ["b", "a1"],
      ["a1", "b"],
      ["a2", "b1"],
    ])
      expect(send(from!, to!)).toBe("not_found")
    for (const [from, to] of [
      ["a", "orch"],
      ["b", "orch"],
      ["a", "a1"],
      ["a", "a2"],
      ["a1", "a"],
      ["a2", "a"],
      ["b", "b1"],
      ["b1", "b"],
      ["orch", "a"],
      ["orch", "b1"],
    ])
      expect(send(from!, to!)).toBeUndefined()
    core.rulesSet(as("orch"), { scope: "tree" })
    expect(send("orch", "a2")).toBeUndefined()
    expect(core.scopeView(as("a")).preset).toBe("tree")
  })

  test("a plain shell may only tighten its endpoint's own rules; a session may loosen them", () => {
    const { core, claim, as } = setup()
    claim("w", 1)
    expect(core.rulesSet(as("w", "lineage"), { out: ["tree:self", "fleet:x"] }).rules.out).toEqual(["tree:self", "fleet:x"])
    expect(core.rulesSet(as("w", "lineage"), { out: ["tree:self"] }).rules.out).toEqual(["tree:self"])
    expect(code(() => core.rulesSet(as("w", "lineage"), { out: ["*"] }))).toBe("scope_refused")
    expect(code(() => core.rulesSet(as("w", "lineage"), { scope: "open" }))).toBe("scope_refused")
    expect(core.rulesSet(as("w"), { scope: "open" }).preset).toBe("open")
  })

  test("a relative tree selector is within tree:self, so the tree preset narrows a tree:self list", () => {
    expect(narrower(["tree:parent", "tree:descendants"], ["tree:self"])).toBe(true)
    expect(narrower(["tree:root", "tree:siblings", "tree:children", "tree:ancestors:2", "tree:descendants:3", "tree:self"], ["tree:self", "fleet:x"])).toBe(
      true,
    )
    expect(narrower(["tree:parent", "fleet:x"], ["tree:self"])).toBe(false)
    expect(narrower(["tree:self"], ["tree:parent", "tree:descendants"])).toBe(false)
    expect(narrower(["tree:children"], ["tree:descendants"])).toBe(false)
    const { core, claim, as } = setup()
    claim("w", 1)
    core.rulesSet(as("w"), { in: ["tree:self"], out: ["tree:self"] })
    const view = core.rulesSet(as("w", "lineage"), { scope: "tree" })
    expect(view.rules).toEqual({ in: ["tree:parent", "tree:descendants"], out: ["tree:parent", "tree:descendants"] })
    expect(view.preset).toBe("tree")
    expect(
      core
        .log({ scope: true })
        .slice(-2)
        .map((row) => row.event),
    ).toEqual(["scope_narrow", "scope_narrow"])
  })

  test("lists stored as exactly tree:self before the tree preset narrowed narrow to it once, on the next open", () => {
    const { core, db, claim, as, ids, restarted } = setup()
    claim("orch", 1)
    claim("a", 2, [1], { grant: core.grant(as("orch"), { scope: "tree" }).token })
    claim("b", 3, [1], { grant: core.grant(as("orch"), { scope: "tree" }).token })
    claim("c", 4, [1], { scope: "tree" })
    claim("a1", 5, [2, 1])
    claim("x", 6, [1], { out: ["tree:self", "fleet:x"] })
    core.grant(as("orch"), { scope: "tree" })
    core.grant(as("orch"), { out: ["tree:self", "fleet:x"] })
    const preset = '"tree:parent","tree:descendants"'
    const entries = '{"sel":"tree:parent"},{"sel":"tree:descendants"}'
    db.query(`UPDATE endpoints SET rules = replace(rules, '${preset}', '"tree:self"'), caps = replace(caps, '${entries}', '{"sel":"tree:self"}')`).run()
    db.query(`UPDATE grants SET caps = replace(caps, '${entries}', '{"sel":"tree:self"}')`).run()
    db.query(`DROP TABLE IF EXISTS relay_migrations`).run()
    const send = (relay: RelayCore, from: string, to: string) => code(() => relay.send(ids[from]!, { to, body: `${from} to ${to}` }))
    expect(send(core, "a", "b")).toBeUndefined()
    expect(core.scopeView(as("a")).preset).toBe("custom")

    const next = restarted()
    const row = (handle: string) =>
      db.query<{ rules: string | null; caps: string | null }, [string]>(`SELECT rules, caps FROM endpoints WHERE handle = ?`).get(handle)!
    const tree = ["tree:parent", "tree:descendants"]
    for (const handle of ["a", "b"])
      expect(JSON.parse(row(handle).caps!).caps.map((cap: { sels: { sel: string }[] }) => cap.sels)).toEqual([
        tree.map((sel) => ({ sel })),
        tree.map((sel) => ({ sel })),
      ])
    expect(JSON.parse(row("c").rules!)).toEqual({ in: tree, out: tree })
    expect(JSON.parse(row("x").rules!)).toEqual({ out: ["tree:self", "fleet:x"] })
    const grants = db.query<{ caps: string; used_by: string | null }, []>(`SELECT caps, used_by FROM grants ORDER BY created_at, rowid`).all()
    expect(grants.filter((g) => g.used_by === null).map((g) => JSON.parse(g.caps))).toEqual([
      [
        { dir: "in", sels: tree.map((sel) => ({ sel })) },
        { dir: "out", sels: tree.map((sel) => ({ sel })) },
      ],
      [{ dir: "out", sels: [{ sel: "tree:self" }, { sel: "fleet:x" }] }],
    ])
    for (const [from, to] of [
      ["a", "b"],
      ["b", "a"],
      ["c", "a"],
      ["a", "c"],
      ["a1", "b"],
    ])
      expect(send(next, from!, to!)).toBe("not_found")
    for (const [from, to] of [
      ["a", "orch"],
      ["c", "orch"],
      ["a", "a1"],
      ["a1", "a"],
      ["orch", "b"],
    ])
      expect(send(next, from!, to!)).toBeUndefined()
    for (const handle of ["a", "b", "c"]) expect(next.scopeView(as(handle)).preset).toBe("tree")

    const migrated = next.log({ scope: true }).filter((entry) => entry.event === "scope_migrate")
    expect(migrated.map((entry) => entry.detail.target)).toEqual(["me/a", "me/b", "me/c", "me/orch"])
    expect(migrated[2]!.detail).toMatchObject({
      lists: [
        { list: "own rules", dir: "in", before: ["tree:self"], after: tree },
        { list: "own rules", dir: "out", before: ["tree:self"], after: tree },
      ],
    })
    expect(migrated[3]!.detail).toMatchObject({
      grant: true,
      lists: [
        { list: "grant", dir: "in", before: ["tree:self"], after: tree },
        { list: "grant", dir: "out" },
      ],
    })

    next.rulesSet(as("c"), { in: ["tree:self"], out: ["tree:self"] })
    const again = restarted()
    expect(JSON.parse(row("c").rules!)).toEqual({ in: ["tree:self"], out: ["tree:self"] })
    expect(again.log({ scope: true }).filter((entry) => entry.event === "scope_migrate").length).toBe(4)
  })
})

describe("the check", () => {
  test("cross-fleet: anything set confines both directions to the fleet, a leaving selector reaches out, nothing set stays open", () => {
    const { core, claim, as, send } = setup()
    claim("a", 1)
    claim("b", 2)
    claim("x", 3)
    expect(send("a", "x")).toBeUndefined()
    core.rulesSet(as("a"), { in: ["tree:self"] })
    expect(send("a", "x")).toBe("not_found")
    expect(send("x", "a")).toBe("not_found")
    core.rulesSet(as("a"), { out: ["handle:x"] })
    expect(send("a", "x")).toBe("not_found")
    core.rulesSet(as("a"), { out: ["fleet:x"] })
    expect(send("a", "x")).toBeUndefined()
    core.rulesSet(as("a"), { out: ["*"] })
    expect(send("a", "b")).toBeUndefined()
    expect(send("b", "x")).toBeUndefined()
    expect(send("a", "me/")).toBeUndefined()
    expect(send("x", "machine:laptop")).toBe("not_found")
  })

  test("own rules and a self-made group never take an endpoint past a fleet boundary its caps keep it in", () => {
    const { core, claim, as, send } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("other", 9)
    core.rulesSet(as("main"), { endpoint: "w", out: ["tree:parent", "harness:codex"] })
    expect(send("w", "other")).toBe("not_found")
    core.rulesSet(as("w"), { out: ["*"] })
    expect(send("w", "other")).toBe("not_found")
    core.group(as("w"), { action: "create", name: "esc", rules: ["*"] })
    core.group(as("w"), { action: "add", name: "esc" })
    expect(send("w", "other")).toBe("not_found")
    expect(send("w", "main")).toBeUndefined()
    claim("c", 3, [2, 1])
    core.rulesSet(as("c"), { out: ["*"] })
    expect(send("c", "other")).toBe("not_found")
    core.rulesWiden(as("main"), { endpoint: "w", out: ["fleet:other"] })
    expect(send("w", "other")).toBeUndefined()
    expect(send("c", "other")).toBeUndefined()
  })

  test("a thread member replies to a message in it it did not get as to an ordinary send: in scope it goes, out of scope it is refused; a non-member is not_found", () => {
    const { core, claim, as, ids, send } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("v", 4, [1])
    claim("w", 3, [2, 1])
    claim("x", 5, [1])
    core.rulesSet(as("main"), { in: ["tree:children"] })
    const start = core.send(ids.main!, { to: ["w", "v"], body: "kickoff", kind: "request" })
    const toOrch = core.send(ids.main!, { to: "orch", body: "orch only", kind: "request", thread: start.thread })
    const subjects = (from: string, reply_to: string) => code(() => core.judgeSubjects(ids[from]!, { to: "main", kind: "reply", reply_to }))
    expect(core.send(ids.v!, { to: "main", body: "seen", kind: "reply", reply_to: toOrch.id }).thread).toBe(start.thread)
    expect(subjects("v", toOrch.id)).toBeUndefined()
    expect(send("w", "main", { kind: "reply", reply_to: toOrch.id })).toBe("not_found")
    expect(subjects("w", toOrch.id)).toBe("not_found")
    expect(send("w", "main", { kind: "reply", reply_to: start.id })).toBeUndefined()
    expect(subjects("w", start.id)).toBeUndefined()
    expect(send("x", "main", { kind: "reply", reply_to: toOrch.id })).toBe("not_found")
    expect(subjects("x", toOrch.id)).toBe("not_found")
    expect(send("x", "main")).toBeUndefined()
  })

  test("a reply to a message the replier got passes the replier's out and the recipient's in, every time; a plain message does not", () => {
    const { core, claim, as, ids, send } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("w", 3, [2, 1])
    core.rulesSet(as("main"), { in: ["tree:children"] })
    expect(send("w", "main")).toBe("not_found")
    const asked = core.send(ids.main!, { to: "w", body: "status?", kind: "request" })
    expect(send("w", "main", { kind: "reply", reply_to: asked.id })).toBeUndefined()
    expect(send("w", "main", { kind: "reply", reply_to: asked.id })).toBeUndefined()
    expect(send("w", "main", { kind: "message", reply_to: asked.id })).toBe("not_found")
    const again = core.send(ids.main!, { to: "w", body: "and now?", kind: "request" })
    core.rulesSet(as("w"), { out: [] })
    expect(send("w", "main", { kind: "reply", reply_to: again.id })).toBeUndefined()
  })

  test("clipping follows the chain two levels up, shrinks live when a widener is narrowed and lapses when it is released", () => {
    const { core, db, claim, as, ids, send } = setup()
    claim("r", 1)
    claim("c", 2, [1])
    claim("g", 3, [2, 1])
    claim("other", 9)
    core.rulesSet(as("r"), { out: ["tree:self", "fleet:other"] })
    core.rulesSet(as("r"), { endpoint: "c", out: ["tree:self"] })
    core.rulesSet(as("c"), { endpoint: "g", out: ["tree:self"] })
    expect(code(() => core.rulesWiden(as("c"), { endpoint: "g", out: ["fleet:other"] }))).toBe("scope_refused")
    expect(core.rulesWiden(as("r"), { endpoint: "c", out: ["fleet:other"] }).added).toEqual(["fleet:other"])
    expect(core.rulesWiden(as("c"), { endpoint: "g", out: ["fleet:other"] }).added).toEqual(["fleet:other"])
    expect(send("g", "other")).toBeUndefined()
    core.rulesSet(as("r"), { out: ["tree:self"] })
    expect(send("c", "other")).toBe("not_found")
    expect(send("g", "other")).toBe("not_found")
    core.rulesSet(as("r"), { out: ["tree:self", "fleet:other"] })
    expect(send("g", "other")).toBeUndefined()
    db.run("UPDATE endpoints SET handle = '_gone_' || id WHERE id = ?", [ids.c!])
    expect(send("g", "other")).toBe("not_found")
  })

  test("a widening by the human is never clipped and never lapses", () => {
    const { core, db, claim, as, ids, send } = setup()
    claim("r", 1)
    claim("c", 2, [1])
    claim("other", 9)
    core.rulesSet(as("r"), { out: ["tree:self"] })
    core.rulesSet(as("r"), { endpoint: "c", out: ["tree:self"] })
    expect(core.rulesWiden(HUMAN, { endpoint: "c", out: ["fleet:other"] })).toEqual({ added: ["fleet:other"], clipped: [] })
    db.run("UPDATE endpoints SET handle = '_gone_' || id WHERE id = ?", [ids.r!])
    expect(send("c", "other")).toBeUndefined()
    expect(core.scopeView(HUMAN, "c").caps[0]!.sels).toEqual([{ sel: "tree:self" }, { sel: "fleet:other", via: "human" }])
    expect(code(() => core.rulesWiden({ kind: "human", tty: false }, { endpoint: "c", out: ["*"] }))).toBe("scope_refused")
  })

  test("authority: caps set above an endpoint cannot be lifted by it, by a sibling, or by a plain shell", () => {
    const { core, claim, as, send } = setup()
    claim("r", 1)
    claim("c", 2, [1])
    claim("d", 3, [1])
    const capped = core.rulesSet(as("r"), { endpoint: "c", out: ["tree:parent"] })
    const cap = capped.caps[0]!.id
    expect(send("c", "d")).toBe("not_found")
    expect(code(() => core.rulesLift(as("c"), { endpoint: "c", cap }))).toBe("scope_refused")
    expect(code(() => core.rulesLift(as("d"), { endpoint: "c", cap }))).toBe("scope_refused")
    expect(code(() => core.rulesLift(as("r", "lineage"), { endpoint: "c", cap }))).toBe("scope_refused")
    expect(code(() => core.rulesSet(as("r", "lineage"), { endpoint: "c", out: ["tree:parent", "tree:siblings"] }))).toBe("scope_refused")
    expect(core.rulesSet(as("r", "lineage"), { endpoint: "c", out: [] }).caps[0]!.sels).toEqual([])
    expect(core.rulesLift(as("r"), { endpoint: "c", cap }).caps).toEqual([])
    expect(send("c", "d")).toBeUndefined()
    expect(code(() => core.rulesLift(as("r"), { endpoint: "c", cap }))).toBe("not_found")
  })

  test("a refused send names the refusing rule to an admin of the target's tree; an ancestor is never refused; anyone else gets not_found", () => {
    const { core, claim, as, ids } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("adm", 3)
    claim("x", 4)
    core.rulesSet(as("main"), { endpoint: "w", in: [], out: [] })
    core.admin(HUMAN, { action: "grant", subject: "adm", tree: "main" })
    const refusal = (from: string) => {
      try {
        core.send(ids[from]!, { to: "w", body: "hi" })
      } catch (error) {
        if (error instanceof RelayError) return [error.code, error.message]
        throw error
      }
      return undefined
    }
    expect(refusal("main")).toBeUndefined()
    expect(refusal("adm")).toEqual(["scope_refused", "me/main (w's parent) limits who may message w to nobody; widen with swarm rules widen w --in ep:adm"])
    expect(refusal("x")).toEqual(["not_found", "no endpoint w that you can reach (swarm peers lists who you may message)"])
    expect(
      core
        .log()
        .filter((row) => row.event === "scope_refused")
        .map((row) => row.detail.from),
    ).toEqual(["me/adm", "me/x"])
  })

  test("scope audit rows name addresses, and log --scope keeps only them", () => {
    const { core, claim, as } = setup()
    claim("r", 1)
    claim("c", 2, [1])
    core.rulesSet(as("r"), { endpoint: "c", in: ["tree:parent"] })
    core.rulesWiden(as("r"), { endpoint: "c", in: ["tree:siblings"] })
    const rows = core.log({ scope: true })
    expect(rows.every((row) => row.event.startsWith("scope_"))).toBe(true)
    expect(rows.map((row) => row.event)).toEqual(["scope_place", "scope_narrow", "scope_widen"])
    expect(rows[2]!.detail).toMatchObject({ by: "me/r", auth: "session", via: "me/r", target: "me/c", dir: "in", added: ["tree:siblings"], clipped: [] })
    expect(core.log().some((row) => row.event === "claim")).toBe(true)
  })

  test("minting a grant writes a scope row without the token; a widening records its caps before and after", () => {
    const { core, claim, as } = setup()
    claim("r", 1)
    claim("c", 2, [1])
    const { token } = core.grant(as("r"), { name: "kid", out: ["tree:parent"] })
    const cap = core.rulesSet(as("r"), { endpoint: "c", in: ["tree:parent"] }).caps[0]!.id
    core.rulesWiden(as("r"), { endpoint: "c", in: ["tree:siblings"] })
    const rows = core.log({ scope: true })
    expect(rows.find((row) => row.event === "scope_grant")!.detail).toMatchObject({
      by: "me/r",
      auth: "session",
      target: "me/r",
      name: "kid",
      caps: [{ dir: "out", sels: ["tree:parent"] }],
    })
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(rows.find((row) => row.event === "scope_widen")!.detail).toMatchObject({
      before: { [cap]: ["tree:parent"] },
      after: { [cap]: ["tree:parent", "tree:siblings"] },
    })
  })
})

/** main, under it leads la3 and lb3 (their parent and their own subtree), under each a worker wa3 and wb3 capped to tree:parent; x a root of its own */
function leads() {
  const t = setup()
  t.claim("main", 1)
  t.claim("la3", 2, [1])
  t.claim("lb3", 3, [1])
  t.claim("wa3", 4, [2, 1])
  t.claim("wb3", 5, [3, 1])
  t.claim("x", 9)
  for (const lead of ["la3", "lb3"])
    t.core.rulesSet(t.as("main"), { endpoint: lead, in: ["tree:parent", "tree:descendants"], out: ["tree:parent", "tree:descendants"] })
  t.core.rulesSet(t.as("la3"), { endpoint: "wa3", scope: "parent" })
  t.core.rulesSet(t.as("lb3"), { endpoint: "wb3", scope: "parent" })
  return t
}

describe("downward, replies, the own shell and ep:", () => {
  test("an ancestor sees and reaches its descendants whatever their caps; lateral and upward traffic stays capped, and the policy still applies", () => {
    const { core, ids, send } = leads()
    expect(send("main", "wa3")).toBeUndefined()
    expect(send("main", "wb3")).toBeUndefined()
    expect(send("la3", "wa3")).toBeUndefined()
    expect(core.why(HUMAN, "main", "wb3")).toEqual({ allowed: true, reasons: ["me/main is an ancestor of me/wb3: scopes never stop it"] })
    expect(core.list({ viewer: ids.main }).map((view) => view.address)).toEqual(expect.arrayContaining(["me/wa3", "me/wb3"]))
    expect(core.peers(ids.main!).map((peer) => peer.address)).toEqual(expect.arrayContaining(["me/wa3", "me/wb3"]))
    expect(core.peers(ids.la3!).map((peer) => peer.address)).not.toContain("me/wb3")
    expect(send("wb3", "main")).toBe("not_found")
    expect(send("wa3", "lb3")).toBe("not_found")
    expect(send("la3", "lb3")).toBe("not_found")
    expect(send("la3", "wb3")).toBe("not_found")
    expect(send("x", "wa3")).toBe("not_found")
    core.setPolicy(parsePolicy({ rules: [{ match: "handle:wa3", accept_from: ["handle:la3"] }] }))
    expect(send("main", "wa3")).toBe("policy_refused")
  })

  test("a recipient replies to the sender in its thread whatever the caps, any number of times; never a new message, another address or a message it did not get", () => {
    const { core, ids, send } = leads()
    const asked = core.send(ids.main!, { to: "wb3", body: "status?", kind: "request" })
    const reply = { kind: "reply", reply_to: asked.id }
    expect(send("wb3", "main", reply)).toBeUndefined()
    expect(send("wb3", "main", { ...reply, thread: "elsewhere" })).toBeUndefined()
    expect(core.inbox(ids.main!).map((m) => m.thread)).toEqual([asked.thread, asked.thread])
    core.rulesSet(HUMAN, { endpoint: "wb3", out: [] })
    expect(send("wb3", "main", reply)).toBeUndefined()
    expect(send("wb3", "main", { kind: "message", reply_to: asked.id })).toBe("not_found")
    expect(send("wb3", "main")).toBe("not_found")
    expect(send("wb3", "x", reply)).toBe("not_found")
    expect(send("wa3", "main", reply)).toBe("not_found")
  })

  test("an agent's own harness shell widens, lifts and runs groups like its session, clipped to its reach; a plain lineage still only narrows", () => {
    const { core, as, send } = leads()
    expect(code(() => core.rulesWiden(as("la3", "lineage"), { endpoint: "wa3", out: ["tree:root"] }))).toBe("scope_refused")
    expect(core.rulesWiden(as("la3", "self"), { endpoint: "wa3", out: ["tree:root"] }).added).toEqual(["tree:root"])
    expect(send("wa3", "main")).toBeUndefined()
    expect(send("wb3", "main")).toBe("not_found")
    expect(code(() => core.rulesWiden(as("la3", "self"), { endpoint: "wa3", out: ["ep:lb3"] }))).toBe("scope_refused")
    expect(send("wa3", "lb3")).toBe("not_found")
    const cap = core.scopeView(as("la3", "self"), "wa3").caps[0]!.id
    expect(code(() => core.rulesLift(as("la3", "lineage"), { endpoint: "wa3", cap }))).toBe("scope_refused")
    expect(core.rulesLift(as("la3", "self"), { endpoint: "wa3", cap }).caps.map((c) => c.id)).not.toContain(cap)
    core.group(as("la3", "self"), { action: "create", name: "crew" })
    expect(code(() => core.group(as("la3", "lineage"), { action: "add", name: "crew", endpoint: "wa3" }))).toBe("scope_refused")
    core.group(as("la3", "self"), { action: "add", name: "crew", endpoint: "wa3" })
    expect(core.scopeView(HUMAN, "wa3").groups).toEqual(["crew"])
    expect(
      core
        .log({ scope: true })
        .filter((row) => row.event === "scope_widen")
        .map((row) => [row.detail.auth, row.detail.group ?? null]),
    ).toEqual([
      ["self", null],
      ["self", "crew"],
      ["self", "crew"],
    ])
  })

  test("ep:<handle> admits that one agent, in a fleet of its own too; tree:root and tree:ancestors are rule selectors", () => {
    const { core, as, send } = leads()
    expect(validSelector("ep:lb3")).toBe(true)
    expect(validSelector("ep:lb*")).toBe(false)
    expect(validSelector("ep:lb3", { absolute: true })).toBe(true)
    expect(core.rulesWiden(as("main"), { endpoint: "wa3", out: ["ep:lb3"] }).mirrored).toEqual([{ endpoint: "me/lb3", dir: "in", added: ["ep:wa3"] }])
    expect(send("wa3", "lb3")).toBeUndefined()
    expect(send("wb3", "la3")).toBe("not_found")
    expect(send("wa3", "la3")).toBeUndefined()
    core.rulesSet(as("x"), { in: ["ep:wa3"] })
    core.rulesWiden(as("main"), { endpoint: "wa3", out: ["ep:x"] })
    expect(send("wa3", "x")).toBeUndefined()
    expect(send("wb3", "x")).toBe("not_found")
    expect(core.rulesSet(as("wb3"), { out: ["tree:root", "tree:ancestors", "tree:ancestors:2"] }).rules.out).toEqual([
      "tree:root",
      "tree:ancestors",
      "tree:ancestors:2",
    ])
    expect(send("wb3", "main")).toBe("not_found")
    core.rulesWiden(as("main"), { endpoint: "wb3", out: ["tree:root"] })
    expect(send("wb3", "main")).toBeUndefined()
  })

  test("a send to a known offline endpoint queues and is delivered when it is back; an unknown handle is not_found", () => {
    const { core, db, ids, send } = leads()
    db.run("UPDATE endpoints SET connections = 0, hook_seen = NULL WHERE id = ?", [ids.wb3!])
    expect(core.list({ all: true }).find((view) => view.address === "me/wb3")!.presence).toBe("offline")
    expect(core.send(ids.main!, { to: "wb3", body: "while you were out" }).deliveries).toEqual([expect.objectContaining({ address: "me/wb3", queued: true })])
    expect(send("main", "nobody")).toBe("not_found")
    expect(core.inbox(ids.wb3!).map((m) => m.body.text)).toEqual(["while you were out"])
  })
})

describe("discovery", () => {
  test("list, peers, snapshot and activity show an agent only what it may message", () => {
    const { core, claim, as, ids } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("x", 3)
    core.rulesSet(as("w"), { scope: "parent" })
    core.event(ids.x!, { kind: "tool", tool: "Bash" })
    core.event(ids.main!, { kind: "tool", tool: "Read" })
    expect(core.list({ viewer: ids.w }).map((view) => view.address)).toEqual(["me/", "me/main", "me/w"])
    expect(core.list({}).length).toBe(4)
    expect(core.peers(ids.w!).map((peer) => [peer.address, peer.reason.includes("tree:parent") || peer.reason.includes("human")])).toEqual([
      ["me/", true],
      ["me/main", true],
    ])
    const snapshot = core.snapshot({ viewer: ids.w })
    expect(snapshot.endpoints.map((view) => view.address)).not.toContain("me/x")
    expect(snapshot.activity.map((row) => row.endpoint)).toEqual(["me/main"])
    expect(core.list({ viewer: ids.w })[1]).toMatchObject({ parent: null, depth: 0, scope: "open" })
    expect(core.list({ viewer: ids.w })[2]).toMatchObject({ parent: "me/main", depth: 1, scope: "parent" })
  })

  test("reasons say who set a limit and how to widen it, never a cap id, and peers say who each peer is to you", () => {
    const { core, claim, as, ids, send } = setup()
    claim("main", 1)
    claim("lead", 2, [1])
    claim("wa", 3, [2, 1])
    claim("wb", 4, [2, 1])
    claim("wc", 5, [2, 1])
    claim("wd", 6, [2, 1])
    core.rulesSet(as("lead"), { endpoint: "wa", out: ["tree:parent"] })
    expect(core.why(HUMAN, "wa", "wb")).toEqual({
      allowed: false,
      reasons: ["me/lead (wa's parent) limits wa's messages to tree:parent; widen with swarm rules widen wa --out ep:wb"],
    })
    expect(core.why(as("lead"), "wa", "wb").reasons).toEqual(["you limit wa's messages to tree:parent; widen with swarm rules widen wa --out ep:wb"])
    expect(core.why(as("wa"), "wa", "lead")).toMatchObject({ allowed: true })
    expect(core.why(as("wa"), "wa", "lead").reasons.join("; ")).not.toContain("cap_")
    expect(core.peers(ids.wa!).map((peer) => [peer.address, peer.reason])).toEqual([
      ["me/", "the human is always reachable"],
      ["me/lead", "your parent (tree:parent)"],
    ])
    expect(core.peers(ids.wb!).find((peer) => peer.address === "me/wc")!.reason).toBe("your sibling (open)")
    core.rulesSet(as("wa"), { in: ["tree:parent"] })
    expect(core.why(HUMAN, "wb", "wa").reasons.at(-1)).toBe(
      "wa's own rules limit who may message wa to tree:parent; wa widens them with swarm rules set --in tree:parent,ep:wb",
    )
    expect(core.why(as("lead"), "wb", "wa").reasons.at(-1)).toBe(
      "wa's own rules limit who may message wa to tree:parent; wa widens them with swarm rules set --in tree:parent,ep:wb",
    )
    core.rulesSet(HUMAN, { endpoint: "wb", out: [] })
    expect(core.why(HUMAN, "wb", "wc").reasons).toEqual(["the human limits wb's messages to nobody; widen with swarm rules widen wb --out ep:wc"])
    core.group(as("lead"), { action: "create", name: "crew", rules: ["group:self"] })
    core.group(as("lead"), { action: "add", name: "crew", endpoint: "wc" })
    expect(core.why(HUMAN, "wc", "wa").reasons[0]).toBe(
      "group crew's rules (set by me/lead (wc's parent)) limit wc's messages to group:crew; widen with swarm rules widen wc --out ep:wa",
    )
    core.rulesSet(as("wd"), { out: ["tree:parent"] })
    const refusals = () =>
      core
        .log({ scope: true })
        .filter((row) => row.event === "scope_refused")
        .map((row) => [row.detail.dir, row.detail.reason])
    expect(send("wa", "wb")).toBe("not_found")
    expect(send("wd", "wb")).toBe("not_found")
    expect(refusals().slice(-2)).toEqual([
      ["out", "me/lead (your parent) limits your messages to tree:parent; widen with swarm rules widen wa --out ep:wb"],
      ["out", "your own rules limit your messages to tree:parent; widen them with swarm rules set --out tree:parent,ep:wb"],
    ])
  })

  test("a hidden endpoint and one that does not exist are refused in the same words", () => {
    const { core, claim, as, ids } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("x", 3)
    core.rulesSet(as("w"), { scope: "parent" })
    const message = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return [(error as RelayError).code, (error as RelayError).message]
      }
      return undefined
    }
    const unreachable = (address: string) => ["not_found", `no endpoint ${address} that you can reach (swarm peers lists who you may message)`]
    expect(message(() => core.send(ids.w!, { to: "x", body: "hi" }))).toEqual(unreachable("x"))
    expect(message(() => core.send(ids.w!, { to: "nobody", body: "hi" }))).toEqual(unreachable("nobody"))
    expect(message(() => core.why(as("w"), "w", "x"))).toEqual(unreachable("x"))
    expect(message(() => core.why(as("w"), "w", "nobody"))).toEqual(unreachable("nobody"))
    expect(message(() => core.rulesWiden(as("w"), { endpoint: "x", out: ["*"] }))).toEqual(unreachable("x"))
    expect(message(() => core.rulesWiden(as("w"), { endpoint: "nobody", out: ["*"] }))).toEqual(unreachable("nobody"))
    expect(message(() => core.scopeView(as("w"), "x"))).toEqual(unreachable("x"))
    expect(message(() => core.scopeView(as("w"), "nobody"))).toEqual(unreachable("nobody"))
  })

  test("a bare handle in a rule stands for ep:<handle>; anything else that is no selector is still refused", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("x", 3)
    expect(core.rulesSet(as("w"), { out: ["x", "tree:parent"] }).rules.out).toEqual(["ep:x", "tree:parent"])
    expect(core.rulesSet(as("main"), { endpoint: "w", in: ["x"] }).caps.find((cap) => cap.dir === "in")!.sels).toEqual([{ sel: "ep:x" }])
    expect(core.rulesWiden(as("main"), { endpoint: "w", in: ["main"] }).added).toEqual(["ep:main"])
    expect(code(() => core.rulesSet(as("w"), { out: ["Not A Handle"] }))).toBe("invalid_params")
    expect(code(() => core.rulesSet(as("w"), { out: ["bogus:x"] }))).toBe("invalid_params")
  })

  test("a worker spawned with a preset under a limited spawner shows that preset, its inherited limit aside", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("lead", 2, [1], { grant: core.grant(as("main"), { scope: "parent" }).token })
    claim("w", 3, [2, 1], { grant: core.grant(as("lead"), { scope: "parent" }).token })
    expect(core.scopeView(HUMAN, "w").caps.map((cap) => cap.by)).toContain("inherited from me/lead")
    expect(core.list({}).find((view) => view.address === "me/w")).toMatchObject({ scope: "parent" })
    expect(core.scopeView(HUMAN, "w").preset).toBe("parent")
  })

  test("why: an agent asks about itself and what it sees, else not_found; the human asks anything", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("x", 3)
    core.rulesSet(as("w"), { scope: "parent" })
    expect(core.why(as("w"), "w", "main")).toMatchObject({ allowed: true })
    expect(code(() => core.why(as("w"), "w", "x"))).toBe("not_found")
    expect(code(() => core.why(as("x"), "main", "w"))).toBe("not_found")
    const why = core.why(HUMAN, "x", "w")
    expect(why.allowed).toBe(false)
    expect(why.reasons.at(-1)).toBe("w's own rules limit who may message w to tree:parent; w widens them with swarm rules set --in tree:parent,ep:x")
  })

  test("why: a parent asks about a pair of its children, an admin about an endpoint it cannot see; others get not_found", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("v", 3, [1])
    claim("adm", 4)
    claim("x", 5)
    core.rulesSet(as("main"), { endpoint: "w", in: [], out: [] })
    core.admin(HUMAN, { action: "grant", subject: "adm", tree: "main" })
    expect(core.why(as("main"), "w", "v")).toMatchObject({
      allowed: false,
      reasons: ["you limit w's messages to nobody; widen with swarm rules widen w --out ep:v"],
    })
    expect(core.why(as("main"), "v", "x")).toMatchObject({ allowed: true })
    const why = core.why(as("adm"), "adm", "w")
    expect(why.allowed).toBe(false)
    expect(why.reasons.at(-1)).toBe("me/main (w's parent) limits who may message w to nobody; widen with swarm rules widen w --in ep:adm")
    expect(code(() => core.why(as("x"), "x", "w"))).toBe("not_found")
    expect(code(() => core.why(as("x"), "main", "w"))).toBe("not_found")
    expect(code(() => core.why(as("v"), "w", "x"))).toBe("not_found")
  })

  test("the envelope carries how the recipient sees the sender", () => {
    const { core, claim, ids } = setup()
    claim("r", 1)
    claim("c", 2, [1])
    claim("d", 3, [1])
    claim("g", 4, [2, 1])
    claim("x", 5)
    const rel = (from: string, to: string) => {
      core.send(ids[from]!, { to, body: "hi" })
      const messages = core.inbox(ids[to]!)
      core.ack(
        ids[to]!,
        messages.map((m) => m.seq!),
      )
      return messages.at(-1)!.from.rel
    }
    expect([rel("r", "c"), rel("c", "r"), rel("r", "g"), rel("g", "r"), rel("c", "d"), rel("g", "d"), rel("x", "r")]).toEqual([
      "parent",
      "child",
      "ancestor",
      "descendant",
      "sibling",
      "tree",
      "fleet:x",
    ])
    core.send(core.claimHuman(true).id, { to: "r", body: "hi" }, { tty: true })
    expect(core.inbox(ids.r!).at(-1)!.from.rel).toBe("human")
    core.send(core.claimHuman(false).id, { to: "r", body: "hi" }, { tty: false })
    expect(core.inbox(ids.r!).at(-1)!.from.rel).toBe("human, no terminal")
  })
})

describe("placement", () => {
  test("lineage places a claim under the nearest endpoint; bare and env keys never place", () => {
    const { core, claim } = setup()
    claim("r", 1)
    claim("c", 2, [1])
    expect(claim("g", 3, [99, 2, 1]).parent).toBe("me/c")
    expect(core.claim({ handle: "bare", harness: "codex", lineage: ["pid:2", "env:abc"] }).endpoint.parent).toBeNull()
    expect(claim("deep", 4, [3, 2, 1]).depth).toBe(3)
    expect(
      core
        .log({ scope: true })
        .filter((row) => row.event === "scope_place")
        .map((row) => row.detail.parent),
    ).toEqual(["me/r", "me/c", "me/g"])
  })

  test("a claim deeper than the depth limit is refused and spends no grant", () => {
    const { core, claim, as, db } = setup()
    claim("e0", 1000)
    for (let i = 1; i <= LIMITS.depthMax; i++) claim(`e${i}`, 1000 + i, [999 + i])
    const token = core.grant(as(`e${LIMITS.depthMax}`), { scope: "parent" }).token
    expect(code(() => claim("deep", 2000, [], { grant: token }))).toBe("scope_refused")
    expect(code(() => claim("plain", 2001, [1000 + LIMITS.depthMax]))).toBe("scope_refused")
    expect(db.query("SELECT used_by FROM grants").all()).toEqual([{ used_by: null }])
    expect(core.list({ all: true }).map((e) => e.address)).not.toContain("me/deep")
  })

  test("several endpoints on one process key: the shallowest wins", () => {
    const { core, claim } = setup()
    claim("main", 1)
    const lane = core.claim({ handle: "lane", harness: "cli", process: key(1), lineage: [key(1)] }).endpoint
    expect(lane.parent).toBe("me/main")
    expect(claim("worker", 2, [1]).parent).toBe("me/main")
  })

  test("grants place at or below lineage, never above, once, and detached", () => {
    const { core, claim, as, db } = setup()
    claim("main", 1)
    claim("lane", 2, [1])
    const below = core.grant(as("main"), { under: "lane", scope: "tree" }).token
    expect(claim("w1", 3, [1], { grant: below })).toMatchObject({ parent: "me/lane", scope: "tree" })
    expect(core.scopeView(HUMAN, "w1").caps.map((cap) => cap.by)).toEqual(["me/main", "me/main"])
    expect(code(() => claim("w2", 4, [], { grant: below }))).toBe("unauthorized")
    expect(claim("w4", 7, [1], { grant: below })).toMatchObject({ parent: "me/main", scope: "open" })
    const above = core.grant(as("main"), {}).token
    expect(code(() => claim("w3", 5, [2, 1], { grant: above }))).toBe("unauthorized")
    expect(core.list().map((row) => row.address)).not.toContain("me/w2")
    expect(
      core
        .log({ scope: true })
        .filter((row) => row.event === "scope_refused")
        .map((row) => row.detail.reason),
    ).toEqual(["grant used", "grant above lineage"])
    const detached = core.grant(as("lane"), { name: "bg" })
    expect(detached.env).toEqual({ SCP_GRANT: detached.token, SCP_NAME: "bg" })
    expect(claim("bg", 6, [], { grant: detached.token }).parent).toBe("me/lane")
    expect(JSON.stringify(db.query("SELECT * FROM grants").all())).not.toContain(detached.token)
    expect(code(() => core.grant(as("lane"), { under: "main" }))).toBe("not_found")
    expect(code(() => core.grant(as("lane"), { ttl_s: LIMITS.grantTtlS + 1 }))).toBe("invalid_params")
  })

  test("verify_lineage true: lineage alone places nothing, grants still do", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    const token = core.grant(as("main"), {}).token
    core.setPolicy({ rules: [], defaults: { verify_lineage: true } })
    expect(claim("a", 2, [1]).parent).toBeNull()
    expect(claim("b", 3, [1], { grant: token }).parent).toBe("me/main")
  })

  test("an offline endpoint is taken over only from its own tree; a claim from another tree gets -2", () => {
    const { core, claim, ids } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("other", 9)
    core.disconnect(ids.w!)
    expect(claim("w", 3, [9]).address).toBe("me/w-2")
    expect(core.claim({ handle: "w", harness: "codex" }).endpoint.address).toBe("me/w-3")
    expect(claim("w", 4, [1]).id).toBe(ids.w!)
  })

  test("an offline endpoint is taken over only from its own parent's place, never from at or below it", () => {
    const { core, claim, ids } = setup()
    claim("main", 10)
    claim("orch-a", 20, [10])
    claim("orch-b", 30, [10])
    claim("a1", 40, [20, 10])
    claim("a2", 45, [20, 10])
    const { main, a1, a2 } = ids
    const orchB = ids["orch-b"]
    for (const id of [main, orchB, a2, a1]) core.disconnect(id!)
    /** a claim from a process `shell` under a1 (pid 40), with no process key of its own when `process` is false */
    const fromA1 = (handle: string, shell: number, process = true) =>
      core.claim({ handle, harness: "codex", ...(process ? { process: key(shell) } : {}), lineage: [shell, 40, 20, 10].map(key) }).endpoint
    expect(fromA1("main", 41).address).toBe("me/main-2")
    expect(fromA1("orch-b", 42).address).toBe("me/orch-b-2")
    expect(fromA1("a2", 43).address).toBe("me/a2-2")
    expect(fromA1("a1", 44, false).address).toBe("me/a1-2")
    expect(claim("a2", 46, [20, 10]).id).toBe(a2!)
    expect(claim("orch-b", 31, [10]).id).toBe(orchB!)
    expect(claim("main", 11).id).toBe(main!)
    expect(core.claim({ handle: "a1", harness: "codex", process: key(40), lineage: [40, 20, 10].map(key) }).endpoint.id).toBe(a1!)
  })

  test("a session's hooks keep their unread mail when the shim's handle belongs to an endpoint it may not take over", () => {
    const { core, claim, ids } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("x", 9)
    core.disconnect(ids.w!)
    const from = { harness: "codex", session: "pid:77", process: key(77), lineage: [77, 9].map(key) }
    const hook = core.claim({ handle: "hooks", ...from }, { transient: true }).endpoint
    core.send(ids.x!, { to: "hooks", body: "for the hooks" })
    const shim = core.claim({ handle: "w", ...from }).endpoint
    expect(shim.id).toBe(hook.id)
    expect(core.inbox(ids.w!)).toEqual([])
    expect(core.inbox(hook.id).map((m) => m.body.text)).toEqual(["for the hooks"])
  })

  test("child_default caps a placed child that got no grant caps", () => {
    const { core, claim, as } = setup()
    core.setPolicy(parsePolicy({ rules: [], defaults: { child_default: "tree" } }))
    claim("main", 1)
    expect(claim("w", 2, [1]).scope).toBe("tree")
    expect(core.scopeView(HUMAN, "w").caps.every((cap) => cap.by === "policy")).toBe(true)
    expect(claim("root2", 3).scope).toBe("open")
    expect(claim("g", 4, [1], { grant: core.grant(as("main"), { scope: "parent" }).token }).scope).toBe("parent")
  })
})

describe("groups", () => {
  test("create, add and remove need authority; a member cannot leave a ruled group", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("o", 2, [1])
    claim("w", 3, [2, 1])
    claim("v", 4, [2, 1])
    claim("x", 5)
    core.group(as("o"), { action: "create", name: "team", rules: ["group:self", "tree:parent"] })
    expect(code(() => core.group(as("o"), { action: "create", name: "team" }))).toBe("invalid_params")
    expect(code(() => core.group(as("o"), { action: "create", name: "self" }))).toBe("invalid_params")
    expect(code(() => core.group(as("x"), { action: "add", name: "team" }))).toBe("not_found")
    expect(code(() => core.group(as("w"), { action: "add", name: "team", endpoint: "v" }))).toBe("scope_refused")
    core.group(as("o"), { action: "add", name: "team", endpoint: "w" })
    core.group(as("v", "lineage"), { action: "add", name: "team" })
    expect((core.group(as("w"), { action: "show", name: "team" }) as { members: string[] }).members).toEqual(["me/v", "me/w"])
    expect(code(() => core.group(as("w"), { action: "remove", name: "team" }))).toBe("scope_refused")
    expect(code(() => core.group(as("o", "lineage"), { action: "remove", name: "team", endpoint: "w" }))).toBe("scope_refused")
    expect(core.group(as("main"), { action: "remove", name: "team", endpoint: "w" })).toEqual({ name: "team", endpoint: "me/w", member: false })
    expect((core.group(HUMAN, { action: "ls" }) as { name: string; members: number }[]).map((g) => [g.name, g.members])).toEqual([["team", 1]])
    expect(claim("y", 6, [2, 1], { groups: ["team"] }) && core.scopeView(HUMAN, "y").groups).toEqual(["team"])
    expect(claim("z", 7, [], { groups: ["team"] }) && core.scopeView(HUMAN, "z").groups).toEqual([])
  })

  test("a plain shell creates a group and adds itself, but adding another endpoint needs a session", () => {
    const { core, claim, as } = setup()
    claim("o", 1)
    claim("w", 2, [1])
    claim("v", 3, [1])
    core.group(as("o", "lineage"), { action: "create", name: "team" })
    expect(code(() => core.group(as("o", "lineage"), { action: "add", name: "team", endpoint: "w" }))).toBe("scope_refused")
    expect(
      core
        .log()
        .filter((row) => row.event === "scope_refused")
        .at(-1)!.detail.reason,
    ).toBe("narrow only")
    core.group(as("o", "lineage"), { action: "add", name: "team" })
    core.group(as("v", "lineage"), { action: "add", name: "team", endpoint: "v" })
    core.group(as("o"), { action: "add", name: "team", endpoint: "w" })
    expect((core.group(as("o"), { action: "show", name: "team" }) as { members: string[] }).members).toEqual(["me/o", "me/v", "me/w"])
  })

  test("a steward removes a member it cannot message and shows it; others still cannot find it", () => {
    const { core, claim, as } = setup()
    claim("orch", 1)
    claim("x", 2)
    claim("y", 3)
    core.rulesSet(as("x"), { in: [] })
    core.rulesSet(as("y"), { scope: "none" })
    core.group(as("orch"), { action: "create", name: "crew" })
    for (const m of ["x", "y"]) core.group(HUMAN, { action: "add", name: "crew", endpoint: m })
    const members = (actor: ScopeActor) => (core.group(actor, { action: "show", name: "crew" }) as { members: string[] }).members
    expect(members(as("orch"))).toEqual(["me/x", "me/y"])
    expect(members(as("y"))).toEqual(["me/y"])
    expect(code(() => core.group(as("y"), { action: "remove", name: "crew", endpoint: "x" }))).toBe("not_found")
    expect(core.group(as("orch"), { action: "remove", name: "crew", endpoint: "x" })).toEqual({ name: "crew", endpoint: "me/x", member: false })
    expect(code(() => core.group(as("orch"), { action: "remove", name: "crew", endpoint: "x" }))).toBe("not_found")
  })

  test("group:self in a group's rules is its members; loosening the rules is clipped like any widening", () => {
    const { core, claim, as, send } = setup()
    claim("o", 1)
    claim("w", 2, [1])
    claim("v", 3, [1])
    claim("u", 4, [1])
    claim("x", 5)
    core.rulesSet(as("o"), { out: ["tree:self"] })
    core.group(as("o"), { action: "create", name: "team", rules: ["group:self"] })
    core.group(as("o"), { action: "add", name: "team", endpoint: "w" })
    core.group(as("o"), { action: "add", name: "team", endpoint: "v" })
    expect(send("w", "v")).toBeUndefined()
    expect(send("w", "u")).toBe("not_found")
    expect(send("w", "o")).toBe("not_found")
    expect(send("o", "w")).toBeUndefined()
    core.group(as("o"), { action: "rules", name: "team", out: ["group:self", "tree:parent", "fleet:x"] })
    expect((core.group(as("o"), { action: "show", name: "team" }) as { rules: { out: unknown[] } }).rules.out).toEqual([
      { sel: "group:self" },
      { sel: "tree:parent", via: "me/o" },
      { sel: "fleet:x", via: "me/o" },
    ])
    expect(send("w", "o")).toBeUndefined()
    expect(send("w", "x")).toBe("not_found")
    core.group(as("o"), { action: "rules", name: "team", in: ["group:self", "tree:parent"] })
    expect(send("o", "w")).toBeUndefined()
    expect(code(() => core.group(as("w"), { action: "rules", name: "team", out: ["*"] }))).toBe("scope_refused")
  })

  test("dropping or loosening a ruled group needs authority to loosen every member", () => {
    const { core, clock, claim, as, send } = setup()
    claim("main", 1)
    claim("o", 2, [1])
    claim("w", 3, [2, 1])
    claim("x", 9)
    claim("y", 8)
    core.group(as("o"), { action: "create", name: "pals" })
    for (const name of ["team", "crew"]) {
      core.group(as("o"), { action: "create", name, rules: ["group:self", "group:pals"] })
      core.group(as("o"), { action: "add", name, endpoint: "w" })
      core.group(HUMAN, { action: "add", name, endpoint: "x" })
    }
    const refused = (fn: () => unknown) => [
      code(fn),
      core
        .log()
        .filter((row) => row.event === "scope_refused")
        .at(-1)?.detail.reason,
    ]
    const noAuthority = ["scope_refused", "no authority"]
    expect(refused(() => core.group(as("o"), { action: "drop", name: "team" }))).toEqual(noAuthority)
    expect(refused(() => core.group(as("o"), { action: "rules", name: "team", out: ["group:self", "group:pals", "*"] }))).toEqual(noAuthority)
    expect(refused(() => core.group(as("main"), { action: "drop", name: "crew" }))).toEqual(noAuthority)
    core.group(as("o"), { action: "drop", name: "pals" })
    clock.now += 1000
    core.group(as("o"), { action: "create", name: "pals" })
    core.group(as("o"), { action: "add", name: "pals" })
    expect(refused(() => core.group(as("o"), { action: "rules", name: "team", rules: ["group:self", "group:pals"] }))).toEqual(noAuthority)
    core.group(as("o"), { action: "rules", name: "team", rules: ["group:self"] })
    core.group(HUMAN, { action: "drop", name: "crew" })
    expect(send("x", "y")).toBe("not_found")
    core.group(HUMAN, { action: "rules", name: "team", out: ["group:self", "*"] })
    expect(send("x", "y")).toBeUndefined()
    core.admin(HUMAN, { action: "grant", subject: "main", tree: "x" })
    core.group(as("main"), { action: "rules", name: "team", in: ["group:self", "*"] })
    core.group(as("main"), { action: "drop", name: "team" })
    expect(core.scopeView(HUMAN, "x").groups).toEqual([])
  })

  test("an owner in its own ruled group loosens and drops it", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("o", 2, [1])
    claim("w", 3, [2, 1])
    core.group(as("o"), { action: "create", name: "team", rules: ["group:self"] })
    core.group(as("o"), { action: "add", name: "team" })
    core.group(as("o"), { action: "add", name: "team", endpoint: "w" })
    expect(code(() => core.group(as("o"), { action: "rules", name: "team", out: ["group:self", "*"] }))).toBeUndefined()
    expect(code(() => core.group(as("o"), { action: "drop", name: "team" }))).toBeUndefined()
  })

  test("fan-out reaches the members in the sender's scope, the sender excluded; tree:children reaches the children", () => {
    const { core, claim, as, ids, send } = setup()
    claim("o", 1)
    claim("w", 2, [1])
    claim("v", 3, [1])
    claim("u", 4, [1])
    core.group(as("o"), { action: "create", name: "team" })
    for (const m of ["w", "v", "u"]) core.group(as("o"), { action: "add", name: "team", endpoint: m })
    core.rulesSet(as("u"), { in: [] })
    const sent = core.send(ids.w!, { to: "group:team", body: "all" })
    expect(sent.deliveries.map((d) => d.address)).toEqual(["me/v"])
    expect(
      core
        .log()
        .filter((row) => row.event === "send")
        .at(-1)!.detail.to,
    ).toEqual(["me/v"])
    expect(send("o", "group:team")).toBe("not_found")
    expect(send("w", "group:nope")).toBe("not_found")
    expect(core.send(ids.o!, { to: "tree:children", body: "kids" }).deliveries.map((d) => d.address)).toEqual(["me/u", "me/v", "me/w"])
    expect(send("w", "tree:children")).toBe("not_found")
  })

  test("one send reaches at most the total fan-out cap across its groups", () => {
    const { core, claim, as, ids } = setup()
    claim("o", 1)
    for (let g = 0; g < 3; g++) {
      core.group(as("o"), { action: "create", name: `g${g}` })
      core.group(as("o"), { action: "add", name: `g${g}` })
      for (let i = 0; i < 30; i++) {
        claim(`w${g}-${i}`, 100 + g * 100 + i, [1])
        core.group(as("o"), { action: "add", name: `g${g}`, endpoint: `w${g}-${i}` })
      }
    }
    expect(code(() => core.send(ids.o!, { to: ["group:g0", "group:g1", "group:g2"], body: "ninety" }))).toBe("too_large")
    expect(core.send(ids.o!, { to: ["group:g0", "group:g1"], body: "sixty" }).deliveries).toHaveLength(60)
  })

  test("a group dies with its creator's tree unless pinned; pin is the human's at a terminal", () => {
    const { core, clock, claim, as, ids } = setup()
    claim("o", 1)
    claim("w", 2, [1])
    core.group(as("o"), { action: "create", name: "keep", rules: ["group:self"] })
    core.group(as("o"), { action: "create", name: "lapse", rules: ["group:self"] })
    core.group(as("o"), { action: "add", name: "lapse", endpoint: "w" })
    expect(code(() => core.group({ kind: "human", tty: false }, { action: "pin", name: "keep" }))).toBe("scope_refused")
    expect(code(() => core.group(as("o"), { action: "pin", name: "keep" }))).toBe("scope_refused")
    core.group(HUMAN, { action: "pin", name: "keep" })
    core.disconnect(ids.o!)
    core.disconnect(ids.w!)
    core.sweep()
    expect((core.group(HUMAN, { action: "ls" }) as unknown[]).length).toBe(2)
    clock.now += (LIMITS.groupIdleS + 1) * 1000
    core.sweep()
    expect((core.group(HUMAN, { action: "ls" }) as { name: string }[]).map((g) => g.name)).toEqual(["keep"])
    expect(core.scopeView(HUMAN, "w").groups).toEqual([])
  })

  test("admins: only the human at a terminal grants them; an admin loosens within its tree", () => {
    const { core, claim, as, send } = setup()
    claim("main", 1)
    claim("a", 2, [1])
    claim("b", 3, [1])
    claim("b1", 4, [3, 1])
    core.rulesSet(as("b"), { endpoint: "b1", out: ["tree:parent"] })
    expect(code(() => core.admin(as("main"), { action: "grant", subject: "a", tree: "main" }))).toBe("scope_refused")
    expect(code(() => core.admin({ kind: "human", tty: false }, { action: "grant", subject: "a", tree: "main" }))).toBe("scope_refused")
    core.admin(HUMAN, { action: "grant", subject: "a", tree: "b1" })
    expect(core.admin(as("a"), { action: "ls" })).toEqual([{ subject: "me/a", tree: "me/main", granted_at: expect.any(String) }])
    expect(core.rulesWiden(as("a"), { endpoint: "b1", out: ["handle:main"] }).added).toEqual(["handle:main"])
    expect(send("b1", "main")).toBeUndefined()
    core.admin(HUMAN, { action: "revoke", subject: "a", tree: "main" })
    expect(code(() => core.rulesWiden(as("a"), { endpoint: "b1", out: ["handle:a"] }))).toBe("scope_refused")
    expect(send("b1", "main")).toBeUndefined()
  })

  test("a group selector an endpoint set admits no other fleet; the human's, the policy's and one naming a pinned group may", () => {
    const { core, claim, as, send } = setup()
    claim("main", 1)
    claim("x", 9)
    claim("y", 8)
    core.group(as("x"), { action: "create", name: "reviewers" })
    core.group(as("x"), { action: "add", name: "reviewers" })
    expect(code(() => core.rulesSet(as("main"), { in: ["tree:children", "group:reviewers"] }))).toBe("invalid_params")
    core.rulesSet(as("main"), { in: ["tree:children"] })
    expect(send("x", "main")).toBe("not_found")
    core.rulesSet(HUMAN, { endpoint: "y", in: ["group:reviewers"] })
    expect(send("x", "y")).toBeUndefined()
    core.group(HUMAN, { action: "pin", name: "reviewers" })
    expect(send("x", "main")).toBe("not_found")
    core.rulesSet(as("main"), { in: ["tree:children", "group:reviewers"] })
    expect(send("x", "main")).toBeUndefined()
    core.group(HUMAN, { action: "unpin", name: "reviewers" })
    expect(send("x", "main")).toBe("not_found")
    expect(code(() => core.rulesSet(as("main"), { in: ["tree:children", "group:fixed"] }))).toBe("invalid_params")
    core.setPolicy(parsePolicy({ rules: [], groups: [{ name: "fixed", members: ["handle:x"] }] }))
    core.rulesSet(as("main"), { in: ["tree:children", "group:fixed"] })
    expect(send("x", "main")).toBeUndefined()
  })

  test("group selectors and admin rows bind to the group they named: a later group of that name is another group", () => {
    const { core, claim, as, send } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("g", 3, [2, 1])
    claim("x", 9)
    core.group(as("main"), { action: "create", name: "team" })
    core.group(as("main"), { action: "add", name: "team", endpoint: "g" })
    core.rulesSet(as("main"), { in: ["tree:children", "group:team"] })
    core.rulesSet(as("main"), { endpoint: "orch", out: ["tree:parent", "group:team"] })
    core.admin(HUMAN, { action: "grant", subject: "x", group: "team" })
    expect(send("g", "main")).toBeUndefined()
    expect(send("orch", "g")).toBeUndefined()
    expect(core.scopeView(as("x"), "g").address).toBe("me/g")
    core.group(as("main"), { action: "drop", name: "team" })
    core.group(as("g"), { action: "create", name: "team" })
    core.group(as("g"), { action: "add", name: "team" })
    expect(send("g", "main")).toBe("not_found")
    expect(send("orch", "g")).toBeUndefined()
    expect(code(() => core.scopeView(as("x"), "g"))).toBe("not_found")
    expect(code(() => core.group(as("x"), { action: "show", name: "team" }))).toBe("not_found")
  })
})

describe("group selectors need a group", () => {
  const failure = (fn: () => unknown, name: string): [string, string] | undefined => {
    try {
      fn()
    } catch (error) {
      if (error instanceof RelayError) return [error.code, error.message.replace(name, "<name>")]
      throw error
    }
    return undefined
  }

  test("a group selector naming no group the setter may name is refused at set time, the same whether or not another fleet has it", () => {
    const { core, claim, as, send } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("x", 9)
    core.group(as("x"), { action: "create", name: "theirs" })
    core.group(as("x"), { action: "add", name: "theirs" })
    core.rulesSet(as("main"), { endpoint: "w", out: ["tree:parent"] })
    const nope = failure(() => core.rulesSet(as("main"), { in: ["group:nope"] }), "nope")
    expect(nope).toEqual(["invalid_params", "no group <name>"])
    expect(failure(() => core.rulesSet(as("main"), { in: ["group:theirs"] }), "theirs")).toEqual(nope)
    for (const name of ["nope", "theirs"]) {
      expect(failure(() => core.rulesSet(as("main"), { endpoint: "w", in: [`group:${name}`] }), name)).toEqual(nope)
      expect(failure(() => core.rulesWiden(as("main"), { endpoint: "w", out: [`group:${name}`] }), name)).toEqual(nope)
      expect(failure(() => core.grant(as("main"), { in: [`group:${name}`] }), name)).toEqual(nope)
      expect(failure(() => core.group(as("main"), { action: "create", name: "mine", rules: ["group:self", `group:${name}`] }), name)).toEqual(nope)
    }
    expect(failure(() => core.rulesSet(HUMAN, { endpoint: "main", in: ["group:future"] }), "future")).toEqual(nope)
    core.rulesSet(HUMAN, { endpoint: "main", in: ["group:theirs"] })
    expect(send("x", "main")).toBeUndefined()
    core.group(as("main"), { action: "create", name: "mine", rules: ["group:self"] })
    expect(core.rulesSet(as("main"), { in: ["tree:children", "group:mine"] }).rules).toEqual({ in: ["tree:children", "group:mine"] })
    core.group(as("x"), { action: "create", name: "future" })
    core.group(HUMAN, { action: "pin", name: "future" })
    expect(core.rulesSet(as("w"), { in: ["group:future"] }).rules).toEqual({ in: ["group:future"] })
  })

  test("claim-time group selectors get the same refusal, and the claim is not placed", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("x", 9)
    core.group(as("x"), { action: "create", name: "theirs" })
    core.group(as("main"), { action: "create", name: "mine" })
    const nope = failure(() => core.rulesSet(as("main"), { in: ["group:nope"] }), "nope")
    for (const name of ["theirs", "future"]) {
      for (const params of [{ in: [`group:${name}`] }, { allow: [`group:${name}`] }, { lineage: [key(1)], out: [`group:${name}`] }]) {
        expect(failure(() => core.claim({ handle: "k", harness: "codex", process: key(5), ...params }), name)).toEqual(nope)
      }
    }
    expect(core.list().map((row) => row.address)).not.toContain("me/k")
    expect(claim("k", 5, [1], { in: ["group:mine"] }).parent).toBe("me/main")
  })

  test("a policy group: selector binds at load to the group of that name then, or to none", () => {
    const { core, clock, claim, as, send } = setup()
    claim("main", 1)
    claim("x", 9)
    claim("y", 8)
    claim("z", 7)
    core.group(HUMAN, { action: "create", name: "crew" })
    core.group(HUMAN, { action: "add", name: "crew", endpoint: "x" })
    const policy = parsePolicy({
      rules: [{ match: "handle:main", scope: ["group:crew", "group:later", "group:fixed"] }],
      groups: [{ name: "fixed", members: ["handle:y"] }],
    })
    core.setPolicy(policy)
    expect(send("x", "main")).toBeUndefined()
    expect(send("y", "main")).toBeUndefined()
    core.group(as("z"), { action: "create", name: "later" })
    core.group(as("z"), { action: "add", name: "later" })
    expect(send("z", "main")).toBe("not_found")
    core.group(HUMAN, { action: "drop", name: "crew" })
    clock.now += 1000
    core.group(HUMAN, { action: "create", name: "crew" })
    core.group(HUMAN, { action: "add", name: "crew", endpoint: "x" })
    expect(send("x", "main")).toBe("not_found")
    core.setPolicy(policy)
    expect(send("x", "main")).toBe("not_found")
    expect(send("z", "main")).toBe("not_found")
    core.setPolicy({ ...policy, rules: [...policy.rules, { match: "handle:nobody", send_to: ["kind:human"] }] })
    expect(send("x", "main")).toBeUndefined()
    expect(send("z", "main")).toBeUndefined()
  })

  test("policy group: bindings survive a restart: a group made after the load, or remade, still does not match until the policy text changes", () => {
    const { core, clock, claim, as, send, ids, restarted } = setup()
    claim("main", 1)
    claim("x", 9)
    const ops = () => {
      core.group(as("x"), { action: "create", name: "ops" })
      core.group(as("x"), { action: "add", name: "ops" })
    }
    const policy = parsePolicy({ rules: [{ match: "handle:main", accept_from: ["group:ops", "group:crew"] }] })
    core.group(as("x"), { action: "create", name: "crew" })
    core.group(as("x"), { action: "add", name: "crew" })
    core.setPolicy(policy)
    expect(send("x", "main")).toBeUndefined()
    core.group(as("x"), { action: "drop", name: "crew" })
    clock.now += 1000
    core.group(as("x"), { action: "create", name: "crew" })
    core.group(as("x"), { action: "add", name: "crew" })
    ops()
    expect(send("x", "main")).toBe("policy_refused")
    const after = restarted()
    after.setPolicy(policy)
    expect(code(() => after.send(ids.x!, { to: "main", body: "after a restart" }))).toBe("policy_refused")
    after.setPolicy(parsePolicy({ rules: [{ match: "handle:main", accept_from: ["group:ops"] }] }))
    expect(code(() => after.send(ids.x!, { to: "main", body: "a new policy" }))).toBeUndefined()
  })

  test("policy group: bindings ignore selector order and outlive a switch to another policy and back, until enough others were loaded", () => {
    const { core, claim, as, send } = setup()
    claim("main", 1)
    claim("x", 9)
    const accepting = (...sels: string[]) => parsePolicy({ rules: [{ match: "handle:main", accept_from: sels }] })
    core.setPolicy(accepting("group:ops", "handle:main"))
    core.group(as("x"), { action: "create", name: "ops" })
    core.group(as("x"), { action: "add", name: "ops" })
    expect(send("x", "main")).toBe("policy_refused")
    core.setPolicy(accepting("handle:main", "group:ops"))
    expect(send("x", "main")).toBe("policy_refused")
    core.setPolicy(accepting("group:ops", "handle:x"))
    expect(send("x", "main")).toBeUndefined()
    core.setPolicy(accepting("group:ops", "handle:main"))
    expect(send("x", "main")).toBe("policy_refused")
    for (let n = 0; n < 8; n++) core.setPolicy(accepting("group:ops", `handle:k${n}`))
    core.setPolicy(accepting("group:ops", "handle:main"))
    expect(send("x", "main")).toBeUndefined()
  })

  test("setting a group selector again rebinds it to the group of that name now", () => {
    const { core, clock, claim, as, send } = setup()
    claim("main", 1)
    for (const [name, pid] of [
      ["g", 2],
      ["o1", 3],
      ["o2", 4],
      ["k", 5],
    ] as const)
      claim(name, pid, [1])
    const team = () => {
      core.group(as("main"), { action: "create", name: "team" })
      core.group(as("main"), { action: "add", name: "team", endpoint: "g" })
    }
    team()
    core.rulesSet(as("main"), { in: ["group:team"] })
    core.rulesSet(as("main"), { endpoint: "o1", out: ["tree:parent", "group:team"] })
    core.rulesSet(as("main"), { endpoint: "o2", out: ["tree:parent"] })
    core.rulesWiden(as("main"), { endpoint: "o2", out: ["group:team"] })
    core.group(as("main"), { action: "create", name: "crew", out: ["group:self", "tree:parent", "group:team"] })
    core.group(as("main"), { action: "add", name: "crew", endpoint: "k" })
    const reach = () => [send("g", "main"), send("o1", "g"), send("o2", "g"), send("k", "g")]
    expect(reach()).toEqual([undefined, undefined, undefined, undefined])
    core.group(as("main"), { action: "drop", name: "team" })
    clock.now += 1000
    team()
    expect(reach()).toEqual(["not_found", "not_found", "not_found", "not_found"])
    core.rulesSet(as("main"), { in: ["group:team"] })
    core.rulesSet(as("main"), { endpoint: "o1", out: ["tree:parent", "group:team"] })
    core.rulesWiden(as("main"), { endpoint: "o2", out: ["group:team"] })
    core.group(as("main"), { action: "rules", name: "crew", out: ["group:self", "tree:parent", "group:team"] })
    expect(reach()).toEqual([undefined, undefined, undefined, undefined])
  })

  test("a plain shell setting a group selector again may not rebind it to a group remade since", () => {
    const { core, clock, claim, as, send } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("sib", 3, [1])
    const team = () => {
      core.group(as("main"), { action: "create", name: "team" })
      core.group(as("main"), { action: "add", name: "team", endpoint: "sib" })
    }
    team()
    core.rulesSet(as("w"), { out: ["group:team"] })
    core.rulesSet(as("main"), { endpoint: "w", out: ["group:team"] })
    expect(send("w", "sib")).toBeUndefined()
    core.group(as("main"), { action: "drop", name: "team" })
    clock.now += 1000
    team()
    expect(send("w", "sib")).toBe("not_found")
    expect(code(() => core.rulesSet(as("w", "lineage"), { out: ["group:team"] }))).toBe("scope_refused")
    expect(code(() => core.rulesSet(as("main", "lineage"), { endpoint: "w", out: ["group:team"] }))).toBe("scope_refused")
    expect(send("w", "sib")).toBe("not_found")
    core.rulesSet(as("w"), { out: ["group:team"] })
    core.rulesSet(as("main"), { endpoint: "w", out: ["group:team"] })
    expect(send("w", "sib")).toBeUndefined()
  })

  test("a group admin row of a dropped group shows as stale, is revoked by name and is not duplicated by a regrant", () => {
    const { core, clock, claim, as } = setup()
    claim("main", 1)
    claim("x", 9)
    const remake = () => {
      core.group(as("main"), { action: "drop", name: "team" })
      clock.now += 1000
      core.group(as("main"), { action: "create", name: "team" })
    }
    const ls = () =>
      (core.admin(HUMAN, { action: "ls" }) as { subject: string; group?: string; stale?: boolean }[]).map(({ subject, group, stale }) => ({
        subject,
        group,
        stale,
      }))
    core.group(as("main"), { action: "create", name: "team" })
    core.admin(HUMAN, { action: "grant", subject: "x", group: "team" })
    expect(ls()).toEqual([{ subject: "me/x", group: "team", stale: undefined }])
    remake()
    expect(ls()).toEqual([{ subject: "me/x", group: "team", stale: true }])
    expect((core.admin(as("x"), { action: "ls" }) as { stale?: boolean }[]).map((row) => row.stale)).toEqual([true])
    core.admin(HUMAN, { action: "grant", subject: "x", group: "team" })
    expect(ls()).toEqual([{ subject: "me/x", group: "team", stale: undefined }])
    remake()
    core.admin(HUMAN, { action: "revoke", subject: "x", group: "team" })
    expect(ls()).toEqual([])
    core.admin(HUMAN, { action: "grant", subject: "x", group: "team" })
    core.group(as("main"), { action: "drop", name: "team" })
    core.admin(HUMAN, { action: "revoke", subject: "x", group: "team" })
    expect(ls()).toEqual([])
    expect(code(() => core.admin(HUMAN, { action: "revoke", subject: "x", group: "team" }))).toBe("not_found")
  })

  test("policy group: selectors in match, send_to, accept_from and members bind at load, so a later group of that name never matches", () => {
    const { core, claim, as, send } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    claim("x", 9)
    claim("z", 7)
    claim("q", 6)
    core.group(HUMAN, { action: "create", name: "crew" })
    core.group(HUMAN, { action: "add", name: "crew", endpoint: "w" })
    core.setPolicy(
      parsePolicy({
        rules: [
          { match: "handle:main", accept_from: ["group:crew", "group:later", "group:fixed"] },
          { match: "group:quiet", send_to: ["kind:human"] },
          { match: "handle:z", send_to: ["group:later"] },
        ],
        groups: [{ name: "fixed", members: ["group:held"] }],
      }),
    )
    expect(send("w", "main")).toBeUndefined()
    core.group(as("x"), { action: "create", name: "later" })
    core.group(as("x"), { action: "add", name: "later" })
    expect(send("x", "main")).toBe("policy_refused")
    expect(send("z", "x")).toBe("policy_refused")
    core.group(as("x"), { action: "create", name: "held" })
    core.group(as("x"), { action: "add", name: "held" })
    expect(core.scopeView(HUMAN, "x").groups).toEqual(["held", "later"])
    expect(send("x", "main")).toBe("policy_refused")
    core.group(as("q"), { action: "create", name: "quiet" })
    core.group(as("q"), { action: "add", name: "quiet" })
    expect(send("q", "w")).toBeUndefined()
  })

  test("a group dropped and remade in the same millisecond is another group", () => {
    const { core, claim, as, send } = setup()
    claim("main", 1)
    claim("g", 2, [1])
    claim("g2", 3, [1])
    claim("x", 9)
    claim("y", 8)
    core.group(as("main"), { action: "create", name: "team" })
    core.group(as("main"), { action: "add", name: "team", endpoint: "g" })
    core.rulesSet(HUMAN, { endpoint: "y", in: ["group:team"] })
    core.admin(HUMAN, { action: "grant", subject: "x", group: "team" })
    const token = core.grant(as("main"), { groups: ["team"] }).token
    expect(send("g", "y")).toBeUndefined()
    core.group(as("main"), { action: "drop", name: "team" })
    core.group(as("main"), { action: "create", name: "team" })
    core.group(as("main"), { action: "add", name: "team", endpoint: "g2" })
    expect(send("g2", "y")).toBe("not_found")
    expect((core.admin(HUMAN, { action: "ls" }) as { stale?: boolean }[]).map((row) => row.stale)).toEqual([true])
    expect(claim("late", 4, [], { grant: token }).parent).toBe("me/main")
    expect(core.scopeView(HUMAN, "late").groups).toEqual([])
  })

  test("a selector entry or group admin row without a group identity grants nothing", () => {
    const { core, claim, as, send, db, ids } = setup()
    claim("main", 1)
    claim("g", 3, [1])
    claim("x", 9)
    core.group(as("main"), { action: "create", name: "team" })
    core.group(as("main"), { action: "add", name: "team", endpoint: "g" })
    core.group(HUMAN, { action: "pin", name: "team" })
    core.rulesSet(HUMAN, { endpoint: "x", in: ["group:team"] })
    expect(send("g", "x")).toBeUndefined()
    const caps = JSON.parse((db.query(`SELECT caps FROM endpoints WHERE id = ?`).get(ids.x!) as { caps: string }).caps) as {
      caps: { sels: { group?: string }[] }[]
    }
    for (const cap of caps.caps) for (const entry of cap.sels) delete entry.group
    db.query(`UPDATE endpoints SET caps = ? WHERE id = ?`).run(JSON.stringify(caps), ids.x!)
    expect(send("g", "x")).toBe("not_found")
    db.query(`INSERT INTO admins (subject, scope_kind, scope, scope_id, granted_at) VALUES (?, 'group', 'team', NULL, 0)`).run(ids.x!)
    expect(code(() => core.scopeView(as("x"), "g"))).toBe("not_found")
  })
})

describe("policy", () => {
  test("scope, groups and defaults parse, and unknown fields are refused", () => {
    const policy = parsePolicy({
      rules: [{ match: "harness:codex", scope: ["tree:self"] }],
      groups: [{ name: "reviewers", members: ["harness:grok"], rules: ["group:self"] }],
      defaults: { human_always: false, symmetric_presets: false, child_default: "parent", verify_lineage: "spike" },
    })
    expect(policy.rules[0]!.scope).toEqual(["tree:self"])
    expect(policy.groups![0]).toEqual({ name: "reviewers", members: ["harness:grok"], rules: ["group:self"] })
    expect(policy.defaults).toEqual({ human_always: false, symmetric_presets: false, child_default: "parent", verify_lineage: "spike" })
    for (const bad of [
      { rules: [], defaults: { human_always: "yes" } },
      { rules: [], defaults: { child_default: "wide" } },
      { rules: [], defaults: { other: 1 } },
      { rules: [], groups: [{ name: "g", members: ["tree:self"] }] },
      { rules: [], groups: [{ name: "g", members: [], size: 1 }] },
      { rules: [{ match: "*", scope: ["group:self"] }] },
    ]) {
      expect(code(() => parsePolicy(bad))).toBe("invalid_params")
    }
  })

  test("verify_lineage true is refused until the peer-pid check exists; false and spike parse", () => {
    expect(() => parsePolicy({ rules: [], defaults: { verify_lineage: true } })).toThrow(/peer-pid check/)
    expect(parsePolicy({ rules: [], defaults: { verify_lineage: false } }).defaults).toEqual({ verify_lineage: false })
  })

  test("a policy scope caps every match, nobody loosens it, and human_always can be turned off", () => {
    const { core, claim, send } = setup()
    claim("r", 1)
    claim("c", 2, [1])
    claim("x", 3)
    claim("d", 4, [1])
    core.setPolicy(parsePolicy({ rules: [{ match: "handle:c", scope: ["tree:parent"] }] }))
    expect(send("d", "c")).toBe("not_found")
    expect(send("c", "x")).toBe("not_found")
    expect(send("x", "c")).toBe("not_found")
    expect(send("r", "c")).toBeUndefined()
    expect(core.scopeView(HUMAN, "c").caps.map((cap) => [cap.by, cap.dir])).toEqual([
      ["policy", "in"],
      ["policy", "out"],
    ])
    expect(code(() => core.rulesWiden(HUMAN, { endpoint: "c", out: ["*"] }))).toBe("scope_refused")
    expect(send("c", "me/")).toBeUndefined()
    core.setPolicy(parsePolicy({ rules: [{ match: "handle:c", scope: ["tree:parent"] }], defaults: { human_always: false } }))
    expect(send("c", "me/")).toBe("not_found")
    core.setPolicy(parsePolicy({ rules: [{ match: "handle:c", scope: ["tree:parent"] }], defaults: { symmetric_presets: false } }))
    expect(send("d", "c")).toBeUndefined()
    expect(send("c", "d")).toBe("not_found")
  })

  test("policy groups: members by selector, their rules cap them, agents cannot change them", () => {
    const { core, claim, as, send } = setup()
    claim("a", 1, [], { harness: "grok" })
    core.claim({ handle: "b", harness: "grok", process: key(2), lineage: [key(2)] })
    claim("c", 3)
    core.setPolicy(
      parsePolicy({
        rules: [{ match: "group:reviewers", send_to: ["group:reviewers", "kind:human"] }],
        groups: [{ name: "reviewers", members: ["harness:grok"], rules: ["group:self"] }],
      }),
    )
    expect(core.scopeView(HUMAN, "b").groups).toEqual(["reviewers"])
    expect(send("a", "c")).toBe("not_found")
    expect(send("a", "group:reviewers")).toBeUndefined()
    expect(code(() => core.group(as("a"), { action: "remove", name: "reviewers" }))).toBe("scope_refused")
    expect(code(() => core.group(as("c"), { action: "create", name: "reviewers" }))).toBe("invalid_params")
  })

  test("send_to and accept_from understand the scope selectors relative to their side", () => {
    const { core, claim, send } = setup()
    claim("r", 1)
    claim("c", 2, [1])
    claim("x", 3)
    core.setPolicy(
      parsePolicy({
        rules: [
          { match: "handle:c", send_to: ["tree:parent"] },
          { match: "handle:r", accept_from: ["tree:children"] },
        ],
      }),
    )
    expect(send("c", "r")).toBeUndefined()
    expect(send("c", "x")).toBe("policy_refused")
    expect(send("x", "r")).toBe("policy_refused")
  })
})

test("the scrubber refuses krt_ grants in bodies and claims", () => {
  const { core, claim, as, send } = setup()
  claim("main", 1)
  claim("w", 2, [1])
  const { token } = core.grant(as("main"), {})
  expect(findSecret(`export SCP_GRANT=${token}`)).toBe("relay grant")
  expect(send("w", "main", { body: token })).toBe("secret_refused")
  expect(code(() => core.claim({ handle: "z", grant: "krt_nothex" }))).toBe("invalid_params")
})

describe("a grant's title", () => {
  test("lands on the endpoint the grant places or redeems, one line; a title the endpoint set itself wins a redeem, not a new spawn's", () => {
    const { core, claim, as, ids } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    expect(claim("w1", 3, [], { grant: core.grant(as("orch"), { name: "w1", title: " docs\n\t pass " }).token }).title).toBe("docs pass")
    claim("own", 4, [2, 1])
    core.title(ids.own!, "mine")
    core.disconnect(ids.own!)
    expect(claim("own", 5, [], { grant: core.grant(as("orch"), { title: "theirs" }).token })).toMatchObject({ id: ids.own, title: "theirs" })
    core.title(ids.own!, "mine")
    core.disconnect(ids.own!)
    expect(claim("own", 5, [], { grant: core.grant(as("orch"), { title: "later" }).token })).toMatchObject({ id: ids.own, title: "mine" })
    claim("bare", 6, [2, 1])
    core.disconnect(ids.bare!)
    expect(claim("bare", 7, [], { grant: core.grant(as("orch"), { title: "given" }).token })).toMatchObject({ id: ids.bare, title: "given" })
    expect(core.title(ids.w1!, "renamed").title).toBe("renamed")
    expect(code(() => core.grant(as("orch"), { title: "x".repeat(65) }))).toBe("too_large")
    expect(code(() => core.grant(as("orch"), { title: `ghp_${"A1b2C3d4".repeat(5)}` }))).toBe("secret_refused")
    expect(code(() => core.grant(as("orch"), { title: 7 as unknown as string }))).toBe("invalid_params")
  })
})

describe("single-use grants", () => {
  test("a takeover and a session join spend the grant; a named grant redeems only for its name; a refused grant fails the claim", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    const w = claim("w", 3, [2, 1]).id
    core.disconnect(w)
    const named = core.grant(as("orch"), { name: "spawned" }).token
    expect(code(() => claim("w", 4, [], { grant: named }))).toBe("unauthorized")
    expect(claim("spawned", 5, [], { grant: named }).parent).toBe("me/orch")
    expect(code(() => claim("spawned-again", 6, [], { grant: named }))).toBe("unauthorized")
    const open = core.grant(as("orch"), {}).token
    expect(claim("w", 7, [], { grant: open, cwd: "/work/w" }).id).toBe(w)
    expect(code(() => claim("fresh", 8, [], { grant: open }))).toBe("unauthorized")
    expect(core.list().map((row) => row.address)).not.toContain("me/w-2")
    const joining = core.grant(as("orch"), {}).token
    const hook = core.claim({ handle: "j", harness: "codex", session: "sess-1", process: key(9), lineage: [key(9), key(2)] }, { transient: true })
    expect(hook.endpoint.parent).toBe("me/orch")
    expect(core.claim({ handle: "j", harness: "codex", session: "sess-1", process: key(9), lineage: [key(9), key(2)], grant: joining }).endpoint.id).toBe(
      hook.endpoint.id,
    )
    expect(code(() => claim("late", 10, [], { grant: joining }))).toBe("unauthorized")
    core.disconnect(w)
    expect(claim("w", 11, [], { grant: open, cwd: "/work/w" }).id).toBe(w)
  })

  test("a named grant is neither applied nor spent, and the claim fails, when it would land on a suffixed handle", () => {
    const { core, claim, as, db } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("spawned", 3)
    const named = core.grant(as("orch"), { name: "spawned" }).token
    expect(code(() => claim("spawned", 4, [], { grant: named }))).toBe("unauthorized")
    expect(core.list().map((row) => row.address)).not.toContain("me/spawned-2")
    expect(db.query("SELECT used_by FROM grants").all()).toEqual([{ used_by: null }])
  })

  test("a grant's group joins only the group it was issued for", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("y", 3)
    core.group(as("orch"), { action: "create", name: "g1", rules: ["group:self"] })
    const token = core.grant(as("orch"), { groups: ["g1"] }).token
    core.group(as("orch"), { action: "drop", name: "g1" })
    core.group(as("y"), { action: "create", name: "g1", rules: ["group:self"] })
    expect(claim("n", 4, [], { grant: token }).parent).toBe("me/orch")
    expect(core.scopeView(HUMAN, "n").groups).toEqual([])
  })

  test("a grant's caps and groups apply to the endpoint its claim takes over or joins", () => {
    const { core, claim, as, send, ids } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("y", 9)
    core.group(as("orch"), { action: "create", name: "crew" })
    const w = claim("w", 3, [2, 1]).id
    core.disconnect(w)
    expect(claim("w", 4, [], { grant: core.grant(as("orch"), { scope: "parent", groups: ["crew"] }).token }).id).toBe(w)
    expect(send("w", "y")).toBe("not_found")
    expect(send("w", "orch")).toBeUndefined()
    expect(core.scopeView(HUMAN, "w").groups).toEqual(["crew"])
    const hook = core.claim({ handle: "j", harness: "codex", session: "sess-1", process: key(5), lineage: [key(5), key(2)] }, { transient: true }).endpoint
    ids.j = hook.id
    expect(send("j", "y")).toBeUndefined()
    const grant = core.grant(as("orch"), { scope: "parent" }).token
    expect(core.claim({ handle: "j", harness: "codex", session: "sess-1", process: key(5), lineage: [key(5), key(2)], grant }).endpoint.id).toBe(hook.id)
    expect(send("j", "y")).toBe("not_found")
  })

  test("a fresh grant taking over an endpoint replaces the caps it had, and the same caps again add nothing", () => {
    const { core, claim, as, send } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("y", 9)
    const w = claim("w", 3, [], { grant: core.grant(as("orch"), { name: "w", out: ["*"], in: ["*"] }).token }).id
    expect(send("w", "y")).toBeUndefined()
    const restart = (pid: number) => {
      core.disconnect(w)
      expect(claim("w", pid, [], { grant: core.grant(as("orch"), { name: "w", scope: "parent" }).token }).id).toBe(w)
      return core.scopeView(HUMAN, "w").caps.length
    }
    expect(restart(4)).toBe(2)
    expect(send("w", "y")).toBe("not_found")
    expect(send("w", "orch")).toBeUndefined()
    expect(restart(5)).toBe(2)
  })

  test("the same grant caps in another order add nothing on a restart", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    const mint = (out: string[]) => core.grant(as("orch"), { name: "w", out }).token
    const w = claim("w", 3, [], { grant: mint(["handle:main", "tree:parent"]) }).id
    const caps = core.scopeView(HUMAN, "w").caps.length
    core.disconnect(w)
    expect(claim("w", 4, [], { grant: mint(["tree:parent", "handle:main"]) }).id).toBe(w)
    expect(core.scopeView(HUMAN, "w").caps.length).toBe(caps)
  })

  test("a grant-capped detached spawn restarts onto its own endpoint with its spent grant, past expiry, and its children carry the grant under it", () => {
    const { core, clock, claim, as, send, ids } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("y", 9)
    const token = core.grant(as("orch"), { scope: "parent", ttl_s: 60 }).token
    const shim = (pid: number, parents: number[] = [], transient = false) =>
      core.claim(
        { handle: "w", harness: "codex", cwd: "/work/w", session: "sess-w", process: key(pid), lineage: [pid, ...parents].map(key), grant: token },
        { transient },
      ).endpoint
    const w = shim(3).id
    ids.w = w
    expect(send("w", "y")).toBe("not_found")
    core.disconnect(w)
    clock.now += 120_000
    core.sweep()
    expect(shim(4)).toMatchObject({ id: w, address: "me/w", parent: "me/orch" })
    expect(shim(4, [], true).id).toBe(w)
    expect(send("w", "y")).toBe("not_found")
    expect(code(() => claim("w", 5, [], { grant: token }))).toBe("unauthorized")
    expect(claim("kid", 6, [4], { grant: token }).parent).toBe("me/w")
    core.disconnect(w)
    expect(claim("w", 7, [6, 4], { grant: token })).toMatchObject({ address: "me/w-2", parent: "me/kid" })
    expect(send("kid", "y")).toBe("not_found")
  })

  test("a spent grant re-claims its endpoint only from above it or with no lineage, never from another tree", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("y", 9)
    const token = core.grant(as("orch"), { scope: "parent" }).token
    const w = claim("w", 3, [], { grant: token, cwd: "/work/w" }).id
    core.disconnect(w)
    expect(claim("w", 10, [9], { grant: token })).toMatchObject({ address: "me/w-2", parent: "me/y" })
    expect(claim("w", 11, [1], { grant: token, cwd: "/work/w" }).id).toBe(w)
    core.disconnect(w)
    expect(claim("w", 12, [], { grant: token, cwd: "/work/w" }).id).toBe(w)
  })

  test("a spent grant re-claims its endpoint with no lineage only from the harness and cwd the endpoint records", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    const token = core.grant(as("orch"), { scope: "parent" }).token
    const w = claim("w", 3, [], { grant: token, cwd: "/work/w" }).id
    core.disconnect(w)
    expect(code(() => claim("w", 4, [], { grant: token }))).toBe("unauthorized")
    expect(code(() => claim("w", 5, [], { grant: token, cwd: "/work/w/sub" }))).toBe("unauthorized")
    expect(code(() => core.claim({ handle: "w", harness: "claude", cwd: "/work/w", process: key(6), lineage: [key(6)], grant: token }))).toBe("unauthorized")
    expect(claim("w", 7, [], { grant: token, cwd: "/work/w" }).id).toBe(w)
  })

  test("a no-lineage re-claim's cwd is where the endpoint's claims connected from, which a hook or a claim without a cwd does not move", () => {
    const { core, clock, claim, as } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    const token = core.grant(as("orch"), { scope: "parent" }).token
    const shim = (pid: number, cwd: string | undefined, transient = false) =>
      core.claim(
        { handle: "w", harness: "codex", ...(cwd === undefined ? {} : { cwd }), session: "sess-w", process: key(pid), lineage: [key(pid)], grant: token },
        { transient },
      ).endpoint
    const w = shim(3, "/work/w").id
    shim(3, "/elsewhere", true)
    core.disconnect(w)
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    expect(code(() => claim("w", 4, [], { grant: token, cwd: "/elsewhere" }))).toBe("unauthorized")
    expect(claim("w", 3, [], { grant: token }).id).toBe(w)
    core.disconnect(w)
    clock.now += 600_000
    expect(claim("w", 5, [], { grant: token, cwd: "/work/w" }).id).toBe(w)
  })

  test("a stale grant refuses only a claim with no lineage; one that lineage places lands there and the grant is ignored", () => {
    const { core, clock, claim, as, ids } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    const expired = core.grant(as("orch"), { scope: "parent", ttl_s: 60 }).token
    const spent = core.grant(as("orch"), { scope: "parent" }).token
    claim("w", 3, [], { grant: spent })
    clock.now += 120_000
    expect(code(() => claim("a", 4, [], { grant: expired }))).toBe("unauthorized")
    expect(claim("a", 5, [2, 1], { grant: expired }).parent).toBe("me/orch")
    core.disconnect(ids.a!)
    expect(claim("a", 6, [2, 1], { grant: expired }).address).toBe("me/a")
    expect(claim("b", 7, [2, 1], { grant: spent }).parent).toBe("me/orch")
    expect(code(() => claim("c", 8, [], { grant: spent }))).toBe("unauthorized")
    const ignored = core.log().filter((row) => row.event === "scope_grant_ignored")
    expect(ignored.map((row) => row.detail.reason).sort()).toEqual(["grant invalid", "grant invalid", "grant used"])
  })
})

describe("a reused handle", () => {
  /** main with leads la and lb; wa spawned under la and wb under lb, both parent-scoped and put in main's group qa */
  function crew() {
    const t = setup()
    t.claim("main", 1)
    t.claim("la", 2, [1])
    t.claim("lb", 3, [1])
    const spawn = (lead: string, name: string, pid: number) => {
      const token = t.core.grant(t.as(lead), { name, scope: "parent" }).token
      return { endpoint: t.claim(name, pid, [], { grant: token, cwd: `/work/${name}` }), token }
    }
    const wa = spawn("la", "wa", 4)
    const wb = spawn("lb", "wb", 5)
    t.core.group(t.as("main"), { action: "create", name: "qa" })
    t.core.group(t.as("main"), { action: "add", name: "qa", endpoint: "wa" })
    t.core.group(t.as("main"), { action: "add", name: "qa", endpoint: "wb" })
    return { ...t, spawn, tokens: { wa: wa.token, wb: wb.token } }
  }
  const resets = (core: RelayCore) => core.log({ scope: true }).filter((row) => row.event === "scope_reset")

  test("a fresh spawn under a name an earlier agent held starts outside its groups, so the lateral send its membership allowed is refused", () => {
    const { core, clock, ids, send, spawn } = crew()
    expect(send("wb", "wa")).toBeUndefined()
    core.disconnect(ids.wa!)
    core.disconnect(ids.wb!)
    clock.now += 3 * 3600_000
    const [wa, wb] = [ids.wa, ids.wb]
    expect(spawn("la", "wa", 14).endpoint.id).toBe(wa!)
    expect(spawn("lb", "wb", 15).endpoint.id).toBe(wb!)
    expect(core.scopeView(HUMAN, "wa").groups).toEqual([])
    expect(core.scopeView(HUMAN, "wb").groups).toEqual([])
    expect(send("wb", "wa")).toBe("not_found")
    expect(send("wb", "lb")).toBeUndefined()
    expect((core.group(HUMAN, { action: "show", name: "qa" }) as { members: string[] }).members).toEqual([])
    expect(resets(core).map((row) => [row.detail.target, row.detail.by, row.detail.groups])).toEqual([
      ["me/wa", "me/la", ["qa"]],
      ["me/wb", "me/lb", ["qa"]],
    ])
  })

  test("the same harness process re-claiming, or a re-claim with the grant the endpoint spent, keeps its groups and status", () => {
    const { core, claim, ids, send, tokens } = crew()
    core.status(ids.wb!, "working", "on it")
    core.disconnect(ids.wb!)
    expect(claim("wb", 5, [], { grant: tokens.wb }).id).toBe(ids.wb!)
    core.disconnect(ids.wb!)
    expect(claim("wb", 5).id).toBe(ids.wb!)
    core.disconnect(ids.wb!)
    expect(claim("wb", 25, [], { grant: tokens.wb, cwd: "/work/wb" }).id).toBe(ids.wb!)
    expect(core.scopeView(HUMAN, "wb").groups).toEqual(["qa"])
    expect(core.whoami(ids.wb!).status).toMatchObject({ state: "working", note: "on it" })
    expect(send("wb", "wa")).toBeUndefined()
    expect(resets(core)).toEqual([])
  })

  test("a takeover by a grant child drops the widenings, rules, admin rows and status the earlier holder had, and is audited", () => {
    const { core, claim, as, ids, send } = crew()
    claim("kid", 6, [2, 1])
    core.rulesSet(as("la"), { endpoint: "kid", out: ["tree:parent"] })
    core.rulesWiden(as("la"), { endpoint: "kid", out: ["ep:lb"] })
    core.rulesSet(as("kid"), { in: ["tree:parent", "ep:lb"] })
    core.admin(HUMAN, { action: "grant", subject: "kid", tree: "main" })
    core.status(ids.kid!, "working", "old task")
    expect(send("kid", "lb")).toBeUndefined()
    core.disconnect(ids.kid!)
    const kid = claim("kid", 16, [], { grant: core.grant(as("la"), { scope: "parent" }).token })
    expect(kid.id).toBe(ids.kid!)
    expect(kid.status).toBeNull()
    const view = core.scopeView(HUMAN, "kid")
    expect(view.rules).toEqual({})
    expect(view.caps.every((cap) => cap.by === "me/la" && cap.sels.every((entry) => entry.via === undefined))).toBe(true)
    expect(send("kid", "lb")).toBe("not_found")
    expect(send("kid", "la")).toBeUndefined()
    expect(core.admin(HUMAN, { action: "ls" })).toEqual([])
    const [row] = resets(core)
    expect(row?.detail).toMatchObject({
      by: "me/la",
      target: "me/kid",
      groups: [],
      admins: 1,
      before: { rules: { in: ["tree:parent", "ep:lb"] }, status: "working", note: "old task" },
    })
  })

  test("a new spawn gets none of the earlier holder's mail, and neither end's reply to a message from before the takeover passes as solicited", () => {
    const { core, clock, as, ids, send, spawn } = crew()
    const toWa = core.send(ids.wb!, { to: "wa", body: "q", kind: "request" })
    const toWb = core.send(ids.wa!, { to: "wb", body: "q", kind: "request" })
    core.disconnect(ids.wa!)
    clock.now += 1000
    expect(spawn("la", "wa", 14).endpoint.id).toBe(ids.wa!)
    expect(core.inbox(ids.wa!)).toEqual([])
    expect(send("wa", "wb", { kind: "reply", reply_to: toWa.id })).toBe("not_found")
    expect(send("wb", "wa", { kind: "reply", reply_to: toWb.id })).toBe("not_found")
    expect(resets(core)[0]?.detail).toMatchObject({ target: "me/wa", dropped: 1 })
    clock.now += 1000
    const asked = core.send(ids.la!, { to: "wa", body: "status?", kind: "request" })
    core.rulesSet(as("wa"), { out: [] })
    expect(send("wa", "la")).toBe("not_found")
    expect(send("wa", "la", { kind: "reply", reply_to: asked.id })).toBeUndefined()
  })

  test("a revoked grant outlives the sweep, so a late spawn_exit hears it was revoked", () => {
    const { core, as, ids, spawn, tokens } = crew()
    core.disconnect(ids.wa!)
    spawn("la", "wa", 14)
    core.sweep()
    expect(() => core.spawnExit(as("la"), { grant: tokens.wa, code: 0 })).toThrow("the grant was revoked")
  })

  test("a takeover revokes the grants the earlier holder spent: its spawn's late exit and a re-claim with that grant reach the new holder no more", () => {
    const { core, claim, as, ids, spawn, tokens } = crew()
    core.disconnect(ids.wa!)
    spawn("la", "wa", 14)
    core.status(ids.wa!, "working", "new task")
    expect(code(() => core.spawnExit(as("la"), { grant: tokens.wa, code: 0 }))).toBe("unauthorized")
    expect(core.whoami(ids.wa!).status).toMatchObject({ state: "working", note: "new task" })
    core.disconnect(ids.wa!)
    expect(code(() => claim("wa", 4, [], { grant: tokens.wa, cwd: "/work/wa" }))).toBe("unauthorized")
    expect(core.whoami(ids.wa!).status).toMatchObject({ state: "working", note: "new task" })
  })

  test("a takeover from another process without a grant drops the widenings, groups and admin rows but keeps what narrows it; a root's too", () => {
    const { core, claim, ids, send } = crew()
    core.rulesSet(HUMAN, { endpoint: "wa", in: ["ep:la", "ep:main", "ep:wb"] })
    core.rulesWiden(HUMAN, { endpoint: "wa", out: ["ep:lb"] })
    core.admin(HUMAN, { action: "grant", subject: "wa", tree: "main" })
    core.rulesSet(HUMAN, { endpoint: "main", in: ["tree:children"] })
    expect(send("wa", "lb")).toBeUndefined()
    core.disconnect(ids.wa!)
    expect(claim("wa", 24, [2, 1]).id).toBe(ids.wa!)
    const view = core.scopeView(HUMAN, "wa")
    expect(view.groups).toEqual([])
    expect(view.caps.filter((cap) => cap.by === "human").map((cap) => [cap.dir, cap.sels.map((entry) => entry.sel)])).toEqual([
      ["in", ["ep:la", "ep:main", "ep:wb"]],
    ])
    expect(view.caps.filter((cap) => cap.by === "me/la").every((cap) => cap.sels.every((entry) => entry.via === undefined))).toBe(true)
    expect(send("wa", "lb")).toBe("not_found")
    expect(send("wb", "wa")).toBe("not_found")
    expect(core.admin(HUMAN, { action: "ls" })).toEqual([])
    core.disconnect(ids.main!)
    expect(claim("main", 31).id).toBe(ids.main!)
    expect(
      core
        .scopeView(HUMAN, "main")
        .caps.filter((cap) => cap.by === "human")
        .map((cap) => cap.sels.map((entry) => entry.sel)),
    ).toEqual([["tree:children"]])
    expect(resets(core).map((row) => [row.detail.target, row.detail.by])).toEqual([
      ["me/wa", "me/wa"],
      ["me/main", "me/main"],
    ])
  })

  test("a new spawn does not own the groups the earlier holder created: they pass to the grant's issuer, and the reset names them", () => {
    const { core, clock, as, ids, spawn } = crew()
    core.group(as("wa"), { action: "create", name: "wq" })
    core.disconnect(ids.wa!)
    clock.now += 1000
    expect(spawn("la", "wa", 14).endpoint.id).toBe(ids.wa!)
    expect(code(() => core.group(as("wa"), { action: "add", name: "wq", endpoint: "wb" }))).toBeDefined()
    expect(code(() => core.group(as("wa"), { action: "rules", name: "wq", out: ["tree:parent"] }))).toBeDefined()
    expect(code(() => core.group(as("wa"), { action: "drop", name: "wq" }))).toBeDefined()
    expect(core.group(HUMAN, { action: "show", name: "wq" })).toMatchObject({ owner: "me/la", tree: "me/main" })
    expect(core.group(as("la"), { action: "drop", name: "wq" })).toEqual({ name: "wq", dropped: true })
    expect(resets(core)[0]?.detail).toMatchObject({ target: "me/wa", owned: ["wq"], owner: "me/la" })
  })

  test("a takeover from another process hands the groups the earlier holder created to the human; a restart keeps them", () => {
    const { core, claim, as, ids, tokens } = crew()
    core.group(as("wa"), { action: "create", name: "wq" })
    core.group(as("wb"), { action: "create", name: "wr" })
    core.disconnect(ids.wb!)
    expect(claim("wb", 5, [], { grant: tokens.wb }).id).toBe(ids.wb!)
    expect(core.group(HUMAN, { action: "show", name: "wr" })).toMatchObject({ owner: "me/wb" })
    expect(core.group(as("wb"), { action: "rules", name: "wr", out: ["tree:parent"] })).toMatchObject({ name: "wr" })
    core.disconnect(ids.wa!)
    expect(claim("wa", 24, [2, 1]).id).toBe(ids.wa!)
    expect(code(() => core.group(as("wa"), { action: "drop", name: "wq" }))).toBeDefined()
    const human = core.group(HUMAN, { action: "show", name: "wq" }) as { owner: string }
    expect(human.owner).toBe(core.whoami(core.humanId()).address)
    expect(resets(core).map((row) => [row.detail.target, row.detail.owned, row.detail.owner])).toEqual([["me/wa", ["wq"], human.owner]])
  })

  test("a hook claim from another process takes over an ended endpoint like a lasting claim; one from the endpoint's own process restarts it", () => {
    const { core, clock, ids, send } = crew()
    core.rulesWiden(HUMAN, { endpoint: "wa", out: ["ep:lb"] })
    core.admin(HUMAN, { action: "grant", subject: "wa", tree: "main" })
    const hook = (pid: number, parents: number[], session: string) =>
      core.claim({ handle: "wa", harness: "codex", process: key(pid), lineage: [pid, ...parents].map(key), session }, { transient: true }).endpoint
    core.disconnect(ids.wa!)
    clock.now += (LIMITS.restartGraceS + 1) * 1000
    expect(hook(4, [], "s-wa").id).toBe(ids.wa!)
    expect(send("wa", "lb")).toBeUndefined()
    expect(core.admin(HUMAN, { action: "ls" })).toHaveLength(1)
    expect(resets(core)).toEqual([])
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    expect(hook(2, [1], "s-la").id).toBe(ids.wa!)
    expect(send("wa", "lb")).toBe("not_found")
    expect(core.admin(HUMAN, { action: "ls" })).toEqual([])
    expect(resets(core).map((row) => [row.detail.target, row.detail.reason])).toEqual([["me/wa", "another process took over the endpoint"]])
  })
})

describe("a widening names the other end", () => {
  /** main with leads la and lb; wa and wc spawned parent-scoped under la, wb under lb */
  function leads() {
    const t = setup()
    t.claim("main", 1)
    t.claim("la", 2, [1])
    t.claim("lb", 3, [1])
    const spawn = (lead: string, name: string, pid: number) => t.claim(name, pid, [], { grant: t.core.grant(t.as(lead), { name, scope: "parent" }).token })
    spawn("la", "wa", 4)
    spawn("la", "wc", 5)
    spawn("lb", "wb", 6)
    return t
  }
  const widens = (core: RelayCore) =>
    core
      .log({ scope: true })
      .filter((row) => row.event === "scope_widen")
      .map((row) => [row.detail.target, row.detail.dir, row.detail.added])

  test("a widener with authority over both ends widens the other end's in side too, and both are audited", () => {
    const { core, as, send } = leads()
    expect(send("wa", "wc")).toBe("not_found")
    expect(core.rulesWiden(as("la"), { endpoint: "wa", out: ["ep:wc"] })).toEqual({
      added: ["ep:wc"],
      clipped: [],
      mirrored: [{ endpoint: "me/wc", dir: "in", added: ["ep:wa"] }],
    })
    expect(send("wa", "wc")).toBeUndefined()
    expect(widens(core)).toEqual([
      ["me/wa", "out", ["ep:wc"]],
      ["me/wc", "in", ["ep:wa"]],
    ])
    expect(core.rulesWiden(as("la"), { endpoint: "wc", in: ["ep:wa"] })).toEqual({ added: ["ep:wa"], clipped: [] })
  })

  test("an --in widening widens the other end's out side the same way", () => {
    const { core, as, send } = leads()
    expect(core.rulesWiden(as("la"), { endpoint: "wc", in: ["ep:wa"] }).mirrored).toEqual([{ endpoint: "me/wa", dir: "out", added: ["ep:wc"] }])
    expect(send("wa", "wc")).toBeUndefined()
  })

  test("without authority over the other end the widening applies and says that end still refuses, with the command that fixes it", () => {
    const { core, as, send } = leads()
    core.rulesSet(as("lb"), { in: ["ep:la", "ep:main"] })
    expect(core.rulesWiden(as("la"), { endpoint: "wa", out: ["ep:lb"] })).toEqual({
      added: ["ep:lb"],
      clipped: [],
      refused: [{ endpoint: "me/lb", dir: "in", fix: "swarm rules widen me/lb --in ep:wa" }],
    })
    expect(send("wa", "lb")).toBe("not_found")
    expect(widens(core)).toEqual([["me/wa", "out", ["ep:lb"]]])
  })

  test("an other end the widener does not see, or no endpoint at all, gets the same hint, which tells neither apart", () => {
    const { core, as, send } = leads()
    const hint = (name: string) => [{ endpoint: `me/${name}`, dir: "in" as const, fix: `swarm rules widen me/${name} --in ep:wa`, unseen: true as const }]
    expect(core.rulesWiden(as("la"), { endpoint: "wa", out: ["ep:wb"] }).refused).toEqual(hint("wb"))
    expect(core.rulesWiden(as("la"), { endpoint: "wa", out: ["ep:nobody"] }).refused).toEqual(hint("nobody"))
    expect(send("wa", "wb")).toBe("not_found")
    core.rulesWiden(as("lb"), { endpoint: "me/wb", in: ["ep:wa"] })
    expect(send("wa", "wb")).toBeUndefined()
  })
})

describe("group membership given by an adder with authority", () => {
  /** r, under it leads la and lb (tree); under la sla (tree) and wc (parent); under sla wa (parent); under lb wb (parent); each capped by its parent */
  function fleet() {
    const t = setup()
    t.claim("r", 1)
    t.claim("la", 2, [1])
    t.claim("sla", 3, [2, 1])
    t.claim("wa", 4, [3, 2, 1])
    t.claim("wc", 5, [2, 1])
    t.claim("lb", 6, [1])
    t.claim("wb", 7, [6, 1])
    for (const [by, endpoint, scope] of [
      ["r", "la", "tree"],
      ["la", "sla", "tree"],
      ["sla", "wa", "parent"],
      ["la", "wc", "parent"],
      ["r", "lb", "tree"],
      ["lb", "wb", "parent"],
    ] as const) {
      t.core.rulesSet(t.as(by), { endpoint, scope })
    }
    return t
  }

  test("the root's group admits its members to each other across sub-fleets, both ways, with fan-out and discovery, until a member leaves or the group drops", () => {
    const { core, as, ids, send } = fleet()
    expect(send("wa", "wb")).toBe("not_found")
    core.group(as("r"), { action: "create", name: "qa" })
    for (const m of ["wa", "wb"]) core.group(as("r"), { action: "add", name: "qa", endpoint: m })
    expect(send("wa", "wb")).toBeUndefined()
    const asked = core.send(ids.wb!, { to: "wa", body: "ping", kind: "request" })
    expect(send("wa", "wb", { kind: "reply", reply_to: asked.id })).toBeUndefined()
    expect(core.send(ids.wa!, { to: "group:qa", body: "all" }).deliveries.map((d) => d.address)).toEqual(["me/wb"])
    expect(core.list({ viewer: ids.wa! }).map((e) => e.address)).toContain("me/wb")
    expect(core.why(as("wa"), "wa", "wb")).toMatchObject({ allowed: true })
    expect(send("wa", "lb")).toBe("not_found")
    const rows = core.log().filter((row) => row.event === "scope_widen" && row.detail.group === "qa")
    expect(rows.map((row) => [row.endpoint, row.detail.dir, row.detail.via, row.detail.added])).toEqual([
      ["me/wa", "in", "me/r", ["group:qa"]],
      ["me/wa", "out", "me/r", ["group:qa"]],
      ["me/wb", "in", "me/r", ["group:qa"]],
      ["me/wb", "out", "me/r", ["group:qa"]],
    ])
    core.group(as("r"), { action: "remove", name: "qa", endpoint: "wb" })
    expect(send("wa", "wb")).toBe("not_found")
    expect(send("wb", "wa")).toBe("not_found")
    expect(JSON.stringify(core.scopeView(HUMAN, "wb").caps)).not.toContain("group:qa")
    core.group(as("r"), { action: "add", name: "qa", endpoint: "wb" })
    expect(send("wb", "wa")).toBeUndefined()
    core.group(as("r"), { action: "drop", name: "qa" })
    expect(send("wa", "wb")).toBe("not_found")
    expect(JSON.stringify(core.scopeView(HUMAN, "wa").caps)).not.toContain("group:qa")
  })

  test("an explicit widen to a group's selector outlives the member leaving that group", () => {
    const { core, as } = fleet()
    core.group(as("r"), { action: "create", name: "qa" })
    for (const m of ["wa", "wb"]) core.group(as("r"), { action: "add", name: "qa", endpoint: m })
    core.rulesWiden(as("r"), { endpoint: "wa", out: ["group:qa"] })
    core.group(as("r"), { action: "remove", name: "qa", endpoint: "wa" })
    expect(JSON.stringify(core.scopeView(HUMAN, "wa").caps)).toContain("group:qa")
  })

  test("a member's own join, and an add by one with no authority over the member, give no reach", () => {
    const { core, as, send } = fleet()
    core.group(as("r"), { action: "create", name: "open" })
    for (const m of ["wa", "wb"]) core.group(as(m), { action: "add", name: "open" })
    expect(send("wa", "wb")).toBe("not_found")
    expect(send("wb", "wa")).toBe("not_found")
    core.group(as("wa"), { action: "create", name: "mine" })
    core.group(as("wa"), { action: "add", name: "mine" })
    expect(code(() => core.group(as("wa"), { action: "add", name: "mine", endpoint: "wb" }))).toBe("not_found")
    expect(code(() => core.group(as("wb"), { action: "add", name: "mine" }))).toBe("not_found")
    core.group(as("la"), { action: "create", name: "crew" })
    expect(code(() => core.group(as("la"), { action: "add", name: "crew", endpoint: "wb" }))).toBe("not_found")
    expect(code(() => core.group(as("la"), { action: "add", name: "crew", endpoint: "lb" }))).toBe("not_found")
    expect(code(() => core.group(as("la", "lineage"), { action: "add", name: "crew", endpoint: "wa" }))).toBe("scope_refused")
    expect(send("wa", "wb")).toBe("not_found")
  })

  test("a lead's group admits its own descendants; caps by the human, the policy or above the adder still block, and it lapses with the adder", () => {
    const { core, db, as, ids, send } = fleet()
    core.group(as("la"), { action: "create", name: "crew" })
    for (const m of ["wa", "wc"]) core.group(as("la"), { action: "add", name: "crew", endpoint: m })
    expect(send("wa", "wc")).toBeUndefined()
    expect(send("wc", "wa")).toBeUndefined()
    const cap = core.rulesSet(as("r"), { endpoint: "wa", out: ["tree:parent"] }).caps.find((c) => c.by === "me/r")!
    expect(send("wa", "wc")).toBe("not_found")
    expect(send("wc", "wa")).toBeUndefined()
    core.rulesLift(as("r"), { endpoint: "wa", cap: cap.id })
    expect(send("wa", "wc")).toBeUndefined()
    core.rulesSet(HUMAN, { endpoint: "wc", in: [] })
    expect(send("wa", "wc")).toBe("not_found")
    const human = core.scopeView(HUMAN, "wc").caps.find((c) => c.by === "human")!
    core.rulesLift(HUMAN, { endpoint: "wc", cap: human.id })
    expect(send("wa", "wc")).toBeUndefined()
    core.setPolicy(parsePolicy({ rules: [{ match: "handle:wa", scope: ["tree:parent"] }] }))
    expect(send("wa", "wc")).toBe("not_found")
    core.setPolicy(parsePolicy({ rules: [] }))
    expect(send("wa", "wc")).toBeUndefined()
    db.run("UPDATE endpoints SET handle = '_gone_' || id WHERE id = ?", [ids.la!])
    expect(send("wa", "wc")).toBe("not_found")
  })

  test("a grant's group gives the same membership when its issuer had a session; from a plain shell it only narrows", () => {
    const { core, claim, as, send } = fleet()
    core.group(as("la"), { action: "create", name: "crew" })
    core.group(as("la"), { action: "add", name: "crew", endpoint: "wc" })
    claim("wd", 8, [2, 1], { grant: core.grant(as("la"), { scope: "parent", groups: ["crew"] }).token })
    claim("we", 9, [2, 1], { grant: core.grant(as("la", "lineage"), { scope: "parent", groups: ["crew"] }).token })
    expect(core.scopeView(HUMAN, "we").groups).toEqual(["crew"])
    expect(send("wd", "wc")).toBeUndefined()
    expect(send("wc", "wd")).toBeUndefined()
    expect(send("we", "wc")).toBe("not_found")
    expect(send("wc", "we")).toBe("not_found")
  })

  test("the root's membership is clipped like its widening: the human's quarantine of a member holds", () => {
    const { core, as, send } = fleet()
    core.group(as("r"), { action: "create", name: "qa" })
    for (const m of ["wa", "wb"]) core.group(as("r"), { action: "add", name: "qa", endpoint: m })
    core.rulesSet(HUMAN, { endpoint: "wa", out: [] })
    expect(send("wa", "wb")).toBe("not_found")
    expect(send("wb", "wa")).toBeUndefined()
    core.rulesSet(HUMAN, { endpoint: "wa", in: [] })
    expect(send("wb", "wa")).toBe("not_found")
    expect(send("wb", "group:qa")).toBe("not_found")
  })
})

describe("no leaks past the scope", () => {
  /** main, under it v and w; w may message only its parent, v may message w */
  function oneWay() {
    const t = setup()
    t.claim("main", 1)
    t.claim("v", 2, [1])
    t.claim("w", 3, [1])
    t.core.rulesSet(t.as("w"), { out: ["tree:parent"] })
    return t
  }

  test("group ls and show: the owner, members, admins and those with authority over the owner; members cut to what the viewer finds", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("orch-a", 2, [1])
    claim("a1", 3, [2, 1])
    claim("a3", 4, [2, 1])
    claim("orch-b", 5, [1])
    claim("b1", 6, [5, 1])
    core.group(as("orch-a"), { action: "create", name: "team-a", rules: ["group:self"] })
    for (const m of ["a1", "a3"]) core.group(as("orch-a"), { action: "add", name: "team-a", endpoint: m })
    core.rulesSet(as("a3"), { scope: "none" })
    expect(core.group(as("b1"), { action: "ls" })).toEqual([])
    expect(code(() => core.group(as("b1"), { action: "show", name: "team-a" }))).toBe("not_found")
    expect(code(() => core.group(as("orch-b"), { action: "show", name: "team-a" }))).toBe("not_found")
    const members = (actor: ScopeActor) => (core.group(actor, { action: "show", name: "team-a" }) as { members: string[] }).members
    expect(members(as("main"))).toEqual(["me/a1", "me/a3"])
    expect(members(as("orch-a"))).toEqual(["me/a1", "me/a3"])
    expect(members(as("a1"))).toEqual(["me/a1"])
    expect(members(as("a3"))).toEqual(["me/a3"])
    expect((core.group(as("a3"), { action: "ls" }) as { members: number }[]).map((g) => g.members)).toEqual([1])
  })

  test("log for a viewer drops rows that name an address it cannot see", () => {
    const { core, claim, as, ids } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("w", 3, [2, 1])
    core.rulesSet(as("w"), { scope: "parent" })
    const rows = core.log({ viewer: ids.w })
    expect(JSON.stringify(rows)).not.toContain("me/main")
    expect(rows.some((row) => row.event === "scope_place" && row.detail.target === "me/w")).toBe(true)
    expect(core.log({}).some((row) => row.detail.parent === "me/main")).toBe(true)
  })

  test("watch, activity and log visibility run both ways; list and peers stay what the viewer may message", () => {
    const { core, ids } = oneWay()
    core.event(ids.v!, { kind: "tool", tool: "Read" })
    expect(core.list({ viewer: ids.w }).map((view) => view.address)).not.toContain("me/v")
    expect(core.peers(ids.w!).map((peer) => peer.address)).not.toContain("me/v")
    expect(core.activity({ viewer: ids.w }).map((row) => row.endpoint)).toContain("me/v")
    expect([...core.visibleTo(ids.w!)]).toContain("me/v")
    expect(core.log({ viewer: ids.w }).some((row) => row.endpoint === "me/v")).toBe(true)
  })

  test("changing the scope of an endpoint the actor cannot find answers not_found, as for an unknown one", () => {
    const { core, as } = oneWay()
    core.group(as("w"), { action: "create", name: "mine" })
    const calls = (target: string) => [
      code(() => core.rulesWiden(as("w"), { endpoint: target, in: ["*"] })),
      code(() => core.rulesSet(as("w"), { endpoint: target, in: ["*"] })),
      code(() => core.rulesLift(as("w"), { endpoint: target, cap: "cap_x" })),
      code(() => core.group(as("w"), { action: "add", name: "mine", endpoint: target })),
      code(() => core.grant(as("w"), { under: target })),
    ]
    expect(calls("nobody")).toEqual(Array(5).fill("not_found"))
    expect(calls("v")).toEqual(calls("nobody"))
    expect(code(() => core.rulesWiden(as("w"), { endpoint: "main", in: ["*"] }))).toBe("scope_refused")
  })

  test("a policy group wins over a runtime group of its name, which is ignored and shown to the human", () => {
    const { core, claim, as, send } = setup()
    claim("main", 1)
    claim("a", 2, [1])
    claim("b", 3, [1])
    claim("c", 4, [1])
    core.group(as("a"), { action: "create", name: "reviewers" })
    core.group(as("a"), { action: "add", name: "reviewers" })
    core.group(HUMAN, { action: "add", name: "reviewers", endpoint: "c" })
    expect(send("a", "b")).toBeUndefined()
    core.setPolicy(parsePolicy({ rules: [], groups: [{ name: "reviewers", members: ["handle:a"], rules: ["group:self"] }] }))
    expect(core.scopeView(HUMAN, "a").groups).toEqual(["reviewers"])
    expect(core.scopeView(HUMAN, "c").groups).toEqual([])
    expect(send("a", "b")).toBe("not_found")
    expect(send("c", "b")).toBeUndefined()
    expect(core.group(HUMAN, { action: "show", name: "reviewers" })).toMatchObject({ policy: true, members: ["me/a"] })
    expect(core.group(HUMAN, { action: "ls" })).toEqual([
      { name: "reviewers", owner: "policy", members: 1, pinned: true, policy: true },
      { name: "reviewers", owner: "me/a", members: 2, pinned: false, policy: false, ignored: "a policy group has this name" },
    ])
    expect((core.group(as("a"), { action: "ls" }) as unknown[]).length).toBe(1)
  })

  test("an endpoint view names its parent only when the viewer can see it", () => {
    const { core, claim, as, ids } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("w", 3, [2, 1])
    core.rulesSet(as("w"), { scope: "parent" })
    const views = core.list({ viewer: ids.w })
    expect(views.find((view) => view.address === "me/orch")!.parent).toBeNull()
    expect(views.find((view) => view.address === "me/w")!.parent).toBe("me/orch")
    expect(core.list({}).find((view) => view.address === "me/orch")!.parent).toBe("me/main")
  })

  test("a delivery of a send to several addresses names only its own recipient; a fan-out keeps its target", () => {
    const { core, claim, as, ids } = setup()
    claim("r", 1)
    claim("c1", 2, [1])
    claim("c2", 3, [1])
    core.send(ids.r!, { to: ["c1", "me/c2"], body: "both" })
    expect(core.inbox(ids.c1!).map((m) => m.to)).toEqual(["me/c1"])
    expect(core.inbox(ids.c2!).map((m) => m.to)).toEqual(["me/c2"])
    core.group(as("r"), { action: "create", name: "crew" })
    for (const m of ["r", "c1", "c2"]) core.group(as("r"), { action: "add", name: "crew", endpoint: m })
    core.send(ids.r!, { to: "group:crew", body: "all" })
    expect(core.inbox(ids.c1!).map((m) => m.to)).toEqual(["me/c1", "group:crew"])
    core.send(ids.r!, { to: "tree:children", body: "kids" })
    expect(core.inbox(ids.c2!).map((m) => m.to)).toEqual(["me/c2", "group:crew", "tree:children"])
  })

  test("a reason names a widener the viewer cannot see only as an ancestor or admin", () => {
    const { core, claim, as, ids } = setup()
    claim("main", 1)
    claim("orch-a", 2, [1])
    claim("a1", 3, [2, 1])
    claim("a2", 4, [2, 1])
    claim("adm", 5)
    core.rulesSet(as("orch-a"), { endpoint: "a1", out: ["tree:parent"] })
    core.admin(HUMAN, { action: "grant", subject: "adm", tree: "main" })
    core.rulesWiden(as("adm"), { endpoint: "a1", out: ["tree:siblings"] })
    expect([...core.visibleTo(ids.a1!)]).not.toContain("me/adm")
    const reason = core.peers(ids.a1!).find((peer) => peer.address === "me/a2")!.reason
    expect(reason).toContain("via an ancestor or admin")
    expect(reason).not.toContain("me/adm")
    expect(core.why(as("a1"), "a1", "a2").reasons.join("; ")).not.toContain("me/adm")
    expect(core.why(HUMAN, "a1", "a2").reasons.join("; ")).toContain("via me/adm")
    core.rulesWiden(as("orch-a"), { endpoint: "a1", out: ["tree:root"] })
    expect(core.peers(ids.a1!).find((peer) => peer.address === "me/main")!.reason).toBe("your ancestor (tree:root via me/orch-a)")
  })

  test("a scope view and a group view name a hidden root, parent or widener only as the viewer sees them", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("w", 3, [2, 1])
    claim("adm", 4)
    core.rulesSet(as("w"), { scope: "parent" })
    core.admin(HUMAN, { action: "grant", subject: "adm", tree: "main" })
    core.rulesSet(as("orch"), { endpoint: "w", out: ["tree:parent"] })
    core.rulesWiden(as("adm"), { endpoint: "w", out: ["tree:root"] })
    core.group(as("orch"), { action: "create", name: "crew", rules: ["group:self", "tree:parent"] })
    core.group(as("orch"), { action: "add", name: "crew", endpoint: "w" })
    core.group(as("adm"), { action: "rules", name: "crew", rules: ["group:self", "tree:parent", "tree:root"] })
    const own = core.scopeView(as("w"))
    expect(own).toMatchObject({ address: "me/w", tree: null, parent: "me/orch" })
    expect(JSON.stringify(own)).not.toContain("me/main")
    expect(JSON.stringify(own)).not.toContain("me/adm")
    expect(JSON.stringify(own)).toContain("an ancestor or admin")
    const shown = core.group(as("w"), { action: "show", name: "crew" })
    expect(shown).toMatchObject({ tree: null })
    expect(JSON.stringify(shown)).not.toContain("me/main")
    expect(JSON.stringify(shown)).not.toContain("me/adm")
    expect(core.scopeView(HUMAN, "w")).toMatchObject({ tree: "me/main", parent: "me/orch" })
    expect(JSON.stringify(core.scopeView(HUMAN, "w"))).toContain("me/adm")
    expect(core.group(HUMAN, { action: "show", name: "crew" })).toMatchObject({
      tree: "me/main",
      rules: { out: [{ sel: "group:self" }, { sel: "tree:parent" }, { sel: "tree:root", via: "me/adm" }] },
    })
    core.rulesSet(as("w"), { scope: "none" })
    expect(core.scopeView(as("w"))).toMatchObject({ tree: null, parent: null })
  })

  test("a reply through a fan-out passes the original sender's in, and only its, each time", () => {
    const { core, claim, as, ids } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("w", 3, [2, 1])
    claim("q", 4)
    core.rulesSet(as("main"), { in: ["tree:children"] })
    core.rulesSet(as("q"), { in: [] })
    core.group(as("orch"), { action: "create", name: "crew" })
    core.group(as("orch"), { action: "add", name: "crew", endpoint: "w" })
    for (const m of ["main", "q"]) core.group(HUMAN, { action: "add", name: "crew", endpoint: m })
    const asked = core.send(ids.main!, { to: "w", body: "status?", kind: "request" })
    const reply = core.send(ids.w!, { to: "group:crew", body: "done", kind: "reply", reply_to: asked.id })
    expect(reply.deliveries.map((d) => d.address)).toEqual(["me/main"])
    expect(core.send(ids.w!, { to: "group:crew", body: "again", kind: "reply", reply_to: asked.id }).deliveries.map((d) => d.address)).toEqual(["me/main"])
  })
})

describe("the human without a terminal", () => {
  const NO_TTY: ScopeActor = { kind: "human", tty: false }

  /** main accepts only its children; w under it; open, another root with nothing set */
  function scoped() {
    const t = setup()
    t.claim("main", 1)
    t.claim("w", 2, [1])
    t.claim("open", 9)
    t.core.rulesSet(t.as("main"), { in: ["tree:children"] })
    return t
  }

  test("its sends get no scope exemption; the human at a terminal keeps it, and agents still reach the human", () => {
    const { core, ids } = scoped()
    const script = core.claimHuman(false).id
    expect(code(() => core.send(script, { to: "main", body: "x" }, { tty: false, unverified: true }))).toBe("not_found")
    expect(code(() => core.send(script, { to: "w", body: "x" }, { tty: false, unverified: true }))).toBeUndefined()
    expect(code(() => core.send(core.claimHuman(true).id, { to: "main", body: "x" }, { tty: true }))).toBeUndefined()
    expect(code(() => core.send(ids.main!, { to: "me/", body: "x" }))).toBeUndefined()
  })

  test("it sees only what it may message with no exemption", () => {
    const { core } = scoped()
    const script = core.claimHuman(false).id
    expect(
      core
        .list({ all: true, viewer: script })
        .map((e) => e.address)
        .sort(),
    ).toEqual(["me/", "me/open", "me/w"])
    expect(
      core
        .peers(script, { unverified: true })
        .map((p) => p.address)
        .sort(),
    ).toEqual(["me/open", "me/w"])
    expect(
      core
        .peers(script)
        .map((p) => p.address)
        .sort(),
    ).toEqual(["me/main", "me/open", "me/w"])
    expect(code(() => core.scopeView(NO_TTY, "main"))).toBe("not_found")
    expect(core.scopeView(NO_TTY, "w")).toMatchObject({ address: "me/w" })
    expect(code(() => core.why(NO_TTY, "w", "main"))).toBe("not_found")
    expect(core.why(NO_TTY, "w", "open")).toMatchObject({ allowed: true })
  })

  test("it sets no caps, mints no grants and runs no group or admin action; the human at a terminal does", () => {
    const { core } = scoped()
    expect(code(() => core.rulesSet(NO_TTY, { endpoint: "main", in: [] }))).toBe("scope_refused")
    expect(code(() => core.rulesSet(NO_TTY, { endpoint: "nobody", in: [] }))).toBe("scope_refused")
    expect(core.scopeView(HUMAN, "main").caps).toEqual([])
    expect(code(() => core.grant(NO_TTY, { under: "main" }))).toBe("scope_refused")
    expect(code(() => core.group(NO_TTY, { action: "ls" }))).toBe("scope_refused")
    expect(code(() => core.admin(NO_TTY, { action: "ls" }))).toBe("scope_refused")
    expect(core.rulesSet(HUMAN, { endpoint: "main", in: [] }).caps.map((cap) => cap.by)).toEqual(["human"])
    expect(core.grant(HUMAN, { under: "main" }).token).toMatch(/^krt_[0-9a-f]{64}$/)
  })

  test("a plain shell's grant keeps the policy's child default; a session's grant replaces it", () => {
    const { core, claim, as, send } = setup()
    core.setPolicy(parsePolicy({ rules: [], defaults: { child_default: "parent" } }))
    claim("main", 1)
    claim("other", 9)
    const shell = core.grant(as("main", "lineage"), { scope: "open", out: ["*"], in: ["*"] }).token
    claim("kid", 2, [], { grant: shell })
    expect(send("kid", "other")).toBe("not_found")
    expect(send("kid", "main")).toBeUndefined()
    const session = core.grant(as("main"), { out: ["*"], in: ["*"] }).token
    claim("kid2", 3, [], { grant: session })
    expect(send("kid2", "other")).toBeUndefined()
  })
})

describe("children inherit their parent's limits", () => {
  /** main, w under it capped by main to its parent and fleet x; x and y other roots, open */
  function capped() {
    const t = setup()
    t.claim("main", 10)
    t.claim("w", 20, [10])
    t.claim("x", 90)
    t.claim("y", 95)
    t.core.rulesSet(t.as("main"), { endpoint: "w", out: ["tree:parent", "fleet:x"] })
    return t
  }

  test("a child of a capped parent reaches only what its parent reaches, and the parent cannot lift that", () => {
    const { core, claim, as, send } = capped()
    expect(send("w", "x")).toBeUndefined()
    expect(send("w", "y")).toBe("not_found")
    expect(claim("kid", 50, [20, 10]).parent).toBe("me/w")
    expect(send("kid", "x")).toBeUndefined()
    expect(send("kid", "main")).toBeUndefined()
    expect(send("kid", "w")).toBeUndefined()
    expect(send("kid", "y")).toBe("not_found")
    expect(send("y", "kid")).toBe("not_found")
    const caps = core.scopeView(HUMAN, "kid").caps
    expect(caps.map((cap) => [cap.dir, cap.by, cap.sels])).toEqual([
      ["in", "inherited from me/w", [{ sel: "*", via: "me/w" }]],
      ["out", "inherited from me/w", [{ sel: "*", via: "me/w" }]],
    ])
    expect(code(() => core.rulesLift(as("w"), { endpoint: "kid", cap: caps[1]!.id }))).toBe("scope_refused")
  })

  test("in the worked example, a1's own CLI claim and a child of a1 reach nothing a1 cannot", () => {
    const { core, claim, as, send } = setup()
    claim("main", 10)
    core.rulesSet(as("main"), { in: ["tree:children"] })
    const allow = ["tree:parent", "tree:siblings", "tree:children"]
    claim("orch-a", 20, [10], { grant: core.grant(as("main"), { name: "orch-a", in: allow, out: allow }).token })
    core.group(as("orch-a"), { action: "create", name: "team-a", rules: ["group:self", "tree:parent"] })
    const g1 = core.grant(as("orch-a"), { name: "a1", groups: ["team-a"] }).token
    const a1 = claim("a1", 40, [20, 10], { grant: g1 }).id
    claim("bo-main", 90)
    expect(send("a1", "bo-main")).toBe("not_found")
    const shell = [41, 40, 20, 10].map(key)
    const again = core.claim({ handle: "a1", harness: "cli", lineage: shell, grant: g1 }).endpoint
    expect(again).toMatchObject({ address: "me/a1-2", parent: "me/a1" })
    const kid = core.claim({ handle: "kid", harness: "cli", lineage: shell }).endpoint
    expect(kid.parent).toBe("me/a1")
    const reach = (id: string) => core.peers(id).map((peer) => peer.address)
    const subtree = ["me/a1", again.address, kid.address]
    for (const id of [again.id, kid.id]) {
      expect(code(() => core.send(id, { to: "bo-main", body: "x" }))).toBe("not_found")
      expect(reach(id).filter((address) => !subtree.includes(address) && !reach(a1).includes(address))).toEqual([])
    }
  })

  test("narrowing the parent later shrinks the child", () => {
    const { core, claim, as, send } = capped()
    claim("kid", 50, [20, 10])
    expect(send("kid", "x")).toBeUndefined()
    core.rulesSet(as("main"), { endpoint: "w", out: ["tree:parent"] })
    expect(send("kid", "x")).toBe("not_found")
    expect(send("kid", "main")).toBeUndefined()
  })

  test("a capped parent's grant cannot widen its child past the parent", () => {
    const { core, claim, as, send } = capped()
    const token = core.grant(as("w"), { scope: "open", out: ["*"], in: ["*"] }).token
    expect(claim("kid", 50, [], { grant: token }).parent).toBe("me/w")
    expect(send("kid", "y")).toBe("not_found")
    expect(send("kid", "x")).toBeUndefined()
  })

  test("a child of a parent with no caps stays open, as does any child under child_default open", () => {
    const { core, claim, send } = capped()
    expect(claim("free", 60, [10]).scope).toBe("open")
    expect(send("free", "y")).toBeUndefined()
    core.setPolicy(parsePolicy({ rules: [], defaults: { child_default: "open" } }))
    expect(claim("loose", 70, [20, 10]).scope).toBe("open")
    expect(send("loose", "y")).toBeUndefined()
    expect(parsePolicy({ rules: [], defaults: { child_default: "inherit" } }).defaults).toEqual({ child_default: "inherit" })
  })

  test("a parent capped by the human or by a group passes the cap on, which the parent and its capper cannot lift", () => {
    const { core, claim, as, send } = setup()
    claim("main", 10)
    claim("y", 95)
    core.rulesSet(HUMAN, { endpoint: "main", out: ["tree:self"] })
    expect(claim("kid", 20, [10]).parent).toBe("me/main")
    expect(send("kid", "y")).toBe("not_found")
    expect(core.scopeView(HUMAN, "kid").caps.map((cap) => cap.by)).toEqual(["inherited from me/main", "inherited from me/main"])
    expect(code(() => core.rulesLift(as("main"), { endpoint: "kid", cap: core.scopeView(HUMAN, "kid").caps[0]!.id }))).toBe("scope_refused")
    const t = setup()
    t.claim("root", 1)
    t.claim("o", 2, [1])
    t.claim("w", 3, [2, 1])
    t.core.group(t.as("o"), { action: "create", name: "crew", rules: ["group:self", "tree:parent"] })
    t.core.group(t.as("o"), { action: "add", name: "crew", endpoint: "w" })
    expect(t.claim("v", 4, [3, 2, 1]).parent).toBe("me/w")
    expect(t.send("v", "root")).toBe("not_found")
    expect(t.send("v", "o")).toBeUndefined()
    const caps = t.core.scopeView(HUMAN, "v").caps
    expect(caps.map((cap) => cap.by)).toEqual(["inherited from me/w", "inherited from me/w"])
    expect(code(() => t.core.rulesLift(t.as("w"), { endpoint: "v", cap: caps[0]!.id }))).toBe("scope_refused")
    expect(code(() => t.core.rulesLift(t.as("o"), { endpoint: "v", cap: caps[0]!.id }))).toBe("scope_refused")
  })

  /** main, w under it, kid under w, y another root: nothing capped yet */
  function placed() {
    const t = setup()
    t.claim("main", 10)
    t.claim("w", 20, [10])
    t.claim("kid", 50, [20, 10])
    t.claim("y", 95)
    expect(t.send("kid", "y")).toBeUndefined()
    return t
  }

  test("capping a parent after its child is placed contains the child at its next send", () => {
    const a = placed()
    a.core.rulesSet(a.as("main"), { endpoint: "w", out: ["tree:parent"] })
    expect(a.send("kid", "y")).toBe("not_found")
    expect(a.send("kid", "main")).toBeUndefined()
    const b = placed()
    b.core.group(b.as("main"), { action: "create", name: "crew", rules: ["group:self", "tree:parent"] })
    b.core.group(b.as("main"), { action: "add", name: "crew", endpoint: "w" })
    expect(b.send("kid", "y")).toBe("not_found")
    const c = placed()
    c.core.rulesSet(HUMAN, { endpoint: "main", out: ["tree:self"] })
    expect(c.send("kid", "y")).toBe("not_found")
    expect(c.send("y", "kid")).toBe("not_found")
  })

  test("an inherited cap is derived, named after the parent, widened only within the widener's reach, and lifted only by the human at a terminal", () => {
    const { core, claim, as, send } = placed()
    claim("adm", 99)
    core.rulesSet(as("main"), { endpoint: "w", out: ["tree:parent"] })
    core.admin(HUMAN, { action: "grant", subject: "adm", tree: "main" })
    const caps = core.scopeView(HUMAN, "kid").caps
    expect(caps.map((cap) => [cap.id, cap.dir, cap.by, cap.sels])).toEqual([
      ["inherited:in", "in", "inherited from me/w", [{ sel: "*", via: "me/w" }]],
      ["inherited:out", "out", "inherited from me/w", [{ sel: "*", via: "me/w" }]],
    ])
    expect(core.why(HUMAN, "kid", "y").reasons.join(" ")).toContain("inherited")
    expect(core.rulesWiden(as("w"), { endpoint: "kid", out: ["*"] }).added).toEqual(["*"])
    expect(send("kid", "y")).toBe("not_found")
    for (const actor of [as("w"), as("main"), as("adm"), { kind: "human" as const, tty: false }]) {
      expect(code(() => core.rulesLift(actor, { endpoint: "kid", cap: "inherited:out" }))).toBe("scope_refused")
    }
    expect(send("kid", "y")).toBe("not_found")
    core.rulesLift(HUMAN, { endpoint: "kid", cap: "inherited:in" })
    core.rulesLift(HUMAN, { endpoint: "kid", cap: "inherited:out" })
    expect(core.scopeView(HUMAN, "kid").caps).toEqual([])
    expect(
      core
        .log({ scope: true })
        .filter((row) => row.event === "scope_lift")
        .at(-1),
    ).toMatchObject({ detail: { target: "me/kid", auth: "tty" } })
    expect(send("kid", "y")).toBeUndefined()
    expect(claim("grandkid", 60, [50, 20, 10]).scope).toBe("open")
    expect(send("grandkid", "y")).toBeUndefined()
    core.rulesSet(as("w"), { endpoint: "kid", out: ["tree:self"] })
    expect(send("kid", "y")).toBe("not_found")
  })

  test("deriving inherited caps down a chain costs queries linear in its depth", () => {
    const cost = (depth: number) => {
      const { core, claim, as, send, stats } = setup()
      claim("n0", 100)
      claim("n1", 101, [100])
      core.rulesSet(as("n0"), { endpoint: "n1", out: ["tree:parent", "tree:descendants"] })
      for (let i = 2; i <= depth; i++) claim(`n${i}`, 100 + i, [99 + i])
      const before = stats.queries
      expect(send(`n${depth}`, "n0")).toBeUndefined()
      return stats.queries - before
    }
    expect(cost(24)).toBeLessThan(cost(8) * 4)
  })

  test("the human lifts an inherited cap per direction, by the id the view shows", () => {
    const { core, as, send } = placed()
    core.rulesSet(as("main"), { endpoint: "w", out: ["tree:parent"] })
    expect(send("kid", "y")).toBe("not_found")
    core.rulesLift(HUMAN, { endpoint: "kid", cap: "inherited:in" })
    expect(core.scopeView(HUMAN, "kid").caps.map((cap) => cap.id)).toEqual(["inherited:out"])
    expect(send("kid", "y")).toBe("not_found")
    for (const cap of ["inherited:in", "inherited"]) expect(code(() => core.rulesLift(HUMAN, { endpoint: "kid", cap }))).toBe("not_found")
    core.rulesLift(HUMAN, { endpoint: "kid", cap: "inherited:out" })
    expect(core.scopeView(HUMAN, "kid").caps).toEqual([])
    expect(send("kid", "y")).toBeUndefined()
  })

  test("a released parent keeps its child limited to the parent's subtree, and the human can lift that", () => {
    const { core, claim, as, send, db, ids } = placed()
    claim("sib", 30, [20, 10])
    core.rulesSet(as("main"), { endpoint: "w", out: ["tree:parent"] })
    db.query(`UPDATE endpoints SET handle = '_gone_' || id WHERE id = ?`).run(ids.w!)
    expect(send("kid", "y")).toBe("not_found")
    expect(send("kid", "main")).toBe("not_found")
    expect(send("kid", "sib")).toBeUndefined()
    db.query(`DELETE FROM endpoints WHERE id = ?`).run(ids.w!)
    expect(send("kid", "y")).toBe("not_found")
    expect(send("kid", "sib")).toBeUndefined()
    core.rulesLift(HUMAN, { endpoint: "kid", cap: "inherited:in" })
    core.rulesLift(HUMAN, { endpoint: "kid", cap: "inherited:out" })
    expect(send("kid", "y")).toBeUndefined()
  })

  test("an allowance widened into an inherited cap lapses with its widener; only the base entry keeps a released parent's subtree", () => {
    const { core, claim, as, send, db, ids } = placed()
    claim("sib2", 30, [10])
    core.rulesSet(as("main"), { endpoint: "w", out: ["tree:parent"] })
    expect(send("kid", "sib2")).toBe("not_found")
    core.rulesWiden(as("main"), { endpoint: "kid", out: ["handle:sib2"] })
    expect(send("kid", "sib2")).toBeUndefined()
    db.query(`UPDATE endpoints SET handle = '_gone_' || id WHERE id = ?`).run(ids.main!)
    expect(send("kid", "sib2")).toBe("not_found")
    expect(send("kid", "w")).toBeUndefined()
  })
})

describe("exact claims", () => {
  /** an exact CLI claim of `handle` from a shell whose ancestors are `lineage` (pids, nearest first) */
  const exact = (core: RelayCore, handle: string, lineage: number[], harness = "cli") =>
    core.claim({ handle, harness, lineage: lineage.map(key), exact: true }).endpoint

  test("an exact claim takes over an offline endpoint as before, and joins a CLI identity from its place, online or not", () => {
    const { core, claim, ids } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    core.disconnect(ids.w!)
    expect(core.claim({ handle: "w", harness: "codex", lineage: [3, 1].map(key), exact: true }).endpoint.id).toBe(ids.w!)
    const lane = exact(core, "lane", [5, 1])
    expect(lane.parent).toBe("me/main")
    const joined = exact(core, "lane", [6, 1])
    expect(joined).toMatchObject({ id: lane.id, presence: "online" })
    core.disconnect(lane.id)
    core.disconnect(lane.id)
    expect(core.whoami(lane.id).presence).toBe("offline")
    expect(exact(core, "lane", [7, 1]).id).toBe(lane.id)
    expect(core.list({ all: true }).map((e) => e.address)).toEqual(["me/", "me/lane", "me/main", "me/w"])
  })

  test("an exact claim joining a live CLI identity leaves its holder's resume token in place", () => {
    const { core, claim } = setup()
    claim("main", 1)
    const held = core.claim({ handle: "lane", harness: "cli", lineage: [5, 1].map(key), exact: true })
    const joined = core.claim({ handle: "lane", harness: "cli", lineage: [6, 1].map(key), exact: true })
    expect(joined.endpoint.id).toBe(held.endpoint.id)
    expect(core.resume(held.token!).id).toBe(held.endpoint.id)
    expect(joined.token).toBeUndefined()
  })

  test("an exact claim never suffixes: a live harness session, another harness or another place is refused with the reason", () => {
    const { core, claim } = setup()
    claim("main", 1)
    claim("w", 2, [1])
    core.claim({ handle: "bo", harness: "claude-code", session: key(50), process: key(50), lineage: [key(50)] }, { transient: true })
    core.claim({ handle: "cx", harness: "codex", lineage: [9, 1].map(key) })
    exact(core, "lane", [5, 1])
    const refused = (handle: string, lineage: number[], reason: RegExp) => {
      expect(code(() => exact(core, handle, lineage))).toBe("unauthorized")
      expect(() => exact(core, handle, lineage)).toThrow(reason)
    }
    refused("bo", [60], /live claude-code session/)
    refused("cx", [8, 1], /codex endpoint.*--harness/)
    refused("lane", [70], /another tree or under another parent/)
    refused("lane", [6, 2, 1], /another tree or under another parent/)
    expect(core.list({ all: true }).some((e) => /-\d+$/.test(e.address))).toBe(false)
    expect(core.claim({ handle: "lane", harness: "cli", lineage: [key(70)] }).endpoint.address).toBe("me/lane-2")
    expect(core.claim({ handle: "bo", harness: "cli" }).endpoint.address).toBe("me/bo-2")
  })

  test("a lineage with a handle binds to that handle among the endpoints holding the first matching key, never further up", () => {
    const { core, claim, ids } = setup()
    claim("main", 1)
    const lane = core.claim({ handle: "lane", harness: "cli", process: key(1), lineage: [key(1)] }).endpoint
    claim("w", 2, [1])
    expect(core.placeLineage([9, 1].map(key))).toBe(ids.main!)
    expect(core.placeLineage([9, 1].map(key), "lane")).toBe(lane.id)
    expect(core.placeLineage([9, 1].map(key), "main")).toBe(ids.main!)
    expect(core.placeLineage([9, 1].map(key), "w")).toBeNull()
    expect(core.placeLineage([9, 2, 1].map(key), "lane")).toBeNull()
    expect(core.placeLineage([9, 2, 1].map(key), "w")).toBe(ids.w!)
  })
})

describe("snapshot unread", () => {
  test("counts unacked, unexpired mail per endpoint the viewer sees, and only counts above zero", () => {
    const { core, claim, ids, clock } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("w", 3, [2, 1], { scope: "parent" })
    core.send(ids.orch!, { to: "main", body: "up" })
    core.send(ids.orch!, { to: "w", body: "down" })
    core.send(ids.orch!, { to: "w", body: "short", ttl_s: 60 })
    core.send(ids.w!, { to: "orch", body: "back" })
    expect(core.snapshot().unread).toEqual({ "me/main": 1, "me/orch": 1, "me/w": 2 })
    expect(core.snapshot({ viewer: ids.w! }).unread).toEqual({ "me/orch": 1, "me/w": 2 })
    clock.now += 61_000
    core.ack(
      ids.orch!,
      core.inbox(ids.orch!).map((m) => m.seq),
    )
    expect(core.snapshot({ viewer: ids.w! }).unread).toEqual({ "me/w": 1 })
  })
})
