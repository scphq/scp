import { describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { join, resolve } from "node:path"
import { swarmBinary } from "./test-setup"

// Runs each scenario on the TypeScript CLI and on the native swarm with a fake claude and ps on PATH and a fake broker on the socket, and
// compares what each printed, ran, asked the broker and left on disk.

const ID = "1a2b3c4d"
const SESSION = `${ID}-0000-4000-8000-000000000001`
const ID2 = "2b3c4d5e"
const SESSION2 = `${ID2}-0000-4000-8000-000000000002`
const TICKET = `kwt_${"a".repeat(64)}`
const CLI = join(import.meta.dir, "cli.ts")
const LAUNCH = [process.execPath, "--no-env-file", "--config=/dev/null", CLI]
const ENGINE_VARS = new Set(["SCP_NATIVE", "SCP_NATIVE_TS", "SCP_SWARM_BIN", "SCP_CLI_ARGV", "SCP_ROUTE_LOG", "SCP_ROUTED", "SCP_CLI_PARENT"])

type Json = Record<string, unknown>

const FAKE_CLAUDE = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const root = process.env.HOME;
const file = root + "/claude-state.json";
const argv = process.argv.slice(2);
const seen = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SCP_|CLAUDE_)/.test(key)));
appendFileSync(root + "/calls.log", JSON.stringify({ argv, cwd: process.cwd(), env: seen }) + "\\n");
let entries = JSON.parse(readFileSync(file, "utf8"));
const [command, id] = argv;
if (command === "stop" && existsSync(root + "/slow-stop")) await Bun.sleep(1500);
if (existsSync(root + "/fail-" + command)) {
  console.error(readFileSync(root + "/fail-" + command, "utf8"));
  process.exit(1);
}
if (command === "agents") {
  if (existsSync(root + "/agents-noise")) console.error("warning: slow");
  console.log(JSON.stringify(argv.includes("--all") ? entries : entries.filter((e) => e.pid !== undefined)));
  process.exit(0);
}
const entry = entries.find((e) => e.id === id);
if (command === "stop") {
  delete entry.pid;
  entry.state = "stopped";
  console.log("stopped " + id);
} else if (command === "rm") {
  entries = entries.filter((e) => e.id !== id);
  console.log("removed " + id);
} else if (command === "respawn") {
  Object.assign(entry, { pid: 4242, state: "working", status: "idle" });
  console.log("respawned " + id);
} else if (command === "--bg") {
  const sessionId = existsSync(root + "/fork") ? readFileSync(root + "/fork", "utf8").trim() : argv[argv.indexOf("--resume") + 1];
  const short = sessionId.slice(0, 8);
  entries.push({ id: short, sessionId, kind: "background", cwd: process.cwd(), name: "lane", pid: 4242, state: "working", status: "idle" });
  console.log("backgrounded · " + short);
} else process.exit(2);
writeFileSync(file, JSON.stringify(entries));
`

const FAKE_PS = `#!/bin/sh
case "$2" in
  pid=,ppid=) [ -f "$HOME/fail-ps" ] && exit 1; printf '1 0\\n';;
  *) [ -f "$HOME/fail-ps" ] && exit 1; cat "$HOME/ps-table";;
