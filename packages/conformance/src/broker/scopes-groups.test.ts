import { expect, test } from "bun:test";
import { brokerSuite, type BrokerFixture } from "./suite";
import { type BrokerWire, refusal } from "./wire";

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`;
const placed = (broker: BrokerFixture, handle: string, pid: number, parents: number[] = []) =>
  broker.agent(handle, "codex", {}, { process: key(pid), lineage: [pid, ...parents].map(key) });
const send = (wire: BrokerWire, to: string) => wire.request("send", { to, body: "hi" });
type Scope = { caps: { id: string; by: string; dir: string }[]; groups: string[] };
async function fleet(broker: BrokerFixture) {
  const main = await placed(broker, "main", 100);
  const la = await placed(broker, "la", 200, [100]);
  const lb = await placed(broker, "lb", 300, [100]);
  const wa = await placed(broker, "wa", 400, [200, 100]);
  const wb = await placed(broker, "wb", 500, [300, 100]);
  const wc = await placed(broker, "wc", 600, [200, 100]);
  for (const [parent, endpoint] of [
    [la, "wa"],
    [la, "wc"],
    [lb, "wb"],
  ] as const)
    await parent.request("rules_set", { endpoint, scope: "parent" });
  return { main, la, lb, wa, wb, wc };
}

brokerSuite("broker group authority and widening", (start) => {
  test("widening an ep selector mirrors the opposite side when both endpoints are under authority", async () => {
    const broker = await start();
    const { la, wa } = await fleet(broker);
    expect(await refusal(send(wa, "wc"))).toBe("not_found");
    expect(await la.request("rules_widen", { endpoint: "wa", out: ["ep:wc"] })).toEqual({
      added: ["ep:wc"],
      clipped: [],
      mirrored: [{ endpoint: "me/wc", dir: "in", added: ["ep:wa"] }],
    });
    await send(wa, "wc");
    const rows = await la.request<{ rows: { event: string }[] }>("log", { scope: true });
    expect(rows.rows.some((r) => r.event === "scope_widen")).toBe(true);
  });

  test("an in widening mirrors the other endpoint's out side", async () => {
    const broker = await start();
    const { la, wa } = await fleet(broker);
    expect(await la.request("rules_widen", { endpoint: "wc", in: ["ep:wa"] })).toMatchObject({
      mirrored: [{ endpoint: "me/wa", dir: "out", added: ["ep:wc"] }],
    });
    await send(wa, "wc");
  });

  test("widening without authority reports the other end's refusal", async () => {
    const broker = await start();
    const { la, lb, wa } = await fleet(broker);
    await lb.request("rules_set", { in: ["ep:la", "ep:main"] });
    expect(await la.request("rules_widen", { endpoint: "wa", out: ["ep:lb"] })).toMatchObject({
      added: ["ep:lb"],
      clipped: [],
      refused: [{ endpoint: "me/lb", dir: "in" }],
    });
    expect(await refusal(send(wa, "lb"))).toBe("not_found");
  });

  test("unseen and missing widening targets receive indistinguishable refusals", async () => {
    const broker = await start();
    const { la, wa } = await fleet(broker);
    for (const name of ["wb", "missing"]) {
      expect(await la.request("rules_widen", { endpoint: "wa", out: [`ep:${name}`] })).toMatchObject({
        refused: [{ endpoint: `me/${name}`, dir: "in", unseen: true }],
      });
      expect(await refusal(send(wa, name))).toBe("not_found");
    }
  });

  test("authority membership opens lateral reach and removal or drop removes the allowance", async () => {
    const broker = await start();
    const { main, wa, wb } = await fleet(broker);
    expect(await refusal(send(wa, "wb"))).toBe("not_found");
    await main.request("group", { action: "create", name: "qa" });
    for (const endpoint of ["wa", "wb"]) await main.request("group", { action: "add", name: "qa", endpoint });
    await send(wa, "wb");
    await send(wb, "wa");
    expect(await wa.request("why", { from: "wa", to: "wb" })).toMatchObject({ allowed: true });
    expect(await wa.request("send", { to: "group:qa", body: "all" })).toMatchObject({ deliveries: [{ address: "me/wb" }] });
    await main.request("group", { action: "remove", name: "qa", endpoint: "wb" });
    expect(await refusal(send(wa, "wb"))).toBe("not_found");
    expect(JSON.stringify(await main.request("rules", { endpoint: "wb" }))).not.toContain("group:qa");
    await main.request("group", { action: "add", name: "qa", endpoint: "wb" });
    await send(wb, "wa");
    await main.request("group", { action: "drop", name: "qa" });
    expect(await refusal(send(wb, "wa"))).toBe("not_found");
  });

  test("self membership adds no lateral allowance and human quarantine still caps authority membership", async () => {
    const broker = await start();
    const { main, wa, wb } = await fleet(broker);
    await main.request("group", { action: "create", name: "qa" });
    await wa.request("group", { action: "add", name: "qa" });
    await wb.request("group", { action: "add", name: "qa" });
    expect(await refusal(send(wa, "wb"))).toBe("not_found");
    for (const endpoint of ["wa", "wb"]) await main.request("group", { action: "add", name: "qa", endpoint });
    await send(wa, "wb");
    const human = await broker.human();
    await human.request("rules_set", { endpoint: "wa", out: [] });
    expect(await refusal(send(wa, "wb"))).toBe("not_found");
    await send(wb, "wa");
    await human.request("rules_set", { endpoint: "wa", in: [] });
    expect(await refusal(send(wb, "wa"))).toBe("not_found");
  });

  test("explicit group widening outlives membership removal", async () => {
    const broker = await start();
    const { main } = await fleet(broker);
    await main.request("group", { action: "create", name: "qa" });
    for (const endpoint of ["wa", "wb"]) await main.request("group", { action: "add", name: "qa", endpoint });
    await main.request("rules_widen", { endpoint: "wa", out: ["group:qa"] });
    await main.request("group", { action: "remove", name: "qa", endpoint: "wa" });
    expect(JSON.stringify(await main.request("rules", { endpoint: "wa" }))).toContain("group:qa");
  });

  test("group discovery filters members and hides groups from outsiders", async () => {
    const broker = await start();
    const { main, la, wa, wb, wc } = await fleet(broker);
    await la.request("group", { action: "create", name: "team", rules: ["group:self"] });
    for (const endpoint of ["wa", "wc"]) await la.request("group", { action: "add", name: "team", endpoint });
    await wc.request("rules_set", { scope: "none" });
    expect(await wb.request<unknown[]>("group", { action: "ls" })).toEqual([]);
    expect(await refusal(wb.request("group", { action: "show", name: "team" }))).toBe("not_found");
    expect(await main.request("group", { action: "show", name: "team" })).toMatchObject({ members: ["me/wa", "me/wc"] });
    expect(await wa.request("group", { action: "show", name: "team" })).toMatchObject({ members: ["me/wa"] });
    expect(await wc.request("group", { action: "show", name: "team" })).toMatchObject({ members: ["me/wc"] });
  });

  test("a group steward can remove an unreachable member but ordinary members cannot", async () => {
    const broker = await start();
    const owner = await broker.agent("owner");
    const x = await broker.agent("x");
    const y = await broker.agent("y");
    await x.request("rules_set", { in: [] });
    await y.request("rules_set", { scope: "none" });
    await owner.request("group", { action: "create", name: "crew" });
    const human = await broker.human();
    for (const endpoint of ["x", "y"]) await human.request("group", { action: "add", name: "crew", endpoint });
    expect(await owner.request("group", { action: "show", name: "crew" })).toMatchObject({ members: ["me/x", "me/y"] });
    expect(await refusal(y.request("group", { action: "remove", name: "crew", endpoint: "x" }))).toBe("not_found");
    expect(await owner.request("group", { action: "remove", name: "crew", endpoint: "x" })).toMatchObject({ member: false });
  });

  test("dropping or loosening a ruled group requires authority over every member", async () => {
    const broker = await start();
    const { la } = await fleet(broker);
    await broker.agent("x");
    await la.request("group", { action: "create", name: "team", rules: ["group:self"] });
    await la.request("group", { action: "add", name: "team", endpoint: "wa" });
    const human = await broker.human();
    await human.request("group", { action: "add", name: "team", endpoint: "x" });
    expect(await refusal(la.request("group", { action: "drop", name: "team" }))).toBe("scope_refused");
    expect(await refusal(la.request("group", { action: "rules", name: "team", out: ["group:self", "*"] }))).toBe("scope_refused");
    await human.request("group", { action: "drop", name: "team" });
  });

  test("an owner inside its ruled group may loosen and drop it", async () => {
    const broker = await start();
    const { la } = await fleet(broker);
    await la.request("group", { action: "create", name: "team", rules: ["group:self"] });
    await la.request("group", { action: "add", name: "team" });
    await la.request("group", { action: "add", name: "team", endpoint: "wa" });
    await la.request("group", { action: "rules", name: "team", out: ["group:self", "*"] });
    expect(await la.request("group", { action: "drop", name: "team" })).toEqual({ name: "team", dropped: true });
  });

  test("unpinned group selectors cannot cross trees, pinning makes them leaving selectors", async () => {
    const broker = await start();
    const main = await broker.agent("main");
    const x = await broker.agent("x");
    await x.request("group", { action: "create", name: "reviewers" });
    await x.request("group", { action: "add", name: "reviewers" });
    expect(await refusal(main.request("rules_set", { in: ["group:reviewers"] }))).toBe("invalid_params");
    const human = await broker.human();
    await human.request("group", { action: "pin", name: "reviewers" });
    await main.request("rules_set", { in: ["group:reviewers"] });
    await send(x, "main");
    await human.request("group", { action: "unpin", name: "reviewers" });
    expect(await refusal(send(x, "main"))).toBe("not_found");
  });

  test("a plain shell cannot rebind selectors to a recreated group", async () => {
    const broker = await start();
    const { main, wa } = await fleet(broker);
    const team = async () => {
      await main.request("group", { action: "create", name: "team" });
      await main.request("group", { action: "add", name: "team", endpoint: "wb" });
    };
    await team();
    await wa.request("rules_set", { out: ["group:team"] });
    await main.request("rules_set", { endpoint: "wa", out: ["group:team"] });
    await main.request("group", { action: "drop", name: "team" });
    await team();
    const shell = await broker.wire();
    await shell.hello({ human: true, lineage: [key(401), key(400)] });
    expect(await refusal(shell.request("rules_set", { out: ["group:team"] }))).toBe("scope_refused");
    expect(await refusal(send(wa, "wb"))).toBe("not_found");
    expect((await main.request<Scope>("rules", { endpoint: "wb" })).groups).toEqual(["team"]);
  });
});

brokerSuite("broker group and scope privacy", (start) => {
  test("taken group names are refused for visible and hidden owners", async () => {
    const broker = await start();
    const a = await placed(broker, "a", 100);
    const kid = await placed(broker, "kid", 200, [100]);
    const loner = await broker.agent("loner", "codex", {}, { scope: "none" });
    await a.request("group", { action: "create", name: "team" });
    expect((await kid.call("group", { action: "create", name: "team" })).error).toMatchObject({ code: -32602, data: { code: "invalid_params" } });
    expect((await loner.call("group", { action: "create", name: "team" })).error).toMatchObject({ code: -32602, data: { code: "invalid_params" } });
  });

  test("scope views redact hidden parents, roots and wideners", async () => {
    const broker = await start();
    const { main, wa } = await fleet(broker);
    const adm = await broker.agent("adm");
    const human = await broker.human();
    await human.request("admin", { action: "grant", subject: "adm", tree: "main" });
    await adm.request("rules_widen", { endpoint: "wa", out: ["tree:root"] });
    await wa.request("rules_set", { scope: "parent" });
    const own = await wa.request("rules");
    expect(own).toMatchObject({ tree: null, parent: "me/la" });
    expect(JSON.stringify(own)).not.toContain("me/main");
    expect(JSON.stringify(own)).not.toContain("me/adm");
    expect(await human.request("rules", { endpoint: "wa" })).toMatchObject({ tree: "me/main" });
    expect(await main.request("why", { from: "wa", to: "la" })).toMatchObject({ allowed: true });
  });

  test("widening clips through the widener and later narrowing shrinks derived reach", async () => {
    const broker = await start();
    const main = await placed(broker, "main", 100);
    const c = await placed(broker, "c", 200, [100]);
    const g = await placed(broker, "g", 300, [200, 100]);
    await broker.agent("other");
    await main.request("rules_set", { out: ["tree:self", "fleet:other"] });
    await main.request("rules_set", { endpoint: "c", out: ["tree:self"] });
    await c.request("rules_set", { endpoint: "g", out: ["tree:self"] });
    expect(await refusal(c.request("rules_widen", { endpoint: "g", out: ["fleet:other"] }))).toBe("scope_refused");
    await main.request("rules_widen", { endpoint: "c", out: ["fleet:other"] });
    await c.request("rules_widen", { endpoint: "g", out: ["fleet:other"] });
    await send(g, "other");
    await main.request("rules_set", { out: ["tree:self"] });
    expect(await refusal(send(c, "other"))).toBe("not_found");
    expect(await refusal(send(g, "other"))).toBe("not_found");
  });
});
