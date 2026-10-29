import { describe, expect, test } from "bun:test"
import { forkOrigin, type PsCommTable, relayIdentity } from "./identity"

const OLD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const NEW = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c"
const START = "Thu-Oct-15-10:00:00-2026"

describe("forkOrigin", () => {
  test("is the session --resume names with --fork-session, by id or transcript path", () => {
    expect(forkOrigin(`claude --fork-session --resume ${OLD}`)).toBe(OLD)
    expect(forkOrigin(`claude -r ${OLD} --fork-session`)).toBe(OLD)
    expect(forkOrigin(`claude --resume=${OLD} --fork-session`)).toBe(OLD)
    expect(forkOrigin(`node /opt/claude --fork-session --resume /home/u/.claude/projects/p/${OLD}.jsonl`)).toBe(OLD)
  })

  test("is none without --fork-session, without a value, or for an invalid id", () => {
    expect(forkOrigin(`claude --resume ${OLD}`)).toBeUndefined()
    expect(forkOrigin("claude --fork-session --resume")).toBeUndefined()
    expect(forkOrigin("claude --fork-session --resume --verbose")).toBeUndefined()
    expect(forkOrigin("claude --fork-session --resume /tmp/.jsonl")).toBeUndefined()
    expect(forkOrigin(undefined)).toBeUndefined()
  })
})

describe("relayIdentity", () => {
  const claim = (args: string, harnessSession = NEW, env: Record<string, string> = {}) =>
    relayIdentity({
      harness: "claude-code",
      fallbackHarness: "hook",
      cwd: "/work",
      env,
      harnessSession,
      harnessPid: () => 40,
      startOf: () => START,
      lineageOf: () => [],
      t3Hosted: () => false,
      psTable: (): PsCommTable => new Map([[40, { ppid: 1, start: START, args }]]),
    })

  test("a forked Claude Code harness claims the session it forks as its origin", () => {
    expect(claim(`claude --fork-session --resume ${OLD}`)).toMatchObject({ harness_session: NEW, harness_origin: OLD })
  })

  test("a plain resume, or a fork of the session itself, claims no origin", () => {
    expect(claim(`claude --resume ${OLD}`).harness_origin).toBeUndefined()
    expect(claim(`claude --fork-session --resume ${NEW}`).harness_origin).toBeUndefined()
  })

  test("the background session a terminal session moved to claims a hand-off of its origin", () => {
    const fork = `claude --session-id ${NEW} --fork-session --resume ${OLD}`
    const moved = { CLAUDE_CODE_SESSION_KIND: "bg", CLAUDE_BG_SOURCE: "slash" }
    expect(claim(fork, NEW, moved)).toMatchObject({ harness_session: NEW, harness_origin: OLD, harness_handoff: true })
    expect(claim(`claude --resume ${OLD}`, NEW, moved).harness_handoff).toBeUndefined()
  })

  test("a fork run from a terminal, or started in the background by other means, is a parallel fork", () => {
    const fork = `claude --fork-session --resume ${OLD}`
    expect(claim(fork).harness_handoff).toBeUndefined()
    expect(claim(fork, NEW, { CLAUDE_CODE_SESSION_KIND: "bg" }).harness_handoff).toBeUndefined()
    expect(claim(fork, NEW, { CLAUDE_CODE_SESSION_KIND: "bg", CLAUDE_BG_SOURCE: "cli" }).harness_handoff).toBeUndefined()
  })
})
