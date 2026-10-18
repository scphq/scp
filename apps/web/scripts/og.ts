// Renders public/og.png, the 1200x630 share image, with headless Chrome: `bun run og`.
// Set CHROME to the browser binary when it is not at the default path.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HERO, SITE } from "../app/content";

const W = 1200;
const H = 630;
const C = {
  bg: "#090909",
  surface: "#111111",
  fg: "#f2f2f0",
  ink: "#a6a6a6",
  dim: "#8c8c8c",
  faint: "#575757",
  line: "rgb(255 255 255 / 0.24)",
  acc: "#9d9cff",
};
const HARNESSES = ["Claude Code", "Codex", "OpenCode", "Gemini", "Muse", "Grok"];

type Pt = { x: number; y: number };
type Kind = "hub" | "broker" | "root" | "sub" | "worker";
type Node = Pt & { kind: Kind; parent: number };
type Tree = Tree[] | 0;

const nodes: Node[] = [];
const add = (kind: Kind, x: number, y: number, parent: number) => nodes.push({ kind, x, y, parent }) - 1;

const LEVEL = [352, 420, 486];
const hub = add("hub", 902, 150, -1);

function leaves(t: Tree): number {
  return t === 0 ? 1 : t.reduce<number>((s, c) => s + leaves(c), 0);
}

function place(t: Tree, depth: number, x0: number, step: number, parent: number): number {
  const kind: Kind = depth === 0 ? "root" : t === 0 ? "worker" : "sub";
  const span = leaves(t) * step;
  const i = add(kind, x0 + span / 2, LEVEL[depth], parent);
  if (t !== 0) {
    let x = x0;
    for (const c of t) {
      place(c, depth + 1, x, step, i);
      x += leaves(c) * step;
    }
  }
  return i;
}

const boxes = [
  {
    x: 676,
    y: 236,
    w: 218,
    h: 296,
    label: "machine a",
    fleets: [
      [[0, 0], 0, 0],
      [0, [0, 0]],
    ] as Tree[],
  },
  {
    x: 910,
    y: 236,
    w: 218,
    h: 296,
    label: "machine b",
    fleets: [
      [0, [0, 0, 0]],
      [0, 0],
    ] as Tree[],
  },
];
const roots = boxes.map((b) => {
  const broker = add("broker", b.x + b.w / 2, 292, hub);
  const step = (b.w - 36) / b.fleets.reduce<number>((s, f) => s + leaves(f), 0);
  let x = b.x + 18;
  return {
    broker,
    fleets: b.fleets.map((f) => {
      const r = place(f, 0, x, step, broker);
      x += leaves(f) * step;
      return r;
    }),
  };
});

function elbow(p: Pt, n: Pt): Pt[] {
  if (p.x === n.x) return [p, n];
  const mid = p.y + Math.round((n.y - p.y) * (p.y === nodes[hub].y ? 0.45 : 0.5));
  return [p, { x: p.x, y: mid }, { x: n.x, y: mid }, n];
}

const ancestors = (i: number) => {
  const out = [i];
  while (nodes[out[out.length - 1]].parent >= 0) out.push(nodes[out[out.length - 1]].parent);
  return out;
};

function route(from: number, to: number): Pt[] {
  const up = ancestors(from);
  const down = ancestors(to);
  const lca = up.find((n) => down.includes(n))!;
  const pts: Pt[] = [];
  const push = (seg: Pt[]) => {
    for (const p of seg) {
      const last = pts[pts.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) pts.push(p);
    }
  };
  for (const n of up.slice(0, up.indexOf(lca))) push(elbow(nodes[nodes[n].parent], nodes[n]).reverse());
  for (const n of down.slice(0, down.indexOf(lca)).reverse()) push(elbow(nodes[nodes[n].parent], nodes[n]));
  return pts;
}

const crisp = (v: number) => Math.round(v) + 0.5;
const path = (pts: Pt[]) => pts.map((p, i) => `${i ? "L" : "M"}${crisp(p.x)} ${crisp(p.y)}`).join("");
const sq = (p: Pt, s: number, attrs: string) => `<rect x="${Math.round(p.x - s / 2)}" y="${Math.round(p.y - s / 2)}" width="${s}" height="${s}" ${attrs}/>`;
const label = (text: string, x: number, y: number, anchor = "start", color = C.dim) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${color}" class="lbl">${text.toUpperCase()}</text>`;

const deepest = (machine: number, fleet: number) =>
  nodes.reduce(
    (best, n, i) => (n.kind === "worker" && ancestors(i).includes(roots[machine].fleets[fleet]) && (best < 0 || n.y > nodes[best].y) ? i : best),
    -1,
  );
const workersOf = (fleet: number) => nodes.flatMap((n, i) => (n.kind === "worker" && n.parent === fleet ? [i] : []));

