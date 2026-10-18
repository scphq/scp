import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    SCP_SPEC: readFileSync(join(process.cwd(), "..", "..", "packages", "spec", "SPEC.md"), "utf8"),
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
