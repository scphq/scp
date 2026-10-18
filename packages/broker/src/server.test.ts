import { Database } from "bun:sqlite"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { LIMITS, RelayError, type StopNudge } from "@scp-dev/core"
import { BrokerUnavailable, connectBroker, RelayClient } from "./client"
import { BrokerRunning, releaseBrokerLock, takeBrokerLock } from "./lock"
import { LineReader, LineWriter } from "./ndjson"
import { privateDir, socketPath } from "./paths"
import { type Broker, type BrokerOptions, startBroker } from "./server"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function setup(options: { idleMs?: number; policy?: unknown } & Partial<BrokerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-broker-"))
  const policyPath = join(root, "policy.json")
  if (options.policy !== undefined) writeFileSync(policyPath, JSON.stringify(options.policy))
  const broker = await startBroker({ ...options, dir: join(root, "state"), policyPath, idleMs: options.idleMs ?? 0 })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => broker.stop())
  return { root, broker, policyPath }
}

async function agent(broker: Broker, handle: string, harness = "claude-code", cwd?: string) {
  const client = await RelayClient.connect(broker.socket)
  cleanups.push(() => client.close())
  const hello = await client.hello({ claim: { handle, harness, ...(cwd === undefined ? {} : { cwd }) } })
  return { client, hello }
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RelayError) return error.code
    throw error
  }
  return undefined
}

describe("broker", () => {
  test("its directory and socket are private", async () => {
    const { root, broker } = await setup()
    expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700)
    expect(statSync(broker.socket).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, "state", "relay.db")).mode & 0o777).toBe(0o600)
  })

  test("a second broker on the same directory is refused", async () => {
    const { root } = await setup()
    await expect(startBroker({ dir: join(root, "state"), idleMs: 0 })).rejects.toBeInstanceOf(BrokerRunning)
  })

  test("hello advertises what the broker serves, peek, judge and holds among it", async () => {
    const { broker } = await setup()
    const { hello } = await agent(broker, "a")
    expect(hello.capabilities).toEqual(["inbox.wait", "ask", "scopes", "groups", "peek", "judge", "holds"])
  })

  test("two agents find each other, and a waiting inbox wakes on send", async () => {
    const { broker } = await setup()
    const a = await agent(broker, "a", "claude-code", "/repo")
    const b = await agent(broker, "b", "codex")
    const listed = await a.client.request<{ endpoints: { address: string; harness: string; presence: string }[] }>("list")
    expect(listed.endpoints.map((e) => [e.address, e.harness, e.presence])).toEqual([
      ["me/", "human", "offline"],
      ["me/a", "claude-code", "online"],
      ["me/b", "codex", "online"],
    ])
    const waiting = b.client.request<{ messages: { seq: number; body: { text: string }; from: { address: string } }[] }>("inbox", { wait_s: 5 })
    await Bun.sleep(50)
    await a.client.request("send", { to: "b", body: "ping" })
    const got = await waiting
    expect(got.messages.map((m) => [m.from.address, m.body.text])).toEqual([["me/a", "ping"]])
    expect(await b.client.request<{ acked: number }>("ack", { seqs: [got.messages[0]!.seq] })).toEqual({ acked: 1 })
  })

  test("ask returns the reply when it comes within the wait, else pending for ask_wait", async () => {
    const { broker } = await setup()
    const a = await agent(broker, "a")
    const b = await agent(broker, "b", "codex")
    const asking = a.client.request<{ id: string; reply?: { body: { text: string } } }>("ask", { to: "b", body: "2+2?", wait_s: 5 })
    const inbox = await b.client.request<{ messages: { id: string }[] }>("inbox", { wait_s: 5 })
    await b.client.request("send", { to: "a", kind: "reply", reply_to: inbox.messages[0]!.id, body: "4" })
    expect((await asking).reply!.body.text).toBe("4")

    const pending = await a.client.request<{ id: string; pending?: boolean }>("ask", { to: "b", body: "slow one", wait_s: 0 })
    expect(pending.pending).toBe(true)
    const later = a.client.request<{ reply?: { body: { text: string } } }>("ask_wait", { id: pending.id, wait_s: 5 })
    const second = await b.client.request<{ messages: { id: string }[] }>("inbox", { wait_s: 5, after: 0 })
    await b.client.request("send", { to: "a", kind: "reply", reply_to: second.messages.at(-1)!.id, body: "done" })
    expect((await later).reply!.body.text).toBe("done")
  })

  test("fields the relay sets are refused from the sender", async () => {
    const { broker } = await setup()
    const a = await agent(broker, "a")
    await agent(broker, "b")
    expect(await code(a.client.request("send", { to: "b", body: "x", from: { address: "me/" } }))).toBe("invalid_params")
    expect(await code(a.client.request("send", { to: "b", body: "x", hop: 0 }))).toBe("invalid_params")
  })

  test("nothing but hello works before hello", async () => {
    const { broker } = await setup()
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    expect(await code(client.request("list"))).toBe("unauthorized")
    expect(await code(client.request("hello", { protocol: "scp/9" }))).toBe("invalid_params")
  })

  test("a watcher sees presence, messages, status and activity, never bodies", async () => {
    const { broker } = await setup()
    const watcher = await RelayClient.connect(broker.socket)
    cleanups.push(() => watcher.close())
    await watcher.hello({ human: true })
    const events: Record<string, unknown>[] = []
    watcher.onNotification((method, params) => method === "fleet" && events.push(params as Record<string, unknown>))
    await watcher.request("watch")
    const a = await agent(broker, "lane-impl")
    await agent(broker, "b")
    await a.client.request("send", { to: "b", body: "secret plan" })
    await a.client.request("status", { state: "working", note: "relay 1a" })
    await a.client.request("event", { kind: "tool", tool: "Bash", summary: "bun test" })
    a.client.close()
    await Bun.sleep(100)
    expect(events.map((e) => e.type)).toEqual(["presence", "presence", "message", "status", "activity", "presence", "status"])
    expect(events[2]).toMatchObject({ from: "me/lane-impl", to: ["me/b"], kind: "message" })
    expect(JSON.stringify(events)).not.toContain("secret plan")
    expect(events.at(-2)).toMatchObject({ endpoint: "me/lane-impl", presence: "offline" })
    expect(events.at(-1)).toMatchObject({ endpoint: "me/lane-impl", status: null })
  })

  test("the policy file is picked up on change, and an invalid one refuses everything", async () => {
    const { broker, policyPath } = await setup()
    const grok = await agent(broker, "grok-1", "grok")
    await agent(broker, "rev", "codex")
    expect(await code(grok.client.request("send", { to: "rev", body: "open" }))).toBeUndefined()
    writeFileSync(policyPath, JSON.stringify({ rules: [{ match: "harness:grok", send_to: ["kind:human"] }] }))
    expect(await code(grok.client.request("send", { to: "rev", body: "x" }))).toBe("policy_refused")
    expect(await code(grok.client.request("send", { to: "me/", body: "x" }))).toBeUndefined()
    expect(await grok.client.request<{ allowed: boolean }>("policy_check", { from: "grok-1", to: "rev" })).toMatchObject({ allowed: false })
    writeFileSync(policyPath, "{ not json")
    expect(await code(grok.client.request("send", { to: "me/", body: "x" }))).toBe("policy_refused")
    rmSync(policyPath)
    expect(await code(grok.client.request("send", { to: "rev", body: "open again" }))).toBeUndefined()
  })

  test("attachments must exist inside the sender's cwd", async () => {
    const { root, broker } = await setup()
    const work = join(root, "work")
    mkdirSync(work)
    writeFileSync(join(work, "notes.md"), "x")
    writeFileSync(join(root, "outside.md"), "x")
    const a = await agent(broker, "a", "claude-code", work)
    await agent(broker, "b")
    expect(await code(a.client.request("send", { to: "b", body: "see", attachments: [{ kind: "path", path: join(work, "notes.md") }] }))).toBeUndefined()
    expect(await code(a.client.request("send", { to: "b", body: "see", attachments: [{ kind: "path", path: join(root, "outside.md") }] }))).toBe(
      "invalid_params",
    )
    expect(await code(a.client.request("send", { to: "b", body: "see", attachments: [{ kind: "path", path: join(work, "missing.md") }] }))).toBe("not_found")
  })

  test("a broker with nobody connected exits after its idle time, and connectBroker starts one on demand", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-broker-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, "state")
    let started: Broker | undefined
    const client = await connectBroker(dir, () => {
      void startBroker({ dir, idleMs: 200, policyPath: join(root, "none.json") }).then((b) => (started = b))
    })
    expect((await client.hello({ human: true })).endpoint!.address).toBe("me/")
    client.close()
    await Promise.race([started!.stopped, Bun.sleep(3000).then(() => Promise.reject(new Error("broker did not idle out")))])
  })

  test("a socket that refuses connects while the broker lock is held is a sandbox, not a missing broker", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-broker-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const dir = privateDir(join(root, "state"))
    const path = socketPath(dir)
    privateDir(dirname(path))
    cleanups.push(() => rmSync(path, { force: true }))
    const listener = Bun.listen({ unix: `${path}.live`, socket: { data() {} } })
    linkSync(`${path}.live`, path)
    listener.stop(true)
    const lock = takeBrokerLock(join(dir, "broker.lock"))
    let starts = 0
    try {
      const error = await connectBroker(dir, () => starts++, 300).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(BrokerUnavailable)
      expect((error as Error).message).toMatch(/^the sandbox blocks the relay socket \((ECONNREFUSED|ENOENT)\)/)
      expect((error as Error).message).toEndWith(`; allow ${path} or run outside the sandbox`)
      expect(starts).toBe(0)
    } finally {
      releaseBrokerLock(lock)
    }
    const error = await connectBroker(dir, () => starts++, 300).catch((e: unknown) => e)
    expect((error as Error).message).toStartWith("the relay broker did not start within 300 ms")
    expect(starts).toBe(1)
  })

  test("a /tmp socket directory that is a link or writable by others is refused before a hello is sent", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-broker-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const dir = privateDir(join(root, "s".repeat(100)))
    const path = socketPath(dir)
    expect(dirname(path)).toStartWith("/tmp/scp-")
    const target = privateDir(join(root, "target"))
    for (const plant of [() => chmodSync(privateDir(dirname(path)), 0o777), () => symlinkSync(target, dirname(path))]) {
      rmSync(dirname(path), { recursive: true, force: true })
      plant()
      cleanups.push(() => rmSync(dirname(path), { recursive: true, force: true }))
      const got: string[] = []
      const listener = Bun.listen({ unix: path, socket: { data: (_s, chunk) => void got.push(chunk.toString()) } })
      try {
        const result = await connectBroker(dir, () => {}, 300).catch((e: unknown) => e)
        if (result instanceof RelayClient) {
          void result.hello({ human: true }).catch(() => {})
          await Bun.sleep(50)
          result.close()
        }
        expect(result).toBeInstanceOf(BrokerUnavailable)
        expect(got).toEqual([])
      } finally {
        listener.stop(true)
        rmSync(path, { force: true })
      }
    }
  })

  test("a connect a sandbox refuses names the socket to allow and starts no broker", async () => {
    const dir = join(tmpdir(), "relay-sandboxed")
    for (const code of ["EPERM", "EACCES"]) {
      const connect = spyOn(RelayClient, "connect").mockRejectedValue(Object.assign(new Error("Failed to connect"), { code }))
      let starts = 0
      try {
        const error = await connectBroker(dir, () => starts++).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(BrokerUnavailable)
        expect((error as Error).message).toBe(`the sandbox blocks the relay socket (${code}); allow ${socketPath(dir)} or run outside the sandbox`)
        expect(starts).toBe(0)
        expect(connect).toHaveBeenCalledTimes(1)
      } finally {
        connect.mockRestore()
      }
    }
    const connect = spyOn(RelayClient, "connect")
      .mockRejectedValueOnce(Object.assign(new Error("Failed to connect"), { code: "ENOENT" }))
      .mockRejectedValue(Object.assign(new Error("Failed to connect"), { code: "EPERM" }))
    let starts = 0
    try {
      const started = Date.now()
      const error = await connectBroker(dir, () => starts++, 5000).catch((e: unknown) => e)
      expect((error as Error).message).toBe(`the sandbox blocks the relay socket (EPERM); allow ${socketPath(dir)} or run outside the sandbox`)
      expect(starts).toBe(1)
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      connect.mockRestore()
    }
  })
})

