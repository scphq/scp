import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, describe, expect, test } from "bun:test"
import { RelayClient, startBroker } from "@scp-dev/broker"
import { codexLaunch } from "./codex"
import { codexLockPath, codexOwner, codexThread, codexWakeCommand, ownerOf, type Run } from "./codex-queue"
import { runHook, subagentIntro } from "./hooks"
import { type PsCommTable, relayIdentity } from "./identity"

const THREAD = "01a1602d-b655-70a1-b717-0af8f5083d80"
const START = "Fri-Oct-17-09:00:00-2026"
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-queue-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const table = (rows: [number, number, string][]): PsCommTable => new Map(rows.map(([pid, ppid, args]) => [pid, { ppid, start: START, args }]))
const DESKTOP_CLI = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"

type Call = { bin: string; args: string[] }
/** a fake runner: lsof names `holder`, codex queue answers `queue`, everything is recorded */
function fakeRun(options: { holder?: number; lsof?: "missing"; fuser?: "missing"; queue?: "ok" | "no-rollout" | "fail" } = {}): { run: Run; calls: Call[] } {
  const calls: Call[] = []
  const run: Run = async (bin, args) => {
    calls.push({ bin, args })
    if (bin === "lsof" || bin === "fuser") {
      if (options[bin] === "missing") return { code: null, stdout: "", stderr: "", missing: true }
      if (options.holder === undefined) return { code: 1, stdout: "", stderr: "" }
      return { code: 0, stdout: bin === "lsof" ? `${options.holder}\n` : `${args[0]}: ${options.holder}\n`, stderr: "" }
    }
    if (bin === "codex") {
      if (options.queue === "no-rollout") return { code: 1, stdout: "", stderr: `Error: no rollout found for thread id ${THREAD}\n` }
      if (options.queue === "fail") return { code: 1, stdout: "", stderr: "Error: daemon unavailable\n" }
      return { code: 0, stdout: "", stderr: "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { run, calls }
}

function lockFile(env: Record<string, string>): void {
  const path = codexLockPath(THREAD, env)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, "")
}

describe("codex thread ids", () => {
  test("only a UUID is a thread id; anything that could reach a shell, a path or a URL is refused", () => {
    expect(codexThread(THREAD)).toBe(THREAD)
    expect(codexThread("01A1602D-B655-70A1-B717-0AF8F5083D80")).toBeDefined()
    for (const bad of [`${THREAD};rm -rf /`, `${THREAD} x`, `../${THREAD}`, `${THREAD}\n`, "../../etc/passwd", "", "thread", 7, undefined])
      expect(codexThread(bad)).toBeUndefined()
  })
})

describe("codex lock owners", () => {
  test("the holder and its ancestors name the surface", () => {
    const ps = table([
      [10, 9, `${DESKTOP_CLI} -c features.code_mode_host=true app-server --analytics-default-enabled`],
      [9, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      [20, 19, "/opt/codex app-server --listen unix:///tmp/scp-codex-AbC123/app.sock -c mcp_servers.scp.enabled=true"],
      [30, 29, "/home/u/.vscode/extensions/openai.chatgpt-1.0/bin/codex app-server"],
      [29, 1, "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)"],
      [40, 39, "/u/.codex/packages/app-server-daemon/releases/0.163.0/bin/codex app-server --listen unix://"],
      [39, 1, "/u/.codex/packages/app-server-daemon/releases/0.163.0/bin/codex app-server daemon pid-update-loop"],
      [50, 49, "codex exec -C /work -m gpt --sandbox workspace-write fix the app-server"],
      [51, 49, "codex -c model=x e hello"],
      [60, 49, "codex resume 01a1602d-b655-70a1-b717-0af8f5083d80"],
      [61, 49, "codex --model gpt"],
      [62, 49, 'codex -c mcp_servers.scp.env_vars=["SCP_GRANT", "SCP_NAME"] -C /a/b exec fix it'],
      [63, 49, `${DESKTOP_CLI} exec hi`],
      [64, 49, "/usr/bin/vim notes"],
      [66, 49, "codex fix exec crash"],
      [65, 10, "/bin/zsh -lc make"],
      [49, 1, "-zsh"],
    ])
    expect(ownerOf(10, ps)).toBe("desktop")
    expect(ownerOf(20, ps)).toBe("scp")
    expect(ownerOf(30, ps)).toBe("ide")
    expect(ownerOf(40, ps)).toBe("app-server")
    expect(ownerOf(50, ps)).toBe("exec")
    expect(ownerOf(51, ps)).toBe("exec")
    expect(ownerOf(60, ps)).toBe("tui")
    expect(ownerOf(61, ps)).toBe("tui")
    expect(ownerOf(62, ps)).toBe("exec")
    expect(ownerOf(63, ps)).toBe("exec")
    expect(ownerOf(64, ps)).toBe("other")
    expect(ownerOf(66, ps)).toBe("tui")
    expect(ownerOf(99, ps)).toBe("unknown")
    expect(ownerOf(10, undefined)).toBe("unknown")
  })

  test("several holders: children sharing the lock's descriptor count as their parent, and an exec wins", async () => {
    const env = { CODEX_HOME: join(temp(), "codex") }
    lockFile(env)
    const ps = () =>
      table([
        [10, 9, `${DESKTOP_CLI} app-server`],
        [9, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
        [11, 10, "/bin/zsh -lc make"],
        [50, 1, "codex exec hi"],
      ])
    const several =
      (pids: number[]): Run =>
      async (bin) =>
        bin === "lsof" ? { code: 0, stdout: pids.map((pid) => `${pid}\n`).join(""), stderr: "" } : { code: 0, stdout: "", stderr: "" }
    expect(await codexOwner(THREAD, env, { run: several([11, 10]), table: ps })).toBe("desktop")
    expect(await codexOwner(THREAD, env, { run: several([10, 50]), table: ps })).toBe("exec")
  })

  test("no lock file is nobody; lsof names the holder, else fuser, else the holder stays unknown", async () => {
    const env = { CODEX_HOME: join(temp(), "codex") }
    const ps = () => table([[10, 9, `${DESKTOP_CLI} app-server`]])
    const none = fakeRun({ holder: 10 })
    expect(await codexOwner(THREAD, env, { run: none.run, table: ps })).toBe("none")
    expect(none.calls).toEqual([])
    lockFile(env)
    const path = codexLockPath(THREAD, env)
    const lsof = fakeRun({ holder: 10 })
    expect(await codexOwner(THREAD, env, { run: lsof.run, table: ps })).toBe("desktop")
    expect(lsof.calls).toEqual([{ bin: "lsof", args: ["-t", "--", path] }])
    expect(await codexOwner(THREAD, env, { run: fakeRun().run, table: ps })).toBe("none")
    const fuser = fakeRun({ holder: 10, lsof: "missing" })
    expect(await codexOwner(THREAD, env, { run: fuser.run, table: ps })).toBe("desktop")
    expect(fuser.calls.map((call) => call.bin)).toEqual(["lsof", "fuser"])
    expect(await codexOwner(THREAD, env, { run: fakeRun({ holder: 10, lsof: "missing", fuser: "missing" }).run, table: ps })).toBe("unknown")
  })
})

async function wakeSetup() {
  const root = temp()
  const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0 })
  cleanups.push(() => broker.stop())
  const lane = broker.core.claim({ handle: "lane", harness: "codex", session: "s1", process: "pid:4242" }, { transient: true }).endpoint
  broker.core.event(lane.id, { kind: "stop", session_id: THREAD }, { transient: true, process: "pid:4242" })
  broker.core.setWake(lane.id, "codex-queue", { transient: true, process: "pid:4242" })
  const peer = broker.core.claim({ handle: "peer", harness: "test" }).endpoint
  const env: Record<string, string> = { SCP_DIR: join(root, "state"), CODEX_HOME: join(root, "codex") }
  const wake = async (deps: { run: Run; table?: () => PsCommTable | undefined }, ref: string = THREAD) => {
    const job = broker.core.wakeDue(lane.id, Date.now())
    expect({ provider: job?.provider, ref: job?.ref, ticket: job?.ticket?.slice(0, 4) }).toEqual({ provider: "codex-queue", ref: THREAD, ticket: "kwt_" })
    const printed: string[] = []
    const code = await codexWakeCommand(
      { ...env, SCP_WAKE_TICKET: job!.ticket! },
      { ...deps, platform: "darwin", stdin: Readable.from([JSON.stringify({ endpoint: "me/lane", ref })]), stdout: (text) => printed.push(text) },
    )
    broker.core.wakeResult(lane.id, {
      ok: code === 0,
      code,
      ms: 1,
      message: job!.message.id,
      ...(code === 77 ? { declined: JSON.parse(printed[0]!).declined } : {}),
    })
    return { code, printed }
  }
  return { broker, lane, peer, env, wake }
}

describe("codex-wake", () => {
  test("queues the framed messages with argv kept verbatim, confirms them read and opens the thread nobody holds", async () => {
    const { broker, lane, peer, wake } = await wakeSetup()
    const body = `$(touch /tmp/pwned); \`id\` | rm -rf ~ && echo "x" > /etc/y; --message=evil\nnext line`
    broker.core.send(peer.id, { to: "lane", body })
    const { run, calls } = fakeRun()
    expect((await wake({ run })).code).toBe(0)
    const queue = calls.find((call) => call.bin === "codex")!
    expect(queue.args.slice(0, 2)).toEqual(["queue", `--thread=${THREAD}`])
    expect(queue.args).toHaveLength(3)
    expect(queue.args[2]).toStartWith("--message=")
    expect(queue.args[2]).toContain(body)
    expect(queue.args[2]).toContain('<relay-message from="me/peer"')
    expect(calls.at(-1)).toEqual({ bin: "open", args: ["-g", `codex://threads/wake/${THREAD}`] })
    expect(broker.core.hasUnread(lane.id)).toBe(false)
  })

  test("opens only for the desktop app; other holders drain the queue themselves, and a running exec keeps the messages", async () => {
    const { broker, lane, peer, env, wake } = await wakeSetup()
    lockFile(env)
    const ps = () =>
      table([
        [10, 9, `${DESKTOP_CLI} app-server`],
        [9, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
        [20, 1, "codex"],
        [30, 1, "/opt/codex app-server"],
        [50, 1, "codex exec hi"],
      ])
    for (const [holder, opens] of [
      [10, true],
      [20, false],
      [30, false],
    ] as const) {
      broker.core.send(peer.id, { to: "lane", body: `for ${holder}` })
      const { run, calls } = fakeRun({ holder })
      expect((await wake({ run, table: ps })).code).toBe(0)
      expect(calls.some((call) => call.bin === "codex")).toBe(true)
      expect(calls.some((call) => call.bin === "open")).toBe(opens)
      expect(broker.core.hasUnread(lane.id)).toBe(false)
    }
    broker.core.send(peer.id, { to: "lane", body: "while exec runs" })
    const exec = fakeRun({ holder: 50 })
    expect((await wake({ run: exec.run, table: ps })).code).toBe(0)
    expect(exec.calls.map((call) => call.bin)).toEqual(["lsof"])
    expect(broker.core.hasUnread(lane.id)).toBe(true)
    const unknown = fakeRun({ holder: 10, lsof: "missing", fuser: "missing" })
    expect((await wake({ run: unknown.run, table: ps })).code).toBe(0)
    expect(unknown.calls.map((call) => call.bin)).toEqual(["lsof", "fuser", "codex", "lsof", "fuser"])
    expect(broker.core.hasUnread(lane.id)).toBe(false)
  })

  test("a thread with no rollout declines quietly, keeps the message unread and opens nothing; the next delivery does not retry", async () => {
    const { broker, lane, peer, wake } = await wakeSetup()
    broker.core.send(peer.id, { to: "lane", body: "too early" })
    const { run, calls } = fakeRun({ queue: "no-rollout" })
    const result = await wake({ run })
    expect(result).toEqual({ code: 77, printed: [`${JSON.stringify({ declined: "no-rollout" })}\n`] })
    expect(calls.some((call) => call.bin === "open")).toBe(false)
    expect(broker.core.hasUnread(lane.id)).toBe(true)
    expect(broker.core.whoami(lane.id)).toMatchObject({ wake: "codex-queue", wake_declined: "no-rollout" })
    expect(broker.core.whoami(lane.id).wake_failed).toBeUndefined()
    broker.core.send(peer.id, { to: "lane", body: "still too early" })
    expect(broker.core.wakeDue(lane.id, Date.now())).toBeNull()
    expect(broker.core.setWake(lane.id, "codex-queue", { transient: true, process: "pid:4242" })).toBe(true)
    expect(broker.core.whoami(lane.id).wake_declined).toBeUndefined()
    expect(broker.core.wakeDue(lane.id, Date.now())).not.toBeNull()
  })

  test("nothing is delivered twice: a hook sees no queued message, and a message a hook showed is not queued", async () => {
    const { broker, lane, peer, wake } = await wakeSetup()
    broker.core.send(peer.id, { to: "lane", body: "once" })
    const first = fakeRun()
    await wake({ run: first.run })
    expect(broker.core.inject(lane.id, { transient: true, process: "pid:4242" }).offered).toEqual([])
    broker.core.send(peer.id, { to: "lane", body: "shown by a hook" })
    const shown = broker.core.inject(lane.id, { transient: true, process: "pid:4242" })
    expect(shown.offered).toHaveLength(1)
    broker.core.injected(shown.offered, shown.hold, { endpoint: lane.id, read: shown.offered })
    broker.core.send(peer.id, { to: "lane", body: "held by a hook" })
    broker.core.inject(lane.id, { transient: true, process: "pid:4242" })
    const second = fakeRun()
    await wake({ run: second.run })
    expect(second.calls.some((call) => call.bin === "codex")).toBe(false)
  })

  test("large messages go in several codex queue messages, each confirmed once queued", async () => {
    const { broker, lane, peer, wake } = await wakeSetup()
    for (const fill of ["a", "b"]) broker.core.send(peer.id, { to: "lane", body: fill.repeat(60_000) })
    const { run, calls } = fakeRun()
    expect((await wake({ run })).code).toBe(0)
    const queued = calls.filter((call) => call.bin === "codex")
    expect(queued).toHaveLength(2)
    for (const call of queued) expect(Buffer.byteLength(call.args[2]!)).toBeLessThan(96 * 1024)
    expect(broker.core.hasUnread(lane.id)).toBe(false)
  })

  test("a run's ticket stays good while a turn clears the wake and its stop sets it again", async () => {
    const { broker, lane, peer } = await wakeSetup()
    broker.core.send(peer.id, { to: "lane", body: "mid-run" })
    const job = broker.core.wakeDue(lane.id, Date.now())!
    broker.core.prompted(lane.id, { transient: true, process: "pid:4242" })
    expect(broker.core.whoami(lane.id).wake).toBeNull()
    broker.core.setWake(lane.id, "codex-queue", { transient: true, process: "pid:4242" })
    expect(broker.core.wakeTicketHolder(job.ticket)).toBe(lane.id)
    broker.core.wakeResult(lane.id, { ok: true, ms: 1 })
    expect(broker.core.wakeTicketHolder(job.ticket)).toBeNull()
  })

  test("a bad ref declines before anything runs; a ticket binds only during its run", async () => {
    const { broker, lane, peer, wake } = await wakeSetup()
    broker.core.send(peer.id, { to: "lane", body: "hi" })
    const { run, calls } = fakeRun()
    expect(await wake({ run }, `${THREAD}; open -a Calculator`)).toEqual({ code: 77, printed: [`${JSON.stringify({ declined: "unresumable" })}\n`] })
    expect(calls).toEqual([])
    broker.core.setWake(lane.id, "codex-queue", { transient: true, process: "pid:4242" })
    const job = broker.core.wakeDue(lane.id, Date.now())!
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    expect((await client.hello({ observe: true, ticket: job.ticket! })).endpoint?.address).toBe("me/lane")
    broker.core.wakeResult(lane.id, { ok: true, ms: 1 })
    const late = await RelayClient.connect(broker.socket)
    cleanups.push(() => late.close())
    expect(late.hello({ observe: true, ticket: job.ticket! })).rejects.toThrow("unknown or spent")
    expect(client.request("inbox", { offer: true })).rejects.toThrow("spent")
  })
})

describe("codex thread identity", () => {
  const base = { fallbackHarness: "hook", cwd: "/work", startOf: () => START, lineageOf: () => [] }

  test("a thread a shared app server hosts claims by its id; one codex process per thread keeps its process key", () => {
    const desktop = relayIdentity({
      ...base,
      harness: "codex",
      harnessSession: THREAD,
      env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
      harnessPid: () => 10,
      psTable: () => table([[10, 1, `${DESKTOP_CLI} app-server`]]),
    })
    expect(desktop).toMatchObject({ harness: "codex-desktop", session: `codex:${THREAD}`, harness_session: THREAD, process: `pid:10:${START}` })
    const ide = relayIdentity({
      ...base,
      harness: "codex",
      harnessSession: THREAD,
      env: {},
      harnessPid: () => 30,
      psTable: () => table([[30, 1, "/opt/codex app-server"]]),
    })
    expect(ide.session).toBe(`codex:${THREAD}`)
    const tui = relayIdentity({ ...base, harness: "codex", harnessSession: THREAD, env: {}, harnessPid: () => 20, psTable: () => table([[20, 1, "codex"]]) })
    expect(tui).toMatchObject({ session: `pid:20:${START}`, harness_session: THREAD })
    const launched = relayIdentity({
      ...base,
      harness: "codex",
      env: { SCP_SHIM_BINDING: "ab", SCP_CODEX_THREAD: THREAD },
      harnessPid: () => 30,
      psTable: () => table([[30, 1, "/opt/codex app-server"]]),
    })
    expect(launched).toMatchObject({ session: `pid:30:${START}`, harness_session: THREAD })
    expect(relayIdentity({ ...base, harness: "codex", harnessSession: "not-a-thread", env: {}, harnessPid: () => 20 }).harness_session).toBeUndefined()
  })

  test("a codex stop hook sets codex-queue on its thread's endpoint once; a launcher's wake wins", async () => {
    const root = temp()
    const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0 })
    cleanups.push(() => broker.stop())
    const hook = (env: Record<string, string>, event = "Stop") =>
      runHook(["codex"], {
        env: { SCP_DIR: join(root, "state"), ...env },
        cwd: root,
        stdin: Readable.from([JSON.stringify({ hook_event_name: event, session_id: THREAD, cwd: root, stop_hook_active: false })]),
        connect: async () => RelayClient.connect(broker.socket),
        harnessPid: () => 10,
        startOf: () => START,
        psTable: () => table([[10, 1, `${DESKTOP_CLI} app-server`]]),
        print: () => true,
      })
    await hook({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" }, "SessionStart")
    const view = () => broker.core.list({ all: true }).find((e) => e.harness === "codex-desktop")!
    expect(view().wake).toBeNull()
    await hook({ CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" })
    expect(view().wake).toBe("codex-queue")
    expect(broker.core.sessionOf(view().id)).toBe(`codex:${THREAD}`)
    expect(broker.core.list({ all: true }).filter((e) => e.harness === "codex-desktop")).toHaveLength(1)
    const launcher = await RelayClient.connect(broker.socket)
    cleanups.push(() => launcher.close())
    await launcher.hello({ claim: { handle: "swarm-lane", harness: "codex", session: `pid:20:${START}`, process: `pid:20:${START}` } })
    await launcher.request("wake", { via: "codex-app-server" })
    const spawned = broker.core.list({ all: true }).find((e) => e.address === "me/swarm-lane")!
    await runHook(["codex"], {
      env: { SCP_DIR: join(root, "state"), SCP_SHIM_BINDING: "ab", SCP_NAME: "swarm-lane" },
      cwd: root,
      stdin: Readable.from([JSON.stringify({ hook_event_name: "Stop", session_id: THREAD, cwd: root })]),
      connect: async () => RelayClient.connect(broker.socket),
      harnessPid: () => 20,
      startOf: () => START,
      psTable: () => table([[20, 1, "/opt/codex app-server --listen unix:///tmp/scp-codex-x/app.sock"]]),
      print: () => true,
    })
    expect(broker.core.whoami(spawned.id).wake).toBe("codex-app-server")
  })
})

describe("desktop threads", () => {
  test("threads of one app server are separate roots, and a new thread never takes an idle thread's endpoint", async () => {
    const root = temp()
    const clock = { now: Date.now() }
    const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0, now: () => clock.now })
    cleanups.push(() => broker.stop())
    const other = "01a16032-a1c8-7512-b648-be089f3cebf6"
    const hook = (thread: string) =>
      runHook(["codex"], {
        env: { SCP_DIR: join(root, "state"), CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
        cwd: root,
        stdin: Readable.from([JSON.stringify({ hook_event_name: "Stop", session_id: thread, cwd: root })]),
        connect: async () => RelayClient.connect(broker.socket),
        harnessPid: () => 10,
        startOf: () => START,
        psTable: () =>
          table([
            [10, 9, `${DESKTOP_CLI} app-server`],
            [9, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
          ]),
        print: () => true,
      })
    await hook(THREAD)
    clock.now += 7_200_000
    await hook(other)
    const threads = broker.core.list({ all: true }).filter((e) => e.harness === "codex-desktop")
    expect(threads).toHaveLength(2)
    for (const view of threads) expect(view).toMatchObject({ parent: null, depth: 0, wake: "codex-queue" })
    const shells = await Promise.all(
      [THREAD, other].map(async (thread) => {
        const shell = await RelayClient.connect(broker.socket)
        cleanups.push(() => shell.close())
        return (await shell.hello({ observe: true, self: [`pid:10:${START}`], harness_session: thread })).endpoint?.id
      }),
    )
    expect(new Set(shells)).toEqual(new Set(threads.map((view) => view.id)))
  })
})

describe("desktop child threads and forks", () => {
  test("a child thread's hooks claim a subagent of its root thread's endpoint; an app server's ephemeral fork claims nothing, an ephemeral exec does", async () => {
    const root = temp()
    const broker = await startBroker({ dir: join(root, "state"), policyPath: join(root, "policy.json"), idleMs: 0 })
    cleanups.push(() => broker.stop())
    const hook = (payload: Record<string, unknown>, server = `${DESKTOP_CLI} -c features.code_mode_host=true app-server`) =>
      runHook(["codex"], {
        env: { SCP_DIR: join(root, "state"), ...(server.includes("app-server") ? { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" } : {}) },
        cwd: root,
        stdin: Readable.from([JSON.stringify({ cwd: root, transcript_path: join(root, "rollout.jsonl"), ...payload })]),
        connect: async () => RelayClient.connect(broker.socket),
        harnessPid: () => process.pid,
        startOf: () => START,
        psTable: () => table([[process.pid, 1, server]]),
        print: () => true,
      })
    await hook({ hook_event_name: "SessionStart", session_id: THREAD, source: "startup" })
    const desktop = () => broker.core.list({ all: true }).filter((e) => e.harness === "codex-desktop")
    const thread = desktop()[0]!
    const child = { session_id: THREAD, agent_id: "01a16032-a1c8-7512-b648-be089f3cebf6", agent_type: "default" }
    const address = `${thread.address}-default-01a1`
    expect(JSON.parse((await hook({ ...child, hook_event_name: "UserPromptSubmit", prompt: "task" }))!).hookSpecificOutput).toEqual({
      hookEventName: "UserPromptSubmit",
      additionalContext: subagentIntro(address),
    })
    const sub = () => broker.core.list({ all: true }).find((e) => e.address === address)!
    expect(sub()).toMatchObject({ parent: thread.address, harness: "codex-desktop" })
    expect(broker.core.sessionOf(sub().id)).toBe(`sub:${child.agent_id}:codex:${THREAD}`)
    await hook({ ...child, hook_event_name: "PostToolUse", tool_name: "shell", tool_input: { command: "ls" } })
    await hook({ ...child, hook_event_name: "SubagentStop" })
    expect(sub().status?.state).toBe("done")
    const ended = { session_id: THREAD, agent_id: "01a16033-0000-7000-8000-000000000000", agent_type: "default" }
    await hook({ ...ended, hook_event_name: "PostToolUse", tool_name: "shell", tool_input: { command: "ls" } })
    const second = () => broker.core.list({ all: true }).find((e) => e.address === `${thread.address}-default-01a1-2`)!
    expect(second().status?.state).not.toBe("done")
    await hook({ ...ended, hook_event_name: "SessionEnd", reason: "other" })
    expect(second().status?.state).toBe("done")
    expect(
      broker.core
        .activity({ limit: 100 })
        .filter((r) => r.endpoint === thread.address)
        .map((r) => r.kind),
    ).toEqual(["session_start"])
    const fork = { session_id: "01a16040-0000-7000-8000-000000000000", transcript_path: null }
    expect(await hook({ ...fork, hook_event_name: "SessionStart", source: "fork" })).toBeUndefined()
    expect(await hook({ ...fork, hook_event_name: "UserPromptSubmit", prompt: "suggest" })).toBeUndefined()
    expect(
      await hook({ sessionId: fork.session_id, transcript_path: undefined, transcriptPath: null, hook_event_name: "UserPromptSubmit", prompt: "x" }),
    ).toBeUndefined()
    expect(desktop().map((e) => e.address)).toEqual([thread.address, address, `${thread.address}-default-01a1-2`])
    await hook({ ...fork, hook_event_name: "UserPromptSubmit", prompt: "run" }, "/opt/codex exec --ephemeral run")
    expect(broker.core.list({ all: true }).filter((e) => e.harness === "codex")).toHaveLength(1)
  })
})

describe("swarm codex --resume", () => {
  test("names the resumed thread to its shim, and only a thread id", () => {
    expect(codexLaunch(["--resume", THREAD], { SCP_CODEX_THREAD: "old" }, []).env.SCP_CODEX_THREAD).toBe(THREAD)
    expect(codexLaunch(["--resume", "named-session"], { SCP_CODEX_THREAD: THREAD }, []).env.SCP_CODEX_THREAD).toBeUndefined()
  })

  test("a thread the desktop app holds is refused with a hint, not codex's exit 125", async () => {
    const root = temp()
    const bundled = join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli")
    mkdirSync(bundled, { recursive: true })
    writeFileSync(join(bundled, "codex"), "#!/bin/sh\nsleep 30\n:\n")
    chmodSync(join(bundled, "codex"), 0o755)
    const holder = spawn(join(bundled, "codex"), ["app-server"], { stdio: "ignore" })
    cleanups.push(() => void holder.kill("SIGKILL"))
    const lsof = join(root, "lsof")
    writeFileSync(lsof, `#!/bin/sh\necho ${holder.pid}\n`)
    chmodSync(lsof, 0o755)
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      CODEX_HOME: join(root, "codex"),
      SCP_DIR: join(root, "scp"),
      SCP_LSOF_BIN: lsof,
      SCP_CODEX_BIN: "/usr/bin/false",
    }
    lockFile(env)
    const run = spawnSync(process.execPath, [join(import.meta.dir, "cli.ts"), "codex", "--headless", "--resume", THREAD], { env, encoding: "utf8" })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`thread ${THREAD} is open in the Codex desktop app`)
    expect(run.stderr).toContain(`codex fork ${THREAD}`)
  })
})
