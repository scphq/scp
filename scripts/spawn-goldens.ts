// Writes the spawn argv and output goldens the native CLI is tested against, and the fixture files they read; --check fails when they drifted.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../packages/cli/package.json" with { type: "json" };
import { agyRules } from "../packages/cli/src/setup";
import {
  agyNote,
  closedStdin,
  codexExec,
  codexMount,
  codexOverrideAt,
  codexOverrides,
  codexSkipsGitCheck,
  codexThread,
  contributorRefusal,
  handbackBytes,
  harnessArgv,
  harnessOutput,
  hasFlag,
  inGit,
  MESSAGING,
  messagingAllow,
  museExec,
  museFirstRun,
  museModeAt,
  museModes,
  museOptionsEnd,
  museResumeBase,
  programAt,
  promptAt,
  repliesOutput,
  resumeArgv,
  spawnDefaults,
  spawnPrompt,
  spawnTitle,
  splitSpawn,
  stderrOutput,
  steerArgv,
  toml,
  transcriptReplies,
  workerName,
} from "../packages/cli/src/spawn";

const root = join(import.meta.dir, "..");
const FIXTURES = join(root, "crates/scp-cli/tests/fixtures/spawn");
const GOLDENS = join(root, "crates/scp-cli/tests/fixtures/spawn.json");
const SELF = ["node", "/cli.js"];
const NO_SWARM = "/nonexistent/swarm";
const F = "<fixtures>";
const SWARM = "<swarm>";

type Env = Record<string, string>;
type Case = { fn: string; input: Record<string, unknown> };
type Fixture = string | Buffer | { script: string } | { link: string };

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const cat = (...parts: (string | number[])[]) => Buffer.concat(parts.map((part) => Buffer.from(part as string)));

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const S = "s1";
const say = (text: unknown, extra: Record<string, unknown> = {}, session = S) =>
  line({ type: "assistant", sessionId: session, message: { role: "assistant", content: [{ type: "text", text }], ...extra } });
const ask = (content: unknown, extra: Record<string, unknown> = {}, session = S) =>
  line({ type: "user", sessionId: session, message: { role: "user", content }, ...extra });

const TRANSCRIPT = [
  say("before the prompt"),
  ask("first task"),
  say("working on it"),
  line({ type: "assistant", sessionId: S, isSidechain: true, message: { content: [{ type: "text", text: "sidechain reply" }] } }),
  line({ type: "assistant", sessionId: "other", message: { content: [{ type: "text", text: "other session" }] } }),
  ask([{ type: "tool_result", content: "tool output" }]),
  say("after a tool"),
  ask("meta note", { isMeta: true }),
  ask("summary of the conversation", { isCompactSummary: true }),
  ask("from a tool", { toolUseResult: null }),
  ask("Stop hook feedback: keep going"),
  ask("   "),
  ask([{ type: "image" }, { type: "text", text: "  " }]),
  say("   "),
  line({ type: "assistant", sessionId: S, message: { content: "a string reply" } }),
  line({
    type: "assistant",
    sessionId: S,
    message: { content: [{ type: "thinking", thinking: "hm" }, { type: "tool_use", name: "x" }, "bare string block", { type: "text", text: "two" }, null, 5] },
  }),
  "not json\n",
  "[1,2]\n",
  "42\n",
  "\n",
  line({ type: "assistant", sessionId: S, message: ["array message"] }),
  line({ type: "assistant", sessionId: S, message: { content: [{ type: "text", text: "cut short" }], stop_reason: "max_tokens" } }),
  line({ type: "assistant", sessionId: S, message: { content: [{ type: "text", text: 7 }], stop_reason: "max_tokens" } }),
  `${JSON.stringify({ type: "assistant", sessionId: S, message: { content: [{ type: "text", text: "crlf line" }] } })}\r\n`,
].join("");

const s2 = "s2";
const PROMPT_LAST = [
  say("old", {}, s2),
  ask([{ type: "text", text: "new prompt" }, { type: "tool_result" }], {}, s2),
  say("kept after tool_result block", {}, s2),
  ask("real prompt", {}, s2),
  say("final", {}, s2),
].join("");

const surrogates = (text: string) => `{"type":"assistant","sessionId":"s5","message":{"content":[{"type":"text","text":"${text}"}]}}\n`;

const codex = (body: string) => `[mcp_servers.scp]\n${body}\n`;
const VALUES = [
  `s = "quote \\" back \\\\ tab\\t nl\\n cr\\r bell\\u0007 esc\\u001b del\\u007f c1\\u0085 emoji 😀 nbsp\\u00a0 ls\\u2028 ps\\u2029 bom\\ufeff"`,
  "lit = 'C:\\path\\x'",
  'arr = [[1, 2], ["a"], [], [true, false]]',
  'tbl = { b = 1, a = "x", "10" = 2, "9" = 3, "01" = 4, "4294967295" = 5, "4294967294" = 6, nested = { z = [true, 1.5] } }',
  "f = 1.5e300",
  "small = 1e-7",
  "frac = 0.1",
  "neg = -0.0",
  "big = 9007199254740991",
  "nan = nan",
  "inf = -inf",
  "dt = 1979-05-27T07:32:00Z",
  "d = 1979-05-27",
  'empty = ""',
  "on = true",
].join("\n");

