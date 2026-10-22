import { afterEach, expect, test } from "bun:test"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

type Json = Record<string, unknown>
const cli = join(import.meta.dir, "cli.ts")
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(probe: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await probe()) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
  child.kill("SIGTERM")
  await exited
  clearTimeout(timer)
}

/** a throwaway HOME and private broker, and the swarm CLI run in them */
function sandbox(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "scp-t3-e2e-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, "work")
  mkdirSync(cwd)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_STATE_HOME: join(root, ".state"),
    XDG_DATA_HOME: join(root, ".data"),
    XDG_CACHE_HOME: join(root, ".cache"),
    SCP_DIR: join(root, "scp"),
    SCP_IDLE: "30s",
  }
  for (const key of [
    "SCP_SESSION",
    "SCP_GRANT",
    "SCP_PARENT",
    "SCP_NAME",
    "SCP_HARNESS",
    "SCP_HARNESS_PID",
    "SCP_TRANSPORT",
    "SCP_T3_URL",
    "SCP_T3_TOKEN",
    "T3CODE_HOME",
  ])
    delete env[key]
  for (const key of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_THREAD_ID|CODEX_INTERNAL_)/.test(key)) delete env[key]
  Object.assign(env, extra)
  const swarm = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, cwd, encoding: "utf8", timeout: 30_000 })
  cleanups.push(() => {
    swarm("daemon", "stop")
  })
  /** a swarm command that must not block this process, where the fake server runs */
  const swarmAsync = async (args: string[], more: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, cli, ...args], { env: { ...env, ...more }, cwd, stdout: "pipe", stderr: "pipe" })
    const [stderr, status] = await Promise.all([new Response(child.stderr).text(), child.exited])
    return { status, stderr }
  }
  const launch = (args: string[], more: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [cli, "t3code", ...args], { env: { ...env, ...more }, cwd, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr!.on("data", (data) => (stderr += String(data)))
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
    cleanups.push(() => stop(child))
    return { child, exited, stderr: () => stderr }
  }
  type Listed = { address: string; harness: string; wake: string | null; parent?: string | null }
  const listed = () => (JSON.parse(swarm("list", "--as", "lead", "--all", "--json").stdout || "{}") as { endpoints?: Listed[] }).endpoints ?? []
  return { root, cwd, env, swarm, swarmAsync, launch, listed }
}

/** a fake T3 Code server, not the real one: Effect RPC JSON framing over a WebSocket, one known thread, and a log of dispatched commands */
function fakeT3(base: string, thread: string) {
  const dispatched: Json[] = []
  let fail = 0
  let socket: { send(text: string): void; close(): void } | undefined
  let shell: string | undefined
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, srv) {
      if (new URL(request.url).searchParams.get("orchestrationProtocol") !== "2") return new Response("protocol", { status: 426 })
      if (request.headers.get("authorization") !== "Bearer fake-token") return new Response("no", { status: 401 })
      if (srv.upgrade(request)) return
      return new Response("upgrade required", { status: 400 })
    },
    websocket: {
      open(ws) {
        socket = ws
      },
      message(ws, data) {
        const message = JSON.parse(String(data)) as Json
        if (message._tag !== "Request") return
        const exit = (exit: Json) => ws.send(JSON.stringify({ _tag: "Exit", requestId: message.id, exit }))
        const payload = message.payload as Json
        if (message.tag === "orchestration.getThreadProjection") {
          if (payload.threadId === thread) exit({ _tag: "Success", value: { thread: { id: thread }, runs: [] } })
          else exit({ _tag: "Failure", cause: [{ _tag: "Fail", error: { message: `No orchestration projection exists for thread ${payload.threadId}.` } }] })
        } else if (message.tag === "orchestration.subscribeShell") {
          shell = String(message.id)
          ws.send(
            JSON.stringify({
              _tag: "Chunk",
              requestId: shell,
              values: [{ kind: "snapshot", snapshot: { threads: [{ id: thread, activeRunId: null }], projects: [] } }],
            }),
          )
        } else if (message.tag === "orchestration.dispatchCommand") {
          dispatched.push(payload)
          if (fail > 0) {
            fail--
            exit({ _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "provider busy" } }] })
          } else exit({ _tag: "Success", value: { sequence: dispatched.length } })
        }
      },
    },
  })
  cleanups.push(() => server.stop(true))
  mkdirSync(join(base, "userdata"), { recursive: true })
  writeFileSync(join(base, "userdata", "server-runtime.json"), JSON.stringify({ version: 1, pid: process.pid, host: "127.0.0.1", port: server.port }))
  return {
    dispatched,
    failNext: (n: number) => (fail = n),
    running: (runId: string | null) =>
      socket?.send(JSON.stringify({ _tag: "Chunk", requestId: shell, values: [{ kind: "thread.updated", thread: { id: thread, activeRunId: runId } }] })),
    drop: () => socket?.close(),
  }
}

