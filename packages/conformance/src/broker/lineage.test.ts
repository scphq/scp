import { expect } from "bun:test";
import { waitFor } from "../targets";
import { type BrokerFixture, brokerSuite, test } from "./suite";
import { refusal, type View } from "./wire";

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`;
const claim = (pid: number) => ({ process: key(pid), session: key(pid), lineage: [key(pid)] });
const sub = (broker: BrokerFixture, id = "aceb553c19f223c70", extra: Record<string, unknown> = {}) =>
  broker.hook({ handle: "lead", ...claim(1), subagent: { id, type: "Explore", ...extra } });

brokerSuite("broker lineage", (start) => {
  test("a terminal adopts a root with its subtree and unlink restores root depth", async () => {
    const broker = await start();
    const h = await broker.human();
    await broker.agent("lead");
    const app = await broker.agent("app");
    const peer = await broker.agent("peer");
    await h.request("adopt", { endpoint: "peer", parent: "app" });
    expect(await h.request("adopt", { endpoint: "app", parent: "lead" })).toMatchObject({ parent: "me/lead", endpoint: { id: app.id, depth: 1 } });
    expect(await peer.request("whoami")).toMatchObject({ parent: "me/app", depth: 2 });
    expect(await h.request("unlink", { endpoint: "app" })).toMatchObject({ parent: "me/lead", endpoint: { parent: null, depth: 0 } });
    expect(await peer.request("whoami")).toMatchObject({ parent: "me/app", depth: 1 });
    expect(await h.request("rules", { endpoint: "app" })).toMatchObject({ parent: null, tree: "me/app", caps: [] });
    expect(await refusal(h.request("unlink", { endpoint: "app" }))).toBe("invalid_params");
  });

  test("adoption requires a terminal for the human and an explicit parent", async () => {
    const broker = await start();
    await broker.agent("lead");
    const peer = await broker.agent("peer");
    expect(await refusal((await broker.human(false)).request("adopt", { endpoint: "peer", parent: "lead" }))).toBe("scope_refused");
    expect(await refusal((await broker.human()).request("adopt", { endpoint: "peer" }))).toBe("invalid_params");
    expect(await peer.request("whoami")).toMatchObject({ parent: null });
  });

  test("an agent adopts a root directly under itself and worker defaults apply", async () => {
    const broker = await start({ policy: { rules: [], defaults: { child_default: "parent" } } });
    const lead = await broker.agent("lead");
    const peer = await broker.agent("peer");
    await broker.agent("other");
    expect(await lead.request("adopt", { endpoint: "peer" })).toMatchObject({ parent: "me/lead", endpoint: { id: peer.id, depth: 1 } });
    expect(await peer.request("inbox")).toMatchObject({ messages: [] });
    await peer.request("send", { to: "lead", body: "allowed" });
    expect(await refusal(peer.request("send", { to: "other", body: "hidden" }))).toBe("not_found");
    await lead.request("adopt", { endpoint: "peer" });
    const rows = await (await broker.human()).request<{ rows: { event: string }[] }>("log");
    expect(rows.rows.filter((r) => r.event === "adopt")).toHaveLength(1);
  });

  test("lineage authority adopts a root and its subtree", async () => {
    const broker = await start();
    await broker.agent("lead", "codex", {}, claim(1));
    await broker.agent("app");
    const peer = await broker.agent("peer");
    await (await broker.human()).request("adopt", { endpoint: "peer", parent: "app" });
    const shell = await broker.wire();
    await shell.hello({ human: true, tty: false, lineage: [key(40), key(1)] });
    expect(await shell.request("adopt", { endpoint: "app" })).toMatchObject({ endpoint: { parent: "me/lead" } });
    expect(await peer.request("whoami")).toMatchObject({ depth: 2 });
  });

  test("adoption refuses self, ancestors, cycles, unreachable targets and other machines", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    const peer = await broker.agent("peer");
    const h = await broker.human();
    expect(await refusal(lead.request("adopt", { endpoint: "lead" }))).toBe("scope_refused");
    expect(await refusal(lead.request("adopt", { endpoint: "peer", parent: "peer" }))).toBe("scope_refused");
    expect(await refusal(lead.request("adopt", { endpoint: "me/" }))).toBe("invalid_params");
    await lead.request("adopt", { endpoint: "peer" });
    expect(await refusal(peer.request("adopt", { endpoint: "lead" }))).toBe("scope_refused");
    expect(await refusal(h.request("adopt", { endpoint: "lead", parent: "peer" }))).toBe("scope_refused");
    expect(await refusal(h.request("adopt", { endpoint: "lead", parent: "me/desk/lead" }))).toBe("not_found");
    const hidden = await broker.agent("hidden");
    await hidden.request("rules_set", { in: [] });
    expect(await refusal(lead.request("adopt", { endpoint: "hidden" }))).toBe("not_found");
  });

  test("adopting another parent's child sends a link request accepted only after unlink", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    const peer = await broker.agent("peer");
    await broker.agent("other");
    const h = await broker.human();
    await h.request("adopt", { endpoint: "peer", parent: "other" });
    await h.request("rules_set", { endpoint: "lead", in: ["*"], out: ["*"] });
    const result = await lead.request<{ requested: string }>("adopt", { endpoint: "peer" });
    expect(await peer.request("inbox")).toMatchObject({ messages: [{ id: result.requested, kind: "request", link: { parent: "me/lead" } }] });
    expect(await refusal(peer.request("link_accept", { id: result.requested }))).toBe("scope_refused");
    await h.request("unlink", { endpoint: "peer" });
    expect(await refusal(lead.request("link_accept", { id: result.requested }))).toBe("not_found");
    expect(await refusal(h.request("link_accept", { id: result.requested }))).toBe("scope_refused");
    const ordinary = await lead.request<{ id: string }>("send", { to: "peer", kind: "request", body: "join me" });
    expect(await refusal(peer.request("link_accept", { id: ordinary.id }))).toBe("not_found");
    expect(await peer.request("link_accept", { id: result.requested.slice(-6) })).toMatchObject({ parent: "me/lead", endpoint: { depth: 1 } });
  });

  test("a hidden child of another parent is not_found like a missing endpoint and gets no link request", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    const peer = await broker.agent("peer");
    await broker.agent("other");
    const h = await broker.human();
    await h.request("adopt", { endpoint: "peer", parent: "other" });
    await h.request("rules_set", { endpoint: "peer", in: [] });
    expect(await refusal(lead.request("adopt", { endpoint: "peer" }))).toBe("not_found");
    expect(await refusal(lead.request("adopt", { endpoint: "ghost" }))).toBe("not_found");
    expect(await peer.request("inbox")).toMatchObject({ messages: [] });
  });

  test("link acceptance rechecks cycles and lineage auth cannot accept", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    await broker.agent("peer", "codex", {}, claim(2));
    await broker.agent("other");
    const h = await broker.human();
    await h.request("adopt", { endpoint: "peer", parent: "other" });
    await h.request("rules_set", { endpoint: "lead", in: ["*"], out: ["*"] });
    const { requested: id } = await lead.request<{ requested: string }>("adopt", { endpoint: "peer" });
    await h.request("unlink", { endpoint: "peer" });
    const shell = await broker.wire();
    await shell.hello({ human: true, lineage: [key(40), key(2)] });
    expect(await refusal(shell.request("link_accept", { id }))).toBe("scope_refused");
    await h.request("adopt", { endpoint: "lead", parent: "peer" });
    const own = await broker.observer({ self: [key(2)], lineage: [key(2)] });
    expect(await refusal(own.request("link_accept", { id }))).toBe("scope_refused");
  });

  test("claim under links once and a refused link keeps the claim", async () => {
    const broker = await start();
    await broker.agent("lead");
    const app = await broker.hook({ handle: "app", ...claim(2), under: "lead" });
    expect(app.hello.endpoint).toMatchObject({ parent: "me/lead", depth: 1 });
    expect((await broker.hook({ handle: "app", ...claim(2), under: "lead" })).hello.endpoint?.id).toBe(app.hello.endpoint?.id);
    const lone = await broker.hook({ handle: "lone", ...claim(3), under: "nobody" });
    expect(lone.hello.endpoint?.parent).toBeNull();
    const rows = await (await broker.human()).request<{ rows: { event: string }[] }>("log");
    expect(rows.rows.filter((r) => r.event === "claim_under_refused")).not.toHaveLength(0);
  });

  test("join under applies inherited reach and refuses a parent it cannot reach atomically", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    await broker.agent("peer");
    await (await broker.human()).request("rules_set", { endpoint: "lead", out: ["tree:children"], in: ["*"] });
    const w = await broker.wire();
    const hello = await w.hello({ transient: true, claim: { handle: "app", harness: "codex", ...claim(2) }, join: { under: "lead" } });
    expect(hello.endpoint?.parent).toBe("me/lead");
    const self = await broker.observer({ self: [key(2)], lineage: [key(2)] });
    expect(await refusal(self.request("send", { to: "peer", body: "hidden" }))).toBe("not_found");
    await lead.request("rules_set", { in: [] });
    expect(
      await refusal((await broker.wire()).hello({ transient: true, claim: { handle: "nope", harness: "codex", ...claim(3) }, join: { under: "lead" } })),
    ).toBe("not_found");
    expect((await (await broker.human()).request<{ endpoints: View[] }>("list", { all: true })).endpoints.some((e) => e.address === "me/nope")).toBe(false);
  });

  test("unlink requires terminal authority unless policy allows self unlink", async () => {
    const broker = await start({ policy: { rules: [], defaults: { unlink: "self" } } });
    const lead = await broker.agent("lead");
    const app = await broker.agent("app");
    await lead.request("adopt", { endpoint: "app" });
    expect(await refusal((await broker.human(false)).request("unlink", { endpoint: "app" }))).toBe("scope_refused");
    expect(await app.request("unlink")).toMatchObject({ endpoint: { parent: null } });
  });

  test("subagent hook claims create one child, stop finds only existing children and tool claims resume done children", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "claude-code", {}, claim(1));
    expect(await refusal(sub(broker, "missing", { stop: true }))).toBe("not_found");
    const first = await sub(broker);
    expect(first.hello).toMatchObject({ subagent: true, created: true, endpoint: { address: "me/lead-explore-aceb", parent: lead.address, depth: 1 } });
    expect((await sub(broker)).hello).toMatchObject({ subagent: true, endpoint: { id: first.hello.endpoint?.id } });
    expect((await sub(broker)).hello.created).toBeUndefined();
    await first.request("status", { state: "done" });
    expect((await sub(broker, undefined, { stop: true })).hello.endpoint?.status?.state).toBe("done");
    expect((await sub(broker)).hello.endpoint?.status?.state).toBe("working");
  });

  test("subagent claims require a hook of the root's own process and harness", async () => {
    const broker = await start();
    await broker.agent("lead", "claude-code", {}, claim(1));
    const descriptor = { id: "aceb", type: "Explore" };
    expect(await refusal(broker.hook({ handle: "lead", ...claim(1), process: key(2), subagent: descriptor }))).toBe("unauthorized");
    expect(await refusal(broker.agent("lead", "claude-code", {}, { ...claim(1), subagent: descriptor }))).toBe("unauthorized");
    expect(await refusal(broker.hook({ handle: "lead", harness: "codex", ...claim(1), subagent: descriptor }))).toBe("unauthorized");
    expect(await refusal(broker.hook({ handle: "missing", ...claim(3), subagent: descriptor }))).toBe("unauthorized");
  });

  test("root shells bind subagents without tokens and messages stay in their own inboxes", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "claude-code", {}, claim(1));
    const child = await sub(broker);
    const shell = await broker.agent("lead-explore-aceb", "cli", { self: [key(40), key(1)], brief: true }, { exact: true, lineage: [key(40), key(1)] });
    expect(shell.id).toBe(child.hello.endpoint!.id);
    expect(shell.hello.token).toBeUndefined();
    await lead.request("send", { to: shell.address, body: "for child" });
    expect(await shell.request("inbox")).toMatchObject({ messages: [{ body: { text: "for child" }, relation: "parent" }] });
    expect(await lead.request("inbox")).toMatchObject({ messages: [] });
    await shell.request("status", { state: "waiting", note: "from shell" });
    await shell.close();
    expect((await sub(broker)).hello.endpoint).toMatchObject({ id: shell.id, status: { state: "waiting", note: "from shell" } });
  });

  test("pending subagent titles apply on creation and explicit titles win", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "claude-code", {}, claim(1));
    const parent = await broker.hook({ handle: "lead", ...claim(1) });
    expect(await parent.request("subagent_title", { id: "f00d42", title: "Review the\n parser" })).toEqual({ changed: false });
    expect((await sub(broker, "f00d42")).hello.endpoint?.title).toBe("Review the parser");
    await lead.request("rename", { handle: "chief" });
    const child = await sub(broker);
    expect(child.hello.endpoint?.address).toBe("me/chief-explore-aceb");
    expect(await parent.request("subagent_title", { id: "aceb553c19f223c70", title: "inferred" })).toEqual({ changed: true });
    const shell = await broker.wire();
    await shell.hello({ claim: { handle: "chief-explore-aceb", harness: "cli", exact: true, lineage: [key(40), key(1)] }, self: [key(40), key(1)] });
    await shell.request("title", { text: "chosen" });
    expect(await parent.request("subagent_title", { id: "aceb553c19f223c70", title: "ignored" })).toEqual({ changed: false });
    expect(await shell.request("whoami")).toMatchObject({ title: "chosen" });
  });

  test("subagent handle derivation shortens types and avoids collisions", async () => {
    const broker = await start();
    await broker.agent("lead", "claude-code", {}, claim(1));
    const kinds = ["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "codeReviewer", "x".repeat(40)];
    const short = ["gp", "explore", "plan", "statusline", "claude", "code", "x".repeat(16)];
    for (let i = 0; i < kinds.length; i++) {
      const hook = await broker.hook({ handle: "lead", ...claim(1), subagent: { id: `abcd${i}`, type: kinds[i] } });
      expect(hook.hello.endpoint?.address).toBe(`me/lead-${short[i]}-abcd`);
    }
    expect((await sub(broker, "aceb01")).hello.endpoint?.address).toBe("me/lead-explore-aceb");
    expect((await sub(broker, "aceb02")).hello.endpoint?.address).toBe("me/lead-explore-aceb-2");
  });
});

brokerSuite("broker exact lineage state", (start) => {
  const shell = (broker: BrokerFixture, handle: string, walk: number[], own = walk.slice(0, 2)) =>
    broker.agent(handle, "cli", { self: own.map(key), brief: true }, { exact: true, lineage: walk.map(key) });
  test("root shells repeatedly bind a child identity without resetting status or group ownership", async () => {
    const broker = await start();
    await broker.agent("lead", "claude-code", {}, claim(1));
    const kid = await shell(broker, "kid", [30, 1]);
    await kid.request("status", { state: "blocked", note: "on it" });
    await kid.request("group", { action: "create", name: "crew" });
    await kid.close();
    const again = await shell(broker, "kid", [31, 1]);
    expect(again.hello.endpoint).toMatchObject({ id: kid.id, status: { state: "blocked", note: "on it" } });
    expect(await (await broker.human()).request("group", { action: "show", name: "crew" })).toMatchObject({ owner: "me/kid" });
    expect((await (await broker.human()).request<{ rows: { event: string }[] }>("log", { scope: true })).rows.filter((r) => r.event === "scope_reset")).toEqual(
      [],
    );
  });

  test("a different harness process taking an exact child resets its group ownership", async () => {
    const broker = await start();
    await broker.agent("lead", "claude-code", {}, claim(1));
    const kid = await shell(broker, "kid", [30, 1]);
    await kid.request("group", { action: "create", name: "crew" });
    await kid.close();
    const human = await broker.human();
    await waitFor(
      async () => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === kid.id)?.presence === "offline",
      "child offline",
    );
    expect((await shell(broker, "kid", [35, 20, 15, 1])).id).toBe(kid.id);
    expect(await human.request("group", { action: "show", name: "crew" })).toMatchObject({ owner: "me/" });
    const rows = await human.request<{ rows: { event: string }[] }>("log", { scope: true });
    expect(rows.rows.filter((r) => r.event === "scope_reset")).not.toHaveLength(0);
  });

  test("a spawned harness cannot exact-bind its root or a child from the root's shells", async () => {
    const broker = await start();
    await broker.agent("lead", "claude-code", {}, claim(1));
    const kid = await shell(broker, "kid", [30, 1]);
    await kid.close();
    await broker.agent("w", "codex", {}, { ...claim(20), lineage: [20, 15, 1].map(key) });
    expect(await refusal(shell(broker, "kid", [50, 20, 15, 1]))).toBe("unauthorized");
    expect(await refusal(shell(broker, "lead", [50, 20, 15, 1]))).toBe("unauthorized");
  });

  test("adoption refuses subagent endpoints even after terminal unlink", async () => {
    const broker = await start();
    await broker.agent("lead", "claude-code", {}, claim(1));
    const child = await sub(broker);
    const peer = await broker.agent("peer");
    await (await broker.human()).request("unlink", { endpoint: child.hello.endpoint!.address });
    expect(await refusal(peer.request("adopt", { endpoint: child.hello.endpoint!.address }))).toBe("scope_refused");
  });

  test("claim under validates address length and type", async () => {
    const broker = await start();
    expect(await refusal((await broker.wire()).hello({ transient: true, claim: { handle: "long", under: "x".repeat(129) } }))).toBe("too_large");
    expect(
      await refusal((await broker.wire()).request("hello", { protocol: "scp/1", transient: true, claim: { handle: "odd", under: 5 } }, { unchecked: true })),
    ).toBe("invalid_params");
  });
});

brokerSuite("broker subagent handle bounds", (start) => {
  test("derived handles shorten long roots and types while leaving room for suffixes", async () => {
    const broker = await start();
    const root = "a".repeat(63);
    await broker.agent(root, "claude-code", {}, claim(1));
    const child = await broker.hook({ handle: root, ...claim(1), subagent: { id: "aceb553c19f223c70", type: "Some Plugin:Very-Long-Agent-Type-Name" } });
    const handle = child.hello.endpoint!.address.slice(3);
    expect(handle.length).toBeLessThanOrEqual(58);
    expect(handle).toEndWith("a-some-aceb");
    const mixed = await broker.hook({ handle: root, ...claim(1), subagent: { id: "ABC_def12" } });
    expect(mixed.hello.endpoint!.address).toEndWith("-agent-abcd");
  });
});
