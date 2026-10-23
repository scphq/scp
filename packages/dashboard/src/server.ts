import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

export interface Options {
  relay: string;
  listen?: string;
  publicUrl?: string;
  forwardHeaders?: string[];
  publicDir?: URL;
  revalidateMs?: number;
}
interface Identity {
  org: { handle: string; name: string };
  member: { id: string; name: string; role: string };
  members: { id: string; name: string }[];
  devices: number;
  tokens: number;
  scoped: boolean;
}
interface Session {
  token?: string;
  expires: number;
}
interface Context {
  key: string;
  session: Session | undefined;
  identity: Identity | undefined;
  binding: string;
}
const lifetime = 2592000;
const hash = (value: string): string => createHash("sha256").update(value).digest("base64url");
const random = (): string => randomBytes(32).toString("base64url");
const csp =
  "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const assets: Record<string, string> = {
  "app.css": "text/css",
  "graph.css": "text/css",
  "app.js": "text/javascript",
  "graph.js": "text/javascript",
  "selfhost.js": "text/javascript",
};

function identity(value: Identity): Identity {
  return {
    org: { handle: value.org.handle, name: value.org.name },
    member: { id: value.member.id, name: value.member.name, role: value.member.role },
    members: value.members.map(({ id, name }) => ({ id, name })),
    devices: value.devices,
    tokens: value.tokens,
    scoped: value.scoped,
  };
}
function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? "").split(";").map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    }),
  );
}
function equal(a: unknown, b: string): boolean {
  return typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function parseListen(value = "127.0.0.1:8788"): { host: string; port: number } {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value);
  if (!match || Number(match[2]) > 65535) throw new Error("Expected listen host:port");
  return { host: match[1]!.replace(/^\[|\]$/g, ""), port: Number(match[2]) };
}
export function createDashboard(options: Options) {
  const relay = new URL(options.relay);
  if (!["http:", "https:"].includes(relay.protocol) || relay.username || relay.password || relay.search || relay.hash || relay.pathname !== "/") {
    throw new Error("Expected a relay HTTP(S) origin");
  }
  const publicOrigin = options.publicUrl ? new URL(options.publicUrl).origin : undefined;
  const secure = publicOrigin?.startsWith("https:") ?? false;
  const prefix = secure ? "__Host-" : "";
  const sessionCookie = `${prefix}scp_session`;
  const preCookie = `${prefix}scp_pre`;
  const forward = [...new Set((options.forwardHeaders ?? []).map((name) => name.toLowerCase()))];
  for (const name of forward) {
    if (
      !/^[a-z0-9-]+$/.test(name) ||
      /^(authorization|cookie|host|connection|upgrade|content-length|transfer-encoding|proxy-.*|sec-websocket-.*)$/.test(name)
    ) {
      throw new Error("Forward headers must be identity headers");
    }
  }
  const sso = forward.length > 0;
  const sessions = new Map<string, Session>();
  const devices = new Map<string, { binding: string; expires: number }>();
  const secret = randomBytes(32);
  const csrf = (binding: string): string => createHmac("sha256", secret).update(`csrf:${binding}`).digest("base64url");
  const upstreamHeaders = (req: IncomingMessage, session?: Session): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (sso) {
      for (const name of forward) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
    } else if (session?.token) headers.authorization = `Bearer ${session.token}`;
    return headers;
  };
  const call = (req: IncomingMessage, path: string, session?: Session, body?: object) =>
    fetch(new URL(path, relay), {
      method: body ? "POST" : "GET",
      headers: { ...upstreamHeaders(req, session), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  const setCookie = (res: ServerResponse, name: string, value: string, age = lifetime): void => {
    const existing = res.getHeader("set-cookie");
    const list = Array.isArray(existing) ? existing.map(String) : existing ? [String(existing)] : [];
    res.setHeader("set-cookie", [...list, `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? "; Secure" : ""}`]);
  };
  const endSession = (res: ServerResponse, key: string): void => {
    sessions.delete(key);
    setCookie(res, sessionCookie, "", 0);
  };
  const json = (res: ServerResponse, status: number, body: object): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  const error = (res: ServerResponse, status: number, code: string): void => json(res, status, { error: code, message: code.replaceAll("_", " ") });
  const originOK = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return req.headers["sec-fetch-site"] === "same-origin";
    if (origin === "null") return false;
    return origin === (publicOrigin ?? `${secure ? "https" : "http"}://${req.headers.host}`);
  };
  const context = async (req: IncomingMessage, res: ServerResponse): Promise<Context> => {
    const jar = cookies(req);
    const key = hash(jar[sessionCookie] ?? "");
    let session = sessions.get(key);
    if (session && session.expires <= Date.now()) {
      endSession(res, key);
      session = undefined;
    }
    let info: Identity | undefined;
    if (session || sso) {
      const response = await call(req, "/v1/dashboard/session", session);
      if (response.status === 401) {
        if (session) endSession(res, key);
        session = undefined;
      } else if (!response.ok) throw new Error("Relay unavailable");
      else info = identity((await response.json()) as Identity);
    }
    if (sso && info && !session) {
      const value = random();
      session = { expires: Date.now() + lifetime * 1000 };
      const newKey = hash(value);
      sessions.set(newKey, session);
      setCookie(res, sessionCookie, value);
      return { key: newKey, session, identity: info, binding: `s:${newKey}` };
    }
    let pre = jar[preCookie];
    if (!session && !/^[A-Za-z0-9_-]{43}$/.test(pre ?? "")) {
      pre = random();
      setCookie(res, preCookie, pre);
    }
    return { key, session, identity: info, binding: session ? `s:${key}` : `p:${pre}` };
  };
  const signIn = async (req: IncomingMessage, res: ServerResponse, ctx: Context, token: unknown, device = false): Promise<void> => {
    if (sso || typeof token !== "string" || !/^scp_[td]_[A-Za-z0-9_-]+$/.test(token)) return error(res, 401, "invalid_token");
    const session = { token, expires: Date.now() + lifetime * 1000 };
    const response = await call(req, "/v1/dashboard/session", session);
    if (response.status === 401) return error(res, 401, "invalid_token");
    if (!response.ok) return error(res, 502, "relay_unavailable");
    identity((await response.json()) as Identity);
    sessions.delete(ctx.key);
    const value = random();
    sessions.set(hash(value), session);
    setCookie(res, sessionCookie, value);
    setCookie(res, preCookie, "", 0);
    json(res, 200, device ? { status: "ok" } : { ok: true });
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://dashboard.invalid");
      const path = url.pathname;
      const get = req.method === "GET" || req.method === "HEAD";
      if (get && path === "/health") return json(res, 200, { ok: true });
      const asset = Object.hasOwn(assets, path.slice(1)) ? assets[path.slice(1)] : undefined;
      const shell = ["/", "/sign-in", "/device", "/orgs"].includes(path) || (path.startsWith("/orgs/") && !/^\/orgs\/[^/]+\/events$/.test(path));
      if (get && (asset || shell)) {
        const data = await readFile(new URL(asset ? path.slice(1) : "index.html", options.publicDir ?? new URL("./public/", import.meta.url)));
        res.writeHead(200, {
          "content-type": `${asset ?? "text/html"}; charset=utf-8`,
          "cache-control": asset ? "public, max-age=3600" : "no-store",
          "x-content-type-options": "nosniff",
          ...(!asset ? { "referrer-policy": "same-origin", "x-frame-options": "DENY", "content-security-policy": csp } : {}),
        });
        return res.end(req.method === "HEAD" ? undefined : data);
      }
      const posts = ["sign-in", "device", "device/poll", "sign-out"];
      if (!path.startsWith("/v1/dashboard/") || !(get || (req.method === "POST" && posts.includes(path.slice(14))))) return error(res, 404, "not_found");
      if (req.method === "POST") {
        if (!originOK(req)) return error(res, 403, "bad_origin");
        if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") return error(res, 415, "bad_content_type");
      }
      const ctx = await context(req, res);
      if (get && path === "/v1/dashboard/session") return json(res, 200, { ...ctx.identity, signedIn: !!ctx.identity, csrf: csrf(ctx.binding) });
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16384) return error(res, 413, "body_too_large");
          chunks.push(Buffer.from(chunk));
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
        } catch {
          return error(res, 400, "bad_json");
        }
        if (!equal(body.csrf, csrf(ctx.binding))) return error(res, 403, "bad_csrf");
        if (path.endsWith("/sign-in")) return await signIn(req, res, ctx, body.token);
        if (path.endsWith("/sign-out")) {
          endSession(res, ctx.key);
          return json(res, 200, { ok: true });
        }
        if (sso) return error(res, 403, "sso_required");
        if (path.endsWith("/device")) {
          const response = await call(req, "/v1/device/code", undefined, { label: "dashboard" });
          if (!response.ok) return error(res, 502, "relay_unavailable");
          const data = (await response.json()) as { user_code: string; device_code: string; interval: number; expires_in: number };
          devices.set(hash(data.device_code), { binding: ctx.binding, expires: Date.now() + data.expires_in * 1000 });
          return json(res, 200, { user_code: data.user_code, device_code: data.device_code, interval: data.interval, expires_in: data.expires_in });
        }
        if (path.endsWith("/device/poll")) {
          if (typeof body.device_code !== "string") return error(res, 400, "bad_device_code");
          const key = hash(body.device_code);
          const device = devices.get(key);
          if (!device || device.binding !== ctx.binding || device.expires <= Date.now()) return json(res, 200, { status: "expired" });
          const response = await call(req, "/v1/device/token", undefined, { device_code: body.device_code });
          const data = (await response.json()) as { access_token?: string; error?: string };
          if (response.ok && data.access_token) {
            devices.delete(key);
            // The browser consumes only status, never the minted credential.
            await signIn(req, res, ctx, data.access_token, true);
            return;
          }
          if (["authorization_pending", "slow_down"].includes(data.error ?? "")) return json(res, 200, { status: "pending" });
          if (["access_denied", "expired_token", "invalid_grant"].includes(data.error ?? "")) {
            devices.delete(key);
            return json(res, 200, { status: data.error === "access_denied" ? "denied" : "expired" });
          }
          return error(res, 502, "relay_unavailable");
        }
      }
      if (get && ["/v1/dashboard/overview", "/v1/dashboard/graph"].includes(path)) {
        if (!ctx.identity) return json(res, 401, { error: "signed_out" });
        const historic = url.searchParams.get("historic");
        const query = path.endsWith("/graph") ? url.search : historic === null ? "" : `?${new URLSearchParams({ historic })}`;
        const response = await call(req, path + query, ctx.session);
        if (response.status === 401) {
          endSession(res, ctx.key);
          return json(res, 401, { error: "signed_out" });
        }
        if (!response.ok) return error(res, 502, "relay_unavailable");
        return json(res, 200, (await response.json()) as object);
      }
      error(res, 404, "not_found");
    } catch {
      if (!res.headersSent) error(res, 502, "relay_unavailable");
      else res.end();
    }
  });
  const sockets = new Set<Duplex>();
  server.on("upgrade", async (req, socket, head) => {
    const refuse = (status: number): void => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    try {
      const match = /^\/orgs\/([^/]+)\/events$/.exec(new URL(req.url ?? "/", "http://dashboard.invalid").pathname);
      if (!match) return refuse(404);
      if (!originOK(req)) return refuse(403);
      if (!sessions.has(hash(cookies(req)[sessionCookie] ?? ""))) return refuse(401);
      // Resolve without issuing cookies during an upgrade.
      const res = new ServerResponse(req);
      const ctx = await context(req, res);
      if (!ctx.identity || !ctx.session) return refuse(401);
      if (match[1] !== ctx.identity.org.handle) return refuse(404);
      const headers = upstreamHeaders(req, ctx.session);
      for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      headers.connection = "Upgrade";
      headers.upgrade = "websocket";
      const upstream = (relay.protocol === "https:" ? httpsRequest : httpRequest)(new URL("/v1/dashboard/events", relay), { headers });
      upstream.setTimeout(15000, () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("error", () => {
        if (!socket.destroyed) refuse(502);
      });
      upstream.on("response", (response) => {
        response.resume();
        if (response.statusCode === 401) sessions.delete(ctx.key);
        refuse(response.statusCode === 401 ? 401 : 502);
      });
      upstream.on("upgrade", (response, remote, remoteHead) => {
        upstream.setTimeout(0);
        let reply = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n";
        for (const name of ["sec-websocket-accept", "sec-websocket-protocol"]) {
          if (response.headers[name]) reply += `${name}: ${response.headers[name]}\r\n`;
        }
        socket.write(`${reply}\r\n`);
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        sockets.add(socket);
        sockets.add(remote);
        socket.pipe(remote).pipe(socket);
        const close = (): void => {
          socket.destroy();
          remote.destroy();
        };
        const timer = setInterval(async () => {
          try {
            const current = sessions.get(ctx.key);
            const response = current && current.expires > Date.now() ? await call(req, "/v1/dashboard/session", current) : undefined;
            if (response?.ok) {
              await response.body?.cancel();
              return;
            }
            sessions.delete(ctx.key);
            // Unmasked server close frame, code 4003.
            socket.end(Buffer.from([0x88, 2, 0x0f, 0xa3]));
            remote.destroy();
          } catch {
            close();
          }
        }, options.revalidateMs ?? 30000);
        timer.unref();
        for (const peer of [socket, remote]) {
          peer.on("error", close);
          peer.on("close", () => {
            clearInterval(timer);
            sockets.delete(peer);
            close();
          });
        }
      });
      upstream.end();
    } catch {
      refuse(502);
    }
  });
  const cleanup = setInterval(() => {
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
    for (const [key, device] of devices) if (device.expires <= Date.now()) devices.delete(key);
  }, 60000);
  cleanup.unref();
  server.on("close", () => clearInterval(cleanup));
  return {
    server,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      });
    },
  };
}

