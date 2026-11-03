import { execFileSync } from "node:child_process";
import { expect } from "bun:test";
import hookEnv from "../../../spec/schema/broker/hook-env.json";
import type { BrokerFixture } from "./suite";

/** a process's start time as the CLI's process keys carry it */
export const lstart = (pid: number) =>
  execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } })
    .trim()
    .replace(/\s+/g, "-");

/** the process key of the test process, the harness every hook here runs under */
export const harnessKey = () => `pid:${process.pid}:${lstart(process.pid)}`;

export type HookRun = { stdout: string; deadlines: number[]; elapsedMs: number };

/**
 * one hook run handed to the broker's renderer over the `hook` method, as the native hook client does: what the CLI prints (its stdout and
 * a newline, else agy's `{}`), committed once printed unless `commit` is false, and the `hook_deadline` notifications it heard
 */
export async function hookRpc(
  broker: BrokerFixture,
  args: string[],
  payload: Record<string, unknown>,
  env: Record<string, string | undefined>,
  options: { budgetMs?: number; commit?: boolean; beforeCommit?: () => Promise<void> } = {},
): Promise<HookRun> {
  const { budgetMs = 3500, commit = true } = options;
  const wire = await broker.wire();
  const began = performance.now();
  try {
    const hello = await wire.hello({ observe: true });
    expect(hello.capabilities).toContain("hook");
    const origin = Date.now();
    const result = await wire.request<{ stdout?: string; commit?: string }>(
      "hook",
      {
        args,
        payload,
        cwd: broker.target.home,
        env: Object.fromEntries(hookEnv.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]!]]))),
        origin,
        ends: origin + budgetMs,
        ppid: process.pid,
        procs: [{ pid: process.pid, ppid: process.ppid, start: lstart(process.pid), args: "bun test", comm: "bun" }],
      },
      { timeoutMs: 30_000 },
    );
    await options.beforeCommit?.();
    if (commit && result.stdout && result.commit) await wire.request("hook_commit", { commit: result.commit });
    const deadlines = wire.frames.flatMap((frame) =>
      frame.method === "hook_deadline" && frame.id === undefined ? [(frame.params as { ends: number }).ends - origin] : [],
    );
    const stdout = result.stdout ? `${result.stdout}\n` : args[0] === "agy" ? "{}\n" : "";
    return { stdout, deadlines, elapsedMs: performance.now() - began };
  } finally {
    await wire.close();
  }
}
