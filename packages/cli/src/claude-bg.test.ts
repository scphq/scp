import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BrokerTaskContext, RelayClient, startBroker } from "@scp-dev/broker"
import type { LocalAgent } from "@scp-dev/core"
import { bgDir } from "./claude"
import { SELF } from "./term"
import {
  type BgState,
  type ClaudeEntry,
  type PlanInput,
  ancestorsOf,
  attachTargets,
  bgConfig,
  claudeBgCommand,
  claudeBgTask,
  claudeWakeCommand,
  historicAfterS,
  idleAfterS,
  spawnIdleAfterS,
  plan,
  readRecords,
  readState,
  onlyPollsInbox,
  pollsInbox,
  runsCommand,
  refSession,
  reviveRef,
} from "./claude-bg"

const id = "1a2b3c4d"
const sessionId = `${id}-0000-4000-8000-000000000001`
const now = Date.parse("2030-01-02T00:00:00Z")
const cleanups: (() => void | Promise<void>)[] = []
/** a session's process tree with only its helpers: the pty host above it, MCP servers, a hook, and another session's Bash tool shell */
const helpers = [
  "  4200     1 claude bg-pty-host --bg-pty-host /tmp/d/a.pty.sock 200 50 -- /opt/claude --bg-spare /tmp/d/a.claim",
  "  4242  4200 claude bg-spare --bg-spare /tmp/d/a.claim.sock",
  "  4300  4242 node /opt/scp/cli.js mcp --harness claude --channels",
  "  4301  4242 bun packages/notes/mcp/src/index.ts",
  "  4302  4242 caffeinate -i -t 300",
  "  4303  4242 /bin/sh -c /opt/hooks/on-stop.sh",
  "  5000  4999 /bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-9-b.sh 2>/dev/null || true && eval 'sleep 600'",
  "",
].join("\n")
/** the same tree with a Bash tool command still running under the session */
const running = `${helpers}  4400  4242 /bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && eval 'bash suite.sh' < /dev/null && pwd -P >| /tmp/c-cwd
  4401  4400 bash suite.sh
`
const loop = `while true; do out=$(swarm inbox --wait 50 2>&1); if echo "$out" | grep -q "relay-message"; then echo "$out"; break; fi; echo "$out" | grep -q "no unread messages" || sleep 10; done`
const shell = (command: string) =>
  `/bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && eval '${command.replaceAll("'", `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-ab12-cwd`
/** `ps` `lstart` in the C locale */
const lstart = (ms: number) => {
  const [day, month, date, year, time] = new Date(ms).toString().split(" ")
  return `${day} ${month} ${String(Number(date)).padStart(2)} ${time} ${year}`
}
/** the tree with only an inbox poll loop running under the session, waiting on the inbox, started `started` ms ago */
const pollingSince = (started: number) => `${helpers}  4500  4242 ${lstart(now - started)}     ${shell(loop)}
  4501  4500 ${lstart(now - 1000)} node /opt/scp/bin/swarm inbox --wait 50
`
/** a loop the turn started after the endpoint's last hook (`agent()` worked an hour ago) */
const polling = pollingSince(1_800_000)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** a message queued for it now and still unread */
function mail(facts: LocalAgent): void {
  facts.unread = true
  facts.unread_at = facts.mail_at = new Date(now).toISOString()
}

function agent(overrides: Partial<LocalAgent> = {}): LocalAgent {
  return {
    id: "worker-id",
    address: "me/w1",
    handle: "w1",
    harness: null,
    cwd: null,
    parent: "me/lead",
    children: 0,
    subagents: 0,
    harness_session: sessionId,
    harness_origin: null,
    state: "done",
    presence: "online",
    historic: false,
    worked_at: new Date(now - 3_600_000).toISOString(),
    mail_at: null,
    connections: 1,
    hibernate: null,
    unread: false,
    unread_at: null,
    handed_back: false,
    ...overrides,
  }
}
const entry = (overrides: Partial<ClaudeEntry> = {}): ClaudeEntry => ({
  id,
  sessionId,
  cwd: "/work",
  kind: "background",
  name: "lane",
  state: "working",
  pid: 4242,
  status: "idle",
  ...overrides,
})
function stoppedEntry(overrides: Partial<ClaudeEntry> = {}): ClaudeEntry {
  const value = entry({ state: "stopped", ...overrides })
  delete value.pid
  return value
}
function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    entries: [entry()],
    agents: [agent()],
    records: new Map([[id, { file: "/record.json", handle: "w1" }]]),
    states: new Map(),
    attached: new Set(),
    processes: helpers,
    now,
    config: { stopAfterS: 600, idleAfterS: 600, remove: "historic" },
    ...overrides,
  }
}

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "bg-test-")))
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  const bin = join(home, "bin")
  mkdirSync(bin)
  const env: { HOME: string; SCP_DIR: string; XDG_CONFIG_HOME: string; PATH: string; SCP_CLAUDE_BG_REMOVE?: string } = {
    HOME: home,
    SCP_DIR: join(home, "state"),
    XDG_CONFIG_HOME: join(home, "config"),
    PATH: `${bin}:/usr/bin:/bin`,
    SCP_CLAUDE_BG_REMOVE: "historic",
  }
  mkdirSync(bgDir(env), { recursive: true })
  const stateFile = join(home, "claude-state.json")
  const callsFile = join(home, "calls.log")
  const save = (entries: ClaudeEntry[]) => writeFileSync(stateFile, JSON.stringify(entries))
  save([entry({ cwd: home })])
  writeFileSync(
    join(bin, "claude"),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const root = process.env.HOME;
const file = root + "/claude-state.json";
const argv = process.argv.slice(2);
appendFileSync(root + "/calls.log", JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
let entries = JSON.parse(readFileSync(file, "utf8"));
const [command, id] = argv;
if (command === "agents") {
  console.log(JSON.stringify(argv.includes("--all") ? entries : entries.filter(e => e.pid !== undefined)));
  process.exit(0);
}
const entry = entries.find(e => e.id === id);
if (command === "stop") {
  delete entry.pid;
  entry.state = "stopped";
  console.log("stopped " + id);
} else if (command === "rm") {
  if (existsSync(root + "/rm-refuse")) {
    console.error("cannot remove " + id + ": unpushed commits; pass --discard-unpushed abc123@wt-1 to discard them");
    process.exit(1);
  }
  entries = entries.filter(e => e.id !== id);
  console.log("removed " + id);
} else if (command === "respawn") {
  if (existsSync(root + "/respawn-fail")) {
    console.error("cannot respawn " + id);
    process.exit(1);
  }
  Object.assign(entry, { pid: 4242, state: "working", status: "idle" });
  console.log("respawned " + id);
} else if (command === "--bg") {
  const sessionId = existsSync(root + "/fork") ? readFileSync(root + "/fork", "utf8").trim() : argv[argv.indexOf("--resume") + 1];
  const id = sessionId.slice(0, 8);
  entries.push({ id, sessionId, kind: "background", cwd: process.cwd(), name: argv[argv.indexOf("--name") + 1], pid: 4242, state: "working", status: "idle" });
  console.log("backgrounded · " + id);
} else process.exit(2);
writeFileSync(file, JSON.stringify(entries));
`,
    { mode: 0o755 },
  )
  const calls = (): { argv: string[]; cwd: string }[] =>
    existsSync(callsFile)
      ? readFileSync(callsFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : []
  const record = (short = id, handle = "w1", grant = "") => {
    const file = join(bgDir(env), `${crypto.randomUUID()}.json`)
    writeFileSync(file, JSON.stringify({ mcpServers: { scp: { env: { SCP_NAME: handle, SCP_GRANT: grant } } } }), { mode: 0o600 })
    symlinkSync(file, join(bgDir(env), `${short}.json`))
    return file
  }
  const state = (overrides: Partial<BgState> = {}) => {
    const value = { sessionId, cwd: home, name: "lane", handle: "w1", ...overrides }
    writeFileSync(join(bgDir(env), `${id}.state.json`), JSON.stringify(value))
    return value
  }
  let facts = agent()
  const events: unknown[][] = []
  let onHibernate = () => {}
  let onAgents = () => {}
  const context: BrokerTaskContext = {
    agents() {
      events.push(["agents"])
      onAgents()
      return [{ ...facts }]
    },
    hibernate(endpoint, provider, ref) {
      events.push(["hibernate", endpoint, provider, ref, calls().some((call) => call.argv[0] === "stop")])
      facts.hibernate = provider
      onHibernate()
    },
    unhibernate(endpoint) {
      events.push(["unhibernate", endpoint])
      facts.hibernate = null
    },
    kick(endpoint) {
      events.push(["kick", endpoint])
    },
    log(line) {
      events.push(["log", line])
    },
  }
  const deps: { ps: () => Promise<string | null>; ancestors: () => Promise<Set<number> | null>; now: () => number } = {
    ps: async () => "",
    ancestors: async () => new Set([process.pid]),
    now: () => now,
  }
  return {
    home,
    env,
    callsFile,
    save,
    calls,
    record,
    state,
    context,
    events,
    deps,
    get facts() {
      return facts
    },
    set facts(value: LocalAgent) {
      facts = value
    },
    set onHibernate(fn: () => void) {
      onHibernate = fn
    },
    set onAgents(fn: () => void) {
      onAgents = fn
    },
    run: () => claudeBgTask(env, deps).run(context),
  }
}

