import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker";
import { type Envelope, PROTOCOL } from "@scp-dev/core";
import { bearer, Browser, type Relay, startRelay } from "./harness";

setDefaultTimeout(30_000);

let relay: Relay;
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  relay = await startRelay();
}, 30_000);

afterAll(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await relay?.dispose();
});

async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** the hidden fields of the page's POST form to `action` */
function formOf(page: string, action: string): Record<string, string> {
  const form = new RegExp(`<form[^>]*method="post" action="${action}"[^>]*>([\\s\\S]*?)</form>`).exec(page)?.[1];
  if (!form) throw new Error(`no form posting to ${action}`);
  return Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!]));
}

async function deviceLogin(browser: Browser, label: string): Promise<string> {
  const start = (await (
    await relay.fetch("/v1/device/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) })
  ).json()) as { device_code: string; verification_uri_complete: string };
  const link = new URL(start.verification_uri_complete);
  const page = await (await browser.get(link.pathname + link.search)).text();
  await browser.post("/device", { ...formOf(page, "/device"), action: "approve" });
  const issued = await relay.fetch("/v1/device/token", { method: "POST", body: JSON.stringify({ device_code: start.device_code }) });
  return ((await issued.json()) as { access_token: string }).access_token;
}

async function machine(origin: string, name: string, token: string): Promise<Broker> {
  const root = mkdtempSync(join(tmpdir(), `scp-relay-${name}-`));
  const broker = await startBroker({
    dir: join(root, "state"),
    policyPath: join(root, "policy.json"),
    idleMs: 0,
    log: () => {},
    bridge: { url: origin, token, machine: name, backoff: { minMs: 50, maxMs: 200 } },
  });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => broker.stop());
  await waitFor(() => broker.bridge!.status().connected, `${name}'s bridge`);
  return broker;
}

async function agent(broker: Broker, handle: string): Promise<RelayClient> {
  const client = await RelayClient.connect(broker.socket);
  cleanups.push(() => client.close());
  await client.hello({ claim: { handle, harness: "claude-code" } });
  return client;
}

type Grant = { tokenId: string; userId: string; actorId: string; expiresAt: number; scoped: boolean; role: string };
interface WorkerModules {
  authenticate(db: unknown, header: string): Promise<{ ok: true; grant: { orgId: string; userId: string } } | { ok: false; reason: string }>;
  hubGrant(cred: unknown, now: number): Grant;
  grantValid(db: unknown, grant: Grant, now: number): Promise<boolean>;
}

/** Worker source, loaded by path so the test typecheck (Bun types) does not pull in the Workers types */
async function workerModules(): Promise<WorkerModules> {
  const paths = ["../src/credentials", "../src/hub/grant"];
  const [credentials, grant] = await Promise.all(paths.map((p) => import(p)));
  return { authenticate: credentials.authenticate, hubGrant: grant.hubGrant, grantValid: grant.grantValid };
}

type Inbox = { messages: Envelope[] };
type Listed = { endpoints: { address: string; labels?: Record<string, string> }[] };

