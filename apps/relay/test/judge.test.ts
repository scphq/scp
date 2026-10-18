import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Broker, RelayClient, startBroker } from "@scp-dev/broker";
import type { Envelope, SendResult } from "@scp-dev/core";
import { Browser, type Relay, startRelay } from "./harness";

setDefaultTimeout(60_000);

const MARKER = "HOLDME";
const cleanups: (() => Promise<void> | void)[] = [];

interface ProviderCall {
  authorization: string | null;
  model: string;
}

/** a chat completions endpoint: holds a prompt carrying the marker, passes anything else */
function stubProvider() {
  const calls: ProviderCall[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.text();
      calls.push({ authorization: req.headers.get("authorization"), model: (JSON.parse(body) as { model: string }).model });
      const verdict = body.includes(MARKER)
        ? { verdict: "hold", categories: ["private"], reason: "looks internal", redactions: [] }
        : { verdict: "pass", categories: [], reason: "ordinary work traffic", redactions: [] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    },
  });
  cleanups.push(() => server.stop(true));
  const outbound = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.hostname !== "openrouter.ai") return fetch(req);
    return fetch(`http://127.0.0.1:${server.port}${url.pathname}`, { method: req.method, headers: req.headers, body: await req.text() });
  };
  return { calls, outbound };
}

const relays: Relay[] = [];
async function relayWith(bindings: Record<string, string>, outbound: (req: Request) => Promise<Response>): Promise<Relay> {
  const relay = await startRelay({ bindings, outbound });
  relays.push(relay);
  return relay;
}

const provider = stubProvider();
let relay: Relay;

beforeAll(async () => {
  relay = await relayWith({ JUDGE_MODEL: "test/judge", JUDGE_API_KEY: "test-key" }, provider.outbound);
}, 30_000);

afterAll(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const r of relays) await r.dispose();
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

function formOf(page: string, action: string): Record<string, string> {
  const form = new RegExp(`<form[^>]*method="post" action="${action}"[^>]*>([\\s\\S]*?)</form>`).exec(page)?.[1];
  if (!form) throw new Error(`no form posting to ${action}`);
  return Object.fromEntries([...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!]));
}

async function deviceLogin(relay: Relay, browser: Browser, label: string): Promise<string> {
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
  const root = mkdtempSync(join(tmpdir(), `scp-judge-${name}-`));
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
  await client.hello({ claim: { handle, harness: "test-harness" } });
  return client;
}

type Inbox = { messages: Envelope[] };

/** an org of one owner with two bridged machines, `lead` on one and `bot` on the other, its judge turned on or left at its default */
async function org(relay: Relay, handle: string, judge: boolean) {
  const owner = new Browser(relay);
  await owner.signIn(`${handle}-owner@example.com`);
  await owner.post("/orgs", { handle });
  const page = await (await owner.get(`/orgs/${handle}/members`)).text();
  expect(page).toContain("Relay judge");
  expect(page).toContain(`The relay judge is <span class="role">off</span>`);
  if (judge) {
    expect((await owner.post(`/orgs/${handle}/judge`, formOf(page, `/orgs/${handle}/judge`))).status).toBe(303);
    expect(await (await owner.get(`/orgs/${handle}/members`)).text()).toContain(`The relay judge is <span class="role">on</span>`);
  }
  const origin = await relay.listening();
  const laptop = await machine(origin, "laptop", await deviceLogin(relay, owner, "laptop"));
  const runner = await machine(origin, "runner", await deviceLogin(relay, owner, "runner"));
  const lead = await agent(laptop, "lead");
  const bot = await agent(runner, "bot");
  const to = await waitFor(
    async () => (await lead.request<{ endpoints: { address: string }[] }>("list")).endpoints.find((e) => e.address.endsWith("/runner/bot"))?.address,
    "runner/bot on the laptop",
  );
  const send = (body: string) => lead.request<SendResult>("send", { to, body });
  const received = async (wait_s: number) => {
    const { messages } = await bot.request<Inbox>("inbox", { wait_s });
    if (messages.length) await bot.request("ack", { seqs: messages.map((m) => m.seq) });
    return messages.map((m) => m.body.text);
  };
  return { owner, lead, send, received };
}

describe("relay judge", () => {
  test("an org that turned the judge on: clean messages pass, flagged ones wait for the dashboard to release or refuse them", async () => {
    const before = provider.calls.length;
    const { owner, lead, send, received } = await org(relay, "judgeco", true);

    expect((await send("the nightly build is green")).held).toBeUndefined();
    expect(await received(10)).toEqual(["the nightly build is green"]);
    expect(provider.calls.slice(before)).toEqual([{ authorization: "Bearer test-key", model: "test/judge" }]);

    const held = await send(`${MARKER} the quarterly numbers`);
    expect(held.deliveries).toEqual([]);
    const holdId = held.held!.hold_id;
    expect(await received(1)).toEqual([]);

    const page = await (await owner.get("/orgs/judgeco/members")).text();
    expect(page).toContain("Held messages");
    expect(page).toContain("judgeco/laptop/lead");
    expect(page).toContain("looks internal");
    expect(page).not.toContain("quarterly");
    expect((await owner.post(`/orgs/judgeco/holds/${holdId}/release`, {})).status).toBe(303);
    expect(await received(10)).toEqual([`${MARKER} the quarterly numbers`]);
    await waitFor(async () => {
      const { messages } = await lead.request<Inbox>("inbox");
      return messages.some((m) => m.kind === "status" && m.body.text.includes(holdId) && m.body.text.includes("released"));
    }, "the release notice");

    const refused = await send(`${MARKER} the salary sheet`);
    const refusedId = refused.held!.hold_id;
    await owner.get("/orgs/judgeco/members");
    expect((await owner.post(`/orgs/judgeco/holds/${refusedId}/refuse`, { reason: "keep it internal" })).status).toBe(303);
    expect(await received(2)).toEqual([]);
    await waitFor(async () => {
      const { messages } = await lead.request<Inbox>("inbox");
      return messages.some((m) => m.kind === "status" && m.body.text.includes("keep it internal"));
    }, "the refusal notice");
    expect(await (await owner.get("/orgs/judgeco/members")).text()).toContain("No held messages.");
    expect(provider.calls.length - before).toBe(3);
  });

  test("an org that never turned the judge on asks no model and delivers everything", async () => {
    const before = provider.calls.length;
    const { send, received } = await org(relay, "plainco", false);
    expect((await send(`${MARKER} unjudged`)).held).toBeUndefined();
    expect(await received(10)).toEqual([`${MARKER} unjudged`]);
    expect(provider.calls.length).toBe(before);
  });

  test("with the flag on but no model or no key on the relay, nothing is judged or held", async () => {
    for (const bindings of [{ JUDGE_API_KEY: "test-key" }, { JUDGE_MODEL: "test/judge" }]) {
      const stub = stubProvider();
      const bare = await relayWith(bindings, stub.outbound);
      const { owner, send, received } = await org(bare, "bareco", true);
      expect(await (await owner.get("/orgs/bareco/members")).text()).toContain("not configured on this relay");
      expect((await send(`${MARKER} not judged here`)).held).toBeUndefined();
      expect(await received(10)).toEqual([`${MARKER} not judged here`]);
      expect(stub.calls).toEqual([]);
    }
  });
});
