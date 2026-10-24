import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Broker, startBroker } from "@scp-dev/broker"
import { walkNow } from "./common"
import { harnessLineage, readPsTable, SHELL_PS_TIMEOUT_MS, spawnerKey } from "./identity"

setDefaultTimeout(60_000)

const entry = join(import.meta.dir, "cli.ts")
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_THREAD_ID|CODEX_SANDBOX|SCP_)/
const root = mkdtempSync(join(process.env.HOME!, "ps-table-"))
const dir = join(root, "relay")
const project = join(root, "bg-app")
let broker: Broker

/** a directory holding a `ps` that runs `body` */
function fakePs(name: string, body: string): string {
  const bin = join(root, name)
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, "ps"), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, "ps"), 0o755)
  return bin
}

/** the real ps, then a 2 MiB command line when the whole table is asked for */
function padded(): string {
  const pad = join(root, "pad")
  writeFileSync(pad, `2147483000 1 Thu Oct 16 09:00:00 2026 pad ${"x".repeat(2 * 1024 * 1024)}\n`)
  return fakePs("padded", `/bin/ps "$@" || exit $?\ncase "$*" in *args=*) cat '${pad}' ;; esac`)
}

function withPath<T>(bin: string, run: () => T): T {
  const saved = process.env.PATH
  process.env.PATH = `${bin}:${saved}`
  try {
    return run()
  } finally {
    process.env.PATH = saved
  }
}

function env(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) out[key] = value
  return { ...out, SCP_DIR: dir, ...extra }
}

beforeAll(async () => {
  mkdirSync(join(project, ".git"), { recursive: true })
  broker = await startBroker({ dir, idleMs: 0, policyPath: join(root, "policy.json"), log: () => {} })
})
afterAll(async () => {
  await broker?.stop()
  rmSync(root, { recursive: true, force: true })
})

test("the process table reads past a 1 MiB ps output", () => {
  const table = withPath(padded(), () => readPsTable(SHELL_PS_TIMEOUT_MS))
  expect(table?.get(process.pid)).toBeDefined()
  expect(table?.get(2147483000)?.args.length).toBeGreaterThan(2_000_000)
})

test("a shell read waits out a slow ps that a hook's deadline gives up on", () => {
  const bin = fakePs("slow", 'sleep 2\nexec /bin/ps "$@"')
  expect(withPath(bin, () => readPsTable())).toBeUndefined()
  expect(withPath(bin, () => readPsTable(SHELL_PS_TIMEOUT_MS))?.get(process.pid)).toBeDefined()
})

test("a failed table read leaves an empty walk without reading again", () => {
  const second = join(root, "second-read")
  const bin = fakePs("once", `if [ ! -e '${second}' ]; then : > '${second}'; exit 1; fi\nexec /bin/ps "$@"`)
  expect(withPath(bin, () => harnessLineage(process.pid))).toEqual([])
  rmSync(second)
  expect(withPath(bin, () => spawnerKey())).toBeUndefined()
  rmSync(second)
  expect(withPath(bin, () => walkNow({}, process.pid))).toEqual({ keys: [], self: [], unread: true })
  const called = join(root, "called")
  const watch = fakePs("watch", `: > '${called}'\nexec /bin/ps "$@"`)
  expect(withPath(watch, () => walkNow({}, process.pid, undefined))).toEqual({ keys: [], self: [], unread: true })
  expect(existsSync(called)).toBe(false)
})

test("a shell whose ps fails is told so, not that no harness runs it", async () => {
  const broken = fakePs("broken", "exit 1")
  for (const args of [["whoami"], ["spawn", "--fg", "--", "/bin/sh", "-c", "exit 0"]]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, ...args], {
      cwd: project,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env({ PATH: `${broken}:${process.env.PATH}` }),
    })
    const err = await new Response(child.stderr).text()
    expect(await child.exited).not.toBe(0)
    expect(err).toContain("could not read the process table")
  }
})

