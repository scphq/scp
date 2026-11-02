import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Subprocess } from "bun";
import { brokerBinary, brokerNode, selectedBrokerTargets, swarmBinary } from "../environment";
import { terminate, waitFor } from "../targets";
import { BrokerWire } from "./wire";

/** SPEC Appendix E.1 socket discovery, including the Unix path limit. */
export function socketPath(dir: string): string {
  const inside = join(dir, "relay.sock");
  if (Buffer.byteLength(inside) <= 100) return inside;
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 12);
  return join("/tmp", `scp-${process.getuid!()}-${hash}`, "relay.sock");
}

export const cli = join(import.meta.dir, "../../../cli/dist/cli.js");

/**
 * `ts` runs the built CLI's foreground broker under Bun, `ts-node` under Node, `rust` the engine named by SCP_BROKER_BIN, and
 * `ts-native` the built CLI's foreground broker under SCP_NATIVE=1, which runs the native swarm named by SCP_SWARM_BIN
 */
export const brokerTargetNames = ["ts", "ts-node", "rust", "ts-native"].filter((name) => !selectedBrokerTargets || selectedBrokerTargets.includes(name));
export const brokerTargetEnabled = (name: string) =>
  name === "ts" ? true : name === "ts-node" ? !!brokerNode : name === "ts-native" ? !!swarmBinary : !!brokerBinary;
/** the targets whose broker is the native engine */
export const nativeBrokerTarget = (name: string) => name === "rust" || name === "ts-native";

export type BrokerFiles = {
  limits?: Record<string, number | null>;
  /** written to the policy path the broker is started with */
  policy?: unknown;
  /** written relative to the isolated home */
  files?: Record<string, string>;
};

/**
 * one broker engine over a fresh relay directory and home. The engine contract: `<engine> daemon --idle <s> --policy <file>`
 * in the foreground, the relay directory from SCP_DIR, serving the socket of Appendix E.1 until SIGTERM.
 */
export class BrokerTarget {
  readonly home = mkdtempSync(join(tmpdir(), "scp-bc-"));
  readonly dir = join(this.home, "state", "scp");
  readonly socket = socketPath(this.dir);
  readonly policyPath = join(this.home, "config", "scp", "policy.json");
  readonly env: Record<string, string | undefined>;
  private child?: Subprocess;
  private stderr = "";
  constructor(
    readonly name: string,
    files: BrokerFiles = {},
  ) {
    this.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SCP_")));
    Object.assign(this.env, {
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, "config"),
      XDG_STATE_HOME: join(this.home, "state"),
      XDG_DATA_HOME: join(this.home, "data"),
      SCP_DIR: this.dir,
      SCP_HARNESS_DETECT: "0",
      CODEX_HOME: join(this.home, "codex"),
      CLAUDE_CONFIG_DIR: join(this.home, "claude"),
      GEMINI_CLI_HOME: this.home,
    });
    if (name === "ts-native") Object.assign(this.env, { SCP_NATIVE: "1", SCP_SWARM_BIN: resolve(swarmBinary!) });
    if (files.limits !== undefined) this.env.SCP_LIMITS = JSON.stringify(files.limits);
    if (files.policy !== undefined) this.write(this.policyPath, typeof files.policy === "string" ? files.policy : JSON.stringify(files.policy));
    for (const [path, text] of Object.entries(files.files ?? {})) this.write(join(this.home, path), text);
  }
  private write(path: string, text: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  writePolicy(policy: unknown) {
    this.write(this.policyPath, typeof policy === "string" ? policy : JSON.stringify(policy));
  }
  command(): string[] {
    const args = ["daemon", "--idle", "600", "--policy", this.policyPath];
    if (this.name === "rust") return [resolve(brokerBinary!), ...args];
    if (this.name === "ts-node") return [brokerNode === "1" ? "node" : brokerNode!, cli, ...args];
    return [process.execPath, "--no-env-file", cli, ...args];
  }
  async start() {
    const child = Bun.spawn(this.command(), { env: this.env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    this.child = child;
    void new Response(child.stderr).text().then((text) => {
      this.stderr = text;
    });
    await waitFor(
      async () => {
        if (child.exitCode !== null) throw new Error(`${this.name} broker exited (${child.exitCode}): ${this.stderr}`);
        if (!existsSync(this.socket)) return false;
        try {
          const wire = await BrokerWire.connect(this.socket);
          await wire.close();
          return true;
        } catch {
          return false;
        }
      },
      `${this.name} broker socket`,
      20000,
    );
    if (this.name === "ts-native" && Number(readFileSync(join(this.dir, "broker.lock"), "utf8").split(":")[0]) === child.pid)
      throw new Error(`ts-native ran the TypeScript broker: ${this.stderr}`);
  }
  get pid() {
    return this.child?.pid;
  }
  get running() {
    return !!this.child && this.child.exitCode === null;
  }
  /** SIGTERM and wait; the relay directory stays */
  async stop() {
    if (this.child) await terminate(this.child);
  }
  async restart() {
    await this.stop();
    await this.start();
  }
  async dispose() {
    try {
      await this.stop();
    } finally {
      rmSync(this.home, { recursive: true, force: true });
      if (!this.socket.startsWith(this.home)) rmSync(dirname(this.socket), { recursive: true, force: true });
    }
  }
}
