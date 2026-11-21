import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout } from "node:timers/promises"

export async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 10_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await setTimeout(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const packages = join(import.meta.dir, "..", "..", "..")
const BUILT = ["core", "hub", "broker", "mcp", "cli"]
const ENTRIES: [string, string][] = [
  ...BUILT.map((name): [string, string] => [join(name, "dist", name === "cli" ? "cli.js" : "index.js"), join(name, "src")]),
  [join("cli", "dist", "pi-extension.js"), join("pi", "src")],
]

function newest(dir: string): number {
  return Math.max(
    0,
    ...readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => statSync(join(dir, file)).mtimeMs),
  )
}

/** what sends a test's `swarm mcp` to the native server when the run names one: test-setup keeps these past its SCP_ clear */
export function nativeMcpEnv(): Record<string, string> {
  const bin = process.env.SCP_MCP_BIN
  return process.env.SCP_NATIVE === "1" && bin ? { SCP_NATIVE: "1", SCP_MCP_BIN: bin } : {}
}

/** held by the test worker that builds; a directory, so taking it is atomic across processes */
const BUILD_LOCK = join(packages, "..", "node_modules", ".cache", "scp-test-build.lock")
/** a lock older than this was left by a run that died mid-build */
const BUILD_LOCK_STALE_MS = 120_000

function stale(): boolean {
  return ENTRIES.some(([entry, src]) => (statSync(join(packages, entry), { throwIfNoEntry: false })?.mtimeMs ?? 0) < newest(join(packages, src)))
}

function lockBuild() {
  mkdirSync(dirname(BUILD_LOCK), { recursive: true })
  for (;;) {
    try {
      mkdirSync(BUILD_LOCK)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const taken = statSync(BUILD_LOCK, { throwIfNoEntry: false })?.mtimeMs
    if (taken !== undefined && Date.now() - taken > BUILD_LOCK_STALE_MS) rmSync(BUILD_LOCK, { recursive: true, force: true })
    else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
}

/**
 * builds the CLI and the packages it runs on when a dist entry is missing or older than its sources. Parallel test workers
 * build once: the others wait for the lock, since a second build would clean dist under the tests already running on it.
 */
export function ensureBuilt() {
  if (!stale() && !existsSync(BUILD_LOCK)) return
  lockBuild()
  try {
    if (!stale()) return
    const result = spawnSync("bun", ["run", ...BUILT.flatMap((name) => ["--filter", `@scp-dev/${name}`]), "build"], { cwd: packages, encoding: "utf8" })
    if (result.status !== 0) throw new Error(`the packages did not build: ${result.stdout}${result.stderr}`)
  } finally {
    rmSync(BUILD_LOCK, { recursive: true, force: true })
  }
}