describe("planning", () => {
  test("stops a finished idle worker", () => {
    expect(plan(input())).toMatchObject([{ kind: "stop", id }])
  })
  test("stops an idle worker with unread mail, finished or not", () => {
    expect(plan(input({ agents: [agent({ unread: true })] }))).toMatchObject([{ kind: "stop", id }])
    expect(plan(input({ agents: [agent({ unread: true, state: "working" })] }))).toMatchObject([{ kind: "stop", id }])
  })
  const child = (overrides: Partial<LocalAgent> = {}) =>
    agent({ id: "child-id", address: "me/c1", handle: "c1", parent: "me/w1", harness_session: "child-session", state: "working", ...overrides })
  const guards: [string, Partial<PlanInput>][] = [
    ["no SCP endpoint, so nothing could wake it", { records: new Map(), agents: [] }],
    ["no SCP endpoint, so nothing could wake it", { records: new Map(), agents: [agent({ harness_session: null })] }],
    ["no endpoint", { agents: [] }],
    ["a root", { agents: [agent({ parent: null })] }],
    ["a root", { agents: [agent({ parent: null, state: "working" })] }],
    ["not started by swarm claude --bg, so no wake ticket would take its endpoint back", { records: new Map() }],
    ["1 live worker", { agents: [agent({ children: 1 })] }],
    ["1 live worker", { agents: [agent({ children: 1 }), child()] }],
    ["1 live worker", { agents: [agent({ children: 1 }), child({ presence: "offline", state: "working" })] }],
    ["1 live worker", { agents: [agent({ children: 2 }), child({ presence: "offline", state: "done" })] }],
    ["2 live workers", { agents: [agent({ subagents: 2 })] }],
    ["attached", { attached: new Set([id]) }],
    ["attached", { attached: new Set(["lane"]) }],
    ["the caller's own session", { self: new Set([sessionId]) }],
    ["the caller's own session", { selfPids: new Set([1, 4242]) }],
    ["running a background command", { processes: running }],
    ["running a background command", { processes: running, agents: [agent({ historic: true })] }],
    ["ps failed, so running commands are unknown", { processes: null }],
    ["running a background command", { processes: `${polling}  4400  4242 /bin/zsh -c source /s/shell-snapshots/snapshot-zsh-2-b.sh && eval 'sleep 900'\n` }],
    ["busy", { entries: [entry({ status: "busy" })], processes: running.replace("bash suite.sh' <", `${loop}' <`) }],
    ["polling its inbox, which has unread mail", { agents: [agent({ unread: true, unread_at: new Date(now - 1000).toISOString() })], processes: polling }],
    ["polling its inbox, which has unread mail", { entries: [entry({ status: "busy" })], agents: [agent({ unread: true })], processes: polling }],
    ["polling its inbox, idle 1 s of 600 s", { agents: [agent({ worked_at: new Date(now - 1000).toISOString() })], processes: polling }],
    ["waiting", { entries: [entry({ status: "waiting" })], processes: polling }],
    ["busy", { entries: [entry({ status: "busy" })] }],
    ["blocked", { entries: [entry({ status: "blocked" })] }],
    ["waiting", { entries: [entry({ status: "waiting" })] }],
    ["idle 1 s of 600 s", { agents: [agent({ worked_at: new Date(now - 1000).toISOString() })] }],
    ["idle 1 s of 600 s", { agents: [agent({ state: "working", worked_at: new Date(now - 1000).toISOString() })] }],
    [
      "not done, and idle_after_s is Infinity",
      { agents: [agent({ state: "working" })], config: { stopAfterS: 600, idleAfterS: Infinity, remove: "historic" } },
    ],
    ["stop_after_s and idle_after_s are Infinity", { config: { stopAfterS: Infinity, idleAfterS: Infinity, remove: "historic" } }],
    ["idle 3600 s of 7200 s", { config: { stopAfterS: 7200, idleAfterS: 7200, remove: "historic" } }],
  ]
  for (const [index, [reason, overrides]] of guards.entries()) {
    test(`keeps a guarded worker in case ${index + 1}`, () => {
      expect(plan(input(overrides))).toMatchObject([{ kind: "keep", reason }])
    })
  }
  test("treats handed back work as finished", () => {
    const handedBack = { agents: [agent({ state: "working", handed_back: true })] }
    expect(plan(input({ ...handedBack, config: { stopAfterS: 600, idleAfterS: Infinity, remove: "historic" } }))[0]?.kind).toBe("stop")
  })
  test("stops an unfinished idle worker after idle_after_s, and a finished one after the sooner threshold", () => {
    expect(plan(input({ agents: [agent({ state: "working" })] }))).toMatchObject([{ kind: "stop", id }])
    for (const [stopAfterS, idleAfterS] of [
      [7200, 1800],
      [1800, 7200],
    ] as const)
      expect(plan(input({ config: { stopAfterS, idleAfterS, remove: "historic" } }))[0]?.kind).toBe("stop")
    expect(plan(input({ agents: [agent({ state: "working" })], config: { stopAfterS: 1800, idleAfterS: 7200, remove: "historic" } }))).toMatchObject([
      { kind: "keep", reason: "idle 3600 s of 7200 s" },
    ])
  })
  test("stops a worker whose children are historic or offline and not working", () => {
    const children = [child({ historic: true }), child({ id: "c2", address: "me/c2", presence: "offline", state: "done" })]
    expect(plan(input({ agents: [agent({ children: 2 }), ...children] }))).toMatchObject([{ kind: "stop", id }])
    const historic = plan(input({ agents: [agent({ children: 2, historic: true }), ...children] }))
    expect(historic).toMatchObject([{ kind: "remove", id, live: true }])
  })
  test("never stops or removes a session swarm did not start, but clears a stale hibernation once it runs again", () => {
    const unrecorded = input({ records: new Map(), agents: [agent({ state: "working" })] })
    for (const overrides of [{}, { agents: [agent({ historic: true })] }, { agents: [agent({ historic: true })], olderThanS: 60 }])
      expect(plan({ ...unrecorded, ...overrides }).map((action) => action.kind)).toEqual(["keep"])
    expect(plan({ ...unrecorded, agents: [agent({ hibernate: "claude-bg", connections: 1 })] }).map((action) => action.kind)).toEqual(["unhibernate", "keep"])
    expect(plan({ ...unrecorded, agents: [agent({ harness_session: null, handle: "w1" })] })).toMatchObject([{ kind: "keep" }])
  })
  test("ignores interactive sessions and invalid short ids", () => {
    const unnamed = entry()
    delete unnamed.id
    const entries = [unnamed, entry({ kind: "interactive" }), ...["ABCDEF12", "123", "1234567g"].map((id) => entry({ id }))]
    expect(plan(input({ entries }))).toEqual([])
  })
  test("prefers the session over the recorded handle", () => {
    const matched = agent({ id: "session-worker", handle: "w2" })
    const wrong = agent({ harness_session: "another-session", parent: null })
    expect(plan(input({ agents: [wrong, matched] }))).toMatchObject([{ kind: "stop", agent: { id: matched.id } }])
    expect(plan(input({ agents: [wrong] }))).toMatchObject([{ kind: "keep", reason: "no endpoint" }])
    expect(plan(input({ agents: [wrong], records: new Map() }))).toMatchObject([{ kind: "keep", reason: "no SCP endpoint, so nothing could wake it" }])
    expect(plan(input({ agents: [agent({ harness_session: null })] }))[0]?.kind).toBe("stop")
  })
  test("removes historic stopped workers when enabled", () => {
    const stopped = input({ entries: [stoppedEntry()], agents: [agent({ historic: true })] })
    expect(plan(stopped)).toMatchObject([{ kind: "remove", live: false }])
    expect(plan({ ...stopped, config: { stopAfterS: 600, idleAfterS: 600, remove: false } })).toMatchObject([{ kind: "keep", reason: "stopped" }])
    expect(plan({ ...stopped, stopOnly: true })).toMatchObject([{ kind: "keep", reason: "stopped" }])
  })
  test("uses an explicit age instead of finish and configured thresholds", () => {
    const aged = input({ agents: [agent({ state: "working" })], olderThanS: 1800, config: { stopAfterS: Infinity, idleAfterS: Infinity, remove: false } })
    expect(plan({ ...aged, stopOnly: true })[0]?.kind).toBe("stop")
    expect(plan(aged)).toMatchObject([{ kind: "remove", live: true }])
    expect(plan({ ...aged, olderThanS: 7200 })).toMatchObject([{ kind: "keep", reason: "idle 3600 s of 7200 s" }])
  })
  test("removes a live historic worker only once it is idle past its stop threshold", () => {
    const live = input({ agents: [agent({ historic: true })] })
    expect(plan(live)).toMatchObject([{ kind: "remove", live: true }])
    expect(plan({ ...live, agents: [agent({ historic: true, state: "working" })] })).toMatchObject([{ kind: "remove", live: true }])
    const never = { stopAfterS: 600, idleAfterS: Infinity, remove: "historic" } as const
    expect(plan({ ...live, agents: [agent({ historic: true, state: "working" })], config: never })).toMatchObject([
      { kind: "keep", reason: "not done, and idle_after_s is Infinity" },
    ])
    expect(plan({ ...live, config: { ...never, stopAfterS: Infinity } })).toMatchObject([
      { kind: "keep", reason: "stop_after_s and idle_after_s are Infinity" },
    ])
    expect(plan({ ...live, agents: [agent({ historic: true, children: 1 }), child({ historic: true })] })).toMatchObject([{ kind: "remove", id, live: true }])
    expect(plan({ ...live, agents: [agent({ historic: true, children: 1 }), child()] })).toMatchObject([{ kind: "keep", reason: "1 live worker" }])
    expect(plan({ ...live, agents: [agent({ historic: true, parent: null })] })).toMatchObject([{ kind: "keep", reason: "a root" }])
  })
  test("holds a refused removal for one day unless retried", () => {
    const held = input({
      entries: [stoppedEntry()],
      agents: [agent({ historic: true })],
      states: new Map([[id, { sessionId, cwd: "/work", rmRefused: { at: now - 1000, reason: "unpushed" } }]]),
    })
    expect(plan(held)).toMatchObject([{ kind: "keep", reason: "claude rm refused: unpushed" }])
    expect(plan({ ...held, retryRefused: true })[0]?.kind).toBe("remove")
    expect(plan({ ...held, now: now + 86_400_000 })[0]?.kind).toBe("remove")
  })
  test("unhibernates a connected live session", () => {
    expect(plan(input({ agents: [agent({ hibernate: "claude-bg" })] }))[0]).toMatchObject({ kind: "unhibernate", id })
  })
  describe("removing on stop", () => {
    const onStop = { stopAfterS: 600, idleAfterS: 600, remove: "on_stop" } as const
    test("removes a worker where it would stop it, and a stopped one at once, historic or not", () => {
      expect(plan(input({ config: onStop }))).toMatchObject([{ kind: "remove", id, live: true }])
      expect(plan(input({ config: onStop, entries: [stoppedEntry()] }))).toMatchObject([{ kind: "remove", id, live: false }])
      expect(plan(input({ config: onStop, entries: [stoppedEntry({ state: "done" })], agents: [agent({ state: "working" })] }))).toMatchObject([
        { kind: "remove", live: false },
      ])
      const finished = [agent({ children: 1 }), child({ historic: true, presence: "hibernated", state: "done" })]
      expect(plan(input({ config: onStop, entries: [stoppedEntry()], agents: finished }))).toMatchObject([{ kind: "remove", live: false }])
    })
    test("keeps the stop guards and thresholds", () => {
      expect(plan(input({ config: onStop, agents: [agent({ worked_at: new Date(now - 1000).toISOString() })] }))).toMatchObject([
        { kind: "keep", reason: "idle 1 s of 600 s" },
      ])
      const stopped = { config: onStop, entries: [stoppedEntry()] }
      for (const [reason, overrides] of [
        ["a root", { agents: [agent({ parent: null })] }],
        ["1 live worker", { agents: [agent({ children: 1 }), child()] }],
        ["2 live workers", { agents: [agent({ subagents: 2 })] }],
        ["attached", { attached: new Set([id]) }],
        ["the caller's own session", { self: new Set([sessionId]) }],
        ["not started by swarm claude --bg, so no wake ticket would take its endpoint back", { records: new Map() }],
      ] satisfies [string, Partial<PlanInput>][])
        expect(plan(input({ ...stopped, ...overrides }))).toMatchObject([{ kind: "keep", reason }])
      expect(plan(input({ config: onStop, processes: running }))).toMatchObject([{ kind: "keep", reason: "running a background command" }])
    })
    test("only stops with stop only, or while a refused removal is held", () => {
      expect(plan(input({ config: onStop, stopOnly: true }))).toMatchObject([{ kind: "stop", id }])
      expect(plan(input({ config: onStop, entries: [stoppedEntry()], stopOnly: true }))).toMatchObject([{ kind: "keep", reason: "stopped" }])
      const states = new Map([[id, { sessionId, cwd: "/work", rmRefused: { at: now - 1000, reason: "unpushed" } }]])
      expect(plan(input({ config: onStop, states }))).toMatchObject([{ kind: "stop", id }])
      expect(plan(input({ config: onStop, states, entries: [stoppedEntry()] }))).toMatchObject([{ kind: "keep", reason: "claude rm refused: unpushed" }])
    })
    test("removes a session in a claude worktree only once its endpoint is historic, since claude rm takes the worktree", () => {
      const cwd = "/repo/.claude/worktrees/lane"
      expect(plan(input({ config: onStop, entries: [entry({ cwd })] }))).toMatchObject([{ kind: "stop", id }])
      expect(plan(input({ config: onStop, entries: [stoppedEntry({ cwd })] }))).toMatchObject([{ kind: "keep", reason: "in a claude worktree until historic" }])
      expect(plan(input({ config: onStop, entries: [stoppedEntry({ cwd })], agents: [agent({ historic: true })] }))).toMatchObject([
        { kind: "remove", live: false },
      ])
      expect(plan(input({ entries: [stoppedEntry({ cwd })] }))).toMatchObject([{ kind: "keep", reason: "stopped" }])
      expect(plan(input({ config: onStop, entries: [stoppedEntry({ cwd: "/repo/worktrees/lane" })] }))).toMatchObject([{ kind: "remove" }])
    })
    test("keeps a historic worker stopped with remove historic until its endpoint turns historic, and with remove false", () => {
      const stopped = input({ entries: [stoppedEntry()] })
      expect(plan(stopped)).toMatchObject([{ kind: "keep", reason: "stopped" }])
      expect(plan({ ...stopped, config: { ...onStop, remove: false } })).toMatchObject([{ kind: "keep", reason: "stopped" }])
    })
  })
  describe("orphans", () => {
    const parented = new Map([[id, { file: "/record.json", handle: "w1", parented: true }]])
    const orphan = (overrides: Partial<PlanInput> = {}) => input({ entries: [stoppedEntry()], agents: [], records: parented, ...overrides })
    test("removes a stopped worker whose endpoint is gone", () => {
      expect(plan(orphan())).toMatchObject([{ kind: "orphan", id, record: { file: "/record.json" } }])
      expect(plan(orphan({ config: { stopAfterS: 600, idleAfterS: 600, remove: "on_stop" } }))).toMatchObject([{ kind: "orphan", id }])
      expect(plan(orphan({ agents: [agent({ harness_session: "another", handle: "w2" })] }))).toMatchObject([{ kind: "orphan", id }])
    })
    test("keeps a root, a live one, an attached one, the caller's own, a held refusal, and any with remove false or stop only", () => {
      const states = new Map([[id, { sessionId, cwd: "/work", rmRefused: { at: now - 1000, reason: "unpushed" } }]])
      for (const [reason, overrides] of [
        ["no endpoint, and it started as a root", { records: new Map([[id, { file: "/record.json", handle: "w1" }]]) }],
        ["no endpoint", { entries: [entry()] }],
        ["no endpoint", { config: { stopAfterS: 600, idleAfterS: 600, remove: false } }],
        ["no endpoint", { config: { stopAfterS: 600, idleAfterS: 600, remove: false }, olderThanS: 60 }],
        ["no endpoint", { stopOnly: true }],
        ["attached", { attached: new Set(["lane"]) }],
        ["the caller's own session", { self: new Set([sessionId]) }],
        ["claude rm refused: unpushed", { states }],
        ["no SCP endpoint, so nothing could wake it", { records: new Map() }],
      ] satisfies [string, Partial<PlanInput>][])
        expect(plan(orphan(overrides))).toMatchObject([{ kind: "keep", reason }])
      expect(plan(orphan({ states, retryRefused: true }))).toMatchObject([{ kind: "orphan", id }])
    })
  })
})

