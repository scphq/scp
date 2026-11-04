// Prints the claude-bg goldens the native policy is tested against: a seeded sample of the planner's input space and the process table,
// config and ref readers on the inputs of claude-bg.test.ts. Run under TZ=UTC by cli-goldens.ts, which writes or checks the file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUNDED } from "../packages/cli/src/claude";
import {
  ancestorsOf,
  attachTargets,
  bgConfig,
  type BgRecord,
  type BgState,
  type ClaudeEntry,
  onlyPollsInbox,
  plan,
  pollsInbox,
  refSession,
  reviveRef,
  runsCommand,
} from "../packages/cli/src/claude-bg";
import { parseSeconds } from "../packages/cli/src/term";

const id = "1a2b3c4d";
const sessionId = `${id}-0000-4000-8000-000000000001`;
const now = Date.parse("2030-01-02T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const lstart = (ms: number) => {
  const [day, month, date, year, time] = new Date(ms).toString().split(" ");
  return `${day} ${month} ${String(Number(date)).padStart(2)} ${time} ${year}`;
};

const helpers = [
  "  4200     1 claude bg-pty-host --bg-pty-host /tmp/d/a.pty.sock 200 50 -- /opt/claude --bg-spare /tmp/d/a.claim",
  "  4242  4200 claude bg-spare --bg-spare /tmp/d/a.claim.sock",
  "  4300  4242 node /opt/scp/cli.js mcp --harness claude --channels",
  "  4301  4242 bun packages/notes/mcp/src/index.ts",
  "  4302  4242 caffeinate -i -t 300",
  "  4303  4242 /bin/sh -c /opt/hooks/on-stop.sh",
  "  5000  4999 /bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-9-b.sh 2>/dev/null || true && eval 'sleep 600'",
  "",
].join("\n");
const running = `${helpers}  4400  4242 /bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && eval 'bash suite.sh' < /dev/null && pwd -P >| /tmp/c-cwd
  4401  4400 bash suite.sh
`;
const loop = `while true; do out=$(swarm inbox --wait 50 2>&1); if echo "$out" | grep -q "relay-message"; then echo "$out"; break; fi; echo "$out" | grep -q "no unread messages" || sleep 10; done`;
const shell = (command: string) =>
  `/bin/zsh -c source /home/u/.claude/shell-snapshots/snapshot-zsh-1-a.sh 2>/dev/null || true && eval '${command.replaceAll("'", `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-ab12-cwd`;
const pollingSince = (started: number) => `${helpers}  4500  4242 ${lstart(now - started)}     ${shell(loop)}
  4501  4500 ${lstart(now - 1000)} node /opt/scp/bin/swarm inbox --wait 50
