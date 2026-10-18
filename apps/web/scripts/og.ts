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
const C = { bg: "#090909", fg: "#f2f2f0", dim: "#8c8c8c", node: "#3a3a38", edge: "#262624", acc: "#9d9cff" };
const TINT: Partial<Record<Harness, string>> = {
  claude: "#e08b6b",
  codex: "#3fc6a0",
  opencode: "#e6a43f",
  pi: "#ec7bb8",
  agy: "#7aa9ff",
  grok: "#e6e6e6",
  muse: "#3384ff",
};
const ROW = HARNESSES.filter((h) => h !== "gemini");

function mark(h: Harness, size: number): string {
  const m = HARNESS[h];
  const k = ((m.scale ?? 1) * size) / 24;
  const o = (size - 24 * k) / 2;
  const parts = m.parts.map((p) => `<path d="${p.d}"${p.evenodd ? ' fill-rule="evenodd"' : ""}${p.alpha ? ` opacity="${p.alpha}"` : ""}/>`).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><g transform="translate(${o} ${o}) scale(${k})" fill="${TINT[h] ?? C.dim}">${parts}</g></svg>`;
}

type Pt = { x: number; y: number };

function graph(): string {
  const hub: Pt = { x: 940, y: 200 };
  const roots: Pt[] = [
    { x: 820, y: 330 },
    { x: 1060, y: 330 },
  ];
  const kids: Pt[][] = [
    [
      { x: 770, y: 440 },
      { x: 820, y: 440 },
      { x: 870, y: 440 },
    ],
    [
      { x: 1020, y: 440 },
      { x: 1100, y: 440 },
    ],
  ];
  const curve = (a: Pt, b: Pt) => `M${a.x} ${a.y}C${a.x} ${(a.y + b.y) / 2} ${b.x} ${(a.y + b.y) / 2} ${b.x} ${b.y}`;
  const edges = [...roots.map((r) => curve(hub, r)), ...roots.flatMap((r, i) => kids[i].map((k) => curve(r, k)))];
  const route = [curve(kids[0][0], roots[0]), curve(roots[0], hub), curve(hub, roots[1]), curve(roots[1], kids[1][1])];
  const dot = (p: Pt, r: number) => `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${C.bg}" stroke="${C.node}" stroke-width="1.5"/>`;
  return `<svg class="g" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${edges.map((d) => `<path d="${d}" fill="none" stroke="${C.edge}" stroke-width="1.5"/>`).join("")}
    ${route.map((d) => `<path d="${d}" fill="none" stroke="${C.acc}" stroke-opacity=".7" stroke-width="1.5"/>`).join("")}
    <rect x="${hub.x - 11}" y="${hub.y - 11}" width="22" height="22" fill="${C.bg}" stroke="${C.dim}" stroke-width="1.5"/>
    ${roots.map((r) => dot(r, 9)).join("")}
    ${kids
      .flat()
      .map((k) => dot(k, 6))
      .join("")}
    <circle cx="${kids[0][0].x}" cy="${kids[0][0].y}" r="3" fill="${C.acc}"/>
    <circle cx="${kids[1][1].x}" cy="${kids[1][1].y}" r="3" fill="${C.acc}"/>
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
.brand { position: absolute; left: 96px; top: 84px; display: flex; align-items: center; gap: 14px; font-size: 26px; font-weight: 640; letter-spacing: 0.02em; }
.title { position: absolute; left: 92px; top: 176px; width: 620px; font-size: 78px; line-height: 1; font-weight: 600; letter-spacing: -0.045em; text-wrap: balance; }
.marks { position: absolute; left: 96px; top: 438px; display: flex; gap: 26px; align-items: center; }
.url { position: absolute; left: 96px; bottom: 76px; font: 500 20px GeistMono, monospace; color: ${C.dim}; letter-spacing: 0.02em; }
</style></head><body>
${graph()}
<div class="brand"><svg width="28" height="28" viewBox="0 0 32 32" fill="${C.fg}"><path d="M3 3h10v4H7v6H3zM29 29H19v-4h6v-6h4z"/><rect x="11" y="11" width="10" height="10"/></svg>SCP</div>
<h1 class="title">${HERO.title}</h1>
<div class="marks">${ROW.map((h) => mark(h, 30)).join("")}</div>
<div class="url">${new URL(SITE).host}</div>
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
