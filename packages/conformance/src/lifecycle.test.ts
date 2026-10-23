import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { EndpointView } from "@scp-dev/core";
import { ensureBuilt, Machine } from "./machines";
import { delivered, scenario, view } from "./scenarios";
import { enabled, ProcessTarget, targetNames, waitFor } from "./targets";

type Row = { address: string; historic?: true; [key: string]: unknown };
const tree = (root: string, child: string) => [view(root), view(child, { tree: root, parent_ep: root, depth: 1 })];
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe.each(targetNames)("%s default reach conformance", (name) => {
  if (!enabled(name)) {
    test.skip("requires SCP_RELAY_BIN");
    return;
  }
  test("through the hub an agent reaches its own tree and every root, never another tree's child", async () => {
    await scenario(name, async ({ bridge }) => {
      const alpha = await bridge("acme", "alpha", tree("ra", "ka"));
      const beta = await bridge("acme", "beta", tree("rb", "kb"));
      const sent = await alpha.result<{ id: string }>("forward", { from: "ka", params: { to: "beta/rb", body: "to the other root" } });
      expect((await delivered(beta, sent.id)).endpoint).toBe("beta/rb");
      const refused = async (from: string, to: string) => (await alpha.call("forward", { from, params: { to, body: "x" } })).error?.data.code;
      expect(await refused("ka", "beta/kb")).toBe("not_found");
      expect(await refused("ra", "beta/kb")).toBe("not_found");
      const back = await beta.result<{ id: string }>("forward", { from: "kb", params: { to: "alpha/ra", body: "to the first root" } });
      expect((await delivered(alpha, back.id)).endpoint).toBe("alpha/ra");
    });
  }, 30000);
});

describe.each(targetNames)("%s default reach across bridged brokers", (name) => {
  if (!enabled(name)) {
    test.skip("requires SCP_RELAY_BIN");
    return;
  }
  const target = new ProcessTarget(name);
  const machines: Machine[] = [];
  beforeAll(async () => {
    ensureBuilt();
    await target.start();
    const { token } = await target.mint("acme", "ada", { device: true });
    machines.push(new Machine("laptop", target, token), new Machine("desk", target, token));
    await Promise.all(machines.map((machine) => machine.start()));
  }, 60000);
  afterAll(async () => {
    await Promise.allSettled(machines.map((machine) => machine.stop()));
    await target.stop();
  });
  test("a child's list through the hub shows the other machine's root but not its child", async () => {
    const [laptop, desk] = machines as [Machine, Machine];
    await laptop.child(await laptop.claim("lroot"), "lkid");
    const dkid = await desk.child(await desk.claim("droot"), "dkid");
    const list = async () => (await dkid.request<{ endpoints: EndpointView[] }>("list", { all: true })).endpoints.map((e) => e.address);
    await waitFor(async () => (await desk.list()).some((e) => e.address === "me/laptop/lkid"), "laptop/lkid mirrored to desk");
    const seen = await list();
    expect(seen).toContain("me/laptop/lroot");
    expect(seen).toContain("me/droot");
    expect(seen).not.toContain("me/laptop/lkid");
    expect((await dkid.request<{ deliveries: object[] }>("send", { to: "laptop/lroot", body: "hello root" })).deliveries).toHaveLength(1);
    await expect(dkid.request("send", { to: "laptop/lkid", body: "hello child" })).rejects.toMatchObject({ code: "not_found" });
  }, 60000);
});

describe.each(targetNames)("%s historic conformance", (name) => {
  if (!enabled(name)) {
    test.skip("requires SCP_RELAY_BIN");
    return;
  }
  test("an agent idle past historicAfterS leaves the hub list and the graph until asked for, and a message to it brings it back", async () => {
    await scenario(
      name,
      async ({ target, bridge }) => {
        const idle = ago(10 * 60_000);
        const alpha = await bridge("acme", "alpha", [view("sleeper", { presence: "offline", last_seen: idle, active_at: idle })]);
        const beta = await bridge("acme", "beta", [view("caller")]);
        const { token } = await target.mint("acme", "owner");
        const dashboard = async (query = "") => {
          const response = await fetch(`${target.url}/v1/dashboard/graph${query}`, { headers: { authorization: `Bearer ${token}` } });
          expect(response.status).toBe(200);
          return ((await response.json()) as { nodes: Row[] }).nodes;
        };
        const listed = async (params: object = {}) => (await alpha.result<{ endpoints: Row[] }>("list", params)).endpoints;
        const sleeper = (rows: Row[]) => rows.find((row) => row.address === "acme/alpha/sleeper");
        await Bun.sleep(1100);
        expect(sleeper(await dashboard())).toBeUndefined();
        expect(sleeper(await listed())).toBeUndefined();
        expect(sleeper(await dashboard("?historic=1"))).toMatchObject({ historic: true });
        expect(sleeper(await dashboard("?historic=true"))).toMatchObject({ historic: true });
        expect(sleeper(await listed({ historic: true }))).toMatchObject({ historic: true });
        expect(sleeper(await listed({ all: true }))).toMatchObject({ historic: true });
        await beta.result("forward", { from: "caller", params: { to: "alpha/sleeper", body: "wake up" } });
        const back = await waitFor(async () => sleeper(await dashboard()), "the sleeper back in the graph", 900);
        expect(back.historic).toBeUndefined();
      },
      { historicAfterS: 1 },
    );
  }, 30000);
});
