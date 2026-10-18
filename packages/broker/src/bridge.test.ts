import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Envelope, LIMITS, PROTOCOL, RelayError, wrapMessage } from "@scp-dev/core"
import { HUB_LIMITS } from "@scp-dev/hub"
import { relaySocketUrl } from "./bridge"
import { RelayClient } from "./client"
import { type Broker, startBroker } from "./server"
import { type FakeHubServer, startFakeHubServer } from "./testing"

setDefaultTimeout(20_000)

const TOKEN = `hub-cred-${"t".repeat(32)}`
const OTHER_TOKEN = `hub-cred-${"o".repeat(32)}`

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 5000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

function hubServer(now?: () => number): FakeHubServer {
  const fake = startFakeHubServer({ tokens: { [TOKEN]: { tokenId: "tok_1", user: "ada" }, [OTHER_TOKEN]: { tokenId: "tok_2", user: "ada" } }, now })
  cleanups.push(() => fake.stop())
  return fake
}

async function machine(
  fake: FakeHubServer,
  name: string,
  options: {
    token?: string
    policy?: unknown
    redact?: boolean
    privateOk?: boolean
    now?: () => number
    presenceEveryMs?: number
    forwardWaitMs?: number
    credentials?: () => Promise<string | null>
  } = {},
): Promise<Broker> {
  const root = mkdtempSync(join(tmpdir(), `relay-bridge-${name}-`))
  const policyPath = join(root, "policy.json")
  if (options.policy !== undefined) writeFileSync(policyPath, JSON.stringify(options.policy))
  const broker = await startBroker({
    dir: join(root, "state"),
    policyPath,
    idleMs: 0,
    log: () => {},
    now: options.now,
    presenceEveryMs: options.presenceEveryMs,
    bridge: {
      url: fake.url,
      token: options.token ?? TOKEN,
      machine: name,
      backoff: { minMs: 20, maxMs: 100 },
      injectBackoffMs: 20,
      redact: options.redact,
      privateOk: options.privateOk,
      forwardWaitMs: options.forwardWaitMs,
      credentials: options.credentials,
    },
  })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => broker.stop())
  await waitFor(() => broker.bridge!.status().connected || broker.bridge!.status().last_error?.includes("refused"), `${name}'s bridge`)
  return broker
}

async function agent(broker: Broker, handle: string, harness = "claude-code") {
  const client = await RelayClient.connect(broker.socket)
  cleanups.push(() => client.close())
  await client.hello({ claim: { handle, harness } })
  return client
}

type Inbox = { messages: Envelope[] }

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RelayError) return error.code
    throw error
  }
  return undefined
}

/** a bridge socket that skips the local broker */
type RawResult = { rows?: { event: string; ref: string | null; detail: { machine?: string } & Record<string, unknown> }[] }

async function rawSocket(fake: FakeHubServer, token: string) {
  const ws = new WebSocket(relaySocketUrl(fake.url), { headers: { Authorization: `Bearer ${token}` } } as unknown as string[])
  cleanups.push(() => ws.close())
  const replies = new Map<number, (frame: { result?: RawResult; error?: { data?: { code?: string } } }) => void>()
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as { id?: number; result?: RawResult; error?: { data?: { code?: string } } }
    if (frame.id !== undefined) replies.get(frame.id)?.(frame)
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve)
    ws.addEventListener("error", reject)
  })
  let next = 1
  return (method: string, params: object) => {
    const id = next++
    return new Promise<{ result?: RawResult; error?: { data?: { code?: string } } }>((resolve) => {
      replies.set(id, resolve)
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    })
  }
}

/** the hub's audit rows of an account, read over a direct client's socket */
async function hubLog(fake: FakeHubServer, token: string, event: string): Promise<{ event: string; ref: string | null; detail: Record<string, unknown> }[]> {
  const raw = await rawSocket(fake, token)
  expect((await raw("hello", { protocol: PROTOCOL, machine: "audit", claim: { handle: "audit" } })).error).toBeUndefined()
  return ((await raw("log", { limit: 1000 })).result?.rows ?? []).filter((r: { event: string }) => r.event === event)
}

