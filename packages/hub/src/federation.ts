import {
  type Admission,
  ACCOUNT_HANDLE,
  admits,
  type Claim,
  cleanLabels,
  cleanText,
  type CoreOptions,
  effectiveSelector,
  type EndpointKind,
  type EndpointRow,
  type EndpointView,
  type Envelope,
  findSecret,
  GONE_PREFIX,
  groupCapKey,
  HUMAN_HANDLE,
  LIMITS,
  MESSAGE_KINDS,
  type MessageRow,
  newId,
  one,
  type PolicySubject,
  type Presence,
  randomHex,
  RelayCore,
  RelayError,
  type ScopeCap,
  type ScopeCaps,
  type ScopeDirection,
  type ScopeEntry,
  type ScopeNode,
  type ScopeRules,
  type ScopeSubject,
  type SendParams,
  type SendResult,
  STATUS_STATES,
  type SqlValue,
  type StatusState,
  SYSTEM_HANDLE,
  seqList,
  unreachable,
  harnessFits,
  keptHarness,
  validHandle,
  validHarness,
  validSelector,
  type Wake,
  WAKES,
} from "@scp-dev/core"

export type RelayAuth = Envelope["from"]["auth"]

/** a machine name: one relay host of an account */
export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

const REMOTE = /^[a-z0-9][a-z0-9._-]{0,63}\/([a-z0-9][a-z0-9._-]{0,62})?$/
const MESSAGE_ID = /^[a-z]{2,8}_[a-z0-9]{8,64}$/
const AUTHS: readonly RelayAuth[] = ["local-uid", "account", "account+bridge", "contact"]
const PRESENCES: readonly Presence[] = ["online", "idle", "offline"]

export interface FederatedOptions extends CoreOptions {
  /** this host's own machine name; addresses naming it stay local */
  machine?: string
  /** other names of the local user, such as the account handle once known */
  aliases?: string[]
  /** `from.auth` of senders whose row records none (default local-uid) */
  auth?: RelayAuth
  /** at most this many live endpoints, mirrored and claimed together */
  endpointCap?: number
  /** at most this many refusal audit rows a minute for each refusal code; the next one written counts those left out */
  refusalsPerMinute?: number
  /** the hosted relay's cross-account tables: messages from other accounts in xinbox, in one seq space with deliveries */
  xinbox?: boolean
}

interface FederatedRow extends EndpointRow {
  remote: string | null
  auth: RelayAuth | null
  incarnation: string | null
  /** this machine's own agent: moves on when its caps loosen, so the incarnation it mirrors changes */
  scope_epoch: number | null
  /** this machine's own agent: the wire caps it mirrored last */
  mirrored_caps: string | null
  /** another machine's row: the presence its bridge mirrored last */
  mirrored_presence: Presence | null
}

/** own rules as they cross machines: selector lists per direction */
export interface MirrorRules {
  in?: string[]
  out?: string[]
}

/** caps and allowances as they cross machines: `by` and `via` name an endpoint of the same machine as `ep:<handle>`, else human, policy, inherited or gone */
export interface MirrorCaps {
  caps: ScopeCap[]
  allow?: Record<string, ScopeEntry[]>
}

/** an agent endpoint's place in its machine's tree, its rules and its caps; a field left out is unknown, or unchanged once known */
export interface MirrorScope {
  /** the root's handle on the same machine (a root's own) */
  tree?: string | null
  /** the parent's handle on the same machine; null for a root */
  parent_ep?: string | null
  /** 0 for a root; null when not known */
  depth?: number | null
  rules?: MirrorRules | null
  caps?: MirrorCaps | null
  /**
   * changes when its machine released the endpoint and another took the handle, a new spawn took it over, or its caps loosened: the caps
   * seen before lapse. The part before the first "." names the holder: a change there also drops what a hub queued for the endpoint
   */
  incarnation?: string | null
}

/** an endpoint as another machine reports it: EndpointView-like, only the address's last segment is used as the handle */
export interface MirrorView extends MirrorScope {
  address: string
  kind: EndpointKind
  harness?: string | null
  model?: string | null
  cwd?: string | null
  labels?: Record<string, string>
  status?: { state: StatusState; note: string } | null
  presence?: Presence
  last_seen?: string | null
  title?: string | null
  /** an agent's {@link Wake}; a value this hub does not know is kept as none */
  wake?: string | null
  /** the handle the endpoint had before a rename: its mirror is renamed in place */
  was?: string
}

export interface RemoteView extends Omit<EndpointView, "depth">, MirrorScope {
  machine: string
}

interface Placement {
  tree: string | null
  parent_ep: string | null
  depth: number | null
}

interface ParsedScope {
  tree?: string | null
  parent?: string | null
  depth?: number | null
  rules?: MirrorRules | null
  caps?: ScopeCaps | null
  title?: string | null
  wake?: Wake | null
  incarnation?: string | null
}

type ParsedView = {
  handle: string
  kind: EndpointKind
  harness: string | null
  model: string | null
  cwd: string | null
  labels: string
  status: { state: StatusState; note: string } | null
  presence: Presence
  lastSeen: number | null
  scope: ParsedScope
  was: string | null
}

const UNKNOWN: Placement = { tree: null, parent_ep: null, depth: null }
const REFS = new Set(["human", "policy", "inherited", "gone"])
const INCARNATION = /^[A-Za-z0-9._:-]{1,128}$/
const SCOPE_BYTES = 16 * 1024

const XACCT_MIGRATION = [
  `CREATE TABLE IF NOT EXISTS xinbox (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, from_account TEXT NOT NULL, client_id TEXT NOT NULL, endpoint TEXT NOT NULL, sender TEXT NOT NULL, message TEXT NOT NULL, thread TEXT NOT NULL, grant TEXT, expires_at INTEGER NOT NULL, at INTEGER NOT NULL, UNIQUE (from_account, client_id))`,
  `CREATE TABLE IF NOT EXISTS xcursor (endpoint TEXT PRIMARY KEY, acked_seq INTEGER NOT NULL, at INTEGER, old_seq INTEGER, old_at INTEGER) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS xstate (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS xcounters (contact TEXT PRIMARY KEY, day INTEGER, sent INTEGER, at INTEGER) WITHOUT ROWID`,
]

/**
 * how long an xinbox row outlives its receipt, and an acked one its ack (24 to about 48 h, by the cursor's checkpoint): the reply
 * grant, the dedupe of a retry and the recipient's rate counts read it
 */
const XINBOX_KEEP_MS = 86_400_000

/** the highest seq handed out so far: deliveries' and xinbox's, kept past purges by the acked cursors and the sweep's floor */
const SEQ_TOP = `MAX(COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'deliveries'), 0), COALESCE((SELECT MAX(seq) FROM xinbox), 0),
  COALESCE((SELECT MAX(acked_seq) FROM xcursor), 0), COALESCE((SELECT CAST(value AS INTEGER) FROM xstate WHERE key = 'seq_floor'), 0))`

/** a row of xinbox: a message from another account, its envelope as JSON */
export interface XInboxRow {
  seq: number
  id: string
  from_account: string
  client_id: string
  endpoint: string
  /** the sender's address in its account */
  sender: string
  message: string
  thread: string
  grant: string | null
  expires_at: number
  /** when it was received */
  at: number
}

/** a mirrored endpoint of this account as the cross-account checks see it */
export interface XEndpoint {
  id: string
  /** `<machine>/<handle>`, handle empty for a machine's human */
  remote: string
  machine: string
  handle: string
  kind: EndpointKind
  depth: number | null
  harness: string | null
  presence: Presence
}

export interface MirrorChange {
  view: RemoteView
  added: boolean
  presence: boolean
  status: boolean
  /** the handle a renamed mirror had */
  was?: string
}

export interface Delivery {
  seq: number
  /** `<machine>/<handle>` of the recipient, or null for a row of no machine */
  endpoint: string | null
  /** the recipient's endpoint id */
  recipient: string
  /** whether the recipient is a row its machine's bridge mirrors, not one a direct client claimed */
  mirrored: boolean
  message: Envelope
}

const machinePart = (remote: string): string => remote.slice(0, remote.indexOf("/"))
/** a stand-in for another account's sender, `@<account>/...`: never a machine of this account */
const isForeign = (remote: string): boolean => remote.startsWith("@")
const foreignOf = (remote: string): string => remote.slice(1, remote.indexOf("/"))

/** an endpoint of another account as the scope check sees it: it matches only `acct:` selectors */
export function foreignNode(peer: { account: string; machine: string; handle: string }): ScopeNode {
  const address = `${peer.account}/${peer.machine}/${peer.handle || "me"}`
  return {
    id: `@${address}`,
    address,
    subject: { handle: peer.handle, harness: null, kind: peer.handle === "" ? "human" : "agent", labels: {}, account: peer.account },
    rules: {},
    caps: { caps: [], allow: {} },
    groups: [],
    policy: [],
  }
}
const handlePart = (remote: string): string => remote.slice(remote.indexOf("/") + 1)

/** RelayCore with endpoints of other machines: qualified addresses, mirrored and proxy rows, injection and forwarding records */
export class FederatedCore extends RelayCore {
  readonly machine: string | null
  private aliases: Set<string>
  private account: string | null = null
  private others = new Set<string>()
  private scope: string | null = null
  private readonly defaultAuth: RelayAuth
  private readonly endpointCap: number | null
  private readonly refusalsPerMinute: number | null
  private readonly refusals = new Map<string, { minute: number; written: number; suppressed: number }>()
  private readonly xinbox: boolean
  private xfrom: Set<string> | null = null

  constructor(sql: ConstructorParameters<typeof RelayCore>[0], options: FederatedOptions) {
    super(sql, options)
    this.machine = options.machine ?? null
    this.aliases = new Set(options.aliases ?? [])
    this.defaultAuth = options.auth ?? "local-uid"
    this.endpointCap = options.endpointCap ?? null
    this.refusalsPerMinute = options.refusalsPerMinute ?? null
    this.xinbox = options.xinbox === true
  }

  override migrate(): void {
    super.migrate()
    const columns = this.sql.all<{ name: string }>(`PRAGMA table_info(endpoints)`).map((c) => c.name)
    if (!columns.includes("remote")) this.sql.all(`ALTER TABLE endpoints ADD COLUMN remote TEXT`)
    if (!columns.includes("auth")) this.sql.all(`ALTER TABLE endpoints ADD COLUMN auth TEXT`)
    if (!columns.includes("incarnation")) this.sql.all(`ALTER TABLE endpoints ADD COLUMN incarnation TEXT`)
    if (!columns.includes("scope_epoch")) this.sql.all(`ALTER TABLE endpoints ADD COLUMN scope_epoch INTEGER`)
    if (!columns.includes("mirrored_caps")) this.sql.all(`ALTER TABLE endpoints ADD COLUMN mirrored_caps TEXT`)
    if (!columns.includes("mirrored_presence")) this.sql.all(`ALTER TABLE endpoints ADD COLUMN mirrored_presence TEXT`)
    this.sql.all(`CREATE UNIQUE INDEX IF NOT EXISTS endpoints_remote ON endpoints (remote) WHERE remote IS NOT NULL`)
    if (this.xinbox) for (const statement of XACCT_MIGRATION) this.sql.all(statement)
  }

