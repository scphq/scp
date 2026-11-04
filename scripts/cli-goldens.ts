// Writes the option tables and the argument parsing goldens the native CLI is tested against; --check fails when they drifted.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPTIONS, RelayUsage, type Values } from "../packages/cli/src/common";
import { hookClient } from "../packages/cli/src/hooks";
import {
  fleetLine,
  groupText,
  hoistIdentity,
  holdsArgs,
  printEndpoints,
  printScope,
  printSummary,
  printTree,
  type Snapshot,
  unlisted,
  unspawned,
  VERB_OPTIONS,
  VERBS,
} from "../packages/cli/src/main";
import { printTable } from "../packages/cli/src/term";

const root = join(import.meta.dir, "..");
const OPTIONS_FILE = join(root, "crates/scp-cli/src/options.json");
const PARSE_FILE = join(root, "crates/scp-cli/tests/fixtures/parse.json");
const FLEET_FILE = join(root, "crates/scp-cli/tests/fixtures/fleet.json");
const CLAUDE_BG_FILE = join(root, "crates/scp-cli/tests/fixtures/claude-bg.json");
const SCOPE_FILE = join(root, "crates/scp-cli/tests/fixtures/scope.json");

/** whole command lines after `swarm`; each runs through hoisting, util.parseArgs under Node and the verb's allowed flags */
const CASES: string[][] = [
  ["whoami"],
  ["whoami", "--json"],
  ["--as", "lane", "whoami"],
  ["--as=lane", "--human", "whoami", "--json"],
  ["--human", "--as", "x", "set-now", "a", "b"],
  ["--as", "whoami"],
  ["--as"],
  ["--json", "whoami"],
  ["whoami", "--as", "a", "--as", "b"],
  ["whoami", "--as=", "x"],
  ["whoami", "--as", "-x"],
  ["whoami", "-h", "extra"],
  ["whoami", "--help"],
  ["whoami", "--help=1"],
  ["whoami", "-hx"],
  ["whoami", "-xh"],
  ["whoami", "-h=1"],
  ["whoami", "-x"],
  ["whoami", "--nope"],
  ["whoami", "--no-json"],
  ["whoami", "--json=1"],
  ["whoami", "--json", "--wait", "5"],
  ["whoami", "--machine", "m"],
  ["whoami", "--cloud"],
  ["whoami", "--", "--json"],
  ["whoami", "-"],
  ["whoami", "--=x"],
  ["whoami", "--__proto__"],
  ["whoami", "--__proto__=x"],
  ["whoami", "--constructor"],
  ["whoami", "--ünï"],
  ["whoami", '--a"b'],
  ["set-now", "--as", "x", "fixing", "--json", "the", "build"],
  ["set-now", "--as", "-"],
  ["set-status", "done", "PR", "open", "--as=me/x"],
  ["set-status", "--harness", "--json"],
  ["set-status", "--harness", "codex", "--human"],
  ["set-title", ""],
  ["set-title", "--", "--as", "x"],
  ["event", "tool", "--tool", "Bash", "--summary", "ran tests"],
  ["event", "--tool=", "--summary"],
  ["event", "--attach", "a"],
  ["send", "x", "--attach", "a", "--attach=b", "--attach", "c"],
  ["send", "--attach"],
  ["log", "--scope", "x"],
  ["log", "--scope=x"],
  ["list", "--scope", "x"],
  ["admin", "--tree", "me/a"],
  ["admin", "--tree"],
  ["list", "--tree", "--all"],
  ["daemon"],
  ["daemon", "--idle", "10m", "--policy", "p.json"],
  ["daemon", "stop"],
  ["daemon", "restart", "--json"],
  ["daemon", "--idle"],
  ["daemon", "--as", "x"],
  ["spawn-env", "--name", "n", "--peek", "local", "--allow", "a", "--allow", "b"],
  ["inbox", "--wait", "-1"],
  ["inbox", "--wait=-1"],
  ["whoami", "--cloud", "--json", "--bogus"],
  ["whoami", "--json", "--json"],
  ["whoami", "--as", "a", "--human", "--harness", "h", "--machine=m"],
  ["rules", "set", "--allow", "a", "--allow=b,c", "--scope", "tree", "--in", "x"],
  ["rules", "widen", "me/a", "--out"],
  ["group", "create", "g", "--rules", "a,b", "--json"],
  ["group", "ls", "--all"],
  ["admin", "grant", "me/a", "--tree", "me/r", "--group", "g"],
  ["holds", "refuse", "h", "--reason", "no", "--redacted"],
  ["holds", "ls", "--all", "--reason="],
  ["peek", "me/a", "--turns", "2", "--full", "--who"],
  ["peek", "--turns"],
  ["set-peek", "on", "--all"],
  ["spawn-env", "--json"],
  ["spawn-env", "--title", "a b", "--scope", "tree", "--group", "g", "--ttl", "1h", "--under", "me/x"],
];

