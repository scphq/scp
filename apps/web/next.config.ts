import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const docsDir = join(process.cwd(), "docs");
const docs = Object.fromEntries(
  readdirSync(docsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => [name, readFileSync(join(docsDir, name), "utf8")]),
);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    SCP_SPEC: readFileSync(join(process.cwd(), "..", "..", "packages", "spec", "SPEC.md"), "utf8"),
    SCP_DOCS: JSON.stringify(docs),
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