  /** with xinbox, a delivery takes the next seq past xinbox's too, so a bridge's replay and ack cursor stay one space */
  protected override insertDelivery(messageId: string, endpoint: string, expiresAt: number): number {
    if (!this.xinbox) return super.insertDelivery(messageId, endpoint, expiresAt)
    return one<{ seq: number }>(
      this.sql,
      `INSERT INTO deliveries (seq, message_id, endpoint, expires_at) VALUES (1 + ${SEQ_TOP}, ?, ?, ?) RETURNING seq`,
      messageId,
      endpoint,
      expiresAt,
    )!.seq
  }

  setAliases(aliases: string[]): void {
    this.aliases = new Set(aliases)
  }

  /** the account handle another member's machines render under, `<account>/<machine>/<handle>`; this member's own stay `me/<machine>/<handle>` */
  setOthers(account: string, machines: Iterable<string>): void {
    this.account = account
    this.others = new Set(machines)
  }

  /** whether `machine` is another member's: it renders under the account handle */
  setOther(machine: string, other: boolean): void {
    if (other) this.others.add(machine)
    else this.others.delete(machine)
  }

  /** how this host renders `<machine>/<handle>` of its own account */
  remoteAddress(remote: string): string {
    return `${this.account && this.others.has(machinePart(remote)) ? this.account : this.user}/${remote}`
  }

  /** runs `fn` with unqualified handles resolving on `machine`: a direct client's own namespace on the hub */
  within<T>(machine: string | null, fn: () => T): T {
    const previous = this.scope
    this.scope = machine
    try {
      return fn()
    } finally {
      this.scope = previous
    }
  }

  // addresses

  /** the hub-side address (`<machine>/<handle>`) an address names, another account's as it is, or null when it is on this machine */
  route(address: unknown): string | null {
    if (this.foreignAccount(address)) return String(address).trim()
    const { machine, handle } = this.locate(address)
    return machine === null ? null : `${machine}/${handle}`
  }

  /** whether an address names an endpoint on another machine or of another account; malformed addresses are not remote */
  isRemote(address: unknown): boolean {
    try {
      return this.route(address) !== null
    } catch {
      return false
    }
  }

  /** the local endpoint id a hub delivery for `<machine>/<handle>` is for */
  localTarget(target: unknown): string {
    if (typeof target !== "string" || !REMOTE.test(target) || machinePart(target) !== this.machine)
      throw new RelayError("not_found", `no endpoint ${String(target)} on this machine`)
    const handle = handlePart(target)
    const row = handle === "" ? this.byHandle(HUMAN_HANDLE) : validHandle(handle) ? this.byHandle(handle) : undefined
    if (!row) throw new RelayError("not_found", `no endpoint ${target} on this machine`)
    return row.id
  }

  /** the live row of `<machine>/<handle>`, for a bridge acting on its own machine's endpoints */
  remoteEndpoint(machine: string, handle: unknown): string {
    if (typeof handle !== "string" || handle.includes("/")) throw new RelayError("invalid_params", "from is a handle on the bridge's own machine")
    const row = this.byRemote(`${machine}/${handle}`)
    if (!row) throw new RelayError("not_found", `no endpoint ${machine}/${handle}`)
    return row.id
  }

  /** the machine an endpoint row belongs to, or null for a row of this host */
  machineOf(endpoint: string): string | null {
    const row = this.byId(endpoint) as FederatedRow | undefined
    return row?.remote ? machinePart(row.remote) : null
  }

  /** `<account>/<machine>/<handle>` of another account (handle empty for its machine's human, `me`), or null for any other address */
  foreignAccount(address: unknown): { account: string; machine: string; handle: string } | null {
    if (typeof address !== "string") return null
    const parts = address.trim().split("/")
    if (parts.length !== 3) return null
    const [account, machine, handle] = parts as [string, string, string]
    if (this.isLocalUser(account) || !ACCOUNT_HANDLE.test(account) || !MACHINE_NAME.test(machine)) return null
    if (handle !== "me" && handle !== "" && !validHandle(handle)) return null
    return { account, machine, handle: handle === "me" ? "" : handle }
  }

  private isLocalUser(part: string): boolean {
    return part === "me" || part === "local" || part === this.user || this.aliases.has(part)
  }

  /** whether an endpoint of another account `part` ever reached this relay, so `<part>/me` is that account's human */
  private knownAccount(part: string): boolean {
    return (
      !this.isLocalUser(part) &&
      ACCOUNT_HANDLE.test(part) &&
      one(this.sql, `SELECT 1 FROM endpoints WHERE substr(remote, 1, ?) = ? LIMIT 1`, part.length + 2, `@${part}/`) !== undefined
    )
  }

  private locate(address: unknown): { machine: string | null; handle: string } {
    if (typeof address !== "string" || !address.trim()) throw new RelayError("invalid_params", "an address is machine/handle, user/handle, or a handle")
    const text = address.trim()
    const parts = text.split("/")
    let machine: string | null
    let handle: string
    if (parts.length === 1) [machine, handle] = [null, parts[0]!]
    else if (parts.length === 2 && parts[1] === "me" && this.knownAccount(parts[0]!))
      throw new RelayError(
        "invalid_params",
        `${text} is account ${parts[0]}'s human, which takes no messages yet; message one of its endpoints (${parts[0]}/<machine>/<handle>)`,
      )
    else if (parts.length === 2) [machine, handle] = [this.isLocalUser(parts[0]!) ? null : parts[0]!, parts[1]!]
    else if (parts.length === 3 && this.isLocalUser(parts[0]!)) [machine, handle] = [parts[1]!, parts[2]!]
    else throw unreachable(text)
    if (machine !== null && handle === "me") handle = ""
    if (machine === null && this.scope !== null && handle !== "") machine = this.scope
    if (machine !== null && machine === this.machine) machine = null
    return { machine, handle }
  }

  protected override resolve(address: unknown): EndpointRow {
    const { machine, handle } = this.locate(address)
    const text = String(address).trim()
    if (machine === null) {
      const row = handle === "" ? this.byHandle(HUMAN_HANDLE) : validHandle(handle) ? this.byHandle(handle) : undefined
      if (!row) throw unreachable(text)
      return row
    }
    const row = this.byRemote(`${machine}/${handle}`)
    if (!row) throw unreachable(text)
    return row
  }

  protected override addressUsers(): string[] {
    return [this.user, "me", "local", ...this.aliases]
  }

  protected override localRow(row: EndpointRow): boolean {
    return !(row as FederatedRow).remote
  }

  /** a live mirrored row shows the presence its machine mirrored, not one its last_seen decays to here */
  protected override view(row: EndpointRow, shown?: Set<string>): EndpointView {
    const view = super.view(row, shown)
    const { remote, mirrored_presence: mirrored } = row as FederatedRow
    return remote && row.connections > 0 && (mirrored === "online" || mirrored === "idle") ? { ...view, presence: mirrored } : view
  }

  protected override address(row: EndpointRow): string {
    const remote = (row as FederatedRow).remote
    if (remote && isForeign(remote)) return remote.slice(1)
    return remote ? this.remoteAddress(remote) : super.address(row)
  }

  protected override subject(row: EndpointRow): PolicySubject {
    const remote = (row as FederatedRow).remote
    if (!remote) return super.subject(row)
    return {
      handle: "",
      harness: row.harness,
      kind: row.kind,
      labels: JSON.parse(row.labels) as Record<string, string>,
      ...(isForeign(remote) ? { account: foreignOf(remote) } : {}),
    }
  }

  /** a stand-in for another account's sender is no endpoint of this relay: list, peers and snapshots leave it out */
  protected override listable(row: EndpointRow): boolean {
    const remote = (row as FederatedRow).remote
    return !remote || !isForeign(remote)
  }

  /** an address of another account (a sender's stand-in, or a target with none) is checked as that account's endpoint */
  protected override policySubject(address: string): PolicySubject {
    const proxy = typeof address === "string" ? this.byRemote(`@${address.trim()}`) : undefined
    if (proxy) return this.subject(proxy)
    const foreign = this.foreignAccount(address)
    if (foreign) return foreignNode(foreign).subject
    return super.policySubject(address)
  }

  /**
   * another machine's row sits in no local tree: a fleet of its own on its machine, so a scoped local endpoint reaches it only by a leaving
   * selector; its mirrored ancestors are kept so a cap widened by one of them is clipped as on its machine
   */
  protected override scopeSubject(row: EndpointRow): ScopeSubject {
    const remote = (row as FederatedRow).remote
    if (!remote) return super.scopeSubject(row)
    const ancestors: string[] = []
    for (let id = row.parent_ep; id && id !== row.id && !ancestors.includes(id) && ancestors.length <= LIMITS.depthMax; id = this.byId(id)?.parent_ep ?? null)
      ancestors.push(id)
    return { id: row.id, tree: row.tree ?? row.id, ancestors, groups: [], rootHandle: "", machine: machinePart(remote), local: false }
  }

  /** another machine's row has the rules and caps its machine mirrored; only the hub's own human (a full login on the hub) is the account's human */
  protected override scopeNode(row: EndpointRow): ScopeNode {
    const remote = (row as FederatedRow).remote
    if (!remote) return super.scopeNode(row)
    if (isForeign(remote))
      return { id: row.id, address: this.address(row), subject: this.subject(row), rules: {}, caps: { caps: [], allow: {} }, groups: [], policy: [] }
    const subject = row.kind === "system" ? this.subject(row) : { ...this.subject(row), scope: this.scopeSubject(row) }
    const human = row.kind === "human" && handlePart(remote) === "" && this.isLocalUser(machinePart(remote))
    const caps = row.caps ? (JSON.parse(row.caps) as ScopeCaps) : { caps: [], allow: {} }
    return {
      id: row.id,
      address: this.address(row),
      subject,
      human,
      rules: row.rules ? (JSON.parse(row.rules) as ScopeRules) : {},
      caps: { caps: caps.caps, allow: caps.allow ?? {} },
      groups: [],
      policy: [],
    }
  }

  /**
   * throws not_found, as send() does, when the scope refuses a local endpoint's message to an address on another machine, a reply
   * (`replyTo`, its parent) to a message it got from that address passing as a solicited one; to another account, the cross-account rule on
   * the sender's out lists, unless it replies to a message it got from exactly that address
   */
  scopeCheck(from: string, to: unknown, replyTo?: string): void {
    const foreign = this.foreignAccount(to)
    if (!foreign) {
      const parent = replyTo === undefined ? undefined : one<MessageRow>(this.sql, `SELECT * FROM messages WHERE id = ?`, String(replyTo))
      this.checkScope(this.mustEndpoint(from), this.resolve(to), String(to).trim(), parent)
      return
    }
    const sender = this.mustEndpoint(from)
    const text = String(to).trim()
    if (replyTo !== undefined) {
      const parent = one<{ from_ep: string }>(
        this.sql,
        `SELECT m.from_ep AS from_ep FROM messages m JOIN deliveries d ON d.message_id = m.id WHERE m.id = ? AND d.endpoint = ?`,
        replyTo,
        from,
      )
      const origin = parent ? this.byId(parent.from_ep) : undefined
      if (origin && this.address(origin) === text) return
    }
    const admission = this.crossAdmission(from, "out", foreignNode(foreign))
    if (admission.ok) return
    this.audit("scope_refused", from, null, { from: this.address(sender), to: text, dir: "out", reason: admission.why })
    throw new RelayError("not_found", `no endpoint ${text}`)
  }

