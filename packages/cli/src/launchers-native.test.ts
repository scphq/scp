import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { opencodePlugin } from "./hooks"
import { processKey } from "./identity"
import { hooksTarget } from "./install"
import { swarmBinary } from "./test-setup"
import { ensureBuilt } from "./testing/fixtures"

setDefaultTimeout(60_000)

const dist = join(import.meta.dir, "..", "dist", "cli.js")
const node = Bun.which("node")
/** the CLI as it starts under Node, which the native swarm is told as SCP_CLI_ARGV: failures read as Node words them */
const SELF = [node ?? "node", dist]
const top = realpathSync(mkdtempSync(join(process.env.HOME!, "launchers-native-")))
const brokers: Broker[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
beforeAll(ensureBuilt)
afterAll(async () => {
  for (const broker of brokers) await broker.stop()
  for (const server of servers) server.stop(true)
  rmSync(top, { recursive: true, force: true })
})

type Engine = "ts" | "native"

/** one fake harness for every launcher: records how it was started, and plays the part `$FAKE` asks for */
const FAKE = `#!${process.execPath}
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs"
import { spawn } from "node:child_process"
const root = process.env.FAKE_ROOT
const args = process.argv.slice(2)
const shown = Object.entries(process.env).filter(([key]) => /^(SCP_|CODEX|T3|XDG_STATE)/.test(key)).map(([key, value]) => key + "=" + value).sort().join("\\n")
const record = (name) => {
  writeFileSync(root + "/" + name + ".args", args.join("\\n") + "\\n")
  writeFileSync(root + "/" + name + ".env", shown + "\\n")
}
const reply = (ws, id, result) => ws.send(JSON.stringify({ id, result }))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const there = (name) => existsSync(root + "/" + name)
if (args[0] === "--remote") {
  record("tui")
  if (process.env.FAKE_APP === "vanish") {
    while (!there("app.gone")) await pause(5)
    await pause(30)
  }
  process.exit(Number(process.env.FAKE_TUI_CODE ?? 0))
}
if (args[0] === "app-server") {
  record("app")
  writeFileSync(root + "/server.pid", String(process.pid))
  if (process.env.FAKE_APP === "die") {
    console.error("app-server boom")
    process.exit(3)
  }
  if (process.env.FAKE_APP === "vanish") {
    ;(async () => {
      while (!there("tui.args")) await pause(5)
      spawn("sleep", ["1"], { stdio: ["ignore", "ignore", "inherit"], detached: true }).unref()
      writeFileSync(root + "/app.gone", "")
      process.exit(0)
    })()
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
          if (process.env.FAKE_APP === "flood")
            for (let i = 0; i < 8; i++) ws.send(JSON.stringify({ method: "item/completed", params: { item: { type: "agentMessage", text: "x".repeat(1 << 20) } } }))
        } else if (message.id !== undefined && message.method) reply(ws, message.id, {})
      },
    },
  })
} else if (args[0] === "serve") {
  record("muse")
  if (process.env.FAKE_APP === "die") {
    console.error("serve boom")
    process.exit(3)
  }
  writeFileSync(root + "/muse.pid", String(process.pid))
  writeFileSync(root + "/server.pid", String(process.pid))
  const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
  let buffer = ""
  let turn = 0
  process.stdin.on("data", (chunk) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf("\\n")
      if (end < 0) return
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      const message = JSON.parse(line)
      appendFileSync(root + "/wire.log", line.replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid7>") + "\\n")
      if (message.method === "session/start" || message.method === "session/resume") {
        const dir = process.env.HOME + "/.local/state/scp/launch"
        appendFileSync(root + "/launch.log", readFileSync(dir + "/muse-" + process.pid + ".json", "utf8") + "\\n")
        if (process.env.FAKE_APP === "refuse") write({ id: message.id, error: { message: "no", code: 7 } })
        else if (process.env.FAKE_APP === "unnamed") write({ id: message.id, result: { session: {} } })
        else {
          write({ id: message.id, result: { session: { sessionId: "s-1" } } })
          write({ id: "r1", method: "approval/request", params: { approvalId: "a", sessionId: "s-1", currentRequirementId: "q", subject: { command: "rm -rf" }, availableChoices: [{ decision: "approved", choiceId: "c0" }, { decision: "denied", choiceId: "c1" }] } })
          write({ id: "r2", method: "approval/request", params: { subject: { kind: "network" }, availableChoices: [] } })
          write({ id: "r3", method: "other/thing", params: {} })
          write({ method: "item/completed", params: { item: { kind: "agentMessage", text: "hello from muse" } } })
          write({ method: "item/completed", params: { item: { kind: "agentMessage", text: "" } } })
          process.stdout.write("not json\\n\\n")
          if (process.env.FAKE_APP === "flood")
            for (let i = 0; i < 8; i++) write({ method: "item/completed", params: { item: { kind: "agentMessage", text: "x".repeat(1 << 20) } } })
        }
      } else if (message.method === "turn/start") {
        write({ id: message.id, result: { status: ++turn === 1 && process.env.FAKE_APP === "busy" ? "rejected" : "accepted" } })
      } else if (message.id !== undefined && message.method) write({ id: message.id, result: {} })
    }
  })
  process.stdin.on("end", () => process.exit(0))
} else if (args[0] === "auth") {
  record("t3")
  if (process.env.FAKE_APP === "stdin") await Bun.stdin.text()
  if (process.env.FAKE_APP === "refuse") {
    console.error("one\\ntwo\\nthree\\nfour")
    process.exit(2)
  }
  console.log(process.env.FAKE_APP === "spaced" ? "some words here" : "banner\\n  tok-1  ")
} else {
  appendFileSync(root + "/turns.log", JSON.stringify(args) + "\\n" + shown + "\\n")
  if (process.env.SCP_AGY_CONVERSATION_FILE && !process.env.FAKE_NO_CONVERSATION) writeFileSync(process.env.SCP_AGY_CONVERSATION_FILE, "conv-1\\n")
  if (args.some((word) => String(word).includes("please-fail"))) process.exit(4)
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
  for (const harness of ["codex", "muse", "t3", "agy", "grok", "opencode", "pi"]) writeFileSync(join(bin, harness), FAKE, { mode: 0o755 })
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
  return { engine, root, work, env, broker: undefined as Broker | undefined }
}

type Machine = ReturnType<typeof machine>

/** a broker of its own, so no launcher leaves a daemon behind */
async function broker(m: Machine, dir = m.env.SCP_DIR!) {
  m.broker = await startBroker({ dir, idleMs: 0, policyPath: join(m.root, "policy.json"), log: () => {} })
  brokers.push(m.broker)
}

const start = (m: Machine, verb: string, args: string[], extra: Record<string, string>, cwd: string) =>
  Bun.spawn(m.engine === "native" ? [resolve(swarmBinary!), verb, ...args] : [node!, dist, verb, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...m.env, ...extra },
  })

type Outcome = { code: number; stdout: string; stderr: string; records: Record<string, string> }

/** what a run left: its output and code, and every record the fakes wrote */
function outcome(m: Machine, shown: Record<string, unknown>): Outcome {
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
      .replace(/SCP_SESSION=[0-9a-f]{32}/g, "SCP_SESSION=<session>")
      .replace(/SCP_HARNESS_PID=\d+/g, "SCP_HARNESS_PID=<pid>")
      .replace(/resume-[A-Za-z0-9]{6}/g, "resume-<dir>")
      .replace(/krt_[0-9a-f]{64}/g, "<grant>")
      .replace(/"process":"pid:[^"]*/g, '"process":"<process>')
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
      .replace(/(msg|thr)_[0-9a-z]+/g, "$1_<id>")
      .replace(/short=\\"[0-9a-f]{6}/g, 'short=\\"<short>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid4>")
      .replace(/swarm mcp: could not reach the relay broker yet: codex channel stopped\n/g, "")
  const each = (value: unknown): unknown => (typeof value === "string" ? normal(value) : value)
  return {
    ...Object.fromEntries(Object.entries(shown).map(([key, value]) => [key, each(value)])),
    records: Object.fromEntries(Object.entries(records).map(([key, value]) => [key, normal(value)])),
  } as Outcome
}

/** `swarm <verb> <args>` to its end */
async function run(m: Machine, verb: string, args: string[], extra: Record<string, string> = {}, cwd = m.work) {
  const child = start(m, verb, args, extra, cwd)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return outcome(m, { code, stdout, stderr })
}

/** `swarm <verb> <args>` until stderr shows `marker`, or `stop()` runs: then `signal`, which it takes as the end of the run */
function supervise(m: Machine, verb: string, args: string[], marker: RegExp, extra: Record<string, string> = {}, signal: NodeJS.Signals = "SIGTERM") {
  const child = start(m, verb, args, extra, m.work)
  const out = new Response(child.stdout).text()
  let stderr = ""
  const decoder = new TextDecoder()
  const reader = child.stderr.getReader()
  const stop = () => child.kill(signal)
  const read = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      stderr += decoder.decode(value, { stream: true })
      if (marker.test(stderr)) {
        await Bun.sleep(300)
        stop()
        marker = /$^/
      }
    }
  })()
  const finished = (async () => {
    const code = await child.exited
    await read
    return outcome(m, { code, stdout: await out, stderr })
  })()
  return Object.assign(finished, { stop, stderr: () => stderr })
}

async function until(probe: () => boolean, ms = 20_000) {
  const end = Date.now() + ms
  while (!probe()) {
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(50)
  }
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

/** a shim's claim of the process in `file`, once it is there, on the machine's broker */
async function shim(m: Machine, file: string, handle: string, harness: string) {
  while (!existsSync(join(m.root, file))) await Bun.sleep(20)
  const pid = Number(readFileSync(join(m.root, file), "utf8"))
  const client = await RelayClient.connect(m.broker!.socket)
  const key = processKey(pid)
  await client.hello({ claim: { handle, harness, process: key, lineage: [key] } })
  rmSync(join(m.root, file))
  return client
}

const THREAD = "019bd3c6-f4a2-7c3e-9d5e-1f2a3b4c5d6e"
const WAITING = /waiting for messages/

/** the native `swarm <verb>`, its stdout a pipe nobody reads and flooded by its harness: SIGTERM still stops the harness at once */
async function blocked(m: Machine, verb: string, args: string[], extra: Record<string, string>, ready?: () => Promise<unknown>) {
  const fifo = join(m.root, "stdout.fifo")
  Bun.spawnSync(["mkfifo", fifo])
  const pipe = openSync(fifo, constants.O_RDWR)
  const child = Bun.spawn([resolve(swarmBinary!), verb, ...args], {
    cwd: m.work,
    stdin: "ignore",
    stdout: pipe,
    stderr: "pipe",
    env: { ...m.env, FAKE_APP: "flood", ...extra },
  })
  const seen = new Response(child.stderr).text()
  await ready?.()
  await until(() => existsSync(join(m.root, "server.pid")))
  await Bun.sleep(1500)
  const pid = Number(readFileSync(join(m.root, "server.pid"), "utf8"))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  expect(alive()).toBe(true)
  child.kill("SIGTERM")
  await until(() => !alive(), 5000)
  expect(await child.exited).toBe(0)
  await seen
  closeSync(pipe)
}

/** `tester` sending `body` to `to` on the machine's broker */
async function send(m: Machine, to: string, body: string) {
  const sender = await RelayClient.connect(m.broker!.socket)
  await sender.hello({ claim: { handle: "tester", harness: "test", process: "pid:1:tester", lineage: [] } })
  await sender.request("send", { to, body })
  sender.close()
}

const turns = (m: Machine) =>
  existsSync(join(m.root, "turns.log"))
    ? readFileSync(join(m.root, "turns.log"), "utf8")
        .split("\n")
        .filter((line) => line.startsWith("[")).length
    : 0

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

  test("an app-server gone before the TUI is a failure, though what it left behind holds its stderr", async () => {
    const out = await same(each("codex", [[[], { FAKE_APP: "vanish" }]]), broker)
    expect((out[0] as Outcome).code).toBe(1)
    expect((out[0] as Outcome).stderr).toContain("app-server failed")
  })

  test("a stdout nobody reads never holds up a signal", async () => {
    const m = machine("native")
    await broker(m)
    await blocked(m, "codex", ["--headless"], {})
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
        writeFileSync(
          join(m.root, ".codex", "mock.config.toml"),
          'model = "mock"\nwhen = 2024-01-02T03:04:05Z\nzero = 2024-01-02T03:04:05-00:00\n[tools]\nweb = true\nlist = [1, "two"]\n',
        )
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

const MUSE_MOUNT = JSON.stringify({ mcpServers: { scp: { command: "swarm", args: ["mcp"] } } })

/** a machine Muse has its mount on, with the default broker its shim would reach */
async function museMachine(m: Machine) {
  mkdirSync(join(m.env.XDG_CONFIG_HOME!, "muse"), { recursive: true })
  writeFileSync(join(m.env.XDG_CONFIG_HOME!, "muse", "settings.json"), MUSE_MOUNT)
  await broker(m, join(m.root, ".local", "state", "scp"))
}

describe.skipIf(!swarmBinary || !node)("swarm muse: the native swarm runs it as the TypeScript CLI does", () => {
  test("a serve that dies is named with its stderr, whichever of its pipe and its exit came first", async () => {
    const m = machine("native")
    await museMachine(m)
    const died = await run(m, "muse", [], { FAKE_APP: "die" })
    expect(died.code).toBe(125)
    expect(died.stderr).toContain("swarm muse: muse serve failed\nserve boom\n")
  })

  test("usage errors and mount hints", async () => {
    await same(
      each("muse", [
        [["--name"]],
        [["--name", "me"]],
        [["--as=Bad Name"]],
        [["--resume"]],
        [["--under"]],
        [["--root", "--under=lead"]],
        [["--approval-mode", "yes"]],
        [["--contributor-mode"]],
        [["--contributor-mode", "max"]],
        [["--contributor-mode=max"]],
      ]),
      async (m) => {
        await museMachine(m)
      },
    )
    await same(each("muse", [[[]]]))
    await same(each("muse", [[[]]]), (m) => {
      mkdirSync(join(m.env.XDG_CONFIG_HOME!, "muse"), { recursive: true })
      writeFileSync(join(m.env.XDG_CONFIG_HOME!, "muse", "settings.json"), "[1]")
    })
  })

  test("a serve that fails says why", async () => {
    await same(
      each("muse", [
        [[], { SCP_MUSE_BIN: "/nonexistent/muse" }],
        [[], { FAKE_APP: "refuse" }],
        [[], { FAKE_APP: "unnamed" }],
      ]),
      museMachine,
    )
  })

  test("a session: its arguments, launch file, approvals, messages and a signal end it with 0", async () => {
    const out = await same(async (m) => {
      const steps: unknown[] = []
      const claimed = shim(m, "muse.pid", "lead", "muse")
      steps.push(await supervise(m, "muse", ["--name=lead", "--approval-mode=never", "--model", "m", "--", "--provider", "x"], WAITING))
      ;(await claimed).close()
      const again = shim(m, "muse.pid", "muse-work-dir", "muse")
      steps.push(await supervise(m, "muse", ["--resume", "s-9", "--contributor-mode=on"], WAITING, { SCP_DIR: join(m.root, "other") }, "SIGINT"))
      ;(await again).close()
      return steps
    }, museMachine)
    const first = out[0] as { code: number; stdout: string; stderr: string; records: Record<string, string> }
    expect(first.code).toBe(0)
    expect(first.stdout).toBe("hello from muse\n")
    expect(first.stderr).toContain("declined rm -rf")
    expect(first.records["muse.args"]).toContain("--disable-request-user-input")
    expect(first.records["launch.log"]).toContain('"name":"lead"')
  })

  test("a stdout nobody reads never holds up a signal", async () => {
    const m = machine("native")
    await museMachine(m)
    let client: RelayClient | undefined
    await blocked(m, "muse", [], {}, async () => {
      client = await shim(m, "muse.pid", "muse-work-dir", "muse")
    })
    client?.close()
  })

  test("a relay message wakes the session, retried when it is busy", async () => {
    const out = await same(async (m) => {
      const claimed = shim(m, "muse.pid", "lead", "muse")
      const waited = supervise(m, "muse", ["--name", "lead"], /$^/, { FAKE_APP: "busy" })
      const client = await claimed
      await until(() => waited.stderr().includes("waiting for messages"))
      await send(m, "me/lead", "ping")
      await until(() => existsSync(join(m.root, "wire.log")) && (readFileSync(join(m.root, "wire.log"), "utf8").match(/turn\/start/g)?.length ?? 0) >= 2)
      waited.stop()
      const done = await waited
      client.close()
      return [done]
    }, museMachine)
    expect((out[0] as { records: Record<string, string> }).records["wire.log"]).toContain("ping")
  })
})

/** a stand-in T3 Code server: answers the projection, streams the shell, and logs what it was sent */
function t3Server(m: Machine, script: { token?: string; fail?: string; ended?: boolean; deleted?: boolean } = {}) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (request.headers.get("authorization") !== `Bearer ${script.token ?? "tok-1"}`) return new Response("no", { status: 401 })
      if (new URL(request.url).search !== "?orchestrationProtocol=2") return new Response("no", { status: 404 })
      return server.upgrade(request) ? undefined : new Response("no", { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw))
        appendFileSync(join(m.root, "wire.log"), `${String(raw)}\n`)
        const exit = (exit: unknown) => ws.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit }))
        if (message.tag === "orchestration.getThreadProjection") {
          if (script.fail) exit({ _tag: "Failure", cause: [{ error: { message: script.fail } }] })
          else exit({ _tag: "Success", value: { runs: [{ id: "run-1", status: "running" }] } })
        } else if (message.tag === "orchestration.subscribeShell") {
          ws.send(JSON.stringify({ _tag: "Ping" }))
          ws.send(
            JSON.stringify({
              _tag: "Chunk",
              requestId: message.id,
              values: [{ kind: "snapshot", snapshot: { threads: [{ id: "t-1", activeRunId: "run-2" }] } }],
            }),
          )
          if (script.deleted) ws.send(JSON.stringify({ _tag: "Chunk", requestId: message.id, values: [{ thread: { id: "t-1", deletedAt: "now" } }] }))
          if (script.ended) exit({ _tag: "Failure", cause: [{ error: "stream over" }] })
        } else if (message.tag === "orchestration.dispatchCommand") exit({ _tag: "Success", value: {} })
      },
    },
  })
  servers.push(server)
  return String(server.port)
}

const T3 = ["--thread", "t-1"]

describe.skipIf(!swarmBinary || !node)("swarm t3code: the native swarm runs it as the TypeScript CLI does", () => {
  test("usage errors and what it needs before it starts", async () => {
    await same(
      each("t3code", [
        [[]],
        [["--model"]],
        [["--thread="]],
        [["--thread"]],
        [[...T3, "--name"]],
        [[...T3, "--name", "me"]],
        [[...T3, "--root", "--under=lead"]],
        [[...T3, "--under=me/vm/Bad"]],
        [T3],
        [T3, { SCP_T3_URL: "nope" }],
        [T3, { SCP_T3_URL: "https://x" }],
      ]),
    )
    await same(async (m) => {
      const dir = join(m.root, ".t3", "userdata")
      mkdirSync(dir, { recursive: true })
      const file = join(dir, "server-runtime.json")
      const out: unknown[] = []
      for (const content of ["{", "[1]", '{"port":"x","host":"h"}', '{"port":1,"pid":999999,"host":"h"}']) {
        writeFileSync(file, content)
        out.push(await run(m, "t3code", T3))
      }
      return out
    })
  })

  test("a token comes from the variable or from t3", async () => {
    await same(async (m) => {
      const url = `http://127.0.0.1:${t3Server(m, { fail: "gone" })}`
      const empty = join(m.root, "empty")
      mkdirSync(empty)
      writeFileSync(join(m.root, "plain-file"), "")
      return [
        await run(m, "t3code", T3, { SCP_T3_URL: url, SCP_T3_TOKEN: "  tok-1 " }),
        await run(m, "t3code", T3, { SCP_T3_URL: url }),
        await run(m, "t3code", ["--base-dir=/b", ...T3], { SCP_T3_URL: url, FAKE_APP: "refuse" }),
        await run(m, "t3code", T3, { SCP_T3_URL: url, FAKE_APP: "spaced" }),
        await run(m, "t3code", T3, { SCP_T3_URL: url, PATH: empty }),
        await run(m, "t3code", T3, { SCP_T3_URL: url, SCP_T3_BIN: "/nonexistent/t3" }),
        await run(m, "t3code", T3, { SCP_T3_URL: url, SCP_T3_BIN: join(m.root, "plain-file") }),
        await run(m, "t3code", T3, { SCP_T3_URL: url, FAKE_APP: "stdin" }),
      ]
    })
  })

  test("a server that refuses, has no thread or ends its stream stops the launch", async () => {
    await same(async (m) => {
      const token = { SCP_T3_TOKEN: "tok-1" }
      return [
        await run(m, "t3code", T3, { ...token, SCP_T3_URL: "http://127.0.0.1:9" }),
        await run(m, "t3code", T3, { ...token, SCP_T3_URL: `http://127.0.0.1:${t3Server(m, { token: "other" })}` }),
        await run(m, "t3code", T3, { ...token, SCP_T3_URL: `http://127.0.0.1:${t3Server(m, { fail: "no such thread" })}` }),
        await run(m, "t3code", T3, { ...token, SCP_T3_URL: `http://127.0.0.1:${t3Server(m, { ended: true })}` }),
        await run(m, "t3code", T3, { ...token, SCP_T3_URL: `http://127.0.0.1:${t3Server(m, { deleted: true })}` }),
      ]
    }, broker)
  })

  test("a relay message becomes a user message on the thread, steering its active run", async () => {
    const out = await same(async (m) => {
      const url = `http://127.0.0.1:${t3Server(m)}`
      const env = { SCP_T3_TOKEN: "tok-1", SCP_T3_URL: url }
      const waited = supervise(m, "t3code", ["--name", "lead", ...T3], /$^/, env)
      await until(() => waited.stderr().includes("waking T3 Code thread"))
      await send(m, "me/lead", "ping")
      await until(() => existsSync(join(m.root, "wire.log")) && readFileSync(join(m.root, "wire.log"), "utf8").includes("message.dispatch"))
      waited.stop()
      return [await waited]
    }, broker)
    const first = out[0] as { code: number; records: Record<string, string> }
    expect(first.code).toBe(0)
    expect(first.records["wire.log"]).toContain("steer_active")
  })
})

