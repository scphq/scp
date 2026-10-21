import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sha256Hex, type Sql, type SqlValue } from "@scp-dev/core";
import { type HubGrant, type HubLimits, type HubSocket, RelayHub } from "@scp-dev/hub";
import type { ServerWebSocket } from "bun";

// Admin requests use a random per-target secret in SCP_CONFORMANCE_ADMIN.
// Credentials are hashed in credentials.db; each account has its own hub database.
const { values } = parseArgs({
  options: { listen: { type: "string", default: "127.0.0.1:0" }, dir: { type: "string" }, limit: { type: "string", multiple: true } },
});
const limits: Partial<HubLimits> = Object.fromEntries(
  (values.limit ?? []).map((entry) => {
    const [key, raw] = entry.split("=");
    const value = Number(raw);
    if (!key || raw === undefined || !Number.isFinite(value) || value <= 0) throw new Error("--limit requires name=positive-number");
    return [key, value];
  }),
);
if (!values.dir || !process.env.SCP_CONFORMANCE_ADMIN) throw new Error("--dir and SCP_CONFORMANCE_ADMIN are required");
const dir = values.dir;
mkdirSync(dir, { recursive: true });
const credentials = new Database(join(dir, "credentials.db"));
credentials.exec(
  `CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, id TEXT, account TEXT, member TEXT, device INTEGER, name TEXT, role TEXT, revoked INTEGER DEFAULT 0)`,
);
type Token = { hash: string; id: string; account: string; member: string; device: number; name: string; role: "owner" | "member"; revoked: number };
type Account = { db: Database; hub: RelayHub; sockets: Map<ServerWebSocket<Data>, HubSocket> };
type Data = { account: string; grant: HubGrant; socket?: HubSocket };
const accounts = new Map<string, Account>();
function account(name: string): Account {
  const found = accounts.get(name);
  if (found) return found;
  const db = new Database(join(dir, `${name}.db`));
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] };
  const sockets = new Map<ServerWebSocket<Data>, HubSocket>();
  const hub = new RelayHub({ sql, hash: sha256Hex, transaction: (fn) => db.transaction(fn)(), sockets: () => [...sockets.values()], save: () => {}, limits });
  hub.init({ user: name });
  const state = { db, hub, sockets };
  accounts.set(name, state);
  const timer = setInterval(() => {
    void hub.alarm(async (grant) => {
      const token = credentials.query("SELECT revoked FROM tokens WHERE id = ?").get(grant.tokenId) as { revoked: number } | null;
      return !!token && !token.revoked;
    });
  }, limits.revalidateMs ?? 300000);
  timer.unref();
  return state;
}
function authenticate(request: Request): Token | Response {
  const header = request.headers.get("authorization");
  if (!header) return Response.json({ error: "unauthorized" }, { status: 401 });
  const secret = /^Bearer (\S+)$/.exec(header)?.[1];
  const token = secret ? (credentials.query("SELECT * FROM tokens WHERE hash = ?").get(sha256Hex(secret)) as Token | null) : null;
  if (!token) return Response.json({ error: "invalid" }, { status: 401 });
  if (token.revoked) return Response.json({ error: "revoked" }, { status: 401 });
  return token;
}
function grant(token: Token): HubGrant {
  return {
    tokenId: token.id,
    userId: token.account,
    actorId: token.member,
    scoped: !token.device,
    role: token.role,
    expiresAt: Date.now() + 365 * 86400000,
    ...(!token.device ? { labels: { token: token.name } } : {}),
  };
}
const [hostname, port] = values.listen!.split(":");
const server = Bun.serve<Data>({
  hostname: hostname!,
  port: Number(port),
  idleTimeout: 65,
  async fetch(request, srv) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ok: true, service: "scp-relay" });
    if (path === "/_admin" && request.method === "POST") {
      if (request.headers.get("authorization") !== `Bearer ${process.env.SCP_CONFORMANCE_ADMIN}`)
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const body = (await request.json()) as { action: string; account: string; member: string; device?: boolean; name?: string; credentialId?: string };
      if (body.action === "revoke") {
        credentials.query("UPDATE tokens SET revoked = 1 WHERE id = ?").run(body.credentialId!);
        return Response.json({ revoked: true });
      }
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(body.account)) return Response.json({ error: "invalid" }, { status: 400 });
      const first = credentials.query("SELECT member FROM tokens WHERE account = ? ORDER BY rowid LIMIT 1").get(body.account) as { member: string } | null;
      const role = !first || first.member === body.member ? "owner" : "member";
      const id = crypto.randomUUID();
      const token = `${body.device ? "scp_d_" : "scp_t_"}${crypto.randomUUID().replaceAll("-", "")}`;
      credentials
        .query("INSERT INTO tokens (hash, id, account, member, device, name, role) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(sha256Hex(token), id, body.account, body.member, Number(!!body.device), body.name ?? "cli", role);
      return Response.json({ token, credentialId: id });
    }
    if (!["/v1/whoami", "/v1/relay/ws", "/v1/relay/rpc"].includes(path)) return Response.json({ error: "not_found" }, { status: 404 });
    const token = authenticate(request);
    if (token instanceof Response) return token;
    if (path === "/v1/whoami")
      return Response.json({
        kind: token.device ? "device" : "token",
        org: token.account,
        email: null,
        role: token.role,
        label: token.name,
        ambient: !token.device,
        endpoint_labels: token.device ? {} : { token: token.name },
        expires_at: null,
      });
    const state = account(token.account);
    if (path === "/v1/relay/ws") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json({ error: "upgrade_required" }, { status: 426 });
      if (state.hub.full()) return Response.json({ error: "too_many_sockets" }, { status: 429 });
      if (srv.upgrade(request, { data: { account: token.account, grant: grant(token) } })) return;
      return Response.json({ error: "upgrade_required" }, { status: 426 });
    }
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    return Response.json(await state.hub.batch(grant(token), body));
  },
  websocket: {
    open(ws) {
      const socket: HubSocket = {
        conn: RelayHub.connection(ws.data.grant),
        send: (text) => void ws.send(text),
        close: (code, reason) => ws.close(code, reason),
      };
      ws.data.socket = socket;
      account(ws.data.account).sockets.set(ws, socket);
    },
    async message(ws, message) {
      await account(ws.data.account).hub.message(ws.data.socket!, String(message));
    },
    close(ws) {
      const state = account(ws.data.account);
      state.sockets.delete(ws);
      state.hub.closed(ws.data.socket!);
    },
  },
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const state of accounts.values()) for (const ws of state.sockets.keys()) ws.close(1001, "shutdown");
  await server.stop(true);
  for (const state of accounts.values()) state.db.close();
  credentials.close();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
console.log(JSON.stringify({ event: "listening", url: `http://${hostname}:${server.port}` }));
