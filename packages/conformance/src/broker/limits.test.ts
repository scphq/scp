import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brokerSuite } from "./suite";
import { refusal } from "./wire";

brokerSuite("broker limits and hardening", (start) => {
  test("server fields cannot be forged and invalid send values are refused without deliveries", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    const b = await broker.agent("b");
    for (const field of ["from", "id", "seq", "hop", "created_at", "auth", "expires_at", "relation", "link"]) {
      expect(await refusal(a.request("send", { to: "b", body: "x", [field]: "forged" }, { unchecked: true }))).toBe("invalid_params");
    }
    for (const change of [
      { kind: "order" },
      { ttl_s: 0 },
      { ttl_s: 2592001 },
      { ttl_s: 1.5 },
      { require_reply: true },
      { live: "yes" },
      { data_class: "secret" },
      { to: [] },
      { to: Array(17).fill("b") },
    ]) {
      expect(await refusal(a.request("send", { to: "b", body: "x", ...change }, { unchecked: true }))).toBe("invalid_params");
    }
    for (const change of [{ body: "x".repeat(65537) }, { client_id: "x".repeat(129) }, { mime: "x".repeat(65) }]) {
      expect(await refusal(a.request("send", { to: "b", body: "x", ...change }, { unchecked: true }))).toBe("too_large");
    }
    expect(await b.request("inbox")).toMatchObject({ messages: [] });
    expect(await a.request("whoami")).toMatchObject({ address: "me/a" });
  });

  test("credentials are refused in messages and status and redacted in activity without audit leaks", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    await broker.agent("b");
    const secrets = [
      `scp_${"a1B2".repeat(8)}`,
      `sk-ant-${"x".repeat(30)}`,
      `Authorization: Bearer ${"t0k".repeat(8)}`,
      `MY_TOKEN=${"q7".repeat(18)}`,
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ];
    for (const secret of secrets) expect(await refusal(a.request("send", { to: "b", body: secret }))).toBe("secret_refused");
    expect(await refusal(a.request("status", { state: "working", note: secrets[0] }))).toBe("secret_refused");
    const activity = await a.request<{ summary: string; agent: string }>("event", { kind: "tool", summary: secrets[1], agent: secrets[1] });
    expect(activity.summary).toContain("[redacted anthropic key]");
    expect(activity.agent).toBe("[redacted anthropic key]");
    expect(JSON.stringify(activity)).not.toContain(secrets[1]!);
    const human = await broker.human();
    const log = JSON.stringify(await human.request("log", { limit: 100 }));
    for (const secret of secrets) expect(log).not.toContain(secret);
  });

  test("pair burst counts both directions, returns a retry hint and is explained by why and log", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    const b = await broker.agent("b");
    for (let i = 0; i < 20; i++) await (i % 4 ? a : b).request("send", { to: i % 4 ? "b" : "a", body: String(i) });
    const frame = await a.call("send", { to: "b", body: "over" });
    const retryAfter = frame.error?.data?.retry_after;
    expect(frame.error).toMatchObject({ data: { code: "rate_limited", retry_after: expect.any(Number) } });
    expect(retryAfter).toBeGreaterThan(0);
    expect(frame.error?.code).toBe(-32000);
    expect(await refusal(b.request("send", { to: "a", body: "other direction" }))).toBe("rate_limited");
    const human = await broker.human();
    expect(await human.request("why", { from: "a", to: "b" })).toMatchObject({ allowed: false, pair: { burst: { n: 20 }, refused: { code: "rate_limited" } } });
    const log = await human.request<{ rows: { event: string }[] }>("log", { limit: 10 });
    expect(log.rows.some((r) => r.event === "refuse")).toBe(true);
  });

  test("auto-replies are stopped at the twenty-first message and retries bypass the full burst", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    const b = await broker.agent("b");
    const first = await a.request<{ id: string }>("send", { to: "b", body: "go", client_id: "first" });
    let last = first;
    for (let i = 1; i < 20; i++)
      last = await (i % 2 ? b : a).request<{ id: string }>("send", { to: i % 2 ? "a" : "b", body: "re", kind: "reply", reply_to: last.id });
    expect(await refusal(a.request("send", { to: "b", body: "re", kind: "reply", reply_to: last.id }))).toBe("rate_limited");
    expect(await a.request("send", { to: "b", body: "go", client_id: "first" })).toMatchObject({ id: first.id, duplicate: true });
  });

  test("a connection queues requests after thirty-two pending polls", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    const polls = Array.from({ length: 32 }, () => a.request("inbox", { wait_s: 0.5 }));
    const began = Date.now();
    await a.request("whoami");
    expect(Date.now() - began).toBeLessThan(5000);
    expect(Date.now() - began).toBeGreaterThanOrEqual(350);
    await Promise.all(polls);
  });

  test("unreadable and dangling policy paths fail closed and recover when repaired", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    await broker.agent("b");
    mkdirSync(broker.target.policyPath, { recursive: true });
    expect(await refusal(a.request("send", { to: "b", body: "x" }))).toBe("policy_refused");
    expect(await a.request("policy")).toMatchObject({ state: "error" });
    rmSync(broker.target.policyPath, { recursive: true });
    symlinkSync(join(broker.target.home, "missing.json"), broker.target.policyPath);
    expect(await refusal(a.request("send", { to: "b", body: "x" }))).toBe("policy_refused");
    writeFileSync(join(broker.target.home, "missing.json"), JSON.stringify({ rules: [] }));
    await a.request("send", { to: "b", body: "recovered" });
    expect(await a.request("policy")).toMatchObject({ state: "loaded" });
  });

  test("audit pages advance from since without gaps and default to the newest page", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    await broker.agent("b");
    for (let i = 0; i < 6; i++) await a.request("send", { to: "b", body: `AUDIT_PRIVATE_BODY_${i}_END` });
    const human = await broker.human();
    const audit = await human.request<{ rows: { id: number }[] }>("log", { limit: 100 });
    expect(JSON.stringify(audit)).not.toContain("AUDIT_PRIVATE_BODY_");
    if (a.hello.token !== undefined) expect(JSON.stringify(audit)).not.toContain(a.hello.token);
    const all = audit.rows.map((r) => r.id);
    for (let i = 1; i < all.length; i++) expect(all[i]!).toBeGreaterThan(all[i - 1]!);
    const paged: number[] = [];
    for (let since = 0; ; ) {
      const { rows } = await human.request<{ rows: { id: number }[] }>("log", { since, limit: 2 });
      if (!rows.length) break;
      paged.push(...rows.map((r) => r.id));
      since = rows.at(-1)!.id;
    }
    expect(paged).toEqual(all);
    expect((await human.request<{ rows: { id: number }[] }>("log", { limit: 2 })).rows.map((r) => r.id)).toEqual(all.slice(-2));
  });

  test("causal hop crosses new threads and refuses the sixty-fifth hop", async () => {
    const broker = await start();
    let sender = await broker.agent("hop0");
    for (let i = 1; i <= 65; i++) {
      const receiver = await broker.agent(`hop${i}`);
      const sent = await sender.request<{ hop: number }>("send", { to: `hop${i}`, body: "causal" });
      expect(sent.hop).toBe(i - 1);
      await receiver.request("inbox");
      sender = receiver;
    }
    expect(await refusal(sender.request("send", { to: "hop0", body: "over" }))).toBe("loop_guard");
    const human = await broker.human();
    const log = await human.request<{ rows: { event: string }[] }>("log", { limit: 5 });
    expect(log.rows.some((r) => r.event === "refuse" || r.event === "loop_guard")).toBe(true);
  }, 30_000);

  test("shutdown closes attached watchers and long polls cleanly", async () => {
    const broker = await start();
    const watcher = await broker.observer();
    await watcher.request("watch");
    const a = await broker.agent("a");
    const waiting = a.request("inbox", { wait_s: 3 }).catch((error: unknown) => error);
    await broker.target.stop();
    expect(await waiting).toBeInstanceOf(Error);
    expect(a.closed).toBe(true);
    expect(watcher.closed).toBe(true);
  });

  test("an unbound observer sees broker metadata and policy state without acquiring message powers", async () => {
    const broker = await start({ policy: { rules: [] } });
    const observer = await broker.observer();
    expect(observer.hello.endpoint).toBeNull();
    expect(observer.hello.broker).toEqual(expect.any(Object));
    expect((await observer.request("snapshot")).broker).toEqual(expect.any(Object));
    expect(await refusal(observer.request("send", { to: "me/", body: "x" }))).toBe("unauthorized");
    expect(await refusal(observer.request("inbox"))).toBe("unauthorized");
  });
});
