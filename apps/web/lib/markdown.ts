import * as content from "../app/content";
import { HARNESS, HARNESSES } from "../app/harnesses";
import { ARCHITECTURE_DESCRIPTION, DOCS, docHref } from "./docs";
import { SPEC_DESCRIPTION } from "./spec";

/** The markdown sources the site renders: apps/web/docs by file name, and SPEC.md. */
export interface Sources {
  docs: Record<string, string>;
  spec: string;
}

/** The sources as next.config.ts inlines them at build. */
export function buildSources(): Sources {
  return { docs: JSON.parse(process.env.SCP_DOCS ?? "{}") as Record<string, string>, spec: process.env.SCP_SPEC ?? "" };
}

export interface MarkdownPage {
  path: string;
  title: string;
  description: string;
  body: string;
}

type Rec = Record<string, unknown>;
const C = content as unknown as Rec;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, ...keys: string[]): string => {
  if (typeof v === "string") return v;
  for (const k of keys) {
    const x = rec(v)[k];
    if (typeof x === "string" && x) return x;
  }
  return "";
};
const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === "string");

const SITE = str(C.SITE) || "https://scp.dev";
const PAGES = new Set(["/", "/spec", "/architecture", "/docs", ...DOCS.map((d) => docHref(d.slug))]);

/** The markdown twin of an HTML path: `/` is `/index.md`, any other page gains `.md`. */
export const mdHref = (path: string) => (path === "/" ? "/index.md" : `${path}.md`);

const abs = (path: string) => `${SITE}${path}`;

/** Root-relative links in a source become absolute, pointing at the markdown twin when there is one. */
export function absoluteLinks(md: string): string {
  return md.replace(/\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g, (_, path: string, hash = "") => `](${abs(PAGES.has(path) ? mdHref(path) : path)}${hash})`);
}

const cell = (s: string) => s.replace(/\|/g, "\\|");
const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
const harnessLabel = (h: string) => (HARNESS as Record<string, { label: string } | undefined>)[h]?.label ?? h;

function section(label: string, heading: string, lead: string, body: string[]): string[] {
  if (!heading && !body.length) return [];
  return [`## ${heading || label}`, lead, ...body].filter(Boolean);
}

/** The home page, from the constants in app/content.ts. Missing or renamed constants drop their section. */
export function homeMarkdown(): string {
  const hero = rec(C.HERO);
  const out: string[] = [`# ${str(hero, "title") || str(C.SITE_TITLE)}`, `> ${str(C.SITE_DESCRIPTION)}`, str(hero, "deck")];
  const facts = list(C.HERO_FACTS).map((f) => `- ${str(f, "k")}: ${str(f, "v")}`);
  if (facts.length) out.push(facts.join("\n"));
  out.push(`Read the [specification](${abs(mdHref("/spec"))}) or the [docs](${abs(mdHref("/docs"))}), or try the [hosted demo](${str(C.DEMO)}).`);

  for (const claim of Object.values(rec(C.CLAIMS))) {
    const parts = [`## ${str(claim, "title")}`, str(claim, "line")];
    const c = rec(claim);
    if (strings(c.snippet).length) parts.push(["```", ...strings(c.snippet), "```"].join("\n"));
    if (strings(c.chain).length)
      parts.push(
        strings(c.chain)
          .map((a) => `\`${a}\``)
          .join(" > "),
      );
    const steps = list(c.steps).map((s) => [str(s, "k"), str(s, "v")].filter(Boolean).join(": "));
    if (steps.length) parts.push(steps.join(" > "));
    out.push(...parts.filter(Boolean));
  }

  const rows = list(C.HARNESS_ROWS);
  out.push("## Harnesses");
  out.push(
    rows.length
      ? table(
          ["Harness", "Start", "Wake"],
          rows.map((r) => [harnessLabel(str(r, "h")), `\`${str(r, "cmd")}\``, str(r, "wake")]),
        )
      : `Works with ${HARNESSES.map(harnessLabel).join(", ")}.`,
  );

  const protocol = rec(C.PROTOCOL);
  const rules = list(C.RULES).map((r, i) => {
    const sample = str(r, "sample", "chip");
    const ref = str(r, "ref");
    return [
      `${i + 1}. **${str(r, "name").replace(/\.?$/, ".")}** ${str(r, "desc", "line")}`,
      sample && `\`${sample}\``,
      ref && `[spec](${abs(mdHref("/spec"))}#${ref})`,
    ]
      .filter(Boolean)
      .join(" ");
  });
  out.push(...section(str(protocol, "label") || "Protocol", str(protocol, "heading"), str(protocol, "lead"), rules.length ? [rules.join("\n")] : []));

  const authors = rec(C.AUTHORS);
  const caps = list(C.CAPABILITIES).map((c) => [str(c, "has"), str(c, "gives")]);
  const musts = strings(authors.rules);
  out.push(
    ...section(str(authors, "label"), str(authors, "heading"), str(authors, "lead"), [
      caps.length ? table(["The harness has", "It gets"], caps) : "",
      musts.length ? `Every integration:\n\n${musts.map((m, i) => `${i + 1}. ${m}`).join("\n")}` : "",
    ]),
  );

  const quick = rec(C.QUICKSTART);
  const lines = list(C.QUICKSTART_LINES).length
    ? list(C.QUICKSTART_LINES).map((l) => (str(l, "cmd") ? str(l, "cmd") : `# ${str(l, "comment")}`))
    : strings(C.QUICKSTART_CMDS);
  if (lines.length) out.push(...section("Quickstart", str(quick, "heading") || "Quickstart", str(quick, "lead"), [["```sh", ...lines, "```"].join("\n")]));

  return `${out.filter(Boolean).join("\n\n")}\n`;
}

