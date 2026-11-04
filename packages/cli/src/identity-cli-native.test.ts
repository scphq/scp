import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { swarmBinary } from "./test-setup"

setDefaultTimeout(60_000)

const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|CLAUDE_BG_|OPENCODE|GROK_|MUSE_|ANTIGRAVITY_|CODEX_|SCP_)/
const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const GRANT = `krt_${"ab".repeat(32)}`

const root = mkdtempSync(join(process.env.HOME!, "identity-cli-native-"))
const bin = join(root, "bin")
const project = join(root, "Probe Project")
/** short enough for the socket to sit inside it */
const dir = mkdtempSync("/tmp/scp-probe-")
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

/** this CLI's open() against a broker that records the hello and answers with a bound agent */
const PROBE = `
import { createServer } from "node:net"
import { socketPath } from ${JSON.stringify(join(import.meta.dir, "../../broker/src/index.ts"))}
import { open } from ${JSON.stringify(join(import.meta.dir, "common.ts"))}
const [values, verb] = [JSON.parse(process.argv[2]), process.argv[3]]
let hello
const server = createServer((socket) => {
  let buffer = ""
  socket.on("data", (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
      const message = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      if (message.method === "hello") hello = message.params
      const result = { endpoint: { kind: "agent", address: "me/x" }, broker: { socket: "s", pid: 1, policy: { state: "open", file: "f" } }, grant_bound: true }
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n")
    }
  })
})
await new Promise((done, fail) => server.once("error", fail).listen(socketPath(process.env.SCP_DIR), done))
const opened = await open(verb, values, process.cwd(), false)
const { protocol, capabilities, ...rest } = hello
console.log(JSON.stringify({ hello: rest, harness_pid: opened.harnessPid || null, shell: process.ppid }))
opened.client.close()
server.close()
process.exit(0)
`

/** a harness process: it runs both probes as its children, through `sh -c` when asked, and prints both */
const HARNESS = `
const plan = JSON.parse(process.env.PROBE_PLAN)
const hop = (argv) => (plan.shell ? ["sh", "-c", '"$@"; :', "sh", ...argv] : argv)
const flags = [...(plan.values.as !== undefined ? ["--as", plan.values.as] : []), ...(plan.values.harness !== undefined ? ["--harness", plan.values.harness] : []), ...(plan.values.human ? ["--human"] : [])]
const run = async (argv) => {
  const child = Bun.spawn(hop(argv), { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(argv[0] + " exited " + code + ": " + err)
  return JSON.parse(out)
}
const ts = await run([process.env.PROBE_BUN, "--no-env-file", process.env.PROBE_SCRIPT, JSON.stringify(plan.values), plan.verb])
const native = await run([process.env.PROBE_NATIVE, "__probe", "identity", plan.verb, ...flags])
console.log(JSON.stringify({ ts, native }))
`

type Plan = {
  harness: "claude" | "codex"
  verb?: string
  env?: Record<string, string>
  values?: { as?: string; harness?: string; human?: boolean }
  shell?: boolean
}

async function probes(plan: Plan): Promise<{ ts: Record<string, unknown>; native: Record<string, unknown> }> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) base[key] = value
  const env = {
    ...base,
    SCP_DIR: dir,
    SCP_HARNESS_DETECT: "0",
    ...plan.env,
    PROBE_PLAN: JSON.stringify({ ...plan, verb: plan.verb ?? "whoami", values: plan.values ?? {} }),
    PROBE_BUN: process.execPath,
    PROBE_SCRIPT: join(root, "probe.ts"),
    PROBE_NATIVE: swarmBinary!,
  }
  const child = Bun.spawn([join(bin, plan.harness), join(root, "harness.js")], { env, cwd: project, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`the fake harness failed (${code}): ${err}`)
  return JSON.parse(out)
}

/** the native plan sends the hello this CLI's open() sends, from the same shell and harness */
async function same(plan: Plan): Promise<Record<string, unknown>> {
  const { ts, native } = await probes(plan)
  const view = (probe: Record<string, unknown>) => (plan.shell ? hopless(probe) : { hello: probe.hello, harness_pid: probe.harness_pid, shell: probe.shell })
  expect(view(native)).toEqual(view(ts))
  return ts.hello as Record<string, unknown>
}

/** a probe without the `sh -c` each one ran in, its own process: the shell, and the first key of each walk */
function hopless(probe: Record<string, unknown>): Record<string, unknown> {
  const hello = structuredClone(probe.hello) as Record<string, unknown> & { claim?: Record<string, unknown> }
  for (const holder of [hello, hello.claim ?? {}]) for (const key of ["lineage", "self"]) if (Array.isArray(holder[key])) holder[key] = holder[key].slice(1)
  return { hello, harness_pid: probe.harness_pid }
}

describe.skipIf(!swarmBinary)("native open() against this CLI's", () => {
  beforeAll(() => {
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(project, ".git"), { recursive: true })
    mkdirSync(join(dir, "sessions"), { recursive: true, mode: 0o700 })
    for (const name of ["claude", "codex"]) symlinkSync(process.execPath, join(bin, name))
    writeFileSync(join(root, "probe.ts"), PROBE)
    writeFileSync(join(root, "harness.js"), HARNESS)
    const marker = createHash("sha256").update("env:joined-session").digest("hex").slice(0, 32)
    writeFileSync(join(dir, "sessions", `${marker}.json`), JSON.stringify({ joined: true, handle: "joined-h" }), { mode: 0o600 })
  })

  test("an --as claim, directly and through a shell", async () => {
    const env = { CLAUDECODE: "1", SCP_PARENT: "me/boss", SCP_UNDER: "me/boss", SCP_LABELS: "team=x" }
    const direct = await same({ harness: "claude", env, values: { as: "me/lane", harness: "claude" } })
    expect(direct.claim).toMatchObject({ handle: "lane", exact: true, harness: "claude", parent: "me/boss", under: "me/boss" })
    await same({ harness: "claude", env, values: { as: "lane" }, shell: true })
  })

  test("lineage observe, human, grant and the joined handle", async () => {
    const observed = await same({ harness: "claude", env: { CLAUDECODE: "1", SCP_HARNESS_DETECT: "1" } })
    expect(observed.observe).toBe(true)
    expect((await same({ harness: "claude", env: { CLAUDECODE: "1" }, values: { human: true } })).human).toBe(true)
    expect((await same({ harness: "claude", env: { CLAUDECODE: "1", SCP_GRANT: GRANT } })).grant).toBe(GRANT)
    const joined = await same({ harness: "claude", env: { CLAUDECODE: "1", SCP_HARNESS_DETECT: "1", SCP_NAME: "lane", SCP_SESSION: "joined-session" } })
    expect(joined.claim).toMatchObject({ handle: "joined-h" })
  })

  test("a codex shell's thread and an inferred harness", async () => {
    const env = { CODEX_THREAD_ID: THREAD, SCP_HARNESS_DETECT: "1" }
    const hello = await same({ harness: "codex", env, values: { as: "cx" }, shell: true })
    expect(hello.claim).toMatchObject({ harness_session: THREAD })
    await same({ harness: "codex", env, verb: "list" })
  })
})
