import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RelayClient } from "./client"
import { startBroker } from "./server"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** a hub that links the bridge and then answers nothing more, keeping its sockets open */
function silentHub() {
  let silent = false
  let sockets = 0
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return undefined
      return new Response("not found", { status: 404 })
    },
    websocket: {
      open() {
        sockets++
      },
      message(ws, data) {
        const frame = JSON.parse(String(data)) as { id?: number; method?: string }
        if (silent || frame.id === undefined) return
        const result = frame.method === "hello" ? { account: "ada", endpoints: [], others: [] } : {}
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }))
        if (frame.method === "subscribe") silent = true
      },
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, sockets: () => sockets }
}

test("a request the hub never answers fails in time and the silent socket is linked again", async () => {
  const hub = silentHub()
  const root = mkdtempSync(join(tmpdir(), "relay-silent-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const broker = await startBroker({
    dir: join(root, "state"),
    policyPath: join(root, "policy.json"),
    idleMs: 0,
    log: () => {},
    bridge: { url: hub.url, token: `hub-cred-${"t".repeat(32)}`, machine: "m1", backoff: { minMs: 20, maxMs: 100 }, replyTimeoutMs: 300 },
  })
  cleanups.push(() => broker.stop())
  const deadline = Date.now() + 5000
  while (!broker.bridge!.status().connected) {
    if (Date.now() > deadline) throw new Error("the bridge never linked")
    await Bun.sleep(20)
  }
  const human = await RelayClient.connect(broker.socket)
  cleanups.push(() => human.close())
  await human.hello({ human: true, tty: true })
  const started = Date.now()
  await expect(human.request("machine_wake", { url: null })).rejects.toMatchObject({ code: "unavailable" })
  expect(Date.now() - started).toBeLessThan(3000)
  while (hub.sockets() < 2) {
    if (Date.now() > deadline + 5000) throw new Error("the silent socket was never linked again")
    await Bun.sleep(20)
  }
})
