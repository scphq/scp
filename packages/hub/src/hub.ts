import {
  type ActivityRow,
  allowlisted,
  CAPABILITIES,
  CLI_NAME,
  type Claim,
  type CrossAccountLink,
  cleanText,
  dayStart,
  declaredLimits,
  type EndpointKind,
  type EndpointView,
  type Envelope,
  findSecret,
  type GateVerdict,
  gateRefusal,
  HUMAN_HANDLE,
  honestSender,
  joinRedacted,
  judgeDetailForAgents,
  type JudgePolicy,
  LIMITS,
  MESSAGE_KINDS,
  type MessageKind,
  newId,
  one,
  PREAMBLE,
  type Presence,
  PROTOCOL,
  parseXMessage,
  RelayError,
  randomHex,
  replyGrant,
  type SendParams,
  type SendResult,
  SERVER_FIELDS,
  type Sql,
  SYSTEM_HANDLE,
  sameSecret,
  untilTomorrow,
  type Wake,
  type XContact,
  XCounters,
  type XDelivered,
  type XEnvelopeFrom,
  type XListed,
  XLIMITS,
  type XMessage,
  type XRelease,
  xlimits,
} from "@scp-dev/core"
import { FederatedCore, MACHINE_NAME, type MirrorChange, type XEndpoint } from "./federation"
import { type Deliver, type HoldView, type JudgeClientFactory, JudgeGate, type JudgeLimits } from "./judge-gate"

export type HubAuth = "account" | "account+bridge"

export type HubRole = "owner" | "admin" | "member"

/** what the host proved about the token, plus its privilege */
export interface HubGrant {
  tokenId: string
  userId: string
  actorId: string | null
  expiresAt: number
  /** a scoped token, not a full login; a grant that doesn't say false counts as scoped */
  scoped: boolean
  /** the actor's org role; null on a personal account */
  role: HubRole | null
  /** labels set on every endpoint the token claims or mirrors, over the client's own for the same keys */
  labels?: Record<string, string>
}

/** per-socket state; JSON-serialisable, so the host can persist it with the socket */
export interface HubConn {
  id: string
  grant: HubGrant
  role: "new" | "client" | "bridge" | "observer"
  /** the machine a bridge or agent client is bound to; a human's or observer's namespace for unqualified handles */
  machine: string | null
  /** the hub endpoint id a client connection acts as */
  endpoint: string | null
  watching: boolean
  subscribed: boolean
  /** whether a human client said a terminal is attached */
  tty?: boolean
}

/** a bound machine, or a revoked token's name kept as a tombstone */
export interface MachineRow {
  name: string
  kind: string
  online: boolean
  bridge: boolean
  created_at: string | null
  last_seen: string | null
}

/** an endpoint as the dashboard graph draws it */
export interface GraphNode {
  address: string
  kind: EndpointKind
  harness: string | null
  title: string | null
  presence: Presence
  status: EndpointView["status"]
  last_seen: string | null
  parent: string | null
  wake?: Wake | null
}

/** `spawn`: parent to child; `message`: sender to recipient, with the count and newest send in the graph's window */
export type GraphEdge = { kind: "spawn"; from: string; to: string } | { kind: "message"; from: string; to: string; count: number; last_at: string }

/** a machine as the graph draws it: `actor` is the member who bound it, null for the personal account's owner or a revoked name */
export interface GraphMachine extends MachineRow {
  actor: string | null
}

export interface HubGraph {
  /** the window message edges count over */
  minutes: number
  machines: GraphMachine[]
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** the default and widest window of message edges; the core keeps an hour of sender and recipient pairs */
export const GRAPH_MINUTES = 15
export const GRAPH_MINUTES_MAX = 60

/** what a read-only dashboard stream sees as it happens: addresses, kinds and presence, never a body, note, summary or label */
export type DashboardEvent =
  | { type: "presence"; at: string; machine: string | null; endpoint: string; presence: Presence }
  | { type: "message"; at: string; kind: string; from: string; to: string[]; local?: true }
  | { type: "endpoints"; at: string; machine: string }

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)

/** a watcher's fleet event as a dashboard sees it, field by field; null for the kinds a dashboard does not stream */
export function dashboardEvent(event: Record<string, unknown>, at: string): DashboardEvent | null {
  if (event.type === "message") {
    const from = str(event.from)
    const to = Array.isArray(event.to) ? event.to.filter((a): a is string => typeof a === "string") : []
    if (!from || !to.length) return null
    return { type: "message", at, kind: str(event.kind) ?? "message", from, to, ...(event.local === true ? { local: true as const } : {}) }
  }
  if (event.type === "presence") {
    const endpoint = str(event.endpoint)
    const presence = event.presence === "online" || event.presence === "idle" || event.presence === "offline" ? event.presence : null
    return endpoint && presence ? { type: "presence", at, machine: str(event.machine), endpoint, presence } : null
  }
  return null
}

export interface HubSocket {
  conn: HubConn
  send(text: string): void
  close(code: number, reason: string): void
}

export interface HubDeps {
  sql: Sql
  /** synchronous sha256 hex */
  hash: (value: string) => string
  /** runs fn in one synchronous storage transaction */
  transaction?: <T>(fn: () => T) => T
  now?: () => number
  /** every live socket of this account (rebuilt from persisted state when the host restarts) */
  sockets(): HubSocket[]
  /** persist socket.conn after the hub changed it */
  save(socket: HubSocket): void
  /** structured log line, e.g. relay_action; never bodies or tokens */
  log?: (event: string, fields: Record<string, unknown>) => void
  /** live presence, endpoint and message metadata for a read-only dashboard; never a body */
  dashboard?: (event: DashboardEvent) => void
  /** overrides of {@link HUB_LIMITS}; `Infinity` disables a cap, count or byte limit, durations stay finite */
  limits?: Partial<HubLimits>
  /** the link to other accounts' relays; without it an address of another account is not found */
  crossAccount?: CrossAccountLink
}

/** what a configured judge needs besides its policy */
export interface HubJudgeOptions {
  /** where the model's key_env is read */
  env: Record<string, string | undefined>
  /** the model client (default the provider's HTTP API) */
  client?: JudgeClientFactory | undefined
  /** overrides of the judge's own caps; `Infinity` disables one */
  limits?: Partial<JudgeLimits> | undefined
}

export const HUB_LIMITS = {
  machines: 16,
  endpoints: 512,
  sockets: 64,
  frameBytes: 262_144,
  callsPerMinute: 120,
  bridgeCallsPerMinute: 600,
  accountCallsPerMinute: 1200,
  acksPerMinute: 1200,
  accountAcksPerMinute: 4800,
  storedBytes: 256 * 1024 * 1024,
  clientMachineIdleS: 14 * 86_400,
  idlePurgeS: 30 * 86_400,
  httpWaitS: 25,
  revalidateMs: 300_000,
  deniedS: 3600,
  refusalsPerMinute: 10,
} as const

export type HubLimits = { [K in keyof typeof HUB_LIMITS]: number }

const DURATIONS = ["clientMachineIdleS", "idlePurgeS", "httpWaitS", "revalidateMs", "deniedS"] as const satisfies readonly (keyof HubLimits)[]

const SWEEP_MS = 10 * 60_000
const DAY_MS = 86_400_000
const MIN_ALARM_MS = 60_000
const REVALIDATE_RETRY_MS = 30_000
const REVALIDATE_ERROR = "revalidate_error:"
const DENIED = "denied:"
const TOUCH_MS = 10_000

const HUB_MIGRATION = [
  `CREATE TABLE IF NOT EXISTS machines (name TEXT PRIMARY KEY, token_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER)`,
  `CREATE TABLE IF NOT EXISTS hub_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS machine_tombstones (name TEXT PRIMARY KEY, actor_id TEXT, user_id TEXT, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS local_events (from_ep TEXT NOT NULL, to_ep TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS local_events_at ON local_events (at)`,
]

/** kinds a bridge reports for a delivery its broker made on its own machine */
export const LOCAL_EVENT_KINDS = ["message", "request", "reply", "status", "handback", "spawn"] as const
/** events per `local_events` frame, recipients per event, and how far back an event's `at` may lie */
export const LOCAL_EVENTS = { perFrame: 200, recipients: 64, maxAgeMs: 300_000 } as const
const LOCAL_KEEP_MS = 3_600_000
const HASH_ID = /^[0-9a-f]{8,64}$/

const OBSERVER_METHODS = new Set(["list", "snapshot", "watch", "log", "machines", "machines_rm"])
const CLIENT_METHODS = new Set(["whoami", "send", "ask", "ask_wait", "inbox", "ack", "status", "event", ...OBSERVER_METHODS])

type Request = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown }
type Params = Record<string, unknown>

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

function rpcError(error: unknown): { code: number; message: string; data?: { code: string; retry_after?: number } } {
  if (!(error instanceof RelayError)) return { code: -32603, message: "internal error", data: { code: "unavailable" } }
  const code = error.code === "method_not_found" ? -32601 : error.code === "invalid_params" ? -32602 : -32000
  return { code, message: error.message, data: { code: error.code, ...(error.retryAfterS ? { retry_after: error.retryAfterS } : {}) } }
}

/** a frame's place in a full mirror sent in several frames (`part` of `parts` under one `id`), or null for a mirror of one frame */
function mirrorSync(value: unknown): { id: string; part: number; parts: number } | null {
  if (value === undefined || value === null) return null
  const { id, part, parts } = value as { id?: unknown; part?: unknown; parts?: unknown }
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 64 ||
    !Number.isInteger(parts) ||
    (parts as number) < 1 ||
    (parts as number) > 4096 ||
    !Number.isInteger(part) ||
    (part as number) < 1 ||
    (part as number) > (parts as number)
  ) {
    throw new RelayError("invalid_params", "sync is { id, part, parts } of a full mirror in several frames")
  }
  return { id, part: part as number, parts: parts as number }
}

function serverFields(params: Params): void {
  for (const field of SERVER_FIELDS) if (field in params) throw new RelayError("invalid_params", `${field} is set by the relay, not the sender`)
}

function object(value: unknown, what: string): Params {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("invalid_params", `${what} must be an object`)
  return value as Params
}

/** a full login: a grant that doesn't say it is unscoped counts as scoped */
const fullLogin = (grant: HubGrant): boolean => grant.scoped === false

/** a full login of the member `actorId` (null: the personal account's owner) */
const fullOf = (grant: HubGrant, actorId: string | null): boolean => fullLogin(grant) && grant.actorId === actorId

/** a full login of an org owner or admin, or of a personal account (its owner) */
const accountAdmin = (grant: HubGrant): boolean =>
  fullLogin(grant) && (grant.role === "owner" || grant.role === "admin" || ((grant.role ?? null) === null && grant.actorId === null))

