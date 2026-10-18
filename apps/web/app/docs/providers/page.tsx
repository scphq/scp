import { DocPage, docMetadata } from "../doc-page";

export const dynamic = "force-static";

export const metadata = docMetadata("providers");

export default function Page() {
  return <DocPage slug="providers" />;
}
