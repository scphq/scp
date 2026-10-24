import { Database } from "bun:sqlite"
import type { Server, ServerWebSocket } from "bun"
import { type CrossAccountLink, PASS_GATE, sha256Hex, type Sql, type SqlValue, type XContact } from "@scp-dev/core"
import { type DashboardEvent, type HubGrant, type HubLimits, type HubSocket, RelayHub } from "@scp-dev/hub"

export interface FakeToken {
  tokenId: string
  /** the account handle the token acts as */
  user: string
  /** the org member the token belongs to; none is the personal account's owner */
  actor?: string
}

export interface FakeHubServer {
  /** the http origin, as a bridge's url takes it */
  url: string
  hub(account: string): RelayHub
  /** closes every socket of `machine` (code 1012), as a dropped network would */
  drop(account: string, machine: string): void
  /** the next frame calling `method` from `machine` closes its socket instead of reaching the hub; resolves once it did */
  dropOn(account: string, machine: string, method: string): Promise<void>
  /** the open sockets of an account, with their state */
  sockets(account: string): HubSocket[]
  stop(): Promise<void>
}

type Data = { account: string; grant: HubGrant; socket?: HubSocket }

interface Account {
  hub: RelayHub
  sockets: Map<ServerWebSocket<Data>, HubSocket>
  traps: Map<string, { method: string; fired: () => void }>
}

/**
 * a stand-in for a hosted hub's /v1/relay routes: one RelayHub per account over bun:sqlite, bearer credentials from a table; `contacts` pairs
 * account handles that are active contacts both ways (default allowlist: every root), their relays linked directly
 */
export function startFakeHubServer(options: {
  tokens: Record<string, FakeToken>
  limits?: Partial<HubLimits> | undefined
  now?: (() => number) | undefined
  contacts?: [string, string][] | undefined
  /** receives every account's dashboard events */
  dashboard?: ((account: string, event: DashboardEvent) => void) | undefined
}): FakeHubServer {
  const accounts = new Map<string, Account>()

  function linkOf(name: string): CrossAccountLink {
    const peers = () => (options.contacts ?? []).flatMap(([a, b]) => (a === name ? [b] : b === name ? [a] : []))
    const contact = (peer: string): XContact => ({
      peerId: `usr_${peer}`,
      peerHandle: peer,
      allow: [{ machine: "*", sel: "tree:root" }],
      dir: "both",
      limits: null,
    })
    return {
      self: { id: `usr_${name}`, handle: name },
      contactByHandle: async (handle) => (peers().includes(handle) ? contact(handle) : null),
      contactById: async (id) => (id.startsWith("usr_") && peers().includes(id.slice(4)) ? contact(id.slice(4)) : null),
      contacts: async () => peers().map(contact),
      deliver: async (peer, msg) => account(peer.peerHandle).hub.xreceive(`usr_${name}`, JSON.parse(JSON.stringify(msg))),
      list: async (peer) => account(peer.peerHandle).hub.xlist(`usr_${name}`),
      gate: PASS_GATE,
    }
  }

  function account(name: string): Account {
    let found = accounts.get(name)
    if (found) return found
    const db = new Database(":memory:")
    const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] }
    const sockets = new Map<ServerWebSocket<Data>, HubSocket>()
    const hub = new RelayHub({
      sql,
      ...(options.limits ? { limits: options.limits } : {}),
      hash: sha256Hex,
      transaction: (fn) => db.transaction(fn)(),
      ...(options.now ? { now: options.now } : {}),
      sockets: () => [...sockets.values()],
      save: () => {},
      ...(options.contacts ? { crossAccount: linkOf(name) } : {}),
      ...(options.dashboard ? { dashboard: (event: DashboardEvent) => options.dashboard!(name, event) } : {}),
    })
    hub.init({ user: name })
    found = { hub, sockets, traps: new Map() }
    accounts.set(name, found)
    return found
  }

  function grantOf(request: Request): { account: string; grant: HubGrant } | null {
    const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")
    const token = match ? options.tokens[match[1]!] : undefined
    if (!token) return null
    return {
      account: token.user,
      grant: {
        tokenId: token.tokenId,
        userId: `usr_${token.user}`,
        actorId: token.actor ?? null,
        expiresAt: Date.now() + 3_600_000,
        scoped: false,
        role: token.actor ? "member" : null,
      },
    }
  }

  const server: Server<Data> = Bun.serve<Data>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, srv) {
      const path = new URL(request.url).pathname
      if (path !== "/v1/relay/ws" && path !== "/v1/relay/rpc") return Response.json({ error: "not_found" }, { status: 404 })
      const principal = grantOf(request)
      if (!principal) return Response.json({ error: "unauthorized" }, { status: 401 })
      const { hub } = account(principal.account)
      if (path === "/v1/relay/ws") {
        if (hub.full()) return Response.json({ error: "too_many_sockets" }, { status: 429 })
        if (srv.upgrade(request, { data: principal })) return undefined
        return Response.json({ error: "upgrade_required" }, { status: 426 })
      }
      if (request.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 })
      let body: unknown
      try {
        body = JSON.parse(await request.text())
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
      }
      return Response.json(await hub.batch(principal.grant, body))
    },
    websocket: {
      open(ws) {
        const state = account(ws.data.account)
        const socket: HubSocket = {
          conn: RelayHub.connection(ws.data.grant),
          send: (text) => void ws.send(text),
          close: (code, reason) => ws.close(code, reason),
        }
        ws.data.socket = socket
        state.sockets.set(ws, socket)
      },
      async message(ws, message) {
        const state = account(ws.data.account)
        const socket = ws.data.socket!
        const text = typeof message === "string" ? message : new TextDecoder().decode(message)
        const machine = socket.conn.machine
        if (machine && state.traps.size) {
          const method = (JSON.parse(text) as { method?: string }).method
          const trap = state.traps.get(machine)
          if (method && trap?.method === method) {
            state.traps.delete(machine)
            ws.close(1012, "dropped by the test")
            trap.fired()
            return
          }
        }
        await state.hub.message(socket, text)
      },
      close(ws) {
        const state = account(ws.data.account)
        state.sockets.delete(ws)
        if (ws.data.socket) state.hub.closed(ws.data.socket)
      },
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    hub: (name) => account(name).hub,
    drop(name, machine) {
      for (const [ws, socket] of account(name).sockets) if (socket.conn.machine === machine) ws.close(1012, "dropped by the test")
    },
    dropOn(name, machine, method) {
      return new Promise((fired) => account(name).traps.set(machine, { method, fired }))
    },
    sockets: (name) => [...account(name).sockets.values()],
    async stop() {
      await server.stop(true)
    },
  }
}
