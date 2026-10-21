import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { enabled, ProcessTarget, targetNames, waitFor } from "./targets";
import { type Frame, rpc, Wire } from "./wire";

type Delivery = { seq: number; endpoint: string; message: { id: string; from: { address: string }; body: { text: string } } };
const hello = (params: object) => ({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: "scp/1", ...params } });
const view = (handle: string) => ({
  address: `me/${handle}`,
  kind: "agent",
  harness: "cli",
  labels: {},
  presence: "online",
  tree: handle,
  parent_ep: null,
  parent_addr: null,
  depth: 0,
});
const limitKeys = [
  "machines",
  "endpoints",
  "sockets",
  "frameBytes",
  "callsPerMinute",
  "bridgeCallsPerMinute",
  "accountCallsPerMinute",
  "acksPerMinute",
  "accountAcksPerMinute",
  "storedBytes",
  "refusalsPerMinute",
  "clientMachineIdleS",
  "idlePurgeS",
  "httpWaitS",
  "revalidateMs",
  "deniedS",
];

describe.each(targetNames)("%s raw wire conformance", (name) => {
  if (!enabled(name)) {
    test.skip("requires SCP_RELAY_BIN");
    return;
  }
  const target = new ProcessTarget(name);
  const sockets: Wire[] = [];
  let token: string;
  async function connect(credential = token) {
    const wire = await Wire.connect(target.url, credential);
    sockets.push(wire);
    return wire;
  }
  beforeAll(async () => {
    await target.start();
    token = (await target.mint("acme", "ada", { device: true })).token;
  }, 20000);
  afterAll(async () => {
    const results = await Promise.allSettled(sockets.map((wire) => wire.close()));
    await target.stop();
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "socket cleanup failed");
  });
  test("HTTP checks credentials before RPC and reports the contract routes", async () => {
    const revoked = await target.mint("acme", "bob");
    await target.revoke(revoked.credentialId);
    for (const path of ["/v1/relay/ws", "/v1/relay/rpc", "/v1/whoami"]) {
      for (const [credential, error] of [
        [undefined, "unauthorized"],
        ["invalid-credential", "invalid"],
        [revoked.token, "revoked"],
      ] as const) {
        const response = await fetch(`${target.url}${path}`, { headers: credential ? { authorization: `Bearer ${credential}` } : {} });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error });
      }
    }
    const query = await fetch(`${target.url}/v1/relay/ws?token=${encodeURIComponent(token)}`);
    expect(query.status).toBe(401);
    expect(await query.json()).toMatchObject({ error: "unauthorized" });
    const headers = { authorization: `Bearer ${token}` };
    expect((await fetch(`${target.url}/v1/relay/ws`, { headers })).status).toBe(426);
    expect((await fetch(`${target.url}/v1/relay/rpc`, { headers })).status).toBe(405);
    const health = await fetch(`${target.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "scp-relay" });
    const missing = await fetch(`${target.url}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
    expect(await (await fetch(`${target.url}/v1/whoami`, { headers })).json()).toMatchObject({
      kind: "device",
      org: "acme",
      ambient: false,
      endpoint_labels: {},
    });
    const api = await target.mint("acme", "ada", { name: "build" });
    expect(await (await fetch(`${target.url}/v1/whoami`, { headers: { authorization: `Bearer ${api.token}` } })).json()).toMatchObject({
      kind: "token",
      org: "acme",
      ambient: true,
      endpoint_labels: { token: "build" },
    });
  });
  test("HTTP requests are fresh connections, batches are ordered, and bridges require WebSocket", async () => {
    const first = (await rpc(target.url, token, { id: 1, method: "list" })) as Frame;
    expect(first.error?.data.code).toBe("unauthorized");
    expect(first.error?.message).toContain("call hello first");
    const batch = (await rpc(target.url, token, [hello({ observe: true }), { id: 2, method: "machines" }])) as (Frame & {
      result: { account: string; machines: unknown[] };
    })[];
    expect(batch.map((frame) => frame.id)).toEqual([1, 2]);
    expect(batch[0]!.result.account).toBe("acme");
    expect(batch[1]!.result.machines).toBeArray();
    expect(((await rpc(target.url, token, { id: 3, method: "machines" })) as Frame).error?.data.code).toBe("unauthorized");
    expect(((await rpc(target.url, token, hello({ machine: "http-bridge", bridge: true }))) as Frame).error?.data.code).toBe("invalid_params");
  });
  test("hello advertises account, capabilities, server time and every required hub limit", async () => {
    const wire = await connect();
    expect((await wire.call("unknown")).error?.data.code).toBe("unauthorized");
    const result = await wire.hello({ observe: true });
    expect(result.account).toBe("acme");
    expect(result.capabilities).toEqual(expect.arrayContaining(["inbox.wait", "ask", "scopes", "groups"]));
    expect(Number.isFinite(Date.parse(result.server_time as string))).toBe(true);
    const limits = result.limits as Record<string, unknown>;
    for (const key of limitKeys) {
      expect(Object.hasOwn(limits, key)).toBe(true);
      expect(limits[key] === null || typeof limits[key] === "number").toBe(true);
    }
    expect((await wire.call("hello", { protocol: "scp/1", observe: true })).error?.data.code).toBe("invalid_params");
  });
  test("invalid machine names fail and machine bindings exclude another member's credential", async () => {
    const invalid = await connect();
    for (const machine of ["", "Upper", "has/slash", "a_b", "me", "local", "acme", "a".repeat(33)]) {
      expect((await invalid.call("hello", { protocol: "scp/1", bridge: true, machine })).error?.data.code).toBe("invalid_params");
    }
    const bound = await connect();
    await bound.hello({ machine: "bound", bridge: true });
    const other = await connect((await target.mint("acme", "bob", { device: true })).token);
    expect((await other.call("hello", { protocol: "scp/1", machine: "bound", bridge: true })).error?.data.code).toBe("unauthorized");
  });
  test("a replacement bridge closes its predecessor with 4000", async () => {
    const first = await connect();
    await first.hello({ machine: "replaced", bridge: true });
    const second = await connect();
    await second.hello({ machine: "replaced", bridge: true });
    expect(await waitFor(() => first.closeCode, "replacement close")).toBe(4000);
  });
  test("text frames above 262144 bytes close with 1009", async () => {
    const wire = await connect();
    wire.ws.send("x".repeat(262145));
    expect(await waitFor(() => wire.closeCode, "oversized frame close")).toBe(1009);
  });
  test("mirror reports changed rows and forward validates its bare mirrored sender", async () => {
    const wire = await connect();
    await wire.hello({ machine: "mirror", bridge: true });
    const params = { to: "mirror/ada", body: "hi" };
    expect((await wire.call("forward", { from: "absent", params })).error?.data.code).toBe("not_found");
    expect((await wire.call("forward", { from: "mirror/ada", params })).error?.data.code).toBe("invalid_params");
    expect(await wire.result("mirror", { endpoints: [view("ada")], full: true })).toEqual({ changed: 1 });
    expect(await wire.result("mirror", { endpoints: [view("ada")], full: true })).toEqual({ changed: 0 });
    expect(await wire.result("mirror", { endpoints: [{ ...view("ada"), title: "updated" }], full: false })).toEqual({ changed: 1 });
  });
  test("subscribe replays all unacknowledged deliveries, ack clears them and reject notifies the sender", async () => {
    const sender = await connect();
    await sender.hello({ machine: "source", bridge: true });
    await sender.result("mirror", { endpoints: [view("ada")], full: true });
    await sender.result("subscribe", { after: 0 });
    const recipient = await connect();
    await recipient.hello({ machine: "sink", bridge: true });
    await recipient.result("mirror", { endpoints: [view("bob")], full: true });
    await recipient.close();
    const sent: { id: string }[] = [];
    for (let i = 0; i < 3; i++) sent.push(await sender.result("forward", { from: "ada", params: { to: "sink/bob", body: `queued ${i}` } }));
    const replay = await connect();
    await replay.hello({ machine: "sink", bridge: true });
    const result = await replay.result<{ replayed: number; next: number }>("subscribe", { after: 0 });
    expect(result.replayed).toBe(3);
    const deliveries = replay.notifications("deliver") as Delivery[];
    expect(deliveries.map((d) => d.message.id)).toEqual(sent.map((s) => s.id));
    expect(deliveries.map((d) => d.endpoint)).toEqual(["sink/bob", "sink/bob", "sink/bob"]);
    expect(deliveries[0]?.message.from.address).toBe("acme/source/ada");
    expect(result.next).toBe(Math.max(...deliveries.map((d) => d.seq)));
    expect(await replay.result("subscribe", { after: 0 })).toEqual(result);
    expect(replay.notifications("deliver").length).toBe(6);
    expect(await replay.result("ack", { seqs: deliveries.map((d) => d.seq) })).toEqual({ acked: 3 });
    expect(await replay.result("subscribe", { after: 0 })).toEqual({ replayed: 0, next: 0 });
    expect(replay.notifications("deliver").length).toBe(6);
    const refused = await sender.result<{ id: string }>("forward", { from: "ada", params: { to: "sink/bob", body: "refuse this" } });
    const delivery = await waitFor(() => (replay.notifications("deliver") as Delivery[]).find((d) => d.message.id === refused.id), "delivery to reject");
    expect(await replay.result("reject", { seq: delivery.seq, code: "policy_refused" })).toEqual({ rejected: true });
    const notice = await waitFor(() => (sender.notifications("deliver") as Delivery[]).find((d) => d.message.body.text.includes(refused.id)), "refusal notice");
    expect(notice.message.body.text).toContain("policy_refused");
    expect(await replay.result("subscribe", { after: 0 })).toEqual({ replayed: 0, next: 0 });
  }, 20000);
});
