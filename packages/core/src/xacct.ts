import { type ErrorCode, MESSAGE_KINDS, type MessageKind, RelayError } from "./protocol"

/**
 * what a gate says about one cross-account message: pass it, deliver `body` in its place (`n` spans of these kinds replaced), refuse it,
 * hold it for the account's human as `hold_id` (nothing is delivered until a release runs the rest of the path again), or answer a retry
 * of a message whose hold `hold_id` was already released as the duplicate it is
 */
export type GateVerdict =
  | { verdict: "pass" }
  | { verdict: "refuse"; code: string; categories: string[]; retry_after?: number }
  | { verdict: "redact"; body: string; redacted: { n: number; kinds: string[] } }
  | { verdict: "hold"; hold_id: string }
  | { verdict: "duplicate"; hold_id: string }

/** the sender of a cross-account message, set by the sending account's hub from its principal and the bridge's auth class */
export interface XEnvelopeFrom {
  /** the sending account's handle */
  account: string
  /** `<account>/me` for the account's human at a terminal, else `<account>/<machine>/<handle>` */
  address: string
  human: boolean
  auth: "contact"
  /** `contact:<account>` */
  rel: string
  machine?: string
  harness?: string | null
}

/** one message between two account hubs */
export interface XMessage {
  id: string
  from: XEnvelopeFrom
  /** `<machine>/<handle>` in the recipient account (handle empty for a machine's human) */
  to: string
  body: string
  kind: string
  thread: string
  reply_to: string | null
  hop: number
  client_id: string
  created_at: number
  expires_at: number
  /** the recipient's own grant for the message this one replies to, which lets the reply past the recipient's scope */
  reply_grant?: string
  /** the expiry of the message `reply_grant` came with, which the grant covers */
  reply_grant_expires_at?: number
  /** a grant the recipient keeps: a reply carrying it back passes the sender's scope until this message expires */
  grant?: string
  /** the sending account's limits for this contact; the recipient applies them only to lower its own */
  limits?: XLimits
}

export interface XLimits {
  per_minute?: number
  per_hour?: number
  per_day?: number
}

export interface GateContext {
  side: "egress" | "ingress"
  /** this account's handle */
  account: string
  /** the other account's handle */
  peer: string
  /** the other account's id */
  peer_id?: string
  /** egress: the sending endpoint, which a release sends as again */
  sender?: string
}

/** the one hook a judge plugs into: called once as a message leaves an account, once as it enters the other */
export interface CrossAccountGate {
  egress(msg: XMessage, ctx: GateContext): Promise<GateVerdict>
  ingress(msg: XMessage, ctx: GateContext): Promise<GateVerdict>
}

export const PASS_GATE: CrossAccountGate = {
  egress: async () => ({ verdict: "pass" }),
  ingress: async () => ({ verdict: "pass" }),
}

/** one allowlist entry: which of this account's endpoints the contact may reach, and which may reach it */
export interface XAllow {
  /** a machine of this account, or `*` */
  machine: string
  /** `tree:root`, or `ep:<machine>/<handle>` */
  sel: string
  allow_worker?: true
}

/** an active contact as this account holds it */
export interface XContact {
  peerId: string
  peerHandle: string
  allow: XAllow[]
  /** `in`: the contact may message this account only; `out`: this account may message the contact only */
  dir: "in" | "out" | "both"
  limits: XLimits | null
}

/** an endpoint of a contact as discovery shows it */
export interface XListed {
  address: string
  harness: string | null
  presence: string
}

/** what a peer account's hub answered for a delivered message */
export interface XDelivered {
  id: string
  state: "delivered" | "queued"
  duplicate?: boolean
  /** the recipient's ingress judge held it for its human: nothing was delivered yet */
  held?: { hold_id: string }
  /** the recipient's ingress judge delivered it with spans replaced */
  redacted?: { n: number; kinds: string[] }
}

/** a held message its account's human released, as the hub runs the rest of that side's path for it again */
export type XRelease =
  | { side: "egress"; hold_id: string; sender: string; peer: string; message: XMessage }
  | { side: "ingress"; hold_id: string; from_account: string; message: XMessage }

