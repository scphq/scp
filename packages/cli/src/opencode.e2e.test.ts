import { afterEach, expect, test } from "bun:test"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const cli = join(import.meta.dir, "cli.ts")

/** the OpenCode binary of the opencode-ai devDependency's platform package, which its skipped postinstall would have linked */
function opencodeBin(): string | undefined {
  try {
    const wrapper = createRequire(import.meta.path).resolve("opencode-ai/package.json")
    const os = process.platform === "win32" ? "windows" : process.platform
    for (const name of [`opencode-${os}-${process.arch}`, `opencode-${os}-${process.arch}-baseline`, `opencode-${os}-${process.arch}-musl`]) {
      try {
        const bin = join(dirname(createRequire(wrapper).resolve(`${name}/package.json`)), "bin", "opencode")
        if (existsSync(bin)) return bin
      } catch {}
    }
  } catch {}
  return undefined
}

const bin = opencodeBin()

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

type Chat = { messages: { role: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] }

/** an OpenAI-compatible chat endpoint: a turn with the relay tools answers by calling relay_reply, then ends; any other call gets plain text */
function mockModel() {
  const requests: Chat[] = []
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as Chat
      const reply = body.tools?.map((tool) => tool.function?.name).find((name) => name?.endsWith("relay_reply"))
      if (reply) requests.push(body)
      const last = body.messages[body.messages.length - 1]
      const sse =
        reply && last?.role !== "tool"
          ? [
              chunk({
                role: "assistant",
                tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: reply, arguments: JSON.stringify({ id: "last", body: "pong" }) } }],
              }),
              chunk({}, "tool_calls"),
            ]
          : [chunk({ role: "assistant", content: reply ? "replied" : "a title" }), chunk({}, "stop")]
      return new Response(`${sse.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await probe()
    if (value !== undefined) return value
    await Bun.sleep(200)
  }
  throw new Error(`timed out waiting for ${what}`)
}

test.skipIf(!bin)(
  "a message to an idle OpenCode session wakes it to run a turn and reply, shown once (skipped without the opencode-ai devDependency)",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "scp-opencode-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const model = mockModel()
    cleanups.push(model.stop)
    const project = join(root, "project")
    const tools = join(root, "bin")
    mkdirSync(project, { recursive: true })
    mkdirSync(tools, { recursive: true })
    writeFileSync(join(tools, "swarm"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`)
    chmodSync(join(tools, "swarm"), 0o755)
    const config = join(root, ".config")
    mkdirSync(join(config, "opencode"), { recursive: true })
    writeFileSync(
      join(config, "opencode", "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "mock/mock",
        provider: {
          mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: model.url, apiKey: "none" }, models: { mock: { name: "mock" } } },
        },
        mcp: { scp: { type: "local", command: ["swarm", "mcp", "--harness", "opencode"], enabled: true } },
      }),
    )
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      HOME: root,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: join(root, ".local", "state"),
      XDG_DATA_HOME: join(root, ".local", "share"),
      XDG_CACHE_HOME: join(root, ".cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      SCP_DIR: join(root, "scp"),
      SCP_IDLE: "60s",
    }
    for (const key of ["SCP_NAME", "SCP_SESSION", "SCP_GRANT", "SCP_PARENT", "SCP_HARNESS", "SCP_TRANSPORT", "SCP_WAKE", "OPENCODE"]) delete env[key]
    const swarm = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, cwd: root, encoding: "utf8", timeout: 30_000 })
    expect(swarm("hooks", "install", "--harness", "opencode", "--scope", "user", "--write").status).toBe(0)
    expect(existsSync(join(config, "opencode", "plugin", "scp.ts"))).toBe(true)

    let server: ChildProcess | undefined
    cleanups.push(() => {
      server?.kill()
      swarm("daemon", "stop")
    })
    server = spawn(bin!, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: project,
      env: { ...env, SCP_NAME: "ocdemo" },
      stdio: ["ignore", "pipe", "ignore"],
    })
    let out = ""
    server.stdout!.on("data", (data) => (out += String(data)))
    const base = await until(() => /listening on (http:\/\/\S+)/.exec(out)?.[1], 60_000, "opencode serve")
    const session = (await (await fetch(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as {
      id: string
    }
    expect(session.id).toBeString()
    await until(() => (swarm("list", "--as", "tester", "--json").stdout.includes("ocdemo") ? true : undefined), 30_000, "the opencode endpoint")
    await Bun.sleep(1500)
    expect(model.requests.length).toBe(0)

    expect(swarm("send", "--as", "tester", "ocdemo", "ping").status).toBe(0)
    const replies = () =>
      (
        JSON.parse(swarm("inbox", "--as", "tester", "--json", "--keep").stdout || "{}") as {
          messages?: { from: { address: string }; body: { text: string } }[]
        }
      ).messages?.filter((message) => message.from.address === "me/ocdemo" && message.body.text === "pong").length ?? 0
    await until(() => (replies() >= 1 ? true : undefined), 60_000, "the reply")
    const last = JSON.stringify(model.requests[model.requests.length - 1]!.messages)
    expect(last).toContain("ping")
    expect(last.split("<relay-message").length - 1).toBe(1)
  },
  180_000,
)
