export const PROTOCOL = "scp/1"

/** the reference CLI's command, as refusals and notes name its verbs */
export const CLI_NAME = "swarm"

export const CAPABILITIES = ["inbox.wait", "ask", "scopes", "groups"] as const
/** the local broker serves the peek, judge and hold review methods the hosted hub does not */
export const BROKER_CAPABILITIES = [...CAPABILITIES, "peek", "judge", "holds"] as const

export const LIMITS = {
  bodyBytes: 64 * 1024,
  recipients: 16,
  attachments: 16,
  ttlDefaultS: 7 * 86_400,
  ttlMaxS: 30 * 86_400,
  purgeAfterS: 7 * 86_400,
  inboxMax: 1000,
  inboxPage: 100,
  waitMaxS: 50,
  hopMax: 64,
  threadMax: 200,
  causalWindowS: 120,
  pairBurst: 20,
  pairBurstWindowS: 10,
  pairPerMinute: 30,
  pairPerHour: 300,
  userPerDay: 2000,
  pingPongAlternations: 100,
  pingPongWindowS: 600,
  pingPongBlockS: 600,
  onlineWithinS: 60,
  hookOnlineS: 300,
  hookIdleS: 1800,
  hookEndedGraceS: 30,
  restartGraceS: 60,
  injectMessages: 5,
  injectBytes: 7168,
  pushBytes: 20480,
  /** the stops a session's push may continue between two prompts */
  pushes: 20,
  /** how long a live worker's next message waits after a push showed one of its own */
  pushGapS: 30,
  /** with other workers still running, how long a stop's push waits for one more worker result before it goes */
  pushQuietS: 3,
  /** the longest a stop's push gathers worker results, from the first it has to show */
  pushGraceS: 6,
  stopBlocks: 3,
  /** the stops a session's late parent directives may hold */
  directiveHolds: 5,
  injectHoldS: 10,
  /** how long inbox still lists a message a background hook showed, whose text the harness may hand the agent only after its next tool call */
  deferredShowS: 600,
  /** a deferred showing older than this settles at the session's next tool event or prompt: the harness has handed it over by then */
  deferredSettleMs: 2000,
  listOfflineWithinS: 86_400,
  handleBoundS: 30 * 86_400,
  /** how long an offline child endpoint (a subagent's, a worker's) or a `_gone_` row that nothing references stays before the sweep retires it */
  endpointRetireS: 86_400,
  /** the most endpoint rows one sweep retires */
  endpointRetireMax: 1000,
  idempotencyS: 86_400,
  auditKeepS: 30 * 86_400,
  noteChars: 280,
  handbackBytes: 16384,
  stderrBytes: 1024,
  activityKeep: 5000,
  activitySummaryChars: 200,
  textField: 512,
  lineageMax: 16,
  depthMax: 32,
  fanOutMax: 32,
  fanOutTotal: 64,
  treePerMinute: 120,
  treePerHour: 1200,
  treePauseS: 600,
  groupPerMinute: 60,
  grantTtlS: 7 * 86_400,
  groupIdleS: 86_400,
  policyLoadsKept: 8,
  /** the prompts between two refreshes of a title a hook inferred */
  titleRefreshTurns: 5,
  /** the least time between two wake hook runs for one hibernated endpoint */
  wakeDebounceS: 60,
  /** the longest backoff after failed wake hook runs */
  wakeBackoffMaxS: 900,
  /** the longest opaque wake reference a provider stores with a hibernation */
  wakeRefChars: 512,
  /** the longest wake time a provider may announce with a hibernation */
  wakeEtaMaxS: 3600,
} as const

export type ErrorCode =
  | "not_found"
  | "inbox_full"
  | "rate_limited"
  | "loop_guard"
  | "data_class_refused"
  | "secret_refused"
  | "policy_refused"
  | "too_large"
  | "invalid_params"
  | "unauthorized"
  | "method_not_found"
  | "scope_refused"
  | "unavailable"
  | "judge_refused"
  | "not_live"

export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterS?: number,
    /** structured fields a client may show, never a message body */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export type EndpointKind = "agent" | "human" | "system"