const NODE_PARSE = `
const { parseArgs } = require("node:util")
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"))
const out = input.cases.map(({ verb, rest }) => {
  try {
    const { values, positionals } = parseArgs({ args: rest, options: { ...input.options, ...input.verbOptions[verb] }, allowPositionals: true, strict: true })
    return { values: Object.entries(values), positionals }
  } catch (error) {
    return { error: error.message }
  }
})
process.stdout.write(JSON.stringify(out))
`;

type Parsed = { values: [string, unknown][]; positionals: string[] } | { error: string };

function goldens(): string {
  const hoisted = CASES.map((argv) => {
    const [verb, ...rest] = hoistIdentity(argv);
    return { argv, verb: verb ?? "", rest };
  });
  const known = hoisted.filter((item) => VERBS[item.verb]);
  const node = spawnSync("node", ["-e", NODE_PARSE], {
    input: JSON.stringify({ options: OPTIONS, verbOptions: VERB_OPTIONS, cases: known }),
    encoding: "utf8",
  });
  if (node.status !== 0) throw new Error(`node failed: ${node.stderr}`);
  const parsed = JSON.parse(node.stdout) as Parsed[];
  const rows = hoisted.map(({ argv, verb, rest }) => {
    const at = known.findIndex((item) => item.argv === argv);
    if (at < 0) return { argv, verb, rest, unknown: true };
    const result = parsed[at]!;
    if ("error" in result) return { argv, verb, error: result.error };
    const extra = result.values.find(([key]) => !(VERBS[verb] as string[]).includes(key));
    if (extra && !result.values.some(([key]) => key === "help")) return { argv, verb, error: `swarm ${verb} does not take --${extra[0]}` };
    return { argv, verb, values: result.values, positionals: result.positionals };
  });
  return `[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]\n`;
}

function tables(): string {
  return `${JSON.stringify({ options: OPTIONS, verb_options: VERB_OPTIONS, verbs: VERBS }, null, 2)}\n`;
}

/** the lines `run` prints, through console.log or stdout */
function printed(run: () => unknown): { lines: string[]; result: unknown } {
  const lines: string[] = [];
  const log = console.log;
  const write = process.stdout.write;
  console.log = (line: string) => lines.push(`${line}\n`);
  process.stdout.write = ((chunk: string) => lines.push(chunk)) as typeof process.stdout.write;
  try {
    const result = run();
    return { lines: lines.join("").split("\n").slice(0, -1), result };
  } finally {
    console.log = log;
    process.stdout.write = write;
  }
}

const HOME = "/home/u";
const at = "a while ago";
const agent = (address: string, extra: Record<string, unknown> = {}) => ({
  id: `ep_${address}`,
  address,
  kind: "agent",
  harness: "codex",
  cwd: null,
  labels: {},
  title: null,
  presence: "online",
  status: null,
  parent: null,
  wake: null,
  ...extra,
});
const human = { id: "ep_me", address: "me/", kind: "human", harness: "human", cwd: null, labels: {}, title: null, presence: "offline", status: null };
const FLEET = [
  human,
  agent("me/lead", {
    title: "Lead — ünïcode 😀",
    labels: { role: "lead", "10": "x", machine: "laptop", a: "b" },
    status: { state: "working", note: 'fix "it" \\ now' },
    cwd: `${HOME}/src/app`,
    wake: "spawn",
  }),
  agent("me/kid", {
    parent: "me/lead",
    status: { state: "blocked", note: "ci red" },
    cwd: HOME,
    scope: "tree",
    runner: { name: "tmux", attach: "tmux attach -t kid" },
  }),
  agent("me/grandkid", { parent: "me/kid", harness: "claude-code", presence: "idle", status: { state: "waiting", note: "" }, peekable: "local" }),
  agent("me/w_1", { harness: "claude-code", title: "日本語", labels: { lane: "a" }, status: { state: "waiting", note: "review" } }),
  agent("me/w-2", { harness: "claude-code", presence: "hibernated", cwd: "/elsewhere" }),
  agent("me/Zed", { harness: "grok", presence: "offline", status: { state: "done", note: "x" }, labels: { machine: "desk" } }),
  agent("me/old", { presence: "offline", historic: true }),
  agent("me/far", { labels: { machine: "Apex" }, harness: "pi", parent: "me/far" }),
  agent("me/loop-a", { parent: "me/loop-b" }),
  agent("me/loop-b", { parent: "me/loop-a" }),
];
const ME = FLEET[2];

