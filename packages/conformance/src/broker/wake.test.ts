import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "../targets";
import { brokerSuite } from "./suite";
import { refusal } from "./wire";

const key = `pid:${process.pid}:conformance`;
const files = (script = "cat > /dev/null") => ({ "config/scp/wakers.json": JSON.stringify({ vm: { command: ["sh", "-c", script], timeout_s: 2 } }) });

brokerSuite("broker wake and hibernation", (start) => {
  test("session, own hook and attested launcher set wake and sends advertise it", async () => {
    const broker = await start();
    const lane = await broker.agent("lane", "codex", {}, { process: key, session: "s1" });
    const peer = await broker.agent("peer");
    expect(await lane.request("whoami")).toMatchObject({ wake: null });
    expect(await lane.request("wake", { via: "channels" })).toEqual({ changed: true });
    expect(await lane.request("wake", { via: "channels" })).toEqual({ changed: false });
    expect(await refusal(lane.request("wake", { via: "bogus" }, { unchecked: true }))).toBe("invalid_params");
    const hook = await broker.hook({ handle: "lane", harness: "codex", process: key, session: "s1" });
    expect(await hook.request("wake", { via: "none" })).toEqual({ changed: true });
    const launcher = await broker.observer({ self: [key] });
    expect(await launcher.request("wake", { via: "codex-app-server" })).toEqual({ changed: true });
    expect(await peer.request("send", { to: "lane", body: "hi" })).toMatchObject({ deliveries: [{ address: "me/lane", wake: "codex-app-server" }] });
    expect(await peer.request("list")).toMatchObject({
      endpoints: expect.arrayContaining([expect.objectContaining({ address: "me/lane", wake: "codex-app-server" })]),
    });
    const observer = await broker.observer();
    expect(await refusal(observer.request("wake", { via: "channels" }))).toBe("unauthorized");
    const human = await broker.human();
    expect(await refusal(human.request("wake", { via: "channels" }))).toBe("invalid_params");
  });

  test("foreign hooks cannot change wake and leave clears it", async () => {
    const broker = await start();
    const lane = await broker.agent("lane", "codex", {}, { process: key, session: "s1" });
    const foreign = await broker.hook({ handle: "lane", harness: "codex", process: "pid:999992:conformance", session: "s1" });
    expect(await foreign.request("wake", { via: "channels" })).toEqual({ changed: false });
    expect(await lane.request("whoami")).toMatchObject({ wake: null });
    await lane.request("wake", { via: "channels" });
    expect(await lane.request("leave")).toMatchObject({ wake: null });
  });

  test("clearing hibernation without a bridge reports mirrored false", async () => {
    const broker = await start();
    const lane = await broker.agent("lane");
    expect(await lane.request("hibernate", { wake: "none" })).toMatchObject({ mirrored: false });
  });

  test("session end preserves wake while its waker lives and the last waker close clears it", async () => {
    const broker = await start();
    const lane = await broker.agent("lane", "codex", {}, { process: key, session: "ending" });
    const hook = await broker.hook({ handle: "lane", harness: "codex", process: key, session: "ending" });
    await lane.request("wake", { via: "codex-app-server" });
    await hook.request("event", { kind: "session_end" });
    expect(await hook.request("whoami")).toMatchObject({ wake: "codex-app-server" });
    await lane.close();
    await waitFor(async () => (await hook.request<{ wake: string | null }>("whoami")).wake === null, "ended wake cleared", 2000);
  });
});

