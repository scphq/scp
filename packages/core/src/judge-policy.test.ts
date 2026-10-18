import { describe, expect, test } from "bun:test"
import { judgeBoundary, parseJudgePolicy } from "./judge-policy"
import { canonicalPolicy, parsePolicy, type PolicySubject } from "./policy"

const agent = (handle: string, tree: string, ancestors: string[] = [], rootHandle = tree): PolicySubject => ({
  handle,
  harness: "claude-code",
  kind: "agent",
  labels: {},
  scope: { id: handle, tree, ancestors, groups: [], rootHandle, machine: null, local: true },
})

describe("parseJudgePolicy", () => {
  test("defaults: shadow, fail open, 12 s, from and to *", () => {
    expect(parseJudgePolicy({ boundaries: [{}] })).toEqual({ mode: "shadow", fail: "open", timeout_s: 12, boundaries: [{ from: "*", to: "*" }] })
  })

  test("a full section", () => {
    const judge = parseJudgePolicy({
      mode: "enforce",
      fail: "closed",
      timeout_s: 5,
      model: { id: "openrouter/anthropic/claude-haiku-5-5", effort: "low", key_env: "OPENROUTER_API_KEY" },
      boundaries: [{ from: "fleet:qa", to: "tree:root" }, { to: "ep:main" }, { across: "tree" }],
    })
    expect(judge.model).toEqual({ id: "openrouter/anthropic/claude-haiku-5-5", effort: "low", key_env: "OPENROUTER_API_KEY" })
    expect(judge.boundaries).toEqual([{ from: "fleet:qa", to: "tree:root" }, { from: "*", to: "ep:main" }, { from: "*", to: "*", across: "tree" }])
    expect(parseJudgePolicy({ model: { id: "anthropic/judge-small", key_file: "/home/u/.config/scp/judge.key" }, boundaries: [{}] }).model).toEqual({
      id: "anthropic/judge-small",
      effort: "medium",
      key_file: "/home/u/.config/scp/judge.key",
    })
  })

  test("a model id names a provider of the table it is checked against", () => {
    const providers = { local: { url: "http://127.0.0.1:8080/v1/chat/completions", shape: "openai" as const } }
    expect(parseJudgePolicy({ model: { id: "local/judge", key_env: "K" }, boundaries: [{}] }, providers).model?.id).toBe("local/judge")
    expect(() => parseJudgePolicy({ model: { id: "openai/x", key_env: "K" }, boundaries: [{}] }, providers)).toThrow("provider one of local")
    expect(parsePolicy({ rules: [], judge: { model: { id: "local/judge", key_env: "K" }, boundaries: [{}] } }, { judgeProviders: providers }).judge?.model?.id).toBe("local/judge")
  })

  test("a broker-wide budget, absent unless set", () => {
    expect(parseJudgePolicy({ budget: { per_minute: 10, per_hour: 100 }, boundaries: [{}] }).budget).toEqual({ per_minute: 10, per_hour: 100 })
    expect(parseJudgePolicy({ budget: { per_hour: 50 }, boundaries: [{}] }).budget).toEqual({ per_minute: 120, per_hour: 50 })
    expect(parseJudgePolicy({ boundaries: [{}] }).budget).toBeUndefined()
  })

  test("refuses unknown fields, inline keys and bad values", () => {
    for (const bad of [
      { boundaries: [{}], extra: 1 },
      { boundaries: [{}], model: { id: "openai/x", key: "sk-abcdefghijklmnopqrstuvwxyz0123456789ab" } },
      { boundaries: [{}], model: { id: "openai/x", key_env: "OK", api_key: "x" } },
      { boundaries: [{}], model: { id: "openai/x" } },
      { boundaries: [{}], model: { id: "openai/x", key_env: "A", key_file: "/k" } },
      { boundaries: [{}], model: { id: "openai/x", key_env: "lower" } },
      { boundaries: [{}], model: { id: "openai/x", key_file: "relative/k" } },
      { boundaries: [{}], model: { id: "acme/x", key_env: "K" } },
      { boundaries: [{}], model: { id: "openai/x", key_env: "K", effort: "max" } },
      { boundaries: [{ from: "fleet:qa", label: "x" }] },
      { boundaries: [{ from: "nope" }] },
      { boundaries: [{ across: "machine" }] },
      { boundaries: [] },
      { boundaries: Array.from({ length: 65 }, () => ({})) },
      { mode: "on", boundaries: [{}] },
      { fail: "maybe", boundaries: [{}] },
      { timeout_s: 0, boundaries: [{}] },
      { timeout_s: 31, boundaries: [{}] },
      { budget: { per_minute: 0 }, boundaries: [{}] },
      { budget: { per_hour: 1.5 }, boundaries: [{}] },
      { budget: { per_minute: 10_001 }, boundaries: [{}] },
      { budget: { per_day: 5 }, boundaries: [{}] },
      { budget: 5, boundaries: [{}] },
      "shadow",
    ]) {
      expect(() => parseJudgePolicy(bad)).toThrow()
    }
  })
})

describe("judgeBoundary", () => {
  const qa = agent("qa-1", "qa", ["qa"], "qa")
  const qaRoot = agent("qa", "qa", [], "qa")
  const main = agent("main", "main")
  const judge = parseJudgePolicy({ boundaries: [{ from: "fleet:qa", to: "tree:root" }, { to: "ep:main" }] })

  test("the first matching boundary's label, relative selectors anchored on the other end", () => {
    expect(judgeBoundary(judge, qa, qaRoot)).toBe("fleet:qa to tree:root")
    expect(judgeBoundary(judge, qaRoot, main)).toBe("* to ep:main")
    expect(judgeBoundary(judge, main, qa)).toBeNull()
    expect(judgeBoundary(undefined, qa, main)).toBeNull()
    expect(judgeBoundary(parseJudgePolicy({ mode: "off", boundaries: [{}] }), qa, main)).toBeNull()
  })

  test("across tree matches only two scoped ends in different trees", () => {
    const across = parseJudgePolicy({ boundaries: [{ across: "tree" }] })
    expect(judgeBoundary(across, qa, main)).toBe("* to * (across trees)")
    expect(judgeBoundary(across, qa, qaRoot)).toBeNull()
    const human: PolicySubject = { handle: "", harness: null, kind: "human", labels: {} }
    expect(judgeBoundary(across, qa, human)).toBeNull()
  })
})

describe("policy", () => {
  test("a rule's scope takes a preset as its selector list, open as no cap", () => {
    const scope = (value: unknown) => parsePolicy({ rules: [{ match: "*", scope: value }] }).rules[0]!.scope
    expect(scope("tree")).toEqual(["tree:parent", "tree:descendants"])
    expect(scope("parent")).toEqual(["tree:parent"])
    expect(scope("none")).toEqual([])
    expect(scope("open")).toBeUndefined()
    expect(scope(["fleet:*"])).toEqual(["fleet:*"])
    expect(() => scope("wide")).toThrow()
  })

  test("parsePolicy takes a judge section and canonicalPolicy covers it", () => {
    const policy = parsePolicy({ rules: [], judge: { mode: "enforce", boundaries: [{ to: "ep:main" }] } })
    expect(policy.judge?.mode).toBe("enforce")
    expect(canonicalPolicy(policy)).not.toBe(canonicalPolicy(parsePolicy({ rules: [] })))
    expect(canonicalPolicy(parsePolicy({ rules: [] }))).toBe(JSON.stringify({ rules: [], groups: [], defaults: {} }))
    expect(() => parsePolicy({ rules: [], judge: { boundaries: [{}], model: { id: "openai/x", key: "abc" } } })).toThrow()
  })
})
