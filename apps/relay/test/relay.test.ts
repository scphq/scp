import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bearer, Browser, codeOf, DUMMY_TOKEN, type Relay, startRelay, TURNSTILE_FAIL } from "./harness";

let relay: Relay;

beforeAll(async () => {
  relay = await startRelay();
}, 30_000);

afterAll(async () => {
  await relay?.dispose();
});

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
    const signedIn = await b.get("/sign-in");
    expect(signedIn.headers.get("location")).toBe("/orgs");

    const again = new Browser(relay);
    await again.get("/sign-in");
    await again.post("/sign-in", { email: "alice@example.com", "cf-turnstile-response": DUMMY_TOKEN });
    await again.get("/sign-in/code");
    expect((await again.post("/sign-in/code", { code: codeOf(mail) })).status).toBe(400);
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
  });
});
