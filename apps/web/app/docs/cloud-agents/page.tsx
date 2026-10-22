import { DocPage, docMetadata } from "../doc-page";

export const dynamic = "force-static";

export const metadata = docMetadata("cloud-agents");

export default function Page() {
  return <DocPage slug="cloud-agents" />;
}
