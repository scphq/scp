// biome-ignore-all lint/suspicious/noExplicitAny: JSON-RPC results and frames are untyped wire data
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { LIMITS, PROTOCOL, type Sql, type SqlValue } from "@scp-dev/core"
import {
  type DashboardEvent,
  GRAPH_MINUTES,
  GRAPH_MINUTES_MAX,
  HUB_LIMITS as DEFAULT_HUB_LIMITS,
  type HubConn,
  type HubGrant,
  type HubLimits,
  type HubWakeOptions,
  RelayHub,
  type HubSocket,
} from "./hub"

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
const HUB_LIMITS = {
  ...DEFAULT_HUB_LIMITS,
  callsPerMinute: 120,
  bridgeCallsPerMinute: 600,
  accountCallsPerMinute: 1200,
  acksPerMinute: 1200,
  accountAcksPerMinute: 4800,
  ...TEST_RATES,
}

const START = 1_800_000_000_000

type Frame = {
  jsonrpc: "2.0"
  id?: number | null
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: { code: string; retry_after?: number } }
}

class FakeSocket implements HubSocket {
  frames: Frame[] = []
  closedWith: { code: number; reason: string } | null = null
  constructor(
    public conn: HubConn,
    private readonly live: Set<FakeSocket>,
  ) {}
  send(text: string): void {
    this.frames.push(JSON.parse(text) as Frame)
  }
  close(code: number, reason: string): void {
    this.closedWith = { code, reason }
    this.live.delete(this)
  }
  pushes(method: string): any[] {
    return this.frames.filter((f) => f.id === undefined && f.method === method).map((f) => f.params)
  }
}

const grant = (tokenId: string, expiresAt = START + 3_600_000): HubGrant => ({ tokenId, userId: "usr_1", actorId: null, expiresAt, scoped: false, role: null })

function setup(
  options: {
    limits?: Partial<HubLimits>
    dashboard?: (event: DashboardEvent) => void
    fetch?: ConstructorParameters<typeof RelayHub>[0]["fetch"]
    machineWake?: ConstructorParameters<typeof RelayHub>[0]["machineWake"]
    wake?: Partial<HubWakeOptions>
  } = {},
) {
  const clock = { now: START }
  const db = new Database(":memory:")
  const writes = { n: 0 }
  const sql: Sql = {
    all: <T>(query: string, ...params: SqlValue[]) => {
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query)) writes.n++
      return db.query(query).all(...params) as T[]
    },
  }
  const live = new Set<FakeSocket>()
  const logs: { event: string; fields: Record<string, unknown> }[] = []
  const deps: ConstructorParameters<typeof RelayHub>[0] = {
    sql,
    hash: (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: (fn) => db.transaction(fn)(),
    now: () => clock.now,
    sockets: () => [...live],
    save: () => {},
    log: (event, fields) => logs.push({ event, fields }),
    limits: { ...HUB_LIMITS, ...options.limits },
    ...(options.dashboard ? { dashboard: options.dashboard } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.machineWake ? { machineWake: options.machineWake } : {}),
    ...(options.wake ? { wake: options.wake } : {}),
  }
  let hub = new RelayHub(deps)
  hub.init({ user: "ada" })
  /** a fresh hub on the same storage, as after the object was evicted or restarted */
  function restart(): RelayHub {
    hub = new RelayHub(deps)
    hub.init({ user: "ada" })
    return hub
  }
  let nextId = 1

  function connect(tokenId = "tok_a", actorId: string | null = null, extra: { [K in keyof HubGrant]?: HubGrant[K] | undefined } = {}): FakeSocket {
    const socket = new FakeSocket(RelayHub.connection({ ...grant(tokenId), actorId, ...extra } as HubGrant), live)
    live.add(socket)
    return socket
  }

  async function rpc(socket: FakeSocket, method: string, params: unknown = {}): Promise<Frame> {
    const id = nextId++
    await hub.message(socket, JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    return socket.frames.find((f) => f.id === id)!
  }

  async function ok(socket: FakeSocket, method: string, params: unknown = {}): Promise<any> {
    const frame = await rpc(socket, method, params)
    if (frame.error) throw new Error(`${method}: ${frame.error.data?.code} ${frame.error.message}`)
    return frame.result
  }

  async function fails(socket: FakeSocket, method: string, params: unknown = {}): Promise<string | undefined> {
    return (await rpc(socket, method, params)).error?.data?.code
  }

  async function bridge(
    machine: string,
    endpoints: { address: string; harness?: string; [field: string]: unknown }[],
    tokenId = "tok_a",
    actorId: string | null = null,
    extra: Partial<HubGrant> = {},
  ): Promise<FakeSocket> {
    const socket = connect(tokenId, actorId, extra)
    await ok(socket, "hello", { protocol: PROTOCOL, machine, bridge: true })
    await ok(socket, "mirror", {
      full: true,
      endpoints: endpoints.map((e) => ({ kind: "agent", harness: "claude-code", presence: "online", parent_ep: null, depth: 0, ...e })),
    })
    await ok(socket, "subscribe", { after: 0 })
    return socket
  }

  function disconnect(socket: FakeSocket) {
    live.delete(socket)
    hub.closed(socket)
  }

  return { hub, db, clock, live, logs, writes, connect, rpc, ok, fails, bridge, disconnect, restart }
}

describe("machines", () => {
  test("a machine binds to the first token; another token naming it is refused", async () => {
    const { connect, ok, fails } = setup()
    await ok(connect("tok_a"), "hello", { protocol: PROTOCOL, machine: "laptop", bridge: true })
    expect(await fails(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "laptop", bridge: true })).toBe("unauthorized")
    expect(await fails(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "laptop", claim: { handle: "x" } })).toBe("unauthorized")
    expect(await fails(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "ada" })).toBe("invalid_params")
    expect(await fails(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "me" })).toBe("invalid_params")
    expect(await fails(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "ci", auth: "account+bridge" })).toBe("invalid_params")
    expect(await fails(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "ci", human: true })).toBe("invalid_params")
  })

  test("a failed hello binds nothing and uses no machine slot", async () => {
    const { connect, ok, fails } = setup()
    expect(await fails(connect("tok_a"), "hello", { protocol: PROTOCOL, machine: "ci", resume: "kre_unknown" })).toBe("unauthorized")
    expect(await fails(connect("tok_a"), "hello", { protocol: PROTOCOL, machine: "desk", claim: { handle: "Bad Handle" } })).toBe("invalid_params")
    const cli = connect("tok_b")
    await ok(cli, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    expect((await ok(cli, "machines")).machines.map((m: any) => m.name)).toEqual(["ci"])
  })

  test("revoking a token unbinds its machines but keeps their endpoints for a full login of the same member", async () => {
    const { hub, bridge, connect, ok } = setup()
    await bridge("laptop", [{ address: "me/review" }], "tok_a")
    const first = connect("tok_a")
    const { endpoint, token } = await ok(first, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    hub.revoke({ tokenId: "tok_a" })
    const resumed = await ok(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "ci", resume: token })
    expect(resumed.endpoint.id).toBe(endpoint.id)
    const laptop = await bridge("laptop", [{ address: "me/review" }], "tok_b")
    expect((await ok(laptop, "list", { all: true })).endpoints.filter((e: any) => e.address === "ada/laptop/review").map((e: any) => e.presence)).toEqual([
      "online",
    ])
  })

  test("revoking an actor unbinds the machines its tokens bound, even with no socket open", async () => {
    const { hub, connect, ok, fails, disconnect } = setup()
    const member = connect("tok_m", "usr_m", { role: "member" })
    await ok(member, "hello", { protocol: PROTOCOL, machine: "laptop", bridge: true })
    disconnect(member)
    const owner = connect("tok_o", "usr_o", { role: "owner" })
    await ok(owner, "hello", { protocol: PROTOCOL, machine: "desk", claim: { handle: "impl" } })
    expect(await fails(connect("tok_x", "usr_x", { role: "admin" }), "hello", { protocol: PROTOCOL, machine: "laptop", bridge: true })).toBe("unauthorized")
    expect(hub.revoke({ userId: "usr_1", actorId: "usr_m" })).toBe(0)
    expect((await ok(owner, "machines")).machines.map((m: any) => [m.name, m.kind])).toEqual([
      ["desk", "client"],
      ["laptop", "revoked"],
    ])
    await ok(connect("tok_b", "usr_m", { role: "member" }), "hello", { protocol: PROTOCOL, machine: "laptop", bridge: true })
    expect((await ok(owner, "machines")).machines.map((m: any) => [m.name, m.kind])).toEqual([
      ["desk", "client"],
      ["laptop", "bridge"],
    ])
    hub.revoke({ userId: "usr_1" })
    const after = connect("tok_c", "usr_o", { role: "owner" })
    await ok(after, "hello", { protocol: PROTOCOL, machine: "laptop", claim: { handle: "impl" } })
    expect((await ok(after, "machines")).machines.map((m: any) => [m.name, m.kind])).toEqual([
      ["laptop", "client"],
      ["desk", "revoked"],
    ])
  })

  test("a newer bridge for the machine replaces the older one, whose rows stay online", async () => {
    const { bridge, connect, ok } = setup()
    const old = await bridge("laptop", [{ address: "me/impl" }])
    const newer = connect()
    const hello = await ok(newer, "hello", { protocol: PROTOCOL, machine: "laptop", bridge: true })
    expect(hello.account).toBe("ada")
    expect(old.closedWith?.code).toBe(4000)
    const desk = await bridge("desk", [])
    expect((await ok(desk, "list")).endpoints.find((e: any) => e.address === "ada/laptop/impl").presence).toBe("online")
  })

  test("a bridge's hello lists the other machines' endpoints; its mirror pushes endpoints to the others; closing marks them offline", async () => {
    const { bridge, disconnect } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review" }])
    const deskHello = desk.frames.find((f) => f.result?.machine === "desk")!.result
    expect(deskHello.endpoints.map((e: any) => [e.machine, e.address])).toEqual([["laptop", "ada/laptop/impl"]])
    expect(laptop.pushes("endpoints").map((p) => [p.machine, p.full, p.endpoints.map((e: any) => e.address)])).toEqual([["desk", true, ["ada/desk/review"]]])
    disconnect(desk)
    const last = laptop.pushes("endpoints").at(-1)
    expect([last.machine, last.full, last.endpoints.map((e: any) => [e.address, e.presence])]).toEqual(["desk", false, [["ada/desk/review", "offline"]]])
  })

  test("machines lists bindings; machines_rm drops the rows, closes the bridge and tells the others", async () => {
    const { bridge, connect, ok } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review" }])
    const cli = connect()
    await ok(cli, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    expect((await ok(cli, "machines")).machines.map((m: any) => [m.name, m.kind, m.online, m.bridge])).toEqual([
      ["desk", "bridge", true, true],
      ["laptop", "bridge", true, true],
    ])
    expect(await ok(cli, "machines_rm", { name: "desk" })).toEqual({ removed: "desk", endpoints: 1 })
    expect(desk.closedWith?.code).toBe(1008)
    expect(laptop.pushes("endpoints").at(-1)).toEqual({ machine: "desk", endpoints: [], full: true, released: true })
    expect((await ok(cli, "list", { all: true })).endpoints.map((e: any) => e.address)).toEqual(["ada/", "ada/laptop/impl"])
    await ok(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
  })
})

describe("bridges", () => {
  test("a forward from one machine is pushed to the other's bridge, acked once, and not replayed", async () => {
    const { bridge, connect, ok, disconnect } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review" }])
    const sent = await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "please review" }, hop_floor: 0 })
    const [push] = desk.pushes("deliver")
    expect(push.seq).toBe(sent.deliveries[0].seq)
    expect(push.endpoint).toBe("desk/review")
    expect(push.message).toMatchObject({
      id: sent.id,
      body: { text: "please review" },
      from: { address: "ada/laptop/impl", auth: "account+bridge", machine: "laptop" },
    })
    expect(await ok(desk, "ack", { seqs: [push.seq] })).toEqual({ acked: 1 })
    disconnect(desk)
    const again = connect()
    await ok(again, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
    expect(await ok(again, "subscribe", { after: 0 })).toEqual({ replayed: 0, next: 0 })
    expect(again.pushes("deliver")).toEqual([])
  })

  test("an unacked delivery replays after the bridge reconnects", async () => {
    const { bridge, connect, ok, disconnect } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review" }])
    disconnect(desk)
    const sent = await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "while you were away" } })
    const again = connect()
    await ok(again, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
    expect(await ok(again, "subscribe", { after: 0 })).toEqual({ replayed: 1, next: sent.deliveries[0].seq })
    expect(again.pushes("deliver").map((p) => p.message.id)).toEqual([sent.id])
  })

  test("a duplicate client_id forwards once", async () => {
    const { bridge, ok } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review" }])
    const params = { from: "impl", params: { to: "desk/review", body: "once", client_id: "c-1" } }
    const first = await ok(laptop, "forward", params)
    const second = await ok(laptop, "forward", params)
    expect(second).toMatchObject({ id: first.id, duplicate: true })
    expect(desk.pushes("deliver")).toHaveLength(1)
  })

  test("hop_floor raises the hop, and a floor past the limit is a loop_guard", async () => {
    const { bridge, ok, fails } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    await bridge("desk", [{ address: "me/review" }])
    expect((await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "a" }, hop_floor: 5 })).hop).toBe(5)
    expect(await fails(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "b" }, hop_floor: LIMITS.hopMax + 1 })).toBe("loop_guard")
  })

  test("hop_floor is clamped to one past the hop limit", async () => {
    const { bridge, rpc } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    await bridge("desk", [{ address: "me/review" }])
    const refused = await rpc(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "b" }, hop_floor: 1000 })
    expect(refused.error?.data?.code).toBe("loop_guard")
    expect(refused.error?.message).toContain(`would be hop ${LIMITS.hopMax + 1} `)
  })

  test("the scrubber and server-set fields apply to forwards", async () => {
    const { bridge, fails } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review" }])
    expect(await fails(laptop, "forward", { from: "impl", params: { to: "desk/review", body: `use scp_${"z".repeat(24)}` } })).toBe("secret_refused")
    expect(await fails(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "x", hop: 0 } })).toBe("invalid_params")
    expect(desk.pushes("deliver")).toEqual([])
  })

  test("a bridge can only act as its own machine's endpoints", async () => {
    const { bridge, fails, ok } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    await bridge("desk", [{ address: "me/review" }])
    expect(await fails(laptop, "forward", { from: "review", params: { to: "desk/review", body: "x" } })).toBe("not_found")
    expect(await fails(laptop, "forward", { from: "desk/review", params: { to: "laptop/impl", body: "x" } })).toBe("invalid_params")
    expect(await fails(laptop, "forward", { from: "", params: { to: "desk/review", body: "x" } })).toBe("not_found")
    expect(await fails(laptop, "event", { from: "review", kind: "tool", tool: "Bash" })).toBe("not_found")
    await ok(laptop, "mirror", { endpoints: [{ address: "ada/desk/review", kind: "agent", harness: "grok", presence: "offline" }] })
    const review = (await ok(laptop, "list", { all: true })).endpoints.find((e: any) => e.address === "ada/desk/review")
    expect([review.harness, review.presence]).toEqual(["claude-code", "online"])
    expect(await fails(laptop, "send", { to: "desk/review", body: "x" })).toBe("method_not_found")
  })

  test("a bridge's scope fields reach the other bridges, and the hub refuses a forward its recipient's mirrored rules do not admit", async () => {
    const { bridge, ok, fails } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const review = (rules: unknown) => ({
      address: "me/review",
      kind: "agent",
      harness: "codex",
      presence: "online",
      parent_ep: null,
      depth: 0,
      rules,
      title: "reviews",
      incarnation: "i1",
    })
    const desk = await bridge("desk", [review({ in: ["tree:descendants"] })])
    expect(laptop.pushes("endpoints").at(-1).endpoints[0]).toMatchObject({
      address: "ada/desk/review",
      tree: "review",
      parent_ep: null,
      depth: 0,
      rules: { in: ["tree:descendants"] },
      title: "reviews",
      incarnation: "i1",
    })
    expect(await fails(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "x" } })).toBe("not_found")
    const pushed = laptop.pushes("endpoints").length
    await ok(desk, "mirror", { full: true, endpoints: [review({ in: ["tree:descendants"] })] })
    expect(laptop.pushes("endpoints").length).toBe(pushed + 1)
    await ok(desk, "mirror", { endpoints: [review({ in: ["tree:descendants", "machine:laptop"] })] })
    expect(laptop.pushes("endpoints").at(-1)).toMatchObject({
      machine: "desk",
      full: false,
      endpoints: [{ rules: { in: ["tree:descendants", "machine:laptop"] } }],
    })
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "x" } })
    expect(desk.pushes("deliver").length).toBe(1)
  })

  test("a forward from a machine's human at a terminal carries the human flag; without a terminal, or from an agent, it does not", async () => {
    const { bridge, ok } = setup()
    const laptop = await bridge("laptop", [{ address: "me/", kind: "human" }, { address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review" }])
    await ok(laptop, "forward", { from: "", tty: true, params: { to: "desk/review", body: "from my laptop" } })
    await ok(laptop, "forward", { from: "", tty: false, params: { to: "desk/review", body: "a script" } })
    await ok(laptop, "forward", { from: "impl", tty: true, params: { to: "desk/review", body: "an agent" } })
    const from = desk.pushes("deliver").map((push) => [push.message.body.text, push.message.from.address, push.message.from.human])
    expect(from).toEqual([
      ["from my laptop", "ada/laptop/", true],
      ["a script", "ada/laptop/", undefined],
      ["an agent", "ada/laptop/impl", undefined],
    ])
    await ok(desk, "forward", { from: "review", params: { to: "laptop/me", body: "answer" } })
    expect(laptop.pushes("deliver").map((push) => push.endpoint)).toEqual(["laptop/"])
  })

  test("a reject acks the delivery and sends the sender a relay notice", async () => {
    const { bridge, ok } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review" }])
    const sent = await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "x" } })
    expect(await ok(desk, "reject", { seq: sent.deliveries[0].seq, code: "policy_refused" })).toEqual({ rejected: true })
    const [notice] = laptop.pushes("deliver")
    expect(notice.endpoint).toBe("laptop/impl")
    expect(notice.message).toMatchObject({ kind: "status", from: { address: "ada/relay" } })
    expect(notice.message.body.text).toContain("policy_refused")
  })
})

