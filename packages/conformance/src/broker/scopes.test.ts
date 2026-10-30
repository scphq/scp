import { expect } from "bun:test";
import { waitFor } from "../targets";
import { type BrokerFixture, brokerSuite, test } from "./suite";
import { type BrokerWire, refusal, type View } from "./wire";

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`;
const placed = (broker: BrokerFixture, handle: string, pid: number, parents: number[] = [], extra: Record<string, unknown> = {}) =>
  broker.agent(handle, "codex", {}, { process: key(pid), lineage: [pid, ...parents].map(key), ...extra });
const addresses = (rows: { address: string }[]) => rows.map((e) => e.address).sort();
const send = (wire: BrokerWire, to: string, extra: Record<string, unknown> = {}) => wire.request("send", { to, body: "hello", ...extra });
type Scope = { address: string; rules: { in?: string[] | null; out?: string[] | null }; caps: { id: string; by: string; dir: string; sels: unknown[] }[] };
async function fleet(broker: BrokerFixture) {
  const main = await placed(broker, "main", 100);
  const orch = await placed(broker, "orch", 200, [100]);
  const w = await placed(broker, "w", 300, [200, 100]);
  await w.request("rules_set", { scope: "parent" });
  return { main, orch, w };
}

brokerSuite("broker scopes", (start) => {
  test("lineage places at the nearest full key and bare or environment keys never place", async () => {
    const broker = await start();
    const { main, orch, w } = await fleet(broker);
    expect(w.hello.endpoint).toMatchObject({ parent: orch.address, depth: 2 });
    expect(await main.request("rules", { endpoint: "orch" })).toMatchObject({ tree: main.address, depth: 1 });
    expect(await refusal(w.request("rules", { endpoint: "orch" }))).toBe("not_found");
    expect((await placed(broker, "bare", 400, [], { lineage: ["pid:200"] })).hello.endpoint?.parent).toBeNull();
    expect((await placed(broker, "env", 500, [], { lineage: ["env:200"] })).hello.endpoint?.parent).toBeNull();
  });

  test("presets expand symmetrically and explicit directions override them", async () => {
    const broker = await start();
    const a = await placed(broker, "a", 100, [], { scope: "tree" });
    expect(await a.request("rules")).toMatchObject({
      preset: "tree",
      rules: { in: ["tree:parent", "tree:descendants"], out: ["tree:parent", "tree:descendants"] },
    });
    expect(await a.request("rules_set", { scope: "parent", allow: ["fleet:x"], in: ["*"] })).toMatchObject({
      rules: { in: ["*"], out: ["tree:parent", "fleet:x"] },
    });
    expect(await a.request("rules_set", { allow: ["tree:children"] })).toMatchObject({ rules: { in: ["tree:children"], out: ["tree:children"] } });
    expect(await refusal(a.request("rules_set", { scope: "open", allow: ["*"] }))).toBe("invalid_params");
    expect(await a.request("rules_set", { scope: "open" })).toMatchObject({ preset: "open" });
  });

  test("asymmetric presets set only out", async () => {
    const broker = await start({ policy: { rules: [], defaults: { symmetric_presets: false } } });
    await (await broker.observer()).request("policy");
    const a = await placed(broker, "a", 100, [], { scope: "none" });
    expect((await a.request<Scope>("rules")).rules).toEqual({ out: [] });
  });

  test("lineage shells only narrow their own rules while self shells may loosen", async () => {
    const broker = await start();
    await placed(broker, "main", 100);
    const shell = await broker.wire();
    await shell.hello({ human: true, tty: true, lineage: [key(101), key(100)] });
    await shell.request("rules_set", { out: ["tree:self", "fleet:x"] });
    await shell.request("rules_set", { out: ["tree:self"] });
    await shell.request("rules_set", { scope: "tree" });
    expect(await refusal(shell.request("rules_set", { scope: "open" }))).toBe("scope_refused");
    const own = await broker.observer({ self: [key(101), key(100)], lineage: [key(101), key(100)] });
    expect(await own.request("rules_set", { scope: "open" })).toMatchObject({ preset: "open" });
  });

  test("selector grammar rejects scope words, invalid depth and group:self outside group rules", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    for (const selector of [
      "open",
      "none",
      "tree",
      "parent",
      "self",
      "root",
      "children",
      "descendants",
      "ancestors",
      "siblings",
      "human",
      "me",
      "tree:ancestors:17",
      "tree:descendants:0",
      "tree:cousins",
      "group:self",
      "ep:x*",
    ]) {
      expect(await refusal(a.request("rules_set", { out: [selector] }))).toBe("invalid_params");
    }
    expect(await a.request("rules_set", { out: ["other", "tree:ancestors:16", "ep:open"] })).toMatchObject({
      rules: { out: ["ep:other", "tree:ancestors:16", "ep:open"] },
    });
  });

  test("non-leaving selectors do not cross trees, while ep, fleet and star do", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    await broker.agent("x");
    await send(a, "x");
    await a.request("rules_set", { in: ["tree:self"] });
    expect(await refusal(send(a, "x"))).toBe("not_found");
    for (const sel of ["handle:x", "harness:claude-code", "kind:agent"]) {
      await a.request("rules_set", { out: [sel] });
      expect(await refusal(send(a, "x"))).toBe("not_found");
    }
    for (const sel of ["ep:x", "fleet:x", "fleet:*", "*"]) {
      await a.request("rules_set", { out: [sel] });
      await send(a, "x");
    }
  });

  test("tree selectors are relative to their owner and enforce bounded ancestry", async () => {
    const broker = await start();
    await placed(broker, "r", 100);
    await placed(broker, "c1", 200, [100]);
    await placed(broker, "c2", 300, [100]);
    await placed(broker, "g", 400, [200, 100]);
    const h = await placed(broker, "h", 500, [400, 200, 100]);
    for (const [sel, allowed] of [
      ["tree:root", ["r"]],
      ["tree:parent", ["g"]],
      ["tree:ancestors:1", ["g"]],
      ["tree:ancestors:2", ["c1", "g"]],
      ["tree:ancestors", ["r", "c1", "g"]],
      ["tree:siblings", []],
      ["tree:self", ["r", "c1", "c2", "g"]],
    ] as [string, string[]][]) {
      await h.request("rules_set", { out: [sel] });
      for (const target of ["r", "c1", "c2", "g"]) expect(await refusal(send(h, target))).toBe(allowed.includes(target) ? undefined : "not_found");
    }
  });

  test("list, snapshot, peers and why hide endpoints outside directional reach", async () => {
    const broker = await start();
    const { main, w } = await fleet(broker);
    expect(addresses((await w.request<{ endpoints: View[] }>("list", { all: true })).endpoints)).toEqual(["me/", "me/orch", "me/w"]);
    expect(addresses((await w.request<{ endpoints: View[] }>("snapshot", { all: true })).endpoints)).toEqual(["me/", "me/orch", "me/w"]);
    expect(addresses((await w.request<{ peers: View[] }>("peers")).peers)).toEqual(["me/", "me/orch"]);
    expect(await w.request("why", { from: "w", to: "orch" })).toMatchObject({ allowed: true });
    expect(await refusal(w.request("why", { from: "main", to: "orch" }))).toBe("not_found");
    expect(addresses((await main.request<{ endpoints: View[] }>("list")).endpoints)).toEqual(["me/", "me/main", "me/orch", "me/w"]);
  });

  test("an agent with no list reaches its own tree and the roots until the human widens it", async () => {
    const broker = await start();
    await placed(broker, "main", 100);
    const orch = await placed(broker, "orch", 200, [100]);
    await placed(broker, "w", 300, [200, 100]);
    const r2 = await placed(broker, "r2", 400);
    await placed(broker, "c2", 500, [400]);
    expect(addresses((await orch.request<{ peers: View[] }>("peers", { all: true, historic: true })).peers)).toEqual(["me/", "me/main", "me/r2", "me/w"]);
    expect(addresses((await r2.request<{ peers: View[] }>("peers", { historic: true })).peers)).toEqual(["me/", "me/c2", "me/main"]);
    expect(await refusal(send(orch, "c2"))).toBe("not_found");
    expect(await refusal(send(r2, "w"))).toBe("not_found");
    await send(orch, "r2");
    const listed = (await r2.request<{ endpoints: View[] }>("list", { historic: true })).endpoints.find((e) => e.address === "me/r2");
    expect(Date.parse(String(listed?.active_at))).not.toBeNaN();
    await (await broker.human()).request("rules_set", { endpoint: "r2", out: ["*"] });
    await send(r2, "w");
  });

  test("hidden and missing endpoints have indistinguishable errors", async () => {
    const broker = await start();
    const { w } = await fleet(broker);
    for (const endpoint of ["main", "missing"]) {
      const error = (await w.call("send", { to: endpoint, body: "hello" })).error;
      expect(error?.data?.code).toBe("not_found");
      expect(error).toMatchObject({ code: -32000, data: { code: "not_found" } });
      expect(await refusal(w.request("rules", { endpoint }))).toBe("not_found");
      expect(await refusal(w.request("rules_set", { endpoint, out: [] }))).toBe("not_found");
    }
  });

  test("human without terminal has filtered discovery and no scope administration powers", async () => {
    const broker = await start();
    const { main, w } = await fleet(broker);
    await main.request("rules_set", { in: ["tree:children"] });
    const script = await broker.human(false);
    expect(await refusal(send(script, "main"))).toBe("not_found");
    await send(script, "orch");
    expect(addresses((await script.request<{ endpoints: View[] }>("list", { all: true })).endpoints)).toEqual(["me/", "me/orch"]);
    expect(addresses((await script.request<{ peers: View[] }>("peers")).peers)).toEqual(["me/orch"]);
    expect(await refusal(script.request("rules_set", { endpoint: "w", in: [] }))).toBe("scope_refused");
    expect(await refusal(script.request("grant", { under: "main" }))).toBe("scope_refused");
    expect(await refusal(script.request("group", { action: "create", name: "team" }))).toBe("scope_refused");
    expect(await refusal(script.request("admin", { action: "grant", subject: "orch", tree: "main" }))).toBe("scope_refused");
    const h = await broker.human();
    await send(h, "w");
    await send(w, "me/");
    expect(addresses((await h.request<{ endpoints: View[] }>("list")).endpoints)).toEqual(["me/", "me/main", "me/orch", "me/w"]);
  });

  test("observer lineage narrows the view and only self attestation permits sending", async () => {
    const broker = await start();
    await fleet(broker);
    const shell = await broker.observer({ lineage: [key(301), key(300), key(200)] });
    expect(shell.hello.endpoint).toBeNull();
    expect(await shell.request("rules")).toMatchObject({ address: "me/w" });
    expect(await refusal(send(shell, "orch"))).toBe("unauthorized");
    await shell.request("rules_set", { in: [] });
    expect(await refusal(shell.request("rules_widen", { endpoint: "w", out: ["*"] }))).toBe("scope_refused");
    const own = await broker.observer({ self: [key(301), key(300)], lineage: [key(301), key(300), key(200)] });
    expect(own.hello.endpoint?.address).toBe("me/w");
    await send(own, "orch");
    const bare = await broker.observer();
    expect(await refusal(bare.request("rules"))).toBe("unauthorized");
  });

  test("a self walk binds the nearest endpoint, while an unplaced self only observes by lineage", async () => {
    const broker = await start();
    await fleet(broker);
    const own = await broker.observer({ self: [302, 301, 300, 200].map(key), lineage: [302, 301, 300, 200, 100].map(key) });
    expect(own.hello.endpoint?.address).toBe("me/w");
    const stray = await broker.observer({ self: [key(999)], lineage: [999, 200, 100].map(key) });
    expect(stray.hello.endpoint).toBeNull();
    expect(await stray.request("rules")).toMatchObject({ address: "me/orch" });
    expect(await refusal(stray.request("title", { text: "no" }))).toBe("unauthorized");
  });

  test("hook connections cannot call scope methods", async () => {
    const broker = await start();
    await placed(broker, "main", 100);
    const h = await broker.hook({ handle: "main", harness: "codex", process: key(100), session: "env:hook" });
    for (const [method, params] of [
      ["rules", {}],
      ["rules_set", { in: [] }],
      ["rules_widen", { endpoint: "main", out: ["*"] }],
      ["rules_lift", { endpoint: "main", cap: "cap_x" }],
      ["grant", {}],
      ["group", { action: "ls" }],
      ["admin", { action: "ls" }],
      ["peers", {}],
      ["why", { from: "main", to: "me/" }],
      ["spawn_exit", { grant: `krt_${"0".repeat(64)}`, code: 0 }],
    ] as [string, Record<string, unknown>][])
      expect(await refusal(h.request(method, params))).toBe("scope_refused");
  });

  test("widening and lifting require authority and self auth permits both", async () => {
    const broker = await start();
    const { main, orch, w } = await fleet(broker);
    const cap = (await orch.request<Scope>("rules_set", { endpoint: "w", out: ["tree:parent"] })).caps.find((c) => c.by === orch.address)!;
    expect(await refusal(w.request("rules_lift", { endpoint: "w", cap: cap.id }))).toBe("scope_refused");
    const plain = await broker.observer({ lineage: [key(201), key(200)] });
    expect(await refusal(plain.request("rules_lift", { endpoint: "w", cap: cap.id }))).toBe("scope_refused");
    const own = await broker.observer({ self: [key(201), key(200)], lineage: [key(201), key(200)] });
    expect(await own.request("rules_widen", { endpoint: "w", out: ["tree:root"] })).toMatchObject({ added: ["tree:root"] });
    expect((await own.request<Scope>("rules_lift", { endpoint: "w", cap: cap.id })).caps.map((c) => c.id)).not.toContain(cap.id);
    expect(await refusal(main.request("rules_lift", { endpoint: "w", cap: cap.id }))).toBe("not_found");
  });

  test("ancestor traffic passes caps and reply grants pass both directions repeatedly", async () => {
    const broker = await start();
    const { main, w } = await fleet(broker);
    await main.request("rules_set", { in: ["tree:children"] });
    expect(await refusal(send(w, "main"))).toBe("not_found");
    const asked = await main.request<{ id: string }>("send", { to: "w", body: "status?", kind: "request" });
    await w.request("rules_set", { out: [] });
    for (let i = 0; i < 2; i++) await send(w, "main", { kind: "reply", reply_to: asked.id });
    expect(await refusal(send(w, "main", { kind: "message", reply_to: asked.id }))).toBe("not_found");
  });

  test("watch events respect visibility", async () => {
    const broker = await start();
    const { main, orch, w } = await fleet(broker);
    await w.request("watch");
    await main.request("status", { state: "working", note: "hidden" });
    await orch.request("status", { state: "working", note: "visible" });
    await waitFor(() => w.fleet("status").length === 1, "visible status");
    expect(w.fleet("status").map((e) => e.endpoint)).toEqual(["me/orch"]);
  });

  test("groups require authority and members cannot leave ruled groups", async () => {
    const broker = await start();
    const { main, orch, w } = await fleet(broker);
    await orch.request("group", { action: "create", name: "team", rules: ["group:self", "tree:parent"] });
    expect(await refusal(orch.request("group", { action: "create", name: "team" }))).toBe("invalid_params");
    expect(await refusal(orch.request("group", { action: "create", name: "self" }))).toBe("invalid_params");
    await orch.request("group", { action: "add", name: "team", endpoint: "w" });
    expect(await w.request("rules")).toMatchObject({ groups: ["team"] });
    expect(await refusal(w.request("group", { action: "remove", name: "team" }))).toBe("scope_refused");
    expect(await main.request("group", { action: "remove", name: "team", endpoint: "w" })).toMatchObject({ member: false });
    expect(await w.request("rules")).toMatchObject({ groups: [] });
  });

  test("only terminal human pins groups and grants admins; admins gain authority without a send exemption", async () => {
    const broker = await start();
    const { main, orch } = await fleet(broker);
    const adm = await broker.agent("adm");
    await orch.request("rules_set", { endpoint: "w", in: [], out: [] });
    await main.request("group", { action: "create", name: "team" });
    expect(await refusal(main.request("group", { action: "pin", name: "team" }))).toBe("scope_refused");
    expect(await refusal(main.request("admin", { action: "grant", subject: "adm", tree: "main" }))).toBe("scope_refused");
    const human = await broker.human();
    await human.request("group", { action: "pin", name: "team" });
    await human.request("admin", { action: "grant", subject: "adm", tree: "w" });
    expect(await refusal(send(adm, "w"))).toBe("scope_refused");
    expect(await adm.request("admin", { action: "ls" })).toMatchObject([{ subject: "me/adm", tree: "me/main" }]);
    expect(await adm.request("rules_widen", { endpoint: "w", out: ["ep:orch"] })).toMatchObject({ added: ["ep:orch"] });
    await human.request("admin", { action: "revoke", subject: "adm", tree: "main" });
  });

  test("unnameable groups refuse selectors at set and claim time without revealing their existence", async () => {
    const broker = await start();
    const main = await placed(broker, "main", 100);
    const x = await placed(broker, "x", 900);
    await x.request("group", { action: "create", name: "theirs" });
    for (const name of ["theirs", "missing"]) {
      expect(await refusal(main.request("rules_set", { in: [`group:${name}`] }))).toBe("invalid_params");
      expect(await refusal(main.request("grant", { in: [`group:${name}`] }))).toBe("invalid_params");
      expect(await refusal(placed(broker, "k", 500, [], { in: [`group:${name}`] }))).toBe("invalid_params");
    }
    expect((await main.request<{ endpoints: View[] }>("list")).endpoints.map((e) => e.address)).not.toContain("me/k");
  });

  test("group identities survive neither drop nor recreation and admin rows become stale", async () => {
    const broker = await start();
    const main = await placed(broker, "main", 100);
    const g = await placed(broker, "g", 200, [100]);
    const x = await placed(broker, "x", 900);
    const human = await broker.human();
    await main.request("group", { action: "create", name: "team" });
    await main.request("group", { action: "add", name: "team", endpoint: "g" });
    await main.request("rules_set", { in: ["group:team"] });
    await human.request("admin", { action: "grant", subject: "x", group: "team" });
    await send(g, "main");
    await main.request("group", { action: "drop", name: "team" });
    await main.request("group", { action: "create", name: "team" });
    await main.request("group", { action: "add", name: "team", endpoint: "g" });
    expect(await refusal(send(g, "main"))).toBe("not_found");
    expect(await x.request("admin", { action: "ls" })).toMatchObject([{ stale: true }]);
    await main.request("rules_set", { in: ["group:team"] });
    await send(g, "main");
    await human.request("admin", { action: "grant", subject: "x", group: "team" });
    expect(await x.request("admin", { action: "ls" })).toMatchObject([{ subject: "me/x", group: "team" }]);
  });

  test("inherited caps derive live and only terminal human lifts them per direction", async () => {
    const broker = await start();
    const main = await placed(broker, "main", 100);
    const parent = await placed(broker, "parent", 200, [100]);
    const child = await placed(broker, "child", 300, [200, 100]);
    const x = await broker.agent("x");
    await send(child, "x");
    await main.request("rules_set", { endpoint: "parent", out: ["tree:parent"] });
    expect(await refusal(send(child, "x"))).toBe("not_found");
    const human = await broker.human();
    const caps = (await human.request<Scope>("rules", { endpoint: "child" })).caps;
    expect(caps.map((c) => c.id)).toContain("inherited:out");
    expect(await refusal(parent.request("rules_lift", { endpoint: "child", cap: "inherited:out" }))).toBe("scope_refused");
    await human.request("rules_lift", { endpoint: "child", cap: "inherited:out" });
    await human.request("rules_lift", { endpoint: "child", cap: "inherited:in" });
    await send(child, x.address);
  });

  test("snapshot unread counts only visible endpoints with unread mail", async () => {
    const broker = await start();
    const { main, orch, w } = await fleet(broker);
    await send(main, "w");
    await send(main, "orch");
    expect(await w.request("snapshot")).toMatchObject({ unread: { "me/w": 1 } });
    expect(await orch.request("snapshot")).toMatchObject({ unread: { "me/orch": 1 } });
  });
});

brokerSuite("broker scope bounds", (start) => {
  test("depth above 32 is refused without spending a grant", async () => {
    const broker = await start();
    let parent = await placed(broker, "n0", 1000);
    for (let depth = 1; depth <= 32; depth++) parent = await placed(broker, `n${depth}`, 1000 + depth, [999 + depth]);
    expect(parent.hello.endpoint?.depth).toBe(32);
    const { token } = await parent.request<{ token: string }>("grant", { name: "deep", spawn: true });
    expect(await refusal(placed(broker, "deep", 2000, [1032], { grant: token }))).toBe("scope_refused");
    expect(await parent.request("spawn_steers", { grant: token })).toMatchObject({ joined: false });
  }, 30_000);

  test("fan-out cap applies to the total recipients across groups", async () => {
    const broker = await start();
    const owner = await placed(broker, "owner", 100);
    for (let g = 0; g < 3; g++) {
      await owner.request("group", { action: "create", name: `g${g}` });
      await owner.request("group", { action: "add", name: `g${g}` });
      await Promise.all(
        Array.from({ length: 30 }, async (_, i) => {
          const name = `w${g}-${i}`;
          await placed(broker, name, 1000 + g * 100 + i, [100]);
          await owner.request("group", { action: "add", name: `g${g}`, endpoint: name });
        }),
      );
    }
    expect(await refusal(owner.request("send", { to: ["group:g0", "group:g1", "group:g2"], body: "ninety" }))).toBe("too_large");
    expect((await owner.request<{ deliveries: unknown[] }>("send", { to: ["group:g0", "group:g1"], body: "sixty" })).deliveries).toHaveLength(60);
  }, 30_000);
});
