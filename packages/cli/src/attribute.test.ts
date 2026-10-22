import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { RelayError } from "@scp-dev/core"
import { attribute, attributed } from "./attribute"
import { claudeCommand } from "./claude"
import { processKey } from "./identity"

setDefaultTimeout(30_000)

const entry = join(import.meta.dir, "cli.ts")
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_THREAD_ID|SCP_)/
const root = mkdtempSync(join(process.env.HOME!, "autoattr-"))
const dir = join(root, "relay")
const project = join(root, "app")
const bin = join(root, "bin")
const record = join(root, "claude.args")
let broker: Broker

beforeAll(async () => {
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, "claude"), ["#!/bin/sh", `printf '%s\\n' "$@" > "${record}"`, "echo 'backgrounded · 1a2b3c4d (idle)'", ""].join("\n"), {
    mode: 0o755,
  })
  broker = await startBroker({ dir, idleMs: 0, policyPath: join(root, "policy.json"), log: () => {} })
})
afterAll(async () => {
  await broker.stop()
  rmSync(root, { recursive: true, force: true })
})

function env(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) out[key] = value
  return { ...out, PATH: `${bin}:${process.env.PATH}`, SCP_DIR: dir, ...extra }
}

/** `swarm <args>` from a shell, as an agent's harness runs one: `agent` names the endpoint whose lineage holds that shell (claimed with `grant`), else none does */
async function launch(args: string[], extra: Record<string, string> = {}, agent?: string, grant?: string) {
  const shell = Bun.spawn(["sh", "-c", 'read go; "$0" --no-env-file "$@"; :', process.execPath, entry, ...args], {
    cwd: project,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: env(extra),
  })
  const held = agent ? await RelayClient.connect(broker.socket) : undefined
  const key = processKey(shell.pid)
  await held?.hello({ claim: { handle: agent!, harness: "claude-code", process: key, lineage: [key], ...(grant ? { grant } : {}) } })
  shell.stdin.write("go\n")
  shell.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(shell.stdout).text(), new Response(shell.stderr).text(), shell.exited])
  held?.close()
  const args_ = readFileSync(record, "utf8").trimEnd().split("\n")
  const config = JSON.parse(readFileSync(args_.at(-1)!, "utf8")) as { mcpServers: { scp: { command: string; args: string[]; env: Record<string, string> } } }
  return { stdout, stderr, code, scp: config.mcpServers.scp }
}

/** the background session's hook, then its shim from the config `swarm claude --bg` wrote, each under a shell of its own outside the agent's lineage, as under claude's daemon */
async function session(scp: { command: string; args: string[]; env: Record<string, string> }, id: string) {
  const base = env({ SCP_SESSION: id, CLAUDECODE: "1" })
  const hook = Bun.spawn(["sh", "-c", '"$0" "$@"; :', process.execPath, "--no-env-file", entry, "hook", "claude"], {
    cwd: project,
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: id, cwd: project })),
    stdout: "ignore",
    stderr: "ignore",
    env: base,
  })
  expect(await hook.exited).toBe(0)
  const child = Bun.spawn(["sh", "-c", '"$0" "$@"; :', scp.command, ...scp.args], {
    cwd: project,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...base, ...scp.env },
  })
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } })
  send({ method: "notifications/initialized" })
  send({ id: 2, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })
  let out = ""
  const decoder = new TextDecoder()
  for await (const chunk of child.stdout) {
    out += decoder.decode(chunk)
    if (out.includes('"id":2')) break
  }
  child.stdin.end()
  child.kill()
  await child.exited
  return out
}

const endpoint = (address: string) => broker.core.list({ all: true }).find((e) => e.address === address)