describe("direct clients", () => {
  test("a client claims on its machine, asks a bridged endpoint and gets the reply", async () => {
    const { bridge, connect, ok } = setup()
    const desk = await bridge("desk", [{ address: "me/review" }])
    const ci = connect("tok_c")
    const hello = await ok(ci, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl", harness: "codex" } })
    expect(hello.endpoint.address).toBe("ada/ci/impl")
    expect(hello.token).toStartWith("kre_")
    expect(
      desk
        .pushes("endpoints")
        .at(-1)
        .endpoints.map((e: any) => e.address),
    ).toEqual(["ada/ci/impl"])
    const asking = ok(ci, "ask", { to: "desk/review", body: "is this right?", wait_s: 5 })
    await Bun.sleep(5)
    const [push] = desk.pushes("deliver")
    expect(push.message).toMatchObject({ kind: "request", from: { address: "ada/ci/impl", auth: "account", machine: "ci" } })
    await ok(desk, "forward", { from: "review", params: { to: "ci/impl", kind: "reply", reply_to: push.message.id, body: "yes" } })
    const answered = await asking
    expect(answered.reply.body.text).toBe("yes")
    expect(answered.reply.from.address).toBe("ada/desk/review")
  })

  test("a resume token of one machine is refused on another", async () => {
    const { connect, ok, fails, disconnect } = setup()
    const first = connect("tok_c")
    const { token } = await ok(first, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    disconnect(first)
    expect(await fails(connect("tok_c"), "hello", { protocol: PROTOCOL, machine: "ci2", resume: token })).toBe("unauthorized")
    expect((await ok(connect("tok_c"), "hello", { protocol: PROTOCOL, machine: "ci", resume: token })).endpoint.address).toBe("ada/ci/impl")
  })

  test("a full mirror in three frames flaps no presence and writes no row when nothing changed; an endpoint gone from it goes offline once", async () => {
    const { bridge, connect, ok, clock, writes } = setup()
    const seen = new Date(START).toISOString()
    const views = Array.from({ length: 6 }, (_, i) => ({ address: `me/w${i}`, kind: "agent", harness: "claude-code", presence: "online", last_seen: seen }))
    const laptop = await bridge("laptop", views)
    const desk = await bridge("desk", [{ address: "me/review" }])
    const watcher = connect()
    await ok(watcher, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: false })
    await ok(watcher, "watch")
    const resync = async (id: string, list: typeof views) => {
      const frames = [list.slice(0, 2), list.slice(2, 4), list.slice(4)]
      for (const [i, endpoints] of frames.entries()) await ok(laptop, "mirror", { endpoints, full: i === 0, sync: { id, part: i + 1, parts: 3 } })
    }
    clock.now += 60_000
    desk.frames = []
    writes.n = 0
    await resync("sync_1", views)
    expect(writes.n).toBe(0)
    expect(watcher.pushes("fleet")).toEqual([])
    const pushed = desk.pushes("endpoints")
    expect(pushed.flatMap((p) => p.endpoints).filter((e) => e.presence !== "online")).toEqual([])
    expect(pushed.at(-1)).toMatchObject({ machine: "laptop", full: true })
    expect(pushed.at(-1).endpoints).toHaveLength(6)

    await resync("sync_2", views.slice(0, 5))
    expect(watcher.pushes("fleet").map((e) => [e.type, e.endpoint, e.presence])).toEqual([["presence", "ada/laptop/w5", "offline"]])

    await ok(laptop, "mirror", { full: true, endpoints: views.slice(0, 4) })
    expect(
      watcher
        .pushes("fleet")
        .map((e) => [e.endpoint, e.presence])
        .at(-1),
    ).toEqual(["ada/laptop/w4", "offline"])
  })

  test("watchers get fleet events with the machine", async () => {
    const { bridge, connect, ok } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review" }])
    const watcher = connect()
    await ok(watcher, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: false })
    await ok(watcher, "watch")
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "x" } })
    await ok(desk, "event", { from: "review", kind: "tool", tool: "Bash", summary: "bun test" })
    await ok(desk, "mirror", {
      endpoints: [{ address: "me/review", kind: "agent", harness: "claude-code", presence: "online", status: { state: "working", note: "reviewing" } }],
    })
    const events = watcher.pushes("fleet").map((e) => [e.type, e.machine])
    expect(events).toEqual([
      ["message", "laptop"],
      ["activity", "desk"],
      ["status", "desk"],
    ])
    expect(watcher.pushes("fleet")[1].endpoint).toBe("ada/desk/review")
  })
})

