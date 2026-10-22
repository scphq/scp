import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, sep } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import {
  type Attachment,
  BROKER_CAPABILITIES,
  BROKER_WAKES,
  type Claim,
  CLI_NAME,
  type EndpointView,
  LIMITS,
  parsePolicy,
  PREAMBLE,
  type Presence,
  PROTOCOL,
  RelayError,
  type ScopeActor,
  type ScopePreset,
  type SendParams,
  type SendResult,
  SERVER_FIELDS,
  SPAWN_PROVIDER,
  type Sql,
  type StopWaitResult,
  stripControl,
  type Wake,
} from "@scp-dev/core"
import { FederatedCore } from "@scp-dev/hub"
import { type Bridge, type BridgeConfig, type BridgeHooks, remoteSend, startBridge } from "./bridge"
import { type Deliver, type JudgeClientFactory, JudgeGate } from "./judge-gate"
import { releaseBrokerLock, takeBrokerLock } from "./lock"
import { encodeLine, LineReader, LineWriter, MAX_LINE } from "./ndjson"
import { accountHome, accountHomeVerified, policyPath as defaultPolicyPath, privateDir, shortHostname, socketPath } from "./paths"
import { writeSessionMarker } from "./sessions"
import { Conn } from "./socket"
import { type Database, openDatabase } from "./sqlite"
import { startWakers, type Wakers } from "./wakers"

export interface BrokerOptions {
  dir: string
  /** the policy file; missing means open */
  policyPath?: string | undefined
  /** the user part of addresses */
  user?: string | undefined
  /** exit after this long with no connection and nothing waiting (default 30 min); 0 never */
  idleMs?: number | undefined
  now?: (() => number) | undefined
  /** extra roots attachments may point into, besides the sender's cwd */
  roots?: string[] | undefined
  /** bytes queued for one connection before fleet events to it are dropped and replies end it (default 4 MiB) */
  outboundCapBytes?: number | undefined
  /** requests one connection may have in flight (default 32) */
  maxPending?: number | undefined
  /** how long a request line may stay unfinished (default 30 s) */
  partialLineMs?: number | undefined
  /** where the broker reports its own failures (default stderr) */
  log?: ((line: string) => void) | undefined
  /** this host's machine name on the hub (default the bridge's), and for `machine:` selectors (default the short hostname) */
  machine?: string | undefined
  /** the link to the hub; without it the broker never opens a network connection */
  bridge?: BridgeConfig | undefined
  /** reads the bridge configuration again for bridge_relink; one that appeared or names another hub or machine restarts the broker */
  bridgeConfig?: (() => Promise<BridgeConfig | undefined>) | undefined
  /** experimental: another link to other machines in place of the hub's, started only when `bridge` is unset */
  link?: LinkFactory | undefined
  /** how often presence that decays without a request (a hook-only endpoint) is checked for changes (default 60 s) */
  presenceEveryMs?: number | undefined
  /** how often the broker checks it still owns its socket and lock, stopping once another broker or a wiped state directory took them (default 2 s) */
  ownershipEveryMs?: number | undefined
  /** when a process started, as a harness-instance key spells it (default `ps`); a spawn's worker stops counting once its process's differs */
  startOf?: ((pid: number, expected: string) => string | undefined) | undefined
  /** where a judge model's key_env is read (default the broker's environment) */
  env?: Record<string, string | undefined> | undefined
  /** the judge model client for a policy's `judge.model` (default the provider's HTTP API) */
  judgeClient?: JudgeClientFactory | undefined
  /** the wake hooks' configuration file (default wakers.json beside the policy file), read again when it changes */
  wakersPath?: string | undefined
  /** the wake hooks by provider, in place of the file */
  wakers?: Record<string, unknown> | undefined
  /** wake hooks this broker has built in, by provider (the reference CLI's `spawn`), configured even without a wakers file; a configured provider of the same name replaces one */
  builtinWakers?: Record<string, unknown> | undefined
}

/** what a link gets from the broker: its core, the remote hooks a bridge gets, and a send as a local endpoint or a mirrored one through the judge */
export interface LinkContext {
  core: FederatedCore
  hooks: BridgeHooks
  send: Deliver
}

export type LinkFactory = (context: LinkContext) => Bridge

export interface Broker {
  socket: string
  core: FederatedCore
  bridge: Bridge | null
  judge: JudgeGate
  policyFile: string
  stopped: Promise<void>
  stop(): Promise<void>
}

interface Connection {
  reader: LineReader
  writer: LineWriter
  endpoint?: string | undefined
  /** a connection that only looks: list, status, watch, log and policy */
  observer: boolean
  /** set when the connection claimed the human inbox: whether it said a terminal was attached */
  tty?: boolean
  /** the connection holds the human inbox */
  human?: boolean
  /** a human hello bound to the agent of this shell's lineage said a terminal was attached: the human at that agent's shell */
  terminal?: boolean
  /**
   * the lineage endpoint of an observer, or of a hello bound to it: the connection sees and acts with that endpoint's view,
   * never widening unless `own`, and never counts as connected
   */
  lineage?: string | undefined
  /** the lineage endpoint is the one of the harness whose shell runs the command, bound with no grant: it acts with the endpoint's session reach */
  own?: boolean
  /** the connection claimed with a grant or a wake ticket, as a spawn holding its worker does: it may give a durable ref */
  holder?: boolean
  /** a broker wake's waker run bound by its wake ticket: the connection acts only while the ticket is current */
  ticket?: string
  /** a hook's connection: it posts activity and status, and never counts as connected */
  transient?: boolean
  /** a hook connection's harness process key, from its claim */
  process?: string
  /** a one-shot CLI command's connection: its comings and goings are not fleet presence events */
  brief?: boolean
  /** the endpoint whose wake this connection set: it counts as its waker until it closes or sets none */
  waker?: string | undefined
  cwd?: string | undefined
  watching: boolean
  closed: boolean
  inFlight: number
  /** lines read but not started while `inFlight` is at the cap; the socket is paused meanwhile */
  queue: string[]
  queueHead: number
  lineTimer?: ReturnType<typeof setTimeout> | undefined
  /** a line passed the cap: what follows is discarded, and too_large goes once the lines before it are answered */
  tooLarge?: boolean
}

const SWEEP_MS = 10 * 60_000
const PRESENCE_MS = 60_000
/** how long a broker wake's run holds what it was offered: past the time its harness takes to queue it */
const TICKET_HOLD_S = 180
const OWNERSHIP_MS = 2_000
/** pending connects the socket queues before refusing more: hooks of many sessions arrive in bursts */
const LISTEN_BACKLOG = 1024
/** how long a hibernate waits for the hub to take its mirror */
const HIBERNATE_BARRIER_MS = 10_000
const OBSERVER_METHODS = new Set(["list", "snapshot", "watch", "log", "policy", "policy_check", "cloud_status", "bridge_relink"])
const SCOPE_METHODS = new Set([
  "rules",
  "rules_set",
  "rules_widen",
  "rules_lift",
  "grant",
  "group",
  "admin",
  "peers",
  "why",
  "spawn_exit",
  "spawn_steers",
  "spawn_end",
  "peek",
  "peek_set",
  "peek_who",
])
const CHANGES_SCOPE = new Set(["rules_set", "rules_widen", "rules_lift", "group"])
/** how often a waiting ask rechecks whether its recipients ended, since only deliveries to the asker wake it */
const ASK_RECHECK_MS = 1000
/** how often a waiting stop rechecks its workers, since a worker's exit or lapse wakes no one */
const STOP_RECHECK_MS = 1000
const TRANSIENT_METHODS = new Set([
  "event",
  "status",
  "whoami",
  "inject",
  "injected",
  "peek_turn",
  "stop_wait",
  "prompted",
  "title_infer",
  "subagent_title",
  "wake",
])
const GRANT_UNBOUND = `a spawn-env grant binds only a new harness process: run the harness with it, or name the child (${CLI_NAME} spawn-env --name / --as)`