describe("broker, state ownership", () => {
  test("a broker whose state directory was wiped stops", async () => {
    const { root, broker } = await setup({ ownershipEveryMs: 20 })
    rmSync(join(root, "state"), { recursive: true, force: true })
    expect(await Promise.race([broker.stopped.then(() => "stopped"), Bun.sleep(2000).then(() => "running")])).toBe("stopped")
  })

  test("a broker whose socket another took over stops and leaves that socket", async () => {
    const { broker } = await setup({ ownershipEveryMs: 20 })
    rmSync(broker.socket)
    writeFileSync(broker.socket, "")
    expect(await Promise.race([broker.stopped.then(() => "stopped"), Bun.sleep(2000).then(() => "running")])).toBe("stopped")
    expect(existsSync(broker.socket)).toBe(true)
  })
})

describe("broker, framing and connection limits", () => {
  test("large pages of multibyte text cross the socket intact", async () => {
    const { broker } = await setup()
    const a = await agent(broker, "a")
    const b = await agent(broker, "b")
    const body = "ü日本🙂".repeat(5000)
    for (let i = 0; i < 15; i++) await a.client.request("send", { to: "b", body: `${i}:${body}` })
    const inbox = await b.client.request<{ messages: { body: { text: string } }[] }>("inbox")
    expect(inbox.messages).toHaveLength(15)
    expect(inbox.messages.every((m, i) => m.body.text === `${i}:${body}`)).toBe(true)
  })

  test("a single oversized line is refused before it is parsed, and the connection closed", async () => {
    const { broker } = await setup()
    let received = ""
    let closed = false
    const raw = await Bun.connect({
      unix: broker.socket,
      socket: {
        data: (_s, chunk) => {
          received += chunk.toString()
        },
        close: () => {
          closed = true
        },
      },
    })
    let bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { pad: "x".repeat(300 * 1024) } })}\n`)
    for (let i = 0; i < 500 && bytes.length && !closed; i++) {
      const written = raw.write(bytes)
      if (written > 0) bytes = bytes.subarray(written)
      else await Bun.sleep(5)
    }
    for (let i = 0; i < 100 && !closed; i++) await Bun.sleep(20)
    expect(received).toContain('"too_large"')
    expect(closed).toBe(true)
  })

  test("a cwd of / or the home directory is no attachment root", async () => {
    const { root, broker } = await setup()
    writeFileSync(join(root, "file.md"), "x")
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    await client.hello({ claim: { handle: "wide", cwd: "/" } })
    await agent(broker, "b")
    expect(await code(client.request("send", { to: "b", body: "see", attachments: [{ kind: "path", path: join(root, "file.md") }] }))).toBe("invalid_params")
  })

  test("a reply returned by ask is acked, so it does not come back in the inbox", async () => {
    const { broker } = await setup()
    const a = await agent(broker, "a")
    const b = await agent(broker, "b")
    const asking = a.client.request<{ reply?: object }>("ask", { to: "b", body: "q", wait_s: 5 })
    const inbox = await b.client.request<{ messages: { id: string }[] }>("inbox", { wait_s: 5 })
    await b.client.request("send", { to: "a", kind: "reply", reply_to: inbox.messages[0]!.id, body: "r" })
    expect((await asking).reply).toBeDefined()
    expect(await a.client.request<{ messages: unknown[] }>("inbox")).toMatchObject({ messages: [] })
  })

  test("stopping with a watcher and a long poll attached shuts down cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-broker-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const broker = await startBroker({ dir: join(root, "state"), idleMs: 0, policyPath: join(root, "none.json") })
    const watcher = await RelayClient.connect(broker.socket)
    await watcher.hello({ human: true })
    await watcher.request("watch")
    const a = await RelayClient.connect(broker.socket)
    await a.hello({ claim: { handle: "a" } })
    const polling = a.request("inbox", { wait_s: 30 }).catch((error: Error) => error)
    await Bun.sleep(50)
    await broker.stop()
    expect(await polling).toBeInstanceOf(Error)
    expect(statSync(broker.socket, { throwIfNoEntry: false })).toBeUndefined()
  })

  test("a valid line before an oversized one is still answered", () => {
    const reader = new LineReader(16)
    const { lines, tooLong } = reader.push(new TextEncoder().encode(`{"ok":1}\n${"x".repeat(40)}\n`))
    expect(lines).toEqual(['{"ok":1}'])
    expect(tooLong).toBe(true)
  })
})

/** a socket that speaks raw lines, for what a well-behaved client never sends */
async function raw(path: string) {
  const state = { text: "", closed: false }
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data: (_s, chunk) => {
        state.text += Buffer.from(chunk).toString()
      },
      close: () => {
        state.closed = true
      },
    },
  })
  cleanups.push(() => void socket.end())
  const lines = () =>
    state.text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown>; error?: { code: number }; result?: unknown })
  const until = async (done: () => boolean, ms = 5000) => {
    for (const deadline = Date.now() + ms; !done() && Date.now() < deadline; ) await Bun.sleep(10)
    return done()
  }
  return { socket, state, lines, until }
}

describe("broker, hardening", () => {
  test("lines that are JSON but no request object are refused, and the broker keeps serving", async () => {
    const { broker } = await setup()
    const r = await raw(broker.socket)
    r.socket.write(
      'null\n[]\n1\n"x"\n{"jsonrpc":"2.0","id":{},"method":"list"}\n{"jsonrpc":"2.0","id":7,"method":7}\n{"jsonrpc":"2.0","id":8,"method":"list","params":[1]}\n',
    )
    expect(await r.until(() => r.lines().length >= 7)).toBe(true)
    expect(r.lines().map((line) => [line.id, line.error?.code])).toEqual([
      [null, -32600],
      [null, -32600],
      [null, -32600],
      [null, -32600],
      [null, -32600],
      [7, -32600],
      [8, -32600],
    ])
    const a = await agent(broker, "after")
    expect(a.hello.endpoint!.address).toBe("me/after")
  })

  test("a policy file that exists but cannot be read refuses sends instead of opening them", async () => {
    const { broker, policyPath } = await setup()
    mkdirSync(policyPath)
    const a = await agent(broker, "a")
    await agent(broker, "b")
    expect(await code(a.client.request("send", { to: "b", body: "x" }))).toBe("policy_refused")
    expect(await a.client.request("policy")).toMatchObject({ file: policyPath, state: "error" })
    rmSync(policyPath, { recursive: true })
    expect(await code(a.client.request("send", { to: "b", body: "x" }))).toBeUndefined()
    expect(await a.client.request("policy")).toMatchObject({ state: "open", policy: null })
  })

  test("status and policy tell which socket and policy file the broker uses, to an observer without identity", async () => {
    const { broker, policyPath } = await setup({ policy: { rules: [] } })
    const observer = await RelayClient.connect(broker.socket)
    cleanups.push(() => observer.close())
    const hello = await observer.hello({ observe: true })
    expect(hello.endpoint).toBeNull()
    expect(hello.broker).toMatchObject({ socket: broker.socket, policy: { file: policyPath, state: "loaded" } })
    expect(await observer.request("snapshot")).toMatchObject({ broker: { socket: broker.socket, pid: process.pid } })
    expect(await observer.request("policy")).toMatchObject({ state: "loaded", policy: { rules: [] } })
    expect(await code(observer.request("send", { to: "me/", body: "x" }))).toBe("unauthorized")
    expect(await code(observer.request("inbox"))).toBe("unauthorized")
  })

  test("a watcher that stops reading gets one lagged notice instead of an unbounded queue", async () => {
    const cap = 64 * 1024
    const { broker } = await setup({ outboundCapBytes: cap })
    const w = await raw(broker.socket)
    w.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: "scp/1", observe: true } })}\n`)
    w.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "watch" })}\n`)
    expect(await w.until(() => w.lines().some((line) => line.id === 2))).toBe(true)
    w.socket.pause()
    const a = await agent(broker, "busy")
    const summary = "s".repeat(150)
    let sent = 0
    for (let batch = 0; batch < 200; batch++) {
      await Promise.all(Array.from({ length: 30 }, () => a.client.request("event", { kind: "tool", tool: "Bash", summary })))
      sent += 30
    }
    const before = w.state.text.length
    w.socket.resume()
    await w.until(() => w.lines().some((line) => line.params?.type === "lagged"))
    await Bun.sleep(100)
    const events = w.lines().filter((line) => line.method === "fleet")
    expect(events.filter((line) => line.params?.type === "lagged")).toHaveLength(1)
    expect(events.length).toBeLessThan(sent / 2)
    expect(w.state.text.length - before).toBeLessThan(sent * 100)
    w.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "watch" })}\n`)
    expect(await w.until(() => w.lines().some((line) => line.id === 3))).toBe(true)
    await a.client.request("event", { kind: "note", summary: "after the lag" })
    expect(await w.until(() => w.lines().some((line) => line.params?.summary === "after the lag"))).toBe(true)
  }, 20_000)

  test("a connection never runs more than maxPending requests at once; the rest wait their turn", async () => {
    const { broker } = await setup({ maxPending: 4 })
    const a = await agent(broker, "poller")
    const polls = Array.from({ length: 4 }, () => a.client.request("inbox", { wait_s: 1 }))
    const started = Date.now()
    await a.client.request("whoami")
    expect(Date.now() - started).toBeGreaterThanOrEqual(800)
    await Promise.all(polls)
  })

  test("a request line left unfinished is cut off", async () => {
    const { broker } = await setup({ partialLineMs: 100 })
    const r = await raw(broker.socket)
    r.socket.write('{"jsonrpc":"2.0","id":1,"method":"hel')
    expect(await r.until(() => r.state.closed, 3000)).toBe(true)
    expect(r.state.text).toContain("not finished in time")
  })

  test("the chunked writer hands bytes over in order across partial writes", () => {
    const writer = new LineWriter()
    for (let i = 0; i < 1000; i++) writer.push({ i })
    const got: Uint8Array[] = []
    let budget = 7
    for (let round = 0; writer.pending && round < 100_000; round++) {
      writer.flush((bytes) => {
        const n = Math.min(bytes.length, budget)
        if (!n) return 0
        got.push(bytes.slice(0, n))
        budget -= n
        return n
      })
      budget = 7 + (round % 13)
    }
    const text = Buffer.concat(got).toString()
    expect(
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { i: number }).i),
    ).toEqual(Array.from({ length: 1000 }, (_, i) => i))
  })
})