/** the hub's link to other accounts, built by its host; the hub only calls it */
export interface CrossAccountLink {
  /** this account: its id and handle, from the host's authenticated principal, never a client */
  self: { id: string; handle: string }
  contactByHandle(handle: string): Promise<XContact | null>
  contactById(id: string): Promise<XContact | null>
  /** every active contact, for discovery; null when they cannot be loaded */
  contacts(): Promise<XContact[] | null>
  /** the peer hub's `xreceive`; throws the RelayError the peer answered */
  deliver(contact: XContact, msg: XMessage): Promise<XDelivered>
  /** the peer hub's `xlist` */
  list(contact: XContact): Promise<XListed[]>
  gate: CrossAccountGate
}

/** the cross-account caps; a deployment overrides any of them, and `Infinity` lifts a count cap */
export interface XLimitConfig {
  bodyBytes: number
  hopMax: number
  threadMax: number
  pairPerMinute: number
  pairPerHour: number
  accountPerDay: number
  accountPerDayMax: number
  /** the most day counts one write reserves ahead */
  reserveMax: number
  /** how long after its last write a reservation left over from a burst waits to be trued up */
  trueUpMs: number
}

export const XLIMITS: Readonly<XLimitConfig> = {
  bodyBytes: 16 * 1024,
  hopMax: 8,
  threadMax: 50,
  pairPerMinute: Infinity,
  pairPerHour: Infinity,
  accountPerDay: Infinity,
  accountPerDayMax: Infinity,
  reserveMax: 20,
  trueUpMs: 5 * 60_000,
}

/** an account handle as the relay addresses it */
export const ACCOUNT_HANDLE = /^[a-z0-9][a-z0-9-]{0,63}$/

export const ERROR_CODES: readonly ErrorCode[] = [
  "not_found",
  "inbox_full",
  "rate_limited",
  "loop_guard",
  "data_class_refused",
  "secret_refused",
  "policy_refused",
  "too_large",
  "invalid_params",
  "unauthorized",
  "method_not_found",
  "scope_refused",
  "unavailable",
  "judge_refused",
]

/** a gate's refusal as the error the sender sees: its code when it is a protocol code, else policy_refused */
export function gateRefusal(verdict: { code: string; categories: string[]; retry_after?: number }, side: "egress" | "ingress"): RelayError {
  const code = (ERROR_CODES as readonly string[]).includes(verdict.code) ? (verdict.code as ErrorCode) : "policy_refused"
  const categories = verdict.categories.filter((c) => typeof c === "string").map((c) => c.slice(0, 64))
  const what = code === "judge_refused" ? "relay judge" : "relay"
  const message = `the ${side === "egress" ? "sending" : "receiving"} account's ${what} refused this message${categories.length ? ` (${categories.join(", ")})` : ""}`
  if (code === "judge_refused") return new RelayError(code, message, undefined, { side, categories })
  const retry = Number.isInteger(verdict.retry_after) && verdict.retry_after! > 0 ? verdict.retry_after : undefined
  return new RelayError(code, message, retry)
}

/** one count of redactions for a message redacted on both sides */
export function joinRedacted(
  a: { n: number; kinds: string[] } | undefined,
  b: { n: number; kinds: string[] } | undefined,
): { n: number; kinds: string[] } | undefined {
  if (!a || !b) return a ?? b
  return { n: a.n + b.n, kinds: [...new Set([...a.kinds, ...b.kinds])].sort() }
}

/**
 * whether a contact's allowlist admits `<machine>/<handle>` at `depth` (null: unknown): `tree:root` a depth 0 agent on that machine or
 * any, `ep:<machine>/<handle>` that agent at any known depth, but 2 or deeper only with allow_worker; a machine's human (handle empty)
 * whenever an entry names its machine or any
 */
export function allowlisted(allow: XAllow[], machine: string, handle: string, depth: number | null): boolean {
  const onMachine = (entry: XAllow) => entry.machine === "*" || entry.machine === machine
  if (handle === "") return allow.some(onMachine)
  if (depth === null) return false
  return allow.some((entry) => {
    if (entry.sel === "tree:root") return depth === 0 && onMachine(entry)
    if (entry.sel !== `ep:${machine}/${handle}` || !onMachine(entry)) return false
    return depth < 2 || entry.allow_worker === true
  })
}

