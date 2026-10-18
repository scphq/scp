import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { type Envelope, parsePolicy, RelayError, type ScopeActor, type Sql, type SqlValue } from "@scp-dev/core"
import { FederatedCore, type FederatedOptions } from "./federation"

function setup(options: Partial<FederatedOptions>, db = new Database(":memory:")) {
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new FederatedCore(sql, {
    now: () => 1_800_000_000_000,
    hash: (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: (fn) => db.transaction(fn)(),
    ...options,
  })
  core.migrate()
  return core
}

/** a laptop broker with a scoped agent `fenced` (tree preset) and an open one, the account's hub, and desk's agent and human on both */
function world() {
  const broker = setup({ machine: "laptop", aliases: ["ada"] })
  const hub = setup({ user: "ada", auth: "account", capEverySender: true })
  const fenced = broker.claim({ handle: "fenced", harness: "claude-code", scope: "tree" }).endpoint.id
  const open = broker.claim({ handle: "open", harness: "claude-code" }).endpoint.id
  const views = [
    { address: "me/review", kind: "agent", harness: "codex", presence: "online" },
    { address: "me/", kind: "human", presence: "online" },
  ]
  hub.mirror("laptop", [
    { address: "me/fenced", kind: "agent", presence: "online" },
    { address: "me/open", kind: "agent", presence: "online" },
  ])
  hub.mirror("desk", views)
  broker.mirror(
    "desk",
    views.map((v) => ({ ...v, address: `ada/desk/${v.address.slice(3)}` })),
  )
  const fromHub = (from: string, to: string, extra: Record<string, unknown> = {}, tty?: boolean): Envelope => {
    const sent = hub.send(from, { to, body: "x", ...extra }, tty === undefined ? {} : { tty })
    return hub.delivery(sent.deliveries[0]!.seq)!.message
  }
  return { broker, hub, fenced, open, fromHub }
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

describe("scopes with other machines", () => {
  test("another machine's row is another fleet: a scoped endpoint reaches it only by a leaving selector, an open one as before", () => {
    const { broker, fenced, open } = world()
    for (const to of ["desk/review", "desk/"]) {
      expect(code(() => broker.scopeCheck(fenced, to))).toBe("not_found")
      expect(code(() => broker.send(fenced, { to, body: "x" }))).toBe("not_found")
      expect(code(() => broker.scopeCheck(open, to))).toBeUndefined()
    }
    expect(broker.log({ limit: 1 })[0]).toMatchObject({ event: "scope_refused" })
    broker.rulesSet({ kind: "endpoint", id: fenced, auth: "session" }, { scope: "tree", allow: ["kind:agent"] })
    expect(code(() => broker.scopeCheck(fenced, "desk/review"))).toBe("not_found")
    expect(broker.why({ kind: "human", tty: true }, "fenced", "desk/review").reasons.at(-1)).toContain("only within its own fleet")
    broker.rulesSet({ kind: "endpoint", id: fenced, auth: "session" }, { scope: "tree", allow: ["machine:desk"] })
    expect(code(() => broker.scopeCheck(fenced, "desk/review"))).toBeUndefined()
    expect(code(() => broker.scopeCheck(fenced, "me/"))).toBeUndefined()
  })

  test("a hub delivery from another machine to a scoped endpoint is refused as not_found, except a reply to its own message", () => {
    const { broker, hub, fenced, open, fromHub } = world()
    const review = hub.remoteEndpoint("desk", "review")
    expect(code(() => broker.inboundRefusal(fenced, fromHub(review, "laptop/fenced")))).toBe("not_found")
    expect(broker.inboundRefusal(open, fromHub(review, "laptop/open"))).toBeNull()
    broker.rulesSet({ kind: "endpoint", id: fenced, auth: "session" }, { scope: "tree", allow: ["machine:desk"] })
    const params = { to: "desk/review", body: "review this", kind: "request" as const }
    const ask = hub.send(hub.remoteEndpoint("laptop", "fenced"), params)
    broker.recordForward(fenced, params, ask)
    broker.rulesSet({ kind: "endpoint", id: fenced, auth: "session" }, { scope: "tree" })
    const reply = fromHub(review, "laptop/fenced", { kind: "reply", reply_to: ask.id })
    expect(broker.inboundRefusal(fenced, reply)).toBeNull()
    broker.admit(fenced, reply)
    expect(broker.inboundRefusal(fenced, reply)).toBeNull()
    expect(broker.inboundRefusal(fenced, fromHub(review, "laptop/fenced", { kind: "reply", reply_to: ask.id }))).toBeNull()
    expect(code(() => broker.inboundRefusal(fenced, fromHub(review, "laptop/fenced", { kind: "message", reply_to: ask.id })))).toBe("not_found")
    expect(code(() => broker.inboundRefusal(fenced, fromHub(hub.remoteEndpoint("desk", "other"), "laptop/fenced", { kind: "reply", reply_to: ask.id })))).toBe(
      "not_found",
    )
  })

  test("a reply to another machine's message the endpoint got passes the scope where an unsolicited send is refused", () => {
    const { broker, hub, fenced, open, fromHub } = world()
    const review = hub.remoteEndpoint("desk", "review")
    const got = fromHub(review, "laptop/fenced", { kind: "request" })
    broker.admit(fenced, got)
    const elsewhere = fromHub(review, "laptop/open", { kind: "request" })
    broker.admit(open, elsewhere)
    expect(code(() => broker.scopeCheck(fenced, "desk/review"))).toBe("not_found")
    expect(code(() => broker.scopeCheck(fenced, "desk/review", got.id))).toBeUndefined()
    expect(code(() => broker.scopeCheck(fenced, "desk/", got.id))).toBe("not_found")
    expect(code(() => broker.scopeCheck(fenced, "desk/review", elsewhere.id))).toBe("not_found")
    expect(code(() => broker.scopeCheck(fenced, "desk/review", "msg_unknown0000"))).toBe("not_found")
  })

  test("the human exemption is the account's own human endpoint, never a tty claim: another machine's human row is not exempt", () => {
    const { broker, hub, fenced, fromHub } = world()
    const human = broker.claimHuman(false).id
    expect(code(() => broker.send(human, { to: "fenced", body: "x" }))).toBeUndefined()
    expect(code(() => broker.send(fenced, { to: "me/", body: "x" }))).toBeUndefined()
    const platform = hub.claimHuman(false).id
    expect(broker.inboundRefusal(fenced, fromHub(platform, "laptop/fenced", {}, false))).toBeNull()
    const desk = hub.remoteEndpoint("desk", "")
    expect(code(() => broker.inboundRefusal(fenced, fromHub(desk, "laptop/fenced", {}, true)))).toBe("not_found")
    expect(code(() => broker.scopeCheck(fenced, "desk/"))).toBe("not_found")
    expect(broker.why({ kind: "human", tty: true }, "desk/", "fenced").allowed).toBe(false)
    expect(broker.why({ kind: "human", tty: true }, "me/ada/", "fenced").reasons).toEqual(["the human is always reachable"])
  })

  test("another machine's row is no scope or group target here, and a fan-out never reaches one", () => {
    const { broker, open } = world()
    const human = { kind: "human", tty: true } as const
    broker.group(human, { action: "create", name: "crew" })
    for (const target of ["desk/review", "ada/desk/review"]) {
      expect(code(() => broker.group(human, { action: "add", name: "crew", endpoint: target }))).toBe("not_found")
      expect(code(() => broker.rulesSet(human, { endpoint: target, in: ["*"] }))).toBe("not_found")
      expect(code(() => broker.rulesWiden(human, { endpoint: target, in: ["*"] }))).toBe("not_found")
      expect(code(() => broker.rulesLift(human, { endpoint: target, cap: "cap_x" }))).toBe("not_found")
      expect(code(() => broker.grant(human, { under: target }))).toBe("not_found")
      expect(code(() => broker.scopeView(human, target))).toBe("not_found")
    }
    broker.group(human, { action: "add", name: "crew", endpoint: "open" })
    const sql = (broker as unknown as { sql: Sql }).sql
    sql.all(`INSERT INTO group_members (name, endpoint, added_by, at) VALUES (?, ?, 'human', 0)`, "crew", broker.remoteEndpoint("desk", "review"))
    expect(code(() => broker.send(open, { to: "group:crew", body: "x" }))).toBe("not_found")
  })

  test("a scoped viewer's log drops rows naming another machine's endpoint it cannot see, in the hub's address form too", () => {
    const { broker, hub, fenced, fromHub } = world()
    const session = { kind: "endpoint", id: fenced, auth: "session" } as const
    broker.rulesSet(session, { scope: "tree", allow: ["machine:desk"] })
    const params = { to: "desk/review", body: "x" }
    broker.recordForward(fenced, params, hub.send(hub.remoteEndpoint("laptop", "fenced"), params))
    broker.admit(fenced, fromHub(hub.remoteEndpoint("desk", "review"), "laptop/fenced"))
    const crossing = (viewer?: string) => broker.log(viewer ? { viewer } : {}).filter((row) => row.event === "forward" || row.event === "inject")
    expect(crossing(fenced).map((row) => row.event)).toEqual(["forward", "inject"])
    expect(JSON.stringify(crossing(fenced))).toContain("ada/desk/review")
    broker.rulesSet(session, { scope: "tree" })
    expect(crossing(fenced)).toEqual([])
    expect(crossing().length).toBe(2)
  })
  test("a mirrored endpoint's own rules apply on the hub and on other machines' brokers: a sender it does not admit is refused where it used to pass", () => {
    const { broker, hub, open, fromHub } = world()
    const review = (rules: unknown) => [{ address: "me/review", kind: "agent", harness: "codex", presence: "online", parent_ep: null, depth: 0, rules }]
    const sync = (rules: unknown) => {
      hub.mirror("desk", review(rules), { auth: "account+bridge" })
      broker.mirror("desk", hub.remoteRowsOf("desk"))
    }
    const laptopOpen = hub.remoteEndpoint("laptop", "open")
    const fromReview = fromHub(hub.remoteEndpoint("desk", "review"), "laptop/open")
    sync({ in: ["tree:descendants"] })
    expect(code(() => hub.send(laptopOpen, { to: "desk/review", body: "x" }))).toBe("not_found")
    expect(code(() => broker.scopeCheck(open, "desk/review"))).toBe("not_found")
    expect(broker.why({ kind: "human", tty: true }, "open", "desk/review").reasons.at(-1)).toBe(
      "desk/review's own rules limit who may message desk/review to tree:descendants; desk/review widens them with swarm rules set --in tree:descendants,ep:open",
    )
    sync({ out: ["tree:descendants"] })
    expect(code(() => hub.send(hub.remoteEndpoint("desk", "review"), { to: "laptop/open", body: "x" }))).toBe("not_found")
    expect(code(() => broker.inboundRefusal(open, fromReview))).toBe("not_found")
    sync({ in: ["tree:descendants", "machine:laptop"], out: ["tree:descendants", "machine:laptop"] })
    expect(code(() => hub.send(laptopOpen, { to: "desk/review", body: "x" }))).toBeUndefined()
    expect(code(() => broker.scopeCheck(open, "desk/review"))).toBeUndefined()
    expect(broker.inboundRefusal(open, fromReview)).toBeNull()
  })

  test("a mirrored cap's widened entry is clipped by its widener's mirrored scope, as the local core clips it; an unmirrored widener admits nothing", () => {
    const { hub } = world()
    const laptopOpen = hub.remoteEndpoint("laptop", "open")
    const desk = (leadRules: unknown, via = "ep:lead") => {
      hub.mirror("desk", [
        { address: "me/main", kind: "agent", presence: "online", parent_ep: null, depth: 0 },
        { address: "me/lead", kind: "agent", presence: "online", parent_ep: "main", depth: 1, rules: leadRules },
        {
          address: "me/orch",
          kind: "agent",
          presence: "online",
          parent_ep: "lead",
          depth: 2,
          caps: { caps: [{ id: "cap_w", dir: "in", by: "ep:main", sels: [{ sel: "tree:parent" }, { sel: "machine:laptop", via }] }], allow: {} },
          incarnation: via,
        },
      ])
    }
    desk(null)
    expect(code(() => hub.send(laptopOpen, { to: "desk/orch", body: "x" }))).toBeUndefined()
    desk({ in: ["tree:children"] })
    expect(code(() => hub.send(laptopOpen, { to: "desk/orch", body: "x" }))).toBe("not_found")
    desk(null, "ep:ghost")
    expect(code(() => hub.send(laptopOpen, { to: "desk/orch", body: "x" }))).toBe("not_found")
    desk(null, "human")
    expect(code(() => hub.send(laptopOpen, { to: "desk/orch", body: "x" }))).toBeUndefined()
  })
})

const pid = (n: number) => `pid:${n}:Thu-Oct-15-10:00:00-2026`
const HUMAN: ScopeActor = { kind: "human", tty: true }

/** desk's broker with `main` and its children `orch` and `work`, mirrored to the hub as its bridge sends them, and laptop's broker with `open` */
function desks() {
  const db = new Database(":memory:")
  let desk = setup({ machine: "desk", aliases: ["ada"] }, db)
  const hub = setup({ user: "ada", auth: "account", capEverySender: true })
  const laptop = setup({ machine: "laptop", aliases: ["ada"] })
  const ids: Record<string, string> = {}
  for (const [handle, lineage] of [
    ["main", [1]],
    ["orch", [2, 1]],
    ["work", [3, 1]],
  ] as const) {
    ids[handle] = desk.claim({ handle, harness: "codex", process: pid(lineage[0]), lineage: lineage.map(pid) }).endpoint.id
  }
  const open = laptop.claim({ handle: "open", harness: "claude-code" }).endpoint.id
  hub.mirror("laptop", [{ address: "me/open", kind: "agent", harness: "claude-code", presence: "online" }])
  const laptopOpen = hub.remoteEndpoint("laptop", "open")
  const as = (handle: string): ScopeActor => ({ kind: "endpoint", id: ids[handle]!, auth: "session" })
  const views = () =>
    Object.entries(ids).map(([handle, id]) => ({ ...desk.mirrorScope(id), address: `me/${handle}`, kind: "agent", harness: "codex", presence: "online" }))
  const sync = (edit: (view: ReturnType<typeof views>[number]) => object = (view) => view) => {
    hub.mirror("desk", views().map(edit), { full: true, auth: "account+bridge" })
    laptop.mirror("desk", hub.remoteRowsOf("desk"))
  }
  /** whether laptop's `open` reaches desk's `to` on the hub and on laptop's broker: undefined when both pass, else each refusal */
  const reach = (to: string) => {
    const onHub = code(() => hub.send(laptopOpen, { to: `desk/${to}`, body: "x" }))
    const onPeer = code(() => laptop.scopeCheck(open, `desk/${to}`))
    return onHub === undefined && onPeer === undefined ? "passes" : `hub ${onHub ?? "passes"}, peer ${onPeer ?? "passes"}`
  }
  const incarnation = (handle: string) => desk.mirrorScope(ids[handle]!).incarnation
  /** desk's broker restarted on the same database, its policy not loaded yet */
  const restart = () => (desk = setup({ machine: "desk", aliases: ["ada"] }, db))
  return {
    get desk() {
      return desk
    },
    hub,
    ids,
    as,
    sync,
    reach,
    incarnation,
    restart,
  }
}

describe("a mirrored endpoint after an authorised loosening", () => {
  const REFUSED = "hub not_found, peer not_found"

  test("a cap widened by a parent's rules_set, or lifted, reaches the hub and other brokers", () => {
    const { desk, as, sync, reach } = desks()
    const cap = desk.rulesSet(as("main"), { endpoint: "orch", in: ["tree:parent"] }).caps[0]!.id
    sync()
    expect(reach("orch")).toBe(REFUSED)
    desk.rulesSet(as("main"), { endpoint: "orch", in: ["tree:parent", "machine:laptop"] })
    sync()
    expect(reach("orch")).toBe("passes")
    desk.rulesSet(as("main"), { endpoint: "orch", in: ["tree:parent"] })
    sync()
    expect(reach("orch")).toBe(REFUSED)
    desk.rulesLift(as("main"), { endpoint: "orch", cap })
    sync()
    expect(reach("orch")).toBe("passes")
  })

  test("a group's rules loosened, a member removed and a group dropped reach the hub and other brokers", () => {
    const { desk, as, sync, reach } = desks()
    desk.group(as("main"), { action: "create", name: "crew", in: ["tree:parent"] })
    desk.group(as("main"), { action: "add", name: "crew", endpoint: "orch" })
    sync()
    expect(reach("orch")).toBe(REFUSED)
    desk.group(as("main"), { action: "rules", name: "crew", in: ["tree:parent", "machine:laptop"] })
    sync()
    expect(reach("orch")).toBe("passes")
    desk.group(as("main"), { action: "rules", name: "crew", in: ["tree:parent"] })
    sync()
    expect(reach("orch")).toBe(REFUSED)
    desk.group(as("main"), { action: "remove", name: "crew", endpoint: "orch" })
    sync()
    expect(reach("orch")).toBe("passes")
    desk.group(as("main"), { action: "add", name: "crew", endpoint: "orch" })
    sync()
    expect(reach("orch")).toBe(REFUSED)
    desk.group(as("main"), { action: "drop", name: "crew" })
    sync()
    expect(reach("orch")).toBe("passes")
  })

  test("a policy cap loosened or gone on reload reaches the hub and other brokers", () => {
    const { desk, sync, reach } = desks()
    const policy = (scope: string[]) => parsePolicy({ rules: [{ match: "handle:orch", scope }] })
    desk.setPolicy(policy(["tree:parent"]))
    sync()
    expect(reach("orch")).toBe(REFUSED)
    desk.setPolicy(policy(["tree:parent", "machine:laptop"]))
    sync()
    expect(reach("orch")).toBe("passes")
    desk.setPolicy(policy(["tree:parent"]))
    sync()
    expect(reach("orch")).toBe(REFUSED)
    desk.setPolicy(null)
    sync()
    expect(reach("orch")).toBe("passes")
  })

  test("a policy loosened while the broker was down reaches the hub and other brokers once it is back", () => {
    const world = desks()
    const policy = (scope: string[]) => parsePolicy({ rules: [{ match: "handle:orch", scope }] })
    world.desk.setPolicy(policy(["tree:parent"]))
    world.sync()
    expect(world.reach("orch")).toBe(REFUSED)
    world.restart().setPolicy(policy(["tree:parent", "machine:laptop"]))
    world.sync()
    expect(world.reach("orch")).toBe("passes")
  })

  test("an inherited cap lifted, or gone with its ancestor's cap, reaches the hub and other brokers", () => {
    const { desk, sync, reach } = desks()
    const cap = desk.rulesSet(HUMAN, { endpoint: "main", in: ["tree:descendants"] }).caps[0]!.id
    sync()
    expect(reach("orch")).toBe(REFUSED)
    expect(reach("work")).toBe(REFUSED)
    desk.rulesLift(HUMAN, { endpoint: "orch", cap: "inherited:in" })
    desk.rulesLift(HUMAN, { endpoint: "orch", cap: "inherited:out" })
    sync()
    expect(reach("orch")).toBe("passes")
    expect(reach("work")).toBe(REFUSED)
    desk.rulesLift(HUMAN, { endpoint: "main", cap })
    sync()
    expect(reach("work")).toBe("passes")
    expect(reach("main")).toBe("passes")
  })

  test("a tightening keeps the incarnation, so the caps the hub has seen stay", () => {
    const { desk, as, sync, reach, incarnation } = desks()
    const first = incarnation("orch")
    desk.rulesSet(as("main"), { endpoint: "orch", in: ["tree:parent", "machine:laptop"] })
    sync()
    expect(reach("orch")).toBe("passes")
    desk.rulesSet(as("main"), { endpoint: "orch", in: ["tree:parent"] })
    desk.group(as("main"), { action: "create", name: "crew", in: ["tree:parent"] })
    desk.group(as("main"), { action: "add", name: "crew", endpoint: "orch" })
    desk.setPolicy(parsePolicy({ rules: [{ match: "handle:orch", scope: ["tree:parent"] }] }))
    desk.rulesSet(HUMAN, { endpoint: "main", in: ["tree:descendants"] })
    sync()
    expect(reach("orch")).toBe(REFUSED)
    expect(incarnation("orch")).toBe(first)
    sync((view) => ({ ...view, caps: null }))
    expect(reach("orch")).toBe(REFUSED)
  })

  test("an agent cannot move its own incarnation to shed a cap its parent set", () => {
    const { desk, as, sync, reach, incarnation } = desks()
    const cap = desk.rulesSet(as("main"), { endpoint: "orch", in: ["tree:parent"] }).caps[0]!.id
    sync()
    const first = incarnation("orch")
    desk.rulesSet(as("orch"), { in: ["tree:parent"] })
    desk.rulesSet(as("orch"), { in: ["*"] })
    expect(code(() => desk.rulesLift(as("orch"), { endpoint: "orch", cap }))).toBe("scope_refused")
    expect(code(() => desk.rulesSet(as("orch"), { endpoint: "orch", in: ["*"] }))).toBeUndefined()
    expect(incarnation("orch")).toBe(first)
    sync((view) => ({ ...view, caps: null }))
    expect(reach("orch")).toBe(REFUSED)
  })
})

describe("a mirrored endpoint's holder", () => {
  const parts = (incarnation: string | null | undefined) => {
    expect(incarnation).toMatch(/^[0-9a-f]{24}\.\d+$/)
    const [identity, epoch] = incarnation!.split(".")
    return { identity, epoch: Number(epoch) }
  }

  test("the incarnation's part before the dot moves on a new spawn only; a process takeover and a loosening keep it, a loosening moves the epoch", () => {
    const { desk, ids, as, sync, incarnation } = desks()
    sync()
    const orch = parts(incarnation("orch"))
    const work = parts(incarnation("work"))
    expect(orch.epoch).toBe(0)
    const cap = desk.rulesSet(as("main"), { endpoint: "orch", in: ["tree:parent"] }).caps[0]!.id
    sync()
    desk.rulesLift(as("main"), { endpoint: "orch", cap })
    sync()
    expect(parts(incarnation("orch"))).toEqual({ identity: orch.identity, epoch: 1 })
    desk.disconnect(ids.work!)
    expect(desk.claim({ handle: "work", harness: "codex", process: pid(13), lineage: [pid(13), pid(1)] }).endpoint.id).toBe(ids.work!)
    expect(parts(incarnation("work")).identity).toBe(work.identity)
    const token = desk.grant(as("main"), { name: "orch", scope: "parent" }).token
    desk.disconnect(ids.orch!)
    expect(desk.claim({ handle: "orch", harness: "codex", process: pid(12), lineage: [pid(12)], grant: token }).endpoint.id).toBe(ids.orch!)
    expect(
      desk
        .log({ scope: true })
        .filter((row) => row.event === "scope_reset")
        .map((row) => [row.detail.target, row.detail.reason]),
    ).toEqual([
      ["me/work", "another process took over the endpoint"],
      ["me/orch", "a new spawn took over the endpoint"],
    ])
    expect(parts(incarnation("orch")).identity).not.toBe(orch.identity)
  })

  test("an endpoint's first mirror after the format change differs from the old incarnation, so a hub takes its caps afresh", () => {
    const { ids, incarnation } = desks()
    const old = new Bun.CryptoHasher("sha256").update(ids.main!).digest("hex").slice(0, 32)
    expect(parts(incarnation("main")).identity).toHaveLength(24)
    expect(incarnation("main")).not.toBe(old)
  })
})