describe("broker, partial lines", () => {
  test("each unfinished line gets its own deadline, not the one before it", async () => {
    const { broker } = await setup({ partialLineMs: 300 })
    const r = await raw(broker.socket)
    const hello = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: "scp/1", observe: true } })}\n`
    const list = `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "list" })}\n`
    r.socket.write(hello.slice(0, 10))
    await Bun.sleep(200)
    r.socket.write(hello.slice(10) + list.slice(0, 10))
    await Bun.sleep(200)
    r.socket.write(list.slice(10))
    expect(await r.until(() => r.lines().some((line) => line.id === 2))).toBe(true)
    expect(r.state.closed).toBe(false)
  })
})

describe("broker, hooks", () => {
  async function hook(broker: Broker, claim: { handle?: string; harness?: string; session?: string; process?: string }) {
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    const hello = await client.hello({ transient: true, claim })
    return { client, hello }
  }

  test("a hook connection joins its session's endpoint without a token, and may only post activity and status", async () => {
    const { broker } = await setup()
    const shim = await RelayClient.connect(broker.socket)
    cleanups.push(() => shim.close())
    const claimed = await shim.hello({ claim: { handle: "lane", harness: "claude-code", session: "s1" } })
    const h = await hook(broker, { handle: "claude-code", harness: "claude-code", session: "s1" })
    expect(h.hello.endpoint!.id).toBe(claimed.endpoint!.id)
    expect(h.hello.token).toBeUndefined()
    expect(await h.client.request("whoami")).toMatchObject({ address: "me/lane" })
    expect(await h.client.request("event", { kind: "tool", tool: "Bash", agent: "Explore 3f2a9c" })).toMatchObject({
      endpoint: "me/lane",
      agent: "Explore 3f2a9c",
    })
    expect(await h.client.request("status", { state: "working", note: "hooked" })).toMatchObject({ status: { state: "working" } })
    for (const method of ["send", "inbox", "ack", "list", "snapshot", "watch"]) {
      expect(await code(h.client.request(method, { to: "me/", body: "x", seqs: [] }))).toBe("unauthorized")
    }
    for (const extra of [{ human: true }, { observe: true }, { resume: claimed.token! }]) {
      const client = await RelayClient.connect(broker.socket)
      cleanups.push(() => client.close())
      expect(await code(client.hello({ transient: true, claim: { harness: "claude-code", session: "s1" }, ...extra }))).toBe("invalid_params")
    }
  })

  test("closing a hook connection does not disconnect the endpoint it posted for", async () => {
    const { root, broker } = await setup()
    const shim = await RelayClient.connect(broker.socket)
    cleanups.push(() => shim.close())
    const claimed = await shim.hello({ claim: { handle: "lane", harness: "codex", session: "s1" } })
    const h = await hook(broker, { harness: "codex", session: "s1" })
    h.client.close()
    await Bun.sleep(100)
    const db = new Database(join(root, "state", "relay.db"), { readonly: true })
    cleanups.push(() => db.close())
    expect(db.query("SELECT connections FROM endpoints WHERE id = ?").get(claimed.endpoint!.id)).toEqual({ connections: 1 })
  })

  test("a hook tells the fleet about presence only when it changes, and its events keep the endpoint present", async () => {
    const clock = { now: Date.now() }
    const { broker } = await setup({ now: () => clock.now })
    const watcher = await RelayClient.connect(broker.socket)
    cleanups.push(() => watcher.close())
    await watcher.hello({ observe: true })
    const events: Record<string, unknown>[] = []
    watcher.onNotification((method, params) => method === "fleet" && events.push(params as Record<string, unknown>))
    await watcher.request("watch")
    const first = await hook(broker, { handle: "worker", harness: "codex", session: "s2" })
    await hook(broker, { handle: "worker", harness: "codex", session: "s2" })
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    const presence = async () =>
      (await watcher.request<{ endpoints: { address: string; presence: string }[] }>("list", { all: true })).endpoints.find((e) => e.address === "me/worker")!
        .presence
    expect(await presence()).toBe("offline")
    await first.client.request("event", { kind: "tool", tool: "Read" })
    expect(await presence()).toBe("online")
    await hook(broker, { handle: "worker", harness: "codex", session: "s2" })
    await Bun.sleep(50)
    expect(events.filter((e) => e.type === "presence")).toEqual([expect.objectContaining({ endpoint: "me/worker", presence: "online" })])
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    await hook(broker, { handle: "worker", harness: "codex", session: "s2" })
    await Bun.sleep(50)
    expect(events.filter((e) => e.type === "presence").map((e) => e.presence)).toEqual(["online", "online"])
  })

  test("a hook's hello, event and inject go out together and are answered in one round trip, each message offered once", async () => {
    const { broker } = await setup()
    const peer = await agent(broker, "peer")
    const shim = await agent(broker, "lane", "codex")
    await peer.client.request("send", { to: "lane", body: "first" })
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    const replies = await Promise.all([
      client.hello({ transient: true, claim: { handle: "lane", harness: "codex" } }),
      client.request("event", { kind: "tool", tool: "Read" }),
      client.request<{ messages: { body: { text: string } }[]; more: number; unread: number; block: boolean }>("inject", {}),
    ])
    expect(replies[0].endpoint!.id).not.toBe(shim.hello.endpoint!.id)
    const hooked = await hook(broker, { handle: "x", harness: "codex", session: "inj" })
    const joined = await RelayClient.connect(broker.socket)
    cleanups.push(() => joined.close())
    await joined.hello({ claim: { handle: "x", harness: "codex", session: "inj" } })
    await peer.client.request("send", { to: "x", body: "for x" })
    const injected = await hooked.client.request<{ messages: { body: { text: string } }[]; unread: number }>("inject", {})
    expect(injected.messages.map((m) => m.body.text)).toEqual(["for x"])
    expect(await hooked.client.request("inject", {})).toMatchObject({ messages: [], unread: 1, block: false })
    expect(await hooked.client.request("inject", { stop: true })).toMatchObject({ messages: [], unread: 1, block: false })
    expect(await hooked.client.request("inject", { stop: true, hold_unread: true })).toMatchObject({ messages: [], unread: 1, block: true, forced: true })
  })

  test("a hook confirms what it showed on its own connection, a counting stop offers nothing, and a shim finds a delivery by id", async () => {
    const clock = { now: Date.now() }
    const { broker } = await setup({ now: () => clock.now })
    const peer = await agent(broker, "peer")
    const shim = { client: await RelayClient.connect(broker.socket) }
    cleanups.push(() => shim.client.close())
    await shim.client.hello({ claim: { handle: "confirmer", harness: "codex", session: "cf" } })
    const sent = await peer.client.request<{ id: string }>("send", { to: "confirmer", body: "show me" })
    const h = await hook(broker, { handle: "codex-repo", harness: "codex", session: "cf" })
    expect(await h.client.request<unknown>("inject", { stop: true, count: true, hold_unread: true })).toEqual({
      messages: [],
      offered: [],
      hold: null,
      more: 0,
      unread: 1,
      block: true,
      forced: true,
    })
    const offered = await h.client.request<{ offered: number[]; hold: string }>("inject", {})
    expect(await h.client.request<unknown>("injected", { seqs: offered.offered })).toEqual({ injected: 0 })
    expect(await h.client.request<unknown>("injected", { seqs: offered.offered, hold: offered.hold })).toEqual({ injected: 1 })
    clock.now += LIMITS.injectHoldS * 1000
    expect(await h.client.request("inject", {})).toMatchObject({ messages: [], offered: [] })
    expect(await shim.client.request<unknown>("inbox", { offer: true })).toMatchObject({ messages: [], hold: null })
    expect(await shim.client.request("message", { id: sent.id })).toMatchObject({ message: { id: sent.id, from: { address: "me/peer" } } })
    expect(await peer.client.request<unknown>("message", { id: sent.id })).toEqual({ message: null })
    expect(await peer.client.request<unknown>("message", { id: sent.id, member: true })).toEqual({ message: null })
    const third = await agent(broker, "third")
    const kick = await peer.client.request<{ thread: string }>("send", { to: ["confirmer", "third"], body: "both" })
    const aside = await peer.client.request<{ id: string }>("send", { to: "confirmer", body: "aside", thread: kick.thread })
    expect(await third.client.request<unknown>("message", { id: aside.id })).toEqual({ message: null })
    const member = await third.client.request<{ message: Record<string, unknown> }>("message", { id: aside.id.slice(-6), member: true })
    expect(member.message).toMatchObject({ id: aside.id, thread: kick.thread, from: { address: "me/peer" } })
    expect(member.message).not.toHaveProperty("body")
    expect(await code(h.client.request("message", { id: sent.id }))).toBe("unauthorized")
  })

  test("a hook from a child process of the session's harness takes none of its mail, and a printed stop hold counts once confirmed", async () => {
    const { broker } = await setup()
    const peer = await agent(broker, "peer")
    const P1 = `pid:${process.pid}:Wed-Oct-15-10:00:00-2026`
    const shim = await RelayClient.connect(broker.socket)
    cleanups.push(() => shim.close())
    await shim.hello({ claim: { handle: "parent", harness: "claude-code", session: "env:inherited", process: P1 } })
    await peer.client.request("send", { to: "parent", body: "for the parent" })
    const child = await hook(broker, { harness: "claude-code", session: "env:inherited", process: "pid:200:Wed-Oct-15-10:00:00-2026" })
    expect(await child.client.request<unknown>("inject", {})).toEqual({ messages: [], offered: [], hold: null, more: 0, unread: 0, block: false })
    expect(await child.client.request<unknown>("injected", { seqs: [], stop: true })).toEqual({ injected: 0, held: false })
    const own = await hook(broker, { harness: "claude-code", session: "env:inherited", process: P1 })
    for (let i = 0; i < LIMITS.stopBlocks; i++) {
      expect(await own.client.request<unknown>("inject", { stop: true, count: true, hold_unread: true })).toMatchObject({ unread: 1, block: true })
      expect(await own.client.request<unknown>("injected", { seqs: [], stop: true })).toEqual({ injected: 0, held: true })
    }
    expect(await own.client.request<unknown>("inject", { stop: true, count: true, hold_unread: true })).toMatchObject({ unread: 1, block: false })
    expect((await own.client.request<{ messages: { body: { text: string } }[] }>("inject", {})).messages.map((m) => m.body.text)).toEqual(["for the parent"])
  })

  test("a stop's nudge about an unanswered request is confirmed over the socket once printed, and not counted as a held stop", async () => {
    const { broker } = await setup()
    const peer = await agent(broker, "peer")
    const P1 = `pid:${process.pid}:Wed-Oct-15-10:00:00-2026`
    const shim = await RelayClient.connect(broker.socket)
    cleanups.push(() => shim.close())
    await shim.hello({ claim: { handle: "nudged", harness: "claude-code", session: "env:nudge", process: P1 } })
    const asked = await peer.client.request<{ id: string }>("send", { to: "nudged", body: "QUESTION-BODY", kind: "request" })
    const own = await hook(broker, { harness: "claude-code", session: "env:nudge", process: P1 })
    const stop = await own.client.request<Record<string, unknown> & { nudge: StopNudge[] }>("inject", { stop: true, count: true })
    expect(stop).toEqual({
      messages: [],
      offered: [],
      hold: null,
      more: 0,
      unread: 1,
      block: true,
      forced: false,
      nudge: [{ seq: expect.any(Number), from: "me/peer", id: asked.id, unread: true }],
    })
    expect(JSON.stringify(stop)).not.toContain("QUESTION-BODY")
    const child = await hook(broker, { harness: "claude-code", session: "env:nudge", process: "pid:200:Wed-Oct-15-10:00:00-2026" })
    expect(await child.client.request<unknown>("injected", { seqs: [], nudged: stop.nudge.map((n) => n.seq) })).toEqual({ injected: 0, nudged: 0 })
    expect(await own.client.request<unknown>("injected", { seqs: [], nudged: stop.nudge.map((n) => n.seq) })).toEqual({ injected: 0, nudged: 1 })
    expect(await own.client.request<unknown>("inject", { stop: true, count: true })).toEqual({
      messages: [],
      offered: [],
      hold: null,
      more: 0,
      unread: 1,
      block: false,
      forced: false,
    })
    expect(await code(own.client.request("injected", { seqs: [], nudged: ["x"] }))).toBe("invalid_params")
  })

  test("a shim that renames its hooks' endpoint tells the fleet the new address", async () => {
    const { broker } = await setup()
    const watcher = await RelayClient.connect(broker.socket)
    cleanups.push(() => watcher.close())
    await watcher.hello({ observe: true })
    const events: Record<string, unknown>[] = []
    watcher.onNotification((method, params) => method === "fleet" && events.push(params as Record<string, unknown>))
    await watcher.request("watch")
    const hooked = await hook(broker, { handle: "codex-repo", harness: "codex", session: "rn", process: `pid:${process.pid}` })
    const shim = await RelayClient.connect(broker.socket)
    cleanups.push(() => shim.close())
    const claimed = await shim.hello({ claim: { handle: "renamed-lane", harness: "codex", session: "rn", process: `pid:${process.pid}` } })
    expect(claimed.endpoint!.id).toBe(hooked.hello.endpoint!.id)
    await Bun.sleep(50)
    expect(events.filter((e) => e.type === "presence").map((e) => e.endpoint)).toEqual(["me/codex-repo", "me/renamed-lane"])
  })

  test("presence events come only on a change: a second connection and one-shot commands add none", async () => {
    const { broker } = await setup()
    const watcher = await RelayClient.connect(broker.socket)
    cleanups.push(() => watcher.close())
    await watcher.hello({ observe: true })
    const events: Record<string, unknown>[] = []
    watcher.onNotification((method, params) => method === "fleet" && events.push(params as Record<string, unknown>))
    await watcher.request("watch")
    const first = await agent(broker, "steady", "codex")
    const second = await RelayClient.connect(broker.socket)
    await second.hello({ resume: first.hello.token! })
    second.close()
    const cli = await RelayClient.connect(broker.socket)
    await cli.hello({ claim: { handle: "oneshot", harness: "cli" }, brief: true })
    cli.close()
    const human = await RelayClient.connect(broker.socket)
    await human.hello({ human: true, brief: true })
    human.close()
    await first.client.request("status", { state: "done" })
    first.client.close()
    await Bun.sleep(100)
    expect(events.filter((e) => e.type === "presence").map((e) => [e.endpoint, e.presence])).toEqual([
      ["me/steady", "online"],
      ["me/steady", "offline"],
    ])
    expect(events.filter((e) => e.type === "status").map((e) => (e.status as { state: string } | null)?.state)).toEqual(["done"])
  })
})

describe("broker, limits", () => {
  test("a request over the broker's line cap once escaped is refused by the client, and the connection stays usable", async () => {
    const { broker } = await setup()
    const a = await agent(broker, "a")
    await agent(broker, "b")
    const refused = await a.client.request("send", { to: "b", body: "\u0001".repeat(64 * 1024) }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(RelayError)
    expect((refused as RelayError).code).toBe("too_large")
    expect((refused as RelayError).message).toContain("line limit")
    expect(await a.client.request("whoami")).toMatchObject({ address: "me/a" })
  })

  test("one response larger than the outbound cap still goes, but a reader that lets responses pile up past it is ended", async () => {
    const { broker } = await setup({ outboundCapBytes: 8 * 1024, log: () => {} })
    const a = await agent(broker, "a")
    const b = await agent(broker, "b")
    await a.client.request("send", { to: "b", body: "x".repeat(16 * 1024) })
    expect((await b.client.request<{ messages: unknown[] }>("inbox")).messages).toHaveLength(1)
    const r = await raw(broker.socket)
    r.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: "scp/1", claim: { handle: "c" } } })}\n`)
    expect(await r.until(() => r.lines().some((line) => line.id === 1))).toBe(true)
    await a.client.request("send", { to: "c", body: "y".repeat(16 * 1024) })
    r.socket.pause()
    const asks = 200
    r.socket.write(Array.from({ length: asks }, (_, i) => `${JSON.stringify({ jsonrpc: "2.0", id: i + 2, method: "inbox" })}\n`).join(""))
    await Bun.sleep(300)
    r.socket.resume()
    expect(await r.until(() => r.state.closed)).toBe(true)
    expect(r.state.text.split("\n").slice(0, -1).length - 1).toBeLessThan(asks)
  })

  test("a policy path that is a link to a missing file refuses sends instead of opening them", async () => {
    const { root, broker, policyPath } = await setup()
    symlinkSync(join(root, "missing.json"), policyPath)
    const a = await agent(broker, "a")
    await agent(broker, "b")
    expect(await code(a.client.request("send", { to: "b", body: "x" }))).toBe("policy_refused")
    expect(await a.client.request("policy")).toMatchObject({ state: "error", error: expect.stringContaining("a link to a missing file") })
    writeFileSync(join(root, "missing.json"), JSON.stringify({ rules: [] }))
    expect(await code(a.client.request("send", { to: "b", body: "x" }))).toBeUndefined()
  })

  test("two agents auto-replying over the socket are stopped by the pair burst, and why and the log say so", async () => {
    const { broker } = await setup()
    const a = await agent(broker, "a")
    const b = await agent(broker, "b")
    let refused: RelayError | undefined
    const respond = async (client: RelayClient) => {
      while (!refused) {
        const { messages } = await client.request<{ messages: { id: string; seq: number; from: { address: string } }[] }>("inbox", { wait_s: 1 })
        if (messages.length) await client.request("ack", { seqs: messages.map((m) => m.seq) })
        for (const message of messages) {
          await client.request("send", { to: message.from.address, body: "re", kind: "reply", reply_to: message.id }).catch((error: unknown) => {
            refused = error as RelayError
          })
        }
      }
    }
    await a.client.request("send", { to: "b", body: "go" })
    await Promise.all([respond(a.client), respond(b.client)])
    expect(refused).toBeInstanceOf(RelayError)
    expect(refused!.code).toBe("rate_limited")
    expect(refused!.message).toMatch(
      new RegExp(
        `^${LIMITS.pairBurst + 1} messages between me/[ab] and me/[ab] in ${LIMITS.pairBurstWindowS} s \\(limit ${LIMITS.pairBurst}\\): pausing this pair; retry after \\d+ s$`,
      ),
    )
    const human = await RelayClient.connect(broker.socket)
    cleanups.push(() => human.close())
    await human.hello({ human: true, tty: true })
    const why = await human.request<{ allowed: boolean; reasons: string[]; pair?: { burst?: { n: number }; refused?: { code: string } } }>("why", {
      from: "a",
      to: "b",
    })
    expect(why.allowed).toBe(false)
    expect(why.pair).toMatchObject({ burst: { n: LIMITS.pairBurst }, refused: { code: "rate_limited" } })
    expect(why.reasons.at(-1)).toContain(`rate_limited: ${refused!.message}`)
    const { rows } = await human.request<{ rows: { event: string; detail: Record<string, unknown> }[] }>("log", { limit: 5 })
    expect(rows.filter((row) => row.event === "refuse").at(-1)!.detail).toMatchObject({
      code: "rate_limited",
      limit: LIMITS.pairBurst,
      window_s: LIMITS.pairBurstWindowS,
    })
  })

  test("stopping removes the /tmp directory a socket falls back to", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-broker-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, "d".repeat(120))
    const broker = await startBroker({ dir, idleMs: 0, policyPath: join(root, "none.json") })
    cleanups.push(() => rmSync(dirname(broker.socket), { recursive: true, force: true }))
    expect(dirname(broker.socket)).not.toBe(dir)
    expect(existsSync(dirname(broker.socket))).toBe(true)
    await broker.stop()
    expect(existsSync(dirname(broker.socket))).toBe(false)
  })
})