describe("auth and lifecycle", () => {
  test("revoke closes matching sockets with 1008 after a revoked notice", async () => {
    const { hub, bridge, connect, ok } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const other = connect("tok_b")
    await ok(other, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    expect(hub.revoke({ tokenId: "tok_a" })).toBe(1)
    expect(laptop.pushes("revoked")).toHaveLength(1)
    expect(laptop.closedWith?.code).toBe(1008)
    expect(other.closedWith).toBeNull()
    expect(hub.revoke({})).toBe(0)
  })

  test("the alarm closes sockets whose grant fails validation with 1008 or expired with 4001, and schedules the next one", async () => {
    const { hub, clock, connect, ok } = setup()
    const good = connect("tok_good")
    const bad = connect("tok_bad")
    await ok(good, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    await ok(bad, "hello", { protocol: PROTOCOL, machine: "ci2", human: true, tty: true })
    expect(hub.nextAlarm()).toBe(START + HUB_LIMITS.revalidateMs)
    const next = await hub.alarm(async (g) => g.tokenId !== "tok_bad")
    expect(bad.closedWith?.code).toBe(1008)
    expect(good.closedWith).toBeNull()
    expect(next).toBe(START + HUB_LIMITS.revalidateMs)
    clock.now += 3_600_000
    await hub.alarm(async () => true)
    expect(good.closedWith?.code).toBe(4001)
    expect(hub.nextAlarm()).toBe(clock.now + 86_400_000)
  })

  test("a check that throws keeps the sockets and retries in 30 s; errors past the grace period close with the retryable 1013", async () => {
    const { hub, clock, logs, connect, ok } = setup()
    const first = connect("tok_a")
    const second = connect("tok_a")
    await ok(first, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    await ok(second, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: false })
    const down = async (): Promise<boolean> => {
      throw new Error("d1 down")
    }
    expect(await hub.alarm(down)).toBe(START + 30_000)
    expect([first.closedWith, second.closedWith]).toEqual([null, null])
    expect(logs.filter((l) => l.event === "relay_revalidate_error").map((l) => l.fields)).toEqual([{ account: "ada", error: "Error" }])
    clock.now = START + HUB_LIMITS.revalidateMs - 1
    await hub.alarm(down)
    expect(first.closedWith).toBeNull()
    clock.now = START + HUB_LIMITS.revalidateMs
    await hub.alarm(down)
    expect(first.pushes("revoked")).toEqual([{ reason: "the token could not be revalidated, try again" }])
    expect([first.closedWith, second.closedWith]).toEqual([
      { code: 1013, reason: "the token could not be revalidated, try again" },
      { code: 1013, reason: "the token could not be revalidated, try again" },
    ])
    const back = connect("tok_a")
    await ok(back, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    clock.now += 30_000
    await hub.alarm(down)
    expect(back.closedWith).toBeNull()
  })

  test("a successful check clears the error state, so a later error starts a new grace period", async () => {
    const { hub, clock, connect, ok } = setup()
    const socket = connect("tok_a")
    await ok(socket, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    const down = async (): Promise<boolean> => {
      throw new Error("d1 down")
    }
    expect(await hub.alarm(down)).toBe(START + 30_000)
    clock.now = START + 30_000
    expect(await hub.alarm(async () => true)).toBe(START + 30_000 + HUB_LIMITS.revalidateMs)
    clock.now = START + HUB_LIMITS.revalidateMs + 30_000
    expect(await hub.alarm(down)).toBe(clock.now + 30_000)
    expect(socket.closedWith).toBeNull()
    clock.now += HUB_LIMITS.revalidateMs
    await hub.alarm(async () => false)
    expect(socket.closedWith?.code).toBe(1008)
  })

  test("a batch runs hello then calls on a transient connection", async () => {
    const { hub, bridge } = setup()
    const desk = await bridge("desk", [{ address: "me/review" }])
    const responses = (await hub.batch(grant("tok_c"), [
      { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: PROTOCOL, machine: "ci", human: true, tty: false } },
      { jsonrpc: "2.0", id: 2, method: "send", params: { to: "desk/review", body: "from curl" } },
    ])) as Frame[]
    expect(responses.map((r) => r.error)).toEqual([undefined, undefined])
    expect(desk.pushes("deliver").map((p) => [p.message.body.text, p.message.from.address, p.message.from.claims.tty])).toEqual([["from curl", "ada/", false]])
    const single = (await hub.batch(grant("tok_c"), { jsonrpc: "2.0", id: 1, method: "whoami" })) as Frame
    expect(single.error?.data?.code).toBe("unauthorized")
    const bridged = (await hub.batch(grant("tok_c"), [
      { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: PROTOCOL, machine: "ci", bridge: true } },
    ])) as Frame[]
    expect(bridged[0]!.error?.data?.code).toBe("invalid_params")
  })

  test("limits: machines per account, frame size, calls per minute", async () => {
    const { hub, connect, ok, fails } = setup()
    for (let i = 0; i < HUB_LIMITS.machines; i++) await ok(connect(), "hello", { protocol: PROTOCOL, machine: `m${i}`, claim: { handle: "impl" } })
    expect(await fails(connect(), "hello", { protocol: PROTOCOL, machine: "one-more", claim: { handle: "impl" } })).toBe("too_large")
    const big = connect()
    await hub.message(big, "x".repeat(HUB_LIMITS.frameBytes + 1))
    expect(big.frames[0]!.error?.data?.code).toBe("too_large")
    expect(big.closedWith?.code).toBe(1009)
    const fresh = setup()
    const busy = fresh.connect("tok_busy")
    await fresh.ok(busy, "hello", { protocol: PROTOCOL, machine: "m0", human: true, tty: true })
    for (let i = 1; i < HUB_LIMITS.callsPerMinute; i++) await fresh.ok(busy, "whoami")
    expect((await fresh.rpc(busy, "whoami")).error?.data).toEqual({ code: "rate_limited", retry_after: 1 })
  })

  test("the call bucket is per token, shared by batches and reconnects", async () => {
    const { hub, connect, ok, fails, disconnect } = setup()
    const hello = { jsonrpc: "2.0", id: 0, method: "hello", params: { protocol: PROTOCOL, machine: "ci", human: true, tty: false } }
    const calls = Array.from({ length: HUB_LIMITS.callsPerMinute - 2 }, (_, i) => ({ jsonrpc: "2.0", id: i + 1, method: "whoami" }))
    expect(((await hub.batch(grant("tok_a"), [hello, ...calls])) as Frame[]).every((r) => !r.error)).toBe(true)
    const socket = connect("tok_a")
    await ok(socket, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    disconnect(socket)
    expect(((await hub.batch(grant("tok_a"), [hello])) as Frame[])[0]!.error?.data?.code).toBe("rate_limited")
    expect(await fails(connect("tok_a"), "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })).toBe("rate_limited")
    await ok(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "desk", human: true, tty: true })
  })

  test("a bridge has its own, larger bucket, so a busy client on its token does not starve it", async () => {
    const { bridge, connect, ok, fails } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }], "tok_a")
    const busy = connect("tok_a")
    await ok(busy, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    for (let i = 1; i < HUB_LIMITS.callsPerMinute; i++) await ok(busy, "whoami")
    expect(await fails(busy, "whoami")).toBe("rate_limited")
    expect(await fails(connect("tok_a"), "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })).toBe("rate_limited")
    for (let i = 3; i < HUB_LIMITS.bridgeCallsPerMinute; i++) await ok(laptop, "list")
    expect(await fails(laptop, "list")).toBe("rate_limited")
    expect(laptop.closedWith).toBeNull()
  })

  test("an Infinity limit admits past the default cap; a duration must stay finite", async () => {
    const { connect, ok } = setup({ limits: { machines: Infinity, endpoints: Infinity, callsPerMinute: Infinity } })
    for (let i = 0; i <= HUB_LIMITS.machines; i++) await ok(connect(), "hello", { protocol: PROTOCOL, machine: `m${i}`, claim: { handle: "impl" } })
    for (let i = 0; i <= HUB_LIMITS.endpoints; i++) await ok(connect(), "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: `w${i}` } })
    const busy = connect("tok_busy")
    await ok(busy, "hello", { protocol: PROTOCOL, machine: "desk", human: true, tty: true })
    for (let i = 0; i <= 120; i++) await ok(busy, "whoami")
    expect(() => setup({ limits: { revalidateMs: Infinity } })).toThrow(RangeError)
  })

  test("a grant's labels go on every endpoint it claims, resumes or mirrors, over the client's own", async () => {
    const { bridge, connect, ok, fails, disconnect } = setup()
    const labels = { token: "ci-bot" }
    const first = connect("tok_c", null, { labels })
    const hello = await ok(first, "hello", {
      protocol: PROTOCOL,
      machine: "ci",
      claim: { handle: "impl", labels: { token: "spoof", team: "x" } },
    })
    expect(hello.endpoint.labels).toEqual({ token: "ci-bot", team: "x" })
    disconnect(first)
    const relabeled = connect("tok_c", null, { labels: { token: "ci-bot-2", lane: "a" } })
    const resumed = await ok(relabeled, "hello", { protocol: PROTOCOL, machine: "ci", resume: hello.token })
    expect(resumed.endpoint).toMatchObject({ id: hello.endpoint.id, labels: { token: "ci-bot-2", team: "x", lane: "a" } })
    disconnect(relabeled)
    const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, "v"]))
    expect(await fails(connect("tok_c", null, { labels: many }), "hello", { protocol: PROTOCOL, machine: "ci", resume: hello.token })).toBe("too_large")
    expect((await ok(connect("tok_c"), "hello", { protocol: PROTOCOL, machine: "ci", resume: hello.token })).endpoint.labels).toEqual({
      token: "ci-bot-2",
      team: "x",
      lane: "a",
    })
    const laptop = await bridge("laptop", [{ address: "me/review", labels: { token: "spoof" } }], "tok_b", null, { labels })
    const mirrored = async () => (await ok(laptop, "list", { all: true })).endpoints.find((e: any) => e.address === "ada/laptop/review").labels
    expect(await mirrored()).toEqual({ token: "ci-bot" })
    await ok(laptop, "mirror", { endpoints: [{ address: "me/review", kind: "agent", presence: "online", labels: { role: "rev", token: "spoof" } }] })
    expect(await mirrored()).toEqual({ role: "rev", token: "ci-bot" })
    await ok(laptop, "mirror", { endpoints: [{ address: "me/review", kind: "agent", presence: "online" }] })
    expect(await mirrored()).toEqual({ token: "ci-bot" })
    const full = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"]))
    expect(await fails(connect("tok_d", null, { labels }), "hello", { protocol: PROTOCOL, machine: "desk", claim: { handle: "many", labels: full } })).toBe(
      "too_large",
    )
  })
})

const FAR = START + 365 * 86_400_000
const observe = { protocol: PROTOCOL, observe: true }

describe("machine ownership", () => {
  test("only the bound token, a full login of its member or an org owner or admin releases a machine", async () => {
    const { bridge, connect, ok, rpc, fails } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }], "tok_m", "usr_m", { role: "member" })
    await bridge("desk", [{ address: "me/review" }], "tok_m", "usr_m", { role: "member" })
    const scoped = connect("tok_s", "usr_m", { scoped: true, role: "member" })
    await ok(scoped, "hello", observe)
    const refused = await rpc(scoped, "machines_rm", { name: "laptop" })
    expect([refused.error?.data?.code, refused.error?.message]).toEqual([
      "unauthorized",
      "only the token machine laptop is bound to, a full login of the member who bound it, or an org owner or admin can release it; any credential of that member can once it is offline",
    ])
    const other = connect("tok_v", "usr_v", { role: "member" })
    await ok(other, "hello", observe)
    expect(await fails(other, "machines_rm", { name: "laptop" })).toBe("unauthorized")
    expect(laptop.closedWith).toBeNull()
    expect((await ok(other, "log")).rows.filter((r: any) => r.event === "refuse" && r.detail.machine === "laptop").map((r: any) => r.detail.code)).toEqual([
      "unauthorized",
      "unauthorized",
    ])
    const same = connect("tok_m2", "usr_m", { role: "member" })
    await ok(same, "hello", observe)
    expect(await ok(same, "machines_rm", { name: "laptop" })).toEqual({ removed: "laptop", endpoints: 1 })
    const admin = connect("tok_ad", "usr_ad", { role: "admin" })
    await ok(admin, "hello", observe)
    expect(await ok(admin, "machines_rm", { name: "desk" })).toEqual({ removed: "desk", endpoints: 1 })
    const own = connect("tok_s", "usr_m", { scoped: true, role: "member" })
    await ok(own, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    expect(await ok(own, "machines_rm", { name: "ci" })).toEqual({ removed: "ci", endpoints: 1 })
  })

  test("a member's rotated token releases the offline machine its old token bound, and only once no connection holds it", async () => {
    const { bridge, connect, ok, fails, disconnect } = setup()
    const runner = await bridge("runner", [{ address: "me/bot" }], "tok_old", "usr_m", { scoped: true, role: "member" })
    const rotated = connect("tok_new", "usr_m", { scoped: true, role: "member" })
    await ok(rotated, "hello", observe)
    expect(await fails(rotated, "machines_rm", { name: "runner" })).toBe("unauthorized")
    const stranger = connect("tok_v", "usr_v", { scoped: true, role: "member" })
    await ok(stranger, "hello", observe)
    disconnect(runner)
    expect(await fails(stranger, "machines_rm", { name: "runner" })).toBe("unauthorized")
    expect(await ok(rotated, "machines_rm", { name: "runner" })).toEqual({ removed: "runner", endpoints: 1 })
  })

  test("after a revoke a scoped token or another member can't rebind or release the name, and gets nothing replayed", async () => {
    const { hub, bridge, connect, ok, rpc, fails, disconnect } = setup()
    const desk = await bridge("desk", [{ address: "me/review" }], "tok_m", "usr_m", { role: "member" })
    const laptop = await bridge("laptop", [{ address: "me/impl" }], "tok_o", "usr_o", { role: "owner" })
    disconnect(desk)
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "queued" } })
    hub.revoke({ tokenId: "tok_m" })
    for (const intruder of [connect("tok_s", "usr_m", { scoped: true, role: "member" }), connect("tok_v", "usr_v", { role: "member" })]) {
      const refused = await rpc(intruder, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
      expect([refused.error?.data?.code, refused.error?.message]).toEqual([
        "unauthorized",
        "machine desk was unbound when its token was revoked; a full login of the same member (or an org owner or admin) can take it back, or swarm machines rm desk drops its queued messages",
      ])
      expect(await fails(intruder, "hello", { protocol: PROTOCOL, machine: "desk", claim: { handle: "review" } })).toBe("unauthorized")
      expect(await fails(intruder, "subscribe", { after: 0 })).toBe("unauthorized")
      expect(intruder.pushes("deliver")).toEqual([])
      await ok(intruder, "hello", observe)
      expect(await fails(intruder, "machines_rm", { name: "desk" })).toBe("unauthorized")
    }
    const back = await bridge("desk", [{ address: "me/review" }], "tok_m2", "usr_m", { role: "member" })
    expect(back.pushes("deliver").map((p) => p.message.body.text)).toEqual(["queued"])
  })

  test("an org admin may take a revoked member's machine back, or release it and its queue", async () => {
    const { hub, db, bridge, connect, ok, disconnect } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }], "tok_o", "usr_o", { role: "owner" })
    disconnect(await bridge("desk", [{ address: "me/review" }], "tok_m", "usr_m", { role: "member" }))
    disconnect(await bridge("ci", [{ address: "me/build" }], "tok_m", "usr_m", { role: "member" }))
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "for desk" } })
    await ok(laptop, "forward", { from: "impl", params: { to: "ci/build", body: "for ci" } })
    hub.revoke({ tokenId: "tok_m" })
    const admin = await bridge("desk", [{ address: "me/review" }], "tok_ad", "usr_ad", { role: "admin" })
    expect(admin.pushes("deliver").map((p) => p.message.body.text)).toEqual(["for desk"])
    const observer = connect("tok_ad", "usr_ad", { role: "admin" })
    await ok(observer, "hello", observe)
    expect(await ok(observer, "machines_rm", { name: "ci" })).toEqual({ removed: "ci", endpoints: 1 })
    expect(db.query("SELECT body FROM messages ORDER BY body").all()).toEqual([{ body: "for desk" }])
    const fresh = await bridge("ci", [{ address: "me/build" }], "tok_v", "usr_v", { role: "member" })
    expect(fresh.pushes("deliver")).toEqual([])
  })

  test("releasing a machine keeps the requests others asked it, so an answered ask still finds its reply", async () => {
    const { bridge, connect, ok } = setup()
    const ci = await bridge("ci", [{ address: "me/build" }])
    const client = connect()
    await ok(client, "hello", { protocol: PROTOCOL, machine: "desk", claim: { handle: "impl" } })
    const asked = await ok(client, "ask", { to: "ci/build", body: "green?" })
    await ok(ci, "forward", { from: "build", params: { to: "desk/impl", body: "yes", kind: "reply", reply_to: asked.id } })
    await ok(client, "machines_rm", { name: "ci" })
    expect((await ok(client, "ask_wait", { id: asked.id })).reply.body.text).toBe("yes")
  })

  test("a revoked machine's tombstone outlives its age while mail queued after the revoke is undelivered", async () => {
    const { hub, clock, bridge, connect, ok, fails, disconnect } = setup()
    disconnect(await bridge("desk", [{ address: "me/review" }], "tok_m", "usr_m", { role: "member", expiresAt: FAR }))
    hub.revoke({ tokenId: "tok_m" })
    clock.now += (LIMITS.ttlMaxS + LIMITS.purgeAfterS - 86_400) * 1000
    const laptop = await bridge("laptop", [{ address: "me/impl" }], "tok_o", "usr_o", { role: "owner", expiresAt: FAR })
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "late", ttl_s: LIMITS.ttlMaxS } })
    clock.now += 2 * 86_400_000
    await hub.alarm(async () => true)
    expect(await fails(connect("tok_v", "usr_v", { role: "member", expiresAt: FAR }), "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })).toBe(
      "unauthorized",
    )
    clock.now += LIMITS.ttlMaxS * 1000
    await hub.alarm(async () => true)
    const fresh = await bridge("desk", [{ address: "me/review" }], "tok_v", "usr_v", { role: "member", expiresAt: FAR })
    expect(fresh.pushes("deliver")).toEqual([])
  })

  test("sweeping a revoked machine's tombstone retires its rows, so its addresses resolve to nothing and a new binding of the name inherits none", async () => {
    const { hub, clock, bridge, ok, fails, disconnect } = setup()
    const owner = await bridge("laptop", [{ address: "me/impl" }], "tok_o", "usr_o", { role: "owner", expiresAt: FAR })
    disconnect(await bridge("desk", [{ address: "me/review" }, { address: "me/", kind: "human" } as any], "tok_m", "usr_m", { role: "member", expiresAt: FAR }))
    hub.revoke({ tokenId: "tok_m" })
    for (let day = 0; day < 40; day++) {
      clock.now += 86_400_000
      await hub.alarm(async () => true)
    }
    expect(owner.pushes("endpoints").at(-1)).toEqual({ machine: "desk", endpoints: [], full: true, released: true })
    for (const to of ["desk/", "desk/review"])
      expect(await fails(owner, "forward", { from: "impl", params: { to, body: "after the sweep" } })).toBe("not_found")
    const scoped = await bridge("desk", [], "tok_vs", "usr_v", { role: "member", scoped: true, expiresAt: FAR })
    expect(await fails(scoped, "forward", { from: "", params: { to: "laptop/impl", body: "as the old desk human" } })).toBe("not_found")
    await ok(scoped, "mirror", { full: true, endpoints: [{ address: "me/", kind: "human", presence: "online" }] })
    await ok(owner, "forward", { from: "impl", params: { to: "desk/", body: "to the new desk" } })
    expect(scoped.pushes("deliver").map((p) => p.message.body.text)).toEqual(["to the new desk"])
  })

  test("revalidation checks each grant a token's sockets carry, not the first one for all", async () => {
    const { hub, connect } = setup()
    const stale = connect("tok_m", "usr_m", { role: "admin" })
    const current = connect("tok_m", "usr_m", { role: "member" })
    await hub.alarm(async (g) => g.role === "member")
    expect(stale.closedWith?.code).toBe(1008)
    expect(current.closedWith).toBeNull()
  })
})

