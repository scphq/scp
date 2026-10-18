import { Readable } from "node:stream"
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { runHook } from "./hooks"
import { harnessLineage } from "./identity"
import { joinMode, setJoinMode } from "./relay"
import { parseSetupArgs } from "./setup"

setDefaultTimeout(30_000)

const entry = join(import.meta.dir, "cli.ts")
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_THREAD_ID|SCP_)/

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) env[key] = value
  return { ...env, ...extra }
}

describe("join mode", () => {
  test("setup --join takes auto or manual, saved in the config next to the relay; auto when unset", () => {
    expect(parseSetupArgs(["--join", "manual"])).toEqual({ join: "manual" })
    expect(() => parseSetupArgs(["--join", "later"])).toThrow("--join takes auto or manual")
    const env = { HOME: mkdtempSync(join(process.env.HOME!, "join-mode-")) }
    expect(joinMode(env)).toBe("auto")
    setJoinMode(env, "manual")
    expect(joinMode(env)).toBe("manual")
  })
})

describe("swarm join, leave and name, from a session's shell", () => {
  let broker: Broker
  let peer: RelayClient
  const root = mkdtempSync(join(process.env.HOME!, "join-"))
  const dir = join(root, "relay")
  const project = join(root, "lane")
  const key = harnessLineage(process.pid).at(-1)!
  const pid = Number(key.split(":")[1])
  const env = cleanEnv({ SCP_DIR: dir, XDG_CONFIG_HOME: join(root, "config"), CLAUDECODE: "1" })
  const addresses = (all = true) => broker.core.list({ all }).map((e) => e.address)

  async function swarm(...args: string[]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, cwd: project })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, code }
  }

  const hook = (event: string, extra: Record<string, unknown> = {}) =>
    runHook(["claude"], {
      env,
      cwd: project,
      stdin: Readable.from([JSON.stringify({ hook_event_name: event, cwd: project, ...extra })]),
      connect: () => RelayClient.connect(broker.socket),
      harnessPid: () => pid,
    })
  const tool = () => hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" } })

  beforeAll(async () => {
    mkdirSync(join(project, ".git"), { recursive: true })
    setJoinMode({ XDG_CONFIG_HOME: join(root, "config") }, "manual")
    broker = await startBroker({ dir, idleMs: 0, policyPath: join(root, "policy.json"), log: () => {} })
    peer = await RelayClient.connect(broker.socket)
    await peer.hello({ claim: { handle: "peer", harness: "codex" } })
  })
  afterAll(async () => {
    peer.close()
    await broker.stop()
  })

  test("manual mode: dark until join, listed and pushed to after it, offline with mail kept after leave, and back on join", async () => {
    expect(await hook("SessionStart", { source: "startup" })).toBeUndefined()
    expect(await tool()).toBeUndefined()
    expect(addresses().filter((a) => a.startsWith("me/claude"))).toEqual([])

    const joined = await swarm("join", "lead")
    expect([joined.code, joined.stderr, joined.stdout.split(":")[0]]).toEqual([0, "", "joined as me/lead"])
    expect((await swarm("list")).stdout).toContain("me/lead")
    await peer.request("send", { to: "lead", body: "welcome aboard" })
    expect(await tool()).toContain("welcome aboard")

    const left = await swarm("leave")
    expect([left.code, left.stdout]).toEqual([0, "me/lead left the relay: offline, no messages pushed; its mail is kept until swarm join\n"])
    expect(broker.core.list({ all: true }).find((e) => e.address === "me/lead")?.presence).toBe("offline")
    expect((await swarm("list")).stdout).not.toContain("me/lead")
    expect((await swarm("list", "--all")).stdout).toContain("me/lead")
    const queued = await swarm("send", "lead", "while you were away", "--as", "peer2")
    expect(queued.stdout).toContain("  queued: no live session holds me/lead\n")
    const live = await swarm("send", "lead", "only if live", "--live", "--as", "peer2")
    expect(live.code).not.toBe(0)
    expect(live.stderr).toContain("no live session holds me/lead: nothing was queued")
    expect(await tool()).toBeUndefined()

    expect((await swarm("join")).stdout.split(":")[0]).toBe("joined as me/lead")
    const shown = await tool()
    expect(shown).toContain("while you were away")
    expect(shown).not.toContain("only if live")
  })

  test("swarm name prints and renames the session in place; its hooks follow the new handle and never fork the old one", async () => {
    expect((await swarm("name")).stdout).toBe("me/lead\n")
    expect((await swarm("name", "boss")).stdout).toBe("me/lead is now me/boss\n")
    await peer.request("send", { to: "boss", body: "renamed mail" })
    expect(await tool()).toContain("renamed mail")
    expect((await swarm("join", "chief")).stdout.split(":")[0]).toBe("joined as me/chief")
    await hook("SessionStart", { source: "resume" })
    expect(addresses().filter((a) => ["me/lead", "me/boss", "me/chief"].includes(a) || a.startsWith("me/claude"))).toEqual(["me/chief"])
    const taken = await swarm("name", "peer")
    expect(taken.code).not.toBe(0)
    expect(taken.stderr).toContain("peer is held by a live endpoint: pick another name")
  })
})

