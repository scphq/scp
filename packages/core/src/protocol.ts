export { PROTOCOL } from "@scp-dev/spec"

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
  injectBytes: 4096,
  pushBytes: 20480,
  /** the stops a session's push may continue between two prompts */
  pushes: 20,
  /** how long a live worker's next message waits after a push showed one of its own */
  pushGapS: 30,
  stopBlocks: 3,
  /** the stops a session's late parent directives may hold */
  directiveHolds: 5,
  injectHoldS: 10,
  listOfflineWithinS: 86_400,
  handleBoundS: 30 * 86_400,
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
export type Presence = "online" | "idle" | "offline"
export type StatusState = "working" | "waiting" | "blocked" | "done"

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
  /** process keys of the claimant's harness process and its ancestors, nearest first: the nearest endpoint holding one places the claim under it */
  lineage?: string[]
  /** a `krt_` grant from `spawn-env`: places the claim at or below its lineage placement, with the grant's caps and groups */
  grant?: string
  /** the handle as named (`--as`): never suffixed; it takes over or joins that endpoint where the rules allow, else the claim is refused */
  exact?: boolean
  /**
   * a hook's claim for an in-process subagent of the harness holding the claim's lineage endpoint: the broker places it under that endpoint,
   * as `<its handle>-<type>-<first 6 of id>` with a session of its own, and only for a hook of that endpoint's own harness process. A stop's
   * claim (`stop`) takes only an endpoint the subagent already has, else is refused not_found; any other claim of a done one resumes it working
   */
  subagent?: { id: string; type?: string; stop?: boolean }
  scope?: ScopePreset
  in?: string[]
  out?: string[]
  groups?: string[]
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
  /**
   * the sender as the local broker sees it from the recipient, never from anything the sender claims: `parent` when it issued the grant the
   * recipient's current incarnation spent or is its ancestor, `child` when it is the recipient's descendant; unset for humans and other machines.
   * A recipient an `scp spawn` grant with a steer key placed hears only that issuer's keyed messages as `parent`: another ancestor's are `ancestor`
   */
  relation?: "parent" | "ancestor" | "child"
  /** with `parent`, from the issuer of the `scp spawn` grant the recipient spent: that grant's steer key, which the worker's prompt names */
  parent_key?: string
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
  others: number
  others_shown?: number
  pushes_left: number
  prompted?: true
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
 * `ended` never unless it is started again (it is done: an `scp spawn` run that exited, a finished subagent), `offline` never unless it
 * comes back, `starting` once it joins (the sender's own `scp spawn` of it has not joined yet)
 */
export type Reach = "running" | "ended" | "offline" | "starting"

export interface SendResult {
  id: string
  thread: string
  hop: number
  /**
   * `queued`: the recipient is not connected now; `offline`: it has been gone past a short grace, so a client polling between waits is not
   * offline; `state`: an agent recipient's {@link Reach} on this machine (an older broker leaves it out)
   */
  deliveries: { endpoint: string; address: string; seq: number; offline: boolean; queued?: boolean; last_seen: string | null; state?: Reach }[]
  duplicate?: boolean
  held?: JudgeHeld
  redacted?: JudgeRedacted
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
export const SERVER_FIELDS = ["from", "id", "seq", "hop", "created_at", "auth", "expires_at", "relation"] as const
