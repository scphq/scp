// Writes the option tables and the argument parsing goldens the native CLI is tested against; --check fails when they drifted.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPTIONS } from "../packages/cli/src/common";
import { hoistIdentity, VERB_OPTIONS, VERBS } from "../packages/cli/src/main";

const root = join(import.meta.dir, "..");
const OPTIONS_FILE = join(root, "crates/scp-cli/src/options.json");
const PARSE_FILE = join(root, "crates/scp-cli/tests/fixtures/parse.json");

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

const check = process.argv.includes("--check");
let drifted = false;
for (const [file, text] of [
  [OPTIONS_FILE, tables()],
  [PARSE_FILE, goldens()],
] as const) {
  if (!check) writeFileSync(file, text);
  else if (readFileSync(file, "utf8") !== text) {
    console.error(`${file} drifted from the TypeScript CLI: run bun scripts/cli-goldens.ts`);
    drifted = true;
  }
}
if (drifted) process.exit(1);
