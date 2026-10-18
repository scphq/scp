import type { EndpointView, Presence } from "@scp-dev/core";
import { expect, test } from "bun:test";

interface OverviewModule {
  orderRows(endpoints: EndpointView[]): { e: EndpointView; depth: number }[];
  liveRegion(o: { machines: unknown[]; endpoints: EndpointView[]; activity: unknown[] }, handle: string, now: number): { value: string };
}
/** loaded by path so the test typecheck (Bun types) does not pull in the Workers types */
const path = "../src/overview";
const { orderRows, liveRegion }: OverviewModule = await import(path);

const ep = (handle: string, presence: Presence, parent?: string, labels: Record<string, string> = {}): EndpointView => ({
  id: `ep_${handle}`,
  address: `acme/box/${handle}`,
  kind: "agent",
  harness: "claude-code",
  model: null,
  cwd: null,
  labels: { machine: "box", ...labels },
  title: null,
  presence,
  status: null,
  last_seen: null,
  parent: parent ? `acme/box/${parent}` : null,
});

const splitHandle = (address: string): string => address.split("/").pop()!;

test("rows go online, idle, offline, then by handle, with each subagent under its listed parent", () => {
  const rows = orderRows([
    ep("zed", "online"),
    ep("old", "offline"),
    ep("amy", "idle"),
    ep("kid", "idle", "zed"),
    ep("bob", "online"),
    ep("orphan", "online", "gone"),
  ]);
  expect(rows.map((r) => [splitHandle(r.e.address), r.depth])).toEqual([
    ["bob", 0],
    ["orphan", 0],
    ["zed", 0],
    ["kid", 1],
    ["amy", 0],
    ["old", 0],
  ]);
});

test("the agents table keeps offline agents behind a toggle, drops the machine label and shows a retired parent as ended", () => {
  const page = liveRegion(
    {
      machines: [],
      endpoints: [ep("lead", "online", undefined, { role: "impl" }), ep("old", "offline", "_gone_ep_1"), ep("prev", "offline")],
      activity: [],
    },
    "acme",
    Date.now(),
  ).value;
  expect(page).toContain('<span class="tag">role=impl</span>');
  expect(page).not.toContain("machine=");
  expect(page).not.toContain("_gone_");
  expect(page).toContain("sub of (ended)");
  expect(page).toMatch(
    /<details class="offline" data-key="box"><summary class="mini"><span class="when-shut">show<\/span><span class="when-open">hide<\/span> 2 offline<\/summary>[\s\S]*old[\s\S]*prev/,
  );
  expect(page.indexOf("lead")).toBeLessThan(page.indexOf("<details"));
});

test("an idle agent a message can wake shows apart from one that reads at its next turn, with its harness as an icon", () => {
  const woken = { ...ep("woken", "idle"), harness: "codex", wake: "codex-app-server" } as EndpointView;
  const page = liveRegion(
    { machines: [], endpoints: [woken, ep("later", "idle"), { ...ep("none", "idle"), wake: "none" } as EndpointView], activity: [] },
    "acme",
    Date.now(),
  ).value;
  expect(page).toContain('title="idle, a message wakes it via codex-app-server"><span class="dot idle wake"');
  expect(page.match(/class="dot idle wake"/g)).toHaveLength(1);
  expect(page.match(/reads messages at its next turn/g)).toHaveLength(2);
  expect(page).toContain('aria-label="codex"');
  expect(page).toContain('aria-label="claude-code"');
});
