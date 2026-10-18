import type { User } from "./env";
import { hubHold, hubHolds, hubJudge, judgeEnabled } from "./hub/routes";
import { judgeSetup } from "./hub/judge";
import { type Html, html } from "./html";
import { canManage, type Membership } from "./orgs";
import { HttpError } from "./util";
import { type Ctx, field } from "./web";

const when = (iso: string): string => iso.slice(0, 16).replace("T", " ");

/** the org page's relay judge section: its state, the owner's toggle, and the held messages for owners and admins */
export async function judgeSection(ctx: Ctx, m: Membership): Promise<Html> {
  const enabled = await judgeEnabled(ctx.env.DB, m.org.id);
  const configured = judgeSetup(ctx.env) !== null;
  const holds = enabled && configured && canManage(m.role) ? await hubHolds(ctx.env, m.org.id) : null;
  const action = `/orgs/${m.org.handle}`;
  return html`<section class="block" id="judge"><h2>Relay judge</h2>
    <p class="small">A model reads this org's messages before the hub delivers them, and holds the ones that look like they leak private data until an owner or admin reviews them.</p>
    <p>The relay judge is <span class="role">${enabled ? "on" : "off"}</span>.</p>
    ${configured ? "" : html`<p class="notice" role="status">The judge is not configured on this relay (no model or key), so no message is judged.</p>`}
    ${
      m.role === "owner"
        ? html`<form method="post" action="${action}/judge"><input type="hidden" name="csrf" value="${ctx.csrf}"><input type="hidden" name="enabled" value="${enabled ? "0" : "1"}"><button class="btn ${enabled ? "btn-ghost" : "btn-primary"} btn-small" type="submit">${enabled ? "Turn off" : "Turn on"}</button></form>`
        : ""
    }
    ${
      holds === null
        ? enabled && configured && canManage(m.role)
          ? html`<p class="empty">The hub did not answer; reload to see held messages.</p>`
          : ""
        : holds.length
          ? html`<h3>Held messages</h3><div class="table"><table>
            <thead><tr><th>From</th><th>To</th><th>Categories</th><th>Reason</th><th>Held</th><th>Expires</th><th></th></tr></thead>
            <tbody>${holds.map(
              (
                h,
              ) => html`<tr><td class="mono">${h.from}</td><td class="mono">${h.to.join(", ")}</td><td>${h.categories.join(", ") || "none"}</td><td>${h.reason}</td>
                <td class="mono">${when(h.created_at)}</td><td class="mono">${when(h.expires_at)}</td>
                <td class="end"><form method="post" action="${action}/holds/${h.id}/release"><input type="hidden" name="csrf" value="${ctx.csrf}"><button class="btn btn-primary btn-small" type="submit">Release</button></form>
                <form method="post" action="${action}/holds/${h.id}/refuse"><input type="hidden" name="csrf" value="${ctx.csrf}"><input type="text" name="reason" maxlength="280" placeholder="Reason" required aria-label="Reason"><button class="btn btn-ghost btn-small" type="submit">Refuse</button></form></td></tr>`,
            )}</tbody></table></div>`
          : html`<p class="empty">No held messages.</p>`
    }
    </section>`;
}

/** POST /orgs/<org>/judge (owner) and /orgs/<org>/holds/<id>/release or /refuse (owner or admin) */
export async function judgePost(ctx: Ctx, user: User, m: Membership, form: FormData, kind: string, id?: string, action?: string): Promise<boolean> {
  if (kind === "judge" && !id) {
    if (m.role !== "owner") throw new HttpError(403, "forbidden", "Only owners can turn the relay judge on or off.");
    const enabled = field(form, "enabled") === "1";
    await ctx.env.DB.prepare("UPDATE orgs SET judge_enabled = ? WHERE id = ?")
      .bind(enabled ? 1 : 0, m.org.id)
      .run();
    await hubJudge(ctx.env, m.org.id, enabled);
    return true;
  }
  if (kind === "holds" && id && (action === "release" || action === "refuse")) {
    if (!canManage(m.role)) throw new HttpError(403, "forbidden", "Only owners and admins review held messages.");
    const reason = field(form, "reason");
    if (action === "refuse" && !reason) throw new HttpError(400, "invalid_reason", "Give a reason for refusing the message.");
    const done = await hubHold(ctx.env, m.org.id, action, { id, by: user.email, ...(action === "refuse" ? { reason } : {}) });
    if (!done.ok) throw new HttpError(done.status >= 500 ? 502 : done.status, "hold_refused", done.message);
    return true;
  }
  return false;
}
