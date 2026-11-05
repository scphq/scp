// Writes the hooks install and mcp install goldens the native CLI is tested against: the hook commands, the hook files, the merges, every
// install line and file in scratch homes, and the mount builders; --check fails when they drifted.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agyHookSet,
  type HookLaunch,
  hookArgv,
  hookClient,
  hookCommand,
  hookEntries,
  mergeHooks,
  musePlugin,
  opencodePlugin,
  shellQuote,
  shellWords,
} from "../packages/cli/src/hooks";
import { installHooks, mcpInstall } from "../packages/cli/src/install";
import { mountVars, mountWith, pinMode } from "../packages/cli/src/native";
import { hookContent, launcherPrefixes } from "../packages/cli/src/setup";

process.env.TZ = "UTC";
const FILE = join(import.meta.dir, "../crates/scp-cli/tests/fixtures/setup.json");
const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);

const WORDS = [
  "",
  "plain",
  "/opt/swarm",
  "a b",
  "it's",
  "'",
  "''",
  "a'b'c",
  "$HOME",
  "`x`",
  "tab\there",
  "line\nbreak",
  "back\\slash",
  "ünï",
  '"',
  "--flag=1",
  "@scp-dev/cli",
  "a:b+c",
  "x,y",
  "~/bin",
  "*",
  "é",
];
const COMMANDS = [
  "swarm hook claude",
  "  swarm   hook  ",
  "'a b' \"c d\" e\\ f",
  "'open",
  '"open',
  "a\\",
  "x 'it'\\''s' y",
  '"a\\"b" c',
  "",
  "a\u00a0b\u2028c",
];
const LAUNCHES: HookLaunch[] = [
  {},
  { launcher: ["/usr/bin/node", "/opt/scp/@scp-dev/cli/dist/cli.js"] },
  { launcher: ["/opt/my bin/swarm"] },
  { native: "/opt/scp/scp-hook" },
  { native: "/opt/it's here/scp-hook", launcher: ["/usr/bin/node", "/x y/packages/cli/dist/cli.js"] },
  { native: "", launcher: [] },
];

const quote = WORDS.map((word) => ({ word, quoted: shellQuote(word), words: shellWords(shellQuote(word)) ?? null }));
const words = COMMANDS.map((command) => ({ command, words: shellWords(command) ?? null }));
const launches = LAUNCHES.map((launch) => {
  const command = hookCommand(launch, ["hook", "claude", "--subagent"]);
  const argv = hookArgv(launch, ["hook", "muse", "Stop"]);
  return { launch, command, argv, client: hookClient(command) ?? null, argvClient: hookClient(argv) ?? null, prefixes: launcherPrefixes(launch) };
});

const SOME = [LAUNCHES[0]!, LAUNCHES[4]!, LAUNCHES[5]!];
const OPTIONS = [{}, { blockStop: true }, { pushWait: 0 }, { pushWait: 15, blockStop: true }, { cowork: true }];
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const entries = (["claude", "codex"] as const).flatMap((harness) =>
  SOME.flatMap((launch) =>
    OPTIONS.map((options) => ({ harness, options: { ...options, ...launch }, text: json(hookEntries(harness, { ...options, ...launch })) })),
  ),
);
const agy = LAUNCHES.flatMap((launch) => [false, true].map((blockStop) => ({ blockStop, launch, text: json(agyHookSet({ blockStop, ...launch })) })));
const muse = SOME.flatMap((launch) => OPTIONS.map((options) => ({ options: { ...options, ...launch }, text: json(musePlugin({ ...options, ...launch })) })));
const opencode = SOME.flatMap((launch) => [false, true].map((blockStop) => ({ blockStop, launch, text: opencodePlugin({ blockStop, ...launch }) })));

