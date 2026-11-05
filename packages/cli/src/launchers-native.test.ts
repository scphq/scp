import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { type Broker, startBroker } from "@scp-dev/broker"
import { swarmBinary } from "./test-setup"
import { ensureBuilt } from "./testing/fixtures"

setDefaultTimeout(60_000)

const dist = join(import.meta.dir, "..", "dist", "cli.js")
const node = Bun.which("node")
/** the CLI as it starts under Node, which the native swarm is told as SCP_CLI_ARGV: failures read as Node words them */
const SELF = [node ?? "node", dist]
const top = realpathSync(mkdtempSync(join(process.env.HOME!, "launchers-native-")))
const brokers: Broker[] = []
beforeAll(ensureBuilt)
afterAll(async () => {
  for (const broker of brokers) await broker.stop()
  rmSync(top, { recursive: true, force: true })
})

type Engine = "ts" | "native"

/** one fake harness for every launcher: records how it was started, and plays the part `$FAKE` asks for */
const FAKE = `#!${process.execPath}
import { writeFileSync, appendFileSync } from "node:fs"
const root = process.env.FAKE_ROOT
const args = process.argv.slice(2)
const shown = Object.entries(process.env).filter(([key]) => /^(SCP_|CODEX|T3|XDG_STATE)/.test(key)).map(([key, value]) => key + "=" + value).sort().join("\\n")
const record = (name) => {
  writeFileSync(root + "/" + name + ".args", args.join("\\n") + "\\n")
  writeFileSync(root + "/" + name + ".env", shown + "\\n")
}
const reply = (ws, id, result) => ws.send(JSON.stringify({ id, result }))
if (args[0] === "--remote") {
  record("tui")
  process.exit(Number(process.env.FAKE_TUI_CODE ?? 0))
}
if (args[0] === "app-server") {
  record("app")
  if (process.env.FAKE_APP === "die") {
    console.error("app-server boom")
    process.exit(3)
  }
  Bun.serve({
    unix: args[2].replace("unix://", ""),
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw))
        appendFileSync(root + "/wire.log", raw + "\\n")
        if (message.method === "initialize") reply(ws, message.id, {})
        else if (message.method === "thread/resume" && process.env.FAKE_APP === "held")
          ws.send(JSON.stringify({ id: message.id, error: { code: -1, message: "thread has an active writer" } }))
        else if (message.method === "thread/start" && process.env.FAKE_APP === "refuse")
          ws.send(JSON.stringify({ id: message.id, error: { message: "no", code: 7 } }))
        else if (message.method === "thread/start" || message.method === "thread/resume") {
          reply(ws, message.id, { thread: { id: "thread-1" } })
          ws.send(JSON.stringify({ id: "a1", method: "item/commandExecution/requestApproval", params: {} }))
          ws.send(JSON.stringify({ id: "a2", method: "other/ask", params: {} }))
          ws.send(JSON.stringify({ method: "item/completed", params: { item: { type: "agentMessage", text: "hello from the thread" } } }))
        } else if (message.id !== undefined && message.method) reply(ws, message.id, {})
      },
    },
  })
} else {
  record("run")
  process.exit(Number(process.env.FAKE_CODE ?? 0))
}
`

/** a scratch machine: HOME with fake harnesses on PATH */
function machine(engine: Engine) {
  const root = mkdtempSync(join(top, `${engine}-`))
  const bin = join(root, "bin")
  const work = join(root, "Work Dir")
  mkdirSync(bin)
  mkdirSync(join(work, ".git"), { recursive: true })
  writeFileSync(join(bin, "codex"), FAKE, { mode: 0o755 })
  const env: Record<string, string> = {
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    TMPDIR: "/tmp",
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_STATE_HOME: join(root, ".state"),
    SCP_DIR: join(root, "relay"),
    SCP_HARNESS_DETECT: "0",
    SCP_CLI_ARGV: JSON.stringify(SELF),
    FAKE_ROOT: root,
    ...(process.env.SCP_ROUTE_LOG ? { SCP_ROUTE_LOG: process.env.SCP_ROUTE_LOG } : {}),
  }
  return { engine, root, work, env }
}

