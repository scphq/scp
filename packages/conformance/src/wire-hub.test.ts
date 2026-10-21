import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { slowConformance } from "./environment";
import { enabled, ProcessTarget, type Target, targetNames, waitFor } from "./targets";
import { type Frame, rpc, Wire } from "./wire";

type Row = {
  id: string;
  address: string;
  kind: string;
  harness: string | null;
  presence: string;
  status: { state: string; note: string } | null;
  [key: string]: unknown;
};
type Announcement = { machine: string; endpoints: Row[]; full: boolean; own?: boolean; released?: boolean };
type Sent = { id: string; thread: string; duplicate?: boolean };
type Delivery = {
  seq: number;
  endpoint: string;
  message: {
    id: string;
    from: { address: string; user: string };
    to: string;
    thread: string;
    kind: string;
    reply_to: string | null;
    body: { text: string };
    seq?: number;
  };
};
const view = (handle: string, extra: object = {}) => ({
  address: `me/${handle}`,
  kind: "agent",
  harness: "cli",
  model: null,
  cwd: null,
  labels: {},
  status: null,
  presence: "online",
  last_seen: "2026-01-01T00:00:00.000Z",
  title: null,
  wake: null,
  tree: handle,
  parent_ep: null,
  parent_addr: null,
  depth: 0,
  rules: null,
  caps: null,
  incarnation: "holder.1",
  ...extra,
});
const hello = (params: object) => ({ id: 1, method: "hello", params: { protocol: "scp/1", ...params } });
const announcements = (wire: Wire, machine: string) => (wire.notifications("endpoints") as Announcement[]).filter((frame) => frame.machine === machine);
const deliveries = (wire: Wire, id: string) => (wire.notifications("deliver") as Delivery[]).filter((delivery) => delivery.message.id === id);
const rows = async (wire: Wire) => (await wire.result<{ endpoints: Row[] }>("list", { all: true })).endpoints;
const forward = (wire: Wire, to: string | string[], extra: object = {}, from = "source") =>
  wire.result<Sent>("forward", { from, params: { to, body: "wire message", ...extra } });
async function delivered(wire: Wire, id: string) {
  return await waitFor(() => deliveries(wire, id)[0], "matching delivery");
}

async function fixture(
  target: Target,
  run: (f: {
    account: string;
    token: string;
    connect: (credential?: string) => Promise<Wire>;
    bridge: (machine: string, endpoints?: object[]) => Promise<Wire>;
  }) => Promise<void>,
) {
  const account = `wire-${crypto.randomUUID().slice(0, 8)}`;
  const { token } = await target.mint(account, "member-a", { device: true });
  const sockets: Wire[] = [];
  const connect = async (credential = token) => {
    const wire = await Wire.connect(target.url, credential);
    sockets.push(wire);
    return wire;
  };
  const bridge = async (machine: string, endpoints: object[] = []) => {
    const wire = await connect();
    await wire.hello({ machine, bridge: true });
    if (endpoints.length) await wire.result("mirror", { endpoints, full: true });
    return wire;
  };
  const errors: unknown[] = [];
  try {
    await run({ account, token, connect, bridge });
  } catch (error) {
    errors.push(error);
  } finally {
    const results = await Promise.allSettled(sockets.map((socket) => socket.close()));
    errors.push(...results.filter((result) => result.status === "rejected").map((result) => result.reason));
  }
  if (errors.length) throw new AggregateError(errors, "wire fixture failed");
}

