import type { Bridge, BridgeStatus, LinkContext } from "@scp-dev/broker"
import { type EndpointView, findSecret, LIMITS, matches, newId, PROTOCOL, RelayError, SERVER_FIELDS, type SendParams, type SendResult } from "@scp-dev/core"
import { WebSocket, WebSocketServer } from "ws"
import { type AccountKey, type MeshConfig, parseHostPort } from "./config"
import { accountId, canonicalJson, type KeyPair, newNonce, SIGN_DOMAIN, signPayload, validPublicKey, verifyPayload } from "./keys"
import { type Channel, type Exchange, newExchange, openChannel, SEAL_TAG_BYTES } from "./seal"
import { issueCert, type MachineCert, type MachineRecord, MESH_FRAME_BYTES, MESH_PATH, signRecord, verifyCert, verifyRecord } from "./wire"

export interface MeshOptions extends LinkContext {
  config: MeshConfig
  account: AccountKey
  machineKey: KeyPair
  /** read again every reloadMs for the peer list; null keeps the last one */
  reloadConfig?: (() => MeshConfig | null) | undefined
  /** default 5 s */
  reloadMs?: number | undefined
  /** reconnect backoff bounds (default 1 s to 30 s) */
  backoff?: { minMs: number; maxMs: number } | undefined
  /** default 15 s; a link silent for 3 heartbeats is closed */
  heartbeatMs?: number | undefined
  /** how long a forward waits for the peer's answer (default 30 s) */
  forwardTimeoutMs?: number | undefined
}

export interface MeshPeerStatus {
  addr: string
  machine: string | null
  connected: boolean
  last_error: string | null
}

export interface MeshLinkStatus {
  machine: string
  inbound: boolean
  addr: string | null
  since: string
}

export interface MeshMachineStatus {
  machine: string
  epoch: number
  seq: number
  endpoints: number
  linked: boolean
}

export interface MeshStatus extends BridgeStatus {
  mesh: {
    account: string
    acct: string
    /** the bound host:port, or null when dialing out only */
    listen: string | null
    peers: MeshPeerStatus[]
    links: MeshLinkStatus[]
    machines: MeshMachineStatus[]
  }
}

export interface MeshLink extends Bridge {
  status(): MeshStatus
  /** resolves once the listener is bound: its host and port, or null with no listener */
  listening(): Promise<{ host: string; port: number } | null>
}

type Timer = ReturnType<typeof setTimeout>
type Params = Record<string, unknown>
type Pending = { resolve: (result: SendResult) => void; reject: (error: Error) => void; timer: Timer }
type Peer = MeshPeerStatus & { attempt: number; timer?: Timer; link?: Link }
type Link = {
  socket: WebSocket
  peer: Peer | null
  cert: MachineCert | null
  nonce: string
  peerNonce: string | null
  /** dropped once the channel keys are derived */
  exchange: Exchange | null
  peerKx: string | null
  channel: Channel | null
  authenticated: boolean
  order: number
  since: string
  received: number
  forwards: number[]
  pending: Map<number, Pending>
  authTimer: Timer
  closeTimer?: Timer
  closed: Promise<void>
}

function object(value: unknown, what: string): Params {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RelayError("invalid_params", `${what} must be an object`)
  return value as Params
}

/** inbound links still authenticating; past this, new connections are closed at once */
const PENDING_INBOUND = 64

