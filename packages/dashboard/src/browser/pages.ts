import { overviewRegion, type Side } from "../../../../apps/relay/src/dashboard";
import { graphAssets, graphFull, graphTab } from "../../../../apps/relay/src/graph";
import { type Chrome, type Html, html, layout } from "../../../../apps/relay/src/html";
import { identities, identify } from "../../../../apps/relay/src/identity";
import { notice, type OrgTab, orgTabChrome } from "../../../../apps/relay/src/orgs";
import { activityBlock, hubDown, liveRegion } from "../../../../apps/relay/src/overview";
import type { DeviceCode, MemberSession, Session, Snapshot } from "./api";

export type DashboardTab = OrgTab | "graph/full";
export type Route = { redirect: string } | { tab: DashboardTab } | { page: "device" | "not-found" };

const aliases: Record<string, string> = {
  overview: "",
  agents: "/sessions",
  devices: "/tokens",
  machines: "/tokens",
  settings: "/members",
  judge: "/members",
};

export function destination(raw: string | null): string {
  if (!raw?.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  const base = "https://relay.invalid";
  try {
    const url = new URL(raw, base);
    return url.origin === base && url.pathname.replace(/\/+$/, "") !== "/sign-in" ? url.pathname + url.search + url.hash : "/";
  } catch {
    return "/";
  }
}

export function route(pathname: string, s: MemberSession): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  const base = `/orgs/${s.org.handle}`;
  if (path === "/" || path === "/orgs" || path === "/sign-in") return { redirect: base };
  if (path === "/device") return { page: "device" };
  if (path === base) return { tab: "overview" };
  if (!path.startsWith(`${base}/`)) return { page: "not-found" };
  const tab = path.slice(base.length + 1);
  if (Object.hasOwn(aliases, tab)) return { redirect: base + aliases[tab] };
  if (["activity", "sessions", "graph", "graph/full", "tokens", "members"].includes(tab)) return { tab: tab as DashboardTab };
  return { page: "not-found" };
}

function page(s: Session, chrome: Omit<Chrome, "email" | "csrf">, body: Html): string {
  return layout({ ...chrome, email: s.signedIn ? s.member.name : null, csrf: s.csrf }, body);
}

export function tabBody(s: MemberSession, tab: OrgTab, data: Snapshot, now: number): Html {
  const g = data.graph ? identify(data.graph, identities(s.members.map((m) => ({ user_id: m.id, email: m.name })))) : null;
  switch (tab) {
    case "overview": {
      const side: Side = { devices: s.devices, tokens: s.tokens, holds: null };
      return overviewRegion(data.overview, g, side, s.org.handle, now);
    }
    case "activity":
      return data.overview ? activityBlock(data.overview.activity, now) : hubDown();
    case "sessions":
      return liveRegion(data.overview, s.org.handle, now);
    case "tokens":
      return html`${notice("Tokens and devices are managed with the scp-relay token CLI.")}`;
    case "members":
      return html`${notice("Members are managed with the scp-relay account CLI.")}`;
    case "graph":
      return graphTab({ org: s.org, role: s.member.role }, g);
  }
}

export function dashboardPage(s: MemberSession, tab: DashboardTab, data: Snapshot, now: number): string {
  const m = { org: s.org, role: s.member.role };
  const title = tab === "overview" ? s.org.name : `${s.org.name} ${tab === "graph/full" ? "graph" : tab}`;
  if (tab === "graph/full") {
    const g = data.graph ? identify(data.graph, identities(s.members.map((member) => ({ user_id: member.id, email: member.name })))) : null;
    return page(s, { title, bare: true, head: graphAssets() }, graphFull(s.org, g));
  }
  const body = tabBody(s, tab, data, now);
  if (tab === "graph") return page(s, { title, nav: "orgs", head: graphAssets() }, body);
  const live = tab === "overview" || tab === "activity" || tab === "sessions";
  const { body: content, ...chrome } = orgTabChrome(m, tab, body, { live });
  return page(s, { ...chrome, title }, content);
}

export function signInPage(s: Session, error = "", code?: Pick<DeviceCode, "user_code">): string {
  return page(
    s,
    { title: "Sign in", narrow: true },
    html`<p class="label">Self-hosted relay</p><h1>Sign in</h1>
      <p class="lead">Use a relay token or sign in with a device code.</p>
      ${notice(error, true)}
      <form class="form" data-sign-in method="post" action="/v1/dashboard/sign-in">
        <input type="hidden" name="csrf" value="${s.csrf}">
        <label class="field"><span>Token</span><input type="password" name="token" placeholder="scp_t_... or scp_d_..." required autofocus autocomplete="off"></label>
        <div class="acts"><button class="btn btn-primary" type="submit">Sign in</button></div>
      </form>
      <form class="form" data-device method="post" action="/v1/dashboard/device">
        <input type="hidden" name="csrf" value="${s.csrf}">
        <div class="acts"><button class="btn btn-ghost" type="submit"${code ? html` disabled` : ""}>Sign in with a device code</button></div>
      </form>
      ${code ? html`<section class="block"><h2>Approve this device</h2><p class="small">Run this command on the relay, replacing the account and member placeholders:</p><pre><code>scp-relay device approve ${code.user_code} --account &lt;handle&gt; --member &lt;name&gt;</code></pre><p class="mini" role="status">Waiting for approval.</p></section>` : ""}`,
  );
}

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export function devicePage(s: MemberSession, userCode = "<user_code>"): string {
  return page(
    s,
    { title: "Device", nav: "device", narrow: true },
    html`<p class="label">Device sign-in</p><h1>Approve a device</h1>
      <p class="lead">Approve the code shown on the device by running this command on the relay:</p>
      <pre><code>scp-relay device approve ${quote(userCode)} --account ${quote(s.org.handle)} --member ${quote(s.member.name)}</code></pre>
      <p class="small">Only approve a code for a device you recognize.</p>`,
  );
}

export function notFoundPage(s: Session): string {
  return page(s, { title: "Not found", narrow: true }, html`<h1>Not found</h1><p class="lead">This page does not exist.</p><a href="/">Return home</a>`);
}

export function errorPage(s: Session, message: string): string {
  return page(s, { title: "Dashboard unavailable", narrow: true }, html`<h1>Dashboard unavailable</h1>${notice(message, true)}<a href="">Reload</a>`);
}