type Machine = ReturnType<typeof machine>

/** a broker of its own, so no launcher leaves a daemon behind */
async function broker(m: Machine) {
  brokers.push(await startBroker({ dir: m.env.SCP_DIR!, idleMs: 0, policyPath: join(m.root, "policy.json"), log: () => {} }))
}

const start = (m: Machine, verb: string, args: string[], extra: Record<string, string>, cwd: string) =>
  Bun.spawn(m.engine === "native" ? [resolve(swarmBinary!), verb, ...args] : [node!, dist, verb, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...m.env, ...extra },
  })

/** what a run left: its output and code, and every record the fakes wrote */
function outcome(m: Machine, shown: Record<string, unknown>) {
  const records = Object.fromEntries(
    readdirSync(m.root)
      .filter((name) => /\.(args|env|log)$/.test(name))
      .sort()
      .map((name) => [name, readFileSync(join(m.root, name), "utf8")]),
  )
  for (const name of Object.keys(records)) rmSync(join(m.root, name))
  const normal = (text: string) =>
    text
      .replaceAll(m.root, "<root>")
      .replace(/scp-codex-[A-Za-z0-9]{6}/g, "<socket>")
      .replace(/SCP_SHIM_BINDING=[0-9a-f]{32}/g, "SCP_SHIM_BINDING=<binding>")
      .replace(/krt_[0-9a-f]{64}/g, "<grant>")
      .replace(/swarm mcp: could not reach the relay broker yet: codex channel stopped\\n/g, "")
  return JSON.parse(normal(JSON.stringify({ ...shown, records })))
}

/** `swarm <verb> <args>` to its end */
async function run(m: Machine, verb: string, args: string[], extra: Record<string, string> = {}, cwd = m.work) {
  const child = start(m, verb, args, extra, cwd)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return outcome(m, { code, stdout, stderr })
}

/** `swarm <verb> <args>` until stderr shows `marker`, then `signal`, which it takes as the end of the run */
async function supervise(m: Machine, verb: string, args: string[], marker: RegExp, extra: Record<string, string> = {}, signal: NodeJS.Signals = "SIGTERM") {
  const child = start(m, verb, args, extra, m.work)
  const out = new Response(child.stdout).text()
  let stderr = ""
  const decoder = new TextDecoder()
  const reader = child.stderr.getReader()
  const signalled = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      stderr += decoder.decode(value, { stream: true })
      if (marker.test(stderr)) {
        await Bun.sleep(300)
        child.kill(signal)
        marker = /$^/
      }
    }
  })()
  const code = await child.exited
  await signalled
  return outcome(m, { code, stdout: await out, stderr })
}

/** runs `steps` on a TypeScript machine and a native one, each set up by `prepare`, and expects every step to come out the same */
async function same(steps: (m: Machine) => Promise<unknown[]>, prepare: (m: Machine) => void | Promise<void> = () => {}) {
  const results: unknown[][] = []
  for (const engine of ["ts", "native"] as Engine[]) {
    const m = machine(engine)
    await prepare(m)
    results.push(await steps(m))
  }
  expect(results[1]).toEqual(results[0]!)
  return results[0]!
}

const each =
  (verb: string, lists: [string[], Record<string, string>?][]) =>
  async (m: Machine): Promise<unknown[]> => {
    const out: unknown[] = []
    for (const [args, extra] of lists) out.push(await run(m, verb, args, extra))
    return out
  }

const THREAD = "019bd3c6-f4a2-7c3e-9d5e-1f2a3b4c5d6e"
const WAITING = /waiting for messages/

