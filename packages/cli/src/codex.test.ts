import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RelayClient, startBroker } from "@scp-dev/broker"
import { codexLaunch, CodexSocket, CodexWaker, connectCodexChannel, serverOptions } from "./codex"
import { processKey, relayIdentity } from "./identity"
import { codexOverrides, spawnEnvironment } from "./spawn"

type Json = Record<string, unknown>
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

test("codex launch parses names, headless and passthrough without inheriting the session", () => {
  const env = { PATH: "/bin", SCP_SESSION: "s", SCP_GRANT: "g", SCP_PARENT: "p", SCP_NAME: "old", SCP_CODEX_BIN: "/opt/codex" }
  expect(codexLaunch(["--name", "me/cx", "--headless", "--", "--name", "other", "--headless"], env, ["swarm"])).toEqual({
    name: "cx",
    headless: true,
    codexArgs: ["--name", "other", "--headless"],
    env: {
      PATH: "/bin",
      SCP_NAME: "cx",
      SCP_GRANT: "g",
      SCP_CODEX_BIN: "/opt/codex",
      SCP_HARNESS: "codex",
      SCP_SHIM_BINDING: expect.stringMatching(/^[0-9a-f]{32}$/),
    },
  })
  for (const args of [["--as", "cx"], ["--as=me/cx"], ["--name=cx"]]) expect(codexLaunch(args, {}, []).name).toBe("cx")
  expect(codexLaunch(["-m", "mock", "--resume", "thread"], {}, [])).toEqual({
    headless: false,
    resume: "thread",
    codexArgs: ["resume", "thread", "-m", "mock"],
    env: { SCP_HARNESS: "codex", SCP_SHIM_BINDING: expect.stringMatching(/^[0-9a-f]{32}$/) },
  })
  expect(codexLaunch(["--headless", "--resume=thread", "-m", "mock"], {}, [])).toMatchObject({ resume: "thread", codexArgs: ["-m", "mock"] })
  expect(env.SCP_SESSION).toBe("s")
  expect(() => codexLaunch(["--name"], {}, [])).toThrow("takes a name")
  expect(() => codexLaunch(["--as", "Bad Name"], {}, [])).toThrow("not a valid agent handle")
  expect(() => codexLaunch(["--name="], {}, [])).toThrow("not a valid agent handle")
})

test("codex launch carries the grant and a fresh binding key into the app-server and shim environment", () => {
  const env = { SCP_GRANT: `krt_${"a".repeat(64)}`, SCP_SESSION: "outer", SCP_PARENT: "outer", SCP_SHIM_BINDING: "old" }
  const launch = codexLaunch(["--name", "worker"], env, ["swarm"])
  expect(launch.env.SCP_GRANT).toBe(env.SCP_GRANT)
  expect(launch.env.SCP_SESSION).toBeUndefined()
  expect(launch.env.SCP_PARENT).toBeUndefined()
  expect(launch.env.SCP_SHIM_BINDING).toMatch(/^[0-9a-f]{32}$/)
  expect(codexLaunch([], env, []).env.SCP_SHIM_BINDING).not.toBe(launch.env.SCP_SHIM_BINDING)
  expect(spawnEnvironment(launch.env, { SCP_GRANT: "child-grant" }).SCP_SHIM_BINDING).toBeUndefined()
  for (const mount of [undefined, { env_vars: ["CUSTOM"] }]) {
    const overrides = codexOverrides(launch.env, mount, ["swarm"])
    const vars = overrides.find((arg) => arg.startsWith("mcp_servers.scp.env_vars="))!
    expect(JSON.parse(vars.slice(vars.indexOf("=") + 1))).toEqual(expect.arrayContaining(["SCP_GRANT", "SCP_SHIM_BINDING"]))
    expect(overrides.join(" ")).not.toContain(env.SCP_GRANT)
  }
  expect(relayIdentity({ fallbackHarness: "codex", cwd: "/tmp", env: launch.env, harnessPid: () => process.pid }).grant).toBe(env.SCP_GRANT)
})

