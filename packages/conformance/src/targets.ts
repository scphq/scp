import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import type { XAllow, XLimits } from "@scp-dev/core";
import { HUB_LIMITS, type HubWakeOptions } from "@scp-dev/hub";
import { DockerTarget } from "./docker-target";
import { containerImage, postgresServer, relayBinary, selectedTargets } from "./environment";
export { DockerTarget } from "./docker-target";

export type ContactOp = "invite" | "accept" | "decline" | "revoke" | "block" | "update";
export type ContactOptions = { allow?: XAllow[]; dir?: "in" | "out" | "both"; limits?: XLimits | null };
export type MintOptions = { device?: boolean; name?: string; expiresIn?: number };

export interface Target {
  start(limits?: Record<string, number>, wake?: Partial<HubWakeOptions>, extraServeArgs?: string[]): Promise<{ url: string }>;
  mint(account: string, member: string, opts?: MintOptions): Promise<{ token: string; credentialId: string }>;
  revoke(credentialId: string): Promise<void>;
  contact(op: ContactOp, account: string, peer: string, opts?: ContactOptions): Promise<{ account: string; peer: string; state: string | null }>;
  device(op: "approve" | "deny", userCode: string, account?: string, member?: string): Promise<void>;
  restart(): Promise<void>;
  stop(): Promise<void>;
  readonly url: string;
}
export const targetNames = ["ts", "rust-sqlite", ...(postgresServer ? ["rust-pg"] : []), ...(containerImage ? ["docker"] : [])].filter(
  (name) => !selectedTargets || selectedTargets.includes(name),
);
export const enabled = (name: string) => (name === "docker" ? !!containerImage : name === "ts" || !!relayBinary);