const HANDLERS = [
  "swarm hook claude",
  "swarm hook",
  "swarm hooky",
  "/x/swarm hook codex --push-wait 600",
  "'/a b/swarm' hook claude",
  "'/it'\\''s/swarm' hook claude",
  "'swarm' hook claude",
  "/x/scp-hook swarm hook claude",
  "'/x y/scp-hook' /x/swarm hook claude",
  "node /x/packages/cli/dist/cli.js hook claude --subagent",
  "/usr/bin/node '/a b/@scp-dev/cli/dist/cli.js' hook codex",
  "node /x/cli.js hook claude",
  "node /x/packages/cli/dist/cli.js hook Claude",
  "echo swarm hook claude",
  "swarm hook claude; rm -rf /",
  "myswarm hook",
  "[ -x /opt/scp-hook ] && exec /opt/scp-hook swarm hook claude || exec swarm hook claude",
  "[ -x '/a b/scp-hook' ] && exec '/a b/scp-hook' swarm hook claude || exec swarm hook claude",
  "[ -x '/it'\\''s/scp-hook' ] && exec '/it'\\''s/scp-hook' /usr/bin/node /x/packages/cli/dist/cli.js hook codex || exec x",
  "[ -x /a ] && exec /b swarm hook claude",
  "[ -x /a ] && exec /a  swarm hook claude",
  "/usr/bin/node /opt/custom.js hook claude",
  "/opt/my\\ bin/swarm hook claude",
  "swarm\thook\u00a0claude",
];
const PREFIXES = [[], ["/usr/bin/node /opt/custom.js"]];
const ours = PREFIXES.map((prefixes) => ({
  prefixes,
  kept: HANDLERS.map((command) => {
    const merged = mergeHooks({ hooks: { E: [{ hooks: [{ type: "command", command }] }] } }, {}, prefixes).hooks as Record<string, unknown>;
    return "E" in merged;
  }),
}));

const SETTINGS = [
  "{}",
  '{"model":"x","hooks":null,"after":1}',
  '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"swarm hook claude"},{"type":"command","command":"mine"}]}],"Notification":[{"hooks":[{"command":"other"}]}]}}',
  '{"hooks":{"2":[],"1":[{"hooks":[]}],"Stop":"x","SessionEnd":[{"matcher":"m","hooks":[{"command":"swarm hook claude"}]},[1],"s",null,{"hooks":"no"}],"x":5}}',
  '{"hooks":{"Stop":"ab"}}',
  '{"hooks":{"Stop":{"a":1}}}',
  '{"hooks":{"Stop":5}}',
  '{"hooks":[]}',
  '{"hooks":"x"}',
  "null",
  "[1]",
  '"s"',
  '{"a":1,"a":2,"hooks":{"Stop":[{"hooks":[{"command":["swarm","hook"]},{"command":5},{"command":null},5,null]}]}}',
  '{"n":1e400,"m":-0,"f":1.5e-7,"big":12345678901234567890,"u":"\\u2028\\ud83d\\ude00"}',
  '{"hooks":{"Stop":[{"hooks":[{"command":{"toString":null}}]}]}}',
  '{"hooks":{"Stop":[{"hooks":[{"command":"swarm hook claude"},{"command":[1,[{"toString":1}]]}]}]}}',
  '{"hooks":{"Stop":[{"hooks":[{"command":{"valueOf":1}},{"command":[null,"swarm hook"]},{"command":["swarm hook x",null]}]}]}}',
];
const merges = SETTINGS.flatMap((text) =>
  PREFIXES.map((prefixes) => {
    try {
      return { text, prefixes, out: json(mergeHooks(JSON.parse(text), hookEntries("claude"), prefixes)) };
    } catch (error) {
      return { text, prefixes, error: normalize((error as Error).message) };
    }
  }),
);

/** a message an engine words its own way, the same in either golden */
function normalize(message: string): string {
  return message
    .replace(/is not valid JSON \(.*\)/, "is not valid JSON (<parse error>)")
    .replace(/^.*(is not iterable|Spread syntax).*$/, "<not iterable>")
    .replace(/No default value|Cannot convert object to primitive value/, "<no primitive>")
    .replace(/: (?:\(merged\[event\] \?\? \[\]\) is not iterable|Spread syntax requires .*?);/, ": <not iterable>;");
}

