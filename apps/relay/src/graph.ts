import type { User } from "./env";
import { hubEvents, hubGraph } from "./hub/routes";
import { Html, html, stamp } from "./html";
import type { IdentifiedGraph } from "./identity";
import { orgHeader, requireMember } from "./orgs";
import { APP_JS, harnessIcon, ICON_PATHS, REFRESH_MS, shown } from "./overview";
import { HttpError } from "./util";
import { type Ctx, checkOrigin, page } from "./web";

/** icon keys with a `--h-<key>` colour token; others draw in the ink colour */
const COLORED = ["claude", "codex", "opencode", "gemini", "agy", "grok", "muse", "pi", "t3code"];

const HUMAN_ICON =
  '<g transform="scale(1.5)"><circle cx="8" cy="5.25" r="2.75" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.75 14c.5-3 2.6-4.75 5.25-4.75S12.75 11 13.25 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></g>';

const MARK = '<path d="M3 3h10v4H7v6H3zM29 29H19v-4h6v-6h4z"/><rect x="11" y="11" width="10" height="10"/>';

/** `org/machine/handle` as its machine and handle; the org's own human (`org/`) has neither */
export function placeOf(address: string): { machine: string; handle: string } {
  const parts = address.split("/");
  return parts.length >= 3 ? { machine: parts[1]!, handle: parts.slice(2).join("/") } : { machine: "", handle: "" };
}

/** a child's handle without its parent's handle and the separator after it, so siblings show what tells them apart */
export function shortLabel(handle: string, parent: string): string {
  if (!parent || handle.length <= parent.length + 1 || !handle.startsWith(parent)) return handle;
  return "-_./:".includes(handle[parent.length]!) ? handle.slice(parent.length + 1) : handle;
}

/** the graph as the page script draws it, in a JSON block inside the live region so each refresh carries it */
export function graphData(g: IdentifiedGraph | null): Html {
  if (!g) return html``;
  const nodes = g.nodes.map((n) => {
    const { machine, handle } = placeOf(n.address);
    const name = n.kind === "human" ? "human" : shown(handle);
    const up = n.parent ? placeOf(n.parent) : null;
    return {
      address: n.address,
      kind: n.kind,
      machine,
      name,
      label: name === handle && up && up.machine === machine ? shortLabel(handle, up.handle) : name,
      icon: n.kind === "human" ? "human" : harnessIcon(n.harness),
      harness: n.harness,
      title: n.title,
      presence: n.presence,
      status: n.status,
      wake: n.wake && n.wake !== "none" ? n.wake : null,
      parent: n.parent,
    };
  });
  const machines = g.machines.filter((m) => m.kind !== "revoked").map((m) => ({ name: m.name, online: m.online, identity: m.identity ?? null }));
  const json = JSON.stringify({ minutes: g.minutes, machines, nodes, edges: g.edges }).replace(/</g, "\\u003c");
  return html`<script type="application/json" data-graph-data>${new Html(json)}</script>`;
}

const canvas = html`<div class="graph-canvas"><svg class="graph-svg" role="group" aria-label="Agents by machine"></svg><div class="graph-tip" role="tooltip" hidden></div></div>`;

const trails = html`<span class="trails" role="group" aria-label="Message trail speed">trails <span class="seg">${["1", "0.5", "0.25"].map(
  (v) => html`<button type="button" data-trail="${v}" aria-pressed="${v === "1" ? "true" : "false"}">${v}x</button>`,
)}</span></span>`;

const filters = html`<label class="mini"><input type="checkbox" data-graph-nextturn> show next-turn idle</label><label class="mini"><input type="checkbox" data-graph-offline> show offline</label>`;
const legend = html`<p class="mini graph-legend"><span class="key spawn" aria-hidden="true"></span>spawned <span class="key msg" aria-hidden="true"></span>messages, last <span data-graph-minutes>15</span> min</p>`;

/** the stamped script and stylesheet tags a graph page loads */
export const graphAssets = (): Html =>
  html`<script src="/app.js?v=${stamp(APP_JS)}" defer></script><script src="/graph.js?v=${stamp(graphScript())}" defer></script><link rel="stylesheet" href="/graph.css?v=${stamp(GRAPH_CSS)}">`;

/** the full-window view's body: the canvas under a small overlay, and a hidden live region the refresh swaps */
export function graphFull(org: { handle: string; name: string }, g: IdentifiedGraph | null): Html {
  return html`<div class="graph gfull" data-graph data-full data-events="/orgs/${org.handle}/events" aria-label="Live graph of agents and their links">
      ${canvas}
      <header class="g-over g-left">
        <a class="mini-link" href="/orgs/${org.handle}/graph">Back to the dashboard</a>
        <h1 title="${org.name}">${org.name}</h1>
        <p class="mini" data-graph-counts></p>
        <p class="mini" data-graph-stream></p>
      </header>
      <div class="g-over g-right">
        ${legend}
        ${filters}
        <span class="mini">${trails}</span>
      </div>
      <div hidden data-live="${REFRESH_MS}">${graphData(g)}</div>
      ${g ? "" : html`<p class="g-empty mini">The hub did not answer. This page retries on its own.</p>`}
    </div>`;
}

/** `/orgs/<handle>/graph/full`: the graph alone, filling the window, for a big screen */
export async function graphPage(ctx: Ctx, user: User, handle: string): Promise<Response> {
  const m = await requireMember(ctx.env.DB, handle, user.id);
  return page(ctx, { title: `${m.org.name} graph`, bare: true, head: graphAssets() }, graphFull(m.org, await hubGraph(ctx.env, m.org.id)));
}

/** `/orgs/<handle>/graph`: the graph tab, the same canvas filling the rest of the window under the tab bar */
export async function graphTabPage(ctx: Ctx, user: User, handle: string): Promise<Response> {
  const m = await requireMember(ctx.env.DB, handle, user.id);
  const g = await hubGraph(ctx.env, m.org.id);
  return page(
    ctx,
    { title: `${m.org.name} graph`, nav: "orgs", head: graphAssets() },
    html`${orgHeader(m, "graph")}
      <div class="graph gfull gtab" data-graph data-full data-events="/orgs/${m.org.handle}/events" aria-label="Live graph of agents and their links">
        ${canvas}
        <div class="g-over g-left">
          <p class="mini" data-graph-counts></p>
          <p class="mini" data-graph-stream></p>
        </div>
        <div class="g-over g-right">
          ${legend}
          <span class="g-acts">${filters}<a class="mini-link" href="/orgs/${m.org.handle}/graph/full">Full screen</a></span>
          <span class="mini">${trails}</span>
        </div>
        <div hidden data-live="${REFRESH_MS}">${graphData(g)}</div>
        ${g ? "" : html`<p class="g-empty mini">The hub did not answer. This page retries on its own.</p>`}
      </div>`,
  );
}

