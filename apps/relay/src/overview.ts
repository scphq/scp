import type { ActivityRow, EndpointView } from "@scp-dev/core";
import type { MachineRow } from "@scp-dev/hub";
import type { User } from "./env";
import { type Overview, hubOverview } from "./hub/routes";
import { type Html, html } from "./html";
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

const presence = (state: string): Html => html`<span class="dot ${state}" aria-hidden="true"></span><span class="mini">${state}</span>`;

const labels = (l: Record<string, string>): Html[] => Object.entries(l).map(([k, v]) => html`<span class="tag">${k}=${v}</span> `);

function endpointRow(e: EndpointView, now: number): Html {
  const { handle } = splitAddress(e.address);
  return html`<tr>
    <td><span class="mono">${handle}</span>${e.parent ? html` <span class="mini">sub of ${splitAddress(e.parent).handle}</span>` : ""}</td>
    <td class="mono">${e.harness ?? ""}</td>
    <td class="small">${e.title ?? ""}</td>
    <td class="nowrap">${presence(e.presence)}</td>
    <td>${e.status ? html`<span class="role">${e.status.state}</span>${e.status.note ? html` <span class="small">${e.status.note}</span>` : ""}` : html`<span class="mini">none</span>`}</td>
    <td>${labels(e.labels)}</td>
    <td class="mono nowrap">${e.presence === "online" ? "now" : ago(e.last_seen, now)}</td>
  </tr>`;
}

function machineBlock(g: MachineGroup, now: number): Html {
  const m = g.machine;
  const state = m ? (m.online ? "online" : "offline") : g.endpoints.some((e) => e.presence === "online") ? "online" : "offline";
  return html`<div class="machine">
    <div class="machine-head">
      <span class="dot ${state}" aria-hidden="true"></span><h3 class="mono">${g.name}</h3>
      ${m ? html`<span class="role">${m.kind}</span>` : ""}
      <span class="mini">${state === "online" ? "online" : `seen ${ago(m?.last_seen ?? null, now)}`}</span>
      <span class="mini push">${g.endpoints.length} ${g.endpoints.length === 1 ? "agent" : "agents"}</span>
    </div>
    ${
      g.endpoints.length
        ? html`<div class="table"><table class="agents">
          <colgroup><col class="c-agent"><col class="c-harness"><col class="c-title"><col class="c-presence"><col class="c-status"><col class="c-labels"><col class="c-seen"></colgroup>
          <thead><tr><th>Agent</th><th>Harness</th><th>Title</th><th>Presence</th><th>Status</th><th>Labels</th><th>Seen</th></tr></thead>
          <tbody>${g.endpoints.map((e) => endpointRow(e, now))}</tbody></table></div>`
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
        ? html`<div class="table"><table><thead><tr><th>When</th><th>Agent</th><th>What</th></tr></thead>
          <tbody>${rows.map((a) => {
            const { machine, handle } = splitAddress(a.endpoint);
            return html`<tr><td class="mono nowrap">${ago(a.at, now)}</td><td class="mono nowrap">${machine}/${handle}${a.agent ? html` <span class="mini">${a.agent}</span>` : ""}</td><td class="small">${describe(a)}</td></tr>`;
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
  const o = await hubOverview(ctx.env, m.org.id);
  return page(
    ctx,
    {
      title: m.org.name,
      nav: "orgs",
      head: html`<script src="/app.js" defer></script><noscript><meta http-equiv="refresh" content="${Math.round(REFRESH_MS / 1000)}"></noscript>`,
    },
    html`${orgHeader(m, "overview")}
      <div data-live="${REFRESH_MS}">${liveRegion(o, m.org.handle, ctx.now)}</div>`,
  );
}

/** copy buttons, and a refetch of the page that swaps in its live region while the tab is visible */
export const APP_JS = `
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
        if (next) live.replaceChildren(...next.childNodes);
      } catch {}
    }
    setTimeout(tick, every);
  };
  setTimeout(tick, every);
}
`;
