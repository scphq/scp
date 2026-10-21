import "./build";
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { DeviceCode, MemberSession, Session, Snapshot } from "../src/browser/api";

type Tab = "overview" | "activity" | "sessions" | "graph" | "graph/full" | "tokens" | "members";
type Markup = { value: string };
type Member = { org: { handle: string; name: string }; role: "owner" | "admin" | "member" };

const pagesPath = "../src/browser/pages";
const {
  dashboardPage,
  signInPage,
  devicePage,
  notFoundPage,
  errorPage,
  route,
  destination,
}: {
  dashboardPage(s: MemberSession, tab: Tab, data: Snapshot, now: number): string;
  signInPage(s: Session, error?: string, code?: Pick<DeviceCode, "user_code">): string;
  devicePage(s: MemberSession, userCode?: string): string;
  notFoundPage(s: Session): string;
  errorPage(s: Session, message: string): string;
  route(path: string, s: MemberSession): { redirect: string } | { tab: Tab } | { page: "device" | "not-found" };
  destination(raw: string | null): string;
} = await import(pagesPath);

const htmlPath = "../../../apps/relay/src/html";
const {
  html,
  layout,
  CSS,
  stamp,
}: {
  html(strings: TemplateStringsArray, ...values: unknown[]): Markup;
  layout(chrome: { title: string; email: string | null; csrf: string; nav: "orgs"; head: Markup; bare?: boolean }, body: Markup): string;
  CSS: string;
  stamp(text: string): string;
} = await import(htmlPath);
const orgsPath = "../../../apps/relay/src/orgs";
const {
  orgTabChrome,
  orgHeader,
}: {
  orgTabChrome(m: Member, tab: "overview", body: Markup, opts?: { live?: boolean }): { head: Markup; body: Markup; nav: "orgs" };
  orgHeader(m: Member, tab: "overview"): Markup;
} = await import(orgsPath);
const graphPath = "../../../apps/relay/src/graph";
const {
  graphTab,
  graphFull,
  graphAssets,
}: {
  graphTab(m: Member, g: unknown): Markup;
  graphFull(org: Member["org"], g: unknown): Markup;
  graphAssets(): Markup;
} = await import(graphPath);
const overviewPath = "../../../apps/relay/src/overview";
const { APP_JS, REFRESH_MS }: { APP_JS: string; REFRESH_MS: number } = await import(overviewPath);

const hostile = "<img src=x onerror=alert(1)>";
const now = Date.parse("2026-10-01T12:00:00Z");
const session: MemberSession = {
  signedIn: true,
  csrf: 'csrf<&"',
  org: { handle: "acme", name: hostile },
  member: { id: "member_1", name: "sam", role: "owner" },
  members: [{ id: "member_1", name: "sam" }],
  devices: 2,
  tokens: 3,
};
const endpoint = {
  id: "ep_1",
  address: "acme/box/lead",
  kind: "agent" as const,
  harness: "codex",
  model: null,
  cwd: null,
  labels: { machine: "box" },
  title: hostile,
  presence: "online" as const,
  status: null,
  last_seen: "2026-10-01T11:59:59Z",
  parent: null,
};
const machine = { name: "box", kind: "bridge", online: true, bridge: true, created_at: null, last_seen: null };
const snapshot: Snapshot = {
  overview: {
    machines: [machine],
    endpoints: [endpoint],
    activity: [{ id: 1, at: endpoint.last_seen, endpoint: endpoint.address, kind: "stop", tool: null, summary: hostile, agent: null }],
  },
  graph: { minutes: 15, machines: [{ ...machine, actor: "member_1" }], nodes: [endpoint], edges: [] },
};

for (const tab of ["overview", "activity", "sessions", "graph", "graph/full"] as const) {
  test(`${tab} reuses the hosted live markup and escapes titles`, () => {
    const output = dashboardPage(session, tab, snapshot, now);
    expect(output).toContain(`data-live="${REFRESH_MS}"`);
    expect(output).toContain('data-events="/orgs/acme/events"');
    expect(output).toContain("lead");
    expect(output).not.toContain(hostile);
    expect(output).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(output).not.toContain("member_1");
    if (tab !== "graph/full") {
      expect(output).toContain('aria-label="Organization"');
      expect(output).toContain('href="/orgs/acme/sessions"');
      const current = tab === "overview" ? "/orgs/acme" : `/orgs/acme/${tab}`;
      expect(output).toContain(`href="${current}" aria-current="page"`);
    } else {
      expect(output).toContain('<body class="bare">');
      expect(output).not.toContain('aria-label="Organization"');
    }
    if (tab.startsWith("graph")) {
      expect(output.indexOf('src="/app.js?')).toBeLessThan(output.indexOf('src="/graph.js?'));
      const block = output.match(/data-graph-data>(.*?)<\/script>/s)![1]!;
      const graph = JSON.parse(block);
      expect(graph.nodes[0].title).toBe(hostile);
      expect(graph.machines[0].identity.name).toBe("sam");
      expect(block).not.toContain("<img");
      expect(block).not.toContain('"actor"');
    }
  });
}

