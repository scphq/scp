import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type EndpointView, LIMITS, RelayError, type SendResult } from "@scp-dev/core"
import { RelayClient } from "./client"
import { type Broker, startBroker } from "./server"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function setup(now?: () => number) {
  const root = mkdtempSync(join(tmpdir(), "relay-wake-"))
  const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0, now })
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

  test("a launcher's waker keeps a hook-only endpoint idle, and its close tells the watchers it went offline", async () => {
    const clock = { now: Date.now() }
    const broker = await setup(() => clock.now)
    const hook = await connect(broker, { transient: true, claim: { handle: "lane", harness: "codex", session: "s1", process: key(process.pid) } })
    hook.close()
    const launcher = await connect(broker, { observe: true, self: [key(process.pid)] })
    await launcher.request("wake", { via: "codex-app-server" })
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    const watcher = await connect(broker, { human: true })
    const events: Record<string, unknown>[] = []
    watcher.onNotification((method, params) => method === "fleet" && events.push(params as Record<string, unknown>))
    await watcher.request("watch")
    const lane = async () => (await watcher.request<{ endpoints: EndpointView[] }>("list")).endpoints.find((e) => e.address === "me/lane")?.presence
    expect(await lane()).toBe("idle")
    launcher.close()
    await Bun.sleep(100)
    expect(events).toContainEqual(expect.objectContaining({ type: "presence", endpoint: "me/lane", presence: "offline" }))
    expect(await lane()).toBe("offline")
  })

  test("a broker wake outlasts its hook and harness: each delivery runs its waker, which binds with the run's ticket and confirms the messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-broker-wake-"))
    const log = join(root, "woke.log")
    const waker = join(root, "waker.ts")
    writeFileSync(
      waker,
      `import { appendFileSync } from "node:fs"
import { RelayClient } from ${JSON.stringify(join(import.meta.dir, "client.ts"))}
import { socketPath } from ${JSON.stringify(join(import.meta.dir, "paths.ts"))}
let input = ""
for await (const chunk of process.stdin) input += String(chunk)
const client = await RelayClient.connect(socketPath(process.env.SCP_DIR!))
await client.hello({ observe: true, ticket: process.env.SCP_WAKE_TICKET! })
const { messages, hold } = await client.request("inbox", { offer: true })
const seqs = messages.map((m) => m.seq)
await client.request("injected", { seqs, hold, read: seqs })
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event: JSON.parse(input), bodies: messages.map((m) => m.body.text) }) + "\\n")
client.close()
`,
    )
    const broker = await startBroker({
      dir: join(root, "state"),
      policyPath: join(root, "policy.json"),
      idleMs: 0,
      builtinWakers: { "codex-queue": { command: [process.execPath, waker], timeout_s: 30 } },
    })
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    cleanups.push(() => broker.stop())
    const thread = "01a1602d-b655-70a1-b717-0af8f5083d80"
    const dead = "pid:999999:Fri-Oct-17-09:00:00-2026"
    const hook = await connect(broker, { transient: true, claim: { handle: "lane", harness: "codex", session: "s1", process: dead, harness_session: thread } })
    await hook.request("event", { kind: "stop", session_id: thread })
    expect(await hook.request<object>("wake", { via: "codex-queue" })).toEqual({ changed: true })
    hook.close()
    const peer = await connect(broker, { claim: { handle: "peer", harness: "claude-code" } })
    const lane = () => broker.core.list({ all: true }).find((e) => e.address === "me/lane")!
    expect(lane().wake).toBe("codex-queue")
    const woke = () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : []
    const sent = await peer.request<SendResult>("send", { to: "lane", body: "first" })
    expect(sent.deliveries[0]).toMatchObject({ wake: "codex-queue" })
    for (const deadline = Date.now() + 10_000; woke().length < 1 && Date.now() < deadline; ) await Bun.sleep(25)
    expect(woke()[0]).toMatchObject({ event: { provider: "codex-queue", ref: thread, endpoint: "me/lane" }, bodies: ["first"] })
    await peer.request("send", { to: "lane", body: "second" })
    for (const deadline = Date.now() + 10_000; woke().length < 2 && Date.now() < deadline; ) await Bun.sleep(25)
    expect(woke()[1].bodies).toEqual(["second"])
    expect(broker.core.hasUnread(lane().id)).toBe(false)
    const desktop = broker.core.claim(
      { handle: "codex-desktop", harness: "codex-desktop", session: `codex:${thread}`, process: "pid:999998:x", harness_session: thread },
      { transient: true },
    )
    expect(desktop.endpoint).toMatchObject({ id: lane().id, harness: "codex-desktop", wake: "codex-queue" })
    const turn = await connect(broker, {
      transient: true,
      claim: { harness: "codex-desktop", session: `codex:${thread}`, process: "pid:999998:x", harness_session: thread },
    })
    await turn.request("prompted", {})
    expect(lane().wake).toBeNull()
    await peer.request("send", { to: "lane", body: "during the turn" })
    expect(await turn.request<object>("wake", { via: "codex-queue" })).toEqual({ changed: true })
    for (const deadline = Date.now() + 10_000; woke().length < 3 && Date.now() < deadline; ) await Bun.sleep(25)
    expect(woke()[2].bodies).toEqual(["during the turn"])
  })
})
