import { execFile } from "node:child_process"
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type BrokerTask, type BrokerTaskContext, connectBroker, readOwnedFile, relayDir } from "@scp-dev/broker"
import { CLI_NAME, LIMITS, type LocalAgent, type ReviveRecord, reviveRecord } from "@scp-dev/core"
import { bgDir, LAUNCHER_IDENTITY } from "./claude"
import { RelayUsage, terminalAttached } from "./common"
import { configDir } from "./relay"
import { whichOnPath } from "./setup"
import { claudeTranscripts } from "./spawn"
import { note, parseSeconds, printTable } from "./term"
import { safeCwd } from "./cwd"

type Env = Record<string, string | undefined>

/** the provider a stopped or removed worker is hibernated by; its waker is `swarm claude-wake` */
export const CLAUDE_BG_PROVIDER = "claude-bg"
export const CLAUDE_WAKE_TIMEOUT_S = 90
/** how often the broker looks for workers to stop or remove */
export const CLAUDE_BG_EVERY_MS = 120_000
const STOP_AFTER_S = 600
const IDLE_AFTER_S = 600
const LIST_TIMEOUT_MS = 15_000
const ACT_TIMEOUT_MS = 30_000
/** a refused `claude rm` is tried again no sooner than this */
const RM_RETRY_MS = 86_400_000
const SHORT_ID = /^[0-9a-f]{8}$/
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** a session name passed back to `claude --name`: never read as an option */
const SAFE_NAME = /^[\w.@+ ][\w.@+ -]{0,99}$/
const WAKE_PROMPT = "You were woken by an SCP message: read it with relay_inbox."
const WAKE_TICKET = /^kwt_[0-9a-f]{64}$/

/**
 * the hibernation ref of a worker this policy stops or removes: its revive record (SPEC section 19.1), so the endpoint shows revivable, or
 * the bare session id when the record would not fit a ref
 */
export function reviveRef(sessionId: string, cwd: string, name: string | undefined): string {
  const record: ReviveRecord = {
    via: CLAUDE_BG_PROVIDER,
    harness: "claude-code",
    session: sessionId,
    cwd,
    argv: ["claude", "--bg", "--resume", sessionId, ...(name && SAFE_NAME.test(name) ? ["--name", name] : [])],
  }
  const text = JSON.stringify(record)
  return text.length <= LIMITS.wakeRefChars ? text : sessionId
}

/** the session id a `claude-bg` hibernation ref names: a revive record's session, or the bare id */
export function refSession(ref: string): string {
  return reviveRecord(ref)?.session ?? ref
}

/** one entry of `claude agents --json [--all]` */
export interface ClaudeEntry {
  id?: string
  cwd?: string
  kind?: string
  sessionId?: string
  name?: string
  state?: string
  pid?: number
  status?: string
}

/** a background session `swarm claude --bg` started: its `<id>.json` MCP config and the handle that config claims */
export interface BgRecord {
  file: string
  handle?: string
}

/** what `<id>.state.json` keeps of a worker this policy stopped or removed, so its waker can bring it back */
export interface BgState {
  sessionId: string
  cwd: string
  name?: string
  handle?: string
  stoppedAt?: number
  removedAt?: number
  rmRefused?: { at: number; reason: string }
}

/**
 * `stopAfterS`: idle seconds before a finished worker stops; `idleAfterS`: idle seconds before any worker stops, finished or not;
 * `Infinity` never; `remove`: whether a historic worker is removed
 */
export interface BgConfig {
  stopAfterS: number
  idleAfterS: number
  remove: boolean
}

export type AgentFacts = Pick<
  LocalAgent,
  | "id"
  | "address"
  | "handle"
  | "harness"
  | "parent"
  | "children"
  | "subagents"
  | "harness_session"
  | "state"
  | "presence"
  | "historic"
  | "worked_at"
  | "mail_at"
  | "connections"
  | "hibernate"
  | "unread"
  | "handed_back"
>

/** `record` is absent for a session `swarm claude --bg` did not start: such a session is stopped, never removed */
type Target = { id: string; entry: ClaudeEntry; agent: AgentFacts; record?: BgRecord }
export type Action =
  | ({ kind: "stop" } & Target)
  | ({ kind: "remove"; live: boolean } & Target)
  | ({ kind: "unhibernate" } & Target)
  | { kind: "keep"; id: string; entry: ClaudeEntry; agent?: AgentFacts; reason: string }

export interface PlanInput {
  entries: ClaudeEntry[]
  agents: AgentFacts[]
  records: Map<string, BgRecord>
  states: Map<string, BgState>
  /** the sessions `claude attach` holds, by id, name or session id */
  attached: Set<string>
  now: number
  config: BgConfig
  /** idle seconds that replace the configured thresholds */
  olderThanS?: number
  stopOnly?: boolean
  /** try a refused `claude rm` again at once */
  retryRefused?: boolean
  /** the session ids of the sessions the caller runs in, never stopped or removed */
  self?: Set<string>
}

/**
 * the endpoint of a session: the one its hooks named with its session id, else the one its record claims, unless that one runs another
 * session; without a record only its session id names it
 */
