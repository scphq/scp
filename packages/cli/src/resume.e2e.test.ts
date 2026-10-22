import { afterEach, expect, test } from "bun:test"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = join(import.meta.dir, "cli.ts")
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(probe: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (probe()) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []
}

/** a stand-in harness binary: it logs its argv, reports the conversation as agy's hooks would, asks its own MCP shim who it is, and fails a turn that says please-fail */
function fixture(harness: "agy" | "grok") {
  const root = mkdtempSync(join(tmpdir(), `scp-${harness}-e2e-`))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, "work")
  const tools = join(root, "bin")
  mkdirSync(cwd)
  mkdirSync(tools)
  const log = join(root, "argv.log")
  const who = join(root, "whoami.log")
  const hook =
    harness === "agy"
      ? `const at = args.indexOf("--conversation")
spawnSync(process.execPath, [cli, "hook", "agy", "SessionStart"], {
  input: JSON.stringify({ conversationId: at < 0 ? "conv-1" : args[at + 1], workspacePaths: [process.cwd()] }),
  stdio: ["pipe", "ignore", "ignore"],
})`
      : ""
  const bin = join(tools, harness)
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
const args = process.argv.slice(2)
const cli = ${JSON.stringify(cli)}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n")
${hook}
const shim = spawn(process.execPath, [cli, "mcp", "--harness", ${JSON.stringify(harness)}], { stdio: ["pipe", "pipe", "ignore"] })
let out = ""
const answered = new Promise((resolve) => shim.stdout.on("data", (data) => { out += data; if (out.includes('"id":2')) resolve() }))
const send = (message) => shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } })
send({ method: "notifications/initialized" })
send({ id: 2, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })
await answered
shim.stdin.end()
appendFileSync(${JSON.stringify(who)}, out.split("\\n").find((line) => line.includes('"id":2')) + "\\n")
process.exit(args.some((arg) => arg.includes("please-fail")) ? 3 : 0)
`,
  )
  chmodSync(bin, 0o755)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH ?? ""}`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_STATE_HOME: join(root, ".state"),
    XDG_DATA_HOME: join(root, ".data"),
    XDG_CACHE_HOME: join(root, ".cache"),
    SCP_DIR: join(root, "scp"),
    SCP_IDLE: "30s",
    [harness === "agy" ? "SCP_AGY_BIN" : "SCP_GROK_BIN"]: bin,
  }
  for (const key of ["SCP_SESSION", "SCP_GRANT", "SCP_PARENT", "SCP_NAME", "SCP_HARNESS", "SCP_HARNESS_PID", "SCP_AGY_CONVERSATION_FILE", "SCP_TRANSPORT"])
    delete env[key]
  for (const key of Object.keys(env)) if (/^(ANTIGRAVITY_|GROK_|CLAUDECODE|CLAUDE_CODE_|CODEX_THREAD_ID)/.test(key)) delete env[key]
  const swarm = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, cwd, encoding: "utf8", timeout: 30_000 })
  cleanups.push(() => {
    swarm("daemon", "stop")
  })
  const launch = (args: string[], extra: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [cli, harness, ...args], { env: { ...env, ...extra }, cwd, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr!.on("data", (data) => (stderr += String(data)))
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
    cleanups.push(() => stop(child))
    return { child, exited, stderr: () => stderr }
  }
  type Listed = { address: string; harness: string; wake: string | null; parent?: string | null }
  const listed = () => (JSON.parse(swarm("list", "--as", "lead", "--all", "--json").stdout || "{}") as { endpoints?: Listed[] }).endpoints ?? []
  return {
    swarm,
    launch,
    listed,
    turns: () => lines(log).map((line) => JSON.parse(line) as string[]),
    whos: () => lines(who),
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
  child.kill("SIGTERM")
  await exited
  clearTimeout(timer)
}

test("swarm agy runs its prompt, then resumes the conversation its hooks report with each new message, as one endpoint", async () => {
  const f = fixture("agy")
  const refused = f.swarm("agy", "--name", "w", "--", "-p", "hi")
  expect(refused.status).not.toBe(0)
  expect(refused.stderr).toContain("setup --write")
  expect(f.turns()).toEqual([])
  expect(f.swarm("hooks", "install", "--harness", "agy", "--scope", "user", "--write").status).toBe(0)
  const run = f.launch(["--name", "w", "--", "-p", "hi"])
  await until(() => f.whos().length >= 1, 30_000, "the first turn")
  expect(f.turns()[0]).toEqual(["-p", "hi"])
  expect(f.whos()[0]).toContain("address: me/w\\n")
  const w = f.listed().find((e) => e.address === "me/w")
  expect(w?.harness).toBe("agy")
  expect(w?.wake).toBe("agy-resume")
  expect(f.listed().filter((e) => e.address.startsWith("me/w-"))).toEqual([])

  expect(f.swarm("send", "--as", "tester", "w", "ping from tester").status).toBe(0)
  await until(() => f.whos().length >= 2, 30_000, "the resumed turn")
  const resumed = f.turns()[1]!
  expect(resumed.slice(0, 3)).toEqual(["--conversation", "conv-1", "-p"])
  expect(resumed[3]).toContain("ping from tester")
  expect(resumed[3]).toContain("<relay-message")
  expect(f.whos()[1]).toContain("address: me/w\\n")
  await stop(run.child)
  expect(await run.exited).toBe(0)
}, 120_000)

test("swarm grok waits for a message, opens a preassigned session with it, resumes it, and fails loud on a failed turn", async () => {
  const f = fixture("grok")
  const run = f.launch(["--name", "g", "--", "--model", "m"])
  await until(() => run.stderr().includes("me/g waiting for messages"), 30_000, "the waiting line")
  expect(f.turns()).toEqual([])
  expect(f.listed().find((e) => e.address === "me/g")?.wake).toBe("grok-resume")

  expect(f.swarm("send", "--as", "tester", "g", "first message").status).toBe(0)
  await until(() => f.whos().length >= 1, 30_000, "the opening turn")
  const opening = f.turns()[0]!
  expect(opening.slice(0, 3)).toEqual(["--model", "m", "-s"])
  const id = opening[3]!
  expect(id).toMatch(/^[0-9a-f-]{36}$/)
  expect(opening[4]).toBe("-p")
  expect(opening[5]).toContain("first message")
  expect(opening.slice(6, 8)).toEqual(["--allow", "mcp__scp__relay_send"])
  expect(f.whos()[0]).toContain("address: me/g\\n")

  expect(f.swarm("send", "--as", "tester", "g", "second message").status).toBe(0)
  await until(() => f.whos().length >= 2, 30_000, "the resumed turn")
  expect(f.turns()[1]!.slice(0, 5)).toEqual(["--model", "m", "--resume", id, "-p"])
  expect(f.turns()[1]![5]).toContain("second message")

  expect(f.swarm("send", "--as", "tester", "g", "please-fail").status).toBe(0)
  expect(await run.exited).toBe(3)
  expect(run.stderr()).toContain("turn failed (exit 3); undelivered messages stay unread in relay_inbox")
}, 120_000)

test("swarm grok under spawn-env takes the spawner's grant, and each turn's MCP server joins that endpoint", async () => {
  const f = fixture("grok")
  const issued = f.swarm("spawn-env", "--as", "lead", "--name", "gw")
  expect(issued.status).toBe(0)
  const grant = Object.fromEntries(
    issued.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  )
  expect(grant.SCP_GRANT).toStartWith("krt_")
  const run = f.launch([], grant)
  await until(() => run.stderr().includes("waiting for messages"), 30_000, "the waiting line")
  const gw = f.listed().find((e) => e.address === "me/gw")
  expect(gw?.wake).toBe("grok-resume")
  expect(gw?.parent).toBe("me/lead")
  expect(f.swarm("send", "--as", "lead", "gw", "hello worker").status).toBe(0)
  await until(() => f.whos().length >= 1, 30_000, "the opening turn")
  expect(f.whos()[0]).toContain("address: me/gw\\n")
  expect(f.listed().filter((e) => e.address.startsWith("me/gw-"))).toEqual([])
}, 120_000)
