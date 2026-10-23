import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { type HookParams, RelayClient, startBroker, readOwnedFile } from "@scp-dev/broker"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HOOK_ENV, hookHandler, hookProcs, procOptions, relayHookRpc, shrinkHook } from "./hook-rpc"
import { hookHarnessPid, processKey } from "./identity"

const params = (): HookParams => ({ args: ["codex"], payload: {}, env: {}, origin: 1, ends: Date.now() + 1000, ppid: 30, procs: [] })
describe("thin hook client", () => {
  test("shared environment list covers every environment read on the hook path", () => {
    const shared = JSON.parse(readFileSync(new URL("../../spec/schema/broker/hook-env.json", import.meta.url), "utf8"))
    expect(shared).toEqual([...HOOK_ENV])
    for (const name of ["hooks.ts", "identity.ts", "hook-fast.ts", "cwd.ts"]) {
      const text = readFileSync(new URL(name, import.meta.url), "utf8")
      for (const [, key] of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) expect(shared).toContain(key)
    }
  })
  test("shrink preserves small payloads and clips Unicode strings and nested arrays", () => {
    const small = params()
    expect(shrinkHook(small)).toBe(small)
    const large = { ...small, payload: { text: "😀".repeat(90_000), nested: Array.from({ length: 100 }, () => ({ text: "a".repeat(9000) })) } }
    const shrunk = shrinkHook(large)
    expect(Array.from(shrunk.payload.text as string)).toHaveLength(1024)
    expect(shrunk.payload.nested as unknown[]).toHaveLength(64)
    expect(large.payload.nested).toHaveLength(100)
  })
  test("shrink uses the final scalar fallback without changing keys", () => {
    const input = { ...params(), payload: { ["key".repeat(90_000)]: { text: "long" }, keep: "value", number: 2, yes: true, nil: null, drop: [] } }
    expect(shrinkHook(input).payload).toEqual({ keep: "value", number: 2, yes: true, nil: null })
  })
  test("ancestry-derived harness keys match process-table derivation", () => {
    const table = new Map([
      [30, { ppid: 20, start: "shell", args: "sh -c hook" }],
      [20, { ppid: 10, start: "harness", args: "claude" }],
      [10, { ppid: 1, start: "launcher", args: "launcher" }],
      [1, { ppid: 0, start: "init", args: "init" }],
      [99, { ppid: 1, start: "unrelated", args: "other" }],
    ])
    for (const env of [{}, { CLAUDE_PID: "20" }, { OPENCODE_PID: "20" }, { SCP_HARNESS_PID: "10" }]) {
      const parent = { ppid: 20, comm: "/bin/sh" }
      const procs = hookProcs(30, env, table, parent)
      expect(procs.map((proc) => proc.pid)).toEqual([30, 20, 10, 1])
      const input = { ...params(), env, procs }
      for (const harness of ["claude-code", "opencode", "codex"]) {
        const pid = hookHarnessPid(env, harness, 30, () => parent)
        expect(procOptions(input).harnessPid(harness)).toBe(pid)
        expect(processKey(pid, procOptions(input).startOf)).toBe(processKey(pid, (pid) => table.get(pid)?.start))
      }
    }
  })
  test("a failed write never sends commit, and old brokers request no hook", async () => {
    for (const capable of [false, true])
      for (const printed of [false, true]) {
        const calls: string[] = []
        const client = {
          hello: async () => ({ capabilities: capable ? ["hook"] : [] }),
          onNotification: () => {},
          request: async (method: string) => {
            calls.push(method)
            return method === "hook" ? { stdout: "output", exit: 0, commit: "token" } : {}
          },
        } as unknown as RelayClient
        const reply = await relayHookRpc(
          client,
          params(),
          () => printed,
          () => {},
        )
        expect(calls).toEqual(capable ? (printed ? ["hook", "hook_commit"] : ["hook"]) : [])
        expect(reply === undefined).toBe(!capable)
      }
  })
})

test("server hooks use supplied process starts and confine file access", async () => {
  const root = mkdtempSync(join(tmpdir(), "hook-files-"))
  const dir = join(root, "state")
  let lookups = 0
  const broker = await startBroker({
    dir,
    idleMs: 0,
    hook: hookHandler(dir, dir),
    startOf: () => {
      lookups++
      return undefined
    },
  })
  try {
    const input: HookParams = {
      ...params(),
      args: ["codex"],
      payload: { hook_event_name: "PostToolUse", tool_name: "Read" },
      cwd: root,
      env: { SCP_NAME: "snapshot", SCP_SESSION: "snapshot", HOME: root, SCP_DIR: dir },
      ppid: process.pid,
      procs: [{ pid: process.pid, ppid: 1, start: "snapshot", args: "codex", comm: "codex" }],
    }
    const client = await RelayClient.connect(broker.socket)
    try {
      await relayHookRpc(
        client,
        input,
        () => true,
        () => {},
      )
    } finally {
      client.close()
    }
    expect(lookups).toBe(0)
    expect(broker.core.list().find((endpoint) => endpoint.address === "me/snapshot")?.harness).toBe("codex")
    for (const file of [join(dir, "conversation"), join(root, "outside")]) {
      const client = await RelayClient.connect(broker.socket)
      try {
        await relayHookRpc(
          client,
          { ...params(), args: ["agy"], payload: { conversationId: "session" }, env: { SCP_AGY_CONVERSATION_FILE: file } },
          () => true,
          () => {},
        )
      } finally {
        client.close()
      }
    }
    expect(readFileSync(join(dir, "conversation"), "utf8")).toBe("session")
    expect(existsSync(join(root, "outside"))).toBe(false)
    writeFileSync(join(root, "regular"), "data")
    symlinkSync(join(root, "regular"), join(root, "link"))
    expect(readOwnedFile(join(root, "regular"))).toBe("data")
    expect(() => readOwnedFile(root)).toThrow()
    expect(() => readOwnedFile(join(root, "link"))).toThrow()
  } finally {
    await broker.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