/** the fixture files, by path under the fixture directory */
const FILES: Record<string, Fixture> = {
  "codex/node/config.toml": codex('command = "node"\nargs = ["/x/cli.js", "mcp", "--harness", "codex"]'),
  "codex/gone/config.toml": codex('command = "/nonexistent/swarm"\nargs = ["mcp", "--harness", "codex", "--extra"]'),
  "codex/present/config.toml": codex('command = "/bin/sh"\nargs = ["mcp"]'),
  "codex/nomcp/config.toml": codex('command = "/bin/sh"\nargs = ["-x"]'),
  "codex/kept/config.toml": codex(
    'command = "node"\nargs = ["cli.js", "mcp", "--harness", "codex"]\nenv_vars = ["SCP_GRANT", "OTHER", 5, { a = 1 }]\ndefault_tools_approval_mode = "prompt"\nenv = { SCP_NATIVE = "1" }',
  ),
  "codex/native/config.toml": codex('command = "/bin/sh"\nargs = ["mcp", "--harness", "codex"]\nenv = { SCP_NATIVE = "1", SCP_CLI_ARGV = "[]" }'),
  "codex/weird/config.toml": codex('command = 42\nargs = [true, 1.5, ["a", "b"], 1e300, -0.0, 1e-7]\nenv = "string"\nenv_vars = "SCP_GRANT"'),
  "codex/values/config.toml": codex(VALUES),
  "codex/unsafe/config.toml": `${codex('command = "node"')}[other]\nbig = 9007199254740993\n`,
  "codex/crlf/config.toml": codex('command = "/bin/sh"\r\nargs = ["mcp", "--harness", "codex"]\r\n'),
  "codex/invalid/config.toml": "[mcp_servers.scp\ncommand = 1\n",
  "codex/scalar/config.toml": '[mcp_servers]\nscp = "string"\n',
  "codex/other/config.toml": '[mcp_servers.other]\ncommand = "x"\n',
  "codex/empty/config.toml": "",
  "agy/full/.gemini/antigravity-cli/settings.json": `${JSON.stringify({ permissions: { allow: [...agyRules(), "other"] } }, null, 2)}\n`,
  "agy/partial/.gemini/antigravity-cli/settings.json": `${JSON.stringify({ permissions: { allow: agyRules().slice(1) } })}\n`,
  "agy/surrogate/.gemini/antigravity-cli/settings.json": `{"note":"\\ud83d","permissions":${JSON.stringify({ allow: agyRules() })}}\n`,
  "agy/scalar/.gemini/antigravity-cli/settings.json": `${JSON.stringify({ permissions: { allow: "mcp(scp/relay_send)" } })}\n`,
  "agy/invalid/.gemini/antigravity-cli/settings.json": `\ufeff${JSON.stringify({ permissions: { allow: agyRules() } })}\n`,
  "agy/array/.gemini/antigravity-cli/settings.json": "[]\n",
  "agy/null/.gemini/antigravity-cli/settings.json": "null\n",
  "claude/projects/p/s1.jsonl": TRANSCRIPT,
  "claude/projects/p/s2.jsonl": PROMPT_LAST,
  "claude/projects/p/s3.jsonl": cat(
    '{"type":"assistant","sessionId":"s3","message":{"content":[{"type":"text","text":"bad ',
    [0xff, 0xfe, 0xc3],
    ' bytes"}]}}\n',
    [0xff, 0x0a],
    say("tail \u00e9", {}, "s3"),
  ),
  "claude/projects/p/s4.jsonl": "",
  "claude/projects/p/s5.jsonl": [
    surrogates("cut mid emoji \\ud83d"),
    surrogates("low \\ude00 pair \\ud83d\\ude00 literal \\\\ud83d end"),
    surrogates("high high \\ud83d\\ud83d\\ude00"),
    surrogates("short \\ud83"),
  ].join(""),
  "claude/projects/p/link.jsonl": { link: "s1.jsonl" },
  "claude/projects/p/dir.jsonl/keep": "",
  "claude/outside/s1.jsonl": TRANSCRIPT,
  "bin/codex-skip": { script: 'echo "Usage: codex exec [OPTIONS]"\necho "      --skip-git-repo-check  Allow running outside a git repository"' },
  "bin/codex-noskip": { script: 'echo "Usage: codex exec [OPTIONS]"' },
  "bin/codex-fail": { script: 'echo "--skip-git-repo-check"\nexit 1' },
  "bin/codex-slow": { script: "exec sleep 8" },
  "bin/codex-args": { script: '[ "$1 $2" = "exec --help" ] && [ "$PROBE_ENV" = "yes" ] && echo "--skip-git-repo-check"' },
};

function sameFile(path: string, want: Fixture): boolean {
  try {
    if (typeof want === "object" && "link" in want) return lstatSync(path).isSymbolicLink() && readlinkSync(path) === want.link;
    if (typeof want === "object" && "script" in want)
      return readFileSync(path, "utf8") === `#!/bin/sh\n${want.script}\n` && (lstatSync(path).mode & 0o111) !== 0;
    return !lstatSync(path).isSymbolicLink() && readFileSync(path).equals(Buffer.from(want as string));
  } catch {
    return false;
  }
}

function writeFixtures(): void {
  for (const [rel, want] of Object.entries(FILES)) {
    const path = join(FIXTURES, rel);
    mkdirSync(dirname(path), { recursive: true });
    if (sameFile(path, want)) continue;
    rmSync(path, { force: true });
    if (typeof want === "object" && "link" in want) symlinkSync(want.link, path);
    else if (typeof want === "object" && "script" in want) {
      writeFileSync(path, `#!/bin/sh\n${want.script}\n`);
      chmodSync(path, 0o755);
    } else writeFileSync(path, want as string);
  }
}

let swarmBin = "";

/** the case's input with the placeholders for the fixture directory and the native swarm replaced */
function real<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replaceAll(F, FIXTURES).replaceAll(SWARM, swarmBin)) as T;
}

/** the output with the fixture directory and the native swarm as placeholders, so the goldens hold on any machine */
function placeheld(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value).replaceAll(swarmBin, SWARM).replaceAll(FIXTURES, F));
}

