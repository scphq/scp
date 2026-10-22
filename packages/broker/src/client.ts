import {
  type Claim,
  type EndpointView,
  type Envelope,
  CLI_NAME,
  type ErrorCode,
  type PeerView,
  PROTOCOL,
  RelayError,
  type ScopeChange,
  type ScopePreset,
  type ScopeView,
  type StopWaitResult,
  type WhyResult,
} from "@scp-dev/core"
import { readFileSync } from "node:fs"
import { createConnection } from "node:net"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { brokerLockHeld } from "./lock"
import { encodeLine, LineReader, LineWriter, MAX_LINE } from "./ndjson"
import { ownPrivateDir, socketPath } from "./paths"
import { Conn } from "./socket"

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export interface Hello {
  claim?: Claim
  resume?: string
  /** the human inbox me/; `tty` says whether a terminal is attached, and is recorded on what it sends */
  human?: boolean
  tty?: boolean
  /** a hook's connection: it claims like an agent but never counts as connected, and posts only event and status */
  transient?: boolean
  /** with `transient`: the session joins the relay on demand, taking `handle` when given, and links itself under the agent `under` */
  join?: { handle?: string; under?: string }
  /** a one-shot command: the broker announces no presence change when it connects or goes */
  brief?: boolean
  /** no identity: list, status, watch, log and policy only */
  observe?: boolean
  /** an observer's process lineage: when it lands on an endpoint, the observer gets that endpoint's view and may narrow */
  lineage?: string[]
  /** an observer's lineage up to its nearest harness process: when it lands on an agent endpoint, the connection acts as it with lineage auth */
  self?: string[]
  /** a spawn-env grant from a shell with no name: the hello binds only to the endpoint that spent it, or one below it */
  grant?: string
  /** with `self` or `lineage`: the caller's harness session id, which picks among the endpoints one harness instance holds */
  harness_session?: string
  /** with `observe`: a broker wake's waker run binds to its endpoint, as that endpoint, with the wake ticket the run got */
  ticket?: string
  cwd?: string
}

export interface BrokerInfo {
  socket: string
  dir: string
  pid: number
  policy: { file: string; state: "open" | "loaded" | "error"; error?: string }
}

export interface HelloResult {
  endpoint: EndpointView | null
  token?: string
  /** the broker checked the hello's grant against the endpoint it bound */
  grant_bound?: boolean
  /** a hook's subagent claim the broker honoured, and whether it made the endpoint */
  subagent?: true
  created?: true
  capabilities: string[]
  preamble: string
  broker: BrokerInfo
}

export interface GrantParams {
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
  /** a full process key: a claim from that process's tree with no grant of its own takes this grant (`swarm spawn` binds its own) */
  bind_process?: string
  /** `swarm spawn`'s, which waits on the harness it runs: the spawner's stop may wait for that worker */
  spawn?: boolean
  /** `swarm spawn --no-push`'s: the spawner's stop never waits on that worker, whose messages and handback stay ordinary unread ones */
  no_push?: boolean
  /** with peek on, the spawn's prompt: kept scrubbed as the worker's first peek turn once it joins */
  prompt?: string
}

export interface GroupParams {
  action: "create" | "add" | "remove" | "rules" | "ls" | "show" | "drop" | "pin" | "unpin"
  name?: string
  endpoint?: string
  in?: string[]
  out?: string[]
  rules?: string[]
}

