import { LIMITS, RelayError, sha256Hex, type Sql, type SqlValue, stripControl } from "@scp-dev/core";
import { GRAPH_MINUTES, type HubConn, type HubLimits, type HubSocket, RelayHub } from "@scp-dev/hub";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { DASH_HEADER, GRANT_HEADER, grantValid, ORG_HEADER, parseGrant } from "./grant";
import { JUDGE_HEADER, judgeSetup } from "./judge";

export const HUB_TAG = "hub";
/** a dashboard's read-only event stream; its attachment names the member who opened it */
export const DASH_TAG = "dash";
const ORG_KEY = "hub:org";
const JUDGE_KEY = "hub:judge";
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

function relayError(e: unknown): Response {
  if (!(e instanceof RelayError)) throw e;
  return error(e.code === "not_found" ? 404 : e.code === "invalid_params" ? 400 : 409, e.code, e.message);
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

/**
 * One org's hub (`idFromName("hub:" + orgId)`): its machines, endpoints and deliveries in SQLite, its sockets
 * hibernating. Only the Worker reaches it, with the grant and org handle in internal headers.
 */
export class OrgHub extends DurableObject<Env> {
  private readonly hub: RelayHub;
  private org: string | null = null;
  /** the org's judge flag as stored, loaded once */
  private judgeOn: boolean | null = null;
  /** the flag the hub's judge is configured for */
  private judging: boolean | null = null;

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
      fetch: (url, init) => fetch(url, init),
      limits: NO_LIMITS,
      dashboard: (event) => {
        const text = JSON.stringify(event);
        for (const ws of ctx.getWebSockets(DASH_TAG)) {
          try {
            ws.send(text);
          } catch {}
        }
      },
    });
  }

  /** inits the hub with the stored org handle; false when the object never served a request */
  private async ready(): Promise<boolean> {
    this.org ??= (await this.ctx.storage.get<string>(ORG_KEY)) ?? null;
    if (!this.org) return false;
    this.hub.init({ user: this.org });
    await this.judge();
    return true;
  }

  /** configures the hub's judge for the org's flag (`on` when given, stored); only with a model and key in the env does it judge */
  private async judge(on?: boolean): Promise<void> {
    this.judgeOn ??= (await this.ctx.storage.get<boolean>(JUDGE_KEY)) ?? false;
    if (on !== undefined && on !== this.judgeOn) {
      await this.ctx.storage.put(JUDGE_KEY, on);
      this.judgeOn = on;
    }
    if (this.judging === this.judgeOn) return;
    this.judging = this.judgeOn;
    const setup = this.judgeOn ? judgeSetup(this.env) : null;
    this.hub.configureJudge(setup?.policy, setup?.options);
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
      let shut = 0;
      if (match.actorId)
        for (const ws of this.ctx.getWebSockets(DASH_TAG)) {
          if ((ws.deserializeAttachment() as { dash?: string } | null)?.dash !== match.actorId) continue;
          ws.close(4003, "membership ended");
          shut++;
        }
      if (!(await this.ready())) return Response.json({ closed: shut });
      const closed = this.hub.revoke(match) + shut;
      await this.arm();
      return Response.json({ closed });
    }
    if (request.method === "POST" && url.pathname === "/judge") {
      const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
      if (typeof body?.enabled !== "boolean") return error(400, "invalid_request", "enabled is true or false.");
      await this.judge(body.enabled);
      return Response.json({ enabled: body.enabled, configured: judgeSetup(this.env) !== null });
    }
    if (url.pathname === "/holds" || url.pathname.startsWith("/holds/")) return this.holdRoute(request, url);
    if (request.method === "GET" && url.pathname === "/overview") {
      if (!(await this.ready())) return Response.json({ machines: [], endpoints: [], activity: [] });
      return Response.json(this.hub.overview());
    }
    if (request.method === "GET" && url.pathname === "/dash") {
      const user = request.headers.get(DASH_HEADER);
      if (!user) return error(403, "invalid_grant", "Name the member.");
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return error(426, "upgrade_required", "The event stream is a WebSocket.");
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [DASH_TAG]);
      server.serializeAttachment({ dash: user });
      server.send(JSON.stringify({ type: "hello", at: new Date().toISOString() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method === "GET" && url.pathname === "/graph") {
      const minutes = Number(url.searchParams.get("minutes") ?? GRAPH_MINUTES);
      if (!(await this.ready())) return Response.json({ minutes: GRAPH_MINUTES, machines: [], nodes: [], edges: [] });
      return Response.json(this.hub.graph(minutes));
    }
    const route =
      url.pathname === "/ws" && request.method === "GET"
        ? "ws"
        : url.pathname === "/rpc" && request.method === "POST"
          ? "rpc"
          : url.pathname === "/mcp"
            ? "mcp"
            : null;
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
    const judged = request.headers.get(JUDGE_HEADER);
    await this.judge(judged === "1" ? true : judged === "0" ? false : undefined);
    if (route === "ws") {
      if (this.hub.full()) return error(429, "too_many_sockets", "This org has too many hub connections open.");
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [HUB_TAG]);
      server.serializeAttachment(RelayHub.connection(grant));
      await this.arm();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (route === "mcp") {
      const client = request.headers.get("x-scp-hub-client") ?? "";
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(client)) return error(400, "invalid_client", "Invalid client label.");
      let body: unknown = null;
      if (request.method !== "GET" && request.method !== "HEAD") {
        const reader = request.body?.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        let raw = "";
        if (reader) {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 1_048_576) {
              await reader.cancel();
              return error(413, "body_too_large", "Request body is too large.");
            }
            raw += decoder.decode(chunk.value, { stream: true });
          }
          raw += decoder.decode();
        }
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            return error(400, "invalid_json", "Invalid JSON.");
          }
        }
      }
      const result = await this.hub.mcp(grant, { method: request.method, session: request.headers.get("mcp-session-id"), client, body });
      const headers = new Headers(result.headers);
      if (result.body !== null) headers.set("content-type", "application/json");
      await this.arm();
      return new Response(result.body === null ? null : JSON.stringify(result.body), { status: result.status, headers });
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
    if (this.ctx.getTags(ws).includes(DASH_TAG)) {
      if (message === "ping") ws.send("pong");
      return;
    }
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
      this.judgeOn = null;
      this.hub.reset();
      return;
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  /** GET /holds, POST /holds/release {id, by} and POST /holds/refuse {id, reason, by}: the dashboard's review of held messages */
  private async holdRoute(request: Request, url: URL): Promise<Response> {
    const ready = await this.ready();
    if (request.method === "GET" && url.pathname === "/holds") {
      if (!ready || !this.judgeOn) return Response.json({ holds: [] });
      try {
        return Response.json({ holds: this.hub.holds(url.searchParams.get("state") ?? undefined) });
      } catch (e) {
        return relayError(e);
      }
    }
    if (request.method !== "POST") return error(404, "not_found", "Not found.");
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const id = text(body?.id, 128);
    const by = text(body?.by, 254);
    if (!id || !by) return error(400, "invalid_request", "Name the hold's id and who reviewed it.");
    if (!ready) return error(404, "not_found", `No held message ${id}.`);
    try {
      if (url.pathname === "/holds/release") {
        const result = await this.hub.holdRelease(id, { by });
        await this.arm();
        return Response.json(result);
      }
      if (url.pathname === "/holds/refuse") {
        const reason = text(body?.reason, LIMITS.noteChars);
        if (!reason) return error(400, "invalid_request", `Give a reason of at most ${LIMITS.noteChars} characters.`);
        const hold = this.hub.holdRefuse(id, stripControl(reason), by);
        await this.arm();
        return Response.json(hold);
      }
    } catch (e) {
      return relayError(e);
    }
    return error(404, "not_found", "Not found.");
  }

  private async arm(next = this.hub.nextAlarm()): Promise<void> {
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || next < current) await this.ctx.storage.setAlarm(next);
  }
}