const EXISTING = [
  undefined,
  "{}",
  '{"hooks":{"Stop":[{"hooks":[{"command":"/usr/bin/node /opt/custom.js hook claude"}]}]},"k":1}',
  "{x",
  '{"scp":1,"a":2}',
  "[]",
];
const contents = (["claude", "codex", "agy", "opencode", "muse"] as const).flatMap((kind) =>
  (kind === "opencode" || kind === "muse" ? [undefined] : EXISTING).flatMap((existing) =>
    [
      [false, {}],
      [true, { launcher: ["/usr/bin/node", "/opt/custom.js"], native: "/opt/scp-hook" }],
    ].map(([blockStop, launch]) => {
      try {
        return { kind, existing: existing ?? null, blockStop, launch, out: hookContent(kind, existing, blockStop as boolean, launch as HookLaunch) };
      } catch {
        return { kind, existing: existing ?? null, blockStop, launch, error: true };
      }
    }),
  ),
);

type Run = { harness?: string; scope?: string; write?: boolean; blockStop?: boolean; pushWait?: number; env?: Record<string, string>; cwd?: string };
type Scenario = { name: string; files?: Record<string, string>; modes?: Record<string, number>; links?: Record<string, string>; dirs?: string[]; runs: Run[] };
const OLD_HOOKS = JSON.stringify(
  {
    model: "opus",
    hooks: {
      Stop: [
        {
          hooks: [
            { type: "command", command: "[ -x /gone/scp-hook ] && exec /gone/scp-hook swarm hook claude || exec swarm hook claude" },
            { type: "command", command: "mine" },
          ],
        },
      ],
      Notification: [{ hooks: [{ type: "command", command: "notify" }] }],
    },
    permissions: { allow: ["x"] },
  },
  null,
  4,
);
const SCENARIOS: Scenario[] = [
  { name: "claude prints by default", runs: [{ harness: "claude" }, { harness: "claude", scope: "project" }, { harness: "claude", scope: "user" }] },
  {
    name: "claude writes and is idempotent",
    runs: [
      { harness: "claude", scope: "user", write: true },
      { harness: "claude", scope: "user", write: true },
    ],
  },
  {
    name: "claude merges into a settings file, backs up and keeps its mode",
    files: { "proj/.claude/settings.json": OLD_HOOKS },
    modes: { "proj/.claude/settings.json": 0o600 },
    runs: [
      { harness: "claude", scope: "project", write: true, blockStop: true },
      { harness: "claude", scope: "project", write: true },
    ],
  },
  {
    name: "backups never overwrite each other",
    files: { "proj/.claude/settings.json": "{}", "proj/.claude/settings.json.bak-20300102030405": "old" },
    runs: [{ harness: "claude", scope: "project", write: true }],
  },
  {
    name: "a symlinked settings file is written through",
    files: { "real/settings.json": '{"a":1}' },
    links: { "proj/.claude/settings.json": "../../real/settings.json" },
    runs: [{ harness: "claude", scope: "project", write: true }],
  },
  {
    name: "a dangling symlink is replaced",
    links: { "proj/.claude/settings.json": "../missing.json" },
    dirs: ["proj/.claude"],
    runs: [{ harness: "claude", scope: "project", write: true }],
  },
  {
    name: "the per-person file warns about the shared one",
    runs: [{ harness: "claude", scope: "project", write: true }, { harness: "claude", write: true }, { harness: "claude" }],
  },
  {
    name: "codex at user and project scope",
    runs: [
      { harness: "codex", scope: "user", write: true, pushWait: 0 },
      { harness: "codex", blockStop: true, pushWait: 15 },
      { harness: "codex", write: true, pushWait: 3600 },
    ],
  },
  {
    name: "codex in a subdirectory writes at the git root",
    dirs: ["proj/sub/dir"],
    runs: [{ harness: "codex", write: true, cwd: "proj/sub/dir" }],
  },
  { name: "codex outside git writes in the cwd", dirs: ["loose"], runs: [{ harness: "codex", write: true, cwd: "loose" }] },
  {
    name: "opencode plugins",
    runs: [
      { harness: "opencode", scope: "user", write: true },
      { harness: "opencode", blockStop: true },
      { harness: "opencode", write: true, blockStop: true },
    ],
  },
  {
    name: "agy merges its named set",
    files: { "proj/.agents/hooks.json": '{"other":{"x":1},"scp":{"old":true},"z":[]}' },
    runs: [
      { harness: "agy", write: true },
      { harness: "agy", scope: "user" },
      { harness: "agy", scope: "user", write: true, blockStop: true },
    ],
  },
  {
    name: "agy refuses a hooks file that is no object",
    files: { "proj/.agents/hooks.json": "[1]" },
    runs: [{ harness: "agy", write: true }, { harness: "agy" }],
  },
  {
    name: "muse plugin",
    runs: [{ harness: "muse" }, { harness: "muse", write: true, blockStop: true, pushWait: 0 }, { harness: "muse", scope: "project", write: true }],
  },
  {
    name: "refusals",
    runs: [
      { harness: "grok" },
      { harness: "vim" },
      {},
      { harness: "codex", scope: "local" },
      { harness: "claude", scope: "global" },
      { harness: "claude", env: { SCP_TRANSPORT: "cloud" } },
      { harness: "claude", pushWait: 3601 },
      { harness: "claude", pushWait: 1.5 },
    ],
  },
  {
    name: "unreadable settings",
    files: {
      "proj/.claude/settings.json": "{x",
      "proj/.claude/settings.local.json": "",
      "proj/.codex/hooks.json": "null",
      "home/.codex/hooks.json": '{"hooks":[]}',
    },
    runs: [
      { harness: "claude", scope: "project", write: true },
      { harness: "claude", write: true },
      { harness: "codex", write: true },
      { harness: "codex", scope: "user", write: true, env: { CODEX_HOME: "<root>/home/.codex" } },
      { harness: "claude", scope: "project" },
    ],
  },
  {
    name: "a non-iterable event",
    files: { "proj/.claude/settings.json": '{"hooks":{"Stop":{"a":1},"SessionStart":"ab"}}' },
    runs: [{ harness: "claude", scope: "project", write: true }],
  },
  { name: "a directory where the file goes", dirs: ["proj/.claude/settings.json"], runs: [{ harness: "claude", scope: "project", write: true }] },
  {
    name: "number formatting and key order round-trip",
    files: { "proj/.claude/settings.json": '{"b":1.0,"a":1e21,"10":2,"1":1,"x":"\\u00e9\\n","hooks":{"9":[],"Stop":[]}}' },
    runs: [{ harness: "claude", scope: "project", write: true }],
  },
];