test("finds a Bash tool command at any depth under a session, never in its helpers or another session", () => {
  expect(runsCommand(helpers, 4242)).toBe(false)
  expect(runsCommand(running, 4242)).toBe(true)
  expect(runsCommand(running.replace("4400  4242", "4400  4301"), 4242)).toBe(true)
  expect(runsCommand(running, 4300)).toBe(false)
  expect(runsCommand("bad line\n4400 4242\n", 4242)).toBe(false)
})

test("tells an inbox poll loop from any command that watches more than mail", () => {
  for (const command of [
    loop,
    "swarm inbox --wait 50",
    `for i in $(seq 1 70); do o=$(swarm inbox --wait=50 --keep --json 2>/dev/null); [ "$o" != "" ] && { echo "$o"; exit 0; }; done; echo idle-timeout`,
    `while :; do node /opt/scp/dist/cli.js inbox --wait 50 | head -5; sleep 5; done`,
    "while true; do timeout 60 swarm inbox --wait 45 --keep --json | grep -q seq && break; done",
  ])
    expect([command, pollsInbox(shell(command))]).toEqual([command, true])
  for (const command of [
    "swarm inbox",
    "bash inbox_wait.sh",
    "while true; do gh pr checks 12 | grep -q pending || break; swarm inbox --wait 50; done",
    "while true; do swarm inbox --wait 50; grep -q done build.log && break; done",
    "until [ -f done ]; do sleep 30; done",
    "while [ ! -f /tmp/build.done ]; do swarm inbox --wait 50; done",
    "while [[ -s out.log ]]; do swarm inbox --wait 50; done",
    "while read -r line; do swarm inbox --wait 50; done < queue.txt",
    "while true; do swarm inbox --wait 50 | grep -q COMPLETE build.log && break; done",
    "while true; do swarm inbox --wait 50 | tail -n 5 out.log; done",
    "swarm send lead hi; swarm inbox --wait 50",
  ])
    expect([command, pollsInbox(shell(command))]).toEqual([command, false])
})

test("finds a session that only polls its inbox, and keeps every other command", () => {
  const ci = `${helpers}  4400  4242 ${shell("while gh run view 7 | grep -q in_progress; do sleep 60; done")}\n  4401  4400 sleep 60\n`
  const script = `${helpers}  4400  4242 ${shell("~/tmp/inbox_wait.sh")}\n  4401  4400 /bin/bash /home/u/tmp/inbox_wait.sh\n  4402  4401 node /opt/scp/bin/swarm inbox --wait 50\n`
  const subshell = polling.replace("  4501  4500", `  4502  4500 ${shell(loop)}\n  4501  4502`)
  expect(onlyPollsInbox(polling, 4242)).toBe(true)
  expect(onlyPollsInbox(subshell, 4242)).toBe(true)
  expect(onlyPollsInbox(polling.replace("swarm inbox --wait 50\n", "python3 -c pass\n"), 4242)).toBe(false)
  expect(onlyPollsInbox(`${polling}  4400  4242 ${shell("bun test")}\n`, 4242)).toBe(false)
  expect(onlyPollsInbox(ci, 4242)).toBe(false)
  expect(onlyPollsInbox(script, 4242)).toBe(false)
  expect(onlyPollsInbox(helpers, 4242)).toBe(false)
  expect(runsCommand(`${helpers}  4400  4242 /bin/zsh -c -l setopt X && eval 'sleep 9' < /dev/null && pwd -P >| /tmp/claude-e367-cwd\n`, 4242)).toBe(true)
  expect(plan(input({ processes: polling }))).toMatchObject([{ kind: "stop", id }])
  expect(plan(input({ processes: polling, entries: [entry({ status: "busy" })] }))).toMatchObject([{ kind: "stop", id }])
  expect(plan(input({ processes: polling, agents: [agent({ unread: true })] }))).toMatchObject([{ kind: "keep" }])
  const beside = pollingSince(7_200_000)
  expect(onlyPollsInbox(beside, 4242)).toBe(true)
  expect(plan(input({ processes: beside }))).toMatchObject([{ kind: "stop", id }])
  expect(plan(input({ processes: beside, entries: [entry({ status: "busy" })] }))).toMatchObject([{ kind: "keep", reason: "busy" }])
  expect(plan(input({ processes: polling.replace(/^( {2}4500 {2}4242) .{24}/m, "$1"), entries: [entry({ status: "busy" })] }))).toMatchObject([
    { kind: "keep", reason: "busy" },
  ])
  expect(plan(input({ processes: ci, entries: [entry({ status: "busy" })] }))).toMatchObject([{ kind: "keep", reason: "busy" }])
  expect(plan(input({ processes: ci }))).toMatchObject([{ kind: "keep", reason: "running a background command" }])
})

test("walks a process's ancestors, stopping at pid 1 and on a cycle", () => {
  expect(ancestorsOf("  10     1\n  20    10\n  30    20\n  40    99\n\n", 30)).toEqual(new Set([30, 20, 10]))
  expect(ancestorsOf("5 6\n6 5\n", 5)).toEqual(new Set([5, 6]))
  expect(ancestorsOf("bad line\n", 77)).toEqual(new Set([77]))
})

test("finds attach targets only after a word with claude in its path", () => {
  expect([...attachTargets("/opt/bin/claude attach 1a2b3c4d\nbun /x/cli.js claude attach w1\nnode /x/claude/cli.js attach lane\ngit attach x")]).toEqual([
    id,
    "w1",
    "lane",
  ])
})

