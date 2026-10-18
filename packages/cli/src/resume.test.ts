import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"

const uuid = () => "00000000-0000-4000-8000-000000000001"
const ALLOW = ["--allow", "mcp__scp__relay_send"]

test("swarm agy: the name, the pass-through arguments, the first turn as given and resumes on the reported conversation", async () => {
  const { resumeLaunch, turnArgv } = await import("./resume")
  const env = { SCP_SESSION: "outer", SCP_PARENT: "me/p", SCP_HARNESS_PID: "7", SCP_GRANT: "krt_x", KEEP: "1" }
  const launch = resumeLaunch("agy", ["--name", "me/w", "--", "--model", "m", "-p", "hi", "--yolo"], env)
  expect(launch.name).toBe("w")
  expect(launch.first).toEqual(["--model", "m", "-p", "hi", "--yolo"])
  expect(launch.base).toEqual(["--model", "m", "--yolo"])
  expect(launch.id).toBeUndefined()
  expect(launch.env).toMatchObject({ SCP_HARNESS: "agy", SCP_NAME: "w", SCP_GRANT: "krt_x", KEEP: "1" })
  expect(launch.env.SCP_SESSION).toMatch(/^[0-9a-f]{32}$/)
  expect(launch.env.SCP_PARENT).toBeUndefined()
  expect(launch.env.SCP_HARNESS_PID).toBeUndefined()
  expect(turnArgv(launch, "msg", "c1")).toEqual(["--model", "m", "--yolo", "--conversation", "c1", "-p", "msg"])
  expect(turnArgv(launch, "msg")).toEqual(["--model", "m", "--yolo", "-p", "msg"])

  const given = resumeLaunch("agy", ["--as=w", "--conversation=c9", "--prompt", "go"], {})
  expect(given.name).toBe("w")
  expect(given.first).toEqual(["--conversation=c9", "--prompt", "go"])
  expect(given.id).toBe("c9")
  expect(turnArgv(given, "msg")).toEqual(["--conversation", "c9", "-p", "msg"])
  expect(turnArgv(given, "msg", "c9")).toEqual(["--conversation", "c9", "-p", "msg"])
  expect(resumeLaunch("agy", ["--print=x"], {}).first).toEqual(["--print=x"])
  expect(resumeLaunch("agy", [], {}).first).toBeUndefined()
})

test("swarm agy and swarm grok refuse interactive and ambiguous flags, a flag without its value and a bad name", async () => {
  const { resumeLaunch } = await import("./resume")
  for (const flag of ["-i", "--prompt-interactive", "-c", "--continue", "--input-format=stream-json", "--remote-control"])
    expect(() => resumeLaunch("agy", [flag], {})).toThrow("run plain agy")
  expect(() => resumeLaunch("agy", ["remote-control"], {})).toThrow("run plain agy")
  for (const flag of ["-c", "--continue", "--fork-session"]) expect(() => resumeLaunch("grok", ["--", flag], {})).toThrow("run plain grok")
  expect(() => resumeLaunch("agy", ["-p"], {})).toThrow("-p takes a value")
  expect(() => resumeLaunch("grok", ["--resume"], {})).toThrow("--resume takes a value")
  expect(() => resumeLaunch("grok", ["--name"], {})).toThrow("takes a name")
  expect(() => resumeLaunch("grok", ["--name", "Bad Name"], {})).toThrow("not a valid agent handle")
  expect(resumeLaunch("agy", ["-p", "-c"], {}).first).toEqual(["-p", "-c"])
})

test("swarm grok preassigns a session unless one is given, resumes it and adds the relay allow rules unless the user decides", async () => {
  const { resumeLaunch, turnArgv } = await import("./resume")
  const fresh = resumeLaunch("grok", ["--model", "m", "-p", "hi"], {}, uuid)
  expect(fresh.id).toBe(uuid())
  expect(fresh.first?.slice(0, 6)).toEqual(["--model", "m", "-p", "hi", "-s", uuid()])
  expect(fresh.first?.slice(6, 8)).toEqual(ALLOW)
  expect(fresh.base).toEqual(["--model", "m"])
  expect(turnArgv(fresh, "msg", uuid()).slice(0, 6)).toEqual(["--model", "m", "--resume", uuid(), "-p", "msg"])
  expect(turnArgv(fresh, "msg").slice(0, 6)).toEqual(["--model", "m", "-s", uuid(), "-p", "msg"])

  const named = resumeLaunch("grok", ["--session-id", "s1", "--single=hi", "--always-approve"], {}, uuid)
  expect(named.id).toBe("s1")
  expect(named.first).toEqual(["--session-id", "s1", "--single=hi", "--always-approve"])
  expect(named.extra).toEqual([])
  expect(turnArgv(named, "msg")).toEqual(["--always-approve", "-s", "s1", "-p", "msg"])

  const resumed = resumeLaunch("grok", ["-r", "r1"], {}, uuid)
  expect(resumed.id).toBe("r1")
  expect(resumed.first).toBeUndefined()
  expect(turnArgv(resumed, "msg").slice(0, 4)).toEqual(["--resume", "r1", "-p", "msg"])
  expect(turnArgv(resumed, "msg", "r1").slice(0, 4)).toEqual(["--resume", "r1", "-p", "msg"])

  const dashed = resumeLaunch("grok", ["-p", "hi", "--", "extra"], {}, uuid)
  expect(dashed.first?.slice(0, 4)).toEqual(["-p", "hi", "-s", uuid()])
  expect(dashed.first?.slice(-2)).toEqual(["--", "extra"])
  expect(turnArgv(dashed, "msg", "x").slice(-2)).toEqual(["--", "extra"])
})

