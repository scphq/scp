import { expect, test } from "bun:test";
import { waitFor } from "../targets";
import { brokerSuite, type BrokerFixture } from "./suite";
import { refusal, type View } from "./wire";

const key = (pid: number) => `pid:${pid}:Thu-Oct-15-10:00:00-2026`;
const claim = (pid: number, parents: number[] = []) => ({ process: key(pid), session: key(pid), lineage: [pid, ...parents].map(key) });
type Grant = { token: string; env?: Record<string, string>; steer?: { key: string; parent: string } };
type Exit = { joined: boolean; name: string; endpoint: View | null; handback: string | null };
type Message = { id: string; seq: number; thread: string; reply_to: string | null; from: { address: string }; body: { text: string } };
type Steers = { session: string | null; transcript: string | null; joined: boolean; steers: Message[] };
async function setup(broker: BrokerFixture, extra: Record<string, unknown> = {}) {
  const lead = await broker.agent("lead", "claude-code", {}, claim(1));
  const grant = await lead.request<Grant>("grant", { name: "w", scope: "parent", spawn: true, bind_process: key(5), ...extra });
  const worker = await broker.agent("app", "codex", {}, claim(6, [5, 1]));
  return { lead, grant, worker };
}
const inbox = async (wire: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> }) =>
  (await wire.request<{ messages: Message[] }>("inbox")).messages;

