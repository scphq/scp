// biome-ignore-all lint/suspicious/noExplicitAny: JSON-RPC results and frames are untyped wire data
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  type CrossAccountGate,
  type CrossAccountLink,
  type Envelope,
  type GateContext,
  type GateVerdict,
  PROTOCOL,
  RelayError,
  type Sql,
  type SqlValue,
  wrapMessage,
  type XContact,
  type XMessage,
} from "@scp-dev/core"
import { FederatedCore } from "./federation"
import { type HubConn, type HubDeps, RelayHub, type HubSocket } from "./hub"

const START = 1_800_000_000_000
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

type Frame = {
  jsonrpc: "2.0"
  id?: number | null
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: { code: string; retry_after?: number } }
}

class FakeSocket implements HubSocket {
  frames: Frame[] = []
  constructor(
    public conn: HubConn,
    private readonly live: Set<FakeSocket>,
  ) {}
  send(text: string): void {
    this.frames.push(JSON.parse(text) as Frame)
  }
  close(): void {
    this.live.delete(this)
  }
  pushes(method: string): any[] {
    return this.frames.filter((f) => f.id === undefined && f.method === method).map((f) => f.params)
  }
}

/** counts statements that write, as a Durable Object bills them: INSERT, UPDATE, DELETE, REPLACE, and a WITH that ends in one */
const WRITE = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(?:INSERT|UPDATE|DELETE|REPLACE|WITH\b[\s\S]*?\b(?:INSERT|UPDATE|DELETE|REPLACE)\b)/i

interface Gate extends CrossAccountGate {
  calls: { side: string; id: string; msg: XMessage; ctx: GateContext }[]
  egressVerdict: GateVerdict
  ingressVerdict: GateVerdict
}

function gate(): Gate {
  const g: Gate = {
    calls: [],
    egressVerdict: { verdict: "pass" },
    ingressVerdict: { verdict: "pass" },
    egress: async (msg, ctx) => {
      g.calls.push({ side: "egress", id: msg.id, msg, ctx })
      return g.egressVerdict
    },
    ingress: async (msg, ctx) => {
      g.calls.push({ side: "ingress", id: msg.id, msg, ctx })
      return g.ingressVerdict
    },
  }
  return g
}

interface Account {
  id: string
  handle: string
  hub: RelayHub
  db: Database
  writes: { n: number }
  gate: Gate
  contacts: Map<string, XContact>
  delivered: XMessage[]
  connect(): FakeSocket
  ok(socket: FakeSocket, method: string, params?: unknown): Promise<any>
  fails(socket: FakeSocket, method: string, params?: unknown): Promise<string | undefined>
  rpc(socket: FakeSocket, method: string, params?: unknown): Promise<Frame>
  bridge(machine: string, endpoints: Record<string, unknown>[]): Promise<FakeSocket>
  disconnect(socket: FakeSocket): void
  xinbox(): number
  /** a fresh hub on the same storage, as after the object was evicted */
  wake(): void
  /** while on, the link cannot load the contacts */
  unknown: { on: boolean }
}

const root = (handle: string, extra: Record<string, unknown> = {}) => ({
  address: `me/${handle}`,
  kind: "agent",
  harness: "claude-code",
  presence: "online",
  parent_ep: null,
  depth: 0,
  ...extra,
})

/** two accounts, alice and bob, each a hub on its own database, linked as contacts through a fake link that calls the other hub */
type Options = { link?: boolean; storedBytes?: number; machineWake?: HubDeps["machineWake"]; wake?: HubDeps["wake"] }

function setup(options: Options = {}) {
  const clock = { now: START }
  const accounts = new Map<string, Account>()

  function account(id: string, handle: string): Account {
    const db = new Database(":memory:")
    const writes = { n: 0 }
    const sql: Sql = {
      all: <T>(query: string, ...params: SqlValue[]) => {
        if (WRITE.test(query)) writes.n++
        return db.query(query).all(...params) as T[]
      },
    }
    const live = new Set<FakeSocket>()
    const contacts = new Map<string, XContact>()
    const g = gate()
    const delivered: XMessage[] = []
    const unknown = { on: false }
    const link: CrossAccountLink = {
      self: { id, handle },
      contactByHandle: async (h) => [...contacts.values()].find((c) => c.peerHandle === h) ?? null,
      contactById: async (peer) => contacts.get(peer) ?? null,
      contacts: async () => (unknown.on ? null : [...contacts.values()]),
      deliver: async (contact, msg) => {
        delivered.push(msg)
        const peer = accounts.get(contact.peerId)
        if (!peer) throw new RelayError("not_found", "no such account")
        try {
          return await peer.hub.xreceive(id, JSON.parse(JSON.stringify(msg)))
        } catch (error) {
          if (error instanceof RelayError) throw new RelayError(error.code, error.message, error.retryAfterS)
          throw error
        }
      },
      list: async (contact) => accounts.get(contact.peerId)!.hub.xlist(id),
      gate: g,
    }
    const deps = {
      sql,
      hash,
      transaction: <T>(fn: () => T) => db.transaction(fn)(),
      now: () => clock.now,
      sockets: () => [...live],
      save: () => {},
      ...(options.storedBytes === undefined ? {} : { limits: { storedBytes: options.storedBytes } }),
      ...(options.link === false ? {} : { crossAccount: link }),
      ...(options.machineWake ? { machineWake: options.machineWake } : {}),
      ...(options.wake ? { wake: options.wake } : {}),
    }
    let hub = new RelayHub(deps)
    hub.init({ user: handle })
    let nextId = 1
    const connect = () => {
      const socket = new FakeSocket(
        RelayHub.connection({ tokenId: `tok_${handle}`, userId: id, actorId: null, expiresAt: START + 86_400_000 * 30, scoped: false, role: null }),
        live,
      )
      live.add(socket)
      return socket
    }
    const rpc = async (socket: FakeSocket, method: string, params: unknown = {}): Promise<Frame> => {
      const rid = nextId++
      await hub.message(socket, JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }))
      return socket.frames.find((f) => f.id === rid)!
    }
    const ok = async (socket: FakeSocket, method: string, params: unknown = {}) => {
      const frame = await rpc(socket, method, params)
      if (frame.error) throw new Error(`${method}: ${frame.error.data?.code} ${frame.error.message}`)
      return frame.result
    }
    const fails = async (socket: FakeSocket, method: string, params: unknown = {}) => (await rpc(socket, method, params)).error?.data?.code
    const bridge = async (machine: string, endpoints: Record<string, unknown>[]) => {
      const socket = connect()
      await ok(socket, "hello", { protocol: PROTOCOL, machine, bridge: true })
      await ok(socket, "mirror", { full: true, endpoints })
      await ok(socket, "subscribe", { after: 0 })
      return socket
    }
    const disconnect = (socket: FakeSocket) => {
      live.delete(socket)
      hub.closed(socket)
    }
    const xinbox = () => (db.query(`SELECT COUNT(*) AS n FROM xinbox`).get() as { n: number }).n
    const wake = () => {
      hub = new RelayHub(deps)
      hub.init({ user: handle })
      made.hub = hub
    }
    const made: Account = { id, handle, hub, db, writes, gate: g, contacts, delivered, connect, ok, fails, rpc, bridge, disconnect, xinbox, wake, unknown }
    accounts.set(id, made)
    return made
  }

  const alice = account("usr_a", "alice")
  const bob = account("usr_b", "bob")
  const befriend = (a: Account, b: Account, extra: Partial<XContact> = {}) =>
    a.contacts.set(b.id, { peerId: b.id, peerHandle: b.handle, allow: [{ machine: "*", sel: "tree:root" }], dir: "both", limits: null, ...extra })
  befriend(alice, bob)
  befriend(bob, alice)
  return { clock, alice, bob, befriend, account }
}

/** alice's laptop with impl (which may write to bob, and takes in only its own tree) and her human; bob's desk with review */
async function linked(options: Options = {}) {
  const env = setup(options)
  const { alice, bob } = env
  const laptop = await alice.bridge("laptop", [
    root("impl", { rules: { in: ["tree:descendants"], out: ["acct:bob"] } }),
    { address: "me/", kind: "human", presence: "online" },
  ])
  const desk = await bob.bridge("desk", [root("review"), root("spare"), root("lead", { rules: { in: ["tree:descendants"] } })])
  return { ...env, laptop, desk }
}

