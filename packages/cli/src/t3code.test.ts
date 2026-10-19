import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import type { RelayClient } from "@scp-dev/broker"
import { runHook } from "./hooks"
import { hookFormat, type PsCommTable, relayIdentity, t3Hosted, t3Process } from "./identity"
import { detectT3 } from "./setup"
import { spawnEnvironment } from "./spawn"
import { activeRun, exitReason, issueArgv, T3Socket, T3Waker, t3Home, t3Launch, t3Server, t3Token } from "./t3code"

type Json = Record<string, unknown>
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "scp-t3-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("the launch takes a name, the thread and a base dir, refuses anything else, and starts a fresh t3code session", () => {
  const env = { PATH: "/bin", SCP_SESSION: "s", SCP_PARENT: "p", SCP_HARNESS_PID: "9", SCP_GRANT: "g" }
  const launch = t3Launch(["--name", "me/t3", "--thread=th-1", "--base-dir", "/b"], env)
  expect(launch).toMatchObject({ name: "t3", thread: "th-1", baseDir: "/b" })
  expect(launch.env).toEqual({ PATH: "/bin", SCP_GRANT: "g", SCP_HARNESS: "t3code", SCP_NAME: "t3", SCP_SESSION: expect.stringMatching(/^[0-9a-f]{32}$/) })
  expect(t3Launch(["--as=w", "--thread", "x"], {}).name).toBe("w")
  expect(t3Launch(["--thread", "x"], {}).env.SCP_NAME).toBeUndefined()
  expect(() => t3Launch([], {})).toThrow("needs --thread")
  expect(() => t3Launch(["--thread"], {})).toThrow("--thread takes a value")
  expect(() => t3Launch(["--thread", "x", "--model", "m"], {})).toThrow('not "--model"')
  expect(() => t3Launch(["--thread", "x", "--name", "Bad Name"], {})).toThrow("not a valid agent handle")
})

test("the data dir is --base-dir, else $T3CODE_HOME, else ~/.t3", () => {
  expect(t3Home({ HOME: "/h", T3CODE_HOME: "/t" }, "/b")).toBe("/b")
  expect(t3Home({ HOME: "/h", T3CODE_HOME: "/t" })).toBe("/t")
  expect(t3Home({ HOME: "/h" })).toBe(join("/h", ".t3"))
})

test("the server is $SCP_T3_URL, else the live one the runtime file names, and a missing or dead one is refused", () => {
  expect(t3Server({ SCP_T3_URL: "http://127.0.0.1:4100" }, "/none")).toEqual({ host: "127.0.0.1", port: 4100 })
  expect(t3Server({ SCP_T3_URL: "ws://[::1]:4100/ws" }, "/none")).toEqual({ host: "::1", port: 4100 })
  expect(() => t3Server({ SCP_T3_URL: "https://host" }, "/none")).toThrow("http:// or ws://")
  const home = temp()
  expect(() => t3Server({}, home)).toThrow("no T3 Code server runs for")
  mkdirSync(join(home, "userdata"))
  writeFileSync(join(home, "userdata", "server-runtime.json"), JSON.stringify({ version: 1, pid: 4242, host: "0.0.0.0", port: 3773 }))
  expect(t3Server({}, home, (pid) => pid === 4242)).toEqual({ host: "127.0.0.1", port: 3773 })
  expect(() => t3Server({}, home, () => false)).toThrow("(pid 4242) is not running")
})

