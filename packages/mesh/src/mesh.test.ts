import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Broker, type BrokerOptions, RelayClient, startBroker } from "@scp-dev/broker"
import { type EndpointView, type Envelope, FakeJudgeClient, LIMITS, RelayError, type SendResult, SERVER_FIELDS } from "@scp-dev/core"
import { WebSocket } from "ws"
import type { AccountKey, MeshConfig } from "./config"
import { accountId, canonicalJson, generateKeyPair, type KeyPair, newNonce, SIGN_DOMAIN, signPayload, verifyPayload } from "./keys"
import { type MeshLink, type MeshOptions, type MeshStatus, startMesh } from "./link"
import { type Channel, newExchange, openChannel, SEAL_TAG_BYTES } from "./seal"
import { issueCert, type MachineCert, MESH_FRAME_BYTES, MESH_PATH, signRecord, verifyCert, verifyRecord } from "./wire"

setDefaultTimeout(15_000)
const MODEL = { id: "openai/test-judge", key_env: "JUDGE_TEST_KEY" }
const answer = (fields: Record<string, unknown>) => JSON.stringify({ verdict: "pass", categories: [], reason: "fine", redactions: [], ...fields })
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
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

function accountKey(): AccountKey {
  return { ...generateKeyPair(), v: 1, account: "team" }
}

async function machine(
  account: AccountKey,
  name: string,
  config: Partial<MeshConfig> = {},
  options: Partial<Pick<MeshOptions, "reloadConfig" | "reloadMs" | "forwardTimeoutMs" | "heartbeatMs">> = {},
  brokerOptions: Partial<Pick<BrokerOptions, "policyPath" | "env" | "judgeClient">> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "mesh-test-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const policyPath = brokerOptions.policyPath ?? join(root, "policy.json")
  const broker = await startBroker({
    ...brokerOptions,
    dir: join(root, "state"),
    policyPath,
    idleMs: 0,
    log: () => {},
    machine: name,
    link: (ctx) =>
      startMesh({
        ...ctx,
        config: { v: 1, enabled: true, account: account.account, machine: name, listen: "127.0.0.1:0", peers: [], ...config },
        account,
        machineKey: generateKeyPair(),
        backoff: { minMs: 20, maxMs: 200 },
        heartbeatMs: 1000,
        ...options,
      }),
  })
  cleanups.push(() => broker.stop())
  const mesh = broker.bridge as MeshLink
  const bound = await mesh.listening()
  return { broker, mesh, policyPath, addr: bound ? `127.0.0.1:${bound.port}` : null }
}

type Machine = Awaited<ReturnType<typeof machine>>
type Inbox = { messages: Envelope[] }

async function agent(broker: Broker, handle: string) {
  const client = await RelayClient.connect(broker.socket)
  cleanups.push(() => client.close())
  await client.hello({ claim: { handle, harness: "test" } })
  return client
}

async function code(promise: Promise<unknown>) {
  try {
    await promise
    return undefined
  } catch (error) {
    if (error instanceof RelayError) return error.code
    throw error
  }
}

async function listed(client: RelayClient, address: string) {
  const { endpoints } = await client.request<{ endpoints: EndpointView[] }>("list", { all: true })
  return endpoints.find((view) => view.address === address)
}

type Frame = {
  jsonrpc: string
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data: { code: string; retry_after?: number } }
}