// biome-ignore lint/suspicious/noExplicitAny: each case's input is read as its function takes it
const RUNNERS: Record<string, (input: any) => unknown> = {
  programAt: (i) => programAt(i.command),
  hasFlag: (i) => hasFlag(i.args, i.flags),
  toml: (i) => {
    if (i.key === undefined) return toml(i.value);
    const mount = codexMount({ CODEX_HOME: i.home });
    return mount && i.key in mount ? toml(mount[i.key]) : undefined;
  },
  codexMount: (i) => {
    const mount = codexMount(i.env);
    return mount === undefined ? undefined : toml(mount);
  },
  codexOverrides: (i) => codexOverrides(i.env, codexMount(i.env), SELF),
  codexOverrideAt: (i) => codexOverrideAt(i.args),
  messagingAllow: (i) => messagingAllow(i.harness, i.args),
  harnessArgv: (i) => harnessArgv(i.command, i.env, SELF, codexMount, i.cwd, () => i.probe),
  codexSkipsGitCheck: (i) => codexSkipsGitCheck(i.program, i.env),
  inGit: (i) => inGit(i.dir),
  museModes: (i) => museModes(i.args).map((mode) => mode ?? null),
  contributorRefusal: (i) => contributorRefusal(i.command),
  museFirstRun: (i) => museFirstRun(i.command, () => "00000000-0000-4000-8000-000000000000"),
  museResumeBase: (i) => museResumeBase(i.command, i.session),
  museExec: (i) => museExec(i.args),
  museOptionsEnd: (i) => museOptionsEnd(i.args, i.start),
  museModeAt: (i) => museModeAt(i.args),
  closedStdin: (i) => closedStdin(i.command),
  codexExec: (i) => codexExec(i.args),
  promptAt: (i) => promptAt(i.command),
  resumeArgv: (i) => resumeArgv(i.command, i.session, i.prompt),
  spawnPrompt: (i) => spawnPrompt(i.command),
  steerArgv: (i) => steerArgv(i.command, i.steer ?? undefined),
  spawnTitle: (i) => spawnTitle(i.command),
  workerName: (i) => workerName(i.command, () => "abcde"),
  splitSpawn: (i) => splitSpawn(i.args),
  spawnDefaults: (i) => Object.entries(spawnDefaults(Object.fromEntries(i.values), i.command, () => "abcde")),
  handbackBytes: (i) => {
    try {
      return { ok: handbackBytes(i.value) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
  agyNote: (i) => (i.verb === undefined ? agyNote(i.command, i.env) : agyNote(i.command, i.env, i.verb)),
  codexThread: (i) => codexThread(i.head === null ? {} : { head: { out: unhex(i.head.out), err: unhex(i.head.err) } }),
  harnessOutput: (i) => harnessOutput({ tail: unhex(i.tail), cut: i.cut }, i.bytes ?? undefined),
  stderrOutput: (i) =>
    i.bytes === undefined ? stderrOutput({ err: unhex(i.err), errCut: i.cut }) : stderrOutput({ err: unhex(i.err), errCut: i.cut }, i.bytes),
  transcriptReplies: (i) =>
    (i.bytes === undefined ? transcriptReplies(i.path, i.session, i.root) : transcriptReplies(i.path, i.session, i.root, i.bytes)).map((reply) =>
      reply.toWellFormed(),
    ),
  repliesOutput: (i) => (i.bytes === undefined ? repliesOutput(i.replies) : repliesOutput(i.replies, i.bytes)),
};

const cases: Case[] = [];
const add = (fn: string, input: Record<string, unknown>) => cases.push({ fn, input });
const each = (fn: string, key: string, list: unknown[]) => {
  for (const value of list) add(fn, { [key]: value });
};

each("programAt", "command", [
  [],
  ["claude"],
  ["/usr/local/bin/claude", "-p", "x"],
  ["env", "-u", "X", "codex", "exec"],
  ["env", "-i", "-C", "/tmp", "--", "codex"],
  ["/usr/bin/env", "A=1", "B=2", "claude"],
  ["A=1", "_B=2", "1C=3", "claude"],
  ["A-B=1", "claude"],
  ["=x", "claude"],
  ["timeout", "-s", "KILL", "5", "codex", "exec"],
  ["timeout", "--signal=KILL", "-k", "1", "10", "nice", "-n", "3", "nohup", "muse"],
  ["timeout"],
  ["timeout", "5"],
  ["nice", "--adjustment", "2", "--", "grok"],
  ["nice", "-5", "codex"],
  ["nohup", "nohup", "env", "codex/"],
  ["env", "--split-string", "a b", "--unset=Y", "agy"],
  ["env", "--", "--", "claude"],
  ["env", "-", "claude"],
  ["env/", "claude"],
  ["sudo", "claude"],
  ["", "claude"],
]);

const FLAG_ARGS: [string[], string[]][] = [
  [["-p"], ["-p", "--print"]],
  [["--print=x"], ["-p", "--print"]],
  [["-p=x"], ["-p", "--print"]],
  [["--printx"], ["--print"]],
  [["--", "-p"], ["-p"]],
  [["x", "--allowedTools=a"], ["--allowedTools"]],
  [["--allowedTools"], ["--allowedTools"]],
  [["--allowed"], ["--allowedTools"]],
  [[], ["-p"]],
  [["-p"], []],
  [["--last"], ["--last"]],
  [["a", "--", "--last"], ["--last"]],
];
for (const [args, flags] of FLAG_ARGS) add("hasFlag", { args, flags });

each("toml", "value", [
  "plain",
  'quote " and \\ backslash',
  "control \u0000\u0001\u0007\b\f\n\r\t\u000b\u001b\u001f",
  "del \u007f and c1 \u0080\u009f",
  "emoji 😀 cjk 漢字 nbsp \u00a0 ls \u2028 ps \u2029 bom \ufeff",
  "",
  ["a", "b"],
  [],
  [["nested", ["deep"]], "x"],
  true,
  false,
  0,
  -1,
  1.5,
  1e21,
  1e-7,
  123456789012,
]);
for (const key of ["s", "lit", "arr", "tbl", "f", "small", "frac", "neg", "big", "nan", "inf", "dt", "d", "empty", "on", "missing"])
  add("toml", { home: `${F}/codex/values`, key });

for (const home of ["none", "node", "gone", "present", "nomcp", "kept", "native", "weird", "values", "unsafe", "crlf", "invalid", "scalar", "other", "empty"])
  add("codexMount", { env: { CODEX_HOME: `${F}/codex/${home}` } });
add("codexMount", { env: { HOME: `${F}/codex`, CODEX_HOME: "" } });
add("codexMount", { env: { HOME: `${F}/nohome` } });

const SHIM: Env = { SCP_GRANT: "krt_x", SCP_NAME: "w", SCP_DIR: "/d", SCP_HARNESS_PID: "1", OTHER: "o" };
const NATIVE: Env[] = [
  {},
  { SCP_NATIVE: "1", SCP_SWARM_BIN: NO_SWARM },
  { SCP_NATIVE: "mcp", SCP_SWARM_BIN: NO_SWARM },
  { SCP_NATIVE: "1", SCP_SWARM_BIN: SWARM },
  { SCP_NATIVE: "mcp", SCP_SWARM_BIN: SWARM },
  { SCP_NATIVE: "0", SCP_SWARM_BIN: SWARM },
];
for (const home of ["none", "node", "gone", "present", "nomcp", "kept", "native", "weird", "crlf"])
  for (const native of NATIVE) add("codexOverrides", { env: { ...SHIM, ...native, CODEX_HOME: `${F}/codex/${home}` } });
add("codexOverrides", { env: { CODEX_HOME: `${F}/codex/none` } });
add("codexOverrides", { env: { SCP_SESSION: "", SCP_CODEX_THREAD: "t", XDG_STATE_HOME: "/s", CODEX_HOME: `${F}/codex/kept` } });

const CODEX_ARGS: string[][] = [
  [],
  ["exec"],
  ["e", "hi"],
  ["-m", "o3", "exec", "hi"],
  ["-c", "a=1", "--config", "b=2", "review"],
  ["resume", "--last"],
  ["fork", "x"],
  ["--", "exec"],
  ["login"],
  ["-m"],
  ["exec", "--json", "-o", "f", "resume", "x"],
  ["exec", "--color", "never", "review"],
  ["exec", "--model", "m", "--", "resume"],
  ["exec", "-", "resume"],
  ["e", "--output-schema", "s.json", "resume", "--last", "p"],
  ["exec", "--color"],
  ["--image", "a.png", "e", "-i", "b.png", "review"],
];
each("codexOverrideAt", "args", CODEX_ARGS);
each("codexExec", "args", [
  ...CODEX_ARGS,
  ["-C", "/a", "exec", "--cd", "/b", "x"],
  ["--cd=/c", "exec", "p"],
  ["exec", "--cd=/d", "resume", "-C", "/e", "id", "p"],
  ["exec", "-C"],
  ["exec", "p", "--json", "q", "--", "-x", "y"],
  ["exec", "-", "p"],
  ["exec", "resume", "--last", "-"],
  ["-", "exec"],
  ["exec", "review", "--", "--uncommitted"],
]);

for (const harness of ["claude", "grok", "codex", "muse", "other"])
  for (const args of [
    [],
    ["-p", "x"],
    ["--allowedTools", "Bash"],
    ["--allowedTools=Bash"],
    ["--allow", "x"],
    ["--", "--permission-mode"],
    ["--always-approve"],
  ])
    add("messagingAllow", { harness, args });

const baseEnv = (extra: Env = {}): Env => ({ ...SHIM, CODEX_HOME: `${F}/codex/none`, ...extra });
const HARNESS: { command: string[]; env?: Env; cwd?: string; probe?: boolean }[] = [
  { command: [] },
  { command: ["claude"] },
  { command: ["claude", "-p", "hi"] },
  { command: ["claude", "--print", "hi", "--", "more"] },
  { command: ["claude", "-p", "--allowedTools=Bash", "hi"] },
  { command: ["claude", "-p", "--dangerously-skip-permissions", "hi"] },
  { command: ["claude", "-p", "--", "--allowedTools"] },
  { command: ["env", "-u", "X", "/opt/claude", "-p", "x"] },
  { command: ["grok", "-p", "x"] },
  { command: ["grok", "--prompt-file", "f", "--always-approve"] },
  { command: ["grok", "--single", "x", "--", "y"] },
  { command: ["grok", "x"] },
  { command: ["muse"] },
  { command: ["muse", "exec", "hi"] },
  { command: ["muse", "--model", "m", "-w", "create", "exec", "--json", "hi"] },
  { command: ["muse", "-w", "exec", "hi"] },
  { command: ["muse", "--contributor-mode", "on", "exec"] },
  { command: ["muse", "-c", "contributor_mode=true", "exec"] },
  { command: ["muse", "exec", "--", "--contributor-mode"] },
  { command: ["nice", "-n", "3", "muse", "run", "x"] },
  { command: ["agy", "-p", "x"] },
  { command: ["codex"] },
  { command: ["codex", "login"] },
  { command: ["codex", "exec", "hi"] },
  { command: ["codex", "exec", "hi"], probe: true },
  { command: ["codex", "exec", "hi"], probe: true, cwd: F },
  { command: ["codex", "exec", "--skip-git-repo-check", "hi"], probe: true },
  { command: ["codex", "exec", "--", "--skip-git-repo-check"], probe: true },
  { command: ["codex", "-C", F, "exec", "hi"], probe: true },
  { command: ["codex", "exec", "--cd", "/", "hi"], probe: true, cwd: F },
  { command: ["codex", "exec", "--cd=sub", "hi"], probe: true, cwd: F },
  { command: ["codex", "exec", "-C", "../../../../../../../../../../../../../../../../.."], probe: true, cwd: F },
  { command: ["codex", "exec", "review"], probe: true },
  { command: ["codex", "exec", "resume", "--last", "go"], probe: true },
  { command: ["codex", "exec", "--json", "resume", "id", "go"], probe: true },
  { command: ["codex", "-m", "o3", "exec"], probe: true },
  { command: ["codex", "e", "hi"] },
  { command: ["codex", "review"] },
  { command: ["codex", "resume", "--last"] },
  { command: ["codex", "fork"] },
  { command: ["timeout", "5", "codex", "-c", "x=1", "exec", "hi"], probe: true },
  { command: ["codex", "exec", "hi"], env: baseEnv({ CODEX_HOME: `${F}/codex/node` }) },
  { command: ["codex", "exec", "hi"], env: baseEnv({ CODEX_HOME: `${F}/codex/gone` }) },
  { command: ["codex", "exec", "hi"], env: baseEnv({ CODEX_HOME: `${F}/codex/kept`, SCP_NATIVE: "mcp", SCP_SWARM_BIN: NO_SWARM }) },
  { command: ["codex", "exec", "hi"], env: baseEnv({ CODEX_HOME: `${F}/codex/kept`, SCP_NATIVE: "mcp", SCP_SWARM_BIN: SWARM }) },
  { command: ["codex", "exec", "hi"], env: baseEnv({ CODEX_HOME: `${F}/codex/present`, SCP_NATIVE: "1", SCP_SWARM_BIN: SWARM }) },
  { command: ["codex"], env: baseEnv({ SCP_NATIVE: "1", SCP_SWARM_BIN: SWARM }) },
  { command: ["codex", "exec", "hi"], env: { CODEX_HOME: `${F}/codex/none` } },
];
for (const { command, env, cwd, probe } of HARNESS) add("harnessArgv", { command, env: env ?? baseEnv(), cwd: cwd ?? "/", probe: probe ?? false });

const PROBE_ENV = { PATH: "/usr/bin:/bin" };
for (const program of ["codex-skip", "codex-noskip", "codex-fail", "missing", "codex-slow"])
  add("codexSkipsGitCheck", { program: `${F}/bin/${program}`, env: PROBE_ENV });
add("codexSkipsGitCheck", { program: `${F}/bin/codex-args`, env: { ...PROBE_ENV, PROBE_ENV: "yes" } });
each("inGit", "dir", [F, `${F}/nonexistent/deeper`, "/", "/nonexistent-scp-dir/x"]);

const MUSE_ARGS: string[][] = [
  [],
  ["exec", "hi"],
  ["--contributor-mode", "on"],
  ["--contributor-mode"],
  ["--contributor-mode=x"],
  ["--contributor-mode="],
  ["-c", "contributor_mode=true"],
  ["-c", "CONTRIBUTOR=false"],
  ["--config", 'x.contributor.y="on"'],
  ["-c=contributor_mode=1"],
  ["--config=contributor=[1]"],
  ["-c", "contributor_mode"],
  ["-c", "=contributor"],
  ["-c", "model=contributor"],
  ["-c"],
  ["exec", "--", "--contributor-mode", "x"],
  ["--contributor-mode", "off", "-c", "contributor=  true "],
  ["-c", 'contributor="on'],
];
each("museModes", "args", MUSE_ARGS);
for (const args of MUSE_ARGS) add("contributorRefusal", { command: ["muse", ...args] });
each("contributorRefusal", "command", [
  [],
  ["codex", "--contributor-mode"],
  ["env", "nice", "/bin/muse", "--contributor-mode", "x y"],
  ["muse/", "--contributor-mode", "on"],
]);

const MUSE_EXEC: string[][] = [
  [],
  ["exec"],
  ["exec", "hi"],
  ["exec", "hi", "there"],
  ["exec", "--", "hi"],
  ["exec", "--", "hi", "there"],
  ["--model", "m", "exec", "--json", "hi"],
  ["--model=m", "exec", "--session-id", "abc", "hi"],
  ["exec", "--session-id=one", "--session-id", "two"],
  ["exec", "--session-id"],
  ["-w", "create", "exec", "-w", "hi"],
  ["--worktree", "existing", "exec", "--worktree", "off"],
  ["-w", "exec", "hi"],
  ["exec", "--no-session-log", "hi"],
  ["exec", "--api-key-stdin"],
  ["--no-session-log=1", "exec"],
  ["run", "hi"],
  ["--prompt-file", "p.md", "--image", "i.png", "exec", "--worktree-base", "b", "--effort", "high"],
  ["exec", "-x=1", "--", "p"],
  ["--", "exec"],
  ["-c", "a=b", "exec", "--config", "x"],
];
each("museExec", "args", MUSE_EXEC);
for (const args of MUSE_EXEC) for (const start of [0, 1, 2]) add("museOptionsEnd", { args, start });
each("museModeAt", "args", MUSE_EXEC);
for (const args of MUSE_EXEC) add("museFirstRun", { command: ["nice", "muse", ...args] });
for (const args of MUSE_EXEC) add("museResumeBase", { command: ["muse", ...args], session: "s-1" });
add("museFirstRun", { command: ["codex", "exec"] });
add("museResumeBase", { command: [], session: "s" });

const STDIN: string[][] = [
  [],
  ["claude", "-p", "x"],
  ["codex"],
  ["codex", "exec"],
  ["codex", "exec", "hi"],
  ["codex", "exec", "-"],
  ["codex", "exec", "hi", "-"],
  ["codex", "exec", "review"],
  ["codex", "exec", "resume", "id"],
  ["codex", "exec", "resume", "id", "p"],
  ["codex", "exec", "resume", "--last", "p"],
  ["codex", "exec", "resume", "--last"],
  ["codex", "exec", "resume", "--last", "-"],
  ["codex", "exec", "--", "-"],
  ["env", "X=1", "codex", "e", "--json", "p"],
  ["codex-cli", "exec", "p"],
];
each("closedStdin", "command", STDIN);

const PROMPTS: string[][] = [
  ...STDIN,
  ["claude", "hi"],
  ["claude", "-p"],
  ["claude", "-p", ""],
  ["claude", "-p", "--model", "opus"],
  ["claude", "-p", "--model", "opus", "do it", "--verbose"],
  ["claude", "--print", "a", "b"],
  ["claude", "-p", "--", "multi", "word", "prompt"],
  ["claude", "-p", "--"],
  ["claude", "-p", "x", "--", ""],
  ["claude", "-r", "id", "-p"],
  ["claude", "-p", "--resume", "id"],
  ["codex", "exec", "--", "p"],
  ["codex", "exec", "--", "-"],
  ["codex", "exec", "--"],
  ["codex", "exec", "--", ""],
  ["codex", "exec", ""],
  ["codex", "exec", "-m", "x", "p"],
  ["codex", "exec", "--model=x", "p"],
  ["codex", "exec", "-o", "f", "--color", "c", "p"],
  ["codex", "-m", "x", "-c", "y", "exec", "p"],
  ["codex", "--", "exec", "p"],
  ["codex", "e", "resume", "p"],
  ["timeout", "9", "codex", "exec", "p"],
  ["grok", "-p", "x"],
];
each("promptAt", "command", PROMPTS);
each("spawnPrompt", "command", PROMPTS);

const RESUMES: string[][] = [
  ["codex", "exec", "p"],
  ["codex", "exec"],
  ["codex", "exec", "-"],
  ["codex", "exec", "p", "q"],
  ["codex", "exec", "review"],
  ["codex", "exec", "resume", "x"],
  ["codex", "exec", "--ephemeral", "p"],
  ["codex", "exec", "--ephemeral=1", "p"],
  ["codex", "-m", "o3", "exec", "-m", "o4", "--json", "p"],
  ["codex", "exec", "-s", "read-only", "p"],
  ["codex", "exec", "--sandbox", "workspace-write", "p"],
  ["codex", "exec", '--sandbox=danger "full"', "p"],
  ["codex", "exec", "p", "-s"],
  ["codex", "exec", "-i", "a.png", "--image", "b.png", "--worktree", "--thread-source=x", "p"],
  ["codex", "exec", "--full-auto", "--skip-git-repo-check", "-c", "k=v", "--enable", "f", "p"],
  ["codex", "exec", "--json", "-o", "out.txt", "--output-schema", "s.json", "p"],
  ["codex", "exec", "--color", "never", "--add-dir", "/x", "-C", "/y", "p"],
  ["codex", "exec", "--", "p"],
  ["codex", "exec", "-", "--json"],
  ["env", "A=1", "codex", "-a", "never", "e", "p", "--json"],
  ["claude", "-p", "x"],
  ["codex", "exec", "--profile=x", "p"],
  ["codex", "exec", "-p", "prof", "p"],
];
for (const command of RESUMES) add("resumeArgv", { command, session: "019a-thread", prompt: "steer: go" });

const STEERS: unknown[] = [
  { key: "abc123", parent: "me/lead" },
  { key: "ABC123", parent: "me/lead" },
  { key: "abc12", parent: "me/lead" },
  { key: "abc123", parent: "me lead" },
  { key: "abc123", parent: "me]lead" },
  { key: "abc123", parent: "" },
  { key: "abc123", parent: "me/\u00a0lead" },
  { key: "abc123", parent: "émile" },
  { key: 123456, parent: "x" },
  { key: "abc123" },
  "abc123",
  null,
];
for (const steer of STEERS) add("steerArgv", { command: ["claude", "-p", "do it"], steer });
for (const command of [
  ["claude", "-p", "--", "a", "b"],
  ["codex", "exec", "--json", "p", "--color", "x"],
  ["codex", "exec"],
  ["grok", "-p", "x"],
])
  add("steerArgv", { command, steer: { key: "zz9zz9", parent: "lead" } });

const TITLES: string[] = [
  "fix the build",
  "",
  "   \n\n  second line wins  \nthird",
  "tabs\tand  \u00a0 nbsp\u3000ideographic\u2028ls",
  "ctrl \u0007bell \u001b[31mred\u001b[0m \u200bzwsp \ufeffbom\u0085nel",
  "crlf line\r\nnext",
  "\r\n\r\nafter crlfs",
  "\u0001\u0002\n\u0003visible",
  "word ".repeat(20),
  `${"a".repeat(63)}😀tail`,
  `${"a".repeat(62)}😀tail`,
  `${"a".repeat(64)}😀`,
  `${"a".repeat(63)}😀`,
  `${"a".repeat(60)}     ${"b".repeat(10)}`,
  "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 please",
  "use sk-ant-abcdefghijklmnopqrstuvwxyz now",
  `${"x".repeat(50)} AKIAABCDEFGHIJKLMNOP`,
  `${"x".repeat(56)} password=hunter2hunter2hunter2hunter2`,
  `${"x".repeat(40)} ghp_abcdefghijklmnopqrstuvwxyz0123456789abcdef`,
  "Émile ÑANDÚ İstanbul ß ﬀ",
  "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
];
for (const prompt of TITLES) add("spawnTitle", { command: ["claude", "-p", prompt] });
add("spawnTitle", { command: ["claude", "-p", "--", "multi", "word"] });
add("spawnTitle", { command: ["codex", "exec", "  codex prompt  "] });
add("spawnTitle", { command: ["codex", "exec"] });

each("workerName", "command", [
  [],
  ["codex"],
  ["/usr/local/bin/Claude-Code"],
  ["env", "A=1", "./my agent.sh"],
  ["ÜBER"],
  ["--weird--"],
  ["___"],
  ["a..b__c--d"],
  ["\u0130x"],
  ["\u212a"],
  ["ΑΣ"],
  ["x".repeat(80)],
  [`a${"-".repeat(60)}b`],
  ["数字ab"],
  [""],
  ["/"],
  ["muse/"],
]);

each("splitSpawn", "args", [
  [],
  ["codex", "exec"],
  ["--name", "w", "codex"],
  ["--name=w", "codex"],
  ["--bg", "--title", "t", "--", "codex"],
  ["--", "--x"],
  ["-x", "codex"],
  ["--unknown", "codex"],
  ["--as", "--bg"],
  ["--name"],
  ["--handback-bytes", "100", "--no-push", "claude", "-p", "x"],
  ["--constructor", "x"],
  ["--__proto__", "x"],
  ["--", "--"],
  ["--allow", "a", "--allow", "b", "c"],
]);

const DEFAULTS: [string, unknown][][] = [
  [],
  [["name", "given"]],
  [["title", "given"]],
  [
    ["bg", true],
    ["as", "me"],
  ],
];
for (const values of DEFAULTS)
  for (const command of [["claude", "-p", "a prompt"], ["codex"], [], ["claude", "-p", "token=abcdefghij1234567890abcd"]])
    add("spawnDefaults", { values, command });

each("handbackBytes", "value", ["1", "16384", "16385", "0", "", "007", "12a", " 5", "5\n", "-1", "1.5", "1e3", "99999999999999999999999", "٣"]);

const AGY = ["agy", "-p", "x"];
for (const home of ["full", "partial", "surrogate", "scalar", "invalid", "array", "null", "missing"])
  add("agyNote", { command: AGY, env: { HOME: `${F}/agy/${home}` } });
for (const command of [
  ["agy"],
  ["agy", "--prompt=x"],
  ["agy", "--print", "x", "--dangerously-skip-permissions"],
  ["agy", "--", "-p"],
  ["nice", "/opt/agy", "-p"],
  ["claude", "-p"],
])
  add("agyNote", { command, env: { HOME: `${F}/agy/missing` } });
add("agyNote", { command: AGY, env: { HOME: `${F}/agy/missing` }, verb: "spawn-wake" });

const UUID = "0199aabb-ccdd-7eef-8001-23456789abcd";
const head = (out: string | Buffer, err: string | Buffer) => ({ out: hex(Buffer.from(out as string)), err: hex(Buffer.from(err as string)) });
for (const h of [
  null,
  head("", ""),
  head("", `codex\n--------\nsession id: ${UUID}\n`),
  head("", `session id: ${UUID}\r\nmore`),
  head("", `session id: ${UUID}`),
  head("", `xsession id: ${UUID}\n`),
  head("", `session id: ${UUID.toUpperCase()}\n`),
  head("", `session id: ${UUID}x\n`),
  head("", `a\rsession id: ${UUID}\u2028`),
  head("", `\ufeffsession id: ${UUID}\n`),
  head("", cat([0xff], `\nsession id: ${UUID}\n`)),
  head(`{"type":"thread.started","thread_id":"${UUID}"}\n{"type":"x"}`, ""),
  head(`{"type":"thread.started","thread_id":"${UUID}"}\r\n`, ""),
  head(`{"type":"thread.started","thread_id":"${UUID}"} \n`, ""),
  head(`{"type":"x"}\n{"type":"thread.started","thread_id":"${UUID}"}\n`, ""),
  head(`{"type":"thread.started","thread_id":"${UUID}"}`, "session id: 0199aabb-ccdd-7eef-8001-000000000000\n"),
  head(`\ufeff{"type":"thread.started","thread_id":"${UUID}"}`, ""),
])
  add("codexThread", { head: h });

const OUTPUTS: [Buffer, boolean, number | null][] = [
  [Buffer.from(""), false, null],
  [Buffer.from("done\n"), false, null],
  [Buffer.from("partial first line\nsecond\nthird"), true, null],
  [Buffer.from("no newline at all"), true, null],
  [cat([0x98, 0x80], "é tail\nkept"), true, null],
  [cat([0x98, 0x80], "é tail\nkept"), false, null],
  [cat("bad ", [0xff, 0xc3], " bytes ", [0xe2, 0x82], "!"), false, null],
  [cat([0xef, 0xbb, 0xbf], "bom start"), false, null],
  [cat([0x80, 0xef, 0xbb, 0xbf], "bom after cut\nnext"), true, null],
  [Buffer.from("\u001b[1mbold\u001b[0m and \u001b]0;title\u0007 osc\nprogress 10%\rprogress 100%\r\n"), false, null],
  [Buffer.from("key ghp_abcdefghijklmnopqrstuvwxyz0123456789 end"), false, null],
  [Buffer.from(`${"line\n".repeat(50)}last`), false, 64],
  [Buffer.from("x".repeat(300)), false, 100],
  [Buffer.from(`${"y".repeat(300)}\nshort`), false, 100],
  [Buffer.from("a\nb\nc"), false, 5],
  [Buffer.from("abcdef"), false, 3],
  [Buffer.from("  padded  \n\n"), false, null],
  [Buffer.from("tail\n-----END RSA PRIVATE KEY-----\nafter key"), false, null],
];
for (const [tail, cut, bytes] of OUTPUTS) add("harnessOutput", { tail: hex(tail), cut, bytes });

const ERRS: [Buffer, boolean, number | undefined][] = [
  [Buffer.from(""), false, undefined],
  [Buffer.from(""), true, undefined],
  [Buffer.from("error: boom\n"), false, undefined],
  [Buffer.from("cut first\nerror: boom\n"), true, undefined],
  [Buffer.from("only partial"), true, undefined],
  [Buffer.from("cut first\n"), true, undefined],
  [cat([0x80, 0x80], "x\nwarn ", [0xff], "\n"), true, undefined],
  [Buffer.from(`${"e".repeat(2000)}\nfinal error`), false, undefined],
  [Buffer.from("line of stderr\n".repeat(200)), false, undefined],
  [Buffer.from("é".repeat(800)), false, undefined],
  [Buffer.from("é".repeat(800)), false, 101],
  [Buffer.from("aaa\nbbb\nccc"), false, 5],
  [Buffer.from("aaa\nbbb\nccc"), false, 4],
  [Buffer.from("aaa\nbbb\n"), false, 0],
  [Buffer.from("abc"), false, -1],
  [Buffer.from("\u001b[31mred\u001b[0m\r\nprogress 1\rprogress 2\nsk-ant-abcdefghijklmnopqrstuvwxyz"), true, undefined],
];
for (const [err, cut, bytes] of ERRS) add("stderrOutput", { err: hex(err), cut, ...(bytes === undefined ? {} : { bytes }) });

const P = `${F}/claude/projects`;
const TRANSCRIPTS: Record<string, unknown>[] = [
  { path: `${P}/p/s1.jsonl`, session: "s1", root: P },
  { path: `${P}/p/s1.jsonl`, session: "s1", root: P, bytes: 600 },
  { path: `${P}/p/s1.jsonl`, session: "s1", root: P, bytes: 1 },
  { path: `${P}/p/s1.jsonl`, session: "s1", root: P, bytes: 0 },
  { path: `${P}/p/s1.jsonl`, session: "other", root: P },
  { path: `${P}/p/s1.jsonl`, session: "s1", root: `${P}/p` },
  { path: `${P}/p/s1.jsonl`, session: "s1", root: `${F}/claude/outside` },
  { path: `${P}/p/../p/s1.jsonl`, session: "s1", root: P },
  { path: "claude/projects/p/s1.jsonl", session: "s1", root: P },
  { path: `${P}/p/s2.jsonl`, session: "s2", root: P },
  { path: `${P}/p/s3.jsonl`, session: "s1", root: P },
  { path: `${P}/p/s3.jsonl`, session: "s3", root: P },
  { path: `${P}/p/s4.jsonl`, session: "s4", root: P },
  { path: `${P}/p/s5.jsonl`, session: "s5", root: P },
  { path: `${P}/p/link.jsonl`, session: "link", root: P },
  { path: `${P}/p/dir.jsonl`, session: "dir", root: P },
  { path: `${P}/p/missing.jsonl`, session: "missing", root: P },
  { path: `${P}/p/s1.jsonl`, session: "s1", root: `${F}/nonexistent` },
  { path: `${F}/claude/outside/s1.jsonl`, session: "s1", root: P },
  { path: `${P}/p/s1.jsonl/`, session: "s1", root: P },
];
for (const input of TRANSCRIPTS) add("transcriptReplies", input);

const REPORT = "Summary:\n- fixed the build\n- added tests";
const REPLIES: [string[], number | undefined][] = [
  [[], undefined],
  [["[earlier output cut]"], undefined],
  [["  ", "\n"], undefined],
  [["one", "two"], undefined],
  [[REPORT, `Done. ${REPORT}`], undefined],
  [[REPORT, "Done.\n  - fixed the build\n- added tests  \nSummary:"], undefined],
  [["single line", "single line again single line"], undefined],
  [["[earlier output cut]", "kept", REPORT, REPORT], undefined],
  [["crlf\r\nreply\rold mac"], undefined],
  [["\u001b[31mred\u001b[0m reply ghp_abcdefghijklmnopqrstuvwxyz0123456789"], undefined],
  [["a".repeat(30), "b".repeat(30), "c".repeat(30)], 70],
  [["a".repeat(30), "b".repeat(30), "c".repeat(30)], 62],
  [["a".repeat(30), "b".repeat(30), "c".repeat(30)], 20],
  [["first\nsecond\nthird line that is long"], 20],
  [["x".repeat(100)], 10],
  [["é".repeat(50)], 31],
  [["[earlier output cut]", "a".repeat(40)], 30],
  [["one", "[earlier output cut]"], undefined],
];
for (const [replies, bytes] of REPLIES) add("repliesOutput", { replies, ...(bytes === undefined ? {} : { bytes }) });

function goldens(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-goldens-"));
  swarmBin = join(dir, "swarm");
  writeFileSync(swarmBin, `#!/bin/sh\necho "swarm ${pkg.version}"\n`);
  chmodSync(swarmBin, 0o755);
  try {
    const rows = cases.map(({ fn, input }) => {
      const run = RUNNERS[fn];
      if (!run) throw new Error(`no runner for ${fn}`);
      return { fn, input, output: placeheld(run(real(input))) };
    });
    return `[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]\n`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (MESSAGING.length !== 11) throw new Error("MESSAGING changed: update the native table");

const check = process.argv.includes("--check");
let drifted = false;
if (check) {
  for (const [rel, want] of Object.entries(FILES)) {
    if (!sameFile(join(FIXTURES, rel), want)) {
      console.error(`${join(FIXTURES, rel)} drifted: run bun scripts/spawn-goldens.ts`);
      drifted = true;
    }
  }
} else writeFixtures();
if (!drifted) {
  const text = goldens();
  if (!check) writeFileSync(GOLDENS, text);
  else if (!existsSync(GOLDENS) || readFileSync(GOLDENS, "utf8") !== text) {
    console.error(`${GOLDENS} drifted from the TypeScript CLI: run bun scripts/spawn-goldens.ts`);
    drifted = true;
  }
}
if (drifted) process.exit(1);
