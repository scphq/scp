import { DocPage, docMetadata } from "./doc-page";

export const dynamic = "force-static";

export const metadata = docMetadata("");

export default function DocsPage() {
  return <DocPage slug="" />;
}
