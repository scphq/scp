import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

setDefaultTimeout(60_000)

/** the native MCP server, when the run names one: its identity must equal this CLI's for the same process tree and environment */
const nativeBin = process.env.SCP_NATIVE === "1" ? process.env.SCP_MCP_BIN : undefined
const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|CLAUDE_BG_|OPENCODE|GROK_|MUSE_|ANTIGRAVITY_|CODEX_|SCP_)/
const THREAD = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
const SESSION = "11111111-2222-4333-8444-555555555555"

const root = mkdtempSync(join(process.env.HOME!, "identity-native-"))
const bin = join(root, "bin")
const project = join(root, "Native Project")
const dir = join(root, "relay")
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** what the probe under the fake harness resolves: this CLI's claim from the shim's own input */
const PROBE = `
import { shimIdentityInput } from ${JSON.stringify(join(import.meta.dir, "mcp.ts"))}
import { relayIdentity } from ${JSON.stringify(join(import.meta.dir, "identity.ts"))}
console.log(JSON.stringify(relayIdentity(shimIdentityInput(JSON.parse(process.argv[2])))))
`

/** a harness process: it runs both probes as its children (through \`sh -c\` when asked) and prints both claims */
const HARNESS = `
const plan = JSON.parse(process.env.PROBE_PLAN)
if (plan.muse) {
  const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], { env: { PATH: process.env.PATH, LC_ALL: "C" } })
  const key = "pid:" + process.pid + ":" + ps.stdout.toString().trim().replace(/\\s+/g, "-")
  const { mkdirSync, writeFileSync } = await import("node:fs")
  mkdirSync(process.env.SCP_DIR + "/launch", { recursive: true, mode: 0o700 })
  writeFileSync(process.env.SCP_DIR + "/launch/muse-" + process.pid + ".json", JSON.stringify({ process: key, ...plan.muse }), { mode: 0o600 })
}
const hop = (argv) => (plan.shell ? ["sh", "-c", '"$@"; :', "sh", ...argv] : argv)
const flags = [...(plan.values.as !== undefined ? ["--as", plan.values.as] : []), ...(plan.values.harness !== undefined ? ["--harness", plan.values.harness] : [])]
const run = async (argv, env) => {
  const child = Bun.spawn(hop(argv), { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(argv[0] + " exited " + code + ": " + err)
  return JSON.parse(out)
}
const ts = await run([process.env.PROBE_BUN, "--no-env-file", process.env.PROBE_SCRIPT, JSON.stringify(plan.values)], process.env)
const native = await run([process.env.PROBE_NATIVE, ...flags], { ...process.env, SCP_MCP_IDENTITY: "1" })
console.log(JSON.stringify({ ts, native }))
`

/** starts the harness, from a launcher that names itself in SCP_HARNESS_PID when asked */
const LAUNCHER = `
const plan = JSON.parse(process.env.PROBE_PLAN)
const env = { ...process.env, ...(plan.launcher ? { SCP_HARNESS_PID: String(process.pid) } : {}) }
const child = Bun.spawn([process.env.PROBE_HARNESS_BIN, ...plan.argv], { env, cwd: process.env.PROBE_CWD, stdout: "pipe", stderr: "inherit" })
process.stdout.write(await new Response(child.stdout).text())
process.exit(await child.exited)
`

type Plan = {
  harness: "claude" | "codex" | "muse"
  args?: string[]
  appServer?: boolean
  env?: Record<string, string>
  values?: { as?: string; harness?: string }
  shell?: boolean
  launcher?: boolean
  muse?: Record<string, string>
}

function setup(): void {
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const name of ["claude", "codex", "muse"]) symlinkSync(process.execPath, join(bin, name))
  writeFileSync(join(root, "probe.ts"), PROBE)
  writeFileSync(join(root, "harness.js"), HARNESS)
  writeFileSync(join(project, "app-server"), HARNESS)
  writeFileSync(join(root, "launcher.js"), LAUNCHER)
}

async function claims(plan: Plan): Promise<{ ts: Record<string, unknown>; native: Record<string, unknown> }> {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !MARKERS.test(key)) base[key] = value
  const argv = plan.appServer ? ["app-server"] : [join(root, "harness.js"), ...(plan.args ?? [])]
  const env = {
    ...base,
    SCP_DIR: dir,
    SCP_HARNESS_DETECT: "0",
    ...plan.env,
    PROBE_PLAN: JSON.stringify({ ...plan, values: plan.values ?? {}, argv }),
    PROBE_BUN: process.execPath,
    PROBE_SCRIPT: join(root, "probe.ts"),
    PROBE_NATIVE: nativeBin!,
    PROBE_HARNESS_BIN: join(bin, plan.harness),
    PROBE_CWD: project,
  }
  const child = Bun.spawn([process.execPath, "--no-env-file", join(root, "launcher.js")], { env, cwd: project, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`the fake harness failed (${code}): ${err}`)
  return JSON.parse(out)
}