function endpointOf(entry: ClaudeEntry, record: BgRecord | undefined, agents: AgentFacts[]): AgentFacts | undefined {
  const bySession = entry.sessionId ? agents.find((agent) => agent.harness_session === entry.sessionId) : undefined
  if (bySession || !record) return bySession
  const byHandle = record.handle === undefined ? undefined : agents.find((agent) => agent.handle === record.handle)
  return byHandle && (byHandle.harness_session === null || byHandle.harness_session === entry.sessionId) ? byHandle : undefined
}

const attachedTo = (entry: ClaudeEntry, attached: Set<string>): boolean =>
  [entry.id, entry.name, entry.sessionId].some((key) => key !== undefined && attached.has(key))

/**
 * the workers under an endpoint that still run: a local child not historic and online or working, any child the broker's local agents do not
 * list, and its in-process subagents neither done nor historic
 */
export function liveChildren(agent: AgentFacts, agents: AgentFacts[]): number {
  const local = agents.filter((one) => one.parent === agent.address)
  const live = local.filter((one) => !one.historic && (one.presence === "online" || one.state === "working")).length
  return live + Math.max(0, agent.children - local.length) + agent.subagents
}

/** a worker with no workers of its own: the only kind ever removed */
const leaf = (agent: AgentFacts): boolean => agent.parent !== null && agent.children === 0
const finishedOf = (agent: AgentFacts): boolean => agent.state === "done" || agent.handed_back
/** the idle seconds before the policy stops a session */
const stopAfter = (agent: AgentFacts, config: BgConfig): number => (finishedOf(agent) ? Math.min(config.stopAfterS, config.idleAfterS) : config.idleAfterS)

/**
 * what to do with each background session: only a worker, an endpoint linked under a parent, with no live workers, no unread mail, no
 * `claude attach` and not the caller's own is ever stopped, and only while Claude shows it exactly idle. Such a worker stops after
 * `idleAfterS` without work, a finished one (done or handed back) after `stopAfterS` when sooner; a historic worker `swarm claude --bg`
 * started, with no children, is removed; `olderThanS` replaces the thresholds
 */
export function plan(input: PlanInput): Action[] {
  const actions: Action[] = []
  for (const entry of input.entries) {
    const id = entry.id
    if (entry.kind !== "background" || typeof id !== "string" || !SHORT_ID.test(id)) continue
    const keep = (reason: string, agent?: AgentFacts) => actions.push({ kind: "keep", id, entry, ...(agent ? { agent } : {}), reason })
    const record = input.records.get(id)
    const agent = endpointOf(entry, record, input.agents)
    if (!agent) {
      keep(record ? "no endpoint" : "no SCP endpoint, so nothing could wake it")
      continue
    }
    const live = typeof entry.pid === "number"
    if (live && agent.hibernate === CLAUDE_BG_PROVIDER && agent.connections > 0)
      actions.push({ kind: "unhibernate", id, entry, agent, ...(record ? { record } : {}) })
    if (!agent.parent) {
      keep("a root", agent)
      continue
    }
    const running = liveChildren(agent, input.agents)
    if (running > 0) {
      keep(`${running} live worker${running === 1 ? "" : "s"}`, agent)
      continue
    }
    if (agent.unread) {
      keep("unread mail", agent)
      continue
    }
    if (attachedTo(entry, input.attached)) {
      keep("attached", agent)
      continue
    }
    if ([entry.sessionId, agent.harness_session].some((key) => typeof key === "string" && input.self?.has(key))) {
      keep("the caller's own session", agent)
      continue
    }
    if (live && entry.status !== "idle") {
      keep(entry.status ?? "busy", agent)
      continue
    }
    const idleMs = input.now - Date.parse(agent.worked_at)
    const older = input.olderThanS
    const refused = input.states.get(id)?.rmRefused
    const holding = refused !== undefined && !input.retryRefused && input.now - refused.at < RM_RETRY_MS
    const threshold = older ?? stopAfter(agent, input.config)
    const removable =
      record !== undefined &&
      leaf(agent) &&
      (older !== undefined ? idleMs >= older * 1000 : input.config.remove && agent.historic && (!live || idleMs >= threshold * 1000))
    if (!input.stopOnly && !holding && removable) {
      actions.push({ kind: "remove", id, entry, agent, record, live })
      continue
    }
    if (!live) {
      keep(holding ? `claude rm refused: ${refused.reason}` : "stopped", agent)
      continue
    }
    if (!Number.isFinite(threshold)) {
      keep(finishedOf(agent) ? "stop_after_s and idle_after_s are Infinity" : "not done, and idle_after_s is Infinity", agent)
      continue
    }
    if (!(idleMs >= threshold * 1000)) {
      keep(`idle ${Math.max(0, Math.floor(idleMs / 1000))} s of ${threshold} s`, agent)
      continue
    }
    actions.push({ kind: "stop", id, entry, agent, ...(record ? { record } : {}) })
  }
  return actions
}

/** idle seconds: a number, a duration such as 30m, or Infinity; undefined when unreadable */
function seconds(value: unknown): number | undefined {
  if (value === Number.POSITIVE_INFINITY || value === "Infinity") return Number.POSITIVE_INFINITY
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined
  if (typeof value !== "string") return undefined
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim())
  try {
    return parseSeconds(value, "stop_after_s")
  } catch {
    return undefined
  }
}

function flag(value: unknown): boolean | undefined {
  if (value === true || value === "1" || value === "true") return true
  if (value === false || value === "0" || value === "false") return false
  return undefined
}

