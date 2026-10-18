import { DocPage, docMetadata } from "../doc-page";

export const dynamic = "force-static";

export const metadata = docMetadata("self-host");

export default function Page() {
  return <DocPage slug="self-host" />;
}
