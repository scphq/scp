import { authenticate } from "../credentials";
import type { Env } from "../env";
import { json } from "../util";
import { GRANT_HEADER, hubGrant, ORG_HEADER } from "./grant";

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