const forward = (to: string, body: string, extra: Record<string, unknown> = {}, from = "impl", top: Record<string, unknown> = {}) => ({
  from,
  params: { to, body, ...extra },
  ...top,
})

/** a message as alice's relay would send it to bob's desk/review */
const fromAlice = (id: string, extra: Partial<XMessage> = {}, from: Partial<XMessage["from"]> = {}): XMessage => ({
  id,
  from: { account: "alice", address: "alice/laptop/impl", human: false, auth: "contact", rel: "contact:alice", machine: "laptop", ...from },
  to: "desk/review",
  body: "hello",
  kind: "message",
  thread: `thr_${id}`,
  reply_to: null,
  hop: 0,
  client_id: `cid_${id}`,
  created_at: START,
  expires_at: START + 3_600_000,
  ...extra,
})

describe("cross-account messages between two account relays", () => {
  test("an ask reaches the other account's bridge, and a reply in its thread passes the asker's in lists by the reply grant", async () => {
    const { alice, bob, laptop, desk } = await linked()
    const sent = await alice.ok(laptop, "forward", forward("bob/desk/review", "please review", { kind: "request", client_id: "c-1" }))
    expect(sent).toMatchObject({ hop: 0, deliveries: [{ address: "bob/desk/review", seq: 0, offline: false }] })
    const [push] = desk.pushes("deliver")
    expect(push.endpoint).toBe("desk/review")
    expect(push.message).toMatchObject({
      id: sent.id,
      kind: "request",
      thread: sent.thread,
      to: "bob/desk/review",
      body: { text: "please review" },
      from: { address: "alice/laptop/impl", user: "alice", auth: "contact", account: "alice", rel: "contact:alice", machine: "laptop" },
    })
    expect(push.message.from.human).toBeUndefined()
    expect(await bob.ok(desk, "ack", { seqs: [push.seq] })).toEqual({ acked: 1 })

    expect(await bob.fails(desk, "forward", forward("alice/laptop/impl", "unasked", {}, "review"))).toBe("not_found")
    const reply = await bob.ok(desk, "forward", forward("alice/laptop/impl", "looks good", { kind: "reply", reply_to: sent.id }, "review"))
    expect(reply.thread).toBe(sent.thread)
    const back = laptop.pushes("deliver")
    expect(back.map((p) => [p.endpoint, p.message.reply_to, p.message.from.address, p.message.thread, p.message.hop])).toEqual([
      ["laptop/impl", sent.id, "bob/desk/review", sent.thread, 1],
    ])
    expect(bob.delivered.at(-1)!.reply_grant).toBeString()
  })

  test("a reply grant opens only the asker's thread: another endpoint, another message id or a forged grant stays not_found", async () => {
    const { alice, bob, laptop, desk } = await linked()
    const sent = await alice.ok(laptop, "forward", forward("bob/desk/review", "please review"))
    const grant = alice.delivered.at(-1)!.grant!
    expect(grant).toBeString()
    const asked = alice.delivered.at(-1)!
    const base = {
      ...asked,
      from: { account: "bob", address: "bob/desk/review", human: false, auth: "contact" as const, rel: "contact:bob", machine: "desk" },
      to: "laptop/impl",
      kind: "reply",
      reply_to: sent.id,
      hop: 1,
      reply_grant_expires_at: asked.expires_at,
    }
    expect(await code(alice.hub.xreceive(bob.id, { ...base, id: "msg_aaaaaaaa1", client_id: "f-1", reply_grant: "0".repeat(64) }))).toBe("not_found")
    expect(await code(alice.hub.xreceive(bob.id, { ...base, id: "msg_aaaaaaaa2", client_id: "f-2", reply_to: "msg_other0000", reply_grant: grant }))).toBe(
      "not_found",
    )
    expect(await code(alice.hub.xreceive("usr_c", { ...base, id: "msg_aaaaaaaa3", client_id: "f-3", reply_grant: grant }))).toBe("not_found")
    expect(await code(alice.hub.xreceive(bob.id, { ...base, id: "msg_aaaaaaaa4", client_id: "f-4", reply_grant: grant }))).toBeUndefined()
    expect(alice.xinbox()).toBe(1)
    expect(desk.pushes("deliver")).toHaveLength(1)
  })

  test("one clean message and its ack write one reservation on the sending relay and at most two rows on the receiving one", async () => {
    const { alice, bob, laptop, desk } = await linked()
    alice.writes.n = 0
    bob.writes.n = 0
    const sent = await alice.ok(laptop, "forward", forward("bob/desk/review", "one message", { client_id: "c-budget" }))
    expect(alice.writes.n).toBe(1)
    const [push] = desk.pushes("deliver")
    expect(push.message.id).toBe(sent.id)
    await bob.ok(desk, "ack", { seqs: [push.seq] })
    expect(alice.writes.n).toBe(1)
    expect(bob.writes.n).toBeLessThanOrEqual(2)
    expect(bob.writes.n).toBeGreaterThan(0)
  })

  test("a refusing egress gate stops the message before the other relay; a refusing ingress gate leaves no row there", async () => {
    const { alice, bob, laptop, desk } = await linked()
    alice.gate.egressVerdict = { verdict: "refuse", code: "judge_says_no", categories: ["exfiltration"] }
    const refused = await alice.rpc(laptop, "forward", forward("bob/desk/review", "x"))
    expect(refused.error?.data?.code).toBe("policy_refused")
    expect(refused.error?.message).toContain("exfiltration")
    expect(alice.delivered).toHaveLength(0)
    expect(bob.gate.calls).toEqual([])
    expect(bob.xinbox()).toBe(0)

    alice.gate.egressVerdict = { verdict: "pass" }
    bob.gate.ingressVerdict = { verdict: "refuse", code: "secret_refused", categories: ["credentials"] }
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "y"))).toBe("secret_refused")
    expect(bob.gate.calls.map((c) => c.side)).toEqual(["ingress"])
    expect(bob.xinbox()).toBe(0)
    expect(desk.pushes("deliver")).toEqual([])
  })

  test("the contact and the target resolve before either gate: an unresolvable address is not_found and no gate is called", async () => {
    const { alice, bob, laptop } = await linked()
    alice.gate.egressVerdict = { verdict: "refuse", code: "policy_refused", categories: ["x"] }
    bob.gate.ingressVerdict = { verdict: "refuse", code: "policy_refused", categories: ["x"] }
    expect(await alice.fails(laptop, "forward", forward("carol/desk/review", "x"))).toBe("not_found")
    expect(alice.gate.calls).toEqual([])
    alice.gate.egressVerdict = { verdict: "pass" }
    for (const to of ["bob/desk/nobody", "bob/attic/review", "bob/desk/lead2"]) expect(await alice.fails(laptop, "forward", forward(to, "x"))).toBe("not_found")
    expect(bob.gate.calls).toEqual([])
    const missing = await alice.rpc(laptop, "forward", forward("carol/desk/review", "x"))
    expect(missing.error?.message).toBe("no endpoint carol/desk/review")
  })

  test("a credential is refused before either gate sees the message", async () => {
    const { alice, bob, laptop } = await linked()
    const body = `here: scp_${"z".repeat(24)}`
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", body))).toBe("secret_refused")
    expect(alice.gate.calls).toEqual([])
    const msg = {
      id: "msg_secret0001",
      from: { account: "alice", address: "alice/laptop/impl", human: false, auth: "contact", rel: "contact:alice", machine: "laptop" },
      to: "desk/review",
      body,
      kind: "message",
      thread: "thr_1",
      reply_to: null,
      hop: 0,
      client_id: "s-1",
      created_at: START,
      expires_at: START + 60_000,
    }
    expect(await code(bob.hub.xreceive(alice.id, msg))).toBe("secret_refused")
    expect(bob.gate.calls).toEqual([])
    expect(bob.xinbox()).toBe(0)
  })

  test("a retry with the same client_id answers the first message's id, with one row and one push", async () => {
    const { alice, bob, laptop, desk } = await linked()
    const first = await alice.ok(laptop, "forward", forward("bob/desk/review", "once", { client_id: "c-dup" }))
    const second = await alice.ok(laptop, "forward", forward("bob/desk/review", "once", { client_id: "c-dup" }))
    expect(second).toMatchObject({ id: first.id, duplicate: true })
    expect(bob.xinbox()).toBe(1)
    expect(desk.pushes("deliver")).toHaveLength(1)
    expect(bob.gate.calls.filter((c) => c.side === "ingress")).toHaveLength(1)
  })

  test("caps: one recipient, 16 KiB, no attachments or private class, hop 8, 10 a minute per pair, a thread of 50", async () => {
    const { alice, laptop, clock } = await linked()
    expect(await alice.fails(laptop, "forward", forward(["bob/desk/review", "bob/desk/lead"] as unknown as string, "x"))).toBe("invalid_params")
    expect(await alice.fails(laptop, "forward", forward(["bob/desk/review", "group:team"] as unknown as string, "x"))).toBe("invalid_params")
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x".repeat(16 * 1024 + 1)))).toBe("too_large")
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x", { attachments: [{ kind: "path", path: "/tmp/a" }] }))).toBe(
      "data_class_refused",
    )
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x", { data_class: "private" }))).toBe("data_class_refused")
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x", {}, "impl", { hop_floor: 9 }))).toBe("loop_guard")
    expect((await alice.ok(laptop, "forward", forward("bob/desk/review", "x".repeat(16 * 1024), {}, "impl", { hop_floor: 8 }))).hop).toBe(8)
    for (let i = 1; i < 10; i++) await alice.ok(laptop, "forward", forward("bob/desk/review", `m${i}`))
    const eleventh = await alice.rpc(laptop, "forward", forward("bob/desk/review", "m10"))
    expect(eleventh.error?.data?.code).toBe("rate_limited")
    expect(eleventh.error?.data?.retry_after).toBeGreaterThan(0)
    await alice.ok(laptop, "forward", forward("bob/desk/spare", "another pair"))
    for (let i = 0; i < 50; i++) {
      clock.now += 7 * 60_000
      await alice.ok(laptop, "forward", forward("bob/desk/review", `t${i}`, { thread: "thr_long" }))
    }
    clock.now += 7 * 60_000
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "t50", { thread: "thr_long" }))).toBe("loop_guard")
  })

  test("200 messages a day per account, raised by the contact's per_day up to 2000", async () => {
    const { alice, bob, laptop, clock, befriend } = await linked()
    clock.now = START - (START % 86_400_000) + 86_400_000 + 60_000
    for (let i = 0; i < 200; i++) {
      clock.now += 4 * 60_000
      await alice.ok(laptop, "forward", forward("bob/desk/review", `d${i}`))
    }
    clock.now += 4 * 60_000
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "d200"))).toBe("rate_limited")
    befriend(alice, bob, { limits: { per_day: 5000 } })
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "d200"))).toBe("rate_limited")
    befriend(bob, alice, { limits: { per_day: 5000 } })
    await alice.ok(laptop, "forward", forward("bob/desk/review", "d200"))
  })

  test("retries through a peer outage spend none of the pair, thread or day counts, and the next delivery goes through", async () => {
    const { alice, bob, laptop, desk, clock } = await linked()
    const xreceive = bob.hub.xreceive.bind(bob.hub)
    bob.hub.xreceive = async () => {
      throw new RelayError("unavailable", "the relay is unavailable; try again later")
    }
    clock.now = START - (START % 86_400_000) + 86_400_000 + 60_000
    alice.writes.n = 0
    for (let i = 0; i < 210; i++) {
      clock.now += 4 * 60_000
      expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "retried", { thread: "thr_outage", client_id: "c-outage" }))).toBe("unavailable")
    }
    for (let i = 0; i < 10; i++)
      expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "retried", { thread: "thr_outage", client_id: "c-outage" }))).toBe("unavailable")
    expect(alice.writes.n).toBe(1)
    bob.hub.xreceive = xreceive
    for (let i = 0; i < 10; i++) await alice.ok(laptop, "forward", forward("bob/desk/review", `after${i}`, { thread: "thr_outage" }))
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "eleventh", { thread: "thr_outage" }))).toBe("rate_limited")
    expect(desk.pushes("deliver")).toHaveLength(10)
  })

  test("the sender's day cap counts one contact's messages only: a day spent on one contact leaves another's open", async () => {
    const { alice, bob, laptop, clock, befriend, account } = await linked()
    const carol = account("usr_c", "carol")
    befriend(alice, carol)
    befriend(carol, alice)
    await carol.bridge("den", [root("review")])
    await alice.ok(laptop, "mirror", { endpoints: [root("open")] })
    clock.now = START - (START % 86_400_000) + 86_400_000 + 60_000
    for (let i = 0; i < 200; i++) {
      clock.now += 4 * 60_000
      await alice.ok(laptop, "forward", forward("bob/desk/review", `d${i}`, {}, "open"))
    }
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "d200", {}, "open"))).toBe("rate_limited")
    await alice.ok(laptop, "forward", forward("carol/den/review", "c0", {}, "open"))
    expect(bob.xinbox()).toBe(200)
  })

  test("a released egress hold goes out under its hold id, the id its sender got, so the reply to it passes the sender's in lists", async () => {
    const { alice, bob, laptop, desk } = await linked()
    const hold_id = "hold_0000000held1"
    alice.gate.egressVerdict = { verdict: "hold", hold_id }
    const held = await alice.ok(laptop, "forward", forward("bob/desk/review", "please review", { kind: "request" }))
    expect(held.id).toBe(hold_id)
    const { msg, ctx } = alice.gate.calls.at(-1)!
    alice.gate.egressVerdict = { verdict: "pass" }
    const released = await alice.hub.xrelease({ side: "egress", hold_id, sender: ctx.sender!, peer: "bob", message: msg })
    expect(released.id).toBe(hold_id)
    expect(desk.pushes("deliver").map((p) => p.message.id)).toEqual([hold_id])
    await bob.ok(desk, "forward", forward("alice/laptop/impl", "looks good", { kind: "reply", reply_to: hold_id }, "review"))
    expect(laptop.pushes("deliver").map((p) => p.message.reply_to)).toEqual([hold_id])
  })

  test("a row withheld while the contacts are unknown replays on a later subscribe even after a later seq was acked", async () => {
    const { alice, bob, laptop, desk } = await linked()
    bob.disconnect(desk)
    const sent = await alice.ok(laptop, "forward", forward("bob/desk/review", "queued"))
    bob.unknown.on = true
    const blind = bob.connect()
    await bob.ok(blind, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
    await bob.ok(blind, "subscribe", { after: 0 })
    expect(blind.pushes("deliver")).toEqual([])
    const den = await bob.bridge("den", [root("impl")])
    const local = await bob.ok(den, "forward", { from: "impl", params: { to: "desk/review", body: "same account" } })
    const seq = local.deliveries[0].seq
    expect(blind.pushes("deliver").map((p) => p.seq)).toEqual([seq])
    await bob.ok(blind, "ack", { seqs: [seq] })
    bob.disconnect(blind)
    bob.unknown.on = false
    const again = bob.connect()
    await bob.ok(again, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
    await bob.ok(again, "subscribe", { after: seq })
    expect(again.pushes("deliver").map((p) => p.message.id)).toEqual([sent.id])
  })

  test("forgetting a revoked machine's tombstone drops its unexpired xinbox rows, so they never replay to a new holder", async () => {
    const { alice, bob, laptop, clock } = await linked()
    bob.hub.revoke({ tokenId: "tok_bob" })
    clock.now += 8 * 86_400_000
    await alice.ok(laptop, "forward", forward("bob/desk/review", "late", { ttl_s: 30 * 86_400 }))
    expect(bob.xinbox()).toBe(1)
    clock.now = START + 37 * 86_400_000 + 3_600_000
    await bob.hub.alarm(async () => true)
    expect(bob.xinbox()).toBe(0)
  })

  test("the human at a terminal is <account>/me with a human flag; without a terminal, an agent, or a forged sender never is", async () => {
    const { alice, bob, laptop, desk } = await linked()
    await alice.ok(laptop, "forward", { from: "", tty: true, params: { to: "bob/desk/review", body: "from alice herself" } })
    await alice.ok(laptop, "forward", { from: "", tty: false, params: { to: "bob/desk/review", body: "a script" } })
    await alice.ok(laptop, "forward", { from: "impl", tty: true, params: { to: "bob/desk/review", body: "an agent" } })
    expect(desk.pushes("deliver").map((p) => [p.message.body.text, p.message.from.address, p.message.from.human])).toEqual([
      ["from alice herself", "alice/me", true],
      ["a script", "alice/laptop/me", undefined],
      ["an agent", "alice/laptop/impl", undefined],
    ])
    expect(
      await alice.fails(laptop, "forward", {
        from: "impl",
        tty: true,
        params: { to: "bob/desk/review", body: "x", from: { address: "alice/me", human: true } },
      }),
    ).toBe("invalid_params")
    const forged = (from: Record<string, unknown>, id: string) => ({
      id,
      from: { account: "alice", auth: "contact", rel: "contact:alice", machine: "laptop", ...from },
      to: "desk/review",
      body: "x",
      kind: "message",
      thread: "thr_f",
      reply_to: null,
      hop: 0,
      client_id: id,
      created_at: START,
      expires_at: START + 60_000,
    })
    expect(await code(bob.hub.xreceive(alice.id, forged({ address: "alice/laptop/impl", human: true }, "msg_forged0001")))).toBe("invalid_params")
    expect(await code(bob.hub.xreceive(alice.id, forged({ address: "alice/me", human: false }, "msg_forged0002")))).toBe("invalid_params")
    expect(await code(bob.hub.xreceive(alice.id, forged({ address: "carol/laptop/impl", human: false }, "msg_forged0003")))).toBe("invalid_params")
    expect(await code(bob.hub.xreceive(alice.id, forged({ account: "carol", address: "carol/laptop/impl", human: false }, "msg_forged0004")))).toBe("not_found")
    const shown = wrapMessage(desk.pushes("deliver")[0].message as Envelope)
    expect(shown).toContain(`from="alice/me" human="true" account="alice" contact="true"`)
  })

  test("a queued message replays on subscribe after a seq, and acked ones never again; seqs stay one space with same-account deliveries", async () => {
    const { alice, bob, laptop, desk } = await linked()
    bob.disconnect(desk)
    const one = await alice.ok(laptop, "forward", forward("bob/desk/review", "first"))
    const two = await alice.ok(laptop, "forward", forward("bob/desk/review", "second"))
    expect([one.deliveries[0].offline, two.deliveries[0].offline]).toEqual([true, true])
    const again = bob.connect()
    await bob.ok(again, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
    const replay = await bob.ok(again, "subscribe", { after: 0 })
    const seqs = again.pushes("deliver").map((p) => p.seq)
    expect(again.pushes("deliver").map((p) => p.message.id)).toEqual([one.id, two.id])
    expect(replay).toEqual({ replayed: 2, next: seqs[1] })
    await bob.ok(again, "ack", { seqs: [seqs[0]] })
    const third = bob.connect()
    await bob.ok(third, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
    await bob.ok(third, "subscribe", { after: 0 })
    expect(third.pushes("deliver").map((p) => p.message.id)).toEqual([two.id])
    const den = await bob.bridge("den", [root("impl")])
    const local = await bob.ok(den, "forward", { from: "impl", params: { to: "desk/review", body: "same account" } })
    expect(local.deliveries[0].seq).toBeGreaterThan(seqs[1])
    await bob.ok(third, "ack", { seqs: [seqs[1], local.deliveries[0].seq] })
    const fourth = bob.connect()
    await bob.ok(fourth, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
    expect(await bob.ok(fourth, "subscribe", { after: 0 })).toEqual({ replayed: 0, next: 0 })
    expect(await bob.ok(fourth, "reject", { seq: seqs[1], code: "policy_refused" }).catch(() => "gone")).toBe("gone")
  })

  test("an allowlist admits roots by tree:root, an ep: entry its endpoint, a worker only with allow_worker, never an unknown depth", async () => {
    const { alice, bob, laptop, befriend } = await linked()
    await bob.bridge("ci", [
      root("orch"),
      { address: "me/mid", kind: "agent", harness: "codex", presence: "online", parent_ep: "orch", depth: 1 },
      { address: "me/worker", kind: "agent", harness: "codex", presence: "online", parent_ep: "mid", depth: 2 },
      { address: "me/loose", kind: "agent", harness: "codex", presence: "online" },
    ])
    for (const to of ["bob/ci/mid", "bob/ci/worker", "bob/ci/loose"]) expect(await alice.fails(laptop, "forward", forward(to, "x"))).toBe("not_found")
    await alice.ok(laptop, "forward", forward("bob/ci/orch", "x"))
    befriend(bob, alice, {
      allow: [
        { machine: "ci", sel: "ep:ci/worker" },
        { machine: "ci", sel: "ep:ci/mid" },
        { machine: "ci", sel: "ep:ci/loose" },
      ],
    })
    await alice.ok(laptop, "forward", forward("bob/ci/mid", "x"))
    expect(await alice.fails(laptop, "forward", forward("bob/ci/worker", "x"))).toBe("not_found")
    expect(await alice.fails(laptop, "forward", forward("bob/ci/loose", "x"))).toBe("not_found")
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x"))).toBe("not_found")
    befriend(bob, alice, { allow: [{ machine: "ci", sel: "ep:ci/worker", allow_worker: true }] })
    await alice.ok(laptop, "forward", forward("bob/ci/worker", "x"))
  })

  test("the sender must be on its own account's allowlist for the contact, and its out lists must name acct:", async () => {
    const { alice, laptop, befriend, bob } = await linked()
    await alice.ok(laptop, "mirror", { endpoints: [root("open"), root("fenced", { rules: { out: ["fleet:*"] } })] })
    await alice.ok(laptop, "forward", forward("bob/desk/review", "x", {}, "open"))
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x", {}, "fenced"))).toBe("not_found")
    befriend(alice, bob, { allow: [{ machine: "laptop", sel: "ep:laptop/open" }] })
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x", {}, "impl"))).toBe("not_found")
    await alice.ok(laptop, "forward", forward("bob/desk/review", "x", {}, "open"))
    await alice.ok(laptop, "forward", { from: "", tty: true, params: { to: "bob/desk/review", body: "the human of a named machine" } })
  })

  test("the recipient's in lists must name acct:, and a contact's direction or its removal cuts the next message", async () => {
    const { alice, bob, laptop, befriend } = await linked()
    expect(await alice.fails(laptop, "forward", forward("bob/desk/lead", "x"))).toBe("not_found")
    befriend(alice, bob, { dir: "in" })
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x"))).toBe("not_found")
    befriend(alice, bob)
    befriend(bob, alice, { dir: "out" })
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x"))).toBe("not_found")
    befriend(bob, alice)
    await alice.ok(laptop, "forward", forward("bob/desk/review", "x"))
    bob.contacts.delete(alice.id)
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x"))).toBe("not_found")
    alice.contacts.delete(bob.id)
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x"))).toBe("not_found")
  })

  test("list --contacts shows the allowlisted endpoints of each contact: address, harness and presence only", async () => {
    const { alice, bob, laptop } = await linked()
    await bob.bridge("ci", [
      root("orch", { cwd: "/srv/secret", labels: { team: "x" }, title: "hidden" }),
      { address: "me/worker", kind: "agent", harness: "codex", presence: "online", parent_ep: "orch", depth: 1 },
    ])
    const { contacts } = await alice.ok(laptop, "list", { contacts: true })
    expect(contacts).toEqual([
      { address: "bob/ci/orch", harness: "claude-code", presence: "online" },
      { address: "bob/desk/lead", harness: "claude-code", presence: "online" },
      { address: "bob/desk/review", harness: "claude-code", presence: "online" },
      { address: "bob/desk/spare", harness: "claude-code", presence: "online" },
    ])
    const human = alice.connect()
    await alice.ok(human, "hello", { protocol: PROTOCOL, machine: "cli", human: true, tty: true })
    expect((await alice.ok(human, "list", { contacts: true })).contacts.map((e: any) => e.address)).toEqual(contacts.map((e: any) => e.address))
    alice.contacts.set(bob.id, { ...alice.contacts.get(bob.id)!, dir: "in" })
    expect((await alice.ok(laptop, "list", { contacts: true })).contacts).toEqual([])
  })

  test("a direct client of the hub has no cross-account path: another account's address is not found", async () => {
    const { alice } = await linked()
    const cli = alice.connect()
    await alice.ok(cli, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "bot" } })
    expect(await alice.fails(cli, "send", { to: "bob/desk/review", body: "x" })).toBe("not_found")
    expect(alice.delivered).toHaveLength(0)
  })

  test("the sweep purges an expired xinbox row a day after its receipt and keeps its seq from coming back; only the sender keeps a day count row", async () => {
    const { alice, bob, laptop, desk, clock } = await linked()
    const sent = await alice.ok(laptop, "forward", forward("bob/desk/review", "short lived", { ttl_s: 60 }))
    const [push] = desk.pushes("deliver")
    expect(push.message.id).toBe(sent.id)
    expect(alice.db.query(`SELECT contact, sent FROM xcounters`).all()).toEqual([{ contact: bob.id, sent: 1 }])
    clock.now += 11 * 60_000
    await bob.hub.alarm(async () => true)
    await alice.hub.alarm(async () => true)
    expect(bob.xinbox()).toBe(1)
    clock.now += 24 * 3_600_000
    await bob.hub.alarm(async () => true)
    await alice.hub.alarm(async () => true)
    expect(bob.xinbox()).toBe(0)
    expect(alice.db.query(`SELECT contact, sent FROM xcounters`).all()).toEqual([{ contact: bob.id, sent: 1 }])
    expect(bob.db.query(`SELECT COUNT(*) AS n FROM xcounters`).get()).toEqual({ n: 0 })
    const den = await bob.bridge("den", [root("impl")])
    const local = await bob.ok(den, "forward", { from: "impl", params: { to: "desk/review", body: "same account" } })
    expect(local.deliveries[0].seq).toBeGreaterThan(push.seq)
  })

  test("the recipient enforces the lower of its own contact's limits and the sender's declared ones; a retry is not counted", async () => {
    const { alice, bob, laptop, befriend } = await linked()
    befriend(bob, alice, { limits: { per_minute: 3 } })
    for (let i = 0; i < 3; i++) await alice.ok(laptop, "forward", forward("bob/desk/review", `m${i}`, { client_id: `c-${i}` }))
    const fourth = await alice.rpc(laptop, "forward", forward("bob/desk/review", "m3"))
    expect(fourth.error?.data?.code).toBe("rate_limited")
    expect(fourth.error?.data?.retry_after).toBeGreaterThan(0)
    expect((await alice.ok(laptop, "forward", forward("bob/desk/review", "m0", { client_id: "c-0" }))).duplicate).toBe(true)
    expect(bob.xinbox()).toBe(3)

    befriend(bob, alice)
    const direct = (id: string, limits: unknown) => bob.hub.xreceive(alice.id, { ...fromAlice(id, { to: "desk/spare" }), limits })
    expect(await code(direct("msg_declared01", { per_minute: 1 }))).toBeUndefined()
    expect(await code(direct("msg_declared02", { per_minute: 1 }))).toBe("rate_limited")
    for (const limits of [{ per_minute: 0 }, { per_hour: 1.5 }, { per_day: "9" }, "x", [1]])
      expect(await code(direct("msg_declared03", limits))).toBe("invalid_params")
    expect(bob.xinbox()).toBe(4)
  })

  test("the pair caps survive a wake: of the sender, and separately of the recipient", async () => {
    const { alice, bob, laptop } = await linked()
    for (let i = 0; i < 5; i++) await alice.ok(laptop, "forward", forward("bob/desk/review", `s${i}`))
    alice.wake()
    for (let i = 5; i < 10; i++) await alice.ok(laptop, "forward", forward("bob/desk/review", `s${i}`))
    const eleventh = await alice.rpc(laptop, "forward", forward("bob/desk/review", "s10"))
    expect(eleventh.error?.data?.code).toBe("rate_limited")
    expect(bob.xinbox()).toBe(10)

    for (let i = 0; i < 5; i++) expect(await code(bob.hub.xreceive(alice.id, fromAlice(`msg_wakerecv${i}`, { to: "desk/spare" })))).toBeUndefined()
    bob.wake()
    for (let i = 5; i < 10; i++) expect(await code(bob.hub.xreceive(alice.id, fromAlice(`msg_wakerecv${i}`, { to: "desk/spare" })))).toBeUndefined()
    expect(await code(bob.hub.xreceive(alice.id, fromAlice("msg_wakerecv10", { to: "desk/spare" })))).toBe("rate_limited")
    expect(bob.xinbox()).toBe(20)
  })

  test("the day cap survives a wake of the sender mid-burst and never lets more than 200 through; the recipient's survives its own", async () => {
    const { alice, bob, laptop, clock } = await linked()
    clock.now = START - (START % 86_400_000) + 86_400_000 + 60_000
    let through = 0
    let refused: string | undefined
    for (let burst = 0; burst < 25 && !refused; burst++) {
      if (burst === 10) alice.wake()
      for (let i = 0; i < 10 && !refused; i++) {
        refused = await alice.fails(laptop, "forward", forward("bob/desk/review", `b${burst}-${i}`))
        if (!refused) through++
      }
      clock.now += 7 * 60_000
    }
    expect(refused).toBe("rate_limited")
    expect(through).toBeLessThanOrEqual(200)
    expect(through).toBeGreaterThan(200 - 20)
    expect(bob.xinbox()).toBe(through)
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "after"))).toBe("rate_limited")

    bob.wake()
    const spare = (i: number) =>
      bob.hub.xreceive(
        alice.id,
        fromAlice(`msg_dayrecv${String(i).padStart(4, "0")}`, { to: "desk/spare", expires_at: clock.now + 3_600_000 }, { address: `alice/laptop/s${i}` }),
      )
    const left = 200 - through
    for (let i = 0; i < left; i++) expect(await code(spare(i))).toBeUndefined()
    expect(await code(spare(left))).toBe("rate_limited")
    expect(bob.xinbox()).toBe(200)
  })

  test("a burst reserves its day count ahead in a few writes, and the alarm trues the reservation up once the burst is over", async () => {
    const { alice, laptop, clock } = await linked()
    alice.writes.n = 0
    for (let i = 0; i < 10; i++) await alice.ok(laptop, "forward", forward("bob/desk/review", `r${i}`))
    expect(alice.writes.n).toBeLessThanOrEqual(5)
    const reserved = () => (alice.db.query(`SELECT sent FROM xcounters`).get() as { sent: number }).sent
    expect(reserved()).toBeGreaterThan(10)
    clock.now += 5 * 60_000
    await alice.hub.alarm(async () => true)
    expect(reserved()).toBe(10)
  })

  test("xinbox bytes count against the account's stored cap, and an endpoint with a full inbox refuses with inbox_full", async () => {
    const { alice, bob, laptop } = await linked({ storedBytes: 4096 })
    await alice.ok(laptop, "forward", forward("bob/desk/review", "a".repeat(1800)))
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "b".repeat(1800)))).toBe("inbox_full")
    expect(bob.xinbox()).toBe(1)
    const den = await bob.bridge("den", [root("impl")])
    expect(await bob.fails(den, "forward", { from: "impl", params: { to: "desk/spare", body: "c".repeat(2000) } })).toBe("too_large")

    const { alice: sender, bob: full, laptop: from } = await linked()
    const insert = full.db.query(
      `INSERT INTO xinbox (id, from_account, client_id, endpoint, sender, message, thread, grant, expires_at, at) VALUES (?, 'usr_z', ?, 'desk/review', 'zed/x/y', '{}', 'thr_z', NULL, ?, ?)`,
    )
    for (let i = 0; i < 1000; i++) insert.run(`msg_full${String(i).padStart(6, "0")}`, `z-${i}`, START + 86_400_000, START)
    expect(await sender.fails(from, "forward", forward("bob/desk/review", "one too many"))).toBe("inbox_full")
    await sender.ok(from, "forward", forward("bob/desk/spare", "another endpoint"))
  })

  test("an acked or expired row stays a day after its receipt; an acked one goes 24 to 48 h after its ack", async () => {
    const { alice, bob, laptop, desk, clock } = await linked()
    const t0 = clock.now
    await alice.ok(laptop, "forward", forward("bob/desk/review", "a", { ttl_s: 60 }))
    await alice.ok(laptop, "forward", forward("bob/desk/spare", "b", { ttl_s: 60 }))
    const [a] = desk.pushes("deliver")
    await bob.ok(desk, "ack", { seqs: [a.seq] })
    clock.now = t0 + 11 * 60_000
    await bob.hub.alarm(async () => true)
    expect(bob.xinbox()).toBe(2)
    clock.now = t0 + 23 * 3_600_000
    await alice.ok(laptop, "forward", forward("bob/desk/review", "c"))
    const c = desk.pushes("deliver").at(-1)
    await bob.ok(desk, "ack", { seqs: [c.seq] })
    clock.now = t0 + 24 * 3_600_000 + 60_000
    await bob.hub.alarm(async () => true)
    expect(bob.db.query(`SELECT seq FROM xinbox`).all()).toEqual([{ seq: c.seq }])
    clock.now = t0 + 47 * 3_600_000 + 60_000
    await bob.hub.alarm(async () => true)
    expect(bob.xinbox()).toBe(0)
  })

  test("two senders of one account with the same client_id both arrive; the same sender's retry dedupes", async () => {
    const { alice, bob, laptop } = await linked()
    const impl = await alice.ok(laptop, "forward", forward("bob/desk/review", "from impl", { client_id: "c-same" }))
    const human = await alice.ok(laptop, "forward", { from: "", tty: false, params: { to: "bob/desk/review", body: "from the human", client_id: "c-same" } })
    expect(human.id).not.toBe(impl.id)
    expect(human.duplicate).toBeUndefined()
    expect(await alice.ok(laptop, "forward", forward("bob/desk/review", "from impl", { client_id: "c-same" }))).toMatchObject({ id: impl.id, duplicate: true })
    expect(bob.xinbox()).toBe(2)
  })

  test("an ack or a reject moves an endpoint's cursor only over the leading run it covers; what is past a gap replays", async () => {
    for (const how of ["ack", "reject"] as const) {
      const { alice, bob, laptop, desk } = await linked()
      bob.disconnect(desk)
      const ids: string[] = []
      for (const body of ["a", "b", "c"]) ids.push((await alice.ok(laptop, "forward", forward("bob/desk/review", body))).id)
      const replay = async () => {
        const socket = bob.connect()
        await bob.ok(socket, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
        await bob.ok(socket, "subscribe", { after: 0 })
        const pushed = socket.pushes("deliver")
        return { socket, ids: pushed.map((p) => p.message.id), seqs: pushed.map((p) => p.seq as number) }
      }
      let last = await replay()
      expect(last.ids).toEqual(ids)
      const [a, b, c] = last.seqs as [number, number, number]
      const done = async (seqs: number[]) => {
        if (how === "ack") await bob.ok(last.socket, "ack", { seqs })
        else for (const seq of seqs) await bob.ok(last.socket, "reject", { seq, code: "policy_refused" })
        last = await replay()
        return last.ids
      }
      expect(await done([c])).toEqual(ids)
      expect(await done([b])).toEqual(ids)
      expect(await done([a])).toEqual(ids.slice(1))
      expect(await done([b, c])).toEqual([])
    }
  })

  test("a queued message from a revoked contact is deleted, and none is replayed while the contact is not active or the contacts are unknown", async () => {
    const { alice, bob, laptop, desk, befriend } = await linked()
    bob.disconnect(desk)
    const sent = await alice.ok(laptop, "forward", forward("bob/desk/review", "queued"))
    const replay = async () => {
      const socket = bob.connect()
      await bob.ok(socket, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
      await bob.ok(socket, "subscribe", { after: 0 })
      return socket.pushes("deliver").map((p) => p.message.id)
    }
    befriend(bob, alice, { dir: "out" })
    expect(await replay()).toEqual([])
    befriend(bob, alice)
    bob.unknown.on = true
    expect(await replay()).toEqual([])
    await bob.hub.xprune()
    expect(bob.xinbox()).toBe(1)
    bob.unknown.on = false
    expect(await replay()).toEqual([sent.id])
    await bob.hub.xprune()
    expect(bob.xinbox()).toBe(1)
    bob.contacts.delete(alice.id)
    await bob.hub.xprune()
    expect(bob.xinbox()).toBe(0)
    befriend(bob, alice)
    expect(await replay()).toEqual([])
  })

  test("a reply grant covers its message's expiry: a tampered or a past expiry is not_found", async () => {
    const { alice, bob, laptop, desk, clock } = await linked()
    const sent = await alice.ok(laptop, "forward", forward("bob/desk/review", "please review", { ttl_s: 60 }))
    const asked = alice.delivered.at(-1)!
    expect(desk.pushes("deliver")).toHaveLength(1)
    const reply = (id: string, extra: Record<string, unknown>) => ({
      ...fromAlice(
        id,
        { to: "laptop/impl", kind: "reply", reply_to: sent.id, hop: 1, thread: asked.thread, expires_at: clock.now + 3_600_000 },
        { account: "bob", address: "bob/desk/review", machine: "desk", rel: "contact:bob" },
      ),
      reply_grant: asked.grant,
      ...extra,
    })
    expect(await code(alice.hub.xreceive(bob.id, reply("msg_tampered01", { reply_grant_expires_at: asked.expires_at + 86_400_000 })))).toBe("not_found")
    expect(await code(alice.hub.xreceive(bob.id, reply("msg_nogrant001", {})))).toBe("not_found")
    clock.now += 2 * 60_000
    expect(await code(alice.hub.xreceive(bob.id, reply("msg_expired001", { reply_grant_expires_at: asked.expires_at })))).toBe("not_found")
    expect(alice.xinbox()).toBe(0)
  })

  test("without a cross-account link, another account's address is not found as before", async () => {
    const { alice, laptop } = await linked({ link: false })
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "x"))).toBe("not_found")
    expect(await code(alice.hub.xreceive("usr_b", {}))).toBe("invalid_params")
  })
})