async function rawPeer(
  target: Machine,
  account: AccountKey,
  name = "c",
  options: { badAuth?: boolean; silent?: boolean; otherKx?: boolean; key?: KeyPair } = {},
) {
  const key = options.key ?? generateKeyPair()
  const cert = issueCert(account, name, key)
  const acct = accountId(account.public)
  const nonce = newNonce()
  const exchange = newExchange()
  let channel: Channel | null = null
  let remoteKx = ""
  const socket = new WebSocket(`ws://${target.addr}${MESH_PATH}`, { maxPayload: MESH_FRAME_BYTES + SEAL_TAG_BYTES })
  const frames: Frame[] = []
  const pending = new Map<number, (frame: Frame) => void>()
  let authenticated = false
  let closeCode: number | undefined
  let remoteNonce = ""
  let remoteCert: MachineCert | undefined
  let nextId = 1
  let seq = 0
  const epoch = Date.now()
  const raw = (frame: object) => {
    const text = JSON.stringify({ jsonrpc: "2.0", ...frame })
    socket.send(channel ? channel.seal(text) : text)
  }
  const notify = (method: string, params: object) => raw({ method, params })
  const closed = new Promise<void>((resolve) =>
    socket.once("close", (code) => {
      closeCode = code
      resolve()
    }),
  )
  cleanups.push(async () => {
    socket.terminate()
    await closed
  })
  socket.on("error", () => {})
  socket.on("message", (data, binary) => {
    const frame = JSON.parse(binary && channel ? channel.open(data as Buffer) : data.toString()) as Frame
    frames.push(frame)
    if (frame.method === "mesh_hello") {
      remoteNonce = frame.params!.nonce as string
      remoteCert = frame.params!.cert as MachineCert
      remoteKx = frame.params!.kx as string
      const payload = { acct, from: name, to: remoteCert.machine, peer_nonce: remoteNonce, nonce, peer_kx: remoteKx, kx: exchange.public, dialed: true }
      notify("mesh_auth", { sig: signPayload(options.badAuth ? generateKeyPair() : key, SIGN_DOMAIN.auth, payload) })
    } else if (frame.method === "mesh_auth") {
      const remote = remoteCert!.machine
      const payload = { acct, from: remote, to: name, peer_nonce: nonce, nonce: remoteNonce, peer_kx: exchange.public, kx: remoteKx, dialed: false }
      authenticated = verifyPayload(remoteCert!.key, SIGN_DOMAIN.auth, payload, frame.params!.sig)
      if (authenticated && !options.badAuth) {
        const mine = { dialer: name, from_nonce: nonce, from_kx: exchange.public }
        const theirs = { dialer: name, from_nonce: remoteNonce, from_kx: remoteKx }
        channel = openChannel(
          exchange,
          remoteKx,
          { acct, from: name, to: remote, ...mine, to_nonce: remoteNonce, to_kx: remoteKx },
          { acct, from: remote, to: name, ...theirs, to_nonce: nonce, to_kx: exchange.public },
        )
      }
    } else if (frame.method === "ping" && !options.silent) {
      notify("ping", {})
    }
    if (frame.id !== undefined) {
      pending.get(frame.id)?.(frame)
      pending.delete(frame.id)
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      notify("mesh_hello", { protocol: "scp/1", acct, cert, nonce, kx: options.otherKx ? newExchange().public : exchange.public })
      resolve()
    })
    socket.once("error", reject)
  })
  return {
    socket,
    frames,
    cert,
    key,
    notify,
    sealed: (frame: object) => channel!.seal(JSON.stringify({ jsonrpc: "2.0", ...frame })),
    authenticated: () => authenticated,
    closeCode: () => closeCode,
    ready: () => waitFor(() => frames.some((frame) => frame.method === "records"), "raw peer authentication"),
    record(endpoints: unknown[] = [{ address: "me/source", kind: "agent", harness: "test", presence: "online" }]) {
      const record = signRecord(key, { v: 1, acct, machine: name, epoch, seq: ++seq, endpoints, cert })
      notify("records", { records: [record] })
      return record
    },
    request(params: unknown): Promise<Frame> {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error("raw request timed out"))
        }, 3000)
        pending.set(id, (frame) => {
          clearTimeout(timer)
          resolve(frame)
        })
        raw({ id, method: "forward", params })
      })
    },
  }
}

async function carried(target: Machine, peer: Awaited<ReturnType<typeof rawPeer>>, name = "c") {
  await peer.ready()
  const record = peer.record()
  await waitFor(() => target.mesh.status().mesh.machines.some((row) => row.machine === name && row.seq === record.seq), "peer record")
}

