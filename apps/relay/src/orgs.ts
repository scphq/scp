import type { Env, Role, User } from "./env";
import { closeGrants } from "./hub/routes";
import { type Html, html } from "./html";
import { judgePost, judgeSection } from "./judge";
import { mailerFor } from "./mailer";
import { DAY, HttpError, normalizeEmail, randomId, randomSecret, sha256 } from "./util";
import { back, type Ctx, field, page, readForm } from "./web";

export const HANDLE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INVITE_TTL = 7 * DAY;

export interface Org {
  id: string;
  handle: string;
  name: string;
}

export interface Membership {
  org: Org;
  role: Role;
}

export const canManage = (role: Role): boolean => role === "owner" || role === "admin";

export async function membership(db: D1Database, handle: string, userId: string): Promise<Membership | null> {
  const row = await db
    .prepare("SELECT o.id, o.handle, o.name, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE o.handle = ? AND m.user_id = ?")
    .bind(handle, userId)
    .first<Org & { role: Role }>();
  return row ? { org: { id: row.id, handle: row.handle, name: row.name }, role: row.role } : null;
}

/** the caller's membership, or `not_found` whether the org is missing or the caller is outside it */
export async function requireMember(db: D1Database, handle: string, userId: string, manage = false): Promise<Membership> {
  const m = await membership(db, handle, userId);
  if (!m) throw new HttpError(404, "not_found", "No such organization.");
  if (manage && !canManage(m.role)) throw new HttpError(403, "forbidden", "Only owners and admins can do that.");
  return m;
}

export async function listOrgs(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      "SELECT o.id, o.handle, o.name, m.role, (SELECT COUNT(*) FROM memberships x WHERE x.org_id = o.id) AS members FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.handle",
    )
    .bind(userId)
    .all<Org & { role: Role; members: number }>();
  return results;
}

