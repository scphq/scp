import { canonicalPolicy, GROUP_NAME, matches, type Policy, policyRefusal, type PolicySubject, type ScopeSubject, validSelector } from "./policy"
import {
  ACTIVITY_KINDS,
  CLI_NAME,
  type ActivityKind,
  type ActivityRow,
  type AdoptResult,
  type AuditRow,
  type Claim,
  type DataClass,
  type EndpointKind,
  type EndpointView,
  type Envelope,
  LIMITS,
  MESSAGE_KINDS,
  type MessageKind,
  type MessageReceipts,
  type PeekLevel,
  type PeekResult,
  type PeekSeen,
  type PeekState,
  type PeekTurn,
  type PeerView,
  type Presence,
  type Reach,
  RelayError,
  SCOPE_PRESETS,
  SPAWN_PROVIDER,
  type ScopeActor,
  type ScopeCap,
  type ScopeChange,
  type ScopeDirection,
  type ScopeEntry,
  type ScopePreset,
  type ScopeView,
  type SendParams,
  type SendResult,
  STATUS_STATES,
  type StatusState,
  type StopNudge,
  type StopWaitResult,
  type ThreadMessage,
  GENERIC_HARNESSES,
  harnessFits,
  keptHarness,
  validHandle,
  validHarness,
  type Wake,
  type WakeDecline,
  wakeDeclineOf,
  WAKES,
  type WhyResult,
} from "./protocol"
import { digestText, PEEK, peekLevel, readText } from "./peek"
import { clock, shortId, stripControl, wrapMessage } from "./render"
import {
  clipped,
  expandRules,
  groupCapKey,
  narrower,
  presetOf,
  PRESET_LISTS,
  relation,
  type ScopeCaps,
  relationText,
  scopeDecision,
  type ScopeDecision,
  type ScopeGroupRules,
  type ScopeNode,
  type ScopePolicyCap,
  type ScopeRules,
  type ScopeWorld,
} from "./scopes"
import type { JudgeAuditDetail, JudgeAuditEvent } from "./judge"
import { handbackOutput } from "./handback"
import { findSecret, redactSecrets } from "./scrub"
import { one, type Sql, type SqlValue } from "./sql"
import { utf8Bytes } from "./utf8"

const GENERIC_SQL = `harness IN (${[...GENERIC_HARNESSES].map((h) => `'${h}'`).join(", ")})`

export const HUMAN_HANDLE = "_human"
/** an agent title's length cap */
export const TITLE_CHARS = 64
export const SYSTEM_HANDLE = "_relay"
export const GONE_PREFIX = "_gone_"

const MIGRATION = [
  `CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    harness TEXT,
    model TEXT,
    cwd TEXT,
    parent TEXT,
    labels TEXT NOT NULL DEFAULT '{}',
    status_state TEXT,
    status_note TEXT,
    token_hash TEXT,
    connections INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER,
    last_received_at INTEGER,
    last_received_hop INTEGER,
    created_at INTEGER NOT NULL,
    session TEXT,
    hook_seen INTEGER,
    hook_ended INTEGER,
    process TEXT,
    stop_blocks INTEGER
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS endpoints_token ON endpoints (token_hash)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread TEXT NOT NULL,
    reply_to TEXT,
    kind TEXT NOT NULL,
    from_ep TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    body TEXT NOT NULL,
    mime TEXT NOT NULL,
    data_class TEXT NOT NULL,
    attachments TEXT NOT NULL,
    hop INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    sender_tty INTEGER,
    require_reply INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread)`,
  `CREATE INDEX IF NOT EXISTS messages_reply_to ON messages (reply_to)`,
  `CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at)`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    acked_at INTEGER,
    expires_at INTEGER NOT NULL,
    offered_until INTEGER,
    offered_hold TEXT,
    injected_at INTEGER,
    nudged_at INTEGER,
    deferred_at INTEGER,
    deferred_ack INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS deliveries_inbox ON deliveries (endpoint, acked_at, seq)`,
  `CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries (message_id)`,
  `CREATE INDEX IF NOT EXISTS deliveries_expires ON deliveries (expires_at)`,
  `CREATE TABLE IF NOT EXISTS idempotency (
    from_ep TEXT NOT NULL,
    client_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_ep, client_id)
  )`,
  `CREATE TABLE IF NOT EXISTS pair_events (from_ep TEXT NOT NULL, to_ep TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS pair_events_pair ON pair_events (from_ep, to_ep, at)`,
  `CREATE TABLE IF NOT EXISTS blocks (pair TEXT PRIMARY KEY, until INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    event TEXT NOT NULL,
    endpoint TEXT,
    ref TEXT,
    detail TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS audit_at ON audit (at)`,
  `CREATE TABLE IF NOT EXISTS grants (
    token_hash TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    under TEXT NOT NULL,
    name TEXT,
    labels TEXT,
    caps TEXT,
    groups TEXT,
    used_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    spent_cwd TEXT,
    title TEXT,
    bound_process TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS groups (name TEXT PRIMARY KEY, owner TEXT NOT NULL, tree TEXT, rules TEXT, pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, id TEXT)`,
  `CREATE TABLE IF NOT EXISTS group_members (name TEXT NOT NULL, endpoint TEXT NOT NULL, added_by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (name, endpoint))`,
  `CREATE TABLE IF NOT EXISTS policy_binds (policy TEXT NOT NULL, name TEXT NOT NULL, grp TEXT NOT NULL, PRIMARY KEY (policy, name))`,
  `CREATE TABLE IF NOT EXISTS policy_loads (policy TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS group_members_endpoint ON group_members (endpoint)`,
  `CREATE TABLE IF NOT EXISTS admins (subject TEXT NOT NULL, scope_kind TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT, granted_at INTEGER NOT NULL, revoked_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS tree_events (tree TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tree_events_tree ON tree_events (tree, at)`,
  `CREATE TABLE IF NOT EXISTS relay_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    kind TEXT NOT NULL,
    tool TEXT,
    summary TEXT,
    agent TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS peek_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS peek_turns_endpoint ON peek_turns (endpoint, id)`,
  `CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
    WHEN OLD.at > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - ${LIMITS.auditKeepS * 1000}
    BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END`,
]

export interface EndpointRow {
  id: string
  handle: string
  kind: EndpointKind
  harness: string | null
  model: string | null
  cwd: string | null
  parent: string | null
  labels: string
  status_state: StatusState | null
  status_note: string | null
  token_hash: string | null
  connections: number
  last_seen: number | null
  last_received_at: number | null
  last_received_hop: number | null
  created_at: number
  session: string | null
  hook_seen: number | null
  hook_ended: number | null
  process: string | null
  stop_blocks: number | null
  /** the pushes that continued a stop since the last prompt or session start */
  pushes: number | null
  /** how many prompts the session's hooks reported: a stop that waits ends once it moves */
  prompts: number | null
  /** a hook showed the session the full preamble */
  briefed: number | null
  /** a hook showed the session who spawned it */
  introduced: number | null
  /** the stops late parent directives held since the session started */
  directive_holds: number | null
  /** the harness's own session id, from the hook of the process that holds the endpoint: what `codex exec resume` takes */
  harness_session: string | null
  /** the transcript file the hook named with that session, `<session>.jsonl`: what spawn reads a Claude Code worker's result from */
  harness_transcript: string | null
  /** the root endpoint's id; null for a root */
  tree: string | null
  parent_ep: string | null
  /** a parent on another machine of the account, `<machine>/<handle>`: the row stays a root of its own tree */
  parent_addr: string | null
  depth: number | null
  /** JSON {@link ScopeRules} */
  rules: string | null
  /** JSON {@link ScopeCaps} */
  caps: string | null
  title: string | null
  /** the title a hook last inferred: the title is inferred while it equals this */
  title_auto: string | null
  /** the prompt count when a summary last set the inferred title; null when the first prompt set it */
  title_turn: number | null
  /** the prompt count when the status note last changed or a hook last reminded the agent to refresh it */
  tldr_turn: number | null
  /** when a new spawn last took the endpoint over: mail and messages from before it were the earlier holder's */
  reset_at: number | null
  /** when a new spawn last took the endpoint over: with its id, names the holder another machine sees */
  spawned_at: number | null
  /** who may peek: null is off */
  peek: PeekLevel | null
  /** when the session last set its handle itself (join or rename): a later claim with another handle does not rename it back */
  named: number | null
  /** when the session itself or the human linked it under a parent by hand: a later root claim of it takes it back where it sits */
  linked: number | null
  /** how the session that holds the endpoint wakes it: a {@link Wake} other than none, or null */
  wake: string | null
  /** the live connections that set the wake */
  wakers: number
  /** when the last hook connection that set the wake closed */
  waker_left: number | null
  /** the provider whose wake hook resumes the hibernated session; null when it is not hibernated */
  hibernate: string | null
  /** the provider's opaque reference to the suspended session, handed to its wake hook */
  wake_ref: string | null
  hibernated_at: number | null
  /** when a wake hook last ran for it */
  wake_tried: number | null
  /** the wake hook runs that failed in a row */
  wake_fails: number
  /** `wake_failed: <reason>` after a failed run */
  wake_note: string | null
  /** the seconds the provider said a wake takes */
  wake_eta: number | null
  /** the reason the provider declined a wake, a short token such as `policy` or `budget` */
  wake_declined: string | null
  /** the message, and its sender, the decline was for */
  declined_message: string | null
  declined_from: string | null
  /** a held spawn's durable ref: when its holding connection goes without a hibernate or spawn_end, the broker hibernates it by `spawn` with this ref */
  hold_ref: string | null
  /** the hash of the wake ticket the last `spawn` waker run got: a claim with it takes the hibernated row back as its resumed session */
  wake_ticket: string | null
}

/** a wake hook run that is due: the hibernated endpoint, its provider and ref, and the newest unread message's metadata (never a body) */
export interface WakeJob {
  endpoint: string
  address: string
  handle: string
  provider: string
  ref: string | null
  message: { id: string; from: string | null; kind: MessageKind; thread: string; created_at: string }
  unread: number
  /** for provider {@link SPAWN_PROVIDER}: a one-time ticket with which the run's claim takes the endpoint back as its resumed session */
  ticket?: string
}

export interface MessageRow {
  id: string
  thread: string
  reply_to: string | null
  kind: MessageKind
  from_ep: string
  to_addr: string
  body: string
  mime: string
  data_class: DataClass
  attachments: string
  hop: number
  created_at: number
  expires_at: number
  sender_tty: number | null
  require_reply: number | null
  link_parent: string | null
}

type AdoptSend = (from: string, params: SendParams, origin: { link: "session" | "self" }) => Promise<SendResult>

export interface CoreOptions {
  /** the local user's address part; `me` until a login names one */
  user?: string
  now?: () => number
  /** a synchronous hash for resume tokens (sha256 hex) */
  hash: (value: string) => string
  /** runs `fn` atomically: a local SQLite transaction, a Durable Object's transactionSync */
  transaction?: <T>(fn: () => T) => T
  /** count every sender but the relay itself, humans included, against LIMITS.userPerDay, and trust no client's terminal claim for a hop reset (default: agents and non-terminal humans count) */
  capEverySender?: boolean
  /** whether a process is running; without it every process holding an endpoint counts as running */
  alive?: (pid: number) => boolean
  /** when a process started, as a full harness-instance key spells it (Appendix E.3); undefined when it cannot be read */
  startOf?: (pid: number) => string | undefined
  /** this host's machine name: what `machine:` selectors match for its endpoints */
  machine?: string
  /** the short hostname, matched by `machine:` selectors when `machine` is not set */
  hostname?: string
}

interface GrantRow {
  token_hash: string
  issuer: string
  under: string
  name: string | null
  labels: string | null
  title: string | null
  caps: string | null
  groups: string | null
  used_by: string | null
  /** the cwd the spender's claims connect from: set by the spending claim, moved only by a connecting claim that names one */
  spent_cwd: string | null
  /** the spawner's process key: a claim from its tree that carries no grant of its own takes this one */
  bound_process: string | null
  /** the peek level the spawn starts with when it has none */
  peek: string | null
  /** the spawn's prompt, scrubbed as a digest turn: its first peek turn once it joins; kept only with `peek` */
  prompt: string | null
  /** minted by `swarm spawn`, which waits on the harness it runs: its spawner's stop may wait for it; a spawn-env grant never holds one */
  spawn: number | null
  /** a spawn whose spawner never waits on it (`swarm spawn --no-push`): its messages and handback stay ordinary unread ones */
  no_push: number | null
  /** a spawn grant's steer key: its issuer's messages to the endpoint that spent it carry it, and the spawn's prompt names it */
  steer: string | null
  /** the handback a spawn_exit sent for this grant: there is one at most */
  handback: string | null
  /** when a push last showed a message from the grant's spender */
  pushed_at: number | null
  /** the last spawn run a handback went out for: run 1 is the first; null before any */
  run: number | null
  /** when the worker's spawner or an ancestor ended it (spawn_end): its spawn no longer holds it */
  ended_at: number | null
  created_at: number
  expires_at: number
  revoked_at: number | null
}

interface GroupRow {
  name: string
  owner: string
  tree: string | null
  rules: string | null
  pinned: number
  created_at: number
  id: string
}

/** a group from the table or the policy file, with its rules as entries per direction */
interface Group {
  name: string
  owner: string
  tree: string | null
  rules: { in?: ScopeEntry[]; out?: ScopeEntry[] }
  pinned: boolean
  policy: boolean
  /** unique to the group's row, made at creation; `policy` for a policy group */
  id: string
}

/** a group as a grant names it: a dropped and recreated group of the same name is another group */
interface GrantGroup {
  name: string
  id: string
  /** the issuer could widen when it named the group: joining gives the membership allowance */
  allow?: true
}

interface Placement {
  parent: EndpointRow | null
  grant: GrantRow | null
  refused: string | null
  /** why a stale grant was ignored for the lineage placement */
  ignored?: string
}

interface ClaimScope {
  /** the handle the claim asked for */
  handle: string
  lineage: string[]
  /** the hash of the claim's grant, or of the grant bound to its lineage */
  grant: string | null
  rules: ScopeRules
  groups: string[]
  cwd: string | null
  exact?: boolean
  /** the hash of the claim's wake ticket */
  ticket?: string
  /** the claimant's nearest harness process, the end of its shell's walk (`self`), when that walk begins its lineage */
  nearest?: string
  /** a hook's claim for a subagent of the endpoint `root` */
  subagent?: { id: string; type?: string; stop?: true; root: string }
}

const GRANT_TOKEN = /^krt_[0-9a-f]{64}$/
const WAKE_TICKET = /^kwt_[0-9a-f]{64}$/
/** a harness's session id as its hooks name it: a UUID or a similar token */
const HARNESS_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** a wake provider's name, as hibernate takes it and a waker is configured under */
export const WAKE_PROVIDER = /^[a-z0-9][a-z0-9-]{0,31}$/
const TRANSCRIPT_CHARS = 4096

/** a hook's transcript path for harness session `session`: an absolute path without control characters whose file is `<session>.jsonl` */
function transcriptPath(path: unknown, session: string): string | null {
  if (typeof path !== "string" || path.length > TRANSCRIPT_CHARS || !path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) return null
  return path.endsWith(`/${session}.jsonl`) ? path : null
}

/** how much of a steer's text a handback quotes */
const STEER_CLIP = 120
const STDERR_LABEL = `stderr (last ${LIMITS.stderrBytes / 1024} KB):`
const MESSAGE_SUFFIX_MIN = 4
const MESSAGE_SUFFIX = new RegExp(`^[0-9a-z]{${MESSAGE_SUFFIX_MIN},}$`)
const json = <T>(text: string | null | undefined, fallback: T): T => (text ? (JSON.parse(text) as T) : fallback)

/** a spawn grant's steer key: six random lowercase base36 characters */
function steerKey(): string {
  const buffer = new Uint8Array(6)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, (b) => (b % 36).toString(36)).join("")
}

export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function newId(prefix: string, now = Date.now()): string {
  return `${prefix}_${now.toString(36).padStart(9, "0")}${randomHex(8)}`
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

export function cleanText(value: unknown, field: string, max: number = LIMITS.textField): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new RelayError("invalid_params", `${field} must be a string`)
  const text = stripControl(value).trim()
  if (text.length > max) throw new RelayError("too_large", `${field} is longer than ${max} characters`)
  return text
}

/** {@link cleanText} on one line: every whitespace run, newlines included, is one space */
export function oneLine(value: unknown, field: string, max: number): string | null {
  return cleanText(typeof value === "string" ? value.replace(/\s+/g, " ") : value, field, max)
}

export function cleanLabels(labels: unknown): Record<string, string> {
  if (labels === undefined || labels === null) return {}
  if (typeof labels !== "object" || Array.isArray(labels)) throw new RelayError("invalid_params", "labels must be an object of strings")
  const out: Record<string, string> = {}
  const entries = Object.entries(labels as Record<string, unknown>)
  if (entries.length > 16) throw new RelayError("too_large", "at most 16 labels")
  for (const [key, value] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(key)) throw new RelayError("invalid_params", `label ${JSON.stringify(key)} is not a valid name`)
    out[key] = cleanText(value, `label ${key}`, 128) ?? ""
  }
  return out
}

export class RelayCore {
  readonly user: string
  protected readonly now: () => number
  protected readonly hash: (value: string) => string
  protected readonly tx: <T>(fn: () => T) => T
  private readonly capEverySender: boolean
  private readonly alive: (pid: number) => boolean
  private readonly startOf: ((pid: number) => string | undefined) | undefined
  private readonly hostMachine: string | null
  private readonly namedMachine: string | null
  private readonly hostname: string | null
  private policy: Policy | null = null
  /** the identity each policy `group:<name>` naming no policy group bound to when the policy's text first loaded: that group's then, or `none` */
  private policyBinds = new Map<string, string>()
  private scopeDepth = 0
  /** while a scope world derives a node: what it already derived of ancestor lists and limits */
  private scopeMemo: { ancestors: Map<string, string[]>; limited: Map<string, boolean> } | null = null
  /** subagent titles from their parents' hooks, by `<parent id> <subagent id>`, until the subagent's first claim */
  private readonly subagentTitles = new Map<string, string>()
  private readonly deferred = new WeakMap<RelayError, { endpoint: string | null; detail: Record<string, unknown> }>()

  constructor(
    protected readonly sql: Sql,
    options: CoreOptions,
  ) {
    this.user = options.user ?? "me"
    this.now = options.now ?? Date.now
    this.hash = options.hash
    this.tx = options.transaction ?? ((fn) => fn())
    this.capEverySender = options.capEverySender === true
    this.alive = options.alive ?? (() => true)
    this.startOf = options.startOf
    this.hostMachine = options.machine ?? options.hostname ?? null
    this.namedMachine = options.machine ?? null
    this.hostname = options.hostname ?? null
  }

  /** a `machine` label naming this host by its hostname, as clients default it, names it by its machine name when one is set */
  private machineLabel(labels: Record<string, string>): Record<string, string> {
    if (this.namedMachine !== null && labels.machine !== undefined && labels.machine === this.hostname) labels.machine = this.namedMachine
    return labels
  }

  /** this host's own agent rows labelled with another machine (its name before a rename, or its hostname) take its machine name */
  relabelMachine(): number {
    const machine = this.namedMachine
    if (machine === null) return 0
    let changed = 0
    for (const row of this.sql.all<EndpointRow>(`SELECT * FROM endpoints WHERE kind = 'agent' AND labels LIKE '%"machine"%'`)) {
      const labels = json<Record<string, string>>(row.labels, {})
      if (labels.machine === undefined || labels.machine === machine || !this.localRow(row)) continue
      this.sql.all(`UPDATE endpoints SET labels = ? WHERE id = ?`, JSON.stringify({ ...labels, machine }), row.id)
      changed++
    }
    return changed
  }

  migrate(): void {
    for (const statement of MIGRATION) this.sql.all(statement)
    const columns = this.sql.all<{ name: string }>(`PRAGMA table_info(idempotency)`).map((c) => c.name)
    if (!columns.includes("payload_hash")) this.sql.all(`ALTER TABLE idempotency ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''`)
    const messageColumns = this.sql.all<{ name: string }>(`PRAGMA table_info(messages)`).map((c) => c.name)
    if (!messageColumns.includes("sender_tty")) this.sql.all(`ALTER TABLE messages ADD COLUMN sender_tty INTEGER`)
    if (!messageColumns.includes("require_reply")) this.sql.all(`ALTER TABLE messages ADD COLUMN require_reply INTEGER`)
    if (!messageColumns.includes("link_parent")) this.sql.all(`ALTER TABLE messages ADD COLUMN link_parent TEXT`)
    const endpointColumns = this.sql.all<{ name: string }>(`PRAGMA table_info(endpoints)`).map((c) => c.name)
    if (!endpointColumns.includes("session")) this.sql.all(`ALTER TABLE endpoints ADD COLUMN session TEXT`)
    if (!endpointColumns.includes("hook_seen")) this.sql.all(`ALTER TABLE endpoints ADD COLUMN hook_seen INTEGER`)
    if (!endpointColumns.includes("hook_ended")) this.sql.all(`ALTER TABLE endpoints ADD COLUMN hook_ended INTEGER`)
    if (!endpointColumns.includes("process")) {
      this.sql.all(`ALTER TABLE endpoints ADD COLUMN process TEXT`)
      this.sql.all(`UPDATE endpoints SET process = session WHERE session GLOB 'pid:[0-9]*'`)
    }
    if (!endpointColumns.includes("stop_blocks")) this.sql.all(`ALTER TABLE endpoints ADD COLUMN stop_blocks INTEGER`)
    for (const [column, type] of [
      ["tree", "TEXT"],
      ["parent_ep", "TEXT"],
      ["parent_addr", "TEXT"],
      ["depth", "INTEGER"],
      ["rules", "TEXT"],
      ["caps", "TEXT"],
      ["title", "TEXT"],
      ["reset_at", "INTEGER"],
      ["spawned_at", "INTEGER"],
      ["peek", "TEXT"],
      ["pushes", "INTEGER"],
      ["prompts", "INTEGER"],
      ["briefed", "INTEGER"],
      ["introduced", "INTEGER"],
      ["directive_holds", "INTEGER"],
      ["harness_session", "TEXT"],
      ["harness_transcript", "TEXT"],
      ["title_auto", "TEXT"],
      ["title_turn", "INTEGER"],
      ["tldr_turn", "INTEGER"],
      ["named", "INTEGER"],
      ["linked", "INTEGER"],
      ["wake", "TEXT"],
      ["wakers", "INTEGER NOT NULL DEFAULT 0"],
      ["waker_left", "INTEGER"],
      ["hibernate", "TEXT"],
      ["wake_ref", "TEXT"],
      ["hibernated_at", "INTEGER"],
      ["wake_tried", "INTEGER"],
      ["wake_fails", "INTEGER NOT NULL DEFAULT 0"],
      ["wake_note", "TEXT"],
      ["wake_eta", "INTEGER"],
      ["wake_declined", "TEXT"],
      ["declined_message", "TEXT"],
      ["declined_from", "TEXT"],
      ["hold_ref", "TEXT"],
      ["wake_ticket", "TEXT"],
    ] as const) {
      if (!endpointColumns.includes(column)) this.sql.all(`ALTER TABLE endpoints ADD COLUMN ${column} ${type}`)
    }
    const adminColumns = this.sql.all<{ name: string }>(`PRAGMA table_info(admins)`).map((c) => c.name)
    if (!adminColumns.includes("scope_id")) this.sql.all(`ALTER TABLE admins ADD COLUMN scope_id TEXT`)
    const grantColumns = this.sql.all<{ name: string }>(`PRAGMA table_info(grants)`).map((c) => c.name)
    for (const column of ["spent_cwd", "title", "bound_process", "peek", "prompt"])
      if (!grantColumns.includes(column)) this.sql.all(`ALTER TABLE grants ADD COLUMN ${column} TEXT`)
    if (!grantColumns.includes("spawn")) this.sql.all(`ALTER TABLE grants ADD COLUMN spawn INTEGER`)
    if (!grantColumns.includes("no_push")) this.sql.all(`ALTER TABLE grants ADD COLUMN no_push INTEGER`)
    if (!grantColumns.includes("handback")) this.sql.all(`ALTER TABLE grants ADD COLUMN handback TEXT`)
    if (!grantColumns.includes("pushed_at")) this.sql.all(`ALTER TABLE grants ADD COLUMN pushed_at INTEGER`)
    if (!grantColumns.includes("steer")) this.sql.all(`ALTER TABLE grants ADD COLUMN steer TEXT`)
    if (!grantColumns.includes("run")) this.sql.all(`ALTER TABLE grants ADD COLUMN run INTEGER`)
    if (!grantColumns.includes("ended_at")) this.sql.all(`ALTER TABLE grants ADD COLUMN ended_at INTEGER`)
    this.sql.all(`CREATE INDEX IF NOT EXISTS grants_bound ON grants (bound_process)`)
    this.sql.all(`CREATE INDEX IF NOT EXISTS grants_issuer ON grants (issuer)`)
    this.sql.all(`CREATE INDEX IF NOT EXISTS grants_used ON grants (used_by)`)
    const groupColumns = this.sql.all<{ name: string }>(`PRAGMA table_info(groups)`).map((c) => c.name)
    if (!groupColumns.includes("id")) this.sql.all(`ALTER TABLE groups ADD COLUMN id TEXT`)
    for (const row of this.sql.all<{ name: string }>(`SELECT name FROM groups WHERE id IS NULL`))
      this.sql.all(`UPDATE groups SET id = ? WHERE name = ?`, newId("grp", this.now()), row.name)
    this.sql.all(`CREATE INDEX IF NOT EXISTS endpoints_process ON endpoints (process)`)
    this.sql.all(`CREATE INDEX IF NOT EXISTS endpoints_parent ON endpoints (parent_ep)`)
    const deliveryColumns = this.sql.all<{ name: string }>(`PRAGMA table_info(deliveries)`).map((c) => c.name)
    if (!deliveryColumns.includes("offered_until")) this.sql.all(`ALTER TABLE deliveries ADD COLUMN offered_until INTEGER`)
    if (!deliveryColumns.includes("offered_hold")) this.sql.all(`ALTER TABLE deliveries ADD COLUMN offered_hold TEXT`)
    if (!deliveryColumns.includes("injected_at")) this.sql.all(`ALTER TABLE deliveries ADD COLUMN injected_at INTEGER`)
    if (!deliveryColumns.includes("nudged_at")) this.sql.all(`ALTER TABLE deliveries ADD COLUMN nudged_at INTEGER`)
    if (!deliveryColumns.includes("restated_at")) this.sql.all(`ALTER TABLE deliveries ADD COLUMN restated_at INTEGER`)
    if (!deliveryColumns.includes("deferred_at")) this.sql.all(`ALTER TABLE deliveries ADD COLUMN deferred_at INTEGER`)
    if (!deliveryColumns.includes("deferred_ack")) this.sql.all(`ALTER TABLE deliveries ADD COLUMN deferred_ack INTEGER`)
    const activityColumns = this.sql.all<{ name: string }>(`PRAGMA table_info(activity)`).map((c) => c.name)
    if (!activityColumns.includes("agent")) this.sql.all(`ALTER TABLE activity ADD COLUMN agent TEXT`)
    if (!this.byHandle(SYSTEM_HANDLE)) {
      this.sql.all(
        `INSERT INTO endpoints (id, handle, kind, harness, labels, created_at) VALUES (?, ?, 'system', 'relay', '{}', ?)`,
        newId("ep", this.now()),
        SYSTEM_HANDLE,
        this.now(),
      )
    }
    if (!this.byHandle(HUMAN_HANDLE)) {
      this.sql.all(
        `INSERT INTO endpoints (id, handle, kind, harness, labels, created_at) VALUES (?, ?, 'human', 'human', '{}', ?)`,
        newId("ep", this.now()),
        HUMAN_HANDLE,
        this.now(),
      )
    }
    this.migrateTreePreset()
  }

  /** every stored list that is exactly `tree:self`, the tree preset's old list, narrows once to the preset's list */
  private migrateTreePreset(): void {
    const name = "tree_preset_narrowed"
    if (one(this.sql, `SELECT name FROM relay_migrations WHERE name = ?`, name)) return
    const tree = PRESET_LISTS.tree
    const old = (sels: string[] | undefined) => sels?.length === 1 && sels[0] === "tree:self"
    const oldEntries = (sels: ScopeEntry[]) => sels.length === 1 && JSON.stringify(sels[0]) === `{"sel":"tree:self"}`
    const change = (list: string, dir: ScopeDirection) => ({ list, dir, before: ["tree:self"], after: tree })
    this.tx(() => {
      for (const row of this.sql.all<EndpointRow>(`SELECT * FROM endpoints WHERE rules IS NOT NULL OR caps IS NOT NULL ORDER BY rowid`)) {
        const lists: ReturnType<typeof change>[] = []
        const rules = json<ScopeRules>(row.rules, {})
        for (const dir of ["in", "out"] as const) {
          if (!old(rules[dir])) continue
          rules[dir] = [...tree]
          lists.push(change("own rules", dir))
        }
        const caps = this.capsOf(row)
        for (const cap of caps.caps) {
          if (!oldEntries(cap.sels)) continue
          cap.sels = tree.map((sel) => ({ sel }))
          lists.push(change(`cap ${cap.id}`, cap.dir))
        }
        if (!lists.length) continue
        this.sql.all(`UPDATE endpoints SET rules = ? WHERE id = ?`, Object.keys(rules).length ? JSON.stringify(rules) : null, row.id)
        this.saveCaps(row.id, caps)
        this.audit("scope_migrate", row.id, null, { target: this.address(row), lists })
      }
      for (const grant of this.sql.all<GrantRow>(`SELECT * FROM grants WHERE used_by IS NULL AND revoked_at IS NULL AND caps IS NOT NULL ORDER BY rowid`)) {
        const caps = json<{ dir: ScopeDirection; sels: ScopeEntry[] }[]>(grant.caps, [])
        const changed = caps.filter((cap) => oldEntries(cap.sels))
        if (!changed.length) continue
        for (const cap of changed) cap.sels = tree.map((sel) => ({ sel }))
        this.sql.all(`UPDATE grants SET caps = ? WHERE token_hash = ?`, JSON.stringify(caps), grant.token_hash)
        const under = this.byId(grant.under)
        this.audit("scope_migrate", grant.under, null, {
          target: under ? this.address(under) : grant.under,
          grant: true,
          lists: changed.map((cap) => change("grant", cap.dir)),
        })
      }
      this.sql.all(`INSERT INTO relay_migrations (name, at) VALUES (?, ?)`, name, this.now())
    })
  }

  /**
   * null opens everything; a policy restricts who may message whom. Its `group:` bindings are stored per policy, selector order aside, so the
   * same policy loaded again keeps them while it is among the last ${LIMITS.policyLoadsKept} loaded
   */
  setPolicy(policy: Policy | null): void {
    this.policy = policy
    this.policyBinds = new Map()
    if (!policy) return
    const key = this.hash(canonicalPolicy(policy))
    const fixed = new Set((policy.groups ?? []).map((group) => group.name))
    const sels = [
      ...policy.rules.flatMap((rule) => [rule.match, ...(rule.scope ?? []), ...(rule.send_to ?? []), ...(rule.accept_from ?? [])]),
      ...(policy.groups ?? []).flatMap((group) => [...group.members, ...(group.rules ?? []), ...(group.in ?? []), ...(group.out ?? [])]),
    ]
    this.tx(() => {
      this.sql.all(`DELETE FROM policy_loads WHERE policy = ?`, key)
      this.sql.all(`INSERT INTO policy_loads (policy, at) VALUES (?, ?)`, key, this.now())
      this.sql.all(
        `DELETE FROM policy_loads WHERE policy NOT IN (SELECT policy FROM policy_loads ORDER BY at DESC, rowid DESC LIMIT ${LIMITS.policyLoadsKept})`,
      )
      this.sql.all(`DELETE FROM policy_binds WHERE policy NOT IN (SELECT policy FROM policy_loads)`)
      for (const row of this.sql.all<{ name: string; grp: string }>(`SELECT name, grp FROM policy_binds WHERE policy = ?`, key))
        this.policyBinds.set(row.name, row.grp)
      for (const sel of sels) {
        const name = sel.startsWith("group:") ? sel.slice("group:".length) : undefined
        if (name === undefined || name === "self" || fixed.has(name) || this.policyBinds.has(name)) continue
        const group = GROUP_NAME.test(name) ? this.groupByName(name) : undefined
        this.policyBinds.set(name, group ? this.groupId(group) : "none")
        this.sql.all(`INSERT INTO policy_binds (policy, name, grp) VALUES (?, ?, ?)`, key, name, this.policyBinds.get(name)!)
      }
    })
  }

  /** why the policy refuses a message between two addresses, or null */
  checkPolicy(from: string, to: string): string | null {
    return policyRefusal(this.policy, this.policySubject(from), this.policySubject(to), this.policyBound)
  }

  /** the subject the policy checks for an address */
  protected policySubject(address: string): PolicySubject {
    return this.subject(this.resolve(address))
  }

  // endpoints

  /**
   * The connection's claim of an agent endpoint; an offline endpoint of the same harness and handle is taken back with its inbox,
   * and a claim with a session joins that session's endpoint while it is not offline. A connecting claim joins it only when no
   * connection holds it and the claim comes from the harness process that last claimed it (its process key), and with a full key
   * when an earlier connection held it; otherwise it gets the next free handle. The connecting claim's handle wins over another name the
   * session's hooks claimed first, so the order of the two does not matter: the handles are walked as a claim with no hooks walks them, and the
   * hooks' endpoint, with its mail and status, is renamed to the first free one (`<handle>-<n>` past one another agent holds), or left for an
   * offline endpoint of that handle the claim may take over, which it takes back with the hooks' unread mail. A transient claim (a hook) marks the endpoint
   * seen without connecting. It takes an offline endpoint by its handle from another harness process only once that session ended or
   * went quiet for ${LIMITS.restartGraceS} s, and then drops the old token, so the session's shim can join it.
   */
  claim(claim: Claim, options: { transient?: boolean; self?: unknown } = {}): { endpoint: EndpointView; token?: string; created?: true; subagent?: true } {
    const subagent = subagentOf(claim.subagent)
    const harness = cleanText(claim.harness, "harness", 32) ?? "cli"
    if (!validHarness(harness)) throw new RelayError("invalid_params", `harness ${JSON.stringify(harness)} is not a valid name`)
    const wanted = cleanText(claim.handle, "handle", 63) ?? harness
    if (!validHandle(wanted)) throw new RelayError("invalid_params", `handle ${JSON.stringify(wanted)} is not valid: lowercase letters, digits, . _ -`)
    const fields = {
      model: cleanText(claim.model, "model", 128),
      cwd: cleanText(claim.cwd, "cwd", 1024),
      parent: cleanText(claim.parent, "parent", 128),
      labels: JSON.stringify(this.machineLabel(cleanLabels(claim.labels))),
      session: cleanText(claim.session, "session", 128),
      process: cleanText(claim.process, "process", 128),
      harness_session: cleanText(claim.harness_session, "harness_session", 128),
    }
    if (fields.process !== null && !ANY_PROCESS_KEY.test(fields.process)) throw new RelayError("invalid_params", "process is a key pid:<pid>[:<start time>]")
    if (fields.harness_session !== null && !HARNESS_SESSION.test(fields.harness_session))
      throw new RelayError("invalid_params", "harness_session is a harness's session id: letters, digits, . _ : -")
    const under = cleanText(claim.under, "under", 128) || null
    const leaked = [wanted, fields.model, fields.cwd, fields.parent, fields.labels, fields.session, fields.harness_session, under]
      .map((v) => (v ? findSecret(v) : null))
      .find(Boolean)
    if (leaked) throw new RelayError("secret_refused", `the claim looks like it carries a credential (${leaked})`)
    if (claim.grant !== undefined && (typeof claim.grant !== "string" || !GRANT_TOKEN.test(claim.grant)))
      throw new RelayError("invalid_params", "grant is a krt_ token")
    if (claim.ticket !== undefined && (typeof claim.ticket !== "string" || !WAKE_TICKET.test(claim.ticket)))
      throw new RelayError("invalid_params", "ticket is a kwt_ wake ticket")
    const scope: ClaimScope = {
      handle: wanted,
      lineage: lineageKeys(claim.lineage),
      grant: claim.grant === undefined ? null : this.hash(claim.grant),
      rules: this.claimRules(claim),
      groups: groupNames(claim.groups, "groups"),
      cwd: fields.cwd,
      exact: claim.exact === true && !subagent,
      ...(claim.ticket !== undefined && !subagent ? { ticket: this.hash(claim.ticket) } : {}),
    }
    const self = lineageKeys(options.self)
    const nearest = self.at(-1)
    if (nearest !== undefined && PROCESS_KEY.test(nearest) && self.every((key, i) => scope.lineage[i] === key)) scope.nearest = nearest
    return this.scopeTx(() => {
      if (subagent) {
        const root = this.subagentRoot(scope, harness, fields.session, fields.process, options.transient === true)
        Object.assign(scope, { handle: subagentHandle(root.handle, subagent), grant: null, subagent: { ...subagent, root: root.id } })
        fields.session = `sub:${subagent.id}:${fields.session ?? root.id}`.slice(0, 128)
        const had = one<{ id: string }>(
          this.sql,
          `SELECT id FROM endpoints WHERE kind = 'agent' AND harness = ? AND (session = ? OR (handle = ? AND parent_ep = ?)) LIMIT 1`,
          harness,
          fields.session,
          scope.handle,
          root.id,
        )
        if (subagent.stop && !had) throw new RelayError("not_found", "that subagent has no endpoint: it never ran a tool")
        const claimed = this.claimRow(scope.handle, harness, fields, true, scope)
        const titled = this.takeSubagentTitle(root.id, subagent.id, claimed.endpoint.id)
        const resumed =
          !subagent.stop &&
          one(this.sql, `UPDATE endpoints SET status_state = 'working' WHERE id = ? AND status_state = 'done' RETURNING id`, claimed.endpoint.id)
        if (!titled && !resumed) return { ...claimed, subagent: true as const }
        return { ...claimed, endpoint: this.view(this.byId(claimed.endpoint.id)!), subagent: true as const }
      }
      const bound = scope.grant === null && !scope.exact ? this.boundGrant(scope, fields.process) : undefined
      if (bound) Object.assign(scope, { grant: bound.token_hash, handle: bound.name ?? wanted })
      const claimed = this.claimRow(scope.handle, harness, fields, options.transient === true, scope)
      return under === null ? claimed : this.claimUnder(claimed, under)
    })
  }

  /** links a claimed root under `under` as a join under does; a refusal keeps the claim and is audited `claim_under_refused` */
  private claimUnder<T extends { endpoint: EndpointView }>(claimed: T, under: string): T {
    const me = this.mustEndpoint(claimed.endpoint.id)
    if (me.kind !== "agent" || !this.localRow(me) || me.parent_ep !== null || me.parent_addr !== null) return claimed
    try {
      const parent = this.resolve(under)
      if (parent.kind === "agent" && !this.mayMessage(me, parent)) throw unreachable(under)
      this.link(me, parent, { by: this.address(me), auth: "session" })
    } catch (error) {
      if (!(error instanceof RelayError)) throw error
      this.audit("claim_under_refused", me.id, null, { target: this.address(me), under, code: error.code })
      return claimed
    }
    return { ...claimed, endpoint: this.view(this.byId(me.id)!) }
  }

  /** a claim's own rules per direction, as its `scope`, `allow`, `in` and `out` expand */
  protected claimRules(claim: Claim): ScopeRules {
    const rules: ScopeRules = {}
    for (const [dir, list] of Object.entries(expandRules(this.ruleParams(claim), this.defaults().symmetric)) as [ScopeDirection, string[] | null][])
      if (list) rules[dir] = list
    return rules
  }

  /**
   * the endpoint a subagent claim goes under: the claim's session's, else its lineage endpoint, when the claim is a hook of the harness process
   * holding it; any other is refused, audited
   */
  private subagentRoot(scope: ClaimScope, harness: string, session: string | null, process: string | null, transient: boolean): EndpointRow {
    const held =
      session === null
        ? undefined
        : one<EndpointRow>(
            this.sql,
            `SELECT * FROM endpoints WHERE kind = 'agent' AND harness = ? AND session = ? AND substr(handle, 1, ${GONE_PREFIX.length}) != '${GONE_PREFIX}'`,
            harness,
            session,
          )
    const root = held ?? this.lineageParent(scope.lineage)
    if (transient && process !== null && root && root.process !== null && root.harness === harness && sameHarness(root.process, process)) return root
    const error = new RelayError("unauthorized", "a subagent claim comes only from a hook of the harness process that holds its lineage endpoint")
    this.deferred.set(error, { endpoint: root?.id ?? null, detail: { target: scope.handle, reason: "subagent claim from another process" } })
    throw error
  }

  /**
   * the grant a spawner bound to its own process for the nearest lineage key that has one: unspent, issued by the claim's lineage parent
   * (the human when it has none) and placing the claim, or spent by the endpoint of the claim's own harness process, which re-claims it.
   * A claim whose lineage lacks the key never takes it, so a grant bound to a key outside the issuer's own tree places nothing
   */
  private boundGrant(scope: ClaimScope, process: string | null): GrantRow | undefined {
    if (this.defaults().verifyLineage === true) return undefined
    const now = this.now()
    const parent = this.lineageParent(scope.lineage)
    const issuedHere = (grant: GrantRow): boolean => (parent ? grant.issuer === parent.id : this.byId(grant.issuer)?.kind === "human")
    for (const key of scope.lineage) {
      if (!PROCESS_KEY.test(key)) continue
      const rows = this.sql.all<GrantRow>(
        `SELECT * FROM grants WHERE bound_process = ? AND revoked_at IS NULL AND (used_by IS NOT NULL OR expires_at > ?) ORDER BY created_at DESC, rowid DESC`,
        key,
        now,
      )
      if (!rows.length) continue
      return rows.find((grant) => {
        if (grant.used_by === null)
          return issuedHere(grant) && !this.placement({ ...scope, grant: grant.token_hash, handle: grant.name ?? scope.handle }, now).refused
        const spender = this.byId(grant.used_by)
        return process !== null && spender?.process != null && sameHarness(spender.process, process)
      })
    }
    return undefined
  }

  private claimRow(
    wanted: string,
    harness: string,
    fields: {
      model: string | null
      cwd: string | null
      parent: string | null
      labels: string
      session: string | null
      process: string | null
      harness_session?: string | null
    },
    transient: boolean,
    scope: ClaimScope = { handle: wanted, lineage: [], grant: null, rules: {}, groups: [], cwd: fields.cwd },
  ): { endpoint: EndpointView; token?: string; created?: true } {
    const now = this.now()
    this.endExited(now)
    const ticketed = !transient && scope.ticket !== undefined ? this.ticketed(scope.ticket, harness) : undefined
    const bare = transient && fields.session !== null && BARE_PID_KEY.test(fields.session)
    let row =
      fields.session && !ticketed
        ? one<EndpointRow>(
            this.sql,
            `SELECT * FROM endpoints WHERE kind = 'agent' AND (harness = ? OR ${GENERIC_SQL})
           AND (session = ? OR (? = 1 AND substr(session, 1, ?) = ? AND (connections = 0 OR hook_seen >= ?)))
           AND substr(handle, 1, ${GONE_PREFIX.length}) != '${GONE_PREFIX}' ORDER BY COALESCE(last_seen, created_at) DESC LIMIT 1`,
            harness,
            fields.session,
            bare ? 1 : 0,
            fields.session.length + 1,
            `${fields.session}:`,
            now - LIMITS.hookOnlineS * 1000,
          )
        : undefined
    let session = fields.session
    let stopBlocks: number | null = null
    let moved: number[] = []
    let exactFrom: EndpointRow | undefined
    const open = !row || presenceOf(row, now) === "offline"
    if (row && presenceOf(row, now) === "offline") {
      this.sql.all(`UPDATE endpoints SET session = NULL WHERE id = ?`, row.id)
      row = undefined
    } else if (row && !transient && !sameProcess(row, fields.process) && !(row.handle === wanted && reclaims(row, fields.process))) {
      row = undefined
      session = null
    } else if (
      row &&
      !transient &&
      row.token_hash === null &&
      row.named === null &&
      row.handle !== wanted &&
      !row.handle.startsWith(`${wanted.slice(0, 58)}-`)
    ) {
      const hooks = row
      let settled = false
      for (let n = 1; n < (scope.exact ? 2 : 1000) && !settled; n++) {
        const handle = n === 1 ? wanted : `${wanted.slice(0, 58)}-${n}`
        const held = this.byHandle(handle)
        if (!held) {
          this.sql.all(`UPDATE endpoints SET handle = ? WHERE id = ?`, handle, hooks.id)
          settled = true
        } else if (held.kind === "agent" && held.connections === 0 && presenceOf(held, now) === "offline" && harnessFits(held.harness, harness)) {
          if (this.restarts(held, this.placement(scope, now).parent, fields.process) || this.redeems(held, scope, { harness, ...fields })) {
            ;({ moved, stopBlocks } = this.leaveHooks(hooks, held.id))
            row = undefined
            settled = true
          }
        } else if (held.kind === "agent" && held.connections === 0 && (held.last_seen ?? held.created_at) < now - LIMITS.handleBoundS * 1000) {
          this.sql.all(`UPDATE endpoints SET handle = ? WHERE id = ?`, `${GONE_PREFIX}${held.id}`, held.id)
          this.dropPeek(held.id)
          n--
        }
      }
      if (!settled && scope.exact) {
        row = undefined
        exactFrom = hooks
      }
    } else if (row && transient) session = row.session
    const resumed =
      ticketed ??
      (!row && open && !scope.exact && !scope.subagent && fields.harness_session
        ? this.resumable(harness, fields.harness_session, scope, fields, now)
        : undefined)
    if (resumed) row = resumed
    let joined = row !== undefined && !resumed
    const bySession =
      joined && row!.token_hash === null && (!transient || row!.process === null || (fields.process !== null && sameHarness(row!.process, fields.process)))
    let own = false
    let live = false
    let created = false
    for (let n = 1; n < (scope.exact ? 2 : 1000) && !row; n++) {
      const handle = n === 1 ? wanted : `${wanted.slice(0, 58)}-${n}`
      const held = this.byHandle(handle)
      if (!held) {
        const id = newId("ep", now)
        this.sql.all(`INSERT INTO endpoints (id, handle, kind, harness, labels, created_at) VALUES (?, ?, 'agent', ?, '{}', ?)`, id, handle, harness, now)
        row = this.byId(id)
        created = true
      } else if (
        held.kind === "agent" &&
        ((held.connections === 0 && presenceOf(held, now) === "offline") || (!transient && this.outlived(held))) &&
        harnessFits(held.harness, harness) &&
        held.id !== scope.subagent?.root &&
        !(scope.subagent && held.session?.startsWith("sub:") && held.session !== fields.session)
      ) {
        own = transient && held.process !== null && fields.process !== null && sameHarness(held.process, fields.process)
        const ended = held.hook_ended !== null || (held.last_seen ?? held.created_at) < now - LIMITS.restartGraceS * 1000
        if (
          (!transient || own || ended) &&
          (this.restarts(held, this.placement(scope, now).parent, fields.process) || this.redeems(held, scope, { harness, ...fields }))
        )
          row = held
      } else if (
        scope.exact &&
        held.kind === "agent" &&
        held.process === null &&
        held.session === null &&
        harnessFits(held.harness, harness) &&
        this.restarts(held, this.placement(scope, now).parent, null)
      ) {
        row = held
        joined = true
        live = presenceOf(held, now) !== "offline"
      } else if (held.kind === "agent" && held.connections === 0 && (held.last_seen ?? held.created_at) < now - LIMITS.handleBoundS * 1000) {
        this.sql.all(`UPDATE endpoints SET handle = ? WHERE id = ?`, `${GONE_PREFIX}${held.id}`, held.id)
        this.dropPeek(held.id)
        n--
      }
    }
    if (!row)
      throw scope.exact ? this.exactRefusal(this.byHandle(wanted)!, wanted, harness, now) : new RelayError("invalid_params", `no free handle for ${wanted}`)
    if (exactFrom && exactFrom.id !== row.id) ({ moved, stopBlocks } = this.leaveHooks(exactFrom, row.id))
    const fresh = created || joined || resumed ? null : this.incarnates(row, scope, fields.process, now)
    const token = transient || live ? undefined : `kre_${randomHex(32)}`
    const field = (column: string) => (transient || ticketed ? `COALESCE(?, ${column})` : "?")
    if (session) this.sql.all(`UPDATE endpoints SET session = NULL WHERE session = ? AND harness = ? AND id != ?`, session, harness, row.id)
    const keep = (transient && (joined || own)) || live
    this.sql.all(
      `UPDATE endpoints SET harness = ?, model = ${field("model")}, cwd = ${field("cwd")}, parent = ${field("parent")}, labels = ${field("labels")}, session = ?,
       process = ${keep ? "COALESCE(process, ?)" : "?"}, token_hash = ${keep ? "token_hash" : "?"}, connections = connections + ?, last_seen = ?,
       hook_seen = CASE WHEN ? IS NOT NULL AND (hook_ended IS NULL OR hook_ended < ?) THEN ? ELSE hook_seen END,
       stop_blocks = CASE WHEN ? IS NOT NULL THEN ? WHEN ? IS NOT NULL AND session IS NOT ? THEN 0 ELSE stop_blocks END,
       briefed = CASE WHEN ? IS NOT NULL AND session IS NOT ? THEN NULL ELSE briefed END, introduced = CASE WHEN ? IS NOT NULL AND session IS NOT ? THEN NULL ELSE introduced END,
       directive_holds = CASE WHEN ? IS NOT NULL AND session IS NOT ? THEN NULL ELSE directive_holds END WHERE id = ?`,
      keptHarness(row.harness, harness),
      fields.model,
      fields.cwd,
      fields.parent,
      ticketed || (transient && fields.labels === "{}") ? null : fields.labels,
      session,
      fields.process,
      ...(keep ? [] : [token ? this.hash(token) : null]),
      transient ? 0 : 1,
      now,
      transient ? now : null,
      now - LIMITS.hookEndedGraceS * 1000,
      now,
      stopBlocks,
      stopBlocks,
      session,
      session,
      session,
      session,
      session,
      session,
      session,
      session,
      row.id,
    )
    if (!transient && fields.cwd !== null) this.sql.all(`UPDATE grants SET spent_cwd = ? WHERE used_by = ?`, fields.cwd, row.id)
    if (!(transient && joined)) {
      const sub = scope.subagent ? { subagent: scope.subagent.type ?? "agent", parent: this.addressOf(scope.subagent.root) } : {}
      this.audit("claim", row.id, null, {
        handle: row.handle,
        harness,
        ...(joined ? { joined: true } : {}),
        ...(resumed ? { resumed: true } : {}),
        ...(transient ? { transient: true } : {}),
        ...sub,
      })
    }
    if (fresh) this.reset(row, scope, fresh, moved, now)
    if (created || fresh === "grant") this.place(this.byId(row.id)!, scope, now)
    else if (scope.grant !== null) this.redeem(this.byId(row.id)!, scope, now, bySession)
    if (scope.grant !== null) this.takePending(row.id)
    if (!transient) this.wakeDone(row.id, "claim")
    return { endpoint: this.view(this.byId(row.id)!), ...(token ? { token } : {}), ...(created ? { created: true as const } : {}) }
  }

  /**
   * the offline local row a claim of harness session `harnessSession` from a new harness process takes back, as a restart of that session:
   * of a fitting harness, no subagent's, and restarted where it sits or redeemed with its grant. A claim with a grant that row did not spend
   * is a new spawn and takes none. A named row first, then the latest seen
   */
  private resumable(
    harness: string,
    harnessSession: string,
    scope: ClaimScope,
    fields: { cwd: string | null; process: string | null },
    now: number,
  ): EndpointRow | undefined {
    const rows = this.sql.all<EndpointRow>(
      `SELECT * FROM endpoints WHERE kind = 'agent' AND harness_session = ? AND connections = 0 AND (session IS NULL OR substr(session, 1, 4) != 'sub:')
       AND substr(handle, 1, ${GONE_PREFIX.length}) != '${GONE_PREFIX}' ORDER BY named IS NULL, COALESCE(last_seen, created_at) DESC`,
      harnessSession,
    )
    const parent = rows.length ? this.placement(scope, now).parent : null
    const spender = scope.grant === null ? null : (this.spentGrant(scope)?.used_by ?? "")
    return rows.find(
      (row) =>
        (spender === null || spender === row.id) &&
        this.localRow(row) &&
        harnessFits(row.harness, harness) &&
        presenceOf(row, now) === "offline" &&
        (this.restarts(row, parent, fields.process) || this.redeems(row, scope, { harness, ...fields })),
    )
  }

  /** a session's hook endpoint left for `to`: its unread mail moves there and it lets go of the session; the moved seqs and its stop budget */
  private leaveHooks(hooks: EndpointRow, to: string): { moved: number[]; stopBlocks: number } {
    const moved = this.sql
      .all<{ seq: number }>(`UPDATE deliveries SET endpoint = ? WHERE endpoint = ? AND acked_at IS NULL RETURNING seq`, to, hooks.id)
      .map((d) => d.seq)
    this.sql.all(`UPDATE endpoints SET session = NULL, hook_seen = NULL WHERE id = ?`, hooks.id)
    return { moved, stopBlocks: hooks.stop_blocks ?? 0 }
  }

  /**
   * whether a claim taking over `row` starts a new incarnation of it, and how: `grant` with an unspent grant that places it, `process` for any
   * other claim, a hook's too, both from a process other than `row`'s own harness process. That process re-claiming, a re-claim with the
   * grant the endpoint spent and one that {@link runsUnder} its process are restarts and keep its state
   */
  private incarnates(row: EndpointRow, scope: ClaimScope, process: string | null, now: number): "grant" | "process" | null {
    if (this.spentGrant(scope)?.used_by === row.id) return null
    if (process !== null && row.process !== null && sameHarness(row.process, process)) return null
    if (scope.grant !== null && this.placement(scope, now, row).grant !== null) return "grant"
    return this.runsUnder(row, scope.nearest) ? null : "process"
  }

  /**
   * whether the claimant's nearest harness process is `row`'s own, or, for a row no harness process holds (one only `--as` claimed), its
   * parent's: that agent's own shells (its in-process subagents' too) acting as it or its child again. A process further up, such as the
   * harness that spawned the claimant's, never counts
   */
  private runsUnder(row: EndpointRow, nearest: string | undefined): boolean {
    if (nearest === undefined) return false
    if (row.process !== null) return row.process === nearest
    const parent = row.parent_ep === null ? undefined : this.byId(row.parent_ep)
    return parent?.process === nearest
  }

  /**
   * a new incarnation drops what reaches past the endpoint's caps: groups and the allowances with them, every widened entry, lifted
   * inherited caps, admin rows and the grants the earlier holder spent; replies to messages from before it are checked like any send. A
   * `grant` incarnation is a new spawn: it also drops every cap but the human's, its own rules, status, title and mail but the unread messages
   * the grant's issuer sent it since minting the grant (steers for the new run), and is placed afresh.
   * A `process` one keeps its narrowing caps and own rules, a cap only narrows, and its mail. The groups the earlier holder created pass to
   * the grant's issuer when it already stewards them (the human or an ancestor), else to the human
   */
  private reset(row: EndpointRow, scope: ClaimScope, kind: "grant" | "process", moved: number[], now: number): void {
    const groups = this.sql.all<{ name: string }>(`SELECT name FROM group_members WHERE endpoint = ? ORDER BY name`, row.id).map((r) => r.name)
    for (const name of groups) this.leave(name, row.id)
    const admins = this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM admins WHERE subject = ? AND revoked_at IS NULL`, row.id)[0]?.n ?? 0
    this.sql.all(`UPDATE admins SET revoked_at = ? WHERE subject = ? AND revoked_at IS NULL`, now, row.id)
    const caps = this.capsOf(this.byId(row.id)!)
      .caps.filter((cap) => kind === "process" || cap.by === "human")
      .map((cap) => ({ ...cap, sels: cap.sels.filter((entry) => entry.via === undefined || entry.via === cap.by) }))
    const stored = caps.length ? JSON.stringify({ caps, allow: {} }) : null
    if (kind === "process")
      this.sql.all(`UPDATE endpoints SET caps = ?, reset_at = ?, peek = NULL, wake = NULL, hold_ref = NULL WHERE id = ?`, stored, now, row.id)
    else
      this.sql.all(
        `UPDATE endpoints SET rules = NULL, caps = ?, status_state = NULL, status_note = NULL, title = NULL, reset_at = ?, spawned_at = ?, peek = NULL, harness_session = NULL, wake = NULL, hold_ref = NULL WHERE id = ?`,
        stored,
        now,
        now,
        row.id,
      )
    this.sql.all(`DELETE FROM peek_turns WHERE endpoint = ?`, row.id)
    this.wakeDone(row.id, "reset")
    let dropped = 0
    if (kind === "grant") {
      const spawned = one<{ issuer: string; created_at: number }>(this.sql, `SELECT issuer, created_at FROM grants WHERE token_hash = ?`, scope.grant!)
      const deliveries = this.sql.all<{ seq: number; acked_at: number | null; from_ep: string; created_at: number }>(
        `SELECT d.seq, d.acked_at, m.from_ep, m.created_at FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ?`,
        row.id,
      )
      for (const delivery of deliveries) {
        if (moved.includes(delivery.seq)) continue
        if (delivery.acked_at === null && delivery.from_ep === spawned?.issuer && delivery.created_at >= spawned.created_at) continue
        this.sql.all(`DELETE FROM deliveries WHERE seq = ?`, delivery.seq)
        if (delivery.acked_at === null) dropped++
      }
    }
    this.sql.all(`UPDATE grants SET revoked_at = COALESCE(revoked_at, ?) WHERE used_by = ? AND token_hash IS NOT ?`, now, row.id, scope.grant)
    const grant = kind === "grant" ? one<GrantRow>(this.sql, `SELECT issuer FROM grants WHERE token_hash = ?`, scope.grant!) : undefined
    const owned = this.sql.all<{ name: string }>(`SELECT name FROM groups WHERE owner = ? ORDER BY name`, row.id).map((r) => r.name)
    const steward = grant && (this.byId(grant.issuer)?.kind === "human" || this.ancestorsOf(row).includes(grant.issuer)) ? grant.issuer : this.humanId()
    if (owned.length) this.sql.all(`UPDATE groups SET owner = ? WHERE owner = ?`, steward, row.id)
    this.audit("scope_reset", row.id, null, {
      by: grant ? this.addressOf(grant.issuer) : this.address(row),
      target: this.address(row),
      reason: kind === "grant" ? "a new spawn took over the endpoint" : "another process took over the endpoint",
      groups,
      ...(admins ? { admins } : {}),
      ...(dropped ? { dropped } : {}),
      ...(owned.length ? { owned, owner: this.addressOf(steward) } : {}),
      before: {
        caps: json<ScopeCaps>(row.caps, { caps: [], allow: {} }),
        rules: json<ScopeRules>(row.rules, {}),
        status: row.status_state,
        note: row.status_note,
      },
    })
  }

  /** why an exact claim of `handle`, which `held` holds, is refused */
  protected exactRefusal(held: EndpointRow, handle: string, harness: string, now: number): RelayError {
    if ((held.session !== null || held.process !== null) && presenceOf(held, now) !== "offline") {
      return new RelayError("unauthorized", `${handle} is held by a live ${held.harness} session: act as it from that session's own shell, no --as needed`)
    }
    if (!harnessFits(held.harness, harness)) return new RelayError("unauthorized", `${handle} is a ${held.harness} endpoint: pass --harness ${held.harness}`)
    return new RelayError("unauthorized", `${handle} is placed in another tree or under another parent than this shell`)
  }

  /**
   * the claim's place: under the nearest lineage endpoint, or under a valid grant's endpoint at or below it; a grant spent by the lineage
   * endpoint or one above it is one its process passed down, and places nothing. An expired, revoked or spent grant refuses only a claim with
   * no lineage; lineage places any other, and the grant is ignored
   */
  private placement(scope: ClaimScope, now: number, exclude?: EndpointRow): Placement {
    if (scope.subagent) return { parent: this.byId(scope.subagent.root) ?? null, grant: null, refused: null }
    const lineage = this.lineageParent(scope.lineage, exclude)
    if (scope.grant === null) return { parent: lineage, grant: null, refused: null }
    const grant = one<GrantRow>(this.sql, `SELECT * FROM grants WHERE token_hash = ?`, scope.grant)
    const spender = this.spentGrant(scope)?.used_by
    if (spender && lineage && (lineage.id === spender || this.ancestorsOf(lineage).includes(spender))) return { parent: lineage, grant: null, refused: null }
    const issuer = grant ? this.byId(grant.issuer) : undefined
    const under = grant ? this.byId(grant.under) : undefined
    const live = (row: EndpointRow | undefined) => row !== undefined && !row.handle.startsWith(GONE_PREFIX)
    const stale = (reason: string): Placement =>
      lineage ? { parent: lineage, grant: null, refused: null, ignored: reason } : { parent: null, grant: null, refused: reason }
    if (!grant || grant.expires_at <= now || grant.revoked_at !== null || !live(issuer) || !live(under) || under!.kind !== "agent")
      return stale("grant invalid")
    if (grant.used_by !== null) return stale("grant used")
    if (grant.name !== null && grant.name !== (exclude?.handle ?? scope.handle)) return { parent: lineage, grant: null, refused: "grant for another name" }
    if (exclude && (under!.id === exclude.id || this.ancestorsOf(under!).includes(exclude.id)))
      return { parent: lineage, grant: null, refused: "grant under the claimed endpoint" }
    if (lineage && under!.id !== lineage.id && !this.ancestorsOf(under!).includes(lineage.id))
      return { parent: lineage, grant: null, refused: "grant above lineage" }
    return { parent: under!, grant, refused: null }
  }

  /** the first lineage key some agent endpoint holds as its process, the shallowest (then oldest) of them; full keys only */
  private lineageParent(lineage: string[], exclude?: EndpointRow): EndpointRow | null {
    return this.lineageRows(lineage, exclude)[0] ?? null
  }

  /** the agent endpoints holding the first lineage key any of them holds, shallowest (then oldest) first */
  private lineageRows(lineage: string[], exclude?: EndpointRow): EndpointRow[] {
    if (this.defaults().verifyLineage === true) return []
    for (const key of lineage) {
      if (!PROCESS_KEY.test(key)) continue
      const rows = this.sql
        .all<EndpointRow>(
          `SELECT * FROM endpoints WHERE kind = 'agent' AND process = ? AND substr(handle, 1, ${GONE_PREFIX.length}) != '${GONE_PREFIX}' ORDER BY COALESCE(depth, 0), created_at, id`,
          key,
        )
        .filter((row) => !exclude || (row.id !== exclude.id && !this.ancestorsOf(row).includes(exclude.id)))
      if (rows.length) return rows
    }
    return []
  }

  /**
   * whether a claim placed under `parent` restarts `row`: it lands where `row` sits (under `row`'s parent, or a root with no placement), or on
   * `row` itself from `row`'s own process; never under `row` or elsewhere in its tree
   */
  /** a local row held only by connections whose harness process exited, as a shim that outlived its harness leaves it */
  private outlived(row: EndpointRow): boolean {
    const pid = Number(/^pid:(\d+):/.exec(row.process ?? "")?.[1])
    return row.connections > 0 && pid > 0 && this.localRow(row) && !this.alive(pid)
  }

  private restarts(row: EndpointRow, parent: EndpointRow | null, process: string | null): boolean {
    if (parent?.id === row.id) return process !== null && row.process !== null && sameHarness(row.process, process)
    return (parent?.id ?? null) === row.parent_ep || (parent === null && row.linked !== null)
  }

  /**
   * the local row hibernated by {@link SPAWN_PROVIDER} whose current wake ticket hashes to `ticket`, connectionless and of a fitting harness:
   * the waker run it was given to taking it back as its resumed session. An unknown or spent ticket is unauthorized
   */
  private ticketed(ticket: string, harness: string): EndpointRow {
    const row = one<EndpointRow>(this.sql, `SELECT * FROM endpoints WHERE kind = 'agent' AND wake_ticket = ? AND hibernate = ?`, ticket, SPAWN_PROVIDER)
    if (!row || !this.localRow(row) || !harnessFits(row.harness, harness)) throw new RelayError("unauthorized", "the wake ticket is unknown or spent")
    if (row.connections > 0) throw new RelayError("unavailable", "the endpoint is still held: try again once it lets go")
    return row
  }

  /**
   * whether the claim re-claims `row` with the grant `row` spent: from `row`'s own process or one of its ancestors, or with no lineage from
   * `row`'s harness and the cwd its claims connect from
   */
  private redeems(row: EndpointRow, scope: ClaimScope, claimant: { harness: string; cwd: string | null; process: string | null }): boolean {
    const spent = this.spentGrant(scope)
    if (spent?.used_by !== row.id) return false
    const lineage = this.lineageParent(scope.lineage)
    if (!lineage) return harnessFits(row.harness, claimant.harness) && spent.spent_cwd !== null && spent.spent_cwd === claimant.cwd
    return this.restarts(row, lineage, claimant.process) || this.ancestorsOf(row).includes(lineage.id)
  }

  /** the claim's grant, when an endpoint spent it */
  private spentGrant(scope: ClaimScope): GrantRow | undefined {
    if (scope.grant === null) return undefined
    return one<GrantRow>(this.sql, `SELECT * FROM grants WHERE token_hash = ? AND used_by IS NOT NULL AND revoked_at IS NULL`, scope.grant)
  }

  /** a claim whose grant is refused fails; its audit row is written after the rollback */
  private grantRefused(scope: ClaimScope, reason: string): RelayError {
    const error = new RelayError("unauthorized", `grant refused: ${reason}`)
    this.deferred.set(error, { endpoint: null, detail: { target: scope.handle, reason } })
    return error
  }

  /** a new row's tree, caps (besides the human's a reset kept), own rules and groups */
  private place(row: EndpointRow, scope: ClaimScope, now: number): void {
    const placement = this.placement(scope, now, row)
    if (placement.refused) throw this.grantRefused(scope, placement.refused)
    if (placement.ignored) this.audit("scope_grant_ignored", row.id, null, { target: this.address(row), reason: placement.ignored })
    const parent = placement.parent
    const depth = parent ? (parent.depth ?? 0) + 1 : 0
    if (depth > LIMITS.depthMax)
      throw new RelayError("scope_refused", `${scope.handle} would sit deeper than ${LIMITS.depthMax} under ${this.address(parent!)}`)
    const caps: ScopeCaps = { caps: [], allow: {} }
    const grant = placement.grant
    if (grant) {
      this.spend(grant, row.id, scope.cwd)
      caps.caps.push(...this.grantCaps(grant))
      const labels = { ...json<Record<string, string>>(grant.labels, {}), ...json<Record<string, string>>(row.labels, {}) }
      this.sql.all(
        `UPDATE endpoints SET labels = ?, title = CASE WHEN title IS NULL OR title IS title_auto THEN COALESCE(?, title) ELSE title END,
         title_auto = CASE WHEN ? IS NOT NULL AND (title IS NULL OR title IS title_auto) THEN NULL ELSE title_auto END WHERE id = ?`,
        JSON.stringify(labels),
        grant.title,
        grant.title,
        row.id,
      )
    }
    const rules = this.boundRules(scope.rules)
    const childDefault = this.defaults().childDefault
    if (parent && !caps.caps.length && childDefault !== "open" && childDefault !== "inherit") {
      for (const dir of this.presetDirs()) caps.caps.push({ id: capId(), dir, by: "policy", sels: PRESET_LISTS[childDefault].map((sel) => ({ sel })) })
    }
    caps.caps.push(...this.capsOf(row).caps)
    this.sql.all(
      `UPDATE endpoints SET tree = ?, parent_ep = ?, parent_addr = NULL, depth = ?, rules = ?, caps = ? WHERE id = ?`,
      parent ? (parent.tree ?? parent.id) : null,
      parent?.id ?? null,
      depth,
      Object.keys(rules).length ? JSON.stringify(rules) : null,
      caps.caps.length ? JSON.stringify(caps) : null,
      row.id,
    )
    const placed = this.byId(row.id)!
    for (const dir of ["in", "out"] as const) this.needGroups(placed, scope.rules[dir])
    if (grant) this.joinGrant(grant, row.id, now)
    if (grant?.peek === "local" && one(this.sql, `UPDATE endpoints SET peek = 'local' WHERE id = ? AND peek IS NULL RETURNING id`, row.id)) {
      this.audit("peek_set", row.id, null, { by: this.addressOf(grant.issuer), auth: "grant", target: this.address(row), before: null, after: "local" })
    }
    if (grant?.prompt && this.byId(row.id)!.peek !== null)
      this.sql.all(`INSERT INTO peek_turns (endpoint, at, role, text) VALUES (?, ?, 'user', ?)`, row.id, now, grant.prompt)
    for (const name of scope.groups) {
      const group = this.groupByName(name)
      if (group && !group.policy && (group.owner === row.id || this.descendantOf(row.id, group.owner))) this.join(name, row.id, row.id, now)
    }
    if (parent)
      this.audit("scope_place", row.id, null, {
        by: grant ? this.addressOf(grant.issuer) : this.address(row),
        target: this.address(row),
        parent: this.address(parent),
        ...(grant ? { grant: true } : {}),
      })
  }

  /**
   * a claim that took over or joined an existing endpoint spends a grant that would have placed it, adds its caps to the endpoint's and joins
   * its groups; it moves nothing, unless it joined by session key the endpoint only its session's hooks held, still {@link unplaced}, which
   * the grant places as a new endpoint. The endpoint that spent the grant re-claims with it; any other refused grant fails the claim
   */
  private redeem(row: EndpointRow, scope: ClaimScope, now: number, bySession: boolean): void {
    if (this.spentGrant(scope)?.used_by === row.id) return
    const { grant, refused, ignored } = this.placement(scope, now, row)
    if (refused) throw this.grantRefused(scope, refused)
    if (ignored) this.audit("scope_grant_ignored", row.id, null, { target: this.address(row), reason: ignored })
    if (!grant) return
    if (bySession && this.unplaced(row)) {
      this.place(row, scope, now)
      return
    }
    this.spend(grant, row.id, scope.cwd)
    const caps = this.capsOf(row)
    const base = (cap: ScopeCap) =>
      JSON.stringify([
        cap.dir,
        cap.by,
        cap.sels
          .filter((entry) => entry.via === undefined)
          .map((entry) => JSON.stringify([entry.sel, entry.group ?? null]))
          .sort(),
      ])
    for (const cap of this.grantCaps(grant)) if (!caps.caps.some((had) => base(had) === base(cap))) caps.caps.push(cap)
    this.saveCaps(row.id, caps)
    if (grant.title) this.sql.all(`UPDATE endpoints SET title = COALESCE(title, ?) WHERE id = ?`, grant.title, row.id)
    this.joinGrant(grant, row.id, now)
  }

  /** a local root never named, linked or redeeming a grant, with no parent and no local children, not a subagent's */
  private unplaced(row: EndpointRow): boolean {
    return (
      row.kind === "agent" &&
      this.localRow(row) &&
      row.parent_ep === null &&
      row.parent_addr === null &&
      row.linked === null &&
      row.named === null &&
      !row.session?.startsWith("sub:") &&
      !one(this.sql, `SELECT 1 AS x FROM endpoints WHERE parent_ep = ? LIMIT 1`, row.id) &&
      !one(this.sql, `SELECT 1 AS x FROM grants WHERE used_by = ? LIMIT 1`, row.id)
    )
  }

  private grantCaps(grant: GrantRow): ScopeCap[] {
    return json<{ dir: ScopeDirection; sels: ScopeEntry[] }[]>(grant.caps, []).map((cap) => ({ id: capId(), dir: cap.dir, by: grant.issuer, sels: cap.sels }))
  }

  /** the grant's groups, each while it is still the group the grant was issued for, with the issuer's membership allowance when it could widen */
  private joinGrant(grant: GrantRow, endpoint: string, now: number): void {
    for (const entry of json<GrantGroup[]>(grant.groups, [])) {
      const group = typeof entry === "object" && entry !== null ? this.groupByName(entry.name) : undefined
      if (!group || group.policy || this.groupId(group) !== entry.id) continue
      this.join(group.name, endpoint, grant.issuer, now)
      const issuer = this.byId(grant.issuer)
      const target = this.byId(endpoint)!
      if (entry.allow && issuer && !issuer.handle.startsWith(GONE_PREFIX) && this.authority(issuer, target)) {
        const sel = [`group:${group.name}`]
        const by = this.address(issuer)
        this.allowInto(issuer, target, { in: sel, out: sel }, { by, auth: "grant", via: by, target: this.address(target), group: group.name }, group.name)
      }
    }
  }

  private spend(grant: GrantRow, endpoint: string, cwd: string | null): void {
    this.sql.all(`UPDATE grants SET used_by = ?, spent_cwd = ?, prompt = NULL WHERE token_hash = ? AND used_by IS NULL`, endpoint, cwd, grant.token_hash)
  }

  /** the endpoint a plain shell's lineage lands on, or null; with `handle`, the one holding it among the endpoints on that lineage key */
  placeLineage(lineage: unknown, handle?: string): string | null {
    const rows = this.lineageRows(lineageKeys(lineage))
    return (handle === undefined ? rows[0] : rows.find((row) => row.handle === handle))?.id ?? null
  }

  /** whether a shell carrying the spawn-env grant `token` may act as `endpoint`: the endpoint that spent the grant, or one below it */
  grantBinds(token: unknown, endpoint: string | null): boolean {
    if (typeof token !== "string" || !GRANT_TOKEN.test(token)) throw new RelayError("invalid_params", "grant is a krt_ token")
    const spender = one<GrantRow>(
      this.sql,
      `SELECT * FROM grants WHERE token_hash = ? AND used_by IS NOT NULL AND revoked_at IS NULL`,
      this.hash(token),
    )?.used_by
    return endpoint !== null && !!spender && (endpoint === spender || this.descendantOf(endpoint, spender))
  }

  /** the user's own inbox, claimed by the CLI; `tty` is whether the client said a terminal is attached */
  claimHuman(tty: boolean): EndpointView {
    const human = this.byHandle(HUMAN_HANDLE)!
    this.sql.all(`UPDATE endpoints SET connections = connections + 1, last_seen = ? WHERE id = ?`, this.now(), human.id)
    this.audit("claim", human.id, null, { handle: "", harness: "human", tty })
    return this.view(this.byId(human.id)!)
  }

  resume(token: string): EndpointView {
    const row = typeof token === "string" ? one<EndpointRow>(this.sql, `SELECT * FROM endpoints WHERE token_hash = ?`, this.hash(token)) : undefined
    if (!row || row.handle.startsWith(GONE_PREFIX)) throw new RelayError("unauthorized", "unknown resume token")
    this.sql.all(`UPDATE endpoints SET connections = connections + 1, last_seen = ? WHERE id = ?`, this.now(), row.id)
    this.audit("resume", row.id, null, {})
    return this.view(this.byId(row.id)!)
  }

  /**
   * A connection let go; the last one ends the session key unless the session's hooks still report. With `settle` (a lasting connection, such
   * as a shim's), an endpoint left offline drops a working or waiting status, which no one is left to keep current; true when it did.
   */
  disconnect(endpoint: string, options: { settle?: boolean } = {}): boolean {
    const now = this.now()
    this.sql.all(
      `UPDATE endpoints SET connections = MAX(connections - 1, 0), last_seen = ?,
       session = CASE WHEN connections <= 1 AND (hook_seen IS NULL OR hook_seen < ?) THEN NULL ELSE session END WHERE id = ?`,
      now,
      now - LIMITS.hookIdleS * 1000,
      endpoint,
    )
    const row = this.mustEndpoint(endpoint)
    if (!options.settle || this.presence(row, now) !== "offline" || (row.status_state !== "working" && row.status_state !== "waiting")) return false
    this.sql.all(`UPDATE endpoints SET status_state = NULL, status_note = NULL WHERE id = ?`, endpoint)
    return true
  }

  /** refreshes last_seen, unless it is less than `everyMs` old */
  touch(endpoint: string, everyMs = 0): void {
    const now = this.now()
    this.sql.all(`UPDATE endpoints SET last_seen = ? WHERE id = ? AND COALESCE(last_seen, 0) <= ?`, now, endpoint, now - everyMs)
  }

  /** every connection let go, as when the broker starts after a crash; an agent's session stays present for ${LIMITS.restartGraceS} s, while its shim reconnects */
  resetConnections(): void {
    this.sql.all(
      `UPDATE endpoints SET connections = 0, hook_seen = CASE WHEN kind = 'agent' AND hook_ended IS NULL THEN MAX(COALESCE(hook_seen, 0), ?) ELSE hook_seen END WHERE connections > 0`,
      this.now() - (LIMITS.hookIdleS - LIMITS.restartGraceS) * 1000,
    )
    this.sql.all(`UPDATE endpoints SET wakers = 0, waker_left = ? WHERE wakers > 0`, this.now())
  }

  whoami(endpoint: string): EndpointView {
    return this.view(this.mustEndpoint(endpoint))
  }

  /**
   * with `viewer` (an agent's id), only the endpoints it may message, and itself; a parent it cannot see is null. The human's id as `viewer` is
   * the human without a terminal, which sees only what it may message with no exemption. `peekable` marks what each viewer may peek; without a
   * viewer, `peekable: true` marks rows as the human at a terminal sees them
   */
  list(
    filters: {
      all?: boolean | undefined
      harness?: string | undefined
      kind?: EndpointKind | undefined
      presence?: Presence | undefined
      viewer?: string | undefined
      peekable?: boolean | undefined
    } = {},
  ): EndpointView[] {
    const now = this.now()
    this.endExited(now)
    this.settleOffline(now)
    const cutoff = now - LIMITS.listOfflineWithinS * 1000
    const viewer = filters.viewer === undefined ? undefined : this.mustEndpoint(filters.viewer)
    const shown = viewer ? new Set(this.visibleRows(viewer).map((row) => row.id)) : undefined
    const peeker = viewer ?? (filters.peekable === true ? this.byHandle(HUMAN_HANDLE)! : undefined)
    return this.listed()
      .filter(
        (row) =>
          filters.all ||
          row.connections > 0 ||
          row.kind === "human" ||
          (row.last_seen ?? 0) >= cutoff ||
          waking(row, now) ||
          this.rootWake(row, now) !== null ||
          this.hibernated(row),
      )
      .filter((row) => !filters.harness || row.harness === filters.harness)
      .filter((row) => !filters.kind || row.kind === filters.kind)
      .filter((row) => !viewer || row.id === viewer.id || this.mayMessage(viewer, row, viewer.kind === "human"))
      .map((row) => {
        const view = this.view(row, shown)
        return peeker && this.peekableBy(peeker, row, viewer?.kind === "human") ? { ...view, peekable: row.peek! } : view
      })
      .filter((view) => !filters.presence || view.presence === filters.presence)
  }

  /** the addresses `viewer` sees: those it may message or be messaged by, and itself */
  visibleTo(viewer: string): Set<string> {
    return new Set(this.visibleRows(this.mustEndpoint(viewer)).map((row) => this.address(row)))
  }

  private visibleRows(me: EndpointRow): EndpointRow[] {
    return this.listed().filter((row) => row.id === me.id || (me.kind === "human" ? this.mayMessage(me, row, true) : this.sees(me, row)))
  }

  /** the user's own inbox */
  humanId(): string {
    return this.byHandle(HUMAN_HANDLE)!.id
  }

  /** the endpoints `viewer` may message under its scope and the policy, with the rule that admits each; `unverified`: the human without a terminal */
  peers(viewer: string, options: { unverified?: boolean } = {}): PeerView[] {
    const me = this.mustEndpoint(viewer)
    const world = this.scopeWorld(me)
    const unverified = me.kind === "human" && options.unverified === true
    return this.listed()
      .filter((row) => row.id !== me.id && this.mayMessage(me, row, unverified))
      .map((row) => {
        const view = this.view(row)
        return {
          address: view.address,
          kind: view.kind,
          presence: view.presence,
          title: view.title,
          status: view.status,
          reason: this.peerReason(world, me, row, unverified),
          ...(this.peekableBy(me, row, unverified) ? { peekable: row.peek! } : {}),
        }
      })
  }

  /** what a peer is to the viewer and the selectors that admit it, or the reason a pass needs no list */
  private peerReason(world: ScopeWorld, me: EndpointRow, row: EndpointRow, unverified: boolean): string {
    const decision = this.decide(world, me, row, undefined, unverified)
    if (!decision.admitted) return decision.reasons.join("; ")
    return `${relationText(this.subject(row), this.subject(me))} (${decision.admitted.join(", ") || "open"})`
  }

  /** a status line: without a state the current one stays (working when there is none), without a note the current note (the agent's now) stays */
  status(endpoint: string, state: unknown, note: unknown): void {
    if (state !== undefined && (typeof state !== "string" || !STATUS_STATES.includes(state as StatusState))) {
      throw new RelayError("invalid_params", `state must be one of ${STATUS_STATES.join(", ")}`)
    }
    const text = oneLine(note, "note", LIMITS.noteChars)
    if (text && findSecret(text)) throw this.refuse(endpoint, "secret_refused", "the status note looks like it carries a credential")
    this.sql.all(
      `UPDATE endpoints SET status_state = COALESCE(?, status_state, 'working'), status_note = COALESCE(?, status_note, ''), last_seen = ?,
       tldr_turn = CASE WHEN ? THEN COALESCE(prompts, 0) ELSE tldr_turn END WHERE id = ?`,
      state ?? null,
      text,
      this.now(),
      text === null ? 0 : 1,
      endpoint,
    )
  }

  /** an agent's own title, shown in list and whoami; empty clears it, and no claim overwrites it */
  title(endpoint: string, value: unknown): EndpointView {
    const row = this.mustEndpoint(endpoint)
    if (row.kind !== "agent") throw new RelayError("invalid_params", "only an agent endpoint has a title")
    const title = oneLine(value, "title", 64) || null
    if (title && findSecret(title)) throw this.refuse(endpoint, "secret_refused", "the title looks like it carries a credential")
    this.sql.all(`UPDATE endpoints SET title = ?, title_auto = NULL, title_turn = NULL WHERE id = ?`, title, endpoint)
    this.audit("title", endpoint, null, { title })
    return this.whoami(endpoint)
  }

  /**
   * a hook's guess at the session's title, from the harness's own summary or the first prompt's first line; whether it changed the title.
   * Never over a title set explicitly; the first prompt fills only an empty title, and a summary replaces an inferred one at most every
   * ${LIMITS.titleRefreshTurns} prompts, or at once over the first prompt's
   */
  inferTitle(endpoint: string, params: { text?: unknown; from?: unknown }, options: { transient?: boolean; process?: string } = {}): boolean {
    if (params.from !== "summary" && params.from !== "prompt") throw new RelayError("invalid_params", "from is summary or prompt")
    if (typeof params.text !== "string") throw new RelayError("invalid_params", "text must be a string")
    const row = this.mustEndpoint(endpoint)
    if (row.kind !== "agent" || !this.holds(row, options)) return false
    const title = hookTitle(params.text)
    if (!title || title === row.title) return false
    if (row.title !== null && row.title !== row.title_auto) return false
    const turn = row.prompts ?? 0
    if (params.from === "prompt" && row.title !== null) return false
    if (params.from === "summary" && row.title !== null && row.title_turn !== null && turn - row.title_turn < LIMITS.titleRefreshTurns) return false
    this.sql.all(`UPDATE endpoints SET title = ?, title_auto = ?, title_turn = ? WHERE id = ?`, title, title, params.from === "summary" ? turn : null, endpoint)
    return true
  }

  /**
   * how the session holding an agent endpoint wakes it when idle, one of {@link WAKES}; `none` clears it. Only the process holding the
   * endpoint sets it through a hook; whether it changed
   */
  setWake(endpoint: string, value: unknown, options: { transient?: boolean; process?: string; ref?: unknown } = {}): boolean {
    if (typeof value !== "string" || !WAKES.includes(value as Wake)) throw new RelayError("invalid_params", `via must be one of ${WAKES.join(", ")}`)
    const ref = options.ref === undefined || options.ref === null ? null : this.wakeRef(options.ref)
    if (ref !== null && (value !== "spawn-resume" || options.transient))
      throw new RelayError("invalid_params", "ref goes only with spawn-resume, from the connection that holds the spawn")
    const row = this.mustEndpoint(endpoint)
    if (row.kind !== "agent") throw new RelayError("invalid_params", "only an agent endpoint wakes")
    if (!this.holds(row, options)) return false
    const wake = value === "none" ? null : value
    const hold = options.transient ? row.hold_ref : ref
    if (row.wake === wake && row.hold_ref === hold) return false
    this.sql.all(`UPDATE endpoints SET wake = ?, hold_ref = ? WHERE id = ?`, wake, hold, endpoint)
    return row.wake !== wake
  }

  /**
   * a connection that set the endpoint's wake starts (`live`) or stops counting as its waker. A hook's (`grace`) still counts for
   * LIMITS.restartGraceS after it closes, while its harness starts the next one
   */
  waker(endpoint: string, live: boolean, options: { grace?: boolean } = {}): void {
    if (live) this.sql.all(`UPDATE endpoints SET wakers = wakers + 1 WHERE id = ?`, endpoint)
    else {
      const now = this.now()
      this.sql.all(
        `UPDATE endpoints SET wakers = MAX(wakers - 1, 0), waker_left = CASE WHEN ? THEN ? ELSE waker_left END WHERE id = ?`,
        options.grace ? 1 : 0,
        now,
        endpoint,
      )
      if (!options.grace) this.lapseWake(endpoint, now)
    }
  }

  /** clears a wake no waker holds once a hook waker's grace ran out too: nothing is left to wake the endpoint */
  private lapseWake(endpoint: string, now: number): void {
    this.sql.all(`UPDATE endpoints SET wake = NULL WHERE id = ? AND wakers = 0 AND COALESCE(waker_left, 0) < ?`, endpoint, now - LIMITS.restartGraceS * 1000)
  }

  /**
   * a title for the caller's in-process subagent `id` from the description its parent gave it; the subagent's endpoint id when it changed one.
   * It fills only a title nobody set, as an inferred one, and waits for the subagent's claim when it has no endpoint yet
   */
  subagentTitle(endpoint: string, params: { id?: unknown; title?: unknown }, options: { transient?: boolean; process?: string } = {}): string | null {
    if (typeof params.id !== "string" || !SUBAGENT_ID.test(params.id)) throw new RelayError("invalid_params", "id is the subagent's id")
    if (typeof params.title !== "string") throw new RelayError("invalid_params", "title must be a string")
    const row = this.mustEndpoint(endpoint)
    const title = hookTitle(params.title)
    if (row.kind !== "agent" || !this.holds(row, options) || !title) return null
    const prefix = `sub:${params.id}:`
    const sub = one<{ id: string }>(
      this.sql,
      `SELECT id FROM endpoints WHERE kind = 'agent' AND parent_ep = ? AND substr(session, 1, ?) = ? ORDER BY COALESCE(last_seen, created_at) DESC LIMIT 1`,
      row.id,
      prefix.length,
      prefix,
    )
    if (sub) return this.fillTitle(sub.id, title) ? sub.id : null
    const key = `${row.id} ${params.id}`
    this.subagentTitles.delete(key)
    this.subagentTitles.set(key, title)
    for (const old of this.subagentTitles.keys()) {
      if (this.subagentTitles.size <= SUBAGENT_TITLES_KEPT) break
      this.subagentTitles.delete(old)
    }
    return null
  }

  /** the title a parent named subagent `id` with before it had an endpoint, given to `endpoint`; whether it changed its title */
  private takeSubagentTitle(root: string, id: string, endpoint: string): boolean {
    const title = this.subagentTitles.get(`${root} ${id}`)
    if (title === undefined) return false
    this.subagentTitles.delete(`${root} ${id}`)
    return this.fillTitle(endpoint, title)
  }

  /** an inferred title for an endpoint whose title nobody set */
  private fillTitle(endpoint: string, title: string): boolean {
    return (
      one(
        this.sql,
        `UPDATE endpoints SET title = ?, title_auto = ?, title_turn = NULL WHERE id = ? AND (title IS NULL OR title = title_auto) AND title IS NOT ? RETURNING id`,
        title,
        title,
        endpoint,
        title,
      ) !== undefined
    )
  }

  /**
   * a session joins on demand: its hook claim registers or takes back its endpoint, marked seen now even right after a leave, and `handle`,
   * when given, renames it in place ({@link rename}'s rules). Nothing is kept when the rename is refused
   */
  joinSession(claim: Claim, handle?: unknown, under?: unknown): EndpointView {
    return this.scopeTx(() => {
      const { endpoint } = this.claim(claim, { transient: true })
      const row = this.mustEndpoint(endpoint.id)
      if (handle !== undefined && handle !== null && handle !== "") this.renameRow(row, handle, false)
      this.sql.all(`UPDATE endpoints SET hook_seen = ?, hook_ended = NULL WHERE id = ?`, this.now(), row.id)
      this.wakeDone(row.id, "join")
      this.audit("join", row.id, null, { handle: this.byId(row.id)!.handle })
      if (under !== undefined && under !== null && under !== "") {
        const me = this.byId(row.id)!
        const parent = this.resolve(under)
        if (parent.id !== me.parent_ep && parent.kind === "agent" && !this.mayMessage(me, parent)) throw unreachable(under)
        this.link(me, parent, { by: this.address(me), auth: "session" })
      }
      return this.whoami(row.id)
    })
  }

  /**
   * the human links a local root directly. An agent (session, self or lineage auth) adopts a local root under itself directly when it may
   * message it: not itself, an ancestor or a subagent's endpoint. A child that sits under another parent is asked to consent through the normal
   * send path instead
   */
  adopt(actor: ScopeActor, params: { endpoint: unknown; parent?: unknown }, options?: { tty?: boolean }): AdoptResult
  adopt(actor: ScopeActor, params: { endpoint: unknown; parent?: unknown }, options: { tty?: boolean; send: AdoptSend }): AdoptResult | Promise<AdoptResult>
  adopt(
    actor: ScopeActor,
    params: { endpoint: unknown; parent?: unknown },
    options: { tty?: boolean; send?: AdoptSend } = {},
  ): AdoptResult | Promise<AdoptResult> {
    const prepared: { result: AdoptResult; sender?: { from: string; auth: "session" | "self"; under: string } } = this.scopeTx(() => {
      const me = this.actorRow(actor)
      if (actor.kind === "human") this.needTerminal(actor, me, params.endpoint)
      const target = this.resolve(params.endpoint)
      if (target.kind !== "agent" || !this.localRow(target)) throw new RelayError("invalid_params", "only a local agent endpoint can be linked")
      const parentAddress = params.parent ?? (actor.kind === "human" ? undefined : this.address(me))
      if (parentAddress === undefined || parentAddress === null || parentAddress === "")
        throw new RelayError("invalid_params", "the human names the parent to link under")
      const parent = this.resolve(parentAddress)
      const refused = (message: string) => this.scopeRefused(actor, me, { target: this.address(target), reason: "adopt" }, message)
      if (actor.kind !== "human" && parent.id !== me.id) throw refused("an agent adopts only under itself")
      const result: AdoptResult = { endpoint: this.whoami(target.id), parent: this.address(parent) }
      if (actor.kind === "human" || options.tty === true) {
        this.link(target, parent, this.actorDetail(actor, me))
        return { result: { ...result, endpoint: this.whoami(target.id) } }
      }
      if (target.id === me.id) throw refused("an agent cannot adopt itself")
      if (this.ancestorsOf(me).includes(target.id)) throw refused(`${this.address(target)} sits above you: an agent cannot adopt its own ancestor`)
      if (target.session?.startsWith("sub:")) throw refused(`${this.address(target)} is a subagent's endpoint: it stays under its root`)
      if (target.parent_ep === me.id) return { result }
      if (target.parent_ep !== null || target.parent_addr !== null) {
        if (actor.auth === "lineage") throw refused("only the session itself may ask a child that sits under another parent to link")
        return { result, sender: { from: me.id, auth: actor.auth === "self" ? "self" : "session", under: this.parentAddress(target) } }
      }
      this.checkScope(me, target, String(params.endpoint))
      const policy = policyRefusal(this.policy, this.subject(me), this.subject(target), this.policyBound)
      if (policy) throw new RelayError("policy_refused", `${policy} (${this.address(target)})`)
      this.link(target, me, this.actorDetail(actor, me))
      return { result: { ...result, endpoint: this.whoami(target.id) } }
    })
    if (!prepared.sender) return prepared.result
    const { result } = prepared
    const { from, auth, under } = prepared.sender
    const send: SendParams = {
      to: result.endpoint.address,
      kind: "request",
      ttl_s: 86_400,
      body: `${result.parent} asks you to link under it as its worker. You sit under ${under} now: you can accept only once you are a root again. To accept, run ${CLI_NAME} link accept <id> with this message's id, or ${CLI_NAME} join --under ${result.parent} (relay_link_accept {id} or relay_join {under: "${result.parent}"}).`,
    }
    const requested = (sent: SendResult): AdoptResult => ({ ...result, ...(sent.held ? { held: sent.held } : { requested: sent.id }) })
    return options.send ? options.send(from, send, { link: auth }).then(requested) : requested(this.send(from, send, { link: auth }))
  }

  /** accepts a broker-issued request delivered to the caller's own session */
  linkAccept(actor: ScopeActor, params: { id: unknown }): { endpoint: EndpointView; parent: string } {
    return this.scopeTx(() => {
      if (actor.kind !== "endpoint" || actor.auth === "lineage") throw new RelayError("scope_refused", "only the session itself accepts a link request")
      const me = this.actorRow(actor)
      const request = this.delivered(me.id, params.id)
      if (!request?.link || request.kind !== "request") throw new RelayError("not_found", "no link request delivered to this endpoint")
      const parent = this.mustEndpoint(request.from.endpoint)
      if (parent.kind !== "agent") throw new RelayError("invalid_params", "the requesting parent is no longer an agent")
      this.link(me, parent, { ...this.actorDetail(actor, me), request: request.id })
      return { endpoint: this.whoami(me.id), parent: this.address(parent) }
    })
  }

  /**
   * a linked agent back to a root: its subtree moves along and the policy's child scope comes off. The human at a terminal unlinks any local
   * agent; an agent only itself, and only when the policy's `defaults.unlink` is `self`, since a worker detaching widens its own scope
   */
  unlink(actor: ScopeActor, params: { endpoint?: unknown } = {}): { endpoint: EndpointView; parent: string } {
    return this.scopeTx(() => {
      const me = this.actorRow(actor)
      if (actor.kind === "human") this.needTerminal(actor, me, params.endpoint)
      else if (actor.auth === "lineage") throw new RelayError("scope_refused", "only the session itself unlinks it: run this from the session's own shell")
      const target = params.endpoint === undefined ? me : this.resolve(params.endpoint)
      if (actor.kind !== "human" && target.id !== me.id) throw new RelayError("scope_refused", "an agent unlinks only itself")
      if (target.kind !== "agent" || !this.localRow(target)) throw new RelayError("invalid_params", "only a local agent endpoint can be unlinked")
      if (target.parent_ep === null && target.parent_addr === null)
        throw new RelayError("invalid_params", `${this.address(target)} is a root: it has no parent`)
      if (actor.kind !== "human" && this.policy?.defaults?.unlink !== "self")
        throw this.scopeRefused(
          actor,
          me,
          { target: this.address(target), reason: "unlink" },
          "unlinking widens a worker's scope: only the human at a terminal unlinks it (policy defaults.unlink: self lets it)",
        )
      if (target.parent_ep === null) {
        const from = this.linkedParent(target) ?? target.parent_addr!
        this.sql.all(`UPDATE endpoints SET parent_addr = NULL, linked = NULL WHERE id = ?`, target.id)
        this.scopeMemo?.ancestors.clear()
        this.scopeMemo?.limited.clear()
        this.audit("unlink", target.id, null, { ...this.actorDetail(actor, me), target: this.address(target), parent: from })
        return { endpoint: this.whoami(target.id), parent: from }
      }
      const parent = this.byId(target.parent_ep)
      const from = parent ? this.address(parent) : target.parent_ep
      const shift = target.depth ?? 0
      this.sql.all(
        `WITH RECURSIVE below(id) AS (SELECT id FROM endpoints WHERE parent_ep = ? UNION SELECT e.id FROM endpoints e JOIN below b ON e.parent_ep = b.id)
         UPDATE endpoints SET tree = ?, depth = depth - ? WHERE id IN (SELECT id FROM below)`,
        target.id,
        target.id,
        shift,
      )
      const caps = this.capsOf(target)
      const kept = caps.caps.filter((cap) => cap.by !== "policy")
      this.sql.all(
        `UPDATE endpoints SET tree = NULL, parent_ep = NULL, depth = 0, linked = NULL, caps = ? WHERE id = ?`,
        kept.length || Object.keys(caps.allow).length ? JSON.stringify({ ...caps, caps: kept }) : null,
        target.id,
      )
      this.scopeMemo?.ancestors.clear()
      this.scopeMemo?.limited.clear()
      this.audit("unlink", target.id, null, { ...this.actorDetail(actor, me), target: this.address(target), parent: from })
      return { endpoint: this.whoami(target.id), parent: from }
    })
  }

  /**
   * `row`, a root, and its subtree moved under `parent`, a local agent that is neither `row` nor one of its descendants; a parent on another
   * machine goes to {@link linkAcross}
   */
  private link(row: EndpointRow, parent: EndpointRow, by: { by: string; auth: string; request?: string }): void {
    if (!this.localRow(parent)) {
      const key = this.linkAcross(row, parent)
      if (row.parent_addr === key) return
      if (row.parent_ep !== null || row.parent_addr !== null) throw this.alreadyLinked(row)
      this.sql.all(`UPDATE endpoints SET parent_addr = ?, linked = ? WHERE id = ?`, key, this.now(), row.id)
      this.scopeMemo?.ancestors.clear()
      this.scopeMemo?.limited.clear()
      this.audit("adopt", row.id, by.request ?? null, { ...by, target: this.address(row), parent: this.address(parent) })
      return
    }
    if (parent.kind !== "agent") throw new RelayError("invalid_params", "the parent is an agent endpoint")
    if (row.parent_ep === parent.id) return
    if (parent.id === row.id || this.ancestorsOf(parent).includes(row.id))
      throw new RelayError("scope_refused", `${this.address(parent)} sits under ${this.address(row)}: a session cannot go under its own descendant`)
    if (row.parent_ep !== null || row.parent_addr !== null) throw this.alreadyLinked(row)
    const depth = (parent.depth ?? 0) + 1
    const deepest = one<{ d: number | null }>(this.sql, `SELECT MAX(depth) AS d FROM endpoints WHERE tree = ?`, row.id)?.d ?? 0
    if (deepest + depth > LIMITS.depthMax)
      throw new RelayError("scope_refused", `${this.address(row)} would sit deeper than ${LIMITS.depthMax} under ${this.address(parent)}`)
    const tree = parent.tree ?? parent.id
    this.sql.all(`UPDATE endpoints SET tree = ?, depth = depth + ? WHERE tree = ?`, tree, depth, row.id)
    const caps = this.capsOf(row)
    const childDefault = this.defaults().childDefault
    if (childDefault !== "open" && childDefault !== "inherit" && !caps.caps.some((cap) => cap.by === "policy"))
      for (const dir of this.presetDirs()) caps.caps.push({ id: capId(), dir, by: "policy", sels: PRESET_LISTS[childDefault].map((sel) => ({ sel })) })
    this.sql.all(
      `UPDATE endpoints SET tree = ?, parent_ep = ?, depth = ?, linked = ?, caps = ? WHERE id = ?`,
      tree,
      parent.id,
      depth,
      this.now(),
      caps.caps.length || Object.keys(caps.allow).length ? JSON.stringify(caps) : null,
      row.id,
    )
    this.scopeMemo?.ancestors.clear()
    this.scopeMemo?.limited.clear()
    this.audit("adopt", row.id, by.request ?? null, { ...by, target: this.address(row), parent: this.address(parent) })
  }

  /** a link of `row`, which already sits under a parent, to another one */
  private alreadyLinked(row: EndpointRow): RelayError {
    return new RelayError("scope_refused", `${this.address(row)} already sits under ${this.parentAddress(row)}; unlink it first`)
  }

  /** the address of the parent `row` sits under, local or on another machine */
  private parentAddress(row: EndpointRow): string {
    const local = row.parent_ep ? this.byId(row.parent_ep) : undefined
    return local ? this.address(local) : row.parent_addr !== null ? (this.linkedParent(row) ?? row.parent_addr) : "another agent"
  }

  /**
   * the key `<machine>/<handle>` that links `row`, a local agent, under `parent`, an agent on another machine, once the parent is checked; no
   * inherited or child-default caps come with it. A relay of one machine has no such parent
   */
  protected linkAcross(_row: EndpointRow, _parent: EndpointRow): string {
    throw new RelayError("invalid_params", "the parent is a local agent endpoint")
  }

  /** whether `a` and `b` are a parent and its child on different machines */
  protected linkedAcross(_a: EndpointRow, _b: EndpointRow): boolean {
    return false
  }

  /** the address of `row`'s parent on another machine, null when it has none; with `shown`, null for a parent outside it */
  protected linkedParent(_row: EndpointRow, _shown?: Set<string>): string | null {
    return null
  }

  /**
   * renames an agent in place: its id, mail, threads, status, title and relations stay. An agent renames only itself, and only a root unless
   * the policy's `defaults.rename` is `self`; the human at a terminal renames any local agent. The new handle is valid and held by no other endpoint,
   * except an offline one {@link renameRow} takes over
   */
  rename(
    actor: ScopeActor,
    params: { endpoint?: unknown; handle: unknown; take_over?: unknown },
  ): { endpoint: EndpointView; from: string; session: string | null; retired?: string } {
    if (params.take_over !== undefined && typeof params.take_over !== "boolean") throw new RelayError("invalid_params", "take_over is true or false")
    return this.scopeTx(() => {
      const me = this.actorRow(actor)
      if (actor.kind === "human") this.needTerminal(actor, me, params.endpoint)
      else if (actor.auth === "lineage") throw new RelayError("scope_refused", "only the session itself renames it: run this from the session's own shell")
      const target = params.endpoint === undefined ? me : this.resolve(params.endpoint)
      if (actor.kind !== "human" && target.id !== me.id) throw new RelayError("scope_refused", "an agent renames only itself")
      if (target.kind !== "agent" || !this.localRow(target)) throw new RelayError("invalid_params", "only a local agent endpoint can be renamed")
      const retired = this.renameRow(target, params.handle, actor.kind === "human", params.take_over === true)
      return { endpoint: this.whoami(target.id), from: target.handle, session: target.session, ...(retired ? { retired } : {}) }
    })
  }

  /**
   * the endpoint's handle set to `value`, with the stored `ep:` and `fleet:` selectors that named it. A local offline agent holding the handle
   * is taken over when it held the same harness session, or with `takeOver` by the human at a terminal: the id of the row retired
   */
  private renameRow(row: EndpointRow, value: unknown, byHuman: boolean, takeOver = false): string | undefined {
    const handle = typeof value === "string" ? value.trim().replace(/^me\//, "") : ""
    if (!validHandle(handle)) throw new RelayError("invalid_params", `handle ${JSON.stringify(handle)} is not valid: lowercase letters, digits, . _ -`)
    if (findSecret(handle)) throw new RelayError("secret_refused", "the handle looks like it carries a credential")
    if (handle === row.handle) {
      this.sql.all(`UPDATE endpoints SET named = COALESCE(named, ?) WHERE id = ?`, this.now(), row.id)
      return
    }
    if (!byHuman && row.parent_ep !== null && this.policy?.defaults?.rename !== "self") {
      const parent = this.byId(row.parent_ep)
      throw new RelayError("scope_refused", `spawned by ${parent ? this.address(parent) : "another agent"}; its name is set by the spawner`)
    }
    const held = this.byHandle(handle)
    let retired: string | undefined
    if (held) {
      const offline = held.kind === "agent" && held.connections === 0 && presenceOf(held, this.now()) === "offline" && this.localRow(held)
      const same = held.harness_session !== null && held.harness_session === row.harness_session
      if (takeOver && !byHuman && !same) throw new RelayError("scope_refused", "only the human at a terminal takes over another endpoint")
      if (takeOver && offline && !same && !harnessFits(held.harness, row.harness ?? "cli"))
        throw new RelayError("invalid_params", `${handle} is a ${held.harness} endpoint: only an endpoint of the same harness is taken over`)
      if (!offline || held.session?.startsWith("sub:") || !(same || (takeOver && harnessFits(held.harness, row.harness ?? "cli")))) {
        const how = held.kind !== "agent" ? "reserved" : presenceOf(held, this.now()) === "offline" ? "held by an offline endpoint" : "held by a live endpoint"
        throw new RelayError("invalid_params", `${handle} is ${how}: pick another name${offline ? ", or take it over with --take-over from a terminal" : ""}`)
      }
      retired = this.takeOver(row, held, same ? "session" : "human")
    }
    const from = row.handle
    this.sql.all(`UPDATE endpoints SET handle = ?, named = ? WHERE id = ?`, handle, this.now(), row.id)
    this.sql.all(`UPDATE grants SET name = ? WHERE used_by = ? AND name = ?`, handle, row.id, from)
    for (const prefix of this.byId(row.id)!.parent_ep === null ? ["ep:", "fleet:"] : ["ep:"]) {
      const [a, b] = [JSON.stringify(`${prefix}${from}`), JSON.stringify(`${prefix}${handle}`)]
      for (const [table, column] of [
        ["endpoints", "rules"],
        ["endpoints", "caps"],
        ["groups", "rules"],
        ["grants", "caps"],
      ] as const)
        this.sql.all(`UPDATE ${table} SET ${column} = REPLACE(${column}, ?, ?) WHERE instr(${column}, ?) > 0`, a, b, a)
    }
    this.renamedHandle(from, handle)
    this.audit("rename", row.id, null, { from, to: handle })
    return retired
  }

  /**
   * `row` takes over `held`, an offline local agent, and retires it: `held`'s subtree, unread mail, grants, groups and harness session move to
   * `row`, which takes `held`'s hand-made link when it is an unlinked root itself. Its handle is then free for `row`
   */
  private takeOver(row: EndpointRow, held: EndpointRow, by: "human" | "session"): string {
    if (this.ancestorsOf(row).includes(held.id))
      throw new RelayError("scope_refused", `${this.address(row)} sits under ${this.address(held)}: it cannot take over its own ancestor`)
    if (row.parent_ep === null && row.parent_addr === null && held.linked !== null && held.parent_addr !== null)
      this.sql.all(`UPDATE endpoints SET parent_addr = ?, linked = ? WHERE id = ?`, held.parent_addr, held.linked, row.id)
    else if (row.parent_ep === null && row.parent_addr === null && held.linked !== null && held.parent_ep !== null) {
      const parent = this.byId(held.parent_ep)
      if (parent) this.link(row, parent, { by: this.address(row), auth: by })
    }
    const place = this.byId(row.id)!
    const shift = (place.depth ?? 0) - (held.depth ?? 0)
    const below = `WITH RECURSIVE below(id) AS (SELECT id FROM endpoints WHERE parent_ep = ? UNION SELECT e.id FROM endpoints e JOIN below b ON e.parent_ep = b.id)`
    const deepest = one<{ d: number | null }>(this.sql, `${below} SELECT MAX(depth) AS d FROM endpoints WHERE id IN (SELECT id FROM below)`, held.id)?.d
    if (deepest != null && deepest + shift > LIMITS.depthMax)
      throw new RelayError("scope_refused", `${this.address(held)}'s children would sit deeper than ${LIMITS.depthMax} under ${this.address(place)}`)
    this.sql.all(`${below} UPDATE endpoints SET tree = ?, depth = depth + ? WHERE id IN (SELECT id FROM below)`, held.id, place.tree ?? place.id, shift)
    const children = this.sql.all<{ id: string }>(`UPDATE endpoints SET parent_ep = ? WHERE parent_ep = ? RETURNING id`, row.id, held.id).length
    this.sql.all(`UPDATE deliveries SET endpoint = ? WHERE endpoint = ? AND acked_at IS NULL`, row.id, held.id)
    this.sql.all(`UPDATE grants SET issuer = ? WHERE issuer = ?`, row.id, held.id)
    this.sql.all(`UPDATE grants SET under = ? WHERE under = ?`, row.id, held.id)
    this.sql.all(`UPDATE groups SET owner = ? WHERE owner = ?`, row.id, held.id)
    this.sql.all(
      `INSERT OR IGNORE INTO group_members (name, endpoint, added_by, at) SELECT name, ?, added_by, at FROM group_members WHERE endpoint = ?`,
      row.id,
      held.id,
    )
    this.sql.all(`DELETE FROM group_members WHERE endpoint = ?`, held.id)
    this.sql.all(
      `UPDATE endpoints SET harness_session = ?, harness_transcript = ? WHERE id = ? AND harness_session IS NULL`,
      held.harness_session,
      held.harness_transcript,
      row.id,
    )
    this.sql.all(`UPDATE endpoints SET handle = ?, session = NULL, token_hash = NULL WHERE id = ?`, `${GONE_PREFIX}${held.id}`, held.id)
    this.wakeDone(held.id, "retired")
    this.dropPeek(held.id)
    this.scopeMemo?.ancestors.clear()
    this.scopeMemo?.limited.clear()
    this.audit("take_over", row.id, null, { from: row.handle, to: held.handle, retired: held.id, children, by })
    return held.id
  }

  /** a local agent's handle moved from `from` to `to`: a subclass updates what names it on another machine's rows */
  protected renamedHandle(_from: string, _to: string): void {}

  /**
   * a session leaves: it lets go of its session and token and shows offline, its mail kept; a later join takes it back. An agent leaves only
   * itself, the human at a terminal any local root or linked agent. A spawned worker stays joined while it runs
   */
  leaveSession(actor: ScopeActor, params: { endpoint?: unknown } = {}): { endpoint: EndpointView; session: string | null } {
    return this.scopeTx(() => {
      const me = this.actorRow(actor)
      if (actor.kind === "human") this.needTerminal(actor, me, params.endpoint)
      else if (actor.auth === "lineage") throw new RelayError("scope_refused", "only the session itself leaves: run this from the session's own shell")
      const target = params.endpoint === undefined ? me : this.resolve(params.endpoint)
      if (actor.kind !== "human" && target.id !== me.id) throw new RelayError("scope_refused", "an agent leaves only for itself")
      if (target.kind !== "agent" || !this.localRow(target)) throw new RelayError("invalid_params", "only a local agent endpoint can leave")
      if (target.parent_ep !== null && target.linked === null) {
        const parent = this.byId(target.parent_ep)
        throw new RelayError("scope_refused", `spawned by ${parent ? this.address(parent) : "another agent"}; a spawned worker stays joined while it runs`)
      }
      this.sql.all(
        `UPDATE endpoints SET session = NULL, token_hash = NULL, hook_seen = NULL, hook_ended = ?, wake = NULL, hold_ref = NULL WHERE id = ?`,
        this.now(),
        target.id,
      )
      this.wakeDone(target.id, "leave")
      this.audit("leave", target.id, null, { handle: target.handle })
      return { endpoint: this.whoami(target.id), session: target.session }
    })
  }

  /** the harness session key an endpoint holds, if any */
  sessionOf(endpoint: string): string | null {
    return this.byId(endpoint)?.session ?? null
  }

  /**
   * marks a local agent hibernated by `wake`, the provider whose wake hook resumes it, with its opaque `ref` and the seconds a wake takes
   * (`eta_s`); `none` clears it. The agent's own session or the human (no terminal needed: a provider's daemon has none) naming the endpoint.
   * `known` is whether a waker is configured for a provider
   */
  hibernate(
    actor: ScopeActor,
    params: { endpoint?: unknown; wake?: unknown; ref?: unknown; eta_s?: unknown },
    options: { known?: (provider: string) => boolean } = {},
  ): { endpoint: EndpointView } {
    const me = this.actorRow(actor)
    const set = this.hibernation(params, options)
    if (actor.kind === "endpoint" && actor.auth === "lineage")
      throw new RelayError("scope_refused", "only the session itself hibernates: run this from the session's own shell")
    if (params.endpoint === undefined && me.kind !== "agent") throw new RelayError("invalid_params", "the human names the endpoint")
    const target = params.endpoint === undefined ? me : this.resolve(params.endpoint)
    if (actor.kind === "endpoint" && target.id !== me.id) throw new RelayError("scope_refused", "an agent hibernates only itself")
    if (target.kind !== "agent" || !this.localRow(target)) throw new RelayError("invalid_params", "only a local agent endpoint hibernates")
    if (set.wake === SPAWN_PROVIDER && (target.hold_ref === null || set.ref !== target.hold_ref))
      throw new RelayError("invalid_params", `${SPAWN_PROVIDER} hibernates only a durably held worker, with the ref its hold gave`)
    return { endpoint: this.setHibernation(me, target, set) }
  }

  /** the human marks every live local agent but subagents hibernated by one provider, as before suspending the machine they run on */
  hibernateAll(
    actor: ScopeActor,
    params: { wake?: unknown; ref?: unknown; eta_s?: unknown },
    options: { known?: (provider: string) => boolean } = {},
  ): { endpoints: EndpointView[] } {
    const me = this.actorRow(actor)
    if (actor.kind !== "human") throw new RelayError("scope_refused", "only the human hibernates every agent")
    const set = this.hibernation(params, options)
    if (set.wake === SPAWN_PROVIDER) throw new RelayError("invalid_params", `${SPAWN_PROVIDER} hibernates only a durably held worker, by its own ref`)
    const now = this.now()
    const targets = this.sql
      .all<EndpointRow>(
        `SELECT * FROM endpoints WHERE kind = 'agent' AND substr(handle, 1, ${GONE_PREFIX.length}) != '${GONE_PREFIX}'
         AND (session IS NULL OR substr(session, 1, 4) != 'sub:') ORDER BY handle`,
      )
      .filter((row) => this.localRow(row) && (set.wake === "none" ? row.hibernate !== null : presenceOf(row, now) !== "offline"))
    return { endpoints: targets.map((row) => this.setHibernation(me, row, set)) }
  }

  private hibernation(
    params: { wake?: unknown; ref?: unknown; eta_s?: unknown },
    options: { known?: (provider: string) => boolean },
  ): { wake: string; ref: string | null; eta: number | null } {
    const wake = params?.wake
    if (typeof wake !== "string" || (wake !== "none" && !WAKE_PROVIDER.test(wake)))
      throw new RelayError("invalid_params", "wake is a provider name (lowercase letters, digits and hyphens, at most 32) or none")
    const ref = params.ref === undefined || params.ref === null ? null : this.wakeRef(params.ref)
    let eta: number | null = null
    if (params.eta_s !== undefined && params.eta_s !== null) {
      if (typeof params.eta_s !== "number" || !Number.isInteger(params.eta_s) || params.eta_s < 1 || params.eta_s > LIMITS.wakeEtaMaxS)
        throw new RelayError("invalid_params", `eta_s is a whole number of seconds from 1 to ${LIMITS.wakeEtaMaxS}`)
      eta = params.eta_s
    }
    if (wake !== "none" && options.known && !options.known(wake)) throw new RelayError("invalid_params", `no waker ${wake} is configured`)
    return { wake, ref, eta }
  }

  /** a provider's opaque reference to a session: at most LIMITS.wakeRefChars characters, no control characters, no credential */
  private wakeRef(value: unknown): string {
    if (typeof value !== "string" || value.length > LIMITS.wakeRefChars || /[\u0000-\u001f\u007f]/.test(value))
      throw new RelayError("invalid_params", `ref is a string of at most ${LIMITS.wakeRefChars} characters with no control characters`)
    if (findSecret(value)) throw new RelayError("secret_refused", "the wake ref looks like it carries a credential")
    return value
  }

  private setHibernation(me: EndpointRow, target: EndpointRow, set: { wake: string; ref: string | null; eta: number | null }): EndpointView {
    const address = this.address(target)
    if (set.wake === "none") {
      if (target.hibernate !== null) {
        this.clearHibernation(target.id)
        this.audit("unhibernate", target.id, null, { by: this.address(me), target: address })
      }
      return this.view(this.byId(target.id)!)
    }
    this.clearHibernation(target.id)
    this.sql.all(
      `UPDATE endpoints SET hibernate = ?, wake_ref = ?, wake_eta = ?, hibernated_at = ?, hold_ref = NULL WHERE id = ?`,
      set.wake,
      set.ref,
      set.eta,
      this.now(),
      target.id,
    )
    this.audit("hibernate", target.id, null, { by: this.address(me), target: address, provider: set.wake })
    return this.view(this.byId(target.id)!)
  }

  /**
   * the held spawn `endpoint` whose holding connection closed without a hibernate or spawn_end, or, with none named (the broker starting after
   * a crash or reboot), every endpoint a durable spawn held: hibernated by the built-in provider {@link SPAWN_PROVIDER} with the spawn's durable
   * ref, audited `hibernate {by: "broker"}`. The endpoints it hibernated
   */
  hibernateHeld(endpoint?: string): EndpointView[] {
    return this.tx(() => {
      const rows = this.sql.all<EndpointRow>(
        `SELECT * FROM endpoints WHERE kind = 'agent' AND hold_ref IS NOT NULL AND hibernate IS NULL AND wakers <= 1 AND (? IS NULL OR id = ?) ORDER BY handle`,
        endpoint ?? null,
        endpoint ?? null,
      )
      return rows
        .filter((row) => this.localRow(row))
        .map((row) => {
          this.clearHibernation(row.id)
          this.sql.all(
            `UPDATE endpoints SET hibernate = ?, wake_ref = hold_ref, hold_ref = NULL, hibernated_at = ? WHERE id = ?`,
            SPAWN_PROVIDER,
            this.now(),
            row.id,
          )
          this.audit("hibernate", row.id, null, { by: "broker", target: this.address(row), provider: SPAWN_PROVIDER })
          return this.view(this.byId(row.id)!)
        })
    })
  }

  /**
   * the wake hook run a delivery to a hibernated local agent is due, recorded as tried: none while it is not hibernated, has no unread
   * message, ran within LIMITS.wakeDebounceS (after failures, a doubling backoff up to LIMITS.wakeBackoffMaxS), or the provider declined a
   * wake for the newest unread message or for another from its sender. The newest unread message's metadata only, never its body
   */
  wakeDue(endpoint: string, now = this.now()): WakeJob | null {
    const row = this.byId(endpoint)
    if (!row?.hibernate || row.kind !== "agent" || !this.localRow(row)) return null
    if (row.wake_tried !== null) {
      const waitS = row.wake_fails > 0 ? Math.min(LIMITS.wakeDebounceS * 2 ** row.wake_fails, LIMITS.wakeBackoffMaxS) : LIMITS.wakeDebounceS
      if (now - row.wake_tried < waitS * 1000) return null
    }
    const newest = one<{ id: string; from_ep: string; kind: MessageKind; thread: string; created_at: number }>(
      this.sql,
      `SELECT m.id, m.from_ep, m.kind, m.thread, m.created_at FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ? ORDER BY d.seq DESC LIMIT 1`,
      endpoint,
      now,
    )
    if (!newest) return null
    if (row.wake_declined !== null && (newest.id === row.declined_message || newest.from_ep === row.declined_from)) return null
    const unread = one<{ n: number }>(
      this.sql,
      `SELECT COUNT(*) AS n FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ?`,
      endpoint,
      now,
    )!.n
    const ticket = row.hibernate === SPAWN_PROVIDER ? `kwt_${randomHex(32)}` : undefined
    this.sql.all(`UPDATE endpoints SET wake_tried = ?, wake_ticket = ? WHERE id = ?`, now, ticket ? this.hash(ticket) : null, endpoint)
    const sender = this.byId(newest.from_ep)
    return {
      endpoint,
      address: this.address(row),
      handle: row.handle,
      provider: row.hibernate,
      ref: row.wake_ref,
      message: { id: newest.id, from: sender ? this.address(sender) : null, kind: newest.kind, thread: newest.thread, created_at: iso(newest.created_at)! },
      unread,
      ...(ticket ? { ticket } : {}),
    }
  }

  /**
   * how a wake hook run ended, audited without the ref: a failure counts toward the backoff and shows `wake_failed` while the message stays
   * queued; a decline (`declined`, for the message `message`) shows `wake_declined`, counts toward nothing and holds further runs for that
   * message and its sender until a newer message of another sender or a new hibernate; a success resets both (the hibernation clears once the
   * session claims its endpoint again). Whether the shown note changed
   */
  wakeResult(
    endpoint: string,
    result: { ok: boolean; code?: number | null; error?: string | null; ms: number; declined?: WakeDecline; message?: string },
  ): boolean {
    const row = this.byId(endpoint)
    if (!row) return false
    const error = result.error ? redactSecrets(stripControl(result.error).replace(/\s+/g, " ").trim()).slice(0, 200) : null
    const declined = result.ok ? null : wakeDeclineOf(result.declined)
    this.audit("wake", endpoint, null, {
      target: this.address(row),
      provider: row.hibernate,
      ok: result.ok,
      ...(result.code !== undefined && result.code !== null ? { code: result.code } : {}),
      ms: Math.max(0, Math.round(result.ms)),
      ...(declined ? { declined } : error ? { error } : {}),
    })
    if (!row.hibernate) return false
    if (declined) {
      const message = result.message ? one<{ from_ep: string }>(this.sql, `SELECT from_ep FROM messages WHERE id = ?`, result.message) : undefined
      this.sql.all(
        `UPDATE endpoints SET wake_declined = ?, declined_message = ?, declined_from = ?, wake_note = NULL, wake_tried = NULL WHERE id = ?`,
        declined,
        result.message ?? null,
        message?.from_ep ?? null,
        endpoint,
      )
      return declined !== row.wake_declined || row.wake_note !== null
    }
    const note = result.ok
      ? null
      : `wake_failed: ${(error ?? (result.code !== undefined && result.code !== null ? `exit ${result.code}` : "failed")).slice(0, 120)}`
    this.sql.all(
      `UPDATE endpoints SET wake_fails = ${result.ok ? "0" : "wake_fails + 1"}, wake_note = ?, wake_declined = NULL, declined_message = NULL, declined_from = NULL WHERE id = ?`,
      note,
      endpoint,
    )
    return note !== row.wake_note || row.wake_declined !== null
  }

  /** whether the row shows hibernated: a subclass also counts what another machine mirrored */
  protected hibernated(row: EndpointRow): boolean {
    return row.hibernate !== null
  }

  /** the hibernated session is back, or gone: its hibernation clears */
  private wakeDone(endpoint: string, how: string): void {
    const row = this.byId(endpoint)
    if (!row?.hibernate) return
    this.clearHibernation(endpoint)
    this.audit("wake_done", endpoint, null, { target: this.address(row), how })
  }

  private clearHibernation(endpoint: string): void {
    this.sql.all(
      `UPDATE endpoints SET hibernate = NULL, wake_ref = NULL, wake_eta = NULL, hibernated_at = NULL, wake_tried = NULL, wake_fails = 0, wake_note = NULL,
       wake_declined = NULL, declined_message = NULL, declined_from = NULL, wake_ticket = NULL WHERE id = ?`,
      endpoint,
    )
  }

  // messages

  /**
   * `origin.tty` is recorded on messages the human inbox sends: whether its client said a terminal was attached. `origin.unverified`: the human
   * sends without a terminal, so the scopes check it like any unplaced sender
   */
  send(from: string, params: SendParams, origin: { tty?: boolean; unverified?: boolean; link?: "session" | "self" } = {}): SendResult {
    if ("link" in params) throw new RelayError("invalid_params", "link is set by the relay, not the sender")
    const sender = this.mustEndpoint(from)
    const senderTty = sender.kind === "human" ? (origin.tty === true ? 1 : 0) : null
    const unverified = sender.kind === "human" && origin.unverified === true
    const now = this.now()
    const clientId = cleanText(params.client_id, "client_id", 128)
    if (typeof params.body !== "string") throw new RelayError("invalid_params", "body must be a string")
    const bytes = utf8Bytes(params.body)
    if (bytes > LIMITS.bodyBytes) throw new RelayError("too_large", `the body is ${bytes} bytes, more than ${LIMITS.bodyBytes}`)
    const kind = params.kind ?? "message"
    if (!MESSAGE_KINDS.includes(kind)) throw new RelayError("invalid_params", `kind must be one of ${MESSAGE_KINDS.join(", ")}`)
    const dataClass = params.data_class ?? "public"
    if (dataClass !== "public" && dataClass !== "private") throw new RelayError("invalid_params", "data_class must be public or private")
    if (params.require_reply !== undefined && typeof params.require_reply !== "boolean")
      throw new RelayError("invalid_params", "require_reply must be true or false")
    if (params.require_reply === true && kind !== "request") throw new RelayError("invalid_params", "require_reply goes only on a request (swarm ask)")
    const mime = cleanText(params.mime, "mime", 64) ?? "text/markdown"
    const ttl = params.ttl_s ?? LIMITS.ttlDefaultS
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > LIMITS.ttlMaxS) throw new RelayError("invalid_params", `ttl_s must be 1 to ${LIMITS.ttlMaxS}`)
    const attachments = params.attachments ?? []
    if (!Array.isArray(attachments) || attachments.length > LIMITS.attachments)
      throw new RelayError("invalid_params", `at most ${LIMITS.attachments} attachments`)
    for (const attachment of attachments) {
      if (attachment?.kind !== "path" || typeof attachment.path !== "string" || !attachment.path.startsWith("/")) {
        throw new RelayError("invalid_params", "an attachment is {kind: path, path: an absolute path}")
      }
    }
    const secret = findSecret(params.body) ?? attachments.map((a) => findSecret(a.path)).find(Boolean) ?? null
    if (secret) throw this.refuse(from, "secret_refused", `the message looks like it carries a credential (${secret}); send a reference instead`)

    const targets = Array.isArray(params.to) ? params.to : [params.to]
    if (targets.length < 1 || targets.length > LIMITS.recipients) throw new RelayError("invalid_params", `to takes 1 to ${LIMITS.recipients} addresses`)

    const parent = params.reply_to === undefined ? undefined : this.replyParent(from, params.reply_to)
    const fanOut: string[] = []
    const resolved: EndpointRow[] = []
    const unjoined = new Map<string, GrantRow>()
    for (const address of targets) {
      const text = typeof address === "string" ? address.trim() : address
      if (typeof text === "string" && (text.startsWith("group:") || text === "tree:children")) {
        resolved.push(...this.expand(sender, text, kind === "reply" ? parent : undefined))
        if (text.startsWith("group:")) fanOut.push(text.slice("group:".length))
        continue
      }
      const spawned = this.unjoinedTarget(sender, address, now)
      if (spawned) {
        unjoined.set(spawned.token_hash, spawned)
        continue
      }
      const row = this.resolve(address)
      this.checkScope(sender, row, String(text), kind === "reply" ? parent : undefined, unverified)
      resolved.push(row)
    }
    const recipients = [...new Map(resolved.map((row) => [row.id, row])).values()]
    if (params.live !== undefined && typeof params.live !== "boolean") throw new RelayError("invalid_params", "live must be true or false")
    const dark = recipients.filter(
      (r) =>
        r.kind === "agent" &&
        this.presence(r, now) === "offline" &&
        (now - Math.max(r.last_seen ?? 0, r.hook_seen ?? 0) >= ASK_ENDED_GRACE_MS || (r.session === null && r.token_hash === null && r.hook_ended !== null)) &&
        !this.unjoinedSpawn(sender, r.handle, now),
    )
    const asleep = params.live === true ? recipients.filter((r) => r.kind === "agent" && r.hibernate !== null) : []
    if (params.live === true && (dark.length || asleep.length))
      throw new RelayError("not_live", `no live session holds ${[...dark, ...asleep].map((r) => this.address(r)).join(", ")}: nothing was queued`)
    const warnings = dark.map((r) => `queued: no live session holds ${this.address(r)}`)
    const pending = [...unjoined.values()].map((grant) => ({ key: pendingKey(grant.token_hash), address: `${this.user}/${grant.name}` }))
    const reached = recipients.length + pending.length
    if (reached > LIMITS.fanOutTotal) throw new RelayError("too_large", `the send reaches ${reached} endpoints, more than ${LIMITS.fanOutTotal}`)
    if (
      origin.link &&
      (sender.kind !== "agent" ||
        kind !== "request" ||
        recipients.length !== 1 ||
        pending.length ||
        recipients[0]!.kind !== "agent" ||
        !this.localRow(recipients[0]!))
    )
      throw new RelayError("invalid_params", "a link request is from an agent to one local agent")
    const requestedThread = this.threadRef(from, cleanText(params.thread, "thread", 64))
    const payloadHash = this.hash(
      JSON.stringify([
        [...recipients.map((r) => r.id), ...pending.map((p) => p.key)].sort(),
        params.body,
        kind,
        requestedThread,
        parent?.id ?? null,
        dataClass,
        attachments.map((a) => a.path).sort(),
        mime,
        ttl,
        params.require_reply === true,
        ...(origin.link ? [origin.link] : []),
      ]),
    )
    if (clientId) {
      const seen = one<{ result: string; payload_hash: string; created_at: number }>(
        this.sql,
        `SELECT result, payload_hash, created_at FROM idempotency WHERE from_ep = ? AND client_id = ?`,
        from,
        clientId,
      )
      if (seen && seen.created_at >= now - LIMITS.idempotencyS * 1000) {
        if (seen.payload_hash !== payloadHash) throw new RelayError("invalid_params", `client_id ${clientId} was already used for a different message`)
        return { ...(JSON.parse(seen.result) as SendResult), duplicate: true }
      }
    }
    const addressed = [...recipients.map((row) => this.address(row)), ...pending.map((p) => p.address)]
    const thread = parent?.thread ?? requestedThread ?? newId("thr", now)
    const causal = sender.last_received_at !== null && sender.last_received_at >= now - LIMITS.causalWindowS * 1000 ? (sender.last_received_hop ?? 0) + 1 : 0
    const hop = senderTty === 1 && !this.capEverySender ? 0 : Math.max(parent ? parent.hop + 1 : 0, causal)
    if (hop > LIMITS.hopMax) {
      const chain = parent ? `this reply would be hop ${hop} of a reply chain` : `this message would be hop ${hop} of a chain of agent messages`
      throw this.refuse(
        from,
        "loop_guard",
        `${chain} (limit ${LIMITS.hopMax}): agents may be answering each other in a loop; stop and report to your user`,
        undefined,
        {
          to: addressed,
          hop,
          limit: LIMITS.hopMax,
          thread,
        },
      )
    }
    const inThread = one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM messages WHERE thread = ?`, thread)!.n
    if (inThread > 0 && !parent && !this.member(thread, from)) throw new RelayError("not_found", `no thread ${thread} to continue`)
    if (inThread >= LIMITS.threadMax)
      throw this.refuse(from, "loop_guard", `thread ${thread} reached ${LIMITS.threadMax} messages`, undefined, {
        to: addressed,
        limit: LIMITS.threadMax,
        thread,
      })
    const today = this.capEverySender
      ? sender.kind === "system"
        ? 0
        : one<{ n: number }>(
            this.sql,
            `SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND from_ep IN (SELECT id FROM endpoints WHERE kind != 'system')`,
            now - 86_400_000,
          )!.n
      : senderTty === 1
        ? 0
        : one<{ n: number }>(
            this.sql,
            `SELECT COUNT(*) AS n FROM messages WHERE created_at >= ? AND (from_ep IN (SELECT id FROM endpoints WHERE kind = 'agent') OR sender_tty = 0)`,
            now - 86_400_000,
          )!.n
    if (today >= LIMITS.userPerDay)
      throw this.refuse(from, "rate_limited", `${LIMITS.userPerDay} messages in the last day`, 3600, {
        to: addressed,
        limit: LIMITS.userPerDay,
        window_s: 86_400,
      })

    for (const recipient of recipients) {
      const pair = [this.address(sender), this.address(recipient)] as const
      const blocked = one<{ until: number }>(this.sql, `SELECT until FROM blocks WHERE pair = ? AND until > ?`, pairKey(from, recipient.id), now)
      if (blocked) {
        throw this.refuse(
          from,
          "loop_guard",
          `messages between ${pair[0]} and ${pair[1]} are paused: they went back and forth too often`,
          Math.ceil((blocked.until - now) / 1000),
          {
            to: [pair[1]],
            until: iso(blocked.until),
          },
        )
      }
      const retry = (first: number | null, windowS: number) => Math.max(1, Math.ceil(((first ?? now) + windowS * 1000 - now) / 1000))
      const burst = this.pairBurst(from, recipient.id, now)
      if (burst.n >= LIMITS.pairBurst) {
        const after = retry(burst.first, LIMITS.pairBurstWindowS)
        throw this.refuse(
          from,
          "rate_limited",
          `${burst.n + 1} messages between ${pair[0]} and ${pair[1]} in ${LIMITS.pairBurstWindowS} s (limit ${LIMITS.pairBurst}): pausing this pair; retry after ${after} s`,
          after,
          { to: [pair[1]], limit: LIMITS.pairBurst, window_s: LIMITS.pairBurstWindowS },
        )
      }
      for (const [limit, windowS] of [
        [LIMITS.pairPerMinute, 60],
        [LIMITS.pairPerHour, 3600],
      ] as const) {
        const recent = one<{ n: number; first: number | null }>(
          this.sql,
          `SELECT COUNT(*) AS n, MIN(at) AS first FROM pair_events WHERE from_ep = ? AND to_ep = ? AND at > ?`,
          from,
          recipient.id,
          now - windowS * 1000,
        )!
        if (recent.n >= limit) {
          const after = retry(recent.first, windowS)
          throw this.refuse(
            from,
            "rate_limited",
            `${recent.n + 1} messages from ${pair[0]} to ${pair[1]} in ${windowS} s (limit ${limit}): retry after ${after} s`,
            after,
            {
              to: [pair[1]],
              limit,
              window_s: windowS,
            },
          )
        }
      }
      const refusal = policyRefusal(this.policy, this.subject(sender), this.subject(recipient), this.policyBound)
      if (refusal) throw this.refuse(from, "policy_refused", `${refusal} (${pair[1]})`, undefined, { to: [pair[1]] })
      const firstReply =
        kind === "reply" &&
        parent?.from_ep === recipient.id &&
        one(this.sql, `SELECT 1 FROM deliveries WHERE message_id = ? AND endpoint = ?`, parent.id, from) !== undefined &&
        one(this.sql, `SELECT 1 FROM messages WHERE reply_to = ? AND from_ep = ? AND kind = 'reply'`, parent.id, from) === undefined
      if (!firstReply) {
        const unacked = one<{ n: number }>(
          this.sql,
          `SELECT COUNT(*) AS n FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ?`,
          recipient.id,
          now,
        )!.n
        if (unacked >= LIMITS.inboxMax)
          throw this.refuse(from, "inbox_full", `${pair[1]} has ${unacked} unread messages`, undefined, { to: [pair[1]], limit: LIMITS.inboxMax })
      }
    }
    for (const { key, address } of pending) {
      const unacked = one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM deliveries WHERE endpoint = ? AND expires_at > ?`, key, now)!.n
      if (unacked >= LIMITS.inboxMax)
        throw this.refuse(from, "inbox_full", `${address} has ${unacked} messages waiting for it to join`, undefined, { to: [address], limit: LIMITS.inboxMax })
    }
    const treeSends = sender.kind === "agent" ? recipients.filter((r) => r.kind !== "human").length + pending.length : 0
    const tree = sender.tree ?? sender.id
    if (treeSends) this.treeGuard(sender, tree, treeSends, now, addressed)
    for (const name of fanOut) {
      const recent = one<{ n: number; first: number | null }>(
        this.sql,
        `SELECT COUNT(*) AS n, MIN(at) AS first FROM tree_events WHERE tree = ? AND at > ?`,
        `group:${name}`,
        now - 60_000,
      )!
      if (recent.n >= LIMITS.groupPerMinute) {
        throw this.refuse(
          from,
          "rate_limited",
          `${LIMITS.groupPerMinute} messages to group:${name} in 60 s`,
          Math.max(1, Math.ceil(((recent.first ?? now) + 60_000 - now) / 1000)),
          {
            to: [`group:${name}`],
            limit: LIMITS.groupPerMinute,
            window_s: 60,
          },
        )
      }
    }

    const result = this.tx(() => {
      const id = newId("msg", now)
      const expires = now + ttl * 1000
      const to = targets.length === 1 ? String(targets[0]) : targets.join(",")
      this.sql.all(
        `INSERT INTO messages (id, thread, reply_to, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at, sender_tty, require_reply, link_parent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        thread,
        parent?.id ?? null,
        kind,
        from,
        to,
        params.body,
        mime,
        dataClass,
        JSON.stringify(attachments.map((a) => ({ kind: "path", path: a.path }))),
        hop,
        now,
        expires,
        senderTty,
        params.require_reply === true ? 1 : null,
        origin.link ? this.address(sender) : null,
      )
      if (parent) this.sql.all(`UPDATE deliveries SET acked_at = ? WHERE message_id = ? AND endpoint = ? AND acked_at IS NULL`, now, parent.id, from)
      const deliveries: SendResult["deliveries"] = []
      for (const recipient of recipients) {
        const seq = this.insertDelivery(id, recipient.id, expires)
        this.sql.all(`INSERT INTO pair_events (from_ep, to_ep, at) VALUES (?, ?, ?)`, from, recipient.id, now)
        if (treeSends && recipient.kind !== "human") this.sql.all(`INSERT INTO tree_events (tree, at) VALUES (?, ?)`, tree, now)
        const view = this.view(recipient)
        const hibernated = view.presence === "hibernated"
        const queued = view.presence === "offline" || hibernated
        const offline = view.presence === "offline" && now - Math.max(recipient.last_seen ?? 0, recipient.hook_seen ?? 0) >= ASK_ENDED_GRACE_MS
        const state = this.reach(sender, recipient, offline, now)
        const woken = state === "running" && recipient.status_state === "done"
        deliveries.push({
          endpoint: recipient.id,
          address: view.address,
          seq,
          offline,
          ...(queued ? { queued } : {}),
          last_seen: view.last_seen,
          ...(state ? { state } : {}),
          ...(hibernated && recipient.wake_declined ? { wake: "declined" as const } : view.wake ? { wake: view.wake } : {}),
          ...(view.presence === "idle" || woken ? { idle: true as const } : {}),
          ...(hibernated ? { hibernated: true as const } : {}),
          ...(hibernated && recipient.wake_eta ? { wake_eta_s: recipient.wake_eta } : {}),
        })
      }
      for (const { key, address } of pending) {
        const seq = this.insertDelivery(id, key, expires)
        if (treeSends) this.sql.all(`INSERT INTO tree_events (tree, at) VALUES (?, ?)`, tree, now)
        deliveries.push({ endpoint: key, address, seq, offline: false, queued: true, last_seen: null, state: "starting" })
      }
      for (const name of fanOut) this.sql.all(`INSERT INTO tree_events (tree, at) VALUES (?, ?)`, `group:${name}`, now)
      const sent: SendResult = { id, thread, hop, deliveries, ...(warnings.length ? { warnings } : {}) }
      if (clientId) {
        this.sql.all(
          `INSERT OR REPLACE INTO idempotency (from_ep, client_id, payload_hash, result, created_at) VALUES (?, ?, ?, ?, ?)`,
          from,
          clientId,
          payloadHash,
          JSON.stringify(sent),
          now,
        )
      }
      this.audit("send", from, id, { to: deliveries.map((d) => d.address), kind, bytes, hop, thread, data_class: dataClass })
      if (origin.link)
        this.audit("adopt_request", from, id, {
          by: this.address(sender),
          auth: origin.link,
          target: this.address(recipients[0]!),
          parent: this.address(sender),
        })
      for (const recipient of recipients) this.detectPingPong(sender, recipient)
      return sent
    })
    return result
  }

  /** a local agent recipient's {@link Reach} for a send from `sender`; none for a human, the relay or another machine's row */
  private reach(sender: EndpointRow, recipient: EndpointRow, offline: boolean, now: number): Reach | undefined {
    if (recipient.kind !== "agent" || !this.localRow(recipient)) return undefined
    const done = recipient.status_state === "done"
    if ((done || this.presence(recipient, now) === "offline") && this.unjoinedSpawn(sender, recipient.handle, now)) return "starting"
    if (done) return this.rootWake(recipient, now) ? "running" : "ended"
    return offline ? "offline" : "running"
  }

  /**
   * the newest `swarm spawn` grant `sender` issued for `handle` that no harness has joined with yet, while it may still be: unspent, unrevoked,
   * unexpired and its spawn process not gone
   */
  private unjoinedSpawn(sender: EndpointRow, handle: string, now: number): GrantRow | undefined {
    const grant = one<GrantRow>(
      this.sql,
      `SELECT * FROM grants WHERE issuer = ? AND name = ? AND spawn = 1 AND used_by IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
      sender.id,
      handle,
      now,
    )
    const pid = Number(/^pid:(\d+):/.exec(grant?.bound_process ?? "")?.[1])
    return grant && !(pid && !this.alive(pid)) ? grant : undefined
  }

  /**
   * the `swarm spawn` grant behind a local address no endpoint holds yet, when `sender` issued it and its harness has not joined
   * ({@link unjoinedSpawn}): a send waits there under {@link pendingKey} until the claim that spends it takes it ({@link takePending})
   */
  private unjoinedTarget(sender: EndpointRow, address: unknown, now: number): GrantRow | undefined {
    if (typeof address !== "string") return undefined
    const text = address.trim()
    const slash = text.indexOf("/")
    const handle = text.slice(slash + 1)
    if ((slash !== -1 && !["me", this.user].includes(text.slice(0, slash))) || !validHandle(handle) || this.byHandle(handle)) return undefined
    return this.unjoinedSpawn(sender, handle, now)
  }

  /**
   * the messages a spawner sent its spawn before it joined pass to the endpoint that spent the grant, each checked against the policy now
   * that the endpoint has a subject: one it refuses is dropped, audited for the spawner
   */
  private takePending(endpoint: string): void {
    for (const grant of this.sql.all<{ token_hash: string; issuer: string }>(
      `SELECT token_hash, issuer FROM grants WHERE used_by = ? AND spawn = 1`,
      endpoint,
    )) {
      const seqs = this.sql
        .all<{ seq: number }>(`UPDATE deliveries SET endpoint = ? WHERE endpoint = ? RETURNING seq`, endpoint, pendingKey(grant.token_hash))
        .map((row) => row.seq)
      const issuer = this.byId(grant.issuer)
      const row = this.byId(endpoint)!
      const refusal = seqs.length && issuer ? policyRefusal(this.policy, this.subject(issuer), this.subject(row), this.policyBound) : null
      if (!refusal) continue
      for (const seq of seqs) this.sql.all(`DELETE FROM deliveries WHERE seq = ?`, seq)
      this.audit("refuse", issuer!.id, null, {
        code: "policy_refused",
        message: `${refusal} (${this.address(row)})`,
        to: [this.address(row)],
        dropped: seqs.length,
      })
    }
  }

  /**
   * the oldest unacked deliveries after the cursor, and those a background hook showed in the last ${LIMITS.deferredShowS} s whose showing has
   * not settled ({@link injected}), with `shown_at`: the harness may hand the agent that hook's text only after this call; reading counts as
   * receiving for the causal hop
   */
  inbox(endpoint: string, options: { after?: number | undefined; limit?: number | undefined } = {}): Envelope[] {
    const now = this.now()
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? LIMITS.inboxPage)), LIMITS.inboxPage)
    const rows = this.sql.all<MessageRow & { seq: number; deferred_at: number | null; acked_at: number | null }>(
      `SELECT m.*, d.seq AS seq, d.deferred_at AS deferred_at, d.acked_at AS acked_at FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.endpoint = ? AND (d.acked_at IS NULL OR d.deferred_at > ?) AND d.expires_at > ? AND d.seq > ?
       ORDER BY d.seq LIMIT ?`,
      endpoint,
      now - LIMITS.deferredShowS * 1000,
      now,
      Math.max(0, Math.floor(options.after ?? 0)),
      limit,
    )
    this.received(endpoint, rows, now)
    return rows.map((row) => {
      const envelope = this.envelope(row, row.seq)
      return row.acked_at !== null && row.deferred_at !== null ? { ...envelope, shown_at: new Date(row.deferred_at).toISOString() } : envelope
    })
  }

  /**
   * A channel push's page: the oldest unacked deliveries no hook showed or holds, held from the hooks for ${LIMITS.injectHoldS} s under `hold`
   * until {@link injected} confirms them; reading counts as receiving for the causal hop. With `subagents` (the root's waker asks), also those
   * to its idle in-process subagents, tagged `for` the subagent and without a relation: confirming marks them injected, never read, so they stay
   * in the subagent's inbox while no hook of it shows them again
   */
  offer(endpoint: string, options: { limit?: number; subagents?: boolean } = {}): { messages: Envelope[]; hold: string | null } {
    const now = this.now()
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? LIMITS.inboxPage)), LIMITS.inboxPage)
    const subagents = options.subagents ? this.idleSubagents(endpoint, now) : new Map<string, NonNullable<Envelope["for"]>>()
    const ids = [endpoint, ...subagents.keys()]
    const rows = this.sql.all<MessageRow & { seq: number; delivered_to: string }>(
      `SELECT m.*, d.seq AS seq, d.endpoint AS delivered_to FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.endpoint IN (${ids.map(() => "?").join(", ")}) AND d.acked_at IS NULL AND d.expires_at > ? AND d.injected_at IS NULL
       AND (d.offered_until IS NULL OR d.offered_until <= ?)
       ORDER BY d.seq LIMIT ?`,
      ...ids,
      now,
      now,
      limit,
    )
    const hold = this.hold(
      rows.map((row) => row.seq),
      now,
    )
    this.received(endpoint, rows, now)
    for (const id of subagents.keys())
      this.received(
        id,
        rows.filter((row) => row.delivered_to === id),
        now,
      )
    const messages = rows.map((row) => {
      const envelope = this.envelope(row, row.seq)
      const tag = subagents.get(row.delivered_to)
      if (!tag) return envelope
      const { relation: _relation, parent_key: _key, ...rest } = envelope
      return { ...rest, for: tag }
    })
    return { messages, hold }
  }

  /** the root's idle (`done`) in-process subagents its waker is offered messages for ({@link rootWake}), with their tags */
  private idleSubagents(root: string, now: number): Map<string, NonNullable<Envelope["for"]>> {
    const tags = new Map<string, NonNullable<Envelope["for"]>>()
    for (const row of this.sql.all<EndpointRow>(
      `SELECT * FROM endpoints WHERE parent_ep = ? AND kind = 'agent' AND status_state = 'done' AND substr(session, 1, 4) = 'sub:'`,
      root,
    )) {
      const wake = this.rootWake(row, now)
      if (wake) tags.set(row.id, { address: this.address(row), subagent: wake.id })
    }
    return tags
  }

  /**
   * The unread deliveries no hook has shown the agent yet, oldest first: up to ${LIMITS.injectMessages} whose wrapped text fits in
   * ${LIMITS.injectBytes} bytes, the rest counted in `more` and left for a later hook, and one too big for any hook counted once. `offered` holds
   * their seqs, held from other hooks for ${LIMITS.injectHoldS} s under `hold`: the hook confirms them with {@link injected} once it printed them,
   * else they are offered again. A stop, or a call with `count`, offers nothing and only counts what is unread and, in `awaiting`, the
   * require_reply requests it has not replied to, read or not; a `count` also says in `waiting` how many unread no hook has shown or holds, so a
   * hook recounts its `more` after another hook's offer. A stop is `forced` while `awaiting` (or, with `holdUnread`, the unread count) is
   * above zero and fewer than ${LIMITS.stopBlocks} printed holds ({@link stopHeld}) since the session started; it also lists in `nudge` the other
   * requests it has not replied to and no hook nudged about ({@link nudged}), up to ${LIMITS.injectMessages}, the rest counted in `nudge_more`.
   * `block` says whether to keep the agent from stopping: forced, or with a nudge. A stop also counts its live spawned `workers` and the
   * `worker_unread` messages {@link stopWait} would show, and with either, the `pushes_left` of the prompt's, the `prompts` mark its wait
   * passes on and `wakeable` when a message wakes the endpoint anyway ({@link wakes}), so the stop need not wait. A stop that asks for `directives` is also held, fewer than ${LIMITS.directiveHolds} times a session ({@link restated}), for its
   * parent's messages the agent may not have seen ({@link lateDirectives}): shown and offered within ${LIMITS.pushBytes} bytes, all their seqs in
   * `directive_seqs`. Any call says `brief` once the session was shown the full preamble ({@link briefed}), and one that is no stop names in
   * `intro` the spawner of an endpoint a `swarm spawn` grant placed, with the grant's steer key in `intro_key`, until a hook showed it
   * ({@link introduced}). A hook of another process than the one holding the endpoint (a child that inherited the session key) gets nothing.
   * A wake also offers live workers' messages.
   */
  inject(
    endpoint: string,
    options: { stop?: boolean; count?: boolean; holdUnread?: boolean; directives?: boolean; transient?: boolean; process?: string; wake?: boolean } = {},
  ): {
    messages: Envelope[]
    offered: number[]
    hold: string | null
    more: number
    unread: number
    waiting?: number
    block: boolean
    forced?: boolean
    awaiting?: number
    nudge?: StopNudge[]
    nudge_more?: number
    workers?: number
    worker_unread?: number
    pushes_left?: number
    prompts?: number
    wakeable?: true
    brief?: true
    intro?: string
    intro_key?: string
    directives?: Envelope[]
    directive_seqs?: number[]
  } {
    const now = this.now()
    const me = this.mustEndpoint(endpoint)
    if (!this.holds(me, options)) return { messages: [], offered: [], hold: null, more: 0, unread: 0, block: false }
    const brief = me.briefed ? { brief: true as const } : {}
    const spawner = options.stop === true || me.introduced ? undefined : this.spawnerOf(me, now)
    const intro = spawner ? { intro: this.address(spawner.row), ...(spawner.steer ? { intro_key: spawner.steer } : {}) } : {}
    const live = `d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ?`
    const fresh = `${live} AND d.injected_at IS NULL AND (d.offered_until IS NULL OR d.offered_until <= ?)`
    const unread = one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM deliveries d WHERE ${live}`, endpoint, now)!.n
    if (options.stop === true || options.count === true) {
      const awaiting = one<{ n: number }>(
        this.sql,
        `SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.endpoint = ? AND d.expires_at > ? AND m.require_reply = 1
         AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.from_ep = d.endpoint AND r.kind = 'reply')`,
        endpoint,
        now,
      )!.n
      if (options.stop !== true) {
        const waiting = one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM deliveries d WHERE ${fresh}`, endpoint, now, now)!.n
        return { messages: [], offered: [], hold: null, more: 0, unread, waiting, block: false, ...(awaiting ? { awaiting } : {}), ...brief, ...intro }
      }
      const forced = (awaiting > 0 || (options.holdUnread === true && unread > 0)) && (me.stop_blocks ?? 0) < LIMITS.stopBlocks
      const asked = `FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.endpoint = ? AND d.expires_at > ? AND d.nudged_at IS NULL AND m.kind = 'request' AND COALESCE(m.require_reply, 0) <> 1
         AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.from_ep = d.endpoint AND r.kind = 'reply')`
      const total = one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n ${asked}`, endpoint, now)!.n
      const nudge = this.sql
        .all<{ seq: number; id: string; from_ep: string; acked_at: number | null }>(
          `SELECT d.seq, m.id, m.from_ep, d.acked_at ${asked} ORDER BY d.seq LIMIT ?`,
          endpoint,
          now,
          LIMITS.injectMessages,
        )
        .map((row) => ({ seq: row.seq, from: this.addressOf(row.from_ep), id: row.id, unread: row.acked_at === null }))
      const { workers, starting } = this.liveWorkers(me, now)
      const fromWorkers = this.workerUnread(me, now, true)
      const late = options.directives === true && (me.directive_holds ?? 0) < LIMITS.directiveHolds ? this.lateDirectives(me, now) : []
      const { shown, offered } = this.budget(late, LIMITS.pushBytes)
      const hold = this.hold(offered, now)
      this.received(endpoint, shown, now)
      return {
        messages: [],
        offered,
        hold,
        more: 0,
        unread,
        block: forced || nudge.length > 0 || late.length > 0,
        forced,
        ...(awaiting ? { awaiting } : {}),
        ...(nudge.length ? { nudge } : {}),
        ...(total > nudge.length ? { nudge_more: total - nudge.length } : {}),
        ...(workers.length + starting ? { workers: workers.length + starting } : {}),
        ...(fromWorkers ? { worker_unread: fromWorkers } : {}),
        ...(workers.length + starting + fromWorkers
          ? { pushes_left: this.pushesLeft(me), prompts: me.prompts ?? 0, ...(wakes(me) ? { wakeable: true as const } : {}) }
          : {}),
        ...(late.length ? { directives: shown.map((row) => this.envelope(row, row.seq)), directive_seqs: late.map((row) => row.seq) } : {}),
        ...brief,
      }
    }
    const waiting = one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM deliveries d WHERE ${fresh}`, endpoint, now, now)!.n
    const rows = this.sql.all<MessageRow & { seq: number }>(
      `SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE ${fresh} ORDER BY d.seq LIMIT ?`,
      endpoint,
      now,
      now,
      LIMITS.inboxPage,
    )
    const { shown, offered } = this.budget(rows, LIMITS.injectBytes, options.wake ? undefined : () => this.pushable(me, now))
    const hold = this.hold(offered, now)
    this.received(endpoint, shown, now)
    return { messages: shown.map((row) => this.envelope(row, row.seq)), offered, hold, more: waiting - shown.length, unread, block: false, ...brief, ...intro }
  }

  /**
   * the parent's messages to `me` a stop restates, oldest first: not restated yet and either unread or injected at or after its last tool
   * event, whose hook context may never reach the model before it ends; one injected before a later tool event was seen
   */
  private lateDirectives(me: EndpointRow, now: number): (MessageRow & { seq: number })[] {
    const tool =
      one<{ at: number | null }>(this.sql, `SELECT MAX(at) AS at FROM activity WHERE endpoint = ? AND kind = 'tool' AND agent IS NULL`, me.id)!.at ?? 0
    const steered = this.steerIssuers(me)
    const senders = steered.length
      ? steered
      : [
          ...new Set([
            ...this.ancestorsOf(me),
            ...this.sql.all<{ issuer: string }>(`SELECT issuer FROM grants WHERE used_by = ? AND revoked_at IS NULL`, me.id).map((row) => row.issuer),
          ]),
        ]
    if (!senders.length) return []
    const rows = this.sql.all<MessageRow & { seq: number }>(
      `SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.endpoint = ? AND d.expires_at > ? AND d.restated_at IS NULL AND (d.acked_at IS NULL OR d.injected_at >= ?)
       AND m.from_ep IN (${senders.map(() => "?").join(", ")}) ORDER BY d.seq LIMIT ?`,
      me.id,
      now,
      tool,
      ...senders,
      LIMITS.inboxPage,
    )
    return rows.filter((row) => this.kinship(this.byId(row.from_ep), me, row.created_at).relation === "parent")
  }

  /** the agent whose unrevoked `swarm spawn` grant `me` spent, while it stands to `me` as its parent, and that grant's steer key */
  private spawnerOf(me: EndpointRow, now: number): { row: EndpointRow; steer: string | null } | undefined {
    const grant = one<{ issuer: string; steer: string | null }>(
      this.sql,
      `SELECT issuer, steer FROM grants WHERE used_by = ? AND spawn = 1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      me.id,
    )
    const issuer = grant ? this.byId(grant.issuer) : undefined
    return issuer && this.kinOf(issuer, me, now) === "parent" ? { row: issuer, steer: grant!.steer } : undefined
  }

  /**
   * up to ${LIMITS.injectMessages} rows, oldest first, whose wrapped text fits in `bytes`; `offered` adds each one too big for this hook, shown
   * never, except one among `pushable` that fits a stop's push, left unoffered for {@link stopWait} to show whole
   */
  private budget(
    rows: (MessageRow & { seq: number })[],
    bytes: number,
    pushable?: () => Set<number>,
  ): { shown: (MessageRow & { seq: number })[]; offered: number[] } {
    const shown: (MessageRow & { seq: number })[] = []
    const offered: number[] = []
    let used = 0
    let push: Set<number> | undefined
    for (const row of rows) {
      const size = utf8Bytes(wrapMessage(this.envelope(row, row.seq)))
      if (size > bytes) {
        if (pushable && size <= LIMITS.pushBytes) {
          push ??= pushable()
          if (push.has(row.seq)) continue
        }
        offered.push(row.seq)
        continue
      }
      if (shown.length >= LIMITS.injectMessages || used + size > bytes) break
      shown.push(row)
      offered.push(row.seq)
      used += size
    }
    return { shown, offered }
  }

  /**
   * A stop that waits on spawned workers: their unread messages no hook has shown or holds, and the relay's handbacks about them (a `worker `
   * notice from the relay), held like {@link inject}'s within ${LIMITS.pushBytes} bytes of wrapped text, the rest counted in `more`; the live
   * workers ({@link liveWorkers}) by address and those not joined yet in `starting`. With a worker's message to show, the other unread
   * messages no hook has shown or holds follow theirs ({@link pushOthers}), `others_shown` of them, held with them; `others` counts the other
   * unread ones left. A live worker's messages wait ${LIMITS.pushGapS} s after a push showed one of its own ({@link pushed}), and with no
   * push left since the last prompt nothing is shown. `prompted` says a prompt came since inject handed out the `prompts` mark, `wakeable` that
   * a message wakes the endpoint anyway ({@link wakes}), which ends a wait. A hook of
   * another process than the one holding the endpoint gets nothing. `peek`: the same answer, nothing held (`hold` null) or marked received.
   */
  stopWait(endpoint: string, options: { transient?: boolean; process?: string; prompts?: number; peek?: boolean } = {}): StopWaitResult {
    const now = this.now()
    const me = this.mustEndpoint(endpoint)
    if (!this.holds(me, options)) return { messages: [], offered: [], hold: null, more: 0, workers: [], starting: 0, others: 0, pushes_left: 0 }
    const { workers, starting, paced } = this.liveWorkers(me, now)
    const live = this.liveWorkers(me, now, true)
    const background = [...live.workers.map((row) => this.address(row)), ...live.unjoined.filter(Boolean).map((name) => `me/${name}`)]
    const left = this.pushesLeft(me)
    const { where, params } = this.workerMessages(me, now, true, paced)
    const rows = left ? this.sql.all<MessageRow & { seq: number }>(`SELECT m.*, d.seq AS seq ${where} ORDER BY d.seq LIMIT ?`, ...params, LIMITS.inboxPage) : []
    const waiting = left ? one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n ${where}`, ...params)!.n : 0
    const unread = one<{ n: number }>(
      this.sql,
      `SELECT COUNT(*) AS n FROM deliveries d WHERE d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ?`,
      me.id,
      now,
    )!.n
    const { shown, offered } = this.budget(rows, LIMITS.pushBytes)
    const used = shown.reduce((sum, row) => sum + utf8Bytes(wrapMessage(this.envelope(row, row.seq))), 0)
    const others = rows.length ? this.pushOthers(me, now, LIMITS.pushBytes - used) : []
    const hold = options.peek ? null : this.hold([...offered, ...others.map((row) => row.seq)], now)
    if (!options.peek) this.received(endpoint, [...shown, ...others], now)
    return {
      messages: [...shown, ...others].map((row) => this.envelope(row, row.seq)),
      offered: [...offered, ...others.map((row) => row.seq)],
      hold,
      more: waiting - shown.length,
      workers: workers.map((row) => this.address(row)),
      starting,
      ...(background.length ? { background } : {}),
      others: unread - this.workerUnread(me, now, false) - others.length,
      ...(others.length ? { others_shown: others.length } : {}),
      pushes_left: left,
      ...(options.prompts !== undefined && options.prompts !== (me.prompts ?? 0) ? { prompted: true as const } : {}),
      ...(wakes(me) ? { wakeable: true as const } : {}),
      ...(me.briefed ? { brief: true as const } : {}),
    }
  }

  /**
   * the unread messages no hook has shown or holds that a push shows after its workers' ({@link pushable}): newest first, up to
   * ${LIMITS.injectMessages} whose wrapped text fits whole in `bytes`, in seq order
   */
  private pushOthers(me: EndpointRow, now: number, bytes: number): (MessageRow & { seq: number })[] {
    const workers = this.pushable(me, now)
    const rows = this.sql.all<MessageRow & { seq: number }>(
      `SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ? AND d.injected_at IS NULL AND (d.offered_until IS NULL OR d.offered_until <= ?)
       ORDER BY d.seq DESC LIMIT ?`,
      me.id,
      now,
      now,
      LIMITS.inboxPage,
    )
    const picked: (MessageRow & { seq: number })[] = []
    let left = bytes
    for (const row of rows) {
      if (picked.length >= LIMITS.injectMessages) break
      if (workers.has(row.seq)) continue
      const size = utf8Bytes(wrapMessage(this.envelope(row, row.seq)))
      if (size > left) continue
      picked.push(row)
      left -= size
    }
    return picked.reverse()
  }

  private pushesLeft(me: EndpointRow): number {
    return Math.max(0, LIMITS.pushes - (me.pushes ?? 0))
  }

  /**
   * a hook printed a push that continued the stop: it counts toward the ${LIMITS.pushes} since the last prompt, and the workers whose messages
   * among `read` it showed wait ${LIMITS.pushGapS} s before their next one does; whether it was counted
   */
  pushed(endpoint: string, read: unknown, options: { transient?: boolean; process?: string } = {}): boolean {
    const me = this.mustEndpoint(endpoint)
    if (!this.holds(me, options)) return false
    const counted =
      this.sql.all(`UPDATE endpoints SET pushes = COALESCE(pushes, 0) + 1 WHERE id = ? AND COALESCE(pushes, 0) < ? RETURNING id`, endpoint, LIMITS.pushes)
        .length > 0
    const now = this.now()
    for (const seq of seqList(read)) {
      this.sql.all(
        `UPDATE grants SET pushed_at = ? WHERE issuer = ? AND spawn = 1 AND used_by = (SELECT m.from_ep FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.seq = ? AND d.endpoint = ?)`,
        now,
        me.id,
        seq,
        endpoint,
      )
    }
    return counted
  }

  /** a hook saw the user submit a prompt: the push budget starts over and a stop waiting on workers ends; whether it counted */
  prompted(endpoint: string, options: { transient?: boolean; process?: string } = {}): boolean {
    if (!this.holds(this.mustEndpoint(endpoint), options)) return false
    this.sql.all(`UPDATE endpoints SET prompts = COALESCE(prompts, 0) + 1, pushes = 0 WHERE id = ?`, endpoint)
    this.settle(endpoint)
    return true
  }

  /** whether a prompt should remind the agent to refresh its status note: `every` prompts passed since the note or the last reminder; counts the reminder */
  tldrDue(endpoint: string, every: number): boolean {
    if (!Number.isInteger(every) || every <= 0) return false
    const row = this.mustEndpoint(endpoint)
    const turn = row.prompts ?? 0
    if (row.kind !== "agent" || turn - (row.tldr_turn ?? 0) < every) return false
    this.sql.all(`UPDATE endpoints SET tldr_turn = ? WHERE id = ?`, turn, endpoint)
    return true
  }

  /** the background hooks' showings ({@link injected}) older than ${LIMITS.deferredSettleMs} ms reached the agent: inbox no longer lists them */
  private settle(endpoint: string): void {
    this.sql.all(
      `UPDATE deliveries SET deferred_at = NULL WHERE endpoint = ? AND deferred_at IS NOT NULL AND deferred_at <= ?`,
      endpoint,
      this.now() - LIMITS.deferredSettleMs,
    )
  }

  /**
   * The endpoint's live spawned workers: its unrevoked spawn grants (minted by `swarm spawn` without --no-push, never by spawn-env) from its
   * current spawn that are either unspent and unexpired while their `swarm spawn` process runs (`starting`: the harness has not joined yet),
   * or spent by an endpoint whose status is not done and that is either not offline (by its hooks alone only while its harness process runs)
   * or kept by its `swarm spawn` process, which still runs without having handed back (as while it resumes a codex exec worker); `paced`
   * those a push showed a message from in the last ${LIMITS.pushGapS} s. A process runs while its pid does and, where its start time reads,
   * it started when its key says ({@link running}). spawn_exit marks a spender done and revokes an unspent grant, so a worker goes when its
   * harness exits, else when its presence lapses or its grant expires; an unspent grant whose `swarm spawn` pid is gone (killed before it
   * could report the exit) is revoked here.
   */
  private liveWorkers(me: EndpointRow, now: number, noPush = false): { workers: EndpointRow[]; starting: number; paced: string[]; unjoined: string[] } {
    const grants = this.sql.all<Pick<GrantRow, "token_hash" | "used_by" | "bound_process" | "pushed_at" | "handback" | "name">>(
      `SELECT token_hash, used_by, bound_process, pushed_at, handback, name FROM grants WHERE issuer = ? AND spawn = 1 AND no_push IS ${noPush ? "NOT NULL" : "NULL"} AND revoked_at IS NULL AND created_at >= ? AND (used_by IS NOT NULL OR expires_at > ?) ORDER BY created_at`,
      me.id,
      me.spawned_at ?? 0,
      now,
    )
    const workers = new Map<string, EndpointRow>()
    const paced = new Set<string>()
    const unjoined: string[] = []
    for (const grant of grants) {
      const pid = Number(/^pid:(\d+):/.exec(grant.bound_process ?? "")?.[1])
      if (grant.used_by === null) {
        if (pid && !this.alive(pid))
          this.sql.all(`UPDATE grants SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL AND used_by IS NULL`, now, grant.token_hash)
        else if (!pid || this.running(grant.bound_process!)) unjoined.push(grant.name ?? "")
        continue
      }
      const row = this.byId(grant.used_by)
      if (!row || row.status_state === "done") continue
      const harness = this.presence(row, now) !== "offline" && !(row.connections === 0 && row.process && this.localRow(row) && !this.running(row.process))
      if (!harness && (grant.handback !== null || !pid || !this.running(grant.bound_process!))) continue
      workers.set(row.id, row)
      if (grant.pushed_at !== null && grant.pushed_at > now - LIMITS.pushGapS * 1000) paced.add(row.id)
    }
    return { workers: [...workers.values()], starting: unjoined.length, paced: [...paced], unjoined }
  }

  /** whether the process of a harness-instance key runs: its pid does and, for a full key whose start time reads, it started then */
  private running(key: string): boolean {
    const match = /^pid:(\d+)(?::([A-Za-z0-9:-]+))?$/.exec(key)
    const pid = Number(match?.[1])
    if (!pid) return true
    if (!this.alive(pid)) return false
    const started = match![2] === undefined ? undefined : this.startOf?.(pid)
    return started === undefined || started === match![2]
  }

  /**
   * the unread deliveries to `me` from the endpoints that spent its spawn grants (while each held that grant) and the relay's `worker ` handbacks,
   * none of a no_push grant's; `fresh`: only those no hook has shown or holds; none from the `paced` endpoints
   */
  private workerMessages(me: EndpointRow, now: number, fresh: boolean, paced: string[] = []): { where: string; params: SqlValue[] } {
    const system = this.byHandle(SYSTEM_HANDLE)!.id
    return {
      where: `FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.endpoint = ? AND d.acked_at IS NULL AND d.expires_at > ?
        ${fresh ? "AND d.injected_at IS NULL AND (d.offered_until IS NULL OR d.offered_until <= ?)" : ""}
        ${paced.length ? `AND m.from_ep NOT IN (${paced.map(() => "?").join(", ")})` : ""}
        AND (EXISTS (SELECT 1 FROM grants g WHERE g.issuer = d.endpoint AND g.spawn = 1 AND g.no_push IS NULL AND g.used_by = m.from_ep AND g.created_at >= ?
          AND m.created_at >= g.created_at AND (g.revoked_at IS NULL OR m.created_at <= g.revoked_at))
          OR (m.from_ep = ? AND m.kind = 'message' AND m.body LIKE 'worker %' AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.handback = m.id AND g.no_push = 1)))`,
      params: [me.id, now, ...(fresh ? [now] : []), ...paced, me.spawned_at ?? 0, system],
    }
  }

  /** the seqs of the worker messages a stop's push would show ({@link workerMessages}, fresh) */
  private pushable(me: EndpointRow, now: number): Set<number> {
    const { where, params } = this.workerMessages(me, now, true)
    return new Set(this.sql.all<{ seq: number }>(`SELECT d.seq AS seq ${where}`, ...params).map((row) => row.seq))
  }

  private workerUnread(me: EndpointRow, now: number, fresh: boolean): number {
    const { where, params } = this.workerMessages(me, now, fresh)
    return one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n ${where}`, ...params)!.n
  }

  /** a hook printed a held stop: it counts toward the session's ${LIMITS.stopBlocks}; whether it was counted */
  stopHeld(endpoint: string, options: { transient?: boolean; process?: string } = {}): boolean {
    if (!this.holds(this.mustEndpoint(endpoint), options)) return false
    return (
      this.sql.all(
        `UPDATE endpoints SET stop_blocks = COALESCE(stop_blocks, 0) + 1 WHERE id = ? AND COALESCE(stop_blocks, 0) < ? RETURNING id`,
        endpoint,
        LIMITS.stopBlocks,
      ).length > 0
    )
  }

  /**
   * a hook printed a stop that restated these late parent directives, in full or as a pointer: none is restated again, those among `read`
   * are acked, and the hold counts toward the session's ${LIMITS.directiveHolds}; how many it marked
   */
  restated(endpoint: string, seqs: unknown, read: unknown, options: { transient?: boolean; process?: string } = {}): number {
    const list = seqList(seqs)
    if (!this.holds(this.mustEndpoint(endpoint), options)) return 0
    const now = this.now()
    const acks = new Set(read === undefined ? [] : seqList(read))
    let marked = 0
    let acked = 0
    for (const seq of list) {
      const hit = this.sql.all(
        `UPDATE deliveries SET restated_at = ? WHERE seq = ? AND endpoint = ? AND restated_at IS NULL RETURNING seq`,
        now,
        seq,
        endpoint,
      ).length
      marked += hit
      if (hit && acks.has(seq)) acked += this.sql.all(`UPDATE deliveries SET acked_at = ? WHERE seq = ? AND acked_at IS NULL RETURNING seq`, now, seq).length
    }
    if (acked) this.audit("ack", endpoint, null, { count: acked, via: "inject" })
    if (marked) this.sql.all(`UPDATE endpoints SET directive_holds = COALESCE(directive_holds, 0) + 1 WHERE id = ?`, endpoint)
    return marked
  }

  /** a hook printed the full preamble: the session's later hooks print the brief marker; whether it counted */
  briefed(endpoint: string, options: { transient?: boolean; process?: string } = {}): boolean {
    if (!this.holds(this.mustEndpoint(endpoint), options)) return false
    this.sql.all(`UPDATE endpoints SET briefed = 1 WHERE id = ?`, endpoint)
    return true
  }

  /** a hook printed who spawned the endpoint: inject stops naming it until the session starts again; whether it counted */
  introduced(endpoint: string, options: { transient?: boolean; process?: string } = {}): boolean {
    if (!this.holds(this.mustEndpoint(endpoint), options)) return false
    this.sql.all(`UPDATE endpoints SET introduced = 1 WHERE id = ?`, endpoint)
    return true
  }

  /** a hook printed a stop's nudges: each delivery to `endpoint` among `seqs` is never nudged about again; how many it marked */
  nudged(endpoint: string, seqs: unknown, options: { transient?: boolean; process?: string } = {}): number {
    const list = seqList(seqs)
    if (!this.holds(this.mustEndpoint(endpoint), options)) return 0
    const now = this.now()
    let marked = 0
    for (const seq of list)
      marked += this.sql.all(
        `UPDATE deliveries SET nudged_at = ? WHERE seq = ? AND endpoint = ? AND nudged_at IS NULL RETURNING seq`,
        now,
        seq,
        endpoint,
      ).length
    return marked
  }

  /**
   * a hook or channel showed these deliveries, offered to it under `hold`: no hook offers them again; those of them it marked that are `read`
   * (printed in full) and delivered to `endpoint` are acked, and with `deferred` (a background hook, whose text the harness hands the agent
   * later) still listed by {@link inbox} until that settles ({@link settle}) and marked delivered rather than read ({@link receipts}) until
   * the agent acks it itself; how many it marked
   */
  injected(seqs: unknown, hold: unknown, options: { endpoint?: string; read?: unknown; deferred?: boolean } = {}): number {
    const list = seqList(seqs)
    if (typeof hold !== "string") return 0
    const read = new Set(options.read === undefined || options.endpoint === undefined ? [] : seqList(options.read))
    const now = this.now()
    let marked = 0
    let acked = 0
    for (const seq of list) {
      const hit = this.sql.all(
        `UPDATE deliveries SET injected_at = ? WHERE seq = ? AND offered_hold = ? AND injected_at IS NULL RETURNING seq`,
        now,
        seq,
        hold,
      ).length
      marked += hit
      if (hit && read.has(seq)) {
        const deferred = options.deferred === true ? now : null
        acked += this.sql.all(
          `UPDATE deliveries SET acked_at = ?, deferred_at = ?, deferred_ack = ? WHERE seq = ? AND endpoint = ? AND acked_at IS NULL RETURNING seq`,
          now,
          deferred,
          deferred && 1,
          seq,
          options.endpoint!,
        ).length
      }
    }
    if (acked) this.audit("ack", options.endpoint!, null, { count: acked, via: "inject" })
    return marked
  }

  /**
   * whether a caller acts for the harness process holding the endpoint: any non-hook caller, a hook of that process (equal keys, or a bare and a
   * full key of one pid), or any hook when no process holds it. A hook of another process takes the endpoint over once the holder is gone (a
   * harness restarted under the same session key); while it runs, that hook is a child that inherited the key and acts for nothing.
   */
  private holds(row: EndpointRow, options: { transient?: boolean; process?: string }): boolean {
    if (!options.transient || row.process === null) return true
    if (options.process === undefined) return false
    if (sameHarness(row.process, options.process)) return true
    const pid = Number(/^pid:(\d+)/.exec(row.process)?.[1])
    if (!pid || this.alive(pid)) return false
    this.sql.all(`UPDATE endpoints SET process = ? WHERE id = ? AND process = ?`, options.process, row.id, row.process)
    row.process = options.process
    return true
  }

  /** holds deliveries from the hooks for a while under a new hold id; null when there are none */
  private hold(seqs: number[], now: number): string | null {
    if (!seqs.length) return null
    const hold = newId("hld", now)
    for (const seq of seqs) this.sql.all(`UPDATE deliveries SET offered_until = ?, offered_hold = ? WHERE seq = ?`, now + LIMITS.injectHoldS * 1000, hold, seq)
    return hold
  }

  /**
   * a message delivered to this endpoint and not expired, read or not: by its id; `last`, the newest one, once the endpoint was shown it (read
   * or injected), refused naming its sender while it is unseen; all digits, a seq of its deliveries; or a unique suffix of at least
   * ${MESSAGE_SUFFIX_MIN} characters, such as its {@link shortId}. Null when there is none; invalid_params when the reference is ambiguous
   */
  delivered(endpoint: string, id: unknown): Envelope | null {
    if (typeof id !== "string") throw new RelayError("invalid_params", "id is a message id")
    type Row = MessageRow & { seq: number; shown_at: number | null }
    const query = `SELECT m.*, d.seq AS seq, COALESCE(d.acked_at, d.injected_at) AS shown_at FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND d.expires_at > ?`
    const now = this.now()
    const envelope = (row: Row | undefined) => (row ? this.envelope(row, row.seq) : null)
    const exact = one<Row>(this.sql, `${query} AND m.id = ? ORDER BY d.seq LIMIT 1`, endpoint, now, id)
    if (exact) return envelope(exact)
    if (id === "last") {
      const newest = envelope(one<Row>(this.sql, `${query} ORDER BY d.seq DESC LIMIT 1`, endpoint, now))
      if (newest && one<Row>(this.sql, `${query} AND d.seq = ? AND COALESCE(d.acked_at, d.injected_at) IS NULL`, endpoint, now, newest.seq!)) {
        throw new RelayError("invalid_params", `a newer message arrived from ${newest.from.address} (${shortId(newest.id)}); read it first or name the id`)
      }
      return newest
    }
    const seq = /^\d{1,15}$/.test(id) ? one<Row>(this.sql, `${query} AND d.seq = ?`, endpoint, now, Number(id)) : undefined
    if (!MESSAGE_SUFFIX.test(id)) return envelope(seq)
    const rows = this.sql.all<Row>(`${query} AND substr(m.id, -?) = ? ORDER BY d.seq DESC LIMIT 50`, endpoint, now, id.length, id)
    const ids = [...new Set(rows.map((r) => r.id))]
    if (ids.length > 1) {
      const named = ids.slice(0, 5).map((full) => `${shortId(full)} (${full})`)
      throw new RelayError(
        "invalid_params",
        `${id} matches more than one message delivered to you, newest first: ${named.join(", ")}${ids.length > 5 ? ", ..." : ""}; give more of the id`,
      )
    }
    if (seq && rows[0] && seq.id !== rows[0].id)
      throw new RelayError("invalid_params", `${id} is the seq of one message and the short id of another (${shortId(rows[0].id)}); give the full id`)
    return envelope(seq ?? rows[0])
  }

  /**
   * a message `endpoint` sent, by its id, a unique suffix of at least ${MESSAGE_SUFFIX_MIN} characters such as its {@link shortId}, or `last`
   * (the newest it sent), with when each recipient read it (acked), or when a background hook delivered it (acked by that showing, the agent
   * gets it with its next request, `delivered_at` and no `read_at`), and when a hook or channel showed it; a recipient still waiting for a
   * `swarm spawn` to join is named by the spawn's address. not_found when it sent no such message; invalid_params when a suffix names more
   * than one
   */
  receipts(endpoint: string, id: unknown): MessageReceipts {
    if (typeof id !== "string" || !id.trim()) throw new RelayError("invalid_params", "id is a message id")
    type Row = { id: string; thread: string }
    const sent = `SELECT id, thread FROM messages WHERE from_ep = ?`
    let rows =
      id === "last" ? this.sql.all<Row>(`${sent} ORDER BY created_at DESC, id DESC LIMIT 1`, endpoint) : this.sql.all<Row>(`${sent} AND id = ?`, endpoint, id)
    if (!rows.length && MESSAGE_SUFFIX.test(id))
      rows = this.sql.all<Row>(`${sent} AND substr(id, -?) = ? ORDER BY created_at DESC LIMIT 6`, endpoint, id.length, id)
    if (rows.length > 1) {
      const named = rows.slice(0, 5).map((row) => `${shortId(row.id)} (${row.id})`)
      throw new RelayError(
        "invalid_params",
        `${id} matches more than one message you sent, newest first: ${named.join(", ")}${rows.length > 5 ? ", ..." : ""}; give more of the id`,
      )
    }
    const message = rows[0]
    if (!message) throw new RelayError("not_found", `no message ${id} that you sent`)
    const deliveries = this.sql.all<{ endpoint: string; acked_at: number | null; injected_at: number | null; deferred_ack: number | null }>(
      `SELECT endpoint, acked_at, injected_at, deferred_ack FROM deliveries WHERE message_id = ? ORDER BY seq`,
      message.id,
    )
    const address = (key: string) => {
      const pending = key.startsWith(pendingKey(""))
        ? one<{ name: string | null }>(this.sql, `SELECT name FROM grants WHERE token_hash = ?`, key.slice(pendingKey("").length))
        : undefined
      return pending?.name ? `${this.user}/${pending.name}` : this.addressOf(key)
    }
    return {
      id: message.id,
      thread: message.thread,
      recipients: deliveries.map((d) => ({
        address: address(d.endpoint),
        ...(d.deferred_ack ? { read_at: null, delivered_at: iso(d.acked_at) } : { read_at: iso(d.acked_at) }),
        shown_at: iso(d.injected_at),
      })),
    }
  }

  /**
   * another endpoint's message in a thread `endpoint` sent or got a message in, by its id or a unique suffix of at least ${MESSAGE_SUFFIX_MIN}
   * characters: enough to reply to it, never its body. Null when there is none; invalid_params when the suffix names more than one
   */
  threadMessage(endpoint: string, id: unknown): ThreadMessage | null {
    const row = this.memberMessage(endpoint, id)
    if (!row || row.from_ep === endpoint) return null
    const sender = this.byId(row.from_ep)
    return {
      id: row.id,
      thread: row.thread,
      kind: row.kind,
      created_at: iso(row.created_at)!,
      from: { address: sender ? this.address(sender) : row.from_ep, endpoint: row.from_ep },
    }
  }

  private memberMessage(endpoint: string, id: unknown): MessageRow | undefined {
    if (typeof id !== "string") throw new RelayError("invalid_params", "id is a message id")
    const member = `EXISTS (SELECT 1 FROM messages t WHERE t.thread = m.thread AND (t.from_ep = ? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = t.id AND d.endpoint = ?)))`
    const exact = one<MessageRow>(this.sql, `SELECT * FROM messages m WHERE m.id = ? AND ${member}`, id, endpoint, endpoint)
    if (exact || !MESSAGE_SUFFIX.test(id)) return exact
    const rows = this.sql.all<MessageRow>(
      `SELECT * FROM messages m WHERE substr(m.id, -?) = ? AND ${member} ORDER BY m.created_at DESC LIMIT 50`,
      id.length,
      id,
      endpoint,
      endpoint,
    )
    if (rows.length > 1) {
      const named = rows.slice(0, 5).map((row) => `${shortId(row.id)} (${row.id})`)
      throw new RelayError(
        "invalid_params",
        `${id} matches more than one message in your threads, newest first: ${named.join(", ")}${rows.length > 5 ? ", ..." : ""}; give more of the id`,
      )
    }
    return rows[0]
  }

  /** whether `endpoint` sent or got a message in `thread` */
  private member(thread: string, endpoint: string): boolean {
    return (
      one(
        this.sql,
        `SELECT 1 FROM messages m WHERE thread = ? AND (from_ep = ? OR EXISTS (SELECT 1 FROM deliveries WHERE message_id = m.id AND endpoint = ?)) LIMIT 1`,
        thread,
        endpoint,
        endpoint,
      ) !== undefined
    )
  }

  /**
   * the message a reply from `from` names: one in a thread it sent or got a message in. Only one it got passes the scope as a reply
   * ({@link decide}), so a reply to another message of the thread reaches no one an ordinary send would not
   */
  private replyParent(from: string, id: unknown): MessageRow {
    const parent = one<MessageRow>(this.sql, `SELECT * FROM messages WHERE id = ?`, String(id))
    if (!parent || !this.member(parent.thread, from)) throw new RelayError("not_found", `no message ${id} to reply to`)
    return parent
  }

  /**
   * a send's thread as named: a thread's id as is, else a message in a thread `from` is in (by id or unique suffix) names that thread; an unknown
   * message id is no thread to continue, any other name a new thread
   */
  private threadRef(from: string, name: string | null): string | null {
    if (name === null || one(this.sql, `SELECT 1 FROM messages WHERE thread = ? LIMIT 1`, name)) return name
    const message = this.memberMessage(from, name)
    if (message) return message.thread
    if (name.startsWith("msg_")) throw new RelayError("not_found", `no thread ${name} to continue`)
    return name
  }

  /** reading messages counts as receiving them for the causal hop */
  private received(endpoint: string, rows: MessageRow[], now: number): void {
    if (!rows.length) return
    const hop = Math.max(...rows.map((row) => row.hop))
    this.sql.all(
      `UPDATE endpoints SET last_received_at = ?, last_received_hop = MAX(?, CASE WHEN last_received_at >= ? THEN COALESCE(last_received_hop, 0) ELSE 0 END) WHERE id = ?`,
      now,
      hop,
      now - LIMITS.causalWindowS * 1000,
      endpoint,
    )
  }

  hasUnread(endpoint: string, after = 0): boolean {
    return (
      one(this.sql, `SELECT 1 FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ? AND seq > ? LIMIT 1`, endpoint, this.now(), after) !==
      undefined
    )
  }

  /** marks these deliveries to `endpoint` read, one a background hook's showing acked ({@link injected}) read now too; how many were unread */
  ack(endpoint: string, seqs: unknown): number {
    let acked = 0
    for (const seq of seqList(seqs)) {
      acked += this.sql.all(
        `UPDATE deliveries SET acked_at = ? WHERE seq = ? AND endpoint = ? AND acked_at IS NULL RETURNING seq`,
        this.now(),
        seq,
        endpoint,
      ).length
      this.sql.all(
        `UPDATE deliveries SET acked_at = ?, deferred_ack = NULL WHERE seq = ? AND endpoint = ? AND deferred_ack IS NOT NULL`,
        this.now(),
        seq,
        endpoint,
      )
      this.sql.all(`UPDATE deliveries SET deferred_at = NULL WHERE seq = ? AND endpoint = ? AND deferred_at IS NOT NULL`, seq, endpoint)
    }
    if (acked) this.audit("ack", endpoint, null, { count: acked })
    return acked
  }

  /**
   * the first reply to a request this endpoint sent, delivered to it from an endpoint the request was delivered to (any, for one the hub
   * forwarded); null while there is none. Reading it counts as receiving for the causal hop
   */
  replyTo(endpoint: string, request: string): Envelope | null {
    const asked = one<MessageRow>(this.sql, `SELECT * FROM messages WHERE id = ?`, request)
    if (!asked || asked.from_ep !== endpoint) throw new RelayError("not_found", `no request ${request} from this endpoint`)
    const now = this.now()
    const row = one<MessageRow & { seq: number }>(
      this.sql,
      `SELECT m.*, d.seq AS seq FROM messages m JOIN deliveries d ON d.message_id = m.id
       WHERE m.reply_to = ? AND m.kind = 'reply' AND d.endpoint = ? AND d.expires_at > ?
       AND (m.from_ep IN (SELECT a.endpoint FROM deliveries a WHERE a.message_id = m.reply_to) OR NOT EXISTS (SELECT 1 FROM deliveries a WHERE a.message_id = m.reply_to))
       ORDER BY d.seq LIMIT 1`,
      request,
      endpoint,
      now,
    )
    if (!row) return null
    this.received(endpoint, [row], now)
    return this.envelope(row, row.seq)
  }

  /**
   * the recipients of `request` that were present for it, when every one of them has ended since (its session ended, it is done, or it has been
   * offline for ASK_ENDED_GRACE_MS), with their status state; null while one has not or none was present. `present`: the recipients not offline at the send; without it, those present now or seen since the send
   */
  requestEnded(endpoint: string, request: string, present?: string[]): { address: string; state: StatusState | null }[] | null {
    const asked = one<MessageRow>(this.sql, `SELECT * FROM messages WHERE id = ?`, request)
    if (!asked || asked.from_ep !== endpoint) throw new RelayError("not_found", `no request ${request} from this endpoint`)
    const now = this.now()
    const rows = this.sql
      .all<EndpointRow>(
        `SELECT * FROM endpoints WHERE id IN (SELECT endpoint FROM deliveries WHERE message_id = ?) AND id != ? ORDER BY handle`,
        request,
        endpoint,
      )
      .filter((row) =>
        present
          ? present.includes(row.id)
          : this.presence(row, now) !== "offline" || Math.max(row.last_seen ?? 0, row.hook_seen ?? 0, row.hook_ended ?? 0) >= asked.created_at,
      )
    const gone = (row: EndpointRow): boolean =>
      this.presence(row, now) === "offline" &&
      ((row.hook_ended ?? 0) >= asked.created_at || row.status_state === "done" || now - Math.max(row.last_seen ?? 0, row.hook_seen ?? 0) >= ASK_ENDED_GRACE_MS)
    if (!rows.length || !rows.every(gone)) return null
    return rows.map((row) => ({ address: this.address(row), state: row.status_state as StatusState | null }))
  }

  requestExpired(request: string): boolean {
    const asked = one<{ expires_at: number }>(this.sql, `SELECT expires_at FROM messages WHERE id = ?`, request)
    return !asked || asked.expires_at <= this.now()
  }

  /** oldest first: with `since`, the first rows after it, so a pager never skips one, else the newest; with `scope`, only the scope_* events; with `judge`, only judge_*; with `peek`, only peek and peek_set; with `viewer`, only rows of endpoints it sees that name no address it does not */
  log(
    options: {
      since?: number | undefined
      limit?: number | undefined
      endpoint?: string | undefined
      scope?: boolean | undefined
      judge?: boolean | undefined
      peek?: boolean | undefined
      viewer?: string | undefined
    } = {},
  ): AuditRow[] {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 200)), 1000)
    const forward = options.since !== undefined
    const rows = this.sql.all<{ id: number; at: number; event: string; endpoint: string | null; ref: string | null; detail: string }>(
      `SELECT * FROM audit WHERE id > ? ${options.endpoint ? "AND endpoint = ?" : ""} ${options.scope ? "AND substr(event, 1, 6) = 'scope_'" : ""} ${options.judge ? "AND substr(event, 1, 6) = 'judge_'" : ""} ${options.peek ? "AND event IN ('peek', 'peek_set')" : ""} ORDER BY id ${forward ? "ASC" : "DESC"} LIMIT ?`,
      ...([Math.max(0, Math.floor(options.since ?? 0)), ...(options.endpoint ? [options.endpoint] : []), limit] as SqlValue[]),
    )
    const names = this.names()
    const seen = options.viewer === undefined ? null : this.visibleTo(options.viewer)
    const users = this.addressUsers().map((user) => user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    const address = new RegExp(`(?<![A-Za-z0-9._/-])(?:${users.join("|")})/[A-Za-z0-9._/-]*`, "g")
    const named = new Map<string, boolean>()
    const shown = (text: string): boolean => {
      if (!named.has(text)) {
        const row = this.lookup(text)
        named.set(text, row !== undefined && seen!.has(this.address(row)))
      }
      return named.get(text)!
    }
    const hidden = (value: unknown): boolean => {
      if (typeof value === "string") return [...value.matchAll(address)].some((match) => !shown(match[0]))
      if (Array.isArray(value)) return value.some(hidden)
      return typeof value === "object" && value !== null && Object.values(value).some(hidden)
    }
    return (forward ? rows : rows.reverse())
      .map((row) => ({
        id: row.id,
        at: iso(row.at)!,
        event: row.event,
        endpoint: row.endpoint ? (names.get(row.endpoint) ?? row.endpoint) : null,
        ref: row.ref,
        detail: JSON.parse(row.detail) as Record<string, unknown>,
      }))
      .filter((row) => !seen || (row.endpoint !== null && seen.has(row.endpoint) && !hidden(row.ref) && !hidden(row.detail)))
      .map((row) => (seen && row.event.startsWith("judge_") ? { ...row, detail: judgeDetailForAgents(row.detail) } : row))
  }

  /** drops what expired: deliveries, message bodies past their grace, old guard state and old audit rows */
  sweep(): void {
    const now = this.now()
    this.sql.all(`DELETE FROM deliveries WHERE expires_at <= ? OR (acked_at IS NOT NULL AND acked_at <= ?)`, now, now - LIMITS.purgeAfterS * 1000)
    this.sql.all(
      `DELETE FROM deliveries WHERE substr(endpoint, 1, 6) = 'spawn:' AND substr(endpoint, 7) NOT IN (SELECT token_hash FROM grants WHERE used_by IS NULL AND revoked_at IS NULL AND expires_at > ?)`,
      now,
    )
    this.sql.all(`DELETE FROM messages WHERE expires_at <= ? AND id NOT IN (SELECT message_id FROM deliveries)`, now - LIMITS.purgeAfterS * 1000)
    this.sql.all(`DELETE FROM idempotency WHERE created_at <= ?`, now - LIMITS.idempotencyS * 1000)
    this.sql.all(`DELETE FROM pair_events WHERE at <= ?`, now - 3600 * 1000)
    this.sql.all(`DELETE FROM blocks WHERE until <= ?`, now)
    this.endExited(now)
    this.settleOffline(now)
    this.sql.all(
      `DELETE FROM endpoints WHERE kind = 'agent' AND connections = 0 AND COALESCE(last_seen, created_at) <= ?
       AND id NOT IN (SELECT endpoint FROM deliveries) AND id NOT IN (SELECT from_ep FROM messages) AND id NOT IN (SELECT parent_ep FROM endpoints WHERE parent_ep IS NOT NULL)`,
      now - LIMITS.handleBoundS * 1000,
    )
    this.sql.all(`DELETE FROM audit WHERE at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - ${LIMITS.auditKeepS * 1000}`)
    this.sql.all(`DELETE FROM grants WHERE expires_at <= ? AND (used_by IS NULL OR used_by NOT IN (SELECT id FROM endpoints))`, now)
    this.sql.all(`DELETE FROM tree_events WHERE at <= ?`, now - 3600 * 1000)
    this.sql.all(`DELETE FROM group_members WHERE endpoint NOT IN (SELECT id FROM endpoints)`)
    this.sql.all(
      `DELETE FROM peek_turns WHERE endpoint NOT IN (SELECT id FROM endpoints WHERE peek IS NOT NULL AND substr(handle, 1, ${GONE_PREFIX.length}) != '${GONE_PREFIX}')`,
    )
    for (const group of this.sql.all<GroupRow>(`SELECT * FROM groups WHERE pinned = 0 AND tree IS NOT NULL`)) {
      const root = this.byId(group.tree!)
      const seen = one(
        this.sql,
        `SELECT 1 FROM endpoints WHERE (id = ? OR tree = ?) AND (connections > 0 OR MAX(COALESCE(last_seen, created_at), COALESCE(hook_seen, 0)) > ?) LIMIT 1`,
        group.tree,
        group.tree,
        now - LIMITS.groupIdleS * 1000,
      )
      if (!root || root.handle.startsWith(GONE_PREFIX) || !seen) this.dropGroup(group.name)
    }
  }

  /** ends the hook presence of local agent endpoints whose harness process exited without a session_end, as one would, and lapses wakes whose hook waker never came back */
  endExited(now = this.now()): void {
    for (const row of this.sql.all<EndpointRow>(
      `SELECT * FROM endpoints WHERE kind = 'agent' AND connections = 0 AND hook_seen IS NOT NULL AND process IS NOT NULL`,
    )) {
      const pid = Number(/^pid:(\d+)/.exec(row.process!)?.[1])
      if (!pid || !this.localRow(row) || this.alive(pid)) continue
      this.sql.all(
        `UPDATE endpoints SET hook_seen = NULL, hook_ended = ?, session = NULL, wake = CASE WHEN wakers = 0 THEN NULL ELSE wake END WHERE id = ? AND connections = 0`,
        now,
        row.id,
      )
    }
    for (const row of this.sql.all<EndpointRow>(
      `SELECT * FROM endpoints WHERE wake IS NOT NULL AND wakers = 0 AND waker_left < ?`,
      now - LIMITS.restartGraceS * 1000,
    ))
      if (this.localRow(row)) this.lapseWake(row.id, now)
  }

  /** an agent endpoint left offline drops a working or waiting status, which no one is left to keep current */
  private settleOffline(now: number): void {
    for (const row of this.sql.all<EndpointRow>(
      `SELECT * FROM endpoints WHERE kind = 'agent' AND connections = 0 AND status_state IN ('working', 'waiting')`,
    )) {
      if (this.localRow(row) && this.presence(row, now) === "offline")
        this.sql.all(`UPDATE endpoints SET status_state = NULL, status_note = NULL WHERE id = ?`, row.id)
    }
  }

  // activity

  /**
   * A harness hook's activity event: metadata only, credentials redacted, the newest ${LIMITS.activityKeep} kept.
   * `session_end` ends hook presence and, once no connection holds the endpoint, its session key; any other event from a transient (hook) connection renews it, except for
   * ${LIMITS.hookEndedGraceS} s after a `session_end`, when only a `session_start` does. A hook's `session_end`, and a `session_start`'s reset of the
   * session's stop, push and directive budgets, shown preamble and intro, count only from the harness process that holds the endpoint.
   */
  event(
    endpoint: string,
    params: { kind?: unknown; tool?: unknown; summary?: unknown; agent?: unknown; session_id?: unknown; transcript_path?: unknown },
    options: { transient?: boolean; process?: string } = {},
  ): ActivityRow {
    if (typeof params.kind !== "string" || !ACTIVITY_KINDS.includes(params.kind as ActivityKind)) {
      throw new RelayError("invalid_params", `kind must be one of ${ACTIVITY_KINDS.join(", ")}`)
    }
    const tool = cleanText(params.tool, "tool", 64)
    const summary = cleanText(params.summary, "summary", 4096)
    const agent = cleanText(params.agent, "agent", 64)
    const now = this.now()
    const row = one<{ id: number }>(
      this.sql,
      `INSERT INTO activity (at, endpoint, kind, tool, summary, agent) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      now,
      endpoint,
      params.kind,
      tool ? redactSecrets(tool) : null,
      summary ? redactSecrets(summary).slice(0, LIMITS.activitySummaryChars) : null,
      agent ? redactSecrets(agent) : null,
    )!
    this.sql.all(`DELETE FROM activity WHERE id <= ?`, row.id - LIMITS.activityKeep)
    const own = this.holds(this.mustEndpoint(endpoint), options)
    if (own && !agent && params.kind === "tool") this.settle(endpoint)
    if (own && !agent && typeof params.session_id === "string" && HARNESS_SESSION.test(params.session_id)) {
      this.sql.all(
        `UPDATE endpoints SET harness_session = ?, harness_transcript = ? WHERE id = ?`,
        params.session_id,
        transcriptPath(params.transcript_path, params.session_id),
        endpoint,
      )
    }
    if (params.kind === "session_end") {
      if (own)
        this.sql.all(
          `UPDATE endpoints SET hook_seen = NULL, hook_ended = ?, session = CASE WHEN connections = 0 THEN NULL ELSE session END,
           wake = CASE WHEN wakers = 0 THEN NULL ELSE wake END WHERE id = ?`,
          now,
          endpoint,
        )
    } else if (params.kind === "session_start") {
      this.wakeDone(endpoint, "session_start")
      const fresh = own && summary !== "compact" && summary !== "resume"
      this.sql.all(
        `UPDATE endpoints SET hook_seen = COALESCE(?, hook_seen), hook_ended = NULL, stop_blocks = CASE WHEN ? THEN 0 ELSE stop_blocks END, pushes = CASE WHEN ? THEN 0 ELSE pushes END,
         briefed = CASE WHEN ? THEN NULL ELSE briefed END, introduced = CASE WHEN ? THEN NULL ELSE introduced END, directive_holds = CASE WHEN ? THEN NULL ELSE directive_holds END,
         title = CASE WHEN ? AND title = title_auto THEN NULL ELSE title END, title_auto = CASE WHEN ? THEN NULL ELSE title_auto END WHERE id = ?`,
        options.transient ? now : null,
        own ? 1 : 0,
        own ? 1 : 0,
        own ? 1 : 0,
        own ? 1 : 0,
        own ? 1 : 0,
        fresh ? 1 : 0,
        fresh ? 1 : 0,
        endpoint,
      )
    } else if (options.transient) {
      this.sql.all(
        `UPDATE endpoints SET hook_seen = ? WHERE id = ? AND (hook_ended IS NULL OR hook_ended < ?)`,
        now,
        endpoint,
        now - LIMITS.hookEndedGraceS * 1000,
      )
    }
    this.touch(endpoint)
    return this.activity({ since: row.id - 1, limit: 1 })[0]!
  }

  /** with `viewer`, only the activity of endpoints it sees, and its own */
  activity(
    options: { since?: number | undefined; limit?: number | undefined; endpoint?: string | undefined; viewer?: string | undefined } = {},
  ): ActivityRow[] {
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 1000)
    const visible = options.viewer === undefined ? null : this.visibleRows(this.mustEndpoint(options.viewer)).map((row) => row.id)
    const rows = this.sql.all<{
      id: number
      at: number
      endpoint: string
      kind: ActivityKind
      tool: string | null
      summary: string | null
      agent: string | null
    }>(
      `SELECT * FROM activity WHERE id > ? ${options.endpoint ? "AND endpoint = ?" : ""} ${visible ? `AND endpoint IN (${visible.map(() => "?").join(", ") || "NULL"})` : ""}
       ORDER BY id ${options.since ? "ASC" : "DESC"} LIMIT ?`,
      ...([Math.max(0, Math.floor(options.since ?? 0)), ...(options.endpoint ? [options.endpoint] : []), ...(visible ?? []), limit] as SqlValue[]),
    )
    const names = this.names()
    const ordered = options.since ? rows : rows.reverse()
    return ordered.map((row) => ({ ...row, at: iso(row.at)!, endpoint: names.get(row.endpoint) ?? row.endpoint }))
  }

  /** the fleet right now: every listed endpoint, the latest activity, and the unread mail of each endpoint the viewer sees, listed or not */
  snapshot(options: { all?: boolean | undefined; activity?: number | undefined; viewer?: string | undefined } = {}): {
    endpoints: EndpointView[]
    activity: ActivityRow[]
    unread: Record<string, number>
  } {
    const endpoints = this.list({ all: options.all, viewer: options.viewer })
    const seen = options.all ? endpoints : this.list({ all: true, viewer: options.viewer })
    const counts = new Map(
      this.sql
        .all<{ endpoint: string; n: number }>(
          `SELECT endpoint, COUNT(*) AS n FROM deliveries WHERE acked_at IS NULL AND expires_at > ? GROUP BY endpoint`,
          this.now(),
        )
        .map((row) => [row.endpoint, row.n]),
    )
    const unread = Object.fromEntries(seen.flatMap((view) => (counts.get(view.id) ? [[view.address, counts.get(view.id)!]] : [])))
    return { endpoints, activity: this.activity({ limit: options.activity ?? 50, viewer: options.viewer }), unread }
  }

  /** an endpoint's public address by id, for notifications */
  addressOf(endpoint: string): string {
    const row = this.byId(endpoint)
    return row ? this.address(row) : endpoint
  }

  // peek

  /**
   * a hook's digest turn for its own endpoint: kept, scrubbed, only while the endpoint's peek is on, the newest ${PEEK.ring}. Quotes of the
   * newest ${PEEK.quoteBodies} bodies delivered to it since its reset are cut
   */
  peekTurn(endpoint: string, params: { role?: unknown; text?: unknown }): { stored: boolean } {
    const role = params?.role
    if (role !== "user" && role !== "assistant") throw new RelayError("invalid_params", "role is user or assistant")
    if (typeof params.text !== "string") throw new RelayError("invalid_params", "text is a string")
    const row = this.mustEndpoint(endpoint)
    if (row.kind !== "agent" || !this.localRow(row) || row.peek === null) return { stored: false }
    const delivered = this.sql
      .all<{ body: string }>(
        `SELECT m.body FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.endpoint = ? AND m.created_at > ? ORDER BY d.seq DESC LIMIT ${PEEK.quoteBodies}`,
        row.id,
        row.reset_at ?? -1,
      )
      .map((r) => r.body)
    const text = digestText(params.text, delivered)
    if (!text.trim()) return { stored: false }
    this.sql.all(`INSERT INTO peek_turns (endpoint, at, role, text) VALUES (?, ?, ?, ?)`, row.id, this.now(), role, text)
    this.sql.all(
      `DELETE FROM peek_turns WHERE endpoint = ? AND id NOT IN (SELECT id FROM peek_turns WHERE endpoint = ? ORDER BY id DESC LIMIT ${PEEK.ring})`,
      row.id,
      row.id,
    )
    return { stored: true }
  }

  /**
   * an endpoint's peek level: raised only by the endpoint itself (session or self) or the human at a terminal, lowered by it or anyone with
   * authority over it; off deletes its digest. An ancestor's level is a spawn's grant, never a later raise
   */
  peekSet(actor: ScopeActor, params: { endpoint?: string; level: unknown }): { endpoint: string; peek: PeekLevel | null } {
    const me = this.actorRow(actor)
    const level = peekLevel(params?.level)
    if (level === undefined) throw new RelayError("invalid_params", "level is on, local or off")
    if (params.endpoint === undefined && me.kind !== "agent") throw new RelayError("invalid_params", "the human names the endpoint")
    const target = params.endpoint === undefined ? me : this.peekTarget(params.endpoint)
    if (me.kind === "agent" && target.id !== me.id && !this.authority(me, target)) throw unreachable(params.endpoint)
    const address = this.address(target)
    if (level === target.peek) return { endpoint: address, peek: level }
    if (level !== null) {
      const own = target.id === me.id && actor.kind === "endpoint" && actor.auth !== "lineage"
      if (!own && !this.atTerminal(actor))
        throw this.scopeRefused(actor, me, { target: address, reason: "peek raise" }, "only the endpoint itself or the human at a terminal turns peek on")
    }
    this.sql.all(`UPDATE endpoints SET peek = ? WHERE id = ?`, level, target.id)
    if (level === null) this.sql.all(`DELETE FROM peek_turns WHERE endpoint = ?`, target.id)
    this.audit("peek_set", target.id, null, { ...this.actorDetail(actor, me), target: address, before: target.peek, after: level })
    return { endpoint: address, peek: level }
  }

  /**
   * another endpoint's last turns, scrubbed and cut: itself; the human at a terminal any local agent; otherwise one with peek on that the actor
   * may message or has authority over. Any refusal is not_found, as for an unknown endpoint. Audited without bodies; nothing reaches the target
   */
  peek(actor: ScopeActor, params: { endpoint: unknown; turns?: unknown; full?: unknown }): PeekResult {
    const me = this.actorRow(actor)
    const turns = params?.turns ?? PEEK.turnsDefault
    if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 1 || turns > PEEK.turnsMax)
      throw new RelayError("invalid_params", `turns is 1 to ${PEEK.turnsMax}`)
    const target = this.peekTarget(params.endpoint)
    const tty = this.atTerminal(actor)
    if (!this.mayPeek(me, target, tty)) throw unreachable(params.endpoint)
    const now = this.now()
    if (!tty) {
      for (const [limit, windowS, pair] of [
        [PEEK.pairPerMinute, 60, true],
        [PEEK.targetPerHour, 3600, false],
      ] as const) {
        const recent = one<{ n: number; first: number | null }>(
          this.sql,
          `SELECT COUNT(*) AS n, MIN(at) AS first FROM audit WHERE event = 'peek' AND endpoint = ? AND at > ? ${pair ? "AND ref = ?" : ""} AND json_extract(detail, '$.auth') != 'tty'`,
          ...([target.id, now - windowS * 1000, ...(pair ? [me.id] : [])] as SqlValue[]),
        )!
        if (recent.n >= limit) {
          const after = Math.max(1, Math.ceil(((recent.first ?? now) + windowS * 1000 - now) / 1000))
          throw this.refuse(
            me.id,
            "rate_limited",
            `${limit} peeks ${pair ? "of this endpoint" : "of it by anyone"} in ${windowS} s: retry after ${after} s`,
            after,
            { limit, window_s: windowS },
          )
        }
      }
    }
    const rows = this.sql
      .all<{ at: number; role: PeekTurn["role"]; text: string }>(
        `SELECT at, role, text FROM peek_turns WHERE endpoint = ? ORDER BY id DESC LIMIT ?`,
        target.id,
        turns + 1,
      )
      .reverse()
    const since = target.reset_at ?? 0
    const tools = (after: number, until: number) =>
      this.sql
        .all<{ tool: string }>(
          `SELECT tool FROM activity WHERE endpoint = ? AND kind = 'tool' AND tool IS NOT NULL AND at > ? AND at <= ? ORDER BY id DESC LIMIT ${PEEK.toolsKeep}`,
          target.id,
          after,
          until,
        )
        .map((r) => r.tool)
        .reverse()
    const max = params.full === true ? PEEK.fullChars : PEEK.turnChars
    let truncated = rows.length > turns
    const shown = rows.slice(-turns).map((row, i, all): PeekTurn => {
      const prev = i > 0 ? all[i - 1]!.at : rows.length > turns ? rows[0]!.at : since
      const { text, cut } = readText(row.text, max)
      if (cut) truncated = true
      return { role: row.role, at: iso(row.at)!, text, tools: row.role === "assistant" ? tools(Math.max(prev, since - 1), row.at) : [] }
    })
    const size = () => shown.reduce((n, turn) => n + utf8Bytes(turn.text), 0)
    while (shown.length > 1 && size() > PEEK.totalBytes) {
      shown.shift()
      truncated = true
    }
    const view = this.view(target)
    const result: PeekResult = {
      endpoint: view.address,
      at: iso(now)!,
      level: target.peek,
      source: shown.length ? "digest" : "status",
      turns: shown,
      recent_tools: tools(Math.max(rows.at(-1)?.at ?? since - 1, since - 1), now),
      status: view.status,
      title: view.title,
      unread: one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ?`, target.id, now)!
        .n,
      truncated,
    }
    this.audit("peek", target.id, me.id, { ...this.actorDetail(actor, me), turns: shown.length, bytes: size(), source: result.source, level: target.peek })
    return result
  }

  /** who peeked an endpoint, newest first: its own, or one the actor has authority over */
  peekWho(actor: ScopeActor, params: { endpoint?: string }): { peeked_by: PeekSeen[] } {
    const me = this.actorRow(actor)
    if (params?.endpoint === undefined && me.kind !== "agent") throw new RelayError("invalid_params", "the human names the endpoint")
    const target = params?.endpoint === undefined ? me : this.peekTarget(params.endpoint)
    const allowed = target.id === me.id || (me.kind === "agent" ? this.authority(me, target) : this.atTerminal(actor) || this.mayMessage(me, target, true))
    if (!allowed) throw unreachable(params.endpoint)
    return { peeked_by: this.peekedBy(target.id, PEEK.whoKeep) }
  }

  /** whether `process` is a key of the harness process that holds `endpoint`, the only one whose hooks post its digest turns */
  hookOwns(endpoint: string, process: string | undefined): boolean {
    const row = this.byId(endpoint)
    return process !== undefined && row?.process != null && sameHarness(row.process, process)
  }

  /** an endpoint's own peek level and the last few who peeked it; local only, never mirrored */
  peekState(endpoint: string): PeekState {
    const row = this.mustEndpoint(endpoint)
    return { peek: row.peek ?? null, peeked_by: this.peekedBy(row.id, PEEK.stateKeep) }
  }

  protected dropPeek(endpoint: string): void {
    this.sql.all(`UPDATE endpoints SET peek = NULL WHERE id = ?`, endpoint)
    this.sql.all(`DELETE FROM peek_turns WHERE endpoint = ?`, endpoint)
  }

  private peekedBy(endpoint: string, limit: number): PeekSeen[] {
    return this.sql
      .all<{ at: number; detail: string }>(`SELECT at, detail FROM audit WHERE event = 'peek' AND endpoint = ? ORDER BY id DESC LIMIT ?`, endpoint, limit)
      .map((row) => {
        const detail = JSON.parse(row.detail) as { by?: string; auth?: string; turns?: number }
        return { at: iso(row.at)!, by: detail.by ?? "", auth: detail.auth ?? "", turns: detail.turns ?? 0 }
      })
  }

  /** a local agent endpoint by address, else not_found */
  private peekTarget(address: unknown): EndpointRow {
    if (typeof address !== "string" || !address.trim()) throw new RelayError("invalid_params", "endpoint is an address")
    const row = this.lookup(address)
    if (row?.kind !== "agent" || !this.localRow(row)) throw unreachable(address)
    return row
  }

  private mayPeek(me: EndpointRow, target: EndpointRow, tty: boolean): boolean {
    if (target.kind !== "agent" || !this.localRow(target)) return false
    if (target.id === me.id || (me.kind === "human" && tty)) return true
    if (target.peek === null) return false
    return me.kind === "human" ? this.mayMessage(me, target, true) : this.mayMessage(me, target) || this.authority(me, target)
  }

  /** whether a list or peers row shows `peekable` to `me`: its peek is on and `me` may peek it */
  private peekableBy(me: EndpointRow, row: EndpointRow, unverified: boolean): boolean {
    return row.peek !== null && row.peek !== undefined && this.mayPeek(me, row, me.kind === "human" && !unverified)
  }

  // scopes

  /** an endpoint's scope: the actor's own, one it has authority over, or any for the human; else not_found */
  scopeView(actor: ScopeActor, endpoint?: string): ScopeView {
    const me = this.actorRow(actor)
    if (endpoint === undefined && me.kind !== "agent") throw new RelayError("invalid_params", "the human has no scope; name an endpoint")
    const target = endpoint === undefined ? me : this.resolve(endpoint)
    const hidden = me.kind === "agent" ? target.id !== me.id && !this.authority(me, target) : !this.atTerminal(actor) && !this.mayMessage(me, target, true)
    if (target.kind !== "agent" || !this.localRow(target) || hidden) {
      throw unreachable(endpoint)
    }
    return this.scopeViewOf(target, me)
  }

  /**
   * Without `endpoint` (or naming the actor), the actor's own rules per given direction; a plain shell may only tighten them. With an endpoint the
   * actor has authority over, the cap the actor set on it per direction: selectors new to that cap widen it (stored `via` the actor and clipped
   * to its reach), `open` lifts it.
   */
  rulesSet(actor: ScopeActor, params: { endpoint?: string; in?: string[]; out?: string[]; scope?: ScopePreset; allow?: string[] }): ScopeView {
    const me = this.actorRow(actor)
    this.needTerminal(actor, me, params?.endpoint)
    const changes = expandRules(this.ruleParams(params ?? {}), this.defaults().symmetric)
    const dirs = Object.keys(changes) as ScopeDirection[]
    if (!dirs.length) throw new RelayError("invalid_params", "set in, out, scope or allow")
    const target = params.endpoint === undefined ? me : this.scopeTarget(me, params.endpoint)
    for (const dir of dirs) this.needGroups(me, changes[dir])
    return this.scopeTx(() => {
      if (target.id === me.id) {
        if (me.kind !== "agent") throw new RelayError("invalid_params", "the human has no rules of its own; name an endpoint")
        const rules = json<ScopeRules>(me.rules, {})
        const wider = dirs.filter((dir) => !narrower(changes[dir], rules[dir]) || this.rebindsRule(rules, dir, changes[dir]))
        if (wider.length && this.narrowOnly(actor))
          throw this.scopeRefused(actor, me, { target: this.address(me), dir: wider[0], reason: "narrow only" }, "this connection may only tighten the rules")
        for (const dir of dirs) {
          const before = rules[dir]
          const next = changes[dir]
          this.setRule(rules, dir, next)
          this.audit(wider.includes(dir) ? "scope_widen" : "scope_narrow", me.id, null, {
            ...this.actorDetail(actor, me),
            target: this.address(me),
            dir,
            before: before ?? null,
            after: next ?? null,
          })
        }
        this.sql.all(`UPDATE endpoints SET rules = ? WHERE id = ?`, Object.keys(rules).length ? JSON.stringify(rules) : null, me.id)
        return this.scopeViewOf(this.byId(me.id)!, me)
      }
      if (!this.authority(me, target))
        throw this.scopeRefused(actor, me, { target: this.address(target), reason: "no authority" }, `no authority over ${this.address(target)}`)
      const caps = this.capsOf(target)
      const by = me.kind === "human" ? "human" : me.id
      const prev = (dir: ScopeDirection) => caps.caps.find((cap) => cap.dir === dir && cap.by === by)
      const widens = (dir: ScopeDirection) => {
        const cap = prev(dir)
        const next = changes[dir]
        return cap !== undefined && (!next || next.some((sel) => !cap.sels.some((entry) => entry.sel === sel && this.rebound(entry) === entry)))
      }
      if (this.narrowOnly(actor) && dirs.some(widens))
        throw this.scopeRefused(actor, me, { target: this.address(target), reason: "narrow only" }, "this connection may only narrow")
      for (const dir of dirs) {
        const cap = prev(dir)
        const next = changes[dir]
        const detail = { ...this.actorDetail(actor, me), target: this.address(target), dir }
        if (!next) {
          if (!cap) continue
          caps.caps = caps.caps.filter((c) => c !== cap)
          this.audit("scope_lift", target.id, null, { ...detail, before: cap.sels.map((e) => e.sel), after: null })
        } else if (!cap) {
          caps.caps.push({ id: capId(), dir, by, sels: next.map((sel) => this.entry(sel)) })
          this.audit("scope_narrow", target.id, null, { ...detail, before: null, after: next })
        } else {
          const before = cap.sels.map((e) => e.sel)
          const added = next.filter((sel) => !before.includes(sel))
          cap.sels = next.map((sel) => this.rebound(cap.sels.find((entry) => entry.sel === sel)) ?? this.entry(sel, by))
          this.audit(added.length ? "scope_widen" : "scope_narrow", target.id, null, {
            ...detail,
            ...(added.length ? { via: this.address(me), added } : {}),
            before,
            after: next,
          })
        }
      }
      this.saveCaps(target.id, caps)
      return this.scopeViewOf(this.byId(target.id)!, me)
    })
  }

  /**
   * An allowance for `endpoint`, put into each cap of the direction the actor may loosen (stored caps get the entry, group and inherited caps an allowance),
   * stored `via` the actor and clipped to the actor's reach. A selector is clipped when it matches some endpoint and none the actor reaches;
   * nothing added is `scope_refused`.
   */
  rulesWiden(actor: ScopeActor, params: { endpoint: string; in?: string[]; out?: string[] }): ScopeChange {
    const me = this.actorRow(actor)
    this.needTerminal(actor, me, params?.endpoint)
    const lists = this.ruleParams({ in: params?.in, out: params?.out })
    if (!lists.in?.length && !lists.out?.length) throw new RelayError("invalid_params", "widen takes in or out selectors")
    const target = this.scopeTarget(me, params.endpoint)
    this.needGroups(me, [...(lists.in ?? []), ...(lists.out ?? [])])
    const detail = { target: this.address(target) }
    if (this.narrowOnly(actor)) throw this.scopeRefused(actor, me, { ...detail, reason: "narrow only" }, "widening needs an authenticated session")
    if (!this.authority(me, target)) throw this.scopeRefused(actor, me, { ...detail, reason: "no authority" }, `no authority over ${this.address(target)}`)
    return this.scopeTx(() => {
      const change = this.allowInto(me, target, lists, { ...this.actorDetail(actor, me), via: this.address(me), ...detail })
      if (!change.added.length) {
        throw this.scopeRefused(
          actor,
          me,
          { ...detail, clipped: change.clipped, reason: "clipped" },
          `nothing to widen: ${change.clipped.join(", ")} clipped to what ${this.address(me)} reaches, or no cap it may loosen`,
        )
      }
      this.widenBack(actor, me, target, lists, change)
      return change
    })
  }

  /** the grant issuer's messages to the endpoint that spent it, sent since the grant, that it read, all but those among `unapplied`, oldest first */
  private readSteers(grant: GrantRow, spender: EndpointRow, unapplied: string[]): { id: string; acked_at: number; deferred_ack: number | null }[] {
    return this.sql.all<{ id: string; acked_at: number; deferred_ack: number | null }>(
      `SELECT m.id, d.acked_at, d.deferred_ack FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.endpoint = ? AND m.from_ep = ? AND m.created_at >= ? AND d.acked_at IS NOT NULL
       ${unapplied.length ? `AND m.id NOT IN (${unapplied.map(() => "?").join(", ")})` : ""} ORDER BY d.seq LIMIT ?`,
      spender.id,
      grant.issuer,
      grant.created_at,
      ...unapplied,
      LIMITS.inboxPage,
    )
  }

  /**
   * a message needs both ends: for each `ep:` selector `widen` added on `target`, the other end's side is widened to admit `target` too when
   * `me` has authority over it, audited as its own widening; when that side still refuses, the change names it and the command that would fix it.
   * An end `me` does not find gets that hint unchecked, so it tells a hidden endpoint from a missing one no more than the send would
   */
  private widenBack(actor: ScopeActor, me: EndpointRow, target: EndpointRow, lists: Partial<Record<ScopeDirection, string[]>>, change: ScopeChange): void {
    for (const dir of ["out", "in"] as const) {
      const other = dir === "out" ? "in" : "out"
      for (const sel of lists[dir] ?? []) {
        if (!sel.startsWith("ep:") || !change.added.includes(sel)) continue
        const peer = this.byHandle(sel.slice(3))
        const back = [`ep:${target.handle}`]
        const fix = (address: string) => `${CLI_NAME} rules widen ${address} --${other} ${back[0]}`
        if (peer?.id === target.id) continue
        if (peer?.kind !== "agent" || !this.localRow(peer) || (me.kind === "agent" && !this.discovers(me, peer))) {
          const address = `${this.user}/${sel.slice(3)}`
          change.refused ??= []
          change.refused.push({ endpoint: address, dir: other, fix: fix(address), unseen: true })
          continue
        }
        const refuses = () => {
          const [from, to] = dir === "out" ? [target, peer] : [peer, target]
          const decision = this.decide(this.scopeWorld(), this.byId(from.id)!, this.byId(to.id)!)
          return !decision.allowed && decision.dir === other
        }
        if (!refuses()) continue
        if (this.authority(me, peer)) {
          const added = this.allowInto(
            me,
            peer,
            { [other]: back },
            { ...this.actorDetail(actor, me), via: this.address(me), target: this.address(peer), mirror: this.address(target) },
          ).added
          if (added.length) {
            change.mirrored ??= []
            change.mirrored.push({ endpoint: this.address(peer), dir: other, added })
          }
          if (!refuses()) continue
        }
        change.refused ??= []
        change.refused.push({ endpoint: this.address(peer), dir: other, fix: fix(this.address(peer)) })
      }
    }
  }

  /**
   * puts `lists` into each cap of `target`'s that `me` may loosen, `via` `me`, saving and auditing what it added. With `member`, the allowance a
   * membership of that group gives: kept out of the group's own rules, never clipped at set time (clipping runs live), and taken when the member leaves
   */
  private allowInto(
    me: EndpointRow,
    target: EndpointRow,
    lists: Partial<Record<ScopeDirection, string[]>>,
    detail: Record<string, unknown>,
    member?: string,
  ): ScopeChange {
    const world = this.scopeWorld()
    const node = world.node(target.id)!
    const candidates = member === undefined ? this.agentRows().map((row) => world.node(row.id)!) : []
    const via = me.kind === "human" ? "human" : me.id
    const caps = this.capsOf(target)
    const change: ScopeChange = { added: [], clipped: [] }
    const audits: Record<string, unknown>[] = []
    for (const dir of ["in", "out"] as const) {
      const sels = lists[dir]
      if (!sels?.length) continue
      const stored = caps.caps.filter((cap) => cap.dir === dir && this.mayLoosen(me, target, { by: cap.by }))
      const groups = node.groups.filter(
        (group) => group[dir] && group.name !== member && this.mayLoosen(me, target, { by: `group:${group.name}`, owner: group.owner }),
      )
      const inherited = node.caps.caps.some((cap) => cap.dir === dir && cap.by === "inherited") ? [`inherited:${dir}`] : []
      const added: string[] = []
      const cut: string[] = []
      const snapshot = () =>
        Object.fromEntries([
          ...stored.map((cap) => [cap.id, cap.sels.map((entry) => entry.sel)]),
          ...groups.map((group) => [
            groupCapKey(group.name, dir),
            [...group[dir]!, ...(caps.allow[groupCapKey(group.name, dir)] ?? [])].map((entry) => entry.sel),
          ]),
          ...inherited.map((key) => [key, ["*", ...(caps.allow[key] ?? []).map((entry) => entry.sel)]]),
        ])
      const before = snapshot()
      for (const sel of sels) {
        if (!stored.length && !groups.length && !inherited.length) cut.push(sel)
        else if (via !== "human" && clipped(world, via, sel, node, dir, candidates)) cut.push(sel)
        else {
          const put = (list: ScopeEntry[]) => {
            const at = list.findIndex((e) => e.sel === sel && e.via === via)
            if (at < 0) list.push({ ...this.entry(sel, via), ...(member !== undefined ? { member: true as const } : {}) })
            else {
              const { member: wasMember, ...kept } = this.rebound(list[at])!
              list[at] = member === undefined || !wasMember ? kept : { ...kept, member: true as const }
            }
          }
          for (const cap of stored) put(cap.sels)
          for (const key of [...groups.map((group) => groupCapKey(group.name, dir)), ...inherited]) {
            const sels = caps.allow[key] ?? []
            caps.allow[key] = sels
            put(sels)
          }
          added.push(sel)
        }
      }
      change.added.push(...added)
      change.clipped.push(...cut)
      if (added.length || member === undefined) audits.push({ dir, added, clipped: cut, before, after: snapshot() })
    }
    if (!change.added.length) return change
    this.saveCaps(target.id, caps)
    for (const row of audits) this.audit("scope_widen", target.id, null, { ...detail, ...row })
    return change
  }

  /** removes a stored cap the actor may loosen */
  rulesLift(actor: ScopeActor, params: { endpoint: string; cap: string }): ScopeView {
    const me = this.actorRow(actor)
    this.needTerminal(actor, me, params?.endpoint)
    const target = this.scopeTarget(me, params?.endpoint)
    const detail = { target: this.address(target) }
    if (this.narrowOnly(actor)) throw this.scopeRefused(actor, me, { ...detail, reason: "narrow only" }, "lifting a cap needs an authenticated session")
    if (!this.authority(me, target)) throw this.scopeRefused(actor, me, { ...detail, reason: "no authority" }, `no authority over ${this.address(target)}`)
    return this.scopeTx(() => {
      const caps = this.capsOf(target)
      if (typeof params.cap === "string" && /^inherited:(in|out)$/.test(params.cap)) {
        if (!this.atTerminal(actor))
          throw this.scopeRefused(actor, me, { ...detail, reason: "human only" }, "only the human at a terminal lifts an inherited cap")
        const derived = this.scopeNode(target).caps.caps.find((c) => c.by === "inherited" && c.id === params.cap)
        if (!derived) throw new RelayError("not_found", `no cap ${params.cap} on ${this.address(target)}`)
        caps.lifted = [...(caps.lifted ?? []), derived.dir]
        delete caps.allow[derived.id]
        this.saveCaps(target.id, caps)
        this.audit("scope_lift", target.id, null, {
          ...this.actorDetail(actor, me),
          ...detail,
          dir: derived.dir,
          before: [`inherited from ${this.addressOf(derived.sels[0]!.via!)}`],
          after: null,
        })
        return this.scopeViewOf(this.byId(target.id)!, me)
      }
      const cap = caps.caps.find((c) => c.id === params.cap)
      if (!cap) {
        if (typeof params.cap === "string" && /^(group|policy):/.test(params.cap))
          throw this.scopeRefused(
            actor,
            me,
            { ...detail, reason: "not a stored cap" },
            "a group cap goes with the membership, a policy cap with the policy file",
          )
        throw new RelayError("not_found", `no cap ${String(params.cap)} on ${this.address(target)}`)
      }
      if (!this.mayLoosen(me, target, { by: cap.by }))
        throw this.scopeRefused(actor, me, { ...detail, dir: cap.dir, reason: "set above" }, `${cap.id} was set above ${this.address(me)}`)
      caps.caps = caps.caps.filter((c) => c !== cap)
      this.saveCaps(target.id, caps)
      this.audit("scope_lift", target.id, null, { ...this.actorDetail(actor, me), ...detail, dir: cap.dir, before: cap.sels.map((e) => e.sel), after: null })
      return this.scopeViewOf(this.byId(target.id)!, me)
    })
  }

  /**
   * a `krt_` grant placing a claim under `under` (the actor or its descendant) with caps by the actor and groups; stored hashed. A plain shell's
   * grant keeps the policy's child default preset on top of its caps. A `spawn` grant also gets a steer key, returned with the actor's address
   */
  grant(
    actor: ScopeActor,
    params: {
      name?: string
      labels?: Record<string, string>
      title?: string
      under?: string
      scope?: ScopePreset
      in?: string[]
      out?: string[]
      allow?: string[]
      groups?: string[]
      ttl_s?: number
      bind_process?: string
      peek?: PeekLevel
      spawn?: boolean
      no_push?: boolean
      prompt?: string
    },
  ): { token: string; env: Record<string, string>; steer?: { key: string; parent: string } } {
    const me = this.actorRow(actor)
    const p = params ?? {}
    this.needTerminal(actor, me, p.under)
    if (me.kind !== "agent" && p.under === undefined) throw new RelayError("invalid_params", "the human names the endpoint to grant under")
    const under = p.under === undefined ? me : this.scopeTarget(me, p.under)
    if (under.kind !== "agent" || (me.kind === "agent" && under.id !== me.id && !this.ancestorsOf(under).includes(me.id))) throw unreachable(p.under)
    const name = cleanText(p.name, "name", 63)
    if (name !== null && !validHandle(name)) throw new RelayError("invalid_params", `name ${JSON.stringify(name)} is not a valid handle`)
    const labels = cleanLabels(p.labels)
    const leaked = findSecret(JSON.stringify(labels))
    if (leaked) throw this.refuse(me.id, "secret_refused", `the labels look like they carry a credential (${leaked})`)
    const title = oneLine(p.title, "title", 64) || null
    if (title && findSecret(title)) throw this.refuse(me.id, "secret_refused", "the title looks like it carries a credential")
    const ttl = p.ttl_s ?? LIMITS.grantTtlS
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > LIMITS.grantTtlS) throw new RelayError("invalid_params", `ttl_s must be 1 to ${LIMITS.grantTtlS}`)
    const bound = p.bind_process ?? null
    if (bound !== null && (typeof bound !== "string" || !PROCESS_KEY.test(bound)))
      throw new RelayError("invalid_params", "bind_process is a key pid:<pid>:<start time>")
    if (p.peek !== undefined && p.peek !== "local") throw new RelayError("invalid_params", "peek is local")
    if (p.spawn !== undefined && typeof p.spawn !== "boolean") throw new RelayError("invalid_params", "spawn is true or false")
    if (p.no_push !== undefined && typeof p.no_push !== "boolean") throw new RelayError("invalid_params", "no_push is true or false")
    if (p.prompt !== undefined && typeof p.prompt !== "string") throw new RelayError("invalid_params", "prompt is a string")
    const digested = p.peek === "local" && p.prompt ? digestText(p.prompt) : ""
    const prompt = digested.trim() ? digested : null
    const expanded = expandRules(this.ruleParams(p), this.defaults().symmetric)
    for (const sels of Object.values(expanded)) this.needGroups(me, sels)
    const caps = Object.entries(expanded)
      .filter(([, sels]) => sels)
      .map(([dir, sels]) => ({ dir, sels: sels!.map((sel) => this.entry(sel)) }))
    const childDefault = this.defaults().childDefault
    if (this.narrowOnly(actor) && childDefault !== "open" && childDefault !== "inherit") {
      for (const dir of this.presetDirs()) caps.push({ dir, sels: PRESET_LISTS[childDefault].map((sel) => ({ sel })) })
    }
    const groups: GrantGroup[] = []
    for (const group of groupNames(p.groups, "groups")) {
      const row = this.groupByName(group)
      if (!row || row.policy || !this.seesGroup(me, row)) throw new RelayError("not_found", `no group ${group}`)
      if (me.kind === "agent" && row.owner !== me.id && !this.adminOfGroup(me.id, row))
        throw this.scopeRefused(actor, me, { target: `group:${group}`, reason: "not the owner" }, `only the owner adds to group ${group}`)
      groups.push({ name: row.name, id: this.groupId(row), ...(this.narrowOnly(actor) ? {} : { allow: true as const }) })
    }
    const token = `krt_${randomHex(32)}`
    const steer = p.spawn === true ? steerKey() : null
    const now = this.now()
    this.sql.all(
      `INSERT INTO grants (token_hash, issuer, under, name, labels, title, caps, groups, created_at, expires_at, bound_process, peek, spawn, no_push, prompt, steer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.hash(token),
      me.id,
      under.id,
      name,
      JSON.stringify(labels),
      title,
      JSON.stringify(caps),
      JSON.stringify(groups),
      now,
      now + ttl * 1000,
      bound,
      p.peek ?? null,
      p.spawn === true ? 1 : null,
      p.no_push === true ? 1 : null,
      prompt,
      steer,
    )
    this.audit("scope_grant", under.id, null, {
      ...this.actorDetail(actor, me),
      target: this.address(under),
      ...(name !== null ? { name } : {}),
      caps: caps.map((cap) => ({ dir: cap.dir, sels: cap.sels.map((entry) => entry.sel) })),
      groups: groups.map((group) => group.name),
      expires_at: iso(now + ttl * 1000),
      ...(bound !== null ? { bound: true } : {}),
      ...(p.peek ? { peek: p.peek } : {}),
      ...(p.spawn === true ? { spawn: true } : {}),
      ...(p.no_push === true ? { no_push: true } : {}),
      ...(prompt ? { prompt: true } : {}),
    })
    return { token, env: { SCP_GRANT: token, ...(name ? { SCP_NAME: name } : {}) }, ...(steer ? { steer: { key: steer, parent: this.address(me) } } : {}) }
  }

  /**
   * the harness a spawn ran with `grant` exited with `code`: the endpoint that spent the grant is done (`exited <code>`, its last note after)
   * and its hook presence ends, as at a session_end; a grant no one spent is revoked. Either way the actor gets the handback, the worker's
   * `output` (its last terminal output) framed with the exit as one unread message ({@link handback}), naming as not applied the `unapplied`
   * steers spawn took ({@link spawnSteers}) but could not hand the worker, and the tail of its `stderr` when it never joined or exited
   * non-zero. A harness that never `started` (its spawn reported why) hands nothing back. The grant's issuer or an ancestor of that endpoint only
   */
  spawnExit(
    actor: ScopeActor,
    params: {
      grant: string
      code: number
      output?: string
      stderr?: string
      unapplied?: string[]
      exits?: number[]
      started?: boolean
      run?: number
      reply_to?: string
    },
  ): { joined: boolean; name: string | null; endpoint: EndpointView | null; handback: string | null; spawner: string } {
    const p = params ?? ({} as typeof params)
    if (typeof p.grant !== "string" || !GRANT_TOKEN.test(p.grant)) throw new RelayError("invalid_params", "grant is a krt_ token")
    if (!Number.isInteger(p.code) || p.code < 0 || p.code > 255) throw new RelayError("invalid_params", "code is an exit code, 0 to 255")
    const run = p.run === undefined || p.run === null ? 1 : p.run
    if (!Number.isInteger(run) || run < 1) throw new RelayError("invalid_params", "run is a whole number from 1")
    if (p.reply_to !== undefined && p.reply_to !== null && typeof p.reply_to !== "string") throw new RelayError("invalid_params", "reply_to is a message id")
    if (p.output !== undefined && p.output !== null && typeof p.output !== "string") throw new RelayError("invalid_params", "output is a string")
    if (p.stderr !== undefined && p.stderr !== null && typeof p.stderr !== "string") throw new RelayError("invalid_params", "stderr is a string")
    if (p.started !== undefined && p.started !== null && typeof p.started !== "boolean") throw new RelayError("invalid_params", "started is a boolean")
    const unapplied = p.unapplied === undefined || p.unapplied === null ? [] : p.unapplied
    if (!Array.isArray(unapplied) || unapplied.length > LIMITS.inboxPage || unapplied.some((id) => typeof id !== "string"))
      throw new RelayError("invalid_params", "unapplied is a list of message ids")
    const exitTimes = p.exits === undefined || p.exits === null ? [] : p.exits
    if (!Array.isArray(exitTimes) || exitTimes.length > 8 || exitTimes.some((at) => !Number.isInteger(at)))
      throw new RelayError("invalid_params", "exits is a list of times in ms")
    const output = typeof p.output === "string" ? handbackOutput(p.output) : ""
    const stderr = typeof p.stderr === "string" ? handbackOutput(p.stderr, false, 2 * LIMITS.stderrBytes) : ""
    const me = this.actorRow(actor)
    return this.tx(() => {
      const { grant, spender } = this.spawnGrant(me, p.grant)
      const now = this.now()
      const spawner = this.byId(grant.issuer) ?? me
      if (!spender && run > 1) return { joined: false, name: grant.name, endpoint: null, handback: null, spawner: spawner.id }
      if (!spender) {
        this.sql.all(`UPDATE grants SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?`, now, grant.token_hash)
        const lost = this.sql.all(`DELETE FROM deliveries WHERE endpoint = ? RETURNING seq`, pendingKey(grant.token_hash)).length
        const handback = p.started === false ? null : this.handback(spawner, grant, undefined, p.code, output, [], lost, [], stderr)
        this.audit("spawn_exit", me.id, handback, { by: this.address(me), code: p.code, joined: false, handback })
        return { joined: false, name: grant.name, endpoint: null, handback, spawner: spawner.id }
      }
      const note = [`exited ${p.code}`, spender.status_note].filter(Boolean).join("; ").slice(0, LIMITS.noteChars)
      this.sql.all(
        `UPDATE endpoints SET status_state = 'done', status_note = ?, hook_seen = NULL, hook_ended = ?, session = CASE WHEN connections = 0 THEN NULL ELSE session END,
         wake = CASE WHEN wakers = 0 THEN NULL ELSE wake END WHERE id = ?`,
        note,
        now,
        spender.id,
      )
      const exits = (exitTimes as number[]).map((at) => Math.min(Math.max(at, grant.created_at), now)).sort((a, b) => a - b)
      const handback =
        run === 1
          ? this.handback(spawner, grant, spender, p.code, output, unapplied as string[], 0, exits, stderr)
          : this.runHandback(spawner, grant, spender, run, p.code, output, stderr, typeof p.reply_to === "string" ? p.reply_to : undefined)
      if (run === 1 && handback) this.sql.all(`UPDATE grants SET run = 1 WHERE token_hash = ? AND run IS NULL`, grant.token_hash)
      this.audit("spawn_exit", spender.id, handback, { by: this.address(me), code: p.code, handback, ...(run > 1 ? { run } : {}) })
      return { joined: true, name: grant.name, endpoint: this.whoami(spender.id), handback, spawner: spawner.id }
    })
  }

  /** a spawn grant by its token and the endpoint that spent it, for its issuer or an ancestor of that endpoint */
  private spawnGrant(me: EndpointRow, token: string): { grant: GrantRow; spender: EndpointRow | undefined } {
    const grant = one<GrantRow>(this.sql, `SELECT * FROM grants WHERE token_hash = ?`, this.hash(token))
    if (!grant) throw new RelayError("not_found", "no such grant")
    const spender = grant.used_by === null ? undefined : this.byId(grant.used_by)
    if (grant.issuer !== me.id && !(spender && this.ancestorsOf(spender).includes(me.id)))
      throw new RelayError("unauthorized", "only the grant's issuer ends its spawn")
    if (spender && grant.revoked_at !== null) throw new RelayError("unauthorized", "the grant was revoked: a new spawn holds its endpoint")
    return { grant, spender }
  }

  /** the grant issuer's messages to the endpoint that spent it, sent since the grant, unread or among `ids`, oldest first */
  private steersOf(grant: GrantRow, spender: EndpointRow, now: number, ids: string[] = []): (MessageRow & { seq: number })[] {
    return this.sql.all<MessageRow & { seq: number }>(
      `SELECT m.*, d.seq AS seq FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.endpoint = ? AND m.from_ep = ? AND d.expires_at > ? AND m.created_at >= ?
       AND (d.acked_at IS NULL OR m.id IN (${ids.map(() => "?").join(", ") || "NULL"})) ORDER BY d.seq LIMIT ?`,
      spender.id,
      grant.issuer,
      now,
      grant.created_at,
      ...ids,
      LIMITS.inboxPage,
    )
  }

  /**
   * a `swarm spawn` whose worker exited: the harness session id the worker's hooks reported, which a resume takes, the transcript they named
   * with it, and the grant issuer's unread messages to it, as the worker would have been shown them. With `take` and a session, those are
   * marked read, for spawn to hand them to the resumed session itself, and the exited worker's hook presence ends, so the resumed session's
   * MCP shim re-claims its endpoint with the grant it spent. The grant's issuer or an ancestor of that endpoint only
   */
  spawnSteers(
    actor: ScopeActor,
    params: { grant: string; take?: boolean },
  ): { session: string | null; steers: Envelope[]; transcript: string | null; joined: boolean } {
    const p = params ?? ({} as typeof params)
    if (typeof p.grant !== "string" || !GRANT_TOKEN.test(p.grant)) throw new RelayError("invalid_params", "grant is a krt_ token")
    const me = this.actorRow(actor)
    return this.tx(() => {
      const { grant, spender } = this.spawnGrant(me, p.grant)
      if (!spender) return { session: null, steers: [], transcript: null, joined: false }
      const now = this.now()
      const rows = this.steersOf(grant, spender, now)
      const steers = rows.map((row) => this.envelope(row, row.seq))
      if (p.take === true && spender.harness_session && rows.length) {
        this.sql.all(`UPDATE endpoints SET hook_seen = NULL WHERE id = ?`, spender.id)
        this.sql.all(
          `UPDATE deliveries SET acked_at = ? WHERE seq IN (${rows.map(() => "?").join(", ")}) AND acked_at IS NULL`,
          now,
          ...rows.map((row) => row.seq),
        )
        this.audit("ack", spender.id, null, { count: rows.length, by: this.address(me) })
      }
      return { session: spender.harness_session, steers, transcript: spender.harness_session ? spender.harness_transcript : null, joined: true }
    })
  }

  /**
   * the worker `endpoint`'s spawn no longer holds it: its latest spawn grant records the end, its `spawn-resume` wake and durable ref clear,
   * and a hibernation by {@link SPAWN_PROVIDER} clears, so no message resumes it again; a message after the end queues as for any offline
   * agent. The broker closes the connections waking it. The issuer of its spawn grant, an ancestor of the worker, or the human at a terminal;
   * audited `spawn_end {by, target, held}`, `held` whether a spawn held it or a durable one had it hibernated
   */
  spawnEnd(actor: ScopeActor, params: { endpoint: unknown }): { endpoint: EndpointView; held: boolean } {
    const me = this.actorRow(actor)
    return this.tx(() => {
      const target = this.resolve(params?.endpoint)
      if (target.kind !== "agent" || !this.localRow(target)) throw new RelayError("invalid_params", "only a local agent endpoint is ended")
      const grant = one<GrantRow>(this.sql, `SELECT * FROM grants WHERE used_by = ? AND spawn = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1`, target.id)
      const tty = actor.kind === "human" && actor.tty
      if (!tty && grant?.issuer !== me.id && !this.ancestorsOf(target).includes(me.id)) {
        if (me.kind === "agent" && !this.discovers(me, target)) throw unreachable(params.endpoint)
        throw new RelayError("unauthorized", "only the worker's spawner, an ancestor or the human at a terminal ends it")
      }
      const held = target.wake === "spawn-resume" || target.hold_ref !== null || target.hibernate === SPAWN_PROVIDER
      if (grant) this.sql.all(`UPDATE grants SET ended_at = COALESCE(ended_at, ?) WHERE token_hash = ?`, this.now(), grant.token_hash)
      this.sql.all(`UPDATE endpoints SET wake = CASE WHEN wake = 'spawn-resume' THEN NULL ELSE wake END, hold_ref = NULL WHERE id = ?`, target.id)
      if (target.hibernate === SPAWN_PROVIDER) this.clearHibernation(target.id)
      this.audit("spawn_end", target.id, null, { by: this.address(me), target: this.address(target), held })
      return { endpoint: this.view(this.byId(target.id)!), held }
    })
  }

  /**
   * a spawn's handback to its spawner `me`, the grant's issuer, from the worker (the relay when it never joined): past scopes, pair limits and
   * the judge, since the spawner minted the grant and is the recipient. One per grant (null once sent), in the thread the two last wrote in,
   * else one derived from the grant, naming by short id the spawner's messages the worker read, with when (one a background hook showed only
   * delivered, unless the worker then exited 0: its model had the next request), and those it left unread; its hop follows the worker's
   * causal hop, capped, and a full thread drops it (null). A worker that never joined or exited non-zero gets its `stderr` last, labelled, its
   * output cut from the front so both stay within ${LIMITS.handbackBytes} bytes
   */
  private handback(
    me: EndpointRow,
    grant: GrantRow,
    spender: EndpointRow | undefined,
    code: number,
    whole: string,
    taken: string[],
    lost = 0,
    exits: number[] = [],
    stderr = "",
  ): string | null {
    if (grant.handback !== null) return null
    const tail = stderr && (!spender || code !== 0) ? `${STDERR_LABEL}\n${stderr}` : ""
    const output = tail ? handbackOutput(whole, false, LIMITS.handbackBytes - utf8Bytes(tail) - 2) : whole
    const now = this.now()
    const stable = this.handbackThread(grant)
    const last = spender
      ? one<{ thread: string }>(
          this.sql,
          `SELECT m.thread FROM messages m JOIN deliveries d ON d.message_id = m.id
           WHERE ((m.from_ep = ? AND d.endpoint = ?) OR (m.from_ep = ? AND d.endpoint = ?)) AND m.created_at >= ? ORDER BY m.created_at DESC, d.seq DESC LIMIT 1`,
          spender.id,
          me.id,
          me.id,
          spender.id,
          grant.created_at,
        )
      : undefined
    const full = (thread: string) => one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM messages WHERE thread = ?`, thread)!.n >= LIMITS.threadMax
    const thread = [last?.thread, stable].find((t): t is string => t !== undefined && !full(t))
    if (!thread) return null
    const sent =
      spender !== undefined &&
      one(
        this.sql,
        `SELECT 1 FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE m.from_ep = ? AND d.endpoint = ? AND m.created_at >= ?
         AND m.id NOT IN (SELECT ref FROM audit WHERE event = 'spawn_exit' AND ref IS NOT NULL) LIMIT 1`,
        spender.id,
        me.id,
        grant.created_at,
      ) !== undefined
    const exit = `exit ${code}`
    const body = !spender
      ? [
          `worker ${grant.name ? `${grant.name} ` : ""}finished (${exit}), not a relay agent`,
          lost ? `${lost} message${lost === 1 ? "" : "s"} you sent it never reached it: it never joined the relay` : "",
          output,
          tail,
        ]
      : [
          ...(output
            ? [`worker ${this.address(spender)} finished (${exit})`, output]
            : [
                sent
                  ? `worker ${this.address(spender)} exited (${exit}) with no final output`
                  : `worker ${this.address(spender)} exited without replying (${exit})`,
              ]),
          tail,
        ]
    if (spender) {
      const unapplied = this.steersOf(grant, spender, now, taken)
      const steers = [
        ...this.readSteers(grant, spender, taken).map(
          (row) => `your steer ${shortId(row.id)} was ${row.deferred_ack && code !== 0 ? "delivered" : "read"} at ${clock(row.acked_at)}`,
        ),
        ...(unapplied.length ? this.unappliedLines(spender, grant, unapplied, now, exits) : []),
      ]
      if (steers.length) body.push(steers.join("\n"))
      if (spender.wake === "spawn-resume") body.push(heldLine(this.address(spender)))
    }
    const causal = spender && spender.last_received_at !== null && spender.last_received_at >= now - LIMITS.causalWindowS * 1000
    const hop = causal ? Math.min((spender.last_received_hop ?? 0) + 1, LIMITS.hopMax) : 0
    const { id } = this.post(spender ?? this.byHandle(SYSTEM_HANDLE)!, me, body.filter(Boolean).join("\n\n"), { kind: "message", thread, hop })
    this.sql.all(`UPDATE grants SET handback = ? WHERE token_hash = ?`, id, grant.token_hash)
    return id
  }

  /** the stable thread id a grant's handback falls back to */
  private handbackThread(grant: GrantRow): string {
    return `thr_${grant.created_at.toString(36).padStart(9, "0")}${this.hash(`handback:${grant.token_hash}`).slice(0, 16)}`
  }

  /**
   * a held spawn's handback for its later run `run` (2 and up) to the issuer `me`: one per run, none for a run at or below the last one handed
   * back. From the worker, kind `message`, a reply to `replyTo` when that is the issuer's message to the worker, else to the first handback,
   * in that message's thread (the grant's stable thread without either, none when the thread is full). The body is the first run's without
   * the steer lines
   */
  private runHandback(
    me: EndpointRow,
    grant: GrantRow,
    spender: EndpointRow,
    run: number,
    code: number,
    output: string,
    stderr: string,
    replyTo?: string,
  ): string | null {
    if (!one(this.sql, `UPDATE grants SET run = ? WHERE token_hash = ? AND COALESCE(run, 1) < ? RETURNING token_hash`, run, grant.token_hash, run)) return null
    const full = (thread: string) => one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM messages WHERE thread = ?`, thread)!.n >= LIMITS.threadMax
    const woke =
      replyTo === undefined
        ? undefined
        : one<{ id: string; thread: string }>(
            this.sql,
            `SELECT m.id, m.thread FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE m.id = ? AND m.from_ep = ? AND d.endpoint = ?`,
            replyTo,
            me.id,
            spender.id,
          )
    const first =
      grant.handback === null ? undefined : one<{ id: string; thread: string }>(this.sql, `SELECT id, thread FROM messages WHERE id = ?`, grant.handback)
    const anchor = [woke, first].find((m): m is { id: string; thread: string } => m !== undefined && !full(m.thread))
    const stable = this.handbackThread(grant)
    const thread = anchor?.thread ?? (full(stable) ? undefined : stable)
    if (!thread) return null
    const address = this.address(spender)
    const tail = stderr && code !== 0 ? `${STDERR_LABEL}\n${stderr}` : ""
    const kept = tail ? handbackOutput(output, false, LIMITS.handbackBytes - utf8Bytes(tail) - 2) : output
    const body = [
      kept ? `worker ${address} finished (exit ${code})` : `worker ${address} exited without replying (exit ${code})`,
      kept,
      tail,
      spender.wake === "spawn-resume" ? heldLine(address) : "",
    ]
    const now = this.now()
    const causal = spender.last_received_at !== null && spender.last_received_at >= now - LIMITS.causalWindowS * 1000
    const hop = causal ? Math.min((spender.last_received_hop ?? 0) + 1, LIMITS.hopMax) : 0
    return this.post(spender, me, body.filter(Boolean).join("\n\n"), { kind: "message", thread, hop, ...(anchor ? { replyTo: anchor.id } : {}) }).id
  }

  /**
   * one line per steer a worker never applied: its text clipped to one line, its short id, and when it arrived: after the worker exited (its
   * last session_end after its last step, else now; with spawn's `exits`, one per run it resumed, the first exit after the steer), or that
   * many seconds before, after the worker's last step before then or before it, unread
   */
  private unappliedLines(spender: EndpointRow, grant: GrantRow, rows: MessageRow[], now: number, exits: number[] = []): string[] {
    const last = (where: string, until: number) =>
      one<{ at: number | null }>(
        this.sql,
        `SELECT MAX(at) AS at FROM activity WHERE endpoint = ? AND agent IS NULL AND at >= ? AND at <= ? AND ${where}`,
        spender.id,
        grant.created_at,
        until,
      )!.at
    const end = last(`kind = 'session_end'`, now)
    const lastStep = last(`kind <> 'session_end'`, now)
    const fallback = end !== null && (lastStep === null || end >= lastStep) ? end : now
    return rows.map((row) => {
      const exited = exits.length ? (exits.find((at) => at >= row.created_at) ?? -1) : fallback
      const step = exits.length ? last(`kind <> 'session_end'`, Math.max(exited, 0)) : lastStep
      const line = redactSecrets(stripControl(row.body).replace(/\s+/g, " ").trim())
      const text = line.length > STEER_CLIP ? `${line.slice(0, /[\ud800-\udbff]/.test(line[STEER_CLIP - 1]!) ? STEER_CLIP - 1 : STEER_CLIP)}...` : line
      const seconds = Math.round((exited - row.created_at) / 1000)
      const before = `arrived ${seconds < 1 ? "under 1" : seconds} s before it exited`
      const when =
        row.created_at > exited
          ? "arrived after it exited"
          : step === null
            ? before
            : row.created_at > step
              ? `${before}, after its last step`
              : `${before}, unread`
      return `steer not applied: "${text}" (${shortId(row.id)}, ${when})`
    })
  }

  /** runtime groups: create, add, remove, rules, ls, show, drop, and pin or unpin for the human at a terminal */
  group(
    actor: ScopeActor,
    params: {
      action: "create" | "add" | "remove" | "rules" | "ls" | "show" | "drop" | "pin" | "unpin"
      name?: string
      endpoint?: string
      in?: string[]
      out?: string[]
      rules?: string[]
    },
  ): unknown {
    const me = this.actorRow(actor)
    const p = params ?? ({} as typeof params)
    this.needTerminal(actor, me, p.name === undefined ? undefined : `group:${String(p.name)}`)
    const now = this.now()
    if (p.action === "ls") {
      return this.allGroups()
        .filter((group) => this.seesGroup(me, group))
        .flatMap((group) => {
          const listed = {
            name: group.name,
            owner: this.ownerName(group.owner),
            members: this.membersFor(me, group).length,
            pinned: group.pinned,
            policy: group.policy,
          }
          const shadowed = me.kind === "human" && group.policy ? one<GroupRow>(this.sql, `SELECT * FROM groups WHERE name = ?`, group.name) : undefined
          if (!shadowed) return [listed]
          const ignored = {
            name: shadowed.name,
            owner: this.ownerName(shadowed.owner),
            members: this.runtimeMembers(shadowed.name).length,
            pinned: shadowed.pinned === 1,
            policy: false,
            ignored: "a policy group has this name",
          }
          return [listed, ignored]
        })
    }
    if (p.action === "create") {
      const name = groupName(p.name)
      const taken = this.groupByName(name)
      if (taken) {
        const owner = taken.policy ? "the policy file" : (this.namer(me).place(taken.owner) ?? "another endpoint")
        throw new RelayError("invalid_params", `group ${name} is owned by ${owner}; pick another name`)
      }
      const rules = this.groupRules(me, p, {})
      return this.scopeTx(() => {
        this.sql.all(
          `INSERT INTO groups (name, owner, tree, rules, pinned, created_at, id) VALUES (?, ?, ?, ?, 0, ?, ?)`,
          name,
          me.id,
          me.kind === "agent" ? (me.tree ?? me.id) : null,
          JSON.stringify(rules),
          now,
          newId("grp", now),
        )
        this.audit("scope_group", me.id, null, { ...this.actorDetail(actor, me), target: `group:${name}`, action: "create", after: rules })
        return this.groupView(this.groupByName(name)!, me)
      })
    }
    const group = this.groupByName(groupName(p.name))
    const underOwner = p.action === "add" && group !== undefined && this.descendantOf(me.id, group.owner)
    if (!group || !(this.seesGroup(me, group) || underOwner)) throw new RelayError("not_found", `no group ${String(p.name)}`)
    const detail = { ...this.actorDetail(actor, me), target: `group:${group.name}`, action: p.action }
    const refused = (reason: string, message: string) => this.scopeRefused(actor, me, { target: `group:${group.name}`, reason }, message)
    const steward = this.stewards(me, group)
    const ruled = !!(group.rules.in || group.rules.out)
    const loosensAll = () =>
      this.runtimeMembers(group.name).every(
        (row) => (row.id === me.id || this.authority(me, row)) && this.mayLoosen(me, row, { by: `group:${group.name}`, owner: group.owner }),
      )
    switch (p.action) {
      case "show":
        return this.groupView(group, me)
      case "add": {
        if (group.policy) throw refused("policy group", "the policy file sets this group's members")
        const target = p.endpoint === undefined ? me : this.scopeTarget(me, p.endpoint)
        if (target.kind !== "agent") throw new RelayError("invalid_params", "only agent endpoints join groups")
        if (target.id !== me.id && this.narrowOnly(actor)) throw refused("narrow only", "adding another endpoint to a group needs an authenticated session")
        const ok =
          target.id === me.id
            ? target.id === group.owner || this.descendantOf(target.id, group.owner)
            : me.kind === "human" || (me.id === group.owner && this.descendantOf(target.id, me.id)) || this.administers(me.id, this.scopeSubject(target))
        if (!ok) throw refused("no authority", `no authority to add ${this.address(target)} to ${group.name}`)
        this.scopeTx(() => {
          this.join(group.name, target.id, me.id, now)
          this.audit("scope_group", target.id, null, { ...detail, endpoint: this.address(target) })
          if (target.id !== me.id && this.authority(me, target)) {
            const sel = [`group:${group.name}`]
            this.allowInto(me, target, { in: sel, out: sel }, { ...detail, via: this.address(me), target: this.address(target), group: group.name }, group.name)
          }
        })
        return { name: group.name, endpoint: this.address(target), member: true }
      }
      case "remove": {
        if (group.policy) throw refused("policy group", "the policy file sets this group's members")
        const named = steward && p.endpoint !== undefined ? this.lookup(p.endpoint) : undefined
        const member = (row: EndpointRow | undefined) =>
          row !== undefined && one(this.sql, `SELECT 1 FROM group_members WHERE name = ? AND endpoint = ?`, group.name, row.id) !== undefined
        const target = member(named) ? named! : p.endpoint === undefined ? me : this.scopeTarget(me, p.endpoint)
        if (!member(target)) throw new RelayError("not_found", `${this.address(target)} is not in ${group.name}`)
        if (ruled) {
          if (this.narrowOnly(actor)) throw refused("narrow only", "removing a member lifts the group's caps: it needs an authenticated session")
          if (!this.authority(me, target) || !this.mayLoosen(me, target, { by: `group:${group.name}`, owner: group.owner })) {
            throw refused("no authority", `removing ${this.address(target)} from ${group.name} lifts its caps, which needs widening authority`)
          }
        } else if (target.id !== me.id && me.kind !== "human" && me.id !== group.owner && !this.authority(me, target))
          throw refused("no authority", `no authority over ${this.address(target)}`)
        this.scopeTx(() => {
          this.leave(group.name, target.id)
          this.audit("scope_group", target.id, null, { ...detail, endpoint: this.address(target) })
        })
        return { name: group.name, endpoint: this.address(target), member: false }
      }
      case "rules": {
        if (group.policy) throw refused("policy group", "the policy file sets this group's rules")
        if (!steward) throw refused("no authority", `only the owner, its ancestors, an admin or the human change ${group.name}'s rules`)
        const via = me.kind === "human" ? "human" : me.id
        const rules = this.groupRules(me, p, group.rules, via)
        const widened = (["in", "out"] as const).some((dir) => {
          const before = group.rules[dir]
          return !!before && (!rules[dir] || rules[dir].some((entry) => !before.some((e) => e.sel === entry.sel && e.group === entry.group)))
        })
        if (widened && this.narrowOnly(actor)) throw refused("narrow only", "loosening a group needs an authenticated session")
        if (widened && !loosensAll())
          throw refused("no authority", `loosening ${group.name} lifts caps on its members, which needs widening authority over each`)
        this.scopeTx(() => {
          this.sql.all(`UPDATE groups SET rules = ? WHERE name = ?`, JSON.stringify(rules), group.name)
          this.audit("scope_group", me.id, null, { ...detail, ...(widened ? { via: this.address(me) } : {}), before: group.rules, after: rules })
        })
        return this.groupView(this.groupByName(group.name)!, me)
      }
      case "drop": {
        if (group.policy) throw refused("policy group", "the policy file defines this group")
        if (!steward) throw refused("no authority", `only the owner, its ancestors, an admin or the human drop ${group.name}`)
        if (ruled && this.narrowOnly(actor)) throw refused("narrow only", "dropping a group lifts its caps: it needs an authenticated session")
        if (ruled && !loosensAll()) throw refused("no authority", `dropping ${group.name} lifts caps on its members, which needs widening authority over each`)
        this.scopeTx(() => {
          this.dropGroup(group.name)
          this.audit("scope_group", me.id, null, detail)
        })
        return { name: group.name, dropped: true }
      }
      case "pin":
      case "unpin": {
        if (actor.kind !== "human" || !actor.tty) throw refused("human only", "only the human at a terminal pins a group")
        if (group.policy) throw new RelayError("invalid_params", "a policy group is always pinned")
        this.sql.all(`UPDATE groups SET pinned = ? WHERE name = ?`, p.action === "pin" ? 1 : 0, group.name)
        this.audit("scope_group", me.id, null, detail)
        return this.groupView(this.groupByName(group.name)!, me)
      }
    }
    throw new RelayError("invalid_params", "action is create, add, remove, rules, ls, show, drop, pin or unpin")
  }

  /** admins of a tree or a group: granted and revoked by the human at a terminal; ls lists them (an agent sees its own), a row of a dropped group as stale */
  admin(actor: ScopeActor, params: { action: "grant" | "revoke" | "ls"; subject?: string; tree?: string; group?: string }): unknown {
    const me = this.actorRow(actor)
    const p = params ?? ({} as typeof params)
    this.needTerminal(actor, me, p.subject)
    const listed = (rows: { subject: string; scope_kind: string; scope: string; scope_id: string | null; granted_at: number }[]) =>
      rows.map((row) => ({
        subject: this.addressOf(row.subject),
        ...(row.scope_kind === "tree" ? { tree: this.addressOf(row.scope) } : { group: row.scope }),
        granted_at: iso(row.granted_at),
        ...(row.scope_kind === "group" && !this.grantedOn(row) ? { stale: true } : {}),
      }))
    if (p.action === "ls") {
      return listed(
        this.sql.all(
          `SELECT * FROM admins WHERE revoked_at IS NULL ${me.kind === "agent" ? "AND subject = ?" : ""} ORDER BY granted_at`,
          ...(me.kind === "agent" ? [me.id] : []),
        ),
      )
    }
    if (p.action !== "grant" && p.action !== "revoke") throw new RelayError("invalid_params", "action is grant, revoke or ls")
    if (actor.kind !== "human" || !actor.tty)
      throw this.scopeRefused(actor, me, { target: String(p.subject), reason: "human only" }, "only the human at a terminal grants or revokes admins")
    const subject = this.resolve(p.subject)
    if (subject.kind !== "agent") throw new RelayError("invalid_params", "an admin is an agent endpoint")
    if ((p.tree === undefined) === (p.group === undefined)) throw new RelayError("invalid_params", "name a tree or a group")
    let kind: "tree" | "group"
    let scope: string
    let scopeId: string | null = null
    if (p.tree !== undefined) {
      const root = this.resolve(p.tree)
      if (root.kind !== "agent") throw new RelayError("invalid_params", "a tree is named by one of its endpoints")
      kind = "tree"
      scope = root.tree ?? root.id
    } else {
      const group = this.groupByName(groupName(p.group))
      if (!group && p.action === "grant") throw new RelayError("not_found", `no group ${String(p.group)}`)
      kind = "group"
      scope = groupName(p.group)
      scopeId = group ? this.groupId(group) : null
    }
    const now = this.now()
    return this.scopeTx(() => {
      const held = `subject = ? AND scope_kind = ? AND scope = ? AND revoked_at IS NULL`
      if (p.action === "grant") {
        const active = one(this.sql, `SELECT 1 FROM admins WHERE ${held} AND scope_id IS ?`, subject.id, kind, scope, scopeId)
        if (!active) {
          this.sql.all(`UPDATE admins SET revoked_at = ? WHERE ${held}`, now, subject.id, kind, scope)
          this.sql.all(`INSERT INTO admins (subject, scope_kind, scope, scope_id, granted_at) VALUES (?, ?, ?, ?, ?)`, subject.id, kind, scope, scopeId, now)
        }
      } else {
        if (!one(this.sql, `SELECT 1 FROM admins WHERE ${held}`, subject.id, kind, scope))
          throw new RelayError("not_found", `${this.address(subject)} is no admin of that ${kind}`)
        this.sql.all(`UPDATE admins SET revoked_at = ? WHERE ${held}`, now, subject.id, kind, scope)
      }
      this.audit("scope_admin", subject.id, null, {
        ...this.actorDetail(actor, me),
        target: this.address(subject),
        action: p.action,
        ...(kind === "tree" ? { tree: this.addressOf(scope) } : { group: scope }),
      })
      return listed(this.sql.all(`SELECT * FROM admins WHERE subject = ? AND revoked_at IS NULL ORDER BY granted_at`, subject.id))
    })
  }

  /**
   * whether `from` may message `to` and why; an agent asks about a pair holding itself or an endpoint it has authority over, each side one of
   * those or one it can see, else not_found
   */
  why(actor: ScopeActor, from: string, to: string): WhyResult {
    const me = this.actorRow(actor)
    const a = this.resolve(from)
    const b = this.resolve(to)
    if (me.kind === "agent") {
      const mine = (row: EndpointRow) => row.id === me.id || this.authority(me, row)
      const hidden = [a, b].findIndex((row) => !mine(row) && !this.sees(me, row))
      if (hidden >= 0 || !(mine(a) || mine(b))) throw unreachable(hidden === 1 ? to : from)
    } else if (!this.atTerminal(actor)) {
      const hidden = [a, b].findIndex((row) => row.id !== me.id && !this.mayMessage(me, row, true))
      if (hidden >= 0) throw unreachable(hidden === 0 ? from : to)
    }
    const decision = this.decide(this.scopeWorld(me.kind === "agent" ? me : undefined), a, b)
    const policy = policyRefusal(this.policy, this.subject(a), this.subject(b), this.policyBound)
    const limits = this.pairLimits(a, b)
    return {
      allowed: decision.allowed && policy === null && !limits.held,
      reasons: [...decision.reasons, ...(policy ? [policy] : []), ...limits.lines],
      ...(limits.pair ? { pair: limits.pair } : {}),
    }
  }

  /** why the scope refuses a message from `from` to `to`, or null; a reply to a message `to` sent `from` passes; `strict` drops an ancestor's pass */
  protected scopeRefusal(from: EndpointRow, to: EndpointRow, options: { replyTo?: MessageRow; unverified?: boolean; strict?: boolean } = {}): string | null {
    const decision = this.decide(this.scopeWorld(), from, to, options.replyTo, options.unverified, options.strict)
    return decision.allowed ? null : decision.reasons.at(-1)!
  }

  /**
   * throws when the scope refuses a message from `from` to `to`, and audits why: scope_refused with the refusing rule to an agent with authority
   * over `to`, else not_found, as for an unknown `address`
   */
  protected checkScope(from: EndpointRow, to: EndpointRow, address: string, replyTo?: MessageRow, unverified?: boolean): void {
    const decision = this.decide(this.scopeWorld(from, false), from, to, replyTo, unverified === true)
    if (decision.allowed) return
    const refusal = decision.reasons.at(-1)!
    this.audit("scope_refused", from.id, null, { from: this.address(from), to: this.address(to), dir: decision.dir, reason: refusal })
    if (from.kind === "agent" && this.authority(from, to)) throw new RelayError("scope_refused", refusal)
    throw unreachable(address)
  }

  /** where a local endpoint sits: computed from its columns, its groups and the policy's groups */
  protected scopeSubject(row: EndpointRow): ScopeSubject {
    const tree = row.tree ?? row.id
    const root = tree === row.id ? row : this.byId(tree)
    const fixed = new Set((this.policy?.groups ?? []).map((group) => group.name))
    const runtime = this.sql
      .all<{ name: string }>(`SELECT name FROM group_members WHERE endpoint = ? ORDER BY name`, row.id)
      .map((r) => r.name)
      .filter((name) => !fixed.has(name))
    const scope: ScopeSubject = {
      id: row.id,
      tree,
      ancestors: this.ancestorsOf(row),
      groups: runtime,
      rootHandle: root?.handle ?? "",
      machine: this.scopeMachine(row),
      local: true,
    }
    const base = { ...this.plainSubject(row), scope }
    const fromPolicy = (this.policy?.groups ?? [])
      .filter((group) => !runtime.includes(group.name) && group.members.some((sel) => matches(sel, base, undefined, this.policyBound)))
      .map((group) => group.name)
    return { ...scope, groups: [...runtime, ...fromPolicy] }
  }

  protected scopeMachine(_row: EndpointRow): string | null {
    return this.hostMachine
  }

  private decide(world: ScopeWorld, a: EndpointRow, b: EndpointRow, replyTo?: MessageRow, unverified = false, strict = false): ScopeDecision {
    const solicited =
      replyTo !== undefined && replyTo.from_ep === b.id && a.id !== b.id && replyTo.created_at > (b.reset_at ?? -Infinity) && this.got(replyTo, a)
    return scopeDecision(world, world.node(a.id) ?? this.scopeNode(a), world.node(b.id) ?? this.scopeNode(b), {
      humanAlways: this.defaults().humanAlways,
      solicited,
      linked: a.id !== b.id && this.linkedAcross(a, b),
      unverified,
      strict,
    })
  }

  /** whether `row` got `message` since its last takeover: a delivery here, or for another machine's row, an address the message was sent to */
  private got(message: MessageRow, row: EndpointRow): boolean {
    if (row.reset_at !== null && message.created_at <= row.reset_at) return false
    if (one(this.sql, `SELECT 1 FROM deliveries WHERE message_id = ? AND endpoint = ?`, message.id, row.id)) return true
    return !this.localRow(row) && message.to_addr.split(",").some((address) => this.lookup(address)?.id === row.id)
  }

  /** reasons are written for `viewer`; with `hide`, a widener it does not see is named only as an ancestor or admin */
  protected scopeWorld(viewer?: EndpointRow, hide = true): ScopeWorld {
    const cache = new Map<string, ScopeNode | null>()
    const memo = { ancestors: new Map<string, string[]>(), limited: new Map<string, boolean>() }
    let shown: Set<string> | undefined
    const visible = (viewer: EndpointRow) => {
      shown ??= new Set(this.visibleRows(viewer).map((row) => row.id))
      return shown
    }
    return {
      ...(viewer ? { viewer: viewer.id } : {}),
      ...(viewer && hide ? { label: (id: string) => (visible(viewer).has(id) ? undefined : "an ancestor or admin") } : {}),
      node: (id) => {
        if (!cache.has(id)) {
          const row = this.byId(id)
          const outer = this.scopeMemo
          this.scopeMemo = memo
          try {
            cache.set(id, row && !row.handle.startsWith(GONE_PREFIX) ? this.scopeNode(row) : null)
          } finally {
            this.scopeMemo = outer
          }
        }
        return cache.get(id) ?? undefined
      },
      administers: (w, x) => x.subject.scope !== undefined && this.administers(w, x.subject.scope),
      group: (name) => {
        const group = GROUP_NAME.test(name) ? this.groupByName(name) : undefined
        return group ? { id: this.groupId(group), policy: group.policy, pinned: group.pinned } : undefined
      },
    }
  }

  /** an endpoint as the scope check sees it; a subclass supplies another machine's rows (their place, rules and caps) here */
  protected scopeNode(row: EndpointRow): ScopeNode {
    const subject = this.subject(row)
    const base = { id: row.id, address: this.address(row), subject, human: row.kind === "human" && row.handle === HUMAN_HANDLE }
    if (row.kind !== "agent" || !subject.scope) return { ...base, rules: {}, caps: { caps: [], allow: {} }, groups: [], policy: [] }
    const groups: ScopeGroupRules[] = []
    for (const name of subject.scope.groups) {
      const group = this.groupByName(name)
      if (group) groups.push({ name, owner: group.owner, ...group.rules })
    }
    const caps = this.capsOf(row)
    return {
      ...base,
      rules: json<ScopeRules>(row.rules, {}),
      caps: { ...caps, caps: [...caps.caps, ...this.inheritedCaps(row, caps)] },
      groups,
      policy: this.policyCaps(subject),
    }
  }

  private policyCaps(subject: PolicySubject): ScopePolicyCap[] {
    return (this.policy?.rules ?? []).flatMap((rule) =>
      rule.scope && matches(rule.match, subject, undefined, this.policyBound)
        ? this.presetDirs().map((dir) => ({ dir, match: rule.match, sels: rule.scope!.map((sel) => this.policyEntry(sel)) }))
        : [],
    )
  }

  /** whether a policy `group:<name>` may match the group of that name now: a policy group always, any other only the one it bound to at load */
  private readonly policyBound = (name: string): boolean => {
    const bound = this.policyBinds.get(name)
    if (bound === undefined) return true
    const group = this.groupByName(name)
    return group !== undefined && this.groupId(group) === bound
  }

  /** a policy selector as an entry: a `group:<name>` naming no policy group carries the identity it bound to at load */
  private policyEntry(sel: string): ScopeEntry {
    const bound = sel.startsWith("group:") ? this.policyBinds.get(sel.slice("group:".length)) : undefined
    return bound === undefined ? { sel } : { sel, group: bound }
  }

  /**
   * under child_default inherit, a limited parent's limits on its child, derived live: `*` clipped via the parent in both directions, so the
   * child reaches only what the parent reaches; a parent row gone from the table counts as limited. Only the human lifts them
   */
  private inheritedCaps(row: EndpointRow, caps: ScopeCaps, depth = 0): ScopeCap[] {
    const dirs = (["in", "out"] as const).filter((dir) => !caps.lifted?.includes(dir))
    if (!row.parent_ep || !dirs.length || this.defaults().childDefault !== "inherit") return []
    const parent = this.byId(row.parent_ep)
    if (parent && !this.limited(parent, depth + 1)) return []
    return dirs.map((dir) => ({
      id: `inherited:${dir}`,
      dir,
      by: "inherited",
      sels: [{ sel: "*", via: row.parent_ep!, base: true }, ...(caps.allow[`inherited:${dir}`] ?? [])],
    }))
  }

  /** whether a stored, group or policy cap limits `row`, or an inherited one does */
  private limited(row: EndpointRow, depth: number): boolean {
    const known = this.scopeMemo?.limited.get(row.id)
    if (known !== undefined) return known
    const limited = this.limitedNow(row, depth)
    this.scopeMemo?.limited.set(row.id, limited)
    return limited
  }

  private limitedNow(row: EndpointRow, depth: number): boolean {
    if (depth > LIMITS.depthMax + 1) return true
    const caps = this.capsOf(row)
    if (caps.caps.length) return true
    const subject = this.subject(row)
    if (
      subject.scope?.groups.some((name) => {
        const group = this.groupByName(name)
        return !!group && !!(group.rules.in || group.rules.out)
      })
    )
      return true
    if (this.policyCaps(subject).length) return true
    return this.inheritedCaps(row, caps, depth).length > 0
  }

  /** for an agent viewer, a root, parent or widener it does not see is null or named only as an ancestor or admin */
  private scopeViewOf(row: EndpointRow, viewer: EndpointRow): ScopeView {
    const node = this.scopeNode(row)
    const { name, place } = this.namer(viewer)
    const entries = (list: ScopeEntry[]) => list.map((entry) => (entry.via ? { sel: entry.sel, via: name(entry.via) } : { sel: entry.sel }))
    const caps: ScopeCap[] = node.caps.caps.map((cap) => ({
      id: cap.id,
      dir: cap.dir,
      by: cap.by === "inherited" ? `inherited from ${name(cap.sels[0]!.via!)}` : name(cap.by),
      sels: entries(cap.sels),
    }))
    for (const group of node.groups) {
      for (const dir of ["in", "out"] as const) {
        const rules = group[dir]
        if (rules)
          caps.push({
            id: groupCapKey(group.name, dir),
            dir,
            by: `group:${group.name}`,
            sels: entries([...rules, ...(node.caps.allow[groupCapKey(group.name, dir)] ?? [])]),
          })
      }
    }
    for (const cap of node.policy) caps.push({ id: `policy:${cap.match}:${cap.dir}`, dir: cap.dir, by: "policy", sels: entries(cap.sels) })
    return {
      address: this.address(row),
      tree: place(row.tree ?? row.id),
      parent: row.parent_ep ? place(row.parent_ep) : null,
      depth: row.depth ?? 0,
      rules: { ...(node.rules.in ? { in: node.rules.in } : {}), ...(node.rules.out ? { out: node.rules.out } : {}) },
      caps,
      groups: node.subject.scope?.groups ?? [],
      preset: presetOf(node, this.defaults().symmetric),
    }
  }

  private defaults(): { humanAlways: boolean; symmetric: boolean; childDefault: ScopePreset | "inherit"; verifyLineage: "spike" | boolean } {
    const d = this.policy?.defaults ?? {}
    return {
      humanAlways: d.human_always ?? true,
      symmetric: d.symmetric_presets ?? true,
      childDefault: d.child_default ?? "inherit",
      verifyLineage: d.verify_lineage ?? "spike",
    }
  }

  private presetDirs(): ScopeDirection[] {
    return this.defaults().symmetric ? ["in", "out"] : ["out"]
  }

  private actorRow(actor: ScopeActor): EndpointRow {
    if (actor?.kind === "human") return this.byHandle(HUMAN_HANDLE)!
    if (actor?.kind === "endpoint" && (actor.auth === "session" || actor.auth === "self" || actor.auth === "lineage")) {
      const row = this.mustEndpoint(actor.id)
      if (row.kind !== "agent") throw new RelayError("unauthorized", "this connection has no agent endpoint")
      return row
    }
    throw new RelayError("invalid_params", "an actor is the human or an endpoint")
  }

  private atTerminal(actor: ScopeActor): boolean {
    return actor.kind === "human" && actor.tty
  }

  /** the human's powers need a terminal: without one, a claim to be the human is any local process's */
  private needTerminal(actor: ScopeActor, me: EndpointRow, target: unknown): void {
    if (actor.kind !== "human" || actor.tty) return
    throw this.scopeRefused(
      actor,
      me,
      { target: target === undefined ? null : String(target), reason: "no terminal" },
      "only the human at a terminal sets caps, grants, groups and admins",
    )
  }

  /** a plain shell's lineage and the human without a terminal may only narrow; the agent's own harness shell (`self`) acts as its session */
  private narrowOnly(actor: ScopeActor): boolean {
    return actor.kind === "human" ? !actor.tty : actor.auth === "lineage"
  }

  private actorDetail(actor: ScopeActor, me: EndpointRow): { by: string; auth: string } {
    return { by: this.address(me), auth: actor.kind === "human" ? (actor.tty ? "tty" : "no-tty") : actor.auth }
  }

  /** a refusal with its audit row; inside {@link scopeTx} the row is written after the rollback */
  private scopeRefused(actor: ScopeActor, me: EndpointRow, detail: Record<string, unknown>, message: string): RelayError {
    const error = new RelayError("scope_refused", message)
    const row = { endpoint: me.id, detail: { ...this.actorDetail(actor, me), ...detail } }
    if (this.scopeDepth > 0) this.deferred.set(error, row)
    else this.audit("scope_refused", row.endpoint, null, row.detail)
    return error
  }

  private scopeTx<T>(fn: () => T): T {
    this.scopeDepth++
    try {
      return this.tx(fn)
    } catch (error) {
      const row = error instanceof RelayError ? this.deferred.get(error) : undefined
      if (row && this.scopeDepth === 1) this.audit("scope_refused", row.endpoint, null, row.detail)
      throw error
    } finally {
      this.scopeDepth--
    }
  }

  /** an agent endpoint the actor finds by address: itself, one it has authority over, or one it may message; else not_found, as for an unknown one */
  private scopeTarget(me: EndpointRow, address: unknown): EndpointRow {
    const row = this.resolve(address)
    if (row.kind !== "agent" || !this.localRow(row) || (me.kind === "agent" && !this.discovers(me, row))) {
      throw unreachable(address)
    }
    return row
  }

  /** whether `a` may message `b` or `b` may message `a`; an ancestor's pass down makes the descendant visible to it, not it to the descendant */
  private sees(a: EndpointRow, b: EndpointRow): boolean {
    return this.mayMessage(a, b) || this.mayMessage(b, a, false, true)
  }

  private mayMessage(from: EndpointRow, to: EndpointRow, unverified = false, strict = false): boolean {
    return (
      this.scopeRefusal(from, to, { unverified, strict }) === null &&
      policyRefusal(this.policy, this.subject(from), this.subject(to), this.policyBound) === null
    )
  }

  /** the human; an ancestor; an admin of the endpoint's tree or of a group it is in. Never the endpoint itself */
  private authority(w: EndpointRow, d: EndpointRow): boolean {
    if (w.kind === "human") return true
    if (w.kind !== "agent" || w.id === d.id) return false
    return this.ancestorsOf(d).includes(w.id) || this.administers(w.id, this.scopeSubject(d))
  }

  /**
   * whether `me` may loosen a cap on `d`: the human any but the policy's; an admin any but the policy's and the human's; otherwise caps set by
   * `me` or its descendants, and caps of groups owned by `me` or its descendants
   */
  private mayLoosen(me: EndpointRow, d: EndpointRow, cap: { by: string; owner?: string }): boolean {
    const setter = cap.owner ?? cap.by
    if (cap.by === "policy" || setter === "policy") return false
    if (me.kind === "human") return true
    if (setter === "inherited") return false
    if (setter === "human" || this.byId(setter)?.kind === "human") return false
    if (this.administers(me.id, this.scopeSubject(d))) return true
    return setter === me.id || this.descendantOf(setter, me.id)
  }

  /** whether `w` administers `x`'s tree or a group `x` is in; a group admin row holds only for the group it was granted on */
  private administers(w: string, x: ScopeSubject): boolean {
    return this.adminRows(w).some((row) => (row.scope_kind === "tree" ? row.scope === x.tree : x.groups.includes(row.scope) && this.grantedOn(row)))
  }

  private adminOfGroup(w: string, group: Group): boolean {
    return this.adminRows(w).some((row) => (row.scope_kind === "tree" ? row.scope === (group.tree ?? "") : row.scope === group.name && this.grantedOn(row)))
  }

  private adminRows(w: string): { scope_kind: string; scope: string; scope_id: string | null }[] {
    return this.sql.all(`SELECT scope_kind, scope, scope_id FROM admins WHERE subject = ? AND revoked_at IS NULL`, w)
  }

  /** whether a group admin row's group is the one of that name now; a row without an identity holds for none */
  private grantedOn(row: { scope: string; scope_id: string | null }): boolean {
    if (row.scope_id === null) return false
    const group = this.groupByName(row.scope)
    return group !== undefined && this.groupId(group) === row.scope_id
  }

  /** ancestor ids, nearest first */
  private ancestorsOf(row: EndpointRow): string[] {
    const memo = this.scopeMemo?.ancestors
    const hit = memo?.get(row.id)
    if (hit) return hit
    const out: string[] = []
    let id = row.parent_ep
    while (id && id !== row.id && !out.includes(id) && out.length <= LIMITS.depthMax) {
      out.push(id)
      id = this.byId(id)?.parent_ep ?? null
    }
    memo?.set(row.id, out)
    if (memo && !id) for (const [i, above] of out.entries()) memo.set(above, out.slice(i + 1))
    return out
  }

  private descendantOf(id: string, ancestor: string): boolean {
    const row = this.byId(id)
    return row !== undefined && this.ancestorsOf(row).includes(ancestor)
  }

  private capsOf(row: EndpointRow): ScopeCaps {
    const caps = json<Partial<ScopeCaps>>(row.caps, {})
    return { caps: caps.caps ?? [], allow: caps.allow ?? {}, ...(caps.lifted?.length ? { lifted: caps.lifted } : {}) }
  }

  private saveCaps(id: string, caps: ScopeCaps): void {
    for (const [key, entries] of Object.entries(caps.allow)) if (!entries.length) delete caps.allow[key]
    this.sql.all(
      `UPDATE endpoints SET caps = ? WHERE id = ?`,
      caps.caps.length || Object.keys(caps.allow).length || caps.lifted?.length ? JSON.stringify(caps) : null,
      id,
    )
  }

  private agentRows(): EndpointRow[] {
    return this.sql.all<EndpointRow>(`SELECT * FROM endpoints WHERE kind = 'agent' AND substr(handle, 1, ${GONE_PREFIX.length}) != '${GONE_PREFIX}'`)
  }

  private listed(): EndpointRow[] {
    return this.sql
      .all<EndpointRow>(
        `SELECT * FROM endpoints WHERE kind != 'system' AND substr(handle, 1, ${GONE_PREFIX.length}) != '${GONE_PREFIX}' ORDER BY kind DESC, handle`,
      )
      .filter((row) => this.listable(row))
  }

  /** whether a row is one of this relay's endpoints at all, rather than a stand-in for a sender it only received from */
  protected listable(_row: EndpointRow): boolean {
    return true
  }

  private ruleParams(params: { scope?: unknown; allow?: unknown; in?: unknown; out?: unknown }): {
    scope?: ScopePreset
    allow?: string[]
    in?: string[]
    out?: string[]
  } {
    const out: { scope?: ScopePreset; allow?: string[]; in?: string[]; out?: string[] } = {}
    if (params.scope !== undefined) {
      if (!SCOPE_PRESETS.includes(params.scope as ScopePreset)) throw new RelayError("invalid_params", `scope is one of ${SCOPE_PRESETS.join(", ")}`)
      out.scope = params.scope as ScopePreset
    }
    for (const key of ["allow", "in", "out"] as const) if (params[key] !== undefined) out[key] = selectorList(params[key], key)
    return out
  }

  /** a group's rules from `rules` (both directions under symmetric presets, else out), `in` and `out`; entries new to a direction carry `via` */
  private groupRules(me: EndpointRow, params: { in?: unknown; out?: unknown; rules?: unknown }, prev: Group["rules"], via?: string): Group["rules"] {
    const next: Partial<Record<ScopeDirection, string[]>> = {}
    if (params.rules !== undefined) for (const dir of this.presetDirs()) next[dir] = selectorList(params.rules, "rules", true)
    if (params.in !== undefined) next.in = selectorList(params.in, "in", true)
    if (params.out !== undefined) next.out = selectorList(params.out, "out", true)
    for (const sels of Object.values(next)) this.needGroups(me, sels, true)
    const rules: Group["rules"] = { ...prev }
    for (const [dir, sels] of Object.entries(next) as [ScopeDirection, string[]][]) {
      const before = prev[dir]
      rules[dir] = [...new Set(sels)].map((sel) => this.rebound(before?.find((entry) => entry.sel === sel)) ?? this.entry(sel, before && via ? via : undefined))
    }
    return rules
  }

  /** the policy's group of that name, else the runtime one: a runtime group a policy group shadows is ignored */
  private groupByName(name: string): Group | undefined {
    const fixed = this.policy?.groups?.find((group) => group.name === name)
    if (fixed) {
      const rules: Group["rules"] = {}
      const entries = (sels: string[]) => sels.map((sel) => this.policyEntry(sel))
      if (fixed.rules) for (const dir of this.presetDirs()) rules[dir] = entries(fixed.rules)
      if (fixed.in) rules.in = entries(fixed.in)
      if (fixed.out) rules.out = entries(fixed.out)
      return { name, owner: "policy", tree: null, rules, pinned: true, policy: true, id: "policy" }
    }
    const row = one<GroupRow>(this.sql, `SELECT * FROM groups WHERE name = ?`, name)
    if (!row) return undefined
    return { name: row.name, owner: row.owner, tree: row.tree, rules: json(row.rules, {}), pinned: row.pinned === 1, policy: false, id: row.id }
  }

  /**
   * refuses a `group:<name>` (but `group:self` in a group's rules) naming no group `me` may name: the human any group, an agent a policy or
   * pinned group, the human's, one in its fleet or one it sees. A group elsewhere answers as no group, so the refusal is no oracle
   */
  protected needGroups(me: EndpointRow, sels: string[] | null | undefined, groupRules = false): void {
    for (const sel of sels ?? []) {
      if (!sel.startsWith("group:") || (groupRules && sel === "group:self")) continue
      const name = sel.slice("group:".length)
      const group = GROUP_NAME.test(name) && name !== "self" ? this.groupByName(name) : undefined
      const nameable =
        !!group &&
        (me.kind === "human" || group.policy || group.pinned || group.tree === null || group.tree === (me.tree ?? me.id) || this.seesGroup(me, group))
      if (!nameable) throw new RelayError("invalid_params", `no group ${name}`)
    }
  }

  /** a group's identity, unique to its row: a dropped and remade group of the same name is another group */
  private groupId(group: Group): string {
    return group.id
  }

  /** a selector as set now, `via` a widener: a `group:<name>` binds to the group of that name, when there is one */
  private entry(sel: string, via?: string): ScopeEntry {
    const name = sel.startsWith("group:") ? sel.slice("group:".length) : undefined
    const group = name !== undefined && GROUP_NAME.test(name) && name !== "self" ? this.groupByName(name) : undefined
    return { sel, ...(via !== undefined ? { via } : {}), ...(group ? { group: this.groupId(group) } : {}) }
  }

  /** a kept entry set again: a `group:<name>` binds to the group of that name now, when there is one */
  private rebound(entry: ScopeEntry | undefined): ScopeEntry | undefined {
    const group = entry && this.entry(entry.sel).group
    return group === undefined || group === entry!.group ? entry : { ...entry!, group }
  }

  /** whether setting `next` as own rules in `dir` rebinds a `group:` selector the rules keep to another group */
  private rebindsRule(rules: ScopeRules, dir: ScopeDirection, next: string[] | null | undefined): boolean {
    const before = rules.groups?.[dir] ?? {}
    return (next ?? []).some((sel) => rules[dir]?.includes(sel) && (this.entry(sel).group ?? before[sel]) !== before[sel])
  }

  /** a new row's own rules: each `group:` selector bound to the group of that name now */
  protected boundRules(own: ScopeRules): ScopeRules {
    const rules: ScopeRules = {}
    for (const dir of ["in", "out"] as const) if (own[dir]) this.setRule(rules, dir, own[dir])
    return rules
  }

  /** sets own rules in `dir` to `next` (null clears them): a group selector binds to the group of that name now, or keeps its binding when there is none */
  private setRule(rules: ScopeRules, dir: ScopeDirection, next: string[] | null | undefined): void {
    const before = rules.groups?.[dir] ?? {}
    const bound: Record<string, string> = {}
    for (const sel of next ?? []) {
      const id = this.entry(sel).group ?? (rules[dir]?.includes(sel) ? before[sel] : undefined)
      if (id) bound[sel] = id
    }
    if (next) rules[dir] = next
    else delete rules[dir]
    const groups = { ...rules.groups }
    if (Object.keys(bound).length) groups[dir] = bound
    else delete groups[dir]
    if (Object.keys(groups).length) rules.groups = groups
    else delete rules.groups
  }

  private allGroups(): Group[] {
    const names = [
      ...this.sql.all<{ name: string }>(`SELECT name FROM groups ORDER BY name`).map((row) => row.name),
      ...(this.policy?.groups ?? []).map((group) => group.name),
    ]
    return [...new Set(names)].map((name) => this.groupByName(name)!)
  }

  private groupMembers(group: Group): EndpointRow[] {
    if (!group.policy) return this.runtimeMembers(group.name)
    return this.agentRows().filter((row) => this.scopeSubject(row).groups.includes(group.name))
  }

  private runtimeMembers(name: string): EndpointRow[] {
    return this.sql.all<EndpointRow>(
      `SELECT e.* FROM group_members m JOIN endpoints e ON e.id = m.endpoint WHERE m.name = ? AND substr(e.handle, 1, ${GONE_PREFIX.length}) != '${GONE_PREFIX}' ORDER BY e.handle`,
      name,
    )
  }

  /** the human, the owner, a member, an admin of the group or its tree, or an endpoint with authority over the owner */
  private seesGroup(me: EndpointRow, group: Group): boolean {
    if (me.kind === "human" || group.owner === me.id || this.adminOfGroup(me.id, group)) return true
    const owner = group.policy ? undefined : this.byId(group.owner)
    if (owner && this.authority(me, owner)) return true
    return this.scopeSubject(me).groups.includes(group.name)
  }

  /** whether `me` may find `row` by address: the human finds all; an agent itself, what it has authority over and what it may message */
  private discovers(me: EndpointRow, row: EndpointRow): boolean {
    return me.kind === "human" || row.id === me.id || this.authority(me, row) || this.mayMessage(me, row)
  }

  private groupView(group: Group, viewer: EndpointRow) {
    const { name, place } = this.namer(viewer)
    const rules: { in?: ScopeEntry[]; out?: ScopeEntry[] } = {}
    for (const dir of ["in", "out"] as const) {
      const list = group.rules[dir]
      if (list) rules[dir] = list.map((entry) => (entry.via ? { sel: entry.sel, via: name(entry.via) } : { sel: entry.sel }))
    }
    return {
      name: group.name,
      owner: this.ownerName(group.owner),
      tree: group.tree ? place(group.tree) : null,
      pinned: group.pinned,
      policy: group.policy,
      rules,
      members: this.membersFor(viewer, group).map((row) => this.address(row)),
    }
  }

  /** a steward sees every member, since it may remove any; others what they find */
  private membersFor(me: EndpointRow, group: Group): EndpointRow[] {
    const all = this.groupMembers(group)
    return this.stewards(me, group) ? all : all.filter((row) => this.discovers(me, row))
  }

  /** the owner, its ancestors, an admin of the group or its tree, or the human */
  private stewards(me: EndpointRow, group: Group): boolean {
    return me.kind === "human" || me.id === group.owner || this.descendantOf(group.owner, me.id) || this.adminOfGroup(me.id, group)
  }

  /** endpoint ids as `viewer` may read them: `place` is null and `name` an ancestor or admin for an agent viewer that does not see the id */
  private namer(viewer: EndpointRow): { name: (id: string) => string; place: (id: string) => string | null } {
    let shown: Set<string> | undefined
    const hides = (id: string) => {
      if (viewer.kind !== "agent") return false
      shown ??= new Set(this.visibleRows(viewer).map((row) => row.id))
      return !shown.has(id)
    }
    return {
      name: (id) => (id === "human" || id === "policy" ? id : hides(id) ? "an ancestor or admin" : this.addressOf(id)),
      place: (id) => (hides(id) ? null : this.addressOf(id)),
    }
  }

  private ownerName(owner: string): string {
    return owner === "policy" ? owner : this.addressOf(owner)
  }

  private join(name: string, endpoint: string, addedBy: string, now: number): void {
    this.sql.all(`INSERT OR IGNORE INTO group_members (name, endpoint, added_by, at) VALUES (?, ?, ?, ?)`, name, endpoint, addedBy, now)
  }

  /** a member leaves, and its allowances into the group's caps, and those its membership gave, go with it */
  private leave(name: string, endpoint: string): void {
    this.sql.all(`DELETE FROM group_members WHERE name = ? AND endpoint = ?`, name, endpoint)
    const row = this.byId(endpoint)
    if (!row?.caps) return
    const caps = this.capsOf(row)
    delete caps.allow[groupCapKey(name, "in")]
    delete caps.allow[groupCapKey(name, "out")]
    const kept = (entries: ScopeEntry[]) => entries.filter((entry) => !(entry.member && entry.sel === `group:${name}`))
    for (const cap of caps.caps) cap.sels = kept(cap.sels)
    for (const key of Object.keys(caps.allow)) caps.allow[key] = kept(caps.allow[key]!)
    this.saveCaps(row.id, caps)
  }

  private dropGroup(name: string): void {
    for (const { endpoint } of this.sql.all<{ endpoint: string }>(`SELECT endpoint FROM group_members WHERE name = ?`, name)) this.leave(name, endpoint)
    this.sql.all(`DELETE FROM groups WHERE name = ?`, name)
  }

  /** the members of `group:<name>` (the sender must be one) or the sender's `tree:children`, those in its scope, the sender excluded; a reply reaches the asker */
  private expand(sender: EndpointRow, text: string, replyTo?: MessageRow): EndpointRow[] {
    let members: EndpointRow[]
    if (text === "tree:children") {
      members = this.sql.all<EndpointRow>(
        `SELECT * FROM endpoints WHERE parent_ep = ? AND kind = 'agent' AND substr(handle, 1, ${GONE_PREFIX.length}) != '${GONE_PREFIX}' ORDER BY handle`,
        sender.id,
      )
    } else {
      const name = text.slice("group:".length)
      const group = GROUP_NAME.test(name) ? this.groupByName(name) : undefined
      if (!group || sender.kind !== "agent" || !this.scopeSubject(sender).groups.includes(name)) throw unreachable(text)
      members = this.groupMembers(group)
    }
    const reached = members.filter((row) => row.id !== sender.id && this.localRow(row) && this.scopeRefusal(sender, row, replyTo ? { replyTo } : {}) === null)
    if (!reached.length) throw unreachable(text)
    if (reached.length > LIMITS.fanOutMax) throw new RelayError("too_large", `${text} reaches ${reached.length} endpoints, more than ${LIMITS.fanOutMax}`)
    return reached
  }

  /** the per-tree circuit breaker: a paused tree sends only to the human; past the caps it pauses, and the human and the root are told */
  private treeGuard(sender: EndpointRow, tree: string, sends: number, now: number, to: string[]): void {
    const pair = `tree:${tree}`
    const root = this.byId(tree)
    const name = root ? this.address(root) : tree
    const blocked = one<{ until: number }>(this.sql, `SELECT until FROM blocks WHERE pair = ? AND until > ?`, pair, now)
    if (blocked) {
      throw this.refuse(
        sender.id,
        "loop_guard",
        `the tree of ${name} is paused: it sent too many messages; only the human can be messaged`,
        Math.ceil((blocked.until - now) / 1000),
        {
          to,
          tree: name,
          until: iso(blocked.until),
        },
      )
    }
    const count = (windowS: number) =>
      one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM tree_events WHERE tree = ? AND at > ?`, tree, now - windowS * 1000)!.n
    const minute = count(60)
    const hour = count(3600)
    if (minute + sends <= LIMITS.treePerMinute && hour + sends <= LIMITS.treePerHour) return
    const until = now + LIMITS.treePauseS * 1000
    this.sql.all(`INSERT OR REPLACE INTO blocks (pair, until) VALUES (?, ?)`, pair, until)
    this.audit("loop_guard", sender.id, null, { tree: name, minute, hour, until: iso(until) })
    const text = `relay paused the tree of ${name} for ${LIMITS.treePauseS / 60} minutes: ${minute} messages in the last minute, ${hour} in the last hour. Messages to the human still pass.`
    this.notice(text)
    if (root && root.kind === "agent" && !root.handle.startsWith(GONE_PREFIX)) this.notice(text, root)
    throw this.refuse(
      sender.id,
      "loop_guard",
      `the tree of ${name} sent too many messages and is paused for ${LIMITS.treePauseS / 60} minutes`,
      LIMITS.treePauseS,
      {
        to,
        tree: name,
        limit: minute + sends > LIMITS.treePerMinute ? LIMITS.treePerMinute : LIMITS.treePerHour,
        window_s: minute + sends > LIMITS.treePerMinute ? 60 : 3600,
      },
    )
  }

  // internals

  private names(): Map<string, string> {
    return new Map(this.sql.all<EndpointRow>(`SELECT * FROM endpoints`).map((row) => [row.id, this.address(row)]))
  }

  protected subject(row: EndpointRow): PolicySubject {
    const subject = this.plainSubject(row)
    return row.kind === "agent" ? { ...subject, scope: this.scopeSubject(row) } : subject
  }

  private plainSubject(row: EndpointRow): PolicySubject {
    return { handle: row.kind === "human" ? "" : row.handle, harness: row.harness, kind: row.kind, labels: JSON.parse(row.labels) as Record<string, string> }
  }

  /** messages between two endpoints, both ways, in the burst window */
  private pairBurst(a: string, b: string, now: number): { n: number; first: number | null } {
    return one<{ n: number; first: number | null }>(
      this.sql,
      `SELECT COUNT(*) AS n, MIN(at) AS first FROM pair_events WHERE ((from_ep = ? AND to_ep = ?) OR (from_ep = ? AND to_ep = ?)) AND at > ?`,
      a,
      b,
      b,
      a,
      now - LIMITS.pairBurstWindowS * 1000,
    )!
  }

  /** a pair's live loop and rate limits, for why() */
  private pairLimits(a: EndpointRow, b: EndpointRow): { held: boolean; lines: string[]; pair?: NonNullable<WhyResult["pair"]> } {
    const now = this.now()
    const [first, second] = [this.address(a), this.address(b)]
    const pair: NonNullable<WhyResult["pair"]> = {}
    const lines: string[] = []
    const blocked = one<{ until: number }>(this.sql, `SELECT until FROM blocks WHERE pair = ? AND until > ?`, pairKey(a.id, b.id), now)
    if (blocked) {
      pair.paused_until = iso(blocked.until)!
      lines.push(`paused until ${pair.paused_until}: ${first} and ${second} went back and forth too often`)
    }
    const burst = this.pairBurst(a.id, b.id, now)
    if (burst.n >= LIMITS.pairBurst) {
      pair.burst = { n: burst.n, limit: LIMITS.pairBurst, window_s: LIMITS.pairBurstWindowS }
      lines.push(`burst: ${burst.n} messages between ${first} and ${second} in ${LIMITS.pairBurstWindowS} s (limit ${LIMITS.pairBurst})`)
    }
    const rows = this.sql.all<{ at: number; endpoint: string; detail: string }>(
      `SELECT at, endpoint, detail FROM audit WHERE event = 'refuse' AND endpoint IN (?, ?) ORDER BY id DESC LIMIT 500`,
      a.id,
      b.id,
    )
    for (const row of rows) {
      const detail = JSON.parse(row.detail) as { code?: string; message?: string; to?: unknown }
      const other = row.endpoint === a.id ? second : first
      if ((detail.code !== "loop_guard" && detail.code !== "rate_limited") || !Array.isArray(detail.to) || !detail.to.includes(other)) continue
      pair.refused = { at: iso(row.at)!, code: detail.code, message: String(detail.message ?? "") }
      lines.push(`last refused ${pair.refused.at}: ${detail.code}: ${pair.refused.message}`)
      break
    }
    return { held: blocked !== undefined || pair.burst !== undefined, lines, ...(lines.length ? { pair } : {}) }
  }

  private detectPingPong(a: EndpointRow, b: EndpointRow): void {
    if (a.id === b.id) return
    const now = this.now()
    const events = this.sql.all<{ from_ep: string }>(
      `SELECT from_ep FROM pair_events WHERE ((from_ep = ? AND to_ep = ?) OR (from_ep = ? AND to_ep = ?)) AND at > ? ORDER BY at, rowid`,
      a.id,
      b.id,
      b.id,
      a.id,
      now - LIMITS.pingPongWindowS * 1000,
    )
    let alternations = 0
    for (let i = 1; i < events.length; i++) if (events[i]!.from_ep !== events[i - 1]!.from_ep) alternations++
    if (alternations < LIMITS.pingPongAlternations) return
    const until = now + LIMITS.pingPongBlockS * 1000
    this.sql.all(`INSERT OR REPLACE INTO blocks (pair, until) VALUES (?, ?)`, pairKey(a.id, b.id), until)
    this.sql.all(`DELETE FROM pair_events WHERE (from_ep = ? AND to_ep = ?) OR (from_ep = ? AND to_ep = ?)`, a.id, b.id, b.id, a.id)
    this.audit("loop_guard", a.id, null, { with: this.address(b), alternations, until: iso(until) })
    this.notice(
      `relay paused messages between ${this.address(a)} and ${this.address(b)} for ${LIMITS.pingPongBlockS / 60} minutes: they went back and forth ${alternations} times in ${LIMITS.pingPongWindowS / 60} minutes.`,
    )
  }

  /** a status message from the relay itself, into the human inbox unless `to` names another endpoint */
  private notice(text: string, to?: EndpointRow): void {
    this.post(this.byHandle(SYSTEM_HANDLE)!, to ?? this.byHandle(HUMAN_HANDLE)!, text, { kind: "status", thread: newId("thr", this.now()) })
  }

  /** one plain text message from `from` straight into `to`'s inbox, past every send check: the relay's notices and a spawn's handback */
  private post(
    from: EndpointRow,
    to: EndpointRow,
    text: string,
    options: { kind: MessageKind; thread: string; hop?: number; replyTo?: string },
  ): { id: string; seq: number } {
    const now = this.now()
    const id = newId("msg", now)
    const expires = now + LIMITS.ttlDefaultS * 1000
    this.sql.all(
      `INSERT INTO messages (id, thread, reply_to, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'text/plain', 'public', '[]', ?, ?, ?)`,
      id,
      options.thread,
      options.replyTo ?? null,
      options.kind,
      from.id,
      this.address(to),
      text,
      options.hop ?? 0,
      now,
      expires,
    )
    return { id, seq: this.insertDelivery(id, to.id, expires) }
  }

  /** inserts one delivery and returns its seq; a subclass that hands out seqs elsewhere too keeps them in one space here */
  protected insertDelivery(messageId: string, endpoint: string, expiresAt: number): number {
    return one<{ seq: number }>(
      this.sql,
      `INSERT INTO deliveries (message_id, endpoint, expires_at) VALUES (?, ?, ?) RETURNING seq`,
      messageId,
      endpoint,
      expiresAt,
    )!.seq
  }

  /** a RelayError, audited with its message and `detail`: never a message body */
  protected refuse(endpoint: string, code: RelayError["code"], message: string, retryAfterS?: number, detail: Record<string, unknown> = {}): RelayError {
    this.audit("refuse", endpoint, null, { code, message, ...detail, ...(retryAfterS ? { retry_after_s: retryAfterS } : {}) })
    return new RelayError(code, message, retryAfterS)
  }

  protected audit(event: string, endpoint: string | null, ref: string | null, detail: Record<string, unknown>): void {
    this.sql.all(`INSERT INTO audit (at, event, endpoint, ref, detail) VALUES (?, ?, ?, ?, ?)`, this.now(), event, endpoint, ref, JSON.stringify(detail))
  }

  /** the row an address names, or undefined */
  private lookup(address: string): EndpointRow | undefined {
    try {
      return this.resolve(address)
    } catch (error) {
      if (error instanceof RelayError) return undefined
      throw error
    }
  }

  /** the user parts an address of this core may carry */
  protected addressUsers(): string[] {
    return [this.user, "me", "local"]
  }

  /** whether the row is this host's own, the only rows with a tree, groups, rules and caps here */
  protected localRow(_row: EndpointRow): boolean {
    return true
  }

  protected resolve(address: unknown): EndpointRow {
    if (typeof address !== "string" || !address.trim()) throw new RelayError("invalid_params", "an address is user/handle, or a handle")
    const text = address.trim()
    const slash = text.indexOf("/")
    const user = slash === -1 ? null : text.slice(0, slash)
    const handle = slash === -1 ? text : text.slice(slash + 1)
    if (user !== null && user !== "me" && user !== "local" && user !== this.user) throw unreachable(text)
    const row = handle === "" ? this.byHandle(HUMAN_HANDLE) : validHandle(handle) ? this.byHandle(handle) : undefined
    if (!row) throw unreachable(text)
    return row
  }

  protected mustEndpoint(id: string): EndpointRow {
    const row = this.byId(id)
    if (!row) throw new RelayError("unauthorized", "this connection has no endpoint")
    return row
  }

  protected byId(id: string): EndpointRow | undefined {
    return one<EndpointRow>(this.sql, `SELECT * FROM endpoints WHERE id = ?`, id)
  }

  protected byHandle(handle: string): EndpointRow | undefined {
    return one<EndpointRow>(this.sql, `SELECT * FROM endpoints WHERE handle = ?`, handle)
  }

  protected address(row: EndpointRow): string {
    if (row.kind === "human") return `${this.user}/`
    if (row.kind === "system") return `${this.user}/relay`
    return `${this.user}/${row.handle}`
  }

  /** with `shown`, the ids a viewer sees: a parent outside it is null */
  protected view(row: EndpointRow, shown?: Set<string>): EndpointView {
    const now = this.now()
    const presence = this.presence(row, now)
    return {
      id: row.id,
      address: this.address(row),
      kind: row.kind,
      harness: row.harness,
      model: row.model,
      cwd: row.cwd,
      labels: JSON.parse(row.labels) as Record<string, string>,
      title: row.title ?? null,
      presence,
      status: row.status_state ? { state: row.status_state, note: row.status_note ?? "" } : null,
      last_seen: iso(row.last_seen),
      ...(row.kind === "agent"
        ? { ...this.placeView(row, shown), wake: row.hibernate ? (`hook:${row.hibernate}` as const) : (wakeOf(row) ?? this.rootWake(row, now)?.wake ?? null) }
        : {}),
      ...(row.hibernate && row.wake_note ? { wake_failed: row.wake_note.replace(/^wake_failed: /, "") } : {}),
      ...(row.hibernate && row.wake_declined ? { wake_declined: row.wake_declined } : {}),
    }
  }

  private placeView(row: EndpointRow, shown?: Set<string>): Pick<EndpointView, "parent" | "depth" | "scope"> {
    const parent = row.parent_ep && (!shown || shown.has(row.parent_ep)) ? this.byId(row.parent_ep) : undefined
    const across = !parent && row.parent_ep === null && row.parent_addr ? this.linkedParent(row, shown) : null
    return { parent: parent ? this.address(parent) : across, depth: row.depth ?? 0, scope: presetOf(this.scopeNode(row), this.defaults().symmetric) }
  }

  /** the presence an endpoint shows ({@link shownPresence}): an in-process subagent whose root's waker it reaches ({@link rootWake}) is at least idle */
  private presence(row: EndpointRow, now: number): Presence {
    const presence = shownPresence(row, now)
    return presence === "offline" && this.rootWake(row, now) ? "idle" : presence
  }

  /**
   * the wake of the root a message to `row`, one of its in-process subagents, reaches, with the subagent's id: while the subagent belongs to
   * the root's current session (`sub:<id>:<root session>`) and has no live wake of its own, and the root has a wake with a live waker and is
   * not hibernated
   */
  private rootWake(row: EndpointRow, now: number): { root: EndpointRow; id: string; wake: Wake } | null {
    if (row.kind !== "agent" || row.parent_ep === null || !row.session?.startsWith("sub:") || waking(row, now) || !this.localRow(row)) return null
    const id = row.session.slice(4, row.session.indexOf(":", 4))
    const root = this.byId(row.parent_ep)
    if (!root || root.hibernate !== null || !waking(root, now) || row.session !== `sub:${id}:${root.session ?? root.id}`.slice(0, 128)) return null
    return { root, id, wake: wakeOf(root)! }
  }

  /** the root whose waker a delivery to `endpoint` reaches: `endpoint` is an idle (`done`) in-process subagent of it ({@link rootWake}) */
  wakesRoot(endpoint: string): string | null {
    const row = this.byId(endpoint)
    return row?.status_state === "done" ? (this.rootWake(row, this.now())?.root.id ?? null) : null
  }

  /** the in-process subagents' endpoints under `root` */
  subagentsOf(root: string): string[] {
    return this.sql
      .all<{ id: string }>(`SELECT id FROM endpoints WHERE parent_ep = ? AND kind = 'agent' AND substr(session, 1, 4) = 'sub:'`, root)
      .map((row) => row.id)
  }

  /** `recipient` names the delivery's endpoint when there is no `seq`: a send to several addresses shows each recipient only itself */
  protected envelope(row: MessageRow, seq?: number, recipient?: string): Envelope {
    const sender = this.byId(row.from_ep)
    const delivery = seq === undefined ? undefined : one<{ endpoint: string }>(this.sql, `SELECT endpoint FROM deliveries WHERE seq = ?`, seq)
    const to = delivery ? this.byId(delivery.endpoint) : undefined
    const own = to ?? (recipient === undefined ? undefined : this.byId(recipient))
    const seen = sender && to ? relation(this.subject(sender), this.subject(to)) : undefined
    const rel = seen === "human" && row.sender_tty === 0 ? "human, no terminal" : seen
    const kin = this.kinship(sender, to, row.created_at)
    return {
      ...(seq !== undefined ? { seq } : {}),
      id: row.id,
      thread: row.thread,
      reply_to: row.reply_to,
      kind: row.kind,
      from: {
        address: sender ? this.address(sender) : row.from_ep,
        endpoint: row.from_ep,
        user: this.user,
        auth: "local-uid",
        claims: {
          harness: sender?.harness ?? null,
          model: sender?.model ?? null,
          ...(row.sender_tty === null || row.sender_tty === undefined ? {} : { tty: row.sender_tty === 1 }),
        },
        ...(rel ? { rel } : {}),
      },
      to: own && row.to_addr.includes(",") ? this.address(own) : row.to_addr,
      body: { text: row.body, mime: row.mime },
      data_class: row.data_class,
      attachments: JSON.parse(row.attachments) as Envelope["attachments"],
      hop: row.hop,
      created_at: iso(row.created_at)!,
      expires_at: iso(row.expires_at)!,
      ...(row.require_reply === 1 ? { require_reply: true as const } : {}),
      ...(row.link_parent ? { link: { parent: row.link_parent } } : {}),
      ...kin,
    }
  }

  /** {@link kinOf} with the steer key: a parent without the key, to a recipient whose spawn grant has one, is only an `ancestor` */
  private kinship(sender: EndpointRow | undefined, recipient: EndpointRow | undefined, sentAt: number): Pick<Envelope, "relation" | "parent_key"> {
    const kin = this.kinOf(sender, recipient, sentAt)
    if (kin !== "parent") return kin ? { relation: kin } : {}
    const key = this.parentKey(sender!, recipient!, sentAt)
    return key.parent_key || !this.steerIssuers(recipient!).length ? { relation: "parent", ...key } : { relation: "ancestor" }
  }

  /** the issuers of the unrevoked `swarm spawn` grants with a steer key that `recipient` spent */
  private steerIssuers(recipient: EndpointRow): string[] {
    return this.sql
      .all<{ issuer: string }>(`SELECT DISTINCT issuer FROM grants WHERE used_by = ? AND spawn = 1 AND revoked_at IS NULL AND steer IS NOT NULL`, recipient.id)
      .map((row) => row.issuer)
  }

  /** the steer key of the unrevoked `swarm spawn` grant `sender` issued and `recipient` spent before a message `sender` sent at `sentAt` */
  private parentKey(sender: EndpointRow, recipient: EndpointRow, sentAt: number): { parent_key?: string } {
    const grant = one<{ steer: string }>(
      this.sql,
      `SELECT steer FROM grants WHERE issuer = ? AND used_by = ? AND spawn = 1 AND revoked_at IS NULL AND steer IS NOT NULL AND created_at <= ? ORDER BY created_at DESC LIMIT 1`,
      sender.id,
      recipient.id,
      sentAt,
    )
    return grant ? { parent_key: grant.steer } : {}
  }

  /**
   * how a local agent recipient stands to a local agent sender, from the broker's own rows: `parent` when the sender issued a grant the
   * recipient's current incarnation spent (a new incarnation revokes the grants an earlier holder spent) or is its ancestor, `child` when it
   * is the recipient's descendant. A human, the relay, another machine's row and a message from before the sender's row was taken over get none
   */
  private kinOf(sender: EndpointRow | undefined, recipient: EndpointRow | undefined, sentAt: number): Envelope["relation"] {
    if (!sender || !recipient || sender.id === recipient.id || sender.kind !== "agent" || recipient.kind !== "agent") return undefined
    if (!this.localRow(sender) || !this.localRow(recipient) || sender.handle.startsWith(GONE_PREFIX) || (sender.reset_at ?? 0) > sentAt) return undefined
    if (this.ancestorsOf(recipient).includes(sender.id)) return "parent"
    if (one(this.sql, `SELECT 1 FROM grants WHERE issuer = ? AND used_by = ? AND revoked_at IS NULL LIMIT 1`, sender.id, recipient.id)) return "parent"
    return this.ancestorsOf(sender).includes(recipient.id) ? "child" : undefined
  }

  // judging

  /** the sender, its lineage tree root and the recipients of a send, resolved and scope-checked exactly as send does, so a judge never sees or holds for an endpoint the sender cannot reach */
  judgeSubjects(
    from: string,
    params: Pick<SendParams, "to" | "reply_to" | "kind">,
    origin: { tty?: boolean; unverified?: boolean } = {},
  ): { sender: PolicySubject & { address: string }; recipients: (PolicySubject & { address: string })[]; tree: string } {
    const sender = this.mustEndpoint(from)
    const unverified = sender.kind === "human" && origin.unverified === true
    const targets = Array.isArray(params.to) ? params.to : [params.to]
    if (targets.length < 1 || targets.length > LIMITS.recipients) throw new RelayError("invalid_params", `to takes 1 to ${LIMITS.recipients} addresses`)
    const parent = params.reply_to === undefined ? undefined : this.replyParent(from, params.reply_to)
    const replyTo = params.kind === "reply" ? parent : undefined
    const resolved: EndpointRow[] = []
    const pending: (PolicySubject & { address: string })[] = []
    for (const address of targets) {
      const text = typeof address === "string" ? address.trim() : address
      if (typeof text === "string" && (text.startsWith("group:") || text === "tree:children")) {
        resolved.push(...this.expand(sender, text, replyTo))
        continue
      }
      const spawned = this.unjoinedTarget(sender, address, this.now())
      if (spawned) {
        pending.push({
          handle: spawned.name!,
          harness: null,
          kind: "agent",
          labels: json<Record<string, string>>(spawned.labels, {}),
          address: `${this.user}/${spawned.name}`,
        })
        continue
      }
      const row = this.resolve(address)
      this.checkScope(sender, row, String(text), replyTo, unverified)
      resolved.push(row)
    }
    const named = (row: EndpointRow) => ({ ...this.subject(row), address: this.address(row) })
    return {
      sender: named(sender),
      recipients: [...[...new Map(resolved.map((row) => [row.id, row])).values()].map(named), ...pending],
      tree: sender.tree ?? sender.id,
    }
  }

  /** a judge row in the audit log: the body's hash and the verdict, never the body */
  auditJudge(event: JudgeAuditEvent, endpoint: string | null, ref: string | null, detail: JudgeAuditDetail): void {
    if (!event.startsWith("judge_")) throw new RelayError("invalid_params", "a judge audit event starts with judge_")
    this.audit(event, endpoint, ref, { ...detail })
  }

  /** a status message from the relay to an endpoint, about one of its held messages */
  judgeNotice(endpoint: string, text: string): void {
    this.notice(text, this.mustEndpoint(endpoint))
  }
}

/** a judge row as anyone but the human at a terminal reads it: no free text from the model or the human, no redaction kinds */
export function judgeDetailForAgents(detail: Record<string, unknown>): Record<string, unknown> {
  const { reason: _reason, redacted, ...rest } = detail
  const n = redacted && typeof redacted === "object" ? (redacted as { n?: unknown }).n : undefined
  return { ...rest, ...(typeof n === "number" ? { redacted: { n } } : {}) }
}

/** the seqs of one ack: integers, at most a page of them */
export function seqList(seqs: unknown): number[] {
  if (!Array.isArray(seqs) || seqs.some((s) => !Number.isInteger(s))) throw new RelayError("invalid_params", "seqs must be a list of integers")
  if (seqs.length > LIMITS.inboxPage) throw new RelayError("invalid_params", `at most ${LIMITS.inboxPage} seqs per ack`)
  return seqs as number[]
}

const capId = (): string => `cap_${randomHex(8)}`

/** a claim's lineage: process keys, at most ${LIMITS.lineageMax}; keys that are not full process keys stay but never place */
function lineageKeys(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string" || key.length > 128))
    throw new RelayError("invalid_params", "lineage is a list of process keys")
  return (value as string[]).slice(0, LIMITS.lineageMax)
}

function groupName(value: unknown): string {
  if (typeof value !== "string" || !GROUP_NAME.test(value) || value === "self")
    throw new RelayError("invalid_params", "a group name is lowercase letters, digits, . _ -")
  return value
}

function groupNames(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 16) throw new RelayError("invalid_params", `${where} is a list of at most 16 group names`)
  return [...new Set(value.map(groupName))]
}

/** a recipient briefly offline (a script between `inbox --wait` polls, a reconnecting shim) is not taken as ended before this long, unless its session ended */
const ASK_ENDED_GRACE_MS = 10_000

/** preset and relation words a bare selector must not silently turn into `ep:<word>` */
const RESERVED_WORDS = new Set(["open", "none", "tree", "parent", "self", "root", "children", "descendants", "ancestors", "siblings", "human", "me"])

/** a selector list, a bare handle standing for `ep:<handle>` */
function selectorList(value: unknown, where: string, groupRules = false): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new RelayError("invalid_params", `${where} is a list of at most 64 selectors`)
  return value.map((sel) => {
    if (typeof sel === "string" && RESERVED_WORDS.has(sel)) {
      throw new RelayError(
        "invalid_params",
        `${where}: "${sel}" is a scope word, not a handle: use --scope ${sel === "self" ? "tree" : sel} or tree:${sel === "tree" ? "self" : sel}, or ep:${sel} for an endpoint named ${sel}`,
      )
    }
    const named = typeof sel === "string" && !sel.includes(":") && validHandle(sel) ? `ep:${sel}` : sel
    if (!validSelector(named, { groupRules })) throw new RelayError("invalid_params", `${where}: ${JSON.stringify(sel)} is not a selector`)
    return named as string
  })
}

/** the not_found for an address the caller cannot reach, in the same words whether it is hidden or does not exist */
/** where a send to a `swarm spawn` that has not joined waits: a deliveries endpoint no row has, keyed by the grant */
export function pendingKey(tokenHash: string): string {
  return `spawn:${tokenHash}`
}

export function unreachable(address: unknown): RelayError {
  return new RelayError("not_found", `no endpoint ${String(address).trim()} that you can reach (${CLI_NAME} peers lists who you may message)`)
}

/** a key derived from one harness process (`pid:<pid>:<start time>`): only that process's children compute it */
const PROCESS_KEY = /^pid:\d+:[A-Za-z0-9:-]{1,64}$/
/** a derived key without the start time, from a hook whose harness already exited */
const BARE_PID_KEY = /^pid:\d+$/
const ANY_PROCESS_KEY = /^pid:\d+(:[A-Za-z0-9:-]{1,64})?$/

/**
 * whether a connecting claim from the harness process `key` may join a session endpoint: no connection holds it, the harness process that last
 * claimed it claims again, and, once a connection held it (a token was handed out), with the same full key, which a recycled pid cannot match
 */
/** a claim from the very harness process that holds the live `row`, such as a session it restarted in process */
function reclaims(row: EndpointRow, key: string | null): boolean {
  return row.connections > 0 && key !== null && row.process === key && PROCESS_KEY.test(key)
}

function sameProcess(row: EndpointRow, key: string | null): boolean {
  if (row.connections > 0 || key === null || row.process === null) return false
  return row.token_hash === null ? sameHarness(row.process, key) : row.process === key && PROCESS_KEY.test(key)
}

const SUBAGENT_ID = /^(?=.*[A-Za-z0-9])[A-Za-z0-9_-]{1,64}$/
const SUBAGENT_TITLES_KEPT = 256

/** a title a hook offers: one line of at most the cap, credentials redacted; null when nothing is left or it still looks like a credential */
function hookTitle(text: string): string | null {
  const title = stripControl(redactSecrets(text.slice(0, 4096).replace(/\s+/g, " ").trim()))
    .slice(0, TITLE_CHARS)
    .trim()
  return title && !findSecret(title) ? title : null
}

/** a claim's subagent: an id of letters, digits, `_` and `-` (Claude Code's are hex), an optional type, and `stop` for its stop's claim */
function subagentOf(value: unknown): { id: string; type?: string; stop?: true } | undefined {
  if (value === undefined || value === null) return undefined
  const { id, type, stop } = (typeof value === "object" ? value : {}) as { id?: unknown; type?: unknown; stop?: unknown }
  if (typeof id !== "string" || !SUBAGENT_ID.test(id)) throw new RelayError("invalid_params", "subagent is {id, type}: id letters, digits, _ and -")
  if (type !== undefined && (typeof type !== "string" || type.length > 64))
    throw new RelayError("invalid_params", "subagent type is a name of at most 64 characters")
  if (stop !== undefined && typeof stop !== "boolean") throw new RelayError("invalid_params", "subagent stop is true or false")
  return { id, ...(type ? { type } : {}), ...(stop ? { stop: true as const } : {}) }
}

/** a subagent type's short name: `gp` for general-purpose, else its first word (split at non-alphanumerics and camelCase humps) lowercased, `agent` for none */
function subagentKind(type: string | undefined): string {
  if (type?.toLowerCase() === "general-purpose") return "gp"
  const word = (type ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .find(Boolean)
  return word ? word.toLowerCase().slice(0, 16) : "agent"
}

/** the line a held spawn's handback ends with */
function heldLine(address: string): string {
  return `${address} stays resumable: message it to resume its session`
}

/** `<root handle>-<short type>-<first 4 alphanumerics of id>`, the root's part clipped so the whole leaves room for a `-<n>` suffix */
export function subagentHandle(root: string, subagent: { id: string; type?: string }): string {
  const tail = `-${subagentKind(subagent.type)}-${subagent.id
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 4)}`
  return `${root.slice(0, 58 - tail.length).replace(/[-.]+$/, "")}${tail}`
}

/** two keys of one harness process: equal, or a bare `pid:<pid>` and a full key of that pid */
function sameHarness(a: string, b: string): boolean {
  return a === b || (BARE_PID_KEY.test(a) && b.startsWith(`${a}:`)) || (BARE_PID_KEY.test(b) && a.startsWith(`${b}:`))
}

/** a row's stored wake when it is a known one other than `none` */
function wakeOf(row: EndpointRow): Wake | null {
  return row.wake && row.wake !== "none" && WAKES.includes(row.wake as Wake) ? (row.wake as Wake) : null
}

/** a connection's presence by its last request; without one, a hook's by the last time a hook reported */
function presenceOf(row: EndpointRow, now: number): Presence {
  if (row.connections > 0) return (row.last_seen ?? 0) >= now - LIMITS.onlineWithinS * 1000 ? "online" : "idle"
  if (!row.hook_seen) return "offline"
  if (row.hook_seen >= now - LIMITS.hookOnlineS * 1000) return "online"
  return row.hook_seen >= now - LIMITS.hookIdleS * 1000 ? "idle" : "offline"
}

/** a wake whose waker holds a live connection, on a row not hibernated: a message wakes it, so its stop need not wait on its workers */
function wakes(row: EndpointRow): boolean {
  return wakeOf(row) !== null && row.wakers > 0 && !row.hibernate
}

/** a wake with a live waker, or a hook waker that left within LIMITS.restartGraceS */
function waking(row: EndpointRow, now: number): boolean {
  return wakeOf(row) !== null && (row.wakers > 0 || (row.waker_left ?? 0) >= now - LIMITS.restartGraceS * 1000)
}

/**
 * the presence an endpoint shows: a provider's hibernated session is `hibernated` whatever its connections say; one its waker can wake is at
 * least idle, though its session's own presence decayed
 */
function shownPresence(row: EndpointRow, now: number): Presence {
  if (row.hibernate) return "hibernated"
  const presence = presenceOf(row, now)
  return presence === "offline" && waking(row, now) ? "idle" : presence
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}
