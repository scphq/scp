import { Readable } from "node:stream"
import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type ActivityRow, LIMITS, PREAMBLE, PREAMBLE_BRIEF } from "@scp-dev/core"
import { type Broker, localHostName, RelayClient, socketPath, startBroker, systemHostname } from "@scp-dev/broker"
import {
  BLOCK_STOP,
  claudeVersionFile,
  hookReply,
  mapHookPayload,
  opencodePlugin,
  promptTitle,
  runHook,
  stopContinues,
  SUBAGENT,
  subagentIntro,
  summarize,
  TLDR,
  transcriptTitle,
} from "./hooks"
import { readCapped, STDIN_CAP, subagentSkip } from "./hook-fast"
import {
  deriveHandle,
  detectHarness,
  harnessAt,
  harnessOf,
  hookHarness,
  hookHarnessPid,
  labelsFor,
  processKey,
  psStart,
  relayIdentity,
  resolveHarness,
  sessionKey,
  shortHostname,
  toHandle,
} from "./identity"

setDefaultTimeout(30_000)

const entry = join(import.meta.dir, "cli.ts")
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_THREAD_ID)/
const SECRET = `ghp_${"A1b2C3d4".repeat(5)}`

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) env[key] = value
  return { ...env, ...extra }
}

async function hook(args: string[], payload: unknown, env: Record<string, string>) {
  const started = Date.now()
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, "hook", ...args], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv(env),
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code, ms: Date.now() - started }
}