declare const DASHBOARD_VERSION: string;
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help")) {
    console.log(
      "Usage: scp-dashboard --relay <url> [--listen 127.0.0.1:8788] [--public-url <url>] [--forward-header <name>]...\nEnvironment: SCP_DASHBOARD_RELAY, SCP_DASHBOARD_LISTEN, SCP_DASHBOARD_PUBLIC_URL, SCP_DASHBOARD_FORWARD_HEADERS\nFlags: --help, --version, --health",
    );
    return;
  }
  if (args.includes("--version")) {
    console.log(DASHBOARD_VERSION);
    return;
  }
  const options: Options = {
    relay: process.env.SCP_DASHBOARD_RELAY ?? "",
    listen: process.env.SCP_DASHBOARD_LISTEN ?? "127.0.0.1:8788",
    forwardHeaders: (process.env.SCP_DASHBOARD_FORWARD_HEADERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ...(process.env.SCP_DASHBOARD_PUBLIC_URL ? { publicUrl: process.env.SCP_DASHBOARD_PUBLIC_URL } : {}),
  };
  let health = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--health") {
      health = true;
      continue;
    }
    if (!["--relay", "--listen", "--public-url", "--forward-header"].includes(arg ?? "") || !args[i + 1] || args[i + 1]!.startsWith("--"))
      throw new Error("Invalid arguments. Use --help.");
    const value = args[++i]!;
    if (arg === "--relay") options.relay = value;
    if (arg === "--listen") options.listen = value;
    if (arg === "--public-url") options.publicUrl = value;
    if (arg === "--forward-header") options.forwardHeaders!.push(value);
  }
  const { host, port } = parseListen(options.listen);
  if (health) {
    const target = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
    const response = await fetch(`http://${target}:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok || ((await response.json()) as { ok?: boolean }).ok !== true) throw new Error("Health check failed");
    return;
  }
  if (!options.relay) throw new Error("--relay or SCP_DASHBOARD_RELAY is required");
  const dashboard = createDashboard(options);
  dashboard.server.listen(port, host, () => console.log(`SCP dashboard listening on ${host}:${port}`));
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void dashboard.close();
    });
}
function isMain(): boolean {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isMain()) {
  main().catch(() => {
    console.error("Dashboard failed. Check arguments and relay availability with --help.");
    process.exitCode = 1;
  });
}