describe("swarm claude --bg from an agent's shell", () => {
  // first: a session the hook test below claims has this test process for its harness, so every later shell would find it
  test("--root, a grant minted for the session, or a shell no agent runs pass no new grant; --root drops the caller's identity", async () => {
    const given = `krt_${"a".repeat(64)}`
    const rooted = await launch(["claude", "--bg", "--root"], { SCP_NAME: "lead2", SCP_GRANT: given }, "lead2")
    expect([rooted.code, rooted.scp.env.SCP_GRANT, rooted.scp.env.SCP_NAME]).toEqual([0, "", undefined])
    expect(rooted.stdout).not.toContain(" under ")
    const explicit = await launch(["claude", "--bg", "--name", "kid"], { SCP_GRANT: given }, "lead3")
    expect([explicit.stderr, explicit.scp.env.SCP_GRANT]).toEqual(["", given])
    expect(explicit.stdout).not.toContain(" under ")
    const human = await launch(["claude", "--bg", "--name", "mine"])
    expect([human.code, human.stderr, human.scp.env.SCP_GRANT]).toEqual([0, "", ""])
    expect(human.stdout).not.toContain(" under ")
  })

  test("a spawned agent's own spent grant in its shell is replaced by a fresh grant under that agent", async () => {
    const top = broker.core.claim({ handle: "top", harness: "codex" }).endpoint
    const { token } = broker.core.grant({ kind: "endpoint", id: top.id, auth: "session" }, { name: "mid" })
    const run = await launch(["claude", "--bg", "--name", "leaf"], { SCP_NAME: "mid", SCP_GRANT: token }, "mid", token)
    expect(run.stderr).toBe("")
    expect(run.stdout).toContain("is me/leaf on SCP under me/mid;")
    expect(run.scp.env.SCP_GRANT).toMatch(/^krt_[0-9a-f]{64}$/)
    expect(run.scp.env.SCP_GRANT).not.toBe(token)
    expect(endpoint("me/mid")).toMatchObject({ parent: "me/top" })
  })

  test("mints a grant as spawn-env would, says so, and the session links under the agent even when its hook claims first", async () => {
    const run = await launch(["claude", "--bg", "--name", "worker", "--", "do it"], {}, "lead")
    expect(run.code).toBe(0)
    expect(run.stderr).toBe("")
    expect(run.stdout).toContain("background session 1a2b3c4d is me/worker on SCP under me/lead;")
    expect(run.scp.env.SCP_NAME).toBe("worker")
    expect(run.scp.env.SCP_GRANT).toMatch(/^krt_[0-9a-f]{64}$/)
    expect(await session(run.scp, "bg-worker")).toContain("me/worker")
    expect(endpoint("me/worker")).toMatchObject({ parent: "me/lead" })
  })

  test("without --name the grant has none, and the caller's own $SCP_NAME never reaches the session", async () => {
    const run = await launch(["claude", "--bg"], { SCP_NAME: "boss" }, "boss")
    expect(run.stdout).toContain("under me/boss;")
    expect(run.scp.env.SCP_NAME).toBeUndefined()
    expect(run.scp.env.SCP_GRANT).toMatch(/^krt_/)
  })

  test("no running broker means no agent: nothing starts one and the session launches unlinked", async () => {
    const idle = join(root, "idle-relay")
    const run = await launch(["claude", "--bg", "--name", "lone"], { SCP_DIR: idle })
    expect([run.code, run.stderr, run.scp.env.SCP_GRANT]).toEqual([0, "", ""])
    expect(existsSync(join(idle, "broker.lock"))).toBe(false)
  })
})

describe("a foreground launcher from an agent's shell", () => {
  test("swarm pi runs pi with a grant under the agent in place of the agent's own identity", async () => {
    writeFileSync(join(bin, "pi"), ["#!/bin/sh", `printf '%s\\n' "$SCP_GRANT" "$SCP_NAME" "$SCP_SESSION" > "${record}.pi"`, ""].join("\n"), { mode: 0o755 })
    const extra = { SCP_PI_EXTENSION: join(root, "ext.js"), SCP_NAME: "pilead", SCP_SESSION: "pilead-session" }
    const shell = Bun.spawn(["sh", "-c", 'read go; "$0" --no-env-file "$@"; :', process.execPath, entry, "pi"], {
      cwd: project,
      stdin: "pipe",
      env: env(extra),
    })
    const held = await RelayClient.connect(broker.socket)
    const key = processKey(shell.pid)
    await held.hello({ claim: { handle: "pilead", harness: "claude-code", process: key, lineage: [key] } })
    shell.stdin.write("go\n")
    shell.stdin.end()
    expect(await shell.exited).toBe(0)
    held.close()
    const [grant, name, session] = readFileSync(`${record}.pi`, "utf8").split("\n")
    expect(grant).toMatch(/^krt_[0-9a-f]{64}$/)
    expect([name, session]).toEqual(["", ""])
  })
})

