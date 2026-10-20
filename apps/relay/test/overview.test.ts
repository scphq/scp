import type { EndpointView, Presence } from "@scp-dev/core";
import { expect, test } from "bun:test";

interface OverviewModule {
  orderRows(endpoints: EndpointView[]): { e: EndpointView; depth: number; anc: string[]; kids: number }[];
  liveRegion(o: { machines: unknown[]; endpoints: EndpointView[]; activity: unknown[] }, handle: string, now: number): { value: string };
  fleetTrees(endpoints: EndpointView[]): { root: EndpointView; kids: EndpointView[] }[];
  fleetStrip(o: { machines: unknown[]; endpoints: EndpointView[]; activity: unknown[] }, handle: string): { value: string };
  wakeHow(wake: string): string;
}
/** loaded by path so the test typecheck (Bun types) does not pull in the Workers types */
const path = "../src/overview";
const { orderRows, liveRegion, fleetTrees, fleetStrip, wakeHow }: OverviewModule = await import(path);

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
  expect(rows.find((r) => r.e.address.endsWith("/zed"))?.kids).toBe(1);
  expect(rows.find((r) => r.e.address.endsWith("/kid"))?.anc).toEqual(["acme/box/zed"]);
});

test("a parent row gets a caret over its indented subtree, expanded when live and collapsed when offline", () => {
  const page = liveRegion(
    {
      machines: [],
      endpoints: [ep("lead", "online"), ep("w1", "online", "lead"), ep("w2", "idle", "w1"), ep("past", "offline"), ep("pw", "offline", "past")],
      activity: [],
    },
    "acme",
    Date.now(),
  ).value;
  expect(page).toContain('data-tree="acme/box/lead" aria-expanded="true"');
  expect(page).toContain('data-tree="acme/box/w1" aria-expanded="true"');
  expect(page).toContain('<tr class="sub d2" data-anc="acme/box/lead acme/box/w1">');
  expect(page).toContain('data-tree="acme/box/past" aria-expanded="false"');
  expect(page).toContain('<tr class="sub d1" data-anc="acme/box/past" hidden>');
  expect(page.match(/data-tree=/g)).toHaveLength(3);
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
  expect(page).toContain('<svg class="hicon h-codex" width="12" height="12" viewBox="0 0 24 24" role="img" aria-label="codex">');
  expect(page).toContain('class="hicon h-claude"');
  expect(page).not.toContain('class="harness"');
});

test("a hibernated spawn's wake hook and a held spawn read as words, not wake tokens", () => {
  const asleep = { ...ep("asleep", "hibernated"), wake: "hook:spawn" } as unknown as EndpointView;
  const held = { ...ep("held", "idle"), wake: "spawn-resume" } as unknown as EndpointView;
  const page = liveRegion({ machines: [], endpoints: [asleep, held], activity: [] }, "acme", Date.now()).value;
  expect(page).toContain('title="hibernated, a message runs its spawn wake hook"');
  expect(page).toContain('title="idle, a message resumes it through its spawn"');
  expect(wakeHow("channels")).toBe("a message wakes it via channels");
});

test("the graph data block names each node's machine and label, escapes markup and drops a retired handle", async () => {
  const graphPath = "../src/graph";
  const { graphData }: { graphData(g: unknown): { value: string } } = await import(graphPath);
  const block = graphData({
    minutes: 15,
    machines: [
      { name: "box", kind: "bridge", online: true },
      { name: "old", kind: "revoked", online: false },
    ],
    nodes: [
      { ...ep("lead", "online"), address: "acme/box/lead", title: "</script><b>x</b>" },
      { ...ep("_gone_ep_1", "offline"), parent: null },
      { ...ep("", "online"), kind: "human", address: "acme/box/" },
    ],
    edges: [{ kind: "message", from: "acme/box/", to: "acme/box/lead", count: 3, last_at: "2026-01-01T00:00:00.000Z" }],
  }).value;
  expect(block.match(/<\/script>/g)).toHaveLength(1);
  const g = JSON.parse(/data-graph-data>([\s\S]*)<\/script>/.exec(block)![1]!);
  expect(g.machines).toEqual([{ name: "box", online: true, identity: null }]);
  expect(g.nodes.map((n: { machine: string; label: string; icon: string }) => [n.machine, n.label, n.icon])).toEqual([
    ["box", "lead", "claude"],
    ["box", "(ended)", "claude"],
    ["box", "human", "human"],
  ]);
  expect(g.nodes[0].title).toBe("</script><b>x</b>");
  expect(g.edges[0]).toMatchObject({ kind: "message", count: 3 });
});

