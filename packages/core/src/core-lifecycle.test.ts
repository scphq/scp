import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { shownRows } from "./mcp-tools"
import { parsePolicy } from "./policy"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const HUMAN: ScopeActor = { kind: "human", tty: true }
const BEYOND = (handle: string) =>
  `out(me/${handle}) has the default reach: its own tree and the roots; only the human, the policy or a widening reaches further`

function setup(options: { historicAfterS?: number } = {}) {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    ...options,
  })
  core.migrate()
  const ids: Record<string, string> = {}
  const claim = (handle: string, pid: number, parents: number[] = []) => {
    ids[handle] = core.claim({ handle, harness: "codex", process: key(pid), lineage: [key(pid), ...parents.map(key)] }).endpoint.id
    return ids[handle]!
  }
  const as = (handle: string): ScopeActor => ({ kind: "endpoint", id: ids[handle]!, auth: "session" })
  const send = (from: string, to: string, extra: Record<string, unknown> = {}) => {
    try {
      core.send(ids[from]!, { to, body: `${from} to ${to}`, ...extra })
      return undefined
    } catch (error) {
      if (error instanceof RelayError) return error.code
      throw error
    }
  }
  return { core, clock, ids, claim, as, send }
}

/** two trees: main over w, and r over v */
function trees() {
  const t = setup()
  t.claim("main", 1)
  t.claim("w", 2, [1])
  t.claim("r", 3)
  t.claim("v", 4, [3])
  return t
}

describe("the default reach", () => {
  test("an agent with no list reaches its own tree, every root and the human; another tree's child not at all", () => {
    const { core, send } = trees()
    expect(send("w", "main")).toBeUndefined()
    expect(send("w", "r")).toBeUndefined()
    expect(send("w", "me/")).toBeUndefined()
    expect(send("w", "v")).toBe("not_found")
    expect(send("main", "v")).toBe("not_found")
    expect(send("v", "main")).toBeUndefined()
    expect(core.why(HUMAN, "w", "v").reasons).toEqual([BEYOND("w")])
    expect(core.why(HUMAN, "w", "r").reasons).toEqual(["out(me/w) has the default reach", "in(me/r) is open"])
  })

  test("an agent's own rules, its group and an agent's cap narrow within the default reach; the human, the policy or a widening reach further", () => {
    const { core, as, claim, send } = trees()
    claim("q", 5, [3])
    core.rulesSet(as("r"), { out: ["*"] })
    expect(send("r", "w")).toBe("not_found")
    expect(core.why(HUMAN, "r", "w").reasons).toEqual([BEYOND("r")])
    expect(send("r", "main")).toBeUndefined()
    core.group(as("main"), { action: "create", name: "wide", rules: ["*"] })
    core.group(as("main"), { action: "add", name: "wide", endpoint: "main" })
    expect(send("main", "v")).toBe("not_found")
    core.rulesSet(as("main"), { endpoint: "w", out: ["*"] })
    expect(send("w", "v")).toBe("not_found")
    core.rulesWiden(HUMAN, { endpoint: "w", out: ["ep:v"] })
    expect(send("w", "v")).toBeUndefined()
    core.rulesSet(HUMAN, { endpoint: "v", out: ["*"] })
    expect(send("v", "w")).toBeUndefined()
    expect(send("q", "w")).toBe("not_found")
    core.setPolicy(parsePolicy({ rules: [{ match: "handle:q", scope: ["*"] }] }))
    expect(send("q", "w")).toBeUndefined()
  })

  test("a root does not see another tree's child that may message it, yet reads and answers its message", () => {
    const { core, ids, send } = trees()
    const seen = (viewer: string) => core.list({ all: true, viewer: ids[viewer] }).map((view) => view.address)
    expect(seen("r")).toEqual(expect.arrayContaining(["me/main", "me/r", "me/v"]))
    expect(seen("r")).not.toContain("me/w")
    expect(core.peers(ids.r!).map((peer) => peer.address)).not.toContain("me/w")
    expect([...core.visibleTo(ids.r!)]).not.toContain("me/w")
    expect(seen("w")).toEqual(expect.arrayContaining(["me/main", "me/r", "me/w"]))
    expect(seen("w")).not.toContain("me/v")
    const sent = core.send(ids.w!, { to: "r", body: "from another tree" })
    expect(core.inbox(ids.r!).map((message) => message.id)).toEqual([sent.id])
    expect(send("r", "w")).toBe("not_found")
    expect(send("r", "w", { kind: "reply", reply_to: sent.id })).toBeUndefined()
  })

  test("a child with a list of its own that admits a root is seen by that root", () => {
    const { core, ids, as } = trees()
    expect([...core.visibleTo(ids.r!)]).not.toContain("me/w")
    core.rulesSet(as("w"), { out: ["tree:self", "ep:r"] })
    expect([...core.visibleTo(ids.r!)]).toContain("me/w")
  })
})