  /** whether direction `dir` of `endpoint` admits an endpoint of another account: only an `acct:` selector in each list, or no list at all */
  crossAdmission(endpoint: string, dir: ScopeDirection, peer: ScopeNode | { account: string; machine: string; handle: string }): Admission {
    const world = this.scopeWorld()
    const node = world.node(endpoint)
    if (!node) return { ok: false, why: "the endpoint is gone" }
    return admits(world, node, dir, "id" in peer ? peer : foreignNode(peer))
  }

  protected override envelope(row: MessageRow, seq?: number, recipient?: string): Envelope {
    const envelope = super.envelope(row, seq, recipient)
    const sender = this.byId(row.from_ep) as FederatedRow | undefined
    if (sender?.remote && isForeign(sender.remote)) {
      const account = foreignOf(sender.remote)
      const parts = sender.remote.slice(1).split("/")
      const { rel: _, ...from } = envelope.from
      envelope.from = {
        ...from,
        user: account,
        auth: "contact",
        account,
        rel: `contact:${account}`,
        ...(parts.length === 3 ? { machine: parts[1]! } : {}),
        ...(sender.kind === "human" ? { human: true as const } : {}),
      }
      return envelope
    }
    const machine = sender?.remote ? machinePart(sender.remote) : null
    const other = machine !== null && !this.isLocalUser(machine)
    const human = other && sender?.kind === "human" && row.sender_tty === 1
    envelope.from = { ...envelope.from, auth: sender?.auth ?? this.defaultAuth, ...(other ? { machine } : {}), ...(human ? { human: true as const } : {}) }
    return envelope
  }

  // mirrored and claimed rows

  /**
   * upserts a machine's endpoints from its views, never over a direct client's claimed row; `full` marks its mirrored rows missing from the
   * list offline. An agent's place is worked out here from its mirrored parent, and a cap seen once stays until the endpoint is released
   * (a new `incarnation`). A row is written only when something in it changed. `seen` gathers the remotes of a full mirror sent in several
   * frames: each frame adds its own, and the closing `full` one counts every remote in it as listed.
   */
  mirror(machine: string, views: unknown, options: { full?: boolean; auth?: RelayAuth; seen?: Set<string> } = {}): MirrorChange[] {
    this.checkMachine(machine)
    if (!Array.isArray(views)) throw new RelayError("invalid_params", "endpoints must be a list")
    if (views.length > (this.endpointCap ?? 4096)) throw new RelayError("too_large", `at most ${this.endpointCap ?? 4096} endpoints`)
    const parsed = [...new Map(views.map((view) => this.parseView(view)).map((view) => [view.handle, view])).values()]
    const auth = options.auth ?? null
    return this.tx(() => {
      const now = this.now()
      const changes: MirrorChange[] = []
      const seen = options.seen ?? new Set<string>()
      const batch: { view: ParsedView; id: string; before: FederatedRow | undefined }[] = []
      const renamed = new Map<string, string>()
      for (const view of parsed) {
        const remote = `${machine}/${view.handle}`
        seen.add(remote)
        let before = this.byRemote(remote)
        const old = !before && view.was !== null ? this.byRemote(`${machine}/${view.was}`) : undefined
        if (old && old.token_hash === null) {
          this.sql.all(`UPDATE endpoints SET remote = ? WHERE id = ?`, remote, old.id)
          before = this.byId(old.id) as FederatedRow
          renamed.set(old.id, view.was!)
        }
        if (before && before.token_hash !== null) continue
        if (!before) this.checkCap()
        batch.push({ view, id: before?.id ?? this.insertRemote(remote, view.kind, view.harness, auth, now), before })
      }
      const place = this.placer(machine, batch)
      for (const { view, id, before } of batch) {
        const row = before ?? (this.byId(id) as FederatedRow)
        if (before && view.kind === "agent") this.dropEarlierHolder(before, view.scope.incarnation)
        const live = view.presence !== "offline"
        const next: Partial<FederatedRow> = {
          kind: view.kind,
          harness: view.harness,
          model: view.model,
          cwd: view.cwd,
          labels: view.labels,
          status_state: view.status?.state ?? null,
          status_note: view.status?.note ?? null,
          token_hash: null,
          connections: live ? 1 : 0,
          mirrored_presence: view.presence,
          last_seen: view.lastSeen ?? (live ? now : (before?.last_seen ?? null)),
          auth: auth ?? row.auth,
          ...(view.kind === "agent" ? this.scopeColumns(machine, view.scope, row, place(view.handle)) : {}),
        }
        const columns = Object.entries(next).filter(([column, value]) => row[column as keyof FederatedRow] !== value)
        const was = renamed.get(id)
        if (!columns.length && was === undefined) continue
        if (columns.length)
          this.sql.all(
            `UPDATE endpoints SET ${columns.map(([column]) => `${column} = ?`).join(", ")} WHERE id = ?`,
            ...columns.map(([, value]) => value as SqlValue),
            id,
          )
        const change = this.diff(before, this.byId(id)!)
        if (was !== undefined) changes.push({ ...(change ?? { view: this.remoteView(this.byId(id)!), added: false, presence: true, status: false }), was })
        else if (change) changes.push(change)
      }
      if (options.full) {
        const missing = this.sql.all<FederatedRow>(
          `SELECT * FROM endpoints WHERE substr(remote, 1, ?) = ? AND token_hash IS NULL AND connections > 0`,
          machine.length + 1,
          `${machine}/`,
        )
        for (const row of missing.filter((r) => !seen.has(r.remote!))) {
          this.sql.all(`UPDATE endpoints SET connections = 0, last_seen = ? WHERE id = ?`, now, row.id)
          changes.push({ view: this.remoteView(this.byId(row.id)!), added: false, presence: true, status: false })
        }
      }
      return changes
    })
  }

  /**
   * a local agent's place, rules and caps as its machine's bridge mirrors them (MirrorScope), with its title; nothing for another row. Caps
   * looser than the ones mirrored last move the endpoint's scope epoch and so its incarnation: a hub keeps the caps it has seen until that changes
   */
  mirrorScope(endpoint: string): MirrorScope & { title?: string | null } {
    const row = this.mustEndpoint(endpoint)
    if (row.kind !== "agent" || !this.localRow(row)) return {}
    const node = this.scopeNode(row)
    const root = row.tree ? this.byId(row.tree) : row
    const parent = row.parent_ep ? this.byId(row.parent_ep) : undefined
    const caps: ScopeCap[] = [...node.caps.caps]
    for (const group of node.groups) {
      for (const dir of ["in", "out"] as const) {
        const rules = group[dir]
        if (!rules) continue
        const list = { source: "", by: group.owner, group: group.name, entries: [] }
        const sels = [...rules, ...(node.caps.allow[groupCapKey(group.name, dir)] ?? [])].map((entry) => ({ ...entry, sel: effectiveSelector(list, entry) }))
        caps.push({ id: groupCapKey(group.name, dir), dir, by: group.owner, sels })
      }
    }
    for (const cap of node.policy) caps.push({ id: `policy:${cap.match}:${cap.dir}`, dir: cap.dir, by: "policy", sels: cap.sels })
    const allow = Object.fromEntries(Object.entries(node.caps.allow).filter(([key]) => key.startsWith("inherited:")))
    const rules: MirrorRules = { ...(node.rules.in ? { in: node.rules.in } : {}), ...(node.rules.out ? { out: node.rules.out } : {}) }
    const wire = caps.length || Object.keys(allow).length ? this.wireCaps({ caps, allow }) : null
    const epoch = this.scopeEpoch(row as FederatedRow, wire)
    return {
      tree: root?.handle ?? null,
      parent_ep: parent?.handle ?? null,
      depth: row.depth ?? 0,
      rules: Object.keys(rules).length ? rules : null,
      caps: wire,
      title: row.title ?? null,
      incarnation: `${this.hash(row.spawned_at ? `${row.id}@${row.spawned_at}` : row.id).slice(0, 24)}.${epoch}`,
    }
  }

  private scopeEpoch(row: FederatedRow, caps: MirrorCaps | null): number {
    const epoch = row.scope_epoch ?? 0
    const text = caps ? JSON.stringify(caps) : null
    if (text === row.mirrored_caps) return epoch
    const seen = row.mirrored_caps ? (JSON.parse(row.mirrored_caps) as MirrorCaps) : null
    const next = seen && loosens(seen, caps ?? { caps: [] }) ? epoch + 1 : epoch
    this.sql.all(`UPDATE endpoints SET scope_epoch = ?, mirrored_caps = ? WHERE id = ?`, next || null, text, row.id)
    return next
  }

  /**
   * a direct client's claim of `<machine>/<handle>`, with claim()'s takeover and suffix rules, and its `exact`, `scope`, `allow`, `in` and
   * `out`: a new row takes the claim's own rules, a taken-over one keeps its own. An exact claim is never suffixed: it joins a live claimed
   * row of the same harness no process or session holds, with no new token, and is refused as claim() refuses one otherwise
   */
  claimOn(machine: string, claim: Claim, auth: RelayAuth = "account"): { endpoint: EndpointView; token?: string } {
    this.checkMachine(machine)
    const harness = cleanText(claim.harness, "harness", 32) ?? "cli"
    if (!validHarness(harness)) throw new RelayError("invalid_params", `harness ${JSON.stringify(harness)} is not a valid name`)
    const wanted = cleanText(claim.handle, "handle", 63) ?? harness
    if (!validHandle(wanted)) throw new RelayError("invalid_params", `handle ${JSON.stringify(wanted)} is not valid: lowercase letters, digits, . _ -`)
    const fields = {
      model: cleanText(claim.model, "model", 128),
      cwd: cleanText(claim.cwd, "cwd", 1024),
      parent: cleanText(claim.parent, "parent", 128),
      labels: JSON.stringify(cleanLabels(claim.labels)),
    }
    const leaked = [wanted, fields.model, fields.cwd, fields.parent, fields.labels].map((v) => (v ? findSecret(v) : null)).find(Boolean)
    if (leaked) throw new RelayError("secret_refused", `the claim looks like it carries a credential (${leaked})`)
    const rules = this.claimRules(claim)
    const exact = claim.exact === true
    return this.tx(() => {
      const now = this.now()
      let row: FederatedRow | undefined
      let created = false
      let joined = false
      for (let n = 1; n < (exact ? 2 : 1000) && !row; n++) {
        const handle = n === 1 ? wanted : `${wanted.slice(0, 58)}-${n}`
        const held = this.byRemote(`${machine}/${handle}`)
        if (!held) {
          this.checkCap()
          row = this.byId(this.insertRemote(`${machine}/${handle}`, "agent", harness, auth, now)) as FederatedRow
          created = true
        } else if (held.kind === "agent" && held.connections === 0 && harnessFits(held.harness, harness)) {
          row = held
        } else if (
          exact &&
          held.kind === "agent" &&
          held.token_hash !== null &&
          held.process === null &&
          held.session === null &&
          held.parent_ep === null &&
          harnessFits(held.harness, harness)
        ) {
          row = held
          joined = true
        } else if (held.kind === "agent" && held.connections === 0 && (held.last_seen ?? held.created_at) < now - LIMITS.handleBoundS * 1000) {
          this.retire(held.id)
          n--
        }
      }
      if (!row) {
        if (exact) throw this.exactRefusal(this.byRemote(`${machine}/${wanted}`)!, wanted, harness, now)
        throw new RelayError("invalid_params", `no free handle for ${wanted} on ${machine}`)
      }
      if (created) {
        const own = this.boundRules(rules)
        if (Object.keys(own).length) this.sql.all(`UPDATE endpoints SET rules = ? WHERE id = ?`, JSON.stringify(own), row.id)
        for (const dir of ["in", "out"] as const) this.needGroups(this.byId(row.id)!, rules[dir])
      }
      const token = joined ? undefined : `kre_${randomHex(32)}`
      this.sql.all(
        `UPDATE endpoints SET harness = ?, model = ?, cwd = ?, parent = ?, labels = ?, token_hash = ${token ? "?" : "token_hash"}, auth = ?, connections = connections + 1, last_seen = ? WHERE id = ?`,
        keptHarness(row.harness, harness),
        fields.model,
        fields.cwd,
        fields.parent,
        fields.labels,
        ...(token ? [this.hash(token)] : []),
        auth,
        now,
        row.id,
      )
      this.audit("claim", row.id, null, { handle: row.remote, harness, ...(joined ? { joined: true } : {}) })
      return { endpoint: this.view(this.byId(row.id)!), ...(token ? { token } : {}) }
    })
  }

