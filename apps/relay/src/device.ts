import { DEVICE_PREFIX, mint } from "./credentials";
import { html } from "./html";
import { listOrgs, notice, requireMember } from "./orgs";
import { HttpError, json, randomCode, randomId, randomSecret, readJson, sha256 } from "./util";
import { type Ctx, field, page, readForm } from "./web";

const USER_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const DEVICE_TTL = 15 * 60_000;
const INTERVAL_S = 5;
export const MACHINE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;
const normalizeUserCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z]/g, "");

/** POST /v1/device/code: starts a login for `swarm login` */
export async function deviceCode(req: Request, db: D1Database, origin: string, now: number): Promise<Response> {
  const input = await readJson(req);
  const label = typeof input.label === "string" && input.label ? input.label : "cli";
  if (!MACHINE.test(label))
    throw new HttpError(400, "invalid_request", "label is a machine name: lowercase letters, digits and hyphens, at most 32 characters.");
  const deviceCode = randomSecret();
  for (let attempt = 0; ; attempt++) {
    const userCode = randomCode(USER_ALPHABET, 8);
    try {
      await db
        .prepare("INSERT INTO device_codes (device_code_hash, user_code, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(await sha256(deviceCode), userCode, label, now, now + DEVICE_TTL)
        .run();
    } catch (e) {
      if (attempt < 3 && String(e).includes("UNIQUE")) continue;
      throw e;
    }
    const shown = formatUserCode(userCode);
    return json({
      device_code: deviceCode,
      user_code: shown,
      verification_uri: `${origin}/device`,
      verification_uri_complete: `${origin}/device?code=${shown}`,
      expires_in: DEVICE_TTL / 1000,
      interval: INTERVAL_S,
    });
  }
}

interface CodeRow {
  label: string;
  expires_at: number;
  approved_at: number | null;
  denied_at: number | null;
  credential_id: string | null;
}

/** POST /v1/device/token: the CLI polls until the code is approved, then receives its credential once */
export async function deviceToken(req: Request, db: D1Database, origin: string, now: number): Promise<Response> {
  const input = await readJson(req);
  const raw = typeof input.device_code === "string" ? input.device_code : "";
  const hash = await sha256(raw);
  const row = raw
    ? await db
        .prepare("SELECT label, expires_at, approved_at, denied_at, credential_id FROM device_codes WHERE device_code_hash = ?")
        .bind(hash)
        .first<CodeRow>()
    : null;
  const fail = (error: string, description: string) => json({ error, error_description: description }, 400);
  if (!row || row.credential_id) return fail("invalid_grant", "Unknown or already used device code.");
  if (row.denied_at) return fail("access_denied", "The login was denied.");
  if (row.expires_at <= now) return fail("expired_token", "The device code expired. Run swarm up again.");
  if (!row.approved_at) return fail("authorization_pending", "Waiting for approval in the browser.");

  const cred = await mint(DEVICE_PREFIX);
  const id = randomId("dvc");
  const [claim, insert] = await db.batch([
    db
      .prepare(
        "UPDATE device_codes SET credential_id = ? WHERE device_code_hash = ? AND approved_at IS NOT NULL AND denied_at IS NULL AND credential_id IS NULL AND expires_at > ?",
      )
      .bind(id, hash, now),
    db
      .prepare(
        "INSERT INTO device_credentials (id, token_hash, prefix, last4, user_id, org_id, label, created_at) SELECT ?, ?, ?, ?, d.approved_by, d.org_id, d.label, ? FROM device_codes d JOIN memberships m ON m.org_id = d.org_id AND m.user_id = d.approved_by WHERE d.device_code_hash = ? AND d.credential_id = ?",
      )
      .bind(id, cred.hash, cred.prefix, cred.last4, now, hash, id),
  ]);
  if (!claim?.meta.changes) return fail("invalid_grant", "Unknown or already used device code.");
  if (!insert?.meta.changes) return fail("access_denied", "The approving account is no longer a member of the organization.");
  const who = await db
    .prepare("SELECT u.email, o.handle FROM device_credentials c JOIN users u ON u.id = c.user_id JOIN orgs o ON o.id = c.org_id WHERE c.id = ?")
    .bind(id)
    .first<{ email: string; handle: string }>();
  return json({ access_token: cred.secret, token_type: "Bearer", credential_id: id, org: who?.handle, email: who?.email, label: row.label, relay: origin });
}

// pages

async function pendingByUserCode(db: D1Database, code: string, now: number) {
  const row = await db.prepare("SELECT label, expires_at, approved_at, denied_at FROM device_codes WHERE user_code = ?").bind(code).first<CodeRow>();
  if (!row || row.expires_at <= now) throw new HttpError(404, "not_found", "That code is unknown or has expired. Run swarm up again.");
  if (row.approved_at || row.denied_at) throw new HttpError(409, "decided", "That code was already used.");
  return row;
}

export async function devicePage(ctx: Ctx, userId: string, error = "", status = 200, raw = ctx.url.searchParams.get("code") ?? ""): Promise<Response> {
  const code = normalizeUserCode(raw);
  const head = html`<p class="label">Device login</p>`;
  const entry = (message: string, st: number) =>
    page(
      ctx,
      { title: "Device login", nav: "device" },
      html`${head}<h1>Connect a terminal</h1>
        <p class="lead">Enter the code that <code>swarm up</code> printed.</p>
        ${notice(message, true)}
        <form class="form" method="get" action="/device">
          <label class="field"><span>Code</span><input class="code" type="text" name="code" value="${code ? formatUserCode(code) : ""}" placeholder="BCDF-GHJK" maxlength="9" autocomplete="off" required autofocus></label>
          <div class="acts"><button class="btn btn-primary" type="submit">Continue</button></div>
        </form>`,
      st,
    );
  if (!code || error) return entry(error, status);
  let row: CodeRow;
  try {
    row = await pendingByUserCode(ctx.env.DB, code, ctx.now);
  } catch (e) {
    if (e instanceof HttpError) return entry(e.message, e.status);
    throw e;
  }
  const orgs = await listOrgs(ctx.env.DB, userId);
  return page(
    ctx,
    { title: "Approve device", nav: "device" },
    html`${head}<h1>Approve this login?</h1>
      <p class="usercode">${formatUserCode(code)}</p>
      <p class="lead">Machine <code>${row.label}</code> asks to join an organization's hub as you. Approve only if you just ran <code>swarm up</code> and this code matches your terminal.</p>
      ${
        orgs.length
          ? html`<form class="form" method="post" action="/device">
            <input type="hidden" name="csrf" value="${ctx.csrf}">
            <input type="hidden" name="code" value="${code}">
            ${
              orgs.length === 1
                ? html`<input type="hidden" name="org" value="${orgs[0]!.handle}"><p>Organization <strong>${orgs[0]!.name}</strong> (${orgs[0]!.handle})</p>`
                : html`<label class="field"><span>Organization</span><select name="org">${orgs.map((o) => html`<option value="${o.handle}">${o.name} (${o.handle})</option>`)}</select></label>`
            }
            <div class="acts"><button class="btn btn-primary" type="submit" name="action" value="approve">Approve</button><button class="btn btn-ghost" type="submit" name="action" value="deny">Deny</button></div>
          </form>`
          : html`<p class="empty">You are not in an organization yet. <a href="/orgs">Create one</a>, then reload this page.</p>`
      }`,
  );
}

export async function devicePost(ctx: Ctx, userId: string): Promise<Response> {
  const form = await readForm(ctx);
  const code = normalizeUserCode(field(form, "code"));
  const action = field(form, "action");
  const done = (title: string, text: string) =>
    page(ctx, { title, nav: "device" }, html`<p class="label">Device login</p><h1>${title}</h1><p class="lead">${text}</p>`);
  try {
    await pendingByUserCode(ctx.env.DB, code, ctx.now);
    if (action === "deny") {
      await ctx.env.DB.prepare("UPDATE device_codes SET denied_at = ? WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL")
        .bind(ctx.now, code)
        .run();
      return done("Login denied", "The terminal will not be signed in. You can close this tab.");
    }
    if (action !== "approve") throw new HttpError(400, "invalid_action", "Choose approve or deny.");
    const m = await requireMember(ctx.env.DB, field(form, "org"), userId);
    const res = await ctx.env.DB.prepare(
      "UPDATE device_codes SET approved_by = ?, org_id = ?, approved_at = ? WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL AND expires_at > ?",
    )
      .bind(userId, m.org.id, ctx.now, code, ctx.now)
      .run();
    if (!res.meta.changes) throw new HttpError(409, "decided", "That code was already used.");
    return done("Device approved", `The terminal joins ${m.org.name} in a few seconds. You can close this tab.`);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return devicePage(ctx, userId, e.message, e.status, code);
    throw e;
  }
}