/** the reply grant a hub hands out with message `id` from its `address` to `peerId` until `expiresAt`, keyed by its own secret */
export function replyGrant(hash: (value: string) => string, key: string, id: string, address: string, peerId: string, expiresAt: number): string {
  return hash(`${key}|${id}|${address}|${peerId}|${expiresAt}|${key}`)
}

/** the caps of a contact (pair a minute and an hour, account a day) under `caps`, lowered by what the other side declared when it did */
export function xlimits(
  own: XLimits | null,
  declared?: XLimits,
  caps: Readonly<XLimitConfig> = XLIMITS,
): { perMinute: number; perHour: number; perDay: number } {
  const limits = own ?? {}
  const lower = (cap: number, value: number | undefined) => (value === undefined ? cap : Math.min(cap, value))
  return {
    perMinute: lower(Math.min(caps.pairPerMinute, positive(limits.per_minute) ?? caps.pairPerMinute), declared?.per_minute),
    perHour: lower(Math.min(caps.pairPerHour, positive(limits.per_hour) ?? caps.pairPerHour), declared?.per_hour),
    perDay: lower(
      Number.isFinite(caps.accountPerDay)
        ? Math.max(caps.accountPerDay, Math.min(positive(limits.per_day) ?? 0, caps.accountPerDayMax))
        : (positive(limits.per_day) ?? Infinity),
      declared?.per_day,
    ),
  }
}

/** a contact's limits as a message declares them: the positive whole ones only, or undefined for none */
export function declaredLimits(limits: XLimits | null): XLimits | undefined {
  const out: XLimits = {}
  for (const key of ["per_minute", "per_hour", "per_day"] as const) {
    const value = positive(limits?.[key])
    if (value !== undefined) out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

const MESSAGE_ID = /^[a-z]{2,8}_[a-z0-9]{8,64}$/
const TARGET = /^[a-z0-9][a-z0-9-]{0,31}\/([a-z0-9][a-z0-9._-]{0,62})?$/

/** a message another account's hub sent, checked field by field; anything off is invalid_params */
export function parseXMessage(value: unknown): XMessage & { kind: MessageKind } {
  const bad = (what: string) => new RelayError("invalid_params", `the cross-account message's ${what} is not valid`)
  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
  const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max
  if (!isRecord(value)) throw bad("shape")
  const from = value.from
  if (!text(value.id, 128) || !MESSAGE_ID.test(value.id)) throw bad("id")
  if (
    !isRecord(from) ||
    !text(from.account, 64) ||
    !ACCOUNT_HANDLE.test(from.account) ||
    !text(from.address, 200) ||
    typeof from.human !== "boolean" ||
    from.auth !== "contact"
  )
    throw bad("sender")
  if (from.machine !== undefined && !text(from.machine, 32)) throw bad("sender")
  if (from.harness !== undefined && from.harness !== null && !text(from.harness, 32)) throw bad("sender")
  if (typeof value.to !== "string" || !TARGET.test(value.to)) throw bad("to")
  if (typeof value.body !== "string") throw bad("body")
  if (!MESSAGE_KINDS.includes(value.kind as MessageKind)) throw bad("kind")
  if (!text(value.thread, 128)) throw bad("thread")
  if (value.reply_to !== null && !text(value.reply_to, 128)) throw bad("reply_to")
  if (!Number.isInteger(value.hop) || (value.hop as number) < 0) throw bad("hop")
  if (!text(value.client_id, 128)) throw bad("client_id")
  if (!Number.isFinite(value.created_at) || !Number.isFinite(value.expires_at)) throw bad("timestamps")
  for (const key of ["reply_grant", "grant"] as const) if (value[key] !== undefined && !text(value[key], 128)) throw bad(key)
  const whole = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0
  if (value.reply_grant_expires_at !== undefined && !whole(value.reply_grant_expires_at)) throw bad("reply_grant_expires_at")
  let limits: XLimits | undefined
  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) throw bad("limits")
    limits = {}
    for (const key of ["per_minute", "per_hour", "per_day"] as const) {
      const v = value.limits[key]
      if (v === undefined) continue
      if (!whole(v)) throw bad("limits")
      limits[key] = v
    }
  }
  const rel = typeof from.rel === "string" ? from.rel.slice(0, 128) : `contact:${from.account}`
  return {
    id: value.id,
    from: {
      account: from.account,
      address: from.address,
      human: from.human,
      auth: "contact",
      rel,
      ...(from.machine !== undefined ? { machine: from.machine as string } : {}),
      harness: (from.harness as string | null | undefined) ?? null,
    },
    to: value.to,
    body: value.body,
    kind: value.kind as MessageKind,
    thread: value.thread,
    reply_to: value.reply_to as string | null,
    hop: value.hop as number,
    client_id: value.client_id,
    created_at: value.created_at as number,
    expires_at: value.expires_at as number,
    ...(value.reply_grant !== undefined ? { reply_grant: value.reply_grant as string } : {}),
    ...(value.reply_grant_expires_at !== undefined ? { reply_grant_expires_at: value.reply_grant_expires_at as number } : {}),
    ...(value.grant !== undefined ? { grant: value.grant as string } : {}),
    ...(limits ? { limits } : {}),
  }
}

