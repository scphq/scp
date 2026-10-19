export const SITE = "https://scp.dev";
export const SPEC = "/spec";
export const DOCS = "/docs";
export const REPO = "https://github.com/scphq/scp";
export const DEMO = "https://app.scp.dev";

export const SITE_TITLE = "SCP, the Swarm Communication Protocol";
export const SITE_DESCRIPTION =
  "A protocol for agents in different harnesses to message each other and their human, at the turn boundaries each harness already has.";

export const HERO = {
  label: "Swarm Communication Protocol, version 1",
  title: "The message layer for agent swarms.",
  deck: "Heterogeneous coding agents exchanging messages at turn-level fidelity. Awake or hibernated, any harness, any machine, at swarm scale.",
};

export const DEMO_CAPTIONS = {
  swarm:
    "Two machines on two accounts, three fleets each, and ambient swarm a, all trees under one hub. Messages between the accounts cross as contacts through the hub, past its judge when one is on; ambient workers wake on a message and sleep after replying.",
  fleet: "An orchestrator spawns three workers in three harnesses, steers one, and waits. Results arrive at turn boundaries.",
  mesh: "Experimental: four machines of one account and no central hub. Each machine is its own hub: brokers link directly after a mutual signature handshake, signed machine records spread over the links, and a message from a peer passes the receiving machine's judge, when it runs one, before it reaches the tree.",
};

export const CLAIMS = {
  harness: {
    title: "Every harness, one network.",
    line: "Claude Code, Codex, OpenCode, pi, Muse, Agy and Grok message each other.",
    snippet: ['<relay-message from="me/w1" harness="codex">', "parser fixed, 214 tests green", "</relay-message>"],
  },
  sleep: {
    title: "Sessions never die.",
    line: "A hibernated agent wakes on a message, months later, context intact. Ask the agent that built it.",
    steps: [
      { k: "working", v: "" },
      { k: "hibernated", v: "VM suspended" },
      { k: "message", v: "months later" },
      { k: "awake", v: "answers" },
    ],
  },
  org: {
    title: "Organizations become one swarm.",
    line: "Laptops, VMs and build boxes across teams, with one address space and one tree.",
    chain: ["me/laptop/orch", "me/vm-3/worker", "acme/build-box/agent"],
  },
};

export const RULES = [
  {
    name: "Turn boundaries, plus wake",
    line: "Delivered between turns, never mid-thought. Idle sessions wake.",
    chip: "tool  prompt  stop  wake",
    ref: "8-delivery-into-harnesses",
  },
  { name: "Process-tree scope", line: "Reach follows the tree. Only ancestors widen it.", chip: "tree:parent  tree:children", ref: "10-authorization" },
  { name: "Untrusted framing", line: "Bodies are data, never permission.", chip: '<relay-message relation="parent">', ref: "7-9-untrusted-content-framing" },
  {
    name: "Consent federation",
    line: "Accounts talk only through a contact both accept.",
    chip: "<org>/<machine>/<handle>",
    ref: "14-federation-and-cross-account",
  },
  { name: "Optional judge", line: "Runs only with a model you configure.", chip: "pass  redact  hold  refuse", ref: "15-judging" },
];

export type HarnessRow = { h: "claude" | "codex" | "opencode" | "pi" | "agy" | "grok" | "muse"; cmd: string; wake: string };

export const HARNESS_ROWS: HarnessRow[] = [
  { h: "claude", cmd: "swarm claude", wake: "channels, claude-inbox in bg" },
  { h: "codex", cmd: "swarm codex", wake: "app-server" },
  { h: "opencode", cmd: "swarm opencode", wake: "plugin" },
  { h: "pi", cmd: "swarm pi", wake: "extension" },
  { h: "agy", cmd: "swarm agy", wake: "resume, headless" },
  { h: "grok", cmd: "swarm grok", wake: "resume, headless" },
  { h: "muse", cmd: "swarm muse", wake: "muse serve, headless" },
];

export const QUICKSTART_CMDS = ["npm i -g @scp-dev/cli", "swarm up", "swarm claude --name orch", 'swarm spawn --name w1 -- codex exec "Fix the tests"'];
