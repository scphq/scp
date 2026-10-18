import { expect, test } from "bun:test";

type Identity = { name: string; initials: string; tone: number };
type Rect = { key: string; x: number; y: number; w: number; h: number; n: number };
type Bands = (
  items: { name: string; key: string; w: number; h: number }[],
  o: { gap: number; groupGap: number; pad: number; badge: number; hub: number; aspect: number },
) => { places: Map<string, { x: number; y: number }>; bands: Rect[]; hub: { x: number; y: number } | null; width: number; height: number };

/** loaded by path so the test typecheck (Bun types) does not pull in the Workers types */
const graphPath = "../src/graph";
const identityPath = "../src/identity";
const { BANDS_JS, DRAWN_JS, SLOT_JS }: { BANDS_JS: string; DRAWN_JS: string; SLOT_JS: string } = await import(graphPath);
const {
  identities,
  identify,
}: { identities(m: { user_id: string; email: string }[]): Map<string, Identity>; identify(g: unknown, who: Map<string, Identity>): { machines: unknown[] } } =
  await import(identityPath);
const bands = new Function(`${BANDS_JS}; return bands;`)() as Bands;
type Extent = { x0: number; x1: number; y0: number; y1: number };
const slot = new Function(`${SLOT_JS}; return slot;`)() as (e: Extent, w: number, h: number, min: number) => Extent;
type Node = { address: string; kind: string; presence: string; wake: string | null };
const drawn = new Function(`${DRAWN_JS}; return drawn;`)() as (n: Node, o: { offline: boolean; nextTurn: boolean }, talks: Set<string>) => boolean;

test("each machine carries its member's identity: the email's local part, initials and a distinct tone, never the member id", () => {
  const who = identities([
    { user_id: "u1", email: "elia@example.com" },
    { user_id: "u2", email: "vitor.santos@example.com" },
    { user_id: "u3", email: "sam@a.example" },
    { user_id: "u4", email: "sam@b.example" },
  ]);
  expect(who.get("u1")).toMatchObject({ name: "elia", initials: "E" });
  expect(who.get("u2")).toMatchObject({ name: "vitor.santos", initials: "VS" });
  expect([who.get("u3")!.name, who.get("u4")!.name]).toEqual(["sam@a.example", "sam@b.example"]);
  expect(new Set([...who.values()].map((i) => i.tone)).size).toBe(4);

  const g = identify(
    {
      minutes: 15,
      machines: [
        { name: "laptop", kind: "bridge", online: true, bridge: true, created_at: null, last_seen: null, actor: "u1" },
        { name: "old", kind: "client", online: false, bridge: false, created_at: null, last_seen: null, actor: "u9" },
      ],
      nodes: [],
      edges: [],
    },
    who,
  );
  expect(g.machines).toMatchObject([
    { name: "laptop", identity: who.get("u1") },
    { name: "old", identity: null },
  ]);
  expect(JSON.stringify(g)).not.toContain("u1");
});

test("the layout puts one identity's machines side by side in its own band, apart from another's", () => {
  const o = { gap: 26, groupGap: 52, pad: 14, badge: 30, hub: 96, aspect: 1.8 };
  const L = bands(
    [
      { name: "desk", key: "elia", w: 200, h: 150 },
      { name: "studio", key: "vitor", w: 180, h: 120 },
      { name: "laptop", key: "elia", w: 240, h: 170 },
    ],
    o,
  );
  expect(L.bands.map((b) => [b.key, b.n])).toEqual([
    ["elia", 2],
    ["vitor", 1],
  ]);
  const desk = L.places.get("desk")!,
    laptop = L.places.get("laptop")!,
    studio = L.places.get("studio")!;
  expect(laptop.y).toBe(desk.y);
  expect(laptop.x).toBe(desk.x + 200 + o.gap);
  const [elia, vitor] = L.bands as [Rect, Rect];
  const inside = (p: { x: number; y: number }, w: number, h: number, b: Rect) => p.x >= b.x && p.y >= b.y && p.x + w <= b.x + b.w && p.y + h <= b.y + b.h;
  expect(inside(desk, 200, 150, elia) && inside(laptop, 240, 170, elia)).toBe(true);
  expect(inside(studio, 180, 120, vitor)).toBe(true);
  const apart = elia.x + elia.w + o.groupGap <= vitor.x || vitor.x + vitor.w + o.groupGap <= elia.x || elia.y + elia.h + o.groupGap <= vitor.y;
  expect(apart).toBe(true);
  expect(L.hub).not.toBeNull();
});

test("machines without an identity take no band, and a lone machine needs no hub", () => {
  const L = bands([{ name: "", key: "", w: 140, h: 90 }], { gap: 26, groupGap: 52, pad: 14, badge: 30, hub: 0, aspect: 2 });
  expect(L.places.get("")).toEqual({ x: 0, y: 0 });
  expect(L.bands[0]).toMatchObject({ key: "", w: 140, h: 90 });
  expect(L.hub).toBeNull();
});

test("machine slots fit their labels, so empty machines with long labels and mixed widths never overlap", () => {
  const o = { gap: 26, groupGap: 44, pad: 0, badge: 0, hub: 96, aspect: 1.6 };
  const empty = { x0: 0, x1: 0, y0: 0, y1: 12 };
  const machines = [
    { name: "nebius-swarm-host", key: "vitor", e: empty, label: 330 },
    { name: "vitors-macbook-pro", key: "vitor", e: empty, label: 360 },
    { name: "laptop", key: "elia", e: { x0: -40, x1: 160, y0: -30, y1: 90 }, label: 120 },
    { name: "x", key: "elia", e: empty, label: 20 },
    { name: "build", key: "", e: { x0: -20, x1: 20, y0: -22, y1: 38 }, label: 280 },
  ];
  const items = machines.map((m) => {
    const e = slot(m.e, m.label, 40, 96);
    return { name: m.name, key: m.key, w: e.x1 - e.x0 + 40, h: e.y1 - e.y0 + 40 };
  });
  const L = bands(items, o);
  const rects = items.map((it) => ({ ...L.places.get(it.name)!, w: it.w, h: it.h }));
  machines.forEach((m, i) => {
    expect(rects[i]!.w).toBeGreaterThanOrEqual(Math.max(m.label, 96, m.e.x1 - m.e.x0) + 40);
  });
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      const apart = a.x + a.w + o.gap <= b.x || b.x + b.w + o.gap <= a.x || a.y + a.h + o.gap <= b.y || b.y + b.h + o.gap <= a.y;
      expect(apart).toBe(true);
    }
  expect(L.places.get("vitors-macbook-pro")!.x).toBe(L.places.get("nebius-swarm-host")!.x + items[0]!.w + o.gap);
});

test("the graph shows online and wakeable idle by default, next-turn idle and offline only when asked", () => {
  const n = (address: string, presence: string, wake: string | null = null, kind = "agent"): Node => ({ address, kind, presence, wake });
  const nodes = [
    n("on", "online"),
    n("wakes", "idle", "tmux"),
    n("next", "idle"),
    n("off", "offline"),
    n("me", "offline", null, "human"),
    n("you", "idle", null, "human"),
  ];
  const pick = (o: { offline: boolean; nextTurn: boolean }) => nodes.filter((x) => drawn(x, o, new Set(["me"]))).map((x) => x.address);
  expect(pick({ offline: false, nextTurn: false })).toEqual(["on", "wakes", "me", "you"]);
  expect(pick({ offline: false, nextTurn: true })).toEqual(["on", "wakes", "next", "me", "you"]);
  expect(pick({ offline: true, nextTurn: false })).toEqual(["on", "wakes", "off", "me", "you"]);
});