describe("configuration", () => {
  const configure = (env: { XDG_CONFIG_HOME: string }, value: unknown) => {
    const dir = join(env.XDG_CONFIG_HOME, "scp")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "config.json"), JSON.stringify(value), { mode: 0o600 })
  }
  test("reads defaults and file settings with environment precedence", () => {
    const f = fixture()
    delete f.env.SCP_CLAUDE_BG_REMOVE
    expect(bgConfig(f.env)).toEqual({ stopAfterS: 120, idleAfterS: 600, remove: "on_stop" })
    for (const [value, seconds] of [
      ["900", 900],
      ["10m", 600],
      ["Infinity", Infinity],
    ] as const)
      expect(bgConfig({ ...f.env, SCP_CLAUDE_BG_STOP_AFTER_S: value, SCP_CLAUDE_BG_REMOVE: "0" })).toEqual({
        stopAfterS: seconds,
        idleAfterS: 600,
        remove: false,
      })
    configure(f.env, { claude_bg: { stop_after_s: "Infinity", remove: false } })
    expect(bgConfig(f.env)).toEqual({ stopAfterS: Infinity, idleAfterS: 600, remove: false })
    expect(bgConfig({ ...f.env, SCP_CLAUDE_BG_STOP_AFTER_S: "900", SCP_CLAUDE_BG_REMOVE: "1" })).toEqual({
      stopAfterS: 900,
      idleAfterS: 600,
      remove: "on_stop",
    })
    for (const [value, remove] of [
      ["on_stop", "on_stop"],
      ["true", "on_stop"],
      ["historic", "historic"],
      ["false", false],
      ["bogus", false],
    ] as const)
      expect(bgConfig({ ...f.env, SCP_CLAUDE_BG_REMOVE: value }).remove).toBe(remove)
    for (const [value, remove] of [
      [true, "on_stop"],
      ["on_stop", "on_stop"],
      ["historic", "historic"],
      ["bogus", "on_stop"],
    ] as const) {
      configure(f.env, { claude_bg: { remove: value } })
      expect(bgConfig(f.env).remove).toBe(remove)
    }
  })
  test("reads the claude bg idle threshold from its own names before the shared ones, the environment first at each level", () => {
    const f = fixture()
    const idle = (env: Record<string, string>) => bgConfig({ ...f.env, ...env }).idleAfterS
    expect([idle({}), idleAfterS(f.env)]).toEqual([600, 600])
    expect(idle({ SCP_IDLE_AFTER_S: "5m" })).toBe(300)
    expect(idle({ SCP_IDLE_AFTER_S: "Infinity", SCP_CLAUDE_BG_IDLE_AFTER_S: "20m" })).toBe(1200)
    configure(f.env, { lifecycle: { idle_after_s: 300 } })
    expect([idle({}), idleAfterS(f.env)]).toEqual([300, 300])
    expect(idle({ SCP_IDLE_AFTER_S: "90" })).toBe(90)
    expect(idle({ SCP_IDLE_AFTER_S: "bogus" })).toBe(300)
    configure(f.env, { claude_bg: { idle_after_s: "1h" }, lifecycle: { idle_after_s: 300 } })
    expect([idle({}), idle({ SCP_IDLE_AFTER_S: "90" }), idleAfterS(f.env)]).toEqual([3600, 3600, 3600])
    expect(idle({ SCP_CLAUDE_BG_IDLE_AFTER_S: "90" })).toBe(90)
    expect(idle({ SCP_CLAUDE_BG_IDLE_AFTER_S: "bogus" })).toBe(3600)
  })
  test("reads the spawn hold from its own names before the shared ones, never from claude_bg", () => {
    const f = fixture()
    const hold = (env: Record<string, string>) => spawnIdleAfterS({ ...f.env, ...env })
    expect(hold({})).toBeUndefined()
    expect(hold({ SCP_CLAUDE_BG_IDLE_AFTER_S: "Infinity" })).toBeUndefined()
    expect(hold({ SCP_IDLE_AFTER_S: "5m" })).toBe(300)
    expect(hold({ SCP_IDLE_AFTER_S: "Infinity", SCP_SPAWN_IDLE_AFTER_S: "20m" })).toBe(1200)
    configure(f.env, { lifecycle: { idle_after_s: 300 } })
    expect([hold({}), hold({ SCP_IDLE_AFTER_S: "90" })]).toEqual([300, 90])
    configure(f.env, { spawn: { idle_after_s: "1h" }, lifecycle: { idle_after_s: 300 } })
    expect([hold({}), hold({ SCP_IDLE_AFTER_S: "90" }), hold({ SCP_SPAWN_IDLE_AFTER_S: "0" })]).toEqual([3600, 3600, 0])
  })
  test("claude_bg.idle_after_s Infinity never stops a background worker and leaves spawn holds finite", () => {
    const f = fixture()
    configure(f.env, { claude_bg: { idle_after_s: "Infinity" } })
    expect([idleAfterS(f.env), spawnIdleAfterS(f.env)]).toEqual([Infinity, undefined])
    configure(f.env, { claude_bg: { idle_after_s: "Infinity" }, lifecycle: { idle_after_s: "15m" } })
    expect([idleAfterS(f.env), spawnIdleAfterS(f.env)]).toEqual([Infinity, 900])
    expect([idleAfterS({ ...f.env, SCP_IDLE_AFTER_S: "60" }), spawnIdleAfterS({ ...f.env, SCP_IDLE_AFTER_S: "60" })]).toEqual([Infinity, 60])
  })
  test("reads the historic threshold from the environment, else config.json", () => {
    const f = fixture()
    expect(historicAfterS(f.env)).toBeUndefined()
    expect(historicAfterS({ ...f.env, SCP_HISTORIC_AFTER_S: "2h" })).toBe(7200)
    expect(historicAfterS({ ...f.env, SCP_HISTORIC_AFTER_S: "Infinity" })).toBe(Infinity)
    expect(historicAfterS({ ...f.env, SCP_HISTORIC_AFTER_S: "0" })).toBeUndefined()
    configure(f.env, { lifecycle: { historic_after_s: "30m" } })
    expect(historicAfterS(f.env)).toBe(1800)
    configure(f.env, { historic_after_s: 900, lifecycle: { historic_after_s: "30m" } })
    expect(historicAfterS(f.env)).toBe(900)
    expect(historicAfterS({ ...f.env, SCP_HISTORIC_AFTER_S: "120" })).toBe(120)
  })
})