function configFile(env: Env): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readOwnedFile(join(configDir(env), "config.json"))) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const section = (file: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = file[key]
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/**
 * `$SCP_CLAUDE_BG_STOP_AFTER_S`, `$SCP_IDLE_AFTER_S` (alias `$SCP_CLAUDE_BG_IDLE_AFTER_S`) and `$SCP_CLAUDE_BG_REMOVE`, else
 * `claude_bg.stop_after_s`, `lifecycle.idle_after_s` (alias `claude_bg.idle_after_s`) and `claude_bg.remove` in config.json, else 600 s,
 * 600 s and true
 */
export function bgConfig(env: Env): BgConfig {
  const file = configFile(env)
  const bg = section(file, "claude_bg")
  const lifecycle = section(file, "lifecycle")
  return {
    stopAfterS: seconds(env.SCP_CLAUDE_BG_STOP_AFTER_S) ?? seconds(bg.stop_after_s) ?? STOP_AFTER_S,
    idleAfterS:
      seconds(env.SCP_IDLE_AFTER_S) ?? seconds(env.SCP_CLAUDE_BG_IDLE_AFTER_S) ?? seconds(lifecycle.idle_after_s) ?? seconds(bg.idle_after_s) ?? IDLE_AFTER_S,
    remove: flag(env.SCP_CLAUDE_BG_REMOVE) ?? flag(bg.remove) ?? true,
  }
}

/**
 * `$SCP_HISTORIC_AFTER_S`, else `historic_after_s` (alias `lifecycle.historic_after_s`) in config.json: seconds, a duration such as 2h, or
 * Infinity; undefined (and 0) leaves the broker's default
 */
export function historicAfterS(env: Env): number | undefined {
  const file = configFile(env)
  const value = seconds(env.SCP_HISTORIC_AFTER_S) ?? seconds(file.historic_after_s) ?? seconds(section(file, "lifecycle").historic_after_s)
  return value === 0 ? undefined : value
}

/** the sessions `swarm claude --bg` started, by short id */
export function readRecords(env: Env): Map<string, BgRecord> {
  const dir = bgDir(env)
  const records = new Map<string, BgRecord>()
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return records
  }
  for (const name of names) {
    const id = name.slice(0, -".json".length)
    if (!name.endsWith(".json") || !SHORT_ID.test(id)) continue
    try {
      const file = realpathSync(join(dir, name))
      const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: { scp?: { env?: { SCP_NAME?: unknown } } } }
      const handle = config.mcpServers?.scp?.env?.SCP_NAME
      records.set(id, { file, ...(typeof handle === "string" && handle ? { handle } : {}) })
    } catch {}
  }
  return records
}

const statePath = (env: Env, id: string) => join(bgDir(env), `${id}.state.json`)

export function readState(env: Env, id: string): BgState | undefined {
  try {
    const state = JSON.parse(readFileSync(statePath(env, id), "utf8")) as BgState
    return typeof state?.sessionId === "string" && typeof state.cwd === "string" ? state : undefined
  } catch {
    return undefined
  }
}

function writeState(env: Env, id: string, state: BgState): void {
  const path = statePath(env, id)
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

function readStates(env: Env, ids: Iterable<string>): Map<string, BgState> {
  const states = new Map<string, BgState>()
  for (const id of ids) {
    const state = readState(env, id)
    if (state) states.set(id, state)
  }
  return states
}

export type Exec = (bin: string, args: string[], options: { timeoutMs: number; env: Env; cwd?: string }) => Promise<{ code: number | null; out: string }>

/** runs `bin` with `args`, never through a shell */
const execRun: Exec = (bin, args, options) =>
  new Promise((done) => {
    execFile(
      bin,
      args,
      { timeout: options.timeoutMs, maxBuffer: 4 << 20, encoding: "utf8", env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}) },
      (error, stdout, stderr) => done({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, out: `${stdout ?? ""}${stderr ?? ""}` }),
    )
  })

/** the environment claude runs with: the caller's, without a launcher's identity or a wake request */
function claudeEnv(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !LAUNCHER_IDENTITY.includes(key) && !key.startsWith("SCP_WAKE_")))
}

const firstLine = (text: string): string =>
  text
    .trim()
    .split("\n")[0]!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 200)

export interface ClaudeBgDeps {
  exec?: Exec
  /** the process table's command lines, `ps -Ao args=`; null when it cannot be read */
  ps?: () => Promise<string | null>
  now?: () => number
  log?: (line: string) => void
}

type Claude = { bin: string; env: Env; exec: Exec }

function claudeOf(env: Env, deps: ClaudeBgDeps): Claude | undefined {
  const bin = whichOnPath("claude", env)
  return bin ? { bin, env: claudeEnv(env), exec: deps.exec ?? execRun } : undefined
}

/** `claude agents --json [--all]`; null when it failed */
async function listEntries(claude: Claude, all: boolean): Promise<ClaudeEntry[] | null> {
  const run = await claude.exec(claude.bin, ["agents", "--json", ...(all ? ["--all"] : [])], { timeoutMs: LIST_TIMEOUT_MS, env: claude.env })
  if (run.code !== 0) return null
  try {
    const listed = JSON.parse(run.out) as unknown
    return Array.isArray(listed) ? (listed.filter((entry) => entry && typeof entry === "object") as ClaudeEntry[]) : null
  } catch {
    return null
  }
}

