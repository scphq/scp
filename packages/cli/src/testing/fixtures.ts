import { spawnSync } from "node:child_process"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
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

/** builds the CLI and the packages it runs on when a dist entry is missing or older than its sources */
export function ensureBuilt() {
  const stale = ENTRIES.some(([entry, src]) => (statSync(join(packages, entry), { throwIfNoEntry: false })?.mtimeMs ?? 0) < newest(join(packages, src)))
  if (!stale) return
  const result = spawnSync("bun", ["run", ...BUILT.flatMap((name) => ["--filter", `@scp-dev/${name}`]), "build"], { cwd: packages, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`the packages did not build: ${result.stdout}${result.stderr}`)
}
