import { expect, test } from "bun:test";
import { brokerSuite, type BrokerFixture } from "./suite";
import { refusal } from "./wire";

const key = (pid: number) => `pid:${pid}:Fri-Oct-17-09:00:00-2026`;
const secret = `ghp_${"A1b2C3d4".repeat(5)}`;
const omitted = "[relay message omitted]";
type Peek = { turns: { role: string; text: string; tools: string[] }[]; recent_tools: string[]; source: string };
async function lane(broker: BrokerFixture) {
  const agent = await broker.agent("lane", "claude-code", {}, { session: "s1", process: key(300) });
  const hook = await broker.hook({ handle: "lane", session: "s1", process: key(300) });
  return { agent, hook };
}

brokerSuite("broker peek", (start) => {
  test("a holding hook posts digest turns and another agent sees turns and tools once enabled", async () => {
    const broker = await start();
    const { agent, hook } = await lane(broker);
    const other = await broker.agent("other");
    expect(await hook.request("peek_turn", { role: "user", text: "while off" })).toEqual({ stored: false });
    expect(await refusal(other.request("peek", { endpoint: "lane" }))).toBe("not_found");
    expect(await refusal(other.request("peek", { endpoint: "unknown" }))).toBe("not_found");
    expect(await agent.request("peek_set", { level: "on" })).toEqual({ endpoint: "me/lane", peek: "local" });
    await hook.request("peek_turn", { role: "user", text: "ship the fix" });
    await hook.request("event", { kind: "tool", tool: "Edit" });
    await hook.request("event", { kind: "tool", tool: "Edit" });
    await hook.request("event", { kind: "tool", tool: "Bash" });
    await hook.request("peek_turn", { role: "assistant", text: "shipped" });
    await hook.request("event", { kind: "tool", tool: "Read" });
    const seen = await other.request<Peek>("peek", { endpoint: "lane", turns: 2 });
    expect(seen).toMatchObject({ endpoint: "me/lane", source: "digest", level: "local", recent_tools: ["Read"] });
    expect(seen.turns.map((turn) => [turn.text, turn.tools])).toEqual([
      ["ship the fix", []],
      ["shipped", ["Edit", "Edit", "Bash"]],
    ]);
    expect(await agent.request("whoami")).toMatchObject({ peek: "local", peeked_by: [{ by: "me/other", auth: "session", turns: 2 }] });
    expect(await agent.request("peek_who")).toMatchObject({ peeked_by: [{ by: "me/other" }] });
    expect(await hook.request("whoami")).not.toHaveProperty("peek");
    expect(await refusal(other.request("peek_who", { endpoint: "lane" }))).toBe("not_found");
    for (const [method, params] of [
      ["peek", { endpoint: "lane" }],
      ["peek_set", { level: "on" }],
      ["peek_who", {}],
    ] as const)
      expect(await refusal(hook.request(method, params))).toBe("scope_refused");
    for (const method of ["list", "peers"]) {
      const result = await other.request<Record<string, { address: string; peekable?: string }[]>>(method);
      expect(result[method === "list" ? "endpoints" : "peers"]!.find((row) => row.address === "me/lane")?.peekable).toBe("local");
    }
  });

  test("only a hook of the holding harness process posts digest turns", async () => {
    const broker = await start();
    const { agent, hook } = await lane(broker);
    await agent.request("peek_set", { level: "on" });
    const turn = { role: "user", text: "FORGED-MARKER" };
    const shell = await broker.wire();
    await shell.hello({ human: true, lineage: [key(301), key(300)], brief: true });
    const own = await broker.observer({ self: [key(301), key(300)], lineage: [key(301), key(300)], brief: true });
    const bare = await broker.hook({ handle: "lane", session: "s1" });
    const stranger = await broker.hook({ handle: "lane", session: "s1", process: key(400) });
    for (const wire of [agent, shell, own, bare, stranger]) expect(await refusal(wire.request("peek_turn", turn))).toBe("unauthorized");
    expect(await hook.request("peek_turn", { role: "user", text: "real turn" })).toEqual({ stored: true });
    const human = await broker.human();
    expect((await human.request<Peek>("peek", { endpoint: "lane" })).turns.map((turn) => turn.text)).toEqual(["real turn"]);
  });

  test("peek removes relay spans, channel metadata, delivered quotations and secrets", async () => {
    const broker = await start();
    const { agent, hook } = await lane(broker);
    const other = await broker.agent("other");
    await agent.request("peek_set", { level: "on" });
    const body = "QUOTE-MARKER the staging database password moves to the vault next week";
    await other.request("send", { to: "lane", body });
    await hook.request("peek_turn", { role: "user", text: `before <relay-message from="me/z">private plan</relay-message> after ${secret}` });
    await hook.request("peek_turn", { role: "assistant", text: `noted: ${body.slice(0, 50)}, will do` });
    await hook.request("peek_turn", { role: "user", text: 'keep <channel source="scp" from="me/z" thread="thr_9">private channel</channel> end' });
    const seen = await other.request<Peek>("peek", { endpoint: "lane" });
    expect(JSON.stringify(seen)).not.toContain(secret);
    expect(seen.turns.map((turn) => turn.text)).toEqual([
      `before ${omitted} after [redacted github token]`,
      `noted: ${omitted}, will do`,
      `keep ${omitted} end`,
    ]);
  });

  test("stored text and clipped turns keep redaction markers whole", async () => {
    const broker = await start();
    const { agent, hook } = await lane(broker);
    await agent.request("peek_set", { level: "on" });
    await hook.request("peek_turn", { role: "user", text: `${"word ".repeat(398)}${secret} tail` });
    const seen = await agent.request<Peek>("peek", { endpoint: "lane", full: true });
    expect(seen.turns[0]!.text.length).toBeLessThanOrEqual(2000);
    expect(seen.turns[0]!.text).not.toContain("ghp_");
    const clipped = (await agent.request<Peek>("peek", { endpoint: "lane" })).turns[0]!.text;
    expect(clipped.length).toBeLessThanOrEqual(600);
    expect(clipped).not.toMatch(/\[redacted(?![^\]]*\])/);
    expect(clipped.endsWith("wor...")).toBe(false);
  });

  test("off deletes the digest and enabling it again exposes no earlier turns", async () => {
    const broker = await start();
    const { agent, hook } = await lane(broker);
    await agent.request("peek_set", { level: "on" });
    await hook.request("peek_turn", { role: "user", text: "before" });
    expect(await agent.request("peek_set", { level: "off" })).toEqual({ endpoint: "me/lane", peek: null });
    await agent.request("peek_set", { level: "on" });
    expect(await agent.request("peek", { endpoint: "lane" })).toMatchObject({ source: "status", turns: [] });
  });

  test("the digest retains only the most recent twenty turns", async () => {
    const broker = await start();
    const { agent, hook } = await lane(broker);
    await agent.request("peek_set", { level: "on" });
    for (let n = 0; n < 25; n++) await hook.request("peek_turn", { role: "user", text: `turn ${n}` });
    const seen = await agent.request<Peek>("peek", { endpoint: "lane", turns: 10 });
    expect(seen.turns.map((turn) => turn.text)).toEqual(Array.from({ length: 10 }, (_, n) => `turn ${n + 15}`));
  });

  test("peek audits carry no bodies and deliver no message to the target", async () => {
    const broker = await start();
    const { agent, hook } = await lane(broker);
    const other = await broker.agent("other");
    await agent.request("peek_set", { level: "on" });
    await hook.request("peek_turn", { role: "user", text: "private words" });
    await other.request("peek", { endpoint: "lane", turns: 2 });
    expect(await agent.request("inbox")).toMatchObject({ messages: [] });
    const human = await broker.human();
    const rows = await human.request<{ rows: { event: string }[] }>("log", { peek: true });
    expect(rows.rows.map((row) => row.event)).toEqual(["peek_set", "peek"]);
    expect(JSON.stringify(rows)).not.toContain("private words");
  });

  test("invalid turn counts, roles and levels are refused", async () => {
    const broker = await start();
    const { agent, hook } = await lane(broker);
    for (const turns of [0, 11, 2.5, "3"])
      expect(await refusal(agent.request("peek", { endpoint: "lane", turns }, { unchecked: true }))).toBe("invalid_params");
    expect(await refusal(hook.request("peek_turn", { role: "system", text: "x" }, { unchecked: true }))).toBe("invalid_params");
    expect(await refusal(agent.request("peek_set", { level: "account" }, { unchecked: true }))).toBe("invalid_params");
  });

  test("pair and target peek budgets limit agents while a human terminal is exempt", async () => {
    const broker = await start();
    const target = await broker.agent("target");
    await target.request("peek_set", { level: "on" });
    const human = await broker.human();
    for (let n = 0; n < 10; n++) {
      const viewer = await broker.agent(`p${n}`);
      for (let count = 0; count < 6; count++) await viewer.request("peek", { endpoint: "target" });
      if (n === 0) {
        const limited = await viewer.call("peek", { endpoint: "target" });
        expect(limited.error?.data?.code).toBe("rate_limited");
        const after = limited.error?.data?.retry_after;
        expect(Number.isInteger(after)).toBe(true);
        expect(after).toBeGreaterThan(0);
        expect(after).toBeLessThanOrEqual(60);
      }
    }
    const fresh = await broker.agent("fresh");
    const limited = await fresh.call("peek", { endpoint: "target" });
    expect(limited.error?.data?.code).toBe("rate_limited");
    const after = limited.error?.data?.retry_after;
    expect(Number.isInteger(after)).toBe(true);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(3600);
    for (let n = 0; n < 20; n++) expect(await human.request("peek", { endpoint: "target" })).toMatchObject({ endpoint: "me/target" });
  });

  test("only a human terminal can raise another endpoint's level and peek while off", async () => {
    const broker = await start();
    const agent = await broker.agent("lane");
    const other = await broker.agent("other");
    const human = await broker.human();
    const shell = await broker.human(false);
    expect(await human.request("peek", { endpoint: "lane" })).toMatchObject({ level: null, source: "status" });
    expect(await refusal(shell.request("peek", { endpoint: "lane" }))).toBe("not_found");
    for (const level of ["on", "off"]) expect(await refusal(other.request("peek_set", { endpoint: "lane", level }))).toBe("not_found");
    expect(await refusal(shell.request("peek_set", { endpoint: "lane", level: "on" }))).toBe("scope_refused");
    await human.request("peek_set", { endpoint: "lane", level: "on" });
    expect(await shell.request("peek", { endpoint: "lane" })).toMatchObject({ level: "local" });
    expect(await agent.request("peek_who")).toMatchObject({ peeked_by: [{ auth: "no-tty" }, { auth: "tty" }] });
    await shell.request("peek_set", { endpoint: "lane", level: "off" });
    expect(await refusal(human.request("peek_set", { level: "on" }))).toBe("invalid_params");
  });

  test("scope refusal conceals opted-in endpoints from a restricted agent", async () => {
    const broker = await start();
    const parent = await broker.agent("parent");
    const target = await broker.agent("target");
    await target.request("peek_set", { level: "on" });
    const grant = await parent.request<{ token: string }>("grant", { name: "child", scope: "parent" });
    const child = await broker.agent("child", "codex", {}, { grant: grant.token });
    for (const endpoint of ["target", "unknown"]) expect(await refusal(child.request("peek", { endpoint }))).toBe("not_found");
  });

  test("a grant enables a fresh child and ancestors may lower but never raise its level", async () => {
    const broker = await start();
    const parent = await broker.agent("parent");
    const grant = await parent.request<{ token: string }>("grant", { name: "child", peek: "local" });
    const child = await broker.agent("child", "codex", {}, { grant: grant.token });
    expect(await child.request("whoami")).toMatchObject({ peek: "local" });
    expect(await parent.request("peek_set", { endpoint: "child", level: "off" })).toEqual({ endpoint: "me/child", peek: null });
    expect(await refusal(parent.request("peek_set", { endpoint: "child", level: "on" }))).toBe("scope_refused");
    await child.request("peek_set", { level: "on" });
    expect(await child.request("whoami")).toMatchObject({ peek: "local" });
  });
});