brokerSuite("broker spawn", (start) => {
  test("a bound grant gives the worker its name, placement, title, labels and parent scope", async () => {
    const broker = await start();
    const { lead, grant, worker } = await setup(broker, { title: "docs pass", labels: { role: "worker" } });
    expect(grant.token).toMatch(/^krt_[0-9a-f]{64}$/);
    if (grant.env !== undefined) {
      expect(grant.env.SCP_GRANT).toBe(grant.token);
      if (grant.env.SCP_NAME !== undefined) expect(grant.env.SCP_NAME).toBe("w");
    }
    expect(worker.hello.endpoint).toMatchObject({ address: "me/w", parent: lead.address, title: "docs pass", labels: { role: "worker" }, scope: "parent" });
    expect(grant.steer).toMatchObject({ key: expect.stringMatching(/^[0-9a-z]{6}$/), parent: "me/lead" });
    const rows = await lead.request("log", { scope: true });
    expect(JSON.stringify(rows)).not.toContain(grant.token);
  });

  test("bound grants need full process keys and refuse credentials in labels or titles", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    for (const bind_process of ["pid:5", "5", "pid:5:x y"]) expect(await refusal(lead.request("grant", { bind_process }))).toBe("invalid_params");
    expect(await refusal(lead.request("grant", { labels: { note: `scp_${"a1B2".repeat(8)}` } }))).toBe("secret_refused");
    expect(await refusal(lead.request("grant", { title: `ghp_${"A1b2C3d4".repeat(5)}` }))).toBe("secret_refused");
    expect(await refusal(lead.request("grant", { title: "x".repeat(65) }))).toBe("too_large");
  });

  test("missing bound keys, explicit grants and exact claims leave a bound grant unspent", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, claim(1));
    await lead.request("grant", { name: "bound", bind_process: key(5) });
    expect((await broker.agent("plain", "codex", {}, claim(7, [1]))).address).toBe("me/plain");
    const own = await lead.request<Grant>("grant", { name: "own" });
    expect((await broker.agent("own", "codex", {}, { ...claim(8, [5, 1]), grant: own.token })).address).toBe("me/own");
    expect((await broker.agent("exact", "cli", {}, { exact: true, lineage: [9, 5, 1].map(key) })).address).toBe("me/exact");
    expect((await broker.agent("app", "codex", {}, claim(6, [5, 1]))).address).toBe("me/bound");
  });

  test("nearest bound key wins and a key outside the issuer's tree places nothing", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, claim(1));
    await lead.request("grant", { name: "outer", bind_process: key(5) });
    await lead.request("grant", { name: "inner", bind_process: key(20) });
    const inner = await broker.agent("app", "codex", {}, claim(21, [20, 5, 1]));
    expect(inner.address).toBe("me/inner");
    await inner.request("grant", { name: "victim", bind_process: key(40) });
    expect((await broker.agent("fresh", "codex", {}, claim(41, [40]))).hello.endpoint).toMatchObject({ address: "me/fresh", parent: null });
  });

  test("named grants refuse wrong or occupied names without spending the grant", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    const grant = await lead.request<Grant>("grant", { name: "named" });
    expect(await refusal(broker.agent("wrong", "codex", {}, { grant: grant.token }))).toBe("unauthorized");
    const occupied = await broker.agent("named", "codex");
    expect(await refusal(broker.agent("named", "codex", {}, { grant: grant.token }))).toBe("unauthorized");
    expect((await lead.request<{ endpoints: View[] }>("list")).endpoints.map((e) => e.address)).not.toContain("me/named-2");
    await occupied.close();
    await waitFor(
      async () => (await lead.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === occupied.id)?.presence === "offline",
      "occupied endpoint offline",
    );
    await (await broker.human()).request("rename", { endpoint: "named", handle: "occupied" });
    expect((await broker.agent("named", "codex", {}, { grant: grant.token })).address).toBe("me/named");
  });

  test("grants place at or below lineage and detached claims use the grant parent", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, claim(1));
    const lane = await broker.agent("lane", "codex", {}, claim(2, [1]));
    const below = await lead.request<Grant>("grant", { under: "lane", scope: "tree" });
    expect((await broker.agent("w", "codex", {}, { ...claim(3, [1]), grant: below.token })).hello.endpoint).toMatchObject({
      parent: lane.address,
      scope: "tree",
    });
    const above = await lead.request<Grant>("grant");
    expect(await refusal(broker.agent("bad", "codex", {}, { ...claim(4, [2, 1]), grant: above.token }))).toBe("unauthorized");
    const detached = await lane.request<Grant>("grant", { name: "bg" });
    expect((await broker.agent("bg", "codex", {}, { grant: detached.token })).hello.endpoint?.parent).toBe("me/lane");
    expect(await refusal(lane.request("grant", { under: "lead" }))).toBe("not_found");
  });

  test("a grant places the root its hooks registered before its tool surface", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    const session = claim(process.pid);
    const hook = await broker.hook({ handle: "app", ...session });
    expect(hook.hello.endpoint?.parent).toBeNull();
    const { token } = await lead.request<Grant>("grant", { name: "w", scope: "parent", title: "docs pass" });
    const shim = await broker.agent("w", "claude-code", {}, { ...session, grant: token });
    expect(shim.hello.endpoint).toMatchObject({ id: hook.hello.endpoint?.id, address: "me/w", parent: "me/lead", title: "docs pass" });
    expect((await broker.hook({ handle: "app", ...session })).hello.endpoint?.id).toBe(shim.id);
    expect(await refusal(broker.agent("late", "codex", {}, { grant: token }))).toBe("unauthorized");
  });

  test("spawned subagents never consume their root's bound grant", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, claim(1));
    await lead.request("grant", { name: "w", bind_process: key(5) });
    const root = await broker.hook({ handle: "app", ...claim(9, [5, 1]) });
    expect(root.hello.endpoint?.address).toBe("me/w");
    const sub = await broker.hook({ handle: "app", ...claim(9, [5, 1]), subagent: { id: "aceb553c19f223c70" } });
    expect(sub.hello.endpoint).toMatchObject({ address: "me/w-agent-aceb", parent: "me/w", depth: 2 });
  });

  test("spawn_exit marks a disconnected worker done and hands its cleaned output back exactly once", async () => {
    const broker = await start();
    const { lead, grant, worker } = await setup(broker);
    await worker.request("status", { state: "blocked", note: "on it" });
    await worker.close();
    const other = await broker.agent("other");
    expect(await refusal(other.request("spawn_exit", { grant: grant.token, code: 3 }))).toBe("unauthorized");
    const result = await lead.request<Exit>("spawn_exit", { grant: grant.token, code: 3, output: "\u001b[32mshipped\u001b[0m" });
    expect(result).toMatchObject({ joined: true, name: "w", endpoint: { presence: "offline", status: { state: "done", note: "exited 3; on it" } } });
    expect(await inbox(lead)).toMatchObject([{ id: result.handback, from: { address: "me/w" }, body: { text: "worker me/w finished (exit 3)\n\nshipped" } }]);
    expect((await lead.request<Exit>("spawn_exit", { grant: grant.token, code: 3 })).handback).toBeNull();
    expect(await inbox(lead)).toHaveLength(1);
    expect(await refusal(lead.request("spawn_exit", { grant: `krt_${"0".repeat(64)}`, code: 0 }))).toBe("not_found");
    expect(await refusal(lead.request("spawn_exit", { grant: grant.token, code: -1 }, { unchecked: true }))).toBe("invalid_params");
  });

  test("unspent spawn_exit revokes the grant and hands back from the system", async () => {
    const broker = await start();
    const lead = await broker.agent("lead", "codex", {}, claim(1));
    const grant = await lead.request<Grant>("grant", { name: "never", bind_process: key(5), spawn: true });
    const result = await lead.request<Exit>("spawn_exit", { grant: grant.token, code: 5, output: "boom" });
    expect(result).toMatchObject({ joined: false, name: "never", endpoint: null });
    expect(await inbox(lead)).toMatchObject([
      { id: result.handback, from: { address: "me/relay" }, body: { text: "worker never finished (exit 5), not a relay agent\n\nboom" } },
    ]);
    expect((await broker.agent("app", "codex", {}, claim(6, [5, 1]))).address).toBe("me/app");
  });

  test("a harness that never started sends no handback and its grant cannot be redeemed", async () => {
    const broker = await start();
    const lead = await broker.agent("lead");
    const grant = await lead.request<Grant>("grant", { name: "never", spawn: true });
    await lead.request("send", { to: "never", body: "queued" });
    expect(await lead.request("spawn_exit", { grant: grant.token, code: 127, started: false })).toMatchObject({ joined: false, handback: null });
    expect(await inbox(lead)).toEqual([]);
    expect(await refusal(broker.agent("never", "codex", {}, { grant: grant.token }))).toBe("unauthorized");
  });

  test("spawn_steers returns only issuer steers and takes them only once a harness session is known", async () => {
    const broker = await start();
    const { lead, grant, worker } = await setup(broker);
    expect(await lead.request("spawn_steers", { grant: grant.token })).toEqual({ session: null, steers: [], transcript: null, joined: true });
    await (await broker.human()).request("send", { to: "w", body: "fyi" });
    const steer = await lead.request<{ id: string }>("send", { to: "w", body: "and lint" });
    const untaken = await lead.request<Steers>("spawn_steers", { grant: grant.token, take: true });
    expect(untaken).toMatchObject({ session: null, steers: [{ id: steer.id, relation: "parent", body: { text: "and lint" } }] });
    expect((await inbox(worker)).map((m) => m.id)).toContain(steer.id);
    const hook = await broker.hook({ handle: "w", harness: "codex", ...claim(6, [5, 1]) });
    await hook.request("event", { kind: "session_start", session_id: "019a-session" });
    expect(await lead.request("spawn_steers", { grant: grant.token, take: true })).toMatchObject({ session: "019a-session", steers: [{ id: steer.id }] });
    expect((await inbox(worker)).map((m) => m.body.text)).toEqual(["fyi"]);
    expect((await lead.request<Steers>("spawn_steers", { grant: grant.token, take: true })).steers).toEqual([]);
    expect(await refusal((await broker.agent("stranger")).request("spawn_steers", { grant: grant.token }))).toBe("unauthorized");
  });

  test("spawn_steers returns the worker's reported session and transcript", async () => {
    const broker = await start();
    const { lead, grant } = await setup(broker);
    const hook = await broker.hook({ handle: "w", harness: "codex", ...claim(6, [5, 1]) });
    const path = "/home/u/.claude/projects/-w/019a-s.jsonl";
    await hook.request("event", { kind: "session_start", session_id: "019a-s", transcript_path: path });
    expect(await lead.request("spawn_steers", { grant: grant.token })).toMatchObject({ session: "019a-s", transcript: path });
    await hook.request("event", { kind: "tool", session_id: "019a-t" });
    expect(await lead.request("spawn_steers", { grant: grant.token })).toMatchObject({ session: "019a-t", transcript: null });
  });

  test("handbacks distinguish read, unapplied and other senders' steers", async () => {
    const broker = await start();
    const { lead, grant, worker } = await setup(broker);
    const read = await lead.request<{ id: string }>("send", { to: "w", body: "docs" });
    await worker.request("ack", { seqs: (await inbox(worker)).map((m) => m.seq) });
    const late = await lead.request<{ id: string }>("send", { to: "w", body: "also tests" });
    const fyi = await (await broker.human()).request<{ id: string }>("send", { to: "w", body: "fyi" });
    await lead.request("spawn_exit", { grant: grant.token, code: 0, output: "done" });
    const text = (await inbox(lead))[0]!.body.text;
    expect(text).toContain(`your steer ${read.id.slice(-6)} was read at `);
    expect(text).toContain(`steer not applied: "also tests" (${late.id.slice(-6)},`);
    expect(text).not.toContain(fyi.id.slice(-6));
  });

  for (const [name, output, check] of [
    ["long reports", `Summary:\n${"x".repeat(1200)}\n${"y".repeat(2500)}\nDone.`, "whole"],
    ["redacted credentials", `rotated ghp_${"A1b2C3d4".repeat(5)} yesterday`, "secret"],
    ["UTF-8 tails", `${"é".repeat(9000)}end`, "tail"],
    ["long lines followed by short lines", `${"a".repeat(20000)}\ndone`, "long"],
  ]) {
    test(`handback preserves ${name}`, async () => {
      const broker = await start();
      const lead = await broker.agent("lead");
      const { token } = await lead.request<Grant>("grant", { name: "w" });
      await lead.request("spawn_exit", { grant: token, code: 0, output });
      const text = (await inbox(lead))[0]!.body.text.split("\n\n").slice(1).join("\n\n");
      if (check === "whole") expect(text).toBe(output!);
      if (check === "secret") {
        expect(text).toBe("rotated [redacted github token] yesterday");
        expect(text).not.toContain(`ghp_${"A1b2C3d4".repeat(5)}`);
      }
      if (check === "tail" || check === "long") {
        expect(text).toStartWith("[earlier output cut]\n");
        expect(text).toEndWith(check === "tail" ? "éend" : "a\ndone");
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
        expect(Buffer.byteLength(text)).toBeGreaterThan(16376);
        expect(text).not.toContain("\ufffd");
      }
    });
  }

  test("held workers stay resumable and each later run hands back once as a reply", async () => {
    const broker = await start();
    const { lead, grant, worker } = await setup(broker);
    await worker.close();
    const holder = await broker.agent("w", "codex", {}, { ...claim(9, [1]), session: "env:held", exact: true, grant: grant.token });
    expect(holder.id).toBe(worker.id);
    await holder.request("wake", { via: "spawn-resume" });
    const first = await lead.request<Exit>("spawn_exit", { grant: grant.token, code: 0, output: "first" });
    expect(first.endpoint).toMatchObject({ wake: "spawn-resume", status: { state: "done" } });
    expect((await inbox(lead))[0]!.body.text).toEndWith(
      "me/w stays resumable until its spawn's idle time runs out: message it before then to resume its session",
    );
    const steer = await lead.request<{ id: string; thread: string }>("send", { to: "w", body: "more", thread: "thr_work" });
    const second = await lead.request<Exit>("spawn_exit", { grant: grant.token, code: 0, output: "second", run: 2, reply_to: steer.id });
    expect((await inbox(lead)).find((m) => m.id === second.handback)).toMatchObject({ reply_to: steer.id, thread: steer.thread });
    expect((await lead.request<Exit>("spawn_exit", { grant: grant.token, code: 0, run: 2 })).handback).toBeNull();
    const third = await lead.request<Exit>("spawn_exit", { grant: grant.token, code: 3, stderr: "boom", run: 3, reply_to: "msg_unknown" });
    expect((await inbox(lead)).find((m) => m.id === third.handback)).toMatchObject({ reply_to: first.handback });
    expect((await lead.request<Exit>("spawn_exit", { grant: grant.token, code: 0, run: 2 })).handback).toBeNull();
  });

  test("spawn_end closes the holding waker and only the spawner, ancestor or terminal human may end it", async () => {
    const broker = await start();
    const { lead, grant, worker } = await setup(broker);
    await worker.request("wake", { via: "spawn-resume" });
    const stranger = await broker.agent("stranger");
    expect(await refusal(stranger.request("spawn_end", { endpoint: "w" }))).toBe("not_found");
    expect(await refusal(lead.request("spawn_end", { endpoint: "missing" }))).toBe("not_found");
    expect(await lead.request("spawn_end", { endpoint: "w" })).toMatchObject({ held: true, endpoint: { wake: null } });
    await waitFor(() => worker.closed, "holding socket closed");
    expect(await lead.request("rules", { endpoint: "w" })).toMatchObject({ address: "me/w" });
    expect(await lead.request("spawn_exit", { grant: grant.token, code: 0 })).toMatchObject({ joined: true });
  });
});