function snapshot(root: string): { files: Record<string, string>; modes: Record<string, number>; links: Record<string, string> } {
  const files: Record<string, string> = {};
  const modes: Record<string, number> = {};
  const links: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      const path = join(dir, name);
      const at = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) links[at] = readlinkSync(path);
      else if (stat.isDirectory()) walk(path, at);
      else {
        files[at] = readFileSync(path, "utf8");
        modes[at] = stat.mode & 0o777;
      }
    }
  };
  walk(root, "");
  return { files, modes, links };
}

function scenario(spec: Scenario) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "setup-goldens-")));
  try {
    mkdirSync(join(root, "proj", ".git"), { recursive: true });
    for (const dir of spec.dirs ?? []) mkdirSync(join(root, dir), { recursive: true });
    for (const [rel, text] of Object.entries(spec.files ?? {})) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    for (const [rel, mode] of Object.entries(spec.modes ?? {})) chmodSync(join(root, rel), mode);
    for (const [rel, to] of Object.entries(spec.links ?? {})) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      symlinkSync(to, join(root, rel));
    }
    const base = { HOME: root, CLAUDE_CONFIG_DIR: join(root, ".claude"), CODEX_HOME: join(root, ".codex"), XDG_CONFIG_HOME: join(root, ".config") };
    const runs = spec.runs.map((run) => {
      const env: Record<string, string> = { ...base };
      for (const [key, value] of Object.entries(run.env ?? {})) env[key] = value.replace("<root>", root);
      const lines: string[] = [];
      let error: { message: string } | undefined;
      try {
        installHooks({
          harness: run.harness,
          ...(run.scope !== undefined ? { scope: run.scope } : {}),
          write: run.write === true,
          blockStop: run.blockStop === true,
          ...(run.pushWait !== undefined ? { pushWait: run.pushWait } : {}),
          env,
          cwd: join(root, run.cwd ?? "proj"),
          out: (line) => lines.push(line),
          now: new Date(NOW),
        });
      } catch (thrown) {
        error = { message: normalize((thrown as Error).message) };
      }
      const strip = (text: string) => text.replaceAll(root, "<root>");
      const after = snapshot(root);
      return {
        run,
        lines: lines.map(strip),
        error: error ? strip(error.message) : null,
        files: after.files,
        modes: after.modes,
        links: after.links,
      };
    });
    return { ...spec, runs };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const HARNESSES = ["claude", "codex", "grok", "opencode", "agy", "muse", "vim", undefined];
