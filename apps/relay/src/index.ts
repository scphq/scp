import { api } from "./api";
import { getCode, getSignIn, postCode, postSignIn, postSignOut } from "./auth";
import { deviceCode, devicePage, devicePost, deviceToken } from "./device";
import type { Env } from "./env";
import { hubRoute } from "./hub/routes";
import { CSS, html, layout } from "./html";
import { acceptPost, invitePage, orgPage, orgsPage, orgsPost } from "./orgs";
import { tokensPage, tokensPost } from "./tokens";
import { DAY, HttpError, json } from "./util";
import { back, type Ctx, loadCtx, toSignIn } from "./web";

export { OrgHub } from "./hub/object";

async function pages(ctx: Ctx): Promise<Response> {
  const { req, url, user } = ctx;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const post = req.method === "POST";
  if (!post && req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method_not_allowed", "Method not allowed.");

  if (path === "/") return back(ctx, user ? "/orgs" : "/sign-in");
  if (path === "/sign-in") return post ? postSignIn(ctx) : getSignIn(ctx);
  if (path === "/sign-in/code") return post ? postCode(ctx) : getCode(ctx);
  if (path === "/sign-out" && post) return postSignOut(ctx);

  const signedIn = path === "/orgs" || path.startsWith("/orgs/") || path === "/device" || path.startsWith("/invites/");
  if (!signedIn) throw new HttpError(404, "not_found", "Not found.");
  if (!user) {
    if (post) throw new HttpError(401, "signed_out", "Your session ended. Sign in again.");
    return toSignIn(ctx);
  }

  if (path === "/device") return post ? devicePost(ctx, user.id) : devicePage(ctx, user.id);
  if (path === "/invites/accept" && post) return acceptPost(ctx, user);
  const invite = /^\/invites\/([A-Za-z0-9_-]{20,64})$/.exec(path);
  if (invite && !post) return invitePage(ctx, user, invite[1]!);

  const rest = path.split("/").filter(Boolean).slice(1);
  if (!post) {
    if (rest.length === 0) return orgsPage(ctx, user);
    if (rest.length === 1) return orgPage(ctx, user, rest[0]!);
    if (rest.length === 2 && rest[1] === "tokens") return tokensPage(ctx, user, rest[0]!);
    throw new HttpError(404, "not_found", "Not found.");
  }
  if (rest[1] === "tokens" || rest[1] === "devices") return tokensPost(ctx, user, rest[0]!, rest.slice(1));
  return orgsPost(ctx, user, rest);
}

function failure(e: unknown, url: URL): Response {
  const known = e instanceof HttpError;
  if (!known) console.error("scp-relay error", e);
  const status = known ? e.status : 500;
  const code = known ? e.code : "internal";
  const message = known ? e.message : "Something went wrong.";
  if (url.pathname.startsWith("/v1/")) return json({ error: code, message }, status);
  const body = html`<p class="label">Error ${status}</p><h1>${status === 404 ? "Not found" : "Something is off"}</h1><p class="lead">${message}</p><p class="small"><a href="/">Back to the relay</a></p>`;
  return new Response(layout({ title: "Error", email: null, csrf: "" }, body), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return json({ ok: true, service: "scp-relay" });
      if (url.pathname === "/app.css")
        return new Response(CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" } });
      if (url.pathname === "/v1/device/code" && req.method === "POST") return await deviceCode(req, env.DB, url.origin, Date.now());
      if (url.pathname === "/v1/device/token" && req.method === "POST") return await deviceToken(req, env.DB, url.origin, Date.now());
      if (url.pathname === "/v1/relay/ws") return await hubRoute(req, env, "ws");
      if (url.pathname === "/v1/relay/rpc") return await hubRoute(req, env, "rpc");
      if (url.pathname.startsWith("/v1/")) return await api(req, env, url);
      return await pages(await loadCtx(req, env));
    } catch (e) {
      return failure(e, url);
    }
  },

  /** drops expired sign-in state; a hygiene sweep, not a limit */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM email_codes WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(now - DAY),
    ]);
  },
} satisfies ExportedHandler<Env>;
