import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { alive, waitFor } from "./testing/fixtures"

const packages = join(import.meta.dir, "..", "..")
const node = Bun.which("node")
const [major = 0, minor = 0] = node ? spawnSync(node, ["-p", "process.versions.node"], { encoding: "utf8" }).stdout.trim().split(".").map(Number) : []
const supported = major > 22 || (major === 22 && minor >= 13)
const BUILT = ["core", "hub", "broker", "mcp", "cli"]

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function newest(dir: string): number {
  return Math.max(
    0,
    ...readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => statSync(join(dir, file)).mtimeMs),
  )
}

/** builds the CLI and the packages it runs on when a dist is missing or older than its sources */
function ensureBuilt() {
  const entry = (name: string) => join(packages, name, "dist", name === "cli" ? "cli.js" : "index.js")
  const stale = BUILT.some((name) => (statSync(entry(name), { throwIfNoEntry: false })?.mtimeMs ?? 0) < newest(join(packages, name, "src")))
  if (!stale) return
  const result = spawnSync("bun", ["run", ...BUILT.flatMap((name) => ["--filter", `@scp-dev/${name}`]), "build"], { cwd: packages, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`the packages did not build: ${result.stdout}${result.stderr}`)
}

test.skipIf(!supported)(
  "the built swarm runs under plain Node 22.13+: it starts the broker and delivers a message (skipped without node >= 22.13 on PATH)",
  async () => {
    ensureBuilt()
    const root = mkdtempSync(join(tmpdir(), "swarm-node-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const env = { ...process.env, SCP_DIR: join(root, "state"), SCP_IDLE: "1s" }
    const swarm = (...args: string[]) => {
      const result = spawnSync(node!, [join(packages, "cli", "dist", "cli.js"), ...args], { env, encoding: "utf8", timeout: 60_000 })
      expect(result.status, result.stderr).toBe(0)
      return result
    }
    expect(swarm("whoami", "--as", "peer").stdout).toStartWith("me/peer (agent, cli)")
    swarm("send", "--as", "smoke", "peer", "ping")
    const inbox = JSON.parse(swarm("inbox", "--as", "peer", "--json").stdout) as { messages: { body: { text: string } }[] }
    expect(inbox.messages.map((m) => m.body.text)).toEqual(["ping"])
    const pid = Number(readFileSync(join(root, "state", "broker.lock"), "utf8").split(":")[0])
    await waitFor(() => !alive(pid), 15_000, "the idle broker to exit")
    expect(readFileSync(join(root, "state", "broker.log"), "utf8")).not.toContain("ExperimentalWarning")
  },
  180_000,
)

test.skipIf(!supported)(
  "under Node, a shell whose stdout is a socket, as Node hands a child, keeps writing to it after a swarm command exits",
  () => {
    ensureBuilt()
    const root = mkdtempSync(join(tmpdir(), "swarm-node-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const env = { ...process.env, SCP_DIR: join(root, "state"), SCP_IDLE: "1s", SWARM_CLI: join(packages, "cli", "dist", "cli.js") }
    const parent = `
      const { spawn } = require("node:child_process")
      const child = spawn("sh", ["-c", '"$0" "$SWARM_CLI" whoami --as peer; echo after', process.execPath], { stdio: ["ignore", "pipe", "inherit"] })
      let out = ""
      child.stdout.on("data", (chunk) => (out += chunk))
      child.on("close", (code) => console.log(JSON.stringify({ code, out })))
    `
    const result = spawnSync(node!, ["-e", parent], { env, encoding: "utf8", timeout: 60_000 })
    const { code, out } = JSON.parse(result.stdout) as { code: number; out: string }
    expect([code, out]).toEqual([0, expect.stringMatching(/^me\/peer \(agent, cli\)[\s\S]*\nafter\n$/)])
  },
  180_000,
)
