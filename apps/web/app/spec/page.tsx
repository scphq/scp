import type { Metadata } from "next";
import { Header } from "../chrome";
import { loadSpec } from "../../lib/spec";
import { MermaidBlocks } from "../mermaid";
import { shareMetadata } from "../share";
import { Toc } from "./toc";

export const dynamic = "force-static";

const description = "The Swarm Communication Protocol, version 1: identity, messages, delivery into harnesses, authorization, federation and judging.";

export const metadata: Metadata = {
  title: "Specification",
  description,
  alternates: { canonical: "/spec" },
  ...shareMetadata("Specification, SCP", description, "/spec"),
};

const spec = loadSpec();

export default function SpecPage() {
  return (
    <>
      <Header page="spec" />
      <main id="main">
        <div className="wrap spec-wrap">
          <aside className="spec-side">
            <Toc entries={spec.toc} />
          </aside>
          <article className="prose">
            <p className="label">Specification, version 1</p>
            <h1>{spec.title}</h1>
            <details className="toc-mobile">
              <summary>Contents</summary>
              <ol>
                {spec.toc
                  .filter((e) => e.depth === 2)
                  .map((e) => (
                    <li key={e.id}>
                      <a href={`#${e.id}`}>{e.text}</a>
                    </li>
                  ))}
              </ol>
            </details>
            <div dangerouslySetInnerHTML={{ __html: spec.html }} />
          </article>
        </div>
        <MermaidBlocks />
      </main>
    </>
  );
}