/** the native claim equals this CLI's; a `derived` key this CLI does not write yet is checked on its own */
async function same(plan: Plan, derived: boolean): Promise<Record<string, unknown>> {
  const { ts, native } = await claims(plan)
  if (!("derived" in ts)) {
    expect(native.derived === true).toBe(derived)
    delete native.derived
  }
  expect(native).toEqual(ts)
  return ts
}

describe.skipIf(!nativeBin)("native shim identity", () => {
  beforeAll(setup)

  test("a Claude Code session, directly and through a shell", async () => {
    const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SESSION }
    const direct = await same({ harness: "claude", env }, true)
    expect(direct).toMatchObject({ handle: "claude-native-project", harness: "claude-code", harness_session: SESSION })
    const hopped = await same({ harness: "claude", env, shell: true, values: { harness: "claude" } }, true)
    expect(hopped.handle).toBe(direct.handle)
  })

  test("a forked session and a background hand-off", async () => {
    const claim = await same(
      {
        harness: "claude",
        args: ["--fork-session", "--resume", "/x/aaaa-bbbb.jsonl"],
        env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CODE_SESSION_KIND: "bg", CLAUDE_BG_SOURCE: "slash" },
      },
      true,
    )
    expect(claim).toMatchObject({ harness_origin: "aaaa-bbbb", harness_handoff: true })
  })

  test("names, grants and labels from the environment", async () => {
    const env = {
      CLAUDECODE: "1",
      SCP_NAME: "lane-a",
      SCP_UNDER: "me/boss",
      SCP_GRANT: "krt_grant",
      SCP_SESSION: "sess-9",
      SCP_PARENT: "me/p",
      SCP_LABELS: "team=x, machine=box ,Bad=1",
    }
    expect(await same({ harness: "claude", env }, false)).toMatchObject({ handle: "lane-a", session: "env:sess-9", labels: { team: "x", machine: "box" } })
  })

  test("codex threads, --as and an app server's thread", async () => {
    expect(await same({ harness: "codex", env: { CODEX_THREAD_ID: THREAD } }, true)).toMatchObject({ harness: "codex", harness_session: THREAD })
    expect(await same({ harness: "codex", env: { CODEX_THREAD_ID: THREAD }, values: { as: "flagged", harness: "codex" } }, false)).toMatchObject({
      handle: "flagged",
    })
    const hosted = await same(
      { harness: "codex", appServer: true, env: { SCP_HARNESS_DETECT: "1", SCP_CODEX_THREAD: THREAD }, values: { harness: "codex" } },
      true,
    )
    expect(hosted.session).toBe(`codex:${THREAD}`)
  })

  test("a muse process its launcher left a name and session for", async () => {
    const claim = await same({ harness: "muse", env: { MUSE_SESSION_ID: "m1" }, muse: { name: "muse-named", session: "muse-sess", grant: "g1" } }, false)
    expect(claim).toMatchObject({ handle: "muse-named", harness: "muse", session: "env:muse-sess", grant: "g1" })
  })

  test("a launcher in SCP_HARNESS_PID holds the endpoint", async () => {
    const claim = await same({ harness: "claude", launcher: true, env: { CLAUDECODE: "1" } }, true)
    expect(claim.process).not.toBe((await claims({ harness: "claude", env: { CLAUDECODE: "1" } })).ts.process)
  })

  test("harness inference follows SCP_HARNESS_DETECT", async () => {
    expect((await same({ harness: "claude", env: { SCP_HARNESS_DETECT: "1" } }, true)).harness).toBe("claude-code")
    expect((await same({ harness: "claude", env: { SCP_HARNESS_DETECT: "0" } }, true)).harness).toBe("mcp")
  })

  test("Cowork and desktop sessions", async () => {
    const cowork = { CLAUDE_CODE_IS_COWORK: "1", CLAUDE_CODE_WORKSPACE_HOST_PATHS: '["/x/My Folder/"]', CLAUDE_CODE_SESSION_ID: SESSION }
    expect(await same({ harness: "claude", env: cowork }, true)).toMatchObject({ handle: "cowork-my-folder", harness: "claude-cowork" })
    const desktop = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }
    expect((await same({ harness: "claude", env: desktop }, true)).harness).toBe("claude-desktop")
  })
})