describe("org hub", () => {
  test("two members of one org, one on a device login and one on an API token, exchange messages and a reply through the hub", async () => {
    const owner = new Browser(relay);
    await owner.signIn("hub-owner@example.com");
    await owner.post("/orgs", { handle: "hubco" });
    await owner.get("/orgs/hubco");
    const since = relay.mails.length;
    await owner.post("/orgs/hubco/invites", { email: "hub-member@example.com", role: "member" });
    const invite = /\/invites\/([A-Za-z0-9_-]+)/.exec((await relay.mailTo("hub-member@example.com", since)).text)![1]!;
    const member = new Browser(relay);
    await member.signIn("hub-member@example.com");
    await member.get(`/invites/${invite}`);
    expect((await member.post("/invites/accept", { token: invite })).status).toBe(303);

    const device = await deviceLogin(owner, "laptop");
    await member.get("/orgs/hubco/tokens");
    const token = /scp_t_[A-Za-z0-9_-]{43}/.exec(await (await member.post("/orgs/hubco/tokens", { name: "nightly" })).text())![0];

    const origin = await relay.listening();
    const laptop = await machine(origin, "laptop", device);
    const runner = await machine(origin, "runner", token);
    const lead = await agent(laptop, "lead");
    const bot = await agent(runner, "bot");

    const listed = await waitFor(async () => {
      const { endpoints } = await lead.request<Listed>("list");
      return endpoints.find((e) => e.address.endsWith("/runner/bot")) ?? null;
    }, "runner/bot on the laptop");
    expect(listed.labels).toEqual({ token: "nightly" });

    const sent = await lead.request<{ id: string }>("send", { to: "hubco/runner/bot", body: "nightly build status?" });
    const got = await bot.request<Inbox>("inbox", { wait_s: 10 });
    expect(got.messages.map((m) => [m.id, m.body.text, m.from.machine])).toEqual([[sent.id, "nightly build status?", "laptop"]]);
    await bot.request("ack", { seqs: [got.messages[0]!.seq] });

    const asking = lead.request<{ reply?: Envelope }>("ask", { to: "hubco/runner/bot", body: "green?", wait_s: 20 });
    const request = (await bot.request<Inbox>("inbox", { wait_s: 10 })).messages[0]!;
    expect(request.kind).toBe("request");
    await bot.request("send", { to: request.from.address, kind: "reply", reply_to: request.id, body: "green" });
    const answered = await asking;
    expect(answered.reply?.body.text).toBe("green");
    expect(answered.reply?.from.address).toEndWith("/runner/bot");

    const rpc = await relay.fetch("/v1/relay/rpc", {
      method: "POST",
      headers: { ...(bearer(token).headers as Record<string, string>), "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: PROTOCOL, observe: true } },
        { jsonrpc: "2.0", id: 2, method: "machines" },
      ]),
    });
    const [, machines] = (await rpc.json()) as [unknown, { result: unknown }];
    expect(machines.result).toMatchObject({
      machines: [
        { name: "laptop", online: true },
        { name: "runner", online: true },
      ],
    });

    const tokensPage = await (await member.get("/orgs/hubco/tokens")).text();
    const tokenId = /\/orgs\/hubco\/tokens\/(tok_[A-Za-z0-9_-]+)\/revoke/.exec(tokensPage)![1]!;
    expect((await member.post(`/orgs/hubco/tokens/${tokenId}/revoke`, {})).status).toBe(303);
    await waitFor(() => !runner.bridge!.status().connected, "the revoked bridge to close");
    expect(laptop.bridge!.status().connected).toBe(true);
  });

  test("revalidation holds while the credential and role hold, and fails once the member is removed", async () => {
    const { authenticate, grantValid, hubGrant } = await workerModules();
    const owner = new Browser(relay);
    await owner.signIn("reval-owner@example.com");
    await owner.post("/orgs", { handle: "reval" });
    await owner.get("/orgs/reval");
    const since = relay.mails.length;
    await owner.post("/orgs/reval/invites", { email: "reval-member@example.com", role: "member" });
    const invite = /\/invites\/([A-Za-z0-9_-]+)/.exec((await relay.mailTo("reval-member@example.com", since)).text)![1]!;
    const member = new Browser(relay);
    await member.signIn("reval-member@example.com");
    await member.get(`/invites/${invite}`);
    await member.post("/invites/accept", { token: invite });
    const device = await deviceLogin(member, "box");

    const db = await relay.mf.getD1Database("DB");
    const auth = await authenticate(db, `Bearer ${device}`);
    if (!auth.ok) throw new Error(auth.reason);
    const grant = hubGrant(auth.grant, Date.now());
    expect(grant).toMatchObject({ userId: auth.grant.orgId, actorId: auth.grant.userId, role: "member", scoped: false });
    expect(await grantValid(db, grant, Date.now())).toBe(true);
    expect(await grantValid(db, { ...grant, role: "admin" }, Date.now())).toBe(false);
    expect(await grantValid(db, grant, grant.expiresAt)).toBe(false);

    const orgPage = await (await owner.get("/orgs/reval/members")).text();
    const memberId = /\/orgs\/reval\/members\/(usr_[A-Za-z0-9_-]+)\/remove/.exec(orgPage)![1]!;
    expect(memberId).toBe(auth.grant.userId);
    await owner.post(`/orgs/reval/members/${memberId}/remove`, {});
    expect(await grantValid(db, grant, Date.now())).toBe(false);
  });

  test("revalidation finds a credential by its table, whatever its id looks like", async () => {
    const { authenticate, grantValid, hubGrant } = await workerModules();
    const owner = new Browser(relay);
    await owner.signIn("ids-owner@example.com");
    await owner.post("/orgs", { handle: "idsco" });
    await owner.get("/orgs/idsco");
    const device = await deviceLogin(owner, "desk");
    await owner.get("/orgs/idsco/tokens");
    const token = /scp_t_[A-Za-z0-9_-]{43}/.exec(await (await owner.post("/orgs/idsco/tokens", { name: "ci" })).text())![0];

    const db = await relay.mf.getD1Database("DB");
    for (const [secret, table, id] of [
      [device, "device_credentials", "legacy-device"],
      [token, "api_tokens", "legacy-token"],
    ] as const) {
      const before = await authenticate(db, `Bearer ${secret}`);
      if (!before.ok) throw new Error(before.reason);
      await db.prepare(`UPDATE ${table} SET id = ? WHERE id = ?`).bind(id, hubGrant(before.grant, Date.now()).tokenId).run();
      const auth = await authenticate(db, `Bearer ${secret}`);
      if (!auth.ok) throw new Error(auth.reason);
      const grant = hubGrant(auth.grant, Date.now());
      expect(grant.tokenId).toBe(id);
      expect(await grantValid(db, grant, Date.now())).toBe(true);
      expect(await grantValid(db, { ...grant, scoped: !grant.scoped }, Date.now())).toBe(false);
    }
  });

  test("the hub refuses a missing or unknown bearer", async () => {
    const res = await relay.fetch("/v1/relay/rpc", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const bad = await relay.fetch("/v1/relay/rpc", { method: "POST", ...bearer("scp_t_nope"), body: "{}" });
    expect(bad.status).toBe(401);
  });
});

