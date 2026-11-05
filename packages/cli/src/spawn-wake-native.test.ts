import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { swarmBinary } from "./test-setup"

const root = mkdtempSync(join(tmpdir(), "spawn-wake-native-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const work = join(root, "work")
mkdirSync(work)
const SESSION = "0199f3c2-7a1b-7c3d-9e8f-0123456789ab"
const ref = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ harness: "codex", session: SESSION, cwd: work, argv: ["/bin/codex", "exec", "resume", SESSION], idle_s: 600, parent: "me/lead", ...over })

/** `swarm spawn-wake` on the TypeScript CLI or the native swarm, with `request` on stdin */
async function wake(engine: "ts" | "native", request: object | string, env: Record<string, string> = {}) {
  const argv = engine === "native" ? [resolve(swarmBinary!), "spawn-wake"] : [process.execPath, "--no-env-file", join(import.meta.dir, "cli.ts"), "spawn-wake"]
  const child = Bun.spawn(argv, {
    env: {
      HOME: root,
      PATH: "/usr/bin:/bin",
      SCP_DIR: join(root, "state"),
      ...(engine === "native" && process.env.SCP_ROUTE_LOG ? { SCP_ROUTE_LOG: process.env.SCP_ROUTE_LOG } : {}),
      ...env,
    },
    cwd: root,
    stdin: new TextEncoder().encode(typeof request === "string" ? request : JSON.stringify(request)),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, stdout, stderr }
}

const CASES: { name: string; request: object | string; env?: Record<string, string> }[] = [
  { name: "a request that is not JSON", request: "not json" },
  { name: "a ref of another harness", request: { handle: "w", endpoint: "me/w", ref: ref({ harness: "agy" }) } },
  {
    name: "a ref with no idle and the variables' handle",
    request: { ref: ref({ idle_s: null }) },
    env: { SCP_WAKE_HANDLE: "Bad Handle", SCP_WAKE_ENDPOINT: "me/w" },
  },
  { name: "a ref whose directory is gone", request: { handle: "w", endpoint: "me/w", ref: ref({ cwd: join(root, "gone") }) } },
  { name: "a ref from the variables, with no endpoint", request: {}, env: { SCP_WAKE_REF: ref(), SCP_WAKE_HANDLE: "w" } },
  { name: "a run without a wake ticket", request: { handle: "w", endpoint: "me/w", ref: ref() } },
  { name: "a ref from the variables, with no wake ticket", request: { handle: "w", endpoint: "me/w" }, env: { SCP_WAKE_REF: ref({ idle_s: 1800.5 }) } },
]

describe.skipIf(!swarmBinary)("spawn-wake: the native swarm against this CLI", () => {
  for (const { name, request, env } of CASES)
    test(name, async () => {
      const ts = await wake("ts", request, env)
      expect(await wake("native", request, env)).toEqual(ts)
    })

  test("a runner that cannot take the endpoint back says why once it gave up", async () => {
    const env = { SCP_WAKE_TICKET: "kwt_x" }
    const request = { handle: "w", endpoint: "me/w", ref: ref() }
    const [ts, native] = await Promise.all([wake("ts", request, env), wake("native", request, env)])
    expect(native).toEqual(ts)
    expect(native.code).toBe(1)
    expect(native.stderr).toStartWith("swarm spawn-wake: swarm spawn: w cannot be held for a resume: ")
  }, 30_000)
})