describe("relay identity", () => {
  test("the handle is <harness short>-<worktree>, from the git toplevel, a linked worktree, or the cwd", () => {
    const root = mkdtempSync(join(process.env.HOME!, "ident-"))
    const repo = join(root, "My Repo+x")
    mkdirSync(join(repo, ".git"), { recursive: true })
    mkdirSync(join(repo, "packages", "deep"), { recursive: true })
    expect(deriveHandle("claude-code", join(repo, "packages", "deep"))).toBe("claude-my-repo-x")
    const worktree = join(root, "relay-1b")
    mkdirSync(worktree)
    writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/relay-1b\n")
    expect(deriveHandle("codex", worktree)).toBe("codex-relay-1b")
    const plain = join(root, "no git here")
    mkdirSync(plain)
    expect(deriveHandle("opencode", plain)).toMatch(/^opencode-/)
    expect(toHandle("me")).toBe("me-agent")
    expect(toHandle("--Weird__NAME!!")).toBe("weird__name")
    expect(toHandle("x".repeat(80))).toHaveLength(63)
  })

  test("harness: explicit wins, then grok, muse, opencode, claude-code, codex markers, then the fallback", () => {
    expect(detectHarness({ CLAUDECODE: "1", GROK_SESSION_ID: "g" })).toBe("grok")
    expect(detectHarness({ CLAUDECODE: "1", GROK_HOOK_EVENT: "post_tool_use" })).toBe("grok")
    expect(detectHarness({ MUSE_SESSION_ID: "m", OPENCODE: "1" })).toBe("muse")
    expect(detectHarness({ OPENCODE: "1", CLAUDECODE: "1" })).toBe("opencode")
    expect(detectHarness({ CLAUDECODE: "1" })).toBe("claude-code")
    expect(detectHarness({ CODEX_THREAD_ID: "t" })).toBe("codex")
    expect(detectHarness({ CLAUDECODE: "1", ANTIGRAVITY_AGENT: "1" })).toBe("agy")
    expect(detectHarness({ ANTIGRAVITY_CONVERSATION_ID: "c1" })).toBe("agy")
    expect(resolveHarness(undefined, {}, "claude")).toBe("claude-code")
    expect(resolveHarness(undefined, { SCP_HARNESS: "Rev Agent" }, "mcp")).toBe("rev-agent")
    expect(resolveHarness("codex", { CLAUDECODE: "1" }, "mcp")).toBe("codex")
    expect(resolveHarness(undefined, {}, "mcp")).toBe("mcp")
  })

  test("a harness process's command line names its harness: its program, or the script an interpreter runs", () => {
    expect(harnessOf("claude --dangerously-skip-permissions")).toBe("claude-code")
    expect(harnessOf("/opt/homebrew/bin/codex exec hi")).toBe("codex")
    expect(harnessOf("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe("claude-code")
    expect(harnessOf("node /usr/local/lib/node_modules/@openai/codex/bin/codex.js")).toBe("codex")
    expect(harnessOf("bun /home/u/.bun/install/global/node_modules/opencode-ai/bin/opencode")).toBe("opencode")
    expect(harnessOf("pi --model x")).toBe("pi")
    expect(harnessOf("node /usr/lib/node_modules/pi-coding-agent/dist/cli.js")).toBe("pi")
    for (const name of ["muse", "agy", "grok", "gemini"]) expect(harnessOf(`${name} chat`)).toBe(name)
    expect(harnessOf("node /home/pi/scripts/run.js")).toBeUndefined()
    expect(harnessOf("vim claude.md")).toBeUndefined()
    expect(harnessOf("node constructor")).toBeUndefined()
    expect(harnessOf(undefined)).toBeUndefined()
    const table = new Map([[4242, { ppid: 1, start: "Mon", args: "codex resume" }]])
    const detect = process.env.SCP_HARNESS_DETECT
    try {
      delete process.env.SCP_HARNESS_DETECT
      expect(harnessAt(4242, table)).toBe("codex")
    } finally {
      process.env.SCP_HARNESS_DETECT = detect
    }
    expect(harnessAt(4242, table)).toBeUndefined()
  })

  test("a claim that names and detects no harness takes the harness process's, never over a named or detected one", () => {
    const claim = (harness: string | undefined, env: Record<string, string>) =>
      relayIdentity({
        ...(harness ? { harness } : {}),
        fallbackHarness: "mcp",
        cwd: "/tmp/repo",
        env,
        harnessPid: () => 4242,
        startOf: () => "Mon",
        lineageOf: () => [],
        inferHarness: () => "codex",
      })
    expect(claim(undefined, {})).toMatchObject({ harness: "codex", handle: "codex-repo" })
    expect(claim("hook", {})).toMatchObject({ harness: "codex" })
    expect(claim(undefined, { CLAUDECODE: "1" }).harness).toBe("claude-code")
    expect(claim("opencode", {}).harness).toBe("opencode")
    expect(claim(undefined, { SCP_HARNESS: "pi" }).harness).toBe("pi")
  })

  test("a hook's harness is its argument; only Grok's markers relabel a Claude Code hook", () => {
    const claude = { CLAUDECODE: "1", CLAUDE_PID: "777" }
    expect(hookHarness("codex", claude)).toBe("codex")
    expect(hookHarness("agy", claude)).toBe("agy")
    expect(hookHarness("opencode", { ...claude, SCP_HARNESS: "claude" })).toBe("opencode")
    expect(hookHarness("claude", claude)).toBe("claude-code")
    expect(hookHarness("claude", { GROK_SESSION_ID: "g" })).toBe("grok")
    expect(hookHarness("codex", { GROK_HOOK_EVENT: "post_tool_use" })).toBe("codex")
    expect(hookHarness(undefined, claude)).toBe("claude-code")
    expect(hookHarness(undefined, {})).toBe("hook")
  })

  test("session and process keys, labels and the hook's harness pid", () => {
    expect(sessionKey({ SCP_SESSION: "lane-7" }, "pid:42")).toBe("env:lane-7")
    expect(sessionKey({ SCP_SESSION: "pid:42:Wed-Oct-15-10:00:00-2026" }, "pid:42")).toBe("env:pid:42:Wed-Oct-15-10:00:00-2026")
    expect(sessionKey({}, "pid:42:Wed-Oct-15-10:00:00-2026")).toBe("pid:42:Wed-Oct-15-10:00:00-2026")
    expect(processKey(42, () => undefined)).toBe("pid:42")
    expect(processKey(42, () => "Wed-Oct-15-10:00:00-2026")).toBe("pid:42:Wed-Oct-15-10:00:00-2026")
    expect(processKey(42, () => "Thu-Oct-16-09:00:00-2026")).not.toBe(processKey(42, () => "Wed-Oct-15-10:00:00-2026"))
    expect(psStart(process.pid)).toMatch(/^[A-Za-z0-9:-]+$/)
    expect(psStart(process.pid)).toBe(psStart(process.pid))
    expect(processKey(process.pid)).toBe(`pid:${process.pid}:${psStart(process.pid)}`)
    const path = process.env.PATH
    try {
      process.env.PATH = "/nonexistent"
      expect(psStart(process.pid)).toBeUndefined()
      expect(processKey(42)).toBe("pid:42")
    } finally {
      process.env.PATH = path
    }
    expect(labelsFor({ SCP_LABELS: "role=impl, lane=relay,Bad Key=x,novalue" }, "box")).toEqual({ role: "impl", lane: "relay", machine: "box" })
    expect(labelsFor({ SCP_LABELS: "machine=vm-3" }, "box")).toEqual({ machine: "vm-3" })
    const ran: string[][] = []
    const scutil = (exitCode: number, stdout: string) => (cmd: string[]) => {
      ran.push(cmd)
      return { exitCode, stdout }
    }
    expect(localHostName(scutil(0, "Ada-MacBook-Pro\n"))).toBe("Ada-MacBook-Pro")
    expect(localHostName(scutil(1, ""))).toBeUndefined()
    expect(ran).toEqual([
      ["scutil", "--get", "LocalHostName"],
      ["scutil", "--get", "LocalHostName"],
    ])
    expect(
      systemHostname(
        "darwin",
        () => "Ada-MacBook-Pro",
        () => "mac",
      ),
    ).toBe("Ada-MacBook-Pro")
    expect(
      systemHostname(
        "darwin",
        () => undefined,
        () => "mac.local",
      ),
    ).toBe("mac.local")
    expect(
      systemHostname(
        "linux",
        () => "never read",
        () => "box.lan",
      ),
    ).toBe("box.lan")
    expect(shortHostname("Ada-MacBook-Pro")).toBe("ada-macbook-pro")
    expect(labelsFor({})).toEqual({ machine: shortHostname() })
    const parents = (comm: string) => () => ({ ppid: 900, comm })
    expect(hookHarnessPid({ CLAUDE_PID: "777" }, "claude-code", 500, parents("sh"))).toBe(777)
    expect(hookHarnessPid({ CLAUDE_PID: "777" }, "grok", 500, parents("/bin/sh"))).toBe(900)
    expect(hookHarnessPid({ OPENCODE_PID: "555" }, "opencode", 500, parents("node"))).toBe(555)
    expect(hookHarnessPid({}, "codex", 500, parents("-zsh"))).toBe(900)
    expect(hookHarnessPid({}, "codex", 500, parents("codex"))).toBe(500)
    const claim = relayIdentity({
      fallbackHarness: "claude",
      cwd: "/tmp",
      env: { SCP_PARENT: "me/lead", SCP_NAME: "lane-impl" },
      harnessPid: () => 31,
      startOf: () => "Wed-Oct-15-10:00:00-2026",
    })
    expect(claim).toMatchObject({
      handle: "lane-impl",
      harness: "claude-code",
      session: "pid:31:Wed-Oct-15-10:00:00-2026",
      process: "pid:31:Wed-Oct-15-10:00:00-2026",
      parent: "me/lead",
      cwd: "/tmp",
    })
    const explicit = relayIdentity({
      fallbackHarness: "claude",
      cwd: "/tmp",
      env: { SCP_SESSION: "lane-7" },
      harnessPid: () => 31,
      startOf: () => "Wed-Oct-15-10:00:00-2026",
    })
    expect(explicit).toMatchObject({ session: "env:lane-7", process: "pid:31:Wed-Oct-15-10:00:00-2026" })
  })

  test("a Claude Code claim carries the harness session: the hook payload's id, else $CLAUDE_CODE_SESSION_ID; other harnesses none", () => {
    const base = { fallbackHarness: "claude", cwd: "/tmp", harnessPid: () => 31, startOf: () => "Wed-Oct-15-10:00:00-2026" }
    const env = { CLAUDE_CODE_SESSION_ID: "env-session" }
    expect(relayIdentity({ ...base, env }).harness_session).toBe("env-session")
    expect(relayIdentity({ ...base, env, harnessSession: "payload-session" }).harness_session).toBe("payload-session")
    expect(relayIdentity({ ...base, env, harnessSession: "not a session id" }).harness_session).toBe("env-session")
    expect(relayIdentity({ ...base, env: {} }).harness_session).toBeUndefined()
    expect(relayIdentity({ ...base, env, harness: "codex" }).harness_session).toBeUndefined()
  })
})

describe("hook stdin", () => {
  test("joins Node string and byte chunks before decoding UTF-8", async () => {
    const bytes = Buffer.from("héllo")
    expect(await readCapped(Readable.from([bytes.subarray(0, 2), bytes.subarray(2), "!"]))).toBe("héllo!")
  })

  test("caps stdin in bytes and closes the source without waiting for EOF", async () => {
    let closed = false
    async function* chunks() {
      try {
        yield Buffer.alloc(STDIN_CAP - 1, "a")
        yield "bc"
        throw new Error("read past the cap")
      } finally {
        closed = true
      }
    }
    const text = await readCapped(chunks())
    expect(Buffer.byteLength(text)).toBe(STDIN_CAP)
    expect(text.endsWith("ab")).toBe(true)
    expect(closed).toBe(true)
  })
})

describe("hook payload mapping", () => {
  test("summaries carry a program name, a subagent's type, a file's basename or a host, never arguments or output", () => {
    expect(summarize("Bash", { command: `curl -H "Authorization: token ${SECRET}" https://x.dev`, description: "Fetch the release notes" })).toBe("curl")
    expect(summarize("Bash", { command: `FOO=1 /usr/bin/curl -H "x: ${SECRET}"` })).toBe("curl")
    expect(summarize("Edit", { file_path: "/repo/src/secret-plans.ts", old_string: "a", new_string: "b" })).toBe("secret-plans.ts")
    expect(summarize("Grep", { pattern: "password" })).toBeUndefined()
    expect(summarize("WebFetch", { url: "https://docs.example.com/a?token=x" })).toBe("docs.example.com")
    expect(summarize("mcp__x__y", { anything: 1 })).toBeUndefined()
    expect(summarize("Task", { description: `Push with ${SECRET}`, subagent_type: "general-purpose", prompt: "x" })).toBe("general-purpose")
    expect(summarize("Agent", { description: "Rotate the hunter2-correct-horse key" })).toBeUndefined()
    expect(summarize("Task", { subagent_type: "x y" })).toBeUndefined()
    expect(summarize("Task", { subagent_type: "x".repeat(65) })).toBeUndefined()
    expect(summarize("Bash", { description: `use ${SECRET} here` })).toBeUndefined()
  })

  test("a Bash summary is a plain program word or nothing, never a piece of a quoted value", () => {
    const bash = (command: unknown) => summarize("Bash", { command })
    expect(bash('API_KEY="abc hunter2-correct-horse" curl https://x.dev')).toBe("curl")
    expect(bash("API_KEY='abc hunter2-correct-horse' TOKEN=x\\ y ./deploy.sh --prod")).toBe("deploy.sh")
    expect(bash('API_KEY="abc hunter2-correct-horse curl')).toBeUndefined()
    expect(bash('"hunter2 correct" --x')).toBeUndefined()
    expect(bash("(cd /x && make)")).toBeUndefined()
    expect(bash("$(printf secret) run")).toBeUndefined()
    expect(bash("A=1")).toBeUndefined()
    expect(bash(["bash", "-lc", 'API_KEY="abc hunter2" curl'])).toBe("bash")
    expect(bash(["API_KEY=abc hunter2", "curl"])).toBe("curl")
    expect(bash(["echo hunter2"])).toBeUndefined()
    expect(bash('FOO=1 "hunter2-correct-horse"')).toBeUndefined()
    expect(bash('"/tmp/hunter2-correct-horse" --x')).toBeUndefined()
    expect(bash("hun\\ter2-correct-horse")).toBeUndefined()
    expect(bash("/usr/bin/env FOO=1 make")).toBe("env")
    expect(bash("-phunter2-correct-horse db")).toBeUndefined()
    expect(bash(["-phunter2-correct-horse"])).toBeUndefined()
    expect(summarize("Bash", { command: "git status", description: "Push with hunter2-correct-horse" })).toBe("git")
  })

  test("Claude snake_case and Grok camelCase payloads map to one event; unknown events to none", () => {
    expect(mapHookPayload({ hook_event_name: "SessionStart", source: "resume", cwd: "/w" })).toEqual({
      kind: "session_start",
      summary: "resume",
      status: "working",
      cwd: "/w",
    })
    expect(
      mapHookPayload({
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/a/b.ts" },
        agent_id: "3f2a9c77ee",
        agent_type: "Explore",
      }),
    ).toEqual({ kind: "tool", tool: "Read", summary: "b.ts", agent: "Explore 3f2a9c" })
    expect(mapHookPayload({ hookEventName: "post_tool_use", toolName: "Bash", toolInput: { command: "ls -la" } })).toMatchObject({
      kind: "tool",
      tool: "Bash",
      summary: "ls",
    })
    expect(mapHookPayload({ hook_event_name: "SubagentStop", agent_id: "abcdef12", agent_type: "Plan" })).toEqual({ kind: "stop", agent: "Plan abcdef" })
    expect(mapHookPayload({ hook_event_name: "SessionEnd", reason: "other" })).toEqual({ kind: "session_end", status: "done" })
    expect(mapHookPayload({}, "Stop")).toEqual({ kind: "stop" })
    expect(mapHookPayload({ hook_event_name: "UserPromptSubmit", prompt: "secret" })).toEqual({ kind: "prompt" })
    expect(mapHookPayload({ conversationId: "c1", invocationNum: 2 }, "PreInvocation")).toEqual({ kind: "prompt" })
    expect(mapHookPayload({ hook_event_name: "Notification", message: "x" })).toBeNull()
    const agy = { conversationId: "c1", workspacePaths: ["/w/repo", "/w/other"], transcriptPath: "/t" }
    expect(mapHookPayload({ ...agy, toolCall: { name: "Read", args: { file_path: "/w/repo/a.go" } }, stepIdx: 3 }, "PostToolUse")).toEqual({
      kind: "tool",
      tool: "Read",
      summary: "a.go",
      cwd: "/w/repo",
    })
    expect(mapHookPayload({ ...agy, toolCall: { name: "run_command", args: { CommandLine: `curl ${SECRET}` } } }, "PostToolUse")).toEqual({
      kind: "tool",
      tool: "run_command",
      cwd: "/w/repo",
    })
    expect(mapHookPayload({ ...agy, terminationReason: "done", fullyIdle: true }, "Stop")).toEqual({ kind: "stop", cwd: "/w/repo" })
    expect(mapHookPayload(agy, "SessionStart")).toMatchObject({ kind: "session_start", status: "working" })
  })
})

describe("swarm hook", () => {
  let broker: Broker
  const dir = join(process.env.HOME!, "hook-relay")
  const project = join(process.env.HOME!, "hook-project")

  beforeAll(async () => {
    mkdirSync(join(project, ".git"), { recursive: true })
    broker = await startBroker({ dir, idleMs: 0, policyPath: join(process.env.HOME!, "hook-policy.json"), log: () => {} })
  })
  afterAll(async () => {
    await broker.stop()
  })

  const rows = (address: string): ActivityRow[] => broker.core.activity({ limit: 1000 }).filter((r) => r.endpoint === address)
  const endpoint = (address: string) => broker.core.list({ all: true }).find((e) => e.address === address)

  test("a Claude Code session's hooks post activity silently, with summaries and subagents, and end it", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "claude-s1", CLAUDECODE: "1" }
    const base = { session_id: "abc", transcript_path: "/t", cwd: project }
    const results = [
      await hook(["claude"], { ...base, hook_event_name: "SessionStart", source: "startup" }, env),
      await hook(
        ["claude"],
        {
          ...base,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "bun test src/x.test.ts", description: "Run the x tests" },
          tool_response: { stdout: "RESPONSE-MARKER" },
        },
        env,
      ),
      await hook(
        ["claude"],
        {
          ...base,
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: `curl -H "Authorization: token ${SECRET}" https://api.example.com` },
          tool_response: "RESPONSE-MARKER",
        },
        env,
      ),
      await hook(
        ["claude"],
        { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "true", description: `push with ${SECRET}` } },
        env,
      ),
      await hook(
        ["claude"],
        {
          ...base,
          hook_event_name: "PostToolUse",
          tool_name: "Read",
          tool_input: { file_path: "/repo/src/core.ts" },
          agent_id: "9b1c2d3e4f",
          agent_type: "Explore",
        },
        env,
      ),
      await hook(["claude"], { ...base, hook_event_name: "Stop", stop_hook_active: false }, env),
      await hook(["claude"], { ...base, hook_event_name: "SubagentStop", agent_id: "9b1c2d3e4f", agent_type: "Explore" }, env),
    ]
    expect(results[0]).toMatchObject({ stdout: expect.stringContaining("relay_set_now"), stderr: "", code: 0 })
    for (const result of results.slice(1)) expect(result).toMatchObject({ stdout: "", stderr: "", code: 0 })
    const address = "me/claude-hook-project"
    expect(endpoint(address)).toMatchObject({ harness: "claude-code", presence: "online", status: { state: "working", note: "" } })
    const activity = rows(address).map((r) => [r.kind, r.tool, r.summary, r.agent])
    expect(activity).toEqual([
      ["session_start", null, "startup", null],
      ["tool", "Bash", "bun", null],
      ["tool", "Bash", "curl", null],
      ["tool", "Bash", "true", null],
      ["tool", "Read", "core.ts", "Explore 9b1c2d"],
      ["stop", null, null, null],
      ["stop", null, null, "Explore 9b1c2d"],
    ])
    expect(endpoint(`${address}-explore-9b1c`)).toBeUndefined()
    const stored = JSON.stringify(broker.core.activity({ limit: 1000 }))
    expect(stored).not.toContain(SECRET)
    expect(stored).not.toContain("RESPONSE-MARKER")
    expect(stored).not.toContain("api.example.com")

    expect(await hook(["claude"], { ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" }, env)).toMatchObject({
      stdout: "",
      stderr: "",
      code: 0,
    })
    expect(rows(address).at(-1)!.kind).toBe("session_end")
    expect(endpoint(address)).toMatchObject({ presence: "offline", status: { state: "done" } })
  })

  test("a Claude Code or Codex session start nudges an untitled agent to set its title and now; a titled one, and other harnesses, stay silent", async () => {
    const base = { session_id: "n", cwd: project, hook_event_name: "SessionStart", source: "startup" }
    for (const [harness, env] of [
      ["claude", { CLAUDECODE: "1" }],
      ["codex", { CODEX_THREAD_ID: "t1" }],
    ] as const) {
      const name = `nudge-${harness}`
      const started = await hook([harness], base, { SCP_DIR: dir, SCP_SESSION: name, SCP_NAME: name, ...env })
      expect(started).toMatchObject({ stderr: "", code: 0 })
      expect(json(started.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            "swarm (optional): a title and a one-line now (relay_set_title / relay_set_now) help peers find you; skip it when you only run workers.",
        },
      })
      broker.core.title(endpoint(`me/${name}`)!.id, "docs")
      expect(await hook([harness], { ...base, source: "resume" }, { SCP_DIR: dir, SCP_SESSION: name, SCP_NAME: name, ...env })).toMatchObject({
        stdout: "",
        code: 0,
      })
    }
    expect(await hook(["claude"], base, { SCP_DIR: dir, SCP_SESSION: "nudge-grok", SCP_NAME: "nudge-grok", GROK_SESSION_ID: "g" })).toMatchObject({
      stdout: "",
      code: 0,
    })
  })

  test("with the cloud transport a hook posts nothing and starts no broker: hooks report to a local broker only", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "claude-cloud", CLAUDECODE: "1", SCP_TRANSPORT: "cloud" }
    const base = { session_id: "cloud", transcript_path: "/t", cwd: join(process.env.HOME!, "cloud-project") }
    mkdirSync(join(base.cwd, ".git"), { recursive: true })
    expect(await hook(["claude"], { ...base, hook_event_name: "SessionStart", source: "startup" }, env)).toMatchObject({ stdout: "", stderr: "", code: 0 })
    expect(await hook(["claude"], { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/x.ts" } }, env)).toMatchObject({
      stdout: "",
      stderr: "",
      code: 0,
    })
    expect(endpoint("me/claude-cloud-project")).toBeUndefined()
  })

  test("a Claude hook under Grok labels itself grok and reads camelCase", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "grok-s1", GROK_SESSION_ID: "g1", SCP_NAME: "grok-lane" }
    const result = await hook(
      ["claude"],
      { hookEventName: "post_tool_use", hook_event_name: "PostToolUse", sessionId: "g1", cwd: project, toolName: "Edit", toolInput: { file_path: "/r/a.md" } },
      env,
    )
    expect(result).toMatchObject({ stdout: "", stderr: "", code: 0 })
    expect(endpoint("me/grok-lane")!.harness).toBe("grok")
    expect(rows("me/grok-lane").map((r) => [r.tool, r.summary])).toEqual([["Edit", "a.md"]])
  })

  test("a codex hook run from Claude Code's shell reports for codex, never for the Claude session around it", async () => {
    const nested = join(process.env.HOME!, "nested-project")
    mkdirSync(join(nested, ".git"), { recursive: true })
    const claude = Bun.spawn(["sleep", "60"])
    try {
      const env = { SCP_DIR: dir, CLAUDECODE: "1", CLAUDE_PID: String(claude.pid) }
      expect(await hook(["claude"], { hook_event_name: "SessionStart", source: "startup", cwd: nested }, env)).toMatchObject({ code: 0 })
      expect(await hook(["codex"], { hook_event_name: "PostToolUse", cwd: nested, tool_name: "Bash", tool_input: { command: "ls" } }, env)).toMatchObject({
        code: 0,
      })
      expect(await hook(["codex"], { hook_event_name: "SessionEnd", cwd: nested }, env)).toMatchObject({ code: 0 })
      expect(endpoint("me/claude-nested-project")).toMatchObject({ harness: "claude-code", presence: "online", status: { state: "working" } })
      expect(rows("me/claude-nested-project").map((r) => r.kind)).toEqual(["session_start"])
      expect(endpoint("me/codex-nested-project")).toMatchObject({ harness: "codex", status: { state: "done" } })
      expect(rows("me/codex-nested-project").map((r) => [r.kind, r.summary])).toEqual([
        ["tool", "ls"],
        ["session_end", null],
      ])
    } finally {
      claude.kill()
    }
  })

  test("a shim and a hook with the same session key share one endpoint", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "shared-1", CLAUDECODE: "1" }
    const shim = Bun.spawn([process.execPath, "--no-env-file", entry, "mcp", "--as", "shim-x"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: cleanEnv(env),
      cwd: project,
    })
    try {
      shim.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`)
      shim.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })}\n`)
      shim.stdin.flush()
      const reader = shim.stdout.getReader()
      let out = ""
      while (!out.includes('"id":1')) out += new TextDecoder().decode((await reader.read()).value)
      expect(out).toContain("me/shim-x")
      expect(await hook(["claude"], { hook_event_name: "PostToolUse", cwd: project, tool_name: "Grep", tool_input: { pattern: "x" } }, env)).toMatchObject({
        code: 0,
        stdout: "",
        stderr: "",
      })
      expect(rows("me/shim-x").map((r) => r.tool)).toEqual(["Grep"])
      expect(
        broker.core.list({ all: true }).filter((e) => e.harness === "claude-code" && e.address.startsWith("me/claude-hook-project-") && !e.parent),
      ).toEqual([])
      reader.releaseLock()
    } finally {
      shim.stdin.end()
      await shim.exited
    }
  })

  test("with $SCP_SESSION, a shim restarted in its harness process keeps the endpoint its hooks post to, under the shim's --as name", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "restart-1", CLAUDECODE: "1" }
    const whoami = async () => {
      const shim = Bun.spawn([process.execPath, "--no-env-file", entry, "mcp", "--as", "restart-lane"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: cleanEnv(env),
        cwd: project,
      })
      shim.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`)
      shim.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })}\n`)
      shim.stdin.flush()
      const reader = shim.stdout.getReader()
      let out = ""
      while (!out.includes('"id":1')) out += new TextDecoder().decode((await reader.read()).value)
      reader.releaseLock()
      shim.stdin.end()
      await shim.exited
      return /address: (me\/[a-z0-9._-]+)/.exec(out)?.[1] ?? out
    }
    expect(await hook(["claude"], { hook_event_name: "SessionStart", cwd: project, source: "startup" }, env)).toMatchObject({ code: 0 })
    const hooked = endpoint(broker.core.activity({ limit: 1 })[0]!.endpoint)!.id
    const address = "me/restart-lane"
    expect(await whoami()).toBe(address)
    expect(endpoint(address)!.id).toBe(hooked)
    expect(await whoami()).toBe(address)
    expect(await hook(["claude"], { hook_event_name: "PostToolUse", cwd: project, tool_name: "Grep", tool_input: { pattern: "x" } }, env)).toMatchObject({
      code: 0,
    })
    expect(
      rows(address)
        .slice(-2)
        .map((r) => [r.kind, r.tool]),
    ).toEqual([
      ["session_start", null],
      ["tool", "Grep"],
    ])
  })

  test("a shim whose hooks claimed the session first still gets the --as name a shim alone gets, never another live agent's, keeping the hooks' activity", async () => {
    const live = broker.core.claim({ handle: "taken-lane", harness: "claude-code", session: "pid:9999", process: "pid:9999:Mon-Oct-12-09:00:00-2026" })
    const shimAs = async (env: Record<string, string>) => {
      const shim = Bun.spawn([process.execPath, "--no-env-file", entry, "mcp", "--as", "taken-lane"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: cleanEnv(env),
        cwd: project,
      })
      shim.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`)
      shim.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })}\n`)
      shim.stdin.flush()
      const reader = shim.stdout.getReader()
      let out = ""
      while (!out.includes('"id":1')) out += new TextDecoder().decode((await reader.read()).value)
      reader.releaseLock()
      shim.stdin.end()
      await shim.exited
      return /address: (me\/[a-z0-9._-]+)/.exec(out)?.[1] ?? out
    }
    const hooksFirst = { SCP_DIR: dir, SCP_SESSION: "race-hooks-first", CLAUDECODE: "1" }
    expect(await hook(["claude"], { hook_event_name: "SessionStart", cwd: project, source: "startup" }, hooksFirst)).toMatchObject({ code: 0 })
    const hooked = endpoint(broker.core.activity({ limit: 1 })[0]!.endpoint)!
    expect(hooked.address).toStartWith("me/claude-hook-project")
    expect(await hook(["claude"], { hook_event_name: "UserPromptSubmit", cwd: project, prompt: "go" }, hooksFirst)).toMatchObject({ code: 0 })
    const named = await shimAs(hooksFirst)
    expect(named).toBe("me/taken-lane-2")
    expect(endpoint(named)!.id).toBe(hooked.id)
    expect(await hook(["claude"], { hook_event_name: "PostToolUse", cwd: project, tool_name: "Grep", tool_input: { pattern: "x" } }, hooksFirst)).toMatchObject(
      { code: 0 },
    )
    expect(rows(named).map((r) => [r.kind, r.tool])).toEqual([
      ["session_start", null],
      ["tool", "Grep"],
    ])
    expect(broker.core.whoami(live.endpoint.id).address).toBe("me/taken-lane")
  })

  test("an agy hook prints exactly {} on stdout, on success and on every failure path", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "agy-s1", ANTIGRAVITY_AGENT: "1" }
    const payload = { conversationId: "c1", workspacePaths: [project], toolCall: { name: "Edit", args: { file_path: "/r/notes.md" } }, stepIdx: 1 }
    expect(await hook(["agy", "PostToolUse"], payload, env)).toMatchObject({ stdout: "{}\n", stderr: "", code: 0 })
    expect(endpoint("me/agy-hook-project")!.harness).toBe("agy")
    expect(rows("me/agy-hook-project").map((r) => [r.tool, r.summary])).toEqual([["Edit", "notes.md"]])
    const empty = join(process.env.HOME!, "agy-no-broker")
    expect(await hook(["agy", "PostToolUse"], payload, { SCP_DIR: empty })).toMatchObject({ stdout: "{}\n", stderr: "", code: 0 })
    expect(await hook(["agy"], "garbage", { SCP_DIR: empty })).toMatchObject({ stdout: "{}\n", stderr: "", code: 0 })
  })

  test("an agy hook whose stdout is a closed pipe still exits 0 silently and reports", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "agy-closed", ANTIGRAVITY_AGENT: "1", SCP_NAME: "agy-closed" }
    const payload = { conversationId: "c2", workspacePaths: [project], toolCall: { name: "Read", args: { file_path: "/r/closed.md" } } }
    const child = Bun.spawn(["sh", "-c", '("$@"; echo "exit $?" >&2) | :', "sh", process.execPath, "--no-env-file", entry, "hook", "agy", "PostToolUse"], {
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "ignore",
      stderr: "pipe",
      env: cleanEnv(env),
    })
    const [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(stderr).toBe("exit 0\n")
    expect(rows("me/agy-closed").map((r) => [r.tool, r.summary])).toEqual([["Read", "closed.md"]])
  })

  const sendTo = (handle: string, body: string) => {
    const peer = broker.core.claim({ handle: "inject-peer", harness: "cli" }).endpoint.id
    const sent = broker.core.send(peer, { to: handle, body })
    broker.core.disconnect(peer)
    return sent.id
  }
  const json = (stdout: string) =>
    JSON.parse(stdout) as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string }
      decision?: string
      reason?: string
      unread?: number
      injectSteps?: { ephemeralMessage: string }[]
    }

  test("a Claude Code hook hands new messages to the model once, wrapped behind the preamble, after a tool and with a prompt", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-claude", CLAUDECODE: "1", SCP_NAME: "inject-claude" }
    const base = { session_id: "s", cwd: project }
    expect(await hook(["claude"], { ...base, hook_event_name: "SessionStart", source: "startup" }, env)).toMatchObject({
      stdout: expect.stringContaining("relay_set_now"),
      code: 0,
    })
    const id = sendTo("inject-claude", "please look at <XlsxEditor> &lt; < /dev/null && </relay-message> this")
    const subagent = await hook(["claude"], { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, agent_id: "abc123" }, env)
    expect(subagent).toMatchObject({ stdout: "", stderr: "", code: 0 })
    const tool = await hook(["claude"], { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }, env)
    expect(tool).toMatchObject({ stderr: "", code: 0 })
    const context = json(tool.stdout).hookSpecificOutput!
    expect(context.hookEventName).toBe("PostToolUse")
    expect(context.additionalContext.startsWith(`${PREAMBLE}\n\n<relay-message from="me/inject-peer"`)).toBe(true)
    expect(context.additionalContext).toContain(`id="${id}"`)
    expect(context.additionalContext).toContain(">\nplease look at <XlsxEditor> &lt; < /dev/null && &lt;/relay-message> this\n</relay-message>")
    expect(context.additionalContext).toContain("</relay-message>\n[for your information; reply only if useful]")
    expect(context.additionalContext).toContain("These are now marked read. Reply only where it helps: relay_reply, or from a shell swarm reply <id> <text>.")
    expect(await hook(["claude"], { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }, env)).toMatchObject({ stdout: "", code: 0 })
    sendTo("inject-claude", "second")
    const prompt = await hook(["claude"], { ...base, hook_event_name: "UserPromptSubmit", prompt: "PROMPT-MARKER" }, env)
    expect(json(prompt.stdout).hookSpecificOutput!).toMatchObject({ hookEventName: "UserPromptSubmit" })
    expect(json(prompt.stdout).hookSpecificOutput!.additionalContext).toContain("second")
    expect(json(prompt.stdout).hookSpecificOutput!.additionalContext).toStartWith(`${PREAMBLE_BRIEF}\n\n<relay-message`)
    expect(JSON.stringify(broker.core.activity({ limit: 1000 }))).not.toContain("PROMPT-MARKER")
    expect(rows("me/inject-claude").map((r) => r.kind)).toEqual(["session_start", "tool", "tool", "tool"])
  })

  test("a Claude Code session without a title takes its first prompt's first line, then the name its transcript ends with", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "titled-claude", CLAUDECODE: "1", SCP_NAME: "titled-claude" }
    const transcript = join(dir, "ttl-1.jsonl")
    const base = { session_id: "ttl-1", transcript_path: transcript, cwd: project }
    const title = () => broker.core.list({ all: true }).find((e) => e.address === "me/titled-claude")?.title
    await hook(["claude"], { ...base, hook_event_name: "SessionStart", source: "startup" }, env)
    await hook(["claude"], { ...base, hook_event_name: "UserPromptSubmit", prompt: `\n  wire the ${SECRET} parser\nmore detail` }, env)
    expect(title()).toBe("wire the [redacted github token] parser")
    writeFileSync(transcript, "")
    await hook(["claude"], { ...base, hook_event_name: "Stop", last_assistant_message: "done" }, env)
    expect(title()).toBe("wire the [redacted github token] parser")
    const line = (record: object) => `${JSON.stringify({ ...record, sessionId: "ttl-1" })}\n`
    writeFileSync(transcript, `${"x".repeat(200_000)}\n${line({ type: "ai-title", aiTitle: "Parser wiring" })}${line({ type: "user", message: {} })}`)
    await hook(["claude"], { ...base, hook_event_name: "Stop", last_assistant_message: "done" }, env)
    expect(title()).toBe("Parser wiring")
  })

  test("every SCP_TLDR_EVERY prompts the prompt hook reminds the agent to refresh its tl;dr; 0 turns it off", async () => {
    const base = { session_id: "tldr", cwd: project, prompt: "go" }
    const prompt = (env: Record<string, string>) => hook(["claude"], { ...base, hook_event_name: "UserPromptSubmit" }, env)
    const env = { SCP_DIR: dir, SCP_SESSION: "tldr-claude", CLAUDECODE: "1", SCP_NAME: "tldr-claude", SCP_TLDR_EVERY: "2" }
    await hook(["claude"], { ...base, hook_event_name: "SessionStart", source: "startup" }, env)
    expect((await prompt(env)).stdout).toBe("")
    expect(json((await prompt(env)).stdout).hookSpecificOutput!.additionalContext).toBe(TLDR)
    expect((await prompt(env)).stdout).toBe("")
    expect((await prompt({ ...env, SCP_TLDR_EVERY: "0" })).stdout).toBe("")
  })

  test("a transcript's custom title beats its summary, and a path not named for the session is not read", () => {
    const path = join(dir, "ttl-2.jsonl")
    writeFileSync(
      path,
      [
        { type: "summary", summary: "old" },
        { type: "custom-title", customTitle: "mine" },
        { type: "ai-title", aiTitle: "auto" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    )
    expect(transcriptTitle(path, "ttl-2")).toBe("mine")
    expect(transcriptTitle(path, "other")).toBeUndefined()
    expect(promptTitle(`  \n${"word ".repeat(30)}`)).toHaveLength(64)
  })

  test("swarm inbox still lists what a background PostToolUse hook just showed, whose text Claude Code hands over only later", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-later", CLAUDECODE: "1", SCP_NAME: "inject-later" }
    await hook(["claude"], { hook_event_name: "SessionStart", cwd: project }, env)
    const id = sendTo("inject-later", "HANDBACK-MARKER the whole result")
    const shown = json((await hook(["claude"], { hook_event_name: "PostToolUse", cwd: project, tool_name: "Bash", tool_input: {} }, env)).stdout)
      .hookSpecificOutput!.additionalContext as string
    expect(shown).toContain("HANDBACK-MARKER")
    const inbox = async () => {
      const child = Bun.spawn([process.execPath, "--no-env-file", entry, "inbox"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: cleanEnv(env) })
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return stdout + stderr
    }
    const listed = await inbox()
    expect(listed).toContain("HANDBACK-MARKER")
    expect(listed).toContain(id)
    expect(listed).toContain("a hook already showed you this at ")
    expect(await inbox()).toContain("no unread messages")
  })

  test("a message too big to inline becomes a pointer to relay_inbox and stays unread, while one shown in full is read", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-big", CLAUDECODE: "1", SCP_NAME: "inject-big" }
    await hook(["claude"], { hook_event_name: "SessionStart", cwd: project }, env)
    const big = sendTo("inject-big", "z".repeat(LIMITS.injectBytes + 1000))
    const result = await hook(["claude"], { hook_event_name: "PostToolUse", cwd: project, tool_name: "Read", tool_input: {} }, env)
    const text = json(result.stdout).hookSpecificOutput!.additionalContext as string
    expect(text).toBe("1 more is unread: call relay_inbox, or run swarm inbox from a shell, to read it.")
    expect(text).not.toContain("zzz")
    const small = sendTo("inject-big", "small enough")
    const both = json((await hook(["claude"], { hook_event_name: "PostToolUse", cwd: project, tool_name: "Read", tool_input: {} }, env)).stdout)
      .hookSpecificOutput!.additionalContext as string
    expect(both).toContain("small enough")
    expect(both).not.toContain("more is unread")
    const db = new Database(join(dir, "relay.db"), { readonly: true })
    try {
      const acked = (id: string) => (db.query("SELECT acked_at FROM deliveries WHERE message_id = ?").get(id) as { acked_at: number | null }).acked_at
      expect(acked(small)).toEqual(expect.any(Number))
      expect(acked(big)).toBeNull()
    } finally {
      db.close()
    }
  })

  test("two hooks at once show disjoint messages, and the one that showed the first page points only at what neither showed", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-twice", CLAUDECODE: "1", SCP_NAME: "inject-twice" }
    await hook(["claude"], { hook_event_name: "SessionStart", cwd: project }, env)
    for (let i = 0; i <= LIMITS.injectMessages; i++) sendTo("inject-twice", `burst ${i}`)
    const run = (connect: () => Promise<RelayClient>) =>
      runHook(["claude"], {
        env: cleanEnv(env),
        cwd: project,
        stdin: Readable.from([JSON.stringify({ hook_event_name: "PostToolUse", cwd: project, tool_name: "Read", tool_input: {} })]),
        connect,
        harnessPid: () => process.pid,
        print: () => true,
      })
    let other: string | undefined
    const first = await run(async () => {
      const client = await RelayClient.connect(socketPath(dir))
      const request = client.request.bind(client)
      client.request = (async (method: string, params?: Record<string, unknown>) => {
        if (method === "inject" && params?.count === true && other === undefined) other = await run(() => RelayClient.connect(socketPath(dir)))
        return request(method, params)
      }) as typeof client.request
      return client
    })
    const context = (reply: string | undefined) => json(reply!).hookSpecificOutput!.additionalContext as string
    expect(context(first)).toContain("burst 0")
    expect(context(first)).not.toContain(`burst ${LIMITS.injectMessages}`)
    expect(context(first)).not.toContain("more is unread")
    expect(context(other)).toContain(`burst ${LIMITS.injectMessages}`)
    expect(context(other)).not.toContain("burst 0")
    expect(await hook(["claude"], { hook_event_name: "PostToolUse", cwd: project, tool_name: "Read", tool_input: {} }, env)).toMatchObject({
      stdout: "",
      code: 0,
    })
  })

  test("a hook confirms only what it printed, and skips inject when too little of its deadline is left", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-confirm", CLAUDECODE: "1", SCP_NAME: "inject-confirm" }
    await hook(["claude"], { hook_event_name: "SessionStart", cwd: project }, env)
    const db = new Database(join(dir, "relay.db"), { readonly: true })
    const delivery = (id: string) =>
      db.query("SELECT offered_until, injected_at, acked_at FROM deliveries WHERE message_id = ?").get(id) as {
        offered_until: number | null
        injected_at: number | null
        acked_at: number | null
      }
    const run = (print: (text: string) => boolean, remaining = () => 1500) =>
      runHook(["claude"], {
        env: cleanEnv(env),
        cwd: project,
        stdin: Readable.from([JSON.stringify({ hook_event_name: "PostToolUse", cwd: project, tool_name: "Read", tool_input: {} })]),
        connect: () => RelayClient.connect(socketPath(dir)),
        harnessPid: () => process.pid,
        print,
        remaining,
      })
    try {
      const late = sendTo("inject-confirm", "too late to print")
      expect(
        await run(
          () => true,
          () => 100,
        ),
      ).toBeUndefined()
      expect(delivery(late)).toEqual({ offered_until: null, injected_at: null, acked_at: null })
      const printed: string[] = []
      expect(await run(() => false)).toContain("too late to print")
      expect(delivery(late)).toMatchObject({ offered_until: expect.any(Number), injected_at: null, acked_at: null })
      const shown = sendTo("inject-confirm", "printed")
      expect(await run((text) => printed.push(text) > 0)).toContain("printed")
      expect(printed).toHaveLength(1)
      expect(delivery(shown).injected_at).toEqual(expect.any(Number))
      expect(delivery(shown).acked_at).toEqual(expect.any(Number))
      expect(delivery(late).injected_at).toBeNull()
      const tight = sendTo("inject-confirm", "answered too late")
      let asked = 0
      expect(
        await run(
          (text) => printed.push(text) > 0,
          () => (asked++ === 0 ? 1500 : 50),
        ),
      ).toBeUndefined()
      expect(printed).toHaveLength(1)
      expect(delivery(tight)).toMatchObject({ offered_until: expect.any(Number), injected_at: null, acked_at: null })
    } finally {
      db.close()
    }
  })

  test("an OpenCode stop or prompt names only how many messages are unread, never their text", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-oc-stop", OPENCODE: "1", SCP_NAME: "inject-oc-stop" }
    await hook(["opencode"], { hook_event_name: "SessionStart", session_id: "ses_root", cwd: project }, env)
    sendTo("inject-oc-stop", "BODY-MARKER from a peer")
    const reply = json((await hook(["opencode", BLOCK_STOP], { hook_event_name: "Stop", session_id: "ses_root", cwd: project }, env)).stdout)
    expect(reply).toMatchObject({ decision: "block", unread: 1 })
    expect(JSON.stringify(reply)).not.toContain("BODY-MARKER")
    const prompt = json((await hook(["opencode"], { hook_event_name: "UserPromptSubmit", session_id: "ses_root", cwd: project }, env)).stdout)
    expect(prompt.hookSpecificOutput!).toEqual({
      hookEventName: "UserPromptSubmit",
      additionalContext: "You have 1 unread relay message; call relay_inbox, or run swarm inbox from a shell, to read it.",
    })
    const tool = await hook(["opencode"], { hook_event_name: "PostToolUse", session_id: "ses_root", cwd: project, tool_name: "read", tool_input: {} }, env)
    expect(json(tool.stdout).hookSpecificOutput!.additionalContext).toContain("BODY-MARKER")
    sendTo("inject-oc-stop", "never shown")
    expect(
      await hook(["opencode", "--no-inject"], { hook_event_name: "PostToolUse", session_id: "ses_root", cwd: project, tool_name: "read", tool_input: {} }, env),
    ).toMatchObject({ stdout: "", code: 0 })
    expect(
      json((await hook(["opencode"], { hook_event_name: "PostToolUse", session_id: "ses_root", cwd: project, tool_name: "read", tool_input: {} }, env)).stdout)
        .hookSpecificOutput!.additionalContext,
    ).toContain("never shown")
  })

  test("a Claude Code older than Stop additionalContext, by its hook payload or the version setup cached, gets a block; an unknown one the context", async () => {
    expect(stopContinues("2.1.163")).toBe(true)
    expect(stopContinues("2.1.302 (Claude Code)")).toBe(true)
    expect(stopContinues("2.1.162")).toBe(false)
    expect(stopContinues("1.9.999")).toBe(false)
    expect(stopContinues(undefined)).toBe(true)
    expect(stopContinues("unknown")).toBe(true)
    expect(json(hookReply("claude-code", "stop", "go on", 0, false))).toEqual({ decision: "block", reason: "go on" })
    const config = mkdtempSync(join(process.env.HOME!, "claude-version-"))
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-old", CLAUDECODE: "1", SCP_NAME: "inject-old", XDG_CONFIG_HOME: config }
    const stop = (payload: Record<string, unknown> = {}) =>
      runHook(["claude", BLOCK_STOP], {
        env: cleanEnv(env),
        cwd: project,
        stdin: Readable.from([JSON.stringify({ hook_event_name: "Stop", cwd: project, ...payload })]),
        connect: () => RelayClient.connect(socketPath(dir)),
        harnessPid: () => process.pid,
        print: () => false,
      })
    await hook(["claude"], { hook_event_name: "SessionStart", cwd: project }, env)
    sendTo("inject-old", "hold on")
    expect(json((await stop())!).hookSpecificOutput!.hookEventName).toBe("Stop")
    expect(json((await stop({ version: "2.1.100" }))!)).toMatchObject({ decision: "block" })
    mkdirSync(dirname(claudeVersionFile(cleanEnv(env))), { recursive: true })
    writeFileSync(claudeVersionFile(cleanEnv(env)), "2.1.100 (Claude Code)\n")
    expect(json((await stop())!)).toMatchObject({ decision: "block" })
    expect(json((await stop({ version: "2.1.302" }))!).hookSpecificOutput!.hookEventName).toBe("Stop")
  })

  test("--block-stop-on-unread holds a stop while messages are unread, at most three times a session", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-stop", CLAUDECODE: "1", SCP_NAME: "inject-stop" }
    await hook(["claude"], { hook_event_name: "SessionStart", cwd: project }, env)
    const stop = () => hook(["claude", BLOCK_STOP], { hook_event_name: "Stop", cwd: project, stop_hook_active: false }, env)
    expect(await stop()).toMatchObject({ stdout: "", code: 0 })
    sendTo("inject-stop", "before you go")
    expect(await hook(["claude"], { hook_event_name: "Stop", cwd: project }, env)).toMatchObject({ stdout: "", code: 0 })
    const unprinted = await runHook(["claude", BLOCK_STOP], {
      env: cleanEnv(env),
      cwd: project,
      stdin: Readable.from([JSON.stringify({ hook_event_name: "Stop", cwd: project })]),
      connect: () => RelayClient.connect(socketPath(dir)),
      harnessPid: () => process.pid,
      print: () => false,
    })
    expect(json(unprinted!).hookSpecificOutput!.hookEventName).toBe("Stop")
    for (let i = 0; i < 3; i++)
      expect(json((await stop()).stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: "You have 1 unread relay message; call relay_inbox, or run swarm inbox from a shell, to read it.",
        },
      })
    expect(await stop()).toMatchObject({ stdout: "", code: 0 })
    const tool = await hook(["claude"], { hook_event_name: "PostToolUse", cwd: project, tool_name: "Read", tool_input: {} }, env)
    expect(json(tool.stdout).hookSpecificOutput!.additionalContext).toContain("before you go")
    expect(await hook(["claude", BLOCK_STOP], { hook_event_name: "SubagentStop", cwd: project, agent_id: "a1" }, env)).toMatchObject({ stdout: "", code: 0 })
  })

  test("a subagent's foreground hook takes its own endpoint's messages, the first with its address; the session's hooks never take them", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-sub", CLAUDECODE: "1", SCP_NAME: "inject-sub" }
    const base = { session_id: "s", cwd: project }
    const sub = {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      agent_id: "aceb553c19f223c70",
      agent_type: "general-purpose",
    }
    const both = async (payload: Record<string, unknown>) => {
      const [background, foreground] = await Promise.all([hook(["claude"], payload, env), hook(["claude", SUBAGENT], payload, env)])
      expect(background).toMatchObject({ stdout: "", stderr: "", code: 0 })
      return foreground
    }
    await hook(["claude"], { ...base, hook_event_name: "SessionStart", source: "startup" }, env)
    const main = await hook(["claude", SUBAGENT], { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }, env)
    expect(main).toMatchObject({ stdout: "", stderr: "", code: 0 })
    expect(json((await both(sub)).stdout).hookSpecificOutput!).toEqual({
      hookEventName: "PostToolUse",
      additionalContext: subagentIntro("me/inject-sub-gp-aceb"),
    })
    const forSub = sendTo("inject-sub-gp-aceb", "SUB-MARKER")
    const forRoot = sendTo("inject-sub", "ROOT-MARKER")
    const root = await hook(["claude"], { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }, env)
    expect(root.stdout).toContain(forRoot)
    expect(root.stdout).not.toContain("SUB-MARKER")
    const second = json((await both(sub)).stdout).hookSpecificOutput!.additionalContext as string
    expect(second.startsWith(PREAMBLE)).toBe(true)
    expect(second).toContain(forSub)
    expect(second).not.toContain("ROOT-MARKER")
    expect(second).not.toContain("you are a subagent")
    expect(await both(sub)).toMatchObject({ stdout: "", code: 0 })
    expect(await both({ ...base, hook_event_name: "SubagentStop", agent_id: "aceb553c19f223c70", agent_type: "general-purpose" })).toMatchObject({
      stdout: "",
      code: 0,
    })
    expect(endpoint("me/inject-sub-gp-aceb")).toMatchObject({ parent: "me/inject-sub", status: { state: "done" } })
    expect(await both({ ...base, hook_event_name: "SubagentStop", agent_id: "0123456789abcdef0", agent_type: "Explore" })).toMatchObject({
      stdout: "",
      code: 0,
    })
    expect(endpoint("me/inject-sub-explore-0123")).toBeUndefined()
    expect(rows("me/inject-sub").map((r) => [r.kind, r.agent])).toEqual([
      ["session_start", null],
      ["tool", "general-purpose aceb55"],
      ["tool", null],
      ["tool", "general-purpose aceb55"],
      ["tool", "general-purpose aceb55"],
      ["stop", "general-purpose aceb55"],
      ["stop", "Explore 012345"],
    ])
    expect(rows("me/inject-sub-gp-aceb")).toEqual([])
    expect(await both(sub)).toMatchObject({ stdout: "", code: 0 })
    expect(endpoint("me/inject-sub-gp-aceb")).toMatchObject({ status: { state: "working" } })
  })

  test("a session's Agent call titles the subagent it names in its response, before or after the subagent's first tool; other shapes title nothing", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "title-sub", CLAUDECODE: "1", SCP_NAME: "title-sub" }
    const base = { session_id: "s", cwd: project }
    const launch = (agentId: string, description: string, response?: unknown) => ({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { description, prompt: "long instructions", subagent_type: "Explore", run_in_background: true },
      tool_response: response ?? { status: "async_launched", agentId, description },
    })
    const tool = (agentId: string) =>
      Promise.all(
        [["claude"], ["claude", SUBAGENT]].map((args) =>
          hook(args, { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, agent_id: agentId, agent_type: "Explore" }, env),
        ),
      )
    await hook(["claude"], { ...base, hook_event_name: "SessionStart", source: "startup" }, env)
    expect(await hook(["claude"], launch("d00dfeed01", "Map the broker"), env)).toMatchObject({ stdout: "", stderr: "", code: 0 })
    await tool("d00dfeed01")
    expect(endpoint("me/title-sub-explore-d00d")).toMatchObject({ parent: "me/title-sub", title: "Map the broker" })
    await tool("beadfeed02")
    expect(endpoint("me/title-sub-explore-bead")?.title).toBeNull()
    await hook(["claude"], { ...launch("beadfeed02", "Review the parser"), tool_name: "Task" }, env)
    expect(endpoint("me/title-sub-explore-bead")?.title).toBe("Review the parser")
    await hook(["claude"], launch("cafe03", "as a string", "agentId: cafe03"), env)
    await hook(["claude"], launch("cafe03", "as an array", [{ type: "text", text: "agentId: cafe03" }]), env)
    await tool("cafe03")
    expect(endpoint("me/title-sub-explore-cafe")?.title).toBeNull()
    expect(endpoint("me/title-sub")?.title).toBeNull()
  })

  test("the CLI entry ends a --subagent hook without an agent_id before it loads anything else", async () => {
    const tool = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} })
    expect(subagentSkip(["hook", "claude", SUBAGENT], tool)).toBe(true)
    expect(subagentSkip(["hook", "claude", SUBAGENT], JSON.stringify({ hook_event_name: "PostToolUse", agent_id: "aceb553c19f223c70" }))).toBe(false)
    expect(subagentSkip(["hook", "claude", SUBAGENT], JSON.stringify({ hook_event_name: "SubagentStop", agentId: "a1" }))).toBe(false)
    expect(subagentSkip(["hook", "claude"], tool)).toBe(false)
    expect(subagentSkip(["send", "x", SUBAGENT], tool)).toBe(false)
    const source = readFileSync(entry, "utf8")
    expect([...source.matchAll(/^import .* from "(.+)"$/gm)].map((m) => m[1])).toEqual(["./hook-fast", "./warnings"])
    const env = { SCP_DIR: dir, SCP_SESSION: "fast-sub", CLAUDECODE: "1" }
    expect(await hook(["claude", SUBAGENT], { hook_event_name: "PostToolUse", cwd: project, tool_name: "Read", tool_input: {} }, env)).toMatchObject({
      stdout: "",
      stderr: "",
      code: 0,
    })
    expect(broker.core.list({ all: true }).filter((e) => e.address.startsWith("me/claude-") && e.address.includes("fast"))).toEqual([])
  })

  test("codex's subagent payloads are unverified: a --subagent hook of codex claims no child endpoint and prints nothing", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-codex-sub", SCP_NAME: "inject-codex-sub" }
    const base = { session_id: "s", cwd: project }
    await hook(["codex"], { ...base, hook_event_name: "SessionStart", source: "startup" }, env)
    const sub = {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "shell",
      tool_input: { command: "ls" },
      agent_id: "aceb553c19f223c70",
      agent_type: "worker",
    }
    expect(await hook(["codex", SUBAGENT], sub, env)).toMatchObject({ stdout: "", stderr: "", code: 0 })
    expect(broker.core.list({ all: true }).filter((e) => e.address.startsWith("me/inject-codex-sub-"))).toEqual([])
  })

  test("a stop is held while a require_reply request is unanswered, even once read and without --block-stop-on-unread, and lets go once answered", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-required", CLAUDECODE: "1", SCP_NAME: "inject-required" }
    await hook(["claude"], { hook_event_name: "SessionStart", cwd: project }, env)
    const stop = () => hook(["claude"], { hook_event_name: "Stop", cwd: project, stop_hook_active: false }, env)
    const peer = broker.core.claim({ handle: "inject-asker", harness: "cli" }).endpoint.id
    const asked = broker.core.send(peer, { to: "inject-required", body: "must know", kind: "request", require_reply: true })
    const tool = await hook(["claude"], { hook_event_name: "PostToolUse", cwd: project, tool_name: "Read", tool_input: {} }, env)
    expect(json(tool.stdout).hookSpecificOutput!.additionalContext).toContain("</relay-message>\n[reply required: the sender waits for your relay_reply]")
    expect(json((await stop()).stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: "1 relay request requires your reply: relay_reply, or from a shell swarm reply <id> <text>.",
      },
    })
    const me = broker.core.list({ all: true }).find((e) => e.address === "me/inject-required")!.id
    broker.core.send(me, { to: "inject-asker", body: "42", kind: "reply", reply_to: asked.id })
    expect(await stop()).toMatchObject({ stdout: "", code: 0 })
    broker.core.disconnect(peer)
  })

  test("a stop names an unanswered request once, by sender and id only, without --block-stop-on-unread; it is not counted as a held stop", async () => {
    const env = { SCP_DIR: dir, SCP_SESSION: "inject-nudge", CLAUDECODE: "1", SCP_NAME: "inject-nudge" }
    await hook(["claude"], { hook_event_name: "SessionStart", cwd: project }, env)
    const stop = () => hook(["claude"], { hook_event_name: "Stop", cwd: project, stop_hook_active: false }, env)
    const peer = broker.core.claim({ handle: "inject-lead", harness: "cli" }).endpoint.id
    const asked = broker.core.send(peer, { to: "inject-nudge", body: "NUDGE-BODY-MARKER", kind: "request" })
    const held = await stop()
    expect(held.stderr).toBe("")
    expect(json(held.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: `me/inject-lead asked you something (${asked.id.slice(-6)}); reply with relay_reply if it helps, otherwise stop. Read it with relay_inbox.`,
      },
    })
    expect(held.stdout).not.toContain("NUDGE-BODY-MARKER")
    expect(await stop()).toMatchObject({ stdout: "", code: 0 })
    expect(await hook(["claude"], { hook_event_name: "SubagentStop", cwd: project, agent_id: "a1" }, env)).toMatchObject({ stdout: "", code: 0 })
    const db = new Database(join(dir, "relay.db"), { readonly: true })
    try {
      expect(db.query("SELECT stop_blocks FROM endpoints WHERE handle = 'inject-nudge'").get()).toEqual({ stop_blocks: 0 })
      expect((db.query("SELECT nudged_at FROM deliveries WHERE message_id = ?").get(asked.id) as { nudged_at: number | null }).nudged_at).toEqual(
        expect.any(Number),
      )
    } finally {
      db.close()
    }
    broker.core.disconnect(peer)
  })

  test("each harness gets its own reply shape: Grok after tools only, Codex and Muse as Claude Code, agy before model calls", async () => {
    const grok = { SCP_DIR: dir, SCP_SESSION: "inject-grok", GROK_SESSION_ID: "g", SCP_NAME: "inject-grok" }
    await hook(["claude"], { hook_event_name: "SessionStart", cwd: project }, grok)
    sendTo("inject-grok", "for grok")
    expect(await hook(["claude"], { hook_event_name: "UserPromptSubmit", cwd: project }, grok)).toMatchObject({ stdout: "", code: 0 })
    expect(
      json((await hook(["claude"], { hookEventName: "post_tool_use", hook_event_name: "PostToolUse", cwd: project, toolName: "Read" }, grok)).stdout)
        .hookSpecificOutput!.additionalContext,
    ).toContain("for grok")
    for (const harness of ["codex", "muse"]) {
      const env = { SCP_DIR: dir, SCP_SESSION: `inject-${harness}`, SCP_NAME: `inject-${harness}` }
      await hook([harness, "SessionStart"], { hook_event_name: "SessionStart", cwd: project }, env)
      sendTo(`inject-${harness}`, `for ${harness}`)
      const result = await hook(
        [harness, "PostToolUse"],
        { hook_event_name: "PostToolUse", cwd: project, tool_name: "shell", tool_input: { command: "ls" } },
        env,
      )
      expect(json(result.stdout).hookSpecificOutput!).toMatchObject({
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining(`for ${harness}`),
      })
    }
    const agy = { SCP_DIR: dir, SCP_SESSION: "inject-agy", ANTIGRAVITY_AGENT: "1", SCP_NAME: "inject-agy" }
    const payload = { conversationId: "c", workspacePaths: [project] }
    await hook(["agy", "SessionStart"], payload, agy)
    sendTo("inject-agy", "for agy")
    expect(await hook(["agy", "PostToolUse"], { ...payload, toolCall: { name: "Read", args: {} } }, agy)).toMatchObject({ stdout: "{}\n", code: 0 })
    const pre = json((await hook(["agy", "PreInvocation"], { ...payload, invocationNum: 2 }, agy)).stdout)
    expect(pre.injectSteps![0]!.ephemeralMessage).toContain("for agy")
    expect(pre.injectSteps![0]!.ephemeralMessage.startsWith(PREAMBLE)).toBe(true)
    expect(pre.injectSteps![0]!.ephemeralMessage).not.toContain("marked read")
    expect(pre.injectSteps![0]!.ephemeralMessage).toContain("These stay unread: call relay_inbox, or run swarm inbox --ack from a shell, to mark them read.")
    expect(await hook(["agy", "PreInvocation"], payload, agy)).toMatchObject({ stdout: "{}\n", code: 0 })
    sendTo("inject-agy", "AGY-BODY")
    for (const terminationReason of [undefined, "USER_CANCELLED", "ERROR"]) {
      expect(await hook(["agy", "Stop", BLOCK_STOP], { ...payload, ...(terminationReason ? { terminationReason } : {}) }, agy)).toMatchObject({
        stdout: "{}\n",
        code: 0,
      })
    }
    const held = json((await hook(["agy", "Stop", BLOCK_STOP], { ...payload, terminationReason: "NO_TOOL_CALL" }, agy)).stdout)
    expect(held).toEqual({ decision: "continue", reason: "You have 2 unread relay messages; call relay_inbox, or run swarm inbox from a shell, to read them." })
  })

  test("with no broker running it exits 0 quickly and silently, and starts none", async () => {
    const empty = join(process.env.HOME!, "no-broker-relay")
    const result = await hook(
      ["claude"],
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      { SCP_DIR: empty, CLAUDECODE: "1" },
    )
    expect(result).toMatchObject({ stdout: "", stderr: "", code: 0 })
    expect(result.ms).toBeLessThan(5000)
    expect(existsSync(socketPath(empty))).toBe(false)
    expect(await hook(["claude"], "not an object", { SCP_DIR: empty })).toMatchObject({ stdout: "", stderr: "", code: 0 })
    expect(await hook(["claude", "--weird"], {}, { SCP_DIR: empty })).toMatchObject({ stdout: "", stderr: "", code: 0 })
    expect(await hook(["claude"], { hook_event_name: "UserPromptSubmit", prompt: "x" }, { SCP_DIR: empty, CLAUDECODE: "1" })).toMatchObject({
      stdout: "",
      stderr: "",
      code: 0,
    })
    expect(await hook(["claude", BLOCK_STOP], { hook_event_name: "Stop" }, { SCP_DIR: empty, CLAUDECODE: "1" })).toMatchObject({
      stdout: "",
      stderr: "",
      code: 0,
    })
    expect(await hook(["agy", "PreInvocation"], {}, { SCP_DIR: empty })).toMatchObject({ stdout: "{}\n", stderr: "", code: 0 })
  })
})

