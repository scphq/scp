import { Database } from "bun:sqlite"
import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RelayClient, socketPath } from "@scp-dev/broker"
import type { EndpointView, Envelope } from "@scp-dev/core"
import { processKey } from "./identity"
import { alive, waitFor } from "./testing/fixtures"

setDefaultTimeout(120_000)

const cli = join(import.meta.dir, "cli.ts")
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * a stand-in for codex exec: it finds the scp server in its -c overrides, asks that shim who it is, reports a session id through codex's
 * SessionStart hook on its first run (or, with $FAKE_CODEX_THREAD, only prints that thread in codex's stderr header), records its run, and
 * waits for a go file while a gate file exists
 */
const fakeCodex = (rec: string) => `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
const REC = ${JSON.stringify(rec)}
const CLI = ${JSON.stringify(cli)}
const argv = process.argv.slice(2)
if (argv.includes("--help")) {
  console.log("--skip-git-repo-check")
  process.exit(0)
}
const counter = REC + ".runs"
const run = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1
writeFileSync(counter, String(run))
const server = {}
for (const pair of argv.flatMap((arg, i, all) => (arg === "-c" ? [all[i + 1]] : []))) {
  const eq = pair.indexOf("=")
  if (pair.startsWith("mcp_servers.scp.")) server[pair.slice(16, eq)] = Bun.TOML.parse("v = " + pair.slice(eq + 1)).v
}
const env = {}
for (const key of ["HOME", "PATH", "TMPDIR", "USER", "SCP_HARNESS_DETECT", ...(server.env_vars ?? [])]) if (process.env[key] !== undefined) env[key] = process.env[key]
let address = null
if (server.command) {
  const shim = Bun.spawn([server.command, ...(server.args ?? [])], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" })
  const rpc = (id, method, params) => shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n")
  rpc(0, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0" } })
  rpc(1, "tools/call", { name: "relay_whoami", arguments: {} })
  shim.stdin.flush()
  let text = ""
  const reader = shim.stdout.getReader()
  while (!text.split("\\n").some((line) => line.includes('"id":1'))) {
    const read = await reader.read()
    if (read.done) break
    text += new TextDecoder().decode(read.value)
  }
  shim.stdin.end()
  await shim.exited
  const answer = text.split("\\n").filter(Boolean).map((line) => JSON.parse(line)).find((m) => m.id === 1)
  address = /address: (\\S+)/.exec(answer?.result?.content?.[0]?.text ?? "")?.[1] ?? null
}
if (process.env.FAKE_CODEX_THREAD) {
  if (!argv.includes("resume")) console.error("OpenAI Codex\\n--------\\nsession id: " + process.env.FAKE_CODEX_THREAD + "\\n--------")
} else if (!argv.includes("resume")) {
  const hook = Bun.spawn([process.execPath, "--no-env-file", CLI, "hook", "codex", "SessionStart"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: process.env })
  hook.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-" + process.env.SCP_NAME, cwd: process.cwd(), source: "startup" }))
  hook.stdin.end()
  await hook.exited
}
appendFileSync(REC, JSON.stringify({ run, argv, address, session: process.env.SCP_SESSION ?? null, launcher: process.env.SCP_HARNESS_PID ?? null }) + "\\n")
writeFileSync(REC + ".up" + run, "")
while (existsSync(REC + ".gate") && !existsSync(REC + ".go" + run)) await Bun.sleep(20)
console.log("run " + run + " done")
`

/** a stand-in for headless agy, grok or muse exec: it records its arguments, reports agy's conversation through agy's hook, and asks its own shim who it is */
const fakeTurn = (harness: "agy" | "grok" | "muse", log: string) => `
import { appendFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
const args = process.argv.slice(2)
const cli = ${JSON.stringify(cli)}
if (${JSON.stringify(harness)} === "agy") {
  const at = args.indexOf("--conversation")
  spawnSync(process.execPath, ["--no-env-file", cli, "hook", "agy", "SessionStart"], {
    input: JSON.stringify({ conversationId: at < 0 ? "conv-1" : args[at + 1], workspacePaths: [process.cwd()] }),
    stdio: ["pipe", "ignore", "ignore"],
  })
}
const shim = spawn(process.execPath, ["--no-env-file", cli, "mcp", "--harness", ${JSON.stringify(harness)}], { stdio: ["pipe", "pipe", "ignore"] })
let out = ""
const answered = new Promise((resolve) => shim.stdout.on("data", (data) => { out += data; if (out.includes('"id":2')) resolve() }))
const send = (message) => shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } })
send({ method: "notifications/initialized" })
send({ id: 2, method: "tools/call", params: { name: "relay_whoami", arguments: {} } })
await answered
shim.stdin.end()
const address = /address: (\\S+?)\\\\n/.exec(out)?.[1] ?? null
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, address }) + "\\n")
console.log("turn done")
`

/** Muse starts its shim and hooks without the launcher's SCP_* variables; the fake keeps only the broker dir */
const MUSE_UNSET = ["SCP_GRANT", "SCP_NAME", "SCP_LABELS", "SCP_SESSION", "SCP_HARNESS_PID"].map((key) => `-u ${key}`).join(" ")

type Run = { run: number; argv: string[]; address: string | null; session: string | null; launcher: string | null }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scp-hold-e2e-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, "work")
  const bin = join(root, "bin")
  mkdirSync(cwd)
  mkdirSync(bin)
  const rec = join(root, "runs.jsonl")
  writeFileSync(join(root, "fake-codex.ts"), fakeCodex(rec))
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(join(root, "fake-codex.ts"))} "$@"\n`)
  chmodSync(join(bin, "codex"), 0o755)
  const turns = join(root, "turns.jsonl")
  for (const harness of ["agy", "grok", "muse"] as const) {
    writeFileSync(join(root, `fake-${harness}.ts`), fakeTurn(harness, turns))
    writeFileSync(
      join(bin, harness),
      `#!/bin/sh\nexec ${harness === "muse" ? `env ${MUSE_UNSET} ` : ""}${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(join(root, `fake-${harness}.ts`))} "$@"\n`,
    )
    chmodSync(join(bin, harness), 0o755)
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_STATE_HOME: join(root, ".state"),
    SCP_DIR: join(root, "scp"),
    SCP_IDLE: "120s",
  }
  for (const key of Object.keys(env)) if (/^(SCP_(NAME|SESSION|GRANT|PARENT|HARNESS|HARNESS_PID)$|CODEX_|CLAUDECODE|CLAUDE_CODE_)/.test(key)) delete env[key]
  const swarm = (...args: string[]) => spawnSync(process.execPath, ["--no-env-file", cli, ...args], { env, cwd, encoding: "utf8", timeout: 60_000 })
  const runners: number[] = []
  cleanups.push(() => {
    for (const pid of runners) if (alive(pid)) process.kill(pid, "SIGKILL")
    swarm("daemon", "stop")
  })
  expect(swarm("list", "--json").status).toBe(0)
  const lead = await RelayClient.connect(socketPath(env.SCP_DIR!))
  cleanups.push(() => lead.close())
  await lead.hello({ claim: { handle: "lead", harness: "claude-code", process: processKey(process.pid), lineage: [processKey(process.pid)] } })
  const spawn = (...args: string[]) => {
    const result = swarm("spawn", "--bg", ...args)
    expect([result.status, result.stderr]).toEqual([0, ""])
    const pid = Number(/pid (\d+)/.exec(result.stdout)?.[1])
    runners.push(pid)
    return pid
  }
  const view = async (handle: string) =>
    (await lead.request<{ endpoints: EndpointView[] }>("list", { all: true })).endpoints.find((e) => e.address === `me/${handle}`)
  const read = async () => {
    const { messages } = await lead.request<{ messages: Envelope[] }>("inbox")
    if (messages.length) await lead.request("ack", { seqs: messages.map((m) => m.seq) })
    return messages
  }
  const mail: Envelope[] = []
  /** the next message from `handle` whose body starts with `prefix` */
  const next = async (handle: string, prefix = "worker "): Promise<Envelope> => {
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await Bun.sleep(50)) {
      mail.push(...(await read()))
      const at = mail.findIndex((m) => m.from.address === `me/${handle}` && m.body.text.startsWith(prefix))
      if (at >= 0) return mail.splice(at, 1)[0]!
    }
    const log = existsSync(join(env.SCP_DIR!, "broker.log")) ? readFileSync(join(env.SCP_DIR!, "broker.log"), "utf8") : ""
    const views = (await lead.request<{ endpoints: EndpointView[] }>("list", { all: true })).endpoints.map((e) => [
      e.address,
      e.presence,
      e.wake,
      e.status,
      e.wake_failed,
      e.wake_declined,
    ])
    throw new Error(`timed out waiting for a message from ${handle}: ${JSON.stringify({ mail, views, runs: runs(), log })}`)
  }
  const runs = (): Run[] =>
    existsSync(rec)
      ? readFileSync(rec, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Run)
      : []
  const gate = () => writeFileSync(`${rec}.gate`, "")
  const go = (run: number) => writeFileSync(`${rec}.go${run}`, "")
  const up = (run: number) => waitFor(() => existsSync(`${rec}.up${run}`), 30_000, `run ${run}`)
  const turnsOf = () =>
    existsSync(turns)
      ? readFileSync(turns, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { args: string[]; address: string | null })
      : []
  return { root, cwd, env, swarm, lead, spawn, view, next, runs, gate, go, up, turns: turnsOf }
}