/** a machine with agy's hooks in place and a broker of its own */
async function agyMachine(m: Machine) {
  const file = hooksTarget("agy", "user", m.env, m.work)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ scp: { SessionStart: [{ command: "swarm hook" }] } }))
  await broker(m)
}

describe.skipIf(!swarmBinary || !node)("swarm agy and swarm grok: the native swarm runs them as the TypeScript CLI does", () => {
  test("usage errors, refusals and what they need before they start", async () => {
    await same(
      each("agy", [
        [["--name"]],
        [["--name", "me"]],
        [["--under"]],
        [["--root", "--under=lead"]],
        [["-i"]],
        [["--continue=x"]],
        [["remote-control"]],
        [["-p"]],
        [["--conversation"]],
        [[], { SCP_AGY_BIN: "", PATH: "/nonexistent" }],
        [["-p", "hi"]],
      ]),
    )
    await same(each("grok", [[["-c"]], [["--fork-session"]], [["-s"]], [["--prompt-file"]], [[], { PATH: "/nonexistent" }]]))
    await same(each("agy", [[[]]]), async (m) => {
      const file = hooksTarget("agy", "user", m.env, m.work)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ scp: { enabled: false, SessionStart: [{}] } }))
    })
  })

  test("agy: a prompt is the first turn and each message resumes the conversation its hooks reported", async () => {
    const out = await same(async (m) => {
      const waited = supervise(m, "agy", ["--name", "w", "--", "--model", "m", "-p", "hi", "--", "tail"], /$^/)
      await until(() => turns(m) === 1)
      await send(m, "me/w", "ping")
      await until(() => turns(m) === 2)
      waited.stop()
      return [await waited]
    }, agyMachine)
    expect((out[0] as { records: Record<string, string> }).records["turns.log"]).toContain('"--conversation","conv-1"')
  })

  test("agy: without a prompt the first message opens the conversation, and an unreported one stops it", async () => {
    await same(async (m) => {
      const waited = supervise(m, "agy", ["--name", "w"], /$^/, { FAKE_NO_CONVERSATION: "1" })
      await until(() => waited.stderr().includes("waiting for messages"))
      await send(m, "me/w", "ping")
      return [await waited]
    }, agyMachine)
  })

  test("grok: a chosen session, a failed turn and a binary that will not start", async () => {
    await same(async (m) => {
      const steps: unknown[] = []
      const waited = supervise(m, "grok", ["--name", "g", "-s", "s1"], /$^/)
      await until(() => waited.stderr().includes("waiting for messages"))
      await send(m, "me/g", "ping")
      await until(() => turns(m) === 1)
      await send(m, "me/g", "pong")
      await until(() => turns(m) === 2)
      await send(m, "me/g", "please-fail")
      steps.push(await waited)
      steps.push(await run(m, "grok", ["--resume=r1", "-p", "hi", "--allow", "x"], { SCP_GROK_BIN: "/nonexistent/grok" }))
      steps.push(await run(m, "grok", ["-p", "hi"], { FAKE_CODE: "6" }))
      return steps
    }, broker)
  })

  test("a signal stops the waiting launcher with 0", async () => {
    await same(
      async (m) => [await supervise(m, "grok", ["--name", "g"], WAITING), await supervise(m, "agy", ["--name", "a"], WAITING, {}, "SIGINT")],
      agyMachine,
    )
  })
})

