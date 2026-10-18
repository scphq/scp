import { type ActivityRow, type EndpointView, GONE_PREFIX } from "@scp-dev/core";
import type { MachineRow } from "@scp-dev/hub";
import type { Overview } from "./hub/routes";
import { Html, html } from "./html";
import { notice } from "./orgs";

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
export const wakeOf = (e: EndpointView): string | null => (e.wake && e.wake !== "none" ? e.wake : null);

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

/**
 * Harness marks on a 24 grid, tinted by their `--h-*` token. Brand paths are simple-icons 15.0.0 (CC0), except grok, the xAI mark
 * from lobe-icons 1.95.1 (MIT, https://github.com/lobehub/lobe-icons, icons/xai.svg); opencode is its favicon's frame and block,
 * pi is its 4 by 4 pixel logo.
 */
export const ICON_PATHS: Record<string, string> = {
  claude:
    '<path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" fill="currentColor"/>',
  codex:
    '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="currentColor"/>',
  opencode: '<path d="M21.6 24H2.4V0h19.2zM16.8 4.8H7.2v14.4h9.6z" fill="currentColor"/><path d="M16.8 9.6H7.2v9.6h9.6z" fill="currentColor" opacity=".45"/>',
  gemini:
    '<path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" fill="currentColor"/>',
  agy: '<path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" fill="currentColor"/>',
  grok: '<g transform="translate(1.2 1.2) scale(.9)"><path d="M6.469 8.776 16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9 2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z" fill="currentColor"/></g>',
  muse: '<g transform="translate(-1.2 -1.2) scale(1.1)"><path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" fill="currentColor"/></g>',
  pi: '<path d="M0 0h18v6H0zM0 6h6v18H0zM12 6h6v6h-6zM6 12h6v6H6zM18 12h6v12h-6z" fill="currentColor"/>',
  generic:
    '<g transform="scale(1.5)"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 6.25 6.5 8l-2 1.75M8 10h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></g>',
};

const ICON_OF: Record<string, string> = {
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  agy: "agy",
  antigravity: "agy",
  grok: "grok",
  muse: "muse",
  xai: "grok",
  pi: "pi",
};

/** the glyph for a harness name, generic for one this page does not know */
export const harnessIcon = (harness: string | null): string => ICON_OF[(harness ?? "").toLowerCase()] ?? "generic";

/** sized in markup too, so a stale or missing stylesheet never blows it up */
export const hicon = (harness: string | null): Html => {
  const key = harnessIcon(harness);
  return html`<svg class="hicon h-${key}" width="12" height="12" viewBox="0 0 24 24" role="img" aria-label="${harness ?? "unknown harness"}">${new Html(ICON_PATHS[key]!)}</svg>`;
};

const CARET = html`<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M2 .75 6.5 4 2 7.25z" fill="currentColor"/></svg>`;

/** a handle as people read it: a retired row's `_gone_<id>` shows as ended */
export const shown = (handle: string): string => (handle.startsWith(GONE_PREFIX) ? "(ended)" : handle);

export const handleOf = (address: string): string => shown(splitAddress(address).handle);

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

export interface Tree {
  root: EndpointView;
  /** its live descendants via parent, online first */
  kids: EndpointView[];
}

const live = (e: EndpointView): boolean => e.presence !== "offline";

/** each orchestrator (an agent with no listed parent) with its live descendants, biggest first; all-offline trees drop out */
export function fleetTrees(endpoints: EndpointView[]): Tree[] {
  const agents = endpoints.filter((e) => e.kind === "agent");
  const listed = new Set(agents.map((e) => e.address));
  const under = new Map<string, EndpointView[]>();
  const roots: EndpointView[] = [];
  for (const e of agents) {
    if (e.parent && e.parent !== e.address && listed.has(e.parent)) under.set(e.parent, [...(under.get(e.parent) ?? []), e]);
    else roots.push(e);
  }
  const seen = new Set<string>();
  const grow = (root: EndpointView): Tree => {
    seen.add(root.address);
    const kids: EndpointView[] = [];
    const stack = [...(under.get(root.address) ?? [])];
    while (stack.length) {
      const e = stack.pop()!;
      if (seen.has(e.address)) continue;
      seen.add(e.address);
      kids.push(e);
      stack.push(...(under.get(e.address) ?? []));
    }
    return { root, kids: kids.filter(live).sort(byPresence) };
  };
  const trees = roots.map(grow);
  for (const e of agents) if (!seen.has(e.address)) trees.push(grow(e));
  return trees.filter((t) => live(t.root) || t.kids.length).sort((a, b) => b.kids.length - a.kids.length || byPresence(a.root, b.root));
}

const SOLO_MAX = 3;
const cell = (e: EndpointView): Html => html`<span class="cell ${e.presence}${wakeOf(e) ? " wake" : ""}" title="${handleOf(e.address)}, ${e.presence}"></span>`;

function treeRow({ root, kids }: Tree): Html {
  const { machine } = splitAddress(root.address);
  return html`<div class="strip-row"><span class="strip-who" title="${root.address}">${hicon(root.harness)}<span class="mono strip-name">${handleOf(root.address)}</span><span class="mini">${machine}</span></span>
    <span class="cells">${live(root) ? cell(root) : ""}${kids.map(cell)}</span>${kids.length ? html`<span class="mini push">${kids.length}</span>` : ""}</div>`;
}

