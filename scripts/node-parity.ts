// Runs the built CLI under Node, the runtime its users have: on the TypeScript engine, and through the router on the native one. The CLI
// tests run under Bun, which words its errors and reads stdin differently, so what only Node does shows up here.
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const given = process.argv[2];
if (!given) throw new Error("usage: bun scripts/node-parity.ts <swarm>");
const bin = resolve(given);
const repo = join(import.meta.dir, "..");
const cli = join(repo, "packages/cli/dist/cli.js");
const version = (JSON.parse(readFileSync(join(repo, "packages/cli/package.json"), "utf8")) as { version: string }).version;
const root = mkdtempSync(join(tmpdir(), "scp-node-parity-"));
const log = join(root, "route.log");
const failures: string[] = [];

type Run = { code: number | null; stdout: string; stderr: string };
type Stdin = "empty" | "directory" | "closed";

function baseEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(SCP_|CLAUDE|CODEX_|GROK_|MUSE_|OPENCODE)/.test(key)) env[key] = value;
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".state"),
    SCP_DIR: join(home, "relay"),
    SCP_HARNESS_DETECT: "0",
  };
}

/** `swarm <argv>` under Node; `node` is the first word so a closed stdin can go through sh */
function swarm(env: Record<string, string>, argv: string[], stdin: Stdin = "empty"): Run {
  const home = env.HOME!;
  const words = ["node", cli, ...argv];
  const fd = stdin === "directory" ? openSync(home, "r") : undefined;
  const run =
    stdin === "closed"
      ? spawnSync("sh", ["-c", 'exec "$@" <&-', "sh", ...words], { env, cwd: home, encoding: "utf8" })
      : spawnSync(words[0]!, words.slice(1), { env, cwd: home, encoding: "utf8", stdio: [fd ?? "ignore", "pipe", "pipe"] });
  if (fd !== undefined) closeSync(fd);
  const strip = (text: string) => text.replaceAll(home, "<home>");
  return { code: run.status, stdout: strip(run.stdout), stderr: strip(run.stderr) };
}

function homes() {
  const make = (name: string) => {
    const home = join(root, name);
    mkdirSync(join(home, "relay"), { recursive: true, mode: 0o700 });
    return home;
  };
  return {
    ts: baseEnv(make("ts")),
    native: { ...baseEnv(make("native")), SCP_NATIVE: "1", SCP_SWARM_BIN: bin, SCP_ROUTE_LOG: log },
  };
}

function same(what: string, ts: Run, native: Run): void {
  if (JSON.stringify(ts) !== JSON.stringify(native)) failures.push(`${what}\n  ts:     ${JSON.stringify(ts)}\n  native: ${JSON.stringify(native)}`);
}

function expectEqual(what: string, actual: unknown, wanted: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push(`${what}: ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
}

const logged = () => {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const env = homes();

// the argument parser: what util.parseArgs refuses, under the same words on both engines
const parse = JSON.parse(readFileSync(join(repo, "crates/scp-cli/tests/fixtures/parse.json"), "utf8")) as { argv: string[]; error?: string }[];
const refused = parse.filter((item) => item.error !== undefined).map((item) => item.argv);
for (const argv of [
  ...refused,
  ["help"],
  ["--help"],
  ["help", "--all"],
  ["help", "send"],
  ["send", "-h"],
  ["spawn", "--help"],
  ["version"],
  ["--version"],
  ["nope"],
  ["pi", "--name", "x"],
  ["codex", "--as", "x"],
  [],
]) {
  same(`swarm ${argv.join(" ")}`, swarm(env.ts, argv), swarm(env.native, argv));
}

// stdin as only Node reads it, then a config whose JSON is null, which Node words as a TypeError
for (const stdin of ["directory", "closed"] as const) {
  for (const argv of [
    ["--as", "lane", "send", "peer"],
    ["--as", "lane", "ask", "peer", "-"],
    ["--as", "lane", "reply", "last"],
  ]) {
    same(`swarm ${argv.join(" ")} with stdin ${stdin}`, swarm(env.ts, argv, stdin), swarm(env.native, argv, stdin));
  }
}
for (const engine of [env.ts, env.native]) {
  mkdirSync(join(engine.XDG_CONFIG_HOME!, "scp"), { recursive: true });
  writeFileSync(join(engine.XDG_CONFIG_HOME!, "scp", "cloud.json"), "null");
}
same("swarm cloud status with a null cloud.json", swarm(env.ts, ["cloud", "status"]), swarm(env.native, ["cloud", "status"]));
rmSync(join(env.ts.XDG_CONFIG_HOME!, "scp", "cloud.json"));
rmSync(join(env.native.XDG_CONFIG_HOME!, "scp", "cloud.json"));

// the router itself under Node
const execve = spawnSync("node", ["-p", "typeof process.execve"], { encoding: "utf8" }).stdout.trim() === "function";
const handOff = execve ? "execve" : "spawn";
const decision = (extra: Record<string, string>, argv = ["--version"]) => {
  rmSync(log, { force: true });
  const run = swarm({ ...env.native, ...extra }, argv);
  return { run, lines: logged() };
};
const routed = decision({});
expectEqual("the version under Node", routed.run.stdout, `${version}\n`);
expectEqual("the hand-off under Node", routed.lines, [`--version native ${handOff}`, "--version native run"]);
expectEqual(
  "a hook under Node",
  decision({ SCP_ROUTE_PROBE_MS: "60000" }, ["hook", "claude"]).lines,
  execve ? ["hook native execve", "hook native run"] : ["hook ts spawn"],
);
const spawned = decision({ SCP_ROUTE_EXEC: "spawn" }, ["nope"]);
expectEqual("the spawn hand-off under Node", spawned.lines, ["nope native spawn", "nope native unknown"]);
expectEqual("its exit code", spawned.run.code, 125);
expectEqual("forced under Node", decision({ SCP_NATIVE_TS: "*" }).lines, ["--version ts forced"]);
expectEqual("no binary under Node", decision({ SCP_SWARM_BIN: join(root, "missing") }).lines, ["--version ts missing"]);

function fake(name: string, script: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}
const old = fake("old-swarm", `echo '{"version":"0.0.1","verbs":["--version"]}'`);
expectEqual("another version under Node", decision({ SCP_SWARM_BIN: old }).lines, ["--version ts version"]);
const slow = fake("slow-swarm", "exec sleep 5");
const late = decision({ SCP_SWARM_BIN: slow, SCP_ROUTE_PROBE_MS: "300" });
expectEqual("a slow probe under Node", late.lines, ["--version ts slow"]);
if (!late.run.stderr.includes("did not answer")) failures.push(`a slow probe says nothing: ${JSON.stringify(late.run)}`);

for (const engine of [env.ts, env.native]) swarm(engine, ["daemon", "stop"]);
rmSync(root, { recursive: true, force: true });
if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`${failures.length} differences under Node`);
  process.exit(1);
}
console.log("the CLI under Node matches on both engines");