describe("machine waker for messages from other accounts", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const hibernated = (handle: string) => root(handle, { presence: "hibernated", wake: "hook:vm" })

  async function asleep(options: Options) {
    const env = await linked(options)
    await env.bob.ok(env.desk, "mirror", {
      full: true,
      endpoints: [hibernated("review"), hibernated("spare"), root("lead", { rules: { in: ["tree:descendants"] } })],
    })
    env.bob.disconnect(env.desk)
    return env
  }

  test("off by default: a contact's message to a hibernated endpoint queues and never calls the waker", async () => {
    const events: unknown[] = []
    const { alice, laptop, bob } = await asleep({
      machineWake: async (event) => {
        events.push(event)
        return { ok: true }
      },
    })
    expect((await alice.ok(laptop, "forward", forward("bob/desk/review", "hello"))).deliveries[0].offline).toBe(true)
    await settle()
    expect(events).toEqual([])
    expect(bob.xinbox()).toBe(1)
  })

  test("on, a contact's message wakes it only after the scope, scrubber and gate checks pass, metadata only, and shows it waking", async () => {
    const events: any[] = []
    const { alice, bob, laptop } = await asleep({
      machineWake: async (event) => {
        events.push(event)
        return { ok: true }
      },
      wake: { crossAccount: true },
    })
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", `here: scp_${"z".repeat(24)}`))).toBe("secret_refused")
    expect(await alice.fails(laptop, "forward", forward("bob/desk/lead", "not on its in lists"))).toBe("not_found")
    bob.gate.ingressVerdict = { verdict: "refuse", code: "policy_refused", categories: ["x"] }
    expect(await alice.fails(laptop, "forward", forward("bob/desk/review", "refused"))).toBe("policy_refused")
    bob.gate.ingressVerdict = { verdict: "hold", hold_id: "hld_1" }
    await alice.ok(laptop, "forward", forward("bob/desk/review", "UNIQUE-XACCT-BODY"))
    await settle()
    expect(events).toEqual([])
    const held = bob.gate.calls.at(-1)!.msg
    await bob.hub.xrelease({ side: "ingress", hold_id: "hld_1", from_account: alice.id, message: held })
    await settle()
    expect(events).toEqual([
      {
        scp: 1,
        event: "machine_wake",
        account: "bob",
        machine: "desk",
        endpoints: ["bob/desk/review"],
        message: { id: held.id, from: "alice/laptop/impl", kind: "message", thread: held.thread, created_at: expect.any(String) },
        from_account: "alice",
        same_account: false,
      },
    ])
    expect(JSON.stringify(events)).not.toContain("UNIQUE-XACCT-BODY")
    const cli = bob.connect()
    await bob.ok(cli, "hello", { protocol: PROTOCOL, machine: "ci", claim: { handle: "impl" } })
    const listed = (await bob.ok(cli, "list", {})).endpoints.find((e: any) => e.address === "bob/desk/review")
    expect(listed).toMatchObject({ presence: "hibernated", waking: true })
  })

  test("a contact's queued message wakes the machine once its hold clears, after a restart too; with cross-account wakes off it never does", async () => {
    const events: any[] = []
    const answers = [{ ok: false, declined: "budget" }]
    const machineWake = async (event: any) => {
      events.push(event)
      return answers.shift() ?? { ok: true }
    }
    const on = await asleep({ machineWake, wake: { crossAccount: true } })
    const sent = await on.alice.ok(on.laptop, "forward", forward("bob/desk/review", "one"))
    await settle()
    expect(events.length).toBe(1)
    on.bob.wake()
    expect(on.bob.hub.clearWakeHold("desk")).toBe(1)
    await settle()
    expect(events.map((e) => [e.message.id, e.same_account])).toEqual([
      [sent.id, false],
      [sent.id, false],
    ])

    events.length = 0
    const off = await asleep({ machineWake })
    await off.alice.ok(off.laptop, "forward", forward("bob/desk/review", "one"))
    off.bob.db.query(`INSERT INTO machine_wakes (machine, next, fails) VALUES ('desk', 0, 0)`).run()
    expect(off.bob.hub.clearWakeHold("desk")).toBe(1)
    await settle()
    expect(events).toEqual([])
    expect(off.bob.xinbox()).toBe(1)
  })

  test("a sender account and a target each cause at most their per-hour wakes; Infinity lifts a cap", async () => {
    const events: any[] = []
    const machineWake = async (event: any) => {
      events.push(event)
      return { ok: true }
    }
    const sender = await asleep({ machineWake, wake: { crossAccount: true, senderAccountPerHour: 2, targetPerHour: Number.POSITIVE_INFINITY } })
    for (const body of ["one", "two", "three"]) {
      await sender.alice.ok(sender.laptop, "forward", forward("bob/desk/review", body))
      await settle()
      sender.clock.now += 61_000
    }
    expect(events.length).toBe(2)
    sender.clock.now += 3_600_000
    await sender.alice.ok(sender.laptop, "forward", forward("bob/desk/review", "next hour"))
    await settle()
    expect(events.length).toBe(3)

    events.length = 0
    const held = await asleep({ machineWake, wake: { crossAccount: true, senderAccountPerHour: 2, wakingTimeoutS: 60 } })
    const send = async (body: string, extra: Record<string, unknown> = {}) => {
      await held.alice.ok(held.laptop, "forward", forward("bob/desk/review", body, extra))
      await settle()
    }
    await send("one", { client_id: "dup" })
    await send("one again", { client_id: "dup" })
    await send("while waking")
    expect(events.length).toBe(1)
    held.clock.now += 61_000
    await send("after the timeout")
    expect(events.length).toBe(2)

    events.length = 0
    const target = await asleep({ machineWake, wake: { crossAccount: true, senderAccountPerHour: Number.POSITIVE_INFINITY, targetPerHour: 1 } })
    for (const to of ["bob/desk/review", "bob/desk/review", "bob/desk/spare"]) {
      await target.alice.ok(target.laptop, "forward", forward(to, "x"))
      await settle()
      target.clock.now += 61_000
    }
    expect(events.map((e) => e.endpoints[0])).toEqual(["bob/desk/review", "bob/desk/spare"])
  })
})

