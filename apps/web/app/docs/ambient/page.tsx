import { DocPage, docMetadata } from "../doc-page";

export const dynamic = "force-static";

export const metadata = docMetadata("ambient");

export default function Page() {
  return <DocPage slug="ambient" />;
}
