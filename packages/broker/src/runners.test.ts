import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EndpointView, ScopeActor, ViaRecord } from "@scp-dev/core"
import { RelayClient } from "./client"
import { accountHome } from "./paths"
import { runnerEnvironment, runnerInput, runnerService, statusReply } from "./runners"
import { runRunner } from "./runner-exec"
import { startBroker } from "./server"

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scp-via-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "runners.json")
  const broker = await startBroker({
    dir: join(root, "state"),
    policyPath: join(root, "policy.json"),
    runnersPath: path,
    machine: "laptop",
    idleMs: 0,
    builtinWakers: {},
  })
  cleanup.push(() => broker.stop())
  async function connect(handle: string) {
    const client = await RelayClient.connect(broker.socket)
    cleanup.push(() => client.close())
    const { endpoint } = await client.hello({ claim: { handle, harness: "cli", session: handle } })
    return { client, endpoint: endpoint!, actor: { kind: "endpoint", id: endpoint!.id, auth: "session" } as ScopeActor }
  }
  const lead = await connect("lead"),
    other = await connect("other")
  const record = (name = "w", extra: object = {}) =>
    broker.core.spawnVia(lead.endpoint.id, { name, runner: "vm", address: `me/vm/${name}`, machine: "vm", ref: "job-1", attach: "ssh vm", ...extra })
  const mirror = (name = "w", parent = "laptop/lead") =>
    broker.core.mirror("vm", [{ address: `me/${name}`, kind: "agent", harness: "cli", labels: {}, presence: "online", parent_addr: parent }])
  const config = (extra: object) => writeFileSync(path, JSON.stringify({ vm: { command: ["true"], timeout_s: 1, status_timeout_s: 1, ...extra } }))
  return { root, path, broker, lead, other, connect, record, mirror, config }
}
const command = (code: string) => [process.execPath, "--no-env-file", "-e", code]

test("via validation, replacement, secret drops, views and parent authority", async () => {
  const f = await fixture()
  expect(() => f.record("w", { address: "me/vm/wrong" })).toThrow("invalid runner reply")
  expect(() => f.record("w", { machine: "wrong" })).toThrow("invalid runner reply")
  expect(() => f.record("w", { ref: "a b" })).toThrow("invalid runner reply")
  expect(() => f.record("w", { attach: "a\nb" })).toThrow("invalid runner reply")
  f.record("w", { attach: `ssh vm --token scp_t_test${"v".repeat(32)}` })
  expect(f.broker.core.viaRecords()[0]!.attach).toBeNull()
  f.record()
  f.mirror()
  const views = (await f.lead.client.request<{ endpoints: EndpointView[] }>("list")).endpoints
  expect(views.find((v) => v.address === "me/vm/w")?.runner).toEqual({ name: "vm", ref: "job-1", attach: "ssh vm" })
  expect(f.broker.core.viaRecords()).toHaveLength(1)
  for (const endpoint of ["me/vm/w", "w", "me/w"]) {
    await expect(f.other.client.request("spawn_end", { endpoint })).rejects.toMatchObject({ code: "not_found" })
  }
  f.mirror("w", "laptop/other")
  await expect(f.lead.client.request("spawn_end", { endpoint: "me/vm/w" })).rejects.toMatchObject({ code: "unauthorized" })
  expect(f.broker.core.viaRecords()[0]!.ended_at).toBeNull()
  f.mirror()
  expect(await f.lead.client.request("spawn_end", { endpoint: "me/vm/w" })).toMatchObject({ held: false, runner: { name: "vm", stop: "none" } })
  expect(f.broker.core.viaRecords()[0]!.ended_at).toBeNumber()
  const peek = await f.lead.client.request<{ runner: unknown }>("peek", { endpoint: "me/vm/w" })
  expect(peek.runner).toMatchObject({ attach: "ssh vm" })
  expect(f.broker.core.endVia({ kind: "human", tty: true }, { endpoint: "me/vm/w" })).toBeDefined()
  expect(() => f.broker.core.endVia({ kind: "human", tty: false }, { endpoint: "me/vm/w" })).toThrow("only the spawner")
  f.record("unaddressed", { address: undefined, machine: undefined })
  f.mirror("unaddressed", "laptop/other")
  await expect(f.lead.client.request("spawn_end", { endpoint: "unaddressed" })).rejects.toMatchObject({ code: "unauthorized" })
  f.record("unjoined", { address: undefined, machine: undefined })
  expect(await f.lead.client.request("spawn_end", { endpoint: "unjoined" })).toEqual({ held: false, runner: { name: "vm", stop: "none" } })
})