describe("a broker's side of cross-account messages", () => {
  function broker() {
    const db = new Database(":memory:")
    const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
    const core = new FederatedCore(sql, { machine: "laptop", aliases: ["alice"], now: () => START, hash, transaction: (fn) => db.transaction(fn)() })
    core.migrate()
    return core
  }

  const envelope = (from: { [K in keyof Envelope["from"]]?: Envelope["from"][K] | undefined }, extra: Partial<Envelope> = {}): Envelope => ({
    id: `msg_${Math.random().toString(36).slice(2, 12)}`,
    thread: "thr_x",
    reply_to: null,
    kind: "message",
    from: {
      address: "bob/desk/review",
      endpoint: "bob/desk/review",
      user: "bob",
      auth: "contact",
      machine: "desk",
      claims: { harness: "codex", model: null },
      rel: "contact:bob",
      account: "bob",
      ...from,
    } as Envelope["from"],
    to: "alice/laptop/impl",
    body: { text: "hi", mime: "text/markdown" },
    data_class: "public",
    attachments: [],
    hop: 0,
    created_at: new Date(START).toISOString(),
    expires_at: new Date(START + 60_000).toISOString(),
    ...extra,
  })

  test("another account's address is remote and forwarded as written; it never resolves to a local row", () => {
    const core = broker()
    const impl = core.claim({ handle: "impl", harness: "claude-code" }).endpoint.id
    expect(core.route("bob/desk/review")).toBe("bob/desk/review")
    expect(core.isRemote("bob/desk/review")).toBe(true)
    expect(core.foreignAccount("bob/desk/me")).toEqual({ account: "bob", machine: "desk", handle: "" })
    for (const address of ["alice/desk/review", "me/desk/review", "bob/desk/Bad", "Bob/desk/review", "bob/desk/review/x"])
      expect(core.foreignAccount(address)).toBeNull()
    expect(code(() => core.send(impl, { to: "bob/desk/review", body: "x" }))).toBe("not_found")
  })

  test("the sender's out lists must name acct:, unless it replies to a message it got from exactly that address", () => {
    const core = broker()
    const open = core.claim({ handle: "open", harness: "claude-code" }).endpoint.id
    const fenced = core.claim({ handle: "fenced", harness: "claude-code", scope: "tree" }).endpoint.id
    expect(code(() => core.scopeCheck(open, "bob/desk/review"))).toBeUndefined()
    expect(code(() => core.scopeCheck(fenced, "bob/desk/review"))).toBe("not_found")
    const got = envelope({}, { to: "alice/laptop/fenced" })
    expect(code(() => core.inboundRefusal(fenced, got))).toBe("not_found")
    core.rulesSet({ kind: "endpoint", id: fenced, auth: "session" }, { in: ["tree:descendants", "acct:bob"] })
    expect(core.inboundRefusal(fenced, got)).toBeNull()
    core.admit(fenced, got)
    expect(code(() => core.scopeCheck(fenced, "bob/desk/review"))).toBe("not_found")
    expect(code(() => core.scopeCheck(fenced, "bob/desk/review", got.id))).toBeUndefined()
    expect(code(() => core.scopeCheck(fenced, "bob/desk/lead", got.id))).toBe("not_found")
    core.rulesSet({ kind: "endpoint", id: fenced, auth: "session" }, { out: ["tree:descendants", "acct:bob"] })
    expect(code(() => core.scopeCheck(fenced, "bob/desk/lead"))).toBeUndefined()
    expect(code(() => core.scopeCheck(fenced, "carol/desk/lead"))).toBe("not_found")
  })

  test("a delivery from another account passes the recipient's in lists by acct:, or as the reply to its own message", () => {
    const core = broker()
    const fenced = core.claim({ handle: "fenced", harness: "claude-code", scope: "tree" }).endpoint.id
    expect(code(() => core.inboundRefusal(fenced, envelope({})))).toBe("not_found")
    const params = { to: "bob/desk/review", body: "review this", kind: "request" as const }
    const ask = { id: "msg_ask0000001", thread: "thr_ask", hop: 0, deliveries: [] }
    core.recordForward(fenced, params, ask)
    const reply = envelope({}, { kind: "reply", reply_to: ask.id, thread: "thr_ask", hop: 1 })
    expect(core.inboundRefusal(fenced, reply)).toBeNull()
    expect(
      code(() => core.inboundRefusal(fenced, envelope({ address: "bob/desk/lead", endpoint: "bob/desk/lead" }, { kind: "reply", reply_to: ask.id }))),
    ).toBe("not_found")
    core.admit(fenced, reply)
    expect(core.replyTo(fenced, ask.id)?.from).toMatchObject({ address: "bob/desk/review", auth: "contact", account: "bob", rel: "contact:bob", user: "bob" })
  })

  test("a sender of another account is a stand-in no list shows, the human at its terminal is <account>/me, and the policy sees acct:", () => {
    const core = broker()
    const impl = core.claim({ handle: "impl", harness: "claude-code" }).endpoint.id
    const human = envelope({ address: "bob/me", endpoint: "bob/me", human: true, claims: { harness: "human", model: null } })
    core.admit(impl, human)
    const [got] = core.inbox(impl)
    expect(got!.from).toMatchObject({ address: "bob/me", human: true, account: "bob", auth: "contact" })
    expect(core.list({ all: true }).map((e) => e.address)).not.toContain("bob/me")
    expect(code(() => core.admit(impl, envelope({ address: "bob/me", endpoint: "bob/me" })))).toBe("invalid_params")
    expect(code(() => core.admit(impl, envelope({ address: "carol/desk/x", endpoint: "carol/desk/x" })))).toBe("invalid_params")
    expect(code(() => core.admit(impl, envelope({ address: "alice/desk/x", endpoint: "alice/desk/x", account: "alice", user: "alice" })))).toBe(
      "invalid_params",
    )
    core.setPolicy({ rules: [{ match: "ep:impl", accept_from: ["fleet:*", "*"] }] })
    expect(core.inboundRefusal(impl, envelope({}))).toContain("accept_from")
    core.setPolicy({ rules: [{ match: "ep:impl", accept_from: ["acct:bob"] }] })
    expect(core.inboundRefusal(impl, envelope({}))).toBeNull()
    expect(core.checkPolicy("alice/impl", "bob/desk/review")).toBeNull()
    core.setPolicy({ rules: [{ match: "ep:impl", send_to: ["*"] }] })
    expect(core.checkPolicy("alice/impl", "bob/desk/review")).toContain("send_to")
  })

  test("another account's human, <account>/me, is refused as a target, never read as a machine of this account", () => {
    const core = broker()
    const impl = core.claim({ handle: "impl", harness: "claude-code" }).endpoint.id
    core.admit(impl, envelope({ address: "bob/me", endpoint: "bob/me", human: true, claims: { harness: "human", model: null } }))
    expect(code(() => core.route("bob/me"))).toBe("invalid_params")
    expect(core.isRemote("bob/me")).toBe(false)
    expect(code(() => core.send(impl, { to: "bob/me", body: "back" }))).toBe("invalid_params")
    expect(core.route("desk/me")).toBe("desk/")
  })

  test("a cross-account sender renders with its account; a same-account one renders as before", () => {
    const xacct = wrapMessage(envelope({}))
    expect(xacct).toContain(`from="bob/desk/review" account="bob" contact="true" harness="codex" auth="contact"`)
    const same = wrapMessage(envelope({ address: "alice/desk/review", auth: "account+bridge", account: undefined, rel: undefined, user: "alice" }))
    expect(same).not.toContain("account=")
    expect(same).not.toContain("contact=")
  })
})

