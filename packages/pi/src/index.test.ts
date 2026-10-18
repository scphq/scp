import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import scp, { shimArgv, toolResult } from "./index"

test("the shim runs swarm mcp for harness pi with channels, named by SCP_NAME", () => {
  expect(shimArgv({})).toEqual(["swarm", "mcp", "--harness", "pi", "--channels"])
  expect(shimArgv({ SCP_NAME: "demo", SCP_PI_SWARM: '["bun","cli.ts"]' })).toEqual(["bun", "cli.ts", "mcp", "--harness", "pi", "--channels", "--as", "demo"])
  expect(() => shimArgv({ SCP_PI_SWARM: '"swarm"' })).toThrow("JSON array")
})

test("an MCP tool result becomes pi content, and an error result fails the call", () => {
  expect(toolResult({ content: [{ type: "text", text: "ok" }, { type: "audio" }] })).toEqual({ content: [{ type: "text", text: "ok" }], details: {} })
  expect(() => toolResult({ content: [{ type: "text", text: "not_found: nobody" }], isError: true })).toThrow("not_found: nobody")
})

const FAKE_SHIM = `
const { appendFileSync } = require("node:fs")
const log = process.env.FAKE_LOG
appendFileSync(log, "start\\n")
process.on("SIGTERM", () => setTimeout(() => { appendFileSync(log, "exit\\n"); process.exit(0) }, 150))
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (let nl; (nl = buffer.indexOf("\\n")) >= 0; ) {
    const message = JSON.parse(buffer.slice(0, nl))
    buffer = buffer.slice(nl + 1)
    if (message.id === undefined) continue
    const result =
      message.method === "tools/list" ? { tools: [] }
      : message.method === "tools/call" ? { content: [{ type: "text", text: "unavailable: no free handle" }], isError: process.env.FAKE_FAIL === "1" }
      : {}
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n")
  }
})
`

function fakePi(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "scp-pi-"))
  const script = join(dir, "shim.cjs")
  const log = join(dir, "log")
  writeFileSync(script, FAKE_SHIM)
  writeFileSync(log, "")
  const saved = { ...process.env }
  Object.assign(process.env, { SCP_PI_SWARM: JSON.stringify([process.execPath, script]), FAKE_LOG: log, ...env })
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>()
  const warnings: string[] = []
  const ctx = { hasUI: true, ui: { notify: (text: string) => warnings.push(text) } }
  scp({ on: (name: string, fn: never) => handlers.set(name, fn), registerTool: () => {}, sendMessage: () => {} } as never)
  return {
    start: () => handlers.get("session_start")!({}, ctx),
    stop: () => handlers.get("session_shutdown")!({}, ctx),
    log: () => readFileSync(log, "utf8").trim().split("\n"),
    warnings,
    restore: () => {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    },
  }
}

test("a new pi session starts its shim only once the previous one exited", async () => {
  const pi = fakePi({})
  try {
    await pi.start()
    await pi.start()
    expect(pi.log()).toEqual(["start", "exit", "start"])
    await pi.stop()
    expect(pi.log()).toEqual(["start", "exit", "start", "exit"])
    expect(pi.warnings).toEqual([])
  } finally {
    pi.restore()
  }
})

test("a shim that could not put the session on the relay is reported", async () => {
  const pi = fakePi({ FAKE_FAIL: "1" })
  try {
    await pi.start()
    expect(pi.warnings).toEqual(["scp: not on the relay: unavailable: no free handle"])
    await pi.stop()
  } finally {
    pi.restore()
  }
})