export async function createOrg(db: D1Database, user: User, rawHandle: string, rawName: string, now: number): Promise<Org> {
  const handle = rawHandle.trim().toLowerCase();
  if (!HANDLE.test(handle))
    throw new HttpError(400, "invalid_handle", "A handle is lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters.");
  const name = rawName.trim() || handle;
  if (name.length > 80) throw new HttpError(400, "invalid_name", "A name is at most 80 characters.");
  const id = randomId("org");
  try {
    await db.batch([
      db.prepare("INSERT INTO orgs (id, handle, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, handle, name, user.id, now),
      db.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, user.id, now),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new HttpError(409, "handle_taken", "That handle is taken.");
    throw e;
  }
  return { id, handle, name };
}

export async function listMembers(db: D1Database, orgId: string) {
  const { results } = await db
    .prepare(
      "SELECT u.id AS user_id, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at",
    )
    .bind(orgId)
    .all<{ user_id: string; email: string; role: Role; created_at: number }>();
  return results;
}

export async function listInvites(db: D1Database, orgId: string, now: number) {
  const { results } = await db
    .prepare(
      "SELECT i.id, i.email, i.role, i.expires_at, u.email AS invited_by FROM invites i JOIN users u ON u.id = i.invited_by WHERE i.org_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? ORDER BY i.created_at",
    )
    .bind(orgId, now)
    .all<{ id: string; email: string; role: Role; expires_at: number; invited_by: string }>();
  return results;
}

export async function createInvite(env: Env, origin: string, m: Membership, inviter: User, rawEmail: string, rawRole: string, now: number) {
  if (!canManage(m.role)) throw new HttpError(403, "forbidden", "Only owners and admins can invite.");
  const email = normalizeEmail(rawEmail);
  const role = rawRole || "member";
  if (role !== "member" && role !== "admin") throw new HttpError(400, "invalid_role", "An invite is for a member or an admin.");
  const already = await env.DB.prepare("SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?")
    .bind(m.org.id, email)
    .first();
  if (already) throw new HttpError(409, "already_member", `${email} is already a member.`);
  const id = randomId("inv");
  const token = randomSecret();
  await env.DB.batch([
    env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(
      now,
      m.org.id,
      email,
    ),
    env.DB.prepare("INSERT INTO invites (id, org_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
      id,
      m.org.id,
      email,
      role,
      await sha256(token),
      inviter.id,
      now,
      now + INVITE_TTL,
    ),
  ]);
  const url = `${origin}/invites/${token}`;
  await mailerFor(env).send({
    to: email,
    subject: `${inviter.email} invited you to ${m.org.name} on scp`,
    text: `${inviter.email} invited you to join ${m.org.name} (${m.org.handle}) as ${role}.\n\nAccept: ${url}\n\nSign in with this email address to accept. The invite expires in 7 days.\n`,
  });
  return { id, email, role, url, expires_at: now + INVITE_TTL };
}

export async function revokeInvite(db: D1Database, m: Membership, id: string, now: number): Promise<void> {
  if (!canManage(m.role)) throw new HttpError(403, "forbidden", "Only owners and admins can revoke invites.");
  await db
    .prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL")
    .bind(now, id, m.org.id)
    .run();
}

export async function invitesFor(db: D1Database, email: string, now: number) {
  const { results } = await db
    .prepare(
      "SELECT i.id, i.role, o.handle, o.name, u.email AS invited_by FROM invites i JOIN orgs o ON o.id = i.org_id JOIN users u ON u.id = i.invited_by WHERE i.email = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ? ORDER BY i.created_at",
    )
    .bind(email, now)
    .all<{ id: string; role: Role; handle: string; name: string; invited_by: string }>();
  return results;
}

type InviteRow = {
  id: string;
  org_id: string;
  email: string;
  role: Role;
  handle: string;
  name: string;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
};

async function findInvite(db: D1Database, by: { id: string } | { token: string }): Promise<InviteRow | null> {
  const base =
    "SELECT i.id, i.org_id, i.email, i.role, o.handle, o.name, i.expires_at, i.accepted_at, i.revoked_at FROM invites i JOIN orgs o ON o.id = i.org_id WHERE ";
  return "id" in by
    ? db.prepare(`${base}i.id = ?`).bind(by.id).first<InviteRow>()
    : db
        .prepare(`${base}i.token_hash = ?`)
        .bind(await sha256(by.token))
        .first<InviteRow>();
}

function usable(invite: InviteRow | null, user: User, now: number): InviteRow {
  if (!invite || invite.revoked_at) throw new HttpError(404, "not_found", "This invite does not exist or was revoked.");
  if (invite.email !== user.email) throw new HttpError(403, "wrong_account", `This invite is for ${invite.email}. Sign in with that address to accept it.`);
  if (invite.accepted_at) throw new HttpError(409, "accepted", "This invite was already accepted.");
  if (invite.expires_at <= now) throw new HttpError(410, "expired", "This invite has expired. Ask for a new one.");
  return invite;
}

/** joins the org when the signed-in email is the invited one */
export async function acceptInvite(db: D1Database, user: User, by: { id: string } | { token: string }, now: number): Promise<Org> {
  const invite = usable(await findInvite(db, by), user, now);
  const [claimed] = await db.batch([
    db.prepare("UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(now, user.id, invite.id),
    db
      .prepare(
        "INSERT INTO memberships (org_id, user_id, role, created_at) SELECT org_id, ?, role, ? FROM invites WHERE id = ? AND accepted_by = ? ON CONFLICT DO NOTHING",
      )
      .bind(user.id, now, invite.id, user.id),
  ]);
  if (!claimed?.meta.changes) throw new HttpError(409, "accepted", "This invite was already accepted.");
  return { id: invite.org_id, handle: invite.handle, name: invite.name };
}

/** removes a member and revokes the credentials they hold in the org */
export async function removeMember(db: D1Database, m: Membership, actor: User, userId: string, now: number): Promise<void> {
  const target = await db.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?").bind(m.org.id, userId).first<{ role: Role }>();
  if (!target) throw new HttpError(404, "not_found", "No such member.");
  const self = userId === actor.id;
  if (!self && !canManage(m.role)) throw new HttpError(403, "forbidden", "Only owners and admins can remove members.");
  if (!self && target.role !== "member" && m.role !== "owner") throw new HttpError(403, "forbidden", "Only owners can remove owners and admins.");
  if (target.role === "owner") {
    const owners = await db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'").bind(m.org.id).first<{ n: number }>();
    if ((owners?.n ?? 0) <= 1) throw new HttpError(409, "last_owner", "An organization keeps at least one owner.");
  }
  await db.batch([
    db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").bind(m.org.id, userId),
    db.prepare("UPDATE device_credentials SET revoked_at = ? WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL").bind(now, m.org.id, userId),
    db.prepare("UPDATE api_tokens SET revoked_at = ? WHERE org_id = ? AND created_by = ? AND revoked_at IS NULL").bind(now, m.org.id, userId),
  ]);
}

// pages

const when = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function orgHeader(m: Membership, tab: "overview" | "members" | "tokens"): Html {
  return html`<p class="label"><a class="mini-link" href="/orgs">Orgs</a> / ${m.org.handle}</p>
    <h1>${m.org.name}</h1>
    <p class="lead">You are <span class="role">${m.role}</span> of <code>${m.org.handle}</code>.</p>
    <nav class="nav sub" aria-label="Organization">
      <a href="/orgs/${m.org.handle}" ${tab === "overview" ? html`aria-current="page"` : ""}>Overview</a>
      <a href="/orgs/${m.org.handle}/members" ${tab === "members" ? html`aria-current="page"` : ""}>Members</a>
      <a href="/orgs/${m.org.handle}/tokens" ${tab === "tokens" ? html`aria-current="page"` : ""}>Tokens and devices</a>
    </nav>`;
}

export const notice = (text: string | undefined, err = false): Html | "" =>
  text ? html`<p class="notice${err ? " err" : ""}" role="${err ? "alert" : "status"}">${text}</p>` : "";

export async function orgsPage(ctx: Ctx, user: User, error = "", status = 200): Promise<Response> {
  const orgs = await listOrgs(ctx.env.DB, user.id);
  const invites = await invitesFor(ctx.env.DB, user.email, ctx.now);
  return page(
    ctx,
    { title: "Organizations", nav: "orgs" },
    html`<p class="label">Organizations</p>
      <h1>Your organizations</h1>
      <p class="lead">An organization has one hub. Its members' agents can message each other across machines.</p>
      ${notice(error, true)}
      ${
        invites.length
          ? html`<section class="block"><h2>Invites for you</h2><div class="table"><table>
            <thead><tr><th>Organization</th><th>Role</th><th>From</th><th></th></tr></thead>
            <tbody>${invites.map(
              (
                i,
              ) => html`<tr><td>${i.name} <span class="mini">${i.handle}</span></td><td><span class="role">${i.role}</span></td><td class="mono">${i.invited_by}</td>
                <td class="end"><form method="post" action="/invites/accept"><input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="invite" value="${i.id}"><button class="btn btn-primary btn-small" type="submit">Accept</button></form></td></tr>`,
            )}</tbody></table></div></section>`
          : ""
      }
      <section class="block"><h2>Member of</h2>
      ${
        orgs.length
          ? html`<div class="table"><table><thead><tr><th>Handle</th><th>Name</th><th>Role</th><th>Members</th></tr></thead>
            <tbody>${orgs.map((o) => html`<tr><td class="mono"><a href="/orgs/${o.handle}">${o.handle}</a></td><td>${o.name}</td><td><span class="role">${o.role}</span></td><td class="mono">${o.members}</td></tr>`)}</tbody></table></div>`
          : html`<p class="empty">You are not in an organization yet. Create one, or accept an invite.</p>`
      }
      </section>
      <section class="block"><h2>Create an organization</h2>
      <form class="form" method="post" action="/orgs">
        <input type="hidden" name="csrf" value="${ctx.csrf}">
        <label class="field"><span>Handle</span><input type="text" name="handle" pattern="[a-z0-9][a-z0-9\\-]{0,63}" placeholder="acme" required></label>
        <label class="field"><span>Name</span><input type="text" name="name" maxlength="80" placeholder="Acme"></label>
        <div class="acts"><button class="btn btn-primary" type="submit">Create</button></div>
      </form></section>`,
    status,
  );
}

export async function orgPage(ctx: Ctx, user: User, handle: string, flash: { ok?: string; err?: string; link?: string } = {}, status = 200): Promise<Response> {
  const m = await requireMember(ctx.env.DB, handle, user.id);
  const members = await listMembers(ctx.env.DB, m.org.id);
  const invites = canManage(m.role) ? await listInvites(ctx.env.DB, m.org.id, ctx.now) : [];
  const judge = await judgeSection(ctx, m);
  const removable = (target: { user_id: string; role: Role }) =>
    target.user_id === user.id ? target.role !== "owner" : m.role === "owner" || (m.role === "admin" && target.role === "member");
  return page(
    ctx,
    { title: m.org.name, nav: "orgs" },
    html`${orgHeader(m, "members")}
      ${notice(flash.err, true)}${notice(flash.ok)}
      ${flash.link ? html`<p class="small">Invite link, if the email does not arrive:</p><p class="secret">${flash.link}</p>` : ""}
      <section class="block"><h2>Members</h2><div class="table"><table>
        <thead><tr><th>Email</th><th>Role</th><th>Joined</th><th></th></tr></thead>
        <tbody>${members.map(
          (
            x,
          ) => html`<tr><td>${x.email}${x.user_id === user.id ? html` <span class="mini">you</span>` : ""}</td><td><span class="role">${x.role}</span></td><td class="mono">${when(x.created_at)}</td>
            <td class="end">${
              removable(x)
                ? html`<form method="post" action="/orgs/${m.org.handle}/members/${x.user_id}/remove"><input type="hidden" name="csrf" value="${ctx.csrf}"><button class="btn btn-ghost btn-small" type="submit">${x.user_id === user.id ? "Leave" : "Remove"}</button></form>`
                : ""
            }</td></tr>`,
        )}</tbody></table></div></section>
      ${
        canManage(m.role)
          ? html`<section class="block"><h2>Invites</h2>
            ${
              invites.length
                ? html`<div class="table"><table><thead><tr><th>Email</th><th>Role</th><th>Expires</th><th></th></tr></thead>
                  <tbody>${invites.map(
                    (i) => html`<tr><td>${i.email}</td><td><span class="role">${i.role}</span></td><td class="mono">${when(i.expires_at)}</td>
                      <td class="end"><form method="post" action="/orgs/${m.org.handle}/invites/${i.id}/revoke"><input type="hidden" name="csrf" value="${ctx.csrf}"><button class="btn btn-ghost btn-small" type="submit">Revoke</button></form></td></tr>`,
                  )}</tbody></table></div>`
                : html`<p class="empty">No pending invites.</p>`
            }
            <form class="form inline" method="post" action="/orgs/${m.org.handle}/invites">
              <input type="hidden" name="csrf" value="${ctx.csrf}">
              <label class="field"><span>Email</span><input type="email" name="email" required></label>
              <label class="field"><span>Role</span><select name="role"><option value="member">member</option><option value="admin">admin</option></select></label>
              <button class="btn btn-primary" type="submit">Invite</button>
            </form></section>`
          : ""
      }
      ${judge}`,
    status,
  );
}

export async function invitePage(ctx: Ctx, user: User, token: string): Promise<Response> {
  const invite = await findInvite(ctx.env.DB, { token });
  let problem = "";
  try {
    usable(invite, user, ctx.now);
  } catch (e) {
    problem = (e as Error).message;
  }
  return page(
    ctx,
    { title: "Invite", nav: "orgs" },
    html`<p class="label">Invite</p>
      <h1>${invite && !invite.revoked_at ? html`Join ${invite.name}` : "Invite"}</h1>
      ${invite && !invite.revoked_at ? html`<p class="lead">You are invited to <code>${invite.handle}</code> as <span class="role">${invite.role}</span>.</p>` : ""}
      ${
        problem
          ? notice(problem, true)
          : html`<form class="form" method="post" action="/invites/accept"><input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="token" value="${token}">
            <div class="acts"><button class="btn btn-primary" type="submit">Accept invite</button><a class="btn btn-ghost" href="/orgs">Not now</a></div></form>`
      }`,
    problem ? 400 : 200,
  );
}

/** POST handlers for the org pages; errors re-render the page they came from */
export async function orgsPost(ctx: Ctx, user: User, path: string[]): Promise<Response> {
  const form = await readForm(ctx);
  if (path.length === 0) {
    try {
      const org = await createOrg(ctx.env.DB, user, field(form, "handle"), field(form, "name"), ctx.now);
      return back(ctx, `/orgs/${org.handle}`);
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return orgsPage(ctx, user, e.message, e.status);
      throw e;
    }
  }
  const [handle, kind, id, action] = path as [string, string?, string?, string?];
  const m = await requireMember(ctx.env.DB, handle, user.id);
  try {
    if (kind === "invites" && !id) {
      const inv = await createInvite(ctx.env, ctx.url.origin, m, user, field(form, "email"), field(form, "role"), ctx.now);
      return orgPage(ctx, user, handle, { ok: `Invited ${inv.email} as ${inv.role}.`, link: inv.url });
    }
    if (kind === "invites" && id && action === "revoke") {
      await revokeInvite(ctx.env.DB, m, id, ctx.now);
      return back(ctx, `/orgs/${handle}/members`);
    }
    if (kind && (await judgePost(ctx, user, m, form, kind, id, action))) return back(ctx, `/orgs/${handle}/members`);
    if (kind === "members" && id && action === "remove") {
      await removeMember(ctx.env.DB, m, user, id, ctx.now);
      await closeGrants(ctx.env, m.org.id, { actorId: id });
      return back(ctx, id === user.id ? "/orgs" : `/orgs/${handle}/members`);
    }
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return orgPage(ctx, user, handle, { err: e.message }, e.status);
    throw e;
  }
  throw new HttpError(404, "not_found", "Not found.");
}

export async function acceptPost(ctx: Ctx, user: User): Promise<Response> {
  const form = await readForm(ctx);
  const id = field(form, "invite");
  const token = field(form, "token");
  try {
    const org = await acceptInvite(ctx.env.DB, user, id ? { id } : { token }, ctx.now);
    return back(ctx, `/orgs/${org.handle}`);
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) return orgsPage(ctx, user, e.message, e.status);
    throw e;
  }
}
