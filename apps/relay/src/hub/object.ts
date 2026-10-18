import { sha256Hex, type Sql, type SqlValue } from "@scp-dev/core";
import { type HubConn, type HubLimits, type HubSocket, RelayHub } from "@scp-dev/hub";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { GRANT_HEADER, grantValid, ORG_HEADER, parseGrant } from "./grant";

export const HUB_TAG = "hub";
const ORG_KEY = "hub:org";
const HANDLE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** the demo relay caps nothing; durations stay as the hub sets them */
export const NO_LIMITS: Partial<HubLimits> = {
  machines: Infinity,
  endpoints: Infinity,
  sockets: Infinity,
  frameBytes: Infinity,
  callsPerMinute: Infinity,
  bridgeCallsPerMinute: Infinity,
  accountCallsPerMinute: Infinity,
  acksPerMinute: Infinity,
  accountAcksPerMinute: Infinity,
  storedBytes: Infinity,
  refusalsPerMinute: Infinity,
};

/** each socket's hub view, rebuilt from its attachment once per instance */
const hubSockets = new WeakMap<WebSocket, HubSocket>();
const webSockets = new WeakMap<HubSocket, WebSocket>();

function hubSocketOf(ws: WebSocket): HubSocket | null {
  const known = hubSockets.get(ws);
  if (known) return known;
  let conn: HubConn | null;
  try {
    conn = ws.deserializeAttachment() as HubConn | null;
  } catch {
    return null;
  }
  if (!conn || typeof conn.id !== "string" || !conn.grant) return null;
  const socket: HubSocket = {
    conn,
    send: (text) => ws.send(text),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {}
    },
  };
  hubSockets.set(ws, socket);
  webSockets.set(socket, ws);
  return socket;
}

const error = (status: number, code: string, message: string): Response => Response.json({ error: code, message }, { status });

/**
 * One org's hub (`idFromName("hub:" + orgId)`): its machines, endpoints and deliveries in SQLite, its sockets
 * hibernating. Only the Worker reaches it, with the grant and org handle in internal headers.
 */
export class OrgHub extends DurableObject<Env> {
  private readonly hub: RelayHub;
  private org: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage.sql;
    const sql: Sql = {
      all: <T>(query: string, ...params: SqlValue[]) => storage.exec(query, ...params).toArray() as T[],
    };
    this.hub = new RelayHub({
      sql,
      hash: sha256Hex,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      sockets: () =>
        ctx.getWebSockets(HUB_TAG).flatMap((ws) => {
          const socket = hubSocketOf(ws);
          return socket ? [socket] : [];
        }),
      save: (socket) => webSockets.get(socket)?.serializeAttachment(socket.conn),
      log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
      limits: NO_LIMITS,
    });
  }

  /** inits the hub with the stored org handle; false when the object never served a request */
  private async ready(): Promise<boolean> {
    this.org ??= (await this.ctx.storage.get<string>(ORG_KEY)) ?? null;
    if (!this.org) return false;
    this.hub.init({ user: this.org });
    return true;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/grant/revoke") {
      const body = (await request.json().catch(() => null)) as { tokenId?: unknown; actorId?: unknown } | null;
      const match = {
        ...(typeof body?.tokenId === "string" ? { tokenId: body.tokenId } : {}),
        ...(typeof body?.actorId === "string" ? { actorId: body.actorId } : {}),
      };
      if (!match.tokenId && !match.actorId) return error(400, "invalid_request", "Name a tokenId or an actorId.");
      if (!(await this.ready())) return Response.json({ closed: 0 });
      const closed = this.hub.revoke(match);
      await this.arm();
      return Response.json({ closed });
    }
    if (request.method === "GET" && url.pathname === "/overview") {
      if (!(await this.ready())) return Response.json({ machines: [], endpoints: [], activity: [] });
      return Response.json(this.hub.overview());
    }
    const route = url.pathname === "/ws" && request.method === "GET" ? "ws" : url.pathname === "/rpc" && request.method === "POST" ? "rpc" : null;
    if (!route) return error(404, "not_found", "Not found.");
    const grant = parseGrant(request.headers.get(GRANT_HEADER));
    const org = request.headers.get(ORG_HEADER);
    if (!grant || !org || !HANDLE.test(org)) return error(403, "invalid_grant", "Invalid hub grant.");
    if (route === "ws" && request.headers.get("upgrade")?.toLowerCase() !== "websocket") return error(426, "upgrade_required", "The hub is a WebSocket.");
    this.org ??= (await this.ctx.storage.get<string>(ORG_KEY)) ?? null;
    if (this.org !== org) {
      await this.ctx.storage.put(ORG_KEY, org);
      this.org = org;
    }
    this.hub.init({ user: org });
    if (route === "ws") {
      if (this.hub.full()) return error(429, "too_many_sockets", "This org has too many hub connections open.");
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [HUB_TAG]);
      server.serializeAttachment(RelayHub.connection(grant));
      await this.arm();
      return new Response(null, { status: 101, webSocket: client });
    }
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const result = await this.hub.batch(grant, body);
    await this.arm();
    return Response.json(result);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const socket = hubSocketOf(ws);
    if (!socket || !(await this.ready())) return;
    await this.hub.message(socket, typeof message === "string" ? message : new TextDecoder().decode(message));
    await this.arm();
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const socket = hubSocketOf(ws);
    if (socket && (await this.ready())) this.hub.closed(socket);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {}
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const socket = hubSocketOf(ws);
    if (socket && (await this.ready())) this.hub.closed(socket);
  }

  /** revalidates every socket's grant against D1, sweeps, and deletes the storage of an org idle long enough */
  override async alarm(): Promise<void> {
    if (!(await this.ready())) return;
    const next = await this.hub.alarm((grant) => grantValid(this.env.DB, grant, Date.now()));
    if (this.hub.purgeDue()) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.org = null;
      this.hub.reset();
      return;
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  private async arm(next = this.hub.nextAlarm()): Promise<void> {
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current) await this.ctx.storage.setAlarm(next);
  }
}
