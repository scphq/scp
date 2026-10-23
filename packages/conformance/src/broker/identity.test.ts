import { expect, test } from "bun:test";
import { waitFor } from "../targets";
import { brokerSuite } from "./suite";
import { refusal, type View } from "./wire";

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`;
const session = (pid: number) => ({ process: key(pid), session: key(pid), lineage: [key(pid)] });

brokerSuite("broker identity", (start) => {
  test("claims suffix occupied handles and resume tokens rebind the same endpoint", async () => {
    const broker = await start();
    const a = await broker.agent("app");
    const b = await broker.agent("app");
    expect(b.address).toBe("me/app-2");
    expect(a.hello.token).toMatch(/^kre_[0-9a-f]{64}$/);
    const resumed = await broker.wire();
    expect((await resumed.hello({ resume: a.hello.token })).endpoint?.id).toBe(a.id);
    expect(await refusal((await broker.wire()).hello({ resume: `kre_${"0".repeat(64)}` }))).toBe("unauthorized");
  });

  test("rename preserves identity, inbox and threads and later session claims keep its chosen name", async () => {
    const broker = await start();
    const a = await broker.agent("app", "claude-code", {}, session(1));
    const peer = await broker.agent("peer");
    const sent = await peer.request<{ thread: string }>("send", { to: "app", body: "before" });
    expect(await a.request("rename", { handle: "lead" })).toMatchObject({ id: a.id, address: "me/lead" });
    expect(await a.request("inbox")).toMatchObject({ messages: [{ body: { text: "before" }, thread: sent.thread }] });
    expect(await peer.request("send", { to: "lead", body: "after", thread: sent.thread })).toMatchObject({ thread: sent.thread });
    expect(await refusal(peer.request("send", { to: "app", body: "gone" }))).toBe("not_found");
    expect((await broker.hook({ handle: "app", ...session(1) })).hello.endpoint).toMatchObject({ id: a.id, address: "me/lead" });
  });

  test("rename rewrites endpoint selectors", async () => {
    const broker = await start();
    const a = await broker.agent("app");
    const peer = await broker.agent("peer");
    await peer.request("rules_set", { in: ["ep:app"] });
    await a.request("rename", { handle: "lead" });
    expect(await peer.request("rules")).toMatchObject({ rules: { in: ["ep:lead"] } });
    await a.request("send", { to: "peer", body: "still allowed" });
  });

  test("rename refuses occupied and invalid handles without suffixing", async () => {
    const broker = await start();
    const a = await broker.agent("app");
    await broker.agent("peer");
    for (const handle of ["peer", "relay", "me", "_human", "Bad Name", ""]) {
      expect(await refusal(a.request("rename", { handle }))).toBe("invalid_params");
    }
    expect(await a.request("whoami")).toMatchObject({ address: "me/app" });
  });

  // The claiming socket keeps the endpoint online after leave (SPEC 6.12).
  test.todo("leave from the claiming connection shows the endpoint offline and keeps its mail", async () => {
    const broker = await start();
    const a = await broker.agent("app");
    const peer = await broker.agent("peer");
    await peer.request("send", { to: "app", body: "kept" });
    const human = await broker.human();
    const result = await a.request("leave");
    const observed = await human.request<{ endpoints: View[] }>("list", { all: true });
    await a.close();
    await waitFor(
      async () => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === a.id)?.presence === "offline",
      "app offline",
    );
    expect(result).toMatchObject({ id: a.id, presence: "offline" });
    expect(observed.endpoints.find((e) => e.id === a.id)?.presence).toBe("offline");
    const back = await broker.agent("app");
    expect(back.id).toBe(a.id);
    expect(await back.request("inbox")).toMatchObject({ messages: [{ body: { text: "kept" } }] });
  });

  test("a transient join names the session and a refused join creates no endpoint", async () => {
    const broker = await start();
    await broker.agent("peer");
    const refused = await broker.wire();
    expect(await refusal(refused.hello({ transient: true, claim: { handle: "app", harness: "claude-code", ...session(1) }, join: { handle: "peer" } }))).toBe(
      "invalid_params",
    );
    const wire = await broker.wire();
    const hello = await wire.hello({ transient: true, claim: { handle: "app", harness: "claude-code", ...session(1) }, join: { handle: "lead" } });
    expect(hello.endpoint?.address).toBe("me/lead");
    expect((await broker.hook({ handle: "app", ...session(1) })).hello.endpoint?.id).toBe(hello.endpoint?.id);
    const human = await broker.human();
    expect((await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.map((e) => e.address)).not.toContain("me/app");
  });

  test("workers cannot rename or leave by default; terminal authority can rename them", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "claude-code", {}, session(1));
    const worker = await broker.agent("worker", "codex", {}, { ...session(2), lineage: [key(2), key(1)] });
    expect(worker.hello.endpoint?.parent).toBe(lead.address);
    expect(await refusal(worker.request("rename", { handle: "w2" }))).toBe("scope_refused");
    expect(await refusal(worker.request("leave"))).toBe("scope_refused");
    expect(await refusal(lead.request("rename", { endpoint: "worker", handle: "w2" }))).toBe("scope_refused");
    expect(await (await broker.human()).request("rename", { endpoint: "worker", handle: "w2" })).toMatchObject({ id: worker.id, address: "me/w2" });
    expect(await refusal((await broker.human(false)).request("rename", { endpoint: "w2", handle: "w3" }))).toBe("scope_refused");
  });

  test("policy can let a worker rename itself", async () => {
    const broker = await start({ policy: { rules: [], defaults: { rename: "self" } } });
    await broker.agent("lead", "codex", {}, session(1));
    const w = await broker.agent("w", "codex", {}, { ...session(2), lineage: [key(2), key(1)] });
    expect(await w.request("rename", { handle: "named" })).toMatchObject({ id: w.id, address: "me/named" });
  });

  test("an exact claim refuses another live harness and binds from the session's own shell", async () => {
    const broker = await start();
    const a = await broker.agent("app", "claude-code", {}, session(1));
    const elsewhere = await broker.wire();
    expect(await refusal(elsewhere.hello({ claim: { handle: "app", harness: "cli", exact: true, lineage: [key(900)] }, brief: true }))).toBe("unauthorized");
    const own = await broker.agent("app", "cli", { self: [key(40), key(1)], brief: true }, { exact: true, lineage: [key(40), key(1)] });
    expect(own.id).toBe(a.id);
    expect(own.hello.token).toBeUndefined();
  });

  test("titles collapse whitespace, clear on empty, reject secrets and survive claims", async () => {
    const broker = await start();
    const a = await broker.agent("app", "claude-code", {}, session(1));
    expect(await a.request("title", { text: "  Map the\n broker  " })).toMatchObject({ title: "Map the broker" });
    expect((await broker.hook({ handle: "app", ...session(1) })).hello.endpoint?.title).toBe("Map the broker");
    expect(await refusal(a.request("title", { text: "x".repeat(65) }, { unchecked: true }))).toBe("too_large");
    expect(await refusal(a.request("title", { text: `ghp_${"A1b2C3d4".repeat(5)}` }))).toBe("secret_refused");
    expect(await a.request("title", { text: "" })).toMatchObject({ title: null });
    const hook = await broker.hook({ handle: "app", ...session(1) });
    expect(await refusal(hook.request("title", { text: "forbidden" }))).toBe("unauthorized");
  });

  test("hook title inference uses prompt then summary and explicit titles win", async () => {
    const broker = await start();
    const a = await broker.agent("app", "claude-code", {}, session(1));
    const hook = await broker.hook({ handle: "app", ...session(1) });
    expect(await hook.request("title_infer", { from: "prompt", text: "fix the  parser\n tests" })).toEqual({ changed: true });
    expect(await hook.request("title_infer", { from: "prompt", text: "later" })).toEqual({ changed: false });
    expect(await hook.request("title_infer", { from: "summary", text: "Parser fixes" })).toEqual({ changed: true });
    expect(await hook.request("title_infer", { from: "summary", text: "New summary" })).toEqual({ changed: false });
    for (let i = 0; i < 5; i++) await hook.request("prompted");
    expect(await hook.request("title_infer", { from: "summary", text: `use ghp_${"A1b2C3d4".repeat(5)} ${"x".repeat(70)}` })).toEqual({ changed: true });
    const view = await a.request<View>("whoami");
    expect(view.title).toHaveLength(64);
    expect(view.title).not.toContain("ghp_");
    await a.request("title", { text: "chosen" });
    expect(await hook.request("title_infer", { from: "summary", text: "inferred" })).toEqual({ changed: false });
    expect(await a.request("whoami")).toMatchObject({ title: "chosen" });
  });

  test("note reminders count prompts since the last note or reminder", async () => {
    const broker = await start();
    const a = await broker.agent("app", "claude-code", {}, session(1));
    const h = await broker.hook({ handle: "app", ...session(1) });
    const due = async () => (await h.request<{ tldr?: boolean }>("prompted", { tldr_every: 3 })).tldr ?? false;
    expect([await due(), await due(), await due(), await due()]).toEqual([false, false, true, false]);
    await due();
    await a.request("status", { note: "fixing parser" });
    expect([await due(), await due(), await due()]).toEqual([false, false, true]);
    expect((await h.request("prompted", { tldr_every: 0 })).tldr).toBeUndefined();
  });
});

brokerSuite("broker identity state", (start) => {
  test("offline takeover requires a compatible harness and preserves queued mail", async () => {
    const broker = await start();
    const a = await broker.agent("worker", "codex");
    const peer = await broker.agent("peer");
    await peer.request("send", { to: "worker", body: "hello" });
    await a.close();
    const human = await broker.human();
    await waitFor(
      async () => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === a.id)?.presence === "offline",
      "worker offline",
    );
    expect((await broker.agent("worker", "grok")).address).toBe("me/worker-2");
    const back = await broker.agent("worker", "codex");
    expect(back.id).toBe(a.id);
    expect(await back.request("inbox")).toMatchObject({ messages: [{ body: { text: "hello" } }] });
  });

  test("claims reject invalid handles, harnesses, labels and malformed process keys", async () => {
    const broker = await start();
    for (const claim of [
      { handle: "Bad Name" },
      { handle: "me" },
      { handle: "relay" },
      { handle: "a", harness: "x y" },
      { handle: "a", process: "pid:5:x y" },
    ]) {
      const wire = await broker.wire();
      expect(await refusal(wire.hello({ claim }))).toBe("invalid_params");
    }
    const wire = await broker.wire();
    expect(await refusal(wire.hello({ claim: { handle: "a", harness_session: "bad id" } }))).toBe("invalid_params");
  });

  test("hello modes reject hook combinations and bare observers cannot act as endpoints", async () => {
    const broker = await start();
    for (const mode of [{ human: true }, { observe: true }, { resume: `kre_${"0".repeat(64)}` }]) {
      expect(await refusal((await broker.wire()).hello({ transient: true, claim: { handle: "app" }, ...mode }))).toBe("invalid_params");
    }
    const observer = await broker.observer();
    expect(observer.hello.endpoint).toBeNull();
    expect(await refusal(observer.request("whoami"))).toBe("unauthorized");
    expect(await refusal(observer.request("send", { to: "me/", body: "no" }))).toBe("unauthorized");
    expect((await broker.human()).hello.endpoint).toMatchObject({ address: "me/", kind: "human" });
  });

  test("status notes collapse whitespace and preserve unspecified state or note", async () => {
    const broker = await start();
    const a = await broker.agent("busy");
    expect(await a.request("status", { note: "  reviewing\n  #12 " })).toMatchObject({ status: { state: "working", note: "reviewing #12" } });
    await a.request("status", { state: "blocked", note: "ci red" });
    expect(await a.request("status", { note: "waiting on ci" })).toMatchObject({ status: { state: "blocked", note: "waiting on ci" } });
    expect(await a.request("status", { state: "working" })).toMatchObject({ status: { state: "working", note: "waiting on ci" } });
    expect(await a.request("status", { note: "" })).toMatchObject({ status: { state: "working", note: "" } });
    expect(await refusal(a.request("status", { note: "x".repeat(281) }, { unchecked: true }))).toBe("too_large");
  });

  test("list filters harness, kind and presence and returns claim metadata", async () => {
    const broker = await start();
    await broker.agent("a", "codex", {}, { cwd: "/repo", model: "model-a", labels: { machine: "other", lane: "x" } });
    await broker.agent("b", "grok");
    const human = await broker.human();
    const listed = await human.request<{ endpoints: View[] }>("list", { harness: "codex", kind: "agent", presence: "online" });
    expect(listed.endpoints).toMatchObject([{ address: "me/a", harness: "codex", cwd: "/repo", model: "model-a", labels: { machine: "other", lane: "x" } }]);
    expect((await human.request<{ endpoints: View[] }>("list", { kind: "human" })).endpoints.map((e) => e.address)).toEqual(["me/"]);
  });

  test("an exact CLI identity joins repeatedly and keeps its original resume token", async () => {
    const broker = await start();
    await broker.agent("lead", "codex", {}, session(1));
    const a = await broker.agent("lane", "cli", {}, { exact: true, lineage: [key(5), key(1)] });
    const b = await broker.agent("lane", "cli", {}, { exact: true, lineage: [key(6), key(1)] });
    expect(b.id).toBe(a.id);
    expect(b.hello.token).toBeUndefined();
    expect((await (await broker.wire()).hello({ resume: a.hello.token })).endpoint?.id).toBe(a.id);
    expect(await refusal(broker.agent("lane", "cli", {}, { exact: true, lineage: [key(70)] }))).toBe("unauthorized");
  });

  test("shared harness threads keep separate endpoints and lineage picks the reported session", async () => {
    const broker = await start();
    const processKey = key(process.pid);
    const thread = (id: string) =>
      broker.hook({ handle: "codex-app", harness: "codex-desktop", process: processKey, session: `codex:${id}`, harness_session: id, lineage: [key(1)] });
    const a = await thread("thread-a");
    await a.request("event", { kind: "tool", session_id: "thread-a" });
    const before = await broker.observer({ lineage: [processKey], harness_session: "thread-b" });
    expect(await refusal(before.request("rules"))).toBe("unauthorized");
    const b = await thread("thread-b");
    expect(b.hello.endpoint?.address).toBe("me/codex-app-2");
    await b.request("event", { kind: "tool", session_id: "thread-b" });
    const shell = await broker.observer({ self: [processKey], lineage: [processKey], harness_session: "thread-b" });
    expect(shell.hello.endpoint?.id).toBe(b.hello.endpoint!.id);
    expect((await thread("thread-a")).hello.endpoint?.id).toBe(a.hello.endpoint!.id);
  });

  test("terminal takeover transfers offline mail and children to the renamed endpoint", async () => {
    const broker = await start();
    const old = await broker.agent("old", "codex");
    const child = await broker.agent("child", "codex");
    const human = await broker.human();
    await human.request("adopt", { endpoint: "child", parent: "old" });
    await human.request("send", { to: "old", body: "kept" });
    await old.close();
    await waitFor(
      async () => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === old.id)?.presence === "offline",
      "old offline",
    );
    const fresh = await broker.agent("fresh", "codex");
    expect(await refusal(fresh.request("rename", { handle: "old", take_over: true }))).toBe("scope_refused");
    expect(await refusal((await broker.human(false)).request("rename", { endpoint: "fresh", handle: "old", take_over: true }))).toBe("scope_refused");
    expect(await human.request("rename", { endpoint: "fresh", handle: "old", take_over: true })).toMatchObject({ id: fresh.id, address: "me/old" });
    expect(await child.request("whoami")).toMatchObject({ parent: "me/old", depth: 1 });
    expect(await fresh.request("inbox")).toMatchObject({ messages: [{ body: { text: "kept" } }] });
  });
});

brokerSuite("broker resumed sessions", (start) => {
  for (const first of ["hook", "session"]) {
    test(`a resumed harness ${first} keeps its chosen name, link, child and mail`, async () => {
      const broker = await start();
      await broker.agent("boss", "codex");
      const old = await broker.agent("app", "claude-code", {}, { ...session(process.pid), harness_session: "resume-a" });
      const hook = await broker.hook({ handle: "app", ...session(process.pid), harness_session: "resume-a" });
      await hook.request("event", { kind: "tool", session_id: "resume-a" });
      await old.request("rename", { handle: "lead" });
      const human = await broker.human();
      await human.request("adopt", { endpoint: "lead", parent: "boss" });
      const worker = await broker.agent("worker", "codex", {}, { ...session(40), lineage: [key(40), key(process.pid)] });
      await human.request("send", { to: "lead", body: "while away" });
      await old.request("leave");
      await old.close();
      await waitFor(
        async () => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === old.id)?.presence === "offline",
        "session offline",
      );
      const extra = { ...session(1), harness_session: "resume-a" };
      const back = first === "hook" ? await broker.hook({ handle: "other", ...extra }) : await broker.agent("other", "claude-code", {}, extra);
      expect(back.hello.endpoint).toMatchObject({ id: old.id, address: "me/lead", parent: "me/boss" });
      const own = await broker.observer({ self: [key(1)], lineage: [key(1)] });
      expect(await own.request("inbox")).toMatchObject({ messages: [{ body: { text: "while away" } }] });
      expect(await worker.request("whoami")).toMatchObject({ parent: "me/lead" });
      expect((await human.request<{ rows: { event: string }[] }>("log", { scope: true })).rows.some((r) => r.event === "scope_reset")).toBe(false);
    });
  }
});
