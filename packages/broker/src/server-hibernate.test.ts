import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { EndpointView, SendResult } from "@scp-dev/core"
import { RelayClient } from "./client"
import { type Broker, startBroker } from "./server"
import { parseWakers } from "./wakers"

const WAKER = join(import.meta.dir, "local-sleep-waker.ts")

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function setup(wakers: (root: string) => Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "relay-hibernate-"))
  const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0, wakers: wakers(root) })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => broker.stop())
  return { broker, root }
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

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [])

describe("broker, wake hooks", () => {
  test("a message to a hibernated agent runs its wake hook once; the woken session reclaims its endpoint and drains the queue", async () => {
    const { broker, root } = await setup((dir) => ({ "local-sleep": { command: ["bun", WAKER, "codex", join(dir, "woke.log")], timeout_s: 30 } }))
    const lane = await connect(broker, { claim: { handle: "lane", harness: "codex" } })
    const peer = await connect(broker, { claim: { handle: "peer", harness: "claude-code" } })
    const hibernated = await lane.client.request<{ endpoint: EndpointView }>("hibernate", { wake: "local-sleep", ref: "box-1" })
    expect(hibernated.endpoint).toMatchObject({ presence: "hibernated", wake: "hook:local-sleep" })
    lane.client.close()
    const sent = await peer.client.request<SendResult>("send", { to: "lane", body: "UNIQUE-BODY-4411" })
    expect(sent.deliveries[0]).toMatchObject({ queued: true, hibernated: true })
    await until(() => broker.core.whoami(lane.endpoint.id).presence !== "hibernated" && !broker.core.hasUnread(lane.endpoint.id))
    await until(() => lines(join(root, "woke.log")).length === 2)
    const [event, read] = lines(join(root, "woke.log")).map((line) => JSON.parse(line))
    expect(event).toMatchObject({
      scp: 1,
      event: "wake",
      endpoint: "me/lane",
      handle: "lane",
      provider: "local-sleep",
      ref: "box-1",
      message: { id: sent.id, from: "me/peer", kind: "message", thread: sent.thread },
      unread: 1,
    })
    expect(read).toEqual({ read: [sent.id] })
    expect(readFileSync(join(root, "woke.log"), "utf8")).not.toContain("UNIQUE-BODY")
    const audit = broker.core.log({ limit: 50 }).map((row) => row.event)
    expect(audit).toContain("wake_done")
    await until(() => broker.core.log({ limit: 50 }).some((row) => row.event === "wake" && row.detail.ok === true))
  })

  test("a failing hook leaves the message queued and the agent hibernated with wake_failed; a second message inside the debounce runs none", async () => {
    const { broker, root } = await setup((dir) => ({
      flaky: {
        command: [
          "sh",
          "-c",
          `cat >> '${join(dir, "hook.log")}'; echo >> '${join(dir, "hook.log")}'; env | grep '^SCP_' >> '${join(dir, "hook.log")}'; exit 1`,
        ],
      },
    }))
    const lane = await connect(broker, { claim: { handle: "lane", harness: "codex" } })
    const peer = await connect(broker, { claim: { handle: "peer", harness: "claude-code" } })
    await lane.client.request("hibernate", { wake: "flaky" })
    lane.client.close()
    await peer.client.request<SendResult>("send", { to: "lane", body: "UNIQUE-BODY-9902" })
    await until(() => broker.core.whoami(lane.endpoint.id).wake_failed !== undefined)
    expect(broker.core.whoami(lane.endpoint.id)).toMatchObject({ presence: "hibernated", wake: "hook:flaky", wake_failed: "exit 1" })
    expect(broker.core.hasUnread(lane.endpoint.id)).toBe(true)
    await peer.client.request<SendResult>("send", { to: "lane", body: "UNIQUE-BODY-9903" })
    await sleep(300)
    const log = readFileSync(join(root, "hook.log"), "utf8")
    expect(log.split("\n").filter((line) => line.startsWith("{")).length).toBe(1)
    expect(log).toContain("SCP_WAKE_HANDLE=lane")
    expect(log).toContain("SCP_WAKE_PROVIDER=flaky")
    expect(log).toContain("SCP_WAKE_FROM=me/peer")
    expect(log).not.toContain("UNIQUE-BODY")
    expect(broker.core.log({ limit: 50 }).find((row) => row.event === "wake")?.detail).toMatchObject({ ok: false, code: 1, provider: "flaky" })
  })

  test("a waker entry takes command and timeout_s; other fields are ignored, as in runners.json", () => {
    expect(parseWakers({ vm: { command: ["resume-vm"], extra: { command: ["x"] } } })).toEqual({ vm: { command: ["resume-vm"], timeout_s: 60 } })
    expect(() => parseWakers({ vm: { command: [] } })).toThrow("command is a nonempty array of strings")
    expect(() => parseWakers({ VM: { command: ["x"] } })).toThrow("is not a provider name")
  })

  test("a hook's exit 77 with a declined reason is a decline: wake_declined, no failure, the send result says declined", async () => {
    const { broker } = await setup(() => ({ busy: { command: ["sh", "-c", `cat > /dev/null; printf '{"declined":"budget"}'; exit 77`] } }))
    const lane = await connect(broker, { claim: { handle: "lane", harness: "codex" } })
    const peer = await connect(broker, { claim: { handle: "peer", harness: "claude-code" } })
    await lane.client.request("hibernate", { wake: "busy", eta_s: 30 })
    lane.client.close()
    expect((await peer.client.request<SendResult>("send", { to: "lane", body: "one" })).deliveries[0]).toMatchObject({ wake: "hook:busy", wake_eta_s: 30 })
    await until(() => broker.core.whoami(lane.endpoint.id).wake_declined !== undefined)
    expect(broker.core.whoami(lane.endpoint.id)).toMatchObject({ presence: "hibernated", wake_declined: "budget" })
    expect(broker.core.whoami(lane.endpoint.id)).not.toHaveProperty("wake_failed")
    expect((await peer.client.request<SendResult>("send", { to: "lane", body: "two" })).deliveries[0]).toMatchObject({ wake: "declined" })
    expect(broker.core.log({ limit: 50 }).find((row) => row.event === "wake")?.detail).toMatchObject({ ok: false, declined: "budget", code: 77 })
  })

  test("hibernate refuses a provider no waker is configured for, and a hook connection cannot call it", async () => {
    const { broker } = await setup(() => ({ known: { command: ["true"] } }))
    const lane = await connect(broker, { claim: { handle: "lane", harness: "codex", session: "s1", process: `pid:${process.pid}:x` } })
    await expect(lane.client.request("hibernate", { wake: "unknown" })).rejects.toMatchObject({ code: "invalid_params" })
    const hook = await connect(broker, { transient: true, claim: { harness: "codex", session: "s1", process: `pid:${process.pid}:x` } })
    await expect(hook.client.request("hibernate", { wake: "known" })).rejects.toMatchObject({ code: "unauthorized" })
    const human = await connect(broker, { human: true, tty: false })
    expect((await human.client.request<{ endpoint: EndpointView }>("hibernate", { endpoint: "lane", wake: "known" })).endpoint.presence).toBe("hibernated")
    await expect(human.client.request("machine_wake", { url: "https://example.com/wake", secret: "s".repeat(32) })).rejects.toMatchObject({
      code: "unavailable",
    })
  })
})
