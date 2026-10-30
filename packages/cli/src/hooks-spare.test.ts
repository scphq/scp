import { Readable } from "node:stream"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RelayClient } from "@scp-dev/broker"
import type { Claim } from "@scp-dev/core"
import { hookModes, testHook } from "./hook-test"
import { spareSocket, unclaimedSpare } from "./identity"

describe("Claude Code background spares", () => {
  test("the claim socket comes from the spare's command line", () => {
    expect(spareSocket("claude bg-spare --bg-spare /tmp/d/a.claim.sock")).toBe("/tmp/d/a.claim.sock")
    expect(spareSocket("/opt/claude/versions/2.1.314 --bg-spare=/tmp/d/b.claim.sock")).toBe("/tmp/d/b.claim.sock")
    expect(spareSocket("claude bg-spare --bg-spare --verbose")).toBeUndefined()
    expect(spareSocket("claude --resume /tmp/d/s.jsonl")).toBeUndefined()
    expect(spareSocket(undefined)).toBeUndefined()
  })

  test("a background session is an unclaimed spare only while its claim socket exists; other sessions never read the process table", () => {
    const args = "claude bg-spare --bg-spare /tmp/d/a.claim.sock"
    const bg = { CLAUDE_CODE_SESSION_KIND: "bg" }
    expect(
      unclaimedSpare(
        bg,
        () => args,
        (path) => path === "/tmp/d/a.claim.sock",
      ),
    ).toBe(true)
    expect(
      unclaimedSpare(
        bg,
        () => args,
        () => false,
      ),
    ).toBe(false)
    expect(
      unclaimedSpare(
        bg,
        () => "claude --resume abc",
        () => true,
      ),
    ).toBe(false)
    let read = false
    const reading = () => {
      read = true
      return args
    }
    expect(unclaimedSpare({}, reading, () => true)).toBe(false)
    expect(read).toBe(false)
  })
})

for (const mode of hookModes)
  describe(`${mode}: a hook in a Claude Code background spare`, () => {
    test("claims nothing while the spare waits to be claimed, and claims as usual once a session took it", async () => {
      const dir = mkdtempSync(join(tmpdir(), "spare-hook-"))
      const socket = join(dir, "a.claim.sock")
      writeFileSync(socket, "")
      const table = new Map([[4242, { ppid: 1, start: "Fri-Oct-30-04:48:14-2026", args: `claude bg-spare --bg-spare ${socket}` }]])
      const claims: Claim[] = []
      let connects = 0
      const client = {
        hello: async (params: { claim: Claim }) => {
          claims.push(params.claim)
          return { endpoint: { title: null } }
        },
        request: async () => ({}),
        close: () => {},
      }
      const run = (event: string) =>
        testHook(mode, ["claude"], {
          env: { CLAUDECODE: "1", CLAUDE_PID: "4242", CLAUDE_CODE_SESSION_KIND: "bg", SCP_DIR: dir, HOME: dir, PATH: process.env.PATH ?? "/usr/bin:/bin" },
          cwd: dir,
          stdin: Readable.from([JSON.stringify({ hook_event_name: event, cwd: dir, session_id: "8d7fe290-a185-47a1-8f50-32cb109856dc" })]),
          connect: async () => {
            connects++
            return client as unknown as RelayClient
          },
          harnessPid: () => 4242,
          psTable: () => table,
          startOf: (pid) => table.get(pid)?.start,
        })
      try {
        await run("SessionStart")
        await run("PostToolUse")
        expect(connects).toBe(0)
        expect(claims).toEqual([])
        rmSync(socket)
        await run("SessionStart")
        expect(connects).toBe(1)
        expect(claims).toHaveLength(1)
        expect(claims[0]).toMatchObject({ session: "pid:4242:Fri-Oct-30-04:48:14-2026", harness: "claude-code" })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
