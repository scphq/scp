import { expect } from "bun:test";
import { brokerSuite, test } from "./suite";
import { refusal } from "./wire";

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`;
const session = (pid: number) => ({ process: key(pid), session: key(pid), lineage: [key(pid)] });

type Agent = Record<string, unknown> & { handle: string };

brokerSuite("broker local agents", (start) => {
  test("the human lists the local agents' facts", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "claude-code", {}, { ...session(1), harness_session: "lead-session", harness_origin: "origin-a" });
    const worker = await broker.agent("worker", "codex");
    const human = await broker.human();
    await human.request("adopt", { endpoint: "worker", parent: "lead" });
    const hook = await broker.hook({ handle: "lead", ...session(1), harness_session: "lead-session" });
    await hook.request("event", { kind: "tool", session_id: "lead-session" });
    await lead.request("status", { state: "blocked", note: "waiting on review" });
    const sub = await broker.hook({ handle: "lead", ...session(1), harness_session: "lead-session", subagent: { id: "aceb553c19f223c70", type: "Explore" } });
    expect(sub.hello.subagent).toBeTruthy();
    await worker.request("send", { to: "lead", body: "done" });
    const { agents } = await human.request<{ agents: Agent[] }>("agents");
    expect(agents.map((agent) => agent.handle)).toEqual(["lead", "worker"]);
    const [first, second] = agents;
    expect(first).toEqual({
      id: lead.id,
      address: "me/lead",
      handle: "lead",
      harness: "claude-code",
      cwd: null,
      parent: null,
      children: 1,
      subagents: 1,
      harness_session: "lead-session",
      harness_origin: "origin-a",
      state: "blocked",
      presence: "online",
      historic: false,
      worked_at: expect.any(String),
      mail_at: expect.any(String),
      connections: expect.any(Number),
      hibernate: null,
      unread: true,
      unread_at: expect.any(String),
      handed_back: false,
    });
    expect(second).toMatchObject({
      id: worker.id,
      address: "me/worker",
      harness: "codex",
      parent: "me/lead",
      children: 0,
      subagents: 0,
      harness_session: null,
      harness_origin: null,
      mail_at: null,
      unread: false,
      unread_at: null,
      handed_back: false,
    });
    expect(Date.parse(first!.unread_at as string)).toBeGreaterThan(0);
  });

  test("only the human lists the local agents' facts", async () => {
    const broker = await start();
    const agent = await broker.agent("lead", "claude-code", {}, session(1));
    expect(await refusal(agent.request("agents"))).toBe("unauthorized");
    expect(await refusal((await broker.hook({ handle: "lead", ...session(1) })).request("agents"))).toBe("unauthorized");
    expect(await refusal((await broker.observer()).request("agents"))).toBe("unauthorized");
    const shell = await broker.wire();
    await shell.hello({ human: true, tty: false, lineage: [key(40), key(1)] });
    expect(await refusal(shell.request("agents"))).toBe("unauthorized");
    expect(await (await broker.human(false)).request("agents")).toMatchObject({ agents: [{ handle: "lead" }] });
  });

  test("in-process subagent rows stay out and a done one is not counted", async () => {
    const broker = await start();
    await broker.agent("lead", "claude-code", {}, session(1));
    const done = await broker.hook({ handle: "lead", ...session(1), subagent: { id: "cccc553c19f223c70", type: "Explore" } });
    await done.request("status", { state: "done" });
    await broker.hook({ handle: "lead", ...session(1), subagent: { id: "bbbb553c19f223c70", type: "Explore" } });
    const { agents } = await (await broker.human()).request<{ agents: Agent[] }>("agents");
    expect(agents.map((agent) => [agent.handle, agent.subagents])).toEqual([["lead", 1]]);
  });
});
