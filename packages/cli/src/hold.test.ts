import { describe, expect, test } from "bun:test"
import type { Envelope } from "@scp-dev/core"
import { RelayUsage } from "./common"
import { firstRun, framed, idleSeconds, parseHoldRef, refProblem, resumable, resumeBase, resumeSession, wokeBy } from "./hold"

const uuid = () => "11111111-2222-3333-4444-555555555555"

describe("a held worker's resume", () => {
  test("codex exec resumes as exec resume <session>, its prompt last; an ephemeral or prompt-less codex and claude do not", () => {
    expect(resumeBase(["codex", "exec", "-m", "o4", "-i", "shot.png", "do it"], "019a-s")).toEqual(["codex", "exec", "resume", "-m", "o4", "019a-s"])
    expect(resumeBase(["env", "A=1", "codex", "exec", "go"], "019a-s")).toEqual(["env", "A=1", "codex", "exec", "resume", "019a-s"])
    expect(resumeBase(["codex", "exec", "--ephemeral", "go"], "019a-s")).toBeUndefined()
    expect(resumeBase(["codex", "exec"], "019a-s")).toBeUndefined()
    expect(resumeBase(["claude", "-p", "go"], "019a-s")).toBeUndefined()
    expect(resumeBase(["codex", "exec", "go"], "bad session")).toBeUndefined()
    expect([resumable(["/opt/bin/codex", "exec", "go"]), resumable(["claude", "-p", "go"])]).toEqual(["codex", undefined])
  })

  test("agy resumes with --conversation <id> -p; grok with --resume <id>, its allow rules, -p; neither when interactive", () => {
    expect(resumeBase(["agy", "-p", "hi", "--model", "m"], "conv-1")).toEqual(["agy", "--model", "m", "--conversation", "conv-1", "-p"])
    expect(resumeBase(["agy", "-i", "hi"], "conv-1")).toBeUndefined()
    expect(resumeBase(["agy", "--model", "m"], "conv-1")).toBeUndefined()
    const grok = resumeBase(["grok", "-p", "hi", "-s", "old"], "sess-1")!
    expect(grok.slice(0, 3)).toEqual(["grok", "--resume", "sess-1"])
    expect(grok).toContain("--allow")
    expect(grok.at(-1)).toBe("-p")
    expect(grok).not.toContain("old")
    expect(resumeBase(["grok", "-p", "hi", "--always-approve"], "sess-1")).toEqual(["grok", "--always-approve", "--resume", "sess-1", "-p"])
    expect(resumeBase(["grok", "-c"], "sess-1")).toBeUndefined()
  })

  test("muse exec resumes as exec --session-id <id>, without the first prompt's file, images and worktree; not without a session log", () => {
    expect(resumeBase(["muse", "--model", "m", "exec", "--yolo", "--image", "a.png", "-w", "create", "--prompt-file", "p.md"], "s-1")).toEqual([
      "muse",
      "--model",
      "m",
      "exec",
      "--yolo",
      "--session-id",
      "s-1",
    ])
    expect(resumeBase(["muse", "exec", "--session-id=old", "-c", "a=1", "--", "go"], "s-1")).toEqual(["muse", "exec", "-c", "a=1", "--session-id", "s-1"])
    for (const off of [["--no-session-log"], ["--api-key-stdin"]]) expect(resumeBase(["muse", "exec", ...off, "go"], "s-1")).toBeUndefined()
    expect(resumeBase(["muse", "resume", "--last"], "s-1")).toBeUndefined()
    expect(resumeBase(["muse", "exec", "go", "on"], "s-1")).toBeUndefined()
  })

  test("a muse exec's first run names a new session after exec unless it has one; one without a session log names none", () => {
    expect(firstRun(["muse", "--model", "m", "exec", "--json", "go"], uuid)).toEqual({
      command: ["muse", "--model", "m", "exec", "--session-id", uuid(), "--json", "go"],
      session: uuid(),
    })
    expect(firstRun(["muse", "exec", "--session-id", "mine", "go"], uuid)).toEqual({ command: ["muse", "exec", "--session-id", "mine", "go"], session: "mine" })
    expect(firstRun(["muse", "exec", "--no-session-log", "go"], uuid)).toEqual({ command: ["muse", "exec", "--no-session-log", "go"] })
    expect(firstRun(["muse", "--session-id", "top", "exec", "go"], uuid)).toEqual({ command: ["muse", "--session-id", "top", "exec", "go"], session: "top" })
    expect(firstRun(["muse", "exec", "-c", "--session-id", "go"], uuid)).toEqual({
      command: ["muse", "exec", "--session-id", uuid(), "-c", "--session-id", "go"],
      session: uuid(),
    })
    expect(firstRun(["muse", "exec", "-c", "--no-session-log", "go"], uuid).session).toBe(uuid())
    expect(resumeBase(["muse", "--session-id", "top", "exec", "go"], "top")).toEqual(["muse", "exec", "--session-id", "top"])
    expect(resumeBase(["muse", "exec", "-c", "--session-id", "go"], "s-1")).toEqual(["muse", "exec", "-c", "--session-id", "--session-id", "s-1"])
  })

  test("a grok's first run names a new session unless it has one; agy's session is its hook's, else its own --conversation", () => {
    const opened = firstRun(["grok", "-p", "hi"], uuid)
    expect(opened.session).toBe(uuid())
    expect(opened.command.slice(0, 5)).toEqual(["grok", "-p", "hi", "-s", uuid()])
    expect(firstRun(["grok", "-s", "mine", "-p", "hi"], uuid)).toMatchObject({ session: "mine", command: expect.not.arrayContaining([uuid()]) })
    expect(firstRun(["codex", "exec", "go"], uuid)).toEqual({ command: ["codex", "exec", "go"] })
    expect(resumeSession(["agy", "-p", "hi", "--conversation", "c-9"], undefined)).toBe("c-9")
    expect(resumeSession(["agy", "-p", "hi", "--conversation", "c-9"], "c-hook")).toBe("c-hook")
    expect(resumeSession(["codex", "exec", "go"], null)).toBeUndefined()
  })

  test("a durable ref parses only as spawn wrote it, fits the wake ref cap and holds no credential", () => {
    const ref = { harness: "codex", session: "019a-s", cwd: "/w", argv: ["/bin/codex", "exec", "resume", "019a-s"], idle_s: 1800, parent: "me/lead" }
    expect(parseHoldRef(JSON.stringify(ref))).toEqual(ref as never)
    expect(parseHoldRef(JSON.stringify({ ...ref, idle_s: null }))?.idle_s).toBeNull()
    for (const bad of [
      { ...ref, harness: "muse" },
      { ...ref, argv: ["/bin/agy", "-p"] },
      { ...ref, cwd: "rel" },
      { ...ref, session: "a b" },
      { ...ref, idle_s: 0 },
      { ...ref, parent: "" },
    ])
      expect(parseHoldRef(JSON.stringify(bad))).toBeUndefined()
    expect(parseHoldRef("not json")).toBeUndefined()
    expect(refProblem(JSON.stringify(ref))).toBeUndefined()
    expect(refProblem("x".repeat(513))).toContain("over 512")
    expect(refProblem(JSON.stringify({ ...ref, argv: ["codex", "-c", "token=ghp_aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2y"] }))).toContain("credential")
  })

  test("--idle takes seconds, a duration or Infinity, and 0 for no hold", () => {
    expect([idleSeconds("90"), idleSeconds("30m"), idleSeconds("Infinity"), idleSeconds("0")]).toEqual([90, 1800, Number.POSITIVE_INFINITY, 0])
    expect(() => idleSeconds("soon")).toThrow(RelayUsage)
  })

  test("a batch resumes as channel pushes joined by a blank line; the parent's newest message is the one it answers", () => {
    const message = (id: string, text: string, relation?: "parent") =>
      ({
        id,
        thread: "thr_x",
        reply_to: null,
        kind: "message",
        from: { address: relation ? "me/lead" : "me/peer", endpoint: "ep", user: "me", auth: "local-uid", claims: { harness: null, model: null } },
        to: "me/w",
        body: { text, mime: "text/plain" },
        data_class: "public",
        attachments: [],
        hop: 0,
        created_at: "2026-10-20T10:00:00.000Z",
        expires_at: "2026-10-27T10:00:00.000Z",
        ...(relation ? { relation } : {}),
      }) as Envelope
    const batch = [message("msg_1", "first", "parent"), message("msg_2", "second", "parent"), message("msg_3", "third")]
    const prompt = framed(batch)
    expect(prompt.split("<relay-message").length - 1).toBe(3)
    expect(prompt.indexOf("first")).toBeLessThan(prompt.indexOf("third"))
    expect(wokeBy(batch)).toBe("msg_2")
    expect(wokeBy([message("msg_3", "third")])).toBeUndefined()
  })
})