`;
const polling = pollingSince(1_800_000);
const ci = `${helpers}  4400  4242 ${shell("while gh run view 7 | grep -q in_progress; do sleep 60; done")}\n  4401  4400 sleep 60\n`;
const script = `${helpers}  4400  4242 ${shell("~/tmp/inbox_wait.sh")}\n  4401  4400 /bin/bash /home/u/tmp/inbox_wait.sh\n  4402  4401 node /opt/scp/bin/swarm inbox --wait 50\n`;
const TABLES: (string | null)[] = [
  helpers,
  running,
  polling,
  pollingSince(7_200_000),
  ci,
  script,
  polling.replace("  4501  4500", `  4502  4500 ${shell(loop)}\n  4501  4502`),
  polling.replace(/^( {2}4500 {2}4242) .{24}/m, "$1"),
  polling.replace("swarm inbox --wait 50\n", "python3 -c pass\n"),
  `${polling}  4400  4242 ${shell("bun test")}\n`,
  `${helpers}  4400  4242 /bin/zsh -c -l setopt X && eval 'sleep 9' < /dev/null && pwd -P >| /tmp/claude-e367-cwd\n`,
  running.replace("4400  4242", "4400  4301"),
  "bad line\n4400 4242\n",
  null,
];

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: "worker-id",
  address: "me/w1",
  handle: "w1",
  harness: null,
  parent: "me/lead",
  children: 0,
  subagents: 0,
  harness_session: sessionId,
  state: "done",
  presence: "online",
  historic: false,
  worked_at: iso(now - 3_600_000),
  mail_at: null,
  connections: 1,
  hibernate: null,
  unread: false,
  unread_at: null,
  handed_back: false,
  ...overrides,
});
const child = (overrides: Record<string, unknown> = {}) =>
  agent({ id: "child-id", address: "me/c1", handle: "c1", parent: "me/w1", harness_session: "child-session", state: "working", ...overrides });
const entry = (overrides: Partial<ClaudeEntry> = {}): ClaudeEntry => ({
  id,
  sessionId,
  cwd: "/work",
  kind: "background",
  name: "lane",
  state: "working",
  pid: 4242,
  status: "idle",
  ...overrides,
});
const stopped = (overrides: Partial<ClaudeEntry> = {}): ClaudeEntry => {
  const value = entry({ state: "stopped", ...overrides });
  delete value.pid;
  return value;
};
const unnamed = entry();
delete unnamed.id;
const unstatused = entry();
delete unstatused.status;
const worktree = "/repo/.claude/worktrees/lane";

const ENTRIES: ClaudeEntry[][] = [
  [entry()],
  [entry({ status: "busy" })],
  [entry({ status: "waiting" })],
  [unstatused],
  [stopped()],
  [stopped({ state: "done" })],
  [entry({ cwd: worktree })],
  [stopped({ cwd: worktree })],
  [stopped({ cwd: "/repo/worktrees/lane" })],
  [entry({ kind: "interactive" }), unnamed],
  ["ABCDEF12", "123", "1234567g"].map((bad) => entry({ id: bad })),
  [entry({ pid: 4300 })],
];
const AGENTS: unknown[][] = [
  [agent()],
  [agent({ state: "working" })],
  [agent({ unread: true })],
  [agent({ unread: true, state: "working" })],
  [agent({ parent: null })],
  [agent({ historic: true })],
  [agent({ historic: true, state: "working" })],
  [agent({ historic: true, children: 1 }), child({ historic: true })],
  [agent({ children: 1 })],
  [agent({ children: 1 }), child()],
  [agent({ children: 1 }), child({ presence: "offline", state: "working" })],
  [agent({ children: 2 }), child({ presence: "offline", state: "done" })],
  [agent({ children: 2 }), child({ historic: true }), child({ id: "c2", address: "me/c2", presence: "offline", state: "done" })],
  [agent({ subagents: 2 })],
  [agent({ hibernate: "claude-bg" })],
  [agent({ hibernate: "claude-bg", connections: 0 })],
  [agent({ state: "working", handed_back: true })],
  [agent({ harness_session: null })],
  [agent({ harness_session: "another-session", parent: null })],
  [agent({ harness_session: "another-session", parent: null }), agent({ id: "session-worker", handle: "w2" })],
  [agent({ harness_session: "another", handle: "w2" })],
  [agent({ worked_at: iso(now - 1000) })],
  [agent({ state: "working", worked_at: iso(now - 1000) })],
  [agent({ worked_at: "bogus" })],
  [],
];
const RECORDS: Record<string, BgRecord>[] = [
  { [id]: { file: "/record.json", handle: "w1" } },
  { [id]: { file: "/record.json", handle: "w1", parented: true } },
  {},
];
const STATES: Record<string, BgState>[] = [
  {},
  { [id]: { sessionId, cwd: "/work", rmRefused: { at: now - 1000, reason: "unpushed" } } },
  { [id]: { sessionId, cwd: "/work", rmRefused: { at: now - 86_400_000, reason: "unpushed" } } },
];
const INF = "Infinity";
const CONFIGS: { stopAfterS: number | string; idleAfterS: number | string; remove: "on_stop" | "historic" | false }[] = [
  { stopAfterS: 600, idleAfterS: 600, remove: "historic" },
  { stopAfterS: 600, idleAfterS: 600, remove: "on_stop" },
  { stopAfterS: 600, idleAfterS: 600, remove: false },
  { stopAfterS: 120, idleAfterS: 600, remove: "on_stop" },
  { stopAfterS: 7200, idleAfterS: 7200, remove: "historic" },
  { stopAfterS: 7200, idleAfterS: 1800, remove: "on_stop" },
  { stopAfterS: 1800, idleAfterS: 7200, remove: "historic" },
  { stopAfterS: 600, idleAfterS: INF, remove: "historic" },
  { stopAfterS: INF, idleAfterS: INF, remove: "on_stop" },
];
const OPTIONS: Record<string, unknown>[] = [
  {},
  { stopOnly: true },
  { olderThanS: 1800 },
  { olderThanS: 7200 },
  { olderThanS: 60, stopOnly: true },
  { retryRefused: true },
  { attached: [id] },
  { attached: ["lane"] },
  { attached: [sessionId] },
  { self: [sessionId] },
  { selfPids: [1, 4242] },
];

const seconds = (value: number | string): number => (value === INF ? Number.POSITIVE_INFINITY : (value as number));

function random(seed: number): (limit: number) => number {
  let state = seed;
  return (limit) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % limit) as number;
  };
}

function plans() {
  const pick = random(7);
  const cases = [];
  const rarely = (dim: unknown[], common: number) => (pick(3) === 0 ? pick(dim.length) : pick(common));
  for (let at = 0; at < 3000; at++) {
    const dims = [
      pick(ENTRIES.length),
      pick(AGENTS.length),
      rarely(RECORDS, 2),
      pick(STATES.length),
      pick(CONFIGS.length),
      rarely(OPTIONS, 6),
      rarely(TABLES, 4),
    ];
    const [e, a, r, s, c, o, p] = dims as [number, number, number, number, number, number, number];
    const options = OPTIONS[o]! as { attached?: string[]; self?: string[]; selfPids?: number[] };
    const actions = plan({
      entries: ENTRIES[e]!,
      agents: AGENTS[a]! as never[],
      records: new Map(Object.entries(RECORDS[r]!)),
      states: new Map(Object.entries(STATES[s]!)),
      processes: TABLES[p]!,
      now,
      config: { ...CONFIGS[c]!, stopAfterS: seconds(CONFIGS[c]!.stopAfterS), idleAfterS: seconds(CONFIGS[c]!.idleAfterS) },
      ...OPTIONS[o]!,
      attached: new Set(options.attached ?? []),
      self: new Set(options.self ?? []),
      selfPids: new Set(options.selfPids ?? []),
    });
    cases.push({
      dims,
      actions: actions.map((one) => [one.kind, one.id, one.agent?.id ?? null, one.kind === "keep" ? one.reason : one.kind === "remove" ? one.live : null]),
    });
  }
  return cases;
}

const POLLS = [
  loop,
  "swarm inbox --wait 50",
  `for i in $(seq 1 70); do o=$(swarm inbox --wait=50 --keep --json 2>/dev/null); [ "$o" != "" ] && { echo "$o"; exit 0; }; done; echo idle-timeout`,
  `while :; do node /opt/scp/dist/cli.js inbox --wait 50 | head -5; sleep 5; done`,
  "while true; do timeout 60 swarm inbox --wait 45 --keep --json | grep -q seq && break; done",
  "swarm inbox",
  "bash inbox_wait.sh",
  "while true; do gh pr checks 12 | grep -q pending || break; swarm inbox --wait 50; done",
  "while true; do swarm inbox --wait 50; grep -q done build.log && break; done",
  "until [ -f done ]; do sleep 30; done",
  "while [ ! -f /tmp/build.done ]; do swarm inbox --wait 50; done",
  "while [[ -s out.log ]]; do swarm inbox --wait 50; done",
  "while read -r line; do swarm inbox --wait 50; done < queue.txt",
  "while true; do swarm inbox --wait 50 | grep -q COMPLETE build.log && break; done",
  "while true; do swarm inbox --wait 50 | tail -n 5 out.log; done",
  "swarm send lead hi; swarm inbox --wait 50",
];
const FRAGMENTS = [
  "swarm inbox --wait 50",
  "swarm inbox --wait=5 --json",
  "swarm inbox",
  "/opt/bin/swarm inbox --keep --wait",
  "\\swarm inbox --wait 1",
  "node /x/cli.js inbox --wait 9",
  "bun cli.js inbox --wait",
  "timeout 60 swarm inbox --wait 45",
  "timeout 60 node /x/swarm inbox --wait",
  "swarm send x",
  "sleep 5",
  "echo 'a b' \"c d\"",
  "echo $out",
  "printf x",
  "true",
  ":",
  "break",
  "exit 0",
  "x=1 y=2",
  "A_1=$(date)",
  "! true",
  "[ -f done ]",
  "[ -nt a b ]",
  "[[ -s x ]]",
  "test -z x",
  "test -z",
  "test -d .",
  "grep -q ok",
  "grep -q ok file.txt",
  "jq .x",
  "jq .x y",
  "tr a b",
  "tr a b c",
  "head -5",
  "head 5",
  "tail -n 5",
  "wc -l",
  "cut -d: -f1",
  "gh pr checks",
  "python3 x.py",
  "cat f",
  "for i in 1 2",
  "do",
  "done",
  "then",
  "fi",
  "if true",
  "elif false",
  "while true",
  "until false",
  "2>/dev/null",
  "2>&1",
  ">/dev/null",
  "< /dev/null",
  "</dev/nullx",
  "<in.txt",
  "<<EOF",
  "<<<word",
  "<(cmd)",
  "1>out 2>err",
  ">| f",
  "&>x",
  "'unterminated",
  '"unterminated',
  "é ü",
  "日本語",
  "a b",
];
const SEPARATORS = ["; ", " | ", " || ", " && ", " & ", "\n", " $(", ") ", " ( ", " { ", " } ", " `", "` ", " "];

function polls() {
  const pick = random(11);
  const lines = [...POLLS];
  for (let at = 0; at < 800; at++) {
    let text = FRAGMENTS[pick(FRAGMENTS.length)]!;
    for (let more = pick(5); more > 0; more--) text += SEPARATORS[pick(SEPARATORS.length)]! + FRAGMENTS[pick(FRAGMENTS.length)]!;
    lines.push(text);
  }
  const wrapped = lines.flatMap((text, at) =>
    at % 3 === 0 ? [text, shell(text)] : at % 3 === 1 ? [shell(text)] : [`eval '${text.replaceAll("'", `'"'"'`)}`, `x eval "${text}"`, `medieval '${text}'`],
  );
  return wrapped.map((text) => [text, pollsInbox(text)]);
}