describe("mesh wire", () => {
  test("canonical JSON sorts nested keys and signatures bind certificates and records", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}')
    const account = accountKey()
    const key = generateKeyPair()
    const trust = { acct: accountId(account.public), public: account.public }
    const cert = issueCert(account, "a", key)
    expect(verifyCert(cert, trust)).toBe(true)
    const payload = { v: 1 as const, acct: trust.acct, machine: "a", epoch: 1, seq: 1, endpoints: [], cert }
    const record = signRecord(key, payload)
    expect(verifyRecord(record, trust)).toBe(true)
    expect(verifyRecord(signRecord(key, { ...record, seq: 2 }), trust)).toBe(true)
    expect(verifyRecord({ ...record, seq: 2 }, trust)).toBe(false)
    expect(verifyRecord(signRecord(generateKeyPair(), payload), trust)).toBe(false)
    expect(verifyCert(issueCert(accountKey(), "a", key), trust)).toBe(false)
    expect(verifyCert({ ...cert, account: "other" }, trust)).toBe(false)
    for (const changes of [{ epoch: -1 }, { seq: 0.5 }, { machine: "b" }, { endpoints: Array(513).fill(null) }]) {
      expect(verifyRecord(signRecord(key, { ...payload, ...changes }), trust)).toBe(false)
    }
    for (const value of [null, [], {}, "record"]) {
      expect(verifyCert(value, trust)).toBe(false)
      expect(verifyRecord(value, trust)).toBe(false)
    }
  })
})

