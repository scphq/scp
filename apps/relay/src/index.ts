import type { Env } from "./env";
import { CSS, html, layout } from "./html";
import { DAY, HttpError, json } from "./util";

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
      throw new HttpError(404, "not_found", "Not found.");
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
