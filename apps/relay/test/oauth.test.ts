import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { grantValid } from "../src/hub/grant";
import { connectorLabel, sha256 } from "../src/util";
import { bearer, Browser, type Relay, startRelay } from "./harness";

let relay: Relay;
let browser: Browser;
let clientId: string;
const redirect = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(64);
const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");

function authorizePath(changes: Record<string, string | null> = {}): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: "scp.relay",
    state: "return-state",
    resource: `${relay.origin}/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  for (const [key, value] of Object.entries(changes)) value === null ? query.delete(key) : query.set(key, value);
  return `/authorize?${query}`;
}

function handle(): string {
  const value = /name="handle" value="([^"]+)"/.exec(browser.last)?.[1];
  if (!value) throw new Error("Missing consent handle");
  return value;
}

async function exchange(fields: Record<string, string>): Promise<Response> {
  return relay.fetch("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, resource: `${relay.origin}/mcp`, ...fields }),
  });
}

async function connect(org = "connectors"): Promise<{ access_token: string; refresh_token: string }> {
  expect((await browser.get(authorizePath())).status).toBe(200);
  const consent = await browser.post("/authorize", { handle: handle(), org, decision: "allow" });
  expect(consent.status).toBe(302);
  const callback = new URL(consent.headers.get("location")!);
  expect(callback.searchParams.get("iss")).toBe(relay.origin);
  expect(callback.searchParams.get("state")).toBe("return-state");
  const token = await exchange({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: redirect, code_verifier: verifier });
  expect(token.status).toBe(200);
  const result = (await token.json()) as { access_token: string; refresh_token: string; expires_in: number };
  expect(result.expires_in).toBe(3600);
  return result;
}

async function mcp(
  token: string,
  body: unknown = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  },
  session?: string,
): Promise<Response> {
  return relay.fetch("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(session ? { "mcp-session-id": session } : {}),
      "x-scp-hub-client": "forged",
      "x-scp-hub-grant": "forged",
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  relay = await startRelay({
    outbound: async (request) => {
      if (new URL(request.url).hostname === "metadata.test")
        return Response.json({ client_id: "https://different.test/client", client_name: "Connector", redirect_uris: [redirect] });
      return new Response(null, { status: 404 });
    },
  });
  const db = await relay.mf.getD1Database("DB");
  const now = Date.now();
  await db.prepare("INSERT INTO users VALUES (?, ?, ?)").bind("usr_connector", "connector@example.test", now).run();
  await db
    .prepare("INSERT INTO orgs (id, handle, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind("org_connector", "connectors", "Connectors", "usr_connector", now)
    .run();
  await db.prepare("INSERT INTO memberships VALUES (?, ?, ?, ?)").bind("org_connector", "usr_connector", "owner", now).run();
  await db
    .prepare("INSERT INTO orgs (id, handle, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind("org_connector_b", "connectors-b", "Connectors B", "usr_connector", now)
    .run();
  await db.prepare("INSERT INTO memberships VALUES (?, ?, ?, ?)").bind("org_connector_b", "usr_connector", "owner", now).run();
  await db
    .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)")
    .bind(await sha256("session-test"), "usr_connector", now, now + 86400_000)
    .run();
  browser = new Browser(relay);
  browser.jar.set("__Host-scp_session", "session-test");
  const registered = await relay.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Connector <script>",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { client_id: string; token_endpoint_auth_method: string; client_secret?: string };
  expect(client.token_endpoint_auth_method).toBe("none");
  expect(client.client_secret).toBeUndefined();
  clientId = client.client_id;
}, 30_000);

afterAll(async () => {
  await relay?.dispose();
});

describe("OAuth connector", () => {
  test("discovery advertises canonical resource, PKCE, CIMD and registration", async () => {
    const resource = (await (await relay.fetch("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(resource.resource).toBe(`${relay.origin}/mcp`);
    expect(resource.authorization_servers).toEqual([relay.origin]);
    const server = (await (await relay.fetch("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
    expect(server.registration_endpoint).toBe(`${relay.origin}/oauth/register`);
    expect(server.client_id_metadata_document_supported).toBe(true);
    expect(server.authorization_response_iss_parameter_supported).toBe(true);
    expect(server.revocation_endpoint).toBe(`${relay.origin}/oauth/token`);
    const unauthorized = await relay.fetch("/mcp");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain(`resource_metadata="${relay.origin}/.well-known/oauth-protected-resource/mcp"`);
  });

  test("registration refuses confidential clients", async () => {
    const response = await relay.fetch("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "client_secret_basic" }),
    });
    expect(response.status).toBe(400);
  });

  test("authorization validates PKCE, resource, redirect and CIMD identity", async () => {
    for (const changes of [
      { code_challenge: null },
      { code_challenge_method: "plain" },
      { resource: "https://other.test/mcp" },
      { redirect_uri: "https://other.test/callback" },
      { client_id: "https://metadata.test/client" },
    ]) {
      const response = await browser.get(authorizePath(changes));
      expect(response.status === 400 || (response.status === 303 && response.headers.get("location")?.includes("error="))).toBe(true);
    }
  });

  test("sign-in preserves authorize query and rejects foreign next origins", async () => {
    const signedOut = await relay.fetch(authorizePath());
    expect(signedOut.headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent(authorizePath())}`);
    const response = await browser.get("/sign-in?next=https://other.test/authorize");
    expect(response.headers.get("location")).toBe("/orgs");
  });

  test("consent escapes metadata, forbids framing and checks session CSRF and membership", async () => {
    const page = await browser.get(authorizePath());
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(browser.last).toContain("Connector &lt;script&gt;");
    expect(browser.last).toContain("claude.ai");
    const fields = { handle: handle(), org: "connectors", decision: "allow" };
    expect((await browser.post("/authorize", fields, { csrf: null })).status).toBe(403);
    expect((await browser.post("/authorize", fields, { csrf: "wrong" })).status).toBe(403);
    expect((await browser.post("/authorize", { ...fields, org: "outside" })).status).toBe(403);
  });

  test("deny returns access_denied with issuer", async () => {
    await browser.get(authorizePath());
    const result = await browser.post("/authorize", { handle: handle(), decision: "deny" });
    const url = new URL(result.headers.get("location")!);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("iss")).toBe(relay.origin);
  });

  test("code flow reaches hub, rotates refresh, restricts relay API and revokes", async () => {
    const tokens = await connect();
    const init = await mcp(tokens.access_token);
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } });
    const session = init.headers.get("mcp-session-id")!;
    const joined = await mcp(
      tokens.access_token,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "relay_join", arguments: { name: "main" } } },
      session,
    );
    expect(joined.status).toBe(200);
    const overview = await browser.get("/orgs/connectors/sessions");
    expect(await overview.text()).toContain("claude-ai-");
    const forbidden = await relay.fetch("/v1/relay/rpc", { method: "POST", ...bearer(tokens.access_token), body: "{}" });
    expect(forbidden.status).toBe(401);
    const next = await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(next.status).toBe(200);
    const rotated = (await next.json()) as { refresh_token: string };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    const newest = await exchange({ grant_type: "refresh_token", refresh_token: rotated.refresh_token });
    expect(newest.status).toBe(200);
    expect((await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status).toBe(400);
    await browser.get("/orgs/connectors/tokens");
    const path = /action="([^"]*\/connectors\/[^"]+\/revoke)"/.exec(browser.last)?.[1];
    expect(path).toBeDefined();
    expect((await browser.post(path!, { user_id: "usr_connector" })).status).toBe(303);
    expect((await mcp(tokens.access_token)).status).toBe(401);
  });

  test("API and device credentials reach MCP with the external client label", async () => {
    const db = await relay.mf.getD1Database("DB");
    for (const kind of ["token", "device"]) {
      const secret = kind === "token" ? "scp_t_external_test" : "scp_d_external_test";
      const sql =
        kind === "token"
          ? "INSERT INTO api_tokens (id, token_hash, prefix, last4, name, org_id, created_by, created_at) VALUES (?, ?, 'scp_t_', 'test', 'external', 'org_connector', 'usr_connector', ?)"
          : "INSERT INTO device_credentials (id, token_hash, prefix, last4, label, org_id, user_id, created_at) VALUES (?, ?, 'scp_d_', 'test', 'external', 'org_connector', 'usr_connector', ?)";
      await db
        .prepare(sql)
        .bind(`cred_${kind}`, await sha256(secret), Date.now())
        .run();
      const init = await mcp(secret);
      expect(init.status).toBe(200);
      const joined = await mcp(
        secret,
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "relay_join", arguments: { name: "main" } } },
        init.headers.get("mcp-session-id")!,
      );
      expect(joined.status).toBe(200);
      expect(await (await browser.get("/orgs/connectors/sessions")).text()).toContain("mcp-remote-");
    }
  });

  test("consent to another org keeps the first org's grant and consent to the same org replaces it", async () => {
    const first = await connect();
    const other = await connect("connectors-b");
    expect((await mcp(first.access_token)).status).toBe(200);
    expect((await mcp(other.access_token)).status).toBe(200);
    const again = await connect();
    expect((await mcp(first.access_token)).status).toBe(401);
    expect((await mcp(other.access_token)).status).toBe(200);
    expect((await mcp(again.access_token)).status).toBe(200);
  });

  test("removed members lose OAuth access", async () => {
    const tokens = await connect();
    const db = await relay.mf.getD1Database("DB");
    await db.prepare("DELETE FROM memberships WHERE user_id = 'usr_connector'").run();
    expect((await mcp(tokens.access_token)).status).toBe(401);
    await db.prepare("INSERT INTO memberships VALUES ('org_connector', 'usr_connector', 'owner', ?)").bind(Date.now()).run();
  });

  test("connector visibility and revocation follow org roles", async () => {
    const db = await relay.mf.getD1Database("DB");
    const now = Date.now();
    await db.prepare("INSERT INTO users VALUES ('usr_member', 'member@example.test', ?)").bind(now).run();
    await db.prepare("INSERT INTO memberships VALUES ('org_connector', 'usr_member', 'member', ?)").bind(now).run();
    await db
      .prepare("INSERT INTO sessions VALUES (?, 'usr_member', ?, ?)")
      .bind(await sha256("member-session"), now, now + 86400_000)
      .run();
    const member = new Browser(relay);
    member.jar.set("__Host-scp_session", "member-session");
    await member.get(authorizePath());
    const memberHandle = /name="handle" value="([^"]+)"/.exec(member.last)![1]!;
    expect((await member.post("/authorize", { handle: memberHandle, org: "connectors", decision: "allow" })).status).toBe(302);
    await member.get("/orgs/connectors/tokens");
    expect(member.last).toContain('name="user_id" value="usr_member"');
    expect(member.last).not.toContain('name="user_id" value="usr_connector"');
    await browser.get("/orgs/connectors/tokens");
    expect(browser.last).toContain('name="user_id" value="usr_member"');
    expect(browser.last).toContain('name="user_id" value="usr_connector"');
    const ownerPath = /action="([^"]*\/connectors\/[^"]+\/revoke)"[^>]*><input[^>]*><input type="hidden" name="user_id" value="usr_connector"/.exec(
      browser.last,
    )![1]!;
    expect((await member.post(ownerPath, { user_id: "usr_connector" })).status).toBe(404);
    const memberPath = /action="([^"]*\/connectors\/[^"]+\/revoke)"[^>]*><input[^>]*><input type="hidden" name="user_id" value="usr_member"/.exec(
      browser.last,
    )![1]!;
    expect((await browser.post(memberPath, { user_id: "usr_member" }, { csrf: null })).status).toBe(403);
    expect((await browser.post(memberPath, { user_id: "usr_member" }, { csrf: "wrong" })).status).toBe(403);
    await db.prepare("UPDATE memberships SET role = 'admin' WHERE user_id = 'usr_member'").run();
    await member.get("/orgs/connectors/tokens");
    expect(member.last).toContain('name="user_id" value="usr_connector"');
    expect((await member.post(ownerPath, { user_id: "usr_connector" })).status).toBe(303);
  });

  test("MCP rejects oversized or malformed bodies and accepts an empty DELETE", async () => {
    const token = "scp_t_external_test";
    const init = await mcp(token);
    const session = init.headers.get("mcp-session-id")!;
    const headers = { authorization: `Bearer ${token}`, "mcp-session-id": session };
    const removed = await relay.fetch("/mcp", { method: "DELETE", headers });
    expect(removed.status).toBe(204);
    expect((await relay.fetch("/mcp", { method: "POST", headers, body: "invalid" })).status).toBe(400);
    expect((await relay.fetch("/mcp", { method: "POST", headers, body: "x".repeat(1_048_577) })).status).toBe(413);
  });

  test("OAuth grant revalidation respects its access expiry", async () => {
    const grant = { tokenId: "oauth_stable", userId: "org_connector", actorId: "usr_connector", scoped: true, role: "member" as const, expiresAt: 2000 };
    expect(await grantValid({} as D1Database, grant, 1000)).toBe(true);
    expect(await grantValid({} as D1Database, grant, 2000)).toBe(false);
  });

  test("redirect hosts select only known client labels", () => {
    expect(connectorLabel("sub.claude.ai")).toBe("claude-ai");
    expect(connectorLabel("chatgpt.com")).toBe("chatgpt");
    expect(connectorLabel("chat.openai.com")).toBe("chatgpt");
    expect(connectorLabel("claude.ai.other.test")).toBe("mcp-oauth");
  });
});