const NAMES = [undefined, "lane-impl", "me", "", "Bad Name", "a'b"];
const mcp = HARNESSES.flatMap((harness) =>
  NAMES.map((name) => {
    const lines: string[] = [];
    try {
      mcpInstall(harness, name, (line) => lines.push(line));
      return { harness: harness ?? null, name: name ?? null, lines, error: null };
    } catch (error) {
      return { harness: harness ?? null, name: name ?? null, lines, error: (error as Error).message };
    }
  }),
);

const MOUNT_ENVS = [{}, { SCP_NATIVE: "1" }, { SCP_NATIVE: "mcp" }, { SCP_SWARM_BIN: "/x/swarm" }, { SCP_SWARM_BIN: "", SCP_NATIVE: "mcp" }];
const mounts = [undefined, "/pkg/bin/swarm"].flatMap((bin) =>
  MOUNT_ENVS.map((env) => ({
    bin: bin ?? null,
    env,
    mount: JSON.stringify(mountWith(bin, ["/usr/bin/node", "/x/cli.js"], ["--harness", "claude", "--channels"], env)),
  })),
);
const VARS = [{}, { A: "1", SCP_NATIVE: "1", SCP_CLI_ARGV: "[]", B: "2" }, { SCP_NATIVE: "mcp", "2": "two", SCP_SWARM_BIN: "/y" }, { SCP_NATIVE: "0" }];
const vars = VARS.flatMap((saved) =>
  mounts.map(({ mount }) => ({ vars: JSON.stringify(saved), mount, out: JSON.stringify(mountVars(saved, JSON.parse(mount))) })),
);
const pins = VARS.flatMap((saved) => MOUNT_ENVS.map((env) => ({ vars: JSON.stringify(saved), env, out: JSON.stringify(pinMode(saved, env)) })));

function goldens(): string {
  return json({
    now: NOW,
    quote,
    words,
    launches,
    entries,
    agy,
    muse,
    opencode,
    handlers: HANDLERS,
    ours,
    merges,
    contents,
    scenarios: SCENARIOS.map(scenario),
    mcp,
    mounts,
    vars,
    pins,
  });
}

const text = goldens();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(FILE, "utf8");
  } catch {}
  if (current !== text) {
    console.error(`${FILE} drifted from the TypeScript CLI: run bun scripts/setup-goldens.ts`);
    process.exit(1);
  }
} else writeFileSync(FILE, text);
