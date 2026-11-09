import { expect, test } from "bun:test";
import { waitFor } from "../targets";
import { brokerSuite, type Start } from "./suite";
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

  test("a sessionless leave and join takes the row back seen now, and a sessionless claim after it does not take it by handle", async () => {
    const broker = await start();
    const a = await broker.agent("app");
    const peer = await broker.agent("peer");
    await peer.request("send", { to: "app", body: "kept" });
    const human = await broker.human();
    const presence = async (id: string) => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === id)?.presence;
    await a.request("leave");
    await a.close();
    await waitFor(async () => (await presence(a.id)) === "offline", "app offline");
    const join = await broker.wire();
    const joined = (await join.hello({ transient: true, claim: { handle: "app", harness: "claude-code" }, join: {} })).endpoint!;
    await join.close();
    expect(joined).toMatchObject({ id: a.id, address: "me/app" });
    expect(await presence(a.id)).not.toBe("offline");
    const log = await human.request<{ rows: { event: string; endpoint: string | null; detail: Record<string, unknown> }[] }>("log");
    expect(log.rows.filter((row) => row.event === "join").map((row) => row.detail)).toEqual([{ handle: "app" }]);
    const fresh = await broker.agent("app");
    expect(fresh.address).toBe("me/app-2");
    expect(await fresh.request("inbox")).toMatchObject({ messages: [] });
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

  test("a worker's shell proves only its own identity: --as its parent, a sibling or a peer is unauthorized, a free name lands under it", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "claude-code", {}, { ...session(2), harness_session: "lead-a" });
    const peer = await broker.agent("peer", "codex", {}, session(5));
    const grant = async (name: string) => (await lead.request<{ token: string }>("grant", { name, scope: "parent" })).token;
    const worker = (pid: number) => ({ process: key(pid), session: key(pid), lineage: [key(pid), key(3)] });
    const w1 = await broker.agent("w1", "claude-code", {}, { ...worker(4), grant: await grant("w1") });
    const w2 = await broker.agent("w2", "claude-code", {}, { ...worker(6), grant: await grant("w2") });
    expect([w1.hello.endpoint?.parent, w2.hello.endpoint?.parent]).toEqual(["me/lead", "me/lead"]);
    const shell = async (handle: string) =>
      (await broker.wire()).hello({ claim: { handle, exact: true, harness: "cli", lineage: [key(50), key(4), key(3)] }, self: [key(50), key(4)], brief: true });
    for (const handle of ["lead", "w2", "peer"]) expect(await refusal(shell(handle))).toBe("unauthorized");
    expect(await refusal(w1.request("send", { to: "lead", body: "spoofed", from: "me/lead" }, { unchecked: true }))).toBe("invalid_params");
    const fresh = (await shell("lead-placeholder")).endpoint;
    expect(fresh).toMatchObject({ address: "me/lead-placeholder", parent: "me/w1" });
    const human = await broker.human();
    const views = (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints;
    for (const [id, address] of [
      [lead.id, "me/lead"],
      [w2.id, "me/w2"],
      [peer.id, "me/peer"],
      [w1.id, "me/w1"],
    ])
      expect(views.find((e) => e.id === id)?.address).toBe(address);
    expect(await lead.request("inbox")).toMatchObject({ messages: [] });
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

  test("a takeover of a spawned worker places the root where the grant placed it, with the grant's caps, never as a linked row", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, session(1));
    await broker.agent("other", "codex", {}, session(9));
    const { token } = await lead.request<{ token: string }>("grant", { name: "w1", scope: "parent" });
    const worker = await broker.agent("w1", "codex", {}, { ...session(4), grant: token });
    expect(worker.hello.endpoint).toMatchObject({ parent: "me/lead", depth: 1 });
    const human = await broker.human();
    await worker.close();
    await waitFor(
      async () => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === worker.id)?.presence === "offline",
      "w1 offline",
    );
    const fresh = await broker.agent("fresh", "codex", {}, session(5));
    expect(await fresh.request("send", { to: "other", body: "as a root" })).toMatchObject({ deliveries: [{ address: "me/other" }] });
    expect(await human.request("rename", { endpoint: "fresh", handle: "w1", take_over: true })).toMatchObject({ id: fresh.id, address: "me/w1" });
    expect(await fresh.request("whoami")).toMatchObject({ parent: "me/lead", depth: 1 });
    expect(await refusal(fresh.request("send", { to: "other", body: "past the grant's scope" }))).toBe("not_found");
    expect(await fresh.request("send", { to: "lead", body: "to its parent" })).toMatchObject({ deliveries: [{ address: "me/lead" }] });
    expect(await refusal(fresh.request("leave"))).toBe("scope_refused");
    expect((await human.request<{ rows: { event: string }[] }>("log", { scope: true })).rows.map((r) => r.event)).not.toContain("adopt");
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
  /** the named endpoint `lead` of harness session resume-a with unread mail, offline, and a fresh session that holds `other` */
  async function stranded(start: Start) {
    const broker = await start();
    const old = await broker.agent("app", "claude-code", {}, { ...session(process.pid), harness_session: "resume-a" });
    const hook = await broker.hook({ handle: "app", ...session(process.pid), harness_session: "resume-a" });
    await hook.request("event", { kind: "tool", session_id: "resume-a" });
    await old.request("rename", { handle: "lead" });
    const human = await broker.human();
    await human.request("send", { to: "lead", body: "while away" });
    await old.request("leave");
    await old.close();
    await waitFor(
      async () => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === old.id)?.presence === "offline",
      "session offline",
    );
    const fresh = await broker.agent("other", "claude-code", {}, { ...session(1), harness_session: "fresh-a" });
    return { broker, human, fresh };
  }

  test("a hook reporting a session resumed in process rehomes its fresh endpoint onto the named one", async () => {
    const { broker, fresh } = await stranded(start);
    const resumed = await broker.hook({ handle: "other", ...session(1), harness_session: "resume-a" });
    expect(resumed.hello.endpoint).toMatchObject({ id: fresh.id, address: "me/lead" });
    expect(await fresh.request("inbox")).toMatchObject({ messages: [{ body: { text: "while away" } }] });
  });

  test("a session a harness daemon resumes in a new process keeps its grant's name, place and mail", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "claude-code", {}, session(2));
    const { token } = await lead.request<{ token: string }>("grant", { name: "w1", scope: "parent" });
    const daemon = (pid: number) => ({ process: key(pid), session: key(pid), lineage: [key(pid), key(3)], harness_session: "bg-a" });
    const hook = await broker.hook({ handle: "claude-app", ...daemon(process.pid) });
    const w1 = await broker.agent("w1", "claude-code", {}, { ...daemon(process.pid), grant: token });
    expect(w1.hello.endpoint).toMatchObject({ address: "me/w1", parent: "me/lead" });
    await hook.request("event", { kind: "tool", session_id: "bg-a" });
    await lead.request("send", { to: "w1", body: "while away" });
    await w1.close();
    await hook.request("event", { kind: "session_end" });
    await hook.close();
    await waitFor(
      async () => (await lead.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === w1.id)?.presence === "offline",
      "session offline",
    );
    const back = await broker.hook({ handle: "claude-app", ...daemon(1) });
    expect(back.hello.endpoint).toMatchObject({ id: w1.id, address: "me/w1", parent: "me/lead" });
    const shim = await broker.agent("claude-app", "claude-code", {}, daemon(1));
    expect(shim.hello.endpoint).toMatchObject({ id: w1.id, address: "me/w1", parent: "me/lead" });
    expect(await shim.request("inbox")).toMatchObject({ messages: [{ body: { text: "while away" } }] });
  });

  test("relink lists and applies the pairs for the human at a terminal only", async () => {
    const { broker, human, fresh } = await stranded(start);
    const hook = await broker.hook({ handle: "other", ...session(1), harness_session: "fresh-a" });
    await hook.request("event", { kind: "tool", session_id: "resume-a" });
    expect(await refusal(fresh.request("relink", {}))).toBe("scope_refused");
    expect(await refusal((await broker.human(false)).request("relink", {}))).toBe("scope_refused");
    const pair = { endpoint: fresh.id, from: "other", to: "lead", by: "session" };
    expect(await human.request("relink", { dry_run: true })).toEqual({ relinked: [pair] });
    expect(await fresh.request("whoami")).toMatchObject({ address: "me/other" });
    expect(await human.request("relink", {})).toMatchObject({ relinked: [pair] });
    expect(await fresh.request("whoami")).toMatchObject({ address: "me/lead" });
  });

  /** the ended lane of harness session lane-a on the derived `app`, or on `name` given, titled, with unread mail, under `boss` unless a root */
  async function endedLane(start: Start, root = false, name?: string) {
    const broker = await start();
    await broker.agent("boss", "codex");
    const handle = name ?? "app";
    const lane = { ...session(process.pid), harness_session: "lane-a", ...(name ? {} : { derived: true }) };
    const old = await broker.agent(handle, "claude-code", {}, lane);
    const hook = await broker.hook({ handle, ...lane });
    await hook.request("event", { kind: "tool", session_id: "lane-a" });
    await old.request("title", { text: "the lane" });
    const human = await broker.human();
    if (!root) await human.request("adopt", { endpoint: handle, parent: "boss" });
    await human.request("send", { to: handle, body: "for the lane" });
    await hook.request("event", { kind: "session_end" });
    await old.close();
    await waitFor(
      async () => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === old.id)?.presence === "offline",
      "lane offline",
    );
    const listed = async () => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === old.id);
    return { broker, human, old, listed };
  }

  test("an unrelated session claiming the ended lane's derived name never inherits its row, title, mail or parent", async () => {
    const { broker, human, old, listed } = await endedLane(start);
    const hook = await broker.hook({ handle: "app", ...session(2), harness_session: "other-a", derived: true });
    const shim = await broker.agent("app", "claude-code", {}, { ...session(1), harness_session: "other-b", derived: true });
    for (const claimed of [hook.hello.endpoint!, shim.hello.endpoint!]) {
      expect(claimed.id).not.toBe(old.id);
      expect(claimed).toMatchObject({ title: null, parent: null });
    }
    expect(await shim.request("inbox")).toMatchObject({ messages: [] });
    expect(await listed()).toMatchObject({ address: "me/app", title: "the lane", parent: "me/boss" });
    expect((await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.filter((e) => e.address === "me/app")).toHaveLength(1);
  });

  for (const by of ["session", "origin"] as const) {
    test(`a resumed session takes back only its own ended endpoint, by its ${by}`, async () => {
      const { broker, old, listed } = await endedLane(start, true);
      const unrelated = await broker.agent("app", "claude-code", {}, { ...session(2), harness_session: "other-a", derived: true });
      expect(unrelated.id).not.toBe(old.id);
      const resumed = by === "session" ? { harness_session: "lane-a" } : { harness_session: "fork-a", harness_origin: "lane-a" };
      const back = await broker.agent("app", "claude-code", {}, { ...session(1), ...resumed, derived: true });
      expect(back.hello.endpoint).toMatchObject({ id: old.id, address: "me/app", title: "the lane" });
      expect(await back.request("inbox")).toMatchObject({ messages: [{ body: { text: "for the lane" } }] });
      expect(await listed()).toMatchObject({ address: "me/app" });
    });
  }

  test("a hand-off claim that asks to sit under its origin never takes the origin's name", async () => {
    const broker = await start();
    const origin = { ...session(process.pid), harness_session: "origin-a" };
    const old = await broker.agent("app", "claude-code", {}, origin);
    const hook = await broker.hook({ handle: "app", ...origin });
    await hook.request("event", { kind: "tool", session_id: "origin-a" });
    await hook.close();
    await old.request("rename", { handle: "lead" });
    const fork = { ...session(1), harness_session: "fork-a", harness_origin: "origin-a", harness_handoff: true, under: "lead" };
    await broker.hook({ handle: "app", ...fork });
    await Bun.sleep(5);
    const again = await broker.hook({ handle: "app", ...fork });
    expect(again.hello.endpoint?.address).not.toBe("me/lead");
    expect(await old.request("whoami")).toMatchObject({ id: old.id, address: "me/lead" });
  });

  for (const via of ["claim", "join"] as const) {
    test(`a background hand-off takes the name its idle origin still holds, with its child and mail, and detaches the origin (hook ${via})`, async () => {
      const broker = await start();
      const human = await broker.human();
      const origin = { ...session(process.pid), harness_session: "origin-a" };
      const old = await broker.agent("app", "claude-code", {}, origin);
      const hook = await broker.hook({ handle: "app", ...origin });
      await hook.request("event", { kind: "tool", session_id: "origin-a" });
      await hook.close();
      await old.request("rename", { handle: "lead" });
      const worker = await broker.agent("worker", "codex", {}, { ...session(40), lineage: [key(40), key(process.pid)] });
      await human.request("send", { to: "lead", body: "while away" });
      const fork = { ...session(1), harness_session: "fork-a", harness_origin: "origin-a", harness_handoff: true };
      const started = await broker.hook({ handle: "app", ...fork });
      expect(started.hello.endpoint).toMatchObject({ address: "me/app" });
      const parallel = await broker.hook({ handle: "side", ...session(2), harness_session: "fork-b", harness_origin: "origin-a" });
      expect(parallel.hello.endpoint).toMatchObject({ address: "me/side" });
      await Bun.sleep(5);
      const moved = await broker.hook({ handle: "app", ...fork }, via === "join" ? { join: {} } : {});
      expect(moved.hello.endpoint).toMatchObject({ id: started.hello.endpoint?.id, address: "me/lead" });
      await waitFor(() => old.closed, "origin connection closed");
      expect((await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === parallel.hello.endpoint?.id)).toMatchObject({
        address: "me/side",
      });
      expect(await worker.request("whoami")).toMatchObject({ parent: "me/lead" });
      const shim = await broker.agent("app", "claude-code", {}, fork);
      expect(shim.hello.endpoint).toMatchObject({ id: started.hello.endpoint?.id, address: "me/lead" });
      expect(await shim.request("inbox")).toMatchObject({ messages: [{ body: { text: "while away" } }] });
    });
  }

  test("a shim taking back its name after its hook's derived claim is never moved onto the hook's endpoint", async () => {
    const { broker, old, listed } = await endedLane(start, true, "lane-a");
    const next = { ...session(1), harness_session: "next-a" };
    const hook = await broker.hook({ handle: "app", ...next, derived: true });
    await hook.request("event", { kind: "tool", session_id: "next-a" });
    const shim = await broker.agent("lane-a", "claude-code", {}, { ...next, harness_origin: "lane-a" });
    expect(shim.hello.endpoint).toMatchObject({ id: old.id, address: "me/lane-a" });
    const again = await broker.hook({ handle: "app", ...next, derived: true });
    expect(again.hello.endpoint).toMatchObject({ id: old.id, address: "me/lane-a" });
    expect(await shim.request("inbox")).toMatchObject({ messages: [{ body: { text: "for the lane" } }] });
    expect(await listed()).toMatchObject({ address: "me/lane-a", title: "the lane" });
  });

  test("a resumed session given a name claims that name, never another lane's ended endpoint", async () => {
    const { broker, old, listed } = await endedLane(start, true);
    const next = { ...session(1), harness_session: "next-a" };
    const hook = await broker.hook({ handle: "app", ...next, derived: true });
    expect(hook.hello.endpoint?.id).not.toBe(old.id);
    await hook.request("event", { kind: "tool", session_id: "next-a" });
    const named = await broker.agent("renamed", "claude-code", {}, next);
    expect(named.hello.endpoint).toMatchObject({ address: "me/renamed", title: null });
    expect(named.id).not.toBe(old.id);
    expect((await broker.hook({ handle: "app", ...next, derived: true })).hello.endpoint).toMatchObject({ id: named.id, address: "me/renamed" });
    expect(await listed()).toMatchObject({ address: "me/app", title: "the lane" });
  });

  test("a colliding claim never displaces a live holder, connected or reporting from a running process", async () => {
    const broker = await start();
    const holder = await broker.agent("app", "claude-code", {}, { ...session(process.pid), harness_session: "live-a", derived: true });
    const running = `pid:${process.ppid}`;
    const hooked = await broker.hook({ handle: "lane-b", process: running, session: running, lineage: [running], harness_session: "live-b" });
    await hooked.request("event", { kind: "tool", session_id: "live-b" });
    for (const claim of [{ derived: true }, {}]) {
      const other = await broker.agent("app", "claude-code", {}, { ...session(2), harness_session: "other-a", ...claim });
      expect(other.id).not.toBe(holder.id);
    }
    const hook = await broker.hook({ handle: "app", ...session(3), harness_session: "other-b", derived: true });
    expect(hook.hello.endpoint?.id).not.toBe(holder.id);
    const named = await broker.agent("lane-b", "claude-code", {}, { ...session(4), harness_session: "other-c" });
    expect(named.id).not.toBe(hooked.hello.endpoint?.id);
    expect(await holder.request("whoami")).toMatchObject({ address: "me/app" });
  });

  /** session `lane` of the harness daemon, its hooks' default claim first, its shim then taking back the named worker `lead` launched: the way a stopped worker resumes under a new id */
  const daemonSession = (pid: number, harness_session: string) => ({
    process: `pid:${pid}:conformance`,
    session: `pid:${pid}:conformance`,
    lineage: [`pid:${pid}:conformance`, "pid:3:conformance"],
    cwd: "/work",
    harness_session,
  });
  const walk = (pid: number) => {
    const shell = [`pid:${pid}:conformance`];
    return { self: shell, lineage: shell };
  };
  async function resumedLane(start: Start) {
    const broker = await start();
    const lead = await broker.agent("lead", "claude-code", {}, session(process.pid));
    const { token } = await lead.request<{ token: string }>("grant", { name: "lane-a" });
    const first = daemonSession(process.pid, "lane-1");
    const hook = await broker.hook({ handle: "claude-app", derived: true, ...first });
    const lane = await broker.agent("lane-a", "claude-code", {}, { ...first, grant: token });
    await hook.request("event", { kind: "tool", session_id: "lane-1" });
    await lane.close();
    await hook.request("event", { kind: "session_end" });
    await hook.close();
    const fork = daemonSession(process.ppid, "lane-2");
    const left = await broker.hook({ handle: "claude-app", derived: true, ...fork });
    expect(left.hello.endpoint?.id).not.toBe(lane.id);
    await left.close();
    const back = await broker.agent("lane-a", "claude-code", {}, { ...fork, harness_session: "lane-2", harness_origin: "lane-1" });
    expect(back.hello.endpoint).toMatchObject({ id: lane.id, address: "me/lane-a", parent: "me/lead" });
    return { broker, lead, lane: back, pid: process.ppid };
  }

  test("a shell in a resumed session binds its named endpoint, never the default row its hooks left", async () => {
    const { broker, lane, pid } = await resumedLane(start);
    const shell = await broker.observer(walk(pid));
    expect(shell.hello.endpoint).toMatchObject({ id: lane.id, address: "me/lane-a" });
  });

  test("a worker spawned from a resumed session's shell sits under its named endpoint and its result reaches that endpoint", async () => {
    const { broker, lane, pid } = await resumedLane(start);
    const shell = await broker.observer(walk(pid));
    const { token } = await shell.request<{ token: string }>("grant", { name: "lane-sol" });
    const worker = await broker.agent("lane-sol", "codex", {}, { ...session(40), lineage: [key(40), `pid:${pid}:conformance`], grant: token });
    expect(worker.hello.endpoint).toMatchObject({ address: "me/lane-sol", parent: "me/lane-a" });
    await worker.request("send", { to: "lane-a", body: "finished" });
    expect(await lane.request("inbox")).toMatchObject({ messages: [{ body: { text: "finished" } }] });
  });

  test("a row that lost the session but still names its harness process never outranks the row the session holds", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "claude-code", {}, session(process.pid));
    const { token } = await lead.request<{ token: string }>("grant", { name: "lane-a", scope: "parent" });
    const pid = process.ppid;
    const lane = await broker.agent("lane-a", "claude-code", {}, { ...daemonSession(pid, "lane-1"), session: "shim-a", grant: token });
    expect(lane.hello.endpoint).toMatchObject({ address: "me/lane-a", parent: "me/lead" });
    const root = await broker.hook({ handle: "claude-app", derived: true, ...daemonSession(pid, "lane-1"), session: "hooks-a", lineage: [] });
    expect(root.hello.endpoint).toMatchObject({ parent: null });
    await root.request("event", { kind: "session_end" });
    await root.close();
    expect((await broker.observer(walk(pid))).hello.endpoint).toMatchObject({ id: lane.id, address: "me/lane-a" });
  });

  test("a session's hook or shim at a default name passes by an ended row that has children", async () => {
    const broker = await start();
    const old = await broker.hook({ handle: "claude-app", derived: true, ...session(2) });
    const shell = await broker.observer({ self: [key(2)], lineage: [key(2)] });
    expect(shell.hello.endpoint?.id).toBe(old.hello.endpoint?.id);
    const { token } = await shell.request<{ token: string }>("grant", { name: "lane-sol", scope: "parent" });
    const worker = await broker.agent("lane-sol", "codex", {}, { ...session(40), grant: token });
    await old.request("event", { kind: "session_end" });
    await old.close();
    const parent = old.hello.endpoint?.address;
    expect(worker.hello.endpoint?.parent).toBe(parent);
    const hook = await broker.hook({ handle: "claude-app", derived: true, ...session(3), harness_session: "other-a" });
    const shim = await broker.agent("claude-app", "claude-code", {}, { ...session(4), harness_session: "other-b", derived: true });
    for (const claimed of [hook.hello.endpoint!, shim.hello.endpoint!]) expect(claimed.id).not.toBe(old.hello.endpoint?.id);
    expect(await worker.request("whoami")).toMatchObject({ parent });
  });

  test("a claim of no harness session takes back a restarted row with children, as a harness that reports none restarts", async () => {
    const broker = await start();
    const old = await broker.hook({ handle: "muse-app", harness: "muse", derived: true, ...session(2) });
    const shell = await broker.observer({ self: [key(2)], lineage: [key(2)] });
    const { token } = await shell.request<{ token: string }>("grant", { name: "lane-sol" });
    const worker = await broker.agent("lane-sol", "codex", {}, { ...session(40), grant: token });
    await old.request("event", { kind: "session_end" });
    await old.close();
    const back = await broker.agent("muse-app", "muse", {}, { ...session(3), derived: true });
    expect(back.id).toBe(old.hello.endpoint!.id);
    expect(await worker.request("whoami")).toMatchObject({ parent: "me/muse-app" });
  });

  test("a default name's ended empty row of no session stays free, its unread mail does not pass", async () => {
    const broker = await start();
    const empty = await broker.hook({ handle: "claude-app", derived: true, ...session(2) });
    await empty.request("event", { kind: "session_end" });
    await empty.close();
    const next = await broker.hook({ handle: "claude-app", derived: true, ...session(3), harness_session: "other-a" });
    expect(next.hello.endpoint?.id).toBe(empty.hello.endpoint?.id);
    await next.request("event", { kind: "session_end" });
    await next.close();
    const peer = await broker.agent("peer");
    const human = await broker.human();
    await human.request("rules_set", { endpoint: "peer", out: ["*"] });
    await peer.request("send", { to: "claude-app", body: "for whoever ran here" });
    const third = await broker.hook({ handle: "claude-app", derived: true, ...session(4), harness_session: "other-b" });
    expect(third.hello.endpoint?.id).not.toBe(empty.hello.endpoint?.id);
  });

  test("an ended row with a worker on another machine is passed by at a default name", async () => {
    const broker = await start();
    const old = await broker.hook({ handle: "claude-app", derived: true, ...session(2) });
    const shell = await broker.observer({ self: [key(2)], lineage: [key(2)] });
    await shell.request("spawn_via", { name: "far-sol", runner: "box", address: "me/far/far-sol", machine: "far" });
    await old.request("event", { kind: "session_end" });
    await old.close();
    const next = await broker.hook({ handle: "claude-app", derived: true, ...session(3), harness_session: "other-a" });
    expect(next.hello.endpoint?.id).not.toBe(old.hello.endpoint?.id);
  });

  test("a join-only hook makes no endpoint before its session's shim, and joins it after", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "claude-code", {}, session(process.pid));
    const { token } = await lead.request<{ token: string }>("grant", { name: "lane-a" });
    const claim = { handle: "claude-app", derived: true, join_only: true, ...daemonSession(process.ppid, "lane-1") };
    expect(await refusal(broker.hook(claim))).toBe("not_found");
    expect((await broker.observer(walk(process.ppid))).hello.endpoint).toBeNull();
    const lane = await broker.agent("lane-a", "claude-code", {}, { ...daemonSession(process.ppid, "lane-1"), grant: token });
    expect(lane.hello.endpoint).toMatchObject({ address: "me/lane-a", parent: "me/lead" });
    expect((await broker.hook(claim)).hello.endpoint?.id).toBe(lane.id);
    expect((await broker.observer(walk(process.ppid))).hello.endpoint?.id).toBe(lane.id);
    const human = await broker.human();
    const { endpoints } = await human.request<{ endpoints: View[] }>("list", { all: true });
    expect(endpoints.filter((view) => view.address.startsWith("me/claude-app"))).toEqual([]);
  });

  test("a join-only hook takes nothing by a default handle, and takes back its own session's row", async () => {
    const broker = await start();
    const empty = await broker.hook({ handle: "claude-app", derived: true, ...session(2) });
    await empty.request("event", { kind: "tool", session_id: "own-a" });
    await empty.request("event", { kind: "session_end" });
    await empty.close();
    const claim = (pid: number, harness_session: string) => ({ handle: "claude-app", derived: true, join_only: true, ...session(pid), harness_session });
    expect(await refusal(broker.hook(claim(3, "other-a")))).toBe("not_found");
    expect((await broker.hook(claim(4, "own-a"))).hello.endpoint?.id).toBe(empty.hello.endpoint?.id);
  });

  test("join_only is true or false", async () => {
    const broker = await start();
    const hello = { protocol: "scp/1", transient: true, claim: { handle: "claude-app", harness: "claude-code", join_only: "yes", ...session(2) } };
    expect(await refusal((await broker.wire()).request("hello", hello, { unchecked: true }))).toBe("invalid_params");
  });
});
