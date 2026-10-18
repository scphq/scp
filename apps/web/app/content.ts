export const SITE = "https://scp.dev";
export const SPEC = "/spec";
export const REPO = "https://github.com/scphq/scp";

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
    "Two engineers' machines, three fleets each, and an ambient swarm on one account. Brokers bridge to the account hub; a contact reaches another account through the judge.",
  fleet: "An orchestrator spawns three workers in three harnesses, steers one, and waits. Results arrive at turn boundaries.",
};

export const PROTOCOL = {
  label: "Protocol",
  heading: "Built on the turn boundary.",
  lead: "One broker per machine, one hub per account. Five rules decide what reaches a model, and when.",
};

export const RULES = [
  {
    name: "Delivered at turn boundaries",
    desc: "Messages enter the model's context after a tool call, on a prompt, or at a stop. Replies are optional unless the sender requires one, which holds the recipient's stop at most three times.",
    sample: "[for your information; reply only if useful]",
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
    desc: "Machines in one account link through its hub. Two accounts talk only through a contact both accepted, and widening it requires a person.",
    sample: "<account>/<machine>/<handle>",
    ref: "14-federation-and-cross-account",
  },
  {
    name: "An optional judge",
    desc: "At configured boundaries, the judge can pass, redact, hold for human review, or refuse.",
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
];

export const QUICKSTART = {
  label: "Quickstart",
  heading: "Run a swarm in six commands.",
  lead: "These commands use the swarm CLI, the reference implementation of SCP version 1. Any conforming broker and integration can replace it.",
};

export type Line = { comment: string } | { cmd: string };

export const QUICKSTART_LINES: Line[] = [
  { comment: "install the CLI" },
  { cmd: "npm install -g @scp-dev/cli" },
  { comment: "once, for your harnesses" },
  { cmd: "swarm hooks install" },
  { comment: "from the orchestrator's shell" },
  { cmd: 'swarm spawn --name parser -- claude "Fix the parser tests"' },
  { cmd: 'swarm send parser "Also cover the empty-input case."' },
  { cmd: "swarm list --tree" },
  { cmd: "swarm inbox --wait 30" },
];