const from = deepest(0, 0);
const to = deepest(1, 0);
const across = route(from, to);
const sibA = workersOf(roots[1].fleets[1]);
const local = route(sibA[0], sibA[1]);
const judge = { x: 1040, y: nodes[hub].y };
const peer = { x: 1114, y: nodes[hub].y };

function pointAt(pts: Pt[], f: number): Pt {
  const segs = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  let d = segs.reduce((a, b) => a + b, 0) * f;
  for (let i = 0; i < segs.length; i++) {
    if (d <= segs[i]) {
      const t = d / segs[i];
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
    }
    d -= segs[i];
  }
  return pts[pts.length - 1];
}

function motes(): string {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const out: string[] = [];
  for (let i = 0; i < 46; i++) {
    const x = 690 + rnd() * 320;
    const y = 92 + rnd() * 118;
    if (Math.hypot(x - nodes[hub].x, y - nodes[hub].y) < 34) continue;
    out.push(sq({ x, y }, rnd() < 0.2 ? 3 : 2, `fill="${rnd() < 0.2 ? C.dim : C.faint}"`));
  }
  return out.join("");
}

function graph(): string {
  const tree = nodes
    .map((n, i) => (n.parent < 0 ? "" : path(elbow(nodes[n.parent], nodes[i]))))
    .filter(Boolean)
    .join("");
  const agents = nodes
    .map((n) => {
      if (n.kind === "root") return sq(n, 14, `fill="${C.fg}"`);
      if (n.kind === "sub") return sq(n, 10, `fill="${C.fg}"`);
      if (n.kind === "worker") return sq(n, 8, `fill="${C.ink}"`);
      return "";
    })
    .join("");
  const brokers = roots
    .map(({ broker }) => {
      const b = nodes[broker];
      return `${sq(b, 22, `fill="${C.bg}" stroke="${C.fg}" stroke-width="1.5"`)}${sq(b, 6, `fill="${C.fg}"`)}${label("broker", b.x + 20, b.y - 10)}`;
    })
    .join("");
  const h = nodes[hub];
  const boxSvg = boxes
    .map((b, m) => {
      const count = nodes.filter((n, i) => n.kind !== "broker" && n.kind !== "hub" && ancestors(i).includes(roots[m].broker)).length;
      return `<rect x="${crisp(b.x)}" y="${crisp(b.y)}" width="${b.w}" height="${b.h}" fill="none" stroke="${C.line}"/>${label(b.label, b.x + 14, b.y + 22)}${label(`${count} agents`, b.x + b.w - 14, b.y + 22, "end", C.faint)}`;
    })
    .join("");
  const head = pointAt(across, 0.62);
  const dest = nodes[to];
  return `
  <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
      <radialGradient id="halo"><stop offset="0" stop-color="${C.acc}" stop-opacity="0.22"/><stop offset="1" stop-color="${C.acc}" stop-opacity="0"/></radialGradient>
    </defs>
    <circle cx="${h.x}" cy="${h.y}" r="210" fill="url(#halo)"/>
    ${motes()}
    ${boxSvg}
    <path d="${tree}" fill="none" stroke="${C.line}" stroke-width="1"/>
    <path d="M${crisp(h.x)} ${crisp(h.y)}H${peer.x}" fill="none" stroke="${C.line}"/>
    <path d="M${crisp(h.x)} ${h.y}V96" fill="none" stroke="${C.line}" stroke-dasharray="2 4"/>
    <path d="M${crisp(h.x + 22)} ${crisp(h.y)}H${judge.x - 8}" fill="none" stroke="${C.dim}" stroke-width="1.5" stroke-dasharray="3 5"/>
    <path d="${path(across)}" fill="none" stroke="${C.acc}" stroke-width="7" opacity="0.35" filter="url(#glow)"/>
    <path d="${path(across)}" fill="none" stroke="${C.acc}" stroke-width="2.5" stroke-linejoin="miter"/>
    <path d="${path(local)}" fill="none" stroke="${C.fg}" stroke-width="2"/>
    ${agents}
    ${brokers}
    ${sq(h, 42, `fill="${C.bg}" stroke="${C.fg}" stroke-width="1.5"`)}${sq(h, 20, `fill="${C.fg}"`)}${label("hub", h.x + 32, h.y - 22)}
    <g transform="translate(${judge.x} ${judge.y}) rotate(45)"><rect x="-9" y="-9" width="18" height="18" fill="${C.bg}" stroke="${C.fg}" stroke-width="1.5"/><rect x="-4.5" y="-4.5" width="9" height="9" fill="${C.acc}"/></g>
    ${label("judge", judge.x, judge.y - 26, "middle")}
    ${sq(peer, 24, `fill="${C.bg}" stroke="${C.fg}" stroke-width="1.5"`)}
    ${label("another account", peer.x + 12, peer.y + 36, "end")}
    ${sq(dest, 22, `fill="none" stroke="${C.acc}" stroke-width="2"`)}
    ${sq(nodes[from], 10, `fill="${C.acc}"`)}
    ${sq(head, 26, `fill="${C.acc}" filter="url(#glow)"`)}${sq(head, 11, `fill="${C.acc}"`)}
    ${sq(pointAt(local, 0.3), 7, `fill="${C.fg}"`)}
  </svg>`;
}

