import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { PREAMBLE } from "@scp-dev/core"
import { promptTitle } from "./hooks"
import { readMuseLaunch, relayIdentity, writeMuseLaunch } from "./identity"
import { answerRequest, museBroker, MuseHost, museLaunch, MuseWaker, uuidv7 } from "./muse"

type Json = Record<string, unknown>
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

test("muse launch takes its own flags, passes the rest to muse serve, and drops the launching session", () => {
  const env = { PATH: "/bin", SCP_SESSION: "s", SCP_PARENT: "p", SCP_GRANT: "g", SCP_NAME: "old" }
  expect(museLaunch(["--name", "me/mu", "--resume=S1", "--approval-mode", "never", "--model", "m", "--", "--name", "x"], env)).toEqual({
    name: "mu",
    resume: "S1",
    approvalMode: "allowAll",
    serveArgs: ["--contributor-mode", "off", "--disable-request-user-input", "--model", "m", "--name", "x"],
    env: { PATH: "/bin", SCP_GRANT: "g", SCP_NAME: "mu", SCP_HARNESS: "muse" },
  })
  expect(museLaunch(["--as=mu", "--contributor-mode", "on", "--disable-request-user-input"], {})).toMatchObject({
    name: "mu",
    approvalMode: "onRequest",
    serveArgs: ["--contributor-mode", "on", "--disable-request-user-input"],
  })
  expect(museLaunch(["--approval-mode=untrusted", "-c", "contributor_mode=false"], {}).serveArgs).toEqual([
    "--disable-request-user-input",
    "-c",
    "contributor_mode=false",
  ])
  expect(() => museLaunch(["--name"], {})).toThrow("takes a value")
  expect(() => museLaunch(["--name", "Bad Name"], {})).toThrow("not a valid agent handle")
  expect(() => museLaunch(["--approval-mode", "yolo"], {})).toThrow("never, on-request or untrusted")
  expect(() => museLaunch(["--contributor-mode", "maybe"], {})).toThrow("off or on")
})

test("Muse's shim and hooks reach the broker under HOME, whatever SCP_DIR says", () => {
  expect(museBroker({ HOME: "/h", SCP_DIR: "/elsewhere", XDG_STATE_HOME: "/x" })).toBe(join("/h", ".local", "state", "scp"))
})

test("command ids are version 7 UUIDs ordered by time", () => {
  const id = uuidv7(1_700_000_000_000)
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(id.slice(0, 13).replace("-", "")).toBe((1_700_000_000_000).toString(16).padStart(12, "0"))
  expect(uuidv7(1) < uuidv7(2)).toBe(true)
})

test("the host matches responses to requests and hands server messages on", async () => {
  const toServer = new PassThrough()
  const fromServer = new PassThrough()
  const seen: Json[] = []
  const host = new MuseHost(toServer, fromServer, (message) => seen.push(message))
  const sent: Json[] = []
  toServer.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) sent.push(JSON.parse(line) as Json)
  })
  const reply = host.request("initialize", { clientInfo: { name: "t", version: "1" } })
  await Bun.sleep(5)
  expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "t", version: "1" } } })
  fromServer.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/statusChanged", params: { status: "idle" } })}\n{"jsonrpc":"2.0","id":1,`)
  fromServer.write(`"result":{"ok":true}}\n`)
  expect(await reply).toEqual({ ok: true })
  expect(seen).toEqual([{ jsonrpc: "2.0", method: "session/statusChanged", params: { status: "idle" } }])
  const failed = host.request("turn/start", {})
  fromServer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad" } })}\n`)
  expect(failed).rejects.toThrow("bad")
  const pending = host.request("session/start", {})
  fromServer.end()
  expect(pending).rejects.toThrow("muse serve closed")
})