  /**
   * resume() for a direct client of `machine`, its labels replaced by what `relabel` makes of them, held to the label limits: a token of
   * another machine's endpoint is refused
   */
  resumeOn(machine: string, token: string, relabel?: (labels: Record<string, string>) => unknown): EndpointView {
    const row = typeof token === "string" ? one<FederatedRow>(this.sql, `SELECT * FROM endpoints WHERE token_hash = ?`, this.hash(token)) : undefined
    if (!row?.remote || machinePart(row.remote) !== machine) throw new RelayError("unauthorized", "unknown resume token")
    if (!relabel) return this.resume(token)
    const merged = JSON.stringify(cleanLabels(relabel(JSON.parse(row.labels) as Record<string, string>)))
    return this.tx(() => {
      if (merged !== row.labels) this.sql.all(`UPDATE endpoints SET labels = ? WHERE id = ?`, merged, row.id)
      return this.resume(token)
    })
  }

  /** every live row of other machines (or of one machine), as views with their machine */
  remoteViews(filter: { except?: string; machine?: string } = {}): RemoteView[] {
    return this.sql
      .all<FederatedRow>(`SELECT * FROM endpoints WHERE remote IS NOT NULL ORDER BY remote`)
      .filter((row) => (!filter.except || machinePart(row.remote!) !== filter.except) && (!filter.machine || machinePart(row.remote!) === filter.machine))
      .map((row) => this.remoteView(row))
  }

  remoteRowsOf(machine: string): RemoteView[] {
    return this.remoteViews({ machine })
  }

  /** a bridge went away: its mirrored rows show offline */
  markOffline(machine: string): MirrorChange[] {
    const rows = this.sql.all<{ id: string }>(
      `UPDATE endpoints SET connections = 0, last_seen = ? WHERE substr(remote, 1, ?) = ? AND token_hash IS NULL AND connections > 0 RETURNING id`,
      this.now(),
      machine.length + 1,
      `${machine}/`,
    )
    return rows.map((row) => ({ view: this.remoteView(this.byId(row.id)!), added: false, presence: true, status: false }))
  }

  /**
   * a released machine: its rows are retired like a gone handle and can't be resolved or resumed again; with `queue`,
   * their unread deliveries go too, and each message they leave delivered to no one, unless it is a request or has
   * replies, which askers still look up
   */
  dropMachine(machine: string, options: { queue?: boolean } = {}): number {
    const rows = this.sql.all<{ id: string }>(
      `UPDATE endpoints SET handle = ? || id, remote = NULL, token_hash = NULL, connections = 0 WHERE substr(remote, 1, ?) = ? RETURNING id`,
      GONE_PREFIX,
      machine.length + 1,
      `${machine}/`,
    )
    if (options.queue && this.xinbox) {
      this.xfloor()
      this.sql.all(`DELETE FROM xinbox WHERE substr(endpoint, 1, ?) = ?`, machine.length + 1, `${machine}/`)
    }
    if (options.queue) {
      for (const { id } of rows) {
        for (const { message_id } of this.sql.all<{ message_id: string }>(
          `DELETE FROM deliveries WHERE endpoint = ? AND acked_at IS NULL RETURNING message_id`,
          id,
        )) {
          this.sql.all(
            `DELETE FROM messages WHERE id = ? AND kind != 'request' AND NOT EXISTS (SELECT 1 FROM deliveries WHERE message_id = ?) AND NOT EXISTS (SELECT 1 FROM messages WHERE reply_to = ?)`,
            message_id,
            message_id,
            message_id,
          )
        }
      }
    }
    return rows.length
  }

  /**
   * hands a machine's direct-client rows with no connection (or only `endpoint`) to its bridge: their resume tokens are
   * dropped, so the bridge mirrors them, and their unread deliveries get fresh seqs past any bridge's replay cursor;
   * returns those deliveries
   */
  adoptClaimed(machine: string, endpoint?: string): { seq: number; endpoint: string }[] {
    return this.tx(() => {
      const now = this.now()
      const rows = this.sql.all<{ id: string }>(
        `UPDATE endpoints SET token_hash = NULL WHERE substr(remote, 1, ?) = ? AND token_hash IS NOT NULL AND connections = 0 ${endpoint ? "AND id = ?" : ""} RETURNING id`,
        ...[machine.length + 1, `${machine}/`, ...(endpoint ? [endpoint] : [])],
      )
      const adopted: { seq: number; endpoint: string }[] = []
      for (const { id } of rows) {
        const unread = this.sql.all<{ seq: number; message_id: string; expires_at: number }>(
          `DELETE FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ? RETURNING seq, message_id, expires_at`,
          id,
          now,
        )
        for (const row of unread.sort((a, b) => a.seq - b.seq)) {
          const seq = this.insertDelivery(row.message_id, id, row.expires_at)
          adopted.push({ seq, endpoint: id })
        }
      }
      return adopted
    })
  }

  // hops

  /** the hop a message from this endpoint would get from what it received lately */
  causalHop(endpoint: string): number {
    const row = this.mustEndpoint(endpoint)
    return row.last_received_at !== null && row.last_received_at >= this.now() - LIMITS.causalWindowS * 1000 ? (row.last_received_hop ?? 0) + 1 : 0
  }

  /** records that an endpoint received a message of `hop`, as reading its inbox does */
  markReceived(endpoint: string, hop: number): void {
    const now = this.now()
    this.sql.all(
      `UPDATE endpoints SET last_received_at = ?, last_received_hop = MAX(?, CASE WHEN last_received_at >= ? THEN COALESCE(last_received_hop, 0) ELSE 0 END) WHERE id = ?`,
      now,
      hop,
      now - LIMITS.causalWindowS * 1000,
      endpoint,
    )
  }

  // messages across machines

  /**
   * why the local policy refuses a hub delivery to the local `endpoint`, or null; checks the message as admit() does and creates its sender's
   * proxy row; relay notices always pass. A scope refusal throws not_found, as send() does; a redelivery of an admitted message skips it.
   */
  inboundRefusal(endpoint: string, message: Envelope): string | null {
    const recipient = this.mustEndpoint(endpoint)
    this.checkEnvelope(message)
    const sender = this.byId(this.tx(() => this.proxyFor(message.from)))!
    if (sender.kind === "system") return null
    if (!one(this.sql, `SELECT 1 FROM deliveries WHERE message_id = ? AND endpoint = ?`, message.id, endpoint)) {
      const parent =
        message.kind === "reply" && message.reply_to ? one<MessageRow>(this.sql, `SELECT * FROM messages WHERE id = ?`, message.reply_to) : undefined
      const remote = (sender as FederatedRow).remote
      if (remote && isForeign(remote)) this.checkForeignIn(sender, recipient, parent)
      else this.checkScope(sender, recipient, this.address(recipient), parent)
    }
    return this.checkPolicy(this.addressOf(sender.id), this.addressOf(endpoint))
  }

  /**
   * a message the hub delivered to a local endpoint, stored under the hub's id from a proxy of its sender; idempotent.
   * Throws inbox_full past the inbox cap, which a redelivery, the first reply to the endpoint's own message (as in
   * send()) and relay notices skip.
   */
  admit(endpoint: string, message: Envelope): { seq: number; duplicate: boolean } {
    this.mustEndpoint(endpoint)
    const checked = this.checkEnvelope(message)
    const stored = this.tx((): { seq: number; duplicate: boolean } | { sender: string; unacked: number } => {
      const sender = this.proxyFor(message.from)
      const had = one<{ seq: number }>(this.sql, `SELECT seq FROM deliveries WHERE message_id = ? AND endpoint = ?`, message.id, endpoint)
      if (had) return { seq: had.seq, duplicate: true }
      const unacked = this.inboxFull(endpoint, sender, message)
      if (unacked !== null) return { sender, unacked }
      this.sql.all(
        `INSERT OR IGNORE INTO messages (id, thread, reply_to, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at, sender_tty, require_reply)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        message.id,
        message.thread,
        message.reply_to,
        message.kind,
        sender,
        message.to,
        message.body.text,
        message.body.mime,
        message.data_class,
        JSON.stringify(message.attachments.map((a) => ({ kind: "path", path: a.path }))),
        message.hop,
        checked.createdAt,
        checked.expiresAt,
        message.from.claims.tty === undefined ? null : message.from.claims.tty ? 1 : 0,
        message.require_reply === true && message.kind === "request" ? 1 : null,
      )
      const seq = this.insertDelivery(message.id, endpoint, checked.expiresAt)
      this.audit("inject", endpoint, message.id, { from: message.from.address, hop: message.hop })
      return { seq, duplicate: false }
    })
    if ("unacked" in stored) throw this.refuse(stored.sender, "inbox_full", `${this.addressOf(endpoint)} has ${stored.unacked} unread messages`)
    return stored
  }

  /** inject() for the hooks of a local endpoint; another machine's row (mirrored, claimed on the hub, or a sender's proxy) has none and gets nothing */
  override inject(endpoint: string, options: Parameters<RelayCore["inject"]>[1] = {}): ReturnType<RelayCore["inject"]> {
    if (this.machineOf(endpoint) !== null) return { messages: [], offered: [], hold: null, more: 0, unread: 0, block: false }
    return super.inject(endpoint, options)
  }

  /** offer() for a local endpoint's channel; another machine's row is offered nothing */
  override offer(endpoint: string, options: Parameters<RelayCore["offer"]>[1] = {}): ReturnType<RelayCore["offer"]> {
    if (this.machineOf(endpoint) !== null) return { messages: [], hold: null }
    return super.offer(endpoint, options)
  }

  /** stopHeld() for a local endpoint; another machine's row has no hooks */
  override stopHeld(endpoint: string, options: Parameters<RelayCore["stopHeld"]>[1] = {}): boolean {
    return this.machineOf(endpoint) === null && super.stopHeld(endpoint, options)
  }

  /** the endpoint's unacked count when a new delivery from `sender` would pass the inbox cap, else null */
  private inboxFull(endpoint: string, sender: string, message: Envelope): number | null {
    if (this.byId(sender)!.kind === "system") return null
    const parent =
      message.kind === "reply" && message.reply_to
        ? one<{ id: string; from_ep: string }>(this.sql, `SELECT id, from_ep FROM messages WHERE id = ?`, message.reply_to)
        : undefined
    const firstReply =
      parent?.from_ep === endpoint &&
      one(this.sql, `SELECT 1 FROM messages WHERE reply_to = ? AND from_ep = ? AND kind = 'reply' AND id != ?`, parent.id, sender, message.id) === undefined
    if (firstReply) return null
    const unacked = one<{ n: number }>(
      this.sql,
      `SELECT COUNT(*) AS n FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ?`,
      endpoint,
      this.now(),
    )!.n
    return unacked >= LIMITS.inboxMax ? unacked : null
  }

  /** a send the hub accepted for a local endpoint, stored under the hub's id with no deliveries, so replyTo() and a retried client_id work */
  recordForward(from: string, params: SendParams, result: SendResult, origin: { tty?: boolean } = {}): void {
    const sender = this.mustEndpoint(from)
    const now = this.now()
    const ttl = Number.isInteger(params.ttl_s) ? params.ttl_s! : LIMITS.ttlDefaultS
    const targets = Array.isArray(params.to) ? params.to : [params.to]
    const clientId = cleanText(params.client_id, "client_id", 128)
    const kind = params.kind ?? "message"
    this.tx(() => {
      this.sql.all(
        `INSERT OR IGNORE INTO messages (id, thread, reply_to, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at, sender_tty, require_reply)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        result.id,
        result.thread,
        params.reply_to ?? null,
        kind,
        from,
        targets.map(String).join(","),
        params.body,
        params.mime ?? "text/markdown",
        params.data_class ?? "public",
        JSON.stringify((params.attachments ?? []).map((a) => ({ kind: "path", path: a.path }))),
        result.hop,
        now,
        now + ttl * 1000,
        sender.kind === "human" ? (origin.tty === true ? 1 : 0) : null,
        params.require_reply === true && kind === "request" ? 1 : null,
      )
      if (clientId) {
        const { duplicate: _, ...stored } = result
        this.sql.all(
          `INSERT OR REPLACE INTO idempotency (from_ep, client_id, payload_hash, result, created_at) VALUES (?, ?, ?, ?, ?)`,
          from,
          clientId,
          this.forwardHash(params),
          JSON.stringify(stored),
          now,
        )
      }
      if (params.reply_to)
        this.sql.all(`UPDATE deliveries SET acked_at = ? WHERE message_id = ? AND endpoint = ? AND acked_at IS NULL`, now, params.reply_to, from)
      this.audit("forward", from, result.id, { to: result.deliveries.map((d) => d.address), kind, hop: result.hop, thread: result.thread })
    })
  }

