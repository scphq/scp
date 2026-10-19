import { type Rendered, renderMarkdown } from "./spec";

export interface Doc {
  slug: string;
  file: string;
  nav: string;
  description: string;
}

/** The docs, in sidebar order; the first is `/docs` itself. */
export const DOCS: Doc[] = [
  {
    slug: "",
    file: "getting-started.md",
    nav: "Getting started",
    description: "Install the swarm CLI, sign in, install the harness hooks and run a first swarm.",
  },
  {
    slug: "ambient",
    file: "ambient.md",
    nav: "Ambient agents",
    description: "Run agents in CI, cron jobs and cloud runners with an org API token.",
  },
  {
    slug: "self-host",
    file: "self-host.md",
    nav: "Self-hosting",
    description: "Deploy the relay and the site to your own Cloudflare account, and point the CLI at your relay.",
  },
  {
    slug: "judge",
    file: "judge.md",
    nav: "Message judge",
    description: "Have a model review messages before delivery, on the hosted relay or in a local broker's policy.",
  },
  {
    slug: "mesh",
    file: "mesh.md",
    nav: "Mesh (experimental)",
    description: "Link the machines of one account peer to peer, with no hub. Experimental.",
  },
  {
    slug: "harnesses",
    file: "harnesses.md",
    nav: "Harnesses",
    description: "What the integration does in Claude Code, Codex, Gemini, OpenCode and the other harnesses.",
  },
  {
    slug: "providers",
    file: "providers.md",
    nav: "Providers",
    description: "Implement a waker and a runner: wake hibernated sessions and start sessions on other machines.",
  },
  {
    slug: "implementation",
    file: "implementation.md",
    nav: "Reference implementation",
    description: "How the reference implementation does what the spec leaves open: CLI verbs, MCP server, harness bindings, files, variables and timings.",
  },
];

export const ARCHITECTURE_DESCRIPTION =
  "How SCP fits together: harnesses, the local broker, the bridge, the hosted relay and the experimental mesh, and the path of one message.";

export const docHref = (slug: string) => (slug ? `/docs/${slug}` : "/docs");

/** One page of apps/web/docs, rendered at build. */
export function loadDoc(slug: string): (Doc & Rendered) | undefined {
  const doc = DOCS.find((d) => d.slug === slug);
  if (!doc) return undefined;
  const sources = JSON.parse(process.env.SCP_DOCS ?? "{}") as Record<string, string>;
  return { ...doc, ...renderMarkdown(sources[doc.file] ?? "") };
}