describe("broker, scopes", () => {
  const T = "Thu-Oct-16-09:00:00-2026"
  const key = (pid: number) => `pid:${pid}:${T}`

  async function placed(broker: Broker, handle: string, pid: number, lineage: number[] = []) {
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    const hello = await client.hello({ claim: { handle, harness: "codex", process: key(pid), lineage: [key(pid), ...lineage.map(key)] } })
    return { client, hello }
  }

  async function observer(broker: Broker, lineage?: number[]) {
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    await client.hello({ observe: true, ...(lineage ? { lineage: lineage.map(key) } : {}) })
    return client
  }

  async function human(broker: Broker, tty: boolean, lineage?: number[]) {
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    await client.hello({ human: true, tty, ...(lineage ? { lineage: lineage.map(key) } : {}) })
    return client
  }

  /** main (pid 100) with orch (pid 200) under it and a worker w (pid 300) under orch, which accepts and reaches only its parent */
  async function fleet(broker: Broker) {
    const main = await placed(broker, "main", 100)
    const orch = await placed(broker, "orch", 200, [100])
    const w = await placed(broker, "w", 300, [250, 200, 100])
    await w.client.rulesSet({ scope: "parent" })
    return { main, orch, w }
  }

  const addresses = (endpoints: { address: string }[]) => endpoints.map((e) => e.address).sort()

  test("a hook connection is refused every scope method", async () => {
    const { broker } = await setup()
    await placed(broker, "lane", 100)
    const hook = await RelayClient.connect(broker.socket)
    cleanups.push(() => hook.close())
    await hook.hello({ transient: true, claim: { handle: "lane", harness: "codex", session: key(100), process: key(100) } })
    for (const method of ["rules", "rules_set", "rules_widen", "rules_lift", "grant", "group", "admin", "peers", "why", "spawn_exit"]) {
      expect(await code(hook.request(method, { endpoint: "lane", in: ["tree:self"], cap: "cap_x", action: "ls", from: "lane", to: "me/" }))).toBe(
        "scope_refused",
      )
    }
  })

  test("lineage places agents under the endpoint holding the nearest key, and the views say so", async () => {
    const { broker } = await setup()
    const { main, orch, w } = await fleet(broker)
    expect(await main.client.rules("orch")).toMatchObject({ address: "me/orch", parent: "me/main", tree: "me/main", depth: 1 })
    expect(await orch.client.rules("w")).toMatchObject({ address: "me/w", parent: "me/orch", depth: 2, preset: "parent" })
    expect(await code(w.client.rules("orch"))).toBe("not_found")
    const listed = await orch.client.request<{ endpoints: { address: string; parent?: string | null; depth?: number }[] }>("list")
    expect(listed.endpoints.find((e) => e.address === "me/w")).toMatchObject({ parent: "me/orch", depth: 2 })
  })

  test("an agent lists, snapshots and logs only what it could message or be messaged by; the human sees everything", async () => {
    const { broker } = await setup()
    const { main, w } = await fleet(broker)
    expect(await code(w.client.request("send", { to: "main", body: "hi" }))).toBe("not_found")
    const seen = await w.client.request<{ endpoints: { address: string }[] }>("list", { all: true, viewer: (main.hello.endpoint as { id: string }).id })
    expect(addresses(seen.endpoints)).toEqual(["me/", "me/orch", "me/w"])
    const snapshot = await w.client.request<{ endpoints: { address: string }[] }>("snapshot", { all: true })
    expect(addresses(snapshot.endpoints)).toEqual(["me/", "me/orch", "me/w"])
    const everyone = await (await human(broker, true)).request<{ endpoints: { address: string }[] }>("list", { all: true })
    expect(addresses(everyone.endpoints)).toEqual(["me/", "me/main", "me/orch", "me/w"])
    const log = await w.client.request<{ rows: { endpoint: string | null; event: string }[] }>("log", { scope: true })
    expect(log.rows.length).toBeGreaterThan(0)
    expect(log.rows.every((row) => row.event.startsWith("scope_") && row.endpoint !== "me/main")).toBe(true)
    const all = await main.client.request<{ rows: { event: string }[] }>("log", { scope: true })
    expect(all.rows.every((row) => row.event.startsWith("scope_"))).toBe(true)
  })

  test("an agent reads the policy's state but not its rules, and checks it only for pairs it could ask why about; the human reads and checks all", async () => {
    const { broker } = await setup({ policy: { rules: [] } })
    const { w } = await fleet(broker)
    const shell = await observer(broker, [301, 300, 200])
    for (const viewer of [w.client, shell]) {
      expect(await viewer.request("policy")).toMatchObject({ state: "loaded", policy: null })
      expect(await code(viewer.request("policy_check", { from: "main", to: "orch" }))).toBe("not_found")
      expect(await code(viewer.request("policy_check", { from: "orch", to: "main" }))).toBe("not_found")
      expect(await viewer.request("policy_check", { from: "w", to: "orch" })).toMatchObject({ allowed: true })
    }
    for (const viewer of [await observer(broker), await human(broker, true)]) {
      expect(await viewer.request("policy")).toMatchObject({ state: "loaded", policy: { rules: [] } })
      expect(await viewer.request("policy_check", { from: "orch", to: "main" })).toMatchObject({ allowed: true })
    }
  })

  test("an observer whose lineage lands on an endpoint gets its view and may only narrow; one with none sees what the human may message without a terminal and only reads", async () => {
    const { broker } = await setup()
    await fleet(broker)
    const shell = await observer(broker, [301, 300, 200])
    expect(addresses((await shell.request<{ endpoints: { address: string }[] }>("list", { all: true })).endpoints)).toEqual(["me/", "me/orch", "me/w"])
    expect(await shell.rules()).toMatchObject({ address: "me/w" })
    expect(await code(shell.rulesWiden({ endpoint: "w", out: ["*"] }))).toBe("scope_refused")
    expect(await shell.rulesSet({ in: [] })).toMatchObject({ address: "me/w", rules: { in: [] } })
    expect(await code(shell.request("send", { to: "orch", body: "x" }))).toBe("unauthorized")
    const orchShell = await observer(broker, [201, 200])
    expect(await code(orchShell.rulesWiden({ endpoint: "w", out: ["handle:main"] }))).toBe("scope_refused")
    const bare = await observer(broker)
    expect(addresses((await bare.request<{ endpoints: { address: string }[] }>("list", { all: true })).endpoints)).toEqual(["me/", "me/main", "me/orch"])
    expect(await code(bare.why("w", "main"))).toBe("not_found")
    expect(await bare.why("orch", "main")).toMatchObject({ allowed: true })
    for (const method of ["rules", "rules_set", "grant", "group", "peers"])
      expect(await code(bare.request(method, { action: "ls", in: [] }))).toBe("unauthorized")
  })

  test("a watcher on a scoped view gets only the presence, status and activity of what it may see", async () => {
    const { broker } = await setup()
    const { main, orch } = await fleet(broker)
    const everyone = await human(broker, false)
    const all: Record<string, unknown>[] = []
    everyone.onNotification((method, params) => method === "fleet" && all.push(params as Record<string, unknown>))
    await everyone.request("watch")
    const shell = await observer(broker, [300])
    const scoped: Record<string, unknown>[] = []
    shell.onNotification((method, params) => method === "fleet" && scoped.push(params as Record<string, unknown>))
    const first = await shell.request<{ endpoints: { address: string }[] }>("watch")
    expect(addresses(first.endpoints)).toEqual(["me/", "me/orch", "me/w"])
    await main.client.request("status", { state: "working", note: "main" })
    await main.client.request("event", { kind: "tool", tool: "Bash" })
    await orch.client.request("status", { state: "working", note: "orch" })
    await main.client.request("send", { to: "orch", body: "x" })
    await Bun.sleep(100)
    expect(all.map((e) => [e.type, e.endpoint ?? e.from])).toEqual([
      ["status", "me/main"],
      ["activity", "me/main"],
      ["status", "me/orch"],
      ["message", "me/main"],
    ])
    expect(scoped.map((e) => [e.type, e.endpoint])).toEqual([["status", "me/orch"]])
  })

  test("a human hello without a terminal gets no exemption, a filtered view and no powers; the human at a terminal keeps them", async () => {
    const { broker } = await setup()
    const { main, w } = await fleet(broker)
    await main.client.rulesSet({ in: ["tree:children"] })
    const script = await human(broker, false)
    expect(await code(script.request("send", { to: "main", body: "x" }))).toBe("not_found")
    expect(await code(script.request("send", { to: "orch", body: "x" }))).toBeUndefined()
    expect(addresses((await script.request<{ endpoints: { address: string }[] }>("list", { all: true })).endpoints)).toEqual(["me/", "me/orch"])
    expect(addresses(await script.peers())).toEqual(["me/orch"])
    expect(await code(script.rulesSet({ endpoint: "w", in: [] }))).toBe("scope_refused")
    expect(await code(script.grant({ under: "main" }))).toBe("scope_refused")
    expect(await code(script.rules("main"))).toBe("not_found")
    const boss = await human(broker, true)
    expect(await code(boss.request("send", { to: "main", body: "x" }))).toBeUndefined()
    expect(addresses((await boss.request<{ endpoints: { address: string }[] }>("list", { all: true })).endpoints)).toEqual([
      "me/",
      "me/main",
      "me/orch",
      "me/w",
    ])
    expect((await boss.rulesSet({ endpoint: "w", in: ["tree:parent"] })).caps.map((cap) => cap.by)).toContain("human")
    expect((await boss.grant({ under: "main" })).token).toMatch(/^krt_/)
    expect(await w.client.request<{ messages: unknown[] }>("inbox")).toMatchObject({ messages: [] })
  })

  test("a human hello whose lineage lands on an agent acts as that agent, terminal or not", async () => {
    const { broker } = await setup()
    const { main, orch } = await fleet(broker)
    await main.client.rulesSet({ in: ["tree:children"] })
    const shell = await human(broker, true, [301, 300, 200])
    expect(await shell.request<{ address: string }>("whoami")).toMatchObject({ address: "me/w" })
    expect(await code(shell.request("send", { to: "main", body: "x" }))).toBe("not_found")
    await shell.request("send", { to: "orch", body: "from w's shell" })
    const inbox = await orch.client.request<{ messages: { from: { address: string } }[] }>("inbox")
    expect(inbox.messages.map((m) => m.from.address)).toEqual(["me/w"])
    expect(addresses((await shell.request<{ endpoints: { address: string }[] }>("list", { all: true })).endpoints)).toEqual(["me/", "me/orch", "me/w"])
    expect(await code(shell.rulesWiden({ endpoint: "w", out: ["*"] }))).toBe("scope_refused")
    expect(await shell.rulesSet({ in: [] })).toMatchObject({ address: "me/w", rules: { in: [] } })
    expect(await code(shell.admin({ action: "grant", subject: "orch", tree: "main" }))).toBe("scope_refused")
    const orchShell = await human(broker, false, [201, 200])
    expect(await code(orchShell.rulesWiden({ endpoint: "w", out: ["handle:main"] }))).toBe("scope_refused")
    shell.close()
    orchShell.close()
    await Bun.sleep(50)
    const boss = await human(broker, true)
    const listed = await boss.request<{ endpoints: { address: string; kind: string; presence: string }[] }>("list", { all: true })
    expect(listed.endpoints.filter((e) => e.kind !== "human").map((e) => [e.address, e.presence])).toEqual([
      ["me/main", "online"],
      ["me/orch", "online"],
      ["me/w", "online"],
    ])
  })

  test("a CLI claim of the name its lineage lands on acts as that endpoint instead of claiming a -2", async () => {
    const { broker } = await setup()
    const { orch } = await fleet(broker)
    const cli = await RelayClient.connect(broker.socket)
    cleanups.push(() => cli.close())
    const hello = await cli.hello({ claim: { handle: "w", harness: "cli", lineage: [301, 300, 250, 200, 100].map(key) }, brief: true })
    expect(hello.endpoint).toMatchObject({ address: "me/w" })
    expect(hello.token).toBeUndefined()
    expect(await code(cli.request("send", { to: "main", body: "x" }))).toBe("not_found")
    await cli.request("send", { to: "orch", body: "from w's cli" })
    const inbox = await orch.client.request<{ messages: { from: { address: string } }[] }>("inbox")
    expect(inbox.messages.map((m) => m.from.address)).toEqual(["me/w"])
    expect(await code(cli.rulesWiden({ endpoint: "w", out: ["*"] }))).toBe("scope_refused")
    const other = await RelayClient.connect(broker.socket)
    cleanups.push(() => other.close())
    expect((await other.hello({ claim: { handle: "kid", harness: "cli", lineage: [302, 300, 250, 200, 100].map(key) }, brief: true })).endpoint).toMatchObject({
      address: "me/kid",
    })
    cli.close()
    await Bun.sleep(50)
    const listed = await (await human(broker, true)).request<{ endpoints: { address: string; presence: string }[] }>("list", { all: true })
    expect(listed.endpoints.find((e) => e.address === "me/w")).toMatchObject({ presence: "online" })
    expect(listed.endpoints.some((e) => e.address === "me/w-2")).toBe(false)
  })

  test("the scope methods map to the core as the connection's actor", async () => {
    const { broker } = await setup()
    const { main, orch, w } = await fleet(broker)
    const narrowed = await orch.client.rulesSet({ endpoint: "w", out: ["tree:parent"] })
    const cap = narrowed.caps.find((c) => c.by === "me/orch")!
    expect(cap).toMatchObject({ dir: "out" })
    expect(await main.client.rulesWiden({ endpoint: "w", out: ["handle:main"] })).toEqual({ added: ["handle:main"], clipped: [] })
    expect(await code(w.client.rulesWiden({ endpoint: "w", out: ["*"] }))).toBe("scope_refused")
    expect((await orch.client.rulesLift({ endpoint: "w", cap: cap.id })).caps.some((c) => c.id === cap.id)).toBe(false)
    expect((await w.client.why("w", "orch")).allowed).toBe(true)
    expect(await code(w.client.why("main", "orch"))).toBe("not_found")
    expect((await w.client.peers()).map((p) => p.address).sort()).toEqual(["me/", "me/orch"])
    const { token, env } = await orch.client.grant({ name: "late", scope: "parent" })
    expect(token).toMatch(/^krt_[0-9a-f]{64}$/)
    expect(env).toEqual({ SCP_GRANT: token, SCP_NAME: "late" })
    const late = await RelayClient.connect(broker.socket)
    cleanups.push(() => late.close())
    await late.hello({ claim: { handle: "late", harness: "codex", grant: token } })
    expect(await orch.client.rules("late")).toMatchObject({ parent: "me/orch", depth: 2 })
    await orch.client.group({ action: "create", name: "team", rules: ["group:self", "tree:parent"] })
    await orch.client.group({ action: "add", name: "team", endpoint: "w" })
    expect(await w.client.rules()).toMatchObject({ groups: ["team"] })
    expect(await code(w.client.group({ action: "remove", name: "team", endpoint: "w" }))).toBe("scope_refused")
    expect(await code(main.client.admin({ action: "grant", subject: "orch", tree: "main" }))).toBe("scope_refused")
    expect(await code((await human(broker, false)).admin({ action: "grant", subject: "orch", tree: "main" }))).toBe("scope_refused")
    const boss = await human(broker, true)
    await boss.admin({ action: "grant", subject: "orch", tree: "main" })
    const rows = await boss.request<{ rows: { event: string; detail: unknown }[] }>("log", { scope: true, limit: 1000 })
    expect(rows.rows.map((r) => r.event)).toContain("scope_admin")
    expect(JSON.stringify(rows)).not.toContain(token)
  })
})