describe("background task", () => {
  test("never runs claude without launcher records or Claude Code endpoints", async () => {
    const f = fixture()
    await f.run()
    expect(existsSync(f.callsFile)).toBe(false)
    expect(f.events.filter((event) => event[0] !== "agents")).toEqual([])
  })
  test("never stops an idle worker swarm did not start", async () => {
    const f = fixture()
    f.facts = agent({ harness: "claude-code", state: "working" })
    await f.run()
    expect(f.calls().map((call) => call.argv)).toEqual([["agents", "--json", "--all"]])
    expect(f.events.filter((event) => event[0] === "hibernate")).toEqual([])
    expect(readState(f.env, id)).toBeUndefined()
  })
  test("lists claude once for a Claude Code root, then not again until a worker may be due", async () => {
    const f = fixture()
    const task = claudeBgTask(f.env, f.deps)
    f.facts = agent({ harness: "claude-code", parent: null })
    await task.run(f.context)
    await task.run(f.context)
    expect(f.calls().map((call) => call.argv)).toEqual([["agents", "--json", "--all"]])
    f.facts = agent({ harness: "claude-code", harness_session: `${id}-0000-4000-8000-000000000009` })
    await task.run(f.context)
    await task.run(f.context)
    expect(f.calls()).toHaveLength(1)
  })
  test("aborts the stop when claude shows the session busy right before it", async () => {
    const f = fixture()
    f.record()
    f.onHibernate = () => f.save([entry({ cwd: f.home, status: "busy" })])
    await f.run()
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents", "agents"])
    expect(f.events).toContainEqual(["unhibernate", "worker-id"])
    expect(f.events).toContainEqual(["log", `swarm claude: kept ${id} (me/w1): claude shows it busy`])
    expect(readState(f.env, id)).toBeUndefined()
  })
  test("relists claude after the broker rechecks, so a session busy by then is kept", async () => {
    const f = fixture()
    f.record()
    f.onAgents = () => {
      if (f.facts.hibernate === "claude-bg") f.save([entry({ cwd: f.home, status: "busy" })])
    }
    await f.run()
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents", "agents"])
    expect(f.events).toContainEqual(["log", `swarm claude: kept ${id} (me/w1): claude shows it busy`])
  })
  test("skips the run when its own process ancestry cannot be read", async () => {
    const f = fixture()
    f.record()
    f.deps.ancestors = async () => null
    await f.run()
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents"])
    expect(f.events.filter((event) => event[0] === "hibernate")).toEqual([])
  })
  test("hibernates before stopping and saves resumable state", async () => {
    const f = fixture()
    f.record()
    await f.run()
    const ref = reviveRef(sessionId, f.home, "lane")
    expect(JSON.parse(ref)).toEqual({
      via: "claude-bg",
      harness: "claude-code",
      session: sessionId,
      cwd: f.home,
      argv: ["claude", "--bg", "--resume", sessionId, "--name", "lane"],
    })
    expect(f.events.filter((event) => event[0] === "hibernate")).toEqual([["hibernate", "worker-id", "claude-bg", ref, false]])
    expect(f.calls().map((call) => call.argv)).toEqual([
      ["agents", "--json", "--all"],
      ["agents", "--json", "--all"],
      ["stop", id],
    ])
    expect(readState(f.env, id)).toEqual({ sessionId, cwd: f.home, name: "lane", handle: "w1", stoppedAt: now })
    expect(f.events.some((event) => event[0] === "kick")).toBe(false)
  })
  test("saves wake identity before hibernating a worker", async () => {
    const f = fixture()
    f.record()
    f.onHibernate = () => {
      expect(readState(f.env, id)).toMatchObject({ sessionId, handle: "w1" })
    }
    await f.run()
    expect(f.events.some((event) => event[0] === "hibernate")).toBe(true)
  })
  for (const race of ["work", "mail"] as const) {
    test(`cancels the stop when ${race} arrives after hibernation`, async () => {
      const f = fixture()
      f.record()
      f.onHibernate = () => {
        if (race === "work") f.facts.worked_at = new Date(now).toISOString()
        else f.facts.unread = true
      }
      await f.run()
      expect(f.events).toContainEqual(["unhibernate", "worker-id"])
      expect(f.calls().map((call) => call.argv[0])).toEqual(["agents"])
      expect(readState(f.env, id)).toBeUndefined()
    })
  }
  test("kicks a worker when mail arrives after the stop", async () => {
    const f = fixture()
    f.record()
    f.onAgents = () => {
      if (f.calls().some((call) => call.argv[0] === "stop")) mail(f.facts)
    }
    await f.run()
    expect(f.calls().at(-1)?.argv).toEqual(["stop", id])
    expect(f.events.filter((event) => event[0] === "hibernate").at(-1)?.[4]).toBe(true)
    expect(f.events).toContainEqual(["log", `swarm claude: kept ${id} (me/w1): mail raced the stop, so its waker brings it back`])
  })
  test("a worker stopped with unread mail it already had stays stopped across sweeps, its waker never kicked", async () => {
    const f = fixture()
    f.record()
    const old = new Date(now - 3_600_000).toISOString()
    f.facts = agent({ state: "working", unread: true, unread_at: old, mail_at: old })
    const task = claudeBgTask(f.env, f.deps)
    await task.run(f.context)
    expect(f.calls().at(-1)?.argv).toEqual(["stop", id])
    expect(f.events.filter((event) => event[0] === "hibernate")).toHaveLength(1)
    f.save([stoppedEntry({ cwd: f.home })])
    f.facts = { ...f.facts, presence: "hibernated", connections: 0 }
    for (let n = 0; n < 3; n++) await task.run(f.context)
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents", "agents", "stop"])
    expect(f.events.filter((event) => event[0] === "hibernate")).toHaveLength(1)
    expect(f.events.some((event) => event[0] === "unhibernate" || event[0] === "kick")).toBe(false)
  })
  for (const fails of [false, true]) {
    test(`respawns awake a worker whose shim took mail just before the stop, with respawn failing ${fails}`, async () => {
      const f = fixture()
      const record = f.record()
      const config = JSON.parse(readFileSync(record, "utf8"))
      config.mcpServers.scp.env.SCP_WAKE_TICKET = `kwt_${"cd".repeat(32)}`
      writeFileSync(record, JSON.stringify(config))
      if (fails) writeFileSync(join(f.home, "respawn-fail"), "")
      f.onAgents = () => {
        if (f.calls().some((call) => call.argv[0] === "stop")) f.facts.mail_at = new Date(now).toISOString()
      }
      await f.run()
      expect(f.calls().map((call) => call.argv)).toEqual([
        ["agents", "--json", "--all"],
        ["agents", "--json", "--all"],
        ["stop", id],
        ["respawn", id],
      ])
      expect(f.events.some((event) => event[0] === "kick")).toBe(false)
      expect(f.events.filter((event) => event[0] === "hibernate" || event[0] === "unhibernate").map((event) => event[0])).toEqual(
        fails ? ["hibernate", "unhibernate", "hibernate"] : ["hibernate", "unhibernate"],
      )
      expect(f.facts.hibernate).toBe(fails ? "claude-bg" : null)
      expect(JSON.parse(readFileSync(record, "utf8")).mcpServers.scp.env.SCP_WAKE_TICKET).toBeUndefined()
    })
  }
  test("records a refused removal and holds subsequent attempts", async () => {
    const f = fixture()
    f.record()
    f.save([stoppedEntry({ cwd: f.home })])
    f.facts = agent({ historic: true, hibernate: "claude-bg", connections: 0 })
    writeFileSync(join(f.home, "rm-refuse"), "")
    await f.run()
    const reason = `cannot remove ${id}: unpushed commits; pass --discard-unpushed abc123@wt-1 to discard them`
    expect(readState(f.env, id)?.rmRefused).toEqual({ at: now, reason })
    expect(f.events).toContainEqual(["log", `swarm claude: kept ${id} (me/w1): claude rm refused: ${reason}`])
    await f.run()
    expect(f.calls().filter((call) => call.argv[0] === "rm")).toHaveLength(1)
    expect(f.calls().flatMap((call) => call.argv)).not.toContain("--discard-unpushed")
    expect(f.calls().flatMap((call) => call.argv)).not.toContain("--force-remove-worktree")
  })
  test("records successful removal and keeps the endpoint hibernated", async () => {
    const f = fixture()
    f.record()
    f.save([stoppedEntry({ cwd: f.home })])
    f.facts = agent({ historic: true, hibernate: "claude-bg", connections: 0 })
    await f.run()
    expect(f.calls().at(-1)?.argv).toEqual(["rm", id])
    expect(readState(f.env, id)).toMatchObject({ sessionId, removedAt: now })
    expect(f.facts.hibernate).toBe("claude-bg")
    expect(f.events.some((event) => event[0] === "unhibernate")).toBe(false)
  })
})

describe("removing on stop in the background task", () => {
  const ticket = `kwt_${"ef".repeat(32)}`
  const listing = ["agents", "--json", "--all"]
  function onStop() {
    const f = fixture()
    f.env.SCP_CLAUDE_BG_REMOVE = "on_stop"
    return f
  }
  test("removes a worker right after its stop, keeps its endpoint hibernated, and lists claude for it no more", async () => {
    const f = onStop()
    f.record()
    const task = claudeBgTask(f.env, f.deps)
    await task.run(f.context)
    expect(f.calls().map((call) => call.argv)).toEqual([listing, listing, ["stop", id], listing, ["rm", id]])
    expect(readState(f.env, id)).toEqual({ sessionId, cwd: f.home, name: "lane", handle: "w1", stoppedAt: now, removedAt: now })
    expect(f.facts.hibernate).toBe("claude-bg")
    expect(f.events.filter((event) => event[0] === "hibernate")).toHaveLength(1)
    expect(f.events).toContainEqual(["log", `swarm claude: removed ${id} (me/w1)`])
    f.facts = { ...f.facts, presence: "hibernated", connections: 0 }
    for (let n = 0; n < 3; n++) await task.run(f.context)
    expect(f.calls()).toHaveLength(5)
  })
  test("removes a worker stopped earlier on the next pass, then a message resumes it into the list on the same endpoint", async () => {
    const f = onStop()
    const record = f.record()
    f.save([stoppedEntry({ cwd: f.home })])
    f.facts = agent({ hibernate: "claude-bg", presence: "hibernated", connections: 0 })
    const task = claudeBgTask(f.env, f.deps)
    await task.run(f.context)
    expect(f.calls().map((call) => call.argv)).toEqual([listing, listing, ["rm", id]])
    expect(readState(f.env, id)).toMatchObject({ sessionId, cwd: f.home, name: "lane", handle: "w1", removedAt: now })
    expect(f.events.some((event) => event[0] === "hibernate" || event[0] === "unhibernate" || event[0] === "kick")).toBe(false)
    const wake = { ...f.env, SCP_WAKE_REF: reviveRef(sessionId, f.home, "lane"), SCP_WAKE_HANDLE: "w1", SCP_WAKE_ENDPOINT: "me/w1", SCP_WAKE_TICKET: ticket }
    expect(await claudeWakeCommand(wake, { stdout: () => {} })).toBe(0)
    expect(f.calls().at(-1)).toEqual({
      argv: ["--bg", "--resume", sessionId, "--name", "lane", "You were woken by an SCP message: read it with relay_inbox.", "--mcp-config", record],
      cwd: f.home,
    })
    expect(JSON.parse(readFileSync(record, "utf8")).mcpServers.scp.env.SCP_WAKE_TICKET).toBe(ticket)
    expect(readState(f.env, id)?.removedAt).toBeUndefined()
    expect(JSON.parse(readFileSync(join(f.home, "claude-state.json"), "utf8"))).toMatchObject([{ id, sessionId, name: "lane", cwd: f.home, pid: 4242 }])
    f.facts = { ...f.facts, presence: "online", connections: 1, worked_at: new Date(now).toISOString(), mail_at: new Date(now).toISOString() }
    await task.run(f.context)
    expect(f.events.at(-1)).toEqual(["unhibernate", "worker-id"])
    expect(f.calls().filter((call) => call.argv[0] === "rm" || call.argv[0] === "stop")).toHaveLength(1)
  })
  test("removes a stopped worker whose endpoint is gone, once, and never a root's", async () => {
    for (const grant of ["kgr_grant", ""]) {
      const f = onStop()
      f.record(id, "w1", grant)
      f.save([stoppedEntry({ cwd: f.home })])
      f.facts = agent({ id: "other-id", address: "me/other", handle: "other", harness_session: "other-session", parent: null })
      const task = claudeBgTask(f.env, f.deps)
      for (let n = 0; n < 3; n++) await task.run(f.context)
      if (!grant) {
        expect(f.calls().map((call) => call.argv)).toEqual([listing])
        expect(readState(f.env, id)).toBeUndefined()
        continue
      }
      expect(f.calls().map((call) => call.argv)).toEqual([listing, listing, ["rm", id]])
      expect(readState(f.env, id)).toEqual({ sessionId, cwd: f.home, name: "lane", removedAt: now })
      expect(f.events).toContainEqual(["log", `swarm claude: removed ${id} (no endpoint)`])
      expect(f.events.some((event) => event[0] === "hibernate" || event[0] === "kick")).toBe(false)
    }
  })
  test("removes a worker whose endpoint goes away after the listing, and holds a refused orphan removal", async () => {
    const f = fixture()
    f.record(id, "w1", "kgr_grant")
    f.save([stoppedEntry({ cwd: f.home })])
    f.facts = agent({ hibernate: "claude-bg", presence: "hibernated", connections: 0 })
    const task = claudeBgTask(f.env, f.deps)
    await task.run(f.context)
    await task.run(f.context)
    expect(f.calls().map((call) => call.argv)).toEqual([listing])
    f.facts = agent({ id: "other-id", address: "me/other", handle: "other", harness_session: "other-session", parent: null })
    writeFileSync(join(f.home, "rm-refuse"), "")
    await task.run(f.context)
    await task.run(f.context)
    expect(f.calls().map((call) => call.argv)).toEqual([listing, listing, listing, ["rm", id]])
    expect(readState(f.env, id)?.rmRefused?.reason).toStartWith(`cannot remove ${id}`)
    expect(f.events.filter((event) => event[0] === "log").map((event) => event[1])).toEqual([
      `swarm claude: kept ${id} (no endpoint): claude rm refused: ${readState(f.env, id)?.rmRefused?.reason}`,
    ])
  })
  test("keeps an orphan whose endpoint shows up again right before the removal", async () => {
    const f = onStop()
    f.record(id, "w1", "kgr_grant")
    f.save([stoppedEntry({ cwd: f.home })])
    f.facts = agent({ id: "other-id", address: "me/other", handle: "other", harness_session: "other-session", parent: null })
    let reads = 0
    f.onAgents = () => {
      if (++reads === 4) f.facts = agent({ hibernate: "claude-bg", presence: "hibernated", connections: 0 })
    }
    await f.run()
    expect(f.calls().map((call) => call.argv)).toEqual([listing])
    expect(f.events.at(-1)).toEqual(["log", `swarm claude: kept ${id} (no endpoint): it has an endpoint again`])
  })
  test("stops a worker in a claude worktree without removing it, and removes it once its endpoint turns historic", async () => {
    const f = onStop()
    const cwd = join(f.home, ".claude", "worktrees", "lane")
    f.record()
    f.save([entry({ cwd })])
    const task = claudeBgTask(f.env, f.deps)
    await task.run(f.context)
    expect(f.calls().map((call) => call.argv)).toEqual([listing, listing, ["stop", id]])
    f.facts = { ...f.facts, presence: "hibernated", connections: 0 }
    await task.run(f.context)
    expect(f.calls()).toHaveLength(3)
    f.facts = { ...f.facts, historic: true }
    await task.run(f.context)
    expect(
      f
        .calls()
        .map((call) => call.argv)
        .slice(3),
    ).toEqual([listing, listing, ["rm", id]])
  })
  test("removes a worker it stopped earlier once its endpoint turns historic, with remove historic", async () => {
    const f = fixture()
    f.record()
    const task = claudeBgTask(f.env, f.deps)
    await task.run(f.context)
    expect(f.calls().map((call) => call.argv)).toEqual([listing, listing, ["stop", id]])
    f.facts = { ...f.facts, presence: "hibernated", connections: 0 }
    await task.run(f.context)
    expect(f.calls()).toHaveLength(3)
    f.facts = { ...f.facts, historic: true }
    await task.run(f.context)
    expect(
      f
        .calls()
        .map((call) => call.argv)
        .slice(3),
    ).toEqual([listing, listing, ["rm", id]])
    expect(readState(f.env, id)).toMatchObject({ stoppedAt: now, removedAt: now })
  })
  test("tries a removal claude refused after the stop again a day later", async () => {
    const f = onStop()
    f.record()
    writeFileSync(join(f.home, "rm-refuse"), "")
    let at = now
    f.deps.now = () => at
    const task = claudeBgTask(f.env, f.deps)
    await task.run(f.context)
    expect(f.calls().map((call) => call.argv)).toEqual([listing, listing, ["stop", id], listing, ["rm", id]])
    f.facts = { ...f.facts, presence: "hibernated", connections: 0 }
    await task.run(f.context)
    expect(f.calls()).toHaveLength(5)
    at = now + 86_400_000
    rmSync(join(f.home, "rm-refuse"))
    await task.run(f.context)
    expect(
      f
        .calls()
        .map((call) => call.argv)
        .slice(5),
    ).toEqual([listing, listing, ["rm", id]])
    expect(readState(f.env, id)?.removedAt).toBe(at)
  })
  test("keeps an orphan a claude attach took, or that claude lists running again, right before the removal", async () => {
    for (const race of ["attach", "running"] as const) {
      const f = onStop()
      f.record(id, "w1", "kgr_grant")
      f.save([stoppedEntry({ cwd: f.home })])
      f.facts = agent({ id: "other-id", address: "me/other", handle: "other", harness_session: "other-session", parent: null })
      let reads = 0
      f.deps.ps = async () => (race === "attach" && reads++ ? `/usr/bin/claude attach ${id}` : "")
      if (race === "running") f.onAgents = () => f.calls().length && f.save([entry({ cwd: f.home })])
      await f.run()
      expect(f.calls().map((call) => call.argv[0])).not.toContain("rm")
      expect(f.events.at(-1)?.[1]).toBe(`swarm claude: kept ${id} (no endpoint): ${race === "attach" ? "attached" : "claude shows it running again (idle)"}`)
    }
  })
})