/** a background Claude session: its hook, its MCP shim and a tool shell, all under one `claude` process */
const SESSION = `
const [entry, cwd] = process.argv.slice(2)
const base = { ...process.env, CLAUDE_PID: String(process.pid), CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "11111111-2222-4333-8444-555555555555" }
delete base.SCP_NAME
delete base.SCP_GRANT
const run = async (argv, env, stdin) => {
  const p = Bun.spawn(argv, { cwd, env, stdin: stdin ? new TextEncoder().encode(stdin) : "ignore", stdout: "pipe", stderr: "pipe" })
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text())
  return { code: await p.exited, out }
}
const self = [process.execPath, "--no-env-file", entry]
const line = self.map((word) => "'" + word.replaceAll("'", "'\\\\''") + "'").join(" ")
const hook = await run([...self, "hook", "claude"], base, JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "bg", cwd }))
const shim = Bun.spawn([...self, "mcp", "--harness", "claude"], { cwd, env: { ...base, SCP_NAME: process.env.SCP_NAME, SCP_GRANT: process.env.SCP_GRANT }, stdin: "pipe", stdout: "pipe", stderr: "ignore" })
const send = (m) => shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n")
const reader = shim.stdout.getReader()
let buf = ""
const reply = async (id) => {
  while (!buf.includes('"id":' + id)) {
    const { value, done } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value)
  }
  return buf.split("\\n").find((l) => l.includes('"id":' + id)) ?? ""
}
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } })
await reply(1)
send({ method: "notifications/initialized" })
send({ id: 2, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })
await reply(2)
const sh = (cmd) => run(["/bin/sh", "-c", cmd], base)
const whoami = await sh(line + " whoami")
const spawned = await sh(line + " spawn --bg --name alpha -- /bin/sh -c 'exit 0'")
send({ id: 3, method: "tools/call", params: { name: "relay_spawn", arguments: { command: ["/bin/sh", "-c", "exit 0"], name: "beta" } } })
const relaySpawn = await reply(3)
console.log(JSON.stringify({ hook, whoami, spawned, relaySpawn }))
await new Promise((resolve) => process.stdin.once("data", resolve))
shim.stdin.end()
shim.kill()
await shim.exited
`

test("a background session's tool shell keeps its identity when ps prints over 1 MiB", async () => {
  const bin = join(root, "harness")
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, "claude"))
  writeFileSync(join(root, "session.js"), SESSION)
  const spawner = broker.core.claim({ handle: "spawner", harness: "codex" }).endpoint
  const { token } = broker.core.grant({ kind: "endpoint", id: spawner.id, auth: "session" }, { name: "worker" })
  const session = Bun.spawn([join(bin, "claude"), "--no-env-file", join(root, "session.js"), entry, project], {
    cwd: project,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: env({ PATH: `${padded()}:${process.env.PATH}`, SCP_NAME: "worker", SCP_GRANT: token }),
  })
  try {
    const reader = session.stdout.getReader()
    let line = ""
    while (!line.includes("\n")) {
      const { value, done } = await reader.read()
      if (done) break
      line += new TextDecoder().decode(value)
    }
    const result = JSON.parse(line) as Record<string, { code?: number; out?: string } | string>
    expect(result.hook).toMatchObject({ code: 0 })
    expect(result.whoami).toMatchObject({ code: 0 })
    expect((result.whoami as { out: string }).out).toContain("me/worker")
    expect(result.spawned).toMatchObject({ code: 0 })
    expect(result.relaySpawn).not.toContain('"isError":true')
    const worker = broker.core.list({ all: true }).find((e) => e.address === "me/worker")!
    let mail = ""
    for (const deadline = Date.now() + 20_000; !(mail.includes("alpha") && mail.includes("beta")) && Date.now() < deadline; await Bun.sleep(100))
      mail = JSON.stringify(broker.core.inbox(worker.id))
    expect(mail).toContain("alpha")
    expect(mail).toContain("beta")
  } finally {
    session.stdin.write("\n")
    session.stdin.end()
    const exited = await Promise.race([session.exited, Bun.sleep(10_000).then(() => undefined)])
    if (exited === undefined) session.kill()
  }
})
