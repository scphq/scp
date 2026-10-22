import { Database } from "bun:sqlite"
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

test("hook hellos stay fast with thousands of offline endpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-scale-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, "state")
  const broker = await startBroker({ dir, policyPath: join(root, "policy.json"), idleMs: 0 })
  cleanups.push(() => broker.stop())
  const db = new Database(join(dir, "relay.db"))
  const now = Date.now()
  const insert = db.query(
    `INSERT INTO endpoints (id, handle, kind, harness, labels, created_at, last_seen, parent_ep, tree, depth) VALUES (?, ?, 'agent', 'claude-code', '{}', ?, ?, ?, ?, ?)`,
  )
  db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      const tree = `ep_old${i - (i % 10)}`
      insert.run(`ep_old${i}`, `old-${i}`, now - 3 * 86_400_000, now - 2 * 86_400_000, i % 10 ? tree : null, i % 10 ? tree : null, i % 10 ? 1 : 0)
    }
  })()
  db.close()
  const claim = { handle: "live", harness: "claude-code", cwd: root, session: "pid:7:scale", process: "pid:7:scale" }
  const started = performance.now()
  for (let i = 0; i < 20; i++) {
    const client = await RelayClient.connect(broker.socket)
    await client.hello({ transient: true, claim })
    await client.request("event", { kind: "tool", name: "Bash" })
    client.close()
  }
  const status = await RelayClient.connect(broker.socket)
  cleanups.push(() => status.close())
  await status.hello({ human: true, tty: true, brief: true })
  const { endpoints } = await status.request<{ endpoints: { address: string }[] }>("snapshot", {})
  expect(endpoints.some((view) => view.address.endsWith("/live"))).toBe(true)
  expect(performance.now() - started).toBeLessThan(4000)
})
