import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore, subagentHandle } from "./core"
import { shortId, wrapMessage } from "./render"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import type { Sql, SqlValue } from "./sql"

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const HUMAN: ScopeActor = { kind: "human", tty: true }
const AGENT = "aceb553c19f223c70"

function setup() {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  })
  core.migrate()
  /** the root's hook claim from claude-code process `pid` */
  const hook = (pid: number, extra: Record<string, unknown> = {}) =>
    core.claim(
      { handle: "claude-app", harness: "claude-code", process: key(pid), session: key(pid), lineage: [key(pid), key(1)], ...extra },
      { transient: true },
    )
  const resets = () => core.log({ scope: true }).filter((row) => row.event === "scope_reset")
  return { core, clock, db, hook, resets }
}

function failure(fn: () => unknown): RelayError {
  try {
    fn()
  } catch (error) {
    if (error instanceof RelayError) return error
    throw error
  }
  throw new Error("no error")
}

describe("subagent endpoints", () => {
  test("a hook of the root's own process claims a child endpoint under the root, named for the subagent, rejoined by its session", () => {
    const { core, hook } = setup()
    const root = hook(9).endpoint
    const sub = hook(9, { subagent: { id: AGENT, type: "general-purpose" } })
    expect(sub).toMatchObject({ subagent: true, created: true })
    expect(sub.endpoint.address).toBe("me/claude-app-gp-aceb")
    expect(sub.endpoint).toMatchObject({ parent: root.address, depth: 1, harness: "claude-code" })
    const again = hook(9, { subagent: { id: AGENT, type: "general-purpose" } })
    expect(again.endpoint.id).toBe(sub.endpoint.id)
    expect(again.created).toBeUndefined()
    expect(hook(9).endpoint.id).toBe(root.id)
    expect(core.placeLineage([key(30), key(9)])).toBe(root.id)
    expect(core.placeLineage([key(30), key(9)], sub.endpoint.address.slice(3))).toBe(sub.endpoint.id)
    const audit = core.log({}).find((row) => row.event === "claim" && row.detail.handle === "claude-app-gp-aceb")
    expect(audit?.detail).toMatchObject({ subagent: "general-purpose", parent: root.address, transient: true })
  })

  test("the root's hooks never take the child's messages, and the child's take only its own", () => {
    const { core, hook } = setup()
    const root = hook(9).endpoint
    const sub = hook(9, { subagent: { id: AGENT, type: "Explore" } }).endpoint
    const peer = core.claim({ handle: "peer", harness: "codex" }).endpoint
    core.rulesSet(HUMAN, { endpoint: "peer", out: ["*"] })
    core.send(peer.id, { to: sub.address, body: "for the subagent" })
    core.send(peer.id, { to: root.address, body: "for the root" })
    expect(core.inject(root.id, { transient: true, process: key(9) }).messages.map((m) => m.body.text)).toEqual(["for the root"])
    expect(core.inject(sub.id, { transient: true, process: key(9) }).messages.map((m) => m.body.text)).toEqual(["for the subagent"])
    const fromRoot = core.send(root.id, { to: sub.address, body: "do this" })
    expect(core.delivered(sub.id, fromRoot.id)?.relation).toBe("parent")
  })

  test("a subagent claim from any other process, without a hook connection or with no lineage endpoint is refused and audited", () => {
    const { core, hook } = setup()
    hook(9)
    const sub = { subagent: { id: AGENT, type: "Explore" } }
    expect(failure(() => hook(9, { ...sub, process: key(8) })).code).toBe("unauthorized")
    expect(failure(() => core.claim({ handle: "x", harness: "claude-code", process: key(9), lineage: [key(9)], ...sub })).code).toBe("unauthorized")
    expect(failure(() => core.claim({ handle: "x", harness: "claude-code", process: key(7), lineage: [key(7)], ...sub }, { transient: true })).code).toBe(
      "unauthorized",
    )
    expect(failure(() => hook(9, { ...sub, harness: "codex" })).code).toBe("unauthorized")
    expect(failure(() => hook(9, { subagent: { id: "../x" } })).code).toBe("invalid_params")
    expect(
      core.log({ scope: true }).filter((row) => row.event === "scope_refused" && row.detail.reason === "subagent claim from another process"),
    ).toHaveLength(4)
    expect(core.list({ all: true }).filter((e) => e.kind === "agent")).toHaveLength(1)
  })

  test("a spawned root's subagent never takes the grant the spawner bound to its process", () => {
    const { core } = setup()
    const lead = core.claim({ handle: "lead", harness: "codex", process: key(2), lineage: [key(2)] }).endpoint
    const { token } = core.grant({ kind: "endpoint", id: lead.id, auth: "session" }, { name: "w1", bind_process: key(5) })
    const lineage = [key(9), key(5), key(2)]
    const worker = core.claim({ handle: "claude-x", harness: "claude-code", process: key(9), session: key(9), lineage }, { transient: true }).endpoint
    expect(worker).toMatchObject({ address: "me/w1", parent: "me/lead" })
    expect(token).toStartWith("krt_")
    const sub = core.claim(
      { handle: "claude-x", harness: "claude-code", process: key(9), session: key(9), lineage, subagent: { id: AGENT } },
      { transient: true },
    ).endpoint
    expect(sub).toMatchObject({ address: "me/w1-agent-aceb", parent: "me/w1", depth: 2 })
  })

  test("a stop's claim takes only an endpoint the subagent already has; a tool claim after done resumes it working", () => {
    const { core, hook } = setup()
    hook(9)
    const stop = { subagent: { id: AGENT, type: "Explore", stop: true } }
    expect(failure(() => hook(9, stop)).code).toBe("not_found")
    expect(core.list({ all: true }).filter((e) => e.kind === "agent")).toHaveLength(1)
    const sub = hook(9, { subagent: { id: AGENT, type: "Explore" } }).endpoint
    expect(hook(9, stop).endpoint.id).toBe(sub.id)
    core.status(sub.id, "done", undefined)
    core.disconnect(sub.id)
    expect(hook(9, stop).endpoint.status?.state).toBe("done")
    expect(hook(9, { subagent: { id: AGENT, type: "Explore" } }).endpoint.status?.state).toBe("working")
    expect(core.whoami(sub.id).status?.state).toBe("working")
  })

  test("local agents count the root's subagents that are neither done nor historic", () => {
    const { core, clock, hook } = setup()
    const root = hook(9).endpoint
    const sub = hook(9, { subagent: { id: AGENT, type: "Explore" } }).endpoint
    hook(9, { subagent: { id: "f00d42", type: "Explore" } })
    const facts = () => core.localAgents().find((agent) => agent.id === root.id)!
    expect(facts()).toMatchObject({ children: 0, subagents: 2 })
    core.status(sub.id, "done", undefined)
    expect(facts().subagents).toBe(1)
    clock.now += LIMITS.historicAfterS * 1000
    expect(facts().subagents).toBe(0)
  })

  test("the derived handle stays valid and leaves room for a suffix", () => {
    const long = subagentHandle("a".repeat(63), { id: AGENT, type: "Some Plugin:Very-Long-Agent-Type-Name" })
    expect(long.length).toBeLessThanOrEqual(58)
    expect(long).toEndWith("a-some-aceb")
    expect(subagentHandle("app", { id: "ABC_def12" })).toBe("app-agent-abcd")
    const kinds = ["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "codeReviewer", "x".repeat(40)]
    expect(kinds.map((type) => subagentHandle("app", { id: AGENT, type }))).toEqual([
      "app-gp-aceb",
      "app-explore-aceb",
      "app-plan-aceb",
      "app-statusline-aceb",
      "app-claude-aceb",
      "app-code-aceb",
      `app-${"x".repeat(16)}-aceb`,
    ])
  })

  test("a new subagent is named for its parent's current handle, after a rename or a join that names the session", () => {
    const { core, hook } = setup()
    const root = hook(9).endpoint
    const before = hook(9, { subagent: { id: AGENT, type: "Explore" } }).endpoint
    core.rename({ kind: "endpoint", id: root.id, auth: "session" }, { handle: "lead" })
    expect(hook(9, { subagent: { id: "b107cb", type: "Explore" } }).endpoint).toMatchObject({ address: "me/lead-explore-b107", parent: "me/lead" })
    core.joinSession({ handle: "claude-app", harness: "claude-code", process: key(9), session: key(9), lineage: [key(9), key(1)] }, "chief")
    expect(hook(9, { subagent: { id: "c107cb", type: "Plan" } }).endpoint.address).toBe("me/chief-plan-c107")
    expect(core.whoami(before.id).address).toBe("me/claude-app-explore-aceb")
  })

  test("a subagent whose short handle another's offline endpoint holds gets a suffix instead of taking it over", () => {
    const { core, hook, clock } = setup()
    hook(9)
    const first = hook(9, { subagent: { id: "aceb01", type: "Explore" } }).endpoint
    const peer = core.claim({ handle: "peer", harness: "codex" }).endpoint.id
    core.rulesSet(HUMAN, { endpoint: "peer", out: ["*"] })
    core.send(peer, { to: first.address, body: "for the first" })
    clock.now += 3600_000
    hook(9)
    const second = hook(9, { subagent: { id: "aceb02", type: "Explore" } }).endpoint
    expect(second).toMatchObject({ address: "me/claude-app-explore-aceb-2" })
    expect(second.id).not.toBe(first.id)
    expect(hook(9, { subagent: { id: "aceb01", type: "Explore" } }).endpoint.id).toBe(first.id)
  })
})

describe("subagent titles", () => {
  const HOOK = { transient: true, process: key(9) }

  test("the parent's description titles the subagent: at once when its endpoint exists, else at its first claim", () => {
    const { core, hook } = setup()
    const root = hook(9).endpoint
    const sub = hook(9, { subagent: { id: AGENT, type: "Explore" } }).endpoint
    expect(core.subagentTitle(root.id, { id: AGENT, title: "Map the\nbroker" }, HOOK)).toBe(sub.id)
    expect(core.whoami(sub.id).title).toBe("Map the broker")
    expect(core.subagentTitle(root.id, { id: "f00d42", title: "Review the parser" }, HOOK)).toBeNull()
    const later = hook(9, { subagent: { id: "f00d42", type: "general-purpose" } }).endpoint
    expect(later).toMatchObject({ address: "me/claude-app-gp-f00d", title: "Review the parser" })
    expect(hook(9).endpoint.title).toBeNull()
  })

  test("it never replaces a title set explicitly, which still replaces it; a secret, another process or another parent's subagent sets nothing", () => {
    const { core, hook } = setup()
    const root = hook(9).endpoint
    const sub = hook(9, { subagent: { id: AGENT, type: "Explore" } }).endpoint
    core.subagentTitle(root.id, { id: AGENT, title: "inferred" }, HOOK)
    core.title(sub.id, "mine")
    expect(core.subagentTitle(root.id, { id: AGENT, title: "inferred again" }, HOOK)).toBeNull()
    expect(core.whoami(sub.id).title).toBe("mine")
    core.title(sub.id, "")
    expect(core.subagentTitle(root.id, { id: AGENT, title: `deploy with ghp_${"A1b2C3d4".repeat(5)}` }, HOOK)).toBe(sub.id)
    expect(core.whoami(sub.id).title).not.toContain("ghp_")
    core.subagentTitle(root.id, { id: "beef01", title: "early" }, HOOK)
    const early = hook(9, { subagent: { id: "beef01" } }).endpoint
    core.title(early.id, "explicit")
    expect(core.whoami(early.id).title).toBe("explicit")
    expect(core.subagentTitle(root.id, { id: AGENT, title: "from elsewhere" }, { transient: true, process: key(8) })).toBeNull()
    const other = core.claim({ handle: "other", harness: "claude-code", process: key(7), session: key(7), lineage: [key(7)] }, { transient: true }).endpoint
    expect(core.subagentTitle(other.id, { id: AGENT, title: "not mine" }, { transient: true, process: key(7) })).toBeNull()
    expect(core.whoami(sub.id).title).not.toBe("not mine")
    expect(failure(() => core.subagentTitle(root.id, { id: "../x", title: "x" }, HOOK)).code).toBe("invalid_params")
  })
})

describe("--as from inside the tree", () => {
  /** an --as claim from a shell whose process walk is `lineage` (pids, nearest first), its nearest harness the `harness`-th of them */
  const as = (core: RelayCore, handle: string, lineage: number[], harness = 1) =>
    core.claim({ handle, exact: true, harness: "cli", cwd: "/w", lineage: lineage.map(key) }, { self: lineage.slice(0, harness + 1).map(key) }).endpoint

  test("a child endpoint --as claims again and again from the root's own shells keeps its state and logs no reset", () => {
    const { core, hook, resets } = setup()
    const root = hook(9).endpoint
    const first = as(core, "kid", [30, 9])
    expect(first.parent).toBe(root.address)
    core.status(first.id, "working", "on it")
    core.group({ kind: "endpoint", id: first.id, auth: "session" }, { action: "create", name: "kq" })
    core.disconnect(first.id)
    const second = as(core, "kid", [31, 9])
    core.disconnect(second.id)
    expect(as(core, "kid", [32, 9]).id).toBe(first.id)
    expect(core.whoami(first.id).status).toMatchObject({ state: "working", note: "on it" })
    expect(core.group(HUMAN, { action: "show", name: "kq" })).toMatchObject({ owner: "me/kid" })
    expect(resets()).toEqual([])
  })

  test("from the shell of a harness the root started, with the root's process only further up, the --as child resets; a claim without its walk too", () => {
    const { core, hook, resets } = setup()
    hook(9)
    const kid = as(core, "kid", [30, 9])
    core.group({ kind: "endpoint", id: kid.id, auth: "session" }, { action: "create", name: "kq" })
    core.disconnect(kid.id)
    expect(as(core, "kid", [35, 20, 15, 9]).id).toBe(kid.id)
    expect(resets().map((row) => [row.detail.target, row.detail.reason])).toEqual([["me/kid", "another process took over the endpoint"]])
    expect(core.group(HUMAN, { action: "show", name: "kq" })).not.toMatchObject({ owner: "me/kid" })
    core.disconnect(kid.id)
    expect(core.claim({ handle: "kid", exact: true, harness: "cli", lineage: [key(36), key(9)] }).endpoint.id).toBe(kid.id)
    expect(resets()).toHaveLength(2)
    core.disconnect(kid.id)
    expect(core.claim({ handle: "kid", exact: true, harness: "cli", lineage: [key(37), key(9)] }, { self: [key(38), key(9)] }).endpoint.id).toBe(kid.id)
    expect(resets()).toHaveLength(3)
  })

  test("a worker the root spawned, from its own shell, never takes the root or the root's --as child: refused, nothing reset", () => {
    const { core, hook, resets } = setup()
    const root = hook(9).endpoint
    const kid = as(core, "kid", [30, 9])
    core.disconnect(kid.id)
    core.claim({ handle: "w", harness: "codex", process: key(20), lineage: [key(20), key(15), key(9)] })
    expect(failure(() => as(core, "kid", [50, 20, 15, 9])).code).toBe("unauthorized")
    expect(failure(() => as(core, "claude-app", [50, 20, 15, 9])).code).toBe("unauthorized")
    expect(failure(() => as(core, "claude-app", [51, 21, 9])).code).toBe("unauthorized")
    expect(core.whoami(root.id).address).toBe("me/claude-app")
    expect(resets()).toEqual([])
  })

  test("a genuinely different process still resets: a root --as endpoint, and a worker process's endpoint taken from its parent's shell", () => {
    const { core, hook, resets } = setup()
    const solo = as(core, "solo", [50])
    core.disconnect(solo.id)
    expect(as(core, "solo", [60]).id).toBe(solo.id)
    const root = hook(9).endpoint
    const w = core.claim({ handle: "w", harness: "cli", process: key(40), lineage: [key(40), key(9)] }).endpoint
    expect(w.parent).toBe(root.address)
    core.disconnect(w.id)
    expect(as(core, "w", [33, 9]).id).toBe(w.id)
    expect(resets().map((row) => row.detail.target)).toEqual(["me/solo", "me/w"])
    core.disconnect(w.id)
    expect(as(core, "w", [34, 9]).id).toBe(w.id)
    expect(resets()).toHaveLength(2)
  })
})

describe("message ids", () => {
  /** gives a delivered message the id `id`, so a test can make suffixes collide */
  const rename = (db: Database, from: string, to: string) => {
    db.query(`UPDATE messages SET id = ? WHERE id = ?`).run(to, from)
    db.query(`UPDATE deliveries SET message_id = ? WHERE message_id = ?`).run(to, from)
  }

  test("last is the newest message the caller was shown, read or injected; a newer unseen one refuses, naming its sender", () => {
    const { core } = setup()
    const a = core.claim({ handle: "a", harness: "codex" }).endpoint
    const b = core.claim({ handle: "b", harness: "codex" }).endpoint
    const c = core.claim({ handle: "c", harness: "codex" }).endpoint
    expect(core.delivered(b.id, "last")).toBeNull()
    const one = core.send(a.id, { to: "b", body: "one" })
    const unseen = failure(() => core.delivered(b.id, "last"))
    expect(unseen.code).toBe("invalid_params")
    expect(unseen.message).toBe(`a newer message arrived from me/a (${shortId(one.id)}); read it first or name the id`)
    core.ack(
      b.id,
      core.inbox(b.id).map((m) => m.seq),
    )
    expect(core.delivered(b.id, "last")?.id).toBe(one.id)
    const two = core.send(c.id, { to: "b", body: "two" })
    expect(failure(() => core.delivered(b.id, "last")).message).toContain("from me/c")
    const { offered, hold } = core.inject(b.id)
    core.injected(offered, hold)
    expect(core.delivered(b.id, "last")?.id).toBe(two.id)
    expect(core.delivered(b.id, one.id)?.id).toBe(one.id)
  })

  test("a short id, the id's last 6 characters, or any unique suffix of 4 or more resolves within the caller's messages; an ambiguous one refuses", () => {
    const { core, db } = setup()
    const a = core.claim({ handle: "a", harness: "codex" }).endpoint
    const b = core.claim({ handle: "b", harness: "codex" }).endpoint
    const c = core.claim({ handle: "c", harness: "codex" }).endpoint
    const one = core.send(a.id, { to: "b", body: "one" })
    const two = core.send(a.id, { to: "b", body: "two" })
    const other = core.send(a.id, { to: "c", body: "other" })
    expect(shortId(one.id)).toBe(one.id.slice(-6))
    expect(core.delivered(b.id, shortId(one.id))?.id).toBe(one.id)
    expect(core.delivered(b.id, two.id.slice(-9))?.id).toBe(two.id)
    expect(core.delivered(b.id, shortId(other.id))).toBeNull()
    expect(core.delivered(c.id, shortId(other.id))?.id).toBe(other.id)
    expect(core.delivered(b.id, one.id.slice(-3))).toBeNull()
    expect(core.delivered(b.id, one.id.slice(4, 12))).toBeNull()
    rename(db, one.id, "msg_0000000000aaaaaaaaaaaaaa1234")
    rename(db, two.id, "msg_0000000000bbbbbbbbbbbbbb1234")
    const ambiguous = failure(() => core.delivered(b.id, "1234"))
    expect(ambiguous.code).toBe("invalid_params")
    expect(ambiguous.message).toContain("bb1234 (msg_0000000000bbbbbbbbbbbbbb1234), aa1234 (msg_0000000000aaaaaaaaaaaaaa1234)")
    expect(core.delivered(b.id, "a1234")?.id).toBe("msg_0000000000aaaaaaaaaaaaaa1234")
  })

  test("all digits are a seq of the caller's or a short id: both at once, for two messages, refuses", () => {
    const { core, db } = setup()
    const a = core.claim({ handle: "a", harness: "codex" }).endpoint
    const b = core.claim({ handle: "b", harness: "codex" }).endpoint
    const one = core.send(a.id, { to: "b", body: "one" })
    const two = core.send(a.id, { to: "b", body: "two" })
    const [first, second] = core.inbox(b.id)
    expect(core.delivered(b.id, String(first!.seq))?.id).toBe(one.id)
    rename(db, two.id, "msg_0000000000cccccccccccc424242")
    expect(core.delivered(b.id, "424242")?.body.text).toBe("two")
    const seq = String(second!.seq).padStart(6, "0")
    rename(db, one.id, `msg_0000000000dddddddddddd${seq}`)
    const both = failure(() => core.delivered(b.id, seq))
    expect(both.message).toBe(`${seq} is the seq of one message and the short id of another (${seq}); give the full id`)
  })
})

describe("group names", () => {
  test("creating a group under a taken name names its owner where the caller sees it, else another endpoint", () => {
    const { core } = setup()
    const a = core.claim({ handle: "a", harness: "codex", process: key(2), lineage: [key(2)] }).endpoint
    const kid = core.claim({ handle: "kid", harness: "codex", process: key(3), lineage: [key(3), key(2)] }).endpoint
    const loner = core.claim({ handle: "loner", harness: "codex", process: key(4), lineage: [key(4)] }).endpoint
    core.rulesSet({ kind: "endpoint", id: loner.id, auth: "session" }, { scope: "none" })
    core.group({ kind: "endpoint", id: a.id, auth: "session" }, { action: "create", name: "team" })
    expect(failure(() => core.group(HUMAN, { action: "create", name: "team" })).message).toBe("group team is owned by me/a; pick another name")
    expect(failure(() => core.group({ kind: "endpoint", id: kid.id, auth: "session" }, { action: "create", name: "team" })).message).toBe(
      "group team is owned by me/a; pick another name",
    )
    expect(failure(() => core.group({ kind: "endpoint", id: loner.id, auth: "session" }, { action: "create", name: "team" })).message).toBe(
      "group team is owned by another endpoint; pick another name",
    )
  })
})

describe("a spawn's prompt", () => {
  test("with peek on, the grant's prompt, scrubbed, is the worker's first peek turn once it joins; with peek off nothing is kept; a spent grant drops it", () => {
    const { core, db } = setup()
    const lead = core.claim({ handle: "lead", harness: "codex", process: key(2), lineage: [key(2)] }).endpoint
    const actor: ScopeActor = { kind: "endpoint", id: lead.id, auth: "session" }
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`
    const on = core.grant(actor, { name: "w1", peek: "local", prompt: `fix the parser, token ${secret}` }).token
    const off = core.grant(actor, { name: "w2", prompt: "fix the lexer" }).token
    expect((db.query(`SELECT COUNT(*) AS n FROM grants WHERE prompt IS NOT NULL`).get() as { n: number }).n).toBe(1)
    core.claim({ handle: "w1", harness: "codex", process: key(5), lineage: [key(5)], grant: on })
    core.claim({ handle: "w2", harness: "codex", process: key(6), lineage: [key(6)], grant: off })
    const turns = core.peek(actor, { endpoint: "w1" }).turns
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ role: "user" })
    expect(turns[0]!.text).toContain("fix the parser")
    expect(turns[0]!.text).not.toContain(secret)
    expect((db.query(`SELECT COUNT(*) AS n FROM peek_turns`).get() as { n: number }).n).toBe(1)
    expect((db.query(`SELECT COUNT(*) AS n FROM grants WHERE prompt IS NOT NULL`).get() as { n: number }).n).toBe(0)
  })
})

describe("a subagent woken through its root", () => {
  /** a root whose MCP connection set wake `channels` and is its waker, and its stopped Explore subagent */
  function woken() {
    const { core, clock, db, hook } = setup()
    const root = hook(9).endpoint
    core.claim({ handle: "claude-app", harness: "claude-code", process: key(9), session: key(9), lineage: [key(9), key(1)] })
    core.setWake(root.id, "channels")
    core.waker(root.id, true)
    const sub = hook(9, { subagent: { id: AGENT, type: "Explore" } }).endpoint
    core.status(sub.id, "done", undefined)
    const peer = core.claim({ handle: "peer", harness: "codex" }).endpoint
    core.rulesSet(HUMAN, { endpoint: "peer", out: ["*"] })
    return { core, clock, db, hook, root, sub, peer }
  }

  test("its view shows the root's wake and stays idle while the root's waker lives; a send says it is woken", () => {
    const { core, clock, root, sub, peer } = woken()
    expect(core.whoami(sub.id).wake).toBe("channels")
    clock.now += (LIMITS.hookIdleS + 1) * 1000
    expect(core.whoami(sub.id)).toMatchObject({ presence: "idle", wake: "channels" })
    expect(core.list({}).map((v) => v.id)).toContain(sub.id)
    const sent = core.send(peer.id, { to: sub.address, body: "more for you" })
    expect(sent.deliveries[0]).toMatchObject({ state: "running", idle: true, wake: "channels" })
    expect(core.wakesRoot(sub.id)).toBe(root.id)
    core.waker(root.id, false)
    expect(core.whoami(sub.id)).toMatchObject({ presence: "offline", wake: null })
    expect(core.wakesRoot(sub.id)).toBeNull()
    expect(core.send(peer.id, { to: sub.address, body: "later" }).deliveries[0]).toMatchObject({ state: "ended" })
  })

  test("the root's waker is offered the subagent's messages tagged for it, once: they stay unread for the subagent and no hook shows them again", () => {
    const { core, root, sub, peer } = woken()
    const sent = core.send(peer.id, { to: sub.address, body: "check the tests", kind: "request" })
    expect(core.offer(root.id).messages).toEqual([])
    const page = core.offer(root.id, { subagents: true })
    expect(page.messages).toHaveLength(1)
    const [message] = page.messages
    expect(message).toMatchObject({ id: sent.id, for: { address: sub.address, subagent: AGENT } })
    expect(message!.relation).toBeUndefined()
    const text = wrapMessage(message!)
    expect(text).toContain(`for="${sub.address}" subagent="${AGENT}">`)
    expect(text).toEndWith(
      `[for your subagent ${sub.address} (id ${AGENT}), which has stopped: continue that subagent with this message by its id (for example SendMessage to ${AGENT}) instead of acting on it yourself; the sender asked it a question]`,
    )
    expect(core.injected([message!.seq], page.hold, { endpoint: root.id })).toBe(1)
    expect(core.offer(root.id, { subagents: true }).messages).toEqual([])
    expect(core.inject(sub.id, { transient: true, process: key(9) }).messages).toEqual([])
    expect(core.inbox(sub.id).map((m) => m.id)).toEqual([sent.id])
    expect(core.inbox(root.id)).toEqual([])
  })

  test("a working subagent, one with a wake of its own or one of an earlier root session is not offered to the root", () => {
    const { core, db, hook, root, sub, peer } = woken()
    core.status(sub.id, "working", undefined)
    core.send(peer.id, { to: sub.address, body: "while it runs" })
    expect(core.wakesRoot(sub.id)).toBeNull()
    expect(core.offer(root.id, { subagents: true }).messages).toEqual([])
    core.status(sub.id, "done", undefined)
    core.setWake(sub.id, "claude-inbox")
    core.waker(sub.id, true)
    expect(core.whoami(sub.id).wake).toBe("claude-inbox")
    expect(core.offer(root.id, { subagents: true }).messages).toEqual([])
    core.waker(sub.id, false)
    core.setWake(sub.id, "none")
    expect(core.offer(root.id, { subagents: true }).messages).toHaveLength(1)
    const other = hook(9, { subagent: { id: "b0c1d2e3f4", type: "Plan" } }).endpoint
    core.status(other.id, "done", undefined)
    db.query(`UPDATE endpoints SET session = ? WHERE id = ?`).run("sub:b0c1d2e3f4:env:older", other.id)
    core.send(peer.id, { to: other.address, body: "for an old one" })
    expect(core.whoami(other.id).wake).toBeNull()
    expect(core.wakesRoot(other.id)).toBeNull()
  })
})