esac
`

const agent = (overrides: Json = {}): Json => ({
  id: "worker-id",
  address: "me/w1",
  handle: "w1",
  harness: "claude-code",
  parent: "me/lead",
  children: 0,
  subagents: 0,
  harness_session: SESSION,
  state: "done",
  presence: "online",
  historic: false,
  worked_at: new Date(Date.now() - 3_600_000).toISOString(),
  mail_at: null,
  connections: 1,
  hibernate: null,
  unread: false,
  unread_at: null,
  handed_back: false,
  ...overrides,
})
const lead = (overrides: Json = {}): Json =>
  agent({ id: "lead-id", address: "me/lead", handle: "lead", parent: null, children: 1, harness_session: "lead-session", state: "working", ...overrides })
const entry = (overrides: Json = {}): Json => ({
  id: ID,
  sessionId: SESSION,
  cwd: "<root>/work",
  kind: "background",
  name: "lane",
  state: "working",
  pid: 4242,
  status: "idle",
  extra: { kept: [1, 2] },
  ...overrides,
})
const stopped = (overrides: Json = {}): Json => {
  const value = entry({ state: "stopped", ...overrides })
  delete value.pid
  return value
}
const mcpConfig = (vars: Json = {}, server: Json = {}): Json => ({
  other: { z: 1, a: 2 },
  mcpServers: {
    scp: {
      type: "stdio",
      command: "/bin/sh",
      args: ["mcp", "--harness", "claude"],
      env: { SCP_NAME: "w1", SCP_GRANT: "krt_x", SCP_UNDER: "", ...vars },
      ...server,
    },
  },
})

/** `alongside` runs the same moment on the other engine, `lag` ms after this one */
type Step = { argv: string[]; env?: Record<string, string>; before?: (world: World) => void; alongside?: { argv: string[]; lag: number } }

interface Scenario {
  name: string
  entries?: Json[]
  agents?: Json[]
  /** MCP configs, by short id */
  records?: Record<string, Json>
  /** state files as JSON text or values, by short id */
  states?: Record<string, Json | string>
  ps?: string
  config?: Json
  files?: Record<string, string>
  noBroker?: boolean
  noClaude?: boolean
  /** agents take these fields once `claude <call>` ran, or once hibernate was asked */
  after?: { call?: string; hibernate?: boolean; patch: Json }
  /** the broker's reply to a hibernate: an error, or another endpoint */
  hibernateFails?: "error" | "other"
  agentsFail?: boolean
  steps: Step[]
  check?: (seen: Seen) => void
}

type World = { root: string; agents: Json[]; writeEntries(entries: Json[]): void }
type Seen = { outputs: { code: number; stdout: string; stderr: string }[]; calls: Json[]; requests: Json[]; files: Record<string, string> }

function fakeBroker(path: string, world: World, scenario: Scenario, requests: Json[]): Promise<Server> {
  const called = () => {
    const name = scenario.after?.call
    return name !== undefined && existsSync(join(world.root, "calls.log")) && readFileSync(join(world.root, "calls.log"), "utf8").includes(`"argv":["${name}"`)
  }
  const reply = (socket: Socket, id: unknown, method: string, params: Json) => {
    const send = (message: Json) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...message })}\n`)
    requests.push({ method, params })
    if (method === "hello") return send({ result: {} })
    if (method === "agents") {
      if (scenario.agentsFail) return send({ error: { code: "internal", message: "the database is locked" } })
      if (called()) for (const one of world.agents) if (one.id === "worker-id") Object.assign(one, scenario.after!.patch)
      return send({ result: { agents: world.agents } })
    }
    if (method === "hibernate") {
      if (scenario.hibernateFails === "error") return send({ error: { code: "not_found", message: "no such endpoint" } })
      const target = world.agents.find((one) => one.id === params.id)
      if (target) target.hibernate = params.wake === "none" ? null : params.wake
      if (target && scenario.after?.hibernate) Object.assign(target, scenario.after.patch)
      return send({ result: { endpoint: { id: scenario.hibernateFails === "other" ? "someone-else" : params.id } } })
    }
    return send({ error: { code: "unknown", message: `unknown method ${method}` } })
  }
  return new Promise((done) => {
    const server = createServer((socket) => {
      let buffered = ""
      socket.on("error", () => {})
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8")
        for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
          const message = JSON.parse(buffered.slice(0, end)) as { id: unknown; method: string; params?: Json }
          buffered = buffered.slice(end + 1)
          reply(socket, message.id, message.method, message.params ?? {})
        }
      })
    })
    server.listen(path, () => done(server))
  })
}

const replaceRoot = (text: string, root: string) => text.replaceAll(root, "<root>").replaceAll(realpathSync(CLI), "<cli>").replaceAll(process.execPath, "<bun>")

/** times the run wrote, which differ between runs, read as a mark; times a scenario gave stay */
function steady(text: string): string {
  return text
    .replace(/"(stoppedAt|removedAt|at)": ?(\d{13})/g, (whole, key: string, ms: string) =>
      Math.abs(Date.now() - Number(ms)) < 120_000 ? `"${key}":"<now>"` : whole,
    )
    .replace(/idle \d+ s of/g, "idle N s of")
}

function snapshot(dir: string, root: string, at = ""): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const relative = `${at}${name}`
    const stat = lstatSync(path)
    if (stat.isSocket()) continue
    if (stat.isSymbolicLink()) files[relative] = `-> ${replaceRoot(readlinkSync(path), root)}`
    else if (stat.isDirectory()) Object.assign(files, snapshot(path, root, `${relative}/`))
    else {
      let text = readFileSync(path, "utf8")
      if (name === "claude-bg-task.json") {
        const task = JSON.parse(text) as { seen: string[] }
        task.seen.sort()
        text = JSON.stringify(task)
      }
      files[relative] = `${(stat.mode & 0o777).toString(8)} ${steady(replaceRoot(text, root))}`
    }
  }
  return files
}