/** the targets of `claude attach <target>` in the process table: an `attach` after a word with `claude` in its path */
export function attachTargets(table: string): Set<string> {
  const targets = new Set<string>()
  for (const line of table.split("\n")) {
    const words = line.trim().split(/\s+/)
    const at = words.indexOf("attach")
    if (at > 0 && words[at + 1] && words.slice(0, at).some((word) => word.split("/").some((part) => part.includes("claude")))) targets.add(words[at + 1]!)
  }
  return targets
}

const psTable = (env: Env, exec: Exec) => async (): Promise<string | null> => {
  const run = await exec("ps", ["-Ao", "args="], { timeoutMs: LIST_TIMEOUT_MS, env })
  return run.code === 0 ? run.out : null
}

/** how the policy acts on the broker: in the broker's own task, or over its socket as the human */
export interface BgPort {
  agents(): Promise<AgentFacts[]>
  hibernate(agent: AgentFacts, ref: string): Promise<void>
  unhibernate(agent: AgentFacts): Promise<void>
  /** the waker runs at once when a message is due */
  kick(agent: AgentFacts, ref: string): Promise<void>
}

export function taskPort(context: BrokerTaskContext): BgPort {
  return {
    agents: async () => context.agents(),
    hibernate: async (agent, ref) => context.hibernate(agent.id, CLAUDE_BG_PROVIDER, ref),
    unhibernate: async (agent) => context.unhibernate(agent.id),
    kick: async (agent, ref) => context.hibernate(agent.id, CLAUDE_BG_PROVIDER, ref),
  }
}

type Act = Exclude<Action, { kind: "keep" }>
export type Outcome = { action: Act; ok: boolean; note: string }

const later = (now: string | null | undefined, then: string | null): boolean => !!now && (then === null || Date.parse(now) > Date.parse(then))
/** the session got mail or did work since `then`, gained live workers, lost its parent, or is gone */
function changed(agents: AgentFacts[], then: AgentFacts): boolean {
  const now = agents.find((one) => one.id === then.id)
  return (
    !now ||
    now.unread ||
    later(now.worked_at, then.worked_at) ||
    later(now.mail_at, then.mail_at) ||
    (then.parent !== null && !now.parent) ||
    liveChildren(now, agents) > 0
  )
}

async function current(port: BgPort, agent: AgentFacts): Promise<AgentFacts | undefined> {
  return (await port.agents()).find((one) => one.id === agent.id)
}

type Run = { claude: Claude; env: Env; now: () => number; attached: () => Promise<Set<string> | null> }

const runOf = (claude: Claude, env: Env, now: () => number, ps: () => Promise<string | null>): Run => ({
  claude,
  env,
  now,
  attached: async () => {
    const table = await ps()
    return table === null ? null : attachTargets(table)
  },
})

/** why the planned worker may no longer be stopped or removed: it changed since the plan, or a `claude attach` holds it now */
async function moved(target: Target, port: BgPort, run: Run): Promise<string | null> {
  if (changed(await port.agents(), target.agent)) return "it got work"
  const attached = await run.attached()
  if (attached === null) return "ps failed, so attached sessions are unknown"
  return attachedTo(target.entry, attached) ? "attached" : null
}

/**
 * hibernates the worker, checks nothing reached it, stops it, then brings it back at once when a message raced in: through its waker while
 * the message is unread, else by respawning it awake, since its shim may have handed the message to the session just before the stop
 */
async function stopWorker(target: Target, port: BgPort, run: Run): Promise<string | null> {
  const { id, entry, agent } = target
  const { claude } = run
  const sessionId = entry.sessionId
  if (!sessionId || !SESSION_ID.test(sessionId) || !entry.cwd) return "no session id or cwd"
  const ref = reviveRef(sessionId, entry.cwd, entry.name)
  const previous = readState(run.env, id)
  const restore = () => {
    if (previous) writeState(run.env, id, previous)
    else unlinkSync(statePath(run.env, id))
  }
  writeState(run.env, id, { sessionId, cwd: entry.cwd, ...(entry.name ? { name: entry.name } : {}), handle: agent.handle })
  await port.hibernate(agent, ref)
  const listed = (await listEntries(claude, true))?.find((one) => one.id === id)
  const why =
    (await moved(target, port, run)) ??
    (listed?.status === "idle" && listed.pid === entry.pid ? null : `claude shows it ${listed ? (listed.status ?? "busy") : "unlisted"}`)
  if (why) {
    await port.unhibernate(agent)
    restore()
    return why
  }
  const stopped = await claude.exec(claude.bin, ["stop", id], { timeoutMs: ACT_TIMEOUT_MS, env: claude.env })
  if (stopped.code !== 0) {
    await port.unhibernate(agent)
    restore()
    return `claude stop failed: ${firstLine(stopped.out) || `exit ${stopped.code}`}`
  }
  writeState(run.env, id, { sessionId, cwd: entry.cwd, ...(entry.name ? { name: entry.name } : {}), handle: agent.handle, stoppedAt: run.now() })
  const after = await current(port, agent)
  if (!after) return null
  if (after.unread) {
    await port.kick(agent, ref)
    return "mail raced the stop, so its waker brings it back"
  }
  if (!later(after.mail_at, agent.mail_at)) {
    if (after.hibernate !== CLAUDE_BG_PROVIDER) await port.hibernate(agent, ref)
    return null
  }
  await port.unhibernate(agent)
  if (target.record) armTicket(target.record.file, undefined)
  const respawned = await claude.exec(claude.bin, ["respawn", id], { timeoutMs: ACT_TIMEOUT_MS, env: claude.env })
  if (respawned.code === 0) return "mail raced the stop, so it was respawned"
  await port.hibernate(agent, ref)
  return `mail raced the stop and claude respawn failed: ${firstLine(respawned.out) || `exit ${respawned.code}`}`
}

