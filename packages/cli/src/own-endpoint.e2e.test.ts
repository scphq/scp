import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker"
import { routedHooks } from "./hook-test"
import { readPsTable, spawnerKey } from "./identity"
import { alive, waitFor } from "./testing/fixtures"

setDefaultTimeout(60_000)

const MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_|CLAUDE_BG_|OPENCODE|GROK_|MUSE_|ANTIGRAVITY_|CODEX_)/
const SELF = [process.execPath, "--no-env-file", join(import.meta.dir, "cli.ts")]
const quoted = (words: string[]) => words.map((word) => `'${word}'`).join(" ")

/** a daemon-hosted background session: a process named claude that no terminal or launcher started, whose tool shells are its children */
const SPARE = `
for await (const line of console) {
  const child = Bun.spawn(["sh", "-c", line], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  console.log(JSON.stringify({ out, err, code }))
}
`

const root = mkdtempSync("/tmp/scp-own-")
const bin = join(root, "bin")
let broker: Broker
const spares: Bun.Subprocess<"pipe", "pipe", "inherit">[] = []

beforeAll(async () => {
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, "claude"))
  writeFileSync(join(root, "spare.ts"), SPARE)
  broker = await startBroker({ dir: join(root, "state"), idleMs: 0, policyPath: join(root, "policy.json"), log: () => {}, ...routedHooks(join(root, "state")) })
})
afterAll(async () => {
  for (const spare of spares) spare.kill("SIGKILL")
  await broker.stop()
  rmSync(root, { recursive: true, force: true })
})

function env(extra: Record<string, string> = {}): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !MARKERS.test(key))) as Record<string, string>
  return { ...base, SCP_DIR: join(root, "state"), ...extra }
}

/** a background session's process, with its key and a way to run a command in a shell of its own */
async function spare(session: string) {
  const child = Bun.spawn([join(bin, "claude"), join(root, "spare.ts"), "--bg-spare", "/tmp/none.claim.sock"], {
    env: env({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: session, CLAUDE_CODE_SESSION_KIND: "bg" }),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  })
  spares.push(child)
  const reader = child.stdout.getReader()
  const key = await waitFor(() => spawnerKey(child.pid, readPsTable()), 5000, "the session's process key")
  let pending = ""
  const shell = async (line: string): Promise<{ out: string; err: string; code: number }> => {
    child.stdin.write(`${line}\n`)
    child.stdin.flush()
    for (;;) {
      const at = pending.indexOf("\n")
      if (at >= 0) {
        const reply = pending.slice(0, at)
        pending = pending.slice(at + 1)
        return JSON.parse(reply)
      }
      const { value, done } = await reader.read()
      if (done) throw new Error("the session's process ended")
      pending += new TextDecoder().decode(value)
    }
  }
  return { key, shell, pid: child.pid, stop: () => child.kill("SIGKILL") }
}

const connect = (): Promise<RelayClient> => RelayClient.connect(broker.socket)

const claim = (key: string, extra: Record<string, unknown>) => ({
  harness: "claude-code",
  cwd: root,
  process: key,
  session: key,
  lineage: [key],
  ...extra,
})

/** session `session`'s real hook, run from its own shell with the daemon's environment: `swarm hook claude-code` on an event of `harnessSession` */
async function hook(session: Awaited<ReturnType<typeof spare>>, name: string, harnessSession: string) {
  const payload = JSON.stringify({ hook_event_name: name, session_id: harnessSession, cwd: root, tool_name: "Bash" })
  return session.shell(`echo '${payload}' | CLAUDE_PID=$PPID ${quoted(SELF)} hook claude-code`)
}