/** whether `from` is what the sending hub may claim: `<account>/me` exactly when its human at a terminal, else `<account>/<machine>/<handle>` */
export function honestSender(from: XEnvelopeFrom): boolean {
  if (from.address === `${from.account}/me`) return from.human
  if (from.human) return false
  const parts = from.address.split("/")
  return parts.length === 3 && parts[0] === from.account && TARGET.test(`${parts[1]}/${parts[2] === "me" ? "" : parts[2]}`)
}

export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

type Window = { at: number; n: number }
type Day = { day: number; count: number; reserved: number; recent: number[]; last: number; wrote: number }

/**
 * The sending side's cross-account counters, in memory: pair buckets per (sender, target) and the thread counts of this hub's
 * senders, a fast first line the recipient's own counts back up; and per contact the day's count, which survives a wake through a
 * reservation in one row per contact. The row is written ahead of the sends it covers (so it never trails a delivered message),
 * one at a time when sends are spread out and in growing steps during a burst; a leftover is trued up once the burst is over.
 */
export class XCounters {
  private readonly pairs = new Map<string, { minute: Window; hour: Window }>()
  private readonly threads = new Map<string, Window>()
  private days: Map<string, Day> | null = null
  readonly caps: Readonly<XLimitConfig>

  constructor(
    private readonly sql: { all<T>(query: string, ...params: (string | number | null)[]): T[] },
    private readonly now: () => number,
    limits: Partial<XLimitConfig> = {},
  ) {
    this.caps = { ...XLIMITS, ...limits }
  }

  /** throws when one more message from `sender` to `target` in `thread` over `contact` would pass a cap */
  check(contact: XContact, sender: string, target: string, thread: string): void {
    const now = this.now()
    const pair = this.pair(`${sender} ${target}`, now)
    const { perMinute, perHour, perDay } = xlimits(contact.limits, undefined, this.caps)
    if (pair.minute.n >= perMinute)
      throw new RelayError("rate_limited", `${perMinute} messages to ${target} a minute`, Math.max(1, Math.ceil((pair.minute.at + 60_000 - now) / 1000)))
    if (pair.hour.n >= perHour)
      throw new RelayError("rate_limited", `${perHour} messages to ${target} an hour`, Math.max(1, Math.ceil((pair.hour.at + 3_600_000 - now) / 1000)))
    if (Number.isFinite(perDay) && this.today(contact.peerId, now) >= perDay)
      throw new RelayError("rate_limited", `${perDay} messages to ${contact.peerHandle} today`, untilTomorrow(now))
    const inThread = this.window(this.threads, thread, now, 86_400_000)
    if (inThread.n >= this.caps.threadMax) throw new RelayError("loop_guard", `thread ${thread} reached ${this.caps.threadMax} messages across accounts`)
  }

