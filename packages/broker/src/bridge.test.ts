import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type EndpointView, type Envelope, LIMITS, PROTOCOL, RelayError, type SendResult, wrapMessage } from "@scp-dev/core"
import { type DashboardEvent, HUB_LIMITS, type HubLimits } from "@scp-dev/hub"
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

function hubServer(now?: () => number, limits?: Partial<HubLimits>): FakeHubServer {
  const fake = startFakeHubServer({ tokens: { [TOKEN]: { tokenId: "tok_1", user: "ada" }, [OTHER_TOKEN]: { tokenId: "tok_2", user: "ada" } }, now, limits })
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
    mirrorLocal?: boolean
    now?: () => number
    presenceEveryMs?: number
    forwardWaitMs?: number
    credentials?: () => Promise<string | null>
    root?: string
    historicAfterS?: number
  } = {},
): Promise<Broker> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), `relay-bridge-${name}-`))
  const policyPath = join(root, "policy.json")
  if (options.policy !== undefined) writeFileSync(policyPath, JSON.stringify(options.policy))
  const broker = await startBroker({
    dir: join(root, "state"),
    policyPath,
    idleMs: 0,
    log: () => {},
    now: options.now,
    presenceEveryMs: options.presenceEveryMs,
    historicAfterS: options.historicAfterS,
    bridge: {
      url: fake.url,
      token: options.token ?? TOKEN,
      machine: name,
      backoff: { minMs: 20, maxMs: 100 },
      injectBackoffMs: 20,
      redact: options.redact,
      privateOk: options.privateOk,
      mirrorLocal: options.mirrorLocal,
      localFlushMs: 20,
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

  test("adopt and unlink reach the hub and the other machines: the mirror sits under its new parent, then back at the root", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    await agent(a, "lead")
    await agent(a, "app")
    await agent(b, "review", "codex")
    const on = (handle: string) => b.core.remoteViews().find((v) => v.machine === "a" && v.address.endsWith(`/${handle}`))
    await waitFor(() => on("app"), "a/app on b")
    const human = await RelayClient.connect(a.socket)
    cleanups.push(() => human.close())
    await human.hello({ human: true, tty: true })
    expect(await human.request("adopt", { endpoint: "app", parent: "lead" })).toMatchObject({ parent: "me/lead", endpoint: { parent: "me/lead" } })
    expect(await waitFor(() => (on("app")?.parent_ep === "lead" ? on("app") : undefined), "a/app under a/lead on b")).toMatchObject({ depth: 1 })
    const hub = (fake.hub("ada") as unknown as { core: { list(f: { all: boolean }): { address: string; parent?: string | null }[] } }).core
    expect(hub.list({ all: true }).find((v) => v.address.endsWith("app"))?.parent).toEndWith("lead")
    await human.request("unlink", { endpoint: "app" })
    await waitFor(() => (on("app")?.parent_ep === null ? true : undefined), "a/app a root again on b")
    expect(hub.list({ all: true }).find((v) => v.address.endsWith("app"))?.parent ?? null).toBeNull()
  })

  test("a root links under another machine's agent: every machine shows it, the two reach each other though scoped, a cycle is refused, unlink clears it", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const app = await agent(a, "app")
    const lead = await agent(b, "lead")
    await app.request("rules_set", { in: [], out: [] })
    const onB = (handle: string) => b.core.list({ all: true }).find((v) => v.address === `me/a/${handle}`)
    await waitFor(() => onB("app"), "a/app on b")
    await waitFor(() => a.core.list({ all: true }).find((v) => v.address === "me/b/lead"), "b/lead on a")
    const human = await RelayClient.connect(a.socket)
    cleanups.push(() => human.close())
    await human.hello({ human: true, tty: true })
    expect(await human.request("adopt", { endpoint: "app", parent: "b/lead" })).toMatchObject({
      parent: "me/b/lead",
      endpoint: { parent: "me/b/lead", depth: 0 },
    })
    await waitFor(() => onB("app")?.parent === "me/lead", "a/app under lead on b")
    const hub = (fake.hub("ada") as unknown as { core: { list(f: { all: boolean }): { address: string; parent?: string | null }[] } }).core
    expect(hub.list({ all: true }).find((v) => v.address.endsWith("/a/app"))?.parent).toEndWith("/b/lead")

    await app.request("send", { to: "b/lead", body: "up" })
    expect((await lead.request<Inbox>("inbox", { wait_s: 5 })).messages.map((m) => m.body.text)).toEqual(["up"])
    await lead.request("send", { to: "a/app", body: "down" })
    expect((await app.request<Inbox>("inbox", { wait_s: 5 })).messages.map((m) => m.body.text)).toEqual(["down"])

    const other = await RelayClient.connect(b.socket)
    cleanups.push(() => other.close())
    await other.hello({ human: true, tty: true })
    expect(await code(other.request("adopt", { endpoint: "lead", parent: "a/app" }))).toBe("scope_refused")

    const side = await RelayClient.connect(a.socket)
    cleanups.push(() => side.close())
    const joined = await side.hello({ transient: true, claim: { handle: "side", harness: "claude-code", session: "s-side" }, join: { under: "b/lead" } })
    expect(joined.endpoint?.parent).toBe("me/b/lead")
    await waitFor(() => onB("side")?.parent === "me/lead", "a/side under lead on b")

    await human.request("unlink", { endpoint: "app" })
    await waitFor(() => (onB("app") && (onB("app")!.parent ?? null) === null ? true : undefined), "a/app a root again on b")
    expect(await code(app.request("send", { to: "b/lead", body: "x" }))).toBe("not_found")
  })

  test("a broker linked again under a new machine name relabels its endpoints, mirrors them there, and the old name leaves nothing behind", async () => {
    const fake = hubServer()
    const root = mkdtempSync(join(tmpdir(), "relay-bridge-rename-"))
    const peer = await machine(fake, "peer")
    const before = await machine(fake, "old", { root })
    const client = await RelayClient.connect(before.socket)
    const shim = { handle: "worker", harness: "pi", session: `pid:${process.pid}:start`, process: `pid:${process.pid}:start` }
    await client.hello({ claim: { ...shim, labels: { machine: "old" } } })
    await waitFor(() => peer.core.remoteViews({ machine: "old" }).some((v) => v.address.endsWith("/worker")), "the peer to see old/worker")
    client.close()
    await before.stop()

    const after = await machine(fake, "new", { root })
    expect(after.core.list({ all: true }).find((v) => v.address === "me/worker")?.labels.machine).toBe("new")
    const again = await RelayClient.connect(after.socket)
    cleanups.push(() => again.close())
    const hello = await again.hello({ claim: shim })
    expect(hello.endpoint?.address).toBe("me/worker")
    await waitFor(
      () => peer.core.remoteViews({ machine: "new" }).find((v) => v.address.endsWith("/worker") && v.presence !== "offline"),
      "the peer to see new/worker",
    )
    expect(after.core.remoteViews({ machine: "old" }).length).toBeGreaterThan(0)

    const raw = await rawSocket(fake, TOKEN)
    expect((await raw("hello", { protocol: PROTOCOL, machine: "admin", claim: { handle: "admin", harness: "cli" } })).error).toBeUndefined()
    expect((await raw("machines_rm", { name: "old" })).error).toBeUndefined()
    await waitFor(() => (!after.core.remoteViews({ machine: "old" }).length && !peer.core.remoteViews({ machine: "old" }).length) || null, "old's rows to go")
    expect(
      after.core
        .list({ all: true })
        .filter((v) => v.address.includes("worker"))
        .map((v) => v.address),
    ).toEqual(["me/worker"])
  })

  test("a bridge drops rows the hub no longer lists and rows mirrored under its own name", async () => {
    const fake = hubServer()
    const root = mkdtempSync(join(tmpdir(), "relay-bridge-self-"))
    const first = await machine(fake, "self", { root })
    first.core.mirror("gone", [{ address: "gone/ghost", kind: "agent", harness: "pi", presence: "offline" }])
    first.core.mirror("self", [{ address: "self/echo", kind: "agent", harness: "pi", presence: "offline" }])
    await first.stop()
    const second = await machine(fake, "self", { root })
    await waitFor(() => second.bridge!.status().connected, "the bridge")
    expect(second.core.remoteViews({ machine: "gone" })).toEqual([])
    expect(second.core.remoteViews({ machine: "self" })).toEqual([])
  })

  test("a rename reaches the other machines in place: the new handle is live there and the old one is gone", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const lead = await agent(a, "claude-app")
    await agent(b, "review", "codex")
    const on = (address: string) => b.core.remoteViews().find((v) => v.machine === "a" && v.address.endsWith(address))
    const before = await waitFor(() => on("/claude-app"), "a/claude-app on b")
    await lead.request("rename", { handle: "lead" })
    const after = await waitFor(() => on("/lead"), "a/lead on b")
    expect(after.id).toBe(before.id)
    expect(after.presence).toBe("online")
    expect(on("/claude-app")).toBeUndefined()
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

  test("a bridge replaced with 4000 stays down until bridge_relink, which reads the credential again and links it", async () => {
    const fake = hubServer()
    let reads = 0
    const a = await machine(fake, "a", {
      credentials: async () => {
        reads++
        return TOKEN
      },
    })
    const newer = await machine(fake, "a")
    const replaced = await waitFor(() => (a.bridge!.status().connected ? null : a.bridge!.status()), "the replace")
    expect(replaced.last_error).toContain("replaced")
    await Bun.sleep(300)
    expect(a.bridge!.status().connected).toBe(false)
    const client = await RelayClient.connect(a.socket)
    cleanups.push(() => client.close())
    await client.hello({ observe: true })
    await client.request("bridge_relink")
    await waitFor(() => a.bridge!.status().connected, "a to link again")
    expect(reads).toBeGreaterThan(0)
    await waitFor(() => !newer.bridge!.status().connected, "the newer bridge to be replaced in turn")
  })

  test("bridge_relink on a broker that started before its cloud config existed stops it, so a fresh one links", async () => {
    const fake = hubServer()
    const root = mkdtempSync(join(tmpdir(), "relay-bridge-late-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const broker = await startBroker({
      dir: join(root, "state"),
      policyPath: join(root, "policy.json"),
      idleMs: 0,
      log: () => {},
      bridgeConfig: async () => ({ url: fake.url, token: TOKEN, machine: "a" }),
    })
    cleanups.push(() => broker.stop())
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    await client.hello({ observe: true })
    expect(await client.request("bridge_relink")).toEqual({ enabled: false, restarting: true })
    await broker.stopped
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

  test("a full mirror leaves out offline historic agents, so 600 of them and 50 live ones link under a 512 endpoint cap", async () => {
    const fake = hubServer(undefined, { endpoints: 512 })
    const a = await machine(fake, "a", { historicAfterS: 3 })
    const b = await machine(fake, "b", { token: OTHER_TOKEN })
    for (let i = 0; i < 600; i++) a.core.disconnect(a.core.claim({ handle: `old${i}`, harness: "claude-code" }).endpoint.id)
    await Bun.sleep(3100)
    for (let i = 0; i < 50; i++) a.core.disconnect(a.core.claim({ handle: `new${i}`, harness: "claude-code" }).endpoint.id)
    const before = a.bridge!.status().since
    fake.drop("ada", "a")
    await waitFor(() => a.bridge!.status().since !== before && a.bridge!.status().connected, "a to relink")
    const fresh = () => b.core.remoteViews().filter((v) => v.machine === "a" && v.address.includes("/new")).length
    await waitFor(() => fresh() === 50, "a's 50 live endpoints on b")
    expect(b.core.remoteViews().filter((v) => v.machine === "a" && v.address.includes("/old"))).toEqual([])
    expect(a.bridge!.status().last_error).toBeNull()
  })

  test("a historic agent that comes back is mirrored again, and a resync keeps leaving out the rest", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a", { historicAfterS: 1 })
    const b = await machine(fake, "b", { token: OTHER_TOKEN })
    for (const handle of ["sleeper", "other"]) a.core.disconnect(a.core.claim({ handle, harness: "claude-code" }).endpoint.id)
    await Bun.sleep(1100)
    const before = a.bridge!.status().since
    fake.drop("ada", "a")
    await waitFor(() => a.bridge!.status().since !== before && a.bridge!.status().connected, "a to relink")
    const on = (handle: string) => b.core.remoteViews().find((v) => v.machine === "a" && v.address.endsWith(`/${handle}`))
    await agent(a, "probe")
    await waitFor(() => on("probe"), "the probe on b")
    expect(on("sleeper")).toBeUndefined()
    await agent(a, "sleeper")
    expect((await waitFor(() => on("sleeper"), "the sleeper back on b")).presence).toBe("online")
    a.bridge!.resync()
    await Bun.sleep(200)
    expect(on("other")).toBeUndefined()
    expect(on("sleeper")?.presence).toBe("online")
  })

  test("a historic child that comes back is mirrored after its historic parent, so the hub places it under it", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a", { historicAfterS: 1 })
    const b = await machine(fake, "b", { token: OTHER_TOKEN })
    const ids = ["lead", "app"].map((handle) => a.core.claim({ handle, harness: "claude-code" }).endpoint.id)
    a.core.adopt({ kind: "human", tty: true }, { endpoint: "app", parent: "lead" }, { tty: true })
    for (const id of ids) a.core.disconnect(id)
    await Bun.sleep(1100)
    const before = a.bridge!.status().since
    fake.drop("ada", "a")
    await waitFor(() => a.bridge!.status().since !== before && a.bridge!.status().connected, "a to relink")
    const on = (handle: string) => b.core.remoteViews().find((v) => v.machine === "a" && v.address.endsWith(`/${handle}`))
    expect(on("app")).toBeUndefined()
    const human = a.core.list().find((v) => v.kind === "human")!
    a.core.send(human.id, { to: "me/app", body: "back to work" })
    a.bridge!.changed(ids[1]!)
    expect(await waitFor(() => (on("app")?.parent_ep === "lead" ? on("app") : undefined), "a/app under a/lead on b")).toMatchObject({ depth: 1 })
    expect(on("lead")?.presence).toBe("offline")
  })

  test("a full machines table keeps the bridge retrying with the hub's reason, and it links once a slot frees", async () => {
    const fake = hubServer(undefined, { machines: 4 })
    const clients = []
    for (let i = 0; i < 4; i++) {
      const raw = await rawSocket(fake, TOKEN)
      expect((await raw("hello", { protocol: PROTOCOL, machine: `m${i}`, claim: { handle: "x", harness: "cli" } })).error).toBeUndefined()
      clients.push(raw)
    }
    const q = await machine(fake, "q")
    await Bun.sleep(300)
    expect(q.bridge!.status().connected).toBe(false)
    expect(q.bridge!.status().last_error).toContain(`at most ${4} machines`)
    expect((await clients[0]!("machines_rm", { name: "m0" })).error).toBeUndefined()
    await waitFor(() => q.bridge!.status().connected, "q to link once a slot freed")
    expect(q.bridge!.status().last_error).toBeNull()
  })

  test("an ack the hub's ack limit refuses is retried after its retry_after, so the delivery does not stay unacked", async () => {
    const clock = { now: Date.now() }
    const acksPerMinute = 1200
    const fake = hubServer(() => clock.now, { acksPerMinute })
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
    for (let i = 0; i < acksPerMinute; i++) await raw("ack", { seqs: [] })
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

  test("a wakeable endpoint whose waker lives stays idle on the hub and the other machines, and goes offline without a wake when the waker closes", async () => {
    const clock = { now: Date.now() }
    const fake = hubServer()
    const a = await machine(fake, "a", { now: () => clock.now, presenceEveryMs: 20 })
    const b = await machine(fake, "b")
    const review = await agent(b, "review")
    const process = `pid:${globalThis.process.pid}:wake`
    const hook = await RelayClient.connect(a.socket)
    await hook.hello({ transient: true, claim: { handle: "lane", harness: "codex", session: "s-lane", process } })
    hook.close()
    const launcher = await RelayClient.connect(a.socket)
    cleanups.push(() => launcher.close())
    await launcher.hello({ observe: true, self: [process] })
    await launcher.request("wake", { via: "codex-app-server" })
    const hub = (fake.hub("ada") as unknown as { core: { list(f: { all: boolean }): EndpointView[] } }).core
    const hubView = () => hub.list({ all: true }).find((v) => v.address.endsWith("/lane"))
    const onHub = () => hubView()?.presence
    const bView = async () => (await review.request<{ endpoints: EndpointView[] }>("list", { all: true })).endpoints.find((e) => e.address === "me/a/lane")
    const onB = async () => (await bView())?.presence
    await waitFor(async () => (await onB()) === "online", "a/lane online on b")
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    await waitFor(async () => (await onB()) === "idle", "a/lane idle on b")
    await Bun.sleep(100)
    expect([onHub(), await onB()]).toEqual(["idle", "idle"])
    expect([hubView()?.wake, (await bView())?.wake]).toEqual(["codex-app-server", "codex-app-server"])
    launcher.close()
    await waitFor(async () => (await onB()) === "offline", "a/lane offline on b once its waker closed")
    expect(onHub()).toBe("offline")
    await waitFor(async () => (await bView())?.wake === null, "a/lane without a wake on b")
    expect(hubView()?.wake).toBeNull()
  })

  test("a hook-only endpoint goes offline on the other machines once its harness process exits, and its handle is free again", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a", { presenceEveryMs: 20 })
    const b = await machine(fake, "b")
    const review = await agent(b, "review")
    const presence = async () =>
      (await review.request<{ endpoints: { address: string; presence: string }[] }>("list", { all: true })).endpoints.find((e) => e.address === "me/a/gone")
        ?.presence
    const harness = Bun.spawn(["sleep", "30"])
    const client = await RelayClient.connect(a.socket)
    await client.hello({ transient: true, claim: { handle: "gone", harness: "opencode", session: "s-gone", process: `pid:${harness.pid}:start` } })
    await client.request("event", { kind: "tool" })
    client.close()
    await waitFor(async () => (await presence()) === "online", "a/gone online on b")
    harness.kill()
    await harness.exited
    await waitFor(async () => (await presence()) === "offline", "a/gone offline on b once its harness exited")
    const next = await RelayClient.connect(a.socket)
    cleanups.push(() => next.close())
    expect((await next.hello({ claim: { handle: "gone", harness: "opencode", exact: true }, brief: true })).endpoint).toMatchObject({ address: "me/gone" })
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
    broker.core.mirror("b", [{ address: "me/review", kind: "agent", presence: "online", parent_ep: null, depth: 0 }])
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

  test("an endpoint's wake reaches the other machines, and a send from there names it", async () => {
    const fake = hubServer()
    const a = await machine(fake, "a")
    const b = await machine(fake, "b")
    const lead = await agent(a, "lead")
    await lead.request("wake", { via: "channels" })
    const review = await agent(b, "review")
    const seen = await waitFor(async () => {
      const view = (await review.request<{ endpoints: EndpointView[] }>("list")).endpoints.find((e) => e.address === "me/a/lead")
      return view?.wake === "channels" ? view : null
    }, "a/lead's wake on b")
    expect(seen.wake).toBe("channels")
    expect((await review.request<SendResult>("send", { to: "a/lead", body: "hi" })).deliveries[0]).toMatchObject({ wake: "channels" })
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

  test("another member's machines show under the org handle, the member's own under me/, and both forms and local/ are accepted", async () => {
    const tokens = { [TOKEN]: "member-a", [OTHER_TOKEN]: "member-b", [`hub-cred-${"e".repeat(32)}`]: "member-a" }
    const fake = startFakeHubServer({
      tokens: Object.fromEntries(Object.entries(tokens).map(([token, actor], i) => [token, { tokenId: `tok_${i}`, user: "scp-dev", actor }])),
    })
    cleanups.push(() => fake.stop())
    const laptop = await machine(fake, "laptop")
    const desk = await machine(fake, "desk", { token: `hub-cred-${"e".repeat(32)}` })
    const impl = await agent(laptop, "impl")
    await agent(desk, "build")
    const other = await machine(fake, "teammate-mac", { token: OTHER_TOKEN })
    const review = await agent(other, "review", "codex")
    const listed = await waitFor(async () => {
      const { endpoints } = await impl.request<{ endpoints: { address: string }[] }>("list")
      const addresses = endpoints.map((e) => e.address)
      return addresses.includes("scp-dev/teammate-mac/review") && addresses.includes("me/desk/build") ? addresses : null
    }, "the other machines on laptop")
    expect(listed).toContain("me/impl")
    const seen = await waitFor(async () => {
      const { endpoints } = await review.request<{ endpoints: { address: string }[] }>("list")
      return endpoints.some((e) => e.address === "scp-dev/laptop/impl") ? endpoints : null
    }, "laptop on teammate-mac")
    expect(seen.some((e) => e.address === "me/laptop/impl")).toBe(false)

    for (const to of ["scp-dev/teammate-mac/review", "me/teammate-mac/review"]) await impl.request("send", { to, body: `via ${to}` })
    const got = await waitFor(async () => {
      const { messages } = await review.request<Inbox>("inbox", {})
      return messages.length === 2 ? messages : null
    }, "both sends")
    expect(got.map((m) => [m.body.text, m.from.address])).toEqual([
      ["via scp-dev/teammate-mac/review", "scp-dev/laptop/impl"],
      ["via me/teammate-mac/review", "scp-dev/laptop/impl"],
    ])
    await review.request("send", { to: "scp-dev/laptop/impl", body: "back" })
    const back = (await impl.request<Inbox>("inbox", { wait_s: 5 })).messages[0]!
    expect([back.body.text, back.from.address]).toEqual(["back", "scp-dev/teammate-mac/review"])
    expect(await code(impl.request("send", { to: "local/impl", body: "self" }))).toBeUndefined()
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

describe("same-machine traffic", () => {
  async function linked(mirrorLocal?: boolean) {
    const dashboard: DashboardEvent[] = []
    const fake = startFakeHubServer({ tokens: { [TOKEN]: { tokenId: "tok_1", user: "ada" } }, dashboard: (_, event) => dashboard.push(event) })
    cleanups.push(() => fake.stop())
    const a = await machine(fake, "a", mirrorLocal === undefined ? {} : { mirrorLocal })
    const b = await machine(fake, "b")
    const impl = await agent(a, "impl")
    const review = await agent(a, "review", "codex")
    const watcher = await RelayClient.connect(b.socket)
    cleanups.push(() => watcher.close())
    await watcher.hello({ observe: true })
    const fleet: Record<string, unknown>[] = []
    watcher.onNotification((method, params) => {
      if (method === "fleet") fleet.push(params as Record<string, unknown>)
    })
    await watcher.request("watch")
    await waitFor(
      () =>
        fake
          .hub("ada")
          .graph()
          .nodes.some((n) => n.address === "ada/a/review"),
      "a/review mirrored",
    )
    return { fake, impl, review, fleet, dashboard }
  }

  test("a send between two endpoints of one machine reaches the hub's graph, watchers and dashboard as metadata only", async () => {
    const { fake, impl, review, fleet, dashboard } = await linked()
    const sent = await impl.request<{ id: string; thread: string }>("send", { to: "review", body: "secret plan text", note: "note text" })
    const asked = impl.request("ask", { to: "review", body: "question text", wait_s: 10 })
    const request = (await review.request<Inbox>("inbox", { wait_s: 5 })).messages.find((m) => m.kind === "request")!
    await review.request("send", { to: "impl", kind: "reply", reply_to: request.id, body: "answer text" })
    await asked

    const seen = await waitFor(() => (fleet.filter((e) => e.type === "message" && e.local === true).length >= 3 ? fleet : null), "local events on b")
    const local = seen.filter((e) => e.type === "message" && e.local === true)
    for (const e of local) expect(Object.keys(e).sort()).toEqual(["at", "from", "id", "kind", "local", "machine", "thread", "to", "type"])
    expect(local.map((e) => [e.kind, e.from, e.to, e.machine])).toEqual([
      ["message", "me/a/impl", ["me/a/review"], "a"],
      ["request", "me/a/impl", ["me/a/review"], "a"],
      ["reply", "me/a/review", ["me/a/impl"], "a"],
    ])
    expect(local[0]!.id).toMatch(/^[0-9a-f]{32}$/)
    expect(local[0]!.id).not.toBe(sent.id)
    const text = JSON.stringify([local, dashboard])
    for (const word of ["secret plan", "question text", "answer text", "note text", sent.id]) expect(text).not.toContain(word)

    const dash = dashboard.filter((e) => e.type === "message")
    expect(dash.map((e) => Object.keys(e).sort())).toEqual(Array(3).fill(["at", "from", "kind", "local", "to", "type"]))
    expect(dash[0]).toMatchObject({ type: "message", kind: "message", from: "ada/a/impl", to: ["ada/a/review"], local: true })

    const edges = fake
      .hub("ada")
      .graph()
      .edges.filter((e) => e.kind === "message")
    expect(edges).toEqual([
      { kind: "message", from: "ada/a/impl", to: "ada/a/review", count: 2, last_at: expect.any(String) },
      { kind: "message", from: "ada/a/review", to: "ada/a/impl", count: 1, last_at: expect.any(String) },
    ])
  })

  test("with mirror_local off, same-machine sends tell the hub nothing", async () => {
    const { fake, impl, review, fleet, dashboard } = await linked(false)
    await impl.request("send", { to: "review", body: "hi" })
    expect((await review.request<Inbox>("inbox", { wait_s: 5 })).messages).toHaveLength(1)
    await Bun.sleep(200)
    expect(fleet.filter((e) => e.type === "message")).toEqual([])
    expect(dashboard.filter((e) => e.type === "message")).toEqual([])
    expect(
      fake
        .hub("ada")
        .graph()
        .edges.filter((e) => e.kind === "message"),
    ).toEqual([])
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