describe.each(targetNames)("%s hub wire scenarios", (name) => {
  if (!enabled(name)) {
    test.skip("requires SCP_RELAY_BIN");
    return;
  }
  const target = new ProcessTarget(name);
  beforeAll(() => target.start(), 20000);
  afterAll(() => target.stop());

  test("full and delta mirrors announce fields, ownership and omitted rows offline", async () => {
    await fixture(target, async ({ account, bridge }) => {
      const a = await bridge("alpha");
      const b = await bridge("beta");
      const root = view("root", {
        model: "model-v1",
        cwd: "/work/project",
        labels: { role: "worker" },
        status: { state: "working", note: "processing" },
        title: "Wire worker",
        wake: "channels",
        parent_addr: "beta/parent",
        rules: { in: ["*"], out: ["*"] },
        caps: { caps: [{ id: "limit", dir: "in", by: "human", sels: [{ sel: "*" }] }], allow: {} },
      });
      const child = view("child", { tree: "root", parent_ep: "root", depth: 1, presence: "idle" });
      expect(await a.result("mirror", { endpoints: [root, child], full: true })).toEqual({ changed: 2 });
      await rows(b);
      const full = announcements(b, "alpha");
      expect(full).toHaveLength(1);
      expect(full[0]).toMatchObject({ machine: "alpha", full: true, own: true });
      expect(full[0]!.endpoints).toHaveLength(2);
      for (const input of [root, child]) {
        const address = `${account}/alpha/${input.address.slice(3)}`;
        expect(full[0]!.endpoints.find((row) => row.address === address)).toMatchObject({ ...input, address, machine: "alpha" });
      }
      const updated = { ...root, title: "Updated worker" };
      expect(await a.result("mirror", { endpoints: [updated, child], full: false })).toEqual({ changed: 1 });
      await rows(b);
      const delta = announcements(b, "alpha").at(-1)!;
      expect(delta).toMatchObject({ machine: "alpha", full: false, own: true });
      expect(delta.endpoints.map((row) => row.address)).toEqual([`${account}/alpha/root`]);
      expect(delta.endpoints[0]!.title).toBe("Updated worker");
      expect((await rows(b)).find((row) => row.address === `${account}/alpha/child`)?.presence).toBe("idle");
      expect(await a.result("mirror", { endpoints: [updated], full: true })).toEqual({ changed: 1 });
      await rows(b);
      const swept = announcements(b, "alpha").at(-1)!;
      expect(swept.full).toBe(true);
      expect(swept.endpoints).toHaveLength(2);
      expect(swept.endpoints.find((row) => row.address === `${account}/alpha/child`)?.presence).toBe("offline");
    });
  });

  test("endpoint announcements mark a different member's machine own false", async () => {
    await fixture(target, async ({ account, connect, bridge }) => {
      const b = await bridge("beta");
      const a = await connect((await target.mint(account, "member-b", { device: true })).token);
      await a.hello({ machine: "alpha", bridge: true });
      await a.result("mirror", { endpoints: [view("worker")], full: true });
      await rows(b);
      expect(announcements(b, "alpha")).toMatchObject([{ machine: "alpha", full: true, own: false }]);
    });
  });

  test("was renames in place and queued mail follows the new handle", async () => {
    await fixture(target, async ({ account, bridge }) => {
      const a = await bridge("alpha", [view("old")]);
      const b = await bridge("beta", [view("source")]);
      const original = (await rows(b)).find((row) => row.address === `${account}/alpha/old`)!;
      const sent = await forward(b, "alpha/old");
      expect(deliveries(a, sent.id)).toHaveLength(0);
      expect(await a.result("mirror", { endpoints: [view("new", { was: "old" })], full: false })).toEqual({ changed: 1 });
      const listed = await rows(b);
      const renamed = listed.find((row) => row.address === `${account}/alpha/new`)!;
      expect(renamed.id).toBe(original.id);
      expect(renamed.presence).toBe("online");
      expect(listed.some((row) => row.address === `${account}/alpha/old` && row.presence !== "offline")).toBe(false);
      const delta = announcements(b, "alpha").at(-1)!;
      expect(delta.full).toBe(false);
      expect(delta.endpoints).toMatchObject([{ address: renamed.address, was: "old" }]);
      expect(await a.result("subscribe", { after: 0 })).toMatchObject({ replayed: 1 });
      expect(await delivered(a, sent.id)).toMatchObject({ endpoint: "alpha/new", message: { to: "alpha/old" } });
    });
  });

  const selectors = Array.from({ length: 64 }, () => `label:${"k".repeat(32)}=${"v".repeat(128)}`);
  test.each([
    ["array caps", { caps: [] }, "invalid_params"],
    ["seventeen labels", { labels: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, "value"])) }, "too_large"],
    ["rules above 16 KiB", { rules: { in: selectors, out: selectors } }, "too_large"],
    ["credential in view", { cwd: `/work/scp_${"x".repeat(24)}` }, "secret_refused"],
  ] as const)("mirror refuses %s with its wire code", async (_label, invalid, code) => {
    await fixture(target, async ({ bridge }) => {
      const a = await bridge("alpha");
      const b = await bridge("beta");
      const response = await a.call("mirror", { endpoints: [view("invalid", invalid)], full: true });
      expect(response.error?.data.code).toBe(code);
      expect(await rows(b)).not.toEqual(expect.arrayContaining([expect.objectContaining({ address: expect.stringContaining("/alpha/invalid") })]));
      expect(announcements(b, "alpha")).toHaveLength(0);
    });
  });

  test("ordered sync parts sweep offline only on the last part", async () => {
    await fixture(target, async ({ account, bridge }) => {
      const a = await bridge("alpha", [view("first"), view("second"), view("omitted")]);
      const b = await bridge("beta");
      await a.result("mirror", { endpoints: [view("first", { title: "Part one" })], full: true, sync: { id: "ordered", part: 1, parts: 2 } });
      let listed = await rows(b);
      expect(listed.find((row) => row.address === `${account}/alpha/omitted`)?.presence).toBe("online");
      expect(listed.find((row) => row.address === `${account}/alpha/second`)?.presence).toBe("online");
      expect(announcements(b, "alpha").at(-1)).toMatchObject({ full: false, endpoints: [{ title: "Part one" }] });
      await a.result("mirror", { endpoints: [view("second")], full: true, sync: { id: "ordered", part: 2, parts: 2 } });
      listed = await rows(b);
      expect(listed.find((row) => row.address === `${account}/alpha/first`)?.presence).toBe("online");
      expect(listed.find((row) => row.address === `${account}/alpha/second`)?.presence).toBe("online");
      expect(listed.find((row) => row.address === `${account}/alpha/omitted`)?.presence).toBe("offline");
      expect(announcements(b, "alpha").at(-1)).toMatchObject({ full: true });
    });
  });

  test("an out of order sync and its later parts apply as deltas without a sweep", async () => {
    await fixture(target, async ({ account, bridge }) => {
      const a = await bridge("alpha", [view("keep")]);
      const b = await bridge("beta");
      for (const [part, handle] of [
        [1, "first"],
        [3, "third"],
        [2, "second"],
        [4, "fourth"],
      ] as const) {
        await a.result("mirror", { endpoints: [view(handle)], full: true, sync: { id: "broken", part, parts: 4 } });
        const listed = await rows(b);
        expect(listed.find((row) => row.address === `${account}/alpha/keep`)?.presence).toBe("online");
        expect(listed.find((row) => row.address === `${account}/alpha/${handle}`)?.presence).toBe("online");
        expect(announcements(b, "alpha").at(-1)).toMatchObject({ full: false, endpoints: [{ address: `${account}/alpha/${handle}` }] });
      }
      expect(announcements(b, "alpha")).toHaveLength(4);
    });
  });

  test("bridge close announces offline rows, preserves hibernation and hello returns last presence", async () => {
    await fixture(target, async ({ account, connect, bridge }) => {
      const a = await bridge("alpha", [view("active"), view("idle", { presence: "idle" }), view("sleeping", { presence: "hibernated", wake: "hook:runner" })]);
      const b = await bridge("beta");
      await a.close();
      const notice = await waitFor(
        () => announcements(b, "alpha").find((frame) => frame.endpoints.some((row) => row.presence === "offline")),
        "bridge offline announcement",
      );
      expect(notice.full).toBe(false);
      expect(notice.own).toBe(true);
      expect(notice.endpoints.map((row) => [row.address, row.presence]).sort()).toEqual([
        [`${account}/alpha/active`, "offline"],
        [`${account}/alpha/idle`, "offline"],
      ]);
      const b2 = await connect();
      const result = await b2.hello({ machine: "beta-two", bridge: true });
      const endpoints = (result.endpoints as Row[]).filter((row) => row.machine === "alpha");
      expect(endpoints).toHaveLength(3);
      expect(endpoints.find((row) => row.address === `${account}/alpha/active`)?.presence).toBe("offline");
      expect(endpoints.find((row) => row.address === `${account}/alpha/idle`)?.presence).toBe("offline");
      expect(endpoints.find((row) => row.address === `${account}/alpha/sleeping`)).toMatchObject({ presence: "hibernated", wake: "hook:runner" });
    });
  });

  test("forward resolves machine, account and human addresses with the inbound envelope", async () => {
    await fixture(target, async ({ account, bridge }) => {
      const a = await bridge("alpha", [view("source")]);
      const b = await bridge("beta", [view("target"), { address: "me/", kind: "human", presence: "online", labels: {} }]);
      await b.result("subscribe", { after: 0 });
      for (const to of ["beta/target", `${account}/beta/target`, "beta/me"]) {
        const sent = await forward(a, to, { thread: "wire-thread" });
        const delivery = await delivered(b, sent.id);
        expect(delivery.endpoint).toBe(to === "beta/me" ? "beta/" : "beta/target");
        expect(delivery.message).toMatchObject({
          from: { address: `${account}/alpha/source`, user: account },
          to,
          thread: sent.thread,
          kind: "message",
          reply_to: null,
        });
        expect(sent.thread).toBe("wire-thread");
        expect(delivery.message.seq).toBeUndefined();
      }
      for (const to of ["beta/missing", "elsewhere/beta/target"]) {
        expect((await a.call("forward", { from: "source", params: { to, body: "missing" } })).error?.data.code).toBe("not_found");
      }
    });
  });

  test("fan out sends one delivery to each of two machines", async () => {
    await fixture(target, async ({ account, bridge }) => {
      const a = await bridge("alpha", [view("source")]);
      const b = await bridge("beta", [view("target")]);
      const c = await bridge("gamma", [view("target")]);
      await b.result("subscribe", { after: 0 });
      await c.result("subscribe", { after: 0 });
      const sent = await forward(a, ["beta/target", "gamma/target"]);
      for (const [wire, machine] of [
        [b, "beta"],
        [c, "gamma"],
      ] as const) {
        const delivery = await delivered(wire, sent.id);
        expect(delivery).toMatchObject({
          endpoint: `${machine}/target`,
          message: { to: `${account}/${machine}/target`, thread: sent.thread, kind: "message" },
        });
        await rows(wire);
        expect(deliveries(wire, sent.id)).toHaveLength(1);
      }
    });
  });

  test("request and reply_to keep the same thread", async () => {
    await fixture(target, async ({ bridge }) => {
      const a = await bridge("alpha", [view("source")]);
      const b = await bridge("beta", [view("target")]);
      await a.result("subscribe", { after: 0 });
      await b.result("subscribe", { after: 0 });
      const request = await forward(a, "beta/target", { kind: "request" });
      expect((await delivered(b, request.id)).message).toMatchObject({ kind: "request", thread: request.thread });
      const reply = await forward(b, "alpha/source", { kind: "reply", reply_to: request.id }, "target");
      expect(reply.thread).toBe(request.thread);
      expect((await delivered(a, reply.id)).message).toMatchObject({ kind: "reply", reply_to: request.id, thread: request.thread });
    });
  });

  test("a repeated client_id returns one message id and delivers once", async () => {
    await fixture(target, async ({ bridge }) => {
      const a = await bridge("alpha", [view("source")]);
      const b = await bridge("beta", [view("target")]);
      await b.result("subscribe", { after: 0 });
      const first = await forward(a, "beta/target", { client_id: "retry-one" });
      const again = await forward(a, "beta/target", { client_id: "retry-one" });
      expect(again).toMatchObject({ id: first.id, thread: first.thread, duplicate: true });
      await delivered(b, first.id);
      await rows(b);
      expect(deliveries(b, first.id)).toHaveLength(1);
      await b.result("ack", { seqs: deliveries(b, first.id).map((delivery) => delivery.seq) });
      expect(await b.result("subscribe", { after: 0 })).toEqual({ replayed: 0, next: 0 });
    });
  });

  test("hop_floor beyond the hop maximum is loop_guard", async () => {
    await fixture(target, async ({ connect, bridge }) => {
      const a = await connect();
      const info = await a.hello({ machine: "alpha", bridge: true });
      await a.result("mirror", { endpoints: [view("source")], full: true });
      const b = await bridge("beta", [view("target")]);
      const hopMax = (info.limits as { hopMax: number }).hopMax;
      expect(Number.isInteger(hopMax)).toBe(true);
      expect((await a.call("forward", { from: "source", params: { to: "beta/target", body: "too many hops" }, hop_floor: hopMax + 1 })).error?.data.code).toBe(
        "loop_guard",
      );
      expect(await b.result("subscribe", { after: 0 })).toEqual({ replayed: 0, next: 0 });
    });
  });

  test("a recipient whose mirrored inbound rules exclude the sender is not_found", async () => {
    await fixture(target, async ({ bridge }) => {
      const a = await bridge("alpha", [view("source")]);
      const b = await bridge("beta", [view("target", { rules: { in: ["machine:other"] } })]);
      expect((await a.call("forward", { from: "source", params: { to: "beta/target", body: "scoped" } })).error?.data.code).toBe("not_found");
      expect(await b.result("subscribe", { after: 0 })).toEqual({ replayed: 0, next: 0 });
    });
  });

  test("client claim, resume, send, inbox wake, ack, whoami and watched status use raw WS", async () => {
    await fixture(target, async ({ account, connect, bridge }) => {
      const b = await bridge("beta", [view("target"), view("idle", { harness: "worker", presence: "idle" }), view("offline", { presence: "offline" })]);
      await b.result("subscribe", { after: 0 });
      await b.result("watch");
      const client = await connect();
      const claimed = await client.hello({ machine: "cloud", claim: { handle: "client", harness: "cli", labels: { role: "cloud" } } });
      const endpoint = claimed.endpoint as Row;
      expect(endpoint).toMatchObject({ address: `${account}/cloud/client`, kind: "agent", harness: "cli", presence: "online" });
      expect(claimed.preamble).toBeString();
      expect((claimed.preamble as string).length).toBeGreaterThan(0);
      expect(claimed.token).toBeString();
      await client.close();
      const resumed = await connect();
      const bound = await resumed.hello({ machine: "cloud", resume: claimed.token });
      expect(bound.endpoint).toMatchObject({ id: endpoint.id, address: endpoint.address, presence: "online" });
      expect(bound.preamble).toBeString();
      expect(await resumed.result("whoami")).toMatchObject({ id: endpoint.id, address: endpoint.address });
      const filtered = await resumed.result<{ endpoints: Row[] }>("list", { all: true, kind: "agent", harness: "cli", presence: "online" });
      expect(filtered.endpoints.map((row) => row.address).sort()).toEqual([`${account}/beta/target`, endpoint.address].sort());
      const sent = await resumed.result<Sent>("send", { to: "beta/target", body: "client send" });
      expect(await delivered(b, sent.id)).toMatchObject({
        endpoint: "beta/target",
        message: { from: { address: endpoint.address, user: account }, body: { text: "client send" } },
      });
      const start = Date.now();
      let settled = false;
      const pending = resumed.result<{ messages: Delivery["message"][]; next: number }>("inbox", { wait_s: 10 }).finally(() => {
        settled = true;
      });
      try {
        await Bun.sleep(50);
        expect(settled).toBe(false);
        const incoming = await forward(b, "cloud/client", { body: "wake inbox" }, "target");
        const inbox = await pending;
        expect(Date.now() - start).toBeLessThan(4000);
        expect(inbox.messages).toHaveLength(1);
        expect(inbox.messages[0]).toMatchObject({ id: incoming.id, body: { text: "wake inbox" } });
        expect(inbox.messages[0]!.seq).toBeNumber();
        expect(inbox.next).toBe(inbox.messages[0]!.seq!);
        expect(await resumed.result("ack", { seqs: [inbox.next] })).toEqual({ acked: 1 });
        expect(await resumed.result("inbox")).toEqual({ messages: [], next: 0 });
      } finally {
        await resumed.close();
        await pending.catch(() => {});
      }
      const statusClient = await connect();
      await statusClient.hello({ machine: "cloud", resume: claimed.token });
      expect(await statusClient.result("status", { state: "blocked", note: "waiting for input" })).toMatchObject({
        status: { state: "blocked", note: "waiting for input" },
      });
      await waitFor(() => b.notifications("fleet").find((event) => event.type === "status" && event.endpoint === endpoint.address), "watched client status");
      await rows(b);
      expect(b.notifications("fleet")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "status", machine: "cloud", endpoint: endpoint.address, status: { state: "blocked", note: "waiting for input" } }),
        ]),
      );
      expect(announcements(b, "cloud").at(-1)).toMatchObject({
        full: false,
        own: true,
        endpoints: [{ address: endpoint.address, status: { state: "blocked", note: "waiting for input" } }],
      });
    });
  });

  test("observer can discover machines and list filters but cannot send", async () => {
    await fixture(target, async ({ account, connect, bridge }) => {
      await bridge("alpha", [
        view("online"),
        view("idle", { harness: "worker", presence: "idle" }),
        view("offline", { presence: "offline" }),
        { address: "me/", kind: "human", presence: "online" },
      ]);
      const observer = await connect();
      await observer.hello({ observe: true });
      expect(await observer.result("machines")).toMatchObject({ machines: expect.arrayContaining([expect.objectContaining({ name: "alpha" })]) });
      const cases = [
        [{ kind: "agent" }, ["online", "idle", "offline"]],
        [{ kind: "human" }, [""]],
        [{ harness: "worker" }, ["idle"]],
        [{ kind: "agent", presence: "offline" }, ["offline"]],
        [{ kind: "agent", presence: "online", harness: "cli" }, ["online"]],
      ] as const;
      for (const [filter, handles] of cases) {
        const result = await observer.result<{ endpoints: Row[] }>("list", { all: true, ...filter });
        const remote = result.endpoints.filter((row) => row.address.startsWith(`${account}/alpha/`));
        expect(remote.map((row) => row.address).sort()).toEqual(handles.map((handle) => `${account}/alpha/${handle}`).sort());
        expect(result.endpoints.every((row) => !("kind" in filter) || row.kind === filter.kind)).toBe(true);
        expect(result.endpoints.every((row) => !("harness" in filter) || row.harness === filter.harness)).toBe(true);
        expect(result.endpoints.every((row) => !("presence" in filter) || row.presence === filter.presence)).toBe(true);
      }
      expect((await observer.call("send", { to: "alpha/online", body: "observer send" })).error?.data.code).toBe("unauthorized");
    });
  });

  test("HTTP batch hello, list and whoami returns an ordered array", async () => {
    await fixture(target, async ({ account, token }) => {
      const batch = (await rpc(target.url, token, [
        hello({ machine: "cloud", claim: { handle: "client", harness: "cli" } }),
        { id: 2, method: "list", params: { all: true } },
        { id: 3, method: "whoami" },
      ])) as Frame[];
      expect(batch).toHaveLength(3);
      expect(batch.map((frame) => frame.id)).toEqual([1, 2, 3]);
      expect(batch.every((frame) => !frame.error)).toBe(true);
      const claimed = batch[0]!.result as { endpoint: Row; token: string; preamble: string };
      expect(claimed.endpoint.address).toBe(`${account}/cloud/client`);
      expect(claimed.token).toBeString();
      expect(claimed.preamble).toBeString();
      expect((batch[1]!.result as { endpoints: Row[] }).endpoints).toEqual(expect.arrayContaining([expect.objectContaining({ id: claimed.endpoint.id })]));
      expect(batch[2]!.result).toMatchObject({ id: claimed.endpoint.id, address: claimed.endpoint.address });
    });
  });

  test("HTTP batch without an initial hello refuses endpoint methods unauthorized", async () => {
    await fixture(target, async ({ token }) => {
      const batch = (await rpc(target.url, token, [
        { id: 1, method: "list" },
        { id: 2, method: "whoami" },
      ])) as Frame[];
      expect(batch.map((frame) => frame.id)).toEqual([1, 2]);
      expect(batch.map((frame) => frame.error?.data.code)).toEqual(["unauthorized", "unauthorized"]);
    });
  });

  test.skipIf(!slowConformance)(
    "slow: HTTP inbox wait_s 60 is capped at 25 seconds (SCP_CONFORMANCE_SLOW=1)",
    async () => {
      await fixture(target, async ({ token }) => {
        const start = Date.now();
        const batch = (await rpc(target.url, token, [
          hello({ machine: "cloud", claim: { handle: "client", harness: "cli" } }),
          { id: 2, method: "inbox", params: { wait_s: 60 } },
        ])) as Frame[];
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(24000);
        expect(elapsed).toBeLessThan(26500);
        expect(batch.map((frame) => frame.id)).toEqual([1, 2]);
        expect(batch[0]!.error).toBeUndefined();
        expect(batch[1]!.result).toEqual({ messages: [], next: 0 });
      });
    },
    28000,
  );

  test("revoking a live bridge credential notifies then closes 1008 within revalidation", async () => {
    const revocationTarget = new ProcessTarget(name);
    try {
      await revocationTarget.start({ revalidateMs: 2000 });
      await fixture(revocationTarget, async ({ account, bridge }) => {
        const credential = await revocationTarget.mint(account, "member-b", { device: true });
        const wire = await Wire.connect(revocationTarget.url, credential.token);
        try {
          const info = await wire.hello({ machine: "revoked", bridge: true });
          expect(info.limits).toMatchObject({ revalidateMs: 2000 });
          await wire.result("mirror", { endpoints: [view("worker")], full: true });
          const observer = await bridge("beta");
          const start = Date.now();
          await revocationTarget.revoke(credential.credentialId);
          expect(await waitFor(() => wire.closeCode, "revocation close", 5000)).toBe(1008);
          expect(Date.now() - start).toBeLessThan(5000);
          const index = wire.frames.findIndex((frame) => frame.method === "revoked");
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(wire.framesAtClose!);
          expect(wire.notifications("revoked")).toHaveLength(1);
          expect(
            await waitFor(
              () => announcements(observer, "revoked").find((frame) => frame.endpoints.some((row) => row.presence === "offline")),
              "revoked bridge offline rows",
            ),
          ).toMatchObject({ full: false });
        } finally {
          await wire.close();
        }
      });
    } finally {
      await revocationTarget.stop();
    }
  }, 15000);

  test("machines_rm removes rows, announces released and frees the binding", async () => {
    await fixture(target, async ({ account, connect, bridge }) => {
      await bridge("alpha", [view("worker"), view("other")]);
      const b = await bridge("beta");
      const observer = await connect();
      await observer.hello({ observe: true });
      expect(await observer.result("machines_rm", { name: "alpha" })).toEqual({ removed: "alpha", endpoints: 2 });
      expect((await rows(b)).filter((row) => row.address.startsWith(`${account}/alpha/`))).toEqual([]);
      expect(announcements(b, "alpha").at(-1)).toEqual({ machine: "alpha", endpoints: [], full: true, released: true });
      const machines = await observer.result<{ machines: { name: string }[] }>("machines");
      expect(machines.machines.some((machine) => machine.name === "alpha")).toBe(false);
      const newCredential = await target.mint(account, "member-b", { device: true });
      const rebound = await connect(newCredential.token);
      expect(await rebound.hello({ machine: "alpha", bridge: true })).toMatchObject({ machine: "alpha" });
    });
  });

  test("local_events counts valid known endpoint events and ignores unknown endpoints", async () => {
    await fixture(target, async ({ bridge }) => {
      const a = await bridge("alpha", [view("source"), view("target"), view("other")]);
      const b = await bridge("beta", [view("remote")]);
      await b.result("watch");
      const event = { from: "source", to: ["target", "other", "target"], kind: "message", at: Date.now(), id: "a".repeat(32), thread: "b".repeat(32) };
      expect(
        await a.result("local_events", {
          events: [
            event,
            { ...event, kind: "reply", to: ["target"] },
            { ...event, from: "unknown" },
            { ...event, to: ["unknown"] },
            { ...event, to: ["remote"] },
            { ...event, to: ["source"] },
          ],
        }),
      ).toEqual({ recorded: 2 });
      await rows(b);
      const local = b.notifications("fleet").filter((frame) => frame.local === true);
      expect(local).toHaveLength(2);
      expect(local[0]).toMatchObject({ type: "message", machine: "alpha", local: true, id: event.id, thread: event.thread, kind: "message" });
      expect((local[0]!.to as string[]).map((address) => address.split("/").at(-1)).sort()).toEqual(["other", "target"]);
    });
  });

  test("a local event with known and unknown recipients keeps only the known ones", async () => {
    await fixture(target, async ({ bridge }) => {
      const a = await bridge("alpha", [view("source"), view("target")]);
      const b = await bridge("beta");
      await b.result("watch");
      expect(await a.result("local_events", { events: [{ from: "source", to: ["target", "unknown"], kind: "message", at: Date.now() }] })).toEqual({
        recorded: 1,
      });
      await rows(b);
      const local = b.notifications("fleet").filter((frame) => frame.local === true);
      expect(local).toHaveLength(1);
      expect((local[0]!.to as string[]).map((address) => address.split("/").at(-1))).toEqual(["target"]);
    });
  });
});
