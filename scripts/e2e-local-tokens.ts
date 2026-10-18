// Mints two API tokens on a local dev relay: signs in two users with the log mailer's codes, makes an org, invites the
// second user and has each mint one token. Usage: bun scripts/e2e-local-tokens.ts <origin> <relay log> <token file a> <token file b>
import { readFileSync, writeFileSync } from "node:fs";

const [origin, logPath, fileA, fileB] = process.argv.slice(2);
if (!origin || !logPath || !fileA || !fileB) throw new Error("usage: e2e-local-tokens.ts <origin> <relay log> <token file a> <token file b>");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)) throw new Error("e2e-local-tokens only mints on a loopback relay");

const TURNSTILE_DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

function mailCode(to: string, after: number): string | undefined {
  const text = readFileSync(logPath!, "utf8");
  let code: string | undefined;
  for (const line of text.slice(after).split("\n")) {
    const at = line.indexOf("scp-relay mail ");
    if (at < 0) continue;
    try {
      const mail = JSON.parse(line.slice(at + "scp-relay mail ".length)) as { to: string; text: string };
      const m = /\b([2-9A-Z]{4}-[2-9A-Z]{4})\b/.exec(mail.text);
      if (mail.to === to && m) code = m[1];
    } catch {}
  }
  return code;
}

class Browser {
  readonly jar = new Map<string, string>();
  csrf = "";

  private absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0]!;
      const i = pair.indexOf("=");
      if (/Max-Age=0/.test(c)) this.jar.delete(pair.slice(0, i));
      else this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "), origin: origin!, ...extra };
  }

  async get(path: string): Promise<Response> {
    const res = await fetch(origin + path, { headers: this.headers(), redirect: "manual" });
    this.absorb(res);
    if ((res.headers.get("content-type") ?? "").startsWith("text/html")) {
      const m = /name="csrf" value="([^"]+)"/.exec(await res.clone().text());
      if (m) this.csrf = m[1]!;
    }
    return res;
  }

  async form(path: string, fields: Record<string, string>): Promise<Response> {
    const body = new URLSearchParams({ ...fields, csrf: this.csrf }).toString();
    const res = await fetch(origin + path, {
      method: "POST",
      headers: this.headers({ "content-type": "application/x-www-form-urlencoded" }),
      body,
      redirect: "manual",
    });
    this.absorb(res);
    return res;
  }

  async api<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(origin + path, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json", "x-csrf-token": this.csrf }),
      body: JSON.stringify(body),
      redirect: "manual",
    });
    const out = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${out.error ?? ""}`);
    return out;
  }

  async signIn(email: string): Promise<void> {
    await this.get("/sign-in");
    const after = readFileSync(logPath!, "utf8").length;
    const sent = await this.form("/sign-in", { email, "cf-turnstile-response": TURNSTILE_DUMMY });
    if (sent.status !== 303) throw new Error(`sign-in for ${email}: HTTP ${sent.status} (the Turnstile test secret needs network access)`);
    let code: string | undefined;
    for (let i = 0; i < 100 && !code; i++) {
      await Bun.sleep(100);
      code = mailCode(email, after);
    }
    if (!code) throw new Error(`no sign-in mail to ${email} in the relay log (is MAILER=log?)`);
    await this.get("/sign-in/code");
    const done = await this.form("/sign-in/code", { code });
    if (done.status !== 303) throw new Error(`sign-in code for ${email}: HTTP ${done.status}`);
    await this.get("/orgs");
  }
}

const run = Math.random().toString(36).slice(2, 8);
const org = `e2e-${run}`;
const alice = new Browser();
const bob = new Browser();
await alice.signIn(`alice-${run}@example.test`);
await alice.api("/v1/orgs", { handle: org, name: `e2e ${run}` });
const invite = await alice.api<{ id: string }>(`/v1/orgs/${org}/invites`, { email: `bob-${run}@example.test`, role: "member" });
await bob.signIn(`bob-${run}@example.test`);
await bob.api(`/v1/invites/${invite.id}/accept`, {});
const a = await alice.api<{ token: string }>(`/v1/orgs/${org}/tokens`, { name: "e2e-a" });
const b = await bob.api<{ token: string }>(`/v1/orgs/${org}/tokens`, { name: "e2e-b" });
writeFileSync(fileA, a.token, { mode: 0o600 });
writeFileSync(fileB, b.token, { mode: 0o600 });
console.log(`minted two tokens in org ${org}`);