  /**
   * records that a forwarded message reached mirrored endpoints of other machines, unacknowledged, as a hub's delivery rows would: their
   * replies then join its thread here. For links that deliver machine to machine; a hub bridge never needs it
   */
  recordRemoteDelivery(messageId: string, endpoints: string[]): void {
    this.tx(() => {
      const message = one<{ expires_at: number }>(this.sql, `SELECT expires_at FROM messages WHERE id = ?`, messageId)
      if (!message) return
      for (const endpoint of endpoints) {
        if (this.machineOf(endpoint) === null) continue
        if (one(this.sql, `SELECT 1 FROM deliveries WHERE message_id = ? AND endpoint = ?`, messageId, endpoint)) continue
        this.insertDelivery(messageId, endpoint, message.expires_at)
      }
    })
  }

  /** the earlier result of a forwarded send with this client_id, or null; a different message under the same client_id is refused */
  forwarded(from: string, params: SendParams): SendResult | null {
    const clientId = cleanText(params.client_id, "client_id", 128)
    if (!clientId) return null
    const seen = one<{ result: string; payload_hash: string; created_at: number }>(
      this.sql,
      `SELECT result, payload_hash, created_at FROM idempotency WHERE from_ep = ? AND client_id = ?`,
      from,
      clientId,
    )
    if (!seen || seen.created_at < this.now() - LIMITS.idempotencyS * 1000) return null
    if (seen.payload_hash !== this.forwardHash(params)) throw new RelayError("invalid_params", `client_id ${clientId} was already used for a different message`)
    return { ...(JSON.parse(seen.result) as SendResult), duplicate: true }
  }

  /** one delivery as the hub pushes it, or null when it is gone, acked or expired */
  delivery(seq: number): Delivery | null {
    const row = one<MessageRow & { seq: number; recipient: string; remote: string | null; claimed: number }>(
      this.sql,
      `SELECT m.*, d.seq AS seq, d.endpoint AS recipient, e.remote AS remote, e.token_hash IS NOT NULL AS claimed FROM deliveries d JOIN messages m ON m.id = d.message_id JOIN endpoints e ON e.id = d.endpoint
       WHERE d.seq = ? AND d.acked_at IS NULL AND d.expires_at > ?`,
      seq,
      this.now(),
    )
    if (row)
      return {
        seq: row.seq,
        endpoint: row.remote,
        recipient: row.recipient,
        mirrored: row.claimed === 0,
        message: this.envelope(row, undefined, row.recipient),
      }
    return this.xinbox ? (this.xinboxPage(`x.seq = ?`, [seq], 1)[0] ?? null) : null
  }

  /** the unacked deliveries to `machine`'s mirrored rows after `after` (xinbox rows after `xafter`), oldest first */
  pending(machine: string, after: number, limit = 200, xafter = after): Delivery[] {
    const deliveries = this.sql
      .all<MessageRow & { seq: number; recipient: string; remote: string }>(
        `SELECT m.*, d.seq AS seq, d.endpoint AS recipient, e.remote AS remote FROM deliveries d JOIN messages m ON m.id = d.message_id JOIN endpoints e ON e.id = d.endpoint
         WHERE substr(e.remote, 1, ?) = ? AND e.token_hash IS NULL AND d.acked_at IS NULL AND d.expires_at > ? AND d.seq > ? ORDER BY d.seq LIMIT ?`,
        machine.length + 1,
        `${machine}/`,
        this.now(),
        after,
        limit,
      )
      .map(
        (row): Delivery => ({
          seq: row.seq,
          endpoint: row.remote,
          recipient: row.recipient,
          mirrored: true,
          message: this.envelope(row, undefined, row.recipient),
        }),
      )
    if (!this.xinbox) return deliveries
    const others = this.xinboxPage(`substr(x.endpoint, 1, ?) = ? AND x.seq > ?`, [machine.length + 1, `${machine}/`, xafter], limit)
    return others.length ? [...deliveries, ...others].sort((a, b) => a.seq - b.seq).slice(0, limit) : deliveries
  }

  /**
   * acks deliveries of `machine`'s mirrored rows only; each counts as received for the causal hop. A seq of xinbox moves its endpoint's
   * cursor instead: one row per endpoint for the whole batch, no audit
   */
  ackOn(machine: string, seqs: unknown): number {
    let acked = 0
    const batches = new Map<string, Set<number>>()
    for (const seq of seqList(seqs)) {
      const row = this.ownDelivery(machine, seq)
      if (!row) {
        const endpoint = this.ownXinbox(machine, seq)
        if (endpoint !== null) batches.set(endpoint, (batches.get(endpoint) ?? new Set()).add(seq))
        continue
      }
      this.sql.all(`UPDATE deliveries SET acked_at = ? WHERE seq = ?`, this.now(), seq)
      this.markReceived(row.endpoint, row.hop)
      acked++
    }
    if (acked) this.audit("ack", null, null, { machine, count: acked })
    for (const [endpoint, batch] of batches) acked += this.advanceCursor(endpoint, batch)
    return acked
  }

  /** a delivery `machine`'s local policy refused: acked, and a status notice from the relay to the sender */
  rejectOn(machine: string, seq: unknown, code: unknown): { notice: { seq: number; endpoint: string } | null } {
    if (!Number.isInteger(seq)) throw new RelayError("invalid_params", "seq must be an integer")
    if (typeof code !== "string" || !/^[a-z_]{1,32}$/.test(code)) throw new RelayError("invalid_params", "code is an error code")
    const row = this.ownDelivery(machine, seq as number)
    if (!row) {
      const endpoint = this.ownXinbox(machine, seq as number)
      if (endpoint === null) throw new RelayError("not_found", `no unacked delivery ${String(seq)} for ${machine}`)
      this.advanceCursor(endpoint, new Set([seq as number]))
      return { notice: null }
    }
    return this.tx(() => {
      this.sql.all(`UPDATE deliveries SET acked_at = ? WHERE seq = ?`, this.now(), seq as number)
      this.audit("reject", row.endpoint, row.message_id, { code, machine })
      const sender = this.byId(row.from_ep)
      if (!sender || sender.kind === "system") return { notice: null }
      const recipient = this.byId(row.endpoint)!
      const noticeSeq = this.noticeTo(sender.id, `${this.address(recipient)} refused message ${row.message_id} (${code}).`)
      return { notice: { seq: noticeSeq, endpoint: sender.id } }
    })
  }

  protected override audit(event: string, endpoint: string | null, ref: string | null, detail: Record<string, unknown>): void {
    if (event === "refuse" && this.refusalsPerMinute !== null) {
      const minute = Math.floor(this.now() / 60_000)
      const code = String(detail.code)
      let budget = this.refusals.get(code)
      if (!budget) {
        budget = { minute, written: 0, suppressed: 0 }
        this.refusals.set(code, budget)
      }
      if (budget.minute !== minute) Object.assign(budget, { minute, written: 0 })
      if (budget.written >= this.refusalsPerMinute) {
        budget.suppressed++
        return
      }
      budget.written++
      if (budget.suppressed) {
        detail = { ...detail, suppressed: budget.suppressed }
        budget.suppressed = 0
      }
    }
    super.audit(event, endpoint, ref, detail)
  }

  /** an audit row from outside the core (hub events: machine binds, releases, revocations) */
  record(event: string, endpoint: string | null, ref: string | null, detail: Record<string, unknown>): void {
    this.audit(event, endpoint, ref, detail)
  }

  /**
   * drops what expired, and with xinbox the rows received over XINBOX_KEEP_MS ago that expired or were acked that long ago, keeping
   * the highest seq they held as the floor of the next one
   */
  override sweep(): void {
    super.sweep()
    if (!this.xinbox) return
    this.xfloor()
    const now = this.now()
    const settled = now - XINBOX_KEEP_MS
    this.sql.all(
      `DELETE FROM xinbox WHERE at <= ? AND (expires_at <= ? OR EXISTS (SELECT 1 FROM xcursor c WHERE c.endpoint = xinbox.endpoint
         AND ((xinbox.seq <= c.acked_seq AND c.at <= ?) OR (xinbox.seq <= c.old_seq AND c.old_at <= ?))))`,
      settled,
      now,
      settled,
      settled,
    )
    this.sql.all(`DELETE FROM xcursor WHERE endpoint NOT IN (SELECT endpoint FROM xinbox)`)
  }

  // other accounts (the hosted relay)

