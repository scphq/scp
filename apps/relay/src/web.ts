import type { Env, User } from "./env";
import { type Html, layout, type Chrome } from "./html";
import { cookieName, DAY, hmac, HttpError, parseCookies, randomSecret, redirect, safeEqual, setCookie, sha256 } from "./util";

const SESSION_TTL = 30 * DAY;

export interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  secure: boolean;
  now: number;
  cookies: Map<string, string>;
  user: User | null;
  sessionHash: string | null;
  /** what the CSRF token is bound to: the session, else a pre-session nonce cookie */
  binding: string;
  csrf: string;
  setCookies: string[];
}

export async function loadCtx(req: Request, env: Env): Promise<Ctx> {
  if (!env.SESSION_SECRET) throw new HttpError(500, "unconfigured", "SESSION_SECRET is not set.");
  const url = new URL(req.url);
  const secure = url.protocol === "https:";
  const cookies = parseCookies(req.headers.get("cookie"));
  const ctx: Ctx = { req, env, url, secure, now: Date.now(), cookies, user: null, sessionHash: null, binding: "", csrf: "", setCookies: [] };
  const raw = cookies.get(cookieName("scp_session", secure));
  if (raw) {
    const idHash = await sha256(raw);
    const row = await env.DB.prepare("SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ?")
      .bind(idHash, ctx.now)
      .first<User>();
    if (row) {
      ctx.user = row;
      ctx.sessionHash = idHash;
      ctx.binding = `s:${idHash}`;
    }
  }
  if (!ctx.user) {
    const preName = cookieName("scp_pre", secure);
    let pre = cookies.get(preName);
    if (!pre || pre.length > 64) {
      pre = randomSecret();
      ctx.setCookies.push(setCookie(preName, pre, secure, 400 * 86_400));
    }
    ctx.binding = `p:${pre}`;
  }
  ctx.csrf = await csrfToken(ctx);
  return ctx;
}

export function csrfToken(ctx: Ctx): Promise<string> {
  return hmac(ctx.env.SESSION_SECRET, `csrf:${ctx.binding}`);
}

/** a cross-site POST carries a foreign Origin; one without Origin must at least be same-origin by Fetch Metadata */
export function checkOrigin(ctx: Ctx): void {
  const origin = ctx.req.headers.get("origin");
  if (origin && origin !== "null") {
    if (origin !== ctx.url.origin) throw new HttpError(403, "bad_origin", "This request came from another site.");
    return;
  }
  if (ctx.req.headers.get("sec-fetch-site") !== "same-origin") throw new HttpError(403, "bad_origin", "This request came from another site.");
}

export function checkCsrf(ctx: Ctx, token: string | null): void {
  if (!token || !safeEqual(token, ctx.csrf)) throw new HttpError(403, "bad_csrf", "This form expired. Reload the page and try again.");
}

/** Origin and CSRF checks for a dashboard form POST, then its fields */
export async function readForm(ctx: Ctx): Promise<FormData> {
  checkOrigin(ctx);
  const type = ctx.req.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data"))
    throw new HttpError(415, "bad_content_type", "Expected a form.");
  const form = await ctx.req.formData();
  const csrf = form.get("csrf");
  checkCsrf(ctx, typeof csrf === "string" ? csrf : null);
  return form;
}

export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

export async function startSession(ctx: Ctx, userId: string): Promise<void> {
  const raw = randomSecret();
  await ctx.env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(raw), userId, ctx.now, ctx.now + SESSION_TTL)
    .run();
  ctx.setCookies.push(setCookie(cookieName("scp_session", ctx.secure), raw, ctx.secure, SESSION_TTL / 1000));
}

export async function endSession(ctx: Ctx): Promise<void> {
  if (ctx.sessionHash) await ctx.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(ctx.sessionHash).run();
  ctx.setCookies.push(setCookie(cookieName("scp_session", ctx.secure), "", ctx.secure, 0));
}

export function requireUser(ctx: Ctx): User {
  if (!ctx.user) throw new HttpError(401, "signed_out", "Sign in first.");
  return ctx.user;
}

/** the sign-in redirect for a page that needs a session */
export function toSignIn(ctx: Ctx): Response {
  return redirect(`/sign-in?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`, ctx.setCookies);
}

const CSP = [
  "default-src 'none'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "connect-src 'self' https://challenges.cloudflare.com",
  "img-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export function page(ctx: Ctx, chrome: Omit<Chrome, "email" | "csrf">, body: Html, status = 200): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  for (const c of ctx.setCookies) headers.append("set-cookie", c);
  const text = layout({ ...chrome, email: ctx.user?.email ?? null, csrf: ctx.csrf }, body);
  return new Response(text, { status, headers });
}

export function back(ctx: Ctx, location: string): Response {
  return redirect(location, ctx.setCookies);
}