/** a broker client that binds the caller to `address`, recording its hello and grant requests, failing the grant with `fail`, or never answering hello */
function fakeClient(address: string | undefined, grants: unknown[], fail?: Error, hellos: unknown[] = [], hang = false): RelayClient {
  return {
    hello: (params: unknown) => {
      hellos.push(params)
      return hang ? new Promise(() => {}) : Promise.resolve({})
    },
    rules: async () => {
      if (!address) throw new RelayError("unauthorized", "no endpoint")
      return { address }
    },
    grant: async (params: unknown) => {
      if (fail) throw fail
      grants.push(params)
      return { token: "t", env: { SCP_GRANT: "krt_new", ...((params as { name?: string }).name ? { SCP_NAME: (params as { name: string }).name } : {}) } }
    },
    close: () => {},
  } as unknown as RelayClient
}

describe("attribute", () => {
  const walk = { keys: ["pid:2"], self: [] as string[] }

  test("names the grant by --name only, refuses a $SCP_NAME of another agent, and swaps the caller's identity for the grant", async () => {
    const grants: unknown[] = []
    const warned: string[] = []
    const deps = { walk, connect: async () => fakeClient("me/lead", grants) }
    const named = await attribute("pi", { name: "kid" }, { SCP_NAME: "lead" }, project, () => {}, deps)
    expect(named).toEqual({ env: { SCP_GRANT: "krt_new", SCP_NAME: "kid" }, parent: "me/lead" })
    await attribute("pi", {}, { SCP_NAME: "lead" }, project, () => {}, deps)
    expect(await attribute("pi", {}, { SCP_NAME: "other" }, project, (line) => warned.push(line), deps)).toBeUndefined()
    expect(grants).toEqual([{ name: "kid" }, {}])
    expect(warned).toEqual([expect.stringContaining("($SCP_NAME names other, but this shell runs under me/lead)")])
    const caller = { PATH: "/bin", SCP_NAME: "lead", SCP_SESSION: "s", SCP_UNDER: "me/top", SCP_HARNESS: "claude-code" }
    expect(attributed(caller, named)).toEqual({ PATH: "/bin", SCP_GRANT: "krt_new", SCP_NAME: "kid" })
    expect(attributed(caller, undefined)).toBe(caller)
  })

  test("a shell no agent runs gets nothing, silently; a failed mint warns once and launches unlinked", async () => {
    const warned: string[] = []
    expect(await attribute("codex", {}, {}, project, (line) => warned.push(line), { walk, connect: async () => fakeClient(undefined, []) })).toBeUndefined()
    expect(warned).toEqual([])
    const refused = { walk, connect: async () => fakeClient("me/lead", [], new RelayError("scope_refused", "refused")) }
    expect(await attribute("codex", {}, {}, project, (line) => warned.push(line), refused)).toEqual({ env: {} })
    expect(warned).toEqual(["swarm codex: not linked under the agent that ran it (refused); it starts as a root, swarm adopt <name> links it later"])
  })

  test("a Codex thread shell names its thread, so a shared app server binds the caller by thread", async () => {
    const hellos: unknown[] = []
    const thread = "01a160cb-247a-7903-b0e3-1bba7cf21078"
    const env = { SCP_HARNESS: "codex-desktop", CODEX_THREAD_ID: thread }
    await attribute("claude", {}, env, project, () => {}, { walk, connect: async () => fakeClient("me/lead", [], undefined, hellos) })
    expect(hellos).toEqual([expect.objectContaining({ observe: true, harness_session: thread })])
    hellos.length = 0
    await attribute("claude", {}, { SCP_HARNESS: "codex-desktop", CODEX_THREAD_ID: "not a thread" }, project, () => {}, {
      walk,
      connect: async () => fakeClient("me/lead", [], undefined, hellos),
    })
    expect(hellos[0]).not.toHaveProperty("harness_session")
  })

  test("a caller bound by hello whose rules fail is still unlinked as a root, and $SCP_NAME may carry me/", async () => {
    const warned: string[] = []
    const bound = {
      hello: async () => ({ endpoint: { address: "me/lead" } }),
      rules: async () => {
        throw new Error("gone")
      },
      close: () => {},
    } as unknown as RelayClient
    expect(await attribute("pi", {}, {}, project, (line) => warned.push(line), { walk, connect: async () => bound })).toEqual({ env: {} })
    expect(warned).toEqual([expect.stringContaining("(gone)")])
    const grants: unknown[] = []
    const named = await attribute("pi", {}, { SCP_NAME: "me/lead" }, project, () => {}, { walk, connect: async () => fakeClient("me/lead", grants) })
    expect(named?.parent).toBe("me/lead")
  })

  test("a broker that never answers costs at most the timeout, and warns only once a harness runs the shell", async () => {
    const warned: string[] = []
    const stuck = (harness?: string) => ({
      walk: { keys: ["pid:2"], self: ["pid:2"], ...(harness ? { harness } : {}) },
      timeoutMs: 50,
      connect: async () => fakeClient("me/lead", [], undefined, [], true),
    })
    expect(await attribute("pi", {}, {}, project, (line) => warned.push(line), stuck())).toBeUndefined()
    expect(warned).toEqual([])
    expect(await attribute("pi", {}, {}, project, (line) => warned.push(line), stuck("claude-code"))).toBeUndefined()
    expect(warned).toEqual([expect.stringContaining("(no answer from the relay broker within 50 ms)")])
  })

  test("binds as spawn-env would: self from the agent's own shell, lineage only at a terminal; a resumed session mints nothing", async () => {
    const hellos: unknown[] = []
    const grants: unknown[] = []
    const deps = (tty: boolean) => ({
      walk: { keys: ["pid:2", "pid:1"], self: ["pid:2"] },
      tty,
      connect: async () => fakeClient("me/lead", grants, undefined, hellos),
    })
    await attribute("claude", {}, {}, project, () => {}, deps(false))
    await attribute("claude", {}, {}, project, () => {}, deps(true))
    expect(hellos).toEqual([
      { observe: true, lineage: ["pid:2", "pid:1"], self: ["pid:2"], cwd: project, brief: true },
      { observe: true, lineage: ["pid:2", "pid:1"], cwd: project, brief: true },
    ])
    expect(await attribute("claude", { resume: true }, {}, project, () => {}, deps(false))).toBeUndefined()
    expect(grants).toHaveLength(2)
  })

  test("swarm claude still launches when the mint fails, with no grant and the warning", async () => {
    const warned: string[] = []
    const lines: string[] = []
    const deps = { out: (line: string) => lines.push(line), attribute: { walk, connect: async () => fakeClient("me/lead", [], new Error("broker gone")) } }
    expect(await claudeCommand(["--bg", "--name", "w2"], env(), (line) => warned.push(line), project, deps)).toBe(0)
    expect(warned).toEqual([expect.stringContaining("not linked under the agent that ran it (broker gone)")])
    const args = readFileSync(record, "utf8").trimEnd().split("\n")
    expect(JSON.parse(readFileSync(args.at(-1)!, "utf8")).mcpServers.scp.env.SCP_GRANT).toBe("")
    expect(lines).toEqual([expect.stringContaining("is me/w2 on SCP; messages")])
  })
})
