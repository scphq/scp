import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EndpointView, SendResult } from "@scp-dev/core"
import { RelayClient } from "./client"
import { type Broker, startBroker } from "./server"
import { type FakeHubServer, startFakeHubServer } from "./testing"

setDefaultTimeout(20_000)

const TOKEN = `hub-cred-${"h".repeat(32)}`
const WAKER = join(import.meta.dir, "local-sleep-waker.ts")

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function until<T>(fn: () => T, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = fn()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

async function machine(fake: FakeHubServer, name: string, root: string, wakers?: Record<string, unknown>): Promise<Broker> {
  const broker = await startBroker({
    dir: join(root, "state"),
    policyPath: join(root, "policy.json"),
    idleMs: 0,
    log: () => {},
    wakers,
    bridge: { url: fake.url, token: TOKEN, machine: name, backoff: { minMs: 20, maxMs: 100 }, injectBackoffMs: 20, localFlushMs: 20 },
  })
  cleanups.push(() => broker.stop())
  await until(() => broker.bridge!.status().connected, `${name}'s bridge`)
  return broker
}

async function agent(broker: Broker, handle: string) {
  const client = await RelayClient.connect(broker.socket)
  cleanups.push(() => client.close())
  const hello = await client.hello({ claim: { handle, harness: "codex" } })
  return { client, endpoint: hello.endpoint! }
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [])

describe("bridge, hibernated endpoints", () => {
  test("a hub-queued delivery to a hibernated machine replays when its bridge resubscribes and runs the local wake hook once", async () => {
    const fake = startFakeHubServer({ tokens: { [TOKEN]: { tokenId: "tok_1", user: "ada" } } })
    cleanups.push(() => fake.stop())
    const vmRoot = mkdtempSync(join(tmpdir(), "relay-hib-vm-"))
    const laptopRoot = mkdtempSync(join(tmpdir(), "relay-hib-laptop-"))
    cleanups.push(() => rmSync(vmRoot, { recursive: true, force: true }))
    cleanups.push(() => rmSync(laptopRoot, { recursive: true, force: true }))
    const record = join(vmRoot, "woke.log")
    const wakers = { "local-sleep": { command: ["bun", WAKER, "codex", record], timeout_s: 30 } }
    const vm = await machine(fake, "vm", vmRoot, wakers)
    const laptop = await machine(fake, "laptop", laptopRoot)
    const w = await agent(vm, "w")
    const lead = await agent(laptop, "lead")
    const hibernated = await w.client.request<{ endpoint: EndpointView; mirrored: boolean }>("hibernate", { wake: "local-sleep" })
    expect(hibernated).toMatchObject({ endpoint: { presence: "hibernated" }, mirrored: true })
    w.client.close()
    const raw = vm.core as unknown as { byId(id: string): { connections: number } }
    await until(() => raw.byId(w.endpoint.id).connections === 0, "the session's connection to close")
    await vm.stop()
    await until(
      () =>
        fake
          .hub("ada")
          .overview()
          .endpoints.find((e) => e.address === "ada/vm/w" && e.presence === "hibernated"),
      "the hub's hibernated mirror after the bridge closed",
    )
    const sent = await lead.client.request<SendResult>("send", { to: "vm/w", body: "UNIQUE-REPLAY-BODY" })
    expect(sent.deliveries[0]).toMatchObject({ hibernated: true })
    expect(lines(record)).toEqual([])
    const again = await machine(fake, "vm", vmRoot, wakers)
    await until(() => lines(record).length === 2, "the wake hook and the drained queue")
    const [event, read] = lines(record).map((line) => JSON.parse(line))
    expect(event).toMatchObject({ event: "wake", endpoint: "me/w", provider: "local-sleep", message: { id: sent.id } })
    expect(read).toEqual({ read: [sent.id] })
    expect(readFileSync(record, "utf8")).not.toContain("UNIQUE-REPLAY-BODY")
    await until(() => again.core.whoami(w.endpoint.id).presence !== "hibernated", "the reclaim")
    const wakes = () => again.core.log({ limit: 100 }).filter((row) => row.event === "wake")
    await until(() => wakes().length === 1, "the wake hook's result")
    await Bun.sleep(200)
    expect(lines(record).length).toBe(2)
    expect(wakes().map((row) => row.detail.ok)).toEqual([true])
  })
})