function fleetGoldens(): string {
  const saved = process.env.HOME;
  process.env.HOME = HOME;
  try {
    const tables = [
      [
        ["A", "B", ""],
        ["😀x", "é", ""],
      ],
      [
        ["X", "Y"],
        ["a ", "b "],
        ["", ""],
      ],
    ].map((rows) => ({ rows, lines: printed(() => printTable(rows)).lines }));
    const views = [
      { fleet: FLEET, me: null },
      { fleet: FLEET, me: ME },
      { fleet: FLEET.slice(0, 3), me: human },
      { fleet: [human], me: null },
    ].map(({ fleet, me }) => {
      const { shown, hidden, historic } = unlisted(fleet as never[], false);
      return {
        fleet,
        me,
        endpoints: printed(() => printEndpoints(fleet as never[], me as never, "laptop")).lines,
        tree: printed(() => printTree(fleet as never[], me as never)).lines,
        unlisted: { shown: (shown as { address: string }[]).map((e) => e.address), hidden, historic },
        unspawned: [...unspawned(fleet as never[], me as never)].sort(),
      };
    });
    const summaries = [
      { snapshot: { endpoints: FLEET, activity: [], unread: { "me/w-2": 2, "me/kid": 0, "me/Zed": 1, "me/a_b": 3, "10": 1 } }, me: null, all: false },
      { snapshot: { endpoints: FLEET, activity: [] }, me: ME, all: true },
      { snapshot: { endpoints: [human], activity: [] }, me: human, all: false },
      { snapshot: { endpoints: FLEET, activity: [] }, me: { ...ME, title: 'say "hi"', harness: null }, all: false },
    ].map(({ snapshot, me, all }) => {
      const { lines, result } = printed(() => printSummary(snapshot as unknown as Snapshot, me as never, all));
      return { snapshot, me, all, lines, quotes: result };
    });
    const events = [
      { at, type: "presence", endpoint: "me/a", presence: "online", harness: "pi" },
      { at, type: "presence", endpoint: "me/a", presence: "offline" },
      { at, type: "message", from: "me/a", to: ["me/b", "me/c"], kind: "ask", id: "msg_1", hop: 2 },
      { at, type: "message", from: "me/a", to: ["me/b"], kind: "message", id: "msg_2", hop: 0 },
      { at, type: "status", endpoint: "me/a", status: { state: "waiting", note: 'on "x"' } },
      { at, type: "status", endpoint: "me/a", status: null },
      { at, type: "activity", endpoint: "me/a", agent: "Plan 9a", kind: "tool", tool: "Edit", summary: "did \\ it" },
      { at, type: "activity", endpoint: "me/a", agent: null, kind: "turn", tool: null, summary: "" },
      { at, type: "lagged", z: { "2": 1, b: [1.5, null] } },
    ].map((event) => ({ event, line: fleetLine(event) }));
    const words = [
      "b",
      "B",
      "a-b",
      "ab",
      "a_b",
      "aB",
      "Ab",
      "a1",
      "a.b",
      "me/x",
      "me/X",
      "me-x",
      "a",
      "A",
      "me/a/b",
      "me/a-b",
      "~",
      "$",
      " x",
      "x y",
      "me/10",
      "aé",
      "áe",
      "aë",
      "AE",
      "aÉ",
      "aez",
      "æa",
      "aeb",
      "Æ",
      "SS",
      "ssa",
      "ßa",
      "sß",
      "st",
      "me/9",
      "é",
      "è",
      "ê",
      "ë",
      "É",
      "ecl",
      "éclair",
      "eclair",
      "Éclair",
      "zulu",
      "ä",
      "ñ",
      "ö",
      "ø",
      "ß",
      "ss",
      "ü",
      "ç",
      "ÿ",
      "Å",
      "å",
      "æ",
      "ae",
      "Ærø",
      "Ñu",
      "ìo",
      "Óz",
      "õ",
    ];
    const sorted = [...words].sort((a, b) => a.localeCompare(b));
    const hooks = [
      "[ -x '/opt/scp-hook' ] && exec '/opt/scp-hook' swarm hook claude || exec swarm hook claude",
      "[ -x '/opt/scp-hook' ] && exec '/opt/scp-hook' swarm hook claude || exec swarm hook codex",
      "/opt/bin/scp-hook swarm hook codex",
      "/opt/bin/scp-hook/ node cli.js hook codex",
      "swarm hook claude",
      "'open",
      ["/bin/sh", "-c", '[ -x "$0" ] && exec "$0" "$@"; exec "$@"', "/opt/scp-hook", "swarm", "hook", "agy"],
      ["/opt/scp-hook", "swarm", "hook"],
      ["/opt/scp-hook", 1, "hook"],
      42,
    ].map((command) => ({ command, client: hookClient(command) ?? null }));
    return `${JSON.stringify({ tables, views, summaries, events, sorted, hooks }, null, 2)}\n`;
  } finally {
    process.env.HOME = saved;
  }
}