describe("direct clients on bridged machines", () => {
  test("a direct client's row on a bridged machine gets its messages directly; the bridge is never pushed, replayed or let ack them", async () => {
    const { bridge, connect, ok, fails, disconnect } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const client = connect()
    await ok(client, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "direct" } })
    const ci = await bridge("ci", [{ address: "me/review" }])
    const sent = await ok(laptop, "forward", { from: "impl", params: { to: "ci/direct", body: "for the direct client" } })
    const seq = sent.deliveries[0].seq
    expect(ci.pushes("deliver")).toEqual([])
    expect(await ok(ci, "ack", { seqs: [seq] })).toEqual({ acked: 0 })
    expect(await fails(ci, "reject", { seq, code: "policy_refused" })).toBe("not_found")
    disconnect(ci)
    const again = connect()
    await ok(again, "hello", { protocol: PROTOCOL, machine: "ci", bridge: true })
    expect(await ok(again, "subscribe", { after: 0 })).toEqual({ replayed: 0, next: 0 })
    expect((await ok(client, "inbox")).messages.map((m: any) => m.body.text)).toEqual(["for the direct client"])
  })

  test("a direct claim or resume on a machine bound as a bridge is refused", async () => {
    const { bridge, connect, ok, rpc, fails, disconnect } = setup()
    const first = connect()
    const { token } = await ok(first, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    disconnect(first)
    await bridge("ci", [])
    const refused = await rpc(connect(), "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "other" } })
    expect([refused.error?.data?.code, refused.error?.message]).toEqual([
      "invalid_params",
      "machine ci is linked through its broker's bridge; run the command there without --cloud, or pick another --machine",
    ])
    expect(await fails(connect(), "hello", { protocol: PROTOCOL, machine: "ci", resume: token })).toBe("invalid_params")
  })

  test("a bridge linking a name a direct client claimed first takes over its disconnected rows and their queued mail", async () => {
    const { bridge, connect, ok, disconnect } = setup()
    const desk = await bridge("desk", [{ address: "me/review" }])
    const first = connect()
    await ok(first, "hello", { protocol: PROTOCOL, machine: "laptop", claim: { handle: "claude", harness: "claude-code" } })
    disconnect(first)
    await ok(desk, "forward", { from: "review", params: { to: "laptop/claude", body: "queued before the bridge" } })
    const laptop = await bridge("laptop", [{ address: "me/claude" }])
    await ok(desk, "forward", { from: "review", params: { to: "laptop/claude", body: "after the bridge" } })
    expect(laptop.pushes("deliver").map((p) => [p.endpoint, p.message.body.text])).toEqual([
      ["laptop/claude", "queued before the bridge"],
      ["laptop/claude", "after the bridge"],
    ])
    expect((await ok(laptop, "list")).endpoints.find((e: any) => e.address === "ada/laptop/claude").presence).toBe("online")
  })

  test("a direct client still connected when a bridge links its machine hands its row and unread mail to the bridge when it leaves", async () => {
    const { bridge, connect, ok, disconnect } = setup()
    const desk = await bridge("desk", [{ address: "me/review" }])
    const client = connect()
    await ok(client, "hello", { protocol: PROTOCOL, machine: "laptop", claim: { handle: "claude", harness: "claude-code" } })
    const laptop = await bridge("laptop", [{ address: "me/claude" }])
    const unread = await ok(desk, "forward", { from: "review", params: { to: "laptop/claude", body: "unread when it left" } })
    expect(laptop.pushes("deliver")).toEqual([])
    disconnect(client)
    await ok(desk, "forward", { from: "review", params: { to: "laptop/claude", body: "after it left" } })
    expect(laptop.pushes("deliver").map((p) => p.message.body.text)).toEqual(["unread when it left", "after it left"])
    disconnect(laptop)
    const again = connect()
    await ok(again, "hello", { protocol: PROTOCOL, machine: "laptop", bridge: true })
    expect((await ok(again, "subscribe", { after: unread.deliveries[0].seq })).replayed).toBe(2)
  })
})