function code(fn: () => unknown): string | undefined
function code(promise: Promise<unknown>): Promise<string | undefined>
function code(arg: (() => unknown) | Promise<unknown>): string | undefined | Promise<string | undefined> {
  const of = (error: unknown) => {
    if (error instanceof RelayError) return error.code
    throw error
  }
  if (typeof arg === "function") {
    try {
      arg()
    } catch (error) {
      return of(error)
    }
    return undefined
  }
  return arg.then(() => undefined, of)
}

describe("a mirrored endpoint's new holder at the hub", () => {
  const holder = (id: string, epoch = 0) => `${id.repeat(24)}.${epoch}`
  /** desk's bridge back after a gap, mirroring review under `incarnation`, then subscribed: the message ids it replays */
  const back = async (bob: Account, incarnation: string) => {
    const socket = bob.connect()
    await bob.ok(socket, "hello", { protocol: PROTOCOL, machine: "desk", bridge: true })
    await bob.ok(socket, "mirror", { endpoints: [root("review", { incarnation })] })
    await bob.ok(socket, "subscribe", { after: 0 })
    return { socket, replayed: socket.pushes("deliver").map((p) => p.message.id as string) }
  }
  const resets = (bob: Account) =>
    (bob.db.query(`SELECT detail FROM audit WHERE event = 'mirror_reset'`).all() as { detail: string }[]).map((row) => JSON.parse(row.detail))

  test("a new holder drops the cross-account mail queued for the earlier one, which never replays; the next message reaches it", async () => {
    const { alice, bob, laptop, desk } = await linked()
    await bob.ok(desk, "mirror", { endpoints: [root("review", { incarnation: holder("a") })] })
    bob.disconnect(desk)
    await alice.ok(laptop, "forward", forward("bob/desk/review", "for the earlier holder"))
    const { seq } = bob.db.query(`SELECT seq FROM xinbox`).get() as { seq: number }
    const { socket, replayed } = await back(bob, holder("b"))
    expect(replayed).toEqual([])
    expect(bob.xinbox()).toBe(0)
    expect(resets(bob)).toEqual([{ target: "desk/review", xinbox: 1, deliveries: 0 }])
    const next = await alice.ok(laptop, "forward", forward("bob/desk/review", "for the new holder"))
    expect(socket.pushes("deliver").map((p) => p.message.id)).toEqual([next.id])
    expect(socket.pushes("deliver")[0].seq).toBeGreaterThan(seq)
  })

  test("an epoch-only change, or a first new-format incarnation after an old one, keeps the queued mail", async () => {
    for (const [before, after] of [
      [holder("a"), holder("a", 1)],
      ["c".repeat(32), holder("a")],
    ]) {
      const { alice, bob, laptop, desk } = await linked()
      await bob.ok(desk, "mirror", { endpoints: [root("review", { incarnation: before })] })
      bob.disconnect(desk)
      const queued = await alice.ok(laptop, "forward", forward("bob/desk/review", "kept"))
      expect((await back(bob, after!)).replayed).toEqual([queued.id])
      expect(resets(bob)).toEqual([])
    }
  })

  test("a new holder drops the same-account deliveries the hub queued for the earlier one", async () => {
    const { bob, desk } = await linked()
    await bob.ok(desk, "mirror", { endpoints: [root("review", { incarnation: holder("a") })] })
    bob.disconnect(desk)
    const den = await bob.bridge("den", [root("impl")])
    const sent = await bob.ok(den, "forward", { from: "impl", params: { to: "desk/review", body: "same account" } })
    expect(sent.deliveries).toHaveLength(1)
    expect((await back(bob, holder("b"))).replayed).toEqual([])
    expect(resets(bob)).toEqual([{ target: "desk/review", xinbox: 0, deliveries: 1 }])
  })
})
