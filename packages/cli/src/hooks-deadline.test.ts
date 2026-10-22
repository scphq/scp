import { Readable } from "node:stream"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { BrokerUnavailable, connectBroker, startBroker } from "@scp-dev/broker"
import { HOOK_DEADLINE_MS, hookEnds, runHook } from "./hooks"
import { safeCwd } from "./cwd"

setDefaultTimeout(20_000)

const entry = join(import.meta.dir, "cli.ts")
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_THREAD_ID)/
const EPERM = "EPERM: process.cwd failed with error operation not permitted, uv_cwd"

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) env[key] = value
  return { ...env, ...extra }
}

/** a preload that makes process.cwd throw as a revoked directory does, after blocking `startMs` to stand in for a slow cold start */
function preload(startMs = 0): string {
  const file = join(mkdtempSync(join(process.env.HOME!, "preload-")), "preload.ts")
  writeFileSync(
    file,
    `${startMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${startMs})\n` : ""}process.cwd = () => { throw Object.assign(new Error(${JSON.stringify(EPERM)}), { code: "EPERM" }) }\n`,
  )
  return file
}

async function swarm(args: string[], stdin: unknown, env: Record<string, string>, startMs = 0) {
  const started = Date.now()
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload(startMs), entry, ...args], {
    stdin: new TextEncoder().encode(typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv(env),
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code, ms: Date.now() - started }
}

/** a broker dir whose lock this process holds but where nothing listens: every connect is refused as busy */
function busyDir(): string {
  const dir = join(mkdtempSync(join(process.env.HOME!, "busy-")), "state")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, "broker.lock"), `${process.pid}:${Math.floor(Date.now() / 1000)}`, { mode: 0o600 })
  return dir
}

describe("a revoked working directory", () => {
  test("safeCwd falls back to an absolute given directory, then $PWD, then HOME, never throwing", () => {
    const real = process.cwd
    process.cwd = () => {
      throw new Error(EPERM)
    }
    try {
      expect(safeCwd(["relative", "/from/payload"], { PWD: "/pwd", HOME: "/home" })).toBe("/from/payload")
      expect(safeCwd([undefined], { PWD: "/pwd", HOME: "/home" })).toBe("/pwd")
      expect(safeCwd([], { PWD: "not/absolute", HOME: "/home" })).toBe("/home")
    } finally {
      process.cwd = real
    }
    expect(safeCwd(["/elsewhere"])).toBe(process.cwd())
  })

  test("hooks exit 0 with nothing on stdout, and the CLI still runs", async () => {
    const empty = join(process.env.HOME!, "no-broker")
    const env = { SCP_DIR: empty, CLAUDECODE: "1" }
    for (const payload of [
      { hook_event_name: "UserPromptSubmit", prompt: "x", cwd: process.env.HOME },
      { hook_event_name: "Stop", cwd: process.env.HOME },
      { hook_event_name: "Stop" },
    ]) {
      expect(await swarm(["hook", "claude"], payload, env)).toMatchObject({ stdout: "", stderr: "", code: 0 })
    }
    const version = await swarm(["version"], "", env)
    expect(version).toMatchObject({ stderr: "", code: 0 })
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("a hook reaches a running broker under the payload's cwd", async () => {
    const root = mkdtempSync(join(process.env.HOME!, "cwd-broker-"))
    const dir = join(root, "state")
    const broker = await startBroker({ dir, policyPath: join(root, "policy.json"), idleMs: 0 })
    try {
      const payload = { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {}, session_id: "s1", cwd: root }
      expect(await swarm(["hook", "claude"], payload, { SCP_DIR: dir, CLAUDECODE: "1", SCP_NAME: "revoked" })).toMatchObject({ stdout: "", code: 0 })
      expect(broker.core.list().find((e) => e.address === "me/revoked")?.cwd).toBe(root)
    } finally {
      await broker.stop()
    }
  })
})

describe("the hook deadline counts from process start", () => {
  test("hookEnds is HOOK_DEADLINE_MS past the origin, agy's sooner once loaded", () => {
    expect(hookEnds(false, 1000, 1900)).toBe(1000 + HOOK_DEADLINE_MS)
    expect(hookEnds(true, 1000, 1100)).toBe(2000)
    expect(hookEnds(true, 1000, 1000 + HOOK_DEADLINE_MS)).toBe(1000 + HOOK_DEADLINE_MS)
  })

  test("a hook that started late retries a busy broker only within what is left, and prints nothing", async () => {
    const dir = busyDir()
    const began = Date.now() - 2000
    const budgets: number[] = []
    const printed: string[] = []
    const error = await runHook(["claude"], {
      env: cleanEnv({ CLAUDECODE: "1", SCP_SESSION: "deadline", SCP_NAME: "late" }),
      cwd: process.env.HOME!,
      stdin: Readable.from([JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "x", cwd: process.env.HOME })]),
      harnessPid: () => process.pid,
      startOf: () => "Wed-Oct-21-10:00:00-2026",
      psTable: () => new Map(),
      began,
      remaining: () => began + HOOK_DEADLINE_MS - Date.now(),
      print: (text) => printed.push(text) > 0,
      connect: (_start, retry) => {
        budgets.push(retry?.budgetMs ?? Number.NaN)
        return connectBroker(dir, undefined, retry)
      },
    }).catch((e: unknown) => e)
    const total = Date.now() - began
    expect(error).toBeInstanceOf(BrokerUnavailable)
    expect((error as BrokerUnavailable).busy).toBe(true)
    expect(budgets).toHaveLength(1)
    expect(budgets[0]).toBeGreaterThan(0)
    expect(budgets[0]).toBeLessThanOrEqual(HOOK_DEADLINE_MS - 2000 - 1000)
    expect(total).toBeLessThan(HOOK_DEADLINE_MS)
    expect(printed).toEqual([])
  })

  test("a slow start and a busy broker still end the hook inside the deadline: exit 0, no stdout, one stderr line", async () => {
    const dir = busyDir()
    for (const payload of [
      { hook_event_name: "UserPromptSubmit", prompt: "x", cwd: process.env.HOME },
      { hook_event_name: "Stop", cwd: process.env.HOME },
    ]) {
      const result = await swarm(["hook", "claude"], payload, { SCP_DIR: dir, CLAUDECODE: "1" }, 1500)
      expect(result).toMatchObject({ stdout: "", code: 0 })
      expect(result.stderr.trim().split("\n").filter(Boolean).length).toBeLessThanOrEqual(1)
      expect(result.ms).toBeLessThan(HOOK_DEADLINE_MS + 1000)
    }
  })
})