test("the token is $SCP_T3_TOKEN, else one t3 issues with only the orchestration scopes", () => {
  expect(t3Token({ SCP_T3_TOKEN: " tok " }, "/h")).toBe("tok")
  const calls: string[][] = []
  const run = (argv: string[]) => {
    calls.push(argv)
    return { status: 0, stdout: "note\nissued-token\n", stderr: "" }
  }
  expect(t3Token({ SCP_T3_BIN: "/opt/t3" }, "/h", run)).toBe("issued-token")
  expect(calls).toEqual([issueArgv("/opt/t3", "/h")])
  expect(issueArgv("/opt/t3", "/h")).toEqual([
    "/opt/t3",
    "auth",
    "session",
    "issue",
    "--base-dir",
    "/h",
    "--scope",
    "orchestration:read",
    "--scope",
    "orchestration:operate",
    "--ttl",
    "30d",
    "--label",
    "swarm t3code",
    "--token-only",
  ])
  expect(() => t3Token({ SCP_T3_BIN: "/opt/t3" }, "/h", () => ({ status: 1, stdout: "", stderr: "no database" }))).toThrow(
    "auth session issue failed: no database",
  )
  expect(() => t3Token({ PATH: "" }, "/h")).toThrow("set $SCP_T3_TOKEN")
})

test("failure exits and active runs read as T3 Code writes them", () => {
  expect(exitReason({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "E", message: "Target run nope was not found." } }] })).toBe(
    "Target run nope was not found.",
  )
  expect(exitReason({ _tag: "Failure", cause: [{ _tag: "Die", defect: "boom" }] })).toBe("boom")
  expect(exitReason({ _tag: "Failure", cause: [{ _tag: "Interrupt" }] })).toBe("interrupted")
  expect(
    activeRun([
      { id: "r1", status: "completed" },
      { id: "r2", status: "running" },
    ]),
  ).toBe("r2")
  expect(activeRun([{ id: "r1", status: "completed" }])).toBeNull()
  expect(activeRun(undefined)).toBeNull()
})

/** a T3 Code stand-in speaking Effect RPC's JSON framing over a WebSocket */
function fakeServer(onRequest: (message: Json, reply: (message: Json) => void) => void) {
  const seen: { url: string; auth: string | null; frames: Json[] } = { url: "", auth: null, frames: [] }
  let socket: { send(text: string): void; close(): void } | undefined
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, srv) {
      seen.url = new URL(request.url).pathname + new URL(request.url).search
      seen.auth = request.headers.get("authorization")
      if (srv.upgrade(request)) return
      return new Response("upgrade required", { status: 400 })
    },
    websocket: {
      open(ws) {
        socket = ws
      },
      message(_ws, data) {
        const message = JSON.parse(String(data)) as Json
        seen.frames.push(message)
        onRequest(message, (out) => socket?.send(JSON.stringify(out)))
      },
    },
  })
  cleanups.push(() => server.stop(true))
  return { port: server.port as number, seen, close: () => socket?.close() }
}

test("the socket upgrades with the token, matches exits to requests, acks stream chunks and answers pings; a stream's end closes it", async () => {
  const fake = fakeServer((message, reply) => {
    if (message._tag !== "Request") return
    if (message.tag === "ok") reply({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: { sequence: 3 } } })
    if (message.tag === "bad") reply({ _tag: "Exit", requestId: message.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "nope" } }] } })
    if (message.tag === "stream") {
      reply({ _tag: "Ping" })
      reply({ _tag: "Chunk", requestId: message.id, values: [{ n: 1 }, { n: 2 }] })
      setTimeout(() => reply({ _tag: "Exit", requestId: message.id, exit: { _tag: "Success", value: null } }), 100)
    }
  })
  let closed: Error | undefined
  const socket = new T3Socket({ host: "127.0.0.1", port: fake.port }, "secret", (error) => (closed = error))
  await socket.ready
  expect(fake.seen.url).toBe("/ws?orchestrationProtocol=2")
  expect(fake.seen.auth).toBe("Bearer secret")
  expect(await socket.request("ok", { a: 1 })).toEqual({ sequence: 3 })
  await expect(socket.request("bad", {})).rejects.toThrow("nope")
  const values: Json[] = []
  await socket.subscribe("stream", {}, (value) => values.push(value))
  for (let i = 0; i < 50 && !closed; i++) await Bun.sleep(20)
  expect(values).toEqual([{ n: 1 }, { n: 2 }])
  expect(fake.seen.frames).toEqual([
    { _tag: "Request", id: "1", tag: "ok", payload: { a: 1 }, headers: [] },
    { _tag: "Request", id: "2", tag: "bad", payload: {}, headers: [] },
    { _tag: "Request", id: "3", tag: "stream", payload: {}, headers: [] },
    { _tag: "Pong" },
    { _tag: "Ack", requestId: "3" },
  ])
  expect(closed?.message).toBe("T3 Code ended stream")
  await expect(socket.request("ok", {})).rejects.toThrow()
})

