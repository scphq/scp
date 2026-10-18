import { authenticate } from "./credentials";
import type { Env, User } from "./env";
import { acceptInvite, createInvite, createOrg, listInvites, listMembers, listOrgs, type Membership, requireMember } from "./orgs";
import { HttpError, json, readJson, str } from "./util";
import { checkCsrf, checkOrigin, loadCtx } from "./web";

/** a signed-in browser, or a device credential limited to its own org; API tokens cannot manage the org */
interface Actor {
  user: User;
  orgId: string | null;
}

async function actorOf(req: Request, env: Env): Promise<Actor> {
  const header = req.headers.get("authorization");
  if (header !== null) {
    const auth = await authenticate(env.DB, header);
    if (!auth.ok) throw new HttpError(401, auth.reason === "missing" ? "unauthorized" : auth.reason, "The bearer credential is not valid.");
    if (auth.grant.kind === "token") throw new HttpError(403, "forbidden", "API tokens join the hub; manage the org from the dashboard or a device login.");
    return { user: { id: auth.grant.userId, email: auth.grant.email }, orgId: auth.grant.orgId };
  }
  const ctx = await loadCtx(req, env);
  if (!ctx.user) throw new HttpError(401, "unauthorized", "Sign in or send a bearer credential.");
  if (req.method !== "GET" && req.method !== "HEAD") {
    checkOrigin(ctx);
    checkCsrf(ctx, req.headers.get("x-csrf-token"));
  }
  return { user: ctx.user, orgId: null };
}

async function member(env: Env, actor: Actor, handle: string): Promise<Membership> {
  const m = await requireMember(env.DB, handle, actor.user.id);
  if (actor.orgId && actor.orgId !== m.org.id) throw new HttpError(404, "not_found", "No such organization.");
  return m;
}

function sessionOnly(actor: Actor): void {
  if (actor.orgId) throw new HttpError(403, "forbidden", "This needs a signed-in browser session.");
}

/** `GET /v1/whoami`: what a bearer is, for `scp login --token` and the hub */
async function whoami(req: Request, env: Env): Promise<Response> {
  const auth = await authenticate(env.DB, req.headers.get("authorization"));
  if (!auth.ok) return json({ error: auth.reason === "missing" ? "unauthorized" : auth.reason }, 401);
  const g = auth.grant;
  return json({
    kind: g.kind,
    org: g.org,
    email: g.email,
    role: g.role,
    label: g.label,
    ambient: g.ambient,
    endpoint_labels: g.endpointLabels,
    expires_at: g.expiresAt,
  });
}

export async function api(req: Request, env: Env, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  const method = req.method;
  const now = Date.now();
  if (parts[0] === "whoami" && parts.length === 1 && method === "GET") return whoami(req, env);

  const actor = await actorOf(req, env);
  if (parts[0] === "orgs" && parts.length === 1) {
    if (method === "GET") {
      const orgs = await listOrgs(env.DB, actor.user.id);
      return json({
        orgs: orgs.filter((o) => !actor.orgId || o.id === actor.orgId).map(({ handle, name, role, members }) => ({ handle, name, role, members })),
      });
    }
    if (method === "POST") {
      sessionOnly(actor);
      const body = await readJson(req);
      const org = await createOrg(env.DB, actor.user, str(body.handle), str(body.name), now);
      return json({ handle: org.handle, name: org.name, role: "owner" }, 201);
    }
  }
  if (parts[0] === "invites" && parts.length === 3 && parts[2] === "accept" && method === "POST") {
    sessionOnly(actor);
    const org = await acceptInvite(env.DB, actor.user, { id: parts[1]! }, now);
    return json({ org: org.handle });
  }
  if (parts[0] === "orgs" && parts.length >= 3) {
    const m = await member(env, actor, parts[1]!);
    const [, , kind, id] = parts;
    if (kind === "members" && !id && method === "GET") {
      const members = await listMembers(env.DB, m.org.id);
      return json({ members: members.map(({ email, role, created_at }) => ({ email, role, joined_at: created_at })) });
    }
    if (kind === "invites" && !id && method === "GET") {
      if (m.role === "member") throw new HttpError(403, "forbidden", "Only owners and admins can list invites.");
      return json({ invites: await listInvites(env.DB, m.org.id, now) });
    }
    if (kind === "invites" && !id && method === "POST") {
      const body = await readJson(req);
      return json(await createInvite(env, url.origin, m, actor.user, str(body.email), str(body.role), now), 201);
    }
  }
  throw new HttpError(404, "not_found", "Not found.");
}