  /** the mirrored row of `<machine>/<handle>` (a bridge's, never a direct client's), or null */
  xendpoint(remote: string): XEndpoint | null {
    const row = this.byRemote(remote)
    return row && row.token_hash === null && row.kind !== "system" && !isForeign(remote) ? this.xview(row) : null
  }

  /** the mirrored row an endpoint id is, or null for anything else */
  xsender(endpoint: string): XEndpoint | null {
    const row = this.byId(endpoint) as FederatedRow | undefined
    return row?.remote && row.token_hash === null && row.kind !== "system" && !isForeign(row.remote) ? this.xview(row) : null
  }

  /** every mirrored row, for discovery */
  xendpoints(): XEndpoint[] {
    return this.sql
      .all<FederatedRow>(`SELECT * FROM endpoints WHERE remote IS NOT NULL AND token_hash IS NULL AND kind != 'system' ORDER BY remote`)
      .filter((row) => !isForeign(row.remote!))
      .map((row) => this.xview(row))
  }

  /** the xinbox row `id` delivered to `<machine>/<handle>`, or null */
  xreceived(endpoint: string, id: string): XInboxRow | null {
    return this.xinbox ? (one<XInboxRow>(this.sql, `SELECT * FROM xinbox WHERE endpoint = ? AND id = ?`, endpoint, id) ?? null) : null
  }

  /** the earlier row of a message from `fromAccount` under `clientId`, or null */
  xduplicate(fromAccount: string, clientId: string): { id: string; acked: boolean } | null {
    const row = one<{ id: string; seq: number; endpoint: string }>(
      this.sql,
      `SELECT id, seq, endpoint FROM xinbox WHERE from_account = ? AND client_id = ?`,
      fromAccount,
      clientId,
    )
    if (!row) return null
    const cursor = one<{ acked_seq: number }>(this.sql, `SELECT acked_seq FROM xcursor WHERE endpoint = ?`, row.endpoint)?.acked_seq ?? 0
    return { id: row.id, acked: row.seq <= cursor }
  }

