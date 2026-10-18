import { afterEach, expect, test } from "bun:test"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const pkg = join(import.meta.dir, "..")
const cli = join(pkg, "..", "cli", "src", "cli.ts")
const piBin = join(pkg, "node_modules", ".bin", "pi")
const node = Bun.which("node")
const runnable = node !== null && existsSync(piBin)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

type Chat = { messages: { role: string; content?: unknown }[] }

/** an OpenAI-compatible chat endpoint: it answers a relay message by calling relay_reply, then ends the turn */
function mockModel() {
  const requests: Chat[] = []
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as Chat
      requests.push(body)
      const last = body.messages[body.messages.length - 1]
      const sse =
        last?.role === "tool"
          ? [chunk({ role: "assistant", content: "replied" }), chunk({}, "stop")]
          : [
              chunk({
                role: "assistant",
                tool_calls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "relay_reply", arguments: JSON.stringify({ id: "last", body: "pong" }) } },
                ],
              }),
              chunk({}, "tool_calls"),
            ]
      return new Response(`${sse.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

async function until<T>(probe: () => T | undefined, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = probe()
    if (value !== undefined) return value
    await Bun.sleep(200)
  }
  throw new Error(`timed out waiting for ${what}`)
}

test.skipIf(!runnable)(
  "a message to an idle pi session wakes it to run a turn and reply, and one sent while it was closed arrives when it starts again (skipped without node or the pi devDependency)",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "scp-pi-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const model = mockModel()
    cleanups.push(model.stop)
    const agentDir = join(root, "agent")
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({ providers: { mock: { baseUrl: model.url, api: "openai-completions", apiKey: "none", models: [{ id: "mock" }] } } }),
    )
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: root,
      XDG_CONFIG_HOME: join(root, ".config"),
      XDG_STATE_HOME: join(root, ".local", "state"),
      XDG_DATA_HOME: join(root, ".local", "share"),
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      SCP_DIR: join(root, "scp"),
      SCP_IDLE: "30s",
      SCP_PI_SWARM: JSON.stringify(["bun", cli]),
      SCP_PI_BIN: piBin,
      SCP_PI_EXTENSION: join(pkg, "src", "index.ts"),
    }
    const swarm = (...args: string[]) => spawnSync("bun", [cli, ...args], { env, encoding: "utf8", timeout: 30_000 })
    const running: ChildProcess[] = []
    const startPi = () => {
      const child = spawn(
        "bun",
        [cli, "pi", "--name", "pidemo", "--", "--mode", "rpc", "--provider", "mock", "--model", "mock", "--no-session", "-nc", "-ns", "-np", "--no-themes"],
        { cwd: root, env, stdio: ["pipe", "ignore", "ignore"] },
      )
      running.push(child)
      return child
    }
    const replies = () =>
      (
        JSON.parse(swarm("inbox", "--as", "tester", "--json", "--keep").stdout || "{}") as {
          messages?: { from: { address: string }; body: { text: string } }[]
        }
      ).messages?.filter((message) => message.from.address === "me/pidemo" && message.body.text === "pong").length ?? 0
    const pi = startPi()
    cleanups.push(() => {
      for (const child of running) child.kill()
      swarm("daemon", "stop")
    })
    await until(() => (swarm("list", "--as", "tester", "--json").stdout.includes("pidemo") ? true : undefined), 30_000, "the pi endpoint")
    await Bun.sleep(1000)
    expect(model.requests.length).toBe(0)
    expect(swarm("send", "--as", "tester", "pidemo", "ping").status).toBe(0)
    await until(() => (replies() >= 1 ? true : undefined), 45_000, "the reply")
    expect(JSON.stringify(model.requests[0]!.messages)).toContain("ping")

    const exited = new Promise((resolve) => pi.once("exit", resolve))
    pi.kill()
    await exited
    expect(swarm("send", "--as", "tester", "pidemo", "while you were away").status).toBe(0)
    startPi()
    await until(() => (replies() >= 2 ? true : undefined), 45_000, "the reply after a restart")
    expect(model.requests.some((request) => JSON.stringify(request.messages).includes("while you were away"))).toBe(true)
  },
  120_000,
)