/** the workers' messages and handbacks a stop's push would show, and those of theirs left unread past it */
function workerResults(result: StopWaitResult): number {
  return result.messages.length - (result.others_shown ?? 0) + result.more
}

/** the workers still running that sent none of the messages a stop's push would show, and those not joined yet */
function othersRunning(result: StopWaitResult): number {
  const senders = new Set(result.messages.slice(0, result.messages.length - (result.others_shown ?? 0)).map((m) => m.from.address))
  return result.workers.filter((address) => !senders.has(address)).length + result.starting
}

type Request = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown }

/** whether a process runs (one of another user's counts too) */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

const STARTS_TTL_MS = 5000
const starts = new Map<number, { start: string | undefined; at: number }>()

/**
 * when `pid` started, as a harness-instance key spells it (`ps -o lstart=` in the C locale, runs of whitespace as `-`), cached a few seconds
 * while it matches `expected`; a mismatch is read again, so a pid reused since never fails against the old start
 */
function startedAt(pid: number, expected: string): string | undefined {
  const now = Date.now()
  const cached = starts.get(pid)
  if (cached && cached.at > now - STARTS_TTL_MS && cached.start === expected) return cached.start
  let start: string | undefined
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    })
    const text = out.status === 0 && !out.error ? (out.stdout?.toString() ?? "").trim().replace(/\s+/g, "-") : ""
    start = /^[A-Za-z0-9:-]{1,64}$/.test(text) ? text : undefined
  } catch {}
  if (start === undefined) return undefined
  if (starts.size > 1024) starts.clear()
  starts.set(pid, { start, at: now })
  return start
}

/** who a connection acts for, for the calls only the harness process holding an endpoint may make through its hooks */
/** a view whose waker the broker runs on its periodic check: hibernated, or with a broker wake */
function wakeable(view: EndpointView): boolean {
  return view.presence === "hibernated" || BROKER_WAKES.includes(view.wake as Wake)
}

function hookOf(s: Conn<Connection>): { transient: boolean; process?: string } {
  return { transient: s.data.transient === true, ...(s.data.process ? { process: s.data.process } : {}) }
}