describe("org overview", () => {
  test("a fresh org shows the onboarding commands, and its page loads the refresh script", async () => {
    const owner = new Browser(relay);
    await owner.signIn("fresh-owner@example.com");
    const created = await owner.post("/orgs", { handle: "freshco" });
    expect(created.headers.get("location")).toBe("/orgs/freshco");
    const page = await (await owner.follow(created)).text();
    expect(page).toContain("Connect your first machine");
    for (const cmd of ["npm i -g @scp-dev/cli", "swarm up", "swarm claude --name lead", "swarm up --token &lt;token&gt; --machine &lt;name&gt;"])
      expect(page).toContain(`data-copy="${cmd}"`);
    expect(page).toContain("SCP_TOKEN");
    expect(page).toContain('href="/orgs/freshco/tokens"');
    expect(page).toMatch(/<script src="\/app\.js\?v=[0-9a-z]+" defer><\/script>/);
    expect(page).toMatch(/<link rel="stylesheet" href="\/app\.css\?v=[0-9a-z]+">/);
    expect(page).toMatch(/data-live="\d+"/);

    const js = await relay.fetch("/app.js");
    expect(js.headers.get("content-type")).toStartWith("text/javascript");
    expect(await js.text()).toContain("[data-live]");
    expect((await owner.get("/orgs/freshco/members")).status).toBe(200);
    const stranger = new Browser(relay);
    await stranger.signIn("fresh-stranger@example.com");
    expect((await stranger.get("/orgs/freshco")).status).toBe(404);
  });

  test("bridged machines show with their agents, presence, status, token labels and recent activity", async () => {
    const owner = new Browser(relay);
    await owner.signIn("overview-owner@example.com");
    await owner.post("/orgs", { handle: "liveco" });
    const device = await deviceLogin(owner, "laptop");
    await owner.get("/orgs/liveco/tokens");
    const token = /scp_t_[A-Za-z0-9_-]{43}/.exec(await (await owner.post("/orgs/liveco/tokens", { name: "ambient" })).text())![0];

    const origin = await relay.listening();
    const laptop = await machine(origin, "laptop", device);
    const runner = await machine(origin, "runner", token);
    const lead = await agent(laptop, "lead");
    await agent(runner, "bot");
    await lead.request("status", { state: "working", note: "wiring the overview" });
    await lead.request("event", { kind: "tool", tool: "Bash", summary: "bun test" });
    await lead.request("title", { text: "overview page" });

    const page = await waitFor(async () => {
      const text = await (await owner.get("/orgs/liveco")).text();
      return text.includes("token=ambient") && text.includes("overview page") && text.includes("wiring the overview") && text.includes("bun test")
        ? text
        : null;
    }, "both machines on the overview");
    expect(page).not.toContain("Connect your first machine");
    expect(page).toMatch(/<h3 class="mono">laptop<\/h3>[\s\S]*aria-label="claude-code"[\s\S]*<span class="mono">lead<\/span>[\s\S]*overview page/);
    expect(page).toMatch(/<h3 class="mono">runner<\/h3>[\s\S]*<span class="mono">bot<\/span>[\s\S]*<span class="tag">token=ambient<\/span>/);
    expect(page).toMatch(/<span class="role">working<\/span> <span class="small">wiring the overview<\/span>/);
    expect(page).toMatch(/laptop\/lead[\s\S]*?Bash: bun test/);
    expect(page).toContain("2 machines, 2 online, 2 agents");
  });

  test("the overview carries a live graph of the agents with spawn and message edges, counts only, and its script", async () => {
    const owner = new Browser(relay);
    await owner.signIn("graph-owner@example.com");
    await owner.post("/orgs", { handle: "graphco" });
    const device = await deviceLogin(owner, "laptop");
    const origin = await relay.listening();
    const laptop = await machine(origin, "laptop", device);
    const desk = await machine(origin, "desk", device);
    const lead = await agent(laptop, "lead");
    await agent(desk, "review");
    await waitFor(async () => {
      const { endpoints } = await lead.request<{ endpoints: { address: string }[] }>("list");
      return endpoints.some((e) => e.address.endsWith("/desk/review"));
    }, "desk/review on the laptop");
    await lead.request("send", { to: "graphco/desk/review", body: "a private plan" });
    await lead.request("send", { to: "graphco/desk/review", body: "a second private plan" });

    type Edge = { kind: string; from: string; to: string; count?: number; last_at?: string };
    const data = await waitFor(async () => {
      const text = await (await owner.get("/orgs/graphco")).text();
      const json = /<script type="application\/json" data-graph-data>([\s\S]*?)<\/script>/.exec(text)?.[1];
      const g = json ? (JSON.parse(json) as { nodes: { address: string; machine: string; label: string }[]; edges: Edge[] }) : null;
      return g?.edges.some((e) => e.kind === "message" && e.count === 2) ? { text, g } : null;
    }, "a message edge on the graph");
    expect(data.text).toMatch(/<script src="\/graph\.js\?v=[a-z0-9]+" defer><\/script>/);
    expect(data.text).toMatch(/<link rel="stylesheet" href="\/graph\.css\?v=[a-z0-9]+">/);
    expect(data.text).toContain("data-graph hidden");
    expect(data.text).toContain('data-view-set="table"');
    expect(data.text).not.toContain("private plan");
    expect(data.g.nodes.find((n) => n.label === "lead")).toMatchObject({ machine: "laptop" });
    expect(data.g.edges.find((e) => e.kind === "message")).toMatchObject({
      count: 2,
      from: expect.stringContaining("/laptop/lead"),
      to: expect.stringContaining("/desk/review"),
    });

    const js = await relay.fetch("/graph.js");
    expect(js.headers.get("content-type")).toStartWith("text/javascript");
    expect(await js.text()).toContain("[data-graph-data]");
    expect(await (await relay.fetch("/graph.css")).text()).toContain(".graph-svg");
  });
});