test("a refused token fails the upgrade with the server's status", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 401 }) })
  cleanups.push(() => server.stop(true))
  const socket = new T3Socket({ host: "127.0.0.1", port: server.port as number }, "bad")
  await expect(socket.ready).rejects.toThrow("T3 Code WebSocket upgrade failed (401")
})

test("the waker starts a turn on an idle thread, steers the active run, batches while one is in flight and retries every interval", async () => {
  const sent: Json[] = []
  let fail = 0
  let release: (() => void) | undefined
  const transport = {
    request: async (tag: string, payload: Json) => {
      expect(tag).toBe("orchestration.dispatchCommand")
      sent.push(payload)
      if (fail > 0) {
        fail--
        throw new Error("Target run r1 was not found.")
      }
      if (sent.length === 1) await new Promise<void>((resolve) => (release = resolve))
      return { sequence: sent.length }
    },
  }
  const logs: string[] = []
  const waker = new T3Waker(transport, "th", 30, (line) => logs.push(line))
  cleanups.push(() => waker.close())
  waker.thread({ id: "other", activeRunId: "zz" })
  waker.push("one")
  await Bun.sleep(5)
  waker.push("two")
  waker.push("three")
  release!()
  for (let i = 0; i < 50 && sent.length < 2; i++) await Bun.sleep(5)
  expect(sent.map((c) => [c.text, c.dispatchMode])).toEqual([
    ["one", { type: "start_immediately" }],
    ["two\n\nthree", { type: "start_immediately" }],
  ])
  expect(sent[0]).toMatchObject({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "server",
    threadId: "th",
    attachments: [],
    deliveryIntent: "auto",
  })
  expect(sent[0]!.commandId).not.toBe(sent[1]!.commandId)
  waker.thread({ id: "th", activeRunId: "r1" })
  fail = 2
  waker.push("four")
  for (let i = 0; i < 100 && sent.length < 5; i++) await Bun.sleep(10)
  expect(sent.slice(2).map((c) => [c.text, c.dispatchMode])).toEqual([
    ["four", { type: "steer_active", targetRunId: "r1" }],
    ["four", { type: "steer_active", targetRunId: "r1" }],
    ["four", { type: "steer_active", targetRunId: "r1" }],
  ])
  expect(logs).toEqual(["swarm t3code: T3 Code did not take the message (Target run r1 was not found.); retrying every 2 s"])
  waker.thread({ id: "th", activeRunId: null, deletedAt: "2026-01-01" })
  expect([waker.active, waker.deleted]).toEqual([null, true])
})

const table = (rows: [number, number, string][]): PsCommTable => new Map(rows.map(([pid, ppid, args]) => [pid, { ppid, start: "s", args }]))

