// Renders public/og.png, the 1200x630 share image, with headless Chrome: `bun run og`.
// Set CHROME to the browser binary when it is not at the default path.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HERO } from "../app/content";
import { HARNESS, HARNESSES, type Harness } from "../app/harnesses";

const W = 1200;
const H = 630;
const C = { bg: "#090909", fg: "#f2f2f0", mark: "#9a9a96", edge: "#2e2e2c", acc: "#9d9cff" };
const ROW = HARNESSES.filter((h) => h !== "gemini");

function mark(h: Harness, size: number): string {
  const m = HARNESS[h];
  const k = ((m.scale ?? 1) * size) / 24;
  const o = (size - 24 * k) / 2;
  const parts = m.parts.map((p) => `<path d="${p.d}"${p.evenodd ? ' fill-rule="evenodd"' : ""}${p.alpha ? ` opacity="${p.alpha}"` : ""}/>`).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" overflow="visible"><g transform="translate(${o} ${o}) scale(${k})" fill="${C.mark}">${parts}</g></svg>`;
}

type Pt = { x: number; y: number };
type Node = Pt & { kids?: Node[] };

const crisp = (v: number) => Math.round(v) + 0.5;
const elbow = (a: Pt, b: Pt) => {
  const mid = crisp((a.y + b.y) / 2);
  return `M${crisp(a.x)} ${crisp(a.y)}V${mid}H${crisp(b.x)}V${crisp(b.y)}`;
};
const sq = (p: Pt, s: number, attrs: string) => `<rect x="${Math.round(p.x - s / 2)}" y="${Math.round(p.y - s / 2)}" width="${s}" height="${s}" ${attrs}/>`;

function tree(x: number, y: number, fan: number[][]): Node {
  const width = 150;
  return {
    x,
    y,
    kids: fan.map((g, i) => {
      const cx = x + (i - (fan.length - 1) / 2) * width * 0.6;
      return { x: cx, y: y + 104, kids: g.map((_, j) => ({ x: cx + (j - (g.length - 1) / 2) * 26, y: y + 200 })) };
    }),
  };
}

function graph(): string {
  const hub: Pt = { x: 985, y: 155 };
  const roots = [
    tree(890, 285, [
      [0, 0],
      [0, 0, 0],
    ]),
    tree(1080, 285, [
      [0, 0, 0],
      [0, 0],
    ]),
  ];
  const edges: string[] = roots.map((r) => elbow(hub, r));
  const nodes: string[] = [];
  for (const r of roots) {
    nodes.push(sq(r, 18, `fill="${C.bg}" stroke="${C.fg}" stroke-opacity=".55" stroke-width="1.5"`), sq(r, 6, `fill="${C.fg}" fill-opacity=".55"`));
    for (const c of r.kids ?? []) {
      edges.push(elbow(r, c));
      nodes.push(sq(c, 11, `fill="${C.fg}" fill-opacity=".45"`));
      for (const g of c.kids ?? []) {
        edges.push(elbow(c, g));
        nodes.push(sq(g, 7, `fill="${C.fg}" fill-opacity=".3"`));
      }
    }
  }
  const from = roots[0].kids?.[1].kids?.[0] as Pt;
  const via = roots[0].kids?.[1] as Pt;
  const to = roots[1].kids?.[1].kids?.[1] as Pt;
  const toVia = roots[1].kids?.[1] as Pt;
  const route = [elbow(via, from), elbow(roots[0], via), elbow(hub, roots[0]), elbow(hub, roots[1]), elbow(roots[1], toVia), elbow(toVia, to)];
  return `<svg class="g" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <radialGradient id="fade" cx="960" cy="315" r="330" gradientUnits="userSpaceOnUse">
        <stop offset="0.45" stop-color="#fff"/><stop offset="1" stop-color="#000"/>
      </radialGradient>
      <mask id="m"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>
    </defs>
    <g mask="url(#m)">
      ${edges.map((d) => `<path d="${d}" fill="none" stroke="${C.edge}" stroke-width="1.5"/>`).join("")}
      ${route.map((d) => `<path d="${d}" fill="none" stroke="${C.acc}" stroke-width="2"/>`).join("")}
      ${sq(hub, 30, `fill="${C.bg}" stroke="${C.fg}" stroke-width="1.5"`)}${sq(hub, 12, `fill="${C.fg}"`)}
      ${nodes.join("")}
      ${sq(from, 7, `fill="${C.acc}"`)}${sq(to, 13, `fill="none" stroke="${C.acc}" stroke-width="1.5"`)}
    </g>
  </svg>`;
}

function html(fonts: { sans: string; mono: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Geist; src: url("${fonts.sans}") format("woff2"); font-weight: 100 900; }
@font-face { font-family: GeistMono; src: url("${fonts.mono}") format("woff2"); font-weight: 100 900; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${C.bg}; color: ${C.fg}; -webkit-font-smoothing: antialiased; }
body { position: relative; font-family: Geist, sans-serif; }
svg.g { position: absolute; inset: 0; }
.brand { position: absolute; left: 96px; top: 146px; display: flex; align-items: center; gap: 16px; font-size: 36px; font-weight: 640; letter-spacing: 0.02em; }
.title { position: absolute; left: 92px; top: 238px; width: 740px; font-size: 78px; line-height: 1; font-weight: 600; letter-spacing: -0.045em; text-wrap: balance; }
.marks { position: absolute; left: 98px; top: 454px; display: flex; gap: 28px; align-items: center; }
</style></head><body>
${graph()}
<div class="brand"><svg width="38" height="38" viewBox="0 0 32 32" fill="${C.fg}"><path d="M3 3h10v4H7v6H3zM29 29H19v-4h6v-6h4z"/><rect x="11" y="11" width="10" height="10"/></svg>SCP</div>
<h1 class="title">${HERO.title.replace(/^A /, "The ")}</h1>
<div class="marks">${ROW.map((h) => mark(h, 30)).join("")}</div>
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
const out = process.env.OUT ?? join(import.meta.dirname, "../public/og.png");
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
  { stdio: "ignore" },
);
if (process.env.OG_KEEP) console.log(page);
else rmSync(dir, { recursive: true, force: true });
if (run.status !== 0) throw new Error(`Chrome exited with ${run.status}`);
console.log(`wrote ${out}`);
