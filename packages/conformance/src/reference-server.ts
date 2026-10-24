import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type CrossAccountLink, PASS_GATE, parseLimits, sha256Hex, type Sql, type SqlValue, type XContact } from "@scp-dev/core";
import { HUB_DURATIONS, HUB_LIMITS, type HubGrant, type HubLimits, type HubSocket, type HubWakeOptions, RelayHub } from "@scp-dev/hub";
import type { ServerWebSocket } from "bun";
import type { ContactOp, ContactOptions, MintOptions } from "./targets";

// Admin requests use a random per-target secret in SCP_CONFORMANCE_ADMIN.
// Credentials are hashed in credentials.db; each account has its own hub database.
const { values } = parseArgs({
  options: {
    listen: { type: "string", default: "127.0.0.1:0" },
    dir: { type: "string" },
    limit: { type: "string", multiple: true },
    wake: { type: "string", multiple: true },
    "cors-origin": { type: "string", multiple: true },
  },
});
const limits: Partial<HubLimits> = {
  ...(process.env.SCP_LIMITS !== undefined ? parseLimits(JSON.parse(process.env.SCP_LIMITS), Object.keys(HUB_LIMITS), "SCP_LIMITS", HUB_DURATIONS) : {}),
  ...Object.fromEntries(
    (values.limit ?? []).map((entry) => {
      const [key, raw] = entry.split("=");
      const value = Number(raw);
      if (!key || raw === undefined || Number.isNaN(value) || value < 0) throw new Error("--limit requires name=nonnegative-number");
      return [key, value];
    }),
  ),
};
const wake: Partial<HubWakeOptions> = Object.fromEntries(
  (values.wake ?? []).map((entry) => {
    const [key, raw] = entry.split("=");
    if (!key || raw === undefined) throw new Error("--wake requires name=value");
    return [key, key === "crossAccount" ? raw === "true" : Number(raw)];
  }),
);
if (!values.dir || !process.env.SCP_CONFORMANCE_ADMIN) throw new Error("--dir and SCP_CONFORMANCE_ADMIN are required");
const dir = values.dir;
mkdirSync(dir, { recursive: true });
const credentials = new Database(join(dir, "credentials.db"));
credentials.exec(
  `CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, id TEXT, account TEXT, member TEXT, device INTEGER, name TEXT, role TEXT, revoked INTEGER DEFAULT 0, expires_at INTEGER)`,
);
credentials.exec(`CREATE TABLE IF NOT EXISTS contacts (account TEXT, peer TEXT, state TEXT, config TEXT, PRIMARY KEY (account, peer));
CREATE TABLE IF NOT EXISTS contact_invites (account TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS devices (hash TEXT PRIMARY KEY, user_code TEXT UNIQUE, label TEXT, expires_at INTEGER, last_poll_at INTEGER, state TEXT, account TEXT, member TEXT)`);
type Config = Pick<XContact, "allow" | "dir" | "limits">;
const defaults = (): Config => ({ allow: [{ machine: "*", sel: "tree:root" }], dir: "both", limits: null });
type ContactRow = { account: string; peer: string; state: string; config: string };
const contactRow = (a: string, b: string) => credentials.query("SELECT * FROM contacts WHERE account = ? AND peer = ?").get(a, b) as ContactRow | null;
const saveContact = (a: string, b: string, state: string, config: Config) =>
  credentials.query("INSERT OR REPLACE INTO contacts VALUES (?, ?, ?, ?)").run(a, b, state, JSON.stringify(config));