export async function startBroker(options: BrokerOptions): Promise<Broker> {
  const dir = privateDir(options.dir)
  const lock = takeBrokerLock(join(dir, "broker.lock"))
  const socket = socketPath(dir)
  const connections = new Set<Conn<Connection>>()
  const waiters = new Map<string, Set<() => void>>()
  const policyFile = options.policyPath ?? defaultPolicyPath()
  if (!options.policyPath && !accountHomeVerified())
    (options.log ?? console.error)(`relay broker: the user database has no home for this account; the policy path ${policyFile} comes from HOME`)
  let policyText: string | null | undefined
  let policyError: string | null = null
  const outboundCap = options.outboundCapBytes ?? 4 * 1024 * 1024
  const maxPending = options.maxPending ?? 32
  const partialLineMs = options.partialLineMs ?? 30_000
  const log = options.log ?? ((line: string) => console.error(line))
  const idleMs = options.idleMs ?? 30 * 60_000
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let pending = 0
  let closing = false
  let stopping: Promise<void> | undefined
  let resolveStopped!: () => void
  const stopped = new Promise<void>((resolve) => (resolveStopped = resolve))
  const previousUmask = process.umask(0o077)
  let db!: Database
  let core!: FederatedCore
  let judge!: JudgeGate
  let bridge: Bridge | null = null
  let wakers: Wakers | null = null
  let listener!: Server
  let socketIno: number | bigint | undefined
  try {
    privateDir(dirname(socket))
    db = openDatabase(join(dir, "relay.db"))
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    chmodSync(join(dir, "relay.db"), 0o600)
    const sql: Sql = db
    const machine = options.machine ?? options.bridge?.machine
    core = new FederatedCore(sql, {
      ...compact({ user: options.user, machine, now: options.now }),
      hostname: shortHostname(),
      hash: (value) => createHash("sha256").update(value).digest("hex"),
      transaction: (fn) => db.transaction(fn),
      alive: running,
      startOf: options.startOf ?? startedAt,
    })
    core.migrate()
    core.relabelMachine()
    core.resetConnections()
    core.sweep()
    core.hibernateHeld()
    judge = new JudgeGate({ sql, core, now: options.now ?? Date.now, env: options.env ?? process.env, client: options.judgeClient, log, wake })
    judge.sweep()
    if (existsSync(socket)) unlinkSync(socket)
    listener = createServer((raw) => {
      const s = new Conn<Connection>(
        raw,
        {
          reader: new LineReader(MAX_LINE),
          writer: new LineWriter(),
          observer: false,
          watching: false,
          closed: false,
          inFlight: 0,
          queue: [],
          queueHead: 0,
        },
        { data: onData, drain: flush, close: (s) => onClose(s) },
      )
      if (closing) {
        s.end()
        return
      }
      connections.add(s)
      activity()
    })
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject)
      // the kernel caps the backlog (macOS: kern.ipc.somaxconn, 128 by default)
      listener.listen({ path: socket, backlog: LISTEN_BACKLOG }, () => {
        listener.off("error", reject)
        resolve()
      })
    })
    listener.on("error", (error) => log(`relay broker: the socket listener failed: ${error.message}`))
    chmodSync(socket, 0o600)
    socketIno = lstatSync(socket).ino
  } catch (error) {
    listener?.close()
    db?.close()
    releaseBrokerLock(lock)
    throw error
  } finally {
    process.umask(previousUmask)
  }
  const sweeper = setInterval(() => {
    core.sweep()
    judge.sweep()
  }, SWEEP_MS)
  const known = new Map<string, Presence>()
  const wakes = new Map<string, string | null | undefined>()
  for (const view of localViews()) {
    known.set(view.id, view.presence)
    wakes.set(view.id, view.wake)
  }
  const presenceTimer = setInterval(() => {
    core.endExited()
    const live = new Set<string>()
    for (const view of localViews()) {
      live.add(view.id)
      if ((known.get(view.id) ?? "offline") !== view.presence) presenceChanged(view)
      else if (wakes.has(view.id) && wakes.get(view.id) !== view.wake) bridge?.changed(view.id)
      wakes.set(view.id, view.wake)
      if (wakeable(view)) wakers?.kick(view.id)
    }
    for (const id of known.keys()) if (!live.has(id)) known.delete(id)
    for (const id of wakes.keys()) if (!live.has(id)) wakes.delete(id)
  }, options.presenceEveryMs ?? PRESENCE_MS)
  const ownership = setInterval(() => {
    if (closing || ownsState()) return
    log(`relay broker: ${socket} or its lock was removed or taken over; stopping`)
    void stop()
  }, options.ownershipEveryMs ?? OWNERSHIP_MS)
  ownership.unref?.()

  /** whether the socket path is still this broker's listener */
  function ownsSocket(): boolean {
    return lstatSync(socket, { throwIfNoEntry: false })?.ino === socketIno
  }

  /** whether the socket path and the lock are still this broker's */
  function ownsState(): boolean {
    try {
      return ownsSocket() && readFileSync(lock.path, "utf8") === lock.content
    } catch {
      return false
    }
  }
  const remoteHooks: BridgeHooks = {
    wake,
    fleet: notifyFleet,
    policyError: () => {
      loadPolicy()
      return policyError
    },
    log,
  }
  if (options.bridge) bridge = startBridge({ ...options.bridge, core, onRemote: remoteHooks })
  else if (options.link) bridge = options.link({ core, hooks: remoteHooks, send: (from, params, origin) => judge.send(from, params, origin, deliver) })
  wakers = startWakers({
    core,
    path: options.wakersPath ?? join(dirname(policyFile), "wakers.json"),
    wakers: options.wakers,
    builtin: options.builtinWakers,
    dir,
    machine: options.machine ?? options.bridge?.machine ?? shortHostname(),
    now: options.now ?? Date.now,
    log,
    changed: (endpoint) => presenceChanged(core.whoami(endpoint)),
  })
  for (const view of localViews()) if (wakeable(view)) wakers.kick(view.id)

  /** links the bridge again with the credential on disk; a configuration this broker cannot take without a restart stops it */
  async function relink(): Promise<object> {
    const config = options.bridgeConfig ? await options.bridgeConfig() : options.bridge
    if (!config || (bridge && config.url === options.bridge?.url && config.machine === options.bridge?.machine)) {
      bridge?.relink()
      return bridge?.status() ?? { enabled: false }
    }
    setImmediate(() => void stop())
    return { enabled: false, restarting: true }
  }

  function activity() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
    if (!closing && idleMs > 0 && connections.size === 0 && pending === 0) idleTimer = setTimeout(() => void stop(), idleMs)
  }

  function loadPolicy() {
    let text: string | null
    try {
      text = readFileSync(policyFile, "utf8")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const dangling = code === "ENOENT" && lstatSync(policyFile, { throwIfNoEntry: false }) !== undefined
      if (code !== "ENOENT" || dangling) {
        policyText = undefined
        policyError = dangling
          ? `the relay policy at ${policyFile} is a link to a missing file; messages are refused until it is fixed`
          : `the relay policy at ${policyFile} cannot be read (${code ?? String(error)}); messages are refused until it is fixed`
        return
      }
      text = null
    }
    if (text === policyText) return
    policyText = text
    if (text === null) {
      core.setPolicy(null)
      judge.configure(undefined)
      policyError = null
      bridge?.resync()
      return
    }
    try {
      const policy = parsePolicy(JSON.parse(text))
      core.setPolicy(policy)
      judge.configure(policy.judge)
      policyError = null
      bridge?.resync()
    } catch (error) {
      policyError = `the relay policy at ${policyFile} is invalid (${error instanceof Error ? error.message : String(error)}); messages are refused until it is fixed`
    }
  }

  function policyInfo(): { file: string; state: "open" | "loaded" | "error"; error?: string } {
    loadPolicy()
    if (policyError) return { file: policyFile, state: "error", error: policyError }
    return { file: policyFile, state: policyText === null ? "open" : "loaded" }
  }

  function brokerInfo() {
    return { socket, dir, pid: process.pid, policy: policyInfo() }
  }

  /** a response; a connection whose unread bytes, this response included, would pass the cap is ended (one response alone always goes) */
  function write(s: Conn<Connection>, value: unknown) {
    if (s.data.closed) return
    const line = encodeLine(value)
    const queued = unread(s)
    if (queued > 0 && queued + line.length > outboundCap) {
      log(`relay broker: ended a connection with ${queued} bytes it did not read and a ${line.length} byte response`)
      onClose(s)
      s.end()
      return
    }
    s.data.writer.pushBytes(line)
    flush(s)
  }

  /** bytes queued for a connection that its peer has not taken yet */
  function unread(s: Conn<Connection>): number {
    return s.data.writer.pending + s.unsent
  }

  function flush(s: Conn<Connection>) {
    if (!s.data.closed) s.data.writer.flush((bytes) => s.write(bytes))
  }

  /** a fleet event to every watcher; a watcher that falls more than the cap behind gets one lagged notice and is unsubscribed */
  /** this host's own endpoints, mirrored rows of other machines left out */
  function localViews(): EndpointView[] {
    return core.list({ all: true }).filter((view) => core.machineOf(view.id) === null)
  }

  /** counts `s` as the waker of `endpoint`, or of none, and reports the presence that moves */
  /** the endpoint's waiting calls return and look again, as when it turned wakeable */
  function release(endpoint: string) {
    const waiting = waiters.get(endpoint)
    waiters.delete(endpoint)
    for (const fn of waiting ?? []) fn()
  }

  function setWaker(s: Conn<Connection>, endpoint: string | undefined) {
    const was = s.data.waker
    if (was === endpoint) return
    s.data.waker = endpoint
    if (was) {
      const wake = core.whoami(was).wake
      core.waker(was, false, { grace: s.data.transient === true })
      if (!presenceMoved(was) && core.whoami(was).wake !== wake) bridge?.changed(was)
    }
    if (endpoint) {
      core.waker(endpoint, true)
      presenceMoved(endpoint)
      release(endpoint)
    }
    for (const root of [was, endpoint]) if (root) subagentsMoved(root)
  }

  /** a root's in-process subagents show its wake and the presence it gives them: those that moved are reported */
  function subagentsMoved(root: string) {
    for (const id of core.subagentsOf(root)) {
      const wake = core.whoami(id).wake
      if (!presenceMoved(id) && wakes.get(id) !== wake) bridge?.changed(id)
      wakes.set(id, wake)
    }
  }

  /** reports an endpoint's presence when it is not the one last reported; whether it was not */
  function presenceMoved(id: string): boolean {
    const view = core.whoami(id)
    if ((known.get(id) ?? "offline") === view.presence) return false
    presenceChanged(view)
    return true
  }

  /** an endpoint's presence changed outside a connection's own hello or close: watchers and the other machines hear it */
  function presenceChanged(view: EndpointView) {
    known.set(view.id, view.presence)
    notifyFleet({
      type: "presence",
      endpoint: view.address,
      presence: view.presence,
      harness: view.harness,
      labels: view.labels,
      ...(view.wake_failed ? { wake_failed: view.wake_failed } : {}),
      ...(view.wake_declined ? { wake_declined: view.wake_declined } : {}),
    })
    bridge?.changed(view.id)
  }

  /** after a join, rename or leave: the session's marker, the fleet and the hub's mirror learn it; `was` is the handle before */
  function membership(view: EndpointView, session: string | null, joined: boolean, was?: string) {
    const handle = view.address.slice(view.address.lastIndexOf("/") + 1)
    if (session && !session.startsWith("sub:")) {
      try {
        writeSessionMarker(dir, session, { joined, handle })
      } catch (error) {
        log(`relay broker: the session marker was not written: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    known.set(view.id, view.presence)
    notifyFleet({ type: "presence", endpoint: view.address, presence: view.presence, harness: view.harness, labels: view.labels })
    if (was !== undefined && was !== handle) bridge?.renamed(view.id, was)
    else bridge?.changed(view.id)
  }

  function notifyFleet(event: Record<string, unknown>) {
    const at = new Date((options.now ?? Date.now)()).toISOString()
    let line: Uint8Array | undefined
    const views = new Map<string, Set<string>>()
    for (const s of connections) {
      if (!s.data.watching || s.data.closed) continue
      const viewer = viewerOf(s)
      let bytes: Uint8Array
      if (viewer === undefined) bytes = line ??= encodeLine({ jsonrpc: "2.0", method: "fleet", params: { at, ...event } })
      else {
        let seen = views.get(viewer)
        if (!seen) {
          seen = core.visibleTo(viewer)
          views.set(viewer, seen)
        }
        const shown = filterEvent(event, seen)
        if (!shown) continue
        bytes = encodeLine({ jsonrpc: "2.0", method: "fleet", params: { at, ...shown } })
      }
      const queued = unread(s)
      if (queued + bytes.length > outboundCap) {
        s.data.watching = false
        s.data.writer.push({ jsonrpc: "2.0", method: "fleet", params: { at, type: "lagged", queued_bytes: queued } })
      } else {
        s.data.writer.pushBytes(bytes)
      }
      flush(s)
    }
  }

  /** a fleet event cut to what a scoped viewer may see, or null when it may see none of it */
  function filterEvent(event: Record<string, unknown>, seen: Set<string>): Record<string, unknown> | null {
    if (event.type === "message") {
      const to = (event.to as string[]).filter((address) => seen.has(address))
      return seen.has(String(event.from)) && to.length ? { ...event, to } : null
    }
    return typeof event.endpoint !== "string" || seen.has(event.endpoint) ? event : null
  }

  /** whether the connection is the human at a terminal, the only one exempt from scopes and shown everything */
  function atTerminal(s: Conn<Connection>): boolean {
    return s.data.human === true && s.data.tty === true
  }

  /**
   * the endpoint whose view a connection gets; undefined for the human at a terminal, which sees everything. The human without a terminal, and an
   * observer with no lineage endpoint, see what the human may message with no exemption
   */
  function viewerOf(s: Conn<Connection>): string | undefined {
    if (s.data.lineage) return s.data.lineage
    if (s.data.observer || s.data.human) return atTerminal(s) ? undefined : core.humanId()
    return s.data.endpoint
  }

  function actorOf(s: Conn<Connection>): ScopeActor {
    if (s.data.lineage) return { kind: "endpoint", id: s.data.lineage, auth: s.data.own ? "self" : "lineage" }
    if (s.data.observer || s.data.human) return { kind: "human", tty: atTerminal(s) }
    return { kind: "endpoint", id: s.data.endpoint!, auth: "session" }
  }

  /** binds a hello to the agent endpoint its lineage lands on, acting with lineage auth, or with `own` as that endpoint (self auth) */
  function bindLineage(s: Conn<Connection>, endpoint: string, params: Record<string, unknown>, own = false) {
    s.data.endpoint = endpoint
    s.data.lineage = endpoint
    s.data.own = own
    s.data.brief = true
    s.data.cwd = typeof params.cwd === "string" ? params.cwd : undefined
    return {
      endpoint: core.whoami(endpoint),
      capabilities: BROKER_CAPABILITIES,
      server_time: new Date().toISOString(),
      limits: LIMITS,
      preamble: PREAMBLE,
      broker: brokerInfo(),
    }
  }

  /** whether the hub took these endpoints' mirror within HIBERNATE_BARRIER_MS, so the machine may be suspended at once */
  async function mirrorBarrier(endpoints: string[]): Promise<boolean> {
    if (!bridge?.mirrorNow || !endpoints.length) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), HIBERNATE_BARRIER_MS)
    })
    try {
      return await Promise.race([bridge.mirrorNow(endpoints), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /** a delivery reached `endpoint`: its waiters return, and a hibernated one's wake hook runs when due */
  function wake(endpoint: string) {
    for (const id of [endpoint, core.wakesRoot(endpoint)]) {
      const set = id ? waiters.get(id) : undefined
      if (!set) continue
      waiters.delete(id!)
      for (const fn of set) fn()
    }
    wakers?.kick(endpoint)
  }

  function waitFor(endpoint: string, ms: number, s: Conn<Connection>): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        waiters.get(endpoint)?.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      let set = waiters.get(endpoint)
      if (!set) {
        set = new Set()
        waiters.set(endpoint, set)
      }
      set.add(done)
      if (s.data.closed) done()
    })
  }

  /**
   * a stop's push with worker results to show while other workers still run: waits on, peeking, for more of theirs to show with them until
   * none came for ${LIMITS.pushQuietS} s, ${LIMITS.pushGraceS} s after it began (which may run past the stop's wait), the push budget is
   * full (`more`), no other worker runs ({@link othersRunning}), a prompt came or the connection closed
   */
  async function gather(
    me: string,
    result: StopWaitResult,
    peek: ReturnType<typeof hookOf> & { prompts?: number; peek: boolean },
    s: Conn<Connection>,
  ): Promise<void> {
    const gathering = (r: StopWaitResult) => workerResults(r) > 0 && !r.more && !r.prompted && !r.wakeable && othersRunning(r) > 0
    const cap = Date.now() + LIMITS.pushGraceS * 1000
    let quiet = Date.now() + LIMITS.pushQuietS * 1000
    let results = workerResults(result)
    while (gathering(result) && !s.data.closed && Date.now() < Math.min(quiet, cap)) {
      await waitFor(me, Math.min(quiet, cap) - Date.now(), s)
      if (closing) throw new RelayError("unauthorized", "the relay broker is stopping")
      result = core.stopWait(me, peek)
      if (workerResults(result) > results) {
        results = workerResults(result)
        quiet = Date.now() + LIMITS.pushQuietS * 1000
      }
    }
  }

  function onData(s: Conn<Connection>, chunk: Uint8Array) {
    if (s.data.tooLarge) return
    const { lines, tooLong } = s.data.reader.push(chunk)
    for (const line of lines) s.data.queue.push(line)
    if (tooLong) {
      s.data.tooLarge = true
      clearTimeout(s.data.lineTimer)
      s.data.lineTimer = undefined
    }
    pump(s)
    if (tooLong) return endTooLarge(s)
    if (!s.data.reader.buffered || lines.length) {
      clearTimeout(s.data.lineTimer)
      s.data.lineTimer = undefined
    }
    if (s.data.reader.buffered && !s.data.lineTimer) armLineTimer(s)
  }

  function endTooLarge(s: Conn<Connection>) {
    if (s.data.inFlight || s.data.queueHead < s.data.queue.length) return
    write(s, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large", data: { code: "too_large" } } })
    s.end()
  }

  /** a line must end within partialLineMs of its first byte, not counting time the broker itself paused reading */
  function armLineTimer(s: Conn<Connection>) {
    if (partialLineMs <= 0) return
    s.data.lineTimer = setTimeout(() => {
      s.data.lineTimer = undefined
      if (s.data.closed || !s.data.reader.buffered) return
      if (s.data.queueHead < s.data.queue.length) return armLineTimer(s)
      write(s, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "the request line was not finished in time", data: { code: "invalid_params" } } })
      s.end()
    }, partialLineMs)
  }

  function onClose(s: Conn<Connection>) {
    if (s.data.closed) return
    s.data.closed = true
    clearTimeout(s.data.lineTimer)
    connections.delete(s)
    const held = !closing && s.data.waker ? core.hibernateHeld(s.data.waker) : []
    for (const view of held) presenceChanged(view)
    if (!closing) setWaker(s, undefined)
    for (const view of held) wakers?.kick(view.id)
    if (s.data.endpoint && !closing && !s.data.transient && !s.data.lineage) {
      const before = core.whoami(s.data.endpoint).presence
      const settled = core.disconnect(s.data.endpoint, { settle: !s.data.brief })
      wake(s.data.endpoint)
      const view = core.whoami(s.data.endpoint)
      known.set(s.data.endpoint, view.presence)
      if (!s.data.brief && view.presence !== before) notifyFleet({ type: "presence", endpoint: view.address, presence: view.presence })
      if (settled) notifyFleet({ type: "status", endpoint: view.address, status: null })
      if (!s.data.brief || view.presence !== before || settled) bridge?.changed(s.data.endpoint)
    }
    activity()
  }

  /** starts queued lines while fewer than maxPending run; reading pauses while any wait */
  function pump(s: Conn<Connection>) {
    const data = s.data
    while (data.queueHead < data.queue.length && data.inFlight < maxPending && !data.closed) void handleLine(s, data.queue[data.queueHead++]!)
    if (data.queueHead === data.queue.length) {
      data.queue = []
      data.queueHead = 0
      if (!data.closed) s.resume()
    } else if (!data.closed) {
      s.pause()
    }
  }

  async function handleLine(s: Conn<Connection>, line: string) {
    s.data.inFlight++
    try {
      await answer(s, line)
    } catch (error) {
      log(`relay broker: a request failed outside its handler: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    } finally {
      s.data.inFlight--
      pump(s)
      if (s.data.tooLarge) endTooLarge(s)
    }
  }

  function invalidRequest(s: Conn<Connection>, id: string | number | null, message: string) {
    write(s, { jsonrpc: "2.0", id, error: { code: -32600, message, data: { code: "invalid_params" } } })
  }

  async function answer(s: Conn<Connection>, line: string) {
    if (closing) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      write(s, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
      return
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalidRequest(s, null, "a request is a JSON object")
    const request = parsed as Request
    const hasId = "id" in request
    const id = request.id ?? null
    if (id !== null && typeof id !== "string" && typeof id !== "number") return invalidRequest(s, null, "a request id is a string or a number")
    if (typeof request.method !== "string") return invalidRequest(s, id, "a request needs a method")
    const params = request.params ?? {}
    if (typeof params !== "object" || params === null || Array.isArray(params)) return invalidRequest(s, id, "params is an object")
    pending++
    try {
      const result = await dispatch(s, request.method, params as Record<string, unknown>)
      if (hasId) write(s, { jsonrpc: "2.0", id, result })
    } catch (error) {
      if (!hasId || closing) return
      if (error instanceof RelayError) {
        const code = error.code === "method_not_found" ? -32601 : error.code === "invalid_params" ? -32602 : -32000
        write(s, {
          jsonrpc: "2.0",
          id,
          error: {
            code,
            message: error.message,
            data: { ...error.detail, code: error.code, ...(error.retryAfterS ? { retry_after: error.retryAfterS } : {}) },
          },
        })
      } else {
        log(`relay broker: ${request.method} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
        write(s, { jsonrpc: "2.0", id, error: { code: -32603, message: "internal error" } })
      }
    } finally {
      pending--
      activity()
    }
  }

  function endpointOf(s: Conn<Connection>): string {
    if (closing) throw new RelayError("unauthorized", "the relay broker is stopping")
    if (!s.data.endpoint)
      throw new RelayError("unauthorized", s.data.observer ? "this connection only observes: say hello as an agent or the human" : "call hello first")
    core.touch(s.data.endpoint)
    return s.data.endpoint
  }

  function waitSeconds(value: unknown): number {
    if (value === undefined) return 0
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RelayError("invalid_params", "wait_s must be a number of seconds")
    return Math.min(value, LIMITS.waitMaxS) * 1000
  }

  function checkAttachments(attachments: unknown, s: Conn<Connection>): Attachment[] | undefined {
    if (attachments === undefined) return undefined
    if (!Array.isArray(attachments)) throw new RelayError("invalid_params", "attachments must be a list")
    const tooWide = new Set(["/", realOrSelf(homedir()), realOrSelf(accountHome())])
    const roots = [s.data.cwd, ...(options.roots ?? [])]
      .filter((r): r is string => typeof r === "string" && isAbsolute(r))
      .map(realOrSelf)
      .filter((r) => !tooWide.has(r))
    return attachments.map((attachment: Attachment) => {
      if (attachment?.kind !== "path" || typeof attachment.path !== "string" || !isAbsolute(attachment.path)) {
        throw new RelayError("invalid_params", "an attachment is {kind: path, path: an absolute path}")
      }
      let real: string
      try {
        real = realpathSync(attachment.path)
      } catch {
        throw new RelayError("not_found", `no file at ${attachment.path}`)
      }
      if (!roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep))) {
        throw new RelayError("invalid_params", `${attachment.path} is outside the sender's working directory and the relay's allowed roots`)
      }
      return { kind: "path", path: real }
    })
  }

  async function dispatch(s: Conn<Connection>, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "hello") {
      if (s.data.endpoint || s.data.observer) throw new RelayError("invalid_params", "hello was already called on this connection")
      if (params.protocol !== PROTOCOL) throw new RelayError("invalid_params", `this broker speaks ${PROTOCOL}`)
      if (params.transient === true) {
        if (params.human === true || params.observe === true || params.resume !== undefined) {
          throw new RelayError("invalid_params", "a hook connection claims an agent endpoint: transient does not go with human, observe or resume")
        }
        const join = params.join
        if (join !== undefined && (typeof join !== "object" || join === null || Array.isArray(join)))
          throw new RelayError("invalid_params", "join is {handle?, under?}")
        const under = (join as { under?: unknown } | undefined)?.under
        const before = join === undefined ? core.claimViews(params.claim) : new Map(core.list({ all: true }).map((view) => [view.id, view]))
        const { endpoint, subagent, created } =
          join === undefined
            ? core.claim((params.claim ?? {}) as Claim, { transient: true })
            : {
                endpoint: core.joinSession((params.claim ?? {}) as Claim, (join as { handle?: unknown }).handle, under),
                subagent: undefined,
                created: undefined,
              }
        s.data.endpoint = endpoint.id
        s.data.transient = true
        const key = (params.claim as Claim | undefined)?.process
        if (typeof key === "string") s.data.process = key
        const was = before.get(endpoint.id)?.address
        if (join !== undefined) membership(endpoint, core.sessionOf(endpoint.id), true, was?.slice(was.lastIndexOf("/") + 1))
        const tookOver = join !== undefined && [...before.values()].some((view) => view.id !== endpoint.id && view.address === endpoint.address)
        if (tookOver || (under !== undefined && before.get(endpoint.id)?.parent !== endpoint.parent)) bridge?.resync()
        else if ((before.get(endpoint.id)?.presence ?? known.get(endpoint.id) ?? "offline") !== endpoint.presence) presenceChanged(endpoint)
        return {
          endpoint,
          ...(subagent ? { subagent, ...(created ? { created } : {}) } : {}),
          capabilities: BROKER_CAPABILITIES,
          server_time: new Date().toISOString(),
          limits: LIMITS,
          preamble: PREAMBLE,
          broker: brokerInfo(),
        }
      }
      if (params.observe === true) {
        if (params.ticket !== undefined) {
          const holder = core.wakeTicketHolder(params.ticket)
          if (!holder) throw new RelayError("unauthorized", "the wake ticket is unknown or spent")
          s.data.ticket = params.ticket as string
          return bindLineage(s, holder, params, true)
        }
        const self = params.self === undefined ? null : core.placeLineage(params.self, undefined, params.harness_session)
        if (params.grant !== undefined) {
          if (!core.grantBinds(params.grant, self)) throw new RelayError("unauthorized", GRANT_UNBOUND)
          return { ...bindLineage(s, self!, params, true), grant_bound: true }
        }
        if (self) return bindLineage(s, self, params, true)
        s.data.observer = true
        if (params.lineage !== undefined) s.data.lineage = core.placeLineage(params.lineage, undefined, params.harness_session) ?? undefined
        return {
          endpoint: null,
          capabilities: BROKER_CAPABILITIES,
          server_time: new Date().toISOString(),
          limits: LIMITS,
          preamble: PREAMBLE,
          broker: brokerInfo(),
        }
      }
      const claim = params.claim as Claim | undefined
      if (params.human === true && params.resume === undefined && params.lineage !== undefined) {
        const placed = core.placeLineage(params.lineage, undefined, params.harness_session)
        if (placed) {
          s.data.terminal = params.tty === true
          return bindLineage(s, placed, params)
        }
      } else if (params.human !== true && params.resume === undefined && claim?.process === undefined && typeof claim?.handle === "string") {
        const placed = claim.lineage === undefined ? null : core.placeLineage(claim.lineage, claim.handle)
        if (placed && (claim.grant === undefined || core.grantBinds(claim.grant, placed))) {
          return bindLineage(s, placed, { cwd: claim.cwd, ...params }, params.self !== undefined && core.placeLineage(params.self, claim.handle) === placed)
        }
      }
      let token: string | undefined
      let endpoint: EndpointView
      const before =
        params.resume === undefined ? core.claimViews(params.human === true ? undefined : params.claim, params.human === true) : new Map<string, EndpointView>()
      if (typeof params.resume === "string") endpoint = core.resume(params.resume)
      else if (params.human === true) {
        s.data.tty = params.tty === true
        endpoint = core.claimHuman(s.data.tty)
      } else {
        const claim = (params.claim ?? {}) as Claim
        const claimed = core.claim(claim, { self: params.self })
        s.data.holder = typeof claim.grant === "string" || typeof claim.ticket === "string"
        endpoint = claimed.endpoint
        token = claimed.token
      }
      s.data.endpoint = endpoint.id
      s.data.human = endpoint.kind === "human"
      s.data.brief = params.brief === true
      s.data.cwd = typeof params.cwd === "string" ? params.cwd : (endpoint.cwd ?? undefined)
      const was = before.get(endpoint.id)
      const moved = (was?.presence ?? known.get(endpoint.id) ?? "offline") !== endpoint.presence || (was !== undefined && was.address !== endpoint.address)
      known.set(endpoint.id, endpoint.presence)
      if (!s.data.brief && moved) {
        notifyFleet({ type: "presence", endpoint: endpoint.address, presence: endpoint.presence, harness: endpoint.harness, labels: endpoint.labels })
      }
      if (!s.data.brief || moved) bridge?.changed(endpoint.id)
      return {
        endpoint,
        ...(token ? { token } : {}),
        capabilities: BROKER_CAPABILITIES,
        server_time: new Date().toISOString(),
        limits: LIMITS,
        preamble: PREAMBLE,
        broker: brokerInfo(),
      }
    }
    if (closing) throw new RelayError("unauthorized", "the relay broker is stopping")
    if (s.data.ticket !== undefined && core.wakeTicketHolder(s.data.ticket) !== s.data.endpoint)
      throw new RelayError("unauthorized", "the wake ticket is spent: its run ended")
    if (s.data.observer && OBSERVER_METHODS.has(method)) return observe(s, method, params)
    if (s.data.observer && SCOPE_METHODS.has(method) && (s.data.lineage || method === "why")) return scope(s, method, params)
    if (s.data.transient && SCOPE_METHODS.has(method)) throw new RelayError("scope_refused", "a hook connection cannot read or change scopes, groups or grants")
    const me = endpointOf(s)
    if (s.data.transient && !TRANSIENT_METHODS.has(method)) throw new RelayError("unauthorized", "a hook connection only posts activity and status")
    if (OBSERVER_METHODS.has(method)) return observe(s, method, params)
    if (SCOPE_METHODS.has(method)) return scope(s, method, params)
    switch (method) {
      case "whoami":
        return s.data.transient ? core.whoami(me) : { ...core.whoami(me), ...core.peekState(me) }
      case "peek_turn":
        if (!s.data.transient || !core.hookOwns(me, s.data.process))
          throw new RelayError("unauthorized", "only a hook of the endpoint's own harness process posts digest turns")
        return core.peekTurn(me, { role: params.role, text: params.text })
      case "send":
      case "ask": {
        for (const field of SERVER_FIELDS) if (field in params) throw new RelayError("invalid_params", `${field} is set by the relay, not the sender`)
        loadPolicy()
        if (policyError) throw new RelayError("policy_refused", policyError)
        const attachments = checkAttachments(params.attachments, s)
        const send: SendParams = { ...(params as unknown as SendParams), ...(attachments ? { attachments } : {}) }
        if (method === "ask") send.kind = "request"
        const origin = s.data.tty === undefined ? {} : { tty: s.data.tty, ...(atTerminal(s) ? {} : { unverified: true }) }
        const result = await judge.send(me, send, origin, deliver)
        if (method === "send" || result.held) return result
        return awaitReply(s, me, result.id, waitSeconds(params.wait_s), result)
      }
      case "holds":
        return { holds: judge.holds(optional(reviewer(s, params), "state")) }
      case "hold_show":
        return judge.show(required(reviewer(s, params), "id"))
      case "hold_release": {
        const id = required(reviewer(s, params), "id")
        loadPolicy()
        if (policyError) throw new RelayError("policy_refused", policyError)
        return judge.release(id, { redacted: params.redacted === true, by: core.addressOf(me) }, deliver)
      }
      case "hold_refuse": {
        const reason = required(reviewer(s, params), "reason")
        if (reason.length > LIMITS.noteChars) throw new RelayError("invalid_params", `reason takes at most ${LIMITS.noteChars} characters`)
        return judge.refuse(required(params, "id"), stripControl(reason), core.addressOf(me))
      }
      case "ask_wait": {
        if (typeof params.id !== "string") throw new RelayError("invalid_params", "id is the request's message id")
        return awaitReply(s, me, params.id, waitSeconds(params.wait_s))
      }
      case "inbox": {
        const query = compact({ after: params.after as number | undefined, limit: params.limit as number | undefined })
        const read = () =>
          params.offer === true
            ? core.offer(me, { ...query, subagents: s.data.waker === me, ...(s.data.ticket !== undefined ? { holdS: TICKET_HOLD_S } : {}) })
            : { messages: core.inbox(me, query) }
        const deadline = Date.now() + waitSeconds(params.wait_s)
        let page = read()
        while (!page.messages.length && !s.data.closed && Date.now() < deadline) {
          await waitFor(me, deadline - Date.now(), s)
          if (closing) throw new RelayError("unauthorized", "the relay broker is stopping")
          page = read()
        }
        const { messages } = page
        return { ...page, next: messages.length ? messages[messages.length - 1]!.seq : (query.after ?? 0) }
      }
      case "ack":
        return { acked: core.ack(me, params.seqs) }
      case "title": {
        const view = core.title(me, params.text)
        bridge?.changed(me)
        return view
      }
      case "title_infer": {
        const changed = core.inferTitle(me, params, hookOf(s))
        if (changed) bridge?.changed(me)
        return { changed }
      }
      case "subagent_title": {
        const changed = core.subagentTitle(me, params, hookOf(s))
        if (changed) bridge?.changed(changed)
        return { changed: changed !== null }
      }
      case "wake": {
        if (s.data.lineage && !s.data.own) throw new RelayError("unauthorized", "only the endpoint's own session says how it wakes")
        if (params.ref !== undefined && params.ref !== null && !s.data.holder)
          throw new RelayError("unauthorized", "only a spawn holding its worker, by the grant it spent or a wake ticket, gives a durable ref")
        if (params.ref !== undefined && params.ref !== null && !wakers?.known(SPAWN_PROVIDER))
          throw new RelayError("invalid_params", `no waker ${SPAWN_PROVIDER} is configured: this broker cannot hold a spawn durably`)
        const changed = core.setWake(me, params.via, { ...hookOf(s), ref: params.ref })
        setWaker(s, params.via !== "none" && core.whoami(me).wake === params.via ? me : undefined)
        if (changed) wakers?.kick(me)
        if (!presenceMoved(me) && changed) bridge?.changed(me)
        if (changed) {
          subagentsMoved(me)
          release(me)
        }
        return { changed }
      }
      case "rename": {
        const renamed = core.rename(actorOf(s), {
          ...(params.endpoint !== undefined ? { endpoint: params.endpoint } : {}),
          handle: params.handle,
          ...(params.take_over !== undefined ? { take_over: params.take_over } : {}),
        })
        membership(renamed.endpoint, renamed.session, true, renamed.from)
        if (renamed.retired) bridge?.resync()
        return renamed.endpoint
      }
      case "adopt": {
        const actor = actorOf(s)
        loadPolicy()
        if (policyError && actor.kind === "endpoint" && s.data.terminal !== true) throw new RelayError("policy_refused", policyError)
        const adopted = await core.adopt(
          actor,
          { endpoint: params.endpoint, ...(params.parent !== undefined ? { parent: params.parent } : {}) },
          {
            tty: actor.kind === "endpoint" && s.data.terminal === true,
            send: (from: string, send: SendParams, origin: { link: "session" | "self" }) => {
              loadPolicy()
              if (policyError) throw new RelayError("policy_refused", policyError)
              return judge.send(from, send, { tty: false, ...origin }, deliver)
            },
          },
        )
        bridge?.resync()
        return adopted
      }
      case "link_accept": {
        const linked = core.linkAccept(actorOf(s), { id: params.id })
        bridge?.resync()
        return linked
      }
      case "unlink": {
        const unlinked = core.unlink(actorOf(s), params.endpoint !== undefined ? { endpoint: params.endpoint } : {})
        bridge?.resync()
        return unlinked
      }
      case "hibernate": {
        const known = { known: (provider: string) => wakers?.known(provider) ?? false }
        const set = { wake: params.wake, ref: params.ref, eta_s: params.eta_s }
        if (params.all !== undefined && params.all !== true) throw new RelayError("invalid_params", "all is true or absent")
        if (params.all === true && params.endpoint !== undefined) throw new RelayError("invalid_params", "all names no endpoint")
        const result =
          params.all === true
            ? core.hibernateAll(actorOf(s), set, known)
            : core.hibernate(actorOf(s), { ...(params.endpoint !== undefined ? { endpoint: params.endpoint } : {}), ...set }, known)
        const views = "endpoints" in result ? result.endpoints : [result.endpoint]
        for (const view of views) presenceChanged(view)
        const mirrored = await mirrorBarrier(views.map((view) => view.id))
        for (const view of views) wakers?.kick(view.id)
        return { ...result, mirrored }
      }
      case "machine_wake": {
        if (actorOf(s).kind !== "human") throw new RelayError("unauthorized", "only the human sets this machine's waker")
        if (!bridge?.machineWake) throw new RelayError("unavailable", "this broker has no hub link: the machine waker lives on the hub")
        if (params.url !== null && typeof params.url !== "string") throw new RelayError("invalid_params", "url is an https URL, or null to clear it")
        if (params.secret !== undefined && typeof params.secret !== "string") throw new RelayError("invalid_params", "secret is a string")
        return bridge.machineWake({ url: params.url, ...(params.secret !== undefined ? { secret: params.secret } : {}) })
      }
      case "leave": {
        const left = core.leaveSession(actorOf(s), params.endpoint !== undefined ? { endpoint: params.endpoint } : {})
        for (const c of connections) if (c.data.endpoint === left.endpoint.id && !c.data.transient && !c.data.lineage && c !== s) c.end()
        membership(left.endpoint, left.session, false)
        return left.endpoint
      }
      case "status": {
        core.status(me, params.state, params.note)
        const view = core.whoami(me)
        if (params.state === "done" && core.wakesRoot(me)) wake(me)
        notifyFleet({ type: "status", endpoint: view.address, status: view.status })
        bridge?.changed(me)
        return view
      }
      case "event": {
        const wake = core.whoami(me).wake
        const row = core.event(me, params, hookOf(s))
        notifyFleet({ type: "activity", ...row })
        bridge?.activity(me, row)
        const after = core.whoami(me)
        if ((known.get(me) ?? "offline") !== after.presence) presenceChanged(after)
        else if (after.wake !== wake) bridge?.changed(me)
        return row
      }
      case "inject": {
        const waitMs = waitSeconds(params.wait_s)
        const options = {
          stop: params.stop === true,
          count: params.count === true,
          holdUnread: params.hold_unread === true,
          directives: params.directives === true,
          wake: waitMs > 0 && params.stop !== true && params.count !== true,
          ...hookOf(s),
        }
        const deadline = Date.now() + (options.wake ? waitMs : 0)
        let result = core.inject(me, options)
        while (!result.offered.length && !s.data.closed && Date.now() < deadline) {
          await waitFor(me, deadline - Date.now(), s)
          if (closing) throw new RelayError("unauthorized", "the relay broker is stopping")
          result = core.inject(me, options)
        }
        return result
      }
      case "stop_wait": {
        const waitMs = waitSeconds(params.wait_s)
        const deadline = Date.now() + waitMs
        const options = { ...hookOf(s), ...(typeof params.prompts === "number" ? { prompts: params.prompts } : {}) }
        const peek = { ...options, peek: true }
        let result = core.stopWait(me, peek)
        const idle = (r: StopWaitResult) =>
          !r.messages.length && !r.more && r.workers.length + r.starting > 0 && r.pushes_left > 0 && !r.prompted && !r.wakeable
        while (idle(result) && !s.data.closed && Date.now() < deadline) {
          await waitFor(me, Math.min(STOP_RECHECK_MS, deadline - Date.now()), s)
          if (closing) throw new RelayError("unauthorized", "the relay broker is stopping")
          result = core.stopWait(me, peek)
        }
        if (waitMs > 0) await gather(me, result, peek, s)
        return core.stopWait(me, options)
      }
      case "prompted": {
        const prompted = core.prompted(me, hookOf(s))
        if (prompted) wake(me)
        const tldr = prompted && typeof params.tldr_every === "number" && core.tldrDue(me, params.tldr_every)
        return { prompted, ...(tldr ? { tldr } : {}) }
      }
      case "injected":
        return {
          injected: core.injected(params.seqs, params.hold, { endpoint: me, read: params.read, deferred: params.deferred === true }),
          ...(params.stop === true ? { held: core.stopHeld(me, hookOf(s)) } : {}),
          ...(params.push === true ? { pushed: core.pushed(me, params.read, hookOf(s)) } : {}),
          ...(params.nudged !== undefined ? { nudged: core.nudged(me, params.nudged, hookOf(s)) } : {}),
          ...(params.restated !== undefined ? { restated: core.restated(me, params.restated, params.read, hookOf(s)) } : {}),
          ...(params.preamble === true ? { briefed: core.briefed(me, hookOf(s)) } : {}),
          ...(params.intro === true ? { introduced: core.introduced(me, hookOf(s)) } : {}),
        }
      case "message":
        return { message: core.delivered(me, params.id) ?? (params.member === true ? core.threadMessage(me, params.id) : null) }
      case "receipts":
        return core.receipts(me, params.id)
    }
    throw new RelayError("method_not_found", `no method ${method}`)
  }

  /** a send as `from` to local endpoints or, through the bridge, other machines; wakes the recipients and tells the watchers */
  const deliver: Deliver = async (from, send, origin) => {
    let result: SendResult
    const remote = remoteSend(core, send.to)
    if (remote) {
      if (!bridge)
        throw new RelayError("not_found", `no endpoint ${[send.to].flat().join(", ")}: this broker is not linked to a hub (${CLI_NAME} cloud enable)`)
      result = await bridge.forward(from, send, origin)
    } else {
      result = core.send(from, send, origin)
    }
    if (!result.duplicate && !remote)
      bridge?.local?.({
        id: result.id,
        thread: result.thread,
        kind: send.kind ?? "message",
        from,
        to: result.deliveries.map((d) => d.endpoint),
        at: (options.now ?? Date.now)(),
      })
    if (!result.duplicate) {
      for (const delivery of result.deliveries) wake(delivery.endpoint)
      notifyFleet({
        type: "message",
        id: result.id,
        thread: result.thread,
        kind: send.kind ?? "message",
        from: core.addressOf(from),
        to: result.deliveries.map((d) => d.address),
        hop: result.hop,
      })
    }
    return result
  }

  /** held messages are reviewed only by the human at a terminal: never an agent, a script or a relay message */
  function reviewer(s: Conn<Connection>, params: Record<string, unknown>): Record<string, unknown> {
    if (!atTerminal(s)) throw new RelayError("unauthorized", "only your human at a terminal reviews held messages")
    return params
  }

  /**
   * what any connection that said hello may read; an agent, or an observer on its lineage endpoint, sees only what that endpoint could message or
   * be messaged by, checks the policy only for pairs it could ask why about, and reads the policy's state but not its rules
   */
  function observe(s: Conn<Connection>, method: string, params: Record<string, unknown>): unknown {
    const viewer = viewerOf(s)
    switch (method) {
      case "list":
        if (params.contacts === true) {
          if (!bridge) throw new RelayError("unavailable", `this broker is not linked to a hub (${CLI_NAME} cloud enable), so it reaches no contacts`)
          return bridge.contacts().then((contacts) => ({ contacts }))
        }
        return { endpoints: core.list({ ...(params as Parameters<FederatedCore["list"]>[0]), viewer, peekable: viewer === undefined }) }
      case "snapshot":
        return {
          ...core.snapshot({ all: params.all === true, activity: typeof params.activity === "number" ? params.activity : undefined, viewer }),
          broker: brokerInfo(),
        }
      case "watch":
        s.data.watching = true
        return { ...core.snapshot({ activity: 20, viewer }), broker: brokerInfo() }
      case "log": {
        return {
          rows: core.log({
            since: params.since as number | undefined,
            limit: params.limit as number | undefined,
            scope: params.scope === true,
            judge: params.judge === true,
            peek: params.peek === true,
            viewer,
          }),
        }
      }
      case "policy": {
        const info = policyInfo()
        const text = actorOf(s).kind === "human" && info.state === "loaded" ? policyText : null
        return { ...info, policy: typeof text === "string" ? (JSON.parse(text) as unknown) : null }
      }
      case "policy_check": {
        if (viewer !== undefined) core.why(actorOf(s), String(params.from), String(params.to))
        const info = policyInfo()
        if (info.error) return { allowed: false, reason: info.error, file: policyFile }
        const reason = core.checkPolicy(String(params.from), String(params.to))
        return { allowed: reason === null, reason, file: policyFile }
      }
      case "cloud_status":
        return bridge?.status() ?? { enabled: false }
      case "bridge_relink":
        return relink()
    }
    throw new RelayError("method_not_found", `no method ${method}`)
  }

  /** rules, groups, grants, admins, peers, why and peeks, acting as the connection's actor */
  function scope(s: Conn<Connection>, method: string, params: Record<string, unknown>): unknown {
    const result = scopeCall(s, method, params)
    if (CHANGES_SCOPE.has(method) && params.action !== "ls" && params.action !== "show") bridge?.resync()
    return result
  }

  function scopeCall(s: Conn<Connection>, method: string, params: Record<string, unknown>): unknown {
    const actor = actorOf(s)
    switch (method) {
      case "rules":
        return core.scopeView(actor, optional(params, "endpoint"))
      case "rules_set":
        return core.rulesSet(
          actor,
          compact({
            endpoint: optional(params, "endpoint"),
            in: selectors(params, "in"),
            out: selectors(params, "out"),
            scope: optional(params, "scope") as ScopePreset | undefined,
            allow: selectors(params, "allow"),
          }),
        )
      case "rules_widen":
        return core.rulesWiden(actor, compact({ endpoint: required(params, "endpoint"), in: selectors(params, "in"), out: selectors(params, "out") }))
      case "rules_lift":
        return core.rulesLift(actor, { endpoint: required(params, "endpoint"), cap: required(params, "cap") })
      case "grant":
        return core.grant(actor, params as Parameters<FederatedCore["grant"]>[1])
      case "group":
        return core.group(actor, params as Parameters<FederatedCore["group"]>[1])
      case "admin":
        return core.admin(actor, params as Parameters<FederatedCore["admin"]>[1])
      case "peers":
        return { peers: core.peers(viewerOf(s) ?? s.data.endpoint!, { unverified: !atTerminal(s) }) }
      case "why":
        return core.why(actor, required(params, "from"), required(params, "to"))
      case "peek":
        return core.peek(actor, { endpoint: params.endpoint, turns: params.turns, full: params.full })
      case "peek_set":
        return core.peekSet(actor, { ...compact({ endpoint: optional(params, "endpoint") }), level: params.level })
      case "peek_who":
        return core.peekWho(actor, compact({ endpoint: optional(params, "endpoint") }))
      case "spawn_steers":
        return core.spawnSteers(actor, { grant: params.grant as string, take: params.take === true })
      case "spawn_end": {
        const ended = core.spawnEnd(actor, { endpoint: params.endpoint })
        for (const c of connections) if (c.data.waker === ended.endpoint.id) c.end()
        if (!presenceMoved(ended.endpoint.id)) bridge?.changed(ended.endpoint.id)
        return ended
      }
      case "spawn_exit": {
        const { spawner, ...result } = core.spawnExit(
          actor,
          compact({
            grant: params.grant as string,
            code: params.code as number,
            output: params.output as string | undefined,
            stderr: params.stderr as string | undefined,
            unapplied: params.unapplied as string[] | undefined,
            exits: params.exits as number[] | undefined,
            started: params.started as boolean | undefined,
            run: params.run as number | undefined,
            reply_to: params.reply_to as string | undefined,
          }),
        )
        if (result.handback) {
          const message = core.delivered(spawner, result.handback)!
          wake(spawner)
          bridge?.local?.({
            id: message.id,
            thread: message.thread,
            kind: "handback",
            from: message.from.endpoint,
            to: [spawner],
            at: (options.now ?? Date.now)(),
          })
          notifyFleet({
            type: "message",
            id: message.id,
            thread: message.thread,
            kind: message.kind,
            from: message.from.address,
            to: [message.to],
            hop: message.hop,
          })
        }
        if (result.endpoint) {
          notifyFleet({ type: "status", endpoint: result.endpoint.address, status: result.endpoint.status })
          if ((known.get(result.endpoint.id) ?? "offline") !== result.endpoint.presence) presenceChanged(result.endpoint)
          else bridge?.changed(result.endpoint.id)
        }
        return result
      }
    }
    throw new RelayError("method_not_found", `no method ${method}`)
  }

  function realOrSelf(path: string): string {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }

  /** the reply, or pending at the deadline, or pending with `ended` once every recipient present at the send went offline without replying */
  async function awaitReply(s: Conn<Connection>, me: string, request: string, ms: number, sent?: SendResult): Promise<unknown> {
    const deadline = Date.now() + ms
    const present = sent?.deliveries.filter((d) => !d.offline).map((d) => d.endpoint)
    for (;;) {
      if (closing) throw new RelayError("unauthorized", "the relay broker is stopping")
      const reply = core.replyTo(me, request)
      if (reply) {
        core.ack(me, [reply.seq])
        return { ...sent, id: request, reply }
      }
      if (core.requestExpired(request)) return { ...sent, id: request, expired: true }
      const ended = core.requestEnded(me, request, present)
      if (ended) return { ...sent, id: request, pending: true, ended }
      if (s.data.closed || Date.now() >= deadline) return { ...sent, id: request, pending: true }
      await waitFor(me, Math.min(ASK_RECHECK_MS, deadline - Date.now()), s)
    }
  }

  async function stop(): Promise<void> {
    if (stopping) return stopping
    stopping = (async () => {
      closing = true
      clearInterval(sweeper)
      clearInterval(presenceTimer)
      clearInterval(ownership)
      wakers?.stop()
      await bridge?.stop()
      if (idleTimer) clearTimeout(idleTimer)
      for (const set of [...waiters.values()]) for (const fn of [...set]) fn()
      const deadline = Date.now() + 2000
      while (pending > 0 && Date.now() < deadline) await sleep(5)
      await Promise.race([judge.settled(), sleep(Math.max(0, deadline - Date.now()))])
      for (const s of connections) s.end()
      // closing a listener unlinks its path, which another broker may own by now
      if (ownsSocket()) {
        listener.close()
        try {
          unlinkSync(socket)
        } catch {}
      } else listener.unref()
      if (socket !== join(dir, "relay.sock")) {
        try {
          rmdirSync(dirname(socket))
        } catch {}
      }
      db.close()
      releaseBrokerLock(lock)
      resolveStopped()
    })()
    return stopping
  }

  activity()
  return { socket, core, bridge, judge, policyFile, stopped, stop }
}

type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
}

/** `fields` without the ones that are undefined, for the optional parameters the core takes */
function compact<T extends object>(fields: T): Compact<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Compact<T>
}

function optional(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new RelayError("invalid_params", `${key} must be a string`)
  return value
}

function required(params: Record<string, unknown>, key: string): string {
  const value = optional(params, key)
  if (!value) throw new RelayError("invalid_params", `${key} is required`)
  return value
}

function selectors(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new RelayError("invalid_params", `${key} must be a list of selectors`)
  return value as string[]
}
