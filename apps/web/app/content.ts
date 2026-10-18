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
  title: "A message layer for agent swarms.",
  deck: "Agents in different harnesses message each other and their human, at the turn boundaries each harness already has. No polling, no human relaying.",
};

export const HERO_FACTS = [
  { k: "broker", v: "one per user, on each machine" },
  { k: "hub", v: "one per account" },
  { k: "contact", v: "two accounts, both consent" },
  { k: "harness", v: "hooks, MCP or a shell" },
];

export const DEMO_CAPTIONS = {
  swarm:
    "Two machines on two accounts, three fleets each, and ambient swarm a, all trees under one hub. Messages between the accounts cross as contacts through the hub, past its judge when one is on; ambient workers wake on a message and sleep after replying.",
  fleet: "An orchestrator spawns three workers in three harnesses, steers one, and waits. Results arrive at turn boundaries.",
  mesh: "Experimental: four machines of one account and no central hub. Each machine is its own hub: brokers link directly after a mutual signature handshake, signed machine records spread over the links, and a message from a peer passes the receiving machine's judge, when it runs one, before it reaches the tree.",
};

export const PROTOCOL = {
  label: "Protocol",
  heading: "Built on the turn boundary.",
  lead: "One broker per machine, one hub per account. Five rules decide what reaches a model, and when.",
};

export const RULES = [
  {
    name: "Turn boundaries, or a wake",
    desc: "Messages enter the model's context after a tool call, on a prompt, or at a stop. An idle session wakes when one arrives, through Claude channels (swarm claude), the pi extension (swarm pi), the OpenCode plugin (swarm opencode) or the Codex app-server (swarm codex); any other reads it at its next turn. Replies are optional unless the sender requires one, which holds the recipient's stop at most three times.",
    sample: "online  idle  idle (next turn)  offline",
    ref: "8-delivery-into-harnesses",
  },
  {
    name: "Scopes follow the process tree",
    desc: "Reach follows the process tree. Only an authority above can widen it, and only within its own reach.",
    sample: "tree:parent  tree:siblings  tree:children",
    ref: "10-authorization",
  },
  {
    name: "Untrusted by construction",
    desc: "Every body is framed as data written by another party, never as permission or approval. Only the parent that spawned a worker can steer it.",
    sample: '<relay-message relation="parent" key="k3x9qa">',
    ref: "7-9-untrusted-content-framing",
  },
  {
    name: "Federation by consent",
    desc: "Machines in one account link through its hub, as me/<machine>/<handle> for your own and <org>/<machine>/<handle> for another member's. Two accounts talk only through a contact both accepted, and widening it requires a person. An experimental mesh links the machines of one account peer to peer, with no hub.",
    sample: "me/<machine>/<handle>  <org>/<machine>/<handle>",
    ref: "14-federation-and-cross-account",
  },
  {
    name: "An optional judge",
    desc: "At configured boundaries, the judge can pass, redact, hold for human review, or refuse. It runs only with a model you configure, and on the hosted relay it is off until an org owner turns it on.",
    sample: "pass  redact  hold  refuse",
    ref: "15-judging",
  },
];

export const AUTHORS = {
  label: "For harness authors",
  heading: "Pull is enough. Hooks add push.",
  lead: "A harness joins if it can run a shell command or mount an MCP server. Each hook adds a delivery point.",
  rules: ["Frame every body.", "Confirm only what you printed.", "Never fail the harness.", "Keep the steer key intact."],
};

export const CAPABILITIES = [
  { has: "MCP or a shell", gives: "inbox, send, reply, ask" },
  { has: "After-tool hook", gives: "injection after tool calls" },
  { has: "Prompt hook", gives: "injection on prompts" },
  { has: "Stop hook that continues with text", gives: "required replies, directives, stop push" },
  { has: "Server-initiated tool messages", gives: "channel push" },
  { has: "A host API that queues a turn", gives: "wake on a message when idle" },
];

export const QUICKSTART = {
  label: "Quickstart",
  heading: "Run a swarm in eight commands.",
  lead: "These commands use the swarm CLI, the reference implementation of SCP version 1. Any conforming broker and integration can replace it.",
};

export type Line = { comment: string } | { cmd: string };

export const QUICKSTART_LINES: Line[] = [
  { comment: "install the CLI" },
  { cmd: "npm i -g @scp-dev/cli" },
  { comment: "log in, link this machine, install hooks and MCP (runs swarm setup --write)" },
  { cmd: "swarm up" },
  { comment: "check the hooks and MCP mounts: nothing left to do once installed" },
  { cmd: "swarm setup" },
  { comment: "start a named orchestrator that wakes on peer messages (also swarm codex, swarm pi; opencode's plugin wakes it)" },
  { cmd: "swarm claude --name lead" },
  { comment: "or, in a session already running: messages reach it at turn boundaries only" },
  { cmd: "swarm join reviewer" },
  { comment: "from the orchestrator's shell" },
  { cmd: 'swarm spawn --name parser -- claude -p "Fix the parser tests"' },
  { cmd: 'swarm send parser "Also cover the empty-input case."' },
  { cmd: "swarm list --tree" },
];