/** one NDJSON JSON-RPC connection to the local broker */
export class RelayClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly reader = new LineReader(64 * 1024 * 1024)
  private readonly writer = new LineWriter()
  private socket!: Conn<undefined>
  private closedError: Error | undefined
  private listeners: ((method: string, params: unknown) => void)[] = []

  static connect(path: string): Promise<RelayClient> {
    const client = new RelayClient()
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path })
      socket.once("error", reject)
      socket.once("connect", () => {
        socket.off("error", reject)
        client.socket = new Conn(socket, undefined, {
          data: (_s, chunk) => client.onData(chunk),
          drain: () => client.flush(),
          close: (_s, error) => client.onClose(error ?? new Error("the relay broker closed the connection")),
        })
        resolve(client)
      })
    })
  }

  onNotification(fn: (method: string, params: unknown) => void): void {
    this.listeners.push(fn)
  }

  /** whether the connection is closed, by either side */
  get closed(): boolean {
    return this.closedError !== undefined
  }

  request<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = this.nextId++
    const line = encodeLine({ jsonrpc: "2.0", id, method, params })
    const bytes = line.length - 1
    if (bytes > MAX_LINE) {
      return Promise.reject(
        new RelayError(
          "too_large",
          `the request is ${bytes} bytes as JSON, over the broker's ${MAX_LINE} byte line limit (control characters count 6 bytes each once escaped)`,
        ),
      )
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.writer.pushBytes(line)
      this.flush()
    })
  }

  hello(hello: Hello): Promise<HelloResult> {
    return this.request<HelloResult>("hello", { protocol: PROTOCOL, capabilities: [], ...hello })
  }

  rules(endpoint?: string): Promise<ScopeView> {
    return this.request<ScopeView>("rules", endpoint ? { endpoint } : {})
  }

  rulesSet(params: { endpoint?: string; in?: string[]; out?: string[]; scope?: ScopePreset; allow?: string[] }): Promise<ScopeView> {
    return this.request<ScopeView>("rules_set", params)
  }

  rulesWiden(params: { endpoint: string; in?: string[]; out?: string[] }): Promise<ScopeChange> {
    return this.request<ScopeChange>("rules_widen", params)
  }

  rulesLift(params: { endpoint: string; cap: string }): Promise<ScopeView> {
    return this.request<ScopeView>("rules_lift", params)
  }

  /** a `krt_` grant for a spawn: `env` holds SCP_GRANT, which is a secret */
  grant(params: GrantParams): Promise<{ token: string; env: Record<string, string>; steer?: { key: string; parent: string } }> {
    return this.request("grant", params)
  }

  /**
   * the harness a spawn ran with `grant` exited: its endpoint goes done and offline, or a grant no one spent is revoked, and the spawner gets
   * `output` back in the handback message, unless the harness never `started`
   */
  spawnExit(params: {
    grant: string
    code: number
    output?: string
    stderr?: string
    unapplied?: string[]
    exits?: number[]
    started?: boolean
    /** a held spawn's later run, 2 and up: its own handback, a reply in the spawn's thread */
    run?: number
    /** the spawner's message that woke that run */
    reply_to?: string
  }): Promise<{ joined: boolean; name: string | null; endpoint: EndpointView | null; handback?: string | null }> {
    return this.request("spawn_exit", params)
  }

  /**
   * a spawned worker that exited: its harness session id, the transcript its hooks named with it and its spawner's unread messages to it;
   * with `take` and a session they are marked read, for a resume to carry them
   */
  spawnSteers(params: {
    grant: string
    take?: boolean
  }): Promise<{ session: string | null; steers: Envelope[]; transcript?: string | null; joined?: boolean }> {
    return this.request("spawn_steers", params)
  }

  /**
   * at a stop: the spawned workers' unread messages, held for the hook to print, waiting up to `wait_s` while workers still run, none came,
   * pushes are left and no prompt moved the `prompts` mark inject handed out; with `wait_s` above 0 and other workers still running, the
   * broker gathers more of their results into the same push for up to ${LIMITS.pushGraceS} s, which may run past `wait_s`
   */
  stopWait(waitS = 0, prompts?: number): Promise<StopWaitResult> {
    return this.request<StopWaitResult>("stop_wait", { wait_s: waitS, ...(prompts !== undefined ? { prompts } : {}) })
  }

  group(params: GroupParams): Promise<unknown> {
    return this.request("group", params)
  }

  admin(params: { action: "grant" | "revoke" | "ls"; subject?: string; tree?: string; group?: string }): Promise<unknown> {
    return this.request("admin", params)
  }

  async peers(): Promise<PeerView[]> {
    return (await this.request<{ peers: PeerView[] }>("peers")).peers
  }

  why(from: string, to: string): Promise<WhyResult> {
    return this.request<WhyResult>("why", { from, to })
  }

  close(): void {
    this.socket.end()
  }

  private flush() {
    this.writer.flush((bytes) => this.socket.write(bytes))
  }

  private onData(chunk: Uint8Array) {
    const { lines, tooLong } = this.reader.push(chunk)
    this.dispatchLines(lines)
    if (tooLong) this.fail(new Error("the relay broker sent a line over the size cap"))
  }

  private dispatchLines(lines: string[]) {
    for (const line of lines) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        this.fail(new Error("the relay broker sent a line that is not JSON"))
        return
      }
      const message = parsed as {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
        error?: { message: string; data?: { code?: ErrorCode; retry_after?: number } }
      }
      if (message.method) {
        for (const fn of this.listeners) fn(message.method, message.params)
        continue
      }
      const pending = message.id !== undefined ? this.pending.get(message.id) : undefined
      if (!pending) continue
      this.pending.delete(message.id!)
      if (message.error) pending.reject(new RelayError(message.error.data?.code ?? "invalid_params", message.error.message, message.error.data?.retry_after))
      else pending.resolve(message.result)
    }
  }

  private fail(error: Error) {
    this.onClose(error)
    this.socket.end()
  }

  private onClose(error: Error) {
    if (this.closedError) return
    this.closedError = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export class BrokerUnavailable extends Error {
  constructor(
    message: string,
    /** a sandbox around this process refused the connection to a running broker */
    readonly sandboxed = false,
    /** a running broker kept refusing connections for the whole retry budget */
    readonly busy = false,
  ) {
    super(message)
  }
}

/** how long a connect keeps trying by default: a busy or restarting broker, or one it started */
export const CONNECT_BUDGET_MS = 12_000
/** the first pause between two tries, doubling after each */
export const RETRY_MIN_MS = 50
/** the longest pause between two tries */
export const RETRY_MAX_MS = 400
/** what a full listen backlog or a broker restarting between unlink and listen answers */
const TRANSIENT = new Set(["ECONNREFUSED", "EAGAIN", "ENOENT"])
/** environment markers of a sandbox that may refuse unix sockets */
const SANDBOX_MARKERS = ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"]

export interface ConnectRetry {
  /** how long to keep trying, ms (default {@link CONNECT_BUDGET_MS}) */
  budgetMs?: number
  /** called once, before the first retry */
  retrying?: () => void
  /** the environment checked for sandbox markers (default process.env) */
  env?: Record<string, string | undefined>
}

/** the pause before try `attempt + 1`: {@link RETRY_MIN_MS} doubling, up to half again in jitter, never above {@link RETRY_MAX_MS} or `left` */
export function retryDelay(attempt: number, left: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt)
  return Math.max(0, Math.min(left, RETRY_MAX_MS, base * (1 + random() / 2)))
}