test("T3 Code is the t3 CLI or the desktop app, and it hosts a harness whose parent it is or whose env names its originator", () => {
  expect(t3Process("/x/node_modules/@t3code/t3-darwin-arm64/t3 serve --port 1")).toBe(true)
  expect(t3Process("t3 start")).toBe(true)
  expect(t3Process("/Applications/T3 Code.app/Contents/MacOS/T3 Code /Applications/T3 Code.app/Contents/Resources/app.asar")).toBe(true)
  expect(t3Process("node /x/bin/t3.js")).toBe(false)
  expect(t3Process("/usr/bin/codex app-server")).toBe(false)
  const ps = table([
    [10, 1, "/opt/t3 serve"],
    [11, 10, "codex app-server"],
    [12, 10, "zsh -l"],
    [13, 12, "codex"],
  ])
  const on = { SCP_HARNESS_DETECT: "1" }
  expect(t3Hosted(on, 11, () => ps)).toBe(true)
  expect(t3Hosted(on, 13, () => ps)).toBe(false)
  expect(t3Hosted({ SCP_HARNESS_DETECT: "0" }, 11, () => ps)).toBe(false)
  expect(t3Hosted({ SCP_HARNESS_DETECT: "0", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code" }, 13, () => undefined)).toBe(true)
  expect(t3Hosted(on, 11, () => undefined)).toBe(false)
})

test("a codex or Claude Code session T3 Code runs claims harness t3code; other harnesses keep theirs", () => {
  const claim = (harness: string, hosted: boolean) =>
    relayIdentity({
      harness,
      fallbackHarness: "hook",
      cwd: "/w",
      env: {},
      harnessPid: () => 77,
      startOf: () => "s",
      lineageOf: () => [],
      t3Hosted: () => hosted,
      harnessSession: "cc-1",
    })
  expect(claim("codex", true)).toMatchObject({ harness: "t3code", handle: "t3code-w", session: "pid:77:s" })
  expect(claim("claude-code", true)).toMatchObject({ harness: "t3code", harness_session: "cc-1" })
  expect(claim("codex", false).harness).toBe("codex")
  expect(claim("muse", true).harness).toBe("muse")
  expect(hookFormat("t3code", "codex")).toBe("codex")
  expect(hookFormat("grok", "claude-code")).toBe("grok")
})

test("a hook in a T3 Code session claims t3code and still answers in its provider's format", async () => {
  const run = async (harness: "codex" | "claude", t3: boolean) => {
    const claims: Json[] = []
    const client = {
      hello: async (params: { claim: Json }) => {
        claims.push(params.claim)
        return { endpoint: { title: "t" } }
      },
      request: async (method: string) =>
        method === "inject"
          ? {
              messages: [],
              offered: [],
              hold: null,
              more: 0,
              unread: 1,
              block: true,
              forced: false,
              nudge: [{ seq: 7, from: "me/lead", id: "msg_1", unread: true }],
            }
          : {},
      close: () => {},
    }
    const reply = await runHook([harness], {
      env: {
        HOME: tmpdir(),
        SCP_SESSION: "t3-hook",
        SCP_NAME: "t3-hook",
        ...(harness === "claude" ? { CLAUDECODE: "1" } : { CODEX_THREAD_ID: "c1" }),
        ...(t3 ? { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code" } : {}),
      },
      cwd: tmpdir(),
      stdin: Readable.from([JSON.stringify({ hook_event_name: "Stop", cwd: tmpdir() })]),
      connect: async () => client as unknown as RelayClient,
      harnessPid: () => process.pid,
    })
    return { reply, harness: claims[0]?.harness }
  }
  for (const harness of ["codex", "claude"] as const) {
    const plain = await run(harness, false)
    const hosted = await run(harness, true)
    expect(plain.harness).toBe(harness === "claude" ? "claude-code" : "codex")
    expect(hosted.harness).toBe("t3code")
    expect(hosted.reply).toBeTruthy()
    expect(hosted.reply).toBe(plain.reply)
  }
})

test("spawned workers do not inherit T3 Code's originator, and setup finds T3 Code by its binary, app or data dir", () => {
  expect(spawnEnvironment({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code", PATH: "/bin" }, {})).toEqual({ PATH: "/bin" })
  const home = temp()
  expect(detectT3({ HOME: home }, (name) => (name === "t3" ? "/bin/t3" : undefined))).toBe("/bin/t3")
  expect(
    detectT3(
      { HOME: home },
      () => undefined,
      () => false,
    ),
  ).toBeUndefined()
  mkdirSync(join(home, ".t3"))
  expect(
    detectT3(
      { HOME: home },
      () => undefined,
      (path) => path === join(home, ".t3"),
    ),
  ).toBe(join(home, ".t3"))
})