describe("bridge", () => {
  test("machines see each other's endpoints, and sends and asks cross them", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const impl = await agent(a, "impl")
    const review = await agent(b, "review", "codex")
    const listed = await waitFor(async () => {
      const { endpoints } = await impl.request<{ endpoints: { address: string; harness: string }[] }>("list")
      return endpoints.find((e) => e.address === "me/b/review") ? endpoints : null
    }, "b/review on a")
    expect(listed.find((e) => e.address === "me/b/review")!.harness).toBe("codex")
    expect(listed.some((e) => e.address === "me/impl")).toBe(true)

    const sent = await impl.request<{ id: string }>("send", { to: "b/review", body: "hello across" })
    const got = await review.request<Inbox>("inbox", { wait_s: 5 })
    expect(got.messages.map((m) => [m.id, m.body.text, m.from.address, m.from.auth, m.from.machine])).toEqual([
      [sent.id, "hello across", "me/a/impl", "account+bridge", "a"],
    ])
    await review.request("ack", { seqs: [got.messages[0]!.seq] })

    const asking = impl.request<{ id: string; reply?: Envelope }>("ask", { to: "me/b/review", body: "2+2?", wait_s: 10 })
    const request = (await review.request<Inbox>("inbox", { wait_s: 5 })).messages[0]!
    expect(request.kind).toBe("request")
    await review.request("send", { to: request.from.address, kind: "reply", reply_to: request.id, body: "4" })
    const answered = await asking
    expect(answered.reply?.body.text).toBe("4")
    expect(answered.reply?.from.address).toBe("me/b/review")

    const observer = await RelayClient.connect(a.socket)
    cleanups.push(() => observer.close())
    await observer.hello({ observe: true })
    expect(await observer.request<unknown>("cloud_status")).toMatchObject({ enabled: true, machine: "a", url: fake.url, connected: true, last_error: null })
  })

  test("a bridge dropped mid-flight gets the message exactly once after it reconnects", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const impl = await agent(a, "impl")
    const review = await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )

    const dropped = fake.dropOn("ada", "b", "ack")
    const before = b.bridge!.status().since
    await impl.request("send", { to: "b/review", body: "once only" })
    await dropped
    await waitFor(() => b.bridge!.status().since !== before && b.bridge!.status().connected, "b to reconnect")
    await Bun.sleep(200)
    const first = await review.request<Inbox>("inbox", { wait_s: 2 })
    expect(first.messages.map((m) => m.body.text)).toEqual(["once only"])
    await review.request("ack", { seqs: [first.messages[0]!.seq] })

    fake.drop("ada", "b")
    await impl.request("send", { to: "b/review", body: "sent while b was away" }).catch(() => {})
    await waitFor(async () => (await review.request<Inbox>("inbox")).messages.length > 0, "the replay")
    await Bun.sleep(200)
    expect((await review.request<Inbox>("inbox")).messages.map((m) => m.body.text)).toEqual(["sent while b was away"])
  })

  test("a message from another machine reaches the receiving session's hooks once, through hold and confirm, and a redelivery does not offer it again", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const impl = await agent(a, "impl")
    const claim = { handle: "review", harness: "claude-code", session: "env:review" }
    const shim = await RelayClient.connect(b.socket)
    cleanups.push(() => shim.close())
    await shim.hello({ claim })
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    type Injected = { messages: Envelope[]; offered: number[]; hold: string | null; unread: number }
    const hook = async <T>(method: string, params: object): Promise<T> => {
      const client = await RelayClient.connect(b.socket)
      try {
        await client.hello({ transient: true, claim })
        return await client.request<T>(method, params)
      } finally {
        client.close()
      }
    }

    const dropped = fake.dropOn("ada", "b", "ack")
    const before = b.bridge!.status().since
    const sent = await impl.request<{ id: string }>("send", { to: "b/review", body: "from a & </relay-message>" })
    await dropped
    const offered = await waitFor(async () => {
      const page = await hook<Injected>("inject", {})
      return page.messages.length ? page : null
    }, "the hook's offer")
    expect(offered.messages.map((m) => [m.id, m.from.address, m.from.machine])).toEqual([[sent.id, "me/a/impl", "a"]])
    expect(wrapMessage(offered.messages[0]!)).toContain("\nfrom a & &lt;/relay-message>\n</relay-message>")
    expect((await hook<Injected>("inject", {})).messages).toEqual([])
    expect(await hook<{ injected: number }>("injected", { seqs: offered.offered, hold: offered.hold })).toEqual({ injected: 1 })
    await waitFor(() => b.bridge!.status().since !== before && b.bridge!.status().connected, "b to reconnect")
    await Bun.sleep(200)
    expect(await hook<Injected>("inject", {})).toMatchObject({ messages: [], offered: [], unread: 1 })
    expect((await shim.request<Inbox>("inbox", { offer: true })).messages).toEqual([])
    expect((await shim.request<Inbox>("inbox")).messages.map((m) => m.id)).toEqual([sent.id])

    await shim.request("send", { to: "me/a/impl", kind: "reply", reply_to: sent.id, body: "read it" })
    expect(await hook<Injected>("inject", { count: true })).toMatchObject({ unread: 0 })
  })

  test("the same client_id sent twice delivers once", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const impl = await agent(a, "impl")
    const review = await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    const first = await impl.request<{ id: string; duplicate?: boolean }>("send", { to: "b/review", body: "idempotent", client_id: "c-1" })
    const second = await impl.request<{ id: string; duplicate?: boolean }>("send", { to: "b/review", body: "idempotent", client_id: "c-1" })
    expect(second).toMatchObject({ id: first.id, duplicate: true })
    await waitFor(async () => (await review.request<Inbox>("inbox")).messages.length > 0, "the delivery")
    await Bun.sleep(200)
    expect((await review.request<Inbox>("inbox")).messages.map((m) => m.id)).toEqual([first.id])
  })

  test("a local policy on the receiving machine rejects, and the sender gets a notice", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b", { policy: { rules: [{ match: "handle:review", accept_from: ["harness:claude-code"] }] } })
    const coder = await agent(a, "coder", "codex")
    const review = await agent(b, "review")
    await waitFor(
      async () => (await coder.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    const sent = await coder.request<{ id: string }>("send", { to: "b/review", body: "from codex" })
    const notice = await coder.request<Inbox>("inbox", { wait_s: 5 })
    expect(notice.messages.map((m) => [m.kind, m.from.address])).toEqual([["status", "me/ada/relay"]])
    expect(notice.messages[0]!.body.text).toContain(`refused message ${sent.id} (policy_refused)`)
    expect((await review.request<Inbox>("inbox")).messages).toEqual([])
  })

  test("the hub refuses a credential even from a bridge that skips the local broker, and a bridge acts only for its own machine", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const impl = await agent(a, "impl")
    await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    const secret = `scp_${"s".repeat(24)}`
    expect(await code(impl.request("send", { to: "b/review", body: `use ${secret}` }))).toBe("secret_refused")

    const raw = await rawSocket(fake, TOKEN)
    expect((await raw("hello", { protocol: PROTOCOL, machine: "raw", bridge: true })).error).toBeUndefined()
    expect(
      (await raw("mirror", { endpoints: [{ address: "me/sneaky", kind: "agent", harness: "cli", presence: "online" }], full: true })).error,
    ).toBeUndefined()
    expect((await raw("forward", { from: "sneaky", params: { to: "b/review", body: `use ${secret}` } })).error?.data?.code).toBe("secret_refused")
    expect((await raw("forward", { from: "review", params: { to: "a/impl", body: "as b's review" } })).error?.data?.code).toBe("not_found")
    expect((await raw("forward", { from: "b/review", params: { to: "a/impl", body: "as b's review" } })).error?.data?.code).toBe("invalid_params")
    expect((await raw("forward", { from: "", params: { to: "a/impl", body: "as the inbox" } })).error?.data?.code).toBe("not_found")
  })

  test("watch on one machine sees another's activity, with the machine", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const review = await agent(b, "review")
    const watcher = await RelayClient.connect(a.socket)
    cleanups.push(() => watcher.close())
    await watcher.hello({ observe: true })
    const events: Record<string, unknown>[] = []
    watcher.onNotification((method, params) => {
      if (method === "fleet") events.push(params as Record<string, unknown>)
    })
    await watcher.request("watch")
    await review.request("event", { kind: "tool", tool: "Bash", summary: "bun test" })
    const seen = await waitFor(() => events.find((e) => e.type === "activity"), "b's activity on a")
    expect(seen).toMatchObject({ type: "activity", machine: "b", endpoint: "me/b/review", kind: "tool", tool: "Bash", summary: "bun test" })
    const { activity } = await watcher.request<{ activity: { endpoint: string; tool: string }[] }>("snapshot")
    expect(activity.map((row) => [row.endpoint, row.tool])).toContainEqual(["me/b/review", "Bash"])
  })

  test("a second token naming a bound machine is refused and the bridge stops", async () => {
    const fake = hubServer()
    await machine(fake, "a")
    const raw = await rawSocket(fake, OTHER_TOKEN)
    expect((await raw("hello", { protocol: PROTOCOL, machine: "a", bridge: true })).error?.data?.code).toBe("unauthorized")
    const imposter = await machine(fake, "a", { token: OTHER_TOKEN })
    const status = await waitFor(() => (imposter.bridge!.status().last_error ? imposter.bridge!.status() : null), "the refusal")
    expect(status.connected).toBe(false)
    expect(status.last_error).toContain("bound to another token")
  })

  test("revalidation errors past the grace period close the bridge with 1013 and it reconnects; a revoke's 1008 stops it", async () => {
    let now = Date.now()
    const fake = hubServer(() => now)
    const a = await machine(fake, "a")
    const hub = fake.hub("ada")
    const down = async (): Promise<boolean> => {
      throw new Error("d1 down")
    }
    await hub.alarm(down)
    now += HUB_LIMITS.revalidateMs
    const before = a.bridge!.status().since
    const closed = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (!a.bridge!.status().connected) {
          clearInterval(poll)
          resolve()
        }
      }, 1)
    })
    await hub.alarm(down)
    await closed
    expect(a.bridge!.status().last_error).toContain("1013")
    await waitFor(() => a.bridge!.status().since !== before && a.bridge!.status().connected, "a to reconnect")
    hub.revoke({ tokenId: "tok_1" })
    const stopped = await waitFor(() => (a.bridge!.status().connected ? null : a.bridge!.status()), "the revoke")
    expect(stopped.last_error).toContain("revoked or unauthorized")
    await Bun.sleep(300)
    expect(a.bridge!.status().connected).toBe(false)
  })

  test("an expired grant closes the bridge with 4001 and it reconnects with its token read again", async () => {
    let now = Date.now()
    const fake = hubServer(() => now)
    let reads = 0
    const a = await machine(fake, "a", {
      credentials: async () => {
        reads++
        return TOKEN
      },
    })
    const before = a.bridge!.status().since
    const closed = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (!a.bridge!.status().connected) {
          clearInterval(poll)
          resolve()
        }
      }, 1)
    })
    now += 2 * 3_600_000
    await fake.hub("ada").alarm(async () => true)
    now = Date.now()
    await closed
    expect(a.bridge!.status().last_error).toContain("expired")
    await waitFor(() => a.bridge!.status().since !== before && a.bridge!.status().connected, "a to reconnect")
    expect(reads).toBeGreaterThan(0)
  })

  test("an internal error in the hub's handshake is retried, not taken as a refusal", async () => {
    const fake = hubServer()
    const hub = fake.hub("ada") as unknown as { hello: (...args: unknown[]) => Promise<unknown> }
    const hello = hub.hello.bind(hub)
    let failed = 0
    hub.hello = async (...args) => {
      if (!failed++) throw new Error("d1 hiccup")
      return hello(...args)
    }
    const a = await machine(fake, "a")
    await waitFor(() => a.bridge!.status().connected, "a to link after the internal error")
    expect(failed).toBe(2)
  })

  test("a forward the hub answers with unavailable backs off instead of retrying hot, then fails with the hub's error", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a", { forwardWaitMs: 1000 })
    const b = await machine(fake, "b", { token: OTHER_TOKEN })
    const impl = await agent(a, "impl")
    await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    const hub = fake.hub("ada") as unknown as { bridgeMethod: (socket: unknown, method: string, params: unknown) => Promise<unknown> }
    const bridgeMethod = hub.bridgeMethod.bind(hub)
    let forwards = 0
    hub.bridgeMethod = async (socket, method, params) => {
      if (method !== "forward") return bridgeMethod(socket, method, params)
      forwards++
      throw new RelayError("unavailable", "the peer's relay is down")
    }
    const sent = impl.request("send", { to: "b/review", body: "x" }).catch((error: unknown) => error)
    const error = (await sent) as RelayError
    expect([error.code, error.message]).toEqual(["unavailable", "the peer's relay is down"])
    expect(forwards).toBeGreaterThan(1)
    expect(forwards).toBeLessThan(20)
    expect(a.bridge!.status().connected).toBe(true)
  })

  test("a full mirror over the hub's frame cap goes out in several frames, and every endpoint reaches the other machines", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b", { token: OTHER_TOKEN })
    const cwd = `/${"d".repeat(1000)}`
    for (let i = 0; i < 480; i++) a.core.claim({ handle: `w${i}`, harness: "claude-code", cwd })
    const before = a.bridge!.status().since
    fake.drop("ada", "a")
    await waitFor(() => a.bridge!.status().since !== before && a.bridge!.status().connected, "a to relink")
    const seen = await waitFor(() => {
      const handles = b.core.remoteViews().filter((v) => v.machine === "a" && v.address.includes("/w"))
      return handles.length === 480 ? handles : null
    }, "a's 480 endpoints on b")
    expect(seen.every((v) => v.cwd === cwd)).toBe(true)
    const hub = fake.hub("ada") as unknown as {
      announce: (machine: string, changes: { view: { address: string; presence: string } }[], full: boolean) => void
      bridgeMethod: (socket: unknown, method: string, params: { endpoints: unknown[] }) => Promise<unknown>
    }
    const announce = hub.announce.bind(hub)
    const bridgeMethod = hub.bridgeMethod.bind(hub)
    const flapped: string[] = []
    let frames = 0
    hub.announce = (machine, changes, full) => {
      flapped.push(...changes.filter((c) => c.view.presence === "offline").map((c) => c.view.address))
      announce(machine, changes, full)
    }
    hub.bridgeMethod = async (socket, method, params) => {
      if (method === "mirror" && params.endpoints.length > 1) frames++
      return bridgeMethod(socket, method, params)
    }
    a.bridge!.resync()
    await waitFor(() => frames >= 3 && b.core.remoteViews().filter((v) => v.machine === "a" && v.address.includes("/w")).length === 480, "the resync")
    await Bun.sleep(300)
    expect(frames).toBeGreaterThanOrEqual(3)
    expect(flapped).toEqual([])
    expect(a.bridge!.status().connected).toBe(true)
  })

  test("a full machines table keeps the bridge retrying with the hub's reason, and it links once a slot frees", async () => {
    const fake = hubServer()
    const clients = []
    for (let i = 0; i < HUB_LIMITS.machines; i++) {
      const raw = await rawSocket(fake, TOKEN)
      expect((await raw("hello", { protocol: PROTOCOL, machine: `m${i}`, claim: { handle: "x", harness: "cli" } })).error).toBeUndefined()
      clients.push(raw)
    }
    const q = await machine(fake, "q")
    await Bun.sleep(300)
    expect(q.bridge!.status().connected).toBe(false)
    expect(q.bridge!.status().last_error).toContain(`at most ${HUB_LIMITS.machines} machines`)
    expect((await clients[0]!("machines_rm", { name: "m0" })).error).toBeUndefined()
    await waitFor(() => q.bridge!.status().connected, "q to link once a slot freed")
    expect(q.bridge!.status().last_error).toBeNull()
  })

  test("an ack the hub's ack limit refuses is retried after its retry_after, so the delivery does not stay unacked", async () => {
    const clock = { now: Date.now() }
    const fake = hubServer(() => clock.now)
    const a = await machine(fake, "a")
    const b = await machine(fake, "b", { token: OTHER_TOKEN })
    const impl = await agent(a, "impl")
    const review = await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    const raw = await rawSocket(fake, OTHER_TOKEN)
    expect((await raw("hello", { protocol: PROTOCOL, machine: "drain", claim: { handle: "drain" } })).error).toBeUndefined()
    for (let i = 0; i < HUB_LIMITS.acksPerMinute; i++) await raw("ack", { seqs: [] })
    expect((await raw("ack", { seqs: [] })).error?.data?.code).toBe("rate_limited")
    await impl.request("send", { to: "b/review", body: "acked once the limit allows" })
    await waitFor(async () => (await review.request<Inbox>("inbox")).messages.length, "the delivery on b")
    clock.now += 60_000
    const acks = async () => {
      await Bun.sleep(200)
      return ((await raw("log", { limit: 1000 })).result?.rows ?? []).filter(
        (r: { event: string; detail: { machine?: string } }) => r.event === "ack" && r.detail.machine === "b",
      ).length
    }
    expect(await waitFor(acks, "the bridge's ack", 5000)).toBe(1)
  })

  test("a hook-only endpoint's presence reaches the other machines: on its first hook, on session_end, and when its hooks stop", async () => {
    const clock = { now: Date.now() }
    const fake = hubServer()
    const a = await machine(fake, "a", { now: () => clock.now, presenceEveryMs: 20 })
    const b = await machine(fake, "b")
    const review = await agent(b, "review")
    const presence = async (address: string) =>
      (await review.request<{ endpoints: { address: string; presence: string }[] }>("list", { all: true })).endpoints.find((e) => e.address === address)
        ?.presence
    const hook = async (session: string, kind: string) => {
      const client = await RelayClient.connect(a.socket)
      try {
        await client.hello({ transient: true, claim: { handle: session, harness: "claude-code", session } })
        await client.request("event", { kind })
      } finally {
        client.close()
      }
    }
    await hook("ended", "session_start")
    await waitFor(async () => (await presence("me/a/ended")) === "online", "a/ended online on b")
    await hook("ended", "session_end")
    await waitFor(async () => (await presence("me/a/ended")) === "offline", "a/ended offline on b")
    await hook("silent", "tool")
    await waitFor(async () => (await presence("me/a/silent")) === "online", "a/silent online on b")
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    await waitFor(async () => (await presence("me/a/silent")) === "offline", "a/silent offline on b once its hooks stopped")
  })

  test("attachment paths stay on the sending machine", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const cwd = mkdtempSync(join(tmpdir(), "relay-bridge-attach-"))
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
    writeFileSync(join(cwd, "report.md"), "local only")
    const impl = await RelayClient.connect(a.socket)
    cleanups.push(() => impl.close())
    await impl.hello({ claim: { handle: "impl", harness: "claude-code", cwd } })
    const review = await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    await impl.request("send", { to: "b/review", body: "see the report", attachments: [{ kind: "path", path: join(cwd, "report.md") }] })
    const got = await review.request<Inbox>("inbox", { wait_s: 5 })
    expect(got.messages.map((m) => [m.body.text, m.attachments])).toEqual([["see the report", []]])
  })

  test("with redact, activity reaches other machines without its summary", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b", { redact: true })
    const review = await agent(b, "review")
    const watcher = await RelayClient.connect(a.socket)
    cleanups.push(() => watcher.close())
    await watcher.hello({ observe: true })
    const events: Record<string, unknown>[] = []
    watcher.onNotification((method, params) => {
      if (method === "fleet") events.push(params as Record<string, unknown>)
    })
    await watcher.request("watch")
    await review.request("event", { kind: "tool", tool: "Bash", summary: "cat ~/notes/plan.md" })
    const seen = await waitFor(() => events.find((e) => e.type === "activity"), "b's activity on a")
    expect(seen).toMatchObject({ type: "activity", machine: "b", endpoint: "me/b/review", kind: "tool", tool: "Bash" })
    expect(seen.summary ?? null).toBeNull()
  })

  test("a private message stays on its machine unless the bridge allows private messages", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const impl = await agent(a, "impl")
    const review = await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    const refused = await impl.request("send", { to: "b/review", body: "private notes", data_class: "private" }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(RelayError)
    expect((refused as RelayError).code).toBe("data_class_refused")
    expect((refused as RelayError).message).toContain("allow private messages")
    await Bun.sleep(200)
    expect((await review.request<Inbox>("inbox")).messages).toEqual([])

    const reply = await agent(b, "reply")
    const c = await machine(fake, "c", { privateOk: true })
    const coder = await agent(c, "coder")
    await waitFor(
      async () => (await coder.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/reply"),
      "b/reply on c",
    )
    await coder.request("send", { to: "b/reply", body: "private notes", data_class: "private" })
    const got = await reply.request<Inbox>("inbox", { wait_s: 5 })
    expect(got.messages.map((m) => [m.body.text, m.data_class])).toEqual([["private notes", "private"]])
  })

  test("a bridge with no token stays down, says why, and remote sends are unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-bridge-notoken-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const broker = await startBroker({
      dir: join(root, "state"),
      policyPath: join(root, "policy.json"),
      idleMs: 0,
      bridge: { url: "http://127.0.0.1:9", token: null, tokenError: "no hub credential", machine: "a" },
    })
    cleanups.push(() => broker.stop())
    const impl = await agent(broker, "impl")
    broker.core.mirror("b", [{ address: "me/review", kind: "agent", presence: "online" }])
    expect(await code(impl.request("send", { to: "b/review", body: "x" }))).toBe("unavailable")
    expect(broker.bridge!.status()).toMatchObject({ enabled: true, connected: false, last_error: "no hub credential" })
  })

  test("an endpoint's rules, place and title reach the other machines, so a send its rules do not admit is refused on the sending machine", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const lead = await agent(a, "lead")
    await lead.request("title", { text: "the lead" })
    const review = await agent(b, "review")
    type Listed = { address: string; title: string | null; depth?: number | null; scope?: string }
    const leadOnB = async () => (await review.request<{ endpoints: Listed[] }>("list")).endpoints.find((e) => e.address === "me/a/lead")
    const seen = await waitFor(async () => {
      const view = await leadOnB()
      return view?.title === "the lead" ? view : null
    }, "a/lead's title on b")
    expect([seen.depth, seen.scope]).toEqual([0, "open"])
    await lead.request("rules_set", { in: ["tree:descendants"] })
    await waitFor(async () => !(await leadOnB()), "a/lead hidden from b by its rules")
    expect(await code(review.request("send", { to: "a/lead", body: "refused on b" }))).toBe("not_found")
    await lead.request("rules_set", { in: ["tree:descendants", "machine:b"] })
    await waitFor(leadOnB, "a/lead admitting b")
    await review.request("send", { to: "a/lead", body: "admitted" })
    const got = await lead.request<Inbox>("inbox", { wait_s: 5 })
    expect(got.messages.map((m) => m.body.text)).toEqual(["admitted"])
  })

  test("a policy cap loosened on reload reaches the other machines, so a send the machine now admits passes there", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a", { policy: { rules: [{ match: "handle:lead", scope: ["tree:descendants"] }] } })
    const b = await machine(fake, "b")
    const lead = await agent(a, "lead")
    const review = await agent(b, "review")
    const leadOnB = async () => (await review.request<{ endpoints: { address: string }[] }>("list")).endpoints.find((e) => e.address === "me/a/lead")
    await waitFor(() => code(Promise.resolve().then(() => b.core.remoteEndpoint("a", "lead"))).then((refused) => refused === undefined), "a/lead mirrored to b")
    await waitFor(async () => !(await leadOnB()), "a/lead hidden from b by the policy")
    expect(await code(review.request("send", { to: "a/lead", body: "refused on b" }))).toBe("not_found")
    writeFileSync(a.policyFile, JSON.stringify({ rules: [{ match: "handle:lead", scope: ["tree:descendants", "machine:b"] }] }))
    await lead.request("policy")
    await waitFor(leadOnB, "a/lead admitting b after the policy reload")
    await review.request("send", { to: "a/lead", body: "admitted" })
    const got = await lead.request<Inbox>("inbox", { wait_s: 5 })
    expect(got.messages.map((m) => m.body.text)).toEqual(["admitted"])
  })

  test("the human at a terminal on one machine is <machine>/me with a human flag on the others, and a reply to that name reaches it", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const human = await RelayClient.connect(a.socket)
    cleanups.push(() => human.close())
    await human.hello({ human: true, tty: true })
    const impl = await agent(a, "impl")
    const review = await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    await human.request("send", { to: "b/review", body: "from my terminal" })
    await impl.request("send", { to: "b/review", body: "from an agent" })
    const got = (
      await waitFor(async () => {
        const inbox = await review.request<Inbox>("inbox", { wait_s: 1 })
        return inbox.messages.length === 2 ? inbox : null
      }, "both messages on b")
    ).messages
    expect(got.map((m) => [m.body.text, m.from.address, m.from.human])).toEqual([
      ["from my terminal", "me/a/", true],
      ["from an agent", "me/a/impl", undefined],
    ])
    expect(wrapMessage(got[0]!)).toContain(`from="me/a/me" human="true" harness="human" auth="account+bridge"`)
    expect(wrapMessage(got[1]!)).not.toContain("human=")
    await review.request("send", { to: "me/a/me", body: "answer" })
    const answered = await human.request<Inbox>("inbox", { wait_s: 5 })
    expect(answered.messages.map((m) => [m.body.text, m.from.address])).toEqual([["answer", "me/b/review"]])
  })

  test("an inject that keeps throwing is retried, then dead-lettered once: the sender gets a notice, one audit row, and later mail to the endpoint lands", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const impl = await agent(a, "impl")
    const review = await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    const admit = b.core.admit.bind(b.core)
    let poisoned = 0
    b.core.admit = (endpoint, message) => {
      if (message.body.text !== "poison") return admit(endpoint, message)
      poisoned++
      throw new Error("disk I/O error")
    }
    const sent = await impl.request<{ id: string }>("send", { to: "b/review", body: "poison" })
    const notice = await impl.request<Inbox>("inbox", { wait_s: 5 })
    expect(notice.messages.map((m) => [m.kind, m.from.address])).toEqual([["status", "me/ada/relay"]])
    expect(notice.messages[0]!.body.text).toContain(`refused message ${sent.id} (dead_letter)`)
    expect(poisoned).toBe(3)
    const dead = b.core.log().filter((r) => r.event === "dead_letter")
    expect(dead.map((r) => [r.ref, r.detail.attempts, r.detail.error])).toEqual([[sent.id, 3, "disk I/O error"]])
    expect(JSON.stringify(dead)).not.toContain("poison")

    await impl.request("send", { to: "b/review", body: "after the poison" })
    const got = await review.request<Inbox>("inbox", { wait_s: 5 })
    expect(got.messages.map((m) => m.body.text)).toEqual(["after the poison"])
    const before = b.bridge!.status().since
    fake.drop("ada", "b")
    await waitFor(() => b.bridge!.status().since !== before && b.bridge!.status().connected, "b to reconnect")
    await Bun.sleep(200)
    expect(poisoned).toBe(3)
    expect((await review.request<Inbox>("inbox")).messages.map((m) => m.body.text)).toEqual(["after the poison"])
    expect((await hubLog(fake, TOKEN, "reject")).map((r) => [r.ref, r.detail.code])).toEqual([[sent.id, "dead_letter"]])
  })

  test("an inject that fails once and then succeeds is acked, with no notice and no dead_letter row", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const impl = await agent(a, "impl")
    const review = await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    const admit = b.core.admit.bind(b.core)
    let failures = 1
    b.core.admit = (endpoint, message) => {
      if (failures-- > 0) throw new Error("database is locked")
      return admit(endpoint, message)
    }
    await impl.request("send", { to: "b/review", body: "flaky" })
    const got = await review.request<Inbox>("inbox", { wait_s: 5 })
    expect(got.messages.map((m) => m.body.text)).toEqual(["flaky"])
    await Bun.sleep(200)
    expect((await impl.request<Inbox>("inbox")).messages).toEqual([])
    expect(b.core.log().some((r) => r.event === "dead_letter")).toBe(false)
    expect(await hubLog(fake, TOKEN, "reject")).toEqual([])
    expect((await hubLog(fake, TOKEN, "ack")).filter((r) => r.detail.machine === "b").map((r) => r.detail.count)).toEqual([1])
  })

  test("a RelayError from the inject still rejects at once, without retries or a dead_letter row", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const impl = await agent(a, "impl")
    await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ endpoints: { address: string }[] }>("list")).endpoints.some((e) => e.address === "me/b/review"),
      "b/review on a",
    )
    let attempts = 0
    b.core.admit = () => {
      attempts++
      throw new RelayError("inbox_full", "me/review has 500 unread messages")
    }
    const sent = await impl.request<{ id: string }>("send", { to: "b/review", body: "refused" })
    const notice = await impl.request<Inbox>("inbox", { wait_s: 5 })
    expect(notice.messages[0]!.body.text).toContain(`refused message ${sent.id} (inbox_full)`)
    await Bun.sleep(200)
    expect(attempts).toBe(1)
    expect(b.core.log().some((r) => r.event === "dead_letter")).toBe(false)
  })

  test("without a bridge, a remote address is not found", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-bridge-none-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0 })
    cleanups.push(() => broker.stop())
    const impl = await agent(broker, "impl")
    expect(await code(impl.request("send", { to: "b/review", body: "x" }))).toBe("not_found")
    expect(await code(impl.request("send", { to: ["b/review", "impl"], body: "x" }))).toBe("invalid_params")
    const observer = await RelayClient.connect(broker.socket)
    cleanups.push(() => observer.close())
    await observer.hello({ observe: true })
    expect(await observer.request<unknown>("cloud_status")).toEqual({ enabled: false })
    expect(await code(observer.request("list", { contacts: true }))).toBe("unavailable")
  })
})

