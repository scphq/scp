import type { HubWakeOptions } from "@scp-dev/hub";
import { containerImage } from "./environment";
import { command, type ContactOp, type ContactOptions, type MintOptions, type Target, waitFor } from "./targets";

export class DockerTarget implements Target {
  url = "";
  private container = `scp-conformance-${crypto.randomUUID()}`;
  private volume = `${this.container}-data`;
  private docker(args: string[]) {
    return command(["docker", ...args], process.env, 30000);
  }
  private async admin(args: string[]) {
    return this.docker(["exec", this.container, "scp-relay", ...args]);
  }
  async start(limits: Record<string, number> = {}, wake: Partial<HubWakeOptions> = {}, extraServeArgs: string[] = []) {
    try {
      await this.docker(["volume", "create", this.volume]);
      const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = reservation.port;
      await reservation.stop(true);
      const args = [
        "run",
        "-d",
        "--name",
        this.container,
        "-p",
        `127.0.0.1:${port}:8787`,
        "-v",
        `${this.volume}:/data`,
        containerImage!,
        "serve",
        ...extraServeArgs,
      ];
      for (const [key, value] of Object.entries(limits)) args.push("--limit", `${key}=${value}`);
      for (const [key, value] of Object.entries(wake)) args.push("--wake", `${key}=${value}`);
      await this.docker(args);
      this.url = `http://127.0.0.1:${port}`;
      await this.healthy();
      return { url: this.url };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  private async healthy() {
    await waitFor(
      async () => {
        try {
          return (await fetch(`${this.url}/health`)).ok;
        } catch {
          return false;
        }
      },
      "container health",
      20000,
    );
  }
  async mint(account: string, member: string, opts: MintOptions = {}) {
    await this.admin(["account", "create", account]);
    const output = JSON.parse(
      await this.admin([
        "token",
        "create",
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
    await this.admin(["token", "revoke", credentialId]);
  }
  async contact(op: ContactOp, account: string, peer: string, opts: ContactOptions = {}) {
    const args = ["contact", op, peer, "--account", account];
    if (opts.allow !== undefined) args.push("--allow", JSON.stringify(opts.allow));
    if (opts.dir !== undefined) args.push("--dir", opts.dir);
    if (opts.limits !== undefined) args.push("--limits", JSON.stringify(opts.limits));
    return JSON.parse(await this.admin(args)) as { account: string; peer: string; state: string | null };
  }
  async device(op: "approve" | "deny", userCode: string, account?: string, member?: string) {
    await this.admin(["device", op, userCode, ...(op === "approve" ? ["--account", account!, "--member", member!] : [])]);
  }
  async restart() {
    await this.docker(["restart", "--time", "2", this.container]);
    await this.healthy();
  }
  async stop() {
    try {
      await this.docker(["rm", "-f", this.container]);
    } finally {
      await this.docker(["volume", "rm", "-f", this.volume]);
    }
  }
}
