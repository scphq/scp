import type { MetadataRoute } from "next";
import { DOCS, docHref } from "../lib/docs";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://scp.dev" }, { url: "https://scp.dev/spec" }, ...DOCS.map((d) => ({ url: `https://scp.dev${docHref(d.slug)}` }))];
}