function hostPort(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`
}

export function startMesh(options: MeshOptions): MeshLink {
  const { core, hooks, send, machineKey } = options
  const { account, machine } = options.config
  const acct = accountId(options.account.public)
  const trust = { acct, public: options.account.public }
  const cert = issueCert(options.account, machine, machineKey)
  const log = hooks.log ?? (() => {})
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const minMs = options.backoff?.minMs ?? 1000
  const maxMs = options.backoff?.maxMs ?? 30_000
  const links = new Set<Link>()
  const peers = new Map<string, Peer>()
  const records = new Map<string, MachineRecord>()
  let stopped = false
  let stopping: Promise<void> | undefined
  let rebuildTimer: Timer | undefined
  let lastError: string | null = null
  let since = new Date().toISOString()
  let bound: { host: string; port: number } | null = null
  let server: WebSocketServer | undefined
  let nextId = 1
  let order = 0
  core.setAliases([account])

  function report(error: unknown, peer?: Peer | null) {
    lastError = error instanceof Error ? error.message : String(error)
    since = new Date().toISOString()
    if (peer) peer.last_error = lastError
    log(`mesh: ${lastError}`)
  }

  function mirrored(view: EndpointView): boolean {
    if (view.kind === "system" || core.machineOf(view.id) !== null) return false
    return matches("*", {
      handle: view.kind === "human" ? "" : view.address.slice(view.address.lastIndexOf("/") + 1),
      harness: view.harness,
      kind: view.kind,
      labels: view.labels,
    })
  }

  /** handles local endpoints had before a rename, carried in the next record so peers rename their mirror in place */
  const renames = new Map<string, string>()

  function outward(view: EndpointView): object {
    return {
      ...core.mirrorScope(view.id),
      address: view.address,
      kind: view.kind,
      harness: view.harness,
      model: view.model,
      cwd: view.cwd,
      labels: view.labels,
      status: view.status ? { state: view.status.state, note: view.status.note } : null,
      presence: view.presence,
      last_seen: view.last_seen,
      ...(view.kind === "agent" ? { wake: view.wake ?? null } : {}),
      ...(renames.has(view.id) ? { was: renames.get(view.id) } : {}),
    }
  }

  function localViews(): object[] {
    const endpoints = core.list().filter(mirrored).map(outward)
    if (endpoints.length > 512) throw new RelayError("too_large", "a mesh record carries at most 512 endpoints")
    return endpoints
  }

  let own = signRecord(machineKey, { v: 1, acct, machine, epoch: Date.now(), seq: 1, endpoints: localViews(), cert })
  let ownJson = canonicalJson(own.endpoints)

  function linked(name: string): Link | undefined {
    let latest: Link | undefined
    for (const link of links) {
      if (link.authenticated && link.cert?.machine === name && (!latest || link.order > latest.order)) latest = link
    }
    return latest
  }

  /** a live link to a machine of this name under another machine key: two machines share a name */
  function rival(name: string, key: string): boolean {
    const live = linked(name)
    return !!live && live.cert!.key !== key
  }

  function apply(record: MachineRecord) {
    try {
      core.mirror(record.machine, record.endpoints, { full: true, auth: "account+bridge" })
    } catch (error) {
      report(error)
    }
    if (!linked(record.machine)) core.markOffline(record.machine)
  }

  function write(link: Link, frame: object) {
    const text = JSON.stringify({ jsonrpc: "2.0", ...frame })
    if (Buffer.byteLength(text) > MESH_FRAME_BYTES) throw new RelayError("too_large", "the mesh frame is too large")
    if (link.socket.readyState !== WebSocket.OPEN) throw new RelayError("unavailable", "the mesh link is closed")
    link.socket.send(link.channel ? link.channel.seal(text) : text)
  }

  function notify(link: Link, method: string, params: object) {
    try {
      write(link, { method, params })
    } catch (error) {
      report(error, link.peer)
    }
  }

  function broadcast(accepted: MachineRecord[], except?: Link) {
    for (const link of links) if (link.authenticated && link !== except) notify(link, "records", { records: accepted })
  }

  function rebuild() {
    rebuildTimer = undefined
    if (stopped) return
    try {
      const endpoints = localViews()
      const json = canonicalJson(endpoints)
      if (json === ownJson) return
      const record = signRecord(machineKey, { v: 1, acct, machine, epoch: own.epoch, seq: own.seq + 1, endpoints, cert })
      if (Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method: "records", params: { records: [record] } })) > MESH_FRAME_BYTES)
        throw new RelayError("too_large", "the mesh record is too large")
      own = record
      ownJson = json
      renames.clear()
      broadcast([own])
    } catch (error) {
      report(error)
    }
  }

  function schedule() {
    if (!stopped && !rebuildTimer) rebuildTimer = setTimeout(rebuild, 25)
  }

  function deactivate(link: Link) {
    const wasUp = link.authenticated
    link.authenticated = false
    clearTimeout(link.authTimer)
    for (const pending of link.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new RelayError("unavailable", "the mesh link closed"))
    }
    link.pending.clear()
    if (link.peer) link.peer.connected = false
    if (wasUp) {
      since = new Date().toISOString()
      if (link.cert && !linked(link.cert.machine)) core.markOffline(link.cert.machine)
    }
  }

  function close(link: Link, code: number, reason: string) {
    deactivate(link)
    if (link.socket.readyState === WebSocket.CONNECTING) link.socket.terminate()
    else if (link.socket.readyState === WebSocket.OPEN) link.socket.close(code, reason)
    if (!link.closeTimer && link.socket.readyState !== WebSocket.CLOSED) link.closeTimer = setTimeout(() => link.socket.terminate(), 1000)
  }

  function refuse(link: Link, reason: string) {
    report(reason, link.peer)
    close(link, 1008, reason)
  }

  function authenticated(link: Link) {
    const name = link.cert!.machine
    const first = !linked(name)
    link.authenticated = true
    link.order = ++order
    link.since = new Date().toISOString()
    since = link.since
    lastError = null
    clearTimeout(link.authTimer)
    if (link.peer) {
      link.peer.machine = name
      link.peer.connected = true
      link.peer.last_error = null
      link.peer.attempt = 0
    }
    const record = records.get(name)
    if (record && record.cert.key !== link.cert!.key) {
      records.delete(name)
      apply({ ...record, endpoints: [] })
    } else if (first && record) apply(record)
    notify(link, "records", { records: [own, ...[...records.values()].filter((row) => row.machine !== name)] })
  }

  async function receiveForward(link: Link, params: unknown): Promise<SendResult> {
    const now = Date.now()
    link.forwards = link.forwards.filter((at) => at > now - 60_000)
    if (link.forwards.length >= 600)
      throw new RelayError("rate_limited", "too many mesh forwards", Math.max(1, Math.ceil((link.forwards[0]! + 60_000 - now) / 1000)))
    link.forwards.push(now)
    const policy = hooks.policyError()
    if (policy !== null) throw new RelayError("policy_refused", policy)
    const outer = object(params, "forward")
    if (typeof outer.from !== "string") throw new RelayError("invalid_params", "from must be a string")
    const inner = { ...object(outer.params, "params") }
    const asked = outer.hop_floor === undefined ? 0 : outer.hop_floor
    if (!Number.isInteger(asked) || (asked as number) < 0 || (asked as number) > 1000) throw new RelayError("invalid_params", "hop_floor is a hop count")
    for (const field of SERVER_FIELDS) if (field in inner) throw new RelayError("invalid_params", `${field} is set by the relay, not the sender`)
    delete inner.attachments
    delete inner.wait_s
    const name = link.cert!.machine
    const record = records.get(name)
    const carried = record?.endpoints.some((value) => {
      if (!value || typeof value !== "object") return false
      const view = value as Params
      return typeof view.address === "string" && (view.kind === "human" ? "" : view.address.slice(view.address.lastIndexOf("/") + 1)) === outer.from
    })
    if (!carried) throw new RelayError("not_found", `no endpoint ${name}/${outer.from}`)
    const sender = core.remoteEndpoint(name, outer.from)
    for (const to of Array.isArray(inner.to) ? inner.to : [inner.to]) {
      if (core.foreignAccount(to) !== null || core.route(to) !== null) throw new RelayError("not_found", `no endpoint ${String(to)} on this machine`)
    }
    const floor = Math.min(asked as number, LIMITS.hopMax + 1)
    if (floor > 0) core.markReceived(sender, floor - 1)
    return send(sender, inner as unknown as SendParams, { tty: outer.tty === true })
  }

  async function answer(link: Link, id: string | number, params: unknown) {
    let frame: object
    try {
      frame = { id, result: await receiveForward(link, params) }
    } catch (error) {
      if (!(error instanceof RelayError)) report(error, link.peer)
      const relay = error instanceof RelayError ? error : new RelayError("unavailable", "the mesh forward failed")
      frame = { id, error: { code: -32000, message: relay.message, data: { code: relay.code, retry_after: relay.retryAfterS } } }
    }
    if (stopped || !link.authenticated) return
    try {
      write(link, frame)
    } catch (error) {
      report(error, link.peer)
    }
  }

  function onFrame(link: Link, text: string) {
    const frame = object(JSON.parse(text), "frame")
    if (frame.jsonrpc !== "2.0") return refuse(link, "invalid protocol frame")
    if (!link.authenticated) {
      if (frame.id !== undefined) return refuse(link, "authentication required")
      const params = object(frame.params, "params")
      if (frame.method === "mesh_hello" && !link.cert) {
        if (params.protocol !== PROTOCOL || params.acct !== acct) return refuse(link, "wrong protocol or account")
        if (!verifyCert(params.cert, trust) || params.cert.account !== account) return refuse(link, "invalid certificate")
        if (params.cert.machine === machine) return refuse(link, `the peer is also named ${machine}: give one of them another --machine`)
        if (rival(params.cert.machine, params.cert.key)) return refuse(link, `machine ${params.cert.machine} is already linked with another machine key`)
        if (typeof params.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(params.nonce)) return refuse(link, "invalid nonce")
        if (!validPublicKey(params.kx)) return refuse(link, "invalid key exchange")
        link.cert = params.cert
        link.peerNonce = params.nonce
        link.peerKx = params.kx
        notify(link, "mesh_auth", {
          sig: signPayload(machineKey, SIGN_DOMAIN.auth, {
            acct,
            from: machine,
            to: link.cert.machine,
            peer_nonce: link.peerNonce,
            nonce: link.nonce,
            peer_kx: link.peerKx,
            kx: link.exchange!.public,
            dialed: link.peer !== null,
          }),
        })
        return
      }
      if (frame.method === "mesh_auth" && link.cert) {
        const peer = link.cert.machine
        if (rival(peer, link.cert.key)) return refuse(link, `machine ${peer} is already linked with another machine key`)
        const payload = {
          acct,
          from: peer,
          to: machine,
          peer_nonce: link.nonce,
          nonce: link.peerNonce,
          peer_kx: link.exchange!.public,
          kx: link.peerKx,
          dialed: link.peer === null,
        }
        if (!verifyPayload(link.cert.key, SIGN_DOMAIN.auth, payload, params.sig)) return refuse(link, "invalid authentication")
        const dialer = link.peer ? machine : peer
        const own = { dialer, from_nonce: link.nonce, from_kx: link.exchange!.public }
        const theirs = { dialer, from_nonce: link.peerNonce!, from_kx: link.peerKx! }
        link.channel = openChannel(
          link.exchange!,
          link.peerKx!,
          { acct, from: machine, to: peer, ...own, to_nonce: theirs.from_nonce, to_kx: theirs.from_kx },
          { acct, from: peer, to: machine, ...theirs, to_nonce: own.from_nonce, to_kx: own.from_kx },
        )
        link.exchange = null
        authenticated(link)
        return
      }
      return refuse(link, "authentication required")
    }
    if (frame.method === "records" && frame.id === undefined) {
      const params = object(frame.params, "records")
      if (!Array.isArray(params.records)) return refuse(link, "invalid records")
      const accepted: MachineRecord[] = []
      for (const record of params.records) {
        if (!verifyRecord(record, trust) || record.cert.account !== account || record.machine === machine || rival(record.machine, record.cert.key)) continue
        const previous = records.get(record.machine)
        if (previous && (record.epoch < previous.epoch || (record.epoch === previous.epoch && record.seq <= previous.seq))) continue
        records.set(record.machine, record)
        apply(record)
        accepted.push(record)
      }
      if (accepted.length) broadcast(accepted, link)
    } else if (frame.method === "forward" && (typeof frame.id === "number" || typeof frame.id === "string")) {
      void answer(link, frame.id, frame.params)
    } else if (frame.method === "ping" && frame.id === undefined) {
      return
    } else if (frame.method === undefined && typeof frame.id === "number") {
      const pending = link.pending.get(frame.id)
      if (!pending) return
      let error: RelayError | undefined
      if (frame.error !== undefined) {
        const wire = object(frame.error, "error")
        const data = wire.data === undefined ? {} : object(wire.data, "error data")
        error = new RelayError(
          (typeof data.code === "string" ? data.code : "unavailable") as RelayError["code"],
          typeof wire.message === "string" ? wire.message : "the mesh forward failed",
          typeof data.retry_after === "number" ? data.retry_after : undefined,
        )
      }
      clearTimeout(pending.timer)
      link.pending.delete(frame.id)
      if (error) pending.reject(error)
      else pending.resolve(frame.result as SendResult)
    } else {
      refuse(link, "unexpected frame")
    }
  }

  function attach(socket: WebSocket, peer: Peer | null): Link {
    let finish!: () => void
    const link: Link = {
      socket,
      peer,
      cert: null,
      nonce: newNonce(),
      peerNonce: null,
      exchange: newExchange(),
      peerKx: null,
      channel: null,
      authenticated: false,
      order: 0,
      since: new Date().toISOString(),
      received: Date.now(),
      forwards: [],
      pending: new Map(),
      authTimer: setTimeout(() => refuse(link, "authentication timed out"), 10_000),
      closed: new Promise<void>((resolve) => {
        finish = resolve
      }),
    }
    links.add(link)
    const hello = () => notify(link, "mesh_hello", { protocol: PROTOCOL, acct, cert, nonce: link.nonce, kx: link.exchange!.public })
    socket.on("open", hello)
    socket.on("message", (data, binary) => {
      if (stopped || socket.readyState !== WebSocket.OPEN) return
      link.received = Date.now()
      if (binary !== !!link.channel) return refuse(link, link.channel ? "sealed frames required" : "text frames required")
      let text: string
      try {
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        text = link.channel ? link.channel.open(bytes) : bytes.toString("utf8")
      } catch {
        return refuse(link, "invalid sealed frame")
      }
      if (Buffer.byteLength(text) > MESH_FRAME_BYTES) return refuse(link, "frame too large")
      try {
        onFrame(link, text)
      } catch (error) {
        report(error, peer)
        close(link, 1008, "invalid frame")
      }
    })
    socket.on("error", (error) => report(error, peer))
    socket.on("close", (code, reason) => {
      deactivate(link)
      clearTimeout(link.closeTimer)
      links.delete(link)
      if (!stopped) report(`link closed (${code}${reason.length ? ` ${reason.toString()}` : ""})`, peer)
      if (peer?.link === link) {
        delete peer.link
        retry(peer)
      }
      finish()
    })
    if (socket.readyState === WebSocket.OPEN) hello()
    return link
  }

  function retry(peer: Peer) {
    if (stopped || peers.get(peer.addr) !== peer) return
    const base = Math.min(maxMs, minMs * 2 ** Math.min(peer.attempt++, 16))
    peer.timer = setTimeout(() => dial(peer), base / 2 + (Math.random() * base) / 2)
  }

  function dial(peer: Peer) {
    delete peer.timer
    if (stopped || peers.get(peer.addr) !== peer) return
    try {
      const { host, port } = parseHostPort(peer.addr)
      peer.link = attach(new WebSocket(`ws://${hostPort(host, port)}${MESH_PATH}`, { maxPayload: MESH_FRAME_BYTES + SEAL_TAG_BYTES }), peer)
    } catch (error) {
      report(error, peer)
      retry(peer)
    }
  }

  /** dials now every peer that waits for a retry */
  function relink() {
    for (const peer of peers.values()) {
      if (peer.timer === undefined) continue
      clearTimeout(peer.timer)
      peer.attempt = 0
      dial(peer)
    }
  }

  function configure(addresses: string[]) {
    const wanted = new Set(addresses)
    for (const [addr, peer] of peers) {
      if (wanted.has(addr)) continue
      peers.delete(addr)
      clearTimeout(peer.timer)
      if (peer.link) close(peer.link, 1000, "peer removed")
    }
    for (const addr of wanted) {
      if (peers.has(addr)) continue
      const peer: Peer = { addr, machine: null, connected: false, last_error: null, attempt: 0 }
      peers.set(addr, peer)
      dial(peer)
    }
  }

  const listening = new Promise<{ host: string; port: number } | null>((resolve, reject) => {
    if (!options.config.listen) return resolve(null)
    try {
      const { host, port } = parseHostPort(options.config.listen, { listen: true })
      server = new WebSocketServer({ host, port, path: MESH_PATH, maxPayload: MESH_FRAME_BYTES + SEAL_TAG_BYTES })
      server.on("listening", () => {
        const address = server!.address()
        if (!address || typeof address === "string") return reject(new Error("no mesh listener address"))
        bound = { host: address.address, port: address.port }
        resolve(bound)
      })
      server.on("error", (error) => {
        report(error)
        reject(error)
      })
      server.on("connection", (socket) => {
        let pending = 0
        for (const link of links) if (!link.peer && !link.authenticated) pending++
        if (pending >= PENDING_INBOUND) {
          socket.on("error", () => {})
          return socket.close(1013, "too many links authenticating")
        }
        const link = attach(socket, null)
        if (stopped) close(link, 1000, "mesh stopped")
      })
    } catch (error) {
      report(error)
      reject(error)
    }
  })
  void listening.catch(() => {})
  configure(options.config.peers)
  const reloadTimer = setInterval(() => {
    if (stopped) return
    try {
      const config = options.reloadConfig?.()
      if (config) configure(config.peers)
    } catch (error) {
      report(error)
    }
  }, options.reloadMs ?? 5000)
  const heartbeatTimer = setInterval(() => {
    for (const link of links) {
      if (!link.authenticated) continue
      if (Date.now() - link.received >= 3 * heartbeatMs) close(link, 1000, "heartbeat timed out")
      else notify(link, "ping", {})
    }
  }, heartbeatMs)

  function request(link: Link, params: object): Promise<SendResult> {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id)
        reject(new RelayError("unavailable", "the mesh forward timed out"))
      }, options.forwardTimeoutMs ?? 30_000)
      link.pending.set(id, { resolve, reject, timer })
      try {
        write(link, { id, method: "forward", params })
      } catch (error) {
        clearTimeout(timer)
        link.pending.delete(id)
        reject(error)
      }
    })
  }

  /** a delivery the peer reported, in this machine's addresses and endpoint ids */
  function localDelivery(name: string, delivery: SendResult["deliveries"][number]): SendResult["deliveries"][number] {
    try {
      const endpoint = core.remoteEndpoint(name, delivery.address.slice(delivery.address.lastIndexOf("/") + 1))
      return { ...delivery, endpoint, address: core.addressOf(endpoint) }
    } catch {
      return delivery
    }
  }

  async function forward(from: string, params: SendParams, origin: { tty?: boolean } = {}): Promise<SendResult> {
    const sender = core.addressOf(from)
    const targets = Array.isArray(params.to) ? params.to : [params.to]
    if (targets.some((to) => core.foreignAccount(to) !== null)) throw new RelayError("not_found", "the mesh reaches only this account's machines")
    const routes = targets.map((to) => core.route(to))
    const name = routes[0]?.split("/")[0]
    if (!name || routes.some((route) => !route || route.split("/")[0] !== name))
      throw new RelayError("invalid_params", "a message goes to one other machine at a time; send it once per machine")
    for (const to of targets) {
      core.scopeCheck(from, to, typeof params.reply_to === "string" ? params.reply_to : undefined)
      const refusal = core.checkPolicy(sender, String(to))
      if (refusal) throw new RelayError("policy_refused", `${refusal} (${String(to)})`)
    }
    if (typeof params.body !== "string") throw new RelayError("invalid_params", "body must be a string")
    if (params.data_class === "private") throw new RelayError("data_class_refused", "a private message stays on this machine")
    const secret = findSecret(params.body) ?? (params.attachments ?? []).map((a) => findSecret(String(a?.path))).find(Boolean) ?? null
    if (secret) throw new RelayError("secret_refused", `the message looks like it carries a credential (${secret}); send a reference instead`)
    const earlier = core.forwarded(from, params)
    if (earlier) return earlier
    const view = core.whoami(from)
    const handle = mirrored(view) ? (view.kind === "human" ? "" : view.address.slice(view.address.lastIndexOf("/") + 1)) : null
    if (handle === null) throw new RelayError("policy_refused", `${sender} is not mirrored to the mesh, so it can't message other machines`)
    const link = linked(name)
    if (!link) throw new RelayError("unavailable", `machine ${name} is not linked to this one over the mesh`, 5)
    clearTimeout(rebuildTimer)
    rebuild()
    const clientId = params.client_id ?? newId("fwd")
    const sent: SendParams = { ...params, client_id: clientId, to: routes as string[] }
    delete (sent as { wait_s?: unknown }).wait_s
    delete sent.attachments
    const answered = await request(link, {
      from: handle,
      params: sent,
      hop_floor: core.causalHop(from),
      ...(origin.tty === undefined ? {} : { tty: origin.tty }),
    })
    const result: SendResult = { ...answered, deliveries: answered.deliveries.map((delivery) => localDelivery(name, delivery)) }
    core.recordForward(from, { ...params, client_id: clientId }, result, origin)
    if (!result.duplicate)
      core.recordRemoteDelivery(
        result.id,
        result.deliveries.map((delivery) => delivery.endpoint),
      )
    return result
  }

  function status(): MeshStatus {
    const live = [...links].filter((link) => link.authenticated)
    return {
      enabled: true,
      machine,
      url: "mesh",
      connected: live.length > 0,
      last_error: lastError,
      since,
      mesh: {
        account,
        acct,
        listen: bound ? hostPort(bound.host, bound.port) : null,
        peers: [...peers.values()].map(({ addr, machine, connected, last_error }) => ({ addr, machine, connected, last_error })),
        links: live.map((link) => ({ machine: link.cert!.machine, inbound: link.peer === null, addr: link.peer?.addr ?? null, since: link.since })),
        machines: [...records.values()].map((record) => ({
          machine: record.machine,
          epoch: record.epoch,
          seq: record.seq,
          endpoints: record.endpoints.length,
          linked: !!linked(record.machine),
        })),
      },
    }
  }

  function stop(): Promise<void> {
    if (stopping) return stopping
    stopped = true
    clearTimeout(rebuildTimer)
    clearInterval(reloadTimer)
    clearInterval(heartbeatTimer)
    for (const peer of peers.values()) clearTimeout(peer.timer)
    const closing = [...links]
    for (const link of closing) close(link, 1000, "mesh stopped")
    stopping = (async () => {
      await Promise.all(closing.map((link) => link.closed))
      await listening.catch(() => {})
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
      bound = null
    })()
    return stopping
  }

  return {
    forward,
    changed: schedule,
    resync: schedule,
    renamed: (endpoint, was) => {
      if (!renames.has(endpoint)) renames.set(endpoint, was)
      schedule()
    },
    activity: () => {},
    relink,
    status,
    stop,
    listening: () => listening,
    contacts: async () => {
      throw new RelayError("unavailable", "the mesh links only this account's machines; contacts need a hub")
    },
  }
}