export type MessageKind = "message" | "request" | "reply" | "status"
export type DataClass = "public" | "private"
/** `hibernated`: a provider suspended the session; a message runs its wake hook and the session drains its queue once it is back */
export type Presence = "online" | "idle" | "offline" | "hibernated"
export const PRESENCES: readonly Presence[] = ["online", "idle", "offline", "hibernated"]
export type StatusState = "working" | "waiting" | "blocked" | "done"
/**
 * how an idle agent is woken by a message: a channel push, the pi extension, the OpenCode plugin's waiter, codex app-server, the session inbox,
 * a headless resume, muse serve, a T3 Code thread, a held spawn resuming its worker's session or the broker queueing it into a Codex thread;
 * `none` reads at its next turn; `hook:<provider>` (shown only, never set this way) a hibernated agent's provider wake hook
 */
export type Wake =
  | "channels"
  | "pi"
  | "opencode-plugin"
  | "codex-app-server"
  | "claude-inbox"
  | "agy-resume"
  | "grok-resume"
  | "muse-serve"
  | "t3code"
  | "spawn-resume"
  | "codex-queue"
  | "none"
  | `hook:${string}`
export const WAKES: readonly Wake[] = [
  "channels",
  "pi",
  "opencode-plugin",
  "codex-app-server",
  "claude-inbox",
  "agy-resume",
  "grok-resume",
  "muse-serve",
  "t3code",
  "spawn-resume",
  "codex-queue",
  "none",
]
/** wakes the broker delivers itself, by its waker of the same name: set by a hook, they need no live waker and outlast the harness process */
export const BROKER_WAKES: readonly Wake[] = ["codex-queue"]
/** the built-in wake provider of a durable spawn: its waker resumes the worker's harness session from the hibernation's ref */
export const SPAWN_PROVIDER = "spawn"
/** why a provider declined to wake a hibernated agent, a short token it picks (e.g. `policy`, `budget`): not a failure, and not retried for the same message */
export type WakeDecline = string
export const WAKE_DECLINE = /^[a-z][a-z0-9_-]{0,31}$/

/** `value` when it is a decline reason, else null */
export function wakeDeclineOf(value: unknown): WakeDecline | null {
  return typeof value === "string" && WAKE_DECLINE.test(value) ? value : null
}

export type ActivityKind = "session_start" | "tool" | "stop" | "note" | "session_end"
export const ACTIVITY_KINDS: readonly ActivityKind[] = ["session_start", "tool", "stop", "note", "session_end"]

export interface ActivityRow {
  id: number
  at: string
  endpoint: string
  kind: ActivityKind
  tool: string | null
  summary: string | null
  /** the subagent a hook reported, for example `Explore 3f2a9c` */
  agent: string | null
}

export const MESSAGE_KINDS: readonly MessageKind[] = ["message", "request", "reply", "status"]
export const STATUS_STATES: readonly StatusState[] = ["working", "waiting", "blocked", "done"]

const HANDLE = /^[a-z0-9][a-z0-9._-]{0,62}$/
const RESERVED = new Set(["user", "me", "relay"])
const HARNESS = /^[a-z0-9][a-z0-9-]{0,31}$/

export function validHandle(handle: string): boolean {
  return HANDLE.test(handle) && !RESERVED.has(handle)
}

export function validHarness(harness: string): boolean {
  return HARNESS.test(harness)
}

/** harness names of the path a claim came by (a bare CLI, hook or MCP shim), not of the agent behind it */
export const GENERIC_HARNESSES: ReadonlySet<string> = new Set(["cli", "hook", "mcp", "shell"])

const generic = (harness: string | null): boolean => harness === null || GENERIC_HARNESSES.has(harness)

/** whether a claim of harness `claimed` may take a row of harness `held`: the same harness, or a generic row, which heals to the claim's */
export function harnessFits(held: string | null, claimed: string): boolean {
  return held === claimed || generic(held)
}

/** the harness a claimed row keeps: the claim's, except that a generic claim never replaces a known harness */
export function keptHarness(held: string | null, claimed: string): string {
  return generic(claimed) && !generic(held) ? held! : claimed
}

