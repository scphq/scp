import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

const ROOT = join(import.meta.dir, "..");

/** Cloudflare's Turnstile test secrets: one always passes, one always fails */
export const TURNSTILE_PASS = "1x0000000000000000000000000000000AA";
export const TURNSTILE_FAIL = "2x0000000000000000000000000000000AA";
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

let bundle: string | undefined;

async function script(): Promise<string> {
  if (bundle) return bundle;
  const out = await Bun.build({ entrypoints: [join(ROOT, "src/index.ts")], target: "browser", format: "esm" });
  if (!out.success) throw new Error(out.logs.join("\n"));
  bundle = await out.outputs[0]!.text();
  return bundle;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Relay {
  mf: Miniflare;
  origin: string;
  mails: Mail[];
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** the first mail to `to` at or after index `since` of {@link Relay.mails} */
  mailTo(to: string, since?: number): Promise<Mail>;
  dispose(): Promise<void>;
}

export async function startRelay(opts: { turnstileSecret?: string } = {}): Promise<Relay> {
  const mails: Mail[] = [];
  let buffered = "";
  const mf = new Miniflare({
    modules: true,
    script: await script(),
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: crypto.randomUUID() },
    bindings: {
      MAILER: "log",
      MAIL_FROM: "login@scp.test",
      SESSION_SECRET: "test-session-secret",
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET: opts.turnstileSecret ?? TURNSTILE_PASS,
    },
    handleRuntimeStdio(stdout: Readable, stderr: Readable) {
      stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        for (let i = buffered.indexOf("\n"); i >= 0; i = buffered.indexOf("\n")) {
          const line = buffered.slice(0, i);
          buffered = buffered.slice(i + 1);
          const at = line.indexOf("scp-relay mail ");
          if (at >= 0) mails.push(JSON.parse(line.slice(at + "scp-relay mail ".length)) as Mail);
        }
      });
      stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    },
  });
  const db = await mf.getD1Database("DB");
  const sql = readFileSync(join(ROOT, "migrations/0001_init.sql"), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n");
  for (const stmt of sql
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean))
    await db.prepare(stmt).run();

  const origin = "https://relay.test";
  return {
    mf,
    origin,
    mails,
    fetch(path, init = {}) {
      // Bun's fetch skips the undici dispatcher that sets this, so the Worker would see the loopback URL
      const headers = new Headers(init.headers);
      headers.set("MF-Original-URL", origin + path);
      return mf.dispatchFetch(origin + path, { redirect: "manual", ...init, headers } as never) as unknown as Promise<Response>;
    },
    async mailTo(to, since = 0) {
      for (let i = 0; i < 100; i++) {
        const mail = mails.slice(since).find((m) => m.to === to);
        if (mail) return mail;
        await Bun.sleep(20);
      }
      throw new Error(`no mail to ${to}`);
    },
    dispose: () => mf.dispose(),
  };
}

/** a cookie-jar browser that posts forms with the last page's CSRF token and a same-site Origin */
export class Browser {
  readonly jar = new Map<string, string>();
  csrf = "";
  last = "";

  constructor(readonly relay: Relay) {}

  private cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  }

  private absorb(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = decodeURIComponent(pair!.slice(i + 1));
      if (/Max-Age=0/.test(c)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async get(path: string): Promise<Response> {
    const res = await this.relay.fetch(path, { headers: { cookie: this.cookieHeader() } });
    this.absorb(res);
    if ((res.headers.get("content-type") ?? "").startsWith("text/html")) {
      this.last = await res.clone().text();
      const m = /name="csrf" value="([^"]+)"/.exec(this.last);
      if (m) this.csrf = m[1]!;
    }
    return res;
  }

  async post(path: string, fields: Record<string, string>, opts: { csrf?: string | null; origin?: string | null; fetchSite?: string } = {}): Promise<Response> {
    const body = new URLSearchParams(fields);
    const csrf = opts.csrf === undefined ? this.csrf : opts.csrf;
    if (csrf !== null) body.set("csrf", csrf);
    const headers: Record<string, string> = { cookie: this.cookieHeader(), "content-type": "application/x-www-form-urlencoded" };
    const origin = opts.origin === undefined ? this.relay.origin : opts.origin;
    if (origin !== null) headers.origin = origin;
    if (opts.fetchSite) headers["sec-fetch-site"] = opts.fetchSite;
    const res = await this.relay.fetch(path, { method: "POST", headers, body: body.toString() });
    this.absorb(res);
    if ((res.headers.get("content-type") ?? "").startsWith("text/html")) {
      this.last = await res.clone().text();
      const m = /name="csrf" value="([^"]+)"/.exec(this.last);
      if (m) this.csrf = m[1]!;
    }
    return res;
  }

  /** follows one 303 with a GET, as a browser would */
  async follow(res: Response): Promise<Response> {
    const location = res.headers.get("location");
    if (res.status !== 303 || !location) throw new Error(`expected a 303, got ${res.status}`);
    return this.get(location);
  }

  async signIn(email: string): Promise<void> {
    await this.get("/sign-in");
    const since = this.relay.mails.length;
    const res = await this.post("/sign-in", { email, "cf-turnstile-response": DUMMY_TOKEN });
    if (res.status !== 303) throw new Error(`sign-in: ${res.status} ${await res.text()}`);
    await this.follow(res);
    const res2 = await this.post("/sign-in/code", { code: codeOf(await this.relay.mailTo(email, since)) });
    if (res2.status !== 303) throw new Error(`code: ${res2.status}`);
    await this.follow(res2);
  }
}

export function codeOf(mail: Mail): string {
  const m = /\b([2-9A-Z]{4}-[2-9A-Z]{4})\b/.exec(mail.text);
  if (!m) throw new Error(`no code in ${mail.text}`);
  return m[1]!;
}

export const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
