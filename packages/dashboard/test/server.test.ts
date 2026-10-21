import "./build";
import { afterEach, expect, test } from "bun:test";
import type { Options } from "../src/server";

const token = "scp_t_test_secret_credential";
const deviceToken = "scp_d_test_secret_credential";
const info = {
  org: { handle: "demo", name: "demo" },
  member: { id: "m1", name: "owner", role: "owner" },
  members: [{ id: "m1", name: "owner" }],
  devices: 1,
  tokens: 1,
  scoped: false,
};
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(options: Partial<Options> = {}) {
  let revoked = false;
  let overview401 = false;
  let deviceState = "authorization_pending";
  const calls: { path: string; headers: Headers; body: unknown }[] = [];
  const relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req, server) => {
      const path = new URL(req.url).pathname;
      calls.push({ path: path + new URL(req.url).search, headers: req.headers, body: req.method === "POST" ? await req.json() : null });
      if (path === "/v1/device/code")
        return Response.json({ user_code: "BCDF-GHJK", device_code: "device_secret", expires_in: 900, interval: 5, access_token: deviceToken });
      if (path === "/v1/device/token")
        return deviceState === "ok"
          ? Response.json({ access_token: deviceToken, token_type: "Bearer" })
          : Response.json({ error: deviceState }, { status: 400 });
      if (
        revoked ||
        (![`Bearer ${token}`, `Bearer ${deviceToken}`].includes(req.headers.get("authorization") ?? "") && req.headers.get("x-sso-user") !== "owner")
      )
        return Response.json({ error: "invalid_token", detail: token }, { status: 401 });
      if (path === "/v1/dashboard/session") return Response.json({ ...info, access_token: token });
      if (path === "/v1/dashboard/events") {
        if (server.upgrade(req)) return;
        return new Response("upgrade required", { status: 400 });
      }
      if (overview401) return Response.json({ token }, { status: 401 });
      return Response.json(path.endsWith("overview") ? { machines: [], endpoints: [], activity: [] } : { minutes: 5, machines: [], nodes: [], edges: [] });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ type: "hello", at: "now" }));
      },
      message(ws, message) {
        ws.send(message === "ping" ? "pong" : message);
      },
    },
  });
  cleanup.push(() => {
    relay.stop(true);
  });
  const child = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `
    import {createDashboard} from ${JSON.stringify(new URL("../dist/server.js", import.meta.url).href)};
    const dashboard = createDashboard(${JSON.stringify({ relay: relay.url.origin, revalidateMs: 30, ...options })});
    dashboard.server.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + dashboard.server.address().port));
    process.once("SIGTERM", () => { void dashboard.close(); });
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  cleanup.push(async () => {
    child.kill();
    await child.exited;
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  if (!first.value) throw new Error(await new Response(child.stderr).text());
  const base = new TextDecoder().decode(first.value).trim();
  reader.releaseLock();
  let jar: Record<string, string> = {};
  const responses: string[] = [];
  async function request(path: string, body?: object, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: Object.entries(jar)
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
        ...(body ? { origin: options.publicUrl ?? base, "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(";")[0]!.split("=");
      jar[name!] = value!;
    }
    const text = await response.text();
    responses.push(text + JSON.stringify([...response.headers]));
    return {
      status: response.status,
      headers: response.headers,
      text,
      data: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined,
    };
  }
  async function login() {
    const pre = await request("/v1/dashboard/session");
    expect(pre.data.signedIn).toBe(false);
    expect((await request("/v1/dashboard/sign-in", { token, csrf: pre.data.csrf })).status).toBe(200);
    return (await request("/v1/dashboard/session")).data;
  }
  return {
    base,
    calls,
    request,
    login,
    responses,
    cookie: () =>
      Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    reset: () => {
      jar = {};
    },
    revoke: () => {
      revoked = true;
    },
    failOverview: () => {
      overview401 = true;
    },
    device: (state: string) => {
      deviceState = state;
    },
  };
}

test("token sign-in validates credentials and keeps bearer server side while proxying data", async () => {
  const f = await setup();
  const signed = await f.login();
  expect(signed.org).toEqual(info.org);
  expect(signed.scoped).toBe(false);
  expect(f.cookie()).not.toContain(token);
  expect((await f.request("/v1/dashboard/overview")).data).toEqual({ machines: [], endpoints: [], activity: [] });
  expect((await f.request("/v1/dashboard/graph?minutes=5")).data.minutes).toBe(5);
  expect(f.calls.find((call) => call.path === "/v1/dashboard/overview")?.headers.get("authorization")).toBe(`Bearer ${token}`);
  expect(f.calls.some((call) => call.path === "/v1/dashboard/graph?minutes=5")).toBe(true);
  expect(f.responses.join("\n")).not.toContain(token);
  expect(f.responses.join("\n")).not.toContain(deviceToken);
  expect((await f.request("/v1/dashboard/sign-out", { csrf: signed.csrf })).data).toEqual({ ok: true });
  expect((await f.request("/v1/dashboard/overview")).status).toBe(401);
});

test("Origin, media type and CSRF refusals precede authentication", async () => {
  const f = await setup();
  const pre = await f.request("/v1/dashboard/session");
  const body = { csrf: pre.data.csrf, token };
  for (const origin of ["https://foreign.invalid", "null"]) {
    expect((await f.request("/v1/dashboard/sign-in", body, { origin })).data.error).toBe("bad_origin");
  }
  expect((await f.request("/v1/dashboard/sign-in", body, { "content-type": "text/plain" })).status).toBe(415);
  expect((await f.request("/v1/dashboard/sign-in", { token, csrf: "wrong" })).data.error).toBe("bad_csrf");
  expect((await f.request("/v1/dashboard/sign-in", { token, csrf: "x".repeat(43) })).status).toBe(403);
  expect(f.calls).toHaveLength(0);
  expect((await f.request("/v1/dashboard/sign-in", { ...body, token: "scp_t_invalid" })).status).toBe(401);
  expect(f.responses.join("\n")).not.toContain(token);
  const noOrigin = await fetch(`${f.base}/v1/dashboard/sign-in`, {
    method: "POST",
    headers: { cookie: f.cookie(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(noOrigin.status).toBe(403);
  const sameSite = await fetch(`${f.base}/v1/dashboard/sign-in`, {
    method: "POST",
    headers: { cookie: f.cookie(), "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
  expect(sameSite.status).toBe(200);
});

test("CSRF tokens rotate on sign-in and cannot be replayed from another pre cookie", async () => {
  const f = await setup();
  const pre = (await f.request("/v1/dashboard/session")).data;
  f.reset();
  await f.request("/v1/dashboard/session");
  expect((await f.request("/v1/dashboard/sign-in", { token, csrf: pre.csrf })).status).toBe(403);
  const signed = await f.login();
  expect(signed.csrf).not.toBe(pre.csrf);
  expect((await f.request("/v1/dashboard/sign-out", { csrf: pre.csrf })).status).toBe(403);
});

test("static shell and assets have contract headers, HEAD support, and health needs no relay", async () => {
  const f = await setup();
  expect((await f.request("/health")).data).toEqual({ ok: true });
  for (const path of ["/", "/sign-in", "/device", "/orgs", "/orgs/demo/unknown"]) {
    const res = await f.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(res.text).toContain("<body></body>");
  }
  const asset = await f.request("/app.css?v=anything");
  expect(asset.headers.get("cache-control")).toBe("public, max-age=3600");
  expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
  const head = await fetch(`${f.base}/orgs/demo`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect((await f.request("/missing")).status).toBe(404);
});

test("secure public URL sets host cookies and checks the configured origin", async () => {
  const f = await setup({ publicUrl: "https://dashboard.example.com" });
  const pre = await f.request("/v1/dashboard/session");
  expect(pre.headers.get("set-cookie")).toContain("__Host-scp_pre=");
  expect(pre.headers.get("set-cookie")).toContain("; Secure");
  expect((await f.request("/v1/dashboard/sign-in", { token, csrf: pre.data.csrf })).status).toBe(200);
  expect(f.cookie()).toContain("__Host-scp_session=");
});

test("relay rejection ends sessions both during validation and a proxied data call", async () => {
  const f = await setup();
  await f.login();
  f.failOverview();
  const response = await f.request("/v1/dashboard/overview");
  expect(response.status).toBe(401);
  expect(response.data).toEqual({ error: "signed_out" });
  expect((await f.request("/v1/dashboard/session")).data.signedIn).toBe(false);
  await f.login();
  f.revoke();
  const session = await f.request("/v1/dashboard/session");
  expect(session.data.signedIn).toBe(false);
  expect(session.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(f.responses.join("\n")).not.toContain(token);
});

test("device sign-in binds codes to the browser and hides minted credentials", async () => {
  const f = await setup();
  const { csrf } = (await f.request("/v1/dashboard/session")).data;
  const code = await f.request("/v1/dashboard/device", { csrf });
  expect(code.data).toEqual({ user_code: "BCDF-GHJK", device_code: "device_secret", expires_in: 900, interval: 5 });
  expect((await f.request("/v1/dashboard/device/poll", { csrf, device_code: code.data.device_code })).data).toEqual({ status: "pending" });
  f.device("ok");
  expect((await f.request("/v1/dashboard/device/poll", { csrf, device_code: code.data.device_code })).data).toEqual({ status: "ok" });
  expect((await f.request("/v1/dashboard/session")).data.signedIn).toBe(true);
  expect(f.calls.at(-1)?.headers.get("authorization")).toBe(`Bearer ${deviceToken}`);
  expect(f.responses.join("\n")).not.toContain(deviceToken);
  expect(f.responses.join("\n")).not.toContain(token);
  f.reset();
  const other = (await f.request("/v1/dashboard/session")).data;
  expect((await f.request("/v1/dashboard/device/poll", { csrf: other.csrf, device_code: code.data.device_code })).data.status).toBe("expired");
});

for (const [relayStatus, browserStatus] of [
  ["access_denied", "denied"],
  ["expired_token", "expired"],
  ["slow_down", "pending"],
]) {
  test(`device polling maps ${relayStatus}`, async () => {
    const f = await setup();
    const { csrf } = (await f.request("/v1/dashboard/session")).data;
    const code = (await f.request("/v1/dashboard/device", { csrf })).data;
    f.device(relayStatus!);
    expect((await f.request("/v1/dashboard/device/poll", { csrf, device_code: code.device_code })).data.status).toBe(browserStatus);
  });
}

test("SSO mode forwards only configured headers on every relay request", async () => {
  const f = await setup({ forwardHeaders: ["X-SSO-User"] });
  const headers = { "x-sso-user": "owner", "x-untrusted": "attacker", authorization: `Bearer ${token}` };
  const session = await f.request("/v1/dashboard/session", undefined, headers);
  expect(session.data.signedIn).toBe(true);
  expect((await f.request("/v1/dashboard/overview", undefined, headers)).status).toBe(200);
  for (const call of f.calls) {
    expect(call.headers.get("x-sso-user")).toBe("owner");
    expect(call.headers.has("authorization")).toBe(false);
    expect(call.headers.has("cookie")).toBe(false);
    expect(call.headers.has("x-untrusted")).toBe(false);
  }
  expect((await f.request("/v1/dashboard/session")).data.signedIn).toBe(false);
  expect(f.responses.join("\n")).not.toContain(token);
});

const messages = new WeakMap<WebSocket, { queue: string[]; resolve?: (value: string) => void }>();
async function openSocket(base: string, cookie: string, path = "/orgs/demo/events", origin = base, extra: Record<string, string> = {}) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(base.replace("http", "ws") + path, { headers: { cookie, origin, ...extra } });
    const state: { queue: string[]; resolve?: (value: string) => void } = { queue: [] };
    messages.set(ws, state);
    ws.onmessage = (event) => {
      if (state.resolve) {
        const resolve = state.resolve;
        delete state.resolve;
        resolve(String(event.data));
      } else state.queue.push(String(event.data));
    };
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("upgrade refused"));
  });
}
function nextMessage(ws: WebSocket) {
  const state = messages.get(ws)!;
  return state.queue.length
    ? Promise.resolve(state.queue.shift()!)
    : new Promise<string>((resolve) => {
        state.resolve = resolve;
      });
}

test("events WebSocket proxies hello and ping end to end and closes after revocation", async () => {
  const f = await setup();
  await f.login();
  const ws = await openSocket(f.base, f.cookie());
  expect(JSON.parse(await nextMessage(ws)).type).toBe("hello");
  const pong = nextMessage(ws);
  ws.send("ping");
  expect(await pong).toBe("pong");
  const call = f.calls.find((c) => c.path === "/v1/dashboard/events");
  expect(call?.headers.get("authorization")).toBe(`Bearer ${token}`);
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (event) => resolve(event.code);
  });
  f.revoke();
  expect(await closed).toBe(4003);
});

test("events refuse wrong handles, signed-out browsers and foreign origins", async () => {
  const f = await setup();
  await expect(openSocket(f.base, "")).rejects.toThrow("upgrade refused");
  await f.login();
  await expect(openSocket(f.base, f.cookie(), "/orgs/other/events")).rejects.toThrow("upgrade refused");
  await expect(openSocket(f.base, f.cookie(), "/orgs/demo/events", "https://foreign.invalid")).rejects.toThrow("upgrade refused");
  expect(f.calls.some((c) => c.path === "/v1/dashboard/events")).toBe(false);
});

test("SSO events inject only the configured identity headers", async () => {
  const f = await setup({ forwardHeaders: ["x-sso-user"] });
  await f.request("/v1/dashboard/session", undefined, { "x-sso-user": "owner" });
  const ws = await openSocket(f.base, f.cookie(), "/orgs/demo/events", f.base, { "x-sso-user": "owner", "x-ignore": "no" });
  expect(JSON.parse(await nextMessage(ws)).type).toBe("hello");
  const pong = nextMessage(ws);
  ws.send("ping");
  expect(await pong).toBe("pong");
  const call = f.calls.find((c) => c.path === "/v1/dashboard/events");
  expect(call?.headers.get("x-sso-user")).toBe("owner");
  expect(call?.headers.has("x-ignore")).toBe(false);
  expect(call?.headers.has("cookie")).toBe(false);
  ws.close();
});
