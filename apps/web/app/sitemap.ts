import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://scp.dev" }, { url: "https://scp.dev/spec" }];
}