describe.skipIf(!swarmBinary || !node)("swarm codex: the native swarm runs it as the TypeScript CLI does", () => {
  test("usage errors", async () => {
    await same(
      each("codex", [
        [["--name"]],
        [["--as"]],
        [["--name", "me"]],
        [["--name=Bad Name"]],
        [["--under"]],
        [["--root", "--under=lead"]],
        [["--under=me/vm/Bad"]],
        [["--resume"]],
        [["--headless", "-m"]],
        [["-p"]],
      ]),
    )
  })

  test("an app-server that fails says why", async () => {
    const out = await same(
      each("codex", [
        [["--headless"], { SCP_CODEX_BIN: "/nonexistent/codex" }],
        [["--headless"], { FAKE_APP: "die" }],
        [[], { FAKE_APP: "die" }],
      ]),
      broker,
    )
    expect((out[1] as { code: number; stderr: string }).stderr).toContain("app-server boom")
  })

  test("the TUI runs on the app-server, with codex's arguments and its exit code", async () => {
    const out = await same(
      each("codex", [
        [["--name", "lead", "-m", "gpt", "-s", "read-only", "-c", "a.b=1", "--enable", "x", "--", "fix it"], { FAKE_TUI_CODE: "7" }],
        [["--root", "--strict-config", "--yolo", "-p", "mock"]],
        [["-c", "mcp_servers.scp.command=x"]],
        [["--root"], { SCP_NATIVE: "mcp", SCP_SWARM_BIN: resolve(swarmBinary ?? "swarm") }],
        [["--under=lead", "--resume", THREAD, "-m", "gpt"]],
        [["--", "--name", "x"], { SCP_NAME: "from-env", SCP_SESSION: "s", SCP_PARENT: "p", SCP_CODEX_THREAD: THREAD }],
      ]),
      async (m) => {
        mkdirSync(join(m.root, ".codex"))
        writeFileSync(join(m.root, ".codex", "mock.config.toml"), 'model = "mock"\nwhen = 2024-01-02T03:04:05Z\n[tools]\nweb = true\nlist = [1, "two"]\n')
        await broker(m)
      },
    )
    expect((out[0] as { code: number }).code).toBe(7)
  })

  test("a kept mount is used as it stands, and a bad profile warns", async () => {
    await same(each("codex", [[["-p", "bad"]], [["-p", "missing"]]]), async (m) => {
      mkdirSync(join(m.root, ".codex"))
      writeFileSync(join(m.root, ".codex", "config.toml"), '[mcp_servers.scp]\ncommand = "swarm"\nargs = ["mcp", "--harness", "codex"]\nenv_vars = ["KEEP"]\n')
      mkdirSync(join(m.root, ".codex", "bad.config.toml"))
      await broker(m)
    })
  })

  test("headless: messages print, approvals are declined, a signal ends it with 0", async () => {
    const out = await same(
      async (m) => [
        await supervise(m, "codex", ["--headless", "--name", "worker", "-m", "gpt", "--sandbox=read-only"], WAITING),
        await supervise(m, "codex", ["--headless", "--resume", THREAD], WAITING, {}, "SIGINT"),
        await supervise(m, "codex", ["--headless"], WAITING, {}, "SIGHUP"),
      ],
      broker,
    )
    const first = out[0] as { code: number; stdout: string; stderr: string }
    expect(first.code).toBe(0)
    expect(first.stdout).toBe("hello from the thread\n")
    expect(first.stderr).toContain("declined item/commandExecution/requestApproval")
  })

  test("a thread held elsewhere is refused, before and after the app-server asks", async () => {
    await same(
      each("codex", [
        [["--resume", THREAD], { SCP_LSOF_BIN: "lsof-holds" }],
        [["--headless", "--resume", THREAD], { FAKE_APP: "held", SCP_LSOF_BIN: "lsof-holds" }],
        [["--headless", "--resume", THREAD], { FAKE_APP: "held", SCP_LSOF_BIN: "lsof-free" }],
        [["--headless", "--resume", "plain-name"], { FAKE_APP: "held" }],
        [["--headless"], { FAKE_APP: "refuse" }],
      ]),
      async (m) => {
        mkdirSync(join(m.root, ".codex", "thread-writer-locks"), { recursive: true })
        writeFileSync(join(m.root, ".codex", "thread-writer-locks", `${THREAD}.lock`), "")
        writeFileSync(join(m.root, "bin", "lsof-holds"), `#!/bin/sh\necho ${process.pid}\n`, { mode: 0o755 })
        writeFileSync(join(m.root, "bin", "lsof-free"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
        await broker(m)
      },
    )
  })
})
