import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { type Broker, startBroker } from "@scp-dev/broker"

setDefaultTimeout(30_000)

const entry = join(import.meta.dir, "cli.ts")
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|OPENCODE|GROK_|MUSE_|CODEX_THREAD_ID|SCP_)/
const root = mkdtempSync(join(process.env.HOME!, "bg-grant-"))
const dir = join(root, "relay")
const project = join(root, "bg-app")
let broker: Broker

beforeAll(async () => {
  mkdirSync(join(project, ".git"), { recursive: true })
  broker = await startBroker({ dir, idleMs: 0, policyPath: join(root, "policy.json"), log: () => {} })
})
afterAll(async () => {
  await broker.stop()
  rmSync(root, { recursive: true, force: true })
})

function env(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) out[key] = value
  return { ...out, SCP_DIR: dir, SCP_SESSION: "claude-bg", CLAUDECODE: "1", ...extra }
}

/** runs the MCP shim as the session's tool surface and returns its relay_whoami reply */
async function shim(extra: Record<string, string>): Promise<string> {
  const child = Bun.spawn([process.execPath, "--no-env-file", entry, "mcp", "--harness", "claude"], {
    cwd: project,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: env(extra),
  })
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } })
  send({ method: "notifications/initialized" })
  send({ id: 2, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })
  let out = ""
  const decoder = new TextDecoder()
  for await (const chunk of child.stdout) {
    out += decoder.decode(chunk)
    if (out.includes('"id":2')) break
  }
  child.stdin.end()
  child.kill()
  await child.exited
  return out
}

test("a background session's shim places the endpoint its hooks claimed first, without the grant, under the spawner", async () => {
  const spawner = broker.core.claim({ handle: "spawner", harness: "codex" }).endpoint
  const { token } = broker.core.grant({ kind: "endpoint", id: spawner.id, auth: "session" }, { name: "worker" })
  const hook = Bun.spawn([process.execPath, "--no-env-file", entry, "hook", "claude"], {
    cwd: project,
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "bg", cwd: project })),
    stdout: "ignore",
    stderr: "ignore",
    env: env({}),
  })
  expect(await hook.exited).toBe(0)
  const hooked = broker.core.list({ all: true }).find((e) => e.address === "me/claude-bg-app")
  expect(hooked?.parent).toBeNull()
  expect(await shim({ SCP_NAME: "worker", SCP_GRANT: token })).toContain("me/worker")
  expect(broker.core.list({ all: true }).find((e) => e.id === hooked!.id)).toMatchObject({ address: "me/worker", parent: "me/spawner" })
})