test("swarm agy refuses to start without the scp agy hooks, project or user", async () => {
  const { agyHooksProblem } = await import("./resume")
  const root = mkdtempSync(join(tmpdir(), "scp-agy-hooks-"))
  try {
    const env = { HOME: root }
    const project = join(root, "proj")
    mkdirSync(join(project, ".agents"), { recursive: true })
    expect(agyHooksProblem(env, project)).toContain("setup --write")
    writeFileSync(join(project, ".agents", "hooks.json"), JSON.stringify({ other: { SessionStart: [{}] } }))
    expect(agyHooksProblem(env, project)).toContain("setup --write")
    writeFileSync(join(project, ".agents", "hooks.json"), JSON.stringify({ scp: { enabled: true, SessionStart: [{ type: "command" }] } }))
    expect(agyHooksProblem(env, project)).toBeUndefined()
    rmSync(join(project, ".agents", "hooks.json"))
    mkdirSync(join(root, ".gemini", "config"), { recursive: true })
    writeFileSync(join(root, ".gemini", "config", "hooks.json"), JSON.stringify({ scp: { enabled: false, SessionStart: [{}] } }))
    expect(agyHooksProblem(env, project)).toContain("setup --write")
    writeFileSync(join(root, ".gemini", "config", "hooks.json"), JSON.stringify({ scp: { SessionStart: [{}] } }))
    expect(agyHooksProblem(env, project)).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an agy hook under swarm agy records the first root conversation once, never a subagent's", async () => {
  const { recordAgyConversation, runHook } = await import("./hooks")
  const root = mkdtempSync(join(tmpdir(), "scp-agy-conv-"))
  try {
    const file = join(root, "conversation")
    const env = { SCP_AGY_CONVERSATION_FILE: file }
    recordAgyConversation({ conversationId: "sub", parentConversationId: "c1" }, env)
    recordAgyConversation({ conversation_id: "sub", parent_conversation_id: "c1" }, env)
    recordAgyConversation({ conversationId: "-flag" }, env)
    expect(existsSync(file)).toBe(false)
    recordAgyConversation({ conversationId: "c1" }, env)
    recordAgyConversation({ conversationId: "c2" }, env)
    expect(readFileSync(file, "utf8")).toBe("c1")
    recordAgyConversation({ conversationId: "c3" }, {})

    const fromEnv = join(root, "env")
    recordAgyConversation({}, { SCP_AGY_CONVERSATION_FILE: fromEnv, ANTIGRAVITY_CONVERSATION_ID: "c4" })
    expect(readFileSync(fromEnv, "utf8")).toBe("c4")

    const hooked = join(root, "hooked")
    await runHook(["agy", "SessionStart"], {
      env: { SCP_AGY_CONVERSATION_FILE: hooked, SCP_TRANSPORT: "cloud" },
      cwd: root,
      stdin: Readable.from([JSON.stringify({ conversationId: "c5" })]),
      connect: () => Promise.reject(new Error("no broker")),
    })
    expect(readFileSync(hooked, "utf8")).toBe("c5")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the MCP shim takes $SCP_HARNESS_PID as its harness only when that pid started its harness process", async () => {
  const { launcherPid } = await import("./identity")
  const parentOf = (pid: number) => (pid === 50 ? { ppid: 40, comm: "agy" } : undefined)
  expect(launcherPid({ SCP_HARNESS_PID: "40" }, () => 50, parentOf)).toBe(40)
  expect(launcherPid({ SCP_HARNESS_PID: "41" }, () => 50, parentOf)).toBeUndefined()
  expect(launcherPid({ SCP_HARNESS_PID: "40" }, () => 51, parentOf)).toBeUndefined()
  expect(
    launcherPid(
      { SCP_HARNESS_PID: "1" },
      () => 50,
      () => ({ ppid: 1, comm: "init" }),
    ),
  ).toBeUndefined()
  expect(launcherPid({ SCP_HARNESS_PID: "x" }, () => 50, parentOf)).toBeUndefined()
  expect(launcherPid({}, () => 50, parentOf)).toBeUndefined()
})