describe("historic agents", () => {
  test("an agent idle for historicAfterS leaves list, peers and snapshots unless asked for; its row, mail and reach stay", () => {
    const { core, clock, ids, claim, send } = setup()
    claim("lead", 1)
    claim("old", 2)
    const human = core.humanId()
    expect(core.whoami(ids.old!)).toMatchObject({ active_at: new Date(clock.now).toISOString() })
    expect(core.whoami(ids.old!).historic).toBeUndefined()
    clock.now += LIMITS.historicAfterS * 1000
    expect(core.whoami(ids.old!)).toMatchObject({ historic: true })
    expect(core.whoami(human).historic).toBeUndefined()
    expect(core.list().map((view) => view.address)).toEqual(["me/"])
    expect(
      core
        .list({ historic: true })
        .filter((view) => view.historic)
        .map((view) => view.address),
    ).toEqual(["me/lead", "me/old"])
    expect(core.list({ all: true }).map((view) => view.address)).toContain("me/old")
    expect(core.snapshot().endpoints.map((view) => view.address)).toEqual(["me/"])
    expect(core.snapshot({ all: true }).endpoints.map((view) => view.address)).toContain("me/old")
    core.touch(ids.lead!)
    expect(core.peers(ids.lead!).map((peer) => peer.address)).toEqual(["me/"])
    expect(core.peers(ids.lead!, { historic: true }).find((peer) => peer.address === "me/old")).toMatchObject({ historic: true })
    expect(core.peers(ids.lead!, { all: true }).map((peer) => peer.address)).toContain("me/old")
    expect(send("lead", "old")).toBeUndefined()
    expect(core.whoami(ids.old!)).toMatchObject({ active_at: new Date(clock.now).toISOString() })
    expect(core.list().map((view) => view.address)).toEqual(["me/", "me/lead", "me/old"])
    expect(core.inbox(ids.old!).map((message) => message.body.text)).toEqual(["lead to old"])
  })

  test("snapshot activity only includes listed endpoints, with the limit applied after filtering", () => {
    const { core, clock, ids, claim } = setup()
    claim("old", 1)
    claim("fresh", 2)
    core.event(ids.fresh!, { kind: "tool", tool: "read" })
    core.event(ids.old!, { kind: "tool", tool: "write" })
    clock.now += LIMITS.historicAfterS * 1000
    core.touch(ids.fresh!)
    expect(core.snapshot({ activity: 1 }).activity.map((event) => event.endpoint)).toEqual(["me/fresh"])
    expect(core.snapshot({ all: true }).activity.map((event) => event.endpoint)).toEqual(["me/fresh", "me/old"])
    expect(core.snapshot({ historic: true }).activity.map((event) => event.endpoint)).toEqual(["me/fresh", "me/old"])
    clock.now += LIMITS.historicAfterS * 1000
    expect(core.snapshot().activity).toEqual([])
  })

  test("a hibernated agent idle for historicAfterS leaves the default list, and comes back with historic or Infinity", () => {
    for (const historicAfterS of [LIMITS.historicAfterS, Number.POSITIVE_INFINITY]) {
      const { core, clock, ids, claim } = setup({ historicAfterS })
      claim("sleeper", 1)
      claim("awake", 2)
      core.hibernate(HUMAN, { endpoint: "sleeper", wake: "vm-sleep" })
      clock.now += LIMITS.historicAfterS * 1000
      core.touch(ids.awake!)
      const listed = core.list().map((view) => view.address)
      expect(listed.includes("me/sleeper")).toBe(historicAfterS === Number.POSITIVE_INFINITY)
      expect(listed).toContain("me/awake")
      expect(core.list({ historic: true }).map((view) => view.address)).toContain("me/sleeper")
    }
  })

  test("a call or a read counts as activity; Infinity makes no agent historic", () => {
    const { core, clock, ids, claim, send } = setup()
    claim("a", 1)
    claim("b", 2)
    clock.now += LIMITS.historicAfterS * 1000
    core.touch(ids.a!)
    expect(core.whoami(ids.a!).historic).toBeUndefined()
    expect(send("a", "b")).toBeUndefined()
    clock.now += LIMITS.historicAfterS * 1000
    expect(core.whoami(ids.b!).historic).toBe(true)
    core.inbox(ids.b!)
    expect(core.whoami(ids.b!).historic).toBeUndefined()
    const never = setup({ historicAfterS: Number.POSITIVE_INFINITY })
    never.claim("a", 1)
    never.clock.now += 365 * 86_400_000
    expect(never.core.whoami(never.ids.a!).historic).toBeUndefined()
  })
})

test("the list and peers tools hide historic agents apart from offline ones, and count each", () => {
  const rows = [
    { kind: "human", presence: "offline" },
    { kind: "agent", presence: "online" },
    { kind: "agent", presence: "offline" },
    { kind: "agent", presence: "offline", historic: true as const },
  ]
  expect(shownRows(rows, { all: false, historic: false, human: true })).toEqual({
    shown: rows.slice(0, 2),
    notes: ["1 offline hidden (all: true lists them)", "1 historic hidden (historic: true lists them)"],
  })
  expect(shownRows(rows, { all: false, historic: true }).shown).toEqual([rows[1]!, rows[3]!])
  expect(shownRows(rows, { all: true, historic: false })).toEqual({ shown: rows, notes: [] })
})