function processes() {
  const rows = [];
  const afters = [undefined, now - 3_600_000, now - 60_000, Number.NaN];
  for (const table of TABLES.filter((one) => one !== null))
    for (const pid of [4242, 4300, 4400, 4500, 1])
      for (const after of afters)
        rows.push([table, pid, after === undefined ? null : Number.isNaN(after) ? "NaN" : after, runsCommand(table, pid), onlyPollsInbox(table, pid, after)]);
  const pick = random(13);
  const tails = [
    " && pwd -P >| /tmp/claude-ab12-cwd",
    " && pwd -P >| /tmp/claude-AB12-cwd",
    " && pwd -P >| /tmp x/claude-ab-cwd",
    " && pwd -P >| /x/claude--cwd",
    " && pwd -P >| claude-ab-cwd",
    " && pwd -P >| /claude-a-cwd x",
    "",
  ];
  const heads = ["sleep 9", "/shell-snapshots/snapshot-1", "/shell-snapshots/other", "x && pwd -P >| /a/claude-1-cwd && pwd -P >| /b/c"];
  for (let at = 0; at < 60; at++) {
    const table = `  1  0 x\n  2  1 Mon Jan  1 00:00:00 2029\n  3  1 Mon Jan  1 00:00:00 2029 ${heads[pick(heads.length)]}${tails[pick(tails.length)]}\n`;
    rows.push([table, 1, null, runsCommand(table, 1), onlyPollsInbox(table, 1)]);
  }
  return rows;
}