describe("a stop's nudges", () => {
  type Call = [string, Record<string, unknown>]
  const nudge = (id: string, unread: boolean, seq: number) => ({ seq, from: "me/lead", id, unread })
  async function stopWith(
    args: string[],
    answer: Record<string, unknown>,
    options: { print?: (text: string) => boolean; payload?: Record<string, unknown> } = {},
  ) {
    const calls: Call[] = []
    const client = {
      hello: async () => ({ endpoint: { title: "t" } }),
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push([method, params])
        return method === "inject"
          ? { messages: [], offered: [], hold: null, more: 0, unread: 0, block: false, ...answer }
          : method === "injected"
            ? { injected: 0 }
            : {}
      },
      close: () => {},
    }
    const reply = await runHook(args, {
      env: cleanEnv({ CLAUDECODE: "1", SCP_SESSION: "fake-stop", SCP_NAME: "fake-stop" }),
      cwd: process.env.HOME!,
      stdin: Readable.from([JSON.stringify(options.payload ?? { hook_event_name: "Stop", cwd: process.env.HOME })]),
      connect: async () => client as unknown as RelayClient,
      harnessPid: () => process.pid,
      ...(options.print ? { print: options.print } : {}),
    })
    return { reply, calls, sent: (method: string) => calls.filter(([m]) => m === method).map(([, params]) => params) }
  }

  test("a stop always asks the broker, holds with one line per request and never their text, and confirms the printed nudges uncounted", async () => {
    const { reply, sent } = await stopWith(["claude"], { unread: 1, block: true, forced: false, nudge: [nudge("msg_1", true, 7), nudge("msg_2", false, 9)] })
    expect(sent("inject")).toEqual([{ count: true, stop: true, directives: true }])
    expect(JSON.parse(reply!)).toEqual({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext:
          "me/lead asked you something (msg_1); reply with relay_reply if it helps, otherwise stop. Read it with relay_inbox.\n" +
          "me/lead asked you something (msg_2); reply with relay_reply if it helps, otherwise stop.",
      },
    })
    expect(sent("injected")).toEqual([{ seqs: [], hold: null, nudged: [7, 9] }])
  })

  test("a forcing hold and nudges share one reply, which counts as a held stop; a capped list says how many more", async () => {
    const both = await stopWith(["claude", BLOCK_STOP], { unread: 2, block: true, forced: true, awaiting: 1, nudge: [nudge("msg_3", false, 4)] })
    expect(both.sent("inject")).toEqual([{ count: true, stop: true, directives: true, hold_unread: true }])
    expect(JSON.parse(both.reply!).hookSpecificOutput!.additionalContext).toBe(
      "You have 2 unread relay messages; call relay_inbox, or run swarm inbox from a shell, to read them. 1 relay request requires your reply: relay_reply, or from a shell swarm reply <id> <text>.\n" +
        "me/lead asked you something (msg_3); reply with relay_reply if it helps, otherwise stop.",
    )
    expect(both.sent("injected")).toEqual([{ seqs: [], hold: null, stop: true, nudged: [4] }])
    const forced = await stopWith(["claude"], { unread: 2, block: true, forced: true, awaiting: 1 })
    expect(JSON.parse(forced.reply!).hookSpecificOutput!.additionalContext).toBe(
      "1 relay request requires your reply: relay_reply, or from a shell swarm reply <id> <text>.",
    )
    expect(forced.sent("injected")).toEqual([{ seqs: [], hold: null, stop: true }])
    const many = Array.from({ length: 5 }, (_, i) => nudge(`msg_${i}`, false, i + 1))
    const capped = await stopWith(["claude"], { block: true, forced: false, nudge: many, nudge_more: 2 })
    const lines = JSON.parse(capped.reply!).hookSpecificOutput!.additionalContext.split("\n")
    expect(lines).toHaveLength(6)
    expect(lines.at(-1)).toBe("and 2 more.")
    expect(capped.sent("injected")).toEqual([{ seqs: [], hold: null, nudged: [1, 2, 3, 4, 5] }])
  })

  test("an unprinted nudge is not confirmed, an older broker's hold still counts, and a stop that holds nothing prints nothing", async () => {
    const unprinted = await stopWith(["claude"], { block: true, forced: false, nudge: [nudge("msg_1", true, 7)] }, { print: () => false })
    expect(JSON.parse(unprinted.reply!).hookSpecificOutput!.hookEventName).toBe("Stop")
    expect(unprinted.sent("injected")).toEqual([])
    const older = await stopWith(["claude", BLOCK_STOP], { unread: 1, block: true })
    expect(older.sent("injected")).toEqual([{ seqs: [], hold: null, stop: true }])
    const free = await stopWith(["claude"], { unread: 3, block: false, forced: false })
    expect(free.reply).toBeUndefined()
    expect(free.sent("injected")).toEqual([])
    const subagent = await stopWith(
      ["claude"],
      { block: true, nudge: [nudge("msg_1", true, 7)] },
      { payload: { hook_event_name: "SubagentStop", agent_id: "a1" } },
    )
    expect(subagent.reply).toBeUndefined()
    expect(subagent.sent("inject")).toEqual([])
  })
})