export interface Claim {
  handle?: string
  harness?: string
  model?: string
  cwd?: string
  parent?: string
  labels?: Record<string, string>
  /** a harness session's key: its MCP shim and its hooks share one endpoint */
  session?: string
  /** the harness process the claim comes from, `pid:<pid>:<start time>`: a shim restarted in that process may rejoin its endpoint */
  process?: string
  /** the harness's own stable session id (Claude Code's): a resumed session in a new harness process takes back the offline endpoint of that id */
  harness_session?: string
  /** process keys of the claimant's harness process and its ancestors, nearest first: the nearest endpoint holding one places the claim under it */
  lineage?: string[]
  /** a `krt_` grant from `spawn-env`: places the claim at or below its lineage placement, with the grant's caps and groups */
  grant?: string
  /** the handle as named (`--as`): never suffixed; it takes over or joins that endpoint where the rules allow, else the claim is refused */
  exact?: boolean
  /**
   * a hook's claim for an in-process subagent of the harness holding the claim's lineage endpoint: the broker places it under that endpoint,
   * as `<its current handle>-<short type>-<first 4 of id>` (`gp` for general-purpose, else the type's first word) with a session of its own, and
   * only for a hook of that endpoint's own harness process. A stop's claim (`stop`) takes only an endpoint the subagent already has, else is
   * refused not_found; any other claim of a done one resumes it working
   */
  subagent?: { id: string; type?: string; stop?: boolean }
  scope?: ScopePreset
  in?: string[]
  out?: string[]
  groups?: string[]
  /** an agent address a root claim links under, as a join under does; a refused link keeps the claim, audited */
  under?: string
  /** a `kwt_` wake ticket a `spawn` waker run got: takes back the endpoint hibernated by `spawn` it was minted for, as its resumed session */
  ticket?: string
}

export type ScopeDirection = "in" | "out"
export type ScopePreset = "open" | "tree" | "parent" | "none"
export const SCOPE_PRESETS: readonly ScopePreset[] = ["open", "tree", "parent", "none"]

/** a selector in a cap; `via` is the endpoint id (or `human`) that widened it, which clips what it admits */
export interface ScopeEntry {
  sel: string
  via?: string
  /** for `group:<name>`, the identity of the group of that name when the entry was set: it admits only that group's members */
  group?: string
  /** an inherited cap's base `*` via the parent: once the parent is released it still admits the parent's subtree */
  base?: true
  /** a `group:<name>` allowance its widener gave by adding the endpoint to that group: it goes when the endpoint leaves the group */
  member?: true
}

/** a list set from above: `by` is an endpoint id, `human`, `policy`, or `inherited` for a limited parent's, derived live */
export interface ScopeCap {
  id: string
  dir: ScopeDirection
  by: string
  sels: ScopeEntry[]
}

export interface ScopeView {
  address: string
  /** the root's address, null for an agent viewer that does not see it */
  tree: string | null
  parent: string | null
  depth: number
  rules: { in?: string[]; out?: string[] }
  /** stored caps plus group caps (`by: group:<name>`) and policy caps (`by: policy`), with addresses for `by` and `via` */
  caps: ScopeCap[]
  groups: string[]
  preset: ScopePreset | "custom"
}

export interface ScopeChange {
  added: string[]
  clipped: string[]
  /** the other end of an added `ep:` selector, widened to admit the endpoint back because the widener has authority over it too */
  mirrored?: { endpoint: string; dir: ScopeDirection; added: string[] }[]
  /** the other end of an added `ep:` selector whose side still refuses the endpoint, with the command that would widen it; `unseen` when the widener does not find that end, which is then not checked */
  refused?: { endpoint: string; dir: ScopeDirection; fix: string; unseen?: true }[]
}

export interface PeerView {
  address: string
  kind: EndpointKind
  presence: Presence
  title: string | null
  /** the state and the agent's now, a one-line note */
  status: { state: StatusState; note: string } | null
  /** the rule that admits the message */
  reason: string
  /** set only when the viewer may peek this endpoint */
  peekable?: PeekLevel
}

export interface WhyResult {
  allowed: boolean
  reasons: string[]
  /** the pair's live limits: a ping-pong pause, a burst at its limit, the last loop_guard or rate_limited refusal between the two */
  pair?: { paused_until?: string; burst?: { n: number; limit: number; window_s: number }; refused?: { at: string; code: string; message: string } }
}

/** who calls a scope method: the human (with or without a terminal), or an endpoint by its session or by a plain shell's lineage */
export type ScopeActor = { kind: "human"; tty: boolean } | { kind: "endpoint"; id: string; auth: "session" | "self" | "lineage" }

