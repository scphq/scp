import { type ActivityRow, type EndpointView, GONE_PREFIX } from "@scp-dev/core";
import type { MachineRow } from "@scp-dev/hub";
import type { User } from "./env";
import { GRAPH_CSS, graphData, graphScript, graphShell } from "./graph";
import { hubGraph, hubOverview, type Overview } from "./hub/routes";
import { Html, html, stamp } from "./html";
import { notice, orgHeader, requireMember } from "./orgs";
import { type Ctx, page } from "./web";

/** how often the page refetches itself, in ms */
export const REFRESH_MS = 8000;

export function ago(at: string | null, now: number): string {
  if (!at) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** `acme/laptop/lead` as its machine and handle */
export function splitAddress(address: string): { machine: string; handle: string } {
  const [, machine = "", ...rest] = address.split("/");
  return { machine, handle: rest.join("/") || machine };
}

interface MachineGroup {
  name: string;
  machine: MachineRow | null;
  endpoints: EndpointView[];
}

export function groupByMachine(o: Overview): MachineGroup[] {
  const groups = new Map<string, MachineGroup>(o.machines.map((m) => [m.name, { name: m.name, machine: m, endpoints: [] }]));
  for (const e of o.endpoints) {
    if (e.kind !== "agent") continue;
    const { machine } = splitAddress(e.address);
    let g = groups.get(machine);
    if (!g) {
      g = { name: machine, machine: null, endpoints: [] };
      groups.set(machine, g);
    }
    g.endpoints.push(e);
  }
  return [...groups.values()];
}

/** how an idle agent gets woken by a message; absent or `none` means it reads at its next turn */
const wakeOf = (e: EndpointView): string | null => (e.wake && e.wake !== "none" ? e.wake : null);

const BOLT = html`<svg class="bolt" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1 3 9h4.5L6.5 15 13 7H8.5z" fill="currentColor"/></svg>`;

function presence(e: EndpointView): { cell: Html; tip: string } {
  const wake = wakeOf(e);
  const tip =
    e.presence === "idle"
      ? wake
        ? `idle, a message wakes it via ${wake}`
        : "idle, reads messages at its next turn"
      : wake
        ? `${e.presence}, wakes via ${wake}`
        : e.presence;
  return {
    cell: html`<span class="dot ${e.presence}${wake ? " wake" : ""}" aria-hidden="true"></span><span class="mini">${e.presence}</span>${wake ? html` <span class="wake-badge">${BOLT}<span class="sr">wakes via ${wake}</span></span>` : ""}`,
    tip,
  };
}

export const ICON_PATHS: Record<string, string> = {
  claude: '<path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  codex:
    '<path d="M8 1.5 13.6 4.75v6.5L8 14.5l-5.6-3.25v-6.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 6.5 7.75 8 6 9.5M8.75 10h1.75" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  opencode:
    '<rect x="2.25" y="2.25" width="11.5" height="11.5" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5.5" y="8" width="5" height="3" fill="currentColor"/>',
  gemini: '<path d="M8 1c.6 3.6 3.4 6.4 7 7-3.6.6-6.4 3.4-7 7-.6-3.6-3.4-6.4-7-7 3.6-.6 6.4-3.4 7-7z" fill="currentColor"/>',
  grok: '<circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 13 13 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  muse: '<path d="M2 12.5V4.5l3 4 3-5 3 5 3-4v8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  pi: '<path d="M2.5 4.5h11M6 4.5v8.5M10.25 4.5v6.75c0 1 .5 1.75 1.75 1.75" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  generic:
    '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 6.25 6.5 8l-2 1.75M8 10h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
};

const ICON_OF: Record<string, string> = {
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  agy: "gemini",
  grok: "grok",
  muse: "muse",
  pi: "pi",
};

/** the glyph for a harness name, generic for one this page does not know */
export const harnessIcon = (harness: string | null): string => ICON_OF[(harness ?? "").toLowerCase()] ?? "generic";

/** sized in markup too, so a stale or missing stylesheet never blows it up */
const hicon = (harness: string | null): Html => {
  const key = harnessIcon(harness);
  return html`<svg class="hicon h-${key}" width="12" height="12" viewBox="0 0 16 16" role="img" aria-label="${harness ?? "unknown harness"}">${new Html(ICON_PATHS[key]!)}</svg>`;
};

const CARET = html`<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 .75 6.5 4 2 7.25z" fill="currentColor"/></svg>`;

/** a handle as people read it: a retired row's `_gone_<id>` shows as ended */
export const shown = (handle: string): string => (handle.startsWith(GONE_PREFIX) ? "(ended)" : handle);

const handleOf = (address: string): string => shown(splitAddress(address).handle);

/** labels worth a chip: the machine label repeats the section header */
export const chips = (l: Record<string, string>): [string, string][] => Object.entries(l).filter(([k]) => k !== "machine");

const RANK: Record<string, number> = { online: 0, idle: 1, offline: 2 };

const byPresence = (a: EndpointView, b: EndpointView): number =>
  (RANK[a.presence] ?? 3) - (RANK[b.presence] ?? 3) || splitAddress(a.address).handle.localeCompare(splitAddress(b.address).handle);

export interface Row {
  e: EndpointView;
  /** nesting under a parent shown in the rows above, 0 for a root */
  depth: number;
  /** the addresses of its listed ancestors, root first */
  anc: string[];
  /** how many rows sit directly under it */
  kids: number;
}

/** online, then idle, then offline, then by handle, each subagent right under its parent when the parent is listed */
export function orderRows(endpoints: EndpointView[]): Row[] {
  const listed = new Set(endpoints.map((e) => e.address));
  const kids = new Map<string, EndpointView[]>();
  const roots: EndpointView[] = [];
  for (const e of endpoints) {
    if (e.parent && e.parent !== e.address && listed.has(e.parent)) kids.set(e.parent, [...(kids.get(e.parent) ?? []), e]);
    else roots.push(e);
  }
  const out: Row[] = [];
  const seen = new Set<string>();
  const walk = (list: EndpointView[], anc: string[]): void => {
    for (const e of list.sort(byPresence)) {
      if (seen.has(e.address)) continue;
      seen.add(e.address);
      out.push({ e, depth: anc.length, anc, kids: 0 });
      walk(kids.get(e.address) ?? [], [...anc, e.address]);
    }
  };
  walk(roots, []);
  walk(
    endpoints.filter((e) => !seen.has(e.address)),
    [],
  );
  const byAddress = new Map(out.map((r) => [r.e.address, r]));
  for (const r of out) if (r.anc.length) byAddress.get(r.anc.at(-1)!)!.kids++;
  return out;
}

function endpointRow({ e, depth, anc, kids }: Row, shut: Set<string>, now: number): Html {
  const handle = handleOf(e.address);
  const parent = e.parent ? handleOf(e.parent) : null;
  const tags = chips(e.labels);
  const status = e.status ? (e.status.note ? `${e.status.state}: ${e.status.note}` : e.status.state) : "none";
  const seen = e.presence === "online" ? "now" : ago(e.last_seen, now);
  const state = presence(e);
  const caret = kids
    ? html`<button class="caret" type="button" data-tree="${e.address}" aria-expanded="${String(!shut.has(e.address))}" aria-label="${kids} under ${handle}">${CARET}</button>`
    : html`<span class="caret" aria-hidden="true"></span>`;
  const tip = [handle, e.harness ?? "unknown harness", parent ? `sub of ${parent}` : ""].filter(Boolean).join(", ");
  return html`<tr${depth ? html` class="sub d${Math.min(depth, 4)}" data-anc="${anc.join(" ")}"${anc.some((a) => shut.has(a)) ? " hidden" : ""}` : ""}>
    <td class="agent" title="${tip}">${caret}${hicon(e.harness)}<span class="mono">${handle}</span>${parent && !depth ? html` <span class="mini">sub of ${parent}</span>` : ""}</td>
    <td class="small" title="${e.title ?? ""}">${e.title ?? ""}</td>
    <td title="${state.tip}">${state.cell}</td>
    <td title="${status}">${e.status ? html`<span class="role">${e.status.state}</span>${e.status.note ? html` <span class="small">${e.status.note}</span>` : ""}` : html`<span class="mini">none</span>`}</td>
    <td title="${tags.map(([k, v]) => `${k}=${v}`).join(", ")}">${tags.map(([k, v]) => html`<span class="tag">${k}=${v}</span>`)}</td>
    <td class="mono end" title="${e.last_seen ?? "never"}">${seen}</td>
  </tr>`;
}

const COLS = html`<colgroup><col class="c-agent"><col class="c-title"><col class="c-presence"><col class="c-status"><col class="c-labels"><col class="c-seen"></colgroup>`;

/** live parents start expanded, offline ones collapsed */
const agentTable = (rows: Row[], now: number, head: boolean): Html => {
  const shut = new Set(rows.filter((r) => r.kids && r.e.presence === "offline").map((r) => r.e.address));
  return html`<div class="table"><table class="agents">${COLS}${
    head ? html`<thead><tr><th>Agent</th><th>Title</th><th>Presence</th><th>Status</th><th>Labels</th><th class="end">Seen</th></tr></thead>` : ""
  }<tbody>${rows.map((r) => endpointRow(r, shut, now))}</tbody></table></div>`;
};

function machineBlock(g: MachineGroup, now: number): Html {
  const m = g.machine;
  const state = m ? (m.online ? "online" : "offline") : g.endpoints.some((e) => e.presence === "online") ? "online" : "offline";
  const active = orderRows(g.endpoints.filter((e) => e.presence !== "offline"));
  const offline = orderRows(g.endpoints.filter((e) => e.presence === "offline"));
  return html`<div class="machine">
    <div class="machine-head">
      <span class="dot ${state}" aria-hidden="true"></span><h3 class="mono">${g.name}</h3>
      ${m ? html`<span class="role">${m.kind}</span>` : ""}
      <span class="mini">${state === "online" ? "online" : `seen ${ago(m?.last_seen ?? null, now)}`}</span>
      <span class="mini push">${g.endpoints.length} ${g.endpoints.length === 1 ? "agent" : "agents"}</span>
    </div>
    ${
      g.endpoints.length
        ? html`${active.length ? agentTable(active, now, true) : ""}${
            offline.length
              ? html`<details class="offline" data-key="${g.name}"><summary class="mini"><span class="when-shut">show</span><span class="when-open">hide</span> ${offline.length} offline</summary>${agentTable(offline, now, !active.length)}</details>`
              : ""
          }`
        : html`<p class="empty">No agents on this machine right now.</p>`
    }
  </div>`;
}

function describe(a: ActivityRow): string {
  switch (a.kind) {
    case "session_start":
      return "started a session";
    case "session_end":
      return "ended its session";
    case "stop":
      return a.summary ? `finished a turn: ${a.summary}` : "finished a turn";
    case "tool":
      return [a.tool, a.summary].filter(Boolean).join(": ") || "used a tool";
    default:
      return a.summary ?? a.kind;
  }
}

function activityBlock(rows: ActivityRow[], now: number): Html {
  return html`<section class="block"><h2>Recent activity</h2>
    ${
      rows.length
        ? html`<div class="table"><table class="activity"><colgroup><col class="c-when"><col class="c-who"><col></colgroup><thead><tr><th>When</th><th>Agent</th><th>What</th></tr></thead>
          <tbody>${rows.map((a) => {
            const { machine, handle } = splitAddress(a.endpoint);
            const who = `${machine}/${shown(handle)}`;
            const what = describe(a);
            return html`<tr><td class="mono" title="${a.at}">${ago(a.at, now)}</td><td class="mono" title="${a.agent ? `${who} ${a.agent}` : who}">${who}${a.agent ? html` <span class="mini">${a.agent}</span>` : ""}</td><td class="small" title="${what}">${what}</td></tr>`;
          })}</tbody></table></div>`
        : html`<p class="empty">No activity yet. Hooks report tool use and turns as agents work.</p>`
    }</section>`;
}

const command = (cmd: string): Html =>
  html`<div class="cmd"><code><span class="prompt" aria-hidden="true">$ </span>${cmd}</code><button class="btn btn-ghost btn-small" type="button" data-copy="${cmd}">Copy</button></div>`;

function onboarding(handle: string): Html {
  return html`<section class="block onboard"><h2>Connect your first machine</h2>
    <p class="small">No machines have joined this hub yet. Run these on the machine your agents work on. The page updates on its own once it connects.</p>
    <ol class="steps">
      <li><p class="label">Install the CLI</p>${command("npm i -g @scp-dev/cli")}</li>
      <li><p class="label">Sign in, link this machine, install hooks and MCP</p>${command("swarm up")}</li>
      <li><p class="label">Start a named orchestrator that wakes on peer messages</p>${command("swarm claude --name lead")}</li>
    </ol>
    <div class="sub-block">
      <h3>Use an API token for ambient agents</h3>
      <p class="small">An agent that runs unattended, on a server or in CI, signs in with an org API token instead of a device login. Create one under <a href="/orgs/${handle}/tokens">Tokens and devices</a>, then:</p>
      ${command("swarm up --token <token> --machine <name>")}
      <p class="small">Or set <code>SCP_TOKEN</code> in its environment. Its agents show the label <span class="tag">token=&lt;name&gt;</span>.</p>
    </div>
  </section>`;
}

export function liveRegion(o: Overview | null, handle: string, now: number): Html {
  if (!o) return notice("The hub did not answer. This page retries on its own.", true) || html``;
  const groups = groupByMachine(o);
  if (!groups.length) return onboarding(handle);
  const agents = groups.reduce((n, g) => n + g.endpoints.length, 0);
  const online = groups.filter((g) => g.machine?.online || g.endpoints.some((e) => e.presence === "online")).length;
  return html`<section class="block"><div class="block-head"><h2>Machines</h2>
      <span class="mini">${groups.length} ${groups.length === 1 ? "machine" : "machines"}, ${online} online, ${agents} ${agents === 1 ? "agent" : "agents"}</span>
      <span class="mini push"><span class="dot online pulse" aria-hidden="true"></span>live, updated ${new Date(now).toISOString().slice(11, 19)} UTC</span></div>
      ${groups.map((g) => machineBlock(g, now))}
    </section>
    ${activityBlock(o.activity, now)}`;
}

export async function overviewPage(ctx: Ctx, user: User, handle: string): Promise<Response> {
  const m = await requireMember(ctx.env.DB, handle, user.id);
  const [o, g] = await Promise.all([hubOverview(ctx.env, m.org.id), hubGraph(ctx.env, m.org.id)]);
  return page(
    ctx,
    {
      title: m.org.name,
      nav: "orgs",
      wide: true,
      head: html`<script src="/app.js?v=${stamp(APP_JS)}" defer></script><script src="/graph.js?v=${stamp(graphScript())}" defer></script><link rel="stylesheet" href="/graph.css?v=${stamp(GRAPH_CSS)}"><noscript><meta http-equiv="refresh" content="${Math.round(REFRESH_MS / 1000)}"></noscript>`,
    },
    html`${orgHeader(m, "overview")}
      ${graphShell()}
      <div data-live="${REFRESH_MS}">${liveRegion(o, m.org.handle, ctx.now)}${graphData(g)}</div>`,
  );
}

/** copy buttons, agent tree toggles, and a refetch of the page that swaps in its live region while the tab is visible */
export const APP_JS = `
const chosen = new Map();
const fold = (root) => {
  for (const b of root.querySelectorAll("[data-tree]")) {
    const v = chosen.get(b.getAttribute("data-tree"));
    if (v) b.setAttribute("aria-expanded", v);
  }
  const shut = new Set([...root.querySelectorAll('[data-tree][aria-expanded="false"]')].map((b) => b.getAttribute("data-tree")));
  for (const r of root.querySelectorAll("tr[data-anc]")) r.hidden = r.getAttribute("data-anc").split(" ").some((a) => shut.has(a));
};
document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target.closest("[data-tree]") : null;
  if (!t) return;
  chosen.set(t.getAttribute("data-tree"), t.getAttribute("aria-expanded") === "true" ? "false" : "true");
  fold(document);
});
document.addEventListener("click", async (e) => {
  const b = e.target instanceof Element ? e.target.closest("[data-copy]") : null;
  if (!b) return;
  try {
    await navigator.clipboard.writeText(b.getAttribute("data-copy"));
    b.textContent = "Copied";
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  } catch {}
});
const live = document.querySelector("[data-live]");
if (live) {
  const every = Number(live.getAttribute("data-live")) || 8000;
  const tick = async () => {
    const selecting = String(window.getSelection() || "").length > 0;
    if (!document.hidden && !selecting) {
      try {
        const res = await fetch(location.href, { credentials: "same-origin", headers: { accept: "text/html" } });
        const next = res.ok ? new DOMParser().parseFromString(await res.text(), "text/html").querySelector("[data-live]") : null;
        if (next) {
          const open = new Set([...live.querySelectorAll("details[open][data-key]")].map((d) => d.getAttribute("data-key")));
          for (const d of next.querySelectorAll("details[data-key]")) if (open.has(d.getAttribute("data-key"))) d.open = true;
          fold(next);
          live.replaceChildren(...next.childNodes);
        }
      } catch {}
    }
    setTimeout(tick, every);
  };
  setTimeout(tick, every);
}
`;
