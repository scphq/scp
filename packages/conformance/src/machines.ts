import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { RelayClient, socketPath } from "@scp-dev/broker";
import type { EndpointView, Envelope, SendResult } from "@scp-dev/core";
import type { Subprocess } from "bun";
import { ensureBuilt } from "../../cli/src/testing/fixtures";
import { command, type Target, terminate, waitFor } from "./targets";

export const cli = join(import.meta.dir, "../../cli/dist/cli.js");
export { ensureBuilt };
export class Machine {
  readonly root = mkdtempSync(join(tmpdir(), "scp-conformance-machine-"));
  readonly env: Record<string, string | undefined>;
  private daemon?: Subprocess;
  private clients: RelayClient[] = [];
  private errors = "";
  constructor(
    readonly name: string,
    readonly target: Target,
    token: string,
    readonly program: readonly string[] = [process.execPath, "--no-env-file", cli],
  ) {
    this.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SCP_")));
    Object.assign(this.env, {
      HOME: this.root,
      XDG_CONFIG_HOME: join(this.root, "config"),
      XDG_STATE_HOME: join(this.root, "state"),
      XDG_DATA_HOME: join(this.root, "data"),
      SCP_DIR: join(this.root, "broker"),
      SCP_MACHINE: name,
      SCP_TOKEN: token,
      SCP_RELAY: target.url,
      SCP_HARNESS_DETECT: "0",
      CODEX_HOME: join(this.root, "codex"),
      CLAUDE_CONFIG_DIR: join(this.root, "harness"),
      GEMINI_CLI_HOME: this.root,
    });
    this.assertIsolated();
    mkdirSync(this.env.SCP_DIR!, { recursive: true });
    mkdirSync(join(this.env.XDG_CONFIG_HOME!, "scp"), { recursive: true });
  }
  assertIsolated() {
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "SCP_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME"]) {
      const value = this.env[key]!;
      expect(value.startsWith(`${tmpdir()}/`)).toBe(true);
      const path = relative(this.root, value);
      expect(path === "" || (!path.startsWith("..") && !path.startsWith("/"))).toBe(true);
    }
  }
  async run(args: string[], extra: Record<string, string> = {}) {
    this.assertIsolated();
    this.env.SCP_RELAY = this.target.url;
    return command([...this.program, ...args], { ...this.env, ...extra });
  }
  async json<T>(args: string[], extra: Record<string, string> = {}): Promise<T> {
    return JSON.parse(await this.run([args[0]!, "--json", ...args.slice(1)], extra)) as T;
  }
  async start() {
    await this.run(["cloud", "enable", "--machine", this.name]);
    const child = Bun.spawn([...this.program, "daemon", "--idle", "10m", "--policy", join(this.env.XDG_CONFIG_HOME!, "scp/policy.json")], {
      env: this.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    this.daemon = child;
    void new Response(child.stderr).text().then((text) => {
      this.errors = text;
    });
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`broker exited: ${this.errors}`);
      return existsSync(socketPath(this.env.SCP_DIR!));
    }, `${this.name} broker socket`);
    await this.linked();
  }
  async linked() {
    await waitFor(async () => (await this.json<{ broker: { connected: boolean } }>(["cloud", "status"])).broker.connected, `${this.name} bridge`);
  }
  async claim(handle: string) {
    await this.json(["whoami", "--as", handle]);
    const client = await RelayClient.connect(socketPath(this.env.SCP_DIR!));
    this.clients.push(client);
    await client.hello({ claim: { handle, harness: "cli", exact: true } });
    return client;
  }
  /** a child of `parent`'s endpoint, placed by a grant it mints, with no lists of its own */
  async child(parent: RelayClient, handle: string) {
    const { token } = await parent.grant({ name: handle });
    const client = await RelayClient.connect(socketPath(this.env.SCP_DIR!));
    this.clients.push(client);
    await client.hello({ claim: { handle, harness: "cli", grant: token } });
    return client;
  }
  async list(): Promise<EndpointView[]> {
    return (await this.json<{ endpoints: EndpointView[] }>(["list", "--all"])).endpoints;
  }
  async inbox(handle: string, keep = false): Promise<Envelope[]> {
    return (await this.json<{ messages: Envelope[] }>(["inbox", "--as", handle, ...(keep ? ["--keep"] : [])])).messages;
  }
  async send(handle: string, to: string, text: string) {
    return this.json<SendResult>(["send", to, text, "--as", handle]);
  }
  async stopBroker() {
    for (const client of this.clients.splice(0)) client.close();
    if (this.daemon) await terminate(this.daemon);
  }
  async stop() {
    try {
      await this.stopBroker();
    } finally {
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}
