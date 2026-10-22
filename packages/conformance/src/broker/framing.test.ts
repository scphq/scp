import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { terminate, waitFor } from "../targets";
import { brokerSuite } from "./suite";
import { refusal } from "./wire";

brokerSuite("broker framing and hello", (start) => {
  test("every method before hello is unauthorized, unknown ones included", async () => {
    const broker = await start();
    const wire = await broker.wire();
    expect(await refusal(wire.request("whoami"))).toBe("unauthorized");
    expect(await refusal(wire.request("no_such_method", {}, { unchecked: true }))).toBe("unauthorized");
  });

  test("hello takes scp/1 only, and only once", async () => {
    const broker = await start();
    const wire = await broker.wire();
    expect(await refusal(wire.request("hello", { protocol: "scp/2", observe: true }, { unchecked: true }))).toBe("invalid_params");
    await wire.hello({ observe: true });
    expect(await refusal(wire.hello({ observe: true }))).toBe("invalid_params");
  });

  test("hello advertises every local capability, the clock, limits and the preamble", async () => {
    const broker = await start();
    const { hello } = await broker.agent("a");
    expect([...new Set(hello.capabilities)].sort()).toEqual(["inbox.wait", "ask", "scopes", "groups", "peek", "judge", "holds"].sort());
    expect(Math.abs(Date.parse(hello.server_time) - Date.now())).toBeLessThan(60_000);
    expect(hello.limits).toMatchObject({
      bodyBytes: 65536,
      recipients: 16,
      attachments: 16,
      ttlDefaultS: 604800,
      ttlMaxS: 2592000,
      purgeAfterS: 604800,
      inboxMax: 1000,
      inboxPage: 100,
      waitMaxS: 50,
      hopMax: 64,
      threadMax: 200,
      causalWindowS: 120,
      pairBurst: 20,
      pairBurstWindowS: 10,
      pairPerMinute: 30,
      pairPerHour: 300,
      userPerDay: 2000,
      pingPongAlternations: 100,
      pingPongWindowS: 600,
      pingPongBlockS: 600,
      onlineWithinS: 60,
      hookOnlineS: 300,
      hookIdleS: 1800,
      hookEndedGraceS: 30,
      restartGraceS: 60,
      injectMessages: 5,
      injectBytes: 7168,
      pushBytes: 20480,
      pushes: 20,
      pushGapS: 30,
      pushQuietS: 3,
      pushGraceS: 6,
      stopBlocks: 3,
      directiveHolds: 5,
      injectHoldS: 10,
      deferredShowS: 600,
      deferredSettleMs: 2000,
      listOfflineWithinS: 86400,
      handleBoundS: 2592000,
      idempotencyS: 86400,
      auditKeepS: 2592000,
      noteChars: 280,
      handbackBytes: 16384,
      activityKeep: 5000,
      activitySummaryChars: 200,
      textField: 512,
      lineageMax: 16,
      depthMax: 32,
      fanOutMax: 32,
      fanOutTotal: 64,
      treePerMinute: 120,
      treePerHour: 1200,
      treePauseS: 600,
      groupPerMinute: 60,
      grantTtlS: 604800,
      groupIdleS: 86400,
      policyLoadsKept: 8,
      titleRefreshTurns: 5,
      stderrBytes: 1024,
      wakeDebounceS: 60,
      wakeBackoffMaxS: 900,
      wakeRefChars: 512,
      wakeEtaMaxS: 3600,
    });
    expect(hello.preamble.length).toBeGreaterThan(0);
    expect(hello.endpoint).toMatchObject({ address: "me/a", kind: "agent", harness: "claude-code", presence: "online" });
  });

  test("a bound connection gets method_not_found for an unknown method", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    const frame = await a.call("no_such_method", {}, { unchecked: true });
    expect(frame.error).toMatchObject({ code: -32601, data: { code: "method_not_found" } });
    expect(frame.jsonrpc).toBe("2.0");
  });

  test("bound requests map parameter errors and missing targets to integer codes", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    expect((await a.call("send", { to: "missing", body: 1 }, { unchecked: true })).error).toMatchObject({ code: -32602, data: { code: "invalid_params" } });
    expect((await a.call("send", { to: "missing", body: "hello" })).error).toMatchObject({ code: -32000, data: { code: "not_found" } });
  });

  test("a second broker exits while the first keeps serving the relay directory", async () => {
    const broker = await start();
    const second = Bun.spawn(broker.target.command(), { env: broker.target.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      await waitFor(() => second.exitCode !== null, "second broker exits", 5000);
      const observer = await broker.observer();
      expect(observer.hello.capabilities).toContain("inbox.wait");
      expect(broker.target.running).toBe(true);
    } finally {
      await terminate(second);
    }
  });

  test("relay and socket directories are private and the socket is owner-only", async () => {
    const broker = await start();
    expect(statSync(broker.target.dir).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(broker.target.socket)).mode & 0o777).toBe(0o700);
    expect(statSync(broker.target.socket).mode & 0o777).toBe(0o600);
  });

  test("a broker without a bridge reports disabled and refuses machine wake", async () => {
    const broker = await start();
    const human = await broker.human();
    expect(await human.request("cloud_status")).toEqual({ enabled: false });
    expect(await human.request("bridge_relink")).toEqual({ enabled: false });
    expect((await human.call("machine_wake", { url: null })).error).toMatchObject({ code: -32000, data: { code: "unavailable" } });
  });

  test("malformed lines are answered in order and keep the connection", async () => {
    const broker = await start();
    const wire = await broker.wire();
    wire.raw("not json\n");
    wire.raw("   \n");
    wire.raw("[1,2]\n");
    wire.raw(`${JSON.stringify({ id: { nested: true }, method: "hello", params: {} })}\n`);
    wire.raw(`${JSON.stringify({ id: 7, method: 5 })}\n`);
    wire.raw(`${JSON.stringify({ id: 8, method: "hello", params: [] })}\n`);
    await waitFor(() => wire.frames.length >= 5, "five error frames");
    expect(wire.frames.map((frame) => [frame.error?.code, frame.error?.data?.code ?? null])).toEqual([
      [-32700, null],
      [-32600, "invalid_params"],
      [-32600, "invalid_params"],
      [-32600, "invalid_params"],
      [-32600, "invalid_params"],
    ]);
    expect(wire.frames[0]!.id).toBeNull();
    expect(wire.frames[1]!.id).toBeNull();
    const hello = await wire.hello({ observe: true });
    expect(hello.endpoint).toBeNull();
    expect(wire.closed).toBe(false);
  });

  test("a request without id runs and is never answered; jsonrpc is optional on requests", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    a.notify("status", { state: "blocked", note: "silent" });
    a.raw(`${JSON.stringify({ id: "s1", method: "whoami" })}\n`);
    const answer = await waitFor(() => a.frames.find((frame) => frame.id === "s1"), "string id response");
    expect(answer).toMatchObject({ jsonrpc: "2.0", result: { status: { state: "blocked", note: "silent" } } });
    expect(a.frames.filter((frame) => frame.id === undefined && frame.method === undefined)).toEqual([]);
  });

  test("a line over 256 KiB is too_large and closes the connection after earlier lines are answered", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    a.raw(`${JSON.stringify({ id: "before", method: "whoami" })}\n${"x".repeat(256 * 1024 + 16)}\n`);
    await waitFor(() => a.closed, "connection closed");
    expect(a.frames.find((frame) => frame.id === "before")?.result).toBeDefined();
    expect(a.frames.at(-1)!.error).toMatchObject({ code: -32600, data: { code: "too_large" } });
  });

  test("a line just under 256 KiB is processed", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    const frame = await a.call("whoami", { pad: "n".repeat(250 * 1024) }, { unchecked: true });
    expect(frame.error?.data?.code ?? "ok").not.toBe("too_large");
    expect(a.closed).toBe(false);
  });

  test("responses may come out of order and match by id", async () => {
    const broker = await start();
    const a = await broker.agent("a");
    const b = await broker.agent("b");
    const waiting = b.request<{ messages: unknown[] }>("inbox", { wait_s: 5 });
    const whoami = await b.request<{ address: string }>("whoami");
    expect(whoami.address).toBe("me/b");
    await a.request("send", { to: "b", body: "ping" });
    expect((await waiting).messages).toHaveLength(1);
  });
});
