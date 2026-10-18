import type { HubGraph } from "@scp-dev/hub";
import { Html, html } from "./html";
import { harnessIcon, ICON_PATHS, shown } from "./overview";

/** icon keys with a `--h-<key>` colour token; others draw in the ink colour */
const COLORED = ["claude", "codex", "opencode", "gemini", "grok", "muse", "pi"];

const HUMAN_ICON =
  '<circle cx="8" cy="5.25" r="2.75" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.75 14c.5-3 2.6-4.75 5.25-4.75S12.75 11 13.25 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';

/** `org/machine/handle` as its machine and handle; the org's own human (`org/`) has neither */
export function placeOf(address: string): { machine: string; handle: string } {
  const parts = address.split("/");
  return parts.length >= 3 ? { machine: parts[1]!, handle: parts.slice(2).join("/") } : { machine: "", handle: "" };
}

/** the graph as the page script draws it, in a JSON block inside the live region so each refresh carries it */
export function graphData(g: HubGraph | null): Html {
  if (!g) return html``;
  const nodes = g.nodes.map((n) => {
    const { machine, handle } = placeOf(n.address);
    return {
      address: n.address,
      kind: n.kind,
      machine,
      label: n.kind === "human" ? "human" : shown(handle),
      icon: n.kind === "human" ? "human" : harnessIcon(n.harness),
      harness: n.harness,
      title: n.title,
      presence: n.presence,
      status: n.status,
      wake: n.wake && n.wake !== "none" ? n.wake : null,
      parent: n.parent,
    };
  });
  const machines = g.machines.filter((m) => m.kind !== "revoked").map((m) => ({ name: m.name, online: m.online }));
  const json = JSON.stringify({ minutes: g.minutes, machines, nodes, edges: g.edges }).replace(/</g, "\\u003c");
  return html`<script type="application/json" data-graph-data>${new Html(json)}</script>`;
}

/** the view toggle and the graph canvas; outside the live region so node positions survive a refresh. Hidden until the script runs */
export function graphShell(): Html {
  return html`<div class="view-bar" data-view-bar hidden>
      <div class="seg" role="group" aria-label="View"><button type="button" data-view-set="graph" aria-pressed="true">Graph</button><button type="button" data-view-set="table" aria-pressed="false">Table</button></div>
      <label class="mini graph-only"><input type="checkbox" data-graph-offline> show offline</label>
    </div>
    <section class="graph" data-graph hidden aria-label="Live graph of agents and their links">
      <p class="mini graph-legend"><span class="key spawn" aria-hidden="true"></span>spawned <span class="key msg" aria-hidden="true"></span>messages, last <span data-graph-minutes>15</span> min</p>
      <div class="graph-canvas"><svg class="graph-svg" role="group" aria-label="Agents by machine"></svg><div class="graph-tip" role="tooltip" hidden></div></div>
    </section>`;
}