async function removeWorker(target: Target & { live: boolean }, port: BgPort, run: Run): Promise<string | null> {
  const { id, entry, agent } = target
  const { claude, env, now } = run
  const sessionId = entry.sessionId
  if (!sessionId || !SESSION_ID.test(sessionId) || !entry.cwd) return "no session id or cwd"
  const ref = reviveRef(sessionId, entry.cwd, entry.name)
  if (target.live) {
    const failed = await stopWorker(target, port, run)
    if (failed) return failed
  } else {
    const previous = readState(env, id)
    writeState(env, id, { ...previous, sessionId, cwd: entry.cwd, ...(entry.name ? { name: entry.name } : {}), handle: agent.handle })
    if (agent.hibernate !== CLAUDE_BG_PROVIDER) await port.hibernate(agent, ref)
  }
  const why = await moved(target, port, run)
  if (why) {
    await port.kick(agent, ref)
    return why
  }
  const { removedAt: _removed, rmRefused: _refused, ...earlier } = readState(env, id) ?? {}
  const state: BgState = { ...earlier, sessionId, cwd: entry.cwd, ...(entry.name ? { name: entry.name } : {}), handle: agent.handle }
  writeState(env, id, state)
  const removed = await claude.exec(claude.bin, ["rm", id], { timeoutMs: ACT_TIMEOUT_MS, env: claude.env })
  if (removed.code !== 0) {
    const reason = firstLine(removed.out) || `exit ${removed.code}`
    writeState(env, id, { ...state, rmRefused: { at: now(), reason } })
    return `claude rm refused: ${reason}`
  }
  const { rmRefused: _, ...kept } = state
  writeState(env, id, { ...kept, removedAt: now() })
  if ((await current(port, agent))?.unread) await port.kick(agent, ref)
  return null
}

const acts = (actions: Action[]): Act[] => actions.filter((action): action is Act => action.kind !== "keep")

async function apply(actions: Act[], port: BgPort, run: Run): Promise<Outcome[]> {
  const outcomes: Outcome[] = []
  for (const action of actions) {
    let failed: string | null
    try {
      if (action.kind === "unhibernate") {
        await port.unhibernate(action.agent)
        failed = null
      } else failed = action.kind === "stop" ? await stopWorker(action, port, run) : await removeWorker(action, port, run)
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error)
    }
    outcomes.push({ action, ok: failed === null, note: failed ?? "" })
  }
  return outcomes
}

const verb = (action: Act) => (action.kind === "stop" ? "stopped" : action.kind === "remove" ? "removed" : "woke")

/**
 * whether a worker may be due for a stop or a removal, read from the broker alone, so an idle broker never runs claude; only one
 * `swarm claude --bg` started (`recorded`) is ever removed
 */
function maybeDue(agent: AgentFacts, agents: AgentFacts[], state: BgState | undefined, config: BgConfig, now: number, recorded: boolean): boolean {
  if (agent.hibernate === CLAUDE_BG_PROVIDER && agent.connections > 0) return true
  if (!agent.parent || agent.unread || liveChildren(agent, agents) > 0) return false
  if (recorded && config.remove && agent.historic && leaf(agent)) return !state?.removedAt && !(state?.rmRefused && now - state.rmRefused.at < RM_RETRY_MS)
  if (agent.hibernate === CLAUDE_BG_PROVIDER) return false
  return now - Date.parse(agent.worked_at) >= stopAfter(agent, config) * 1000
}

/** a Claude Code endpoint whose hooks named its session: it may run in a background session no record covers */
const claudeAgent = (agent: AgentFacts): boolean => agent.harness === "claude-code" && agent.harness_session !== null

