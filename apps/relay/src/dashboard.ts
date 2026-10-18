import type { ActivityRow, EndpointView } from "@scp-dev/core";
import type { IdentifiedGraph } from "./identity";
import type { User } from "./env";
import { hubGraph, hubHolds, hubOverview, judgeEnabled, type Overview } from "./hub/routes";
import { judgeSetup } from "./hub/judge";
import { type Html, html } from "./html";
import { canManage, type Membership, orgTab, requireMember } from "./orgs";
import {
  activityBlock,
  ago,
  describe,
  fleetStrip,
  groupByMachine,
  handleOf,
  hicon,
  hubDown,
  liveRegion,
  liveStamp,
  newest,
  onboarding,
  splitAddress,
  wakeOf,
} from "./overview";
import { listDevices, listTokens } from "./tokens";
import type { Ctx } from "./web";

export interface Counts {
  online: number;
  wakeable: number;
  nextTurn: number;
  offline: number;
  machines: number;
  machinesOnline: number;
  /** messages over the graph's window, null when the hub did not answer it */
  messages: number | null;
  minutes: number;
}

export function countsOf(o: Overview, g: IdentifiedGraph | null): Counts {
  const agents = o.endpoints.filter((e) => e.kind === "agent");
  const idle = agents.filter((e) => e.presence === "idle");
  const groups = groupByMachine(o);
  return {
    online: agents.filter((e) => e.presence === "online").length,
    wakeable: idle.filter((e) => wakeOf(e)).length,
    nextTurn: idle.filter((e) => !wakeOf(e)).length,
    offline: agents.filter((e) => e.presence === "offline").length,
    machines: groups.length,
    machinesOnline: groups.filter((x) => x.machine?.online || x.endpoints.some((e) => e.presence === "online")).length,
    messages: g ? g.edges.filter((e) => e.kind === "message").reduce((n, e) => n + (e.count ?? 0), 0) : null,
    minutes: g?.minutes ?? 15,
  };
}

const tile = (label: string, value: number | string, hint: string, tone = ""): Html =>
  html`<div class="tile${tone ? ` ${tone}` : ""}"><p class="tile-label">${label}</p><p class="tile-value">${value}</p><p class="mini">${hint}</p></div>`;

function tiles(c: Counts): Html {
  return html`<div class="tiles">
    ${tile("Online", c.online, c.online === 1 ? "agent working" : "agents working", "on")}
    ${tile("Idle, wakeable", c.wakeable, "a message wakes them")}
    ${tile("Idle, next turn", c.nextTurn, "read at their next turn")}
    ${tile("Machines", c.machines, `${c.machinesOnline} online`)}
    ${tile("Messages", c.messages ?? "-", `last ${c.minutes} min`)}
  </div>`;
}

/** the line an agent shows under "now": its status note, else its last turn's summary, else its title */
function gist(e: EndpointView, lastStop: Map<string, ActivityRow>): { lead: Html | string; text: string } | null {
  if (e.status) return { lead: html`<span class="role">${e.status.state}</span>`, text: e.status.note ?? "" };
  const stop = lastStop.get(e.address);
  if (stop?.summary) return { lead: html`<span class="mini">tl;dr</span>`, text: stop.summary };
  if (e.title) return { lead: "", text: e.title };
  return null;
}

const NOW_MAX = 6;
const RANK: Record<string, number> = { online: 0, idle: 1, offline: 2 };

function nowList(o: Overview, now: number, handle: string): Html {
  const lastStop = new Map<string, ActivityRow>();
  const recent = newest(o.activity);
  for (const a of recent) if (a.kind === "stop" && a.summary && !lastStop.has(a.endpoint)) lastStop.set(a.endpoint, a);
  const rows = o.endpoints
    .filter((e) => e.kind === "agent" && e.presence !== "offline")
    .map((e) => ({ e, g: gist(e, lastStop) }))
    .sort(
      (a, b) =>
        (RANK[a.e.presence] ?? 3) - (RANK[b.e.presence] ?? 3) || Number(!a.g) - Number(!b.g) || (b.e.last_seen ?? "").localeCompare(a.e.last_seen ?? ""),
    );
  const shown = rows.slice(0, NOW_MAX);
  const latest = recent[0];
  return html`<section class="panel now"><div class="panel-head"><h2>Happening now</h2><a class="mini-link push" href="/orgs/${handle}/sessions">All sessions</a></div>
    ${
      shown.length
        ? html`<ul class="now-list">${shown.map(({ e, g }) => {
            const wake = wakeOf(e);
            return html`<li><div class="now-who">${hicon(e.harness)}<span class="mono">${handleOf(e.address)}</span><span class="mini">${splitAddress(e.address).machine}</span><span class="push mini"><span class="dot ${e.presence}${wake ? " wake" : ""}" aria-hidden="true"></span>${e.presence}</span></div>
              <p class="now-what small" title="${g?.text ?? ""}">${g ? html`${g.lead}${g.lead && g.text ? " " : ""}${g.text}` : html`<span class="mini">no status yet</span>`}</p></li>`;
          })}</ul>${rows.length > NOW_MAX ? html`<p class="mini more-line">and ${rows.length - NOW_MAX} more on the <a class="mini-link" href="/orgs/${handle}/sessions">Sessions</a> tab</p>` : ""}`
        : html`<p class="empty">No agent is online or idle right now.</p>`
    }
    ${
      latest
        ? html`<p class="mini last-line"><span class="what" title="${describe(latest)}">Last activity ${ago(latest.at, now)}: ${handleOf(latest.endpoint)}, ${describe(latest)}</span><a class="mini-link" href="/orgs/${handle}/activity">All activity</a></p>`
        : ""
    }
  </section>`;
}