export const GRAPH_CSS = `
.view-bar[hidden]{display:none}
.view-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;margin-top:2rem}
.seg{display:inline-flex;border:1px solid var(--line)}
.seg button{height:2rem;padding-inline:.875rem;border:0;background:transparent;color:var(--ink);font-family:var(--mono);font-size:.6875rem;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.view-bar label{display:inline-flex;align-items:center;gap:.375rem;cursor:pointer}
[data-view=table] .graph,[data-view=table] .graph-only{display:none}
[data-view=graph] [data-live]>.block:has(.machine){display:none}
.graph{margin-top:1.25rem}
.graph-legend{display:flex;flex-wrap:wrap;align-items:center;gap:.375rem}
.graph-legend .key{display:inline-block;width:1.25rem;height:0;margin-left:.5rem;border-top:1.5px solid var(--faint)}
.graph-legend .key:first-child{margin-left:0}
.graph-legend .key.msg{border-top:1.5px dashed var(--acc)}
.graph-canvas{position:relative;margin-top:.75rem;overflow-x:auto;border:1px solid var(--line-soft);background:var(--surface)}
.graph-svg{display:block;font-family:var(--mono)}
.graph-svg .box rect{fill:var(--bg);stroke:var(--line)}
.graph-svg .box.offline rect{stroke-dasharray:3 3}
.graph-svg .box text{font-size:11px;fill:var(--ink)}
.graph-svg .box .empty-note{fill:var(--faint)}
.graph-svg .edge{fill:none;transition:opacity .2s}
.graph-svg .edge.spawn{stroke:var(--faint);stroke-width:1.25}
.graph-svg .edge.msg{stroke:var(--acc);stroke-dasharray:5 4}
.graph-svg .edge.flow{animation:graph-flow .45s linear 8}
@keyframes graph-flow{to{stroke-dashoffset:-9}}
.graph-svg .arrow-spawn{fill:var(--faint)}
.graph-svg .arrow-msg{fill:var(--acc)}
.graph-svg .node{cursor:pointer;outline:none;transition:opacity .2s}
.graph-svg .node .disc{fill:var(--bg);stroke:var(--line);stroke-width:1}
.graph-svg .node.human .disc{stroke:var(--ink);stroke-dasharray:2 2}
.graph-svg .node.offline .disc{stroke-dasharray:2 2}
.graph-svg .node.offline .glyph{opacity:.5}
.graph-svg .node:hover .disc,.graph-svg .node:focus-visible .disc,.graph-svg .node.on .disc{stroke:var(--fg);stroke-width:1.5}
.graph-svg .glyph{color:var(--ink)}
.graph-svg .pdot{stroke:var(--faint);fill:var(--bg)}
.graph-svg .pdot.online{stroke:var(--acc);fill:var(--acc)}
.graph-svg .pdot.idle{stroke:var(--dim);fill:var(--dim)}
.graph-svg .pdot.idle.wake{stroke:var(--acc);fill:var(--acc-soft)}
.graph-svg .nlabel{font-size:10.5px;fill:var(--fg);text-anchor:middle;paint-order:stroke;stroke:var(--bg);stroke-width:3px;stroke-linejoin:round}
.graph-svg.focus .edge:not(.hl),.graph-svg.focus .node:not(.hl){opacity:.15}
.graph-svg.focus .edge.hl.spawn{stroke:var(--ink)}
.graph-tip{position:absolute;z-index:2;max-width:18rem;padding:.5rem .625rem;border:1px solid var(--line);background:var(--bg);font-size:.75rem;line-height:1.4;pointer-events:none;box-shadow:0 4px 16px rgb(0 0 0/.08)}
.graph-tip .t-addr{font-family:var(--mono);font-size:.6875rem;color:var(--fg);overflow-wrap:anywhere}
.graph-tip .t-row{color:var(--ink)}
.graph-tip .t-dim{font-family:var(--mono);font-size:.6875rem;color:var(--dim)}
`;