describe("across accounts", () => {
  const BOB_TOKEN = `hub-cred-${"b".repeat(32)}`

  function contacts(): FakeHubServer {
    const fake = startFakeHubServer({
      tokens: { [TOKEN]: { tokenId: "tok_1", user: "ada" }, [BOB_TOKEN]: { tokenId: "tok_b", user: "bob" } },
      contacts: [["ada", "bob"]],
    })
    cleanups.push(() => fake.stop())
    return fake
  }

  test("an agent asks an agent of a contact's account, sees it in list --contacts, and the reply in its thread resolves the ask", async () => {
    const fake = contacts()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b", { token: BOB_TOKEN })
    const impl = await agent(a, "impl")
    const review = await agent(b, "review", "codex")
    const listed = await waitFor(async () => {
      const { contacts: found } = await impl.request<{ contacts: { address: string; harness: string | null; presence: string }[] }>("list", { contacts: true })
      return found.some((e) => e.address === "bob/b/review") ? found : null
    }, "bob/b/review in list --contacts")
    expect(listed).toEqual([
      { address: "bob/b/me", harness: "human", presence: "offline" },
      { address: "bob/b/review", harness: "codex", presence: "online" },
    ])
    const asking = impl.request<{ reply?: Envelope }>("ask", { to: "bob/b/review", body: "please review", wait_s: 10 })
    const got = await review.request<Inbox>("inbox", { wait_s: 5 })
    expect(got.messages.map((m) => [m.body.text, m.from.address, m.from.auth, m.from.account, m.from.rel])).toEqual([
      ["please review", "ada/a/impl", "contact", "ada", "contact:ada"],
    ])
    expect(wrapMessage(got.messages[0]!)).toContain(`from="ada/a/impl" account="ada" contact="true"`)
    await review.request("send", { to: "ada/a/impl", body: "looks good", kind: "reply", reply_to: got.messages[0]!.id })
    const answer = await asking
    expect([answer.reply?.body.text, answer.reply?.from.address, answer.reply?.from.account]).toEqual(["looks good", "bob/b/review", "bob"])
    const { endpoints } = await impl.request<{ endpoints: { address: string }[] }>("list", { all: true })
    expect(endpoints.some((e) => e.address.startsWith("bob/"))).toBe(false)
  })

  test("the sending machine refuses a message to another account with attachments, a private class, a long body or more than one recipient", async () => {
    const fake = contacts()
    const a = await machine(fake, "a", { privateOk: true })
    await machine(fake, "b", { token: BOB_TOKEN })
    const cwd = mkdtempSync(join(tmpdir(), "relay-bridge-xacct-"))
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
    writeFileSync(join(cwd, "report.md"), "stays here")
    const impl = await RelayClient.connect(a.socket)
    cleanups.push(() => impl.close())
    await impl.hello({ claim: { handle: "impl", harness: "claude-code", cwd } })
    const to = "bob/b/review"
    expect(await code(impl.request("send", { to, body: "see the report", attachments: [{ kind: "path", path: join(cwd, "report.md") }] }))).toBe(
      "data_class_refused",
    )
    expect(await code(impl.request("send", { to, body: "private notes", data_class: "private" }))).toBe("data_class_refused")
    expect(await code(impl.request("send", { to, body: "x".repeat(16 * 1024 + 1) }))).toBe("too_large")
    expect(await code(impl.request("send", { to: [to, "bob/b/lead"], body: "x" }))).toBe("invalid_params")
    expect(await code(impl.request("send", { to: [to, "b/review"], body: "x" }))).toBe("invalid_params")
    expect(await code(impl.request("send", { to, body: `here: scp_${"z".repeat(24)}` }))).toBe("secret_refused")
    expect(await code(impl.request("send", { to: "carol/b/review", body: "x" }))).toBe("not_found")
    const fenced = await RelayClient.connect(a.socket)
    cleanups.push(() => fenced.close())
    await fenced.hello({ claim: { handle: "fenced", harness: "claude-code", scope: "tree" } })
    expect(await code(fenced.request("send", { to, body: "x" }))).toBe("not_found")
  })

  test("a dead-lettered message from another account moves the endpoint's cursor past it, so nothing replays", async () => {
    const fake = contacts()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b", { token: BOB_TOKEN })
    const impl = await agent(a, "impl")
    const review = await agent(b, "review")
    await waitFor(
      async () => (await impl.request<{ contacts: { address: string }[] }>("list", { contacts: true })).contacts.some((e) => e.address === "bob/b/review"),
      "bob/b/review in list --contacts",
    )
    const admit = b.core.admit.bind(b.core)
    b.core.admit = (endpoint, message) => {
      if (message.body.text === "poison") throw new Error("disk I/O error")
      return admit(endpoint, message)
    }
    const sent = await impl.request<{ id: string }>("send", { to: "bob/b/review", body: "poison" })
    await waitFor(() => b.core.log().some((r) => r.event === "dead_letter" && r.ref === sent.id), "the dead letter on b")
    await impl.request("send", { to: "bob/b/review", body: "after the poison" })
    const got = await review.request<Inbox>("inbox", { wait_s: 5 })
    expect(got.messages.map((m) => m.body.text)).toEqual(["after the poison"])
    await Bun.sleep(200)
    const raw = await rawSocket(fake, BOB_TOKEN)
    expect((await raw("hello", { protocol: PROTOCOL, machine: "b", bridge: true })).error).toBeUndefined()
    expect((await raw("subscribe", { after: 0 })).result).toMatchObject({ replayed: 0 })
  })
})