interface Side {
  devices: number;
  tokens: number;
  /** held messages an owner or admin can review; null when there is nothing to show */
  holds: number | null;
}

async function sideOf(ctx: Ctx, m: Membership, user: User): Promise<Side> {
  const judging = canManage(m.role) && judgeSetup(ctx.env) !== null && (await judgeEnabled(ctx.env.DB, m.org.id));
  const [devices, tokens, holds] = await Promise.all([
    listDevices(ctx.env.DB, m, user),
    listTokens(ctx.env.DB, m.org.id),
    judging ? hubHolds(ctx.env, m.org.id) : Promise.resolve(null),
  ]);
  return { devices: devices.length, tokens: tokens.length, holds: holds ? holds.length : null };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function overviewRegion(o: Overview | null, g: IdentifiedGraph | null, side: Side, handle: string, now: number): Html {
  if (!o) return hubDown();
  if (!o.machines.length && !o.endpoints.length) return onboarding(handle);
  const c = countsOf(o, g);
  const held = side.holds
    ? html`<p class="notice held" role="status">${plural(side.holds, "message")} held by the relay judge, waiting for review. <a href="/orgs/${handle}/members#judge">Review</a></p>`
    : "";
  return html`<div class="block-head summary-head"><p class="mini">${plural(c.online + c.wakeable + c.nextTurn, "agent")} live, ${c.offline} offline</p>${liveStamp(now)}</div>
    ${held}
    ${tiles(c)}
    <div class="panels">
      ${nowList(o, now, handle)}
      <section class="panel"><div class="panel-head"><h2>Fleet</h2></div>
        ${fleetStrip(o, handle)}
        <p class="small fleet-line">${plural(c.machines, "machine")}, ${c.machinesOnline} online. ${plural(side.devices, "device")} and ${plural(side.tokens, "API token")} signed in. <a class="mini-link" href="/orgs/${handle}/tokens">Manage</a></p>
      </section>
    </div>`;
}

/** `/orgs/<handle>`: the tl;dr of the org's fleet */
export async function overviewPage(ctx: Ctx, user: User, handle: string): Promise<Response> {
  const m = await requireMember(ctx.env.DB, handle, user.id);
  const [o, g, side] = await Promise.all([hubOverview(ctx.env, m.org.id), hubGraph(ctx.env, m.org.id), sideOf(ctx, m, user)]);
  return orgTab(ctx, m, "overview", m.org.name, overviewRegion(o, g, side, m.org.handle, ctx.now), { live: true });
}

/** `/orgs/<handle>/activity`: tool use and turns as the hooks report them */
export async function activityPage(ctx: Ctx, user: User, handle: string): Promise<Response> {
  const m = await requireMember(ctx.env.DB, handle, user.id);
  const o = await hubOverview(ctx.env, m.org.id);
  return orgTab(ctx, m, "activity", `${m.org.name} activity`, o ? activityBlock(o.activity, ctx.now) : hubDown(), { live: true });
}

/** `/orgs/<handle>/sessions`: every machine's agent tree */
export async function sessionsPage(ctx: Ctx, user: User, handle: string): Promise<Response> {
  const m = await requireMember(ctx.env.DB, handle, user.id);
  const o = await hubOverview(ctx.env, m.org.id);
  return orgTab(ctx, m, "sessions", `${m.org.name} sessions`, liveRegion(o, m.org.handle, ctx.now), { live: true });
}
