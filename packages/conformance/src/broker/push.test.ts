import { expect, test } from "bun:test";
import { waitFor } from "../targets";
import { brokerSuite, type Start } from "./suite";

const key = (pid: number) => `pid:${pid}:conformance`;
type Offer = { messages: { body: { text: string }; relation?: string }[]; offered: number[]; hold: string; prompts: number; pushes_left: number };
async function setup(start: Start, noPush = false) {
  const broker = await start();
  const claim = { process: key(process.pid), session: "main-session", lineage: [key(process.pid)] };
  const main = await broker.agent("main", "claude-code", {}, claim);
  const hook = await broker.hook({ handle: "main", ...claim });
  const grant = await main.request<{ token: string; steer: { key: string; parent: string } }>("grant", { name: "w1", spawn: true, no_push: noPush });
  const worker = await broker.agent("w1", "codex", {}, { grant: grant.token, process: key(999991), session: "worker-session" });
  return { broker, main, hook, worker, grant };
}

brokerSuite("broker push", (start) => {
  test("waiting inject wakes on a worker message and returns empty at its deadline", async () => {
    const { hook, worker } = await setup(start);
    const waiting = hook.request<Offer>("inject", { wait_s: 3 });
    await worker.request("send", { to: "main", body: "wake up" });
    const offer = await waiting;
    expect(offer.messages.map((m) => m.body.text)).toEqual(["wake up"]);
    await hook.request("injected", { seqs: offer.offered, hold: offer.hold, read: offer.offered });
    const began = Date.now();
    expect(await hook.request("inject", { wait_s: 0.2 })).toMatchObject({ messages: [], offered: [] });
    expect(Date.now() - began).toBeGreaterThanOrEqual(150);
  });

  test("stop_wait wakes on child results, reserves them from tools and counts a printed push", async () => {
    const { hook, worker, main } = await setup(start);
    const waiting = hook.request<Offer>("stop_wait", { wait_s: 3 });
    await worker.request("send", { to: "main", body: "done-42" });
    const result = await waiting;
    expect(result).toMatchObject({ workers: ["me/w1"], pushes_left: 20, messages: [{ body: { text: "done-42" }, relation: "child" }] });
    expect(result.hold).toBeString();
    expect(await hook.request("inject")).toMatchObject({ messages: [] });
    expect(await hook.request("injected", { seqs: result.offered, hold: result.hold, read: result.offered, push: true })).toMatchObject({
      pushed: true,
      injected: 1,
    });
    expect(await hook.request("stop_wait", { wait_s: 0 })).toMatchObject({ pushes_left: 19 });
    expect(await main.request("inbox")).toMatchObject({ messages: [] });
  });

  test("stop_wait returns on deadline, last worker exit and immediately with no workers", async () => {
    const { hook, main, grant } = await setup(start);
    const began = Date.now();
    expect(await hook.request("stop_wait", { wait_s: 0.2 })).toMatchObject({ workers: ["me/w1"], messages: [] });
    expect(Date.now() - began).toBeGreaterThanOrEqual(150);
    const waiting = hook.request<Offer>("stop_wait", { wait_s: 3 });
    await main.request("spawn_exit", { grant: grant.token, code: 0, output: "done" });
    expect(await waiting).toMatchObject({ workers: [], starting: 0, messages: [{ body: { text: "worker me/w1 finished (exit 0)\n\ndone" } }] });
    expect(await hook.request("stop_wait", { wait_s: 3 })).toMatchObject({ workers: [], messages: [] });
  });

  test("a prompt interrupts a waiting stop and resets its push budget", async () => {
    const { hook } = await setup(start);
    const mark = (await hook.request<Offer>("inject", { stop: true })).prompts;
    const waiting = hook.request("stop_wait", { wait_s: 3, prompts: mark });
    expect(await hook.request("prompted")).toEqual({ prompted: true });
    expect(await waiting).toMatchObject({ prompted: true, messages: [], pushes_left: 20 });
  });

  test("a waker interrupts a waiting stop and future stops return promptly", async () => {
    const { hook, main, worker } = await setup(start);
    const waiting = hook.request("stop_wait", { wait_s: 3 });
    await main.request("wake", { via: "channels" });
    expect(await waiting).toMatchObject({ wakeable: true, workers: ["me/w1"] });
    await worker.request("send", { to: "main", body: "result" });
    expect(await hook.request("stop_wait", { wait_s: 3 })).toMatchObject({ wakeable: true, messages: [{ body: { text: "result" } }] });
    await main.request("wake", { via: "none" });
    expect(await hook.request("stop_wait", { wait_s: 0 })).not.toHaveProperty("wakeable");
  });

  test("no_push workers hold no stop and leave ordinary unread messages", async () => {
    const { hook, worker, main } = await setup(start, true);
    await worker.request("send", { to: "main", body: "queued" });
    expect(await hook.request("stop_wait", { wait_s: 3 })).toMatchObject({ workers: [], messages: [], others: 1 });
    expect(await main.request("inbox")).toMatchObject({ messages: [{ body: { text: "queued" } }] });
  });

  test("a foreign hook sees no workers and cannot interrupt a waiting stop", async () => {
    const { broker, hook } = await setup(start);
    const foreign = await broker.hook({ handle: "main", process: key(999992), session: "main-session" });
    expect(await foreign.request("stop_wait", { wait_s: 0 })).toMatchObject({ workers: [], messages: [] });
    expect(await foreign.request("prompted")).toEqual({ prompted: false });
    expect(await hook.request("stop_wait", { wait_s: 0 })).toMatchObject({ workers: ["me/w1"] });
  });

  test("worker intro, steer key, preamble and late directives are confirmed once", async () => {
    const { broker, main, grant } = await setup(start);
    const hook = await broker.hook({ handle: "w1", harness: "codex", process: key(999991), session: "worker-session" });
    expect(await hook.request("inject")).toMatchObject({ intro: "me/main", intro_key: grant.steer.key });
    expect(await hook.request("injected", { seqs: [], hold: null, intro: true, preamble: true })).toEqual({ injected: 0, briefed: true, introduced: true });
    expect(await hook.request("inject")).not.toHaveProperty("intro");
    await main.request("send", { to: "w1", body: "echo PINEAPPLE" });
    const stop = await hook.request<Offer & { directive_seqs: number[] }>("inject", { stop: true, directives: true });
    expect(stop).toMatchObject({
      block: true,
      brief: true,
      directives: [{ body: { text: "echo PINEAPPLE" }, relation: "parent", parent_key: grant.steer.key }],
    });
    expect(await hook.request("injected", { seqs: stop.offered, hold: stop.hold, read: stop.offered, restated: stop.directive_seqs })).toEqual({
      injected: 1,
      restated: 1,
    });
    expect(await hook.request("inject", { stop: true, directives: true })).toMatchObject({ block: false });
    await hook.request("event", { kind: "session_start" });
    expect(await hook.request("inject")).toMatchObject({ intro: "me/main" });
    expect(await hook.request("inject")).not.toHaveProperty("brief");
  });

  test("a worker result brings other unread messages while skipping a tool's held offer", async () => {
    const { broker, hook, worker } = await setup(start);
    const peer = await broker.agent("peer");
    await peer.request("send", { to: "main", body: "held" });
    expect(await hook.request("inject")).toMatchObject({ messages: [{ body: { text: "held" } }] });
    await peer.request("send", { to: "main", body: "alongside" });
    await worker.request("send", { to: "main", body: "result" });
    expect(await hook.request("stop_wait", { wait_s: 0 })).toMatchObject({
      messages: [{ body: { text: "result" } }, { body: { text: "alongside" } }],
      others: 1,
      others_shown: 1,
    });
  });

  test("push byte budgets count oversized offers and leave complete messages for a later push", async () => {
    const { hook, worker } = await setup(start);
    await worker.request("send", { to: "main", body: "x".repeat(20480) });
    for (let i = 0; i < 3; i++) await worker.request("send", { to: "main", body: String(i).repeat(6826) });
    const result = await hook.request<Offer>("stop_wait", { wait_s: 0 });
    expect(result.messages.map((m) => m.body.text[0])).toEqual(["0", "1"]);
    expect(result.offered).toHaveLength(3);
    expect(result).toMatchObject({ more: 2 });
  });

  test("other messages fill the remaining push budget whole, newest first within their cap", async () => {
    const { broker, hook, worker } = await setup(start);
    const peer = await broker.agent("peer");
    await peer.request("send", { to: "main", body: "held" });
    await hook.request("inject");
    for (let i = 0; i < 6; i++) await peer.request("send", { to: "main", body: `peer ${i}` });
    await worker.request("send", { to: "main", body: "done" });
    const result = await hook.request<Offer>("stop_wait", { wait_s: 0 });
    expect(result.messages.map((m) => m.body.text)).toEqual(["done", "peer 1", "peer 2", "peer 3", "peer 4", "peer 5"]);
    expect(result).toMatchObject({ others: 2, others_shown: 5 });
  });

  test("workers finishing together are gathered into one push without waiting for the quiet timeout", async () => {
    const { broker, main, hook, worker } = await setup(start);
    const grant = await main.request<{ token: string }>("grant", { name: "w2", spawn: true });
    const w2 = await broker.agent("w2", "codex", {}, { grant: grant.token });
    const waiting = hook.request<Offer>("stop_wait", { wait_s: 3 });
    await worker.request("send", { to: "main", body: "one" });
    await waitFor(
      async () => Object.values((await main.request<{ unread: Record<string, number> }>("snapshot")).unread).some((n) => n > 0),
      "worker mail available",
      5000,
    );
    await w2.request("send", { to: "main", body: "two" });
    const began = Date.now();
    expect((await waiting).messages.map((m) => m.body.text)).toEqual(["one", "two"]);
    expect(Date.now() - began).toBeLessThan(5000);
  });

  test("a parent's directives restate once, consume five holds and reset at session start", async () => {
    const { broker, main } = await setup(start);
    const hook = await broker.hook({ handle: "w1", harness: "codex", process: key(999991), session: "worker-session" });
    for (let i = 0; i < 5; i++) {
      await main.request("send", { to: "w1", body: `steer ${i}` });
      const held = await hook.request<Offer & { directive_seqs: number[] }>("inject", { stop: true, directives: true });
      expect(held).toMatchObject({ block: true });
      expect(await hook.request("injected", { seqs: [], hold: null, restated: held.directive_seqs })).toMatchObject({ restated: 1 });
    }
    await main.request("send", { to: "w1", body: "one too many" });
    expect(await hook.request("inject", { stop: true, directives: true })).toMatchObject({ block: false });
    await hook.request("event", { kind: "session_start" });
    expect(await hook.request("inject", { stop: true, directives: true })).toMatchObject({ directives: [{ body: { text: "one too many" } }] });
  });

  test("tool injection leaves a live worker's large message for the stop push", async () => {
    const { hook, worker } = await setup(start);
    await worker.request("send", { to: "main", body: "w".repeat(7168) });
    expect(await hook.request("inject")).toMatchObject({ messages: [], offered: [] });
    expect(await hook.request("stop_wait", { wait_s: 0 })).toMatchObject({ messages: [{ body: { text: "w".repeat(7168) } }] });
  });

  test("a late parent directive stops holding after a later main-thread tool event", async () => {
    const { broker, main } = await setup(start);
    const hook = await broker.hook({ handle: "w1", harness: "codex", process: key(999991), session: "worker-session" });
    await hook.request("event", { kind: "tool", tool: "Bash" });
    await main.request("send", { to: "w1", body: "late" });
    const offer = await hook.request<Offer>("inject");
    await hook.request("injected", { seqs: offer.offered, hold: offer.hold, read: offer.offered });
    const late = await hook.request<Offer>("inject", { stop: true, directives: true });
    expect(late).toMatchObject({ directives: [{ body: { text: "late" } }] });
    await hook.request("event", { kind: "tool", tool: "Edit", agent: "Explore a1b2c3" });
    expect(await hook.request("inject", { stop: true, directives: true })).toHaveProperty("directives");
    await hook.request("event", { kind: "tool", tool: "Edit" });
    expect(await hook.request("inject", { stop: true, directives: true })).not.toHaveProperty("directives");
  });

  test("parent, ancestor, child and unrelated senders carry only broker-computed relations and steer keys", async () => {
    const { broker, main, worker, grant } = await setup(start);
    const childGrant = await worker.request<{ token: string; steer: { key: string } }>("grant", { name: "sub", spawn: true });
    const sub = await broker.agent("sub", "codex", {}, { grant: childGrant.token });
    const peer = await broker.agent("peer");
    const human = await broker.human();
    await human.request("rules_set", { endpoint: "peer", out: ["*"] });
    await main.request("send", { to: "w1", body: "parent" });
    await main.request("send", { to: "sub", body: "ancestor" });
    await sub.request("send", { to: "main", body: "descendant" });
    await peer.request("send", { to: "w1", body: "peer" });
    await human.request("send", { to: "w1", body: "human" });
    const inbox = await worker.request<{ messages: { body: { text: string }; relation?: string; parent_key?: string }[] }>("inbox");
    expect(inbox.messages.map((m) => [m.body.text, m.relation ?? null, m.parent_key ?? null])).toEqual([
      ["parent", "parent", grant.steer.key],
      ["peer", null, null],
      ["human", null, null],
    ]);
    expect(await sub.request("inbox")).toMatchObject({ messages: [{ relation: "ancestor" }] });
    expect(await main.request("inbox")).toMatchObject({ messages: [{ relation: "child" }] });
    expect(JSON.stringify(await human.request("log", { limit: 100 }))).not.toContain(grant.steer.key);
    expect(await main.request("grant", { name: "env" })).not.toHaveProperty("steer");
  });

  test("push pacing skips the same live worker but not another worker or a finished worker", async () => {
    const { broker, main, hook, worker, grant } = await setup(start);
    const otherGrant = await main.request<{ token: string }>("grant", { name: "w2", spawn: true });
    const other = await broker.agent("w2", "codex", {}, { grant: otherGrant.token });
    await worker.request("send", { to: "main", body: "first" });
    const first = await hook.request<Offer>("stop_wait", { wait_s: 0 });
    await hook.request("injected", { seqs: first.offered, hold: first.hold, read: first.offered, push: true });
    await worker.request("send", { to: "main", body: "chatty" });
    expect(await hook.request("stop_wait", { wait_s: 0 })).toMatchObject({ messages: [] });
    await other.request("send", { to: "main", body: "other" });
    expect(await hook.request("stop_wait", { wait_s: 0 })).toMatchObject({ messages: [{ body: { text: "other" } }] });
    await main.request("spawn_exit", { grant: grant.token, code: 0 });
    const finished = await hook.request<Offer>("stop_wait", { wait_s: 0 });
    expect(finished.messages.map((m) => m.body.text)).toContain("chatty");
  });

  for (const interrupt of ["exit", "wake", "prompt"] as const) {
    test(`gathering returns promptly when interrupted by ${interrupt}`, async () => {
      const { broker, main, hook, worker } = await setup(start);
      const other = await main.request<{ token: string }>("grant", { name: "w2", spawn: true });
      await broker.agent("w2", "codex", {}, { grant: other.token });
      const mark = (await hook.request<Offer>("inject", { stop: true })).prompts;
      const waiting = hook.request<Offer>("stop_wait", { wait_s: 3, prompts: mark });
      await worker.request("send", { to: "main", body: "one" });
      await waitFor(
        async () => Object.values((await main.request<{ unread: Record<string, number> }>("snapshot")).unread).some((n) => n > 0),
        "worker mail available",
        5000,
      );
      if (interrupt === "exit") await main.request("spawn_exit", { grant: other.token, code: 0, output: "two" });
      if (interrupt === "wake") await main.request("wake", { via: "channels" });
      if (interrupt === "prompt") await hook.request("prompted");
      const began = Date.now();
      const result = await waiting;
      expect(result.messages[0]!.body.text).toBe("one");
      expect(Date.now() - began).toBeLessThan(5000);
      if (interrupt === "wake") expect(result).toMatchObject({ wakeable: true });
      if (interrupt === "prompt") expect(result).toMatchObject({ prompted: true });
    });
  }

  test("twenty printed pushes exhaust the prompt budget and a prompt restores it", async () => {
    const { broker, main, hook, worker } = await setup(start);
    const workers = [worker];
    for (let i = 2; i <= 20; i++) {
      const grant = await main.request<{ token: string }>("grant", { name: `w${i}`, spawn: true });
      workers.push(await broker.agent(`w${i}`, "codex", {}, { grant: grant.token }));
    }
    for (const [i, sender] of workers.entries()) {
      await sender.request("send", { to: "main", body: `step ${i}` });
      const offer = await hook.request<Offer>("stop_wait", { wait_s: 0 });
      expect(offer).toMatchObject({ pushes_left: 20 - i, messages: [{ body: { text: `step ${i}` } }] });
      expect(await hook.request("injected", { seqs: offer.offered, hold: offer.hold, read: offer.offered, push: true })).toMatchObject({ pushed: true });
    }
    const lastGrant = await main.request<{ token: string }>("grant", { name: "last", spawn: true });
    const last = await broker.agent("last", "codex", {}, { grant: lastGrant.token });
    await last.request("send", { to: "main", body: "one too many" });
    expect(await hook.request("stop_wait", { wait_s: 0 })).toMatchObject({ pushes_left: 0, messages: [] });
    await hook.request("prompted");
    expect(await hook.request("stop_wait", { wait_s: 0 })).toMatchObject({ pushes_left: 20, messages: [{ body: { text: "one too many" } }] });
  });
});