const titleOf = (md: string) => /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? "";

/** Every page's markdown twin, in llms-full.txt order. Throws when a source is missing, failing the build. */
export function markdownPages(src: Sources): MarkdownPage[] {
  const need = (file: string, md: string | undefined) => {
    if (!md?.trim()) throw new Error(`markdown source missing: ${file}`);
    return absoluteLinks(md.endsWith("\n") ? md : `${md}\n`);
  };
  const docs = DOCS.map((d) => {
    const body = need(d.file, src.docs[d.file]);
    return { path: mdHref(docHref(d.slug)), title: titleOf(body) || d.nav, description: d.description, body };
  });
  const architecture = need("architecture.md", src.docs["architecture.md"]);
  const spec = need("SPEC.md", src.spec);
  return [
    { path: mdHref("/"), title: "Home", description: str(C.SITE_DESCRIPTION), body: homeMarkdown() },
    ...docs,
    { path: mdHref("/architecture"), title: titleOf(architecture), description: ARCHITECTURE_DESCRIPTION, body: architecture },
    { path: mdHref("/spec"), title: titleOf(spec), description: SPEC_DESCRIPTION, body: spec },
  ];
}

/** llms.txt in the llmstxt.org format. */
export function llmsTxt(src: Sources): string {
  const pages = markdownPages(src);
  const links = (paths: string[]) =>
    pages
      .filter((p) => paths.includes(p.path))
      .map((p) => `- [${p.title}](${abs(p.path)}): ${p.description}`)
      .join("\n");
  const docs = [...DOCS.map((d) => mdHref(docHref(d.slug))), mdHref("/architecture")];
  return `${[
    `# ${str(C.SITE_TITLE) || "SCP"}`,
    `> ${str(C.SITE_DESCRIPTION)}`,
    "Every page of the site is also served as Markdown at its URL plus `.md` (the home page at `/index.md`), or at its normal URL when the request sends `Accept: text/markdown`.",
    `## Docs\n\n${links(docs)}`,
    `## Specification\n\n${links([mdHref("/spec")])}`,
    [
      "## Optional",
      "",
      links([mdHref("/")]),
      `- [Full text](${abs("/llms-full.txt")}): every page above in one file`,
      `- [Source](${str(C.REPO)}): the protocol, the swarm CLI and this site`,
    ].join("\n"),
  ].join("\n\n")}\n`;
}

/** Every markdown page, concatenated. */
export function llmsFullTxt(src: Sources): string {
  return markdownPages(src)
    .map((p) => `<!-- ${abs(p.path)} -->\n\n${p.body.trim()}\n`)
    .join("\n---\n\n");
}

const response = (body: string, type: string) => new Response(body, { headers: { "Content-Type": `${type}; charset=utf-8` } });

/** A static route's markdown twin. */
export function markdownResponse(path: string): Response {
  const page = markdownPages(buildSources()).find((p) => p.path === path);
  if (!page) return new Response("Not found", { status: 404 });
  return response(page.body, "text/markdown");
}

export const llmsResponse = (full: boolean) => response((full ? llmsFullTxt : llmsTxt)(buildSources()), "text/plain");
