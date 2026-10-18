import type { ActivityRow, EndpointView } from "@scp-dev/core";
import type { HoldView, HubGraph, MachineRow } from "@scp-dev/hub";
import { authenticate } from "../credentials";
import type { Env } from "../env";
import { json } from "../util";
import { GRANT_HEADER, hubGrant, ORG_HEADER } from "./grant";
import { JUDGE_HEADER } from "./judge";

const INTERNAL = "https://hub.internal";

export const hubStub = (env: Env, orgId: string): DurableObjectStub => env.HUB.get(env.HUB.idFromName(`hub:${orgId}`));

/** `/v1/relay/ws` and `/v1/relay/rpc`: authenticates the bearer and hands the request to its org's hub with the grant */
export async function hubRoute(req: Request, env: Env, path: "ws" | "rpc"): Promise<Response> {
  if (path === "ws" && req.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return json({ error: "upgrade_required", message: "The hub is a WebSocket." }, 426);
  if (path === "rpc" && req.method !== "POST") return json({ error: "method_not_allowed", message: "POST a JSON-RPC request." }, 405);
  const auth = await authenticate(env.DB, req.headers.get("authorization"));
  if (!auth.ok) return json({ error: auth.reason === "missing" ? "unauthorized" : auth.reason, message: "The bearer credential is not valid." }, 401);
  const headers = new Headers();
  for (const [name, value] of req.headers) if (!name.startsWith("x-scp-") && name !== "authorization" && name !== "cookie") headers.set(name, value);
  headers.set(GRANT_HEADER, JSON.stringify(hubGrant(auth.grant, Date.now())));
  headers.set(ORG_HEADER, auth.grant.org);
  headers.set(JUDGE_HEADER, (await judgeEnabled(env.DB, auth.grant.orgId)) ? "1" : "0");
  const stub = hubStub(env, auth.grant.orgId);
  if (path === "ws") return stub.fetch(`${INTERNAL}/ws`, { headers });
  return stub.fetch(`${INTERNAL}/rpc`, { method: "POST", headers, body: await req.arrayBuffer() });
}

/** closes the hub sockets of a revoked credential or of a member who left; best effort, revalidation is the backstop */
export async function closeGrants(env: Env, orgId: string, match: { tokenId: string } | { actorId: string }): Promise<void> {
  try {
    const res = await hubStub(env, orgId).fetch(`${INTERNAL}/grant/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(match),
    });
    await res.body?.cancel();
  } catch (e) {
    console.error("scp-relay hub revoke failed", e);
  }
}

export interface Overview {
  machines: MachineRow[];
  endpoints: EndpointView[];
  activity: ActivityRow[];
}

/** the org hub's machines, endpoints and latest activity for the dashboard; null when the hub does not answer */
export async function hubOverview(env: Env, orgId: string): Promise<Overview | null> {
  try {
    const res = await hubStub(env, orgId).fetch(`${INTERNAL}/overview`);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as Overview;
  } catch (e) {
    console.error("scp-relay hub overview failed", e);
    return null;
  }
}

/** the org hub's live graph: endpoints, spawn edges and message counts over the last `minutes`, no bodies; null when the hub does not answer */
export async function hubGraph(env: Env, orgId: string, minutes?: number): Promise<HubGraph | null> {
  try {
    const res = await hubStub(env, orgId).fetch(`${INTERNAL}/graph${minutes === undefined ? "" : `?minutes=${minutes}`}`);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as HubGraph;
  } catch (e) {
    console.error("scp-relay hub graph failed", e);
    return null;
  }
}

/** whether the org's owner turned the relay judge on; off when the column is missing too */
export async function judgeEnabled(db: D1Database, orgId: string): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT judge_enabled FROM orgs WHERE id = ?").bind(orgId).first<{ judge_enabled: number | null }>();
    return row?.judge_enabled === 1;
  } catch {
    return false;
  }
}

/** tells the org's hub the flag at once; best effort, the next hub request carries it too */
export async function hubJudge(env: Env, orgId: string, enabled: boolean): Promise<void> {
  try {
    const res = await hubStub(env, orgId).fetch(`${INTERNAL}/judge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    await res.body?.cancel();
  } catch (e) {
    console.error("scp-relay hub judge toggle failed", e);
  }
}

/** the org hub's waiting held messages, without bodies; null when the hub does not answer */
export async function hubHolds(env: Env, orgId: string): Promise<HoldView[] | null> {
  try {
    const res = await hubStub(env, orgId).fetch(`${INTERNAL}/holds?state=held`);
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return ((await res.json()) as { holds: HoldView[] }).holds;
  } catch (e) {
    console.error("scp-relay hub holds failed", e);
    return null;
  }
}

/** releases or refuses a held message; the hub's message when it refused the action */
export async function hubHold(
  env: Env,
  orgId: string,
  action: "release" | "refuse",
  body: { id: string; by: string; reason?: string },
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const res = await hubStub(env, orgId).fetch(`${INTERNAL}/holds/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    await res.body?.cancel();
    return { ok: true };
  }
  const failed = (await res.json().catch(() => null)) as { message?: string } | null;
  return { ok: false, status: res.status, message: failed?.message ?? "The hub refused that." };
}