describe("broker, self bind and titles", () => {
  const key = (pid: number) => `pid:${pid}:Thu-Oct-16-09:00:00-2026`

  async function connect(broker: Broker) {
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    return client
  }

  /** main (pid 100), orch (pid 200) under it, w (pid 300) under orch accepting and reaching only its parent */
  async function fleet(broker: Broker) {
    const placed = async (handle: string, pid: number, lineage: number[] = []) => {
      const client = await connect(broker)
      await client.hello({ claim: { handle, harness: "codex", process: key(pid), lineage: [pid, ...lineage].map(key) } })
      return client
    }
    const main = await placed("main", 100)
    const orch = await placed("orch", 200, [100])
    const w = await placed("w", 300, [200, 100])
    await w.rulesSet({ scope: "parent" })
    return { main, orch, w }
  }

  const addresses = (endpoints: { address: string }[]) => endpoints.map((e) => e.address).sort()

  test("a self hello binds to the endpoint its self keys land on and acts with lineage auth, never counted as connected", async () => {
    const { broker } = await setup()
    const { orch, w } = await fleet(broker)
    const shell = await connect(broker)
    const hello = await shell.hello({ observe: true, self: [301, 300].map(key), lineage: [301, 300, 200, 100].map(key), brief: true })
    expect(hello.endpoint).toMatchObject({ address: "me/w" })
    await orch.request("send", { to: "w", body: "for w" })
    expect(await shell.request<{ unread: Record<string, number> }>("snapshot")).toMatchObject({ unread: { "me/w": 1 } })
    const inbox = await shell.request<{ messages: { seq: number; body: { text: string } }[] }>("inbox")
    expect(inbox.messages.map((m) => m.body.text)).toEqual(["for w"])
    expect(await shell.request<{ acked: number }>("ack", { seqs: [inbox.messages[0]!.seq] })).toEqual({ acked: 1 })
    await shell.request("send", { to: "orch", body: "from w's shell" })
    expect((await orch.request<{ messages: { from: { address: string } }[] }>("inbox")).messages.map((m) => m.from.address)).toEqual(["me/w"])
    expect(await code(shell.request("send", { to: "main", body: "x" }))).toBe("not_found")
    expect(await code(shell.rulesWiden({ endpoint: "w", out: ["*"] }))).toBe("scope_refused")
    expect(await shell.rulesSet({ in: [] })).toMatchObject({ address: "me/w", rules: { in: [] } })
    w.close()
    await Bun.sleep(50)
    expect(await shell.request("whoami")).toMatchObject({ address: "me/w", presence: "offline" })
  })

  test("a self hello on the harness's own endpoint widens and lifts within its subtree like its session; a plain lineage observer only narrows", async () => {
    const { broker } = await setup()
    const { orch } = await fleet(broker)
    const cap = (await orch.rulesSet({ endpoint: "w", out: ["tree:parent"] })).caps.find((c) => c.dir === "out")!.id
    const stray = await connect(broker)
    await stray.hello({ observe: true, self: [key(999)], lineage: [999, 200, 100].map(key), brief: true })
    expect(await code(stray.rulesWiden({ endpoint: "w", out: ["tree:root"] }))).toBe("scope_refused")
    const shell = await connect(broker)
    expect((await shell.hello({ observe: true, self: [201, 200].map(key), lineage: [201, 200, 100].map(key), brief: true })).endpoint).toMatchObject({
      address: "me/orch",
    })
    expect(await shell.rulesWiden({ endpoint: "w", out: ["tree:root"] })).toMatchObject({ added: ["tree:root"] })
    expect(
      broker.core
        .log({ scope: true })
        .filter((row) => row.event === "scope_widen")
        .map((row) => row.detail.auth),
    ).toEqual(["self"])
    expect((await shell.rulesLift({ endpoint: "w", cap })).caps.map((c) => c.id)).not.toContain(cap)
  })

  test("a self walk past a helper binds to the nearest key an endpoint holds, never one above it", async () => {
    const { broker } = await setup()
    await fleet(broker)
    const bound = async (self: number[]) =>
      (await (await connect(broker)).hello({ observe: true, self: self.map(key), lineage: [...self, 100].map(key), brief: true })).endpoint
    expect(await bound([302, 301, 300, 200])).toMatchObject({ address: "me/w" })
    expect(await bound([202, 201, 200])).toMatchObject({ address: "me/orch" })
  })

  test("a self that lands nowhere observes by the full lineage, with no endpoint", async () => {
    const { broker } = await setup()
    await fleet(broker)
    const stray = await connect(broker)
    const hello = await stray.hello({ observe: true, self: [key(999)], lineage: [999, 200, 100].map(key), brief: true })
    expect(hello.endpoint).toBeNull()
    expect(addresses((await stray.request<{ endpoints: { address: string }[] }>("list", { all: true })).endpoints)).toEqual([
      "me/",
      "me/main",
      "me/orch",
      "me/w",
    ])
    expect(await stray.rules()).toMatchObject({ address: "me/orch" })
    expect(await code(stray.request("send", { to: "main", body: "x" }))).toBe("unauthorized")
    expect(await code(stray.request("title", { text: "x" }))).toBe("unauthorized")
  })

  test("a hello with a spawn-env grant binds only to the endpoint that spent it or one below it", async () => {
    const { broker } = await setup()
    const { orch } = await fleet(broker)
    const { token } = await orch.grant({ scope: "parent" })
    const named = (await orch.grant({ name: "orch" })).token
    const grantHello = async (self: number[], grant: string) =>
      code(connect(broker).then((c) => c.hello({ observe: true, self: self.map(key), lineage: [...self, 100].map(key), grant, brief: true })))
    expect(await grantHello([201, 200], token)).toBe("unauthorized")
    await expect(connect(broker).then((c) => c.hello({ observe: true, self: [201, 200].map(key), grant: token, brief: true }))).rejects.toThrow(
      "a spawn-env grant binds only a new harness process: run the harness with it, or name the child (swarm spawn-env --name / --as)",
    )
    expect(await grantHello([999], token)).toBe("unauthorized")
    expect(await grantHello([201, 200], "krt_x")).toBe("invalid_params")
    expect(
      await code(
        connect(broker).then((c) =>
          c.hello({ claim: { handle: "orch", harness: "cli", exact: true, lineage: [201, 200, 100].map(key), grant: named }, brief: true }),
        ),
      ),
    ).toBe("unauthorized")
    const kid = await connect(broker)
    await kid.hello({ claim: { handle: "kid", harness: "claude-code", process: key(400), lineage: [400, 200, 100].map(key), grant: token } })
    const grandkid = await connect(broker)
    await grandkid.hello({ claim: { handle: "gk", harness: "codex", process: key(500), lineage: [500, 400, 200, 100].map(key), grant: token } })
    for (const [pid, address] of [
      [400, "me/kid"],
      [500, "me/gk"],
    ] as const) {
      const shell = await connect(broker)
      expect(
        await shell.hello({ observe: true, self: [pid + 1, pid].map(key), lineage: [pid + 1, pid, 200, 100].map(key), grant: token, brief: true }),
      ).toMatchObject({
        endpoint: { address },
        grant_bound: true,
      })
    }
    const kidShell = await connect(broker)
    await kidShell.hello({ observe: true, self: [401, 400].map(key), lineage: [401, 400, 200, 100].map(key), grant: token, brief: true })
    expect(await kidShell.rulesWiden({ endpoint: "gk", out: ["ep:kid"] })).toMatchObject({ added: ["ep:kid"] })
    expect(
      broker.core
        .log({ scope: true })
        .filter((row) => row.event === "scope_widen")
        .map((row) => row.detail.auth),
    ).toEqual(["self"])
    const asKid = await connect(broker)
    expect(
      (await asKid.hello({ claim: { handle: "kid", harness: "cli", exact: true, lineage: [401, 400, 200, 100].map(key), grant: token }, brief: true }))
        .endpoint,
    ).toMatchObject({ address: "me/kid" })
    expect(await grantHello([201, 200], token)).toBe("unauthorized")
    expect(
      broker.core
        .list({ all: true })
        .map((e) => e.address)
        .sort(),
    ).toEqual(["me/", "me/gk", "me/kid", "me/main", "me/orch", "me/w"])
  })

  test("a named claim from its endpoint's own harness shell acts with self auth; from a child harness or the spawner's shell it does not", async () => {
    const { broker } = await setup()
    const { main } = await fleet(broker)
    const spawned = async (handle: string, pid: number, lineage: number[], token: string) => {
      const client = await connect(broker)
      await client.hello({ claim: { handle, harness: "claude-code", process: key(pid), lineage: [pid, ...lineage].map(key), grant: token } })
      return client
    }
    const leadToken = (await main.grant({ name: "lead", scope: "tree" })).token
    const lead = await spawned("lead", 400, [100], leadToken)
    const kidToken = (await lead.grant({ name: "kid", scope: "parent" })).token
    const kid = await spawned("kid", 500, [401, 400, 100], kidToken)
    const wc = await spawned("wc", 450, [401, 400, 100], (await lead.grant({ name: "wc", scope: "parent" })).token)
    const lb = await spawned("lb", 600, [100], (await main.grant({ name: "lb", scope: "tree" })).token)
    await spawned("wb", 700, [601, 600, 100], (await lb.grant({ name: "wb", scope: "parent" })).token)
    const named = async (handle: string, self: number[], lineage: number[], grant?: string) => {
      const shell = await connect(broker)
      const hello = await shell.hello({
        claim: { handle, harness: "cli", exact: true, lineage: lineage.map(key), ...(grant ? { grant } : {}) },
        self: self.map(key),
        brief: true,
      })
      return { shell, hello }
    }
    const auths = () =>
      broker.core
        .log({ scope: true })
        .filter((row) => row.event === "scope_widen")
        .map((row) => row.detail.auth)
    expect(await code(kid.request("send", { to: "wc", body: "x" }))).toBe("not_found")
    const own = await named("lead", [401, 400], [401, 400, 100], leadToken)
    expect(own.hello.endpoint).toMatchObject({ address: "me/lead" })
    expect(await own.shell.rulesWiden({ endpoint: "kid", out: ["ep:wc"] })).toMatchObject({
      added: ["ep:wc"],
      mirrored: [{ endpoint: "me/wc", dir: "in", added: ["ep:kid"] }],
    })
    expect(auths()).toEqual(["self", "self"])
    await kid.request("send", { to: "wc", body: "widened by lead" })
    expect((await wc.request<{ messages: { from: { address: string } }[] }>("inbox")).messages.map((m) => m.from.address)).toEqual(["me/kid"])
    expect(await code(own.shell.rulesWiden({ endpoint: "wb", out: ["ep:kid"] }))).toBe("not_found")
    expect(await code(own.shell.rulesWiden({ endpoint: "lb", out: ["ep:kid"] }))).toBe("not_found")
    const plain = await named("lead", [401, 400], [401, 400, 100])
    expect(await plain.shell.rulesWiden({ endpoint: "kid", out: ["ep:lead"] })).toMatchObject({ added: ["ep:lead"] })
    const unclaimed = await named("lead", [801, 800], [801, 800, 401, 400, 100], leadToken)
    expect(unclaimed.hello.endpoint).toMatchObject({ address: "me/lead" })
    expect(await code(unclaimed.shell.rulesWiden({ endpoint: "kid", out: ["tree:root"] }))).toBe("scope_refused")
    expect(await code(named("lead", [501, 500], [501, 500, 401, 400, 100], leadToken))).toBe("unauthorized")
    expect(await code(named("lead", [401, 400], [401, 400, 100], kidToken))).toBe("unauthorized")
    expect(
      await code(
        connect(broker).then((c) => c.hello({ observe: true, self: [401, 400].map(key), lineage: [401, 400, 100].map(key), grant: kidToken, brief: true })),
      ),
    ).toBe("unauthorized")
    expect(auths()).toEqual(["self", "self", "self"])
    expect(
      broker.core
        .list({ all: true })
        .map((e) => e.address)
        .sort(),
    ).toEqual(["me/", "me/kid", "me/lb", "me/lead", "me/main", "me/orch", "me/w", "me/wb", "me/wc"])
  })

  test("an exact claim the core refuses is an error and claims nothing; from the session's own shell it binds to the session", async () => {
    const { broker } = await setup()
    const hook = await connect(broker)
    await hook.hello({
      transient: true,
      claim: { handle: "bo", harness: "claude-code", session: key(process.pid), process: key(process.pid), lineage: [key(process.pid)] },
    })
    const elsewhere = await connect(broker)
    const refused = elsewhere.hello({ claim: { handle: "bo", harness: "cli", lineage: [key(900)], exact: true }, brief: true })
    await expect(refused).rejects.toThrow(/live claude-code session/)
    expect(await code(elsewhere.hello({ claim: { handle: "bo", harness: "cli", lineage: [key(900)], exact: true }, brief: true }))).toBe("unauthorized")
    const own = await connect(broker)
    expect(
      (await own.hello({ claim: { handle: "bo", harness: "cli", lineage: [key(601), key(600), key(process.pid)], exact: true }, brief: true })).endpoint,
    ).toMatchObject({
      address: "me/bo",
    })
    expect(broker.core.list({ all: true }).map((e) => e.address)).toEqual(["me/", "me/bo"])
  })

  test("a session or lineage-bound connection sets its title, which list shows; a hook connection may not", async () => {
    const { broker } = await setup()
    const { orch, w } = await fleet(broker)
    expect(await w.request("title", { text: "docx viewer" })).toMatchObject({ address: "me/w", title: "docx viewer" })
    const listed = await orch.request<{ endpoints: { address: string; title: string | null }[] }>("list")
    expect(listed.endpoints.find((e) => e.address === "me/w")!.title).toBe("docx viewer")
    const shell = await connect(broker)
    await shell.hello({ observe: true, self: [301, 300].map(key), lineage: [301, 300, 200, 100].map(key), brief: true })
    expect(await shell.request("title", { text: "" })).toMatchObject({ address: "me/w", title: null })
    const hook = await connect(broker)
    await hook.hello({ transient: true, claim: { handle: "hooked", harness: "claude-code", session: key(700), process: key(700) } })
    expect(await code(hook.request("title", { text: "x" }))).toBe("unauthorized")
    expect(broker.core.list({ all: true }).find((e) => e.address === "me/hooked")!.title).toBeNull()
  })

  test("a prompt reminds the agent to refresh its note every n prompts, counted from its last note or reminder", async () => {
    const { broker } = await setup()
    const h = await connect(broker)
    await h.hello({ transient: true, claim: { handle: "tl", harness: "claude-code", session: key(820), process: key(820) } })
    const due = async () => ((await h.request<{ tldr?: boolean }>("prompted", { tldr_every: 3 })).tldr ?? false) as boolean
    expect([await due(), await due(), await due(), await due()]).toEqual([false, false, true, false])
    const shell = await connect(broker)
    await shell.hello({ observe: true, self: [821, 820].map(key), lineage: [821, 820].map(key), brief: true })
    await due()
    await shell.request("status", { note: "fixing the parser" })
    expect([await due(), await due(), await due()]).toEqual([false, false, true])
    expect((await h.request<{ tldr?: boolean }>("prompted", { tldr_every: 0 })).tldr).toBeUndefined()
  })

  test("a hook infers a title from the first prompt, then the session's summary at most every few prompts; an explicit title always wins", async () => {
    const { broker } = await setup()
    const hook = async () => {
      const client = await connect(broker)
      await client.hello({ transient: true, claim: { handle: "inf", harness: "claude-code", session: key(800), process: key(800) } })
      return client
    }
    const title = () => broker.core.list({ all: true }).find((e) => e.address === "me/inf")!.title
    const h = await hook()
    expect(await h.request("title_infer", { from: "prompt", text: "fix the  parser\n tests" })).toEqual({ changed: true })
    expect(title()).toBe("fix the parser tests")
    expect(await h.request("title_infer", { from: "prompt", text: "a later prompt" })).toEqual({ changed: false })
    expect(await h.request("title_infer", { from: "summary", text: "Parser test fixes" })).toEqual({ changed: true })
    expect(await h.request("title_infer", { from: "summary", text: "Something newer" })).toEqual({ changed: false })
    for (let i = 0; i < LIMITS.titleRefreshTurns; i++) await h.request("prompted", {})
    expect(await h.request("title_infer", { from: "summary", text: `use sk-ant-${"a".repeat(40)} ${"x".repeat(70)}` })).toEqual({ changed: true })
    expect(title()).toHaveLength(64)
    expect(title()).not.toContain("aaaa")
    await h.request("event", { kind: "session_start", summary: "compact" })
    expect(title()).toStartWith("use [redacted")
    await h.request("event", { kind: "session_start", summary: "startup" })
    expect(title()).toBeNull()

    const shell = await connect(broker)
    await shell.hello({ observe: true, self: [801, 800].map(key), lineage: [801, 800].map(key), brief: true })
    await shell.request("title", { text: "chosen" })
    expect(await h.request("title_infer", { from: "summary", text: "Parser test fixes" })).toEqual({ changed: false })
    expect(await h.request("title_infer", { from: "prompt", text: "anything" })).toEqual({ changed: false })
    expect(title()).toBe("chosen")
  })
})