  /** what `fromAccount` sent here: from `sender` to `endpoint` in the last minute and hour (each with its oldest), and since `since` */
  xcounts(
    fromAccount: string,
    sender: string,
    endpoint: string,
    since: number,
  ): { minute: number; minuteAt: number | null; hour: number; hourAt: number | null; day: number } {
    const now = this.now()
    const pair = one<{ minute: number; minute_at: number | null; hour: number; hour_at: number | null }>(
      this.sql,
      `SELECT COALESCE(SUM(at > ?), 0) AS minute, MIN(CASE WHEN at > ? THEN at END) AS minute_at, COUNT(*) AS hour, MIN(at) AS hour_at FROM xinbox
       WHERE from_account = ? AND sender = ? AND endpoint = ? AND at > ?`,
      now - 60_000,
      now - 60_000,
      fromAccount,
      sender,
      endpoint,
      now - 3_600_000,
    )!
    const day = one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM xinbox WHERE from_account = ? AND at >= ?`, fromAccount, since)!.n
    return { minute: pair.minute, minuteAt: pair.minute_at, hour: pair.hour, hourAt: pair.hour_at, day }
  }

  /** an endpoint's unread messages: its unacked, unexpired xinbox rows and deliveries */
  xunread(endpoint: XEndpoint): number {
    const now = this.now()
    return one<{ n: number }>(
      this.sql,
      `SELECT (SELECT COUNT(*) FROM xinbox x WHERE x.endpoint = ? AND x.expires_at > ? AND x.seq > COALESCE((SELECT acked_seq FROM xcursor WHERE endpoint = x.endpoint), 0))
         + (SELECT COUNT(*) FROM deliveries WHERE endpoint = ? AND acked_at IS NULL AND expires_at > ?) AS n`,
      endpoint.remote,
      now,
      endpoint.id,
      now,
    )!.n
  }

  /** the accounts whose xinbox rows may be read out now; null (unknown) reads none */
  xsenders(accounts: Set<string> | null): void {
    this.xfrom = accounts
  }

  /** deletes the xinbox rows of every account but `keep`; how many it deleted */
  xprune(keep: Set<string>): number {
    if (!this.xinbox) return 0
    const json = JSON.stringify([...keep])
    if (!one(this.sql, `SELECT 1 FROM xinbox WHERE from_account NOT IN (SELECT value FROM json_each(?)) LIMIT 1`, json)) return 0
    this.xfloor()
    return this.sql.all(`DELETE FROM xinbox WHERE from_account NOT IN (SELECT value FROM json_each(?)) RETURNING seq`, json).length
  }

  xthreadCount(endpoint: string, thread: string): number {
    return one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM xinbox WHERE endpoint = ? AND thread = ?`, endpoint, thread)!.n
  }

  /** one xinbox row under the next seq; null when a row of the same sender and client_id is there already */
  xinsert(row: Omit<XInboxRow, "seq">): number | null {
    return (
      one<{ seq: number }>(
        this.sql,
        `INSERT INTO xinbox (seq, id, from_account, client_id, endpoint, sender, message, thread, grant, expires_at, at) SELECT 1 + ${SEQ_TOP}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE true
         ON CONFLICT (from_account, client_id) DO NOTHING RETURNING seq`,
        row.id,
        row.from_account,
        row.client_id,
        row.endpoint,
        row.sender,
        row.message,
        row.thread,
        row.grant,
        row.expires_at,
        row.at,
      )?.seq ?? null
    )
  }

  /** a value of the cross-account state, written once */
  xstate(key: string, init: () => string): string {
    const found = one<{ value: string }>(this.sql, `SELECT value FROM xstate WHERE key = ?`, key)
    if (found) return found.value
    const value = init()
    this.sql.all(`INSERT INTO xstate (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`, key, value)
    return one<{ value: string }>(this.sql, `SELECT value FROM xstate WHERE key = ?`, key)!.value
  }

  private xview(row: EndpointRow): XEndpoint {
    const remote = (row as FederatedRow).remote!
    return {
      id: row.id,
      remote,
      machine: machinePart(remote),
      handle: handlePart(remote),
      kind: row.kind,
      depth: row.kind === "agent" ? row.depth : null,
      harness: row.harness,
      presence: this.view(row).presence,
    }
  }

  /** unacked, unexpired xinbox rows of mirrored endpoints from the accounts xsenders() named, as deliveries, by `where` over `x` */
  private xinboxPage(where: string, params: SqlValue[], limit: number): Delivery[] {
    if (!this.xfrom?.size) return []
    return this.sql
      .all<{ seq: number; endpoint: string; message: string; recipient: string }>(
        `SELECT x.seq AS seq, x.endpoint AS endpoint, x.message AS message, e.id AS recipient FROM xinbox x JOIN endpoints e ON e.remote = x.endpoint AND e.token_hash IS NULL
         WHERE ${where} AND x.expires_at > ? AND x.from_account IN (SELECT value FROM json_each(?))
         AND x.seq > COALESCE((SELECT acked_seq FROM xcursor WHERE endpoint = x.endpoint), 0) ORDER BY x.seq LIMIT ?`,
        ...params,
        this.now(),
        JSON.stringify([...this.xfrom]),
        limit,
      )
      .map((row) => ({ seq: row.seq, endpoint: row.endpoint, recipient: row.recipient, mirrored: true, message: JSON.parse(row.message) as Envelope }))
  }

  /** the endpoint of an unacked xinbox seq of `machine`, or null */
  private ownXinbox(machine: string, seq: number): string | null {
    if (!this.xinbox) return null
    return (
      one<{ endpoint: string }>(
        this.sql,
        `SELECT x.endpoint AS endpoint FROM xinbox x WHERE x.seq = ? AND substr(x.endpoint, 1, ?) = ? AND x.seq > COALESCE((SELECT acked_seq FROM xcursor WHERE endpoint = x.endpoint), 0)`,
        seq,
        machine.length + 1,
        `${machine}/`,
      )?.endpoint ?? null
    )
  }

  /**
   * moves an endpoint's cursor over the leading run of its unacked, unexpired rows that `batch` names, in one write or none; a seq past
   * a row it does not name stays unacked and replays. How many rows it moved over
   */
  private advanceCursor(endpoint: string, batch: Set<number>): number {
    const now = this.now()
    const cursor = one<{ acked_seq: number }>(this.sql, `SELECT acked_seq FROM xcursor WHERE endpoint = ?`, endpoint)?.acked_seq ?? 0
    let to = cursor
    let moved = 0
    for (const { seq } of this.sql.all<{ seq: number }>(
      `SELECT seq FROM xinbox WHERE endpoint = ? AND seq > ? AND seq <= ? AND expires_at > ? ORDER BY seq`,
      endpoint,
      cursor,
      Math.max(...batch),
      now,
    )) {
      if (!batch.has(seq)) break
      to = seq
      moved++
    }
    if (to === cursor) return 0
    // the checkpoint (old_seq, old_at) rolls to the previous position at most once a day, so the sweep can tell rows acked a day ago
    this.sql.all(
      `INSERT INTO xcursor (endpoint, acked_seq, at) VALUES (?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET
         old_seq = CASE WHEN old_at IS NULL OR excluded.at - old_at >= ? THEN acked_seq ELSE old_seq END,
         old_at = CASE WHEN old_at IS NULL OR excluded.at - old_at >= ? THEN at ELSE old_at END,
         acked_seq = excluded.acked_seq, at = excluded.at`,
      endpoint,
      to,
      now,
      XINBOX_KEEP_MS,
      XINBOX_KEEP_MS,
    )
    return moved
  }

  /** when the holder part of a mirrored agent's incarnation moved, drops its xinbox rows and deliveries: they were the earlier holder's */
  private dropEarlierHolder(row: FederatedRow, incarnation: string | null | undefined): void {
    const holder = (value: string | null | undefined) => (value?.includes(".") ? value.slice(0, value.indexOf(".")) : null)
    const was = holder(row.incarnation)
    const next = holder(incarnation)
    if (was === null || next === null || was === next) return
    let xinbox = 0
    if (this.xinbox) {
      this.xfloor()
      xinbox = this.sql.all(`DELETE FROM xinbox WHERE endpoint = ? RETURNING seq`, row.remote).length
    }
    const deliveries = this.sql.all(`DELETE FROM deliveries WHERE endpoint = ? RETURNING seq`, row.id).length
    this.audit("mirror_reset", row.id, null, { target: row.remote, xinbox, deliveries })
  }

  /** keeps the highest xinbox seq as the floor of the next one, before rows are deleted */
  private xfloor(): void {
    const top = one<{ n: number | null }>(this.sql, `SELECT MAX(seq) AS n FROM xinbox`)!.n
    const floor = Number(one<{ value: string }>(this.sql, `SELECT value FROM xstate WHERE key = 'seq_floor'`)?.value ?? 0)
    if (top !== null && top > floor)
      this.sql.all(`INSERT INTO xstate (key, value) VALUES ('seq_floor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, String(top))
  }

  // internals

  private ownDelivery(machine: string, seq: number): { endpoint: string; message_id: string; from_ep: string; hop: number } | undefined {
    return one(
      this.sql,
      `SELECT d.endpoint AS endpoint, d.message_id AS message_id, m.from_ep AS from_ep, m.hop AS hop FROM deliveries d JOIN messages m ON m.id = d.message_id JOIN endpoints e ON e.id = d.endpoint
       WHERE d.seq = ? AND d.acked_at IS NULL AND substr(e.remote, 1, ?) = ? AND e.token_hash IS NULL`,
      seq,
      machine.length + 1,
      `${machine}/`,
    )
  }

  private noticeTo(endpoint: string, text: string): number {
    const system = this.byHandle(SYSTEM_HANDLE)!
    const now = this.now()
    const id = newId("msg", now)
    const expires = now + LIMITS.ttlDefaultS * 1000
    this.sql.all(
      `INSERT INTO messages (id, thread, reply_to, kind, from_ep, to_addr, body, mime, data_class, attachments, hop, created_at, expires_at)
       VALUES (?, ?, NULL, 'status', ?, ?, ?, 'text/plain', 'public', '[]', 0, ?, ?)`,
      id,
      newId("thr", now),
      system.id,
      this.addressOf(endpoint),
      text,
      now,
      expires,
    )
    return this.insertDelivery(id, endpoint, expires)
  }

  private forwardHash(params: SendParams): string {
    const targets = (Array.isArray(params.to) ? params.to : [params.to]).map(String).sort()
    return this.hash(
      JSON.stringify([
        "forward",
        targets,
        params.body,
        params.kind ?? "message",
        params.thread ?? null,
        params.reply_to ?? null,
        params.data_class ?? "public",
        (params.attachments ?? []).map((a) => a.path).sort(),
        params.mime ?? null,
        params.ttl_s ?? null,
      ]),
    )
  }

  /** a message from another account passes the recipient's in lists by `acct:`, or as a reply to the recipient's own message to that sender */
  private checkForeignIn(sender: EndpointRow, recipient: EndpointRow, parent: MessageRow | undefined): void {
    if (parent && parent.from_ep === recipient.id && parent.to_addr.split(",").some((to) => to.trim() === this.address(sender))) return
    const admission = this.crossAdmission(recipient.id, "in", this.scopeNode(sender))
    if (admission.ok) return
    this.audit("scope_refused", sender.id, null, { from: this.address(sender), to: this.address(recipient), dir: "in", reason: admission.why })
    throw new RelayError("not_found", `no endpoint ${this.address(recipient)}`)
  }

  /** the stand-in row of another account's sender: `@<account>/<machine>/<handle>`, or `@<account>/me` for its human at a terminal */
  private foreignProxy(from: Envelope["from"]): string {
    const bad = () => new RelayError("invalid_params", `the sender ${String(from.address)} is not an endpoint of a contact`)
    const account = from.account
    if (typeof account !== "string" || !ACCOUNT_HANDLE.test(account) || this.isLocalUser(account) || from.user !== account) throw bad()
    let remote: string
    if (from.human === true) {
      if (from.address !== `${account}/me`) throw bad()
      remote = `@${account}/me`
    } else {
      const parsed = this.foreignAccount(from.address)
      if (!parsed || parsed.account !== account) throw bad()
      remote = `@${account}/${parsed.machine}/${parsed.handle}`
    }
    const harness = from.claims.harness && validHarness(from.claims.harness) ? from.claims.harness : null
    const existing = this.byRemote(remote)
    const id = existing?.id ?? this.insertProxy(remote, from.human === true ? "human" : "agent", harness, from.auth)
    if (existing && existing.harness !== harness) this.sql.all(`UPDATE endpoints SET harness = ? WHERE id = ?`, harness, id)
    return id
  }

  private proxyFor(from: Envelope["from"]): string {
    if (from.auth === "contact") return this.foreignProxy(from)
    const prefix = `${from.user}/`
    if (!from.address.startsWith(prefix)) throw new RelayError("invalid_params", "the sender's address is not of its user")
    const rest = from.address.slice(prefix.length)
    const remote = rest.includes("/") ? rest : `${from.user}/${rest}`
    if (!REMOTE.test(remote)) throw new RelayError("invalid_params", `the sender's address ${from.address} is not valid`)
    const handle = handlePart(remote)
    const kind: EndpointKind = handle === "" ? "human" : rest.includes("/") ? "agent" : "system"
    const harness = from.claims.harness && validHarness(from.claims.harness) ? from.claims.harness : null
    const model = cleanText(from.claims.model, "model", 128)
    const existing = this.byRemote(remote)
    const id = existing?.id ?? this.insertProxy(remote, kind, harness, from.auth)
    if (!existing || existing.harness !== harness || existing.model !== model || existing.auth !== from.auth) {
      this.sql.all(`UPDATE endpoints SET harness = ?, model = ?, auth = ? WHERE id = ?`, harness, model, from.auth, id)
    }
    return id
  }

  private checkEnvelope(message: Envelope): { createdAt: number; expiresAt: number } {
    const bad = (what: string) => new RelayError("invalid_params", `the message's ${what} is not valid`)
    if (!message || typeof message !== "object") throw bad("shape")
    if (typeof message.id !== "string" || !MESSAGE_ID.test(message.id)) throw bad("id")
    if (typeof message.thread !== "string" || !message.thread || message.thread.length > 128) throw bad("thread")
    if (message.reply_to !== null && (typeof message.reply_to !== "string" || message.reply_to.length > 128)) throw bad("reply_to")
    if (!MESSAGE_KINDS.includes(message.kind)) throw bad("kind")
    if (typeof message.to !== "string" || message.to.length > 4096) throw bad("to")
    if (!message.body || typeof message.body.text !== "string" || typeof message.body.mime !== "string" || message.body.mime.length > 64) throw bad("body")
    if (new TextEncoder().encode(message.body.text).length > LIMITS.bodyBytes)
      throw new RelayError("too_large", `the body is more than ${LIMITS.bodyBytes} bytes`)
    if (message.data_class !== "public" && message.data_class !== "private") throw bad("data_class")
    if (
      !Array.isArray(message.attachments) ||
      message.attachments.length > LIMITS.attachments ||
      message.attachments.some((a) => a?.kind !== "path" || typeof a.path !== "string" || !a.path.startsWith("/"))
    )
      throw bad("attachments")
    if (!Number.isInteger(message.hop) || message.hop < 0 || message.hop > LIMITS.hopMax) throw bad("hop")
    const from = message.from
    if (!from || typeof from.address !== "string" || typeof from.user !== "string" || !from.claims || !AUTHS.includes(from.auth)) throw bad("sender")
    if (from.claims.tty !== undefined && typeof from.claims.tty !== "boolean") throw bad("sender")
    const createdAt = Date.parse(message.created_at)
    const expiresAt = Date.parse(message.expires_at)
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) throw bad("timestamps")
    const secret = findSecret(message.body.text)
    if (secret) throw new RelayError("secret_refused", `the message looks like it carries a credential (${secret})`)
    return { createdAt, expiresAt }
  }

  private parseView(value: unknown): ParsedView {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("invalid_params", "an endpoint is an object")
    const view = value as Partial<MirrorView>
    if (typeof view.address !== "string") throw new RelayError("invalid_params", "an endpoint needs an address")
    const handle = view.address.slice(view.address.lastIndexOf("/") + 1)
    const kind = view.kind
    if (kind !== "agent" && kind !== "human") throw new RelayError("invalid_params", "an endpoint's kind is agent or human")
    if (kind === "human" ? handle !== "" : !validHandle(handle))
      throw new RelayError("invalid_params", `${JSON.stringify(view.address)} is not a valid endpoint address`)
    const harness = cleanText(view.harness, "harness", 32)
    if (harness !== null && !validHarness(harness)) throw new RelayError("invalid_params", `harness ${JSON.stringify(harness)} is not a valid name`)
    let status: { state: StatusState; note: string } | null = null
    if (view.status) {
      if (!STATUS_STATES.includes(view.status.state)) throw new RelayError("invalid_params", `state must be one of ${STATUS_STATES.join(", ")}`)
      status = { state: view.status.state, note: cleanText(view.status.note, "note", LIMITS.noteChars) ?? "" }
    }
    const presence = view.presence ?? "offline"
    if (!PRESENCES.includes(presence)) throw new RelayError("invalid_params", "presence is online, idle or offline")
    const parsedSeen = typeof view.last_seen === "string" ? Date.parse(view.last_seen) : Number.NaN
    const out = {
      handle,
      kind,
      harness,
      model: cleanText(view.model, "model", 128),
      cwd: cleanText(view.cwd, "cwd", 1024),
      labels: JSON.stringify(cleanLabels(view.labels)),
      status,
      presence,
      lastSeen: Number.isFinite(parsedSeen) ? parsedSeen : null,
      scope: kind === "agent" ? parseScope(view) : {},
      was: kind === "agent" && typeof view.was === "string" && validHandle(view.was) && view.was !== handle ? view.was : null,
    }
    const leaked = [handle, out.model, out.cwd, out.labels, status?.note, out.scope.title].map((v) => (v ? findSecret(v) : null)).find(Boolean)
    if (leaked) throw new RelayError("secret_refused", `an endpoint looks like it carries a credential (${leaked})`)
    return out
  }

  private diff(before: FederatedRow | undefined, after: EndpointRow): MirrorChange | null {
    const view = this.remoteView(after)
    if (!before) return { view, added: true, presence: true, status: true }
    const was = this.view(before)
    const presence = was.presence !== view.presence
    const status = before.status_state !== after.status_state || before.status_note !== after.status_note
    const other = (["kind", "harness", "model", "cwd", "labels", "title", "wake", "tree", "parent_ep", "depth", "rules", "caps", "incarnation"] as const).some(
      (field) => before[field] !== (after as FederatedRow)[field],
    )
    return presence || status || other ? { view, added: false, presence, status } : null
  }

  private remoteView(row: EndpointRow): RemoteView {
    const remote = (row as FederatedRow).remote
    const view: RemoteView = { ...this.view(row), machine: remote ? machinePart(remote) : (this.machine ?? "") }
    if (row.kind !== "agent") return view
    const handle = (id: string | null) => {
      const other = id ? (this.byId(id) as FederatedRow | undefined) : undefined
      return other?.remote ? handlePart(other.remote) : null
    }
    return {
      ...view,
      tree: row.depth === null ? null : row.tree ? handle(row.tree) : remote ? handlePart(remote) : row.handle,
      parent_ep: handle(row.parent_ep),
      depth: row.depth,
      rules: row.rules ? (JSON.parse(row.rules) as MirrorRules) : null,
      caps: row.caps ? this.wireCaps(JSON.parse(row.caps) as ScopeCaps) : null,
      incarnation: (row as FederatedRow).incarnation ?? null,
    }
  }

  /**
   * the place each agent of a mirror batch gets, worked out here: a root is a view with no parent and depth 0; a child sits one below its
   * parent, which must be an agent this machine mirrors; anything else (a parent on another machine or not mirrored, a cycle, a root
   * claiming depth) is unknown. Undefined when the view says nothing about its place.
   */
  private placer(machine: string, batch: { view: ParsedView; before: FederatedRow | undefined }[]): (handle: string) => Placement | undefined {
    const agents = new Map(batch.filter((entry) => entry.view.kind === "agent").map((entry) => [entry.view.handle, entry]))
    const memo = new Map<string, Placement | undefined>()
    const place = (handle: string, trail: string[]): Placement | undefined => {
      if (trail.includes(handle)) return UNKNOWN
      if (memo.has(handle)) return memo.get(handle)
      const { parent, depth } = agents.get(handle)!.view.scope
      let result: Placement | undefined
      if (parent === undefined && depth === undefined) result = undefined
      else if (parent === undefined) result = UNKNOWN
      else if (parent === null) result = depth === 0 ? { tree: null, parent_ep: null, depth: 0 } : UNKNOWN
      else {
        const row = validHandle(parent) ? this.byRemote(`${machine}/${parent}`) : undefined
        if (!row || row.token_hash !== null || row.kind !== "agent") result = UNKNOWN
        else {
          const up = agents.has(parent)
            ? (place(parent, [...trail, handle]) ?? (agents.get(parent)!.before ? stored(agents.get(parent)!.before!) : UNKNOWN))
            : stored(row)
          result = up.depth === null || up.depth + 1 > LIMITS.depthMax ? UNKNOWN : { tree: up.tree ?? row.id, parent_ep: row.id, depth: up.depth + 1 }
        }
      }
      if (!trail.length) memo.set(handle, result)
      return result
    }
    return (handle) => place(handle, [])
  }

  /** an agent row's place, rules, caps, title and incarnation after a view: what it left out stays, unless the endpoint is a new incarnation */
  private scopeColumns(machine: string, scope: ParsedScope, row: FederatedRow, placement: Placement | undefined): Partial<FederatedRow> {
    const fresh = scope.incarnation !== undefined && scope.incarnation !== null && row.incarnation !== null && scope.incarnation !== row.incarnation
    const place = placement ?? (fresh ? UNKNOWN : stored(row))
    let caps = fresh ? null : row.caps
    if (scope.caps !== undefined) {
      const next = this.localCaps(machine, scope.caps ?? { caps: [], allow: {} })
      const merged = fresh || !row.caps ? next : stickyCaps(JSON.parse(row.caps) as ScopeCaps, next)
      caps = merged.caps.length || Object.keys(merged.allow).length ? JSON.stringify(merged) : null
    }
    const rules = scope.rules !== undefined ? scope.rules : fresh ? null : undefined
    return {
      ...place,
      rules: rules === undefined ? row.rules : rules && (rules.in || rules.out) ? JSON.stringify(rules) : null,
      caps,
      title: scope.title !== undefined ? scope.title : fresh ? null : row.title,
      wake: scope.wake !== undefined ? scope.wake : fresh ? null : row.wake,
      incarnation: scope.incarnation ?? row.incarnation,
    }
  }

  /** wire caps of `machine` with their `ep:<handle>` references as this core's row ids; an endpoint the machine does not mirror is `gone`, which admits nothing */
  private localCaps(machine: string, caps: ScopeCaps): ScopeCaps {
    const ref = (value: string) => {
      if (REFS.has(value)) return value
      const handle = value.startsWith("ep:") ? value.slice(3) : ""
      const row = validHandle(handle) ? this.byRemote(`${machine}/${handle}`) : undefined
      return row && row.token_hash === null && row.kind === "agent" ? row.id : "gone"
    }
    return mapRefs(caps, ref)
  }

  /** caps with this core's row ids named as `ep:<handle>`, as they cross machines */
  private wireCaps(caps: ScopeCaps): MirrorCaps {
    const ref = (value: string) => {
      if (REFS.has(value)) return value
      const row = this.byId(value) as FederatedRow | undefined
      if (row?.kind !== "agent") return "gone"
      return `ep:${row.remote ? handlePart(row.remote) : row.handle}`
    }
    const mapped = mapRefs(caps, ref)
    return { caps: mapped.caps, allow: mapped.allow }
  }

  private insertRemote(remote: string, kind: EndpointKind | "system", harness: string | null, auth: RelayAuth | null, now: number): string {
    const id = newId("ep", now)
    this.sql.all(
      `INSERT INTO endpoints (id, handle, kind, harness, labels, created_at, remote, auth) VALUES (?, ?, ?, ?, '{}', ?, ?, ?)`,
      id,
      `_r_${id}`,
      kind,
      harness,
      now,
      remote,
      auth,
    )
    return id
  }

  private retire(id: string): void {
    this.sql.all(`UPDATE endpoints SET handle = ? || id, remote = NULL, token_hash = NULL, connections = 0 WHERE id = ?`, GONE_PREFIX, id)
    this.dropPeek(id)
  }

  /** a new proxy row, within the endpoint cap */
  private insertProxy(remote: string, kind: EndpointKind | "system", harness: string | null, auth: RelayAuth): string {
    this.checkCap()
    return this.insertRemote(remote, kind, harness, auth, this.now())
  }

  private checkCap(): void {
    if (this.endpointCap === null) return
    const live = one<{ n: number }>(
      this.sql,
      `SELECT COUNT(*) AS n FROM endpoints WHERE kind != 'system' AND substr(handle, 1, ?) != ?`,
      GONE_PREFIX.length,
      GONE_PREFIX,
    )!.n
    if (live >= this.endpointCap) throw new RelayError("too_large", `at most ${this.endpointCap} endpoints on this relay`)
  }

  private checkMachine(machine: string): void {
    if (typeof machine !== "string" || !MACHINE_NAME.test(machine))
      throw new RelayError("invalid_params", `machine ${JSON.stringify(machine)} is not a valid name`)
  }

  private byRemote(remote: string): FederatedRow | undefined {
    return one<FederatedRow>(this.sql, `SELECT * FROM endpoints WHERE remote = ?`, remote)
  }

  /** a judge status notice to `endpoint` from the relay; its delivery seq */
  judgeNoticeTo(endpoint: string, text: string): number {
    return this.noticeTo(endpoint, text)
  }
}