/** the broker's task: stops and removes idle workers by the configured policy, read again on each run */
export function claudeBgTask(env: Env = process.env, deps: ClaudeBgDeps = {}): BrokerTask {
  /** the short ids of the background sessions in the last listing, by session id */
  const sessions = new Map<string, string>()
  /** the records the last listing covered */
  const seen = new Set<string>()
  /** endpoints without a record the last listing showed nothing to stop for, with their `worked_at` then */
  const quiet = new Map<string, string>()
  let listed = false
  return {
    name: "claude-bg",
    everyMs: CLAUDE_BG_EVERY_MS,
    async run(context) {
      const records = readRecords(env)
      const unrecorded = (agent: AgentFacts) => {
        const id = agent.harness_session !== null ? sessions.get(agent.harness_session) : undefined
        return claudeAgent(agent) && (id === undefined || !records.has(id))
      }
      if (!records.size && !context.agents().some(unrecorded)) return
      const config = bgConfig(env)
      const now = deps.now ?? Date.now
      const handles = new Map([...records].flatMap(([id, record]) => (record.handle ? [[record.handle, id] as const] : [])))
      const idOf = (agent: AgentFacts) =>
        agent.harness_session !== null ? (sessions.get(agent.harness_session) ?? handles.get(agent.handle)) : handles.get(agent.handle)
      const isDue = () => {
        const agents = context.agents()
        return agents.some((agent) => {
          const id = idOf(agent)
          if (id !== undefined && records.has(id)) return maybeDue(agent, agents, readState(env, id), config, now(), true)
          if (!unrecorded(agent) || quiet.get(agent.id) === agent.worked_at) return false
          return maybeDue(agent, agents, id === undefined ? undefined : readState(env, id), config, now(), false)
        })
      }
      if (listed && [...records.keys()].every((id) => seen.has(id)) && !isDue()) return
      const claude = claudeOf(env, deps)
      if (!claude) return
      const entries = await listEntries(claude, true)
      if (!entries) return
      listed = true
      seen.clear()
      for (const id of records.keys()) seen.add(id)
      sessions.clear()
      const live = new Set<string>()
      for (const entry of entries)
        if (entry.kind === "background" && entry.id && SHORT_ID.test(entry.id) && entry.sessionId) {
          sessions.set(entry.sessionId, entry.id)
          if (typeof entry.pid === "number") live.add(entry.id)
        }
      quiet.clear()
      for (const agent of context.agents()) {
        const id = agent.harness_session !== null ? sessions.get(agent.harness_session) : undefined
        if (unrecorded(agent) && (id === undefined || !live.has(id))) quiet.set(agent.id, agent.worked_at)
      }
      if (!isDue()) return
      const ps = deps.ps ?? psTable(claude.env, claude.exec)
      const table = await ps()
      if (table === null) return
      const actions = plan({
        entries,
        agents: context.agents(),
        records,
        states: readStates(env, sessions.values()),
        attached: attachTargets(table),
        now: now(),
        config,
      })
      const log = deps.log ?? context.log
      for (const { action, ok, note } of await apply(acts(actions), taskPort(context), runOf(claude, env, now, ps)))
        if (action.kind !== "unhibernate" || !ok)
          log(`${CLI_NAME} claude: ${ok ? verb(action) : "kept"} ${action.id} (${action.agent.address})${ok ? "" : `: ${note}`}`)
    },
  }
}

/** the broker over its socket as the human: `agents`, and `hibernate` with an endpoint, which also runs a due waker */
async function socketPort(env: Env): Promise<{ port: BgPort; close(): void }> {
  const dir = relayDir(env as NodeJS.ProcessEnv)
  const client = await connectBroker(dir, undefined, { env })
  try {
    await client.hello({ human: true, tty: terminalAttached(process, false), cwd: safeCwd(), brief: true })
  } catch (error) {
    client.close()
    throw error
  }
  const hibernate = async (agent: AgentFacts, wake: string, ref?: string) => {
    await client.request("hibernate", { endpoint: agent.address, wake, ...(ref ? { ref } : {}) })
  }
  return {
    port: {
      agents: async () => (await client.request<{ agents: AgentFacts[] }>("agents")).agents,
      hibernate: (agent, ref) => hibernate(agent, CLAUDE_BG_PROVIDER, ref),
      unhibernate: (agent) => hibernate(agent, "none"),
      kick: (agent, ref) => hibernate(agent, CLAUDE_BG_PROVIDER, ref),
    },
    close: () => client.close(),
  }
}

/** the Claude Code session the caller runs in, by its session id */
const selfSessions = (env: Env): Set<string> => new Set(env.CLAUDE_CODE_SESSION_ID ? [env.CLAUDE_CODE_SESSION_ID] : [])

type Role = "orchestrator" | "worker" | "unknown"

const roleOf = (agent: AgentFacts | undefined): Role => (!agent ? "unknown" : !agent.parent || agent.children > 0 ? "orchestrator" : "worker")

/** `swarm claude ls [--all] [--json]`: the background sessions with their SCP role, orchestrators first */
async function lsCommand(argv: string[], env: Env, out: (line: string) => void, deps: ClaudeBgDeps): Promise<number> {
  const all = argv.includes("--all")
  const json = argv.includes("--json")
  const unknown = argv.find((arg) => arg !== "--all" && arg !== "--json")
  if (unknown !== undefined) throw new RelayUsage(`${CLI_NAME} claude ls takes --all and --json, not ${unknown}`)
  const claude = claudeOf(env, deps)
  if (!claude) throw new RelayUsage("claude is not on PATH")
  const entries = await listEntries(claude, all)
  if (!entries) throw new Error(`${CLI_NAME} claude: claude agents --json failed`)
  const records = readRecords(env)
  let agents: AgentFacts[] | undefined
  try {
    const { port, close } = await socketPort(env)
    try {
      agents = await port.agents()
    } finally {
      close()
    }
  } catch (error) {
    note(`${CLI_NAME} claude: no endpoints, so every role shows unknown (${error instanceof Error ? error.message : String(error)})`)
  }
  const policy = new Map<string, string>()
  if (agents) {
    const table = await (deps.ps ?? psTable(claude.env, claude.exec))()
    const config = bgConfig(env)
    const listed = all ? entries : await listEntries(claude, true)
    for (const action of plan({
      entries: listed ?? entries,
      agents,
      records,
      states: readStates(env, records.keys()),
      attached: table === null ? new Set() : attachTargets(table),
      now: (deps.now ?? Date.now)(),
      config,
      self: selfSessions(env),
    }))
      if (action.kind !== "unhibernate")
        policy.set(action.id, action.kind === "keep" ? `kept: ${action.reason}` : table === null ? "ps failed, so attached is unknown" : `due: ${action.kind}`)
  }
  const known = agents ?? []
  const rows = entries
    .filter((entry) => entry.kind === "background" && typeof entry.id === "string")
    .map((entry) => {
      const record = records.get(entry.id!)
      const agent = endpointOf(entry, record, known)
      return {
        id: entry.id!,
        name: entry.name ?? null,
        state: entry.state ?? null,
        status: entry.status ?? null,
        role: roleOf(agent),
        endpoint: agent?.address ?? null,
        cwd: entry.cwd ?? null,
        swarm: record !== undefined,
        policy: policy.get(entry.id!) ?? null,
      }
    })
    .sort((a, b) => Number(b.role === "orchestrator") - Number(a.role === "orchestrator"))
  if (json) out(JSON.stringify(rows))
  else if (!rows.length) note(`${CLI_NAME} claude: no background sessions`)
  else
    printTable([
      ["ID", "NAME", "STATE", "ROLE", "ENDPOINT", "POLICY", "CWD"],
      ...rows.map((row) => [
        row.id,
        row.name ?? "",
        [row.state, row.status].filter(Boolean).join("/"),
        row.role,
        row.endpoint ?? "-",
        row.policy ?? "-",
        row.cwd ?? "",
      ]),
    ])
  return 0
}

