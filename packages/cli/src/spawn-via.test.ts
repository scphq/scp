import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LIMITS, RelayError } from "@scp-dev/core"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { type FakeHubServer, startFakeHubServer } from "@scp-dev/broker/testing"
import { processKey } from "./identity"
import { linkedHandbackBody, parseRunners, runnerFor, runnerReply, runRunner, spawnRequest, viaStarted } from "./remote-spawn"
import { RelayUsage } from "./common"

setDefaultTimeout(60_000)

const entry = join(import.meta.dir, "cli.ts")
const RUNNER = join(import.meta.dir, "testing", "local-ssh-runner.ts")
const TOKEN = `scp_t_test${"v".repeat(32)}`

type Listed = { endpoints: { address: string; parent?: string | null; status?: { state: string; note: string | null } }[] }
type Inbox = { messages: { seq: number; from: { address: string }; body: { text: string } }[] }

async function swarm(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

async function until<T>(check: () => Promise<T | undefined>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function usage(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof RelayUsage) return error.message
    throw error
  }
  throw new Error("no usage error")
}

describe("runner config", () => {
  test("maps valid names to a command and a timeout, 60 s by default", () => {
    expect(parseRunners(JSON.stringify({ "vm-1": { command: ["ssh", "vm"] }, b: { command: ["x"], timeout_s: 5 } }), "r.json")).toEqual({
      "vm-1": { command: ["ssh", "vm"], timeout_s: 60 },
      b: { command: ["x"], timeout_s: 5 },
    })
    expect(usage(() => parseRunners("{", "r.json"))).toBe("r.json is not JSON")
    expect(usage(() => parseRunners(JSON.stringify({ "Bad Name": { command: ["x"] } }), "r.json"))).toContain("not a valid name")
    expect(usage(() => parseRunners(JSON.stringify({ a: { command: [] } }), "r.json"))).toContain("non-empty list of words")
    expect(usage(() => parseRunners(JSON.stringify({ a: { command: ["x"], timeout_s: 0 } }), "r.json"))).toContain("timeout_s")
  })

  test("stop and status argv and bounded status timeout are optional and validated", () => {
    expect(
      parseRunners(JSON.stringify({ vm: { command: ["start"], stop: ["stop", "fixed"], status: ["status"], status_timeout_s: 60 } }), "r.json").vm,
    ).toEqual({ command: ["start"], timeout_s: 60, stop: ["stop", "fixed"], status: ["status"], status_timeout_s: 60 })
    for (const key of ["stop", "status"])
      for (const value of [null, "sh", [], [""], [1]])
        expect(usage(() => parseRunners(JSON.stringify({ vm: { command: ["start"], [key]: value } }), "r.json"))).toContain(key)
    for (const value of [null, 0, 61, 1.5, "5", false])
      expect(usage(() => parseRunners(JSON.stringify({ vm: { command: ["start"], status_timeout_s: value } }), "r.json"))).toContain("status_timeout_s")
  })

  test("an unknown runner is a usage error naming the configured ones", () => {
    const runners = parseRunners(JSON.stringify({ a: { command: ["x"] }, b: { command: ["y"] } }), "r.json")
    expect(usage(() => runnerFor("c", runners, "r.json"))).toBe('no runner "c" in r.json: configured: a, b')
    expect(usage(() => runnerFor("c", {}, "r.json"))).toBe('no runner "c" in r.json: none is configured')
    expect(usage(() => runnerFor("constructor", {}, "r.json"))).toContain("none is configured")
  })

  test("the request carries the spawn, its parent and the join, and nothing secret", async () => {
    const request = spawnRequest({ name: "w1", title: null, command: ["codex", "exec", "go"], cwd: "/w", parent: "me/laptop/lead", labels: { role: "impl" } })
    expect(request).toEqual({
      scp: 1,
      event: "spawn",
      name: "w1",
      title: null,
      cmd: ["codex", "exec", "go"],
      cwd: "/w",
      parent: "me/laptop/lead",
      labels: { role: "impl" },
      join: { under: "me/laptop/lead", name: "w1", mode: "account" },
    })
    const root = mkdtempSync(join(tmpdir(), "runner-stdin-"))
    const out = join(root, "stdin.json")
    const ran = await runRunner(
      { command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(out)}, require("fs").readFileSync(0))`], timeout_s: 10 },
      { ...request, cwd: root },
      { PATH: process.env.PATH!, SECRET_ENV: "x" },
    )
    expect(ran).toEqual({ code: 0, timedOut: false, stdout: "", stderr: "" })
    const line = await Bun.file(out).text()
    expect(line.endsWith("\n")).toBe(true)
    expect(Object.keys(JSON.parse(line)).sort()).toEqual(["cmd", "cwd", "event", "join", "labels", "name", "parent", "scp", "title"])
    expect(line).not.toContain("krt_")
    expect(line).not.toContain("SECRET_ENV")
    rmSync(root, { recursive: true, force: true })
  })

  test("a failing runner's exit code and stderr tail come back, a slow one times out with 124", async () => {
    const request = spawnRequest({ name: "w", title: null, command: ["x"], cwd: process.cwd(), parent: "me/a/lead", labels: {} })
    const env = { PATH: process.env.PATH! }
    expect(await runRunner({ command: [process.execPath, "-e", "console.error('no route to host'); process.exit(3)"], timeout_s: 10 }, request, env)).toEqual({
      code: 3,
      timedOut: false,
      stdout: "",
      stderr: "no route to host",
    })
    expect((await runRunner({ command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], timeout_s: 1 }, request, env)).code).toBe(124)
    expect((await runRunner({ command: ["no-such-runner-command"], timeout_s: 1 }, request, env)).code).toBe(127)
  })

  test("a runner's stdout reply names the worker's address and machine, and anything else is ignored", () => {
    expect(runnerReply('{"address":"me/vm/w1","machine":"vm","ref":"i-0abc"}\n', "w1")).toEqual({ address: "me/vm/w1", machine: "vm", ref: "i-0abc" })
    expect(runnerReply('{"address":"me/vm/w1","machine":"vm"}', "w1")).toEqual({ address: "me/vm/w1", machine: "vm" })
    for (const stdout of [
      "",
      "started",
      '{"address":"me/vm/w2","machine":"vm"}',
      '{"address":"me/vm/w1","machine":"box"}',
      '{"address":"me/vm/w1","machine":"vm","ref":5}',
      '["me/vm/w1"]',
    ])
      expect(runnerReply(stdout, "w1")).toBeUndefined()
  })

  test("a reply's attach is one line of at most 1024 characters, dropped when it looks like a credential, and printed", () => {
    const attach = "ssh vm-3 -t tmux attach -t w1"
    const reply = runnerReply(JSON.stringify({ address: "me/vm/w1", machine: "vm", attach }), "w1")
    expect(reply).toEqual({ address: "me/vm/w1", machine: "vm", attach })
    for (const bad of [5, "", "a\nb", "a\u001bb", "x".repeat(1025)])
      expect(runnerReply(JSON.stringify({ address: "me/vm/w1", machine: "vm", attach: bad }), "w1")).toBeUndefined()
    expect(runnerReply(JSON.stringify({ address: "me/vm/w1", machine: "vm", attach: `ssh vm --token ${TOKEN}` }), "w1")).toEqual({
      address: "me/vm/w1",
      machine: "vm",
    })
    const base = { name: "w1", runner: "vm", parent: "me/laptop/lead", reply }
    expect(viaStarted({ ...base, json: false })).toEqual([
      "w1 handed to runner vm: it starts on machine vm and shows under you as me/vm/w1; its result arrives as a relay message by itself",
      `attach: ${attach}`,
    ])
    expect(JSON.parse(viaStarted({ ...base, json: true })[0]!)).toEqual({ ...base.reply, name: "w1", runner: "vm", parent: "me/laptop/lead" })
    expect(viaStarted({ ...base, reply: undefined, json: false })).toHaveLength(1)
  })

  test("a linked worker's handback follows the spawn handback's wording", () => {
    expect(linkedHandbackBody("me/vm/w1", 0, "done", "")).toBe("worker me/vm/w1 finished (exit 0)\n\ndone")
    expect(linkedHandbackBody("me/vm/w1", 0, "", "noise")).toBe("worker me/vm/w1 exited without replying (exit 0)")
    expect(linkedHandbackBody("me/vm/w1", 2, "out", "boom")).toBe(
      `worker me/vm/w1 finished (exit 2)\n\nout\n\nstderr (last ${LIMITS.stderrBytes / 1024} KB):\nboom`,
    )
  })
})

describe("swarm spawn --via", () => {
  let fake: FakeHubServer
  let laptop: Broker
  let vm: Broker
  let lead: RelayClient
  const root = mkdtempSync(join(tmpdir(), "spawn-via-"))
  const laptopDir = join(root, "laptop")
  const vmDir = join(root, "vm")
  const runners = join(root, "runners.json")
  const harness = join(root, "harness.ts")

  async function machine(dir: string, name: string): Promise<Broker> {
    mkdirSync(dir, { recursive: true })
    const broker = await startBroker({
      dir,
      policyPath: join(root, `${name}-policy.json`),
      runnersPath: runners,
      idleMs: 0,
      log: () => {},
      bridge: { url: fake.url, token: TOKEN, machine: name, backoff: { minMs: 20, maxMs: 100 }, localFlushMs: 20 },
    })
    await until(async () => broker.bridge!.status().connected, `${name}'s bridge`)
    return broker
  }

  beforeAll(async () => {
    fake = startFakeHubServer({ tokens: { [TOKEN]: { tokenId: "tok_via", user: "ada" } } })
    laptop = await machine(laptopDir, "laptop")
    vm = await machine(vmDir, "vm")
    writeFileSync(harness, `console.log("hello from " + process.env.SCP_NAME + " under " + process.env.SCP_UNDER)\n`)
    writeFileSync(
      runners,
      JSON.stringify({
        "local-ssh-like": { command: [process.execPath, "--no-env-file", RUNNER, "--dir", vmDir, "--machine", "vm"], timeout_s: 30 },
        broken: { command: [process.execPath, "-e", "console.error('vm unreachable'); process.exit(255)"] },
      }),
    )
    lead = await RelayClient.connect(laptop.socket)
    await lead.hello({ claim: { handle: "lead", harness: "claude-code", process: processKey(process.pid), lineage: [processKey(process.pid)] } })
    const observer = await RelayClient.connect(vm.socket)
    await observer.hello({ observe: true })
    await until(async () => (await observer.request<Listed>("list", { all: true })).endpoints.some((e) => e.address === "me/laptop/lead"), "laptop/lead on vm")
    observer.close()
  })

  afterAll(async () => {
    lead.close()
    await vm.stop()
    await laptop.stop()
    await fake.stop()
    rmSync(root, { recursive: true, force: true })
  })

  test("starts the worker on the other machine, where it shows under its spawner and hands its output back", async () => {
    const env = { SCP_DIR: laptopDir, SCP_RUNNERS_FILE: runners }
    const spawned = await swarm(["spawn", "--via", "local-ssh-like", "--name", "w1", "--", process.execPath, "--no-env-file", harness], env)
    expect(spawned.stderr).toBe("")
    expect(spawned.code).toBe(0)
    expect(spawned.stdout).toStartWith("w1 handed to runner local-ssh-like: it starts on machine vm and shows under you as me/vm/w1;")

    const handback = await until(
      async () => (await lead.request<Inbox>("inbox", { wait_s: 1 })).messages.find((m) => m.from.address === "me/vm/w1"),
      "the handback",
    )
    expect(handback.body.text).toBe("worker me/vm/w1 finished (exit 0)\n\nhello from w1 under me/laptop/lead")
    const shown = await until(
      async () => (await lead.request<Listed>("list", { all: true })).endpoints.find((e) => e.address === "me/vm/w1" && e.status?.state === "done"),
      "vm/w1 done on laptop",
    )
    expect(laptop.core.viaRecords().find((r) => r.name === "w1")).toMatchObject({ runner: "local-ssh-like", address: "me/vm/w1" })
    expect(shown.parent).toBe("me/lead")
    expect(shown.status?.note).toBe("exited 0")

    const asJson = await swarm(["spawn", "--via", "local-ssh-like", "--name", "w2", "--json", "--", process.execPath, "--no-env-file", harness], env)
    expect(JSON.parse(asJson.stdout)).toEqual({ name: "w2", runner: "local-ssh-like", parent: "me/laptop/lead", address: "me/vm/w2", machine: "vm" })
    await until(async () => (await lead.request<Inbox>("inbox", { wait_s: 1 })).messages.find((m) => m.from.address === "me/vm/w2"), "w2's handback")
  })

  test("list and peek show runner metadata; end prints each outcome and fails only on failure or timeout", async () => {
    const env = { SCP_DIR: laptopDir }
    const stopLog = join(root, "stopped.json")
    const fake = (code: number, timeout = false) => ({
      command: ["true"],
      timeout_s: 1,
      stop: [
        process.execPath,
        "-e",
        timeout ? "setInterval(()=>{},1000)" : `await Bun.write(${JSON.stringify(stopLog)}, await Bun.stdin.text()); process.exit(${code})`,
      ],
      status: [process.execPath, "-e", 'console.log(JSON.stringify({state:"running",attach:"ssh vm updated"}))'],
    })
    const original = await Bun.file(runners).text()
    try {
      writeFileSync(runners, JSON.stringify({ vm: fake(0) }))
      laptop.core.mirror("vm", [{ address: "me/lifecycle", kind: "agent", harness: "cli", labels: {}, presence: "online", parent_addr: "laptop/lead" }])
      await lead.request("spawn_via", { name: "lifecycle", runner: "vm", address: "me/vm/lifecycle", machine: "vm", attach: "ssh vm" })
      const listed = await swarm(["list", "--json", "--all"], env)
      expect(listed.code).toBe(0)
      expect(JSON.parse(listed.stdout).endpoints.find((e: { address: string }) => e.address === "me/vm/lifecycle").runner).toMatchObject({
        name: "vm",
        attach: "ssh vm updated",
        status: { state: "running" },
      })
      expect((await swarm(["list", "--all"], env)).stdout).toContain("vm  attach: ssh vm updated")
      expect((await swarm(["list", "--all", "--tree"], env)).stdout).toContain("attach: ssh vm updated")
      expect((await swarm(["peek", "me/vm/lifecycle"], env)).stdout).toContain("attach: ssh vm updated")
      for (const [code, stop, exit] of [
        [0, "stopped", 0],
        [77, "declined", 0],
        [2, "failed", 1],
      ] as const) {
        writeFileSync(runners, JSON.stringify({ vm: fake(code) }))
        const ended = await swarm(["end", "me/vm/lifecycle"], env)
        expect(ended.code).toBe(exit)
        expect(ended.stdout).toBe(`me/vm/lifecycle runner vm: ${stop} (exit ${code})\n`)
      }
      expect(JSON.parse(await Bun.file(stopLog).text())).toMatchObject({ event: "stop", name: "lifecycle" })
      writeFileSync(runners, JSON.stringify({ vm: fake(0, true) }))
      const timeout = await swarm(["end", "lifecycle"], env)
      expect(timeout.code).toBe(1)
      expect(timeout.stdout).toContain("runner vm: timeout (exit 124)")
      writeFileSync(runners, JSON.stringify({ vm: { command: ["true"] } }))
      expect((await swarm(["end", "lifecycle"], env)).stdout).toContain("runner vm: none")
      expect((await swarm(["end", "lifecycle", "--json"], env)).code).toBe(0)
    } finally {
      writeFileSync(runners, original)
    }
  })

  test("a successful runner still succeeds when the broker cannot record it", async () => {
    const original = await Bun.file(runners).text()
    const failed = spyOn(laptop.core, "spawnVia").mockImplementation(() => {
      throw new RelayError("method_not_found", "spawn_via is unavailable")
    })
    try {
      writeFileSync(
        runners,
        JSON.stringify({ vm: { command: [process.execPath, "-e", `console.log('{"address":"me/vm/w","machine":"vm","attach":"ssh vm"}')`] } }),
      )
      for (const flags of [[], ["--json"]]) {
        const result = await swarm(["spawn", "--via", "vm", "--name", "w", ...flags, "--", "echo", "hi"], {
          SCP_DIR: laptopDir,
          SCP_RUNNERS_FILE: runners,
        })
        expect(result.code).toBe(0)
        expect(result.stderr).toBe("w started, but the broker did not record it: swarm end cannot stop it through the runner (spawn_via is unavailable)\n")
        if (flags.length) expect(JSON.parse(result.stdout)).toMatchObject({ name: "w", runner: "vm", attach: "ssh vm" })
        else {
          expect(result.stdout).toStartWith("w handed to runner vm:")
          expect(result.stdout).toContain("attach: ssh vm")
        }
      }
    } finally {
      failed.mockRestore()
      writeFileSync(runners, original)
    }
  })

  test("a failed runner fails the spawn with its exit code and stderr; an unknown one names those configured", async () => {
    const env = { SCP_DIR: laptopDir, SCP_RUNNERS_FILE: runners }
    const broken = await swarm(["spawn", "--via", "broken", "--", "echo", "hi"], env)
    expect(broken.code).toBe(255)
    expect(broken.stderr).toContain("runner broken failed (exit 255):\nvm unreachable")
    const unknown = await swarm(["spawn", "--via", "nope", "--", "echo", "hi"], env)
    expect(unknown.code).not.toBe(0)
    expect(unknown.stderr).toContain('no runner "nope"')
    expect(unknown.stderr).toContain("configured: local-ssh-like, broken")
    const granted = await swarm(["spawn", "--via", "broken", "--scope", "open", "--", "echo", "hi"], env)
    expect(granted.stderr).toContain("not --scope")
    expect((await swarm(["spawn", "--json", "--", "echo", "hi"], env)).stderr).toContain("spawn does not take --json")
  })

  test("--via needs a broker linked to a hub, and a remote --under refuses grant flags", async () => {
    const local = join(root, "local")
    const solo = await startBroker({ dir: local, policyPath: join(root, "solo-policy.json"), idleMs: 0, log: () => {} })
    try {
      const refused = await swarm(["spawn", "--via", "broken", "--as", "solo", "--", "echo", "hi"], { SCP_DIR: local, SCP_RUNNERS_FILE: runners })
      expect(refused.stderr).toContain("not linked to a hub")
    } finally {
      await solo.stop()
    }
    const scoped = await swarm(["spawn", "--fg", "--under", "me/laptop/lead", "--scope", "open", "--", "echo", "hi"], { SCP_DIR: vmDir })
    expect(scoped.stderr).toContain("runs without a grant: --scope does not apply")
  })
})
