import { describe, expect, test } from "bun:test"
import { HANDBACK_CUT, handbackOutput } from "./handback"
import { LIMITS } from "./protocol"

const size = (text: string) => new TextEncoder().encode(text).length

/** a line of `chars` characters: prose with markup, `<`, `&` and non-ASCII, ending mid-thought */
const line = (n: number, chars: number) => {
  const words = `- ${n}: the parser keeps <XlsxEditor> & a < b && c > d; but it isn't the prompt, ç'est la vie, see src/relay-spawn.ts:42 `
  return words
    .repeat(Math.ceil(chars / words.length))
    .slice(0, chars)
    .trimEnd()
}

const REPORT = ["Summary:", line(1, 80), line(2, 250), line(3, 120), line(4, 600), line(5, 60), line(6, 1200), line(7, 300), line(8, 900), "", "Done."].join(
  "\n",
)

describe("a handback's output", () => {
  test("a 4 KB report with lines past 200, 500 and 1000 characters comes back byte for byte; escape sequences alone are cleaned", () => {
    expect(size(REPORT)).toBeGreaterThan(3500)
    expect(size(REPORT)).toBeLessThan(LIMITS.handbackBytes / 2)
    expect(handbackOutput(REPORT)).toBe(REPORT)
    expect(handbackOutput(REPORT.replaceAll("Summary:", "\u001b[1mSummary:\u001b[0m").replaceAll(" & ", " \u001b[31m&\u001b[0m "))).toBe(REPORT)
  })

  test("past the cap it keeps the last whole lines behind the cut marker on its own line, the end intact", () => {
    const big = Array.from({ length: 6 }, (_, i) => REPORT.replace("Summary:", `Summary ${i}:`)).join("\n")
    const out = handbackOutput(big)
    expect(size(out)).toBeLessThanOrEqual(LIMITS.handbackBytes)
    expect(out.startsWith(`${HANDBACK_CUT}\n`)).toBe(true)
    const kept = out.slice(HANDBACK_CUT.length + 1)
    expect(big.endsWith(`\n${kept}`)).toBe(true)
    expect(size(kept)).toBeGreaterThan(LIMITS.handbackBytes - 1300)
    expect(handbackOutput(big, false, 64)).toBe(`${HANDBACK_CUT}\nDone.`)
  })

  test("one line longer than the cap keeps its last characters behind the marker; a cap too small for the marker keeps only text", () => {
    const out = handbackOutput(`head\n${"é".repeat(9000)}end`)
    expect(out.startsWith(`${HANDBACK_CUT}\né`)).toBe(true)
    expect(out.endsWith("éend")).toBe(true)
    expect(size(out)).toBeLessThanOrEqual(LIMITS.handbackBytes)
    expect(handbackOutput("abcdefghij\nklmnop", false, 8)).toBe("klmnop")
    expect(handbackOutput("abcdefghijklmnop", false, 8)).toBe("ijklmnop")
  })

  test("output that already lost its start is marked even when the rest fits", () => {
    expect(handbackOutput("tial line\nwhole line\nlast", true)).toBe(`${HANDBACK_CUT}\nwhole line\nlast`)
  })

  test("a secret mid-line is redacted and the rest of the line stays", () => {
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`
    expect(handbackOutput(`- rotated ${secret} yesterday, but it isn't the prompt that failed\n- next`)).toBe(
      "- rotated [redacted github token] yesterday, but it isn't the prompt that failed\n- next",
    )
    expect(handbackOutput("- set password=hunter2hunter2hunter2x9 then it isn't the prompt either\n- next")).toBe(
      "- set [redacted assigned secret] then it isn't the prompt either\n- next",
    )
  })
})