export interface EndpointView {
  id: string
  address: string
  kind: EndpointKind
  harness: string | null
  model: string | null
  cwd: string | null
  labels: Record<string, string>
  title: string | null
  presence: Presence
  status: { state: StatusState; note: string } | null
  last_seen: string | null
  /** the parent endpoint's address, null for a root */
  parent?: string | null
  depth?: number
  scope?: ScopePreset | "custom"
  /** set only in a viewer's list, when that viewer may peek this endpoint */
  peekable?: PeekLevel
  /** an agent's: how an idle agent is woken by a message; null or `none`: it reads at its next turn */
  wake?: Wake | null
  /** a hibernated agent's last wake hook failure: the reason */
  wake_failed?: string
  /** a hibernated agent's provider declined the last wake */
  wake_declined?: WakeDecline
  /** a hub's hibernated row whose machine waker accepted a wake, until its session reclaims it or the wake times out */
  waking?: true
}

export type PeekLevel = "local"

export interface PeekTurn {
  role: "user" | "assistant"
  at: string
  text: string
  tools: string[]
}

/** a short, redacted view of an endpoint's last turns; bodies are untrusted data */
export interface PeekResult {
  endpoint: string
  at: string
  level: PeekLevel | null
  source: "digest" | "status"
  turns: PeekTurn[]
  recent_tools: string[]
  status: EndpointView["status"]
  title: string | null
  unread: number
  truncated: boolean
}

export interface PeekSeen {
  at: string
  by: string
  auth: string
  turns: number
}

export interface PeekState {
  peek: PeekLevel | null
  peeked_by: PeekSeen[]
}

export interface Attachment {
  kind: "path"
  path: string
}

/** a request a stop names to its recipient once: by sender and id only, never its text */
export interface StopNudge {
  seq: number
  from: string
  id: string
  /** not yet read */
  unread: boolean
}

export interface Envelope {
  seq?: number
  id: string
  thread: string
  reply_to: string | null
  kind: MessageKind
  from: {
    address: string
    endpoint: string
    user: string
    auth: "local-uid" | "account" | "account+bridge" | "contact"
    machine?: string
    /** the sender's account handle when it is another account (a contact); set by the relays, never by a sender */
    account?: string
    claims: { harness: string | null; model: string | null; tty?: boolean }
    /** the sender as seen from the recipient: parent, child, ancestor, descendant, sibling, tree, group:<name>, fleet:<root handle>, human or `human, no terminal` */
    rel?: string
    /** the human at a terminal on another machine of the account, shown as `<machine>/me`; set by the relay, never by a sender */
    human?: true
  }
  to: string
  body: { text: string; mime: string }
  data_class: DataClass
  attachments: Attachment[]
  hop: number
  created_at: string
  expires_at: string
  /** a request whose sender holds the recipient's stop until it replies */
  require_reply?: true
  /** a broker-issued request to link under its sender */
  link?: { parent: string }
  /** set by inbox on a message a background hook already showed (and marked read), whose text may reach the agent only after this call */
  shown_at?: string
  /**
   * the sender as the local broker sees it from the recipient, never from anything the sender claims: `parent` when it issued the grant the
   * recipient's current incarnation spent or is its ancestor, `child` when it is the recipient's descendant; unset for humans and other machines.
   * A recipient a `swarm spawn` grant with a steer key placed hears only that issuer's keyed messages as `parent`: another ancestor's are `ancestor`
   */
  relation?: "parent" | "ancestor" | "child"
  /** with `parent`, from the issuer of the `swarm spawn` grant the recipient spent: that grant's steer key, which the worker's prompt names */
  parent_key?: string
  /** on a delivery to an idle in-process subagent that its root's waker is offered: the subagent's address and the id its root continues it by */
  for?: { address: string; subagent: string }
}

/** a message in a thread the caller sent or got a message in, as `message` with `member` finds it: enough to reply to it, never its body */
export type ThreadMessage = Pick<Envelope, "id" | "thread" | "kind" | "created_at"> & { from: Pick<Envelope["from"], "address" | "endpoint"> }

