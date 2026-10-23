import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { LocalAgent } from "@scp-dev/core"
import { RelayClient } from "./client"
import { startBroker } from "./server"
import { type BrokerTaskContext, startTasks } from "./tasks"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await sleep(10)
  }
}

describe("broker tasks", () => {
  test("a task runs on its interval, never overlapping itself, a failure is logged and stop ends it", async () => {
    const logged: string[] = []
    const context = { agents: () => [], hibernate() {}, unhibernate() {}, kick() {}, log: (line: string) => logged.push(line) } as BrokerTaskContext
    let runs = 0
    let inFlight = 0
    let most = 0
    const tasks = startTasks(
      [
        {
          name: "slow",
          everyMs: 5,
          async run() {
            runs++
            most = Math.max(most, ++inFlight)
            await sleep(30)
            inFlight--
            if (runs === 1) throw new Error("boom")
          },
        },
      ],
      context,
    )
    await until(() => runs >= 3)
    tasks.stop()
    const after = runs
    await sleep(60)
    expect(most).toBe(1)
    expect(runs).toBeLessThanOrEqual(after + 1)
    expect(logged).toEqual(["relay broker: task slow failed: boom"])
  })

  test("a task reads local agents and hibernates one as the broker; the agents method answers the human only", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-tasks-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    let context: BrokerTaskContext | undefined
    const broker = await startBroker({
      dir: join(root, "state"),
      policyPath: join(root, "policy.json"),
      idleMs: 0,
      builtinWakers: { "claude-bg": { command: [process.execPath, "-e", "process.exit(0)"], timeout_s: 5 } },
      tasks: [
        {
          name: "probe",
          everyMs: 10,
          async run(given) {
            context = given
          },
        },
      ],
    })
    cleanups.push(() => broker.stop())
    const lane = await RelayClient.connect(broker.socket)
    cleanups.push(() => lane.close())
    const { endpoint } = await lane.hello({ claim: { handle: "lane", harness: "claude-code" } })
    await until(() => context !== undefined)
    expect(context!.agents().find((agent) => agent.id === endpoint!.id)).toMatchObject({ address: "me/lane", parent: null, children: 0, unread: false })
    context!.hibernate(endpoint!.id, "claude-bg", "11111111-2222-4333-8444-555555555555")
    expect(broker.core.whoami(endpoint!.id)).toMatchObject({ presence: "hibernated", wake: "hook:claude-bg" })
    expect(() => context!.hibernate(endpoint!.id, "nobody", null)).toThrow("no waker nobody is configured")
    context!.unhibernate(endpoint!.id)
    expect(broker.core.whoami(endpoint!.id).wake).not.toBe("hook:claude-bg")
    const audit = broker.core
      .log({ limit: 50 })
      .filter((row) => row.event === "hibernate" || row.event === "unhibernate")
      .sort((a, b) => a.id - b.id)
    expect(audit.map((row) => [row.event, (row.detail as { by?: string }).by])).toEqual([
      ["hibernate", "broker"],
      ["unhibernate", "broker"],
    ])
    await expect(lane.request("agents")).rejects.toThrow("only the human")
    const human = await RelayClient.connect(broker.socket)
    cleanups.push(() => human.close())
    await human.hello({ human: true })
    const { agents } = await human.request<{ agents: LocalAgent[] }>("agents")
    expect(agents.map((agent) => agent.address)).toEqual(["me/lane"])
  })
})