const ATTACH = [
  "/opt/bin/claude attach 1a2b3c4d\nbun /x/cli.js claude attach w1\nnode /x/claude/cli.js attach lane\ngit attach x",
  "attach x\nclaude attach\nclaude x attach  y z\n  claude   attach\ty\n",
  "/a/claude-code/bin attach q",
  "",
];
const ANCESTORS: [string, number][] = [
  ["  10     1\n  20    10\n  30    20\n  40    99\n\n", 30],
  ["5 6\n6 5\n", 5],
  ["bad line\n", 77],
  ["7 1\n", 1],
  ["7 x\n", 7],
];

function configs() {
  const root = mkdtempSync(join(tmpdir(), "bg-goldens-"));
  const dir = join(root, "scp");
  mkdirSync(dir);
  const file = join(dir, "config.json");
  const envs: Record<string, string>[] = [
    {},
    { SCP_CLAUDE_BG_STOP_AFTER_S: "900" },
    { SCP_CLAUDE_BG_STOP_AFTER_S: "10m", SCP_CLAUDE_BG_REMOVE: "0" },
    { SCP_CLAUDE_BG_STOP_AFTER_S: "Infinity" },
    { SCP_CLAUDE_BG_STOP_AFTER_S: "bogus" },
    { SCP_CLAUDE_BG_STOP_AFTER_S: " 7.5 " },
    { SCP_CLAUDE_BG_STOP_AFTER_S: "0" },
    { SCP_CLAUDE_BG_IDLE_AFTER_S: "20m", SCP_IDLE_AFTER_S: "Infinity" },
    { SCP_IDLE_AFTER_S: "5m" },
    { SCP_IDLE_AFTER_S: "bogus" },
    { SCP_CLAUDE_BG_IDLE_AFTER_S: "bogus" },
    { SCP_CLAUDE_BG_REMOVE: "on_stop" },
    { SCP_CLAUDE_BG_REMOVE: "true" },
    { SCP_CLAUDE_BG_REMOVE: "1" },
    { SCP_CLAUDE_BG_REMOVE: "historic" },
    { SCP_CLAUDE_BG_REMOVE: "false" },
    { SCP_CLAUDE_BG_REMOVE: "bogus" },
  ];
  const files: unknown[] = [
    {},
    { claude_bg: { stop_after_s: "Infinity", remove: false } },
    { claude_bg: { remove: true } },
    { claude_bg: { remove: "historic" } },
    { claude_bg: { remove: "bogus" } },
    { claude_bg: { remove: 1 } },
    { claude_bg: { stop_after_s: 45, idle_after_s: "1h" }, lifecycle: { idle_after_s: 300 } },
    { lifecycle: { idle_after_s: 300 } },
    { claude_bg: { stop_after_s: -1, idle_after_s: true } },
    { claude_bg: "x", lifecycle: [] },
    [],
    null,
  ];
  const rows = [];
  for (const value of files) {
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    for (const env of envs) {
      const config = bgConfig({ ...env, XDG_CONFIG_HOME: root });
      const number = (one: number) => (Number.isFinite(one) ? one : INF);
      rows.push({ env, file: value, config: { ...config, stopAfterS: number(config.stopAfterS), idleAfterS: number(config.idleAfterS) } });
    }
  }
  rmSync(root, { recursive: true, force: true });
  return rows;
}