describe("mesh brokers", () => {
  test("two machines deliver messages and replies without a hub", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const a = await machine(account, "a", { peers: [b.addr!], listen: null })
    expect(await a.mesh.listening()).toBeNull()
    const impl = await agent(a.broker, "impl")
    const review = await agent(b.broker, "review")
    await waitFor(() => listed(impl, "me/b/review"), "remote review")
    await waitFor(() => listed(review, "me/a/impl"), "remote sender")
    const sent = await impl.request<SendResult>("send", { to: "b/review", body: "first message", client_id: "first" })
    expect(sent.deliveries.map((delivery) => delivery.address)).toEqual(["me/b/review"])
    const inbox = await review.request<Inbox>("inbox", { wait_s: 2 })
    expect(inbox.messages[0]).toMatchObject({ from: { machine: "a", auth: "account+bridge" }, body: { text: "first message" } })
    await review.request("ack", { seqs: inbox.messages.map((row) => row.seq) })
    const asking = impl.request<{ reply?: Envelope }>("ask", { to: "me/b/review", body: "please review", wait_s: 5 })
    const request = await review.request<Inbox>("inbox", { wait_s: 2 })
    const question = request.messages.find((row) => row.kind === "request")!
    expect(question.body.text).toBe("please review")
    await review.request("send", { to: "a/impl", body: "review complete", kind: "reply", reply_to: question.id })
    expect((await asking).reply).toMatchObject({ body: { text: "review complete" }, from: { address: "me/b/review" } })
    const observer = await RelayClient.connect(a.broker.socket)
    cleanups.push(() => observer.close())
    await observer.hello({ observe: true })
    const status = await observer.request<MeshStatus>("cloud_status")
    expect(status.connected).toBe(true)
    expect(status.mesh.machines).toContainEqual(expect.objectContaining({ machine: "b", linked: true }))
    expect(await code(a.mesh.contacts())).toBe("unavailable")
    expect(await code(impl.request("send", { to: "b/review", body: "local", data_class: "private" }))).toBe("data_class_refused")
    expect(await code(impl.request("send", { to: "other/b/review", body: "outside" }))).toBe("not_found")
    expect(await code(impl.request("send", { to: ["b/review", "c/review"], body: "split" }))).toBe("invalid_params")
  })

  test("a rename on one machine renames the mirror in place, and the wake binding is carried", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const a = await machine(account, "a", { peers: [b.addr!], listen: null })
    const impl = await agent(a.broker, "impl")
    const review = await agent(b.broker, "review")
    const before = await waitFor(() => listed(impl, "me/b/review"), "remote review")
    expect(before.wake).toBeNull()
    const sent = await impl.request<SendResult>("send", { to: "b/review", body: "look" })
    const question = (await review.request<Inbox>("inbox", { wait_s: 2 })).messages[0]!
    await review.request("rename", { handle: "critic" })
    const after = await waitFor(() => listed(impl, "me/b/critic"), "renamed mirror")
    expect(after.id).toBe(before.id)
    expect(await listed(impl, "me/b/review")).toBeUndefined()
    await review.request("send", { to: "a/impl", body: "looked", kind: "reply", reply_to: question.id })
    const reply = (await impl.request<Inbox>("inbox", { wait_s: 2 })).messages.find((row) => row.body.text === "looked")!
    expect(reply).toMatchObject({ reply_to: sent.id, from: { address: "me/b/critic" } })
  })

  test("the receiving broker's judge gates messages from other machines", async () => {
    const account = accountKey()
    const root = mkdtempSync(join(tmpdir(), "mesh-judge-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const policyPath = join(root, "policy.json")
    writeFileSync(policyPath, JSON.stringify({ rules: [], judge: { mode: "enforce", model: MODEL, boundaries: [{}] } }))
    const fake = new FakeJudgeClient([answer({ verdict: "refuse", categories: ["private"], reason: "internal only" }), answer({ verdict: "pass" })])
    const b = await machine(account, "b", {}, {}, { policyPath, env: { JUDGE_TEST_KEY: "k-test" }, judgeClient: () => fake })
    const a = await machine(account, "a", { peers: [b.addr!], listen: null })
    const impl = await agent(a.broker, "impl")
    const review = await agent(b.broker, "review")
    await waitFor(() => listed(impl, "me/b/review"), "remote review")
    await waitFor(() => listed(review, "me/a/impl"), "remote sender")

    expect(await code(impl.request("send", { to: "b/review", body: "internal note" }))).toBe("judge_refused")
    expect((await review.request<Inbox>("inbox")).messages).toEqual([])
    expect(fake.calls).toBe(1)

    await impl.request("send", { to: "b/review", body: "public note" })
    expect((await review.request<Inbox>("inbox")).messages.map((row) => row.body.text)).toEqual(["public note"])
    expect(fake.calls).toBe(2)
  })

  test("the receiving broker enforces rules, hop limits, routing and policy for raw peers", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const review = await agent(b.broker, "review")
    const peer = await rawPeer(b, account)
    await carried(b, peer)
    const forward = (params: object, extra: object = {}) => peer.request({ from: "source", params: { to: "b/review", body: "raw", ...params }, ...extra })
    await review.request("rules_set", { in: ["tree:descendants"] })
    expect((await forward({})).error?.data.code).toBe("not_found")
    await review.request("rules_set", { in: ["*"] })
    expect((await forward({ to: "a/impl" })).error?.data.code).toBe("not_found")
    expect((await forward({ to: "other/b/review" })).error?.data.code).toBe("not_found")
    for (const field of SERVER_FIELDS) expect((await forward({ [field]: "forged" })).error?.data.code).toBe("invalid_params")
    for (const hop_floor of [-1, 1001, 1.5, null]) expect((await forward({}, { hop_floor })).error?.data.code).toBe("invalid_params")
    expect((await peer.request({ from: "source", params: [] })).error?.data.code).toBe("invalid_params")
    expect((await peer.request({ from: "unknown", params: { to: "b/review", body: "raw" } })).error?.data.code).toBe("not_found")
    writeFileSync(b.policyPath, JSON.stringify({ rules: [{ match: "harness:test", send_to: ["kind:human"] }] }))
    expect((await forward({})).error?.data.code).toBe("policy_refused")
    writeFileSync(b.policyPath, "{ invalid")
    expect((await forward({})).error?.data.code).toBe("policy_refused")
    writeFileSync(b.policyPath, JSON.stringify({ rules: [] }))
    expect((await forward({ body: "allowed", attachments: [{ path: "/missing" }], wait_s: 100 })).error).toBeUndefined()
    expect((await review.request<Inbox>("inbox")).messages.map((row) => row.body.text)).toEqual(["allowed"])
    expect((await forward({}, { hop_floor: LIMITS.hopMax + 1 })).error?.data.code).toBe("loop_guard")
  })

  test("frames after authentication are sealed, and a replayed, altered or cleartext frame closes the link", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const tapped: Buffer[] = []
    const tap = createServer((inbound) => {
      const outbound = connect(Number(b.addr!.split(":")[1]), "127.0.0.1")
      for (const [from, to] of [
        [inbound, outbound],
        [outbound, inbound],
      ] as const) {
        from.on("data", (chunk: Buffer) => {
          tapped.push(chunk)
          to.write(chunk)
        })
        from.on("error", () => to.destroy())
        from.on("close", () => to.destroy())
      }
    })
    await new Promise<void>((resolve) => tap.listen(0, "127.0.0.1", resolve))
    cleanups.push(() => new Promise<void>((resolve) => tap.close(() => resolve())))
    const a = await machine(account, "a", { peers: [`127.0.0.1:${(tap.address() as { port: number }).port}`], listen: null })
    const impl = await agent(a.broker, "impl")
    const review = await agent(b.broker, "review")
    await waitFor(() => listed(impl, "me/b/review"), "remote review")
    await impl.request("send", { to: "b/review", body: "marker-6f1d-plaintext" })
    await waitFor(async () => (await review.request<Inbox>("inbox", { wait_s: 1 })).messages.length, "the sealed message")
    const wire = Buffer.concat(tapped).toString("latin1")
    expect(wire).toContain("mesh_hello")
    expect(wire).not.toContain("marker-6f1d-plaintext")
    expect(wire).not.toContain("me/review")

    const replayed = await rawPeer(b, account, "c")
    await replayed.ready()
    const ping = replayed.sealed({ method: "ping", params: {} })
    replayed.socket.send(ping)
    replayed.socket.send(ping)
    await waitFor(() => replayed.closeCode(), "replay close")
    expect(replayed.closeCode()).toBe(1008)
    const altered = await rawPeer(b, account, "d")
    await altered.ready()
    const frame = altered.sealed({ method: "ping", params: {} })
    frame[0]! ^= 1
    altered.socket.send(frame)
    await waitFor(() => altered.closeCode(), "altered close")
    expect(altered.closeCode()).toBe(1008)
    const clear = await rawPeer(b, account, "e")
    await clear.ready()
    clear.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "ping", params: {} }))
    await waitFor(() => clear.closeCode(), "cleartext close")
    expect(clear.closeCode()).toBe(1008)
    const swapped = await rawPeer(b, account, "f", { otherKx: true })
    await waitFor(() => swapped.closeCode(), "swapped key exchange close")
    expect(swapped.closeCode()).toBe(1008)
  })

  test("a third party dialing two machines cannot splice their handshakes into one link", async () => {
    const account = accountKey()
    const a = await machine(account, "a")
    const b = await machine(account, "b")
    const dial = async (target: Machine) => {
      const socket = new WebSocket(`ws://${target.addr}${MESH_PATH}`)
      const frames: Frame[] = []
      const closed = new Promise<number>((resolve) => socket.once("close", resolve))
      cleanups.push(async () => {
        socket.terminate()
        await closed
      })
      socket.on("error", () => {})
      socket.on("message", (data, binary) => {
        if (!binary) frames.push(JSON.parse(data.toString()) as Frame)
      })
      await new Promise((resolve) => socket.once("open", resolve))
      const hello = await waitFor(() => frames.find((frame) => frame.method === "mesh_hello"), "hello")
      const auth = () => waitFor(() => frames.find((frame) => frame.method === "mesh_auth"), "auth")
      const send = (method: string, params: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
      return { hello: hello.params!, auth, send, closed }
    }
    const toA = await dial(a)
    const toB = await dial(b)
    toB.send("mesh_hello", toA.hello)
    toA.send("mesh_hello", toB.hello)
    const [fromA, fromB] = await Promise.all([toA.auth(), toB.auth()])
    toA.send("mesh_auth", fromB.params)
    toB.send("mesh_auth", fromA.params)
    expect(await toA.closed).toBe(1008)
    expect(await toB.closed).toBe(1008)
    expect(a.mesh.status().mesh.links).toEqual([])
    expect(b.mesh.status().mesh.links).toEqual([])
  })

  test("at most 64 inbound links authenticate at once", async () => {
    const b = await machine(accountKey(), "b")
    const open = async () => {
      const socket = new WebSocket(`ws://${b.addr}${MESH_PATH}`)
      const closed = new Promise<number>((resolve) => socket.once("close", resolve))
      cleanups.push(async () => {
        socket.terminate()
        await closed
      })
      socket.on("error", () => {})
      await new Promise((resolve) => socket.once("open", resolve))
      return { closed }
    }
    await Promise.all(Array.from({ length: 64 }, open))
    expect(await (await open()).closed).toBe(1013)
  })

  test("another account and an invalid authentication signature close with policy errors", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const foreign = await rawPeer(b, accountKey())
    await waitFor(() => foreign.closeCode(), "foreign peer close")
    expect(foreign.closeCode()).toBe(1008)
    expect(foreign.authenticated()).toBe(false)
    const bad = await rawPeer(b, account, "c", { badAuth: true })
    await waitFor(() => bad.closeCode(), "bad signature close")
    expect(bad.closeCode()).toBe(1008)
    expect(bad.frames.some((frame) => frame.method === "records")).toBe(false)
    expect(b.mesh.status().connected).toBe(false)
  })

  test("records propagate through a peer, while indirect machines remain offline", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const a = await machine(account, "a", { peers: [b.addr!] })
    const impl = await agent(a.broker, "impl")
    await waitFor(() => b.mesh.status().mesh.machines.some((row) => row.machine === "a" && row.seq > 1), "record at middle peer")
    const c = await machine(account, "c", { peers: [b.addr!] })
    const observer = await agent(c.broker, "observer")
    const view = await waitFor(() => listed(observer, "me/a/impl"), "propagated endpoint")
    expect(view.presence).toBe("offline")
    const before = c.mesh.status().mesh.machines.find((row) => row.machine === "a")!
    expect(before.linked).toBe(false)
    await agent(a.broker, "extra")
    await waitFor(() => listed(observer, "me/a/extra"), "record update")
    expect(c.mesh.status().mesh.machines.find((row) => row.machine === "a")!.seq).toBeGreaterThan(before.seq)
    expect(await code(observer.request("send", { to: "a/impl", body: "no route" }))).toBe("unavailable")
    expect(await waitFor(() => listed(impl, "me/c/observer"), "reverse propagation")).toMatchObject({ presence: "offline" })
  })

  test("losing the last link marks remote endpoints offline and makes sends unavailable", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const a = await machine(account, "a", { peers: [b.addr!] })
    const impl = await agent(a.broker, "impl")
    await agent(b.broker, "review")
    await waitFor(() => listed(impl, "me/b/review"), "remote review")
    await b.broker.stop()
    await waitFor(async () => (await listed(impl, "me/b/review"))?.presence === "offline", "offline review")
    expect(await code(impl.request("send", { to: "b/review", body: "disconnected" }))).toBe("unavailable")
    expect(a.mesh.status().connected).toBe(false)
  })

  test("reloading peers adds and removes dials and restores stored presence", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const review = await agent(b.broker, "review")
    let peers: string[] = []
    const a = await machine(
      account,
      "a",
      { listen: null },
      {
        reloadMs: 30,
        reloadConfig: () => ({ v: 1, enabled: true, account: account.account, machine: "a", listen: null, peers }),
      },
    )
    const impl = await agent(a.broker, "impl")
    peers = [b.addr!]
    await waitFor(async () => (await listed(impl, "me/b/review"))?.presence === "online", "added peer")
    peers = []
    await waitFor(async () => (await listed(impl, "me/b/review"))?.presence === "offline", "removed peer")
    expect(a.mesh.status().mesh.peers).toEqual([])
    peers = [b.addr!]
    await waitFor(async () => (await listed(impl, "me/b/review"))?.presence === "online", "restored peer")
    await waitFor(() => listed(review, "me/a/impl"), "restored sender")
    await impl.request("send", { to: "b/review", body: "restored" })
    expect((await review.request<Inbox>("inbox")).messages[0]!.body.text).toBe("restored")
  })

  test("duplicate links keep presence until the last closes and forwards use the latest", async () => {
    const account = accountKey()
    const b = await machine(account, "b", {}, { forwardTimeoutMs: 80 })
    const review = await agent(b.broker, "review")
    const first = await rawPeer(b, account)
    await carried(b, first)
    const second = await rawPeer(b, account, "c", { key: first.key })
    await second.ready()
    await waitFor(() => b.mesh.status().mesh.links.length === 2, "both links")
    const sending = code(review.request("send", { to: "c/source", body: "latest" }))
    await waitFor(() => second.frames.some((frame) => frame.method === "forward"), "latest link forward")
    expect(first.frames.some((frame) => frame.method === "forward")).toBe(false)
    expect(await sending).toBe("unavailable")
    first.socket.close()
    await waitFor(() => b.mesh.status().mesh.links.length === 1, "first link close")
    expect((await listed(review, "me/c/source"))?.presence).toBe("online")
    const pending = code(review.request("send", { to: "c/source", body: "closing" }))
    await waitFor(() => second.frames.filter((frame) => frame.method === "forward").length === 2, "pending forward")
    second.socket.close()
    expect(await pending).toBe("unavailable")
    await waitFor(async () => (await listed(review, "me/c/source"))?.presence === "offline", "last link close")
  })

  test("stale and tampered records do not replace accepted records", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const peer = await rawPeer(b, account)
    await peer.ready()
    const first = peer.record()
    await waitFor(() => b.mesh.status().mesh.machines.some((row) => row.machine === "c"), "initial record")
    const second = peer.record([])
    await waitFor(() => b.mesh.status().mesh.machines.find((row) => row.machine === "c")?.seq === second.seq, "new record")
    peer.notify("records", { records: [first, { ...second, seq: second.seq + 1, endpoints: first.endpoints }] })
    const result = await peer.request({ from: "source", params: { to: "b/me", body: "removed sender" } })
    expect(result.error?.data.code).toBe("not_found")
    expect(b.mesh.status().mesh.machines.find((row) => row.machine === "c")).toMatchObject({ seq: second.seq, endpoints: 0 })
  })

  test("a second machine under a linked machine's name is refused, and so are its records", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const first = await rawPeer(b, account, "c")
    await carried(b, first)
    const twin = await rawPeer(b, account, "c")
    await waitFor(() => twin.closeCode(), "twin close")
    expect(twin.closeCode()).toBe(1008)
    const relay = await rawPeer(b, account, "d")
    await relay.ready()
    const key = generateKeyPair()
    const forged = signRecord(key, {
      v: 1,
      acct: accountId(account.public),
      machine: "c",
      epoch: Date.now() + 1000,
      seq: 1,
      endpoints: [],
      cert: issueCert(account, "c", key),
    })
    relay.notify("records", { records: [forged] })
    relay.record()
    await waitFor(() => b.mesh.status().mesh.machines.some((row) => row.machine === "d"), "the relay's own record")
    expect(b.mesh.status().mesh.machines.find((row) => row.machine === "c")).toMatchObject({ seq: 1, endpoints: 1 })
    const self = await rawPeer(b, account, "b")
    await waitFor(() => self.closeCode(), "same name close")
    expect(self.closeCode()).toBe(1008)
    first.socket.close()
    await waitFor(() => !b.mesh.status().mesh.links.some((row) => row.machine === "c"), "c unlinked")
    const later = signRecord(key, {
      v: 1,
      acct: accountId(account.public),
      machine: "c",
      epoch: Date.now() + 1_000_000,
      seq: 1,
      endpoints: [],
      cert: issueCert(account, "c", key),
    })
    relay.notify("records", { records: [later] })
    await waitFor(() => b.mesh.status().mesh.machines.find((row) => row.machine === "c")?.endpoints === 0, "the stored rival record")
    const back = await rawPeer(b, account, "c", { key: first.key })
    await carried(b, back)
    expect(b.mesh.status().mesh.machines.find((row) => row.machine === "c")).toMatchObject({ endpoints: 1, linked: true })
  })

  test("a silent authenticated peer is closed after three heartbeats", async () => {
    const account = accountKey()
    const b = await machine(account, "b", {}, { heartbeatMs: 40 })
    const peer = await rawPeer(b, account, "c", { silent: true })
    await carried(b, peer)
    await waitFor(() => peer.closeCode(), "heartbeat close")
    expect(b.mesh.status().connected).toBe(false)
  })

  test("forwards are limited per link", async () => {
    const account = accountKey()
    const b = await machine(account, "b")
    const peer = await rawPeer(b, account)
    await carried(b, peer)
    for (let i = 0; i < 600; i++) expect((await peer.request({})).error?.data.code).toBe("invalid_params")
    const limited = await peer.request({})
    expect(limited.error?.data.code).toBe("rate_limited")
    expect(limited.error?.data.retry_after).toBeGreaterThan(0)
  })
})