/**
 * what a stop that waits on spawned workers takes: their unread messages and the relay's handbacks about them, then with any of those the
 * other unread messages no hook holds, the last `others_shown` of `messages`, all held like an inject's within ${LIMITS.pushBytes} bytes of
 * wrapped text (`offered` under `hold`, `more` of the workers' left unread), the workers still running and those not joined yet (`starting`),
 * how many other messages are left unread, the pushes left of the prompt's ${LIMITS.pushes} (none: nothing shown), `prompted` once a prompt
 * came after the one the stop started under, and `brief` once the session was shown the full preamble
 */
export interface StopWaitResult {
  messages: Envelope[]
  offered: number[]
  hold: string | null
  more: number
  workers: string[]
  starting: number
  /** the live --no-push workers it spawned, which no stop waits on, by address */
  background?: string[]
  others: number
  others_shown?: number
  pushes_left: number
  prompted?: true
  /** a message wakes the session anyway (a wake with a live waker): the stop need not wait for its workers */
  wakeable?: true
  /** a hook already showed this session the full preamble: the brief marker stands for it */
  brief?: true
}

export interface SendParams {
  to: string | string[]
  body: string
  kind?: MessageKind
  thread?: string
  reply_to?: string
  data_class?: DataClass
  attachments?: Attachment[]
  client_id?: string
  ttl_s?: number
  mime?: string
  /** on a request only: the recipient's stop is held until it replies */
  require_reply?: boolean
  /** refuse `not_live`, queueing nothing, when an agent recipient has no live session */
  live?: boolean
}

/** what ask and ask_wait answer: the reply; or pending, with `ended` once every recipient present at the send went offline without replying; or expired */
export interface AskResult {
  id: string
  /** the send's, when the request was sent by this call */
  deliveries?: SendResult["deliveries"]
  reply?: Envelope
  pending?: boolean
  expired?: boolean
  ended?: { address: string; state: StatusState | null }[]
  held?: JudgeHeld
  redacted?: JudgeRedacted
}

/** a send the judge held: nothing was delivered; the human releases or refuses it */
export interface JudgeHeld {
  hold_id: string
  side: "local" | "egress" | "ingress"
}

/** a send the judge delivered with `n` spans replaced, of these kinds */
export interface JudgeRedacted {
  n: number
  kinds: string[]
}

/**
 * when an agent recipient sees a message, as its sender may know it: `running` at its next turn boundary (its next tool call or stop),
 * `ended` never unless it is started again (it is done: a `swarm spawn` run that exited, a finished subagent), `offline` never unless it
 * comes back, `starting` once it joins (the sender's own `swarm spawn` of it has not joined yet)
 */
export type Reach = "running" | "ended" | "offline" | "starting"

export interface SendResult {
  id: string
  thread: string
  hop: number
  /**
   * `queued`: the recipient is not connected now; `offline`: it has been gone past a short grace, so a client polling between waits is not
   * offline; `state`: an agent recipient's {@link Reach} on this machine (an older broker leaves it out); `wake`: how it is woken, only when
   * it can be, `declined` when its provider declined the last wake; `idle`: its presence is idle; `hibernated`: it is hibernated and
   * queued, its provider's wake hook resumes it; `wake_eta_s`: how long its provider said a wake takes
   */
  deliveries: {
    endpoint: string
    address: string
    seq: number
    offline: boolean
    queued?: boolean
    last_seen: string | null
    state?: Reach
    wake?: Wake | "declined"
    idle?: true
    hibernated?: true
    wake_eta_s?: number
  }[]
  /** one line per agent recipient no live session holds: `queued: no live session holds <address>` */
  warnings?: string[]
  duplicate?: boolean
  held?: JudgeHeld
  redacted?: JudgeRedacted
}

export interface AdoptResult {
  endpoint: EndpointView
  parent: string
  requested?: string
  held?: JudgeHeld
}

/**
 * a message the caller sent and, per recipient, when it read the message (acked), or when a background hook delivered it (acked by that
 * showing; the agent gets it with its next request), and when a hook or channel showed it: ISO times, or null
 */
export interface MessageReceipts {
  id: string
  thread: string
  recipients: { address: string; read_at: string | null; delivered_at?: string | null; shown_at: string | null }[]
}

export interface AuditRow {
  id: number
  at: string
  event: string
  endpoint: string | null
  ref: string | null
  detail: Record<string, unknown>
}

/** fields only the server sets: a client that sends them gets invalid_params */
export const SERVER_FIELDS = ["from", "id", "seq", "hop", "created_at", "auth", "expires_at", "relation", "link"] as const