test("codex channel waits for the shim to spend its grant and binds to that endpoint with its parent and title", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scp-codex-grant-"))
  const broker = await startBroker({ dir, idleMs: 0, policyPath: join(dir, "policy.json"), log: () => {} })
  const parent = await RelayClient.connect(broker.socket)
  const shim = await RelayClient.connect(broker.socket)
  let channel: RelayClient | undefined
  try {
    await parent.hello({ claim: { handle: "lead", harness: "codex" } })
    const grant = await parent.grant({ name: "worker", title: "work title" })
    const claim = { handle: "worker", harness: "codex", process: processKey(process.pid), session: processKey(process.pid), grant: grant.token }
    let attempts = 0
    channel = await connectCodexChannel(
      async () => {
        if (++attempts === 2) await shim.hello({ claim })
        return RelayClient.connect(broker.socket)
      },
      claim,
      dir,
      () => attempts >= 3,
    )
    expect(attempts).toBe(2)
    expect(await channel.hello({})).toMatchObject({ grant_bound: true, endpoint: { address: "me/worker", parent: "me/lead", title: "work title" } })
    await channel.request("wake", { via: "codex-app-server" })
    expect(broker.core.list({ all: true }).filter((endpoint) => endpoint.address.startsWith("me/worker"))).toHaveLength(1)
  } finally {
    channel?.close()
    shim.close()
    parent.close()
    await broker.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("codex launch passes every TUI argument through untouched: prompts, resume, flags and anything after --", () => {
  const args = ["--profile", "fast", "-m", "gpt-x", "-c", 'model_reasoning_effort="high"', "fix the bug", "--", "--name", "kept"]
  expect(codexLaunch(["--name", "cx", ...args], {}, []).codexArgs).toEqual(args)
  expect(codexLaunch(["resume", "--last", "-p", "fast"], {}, []).codexArgs).toEqual(["resume", "--last", "-p", "fast"])
})

test("the app-server gets the config codex would resolve: the profile file, then -c and features, then model, sandbox and approval", () => {
  const home = mkdtempSync(join(tmpdir(), "scp-codex-home-"))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(
    join(home, "fast.config.toml"),
    'model = "profile-model"\napproval_policy = "on-request"\n[mcp_servers.docs]\ncommand = "docs"\nargs = ["--x"]\n',
  )
  const warnings: string[] = []
  const options = serverOptions(
    [
      "--profile",
      "fast",
      "-c",
      'model_reasoning_effort="high"',
      "--enable=web_search",
      "-m",
      "gpt-x",
      "-s",
      "workspace-write",
      "--strict-config",
      "a prompt",
      "--",
      "-c",
      "after",
    ],
    { CODEX_HOME: home },
    (line) => warnings.push(line),
  )
  expect(options).toEqual([
    "-c",
    'model="profile-model"',
    "-c",
    'approval_policy="on-request"',
    "-c",
    'mcp_servers.docs.command="docs"',
    "-c",
    'mcp_servers.docs.args=["--x"]',
    "-c",
    'model_reasoning_effort="high"',
    "--enable",
    "web_search",
    "--strict-config",
    "-c",
    'model="gpt-x"',
    "-c",
    'sandbox_mode="workspace-write"',
  ])
  expect(warnings).toEqual([])
  expect(serverOptions(["--dangerously-bypass-approvals-and-sandbox"], {})).toEqual([
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
  ])
  expect(serverOptions(["-p", "missing"], { CODEX_HOME: home })).toEqual([])
  expect(serverOptions(["-c", "mcp_servers.scp.enabled=false", "-c", "mcp_servers.scp.enabled=false"], {}, (line) => warnings.push(line))).toEqual([
    "-c",
    "mcp_servers.scp.enabled=false",
    "-c",
    "mcp_servers.scp.enabled=false",
  ])
  expect(warnings).toEqual([expect.stringContaining("override the ones swarm sets")])
})

test("unix WebSocket carries RPC, errors, notifications and all frame lengths", async () => {
  const root = mkdtempSync(join(tmpdir(), "scp-codex-ws-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "app.sock")
  const notifications: Json[] = []
  const server = Bun.serve({
    unix: path,
    fetch(request, server) {
      if (server.upgrade(request)) return
      return new Response("upgrade required", { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as Json
        if (message.method === "error") ws.send(JSON.stringify({ id: message.id, error: { code: -1, message: "failed" } }))
        else {
          ws.send(JSON.stringify({ id: message.id, result: message.params }))
          ws.send(JSON.stringify({ method: "notice", params: message.params }))
        }
      },
    },
  })
  cleanups.push(() => {
    server.stop(true)
  })
  const client = new CodexSocket(path, (message) => notifications.push(message))
  cleanups.push(() => client.close())
  await client.ready
  for (const length of [5, 500, 70_000]) {
    const params = { text: "x".repeat(length) }
    expect(await client.request("echo", params)).toEqual(params)
  }
  await Bun.sleep(10)
  expect(notifications.map((message) => ((message.params as Json).text as string).length)).toEqual([5, 500, 70_000])
  await expect(client.request("error", {})).rejects.toThrow("failed")
})

function fake(threadId?: string) {
  let threads = ["main"]
  const children = new Set<string>()
  const calls: { method: string; params: Json }[] = []
  const failures = new Set<string>()
  const transport = {
    async request(method: string, params: Json): Promise<Json> {
      calls.push({ method, params })
      if (failures.has(method)) throw new Error("failed")
      if (method === "thread/loaded/list") return { data: threads }
      if (method === "thread/read") return { thread: { parentThreadId: children.has(params.threadId as string) ? "parent" : null } }
      if (method === "thread/turns/list")
        return {
          data: [
            { id: "ended", status: "completed" },
            { id: "turn", status: "inProgress" },
          ],
        }
      return {}
    },
  }
  const waker = new CodexWaker(transport, threadId)
  cleanups.push(() => waker.close())
  const status = (type: string, id = "main") => waker.notification({ method: "thread/status/changed", params: { threadId: id, status: { type } } })
  return {
    waker,
    calls,
    failures,
    children,
    status,
    threads: (ids: string[]) => {
      threads = ids
    },
    turns: () => calls.filter((call) => call.method.startsWith("turn/")),
  }
}

test("idle joins queued messages into one turn", async () => {
  const f = fake()
  f.status("idle")
  f.waker.push("first")
  f.waker.push("second")
  await f.waker.flush()
  expect(f.turns()).toEqual([{ method: "turn/start", params: { threadId: "main", input: [{ type: "text", text: "first\n\nsecond" }] } }])
})

test("active steers the in-progress turn", async () => {
  const f = fake()
  f.status("active")
  f.waker.push("steer")
  await f.waker.flush()
  expect(f.turns()).toEqual([{ method: "turn/steer", params: { threadId: "main", expectedTurnId: "turn", input: [{ type: "text", text: "steer" }] } }])
})

test("failed steer keeps messages until idle", async () => {
  const f = fake()
  f.failures.add("turn/steer")
  f.status("active")
  f.waker.push("kept")
  await f.waker.flush()
  await f.waker.flush()
  expect(f.turns().map((call) => call.method)).toEqual(["turn/steer"])
  f.status("idle")
  await f.waker.flush()
  expect(f.turns().map((call) => call.method)).toEqual(["turn/steer", "turn/start"])
  expect(f.turns()[1]!.params.input).toEqual([{ type: "text", text: "kept" }])
})

test("no thread keeps messages queued until a thread appears", async () => {
  const f = fake()
  f.threads([])
  f.waker.push("pending")
  await f.waker.flush()
  expect(f.turns()).toEqual([])
  f.threads(["main"])
  f.status("idle")
  await f.waker.flush()
  expect(f.turns()[0]!.params.input).toEqual([{ type: "text", text: "pending" }])
})

test("target skips sub-agents, caches parents and prefers the most recent status", async () => {
  const f = fake()
  f.threads(["first", "main", "child"])
  f.children.add("child")
  expect(await f.waker.target()).toBe("main")
  f.status("idle", "first")
  f.status("active", "child")
  expect(await f.waker.target()).toBe("first")
  f.status("idle", "main")
  expect(await f.waker.target()).toBe("main")
  expect(f.calls.filter((call) => call.method === "thread/read")).toHaveLength(3)
})

test("failed start retains texts and retries on status change", async () => {
  const f = fake("owned")
  f.failures.add("turn/start")
  f.waker.push("retry")
  await f.waker.flush()
  f.failures.clear()
  f.status("idle", "owned")
  await f.waker.flush()
  expect(f.turns()).toHaveLength(2)
  expect(f.turns()[1]!.params.input).toEqual([{ type: "text", text: "retry" }])
  expect(f.calls.some((call) => call.method === "thread/loaded/list")).toBe(false)
})

test("failed start retries after two seconds without another notification", async () => {
  const f = fake("owned")
  f.failures.add("turn/start")
  f.waker.push("retry on timer")
  await f.waker.flush()
  f.failures.clear()
  const end = Date.now() + 3000
  while (f.turns().length < 2 && Date.now() < end) await Bun.sleep(20)
  expect(f.turns()).toHaveLength(2)
  expect(f.turns()[1]!.params.input).toEqual([{ type: "text", text: "retry on timer" }])
})

test("flush serializes transport calls and retains pushes arriving during a start", async () => {
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: { method: string; params: Json }[] = []
  let inFlight = 0
  let maximum = 0
  const waker = new CodexWaker(
    {
      async request(method, params) {
        maximum = Math.max(maximum, ++inFlight)
        calls.push({ method, params })
        try {
          if (method === "turn/start") {
            started()
            await gate
          }
          if (method === "thread/turns/list") return { data: [{ id: "turn", status: "inProgress" }] }
          return {}
        } finally {
          inFlight--
        }
      },
    },
    "owned",
  )
  cleanups.push(() => waker.close())
  waker.push("first")
  await entered
  waker.notification({ method: "thread/status/changed", params: { threadId: "owned", status: { type: "active" } } })
  waker.push("second")
  release()
  await waker.flush()
  expect(maximum).toBe(1)
  expect(calls.filter((call) => call.method.startsWith("turn/")).map((call) => call.params.input)).toEqual([
    [{ type: "text", text: "first" }],
    [{ type: "text", text: "second" }],
  ])
})

test("a steer racing idle immediately falls back to a start", async () => {
  const calls: string[] = []
  const waker = new CodexWaker(
    {
      async request(method) {
        calls.push(method)
        if (method === "thread/turns/list") return { data: [{ id: "turn", status: "inProgress" }] }
        if (method === "turn/steer") {
          waker.notification({ method: "thread/status/changed", params: { threadId: "owned", status: { type: "idle" } } })
          throw new Error("turn ended")
        }
        return {}
      },
    },
    "owned",
  )
  cleanups.push(() => waker.close())
  waker.notification({ method: "thread/status/changed", params: { threadId: "owned", status: { type: "active" } } })
  waker.push("kept")
  await waker.flush()
  expect(calls).toEqual(["thread/turns/list", "turn/steer", "turn/start"])
})
