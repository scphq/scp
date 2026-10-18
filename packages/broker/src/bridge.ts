import {
  type ActivityRow,
  type EndpointView,
  type Envelope,
  findSecret,
  matches,
  newId,
  PROTOCOL,
  RelayError,
  type Selector,
  type SendParams,
  type SendResult,
  XLIMITS,
  type XListed,
} from "@scp-dev/core"
import { type FederatedCore, HUB_LIMITS, type RemoteView } from "@scp-dev/hub"

/** what the broker gives the bridge: waking local waiters, telling local watchers, the local policy's state */
export interface BridgeHooks {
  /** a local endpoint got a message */
  wake(endpoint: string): void
  /** a fleet event for local watchers only; never forwarded back */
  fleet(event: Record<string, unknown>): void
  /** loads the local policy; a reason when it is unusable */
  policyError(): string | null
  log?(line: string): void
}

export interface BridgeConfig {
  /** the hub's https origin, from the caller; the socket is <origin>/v1/relay/ws */
  url: string
  /** the account's bearer credential for the hub, opaque to the broker; null keeps the bridge down and says why in status() */
  token: string | null
  /** why there is no credential, for status() */
  tokenError?: string | undefined
  /** reads the credential again before each reconnect, so an expired or replaced one is picked up */
  credentials?: (() => Promise<string | null>) | undefined
  machine: string
  /** which local endpoints are mirrored to the hub (default ["*"]) */
  mirror?: Selector[] | undefined
  /** drop cwd, status notes and activity summaries from what is mirrored */
  redact?: boolean | undefined
  /** let messages marked private leave this machine */
  privateOk?: boolean | undefined
  /** a WebSocket constructor (tests) */
  webSocket?: WebSocketWithHeaders | undefined
  /** reconnect backoff bounds (default 1 s to 60 s) */
  backoff?: { minMs: number; maxMs: number } | undefined
  /** how long a forward cut off by a dropped connection waits for the next one (default 30 s) */
  forwardWaitMs?: number | undefined
  /** the wait before a failed inject is tried again, doubling for each later try (default 1 s) */
  injectBackoffMs?: number | undefined
}

export interface BridgeOptions extends BridgeConfig {
  core: FederatedCore
  onRemote: BridgeHooks
}

export interface BridgeStatus {
  enabled: true
  machine: string
  url: string
  connected: boolean
  last_error: string | null
  since: string
}

export interface Bridge {
  /** a send whose recipients are all on other machines, on behalf of the local endpoint `from` */
  forward(from: string, params: SendParams, origin?: { tty?: boolean }): Promise<SendResult>
  /** a local endpoint was claimed, let go or changed its status: mirrored as a delta */
  changed(endpoint: string): void
  /** rules, caps, groups or a title changed, which can touch several endpoints: every mirrored endpoint is sent again */
  resync(): void
  /** a local endpoint's activity, posted to the hub */
  activity(endpoint: string, row: ActivityRow): void
  /** the endpoints of other accounts this account's contacts let it reach */
  contacts(): Promise<XListed[]>
  status(): BridgeStatus
  stop(): Promise<void>
}

/** a WebSocket constructor that takes request headers, as Bun's and Node's do */
export type WebSocketWithHeaders = new (url: string, options: { headers: Record<string, string> }) => WebSocket

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type Frame = {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message: string; data?: { code?: RelayError["code"]; retry_after?: number } }
}

const CONNECT_TIMEOUT_MS = 15_000
/** room left in the hub's frame for the JSON-RPC envelope around a mirror's endpoints */
const MIRROR_FRAME_BYTES = HUB_LIMITS.frameBytes - 1024
/** an inject that throws this many times in a row is rejected to the hub as a dead letter */
const DEAD_LETTER_ATTEMPTS = 3

/** whether a send goes to other machines: all recipients remote, or none; a mixed list is refused */
export function remoteSend(core: FederatedCore, to: unknown): boolean {
  const targets = Array.isArray(to) ? to : [to]
  const remote = targets.filter((address) => core.isRemote(address)).length
  if (remote && remote !== targets.length)
    throw new RelayError("invalid_params", "a message goes to endpoints on this machine or on other machines, not both; send it twice")
  return remote > 0
}

