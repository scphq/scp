import type { Metadata } from "next";
import { Header } from "../chrome";
import { MermaidBlocks } from "../mermaid";
import { shareMetadata } from "../share";
import { ARCHITECTURE_DESCRIPTION as description } from "../../lib/docs";
import { renderMarkdown } from "../../lib/spec";
import "./architecture.css";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Architecture",
  description,
  alternates: { canonical: "/architecture", types: { "text/markdown": "/architecture.md" } },
  ...shareMetadata("Architecture, SCP", description, "/architecture"),
};

const doc = renderMarkdown((JSON.parse(process.env.SCP_DOCS ?? "{}") as Record<string, string>)["architecture.md"] ?? "");

export default function ArchitecturePage() {
  return (
    <>
      <Header page="docs" />
      <main id="main">
        <div className="wrap">
          <article className="prose arch">
            <p className="label">Architecture</p>
            <h1>{doc.title}</h1>
            <div dangerouslySetInnerHTML={{ __html: doc.html }} />
          </article>
        </div>
        <MermaidBlocks />
      </main>
    </>
  );
}