/** the plugin OpenCode would load, for the user */
function opencodeFile(m: Machine, content: string) {
  const file = hooksTarget("opencode", "user", m.env, m.work)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

describe.skipIf(!swarmBinary || !node)("swarm opencode and swarm pi: the native swarm runs them as the TypeScript CLI does", () => {
  test("opencode: what it needs before it starts", async () => {
    await same(each("opencode", [[[], { PATH: "/nonexistent" }], [["--name"]], [["--as", "me"]], [["--root", "--under=x"]], [[]]]))
    await same(each("opencode", [[[]]]), (m) => opencodeFile(m, "// another plugin"))
  })

  test("opencode: arguments, environment and exit code", async () => {
    const out = await same(
      each("opencode", [
        [["--name", "lead", "run", "--as=me/other", "--", "--name", "x"], { FAKE_CODE: "7" }],
        [["-c", "--root"]],
        [["--under=lead", "--session=s"]],
        [[], { SCP_OPENCODE_BIN: "/nonexistent/opencode" }],
      ]),
      async (m) => {
        opencodeFile(m, opencodePlugin({ blockStop: true }))
        mkdirSync(join(m.env.XDG_CONFIG_HOME!, "opencode"), { recursive: true })
        await broker(m)
      },
    )
    expect((out[0] as { code: number }).code).toBe(7)
    await same(each("opencode", [[[]]]), async (m) => {
      opencodeFile(m, opencodePlugin())
      writeFileSync(join(m.work, "opencode.json"), JSON.stringify({ mcp: { scp: { type: "local", command: ["swarm", "mcp"] } } }))
      await broker(m)
    })
  })

  test("pi: arguments, environment and exit code", async () => {
    const out = await same(
      each("pi", [
        [["--name"]],
        [["--as", "me"]],
        [["--root", "--under=x"]],
        [["--name=lead", "--model", "m", "--name", "session"], { FAKE_CODE: "7" }],
        [["--as", "me/lead", "--", "-c"]],
        [["-c"], { SCP_PI_EXTENSION: "/x/ext.ts" }],
        [["--under=lead", "--resume"]],
        [[], { SCP_PI_BIN: "/nonexistent/pi" }],
      ]),
      broker,
    )
    expect((out[3] as { code: number }).code).toBe(7)
  })

  test("pi: the extension the CLI bundles is found through a relative or linked launcher", async () => {
    await same(async (m) => {
      const link = join(m.root, "swarm-link")
      symlinkSync(dist, link)
      return [
        await run(m, "pi", [], { SCP_CLI_ARGV: JSON.stringify([node, relative(m.work, dist)]) }),
        await run(m, "pi", [], { SCP_CLI_ARGV: JSON.stringify([node, link]) }),
      ]
    }, broker)
  })

  test("a bare launcher word never reads the working directory", async () => {
    const m = machine("native")
    await broker(m)
    writeFileSync(join(m.work, "pi-extension.js"), "// planted")
    const out = await run(m, "pi", [], { SCP_CLI_ARGV: JSON.stringify(["swarm"]) })
    expect(out.records["turns.log"]).toContain("<root>/relay/pi/extension-")
  })

  test("the native swarm embeds the extension the CLI bundles, and writes it to the relay directory", async () => {
    const bundled = readFileSync(join(dirname(dist), "pi-extension.js"), "utf8")
    expect(readFileSync(join(import.meta.dir, "..", "..", "..", "crates", "scp-cli", "src", "launch", "pi-extension.txt"), "utf8")).toBe(bundled)
    const m = machine("native")
    await broker(m)
    delete m.env.SCP_CLI_ARGV
    const out = await run(m, "pi", ["-c"])
    const file = out.records["turns.log"]!.split("\n")[0]!
    const [, path] = JSON.parse(file) as string[]
    expect(path!.startsWith("<root>/relay/pi/extension-")).toBe(true)
    const written = path!.replace("<root>", m.root)
    expect(readFileSync(written, "utf8")).toBe(bundled)
    expect(statSync(written).mode & 0o777).toBe(0o600)
  })
})