test("overview uses session credential counts without a judge panel", () => {
  const output = dashboardPage(session, "overview", snapshot, now);
  expect(output).toContain("2 devices and 3 API tokens signed in.");
  expect(output).not.toContain("held by the relay judge");
});

for (const [tab, command] of [
  ["tokens", "scp-relay token"],
  ["members", "scp-relay account"],
] as const) {
  test(`${tab} keeps the hosted chrome and points to the CLI`, () => {
    const output = dashboardPage(session, tab, snapshot, now);
    expect(output).toContain(`href="/orgs/acme/${tab}" aria-current="page"`);
    expect(output).toContain(command);
    expect(output).toContain('class="notice" role="status"');
    expect(output).not.toContain("data-live");
    expect(output).not.toContain(hostile);
    expect(output).toContain('action="/sign-out"');
    expect(output).toContain("Signed in as sam");
  });
}

test("unavailable live data keeps the hosted retry notices", () => {
  for (const tab of ["overview", "activity", "sessions", "graph", "graph/full"] as const) {
    const output = dashboardPage(session, tab, { overview: null, graph: null }, now);
    expect(output).toContain("The hub did not answer.");
    expect(output).toContain("data-live");
  }
});

test("sign-in uses narrow hosted layout, token and device forms, and escaped messages", () => {
  const output = signInPage({ signedIn: false, csrf: session.csrf }, hostile, { user_code: hostile });
  expect(output).toContain("<body>");
  expect(output).not.toContain('<body class="wide">');
  expect(output).toContain('type="password" name="token"');
  expect(output).toContain("Sign in with a device code");
  expect(output).toContain('action="/v1/dashboard/sign-in"');
  expect(output).toContain('action="/v1/dashboard/device"');
  expect(output).toContain("scp-relay device approve &lt;img src=x onerror=alert(1)&gt; --account &lt;handle&gt; --member &lt;name&gt;");
  expect(output).toContain('value="csrf&lt;&amp;&quot;"');
  expect(output).not.toContain(hostile);
  expect(output).not.toContain("device_code");
});

test("device and fallback pages escape external data", () => {
  const output = devicePage({ ...session, member: { ...session.member, name: "sam's laptop" } }, hostile);
  expect(output).toContain("scp-relay device approve");
  expect(output).toContain("--account &#39;acme&#39; --member &#39;sam&#39;\\&#39;&#39;s laptop&#39;");
  expect(output).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(output).not.toContain(hostile);
  expect(output).toContain('href="/device" aria-current="page"');
  expect(notFoundPage(session)).toContain("This page does not exist.");
  expect(errorPage(session, hostile)).not.toContain(hostile);
});

test("routes redirect roots and hosted aliases and reject foreign accounts and unknown tabs", () => {
  for (const path of ["/", "/orgs", "/orgs/", "/sign-in"]) expect(route(path, session)).toEqual({ redirect: "/orgs/acme" });
  for (const [alias, path] of Object.entries({
    overview: "",
    agents: "/sessions",
    devices: "/tokens",
    machines: "/tokens",
    settings: "/members",
    judge: "/members",
  })) {
    expect(route(`/orgs/acme/${alias}`, session)).toEqual({ redirect: `/orgs/acme${path}` });
  }
  expect(route("/orgs/acme/", session)).toEqual({ tab: "overview" });
  for (const tab of ["activity", "sessions", "graph", "graph/full", "tokens", "members"] as const) expect(route(`/orgs/acme/${tab}`, session)).toEqual({ tab });
  expect(route("/device", session)).toEqual({ page: "device" });
  for (const path of ["/orgs/other", "/orgs/acme2", "/orgs/acme/graph/other", "/orgs/acme/toString", "/orgs/acme/missing"])
    expect(route(path, session)).toEqual({ page: "not-found" });
});

test("post-sign-in destinations stay local", () => {
  expect(destination("/orgs/acme/graph?minutes=5#focus")).toBe("/orgs/acme/graph?minutes=5#focus");
  for (const raw of [
    null,
    "",
    "//",
    "///",
    "https://other.invalid",
    "//other.invalid/",
    "/\\other.invalid",
    "/\n/other.invalid",
    "/sign-in",
    "/sign-in/?next=/sign-in",
  ])
    expect(destination(raw)).toBe("/");
});

test("orgTabChrome preserves the original head and region markup", () => {
  const m: Member = { org: session.org, role: session.member.role };
  const content = html`<p>${hostile}</p>`;
  const app = html`<script src="/app.js?v=${stamp(APP_JS)}" defer></script>`;
  for (const live of [false, true]) {
    const chrome = orgTabChrome(m, "overview", content, { live });
    expect(chrome.nav).toBe("orgs");
    expect(chrome.head.value).toBe(
      live ? html`${app}<noscript><meta http-equiv="refresh" content="${Math.round(REFRESH_MS / 1000)}"></noscript>`.value : app.value,
    );
    const region = live
      ? html`<div class="tab-body" data-live="${REFRESH_MS}" data-events="/orgs/${m.org.handle}/events">${content}</div>`
      : html`<div class="tab-body">${content}</div>`;
    expect(chrome.body.value).toBe(html`${orgHeader(m, "overview")}${region}`.value);
  }
});