const logRoute = process.env.SCP_ROUTE_LOG

async function run(scenario: Scenario, engine: "ts" | "native"): Promise<Seen> {
  const root = realpathSync(mkdtempSync("/tmp/bg-diff-"))
  const bin = join(root, "bin")
  const state = join(root, "state")
  const bg = join(state, "claude-bg")
  for (const dir of [bin, join(root, "work"), join(root, "config", "scp"), join(root, "claude", "projects", "p")]) mkdirSync(dir, { recursive: true })
  mkdirSync(bg, { recursive: true, mode: 0o700 })
  const expand = (value: unknown) => JSON.stringify(value).replaceAll("<root>", root)
  const world: World = {
    root,
    agents: JSON.parse(expand(scenario.agents ?? [])) as Json[],
    writeEntries: (entries) => writeFileSync(join(root, "claude-state.json"), expand(entries)),
  }
  world.writeEntries(scenario.entries ?? [])
  if (!scenario.noClaude) writeFileSync(join(bin, "claude"), FAKE_CLAUDE, { mode: 0o755 })
  writeFileSync(join(bin, "ps"), FAKE_PS, { mode: 0o755 })
  writeFileSync(join(root, "ps-table"), scenario.ps ?? "")
  if (scenario.config) writeFileSync(join(root, "config", "scp", "config.json"), JSON.stringify(scenario.config), { mode: 0o600 })
  for (const [name, text] of Object.entries(scenario.files ?? {})) {
    mkdirSync(join(root, name, ".."), { recursive: true })
    writeFileSync(join(root, name), text.replaceAll("<root>", root))
  }
  for (const [id, config] of Object.entries(scenario.records ?? {})) {
    const file = `0123456789abcde${id[0]}.json`
    writeFileSync(join(bg, file), `${JSON.stringify(JSON.parse(expand(config)), null, 2)}\n`, { mode: 0o600 })
    symlinkSync(file, join(bg, `${id}.json`))
  }
  for (const [id, value] of Object.entries(scenario.states ?? {}))
    writeFileSync(join(bg, `${id}.state.json`), typeof value === "string" ? value : `${JSON.stringify(JSON.parse(expand(value)), null, 2)}\n`, { mode: 0o600 })
  const requests: Json[] = []
  const server = scenario.noBroker ? undefined : await fakeBroker(join(state, "relay.sock"), world, scenario, requests)
  const outputs: Seen["outputs"] = []
  for (const step of scenario.steps) {
    step.before?.(world)
    const start = async (argv: string[], on: "ts" | "native") => {
      const direct = on === "native" && argv[0] !== "claude"
      const env: Record<string, string> = {
        HOME: root,
        PATH: `${bin}:/usr/bin:/bin`,
        SCP_DIR: state,
        XDG_CONFIG_HOME: join(root, "config"),
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        TZ: process.env.TZ ?? "UTC",
        SCP_NATIVE: "1",
        SCP_SWARM_BIN: resolve(swarmBinary!),
        ...(on === "ts" ? { SCP_NATIVE_TS: "*" } : {}),
        ...(direct ? { SCP_CLI_ARGV: JSON.stringify(LAUNCH) } : {}),
        ...(logRoute ? { SCP_ROUTE_LOG: logRoute } : {}),
        ...step.env,
      }
      for (const [key, value] of Object.entries(env)) env[key] = value.replaceAll("<root>", root)
      const child = Bun.spawn(direct ? [resolve(swarmBinary!), ...argv] : [...LAUNCH, ...argv], {
        env,
        cwd: join(root, "work"),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      outputs.push({ code, stdout: steady(replaceRoot(stdout, root)), stderr: steady(replaceRoot(stderr, root)) })
    }
    const other = engine === "ts" ? "native" : "ts"
    const alongside = step.alongside
    await Promise.all([start(step.argv, engine), ...(alongside ? [Bun.sleep(alongside.lag).then(() => start(alongside.argv, other))] : [])])
  }
  await new Promise((done) => (server ? server.close(done) : done(undefined)))
  const log = join(root, "calls.log")
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const call = JSON.parse(replaceRoot(line, root)) as { env: Json }
          for (const key of Object.keys(call.env)) if (ENGINE_VARS.has(key)) delete call.env[key]
          return call
        })
    : []
  const seen = {
    outputs,
    calls,
    requests: JSON.parse(steady(replaceRoot(JSON.stringify(requests), root))) as Json[],
    files: { ...snapshot(state, root, "state/"), entries: replaceRoot(readFileSync(join(root, "claude-state.json"), "utf8"), root) },
  }
  rmSync(root, { recursive: true, force: true })
  return seen
}

