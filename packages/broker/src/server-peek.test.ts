import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type PeekResult, type PeekState, RelayError } from "@scp-dev/core"
import { RelayClient } from "./client"
import { type Broker, startBroker } from "./server"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "relay-peek-"))
  const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0 })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => broker.stop())
  return broker
}

async function connect(broker: Broker, hello: Parameters<RelayClient["hello"]>[0]) {
  const client = await RelayClient.connect(broker.socket)
  cleanups.push(() => client.close())
  const result = await client.hello(hello)
  return { client, hello: result }
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RelayError) return error.code
    throw error
  }
  return undefined
}

const key = (pid: number) => `pid:${pid}:Fri-Oct-17-09:00:00-2026`

describe("broker, peek", () => {
  test("a hook posts digest turns; peek is refused on its connection; another agent peeks once it is on", async () => {
    const broker = await setup()
    const lane = await connect(broker, { claim: { handle: "lane", harness: "claude-code", session: "s1", process: key(300) } })
    const other = await connect(broker, { claim: { handle: "other", harness: "codex" } })
    const hook = await connect(broker, { transient: true, claim: { harness: "claude-code", session: "s1", process: key(300) } })
    expect(await hook.client.request<object>("peek_turn", { role: "user", text: "while off" })).toEqual({ stored: false })
    expect(await code(other.client.request("peek", { endpoint: "lane" }))).toBe("not_found")
    expect(await lane.client.request<object>("peek_set", { level: "on" })).toEqual({ endpoint: "me/lane", peek: "local" })
    expect(await hook.client.request<object>("peek_turn", { role: "user", text: "ship the fix" })).toEqual({ stored: true })
    await hook.client.request("event", { kind: "tool", tool: "Edit" })
    await Bun.sleep(5)
    expect(await hook.client.request<object>("peek_turn", { role: "assistant", text: "shipped" })).toEqual({ stored: true })
    for (const method of ["peek", "peek_set", "peek_who"])
      expect(await code(hook.client.request(method, { endpoint: "lane", level: "on" }))).toBe("scope_refused")
    const seen = await other.client.request<PeekResult>("peek", { endpoint: "lane", turns: 2 })
    expect(seen).toMatchObject({ endpoint: "me/lane", source: "digest", level: "local" })
    expect(seen.turns.map((t) => t.text)).toEqual(["ship the fix", "shipped"])
    expect(await code(other.client.request("peek", { endpoint: "lane", turns: 11 }))).toBe("invalid_params")
    const who = await lane.client.request<PeekState & { address: string }>("whoami")
    expect(who).toMatchObject({ address: "me/lane", peek: "local", peeked_by: [{ by: "me/other", auth: "session", turns: 2 }] })
    const hooked = await hook.client.request<Record<string, unknown>>("whoami")
    expect(hooked).not.toHaveProperty("peek")
    expect(broker.core.whoami(lane.hello.endpoint!.id)).not.toHaveProperty("peeked_by")
    expect(await lane.client.request("peek_who")).toMatchObject({ peeked_by: [{ by: "me/other" }] })
    expect(
      await other.client
        .request<{ endpoints: { address: string; peekable?: string }[] }>("list")
        .then((r) => r.endpoints.find((e) => e.address === "me/lane")?.peekable),
    ).toBe("local")
    expect(
      await other.client
        .request<{ peers: { address: string; peekable?: string }[] }>("peers")
        .then((r) => r.peers.find((e) => e.address === "me/lane")?.peekable),
    ).toBe("local")
  })

  test("only a hook of the endpoint's own harness process posts digest turns; its session, a plain shell and another process cannot", async () => {
    const broker = await setup()
    const lane = await connect(broker, { claim: { handle: "lane", harness: "claude-code", session: "s1", process: key(300) } })
    expect(await lane.client.request<object>("peek_set", { level: "on" })).toEqual({ endpoint: "me/lane", peek: "local" })
    const turn = { role: "user", text: "FORGED-MARKER" }
    expect(await code(lane.client.request("peek_turn", turn))).toBe("unauthorized")
    const shell = await connect(broker, { human: true, lineage: [301, 300].map(key), brief: true })
    expect(shell.hello.endpoint).toMatchObject({ address: "me/lane" })
    expect(await code(shell.client.request("peek_turn", turn))).toBe("unauthorized")
    const own = await connect(broker, { observe: true, self: [301, 300].map(key), lineage: [301, 300].map(key), brief: true })
    expect(own.hello.endpoint).toMatchObject({ address: "me/lane" })
    expect(await code(own.client.request("peek_turn", turn))).toBe("unauthorized")
    const bare = await connect(broker, { transient: true, claim: { harness: "claude-code", session: "s1" } })
    expect(await code(bare.client.request("peek_turn", turn))).toBe("unauthorized")
    const stranger = await connect(broker, { transient: true, claim: { harness: "claude-code", session: "s1", process: key(400) } })
    expect(await code(stranger.client.request("peek_turn", turn))).toBe("unauthorized")
    const hook = await connect(broker, { transient: true, claim: { harness: "claude-code", session: "s1", process: key(300) } })
    expect(await hook.client.request<object>("peek_turn", { role: "user", text: "real turn" })).toEqual({ stored: true })
    const seen = broker.core.peek({ kind: "human", tty: true }, { endpoint: "lane", turns: 10 })
    expect(seen.turns.map((t) => t.text)).toEqual(["real turn"])
  })

  test("the human at a terminal peeks an endpoint that is off and sees peekable rows; log --peek lists peek rows", async () => {
    const broker = await setup()
    const lane = await connect(broker, { claim: { handle: "lane", harness: "codex" } })
    await connect(broker, { claim: { handle: "on", harness: "codex" } }).then((on) => on.client.request<object>("peek_set", { level: "on" }))
    const human = await connect(broker, { human: true, tty: true })
    expect(await human.client.request("peek", { endpoint: "lane" })).toMatchObject({ endpoint: "me/lane", level: null, source: "status" })
    const listed = await human.client.request<{ endpoints: { address: string; peekable?: string }[] }>("list")
    expect(listed.endpoints.filter((e) => e.peekable).map((e) => e.address)).toEqual(["me/on"])
    expect(await human.client.request<object>("peek_set", { endpoint: "lane", level: "on" })).toEqual({ endpoint: "me/lane", peek: "local" })
    const rows = await human.client.request<{ rows: { event: string }[] }>("log", { peek: true })
    expect(rows.rows.map((r) => r.event)).toEqual(["peek_set", "peek", "peek_set"])
    expect(await lane.client.request("peek_who")).toMatchObject({ peeked_by: [{ by: "me/", auth: "tty" }] })
    const untyped = await connect(broker, { human: true })
    expect(await code(untyped.client.request<object>("peek_set", { endpoint: "lane", level: "on" }))).toBeUndefined()
    expect(await code(untyped.client.request<object>("peek_set", { endpoint: "on", level: "off" }))).toBeUndefined()
    expect(await code(untyped.client.request<object>("peek_set", { endpoint: "on", level: "on" }))).toBe("scope_refused")
  })
})
