/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS, docHref } from "./docs";
import { homeMarkdown, llmsFullTxt, llmsTxt, markdownPages, mdHref, type Sources } from "./markdown";

const web = join(import.meta.dir, "..");
const src: Sources = {
  docs: {
    ...Object.fromEntries(
      readdirSync(join(web, "docs"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => [f, readFileSync(join(web, "docs", f), "utf8")]),
    ),
    "implementation.md": readFileSync(join(web, "..", "..", "packages", "spec", "IMPLEMENTATION.md"), "utf8"),
  },
  spec: readFileSync(join(web, "..", "..", "packages", "spec", "SPEC.md"), "utf8"),
};

describe("markdown twins", () => {
  test("every docs slug has a markdown page and a route", () => {
    const paths = markdownPages(src).map((p) => p.path);
    for (const d of DOCS) {
      expect(paths).toContain(mdHref(docHref(d.slug)));
      expect(src.docs[d.file]?.trim()).toBeTruthy();
      if (d.slug) expect(readdirSync(join(web, "app", "docs"))).toContain(d.slug);
    }
    expect(paths).toEqual(expect.arrayContaining(["/index.md", "/spec.md", "/architecture.md"]));
  });

  test("llms.txt lists every page", () => {
    const txt = llmsTxt(src);
    expect(txt.startsWith("# ")).toBe(true);
    expect(txt).toMatch(/^> .+/m);
    for (const p of markdownPages(src)) expect(txt).toContain(`(https://scp.dev${p.path}): ${p.description}`);
    expect(txt).toContain("https://scp.dev/llms-full.txt");
  });

  test("llms-full.txt carries every page body", () => {
    const full = llmsFullTxt(src);
    for (const p of markdownPages(src)) expect(full).toContain(p.body.trim().split("\n")[0]);
  });

  test("the home page renders its sections", () => {
    const md = homeMarkdown();
    expect(md).toMatch(/^# .+/);
    expect(md).toContain("```sh");
    expect(md).toContain("npm i -g @scp-dev/cli");
  });

  test("root-relative links point at markdown twins", () => {
    const body = markdownPages(src).find((p) => p.path === "/architecture.md")?.body ?? "";
    expect(body).toContain("](https://scp.dev/spec.md#4-architecture)");
    expect(body).not.toMatch(/\]\(\/(?!\/)/);
  });

  test("a missing source fails the build", () => {
    expect(() => markdownPages({ ...src, spec: "" })).toThrow("SPEC.md");
  });
});
