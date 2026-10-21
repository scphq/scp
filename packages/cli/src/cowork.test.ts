import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { coworkMcpGuard } from "./mcp"
import { hookEntries, runHook } from "./hooks"
import { hookFormat, relayIdentity } from "./identity"
import { parseSetupArgs, relaySetup } from "./setup"

const claim = (env: Record<string, string>, as?: string) =>
  relayIdentity({
    ...(as ? { as } : {}),
    harness: "claude",
    fallbackHarness: "mcp",
    env,
    cwd: "/work",
    harnessPid: () => 77,
    startOf: () => "s",
    lineageOf: () => [],
    t3Hosted: () => env.HOSTED === "1",
  })

test("Cowork labels preserve the provider session and choose a valid attached-folder handle", () => {
  const env = { CLAUDE_CODE_IS_COWORK: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_SESSION_ID: "abcdefgh-1234" }
  expect(claim(env)).toMatchObject({ harness: "claude-cowork", harness_session: "abcdefgh-1234", handle: "cowork-abcdefgh" })
  for (const paths of ["/work/My Folder+X:/work/second", JSON.stringify(["/work/My Folder+X", "/work/second"])])
    expect(claim({ ...env, CLAUDE_CODE_WORKSPACE_HOST_PATHS: paths }).handle).toBe("cowork-my-folder-x")
  expect(claim({ ...env, CLAUDE_CODE_WORKSPACE_HOST_PATHS: `/work/${"x".repeat(100)}` }).handle).toHaveLength(63)
  expect(claim({ ...env, SCP_NAME: "chosen" }).handle).toBe("chosen")
  expect(claim({ ...env, SCP_NAME: "chosen" }, "explicit").handle).toBe("explicit")
  expect(claim({ ...env, HOSTED: "1" }).harness).toBe("t3code")
  expect(hookFormat("claude-cowork", "claude-cowork")).toBe("claude-code")
})

test("synced hooks return silently before stdin or a broker connection outside Cowork", async () => {
  for (const marker of [undefined, "0", "1"]) {
    const active = marker === "1"
    const sentinel = new Error("connected")
    const run = runHook(["claude", "--cowork-only"], {
      env: { HOME: "/unused", SCP_DIR: "/unused", SCP_HARNESS_DETECT: "0", ...(marker ? { CLAUDE_CODE_IS_COWORK: marker } : {}) },
      cwd: "/work",
      stdin: Readable.from([JSON.stringify({ hook_event_name: "SessionStart", session_id: "hook-session" })]),
      connect: async () => {
        throw sentinel
      },
      harnessPid: () => 77,
      startOf: () => "s",
      psTable: () => undefined,
    })
    if (active) await expect(run).rejects.toThrow("connected")
    else expect(await run).toBeUndefined()
  }
})

test("the synced MCP server answers requests without tools, ignores notifications and exits at EOF", async () => {
  const requests = [
    { id: 1, method: "initialize", params: { protocolVersion: "future-version" } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "ping" },
    { id: 4, method: "tools/call" },
  ]
    .map((request) => JSON.stringify({ jsonrpc: "2.0", ...request }))
    .join("\n")
  const lines: string[] = []
  expect(
    await coworkMcpGuard(
      { "cowork-only": true },
      { env: {}, input: Readable.from([requests.slice(0, 19), requests.slice(19)]), output: (line) => lines.push(line) },
    ),
  ).toBe(true)
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "future-version",
        capabilities: {},
        serverInfo: { name: "scp", version: "0.0.0" },
        instructions: "SCP is inactive outside Cowork.",
      },
    },
    { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    { jsonrpc: "2.0", id: 3, result: {} },
    { jsonrpc: "2.0", id: 4, error: { code: -32601, message: "Method not found" } },
  ])
  const input = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      throw new Error("read stdin")
    },
  }
  expect(
    await coworkMcpGuard(
      { "cowork-only": true },
      {
        env: { CLAUDE_CODE_IS_COWORK: "1" },
        input,
        output: () => {
          throw new Error("wrote output")
        },
      },
    ),
  ).toBe(false)
})

test("setup builds only the plugin and root zip entries with absolute launch paths, replacing stale files", () => {
  const root = realpathSync(mkdtempSync(join(process.env.HOME!, "scp-cowork-")))
  const bin = join(root, "source checkout", "packages/cli/dist/cli.js")
  const node = join(root, "node")
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, "#!/usr/bin/env node\n", { mode: 0o755 })
  writeFileSync(node, "#!/bin/sh\n", { mode: 0o755 })
  const state = join(root, "state")
  const home = join(root, "home")
  const plugin = join(state, "cowork-plugin")
  const lines: string[] = []
  const deps = {
    env: { HOME: home, SCP_DIR: state },
    cwd: root,
    version: "1.2.3",
    out: (line: string) => lines.push(line),
    which: (name: string) => (name === "swarm" ? bin : name === "node" ? node : undefined),
    run: () => {
      throw new Error("ran a harness")
    },
    t3: () => {
      throw new Error("detected apps")
    },
  }
  expect(parseSetupArgs(["--cowork", "--bin", bin])).toEqual({ cowork: true, bin })
  expect(relaySetup({ cowork: true, bin }, deps)).toBe(0)
  const read = (path: string) => JSON.parse(readFileSync(join(plugin, path), "utf8"))
  expect(read(".claude-plugin/plugin.json")).toMatchObject({ name: "scp", version: "1.2.3", homepage: "https://scp.dev" })
  expect(read(".mcp.json")).toEqual({ mcpServers: { scp: { command: node, args: [bin, "mcp", "--harness", "claude", "--channels", "--cowork-only"] } } })
  expect(read("hooks/hooks.json")).toEqual({ hooks: hookEntries("claude", { launcher: [node, bin], cowork: true }) })
  expect(existsSync(home)).toBe(false)
  expect(readdirSync(plugin).sort()).toEqual([".claude-plugin", ".mcp.json", "hooks"])
  const archive = readFileSync(join(state, "scp-cowork.zip"))
  let at = 0
  const paths: string[] = []
  while (archive.readUInt32LE(at) === 0x04034b50) {
    const length = archive.readUInt16LE(at + 26)
    const path = archive.subarray(at + 30, at + 30 + length).toString()
    const size = archive.readUInt32LE(at + 18)
    const data = archive.subarray(at + 30 + length, at + 30 + length + size)
    expect(data.equals(readFileSync(join(plugin, path)))).toBe(true)
    paths.push(path)
    at += 30 + length + size
  }
  expect(paths).toEqual([".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"])
  writeFileSync(join(plugin, "stale"), "stale")
  expect(relaySetup({ cowork: true }, deps)).toBe(0)
  expect(existsSync(join(plugin, "stale"))).toBe(false)
  expect(lines.join("\n")).toContain("Customize, Plugins, Add, Upload plugin")
  expect(() => relaySetup({ cowork: true, undo: true }, deps)).toThrow()
})

test("the CLI fast path exits zero without output or reading stdin outside Cowork", async () => {
  const root = mkdtempSync(join(process.env.HOME!, "cowork-guard-"))
  for (const flags of [[], ["--subagent"]]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "cli.ts"), "hook", "claude", "--cowork-only", ...flags], {
      env: { HOME: root, SCP_DIR: join(root, "state"), CLAUDE_CODE_IS_COWORK: "0" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("")
    expect(await new Response(child.stderr).text()).toBe("")
    expect(existsSync(join(root, "state"))).toBe(false)
    child.stdin.end()
  }
})
