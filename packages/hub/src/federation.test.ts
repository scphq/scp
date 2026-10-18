import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { type Envelope, LIMITS, RelayError, type Sql, type SqlValue, wrapMessage } from "@scp-dev/core"
import { FederatedCore, type FederatedOptions, type RemoteView } from "./federation"

const START = 1_800_000_000_000

function setup(options: Partial<FederatedOptions> = {}) {
  const clock = { now: START }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new FederatedCore(sql, {
    now: () => clock.now,
    hash: (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: (fn) => db.transaction(fn)(),
    ...options,
  })
  core.migrate()
  return { core, clock, db }
}

/** a laptop broker (machine laptop, account ada) and the account's hub core */
function pair() {
  const broker = setup({ machine: "laptop", aliases: ["ada"] })
  const hub = setup({ user: "ada", auth: "account" })
  return { broker: broker.core, hub: hub.core, clock: broker.clock, hubClock: hub.clock, brokerDb: broker.db }
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

const view = (address: string, extra: Record<string, unknown> = {}) => ({ address, kind: "agent", harness: "claude-code", presence: "online", ...extra })

describe("addresses", () => {
  test("me, the user, aliases and this machine stay local; other machines and accounts are remote; another account never resolves locally", () => {
    const { broker } = pair()
    const local = broker.claim({ handle: "app-main", harness: "claude-code" })
    broker.mirror("desk", [view("ada/desk/app-main"), { address: "ada/desk/", kind: "human", presence: "online" }], { full: true })
    for (const address of ["app-main", "me/app-main", "ada/app-main", "laptop/app-main", "me/laptop/app-main"]) expect(broker.route(address)).toBeNull()
    expect(broker.route("desk/app-main")).toBe("desk/app-main")
    expect(broker.route("ada/desk/app-main")).toBe("desk/app-main")
    expect(broker.route("desk/")).toBe("desk/")
    expect(broker.isRemote("grace/desk/app-main")).toBe(true)
    expect(broker.route("grace/desk/app-main")).toBe("grace/desk/app-main")
    expect(code(() => broker.send(local.endpoint.id, { to: "grace/desk/app-main", body: "x" }))).toBe("not_found")
    expect(code(() => broker.send(local.endpoint.id, { to: "nowhere/app-main", body: "x" }))).toBe("not_found")
    expect(code(() => broker.send(local.endpoint.id, { to: "a/b/c/d", body: "x" }))).toBe("not_found")
    const sent = broker.send(local.endpoint.id, { to: ["desk/app-main", "me/desk/"], body: "x" })
    expect(sent.deliveries.map((d) => d.address)).toEqual(["me/desk/app-main", "me/desk/"])
    expect(broker.list().map((e) => e.address)).toContain("me/desk/app-main")
    expect(broker.send(local.endpoint.id, { to: "laptop/app-main", body: "self" }).deliveries[0]!.endpoint).toBe(local.endpoint.id)
  })

  test("within a machine, unqualified handles resolve in its namespace and me/ stays the account inbox", () => {
    const { hub } = pair()
    const impl = hub.claimOn("ci", { handle: "impl", harness: "codex" })
    const lane = hub.claimOn("ci", { handle: "lane", harness: "codex" })
    expect(code(() => hub.send(lane.endpoint.id, { to: "impl", body: "x" }))).toBe("not_found")
    const sent = hub.within("ci", () => hub.send(lane.endpoint.id, { to: ["impl", "me/"], body: "x" }))
    expect(sent.deliveries.map((d) => d.address)).toEqual(["ada/ci/impl", "ada/"])
    expect(impl.endpoint.address).toBe("ada/ci/impl")
  })
})

describe("mirror", () => {
  test("full sync adds, a delta updates only what changed, a later full sync marks missing rows offline", () => {
    const { hub } = pair()
    const added = hub.mirror("desk", [view("me/a"), view("me/b")], { full: true, auth: "account+bridge" })
    expect(added.map((c) => [c.view.address, c.added])).toEqual([
      ["ada/desk/a", true],
      ["ada/desk/b", true],
    ])
    expect(hub.mirror("desk", [view("me/a")], { auth: "account+bridge" })).toEqual([])
    const status = hub.mirror("desk", [view("me/a", { status: { state: "working", note: "tests" } })], { auth: "account+bridge" })
    expect(status.map((c) => [c.view.address, c.status, c.presence])).toEqual([["ada/desk/a", true, false]])
    const full = hub.mirror("desk", [view("me/a", { status: { state: "working", note: "tests" } })], { full: true, auth: "account+bridge" })
    expect(full.map((c) => [c.view.address, c.view.presence])).toEqual([["ada/desk/b", "offline"]])
    expect(hub.remoteRowsOf("desk").map((v) => [v.address, v.machine, v.presence])).toEqual([
      ["ada/desk/a", "desk", "online"],
      ["ada/desk/b", "desk", "offline"],
    ])
  })

  test("a machine's mirror never touches another machine's rows, whatever address its views carry", () => {
    const { hub } = pair()
    hub.mirror("laptop", [view("ada/laptop/impl", { harness: "codex" })], { full: true })
    hub.mirror("desk", [view("ada/laptop/impl", { harness: "grok" })], { full: true })
    hub.mirror("desk", [], { full: true })
    const laptop = hub.remoteRowsOf("laptop")
    expect(laptop.map((v) => [v.address, v.harness, v.presence])).toEqual([["ada/laptop/impl", "codex", "online"]])
    expect(hub.remoteRowsOf("desk").map((v) => [v.address, v.presence])).toEqual([["ada/desk/impl", "offline"]])
  })

  test("a mirror never overwrites a direct client's claimed row, online or offline", () => {
    const { hub } = pair()
    const claimed = hub.claimOn("ci", { handle: "impl", harness: "codex" })
    hub.mirror("ci", [view("me/impl", { harness: "grok" })], { full: true })
    expect(hub.remoteRowsOf("ci").map((v) => [v.address, v.harness, v.presence])).toEqual([["ada/ci/impl", "codex", "online"]])
    hub.disconnect(claimed.endpoint.id)
    hub.mirror("ci", [view("me/impl", { harness: "grok" })], { full: true })
    expect(hub.remoteRowsOf("ci").map((v) => [v.address, v.harness, v.presence])).toEqual([["ada/ci/impl", "codex", "offline"]])
    expect(hub.resumeOn("ci", claimed.token!).id).toBe(claimed.endpoint.id)
  })

  test("bad views and credentials are refused", () => {
    const { hub } = pair()
    expect(code(() => hub.mirror("desk", [view("me/Bad Handle")]))).toBe("invalid_params")
    expect(code(() => hub.mirror("desk", [view("me/a", { kind: "system" })]))).toBe("invalid_params")
    expect(code(() => hub.mirror("Desk", [view("me/a")]))).toBe("invalid_params")
    expect(code(() => hub.mirror("desk", [view("me/a", { cwd: `/w/scp_${"x".repeat(24)}` })]))).toBe("secret_refused")
  })

  test("the endpoint cap counts mirrored and claimed rows", () => {
    const { core } = setup({ user: "ada", endpointCap: 3 })
    core.mirror("desk", [view("me/a")])
    core.claimOn("ci", { handle: "b" })
    expect(code(() => core.mirror("desk", [view("me/c"), view("me/d")]))).toBe("too_large")
  })
})

describe("claimOn and resumeOn", () => {
  test("takeover and suffix rules per machine, kre_ tokens, resume bound to the machine", () => {
    const { hub } = pair()
    const first = hub.claimOn("ci", { handle: "impl", harness: "codex" })
    expect(first.token).toStartWith("kre_")
    expect(hub.claimOn("ci", { handle: "impl", harness: "codex" }).endpoint.address).toBe("ada/ci/impl-2")
    expect(hub.claimOn("desk", { handle: "impl", harness: "codex" }).endpoint.address).toBe("ada/desk/impl")
    hub.disconnect(first.endpoint.id)
    expect(hub.claimOn("ci", { handle: "impl", harness: "grok" }).endpoint.address).toBe("ada/ci/impl-3")
    expect(hub.claimOn("ci", { handle: "impl", harness: "codex" }).endpoint.id).toBe(first.endpoint.id)
    expect(code(() => hub.resumeOn("desk", first.token!))).toBe("unauthorized")
    expect(code(() => hub.resumeOn("ci", "kre_unknown"))).toBe("unauthorized")
  })

  test("a claim's scope and lists hold on its row: none neither sends nor is reached, in and out persist and are enforced", () => {
    const { hub } = pair()
    hub.mirror("laptop", [view("me/app-main")], { auth: "account+bridge" })
    const open = hub.claimOn("ci", { handle: "open", harness: "codex" }).endpoint.id
    const fenced = hub.claimOn("ci", { handle: "fenced", harness: "codex", scope: "none" })
    expect(fenced.endpoint.scope).toBe("none")
    const ci = (fn: () => unknown) => code(() => hub.within("ci", fn))
    expect(ci(() => hub.send(fenced.endpoint.id, { to: "open", body: "x" }))).toBe("not_found")
    expect(code(() => hub.send(fenced.endpoint.id, { to: "laptop/app-main", body: "x" }))).toBe("not_found")
    expect(ci(() => hub.send(open, { to: "fenced", body: "x" }))).toBe("not_found")
    expect(code(() => hub.send(open, { to: "laptop/app-main", body: "x" }))).toBeUndefined()
    const listed = hub.claimOn("ci", { handle: "listed", harness: "codex", in: ["machine:laptop"], out: ["machine:laptop", "machine:desk"] }).endpoint.id
    expect(hub.remoteViews({ machine: "ci" }).map((v) => [v.address, v.rules])).toEqual([
      ["ada/ci/fenced", { in: [], out: [] }],
      ["ada/ci/listed", { in: ["machine:laptop"], out: ["machine:laptop", "machine:desk"] }],
      ["ada/ci/open", null],
    ])
    const app = hub.remoteEndpoint("laptop", "app-main")
    expect(code(() => hub.send(app, { to: "ci/listed", body: "x" }))).toBeUndefined()
    expect(ci(() => hub.send(open, { to: "listed", body: "x" }))).toBe("not_found")
    expect(code(() => hub.send(listed, { to: "laptop/app-main", body: "x" }))).toBeUndefined()
    expect(ci(() => hub.send(listed, { to: "open", body: "x" }))).toBe("not_found")
    hub.disconnect(fenced.endpoint.id)
    expect(hub.claimOn("ci", { handle: "fenced", harness: "codex" }).endpoint).toMatchObject({ id: fenced.endpoint.id, scope: "none" })
    expect(code(() => hub.claimOn("ci", { handle: "bad", scope: "wide" as never }))).toBe("invalid_params")
    expect(code(() => hub.claimOn("ci", { handle: "bad", in: ["group:nope"] }))).toBe("invalid_params")
    expect(hub.claimOn("ci", { handle: "bad" }).endpoint.address).toBe("ada/ci/bad")
  })

  test("an exact claim is never suffixed: it takes over an offline row, joins a live one with no new token, else is refused", () => {
    const { hub } = pair()
    const live = hub.claimOn("ci", { handle: "impl", harness: "codex" })
    const joined = hub.claimOn("ci", { handle: "impl", harness: "codex", exact: true })
    expect([joined.endpoint.id, joined.token]).toEqual([live.endpoint.id, undefined])
    expect(hub.resumeOn("ci", live.token!).id).toBe(live.endpoint.id)
    const refused = (claim: Parameters<FederatedCore["claimOn"]>[1], machine = "ci") => {
      try {
        hub.claimOn(machine, claim)
      } catch (error) {
        if (error instanceof RelayError) return [error.code, error.message]
        throw error
      }
      return undefined
    }
    expect(refused({ handle: "impl", harness: "grok", exact: true })).toEqual(["unauthorized", "impl is a codex endpoint: pass --harness codex"])
    hub.mirror("desk", [view("me/rev", { harness: "codex" })], { auth: "account+bridge" })
    expect(refused({ handle: "rev", harness: "codex", exact: true }, "desk")).toEqual([
      "unauthorized",
      "rev is placed in another tree or under another parent than this shell",
    ])
    expect(hub.remoteViews({ machine: "ci" }).map((v) => v.address)).toEqual(["ada/ci/impl"])
    for (let i = 0; i < 3; i++) hub.disconnect(live.endpoint.id)
    const taken = hub.claimOn("ci", { handle: "impl", harness: "codex", exact: true })
    expect(taken.endpoint.id).toBe(live.endpoint.id)
    expect(taken.token).toStartWith("kre_")
    expect(code(() => hub.resumeOn("ci", live.token!))).toBe("unauthorized")
  })

  test("a mirrored row offline past the bound is retired for a new claim", () => {
    const { hub, hubClock } = pair()
    hub.mirror("ci", [view("me/impl", { presence: "offline", last_seen: new Date(START).toISOString() })])
    hubClock.now += 31 * 86_400_000
    const claimed = hub.claimOn("ci", { handle: "impl", harness: "codex" })
    expect(claimed.endpoint.address).toBe("ada/ci/impl")
    expect(hub.resumeOn("ci", claimed.token!).id).toBe(claimed.endpoint.id)
  })
})

describe("across machines", () => {
  function delivered(hub: FederatedCore, seq: number): Envelope {
    return hub.delivery(seq)!.message
  }

  test("a hub delivery of a send to several machines names only its own recipient", () => {
    const { hub } = pair()
    hub.mirror("laptop", [view("me/app-main")], { auth: "account+bridge" })
    hub.mirror("desk", [view("me/review")], { auth: "account+bridge" })
    const impl = hub.claimOn("ci", { handle: "impl", harness: "codex" })
    const sent = hub.send(impl.endpoint.id, { to: ["laptop/app-main", "desk/review"], body: "both" })
    expect(sent.deliveries.map((d) => delivered(hub, d.seq).to)).toEqual(["ada/laptop/app-main", "ada/desk/review"])
    expect(hub.pending("desk", 0).map((d) => d.message.to)).toEqual(["ada/desk/review"])
  })

  test("admit stores the hub's message once under its id, from a proxy of the sender", () => {
    const { broker, hub } = pair()
    const local = broker.claim({ handle: "app-main", harness: "claude-code" })
    hub.mirror("laptop", [view("me/app-main")], { auth: "account+bridge" })
    const impl = hub.claimOn("ci", { handle: "impl", harness: "codex", model: "gpt" })
    const sent = hub.send(impl.endpoint.id, { to: "laptop/app-main", body: "hello" })
    const message = delivered(hub, sent.deliveries[0]!.seq)
    expect(message.from).toMatchObject({ address: "ada/ci/impl", auth: "account", machine: "ci" })
    const target = broker.localTarget(hub.delivery(sent.deliveries[0]!.seq)!.endpoint)
    expect(target).toBe(local.endpoint.id)
    const once = broker.admit(target, message)
    const twice = broker.admit(target, message)
    expect(once.duplicate).toBe(false)
    expect(twice).toEqual({ seq: once.seq, duplicate: true })
    const inbox = broker.inbox(local.endpoint.id)
    expect(inbox.map((m) => [m.id, m.body.text, m.from.address, m.from.auth, m.from.machine, m.from.claims.model])).toEqual([
      [sent.id, "hello", "me/ci/impl", "account", "ci", "gpt"],
    ])
    expect(broker.route(inbox[0]!.from.address)).toBe("ci/impl")
    expect(code(() => broker.localTarget("desk/app-main"))).toBe("not_found")
  })

  test("admit keeps the human sender's tty claim and refuses a credential in the body", () => {
    const { broker, hub } = pair()
    const local = broker.claim({ handle: "app-main" })
    hub.mirror("laptop", [view("me/app-main")])
    const human = hub.claimHuman(false)
    const sent = hub.send(human.id, { to: "laptop/app-main", body: "from the account" }, { tty: false })
    const message = delivered(hub, sent.deliveries[0]!.seq)
    broker.admit(local.endpoint.id, message)
    const [got] = broker.inbox(local.endpoint.id)
    expect(got!.from).toMatchObject({ address: "me/ada/", auth: "account" })
    expect(got!.from.claims.tty).toBe(false)
    expect(broker.route("me/ada/")).toBe("ada/")
    expect(
      code(() =>
        broker.admit(local.endpoint.id, { ...message, id: "msg_0000000000000001", body: { text: `token scp_${"y".repeat(24)}`, mime: "text/plain" } }),
      ),
    ).toBe("secret_refused")
  })

  test("recordForward lets replyTo find the reply and a retried client_id answer locally", () => {
    const { broker, hub } = pair()
    const local = broker.claim({ handle: "app-main", harness: "claude-code" })
    hub.mirror("laptop", [view("me/app-main")])
    hub.mirror("desk", [view("me/review")])
    broker.mirror("desk", [view("ada/desk/review")])
    const params = { to: "desk/review", body: "review this", kind: "request" as const, client_id: "c1" }
    const hubSender = hub.remoteEndpoint("laptop", "app-main")
    const result = hub.send(hubSender, params)
    expect(broker.forwarded(local.endpoint.id, params)).toBeNull()
    broker.recordForward(local.endpoint.id, params, result)
    expect(broker.forwarded(local.endpoint.id, params)).toEqual({ ...result, duplicate: true })
    expect(code(() => broker.forwarded(local.endpoint.id, { ...params, body: "something else" }))).toBe("invalid_params")
    expect(broker.replyTo(local.endpoint.id, result.id)).toBeNull()
    const review = hub.remoteEndpoint("desk", "review")
    const reply = hub.send(review, { to: "laptop/app-main", kind: "reply", reply_to: result.id, body: "lgtm" })
    broker.admit(local.endpoint.id, delivered(hub, reply.deliveries[0]!.seq))
    expect(broker.replyTo(local.endpoint.id, result.id)!.body.text).toBe("lgtm")
  })

  test("admit refuses past the inbox cap, except the first reply to the endpoint's own ask and a redelivery; inboundRefusal checks policy only", () => {
    const { broker, hub, clock, brokerDb } = pair()
    const local = broker.claim({ handle: "app-main", harness: "claude-code" })
    hub.mirror("laptop", [view("me/app-main")])
    hub.mirror("desk", [view("me/review")])
    broker.mirror("desk", [view("ada/desk/review")])
    const params = { to: "desk/review", body: "review this", kind: "request" as const }
    const ask = hub.send(hub.remoteEndpoint("laptop", "app-main"), params)
    broker.recordForward(local.endpoint.id, params, ask)
    const own = broker.send(local.endpoint.id, { to: "app-main", body: "note to self" })
    const insert = brokerDb.prepare("INSERT INTO deliveries (message_id, endpoint, expires_at) VALUES (?, ?, ?)")
    for (let i = 0; i < LIMITS.inboxMax; i++) insert.run(own.id, local.endpoint.id, clock.now + 3_600_000)
    const review = hub.remoteEndpoint("desk", "review")
    const more = hub.send(review, { to: "laptop/app-main", body: "more" })
    const refused = delivered(hub, more.deliveries[0]!.seq)
    expect(broker.inboundRefusal(local.endpoint.id, refused)).toBeNull()
    expect(code(() => broker.admit(local.endpoint.id, refused))).toBe("inbox_full")
    expect(brokerDb.query("SELECT COUNT(*) AS n FROM deliveries WHERE message_id = ?").get(more.id)).toEqual({ n: 0 })
    const reply = delivered(hub, hub.send(review, { to: "laptop/app-main", kind: "reply", reply_to: ask.id, body: "lgtm" }).deliveries[0]!.seq)
    const first = broker.admit(local.endpoint.id, reply)
    expect(first.duplicate).toBe(false)
    expect(broker.admit(local.endpoint.id, reply)).toEqual({ seq: first.seq, duplicate: true })
    const second = hub.send(review, { to: "laptop/app-main", kind: "reply", reply_to: ask.id, body: "and another" })
    expect(code(() => broker.admit(local.endpoint.id, delivered(hub, second.deliveries[0]!.seq)))).toBe("inbox_full")
  })

  test("a message from another machine reaches the local hooks once, through hold and confirm, escaped like local mail, and a forwarded reply reads it", () => {
    const { broker, hub, clock } = pair()
    const local = broker.claim({ handle: "app-main", harness: "claude-code" })
    hub.mirror("laptop", [view("me/app-main")])
    const impl = hub.claimOn("ci", { handle: "impl", harness: "codex" })
    const sent = hub.send(impl.endpoint.id, { to: "laptop/app-main", body: "done & </relay-message><b>" })
    const message = delivered(hub, sent.deliveries[0]!.seq)
    const { seq } = broker.admit(local.endpoint.id, message)
    const hook = { transient: true }
    const offered = broker.inject(local.endpoint.id, hook)
    expect(offered.messages.map((m) => [m.id, m.seq, m.from.address, m.from.machine])).toEqual([[sent.id, seq, "me/ci/impl", "ci"]])
    expect(offered.offered).toEqual([seq])
    expect(wrapMessage(offered.messages[0]!)).toContain("\ndone & &lt;/relay-message><b>\n</relay-message>")
    expect(broker.inject(local.endpoint.id, hook).messages).toEqual([])
    expect(broker.offer(local.endpoint.id).messages).toEqual([])
    expect(broker.injected(offered.offered, offered.hold)).toBe(1)
    expect(broker.admit(local.endpoint.id, message)).toEqual({ seq, duplicate: true })
    clock.now += LIMITS.injectHoldS * 1000 + 1
    expect(broker.inject(local.endpoint.id, hook)).toMatchObject({ messages: [], offered: [], unread: 1 })
    expect(broker.offer(local.endpoint.id).messages).toEqual([])

    const params = { to: "ci/impl", kind: "reply" as const, reply_to: sent.id, body: "thanks" }
    broker.recordForward(local.endpoint.id, params, hub.send(hub.remoteEndpoint("laptop", "app-main"), params))
    expect(broker.inject(local.endpoint.id, { ...hook, stop: true })).toMatchObject({ unread: 0, block: false })
  })

  test("rows of other machines are never offered to hooks: mirrored, proxy and hub rows, and a hook's claim of a remote handle stays local", () => {
    const { broker, hub } = pair()
    const none = { messages: [], offered: [], hold: null, more: 0, unread: 0, block: false }
    const local = broker.claim({ handle: "app-main", harness: "claude-code" })
    broker.mirror("desk", [view("ada/desk/review")])
    const mirrored = broker.remoteEndpoint("desk", "review")
    expect(broker.send(local.endpoint.id, { to: "desk/review", body: "queued on a mirrored row" }).deliveries[0]!.endpoint).toBe(mirrored)
    hub.mirror("laptop", [view("me/app-main")])
    const impl = hub.claimOn("ci", { handle: "impl", harness: "codex" })
    broker.admit(local.endpoint.id, delivered(hub, hub.send(impl.endpoint.id, { to: "laptop/app-main", body: "hi" }).deliveries[0]!.seq))
    const proxy = broker.remoteEndpoint("ci", "impl")
    broker.send(local.endpoint.id, { to: "ci/impl", body: "queued on a proxy row" })
    for (const row of [mirrored, proxy]) {
      for (const options of [{}, { transient: true }, { stop: true }, { count: true }]) expect(broker.inject(row, options)).toEqual(none)
      expect(broker.offer(row)).toEqual({ messages: [], hold: null })
      expect(broker.stopHeld(row)).toBe(false)
    }
    const hubRow = hub.remoteEndpoint("laptop", "app-main")
    hub.send(impl.endpoint.id, { to: "laptop/app-main", body: "unread on the hub" })
    for (const row of [hubRow, impl.endpoint.id]) {
      expect(hub.inject(row, { transient: true })).toEqual(none)
      expect(hub.offer(row)).toEqual({ messages: [], hold: null })
    }
    const hooked = broker.claim({ handle: "review", harness: "claude-code", session: "env:review" }, { transient: true })
    expect(hooked.endpoint.id).not.toBe(mirrored)
    expect(broker.machineOf(hooked.endpoint.id)).toBeNull()
    expect(broker.inject(local.endpoint.id, { transient: true }).messages.map((m) => m.body.text)).toEqual(["hi"])
  })

  test("markReceived raises the causal hop and ackOn only acks the machine's own deliveries", () => {
    const { hub } = pair()
    hub.mirror("laptop", [view("me/impl")])
    hub.mirror("desk", [view("me/review")])
    const impl = hub.remoteEndpoint("laptop", "impl")
    const review = hub.remoteEndpoint("desk", "review")
    expect(hub.causalHop(impl)).toBe(0)
    hub.markReceived(impl, 5)
    expect(hub.causalHop(impl)).toBe(6)
    const sent = hub.send(impl, { to: "desk/review", body: "x" })
    expect(sent.hop).toBe(6)
    const seq = sent.deliveries[0]!.seq
    expect(hub.ackOn("laptop", [seq])).toBe(0)
    expect(hub.pending("desk", 0).map((d) => [d.seq, d.endpoint])).toEqual([[seq, "desk/review"]])
    expect(hub.ackOn("desk", [seq])).toBe(1)
    expect(hub.causalHop(review)).toBe(7)
    expect(hub.pending("desk", 0)).toEqual([])
  })

  test("rejectOn acks and leaves a relay notice for the sender", () => {
    const { hub } = pair()
    hub.mirror("laptop", [view("me/impl")])
    hub.mirror("desk", [view("me/review")])
    const impl = hub.remoteEndpoint("laptop", "impl")
    const sent = hub.send(impl, { to: "desk/review", body: "x" })
    expect(code(() => hub.rejectOn("laptop", sent.deliveries[0]!.seq, "policy_refused"))).toBe("not_found")
    const { notice } = hub.rejectOn("desk", sent.deliveries[0]!.seq, "policy_refused")
    expect(hub.pending("desk", 0)).toEqual([])
    const [pushed] = hub.pending("laptop", 0)
    expect(pushed!.seq).toBe(notice!.seq)
    expect(pushed!.message).toMatchObject({ kind: "status", from: { address: "ada/relay" } })
    expect(pushed!.message.body.text).toContain("ada/desk/review refused message")
  })

  test("a direct client's claimed row is not the bridge's: delivery() says so, and pending, ackOn and rejectOn skip it", () => {
    const { hub } = pair()
    hub.mirror("laptop", [view("me/impl")])
    hub.mirror("desk", [view("me/review")])
    hub.claimOn("desk", { handle: "direct" })
    const impl = hub.remoteEndpoint("laptop", "impl")
    const direct = hub.send(impl, { to: "desk/direct", body: "x" }).deliveries[0]!.seq
    const mirrored = hub.send(impl, { to: "desk/review", body: "y" }).deliveries[0]!.seq
    expect([hub.delivery(direct)!.mirrored, hub.delivery(mirrored)!.mirrored]).toEqual([false, true])
    expect(hub.pending("desk", 0).map((d) => d.seq)).toEqual([mirrored])
    expect(hub.ackOn("desk", [direct])).toBe(0)
    expect(code(() => hub.rejectOn("desk", direct, "policy_refused"))).toBe("not_found")
  })

  test("dropMachine retires the machine's rows", () => {
    const { hub } = pair()
    hub.mirror("desk", [view("me/review")])
    const claimed = hub.claimOn("desk", { handle: "impl" })
    expect(hub.dropMachine("desk")).toBe(2)
    expect(hub.remoteRowsOf("desk")).toEqual([])
    expect(code(() => hub.resumeOn("desk", claimed.token!))).toBe("unauthorized")
    expect(hub.list({ all: true }).map((e) => e.address)).toEqual(["ada/"])
  })
})

describe("mirrored scope fields", () => {
  const SEEN = new Date(START).toISOString()
  const pick = (v: RemoteView) => [v.address, v.tree, v.parent_ep, v.depth, v.rules, v.caps, v.title]
  const placed = (core: FederatedCore, machine: string) =>
    Object.fromEntries(core.remoteRowsOf(machine).map((v) => [v.address.slice(v.address.lastIndexOf("/") + 1), [v.tree, v.parent_ep, v.depth]]))

  test("a bridge's tree, parent, depth, rules, caps and title round trip to the hub and on to another machine's broker", () => {
    const { broker, hub } = pair()
    const caps = {
      caps: [{ id: "cap_1", dir: "in" as const, by: "ep:main", sels: [{ sel: "tree:parent" }, { sel: "machine:ci", via: "ep:main" }] }],
      allow: {},
    }
    hub.mirror(
      "desk",
      [
        view("me/main", { tree: "main", parent_ep: null, depth: 0, rules: { in: ["tree:children"] }, title: "lead", incarnation: "i1" }),
        view("me/orch", { tree: "main", parent_ep: "main", depth: 1, caps, incarnation: "i2" }),
      ],
      { full: true, auth: "account+bridge" },
    )
    const rows = hub.remoteRowsOf("desk")
    expect(rows.map(pick)).toEqual([
      ["ada/desk/main", "main", null, 0, { in: ["tree:children"] }, null, "lead"],
      ["ada/desk/orch", "main", "main", 1, null, caps, null],
    ])
    expect(rows.map((v) => [v.incarnation, v.scope])).toEqual([
      ["i1", "custom"],
      ["i2", "custom"],
    ])
    broker.mirror("desk", rows, { full: true })
    expect(broker.remoteViews({ machine: "desk" }).map(pick)).toEqual([
      ["me/desk/main", "main", null, 0, { in: ["tree:children"] }, null, "lead"],
      ["me/desk/orch", "main", "main", 1, null, caps, null],
    ])
  })

  test("an older bridge that sends none of them keeps working, and its endpoints' place is unknown, never a root", () => {
    const { hub } = pair()
    hub.mirror("desk", [view("me/old")], { full: true })
    expect(hub.remoteRowsOf("desk").map(pick)).toEqual([["ada/desk/old", null, null, null, null, null, null]])
    const impl = hub.claimOn("ci", { handle: "impl" })
    expect(hub.send(impl.endpoint.id, { to: "desk/old", body: "x" }).deliveries.length).toBe(1)
    expect(hub.remoteRowsOf("ci").map((v) => v.depth)).toEqual([null])
  })

  test("the hub places endpoints itself: depth from the mirrored parent, roots without one, no parent on another machine or unmirrored", () => {
    const { hub } = pair()
    hub.claimOn("desk", { handle: "impl" })
    hub.mirror("desk", [
      view("me/orch", { tree: "main", parent_ep: "main", depth: 5 }),
      view("me/main", { tree: "main", parent_ep: null, depth: 0 }),
      view("me/deep", { tree: "other", parent_ep: "orch", depth: 1 }),
      view("me/liar", { parent_ep: null, depth: 2 }),
      view("me/far", { parent_ep: "laptop/main", depth: 1 }),
      view("me/lost", { parent_ep: "nobody", depth: 1 }),
      view("me/adopted", { parent_ep: "impl", depth: 1 }),
      view("me/x", { parent_ep: "y", depth: 1 }),
      view("me/y", { parent_ep: "x", depth: 1 }),
    ])
    expect(placed(hub, "desk")).toEqual({
      adopted: [null, null, null],
      deep: ["main", "orch", 2],
      far: [null, null, null],
      impl: [null, null, null],
      liar: [null, null, null],
      lost: [null, null, null],
      main: ["main", null, 0],
      orch: ["main", "main", 1],
      x: [null, null, null],
      y: [null, null, null],
    })
    hub.mirror("desk", [view("me/late", { parent_ep: "orch", depth: 9 })])
    expect(placed(hub, "desk").late).toEqual(["main", "orch", 2])
  })

  test("a cap the hub has seen stays until the machine releases the endpoint, and a seen cap gains no plain entries", () => {
    const { hub } = pair()
    const impl = hub.claimOn("ci", { handle: "impl" }).endpoint.id
    const cap = { id: "cap_p", dir: "in" as const, by: "ep:main", sels: [{ sel: "tree:parent" }] }
    const orch = (caps: unknown, incarnation = "i1") => view("me/orch", { parent_ep: "main", depth: 1, caps, incarnation })
    hub.mirror("desk", [view("me/main", { parent_ep: null, depth: 0, incarnation: "i0" }), orch({ caps: [cap], allow: {} })])
    expect(code(() => hub.send(impl, { to: "desk/orch", body: "x" }))).toBe("not_found")
    hub.mirror("desk", [orch({ caps: [], allow: {} })])
    expect(hub.remoteRowsOf("desk").find((v) => v.address === "ada/desk/orch")!.caps).toEqual({ caps: [cap], allow: {} })
    expect(code(() => hub.send(impl, { to: "desk/orch", body: "x" }))).toBe("not_found")
    hub.mirror("desk", [orch(null)])
    expect(code(() => hub.send(impl, { to: "desk/orch", body: "x" }))).toBe("not_found")
    hub.mirror("desk", [orch({ caps: [{ ...cap, sels: [{ sel: "tree:parent" }, { sel: "*" }] }], allow: {} })])
    expect(hub.remoteRowsOf("desk").find((v) => v.address === "ada/desk/orch")!.caps).toEqual({ caps: [cap], allow: {} })
    expect(code(() => hub.send(impl, { to: "desk/orch", body: "x" }))).toBe("not_found")
    hub.mirror("desk", [orch({ caps: [], allow: {} }, "i2")])
    expect(hub.remoteRowsOf("desk").find((v) => v.address === "ada/desk/orch")!.caps).toBeNull()
    expect(code(() => hub.send(impl, { to: "desk/orch", body: "x" }))).toBeUndefined()
  })

  test("malformed scope fields are refused like any bad view", () => {
    const { hub } = pair()
    expect(code(() => hub.mirror("desk", [view("me/a", { depth: "1" })]))).toBe("invalid_params")
    expect(code(() => hub.mirror("desk", [view("me/a", { parent_ep: 7 })]))).toBe("invalid_params")
    expect(code(() => hub.mirror("desk", [view("me/a", { rules: { in: ["not a selector"] } })]))).toBe("invalid_params")
    expect(code(() => hub.mirror("desk", [view("me/a", { caps: { caps: [{ id: "c", dir: "up", by: "human", sels: [] }] } })]))).toBe("invalid_params")
    expect(code(() => hub.mirror("desk", [view("me/a", { caps: { caps: [{ id: "c", dir: "in", by: "human", sels: [{ sel: "bad sel" }] }] } })]))).toBe(
      "invalid_params",
    )
    expect(code(() => hub.mirror("desk", [view("me/a", { title: `scp_${"x".repeat(24)}` })]))).toBe("secret_refused")
  })

  test("a mirror writes one row per changed endpoint and nothing when nothing changed", () => {
    const { core: hub, db } = setup({ user: "ada" })
    const changes = () => (db.query("SELECT total_changes() AS n").get() as { n: number }).n
    const views = [
      view("me/main", { last_seen: SEEN, parent_ep: null, depth: 0, rules: { in: ["tree:children"] }, incarnation: "i0" }),
      view("me/orch", {
        last_seen: SEEN,
        parent_ep: "main",
        depth: 1,
        caps: { caps: [{ id: "cap_p", dir: "in", by: "ep:main", sels: [{ sel: "tree:parent" }] }], allow: {} },
        incarnation: "i1",
      }),
    ]
    hub.mirror("desk", views, { full: true, auth: "account+bridge" })
    let before = changes()
    expect(hub.mirror("desk", views, { full: true, auth: "account+bridge" })).toEqual([])
    expect(changes() - before).toBe(0)
    before = changes()
    const titled = hub.mirror("desk", [views[0]!, { ...views[1]!, title: "orchestrator" }], { full: true, auth: "account+bridge" })
    expect(titled.map((c) => c.view.address)).toEqual(["ada/desk/orch"])
    expect(changes() - before).toBe(1)
  })

  test("the human at a terminal on another machine is <machine>/me with a human flag; no agent and no other sender gets either", () => {
    const { broker, hub } = pair()
    const local = broker.claim({ handle: "app-main" })
    hub.mirror("laptop", [view("me/app-main")])
    hub.mirror("desk", [{ address: "me/", kind: "human", presence: "online" }, view("me/review")])
    const human = hub.remoteEndpoint("desk", "")
    const sent = hub.send(human, { to: "laptop/app-main", body: "from my desk" }, { tty: true })
    const message = hub.delivery(sent.deliveries[0]!.seq)!.message
    expect(message.from).toMatchObject({ address: "ada/desk/", machine: "desk", human: true, claims: { tty: true } })
    broker.admit(local.endpoint.id, message)
    const [got] = broker.inbox(local.endpoint.id)
    expect(got!.from).toMatchObject({ address: "me/desk/", human: true })
    expect(wrapMessage(got!)).toContain(`from="me/desk/me"`)
    for (const address of ["desk/me", "me/desk/me", "ada/desk/me"]) expect(broker.route(address)).toBe("desk/")
    expect(hub.route("desk/me")).toBe("desk/")
    expect(hub.send(hub.remoteEndpoint("laptop", "app-main"), { to: "desk/me", body: "back" }).deliveries[0]!.endpoint).toBe(human)

    const unverified = hub.send(human, { to: "laptop/app-main", body: "no terminal" }, { tty: false })
    expect(hub.delivery(unverified.deliveries[0]!.seq)!.message.from.human).toBeUndefined()
    const review = hub.remoteEndpoint("desk", "review")
    const agent = hub.send(review, { to: "laptop/app-main", body: "as an agent", human: true } as never, { tty: true })
    const agentMessage = hub.delivery(agent.deliveries[0]!.seq)!.message
    expect(agentMessage.from.human).toBeUndefined()
    expect(wrapMessage(agentMessage)).toContain(`from="ada/desk/review"`)
    const platform = hub.claimHuman(true).id
    const own = hub.send(platform, { to: "laptop/app-main", body: "from the dashboard" }, { tty: true })
    expect(hub.delivery(own.deliveries[0]!.seq)!.message.from.human).toBeUndefined()

    expect(code(() => hub.claimOn("desk", { handle: "me" }))).toBe("invalid_params")
    expect(code(() => hub.mirror("desk", [view("me/me")]))).toBe("invalid_params")
    expect(code(() => hub.remoteEndpoint("desk", "me"))).toBe("not_found")
    expect(code(() => broker.claim({ handle: "me" }))).toBe("invalid_params")
    expect(code(() => hub.within("desk", () => hub.send(review, { to: "me", body: "x" })))).toBe("not_found")
  })
})