function changeContact(op: ContactOp, a: string, b: string, opts: ContactOptions) {
  credentials.transaction(() => {
    if (a === b || ![a, b].every((name) => credentials.query("SELECT 1 FROM tokens WHERE account = ?").get(name))) throw new Error("unknown account");
    const here = contactRow(a, b);
    const there = contactRow(b, a);
    const activate = () => {
      for (const name of [a, b]) {
        const n = credentials.query("SELECT COUNT(*) AS n FROM contacts WHERE account = ? AND state = 'active'").get(name) as { n: number };
        if (n.n >= 50) throw new Error("contact capacity");
      }
      saveContact(a, b, "active", defaults());
      saveContact(b, a, "active", defaults());
    };
    switch (op) {
      case "invite":
        if (here?.state === "blocked") break;
        if (here?.state === "pending_in" && there?.state === "pending_out") activate();
        else if (!there) {
          const day = Math.floor(Date.now() / 86400000) * 86400000;
          const n = credentials.query("SELECT COUNT(*) AS n FROM contact_invites WHERE account = ? AND at >= ?").get(a, day) as { n: number };
          if (n.n >= 20) throw new Error("invite capacity");
          credentials.query("DELETE FROM contact_invites WHERE account = ? AND at < ?").run(a, day);
          credentials.query("INSERT INTO contact_invites VALUES (?, ?)").run(a, Date.now());
          saveContact(a, b, "pending_out", { ...defaults(), allow: [] });
          saveContact(b, a, "pending_in", { ...defaults(), allow: [] });
        }
        break;
      case "accept":
        if (here?.state !== "pending_in" || there?.state === "blocked") throw new Error("contact conflict");
        activate();
        break;
      case "decline":
        credentials.query("DELETE FROM contacts WHERE account = ? AND peer = ? AND state = 'pending_in'").run(a, b);
        break;
      case "revoke":
        credentials.query("DELETE FROM contacts WHERE ((account = ? AND peer = ?) OR (account = ? AND peer = ?)) AND state != 'blocked'").run(a, b, b, a);
        break;
      case "block":
        saveContact(a, b, "blocked", { ...defaults(), allow: [] });
        credentials.query("DELETE FROM contacts WHERE account = ? AND peer = ?").run(b, a);
        break;
      case "update": {
        if (here?.state !== "active") throw new Error("contact conflict");
        const config: Config = { ...JSON.parse(here.config), ...opts };
        const machine = (s: string) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(s);
        if (
          config.allow.length > 32 ||
          !["in", "out", "both"].includes(config.dir) ||
          config.allow.some(
            (e) =>
              (e.machine !== "*" && !machine(e.machine)) || (e.sel !== "tree:root" && !/^ep:[a-z0-9][a-z0-9-]{0,31}\/[a-z0-9][a-z0-9._-]{0,62}$/.test(e.sel)),
          ) ||
          Object.values(config.limits ?? {}).some((n) => !Number.isInteger(n) || n < 1 || n > 10000)
        )
          throw new Error("invalid contact config");
        saveContact(a, b, "active", config);
        break;
      }
      default:
        throw new Error("unknown contact action");
    }
  })();
  return { account: a, peer: b, state: contactRow(a, b)?.state ?? null };
}
function linkOf(name: string): CrossAccountLink {
  const contact = (peer: string): XContact | null => {
    const row = contactRow(name, peer);
    return row?.state === "active" ? { peerId: peer, peerHandle: peer, ...JSON.parse(row.config) } : null;
  };
  return {
    self: { id: name, handle: name },
    contactByHandle: async (peer) => contact(peer),
    contactById: async (peer) => contact(peer),
    contacts: async () =>
      (credentials.query("SELECT peer FROM contacts WHERE account = ? AND state = 'active' ORDER BY peer").all(name) as { peer: string }[]).map(
        (row) => contact(row.peer)!,
      ),
    deliver: async (peer, message) => account(peer.peerHandle).hub.xreceive(name, JSON.parse(JSON.stringify(message))),
    list: async (peer) => account(peer.peerHandle).hub.xlist(name),
    gate: PASS_GATE,
  };
}
type Token = {
  hash: string;
  id: string;
  account: string;
  member: string;
  device: number;
  name: string;
  role: "owner" | "member";
  revoked: number;
  expires_at: number | null;
};
type Account = { db: Database; hub: RelayHub; sockets: Map<ServerWebSocket<Data>, HubSocket> };
type Data = { account: string; grant: HubGrant; socket?: HubSocket; dashboard?: boolean; unsubscribe?: () => void };
const dashboardListeners = new Map<string, Set<(event: unknown) => void>>();
function subscribe(name: string, listener: (event: unknown) => void) {
  let listeners = dashboardListeners.get(name);
  if (!listeners) {
    listeners = new Set();
    dashboardListeners.set(name, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const accounts = new Map<string, Account>();
function account(name: string): Account {
  const found = accounts.get(name);
  if (found) return found;
  const db = new Database(join(dir, `${name}.db`));
  const sql: Sql = { all: <T>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as T[] };
  const sockets = new Map<ServerWebSocket<Data>, HubSocket>();
  const hub = new RelayHub({
    sql,
    hash: sha256Hex,
    transaction: (fn) => db.transaction(fn)(),
    sockets: () => [...sockets.values()],
    save: () => {},
    limits,
    crossAccount: linkOf(name),
    fetch: globalThis.fetch,
    wake,
    dashboard: (event) => {
      for (const listener of dashboardListeners.get(name) ?? []) listener(event);
    },
  });
  hub.init({ user: name });
  const state = { db, hub, sockets };
  accounts.set(name, state);
  const alarm = () =>
    hub.alarm(async (grant) => {
      const token = credentials.query("SELECT revoked FROM tokens WHERE id = ?").get(grant.tokenId) as { revoked: number } | null;
      return !!token && !token.revoked;
    });
  const timer = setInterval(() => void alarm(), limits.revalidateMs ?? 300000);
  const expiry = setInterval(() => {
    if ([...sockets.values()].some((socket) => socket.conn.grant.expiresAt <= Date.now())) void alarm();
  }, 100);
  timer.unref();
  expiry.unref();
  return state;
}
function authenticate(request: Request): Token | Response {
  const header = request.headers.get("authorization");
  if (!header) return Response.json({ error: "unauthorized" }, { status: 401 });
  const secret = /^Bearer (\S+)$/.exec(header)?.[1];
  const token = secret ? (credentials.query("SELECT * FROM tokens WHERE hash = ?").get(sha256Hex(secret)) as Token | null) : null;
  if (!token) return Response.json({ error: "invalid" }, { status: 401 });
  if (token.revoked) return Response.json({ error: "revoked" }, { status: 401 });
  if (token.expires_at !== null && token.expires_at <= Date.now()) return Response.json({ error: "expired" }, { status: 401 });
  return token;
}
function grant(token: Token): HubGrant {
  return {
    tokenId: token.id,
    userId: token.account,
    actorId: token.member,
    scoped: !token.device,
    role: token.role,
    expiresAt: token.expires_at ?? Date.now() + 365 * 86400000,
    ...(!token.device ? { labels: { token: token.name } } : {}),
  };
}
function mint(account: string, member: string, opts: MintOptions) {
  const first = credentials.query("SELECT member FROM tokens WHERE account = ? ORDER BY rowid LIMIT 1").get(account) as { member: string } | null;
  const role = !first || first.member === member ? "owner" : "member";
  const id = crypto.randomUUID();
  const token = `${opts.device ? "scp_d_" : "scp_t_"}${crypto.randomUUID().replaceAll("-", "")}`;
  credentials
    .query("INSERT INTO tokens (hash, id, account, member, device, name, role, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      sha256Hex(token),
      id,
      account,
      member,
      Number(!!opts.device),
      opts.name ?? "cli",
      role,
      opts.expiresIn === undefined ? null : Date.now() + opts.expiresIn * 1000,
    );
  return { token, credentialId: id };
}
const [hostname, port] = values.listen!.split(":");
const server = Bun.serve<Data>({
  hostname: hostname!,
  port: Number(port),
  idleTimeout: 65,
  async fetch(request, srv) {
    const path = new URL(request.url).pathname;
    if (["session", "overview", "graph", "events"].some((route) => path === `/v1/dashboard/${route}`)) {
      const headers = new Headers({ "cache-control": "no-store", vary: "origin" });
      const origin = request.headers.get("origin");
      if (origin && values["cors-origin"]?.includes(origin)) {
        headers.set("access-control-allow-origin", origin);
        headers.set("access-control-allow-headers", "authorization, content-type");
        headers.set("access-control-allow-methods", "GET, OPTIONS");
        headers.set("access-control-max-age", "600");
      }
      const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
      const token = authenticate(request);
      if (token instanceof Response) return json({ error: "unauthorized" }, 401);
      const state = account(token.account);
      if (path.endsWith("/session")) {
        const members = credentials.query("SELECT DISTINCT member AS id, member AS name FROM tokens WHERE account = ?").all(token.account);
        const counts = credentials
          .query("SELECT device, COUNT(*) AS n FROM tokens WHERE account = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?) GROUP BY device")
          .all(token.account, Date.now()) as { device: number; n: number }[];
        return json({
          org: { handle: token.account, name: token.account },
          member: { id: token.member, name: token.member, role: token.role },
          members,
          devices: counts.find((c) => c.device)?.n ?? 0,
          tokens: counts.find((c) => !c.device)?.n ?? 0,
          scoped: !token.device,
        });
      }
      const query = new URL(request.url).searchParams;
      const historic = ["1", "true"].includes(query.get("historic") ?? "");
      if (path.endsWith("/overview")) return json(state.hub.overview(20, { historic }));
      if (path.endsWith("/graph")) {
        const raw = query.get("minutes");
        const number = raw === null ? 15 : Number(raw);
        return json(state.hub.graph(Number.isFinite(number) ? Math.min(60, Math.max(1, Math.floor(number))) : 15, { historic }));
      }
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (srv.upgrade(request, { headers, data: { account: token.account, grant: grant(token), dashboard: true } })) return;
        return json({ error: "invalid_request" }, 400);
      }
      headers.set("content-type", "text/event-stream");
      let cleanup = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          const unsubscribe = subscribe(token.account, send);
          const heartbeat = setInterval(() => controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")), 25000);
          const revalidate = setInterval(() => {
            if (authenticate(request) instanceof Response) {
              cleanup();
              controller.close();
            }
          }, limits.revalidateMs ?? 300000);
          cleanup = () => {
            unsubscribe();
            clearInterval(heartbeat);
            clearInterval(revalidate);
          };
          send({ type: "hello", at: new Date().toISOString() });
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(stream, { headers });
    }
    if (path === "/health") return Response.json({ ok: true, service: "scp-relay" });
    if (path === "/_admin" && request.method === "POST") {
      if (request.headers.get("authorization") !== `Bearer ${process.env.SCP_CONFORMANCE_ADMIN}`)
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const body = (await request.json()) as MintOptions &
        ContactOptions & { action: string; op: ContactOp; account: string; peer: string; member: string; credentialId: string; userCode: string };
      if (body.action === "revoke") {
        credentials.query("UPDATE tokens SET revoked = 1 WHERE id = ?").run(body.credentialId);
        return Response.json({ revoked: true });
      }
      if (body.action === "contact") {
        try {
          const opts: ContactOptions = {};
          for (const key of ["allow", "dir", "limits"] as const) if (body[key] !== undefined) Object.assign(opts, { [key]: body[key] });
          const result = changeContact(body.op, body.account, body.peer, opts);
          for (const name of [body.account, body.peer]) await accounts.get(name)?.hub.xprune();
          return Response.json(result);
        } catch {
          return Response.json({ error: "conflict" }, { status: 409 });
        }
      }
      if (body.action === "approve" || body.action === "deny") {
        credentials
          .query("UPDATE devices SET state = ?, account = ?, member = ? WHERE user_code = ? AND state = 'pending' AND expires_at > ?")
          .run(
            body.action === "approve" ? "approved" : "denied",
            body.account ?? null,
            body.member ?? null,
            body.userCode.toUpperCase().replaceAll("-", ""),
            Date.now(),
          );
        return Response.json({ ok: true });
      }
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(body.account)) return Response.json({ error: "invalid" }, { status: 400 });
      return Response.json(mint(body.account, body.member, body));
    }
    if (["/v1/device/code", "/v1/device/token"].includes(path) && request.method === "POST") {
      const error = (code: string) => Response.json({ error: code, error_description: code }, { status: 400 });
      let body: { label?: string; device_code?: string };
      try {
        const text = await request.text();
        if (text && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return error("invalid_request");
        body = text ? JSON.parse(text) : {};
        if (!body || typeof body !== "object" || Array.isArray(body)) return error("invalid_request");
      } catch {
        return error("invalid_request");
      }
      if (path === "/v1/device/code") {
        const label = body.label === undefined || body.label === "" ? "cli" : body.label;
        if (typeof label !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) return error("invalid_request");
        const deviceCode = crypto.randomUUID();
        const user = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
        credentials.query("INSERT INTO devices VALUES (?, ?, ?, ?, NULL, 'pending', NULL, NULL)").run(sha256Hex(deviceCode), user, label, Date.now() + 900000);
        const shown = `${user.slice(0, 4)}-${user.slice(4)}`;
        const uri = `${new URL(request.url).origin}/device`;
        return Response.json({
          device_code: deviceCode,
          user_code: shown,
          verification_uri: uri,
          verification_uri_complete: `${uri}?code=${shown}`,
          expires_in: 900,
          interval: 5,
        });
      }
      const hash = sha256Hex(typeof body.device_code === "string" ? body.device_code : "");
      const code = credentials.query("SELECT * FROM devices WHERE hash = ?").get(hash) as {
        state: string;
        expires_at: number;
        last_poll_at: number | null;
        account: string;
        member: string;
        label: string;
      } | null;
      if (!code || code.state === "redeemed") return error("invalid_grant");
      if (code.state === "denied") return error("access_denied");
      if (code.expires_at <= Date.now()) return error("expired_token");
      const slow = code.last_poll_at !== null && Date.now() - code.last_poll_at < 5000;
      credentials.query("UPDATE devices SET last_poll_at = ? WHERE hash = ?").run(Date.now(), hash);
      if (slow) return error("slow_down");
      if (code.state === "pending") return error("authorization_pending");
      const result = mint(code.account, code.member, { device: true, name: code.label });
      credentials.query("UPDATE devices SET state = 'redeemed' WHERE hash = ?").run(hash);
      return Response.json({
        access_token: result.token,
        token_type: "Bearer",
        credential_id: result.credentialId,
        org: code.account,
        email: null,
        label: code.label,
        relay: new URL(request.url).origin,
      });
    }
    if (!["/mcp", "/v1/whoami", "/v1/relay/ws", "/v1/relay/rpc"].includes(path)) return Response.json({ error: "not_found" }, { status: 404 });
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
        expires_at: token.expires_at === null ? null : new Date(token.expires_at).toISOString(),
      });
    const state = account(token.account);
    if (path === "/mcp") {
      const result = await state.hub.mcp(grant(token), {
        method: request.method,
        session: request.headers.get("mcp-session-id"),
        client: "mcp-remote",
        body: await request.json().catch(() => null),
      });
      return new Response(result.body === null ? null : JSON.stringify(result.body), { status: result.status, headers: result.headers });
    }
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
      if (ws.data.dashboard) {
        ws.send(JSON.stringify({ type: "hello", at: new Date().toISOString() }));
        const unsubscribe = subscribe(ws.data.account, (event) => ws.send(JSON.stringify(event)));
        const timer = setInterval(() => {
          const token = credentials.query("SELECT * FROM tokens WHERE id = ?").get(ws.data.grant.tokenId) as Token | null;
          if (!token || token.revoked || (token.expires_at !== null && token.expires_at <= Date.now())) ws.close(4003, "unauthorized");
        }, limits.revalidateMs ?? 300000);
        ws.data.unsubscribe = () => {
          unsubscribe();
          clearInterval(timer);
        };
        return;
      }
      const socket: HubSocket = {
        conn: RelayHub.connection(ws.data.grant),
        send: (text) => void ws.send(text),
        close: (code, reason) => ws.close(code, reason),
      };
      ws.data.socket = socket;
      account(ws.data.account).sockets.set(ws, socket);
    },
    async message(ws, message) {
      if (ws.data.dashboard) {
        if (String(message) === "ping") ws.send("pong");
        return;
      }
      await account(ws.data.account).hub.message(ws.data.socket!, String(message));
    },
    close(ws) {
      if (ws.data.dashboard) {
        ws.data.unsubscribe?.();
        return;
      }
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
