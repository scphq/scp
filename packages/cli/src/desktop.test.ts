import { Readable } from "node:stream"
import { expect, test } from "bun:test"
import type { RelayClient } from "@scp-dev/broker"
import { claimHarness, spawnEnvironment, walkNow } from "./common"
import { runHook } from "./hooks"
import { detectHarness, harnessVariant, codexShell, hookFormat, hookHarnessPid, parsePsCommTable, relayIdentity } from "./identity"

const bundle = "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server --listen stdio://"
const ps = (args: string, parent = "launchd") => parsePsCommTable(`77 10 Wed Oct 21 09:00:00 2026 ${args}\n10 1 Wed Oct 21 08:00:00 2026 ${parent}`)
const claim = (harness: string, env: Record<string, string> = {}, args = "codex app-server", parent?: string) =>
  relayIdentity({
    harness,
    fallbackHarness: "mcp",
    cwd: "/tmp",
    env,
    harnessPid: () => 77,
    startOf: () => "s",
    lineageOf: () => [],
    psTable: () => ps(args, parent),
    harnessSession: "desktop-session",
  })

test("desktop environment markers label only their provider and preserve Claude sessions", () => {
  expect(claim("claude-code", { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" })).toMatchObject({
    harness: "claude-desktop",
    harness_session: "desktop-session",
  })
  expect(claim("codex", { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop", SCP_HARNESS_DETECT: "0" }).harness).toBe("codex-desktop")
  expect(claim("codex", { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }).harness).toBe("codex")
  expect(claim("claude-code", { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }).harness).toBe("claude-code")
  expect(claim("codex", { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_vscode" }).harness).toBe("codex")
  expect(claim("codex").harness).toBe("codex")
})

test("the desktop bundle's codex process labels MCP shims without the originator", () => {
  expect(claim("codex", {}, bundle).harness).toBe("codex-desktop")
  expect(claim("codex", {}, "/Applications/Codex Desktop.app/Contents/Resources/codex-cli/codex app-server").harness).toBe("codex-desktop")
  expect(claim("codex", {}, bundle.replace("app-server", "exec")).harness).toBe("codex")
  expect(claim("codex", {}, bundle.replace("app-server", "app-server-other")).harness).toBe("codex")
  expect(claim("codex", { SCP_HARNESS_DETECT: "0" }, bundle).harness).toBe("codex")
  expect(claim("codex", {}, "/extensions/codex/bin/codex app-server").harness).toBe("codex")
  expect(claim("codex", {}, "/Applications/Codex.app/Contents/MacOS/codex app-server").harness).toBe("codex")
  expect(claim("codex", {}, "/usr/bin/node /Applications/Codex.app/Contents/Resources/codex-cli/codex").harness).toBe("codex")
  expect(claim("claude-code", {}, bundle).harness).toBe("claude-code")
})

test("T3 Code takes precedence over desktop markers and bundle detection", () => {
  expect(claim("claude-code", { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, "claude", "t3 serve").harness).toBe("t3code")
  expect(claim("codex", { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, bundle, "t3 serve").harness).toBe("t3code")
  expect(claim("codex", { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code" }, bundle).harness).toBe("t3code")
})

test("explicit desktop labels retain provider session keys, hook formats and shell bindings", () => {
  expect(claim("claude-desktop").harness_session).toBe("desktop-session")
  expect(hookFormat("claude-desktop", "claude-desktop")).toBe("claude-code")
  expect(hookFormat("codex-desktop", "codex-desktop")).toBe("codex")
  expect(hookFormat("t3code", "claude-desktop")).toBe("claude-code")
  expect(hookFormat("t3code", "codex-desktop")).toBe("codex")
  expect(hookHarnessPid({ CLAUDE_PID: "77" }, "claude-desktop", 99, () => undefined)).toBe(77)
  expect(codexShell({ SCP_HARNESS: "codex-desktop" })).toBe(true)
  expect(spawnEnvironment({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, {})).toEqual({})
})

test("desktop hooks retain provider replies and Claude harness_session", async () => {
  const run = async (harness: string, markers: Record<string, string>) => {
    const claims: Record<string, unknown>[] = []
    const client = {
      hello: async (params: { claim: Record<string, unknown> }) => {
        claims.push(params.claim)
        return { endpoint: { title: "t" } }
      },
      request: async (method: string) =>
        method === "inject"
          ? { messages: [], offered: [], hold: null, more: 0, unread: 1, block: true, nudge: [{ seq: 7, from: "me/lead", id: "msg_1", unread: true }] }
          : {},
      close: () => {},
    }
    const reply = await runHook([harness], {
      env: { HOME: "/tmp", SCP_HARNESS_DETECT: "0", SCP_SESSION: "desktop-hook", SCP_NAME: "desktop-hook", ...markers },
      cwd: "/tmp",
      stdin: Readable.from([JSON.stringify({ hook_event_name: "Stop", session_id: "hook-session", cwd: "/tmp" })]),
      connect: async () => client as unknown as RelayClient,
      harnessPid: () => 77,
      startOf: () => "s",
      psTable: () => ps("codex app-server"),
    })
    return { reply, claim: claims[0] }
  }
  for (const [provider, desktop, markers] of [
    ["codex", "codex-desktop", { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }],
    ["claude", "claude-desktop", { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }],
  ] as const) {
    const plain = await run(provider, {})
    const hosted = await run(provider, markers)
    expect(hosted.claim?.harness).toBe(desktop)
    expect(hosted.reply).toBeTruthy()
    expect(hosted.reply).toBe(plain.reply)
    if (provider === "claude") expect(hosted.claim?.harness_session).toBe("hook-session")
    else expect(JSON.parse(hosted.reply!)).toMatchObject({ decision: "block", reason: expect.any(String) })
  }
})

const coworkEnv = {
  CLAUDE_CODE_IS_COWORK: "1",
  CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
  CLAUDE_CODE_MESSAGING_SOCKET: "/fake/socket",
  CLAUDE_CODE_MESSAGING_TOKEN: "fake-token",
  CLAUDE_CODE_SESSION_ID: "fake-session",
  CLAUDE_CODE_WORKSPACE_HOST_PATHS: "/fake/workspace",
}

test("workers drop the parent desktop and Cowork session identity, with explicit grants still applied", () => {
  expect(spawnEnvironment({ ...coworkEnv, PATH: "/bin" }, {})).toEqual({ PATH: "/bin" })
  expect(spawnEnvironment(coworkEnv, { CLAUDE_CODE_SESSION_ID: "explicit-session" })).toEqual({ CLAUDE_CODE_SESSION_ID: "explicit-session" })
})

test("codex markers take precedence over inherited Cowork markers", () => {
  for (const marker of [{ CODEX_THREAD_ID: "thread" }, { CODEX_SANDBOX: "seatbelt" }, { CODEX_SANDBOX_NETWORK_DISABLED: "1" }])
    expect(detectHarness({ ...coworkEnv, ...marker })).toBe("codex")
})

test("shell claims and process walks use the session's hosted label", () => {
  for (const [env, provider, label, args] of [
    [{ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, "claude-code", "claude-desktop", "claude"],
    [{ CLAUDECODE: "1", ...coworkEnv }, "claude-code", "claude-cowork", "claude"],
    [{ CODEX_THREAD_ID: "thread", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, "codex", "codex-desktop", "codex app-server"],
  ] as const) {
    expect(claimHarness({}, env, undefined)).toBe(label)
    expect(claimHarness({}, env, { keys: [], self: [], harness: provider })).toBe(label)
    const walk = walkNow(env, 77, ps(args))
    expect(walk.harness).toBe(label)
    expect(claimHarness({}, env, walk)).toBe(label)
    expect(harnessVariant(provider, env, 77, () => ps(args, "t3 serve"))).toBe("t3code")
  }
  expect(walkNow({}, 77, ps(bundle)).harness).toBe("codex-desktop")
  expect(walkNow({}, 77, ps(bundle.replace("app-server", "exec"))).harness).toBe("codex")
})
