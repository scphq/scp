import type { GrantSummary } from "@cloudflare/workers-oauth-provider";
import { mint, TOKEN_PREFIX } from "./credentials";
import { closeGrants, hubOverview } from "./hub/routes";
import { userGrants } from "./grants";
import type { User } from "./env";
import { type Html, html } from "./html";
import { canManage, type Membership, notice, orgTab, requireMember } from "./orgs";
import { ago, groupByMachine } from "./overview";
import { DAY, HttpError, randomId } from "./util";
import { back, type Ctx, field, readForm } from "./web";

export const TOKEN_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export interface TokenView {
  id: string;
  name: string;
  display: string;
  created_by: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

export interface DeviceView {
  id: string;
  label: string;
  display: string;
  email: string;
  created_at: number;
  last_used_at: number | null;
}

export async function listTokens(db: D1Database, orgId: string): Promise<TokenView[]> {
  const { results } = await db
    .prepare(
      "SELECT t.id, t.name, t.prefix || '...' || t.last4 AS display, u.email AS created_by, t.created_at, t.last_used_at, t.expires_at FROM api_tokens t JOIN users u ON u.id = t.created_by WHERE t.org_id = ? AND t.revoked_at IS NULL ORDER BY t.created_at DESC",
    )
    .bind(orgId)
    .all<TokenView>();
  return results;
}

/** an org member mints a token for headless agents; the secret is returned once and only its hash is kept */
export async function createToken(db: D1Database, m: Membership, user: User, rawName: string, rawDays: unknown, now: number) {
  const name = rawName.trim().toLowerCase();
  if (!TOKEN_NAME.test(name))
    throw new HttpError(
      400,
      "invalid_name",
      "A token name is lowercase letters, digits, dots, underscores and hyphens, at most 63 characters, for example ci-nightly.",
    );
  let expiresAt: number | null = null;
  if (rawDays !== undefined && rawDays !== null && rawDays !== "" && rawDays !== "never") {
    const days = Number(rawDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      throw new HttpError(400, "invalid_expiry", "Expiry is a whole number of days from 1 to 3650, or never.");
    expiresAt = now + days * DAY;
  }
  const cred = await mint(TOKEN_PREFIX);
  const id = randomId("tok");
  try {
    await db
      .prepare("INSERT INTO api_tokens (id, token_hash, prefix, last4, name, org_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, cred.hash, cred.prefix, cred.last4, name, m.org.id, user.id, now, expiresAt)
      .run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "name_taken", `A live token named ${name} exists. Revoke it or pick another name.`);
    throw e;
  }
  return { id, name, token: cred.secret, display: `${cred.prefix}...${cred.last4}`, expires_at: expiresAt };
}

export async function revokeToken(db: D1Database, m: Membership, user: User, id: string, now: number): Promise<void> {
  const row = await db
    .prepare("SELECT created_by FROM api_tokens WHERE id = ? AND org_id = ? AND revoked_at IS NULL")
    .bind(id, m.org.id)
    .first<{ created_by: string }>();
  if (!row) throw new HttpError(404, "not_found", "No such token.");
  if (row.created_by !== user.id && !canManage(m.role)) throw new HttpError(403, "forbidden", "Only its creator, owners and admins can revoke a token.");
  await db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
}

/** owners and admins see every device in the org, members their own */
export async function listDevices(db: D1Database, m: Membership, user: User): Promise<DeviceView[]> {
  const all = canManage(m.role);
  const { results } = await db
    .prepare(
      `SELECT d.id, d.label, d.prefix || '...' || d.last4 AS display, u.email, d.created_at, d.last_used_at FROM device_credentials d JOIN users u ON u.id = d.user_id WHERE d.org_id = ? AND d.revoked_at IS NULL${all ? "" : " AND d.user_id = ?"} ORDER BY d.created_at DESC`,
    )
    .bind(...(all ? [m.org.id] : [m.org.id, user.id]))
    .all<DeviceView>();
  return results;
}

export async function revokeDevice(db: D1Database, m: Membership, user: User, id: string, now: number): Promise<void> {
  const row = await db
    .prepare("SELECT user_id FROM device_credentials WHERE id = ? AND org_id = ? AND revoked_at IS NULL")
    .bind(id, m.org.id)
    .first<{ user_id: string }>();
  if (!row) throw new HttpError(404, "not_found", "No such device.");
  if (row.user_id !== user.id && !canManage(m.role)) throw new HttpError(403, "forbidden", "Only its owner, org owners and admins can revoke a device.");
  await db.prepare("UPDATE device_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
}

// pages

const when = (ms: number | null): string => (ms === null ? "never" : new Date(ms).toISOString().slice(0, 10));

/** the machines the hub knows, each with its agents; a device or token above is what lets one join */
async function machinesBlock(ctx: Ctx, orgId: string): Promise<Html> {
  const o = await hubOverview(ctx.env, orgId);
  const groups = o ? groupByMachine(o) : [];
  return html`<section class="block"><h2>Machines</h2>
    <p class="small">Machines that joined this org's hub. Revoke the device or token a machine signed in with to cut it off.</p>
    ${
      !o
        ? html`<p class="empty">The hub did not answer. Reload to see machines.</p>`
        : groups.length
          ? html`<div class="table"><table><thead><tr><th>Machine</th><th>Kind</th><th>State</th><th class="end">Agents</th><th class="end">Last seen</th></tr></thead>
            <tbody>${groups.map((g) => {
              const online = g.machine?.online || g.endpoints.some((e) => e.presence === "online");
              const live = g.endpoints.filter((e) => e.presence !== "offline").length;
              return html`<tr><td class="mono">${g.name}</td><td>${g.machine ? html`<span class="role">${g.machine.kind}</span>` : html`<span class="mini">unlisted</span>`}</td>
                <td><span class="dot ${online ? "online" : "offline"}" aria-hidden="true"></span><span class="mini">${online ? "online" : "offline"}</span></td>
                <td class="mono end">${live} of ${g.endpoints.length}</td><td class="mono end" title="${g.machine?.last_seen ?? ""}">${online ? "now" : ago(g.machine?.last_seen ?? null, ctx.now)}</td></tr>`;
            })}</tbody></table></div>`
          : html`<p class="empty">No machines yet. Run <code>swarm up</code> on one.</p>`
    }
  </section>`;
}

interface Flash {
  err?: string;
  created?: { name: string; token: string };
}

async function connectors(ctx: Ctx, m: Membership, user: User): Promise<GrantSummary[]> {
  const users = canManage(m.role)
    ? (await ctx.env.DB.prepare("SELECT user_id FROM memberships WHERE org_id = ?").bind(m.org.id).all<{ user_id: string }>()).results.map((u) => u.user_id)
    : [user.id];
  const grants: GrantSummary[] = [];
  for (const userId of users) grants.push(...(await userGrants(ctx.env.OAUTH_PROVIDER, userId)).filter((g) => g.metadata?.orgId === m.org.id));
  return grants;
}

export async function tokensPage(ctx: Ctx, user: User, handle: string, flash: Flash = {}, status = 200): Promise<Response> {
  const m = await requireMember(ctx.env.DB, handle, user.id);
  const [tokens, devices, machines] = await Promise.all([listTokens(ctx.env.DB, m.org.id), listDevices(ctx.env.DB, m, user), machinesBlock(ctx, m.org.id)]);
  const grants = await connectors(ctx, m, user);
  const revoke = (path: string) =>
    html`<form method="post" action="/orgs/${m.org.handle}/${path}/revoke"><input type="hidden" name="csrf" value="${ctx.csrf}"><button class="btn btn-ghost btn-small" type="submit">Revoke</button></form>`;
  return orgTab(
    ctx,
    m,
    "tokens",
    `${m.org.name} tokens and devices`,
    html`${notice(flash.err, true)}
      ${
        flash.created
          ? html`<section class="block"><h2>Token ${flash.created.name} created</h2>
            <p class="small">Copy it now. It is shown once and only its hash is stored.</p>
            <p class="secret">${flash.created.token}</p>
            <p class="small">Headless agents use it with no browser:</p>
            <p class="secret">SCP_RELAY=${ctx.url.origin} swarm up --token ${flash.created.token} --machine &lt;name&gt;</p></section>`
          : ""
      }
      <section class="block"><h2>API tokens</h2>
        <p class="small">For CI jobs, cron and cloud runners. A token joins this org's hub as a member on your behalf, labels the endpoints it creates with its name, and stops working when revoked, when it expires or when you leave the org.</p>
        ${
          tokens.length
            ? html`<div class="table"><table><thead><tr><th>Name</th><th>Token</th><th>Created by</th><th>Last used</th><th>Expires</th><th></th></tr></thead>
              <tbody>${tokens.map(
                (
                  t,
                ) => html`<tr><td class="mono">${t.name}</td><td class="mono">${t.display}</td><td>${t.created_by}</td><td class="mono">${t.last_used_at ? when(t.last_used_at) : "never"}</td><td class="mono">${when(t.expires_at)}</td>
                  <td class="end">${t.created_by === user.email || canManage(m.role) ? revoke(`tokens/${t.id}`) : ""}</td></tr>`,
              )}</tbody></table></div>`
            : html`<p class="empty">No API tokens.</p>`
        }
        <form class="form inline" method="post" action="/orgs/${m.org.handle}/tokens">
          <input type="hidden" name="csrf" value="${ctx.csrf}">
          <label class="field"><span>Name</span><input type="text" name="name" placeholder="ci-nightly" maxlength="63" required></label>
          <label class="field"><span>Expires</span><select name="expires_in_days">
            <option value="30">in 30 days</option><option value="7">in 7 days</option><option value="90">in 90 days</option><option value="365">in a year</option><option value="never">never</option>
          </select></label>
          <button class="btn btn-primary" type="submit">Create token</button>
        </form></section>
      <section class="block"><h2>Devices</h2>
        <p class="small">Terminals signed in with <code>swarm up</code>.</p>
        ${
          devices.length
            ? html`<div class="table"><table><thead><tr><th>Machine</th><th>Credential</th><th>User</th><th>Signed in</th><th>Last used</th><th></th></tr></thead>
              <tbody>${devices.map(
                (
                  d,
                ) => html`<tr><td class="mono">${d.label}</td><td class="mono">${d.display}</td><td>${d.email}</td><td class="mono">${when(d.created_at)}</td><td class="mono">${d.last_used_at ? when(d.last_used_at) : "never"}</td>
                  <td class="end">${revoke(`devices/${d.id}`)}</td></tr>`,
              )}</tbody></table></div>`
            : html`<p class="empty">No devices. Run <code>swarm up</code> in a terminal.</p>`
        }
      </section>
      <section class="block"><h2>Connectors</h2>
      ${
        grants.length
          ? html`<div class="table"><table><thead><tr><th>Client</th><th>Label</th><th>Redirect host</th><th>Created</th><th></th></tr></thead><tbody>
      ${grants.map((g) => html`<tr><td>${g.metadata.clientName}</td><td>${g.metadata.label}</td><td>${g.metadata.redirectHost}</td><td>${when(g.createdAt * 1000)}</td><td><form method="post" action="/orgs/${m.org.handle}/connectors/${g.id}/revoke"><input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="user_id" value="${g.userId}"><button class="btn btn-ghost btn-small">Revoke</button></form></td></tr>`)}
      </tbody></table></div>`
          : html`<p class="empty">No connectors.</p>`
      }</section>
      ${machines}`,
    { status },
  );
}

export async function tokensPost(ctx: Ctx, user: User, handle: string, rest: string[]): Promise<Response> {
  const form = await readForm(ctx);
  const m = await requireMember(ctx.env.DB, handle, user.id);
  const [kind, id, action] = rest as [string, string?, string?];
  try {
    if (kind === "connectors" && id && action === "revoke") {
      const grant = (await connectors(ctx, m, user)).find((g) => g.id === id && g.userId === field(form, "user_id"));
      if (!grant) throw new HttpError(404, "not_found", "No such connector.");
      await ctx.env.OAUTH_PROVIDER.revokeGrant(id, grant.userId);
      await closeGrants(ctx.env, m.org.id, { tokenId: `oauth_${id}` });
      return back(ctx, `/orgs/${handle}/tokens`);
    }
    if (kind === "tokens" && !id) {
      const created = await createToken(ctx.env.DB, m, user, field(form, "name"), field(form, "expires_in_days"), ctx.now);
      return tokensPage(ctx, user, handle, { created });
    }
    if (kind === "tokens" && id && action === "revoke") await revokeToken(ctx.env.DB, m, user, id, ctx.now);
    else if (kind === "devices" && id && action === "revoke") await revokeDevice(ctx.env.DB, m, user, id, ctx.now);
    else throw new HttpError(404, "not_found", "Not found.");
    await closeGrants(ctx.env, m.org.id, { tokenId: id });
    return back(ctx, `/orgs/${handle}/tokens`);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return tokensPage(ctx, user, handle, { err: e.message }, e.status);
    throw e;
  }
}