describe("retention", () => {
  test("an account used only over /rpc keeps a sweep alarm, and the sweep removes expired bodies", async () => {
    const { hub, clock, db } = setup()
    const responses = (await hub.batch(grant("tok_c"), [
      { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } } },
      { jsonrpc: "2.0", id: 2, method: "send", params: { to: "me/", body: "kept a while" } },
    ])) as Frame[]
    expect(responses.map((r) => r.error)).toEqual([undefined, undefined])
    expect(hub.nextAlarm()).toBe(START + 86_400_000)
    clock.now += (LIMITS.ttlDefaultS + LIMITS.purgeAfterS) * 1000 + 1
    expect(await hub.alarm(async () => true)).toBe(clock.now + 86_400_000)
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 })
  })

  test("the alarm comes at the earliest unacked delivery's expiry, but not sooner than a minute", async () => {
    const { hub, clock, bridge, ok, disconnect } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    disconnect(await bridge("desk", [{ address: "me/review" }]))
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "soon", ttl_s: 3600 } })
    disconnect(laptop)
    expect(hub.nextAlarm()).toBe(START + 3_600_000)
    clock.now = START + 3_600_000
    expect(hub.nextAlarm()).toBe(clock.now + 60_000)
  })

  test("an account with no machines for 30 days is due a purge; binding a machine clears it", async () => {
    const { hub, clock, connect, ok, disconnect } = setup()
    await hub.batch(grant("tok_c"), [{ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: PROTOCOL, machine: "ci", human: true, tty: false } }])
    expect(await hub.alarm(async () => true)).toBe(START + 86_400_000)
    expect(hub.purgeDue()).toBe(false)
    clock.now += HUB_LIMITS.idlePurgeS * 1000
    await hub.alarm(async () => true)
    expect(hub.purgeDue()).toBe(true)
    const client = connect("tok_c", null, { expiresAt: FAR })
    await ok(client, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    disconnect(client)
    expect(hub.purgeDue()).toBe(false)
    clock.now += HUB_LIMITS.idlePurgeS * 1000
    await hub.alarm(async () => true)
    expect(hub.purgeDue()).toBe(false)
  })

  test("a hello counts as use, so an account used only over /rpc is not purged", async () => {
    const { hub, clock } = setup()
    const human = [{ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: PROTOCOL, machine: "ci", human: true, tty: false } }]
    await hub.batch(grant("tok_c"), human)
    await hub.alarm(async () => true)
    clock.now += (HUB_LIMITS.idlePurgeS - 86_400) * 1000
    await hub.batch(grant("tok_c"), human)
    clock.now += 2 * 86_400_000
    await hub.alarm(async () => true)
    expect(hub.purgeDue()).toBe(false)
  })

  test("refusals write at most a few audit rows a minute for each code; the next row counts the ones left out", async () => {
    const { clock, connect, ok, fails } = setup({ limits: { storedBytes: 10 } })
    await ok(connect("tok_a"), "hello", { protocol: PROTOCOL, machine: "ci", bridge: true })
    for (let i = 0; i < HUB_LIMITS.refusalsPerMinute + 20; i++)
      expect(await fails(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "ci", bridge: true })).toBe("unauthorized")
    const client = connect("tok_c")
    await ok(client, "hello", { protocol: PROTOCOL, machine: "desk", claim: { handle: "impl" } })
    expect(await fails(client, "send", { to: "desk/impl", body: "x".repeat(11) })).toBe("too_large")
    clock.now += 60_000
    expect(await fails(connect("tok_b"), "hello", { protocol: PROTOCOL, machine: "ci", bridge: true })).toBe("unauthorized")
    const refusals = (await ok(client, "log", { limit: 1000 })).rows.filter((r: any) => r.event === "refuse").map((r: any) => r.detail)
    expect(refusals.length).toBe(HUB_LIMITS.refusalsPerMinute + 2)
    expect(refusals.at(-2)).toEqual({ code: "too_large" })
    expect(refusals.at(-1)).toEqual({ code: "unauthorized", machine: "ci", suppressed: 20 })
  })

  test("reset drops the core, so the next init migrates afresh", async () => {
    const { hub, db, connect, ok, disconnect } = setup()
    const client = connect()
    await ok(client, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    disconnect(client)
    for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      db.run(`DROP TABLE ${name}`)
    hub.reset()
    expect(() => hub.nextAlarm()).toThrow()
    hub.init({ user: "ada" })
    expect(hub.nextAlarm()).toBeNull()
    expect(await ok(connect(), "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })).toMatchObject({
      endpoint: { address: "ada/ci/impl" },
    })
  })
})