brokerSuite("broker durable spawn holds", (start) => {
  const held = async (broker: BrokerFixture) => {
    const { lead, grant, worker: run } = await setup(broker);
    await run.close();
    const worker = await broker.agent("w", "codex", {}, { ...claim(9, [1]), session: "env:held", exact: true, grant: grant.token });
    return { lead, grant, worker };
  };
  const ref = JSON.stringify({ harness: "codex", session: "019a-s", cwd: "/w", argv: ["codex", "exec", "resume", "019a-s"], idle_s: 60 });
  test("only grant-bearing holding connections may supply a durable spawn ref", async () => {
    const broker = await start();
    const plain = await broker.agent("plain", "codex");
    expect(await refusal(plain.request("wake", { via: "spawn-resume", ref }))).toBe("unauthorized");
    expect(await refusal(plain.request("hibernate", { wake: "spawn", ref }))).toBe("invalid_params");
    const { lead, worker } = await held(broker);
    expect(await refusal(worker.request("wake", { via: "channels", ref }))).toBe("invalid_params");
    expect(await refusal(worker.request("wake", { via: "spawn-resume", ref: "x".repeat(513) }, { unchecked: true }))).toBe("invalid_params");
    expect(await refusal(worker.request("wake", { via: "spawn-resume", ref: "AKIAABCDEFGHIJKLMNOP" }))).toBe("secret_refused");
    expect(await worker.request("wake", { via: "spawn-resume", ref })).toEqual({ changed: true });
    expect(await refusal(worker.request("hibernate", { wake: "spawn", ref: `${ref} ` }))).toBe("invalid_params");
    await lead.request("spawn_end", { endpoint: "w" });
  });

  test("closing a durable hold hibernates it and terminal human may end it", async () => {
    const broker = await start();
    const { lead, worker } = await held(broker);
    await worker.request("wake", { via: "spawn-resume", ref });
    await worker.close();
    const human = await broker.human();
    await waitFor(
      async () => (await human.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === worker.id)?.presence === "hibernated",
      "durable hold hibernated",
    );
    expect(await human.request("spawn_end", { endpoint: "w" })).toMatchObject({ held: true, endpoint: { wake: null } });
    const rows = await lead.request<{ rows: { event: string }[] }>("log");
    expect(rows.rows.filter((r) => r.event === "hibernate")).not.toHaveLength(0);
  });

  test("broker restart preserves a durable hold as spawn hibernation", async () => {
    const broker = await start();
    const { worker } = await held(broker);
    await worker.request("wake", { via: "spawn-resume", ref });
    await broker.restart();
    const human = await broker.human();
    const rows = await human.request<{ endpoints: View[] }>("list", { all: true });
    expect(rows.endpoints.find((e) => e.id === worker.id)).toMatchObject({ presence: "hibernated", wake: "hook:spawn" });
    await human.request("spawn_end", { endpoint: "w" });
  });

  test("explicit spawn hibernation uses the hold ref and ends without another hibernation", async () => {
    const broker = await start();
    const { lead, worker } = await held(broker);
    await worker.request("wake", { via: "spawn-resume", ref });
    expect(await worker.request("hibernate", { wake: "spawn", ref })).toMatchObject({ endpoint: { presence: "hibernated" } });
    await worker.close();
    await lead.request("spawn_end", { endpoint: "w" });
    const rows = await lead.request<{ rows: { event: string }[] }>("log");
    expect(rows.rows.filter((r) => r.event === "hibernate")).toHaveLength(1);
  });
});

