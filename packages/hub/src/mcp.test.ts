// biome-ignore-all lint/suspicious/noExplicitAny: JSON-RPC wire results
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { FakeJudgeClient, type JudgePolicy, PROTOCOL, REMOTE_TOOLS, type Sql, type SqlValue } from "@scp-dev/core"
import { HUB_LIMITS, type HubGrant, type HubSocket, RelayHub } from "./hub"

const grant = (tokenId = "install"): HubGrant => ({ tokenId, userId: "owner", actorId: null, expiresAt: Date.now() + 3600_000, scoped: true, role: null })
function setup() {
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const live: HubSocket[] = []
  const logs: unknown[] = []
  const deps = {
    sql,
    hash: (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex"),
    sockets: () => live,
    save: () => {},
    log: (event: string, fields: unknown) => logs.push({ event, fields }),
  }
  const hub = new RelayHub(deps)
  hub.init({ user: "account" })
  const request = (method: string, params: object = {}, session: string | null = null, credential = grant()) =>
    hub.mcp(credential, { method: "POST", client: "mcp-remote", session, body: { jsonrpc: "2.0", id: 1, method, params } })
  const call = async (name: string, args: object = {}, session: string | null = null, credential = grant()): Promise<any> => {
    const result = await request("tools/call", { name, arguments: args }, session, credential)
    return (result.body as any).result
  }
  const agent = async (rules: object = {}) => {
    const socket: HubSocket = { conn: RelayHub.connection(grant("agent")), send: () => {}, close: () => {} }
    live.push(socket)
    const rpc = async (method: string, params: object = {}): Promise<any> => {
      let frame: any
      socket.send = (text) => {
        frame = JSON.parse(text)
      }
      await hub.message(socket, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }))
      if (frame.error) throw new Error(JSON.stringify(frame.error))
      return frame.result
    }
    await rpc("hello", { protocol: PROTOCOL, machine: "desk", claim: { handle: "worker", harness: "cli", ...rules } })
    return rpc
  }
  return { db, deps, hub, request, call, agent, logs }
}

