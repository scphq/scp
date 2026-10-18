import type { Metadata } from "next";
import { DOCS } from "../../../lib/docs";
import { DocPage, docMetadata } from "../doc-page";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.filter((d) => d.slug).map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  return docMetadata((await params).slug);
}

export default async function DocSlugPage({ params }: { params: Promise<{ slug: string }> }) {
  return <DocPage slug={(await params).slug} />;
}
