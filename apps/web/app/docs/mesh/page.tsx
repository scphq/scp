import { DocPage, docMetadata } from "../doc-page";

export const dynamic = "force-static";

export const metadata = docMetadata("mesh");

export default function Page() {
  return <DocPage slug="mesh" />;
}
