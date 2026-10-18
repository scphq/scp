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
    nav: "Self-host a relay",
    description: "Point the CLI at your own relay, and deploy the relay to your own Cloudflare account.",
  },
  {
    slug: "harnesses",
    file: "harnesses.md",
    nav: "Harnesses",
    description: "What the integration does in Claude Code, Codex, Gemini, OpenCode and the other harnesses.",
  },
];

export const docHref = (slug: string) => (slug ? `/docs/${slug}` : "/docs");

/** One page of apps/web/docs, rendered at build. */
export function loadDoc(slug: string): (Doc & Rendered) | undefined {
  const doc = DOCS.find((d) => d.slug === slug);
  if (!doc) return undefined;
  const sources = JSON.parse(process.env.SCP_DOCS ?? "{}") as Record<string, string>;
  return { ...doc, ...renderMarkdown(sources[doc.file] ?? "") };
}