/** `swarm claude prune [--dry-run] [--stop-only] [--older-than <dur>]`: stops and removes finished workers now, with the policy's guards */
async function pruneCommand(argv: string[], env: Env, out: (line: string) => void, deps: ClaudeBgDeps): Promise<number> {
  let dryRun = false
  let stopOnly = false
  let olderThanS: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--dry-run") dryRun = true
    else if (arg === "--stop-only") stopOnly = true
    else if (arg === "--older-than" || arg.startsWith("--older-than=")) {
      const value = arg === "--older-than" ? argv[++i] : arg.slice("--older-than=".length)
      if (value === undefined) throw new RelayUsage(`${CLI_NAME} claude prune --older-than takes a duration such as 30m, 2h or 1d`)
      try {
        olderThanS = parseSeconds(value, "--older-than")
      } catch (error) {
        throw new RelayUsage(error instanceof Error ? error.message : String(error))
      }
    } else throw new RelayUsage(`${CLI_NAME} claude prune takes --dry-run, --stop-only and --older-than <duration>, not ${arg}`)
  }
  const claude = claudeOf(env, deps)
  if (!claude) throw new RelayUsage("claude is not on PATH")
  let opened: Awaited<ReturnType<typeof socketPort>>
  try {
    opened = await socketPort(env)
  } catch (error) {
    throw new Error(
      `${CLI_NAME} claude prune needs the relay broker, which knows each session's endpoint (${error instanceof Error ? error.message : String(error)}); start it with ${CLI_NAME} daemon`,
    )
  }
  try {
    const entries = await listEntries(claude, true)
    if (!entries) throw new Error(`${CLI_NAME} claude: claude agents --json --all failed`)
    const ps = deps.ps ?? psTable(claude.env, claude.exec)
    const table = await ps()
    if (table === null) throw new Error(`${CLI_NAME} claude: ps failed, so attached sessions are unknown`)
    const records = readRecords(env)
    const now = deps.now ?? Date.now
    const actions = plan({
      entries,
      agents: await opened.port.agents(),
      records,
      states: readStates(env, records.keys()),
      attached: attachTargets(table),
      now: now(),
      config: bgConfig(env),
      ...(olderThanS !== undefined ? { olderThanS } : {}),
      stopOnly,
      retryRefused: true,
      self: selfSessions(env),
    })
    for (const action of actions) if (action.kind === "keep") out(`keep ${action.id}${action.agent ? ` ${action.agent.address}` : ""}: ${action.reason}`)
    const acting = acts(actions).filter((action) => action.kind !== "unhibernate")
    if (dryRun) {
      for (const action of acting) out(`would ${action.kind} ${action.id} ${action.agent.address}`)
      return 0
    }
    let failed = 0
    for (const { action, ok, note: why } of await apply(acting, opened.port, runOf(claude, env, now, ps))) {
      if (!ok) failed++
      out(ok ? `${verb(action)} ${action.id} ${action.agent.address}` : `kept ${action.id} ${action.agent.address}: ${why}`)
    }
    return failed ? 1 : 0
  } finally {
    opened.close()
  }
}

/** `swarm claude ls` and `swarm claude prune` */
export async function claudeBgCommand(
  verbName: "ls" | "prune",
  argv: string[],
  env: Env = process.env,
  out: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
  deps: ClaudeBgDeps = {},
): Promise<number> {
  return verbName === "ls" ? lsCommand(argv, env, out, deps) : pruneCommand(argv, env, out, deps)
}

const decline = (out: (text: string) => void, reason: string): number => {
  out(`${JSON.stringify({ declined: reason })}\n`)
  return 77
}

/**
 * puts the run's wake ticket in the scp server env of a session's MCP config, or takes a stale one out, so the revived session's shim takes
 * its endpoint back with it (SPEC section 6.4 rule 6); false when the config cannot be read or written
 */