/** waitFor, for an async check */
async function until(check: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${what}`)
}

test("a held codex exec worker resumes its session for each batch of messages, hands each run back as a reply, and swarm end lets it go", async () => {
  const f = await fixture()
  f.gate()
  const runner = f.spawn("--idle", "60", "--name", "hw", "--", "codex", "exec", "do it")
  await f.up(1)
  f.go(1)
  const first = await f.next("hw")
  expect(first.body.text).toBe("worker me/hw finished (exit 0)\n\nrun 1 done\n\nme/hw stays resumable: message it to resume its session")
  await until(async () => (await f.view("hw"))?.wake === "spawn-resume", 10_000, "the spawn-resume wake")
  expect((await f.view("hw"))?.presence).not.toBe("offline")

  const steer = await f.lead.request<{ id: string; thread: string }>("send", { to: "hw", body: "now the tests" })
  await f.up(2)
  const second = f.runs()[1]!
  expect(second.argv.slice(second.argv.indexOf("resume"))).toContain("sess-hw")
  expect(second.argv.at(-1)).toContain("now the tests")
  expect(second.argv.at(-1)).toContain("<relay-message")
  expect([second.address, second.launcher]).toEqual(["me/hw", String(runner)])
  expect(second.session).toMatch(/^[0-9a-f]{32}$/)
  await f.lead.request("send", { to: "hw", body: "and the docs" })
  await Bun.sleep(300)
  f.go(2)
  const reply = await f.next("hw")
  expect(reply.body.text).toBe("worker me/hw finished (exit 0)\n\nrun 2 done\n\nme/hw stays resumable: message it to resume its session")
  expect([reply.reply_to, reply.thread]).toEqual([steer.id, steer.thread])
  await f.up(3)
  expect(f.runs()[2]!.argv.at(-1)).toContain("and the docs")
  expect(f.runs()[2]!.argv.at(-1)).not.toContain("now the tests")
  f.go(3)
  await f.next("hw")
  expect(f.runs().map((r) => r.address)).toEqual(["me/hw", "me/hw", "me/hw"])

  const ended = f.swarm("end", "hw")
  expect([ended.status, ended.stdout]).toEqual([0, "me/hw ended: no message resumes it now; messages to it queue as for any offline agent\n"])
  await waitFor(() => !alive(runner), 10_000, "the runner to exit")
  expect((await f.view("hw"))?.wake ?? null).toBeNull()
  await f.lead.request("send", { to: "hw", body: "after the end" })
  await Bun.sleep(500)
  expect(f.runs()).toHaveLength(3)
})

test("an idle --no-durable worker is let go after --idle seconds; one ended during a run hands that run back, then is let go; one too long to keep durably is held plainly", async () => {
  const f = await fixture()
  const idle = f.spawn("--no-durable", "--idle", "2", "--name", "hi", "--", "codex", "exec", "go")
  await f.next("hi")
  await waitFor(() => !alive(idle), 15_000, "the idle runner to exit")
  const gone = await f.view("hi")
  expect([gone?.wake ?? null, gone?.presence]).toEqual([null, "offline"])

  f.gate()
  const busy = f.spawn("--idle", "60", "--name", "hb", "--", "codex", "exec", "go")
  await f.up(2)
  f.go(2)
  await f.next("hb")
  await f.lead.request("send", { to: "hb", body: "one more" })
  await f.up(3)
  expect((await f.lead.request<{ held: boolean }>("spawn_end", { endpoint: "hb" })).held).toBe(true)
  f.go(3)
  expect((await f.next("hb")).body.text).toStartWith("worker me/hb finished (exit 0)\n\nrun 3 done")
  await waitFor(() => !alive(busy), 10_000, "the ended runner to exit")
  await f.lead.request("send", { to: "hb", body: "too late" })
  await Bun.sleep(500)
  expect(f.runs()).toHaveLength(3)

  f.go(4)
  const plain = f.spawn("--idle", "1", "--name", "hl", "--", "codex", "exec", "--model", "x".repeat(600), "go")
  expect((await f.next("hl")).body.text).toContain("stays resumable")
  await waitFor(() => !alive(plain), 15_000, "the plainly held runner to exit")
  expect((await f.view("hl"))?.presence).toBe("offline")
})

test("a worker with a parent is durable by default: after $SCP_IDLE_AFTER_S it hibernates, and a message wakes it through the built-in spawn waker", async () => {
  const f = await fixture()
  f.env.SCP_IDLE_AFTER_S = "2"
  const runner = f.spawn("--name", "hd", "--", "codex", "exec", "go")
  await f.next("hd")
  await waitFor(() => !alive(runner), 15_000, "the runner to hibernate and exit")
  const asleep = await f.view("hd")
  expect(asleep).toMatchObject({ presence: "hibernated", wake: "hook:spawn" })

  const steer = await f.lead.request<{ id: string }>("send", { to: "hd", body: "wake up and continue" })
  const back = await f.next("hd")
  expect(back.body.text).toBe("worker me/hd finished (exit 0)\n\nrun 2 done")
  expect(back.reply_to).toBe(steer.id)
  const resumed = f.runs()[1]!
  expect(resumed.argv.slice(resumed.argv.indexOf("resume"))).toContain("sess-hd")
  expect(resumed.argv.at(-1)).toContain("wake up and continue")
  expect(resumed.address).toBe("me/hd")
  expect((await f.view("hd"))?.parent).toBe("me/lead")
  expect((await f.view("hd"))?.labels).toEqual(asleep!.labels)
  const db = new Database(join(f.env.SCP_DIR!, "relay.db"), { readonly: true })
  const audits = (event: string) => db.query("SELECT detail FROM audit WHERE event = ?").all(event) as { detail: string }[]
  expect(audits("scope_reset")).toEqual([])
  expect(
    audits("claim")
      .map((a) => JSON.parse(a.detail))
      .filter((a) => a.handle === "hd" && a.resumed),
  ).toHaveLength(1)
  db.close()
  await until(async () => (await f.view("hd"))?.presence === "hibernated", 15_000, "the woken worker to hibernate again")
})

test("a codex exec worker whose hooks report no session is durable by the thread its output names, with its flags kept on resume", async () => {
  const f = await fixture()
  const thread = "0199a213-81c0-7800-8aa1-bbab2a035a53"
  f.env.SCP_IDLE_AFTER_S = "2"
  f.env.FAKE_CODEX_THREAD = thread
  const runner = f.spawn("--name", "ht", "--", "codex", "exec", "--skip-git-repo-check", "-m", "m1", "-c", "k=v", "remember HERON")
  expect((await f.next("ht")).body.text).toBe("worker me/ht finished (exit 0)\n\nrun 1 done\n\nme/ht stays resumable: message it to resume its session")
  await waitFor(() => !alive(runner), 15_000, "the runner to hibernate and exit")
  expect(await f.view("ht")).toMatchObject({ presence: "hibernated", wake: "hook:spawn", revivable: true })
  expect(await f.lead.request<{ deliveries: { state?: string }[] }>("send", { to: "ht", body: "the codeword?" })).toMatchObject({
    deliveries: [{ state: "running", hibernated: true }],
  })
  expect((await f.next("ht")).body.text).toBe("worker me/ht finished (exit 0)\n\nrun 2 done")
  const resumed = f.runs()[1]!.argv
  const own = resumed
    .slice(resumed.indexOf("resume") + 1)
    .filter((word, i, all) => !word.startsWith("mcp_servers.") && !(word === "-c" && all[i + 1]?.startsWith("mcp_servers.")))
  expect(own.slice(0, -1)).toEqual(["--skip-git-repo-check", "-m", "m1", "-c", "k=v", thread])
  expect(own.at(-1)).toContain("the codeword?")
  await f.lead.request("spawn_end", { endpoint: "ht" })
})

test("a grok -p worker is durable: its ref leaves out the allow rules launch adds, and a message revives its session", async () => {
  const f = await fixture()
  f.env.SCP_IDLE_AFTER_S = "2"
  const runner = f.spawn("--name", "hg", "--", "grok", "-p", "remember HERON")
  expect((await f.next("hg")).body.text).toEndWith("me/hg stays resumable: message it to resume its session")
  await waitFor(() => !alive(runner), 15_000, "the runner to hibernate and exit")
  expect(await f.view("hg")).toMatchObject({ presence: "hibernated", wake: "hook:spawn", revivable: true })
  await f.lead.request("send", { to: "hg", body: "the codeword?" })
  await f.next("hg")
  const [opened, again] = f.turns()
  const session = opened!.args[opened!.args.indexOf("-s") + 1]!
  expect(again!.args.slice(0, 3)).toEqual(["--resume", session, "-p"])
  expect(again!.args[3]).toContain("the codeword?")
  expect(again!.args.slice(4)).toEqual(opened!.args.slice(4))
  expect(again!.address).toBe("me/hg")
  await f.lead.request("spawn_end", { endpoint: "hg" })
})

test("a woken durable worker ended during its run still hands that run back, then stays let go", async () => {
  const f = await fixture()
  f.gate()
  const runner = f.spawn("--durable", "--idle", "2", "--name", "hz", "--", "codex", "exec", "go")
  await f.up(1)
  f.go(1)
  await f.next("hz")
  await waitFor(() => !alive(runner), 15_000, "the runner to hibernate and exit")
  await f.lead.request("send", { to: "hz", body: "wake" })
  await f.up(2)
  expect((await f.lead.request<{ held: boolean }>("spawn_end", { endpoint: "hz" })).held).toBe(true)
  f.go(2)
  expect((await f.next("hz")).body.text).toStartWith("worker me/hz finished (exit 0)\n\nrun 2 done")
  await until(async () => (await f.view("hz"))?.presence === "offline", 15_000, "the ended worker to go offline")
  await f.lead.request("send", { to: "hz", body: "too late" })
  await Bun.sleep(500)
  expect(f.runs()).toHaveLength(2)
})

test("a durable worker whose spawn dies, or whose broker restarts, is hibernated by the broker", async () => {
  const f = await fixture()
  const runner = f.spawn("--durable", "--idle", "60", "--name", "hk", "--", "codex", "exec", "go")
  await f.next("hk")
  await until(async () => (await f.view("hk"))?.wake === "spawn-resume", 10_000, "the hold")
  process.kill(runner, "SIGKILL")
  await until(async () => (await f.view("hk"))?.presence === "hibernated", 10_000, "the broker's hibernation")
  expect((await f.view("hk"))?.wake).toBe("hook:spawn")

  const second = f.spawn("--durable", "--idle", "60", "--name", "hr", "--", "codex", "exec", "go")
  await f.next("hr")
  await until(async () => (await f.view("hr"))?.wake === "spawn-resume", 10_000, "the second hold")
  f.lead.close()
  expect(f.swarm("daemon", "stop").status).toBe(0)
  await waitFor(() => !alive(second), 10_000, "the runner to see its broker go")
  const listed = JSON.parse(f.swarm("list", "--all", "--json").stdout) as { endpoints: EndpointView[] }
  expect(listed.endpoints.find((e) => e.address === "me/hr")).toMatchObject({ presence: "hibernated", wake: "hook:spawn" })
})

test("--durable refuses a command it cannot resume, and --idle takes seconds, durations or Infinity", async () => {
  const f = await fixture()
  for (const [args, text] of [
    [["--durable", "--", "sh", "-c", "true"], "--durable resumes a headless session"],
    [["--durable", "--", "codex", "exec", "--ephemeral", "go"], "--durable resumes a headless session"],
    [["--durable", "--idle", "0", "--", "codex", "exec", "go"], "does not go with an idle time of 0"],
    [["--durable", "--no-durable", "--", "codex", "exec", "go"], "--durable and --no-durable conflict"],
    [["--idle", "soon", "--", "codex", "exec", "go"], "or Infinity"],
    [["--durable", "--", "codex", "exec", "--model", "x".repeat(600), "go"], "over 512"],
  ] as const) {
    const result = f.swarm("spawn", "--bg", ...args)
    expect([result.status, result.stderr]).toEqual([125, expect.stringContaining(text)])
  }
  expect(f.runs()).toEqual([])
})

test("headless agy and grok workers stay resumable: a message resumes the conversation agy's hook reported, or the session grok was given", async () => {
  const f = await fixture()
  const agy = f.spawn("--idle", "60", "--name", "ga", "--", "agy", "-p", "hi")
  await f.next("ga")
  await until(async () => (await f.view("ga"))?.wake === "spawn-resume", 10_000, "agy's hold")
  await f.lead.request("send", { to: "ga", body: "agy again" })
  await f.next("ga")
  const [first, resumed] = f.turns()
  expect(first).toEqual({ args: ["-p", "hi"], address: "me/ga" })
  expect(resumed!.args.slice(0, 3)).toEqual(["--conversation", "conv-1", "-p"])
  expect(resumed!.args[3]).toContain("agy again")
  expect(resumed!.address).toBe("me/ga")
  await f.lead.request("spawn_end", { endpoint: "ga" })
  await waitFor(() => !alive(agy), 10_000, "agy's runner to exit")

  const grok = f.spawn("--idle", "60", "--name", "gk", "--", "grok", "-p", "hi")
  await f.next("gk")
  await until(async () => (await f.view("gk"))?.wake === "spawn-resume", 10_000, "grok's hold")
  await f.lead.request("send", { to: "gk", body: "grok again" })
  await f.next("gk")
  const [, , opened, again] = f.turns()
  const session = opened!.args[opened!.args.indexOf("-s") + 1]!
  expect(session).toMatch(/^[0-9a-f-]{36}$/)
  expect(opened!.args.slice(0, 2)).toEqual(["-p", "hi"])
  expect(again!.args.slice(0, 3)).toEqual(["--resume", session, "-p"])
  expect(again!.args[3]).toContain("grok again")
  expect(again!.args.slice(4)).toEqual(opened!.args.slice(4))
  expect(again!.args[4]).toBe("--allow")
  expect([opened!.address, again!.address]).toEqual(["me/gk", "me/gk"])
  await f.lead.request("spawn_end", { endpoint: "gk" })
  await waitFor(() => !alive(grok), 10_000, "grok's runner to exit")
})

test("a muse exec worker, whose shim gets no SCP_* variables, stays resumable as itself: a message resumes it with exec --session-id, durably too", async () => {
  const f = await fixture()
  const muse = f.spawn("--idle", "60", "--name", "mu", "--", "muse", "exec", "--model", "m", "hi")
  expect((await f.next("mu")).body.text).toStartWith("worker me/mu finished (exit 0)\n\nturn done")
  await until(async () => (await f.view("mu"))?.wake === "spawn-resume", 10_000, "muse's hold")
  const steer = await f.lead.request<{ id: string }>("send", { to: "mu", body: "muse again" })
  const back = await f.next("mu")
  expect(back.body.text).toStartWith("worker me/mu finished (exit 0)\n\nturn done")
  expect(back.reply_to).toBe(steer.id)
  const [opened, again] = f.turns()
  const session = opened!.args[opened!.args.indexOf("--session-id") + 1]!
  expect(session).toMatch(/^[0-9a-f-]{36}$/)
  expect(opened!.args).toEqual(["exec", "--contributor-mode", "off", "--session-id", session, "--model", "m", "hi"])
  expect(again!.args.slice(0, -1)).toEqual(["exec", "--contributor-mode", "off", "--model", "m", "--session-id", session])
  expect(again!.args.at(-1)).toContain("muse again")
  expect(again!.args.at(-1)).toContain("<relay-message")
  expect([opened!.address, again!.address]).toEqual(["me/mu", "me/mu"])
  const addresses = async () => (await f.lead.request<{ endpoints: EndpointView[] }>("list", { all: true })).endpoints.map((e) => e.address)
  expect(await addresses()).not.toContain(expect.stringMatching(/^me\/muse-/))
  await f.lead.request("spawn_end", { endpoint: "mu" })
  await waitFor(() => !alive(muse), 10_000, "muse's runner to exit")

  const durable = f.spawn("--durable", "--idle", "2", "--name", "md", "--", "muse", "exec", "--session-id", "mine-1", "hi")
  await f.next("md")
  await waitFor(() => !alive(durable), 15_000, "the muse runner to hibernate and exit")
  expect(await f.view("md")).toMatchObject({ presence: "hibernated", wake: "hook:spawn" })
  await f.lead.request("send", { to: "md", body: "wake muse" })
  expect((await f.next("md")).body.text).toBe("worker me/md finished (exit 0)\n\nturn done")
  const [, , first, woken] = f.turns()
  expect(first!.args).toEqual(["exec", "--contributor-mode", "off", "--session-id", "mine-1", "hi"])
  expect(woken!.args.slice(1, -1)).toEqual(["--contributor-mode", "off", "--session-id", "mine-1"])
  expect(woken!.args.at(-1)).toContain("wake muse")
  expect(woken!.address).toBe("me/md")
  expect(await addresses()).not.toContain(expect.stringMatching(/^me\/muse-/))
  await until(async () => (await f.view("md"))?.presence === "hibernated", 15_000, "the woken muse worker to hibernate again")
})