test("an ancestor of the spawner can end its worker", async () => {
  const f = await fixture()
  const grant = f.broker.core.grant(f.other.actor, { name: "child" })
  const child = f.broker.core.claim({ handle: "child", harness: "cli", session: "child", grant: grant.token }).endpoint
  f.broker.core.spawnVia(child.id, { name: "w", runner: "vm" })
  expect(f.broker.core.endVia(f.other.actor, { endpoint: "w" })).toBeDefined()
})

test("stop verbs receive exact stdin, use home and return stopped, declined, failed, timeout and none", async () => {
  const f = await fixture()
  const log = join(f.root, "stop.json")
  f.record()
  f.config({
    stop: command(
      `const input = await Bun.stdin.text(); await Bun.write(${JSON.stringify(log)}, JSON.stringify({input, argv:process.argv.slice(2), cwd:process.cwd()}))`,
    ),
  })
  expect(await f.lead.client.request("spawn_end", { endpoint: "w" })).toMatchObject({ held: false, runner: { stop: "stopped", code: 0 } })
  const ran = JSON.parse(readFileSync(log, "utf8"))
  expect(ran.argv).toEqual([])
  expect(ran.cwd).toBe(accountHome())
  expect(ran.input).toBe(
    `${JSON.stringify({ scp: 1, event: "stop", name: "w", runner: "vm", parent: "me/laptop/lead", address: "me/vm/w", machine: "vm", ref: "job-1" })}\n`,
  )
  for (const [exit, stop] of [
    [77, "declined"],
    [2, "failed"],
  ] as const) {
    f.config({ stop: command(`console.error("reason");process.exit(${exit})`) })
    expect(await f.lead.client.request("spawn_end", { endpoint: "w" })).toMatchObject({ runner: { stop, code: exit, stderr: "reason" } })
  }
  f.config({ stop: command("setInterval(()=>{},1000)") })
  expect(await f.lead.client.request("spawn_end", { endpoint: "w" })).toMatchObject({ runner: { stop: "timeout", code: 124 } })
  f.config({})
  expect(await f.lead.client.request("spawn_end", { endpoint: "w" })).toMatchObject({ runner: { stop: "none" } })
})

test("invalid runners files report stop failures and status errors", async () => {
  const f = await fixture()
  f.record()
  f.mirror()
  for (const [text, message] of [
    ["{", `${f.path} is not JSON`],
    [JSON.stringify({ vm: { command: [] } }), `${f.path}: runner vm needs command, a non-empty list of words`],
  ] as const) {
    writeFileSync(f.path, text)
    expect(await f.lead.client.request("peek", { endpoint: "me/vm/w" })).toMatchObject({
      runner: { status: { state: "error", detail: "invalid runners file", at: expect.any(String) } },
    })
    expect(await f.lead.client.request("spawn_end", { endpoint: "w" })).toMatchObject({
      held: false,
      runner: { name: "vm", stop: "failed", stderr: message },
    })
    f.record()
  }
})

test("status runs in parallel, caches concurrent lists and peek, refreshes replacements and does not run after end", async () => {
  const f = await fixture()
  const log = join(f.root, "status.log")
  f.record()
  f.mirror()
  f.record("w2")
  f.mirror("w2")
  f.config({
    status: command(
      `require("fs").appendFileSync(${JSON.stringify(log)},"run\\n"); await Bun.sleep(100); console.log(JSON.stringify({state:"running",detail:"ready",attach:"ssh updated"}))`,
    ),
  })
  const list = () => f.lead.client.request<{ endpoints: EndpointView[] }>("list")
  const results = await Promise.all([list(), list()])
  expect(results[0]!.endpoints.find((v) => v.address === "me/vm/w")?.runner).toMatchObject({
    attach: "ssh updated",
    status: { state: "running", detail: "ready", at: expect.any(String) },
  })
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2)
  expect(await f.lead.client.request("peek", { endpoint: "me/vm/w" })).toMatchObject({ runner: { attach: "ssh updated", status: { state: "running" } } })
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2)
  f.record()
  await list()
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3)
  await f.lead.client.request("spawn_end", { endpoint: "w" })
  f.record("w3")
  f.mirror("w3")
  f.record("w4")
  f.mirror("w4")
  f.config({ status: command("setInterval(()=>{},1000)") })
  // A new service starts with an empty cache.
  const service = runnerService(f.broker.core, f.path)
  const start = Date.now()
  const timed = await service.enrich(f.broker.core.list({ all: true }))
  expect(Date.now() - start).toBeLessThan(1300)
  expect(timed.find((v) => v.address === "me/vm/w2")?.runner?.status).toMatchObject({ state: "error", detail: "timeout" })
  expect(timed.find((v) => v.address === "me/vm/w")?.runner?.status).toBeUndefined()
})