test("the fleet groups by orchestrator with only live agents, biggest first, and drops all-offline trees", () => {
  const trees = fleetTrees([
    ep("solo", "idle"),
    ep("lead", "online"),
    ep("a", "offline", "lead"),
    ep("b", "online", "a"),
    ep("big", "idle"),
    ep("c", "idle", "big"),
    ep("d", "idle", "big"),
    ep("e", "offline", "big"),
    ep("gone", "offline"),
    ep("f", "offline", "gone"),
    ep("past", "offline"),
    ep("g", "idle", "past"),
    ep("orphan", "online", "missing"),
  ]);
  expect(trees.map((t) => [splitHandle(t.root.address), t.kids.map((k) => splitHandle(k.address))])).toEqual([
    ["big", ["c", "d"]],
    ["lead", ["b"]],
    ["past", ["g"]],
    ["orphan", []],
    ["solo", []],
  ]);
});

test("the fleet strip shows the root square first, never an offline square, and collapses many solo agents", () => {
  const solos = ["s1", "s2", "s3", "s4"].map((h) => ep(h, "idle"));
  const html = fleetStrip(
    {
      machines: [],
      endpoints: [
        ep("lead", "online"),
        ep("kid", "idle", "lead"),
        ep("dead", "offline", "lead"),
        ...solos,
        ep("old", "offline"),
        ep("was", "offline"),
        ep("w", "idle", "was"),
      ],
      activity: [],
    },
    "acme",
  ).value;
  expect(html.indexOf('title="lead, online"')).toBeLessThan(html.indexOf('title="kid, idle"'));
  expect(html).toContain("4 solo agents");
  expect(html).toContain('title="w, idle"');
  expect(html).not.toContain("offline");
  expect(html).not.toContain("<details");
  expect(html).not.toMatch(/old|dead/);
  expect(html).toContain('<span class="mini">box</span>');
});

test("a session linked under a parent on another machine nests under it with its machine tag", () => {
  const lead = ep("lead", "online");
  const worker = { ...ep("worker", "online"), address: "acme/vm/worker", labels: { machine: "vm" }, parent: "acme/box/lead" };
  const page = liveRegion(
    {
      machines: [
        { name: "box", kind: "device", online: true, last_seen: null },
        { name: "vm", kind: "device", online: true, last_seen: null },
      ],
      endpoints: [lead, worker],
      activity: [],
    },
    "acme",
    Date.now(),
  ).value;
  expect(page).toMatch(
    /<h3 class="mono">box<\/h3>[\s\S]*lead[\s\S]*class="sub d1" data-anc="acme\/box\/lead"[\s\S]*worker<\/span> <span class="tag" title="runs on vm">vm<\/span>[\s\S]*<h3 class="mono">vm<\/h3>/,
  );
  expect(page).toContain("Its agent shows under a parent on another machine.");
});

test("the fleet counts a child on another machine under its orchestrator", () => {
  const worker = { ...ep("worker", "online"), address: "acme/vm/worker", labels: { machine: "vm" }, parent: "acme/box/lead" };
  const trees = fleetTrees([ep("lead", "online"), worker]);
  expect(trees.map((t) => [t.root.address, t.kids.map((k) => k.address)])).toEqual([["acme/box/lead", ["acme/vm/worker"]]]);
});
