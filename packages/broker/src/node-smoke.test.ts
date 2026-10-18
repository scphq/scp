import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const packages = join(import.meta.dir, "..", "..")
const node = Bun.which("node")
const [major = 0, minor = 0] = node ? spawnSync(node, ["-p", "process.versions.node"], { encoding: "utf8" }).stdout.trim().split(".").map(Number) : []
const supported = major > 22 || (major === 22 && minor >= 13)

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

/** builds core, hub and broker when a dist is missing or older than its sources */
function ensureBuilt() {
  const stale = ["core", "hub", "broker"].some((name) => {
    const built = statSync(join(packages, name, "dist", "index.js"), { throwIfNoEntry: false })
    return !built || built.mtimeMs < newest(join(packages, name, "src"))
  })
  if (!stale) return
  const result = spawnSync("bun", ["run", "--filter", "@scp-dev/core", "--filter", "@scp-dev/hub", "--filter", "@scp-dev/broker", "build"], {
    cwd: packages,
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`the packages did not build: ${result.stdout}${result.stderr}`)
}

const SCRIPT = `
const { startBroker, RelayClient, relayDir } = await import(process.argv[2])
const broker = await startBroker({ dir: relayDir(), idleMs: 0, policyPath: process.argv[3] })
try {
  const client = await RelayClient.connect(broker.socket)
  const hello = await client.hello({ claim: { handle: "smoke", harness: "node" } })
  const other = await RelayClient.connect(broker.socket)
  await other.hello({ claim: { handle: "peer" } })
  const waiting = other.request("inbox", { wait_s: 5 })
  await client.request("send", { to: "peer", body: "ping" })
  const inbox = await waiting
  client.close()
  other.close()
  console.log(JSON.stringify({ address: hello.endpoint.address, pid: hello.broker.pid === process.pid, body: inbox.messages[0].body.text }))
} finally {
  await broker.stop()
}
`

test.skipIf(!supported)(
  "the built broker runs under plain Node 22.13+: a hello and a message over its socket (skipped without node >= 22.13 on PATH)",
  () => {
    ensureBuilt()
    const root = mkdtempSync(join(tmpdir(), "relay-node-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const script = join(root, "smoke.mjs")
    writeFileSync(script, SCRIPT)
    const entry = pathToFileURL(join(packages, "broker", "dist", "index.js")).href
    const result = spawnSync(node!, [script, entry, join(root, "none.json")], {
      env: { ...process.env, SCP_DIR: join(root, "state") },
      encoding: "utf8",
      timeout: 60_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ address: "me/smoke", pid: true, body: "ping" })
  },
  180_000,
)