test("status cache lasts 15 seconds after completion and shares slow runs", async () => {
  const f = await fixture()
  f.record()
  f.mirror()
  const log = join(f.root, "calls")
  f.config({ status: command(`require("fs").appendFileSync(${JSON.stringify(log)},"x"); await Bun.sleep(150); console.log('{"state":"running"}')`) })
  let now = Date.now()
  const service = runnerService(f.broker.core, f.path, () => now)
  const list = () => service.enrich(f.broker.core.list({ all: true }))
  const first = list()
  now += 16_000
  await Promise.all([first, list()])
  expect(readFileSync(log, "utf8")).toBe("x")
  now += 14_999
  await list()
  expect(readFileSync(log, "utf8")).toBe("x")
  now += 1
  await list()
  expect(readFileSync(log, "utf8")).toBe("xx")
})

test("status replies reject malformed fields and scrub secrets", () => {
  for (const value of [
    null,
    [],
    {},
    { state: "Running" },
    { state: "x".repeat(33) },
    { state: "ok", detail: "a\nb" },
    { state: "ok", detail: "x".repeat(201) },
    { state: "ok", attach: "a\nb" },
  ])
    expect(statusReply(JSON.stringify(value))).toEqual({ state: "unknown" })
  expect(statusReply('{"state":"starting","detail":"booting","attach":"ssh vm"}')).toEqual({ state: "starting", detail: "booting", attach: "ssh vm" })
  expect(statusReply(JSON.stringify({ state: "ok", attach: `scp_t_test${"v".repeat(32)}` }))).toEqual({ state: "ok" })
})

test("status exits map to unknown or error", async () => {
  const f = await fixture()
  f.record()
  f.mirror()
  for (const [code, status] of [
    [77, { state: "unknown" }],
    [3, { state: "error", detail: "exit 3" }],
  ] as const) {
    f.config({ status: command(`process.exit(${code})`) })
    const views = await runnerService(f.broker.core, f.path).enrich(f.broker.core.list({ all: true }))
    expect(views.find((v) => v.address === "me/vm/w")?.runner?.status).toMatchObject(status)
  }
})

test("argv stays configured, identity env is scrubbed, and timeout kills the whole process group", async () => {
  const f = await fixture()
  const record = {
    ...f.broker.core.viaRecords()[0],
    name: "w;$(touch injected)",
    runner: "vm",
    spawner: f.lead.endpoint.id,
    address: null,
    machine: null,
    ref: null,
  } as ViaRecord
  const result = await runRunner(
    { command: command("console.log(JSON.stringify({argv:process.argv.slice(2),input:await Bun.stdin.json()}))"), timeout_s: 1 },
    runnerInput(f.broker.core, record, "status"),
    {},
    f.root,
  )
  expect(JSON.parse(result.stdout)).toEqual({ argv: [], input: { scp: 1, event: "status", name: record.name, runner: "vm", parent: "me/laptop/lead" } })
  expect(runnerEnvironment({ PATH: "/bin", SCP_NAME: "lead", SCP_HARNESS_PID: "42", SCP_GRANT: "secret", SCP_WAKE_TICKET: "ticket" })).toEqual({ PATH: "/bin" })
  const pidfile = join(f.root, "pid")
  const ran = await runRunner({ command: ["sh", "-c", `trap '' TERM; sleep 60 & echo $! > '${pidfile}'; wait`], timeout_s: 1 }, {}, {}, f.root, "SIGKILL")
  expect(ran).toMatchObject({ code: 124, timedOut: true })
  const pid = Number(readFileSync(pidfile, "utf8").trim())
  await Bun.sleep(50)
  expect(() => process.kill(pid, 0)).toThrow()
})