describe("swarm join --under, adopt and unlink", () => {
  let broker: Broker
  let orch: RelayClient
  let human: RelayClient
  const root = mkdtempSync(join(process.env.HOME!, "adopt-"))
  const dir = join(root, "relay")
  const project = join(root, "lane")
  const env = cleanEnv({ SCP_DIR: dir, XDG_CONFIG_HOME: join(root, "config"), CLAUDECODE: "1" })
  const view = (address: string) => broker.core.list({ all: true }).find((e) => e.address === address)

  async function swarm(...args: string[]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, cwd: project })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, code }
  }

  beforeAll(async () => {
    mkdirSync(join(project, ".git"), { recursive: true })
    broker = await startBroker({ dir, idleMs: 0, policyPath: join(root, "policy.json"), log: () => {} })
    orch = await RelayClient.connect(broker.socket)
    await orch.hello({ claim: { handle: "orch", harness: "codex" } })
    human = await RelayClient.connect(broker.socket)
    await human.hello({ human: true, tty: true })
  })
  afterAll(async () => {
    orch.close()
    human.close()
    await broker.stop()
  })

  test("join --under links the session under its parent: list --tree nests it and its scope narrows to the parent's", async () => {
    await human.request("rules_set", { endpoint: "orch", out: ["tree:children"], in: ["*"] })
    const other = await RelayClient.connect(broker.socket)
    await other.hello({ claim: { handle: "other", harness: "codex" } })
    expect((await swarm("join", "app")).code).toBe(0)
    expect((await swarm("send", "other", "before")).code).toBe(0)
    const joined = await swarm("join", "--under", "orch")
    expect([joined.code, joined.stderr, joined.stdout.split(":")[0]]).toEqual([0, "", "joined as me/app under me/orch"])
    expect(view("me/app")).toMatchObject({ parent: "me/orch", depth: 1 })
    const tree = (await swarm("list", "--tree")).stdout.split("\n")
    expect(tree.findIndex((line) => line.startsWith("  me/app"))).toBe(tree.findIndex((line) => line.startsWith("me/orch")) + 1)
    const refused = await swarm("send", "other", "after")
    expect(refused.code).not.toBe(0)
    other.close()
  })

  test("adopt: refused for an agent without a terminal, done by the human; a cycle is refused", async () => {
    const solo = await RelayClient.connect(broker.socket)
    await solo.hello({ claim: { handle: "solo", harness: "codex" } })
    const byAgent = await swarm("adopt", "solo")
    expect(byAgent.code).not.toBe(0)
    expect(byAgent.stderr).toContain("only the human at a terminal links another session under a parent")
    expect(view("me/solo")?.parent ?? null).toBeNull()
    expect(await human.request("adopt", { endpoint: "solo", parent: "app" })).toMatchObject({ parent: "me/app", endpoint: { depth: 2 } })
    const cycle = await human.request("adopt", { endpoint: "orch", parent: "solo" }).catch((error: Error) => error.message)
    expect(cycle).toContain("cannot go under its own descendant")
    solo.close()
  })

  test("unlink: the session may not detach itself; the human puts it back at the root with its subtree", async () => {
    const self = await swarm("unlink")
    expect(self.code).not.toBe(0)
    expect(self.stderr).toContain("only the human at a terminal unlinks it")
    expect(await human.request("unlink", { endpoint: "app" })).toMatchObject({ parent: "me/orch", endpoint: { parent: null, depth: 0 } })
    expect(view("me/solo")).toMatchObject({ parent: "me/app", depth: 1 })
    expect((await swarm("send", "other", "free again")).code).toBe(0)
  })
})
