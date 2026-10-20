import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { type EndpointView, RelayError } from "@scp-dev/core"
import { RelayClient } from "./client"
import { type Broker, startBroker } from "./server"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const REF = JSON.stringify({ harness: "codex", session: "019a-s", cwd: "/w", argv: ["codex", "exec", "resume", "019a-s"], idle_s: 60, parent: "me/lead" })
const key = (pid: number) => `pid:${pid}:Mon-Oct-19-10:00:00-2026`

async function setup(builtin: boolean, dir?: string) {
  const root = dir ?? mkdtempSync(join(tmpdir(), "relay-spawn-hold-"))
  if (!dir) cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const record = join(root, "woke.log")
  const broker = await startBroker({
    dir: join(root, "state"),
    policyPath: join(root, "policy.json"),
    idleMs: 0,
    ...(builtin ? { builtinWakers: { spawn: { command: ["sh", "-c", `cat >> ${JSON.stringify(record)}`] } } } : {}),
  })
  cleanups.push(() => broker.stop())
  return { broker, root, record }
}

async function connect(broker: Broker, hello: Parameters<RelayClient["hello"]>[0]) {
  const client = await RelayClient.connect(broker.socket)
  cleanups.push(() => client.close())
  const result = await client.hello(hello)
  return { client, endpoint: result.endpoint! }
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await sleep(25)
  }
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

describe("broker, held spawns", () => {
  test("a durable hold needs the spawn waker; without one the endpoint can still be held plainly", async () => {
    const { broker } = await setup(false)
    const { client } = await connect(broker, { claim: { handle: "w", harness: "codex", session: "s1", process: key(11) } })
    expect(await code(client.request("wake", { via: "spawn-resume", ref: REF }))).toBe("invalid_params")
    expect(await client.request("wake", { via: "spawn-resume" })).toEqual({ changed: true })
  })

  test("a durable hold's connection closing hibernates it by the built-in waker, which then runs for its unread message", async () => {
    const { broker, record } = await setup(true)
    const lead = await connect(broker, { claim: { handle: "lead", harness: "claude-code", session: "s0", process: key(10) } })
    const held = await connect(broker, { claim: { handle: "w", harness: "codex", session: "s1", process: key(11) } })
    expect(await held.client.request("wake", { via: "spawn-resume", ref: REF })).toEqual({ changed: true })
    await lead.client.request("send", { to: "w", body: "queued while held" })
    held.client.close()
    await until(() => broker.core.whoami(held.endpoint.id).presence === "hibernated")
    expect(broker.core.whoami(held.endpoint.id).wake).toBe("hook:spawn")
    await until(() => existsSync(record) && readFileSync(record, "utf8").includes("\n"))
    expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({ event: "wake", endpoint: "me/w", provider: "spawn", ref: REF, unread: 1 })
  })

  test("spawn_end closes the holding connection, so the hold ends without a hibernation", async () => {
    const { broker } = await setup(true)
    const lead = await connect(broker, { claim: { handle: "lead", harness: "claude-code", session: "s0", process: key(10) } })
    const grant = await lead.client.grant({ name: "w", spawn: true, ttl_s: 60 })
    const held = await connect(broker, { claim: { handle: "w", harness: "codex", session: "s1", process: key(11), grant: grant.token } })
    await held.client.request("wake", { via: "spawn-resume", ref: REF })
    const waiting = held.client.request("inbox", { wait_s: 30, offer: true })
    const ended = await lead.client.request<{ endpoint: EndpointView; held: boolean }>("spawn_end", { endpoint: "w" })
    expect(ended).toMatchObject({ held: true, endpoint: { address: "me/w", wake: null } })
    expect(await waiting.then(() => "answered").catch(() => "closed")).toBe("closed")
    await sleep(100)
    expect(broker.core.whoami(held.endpoint.id)).toMatchObject({ presence: "offline", wake: null })
  })

  test("a broker that starts again hibernates the endpoints a durable spawn still held", async () => {
    const first = await setup(true)
    const held = await connect(first.broker, { claim: { handle: "w", harness: "codex", session: "s1", process: key(11) } })
    await held.client.request("wake", { via: "spawn-resume", ref: REF })
    await first.broker.stop()
    const again = await setup(true, first.root)
    expect(again.broker.core.whoami(held.endpoint.id)).toMatchObject({ presence: "hibernated", wake: "hook:spawn" })
  })
})