const stored = (row: FederatedRow): Placement => ({ tree: row.tree, parent_ep: row.parent_ep, depth: row.depth })

function mapRefs(caps: ScopeCaps, ref: (value: string) => string): ScopeCaps {
  const entries = (list: ScopeEntry[]) => list.map((entry) => (entry.via === undefined ? entry : { ...entry, via: ref(entry.via) }))
  return {
    caps: caps.caps.map((cap) => ({ ...cap, by: ref(cap.by), sels: entries(cap.sels) })),
    allow: Object.fromEntries(Object.entries(caps.allow ?? {}).map(([key, list]) => [key, entries(list)])),
  }
}

/** a later view's caps over the ones seen before: a cap it leaves out stays, and a cap seen before gains only widened (`via`) entries */
function stickyCaps(seen: ScopeCaps, next: ScopeCaps): ScopeCaps {
  const plain = (entry: ScopeEntry) => entry.via === undefined
  const caps = next.caps.map((cap) => {
    const old = seen.caps.find((had) => had.id === cap.id)
    return old
      ? { ...cap, sels: cap.sels.filter((entry) => !plain(entry) || old.sels.some((had) => plain(had) && had.sel === entry.sel && had.group === entry.group)) }
      : cap
  })
  for (const old of seen.caps) if (!next.caps.some((cap) => cap.id === old.id)) caps.push(old)
  return { caps, allow: next.allow }
}

/** whether `next` drops a cap of `seen` or gives one of them a plain entry: what {@link stickyCaps} would not take without a new incarnation */
function loosens(seen: MirrorCaps, next: MirrorCaps): boolean {
  const plain = (entry: ScopeEntry) => entry.via === undefined
  return seen.caps.some((old) => {
    const cap = next.caps.find((c) => c.id === old.id)
    return !cap || cap.sels.some((entry) => plain(entry) && !old.sels.some((had) => plain(had) && had.sel === entry.sel && had.group === entry.group))
  })
}

const bad = (what: string) => new RelayError("invalid_params", `an endpoint's ${what} is not valid`)
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

function shortText(value: unknown, what: string, max = 128): string {
  if (typeof value !== "string" || !value || value.length > max) throw bad(what)
  return value
}

function parseSelectors(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some((sel) => !validSelector(sel))) throw bad(what)
  return value as string[]
}

function parseEntries(value: unknown): ScopeEntry[] {
  if (!Array.isArray(value) || value.length > 64) throw bad("caps")
  return value.map((entry) => {
    if (!isRecord(entry) || !validSelector(entry.sel)) throw bad("caps")
    return {
      sel: entry.sel as string,
      ...(entry.via === undefined ? {} : { via: shortText(entry.via, "caps") }),
      ...(entry.group === undefined ? {} : { group: shortText(entry.group, "caps") }),
      ...(entry.base === true ? { base: true as const } : {}),
      ...(entry.member === true ? { member: true as const } : {}),
    }
  })
}

/** the scope fields of an agent's view, checked; a field left out stays undefined */
function parseScope(view: Partial<MirrorView>): ParsedScope {
  const out: ParsedScope = {}
  const given = (key: keyof MirrorView) => key in view && view[key] !== undefined
  if (given("tree")) out.tree = view.tree === null ? null : shortText(view.tree, "tree")
  if (given("parent_ep")) out.parent = view.parent_ep === null ? null : shortText(view.parent_ep, "parent_ep")
  if (given("depth")) {
    if (view.depth !== null && (!Number.isInteger(view.depth) || (view.depth as number) < 0 || (view.depth as number) > 1000)) throw bad("depth")
    out.depth = view.depth ?? null
  }
  if (given("rules")) {
    if (view.rules !== null && !isRecord(view.rules)) throw bad("rules")
    const rules = view.rules as Record<string, unknown> | null
    out.rules = rules
      ? {
          ...(rules.in === undefined ? {} : { in: parseSelectors(rules.in, "rules") }),
          ...(rules.out === undefined ? {} : { out: parseSelectors(rules.out, "rules") }),
        }
      : null
  }
  if (given("caps")) {
    if (view.caps === null) out.caps = null
    else {
      const caps = view.caps as unknown
      if (!isRecord(caps) || !Array.isArray(caps.caps) || caps.caps.length > 64 || (caps.allow !== undefined && !isRecord(caps.allow))) throw bad("caps")
      const allow = Object.entries((caps.allow ?? {}) as Record<string, unknown>)
      if (allow.length > 64) throw bad("caps")
      out.caps = {
        caps: caps.caps.map((cap: unknown) => {
          if (!isRecord(cap) || (cap.dir !== "in" && cap.dir !== "out")) throw bad("caps")
          return { id: shortText(cap.id, "caps"), dir: cap.dir as ScopeDirection, by: shortText(cap.by, "caps"), sels: parseEntries(cap.sels) }
        }),
        allow: Object.fromEntries(allow.map(([key, list]) => [shortText(key, "caps"), parseEntries(list)])),
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify([out.rules ?? null, out.caps ?? null])).length > SCOPE_BYTES)
    throw new RelayError("too_large", `an endpoint's rules and caps are more than ${SCOPE_BYTES} bytes`)
  if (given("title"))
    out.title = view.title === null ? null : cleanText(typeof view.title === "string" ? view.title.replace(/\s+/g, " ") : view.title, "title", 64) || null
  if (given("wake")) out.wake = typeof view.wake === "string" && view.wake !== "none" && WAKES.includes(view.wake as Wake) ? (view.wake as Wake) : null
  if (given("incarnation")) {
    if (view.incarnation !== null && (typeof view.incarnation !== "string" || !INCARNATION.test(view.incarnation))) throw bad("incarnation")
    out.incarnation = view.incarnation ?? null
  }
  return out
}