describe("the OpenCode plugin", () => {
  test("the generated plugin preserves its install markers and enables the wake waiter by environment", () => {
    const source = opencodePlugin()
    expect(source).toStartWith("// scp:")
    expect(source).toContain("const BLOCK_STOP = false")
    expect(source).toContain('process.env.SCP_WAKE !== "0"')
    expect(source).toContain('["swarm", "hook", "opencode", "--wake", "50"]')
  })

  type Calls = { args: string[]; payload: Record<string, unknown> }[]
  async function load(
    reply: Record<string, unknown>,
    sessions: Record<string, string | undefined> = {},
    flaky: string[] = [],
    blockStop = true,
    enableWake = false,
    delayWake = false,
  ) {
    const root = mkdtempSync(join(process.env.HOME!, "oc-plugin-"))
    const bin = join(root, "bin")
    mkdirSync(bin)
    const log = join(root, "calls.log")
    const replyFile = join(root, "reply.json")
    writeFileSync(replyFile, JSON.stringify(reply))
    writeFileSync(
      join(bin, "swarm"),
      `#!/bin/sh\nline="$(printf '%s\\t' "$*")$(cat)"\nprintf '%s\\n' "$line" >> '${log}'\n${delayWake ? "trap 'exit 0' TERM\n" : ""}cat '${replyFile}'\n${delayWake ? 'case "$*" in *--wake*) sleep 1;; esac\n' : ""}`,
      { mode: 0o755 },
    )
    const file = join(root, "scp.ts")
    writeFileSync(file, opencodePlugin({ blockStop }))
    const prompts: unknown[] = []
    const lookups: string[] = []
    const client = {
      session: {
        promptAsync: async (args: unknown) => void prompts.push(args),
        create: async () => ({ data: { id: "ses_opened" } }),
        get: async ({ path }: { path: { id: string } }) => {
          lookups.push(path.id)
          if (flaky.includes(path.id) && lookups.filter((id) => id === path.id).length === 1) return { error: { name: "NotFound" } }
          return { data: { id: path.id, parentID: sessions[path.id] } }
        },
      },
    }
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    const wake = process.env.SCP_WAKE
    process.env.SCP_WAKE = enableWake ? "1" : "0"
    const plugin = await (async () => {
      try {
        return await (await import(file)).Scp({ client, directory: "/work/oc" })
      } finally {
        if (wake === undefined) delete process.env.SCP_WAKE
        else process.env.SCP_WAKE = wake
      }
    })()
    const calls = (): Calls =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [args, payload] = line.split("\t")
              return { args: args!.split(" "), payload: JSON.parse(payload!) }
            })
        : []
    const settle = async (count: number) => {
      for (let i = 0; i < 100 && calls().length < count; i++) await Bun.sleep(50)
      await Bun.sleep(100)
    }
    return {
      plugin,
      calls,
      prompts,
      lookups,
      settle,
      setReply: (next: unknown) => writeFileSync(replyFile, JSON.stringify(next)),
      restore: () => (process.env.PATH = path),
    }
  }

  test("one process waiter wakes the last idle root only while no root is busy", async () => {
    const oc = await load({ hookSpecificOutput: { additionalContext: "WAKE-CONTEXT" } }, { ses_child: "ses_root" }, [], false, true)
    try {
      await oc.plugin.event({ event: { type: "session.status", properties: { sessionID: "ses_root", status: { type: "busy" } } } })
      await oc.plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_other", info: { id: "ses_other" } } } })
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
      await oc.settle(1)
      expect(oc.calls().filter((c) => c.args.includes("--wake"))).toEqual([])
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
      await oc.settle(3)
      const wakes = oc.calls().filter((c) => c.args.includes("--wake"))
      expect(wakes).toHaveLength(1)
      expect(wakes[0]).toEqual({
        args: ["hook", "opencode", "--wake", "50"],
        payload: { hook_event_name: "Wake", session_id: "ses_root", cwd: "/work/oc" },
      })
      expect(oc.prompts).toEqual([{ path: { id: "ses_root" }, body: { parts: [{ type: "text", text: "WAKE-CONTEXT" }] } }])
    } finally {
      await oc.plugin.event({ event: { type: "session.deleted", properties: { sessionID: "ses_root" } } })
      oc.restore()
    }
  })

  test("before any session, the waiter starts on its own and opens a session for the message it shows", async () => {
    const oc = await load({ hookSpecificOutput: { additionalContext: "FRESH-CONTEXT" } }, {}, [], false, true)
    try {
      for (let i = 0; i < 100 && !oc.prompts.length; i++) await Bun.sleep(50)
      expect(oc.calls().filter((c) => c.args.includes("--wake"))[0]).toEqual({
        args: ["hook", "opencode", "--wake", "50"],
        payload: { hook_event_name: "Wake", cwd: "/work/oc" },
      })
      expect(oc.prompts).toEqual([{ path: { id: "ses_opened" }, body: { parts: [{ type: "text", text: "FRESH-CONTEXT" }] } }])
    } finally {
      await oc.plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_opened", info: { id: "ses_opened" } } } })
      await oc.plugin.event({ event: { type: "session.deleted", properties: { sessionID: "ses_opened" } } })
      oc.restore()
    }
  })

  test("a waiter that printed still queues its prompt after a root turns busy", async () => {
    const oc = await load({ hookSpecificOutput: { additionalContext: "PRINTED-CONTEXT" } }, {}, [], false, true, true)
    try {
      await oc.plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_root", info: { id: "ses_root" } } } })
      await oc.settle(2)
      expect(oc.prompts).toEqual([])
      await oc.plugin.event({ event: { type: "session.status", properties: { sessionID: "ses_root", status: { type: "retry" } } } })
      for (let i = 0; i < 40 && !oc.prompts.length; i++) await Bun.sleep(50)
      expect(oc.prompts).toEqual([{ path: { id: "ses_root" }, body: { parts: [{ type: "text", text: "PRINTED-CONTEXT" }] } }])
      expect(oc.calls().filter((c) => c.args.includes("--wake"))).toHaveLength(1)
    } finally {
      await oc.plugin.event({ event: { type: "session.deleted", properties: { sessionID: "ses_root" } } })
      oc.restore()
    }
  })

  test("a child session's start and idle are ignored, its tools report as a subagent, and nothing is injected into it", async () => {
    const oc = await load({ hookSpecificOutput: { additionalContext: "CTX" }, decision: "block", reason: "r", unread: 1 }, { ses_known_child: "ses_root" })
    try {
      await oc.plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: "ses_root" } } } })
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_child" } } })
      const output = { output: "tool output" }
      await oc.plugin["tool.execute.after"]({ tool: "read", sessionID: "ses_child", args: {} }, output)
      await oc.plugin["tool.execute.after"]({ tool: "read", sessionID: "ses_known_child", args: {} }, output)
      const message = { message: { id: "msg_1" }, parts: [] as Record<string, unknown>[] }
      await oc.plugin["chat.message"]({ sessionID: "ses_child" }, message)
      await oc.settle(2)
      expect(output.output).toBe("tool output")
      expect(message.parts).toEqual([])
      expect(oc.prompts).toEqual([])
      expect(oc.calls().map((c) => c.payload.hook_event_name)).toEqual(["PostToolUse", "PostToolUse"])
      expect(oc.calls().every((c) => typeof c.payload.agent_id === "string")).toBe(true)
    } finally {
      oc.restore()
    }
  })

  test("a failed session lookup is retried rather than remembered, and a deleted session is looked up again", async () => {
    const oc = await load({ hookSpecificOutput: { additionalContext: "CTX" } }, { ses_flaky: "ses_root" }, ["ses_flaky"])
    try {
      const first = { output: "out" }
      await oc.plugin["tool.execute.after"]({ tool: "read", sessionID: "ses_flaky", args: {} }, first)
      const second = { output: "out" }
      await oc.plugin["tool.execute.after"]({ tool: "read", sessionID: "ses_flaky", args: {} }, second)
      expect(second.output).toBe("out")
      await oc.settle(2)
      expect(oc.calls().at(-1)!.payload.agent_id).toEqual(expect.any(String))
      expect(oc.lookups).toEqual(["ses_flaky", "ses_flaky"])
      await oc.plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_gone", info: { id: "ses_gone", parentID: "ses_root" } } } })
      await oc.plugin.event({ event: { type: "session.deleted", properties: { sessionID: "ses_gone", info: { id: "ses_gone" } } } })
      await oc.plugin["tool.execute.after"]({ tool: "read", sessionID: "ses_gone", args: {} }, { output: "out" })
      expect(oc.lookups).toEqual(["ses_flaky", "ses_flaky", "ses_gone"])
    } finally {
      oc.restore()
    }
  })

  test("a root session's idle stop prompts with the hook's reason, never a wrapped message; a prompt gets a valid, later part; nothing is consumed where text cannot go", async () => {
    const oc = await load({ decision: "block", reason: "<relay-message>BODY-MARKER</relay-message>", unread: 2 })
    try {
      await oc.plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_root", info: { id: "ses_root" } } } })
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
      await oc.settle(2)
      expect(
        oc
          .calls()
          .map((c) => c.payload.hook_event_name)
          .sort(),
      ).toEqual(["SessionStart", "Stop"])
      expect(oc.prompts).toEqual([])
      const reason = "You have 2 unread relay messages; call relay_inbox, or run swarm inbox from a shell, to read them."
      oc.setReply({ decision: "block", reason, unread: 2 })
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
      await oc.settle(3)
      expect(oc.prompts).toEqual([{ path: { id: "ses_root" }, body: { parts: [{ type: "text", text: reason }] } }])
      oc.setReply({ hookSpecificOutput: { additionalContext: "CTX" } })
      const empty = { message: { id: "msg_a" }, parts: [] as Record<string, unknown>[] }
      await oc.plugin["chat.message"]({ sessionID: "ses_root" }, empty)
      expect(empty.parts).toEqual([
        {
          id: expect.stringMatching(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
          sessionID: "ses_root",
          messageID: "msg_a",
          type: "text",
          text: "CTX",
          synthetic: true,
        },
      ])
      const future = "prt_ffffffffff00AAAAAAAAAAAAAA"
      const full = { message: { id: "msg_b" }, parts: [{ id: future, type: "text", text: "hi" }] as Record<string, unknown>[] }
      await oc.plugin["chat.message"]({ sessionID: "ses_root" }, full)
      expect(String(full.parts[1]!.id) > future).toBe(true)
      const last = { message: { id: "msg_c" }, parts: [{ id: "prt_ffffffffffffAAAAAAAAAAAAAA", type: "text", text: "hi" }] as Record<string, unknown>[] }
      await oc.plugin["chat.message"]({ sessionID: "ses_root" }, last)
      expect(String(last.parts[1]!.id).startsWith("prt_ffffffffffff")).toBe(true)
      const before = oc.calls().length
      await oc.plugin["chat.message"]({ sessionID: "ses_root" }, { parts: [] })
      expect(oc.calls()).toHaveLength(before)
      await oc.plugin["tool.execute.after"]({ tool: "read", sessionID: "ses_root", args: {} }, { output: { not: "text" } })
      expect(oc.calls().at(-1)!.args).toContain("--no-inject")
    } finally {
      oc.restore()
    }
  })

  test("an idle after an error or a user's abort is reported but never held; the next answer that ends cleanly is", async () => {
    const oc = await load({ decision: "block", reason: "r", unread: 1 })
    try {
      const assistant = (error?: Record<string, unknown>) => ({
        type: "message.updated",
        properties: { info: { id: "msg_x", sessionID: "ses_root", role: "assistant", ...(error ? { error } : {}) } },
      })
      await oc.plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_root", info: { id: "ses_root" } } } })
      await oc.plugin.event({ event: assistant({ name: "MessageAbortedError", data: {} }) })
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
      await oc.plugin.event({ event: assistant() })
      await oc.plugin.event({ event: { type: "session.error", properties: { sessionID: "ses_root", error: { name: "ProviderAuthError" } } } })
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
      await oc.settle(3)
      expect(oc.prompts).toEqual([])
      const stops = oc.calls().filter((c) => c.payload.hook_event_name === "Stop")
      expect(stops).toHaveLength(2)
      expect(stops.every((c) => !c.args.includes(BLOCK_STOP))).toBe(true)
      await oc.plugin.event({ event: assistant() })
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
      await oc.settle(4)
      expect(
        oc
          .calls()
          .filter((c) => c.payload.hook_event_name === "Stop")
          .at(-1)!.args,
      ).toContain(BLOCK_STOP)
      expect(oc.prompts).toHaveLength(1)
    } finally {
      oc.restore()
    }
  })

  test("without the flag a clean idle still asks the hook and starts a turn once per nudge, read or not; a failed idle takes nothing", async () => {
    const reason = "me/lead asked you something (msg_1); reply with relay_reply if it helps, otherwise stop."
    const oc = await load({ decision: "block", reason, unread: 0 }, {}, [], false)
    try {
      await oc.plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_root", info: { id: "ses_root" } } } })
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
      await oc.settle(2)
      const stop = oc.calls().find((c) => c.payload.hook_event_name === "Stop")!
      expect(stop.args).not.toContain(BLOCK_STOP)
      expect(stop.args).not.toContain("--no-inject")
      expect(oc.prompts).toEqual([{ path: { id: "ses_root" }, body: { parts: [{ type: "text", text: reason }] } }])
      oc.setReply({})
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
      await oc.settle(3)
      expect(oc.prompts).toHaveLength(1)
      oc.setReply({ decision: "block", reason, unread: 0 })
      await oc.plugin.event({ event: { type: "session.error", properties: { sessionID: "ses_root", error: { name: "ProviderAuthError" } } } })
      await oc.plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_root" } } })
      await oc.settle(4)
      expect(oc.calls().at(-1)!.args).toContain("--no-inject")
      expect(oc.prompts).toHaveLength(1)
    } finally {
      oc.restore()
    }
  })
})