describe("broker, spawn bindings and ended asks", () => {
  const key = (pid: number) => `pid:${pid}:Thu-Oct-16-09:00:00-2026`

  async function connect(broker: Broker) {
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    return client
  }

  test("a claim from the bound spawner's tree takes the grant's name; spawn_exit marks it done and offline for the issuer only", async () => {
    const { broker } = await setup()
    const orch = await connect(broker)
    await orch.hello({ claim: { handle: "orch", harness: "codex", process: key(200), lineage: [key(200)] } })
    const other = await connect(broker)
    await other.hello({ claim: { handle: "other", harness: "codex", process: key(900), lineage: [key(900)] } })
    const watcher = await connect(broker)
    await watcher.hello({ observe: true })
    const events: Record<string, unknown>[] = []
    watcher.onNotification((method, params) => method === "fleet" && events.push(params as Record<string, unknown>))
    await watcher.request("watch")
    const { token } = await orch.grant({ name: "wm", bind_process: key(250) })
    expect(await code(orch.grant({ bind_process: "pid:250" }))).toBe("invalid_params")
    const shim = await connect(broker)
    const hello = await shim.hello({ claim: { handle: "muse-work", harness: "muse", process: key(260), lineage: [260, 250, 200].map(key) } })
    expect([hello.endpoint!.address, hello.endpoint!.parent]).toEqual(["me/wm", "me/orch"])
    await shim.request("status", { state: "blocked", note: "on it" })
    shim.close()
    await Bun.sleep(50)
    expect(await code(other.request("spawn_exit", { grant: token, code: 3 }))).toBe("unauthorized")
    const waiting = orch.request<{ messages: { id: string; from: { address: string }; body: { text: string } }[] }>("inbox", { wait_s: 5 })
    const exited = await orch.request<{ handback: string }>("spawn_exit", { grant: token, code: 3, output: "\u001b[32mshipped\u001b[0m" })
    expect(exited).toMatchObject({ joined: true, name: "wm", endpoint: { presence: "offline", status: { state: "done", note: "exited 3; on it" } } })
    expect((await waiting).messages.map((m) => [m.id, m.from.address, m.body.text])).toEqual([
      [exited.handback, "me/wm", "worker me/wm finished (exit 3)\n\nshipped"],
    ])
    await Bun.sleep(50)
    expect(events).toContainEqual(expect.objectContaining({ type: "status", endpoint: "me/wm", status: { state: "done", note: "exited 3; on it" } }))
    expect(events).toContainEqual(expect.objectContaining({ type: "message", id: exited.handback, from: "me/wm", to: ["me/orch"] }))
    const never = await orch.grant({ name: "nj", bind_process: key(270) })
    expect(await orch.spawnExit({ grant: never.token, code: 0 })).toEqual({
      joined: false,
      name: "nj",
      endpoint: null,
      handback: expect.stringMatching(/^msg_/),
    })
    const late = await connect(broker)
    expect(
      (await late.hello({ claim: { handle: "muse-work", harness: "muse", process: key(280), lineage: [280, 270, 200].map(key) } })).endpoint!.address,
    ).toBe("me/muse-work")
  })

  test("ask stops waiting once every recipient present at the send ended without replying; one offline at the send keeps it waiting", async () => {
    const { broker } = await setup()
    const a = await agent(broker, "a")
    const b = await agent(broker, "b", "codex")
    await b.client.request("status", { state: "blocked", note: "stuck" })
    const started = Date.now()
    const asking = a.client.request<{ id: string; pending?: boolean; ended?: unknown }>("ask", { to: "b", body: "still there?", wait_s: 20 })
    await Bun.sleep(200)
    b.client.close()
    const result = await asking
    expect(Date.now() - started).toBeGreaterThanOrEqual(9000)
    expect(Date.now() - started).toBeLessThan(15000)
    expect(result).toMatchObject({ pending: true, ended: [{ address: "me/b", state: "blocked" }] })
    expect(await a.client.request("ask_wait", { id: result.id, wait_s: 20 })).toMatchObject({ pending: true, ended: [{ address: "me/b", state: "blocked" }] })
    const offline = await a.client.request<{ pending?: boolean; ended?: unknown }>("ask", { to: "b", body: "later?", wait_s: 1.5 })
    expect(offline.pending).toBe(true)
    expect(offline.ended).toBeUndefined()
  }, 30_000)
})