const DURATIONS = [
  "90",
  "90s",
  "30m",
  "1h30m",
  "2d",
  "1.5h",
  "1500ms",
  "0.4",
  "1ms",
  "0",
  "0s",
  "",
  " 5m ",
  "5x",
  "m",
  "1h 30m",
  "-1",
  "1.",
  ".5s",
  "5.s",
  "1e3",
  " 7s",
];
function durations() {
  return DURATIONS.map((text) => {
    try {
      return [text, parseSeconds(text, "--older-than")];
    } catch (error) {
      return [text, null, (error as Error).message];
    }
  });
}

const NAMES = [undefined, "lane", "-bad", "a b", `x${"y".repeat(99)}`, `x${"y".repeat(100)}`, "é", "a-b", ""];
function refs() {
  const made = NAMES.flatMap((name) => ["/work", `/${"d".repeat(400)}`].map((cwd) => ({ name: name ?? null, cwd, ref: reviveRef(sessionId, cwd, name) })));
  const reads = [
    ...made.map((one) => one.ref),
    sessionId,
    "{",
    '{"harness":"claude-code"}',
    '{"harness":"claude-code","session":"s1","cwd":"/w","argv":["a"]}',
    "",
  ];
  return { session: sessionId, made, reads: reads.map((ref) => [ref, refSession(ref)]) };
}

const PRINTED = [
  "backgrounded · 1a2b3c4d",
  "backgrounded · 1a2b3c4e extra",
  "backgrounded→1a2b3c4d",
  "started\nbackgrounded  :  deadbeef\n",
  "backgrounded 😀 1a2b3c4d",
  "backgrounded 1a2b3c4d",
  "backgrounded  x 1a2b3c4",
  "backgrounded x y 1a2b3c4d backgrounded z deadbeef",
  "nothing",
];

console.log(
  JSON.stringify({
    id,
    sessionId,
    now,
    dims: { entries: ENTRIES, agents: AGENTS, records: RECORDS, states: STATES, configs: CONFIGS, options: OPTIONS, tables: TABLES },
    plans: plans(),
    polls: polls(),
    processes: processes(),
    attach: ATTACH.map((table) => [table, [...attachTargets(table)].sort()]),
    ancestors: ANCESTORS.map(([table, pid]) => [table, pid, [...ancestorsOf(table, pid)].sort((a, b) => a - b)]),
    configs: configs(),
    durations: durations(),
    refs: refs(),
    backgrounded: PRINTED.map((text) => [text, BACKGROUNDED.exec(text)?.[1] ?? null]),
  }),
);