const argvs = (seen: Seen) => seen.calls.map((call) => (call.argv as string[]).join(" "))
const ran = (seen: Seen, word: string) => argvs(seen).some((line) => line.startsWith(word))

const session = { sessionId: SESSION, cwd: "<root>/work", name: "lane", handle: "w1" }
const unit = { entries: [entry()], agents: [lead(), agent()], records: { [ID]: mcpConfig() } }
const stoppedUnit = { ...unit, entries: [stopped()] }
const longAgo = 1_700_000_000_000
const helpers = "  4200     1 claude bg-pty-host\n  4242  4200 claude bg-spare\n  4300  4242 node /opt/scp/cli.js mcp\n"
const bashTool = `${helpers}  4400  4242 /bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && eval 'bash suite.sh' < /dev/null && pwd -P >| /tmp/c-cwd\n  4401  4400 bash suite.sh\n`
const lstart = (ms: number) => {
  const [day, month, date, year, time] = new Date(ms).toString().split(" ")
  return `${day} ${month} ${String(Number(date)).padStart(2)} ${time} ${year}`
}
const loop = `while true; do out=$(swarm inbox --wait 50 2>&1); echo "$out"; done`
const polling = () =>
  `${helpers}  4500  4242 ${lstart(Date.now() - 1_800_000)}     /bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1-a.sh && eval '${loop}' < /dev/null && pwd -P >| /tmp/claude-ab12-cwd\n  4501  4500 ${lstart(Date.now() - 1000)} node /opt/scp/bin/swarm inbox --wait 50\n`
const prune = (...flags: string[]): Step => ({ argv: ["claude", "prune", ...flags] })
const ls = (...flags: string[]): Step => ({ argv: ["claude", "ls", ...flags] })
const task: Step = { argv: ["claude-bg-task"] }
const wake = (env: Record<string, string> = {}): Step => ({
  argv: ["claude-wake"],
  env: { SCP_WAKE_REF: SESSION, SCP_WAKE_ENDPOINT: "me/w1", SCP_WAKE_HANDLE: "w1", SCP_WAKE_TICKET: TICKET, ...env },
})
const revive = (extra: string[] = []) =>
  JSON.stringify({ via: "claude-bg", harness: "claude-code", session: SESSION, cwd: "<root>/work", argv: ["claude", "--bg", "--resume", SESSION, ...extra] })
const transcript = { [`claude/projects/p/${SESSION}.jsonl`]: "{}\n" }

