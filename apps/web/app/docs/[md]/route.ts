import { DOCS, docHref } from "../../../lib/docs";
import { markdownResponse, mdHref } from "../../../lib/markdown";

export const dynamic = "force-static";
export const dynamicParams = false;

export const generateStaticParams = () => DOCS.filter((d) => d.slug).map((d) => ({ md: `${d.slug}.md` }));

export async function GET(_: Request, { params }: { params: Promise<{ md: string }> }) {
  const { md } = await params;
  return markdownResponse(mdHref(docHref(md.replace(/\.md$/, ""))));
}
