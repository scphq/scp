import { afterEach, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const cli = join(import.meta.dir, "cli.ts")
const bin = join(import.meta.dir, "..", "node_modules", ".bin", "codex")
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Json = Record<string, unknown>
type ModelRequest = { input: Json[] }

function mockModel() {
  const requests: ModelRequest[] = []
  let seq = 0
  const event = (type: string, data: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") return new Response("not found", { status: 404 })
      const body = (await request.json()) as ModelRequest
      requests.push(body)
      const n = ++seq
      const last = body.input.at(-1)
      const user = body.input.findLast((item) => item.role === "user")
      const item =
        last?.type !== "function_call_output" && JSON.stringify(user).includes("<relay-message")
          ? {
              type: "function_call",
              id: `fc_${n}`,
              call_id: `call_${n}`,
              namespace: "mcp__scp",
              name: "relay_reply",
              arguments: JSON.stringify({ id: "last", body: "pong" }),
            }
          : { type: "message", role: "assistant", id: `msg_${n}`, content: [{ type: "output_text", text: "done" }] }
      return new Response(
        [
          event("response.created", { response: { id: `resp_${n}` } }),
          event("response.output_item.done", { item }),
          event("response.completed", {
            response: {
              id: `resp_${n}`,
              usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 },
            },
          }),
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  cleanups.push(() => {
    server.stop(true)
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests }
}

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

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function fixture(interactive: boolean) {
  const root = mkdtempSync(join(tmpdir(), "scp-codex-e2e-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const model = mockModel()
  const cwd = join(root, "work")
  mkdirSync(cwd)
  const home = join(root, ".codex")
  mkdirSync(home)
  writeFileSync(
    join(home, "config.toml"),
    `model = "mock-model"
model_provider = "mock"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.mock]
name = "mock"
base_url = ${JSON.stringify(model.url)}
wire_api = "responses"
[mcp_servers.scp]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(cli)}, "mcp", "--harness", "codex"]
`,
  )
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    CODEX_HOME: home,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_STATE_HOME: join(root, ".state"),
    XDG_DATA_HOME: join(root, ".data"),
    XDG_CACHE_HOME: join(root, ".cache"),
    SCP_DIR: join(root, "scp"),
    SCP_IDLE: "30s",
    SCP_CODEX_BIN: bin,
  }
  for (const key of ["SCP_SESSION", "SCP_GRANT", "SCP_PARENT", "SCP_NAME", "SCP_HARNESS", "CODEX_THREAD_ID"]) delete env[key]
  const log = join(root, "tui.log")
  const pids = join(root, "pids")
  if (interactive) {
    const tui = join(root, "tui.ts")
    writeFileSync(
      tui,
      `import { appendFileSync } from "node:fs"
import { CodexSocket } from ${JSON.stringify(join(import.meta.dir, "codex.ts"))}
appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n")
const socket = new CodexSocket(process.argv[2].replace(/^unix:\\/\\//, ""), (message) => {
  if (message.method) appendFileSync(${JSON.stringify(log)}, JSON.stringify(message) + "\\n")
  if (message.id !== undefined && message.method) socket.send({ id: message.id, result: { decision: "accept" } })
})
await socket.ready
await socket.request("initialize", { clientInfo: { name: "scp-test-tui", version: "0.1.0" } })
socket.send({ method: "initialized" })
await socket.request("thread/start", { cwd: ${JSON.stringify(cwd)}, approvalPolicy: "never" })
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: "test/ready" }) + "\\n")
process.on("SIGTERM", () => { socket.close(); process.exit(0) })
`,
    )
    const wrapper = join(root, "codex.sh")
    writeFileSync(
      wrapper,
      `#!/bin/sh
remote=0
for arg in "$@"; do
  if [ "$remote" = 1 ]; then exec ${quote(process.execPath)} ${quote(tui)} "$arg"; fi
  if [ "$arg" = --remote ]; then remote=1; fi
done
echo $$ >> ${quote(pids)}
exec ${quote(bin)} "$@"
`,
      { mode: 0o700 },
    )
    env.SCP_CODEX_BIN = wrapper
  }
  const children: ChildProcess[] = []
  const swarm = async (...args: string[]) => {
    const child = spawn(process.execPath, ["--no-env-file", cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    children.push(child)
    let stdout = ""
    let stderr = ""
    child.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString()
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve)
      child.once("error", reject)
    })
    clearTimeout(timer)
    return { stdout, stderr, code }
  }
  let diagnostics = ""
  const launcher = spawn(process.execPath, ["--no-env-file", cli, "codex", ...(!interactive ? ["--headless"] : []), "--name", "cx"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(launcher)
  launcher.stderr!.on("data", (data: Buffer) => {
    diagnostics += data.toString()
  })
  let output = ""
  launcher.stdout!.on("data", (data: Buffer) => {
    output += data.toString()
  })
  cleanups.push(async () => {
    for (const child of children) await stop(child)
    if (existsSync(pids))
      for (const line of readFileSync(pids, "utf8").trim().split("\n")) {
        const pid = Number(line)
        if (pid > 1) {
          try {
            process.kill(pid, "SIGTERM")
          } catch {}
        }
      }
    const lock = join(env.SCP_DIR!, "broker.lock")
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8").split(":")[0])
      if (pid > 1) {
        try {
          process.kill(pid, "SIGTERM")
        } catch {}
      }
    }
  })
  const logItems = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
      : []
  const alive = () => {
    if (launcher.exitCode !== null || launcher.signalCode !== null) throw new Error(`launcher exited: ${diagnostics}`)
  }
  return { model, swarm, logItems, diagnostics: () => diagnostics, output: () => output, alive }
}

for (const interactive of [false, true]) {
  test.skipIf(!existsSync(bin))(
    interactive ? "codex remote TUI receives a pushed turn and its reply" : "headless codex wakes, replies and injects the message once",
    async () => {
      const f = fixture(interactive)
      await until(
        async () => {
          f.alive()
          const list = await f.swarm("list", "--as", "tester", "--all", "--json")
          return (
            list.stdout.includes('"me/cx"') &&
            (interactive ? f.logItems().some((item) => item.method === "test/ready") : f.diagnostics().includes("waiting for messages"))
          )
        },
        30_000,
        "the codex endpoint and thread",
      )
      expect(f.model.requests).toHaveLength(0)
      const send = await f.swarm("send", "--as", "tester", "cx", "ping")
      expect(send.code, send.stderr).toBe(0)
      await until(
        async () => {
          f.alive()
          const inbox = await f.swarm("inbox", "--as", "tester", "--keep", "--json")
          const messages = (JSON.parse(inbox.stdout || "{}") as { messages?: { from: { address: string }; body: { text: string } }[] }).messages ?? []
          return messages.some((message) => message.from.address === "me/cx" && message.body.text === "pong")
        },
        60_000,
        "pong from cx",
      )
      if (interactive) {
        await until(
          () => f.logItems().some((item) => item.method === "item/completed" && ((item.params as Json).item as Json).type === "agentMessage"),
          10_000,
          "the TUI agent message",
        )
        expect(f.logItems().some((item) => item.method === "turn/started")).toBe(true)
      } else await until(() => f.output().includes("done"), 10_000, "the headless agent message")
      const turnRequests = f.model.requests.filter((request) => request.input.at(-1)?.type !== "function_call_output")
      const deliveries = turnRequests.flatMap((request) =>
        request.input.filter((item) => item.role === "user" && JSON.stringify(item).includes("<relay-message")),
      )
      expect(deliveries).toHaveLength(1)
    },
    120_000,
  )
}