const SCENARIOS: Scenario[] = [
  { name: "ls with nothing", steps: [ls(), ls("--json"), ls("--all")] },
  {
    name: "ls with roles, policy and every format",
    entries: [
      entry({ id: "ffffffff", sessionId: "lead-session", name: "boss", status: "busy" }),
      entry(),
      stopped({ id: ID2, sessionId: SESSION2, name: undefined, status: undefined }),
      entry({ kind: "interactive", id: "cccccccc" }),
      entry({ id: "dddddddd", sessionId: "unknown", cwd: undefined, state: undefined }),
    ],
    agents: [lead(), agent(), agent({ id: "w2", address: "me/w2", handle: "w2", harness_session: SESSION2, state: "working" })],
    records: { [ID]: mcpConfig(), [ID2]: mcpConfig({ SCP_NAME: "w2" }) },
    steps: [ls(), ls("--all"), ls("--json"), ls("--all", "--json")],
    check: (seen) => expect(seen.outputs[2]!.stdout).toContain('"role":"orchestrator"'),
  },
  { name: "ls with no broker", ...unit, noBroker: true, steps: [ls(), ls("--json")] },
  { name: "ls with no process table", ...unit, files: { "fail-ps": "" }, steps: [ls("--json")] },
  { name: "ls with bad flags", steps: [ls("--bogus"), ls("x")] },
  { name: "ls with no claude", noClaude: true, steps: [ls(), prune()] },
  { name: "ls when claude fails", files: { "fail-agents": "boom" }, steps: [ls(), prune()] },
  { name: "ls when claude adds to its output", ...unit, files: { "agents-noise": "" }, steps: [ls()] },
  { name: "a dry run acts on nothing", ...unit, steps: [prune("--dry-run")], check: (seen) => expect(ran(seen, "stop")).toBe(false) },
  {
    name: "prune stops and removes a finished worker",
    ...unit,
    ps: helpers,
    steps: [prune()],
    check: (seen) => expect(argvs(seen).filter((line) => /^(stop|rm)/.test(line))).toEqual([`stop ${ID}`, `rm ${ID}`]),
  },
  {
    name: "prune keeps it listed with remove historic",
    ...unit,
    steps: [{ ...prune(), env: { SCP_CLAUDE_BG_REMOVE: "historic" } }],
    check: (seen) => expect(ran(seen, "rm")).toBe(false),
  },
  { name: "prune --stop-only", ...unit, steps: [prune("--stop-only")], check: (seen) => expect(ran(seen, "rm")).toBe(false) },
  {
    name: "prune --older-than replaces the thresholds",
    ...unit,
    agents: [lead(), agent({ state: "working" })],
    steps: [prune("--older-than", "2h"), prune("--older-than=30m")],
    check: (seen) => expect(ran(seen, "rm")).toBe(true),
  },
  {
    name: "prune with bad flags",
    steps: [prune("--older-than"), prune("--older-than=x"), prune("--older-than", "0"), prune("--bogus"), prune("--unhibernate-unrecorded", "--stop-only")],
  },
  { name: "prune with no broker", ...unit, noBroker: true, steps: [prune()] },
  { name: "prune with no process table", ...unit, files: { "fail-ps": "" }, steps: [prune()] },
  {
    name: "a refused rm is recorded, and prune tries it again",
    ...stoppedUnit,
    files: { "fail-rm": "cannot remove: unpushed commits; pass --discard-unpushed abc@wt" },
    states: { [ID]: { ...session, stoppedAt: longAgo } },
    steps: [prune(), prune()],
    check: (seen) => {
      expect(argvs(seen).filter((line) => line.startsWith("rm"))).toEqual([`rm ${ID}`, `rm ${ID}`])
      expect(seen.files[`state/claude-bg/${ID}.state.json`]).toContain("rmRefused")
    },
  },
  {
    name: "a failed stop unhibernates and takes its state back",
    ...unit,
    files: { "fail-stop": "cannot stop" },
    steps: [prune()],
    check: (seen) => expect(seen.requests.some((one) => (one.params as Json).wake === "none")).toBe(true),
  },
  {
    name: "a failed stop restores the state it found",
    ...unit,
    files: { "fail-stop": "" },
    states: { [ID]: { ...session, future: 1, stoppedAt: longAgo } },
    steps: [prune()],
  },
  {
    name: "a planned worker a claude attach holds is kept",
    ...unit,
    ps: `${helpers}  9000 1 /opt/claude attach ${ID}\n`,
    steps: [prune()],
    check: (seen) => expect(ran(seen, "stop")).toBe(false),
  },
  { name: "a worker running a command is kept", ...unit, ps: bashTool, steps: [prune(), ls("--json")], check: (seen) => expect(ran(seen, "stop")).toBe(false) },
  { name: "a worker that only polls its inbox stops", ...unit, ps: polling(), entries: [entry({ status: "busy" })], steps: [prune()] },
  { name: "a polling worker with unread mail is kept", ...unit, ps: polling(), agents: [lead(), agent({ unread: true })], steps: [prune()] },
  {
    name: "a root is never touched",
    ...unit,
    agents: [agent({ parent: null })],
    steps: [prune(), prune("--older-than", "1s")],
    check: (seen) => expect(ran(seen, "stop")).toBe(false),
  },
  { name: "a worker with live workers is kept", ...unit, agents: [lead(), agent({ children: 1 })], steps: [prune()] },
  {
    name: "the caller's own session is kept",
    ...unit,
    steps: [{ ...prune(), env: { CLAUDE_CODE_SESSION_ID: SESSION } }],
    check: (seen) => expect(ran(seen, "stop")).toBe(false),
  },
  { name: "a session swarm did not start is kept", ...unit, records: {}, steps: [prune()] },
  {
    name: "a session with no usable session id",
    ...unit,
    entries: [entry({ sessionId: "nope" })],
    agents: [lead(), agent({ harness_session: "nope" })],
    steps: [prune()],
  },
  {
    name: "an orphan leaves the list, a root's stays",
    entries: [stopped(), stopped({ id: ID2, sessionId: SESSION2 })],
    agents: [],
    records: { [ID]: mcpConfig(), [ID2]: mcpConfig({ SCP_NAME: "w2", SCP_GRANT: "" }) },
    steps: [prune()],
    check: (seen) => expect(argvs(seen).filter((line) => line.startsWith("rm"))).toEqual([`rm ${ID}`]),
  },
  { name: "a refused orphan removal is recorded", entries: [stopped()], records: { [ID]: mcpConfig() }, files: { "fail-rm": "no" }, steps: [prune()] },
  {
    name: "a worktree session stops but stays until historic",
    ...unit,
    entries: [entry({ cwd: "<root>/repo/.claude/worktrees/l" })],
    steps: [prune()],
    check: (seen) => expect(ran(seen, "rm")).toBe(false),
  },
  {
    name: "unread mail racing the stop runs the waker",
    ...unit,
    after: {
      call: "stop",
      patch: { unread: true, unread_at: new Date(Date.now() + 60_000).toISOString(), mail_at: new Date(Date.now() + 60_000).toISOString() },
    },
    steps: [prune()],
    check: (seen) => expect(seen.outputs[0]!.stdout).toContain("mail raced the stop"),
  },
  {
    name: "read mail racing the stop respawns it",
    ...unit,
    after: { call: "stop", patch: { mail_at: new Date(Date.now() + 60_000).toISOString() } },
    steps: [prune()],
    check: (seen) => expect(ran(seen, "respawn")).toBe(true),
  },
  {
    name: "a failed respawn after the race hibernates again",
    ...unit,
    files: { "fail-respawn": "nope" },
    after: { call: "stop", patch: { mail_at: new Date(Date.now() + 60_000).toISOString() } },
    steps: [prune()],
  },
  {
    name: "work arriving after the hibernation aborts the stop",
    ...unit,
    after: { hibernate: true, patch: { worked_at: new Date(Date.now() + 60_000).toISOString() } },
    steps: [prune()],
    check: (seen) => expect(ran(seen, "stop")).toBe(false),
  },
  { name: "a refused hibernation stops nothing", ...unit, hibernateFails: "error", steps: [prune()], check: (seen) => expect(ran(seen, "stop")).toBe(false) },
  {
    name: "an address another endpoint took stops nothing",
    ...unit,
    hibernateFails: "other",
    steps: [prune()],
    check: (seen) => expect(ran(seen, "stop")).toBe(false),
  },
  { name: "a broker failing on agents", ...unit, agentsFail: true, steps: [prune(), ls(), task] },
  {
    name: "a session another live run holds is left alone",
    ...unit,
    files: { [`state/claude-bg/${ID}.lock`]: `{"pid":${process.pid}}\n` },
    steps: [prune()],
    check: (seen) => {
      expect(seen.outputs[0]!.stdout).toContain("another claude-bg run")
      expect(ran(seen, "stop")).toBe(false)
    },
  },
  {
    name: "a dead run's lock is taken over",
    ...unit,
    files: { [`state/claude-bg/${ID}.lock`]: '{"pid":2147483646}\n' },
    steps: [prune()],
    check: (seen) => expect(ran(seen, "stop")).toBe(true),
  },
  {
    name: "settings from config.json",
    ...unit,
    config: { claude_bg: { stop_after_s: "2h", idle_after_s: "3h", remove: "historic" } },
    steps: [prune(), ls("--json")],
  },
  {
    name: "settings from the environment over config.json",
    ...unit,
    config: { claude_bg: { stop_after_s: "2h" } },
    steps: [{ ...prune(), env: { SCP_CLAUDE_BG_STOP_AFTER_S: "30m", SCP_CLAUDE_BG_REMOVE: "0" } }],
  },
  {
    name: "unhibernate-unrecorded clears only sessions swarm did not start",
    entries: [entry(), stopped({ id: ID2, sessionId: SESSION2 })],
    agents: [agent({ hibernate: "claude-bg" }), agent({ id: "w2", address: "me/w2", handle: "w2", harness_session: SESSION2, hibernate: "claude-bg" })],
    records: { [ID]: mcpConfig() },
    steps: [prune("--unhibernate-unrecorded", "--dry-run"), prune("--unhibernate-unrecorded")],
  },
  { name: "the task with nothing to do never runs claude", steps: [task, task], check: (seen) => expect(seen.calls).toEqual([]) },
  { name: "the task with no broker", ...unit, noBroker: true, steps: [task] },
  {
    name: "the task lists once for a root, then not again",
    agents: [agent({ parent: null, worked_at: new Date().toISOString() })],
    steps: [task, task, task],
    check: (seen) => expect(argvs(seen).length).toBe(1),
  },
  {
    name: "the task stops and removes a finished worker and remembers it",
    ...unit,
    steps: [task, task],
    check: (seen) => expect(ran(seen, "rm")).toBe(true),
  },
  {
    name: "the task keeps a stopped worker with remove historic, then removes it once historic",
    ...unit,
    steps: [
      { ...task, env: { SCP_CLAUDE_BG_REMOVE: "historic" } },
      { ...task, env: { SCP_CLAUDE_BG_REMOVE: "historic" } },
      {
        ...task,
        env: { SCP_CLAUDE_BG_REMOVE: "historic" },
        before: (world) => {
          for (const one of world.agents) one.historic = one.id === "worker-id"
        },
      },
    ],
  },
  {
    name: "the task removes an orphan once",
    entries: [stopped()],
    agents: [lead()],
    records: { [ID]: mcpConfig() },
    steps: [task, task],
    check: (seen) => expect(argvs(seen).filter((line) => line.startsWith("rm"))).toEqual([`rm ${ID}`]),
  },
  { name: "the task holds a refused removal", ...stoppedUnit, files: { "fail-rm": "refused" }, steps: [task, task, task] },
  { name: "the task skips a run with no process table", ...unit, files: { "fail-ps": "" }, steps: [task] },
  { name: "the task skips a run when claude fails", ...unit, files: { "fail-agents": "x" }, steps: [task, task] },
  {
    name: "the task wakes the hibernation of a session swarm did not start once it runs",
    entries: [entry()],
    agents: [agent({ hibernate: "claude-bg" })],
    steps: [task, task],
  },
  {
    name: "the task reads an old task file",
    ...unit,
    files: { "state/claude-bg-task.json": `{"sessions":[["${SESSION}","${ID}"]],"seen":["${ID}"],"stopped":[],"listed":true}\n` },
    steps: [task],
  },
  { name: "the task survives a broken task file", ...unit, files: { "state/claude-bg-task.json": "{" }, steps: [task] },
  { name: "wake declines a ref that names no session", steps: [wake({ SCP_WAKE_REF: "not-a-session" }), wake({ SCP_WAKE_REF: "" })] },
  { name: "wake refuses a malformed ticket", ...stoppedUnit, steps: [wake({ SCP_WAKE_TICKET: "nope" })] },
  { name: "wake with no claude", ...stoppedUnit, noClaude: true, steps: [wake()] },
  { name: "wake when claude fails", ...stoppedUnit, files: { "fail-agents": "x" }, steps: [wake()] },
  { name: "wake of a session it knows nothing of", entries: [stopped()], steps: [wake()] },
  {
    name: "wake respawns a stopped session with its ticket armed",
    ...stoppedUnit,
    states: { [ID]: session },
    steps: [wake()],
    check: (seen) => {
      expect(ran(seen, "respawn")).toBe(true)
      expect(Object.values(seen.files).join("")).toContain(TICKET)
    },
  },
  {
    name: "wake takes a stale ticket out when none is given",
    ...stoppedUnit,
    records: { [ID]: mcpConfig({ SCP_WAKE_TICKET: TICKET, SCP_HARNESS_ORIGIN: SESSION }) },
    states: { [ID]: session },
    steps: [wake({ SCP_WAKE_TICKET: "" })],
  },
  {
    name: "wake leaves a config that already says so",
    ...stoppedUnit,
    records: { [ID]: mcpConfig({ SCP_WAKE_TICKET: TICKET }) },
    states: { [ID]: session },
    steps: [wake()],
  },
  {
    name: "wake of a live session only arms it",
    ...unit,
    states: { [ID]: session },
    steps: [wake()],
    check: (seen) => expect(ran(seen, "respawn")).toBe(false),
  },
  { name: "wake reports a failed respawn", ...stoppedUnit, states: { [ID]: session }, files: { "fail-respawn": "nope\nmore" }, steps: [wake()] },
  {
    name: "wake resumes a removed session in its own directory",
    records: { [ID]: mcpConfig() },
    states: { [ID]: { ...session, stoppedAt: longAgo, removedAt: longAgo } },
    files: transcript,
    steps: [wake()],
    check: (seen) => expect(ran(seen, "--bg --resume")).toBe(true),
  },
  {
    name: "wake resumes with a revive record ref",
    records: { [ID]: mcpConfig() },
    states: { [ID]: session },
    files: transcript,
    steps: [wake({ SCP_WAKE_REF: revive(["--name", "lane"]) })],
  },
  {
    name: "wake drops a name that would read as an option",
    records: { [ID]: mcpConfig() },
    states: { [ID]: { ...session, name: "-x" } },
    files: transcript,
    steps: [wake()],
  },
  { name: "wake resumes a session with no record", states: { [ID]: session }, files: transcript, steps: [wake()] },
  { name: "wake reports a failed resume", states: { [ID]: session }, files: { ...transcript, "fail---bg": "boom" }, steps: [wake()] },
  {
    name: "a resume under a new id is followed, and the next wake finds it",
    records: { [ID]: mcpConfig() },
    states: { [ID]: session },
    files: { ...transcript, fork: `${ID2}-0000-4000-8000-000000000002` },
    steps: [
      wake(),
      {
        ...wake(),
        before: (world) => world.writeEntries([stopped({ id: ID2, sessionId: SESSION2 })]),
      },
    ],
    check: (seen) => expect(seen.files[`state/claude-bg/${ID}.state.json`]).toContain("movedTo"),
  },
  {
    name: "wake declines when the directory is gone",
    records: { [ID]: mcpConfig() },
    states: { [ID]: { ...session, cwd: "<root>/gone" } },
    files: transcript,
    steps: [wake()],
  },
  { name: "wake declines when the transcript is gone", records: { [ID]: mcpConfig() }, states: { [ID]: session }, steps: [wake()] },
  {
    name: "wake refuses another endpoint's session",
    ...stoppedUnit,
    states: { [ID]: session },
    steps: [wake({ SCP_WAKE_HANDLE: "other" }), wake({ SCP_WAKE_ENDPOINT: "me/other" })],
  },
  {
    name: "wake reads a session its hooks reported",
    entries: [stopped()],
    states: { [ID]: { sessionId: SESSION, cwd: "<root>/work" } },
    steps: [wake({ SCP_WAKE_SESSION: SESSION }), wake({ SCP_WAKE_SESSION: SESSION2 })],
  },
  { name: "wake refuses a listed session under another session id", entries: [stopped({ sessionId: SESSION2 })], states: { [ID]: session }, steps: [wake()] },
  {
    name: "wake refuses a record of another harness",
    ...stoppedUnit,
    states: { [ID]: session },
    steps: [wake({ SCP_WAKE_REF: revive().replace("claude-code", "codex") })],
  },
  {
    name: "wake re-points a record whose command is gone",
    ...stoppedUnit,
    records: {
      [ID]: mcpConfig(
        { SCP_NATIVE: "1", SCP_SWARM_BIN: "/gone/swarm", SCP_CLI_ARGV: "[]" },
        { command: "/gone/swarm", args: ["mcp", "--harness", "claude", "--channels"] },
      ),
    },
    states: { [ID]: session },
    steps: [wake()],
  },
  {
    name: "wake pins a saved native mode under SCP_NATIVE=mcp",
    ...stoppedUnit,
    records: { [ID]: mcpConfig({ SCP_NATIVE: "1" }) },
    states: { [ID]: session },
    steps: [wake({ SCP_NATIVE: "mcp" })],
  },
  { name: "wake fails on a config it cannot read", entries: [stopped()], records: { [ID]: { notServers: true } }, states: { [ID]: session }, steps: [wake()] },
  {
    name: "wake strips the launcher's identity from claude",
    ...stoppedUnit,
    states: { [ID]: session },
    steps: [
      {
        ...wake({
          SCP_NAME: "x",
          SCP_GRANT: "krt_y",
          SCP_SESSION: "s",
          CLAUDE_CODE_SESSION_ID: SESSION2,
          CLAUDE_BG_SOURCE: "z",
          SCP_CHANNELS: "1",
          SCP_KEEP: "yes",
          CLAUDE_OTHER: "yes",
        }),
      },
    ],
    check: (seen) => expect(JSON.stringify(seen.calls)).toContain("SCP_KEEP"),
  },
]