brokerSuite(
  "broker reference waker binding",
  (start) => {
    test("hibernate persists across hook claims, queues sends and refuses live sends until session start", async () => {
      const broker = await start({ files: files() });
      const lane = await broker.agent("lane", "codex", {}, { process: key, session: "s1" });
      const peer = await broker.agent("peer");
      expect(await lane.request("hibernate", { wake: "vm", ref: "box-42", eta_s: 30 })).toMatchObject({
        endpoint: { presence: "hibernated", wake: "hook:vm" },
      });
      const hook = await broker.hook({ handle: "lane", harness: "codex", process: key, session: "s1" });
      expect(await hook.request("whoami")).toMatchObject({ presence: "hibernated" });
      expect(await peer.request("send", { to: "lane", body: "queued" })).toMatchObject({
        deliveries: [{ queued: true, hibernated: true, offline: false, wake_eta_s: 30 }],
      });
      expect(await refusal(peer.request("send", { to: "lane", body: "now?", live: true }))).toBe("not_live");
      await hook.request("event", { kind: "session_start", summary: "resume" });
      expect(await lane.request("whoami")).toMatchObject({ presence: "online", wake: null });
      expect(await lane.request("inbox")).toMatchObject({ messages: [{ body: { text: "queued" } }] });
      const human = await broker.human();
      const audit = await human.request<{ rows: unknown[] }>("log", { limit: 50 });
      expect(JSON.stringify(audit)).not.toContain("box-42");
      expect(audit.rows).toContainEqual(expect.objectContaining({ event: "wake_done" }));
    });

    test("hibernate validates provider, ref, actor and target", async () => {
      const broker = await start({ files: files() });
      const lane = await broker.agent("lane", "codex", {}, { process: key, session: "s1" });
      const peer = await broker.agent("peer");
      for (const params of [
        { wake: "unknown" },
        { wake: "Bad Name" },
        { wake: "vm", ref: "a\nb" },
        { wake: "vm", ref: "x".repeat(513) },
        { wake: "vm", eta_s: 0 },
      ]) {
        expect(await refusal(lane.request("hibernate", params, { unchecked: true }))).toBe("invalid_params");
      }
      expect(await refusal(lane.request("hibernate", { wake: "vm", ref: "AKIAABCDEFGHIJKLMNOP" }))).toBe("secret_refused");
      expect(await refusal(peer.request("hibernate", { endpoint: "lane", wake: "vm" }))).toBe("scope_refused");
      const hook = await broker.hook({ handle: "lane", harness: "codex", process: key, session: "s1" });
      expect(await refusal(hook.request("hibernate", { wake: "vm" }))).toBe("unauthorized");
      const human = await broker.human(false);
      expect(await human.request("hibernate", { endpoint: "lane", wake: "vm" })).toMatchObject({ endpoint: { presence: "hibernated" } });
      expect(await human.request("hibernate", { endpoint: "lane", wake: "none" })).toMatchObject({ endpoint: { presence: "online", wake: null } });
    });

    test("the human hibernates live local agents together and clears their hibernation", async () => {
      const broker = await start({ files: files() });
      await broker.agent("lane");
      const peer = await broker.agent("peer");
      const gone = await broker.agent("gone");
      await gone.close();
      expect(await refusal(peer.request("hibernate", { all: true, wake: "vm" }))).toBe("scope_refused");
      const human = await broker.human(false);
      const result = await human.request<{ endpoints: { address: string; presence: string }[] }>("hibernate", { all: true, wake: "vm" });
      expect(result.endpoints.map((e) => e.address).sort()).toEqual(["me/lane", "me/peer"]);
      expect(result.endpoints.every((e) => e.presence === "hibernated")).toBe(true);
      expect(await human.request("hibernate", { all: true, wake: "none" })).toMatchObject({
        endpoints: [expect.objectContaining({ presence: "online" }), expect.objectContaining({ presence: "online" })],
      });
    });

    test("a failing waker gets metadata without bodies and is debounced while mail stays queued", async () => {
      const broker = await start({
        files: files(
          'cat >> "$HOME/wake.log"; printf "\\n%s\\n%s\\n%s\\n" "$SCP_WAKE_HANDLE" "$SCP_WAKE_PROVIDER" "$SCP_WAKE_FROM" >> "$HOME/wake.log"; exit 1',
        ),
      });
      const lane = await broker.agent("lane");
      const peer = await broker.agent("peer");
      await lane.request("hibernate", { wake: "vm", ref: "box" });
      await lane.close();
      const first = await peer.request<{ id: string }>("send", { to: "lane", body: "UNIQUE-BODY" });
      const human = await broker.human();
      const view = async () =>
        (await human.request<{ endpoints: Record<string, unknown>[] }>("list", { all: true })).endpoints.find((e) => e.address === "me/lane")!;
      await waitFor(async () => (await view()).wake_failed, "wake failure", 3000);
      expect(await view()).toMatchObject({ presence: "hibernated", wake: "hook:vm", wake_failed: expect.any(String) });
      await peer.request("send", { to: "lane", body: "second" });
      const text = readFileSync(join(broker.target.home, "wake.log"), "utf8");
      expect(text).not.toContain("UNIQUE-BODY");
      const events = text.split("\n").filter((line) => line.startsWith("{"));
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!)).toMatchObject({
        scp: 1,
        event: "wake",
        provider: "vm",
        ref: "box",
        endpoint: "me/lane",
        message: { id: first.id, from: "me/peer" },
      });
      expect(text).toContain("lane\nvm\nme/peer");
      const resumed = await broker.agent("lane");
      expect(await resumed.request("inbox")).toMatchObject({ messages: [{ body: { text: "UNIQUE-BODY" } }, { body: { text: "second" } }] });
    });

    test("exit 77 with a decline reason reports declined rather than wake_failed", async () => {
      const broker = await start({ files: files(`cat > /dev/null; printf '{"declined":"budget"}'; exit 77`) });
      const lane = await broker.agent("lane");
      const peer = await broker.agent("peer");
      await lane.request("hibernate", { wake: "vm", eta_s: 30 });
      await peer.request("send", { to: "lane", body: "one" });
      await waitFor(async () => (await lane.request<Record<string, unknown>>("whoami")).wake_declined, "wake declined", 3000);
      expect(await lane.request("whoami")).toMatchObject({ presence: "hibernated", wake_declined: "budget" });
      expect(await lane.request("whoami")).not.toHaveProperty("wake_failed");
      expect(await peer.request("send", { to: "lane", body: "two" })).toMatchObject({ deliveries: [{ wake: "declined" }] });
    });

    test("waker timeouts record a failure without losing mail", async () => {
      const broker = await start({
        files: { "config/scp/wakers.json": JSON.stringify({ vm: { command: ["sh", "-c", "cat > /dev/null; sleep 4"], timeout_s: 1 } }) },
      });
      const lane = await broker.agent("lane");
      const peer = await broker.agent("peer");
      await lane.request("hibernate", { wake: "vm" });
      await peer.request("send", { to: "lane", body: "kept" });
      await waitFor(async () => (await lane.request<Record<string, unknown>>("whoami")).wake_failed, "waker timeout", 3000);
      expect(await lane.request("whoami")).toMatchObject({ wake_failed: expect.any(String), presence: "hibernated" });
      expect(await lane.request("inbox")).toMatchObject({ messages: [{ body: { text: "kept" } }] });
      expect(existsSync(broker.target.socket)).toBe(true);
    });

    test("a successful waker records metadata and the resumed session reclaims its endpoint and drains mail", async () => {
      const broker = await start({ files: files('cat > "$HOME/wake.json"') });
      const lane = await broker.agent("lane");
      const peer = await broker.agent("peer");
      await lane.request("hibernate", { wake: "vm", ref: "box-1" });
      await lane.close();
      const sent = await peer.request<{ id: string }>("send", { to: "lane", body: "UNIQUE-BODY" });
      const human = await broker.human();
      await waitFor(
        async () => (await human.request<{ rows: { event: string }[] }>("log", { limit: 50 })).rows.some((r) => r.event === "wake"),
        "successful wake",
        3000,
      );
      const payload = readFileSync(join(broker.target.home, "wake.json"), "utf8");
      expect(JSON.parse(payload)).toMatchObject({ endpoint: "me/lane", provider: "vm", ref: "box-1", message: { id: sent.id }, unread: 1 });
      expect(payload).not.toContain("UNIQUE-BODY");
      const resumed = await broker.agent("lane");
      expect(resumed.id).toBe(lane.id);
      expect(await resumed.request("whoami")).toMatchObject({ presence: "online", wake: null });
      const inbox = await resumed.request<{ messages: { seq: number }[] }>("inbox");
      expect(inbox.messages).toHaveLength(1);
      expect(await resumed.request("ack", { seqs: inbox.messages.map((m) => m.seq) })).toEqual({ acked: 1 });
      expect(await resumed.request("inbox")).toMatchObject({ messages: [] });
    });

    test("a revive record makes a hibernation revivable, and its waker's ticket takes the same endpoint back once", async () => {
      const broker = await start({ files: files(`cat > /dev/null; printf %s "$SCP_WAKE_TICKET" >> "$HOME/tickets"`) });
      const lane = await broker.agent("lane", "claude-code", {}, { process: key, session: "before" });
      const peer = await broker.agent("peer");
      await lane.request("title", { text: "revive me" });
      expect((await lane.request<{ endpoint: Record<string, unknown> }>("hibernate", { wake: "vm", ref: "box" })).endpoint).not.toHaveProperty("revivable");
      const record = JSON.stringify({ via: "vm", harness: "claude-code", session: "s-42", cwd: "/work", argv: ["claude", "--resume", "s-42"] });
      expect(await lane.request("hibernate", { wake: "vm", ref: record })).toMatchObject({ endpoint: { presence: "hibernated", revivable: true } });
      await lane.close();
      expect(await peer.request("list")).toMatchObject({
        endpoints: expect.arrayContaining([expect.objectContaining({ address: "me/lane", revivable: true })]),
      });
      const sent = await peer.request<{ id: string }>("send", { to: "lane", body: "back?" });
      const path = join(broker.target.home, "tickets");
      await waitFor(() => existsSync(path) && readFileSync(path, "utf8").length > 0, "revive waker run", 3000);
      const ticket = readFileSync(path, "utf8");
      expect(ticket).toMatch(/^kwt_[0-9a-f]{64}$/);
      const revived = await broker.agent("other", "claude-code", {}, { process: "pid:999993:conformance", session: "after", ticket });
      expect(revived.id).toBe(lane.id);
      expect(await revived.request("whoami")).toMatchObject({ address: "me/lane", title: "revive me", presence: "online", wake: null });
      expect(await revived.request("inbox")).toMatchObject({ messages: [{ id: sent.id }] });
      await revived.close();
      expect(await refusal(broker.agent("later", "claude-code", {}, { process: "pid:999994:conformance", session: "later", ticket }))).toBe("unauthorized");
    });

    test("broker wake tickets bind the waker and each later delivery runs it again without debounce", async () => {
      const script = `import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BrokerWire } from ${JSON.stringify(join(import.meta.dir, "wire.ts"))};
let input = "";
for await (const chunk of process.stdin) input += String(chunk);
const dir = process.env.SCP_DIR!;
const inside = join(dir, "relay.sock");
const socket = Buffer.byteLength(inside) <= 100 ? inside : join("/tmp", "scp-" + process.getuid!() + "-" + createHash("sha256").update(dir).digest("hex").slice(0, 12), "relay.sock");
const wire = await BrokerWire.connect(socket);
await wire.hello({ observe: true, ticket: process.env.SCP_WAKE_TICKET });
const page = await wire.request<{ messages: { id: string; seq: number }[]; hold: string }>("inbox", { offer: true });
const seqs = page.messages.map((m) => m.seq);
await wire.request("injected", { seqs, hold: page.hold, read: seqs });
appendFileSync(join(process.env.HOME!, "woke.log"), JSON.stringify({ event: JSON.parse(input), read: page.messages.map((m) => m.id) }) + "\\n");
await wire.close();
`;
      const broker = await start({
        files: {
          "waker.ts": script,
          "config/scp/wakers.json": JSON.stringify({
            "codex-queue": { command: ["sh", "-c", `exec '${process.execPath}' --no-env-file "$HOME/waker.ts"`], timeout_s: 3 },
          }),
        },
      });
      const hook = await broker.hook({
        handle: "lane",
        harness: "codex",
        process: "pid:999999:conformance",
        session: "broker-wake",
        harness_session: "thread-1",
      });
      await hook.request("event", { kind: "stop", session_id: "thread-1" });
      await hook.request("wake", { via: "codex-queue" });
      await hook.close();
      const peer = await broker.agent("peer");
      const log = join(broker.target.home, "woke.log");
      for (let i = 0; i < 2; i++) {
        const sent = await peer.request<{ id: string }>("send", { to: "lane", body: `UNIQUE-BODY-${i}` });
        await waitFor(() => existsSync(log) && readFileSync(log, "utf8").trim().split("\n").length === i + 1, "broker wake", 4500);
        const record = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[i]!);
        expect(record).toMatchObject({ event: { endpoint: "me/lane", provider: "codex-queue", ref: "thread-1" }, read: [sent.id] });
        expect(await peer.request("receipts", { id: sent.id })).toMatchObject({ recipients: [{ read_at: expect.any(String), shown_at: expect.any(String) }] });
      }
      expect(readFileSync(log, "utf8")).not.toContain("UNIQUE-BODY");
    });

    test("a decline suppresses the same sender but a different sender and new hibernation retry", async () => {
      const broker = await start({ files: files(`cat >> "$HOME/declines.log"; printf '{"declined":"budget"}'; exit 77`) });
      const lane = await broker.agent("lane");
      const peer = await broker.agent("peer");
      const other = await broker.agent("other");
      const path = join(broker.target.home, "declines.log");
      const runs = () => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0);
      await lane.request("hibernate", { wake: "vm" });
      await peer.request("send", { to: "lane", body: "one" });
      await waitFor(async () => (await lane.request<Record<string, unknown>>("whoami")).wake_declined, "first decline", 2000);
      expect(runs()).toBe(1);
      await peer.request("send", { to: "lane", body: "two" });
      expect(runs()).toBe(1);
      await other.request("send", { to: "lane", body: "three" });
      await waitFor(() => runs() === 2, "other sender retries", 2000);
      const human = await broker.human();
      await waitFor(
        async () => {
          const log = await human.request<{ rows: { event: string }[] }>("log", { limit: 50 });
          return log.rows.filter((row) => row.event === "wake").length === 2;
        },
        "second wake recorded",
        2000,
      );
      expect(await lane.request("whoami")).toMatchObject({ wake_declined: "budget" });
      const reset = await lane.request<{ endpoint: Record<string, unknown> }>("hibernate", { wake: "vm" });
      expect(reset.endpoint).not.toHaveProperty("wake_declined");
      await waitFor(() => runs() === 3, "new hibernation retries", 2000);
    });
  },
  { referenceWakers: true },
);
