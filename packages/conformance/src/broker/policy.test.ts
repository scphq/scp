import { expect, test } from "bun:test";
import { brokerSuite } from "./suite";
import { refusal } from "./wire";

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`;

brokerSuite("broker policy", (start) => {
  test("missing policy is open and reports open state", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    await broker.agent("b");
    await a.request("send", { to: "b", body: "open" });
    expect(await a.request("policy")).toMatchObject({ state: "open", policy: null });
    expect(await a.request("policy_check", { from: "a", to: "b" })).toMatchObject({ allowed: true });
  });

  test("send_to and accept_from restrict independently and audit explicit policy refusals", async () => {
    const policy = {
      rules: [
        { match: "harness:grok", send_to: ["handle:lead"] },
        { match: "handle:rev", accept_from: ["harness:claude-code", "kind:human"] },
      ],
    };
    const broker = await start({ policy });
    const lead = await broker.agent("lead");
    const grok = await broker.agent("grok-1", "grok");
    await broker.agent("rev", "codex");
    expect(await refusal(grok.request("send", { to: "rev", body: "refused" }))).toBe("policy_refused");
    await grok.request("send", { to: "lead", body: "allowed" });
    await lead.request("send", { to: "rev", body: "allowed" });
    const human = await broker.human();
    await human.request("send", { to: "rev", body: "allowed" });
    expect(await human.request("policy_check", { from: "grok-1", to: "rev" })).toMatchObject({ allowed: false });
    const log = await human.request<{ rows: { event: string }[] }>("log");
    expect(log.rows.some((r) => r.event === "refuse")).toBe(true);
  });

  test("agents see policy state without its text and pair checks obey their scope", async () => {
    const broker = await start({ policy: { rules: [] } });
    await broker.agent("main", "codex", {}, { process: key(100) });
    await broker.agent("orch", "codex", {}, { process: key(200), lineage: [key(200), key(100)] });
    const w = await broker.agent("w", "codex", {}, { process: key(300), lineage: [key(300), key(200), key(100)], scope: "parent" });
    const shell = await broker.observer({ lineage: [key(301), key(300), key(200)] });
    for (const viewer of [w, shell]) {
      expect(await viewer.request("policy")).toMatchObject({ state: "loaded", policy: null });
      expect(await refusal(viewer.request("policy_check", { from: "main", to: "orch" }))).toBe("not_found");
      expect(await viewer.request("policy_check", { from: "w", to: "orch" })).toMatchObject({ allowed: true });
    }
    for (const viewer of [await broker.observer(), await broker.human()]) {
      expect(await viewer.request("policy")).toMatchObject({ state: "loaded", policy: { rules: [] } });
      expect(await viewer.request("policy_check", { from: "orch", to: "main" })).toMatchObject({ allowed: true });
    }
  });

  for (const [name, policy] of [
    ["invalid JSON", "{"],
    ["unknown rule field", { rules: [{ match: "*", sendto: [] }] }],
    ["unknown default", { rules: [], defaults: { other: 1 } }],
    ["relative match", { rules: [{ match: "tree:children", send_to: ["*"] }] }],
    ["unimplemented verified lineage", { rules: [], defaults: { verify_lineage: true } }],
  ] as [string, unknown][]) {
    test(`policy fails closed for ${name}`, async () => {
      const broker = await start({ policy });
      const a = await broker.agent("a");
      await broker.agent("b");
      expect(await refusal(a.request("send", { to: "b", body: "closed" }))).toBe("policy_refused");
      expect(await (await broker.human()).request("policy")).toMatchObject({ state: "error", error: expect.any(String) });
    });
  }

  test("policy reload applies to the next send and can recover from an invalid file", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    await broker.agent("b");
    await a.request("send", { to: "b", body: "before" });
    broker.target.writePolicy({ rules: [{ match: "ep:a", send_to: [] }] });
    expect(await refusal(a.request("send", { to: "b", body: "after" }))).toBe("policy_refused");
    broker.target.writePolicy("{");
    expect(await refusal(a.request("send", { to: "b", body: "invalid" }))).toBe("policy_refused");
    broker.target.writePolicy({ rules: [] });
    await a.request("send", { to: "b", body: "recovered" });
  });

  test("policy scope caps cannot be widened even by terminal human", async () => {
    const broker = await start({ policy: { rules: [{ match: "handle:c", scope: ["tree:parent"] }] } });
    const r = await broker.agent("r", "codex", {}, { process: key(100) });
    const c = await broker.agent("c", "codex", {}, { process: key(200), lineage: [key(200), key(100)] });
    await broker.agent("x");
    expect(await refusal(c.request("send", { to: "x", body: "blocked" }))).toBe("not_found");
    await r.request("send", { to: "c", body: "ancestor" });
    const human = await broker.human();
    expect(await human.request("rules", { endpoint: "c" })).toMatchObject({
      caps: [
        { by: "policy", dir: "in" },
        { by: "policy", dir: "out" },
      ],
    });
    expect(await refusal(human.request("rules_widen", { endpoint: "c", out: ["*"] }))).toBe("scope_refused");
  });

  test("policy can disable the human exemption and anchors relative selectors on each side", async () => {
    const broker = await start({
      policy: {
        rules: [
          { match: "handle:c", send_to: ["tree:parent"] },
          { match: "handle:r", accept_from: ["tree:children"] },
        ],
        defaults: { human_always: false },
      },
    });
    await broker.agent("r", "codex", {}, { process: key(100) });
    const c = await broker.agent("c", "codex", {}, { process: key(200), lineage: [key(200), key(100)] });
    const x = await broker.agent("x");
    await c.request("send", { to: "r", body: "allowed" });
    expect(await refusal(c.request("send", { to: "x", body: "no" }))).toBe("policy_refused");
    expect(await refusal(x.request("send", { to: "r", body: "no" }))).toBe("policy_refused");
    expect(await refusal((await broker.human()).request("send", { to: "r", body: "no" }))).toBe("policy_refused");
  });

  test("policy groups compute members from selectors and refuse runtime mutation", async () => {
    const broker = await start({
      policy: {
        rules: [{ match: "group:reviewers", send_to: ["group:reviewers", "kind:human"] }],
        groups: [{ name: "reviewers", members: ["harness:grok"], rules: ["group:self"] }],
      },
    });
    const a = await broker.agent("a", "grok");
    await broker.agent("b", "grok");
    const c = await broker.agent("c");
    await a.request("policy");
    expect(await (await broker.human()).request("rules", { endpoint: "b" })).toMatchObject({ groups: ["reviewers"] });
    expect(await refusal(a.request("send", { to: "c", body: "no" }))).toBe("not_found");
    await a.request("send", { to: "group:reviewers", body: "review" });
    expect(await refusal(a.request("group", { action: "remove", name: "reviewers" }))).toBe("scope_refused");
    expect(await refusal(c.request("group", { action: "create", name: "reviewers" }))).toBe("invalid_params");
  });
});

brokerSuite("broker policy group bindings", (start) => {
  test("policy group selectors bind at load and rebind only after policy content changes", async () => {
    const broker = await start();
    const main = await broker.agent("main");
    const x = await broker.agent("x");
    const human = await broker.human();
    const policy = { rules: [{ match: "handle:main", accept_from: ["group:ops"] }] };
    broker.target.writePolicy(policy);
    await human.request("policy");
    await x.request("group", { action: "create", name: "ops" });
    await x.request("group", { action: "add", name: "ops" });
    expect(await refusal(x.request("send", { to: "main", body: "late group" }))).toBe("policy_refused");
    broker.target.writePolicy({ rules: [{ match: "handle:main", accept_from: ["group:ops", "handle:main"] }] });
    await x.request("send", { to: "main", body: "new policy" });
    expect(await main.request("inbox")).toMatchObject({ messages: [{ body: { text: "new policy" } }] });
  });

  test("policy group bindings survive broker restart without adopting groups created after load", async () => {
    const broker = await start({ policy: { rules: [{ match: "handle:main", accept_from: ["group:ops"] }] } });
    await broker.agent("main");
    const x = await broker.agent("x");
    await x.request("policy");
    await x.request("group", { action: "create", name: "ops" });
    await x.request("group", { action: "add", name: "ops" });
    expect(await refusal(x.request("send", { to: "main", body: "before" }))).toBe("policy_refused");
    const token = x.hello.token;
    await broker.restart();
    const back = await broker.wire();
    await back.hello({ resume: token });
    expect(await refusal(back.request("send", { to: "main", body: "after" }))).toBe("policy_refused");
  });

  test("policy selectors match handle globs and exact labels", async () => {
    const broker = await start({ policy: { rules: [{ match: "handle:relay-*", send_to: ["label:lane=relay"] }] } });
    const a = await broker.agent("relay-impl");
    await broker.agent("yes", "codex", {}, { labels: { lane: "relay" } });
    await broker.agent("no", "codex", {}, { labels: { lane: "other" } });
    await a.request("send", { to: "yes", body: "allowed" });
    expect(await refusal(a.request("send", { to: "no", body: "refused" }))).toBe("policy_refused");
  });

  test("turning human_always off removes the human scope exemption", async () => {
    const broker = await start({ policy: { rules: [], defaults: { human_always: false } } });
    await (await broker.observer()).request("policy");
    const a = await broker.agent("a", "codex", {}, { scope: "none" });
    expect(await refusal(a.request("send", { to: "me/", body: "no exemption" }))).toBe("not_found");
    expect(await refusal((await broker.human()).request("send", { to: "a", body: "no exemption" }))).toBe("not_found");
  });
});

brokerSuite("broker policy group precedence", (start) => {
  test("policy groups shadow runtime groups and only the human sees the ignored group", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    const b = await broker.agent("b");
    const c = await broker.agent("c");
    const human = await broker.human();
    await a.request("group", { action: "create", name: "reviewers" });
    await a.request("group", { action: "add", name: "reviewers" });
    await human.request("group", { action: "add", name: "reviewers", endpoint: "c" });
    broker.target.writePolicy({ rules: [], groups: [{ name: "reviewers", members: ["handle:a"], rules: ["group:self"] }] });
    await human.request("policy");
    expect(await human.request("rules", { endpoint: "a" })).toMatchObject({ groups: ["reviewers"] });
    expect(await human.request("rules", { endpoint: "c" })).toMatchObject({ groups: [] });
    expect(await refusal(a.request("send", { to: "b", body: "no" }))).toBe("not_found");
    await c.request("send", { to: "b", body: "yes" });
    expect(await human.request("group", { action: "ls" })).toMatchObject([
      { name: "reviewers", policy: true },
      { name: "reviewers", ignored: "a policy group has this name" },
    ]);
    expect(await a.request<unknown[]>("group", { action: "ls" })).toHaveLength(1);
    expect(await b.request<unknown[]>("group", { action: "ls" })).toEqual([]);
  });
});
