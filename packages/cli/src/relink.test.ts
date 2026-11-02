import { describe, expect, test } from "bun:test"
import { mismatchReport, relinkReport } from "./relink"

const released = { from: "claude-app", to: "lead", by: "session" }
const live = { from: "claude-app-2", to: "orchestrator", by: "origin", live: true }

describe("relinkReport", () => {
  test("a dry run asks to confirm the pairs a live origin still holds", () => {
    expect(relinkReport([released, live], true, false)).toEqual([
      "me/claude-app -> me/lead (by session)",
      "me/claude-app-2 -> me/orchestrator (by origin, held by its idle origin)",
      "would relink 2 sessions",
      "1 takes its name from a session that still holds it: confirm with swarm relink --live, which closes the origin's connections",
    ])
    expect(relinkReport([live], true, true).at(-1)).toBe("would relink 1 session")
  })

  test("an apply without --live reports the live pairs it left", () => {
    expect(relinkReport([{ ...released, retired: "ep_a" }, live], false, false).slice(2)).toEqual([
      "relinked 1 session",
      "1 takes its name from a session that still holds it: confirm with swarm relink --live, which closes the origin's connections",
    ])
    expect(relinkReport([{ ...live, retired: "ep_b" }], false, true).slice(1)).toEqual(["relinked 1 session"])
    expect(relinkReport([], false, false)).toEqual(["nothing to relink"])
  })
})

describe("mismatchReport", () => {
  const S = "11111111-aaaa-4bbb-8ccc-000000000001"
  const X = "22222222-aaaa-4bbb-8ccc-000000000002"
  const F = "33333333-aaaa-4bbb-8ccc-000000000003"
  const R = "44444444-aaaa-4bbb-8ccc-000000000004"
  const agent = (id: string, handle: string, harness_session: string | null, harness_origin: string | null = null) => ({
    id,
    address: `me/${handle}`,
    handle,
    harness_session,
    harness_origin,
  })

  test("lists an endpoint at a background session's name that an unrelated session holds, never its own, a fork's or a reuse's", () => {
    const sessions = [
      { id: "11111111", handle: "lane-a" },
      { id: "22222222", handle: "lane-b" },
      { id: "11111111", handle: "claude-proj-11" },
      { id: "11111111", handle: "lane-c" },
      { id: "44444444", handle: "lane-d" },
      { id: "11111111", handle: "lane-d" },
      { id: "55555555" },
    ]
    const agents = [
      agent("ep_a", "lane-a", S),
      agent("ep_b", "lane-b", F, X),
      agent("ep_p", "claude-proj-11", X),
      agent("ep_c", "lane-c", null),
      agent("ep_d", "lane-d", R),
    ]
    expect(mismatchReport(sessions, agents)).toEqual(["me/claude-proj-11 ep_p: bg 11111111 but held by session 22222222"])
    expect(mismatchReport(sessions.slice(0, 2), agents)).toEqual(["no mismatched endpoints"])
  })

  test("lists an endpoint a rehome moved off a background session's name that another session now holds, once", () => {
    const sessions = [
      { id: "11111111", handle: "lane-a" },
      { id: "22222222", handle: "worker-b" },
    ]
    const agents = [agent("ep_a", "worker-b", X), agent("ep_o", "lane-o", F)]
    const rehome = (endpoint: string, from: string) => ({ endpoint, detail: { from, to: "claude-proj-11" } })
    expect(mismatchReport(sessions, agents, [rehome("me/worker-b", "lane-a"), rehome("ep_a", "lane-a"), rehome("me/lane-o", "unknown")])).toEqual([
      "me/worker-b ep_a (was me/lane-a): bg 11111111 but held by session 22222222",
    ])
    expect(mismatchReport(sessions.slice(0, 1), [agent("ep_a", "worker-b", S)], [rehome("me/worker-b", "lane-a")])).toEqual(["no mismatched endpoints"])
  })
})
