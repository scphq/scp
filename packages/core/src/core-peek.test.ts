import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { clip, digestText, dropQuoted, OMITTED, PEEK, stripRelaySpans } from "./peek"
import { LIMITS, RelayError, type ScopeActor } from "./protocol"
import { PREAMBLE, wrapMessage, wrapPeek } from "./render"
import type { Sql, SqlValue } from "./sql"

const TEST_RATES = {
  pairBurst: 20,
  pairPerMinute: 30,
  pairPerHour: 300,
  userPerDay: 2000,
  treePerMinute: 120,
  treePerHour: 1200,
  treePauseS: 600,
  groupPerMinute: 60,
  peekPairPerMinute: 6,
  peekTargetPerHour: 60,
}

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`
const TTY: ScopeActor = { kind: "human", tty: true }
const NO_TTY: ScopeActor = { kind: "human", tty: false }
const GH = `ghp_${"A1b2C3d4".repeat(5)}`

function setup() {
  const clock = { now: 1_800_000_000_000 }
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    limits: TEST_RATES,
    now: () => clock.now,
    hash: (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  })
  core.migrate()
  const ids: Record<string, string> = {}
  const claim = (handle: string, pid: number, parents: number[] = [], extra: Record<string, unknown> = {}) => {
    const result = core.claim({ handle, harness: "claude", process: key(pid), lineage: [key(pid), ...parents.map(key)], ...extra })
    ids[handle] = result.endpoint.id
    return result.endpoint
  }
  const as = (handle: string, auth: "session" | "self" | "lineage" = "session"): ScopeActor => ({ kind: "endpoint", id: ids[handle]!, auth })
  const tick = (ms = 1000) => (clock.now += ms)
  const count = (table: string, where = "1") => (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n
  return { core, clock, db, ids, claim, as, tick, count }
}

function failure(fn: () => unknown): RelayError {
  try {
    fn()
  } catch (error) {
    if (error instanceof RelayError) return error
    throw error
  }
  throw new Error("expected a RelayError")
}

describe("peek helpers", () => {
  test("relay spans, an unterminated opening, an orphan closing and the preamble are cut", () => {
    const message = wrapMessage({
      id: "msg_1",
      thread: "thr_1",
      reply_to: null,
      kind: "message",
      from: { address: "me/x", endpoint: "ep_x", user: "me", auth: "local-uid", claims: { harness: "codex", model: null } },
      to: "me/y",
      body: { text: "third party secret plan", mime: "text/plain" },
      data_class: "public",
      attachments: [],
      hop: 0,
      created_at: "",
      expires_at: "",
    })
    expect(stripRelaySpans(`before ${message} after`)).toBe(`before ${OMITTED}\n[for your information; reply only if useful] after`)
    expect(stripRelaySpans(`${PREAMBLE}\nok`)).toBe(`${OMITTED}\nok`)
    expect(stripRelaySpans(`keep <relay-message from="x">leak to the end`)).toBe(`keep ${OMITTED}`)
    expect(stripRelaySpans(`leaked tail</relay-message> keep`)).toBe(`${OMITTED} keep`)
    expect(stripRelaySpans(`a <RELAY-MESSAGE>x</relay-message > b <relay-message>y</relay-message> c`)).toBe(`a ${OMITTED} b ${OMITTED} c`)
  })

  test("a relay channel wrapper and its sender metadata are cut, at store and at read; another channel stays", () => {
    const channel = `<channel source="scp" from="me/z" id="msg_1" seq="4" thread="thr_9">\n${PREAMBLE}\n\n<relay-message from="me/z">body</relay-message>\n</channel>`
    expect(stripRelaySpans(`before ${channel} after`)).toBe(`before ${OMITTED} after`)
    expect(stripRelaySpans(`keep <channel from="me/z" thread="thr_9">cut to the end`)).toBe(`keep ${OMITTED}`)
    expect(stripRelaySpans(`a <CHANNEL source='scp'>x</channel > b`)).toBe(`a ${OMITTED} b`)
    expect(stripRelaySpans(`<channel source="slack">hi</channel>`)).toBe(`<channel source="slack">hi</channel>`)
    expect(digestText(`ok ${channel}`)).toBe(`ok ${OMITTED}`)
  })

  test("a secret straddling the store cut is redacted whole, never kept in part", () => {
    const text = `${"word ".repeat(398)}${GH} tail`
    expect(text.indexOf(GH)).toBeLessThan(PEEK.storeChars)
    expect(text.indexOf(GH) + GH.length).toBeGreaterThan(PEEK.storeChars)
    const stored = digestText(text)
    expect(stored).not.toContain("ghp_")
    expect(stored.length).toBeLessThanOrEqual(PEEK.storeChars)
  })

  test("a quote of 40 or more characters from a delivered body is cut; a shorter overlap stays", () => {
    const body = "the deploy key rotation for the staging cluster happens on friday at noon"
    expect(dropQuoted(`I read "${body.slice(4, 60)}" so ok`, [body])).toBe(`I read "${OMITTED}" so ok`)
    expect(dropQuoted(`the deploy key rotation is fine`, [body])).toBe(`the deploy key rotation is fine`)
    expect(dropQuoted(`x ${"a".repeat(5000)} y`, ["a".repeat(5000)])).toBe(`x ${OMITTED} y`)
    expect(dropQuoted("nothing", [])).toBe("nothing")
  })

  test("a clip never cuts a marker and ends at a word boundary", () => {
    const text = `${"word ".repeat(10)}[redacted github token] tail`
    for (let max = 20; max < text.length; max++) {
      const { text: out, cut } = clip(text, max)
      expect(cut).toBe(true)
      expect(out.length).toBeLessThanOrEqual(max)
      expect(out.replace(/\.\.\.$/, "")).not.toMatch(/\[redacted(?![^\]]*\])/)
      expect(out.endsWith("wor...")).toBe(false)
    }
    expect(clip("short", 10)).toEqual({ text: "short", cut: false })
    expect(digestText("x".repeat(5000)).length).toBeLessThanOrEqual(PEEK.storeChars)
    expect(digestText(`token ${GH.slice(0, 10)}\u200b${GH.slice(10)}`)).toBe("token [redacted github token]")
  })
})

describe("peek", () => {
  test("an opted-out endpoint is not_found, the same answer as an unknown one", () => {
    const { core, claim, as } = setup()
    claim("a", 1)
    claim("b", 2)
    const off = failure(() => core.peek(as("a"), { endpoint: "b" }))
    const unknown = failure(() => core.peek(as("a"), { endpoint: "nobody" }))
    expect(off.code).toBe("not_found")
    expect(unknown.code).toBe("not_found")
    expect(off.message.replace("b", "X")).toBe(unknown.message.replace("nobody", "X"))
  })

  test("an opted-in endpoint shows its digest turns with tool names from activity, relay spans cut and secrets redacted", () => {
    const { core, claim, as, ids, tick } = setup()
    claim("a", 1)
    claim("b", 2)
    expect(core.peekTurn(ids.b!, { role: "user", text: "ignored while off" })).toEqual({ stored: false })
    expect(core.peekSet(as("b"), { level: "on" })).toEqual({ endpoint: "me/b", peek: "local" })
    tick()
    core.peekTurn(ids.b!, { role: "user", text: `fix the build ${PREAMBLE} <relay-message from="me/z">third party</relay-message> please` })
    tick()
    core.event(ids.b!, { kind: "tool", tool: "Edit" }, { transient: true })
    core.event(ids.b!, { kind: "tool", tool: "Edit" }, { transient: true })
    core.event(ids.b!, { kind: "tool", tool: "Bash" }, { transient: true })
    tick()
    core.peekTurn(ids.b!, { role: "assistant", text: `done, token ${GH} rotated <relay-message from="me/z">unterminated` })
    tick()
    core.event(ids.b!, { kind: "tool", tool: "Read" }, { transient: true })
    const result = core.peek(as("a"), { endpoint: "b" })
    expect(result).toMatchObject({ endpoint: "me/b", level: "local", source: "digest", recent_tools: ["Read"], truncated: false })
    expect(result.turns.map((t) => [t.role, t.text, t.tools])).toEqual([
      ["user", `fix the build ${OMITTED} ${OMITTED} please`, []],
      ["assistant", `done, token [redacted github token] rotated ${OMITTED}`, ["Edit", "Edit", "Bash"]],
    ])
    const wrapped = wrapPeek(result)
    expect(wrapped).toStartWith(`<relay-peek of="me/b" source="digest" turns="2"`)
    expect(wrapped).toContain("[tools: Edit x2, Bash]")
    expect(wrapped).not.toContain("third party")
  })

  test("a stored digest with a secret is redacted again at read time and truncation keeps markers whole", () => {
    const { core, claim, as, ids, db } = setup()
    claim("a", 1)
    claim("b", 2)
    core.peekSet(as("b"), { level: "on" })
    core.peekTurn(ids.b!, { role: "assistant", text: "x" })
    db.query(`UPDATE peek_turns SET text = ?`).run(`${"word ".repeat(118)}${GH} ${"more ".repeat(100)}`)
    const turn = core.peek(as("a"), { endpoint: "b" }).turns[0]!
    expect(turn.text).not.toContain("ghp_")
    expect(turn.text.length).toBeLessThanOrEqual(PEEK.turnChars)
    expect(turn.text).not.toMatch(/\[redacted(?![^\]]*\])/)
    expect(core.peek(as("a"), { endpoint: "b", full: true }).turns[0]!.text).toContain("[redacted github token]")
  })

  test("scope refusal holds when opted in, and the answer matches an unknown endpoint", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("y", 9)
    claim("w", 3, [], { grant: core.grant(as("orch"), { name: "w", scope: "parent" }).token })
    core.peekSet(as("y"), { level: "on" })
    const refused = failure(() => core.peek(as("w"), { endpoint: "y" }))
    expect(refused.code).toBe("not_found")
    expect(refused.message.replace("y", "X")).toBe(failure(() => core.peek(as("w"), { endpoint: "zz" })).message.replace("zz", "X"))
    expect(core.peek(as("y"), { endpoint: "y" }).endpoint).toBe("me/y")
  })

  test("an admin with authority peeks an opted-in endpoint it may not message", () => {
    const { core, claim, as } = setup()
    claim("main", 1)
    claim("w", 3, [1])
    claim("x", 5)
    core.rulesSet(as("x"), { scope: "none" })
    expect(failure(() => core.peek(as("x"), { endpoint: "w" })).code).toBe("not_found")
    core.admin(TTY, { action: "grant", subject: "x", tree: "main" })
    expect(failure(() => core.peek(as("x"), { endpoint: "w" })).code).toBe("not_found")
    core.peekSet(as("w"), { level: "on" })
    expect(core.why(TTY, "me/x", "me/w").allowed).toBe(false)
    expect(core.peek(as("x"), { endpoint: "w" }).endpoint).toBe("me/w")
  })

  test("off deletes the digest and a re-on shows none of it", () => {
    const { core, claim, as, ids, count } = setup()
    claim("a", 1)
    claim("b", 2)
    core.peekSet(as("b"), { level: "on" })
    core.peekTurn(ids.b!, { role: "user", text: "before" })
    expect(count("peek_turns")).toBe(1)
    expect(core.peekSet(as("b"), { level: "off" })).toEqual({ endpoint: "me/b", peek: null })
    expect(count("peek_turns")).toBe(0)
    core.peekSet(as("b"), { level: "on" })
    expect(core.peek(as("a"), { endpoint: "b" })).toMatchObject({ source: "status", turns: [] })
  })

  test("an agent reply quoting a message delivered to it since its reset drops the quote", () => {
    const { core, claim, as, ids } = setup()
    claim("a", 1)
    claim("b", 2)
    core.peekSet(as("b"), { level: "on" })
    const body = "QUOTE-MARKER the staging database password moves to the vault next week"
    core.send(ids.a!, { to: "me/b", body })
    core.peekTurn(ids.b!, { role: "assistant", text: `noted: ${body.slice(0, 50)}, will do` })
    const text = core.peek(as("a"), { endpoint: "b" }).turns[0]!.text
    expect(text).not.toContain("QUOTE-MARKER")
    expect(text).toBe(`noted: ${OMITTED}, will do`)
  })

  test("a hook claim from another process takes over an ended endpoint and drops its digest and peek level", () => {
    const { core, clock, claim, as, ids, count } = setup()
    claim("b", 2)
    core.peekSet(as("b"), { level: "on" })
    core.peekTurn(ids.b!, { role: "user", text: "the earlier holder's words" })
    core.disconnect(ids.b!)
    clock.now += (LIMITS.restartGraceS + LIMITS.hookIdleS + 1) * 1000
    const hook = core.claim({ handle: "b", harness: "claude", process: key(7), lineage: [key(7)], session: "s-new" }, { transient: true }).endpoint
    expect(hook.id).toBe(ids.b!)
    expect(core.log({ scope: true }).some((row) => row.event === "scope_reset" && row.detail.target === "me/b")).toBe(true)
    expect(core.peekState(ids.b!).peek).toBeNull()
    expect(count("peek_turns")).toBe(0)
  })

  test("a retired handle drops its digest and peek level, and sweep drops a retired row's digest", () => {
    const { core, clock, claim, as, ids, db, count } = setup()
    claim("b", 2)
    core.peekSet(as("b"), { level: "on" })
    core.peekTurn(ids.b!, { role: "user", text: "retired words" })
    core.disconnect(ids.b!)
    clock.now += (LIMITS.handleBoundS + 1) * 1000
    const old = ids.b!
    core.claim({ handle: "b", harness: "codex", process: key(8), lineage: [key(8)] })
    expect(db.query(`SELECT handle, peek FROM endpoints WHERE id = ?`).get(old)).toEqual({ handle: `_gone_${old}`, peek: null })
    expect(count("peek_turns")).toBe(0)
    claim("c", 3)
    core.peekSet(as("c"), { level: "on" })
    core.peekTurn(ids.c!, { role: "user", text: "c words" })
    db.query(`UPDATE endpoints SET handle = '_gone_' || id WHERE id = ?`).run(ids.c!)
    core.sweep()
    expect(count("peek_turns")).toBe(0)
  })

  test("the digest keeps a ring per endpoint", () => {
    const { core, claim, as, ids, count } = setup()
    claim("b", 2)
    core.peekSet(as("b"), { level: "on" })
    for (let n = 0; n < PEEK.ring + 5; n++) core.peekTurn(ids.b!, { role: "user", text: `turn ${n}` })
    expect(count("peek_turns")).toBe(PEEK.ring)
    expect(core.peek(as("b"), { endpoint: "b", turns: 10 }).turns.at(-1)!.text).toBe(`turn ${PEEK.ring + 4}`)
  })

  test("a peek is audited without bodies and the peeked endpoint sees who looked, with nothing delivered to it", () => {
    const { core, claim, as, ids, count } = setup()
    claim("a", 1)
    claim("b", 2)
    core.peekSet(as("b"), { level: "on" })
    core.peekTurn(ids.b!, { role: "user", text: "private words" })
    const before = { deliveries: count("deliveries"), activity: count("activity"), messages: count("messages") }
    core.peek(as("a"), { endpoint: "b", turns: 2 })
    expect({ deliveries: count("deliveries"), activity: count("activity"), messages: count("messages") }).toEqual(before)
    expect(core.inbox(ids.b!)).toEqual([])
    const rows = core.log({ peek: true })
    expect(rows.map((r) => r.event)).toEqual(["peek_set", "peek"])
    const peek = rows.at(-1)!
    expect(peek).toMatchObject({ endpoint: "me/b", ref: ids.a, detail: { by: "me/a", auth: "session", turns: 1, source: "digest", level: "local" } })
    expect(JSON.stringify(rows)).not.toContain("private words")
    expect(core.peekState(ids.b!)).toMatchObject({ peek: "local", peeked_by: [{ by: "me/a", auth: "session", turns: 1 }] })
    expect(core.peekWho(as("b"), {}).peeked_by).toHaveLength(1)
    expect(failure(() => core.peekWho(as("a"), { endpoint: "b" })).code).toBe("not_found")
    expect(core.whoami(ids.b!)).not.toHaveProperty("peek")
    expect(core.whoami(ids.b!)).not.toHaveProperty("peeked_by")
  })

  test("turns out of range are invalid_params", () => {
    const { core, claim, as } = setup()
    claim("b", 2)
    for (const turns of [0, 11, 2.5, "3"]) expect(failure(() => core.peek(as("b"), { endpoint: "b", turns })).code).toBe("invalid_params")
    expect(failure(() => core.peekTurn("ep", { role: "system", text: "x" })).code).toBe("invalid_params")
    expect(failure(() => core.peekSet(as("b"), { level: "account" })).code).toBe("invalid_params")
  })

  test("peeks are rate limited per pair and per target; the human at a terminal is exempt", () => {
    const { core, claim, as, tick } = setup()
    for (let n = 0; n < 12; n++) claim(`p${n}`, 100 + n)
    claim("b", 2)
    core.peekSet(as("b"), { level: "on" })
    for (let n = 0; n < TEST_RATES.peekPairPerMinute; n++) core.peek(as("p0"), { endpoint: "b" })
    const limited = failure(() => core.peek(as("p0"), { endpoint: "b" }))
    expect(limited.code).toBe("rate_limited")
    expect(limited.retryAfterS).toBeGreaterThan(0)
    for (let n = 0; n < 20; n++) core.peek(TTY, { endpoint: "b" })
    let done = TEST_RATES.peekPairPerMinute
    while (done < TEST_RATES.peekTargetPerHour) {
      tick(61_000)
      for (let p = 1; p < 12 && done < TEST_RATES.peekTargetPerHour; p++, done++) core.peek(as(`p${p}`), { endpoint: "b" })
    }
    expect(failure(() => core.peek(as("p11"), { endpoint: "b" })).code).toBe("rate_limited")
  })
})

describe("peek levels", () => {
  test("a grant's peek local applies where it places a fresh spawn, never on a redeem; an ancestor may later lower, never raise", () => {
    const { core, claim, as, ids, db } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    expect(failure(() => core.grant(as("orch"), { peek: "account" as "local" })).code).toBe("invalid_params")
    claim("w", 3, [], { grant: core.grant(as("orch"), { name: "w", peek: "local" }).token })
    expect(core.peekState(ids.w!).peek).toBe("local")
    const hook = core.claim({ handle: "j", harness: "claude", session: "sess-1", process: key(9), lineage: [key(9), key(2)] }, { transient: true }).endpoint
    expect(core.peekState(hook.id).peek).toBeNull()
    const grant = core.grant(as("orch"), { peek: "local" }).token
    core.claim({ handle: "j", harness: "claude", session: "sess-1", process: key(9), lineage: [key(9), key(2)], grant })
    expect(core.peekState(hook.id).peek).toBeNull()
    const set = core.log({ peek: true }).filter((row) => row.event === "peek_set")
    expect(set.map((row) => row.detail.auth)).toEqual(["grant"])
    expect(core.peekSet(as("orch"), { endpoint: "w", level: "off" })).toEqual({ endpoint: "me/w", peek: null })
    const raise = failure(() => core.peekSet(as("orch"), { endpoint: "w", level: "on" }))
    expect(raise.code).toBe("scope_refused")
    expect(failure(() => core.peekSet(as("main"), { endpoint: "w", level: "on" })).code).toBe("scope_refused")
    expect(core.log().some((row) => row.event === "scope_refused" && row.detail.target === "me/w")).toBe(true)
    expect(db.query(`SELECT peek FROM endpoints WHERE id = ?`).get(ids.w!)).toEqual({ peek: null })
  })

  test("an explicit off holds when the endpoint re-claims with another peek grant", () => {
    const { core, claim, as, ids } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("w", 3, [], { grant: core.grant(as("orch"), { name: "w", peek: "local" }).token })
    expect(core.peekSet(as("w"), { level: "off" }).peek).toBeNull()
    core.disconnect(ids.w!)
    expect(claim("w", 3, [], { grant: core.grant(as("orch"), { name: "w", peek: "local" }).token }).id).toBe(ids.w!)
    expect(core.peekState(ids.w!).peek).toBeNull()
  })

  test("only the endpoint's session or self raises its own level; lineage may lower", () => {
    const { core, claim, as } = setup()
    claim("a", 1)
    claim("b", 2)
    expect(failure(() => core.peekSet(as("b", "lineage"), { level: "on" })).code).toBe("scope_refused")
    expect(core.peekSet(as("b", "self"), { level: "on" }).peek).toBe("local")
    expect(core.peekSet(as("b", "lineage"), { level: "off" }).peek).toBeNull()
    expect(failure(() => core.peekSet(as("a"), { endpoint: "b", level: "on" })).code).toBe("not_found")
    expect(failure(() => core.peekSet(as("a"), { endpoint: "b", level: "off" })).code).toBe("not_found")
    expect(failure(() => core.peekSet(NO_TTY, { endpoint: "b", level: "on" })).code).toBe("scope_refused")
    expect(core.peekSet(TTY, { endpoint: "b", level: "on" }).peek).toBe("local")
    expect(core.peekSet(NO_TTY, { endpoint: "b", level: "off" }).peek).toBeNull()
    expect(failure(() => core.peekSet(TTY, { level: "on" })).code).toBe("invalid_params")
  })

  test("the human at a terminal peeks an endpoint that is off, audited; without one it needs the opt-in", () => {
    const { core, claim, as, ids } = setup()
    claim("b", 2)
    core.rulesSet(as("b"), { scope: "none" })
    expect(core.peek(TTY, { endpoint: "b" })).toMatchObject({ endpoint: "me/b", level: null, source: "status" })
    expect(core.log({ peek: true }).at(-1)).toMatchObject({ event: "peek", detail: { auth: "tty", level: null } })
    expect(failure(() => core.peek(NO_TTY, { endpoint: "b" })).code).toBe("not_found")
    core.rulesSet(as("b"), { scope: "open" })
    expect(failure(() => core.peek(NO_TTY, { endpoint: "b" })).code).toBe("not_found")
    core.peekSet(as("b"), { level: "on" })
    expect(core.peek(NO_TTY, { endpoint: "b" }).endpoint).toBe("me/b")
    expect(core.peekState(ids.b!).peeked_by.map((seen) => seen.auth)).toEqual(["no-tty", "tty"])
  })

  test("peekable shows only in a viewer's list and peers, for rows that viewer may peek", () => {
    const { core, claim, as, ids } = setup()
    claim("main", 1)
    claim("orch", 2, [1])
    claim("y", 9)
    claim("w", 3, [], { grant: core.grant(as("orch"), { name: "w", scope: "parent" }).token })
    core.peekSet(as("y"), { level: "on" })
    core.peekSet(as("orch"), { level: "on" })
    expect(core.list().some((row) => "peekable" in row)).toBe(false)
    const peekable = (rows: { address: string; peekable?: string }[]) =>
      rows
        .filter((row) => row.peekable)
        .map((row) => row.address)
        .sort()
    expect(peekable(core.list({ viewer: ids.main }))).toEqual(["me/orch", "me/y"])
    expect(peekable(core.list({ viewer: ids.w }))).toEqual(["me/orch"])
    expect(peekable(core.peers(ids.w!))).toEqual(["me/orch"])
    expect(peekable(core.peers(core.humanId()))).toEqual(["me/orch", "me/y"])
    expect(peekable(core.list({ peekable: true }))).toEqual(["me/orch", "me/y"])
  })

  test("sweep drops the digest of endpoints that are off or gone, and a new incarnation starts clean", () => {
    const { core, claim, as, ids, db, count } = setup()
    claim("main", 1)
    claim("b", 2, [1])
    core.peekSet(as("b"), { level: "on" })
    core.peekTurn(ids.b!, { role: "user", text: "kept" })
    db.query(`INSERT INTO peek_turns (endpoint, at, role, text) VALUES ('ep_gone', 0, 'user', 'stale'), (?, 0, 'user', 'stale')`).run(ids.main!)
    core.sweep()
    expect(db.query(`SELECT text FROM peek_turns`).all()).toEqual([{ text: "kept" }])
    core.disconnect(ids.b!)
    claim("b", 5, [], { grant: core.grant(as("main"), { name: "b" }).token })
    expect(core.peekState(ids.b!).peek).toBeNull()
    expect(count("peek_turns")).toBe(0)
  })
})
