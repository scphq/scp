import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RelayClient } from "./client"
import { startBroker, type Broker } from "./server"
import type { HookHandler, HookParams, HookResult } from "./hook"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})
async function setup(hook?: HookHandler) {
  const dir = mkdtempSync(join(tmpdir(), "broker-hook-"))
  const broker = await startBroker({ dir, idleMs: 0, ...(hook ? { hook } : {}) })
  const clients: RelayClient[] = []
  const client = async (observe = true) => {
    const client = await RelayClient.connect(broker.socket)
    clients.push(client)
    await client.hello(observe ? { observe: true } : { human: true })
    return client
  }
  cleanups.push(async () => {
    for (const client of clients) client.close()
    await broker.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  return { broker, client }
}
const params = (): HookParams => ({
  args: ["codex"],
  payload: {},
  env: {},
  origin: Date.now(),
  ends: Date.now() + 2000,
  ppid: 12,
  procs: [{ pid: 12, ppid: 1, start: null, args: "codex", comm: "codex" }],
})

describe("hook RPC", () => {
  test("capability is conditional and the unbound observer stays unbound", async () => {
    for (const enabled of [false, true]) {
      const { broker } = await setup(enabled ? async () => ({ exit: 0 }) : undefined)
      const client = await RelayClient.connect(broker.socket)
      try {
        expect((await client.hello({ observe: true })).capabilities.includes("hook")).toBe(enabled)
        if (enabled) expect(await client.request("hook", params())).toEqual({ exit: 0 })
        await expect(client.request("whoami")).rejects.toMatchObject({ code: "unauthorized" })
      } finally {
        client.close()
      }
    }
  })
  test("rejects non-observers, lineage observers and malformed params", async () => {
    const { broker, client } = await setup(async () => ({ exit: 0 }))
    await expect((await client(false)).request("hook", params())).rejects.toMatchObject({ code: "unauthorized" })
    const narrowed = await RelayClient.connect(broker.socket)
    try {
      await narrowed.hello({ observe: true, lineage: [] })
      await expect(narrowed.request("hook", params())).rejects.toMatchObject({ code: "unauthorized" })
    } finally {
      narrowed.close()
    }
    const observer = await client()
    for (const change of [
      { extra: 1 },
      { args: [1] },
      { env: { SECRET: "value" } },
      { origin: null },
      { procs: [{ pid: 12, ppid: 1, args: "x", start: null }] },
      { procs: Array(65).fill(params().procs[0]) },
      { payload: [] },
      { harness_pid: 0 },
    ])
      await expect(observer.request("hook", { ...params(), ...change })).rejects.toMatchObject({ code: "invalid_params" })
  })
  test("commits belong to their connection and wait for confirmation work", async () => {
    let confirmed = false
    const { client } = await setup(async (_params, context) => {
      if (await context.print("output")) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        confirmed = true
      }
      return { exit: 0 }
    })
    const owner = await client()
    const other = await client()
    const result = await owner.request<HookResult>("hook", params())
    expect(confirmed).toBe(false)
    expect(await other.request("hook_commit", { commit: result.commit })).toEqual({})
    expect(confirmed).toBe(false)
    expect(await owner.request("hook_commit", { commit: result.commit })).toEqual({})
    expect(confirmed).toBe(true)
    expect(await owner.request("hook_commit", { commit: result.commit })).toEqual({})
  })
  test("close and deadline expiry never confirm, and deadline changes notify", async () => {
    const accepted: boolean[] = []
    const { client } = await setup(async (params, context) => {
      context.notify(params.ends)
      accepted.push(await context.print("output"))
      return { exit: 0 }
    })
    for (const close of [true, false]) {
      const owner = await client()
      const notifications: unknown[] = []
      owner.onNotification((method, value) => {
        if (method === "hook_deadline") notifications.push(value)
      })
      const input = { ...params(), ends: Date.now() + 50 }
      const result = await owner.request<HookResult>("hook", input)
      expect(notifications).toEqual([{ ends: input.ends }])
      if (close) owner.close()
      await new Promise((resolve) => setTimeout(resolve, 70))
      if (!close) await owner.request("hook_commit", { commit: result.commit })
    }
    expect(accepted).toEqual([false, false])
  })
  test("in-process claims enforce transient authorization", async () => {
    let broker: Broker | undefined
    const { broker: running, client } = await setup(async (_params, context) => {
      const inner = await context.connect()
      try {
        const claim = { handle: "hook", harness: "codex", process: "pid:12", session: "env:test", grant: `krt_${"0".repeat(64)}` }
        await expect(inner.hello({ transient: true, claim })).rejects.toMatchObject({ code: "unauthorized" })
        const direct = await RelayClient.connect(broker!.socket)
        try {
          await expect(direct.hello({ transient: true, claim })).rejects.toMatchObject({ code: "unauthorized" })
        } finally {
          direct.close()
        }
        expect(broker!.core.list().filter((endpoint) => endpoint.kind === "agent")).toHaveLength(0)
      } finally {
        inner.close()
      }
      return { exit: 0 }
    })
    broker = running
    await (await client()).request("hook", params())
  })
})