describe("remote MCP", () => {
  test("transport initializes, negotiates and lists exactly the remote tools", async () => {
    const { hub, request } = setup()
    const init = await request("initialize", { protocolVersion: "unknown", clientInfo: { name: "Remote Client!" } })
    expect(init.headers["mcp-session-id"]).toBeString()
    expect(init.body).toMatchObject({ result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "scp" } } })
    expect((await request("tools/list")).body).toMatchObject({ result: { tools: REMOTE_TOOLS } })
    expect((await request("ping")).body).toMatchObject({ result: {} })
    expect((await request("unknown")).body).toMatchObject({ error: { code: -32601 } })
    expect((await hub.mcp(grant(), { method: "GET", session: null, client: "mcp-remote", body: null })).status).toBe(405)
    expect((await hub.mcp(grant(), { method: "POST", session: null, client: "mcp-remote", body: [] })).body).toMatchObject({ error: { code: -32600 } })
    expect(
      await hub.mcp(grant(), { method: "POST", session: null, client: "mcp-remote", body: { jsonrpc: "2.0", method: "notifications/initialized" } }),
    ).toMatchObject({ status: 202, body: null })
  })

  test("send, reply, inbox framing, acknowledgments and unread counts", async () => {
    const { call, agent } = setup()
    const rpc = await agent()
    const sent = await call("relay_send", { to: "desk/worker", body: "hello remote" })
    expect(sent.isError).toBeUndefined()
    expect(sent.content[0].text).toEndWith("0 unread")
    const inbox = await rpc("inbox")
    expect(inbox.messages[0].body.text).toBe("hello remote")
    const original = inbox.messages[0]
    await rpc("send", { to: original.from.address, body: "hello back", kind: "reply", reply_to: original.id, thread: original.thread })
    const who = await call("relay_whoami")
    expect(who.content[0].text).toEndWith("1 unread: call relay_inbox")
    expect(who._meta.unread).toBe(1)
    const invalid = await call("relay_send", { to: "desk/worker" })
    expect(invalid.isError).toBe(true)
    expect(invalid.content[0].text).toEndWith("1 unread: call relay_inbox")
    const read = await call("relay_inbox")
    expect(read.content[0].text).toContain("hello back")
    expect(read.content[0].text).toContain("<relay-message")
    expect(read.content[0].text).toEndWith("0 unread")
    const again = await call("relay_inbox")
    expect(again.content[0].text).toContain("no unread messages")
    const reply = await call("relay_reply", { id: "last", body: "thanks" })
    expect(reply.isError).toBeUndefined()
    expect((await rpc("inbox")).messages.at(-1).body.text).toBe("thanks")
  })

  test("session bindings persist, leave falls back, and grants have distinct machines", async () => {
    const { request, call, db, deps } = setup()
    const a = (await request("initialize")).headers["mcp-session-id"]!
    const b = (await request("initialize")).headers["mcp-session-id"]!
    expect((await call("relay_join", { name: "first" }, a)).isError).toBeUndefined()
    expect((await call("relay_join", { name: "second" }, b)).isError).toBeUndefined()
    expect((await call("relay_whoami", {}, a)).content[0].text).toContain("/first")
    expect((await call("relay_whoami", {}, b)).content[0].text).toContain("/second")
    const restarted = new RelayHub(deps)
    restarted.init({ user: "account" })
    const restored = await restarted.mcp(grant(), {
      method: "POST",
      client: "mcp-remote",
      session: a,
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "relay_whoami" } },
    })
    expect(JSON.stringify(restored.body)).toContain("/first")
    expect((await call("relay_leave", {}, a)).isError).toBeUndefined()
    expect((await call("relay_whoami", {}, a)).content[0].text).toContain("/mcp-remote")
    await call("relay_whoami", {}, null, grant("other"))
    const machines = db.query("SELECT machine FROM mcp_machines").all()
    expect(machines).toHaveLength(2)
    expect(new Set(machines.map((row: any) => row.machine)).size).toBe(2)
    expect((await call("relay_join", { name: "none" })).isError).toBe(true)
    expect(await restarted.mcp(grant(), { method: "DELETE", client: "mcp-remote", session: b, body: null })).toMatchObject({ status: 204, body: null })
    expect(db.query("SELECT * FROM mcp_bindings WHERE handle = 'second'").all()).toHaveLength(0)
  })

  test("sessions are bounded per grant and idle ones expire, joined sessions stay and forged ids cannot join", async () => {
    const { deps, db } = setup()
    let now = Date.now()
    const hub = new RelayHub({ ...deps, now: () => now })
    hub.init({ user: "account" })
    const post = (method: string, params: object, session: string | null) =>
      hub.mcp(grant(), { method: "POST", client: "mcp-remote", session, body: { jsonrpc: "2.0", id: 1, method, params } })
    const init = async () => (await post("initialize", {}, null)).headers["mcp-session-id"]!
    const joined = await init()
    expect(JSON.stringify((await post("tools/call", { name: "relay_join", arguments: { name: "kept" } }, joined)).body)).not.toContain("isError")
    const forged = await post("tools/call", { name: "relay_join", arguments: { name: "forged" } }, "made-up")
    expect(JSON.stringify(forged.body)).toContain("unknown session id")
    for (let i = 0; i < 70; i++) {
      now += 1
      await init()
    }
    const count = () => (db.query("SELECT COUNT(*) AS n FROM mcp_sessions").get() as any).n
    expect(count()).toBe(65)
    expect(db.query("SELECT 1 FROM mcp_sessions WHERE key LIKE ?").all(`%${joined}`)).toHaveLength(1)
    now += 31 * 86_400_000
    await init()
    expect(count()).toBe(2)
  })

  test("a refused join leaves the session usable, a suffixed name rejoins, and revoking drops the grant's rows", async () => {
    const { db, hub, request, call } = setup()
    const a = (await request("initialize")).headers["mcp-session-id"]!
    const b = (await request("initialize")).headers["mcp-session-id"]!
    expect((await call("relay_join", { name: "Not Valid" }, a)).isError).toBe(true)
    expect((await call("relay_join", { name: "me" }, a)).isError).toBe(true)
    expect((await call("relay_whoami", {}, a)).isError).toBeUndefined()
    expect((await call("relay_join", { name: "worker" }, a)).isError).toBeUndefined()
    expect((await call("relay_join", { name: "worker" }, b)).content[0].text).toContain("worker-2")
    expect((await call("relay_join", { name: "worker" }, b)).isError).toBeUndefined()
    expect((await call("relay_join", { name: "other" }, b)).isError).toBe(true)
    expect((await call("relay_leave", {}, b)).content[0].text).toContain("worker-2 left")
    hub.revoke({ tokenId: "install" })
    for (const table of ["mcp_sessions", "mcp_bindings", "mcp_machines"]) expect(db.query(`SELECT * FROM ${table}`).all()).toHaveLength(0)
  })

  test("the same requested handle still gives sessions distinct endpoints", async () => {
    const { request, call } = setup()
    const a = (await request("initialize")).headers["mcp-session-id"]!
    const b = (await request("initialize")).headers["mcp-session-id"]!
    const first = await call("relay_join", { name: "worker" }, a)
    const second = await call("relay_join", { name: "worker" }, b)
    expect(first.isError).toBeUndefined()
    expect(second.isError).toBeUndefined()
    expect((await call("relay_whoami", {}, a)).content[0].text).not.toBe((await call("relay_whoami", {}, b)).content[0].text)
  })

  test("scope and cross-account refusals stay tool errors", async () => {
    const { call, agent, hub } = setup()
    await agent({ in: [] })
    const blocked = await call("relay_send", { to: "desk/worker", body: "blocked" })
    expect(blocked.isError).toBe(true)
    const machine = (await call("relay_whoami")).content[0].text.match(/account\/([^/]+)\//)![1]
    const rpc: any = await hub.batch(grant(), [
      { id: 1, method: "hello", params: { protocol: PROTOCOL, machine, claim: { handle: "compare", harness: "cli" } } },
      { id: 2, method: "send", params: { to: "desk/worker", body: "blocked" } },
    ])
    expect(blocked.content[0].text).toContain(`${rpc[1].error.data.code}: ${rpc[1].error.message}`)
    const foreign = await call("relay_send", { to: "elsewhere/desk/worker", body: "blocked" })
    expect(foreign.isError).toBe(true)
    expect(foreign.content[0].text).toEndWith("0 unread")
  })

  test("judge gate holds remote sends", async () => {
    const { hub, agent, call } = setup()
    const rpc = await agent()
    const fake = new FakeJudgeClient([JSON.stringify({ verdict: "hold", categories: ["private"], reason: "review", redactions: [] })])
    const policy: JudgePolicy = {
      mode: "enforce",
      fail: "open",
      timeout_s: 5,
      model: { id: "test/judge", effort: "medium", key_env: "JUDGE_KEY" },
      budget: { per_minute: Infinity, per_hour: Infinity },
      boundaries: [{ from: "*", to: "*" }],
    }
    hub.configureJudge(policy, { env: { JUDGE_KEY: "key" }, client: () => fake })
    const held = await call("relay_send", { to: "desk/worker", body: "internal numbers" })
    expect(held.content[0].text).toContain("held for review")
    expect((await rpc("inbox")).messages).toHaveLength(0)
    expect(hub.holds()).toHaveLength(1)
  })

  test("waits are capped at 50 without sleeping", async () => {
    const { hub, agent, call } = setup()
    await agent()
    let cap = 0
    const internals = hub as any
    internals.awaitReply = async (_socket: HubSocket, _me: string, id: string, milliseconds: number) => {
      cap = milliseconds
      return { id, pending: true }
    }
    await call("relay_ask", { to: "desk/worker", body: "question", wait_s: 500 })
    expect(cap).toBe(50_000)
    expect(HUB_LIMITS.mcpWaitS).toBe(50)
    expect(REMOTE_TOOLS.filter((t: any) => t.inputSchema.properties?.wait_s).every((t: any) => t.inputSchema.properties.wait_s.maximum === 50)).toBe(true)
  })
})