brokerSuite("broker spawn supervision", (start) => {
  test("a bound grant is reclaimed by its own instance and never a sibling", async () => {
    const broker = await start();
    const { lead, worker } = await setup(broker);
    await worker.close();
    await waitFor(
      async () => (await lead.request<{ endpoints: View[] }>("list", { all: true })).endpoints.find((e) => e.id === worker.id)?.presence === "offline",
      "worker offline",
    );
    expect((await broker.agent("app", "codex", {}, claim(6, [5, 1]))).id).toBe(worker.id);
    expect((await broker.agent("app", "codex", {}, claim(11, [5, 1]))).address).toBe("me/app");
  });

  test("an ancestor reports exit but the handback still goes to the grant issuer", async () => {
    const broker = await start();
    const main = await broker.agent("main", "codex", {}, claim(1));
    const lead = await broker.agent("lead", "codex", {}, claim(40, [1]));
    const { token } = await lead.request<Grant>("grant", { name: "w", bind_process: key(45), scope: "parent" });
    await broker.agent("app", "codex", {}, claim(46, [45, 40, 1]));
    const result = await main.request<Exit>("spawn_exit", { grant: token, code: 2 });
    expect(await inbox(lead)).toMatchObject([{ id: result.handback, body: { text: "worker me/w exited without replying (exit 2)" } }]);
    expect(await inbox(main)).toEqual([]);
  });

  test("handback follows the most recent worker thread and distinguishes prior progress from a final output", async () => {
    const broker = await start();
    const { lead, grant, worker } = await setup(broker);
    const progress = await worker.request<{ thread: string }>("send", { to: "lead", body: "progress" });
    const result = await lead.request<Exit>("spawn_exit", { grant: grant.token, code: 0 });
    expect((await inbox(lead)).find((m) => m.id === result.handback)).toMatchObject({
      thread: progress.thread,
      body: { text: "worker me/w exited (exit 0) with no final output" },
    });
  });

  test("unapplied steers appear only as unapplied and other senders are excluded", async () => {
    const broker = await start();
    const { lead, grant } = await setup(broker);
    const hook = await broker.hook({ handle: "w", harness: "codex", ...claim(6, [5, 1]) });
    await hook.request("event", { kind: "session_start", session_id: "s-1" });
    const steer = await lead.request<{ id: string }>("send", { to: "w", body: "rename it" });
    await lead.request("spawn_steers", { grant: grant.token, take: true });
    const other = await (await broker.human()).request<{ id: string }>("send", { to: "w", body: "fyi" });
    await lead.request("spawn_exit", { grant: grant.token, code: 1, output: "x", unapplied: [steer.id, other.id] });
    const text = (await inbox(lead))[0]!.body.text;
    expect(text).toContain(`steer not applied: "rename it" (${steer.id.slice(-6)},`);
    expect(text).not.toContain(`your steer ${steer.id.slice(-6)}`);
    expect(text).not.toContain(other.id.slice(-6));
  });
});
