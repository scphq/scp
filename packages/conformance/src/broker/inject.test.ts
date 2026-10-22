import { expect, test } from "bun:test";
import { waitFor } from "../targets";
import { brokerSuite, type BrokerFixture } from "./suite";
import { refusal } from "./wire";

const processKey = `pid:${process.pid}:conformance`;
type Offer = {
  messages: { seq: number; body: { text: string } }[];
  offered: number[];
  hold: string;
  nudge: { seq: number; id: string; unread: boolean }[];
  directive_seqs: number[];
};
async function session(broker: BrokerFixture, handle = "lane") {
  const claim = { process: processKey, session: `session-${handle}` };
  const agent = await broker.agent(handle, "claude-code", {}, claim);
  const hook = await broker.hook({ handle, ...claim });
  return { agent, hook };
}

brokerSuite("broker injection", (start) => {
  test("hooks join without tokens, preserve the session and have only hook powers", async () => {
    const broker = await start();
    const { agent, hook } = await session(broker);
    expect(hook.hello.endpoint!.id).toBe(agent.id);
    expect(hook.hello.token).toBeUndefined();
    expect(await hook.request("event", { kind: "tool", tool: "Bash", agent: "Explore 3f2a9c" })).toMatchObject({
      endpoint: "me/lane",
      agent: "Explore 3f2a9c",
    });
    expect(await hook.request("status", { state: "working", note: "hooked" })).toMatchObject({ status: { state: "working" } });
    for (const [method, params] of [
      ["send", { to: "me/", body: "x" }],
      ["inbox", {}],
      ["ack", { seqs: [] }],
      ["list", {}],
      ["snapshot", {}],
      ["watch", {}],
      ["title", { text: "x" }],
    ] as const) {
      expect(await refusal(hook.request(method, params))).toBe("unauthorized");
    }
    await hook.close();
    expect(await agent.request("whoami")).toMatchObject({ presence: "online" });
    const resumed = await broker.wire();
    expect((await resumed.hello({ resume: agent.hello.token })).endpoint!.id).toBe(agent.id);
  });

  test("concurrent hook offers are disjoint, capped, held from channels and confirmed under their own hold", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const { agent, hook } = await session(broker);
    const other = await broker.hook({ handle: "lane", session: "session-lane", process: processKey });
    for (let i = 0; i < 7; i++) await peer.request("send", { to: "lane", body: `m${i}` });
    const [a, b] = await Promise.all([hook.request<Offer>("inject"), other.request<Offer>("inject")]);
    expect([a.messages.length, b.messages.length].sort()).toEqual([2, 5]);
    expect(a.offered.filter((seq) => b.offered.includes(seq))).toEqual([]);
    expect(await agent.request("inbox", { offer: true })).toMatchObject({ messages: [], hold: null });
    expect(await hook.request("inject", { count: true })).toMatchObject({ unread: 7, waiting: 0 });
    expect(await hook.request("injected", { seqs: a.offered, hold: "hld_forged", read: a.offered })).toEqual({ injected: 0 });
    expect(await hook.request("injected", { seqs: a.offered, hold: a.hold, read: [...a.offered, ...b.offered] })).toEqual({ injected: a.offered.length });
    expect(await other.request("injected", { seqs: b.offered, hold: b.hold, read: b.offered })).toEqual({ injected: b.offered.length });
    expect(await hook.request("injected", { seqs: a.offered, hold: a.hold, read: a.offered })).toEqual({ injected: 0 });
    expect(await hook.request("inject")).toMatchObject({ messages: [], unread: 0 });
  });

  test("oversized offers stay unread while read confirmation acknowledges only shown messages in that hold", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const { agent, hook } = await session(broker);
    const other = await broker.agent("other");
    await peer.request("send", { to: "lane", body: "x".repeat(7168) });
    await peer.request("send", { to: "lane", body: "short" });
    await peer.request("send", { to: "other", body: "theirs" });
    const offer = await hook.request<Offer>("inject");
    const theirs = await other.request<Offer>("inject");
    expect(offer.messages.map((m) => m.body.text)).toEqual(["short"]);
    expect(offer.offered).toHaveLength(2);
    expect(await hook.request("injected", { seqs: offer.offered, hold: offer.hold, read: [...offer.messages.map((m) => m.seq), ...theirs.offered] })).toEqual({
      injected: 2,
    });
    expect((await agent.request<Offer>("inbox")).messages.map((m) => m.body.text.length)).toEqual([7168]);
    expect((await other.request<Offer>("inbox")).messages.map((m) => m.body.text)).toEqual(["theirs"]);
    expect(await hook.request("inject")).toMatchObject({ messages: [], unread: 1 });
  });

  test("counting stops offer no text and spend their three holds only when printed", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const { hook } = await session(broker);
    await peer.request("send", { to: "lane", body: "wait" });
    const params = { stop: true, count: true, hold_unread: true };
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++)
        expect(await hook.request("inject", params)).toMatchObject({ messages: [], offered: [], hold: null, unread: 1, block: true, forced: true });
      expect(await hook.request("injected", { seqs: [], hold: null, stop: true })).toEqual({ injected: 0, held: true });
    }
    expect(await hook.request("inject", params)).toMatchObject({ block: false, forced: false });
    expect(await hook.request("injected", { seqs: [], hold: null, stop: true })).toEqual({ injected: 0, held: false });
    await hook.request("event", { kind: "session_start" });
    expect(await hook.request("inject", params)).toMatchObject({ block: true });
    expect((await hook.request<Offer>("inject")).messages.map((m) => m.body.text)).toEqual(["wait"]);
  });

  test("required replies hold a stop after ack until answered", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const { agent, hook } = await session(broker);
    const sent = await peer.request<{ id: string }>("send", { to: "lane", body: "must know", kind: "request", require_reply: true });
    const page = await agent.request<Offer>("inbox");
    await agent.request("ack", { seqs: page.messages.map((m) => m.seq) });
    expect(await hook.request("inject", { stop: true })).toMatchObject({ unread: 0, awaiting: 1, block: true, forced: true });
    await agent.request("send", { to: "peer", body: "42", kind: "reply", reply_to: sent.id });
    expect(await hook.request("inject", { stop: true })).toMatchObject({ unread: 0, block: false, forced: false });
  });

  test("nudges contain metadata, repeat until confirmed and do not spend stop holds", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const { agent, hook } = await session(broker);
    const sent = await peer.request<{ id: string }>("send", { to: "lane", body: "QUESTION-BODY", kind: "request" });
    const stop = await hook.request<Offer>("inject", { stop: true, count: true });
    expect(stop).toMatchObject({ messages: [], offered: [], block: true, forced: false, nudge: [{ id: sent.id, unread: true, from: "me/peer" }] });
    expect(JSON.stringify(stop)).not.toContain("QUESTION-BODY");
    expect((await hook.request<Offer>("inject", { stop: true })).nudge).toEqual(stop.nudge);
    expect(await hook.request("injected", { seqs: [], hold: null, nudged: stop.nudge.map((n) => n.seq) })).toEqual({ injected: 0, nudged: 1 });
    expect(await hook.request("inject", { stop: true })).toMatchObject({ block: false });
    const page = await agent.request<Offer>("inbox");
    await agent.request("ack", { seqs: page.messages.map((m) => m.seq) });
    await peer.request("send", { to: "lane", body: "unread" });
    for (let i = 0; i < 3; i++) expect(await hook.request("injected", { seqs: [], hold: null, stop: true })).toMatchObject({ held: true });
  });

  test("foreign process hooks take no mail and cannot confirm nudges or reset budgets", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const { hook } = await session(broker);
    const child = await broker.hook({ handle: "lane", session: "session-lane", process: "pid:200:conformance" });
    await peer.request("send", { to: "lane", body: "question", kind: "request" });
    const stop = await hook.request<Offer>("inject", { stop: true });
    expect(await child.request("inject")).toEqual({ messages: [], offered: [], hold: null, more: 0, unread: 0, block: false });
    expect(await child.request("injected", { seqs: [], hold: null, stop: true, nudged: stop.nudge.map((n) => n.seq) })).toEqual({
      injected: 0,
      held: false,
      nudged: 0,
    });
    expect((await hook.request<Offer>("inject")).messages).toHaveLength(1);
  });

  test("deferred showing is delivered rather than read until inbox ack settles it", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const { agent, hook } = await session(broker);
    const sent = await peer.request<{ id: string }>("send", { to: "lane", body: "background" });
    const offer = await hook.request<Offer>("inject");
    await hook.request("injected", { seqs: offer.offered, hold: offer.hold, read: offer.offered, deferred: true });
    expect(await peer.request("receipts", { id: sent.id })).toMatchObject({
      recipients: [{ read_at: null, delivered_at: expect.any(String), shown_at: expect.any(String) }],
    });
    expect(await agent.request("inbox")).toMatchObject({ messages: [{ shown_at: expect.any(String) }] });
    expect(await agent.request("ack", { seqs: offer.offered })).toEqual({ acked: 0 });
    expect(await agent.request("inbox")).toMatchObject({ messages: [] });
  });

  test("prompt reminders count from the last note and title inference yields to explicit titles", async () => {
    const broker = await start();
    const { agent, hook } = await session(broker);
    const due = async () => (await hook.request<{ tldr?: boolean }>("prompted", { tldr_every: 3 })).tldr ?? false;
    expect([await due(), await due(), await due(), await due()]).toEqual([false, false, true, false]);
    await agent.request("status", { note: "fixing the parser" });
    expect([await due(), await due(), await due()]).toEqual([false, false, true]);
    expect(await hook.request("title_infer", { from: "prompt", text: "fix the  parser\n tests" })).toEqual({ changed: true });
    expect(await agent.request("whoami")).toMatchObject({ title: "fix the parser tests" });
    expect(await hook.request("title_infer", { from: "prompt", text: "later" })).toEqual({ changed: false });
    expect(await hook.request("title_infer", { from: "summary", text: "Parser test fixes" })).toEqual({ changed: true });
    expect(await hook.request("title_infer", { from: "summary", text: "newer" })).toEqual({ changed: false });
    await agent.request("title", { text: "chosen" });
    expect(await hook.request("title_infer", { from: "summary", text: "ignored" })).toEqual({ changed: false });
    expect(await agent.request("whoami")).toMatchObject({ title: "chosen" });
  });

  test("watchers see activity, status and offline settlement without message bodies", async () => {
    const broker = await start();
    const watcher = await broker.observer();
    await watcher.request("watch");
    const a = await broker.agent("a");
    await broker.agent("b");
    await a.request("send", { to: "b", body: "secret plan" });
    await a.request("status", { state: "working", note: "busy" });
    await a.request("event", { kind: "tool", tool: "Bash", summary: "bun test" });
    await a.close();
    await waitFor(() => watcher.fleet("status").some((e) => e.status === null), "offline settles status");
    expect(watcher.fleet().map((e) => e.type)).toEqual(["presence", "presence", "message", "status", "activity", "presence", "status"]);
    expect(JSON.stringify(watcher.fleet())).not.toContain("secret plan");
  });

  test("summary title refreshes after five prompts, redacts credentials and resets only on startup", async () => {
    const broker = await start();
    const { agent, hook } = await session(broker);
    await hook.request("title_infer", { from: "summary", text: "first" });
    for (let i = 0; i < 5; i++) await hook.request("prompted");
    expect(await hook.request("title_infer", { from: "summary", text: `use sk-ant-${"a".repeat(40)} ${"x".repeat(70)}` })).toEqual({ changed: true });
    const title = (await agent.request<{ title: string }>("whoami")).title;
    expect(title).toHaveLength(64);
    expect(title).toStartWith("use [redacted");
    await hook.request("event", { kind: "session_start", summary: "compact" });
    expect(await agent.request("whoami")).toMatchObject({ title });
    await hook.request("event", { kind: "session_start", summary: "startup" });
    expect(await agent.request("whoami")).toMatchObject({ title: null });
  });

  test("activity is cleaned, capped, redacted and visible in snapshots", async () => {
    const broker = await start();
    const { hook } = await session(broker);
    const observer = await broker.observer();
    await hook.request("event", { kind: "session_start" });
    const activity = await hook.request<{ summary: string }>("event", {
      kind: "tool",
      tool: "Bash",
      summary: `ran tests sk-ant-${"x".repeat(30)} ${"y".repeat(400)}`,
    });
    expect(activity.summary.length).toBe(200);
    expect(activity.summary).toContain("[redacted anthropic key]");
    expect(activity.summary).not.toContain(`sk-ant-${"x".repeat(30)}`);
    expect(await refusal(hook.request("event", { kind: "prompt" }, { unchecked: true }))).toBe("invalid_params");
    expect(await refusal(hook.request("event", { kind: "tool", agent: "a".repeat(65) }, { unchecked: true }))).toBe("too_large");
    const snapshot = await observer.request<{ activity: { endpoint: string; kind: string }[] }>("snapshot");
    expect(snapshot.activity.map((row) => [row.endpoint, row.kind])).toEqual([
      ["me/lane", "session_start"],
      ["me/lane", "tool"],
    ]);
  });

  test("nudges distinguish read requests, skip answered and required ones and cap the remainder", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const { agent, hook } = await session(broker);
    const read = await peer.request<{ id: string }>("send", { to: "lane", body: "read", kind: "request" });
    const page = await agent.request<Offer>("inbox");
    await agent.request("ack", { seqs: page.messages.map((m) => m.seq) });
    const answered = await peer.request<{ id: string }>("send", { to: "lane", body: "answered", kind: "request" });
    await agent.request("send", { to: "peer", body: "done", kind: "reply", reply_to: answered.id });
    await peer.request("send", { to: "lane", body: "must", kind: "request", require_reply: true });
    expect(await hook.request("inject", { stop: true })).toMatchObject({ awaiting: 1, nudge: [{ id: read.id, unread: false }], forced: true });
    for (let i = 0; i < 6; i++) await peer.request("send", { to: "lane", body: `q${i}`, kind: "request" });
    const capped = await hook.request<Offer & { nudge_more: number }>("inject", { stop: true });
    expect(capped.nudge).toHaveLength(5);
    expect(capped.nudge_more).toBe(2);
  });

  test("deferred shows settle on a later holding-process prompt", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const { agent, hook } = await session(broker);
    await peer.request("send", { to: "lane", body: "deferred" });
    const offer = await hook.request<Offer>("inject");
    await hook.request("injected", { seqs: offer.offered, hold: offer.hold, read: offer.offered, deferred: true });
    await hook.request("event", { kind: "stop" });
    expect(await agent.request("inbox")).toMatchObject({ messages: [{ shown_at: expect.any(String) }] });
    await Bun.sleep(2050);
    await hook.request("prompted");
    expect(await agent.request("inbox")).toMatchObject({ messages: [] });
  });

  test("only the holding hook ends a session and session_start restores hook presence", async () => {
    const broker = await start();
    const own = await broker.hook({ handle: "hooked", process: processKey, session: "hook-only" });
    const foreign = await broker.hook({ handle: "hooked", process: "pid:999992:conformance", session: "hook-only" });
    await foreign.request("event", { kind: "session_end" });
    expect(await own.request("whoami")).toMatchObject({ presence: "online" });
    await own.request("event", { kind: "session_end" });
    expect(await own.request("whoami")).toMatchObject({ presence: "offline" });
    await own.request("event", { kind: "tool", tool: "Read" });
    expect(await own.request("whoami")).toMatchObject({ presence: "offline" });
    await own.request("event", { kind: "session_start" });
    expect(await own.request("whoami")).toMatchObject({ presence: "online" });
  });

  test("a root hook infers and redacts a subagent title", async () => {
    const broker = await start();
    const { hook } = await session(broker);
    expect(await hook.request("subagent_title", { id: "abcdef12", title: "Map the\nbroker" })).toEqual({ changed: false });
    const sub = await broker.hook({ handle: "lane", process: processKey, session: "session-lane", subagent: { id: "abcdef12", type: "Explore" } });
    expect(await sub.request("whoami")).toMatchObject({ title: "Map the broker" });
    expect(await hook.request("subagent_title", { id: "abcdef12", title: `use sk-ant-${"a".repeat(30)}` })).toEqual({ changed: true });
    const redacted = await sub.request("whoami");
    expect(redacted).toMatchObject({ title: "use [redacted anthropic key]" });
    expect(JSON.stringify(redacted)).not.toContain(`sk-ant-${"a".repeat(30)}`);
    expect(await refusal(hook.request("subagent_title", { id: "../bad", title: "x" }, { unchecked: true }))).toBe("invalid_params");
  });

  test("pipeline hello, event and inject bind the hook before the later requests", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const { agent } = await session(broker);
    await peer.request("send", { to: "lane", body: "pipeline" });
    const wire = await broker.wire();
    const [hello, activity, offer] = await Promise.all([
      wire.hello({ transient: true, claim: { handle: "lane", harness: "claude-code", process: processKey, session: "session-lane" } }),
      wire.request("event", { kind: "tool", tool: "Read" }),
      wire.request<Offer>("inject"),
    ]);
    expect(hello.endpoint!.id).toBe(agent.id);
    expect(activity).toMatchObject({ endpoint: "me/lane", kind: "tool" });
    expect(offer.messages.map((m) => m.body.text)).toEqual(["pipeline"]);
  });

  test("hooks preserve the session token and fields while updating reported metadata", async () => {
    const broker = await start();
    const agent = await broker.agent("lane", "claude-code", {}, { process: processKey, session: "s1", model: "opus", cwd: "/w", labels: { role: "impl" } });
    const hook = await broker.hook({ handle: "other", process: processKey, session: "s1", model: "sonnet" });
    expect(hook.hello.endpoint).toMatchObject({ id: agent.id, address: "me/lane", model: "sonnet", cwd: "/w", labels: { role: "impl" } });
    const resumed = await broker.wire();
    expect((await resumed.hello({ resume: agent.hello.token })).endpoint!.id).toBe(agent.id);
  });

  test("restart preserves the session's hook binding and resume token", async () => {
    const broker = await start();
    const { agent } = await session(broker);
    const id = agent.id;
    const token = agent.hello.token;
    await broker.restart();
    const hook = await broker.hook({ handle: "derived", process: processKey, session: "session-lane" });
    expect(hook.hello.endpoint).toMatchObject({ id, address: "me/lane", presence: "online" });
    const resumed = await broker.wire();
    expect((await resumed.hello({ resume: token })).endpoint!.id).toBe(id);
  });

  test("presence changes only at first connect and last disconnect, and done status survives", async () => {
    const broker = await start();
    const watcher = await broker.observer();
    await watcher.request("watch");
    const first = await broker.agent("steady");
    const second = await broker.wire();
    await second.hello({ resume: first.hello.token });
    await second.close();
    const brief = await broker.agent("oneshot", "cli", { brief: true });
    await brief.close();
    await first.request("status", { state: "done" });
    await first.close();
    await waitFor(() => watcher.fleet("presence").some((e) => e.presence === "offline"), "offline presence");
    expect(watcher.fleet("presence").map((e) => [e.endpoint, e.presence])).toEqual([
      ["me/steady", "online"],
      ["me/steady", "offline"],
    ]);
    expect(watcher.fleet("status").map((e) => e.status)).toEqual([{ state: "done", note: "" }]);
  });

  test("a shim takes its hooks' unread mail and stop budget when reclaiming its earlier handle", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const old = await broker.agent("returning");
    await old.close();
    const hook = await broker.hook({ handle: "derived", process: processKey, session: "new-session" });
    await peer.request("send", { to: "derived", body: "read already" });
    const offered = await hook.request<Offer>("inject");
    await hook.request("injected", { seqs: offered.offered, hold: offered.hold, read: offered.offered });
    await peer.request("send", { to: "derived", body: "unread" });
    await hook.request("injected", { seqs: [], hold: null, stop: true });
    const agent = await broker.agent("returning", "claude-code", {}, { process: processKey, session: "new-session" });
    expect(agent.id).toBe(old.id);
    expect(await agent.request("inbox")).toMatchObject({ messages: [{ body: { text: "unread" } }] });
    const own = await broker.hook({ handle: "returning", process: processKey, session: "new-session" });
    for (let i = 0; i < 2; i++) {
      expect(await own.request("inject", { stop: true, count: true, hold_unread: true })).toMatchObject({ block: true });
      expect(await own.request("injected", { seqs: [], hold: null, stop: true })).toMatchObject({ held: true });
    }
    expect(await own.request("inject", { stop: true, count: true, hold_unread: true })).toMatchObject({ block: false });
  });

  test("another connecting claim sharing a session receives its own token and inbox", async () => {
    const broker = await start();
    const peer = await broker.agent("peer");
    const parent = await broker.agent("lane", "claude-code", {}, { session: "shared" });
    await peer.request("send", { to: "lane", body: "parent only" });
    const child = await broker.agent("lane", "claude-code", {}, { session: "shared" });
    expect(child.id).not.toBe(parent.id);
    expect(child.address).toBe("me/lane-2");
    expect(child.hello.token).not.toBe(parent.hello.token);
    expect(await child.request("inbox")).toMatchObject({ messages: [] });
    expect(await parent.request("inbox")).toMatchObject({ messages: [{ body: { text: "parent only" } }] });
    const hook = await broker.hook({ handle: "lane", session: "shared" });
    expect(hook.hello.endpoint!.id).toBe(parent.id);
  });

  test("the connecting session renames the endpoint its hooks registered and notifies watchers", async () => {
    const broker = await start();
    const watcher = await broker.observer();
    await watcher.request("watch");
    const peer = await broker.agent("peer");
    const hook = await broker.hook({ handle: "derived", process: processKey, session: "renaming" });
    await peer.request("send", { to: "derived", body: "before shim" });
    const shim = await broker.agent("chosen", "claude-code", {}, { process: processKey, session: "renaming" });
    expect(shim.id).toBe(hook.hello.endpoint!.id);
    expect(await shim.request("inbox")).toMatchObject({ messages: [{ body: { text: "before shim" } }] });
    await waitFor(() => watcher.fleet("presence").some((e) => e.endpoint === "me/chosen"), "renamed presence");
    expect(
      watcher
        .fleet("presence")
        .filter((e) => e.endpoint !== "me/peer")
        .map((e) => e.endpoint),
    ).toEqual(["me/derived", "me/chosen"]);
    expect((await broker.hook({ handle: "derived", process: processKey, session: "renaming" })).hello.endpoint!.id).toBe(shim.id);
  });

  test("a bare process key hook and full process key shim share their session", async () => {
    const broker = await start();
    const hook = await broker.hook({ handle: "lane", process: `pid:${process.pid}`, session: "bare-key" });
    const shim = await broker.agent("lane", "claude-code", {}, { process: processKey, session: "bare-key" });
    expect(shim.id).toBe(hook.hello.endpoint!.id);
    expect(shim.hello.token).toStartWith("kre_");
  });

  for (const method of ["list", "snapshot"] as const) {
    test(`${method} settles offline working and waiting status and preserves blocked, done and live status`, async () => {
      const broker = await start();
      for (const state of ["working", "waiting", "blocked", "done"]) {
        const agent = await broker.agent(`gone-${state}`, "claude-code", { brief: true });
        await agent.request("status", { state, note: state });
        await agent.close();
      }
      const live = await broker.agent("live");
      await live.request("status", { state: "working", note: "busy" });
      const observer = await broker.observer();
      const result = await observer.request<{ endpoints: { address: string; status: { state: string } | null }[] }>(method, { all: true });
      expect(
        ["working", "waiting", "blocked", "done"].map((state) => result.endpoints.find((e) => e.address === `me/gone-${state}`)!.status?.state ?? null),
      ).toEqual([null, null, "blocked", "done"]);
      expect(result.endpoints.find((e) => e.address === "me/live")!.status).toMatchObject({ state: "working" });
    });
  }
});