describe("acting on a changed worker", () => {
  test("never removes a live worker when mail races its stop", async () => {
    const f = fixture()
    f.record()
    f.facts = agent({ historic: true })
    f.onAgents = () => {
      if (f.calls().some((call) => call.argv[0] === "stop")) mail(f.facts)
    }
    await f.run()
    expect(f.calls().map((call) => call.argv[0])).not.toContain("rm")
  })
  test("keeps a worker a claude attach took after the plan", async () => {
    const f = fixture()
    f.record()
    let reads = 0
    f.deps.ps = async () => (reads++ ? `/usr/bin/claude attach ${id}` : "")
    await f.run()
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents"])
    expect(f.facts.hibernate).toBeNull()
  })
  test("stops a worker whose process runs only its helpers", async () => {
    const f = fixture()
    f.record()
    f.deps.ps = async () => helpers
    await f.run()
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents", "agents", "stop"])
  })
  test("keeps a worker a command runs under, seen at the plan or right before the stop", async () => {
    for (const seen of [0, 1]) {
      const f = fixture()
      f.record()
      let reads = 0
      f.deps.ps = async () => (reads++ >= seen ? running : helpers)
      await f.run()
      expect(f.calls().map((call) => call.argv[0])).toEqual(["agents"])
      expect(f.facts.hibernate).toBeNull()
      expect(readState(f.env, id)).toBeUndefined()
      if (seen) expect(f.events).toContainEqual(["log", `swarm claude: kept ${id} (me/w1): running a background command`])
    }
  })
  test("stops a busy worker that only polls its inbox, unless its loop ends or mail arrives right before the stop", async () => {
    for (const end of ["none", "loop", "mail"] as const) {
      const f = fixture()
      f.record()
      f.save([entry({ cwd: f.home, status: "busy" })])
      let reads = 0
      f.deps.ps = async () => (end === "loop" && reads++ >= 2 ? helpers : polling)
      if (end === "mail") f.onHibernate = () => mail(f.facts)
      await f.run()
      expect([end, f.calls().map((call) => call.argv[0])]).toEqual([
        end,
        end === "none" ? ["agents", "agents", "stop"] : end === "loop" ? ["agents", "agents"] : ["agents"],
      ])
      if (end !== "none") expect(f.facts.hibernate).toBeNull()
    }
  })
  test("keeps a worker when the process table cannot be read right before the stop", async () => {
    const f = fixture()
    f.record()
    let reads = 0
    f.deps.ps = async () => (reads++ ? null : helpers)
    await f.run()
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents"])
    expect(f.facts.hibernate).toBeNull()
  })
  test("wakes a removed worker whose mail arrived during the removal", async () => {
    const f = fixture()
    f.record()
    f.save([stoppedEntry({ cwd: f.home })])
    f.facts = agent({ historic: true, hibernate: "claude-bg", connections: 0 })
    f.onAgents = () => {
      if (f.calls().some((call) => call.argv[0] === "rm")) mail(f.facts)
    }
    await f.run()
    expect(f.calls().at(-1)?.argv).toEqual(["rm", id])
    expect(f.events.filter((event) => event[0] === "hibernate")).toHaveLength(1)
  })
  test("never kicks a removed worker for unread mail it already had", async () => {
    const f = fixture()
    f.record()
    f.save([stoppedEntry({ cwd: f.home })])
    const old = new Date(now - 3_600_000).toISOString()
    f.facts = agent({ historic: true, hibernate: "claude-bg", connections: 0, unread: true, unread_at: old, mail_at: old })
    await f.run()
    expect(f.calls().at(-1)?.argv).toEqual(["rm", id])
    expect(f.events.filter((event) => event[0] === "hibernate")).toHaveLength(0)
  })
  test("keeps and kicks a stopped worker that claude shows running again right before the removal", async () => {
    const f = fixture()
    f.record()
    f.save([stoppedEntry({ cwd: f.home })])
    f.facts = agent({ historic: true, hibernate: "claude-bg", connections: 0 })
    f.onAgents = () => {
      if (f.calls().length) f.save([entry({ cwd: f.home })])
    }
    await f.run()
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents", "agents"])
    expect(f.events.filter((event) => event[0] === "hibernate")).toHaveLength(1)
    expect(f.events).toContainEqual(["log", `swarm claude: kept ${id} (me/w1): claude shows it running again (idle)`])
  })
})

describe("revive ref", () => {
  test("is the revive record, or the bare session id when the record would not fit a ref", () => {
    expect(refSession(reviveRef(sessionId, "/work", undefined))).toBe(sessionId)
    expect(reviveRef(sessionId, `/${"d".repeat(500)}`, "lane")).toBe(sessionId)
    expect(refSession(sessionId)).toBe(sessionId)
  })
})