/** trees with children one row each; past a few, the childless ones share a row */
function treeRows(trees: Tree[]): Html[] {
  const solo = trees.filter((t) => !t.kids.length);
  if (solo.length <= SOLO_MAX) return trees.map(treeRow);
  return [
    ...trees.filter((t) => t.kids.length).map(treeRow),
    html`<div class="strip-row"><span class="strip-who"><span class="mono strip-name">${solo.length} solo agents</span></span>
      <span class="cells">${solo.map((t) => cell(t.root))}</span></div>`,
  ];
}

/** each orchestrator as a row of squares, its own first, then its subagents, shaded by presence; offline agents are left out */
export function fleetStrip(o: Overview, handle: string): Html {
  return html`<div class="strip" aria-label="Agents per orchestrator">${treeRows(fleetTrees(o.endpoints))}</div><p class="mini strip-key"><span class="cell online"></span>online <span class="cell idle wake"></span>wakeable <span class="cell idle"></span>next turn <a class="mini-link push" href="/orgs/${handle}/graph">Graph</a></p>`;
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

export function describe(a: ActivityRow): string {
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

/** newest first, whatever order the hub merged its machines' rows in */
export const newest = (rows: ActivityRow[]): ActivityRow[] => [...rows].sort((a, b) => b.at.localeCompare(a.at));

export function activityBlock(rows: ActivityRow[], now: number): Html {
  return html`<section class="block"><div class="block-head"><h2>Recent activity</h2>${liveStamp(now)}</div>
    ${
      rows.length
        ? html`<div class="table"><table class="activity"><colgroup><col class="c-when"><col class="c-who"><col></colgroup><thead><tr><th>When</th><th>Agent</th><th>What</th></tr></thead>
          <tbody>${newest(rows).map((a) => {
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

/** the live marker a refreshed region carries: the stream state, then the time of the last render */
export const liveStamp = (now: number): Html =>
  html`<span class="mini push live-stamp"><span class="dot online pulse" aria-hidden="true"></span><span data-feed>polling</span>, updated ${new Date(now).toISOString().slice(11, 19)} UTC</span>`;

export function onboarding(handle: string): Html {
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

export const hubDown = (): Html => notice("The hub did not answer. This page retries on its own.", true) || html``;

/** the sessions tab's live region: each machine with its agent tree, or the onboarding steps before the first one joins */
export function liveRegion(o: Overview | null, handle: string, now: number): Html {
  if (!o) return hubDown();
  const groups = groupByMachine(o);
  if (!groups.length) return onboarding(handle);
  const agents = groups.reduce((n, g) => n + g.endpoints.length, 0);
  const online = groups.filter((g) => g.machine?.online || g.endpoints.some((e) => e.presence === "online")).length;
  return html`<section class="block"><div class="block-head"><h2>Machines</h2>
      <span class="mini">${groups.length} ${groups.length === 1 ? "machine" : "machines"}, ${online} online, ${agents} ${agents === 1 ? "agent" : "agents"}</span>
      ${liveStamp(now)}</div>
      ${groups.map((g) => machineBlock(g, now))}
    </section>`;
}

/**
 * copy buttons, agent tree toggles, and a refetch of the page that swaps in its live region while the tab is visible;
 * slower while the graph's event stream is open, and soon after an `scp:refresh` event. A page without the graph opens
 * the event stream itself and refreshes on each event, keeping its poll for what the stream does not carry
 */
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
  let timer = 0;
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(tick, ms); };
  let soon = false;
  const tick = async () => {
    soon = false;
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
    later(document.documentElement.getAttribute("data-stream") === "open" ? every * 4 : every);
  };
  document.addEventListener("scp:refresh", () => { if (!soon) { soon = true; later(250); } });
  later(every);
  const path = live.getAttribute("data-events");
  if (path && !document.querySelector("[data-graph]") && typeof WebSocket === "function") {
    const state = (open) => {
      document.documentElement.setAttribute("data-feed-state", open ? "open" : "poll");
      for (const s of document.querySelectorAll("[data-feed]")) s.textContent = open ? "live" : "polling";
    };
    let backoff = 1000;
    const connect = () => {
      let ws, ping = 0;
      try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + path); } catch { return; }
      ws.onopen = () => { backoff = 1000; state(true); ping = setInterval(() => { try { ws.send("ping"); } catch {} }, 30000); };
      ws.onmessage = (m) => { if (typeof m.data === "string" && m.data !== "pong" && !m.data.includes('"hello"')) document.dispatchEvent(new CustomEvent("scp:refresh")); };
      ws.onclose = (c) => {
        clearInterval(ping);
        state(false);
        if (c.code === 4003) return;
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
    };
    new MutationObserver(() => state(document.documentElement.getAttribute("data-feed-state") === "open")).observe(live, { childList: true });
    connect();
  }
}
const tab = document.querySelector('.tabs [aria-current="page"]');
if (tab) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
`;
