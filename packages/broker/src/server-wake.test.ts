import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type EndpointView, RelayError, type SendResult } from "@scp-dev/core"
import { RelayClient } from "./client"
import { type Broker, startBroker } from "./server"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "relay-wake-"))
  const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0 })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => broker.stop())
  return broker
}

async function connect(broker: Broker, hello: Parameters<RelayClient["hello"]>[0]) {
  const client = await RelayClient.connect(broker.socket)
  cleanups.push(() => client.close())
  await client.hello(hello)
  return client
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

describe("broker, wake", () => {
  test("an agent, its hook and a launcher bound to it by observe say how it wakes; list and send carry it", async () => {
    const broker = await setup()
    const lane = await connect(broker, { claim: { handle: "lane", harness: "codex", session: "s1", process: key(process.pid) } })
    const peer = await connect(broker, { claim: { handle: "peer", harness: "claude-code" } })
    const wakeOf = async () => (await peer.request<{ endpoints: EndpointView[] }>("list")).endpoints.find((e) => e.address === "me/lane")!.wake
    expect(await wakeOf()).toBeNull()
    expect(await lane.request<object>("wake", { via: "channels" })).toEqual({ changed: true })
    expect(await wakeOf()).toBe("channels")
    expect(await code(lane.request("wake", { via: "bogus" }))).toBe("invalid_params")
    const hook = await connect(broker, { transient: true, claim: { harness: "codex", session: "s1", process: key(process.pid) } })
    expect(await hook.request<object>("wake", { via: "none" })).toEqual({ changed: true })
    expect(await wakeOf()).toBeNull()
    const launcher = await connect(broker, { observe: true, self: [key(process.pid)] })
    expect(await launcher.request<object>("wake", { via: "codex-app-server" })).toEqual({ changed: true })
    expect(await wakeOf()).toBe("codex-app-server")
    const sent = await peer.request<SendResult>("send", { to: "lane", body: "hi" })
    expect(sent.deliveries[0]).toMatchObject({ address: "me/lane", wake: "codex-app-server" })
    const observer = await connect(broker, { observe: true })
    expect(await code(observer.request("wake", { via: "channels" }))).toBe("unauthorized")
  })
})
