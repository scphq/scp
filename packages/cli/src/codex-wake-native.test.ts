import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { startBroker } from "@scp-dev/broker"
import { codexLockPath } from "./codex-queue"
import { swarmBinary } from "./test-setup"

const THREAD = "01a1602d-b655-70a1-b717-0af8f5083d80"
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** a stand-in for lsof, fuser, codex and open: it records its call and the wake variables it got, and answers as FAKE_* say */
const FAKE = `
import { appendFileSync } from "node:fs"
const [bin, ...args] = process.argv.slice(2)
const wake = Object.keys(process.env).filter((key) => key.startsWith("SCP_WAKE_"))
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin, args, wake }) + "\\n")
if (bin === "lsof") {
  if (process.env.FAKE_HOLDER) console.log(process.env.FAKE_HOLDER)
  process.exit(process.env.FAKE_HOLDER ? 0 : 1)
}
if (bin === "codex" && process.env.FAKE_QUEUE === "no-rollout") {
  console.error("Error: no rollout found for thread id ${THREAD}")
  process.exit(1)
}
if (bin === "codex" && process.env.FAKE_QUEUE === "fail") {
  console.error("Error: daemon unavailable")
  process.exit(1)
}
`

type Call = { bin: string; args: string[]; wake: string[] }

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "codex-wake-native-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, "bin")
  mkdirSync(bin)
  writeFileSync(join(root, "fake.mjs"), FAKE)
  for (const name of ["lsof", "fuser", "codex", "open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(join(root, "fake.mjs"))} ${name} "$@"\n`)
    chmodSync(join(bin, name), 0o755)
  }
  const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0 })
  cleanups.push(() => broker.stop())
  const lane = broker.core.claim({ handle: "lane", harness: "codex", session: "s1", process: "pid:4242" }, { transient: true }).endpoint
  broker.core.event(lane.id, { kind: "stop", session_id: THREAD }, { transient: true, process: "pid:4242" })
  broker.core.setWake(lane.id, "codex-queue", { transient: true, process: "pid:4242" })
  const peer = broker.core.claim({ handle: "peer", harness: "test" }).endpoint
  const log = join(root, "calls.jsonl")
  const env: Record<string, string> = {
    HOME: root,
    PATH: "/usr/bin:/bin",
    SCP_DIR: join(root, "state"),
    CODEX_HOME: join(root, "codex"),
    SCP_LSOF_BIN: join(bin, "lsof"),
    SCP_FUSER_BIN: join(bin, "fuser"),
    SCP_CODEX_BIN: join(bin, "codex"),
    SCP_OPEN_BIN: join(bin, "open"),
    FAKE_LOG: log,
    ...(process.env.SCP_ROUTE_LOG ? { SCP_ROUTE_LOG: process.env.SCP_ROUTE_LOG } : {}),
  }
  const calls = (): Call[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Call)
      : []
  const lock = () => {
    const path = codexLockPath(THREAD, env)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, "")
  }
  /** a process the table shows running `args` from a program named codex */
  const holder = (...args: string[]) => {
    const dir = mkdtempSync(join(root, "holder-"))
    writeFileSync(join(dir, "codex"), "#!/bin/sh\nsleep 30\n:\n")
    chmodSync(join(dir, "codex"), 0o755)
    const child = spawn(join(dir, "codex"), args, { stdio: "ignore" })
    cleanups.push(() => void child.kill("SIGKILL"))
    return child.pid!
  }
  /** one wake run of the native swarm as the broker's codex-queue waker */
  const wake = async (extra: Record<string, string> = {}, ref: string = THREAD, ticket = true) => {
    const job = broker.core.wakeDue(lane.id, Date.now())
    expect(job?.provider).toBe("codex-queue")
    writeFileSync(log, "")
    const child = Bun.spawn([resolve(swarmBinary!), "codex-wake"], {
      env: { ...env, ...extra, ...(ticket ? { SCP_WAKE_TICKET: job!.ticket! } : {}) },
      stdin: new TextEncoder().encode(JSON.stringify({ endpoint: "me/lane", ref })),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    broker.core.wakeResult(lane.id, {
      ok: code === 0,
      code,
      ms: 1,
      message: job!.message.id,
      ...(code === 77 ? { declined: JSON.parse(stdout).declined } : {}),
    })
    return { code, stdout, stderr, calls: calls() }
  }
  return { broker, lane, peer, wake, lock, holder }
}

describe.skipIf(!swarmBinary)("codex-wake: the native swarm", () => {
  test("queues the framed messages with argv kept verbatim, confirms them read and opens the thread nobody holds", async () => {
    const { broker, lane, peer, wake } = await setup()
    const body = `$(touch /tmp/pwned); \`id\` | rm -rf ~ && echo "x" > /etc/y; --message=evil\nnext line`
    broker.core.send(peer.id, { to: "lane", body })
    const run = await wake()
    expect([run.code, run.stdout, run.stderr]).toEqual([0, "", ""])
    const queue = run.calls.find((call) => call.bin === "codex")!
    expect(queue.args.slice(0, 2)).toEqual(["queue", `--thread=${THREAD}`])
    expect(queue.args).toHaveLength(3)
    expect(queue.args[2]).toStartWith("--message=")
    expect(queue.args[2]).toContain(body)
    expect(queue.args[2]).toContain('<relay-message from="me/peer"')
    expect(run.calls.at(-1)).toMatchObject({ bin: "open", args: ["-g", `codex://threads/wake/${THREAD}`] })
    expect(run.calls.every((call) => call.wake.length === 0)).toBe(true)
    expect(broker.core.hasUnread(lane.id)).toBe(false)
  })

  test("a running exec keeps the messages; a codex session drains them without an open; the desktop app's opens", async () => {
    const { broker, lane, peer, wake, lock, holder } = await setup()
    lock()
    broker.core.send(peer.id, { to: "lane", body: "while exec runs" })
    const exec = await wake({ FAKE_HOLDER: String(holder("exec", "hi")) })
    expect([exec.code, exec.calls.map((call) => call.bin)]).toEqual([0, ["lsof"]])
    expect(broker.core.hasUnread(lane.id)).toBe(true)
    const tui = await wake({ FAKE_HOLDER: String(holder("resume", THREAD)) })
    expect([tui.code, tui.calls.map((call) => call.bin)]).toEqual([0, ["lsof", "codex", "lsof"]])
    expect(broker.core.hasUnread(lane.id)).toBe(false)
    broker.core.send(peer.id, { to: "lane", body: "again" })
    const none = await wake()
    expect(none.calls.map((call) => call.bin)).toEqual(["lsof", "codex", "lsof", "open"])
  })

  test("a thread with no rollout declines quietly and keeps the message; a failed queue says why", async () => {
    const { broker, lane, peer, wake } = await setup()
    broker.core.send(peer.id, { to: "lane", body: "too early" })
    const early = await wake({ FAKE_QUEUE: "no-rollout" })
    expect([early.code, early.stdout, early.stderr]).toEqual([77, `${JSON.stringify({ declined: "no-rollout" })}\n`, ""])
    expect(early.calls.some((call) => call.bin === "open")).toBe(false)
    expect(broker.core.hasUnread(lane.id)).toBe(true)
    for (const [extra, stderr] of [
      [{ FAKE_QUEUE: "fail" }, "swarm codex-wake: codex queue failed: Error: daemon unavailable\n"],
      [{ SCP_CODEX_BIN: "/nowhere/codex" }, "swarm codex-wake: codex queue is not installed\n"],
    ] as const) {
      const again = await setup()
      again.broker.core.send(again.peer.id, { to: "lane", body: "hi" })
      const failed = await again.wake(extra)
      expect([failed.code, failed.stdout, failed.stderr]).toEqual([1, "", stderr])
      expect(again.broker.core.hasUnread(again.lane.id)).toBe(true)
    }
  })

  test("a bad ref declines before anything runs, and a run without a ticket says so", async () => {
    const { broker, lane, peer, wake } = await setup()
    broker.core.send(peer.id, { to: "lane", body: "hi" })
    const bad = await wake({}, `${THREAD}; open -a Calculator`)
    expect([bad.code, bad.stdout, bad.calls]).toEqual([77, `${JSON.stringify({ declined: "unresumable" })}\n`, []])
    broker.core.setWake(lane.id, "codex-queue", { transient: true, process: "pid:4242" })
    const bare = await wake({}, THREAD, false)
    expect([bare.code, bare.stdout, bare.stderr, bare.calls]).toEqual([
      1,
      "",
      "swarm codex-wake: no wake ticket: this broker cannot hand the messages over\n",
      [],
    ])
  })

  test("large messages go in several codex queue messages, each confirmed once queued", async () => {
    const { broker, lane, peer, wake } = await setup()
    for (const fill of ["a", "b"]) broker.core.send(peer.id, { to: "lane", body: fill.repeat(60_000) })
    const run = await wake()
    expect(run.code).toBe(0)
    const queued = run.calls.filter((call) => call.bin === "codex")
    expect(queued).toHaveLength(2)
    for (const call of queued) expect(Buffer.byteLength(call.args[2]!)).toBeLessThan(96 * 1024)
    expect(broker.core.hasUnread(lane.id)).toBe(false)
  })
})
