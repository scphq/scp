import { expect } from "bun:test";
import { waitFor } from "../targets";
import { brokerSuite, test } from "./suite";
import { type BrokerWire, refusal, type View } from "./wire";

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`;
const fields = (pid: number, parents: number[] = []) => ({ process: key(pid), lineage: [pid, ...parents].map(key), cwd: "/work/w" });
type Grant = { token: string };
type Scope = { groups: string[]; caps: { id: string; by: string; dir: string; sels: { sel: string; via?: string }[] }[]; rules: Record<string, unknown> };
async function offline(wire: BrokerWire, viewer: BrokerWire, id: string) {
  await wire.close();
  await waitFor(
    async () => (await viewer.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === id)?.presence === "offline",
    "worker offline",
  );
}

brokerSuite("broker grant redemption and incarnation", (start) => {
  test("spent grant reclaims its worker with the same cwd and harness and preserves groups and status", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, fields(1));
    await lead.request("group", { action: "create", name: "crew" });
    const { token } = await lead.request<Grant>("grant", { name: "w", scope: "parent", groups: ["crew"] });
    const worker = await broker.agent("w", "codex", {}, { ...fields(4), grant: token });
    await worker.request("status", { state: "blocked", note: "on it" });
    await offline(worker, lead, worker.id);
    const back = await broker.agent("w", "codex", {}, { ...fields(8), grant: token });
    expect(back.hello.endpoint).toMatchObject({ id: worker.id, status: { state: "blocked", note: "on it" } });
    expect(await lead.request("rules", { endpoint: "w" })).toMatchObject({ groups: ["crew"] });
  });

  test("a spent grant from another tree is ignored and cannot capture the old worker", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, fields(1));
    const other = await broker.agent("other", "codex", {}, fields(9));
    const { token } = await lead.request<Grant>("grant", { scope: "parent" });
    const worker = await broker.agent("w", "codex", {}, { ...fields(3), grant: token });
    await offline(worker, lead, worker.id);
    const elsewhere = await broker.agent("w", "codex", {}, { ...fields(10, [9]), grant: token });
    expect(elsewhere.hello.endpoint).toMatchObject({ address: "me/w-2", parent: other.address });
    const back = await broker.agent("w", "codex", {}, { ...fields(11, [1]), grant: token });
    expect(back.id).toBe(worker.id);
  });

  test("a fresh spawn resets mail, rules, status, title, groups and admin authority", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, fields(1));
    const human = await broker.human();
    await lead.request("group", { action: "create", name: "crew" });
    const first = await lead.request<Grant>("grant", { name: "w", scope: "parent", groups: ["crew"] });
    const worker = await broker.agent("w", "codex", {}, { ...fields(4), grant: first.token });
    await worker.request("rules_set", { in: ["ep:lead"] });
    await worker.request("title", { text: "old task" });
    await worker.request("status", { state: "working", note: "old status" });
    await human.request("admin", { action: "grant", subject: "w", tree: "lead" });
    await lead.request("send", { to: "w", body: "old mail" });
    await offline(worker, lead, worker.id);
    const next = await lead.request<Grant>("grant", { name: "w", scope: "parent" });
    const fresh = await broker.agent("w", "codex", {}, { ...fields(14), grant: next.token });
    expect(fresh.hello.endpoint).toMatchObject({ id: worker.id, status: null, title: null });
    expect(await lead.request("rules", { endpoint: "w" })).toMatchObject({ groups: [], rules: {} });
    expect(await fresh.request("inbox")).toMatchObject({ messages: [] });
    expect(await human.request<unknown[]>("admin", { action: "ls" })).toEqual([]);
    expect(await refusal(lead.request("spawn_exit", { grant: first.token, code: 0 }))).toBe("unauthorized");
    const rows = await human.request<{ rows: { event: string }[] }>("log", { scope: true });
    expect(rows.rows.filter((r) => r.event === "scope_reset")).not.toHaveLength(0);
  });

  test("a new spawn takes group ownership from the previous holder and gives it to the issuer", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, fields(1));
    const first = await lead.request<Grant>("grant", { name: "w", scope: "parent" });
    const worker = await broker.agent("w", "codex", {}, { ...fields(4), grant: first.token });
    await worker.request("group", { action: "create", name: "owned" });
    await offline(worker, lead, worker.id);
    const second = await lead.request<Grant>("grant", { name: "w", scope: "parent" });
    const fresh = await broker.agent("w", "codex", {}, { ...fields(14), grant: second.token });
    expect(await lead.request("group", { action: "show", name: "owned" })).toMatchObject({ owner: "me/lead" });
    expect(await refusal(fresh.request("group", { action: "drop", name: "owned" }))).toBeDefined();
    await lead.request("group", { action: "drop", name: "owned" });
  });

  test("incarnation without a grant drops widening and memberships while retaining human caps", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, fields(1));
    const worker = await broker.agent("w", "codex", {}, fields(4, [1]));
    const human = await broker.human();
    await lead.request("group", { action: "create", name: "crew" });
    await lead.request("group", { action: "add", name: "crew", endpoint: "w" });
    await human.request("rules_set", { endpoint: "w", in: ["ep:lead"] });
    await lead.request("rules_set", { endpoint: "w", out: ["tree:parent"] });
    await human.request("rules_widen", { endpoint: "w", out: ["ep:x"] });
    await worker.request("group", { action: "create", name: "owned" });
    await offline(worker, lead, worker.id);
    expect((await broker.agent("w", "codex", {}, fields(24, [1]))).id).toBe(worker.id);
    const view = await human.request<Scope>("rules", { endpoint: "w" });
    expect(view.groups).toEqual([]);
    expect(
      view.caps
        .filter((c) => c.by !== "human")
        .flatMap((c) => c.sels)
        .some((e) => e.via !== undefined),
    ).toBe(false);
    expect(view.caps.filter((c) => c.by === "human").map((c) => c.sels)).toEqual([[{ sel: "ep:lead" }]]);
    expect(await human.request("group", { action: "show", name: "owned" })).toMatchObject({ owner: "me/" });
  });

  test("grant groups bind their original identity and never join a recreated group", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    await lead.request("group", { action: "create", name: "crew" });
    const { token } = await lead.request<Grant>("grant", { name: "w", groups: ["crew"] });
    await lead.request("group", { action: "drop", name: "crew" });
    await lead.request("group", { action: "create", name: "crew" });
    const worker = await broker.agent("w", "codex", {}, { grant: token });
    expect(worker.hello.endpoint?.parent).toBe("me/lead");
    expect(await lead.request("rules", { endpoint: "w" })).toMatchObject({ groups: [] });
  });

  test("fresh grants replace previous caps without accumulating duplicate caps", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    const human = await broker.human();
    const first = await lead.request<Grant>("grant", { name: "w", out: ["*"], in: ["*"] });
    let worker = await broker.agent("w", "codex", {}, { ...fields(4), grant: first.token });
    const id = worker.id;
    for (const pid of [5, 6]) {
      await offline(worker, lead, id);
      const grant = await lead.request<Grant>("grant", { name: "w", scope: "parent" });
      worker = await broker.agent("w", "codex", {}, { ...fields(pid), grant: grant.token });
      expect(worker.id).toBe(id);
      expect((await human.request<Scope>("rules", { endpoint: "w" })).caps).toHaveLength(2);
    }
  });

  test("spawn-env observers bind only the spender or its descendant", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, fields(1));
    const { token } = await lead.request<Grant>("grant", { scope: "parent" });
    expect(await refusal(broker.observer({ self: [key(1)], lineage: [key(1)], grant: token }))).toBe("unauthorized");
    const worker = await broker.agent("w", "codex", {}, { ...fields(4, [1]), grant: token });
    const child = await broker.agent("child", "codex", {}, { ...fields(5, [4, 1]), grant: token });
    for (const [pid, endpoint] of [
      [4, worker],
      [5, child],
    ] as const) {
      expect((await broker.observer({ self: [key(pid)], lineage: [key(pid), key(1)], grant: token })).hello).toMatchObject({
        endpoint: { id: endpoint.id },
        grant_bound: true,
      });
    }
    expect(await refusal(broker.observer({ self: [key(1)], lineage: [key(1)], grant: token }))).toBe("unauthorized");
  });

  test("lineage grants retain child defaults while session grants may supply open caps", async () => {
    const broker = await start({ policy: { rules: [], defaults: { child_default: "parent" } } });
    await (await broker.observer()).request("policy");
    const lead = await broker.agent("lead", "codex", {}, fields(1));
    await broker.agent("other");
    const shell = await broker.wire();
    await shell.hello({ human: true, lineage: [key(40), key(1)] });
    const plain = await shell.request<Grant>("grant", { scope: "open", out: ["*"], in: ["*"] });
    const kid = await broker.agent("kid", "codex", {}, { grant: plain.token });
    expect(await refusal(kid.request("send", { to: "other", body: "no" }))).toBe("not_found");
    const own = await lead.request<Grant>("grant", { out: ["*"], in: ["*"] });
    const kid2 = await broker.agent("kid2", "codex", {}, { grant: own.token });
    await kid2.request("send", { to: "other", body: "yes" });
  });
});

brokerSuite("broker grant validation", (start) => {
  test("no-lineage grant reclaims require the recorded harness and cwd", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    const { token } = await lead.request<Grant>("grant", { name: "w", scope: "parent" });
    const w = await broker.agent("w", "codex", {}, { ...fields(4), grant: token });
    await offline(w, lead, w.id);
    for (const extra of [{}, { cwd: "/work/w/sub" }])
      expect(await refusal(broker.agent("w", "codex", {}, { process: key(5), grant: token, ...extra }))).toBe("unauthorized");
    expect(await refusal(broker.agent("w", "grok", {}, { ...fields(6), grant: token }))).toBe("unauthorized");
    expect((await broker.agent("w", "codex", {}, { ...fields(7), grant: token })).id).toBe(w.id);
  });

  test("a grant title is normalized and a worker's explicit title survives redeeming the same grant", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    const { token } = await lead.request<Grant>("grant", { name: "w", title: " docs\n\t pass " });
    const worker = await broker.agent("w", "codex", {}, { ...fields(4), grant: token });
    expect(worker.hello.endpoint?.title).toBe("docs pass");
    await worker.request("title", { text: "mine" });
    await offline(worker, lead, worker.id);
    expect((await broker.agent("w", "codex", {}, { ...fields(4), grant: token })).hello.endpoint?.title).toBe("mine");
  });

  test("grant prompts are scrubbed before becoming the worker's first peek turn", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`;
    const { token } = await lead.request<Grant>("grant", { name: "w", peek: "local", prompt: `fix parser with ${secret}` });
    await broker.agent("w", "codex", {}, { grant: token });
    const peek = await lead.request<{ turns: { role: string; text: string }[] }>("peek", { endpoint: "w" });
    expect(peek.turns).toMatchObject([{ role: "user", text: expect.stringContaining("fix parser") }]);
    expect(JSON.stringify(peek)).not.toContain(secret);
  });
});
