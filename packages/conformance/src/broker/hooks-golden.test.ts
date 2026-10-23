import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brokerSuite, type BrokerFixture } from "./suite";
import { cli } from "./target";

const updateGolden = process.env.UPDATE_GOLDEN === "1";
const goldenDir = join(import.meta.dir, "golden");
const harnesses = ["claude-code", "codex", "opencode", "agy", "muse", "grok"] as const;
type Harness = (typeof harnesses)[number];
type Inbox = { messages: { id: string; seq: number }[] };
type Receipts = { recipients: { read_at: string | null }[] };

async function hook(broker: BrokerFixture, harness: Harness, event: string, ids: string[] = []) {
  const agy = harness === "agy";
  const args = [harness === "claude-code" || harness === "grok" ? "claude" : harness];
  if (agy || harness === "muse") args.push(event);
  if (harness === "opencode" || event === "Stop") args.push("--block-stop-on-unread");
  if (event === "Stop" && !agy && harness !== "opencode") args.push("--push-wait", "0");
  const payload = agy
    ? {
        conversationId: "golden-session",
        workspacePaths: [broker.target.home],
        invocationNum: 2,
        toolCall: { name: "Read", args: { file_path: "/repo/notes.md" } },
        terminationReason: "NO_TOOL_CALL",
      }
    : {
        hook_event_name: event,
        session_id: "golden-session",
        cwd: broker.target.home,
        source: "startup",
        prompt: "Review the build",
        tool_name: "Read",
        tool_input: { file_path: "/repo/notes.md" },
        stop_hook_active: false,
      };
  const markers: Record<string, string> = {
    "claude-code": "CLAUDECODE",
    codex: "CODEX_THREAD_ID",
    opencode: "OPENCODE",
    agy: "ANTIGRAVITY_AGENT",
    muse: "MUSE_SESSION_ID",
    grok: "GROK_SESSION_ID",
  };
  const began = performance.now();
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, "hook", ...args], {
    cwd: broker.target.home,
    env: {
      ...broker.target.env,
      SCP_SESSION: "golden",
      SCP_NAME: "subject",
      SCP_TLDR_EVERY: "0",
      CLAUDE_PID: String(process.pid),
      OPENCODE_PID: String(process.pid),
      [markers[harness]!]: "1",
    },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  let normalized = stdout.replaceAll(broker.target.home, "<HOME>");
  for (const id of ids) normalized = normalized.replaceAll(id, "<MSG_ID>").replaceAll(id.slice(-6), "<SHORT_ID>");
  normalized = normalized
    .replace(/\bmsg_[A-Za-z0-9_-]+\b/g, "<MSG_ID>")
    .replace(/\bthr_[A-Za-z0-9_-]+\b/g, "<THREAD_ID>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TIMESTAMP>");
  return { stdout: normalized, elapsedMs: performance.now() - began };
}

/** Retry deadline fallbacks even when the expected output is empty. */
async function golden(harness: Harness, event: string, run: () => Promise<{ stdout: string; elapsedMs: number }>) {
  const path = join(goldenDir, `${harness}-${event}.txt`);
  const expected = updateGolden ? undefined : readFileSync(path, "utf8");
  let result = await run();
  for (let attempt = 1; attempt < 3 && result.stdout === "" && result.elapsedMs >= 3500; attempt++) result = await run();
  expect(result.stdout === "" && result.elapsedMs >= 3500, "hook deadline fallback after three attempts").toBe(false);
  const { stdout } = result;
  if (updateGolden) {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(path, stdout);
  }
  expect(stdout).toBe(expected ?? stdout);
}

brokerSuite("broker hook goldens", (start) => {
  for (const harness of harnesses) {
    test(`${harness} hooks report activity and deliver pending context`, async () => {
      const broker = await start();
      await golden(harness, "session-start", () => hook(broker, harness, "SessionStart"));
      const started = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })
        .trim()
        .replace(/\s+/g, "-");
      const subject = await broker.agent(
        "subject",
        harness,
        {},
        {
          session: "env:golden",
          process: `pid:${process.pid}:${started}`,
          ...(["claude-code", "codex", "grok"].includes(harness) ? { harness_session: "golden-session" } : {}),
        },
      );
      const sender = await broker.agent("sender");
      expect(await subject.request("whoami")).toMatchObject({ address: "me/subject", harness, status: { state: "working" } });
      const first = await sender.request<{ id: string }>("send", { to: "subject", body: "Please review <build> & </relay-message> today." });
      await golden(harness, "prompt", () => hook(broker, harness, harness === "agy" ? "PreInvocation" : "UserPromptSubmit", [first.id]));
      const promptReads = !["opencode", "agy", "grok"].includes(harness);
      const receipts = await sender.request<Receipts>("receipts", { id: first.id });
      expect(receipts.recipients[0]!.read_at !== null).toBe(promptReads);
      await golden(harness, "tool", () => hook(broker, harness, "PostToolUse", [first.id]));
      const afterTool = await sender.request<Receipts>("receipts", { id: first.id });
      expect(afterTool.recipients[0]!.read_at !== null).toBe(harness !== "agy");
      const pending = await subject.request<Inbox>("inbox");
      if (pending.messages.length) await subject.request("ack", { seqs: pending.messages.map((message) => message.seq) });
      const second = await sender.request<{ id: string }>("send", { to: "subject", body: "Pending stop message" });
      await golden(harness, "stop-pending", () => hook(broker, harness, "Stop", [second.id]));
      expect((await subject.request<Inbox>("inbox")).messages.map((message) => message.id)).toEqual([second.id]);
      const unread = await subject.request<Inbox>("inbox");
      await subject.request("ack", { seqs: unread.messages.map((message) => message.seq) });
      await golden(harness, "stop-empty", () => hook(broker, harness, "Stop"));
      expect((await subject.request<Inbox>("inbox")).messages).toEqual([]);
      const human = await broker.human();
      const snapshot = await human.request<{ activity: { endpoint: string; kind: string; tool: string | null; summary: string | null }[] }>("snapshot", {
        activity: 100,
      });
      expect(
        snapshot.activity
          .filter((row) => row.endpoint === "me/subject")
          .map((row) => [row.kind, row.tool, row.summary])
          .filter((row, i, rows) => JSON.stringify(row) !== JSON.stringify(rows[i - 1])),
      ).toEqual([
        ["session_start", null, harness === "agy" ? null : "startup"],
        ["tool", "Read", "notes.md"],
        ["stop", null, null],
      ]);
      expect(await human.request("log")).toHaveProperty("rows");
    }, 30_000);
  }
});