/** `/orgs/<handle>/events`: a member's same-origin WebSocket of presence, endpoint and message metadata from the org hub */
export async function eventsRoute(ctx: Ctx, user: User, handle: string): Promise<Response> {
  if (ctx.req.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required", "The event stream is a WebSocket.");
  checkOrigin(ctx);
  const m = await requireMember(ctx.env.DB, handle, user.id);
  return hubEvents(ctx.env, m.org.id, user.id);
}

export const GRAPH_CSS = `
:root{--id-0:#2f6fdb;--id-1:#c2410c;--id-2:#0f8a6c;--id-3:#a3369e;--id-4:#a16207;--id-5:#6d4fd6;--id-6:#be123c;--id-7:#3f7d20}
@media (prefers-color-scheme:dark){:root{--id-0:#7aa9ff;--id-1:#f59a63;--id-2:#3fc6a0;--id-3:#e27ad9;--id-4:#e3b341;--id-5:#a991ff;--id-6:#fb7185;--id-7:#8fd16a}}
.g-over label{display:inline-flex;align-items:center;gap:.375rem;cursor:pointer}
.trails{display:inline-flex;align-items:center;gap:.375rem}
.trails .seg{display:inline-flex;border:1px solid var(--line)}
.trails .seg button{height:1.375rem;padding-inline:.4375rem;border:0;background:transparent;color:var(--ink);font-family:var(--mono);font-size:.625rem;cursor:pointer}
.trails .seg button+button{border-left:1px solid var(--line)}
.trails .seg button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.graph{margin-top:1.25rem}
.graph-legend{display:flex;flex-wrap:wrap;align-items:center;gap:.375rem}
.graph-legend .key{display:inline-block;width:1.25rem;height:0;margin-left:.5rem;border-top:1.5px solid var(--faint)}
.graph-legend .key:first-child{margin-left:0}
.graph-legend .key.msg{border-top-color:var(--acc)}
[data-graph-stream]:empty{display:none}
[data-graph-stream]::before{content:"";display:inline-block;width:6px;height:6px;margin-right:.375rem;vertical-align:1px;border:1px solid var(--faint)}
[data-stream=open] [data-graph-stream]::before{border-color:var(--acc);background:var(--acc);animation:pulse 2.4s ease-in-out infinite}
.graph-canvas{position:relative;margin-top:.75rem;overflow:hidden;border:1px solid var(--line-soft);background:var(--bg)}
.graph-svg{display:block;width:100%;height:420px;font-family:var(--mono);user-select:none;-webkit-user-select:none}
.graph-svg .hull{fill:var(--surface);stroke:var(--surface);stroke-linejoin:round;stroke-linecap:round}
.graph-svg .hull-rim{fill:none;stroke:var(--line-soft);stroke-linejoin:round;stroke-linecap:round}
.graph-svg .region.ided .hull-rim{stroke:color-mix(in srgb,var(--id) 30%,var(--line-soft))}
.graph-svg .region.offline,.graph-svg .region-head.offline{opacity:.55}
.graph-svg .mlabel{font-size:11px;font-weight:500;fill:var(--fg);paint-order:stroke;stroke:var(--surface);stroke-width:5px;stroke-linejoin:round}
.graph-svg .mlabel .n{fill:var(--dim);font-weight:400}
.graph-svg .mid{font-size:10px;fill:color-mix(in srgb,var(--id) 40%,var(--dim));paint-order:stroke;stroke:var(--surface);stroke-width:5px;stroke-linejoin:round}
.graph-svg .mdot{fill:var(--bg);stroke:var(--faint)}
.graph-svg .mdot.online{fill:var(--acc);stroke:var(--acc)}
.graph-svg .empty-note{font-size:10.5px;fill:var(--faint)}
.graph-svg .hub circle{fill:var(--bg);stroke:var(--line)}
.graph-svg .hub svg{color:var(--dim)}
.graph-svg .hub text{font-size:10.5px;fill:var(--dim);text-anchor:middle;paint-order:stroke;stroke:var(--bg);stroke-width:5px;stroke-linejoin:round}
.graph-svg .edge{fill:none;stroke-linecap:round;transition:opacity calc(.25s / var(--trail,1))}
.graph-svg .edge.spawn{stroke:var(--faint);stroke-width:1.25}
.graph-svg .edge.msg{stroke:var(--acc)}
.graph-svg .edge.msg.live{opacity:1!important}
.graph-svg .arrow{fill:var(--acc)}
.graph-svg .pulse{fill:var(--acc)}
.graph-svg .pulse-halo{fill:var(--acc);opacity:.25}
.graph-svg .pulse.reply,.graph-svg .pulse-halo.reply{fill:var(--fg)}
.graph-svg .node{cursor:pointer;outline:none;transition:opacity .3s}
.graph-svg .node .disc{fill:var(--bg);stroke:var(--line);stroke-width:1;transition:stroke .2s}
.graph-svg .node.online .disc{stroke:color-mix(in srgb,var(--fg) 34%,transparent)}
.graph-svg .node.human .disc{stroke-dasharray:2.5 2}
.graph-svg .node.offline{opacity:.5}
.graph-svg .node.offline .disc{stroke-dasharray:2 2}
.graph-svg .node.enter{opacity:0}
.graph-svg .node:hover .disc,.graph-svg .node:focus-visible .disc,.graph-svg .node.on .disc{stroke:var(--fg);stroke-width:1.5}
.graph-svg .ring{fill:none;stroke:var(--acc);stroke-width:2;opacity:0;transform-box:fill-box;transform-origin:center}
.graph-svg .node.hit .ring{animation:graph-hit .7s ease-out}
@keyframes graph-hit{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(1.55)}}
.graph-svg .glyph{color:var(--ink);overflow:visible}
.graph-svg .pdot{stroke:var(--bg);stroke-width:2;fill:var(--faint)}
.graph-svg .pdot.online{fill:var(--acc)}
.graph-svg .pdot.idle{fill:var(--dim)}
.graph-svg .bolt-g{color:var(--acc)}
.graph-svg .bolt-g circle{fill:var(--bg)}
.graph-svg .nlabel{font-size:11px;fill:var(--fg);text-anchor:middle;paint-order:stroke;stroke:var(--surface);stroke-width:5px;stroke-linejoin:round}
.graph-svg .node.offline .nlabel{fill:var(--dim)}
.graph-svg.focus .edge:not(.hl),.graph-svg.focus .node:not(.hl){opacity:.12!important}
.graph-svg.focus .edge.hl.spawn{stroke:var(--ink)}
.graph-tip{position:absolute;z-index:3;width:max-content;max-width:20rem;padding:.625rem .75rem;border:1px solid var(--line);background:var(--bg);font-size:.75rem;line-height:1.45;pointer-events:none;box-shadow:0 6px 24px rgb(0 0 0/.1)}
.graph-tip .t-head{display:flex;align-items:center;gap:.4rem;font-family:var(--mono);font-size:.8125rem;font-weight:500;color:var(--fg)}
.graph-tip .t-head svg{width:13px;height:13px;flex:none;overflow:visible;color:var(--ink)}
.graph-tip .t-addr{margin-top:.125rem;font-family:var(--mono);font-size:.6875rem;color:var(--dim);overflow-wrap:anywhere}
.graph-tip .t-row{margin-top:.375rem;color:var(--ink)}
.graph-tip .t-kv{display:grid;grid-template-columns:auto 1fr;gap:.125rem .75rem;margin-top:.5rem;font-family:var(--mono);font-size:.6875rem}
.graph-tip .t-kv dt{color:var(--dim)}
.graph-tip .t-kv dd{color:var(--fg);overflow-wrap:anywhere}
body.bare{overflow:hidden;height:100dvh;min-height:0}
.gfull{position:fixed;inset:0;margin:0}
.gfull.gtab{position:relative;inset:auto;height:max(26rem,calc(100dvh - 19rem));margin-top:1.5rem;border:1px solid var(--line-soft)}
.gtab .g-left{top:.75rem;left:.75rem}
.gtab .g-right{top:.75rem;right:.75rem}
.g-acts{display:inline-flex;align-items:center;gap:1rem}
@media (max-width:40rem){.gtab .g-right{top:auto;bottom:.75rem;left:.75rem;justify-items:start}.gtab{height:max(26rem,calc(100dvh - 16rem))}}
.gfull .graph-canvas{position:absolute;inset:0;margin:0;border:0}
.gfull .graph-svg{height:100%}
.g-over{position:absolute;z-index:2;display:grid;gap:.25rem;padding:.875rem 1rem;border:1px solid var(--line-soft);background:var(--head);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
.g-left{top:1rem;left:1rem;max-width:min(24rem,calc(100vw - 2rem))}
.g-left h1{font-size:1.25rem;line-height:1.25;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.g-right{top:1rem;right:1rem;justify-items:end}
.g-empty{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)}
@media (max-width:40rem){.g-right{top:auto;bottom:1rem}}
`;

/**
 * lays machine regions out in identity bands, plain JS so the page script and the tests share it. `items` are
 * `{ name, key, w, h }`, `key` the identity ("" for none, drawn without a band); a band holds its machines side by side
 * under a badge strip, bands wrap into rows near the `aspect` the view wants, and with `hub` set the hub sits above a
 * single row or between the middle rows. Returns each machine's top left, each band's rect and the hub point
 */
/** whether a node is drawn: online and wakeable idle always, next-turn idle and offline only when asked; an offline human stays while it talks */
export const DRAWN_JS = `function drawn(n, o, talks) {
  if (n.presence === "offline") return o.offline || (n.kind === "human" && talks.has(n.address));
  if (n.presence === "idle" && n.kind === "agent" && !n.wake) return o.nextTurn;
  return true;
}`;

/** a region's extent widened to fit its header (`w` wide, `h` tall) and a minimum width, so a slot is never narrower than its label */
export const SLOT_JS = `function slot(e, w, h, min) {
  return { x0: e.x0, x1: Math.max(e.x1, e.x0 + w, e.x0 + min), y0: e.y0 - h, y1: e.y1 };
}`;

export const BANDS_JS = `function bands(items, o) {
  const byKey = new Map();
  for (const it of items) { if (!byKey.has(it.key)) byKey.set(it.key, { key: it.key, items: [] }); byKey.get(it.key).items.push(it); }
  const groups = [...byKey.values()];
  for (const g of groups) {
    g.inset = g.key ? o.pad : 0;
    g.top = g.key ? o.badge : 0;
    g.w = g.items.reduce((w, it) => w + it.w, 0) + o.gap * (g.items.length - 1) + 2 * g.inset;
    g.h = Math.max(...g.items.map((it) => it.h)) + g.top + 2 * g.inset;
  }
  const area = groups.reduce((a, g) => a + (g.w + o.groupGap) * (g.h + o.groupGap), 0);
  const target = Math.max(Math.sqrt(area * o.aspect), ...groups.map((g) => g.w));
  const rows = [];
  for (const g of groups) {
    const row = rows[rows.length - 1];
    if (row && row.w + o.groupGap + g.w <= target) { row.groups.push(g); row.w += o.groupGap + g.w; }
    else rows.push({ groups: [g], w: g.w });
  }
  const width = Math.max(1, ...rows.map((r) => r.w));
  const mid = Math.floor(rows.length / 2);
  const places = new Map(), rects = [];
  let y = 0, hub = null;
  rows.forEach((row, r) => {
    if (o.hub && r === mid) {
      hub = { x: width / 2, y: rows.length === 1 ? o.hub / 2 - 10 : y + o.hub / 2 - o.groupGap / 2 };
      y += o.hub;
    }
    let x = (width - row.w) / 2;
    for (const g of row.groups) {
      rects.push({ key: g.key, x, y, w: g.w, h: g.h, n: g.items.length });
      let ix = x + g.inset;
      for (const it of g.items) { places.set(it.name, { x: ix, y: y + g.inset + g.top }); ix += it.w + o.gap; }
      x += g.w + o.groupGap;
    }
    y += Math.max(...row.groups.map((g) => g.h)) + o.groupGap;
  });
  return { places, bands: rects, hub, width, height: Math.max(y - o.groupGap, 1) };
}`;

/** the cluster layout's spacing: node gap, first ring radius, widest single arc, root fan span, how much wider than deep a fan is, child fan span, cluster gap, row aspect */
export const LAYOUT = { gap: 14, ring: 84, reach: 160, span: 2.4, wide: 1.4, sub: 1.6, apart: 64, aspect: 1.8 };

/**
 * one machine's nodes as subtree clusters, plain JS so the page script and the tests share it. `ns` are `{ address, parent }`,
 * `B` their `{ hw, up, down }` boxes. Each root fans its children out on arcs below it (one arc while it stays within
 * `o.reach`, then more rings), each child fans its own; childless roots share one grid. Overlaps inside a cluster are pushed
 * apart, and the clusters, largest first, pack into rows `o.apart` apart (rows half as much again) near `o.aspect`. Deterministic, so the same graph
 * lays out the same
 */
export const CLUSTER_JS = `function cluster(ns, B, o) {
  const at = new Map(ns.map((n, i) => [n.address, i]));
  const by = (a, b) => (ns[a].address < ns[b].address ? -1 : ns[a].address > ns[b].address ? 1 : 0);
  const kids = ns.map(() => []);
  const up = ns.map((n, i) => { const p = n.parent ? at.get(n.parent) : undefined; return p === undefined || p === i ? -1 : p; });
  up.forEach((p, i) => { if (p >= 0) kids[p].push(i); });
  for (const k of kids) k.sort(by);
  const P = ns.map(() => ({ x: 0, y: 0 }));
  const seen = new Set();
  const foot = (i) => Math.max(2 * B[i].hw, B[i].up + B[i].down) + o.gap;
  const step = (a, b) => (foot(a) + foot(b)) / 2;
  const fan = (i, dir, span, out) => {
    const c = kids[i].filter((k) => !seen.has(k));
    if (!c.length) return;
    for (const k of c) { seen.add(k); out.push(k); }
    const rise = Math.max(...c.map((k) => B[k].up + B[k].down)) + o.gap;
    let all = 0;
    for (let k = 1; k < c.length; k++) all += step(c[k - 1], c[k]);
    const per = Math.ceil(c.length / Math.max(1, Math.ceil(all / (span * o.reach))));
    let r = Math.max(o.ring, B[i].down + rise - B[i].up);
    for (let j = 0; j < c.length; j += per) {
      const ring = c.slice(j, j + per);
      let arc = 0;
      for (let k = 1; k < ring.length; k++) arc += step(ring[k - 1], ring[k]);
      r = Math.max(r, arc / span / o.wide);
      const rx = r * o.wide;
      let t = dir + arc / rx / 2;
      ring.forEach((k, n) => {
        let dx = Math.cos(t) * rx, dy = Math.sin(t) * r;
        if (Math.sin(dir) > 0.5) dy = Math.max(dy, B[i].down + B[k].up + o.gap);
        P[k] = { x: P[i].x + dx, y: P[i].y + dy, t };
        if (n + 1 < ring.length) t -= step(k, ring[n + 1]) / rx;
      });
      r += rise;
    }
    for (const k of c) fan(k, (P[k].t + Math.PI / 2) / 2, o.sub, out);
  };
  const grow = (i) => { seen.add(i); const out = [i]; P[i] = { x: 0, y: 0 }; fan(i, Math.PI / 2, o.span, out); return out; };
  const roots = ns.map((_, i) => i).filter((i) => up[i] < 0).sort(by);
  const groups = roots.filter((i) => kids[i].length).map(grow).sort((a, b) => b.length - a.length);
  for (const i of ns.map((_, i) => i).sort(by)) if (!seen.has(i) && up[i] >= 0) groups.push(grow(i));
  const solo = roots.filter((i) => !kids[i].length);
  if (solo.length) {
    const cols = Math.ceil(Math.sqrt(solo.length));
    const cw = Math.max(...solo.map(foot)), ch = Math.max(...solo.map((i) => B[i].up + B[i].down)) + o.gap;
    solo.forEach((i, k) => { P[i] = { x: (k % cols) * cw, y: Math.floor(k / cols) * ch }; });
    groups.push(solo);
  }
  const ext = groups.map((m) => {
    const Q = m.map((i) => P[i]), C = m.map((i) => B[i]), one = m.map(() => 1);
    for (let k = 0; k < 120; k++) if (!collide(Q, C, one)) break;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const i of m) { x0 = Math.min(x0, P[i].x - B[i].hw); x1 = Math.max(x1, P[i].x + B[i].hw); y0 = Math.min(y0, P[i].y - B[i].up); y1 = Math.max(y1, P[i].y + B[i].down); }
    return { m, x0, y0, w: x1 - x0, h: y1 - y0 };
  });
  const area = ext.reduce((a, e) => a + (e.w + o.apart) * (e.h + o.apart), 0);
  const target = Math.max(Math.sqrt(area * o.aspect), ...ext.map((e) => e.w));
  const rows = [];
  for (const e of ext) {
    const row = rows[rows.length - 1];
    if (row && row.w + o.apart + e.w <= target) { row.items.push(e); row.w += o.apart + e.w; }
    else rows.push({ items: [e], w: e.w });
  }
  const width = Math.max(0, ...rows.map((r) => r.w));
  let y = 0;
  for (const row of rows) {
    let x = (width - row.w) / 2;
    for (const e of row.items) {
      for (const i of e.m) { P[i].x += x - e.x0; P[i].y += y - e.y0; }
      x += e.w + o.apart;
    }
    y += Math.max(...row.items.map((e) => e.h)) + o.apart * 1.5;
  }
  return P.map((p) => ({ x: p.x, y: p.y }));
}

/** pushes overlapping node and label boxes apart along their shallower axis; true while any overlapped */
function collide(P, B, mob) {
  let hit = false;
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const dx = P[j].x - P[i].x, dy = P[j].y - P[i].y;
    const ox = B[i].hw + B[j].hw - Math.abs(dx);
    const oy = (dy >= 0 ? B[i].down + B[j].up : B[i].up + B[j].down) - Math.abs(dy);
    if (ox <= 0 || oy <= 0) continue;
    hit = true;
    const mi = mob[i], mj = mob[j], sum = mi + mj || 1;
    if (ox < oy) { const s = (dx >= 0 ? 1 : -1) * (ox + 0.5); P[i].x -= s * mi / sum; P[j].x += s * mj / sum; }
    else { const s = (dy >= 0 ? 1 : -1) * (oy + 0.5); P[i].y -= s * mi / sum; P[j].y += s * mj / sum; }
  }
  return hit;
}`;

/**
 * draws the live graph: each machine a soft region with its subtrees clustered apart, laid out again only when its shape changes;
 * a new node eases out from its parent, and a message pulses along its edge as the hub streams it
 */
export const graphScript = (): string => `(() => {
const root = document.querySelector("[data-graph]");
const live = document.querySelector("[data-live]");
if (!root || !live) return;
const bar = document.querySelector("[data-view-bar]");
const full = root.hasAttribute("data-full");
const NS = "http://www.w3.org/2000/svg";
const ICONS = ${JSON.stringify({ ...ICON_PATHS, human: HUMAN_ICON })};
const MARK = ${JSON.stringify(MARK)};
const COLORED = new Set(${JSON.stringify(COLORED)});
const BOLT = "M9.5 1 3 9h4.5L6.5 15 13 7H8.5z";
const R = 16, PAD = 20, HEAD = 26, ID_LINE = 14, GAP = 26, BAND_GAP = 44, LABEL_MAX = 176, NAME_MAX = 220, ID_MAX = 200, MIN_W = 96, CAP = 1.6;
const TRAILS = [1, 0.5, 0.25];
const LAYOUT = ${JSON.stringify(LAYOUT)};
${SLOT_JS}
${CLUSTER_JS}
${BANDS_JS}
${DRAWN_JS}
const svg = root.querySelector(".graph-svg");
const canvas = root.querySelector(".graph-canvas");
const tip = root.querySelector(".graph-tip");
const offline = document.querySelector("[data-graph-offline]");
const nextTurn = document.querySelector("[data-graph-nextturn]");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const lerp = (a, b, k) => a + (b - a) * k;
const r1 = (v) => Math.round(v * 10) / 10;
const machineOf = (a) => { const p = a.split("/"); return p.length >= 3 ? p[1] : ""; };

const defs = el("defs", {}, svg);
el("path", { d: "M0 0L7 3.5L0 7z", class: "arrow" }, el("marker", { id: "graph-arrow", viewBox: "0 0 7 7", refX: "1", refY: "3.5", markerWidth: "6", markerHeight: "6", markerUnits: "userSpaceOnUse", orient: "auto" }, defs));
const layers = {};
for (const k of ["regions", "edges", "hub", "labels", "pulses", "nodes"]) layers[k] = el("g", { class: "layer-" + k }, svg);

let data = null;
let focus = null;
let first = true;
let streamOpen = false;
const sim = new Map();
const shapes = new Map();
const shown = new Map();
const nodeEls = new Map();
const edgeEls = new Map();
const regionEls = new Map();
let place = new Map();
let hubAt = null;
let hubEl = null;
let viewTarget = null;
let viewShown = null;
let anim = 0;
let trail = TRAILS.includes(Number(load("scp.graph.trails"))) ? Number(load("scp.graph.trails")) : 1;

const measure = document.createElement("canvas").getContext("2d");
const widths = new Map();
function textWidth(text, weight, size = 11) {
  const key = weight + "|" + size + "|" + text;
  if (!widths.has(key)) {
    measure.font = weight + " " + size + "px " + (getComputedStyle(document.documentElement).getPropertyValue("--mono") || "monospace");
    widths.set(key, measure.measureText(text).width);
  }
  return widths.get(key);
}
function fit(text, weight = 400, max = LABEL_MAX, size = 11) {
  if (textWidth(text, weight, size) <= max) return text;
  let s = text;
  while (s.length > 1 && textWidth(s + "…", weight, size) > max) s = s.slice(0, -1);
  return s + "…";
}

function read() {
  const block = live.querySelector("script[data-graph-data]");
  if (!block) return null;
  try { return JSON.parse(block.textContent); } catch { return null; }
}

function setView(v) {
  document.documentElement.setAttribute("data-view", v);
  if (bar) for (const b of bar.querySelectorAll("[data-view-set]")) b.setAttribute("aria-pressed", String(b.getAttribute("data-view-set") === v));
  save("scp.overview.view", v);
  if (v === "graph") apply();
}

function visible(g) {
  const o = { offline: !!(offline && offline.checked), nextTurn: !!(nextTurn && nextTurn.checked) };
  const talks = new Set();
  for (const e of g.edges) if (e.kind === "message") { talks.add(e.from); talks.add(e.to); }
  const nodes = g.nodes.filter((n) => drawn(n, o, talks));
  const on = new Set(nodes.map((n) => n.address));
  const edges = g.edges.filter((e) => on.has(e.from) && on.has(e.to));
  const byName = new Map();
  for (const m of g.machines) byName.set(m.name, { name: m.name, online: m.online, identity: m.identity || null, nodes: [] });
  for (const n of nodes) {
    if (!byName.has(n.machine)) byName.set(n.machine, { name: n.machine, online: n.presence === "online", identity: null, nodes: [] });
    byName.get(n.machine).nodes.push(n);
  }
  const groups = [...byName.values()].filter((gr) => gr.nodes.length || gr.online);
  const who = (gr) => (gr.identity ? gr.identity.name : "");
  groups.sort((a, b) => (a.name === "") - (b.name === "") || !who(a) - !who(b) || who(a).localeCompare(who(b)) || a.name.localeCompare(b.name));
  return { nodes, edges, groups };
}

function box(n) {
  return { hw: Math.max(R + 4, textWidth(fit(n.label), 400) / 2 + 6), up: R + 6, down: R + 22 };
}

/** one machine's layout, recomputed only when its nodes, labels or spawn links change, so a refresh never moves anything */
function settle(g, edges) {
  const ns = g.nodes;
  const ids = new Set(ns.map((n) => n.address));
  const spawn = edges.filter((e) => e.kind === "spawn" && ids.has(e.from) && ids.has(e.to));
  const sig = ns.map((n) => n.address + ":" + fit(n.label)).sort().join(" ") + "|" + spawn.map((e) => e.from + ">" + e.to).sort().join(" ");
  if (shapes.get(g.name) === sig) return;
  shapes.set(g.name, sig);
  const up = new Map(spawn.map((e) => [e.to, e.from]));
  const P = cluster(ns.map((n) => ({ address: n.address, parent: up.get(n.address) || null })), ns.map(box), LAYOUT);
  ns.forEach((n, i) => sim.set(n.address, P[i]));
}

/** a region's header: the machine name and agent count, the identity on a second line, each cut to a sane width */
function headOf(g) {
  const full = g.name || "org";
  const name = fit(full, 500, NAME_MAX);
  const id = g.identity ? fit("identity: " + g.identity.name, 400, ID_MAX, 10) : "";
  const count = g.nodes.length + (g.nodes.length === 1 ? " agent" : " agents") + (g.online ? "" : ", offline");
  const w = Math.max(textWidth(name, 500) + 8 + textWidth(count, 400), id ? textWidth(id, 400, 10) : 0) + 34;
  return { name, id, count, title: full + (g.identity ? "\\nidentity: " + g.identity.name : ""), w, h: HEAD + (id ? ID_LINE : 0) };
}

/** a region's extent around its own origin, header included; an empty machine is one short row for its note */
function extent(g) {
  const h = headOf(g);
  if (!g.nodes.length) return slot({ x0: 0, x1: 0, y0: 0, y1: 12 }, h.w, h.h, MIN_W);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of g.nodes) {
    const p = sim.get(n.address), b = box(n);
    x0 = Math.min(x0, p.x - b.hw); x1 = Math.max(x1, p.x + b.hw); y0 = Math.min(y0, p.y - b.up); y1 = Math.max(y1, p.y + b.down);
  }
  return slot({ x0, x1, y0, y1 }, h.w, h.h, MIN_W);
}

/** regions with one identity's machines side by side, wrapped to the window's shape; the hub sits above a single row, else between the middle rows */
function pack(list) {
  const cw = Math.max(280, canvas.clientWidth), ch = full ? Math.max(240, canvas.clientHeight) : 0;
  const aspect = full ? cw / ch : Math.max(1.4, cw / 560);
  const ext = list.map(extent);
  const items = list.map((g, i) => ({ name: g.name, key: g.identity ? g.identity.name : "", w: ext[i].x1 - ext[i].x0 + 2 * PAD, h: ext[i].y1 - ext[i].y0 + 2 * PAD }));
  const L = bands(items, { gap: GAP, groupGap: BAND_GAP, pad: 0, badge: 0, hub: list.length > 1 ? 96 : 0, aspect: aspect * 1.15 });
  const out = new Map();
  list.forEach((g, i) => {
    const p = L.places.get(g.name), e = ext[i];
    out.set(g.name, { ox: p.x + PAD - e.x0, oy: p.y + PAD - e.y0, x: p.x, y: p.y, w: items[i].w, h: items[i].h });
  });
  hubAt = L.hub;
  const widest = L.width;
  const height = L.height;
  const margin = full ? Math.min(120, cw * 0.06) : 24;
  let top = margin, bottom = margin;
  const at = full ? canvas.getBoundingClientRect().top : 0;
  if (full) for (const o of root.querySelectorAll(".g-over")) {
    const b = o.getBoundingClientRect();
    if (b.top - at < ch / 2) top = Math.max(top, b.bottom - at + 16);
    else bottom = Math.max(bottom, ch - (b.top - at) + 16);
  }
  const scale = full
    ? Math.min(CAP, (cw - 2 * margin) / widest, (ch - top - bottom) / height)
    : Math.min(CAP, (cw - 2 * margin) / widest, 760 / (height + 2 * margin));
  const vw = cw / scale;
  const vh = full ? ch / scale : Math.max(340 / scale, height + (2 * margin) / scale);
  const cy = full ? height / 2 - (top - bottom) / 2 / scale : height / 2;
  viewTarget = { x: widest / 2 - vw / 2, y: cy - vh / 2, w: vw, h: vh, px: full ? 0 : vh * scale };
  return out;
}

function counts(v) {
  const out = document.querySelector("[data-graph-counts]");
  if (!out) return;
  const agents = v.nodes.filter((n) => n.kind === "agent");
  const on = agents.filter((n) => n.presence === "online").length;
  const m = v.groups.filter((g) => g.name).length;
  out.textContent = m + (m === 1 ? " machine, " : " machines, ") + agents.length + (agents.length === 1 ? " agent, " : " agents, ") + on + " online";
}

function apply() {
  if (!data) return;
  const has = data.nodes.length > 0 || data.machines.length > 0;
  if (bar) bar.hidden = !has;
  if (!full) root.hidden = !has;
  if (!has && !full) { document.documentElement.removeAttribute("data-view"); return; }
  if (bar && !document.documentElement.hasAttribute("data-view")) return setView(load("scp.overview.view") === "table" ? "table" : "graph");
  if (bar && document.documentElement.getAttribute("data-view") !== "graph") return;
  for (const m of root.querySelectorAll("[data-graph-minutes]")) m.textContent = String(data.minutes);
  const v = visible(data);
  counts(v);
  for (const g of v.groups) settle(g, v.edges);
  place = pack(v.groups);
  sync(v);
  start();
}

/** where a node rests, in view coordinates */
function target(a) {
  const s = sim.get(a), o = place.get(machineOf(a));
  return s && o ? { x: o.ox + s.x, y: o.oy + s.y } : null;
}

function sync(v) {
  const keep = new Set();
  for (const g of v.groups) {
    keep.add(g.name);
    let r = regionEls.get(g.name);
    if (!r) {
      const gr = el("g", { class: "region" }, layers.regions);
      const head = el("g", { class: "region-head" }, layers.labels);
      r = { g: gr, head, rim: el("path", { class: "hull-rim" }, gr), hull: el("path", { class: "hull" }, gr), dot: el("circle", { class: "mdot", r: "3" }, head), label: el("text", { class: "mlabel" }, head), idl: el("text", { class: "mid" }, head), note: el("text", { class: "empty-note" }, gr) };
      r.title = el("title", {}, head);
      r.name = el("tspan", {}, r.label);
      r.n = el("tspan", { class: "n", dx: "8" }, r.label);
      regionEls.set(g.name, r);
    }
    const head = headOf(g);
    r.g.classList.toggle("offline", !g.online);
    r.head.classList.toggle("offline", !g.online);
    r.dot.setAttribute("class", "mdot" + (g.online ? " online" : ""));
    r.name.textContent = head.name;
    r.idl.textContent = head.id;
    r.title.textContent = head.title;
    r.n.textContent = head.count;
    r.note.textContent = g.nodes.length ? "" : "no agents";
    r.g.classList.toggle("ided", !!g.identity);
    r.g.style.setProperty("--id", g.identity ? "var(--id-" + g.identity.tone + ")" : "");
    r.head.style.setProperty("--id", g.identity ? "var(--id-" + g.identity.tone + ")" : "");
    r.group = g;
  }
  for (const [k, r] of regionEls) if (!keep.has(k)) { r.g.remove(); r.head.remove(); regionEls.delete(k); }


  const on = new Set();
  for (const n of v.nodes) {
    on.add(n.address);
    const e = nodeEls.get(n.address) || makeNode(n);
    e.n = n;
    paintNode(e);
  }
  for (const [a, e] of nodeEls) if (!on.has(a)) {
    nodeEls.delete(a);
    shown.delete(a);
    e.g.classList.add("enter");
    setTimeout(() => e.g.remove(), 320);
  }

  const edgesOn = new Set();
  for (const e of v.edges) {
    const key = e.kind + ":" + e.from + ">" + e.to;
    edgesOn.add(key);
    let p = edgeEls.get(key);
    if (!p) {
      p = el("path", { class: "edge " + (e.kind === "message" ? "msg" : "spawn") }, layers.edges);
      if (e.kind === "message") p.setAttribute("marker-end", "url(#graph-arrow)");
      p.dataset.from = e.from;
      p.dataset.to = e.to;
      edgeEls.set(key, p);
    }
    p.edge = e;
    paintEdge(p);
  }
  for (const [k, p] of edgeEls) if (!edgesOn.has(k)) { p.remove(); edgeEls.delete(k); }

  if (hubAt && !hubEl) {
    hubEl = el("g", { class: "hub", "aria-hidden": "true" }, layers.hub);
    el("circle", { r: "15" }, hubEl);
    el("svg", { x: "-7", y: "-7", width: "14", height: "14", viewBox: "0 0 32 32", fill: "currentColor" }, hubEl).innerHTML = MARK;
    el("text", { y: "-22" }, hubEl).textContent = "hub";
  }
  if (!hubAt && hubEl) { hubEl.remove(); hubEl = null; }
  applyFocus();
}

function makeNode(n) {
  const g = el("g", { class: "node enter", tabindex: "0", role: "button" }, layers.nodes);
  g.dataset.address = n.address;
  const e = { g, n };
  e.ring = el("circle", { class: "ring", r: String(R) }, g);
  e.disc = n.kind === "human" ? el("rect", { class: "disc", x: -R, y: -R, width: 2 * R, height: 2 * R, rx: 6 }, g) : el("circle", { class: "disc", r: String(R) }, g);
  e.glyph = el("svg", { class: "glyph", x: "-7.5", y: "-7.5", width: "15", height: "15", viewBox: "0 0 24 24" }, g);
  e.pdot = el("circle", { class: "pdot", cx: String(r1(R * 0.72)), cy: String(r1(-R * 0.72)), r: "4" }, g);
  e.bolt = el("g", { class: "bolt-g", transform: "translate(" + r1(R * 0.72) + " " + r1(R * 0.72) + ")" }, g);
  el("circle", { r: "6" }, e.bolt);
  el("path", { d: BOLT, transform: "translate(-4.4 -4.4) scale(.55)", fill: "currentColor" }, e.bolt);
  e.label = el("text", { class: "nlabel", y: String(R + 15) }, g);
  const from = n.parent && shown.get(n.parent);
  const t = target(n.address);
  if (t) shown.set(n.address, from ? { ...from } : { ...t });
  nodeEls.set(n.address, e);
  requestAnimationFrame(() => requestAnimationFrame(() => g.classList.remove("enter")));
  return e;
}

function paintNode(e) {
  const n = e.n, c = e.g.classList;
  for (const p of ["online", "idle", "offline"]) c.toggle(p, n.presence === p);
  c.toggle("human", n.kind === "human");
  e.g.setAttribute("aria-label", n.name + ", " + n.presence + (n.wake ? ", wakes via " + n.wake : ""));
  if (e.icon !== n.icon) {
    e.icon = n.icon;
    e.glyph.innerHTML = ICONS[n.icon] || ICONS.generic;
    e.glyph.style.color = COLORED.has(n.icon) ? "var(--h-" + n.icon + ")" : "";
  }
  e.pdot.setAttribute("class", "pdot " + n.presence);
  e.pdot.style.display = n.kind === "human" ? "none" : "";
  e.bolt.style.display = n.wake && n.kind !== "human" ? "" : "none";
  e.label.textContent = fit(n.label);
}

/** message edges fade over the graph's window and thicken with their count */
function paintEdge(p) {
  const e = p.edge;
  if (e.kind !== "message") return;
  const age = Math.max(0, Date.now() - Date.parse(e.last_at)) / (data.minutes * 60000);
  p.style.opacity = String(r1(0.22 + 0.66 * Math.max(0, 1 - age)));
  p.style.strokeWidth = String(r1(1.1 + Math.min(2.6, Math.log2(e.count) * 0.55)));
}

/** an edge's path: straight for a spawn within a machine and an S curve from the parent down to a child on another machine; a message bows gently within a machine and between machines rises to the hub and runs through it, each direction on its own lane */
function curve(e, a, b) {
  const trim = (p, c, by) => { const ux = c.x - p.x, uy = c.y - p.y, l = Math.max(Math.hypot(ux, uy), 1); return { x: p.x + ux / l * by, y: p.y + uy / l * by }; };
  const pt = (p) => r1(p.x) + " " + r1(p.y);
  const end = R + (e.kind === "message" ? 8 : 3);
  if (e.kind === "message" && hubAt && machineOf(e.from) !== machineOf(e.to)) {
    const hy = hubAt.y + (b.x >= a.x ? -3 : 3), h = { x: hubAt.x, y: hy };
    const c1 = { x: a.x, y: lerp(a.y, hy, 0.6) }, c2 = { x: lerp(a.x, h.x, 0.55), y: hy };
    const c3 = { x: lerp(b.x, h.x, 0.55), y: hy }, c4 = { x: b.x, y: lerp(b.y, hy, 0.6) };
    return "M" + pt(trim(a, c1, R + 3)) + "C" + pt(c1) + " " + pt(c2) + " " + pt(h) + "C" + pt(c3) + " " + pt(c4) + " " + pt(trim(b, c4, end));
  }
  if (e.kind === "spawn" && machineOf(e.from) !== machineOf(e.to)) {
    const k = Math.max(Math.abs(b.y - a.y), Math.abs(b.x - a.x) * 0.35, 60) * 0.5;
    const c1 = { x: a.x, y: a.y + k }, c2 = { x: b.x, y: b.y - k };
    return "M" + pt(trim(a, c1, R + 3)) + "C" + pt(c1) + " " + pt(c2) + " " + pt(trim(b, c2, end));
  }
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(Math.hypot(dx, dy), 1), nx = -dy / d, ny = dx / d;
  const bow = e.kind === "spawn" ? 0 : Math.min(46, d * 0.2);
  const c1 = { x: a.x + dx / 3 + nx * bow, y: a.y + dy / 3 + ny * bow }, c2 = { x: a.x + dx * 2 / 3 + nx * bow, y: a.y + dy * 2 / 3 + ny * bow };
  return "M" + pt(trim(a, c1, R + 3)) + "C" + pt(c1) + " " + pt(c2) + " " + pt(trim(b, c2, end));
}

function hullOf(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

function draw() {
  for (const [a, e] of nodeEls) {
    const p = shown.get(a);
    if (p) e.g.setAttribute("transform", "translate(" + r1(p.x) + " " + r1(p.y) + ")");
  }
  for (const [, p] of edgeEls) {
    const a = shown.get(p.edge.from), b = shown.get(p.edge.to);
    if (a && b) p.setAttribute("d", curve(p.edge, a, b));
  }
  for (const [name, r] of regionEls) {
    const g = r.group, o = place.get(name);
    if (!o) continue;
    const pts = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of g.nodes) {
      const p = shown.get(n.address);
      if (!p) continue;
      const b = box(n);
      x0 = Math.min(x0, p.x - b.hw); x1 = Math.max(x1, p.x + b.hw); y0 = Math.min(y0, p.y - b.up); y1 = Math.max(y1, p.y + b.down);
      pts.push([p.x - b.hw + 6, p.y - b.up + 6], [p.x + b.hw - 6, p.y - b.up + 6], [p.x - b.hw + 6, p.y + b.down - 6], [p.x + b.hw - 6, p.y + b.down - 6]);
    }
    const head = headOf(g);
    if (!pts.length) { x0 = o.x + PAD; y0 = o.y + PAD + head.h; x1 = o.x + o.w - PAD; y1 = o.y + o.h - PAD; pts.push([x0, y0], [x1, y0], [x0, y1], [x1, y1]); }
    const hw = x0 + Math.max(head.w, MIN_W);
    if (hw > x1) { x1 = hw; pts.push([x0, y1], [x1, y1]); }
    pts.push([x0, y0 - head.h], [x1, y0 - head.h]);
    const d = "M" + hullOf(pts).map((q) => r1(q[0]) + " " + r1(q[1])).join("L") + "Z";
    r.hull.setAttribute("d", d);
    r.hull.setAttribute("stroke-width", String(2 * PAD));
    r.rim.setAttribute("d", d);
    r.rim.setAttribute("stroke-width", String(2 * PAD + 2));
    const lx = x0 - PAD + 16, ly = y0 - head.h - PAD + 22;
    r.dot.setAttribute("cx", r1(lx));
    r.dot.setAttribute("cy", r1(ly - 4));
    r.label.setAttribute("x", r1(lx + 9));
    r.label.setAttribute("y", r1(ly));
    r.idl.setAttribute("x", r1(lx + 9));
    r.idl.setAttribute("y", r1(ly + ID_LINE));
    r.note.setAttribute("x", r1(lx));
    r.note.setAttribute("y", r1(y0 + 9));
    r.box = { x0: x0 - PAD, y0: y0 - head.h - PAD, x1: x1 + PAD, y1: y1 + PAD };
  }
  if (hubEl && hubAt) hubEl.setAttribute("transform", "translate(" + r1(hubAt.x) + " " + r1(hubAt.y) + ")");
  if (viewShown) {
    svg.setAttribute("viewBox", [viewShown.x, viewShown.y, viewShown.w, viewShown.h].map(r1).join(" "));
    if (!full) svg.style.height = Math.round(viewShown.px) + "px";
  }
}

/** eases every node from where it shows to where it rests, and the view with it */
function start() {
  cancelAnimationFrame(anim);
  const from = new Map();
  for (const [a] of nodeEls) { const t = target(a); if (t) from.set(a, shown.get(a) || { ...t }); }
  const v0 = viewShown || viewTarget;
  const dur = first || reduce ? 0 : 700;
  first = false;
  const t0 = performance.now();
  const step = (now) => {
    const k = dur ? ease(Math.min(1, (now - t0) / dur)) : 1;
    for (const [a, f] of from) { const t = target(a); if (t) shown.set(a, { x: lerp(f.x, t.x, k), y: lerp(f.y, t.y, k) }); }
    viewShown = { x: lerp(v0.x, viewTarget.x, k), y: lerp(v0.y, viewTarget.y, k), w: lerp(v0.w, viewTarget.w, k), h: lerp(v0.h, viewTarget.h, k), px: lerp(v0.px, viewTarget.px, k) };
    draw();
    if (k < 1) anim = requestAnimationFrame(step);
  };
  step(t0);
}

/** a dot from sender to recipient along their edge, about a second end to end; \`bump\` counts the message on the edge */
function pulse(from, to, kind, bump) {
  if (!data) return;
  let e = data.edges.find((x) => x.kind === "message" && x.from === from && x.to === to);
  if (e && bump) { e.count++; e.last_at = new Date().toISOString(); }
  else if (!e) {
    if (!data.nodes.some((n) => n.address === from) || !data.nodes.some((n) => n.address === to)) return refresh();
    data.edges.push({ kind: "message", from, to, count: 1, last_at: new Date().toISOString() });
    apply();
  }
  const p = edgeEls.get("message:" + from + ">" + to);
  if (!p) return;
  paintEdge(p);
  p.classList.add("live");
  setTimeout(() => p.classList.remove("live"), 1600 / trail);
  const dest = nodeEls.get(to);
  const hit = () => {
    if (!dest) return;
    dest.g.classList.remove("hit");
    void dest.g.getBBox();
    dest.g.classList.add("hit");
    setTimeout(() => dest.g.classList.remove("hit"), 750);
  };
  if (reduce || document.hidden) return hit();
  const cls = kind === "reply" ? " reply" : "";
  const halo = el("circle", { class: "pulse-halo" + cls, r: "11" }, layers.pulses);
  const dot = el("circle", { class: "pulse" + cls, r: "4.5" }, layers.pulses);
  const t0 = performance.now(), dur = 950 / trail;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    let q = null;
    try { q = p.getPointAtLength(ease(k) * p.getTotalLength()); } catch {}
    if (q) for (const c of [halo, dot]) { c.setAttribute("cx", r1(q.x)); c.setAttribute("cy", r1(q.y)); }
    if (k < 1 && p.isConnected) requestAnimationFrame(step);
    else { halo.remove(); dot.remove(); hit(); }
  };
  requestAnimationFrame(step);
}

function applyFocus() {
  if (focus && !nodeEls.has(focus)) focus = null;
  svg.classList.toggle("focus", !!focus);
  const near = new Set(focus ? [focus] : []);
  for (const [, p] of edgeEls) {
    const on = !!focus && (p.dataset.from === focus || p.dataset.to === focus);
    p.classList.toggle("hl", on);
    if (on) { near.add(p.dataset.from); near.add(p.dataset.to); }
  }
  for (const [a, e] of nodeEls) { e.g.classList.toggle("hl", near.has(a)); e.g.classList.toggle("on", a === focus); }
}

function showTip(g) {
  const n = data && data.nodes.find((x) => x.address === g.dataset.address);
  if (!n) return;
  const div = (c, t) => { const d = document.createElement("div"); d.className = c; d.textContent = t; return d; };
  const head = document.createElement("div");
  head.className = "t-head";
  const icon = document.createElementNS(NS, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.innerHTML = ICONS[n.icon] || ICONS.generic;
  if (COLORED.has(n.icon)) icon.style.color = "var(--h-" + n.icon + ")";
  head.append(icon, document.createTextNode(n.name));
  const sum = (side) => data.edges.filter((e) => e.kind === "message" && e[side] === n.address).reduce((s, e) => s + e.count, 0);
  const out = sum("from"), inn = sum("to");
  const wake = n.wake ? "wakes via " + n.wake : n.kind === "agent" && n.presence === "idle" ? "reads at its next turn" : "";
  const rows = [
    ["presence", n.presence + (wake ? ", " + wake : "")],
    ["status", n.status ? n.status.state + (n.status.note ? ": " + n.status.note : "") : ""],
    ["harness", n.kind === "agent" ? n.harness || "unknown" : ""],
    ["machine", n.machine],
    ["member", (data.machines.find((m) => m.name === n.machine)?.identity || {}).name || ""],
    ["parent", n.parent ? n.parent.split("/").slice(2).join("/") : ""],
    ["messages", out || inn ? out + " sent, " + inn + " received in " + data.minutes + " min" : ""],
  ].filter((r) => r[1]);
  const kv = document.createElement("dl");
  kv.className = "t-kv";
  for (const [k, v] of rows) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; kv.append(dt, dd); }
  tip.replaceChildren(head, div("t-addr", n.address), ...(n.title ? [div("t-row", n.title)] : []), kv);
  tip.hidden = false;
  const c = canvas.getBoundingClientRect(), r = g.getBoundingClientRect();
  let left = r.right - c.left + 10;
  if (left + tip.offsetWidth > canvas.clientWidth - 8) left = r.left - c.left - tip.offsetWidth - 10;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = Math.max(8, Math.min(r.top - c.top - 6, canvas.clientHeight - tip.offsetHeight - 8)) + "px";
}

function hideTip() { tip.hidden = true; }

function refresh() { document.dispatchEvent(new CustomEvent("scp:refresh")); }

/** a refreshed live region; without the stream, a newer message on an edge pulses it */
function update() {
  const next = read();
  if (!next) return;
  const before = data;
  data = next;
  apply();
  if (!before || streamOpen) return;
  for (const e of next.edges) {
    if (e.kind !== "message") continue;
    const o = before.edges.find((x) => x.kind === "message" && x.from === e.from && x.to === e.to);
    if (!o || e.last_at > o.last_at) pulse(e.from, e.to, "message", false);
  }
}

function onEvent(ev) {
  if (!data || !ev || typeof ev !== "object") return;
  if (ev.type === "message" && Array.isArray(ev.to)) for (const to of ev.to) pulse(ev.from, to, ev.kind, true);
  else if (ev.type === "presence") {
    const n = data.nodes.find((x) => x.address === ev.endpoint);
    if (!n) return refresh();
    if (n.presence === ev.presence) return;
    n.presence = ev.presence;
    const m = data.machines.find((x) => x.name === n.machine);
    if (m && ev.presence !== "offline") m.online = true;
    apply();
  } else if (ev.type === "endpoints" || ev.type === "hello") refresh();
}

let backoff = 1000;
function connect() {
  const path = root.getAttribute("data-events");
  if (!path || typeof WebSocket !== "function") return;
  let ws, ping = 0;
  try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + path); } catch { return; }
  ws.onopen = () => { backoff = 1000; setStream(true); ping = setInterval(() => { try { ws.send("ping"); } catch {} }, 30000); };
  ws.onmessage = (m) => { if (typeof m.data !== "string" || m.data === "pong") return; try { onEvent(JSON.parse(m.data)); } catch {} };
  ws.onclose = (c) => {
    clearInterval(ping);
    setStream(false);
    if (c.code === 4003) return;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
}
function setStream(open) {
  streamOpen = open;
  document.documentElement.setAttribute("data-stream", open ? "open" : "poll");
  for (const s of document.querySelectorAll("[data-graph-stream]")) s.textContent = open ? "live" : "polling";
}

const nodeAt = (e) => (e.target instanceof Element ? e.target.closest(".node") : null);
svg.addEventListener("click", (e) => { const g = nodeAt(e); focus = g && g.dataset.address !== focus ? g.dataset.address : null; applyFocus(); });
svg.addEventListener("keydown", (e) => {
  const g = nodeAt(e);
  if (!g || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  focus = g.dataset.address !== focus ? g.dataset.address : null;
  applyFocus();
});
svg.addEventListener("pointerover", (e) => { const g = nodeAt(e); if (g) showTip(g); });
svg.addEventListener("pointerout", (e) => { const g = nodeAt(e); if (g && !g.contains(e.relatedTarget)) hideTip(); });
svg.addEventListener("focusin", (e) => { const g = nodeAt(e); if (g) showTip(g); });
svg.addEventListener("focusout", hideTip);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && focus) { focus = null; applyFocus(); } });
const trailButtons = document.querySelectorAll("[data-trail]");
function paintTrail() {
  svg.style.setProperty("--trail", String(trail));
  for (const b of trailButtons) b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-trail")) === trail));
}
for (const b of trailButtons) b.addEventListener("click", () => { trail = Number(b.getAttribute("data-trail")); save("scp.graph.trails", String(trail)); paintTrail(); });
paintTrail();
if (bar) for (const b of bar.querySelectorAll("[data-view-set]")) b.addEventListener("click", () => setView(b.getAttribute("data-view-set")));
for (const [input, key] of [[offline, "scp.overview.offline"], [nextTurn, "scp.graph.nextturn"]]) {
  if (!input) continue;
  input.checked = load(key) === "1";
  input.addEventListener("change", () => { save(key, input.checked ? "1" : "0"); apply(); });
}
let size = "";
new ResizeObserver(() => { const s = canvas.clientWidth + "x" + (full ? canvas.clientHeight : 0); if (canvas.clientWidth && s !== size) { size = s; apply(); } }).observe(canvas);
new MutationObserver(update).observe(live, { childList: true });
setInterval(() => { for (const [, p] of edgeEls) paintEdge(p); }, 20000);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { widths.clear(); shapes.clear(); apply(); });
setStream(false);
update();
connect();
})();
`;
