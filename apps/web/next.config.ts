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

const MARKDOWN_TWINS = [
  ["/", "/index.md"],
  ["/docs", "/docs.md"],
  ["/docs/:slug([a-z-]+)", "/docs/:slug.md"],
  ["/spec", "/spec.md"],
  ["/architecture", "/architecture.md"],
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    SCP_SPEC: readFileSync(join(process.cwd(), "..", "..", "packages", "spec", "SPEC.md"), "utf8"),
    SCP_DOCS: JSON.stringify(docs),
  },
  async rewrites() {
    return {
      beforeFiles: MARKDOWN_TWINS.map(([source, destination]) => ({
        source,
        destination,
        has: [{ type: "header" as const, key: "accept", value: ".*text/markdown.*" }],
      })),
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