  /**
   * counts one sent message, reserving ahead in storage first when the reservation is used up; call with no await since its check.
   * Returns the refund for a message the peer never took: the counts in memory go back, the stored reservation stays as an overcount.
   */
  sent(contact: XContact, sender: string, target: string, thread: string): () => void {
    const now = this.now()
    const pair = this.pair(`${sender} ${target}`, now)
    const { minute, hour } = pair
    const inThread = this.window(this.threads, thread, now, 86_400_000)
    minute.n++
    hour.n++
    inThread.n++
    const days = this.loaded()
    const day = dayStart(now)
    let count = days.get(contact.peerId)
    if (!count) {
      count = { day, count: 0, reserved: 0, recent: [], last: 0, wrote: 0 }
      days.set(contact.peerId, count)
    }
    if (count.day !== day) Object.assign(count, { day, count: 0, reserved: 0, recent: [] })
    count.recent = count.recent.filter((at) => now - at < 60_000).slice(-this.caps.reserveMax)
    if (count.count + 1 > count.reserved) this.write(contact.peerId, count, count.count + Math.min(this.caps.reserveMax, 1 + count.recent.length), now)
    count.count++
    count.recent.push(now)
    count.last = now
    this.trueUp(contact.peerId)
    const counted = count
    return () => {
      for (const window of [minute, hour, inThread]) window.n = Math.max(0, window.n - 1)
      if (counted.day !== day) return
      counted.count = Math.max(0, counted.count - 1)
      const at = counted.recent.lastIndexOf(now)
      if (at >= 0) counted.recent.splice(at, 1)
    }
  }

  /** writes the reservation of each contact down to its count once its burst is over (see dueAt), but for `skip` */
  trueUp(skip?: string): void {
    if (!this.days) return
    const now = this.now()
    for (const [contact, count] of this.days)
      if (contact !== skip && (this.due(count, now) ?? Number.POSITIVE_INFINITY) <= now) this.write(contact, count, count.count, now)
  }

  /** when the next true-up is due, or null when no reservation is left over */
  dueAt(): number | null {
    if (!this.days) return null
    const now = this.now()
    let next: number | null = null
    for (const count of this.days.values()) {
      const due = this.due(count, now)
      if (due !== null && (next === null || due < next)) next = due
    }
    return next
  }

  private due(count: Day, now: number): number | null {
    if (count.reserved <= count.count || count.day !== dayStart(now)) return null
    return Math.max(count.last + 60_000, count.wrote + this.caps.trueUpMs)
  }

  private write(contact: string, count: Day, reserved: number, now: number): void {
    this.sql.all(
      `INSERT INTO xcounters (contact, day, sent, at) VALUES (?, ?, ?, ?) ON CONFLICT (contact) DO UPDATE SET day = excluded.day, sent = excluded.sent, at = excluded.at`,
      contact,
      count.day,
      reserved,
      now,
    )
    count.reserved = reserved
    count.wrote = now
  }

  private today(contact: string, now: number): number {
    const count = this.loaded().get(contact)
    return count?.day === dayStart(now) ? count.count : 0
  }

  /** the stored reservations, each taken as that many sends: a wake can only overcount */
  private loaded(): Map<string, Day> {
    if (this.days) return this.days
    const rows = this.sql.all<{ contact: string; day: number; sent: number; at: number }>(`SELECT contact, day, sent, at FROM xcounters`)
    this.days = new Map(rows.map((row) => [row.contact, { day: row.day, count: row.sent, reserved: row.sent, recent: [], last: 0, wrote: row.at }]))
    return this.days
  }

  private pair(key: string, now: number): { minute: Window; hour: Window } {
    let pair = this.pairs.get(key)
    if (!pair) {
      pair = { minute: { at: now, n: 0 }, hour: { at: now, n: 0 } }
      this.pairs.set(key, pair)
    }
    if (now - pair.minute.at >= 60_000) pair.minute = { at: now, n: 0 }
    if (now - pair.hour.at >= 3_600_000) pair.hour = { at: now, n: 0 }
    return pair
  }

  private window(map: Map<string, Window>, key: string, now: number, ms: number): Window {
    let window = map.get(key)
    if (!window || now - window.at >= ms) {
      window = { at: now, n: 0 }
      map.set(key, window)
    }
    return window
  }

  /** drops windows that lapsed, so the maps hold only live keys */
  prune(): void {
    const now = this.now()
    for (const [key, pair] of this.pairs) if (now - pair.hour.at >= 3_600_000) this.pairs.delete(key)
    for (const [key, window] of this.threads) if (now - window.at >= 86_400_000) this.threads.delete(key)
  }
}

/** seconds until the next day starts, at least 1 */
export const untilTomorrow = (now: number): number => Math.max(1, Math.ceil((dayStart(now) + 86_400_000 - now) / 1000))

export const dayStart = (now: number): number => now - (now % 86_400_000)

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined)