/** whether the broker for `dir` is running: its lock is held, or, when the lock cannot be probed, its pid is alive */
function brokerLive(dir: string): boolean {
  const lock = join(dir, "broker.lock")
  const held = brokerLockHeld(lock)
  if (held !== undefined) return held
  let pid: number
  try {
    pid = Number(readFileSync(lock, "utf8").split(":")[0])
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM"
  }
}

/**
 * A connection to the broker for `dir`. A refused or missing socket of a running broker (a full listen backlog, a restart) is retried with
 * jittered exponential backoff within the budget (`retry`, or a number of ms); with `start`, a broker that is not running is started
 * (detached) and waited for within the same budget. A refusal is a sandbox's only on EPERM or EACCES, or for a running broker under a
 * sandbox marker; a running broker that refuses for the whole budget is busy. A socket whose directory is a link, someone else's, or
 * writable by others is refused before anything is sent: in /tmp anyone could make it first.
 */
export async function connectBroker(dir: string, start?: () => void, retry: number | ConnectRetry = {}): Promise<RelayClient> {
  const options = typeof retry === "number" ? { budgetMs: retry } : retry
  const budget = options.budgetMs ?? CONNECT_BUDGET_MS
  const env = options.env ?? process.env
  const path = socketPath(dir)
  const refuse = (code: unknown) => new BrokerUnavailable(`the sandbox blocks the relay socket (${code}); allow ${path} or run outside the sandbox`, true)
  const owned = (client: RelayClient) => {
    if (ownPrivateDir(dirname(path))) return client
    client.close()
    throw new BrokerUnavailable(`${dirname(path)} is a link, not this user's, or writable by others; refusing the relay socket in it`)
  }
  const deadline = Date.now() + budget
  let started = false
  for (let attempt = 0; ; attempt++) {
    let failure: unknown
    try {
      return owned(await RelayClient.connect(path))
    } catch (error) {
      if (error instanceof BrokerUnavailable) throw error
      failure = error
    }
    const code = (failure as { code?: unknown } | null)?.code
    const reason = failure instanceof Error ? failure.message : String(failure)
    if (code === "EPERM" || code === "EACCES") throw refuse(code)
    const live = brokerLive(dir)
    if (live && SANDBOX_MARKERS.some((key) => env[key]) && code !== "ENOENT") throw refuse(code ?? "refused")
    if (!live && !started) {
      if (!start) throw new BrokerUnavailable(`no relay broker at ${path} (${reason})`)
      start()
      started = true
    }
    const left = deadline - Date.now()
    if (left <= 0 || (live && !TRANSIENT.has(String(code)))) {
      if (!live) throw new BrokerUnavailable(`the relay broker did not start within ${budget} ms (${reason})`)
      throw new BrokerUnavailable(
        `the relay broker is running but did not accept a connection within ${budget} ms (${code ?? reason}): it is busy; ${CLI_NAME} status shows it`,
        false,
        true,
      )
    }
    if (attempt === 0) options.retrying?.()
    await sleep(retryDelay(attempt, left))
  }
}