/** the grant's labels over `labels`; a value that is not a label object is left for the core to refuse */
function grantLabels(grant: HubGrant, labels: unknown): unknown {
  if (!grant.labels || !Object.keys(grant.labels).length) return labels
  if (labels !== undefined && labels !== null && (typeof labels !== "object" || Array.isArray(labels))) return labels
  return { ...(labels as Record<string, unknown> | null | undefined), ...grant.labels }
}

/** each mirrored view with the grant's labels over its own */
function grantViews(grant: HubGrant, views: unknown): unknown {
  if (!grant.labels || !Array.isArray(views)) return views
  return views.map((view: unknown) =>
    view && typeof view === "object" && !Array.isArray(view) ? { ...view, labels: grantLabels(grant, (view as Params).labels) } : view,
  )
}

function listFilters(params: Params): { all?: boolean; harness?: string | undefined; kind?: EndpointKind | undefined; presence?: Presence | undefined } {
  return {
    all: params.all === true,
    harness: typeof params.harness === "string" ? params.harness : undefined,
    kind: params.kind === "agent" || params.kind === "human" ? params.kind : undefined,
    presence: params.presence === "online" || params.presence === "idle" || params.presence === "offline" ? params.presence : undefined,
  }
}

/** the hosted relay of one account: machines, bridges, direct clients, push and replay over a FederatedCore; pure, sockets are injected */
export class RelayHub {
  private core: FederatedCore | null = null
  private account = ""
  private readonly now: () => number
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly buckets = new Map<string, { rate: number; tokens: number; at: number; refused: number }>()
  private readonly transient = new Set<HubSocket>()
  private readonly gone = new Set<string>()
  /** per machine, the full mirror its bridge is sending in several frames; lost on eviction, which only skips that sync's offline sweep */
  private readonly syncs = new Map<string, { id: string; parts: number; next: number; seen: Set<string> }>()
  private stored: number | null = null
  private denied: Map<string, number> | null = null
  private xcounters: XCounters | null = null
  private xkey: string | null = null
  private readonly limits: Readonly<HubLimits>
  private judgeConfig: { policy: JudgePolicy; options: HubJudgeOptions } | null = null
  private gate: JudgeGate | null = null

  constructor(private readonly deps: HubDeps) {
    this.now = deps.now ?? Date.now
    this.limits = { ...HUB_LIMITS, ...deps.limits }
    for (const key of DURATIONS) if (!Number.isFinite(this.limits[key])) throw new RangeError(`hub limit ${key} must be finite`)
  }

  /** idempotent: migrates and records the account handle (the address user part, e.g. "ada"); call before handling each request */
  init(account: { user: string }): void {
    if (this.core && this.account === account.user) return
    for (const statement of HUB_MIGRATION) this.deps.sql.all(statement)
    const columns = this.deps.sql.all<{ name: string }>(`PRAGMA table_info(machines)`).map((c) => c.name)
    if (!columns.includes("user_id")) this.deps.sql.all(`ALTER TABLE machines ADD COLUMN user_id TEXT`)
    if (!columns.includes("actor_id")) this.deps.sql.all(`ALTER TABLE machines ADD COLUMN actor_id TEXT`)
    const core = new FederatedCore(this.deps.sql, {
      user: account.user,
      now: this.now,
      hash: this.deps.hash,
      ...(this.deps.transaction ? { transaction: this.deps.transaction } : {}),
      auth: "account",
      endpointCap: this.limits.endpoints,
      refusalsPerMinute: this.limits.refusalsPerMinute,
      capEverySender: true,
      xinbox: this.deps.crossAccount !== undefined,
    })
    core.migrate()
    this.core = core
    this.gate = null
    this.account = account.user
    if (this.deps.crossAccount) {
      this.xkey = core.xstate("key", () => randomHex(32))
      this.xcounters = new XCounters(this.deps.sql, this.now)
    }
  }

  /** forgets the core and in-memory state after the object's storage was deleted; the next init migrates afresh */
  reset(): void {
    this.core = null
    this.account = ""
    this.stored = null
    this.denied = null
    this.xcounters = null
    this.xkey = null
    this.gate = null
    this.buckets.clear()
    this.gone.clear()
  }

  /**
   * judges this account's own sends (client send and ask, bridge forward) before delivery; sends to other accounts are left to the
   * cross-account gate. Without a policy, or with mode off, the hub holds no judge and creates no judge tables
   */
  configureJudge(policy: JudgePolicy | undefined, options: HubJudgeOptions = { env: {} }): void {
    this.gate = null
    this.judgeConfig = policy && policy.mode !== "off" ? { policy, options } : null
  }

  /** the held messages, newest first, without bodies */
  holds(state?: string): HoldView[] {
    return this.judged().holds(state)
  }

  /** one hold with its body while it waits */
  holdShow(id: string): ReturnType<JudgeGate["show"]> {
    return this.judged().show(id)
  }

  /** delivers a held message as its sender, every send check run again */
  holdRelease(id: string, options: { redacted?: boolean; by: string }): Promise<SendResult> {
    return this.judged().release(id, options, this.deliverJudged)
  }

  /** refuses a held message: never delivered, its sender told why */
  holdRefuse(id: string, reason: string, by: string): HoldView {
    return this.judged().refuse(id, reason, by)
  }

  /** a fresh connection state for an accepted socket */
  static connection(grant: HubGrant): HubConn {
    return { id: newId("conn"), grant, role: "new", machine: null, endpoint: null, watching: false, subscribed: false }
  }

  /** a socket would exceed the `sockets` limit: the host refuses it (429) instead of accepting */
  full(): boolean {
    return this.deps.sockets().length >= this.limits.sockets
  }

