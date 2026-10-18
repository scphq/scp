// Renders public/og.png, the 1200x630 share image, with headless Chrome: `bun run og`.
// Set CHROME to the browser binary when it is not at the default path.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { HERO, SITE } from "../app/content";
import { HARNESS, HARNESSES, type Harness } from "../app/harnesses";

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
const ROW = HARNESSES.filter((h) => h !== "gemini");

type Pt = { x: number; y: number };

const crisp = (v: number) => Math.round(v) + 0.5;
const path = (pts: Pt[]) => pts.map((p, i) => `${i ? "L" : "M"}${crisp(p.x)} ${crisp(p.y)}`).join("");
const sq = (p: Pt, s: number, attrs: string) => `<rect x="${Math.round(p.x - s / 2)}" y="${Math.round(p.y - s / 2)}" width="${s}" height="${s}" ${attrs}/>`;
const label = (text: string, x: number, y: number, anchor = "start", color = C.dim) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${color}" class="lbl">${text.toUpperCase()}</text>`;
const elbow = (p: Pt, n: Pt): Pt[] => {
  const mid = Math.round((p.y + n.y) / 2);
  return p.x === n.x ? [p, n] : [p, { x: p.x, y: mid }, { x: n.x, y: mid }, n];
};

const box = { x: 720, y: 160, w: 380, h: 96 };
const hub = { x: 800, y: 216 };
const gate = { x: 1020, y: 216 };
const ROOT = 342;
const LEAF = 446;
const trees = [hub, gate].map((top) => {
  const root = { x: top.x, y: ROOT };
  return { top, root, leaves: [-56, 0, 56].map((dx) => ({ x: top.x + dx, y: LEAF })) };
});
const [a, b] = trees;
const route = [...elbow(a.root, a.leaves[0]).reverse(), hub, gate, ...elbow(b.root, b.leaves[2]).slice(1)];

function graph(): string {
  const wires = trees.flatMap((t) => [path([t.top, t.root]), ...t.leaves.map((l) => path(elbow(t.root, l)))]).join("");
  const agents = trees.flatMap((t) => [sq(t.root, 14, `fill="${C.fg}"`), ...t.leaves.map((l) => sq(l, 9, `fill="${C.ink}"`))]).join("");
  const head = { x: Math.round((hub.x + gate.x) / 2), y: hub.y };
  return `
  <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
      <radialGradient id="halo"><stop offset="0" stop-color="${C.acc}" stop-opacity="0.14"/><stop offset="1" stop-color="${C.acc}" stop-opacity="0"/></radialGradient>
    </defs>
    <circle cx="${head.x}" cy="${head.y}" r="240" fill="url(#halo)"/>
    <rect x="${crisp(box.x)}" y="${crisp(box.y)}" width="${box.w}" height="${box.h}" fill="none" stroke="${C.line}"/>
    ${label("hub", box.x + 16, box.y + 26)}
    <path d="${wires}" fill="none" stroke="${C.line}"/>
    <path d="${path(route)}" fill="none" stroke="${C.acc}" stroke-width="7" opacity="0.3" filter="url(#glow)"/>
    <path d="${path(route)}" fill="none" stroke="${C.acc}" stroke-width="2.5"/>
    ${agents}
    ${sq(hub, 36, `fill="${C.bg}" stroke="${C.fg}" stroke-width="1.5"`)}${sq(hub, 16, `fill="${C.fg}"`)}
    <g transform="translate(${gate.x} ${gate.y}) rotate(45)"><rect x="-12" y="-12" width="24" height="24" fill="${C.bg}" stroke="${C.fg}" stroke-width="1.5"/><rect x="-6" y="-6" width="12" height="12" fill="${C.acc}"/></g>
    ${label("judge", gate.x, box.y + 26, "middle")}
    ${sq(b.leaves[2], 22, `fill="none" stroke="${C.acc}" stroke-width="2"`)}
    ${sq(a.leaves[0], 10, `fill="${C.acc}"`)}
    ${sq(head, 24, `fill="${C.acc}" filter="url(#glow)"`)}${sq(head, 10, `fill="${C.acc}"`)}
  </svg>`;
}

function icon(h: Harness, size: number): string {
  const v = 24 / (HARNESS[h].scale ?? 1);
  const o = 12 - v / 2;
  const parts = HARNESS[h].parts
    .map((p) => `<path d="${p.d}"${p.alpha ? ` fill-opacity="${p.alpha}"` : ""}${p.evenodd ? ` fill-rule="evenodd"` : ""}/>`)
    .join("");
  return `<svg width="${size}" height="${size}" viewBox="${o} ${o} ${v} ${v}" overflow="visible" fill="${C.ink}" style="position:static">${parts}</svg>`;
}

function frame(): string {
  const rails = [56, W - 56];
  const rules = [72, H - 72];
  const lines = [...rails.map((x) => `M${crisp(x)} 0V${H}`), ...rules.map((y) => `M0 ${crisp(y)}H${W}`)].join("");
  const marks = rails.flatMap((x) => rules.map((y) => sq({ x, y }, 7, `fill="${C.fg}"`))).join("");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><path d="${lines}" stroke="${C.line}" fill="none"/>${marks}</svg>`;
}

function html(fonts: { sans: string; mono: string }): string {
  const icons = ROW.map((h) => icon(h, 26)).join("");
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
.foot { position: absolute; left: 88px; right: 88px; bottom: 0; height: 72px; display: flex; align-items: center; justify-content: space-between; }
.icons { display: flex; align-items: center; gap: 30px; }
.url { font: 500 24px GeistMono, monospace; letter-spacing: 0.02em; }
.url i { font-style: normal; color: ${C.acc}; }
</style></head><body>
${frame()}
${graph()}
<div class="brand"><svg width="34" height="34" viewBox="0 0 32 32" fill="${C.fg}" style="position:static"><path d="M3 3h10v4H7v6H3zM29 29H19v-4h6v-6h4z"/><rect x="11" y="11" width="10" height="10"/></svg>SCP</div>
<div class="ver">Swarm Communication Protocol<b>v1</b></div>
<h1 class="title">${HERO.title}</h1>
<div class="foot"><div class="icons">${icons}</div><div class="url">${new URL(SITE).host.replace(".", "<i>.</i>")}</div></div>
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