describe("wake command", () => {
  const ticket = `kwt_${"ab".repeat(32)}`
  const scpEnv = (file: string) => JSON.parse(readFileSync(file, "utf8")).mcpServers.scp.env
  for (const scenario of ["stopped", "removed"] as const) {
    test(`hands the ${scenario} session's shim the wake ticket through its MCP config, from a revive record ref`, async () => {
      const f = fixture()
      const record = f.record()
      if (scenario === "stopped") f.save([stoppedEntry({ cwd: f.home })])
      else {
        f.save([])
        f.state({ cwd: f.home })
      }
      f.state({ cwd: f.home })
      const ref = reviveRef(sessionId, f.home, "lane")
      expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: ref, SCP_WAKE_TICKET: ticket }, { stdout: () => {} })).toBe(0)
      expect(scpEnv(record)).toEqual({
        SCP_NAME: "w1",
        SCP_GRANT: "",
        SCP_WAKE_TICKET: ticket,
        ...(scenario === "removed" ? { SCP_HARNESS_ORIGIN: sessionId } : {}),
      })
      expect(f.calls().at(-1)?.argv[0]).toBe(scenario === "stopped" ? "respawn" : "--bg")
      f.save([stoppedEntry({ cwd: f.home })])
      expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: ref }, { stdout: () => {} })).toBe(0)
      expect(scpEnv(record)).toEqual({ SCP_NAME: "w1", SCP_GRANT: "" })
    })
  }
  test("a removed worker resumed under a new session id gets its origin, stays recorded under the new id and wakes again", async () => {
    const f = fixture()
    const record = f.record()
    f.save([])
    f.state({ cwd: f.home })
    const forked = "5e6f7a8b-0000-4000-8000-000000000009"
    writeFileSync(join(f.home, "fork"), forked)
    const wake = (ref: string) => claudeWakeCommand({ ...f.env, SCP_WAKE_REF: ref, SCP_WAKE_HANDLE: "w1", SCP_WAKE_TICKET: ticket }, { stdout: () => {} })
    expect(await wake(reviveRef(sessionId, f.home, "lane"))).toBe(0)
    expect(scpEnv(record)).toEqual({ SCP_NAME: "w1", SCP_GRANT: "", SCP_WAKE_TICKET: ticket, SCP_HARNESS_ORIGIN: sessionId })
    expect(f.calls().at(-2)?.argv).toEqual(["--bg", "--resume", sessionId, "--name", "lane", expect.any(String), "--mcp-config", record])
    expect(readRecords(f.env).get("5e6f7a8b")).toMatchObject({ file: record, handle: "w1" })
    expect(readState(f.env, "5e6f7a8b")).toEqual({ sessionId: forked, cwd: f.home, name: "lane", handle: "w1" })
    expect(readState(f.env, id)?.movedTo).toBe("5e6f7a8b")
    const before = f.calls().length
    expect(await wake(reviveRef(sessionId, f.home, "lane"))).toBe(0)
    expect(
      f
        .calls()
        .slice(before)
        .map((call) => call.argv[0]),
    ).toEqual(["agents"])
    f.save([stoppedEntry({ id: "5e6f7a8b", sessionId: forked, cwd: f.home })])
    expect(await wake(reviveRef(sessionId, f.home, "lane"))).toBe(0)
    expect(f.calls().at(-1)?.argv).toEqual(["respawn", "5e6f7a8b"])
    f.save([])
    rmSync(join(f.home, "fork"))
    expect(await wake(reviveRef(forked, f.home, "lane"))).toBe(0)
    expect(f.calls().at(-1)?.argv).toEqual(["--bg", "--resume", forked, "--name", "lane", expect.any(String), "--mcp-config", record])
    expect(scpEnv(record).SCP_HARNESS_ORIGIN).toBe(forked)
    f.save([stoppedEntry({ id: "5e6f7a8b", sessionId: forked, cwd: f.home })])
    expect(await wake(forked)).toBe(0)
    expect(f.calls().at(-1)?.argv).toEqual(["respawn", "5e6f7a8b"])
    expect(scpEnv(record).SCP_HARNESS_ORIGIN).toBeUndefined()
  })

  test("a record whose native swarm an upgrade removed is re-pointed at this CLI's mount, keeping its own variables", async () => {
    const f = fixture()
    const record = f.record()
    const config = JSON.parse(readFileSync(record, "utf8"))
    config.mcpServers.scp = {
      type: "stdio",
      command: join(f.home, "removed", "swarm"),
      args: ["mcp", "--harness", "claude", "--channels", "--as", "w1"],
      env: { ...config.mcpServers.scp.env, SCP_NATIVE: "1", SCP_CLI_ARGV: '["/old/node","/old/cli.js"]' },
    }
    writeFileSync(record, JSON.stringify(config))
    f.state()
    expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: sessionId, SCP_WAKE_TICKET: ticket })).toBe(0)
    const scp = JSON.parse(readFileSync(record, "utf8")).mcpServers.scp
    expect(scp.command).toBe(SELF[0])
    expect(scp.args).toEqual([...SELF.slice(1), "mcp", "--harness", "claude", "--channels", "--as", "w1"])
    expect(scp.env).toEqual({ SCP_NAME: "w1", SCP_GRANT: "", SCP_WAKE_TICKET: ticket })
    const kept = JSON.stringify(scp)
    expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: sessionId, SCP_WAKE_TICKET: ticket })).toBe(0)
    expect(JSON.stringify(JSON.parse(readFileSync(record, "utf8")).mcpServers.scp)).toBe(kept)
  })
  test("arms and removes tickets for a live entry", async () => {
    const f = fixture()
    const record = f.record()
    f.state()
    expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: sessionId, SCP_WAKE_TICKET: ticket })).toBe(0)
    expect(scpEnv(record).SCP_WAKE_TICKET).toBe(ticket)
    expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: sessionId })).toBe(0)
    expect(scpEnv(record).SCP_WAKE_TICKET).toBeUndefined()
  })
  for (const mismatch of ["handle", "endpoint", "record", "harness", "session", "harness session"] as const) {
    test(`declines a mismatched ${mismatch} before resuming`, async () => {
      const f = fixture()
      f.record(id, mismatch === "record" ? "other" : "w1")
      if (mismatch !== "record" && mismatch !== "harness session")
        f.state({ sessionId: mismatch === "session" ? `${id}-0000-4000-8000-000000000002` : sessionId })
      f.save([stoppedEntry({ cwd: f.home })])
      const ref = JSON.parse(reviveRef(sessionId, f.home, "lane"))
      if (mismatch === "harness") ref.harness = "other"
      const output: string[] = []
      expect(
        await claudeWakeCommand(
          {
            ...f.env,
            SCP_WAKE_REF: JSON.stringify(ref),
            ...(mismatch === "endpoint" ? { SCP_WAKE_ENDPOINT: "me/other" } : { SCP_WAKE_HANDLE: mismatch === "handle" ? "other" : "w1" }),
            ...(mismatch === "harness session" ? { SCP_WAKE_SESSION: `${id}-0000-4000-8000-000000000002` } : {}),
          },
          { stdout: (text) => output.push(text) },
        ),
      ).toBe(77)
      expect(output).toEqual(['{"declined":"unresumable"}\n'])
      expect(f.calls().map((call) => call.argv[0])).not.toContain("respawn")
    })
  }
  for (const proof of ["harness session", "record", "state"] as const) {
    test(`wakes a stopped session with no saved stop state, owned by its ${proof}`, async () => {
      const f = fixture()
      const record = f.record(id, proof === "harness session" ? "renamed" : proof === "state" ? "old" : "w1")
      if (proof === "state") f.state()
      f.save([stoppedEntry({ cwd: f.home })])
      const env = {
        ...f.env,
        SCP_WAKE_REF: reviveRef(sessionId, f.home, "lane"),
        SCP_WAKE_HANDLE: "w1",
        SCP_WAKE_ENDPOINT: "me/w1",
        SCP_WAKE_TICKET: ticket,
        ...(proof === "harness session" ? { SCP_WAKE_SESSION: sessionId } : {}),
      }
      expect(await claudeWakeCommand(env, { stdout: () => {} })).toBe(0)
      expect(scpEnv(record).SCP_WAKE_TICKET).toBe(ticket)
      expect(f.calls().at(-1)?.argv).toEqual(["respawn", id])
    })
  }
  for (const removed of [false, true]) {
    test(`fails closed when ticket arming fails with removed ${removed}`, async () => {
      const f = fixture()
      const record = f.record()
      f.state()
      f.save(removed ? [] : [stoppedEntry({ cwd: f.home })])
      writeFileSync(record, JSON.stringify({ mcpServers: {} }))
      expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: sessionId, SCP_WAKE_TICKET: ticket })).toBe(1)
      expect(f.calls().map((call) => call.argv[0])).toEqual(["agents"])
    })
  }
  test("removes a private temporary file when renaming fails", async () => {
    const f = fixture()
    const record = f.record()
    f.state()
    f.save([stoppedEntry({ cwd: f.home })])
    const before = fs.readdirSync(bgDir(f.env))
    const rename = spyOn(fs, "renameSync").mockImplementation((from) => {
      expect(fs.statSync(from).mode & 0o777).toBe(0o600)
      throw new Error("rename failed")
    })
    try {
      expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: sessionId, SCP_WAKE_TICKET: ticket })).toBe(1)
    } finally {
      rename.mockRestore()
    }
    expect(fs.readdirSync(bgDir(f.env))).toEqual(before)
    expect(scpEnv(record).SCP_WAKE_TICKET).toBeUndefined()
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents"])
  })
  test("ignores a fixed temp symlink when arming a ticket", async () => {
    const f = fixture()
    const record = f.record()
    f.state()
    f.save([stoppedEntry({ cwd: f.home })])
    const victim = join(f.home, "victim")
    writeFileSync(victim, "untouched")
    symlinkSync(victim, `${record}.tmp`)
    expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: sessionId, SCP_WAKE_TICKET: ticket })).toBe(0)
    expect(readFileSync(victim, "utf8")).toBe("untouched")
  })
  for (const scenario of ["stopped", "removed"] as const) {
    test(`wakes a ${scenario} worker swarm did not start from its saved stop, with no config to arm`, async () => {
      const f = fixture()
      const cwd = join(f.home, "workspace")
      mkdirSync(cwd)
      f.state({ cwd, stoppedAt: now })
      f.save(scenario === "stopped" ? [stoppedEntry({ cwd })] : [])
      const ref = reviveRef(sessionId, cwd, "lane")
      const env = { ...f.env, SCP_WAKE_REF: ref, SCP_WAKE_HANDLE: "w1", SCP_WAKE_TICKET: ticket }
      expect(await claudeWakeCommand(env, { stdout: () => {} })).toBe(0)
      expect(f.calls().at(-1)).toEqual(
        scenario === "stopped"
          ? { argv: ["respawn", id], cwd: expect.any(String) }
          : { argv: ["--bg", "--resume", sessionId, "--name", "lane", "You were woken by an SCP message: read it with relay_inbox."], cwd },
      )
      const output: string[] = []
      expect(await claudeWakeCommand({ ...env, SCP_WAKE_HANDLE: "other" }, { stdout: (text) => output.push(text) })).toBe(77)
      expect(output).toEqual(['{"declined":"unresumable"}\n'])
    })
  }
  test("declines a session swarm did not start, and a removed one whose transcript is gone", async () => {
    const f = fixture()
    const output: string[] = []
    f.save([stoppedEntry({ cwd: f.home })])
    expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: sessionId }, { stdout: (text) => output.push(text) })).toBe(77)
    f.record()
    f.save([])
    f.state({ cwd: f.home })
    const projects = join(f.home, "claude-config", "projects")
    mkdirSync(join(projects, "-work"), { recursive: true })
    const env = { ...f.env, CLAUDE_CONFIG_DIR: join(f.home, "claude-config"), SCP_WAKE_REF: sessionId }
    expect(await claudeWakeCommand(env, { stdout: (text) => output.push(text) })).toBe(77)
    expect(output).toEqual(['{"declined":"unresumable"}\n', '{"declined":"gone"}\n'])
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents", "agents"])
    writeFileSync(join(projects, "-work", `${sessionId}.jsonl`), "")
    expect(await claudeWakeCommand(env, { stdout: (text) => output.push(text) })).toBe(0)
    expect(f.calls().at(-1)?.argv.slice(0, 3)).toEqual(["--bg", "--resume", sessionId])
  })
  for (const scenario of ["invalid", "live", "stopped", "removed", "gone", "missing"] as const) {
    test(`handles a ${scenario} session`, async () => {
      const f = fixture()
      const output: string[] = []
      const record = f.record()
      if (scenario === "stopped") f.save([stoppedEntry({ cwd: f.home })])
      if (["removed", "gone", "missing"].includes(scenario)) f.save([])
      const cwd = join(f.home, "workspace")
      if (scenario === "removed") mkdirSync(cwd)
      if (scenario === "removed" || scenario === "gone") f.state({ cwd, removedAt: now })
      const code = await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: scenario === "invalid" ? id : sessionId }, { stdout: (text) => output.push(text) })
      expect(code).toBe(["invalid", "gone", "missing"].includes(scenario) ? 77 : 0)
      expect(output.join("")).toBe(
        scenario === "gone" ? '{"declined":"gone"}\n' : ["invalid", "missing"].includes(scenario) ? '{"declined":"unresumable"}\n' : "",
      )
      const calls = f.calls()
      if (scenario === "invalid") expect(existsSync(f.callsFile)).toBe(false)
      else {
        expect(calls[0]?.argv).toEqual(["agents", "--json", "--all"])
        expect(calls).toHaveLength(["stopped", "removed"].includes(scenario) ? 2 : 1)
      }
      if (scenario === "stopped") expect(calls[1]?.argv).toEqual(["respawn", id])
      if (scenario === "removed") expect(readState(f.env, id)?.removedAt).toBeUndefined()
      if (scenario === "removed")
        expect(calls[1]).toEqual({
          argv: ["--bg", "--resume", sessionId, "--name", "lane", "You were woken by an SCP message: read it with relay_inbox.", "--mcp-config", record],
          cwd,
        })
    })
  }
})

