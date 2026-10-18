import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bearer, Browser, codeOf, DUMMY_TOKEN, type Relay, startRelay, TURNSTILE_FAIL } from "./harness";

let relay: Relay;

beforeAll(async () => {
  relay = await startRelay();
}, 30_000);

afterAll(async () => {
  await relay?.dispose();
});

const csrfOf = (page: string): string => /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";

/** the hidden fields of the page's POST form to `action`, as a browser would submit them */
function formOf(page: string, action: string): Record<string, string> {
  const form = new RegExp(`<form[^>]*method="post" action="${action}"[^>]*>([\\s\\S]*?)</form>`).exec(page)?.[1];
  if (!form) throw new Error(`no form posting to ${action}`);
  return Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!]));
}

describe("skeleton", () => {
  test("health answers", async () => {
    const res = await relay.fetch("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "scp-relay" });
  });

  test("a signed-out dashboard page redirects to sign-in with a return path", async () => {
    const res = await relay.fetch("/orgs/acme");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in?next=%2Forgs%2Facme");
  });
});

describe("email sign-in", () => {
  test("a code request then the code signs in and sets a __Host- session cookie", async () => {
    const b = new Browser(relay);
    const page = await b.get("/sign-in");
    expect(await page.text()).toContain('class="cf-turnstile"');
    const since = relay.mails.length;
    const sent = await b.post("/sign-in", { email: " Alice@Example.com ", "cf-turnstile-response": DUMMY_TOKEN });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe("/sign-in/code");
    const mail = await relay.mailTo("alice@example.com", since);
    expect(mail.subject).toContain("sign-in code");

    await b.get("/sign-in/code");
    const wrong = await b.post("/sign-in/code", { code: "2222-2222" });
    expect(wrong.status).toBe(400);
    const ok = await b.post("/sign-in/code", { code: codeOf(mail).toLowerCase() });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/orgs");
    expect(b.jar.has("__Host-scp_session")).toBe(true);
    const orgs = await b.get("/orgs");
    expect(orgs.status).toBe(200);
    expect(await orgs.text()).toContain("Signed in as alice@example.com");

    const again = new Browser(relay);
    await again.get("/sign-in");
    await again.post("/sign-in", { email: "alice@example.com", "cf-turnstile-response": DUMMY_TOKEN });
    await again.get("/sign-in/code");
    expect((await again.post("/sign-in/code", { code: codeOf(mail) })).status).toBe(400);
  });

  test("sign-out ends the session", async () => {
    const b = new Browser(relay);
    await b.signIn("leaver@example.com");
    const out = await b.post("/sign-out", {});
    expect(out.status).toBe(303);
    expect((await b.get("/orgs")).status).toBe(303);
  });

  test("a missing Turnstile token is refused and sends nothing", async () => {
    const b = new Browser(relay);
    await b.get("/sign-in");
    const since = relay.mails.length;
    const res = await b.post("/sign-in", { email: "bot@example.com" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("human check failed");
    expect(relay.mails.slice(since).some((m) => m.to === "bot@example.com")).toBe(false);
  });

  test("a token Turnstile refuses is refused (always-fail test secret)", async () => {
    const strict = await startRelay({ turnstileSecret: TURNSTILE_FAIL });
    try {
      const b = new Browser(strict);
      await b.get("/sign-in");
      const res = await b.post("/sign-in", { email: "bot@example.com", "cf-turnstile-response": DUMMY_TOKEN });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("human check failed");
      expect(strict.mails).toHaveLength(0);
    } finally {
      await strict.dispose();
    }
  }, 30_000);

  test("a POST without the CSRF token, from another origin, or with no origin at all is refused", async () => {
    const b = new Browser(relay);
    await b.get("/sign-in");
    const fields = { email: "x@example.com", "cf-turnstile-response": DUMMY_TOKEN };
    expect((await b.post("/sign-in", fields, { csrf: null })).status).toBe(403);
    expect((await b.post("/sign-in", fields, { csrf: "forged" })).status).toBe(403);
    expect((await b.post("/sign-in", fields, { origin: "https://evil.test" })).status).toBe(403);
    expect((await b.post("/sign-in", fields, { origin: null })).status).toBe(403);
    expect((await b.post("/sign-in", fields, { origin: "null", fetchSite: "cross-site" })).status).toBe(403);
  });

  test("a same-origin form sent with Origin: null (no-referrer browsers) is accepted", async () => {
    const b = new Browser(relay);
    await b.get("/sign-in");
    const fields = { email: "null-origin@example.com", "cf-turnstile-response": DUMMY_TOKEN };
    expect((await b.post("/sign-in", fields, { origin: "null", fetchSite: "same-origin" })).status).not.toBe(403);
  });

  test("a CSRF token from another browser does not carry over", async () => {
    const a = new Browser(relay);
    await a.signIn("csrf-a@example.com");
    const other = new Browser(relay);
    await other.signIn("csrf-b@example.com");
    expect((await a.post("/orgs", { handle: "stolen" }, { csrf: other.csrf })).status).toBe(403);
  });
});

describe("organizations and invites", () => {
  test("A creates an org, invites B by email, B accepts, both are listed with roles", async () => {
    const a = new Browser(relay);
    await a.signIn("owner@example.com");
    const created = await a.post("/orgs", { handle: "acme", name: "Acme" });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/orgs/acme");
    await a.follow(created);
    expect((await a.post("/orgs", { handle: "acme", name: "Again" })).status).toBe(409);
    expect((await a.post("/orgs", { handle: "Bad Handle" })).status).toBe(400);

    await a.get("/orgs/acme");
    const since = relay.mails.length;
    const invited = await a.post("/orgs/acme/invites", { email: "member@example.com", role: "member" });
    expect(invited.status).toBe(200);
    const mail = await relay.mailTo("member@example.com", since);
    const link = /https:\/\/relay\.test(\/invites\/[A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
    expect(link).toBeDefined();

    const stranger = new Browser(relay);
    await stranger.signIn("stranger@example.com");
    const wrong = await stranger.get(link!);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("This invite is for member@example.com");

    const b = new Browser(relay);
    await b.signIn("member@example.com");
    const listed = await b.get("/orgs");
    expect(await listed.text()).toContain("Invites for you");
    const view = await b.get(link!);
    expect(view.status).toBe(200);
    const accepted = await b.post("/invites/accept", { token: link!.split("/").pop()! });
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/orgs/acme");
    expect((await b.post("/invites/accept", { token: link!.split("/").pop()! })).status).toBe(409);

    const members = await (await a.get("/orgs/acme/members")).text();
    expect(members).toMatch(/owner@example\.com.*?<span class="role">owner<\/span>/s);
    expect(members).toMatch(/member@example\.com.*?<span class="role">member<\/span>/s);
    expect((await stranger.get("/orgs/acme")).status).toBe(404);

    const bPage = await (await b.get("/orgs/acme/members")).text();
    expect(bPage).not.toContain("/orgs/acme/invites");
    expect((await b.post("/orgs/acme/invites", { email: "x@example.com" })).status).toBe(403);
  });
});

async function deviceLogin(browser: Browser, org: string, label: string): Promise<{ access_token: string; org: string; email: string }> {
  const start = await relay.fetch("/v1/device/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
  expect(start.status).toBe(200);
  const code = (await start.json()) as { device_code: string; user_code: string; verification_uri_complete: string; interval: number };
  expect(code.user_code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
  const poll = () => relay.fetch("/v1/device/token", { method: "POST", body: JSON.stringify({ device_code: code.device_code }) });

  const pending = await poll();
  expect(pending.status).toBe(400);
  expect(((await pending.json()) as { error: string }).error).toBe("authorization_pending");

  const approve = await browser.get(new URL(code.verification_uri_complete).pathname + new URL(code.verification_uri_complete).search);
  expect(approve.status).toBe(200);
  expect(await approve.text()).toContain(label);
  const approved = await browser.post("/device", { code: code.user_code, org, action: "approve" });
  expect(approved.status).toBe(200);
  expect(await approved.text()).toContain("Device approved");

  const issued = await poll();
  expect(issued.status).toBe(200);
  const cred = (await issued.json()) as { access_token: string; org: string; email: string; relay: string };
  expect(cred.access_token).toMatch(/^scp_d_[A-Za-z0-9_-]{43}$/);
  expect(cred.relay).toBe(relay.origin);
  const reused = await poll();
  expect(((await reused.json()) as { error: string }).error).toBe("invalid_grant");
  return cred;
}

describe("device login", () => {
  test("device code, approve in the browser, credential issued once and accepted as a bearer", async () => {
    const a = new Browser(relay);
    await a.signIn("dev-owner@example.com");
    await a.post("/orgs", { handle: "devorg" });
    const cred = await deviceLogin(a, "devorg", "laptop");
    expect(cred.org).toBe("devorg");
    expect(cred.email).toBe("dev-owner@example.com");

    const who = await relay.fetch("/v1/whoami", bearer(cred.access_token));
    expect(await who.json()).toMatchObject({ kind: "device", org: "devorg", role: "owner", label: "laptop", ambient: false });
    const orgs = await relay.fetch("/v1/orgs", bearer(cred.access_token));
    expect(await orgs.json()).toEqual({ orgs: [{ handle: "devorg", name: "devorg", role: "owner", members: 1 }] });

    const tokensPage = await (await a.get("/orgs/devorg/tokens")).text();
    expect(tokensPage).toContain("laptop");
    const deviceId = /\/orgs\/devorg\/devices\/(dvc_[A-Za-z0-9_-]+)\/revoke/.exec(tokensPage)?.[1];
    expect((await a.post(`/orgs/devorg/devices/${deviceId}/revoke`, {})).status).toBe(303);
    const after = await relay.fetch("/v1/whoami", bearer(cred.access_token));
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "revoked" });
  });

  test("the prefilled link survives sign-in and approves in one click", async () => {
    const a = new Browser(relay);
    await a.signIn("one-click@example.com");
    await a.post("/orgs", { handle: "clickorg" });
    await a.post("/sign-out", {});
    const start = (await (await relay.fetch("/v1/device/code", { method: "POST" })).json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
    };
    const link = new URL(start.verification_uri_complete);
    const bounced = await a.get(link.pathname + link.search);
    expect(bounced.headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent(`/device?code=${start.user_code}`)}`);
    await a.follow(bounced);
    const since = relay.mails.length;
    const signIn = formOf(a.last, "/sign-in");
    await a.follow(await a.post("/sign-in", { ...signIn, email: "one-click@example.com", "cf-turnstile-response": DUMMY_TOKEN }));
    const signedIn = await a.post("/sign-in/code", { code: codeOf(await relay.mailTo("one-click@example.com", since)) });
    expect(signedIn.headers.get("location")).toBe(`/device?code=${start.user_code}`);
    const page = await (await a.follow(signedIn)).text();
    expect(page).not.toContain("<select");
    const form = formOf(page, "/device");
    expect(form).toMatchObject({ code: start.user_code.replace("-", ""), org: "clickorg" });
    const approved = await a.post("/device", { ...form, action: "approve" });
    expect(await approved.text()).toContain("Device approved");
    const issued = await relay.fetch("/v1/device/token", { method: "POST", body: JSON.stringify({ device_code: start.device_code }) });
    expect(issued.status).toBe(200);
  });

  test("an unknown code re-renders the entry form with the code kept", async () => {
    const a = new Browser(relay);
    await a.signIn("typo@example.com");
    const res = await a.get("/device?code=bbbb-bbbb");
    expect(res.status).toBe(404);
    const page = await res.text();
    expect(page).toContain("unknown or has expired");
    expect(page).toContain('name="code" value="BBBB-BBBB"');
  });

  test("a denied code yields access_denied and an unknown one invalid_grant", async () => {
    const a = new Browser(relay);
    await a.signIn("denier@example.com");
    await a.post("/orgs", { handle: "denyorg" });
    const start = (await (await relay.fetch("/v1/device/code", { method: "POST" })).json()) as { device_code: string; user_code: string };
    await a.get(`/device?code=${start.user_code}`);
    expect((await a.post("/device", { code: start.user_code, org: "denyorg", action: "deny" })).status).toBe(200);
    const denied = await relay.fetch("/v1/device/token", { method: "POST", body: JSON.stringify({ device_code: start.device_code }) });
    expect(((await denied.json()) as { error: string }).error).toBe("access_denied");
    const unknown = await relay.fetch("/v1/device/token", { method: "POST", body: JSON.stringify({ device_code: "nope" }) });
    expect(((await unknown.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("approving into an org the user is not in is refused", async () => {
    const a = new Browser(relay);
    await a.signIn("outsider@example.com");
    await a.post("/orgs", { handle: "outsider-org" });
    const start = (await (await relay.fetch("/v1/device/code", { method: "POST" })).json()) as { user_code: string };
    await a.get(`/device?code=${start.user_code}`);
    const refused = await a.post("/device", { code: start.user_code, org: "acme", action: "approve" });
    expect(refused.status).toBe(404);
    expect(await refused.text()).toContain(`name="code" value="${start.user_code}"`);
  });
});

describe("API tokens for ambient agents", () => {
  test("create in the dashboard, shown once, verified as an ambient member, then revoked", async () => {
    const a = new Browser(relay);
    await a.signIn("ci-owner@example.com");
    await a.post("/orgs", { handle: "ciorg" });
    await a.get("/orgs/ciorg/tokens");
    const created = await a.post("/orgs/ciorg/tokens", { name: "ci-nightly", expires_in_days: "30" });
    expect(created.status).toBe(200);
    const page = await created.text();
    const token = /scp_t_[A-Za-z0-9_-]{43}/.exec(page)?.[0];
    expect(token).toBeDefined();
    expect(page).toContain(`swarm up --token ${token} --machine &lt;name&gt;`);
    expect((await (await a.get("/orgs/ciorg/tokens")).text()).includes(token!)).toBe(false);

    const who = await relay.fetch("/v1/whoami", bearer(token!));
    expect(who.status).toBe(200);
    const body = (await who.json()) as { expires_at: number };
    expect(body).toMatchObject({ kind: "token", org: "ciorg", role: "member", label: "ci-nightly", ambient: true, endpoint_labels: { token: "ci-nightly" } });
    expect(body.expires_at).toBeGreaterThan(Date.now() + 29 * 86_400_000);

    expect((await relay.fetch("/v1/orgs", bearer(token!))).status).toBe(403);
    expect((await a.post("/orgs/ciorg/tokens", { name: "ci-nightly" })).status).toBe(409);
    expect((await a.post("/orgs/ciorg/tokens", { name: "Bad Name!" })).status).toBe(400);

    const listed = await (await a.get("/orgs/ciorg/tokens")).text();
    const id = /\/orgs\/ciorg\/tokens\/(tok_[A-Za-z0-9_-]+)\/revoke/.exec(listed)?.[1];
    expect(listed).toContain(`${token!.slice(0, 10)}...${token!.slice(-4)}`);
    expect((await a.post(`/orgs/ciorg/tokens/${id}/revoke`, {})).status).toBe(303);
    const after = await relay.fetch("/v1/whoami", bearer(token!));
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "revoked" });
  });

  test("the API creates, lists and revokes tokens with a device credential", async () => {
    const a = new Browser(relay);
    await a.signIn("api-owner@example.com");
    await a.post("/orgs", { handle: "apiorg" });
    const cred = await deviceLogin(a, "apiorg", "ci-box");
    const auth = { authorization: `Bearer ${cred.access_token}`, "content-type": "application/json" };
    const made = await relay.fetch("/v1/orgs/apiorg/tokens", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "cron", expires_in_days: "never" }),
    });
    expect(made.status).toBe(201);
    const tok = (await made.json()) as { id: string; token: string; expires_at: null };
    expect(tok.expires_at).toBeNull();
    expect((await relay.fetch("/v1/whoami", bearer(tok.token))).status).toBe(200);
    const list = (await (await relay.fetch("/v1/orgs/apiorg/tokens", { headers: auth })).json()) as { tokens: { id: string; name: string }[] };
    expect(list.tokens.map((t) => t.name)).toEqual(["cron"]);
    expect(JSON.stringify(list)).not.toContain(tok.token);
    expect((await relay.fetch("/v1/orgs/acme/tokens", { headers: auth })).status).toBe(404);
    expect((await relay.fetch(`/v1/orgs/apiorg/tokens/${tok.id}`, { method: "DELETE", headers: auth })).status).toBe(200);
    expect((await relay.fetch("/v1/whoami", bearer(tok.token))).status).toBe(401);
  });

  test("a session JSON call needs the CSRF header", async () => {
    const a = new Browser(relay);
    await a.signIn("json-owner@example.com");
    const page = await (await a.get("/orgs")).text();
    const cookie = [...a.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const post = (headers: Record<string, string>) =>
      relay.fetch("/v1/orgs", {
        method: "POST",
        headers: { cookie, origin: relay.origin, "content-type": "application/json", ...headers },
        body: JSON.stringify({ handle: "jsonorg" }),
      });
    expect((await post({})).status).toBe(403);
    expect((await post({ "x-csrf-token": csrfOf(page) })).status).toBe(201);
  });

  test("removing a member revokes the tokens and devices they hold", async () => {
    const a = new Browser(relay);
    await a.signIn("team-owner@example.com");
    await a.post("/orgs", { handle: "team" });
    await a.get("/orgs/team");
    const since = relay.mails.length;
    await a.post("/orgs/team/invites", { email: "temp@example.com" });
    const link = /\/invites\/([A-Za-z0-9_-]+)/.exec((await relay.mailTo("temp@example.com", since)).text)![1]!;
    const b = new Browser(relay);
    await b.signIn("temp@example.com");
    await b.get(`/invites/${link}`);
    await b.post("/invites/accept", { token: link });
    await b.get("/orgs/team/tokens");
    const token = /scp_t_[A-Za-z0-9_-]{43}/.exec(await (await b.post("/orgs/team/tokens", { name: "runner" })).text())![0];
    expect((await relay.fetch("/v1/whoami", bearer(token))).status).toBe(200);

    const members = await (await a.get("/orgs/team/members")).text();
    const uid = /\/orgs\/team\/members\/(usr_[A-Za-z0-9_-]+)\/remove/.exec(members)![1];
    expect((await a.post(`/orgs/team/members/${uid}/remove`, {})).status).toBe(303);
    expect(await (await relay.fetch("/v1/whoami", bearer(token))).json()).toEqual({ error: "revoked" });
  });

  test("an unknown or malformed bearer is refused", async () => {
    expect(await (await relay.fetch("/v1/whoami", bearer(`scp_t_${"A".repeat(43)}`))).json()).toEqual({ error: "invalid" });
    expect(await (await relay.fetch("/v1/whoami")).json()).toEqual({ error: "unauthorized" });
  });
});
