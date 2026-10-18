import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Envelope, RelayError, type StopWaitResult } from "@scp-dev/core"
import { RelayClient } from "./client"
import { type Broker, startBroker } from "./server"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const key = (pid: number) => `pid:${pid}:Fri-Oct-17-09:00:00-2026`

async function connect(broker: Broker, hello: Parameters<RelayClient["hello"]>[0]) {
  const client = await RelayClient.connect(broker.socket)
  cleanups.push(() => client.close())
  await client.hello(hello)
  return client
}

/** `main` with its hook connection, and a worker it spawned with a spawn grant bound to pid 1010 */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "relay-push-"))
  const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0 })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => broker.stop())
  const main = await connect(broker, { claim: { handle: "main", harness: "claude-code", session: "s1", process: key(1), lineage: [key(1)] } })
  const hook = await connect(broker, { transient: true, claim: { harness: "claude-code", session: "s1", process: key(1), lineage: [key(1)] } })
  const { token } = await main.grant({ name: "w1", bind_process: key(1010), ttl_s: 3600, spawn: true })
  const worker = await connect(broker, { claim: { handle: "codex", harness: "codex", process: key(10), lineage: [key(10), key(1010), key(1)] } })
  return { broker, main, hook, worker, token }
}

describe("broker, stop_wait", () => {
  test("waits while a worker runs, and returns as its message arrives", async () => {
    const { hook, worker } = await setup()
    const started = Date.now()
    const waiting = hook.stopWait(10)
    await Bun.sleep(150)
    await worker.request("send", { to: "main", body: "done-42" })
    const result = await waiting
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.messages.map((m) => [m.body.text, m.relation])).toEqual([["done-42", "child"]])
    expect(result.workers).toEqual(["me/w1"])
    expect(result.hold).not.toBeNull()
  })

  test("returns when the last worker exits, at the deadline while one still runs, and at once with none", async () => {
    const { main, hook, token } = await setup()
    const timed = Date.now()
    expect(await hook.stopWait(0.3)).toMatchObject({ messages: [], workers: ["me/w1"] })
    expect(Date.now() - timed).toBeGreaterThanOrEqual(250)
    const started = Date.now()
    const waiting = hook.stopWait(10)
    await Bun.sleep(100)
    await main.spawnExit({ grant: token, code: 0 })
    const exited = await waiting
    expect(exited).toMatchObject({ workers: [], starting: 0 })
    expect(exited.messages.map((m) => m.body.text)).toEqual(["worker me/w1 exited without replying (exit 0)"])
    expect(Date.now() - started).toBeLessThan(2500)
    const quick = Date.now()
    expect(await hook.stopWait(10)).toMatchObject({ workers: [] })
    expect(Date.now() - quick).toBeLessThan(500)
  })

  test("a worker's message brings the other unread ones along, except one a tool hook holds, which it counts", async () => {
    const { broker, hook, worker } = await setup()
    const lead = await connect(broker, { claim: { handle: "lead", harness: "codex", process: key(30), lineage: [key(30)] } })
    await lead.request("send", { to: "main", body: "first from lead" })
    const tool = await hook.request<{ messages: Envelope[]; offered: number[] }>("inject", {})
    expect(tool.messages.map((m) => m.body.text)).toEqual(["first from lead"])
    await lead.request("send", { to: "main", body: "second from lead" })
    const waiting = hook.stopWait(10)
    await Bun.sleep(100)
    await worker.request("send", { to: "main", body: "done-42" })
    const result = await waiting
    expect(result.messages.map((m) => [m.from.address, m.body.text])).toEqual([
      ["me/w1", "done-42"],
      ["me/lead", "second from lead"],
    ])
    expect(result).toMatchObject({ others: 1, others_shown: 1 })
    expect(await hook.request("inject", {})).toMatchObject({ messages: [] })
  })

  test("a sender cannot set a relation", async () => {
    const { worker } = await setup()
    const refused = await worker.request("send", { to: "main", body: "x", relation: "parent" }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(RelayError)
    expect((refused as RelayError).code).toBe("invalid_params")
  })

  test("only stop_wait from a hook of the endpoint's own process sees its workers", async () => {
    const { broker } = await setup()
    const stranger = await connect(broker, { transient: true, claim: { harness: "claude-code", session: "s1", process: key(77), lineage: [key(77)] } })
    expect(await stranger.request<StopWaitResult>("stop_wait", { wait_s: 5 })).toMatchObject({ workers: [], messages: [] })
  })

  test("a prompt from the endpoint's hook ends a waiting stop and resets the push budget; a printed push counts toward it", async () => {
    const { hook, worker } = await setup()
    const mark = (await hook.request<{ prompts?: number }>("inject", { stop: true })).prompts!
    const started = Date.now()
    const waiting = hook.stopWait(10, mark)
    await Bun.sleep(150)
    expect(await hook.request<{ prompted: boolean }>("prompted", {})).toEqual({ prompted: true })
    expect(await waiting).toMatchObject({ prompted: true, messages: [] })
    expect(Date.now() - started).toBeLessThan(2000)
    await worker.request("send", { to: "main", body: "done-42" })
    const pushed = await hook.stopWait(0)
    expect(pushed.pushes_left).toBe(20)
    expect(await hook.request("injected", { seqs: pushed.offered, hold: pushed.hold, read: pushed.offered, push: true })).toMatchObject({ pushed: true })
    expect((await hook.stopWait(0)).pushes_left).toBe(19)
  })

  test("a no_push worker holds no stop: its message stays an ordinary unread one", async () => {
    const { broker, main, hook, token } = await setup()
    await main.spawnExit({ grant: token, code: 0 })
    const inbox = async () => {
      const { messages } = await main.request<{ messages: Envelope[] }>("inbox")
      await main.request("ack", { seqs: messages.map((m) => m.seq) })
      return messages
    }
    await inbox()
    await main.grant({ name: "bg", bind_process: key(1020), ttl_s: 3600, spawn: true, no_push: true })
    const bg = await connect(broker, { claim: { handle: "codex", harness: "codex", process: key(20), lineage: [key(20), key(1020), key(1)] } })
    await bg.request("send", { to: "main", body: "queued" })
    const started = Date.now()
    expect(await hook.stopWait(5)).toMatchObject({ messages: [], workers: [], starting: 0, others: 1 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect((await inbox()).map((m) => [m.from.address, m.body.text])).toEqual([["me/bg", "queued"]])
  })

  test("spawn_exit hands back once, wakes the issuer's wait and keeps the spawner to itself", async () => {
    const { main, hook, token } = await setup()
    const waiting = hook.stopWait(10)
    await Bun.sleep(100)
    const first = await main.spawnExit({ grant: token, code: 0, output: "done" })
    expect(first).not.toHaveProperty("spawner")
    expect((await waiting).messages.map((m) => m.body.text)).toEqual(["worker me/w1 finished (exit 0)\n\ndone"])
    expect((await main.spawnExit({ grant: token, code: 0, output: "done" })).handback).toBeNull()
  })

  test("a worker's hook gets its spawner as intro and a stop held for a late directive, and confirms each, the preamble too", async () => {
    const { broker, main } = await setup()
    await main.grant({ name: "w2", bind_process: key(1020), ttl_s: 3600, spawn: true })
    await connect(broker, { claim: { handle: "codex", harness: "codex", session: "s2", process: key(20), lineage: [key(20), key(1020), key(1)] } })
    const hook = await connect(broker, { transient: true, claim: { harness: "codex", session: "s2", process: key(20), lineage: [key(20), key(1020), key(1)] } })
    expect(await hook.request("inject", {})).toMatchObject({ intro: "me/main" })
    expect(await hook.request<unknown>("injected", { seqs: [], intro: true, preamble: true })).toEqual({ injected: 0, briefed: true, introduced: true })
    expect(await hook.request("inject", {})).not.toHaveProperty("intro")
    await main.request("send", { to: "w2", body: "echo PINEAPPLE" })
    const stop = await hook.request<{ block: boolean; brief?: true; offered: number[]; hold: string; directive_seqs: number[] }>("inject", {
      stop: true,
      directives: true,
    })
    expect(stop).toMatchObject({ block: true, brief: true, directives: [{ body: { text: "echo PINEAPPLE" }, relation: "parent" }] })
    expect(await hook.request<unknown>("injected", { seqs: stop.offered, hold: stop.hold, read: stop.offered, restated: stop.directive_seqs })).toEqual({
      injected: 1,
      restated: 1,
    })
    expect(await hook.request("inject", { stop: true, directives: true })).toMatchObject({ block: false })
  })
})

describe("broker, a steer before the spawn joins", () => {
  test("is accepted as starting while its swarm spawn process runs, and in the worker's inbox once it joins", async () => {
    const { broker, main } = await setup()
    await main.grant({ name: "w3", bind_process: key(process.pid), ttl_s: 3600, spawn: true })
    const sent = await main.request<{ deliveries: { address: string; state?: string }[] }>("send", { to: "w3", body: "steer-early" })
    expect(sent.deliveries).toEqual([expect.objectContaining({ address: "me/w3", state: "starting" })])
    const worker = await connect(broker, { claim: { handle: "codex", harness: "codex", process: key(30), lineage: [key(30), key(process.pid), key(1)] } })
    const { messages } = await worker.request<{ messages: Envelope[] }>("inbox")
    expect(messages.map((m) => [m.body.text, m.relation])).toEqual([["steer-early", "parent"]])
  })
})
