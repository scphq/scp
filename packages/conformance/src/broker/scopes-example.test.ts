import { expect, test } from "bun:test";
import { brokerSuite } from "./suite";
import { type BrokerWire, refusal, type View } from "./wire";

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`;
type Grant = { token: string };

brokerSuite("broker scoped fleet", (start) => {
  test("the fleet reachability table holds through send, why and discovery", async () => {
    const broker = await start();
    const wires: Record<string, BrokerWire> = {};
    wires.main = await broker.agent("main", "claude-code", {}, { process: key(100), lineage: [key(100)] });
    await wires.main.request("rules_set", { in: ["tree:children"] });
    for (const [n, name] of ["a", "b", "c"].entries()) {
      const allow = ["tree:parent", "tree:siblings", "tree:children", ...(name === "a" ? ["fleet:app-main"] : [])];
      const { token } = await wires.main.request<Grant>("grant", { name: `orch-${name}`, scope: "none", allow });
      const pid = 200 + n * 100;
      const orch = await broker.agent(`orch-${name}`, "codex", {}, { process: key(pid), lineage: [key(pid), key(100)], grant: token });
      wires[`orch-${name}`] = orch;
      await orch.request("group", { action: "create", name: `team-${name}`, rules: ["group:self", "tree:parent"] });
      for (let i = 1; i <= 4; i++) {
        const grant = await orch.request<Grant>("grant", { name: `${name}${i}`, groups: [`team-${name}`] });
        wires[`${name}${i}`] = await broker.agent(
          `${name}${i}`,
          "codex",
          {},
          { process: key(pid + 10 * i), lineage: [key(pid + 10 * i), key(pid), key(100)], grant: grant.token },
        );
      }
    }
    wires["app-main"] = await broker.agent("app-main");
    wires.human = await broker.human();
    const columns = ["main", "orch-a", "orch-b", "a1", "a2", "b1", "app-main", "human"];
    const table: Record<string, (boolean | null)[]> = {
      main: [null, true, true, true, true, true, false, true],
      "orch-a": [true, null, true, true, true, false, true, true],
      "orch-b": [true, true, null, false, false, true, false, true],
      a1: [false, true, false, null, true, false, false, true],
      "app-main": [false, true, false, false, false, false, null, true],
      human: [true, true, true, true, true, true, true, null],
    };
    for (const [from, row] of Object.entries(table)) {
      await Promise.all(
        columns.map(async (to, i) => {
          const allowed = row[i];
          if (allowed === null) return;
          const address = to === "human" ? "me/" : `me/${to}`;
          const [code, why] = await Promise.all([
            refusal(wires[from]!.request("send", { to: address, body: `${from} to ${to}` })),
            wires.human!.request("why", { from: from === "human" ? "me/" : from, to: address }),
          ]);
          expect([from, to, code]).toEqual([from, to, allowed ? undefined : "not_found"]);
          expect(why).toMatchObject({ allowed });
        }),
      );
    }
    expect(await wires.human!.request("rules", { endpoint: "orch-a" })).toMatchObject({ parent: "me/main", depth: 1, preset: "custom" });
    expect(await wires.human!.request("rules", { endpoint: "a3" })).toMatchObject({ parent: "me/orch-a", depth: 2, groups: ["team-a"] });
    const seen = (await wires.a1!.request<{ endpoints: View[] }>("list", { all: true })).endpoints.map((e) => e.address);
    expect(seen).toContain("me/orch-a");
    expect(seen).toContain("me/a2");
    expect(seen).not.toContain("me/main");
    expect(seen).not.toContain("me/b1");
  }, 30_000);

  test("absolute and relative selectors match their documented endpoint sets in policy checks", async () => {
    const broker = await start();
    await broker.agent("r", "codex", {}, { process: key(100) });
    await broker.agent("c1", "codex", {}, { process: key(200), lineage: [key(200), key(100)] });
    await broker.agent("c2", "grok", {}, { process: key(300), lineage: [key(300), key(100)] });
    await broker.agent("g", "codex", {}, { process: key(400), lineage: [key(400), key(200), key(100)], labels: { lane: "relay" } });
    await broker.agent("h", "codex", {}, { process: key(500), lineage: [key(500), key(400), key(200), key(100)] });
    const human = await broker.human();
    for (const [owner, sel, hits] of [
      ["g", "tree:self", ["r", "c1", "c2", "g", "h"]],
      ["h", "tree:root", ["r"]],
      ["g", "tree:parent", ["c1"]],
      ["h", "tree:ancestors:2", ["c1", "g"]],
      ["r", "tree:children", ["c1", "c2"]],
      ["r", "tree:descendants:2", ["c1", "c2", "g"]],
      ["c1", "tree:siblings", ["c2"]],
      ["r", "fleet:r", ["r", "c1", "c2", "g", "h"]],
      ["r", "fleet:other", []],
      ["r", "harness:grok", ["c2"]],
      ["r", "label:lane=relay", ["g"]],
      ["r", "org:acme", []],
      ["r", "group:acme/review", []],
    ] as [string, string, string[]][]) {
      broker.target.writePolicy({ rules: [{ match: `ep:${owner}`, send_to: [sel] }] });
      for (const to of ["r", "c1", "c2", "g", "h"])
        expect(await human.request("policy_check", { from: owner, to })).toMatchObject({ allowed: hits.includes(to) });
    }
  });
});