  /** one JSON-RPC text frame from a socket; replies and pushes go out through socket.send */
  async message(socket: HubSocket, text: string): Promise<void> {
    if (new TextEncoder().encode(text).length > this.limits.frameBytes) {
      this.write(socket, { jsonrpc: "2.0", id: null, error: rpcError(new RelayError("too_large", `a frame is at most ${this.limits.frameBytes} bytes`)) })
      socket.close(1009, "frame too large")
      this.closed(socket)
      return
    }
    let request: unknown
    try {
      request = JSON.parse(text)
    } catch {
      this.write(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
      return
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      this.write(socket, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "one JSON-RPC request per frame" } })
      return
    }
    const response = await this.handle(socket, request as Request)
    if (response) this.write(socket, response)
  }

  /** the socket closed (any reason) */
  closed(socket: HubSocket): void {
    this.release(socket, false)
  }

  /** POST /v1/relay/rpc: a JSON-RPC request or batch run in order on a short-lived connection; returns the response(s) */
  async batch(grant: HubGrant, body: unknown): Promise<unknown> {
    if (JSON.stringify(body ?? null).length > this.limits.frameBytes) {
      return { jsonrpc: "2.0", id: null, error: rpcError(new RelayError("too_large", `a request is at most ${this.limits.frameBytes} bytes`)) }
    }
    const requests = Array.isArray(body) ? body : [body]
    if (!requests.length) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "an empty batch" } }
    const socket: HubSocket = { conn: RelayHub.connection(grant), send: () => {}, close: () => {} }
    this.transient.add(socket)
    const responses: unknown[] = []
    try {
      for (const request of requests) {
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          responses.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "a request is an object" } })
          continue
        }
        const response = await this.handle(socket, request as Request)
        if (response) responses.push(response)
      }
    } finally {
      this.closed(socket)
      this.transient.delete(socket)
    }
    return Array.isArray(body) ? responses : (responses[0] ?? null)
  }

  /**
   * closes every socket (and in-flight /rpc call) whose grant matches with 1008, audits it, and unbinds the machines
   * the matching grants bound behind a tombstone of their member, keeping their endpoint rows and queued messages;
   * returns how many closed
   */
  revoke(match: { tokenId?: string; userId?: string; actorId?: string }): number {
    const keys = (Object.entries(match) as [keyof HubGrant, string | undefined][]).filter(([, value]) => value !== undefined)
    if (!keys.length) return 0
    let closed = 0
    const tokens = new Set(match.tokenId !== undefined ? [match.tokenId] : [])
    for (const socket of [...this.deps.sockets(), ...this.transient]) {
      if (this.gone.has(socket.conn.id) || !keys.every(([key, value]) => socket.conn.grant[key] === value)) continue
      tokens.add(socket.conn.grant.tokenId)
      this.kick(socket, "the token was revoked")
      closed++
    }
    if (closed) this.relay.record("revoke", null, null, { sockets: closed })
    const columns = match.tokenId !== undefined ? [["token_id", match.tokenId]] : keys.map(([key, value]) => [key === "userId" ? "user_id" : "actor_id", value])
    const where = columns.map(([column]) => `${column} = ?`).join(" AND ")
    const now = this.now()
    for (const row of this.deps.sql.all<{ name: string; token_id: string; actor_id: string | null; user_id: string | null }>(
      `DELETE FROM machines WHERE ${where} RETURNING name, token_id, actor_id, user_id`,
      ...columns.map(([, value]) => value!),
    )) {
      tokens.add(row.token_id)
      this.deps.sql.all(`INSERT OR REPLACE INTO machine_tombstones (name, actor_id, user_id, at) VALUES (?, ?, ?, ?)`, row.name, row.actor_id, row.user_id, now)
      this.relay.record("machine_unbind", null, row.name, { machine: row.name })
    }
    const denied = this.deniedGrants()
    for (const token of tokens) {
      denied.set(DENIED + token, now)
      this.setState(DENIED + token, now)
    }
    this.deps.log?.("relay_action", { account: this.account, method: "revoke", sockets: closed })
    return closed
  }

  /**
   * the host's alarm: revalidates each socket's grant and sweeps; returns the next alarm time in ms, or null. A failed
   * check closes with 1008, an expired grant with 4001 (reconnect for a new one). A check that throws keeps the
   * sockets and retries in 30 s; once a token's checks kept throwing for the `revalidateMs` limit its sockets close
   * with the retryable 1013.
   */
  async alarm(validate: (grant: HubGrant) => Promise<boolean>): Promise<number | null> {
    const now = this.now()
    this.xcounters?.trueUp()
    const checks = new Map<string, Promise<boolean | null>>()
    const erroring = new Set<string>()
    for (const socket of [...this.deps.sockets()]) {
      const grant = socket.conn.grant
      if (grant.expiresAt <= now) {
        this.kick(socket, "the token grant expired, reconnect", 4001)
        continue
      }
      const key = JSON.stringify([grant.tokenId, grant.userId, grant.actorId, grant.expiresAt, grant.scoped, grant.role])
      let check = checks.get(key)
      if (!check) {
        check = validate(grant).catch((error: unknown) => {
          this.deps.log?.("relay_revalidate_error", { account: this.account, error: error instanceof Error ? error.name : "error" })
          return null
        })
        checks.set(key, check)
      }
      const valid = await check
      if (valid === false) {
        this.kick(socket, "the token is no longer valid")
      } else if (valid === null) {
        erroring.add(grant.tokenId)
        const key = REVALIDATE_ERROR + grant.tokenId
        let since = this.state(key)
        if (since === null) {
          since = now
          this.setState(key, since)
        }
        if (now - since >= this.limits.revalidateMs) this.kick(socket, "the token could not be revalidated, try again", 1013)
      }
    }
    for (const { key } of this.deps.sql.all<{ key: string }>(`SELECT key FROM hub_state WHERE key LIKE ?`, `${REVALIDATE_ERROR}%`)) {
      const tokenId = key.slice(REVALIDATE_ERROR.length)
      const lingering = this.deps.sockets().some((s) => s.conn.grant.tokenId === tokenId && !this.gone.has(s.conn.id))
      if (!erroring.has(tokenId) || !lingering) this.deps.sql.all(`DELETE FROM hub_state WHERE key = ?`, key)
    }
    this.setState("last_validated", now)
    if (now - (this.state("last_sweep") ?? 0) >= SWEEP_MS) {
      this.relay.sweep()
      this.deps.sql.all(`DELETE FROM local_events WHERE at <= ?`, now - LOCAL_KEEP_MS)
      this.expireMachines(now)
      this.forgetTombstones(now)
      const denied = this.deniedGrants()
      for (const [key, at] of denied) {
        if (at > now - this.limits.deniedS * 1000) continue
        denied.delete(key)
        this.deps.sql.all(`DELETE FROM hub_state WHERE key = ?`, key)
      }
      this.stored = null
      this.gone.clear()
      for (const [key, bucket] of this.buckets) if (bucket.tokens + ((now - bucket.at) * bucket.rate) / 60_000 >= bucket.rate) this.buckets.delete(key)
      this.xcounters?.prune()
      this.judgeGate()?.sweep()
      this.setState("last_sweep", now)
    }
    if (this.idle(now)) {
      if (this.state("idle_since") === null) this.setState("idle_since", now)
    } else {
      this.deps.sql.all(`DELETE FROM hub_state WHERE key = 'idle_since'`)
    }
    return this.nextAlarm()
  }

  /** when the next alarm should fire (earliest grant expiry, revalidation or its retry after an error, sweep, retention), or null when the hub holds nothing */
  nextAlarm(): number | null {
    const now = this.now()
    const trueUp = this.xcounters?.dueAt() ?? null
    const held = this.retentionAlarm(now)
    const retention = held === null || trueUp === null ? (held ?? trueUp) : Math.min(held, trueUp)
    const sockets = this.deps.sockets()
    if (!sockets.length) return retention
    let validated = this.state("last_validated")
    if (validated === null) {
      validated = now
      this.setState("last_validated", validated)
    }
    let swept = this.state("last_sweep")
    if (swept === null) {
      swept = now
      this.setState("last_sweep", swept)
    }
    const retrying = one(this.deps.sql, `SELECT 1 FROM hub_state WHERE key LIKE ? LIMIT 1`, `${REVALIDATE_ERROR}%`) !== undefined
    return Math.min(
      validated + (retrying ? REVALIDATE_RETRY_MS : this.limits.revalidateMs),
      swept + SWEEP_MS,
      retention ?? Number.POSITIVE_INFINITY,
      ...sockets.map((s) => s.conn.grant.expiresAt),
    )
  }

  /** the account held no machines, tombstones, sockets or queued messages for the `idlePurgeS` limit: the object may delete its storage */
  purgeDue(): boolean {
    const since = this.state("idle_since")
    return since !== null && this.now() - since >= this.limits.idlePurgeS * 1000 && this.idle(this.now())
  }

  /** while the hub holds rows: the earliest unacked delivery's expiry, at most a day and at least a minute away */
  private retentionAlarm(now: number): number | null {
    const sql = this.deps.sql
    const held = one<{ held: number }>(
      sql,
      `SELECT EXISTS (SELECT 1 FROM machines) OR EXISTS (SELECT 1 FROM machine_tombstones) OR EXISTS (SELECT 1 FROM endpoints WHERE handle NOT IN (?, ?))
       OR EXISTS (SELECT 1 FROM messages) OR EXISTS (SELECT 1 FROM deliveries) OR EXISTS (SELECT 1 FROM audit) AS held`,
      HUMAN_HANDLE,
      SYSTEM_HANDLE,
    )!.held
    if (!held) return null
    const expiry = one<{ at: number | null }>(sql, `SELECT MIN(expires_at) AS at FROM deliveries WHERE acked_at IS NULL`)!.at
    return Math.max(now + MIN_ALARM_MS, Math.min(expiry ?? Number.POSITIVE_INFINITY, now + DAY_MS))
  }

  /** no machine bound or tombstoned, no live socket and nothing queued */
  private idle(now: number): boolean {
    if (this.deps.sockets().some((s) => !this.gone.has(s.conn.id))) return false
    return !one<{ busy: number }>(
      this.deps.sql,
      `SELECT EXISTS (SELECT 1 FROM machines) OR EXISTS (SELECT 1 FROM machine_tombstones) OR EXISTS (SELECT 1 FROM deliveries WHERE acked_at IS NULL AND expires_at > ?) AS busy`,
      now,
    )!.busy
  }

  // dispatch

  private get relay(): FederatedCore {
    if (!this.core) throw new Error("RelayHub.init was not called")
    return this.core
  }

  private async handle(socket: HubSocket, request: Request): Promise<object | null> {
    const id = request.id ?? null
    const method = String(request.method)
    let code = "ok"
    try {
      this.refuseDenied(socket)
      this.spend(socket, method, request.params)
      const result = await this.dispatch(socket, method, object(request.params, "params"))
      return request.id === undefined ? null : { jsonrpc: "2.0", id, result }
    } catch (error) {
      code = error instanceof RelayError ? error.code : "internal"
      if (code === "internal") this.deps.log?.("relay_internal_error", { account: this.account, method, error: error instanceof Error ? error.name : "error" })
      return request.id === undefined ? null : { jsonrpc: "2.0", id, error: rpcError(error) }
    } finally {
      this.deps.log?.("relay_action", { account: this.account, machine: socket.conn.machine, method, code })
    }
  }

  /**
   * one call from the token's bucket for the connection's role (a bridge, or a bridge hello, has its own, larger one)
   * and from the account's; acks (one token per seq) and rejects spend from separate ack buckets of the token and the
   * account instead, so they never starve calls, and an activity event is refused once either call bucket is below a
   * quarter, so sends keep the rest
   */
  private spend(socket: HubSocket, method: string, params: unknown): void {
    const conn = socket.conn
    const now = this.now()
    if ((method === "ack" && (conn.role === "client" || conn.role === "bridge")) || (method === "reject" && conn.role === "bridge")) {
      const seqs = (params as Params | null)?.seqs
      const cost = method === "ack" && Array.isArray(seqs) ? Math.min(Math.max(seqs.length, 1), LIMITS.inboxPage) : 1
      const token = this.bucket(`${conn.grant.tokenId}:ack`, this.limits.acksPerMinute, now)
      const account = this.bucket("account:ack", this.limits.accountAcksPerMinute, now)
      for (const [b, scope] of [
        [token, "a token"],
        [account, "an account"],
      ] as const) {
        if (b.tokens < cost)
          throw new RelayError("rate_limited", `at most ${b.rate} acked seqs per minute on ${scope}`, Math.max(1, Math.ceil(((cost - b.tokens) * 60) / b.rate)))
      }
      token.tokens -= cost
      account.tokens -= cost
      return
    }
    const bridge = conn.role === "bridge" || (conn.role === "new" && method === "hello" && (params as Params | null)?.bridge === true)
    const rate = bridge ? this.limits.bridgeCallsPerMinute : this.limits.callsPerMinute
    const bucket = this.bucket(`${conn.grant.tokenId}:${bridge ? "bridge" : "client"}`, rate, now)
    const account = this.bucket("account", this.limits.accountCallsPerMinute, now)
    if (method === "event") {
      for (const b of [bucket, account]) {
        if (b.tokens < b.rate / 4)
          throw new RelayError(
            "rate_limited",
            "activity events wait while the token or the account is near its call limit",
            Math.max(1, Math.ceil(((b.rate / 4 - b.tokens) * 60) / b.rate)),
          )
      }
    }
    if (bucket.tokens < 1) {
      if (++bucket.refused >= rate) {
        socket.close(1013, "rate limited")
        this.closed(socket)
      }
      throw new RelayError(
        "rate_limited",
        `at most ${rate} ${bridge ? "bridge " : ""}calls per minute on a token`,
        Math.max(1, Math.ceil(((1 - bucket.tokens) * 60) / rate)),
      )
    }
    if (account.tokens < 1) {
      throw new RelayError(
        "rate_limited",
        `at most ${this.limits.accountCallsPerMinute} calls per minute on an account`,
        Math.max(1, Math.ceil(((1 - account.tokens) * 60) / account.rate)),
      )
    }
    bucket.tokens -= 1
    bucket.refused = 0
    account.tokens -= 1
  }

  private bucket(key: string, rate: number, now: number): { rate: number; tokens: number; at: number; refused: number } {
    if (rate === Number.POSITIVE_INFINITY) return { rate, tokens: rate, at: now, refused: 0 }
    const bucket = this.buckets.get(key) ?? { rate, tokens: rate, at: now, refused: 0 }
    bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.at) * rate) / 60_000)
    bucket.at = now
    this.buckets.set(key, bucket)
    return bucket
  }

  private async dispatch(socket: HubSocket, method: string, params: Params): Promise<unknown> {
    if (this.gone.has(socket.conn.id)) throw new RelayError("unauthorized", "this connection is closed")
    if (method === "hello") return this.hello(socket, params)
    if (socket.conn.role === "new") throw new RelayError("unauthorized", "call hello first")
    if (socket.conn.role === "bridge") return this.bridgeMethod(socket, method, params)
    if (socket.conn.role === "observer" && !OBSERVER_METHODS.has(method)) {
      if (CLIENT_METHODS.has(method)) throw new RelayError("unauthorized", "this connection only observes: say hello as an agent or the human")
      throw new RelayError("method_not_found", `no method ${method}`)
    }
    return this.clientMethod(socket, method, params)
  }

  private hello(socket: HubSocket, params: Params): unknown {
    const core = this.relay
    const conn = socket.conn
    if (conn.role !== "new") throw new RelayError("invalid_params", "hello was already called on this connection")
    if (params.protocol !== PROTOCOL) throw new RelayError("invalid_params", `this relay speaks ${PROTOCOL}`)
    if (params.transient !== undefined)
      throw new RelayError("invalid_params", "the hub takes no hook connections: hooks report to the local broker, which bridges them")
    serverFields(params)
    const observe = params.observe === true
    const named = params.machine
    if (
      (!observe || named !== undefined) &&
      (typeof named !== "string" || !MACHINE_NAME.test(named) || named === "me" || named === "local" || named === this.account)
    ) {
      throw new RelayError("invalid_params", "machine is a name of lowercase letters, digits and -, other than me, local and the account handle")
    }
    const bridge = params.bridge === true
    const human = params.human === true
    this.deps.sql.all(`DELETE FROM hub_state WHERE key = 'idle_since'`)
    const info = { account: this.account, capabilities: CAPABILITIES, server_time: new Date(this.now()).toISOString(), limits: { ...LIMITS, ...this.limits } }
    if (observe) {
      if (bridge || human || params.claim !== undefined || params.resume !== undefined)
        throw new RelayError("invalid_params", "an observer hello has no bridge, human, claim or resume")
      conn.role = "observer"
      conn.machine = typeof named === "string" ? named : null
      this.save(socket)
      return { ...info, ...(conn.machine ? { machine: conn.machine } : {}) }
    }
    const machine = named as string
    const base = { ...info, machine }
    if (bridge && this.transient.has(socket)) throw new RelayError("invalid_params", "a bridge connects over the WebSocket")
    if (human && typeof params.tty !== "boolean")
      throw new RelayError("invalid_params", "a human hello says whether a terminal is attached (tty: true or false)")

    if (human) {
      if (!fullLogin(conn.grant)) throw new RelayError("unauthorized", "a scoped token acts as an agent: use --as")
      const endpoint = core.claimHuman(params.tty as boolean)
      conn.role = "client"
      conn.machine = machine
      conn.endpoint = endpoint.id
      conn.tty = params.tty as boolean
      this.save(socket)
      this.fleet({ type: "presence", machine, endpoint: endpoint.address, presence: endpoint.presence, harness: endpoint.harness, labels: endpoint.labels })
      return { ...base, endpoint, preamble: PREAMBLE }
    }

    const claimed = object(params.claim, "claim")
    const claim = (conn.grant.labels ? { ...claimed, labels: grantLabels(conn.grant, claimed.labels) } : claimed) as Claim
    const held = this.bindable(machine, conn.grant)

    if (bridge) {
      this.bind(machine, conn.grant, "bridge", held)
      core.adoptClaimed(machine)
      conn.role = "bridge"
      conn.machine = machine
      this.save(socket)
      for (const other of [...this.deps.sockets()]) {
        if (other.conn.id === conn.id || other.conn.role !== "bridge" || other.conn.machine !== machine) continue
        other.close(4000, "replaced by a newer bridge for this machine")
        this.release(other, true)
      }
      core.record("bridge", null, machine, { machine })
      return { ...base, endpoints: core.remoteViews({ except: machine }), others: this.othersOf(conn.grant, machine) }
    }

    if (one<{ kind: string }>(this.deps.sql, `SELECT kind FROM machines WHERE name = ?`, machine)?.kind === "bridge") {
      throw new RelayError(
        "invalid_params",
        `machine ${machine} is linked through its broker's bridge; run the command there without --cloud, or pick another --machine`,
      )
    }
    let endpoint: EndpointView
    let token: string | undefined
    if (typeof params.resume === "string")
      endpoint = core.resumeOn(machine, params.resume, conn.grant.labels ? (own) => grantLabels(conn.grant, own) : undefined)
    else ({ endpoint, token } = core.claimOn(machine, claim, "account"))
    this.bind(machine, conn.grant, "client", held)
    conn.role = "client"
    conn.machine = machine
    conn.endpoint = endpoint.id
    this.save(socket)
    this.fleet({ type: "presence", machine, endpoint: endpoint.address, presence: endpoint.presence, harness: endpoint.harness, labels: endpoint.labels })
    this.announceEndpoint(endpoint.id)
    return { ...base, endpoint, ...(token ? { token } : {}), preamble: PREAMBLE }
  }

  /** refuses a machine bound to another token, a revoked token's machine to anyone but its member or an admin, or one past the machine cap; returns whether this token already holds it */
  private bindable(machine: string, grant: HubGrant): boolean {
    const bound = one<{ token_id: string }>(this.deps.sql, `SELECT token_id FROM machines WHERE name = ?`, machine)
    if (bound && bound.token_id !== grant.tokenId) {
      this.relay.record("refuse", null, machine, { code: "unauthorized", machine })
      throw new RelayError("unauthorized", `machine ${machine} is bound to another token; release it with ${CLI_NAME} machines rm ${machine}`)
    }
    if (bound) return true
    const tomb = one<{ actor_id: string | null }>(this.deps.sql, `SELECT actor_id FROM machine_tombstones WHERE name = ?`, machine)
    if (tomb && !fullOf(grant, tomb.actor_id) && !accountAdmin(grant)) {
      this.relay.record("refuse", null, machine, { code: "unauthorized", machine })
      throw new RelayError(
        "unauthorized",
        `machine ${machine} was unbound when its token was revoked; a full login of the same member (or an org owner or admin) can take it back, or ${CLI_NAME} machines rm ${machine} drops its queued messages`,
      )
    }
    const count = one<{ n: number }>(this.deps.sql, `SELECT COUNT(*) AS n FROM machines`)!.n
    if (count >= this.limits.machines)
      throw new RelayError("too_large", `at most ${this.limits.machines} machines per account; release one with ${CLI_NAME} machines rm`)
    return false
  }

  /** binds the machine to the token once its hello succeeded; `held` is what bindable() returned */
  private bind(machine: string, grant: HubGrant, kind: "bridge" | "client", held: boolean): void {
    const core = this.relay
    const now = this.now()
    if (held) {
      this.deps.sql.all(
        `UPDATE machines SET last_seen = ?, user_id = ?, actor_id = ?, kind = CASE WHEN kind = 'bridge' THEN 'bridge' ELSE ? END WHERE name = ?`,
        now,
        grant.userId,
        grant.actorId,
        kind,
        machine,
      )
      return
    }
    this.deps.sql.all(
      `INSERT INTO machines (name, token_id, user_id, actor_id, kind, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      machine,
      grant.tokenId,
      grant.userId,
      grant.actorId,
      kind,
      now,
      now,
    )
    this.deps.sql.all(`DELETE FROM machine_tombstones WHERE name = ?`, machine)
    this.deps.sql.all(`DELETE FROM hub_state WHERE key = 'idle_since'`)
    core.record("machine_bind", null, machine, { machine, kind })
    this.deps.log?.("relay_action", { account: this.account, machine, method: "machine_bind", code: "ok" })
  }

  private async clientMethod(socket: HubSocket, method: string, params: Params): Promise<unknown> {
    const core = this.relay
    const conn = socket.conn
    const me = conn.endpoint
    if (me) core.touch(me, TOUCH_MS)
    switch (method) {
      case "list":
        if (params.contacts === true) return { contacts: await this.contactList() }
        return { endpoints: core.list(listFilters(params)) }
      case "snapshot":
        return core.snapshot({ all: params.all === true, activity: typeof params.activity === "number" ? params.activity : undefined })
      case "watch":
        conn.watching = true
        this.save(socket)
        return core.snapshot({ activity: 20 })
      case "log":
        // no hosted connection is a verified human at a terminal: judge rows lose their reason and kinds (the dashboard shows them)
        return {
          rows: core
            .log({ since: params.since as number | undefined, limit: params.limit as number | undefined })
            .map((row) => (row.event.startsWith("judge_") ? { ...row, detail: judgeDetailForAgents(row.detail) } : row)),
        }
      case "machines":
        return { machines: this.machineList() }
      case "machines_rm":
        return this.releaseMachine(socket, params.name)
    }
    if (!me) throw new RelayError("unauthorized", "this connection has no endpoint")
    switch (method) {
      case "whoami":
        return core.whoami(me)
      case "send":
      case "ask": {
        serverFields(params)
        const send = { ...(params as unknown as SendParams) }
        delete (send as Params).wait_s
        if (method === "ask") send.kind = "request"
        const origin = conn.tty === undefined ? {} : { tty: conn.tty }
        const gate = this.judgeGate()
        const result = gate
          ? await gate.send(me, send, { ...origin, machine: conn.machine }, this.deliverJudged)
          : this.deliverOn(conn.machine, me, send, origin)
        if (method === "send" || result.held) return result
        return this.awaitReply(socket, me, result.id, this.waitMs(socket, params.wait_s), result)
      }
      case "ask_wait": {
        if (typeof params.id !== "string") throw new RelayError("invalid_params", "id is the request's message id")
        return this.awaitReply(socket, me, params.id, this.waitMs(socket, params.wait_s))
      }
      case "inbox": {
        const query = { after: params.after as number | undefined, limit: params.limit as number | undefined }
        const deadline = Date.now() + this.waitMs(socket, params.wait_s)
        let messages = core.inbox(me, query)
        while (!messages.length && !this.gone.has(conn.id) && Date.now() < deadline) {
          await this.waitFor(me, deadline - Date.now(), socket)
          messages = core.inbox(me, query)
        }
        return { messages, next: messages.length ? messages[messages.length - 1]!.seq : (query.after ?? 0) }
      }
      case "ack":
        return { acked: core.ack(me, params.seqs) }
      case "status": {
        core.status(me, params.state, params.note)
        const view = core.whoami(me)
        this.fleet({ type: "status", machine: conn.machine, endpoint: view.address, status: view.status })
        this.announceEndpoint(me)
        return view
      }
      case "event": {
        const row = core.event(me, params)
        this.fleet({ type: "activity", machine: conn.machine, ...row })
        return row
      }
    }
    throw new RelayError("method_not_found", `no method ${method}`)
  }

  private async bridgeMethod(socket: HubSocket, method: string, params: Params): Promise<unknown> {
    const core = this.relay
    const conn = socket.conn
    const machine = conn.machine!
    switch (method) {
      case "mirror": {
        const sync = mirrorSync(params.sync)
        if (!sync) {
          const full = params.full === true
          const changes = core.mirror(machine, grantViews(conn.grant, params.endpoints), { full, auth: "account+bridge" })
          this.announce(machine, changes, full)
          return { changed: changes.length }
        }
        let state = this.syncs.get(machine)
        if (sync.part === 1) {
          state = { id: sync.id, parts: sync.parts, next: 1, seen: new Set() }
          this.syncs.set(machine, state)
        }
        const intact = state !== undefined && state.id === sync.id && state.parts === sync.parts && state.next === sync.part
        if (!intact) this.syncs.delete(machine)
        const closing = intact && sync.part === sync.parts
        const changes = core.mirror(machine, grantViews(conn.grant, params.endpoints), {
          full: closing,
          auth: "account+bridge",
          ...(intact ? { seen: state!.seen } : {}),
        })
        if (intact) state!.next++
        if (closing) this.syncs.delete(machine)
        this.announce(machine, changes, closing)
        return { changed: changes.length }
      }
      case "forward": {
        const sender = core.remoteEndpoint(machine, params.from)
        const send = { ...object(params.params, "params") }
        serverFields(send)
        const asked = params.hop_floor ?? 0
        if (!Number.isInteger(asked) || (asked as number) < 0 || (asked as number) > 1000) throw new RelayError("invalid_params", "hop_floor is a hop count")
        if ([send.to].flat().some((to) => core.foreignAccount(to) !== null)) return this.xsend(sender, send, { tty: params.tty === true, hop: asked as number })
        delete send.attachments
        const floor = Math.min(asked as number, LIMITS.hopMax + 1)
        if (floor > 0) core.markReceived(sender, floor - 1)
        const gate = this.judgeGate()
        const origin = { tty: params.tty === true }
        if (gate) return gate.send(sender, send as unknown as SendParams, { ...origin, machine }, this.deliverJudged)
        return this.deliverOn(machine, sender, send as unknown as SendParams, origin)
      }
      case "subscribe": {
        const after = params.after ?? 0
        if (!Number.isInteger(after) || (after as number) < 0) throw new RelayError("invalid_params", "after is a seq")
        if (this.deps.crossAccount) core.xsenders(await this.xinbound())
        conn.subscribed = true
        this.save(socket)
        let cursor = 0
        let replayed = 0
        for (;;) {
          const page = core.pending(machine, Math.max(cursor, after as number), 200, cursor)
          for (const delivery of page)
            this.write(socket, { jsonrpc: "2.0", method: "deliver", params: { seq: delivery.seq, endpoint: delivery.endpoint, message: delivery.message } })
          replayed += page.length
          if (page.length) cursor = page[page.length - 1]!.seq
          if (page.length < 200) break
        }
        return { replayed, next: Math.max(cursor, after as number) }
      }
      case "ack":
        return { acked: core.ackOn(machine, params.seqs) }
      case "reject": {
        const { notice } = core.rejectOn(machine, params.seq, params.code)
        if (notice) this.route(notice.seq, notice.endpoint)
        return { rejected: true }
      }
      case "event": {
        const sender = core.remoteEndpoint(machine, params.from)
        const row = core.event(sender, params)
        this.fleet({ type: "activity", machine, ...row })
        return row
      }
      case "local_events":
        return { recorded: this.localEvents(machine, params.events) }
      case "list":
        if (params.contacts === true) return { contacts: await this.contactList() }
        return { endpoints: core.list(listFilters(params)) }
      case "watch":
        conn.watching = true
        this.save(socket)
        return core.snapshot({ activity: 20 })
    }
    throw new RelayError("method_not_found", `no method ${method} on a bridge`)
  }

  // other accounts

  /**
   * A bridge's forward to another account's endpoint, writing no row here: shape, the contact, the sender on this account's allowlist,
   * its scope (or the reply grant of the message it answers), the caps, the scrubber, the egress gate, then the peer relay. Anything
   * unresolvable is not_found, as for a missing endpoint.
   */
  private async xsend(
    sender: string,
    send: Params,
    origin: { tty: boolean; hop: number; judged?: boolean; clientId?: string; id?: string },
  ): Promise<SendResult> {
    const core = this.relay
    const link = this.deps.crossAccount
    const targets = [send.to].flat()
    const missing = () => new RelayError("not_found", `no endpoint ${targets.map(String).join(", ")}`)
    if (targets.length !== 1) throw new RelayError("invalid_params", "a message to another account goes to exactly one endpoint: no lists, groups or tree:")
    const target = core.foreignAccount(targets[0])
    if (!target || !link || !this.xcounters || !this.xkey) throw missing()
    if (typeof send.body !== "string") throw new RelayError("invalid_params", "body must be a string")
    const bytes = new TextEncoder().encode(send.body).length
    if (bytes > XLIMITS.bodyBytes) throw new RelayError("too_large", `a message to another account is at most ${XLIMITS.bodyBytes} bytes; this one is ${bytes}`)
    if (send.attachments !== undefined && !(Array.isArray(send.attachments) && !send.attachments.length))
      throw new RelayError("data_class_refused", "attachments stay in this account")
    if (send.data_class === "private") throw new RelayError("data_class_refused", "a private message stays in this account")
    if (send.data_class !== undefined && send.data_class !== "public") throw new RelayError("invalid_params", "data_class must be public or private")
    const kind = (send.kind ?? "message") as MessageKind
    if (!MESSAGE_KINDS.includes(kind)) throw new RelayError("invalid_params", `kind must be one of ${MESSAGE_KINDS.join(", ")}`)
    if (send.reply_to !== undefined && typeof send.reply_to !== "string") throw new RelayError("invalid_params", "reply_to is a message id")
    if (origin.hop > XLIMITS.hopMax)
      throw new RelayError(
        "loop_guard",
        `this message would be hop ${origin.hop} of a chain across accounts (limit ${XLIMITS.hopMax}); stop and report to your user`,
      )
    const contact = await link.contactByHandle(target.account)
    if (!contact || contact.dir === "in" || contact.peerHandle !== target.account) throw missing()
    const me = core.xsender(sender)
    if (!me || !allowlisted(contact.allow, me.machine, me.handle, me.depth)) throw missing()
    const address = `${target.account}/${target.machine}/${target.handle || "me"}`
    const replyTo = (send.reply_to as string | undefined) ?? null
    const parent = replyTo ? core.xreceived(me.remote, replyTo) : null
    const answered = parent && parent.from_account === contact.peerId ? (JSON.parse(parent.message) as Envelope) : null
    const granted = answered && answered.from.address === address ? parent : null
    if (!granted && !core.crossAdmission(sender, "out", target).ok) throw missing()
    const now = this.now()
    const thread = granted?.thread ?? cleanText(send.thread, "thread", 64) ?? newId("thr", now)
    const hop = Math.max(origin.hop, granted ? answered!.hop + 1 : 0)
    if (hop > XLIMITS.hopMax)
      throw new RelayError("loop_guard", `this message would be hop ${hop} of a chain across accounts (limit ${XLIMITS.hopMax}); stop and report to your user`)
    this.xcounters.check(contact, me.remote, address, thread)
    const secret = findSecret(send.body)
    if (secret) throw new RelayError("secret_refused", `the message looks like it carries a credential (${secret}); send a reference instead`)
    const ttl = send.ttl_s ?? LIMITS.ttlDefaultS
    if (!Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > LIMITS.ttlMaxS)
      throw new RelayError("invalid_params", `ttl_s must be 1 to ${LIMITS.ttlMaxS}`)
    const self = link.self
    const own = `${self.handle}/${me.machine}/${me.handle || "me"}`
    const human = me.kind === "human" && me.handle === "" && origin.tty
    const from: XEnvelopeFrom = {
      account: self.handle,
      address: human ? `${self.handle}/me` : own,
      human,
      auth: "contact",
      rel: `contact:${self.handle}`,
      machine: me.machine,
      harness: me.harness,
    }
    const id = origin.id ?? newId("msg", now)
    const expiresAt = now + (ttl as number) * 1000
    const declared = declaredLimits(contact.limits)
    const msg: XMessage = {
      id,
      from,
      to: `${target.machine}/${target.handle}`,
      body: send.body,
      kind,
      thread,
      reply_to: replyTo,
      hop,
      client_id: origin.clientId ?? this.deps.hash(`${own}|${address}|${cleanText(send.client_id, "client_id", 128) ?? newId("cid", now)}`),
      created_at: now,
      expires_at: expiresAt,
      ...(granted?.grant ? { reply_grant: granted.grant, reply_grant_expires_at: granted.expires_at } : {}),
      grant: replyGrant(this.deps.hash, this.xkey, id, own, contact.peerId, expiresAt),
      ...(declared ? { limits: declared } : {}),
    }
    const verdict: GateVerdict = origin.judged
      ? { verdict: "pass" }
      : await link.gate.egress(msg, { side: "egress", account: self.handle, peer: contact.peerHandle, peer_id: contact.peerId, sender })
    if (verdict.verdict === "refuse") throw gateRefusal(verdict, "egress")
    if (verdict.verdict === "hold") return { id: verdict.hold_id, thread, hop, deliveries: [], held: { hold_id: verdict.hold_id, side: "egress" } }
    if (verdict.verdict === "duplicate") return { id: verdict.hold_id, thread, hop, deliveries: [], duplicate: true }
    if (verdict.verdict === "redact") {
      const result = await this.xsend(sender, { ...send, body: verdict.body }, { ...origin, judged: true })
      const redacted = joinRedacted(verdict.redacted, result.redacted)
      return { ...result, ...(redacted ? { redacted } : {}) }
    }
    this.xcounters.check(contact, me.remote, address, thread)
    const refund = this.xcounters.sent(contact, me.remote, address, thread)
    let delivered: XDelivered
    try {
      delivered = await link.deliver(contact, msg)
    } catch (error) {
      if (!(error instanceof RelayError) || error.code === "unavailable") refund()
      throw error
    }
    this.fleet({ type: "message", machine: me.machine, id: delivered.id, thread, kind, from: from.address, to: [address], hop })
    return {
      id: delivered.id,
      thread,
      hop,
      deliveries: [{ endpoint: address, address, seq: 0, offline: delivered.state === "queued", last_seen: null }],
      ...(delivered.duplicate ? { duplicate: true } : {}),
      ...(delivered.held ? { held: { hold_id: delivered.held.hold_id, side: "ingress" as const } } : {}),
      ...(delivered.redacted ? { redacted: delivered.redacted } : {}),
    }
  }

  /**
   * A message from the account `fromAccountId`'s relay (the host's internal route, never a client): the contact, the target on this
   * account's allowlist, its scope (or the reply grant), shape, a retry's earlier answer, the scrubber, the ingress gate, then one xinbox
   * row pushed to the target's bridge. Anything unresolvable is not_found, as for a missing endpoint.
   */
  async xreceive(fromAccountId: string, raw: unknown, judged = false): Promise<XDelivered> {
    const core = this.relay
    const link = this.deps.crossAccount
    const msg = parseXMessage(raw)
    const missing = () => new RelayError("not_found", `no endpoint ${link?.self.handle ?? this.account}/${msg.to}`)
    if (!link || !this.xcounters || !this.xkey) throw missing()
    const contact = await link.contactById(fromAccountId)
    if (!contact || contact.dir === "out" || contact.peerId !== fromAccountId || msg.from.account !== contact.peerHandle) throw missing()
    const target = core.xendpoint(msg.to)
    if (!target || !allowlisted(contact.allow, target.machine, target.handle, target.depth)) throw missing()
    const address = `${link.self.handle}/${target.machine}/${target.handle || "me"}`
    const grantExpiry = msg.reply_grant_expires_at
    const granted =
      msg.reply_to !== null &&
      msg.reply_grant !== undefined &&
      grantExpiry !== undefined &&
      grantExpiry > this.now() &&
      sameSecret(msg.reply_grant, replyGrant(this.deps.hash, this.xkey, msg.reply_to, address, fromAccountId, grantExpiry))
    const parts = msg.from.address.split("/")
    const peer = {
      account: contact.peerHandle,
      machine: parts.length === 3 ? parts[1]! : (msg.from.machine ?? "me"),
      handle: parts.length === 3 && parts[2] !== "me" ? parts[2]! : "",
    }
    if (!granted && !core.crossAdmission(target.id, "in", peer).ok) throw missing()
    if (!honestSender(msg.from)) throw new RelayError("invalid_params", "the sender is not one its relay may name")
    const bytes = new TextEncoder().encode(msg.body).length
    if (bytes > XLIMITS.bodyBytes) throw new RelayError("too_large", `a message from another account is at most ${XLIMITS.bodyBytes} bytes`)
    if (msg.hop > XLIMITS.hopMax) throw new RelayError("loop_guard", `hop ${msg.hop} is past the limit across accounts (${XLIMITS.hopMax})`)
    if (msg.expires_at <= this.now()) throw new RelayError("invalid_params", "the message expired")
    const earlier = core.xduplicate(fromAccountId, msg.client_id)
    if (earlier) return { id: earlier.id, state: earlier.acked ? "delivered" : "queued", duplicate: true }
    const envelope: Envelope = {
      id: msg.id,
      thread: msg.thread,
      reply_to: msg.reply_to,
      kind: msg.kind,
      from: {
        address: msg.from.address,
        endpoint: msg.from.address,
        user: contact.peerHandle,
        auth: "contact",
        ...(msg.from.machine ? { machine: msg.from.machine } : {}),
        claims: { harness: msg.from.harness ?? null, model: null },
        rel: `contact:${contact.peerHandle}`,
        account: contact.peerHandle,
        ...(msg.from.human ? { human: true as const } : {}),
      },
      to: address,
      body: { text: msg.body, mime: "text/markdown" },
      data_class: "public",
      attachments: [],
      hop: msg.hop,
      created_at: new Date(msg.created_at).toISOString(),
      expires_at: new Date(msg.expires_at).toISOString(),
    }
    const message = JSON.stringify(envelope)
    const stored = new TextEncoder().encode(message).length
    this.xadmit(fromAccountId, contact, msg, target, stored)
    const secret = findSecret(msg.body)
    if (secret) throw new RelayError("secret_refused", `the message looks like it carries a credential (${secret})`)
    const verdict: GateVerdict = judged
      ? { verdict: "pass" }
      : await link.gate.ingress(msg, { side: "ingress", account: link.self.handle, peer: contact.peerHandle, peer_id: fromAccountId })
    if (verdict.verdict === "refuse") throw gateRefusal(verdict, "ingress")
    if (verdict.verdict === "hold") return { id: msg.id, state: "queued", held: { hold_id: verdict.hold_id } }
    if (verdict.verdict === "duplicate") return { id: msg.id, state: "delivered", duplicate: true }
    if (verdict.verdict === "redact") return { ...(await this.xreceive(fromAccountId, { ...msg, body: verdict.body }, true)), redacted: verdict.redacted }
    const raced = () => {
      const row = core.xduplicate(fromAccountId, msg.client_id)
      return row ? { id: row.id, state: row.acked ? ("delivered" as const) : ("queued" as const), duplicate: true } : null
    }
    const again = raced()
    if (again) return again
    this.xadmit(fromAccountId, contact, msg, target, stored)
    const seq = core.xinsert({
      id: msg.id,
      from_account: fromAccountId,
      client_id: msg.client_id,
      endpoint: target.remote,
      sender: msg.from.address,
      message,
      thread: msg.thread,
      grant: msg.grant ?? null,
      expires_at: msg.expires_at,
      at: this.now(),
    })
    if (seq === null) return raced()!
    this.stash(stored)
    let pushed = false
    for (const socket of this.deps.sockets()) {
      if (socket.conn.role !== "bridge" || !socket.conn.subscribed || socket.conn.machine !== target.machine || this.gone.has(socket.conn.id)) continue
      this.write(socket, { jsonrpc: "2.0", method: "deliver", params: { seq, endpoint: target.remote, message: envelope } })
      pushed = true
    }
    this.wake(target.id)
    this.fleet({
      type: "message",
      machine: msg.from.machine ?? null,
      id: msg.id,
      thread: msg.thread,
      kind: msg.kind,
      from: msg.from.address,
      to: [address],
      hop: msg.hop,
    })
    return { id: msg.id, state: pushed ? "delivered" : "queued" }
  }

  /** this account's endpoints the account `fromAccountId` may reach under its contact's allowlist: address, harness and presence only */
  async xlist(fromAccountId: string): Promise<XListed[]> {
    const link = this.deps.crossAccount
    if (!link) return []
    const contact = await link.contactById(fromAccountId)
    if (!contact || contact.dir === "out" || contact.peerId !== fromAccountId) return []
    return this.relay
      .xendpoints()
      .filter((e) => allowlisted(contact.allow, e.machine, e.handle, e.depth))
      .map((e) => ({ address: `${link.self.handle}/${e.machine}/${e.handle || "me"}`, harness: e.harness, presence: e.presence }))
  }

  /**
   * throws when one more message from `fromAccountId` would pass a cap of this side: the pair a minute and an hour and the contact a
   * day (the lower of this account's limits for the contact and the sender's declared ones), the thread, the account's stored bytes or
   * the target's unread messages; counted from xinbox itself, so a wake keeps them
   */
  private xadmit(fromAccountId: string, contact: XContact, msg: XMessage, target: XEndpoint, bytes: number): void {
    const core = this.relay
    const now = this.now()
    const { perMinute, perHour, perDay } = xlimits(contact.limits, msg.limits)
    const counts = core.xcounts(fromAccountId, msg.from.address, target.remote, dayStart(now))
    const retry = (since: number | null, ms: number) => Math.max(1, Math.ceil(((since ?? now) + ms - now) / 1000))
    if (counts.minute >= perMinute)
      throw new RelayError("rate_limited", `${perMinute} messages from ${msg.from.address} to ${msg.to} a minute`, retry(counts.minuteAt, 60_000))
    if (counts.hour >= perHour)
      throw new RelayError("rate_limited", `${perHour} messages from ${msg.from.address} to ${msg.to} an hour`, retry(counts.hourAt, 3_600_000))
    if (counts.day >= perDay) throw new RelayError("rate_limited", `${perDay} messages from ${contact.peerHandle} today`, untilTomorrow(now))
    if (core.xthreadCount(target.remote, msg.thread) >= XLIMITS.threadMax)
      throw new RelayError("loop_guard", `thread ${msg.thread} reached ${XLIMITS.threadMax} messages across accounts`)
    const cap = this.limits.storedBytes
    if (this.storedNow() + bytes > cap) throw new RelayError("inbox_full", `the receiving account's relay holds its cap of ${cap} bytes of messages`)
    const unread = core.xunread(target)
    if (unread >= LIMITS.inboxMax) throw new RelayError("inbox_full", `${msg.to} has ${unread} unread messages`)
  }

  /**
   * deletes the queued messages of every account that is no longer an active contact allowed to message this one, after the
   * contacts changed; nothing when the contacts cannot be loaded
   */
  async xprune(): Promise<void> {
    if (!this.deps.crossAccount || !this.core) return
    const senders = await this.xinbound()
    if (!senders || !this.core) return
    this.relay.xsenders(senders)
    if (this.relay.xprune(senders)) this.stored = null
  }

  /** the accounts whose messages this account takes now: active contacts with dir in or both; null when they cannot be loaded */
  private async xinbound(): Promise<Set<string> | null> {
    const contacts = await this.deps.crossAccount?.contacts()
    return contacts ? new Set(contacts.filter((contact) => contact.dir !== "out").map((contact) => contact.peerId)) : null
  }

  /** what every contact this account may message lets it reach */
  private async contactList(): Promise<XListed[]> {
    const link = this.deps.crossAccount
    if (!link) return []
    const contacts = ((await link.contacts()) ?? []).filter((contact) => contact.dir !== "in")
    const lists = await Promise.all(
      contacts.map((contact) =>
        link.list(contact).then(
          (list) => ({ contact, list }),
          () => ({ contact, list: [] as XListed[] }),
        ),
      ),
    )
    return lists.flatMap(({ contact, list }) =>
      list
        .filter((e) => typeof e?.address === "string" && e.address.startsWith(`${contact.peerHandle}/`))
        .map((e) => ({
          address: e.address,
          harness: typeof e.harness === "string" ? e.harness : null,
          presence: typeof e.presence === "string" ? e.presence : "offline",
        })),
    )
  }

  // judge

  /** the judge, made on first use once configured; null when it is not */
  private judgeGate(): JudgeGate | null {
    if (!this.judgeConfig) return null
    if (this.gate) return this.gate
    const core = this.relay
    const { policy, options } = this.judgeConfig
    const gate = new JudgeGate({
      sql: this.deps.sql,
      core,
      now: this.now,
      env: options.env,
      client: options.client,
      limits: options.limits,
      log: (line) => this.deps.log?.("relay_judge", { account: this.account, line }),
      wake: (endpoint) => this.wake(endpoint),
      notice: (endpoint, text) => this.xnotice(endpoint, text),
      within: (origin, fn) => core.within(origin.machine ?? null, fn),
    })
    gate.configure(policy)
    this.gate = gate
    return gate
  }

  private judged(): JudgeGate {
    const gate = this.judgeGate()
    if (!gate) throw new RelayError("not_found", "this relay has no judge")
    return gate
  }

  /** a send of this account as it runs unjudged: room for the body, the core send on the sender's machine, then push */
  private deliverOn(machine: string | null, from: string, send: SendParams, origin: { tty?: boolean }): SendResult {
    const core = this.relay
    const bytes = this.room(from, send.body)
    const result = core.within(machine, () => core.send(from, send, origin))
    if (!result.duplicate) this.stash(bytes)
    if (!result.duplicate) this.delivered(from, result, send.kind ?? "message")
    return result
  }

  private readonly deliverJudged: Deliver = async (from, send, { machine, ...origin }) => this.deliverOn(machine ?? null, from, send, origin)

  // push and wait

  private delivered(from: string, result: SendResult, kind: string): void {
    const core = this.relay
    for (const delivery of result.deliveries) this.route(delivery.seq, delivery.endpoint)
    this.fleet({
      type: "message",
      machine: core.machineOf(from),
      id: result.id,
      thread: result.thread,
      kind,
      from: core.addressOf(from),
      to: result.deliveries.map((d) => d.address),
      hop: result.hop,
    })
  }

  /**
   * a bridge's metadata for deliveries its broker made on its own machine: counted for the graph and streamed to watchers and the
   * dashboard as `local`; unknown endpoints and malformed events are skipped
   */
  private localEvents(machine: string, value: unknown): number {
    if (!Array.isArray(value) || value.length > LOCAL_EVENTS.perFrame)
      throw new RelayError("invalid_params", `events is a list of at most ${LOCAL_EVENTS.perFrame}`)
    const core = this.relay
    const now = this.now()
    const resolve = (handle: unknown): string | null => {
      try {
        return core.remoteEndpoint(machine, handle)
      } catch {
        return null
      }
    }
    let recorded = 0
    for (const raw of value) {
      if (typeof raw !== "object" || raw === null) continue
      const event = raw as Params
      const kind = (LOCAL_EVENT_KINDS as readonly unknown[]).includes(event.kind) ? (event.kind as string) : null
      const at = typeof event.at === "number" && Number.isFinite(event.at) ? Math.min(Math.max(event.at, now - LOCAL_EVENTS.maxAgeMs), now) : null
      const from = resolve(event.from)
      if (!kind || at === null || !from || !Array.isArray(event.to) || event.to.length > LOCAL_EVENTS.recipients) continue
      const to = [...new Set(event.to.map(resolve).filter((id): id is string => id !== null && id !== from))]
      if (!to.length) continue
      for (const ep of to) this.deps.sql.all(`INSERT INTO local_events (from_ep, to_ep, at) VALUES (?, ?, ?)`, from, ep, at)
      this.fleet({
        type: "message",
        machine,
        local: true,
        ...(typeof event.id === "string" && HASH_ID.test(event.id) ? { id: event.id } : {}),
        ...(typeof event.thread === "string" && HASH_ID.test(event.thread) ? { thread: event.thread } : {}),
        kind,
        from: core.addressOf(from),
        to: to.map((ep) => core.addressOf(ep)),
      })
      recorded++
    }
    return recorded
  }

  /** the body's bytes when the account can hold them; refuses a send past the `storedBytes` limit */
  private room(sender: string, body: unknown): number {
    if (typeof body !== "string") return 0
    const bytes = new TextEncoder().encode(body).length
    const cap = this.limits.storedBytes
    if (this.storedNow() + bytes > cap) {
      this.relay.record("refuse", sender, null, { code: "too_large" })
      throw new RelayError(
        "too_large",
        `the account relay holds its cap of ${cap} bytes of message bodies; ack or let messages expire, or release a machine with ${CLI_NAME} machines rm`,
      )
    }
    return bytes
  }

  /** bytes of message bodies held, and of the messages from other accounts */
  private storedNow(): number {
    const xinbox = this.deps.crossAccount ? ` + (SELECT COALESCE(SUM(LENGTH(CAST(message AS BLOB))), 0) FROM xinbox)` : ""
    this.stored ??= one<{ n: number }>(this.deps.sql, `SELECT (SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) FROM messages)${xinbox} AS n`)!.n
    return this.stored
  }

  private stash(bytes: number): void {
    if (this.stored !== null) this.stored += bytes
  }

  /** wakes direct waiters and pushes a delivery for a mirrored row to the subscribed bridge of its machine */
  private route(seq: number, endpoint: string): void {
    this.wake(endpoint)
    const delivery = this.relay.delivery(seq)
    if (!delivery?.endpoint || !delivery.mirrored) return
    const machine = delivery.endpoint.slice(0, delivery.endpoint.indexOf("/"))
    for (const socket of this.deps.sockets()) {
      if (socket.conn.role === "bridge" && socket.conn.subscribed && socket.conn.machine === machine) {
        this.write(socket, { jsonrpc: "2.0", method: "deliver", params: { seq, endpoint: delivery.endpoint, message: delivery.message } })
      }
    }
  }

  /** a machine's endpoint changes: `endpoints` to the other bridges, presence and status to watchers */
  private announce(machine: string, changes: MirrorChange[], full: boolean): void {
    if (full || changes.length) {
      const endpoints = full ? this.relay.remoteRowsOf(machine) : changes.map((c) => (c.was === undefined ? c.view : { ...c.view, was: c.was }))
      this.toBridges(machine, { machine, endpoints, full })
    }
    for (const change of changes) {
      const view = change.view
      if (change.added || change.presence)
        this.fleet({ type: "presence", machine, endpoint: view.address, presence: view.presence, harness: view.harness, labels: view.labels })
      if (change.status && !change.added) this.fleet({ type: "status", machine, endpoint: view.address, status: view.status })
    }
    if (full || changes.some((c) => c.added || c.was !== undefined)) this.dash({ type: "endpoints", at: new Date(this.now()).toISOString(), machine })
  }

  /** a direct client's endpoint changed: the other bridges mirror it */
  private announceEndpoint(endpoint: string): void {
    const machine = this.relay.machineOf(endpoint)
    if (!machine) return
    const view = this.relay.remoteRowsOf(machine).find((v) => v.id === endpoint)
    if (view) this.toBridges(machine, { machine, endpoints: [view], full: false })
  }

  /** `own` tells each bridge whether a bound machine is its member's own device */
  private toBridges(machine: string, params: Record<string, unknown>): void {
    const bound = one<{ actor_id: string | null }>(this.deps.sql, `SELECT actor_id FROM machines WHERE name = ?`, machine)
    for (const socket of this.deps.sockets()) {
      if (socket.conn.role !== "bridge" || socket.conn.machine === machine) continue
      const own = bound ? { own: (bound.actor_id ?? null) === (socket.conn.grant.actorId ?? null) } : {}
      this.write(socket, { jsonrpc: "2.0", method: "endpoints", params: { ...params, ...own } })
    }
  }

  /** the machines of other members than the grant's, which a bridge shows under the account handle */
  private othersOf(grant: HubGrant, except: string): string[] {
    return this.deps.sql
      .all<{ name: string }>(`SELECT name FROM machines WHERE name != ? AND actor_id IS NOT ?`, except, grant.actorId ?? null)
      .map((row) => row.name)
  }

  private fleet(event: Record<string, unknown>): void {
    const at = new Date(this.now()).toISOString()
    for (const socket of this.deps.sockets()) if (socket.conn.watching) this.write(socket, { jsonrpc: "2.0", method: "fleet", params: { at, ...event } })
    const dash = this.deps.dashboard ? dashboardEvent(event, at) : null
    if (dash) this.dash(dash)
  }

  private dash(event: DashboardEvent): void {
    try {
      this.deps.dashboard?.(event)
    } catch {
      this.deps.log?.("relay_dashboard_failed", { account: this.account })
    }
  }

  private write(socket: HubSocket, value: unknown): void {
    if (this.gone.has(socket.conn.id)) return
    try {
      socket.send(JSON.stringify(value))
    } catch {
      this.deps.log?.("relay_send_failed", { account: this.account, machine: socket.conn.machine })
    }
  }

  private save(socket: HubSocket): void {
    if (this.transient.has(socket)) return
    this.deps.save(socket)
  }

  private waitMs(socket: HubSocket, value: unknown): number {
    if (value === undefined) return 0
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RelayError("invalid_params", "wait_s must be a number of seconds")
    return Math.min(value, this.transient.has(socket) ? this.limits.httpWaitS : LIMITS.waitMaxS) * 1000
  }

  private wake(endpoint: string): void {
    const set = this.waiters.get(endpoint)
    if (!set) return
    this.waiters.delete(endpoint)
    for (const fn of set) fn()
  }

  private waitFor(endpoint: string, ms: number, socket: HubSocket): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters.get(endpoint)?.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      let set = this.waiters.get(endpoint)
      if (!set) {
        set = new Set()
        this.waiters.set(endpoint, set)
      }
      set.add(done)
      if (this.gone.has(socket.conn.id)) done()
    })
  }

  private async awaitReply(socket: HubSocket, me: string, request: string, ms: number, sent?: object): Promise<unknown> {
    const core = this.relay
    const deadline = Date.now() + ms
    for (;;) {
      const reply = core.replyTo(me, request)
      if (reply) {
        core.ack(me, [reply.seq])
        return { ...sent, id: request, reply }
      }
      if (core.requestExpired(request)) return { ...sent, id: request, expired: true }
      if (this.gone.has(socket.conn.id) || Date.now() >= deadline) return { ...sent, id: request, pending: true }
      await this.waitFor(me, deadline - Date.now(), socket)
    }
  }

  // connections and machines

  private kick(socket: HubSocket, reason: string, code = 1008): void {
    this.write(socket, { jsonrpc: "2.0", method: "revoked", params: { reason } })
    socket.close(code, reason)
    this.release(socket, false)
  }

  private release(socket: HubSocket, replaced: boolean): void {
    const conn = socket.conn
    if (this.gone.has(conn.id)) return
    this.gone.add(conn.id)
    if (conn.role === "new" || !this.core) return
    const core = this.core
    const bound = this.boundMachine(conn)
    if (conn.role === "client" && conn.endpoint) {
      const endpoint = conn.endpoint
      core.disconnect(endpoint)
      const machine = core.machineOf(endpoint)
      if (machine && one<{ kind: string }>(this.deps.sql, `SELECT kind FROM machines WHERE name = ?`, machine)?.kind === "bridge") {
        for (const delivery of core.adoptClaimed(machine, endpoint)) this.route(delivery.seq, delivery.endpoint)
      }
      this.wake(endpoint)
      const view = core.whoami(endpoint)
      this.fleet({ type: "presence", machine: conn.machine, endpoint: view.address, presence: view.presence })
      this.announceEndpoint(endpoint)
    } else if (conn.role === "bridge" && conn.machine) {
      const newer = this.deps
        .sockets()
        .some((s) => s.conn.id !== conn.id && s.conn.role === "bridge" && s.conn.machine === conn.machine && !this.gone.has(s.conn.id))
      if (!replaced && !newer) this.announce(conn.machine, core.markOffline(conn.machine), false)
    }
    if (bound) this.deps.sql.all(`UPDATE machines SET last_seen = ? WHERE name = ?`, this.now(), bound)
    conn.role = "new"
    conn.endpoint = null
    conn.subscribed = false
    conn.watching = false
    if (!this.transient.has(socket)) {
      try {
        this.deps.save(socket)
      } catch {}
    }
  }

  /** the machine a bridge or agent client connection holds; a human's or observer's machine is only a namespace */
  private boundMachine(conn: HubConn): string | null {
    if (!conn.machine || !this.core) return null
    if (conn.role === "bridge") return conn.machine
    return conn.role === "client" && conn.endpoint !== null && this.core.machineOf(conn.endpoint) === conn.machine ? conn.machine : null
  }

  /** machines a live connection holds */
  private liveMachines(): Set<string> {
    const live = new Set<string>()
    for (const socket of [...this.deps.sockets(), ...this.transient]) {
      const machine = this.gone.has(socket.conn.id) ? null : this.boundMachine(socket.conn)
      if (machine) live.add(machine)
    }
    return live
  }

  /** bindings, then names a revoke left behind (kind `revoked`) */
  /** a read-only view of the account for a dashboard: its machines, listed endpoints and latest activity */
  overview(activity = 20): { machines: MachineRow[]; endpoints: EndpointView[]; activity: ActivityRow[] } {
    const { endpoints, activity: rows } = this.relay.snapshot({ activity })
    return { machines: this.machineList(), endpoints, activity: rows }
  }

  /** a read-only graph for a dashboard: listed endpoints, spawn edges among them, and message counts per sender and recipient; never a body */
  graph(minutes = GRAPH_MINUTES): HubGraph {
    const window = Math.min(Math.max(1, Math.floor(Number.isFinite(minutes) ? minutes : GRAPH_MINUTES)), GRAPH_MINUTES_MAX)
    const endpoints = this.relay.list()
    const byId = new Map(endpoints.map((e) => [e.id, e.address]))
    const listed = new Set(byId.values())
    const nodes: GraphNode[] = endpoints.map((e) => ({
      address: e.address,
      kind: e.kind,
      harness: e.harness,
      title: e.title,
      presence: e.presence,
      status: e.status,
      last_seen: e.last_seen,
      parent: e.parent ?? null,
      ...(e.wake !== undefined ? { wake: e.wake } : {}),
    }))
    const edges: GraphEdge[] = nodes.flatMap((n) =>
      n.parent && n.parent !== n.address && listed.has(n.parent) ? [{ kind: "spawn" as const, from: n.parent, to: n.address }] : [],
    )
    const since = this.now() - window * 60_000
    const pairs = this.deps.sql.all<{ from_ep: string; to_ep: string; n: number; last: number }>(
      `SELECT from_ep, to_ep, COUNT(*) AS n, MAX(at) AS last FROM (
         SELECT from_ep, to_ep, at FROM pair_events WHERE at > ? UNION ALL SELECT from_ep, to_ep, at FROM local_events WHERE at > ?
       ) GROUP BY from_ep, to_ep`,
      since,
      since,
    )
    const traffic: GraphEdge[] = pairs.flatMap((row) => {
      const from = byId.get(row.from_ep)
      const to = byId.get(row.to_ep)
      return from && to && from !== to ? [{ kind: "message" as const, from, to, count: row.n, last_at: iso(row.last)! }] : []
    })
    edges.push(...traffic.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)))
    const actors = new Map(this.deps.sql.all<{ name: string; actor_id: string | null }>(`SELECT name, actor_id FROM machines`).map((r) => [r.name, r.actor_id]))
    const machines = this.machineList().map((m) => ({ ...m, actor: actors.get(m.name) ?? null }))
    return { minutes: window, machines, nodes, edges }
  }

  private machineList(): MachineRow[] {
    const sockets = this.deps.sockets().filter((s) => !this.gone.has(s.conn.id))
    const bound = this.deps.sql
      .all<{ name: string; kind: string; created_at: number; last_seen: number | null }>(`SELECT name, kind, created_at, last_seen FROM machines ORDER BY name`)
      .map((row) => ({
        name: row.name,
        kind: row.kind,
        online: sockets.some((s) => this.boundMachine(s.conn) === row.name),
        bridge: sockets.some((s) => s.conn.role === "bridge" && s.conn.machine === row.name),
        created_at: iso(row.created_at),
        last_seen: iso(row.last_seen),
      }))
    const revoked = this.deps.sql
      .all<{ name: string; at: number }>(`SELECT name, at FROM machine_tombstones WHERE name NOT IN (SELECT name FROM machines) ORDER BY name`)
      .map((row) => ({ name: row.name, kind: "revoked", online: false, bridge: false, created_at: null, last_seen: iso(row.at) }))
    return [...bound, ...revoked]
  }

  /**
   * only the token the machine is bound to, a full login of the member who bound it, or an admin may release it (or a revoked token's name);
   * while no connection holds a bound machine, any credential of that member may too, so a rotated token releases what the old one bound
   */
  private releaseMachine(caller: HubSocket, name: unknown): unknown {
    const core = this.relay
    if (typeof name !== "string" || !MACHINE_NAME.test(name)) throw new RelayError("invalid_params", "name is a machine name")
    const bound = one<{ token_id: string; actor_id: string | null }>(this.deps.sql, `SELECT token_id, actor_id FROM machines WHERE name = ?`, name)
    const tomb = bound ? undefined : one<{ actor_id: string | null }>(this.deps.sql, `SELECT actor_id FROM machine_tombstones WHERE name = ?`, name)
    if (!bound && !tomb) throw new RelayError("not_found", `no machine ${name}`)
    const grant = caller.conn.grant
    const member = !!bound && bound.actor_id !== null && grant.actorId === bound.actor_id
    if (!(bound?.token_id === grant.tokenId || fullOf(grant, (bound ?? tomb)!.actor_id) || accountAdmin(grant) || (member && !this.liveMachines().has(name)))) {
      core.record("refuse", null, name, { code: "unauthorized", machine: name })
      throw new RelayError(
        "unauthorized",
        `only the token machine ${name} is bound to, a full login of the member who bound it, or an org owner or admin can release it${member ? "; any credential of that member can once it is offline" : ""}`,
      )
    }
    for (const socket of [...this.deps.sockets()]) {
      if (socket.conn.id !== caller.conn.id && this.boundMachine(socket.conn) === name) this.kick(socket, `machine ${name} was released`)
    }
    const dropped = this.tx(() => {
      const count = core.dropMachine(name, { queue: true })
      this.deps.sql.all(`DELETE FROM machines WHERE name = ?`, name)
      this.deps.sql.all(`DELETE FROM machine_tombstones WHERE name = ?`, name)
      core.record("machine_release", null, name, { machine: name, endpoints: count })
      return count
    })
    this.stored = null
    this.toBridges(name, { machine: name, endpoints: [], full: true, released: true })
    this.dash({ type: "endpoints", at: new Date(this.now()).toISOString(), machine: name })
    this.deps.log?.("relay_action", { account: this.account, machine: name, method: "machine_release", code: "ok" })
    return { removed: name, endpoints: dropped }
  }

  /** releases client bindings with no live connection, idle for the `clientMachineIdleS` limit, with nothing queued and no unanswered ask open; bridge bindings never expire */
  private expireMachines(now: number): void {
    const core = this.relay
    const live = this.liveMachines()
    const idle = this.deps.sql.all<{ name: string }>(
      `SELECT name FROM machines WHERE kind = 'client' AND COALESCE(last_seen, created_at) <= ?`,
      now - this.limits.clientMachineIdleS * 1000,
    )
    for (const { name } of idle) {
      if (live.has(name)) continue
      const queued = one(
        this.deps.sql,
        `SELECT 1 FROM deliveries d JOIN endpoints e ON e.id = d.endpoint WHERE substr(e.remote, 1, ?) = ? AND d.acked_at IS NULL AND d.expires_at > ? LIMIT 1`,
        name.length + 1,
        `${name}/`,
        now,
      )
      const asking = one(
        this.deps.sql,
        `SELECT 1 FROM messages m JOIN endpoints e ON e.id = m.from_ep WHERE substr(e.remote, 1, ?) = ? AND m.kind = 'request' AND m.expires_at > ?
         AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.kind = 'reply') LIMIT 1`,
        name.length + 1,
        `${name}/`,
        now,
      )
      if (queued || asking) continue
      const dropped = this.tx(() => {
        const count = core.dropMachine(name)
        this.deps.sql.all(`DELETE FROM machines WHERE name = ?`, name)
        core.record("machine_expire", null, name, { machine: name, endpoints: count })
        return count
      })
      this.toBridges(name, { machine: name, endpoints: [], full: true, released: true })
      this.deps.log?.("relay_action", { account: this.account, machine: name, method: "machine_expire", code: "ok", endpoints: dropped })
    }
  }

  /** drops the tombstones past their age with nothing queued for their machine, and retires the rows and xinbox of each name still unbound */
  private forgetTombstones(now: number): void {
    const forgotten = this.tx(() => {
      const names = this.deps.sql.all<{ name: string }>(
        `DELETE FROM machine_tombstones WHERE at <= ? AND NOT EXISTS (SELECT 1 FROM deliveries d JOIN endpoints e ON e.id = d.endpoint
         WHERE substr(e.remote, 1, length(machine_tombstones.name) + 1) = machine_tombstones.name || '/' AND d.acked_at IS NULL AND d.expires_at > ?)
         RETURNING name`,
        now - (LIMITS.ttlMaxS + LIMITS.purgeAfterS) * 1000,
        now,
      )
      const unbound = names.map((row) => row.name).filter((name) => !one(this.deps.sql, `SELECT 1 FROM machines WHERE name = ?`, name))
      for (const name of unbound) this.relay.record("machine_forget", null, name, { machine: name, endpoints: this.relay.dropMachine(name, { queue: true }) })
      return unbound
    })
    for (const name of forgotten) this.toBridges(name, { machine: name, endpoints: [], full: true, released: true })
  }

  /** the hub_state keys (`denied:<tokenId>`) of tokens revoked lately, to when; loaded once per object lifetime */
  private deniedGrants(): Map<string, number> {
    this.denied ??= new Map(
      this.deps.sql.all<{ key: string; value: number }>(`SELECT key, value FROM hub_state WHERE key LIKE ?`, `${DENIED}%`).map((row) => [row.key, row.value]),
    )
    return this.denied
  }

  /** a token revoked lately is refused even when the host accepted its grant before the revoke reached the object */
  private refuseDenied(socket: HubSocket): void {
    const at = this.deniedGrants().get(DENIED + socket.conn.grant.tokenId)
    if (at === undefined || at <= this.now() - this.limits.deniedS * 1000) return
    this.kick(socket, "the token was revoked")
    throw new RelayError("unauthorized", "the token was revoked")
  }

  private tx<T>(fn: () => T): T {
    return this.deps.transaction ? this.deps.transaction(fn) : fn()
  }

  private state(key: string): number | null {
    return one<{ value: number }>(this.deps.sql, `SELECT value FROM hub_state WHERE key = ?`, key)?.value ?? null
  }

  private setState(key: string, value: number): void {
    this.deps.sql.all(`INSERT OR REPLACE INTO hub_state (key, value) VALUES (?, ?)`, key, value)
  }

  /**
   * a held cross-account message its account's human released (the host claimed the hold first): the rest of that side's path, with
   * every check run again and only the gate skipped. Egress sends as the stored sender with the time left, under the hold id its sender
   * got, and with the message's own client id, so the peer answers both a retried release and the sender's retry of the original as the
   * duplicate. Ingress runs xreceive again
   */
  async xrelease(hold: XRelease): Promise<SendResult | XDelivered> {
    if (hold.side === "ingress") return this.xreceive(hold.from_account, hold.message, true)
    const msg = hold.message
    const left = Math.ceil((msg.expires_at - this.now()) / 1000)
    if (left < 1) throw new RelayError("invalid_params", "the held message expired")
    const send: Params = {
      to: `${hold.peer}/${msg.to.endsWith("/") ? `${msg.to}me` : msg.to}`,
      body: msg.body,
      kind: msg.kind,
      thread: msg.thread,
      ...(msg.reply_to ? { reply_to: msg.reply_to } : {}),
      ttl_s: Math.min(left, LIMITS.ttlMaxS),
    }
    return this.xsend(hold.sender, send, { tty: msg.from.human, hop: msg.hop, judged: true, clientId: msg.client_id, id: hold.hold_id })
  }

  /** a status message from the relay to one of this account's endpoints (a held message's sender), pushed to its bridge */
  xnotice(endpoint: string, text: string): void {
    this.route(this.relay.judgeNoticeTo(endpoint, text), endpoint)
  }
}
