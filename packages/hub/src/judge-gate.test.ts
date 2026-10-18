// biome-ignore-all lint/suspicious/noExplicitAny: JSON-RPC results and frames are untyped wire data
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { FakeJudgeClient, type JudgePolicy, PROTOCOL, RelayError, type Sql, type SqlValue } from "@scp-dev/core"
import { type HubConn, RelayHub, type HubSocket } from "./hub"

const START = 1_800_000_000_000

class FakeSocket implements HubSocket {
  frames: any[] = []
  constructor(
    public conn: HubConn,
    private readonly live: Set<FakeSocket>,
  ) {}
  send(text: string): void {
    this.frames.push(JSON.parse(text))
  }
  close(): void {
    this.live.delete(this)
  }
  pushes(method: string): any[] {
    return this.frames.filter((f) => f.id === undefined && f.method === method).map((f) => f.params)
  }
}

const POLICY: JudgePolicy = {
  mode: "enforce",
  fail: "open",
  timeout_s: 5,
  model: { id: "openrouter/test/judge", effort: "medium", key_env: "JUDGE_API_KEY" },
  budget: { per_minute: Infinity, per_hour: Infinity },
  boundaries: [{ from: "*", to: "*" }],
}
const answer = (verdict: string) => JSON.stringify({ verdict, categories: verdict === "pass" ? [] : ["private"], reason: "test", redactions: [] })

function setup() {
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const live = new Set<FakeSocket>()
  const hub = new RelayHub({
    sql,
    hash: (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: (fn) => db.transaction(fn)(),
    now: () => START,
    sockets: () => [...live],
    save: () => {},
  })
  hub.init({ user: "ada" })
  let nextId = 1

  function connect(): FakeSocket {
    const socket = new FakeSocket(
      RelayHub.connection({ tokenId: "tok_a", userId: "usr_1", actorId: null, expiresAt: START + 3_600_000, scoped: false, role: null }),
      live,
    )
    live.add(socket)
    return socket
  }

  async function ok(socket: FakeSocket, method: string, params: unknown = {}): Promise<any> {
    const id = nextId++
    await hub.message(socket, JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    const frame = socket.frames.find((f) => f.id === id)
    if (frame.error) throw new Error(`${method}: ${frame.error.data?.code} ${frame.error.message}`)
    return frame.result
  }

  async function bridge(machine: string, handle: string): Promise<FakeSocket> {
    const socket = connect()
    await ok(socket, "hello", { protocol: PROTOCOL, machine, bridge: true })
    await ok(socket, "mirror", { full: true, endpoints: [{ address: `me/${handle}`, kind: "agent", harness: "test-harness", presence: "online" }] })
    await ok(socket, "subscribe", { after: 0 })
    return socket
  }

  const tables = () => db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'judge_%'`).all()
  return { hub, connect, ok, bridge, tables }
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

describe("hub judge", () => {
  test("without a policy, or with mode off, the hub holds no judge, makes no judge tables and delivers as before", async () => {
    for (const policy of [undefined, { ...POLICY, mode: "off" as const }]) {
      const { hub, bridge, ok, tables } = setup()
      const fake = new FakeJudgeClient([answer("hold")])
      hub.configureJudge(policy, { env: { JUDGE_API_KEY: "k" }, client: () => fake })
      const laptop = await bridge("laptop", "impl")
      const desk = await bridge("desk", "review")
      const sent = await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "please review" } })
      expect(sent.held).toBeUndefined()
      expect(desk.pushes("deliver").map((p) => p.message.id)).toEqual([sent.id])
      expect(fake.calls).toBe(0)
      expect(tables()).toEqual([])
      expect(code(() => hub.holds())).toBe("not_found")
    }
  })

  test("a pass delivers, a hold waits until released, and a refused hold is never delivered", async () => {
    const { hub, bridge, ok } = setup()
    const fake = new FakeJudgeClient([answer("pass"), answer("hold"), answer("hold")])
    hub.configureJudge(POLICY, { env: { JUDGE_API_KEY: "k" }, client: () => fake })
    const laptop = await bridge("laptop", "impl")
    const desk = await bridge("desk", "review")
    const deliveredTexts = () => desk.pushes("deliver").map((p) => p.message.body.text)

    await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "build is green" } })
    expect(deliveredTexts()).toEqual(["build is green"])

    const held = await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "internal numbers" } })
    expect(held.deliveries).toEqual([])
    expect(held.held.side).toBe("local")
    expect(deliveredTexts()).toEqual(["build is green"])
    expect(hub.holds().map((h) => [h.id, h.from, h.to, h.state, h.categories])).toEqual([
      [held.held.hold_id, "ada/laptop/impl", ["ada/desk/review"], "held", ["private"]],
    ])
    const released = await hub.holdRelease(held.held.hold_id, { by: "owner@example.com" })
    expect(released.deliveries.map((d) => d.address)).toEqual(["ada/desk/review"])
    expect(deliveredTexts()).toEqual(["build is green", "internal numbers"])
    expect(laptop.pushes("deliver").map((p) => [p.endpoint, p.message.kind, p.message.body.text.includes("released")])).toEqual([
      ["laptop/impl", "status", true],
    ])

    const refused = await ok(laptop, "forward", { from: "impl", params: { to: "desk/review", body: "more internal numbers" } })
    expect(hub.holdRefuse(refused.held.hold_id, "keep it internal", "owner@example.com").state).toBe("refused")
    expect(deliveredTexts()).toEqual(["build is green", "internal numbers"])
    expect(laptop.pushes("deliver").at(-1).message.body.text).toContain("keep it internal")
    expect(code(() => hub.holdRefuse(refused.held.hold_id, "again", "owner@example.com"))).toBe("not_found")
    expect(fake.calls).toBe(3)
  })

  test("a direct client's held ask returns at once, and its unqualified address resolves on its machine", async () => {
    const { hub, connect, ok, bridge } = setup()
    const fake = new FakeJudgeClient([answer("hold")])
    hub.configureJudge(POLICY, { env: { JUDGE_API_KEY: "k" }, client: () => fake })
    await bridge("desk", "review")
    const helper = connect()
    await ok(helper, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "helper" } })
    const impl = connect()
    await ok(impl, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    const asked = await ok(impl, "ask", { to: "helper", body: "the roadmap?", wait_s: 30 })
    expect(asked.held.hold_id).toStartWith("hold_")
    expect(asked.pending).toBeUndefined()
    expect(hub.holds()[0]!.to).toEqual(["ada/ci/helper"])
    await hub.holdRelease(asked.held.hold_id, { by: "owner@example.com" })
    expect((await ok(helper, "inbox")).messages.map((m: any) => [m.kind, m.body.text])).toEqual([["request", "the roadmap?"]])
  })
})