function frame(): string {
  const rails = [56, W - 56];
  const rules = [72, H - 72];
  const lines = [...rails.map((x) => `M${crisp(x)} 0V${H}`), ...rules.map((y) => `M0 ${crisp(y)}H${W}`)].join("");
  const marks = rails.flatMap((x) => rules.map((y) => sq({ x, y }, 7, `fill="${C.fg}"`))).join("");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><path d="${lines}" stroke="${C.line}" fill="none"/>${marks}</svg>`;
}

function html(fonts: { sans: string; mono: string }): string {
  const chips = HARNESSES.map((h) => `<span class="chip">${h}</span>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Geist; src: url("${fonts.sans}") format("woff2"); font-weight: 100 900; }
@font-face { font-family: GeistMono; src: url("${fonts.mono}") format("woff2"); font-weight: 100 900; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${C.bg}; color: ${C.fg}; -webkit-font-smoothing: antialiased; }
body { position: relative; font-family: Geist, sans-serif; }
svg { position: absolute; inset: 0; }
.lbl { font: 500 12px GeistMono, monospace; letter-spacing: 0.14em; }
.brand { position: absolute; left: 88px; top: 0; height: 72px; display: flex; align-items: center; gap: 16px; font-size: 30px; font-weight: 640; letter-spacing: 0.02em; }
.ver { position: absolute; right: 88px; top: 0; height: 72px; display: flex; align-items: center; font: 500 13px GeistMono, monospace; letter-spacing: 0.14em; color: ${C.dim}; text-transform: uppercase; }
.ver b { color: ${C.acc}; font-weight: 500; margin-left: 12px; }
.title { position: absolute; left: 84px; top: 120px; width: 600px; font-size: 82px; line-height: 0.95; font-weight: 600; letter-spacing: -0.05em; text-wrap: balance; }
.deck { position: absolute; left: 88px; top: 384px; width: 520px; font-size: 21px; line-height: 1.45; color: ${C.ink}; letter-spacing: -0.005em; text-wrap: balance; }
.foot { position: absolute; left: 88px; right: 88px; bottom: 0; height: 72px; display: flex; align-items: center; justify-content: space-between; }
.chips { display: flex; gap: 10px; }
.chip { font: 500 13px GeistMono, monospace; letter-spacing: 0.1em; text-transform: uppercase; color: ${C.ink}; border: 1px solid ${C.line}; padding: 7px 11px 6px; }
.url { font: 500 24px GeistMono, monospace; letter-spacing: 0.02em; }
.url i { font-style: normal; color: ${C.acc}; }
</style></head><body>
${frame()}
${graph()}
<div class="brand"><svg width="34" height="34" viewBox="0 0 32 32" fill="${C.fg}" style="position:static"><path d="M3 3h10v4H7v6H3zM29 29H19v-4h6v-6h4z"/><rect x="11" y="11" width="10" height="10"/></svg>SCP</div>
<div class="ver">Swarm Communication Protocol<b>v1</b></div>
<h1 class="title">${HERO.title}</h1>
<p class="deck">${HERO.deck.split(". ")[0]}.</p>
<div class="foot"><div class="chips">${chips}</div><div class="url">${new URL(SITE).host.replace(".", "<i>.</i>")}</div></div>
</body></html>`;
}

const require = createRequire(import.meta.url);
const geist = join(dirname(require.resolve("geist/package.json")), "dist/fonts");
const fonts = {
  sans: pathToFileURL(join(geist, "geist-sans/Geist-Variable.woff2")).href,
  mono: pathToFileURL(join(geist, "geist-mono/GeistMono-Variable.woff2")).href,
};
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) throw new Error(`no Chrome at ${chrome}; set CHROME`);

const dir = mkdtempSync(join(tmpdir(), "scp-og-"));
const page = join(dir, "og.html");
const out = join(import.meta.dirname, "../public/og.png");
writeFileSync(page, html(fonts));
const run = spawnSync(
  chrome,
  [
    "--headless=new",
    `--user-data-dir=${join(dir, "profile")}`,
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${W},${H}`,
    "--virtual-time-budget=3000",
    `--screenshot=${out}`,
    pathToFileURL(page).href,
  ],
  { stdio: "inherit" },
);
if (process.env.OG_KEEP) console.log(page);
else rmSync(dir, { recursive: true, force: true });
if (run.status !== 0) throw new Error(`Chrome exited with ${run.status}`);
console.log(`wrote ${out}`);