function armTicket(file: string, ticket: string | undefined): boolean {
  let temp: string | undefined
  try {
    const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: { scp?: { env?: Record<string, string> } } }
    const scp = config.mcpServers?.scp
    if (!scp || typeof scp !== "object") return false
    const vars = scp.env && typeof scp.env === "object" ? scp.env : {}
    if (vars.SCP_WAKE_TICKET === ticket) return true
    const { SCP_WAKE_TICKET: _, ...rest } = vars
    scp.env = ticket ? { ...rest, SCP_WAKE_TICKET: ticket } : rest
    const candidate = `${file}.${crypto.randomUUID()}.tmp`
    const fd = openSync(candidate, "wx", 0o600)
    temp = candidate
    try {
      writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
    return true
  } catch {
    if (temp) {
      try {
        unlinkSync(temp)
      } catch {}
    }
    return false
  }
}

/** whether Claude Code's transcripts are readable and none of them is the session's: its transcript is gone, so no resume can bring it back */
function transcriptGone(env: Env, sessionId: string): boolean {
  const root = claudeTranscripts(env)
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return false
  }
  return !projects.some((project) => existsSync(join(root, project, `${sessionId}.jsonl`)))
}

/**
 * `swarm claude-wake`, the broker's built-in `claude-bg` waker: the ref is the revive record (or the bare session id) of a worker the policy
 * stopped or removed. A stopped session is respawned; a removed one is resumed in the background in its own directory, with its MCP config
 * when `swarm claude --bg` started it. Either way the run's wake ticket goes into that config first, so the session's shim takes the same
 * endpoint back with it; a session without one has no config to arm. It wakes only the endpoint's own session: the handle its stop saved,
 * else the harness session its hooks reported, else its launcher record's handle must match, and never one with neither a record nor a
 * saved stop
 */
export async function claudeWakeCommand(env: Env = process.env, deps: ClaudeBgDeps & { stdout?: (text: string) => void } = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => void process.stdout.write(text))
  const revive = reviveRecord(env.SCP_WAKE_REF ?? "")
  const ref = refSession(env.SCP_WAKE_REF ?? "")
  const id = ref.slice(0, 8)
  if (!SESSION_ID.test(ref) || !SHORT_ID.test(id)) return decline(out, "unresumable")
  const ticket = env.SCP_WAKE_TICKET && WAKE_TICKET.test(env.SCP_WAKE_TICKET) ? env.SCP_WAKE_TICKET : undefined
  if (env.SCP_WAKE_TICKET && !ticket) return 1
  const claude = claudeOf(env, deps)
  if (!claude) {
    note(`${CLI_NAME} claude-wake: claude is not on PATH`)
    return 1
  }
  const entries = await listEntries(claude, true)
  if (!entries) {
    note(`${CLI_NAME} claude-wake: claude agents --json --all failed`)
    return 1
  }
  const entry = entries.find((one) => one.sessionId === ref || (one.id === id && one.kind === "background"))
  const record = readRecords(env).get(id)
  const state = readState(env, id)
  const handles = [env.SCP_WAKE_HANDLE, env.SCP_WAKE_ENDPOINT?.slice(env.SCP_WAKE_ENDPOINT.lastIndexOf("/") + 1)].filter(
    (handle): handle is string => handle !== undefined,
  )
  const owned =
    state?.handle !== undefined
      ? handles.every((handle) => handle === state.handle)
      : env.SCP_WAKE_SESSION
        ? env.SCP_WAKE_SESSION === ref
        : record !== undefined && handles.every((handle) => handle === record.handle)
  if (
    (!record && !state) ||
    (entry?.sessionId !== undefined && entry.sessionId !== ref) ||
    !owned ||
    (revive && (revive.harness !== "claude-code" || (state !== undefined && state.sessionId !== revive.session)))
  )
    return decline(out, "unresumable")
  if (record && !armTicket(record.file, ticket)) {
    note(`${CLI_NAME} claude-wake: could not update the wake ticket`)
    return 1
  }
  if (entry && typeof entry.pid === "number") return 0
  if (entry) {
    const run = await claude.exec(claude.bin, ["respawn", id], { timeoutMs: ACT_TIMEOUT_MS, env: claude.env })
    if (run.code === 0) return 0
    note(`${CLI_NAME} claude-wake: claude respawn ${id} failed: ${firstLine(run.out) || `exit ${run.code}`}`)
    return 1
  }
  if (!state || state.sessionId !== ref) return decline(out, "unresumable")
  let dir = false
  try {
    dir = statSync(state.cwd).isDirectory()
  } catch {}
  if (!dir || transcriptGone(env, ref)) return decline(out, "gone")
  const run = await claude.exec(
    claude.bin,
    [
      "--bg",
      "--resume",
      ref,
      ...(state.name && SAFE_NAME.test(state.name) ? ["--name", state.name] : []),
      WAKE_PROMPT,
      ...(record ? ["--mcp-config", record.file] : []),
    ],
    { timeoutMs: ACT_TIMEOUT_MS, env: claude.env, cwd: state.cwd },
  )
  if (run.code === 0) {
    const { removedAt: _removed, ...resumed } = state
    writeState(env, id, resumed)
    return 0
  }
  note(`${CLI_NAME} claude-wake: claude --bg --resume failed: ${firstLine(run.out) || `exit ${run.code}`}`)
  return 1
}