/** draws the live graph: machines as boxes, a small force layout per machine, positions kept across refreshes */
export const graphScript = (): string => `(() => {
const root = document.querySelector("[data-graph]");
const live = document.querySelector("[data-live]");
const bar = document.querySelector("[data-view-bar]");
if (!root || !live || !bar) return;
const NS = "http://www.w3.org/2000/svg";
const ICONS = ${JSON.stringify({ ...ICON_PATHS, human: HUMAN_ICON })};
const COLORED = new Set(${JSON.stringify(COLORED)});
const R = 17, PADX = 56, PADT = 38, PADB = 40, GAP = 16, MINW = 176;
const svg = root.querySelector("svg");
const canvas = root.querySelector(".graph-canvas");
const tip = root.querySelector(".graph-tip");
const offline = bar.querySelector("[data-graph-offline]");
const pos = new Map();
const shape = new Map();
const seen = new Map();
const flowing = new Map();
let data = null;
let focus = null;
let first = true;
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };

function read() {
  const block = live.querySelector("script[data-graph-data]");
  if (!block) return null;
  try { return JSON.parse(block.textContent); } catch { return null; }
}

function setView(v) {
  document.documentElement.setAttribute("data-view", v);
  for (const b of bar.querySelectorAll("[data-view-set]")) b.setAttribute("aria-pressed", String(b.getAttribute("data-view-set") === v));
  save("scp.overview.view", v);
  if (v === "graph") render();
}

function visible(g) {
  const all = offline.checked;
  const talks = new Set();
  for (const e of g.edges) if (e.kind === "message") { talks.add(e.from); talks.add(e.to); }
  const nodes = g.nodes.filter((n) => all || n.presence !== "offline" || (n.kind === "human" && talks.has(n.address)));
  const shownSet = new Set(nodes.map((n) => n.address));
  const edges = g.edges.filter((e) => shownSet.has(e.from) && shownSet.has(e.to));
  const groups = new Map();
  for (const m of g.machines) groups.set(m.name, { name: m.name, online: m.online, nodes: [] });
  for (const n of nodes) {
    if (!groups.has(n.machine)) groups.set(n.machine, { name: n.machine, online: n.presence === "online", nodes: [] });
    groups.get(n.machine).nodes.push(n);
  }
  const list = [...groups.values()].filter((gr) => gr.nodes.length || gr.online);
  list.sort((a, b) => (a.name === "") - (b.name === "") || a.name.localeCompare(b.name));
  return { nodes, edges, groups: list };
}

function seed(n) {
  const h = hash(n.address);
  const a = (h % 360) * Math.PI / 180;
  const p = n.parent && pos.get(n.parent);
  const r = p ? 70 : 30 + (h % 60);
  return { x: (p ? p.x : 0) + Math.cos(a) * r, y: (p ? p.y : 0) + Math.sin(a) * r };
}

function simulate(group, edges) {
  const ns = group.nodes;
  const sig = ns.map((n) => n.address).sort().join(" ") + "|" + edges.filter((e) => e.kind === "spawn").map((e) => e.from + ">" + e.to).sort().join(" ");
  if (shape.get(group.name) === sig) return;
  shape.set(group.name, sig);
  const fresh = new Set();
  for (const n of ns) if (!pos.has(n.address)) { pos.set(n.address, seed(n)); fresh.add(n.address); }
  const P = ns.map((n) => pos.get(n.address));
  const idx = new Map(ns.map((n, i) => [n.address, i]));
  const links = edges.filter((e) => idx.has(e.from) && idx.has(e.to)).map((e) => [idx.get(e.from), idx.get(e.to), e.kind === "spawn" ? 84 : 112, e.kind === "spawn" ? 0.06 : 0.02]);
  const iters = fresh.size === ns.length ? 320 : 160;
  for (let t = 0; t < iters; t++) {
    const cap = 10 * (1 - t / iters) + 0.3;
    const F = P.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y;
      if (!dx && !dy) { dx = (i - j) * 0.1; dy = 0.1; }
      const d2 = Math.max(dx * dx + dy * dy, 25), d = Math.sqrt(d2), f = 8000 / d2;
      F[i].x += dx / d * f; F[i].y += dy / d * f; F[j].x -= dx / d * f; F[j].y -= dy / d * f;
    }
    for (const [a, b, len, k] of links) {
      const dx = P[b].x - P[a].x, dy = P[b].y - P[a].y, d = Math.max(Math.hypot(dx, dy), 1), f = (d - len) * k;
      F[a].x += dx / d * f; F[a].y += dy / d * f; F[b].x -= dx / d * f; F[b].y -= dy / d * f;
    }
    for (let i = 0; i < P.length; i++) {
      F[i].x -= P[i].x * 0.02; F[i].y -= P[i].y * 0.035;
      const m = fresh.has(ns[i].address) ? 1 : 0.25, s = Math.hypot(F[i].x, F[i].y), c = s > cap ? cap / s : 1;
      P[i].x += F[i].x * c * m; P[i].y += F[i].y * c * m;
    }
  }
}

function pack(groups, width) {
  let x = GAP, y = GAP, row = 0;
  for (const g of groups) {
    const ps = g.nodes.map((n) => pos.get(n.address));
    const minx = ps.length ? Math.min(...ps.map((p) => p.x)) : 0, maxx = ps.length ? Math.max(...ps.map((p) => p.x)) : 0;
    const miny = ps.length ? Math.min(...ps.map((p) => p.y)) : 0, maxy = ps.length ? Math.max(...ps.map((p) => p.y)) : 0;
    const inner = maxx - minx + 2 * PADX;
    g.w = Math.max(inner, MINW, (g.name || "hub").length * 7 + 48);
    g.h = ps.length ? maxy - miny + PADT + PADB + R : 76;
    if (x > GAP && x + g.w + GAP > width) { x = GAP; y += row + GAP; row = 0; }
    g.x = x; g.y = y;
    g.ox = x + (g.w - inner) / 2 + PADX - minx;
    g.oy = y + PADT + R - miny;
    x += g.w + GAP; row = Math.max(row, g.h);
  }
  return y + row + GAP;
}

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  return s < 5 ? "just now" : s < 60 ? s + "s ago" : s < 3600 ? Math.floor(s / 60) + "m ago" : Math.floor(s / 3600) + "h ago";
}

function line(from, to, bend) {
  const dx = to.x - from.x, dy = to.y - from.y, d = Math.max(Math.hypot(dx, dy), 1), ux = dx / d, uy = dy / d;
  const a = { x: from.x + ux * (R + 2), y: from.y + uy * (R + 2) }, b = { x: to.x - ux * (R + 6), y: to.y - uy * (R + 6) };
  if (!bend) return "M" + a.x + " " + a.y + "L" + b.x + " " + b.y;
  const cx = (a.x + b.x) / 2 - uy * bend, cy = (a.y + b.y) / 2 + ux * bend;
  return "M" + a.x + " " + a.y + "Q" + cx + " " + cy + " " + b.x + " " + b.y;
}

function render() {
  if (!data) return;
  const v = visible(data);
  const has = data.nodes.length > 0;
  bar.hidden = !has;
  root.hidden = !has;
  if (!has) { document.documentElement.removeAttribute("data-view"); return; }
  if (!document.documentElement.hasAttribute("data-view")) setView(load("scp.overview.view") === "table" ? "table" : "graph");
  const minutes = root.querySelector("[data-graph-minutes]");
  if (minutes) minutes.textContent = String(data.minutes);
  for (const g of v.groups) simulate(g, v.edges);
  const width = Math.max(280, canvas.clientWidth - 2);
  const height = pack(v.groups, width);
  const full = Math.max(width, ...v.groups.map((g) => g.x + g.w + GAP));
  svg.setAttribute("width", String(full));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", "0 0 " + full + " " + height);
  svg.replaceChildren();
  const defs = el("defs", {}, svg);
  for (const k of ["spawn", "msg"]) el("path", { d: "M0 0L8 4L0 8z", class: "arrow-" + k }, el("marker", { id: "arrow-" + k, viewBox: "0 0 8 8", refX: "1", refY: "4", markerWidth: "7", markerHeight: "7", markerUnits: "userSpaceOnUse", orient: "auto" }, defs));
  const at = new Map();
  for (const g of v.groups) for (const n of g.nodes) { const p = pos.get(n.address); at.set(n.address, { x: g.ox + p.x, y: g.oy + p.y }); }
  const boxes = el("g", {}, svg), lines = el("g", {}, svg), dots = el("g", {}, svg);
  for (const g of v.groups) {
    const box = el("g", { class: "box" + (g.online ? "" : " offline") }, boxes);
    el("rect", { x: g.x + 0.5, y: g.y + 0.5, width: g.w - 1, height: g.h - 1 }, box);
    el("text", { x: g.x + 10, y: g.y + 17 }, box).textContent = (g.name || "hub") + (g.online ? "" : "  offline");
    if (!g.nodes.length) el("text", { x: g.x + 10, y: g.y + 48, class: "empty-note" }, box).textContent = "no agents";
  }
  const now = Date.now();
  const pairs = new Set(v.edges.filter((e) => e.kind === "message").map((e) => e.from + ">" + e.to));
  for (const e of v.edges) {
    const a = at.get(e.from), b = at.get(e.to);
    if (!a || !b) continue;
    const key = e.from + ">" + e.to;
    const msg = e.kind === "message";
    const back = msg && pairs.has(e.to + ">" + e.from);
    const path = el("path", { d: line(a, b, msg ? (back ? 16 : 10) : 0), class: "edge " + (msg ? "msg" : "spawn") + ((flowing.get(key) || 0) > now ? " flow" : ""), "marker-end": "url(#arrow-" + (msg ? "msg" : "spawn") + ")" }, lines);
    path.dataset.from = e.from; path.dataset.to = e.to;
    if (msg) {
      path.setAttribute("stroke-width", String(1 + Math.min(4, Math.log2(e.count))));
      path.setAttribute("opacity", String(0.4 + 0.6 * Math.max(0, 1 - (now - Date.parse(e.last_at)) / (data.minutes * 60000))));
      el("title", {}, path).textContent = e.count + (e.count === 1 ? " message" : " messages") + ", last " + ago(e.last_at);
    } else el("title", {}, path).textContent = "spawned";
  }
  for (const n of v.nodes) {
    const p = at.get(n.address);
    if (!p) continue;
    const g = el("g", { class: "node " + n.presence + (n.kind === "human" ? " human" : ""), transform: "translate(" + p.x + " " + p.y + ")", tabindex: "0", role: "button", "aria-label": n.label + ", " + n.presence }, dots);
    g.dataset.address = n.address;
    if (n.kind === "human") el("rect", { class: "disc", x: -R, y: -R, width: 2 * R, height: 2 * R, rx: 5 }, g);
    else el("circle", { class: "disc", r: R }, g);
    const glyph = el("svg", { class: "glyph", x: -8, y: -8, width: 16, height: 16, viewBox: "0 0 16 16" }, g);
    glyph.innerHTML = ICONS[n.icon] || ICONS.generic;
    if (COLORED.has(n.icon)) glyph.style.color = "var(--h-" + n.icon + ")";
    if (n.kind !== "human") el("circle", { class: "pdot " + n.presence + (n.wake ? " wake" : ""), cx: R - 3, cy: -R + 3, r: 3.5 }, g);
    el("text", { class: "nlabel", y: R + 14 }, g).textContent = n.label.length > 18 ? n.label.slice(0, 17) + "\\u2026" : n.label;
  }
  applyFocus();
}

function applyFocus() {
  if (focus && !svg.querySelector('.node[data-address="' + CSS.escape(focus) + '"]')) focus = null;
  svg.classList.toggle("focus", !!focus);
  const near = new Set(focus ? [focus] : []);
  for (const e of svg.querySelectorAll(".edge")) {
    const hit = !!focus && (e.dataset.from === focus || e.dataset.to === focus);
    e.classList.toggle("hl", hit);
    if (hit) { near.add(e.dataset.from); near.add(e.dataset.to); }
  }
  for (const n of svg.querySelectorAll(".node")) { n.classList.toggle("hl", near.has(n.dataset.address)); n.classList.toggle("on", n.dataset.address === focus); }
}

function showTip(g) {
  const n = data && data.nodes.find((x) => x.address === g.dataset.address);
  if (!n) return;
  const wake = n.wake ? "wakes via " + n.wake : n.kind === "agent" && n.presence === "idle" ? "reads messages at its next turn" : "";
  const rows = [["t-addr", n.address], ["t-row", n.title], ["t-dim", n.presence + (wake ? ", " + wake : "")], ["t-row", n.status ? n.status.state + (n.status.note ? ": " + n.status.note : "") : ""], ["t-dim", n.kind === "agent" ? n.harness : ""]];
  tip.replaceChildren(...rows.filter((r) => r[1]).map(([c, t]) => { const d = document.createElement("div"); d.className = c; d.textContent = t; return d; }));
  tip.hidden = false;
  const box = canvas.getBoundingClientRect(), r = g.getBoundingClientRect();
  const left = r.right - box.left + canvas.scrollLeft + 8;
  tip.style.left = Math.max(4, Math.min(left, canvas.scrollLeft + canvas.clientWidth - tip.offsetWidth - 4)) + "px";
  tip.style.top = Math.max(4, r.top - box.top - 4) + "px";
}

function hideTip() { tip.hidden = true; }

function update() {
  const next = read();
  if (!next) return;
  const now = Date.now();
  for (const e of next.edges) {
    if (e.kind !== "message") continue;
    const key = e.from + ">" + e.to, prev = seen.get(key);
    if (!first && (!prev || e.last_at > prev)) flowing.set(key, now + 3600);
    seen.set(key, e.last_at);
  }
  first = false;
  data = next;
  hideTip();
  render();
}

svg.addEventListener("click", (e) => {
  const g = e.target instanceof Element ? e.target.closest(".node") : null;
  focus = g && g.dataset.address !== focus ? g.dataset.address : null;
  applyFocus();
});
svg.addEventListener("keydown", (e) => {
  const g = e.target instanceof Element ? e.target.closest(".node") : null;
  if (!g || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  focus = g.dataset.address !== focus ? g.dataset.address : null;
  applyFocus();
});
svg.addEventListener("pointerover", (e) => { const g = e.target instanceof Element ? e.target.closest(".node") : null; if (g) showTip(g); });
svg.addEventListener("pointerout", (e) => { const g = e.target instanceof Element ? e.target.closest(".node") : null; if (g && !g.contains(e.relatedTarget)) hideTip(); });
svg.addEventListener("focusin", (e) => { const g = e.target instanceof Element ? e.target.closest(".node") : null; if (g) showTip(g); });
svg.addEventListener("focusout", hideTip);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && focus) { focus = null; applyFocus(); } });
for (const b of bar.querySelectorAll("[data-view-set]")) b.addEventListener("click", () => setView(b.getAttribute("data-view-set")));
offline.checked = load("scp.overview.offline") === "1";
offline.addEventListener("change", () => { save("scp.overview.offline", offline.checked ? "1" : "0"); render(); });
let lastWidth = 0;
new ResizeObserver(() => { const w = canvas.clientWidth; if (w && w !== lastWidth) { lastWidth = w; render(); } }).observe(canvas);
new MutationObserver(update).observe(live, { childList: true });
update();
})();
`;
