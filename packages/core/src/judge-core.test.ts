import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RelayCore } from "./core"
import { RelayError } from "./protocol"
import type { Sql, SqlValue } from "./sql"

function setup() {
  const db = new Database(":memory:")
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
  const core = new RelayCore(sql, {
    now: () => 1_800_000_000_000,
    hash: (value) => new Bun.CryptoHasher("sha256").update(value).digest("hex"),
    transaction: (fn) => db.transaction(fn)(),
  })
  core.migrate()
  const claim = (handle: string, pid: number, parents: number[] = [], extra: Record<string, unknown> = {}) =>
    core.claim({ handle, harness: "codex", process: `pid:${pid}:s`, lineage: [`pid:${pid}:s`, ...parents.map((p) => `pid:${p}:s`)], ...extra }).endpoint
  return { core, claim }
}

function code(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof RelayError) return error.code
    throw error
  }
  return undefined
}

describe("judgeSubjects", () => {
  test("resolves the recipients as send does, tree:children expanded, with their scope", () => {
    const { core, claim } = setup()
    const lead = claim("lead", 10)
    claim("c1", 20, [10])
    claim("c2", 30, [10])
    const subjects = core.judgeSubjects(lead.id, { to: ["tree:children", "c1"] })
    expect(subjects.sender).toMatchObject({ handle: "lead", kind: "agent", scope: { tree: lead.id } })
    expect(subjects.recipients.map((r) => r.handle)).toEqual(["c1", "c2"])
    expect(subjects.recipients[0]!.scope?.ancestors).toEqual([lead.id])
  })

  test("an out-of-scope or unknown target is not_found, as for send", () => {
    const { core, claim } = setup()
    const shut = claim("shut", 10, [], { scope: "none" })
    claim("other", 20)
    expect(code(() => core.judgeSubjects(shut.id, { to: "other" }))).toBe("not_found")
    expect(code(() => core.send(shut.id, { to: "other", body: "x" }))).toBe("not_found")
    expect(code(() => core.judgeSubjects(shut.id, { to: "ghost" }))).toBe("not_found")
    expect(code(() => core.judgeSubjects(shut.id, { to: [] }))).toBe("invalid_params")
  })
})

test("judgeSubjects names the sender's lineage tree root", () => {
  const { core, claim } = setup()
  const lead = claim("lead", 10)
  const child = claim("c1", 20, [10])
  claim("b", 30)
  expect(core.judgeSubjects(child.id, { to: "b" }).tree).toBe(lead.id)
  expect(core.judgeSubjects(lead.id, { to: "b" }).tree).toBe(lead.id)
})

describe("judge audit", () => {
  test("auditJudge writes judge_ rows that log({judge}) filters, and refuses other events", () => {
    const { core, claim } = setup()
    const a = claim("a", 10)
    claim("b", 20)
    core.send(a.id, { to: "b", body: "hello" })
    core.auditJudge("judge_hold", a.id, "hold_1", {
      side: "local",
      boundary: "* to *",
      prompt_version: "j1",
      categories: ["private"],
      sha256: "ab",
      verdict: "hold",
    })
    expect(() =>
      core.auditJudge("send" as "judge_hold", a.id, null, { side: "local", boundary: "b", prompt_version: "j1", categories: [], sha256: "x", verdict: "pass" }),
    ).toThrow()
    const rows = core.log({ judge: true })
    expect(rows.map((row) => [row.event, row.ref])).toEqual([["judge_hold", "hold_1"]])
    expect(rows[0]!.detail).toEqual({ side: "local", boundary: "* to *", prompt_version: "j1", categories: ["private"], sha256: "ab", verdict: "hold" })
    expect(core.log().map((row) => row.event)).toContain("send")
  })

  test("a judge row's reason and redaction kinds are for the human at a terminal only", () => {
    const { core, claim } = setup()
    const a = claim("a", 10)
    claim("b", 20)
    const detail = {
      side: "local" as const,
      boundary: "* to *",
      prompt_version: "j1",
      categories: ["pii"],
      sha256: "ab",
      verdict: "redact",
      reason: "covert words",
      to: ["me/b"],
      redacted: { n: 1, kinds: ["email"] },
    }
    core.auditJudge("judge_redact", a.id, "msg_1", detail)
    expect(core.log({ judge: true })[0]!.detail).toEqual(detail)
    const seen = core.log({ judge: true, viewer: a.id })
    expect(seen.map((row) => row.event)).toEqual(["judge_redact"])
    expect(seen[0]!.detail).toEqual({
      side: "local",
      boundary: "* to *",
      prompt_version: "j1",
      categories: ["pii"],
      sha256: "ab",
      verdict: "redact",
      to: ["me/b"],
      redacted: { n: 1 },
    })
  })

  test("judgeNotice tells an endpoint, from the relay", () => {
    const { core, claim } = setup()
    const a = claim("a", 10)
    core.judgeNotice(a.id, "your held message was released")
    expect(core.inbox(a.id).map((m) => [m.from.address, m.kind, m.body.text])).toEqual([["me/relay", "status", "your held message was released"]])
  })
})