/** what `holdsArgs` returns for `words`, or the usage error it throws */
function holdsCase(words: string[], values: Values) {
  try {
    return { words, values, args: holdsArgs(values, words) };
  } catch (error) {
    if (!(error instanceof RelayUsage)) throw error;
    return { words, values, error: error.message };
  }
}

function scopeGoldens(): string {
  const views = [
    { address: "me/a", preset: "open", tree: "me/a", parent: null, depth: 0, rules: {}, caps: [], groups: [] },
    {
      address: "me/kid",
      preset: "custom",
      tree: "me/r",
      parent: "me/r",
      depth: 2,
      rules: { in: [], out: ["ep:b", "*"] },
      caps: [
        { id: "cap_1", dir: "in", by: "me/r", sels: [{ sel: "tree:parent" }, { sel: "ep:x", via: "me/r" }] },
        { id: "group:g:out", dir: "out", by: "group:g", sels: [] },
      ],
      groups: ["g", "ünï"],
    },
  ].map((view) => ({ view, lines: printed(() => printScope(view as never)).lines }));
  const groups = [
    [],
    [
      { name: "g", owner: "me/a", members: 1, pinned: true, policy: false },
      { name: "h", owner: "me/b", members: 0, pinned: false, policy: true, ignored: "no such tree" },
    ],
    { name: "g", dropped: true },
    { name: "g", endpoint: "me/a", member: true },
    { name: "g", endpoint: "me/a", member: false },
    { name: "g", owner: "me/a", tree: null, pinned: false, members: [], rules: {} },
    { name: "g", owner: "me/a", tree: "me/r", pinned: true, members: ["me/a", "me/b"], rules: { in: [{ sel: "ep:a", via: "me/r" }, { sel: "*" }], out: [] } },
    { z: 1, "2": [true], a: { y: null, b: "é" } },
    null,
  ].map((result) => ({ result, text: groupText(result) }));
  const holds = [
    [[], {}],
    [["ls", "h"], {}],
    [["show"], {}],
    [["nope", "h"], {}],
    [["show", "h", "x"], {}],
    [["show", "h"], { redacted: true }],
    [["release", "h"], { redacted: true, reason: "x" }],
    [["release", "h"], { all: true }],
    [["refuse", "h"], {}],
    [["refuse", "h"], { reason: " \t\n" }],
    [["refuse", "h"], { reason: "spam" }],
    [["ls"], { all: true }],
    [[""], {}],
  ].map(([words, values]) => holdsCase(words as string[], values as Values));
  return `${JSON.stringify({ views, groups, holds }, null, 2)}\n`;
}

/** the claude-bg goldens, printed under UTC so `ps` start times read the same on every machine */
function claudeBgGoldens(): string {
  const run = spawnSync(process.execPath, [join(import.meta.dir, "claude-bg-goldens.ts")], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
    maxBuffer: 1 << 26,
  });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout;
}

const check = process.argv.includes("--check");
let drifted = false;
for (const [file, text] of [
  [OPTIONS_FILE, tables()],
  [PARSE_FILE, goldens()],
  [FLEET_FILE, fleetGoldens()],
  [CLAUDE_BG_FILE, claudeBgGoldens()],
  [SCOPE_FILE, scopeGoldens()],
] as const) {
  if (!check) writeFileSync(file, text);
  else if (readFileSync(file, "utf8") !== text) {
    console.error(`${file} drifted from the TypeScript CLI: run bun scripts/cli-goldens.ts`);
    drifted = true;
  }
}
if (drifted) process.exit(1);