export async function waitFor<T>(check: () => T | Promise<T>, what: string, timeoutMs = 10000): Promise<Exclude<T, undefined | null | false>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value as Exclude<T, undefined | null | false>;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}
export async function terminate(child: Subprocess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}
export async function command(args: string[], env: Record<string, string | undefined> = process.env, timeoutMs = 10000, cwd?: string) {
  const child = Bun.spawn(args, { env, ...(cwd === undefined ? {} : { cwd }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`command failed (${code}): ${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    await terminate(child);
  }
}
export class ProcessTarget implements Target {
  url = "";
  private child?: Subprocess;
  private root = mkdtempSync(join(tmpdir(), "scp-conformance-target-"));
  private secret = crypto.randomUUID();
  private store = `sqlite://${join(this.root, "relay.db")}`;
  private database?: string;
  private admin?: InstanceType<typeof Bun.SQL>;
  private limits: Record<string, number> = {};
  private wake: Partial<HubWakeOptions> = {};
  private docker?: DockerTarget;
  private extraServeArgs: string[] = [];
  constructor(readonly name: string) {
    if (name === "docker") this.docker = new DockerTarget();
  }
  async start(limits: Record<string, number> = {}, wake: Partial<HubWakeOptions> = {}, extraServeArgs: string[] = []) {
    const rustLimits = { ...HUB_LIMITS, ...limits };
    const rustWake = { senderAccountPerHour: 6, targetPerHour: 12, ...wake };
    if (this.docker) {
      const result = await this.docker.start(rustLimits, rustWake, extraServeArgs);
      this.url = result.url;
      return result;
    }
    this.limits = this.name === "ts" ? limits : rustLimits;
    this.extraServeArgs = extraServeArgs;
    this.wake = this.name === "ts" ? wake : rustWake;
    if (this.name === "rust-pg" && !this.database) {
      this.database = `scp_conformance_${crypto.randomUUID().replaceAll("-", "")}`;
      this.admin = new Bun.SQL(postgresServer!);
      await this.admin.unsafe(`CREATE DATABASE ${this.database}`);
      const url = new URL(postgresServer!);
      url.pathname = `/${this.database}`;
      this.store = url.toString();
    }
    await this.launch();
    return { url: this.url };
  }
  private async launch() {
    const listen = this.url ? new URL(this.url).host : "127.0.0.1:0";
    const args =
      this.name === "ts"
        ? [process.execPath, "--no-env-file", join(import.meta.dir, "reference-server.ts"), "--listen", listen, "--dir", this.root]
        : [resolve(relayBinary!), "serve", "--listen", listen, "--store", this.store];
    args.push(...this.extraServeArgs);
    for (const [key, value] of Object.entries(this.limits)) args.push("--limit", `${key}=${value}`);
    for (const [key, value] of Object.entries(this.wake)) args.push("--wake", `${key}=${value}`);
    const child = Bun.spawn(args, { env: { ...process.env, SCP_CONFORMANCE_ADMIN: this.secret }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    this.child = child;
    let listening = "";
    let stderr = "";
    void new Response(child.stderr).text().then((text) => {
      stderr = text;
    });
    void (async () => {
      let pending = "";
      for await (const chunk of child.stdout) {
        pending += new TextDecoder().decode(chunk);
        for (;;) {
          const end = pending.indexOf("\n");
          if (end < 0) break;
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.event === "listening" && typeof event.url === "string") listening = event.url;
          } catch {
            /* Non-contract output cannot signal readiness. */
          }
        }
      }
    })();
    this.url = await waitFor(
      () => {
        if (child.exitCode !== null) throw new Error(`relay exited (${child.exitCode}): ${stderr}`);
        return listening;
      },
      `${this.name} listening`,
      this.name === "rust-pg" ? 60000 : 10000,
    );
    await waitFor(async () => (await fetch(`${this.url}/health`)).ok, "relay health");
  }
  private async tsAdmin(body: object) {
    const response = await fetch(`${this.url}/_admin`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`admin failed: ${response.status}`);
    return response.json();
  }
  async mint(account: string, member: string, opts: MintOptions = {}) {
    if (this.docker) return this.docker.mint(account, member, opts);
    if (this.name === "ts") return (await this.tsAdmin({ action: "mint", account, member, ...opts })) as { token: string; credentialId: string };
    await command([resolve(relayBinary!), "account", "create", account, "--store", this.store]);
    const output = JSON.parse(
      await command([
        resolve(relayBinary!),
        "token",
        "create",
        "--store",
        this.store,
        "--account",
        account,
        "--member",
        member,
        ...(opts.device ? ["--device"] : []),
        ...(opts.name ? ["--name", opts.name] : []),
        ...(opts.expiresIn !== undefined ? ["--expires-in", String(opts.expiresIn)] : []),
      ]),
    );
    return { token: output.token as string, credentialId: output.credential_id as string };
  }
  async revoke(credentialId: string) {
    if (this.docker) return this.docker.revoke(credentialId);
    if (this.name === "ts") {
      await this.tsAdmin({ action: "revoke", credentialId });
      return;
    }
    await command([resolve(relayBinary!), "token", "revoke", "--store", this.store, credentialId]);
  }
  async contact(op: ContactOp, account: string, peer: string, opts: ContactOptions = {}) {
    if (this.docker) return this.docker.contact(op, account, peer, opts);
    if (this.name === "ts")
      return (await this.tsAdmin({ action: "contact", op, account, peer, ...opts })) as { account: string; peer: string; state: string | null };
    const args = [resolve(relayBinary!), "contact", op, peer, "--store", this.store, "--account", account];
    if (opts.allow !== undefined) args.push("--allow", JSON.stringify(opts.allow));
    if (opts.dir !== undefined) args.push("--dir", opts.dir);
    if (opts.limits !== undefined) args.push("--limits", JSON.stringify(opts.limits));
    return JSON.parse(await command(args)) as { account: string; peer: string; state: string | null };
  }
  async device(op: "approve" | "deny", userCode: string, account?: string, member?: string) {
    if (this.docker) return this.docker.device(op, userCode, account, member);
    if (this.name === "ts") {
      await this.tsAdmin({ action: op, userCode, account, member });
      return;
    }
    await command([
      resolve(relayBinary!),
      "device",
      op,
      userCode,
      "--store",
      this.store,
      ...(op === "approve" ? ["--account", account!, "--member", member!] : []),
    ]);
  }
  async restart() {
    if (this.docker) return this.docker.restart();
    if (this.child) await terminate(this.child);
    await this.launch();
  }
  async stop() {
    try {
      if (this.docker) await this.docker.stop();
      if (this.child) await terminate(this.child);
    } finally {
      try {
        if (this.admin && this.database) await this.admin.unsafe(`DROP DATABASE IF EXISTS ${this.database} WITH (FORCE)`);
      } finally {
        await this.admin?.close();
        rmSync(this.root, { recursive: true, force: true });
      }
    }
  }
}
