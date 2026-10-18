import { html } from "./html";
import { mailerFor } from "./mailer";
import { verifyTurnstile } from "./turnstile";
import { b64url, cookieName, hmac, HttpError, normalizeEmail, randomCode, randomId, safeEqual, safeNext, setCookie } from "./util";
import { back, type Ctx, endSession, field, page, readForm, startSession } from "./web";

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_TTL = 10 * 60_000;

/**
 * Eight characters of a 30-letter alphabet (about 2^39) for ten minutes, so the code needs no attempt counter:
 * Turnstile is the only throttle on the demo relay.
 */
function newCode(): string {
  return randomCode(CODE_ALPHABET, 8);
}

const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;
const normalizeCode = (raw: string): string => raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
const codeHash = (ctx: Ctx, email: string, code: string): Promise<string> => hmac(ctx.env.SESSION_SECRET, `code:${email}:${code}`);

interface Pending {
  email: string;
  next: string;
}

async function pendingCookie(ctx: Ctx, p: Pending, expiresAt: number): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify({ e: p.email, n: p.next, x: expiresAt })));
  return `${body}.${await hmac(ctx.env.SESSION_SECRET, `signin:${body}`)}`;
}

async function readPending(ctx: Ctx): Promise<Pending | null> {
  const raw = ctx.cookies.get(cookieName("scp_signin", ctx.secure));
  const [body, sig] = raw?.split(".") ?? [];
  if (!body || !sig || !safeEqual(sig, await hmac(ctx.env.SESSION_SECRET, `signin:${body}`))) return null;
  try {
    const v = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as { e: string; n: string; x: number };
    return v.x > ctx.now ? { email: v.e, next: safeNext(v.n) } : null;
  } catch {
    return null;
  }
}

function signInPage(ctx: Ctx, next: string, email = "", error = "", status = 200): Response {
  const head = html`<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
  return page(
    ctx,
    { title: "Sign in", head, narrow: true },
    html`<p class="label">Sign in or sign up</p>
      <h1>Sign in to the relay</h1>
      <p class="lead">Enter your email and we send you a one-time code. A new email creates an account.</p>
      ${error ? html`<p class="notice err" role="alert">${error}</p>` : ""}
      <form class="form" method="post" action="/sign-in">
        <input type="hidden" name="csrf" value="${ctx.csrf}">
        <input type="hidden" name="next" value="${next}">
        <label class="field"><span>Email</span><input type="email" name="email" value="${email}" autocomplete="email" required autofocus></label>
        <div class="cf-turnstile" data-sitekey="${ctx.env.TURNSTILE_SITE_KEY}"></div>
        <div class="acts"><button class="btn btn-primary" type="submit">Send code</button></div>
      </form>`,
    status,
  );
}

export async function getSignIn(ctx: Ctx): Promise<Response> {
  const next = safeNext(ctx.url.searchParams.get("next"));
  if (ctx.user) return back(ctx, next);
  return signInPage(ctx, next);
}

export async function postSignIn(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  const next = safeNext(field(form, "next"));
  let email: string;
  try {
    email = normalizeEmail(field(form, "email"));
  } catch (e) {
    return signInPage(ctx, next, field(form, "email"), (e as Error).message, 400);
  }
  const human = await verifyTurnstile(ctx.env.TURNSTILE_SECRET, field(form, "cf-turnstile-response"), ctx.req.headers.get("cf-connecting-ip"));
  if (!human) return signInPage(ctx, next, email, "The human check failed. Try again.", 400);

  const code = newCode();
  const expiresAt = ctx.now + CODE_TTL;
  await ctx.env.DB.prepare(
    "INSERT INTO email_codes (email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at, expires_at = excluded.expires_at",
  )
    .bind(email, await codeHash(ctx, email, code), ctx.now, expiresAt)
    .run();
  await mailerFor(ctx.env).send({
    to: email,
    subject: `Your scp sign-in code: ${formatCode(code)}`,
    text: `Your sign-in code for ${ctx.url.host} is\n\n    ${formatCode(code)}\n\nIt expires in 10 minutes. If you did not ask for it, ignore this email.\n`,
  });
  ctx.setCookies.push(setCookie(cookieName("scp_signin", ctx.secure), await pendingCookie(ctx, { email, next }, expiresAt), ctx.secure, CODE_TTL / 1000));
  return back(ctx, "/sign-in/code");
}

function codePage(ctx: Ctx, email: string, error = "", status = 200): Response {
  return page(
    ctx,
    { title: "Enter code", narrow: true },
    html`<p class="label">Check your email</p>
      <h1>Enter your code</h1>
      <p class="lead">We sent a code to <strong>${email}</strong>. It expires in 10 minutes.</p>
      ${error ? html`<p class="notice err" role="alert">${error}</p>` : ""}
      <form class="form" method="post" action="/sign-in/code">
        <input type="hidden" name="csrf" value="${ctx.csrf}">
        <label class="field"><span>Code</span><input class="code" type="text" name="code" autocomplete="one-time-code" inputmode="text" maxlength="12" required autofocus></label>
        <div class="acts"><button class="btn btn-primary" type="submit">Sign in</button><a class="btn btn-ghost" href="/sign-in">Use another email</a></div>
      </form>`,
    status,
  );
}

export async function getCode(ctx: Ctx): Promise<Response> {
  const pending = await readPending(ctx);
  if (!pending) return back(ctx, "/sign-in");
  return codePage(ctx, pending.email);
}

export async function postCode(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx);
  const pending = await readPending(ctx);
  if (!pending) return back(ctx, "/sign-in");
  const code = normalizeCode(field(form, "code"));
  const hash = await codeHash(ctx, pending.email, code);
  const used = await ctx.env.DB.prepare("DELETE FROM email_codes WHERE email = ? AND code_hash = ? AND expires_at > ? RETURNING email")
    .bind(pending.email, hash, ctx.now)
    .first();
  if (!used) return codePage(ctx, pending.email, "That code is wrong or has expired.", 400);

  await ctx.env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING")
    .bind(randomId("usr"), pending.email, ctx.now)
    .run();
  const user = await ctx.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(pending.email).first<{ id: string }>();
  if (!user) throw new HttpError(500, "internal", "Could not create the account.");
  await startSession(ctx, user.id);
  ctx.setCookies.push(setCookie(cookieName("scp_signin", ctx.secure), "", ctx.secure, 0));
  return back(ctx, pending.next);
}

export async function postSignOut(ctx: Ctx): Promise<Response> {
  await readForm(ctx);
  await endSession(ctx);
  return back(ctx, "/sign-in");
}
