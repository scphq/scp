import { describe, expect, test } from "bun:test"
import { matches, type PolicySubject, validSelector } from "./policy"
import type { ScopeCap } from "./protocol"
import { admits, crossFleet, isLeaving, type ScopeNode, type ScopeWorld } from "./scopes"

const local = (id: string, rules: ScopeNode["rules"] = {}, caps: ScopeCap[] = []): ScopeNode => ({
  id,
  address: `alice/${id}`,
  subject: { handle: id, harness: "claude-code", kind: "agent", labels: {}, scope: { id, tree: id, ancestors: [], groups: [], rootHandle: id, machine: "laptop", local: true } },
  rules,
  caps: { caps, allow: {} },
  groups: [],
  policy: [],
})

const peer = (account: string, handle = "review", kind = "agent"): ScopeNode => ({
  id: `x:${account}/${handle}`,
  address: `${account}/desk/${handle}`,
  subject: { handle, harness: null, kind, labels: {}, account },
  rules: {},
  caps: { caps: [], allow: {} },
  groups: [],
  policy: [],
})

function worldOf(...nodes: ScopeNode[]): ScopeWorld {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return { node: (id) => byId.get(id), administers: () => false, group: () => undefined }
}

describe("acct: selectors", () => {
  test("acct:<handle> and acct:* are absolute, leaving selectors", () => {
    for (const sel of ["acct:bob", "acct:*", "acct:bob-2"]) {
      expect(validSelector(sel)).toBe(true)
      expect(validSelector(sel, { absolute: true })).toBe(true)
      expect(isLeaving(sel)).toBe(true)
    }
    for (const sel of ["acct:", "acct:Bob", "acct:bob/desk", "acct:-bob"]) expect(validSelector(sel)).toBe(false)
  })

  test("only acct: matches an endpoint of another account, and acct: never matches one of this account", () => {
    const bob: PolicySubject = peer("bob").subject
    const mine: PolicySubject = local("impl").subject
    expect(matches("acct:bob", bob)).toBe(true)
    expect(matches("acct:*", bob)).toBe(true)
    expect(matches("acct:carol", bob)).toBe(false)
    for (const sel of ["*", "fleet:*", "machine:desk", "ep:review", "kind:agent", "harness:claude-code", "handle:*", "tree:self", "group:x"]) expect(matches(sel, bob, mine)).toBe(false)
    expect(matches("acct:*", mine)).toBe(false)
    expect(matches("acct:bob", mine)).toBe(false)
    expect(crossFleet(local("impl"), peer("bob"))).toBe(true)
  })
})

describe("the cross-account rule", () => {
  test("an endpoint with nothing set takes part in both directions", () => {
    const impl = local("impl")
    const world = worldOf(impl)
    expect(admits(world, impl, "out", peer("bob")).ok).toBe(true)
    expect(admits(world, impl, "in", peer("bob")).ok).toBe(true)
  })

  test("an endpoint with any rule must name a matching acct: selector in each list of the direction", () => {
    const fenced = local("fenced", { in: ["tree:descendants", "fleet:*", "*"], out: ["*"] })
    const world = worldOf(fenced)
    expect(admits(world, fenced, "in", peer("bob")).ok).toBe(false)
    expect(admits(world, fenced, "out", peer("bob")).ok).toBe(false)
    const named = local("named", { in: ["tree:descendants", "acct:bob"] })
    expect(admits(worldOf(named), named, "in", peer("bob")).ok).toBe(true)
    expect(admits(worldOf(named), named, "in", peer("carol")).ok).toBe(false)
    expect(admits(worldOf(named), named, "out", peer("bob")).ok).toBe(false)
    const any = local("any", { in: ["acct:*"], out: ["acct:*"] })
    expect(admits(worldOf(any), any, "in", peer("carol")).ok).toBe(true)
    expect(admits(worldOf(any), any, "out", peer("carol", "", "human")).ok).toBe(true)
  })

  test("a cap is a list of its own: own rules naming acct: do not pass a cap that does not", () => {
    const capped = local("capped", { in: ["acct:bob"] }, [{ id: "c1", dir: "in", by: "human", sels: [{ sel: "fleet:*" }] }])
    expect(admits(worldOf(capped), capped, "in", peer("bob")).ok).toBe(false)
    const both = local("both", { in: ["acct:bob"] }, [{ id: "c1", dir: "in", by: "human", sels: [{ sel: "acct:*" }] }])
    expect(admits(worldOf(both), both, "in", peer("bob")).ok).toBe(true)
  })

  test("an acct: entry a widener added is clipped by the widener's own reach", () => {
    const child = local("child", { out: ["acct:bob"] }, [{ id: "c1", dir: "out", by: "parent", sels: [{ sel: "acct:bob", via: "parent" }] }])
    const narrow = local("parent", { out: ["tree:descendants"] })
    expect(admits(worldOf(narrow, child), child, "out", peer("bob")).ok).toBe(false)
    const wide = local("parent", { out: ["acct:bob"] })
    expect(admits(worldOf(wide, child), child, "out", peer("bob")).ok).toBe(true)
  })
})