test("graph page builders use the factored tab and full-window bodies", () => {
  const data: Snapshot = { overview: null, graph: null };
  const m: Member = { org: session.org, role: session.member.role };
  for (const tab of ["graph", "graph/full"] as const) {
    const chrome = { title: `${session.org.name} graph`, email: session.member.name, csrf: session.csrf, nav: "orgs" as const, head: graphAssets() };
    const expected = tab === "graph" ? layout(chrome, graphTab(m, null)) : layout({ ...chrome, bare: true }, graphFull(session.org, null));
    expect(dashboardPage(session, tab, data, now)).toBe(expected);
  }
  expect(new Bun.CryptoHasher("sha256").update(graphTab(m, null).value).digest("hex")).toBe("d96a05a53939f7b41e453ec835cca0a45d1633ae20f61c30647800181d64f613");
});

for (const mode of ["hook", "fallback", "null", "throw"] as const) {
  test(`live refresh preserves details and scheduling with ${mode}`, async () => {
    const timers: { callback: () => Promise<void>; delay: number }[] = [];
    let hooks = 0;
    let fetches = 0;
    let replacements = 0;
    const children = [{}];
    const detail = { open: false, getAttribute: () => "box" };
    const selectors: string[] = [];
    const next = {
      childNodes: children,
      querySelectorAll(selector: string) {
        selectors.push(selector);
        return selector === "details[data-key]" ? [detail] : [];
      },
    };
    const live = {
      getAttribute: (name: string) => (name === "data-live" ? String(REFRESH_MS) : null),
      querySelectorAll: () => [{ getAttribute: () => "box" }],
      replaceChildren(...nodes: unknown[]) {
        replacements++;
        expect(nodes).toEqual(children);
      },
    };
    const hook = async () => {
      hooks++;
      if (mode === "throw") throw new Error("unavailable");
      return mode === "null" ? null : next;
    };
    runInNewContext(APP_JS, {
      document: {
        hidden: false,
        addEventListener() {},
        querySelector: (selector: string) => (selector === "[data-live]" ? live : null),
        documentElement: { getAttribute: () => "open" },
      },
      window: { getSelection: () => "", ...(mode === "fallback" ? {} : { scpRegion: hook }) },
      location: { href: "/orgs/acme" },
      fetch: async (url: string, init: RequestInit) => {
        fetches++;
        expect(url).toBe("/orgs/acme");
        expect(init).toEqual({ credentials: "same-origin", headers: { accept: "text/html" } });
        return { ok: true, text: async () => "markup" };
      },
      DOMParser: class {
        parseFromString() {
          return { querySelector: () => next };
        }
      },
      clearTimeout() {},
      setTimeout(callback: () => Promise<void>, delay: number) {
        timers.push({ callback, delay });
        return timers.length;
      },
    });
    expect(timers[0]!.delay).toBe(REFRESH_MS);
    await timers[0]!.callback();
    expect(hooks).toBe(mode === "fallback" ? 0 : 1);
    expect(fetches).toBe(mode === "fallback" ? 1 : 0);
    expect(replacements).toBe(mode === "hook" || mode === "fallback" ? 1 : 0);
    expect(detail.open).toBe(mode === "hook" || mode === "fallback");
    if (replacements) expect(selectors).toContain("[data-tree]");
    expect(timers[1]!.delay).toBe(REFRESH_MS * 4);
  });
}

test("dashboard assets build with the shared renderers", async () => {
  const shell = await Bun.file(new URL("../dist/public/index.html", import.meta.url)).text();
  expect(shell).toContain(`/app.css?v=${stamp(CSS)}`);
  expect(shell).toMatch(/<script src="\/selfhost.js\?v=[a-z0-9]+" defer><\/script>/);
  expect(shell).toContain("<body></body>");
  expect(shell).not.toContain("<style");
});

test("the browser bundle initializes with no Worker or server globals", async () => {
  const script = await Bun.file(new URL("../dist/public/selfhost.js", import.meta.url)).text();
  expect(script).not.toContain("cloudflare:");
  expect(script).not.toContain("sourceMappingURL");
  const requests: string[] = [];
  const redirects: string[] = [];
  runInNewContext(script, {
    document: { addEventListener() {} },
    location: { pathname: "/", replace: (path: string) => redirects.push(path) },
    fetch: async (path: string) => {
      requests.push(path);
      return { ok: true, json: async () => session };
    },
  });
  await Bun.sleep(0);
  expect(requests).toEqual(["/v1/dashboard/session"]);
  expect(redirects).toEqual(["/orgs/acme"]);
});