test("drops a resumed session name that would read as an option", async () => {
  const f = fixture()
  f.record()
  f.save([])
  const cwd = join(f.home, "workspace")
  mkdirSync(cwd)
  f.state({ cwd, name: "--dangerously-skip-permissions", removedAt: now })
  expect(await claudeWakeCommand({ ...f.env, SCP_WAKE_REF: sessionId }, { stdout: () => {} })).toBe(0)
  expect(f.calls()[1]?.argv).not.toContain("--name")
})

async function brokerFixture() {
  const f = fixture()
  f.record()
  const broker = await startBroker({
    dir: f.env.SCP_DIR,
    policyPath: join(f.home, "policy.json"),
    idleMs: 0,
    builtinWakers: { "claude-bg": { command: [process.execPath, "-e", "process.exit(0)"], timeout_s: 5 } },
  })
  cleanups.push(() => broker.stop())
  const connect = async (hello: Parameters<RelayClient["hello"]>[0]) => {
    const client = await RelayClient.connect(broker.socket)
    cleanups.push(() => client.close())
    const result = await client.hello(hello)
    return { client, endpoint: result.endpoint! }
  }
  const lead = await connect({ claim: { handle: "lead" } })
  const worker = await connect({ claim: { handle: "w1", session: sessionId } })
  const human = await connect({ human: true, tty: true })
  await human.client.request("adopt", { endpoint: "w1", parent: "lead" })
  await worker.client.request("status", { state: "done" })
  const lines: string[] = []
  const prune = (args: string[]) => claudeBgCommand("prune", args, f.env, (line) => lines.push(line), f.deps)
  return { ...f, broker, lead, worker, human, lines, prune, connect }
}

describe("broker commands", () => {
  test("prints a dry run without stopping the worker", async () => {
    const f = await brokerFixture()
    expect(await f.prune(["--dry-run"])).toBe(0)
    expect(f.lines).toContain(`would stop ${id} me/w1`)
    expect(f.calls().map((call) => call.argv)).toEqual([["agents", "--json", "--all"]])
    expect(f.broker.core.whoami(f.worker.endpoint.id).presence).not.toBe("hibernated")
  })
  test("prunes a worker into hibernation with its wake hook", async () => {
    const f = await brokerFixture()
    expect(await f.prune([])).toBe(0)
    expect(f.calls().at(-1)?.argv).toEqual(["stop", id])
    expect(f.broker.core.whoami(f.worker.endpoint.id)).toMatchObject({ presence: "hibernated", wake: "hook:claude-bg", revivable: true })
  })
  test("never removes sessions with stop only", async () => {
    const f = await brokerFixture()
    expect(await f.prune(["--stop-only"])).toBe(0)
    expect(await f.prune(["--stop-only", "--older-than", "30m"])).toBe(0)
    expect(f.calls().some((call) => call.argv[0] === "stop")).toBe(true)
    expect(f.calls().some((call) => call.argv[0] === "rm")).toBe(false)
  })
  test("keeps a worker a command runs under, in prune and in ls", async () => {
    const f = await brokerFixture()
    f.deps.ps = async () => running
    expect(await f.prune(["--older-than", "30m"])).toBe(0)
    expect(f.lines).toContain(`keep ${id} me/w1: running a background command`)
    expect(f.calls().map((call) => call.argv[0])).toEqual(["agents"])
    const rows: string[] = []
    expect(await claudeBgCommand("ls", ["--json"], f.env, (line) => rows.push(line), f.deps)).toBe(0)
    expect(JSON.parse(rows[0]!)).toMatchObject([{ id, policy: "kept: running a background command" }])
  })
  test("stops unfinished workers past an explicit age", async () => {
    const f = await brokerFixture()
    await f.worker.client.request("status", { state: "working" })
    expect(await f.prune(["--older-than", "30m", "--stop-only"])).toBe(0)
    expect(f.calls().at(-1)?.argv).toEqual(["stop", id])
  })
  test("clears only the claude-bg hibernation of sessions swarm did not start, and stops nothing", async () => {
    const f = await brokerFixture()
    const strayId = "4a2b3c4d"
    const straySession = `${strayId}-0000-4000-8000-000000000001`
    const stray = await f.connect({
      transient: true,
      claim: { handle: "w2", harness: "claude-code", session: "s-w2", process: "pid:999998:x" },
    })
    await stray.client.request("event", { kind: "stop", session_id: straySession })
    f.save([entry({ cwd: f.home }), entry({ id: strayId, sessionId: straySession, name: "stray", cwd: f.home })])
    for (const endpoint of ["w1", "w2"]) await f.human.client.request("hibernate", { endpoint, wake: "claude-bg" })
    const presence = (id: string) => f.broker.core.whoami(id).presence
    expect(await f.prune(["--unhibernate-unrecorded", "--dry-run"])).toBe(0)
    expect(f.lines).toEqual([`would unhibernate ${strayId} me/w2`])
    expect(presence(stray.endpoint.id)).toBe("hibernated")
    expect(await f.prune(["--unhibernate-unrecorded"])).toBe(0)
    expect(f.lines.at(-1)).toBe(`unhibernated ${strayId} me/w2`)
    expect(presence(stray.endpoint.id)).not.toBe("hibernated")
    expect(presence(f.worker.endpoint.id)).toBe("hibernated")
    expect(f.calls().map((call) => call.argv)).toEqual([
      ["agents", "--json", "--all"],
      ["agents", "--json", "--all"],
    ])
    for (const flag of [["--stop-only"], ["--older-than", "1h"]])
      await expect(f.prune(["--unhibernate-unrecorded", ...flag])).rejects.toThrow("does not go with --stop-only or --older-than")
  })
  test("prunes with remove on_stop: a worker is removed as it stops, and an orphan is removed with it", async () => {
    const f = await brokerFixture()
    f.env.SCP_CLAUDE_BG_REMOVE = "on_stop"
    const orphanId = "5a2b3c4d"
    f.record(orphanId, "w9", "kgr_grant")
    f.save([entry({ cwd: f.home }), stoppedEntry({ id: orphanId, sessionId: `${orphanId}-0000-4000-8000-000000000001`, name: "gone", cwd: f.home })])
    expect(await f.prune(["--dry-run"])).toBe(0)
    expect(f.lines).toEqual([`would remove ${id} me/w1`, `would remove ${orphanId} no endpoint`])
    const rows: string[] = []
    expect(await claudeBgCommand("ls", ["--all", "--json"], f.env, (line) => rows.push(line), f.deps)).toBe(0)
    expect(JSON.parse(rows[0]!)).toMatchObject([
      { id, policy: "due: remove" },
      { id: orphanId, policy: "due: remove, no endpoint" },
    ])
    f.lines.length = 0
    expect(await f.prune([])).toBe(0)
    expect(f.lines).toEqual([`removed ${id} me/w1`, `removed ${orphanId} no endpoint`])
    expect(
      f
        .calls()
        .filter((call) => call.argv[0] === "stop" || call.argv[0] === "rm")
        .map((call) => call.argv),
    ).toEqual([
      ["stop", id],
      ["rm", id],
      ["rm", orphanId],
    ])
    expect(f.broker.core.whoami(f.worker.endpoint.id)).toMatchObject({ presence: "hibernated", wake: "hook:claude-bg", revivable: true })
  })
  test("names the missing broker when pruning cannot connect", async () => {
    const f = fixture()
    await expect(claudeBgCommand("prune", [], f.env, () => {}, f.deps)).rejects.toThrow("needs the relay broker")
    expect(existsSync(f.callsFile)).toBe(false)
  })
  test("lists orchestrators first and includes worker and unknown roles", async () => {
    const f = await brokerFixture()
    const leadId = "2a2b3c4d"
    const unknownId = "3a2b3c4d"
    f.record(leadId, "lead")
    f.save([
      entry({ cwd: f.home }),
      entry({ id: unknownId, sessionId: `${unknownId}-0000-4000-8000-000000000001`, name: "stray", cwd: f.home }),
      entry({ id: leadId, sessionId: `${leadId}-0000-4000-8000-000000000001`, name: "lead", cwd: f.home }),
    ])
    const rows: string[] = []
    expect(await claudeBgCommand("ls", ["--json"], f.env, (line) => rows.push(line), f.deps)).toBe(0)
    expect(JSON.parse(rows[0]!)).toMatchObject([
      { id: leadId, name: "lead", state: "working", role: "orchestrator", endpoint: "me/lead", cwd: f.home },
      { id, name: "lane", state: "working", role: "worker", endpoint: "me/w1", cwd: f.home },
      { id: unknownId, name: "stray", state: "working", role: "unknown", endpoint: null, cwd: f.home },
    ])
    const printed: string[] = []
    const log = spyOn(console, "log").mockImplementation((line) => {
      printed.push(String(line))
    })
    try {
      expect(await claudeBgCommand("ls", [], f.env, () => {}, f.deps)).toBe(0)
    } finally {
      log.mockRestore()
    }
    expect(printed[1]).toContain(leadId)
    expect(printed[1]).toContain("orchestrator")
    expect(printed[2]).toContain("worker")
    expect(printed[3]).toContain("unknown")
  })
})
