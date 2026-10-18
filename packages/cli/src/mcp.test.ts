import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { TOOLS } from "@scp-dev/mcp"
import { PREAMBLE } from "@scp-dev/core"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { harnessPid } from "./identity"
import { spawnWords } from "./mcp"

setDefaultTimeout(30_000)

const entry = join(import.meta.dir, "cli.ts")
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_THREAD_ID)/

/** this process's environment without any harness's markers, so detection sees only what a test sets */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) env[key] = value
  return { ...env, ...extra }
}

type Rpc = { id?: number; method?: string; result?: { content?: { text: string }[]; isError?: boolean; [key: string]: unknown }; error?: { code: number } }

/** `swarm mcp` as a child process with a tiny line client over its stdio */
function spawnShim(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, "mcp", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: cleanEnv(env) })
  let stdout = ""
  let stderr = ""
  const pump = async (stream: ReadableStream<Uint8Array>, add: (text: string) => void) => {
    const reader = stream.getReader()
    for (let read = await reader.read(); !read.done; read = await reader.read()) add(new TextDecoder().decode(read.value))
  }
  const pumped = Promise.all([pump(child.stdout, (t) => (stdout += t)), pump(child.stderr, (t) => (stderr += t))])
  let nextId = 1
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`)
  child.stdin.flush()
  const lines = () => stdout.split("\n").filter(Boolean)
  async function request(method: string, params: object = {}): Promise<Rpc> {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    child.stdin.flush()
    for (let i = 0; i < 1500; i++) {
      const found = lines()
        .map((l) => JSON.parse(l) as Rpc)
        .find((m) => m.id === id)
      if (found) return found
      await Bun.sleep(10)
    }
    throw new Error(`no answer to ${method}; stderr: ${stderr}`)
  }
  const call = async (name: string, args: object = {}) => (await request("tools/call", { name, arguments: args })).result!
  async function stop() {
    child.stdin.end()
    const code = await child.exited
    await pumped
    return { code, stdout, stderr }
  }
  return { request, call, stop, lines, child }
}

const textOf = (result: { content?: { text: string }[] }) => result.content![0]!.text

describe("swarm mcp", () => {
  let broker: Broker
  const dir = join(process.env.HOME!, "mcp-relay")
  const env = { SCP_DIR: dir }

  beforeAll(async () => {
    broker = await startBroker({ dir, idleMs: 0, policyPath: join(process.env.HOME!, "mcp-policy.json"), log: () => {} })
  })
  afterAll(async () => {
    await broker.stop()
  })

  test("speaks MCP over stdio as an agent, and writes nothing but JSON-RPC to stdout", async () => {
    const t1 = spawnShim(["--as", "t1"], env)
    const t2 = spawnShim(["--as", "t2", "--harness", "codex"], env)
    const peer = await RelayClient.connect(broker.socket)
    try {
      const init = await t1.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } })
      expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", serverInfo: { name: "scp" } })
      const tools = (await t1.request("tools/list")).result!.tools as { name: string }[]
      expect(tools).toHaveLength(TOOLS.length)

      const whoami = textOf(await t1.call("relay_whoami"))
      expect(whoami).toContain("address: me/t1\n")
      expect(whoami).toContain("harness: mcp")
      expect(whoami).toMatch(/labels: machine=/)

      await t2.call("relay_whoami")
      expect(textOf(await t1.call("relay_send", { to: "t2", body: "from t1" }))).toContain("to me/t2")
      const inbox = textOf(await t2.call("relay_inbox", { wait_s: 5 }))
      expect(inbox.startsWith(PREAMBLE)).toBe(true)
      expect(inbox).toMatch(/<relay-message from="me\/t1" (relation="(parent|child)" )?harness="mcp"/)
      const id = /id="(msg_[^"]+)"/.exec(inbox)![1]!
      await t2.call("relay_reply", { id, body: "back to t1" })
      const back = textOf(await t1.call("relay_inbox", { wait_s: 5 }))
      expect(back).toContain('kind="reply"')
      expect(back).toContain("back to t1")

      await peer.hello({ claim: { handle: "oracle", harness: "codex" } })
      const asking = t1.call("relay_ask", { to: "oracle", body: "ready?", wait_s: 20 })
      const request = (await peer.request<{ messages: { id: string; kind: string }[] }>("inbox", { wait_s: 10 })).messages.find((m) => m.kind === "request")!
      await peer.request("send", { to: "t1", body: "ready", kind: "reply", reply_to: request.id })
      const answered = textOf(await asking)
      expect(answered.startsWith(PREAMBLE)).toBe(true)
      expect(answered).toContain('from="me/oracle"')

      await t1.call("relay_set_status", { state: "waiting", note: "on review" })
      expect(broker.core.list({ all: true }).find((e) => e.address === "me/t1")!.status).toEqual({ state: "waiting", note: "on review" })
      expect((await t1.call("relay_send", { to: "nobody", body: "x" })).isError).toBe(true)
      expect((await t1.call("relay_set_status", { state: "asleep" })).isError).toBe(true)
    } finally {
      peer.close()
      const results = [await t1.stop(), await t2.stop()]
      for (const result of results) {
        expect(result.code).toBe(0)
        for (const line of result.stdout.split("\n").filter(Boolean)) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" })
        expect(result.stdout.endsWith("\n")).toBe(true)
      }
    }
  })

  test("--channels advertises the channel capability and is refused for mcp install", async () => {
    const shim = spawnShim(["--as", "channels-test", "--channels"], env)
    try {
      const init = await shim.request("initialize", { protocolVersion: "2025-06-18" })
      expect(init.result!.capabilities).toMatchObject({ experimental: { "claude/channel": {} } })
    } finally {
      expect((await shim.stop()).code).toBe(0)
    }
    const install = spawnShim(["install", "--harness", "claude", "--channels"], env)
    expect(await install.stop()).toMatchObject({ code: 125, stdout: "" })
  })

  test("relay_spawn runs swarm spawn --bg as the calling shim's agent: it returns at once, and the handback reaches that agent; a refused spawn is the CLI's message", async () => {
    const lead = spawnShim(["--as", "mcp-lead"], env)
    const other = spawnShim(["--as", "mcp-other"], env)
    try {
      await other.call("relay_whoami")
      const began = Date.now()
      const started = await lead.call("relay_spawn", { command: ["sh", "-c", "sleep 1; echo hi"], name: "mcpw1", no_push: true })
      expect(Date.now() - began).toBeLessThan(5000)
      expect(textOf(started)).toMatch(
        /^mcpw1 started \(pid \d+\) and runs in the background: .*steer it with relay_send to mcpw1 \(it gets the message after its next tool call or before it finishes\)$/,
      )
      let handback = ""
      for (const deadline = Date.now() + 15_000; !handback.includes("worker mcpw1") && Date.now() < deadline; )
        handback += textOf(await lead.call("relay_inbox", { wait_s: 2 }))
      expect(handback).toContain('from="me/relay"')
      expect(handback).toContain("worker mcpw1 finished (exit 0), not a relay agent\n\nhi")
      expect(textOf(await other.call("relay_inbox"))).toBe("no unread messages")

      const cwd = realpathSync(mkdtempSync(join(process.env.HOME!, "mcp-cwd-")))
      await lead.call("relay_spawn", { command: ["sh", "-c", "pwd"], name: "mcpw2", no_push: true, cwd })
      let ran = ""
      for (const deadline = Date.now() + 15_000; !ran.includes("worker mcpw2") && Date.now() < deadline; )
        ran += textOf(await lead.call("relay_inbox", { wait_s: 2 }))
      expect(ran).toContain(`worker mcpw2 finished (exit 0), not a relay agent\n\n${cwd}`)

      const refused = await lead.call("relay_spawn", { command: ["sh", "-c", "exit 0"], name: "Bad Name!" })
      const cli = Bun.spawn(
        [process.execPath, "--no-env-file", entry, "spawn", "--bg", "--as", "mcp-lead", "--harness", "mcp", "--name", "Bad Name!", "--", "sh", "-c", "exit 0"],
        { env: cleanEnv(env), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      )
      const stderr = await new Response(cli.stderr).text()
      expect(refused.isError).toBe(true)
      expect(stderr.split("\n")[0]).toBe(`swarm: ${textOf(refused)}`)
    } finally {
      await lead.stop()
      await other.stop()
    }
  })

  test("a relay_spawn request maps to swarm spawn --bg words, its command after --", () => {
    expect(
      spawnWords({
        command: ["codex", "exec", "--json", "x"],
        as: "me/lead",
        harness: "claude-code",
        name: "rev",
        title: "t",
        no_push: true,
        handback_bytes: 900,
      }),
    ).toEqual([
      "--bg",
      "--as",
      "me/lead",
      "--harness",
      "claude-code",
      "--name",
      "rev",
      "--title",
      "t",
      "--no-push",
      "--handback-bytes",
      "900",
      "--",
      "codex",
      "exec",
      "--json",
      "x",
    ])
    expect(spawnWords({ command: ["claude", "-p", "x"], as: "me/lead" })).toEqual(["--bg", "--as", "me/lead", "--", "claude", "-p", "x"])
  })

  test("the shim never becomes me/: --human and a reserved --as are refused", async () => {
    for (const args of [["--human"], ["--as", "me"], ["--as", "user"]]) {
      const shim = spawnShim(args, env)
      const result = await shim.stop()
      expect(result.code).toBe(125)
      expect(result.stdout).toBe("")
    }
    const anonymous = spawnShim([], env)
    try {
      expect(textOf(await anonymous.call("relay_whoami"))).not.toMatch(/address: me\/\n/)
    } finally {
      await anonymous.stop()
    }
  })

  test("the shim's harness pid skips a shell parent, as the hooks' does", () => {
    const parents: Record<number, { ppid: number; comm: string }> = {
      500: { ppid: 900, comm: "/bin/sh" },
      501: { ppid: 901, comm: "-zsh" },
      502: { ppid: 902, comm: "node" },
      503: { ppid: 1, comm: "bash" },
    }
    const parentOf = (pid: number) => parents[pid]
    expect(harnessPid(500, parentOf)).toBe(900)
    expect(harnessPid(501, parentOf)).toBe(901)
    expect(harnessPid(502, parentOf)).toBe(502)
    expect(harnessPid(503, parentOf)).toBe(503)
    expect(harnessPid(504, parentOf)).toBe(504)
  })

  test("a shim started through a shell joins the session of hooks started through one", async () => {
    const project = join(process.env.HOME!, "mcp-shell-project")
    mkdirSync(join(project, ".git"), { recursive: true })
    const shellEnv = cleanEnv({ ...env, CLAUDECODE: "1" })
    delete shellEnv.SCP_SESSION
    const viaShell = (args: string[]) => ["sh", "-c", '"$@"; :', "sh", process.execPath, "--no-env-file", entry, ...args]
    const shim = Bun.spawn(viaShell(["mcp", "--as", "shim-sh"]), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: shellEnv, cwd: project })
    try {
      shim.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`)
      shim.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })}\n`)
      shim.stdin.flush()
      const reader = shim.stdout.getReader()
      let out = ""
      while (!out.includes('"id":1')) out += new TextDecoder().decode((await reader.read()).value)
      expect(out).toContain("me/shim-sh")
      reader.releaseLock()
      const payload = new TextEncoder().encode(
        JSON.stringify({ hook_event_name: "PostToolUse", cwd: project, tool_name: "Grep", tool_input: { pattern: "x" } }),
      )
      const hook = Bun.spawn(viaShell(["hook", "claude"]), { stdin: payload, stdout: "pipe", stderr: "pipe", env: shellEnv, cwd: project })
      expect(await hook.exited).toBe(0)
      expect(
        broker.core
          .activity({ limit: 1000 })
          .filter((r) => r.endpoint === "me/shim-sh")
          .map((r) => r.tool),
      ).toEqual(["Grep"])
    } finally {
      shim.stdin.end()
      await shim.exited
    }
  })

  test("mcp install prints the mount command per harness and runs nothing", async () => {
    const run = (args: string[]) => {
      const result = Bun.spawnSync([process.execPath, "--no-env-file", entry, "mcp", "install", ...args], {
        env: cleanEnv(env),
        stdout: "pipe",
        stderr: "pipe",
      })
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
    }
    expect(run(["--harness", "claude"]).stdout).toBe("claude mcp add scp -- swarm mcp\n")
    expect(run(["--harness", "claude", "--as", "lane-impl"]).stdout).toBe("claude mcp add scp -- swarm mcp --as lane-impl\n")
    expect(run(["--harness", "codex"]).stdout).toBe("codex mcp add scp -- swarm mcp --harness codex\n")
    expect(run(["--harness", "grok"]).stdout).toBe("grok mcp add scp -- swarm mcp --harness grok\n")
    const opencode = run(["--harness", "opencode"]).stdout
    expect(opencode.split("\n")[0]).toBe("opencode mcp add scp -- swarm mcp --harness opencode")
    expect(opencode).toContain('"command": [\n        "swarm",\n        "mcp",\n        "--harness",\n        "opencode"\n      ]')
    const muse = run(["--harness", "muse"])
    expect(muse.stdout).toContain('"mcpServers"')
    expect(muse.stdout).toContain("never add a mcp_servers key")
    expect(run(["--harness", "vim"]).code).toBe(125)
    expect(run(["--harness", "claude", "--as", "me"]).code).toBe(125)
  })
})