/** `name`, a worker of `lead` run in a background session that ended, resumed in a process of its own under a new id: its hooks run first */
async function resumed(name: string, first: string, next: string) {
  const lead = await connect()
  const parent = await lead.hello({ claim: { handle: `${name}-lead`, harness: "claude-code", cwd: root } })
  const { token } = await lead.request<{ token: string }>("grant", { name })
  const started = await spare(first)
  const shim = await connect()
  const row = await shim.hello({ claim: claim(started.key, { handle: name, grant: token, harness_session: first }) })
  await hook(started, "PostToolUse", first)
  shim.close()
  started.stop()
  await waitFor(() => !alive(started.pid), 5000, "the old session's process to end")
  const session = await spare(next)
  await hook(session, "SessionStart", next)
  return {
    lead,
    session,
    id: row.endpoint!.id,
    parent: parent.endpoint!.address,
    connectShim: async () => {
      const back = await connect()
      const bound = await back.hello({ claim: claim(session.key, { handle: name, harness_session: next, harness_origin: first }) })
      expect(bound.endpoint).toMatchObject({ id: row.endpoint!.id, parent: parent.endpoint!.address })
      return { back, row: bound.endpoint! }
    },
  }
}

const list = async (client: RelayClient) => (await client.request<{ endpoints: { address: string; parent: string | null }[] }>("list", { all: true })).endpoints

describe("a command in a background session's shell", () => {
  test("acts as the session's named endpoint, and no default row ever appears", async () => {
    const { session, lead, connectShim } = await resumed("lane-a", "s-1", "s-2")
    expect((await list(lead)).filter((view) => view.address.startsWith("me/claude-"))).toEqual([])
    const { row } = await connectShim()
    await hook(session, "PostToolUse", "s-2")
    const { out, code } = await session.shell(`${quoted(SELF)} whoami --json`)
    expect(code).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ address: row.address })
    expect((await list(lead)).filter((view) => view.address.startsWith("me/claude-"))).toEqual([])
  })

  test("spawns a worker under the session's named endpoint, and the worker's result reaches it", async () => {
    const { session, connectShim } = await resumed("lane-b", "s-3", "s-4")
    const { row, back } = await connectShim()
    const worker = `${quoted(SELF)} send ${row.address} finished`
    const { code, err } = await session.shell(`${quoted(SELF)} spawn --fg --name lane-b-sol -- sh -c ${quoted([worker])}`)
    expect({ code, err }).toMatchObject({ code: 0 })
    expect((await list(back)).find((view) => view.address === "me/lane-b-sol")?.parent).toBe(row.address)
    const { messages } = await back.request<{ messages: { body: { text: string } }[] }>("inbox")
    expect(messages.map((message) => message.body.text)).toContain("finished")
  })

  test("before the session's shim connects, refuses a spawn loudly and starts no worker", async () => {
    const { session, lead } = await resumed("lane-c", "s-5", "s-6")
    const { code, err } = await session.shell(`${quoted(SELF)} spawn --fg --name early-sol -- sh -c true`)
    expect(code).not.toBe(0)
    expect(err).toContain("swarm")
    expect((await list(lead)).some((view) => view.address === "me/early-sol")).toBe(false)
  })

  test("before the session's shim connects, a join is refused; after, it joins the session's own endpoint", async () => {
    const { session, lead, connectShim } = await resumed("lane-e", "s-9", "s-10")
    const early = await session.shell(`${quoted(SELF)} join`)
    expect(early.code).not.toBe(0)
    expect(early.err).toContain("no endpoint yet")
    expect((await list(lead)).filter((view) => view.address.startsWith("me/claude-"))).toEqual([])
    const { row } = await connectShim()
    const joined = await session.shell(`${quoted(SELF)} join`)
    expect(joined.code).toBe(0)
    expect(joined.out).toContain(row.address)
  })

  test("detached from the session binds nothing, never another session's row", async () => {
    const { session, connectShim } = await resumed("lane-d", "s-7", "s-8")
    const { row } = await connectShim()
    const out = join(root, "detached.out")
    await session.shell(`(sh -c '${quoted(SELF).replaceAll("'", "")} whoami; echo "exit $?"' > ${out} 2>&1 &) `)
    const text = await waitFor(
      () => {
        const seen = readFileSync(out, { encoding: "utf8", flag: "a+" })
        return /exit \d/.test(seen) ? seen : undefined
      },
      20_000,
      "the detached shell",
    )
    expect(text).not.toContain(row.address)
    expect(text).not.toContain("claude-")
  })
})