test("swarm t3code (fake T3 Code server) refuses without a server or the thread, then starts, steers and retries the thread's turns", async () => {
  const s = sandbox({ SCP_T3_TOKEN: "fake-token" })
  const base = join(s.root, "t3base")
  const missing = s.swarm("t3code", "--name", "t3w", "--thread", "th-1", "--base-dir", base)
  expect(missing.status).not.toBe(0)
  expect(missing.stderr).toContain("no T3 Code server runs for")
  const t3 = fakeT3(base, "th-1")
  const unknown = await s.swarmAsync(["t3code", "--name", "t3w", "--thread", "th-2", "--base-dir", base])
  expect(unknown.status).not.toBe(0)
  expect(unknown.stderr).toContain("T3 Code has no thread th-2")
  const refused = await s.swarmAsync(["t3code", "--thread", "th-1", "--base-dir", base], { SCP_T3_TOKEN: "wrong" })
  expect(refused.status).not.toBe(0)
  expect(refused.stderr).toContain("the token was refused")

  const run = s.launch(["--name", "t3w", "--thread", "th-1", "--base-dir", base])
  await until(() => run.stderr().includes("me/t3w waking T3 Code thread th-1"), 30_000, "the waking line")
  const endpoint = s.listed().find((e) => e.address === "me/t3w")
  expect([endpoint?.harness, endpoint?.wake]).toEqual(["t3code", "t3code"])

  expect(s.swarm("send", "--as", "tester", "t3w", "first message").status).toBe(0)
  await until(() => t3.dispatched.length >= 1, 30_000, "the first dispatch")
  expect(t3.dispatched[0]).toMatchObject({ type: "message.dispatch", threadId: "th-1", dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" })
  expect(t3.dispatched[0]!.text).toContain("first message")
  expect(t3.dispatched[0]!.text).toContain("<relay-message")

  t3.running("run-1")
  t3.failNext(1)
  await Bun.sleep(200)
  expect(s.swarm("send", "--as", "tester", "t3w", "second message").status).toBe(0)
  await until(() => t3.dispatched.length >= 3, 30_000, "the retried steer")
  expect(t3.dispatched.slice(1).map((c) => [c.dispatchMode, String(c.text).includes("second message")])).toEqual([
    [{ type: "steer_active", targetRunId: "run-1" }, true],
    [{ type: "steer_active", targetRunId: "run-1" }, true],
  ])
  expect(run.stderr()).toContain("did not take the message (provider busy); retrying every 2 s")
  await Bun.sleep(2500)
  expect(t3.dispatched).toHaveLength(3)

  t3.drop()
  expect(await run.exited).toBe(1)
  expect(run.stderr()).toContain("the T3 Code connection closed")
}, 120_000)

test("swarm t3code (fake T3 Code server) under spawn-env joins under the spawner, and SIGTERM exits 0", async () => {
  const s = sandbox({ SCP_T3_TOKEN: "fake-token" })
  const base = join(s.root, "t3base")
  const t3 = fakeT3(base, "th-1")
  const issued = s.swarm("spawn-env", "--as", "lead", "--name", "kid")
  expect(issued.status).toBe(0)
  const grant = Object.fromEntries(
    issued.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  )
  const run = s.launch(["--thread", "th-1", "--base-dir", base], grant)
  await until(() => run.stderr().includes("waking T3 Code thread th-1"), 30_000, "the waking line")
  const kid = s.listed().find((e) => e.address === "me/kid")
  expect([kid?.wake, kid?.parent]).toEqual(["t3code", "me/lead"])
  expect(s.swarm("send", "--as", "lead", "kid", "hello worker").status).toBe(0)
  await until(() => t3.dispatched.length >= 1, 30_000, "the dispatch")
  expect(t3.dispatched[0]!.text).toContain("hello worker")
  run.child.kill("SIGTERM")
  expect(await run.exited).toBe(0)
}, 120_000)

/** the real t3 binary on PATH (the test preload drops SCP_* variables, so $SCP_T3_BIN cannot name it here) */
const t3Bin = Bun.which("t3") ?? undefined

test.skipIf(!t3Bin)(
  "swarm t3code against the real t3 serve (throwaway HOME and base dir, telemetry off, no provider on PATH): a sent message lands in the thread once (skipped without t3 on PATH)",
  async () => {
    const shim = realpathSync(t3Bin!)
    const bin = shim.endsWith(".js")
      ? join(dirname(require.resolve(`@t3code/t3-${process.platform}-${process.arch}/package.json`, { paths: [dirname(shim)] })), "t3")
      : shim
    const s = sandbox()
    const base = join(s.root, "t3base")
    const t3env: NodeJS.ProcessEnv = { HOME: s.root, PATH: "/usr/bin:/bin", T3CODE_TELEMETRY_ENABLED: "false", TMPDIR: tmpdir() }
    const project = join(s.cwd, "proj")
    mkdirSync(project)
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    const serve = spawn(bin, ["serve", "--no-browser", "--port", String(port), "--host", "127.0.0.1", "--base-dir", base, s.cwd], {
      env: t3env,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let serveLog = ""
    serve.stderr!.on("data", (data) => (serveLog += String(data)))
    cleanups.push(() => stop(serve))
    const runtime = join(base, "userdata", "server-runtime.json")
    await until(() => existsSync(runtime) && JSON.parse(readFileSync(runtime, "utf8")).port === port, 90_000, `t3 serve to start (${serveLog.slice(-400)})`)
    const added = spawnSync(bin, ["project", "add", "--base-dir", base, "--title", "e2e", project], { env: t3env, encoding: "utf8", timeout: 60_000 })
    expect(added.status, added.stderr).toBe(0)
    const projectId = /Added project ([0-9a-f-]{36})/.exec(added.stdout)?.[1]
    expect(projectId).toBeDefined()

    const { T3Socket, t3Token } = await import("./t3code")
    const token = t3Token({ ...t3env, SCP_T3_BIN: bin }, base)
    const socket = new T3Socket({ host: "127.0.0.1", port }, token)
    cleanups.push(() => socket.close())
    await socket.ready
    const threadId = crypto.randomUUID()
    await socket.request("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: crypto.randomUUID(),
      createdBy: "user",
      creationSource: "server",
      threadId,
      projectId: projectId!,
      title: "e2e",
      modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    })

    const run = s.launch(["--name", "real", "--thread", threadId, "--base-dir", base], { SCP_T3_BIN: bin, PATH: "/usr/bin:/bin" })
    await until(() => run.stderr().includes(`me/real waking T3 Code thread ${threadId}`), 60_000, `the waking line (${run.stderr()})`)
    expect(s.listed().find((e) => e.address === "me/real")?.wake).toBe("t3code")
    expect(s.swarm("send", "--as", "tester", "real", "hello real t3").status).toBe(0)
    const userTexts = async () => {
      const projection = await socket.request("orchestration.getThreadProjection", { threadId })
      return ((projection.messages as Json[]) ?? []).filter((m) => m.role === "user").map((m) => String(m.text))
    }
    await until(async () => (await userTexts()).some((text) => text.includes("hello real t3")), 30_000, "the message in the thread")
    await Bun.sleep(2500)
    expect((await userTexts()).filter((text) => text.includes("hello real t3"))).toHaveLength(1)
    run.child.kill("SIGTERM")
    expect(await run.exited).toBe(0)
  },
  240_000,
)
