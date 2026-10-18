import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "../chrome";
import { DOCS, docHref, loadDoc } from "../../lib/docs";
import { MermaidBlocks } from "../mermaid";
import { shareMetadata } from "../share";

export function docMetadata(slug: string): Metadata {
  const doc = loadDoc(slug);
  if (!doc) return {};
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: docHref(slug) },
    ...shareMetadata(`${doc.title}, SCP`, doc.description, docHref(slug)),
  };
}

/** A docs page: the page list beside the rendered markdown. */
export function DocPage({ slug }: { slug: string }) {
  const doc = loadDoc(slug);
  if (!doc) notFound();
  const pages = (
    <ol>
      {DOCS.map((d) => (
        <li key={d.slug}>
          <Link href={docHref(d.slug)} aria-current={d.slug === slug ? "page" : undefined}>
            {d.nav}
          </Link>
        </li>
      ))}
      <li>
        <Link href="/architecture">Architecture</Link>
      </li>
    </ol>
  );
  return (
    <>
      <Header page="docs" />
      <main id="main">
        <div className="wrap spec-wrap">
          <aside className="spec-side">
            <nav className="toc" aria-label="Docs">
              <p className="label">Docs</p>
              {pages}
            </nav>
          </aside>
          <article className="prose">
            <p className="label">Docs</p>
            <h1>{doc.title}</h1>
            <details className="toc-mobile">
              <summary>Docs</summary>
              {pages}
            </details>
            <div dangerouslySetInnerHTML={{ __html: doc.html }} />
          </article>
        </div>
        <MermaidBlocks />
      </main>
    </>
  );
}