describe.skipIf(!swarmBinary)("claude-bg: the native swarm against this CLI", () => {
  for (const scenario of SCENARIOS)
    test(scenario.name, async () => {
      const ts = await run(scenario, "ts")
      const native = await run(scenario, "native")
      expect(native).toEqual(ts)
      scenario.check?.(ts)
    }, 60_000)

  for (const [first, second] of [
    ["native", "ts"],
    ["ts", "native"],
  ] as const)
    test(`a ${second} run overlapping a ${first} run on one session leaves it to the first`, async () => {
      const seen = await run({ ...unit, files: { "slow-stop": "" }, steps: [{ ...prune(), alongside: { argv: ["claude", "prune"], lag: 700 } }] }, first)
      expect(argvs(seen).filter((line) => line.startsWith("stop"))).toEqual([`stop ${ID}`])
      expect(argvs(seen).filter((line) => line.startsWith("rm"))).toEqual([`rm ${ID}`])
      expect(seen.outputs.map((one) => one.stdout).join("")).toContain("another claude-bg run is acting on it")
      expect(seen.files[`state/claude-bg/${ID}.state.json`]).toContain("removedAt")
      expect(Object.keys(seen.files).filter((name) => /\.(tmp|lock|stale)$/.test(name))).toEqual([])
    }, 60_000)
})