/** `<origin>/v1/relay/ws` with ws or wss */
export function relaySocketUrl(origin: string): string {
  const url = new URL("/v1/relay/ws", origin)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

/** the broker's link to the hub: mirrors local endpoints, forwards remote sends, injects deliveries */
export function startBridge(options: BridgeOptions): Bridge {
  const { core, onRemote: hooks, machine } = options
  const selectors = options.mirror ?? ["*"]
  const minMs = options.backoff?.minMs ?? 1000
  const maxMs = options.backoff?.maxMs ?? 60_000
  const forwardWaitMs = options.forwardWaitMs ?? 30_000
  const injectBackoffMs = options.injectBackoffMs ?? 1000
  const Socket = options.webSocket ?? (WebSocket as unknown as WebSocketWithHeaders)
  const log = hooks.log ?? ((line: string) => console.error(line))
  const encoder = new TextEncoder()

  let token = options.token
  let ws: WebSocket | null = null
  let connected = false
  /** hello went through on the current socket: deltas may go out */
  let ready = false
  let stopped = false
  let lastError: string | null = options.token ? null : (options.tokenError ?? "no hub credential; the broker runs local-only")
  let since = new Date().toISOString()
  let attempt = 0
  let account: string | null = null
  let revokedReason: string | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let nextId = 1
  const pending = new Map<number, Pending>()
  let waitingForLink: (() => void)[] = []
  let deliveries: Promise<void> = Promise.resolve()
  let ackedMax = 0
  const inflight = new Set<number>()
  const injectFailures = new Map<number, number>()
  const fromHub = new WeakSet<Error>()

  const setState = (up: boolean, error: string | null) => {
    if (up !== connected || error !== lastError) since = new Date().toISOString()
    connected = up
    lastError = error
  }

  function request<T>(method: string, params: object = {}): Promise<T> {
    const socket = ws
    if (socket?.readyState !== 1) return Promise.reject(new RelayError("unavailable", "the hub is not connected"))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
      } catch (error) {
        pending.delete(id)
        reject(new RelayError("unavailable", `the hub connection failed (${error instanceof Error ? error.message : String(error)})`))
      }
    })
  }

  function fireAndForget(method: string, params: object) {
    request(method, params).catch((error: unknown) => {
      if (!(error instanceof RelayError && error.code === "unavailable"))
        log(`relay bridge: ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  function connect() {
    if (stopped || !token) return
    let socket: WebSocket
    try {
      socket = new Socket(relaySocketUrl(options.url), { headers: { Authorization: `Bearer ${token}` } })
    } catch (error) {
      setState(false, `cannot open the hub socket (${error instanceof Error ? error.message : String(error)})`)
      return retry()
    }
    ws = socket
    revokedReason = null
    let handshakeError: string | null = null
    const timer = setTimeout(() => {
      if (socket.readyState === 0) socket.close()
    }, CONNECT_TIMEOUT_MS)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      handshake(socket).catch((error: unknown) => {
        if (ws !== socket) return
        const relay = error instanceof RelayError ? error : null
        if (relay && (relay.code === "unauthorized" || relay.code === "invalid_params")) {
          stopped = true
          handshakeError = `the hub refused this bridge: ${relay.message}`
        } else if (relay?.code === "too_large") {
          handshakeError = `the hub refused this bridge for now, retrying: ${relay.message}`
        } else {
          handshakeError = `the handshake failed: ${error instanceof Error ? error.message : String(error)}`
        }
        socket.close(1000, "handshake failed")
      })
    })
    socket.addEventListener("message", (event) => onFrame(String((event as MessageEvent).data)))
    socket.addEventListener("error", () => {})
    socket.addEventListener("close", (event) => {
      clearTimeout(timer)
      if (ws !== socket) return
      ws = null
      ready = false
      const close = event as CloseEvent
      const wasUp = connected
      for (const p of pending.values()) p.reject(new RelayError("unavailable", "the hub connection closed"))
      pending.clear()
      const why = `${close.code}${close.reason ? ` ${close.reason}` : ""}`
      if (close.code === 1008) {
        stopped = true
        setState(false, `revoked or unauthorized: ${revokedReason ?? (close.reason || "the hub closed the bridge")}`)
      } else if (close.code === 4000) {
        stopped = true
        setState(false, `replaced: ${close.reason || "another bridge connected for this machine"}`)
      } else if (close.code === 4001) {
        setState(false, `the credential expired, reconnecting (${why})`)
      } else {
        setState(false, handshakeError ?? (wasUp ? `disconnected (${why})` : `cannot connect to ${options.url} (${why})`))
      }
      retry()
    })
  }

  function retry() {
    if (stopped) return
    const base = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 16))
    attempt++
    retryTimer = setTimeout(reconnect, base / 2 + Math.random() * (base / 2))
  }

  async function reconnect() {
    if (options.credentials && !stopped) {
      try {
        token = (await options.credentials()) ?? token
      } catch (error) {
        log(`relay bridge: the credential could not be read again: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    connect()
  }

  async function handshake(socket: WebSocket) {
    const hello = await request<{ account: string; endpoints: RemoteView[] }>("hello", { protocol: PROTOCOL, machine, bridge: true })
    account = hello.account
    core.setAliases([account])
    ready = true
    applyRemote(hello.endpoints, true)
    await Promise.all(fullMirror().map((params) => request("mirror", params)))
    await request("watch")
    await request("subscribe", { after: cursor() })
    if (ws !== socket) return
    attempt = 0
    setState(true, null)
    for (const fn of waitingForLink.splice(0)) fn()
  }

  /** the other machines' endpoints, grouped by machine; with `full`, a known machine missing from the list goes offline */
  function applyRemote(views: RemoteView[], full: boolean) {
    const byMachine = new Map<string, RemoteView[]>()
    for (const view of views) {
      if (view.machine === machine) continue
      byMachine.set(view.machine, [...(byMachine.get(view.machine) ?? []), view])
    }
    if (full) for (const view of core.remoteViews()) if (view.machine !== account && !byMachine.has(view.machine)) byMachine.set(view.machine, [])
    for (const [name, list] of byMachine) {
      try {
        core.mirror(name, list, { full })
      } catch (error) {
        log(`relay bridge: the endpoints of ${name} were not applied: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  function mirrored(view: EndpointView): boolean {
    if (view.kind === "system" || core.machineOf(view.id) !== null) return false
    const subject = {
      handle: view.kind === "human" ? "" : view.address.slice(view.address.lastIndexOf("/") + 1),
      harness: view.harness,
      kind: view.kind,
      labels: view.labels,
    }
    return selectors.some((selector) => matches(selector, subject))
  }

  function outward(view: EndpointView): object {
    const { title, ...scope } = core.mirrorScope(view.id)
    return {
      ...scope,
      ...(title === undefined ? {} : { title: options.redact ? null : title }),
      address: view.address,
      kind: view.kind,
      harness: view.harness,
      model: view.model,
      cwd: options.redact ? null : view.cwd,
      labels: view.labels,
      status: view.status ? { state: view.status.state, note: options.redact ? "" : view.status.note } : null,
      presence: view.presence,
      last_seen: view.last_seen,
    }
  }

  function localViews(): object[] {
    return core.list().filter(mirrored).map(outward)
  }

  /**
   * the full mirror in frames that fit the hub's, sent back to back. Several frames share a `sync`, and the hub marks offline
   * only what the whole sync left out, once its last frame is in; the first keeps `full`.
   */
  function fullMirror(): { endpoints: object[]; full: boolean; sync?: { id: string; part: number; parts: number } }[] {
    const frames: object[][] = [[]]
    let bytes = 0
    for (const view of localViews()) {
      const size = encoder.encode(JSON.stringify(view)).length + 1
      if (size > MIRROR_FRAME_BYTES)
        throw new RelayError("too_large", `${(view as { address: string }).address} mirrors ${size} bytes, over the hub's ${MIRROR_FRAME_BYTES} byte frame`)
      if (bytes + size > MIRROR_FRAME_BYTES) {
        frames.push([])
        bytes = 0
      }
      frames.at(-1)!.push(view)
      bytes += size
    }
    if (frames.length === 1) return [{ endpoints: frames[0]!, full: true }]
    const id = newId("sync")
    return frames.map((endpoints, i) => ({ endpoints, full: i === 0, sync: { id, part: i + 1, parts: frames.length } }))
  }

  /** the handle the hub knows a local endpoint by ("" for the human inbox), or null when it is not mirrored */
  function handleOf(endpoint: string): string | null {
    const view = core.whoami(endpoint)
    if (!mirrored(view)) return null
    return view.kind === "human" ? "" : view.address.slice(view.address.lastIndexOf("/") + 1)
  }

  /** a hub address (`<account>/<machine>/<handle>` or `<account>/<handle>`) as the local core writes it */
  function localAddress(address: unknown): unknown {
    if (typeof address !== "string" || !account || !address.startsWith(`${account}/`)) return address
    const rest = address.slice(account.length + 1)
    return rest.includes("/") ? `${core.user}/${rest}` : `${core.user}/${account}/${rest}`
  }

  /** the lowest seq a fresh subscribe must replay from: every delivery at or below it was acked */
  function cursor(): number {
    return inflight.size ? Math.min(...inflight) - 1 : ackedMax
  }

  function onFrame(text: string) {
    let frame: Frame
    try {
      frame = JSON.parse(text) as Frame
    } catch {
      log("relay bridge: the hub sent a frame that is not JSON")
      return
    }
    if (frame.method) return onNotification(frame.method, frame.params as Record<string, unknown>)
    const waiter = frame.id !== undefined ? pending.get(frame.id) : undefined
    if (!waiter) return
    pending.delete(frame.id!)
    if (!frame.error) return waiter.resolve(frame.result)
    const error = new RelayError(frame.error.data?.code ?? "unavailable", frame.error.message, frame.error.data?.retry_after)
    fromHub.add(error)
    waiter.reject(error)
  }

  function onNotification(method: string, params: Record<string, unknown>) {
    switch (method) {
      case "deliver": {
        const seq = params.seq
        if (!Number.isInteger(seq)) return
        inflight.add(seq as number)
        deliveries = deliveries.then(() => deliver(seq as number, params.endpoint, params.message as Envelope))
        return
      }
      case "endpoints": {
        if (typeof params.machine !== "string" || params.machine === machine) return
        try {
          core.mirror(params.machine, params.endpoints, { full: params.full === true })
        } catch (error) {
          log(`relay bridge: the endpoints of ${params.machine} were not applied: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }
      case "fleet":
        return remoteFleet(params)
      case "revoked":
        revokedReason = typeof params.reason === "string" ? params.reason : null
        return
    }
  }

  async function deliver(seq: number, target: unknown, message: Envelope) {
    try {
      let refused: string | null = null
      for (;;) {
        try {
          refused = inject(target, message)
          break
        } catch (error) {
          if (error instanceof RelayError) {
            refused = error.code
            break
          }
          const attempts = (injectFailures.get(seq) ?? 0) + 1
          injectFailures.set(seq, attempts)
          const why = error instanceof Error ? error.message : String(error)
          log(`relay bridge: delivery ${seq} failed (attempt ${attempts} of ${DEAD_LETTER_ATTEMPTS}): ${why}`)
          if (attempts >= DEAD_LETTER_ATTEMPTS) {
            await settled("reject", { seq, code: "dead_letter" })
            settle(seq)
            core.record("dead_letter", null, typeof message?.id === "string" ? message.id : null, { seq, target: String(target), attempts, error: why })
            return
          }
          await new Promise((resolve) => setTimeout(resolve, injectBackoffMs * 2 ** (attempts - 1)))
        }
      }
      if (refused !== null) {
        await settled("reject", { seq, code: refused })
        settle(seq)
        return
      }
      await settled("ack", { seqs: [seq] })
      settle(seq)
    } catch (error) {
      if (error instanceof RelayError && error.code === "unavailable") return
      log(`relay bridge: delivery ${seq} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** admits a delivery to its local endpoint and tells the local waiters; the refusal's code, or null once admitted */
  function inject(target: unknown, message: Envelope): string | null {
    const endpoint = core.localTarget(target)
    if ((hooks.policyError() ?? core.inboundRefusal(endpoint, message)) !== null) return "policy_refused"
    if (core.admit(endpoint, message).duplicate) return null
    hooks.wake(endpoint)
    hooks.fleet({
      type: "message",
      machine: message.from.machine ?? null,
      id: message.id,
      thread: message.thread,
      kind: message.kind,
      from: localAddress(message.from.address),
      to: [core.addressOf(endpoint)],
      hop: message.hop,
    })
    return null
  }

  /** an ack or reject; one the hub's ack limit refuses waits its retry_after and goes again, while the link holds */
  async function settled(method: "ack" | "reject", params: object): Promise<void> {
    for (;;) {
      try {
        await request(method, params)
        return
      } catch (error) {
        if (!(error instanceof RelayError && error.code === "rate_limited")) throw error
        await new Promise((resolve) => setTimeout(resolve, (error.retryAfterS ?? 1) * 1000))
      }
    }
  }

  function settle(seq: number) {
    inflight.delete(seq)
    injectFailures.delete(seq)
    ackedMax = Math.max(ackedMax, seq)
  }

  function remoteFleet(event: Record<string, unknown>) {
    if (event.machine === machine) return
    if (
      event.type === "message" &&
      Array.isArray(event.to) &&
      account &&
      event.to.some((to) => typeof to === "string" && to.startsWith(`${account}/${machine}/`))
    )
      return
    const local: Record<string, unknown> = {
      ...event,
      ...(event.from !== undefined ? { from: localAddress(event.from) } : {}),
      ...(event.endpoint !== undefined ? { endpoint: localAddress(event.endpoint) } : {}),
    }
    if (Array.isArray(event.to)) local.to = event.to.map(localAddress)
    if (event.type === "activity" && typeof event.machine === "string" && typeof event.endpoint === "string") {
      try {
        const proxy = core.remoteEndpoint(event.machine, event.endpoint.slice(event.endpoint.lastIndexOf("/") + 1))
        const row = core.event(proxy, { kind: event.kind, tool: event.tool, summary: event.summary })
        local.id = row.id
      } catch {}
    }
    hooks.fleet(local)
  }

  /** resolves when the link is up, false when `ms` passed or the bridge stopped first */
  function linkUp(ms: number): Promise<boolean> {
    if (connected) return Promise.resolve(true)
    if (stopped) return Promise.resolve(false)
    return new Promise((resolve) => {
      const done = (up: boolean) => {
        clearTimeout(timer)
        waitingForLink = waitingForLink.filter((fn) => fn !== onUp)
        resolve(up)
      }
      const onUp = () => done(true)
      const timer = setTimeout(() => done(false), ms)
      waitingForLink.push(onUp)
    })
  }

  function unavailable(): RelayError {
    return new RelayError("unavailable", `the hub is not connected${lastError ? ` (${lastError})` : ""}; try again`, 5)
  }

  /** a message to another account: one recipient, no fan-out, a short body, nothing private or attached; never stripped to fit */
  function crossAccount(params: SendParams, targets: unknown[]) {
    if (targets.length !== 1) throw new RelayError("invalid_params", "a message to another account goes to exactly one endpoint: no lists, groups or tree:")
    if (typeof params.body === "string") {
      const bytes = new TextEncoder().encode(params.body).length
      if (bytes > XLIMITS.bodyBytes)
        throw new RelayError("too_large", `a message to another account is at most ${XLIMITS.bodyBytes} bytes; this one is ${bytes}`)
    }
    if (params.attachments?.length) throw new RelayError("data_class_refused", "attachments stay in this account; send a reference instead")
    if (params.data_class === "private") throw new RelayError("data_class_refused", "a private message stays in this account")
  }

  async function forward(from: string, params: SendParams, origin: { tty?: boolean } = {}): Promise<SendResult> {
    const sender = core.addressOf(from)
    const targets = Array.isArray(params.to) ? params.to : [params.to]
    if (targets.some((to) => core.foreignAccount(to) !== null)) crossAccount(params, targets)
    for (const to of targets) {
      core.scopeCheck(from, to, typeof params.reply_to === "string" ? params.reply_to : undefined)
      const refusal = core.checkPolicy(sender, String(to))
      if (refusal) throw new RelayError("policy_refused", `${refusal} (${String(to)})`)
    }
    if (typeof params.body !== "string") throw new RelayError("invalid_params", "body must be a string")
    if (params.data_class === "private" && !options.privateOk) {
      throw new RelayError(
        "data_class_refused",
        "a private message stays on this machine; allow private messages in the bridge configuration to send them through the hub",
      )
    }
    const secret = findSecret(params.body) ?? (params.attachments ?? []).map((a) => findSecret(String(a?.path))).find(Boolean) ?? null
    if (secret) throw new RelayError("secret_refused", `the message looks like it carries a credential (${secret}); send a reference instead`)
    const earlier = core.forwarded(from, params)
    if (earlier) return earlier
    const handle = handleOf(from)
    if (handle === null)
      throw new RelayError("policy_refused", `${sender} is not mirrored to the hub (the bridge's mirror selectors), so it can't message other machines`)
    if (!connected) throw unavailable()
    const clientId = params.client_id ?? newId("fwd")
    const sent: SendParams = { ...params, client_id: clientId, to: targets.map((to) => core.route(to)!) }
    delete (sent as { wait_s?: unknown }).wait_s
    delete sent.attachments
    const deadline = Date.now() + forwardWaitMs
    for (let tries = 0; ; ) {
      try {
        const result = await request<SendResult>("forward", {
          from: handle,
          params: sent,
          hop_floor: core.causalHop(from),
          ...(origin.tty === undefined ? {} : { tty: origin.tty }),
        })
        core.recordForward(from, { ...params, client_id: clientId }, result, origin)
        return result
      } catch (error) {
        if (!(error instanceof RelayError && error.code === "unavailable")) throw error
        if (fromHub.has(error)) {
          const base = Math.min(maxMs, minMs * 2 ** tries++)
          const wait = Math.max(base / 2 + Math.random() * (base / 2), (error.retryAfterS ?? 0) * 1000)
          if (Date.now() + wait >= deadline) throw error
          await new Promise((resolve) => setTimeout(resolve, wait))
        } else if (!(await linkUp(deadline - Date.now()))) throw unavailable()
      }
    }
  }

  function changed(endpoint: string) {
    if (!ready) return
    let view: EndpointView
    try {
      view = core.whoami(endpoint)
    } catch {
      return
    }
    if (mirrored(view)) fireAndForget("mirror", { endpoints: [outward(view)], full: false })
  }

  function resync() {
    if (!ready) return
    let frames: ReturnType<typeof fullMirror>
    try {
      frames = fullMirror()
    } catch (error) {
      return log(`relay bridge: mirror failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const params of frames) fireAndForget("mirror", params)
  }

  function activity(endpoint: string, row: ActivityRow) {
    if (!ready) return
    const handle = handleOf(endpoint)
    if (handle === null) return
    fireAndForget("event", { from: handle, kind: row.kind, tool: row.tool ?? undefined, summary: options.redact ? undefined : (row.summary ?? undefined) })
  }

  async function contacts(): Promise<XListed[]> {
    if (!connected) throw unavailable()
    return (await request<{ contacts: XListed[] }>("list", { contacts: true })).contacts
  }

  function status(): BridgeStatus {
    return { enabled: true, machine, url: options.url, connected, last_error: lastError, since }
  }

  async function stop() {
    stopped = true
    clearTimeout(retryTimer)
    for (const fn of waitingForLink.splice(0)) fn()
    const socket = ws
    ws = null
    connected = false
    ready = false
    for (const p of pending.values()) p.reject(new RelayError("unavailable", "the bridge stopped"))
    pending.clear()
    if (socket && socket.readyState <= 1) socket.close(1000, "the broker stopped")
  }

  connect()
  return { forward, changed, resync, activity, contacts, status, stop }
}
