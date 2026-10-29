import { describe, expect, test } from "bun:test"
import { relinkReport } from "./relink"

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
