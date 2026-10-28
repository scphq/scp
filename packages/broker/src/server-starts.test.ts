import { describe, expect, test } from "bun:test"
import { parseStarts } from "./server"

describe("process start table", () => {
  test("reads each pid's start as a harness-instance key spells it and skips lines it cannot read", () => {
    const table = parseStarts(
      ["    1 Mon Oct 26 08:00:01 2026", "  4242 Wed Oct 28 21:58:00 2026  ", "garbage", "  77 ", "  88 bad;start"].join("\n"),
    )
    expect([...table]).toEqual([
      [1, "Mon-Oct-26-08:00:01-2026"],
      [4242, "Wed-Oct-28-21:58:00-2026"],
    ])
  })
})