describe("quotas", () => {
  test("the day's cap counts every sender, humans included", async () => {
    const { db, bridge, connect, ok, rpc } = setup()
    await bridge("laptop", [{ address: "me/impl" }])
    const human = connect()
    await ok(human, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    const me = (db.query("SELECT id FROM endpoints WHERE handle = '_human'").get() as { id: string }).id
    const insert = db.prepare(
      `INSERT INTO messages (id, thread, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at) VALUES (?, 't', 'message', ?, 'x', 'x', 'text/plain', 'public', '[]', 0, ?, ?)`,
    )
    for (let i = 0; i < TEST_RATES.userPerDay; i++) insert.run(`msg_seed${String(i).padStart(8, "0")}`, me, START, START + 86_400_000)
    const refused = await rpc(human, "send", { to: "laptop/impl", body: "one more" })
    expect([refused.error?.data?.code, refused.error?.message]).toEqual(["rate_limited", `${TEST_RATES.userPerDay} messages in the last day`])
  })

  test("a human's terminal claim resets no hop on the hub", async () => {
    const { bridge, connect, ok } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const sent = await ok(laptop, "forward", { from: "impl", hop_floor: 5, params: { to: "ada/", body: "a long chain" } })
    expect(sent.hop).toBe(5)
    const human = connect()
    await ok(human, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    expect((await ok(human, "send", { to: "laptop/impl", body: "from a terminal", reply_to: sent.id })).hop).toBe(6)
  })

  test("calls spend from the account's bucket too", async () => {
    const { connect, ok, rpc } = setup()
    const tokens = HUB_LIMITS.accountCallsPerMinute / HUB_LIMITS.callsPerMinute
    for (let t = 0; t < tokens; t++) {
      const socket = connect(`tok_${t}`)
      await ok(socket, "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
      for (let i = 1; i < HUB_LIMITS.callsPerMinute; i++) await ok(socket, "whoami")
    }
    const refused = await rpc(connect("tok_late"), "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    expect([refused.error?.data?.code, refused.error?.message]).toEqual([
      "rate_limited",
      `at most ${HUB_LIMITS.accountCallsPerMinute} calls per minute on an account`,
    ])
  })

  test("acks and rejects spend from no call bucket, and activity events are shed below a quarter of the bucket", async () => {
    const { bridge, connect, ok, fails } = setup()
    const socket = connect()
    await ok(socket, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    const quarter = HUB_LIMITS.callsPerMinute / 4
    for (let i = 1; i < HUB_LIMITS.callsPerMinute - quarter; i++) await ok(socket, "whoami")
    await ok(socket, "event", { kind: "tool", tool: "Bash" })
    expect(await fails(socket, "event", { kind: "tool", tool: "Bash" })).toBe("rate_limited")
    for (let i = 0; i < quarter - 1; i++) await ok(socket, "whoami")
    expect(await fails(socket, "whoami")).toBe("rate_limited")
    expect(await ok(socket, "ack", { seqs: [] })).toEqual({ acked: 0 })
    const laptop = await bridge("laptop", [{ address: "me/impl" }], "tok_b")
    for (let i = 3; i < HUB_LIMITS.bridgeCallsPerMinute; i++) await ok(laptop, "list")
    expect(await fails(laptop, "list")).toBe("rate_limited")
    expect(await ok(laptop, "ack", { seqs: [] })).toEqual({ acked: 0 })
    expect(await fails(laptop, "reject", { seq: 1, code: "policy_refused" })).toBe("not_found")
  })

  test("acks take at most a page of seqs and spend a token per seq from their own buckets, which run out without closing the socket or starving calls", async () => {
    const { bridge, connect, ok, rpc, fails } = setup()
    const socket = connect()
    await ok(socket, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    const page = Array.from({ length: LIMITS.inboxPage }, (_, i) => i + 1)
    const over = await rpc(socket, "ack", { seqs: [...page, LIMITS.inboxPage + 1] })
    expect([over.error?.data?.code, over.error?.message]).toEqual(["invalid_params", `at most ${LIMITS.inboxPage} seqs per ack`])
    for (let i = 1; i < HUB_LIMITS.acksPerMinute / LIMITS.inboxPage; i++) await ok(socket, "ack", { seqs: page })
    const refused = await rpc(socket, "ack", { seqs: [1] })
    expect([refused.error?.data?.code, refused.error?.message]).toEqual([
      "rate_limited",
      `at most ${HUB_LIMITS.acksPerMinute} acked seqs per minute on a token`,
    ])
    for (let i = 0; i < HUB_LIMITS.acksPerMinute; i++) await fails(socket, "ack", { seqs: [] })
    expect(socket.closedWith).toBeNull()
    await ok(socket, "whoami")
    const laptop = await bridge("laptop", [{ address: "me/impl" }], "tok_b")
    expect(await fails(laptop, "ack", { seqs: [...page, 0] })).toBe("invalid_params")
    for (let i = LIMITS.inboxPage; i < HUB_LIMITS.acksPerMinute; i++) await ok(laptop, "ack", { seqs: [] })
    expect(await fails(laptop, "reject", { seq: 1, code: "policy_refused" })).toBe("rate_limited")
    await ok(laptop, "list")
    const tokens = HUB_LIMITS.accountAcksPerMinute / HUB_LIMITS.acksPerMinute
    for (let t = 2; t < tokens; t++) {
      const other = connect(`tok_${t}`)
      await ok(other, "hello", { protocol: PROTOCOL, machine: `ci-${t}`, claim: { handle: "impl" } })
      for (let i = 0; i < HUB_LIMITS.acksPerMinute / LIMITS.inboxPage; i++) await ok(other, "ack", { seqs: page })
    }
    const late = connect("tok_late")
    await ok(late, "hello", { protocol: PROTOCOL, machine: "late", claim: { handle: "impl" } })
    const account = await rpc(late, "ack", { seqs: [] })
    expect([account.error?.data?.code, account.error?.message]).toEqual([
      "rate_limited",
      `at most ${HUB_LIMITS.accountAcksPerMinute} acked seqs per minute on an account`,
    ])
  })

  test("a call refreshes its endpoint's last_seen at most every few seconds", async () => {
    const { clock, connect, ok } = setup()
    const socket = connect()
    await ok(socket, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    clock.now += 5_000
    await ok(socket, "ack", { seqs: [] })
    expect((await ok(socket, "whoami")).last_seen).toBe(new Date(START).toISOString())
    clock.now += 5_000
    expect((await ok(socket, "whoami")).last_seen).toBe(new Date(START + 10_000).toISOString())
  })

  test("an account holds at most its stored bytes of message bodies, counted from what it already holds", async () => {
    const { hub, db, clock, bridge, connect, ok, rpc } = setup({ limits: { storedBytes: 100 } })
    const laptop = await bridge("laptop", [{ address: "me/impl" }], "tok_a", null, { expiresAt: FAR })
    await bridge("desk", [{ address: "me/review" }], "tok_a", null, { expiresAt: FAR })
    const me = (db.query("SELECT id FROM endpoints WHERE handle = '_human'").get() as { id: string }).id
    db.query(
      `INSERT INTO messages (id, thread, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at) VALUES ('msg_seed0000', 't', 'message', ?, 'x', ?, 'text/plain', 'public', '[]', 0, ?, ?)`,
    ).run(me, "x".repeat(60), START, START + 1000)
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "ü".repeat(15) } })
    const refused = await rpc(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "x".repeat(11) } })
    expect([refused.error?.data?.code, refused.error?.message]).toEqual([
      "too_large",
      "the account relay holds its cap of 100 bytes of message bodies; ack or let messages expire, or release a machine with swarm machines rm",
    ])
    const client = connect()
    await ok(client, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    expect((await rpc(client, "send", { to: "desk/review", body: "x".repeat(11) })).error?.data?.code).toBe("too_large")
    await ok(client, "send", { to: "desk/review", body: "x".repeat(10) })
    clock.now += (LIMITS.ttlDefaultS + LIMITS.purgeAfterS) * 1000 + 1
    await hub.alarm(async () => true)
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "x".repeat(90) } })
  })

  test("a hook's transient hello is refused, and no connection gets the hooks' inject calls: hooks report to a local broker", async () => {
    const { connect, rpc, ok, fails, bridge } = setup()
    const refused = await rpc(connect(), "hello", { protocol: PROTOCOL, machine: "ci", transient: true, claim: { handle: "impl", harness: "claude-code" } })
    expect([refused.error?.data?.code, refused.error?.message]).toEqual([
      "invalid_params",
      "the hub takes no hook connections: hooks report to the local broker, which bridges them",
    ])
    const cli = connect()
    await ok(cli, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    const laptop = await bridge("laptop", [{ address: "me/app-main" }])
    for (const socket of [cli, laptop]) {
      for (const method of ["inject", "injected"]) expect(await fails(socket, method, { seqs: [1], hold: "hld_x", id: "msg_x" })).toBe("method_not_found")
    }
    expect(await ok(cli, "message", { id: "msg_x" })).toEqual({ message: null })
    expect(await fails(laptop, "message", { id: "msg_x" })).toBe("method_not_found")
  })

  test("a human hello needs a full login", async () => {
    const { connect, rpc, ok } = setup()
    const refused = await rpc(connect("tok_s", null, { scoped: true }), "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    expect([refused.error?.data?.code, refused.error?.message]).toEqual(["unauthorized", "a scoped token acts as an agent: use --as"])
    expect(await ok(connect("tok_s", null, { scoped: true }), "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })).toMatchObject({
      endpoint: { address: "ada/ci/impl" },
    })
    expect(await ok(connect("tok_old", null, { scoped: undefined }), "hello", observe)).toMatchObject({ account: "ada" })
    expect(
      (await rpc(connect("tok_old", null, { scoped: undefined }), "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })).error?.data?.code,
    ).toBe("unauthorized")
  })
})

describe("revoked tokens", () => {
  test("a revoked token is refused at hello and on later calls for a while, even with a grant the Worker accepted before the revoke", async () => {
    const { hub, clock, connect, ok, rpc } = setup()
    const member = connect("tok_m", "usr_m", { role: "member", expiresAt: FAR })
    await ok(member, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    hub.revoke({ tokenId: "tok_r" })
    hub.revoke({ userId: "usr_1", actorId: "usr_m" })
    for (const [tokenId, actorId] of [
      ["tok_r", null],
      ["tok_m", "usr_m"],
    ] as const) {
      const late = connect(tokenId, actorId, { expiresAt: FAR })
      await rpc(late, "hello", { protocol: PROTOCOL, machine: "laptop", claim: { handle: "impl" } })
      expect([late.pushes("revoked"), late.closedWith?.code]).toEqual([[{ reason: "the token was revoked" }], 1008])
      const [hello] = (await hub.batch({ ...grant(tokenId, FAR), actorId }, [{ jsonrpc: "2.0", id: 1, method: "hello", params: observe }])) as Frame[]
      expect(hello!.error?.data?.code).toBe("unauthorized")
    }
    await ok(connect("tok_m2", "usr_m", { expiresAt: FAR }), "hello", observe)
    clock.now += HUB_LIMITS.deniedS * 1000
    await hub.alarm(async () => true)
    await ok(connect("tok_r", null, { expiresAt: FAR }), "hello", observe)
  })
})

describe("machine slots", () => {
  test("human and observer hellos bind no machine; an observer lists and releases machines and does nothing else", async () => {
    const { connect, ok, rpc, fails } = setup()
    await ok(connect(), "hello", { protocol: PROTOCOL, machine: "ci", human: true, tty: true })
    const observer = connect("tok_s", null, { scoped: true })
    const hello = await ok(observer, "hello", observe)
    expect(Object.keys(hello).sort()).toEqual(["account", "capabilities", "limits", "server_time"])
    expect(await ok(connect(), "hello", { protocol: PROTOCOL, observe: true, machine: "laptop" })).toMatchObject({ account: "ada", machine: "laptop" })
    expect(await ok(observer, "machines")).toEqual({ machines: [] })
    expect((await ok(observer, "list")).endpoints.map((e: any) => e.address)).toEqual(["ada/"])
    await ok(observer, "snapshot")
    await ok(observer, "log")
    for (const method of ["whoami", "send", "inbox", "status", "event", "ack"]) expect(await fails(observer, method, {})).toBe("unauthorized")
    expect(await fails(observer, "mirror", {})).toBe("method_not_found")
    expect((await rpc(connect(), "hello", { protocol: PROTOCOL, observe: true, claim: { handle: "x" } })).error?.data?.code).toBe("invalid_params")
    expect(await fails(connect(), "hello", { protocol: PROTOCOL, observe: true, machine: "Not Valid" })).toBe("invalid_params")
  })

  test("the sweep releases a client binding idle for 14 days with nothing queued; a queued one and bridge bindings stay", async () => {
    const { hub, clock, bridge, connect, ok, disconnect } = setup()
    const far = { expiresAt: FAR }
    const desk = await bridge("desk", [{ address: "me/review" }], "tok_a", null, far)
    disconnect(await bridge("laptop", [{ address: "me/impl" }], "tok_a", null, far))
    for (const machine of ["ci", "queued"]) {
      const client = connect("tok_c", null, far)
      await ok(client, "hello", { protocol: PROTOCOL, machine, claim: { handle: "impl" } })
      disconnect(client)
    }
    const live = connect("tok_c", null, far)
    await ok(live, "hello", { protocol: PROTOCOL, machine: "busy", claim: { handle: "impl" } })
    await ok(desk, "forward", { from: "review", params: { to: "queued/impl", body: "still waiting", ttl_s: LIMITS.ttlMaxS } })
    clock.now += HUB_LIMITS.clientMachineIdleS * 1000
    await hub.alarm(async () => true)
    expect((await ok(live, "machines")).machines.map((m: any) => m.name)).toEqual(["busy", "desk", "laptop", "queued"])
    expect(desk.pushes("endpoints").at(-1)).toEqual({ machine: "ci", endpoints: [], full: true, released: true })
    expect((await ok(live, "log", { limit: 1000 })).rows.filter((r: any) => r.event === "machine_expire").map((r: any) => r.detail.machine)).toEqual(["ci"])
  })
  test("the sweep keeps a client binding whose endpoint waits on an unexpired ask", async () => {
    const { hub, clock, bridge, connect, ok, disconnect } = setup()
    const desk = await bridge("desk", [{ address: "me/review" }], "tok_a", null, { expiresAt: FAR })
    const client = connect("tok_c", null, { expiresAt: FAR })
    await ok(client, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    const asked = await ok(client, "ask", { to: "desk/review", body: "still open?", ttl_s: LIMITS.ttlMaxS })
    await ok(desk, "ack", { seqs: [asked.deliveries[0].seq] })
    disconnect(client)
    clock.now += HUB_LIMITS.clientMachineIdleS * 1000
    await hub.alarm(async () => true)
    expect((await ok(desk, "list", { all: true })).endpoints.map((e: any) => e.address)).toContain("ada/ci/impl")
    clock.now += LIMITS.ttlMaxS * 1000
    await hub.alarm(async () => true)
    expect((await ok(desk, "list", { all: true })).endpoints.map((e: any) => e.address)).not.toContain("ada/ci/impl")
  })
})

describe("in-flight calls and forwards", () => {
  test("a revoke ends a pending /rpc inbox wait at once", async () => {
    const { hub } = setup()
    const started = Date.now()
    const waiting = hub.batch(grant("tok_c"), [
      { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } } },
      { jsonrpc: "2.0", id: 2, method: "inbox", params: { wait_s: 20 } },
    ])
    await Bun.sleep(5)
    expect(hub.revoke({ tokenId: "tok_c" })).toBe(1)
    const [, inbox] = (await waiting) as Frame[]
    expect(inbox!.result).toEqual({ messages: [], next: 0 })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("a forward drops attachment paths, which are local to the sending machine", async () => {
    const { bridge, ok } = setup()
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review" }])
    await ok(laptop, "forward", {
      from: "impl",
      params: { to: "desk/review", body: "see the file", attachments: [{ kind: "path", path: "/home/ada/notes.md" }] },
    })
    expect(desk.pushes("deliver").map((p) => p.message.attachments)).toEqual([[]])
  })
})

describe("the default reach and historic agents on the hub", () => {
  test("a bridge's agent reaches its own tree and every root of the account, another tree's child only through a list", async () => {
    const { bridge, ok, fails } = setup()
    const laptop = await bridge("laptop", [{ address: "me/lead" }, { address: "me/kid", tree: "lead", parent_ep: "lead", depth: 1 }])
    const desk = await bridge("desk", [{ address: "me/review" }, { address: "me/helper", tree: "review", parent_ep: "review", depth: 1 }], "tok_b")
    expect((await ok(laptop, "forward", { from: "kid", params: { to: "desk/review", body: "to a root" } })).deliveries).toHaveLength(1)
    expect(desk.pushes("deliver").map((p) => p.endpoint)).toEqual(["desk/review"])
    expect(await fails(laptop, "forward", { from: "kid", params: { to: "desk/helper", body: "x" } })).toBe("not_found")
    expect(await fails(laptop, "forward", { from: "lead", params: { to: "desk/helper", body: "x" } })).toBe("not_found")
    const kid = { address: "me/kid", kind: "agent", presence: "online", tree: "lead", parent_ep: "lead", depth: 1 }
    await ok(laptop, "mirror", { endpoints: [{ ...kid, rules: { out: ["*"] } }] })
    expect(await fails(laptop, "forward", { from: "kid", params: { to: "desk/helper", body: "its own rules" } })).toBe("not_found")
    const caps = { caps: [{ id: "cap_h", dir: "out", by: "human", sels: [{ sel: "*" }] }], allow: {} }
    await ok(laptop, "mirror", { endpoints: [{ ...kid, rules: null, caps, incarnation: "i2" }] })
    expect((await ok(laptop, "forward", { from: "kid", params: { to: "desk/helper", body: "the human's cap" } })).deliveries).toHaveLength(1)
  })

  test("a mirrored agent idle past historicAfterS leaves list, overview and graph unless asked for; a routed message or a local event brings it back", async () => {
    const { hub, clock, bridge, ok } = setup()
    const idle = new Date(START - 2 * 3_600_000).toISOString()
    const laptop = await bridge("laptop", [{ address: "me/fresh" }, { address: "me/old", presence: "offline", last_seen: idle, active_at: idle }])
    const desk = await bridge("desk", [{ address: "me/review" }], "tok_b")
    const addresses = (rows: { address: string }[]) => rows.map((row) => row.address)
    expect(addresses((await ok(laptop, "list")).endpoints)).not.toContain("ada/laptop/old")
    expect((await ok(laptop, "list", { historic: true })).endpoints.find((e: any) => e.address === "ada/laptop/old")).toMatchObject({
      historic: true,
      active_at: idle,
    })
    expect(addresses(hub.overview().endpoints)).not.toContain("ada/laptop/old")
    expect(addresses(hub.overview(20, { historic: true }).endpoints)).toContain("ada/laptop/old")
    expect(addresses(hub.graph().nodes)).not.toContain("ada/laptop/old")
    expect(hub.graph(15, { historic: true }).nodes.find((n) => n.address === "ada/laptop/old")).toMatchObject({ historic: true })
    await ok(laptop, "forward", { from: "fresh", params: { to: "desk/review", body: "x" } })
    expect(hub.graph().nodes.find((n) => n.address === "ada/laptop/old")).toBeUndefined()
    clock.now += 1000
    expect((await ok(laptop, "local_events", { events: [{ kind: "message", at: clock.now, from: "fresh", to: ["old"] }] })).recorded).toBe(1)
    expect(hub.graph().nodes.find((n) => n.address === "ada/laptop/old")?.historic).toBeUndefined()
    clock.now += HUB_LIMITS.historicAfterS * 1000
    expect(hub.graph(15, { historic: true }).nodes.find((n) => n.address === "ada/laptop/old")).toMatchObject({ historic: true })
    await ok(desk, "forward", { from: "review", params: { to: "laptop/old", body: "wake up" } })
    expect(hub.graph().nodes.find((n) => n.address === "ada/laptop/old")?.historic).toBeUndefined()
  })

  test("historicAfterS Infinity makes no agent historic", async () => {
    const { hub, bridge } = setup({ limits: { historicAfterS: Number.POSITIVE_INFINITY } })
    await bridge("laptop", [
      { address: "me/old", presence: "offline", last_seen: new Date(START - 86_400_000).toISOString(), active_at: new Date(START - 86_400_000).toISOString() },
    ])
    expect(hub.graph().nodes.find((n) => n.address === "ada/laptop/old")?.historic).toBeUndefined()
  })
})

describe("graph", () => {
  test("listed endpoints, spawn edges and message counts per sender and recipient in the window, never a body", async () => {
    const { hub, clock, bridge, ok } = setup()
    const laptop = await bridge("laptop", [
      { address: "me/lead", parent_ep: null, depth: 0, wake: "channels" },
      { address: "me/kid", tree: "lead", parent_ep: "lead", depth: 1 },
      { address: "me/", kind: "human" },
    ])
    await bridge("desk", [{ address: "me/review" }], "tok_b", "usr_v")
    await ok(laptop, "forward", { from: "lead", params: { to: "desk/review", body: "secret plan one" } })
    clock.now += 1000
    await ok(laptop, "forward", { from: "lead", params: { to: "desk/review", body: "secret plan two" } })
    await ok(laptop, "forward", { from: "kid", params: { to: "laptop/lead", body: "done" } })

    const graph = hub.graph()
    expect(graph.minutes).toBe(GRAPH_MINUTES)
    expect(graph.machines.map((m) => [m.name, m.actor])).toEqual([
      ["desk", "usr_v"],
      ["laptop", null],
    ])
    expect(graph.nodes.find((n) => n.address === "ada/laptop/")?.kind).toBe("human")
    expect(graph.nodes.find((n) => n.address === "ada/laptop/kid")).toMatchObject({ kind: "agent", parent: "ada/laptop/lead", presence: "online" })
    expect(graph.nodes.find((n) => n.address === "ada/laptop/lead")?.wake).toBe("channels")
    expect(graph.nodes.find((n) => n.address === "ada/laptop/kid")?.wake).toBeNull()
    expect(graph.edges).toEqual([
      { kind: "spawn", from: "ada/laptop/lead", to: "ada/laptop/kid" },
      { kind: "message", from: "ada/laptop/kid", to: "ada/laptop/lead", count: 1, last_at: new Date(START + 1000).toISOString() },
      { kind: "message", from: "ada/laptop/lead", to: "ada/desk/review", count: 2, last_at: new Date(START + 1000).toISOString() },
    ])
    const wire = JSON.stringify(graph)
    expect(wire).not.toContain("secret plan")
    expect(wire).not.toContain("done")
    expect(wire).not.toContain("body")

    clock.now += (GRAPH_MINUTES + 1) * 60_000
    expect(hub.graph().edges.map((e) => e.kind)).toEqual(["spawn"])
    expect(hub.graph(GRAPH_MINUTES_MAX).edges.filter((e) => e.kind === "message")).toHaveLength(2)
    expect(hub.graph(10_000).minutes).toBe(GRAPH_MINUTES_MAX)
  })

  test("a child linked under another machine's agent has a spawn edge from it", async () => {
    const { hub, bridge } = setup()
    await bridge("laptop", [{ address: "me/lead", parent_ep: null, depth: 0 }])
    await bridge("desk", [{ address: "me/app", parent_ep: null, depth: 0, parent_addr: "laptop/lead" }], "tok_b", "usr_v")
    const graph = hub.graph()
    expect(graph.nodes.find((n) => n.address === "ada/desk/app")?.parent).toBe("ada/laptop/lead")
    expect(graph.edges).toEqual([{ kind: "spawn", from: "ada/laptop/lead", to: "ada/desk/app" }])
  })
})

describe("local events", () => {
  test("a bridge's same-machine deliveries count in the graph and stream as local messages; stray fields, kinds and endpoints are dropped", async () => {
    const events: DashboardEvent[] = []
    const { hub, ok, bridge, clock } = setup({ dashboard: (e) => events.push(e) })
    const laptop = await bridge("laptop", [{ address: "me/lead" }, { address: "me/kid" }])
    await bridge("desk", [{ address: "me/review" }])
    const id = "a".repeat(32)
    const result = await ok(laptop, "local_events", {
      events: [
        { from: "lead", to: ["kid"], kind: "request", at: START - 1000, id, thread: id, body: "secret plan", note: "secret note" },
        { from: "kid", to: ["lead", "nobody"], kind: "handback", at: clock.now + 60_000, id: "not a hash" },
        { from: "lead", to: ["desk/review"], kind: "message", at: clock.now },
        { from: "lead", to: ["kid"], kind: "gossip", at: clock.now },
        { from: "nobody", to: ["kid"], kind: "message", at: clock.now },
      ],
    })
    expect(result).toEqual({ recorded: 2 })
    const at = new Date(START).toISOString()
    expect(events.filter((e) => e.type === "message")).toEqual([
      { type: "message", at, kind: "request", from: "ada/laptop/lead", to: ["ada/laptop/kid"], local: true },
      { type: "message", at, kind: "handback", from: "ada/laptop/kid", to: ["ada/laptop/lead"], local: true },
    ])
    expect(hub.graph().edges.filter((e) => e.kind === "message")).toEqual([
      { kind: "message", from: "ada/laptop/kid", to: "ada/laptop/lead", count: 1, last_at: at },
      { kind: "message", from: "ada/laptop/lead", to: "ada/laptop/kid", count: 1, last_at: new Date(START - 1000).toISOString() },
    ])
    expect(JSON.stringify(events)).not.toContain("secret")
    clock.now += GRAPH_MINUTES_MAX * 60_000 + 1000
    expect(hub.graph(GRAPH_MINUTES_MAX).edges.filter((e) => e.kind === "message")).toEqual([])
  })
})

describe("dashboard events", () => {
  test("presence, endpoint changes and messages reach the dashboard as addresses and kinds only, never a body, note or label", async () => {
    const events: DashboardEvent[] = []
    const { ok, bridge, clock } = setup({ dashboard: (e) => events.push(e) })
    const laptop = await bridge("laptop", [{ address: "me/lead", labels: { secret: "label-value" } }])
    await bridge("desk", [{ address: "me/review" }])
    clock.now += 1000
    await ok(laptop, "forward", { from: "lead", params: { to: "desk/review", body: "secret plan" } })
    await ok(laptop, "mirror", {
      endpoints: [{ address: "me/lead", kind: "agent", harness: "claude-code", presence: "online", status: { state: "working", note: "secret note" } }],
    })
    await ok(laptop, "mirror", { full: true, endpoints: [] })

    const at = new Date(START + 1000).toISOString()
    expect(events.find((e) => e.type === "message")).toEqual({ type: "message", at, kind: "message", from: "ada/laptop/lead", to: ["ada/desk/review"] })
    expect(events.filter((e) => e.type === "endpoints").map((e) => e.machine)).toEqual(["laptop", "desk", "laptop"])
    expect(events.filter((e) => e.type === "presence").at(-1)).toEqual({
      type: "presence",
      at,
      machine: "laptop",
      endpoint: "ada/laptop/lead",
      presence: "offline",
    })
    const keys = {
      message: ["at", "from", "kind", "to", "type"],
      presence: ["at", "endpoint", "machine", "presence", "type"],
      endpoints: ["at", "machine", "type"],
    }
    for (const e of events) expect(Object.keys(e).sort()).toEqual(keys[e.type])
    const wire = JSON.stringify(events)
    for (const leak of ["secret plan", "secret note", "label-value", "body", "status"]) expect(wire).not.toContain(leak)
  })
})

describe("machine waker", () => {
  const SECRET = "wake-secret-0123456789abcdef"
  type Call = { url: string; headers: Record<string, string>; body: string }

  async function calls(list: Call[], n: number): Promise<void> {
    for (let i = 0; i < 100 && list.length < n; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  test("a bridge sets its machine's waker; the secret and url are never shown, only whether one is set", async () => {
    const { bridge, connect, ok, fails } = setup()
    const desk = await bridge("desk", [])
    const cli = connect("tok_b")
    await ok(cli, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    expect(await fails(desk, "machine_wake", { url: "https://wake.example/hook" })).toBe("invalid_params")
    expect(await fails(desk, "machine_wake", { url: "http://wake.example/hook", secret: SECRET })).toBe("invalid_params")
    expect(await fails(desk, "machine_wake", { url: "https://wake.example/hook", secret: "short" })).toBe("invalid_params")
    expect(await ok(desk, "machine_wake", { url: "http://127.0.0.1:8080/wake", secret: SECRET })).toEqual({ set: true })
    expect(await ok(desk, "machine_wake", { url: "https://wake.example/hook?k=q", secret: SECRET })).toEqual({ set: true })
    const listed = await ok(cli, "machines")
    expect(listed.machines.find((m: any) => m.name === "desk").wake).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(SECRET)
    expect(JSON.stringify(listed)).not.toContain("wake.example")
    expect(await ok(desk, "machine_wake", { url: null })).toEqual({ set: false })
    expect((await ok(cli, "machines")).machines.find((m: any) => m.name === "desk").wake).toBe(false)
  })

  test("a delivery to a hibernated endpoint of a machine with no bridge calls its waker, signed, metadata only, debounced", async () => {
    const sent: Call[] = []
    let status = 200
    const { bridge, ok, clock, disconnect, logs } = setup({
      fetch: async (url, init) => {
        sent.push({ url, headers: init.headers, body: init.body })
        return { status }
      },
    })
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm-sleep" }])
    await ok(desk, "machine_wake", { url: "https://wake.example/hook?k=q", secret: SECRET })
    const before = await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "while the bridge is up" } })
    expect(before.deliveries[0]).toMatchObject({ queued: true, hibernated: true })
    await calls(sent, 1)
    expect(sent).toEqual([])
    disconnect(desk)
    const listed = (await ok(laptop, "list", {})).endpoints
    expect(listed.find((e: any) => e.address === "ada/desk/review")).toMatchObject({ presence: "hibernated", wake: "hook:vm-sleep" })
    const first = await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "UNIQUE-HUB-BODY-1", kind: "request" } })
    await calls(sent, 1)
    expect(sent.length).toBe(1)
    const call = sent[0]!
    expect(call.url).toBe("https://wake.example/hook?k=q")
    expect(call.headers["content-type"]).toBe("application/json")
    const expected = new Bun.CryptoHasher("sha256", SECRET).update(`${call.headers["x-scp-timestamp"]}.${call.body}`).digest("hex")
    expect(call.headers["x-scp-signature"]).toBe(`sha256=${expected}`)
    expect(call.headers["x-scp-timestamp"]).toBe(String(clock.now))
    expect(JSON.parse(call.body)).toEqual({
      scp: 1,
      event: "machine_wake",
      account: "ada",
      machine: "desk",
      endpoints: ["ada/desk/review"],
      message: { id: first.id, from: expect.any(String), kind: "request", thread: first.thread, created_at: expect.any(String) },
      from_account: "ada",
      same_account: true,
    })
    expect(call.body).not.toContain("UNIQUE-HUB-BODY")
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "again" } })
    await calls(sent, 2)
    expect(sent.length).toBe(1)
    status = 500
    clock.now += LIMITS.wakeDebounceS * 1000
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "later" } })
    await calls(sent, 2)
    expect(sent.length).toBe(2)
    clock.now += LIMITS.wakeDebounceS * 1000
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "inside the backoff" } })
    await calls(sent, 3)
    expect(sent.length).toBe(2)
    const lines = JSON.stringify(logs)
    expect(lines).toContain("machine_wake")
    expect(lines).not.toContain(SECRET)
    expect(lines).not.toContain("k=q")
  })

  test("an embedder's machineWake is called for any machine without a URL; a decline holds calls for that message and sender only", async () => {
    const events: any[] = []
    let answer: { ok: boolean; declined?: string } = { ok: false, declined: "budget" }
    const { bridge, ok, disconnect } = setup({
      machineWake: async (event) => {
        events.push(event)
        return answer
      },
    })
    const laptop = await bridge("laptop", [{ address: "me/impl" }, { address: "me/lead" }])
    const desk = await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }])
    disconnect(desk)
    const first = await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "UNIQUE-EMBED-1" } })
    await calls(events as Call[], 1)
    expect(events).toEqual([
      expect.objectContaining({ event: "machine_wake", machine: "desk", same_account: true, message: expect.objectContaining({ id: first.id }) }),
    ])
    expect(JSON.stringify(events)).not.toContain("UNIQUE-EMBED")
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "same sender" } })
    await calls(events as Call[], 2)
    expect(events.length).toBe(1)
    answer = { ok: true }
    await ok(laptop, "forward", { from: "lead", params: { to: "desk/review", body: "another sender" } })
    await calls(events as Call[], 2)
    expect(events.length).toBe(2)
  })

  test("a webhook's 403 with a declined reason is a decline, not a failure", async () => {
    const sent: Call[] = []
    const { bridge, ok, disconnect, clock, logs } = setup({
      fetch: async (url, init) => {
        sent.push({ url, headers: init.headers, body: init.body })
        return { status: 403, text: async () => JSON.stringify({ declined: "policy" }) }
      },
    })
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }])
    await ok(desk, "machine_wake", { url: "https://wake.example/hook", secret: SECRET })
    disconnect(desk)
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "one" } })
    await calls(sent, 1)
    expect(logs.some((l) => l.fields.method === "machine_wake" && l.fields.declined === "policy" && l.fields.code === "declined")).toBe(true)
    clock.now += LIMITS.wakeBackoffMaxS * 1000
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "two" } })
    await calls(sent, 2)
    expect(sent.length).toBe(1)
  })

  test("an accepted wake shows the row waking until its claim mirrors in; without one it falls back after wakingTimeoutS", async () => {
    const events: Call[] = []
    const dash: DashboardEvent[] = []
    const { bridge, ok, disconnect, clock, hub } = setup({
      machineWake: async (event) => {
        events.push(event as unknown as Call)
        return { ok: true }
      },
      dashboard: (event) => dash.push(event),
      wake: { wakingTimeoutS: 300 },
    })
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    disconnect(await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }]))
    const shown = async () => (await ok(laptop, "list", {})).endpoints.find((e: any) => e.address === "ada/desk/review")
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "one" } })
    await calls(events, 1)
    expect(await shown()).toMatchObject({ presence: "hibernated", wake: "hook:vm", waking: true })
    expect(hub.graph().nodes.find((n) => n.address === "ada/desk/review")).toMatchObject({ presence: "hibernated", waking: true })
    expect(dash).toContainEqual(expect.objectContaining({ type: "presence", endpoint: "ada/desk/review", presence: "hibernated", waking: true }))
    clock.now += 120_000
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "while waking" } })
    await calls(events, 2)
    expect(events.length).toBe(1)
    clock.now += 180_000
    expect((await shown()).waking).toBeUndefined()
    await hub.alarm(async () => true)
    expect(dash).toContainEqual(expect.objectContaining({ type: "presence", endpoint: "ada/desk/review", presence: "hibernated", waking: false }))
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "after the timeout" } })
    await calls(events, 2)
    expect(events.length).toBe(2)
    expect(await shown()).toMatchObject({ waking: true })
    await bridge("desk", [{ address: "me/review" }])
    const live = await shown()
    expect(live.presence).toBe("online")
    expect(live.waking).toBeUndefined()
  })

  test("a wake accepted after the claim already mirrored in never shows the live row waking", async () => {
    let accept: (answer: { ok: boolean }) => void = () => {}
    const { bridge, ok, disconnect } = setup({ machineWake: () => new Promise((resolve) => (accept = resolve)) })
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    disconnect(await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }]))
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "one" } })
    await bridge("desk", [{ address: "me/review" }])
    accept({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const row = (await ok(laptop, "list", {})).endpoints.find((e: any) => e.address === "ada/desk/review")
    expect(row.presence).toBe("online")
    expect(row.waking).toBeUndefined()
  })

  test("the debounce and backoff are the embedder's; a new hibernation clears them, so the next message wakes at once", async () => {
    const events: Call[] = []
    const { bridge, ok, disconnect, clock } = setup({
      machineWake: async (event) => {
        events.push(event as unknown as Call)
        return { ok: false }
      },
      wake: { debounceS: 5, backoffMaxS: 20 },
    })
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    disconnect(await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }]))
    const send = async (body: string, after: number) => {
      clock.now += after * 1000
      await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body } })
      await calls(events, events.length + 1)
      return events.length
    }
    expect(await send("one", 0)).toBe(1)
    expect(await send("inside 10 s", 5)).toBe(1)
    expect(await send("after 10 s", 5)).toBe(2)
    expect(await send("inside 20 s", 10)).toBe(2)
    const back = await bridge("desk", [{ address: "me/review" }])
    await ok(back, "mirror", {
      full: false,
      endpoints: [{ address: "me/review", kind: "agent", harness: "claude-code", presence: "hibernated", wake: "hook:vm" }],
    })
    disconnect(back)
    expect(await send("after a new hibernation", 0)).toBe(3)
  })

  test("a decline hold lives in storage: a restarted hub keeps it until its expiry or clearWakeHold", async () => {
    const events: Call[] = []
    const machineWake = async (event: unknown) => {
      events.push(event as Call)
      return { ok: false, declined: "budget" }
    }
    const { bridge, ok, disconnect, clock, restart } = setup({ machineWake, wake: { declineHoldS: 600 } })
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    disconnect(await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }]))
    const send = async (body: string) => {
      await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body } })
      await calls(events, events.length + 1)
      return events.length
    }
    expect(await send("one")).toBe(1)
    const fresh = restart()
    expect(await send("after a restart")).toBe(1)
    clock.now += 599_000
    expect(await send("inside the hold")).toBe(1)
    clock.now += 1000
    expect(await send("after the hold")).toBe(2)
    restart()
    expect(await send("held again")).toBe(2)
    expect(fresh.clearWakeHold("desk")).toBe(1)
    expect(await send("after clearWakeHold")).toBe(3)
  })

  test("waking survives a restart; clearWakeHold ends it and the debounce, so the next message calls at once", async () => {
    const events: Call[] = []
    const dash: DashboardEvent[] = []
    const machineWake = async (event: unknown) => {
      events.push(event as Call)
      return { ok: true }
    }
    const { bridge, ok, disconnect, restart } = setup({ machineWake, dashboard: (event) => dash.push(event), wake: { wakingTimeoutS: 600 } })
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    disconnect(await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }]))
    const send = async (body: string) => {
      await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body } })
      await calls(events, events.length + 1)
      return events.length
    }
    expect(await send("one")).toBe(1)
    const fresh = restart()
    expect((await ok(laptop, "list", {})).endpoints.find((e: any) => e.address === "ada/desk/review").waking).toBe(true)
    expect(await send("while waking")).toBe(1)
    expect(fresh.clearWakeHold()).toBe(1)
    expect(dash).toContainEqual(expect.objectContaining({ type: "presence", endpoint: "ada/desk/review", waking: false }))
    expect(await send("after clearWakeHold")).toBe(2)
  })

  test("a new registration while a call runs drops that call's outcome: no waking, no debounce", async () => {
    const sent: Call[] = []
    let answer: (status: number) => void = () => {}
    const { bridge, ok, disconnect } = setup({
      fetch: (url, init) => {
        sent.push({ url, headers: init.headers, body: init.body })
        return new Promise((resolve) => {
          answer = (status) => resolve({ status })
        })
      },
    })
    const laptop = await bridge("laptop", [{ address: "me/impl" }])
    const desk = await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }])
    await ok(desk, "machine_wake", { url: "https://wake.example/hook", secret: SECRET })
    disconnect(desk)
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "one" } })
    await calls(sent, 1)
    const again = await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }])
    await ok(again, "machine_wake", { url: "https://wake.example/other", secret: SECRET })
    disconnect(again)
    answer(200)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await ok(laptop, "list", {})).endpoints.find((e: any) => e.address === "ada/desk/review").waking).toBeUndefined()
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "two" } })
    await calls(sent, 2)
    expect(sent.map((c) => c.url)).toEqual(["https://wake.example/hook", "https://wake.example/other"])
  })

  test("a call answered after its hold was cleared and a new call started in the same millisecond changes nothing", async () => {
    const answers: ((answer: { ok: boolean; declined?: string }) => void)[] = []
    const { bridge, ok, disconnect, hub } = setup({ machineWake: () => new Promise((resolve) => answers.push(resolve)) })
    const laptop = await bridge("laptop", [{ address: "me/impl" }, { address: "me/lead" }])
    disconnect(await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }]))
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "one" } })
    hub.clearWakeHold("desk")
    expect(answers.length).toBe(2)
    await ok(laptop, "forward", { from: "lead", params: { to: "desk/review", body: "two" } })
    expect(answers.length).toBe(2)
    answers[0]!({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await ok(laptop, "list", {})).endpoints.find((e: any) => e.address === "ada/desk/review").waking).toBeUndefined()
    answers[1]!({ ok: false, declined: "budget" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "three" } })
    expect(answers.length).toBe(2)
  })

  test("a call for another sender keeps the earlier sender's decline, whatever its outcome", async () => {
    const answers: { ok: boolean; declined?: string }[] = [{ ok: false, declined: "budget" }, { ok: false }]
    const events: Call[] = []
    const { bridge, ok, disconnect, clock } = setup({
      machineWake: async (event) => {
        events.push(event as unknown as Call)
        return answers.shift() ?? { ok: false }
      },
    })
    const laptop = await bridge("laptop", [{ address: "me/impl" }, { address: "me/lead" }])
    disconnect(await bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }]))
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "one" } })
    await calls(events, 1)
    await ok(laptop, "forward", { from: "lead", params: { to: "desk/review", body: "two" } })
    await calls(events, 2)
    expect(events.length).toBe(2)
    clock.now += LIMITS.wakeBackoffMaxS * 1000
    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "declined sender again" } })
    await calls(events, 3)
    expect(events.length).toBe(2)
  })

  describe("mail queued while a hold was on", () => {
    function held(wake: Partial<HubWakeOptions> = {}, declines = 1) {
      const events: Call[] = []
      const answers: { ok: boolean; declined?: string }[] = Array.from({ length: declines }, () => ({ ok: false, declined: "budget" }))
      const env = setup({
        machineWake: async (event) => {
          events.push(event as unknown as Call)
          return answers.shift() ?? { ok: true }
        },
        wake: { declineHoldS: 600, ...wake },
      })
      return { ...env, events }
    }

    async function declined(env: ReturnType<typeof held>) {
      const laptop = await env.bridge("laptop", [{ address: "me/impl" }, { address: "me/lead" }])
      env.disconnect(await env.bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }]))
      const first = await env.ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "one" } })
      await calls(env.events, 1)
      expect(env.events.length).toBe(1)
      return { laptop, first }
    }

    test("the hold's expiry wakes the machine for the oldest queued message at the alarm", async () => {
      const env = held()
      const { first } = await declined(env)
      expect(env.hub.nextAlarm()).toBeLessThanOrEqual(env.clock.now + 600_000)
      env.clock.now += 599_000
      await env.hub.alarm(async () => true)
      await calls(env.events, 2)
      expect(env.events.length).toBe(1)
      env.clock.now += 1000
      await env.hub.alarm(async () => true)
      await calls(env.events, 2)
      expect(env.events.map((e: any) => e.message.id)).toEqual([first.id, first.id])
      await env.hub.alarm(async () => true)
      await calls(env.events, 3)
      expect(env.events.length).toBe(2)
    })

    test("a hold shorter than the debounce retries queued mail at most once a debounce window", async () => {
      const env = held({ declineHoldS: 0 }, 3)
      await declined(env)
      await env.hub.alarm(async () => true)
      await calls(env.events, 2)
      expect(env.events.length).toBe(1)
      expect(env.hub.nextAlarm()).toBeLessThanOrEqual(env.clock.now + LIMITS.wakeDebounceS * 1000)
      env.clock.now += LIMITS.wakeDebounceS * 1000
      await env.hub.alarm(async () => true)
      await calls(env.events, 2)
      expect(env.events.length).toBe(2)
      await env.hub.alarm(async () => true)
      await calls(env.events, 3)
      expect(env.events.length).toBe(2)
      env.clock.now += LIMITS.wakeDebounceS * 1000
      await env.hub.alarm(async () => true)
      await calls(env.events, 3)
      expect(env.events.length).toBe(3)
    })

    test("clearWakeHold wakes the machine for queued mail at once", async () => {
      const env = held()
      const { first } = await declined(env)
      expect(env.hub.clearWakeHold("desk")).toBe(1)
      await calls(env.events, 2)
      expect(env.events.map((e: any) => e.message.id)).toEqual([first.id, first.id])
    })

    test("with nothing queued, an ended hold calls nothing", async () => {
      const env = held()
      await declined(env)
      const desk = await env.bridge("desk", [{ address: "me/review", presence: "hibernated", wake: "hook:vm" }])
      const seqs = desk.frames.filter((f: any) => f.method === "deliver").map((f: any) => f.params.seq)
      expect(seqs.length).toBe(1)
      await env.ok(desk, "ack", { seqs })
      env.disconnect(desk)
      expect(env.hub.clearWakeHold("desk")).toBe(1)
      await calls(env.events, 2)
      expect(env.events.length).toBe(1)
    })

    test("queued mail and a new message at the same moment wake the machine once", async () => {
      const env = held()
      const { laptop } = await declined(env)
      env.hub.clearWakeHold("desk")
      await env.ok(laptop, "forward", { from: "lead", params: { to: "desk/review", body: "racing" } })
      await calls(env.events, 3)
      expect(env.events.length).toBe(2)

      const later = held()
      const again = await declined(later)
      later.clock.now += 600_000
      await later.ok(again.laptop, "forward", { from: "lead", params: { to: "desk/review", body: "at the expiry" } })
      await later.hub.alarm(async () => true)
      await calls(later.events, 3)
      expect(later.events.length).toBe(2)
    })
  })

  test("wake durations must be finite; a per-hour cap or the decline hold may be Infinity", () => {
    expect(() => setup({ wake: { debounceS: Number.POSITIVE_INFINITY } })).toThrow(RangeError)
    expect(() => setup({ wake: { wakingTimeoutS: -1 } })).toThrow(RangeError)
    expect(() => setup({ wake: { senderAccountPerHour: Number.NaN } })).toThrow(RangeError)
    expect(() =>
      setup({ wake: { senderAccountPerHour: Number.POSITIVE_INFINITY, targetPerHour: Number.POSITIVE_INFINITY, declineHoldS: Number.POSITIVE_INFINITY } }),
    ).not.toThrow()
  })
})