test("the waker starts or steers one turn per batch and retries until muse serve accepts", async () => {
  const calls: Json[] = []
  let answer: Json | Error = new Error("busy")
  const request = async (_method: string, params: Json): Promise<Json> => {
    calls.push(params)
    if (answer instanceof Error) throw answer
    return answer
  }
  const waker = new MuseWaker({ request }, "S", 50)
  cleanups.push(() => waker.close())
  waker.push("one")
  waker.push("two")
  await Bun.sleep(5)
  expect(calls.length).toBe(1)
  answer = { status: "rejected" }
  await Bun.sleep(75)
  expect(calls.length).toBe(2)
  answer = { status: "accepted" }
  await Bun.sleep(75)
  const last = calls.at(-1)!
  expect(last).toMatchObject({ sessionId: "S", ifBusy: "steer", input: [{ type: "text", text: "one\n\ntwo" }] })
  expect(String(last.commandId)).toMatch(/^[0-9a-f-]{36}$/)
  const count = calls.length
  await Bun.sleep(100)
  expect(calls.length).toBe(count)
  waker.push("three")
  await Bun.sleep(5)
  expect(calls.at(-1)).toMatchObject({ input: [{ type: "text", text: "three" }] })
})

test("a headless session declines approvals and refuses other server requests", async () => {
  const sent: Json[] = []
  const decided: Json[] = []
  const lines: string[] = []
  const host = {
    send: (message: Json) => void sent.push(message),
    request: async (_method: string, params: Json) => {
      decided.push(params)
      return {}
    },
  }
  answerRequest(
    host,
    {
      id: 7,
      method: "approval/request",
      params: {
        approvalId: "a1",
        sessionId: "S",
        currentRequirementId: { approvalId: "a1", sourceIndex: 0 },
        subject: { command: "rm -rf /" },
        availableChoices: [
          { choiceId: "yes", decision: "approved" },
          { choiceId: "no", decision: "denied" },
        ],
      },
    },
    (line) => lines.push(line),
  )
  answerRequest(host, { id: 8, method: "userInput/request", params: {} }, () => {})
  await Bun.sleep(1)
  expect(sent).toEqual([
    { id: 7, result: {} },
    { id: 8, error: { code: -32601, message: "userInput/request is unsupported in a headless session" } },
  ])
  expect(decided).toEqual([
    { approvalId: "a1", choiceId: "no", commandId: expect.any(String), requirementId: { approvalId: "a1", sourceIndex: 0 }, sessionId: "S" },
  ])
  expect(lines[0]).toContain("declined rm -rf /")
})

test("a muse shim and hook take the name, grant, session and launcher a launcher left for their harness process", () => {
  const dir = mkdtempSync(join(tmpdir(), "scp-muse-launch-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const env = { SCP_DIR: dir }
  const key = `pid:${process.pid}:Mon-Oct-19-00:00:00-2026`
  const grant = `krt_${"a".repeat(64)}`
  const remove = writeMuseLaunch(key, { name: "kid", grant }, env)
  const file = join(dir, "launch", `muse-${process.pid}.json`)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(readMuseLaunch(key, env)).toEqual({ name: "kid", grant })
  expect(readMuseLaunch(`pid:${process.pid}:another-start`, env)).toBeUndefined()
  const claim = (harness: string, extra: Record<string, string> = {}) =>
    relayIdentity({
      harness,
      fallbackHarness: harness,
      cwd: "/w/proj",
      env: { ...env, ...extra },
      harnessPid: () => process.pid,
      startOf: () => "Mon-Oct-19-00:00:00-2026",
      lineageOf: () => [],
    })
  expect(claim("muse")).toMatchObject({ handle: "kid", grant })
  expect(claim("muse", { SCP_NAME: "own" })).toMatchObject({ handle: "own" })
  expect(claim("muse", { SCP_NAME: "own" }).grant).toBeUndefined()
  expect(claim("codex").handle).not.toBe("kid")
  remove()
  expect(existsSync(file)).toBe(false)
  expect(claim("muse").handle).not.toBe("kid")
  const launcher = "pid:4242:Mon-Oct-19-00:00:00-2026"
  const resumed = writeMuseLaunch(key, { name: "kid", session: "abc123", launcher }, env)
  expect(claim("muse")).toMatchObject({ handle: "kid", session: "env:abc123", process: launcher })
  expect(claim("muse").grant).toBeUndefined()
  resumed()
  const odd = writeMuseLaunch(key, { name: "kid", session: "a b", launcher: "4242" }, env)
  expect(readMuseLaunch(key, env)).toEqual({ name: "kid" })
  odd()
})

test("a prompt a waker submitted with relay messages names no title", () => {
  expect(promptTitle(`${PREAMBLE}\n\n<relay-message>hi</relay-message>`)).toBeUndefined()
  expect(promptTitle("\n  fix the parser\nmore")).toBe("fix the parser")
})
